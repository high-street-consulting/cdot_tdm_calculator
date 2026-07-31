// Fetch full TAZ attributes for a set of TAZ IDs directly from the published
// hosted feature layer. The strategy functions need the long ACS / network
// columns that aren't surfaced in the web map's popup config.

import FeatureLayer from "@arcgis/core/layers/FeatureLayer";
import type { TazInputs } from "../strategies/types";
import { TAZ_LAYER_URL } from "./agol";

const TAZ_FIELDS = [
  "taz_id",
  "county",
  "mpo",
  "area_type",
  "area_sqmi",
  "population",
  "employment",
  "households",
  "pop_density",
  "emp_density",
  "activity_density",
  "daily_vmt",
  "daily_trips",
  "avg_trip_length",
  "annual_bikeable_days_taz",
  "acs_total_workers",
  "acs_drove_alone_share",
  "acs_carpool_share",
  "acs_transit_share",
  "acs_bike_share",
  "acs_walk_share",
  "lane_mi_freeway",
  "lane_mi_expressway",
  "lane_mi_major_arterial",
  "lane_mi_minor_arterial",
  "lane_mi_collector",
  "lane_mi_local",
  // Transit service + bike network: parent-gate fields for wayfinding (and
  // future transit/active strategies). Already published on the enriched layer.
  "transit_vrh",
  "transit_route_count",
  "bike_centerline_mi",
  // Observed average vehicle occupancy from the TDM model (getAvo prefers it
  // over the statewide default). Requires the republished layer.
  "avo",
  // Observed VMT-purpose split (baseVmt prefers these) + park-and-ride observed
  // inputs (model trip length, drive-to-transit access). Republished layer.
  "vmt_share_commute",
  "vmt_share_recreational",
  "vmt_share_other",
  "tdm_avg_trip_length_mi",
  "drive_to_transit_share",
];

let cachedLayer: FeatureLayer | null = null;
function getLayer(provided?: FeatureLayer | null): FeatureLayer {
  if (provided) return provided;
  if (!cachedLayer) {
    cachedLayer = new FeatureLayer({ url: TAZ_LAYER_URL });
  }
  return cachedLayer;
}

/**
 * Query the TAZ feature service for the attributes of `tazIds` and convert
 * each row into a `TazInputs` blob the strategy functions can consume.
 *
 * Splits large id lists into 200-id chunks to stay under the AGOL where-clause
 * length limit.
 */
export async function queryTazInputs(
  tazIds: ReadonlySet<string>,
  layer?: FeatureLayer | null,
): Promise<TazInputs[]> {
  if (tazIds.size === 0) return [];
  const fl = getLayer(layer);
  const ids = Array.from(tazIds);
  const CHUNK = 200;
  const results: TazInputs[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const idList = chunk.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
    const q = fl.createQuery();
    q.where = `taz_id IN (${idList})`;
    q.outFields = TAZ_FIELDS;
    q.returnGeometry = false;
    const fs = await fl.queryFeatures(q);
    for (const f of fs.features) {
      const attrs = f.attributes as TazInputs;
      // taz_id is a SmallInteger field, so AGOL returns it as a number; the
      // selection set and all id lookups use strings (e.g. the report's
      // per-TAZ roster does inputsById.get(stringId)). Normalize to string so
      // those lookups match.
      attrs.taz_id = String(attrs.taz_id);
      results.push(attrs);
    }
  }
  return results;
}
