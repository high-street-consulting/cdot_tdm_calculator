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

export interface ReferenceLayerDef {
  id: string;
  /** Picker label. Names the source, since that is what makes it trustworthy. */
  label: string;
  /** One line on what it is good for; shown as the control's title. */
  hint: string;
  url: string;
}

export const REFERENCE_LAYERS: ReferenceLayerDef[] = [
  {
    id: "transit_lines_esri",
    label: "Transit Lines (Esri)",
    hint: "World Transit Lines by Modality, from Esri's Living Atlas. Drawn in Esri's own mode colors: bus green, light rail indigo, rail and subway orange.",
    url: "https://services6.arcgis.com/4J5SL9a8ALg9oNpW/arcgis/rest/services/Transit_Lines_by_Modality_RC1/FeatureServer/0",
  },
];

/**
 * Build the (unloaded) layer for a definition.
 *
 * No `renderer` is set, deliberately: each layer draws with the symbology its own
 * service publishes. For World Transit Lines that is a unique-value renderer on
 * `esri_route_type_carto_desc` separating bus, light rail, rail/subway, ferry,
 * aerial lift and the rest, which carries more information than any flat line we
 * would substitute. A future layer that publishes no useful symbology of its own
 * can take a `renderer` here (and a swatch in ReferenceLayers.tsx).
 */
function buildLayer(def: ReferenceLayerDef): FeatureLayer {
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
