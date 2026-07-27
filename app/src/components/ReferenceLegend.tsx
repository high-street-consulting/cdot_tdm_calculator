// Legend for whichever reference layers are switched on.
//
// Derived, never hardcoded. Each reference layer draws in the symbology its own
// service publishes (see data/referenceLayers.ts), so the legend reads that
// renderer back out at runtime. Change the layer, or Esri republishes its colors,
// and this follows automatically.
//
// It also narrows to what is actually on screen. World Transit Lines carries nine
// classes including Ferry, Monorail and Cable Tram; in Colorado only Bus, Light
// Rail and Rail exist, so the legend queries the layer's distinct values within the
// current extent and lists only those. That keeps it small and stops it from
// implying the map shows modes it does not. If the query fails or the service does
// not support distinct values, it falls back to the renderer's full class list.
//
// Renders nothing when no reference layer is enabled.

import { useEffect, useState } from "react";
import type EsriMapView from "@arcgis/core/views/MapView";
import { when } from "@arcgis/core/core/reactiveUtils";
import type FeatureLayer from "@arcgis/core/layers/FeatureLayer";
import type { ProbedReferenceLayer } from "../data/referenceLayers";

/** One swatch + label row. */
interface LegendItem {
  label: string;
  /** CSS color incl. alpha, read off the symbol. */
  css: string;
  /** Line thickness in px (lines only), so heavier classes read as heavier. */
  weight?: number;
  kind: "line" | "marker" | "fill";
}
interface LegendGroup {
  layerId: string;
  layerLabel: string;
  items: LegendItem[];
}

/** Cap so an unexpectedly chatty renderer can't produce a wall of swatches. */
const MAX_ITEMS = 8;

/** Pull a drawable swatch description out of an Esri symbol. */
function symbolToItem(label: string, symbol: unknown): LegendItem | null {
  const s = symbol as {
    type?: string;
    color?: { toCss?: (includeAlpha?: boolean) => string } | null;
    width?: number;
    outline?: { color?: { toCss?: (a?: boolean) => string } | null } | null;
  } | null;
  if (!s) return null;
  // Lines carry their color directly; a marker or fill with no fill color still
  // reads via its outline (Esri uses that for hollow symbols).
  const css =
    s.color?.toCss?.(true) ?? s.outline?.color?.toCss?.(true) ?? null;
  if (!css) return null;
  const kind: LegendItem["kind"] =
    s.type === "simple-marker" || s.type === "picture-marker"
      ? "marker"
      : s.type === "simple-fill" || s.type === "polygon-3d"
        ? "fill"
        : "line";
  return {
    label,
    css,
    weight: kind === "line" ? Math.max(2, Math.min(6, (s.width ?? 1) * 1.6)) : undefined,
    kind,
  };
}

/**
 * Values present in the layer within the current extent.
 *
 * An empty Set is a real answer ("this layer has nothing here"), which collapses
 * the group and hides the legend, rather than implying modes that aren't on
 * screen. Only null means "couldn't determine" (no distinct support, transient
 * failure), and that falls back to the renderer's full class list.
 */
async function valuesInExtent(
  layer: FeatureLayer,
  field: string,
  view: EsriMapView,
): Promise<Set<string> | null> {
  try {
    if (!view.extent) return null;
    const q = layer.createQuery();
    q.geometry = view.extent;
    q.outFields = [field];
    q.returnDistinctValues = true;
    q.returnGeometry = false;
    const res = await layer.queryFeatures(q);
    return new Set(
      res.features
        .map((f) => f.attributes?.[field])
        .filter((v) => v !== null && v !== undefined)
        .map(String),
    );
  } catch {
    return null;
  }
}

async function buildGroup(
  { def, layer }: ProbedReferenceLayer,
  view: EsriMapView,
): Promise<LegendGroup | null> {
  const renderer = layer.renderer as
    | {
        type?: string;
        field?: string;
        uniqueValueInfos?: { value?: unknown; label?: string; symbol?: unknown }[];
        classBreakInfos?: { label?: string; symbol?: unknown }[];
        symbol?: unknown;
      }
    | null;
  if (!renderer) return null;

  let items: LegendItem[] = [];

  if (renderer.type === "unique-value" && renderer.uniqueValueInfos?.length) {
    const field = renderer.field;
    const present = field
      ? await valuesInExtent(layer, field, view)
      : null;
    const seen = new Set<string>();
    for (const info of renderer.uniqueValueInfos) {
      if (present && !present.has(String(info.value))) continue;
      // Several values can share a label ("Rail" and "Subway" -> "Rail, Subway");
      // one row each would be duplicate noise.
      const label = info.label || String(info.value ?? "");
      if (!label || seen.has(label)) continue;
      const item = symbolToItem(label, info.symbol);
      if (!item) continue;
      seen.add(label);
      items.push(item);
    }
  } else if (renderer.type === "class-breaks" && renderer.classBreakInfos?.length) {
    for (const info of renderer.classBreakInfos) {
      const item = symbolToItem(info.label ?? "", info.symbol);
      if (item?.label) items.push(item);
    }
  } else if (renderer.symbol) {
    // Simple renderer: one swatch, named for the layer itself.
    const item = symbolToItem(def.label, renderer.symbol);
    if (item) items.push(item);
  }

  if (items.length === 0) return null;
  items = items.slice(0, MAX_ITEMS);
  return { layerId: def.id, layerLabel: def.label, items };
}

interface ReferenceLegendProps {
  view: EsriMapView | null;
  available: ProbedReferenceLayer[];
  enabled: Set<string>;
}

export function ReferenceLegend({
  view,
  available,
  enabled,
}: ReferenceLegendProps) {
  const [groups, setGroups] = useState<LegendGroup[]>([]);
  // Bumped when the view settles after a pan/zoom, to re-narrow the classes.
  const [moveTick, setMoveTick] = useState(0);

  useEffect(() => {
    if (!view) return;
    // `when` fires on every transition into stationary, so each completed pan or
    // zoom re-narrows the legend to the classes now on screen.
    const handle = when(
      () => view.stationary,
      () => setMoveTick((t) => t + 1),
    );
    return () => handle.remove();
  }, [view]);

  useEffect(() => {
    const on = available.filter((a) => enabled.has(a.def.id));
    if (!view || on.length === 0) {
      setGroups([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const built = await Promise.all(on.map((a) => buildGroup(a, view)));
      if (cancelled) return;
      setGroups(built.filter((g): g is LegendGroup => g !== null));
    })();
    return () => {
      cancelled = true;
    };
    // moveTick re-runs the extent-scoped query after the map settles.
  }, [view, available, enabled, moveTick]);

  if (groups.length === 0) return null;

  return (
    <div className="map-reflegend" aria-label="Reference layer legend">
      {groups.map((g) => (
        <div key={g.layerId} className="map-reflegend-group">
          <div className="map-reflegend-title">{g.layerLabel}</div>
          {g.items.map((it) => (
            <div key={it.label} className="map-reflegend-row">
              <span
                className={`map-reflegend-swatch is-${it.kind}`}
                style={
                  it.kind === "line"
                    ? { background: it.css, height: it.weight }
                    : { background: it.css }
                }
                aria-hidden="true"
              />
              <span className="map-reflegend-label">{it.label}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
