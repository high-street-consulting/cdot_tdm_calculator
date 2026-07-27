// Typed loader for the standalone map styling config (mapStyle.json).
//
// Both maps in the app read their basemap + symbology from here: the
// interactive TAZ map (components/MapView) and the printable report's
// project-area map (data/reportMap). To restyle the maps (basemap, default
// view, boundary line, selection/draw colors) edit mapStyle.json; nothing in
// the component code needs to change.

import raw from "./mapStyle.json";

export interface MapStyle {
  /** Esri basemap id (e.g. "streets-navigation-vector") or a basemap style. */
  basemap: string;
  /** Interactive map's starting camera. */
  initialView: { center: number[]; zoom: number };
  /** Visible TAZ boundary line (painted via the vector tile layer). */
  tazBoundary: {
    lineColor: string;
    lineOpacity: number;
    lineDasharray: number[];
    /** [zoom, widthPx] pairs, linearly interpolated. */
    lineWidthZoomStops: number[][];
  };
  /** Selected-TAZ highlight overlay (interactive map + report map). */
  selection: { fillColor: number[]; outlineColor: number[]; outlineWidth: number };
  /** Polygon-draw preview while selecting an area. */
  sketch: {
    fillColor: number[];
    outlineColor: number[];
    outlineWidth: number;
    outlineStyle: string;
  };
  /**
   * Symbology for the optional reference layers (data/referenceLayers.ts), keyed
   * by layer id. Line layers read lineColor/lineWidth, point layers the marker*
   * fields. Every field is optional, so a layer can be listed before it is styled
   * and the code falls back to a neutral grey.
   */
  referenceLayers?: Record<
    string,
    {
      lineColor?: number[];
      lineWidth?: number;
      markerColor?: number[];
      markerSize?: number;
      markerOutlineColor?: number[];
      markerOutlineWidth?: number;
    }
  >;
}

export const MAP_STYLE = raw as MapStyle;
