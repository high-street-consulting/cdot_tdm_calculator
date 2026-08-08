// Single source of truth for the AGOL identifiers the app consumes at
// runtime, shared by the interactive map (MapView) and the printable
// report's project-area map. Overridable via Vite env (.env); defaults
// target the CDOT org. See scripts/agol_items.json for the publish side.

/** Vector tile layer item: the visible TAZ boundaries. */
export const VTL_ITEM_ID =
  import.meta.env.VITE_VTL_ITEM_ID ?? "df319a5f8a9f48669fd7786204442600";

/** Hosted feature service: taz_id + geometry + attributes. */
export const TAZ_LAYER_URL =
  import.meta.env.VITE_TAZ_LAYER_URL ??
  "https://services.arcgis.com/yzB9WM8W0BO3Ql7d/arcgis/rest/services/CDOT_TDM_Calculator_TAZ_Enriched_2026_06_29_source_/FeatureServer/0";

// A WEBMAP_ITEM_ID export used to live here. The app stopped loading a web map
// when the VTL migration landed — it loads the feature layer directly and takes
// basemap/extent/symbology from config/mapStyle.json — and the web map item was
// deleted from AGOL on 2026-07-30. Removed rather than left pointing at an item
// that no longer exists.

/** Portal the items live in. */
export const PORTAL_URL =
  import.meta.env.VITE_PORTAL_URL ?? "https://cdot.maps.arcgis.com";
