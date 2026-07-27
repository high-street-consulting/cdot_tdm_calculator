// MapView: ArcGIS Maps SDK for JavaScript (@arcgis/core v5) component that
// loads the TAZ feature layer directly and lets the user select TAZs. Basemap,
// initial view, and all symbology come from a standalone config
// (config/mapStyle.json); see the layer/map construction below.
//
// Selection modes:
//   • Plain click          : single-select (replaces current selection with
//                             the clicked TAZ, or clears if same TAZ clicked)
//   • Shift / Cmd / Ctrl-click : toggle in/out of multi-selection
//   • "Draw polygon" button   : click vertices on the map and double-click
//                              to close; every TAZ intersecting the polygon
//                              is added to the selection
//   • "Select zones in view"  : adds every TAZ intersecting the CURRENT map
//                              extent to the selection. This is the primary
//                              mouse-free spatial path: a keyboard user frames
//                              their project area with the search box (type a
//                              place, address, or TAZ id — it pans/zooms the map)
//                              and then activates this button. No map click and
//                              no knowledge of numeric TAZ ids required.
//   • "Clear" button       : empties the selection
//   • Address search       : Esri World Geocoder Search widget pans/zooms
//                              the map to the typed location
//   • TAZ-ID search        : a second Search source backed by the TAZ feature
//                              layer; typing a known TAZ id selects it (adds it
//                              to the selection) and zooms to it. This makes the
//                              selection flow fully keyboard-accessible, no map
//                              click required.
//
// Highlighting is via FeatureEffect: selected TAZs render normally, the rest
// are dimmed.

import { useCallback, useEffect, useRef, useState } from "react";

import { MapLoading } from "./MapLoading";
import EsriMap from "@arcgis/core/Map";
import MapView from "@arcgis/core/views/MapView";
import FeatureLayer from "@arcgis/core/layers/FeatureLayer";
import VectorTileLayer from "@arcgis/core/layers/VectorTileLayer";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import Graphic from "@arcgis/core/Graphic";
import SketchViewModel from "@arcgis/core/widgets/Sketch/SketchViewModel";
import Search from "@arcgis/core/widgets/Search";
import LocatorSearchSource from "@arcgis/core/widgets/Search/LocatorSearchSource";
import LayerSearchSource from "@arcgis/core/widgets/Search/LayerSearchSource";
import type Geometry from "@arcgis/core/geometry/Geometry";

import type Point from "@arcgis/core/geometry/Point";
import EsriExtent from "@arcgis/core/geometry/Extent";

// AGOL identifiers. The TAZ feature service supplies taz_id + geometry; the VTL
// (a published vector tile layer) supplies the visible boundary styling.
import { VTL_ITEM_ID, TAZ_LAYER_URL, PORTAL_URL } from "../data/agol";
// Basemap, initial view, and all symbology live in one standalone, editable
// config file rather than being baked into this component.
import { MAP_STYLE } from "../config/mapStyle";
// Optional context layers (transit, traffic counts). Probed after the map is
// ready; unavailable sources are dropped silently and the picker hides entirely
// when none load.
import {
  probeReferenceLayers,
  type ProbedReferenceLayer,
} from "../data/referenceLayers";
import { ReferenceLayers } from "./ReferenceLayers";
import { ReferenceLegend } from "./ReferenceLegend";

// MapView.on("click") event shape: we only read .native and pass the whole
// event to view.hitTest(). Importing the class type from @arcgis/core fails
// in some module resolution modes; structural type works fine here.
interface ViewClickEvent {
  x: number;
  y: number;
  native: Event;
  mapPoint?: Point;
}

export type SelectionMode = "replace" | "toggle" | "add";

interface MapCanvasProps {
  selectedTazIds: ReadonlySet<string>;
  /** Called with an array of taz ids and the intended mutation mode.
   *  - "replace": new selection = the given ids
   *  - "toggle":  flip membership of each id
   *  - "add":     union the given ids with the current selection
   */
  onSelectionChange: (tazIds: string[], mode: SelectionMode) => void;
  /** Called when a "Draw area" spatial query was truncated server-side by the
   *  TAZ layer's maxRecordCount (the drawn area covered more zones than the
   *  service returns at once). Lets the app surface the "too many zones" banner
   *  even though the app never sees the dropped ids. */
  onSelectionTruncated?: () => void;
  onTazLayerReady?: (layer: FeatureLayer) => void;
}

export function MapCanvas({
  selectedTazIds,
  onSelectionChange,
  onSelectionTruncated,
  onTazLayerReady,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchHostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<MapView | null>(null);
  const tazLayerRef = useRef<FeatureLayer | null>(null);
  const sketchLayerRef = useRef<GraphicsLayer | null>(null);
  const selectionLayerRef = useRef<GraphicsLayer | null>(null);
  // taz_id → geometry, populated from the hitTest graphic on click and from the
  // rectangle query. Lets the selection overlay draw instantly without a
  // per-click queryFeatures round-trip to AGOL (the old source of click lag).
  const geomCacheRef = useRef<Map<string, Geometry>>(new Map());
  const searchRef = useRef<Search | null>(null);

  const [drawing, setDrawing] = useState(false);
  const [mapLoading, setMapLoading] = useState(true);
  // "Select zones in view" pending flag + a status message announced to screen
  // readers (this action has no map-click equivalent, so it needs its own
  // confirmation that N zones were added).
  const [selectingInView, setSelectingInView] = useState(false);
  const [viewSelectStatus, setViewSelectStatus] = useState("");
  // Reference layers that actually loaded, and which of them are switched on.
  // Empty `refLayers` (nothing loaded, or probe not finished) hides the picker.
  const [refLayers, setRefLayers] = useState<ProbedReferenceLayer[]>([]);
  const [refEnabled, setRefEnabled] = useState<Set<string>>(new Set());
  // The view as state (not just the ref) so the legend can re-derive itself once
  // the view exists and whenever the map settles after a pan/zoom.
  const [readyView, setReadyView] = useState<MapView | null>(null);
  const drawingRef = useRef(false);
  drawingRef.current = drawing;

  const onSelRef = useRef(onSelectionChange);
  onSelRef.current = onSelectionChange;

  const onTruncRef = useRef(onSelectionTruncated);
  onTruncRef.current = onSelectionTruncated;

  // Mount/unmount.
  useEffect(() => {
    if (!containerRef.current) return;

    // Display: the published vector tile layer, fast, GPU-rendered TAZ
    // boundaries (replaces rendering the heavy feature layer client-side).
    const vtl = new VectorTileLayer({
      portalItem: { id: VTL_ITEM_ID, portal: { url: PORTAL_URL } },
    });
    // Match the previous web map's TAZ symbology: a transparent fill with a
    // short-dotted brown outline (RGB 107,57,0, ~0.85 opacity) whose width
    // scales with zoom and fades out when zoomed far out. The VTL ships with
    // a single solid-blue *fill* sublayer; a Mapbox-GL fill can only draw a
    // 1px solid outline, so we (a) make every fill transparent and (b) add a
    // dedicated `line` sublayer to carry the dotted, width-scaled boundary.
    void vtl.when(() => {
      try {
        const style = vtl.currentStyleInfo?.style as
          | {
              sources?: Record<string, unknown>;
              layers?: Array<{ id: string; type: string; "source-layer"?: string }>;
            }
          | undefined;
        const sourceName = Object.keys(style?.sources ?? {})[0];
        let sourceLayer: string | undefined;
        for (const sl of style?.layers ?? []) {
          if (sl.type === "fill") {
            sourceLayer = sl["source-layer"];
            vtl.setPaintProperties(sl.id, {
              "fill-color": "rgba(0,0,0,0)",
              "fill-outline-color": "rgba(0,0,0,0)",
            });
          }
        }
        if (sourceName && sourceLayer) {
          vtl.setStyleLayer({
            id: "taz-outline",
            type: "line",
            source: sourceName,
            "source-layer": sourceLayer,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": MAP_STYLE.tazBoundary.lineColor,
              "line-opacity": MAP_STYLE.tazBoundary.lineOpacity,
              "line-dasharray": MAP_STYLE.tazBoundary.lineDasharray,
              // Zoom→width stops from the config, flattened into a Mapbox-GL
              // linear interpolation expression (≈0px zoomed out → 3.2px in).
              "line-width": [
                "interpolate",
                ["linear"],
                ["zoom"],
                ...MAP_STYLE.tazBoundary.lineWidthZoomStops.flat(),
              ],
            },
          } as never);
        }
      } catch (e) {
        console.warn("MapCanvas: failed to restyle VTL", e);
      }
    });
    // Visible-selection overlay drawn ABOVE the layers; the sketch preview
    // sits highest so a draw-in-progress is always visible.
    const selectionLayer = new GraphicsLayer({ listMode: "hide" });
    const sketchLayer = new GraphicsLayer({ listMode: "hide" });
    selectionLayerRef.current = selectionLayer;
    sketchLayerRef.current = sketchLayer;

    // TAZ data layer, created directly from its service URL so the layer
    // metadata and the basemap start loading immediately and in parallel, with no
    // web-map portal round-trips (resolve portal → fetch item → fetch item data)
    // gating the first paint. The layer itself is invisible (transparent
    // renderer, hit-test only); the VTL paints the visible boundaries and the
    // selection overlay sits on top. Basemap + initial view + every symbol come
    // from the standalone config (config/mapStyle.json).
    const tazLayer = new FeatureLayer({
      url: TAZ_LAYER_URL,
      outFields: ["taz_id"],
      popupEnabled: false,
      legendEnabled: false,
      listMode: "hide",
      renderer: {
        type: "simple",
        symbol: {
          type: "simple-fill",
          color: [0, 0, 0, 0],
          outline: { color: [0, 0, 0, 0], width: 0 },
        },
      } as never,
    });
    tazLayerRef.current = tazLayer;

    // Layer draw order is bottom→top: transparent TAZ layer (hit-test), VTL
    // boundaries, then the selection + sketch overlays.
    const map = new EsriMap({
      basemap: MAP_STYLE.basemap,
      layers: [tazLayer, vtl, selectionLayer, sketchLayer],
    });

    const view = new MapView({
      container: containerRef.current,
      map,
      center: MAP_STYLE.initialView.center as [number, number],
      zoom: MAP_STYLE.initialView.zoom,
    });
    viewRef.current = view;

    let isMounted = true;
    void (async () => {
      try {
        await Promise.race([
          view.when(),
          new Promise<void>((resolve) => setTimeout(resolve, 8000)),
        ]);
      } catch (e) {
        console.warn("MapCanvas: view.when() rejected; proceeding anyway:", e);
      }
      if (!isMounted) return;

      // tazLayer was created synchronously above and is already in the map; the
      // view is ready (basemap + VTL visible), so drop the loading spinner.
      onTazLayerReady?.(tazLayer);
      // Keep the (click-blocking) loading overlay up until the TAZ layer is
      // actually loaded and hit-testable. Otherwise there's a window where the
      // map looks ready but clicks register nothing, reported as "can't select
      // TAZs" (in Edge and generally while the map is still loading).
      await tazLayer.load().catch((e) => console.warn("MapCanvas: TAZ layer load failed", e));
      setMapLoading(false);

      // Reference layers: probe AFTER the map is usable so their metadata requests
      // never delay first paint or TAZ selection. Each starts hidden, so adding
      // them costs nothing until the user switches one on. Anything that fails to
      // load is silently absent.
      //
      // Drawing order matters: they go in at the BOTTOM of the operational stack,
      // above the basemap but below the transparent hit-test TAZ layer, the VTL
      // that paints the zone boundaries, and the selection/sketch overlays. So
      // reference context can never obscure a zone boundary or a selection
      // highlight, and can never swallow a click. Index 0 is the bottom of
      // map.layers; asserted below so a future layer-order change trips a warning
      // rather than silently drawing transit lines over the selection.
      void probeReferenceLayers().then((probed) => {
        if (!isMounted || probed.length === 0) return;
        map.addMany(
          probed.map((p) => p.layer),
          0,
        );
        const tazIndex = map.layers.indexOf(tazLayer);
        const lastRefIndex = Math.max(
          ...probed.map((p) => map.layers.indexOf(p.layer)),
        );
        if (lastRefIndex >= tazIndex) {
          console.warn(
            "MapCanvas: reference layers are not below the TAZ layer; " +
              "they may obscure zone boundaries or the selection.",
            { lastRefIndex, tazIndex },
          );
        }
        setRefLayers(probed);
        setReadyView(view);
      });
      (window as unknown as Record<string, unknown>).__cdotView = view;
      (window as unknown as Record<string, unknown>).__cdotTazLayer = tazLayer;
      // Deterministic selection hook for E2E tests: drives the same selection
      // path as a map click, without depending on the WebGL canvas or the Esri
      // search widget. (Harmless in prod: it only does what the UI already can.)
      (window as unknown as Record<string, unknown>).__cdotSelect = (
        ids: Array<string | number>,
        mode: SelectionMode = "add",
      ) => onSelRef.current(ids.map(String), mode);
      console.info("MapCanvas: ready (direct FL + programmatic VTL)");

      // Esri Search widget: use the SDK's default anonymous World
      // Geocoder source, then post-init bias every source's searchExtent
      // + countryCode to Colorado so cross-country namesakes ("Boulder,
      // Australia") drop off and CO addresses surface first.
      const searchHost = searchHostRef.current;
      if (searchHost) {
        const coloradoExtent = new EsriExtent({
          xmin: -109.06, ymin: 36.99,
          xmax: -102.04, ymax: 41.0,
          spatialReference: { wkid: 4326 },
        });
        const search = new Search({
          view,
          container: searchHost,
          popupEnabled: false,
          resultGraphicEnabled: true,
          locationEnabled: false,
          // Search address + TAZ-ID sources together so a single box handles
          // both (type a place → addresses; type a number → TAZ ids).
          searchAllEnabled: true,
          allPlaceholder: "Search address, place, or TAZ ID…",
        });

        // Second source: the TAZ feature layer keyed on taz_id. Lets a user who
        // knows a TAZ id type it in and select that zone entirely by keyboard, so
        // the selection flow no longer requires a mouse click on the map.
        const tazSource = new LayerSearchSource({
          layer: tazLayer,
          searchFields: ["taz_id"],
          displayField: "taz_id",
          outFields: ["taz_id"],
          name: "TAZ ID",
          placeholder: "TAZ ID (e.g. 1234)",
          exactMatch: false,
          suggestionsEnabled: true,
          maxResults: 6,
          maxSuggestions: 6,
          // Our own blue overlay marks the selected TAZ; skip Esri's result
          // graphic so we don't double-draw it.
          resultGraphicEnabled: false,
        });
        search.sources.add(tazSource);

        // Apply CO bias to the geocoder source(s) as they're added, but never
        // to the TAZ source (it's a local layer, not a country-scoped locator).
        const applyColoradoBias = () => {
          search.allSources.forEach((src) => {
            if (src === tazSource) return;
            const s = src as unknown as {
              searchExtent?: EsriExtent;
              countryCode?: string;
              placeholder?: string;
              maxResults?: number;
              maxSuggestions?: number;
            };
            s.searchExtent = coloradoExtent;
            s.countryCode = "USA";
            s.placeholder = "Search Colorado address, city, or place…";
            s.maxResults = 6;
            s.maxSuggestions = 6;
          });
        };
        applyColoradoBias();
        // Default sources can hydrate async; re-apply once they settle.
        search.when(() => applyColoradoBias());

        // Strict client-side filter: drop any autocomplete suggestion or
        // result whose text doesn't read like a Colorado address. The Esri
        // World Geocoder uses ", CO," or ", Colorado," consistently in its
        // formatted text for both states and counties/cities.
        const isColoradoText = (text: string | undefined | null): boolean => {
          if (!text) return false;
          // Match ", CO," / ", CO " / ", Colorado", but not "Co " (county etc).
          return /,\s*(CO|Colorado)\b/.test(text);
        };
        const filterResults = (resultsArr: unknown[]) => {
          for (const sourceResult of resultsArr) {
            const sr = sourceResult as {
              source?: unknown;
              results?: { text?: string; name?: string }[];
            };
            // The CO-address filter only applies to the geocoder; TAZ-id
            // matches ("1234") never contain ", CO" and must pass through.
            if (sr.source === tazSource) continue;
            if (!sr.results) continue;
            sr.results = sr.results.filter((r) =>
              isColoradoText(r.text ?? r.name),
            );
          }
        };
        search.on("suggest-complete", (evt) => filterResults(evt?.results ?? []));
        search.on("search-complete", (evt) => filterResults(evt?.results ?? []));

        // When a TAZ-id result is chosen, add that zone to the selection (and
        // cache its geometry so the blue overlay draws without a round-trip).
        // The Search widget zooms to the feature on its own.
        search.on("select-result", (evt) => {
          const e = evt as unknown as {
            source?: unknown;
            result?: { feature?: { attributes?: Record<string, unknown>; geometry?: Geometry } };
          };
          if (e.source !== tazSource) return;
          const feature = e.result?.feature;
          const tazId = feature?.attributes?.taz_id;
          if (tazId == null) return;
          const id = String(tazId);
          if (feature?.geometry) geomCacheRef.current.set(id, feature.geometry);
          onSelRef.current([id], "add");
        });

        searchRef.current = search;
        void LocatorSearchSource; // keep import for type linting
      }

      view.on("click", (evt) => {
        if (drawingRef.current) return; // polygon drawing handles its own clicks
        void handleClick(evt, view, tazLayer!, onSelRef.current, geomCacheRef.current);
      });
    })();

    return () => {
      isMounted = false;
      searchRef.current?.destroy();
      searchRef.current = null;
      viewRef.current?.destroy();
      viewRef.current = null;
      tazLayerRef.current = null;
      sketchLayerRef.current = null;
      selectionLayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-render the visible-selection graphics layer whenever the selection
  // changes. We query the TAZ layer for the selected geometries and draw
  // them as a vivid blue overlay above the source layer so the highlight
  // is always visible, independent of whatever symbology the underlying
  // feature layer uses, at any zoom level.
  useEffect(() => {
    const selLayer = selectionLayerRef.current;
    const view = viewRef.current;
    if (!selLayer || !view) return;
    if (selectedTazIds.size === 0) {
      selLayer.removeAll();
      return;
    }
    const cache = geomCacheRef.current;
    const ids = Array.from(selectedTazIds);

    // Draw from cached geometry: instant, no network. Clicks and rectangle
    // selections populate the cache before the selection state changes, so
    // this is the normal path.
    const draw = () => {
      selLayer.removeAll();
      for (const id of ids) {
        const geom = cache.get(id);
        if (!geom) continue;
        selLayer.add(
          new Graphic({
            geometry: geom,
            symbol: {
              type: "simple-fill",
              color: MAP_STYLE.selection.fillColor,
              outline: {
                color: MAP_STYLE.selection.outlineColor,
                width: MAP_STYLE.selection.outlineWidth,
              },
            } as never,
            attributes: { taz_id: id },
          }),
        );
      }
    };
    draw();

    // Only ids we have no cached geometry for (e.g. a restored session) need a
    // round-trip; fetch just those, cache, and redraw.
    const missing = ids.filter((id) => !cache.has(id));
    if (missing.length === 0) return;
    const tazLayer = tazLayerRef.current;
    if (!tazLayer) return;
    let cancelled = false;
    void (async () => {
      try {
        const idList = missing.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
        const q = tazLayer.createQuery();
        q.where = `taz_id IN (${idList})`;
        q.outFields = ["taz_id"];
        q.returnGeometry = true;
        q.outSpatialReference = view.spatialReference;
        const fs = await tazLayer.queryFeatures(q);
        if (cancelled) return;
        for (const feat of fs.features) {
          const fid = String(feat.attributes?.taz_id ?? "");
          if (fid && feat.geometry) cache.set(fid, feat.geometry);
        }
        draw();
      } catch (e) {
        console.warn("MapCanvas: selection-layer query failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedTazIds]);

  // (No auto-fit on selection or on view return; map state is preserved
  // verbatim across navigations via the persistent MapCanvas mount.)

  // Polygon-draw mode: SketchViewModel handles pointer events and preview
  // rendering. Click each vertex on the map; double-click (or press Enter)
  // to close the polygon and select every TAZ intersecting it.
  useEffect(() => {
    const view = viewRef.current;
    const sketchLayer = sketchLayerRef.current;
    if (!view || !sketchLayer || !drawing) return;

    const svm = new SketchViewModel({
      view,
      layer: sketchLayer,
      polygonSymbol: {
        type: "simple-fill",
        color: MAP_STYLE.sketch.fillColor,
        outline: {
          color: MAP_STYLE.sketch.outlineColor,
          width: MAP_STYLE.sketch.outlineWidth,
          style: MAP_STYLE.sketch.outlineStyle,
        },
      } as never,
    });

    const handle = svm.on("create", (evt) => {
      if (evt.state === "cancel") {
        sketchLayer.removeAll();
        setDrawing(false);
        return;
      }
      if (evt.state !== "complete") return;
      const geom = evt.graphic?.geometry as Geometry | undefined;
      if (!geom) {
        sketchLayer.removeAll();
        setDrawing(false);
        return;
      }
      void queryAndSelect(tazLayerRef.current, geom, onSelRef.current, geomCacheRef.current, onTruncRef.current).finally(() => {
        sketchLayer.removeAll();
        setDrawing(false);
      });
    });

    // Click each vertex, double-click to finish.
    svm.create("polygon", { mode: "click" });

    // ESC aborts the in-progress draw: discard any partial geometry and return
    // to the normal (non-drawing) state without selecting any TAZs. This
    // listener is registered only while draw mode is active (this effect only
    // runs when `drawing` is true) and torn down in the cleanup below, so ESC
    // is not swallowed elsewhere (e.g. it can still close modals). svm.cancel()
    // fires the "create" handler with state === "cancel", which already clears
    // the sketch layer and flips `drawing` off; we also reset explicitly here
    // in case cancel is a no-op (no active operation to cancel).
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      try {
        svm.cancel();
      } catch {
        /* svm may already be torn down */
      }
      sketchLayer.removeAll();
      setDrawing(false);
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      handle.remove();
      try {
        svm.cancel();
      } catch {
        /* svm may already be torn down */
      }
      svm.destroy();
      sketchLayer.removeAll();
    };
  }, [drawing]);

  // "Select zones in view": add every TAZ intersecting the current map extent.
  // Reuses the same spatial-query path as "Draw area" (geometry caching, cap +
  // truncation handling), just fed the view's own extent instead of a drawn
  // polygon. This is the keyboard/no-mouse spatial selection path.
  const handleSelectInView = useCallback(async () => {
    const view = viewRef.current;
    const tazLayer = tazLayerRef.current;
    if (!view || !tazLayer || !tazLayer.loaded || !view.extent) return;
    setSelectingInView(true);
    setViewSelectStatus("Selecting zones in the current map view…");
    try {
      const count = await queryAndSelect(
        tazLayer,
        view.extent,
        onSelRef.current,
        geomCacheRef.current,
        onTruncRef.current,
      );
      setViewSelectStatus(
        count > 0
          ? `Added ${count} zone${count === 1 ? "" : "s"} from the current map view to your selection.`
          : "No zones found in the current map view. Pan or zoom the map to your project area, then try again.",
      );
    } finally {
      setSelectingInView(false);
    }
  }, []);

  // Reference layer on/off. Visibility only: the layer is already in the map, so
  // toggling costs one tile/query round-trip the first time and nothing after.
  const handleRefToggle = useCallback((id: string, on: boolean) => {
    setRefLayers((current) => {
      const hit = current.find((p) => p.def.id === id);
      if (hit) hit.layer.visible = on;
      return current;
    });
    setRefEnabled((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", minHeight: 320 }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      {mapLoading && <MapLoading />}
      <div ref={searchHostRef} className="map-search-host" />
      <div
        className="map-tools-overlay"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className={`map-tool ${drawing ? "active" : ""}`}
          onClick={() => setDrawing((d) => !d)}
          title="Click vertices on the map, double-click to finish"
        >
          {drawing
            ? "Drawing: click vertices · double-click to finish"
            : "Draw area"}
        </button>
        <button
          type="button"
          className="map-tool"
          onClick={handleSelectInView}
          disabled={mapLoading || selectingInView}
          title="Add every traffic analysis zone currently visible in the map to your selection. No mouse or TAZ ID needed: use the search box to frame your project area, then activate this."
        >
          {selectingInView ? "Selecting…" : "Select zones in view"}
        </button>
        <button
          type="button"
          className="map-tool"
          onClick={() => {
            console.info("MapCanvas: Clear button clicked");
            onSelRef.current([], "replace");
          }}
          disabled={selectedTazIds.size === 0}
          title="Clear all selected TAZs"
        >
          Clear selection
        </button>
        {/* Renders nothing when no reference layer loaded. */}
        <ReferenceLayers
          available={refLayers}
          enabled={refEnabled}
          onToggle={handleRefToggle}
        />
        <div className="map-tool-hint">
          Click a TAZ · Shift-click to add or remove · or Select zones in view
        </div>
      </div>
      {/* Legend for whatever reference layers are on. Derived from each layer's own
          renderer and narrowed to the classes present in view; renders nothing when
          no reference layer is enabled. Bottom-left, clear of the tool stack. */}
      <ReferenceLegend
        view={readyView}
        available={refLayers}
        enabled={refEnabled}
      />
      {/* Confirmation for the "Select zones in view" action (which has no map-click
          equivalent), announced politely to screen-reader users. */}
      <div className="sr-only" role="status" aria-live="polite">
        {viewSelectStatus}
      </div>
    </div>
  );
}

// --- helpers --------------------------------------------------------------

async function handleClick(
  evt: ViewClickEvent,
  view: MapView,
  tazLayer: FeatureLayer,
  onSelectionChange: (ids: string[], mode: SelectionMode) => void,
  geomCache: Map<string, Geometry>,
) {
  // Ignore clicks before the TAZ layer is hit-testable; hitTest would return
  // nothing and a no-hit click would clear the selection. Guards premature
  // clicks during map load (part of the "can't select TAZs" report).
  if (!tazLayer.loaded) return;
  const hit = await view.hitTest(evt, { include: [tazLayer] });
  const graphic = hit.results.find((r) => r.type === "graphic");
  if (!graphic || graphic.type !== "graphic") {
    // Click on empty map clears the selection (unless shift is held)
    if (!(evt.native instanceof MouseEvent && (evt.native.shiftKey || evt.native.metaKey || evt.native.ctrlKey))) {
      onSelectionChange([], "replace");
    }
    return;
  }
  const attrs = graphic.graphic.attributes as Record<string, unknown>;
  let tazId = attrs.taz_id ?? attrs.TAZ_id;
  if (tazId == null) {
    const oid = (attrs.ObjectId ?? attrs.OBJECTID ?? attrs.objectid) as
      | number
      | undefined;
    if (oid == null) {
      console.warn("MapCanvas: clicked graphic has no taz_id or ObjectId", attrs);
      return;
    }
    const q = tazLayer.createQuery();
    q.objectIds = [oid];
    q.outFields = ["taz_id"];
    q.returnGeometry = false;
    try {
      const fs = await tazLayer.queryFeatures(q);
      tazId = fs.features[0]?.attributes?.taz_id;
    } catch (e) {
      console.warn("MapCanvas: query for taz_id failed", e);
      return;
    }
  }
  if (tazId == null) return;
  const id = String(tazId);
  // The hitTest graphic already carries the feature geometry, so cache it so the
  // selection overlay draws immediately, with no follow-up query.
  if (graphic.graphic.geometry) geomCache.set(id, graphic.graphic.geometry);
  // ArcGIS's click event carries the original DOM event on `native`. In
  // modern browsers it's a PointerEvent (which extends MouseEvent), but we
  // read shiftKey/metaKey/ctrlKey defensively in case the SDK ever wraps it.
  const native = evt.native as
    | (MouseEvent & { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean })
    | undefined;
  const multi = !!(
    native &&
    (native.shiftKey || native.metaKey || native.ctrlKey)
  );
  console.debug("MapCanvas: toggle taz", id, { multi, shift: native?.shiftKey, meta: native?.metaKey, ctrl: native?.ctrlKey });
  onSelectionChange([id], multi ? "toggle" : "replace");
}

async function queryAndSelect(
  tazLayer: FeatureLayer | null,
  geometry: Geometry,
  onSelectionChange: (ids: string[], mode: SelectionMode) => void,
  geomCache: Map<string, Geometry>,
  onSelectionTruncated?: () => void,
): Promise<number> {
  if (!tazLayer) return 0;
  const q = tazLayer.createQuery();
  q.geometry = geometry;
  q.spatialRelationship = "intersects";
  q.outFields = ["taz_id"];
  // Return geometry so the selection overlay can draw from cache (no second
  // round-trip per selected TAZ).
  q.returnGeometry = true;
  q.outSpatialReference = geometry.spatialReference;
  q.num = 10000;
  try {
    const fs = await tazLayer.queryFeatures(q);
    // AGOL silently truncates the result at the layer's maxRecordCount and sets
    // exceededTransferLimit: the app never sees the dropped ids, so this flag
    // is the only reliable signal that the drawn area covered too many zones.
    if (fs.exceededTransferLimit === true) onSelectionTruncated?.();
    const ids: string[] = [];
    for (const f of fs.features) {
      const fid = String(f.attributes?.taz_id ?? "");
      if (!fid) continue;
      if (f.geometry) geomCache.set(fid, f.geometry);
      ids.push(fid);
    }
    if (ids.length > 0) onSelectionChange(ids, "add");
    return ids.length;
  } catch (e) {
    console.warn("MapCanvas: rectangle query failed", e);
    return 0;
  }
}
