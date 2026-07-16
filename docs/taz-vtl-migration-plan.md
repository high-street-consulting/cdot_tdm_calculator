# Map engineering: vector-tile migration, data workflow & load performance (scoping)

**Status:** scoping / for review · **Owner:** (you, CDOT AGOL publisher) · **Last updated:** 2026-06-04

## 1. Objective

1. **Fix the slow TAZ load** by splitting the map into a **vector tile layer (VTL) for display** and a **hosted feature layer (FL) for selection + attribute queries**. The current source is ~435 MB and CDOT plans to roughly double the TAZ count, far too much geometry to render as a FeatureLayer client-side.
2. **Cut initial map load time.** The ArcGIS SDK JavaScript is eagerly imported and sits in the first-paint critical path. This is a *separate axis* from the data-volume problem above and is covered in §4.
3. **Migrate the data from the High Street AGOL org to CDOT's AGOL org**, doing the VTL build at the same time.
4. **Make data updates a maintainable, repeatable, low-ceremony workflow**, because the underlying TAZ data will be refreshed periodically.
5. **Add user-toggleable context layers** (AADT, statewide transit, DRCOG bikeways for now) to help users locate the right TAZs.

## 2. Current state (as built)

- **Display + selection both ride on one hosted FeatureLayer** loaded via a web map (`VITE_WEBMAP_ITEM_ID`, default `b2647df733014039bfa0c7df40054489` in the HS org). Rendering all TAZ polygons client-side is the source of the *data* sluggishness.
- **Selection is already decoupled from the FL's symbology**: `MapView.tsx` draws selected TAZs as a separate blue `GraphicsLayer` overlay, geometry fetched via `queryFeatures`. Click selection uses `view.hitTest({ include: [tazLayer] })`; rectangle uses a polygon `queryFeatures`.
- **Attributes are queried server-side, already lightweight**: `src/data/queryTaz.ts` queries `taz_id IN (...)` with `returnGeometry: false` against `VITE_TAZ_LAYER_URL` (default = the HS-org "TAZ_Enriched_source" FeatureServer). The browser never downloads the 435 MB geometry for attributes.
- **The app is already fully config-externalized**: `VITE_TAZ_LAYER_URL`, `VITE_WEBMAP_ITEM_ID`, `VITE_PORTAL_URL` are all env vars (defaulting to HS-org values). So the migration is largely new env values + AGOL-side work.
- **The map is eagerly imported and mounts once, persistently** (always in DOM, hidden per-route via CSS); see §4.
- **A data pipeline already exists** under `scripts/`:
  - `fetch_cdot_layers.py`, `fetch_background_data.py`, `transit_metrics_per_taz.py` pull source layers (CDOT highway/PACE/transit, ACS B08301, NOAA normals).
  - `prepare_taz.py`: `load_taz()` + `prepare_taz()` build the enriched per-TAZ GeoDataFrame (activity, density, lane-miles by class, transit metrics, ACS mode share, NOAA bikeable days).
  - `publish_enriched_taz.py` publishes a GeoJSON → hosted FL + a web map via the ArcGIS API for Python (`arcgis.gis.GIS`), interactive auth, org from `$AGOL_URL` (default `hspartner.maps.arcgis.com`).
- **The schema contract** the app depends on is the `TAZ_FIELDS` list in `queryTaz.ts` (taz_id, county, mpo, area_type, area_sqmi, population, employment, households, *_density, daily_vmt, daily_trips, avg_trip_length, annual_bikeable_days_*, acs_*_share, lane_mi_*).

### Key gap for maintainability

`publish_enriched_taz.py` **refuses to overwrite** an item with the same title and **creates brand-new items each run**, producing new item IDs and service URLs every time. That forces an app config change + redeploy on every data refresh. **Switching to overwrite-in-place is the single most important change** for a repeatable workflow (see §5).

## 3. Target architecture

```
Web map (CDOT org, public)
├── Vector Tile Layer  (TAZ geometry, DISPLAY ONLY)         ← new; fast, GPU-rendered
├── TAZ Feature Layer  (transparent renderer; QUERY + DATA) ← migrated, demoted to invisible
├── Context layers     (visible:false; lazy-loaded toggles)  ← AADT, transit, bikeways
└── basemap
```

- **VTL** renders the polygons. Geometry-only; never queried by app logic.
- **FL** stays the source of truth for attributes (`queryTaz.ts`, `returnGeometry:false`) and for selection geometry (the highlight overlay, with `maxAllowableOffset` so big polygons return screen-resolution geometry). It is `visible:true` with a fully transparent symbol so `hitTest` still works. **Or** we switch click selection to a point `queryFeatures` and ignore its render state entirely (recommended; consistent with the rectangle path).
- **VTL and FL must be generated from the same source** and share an identical `taz_id`, so painted boundaries line up exactly with hit-test/selection boundaries.

## 4. Map load performance: SDK bundle & initialization

*A different axis from §1.1: that's about **data volume** (geometry); this is about the **ArcGIS SDK JavaScript** that must download, parse, and run before the map appears. Both make "the map slow." Fix both.*

### What's happening today

- The map is **eagerly imported**: `App.tsx` does `import { MapCanvas } from "./components/MapView"` (no `React.lazy`), and `MapView.tsx` statically imports `WebMap`, `MapView`, `FeatureLayer`, `GraphicsLayer`, `Graphic`, `SketchViewModel`, `Search`, `LocatorSearchSource`. The whole SDK graph is in the **first-paint critical path**, even though the landing-panel copy needs none of it.
- The built **entry chunk is ~2.1 MB**; total `dist/assets` is ~49 MB of JS (most chunks are lazy, but the statically-imported ones load up front). Heavy chunks include `geometryEngineJSON` (620K), `ProjectionTransformation` (576K), `MultiPathImpl` (564K).
- `App.tsx` imports `FeatureLayer` as a **value but uses it only as a type** (`useState<FeatureLayer | null>`), needless bundle weight.
- **Assets are not the problem:** v5 resolves non-JS assets (images/wasm/CSS) to the version-pinned Esri CDN by default; nothing is copied locally. This is a JS-bundle problem.
- Importing **`WebMap`** drags in support for *every* layer type it might encounter (VideoLayer, OrientedImagery, …), which is why exotic layer chunks show up in the build.

### Recommendations (roughly highest ROI first)

1. **Lazy-load the map** with `React.lazy` + `Suspense` and a lightweight placeholder. The app shell + `/area` landing copy paint immediately; the SDK downloads/parses in parallel and the map fills in a beat later. Biggest *perceived*-speed win, low risk (the map is already an isolated, persistent component). Add `<link rel="modulepreload">`/prefetch for the map chunk right after first paint so it's ready before the user looks at it.
2. **`import type` for type-only SDK imports** (start with `FeatureLayer` in `App.tsx`). Erased at build, so off the runtime bundle. Audit the app for other type-only arcgis imports.
3. **Defer heavy widgets.** `Search` and `SketchViewModel`/`LocatorSearchSource` are only needed for address search and draw-area. Dynamically `import()` them after the view is ready (or on first use) rather than at module load, so they're out of the initial map chunk.
4. **Split the SDK into a cached vendor chunk** via Vite `build.rollupOptions.output.manualChunks` (everything under `@arcgis/core` into one `arcgis` chunk). Parallel download + long-term caching across deploys (repeat-visit win).
5. **Construct the map programmatically instead of from a full `WebMap`**, doing this *with* the VTL refactor (§6). Building a `Map` with only the layers we use (VTL + transparent FL + GraphicsLayer + basemap + context layers) avoids pulling in every layer-type implementation `WebMap` must support. Tradeoff: a `WebMap` is config-driven (nice for swapping context layers without a redeploy). Middle ground: keep `WebMap` but lazy-load the whole map so the bloat is off the critical path. Decide per §11.
6. **Revisit `StrictMode` for prod** (currently off because the MapView didn't survive React's double-mount). Orthogonal to speed, but worth another look once the view lifecycle is encapsulated behind the lazy boundary.

### Expected effect

Items 1–3 move the SDK off the first-paint path and trim the entry chunk, so the landing page becomes interactive in ~React-app time instead of ~ArcGIS-SDK time, with the map arriving slightly after. Items 4–5 reduce total/critical bytes. Together with the §1.1 VTL work (which fixes *map-data* load), this targets both halves of "the map is slow."

## 5. Maintainable, repeatable data-update workflow

### Principles

1. **Overwrite in place; never mint new items.** Refresh data into the *same* hosted FL and the *same* VTL item, so item IDs + service URLs are immutable. Result: **a data refresh requires no app rebuild or redeploy.** This is the headline maintainability win.
2. **One scripted, version-controlled pipeline.** No manual AGOL clicking for data. The pipeline already exists (`fetch_* → prepare_taz → publish_enriched_taz`); harden it and add a written runbook.
3. **Treat `TAZ_FIELDS` as a published contract.** Add a validation gate that fails loudly, *before* publishing, if any contract field is missing, mistyped, or below a non-null coverage threshold. Keep a one-page field dictionary (name, type, units, source) next to the script.
4. **Insulate against upstream renames.** New CDOT TAZ deliveries may rename/restructure fields. Keep an explicit `source → contract` field map in `prepare_taz.py` so an upstream change is a config edit, not an app break.
5. **Geometry (VTL) and attributes (FL) refresh independently.** The ~870 MB geometry never reaches the browser; attribute refresh is AGOL-only. If only attributes change (e.g., re-run ACS), overwrite just the FL and skip VTL regeneration.
6. **Stage before prod.** Publish to a staging item (or `--env staging`), point a local/staging app build at it via `.env`, validate, then overwrite prod. Avoids a bad refresh going straight live.
7. **Pin the toolchain.** Pin `arcgis`, `geopandas`, etc. in a `uv` lock + Python 3.12 env so the pipeline runs identically months later.
8. **Persist the identifiers.** Store prod/staging item IDs + URLs in a small committed config (e.g., `scripts/agol_items.json`) that both the publish script and the app's `.env` derive from: one place, no drift.

### The refresh runbook (steady state)

> Prereq: CDOT AGOL account with publishing rights; `uv` env with pinned deps.

1. Drop the new source TAZ dataset at `DEFAULT_TAZ_PATH` (or pass `--taz-path`). Update the `source → contract` field map in `prepare_taz.py` if CDOT changed field names.
2. (Optional) Refresh background sources (`fetch_cdot_layers.py`, `fetch_background_data.py`, `transit_metrics_per_taz.py`), or reuse cached pulls if ACS/NOAA haven't changed.
3. `python scripts/prepare_taz.py` → enriched GeoDataFrame. **Validation gate** asserts the `TAZ_FIELDS` contract.
4. `python scripts/publish_enriched_taz.py --overwrite --env prod` → **overwrites the existing FL** in the CDOT org (same item ID, same URL).
5. Regenerate the VTL from the updated geometry → **overwrite the existing VTL item** (same ID/URL). (ArcGIS API for Python, or an ArcGIS Pro "Create Vector Tile Package" + overwrite step; see §6.)
6. Smoke test against staging, then confirm prod. **No app redeploy**, since URLs are unchanged.

### Required pipeline changes (vs. today)

- [x] **Generalize the published display geometry**: topology-preserving coverage simplify (`shapely.coverage_simplify`, default **25 m**, `--simplify-tolerance`) in `publish_enriched_taz.py`. Leaves ~23% of TAZ vertices (~77% cut) with no perceptible change at selection zoom and **no attribute impact** (area/density were computed from full-res geometry in `prepare_taz`). Shared borders stay coincident (no slivers). Applied once at the source so the FL and the VTL derived from it align. **[shipped 2026-06-04]**
- [x] `publish_enriched_taz.py`: add `--overwrite` using `FeatureLayerCollection.manager.overwrite()` against the FL item ID in `agol_items.json`, instead of refusing/creating-new. A CREATE run (no `--overwrite`) writes the new item IDs + service URL back into the config so the next run can `--overwrite`; `--overwrite` with no configured `feature_layer_item_id` exits with a "do an initial create publish first" error. **[shipped 2026-06-04]**
- [x] Add `--env {staging,prod}` (default `prod`) and read/write target item IDs in `scripts/agol_items.json` (org URL resolution: `--agol-url` → `agol_items.json[env].portal_url` → `$AGOL_URL` → default). **[shipped 2026-06-04]**
- [x] Add a schema-validation gate keyed to `TAZ_FIELDS`: `validate_contract()` parses the contract out of `queryTaz.ts` at runtime, runs inside `build_enriched_gdf()` (so it also gates `--dry-run`), **fails loudly** listing any missing contract field, and **warns** (non-fatal) on any field below 50% non-null coverage. **[shipped 2026-06-04]**
- [ ] Add a VTL build/overwrite step. Scripted is impractical for the cache, so the documented ArcGIS-Online/Pro path is the runbook in §6 ("Building / refreshing the VTL from the published FL").
- [ ] Support non-interactive auth for repeatability (API key / stored profile) in addition to the current interactive prompt.

## 6. One-time migration to CDOT AGOL

1. **Publish the FL + web map into the CDOT org.** Set `AGOL_URL=https://<cdot-org>.maps.arcgis.com`, run `publish_enriched_taz.py` (first run = create). Share **public** (tokenless static SPA). Capture the new FL URL + web map item ID into `scripts/agol_items.json`.
2. **Build the VTL** from the migrated FL geometry. ArcGIS Pro gives the most control: project to Web Mercator, generate to a high max zoom (crisp boundaries for picking), "Create Vector Tile Package" → share to the CDOT org as a hosted VTL (public). Confirm `taz_id` is carried if we ever want VTL-side styling.
3. **Author the web map**: VTL (visible) on top of a neutral basemap, FL added with a fully transparent renderer, context layers added `visible:false`. *(If we go programmatic-map per §4.5, this becomes layer config in code instead.)*
4. **Point the app at CDOT** via `.env`: `VITE_TAZ_LAYER_URL`, `VITE_WEBMAP_ITEM_ID`, `VITE_PORTAL_URL`. Update the in-code fallbacks (`queryTaz.ts`, `MapView.tsx`) from HS-org to CDOT-org values so defaults are correct too.
5. **App code deltas** (§7), then build + deploy the app **once**. This is the only app deploy coupled to the migration; subsequent data refreshes need none.
6. Decommission / archive the HS-org items once CDOT is verified live.

### Building / refreshing the VTL from the published FL

> Goal: a public **vector tile layer** for fast display, generated **from the same published hosted feature layer** the app queries, so painted boundaries and hit-test/selection boundaries align exactly (shared `taz_id`, shared generalized geometry).

**Create (one-time, via ArcGIS Online):**

1. In the CDOT org, open **Content → the published TAZ hosted feature layer** (`feature_layer_item_id` in `agol_items.json`) → its **Overview** tab.
2. In the right-hand action panel, click **Publish** and choose **Vector tile layer** from the dropdown. AGOL builds the vector tile cache from the FL's (generalized) geometry. *(Verified path, AGOL 2026. The same dropdown also lists Tile layer / WFS / OGC Feature layer. Note: this is **not** "Export Data," which only does Shapefile/CSV/GeoJSON/FGDB.)*
   - One VTL per FL via this menu: after the first publish, **Vector tile layer** greys out with the tooltip *"A vector tile layer, &lt;name&gt;, has already been published from this layer."*
3. Let processing finish, then open the new VTL item (prod: `CDOT TDM Calculator TAZ VTL`, id `df319a5f8a9f48669fd7786204442600`).
4. **Share it public (required, and easy to miss).** A freshly published VTL is **private**; it does **not** inherit the FL's sharing. (Verified: the FL + web map were public, but the new VTL returned HTTP 403 unauthenticated until shared.) The tokenless static SPA can't load it until it's Everyone/public.
5. Record the **VTL item ID** in `agol_items.json[env].vtl_item_id`. Add the VTL to the web map on top of the (transparent/demoted) FL, or wire it programmatically per §4.5.

**Crispness check:** open the web map (or the VTL item's preview), zoom to the level users pick TAZs at, and confirm boundaries are **crisp** (no blurry/over-simplified edges, no tile seams). If they're not crisp enough, regenerate the VTL in **ArcGIS Pro** from the **same source FL**: project to Web Mercator, set the index/tiling scheme to a **deeper max LOD** (higher max zoom) than the AGOL default, optionally bake `taz_id`-aware styling, run **Create Vector Tile Package (.vtpk)**, then **Share Package → To Portal** and **overwrite the same VTL item** (below) rather than uploading a new one.

**Refresh (steady state, keeping the URL stable):** after a geometry change, do **not** create a new VTL item (that would mint a new ID/URL and force an app redeploy). Instead **overwrite the same VTL item** in place, replacing its tile cache (AGOL: *Update / Replace* on the item; Pro: *Share Package → overwrite existing*). If only attributes changed and geometry did not, skip the VTL refresh entirely (overwrite just the FL). After any VTL overwrite, account for tile/CDN caching (see §9 "VTL cache staleness") so users get the new geometry.

## 7. App code changes (concrete, modest)

- `MapView.tsx`
  - Click selection: switch `view.hitTest({include:[tazLayer]})` → point `queryFeatures` (intersects the clicked map point), so selection no longer depends on the FL being rendered. *(Alternative: keep the FL `visible:true` with a transparent symbol and leave hitTest as-is.)*
  - **Selection responsiveness [shipped 2026-06-04]:** cache the geometry the `hitTest` graphic (and the rectangle query) already returns, keyed by `taz_id`, and draw the overlay from that cache. This removed the per-click `queryFeatures` round-trip to AGOL that was the click-to-select lag, without downloading the full layer client-side. A network query now runs only for selected ids with no cached geometry (e.g. a restored session). Still worth adding `maxAllowableOffset` to that fallback query so it stays light as TAZ count doubles.
  - Find-layer logic: still grab the FL from the web map for queries; ignore the VTL for interaction. Exclude context layers from any selection hitTest/query filter.
  - New **layer-toggle panel** (custom, matching the app's design system, not the stock `LayerList` chrome): lists context layers, toggles `layer.visible`, lazy-loads each layer on first enable.
  - **Popup:** `tazLayer.popupEnabled = false` so clicking a TAZ doesn't draw the default teal feature-highlight over the blue selection overlay (the "double selection"). **[shipped 2026-06-04]**
  - Performance deltas from §4: lazy-load the component, defer `Search`/`Sketch` imports, `import type` where applicable.
- `queryTaz.ts`: no logic change; update the fallback URL constant to the CDOT FL once migrated.
- `App.tsx`: `import type FeatureLayer …`; wrap `MapCanvas` in `React.lazy` + `Suspense`.
- `vite.config.ts`: `manualChunks` for the `@arcgis/core` vendor chunk.
- `.env` / `.env.example`: new CDOT values + documented.

## 8. Context layers

Reference-only, **live-referenced** from their authoritative public services (auto-updating; no copies to maintain), `visible:false` by default, lazy-loaded on toggle, excluded from TAZ selection, with min/max scale so statewide line layers don't tank performance. Show attribution for non-CDOT sources.

| Layer | Source | Coverage | Notes / config |
|---|---|---|---|
| **AADT** | CDOT org `AADT_All_Years_Data/FeatureServer/0` | Statewide ✓ | **Built 2026-06-05.** Web Mercator. Wide format (a column per year, no stacked rows), so no def query; latest is `AADT24`. Scale-gated (`minScale` 2,000,000). |
| **Transit routes** | CDOT org `Statewide_Transit_Routes/FeatureServer/0` | Statewide ✓ | **Built 2026-06-05.** Web Mercator; renders cleanly (verified). Scale-gated (`minScale` 1,000,000). |
| **Bikeways** | DRCOG `TRANSPORTATION_bicycle_facilities/FeatureServer/0` | Denver region | **DEFERRED (broken source).** The hosted service declares EPSG 2277 (NAD83 *Texas* Central ftUS); a sample feature reprojects to **Austin, TX**, not Denver. It doesn't reproject server-side (`inSR` ignored → 0) and won't render in a Web Mercator view, so it can't be live-referenced. Re-add via a re-projected copy hosted in CDOT's org, or a corrected/statewide bike source. |

Verified live service URLs (all public, no token):
- AADT: `https://services.arcgis.com/yzB9WM8W0BO3Ql7d/arcgis/rest/services/AADT_All_Years_Data/FeatureServer/0`
- Transit: `https://services.arcgis.com/yzB9WM8W0BO3Ql7d/arcgis/rest/services/Statewide_Transit_Routes/FeatureServer/0`
- Bikeways (broken SR, deferred): `https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/TRANSPORTATION_bicycle_facilities/FeatureServer/0`

Implementation: `app/src/data/contextLayers.ts` (config) + the toggle panel + lazy layer creation in `app/src/components/MapView.tsx`. Layers are created on first toggle, inserted below the selection graphics, scale-gated, popups off, excluded from TAZ selection (the click hitTest is scoped to the TAZ layer), with attribution.

## 9. Risks & gotchas

- **Geometry/ID misalignment** between VTL and FL → selection outlines don't match painted polygons. Mitigation: generate both from one source; identical `taz_id`.
- **`hitTest` needs a rendering layer.** If the FL is `visible:false`, hitTest returns nothing, hence the click→point-query switch (or transparent-but-visible FL).
- **Overwrite semantics.** `overwrite()` requires the schema to match the original publish; a changed field set may force a republish. The field map + validation gate (§5) keep this controlled; if a republish *is* needed, it mints new IDs, so treat as a mini-migration (update `.env`).
- **VTL cache staleness.** Browsers/CDN cache tiles; after a VTL overwrite, bump a version or rely on AGOL's tile cache invalidation so users get new geometry.
- **Lazy-load + persistent map.** The map is mounted once and persists across routes; ensure the `React.lazy` boundary preserves that single-instance lifecycle (don't remount on nav) and that the Suspense fallback doesn't thrash the view.
- **Public sharing / org policy.** Confirm CDOT org policy allows public sharing of the FL/VTL/web map (needed for the tokenless static SPA).
- **DRCOG coverage** could confuse statewide users, so use an explicit "Denver region" label.

## 10. Phased breakdown

- **Phase 0, Load-speed quick wins** (no AGOL/data dependency; ship first): lazy-load `MapCanvas`, `import type` cleanups, defer `Search`/`Sketch`, `manualChunks`. Independent of everything below and addresses the "unacceptably slow" first paint immediately.
  - **Shipped 2026-06-04:** lazy-loaded `MapCanvas` + dynamic-imported `queryTaz` + `import type FeatureLayer` moved ArcGIS off the entry (entry chunk **2.1 MB → 324 KB**, heavy SDK chunks load on demand); plus the `popupEnabled = false` double-selection fix. The widget deferral is now subsumed by the lazy boundary. `manualChunks` deferred; forcing all of `@arcgis/core` into one chunk could fight the SDK's own dynamic-import splitting; revisit with measurement.
- **Phase A, Pipeline hardening** (no app change): overwrite-in-place, validation gate, `agol_items.json`, runbook, pinned env.
- **Phase B, Migration to CDOT org**: publish FL + web map, build VTL, author web map / programmatic map, public share.
- **Phase C, App**: click-query swap + `maxAllowableOffset`, `.env`/fallback updates, deploy once.
- **Phase D, Context layers**: toggle panel + AADT/transit/bikeways with def queries, scale ranges, attribution.

## 11. Open decisions

1. CDOT org URL + target folder for the items.
2. VTL build path: scripted (ArcGIS API for Python) vs. ArcGIS Pro manual-but-documented?
3. Staging: a separate item in the same org, or a separate dev org/folder?
4. Click selection: point-query (recommended) vs. transparent-but-visible FL + hitTest?
5. Auth for the publish script: API key / stored profile for non-interactive repeatable runs?
6. Map construction: keep config-driven `WebMap` (lazy-loaded) vs. programmatic `Map` with only-needed layers (smaller bundle, less config flexibility)? See §4.5.
