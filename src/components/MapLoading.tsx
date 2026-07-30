// Branded loading overlay for the map area. Used in two places:
//   1. The Suspense fallback in App.tsx, while the lazy map chunk downloads.
//   2. Inside MapCanvas, while the ArcGIS view initializes (until view.when()).
// Purely presentational, with no dependencies, so it's safe to keep in the entry
// bundle without pulling in @arcgis/core.
export function MapLoading() {
  return (
    <div className="map-loading" role="status" aria-live="polite">
      <div className="map-loading-spinner" aria-hidden="true" />
      <div className="map-loading-label">Loading map…</div>
    </div>
  );
}
