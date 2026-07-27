// Optional reference layers for the TAZ selection map.
//
// These are context only: they never feed a calculation and never intercept a
// map click (they sit below the transparent hit-test TAZ layer, and hitTest
// explicitly includes only that layer). Each one earns its place by helping the
// user answer an input the calculator actually asks for, which is the bar for
// adding more.
//
// Durability is the other bar. Every layer here is published by an institution
// that maintains it as part of its job: CDOT's enterprise GIS (the same AGOL org
// that hosts this tool's TAZ layer) or Esri's Living Atlas. No individual
// accounts, no consultant one-offs.
//
// Availability is probed once, after the map is ready, and failures are silent:
// a layer that does not load is dropped from the picker, and if none load the
// picker never appears. See probeReferenceLayers below.

import FeatureLayer from "@arcgis/core/layers/FeatureLayer";
import { MAP_STYLE } from "../config/mapStyle";

const STYLES = MAP_STYLE.referenceLayers ?? {};

export interface ReferenceLayerDef {
  id: string;
  /** Picker label. Names the source, since that is what makes it trustworthy. */
  label: string;
  /** One line on what it is good for; shown as the control's title. */
  hint: string;
  url: string;
  geometry: "line" | "point";
}

export const REFERENCE_LAYERS: ReferenceLayerDef[] = [
  {
    id: "transit_lines_esri",
    label: "Transit Lines (Esri)",
    hint: "World transit lines by modality, from Esri's Living Atlas. Broad coverage including operators absent from the CDOT compilation.",
    url: "https://services6.arcgis.com/4J5SL9a8ALg9oNpW/arcgis/rest/services/Transit_Lines_by_Modality_RC1/FeatureServer/0",
    geometry: "line",
  },
  {
    id: "transit_routes_cdot",
    label: "Transit Routes (CDOT)",
    hint: "CDOT's statewide transit routes, compiled from local agency GTFS. The layer the transit strategies already tell you to check when estimating a service-mile or frequency change.",
    url: "https://services.arcgis.com/yzB9WM8W0BO3Ql7d/arcgis/rest/services/Statewide_Transit_Routes/FeatureServer/0",
    geometry: "line",
  },
  {
    id: "transit_stops_cdot",
    label: "Transit Stops (CDOT)",
    hint: "Statewide transit stops and stations. Useful for the share-of-stops inputs in Transit Shelters and Wayfinding.",
    url: "https://services.arcgis.com/yzB9WM8W0BO3Ql7d/arcgis/rest/services/Statewide_Transit_Points/FeatureServer/0",
    geometry: "point",
  },
  {
    id: "traffic_counts_cdot",
    label: "Traffic Counts (CDOT)",
    hint: "Annual average daily traffic on state highways. Useful for the share-of-area-VMT inputs in the bike facility strategies.",
    url: "https://dtdapps.codot.gov/server/rest/services/Webapps/open_data_sde/FeatureServer/13",
    geometry: "line",
  },
];

/** Build the (unloaded) layer for a definition, styled from mapStyle.json. */
function buildLayer(def: ReferenceLayerDef): FeatureLayer {
  const s = STYLES[def.id] ?? {};
  const symbol =
    def.geometry === "point"
      ? {
          type: "simple-marker",
          style: "circle",
          color: s.markerColor ?? [90, 90, 90, 0.9],
          size: s.markerSize ?? 4.5,
          outline: {
            color: s.markerOutlineColor ?? [255, 255, 255, 0.9],
            width: s.markerOutlineWidth ?? 0.6,
          },
        }
      : {
          type: "simple-line",
          color: s.lineColor ?? [90, 90, 90, 0.85],
          width: s.lineWidth ?? 1.6,
        };

  return new FeatureLayer({
    url: def.url,
    id: `ref-${def.id}`,
    title: def.label,
    // Off until the user asks for it: no tile or query traffic on load, and the
    // map looks exactly as it did before this feature existed.
    visible: false,
    // Reference context must not be clickable or selectable.
    popupEnabled: false,
    legendEnabled: false,
    listMode: "hide",
    renderer: { type: "simple", symbol } as never,
  });
}

export interface ProbedReferenceLayer {
  def: ReferenceLayerDef;
  layer: FeatureLayer;
}

/**
 * Load each reference layer's metadata and return only the ones that answered.
 *
 * Silent by design: an unreachable, deleted, or newly-private layer resolves to
 * "not available" and is simply absent from the picker. A `console.debug` is
 * left behind for anyone diagnosing a missing layer, but nothing surfaces to the
 * user, and one bad layer never affects the others.
 */
export async function probeReferenceLayers(): Promise<ProbedReferenceLayer[]> {
  const results = await Promise.all(
    REFERENCE_LAYERS.map(async (def) => {
      const layer = buildLayer(def);
      try {
        await layer.load();
        return { def, layer };
      } catch (e) {
        console.debug(`reference layer unavailable, skipping: ${def.id}`, e);
        try {
          layer.destroy();
        } catch {
          /* already disposed */
        }
        return null;
      }
    }),
  );
  return results.filter((r): r is ProbedReferenceLayer => r !== null);
}
