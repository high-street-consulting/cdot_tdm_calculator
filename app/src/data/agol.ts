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

/**
 * Web map item: NO LONGER USED AT RUNTIME. The app loads the TAZ feature layer
 * directly and reads its basemap/extent/symbology from config/mapStyle.json, so
 * nothing imports this anymore (kept only as a pointer to the AGOL artifact; the
 * web map item itself can be deleted from AGOL without affecting the app).
 */
export const WEBMAP_ITEM_ID =
  import.meta.env.VITE_WEBMAP_ITEM_ID ?? "bc54be72a9184b47a4f5d563f5565c6a";

/** Portal the items live in. */
export const PORTAL_URL =
  import.meta.env.VITE_PORTAL_URL ?? "https://cdot.maps.arcgis.com";
