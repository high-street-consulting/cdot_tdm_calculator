// CAPCOA 2021 combination engine (tdm_strategy_combination_spec.md §2–§4).
//
// Pure, per-(TAZ, purpose-pool) math: given the reduction fractions of the
// strategies acting on one pool of one TAZ, plus that TAZ's place-type caps,
// return the combined pool reduction fraction and a per-strategy attribution.
//
// Key facts that make this simple and correct:
//  - Multiplicative combination `1 - Π(1-rᵢ)` is commutative/associative, so
//    grouping by mechanism (spec Step 5) and grouping by subsector (spec §3.1
//    nested caps) yield the SAME combined number when there are no
//    mechanism-level caps — and CAPCOA defines none. The ONLY reason to group
//    is to apply caps. We therefore group by subsector to apply the nested
//    caps (land_use ⊂ built-env ⊂ global; CTR separate) and the product is the
//    cross-mechanism compounding of Step 6.
//  - Caps are applied per purpose pool, per TAZ (place type varies by TAZ), so
//    the engine runs at that grain and absolute VMT saved is summed afterward.

import type { CapcoaSubsector, PlaceTypeCaps } from "./catalog";

export type PlaceType = "urban_core" | "urban" | "suburban" | "rural";

/** One strategy's contribution to one pool of one TAZ. */
export interface Contributor {
  id: string;
  subsector: CapcoaSubsector;
  /** Reduction fraction of the pool base (post per-measure cap). >0 = reduction. */
  r: number;
  /** True if the per-measure cap already clamped `r`. */
  measureCapped: boolean;
}

export interface PoolCombineResult {
  /** Combined pool reduction fraction after all nested + global caps. */
  R: number;
  /** id → absolute reduction fraction attributed to that strategy (Σ = R). */
  attribution: Record<string, number>;
  /** Ids whose contribution was reduced by a measure/tier/global cap. */
  cappedIds: Set<string>;
  /** Which cap tiers bound: 'measure' | 'land_use' | 'category' | 'ctr' | 'global'. */
  boundCaps: Set<string>;
}

const BUILT_ENV: CapcoaSubsector[] = [
  "land_use",
  "neighborhood_design",
  "parking",
  "transit",
];

/** Multiplicative combine: 1 − Π(1−rᵢ). */
export function combineFractions(rs: number[]): number {
  let keep = 1;
  for (const r of rs) keep *= 1 - r;
  return 1 - keep;
}

function sumBy<T>(xs: T[], f: (x: T) => number): number {
  let s = 0;
  for (const x of xs) s += f(x);
  return s;
}

/**
 * Combine one pool of one TAZ. `caps` are in PERCENT (as authored in
 * globals.yaml); `ctrCap` is the CTR subgroup cap in percent.
 */
export function combinePool(
  contribs: Contributor[],
  placeType: PlaceType,
  caps: PlaceTypeCaps,
  ctrCap: number,
): PoolCombineResult {
  const boundCaps = new Set<string>();
  const cappedIds = new Set<string>();
  for (const c of contribs) if (c.measureCapped) { cappedIds.add(c.id); boundCaps.add("measure"); }

  if (contribs.length === 0) {
    return { R: 0, attribution: {}, cappedIds, boundCaps };
  }

  const landCap = (caps.land_use[placeType] ?? 100) / 100;
  const catCap = (caps.category[placeType] ?? 100) / 100;
  const globalCap = (caps.global[placeType] ?? 100) / 100;
  const ctrCapFrac = ctrCap / 100;

  const bySub = (s: CapcoaSubsector) => contribs.filter((c) => c.subsector === s);

  // Subsector-level combined reductions.
  const rLandRaw = combineFractions(bySub("land_use").map((c) => c.r));
  const rLand = Math.min(rLandRaw, landCap);
  if (rLandRaw > landCap + 1e-12) {
    boundCaps.add("land_use");
    for (const c of bySub("land_use")) cappedIds.add(c.id);
  }
  const rNeigh = combineFractions(bySub("neighborhood_design").map((c) => c.r));
  const rPark = combineFractions(bySub("parking").map((c) => c.r));
  const rTransit = combineFractions(bySub("transit").map((c) => c.r));

  // Built-environment (4 non-CTR subsectors) combined, then category cap.
  const rBuiltRaw = combineFractions([rLand, rNeigh, rPark, rTransit]);
  const rBuilt = Math.min(rBuiltRaw, catCap);
  if (rBuiltRaw > catCap + 1e-12) {
    boundCaps.add("category");
    for (const c of contribs) if (BUILT_ENV.includes(c.subsector)) cappedIds.add(c.id);
  }

  // CTR subgroup combined, then CTR cap.
  const rCtrRaw = combineFractions(bySub("commute_trip_reduction").map((c) => c.r));
  const rCtr = Math.min(rCtrRaw, ctrCapFrac);
  if (rCtrRaw > ctrCapFrac + 1e-12) {
    boundCaps.add("ctr");
    for (const c of bySub("commute_trip_reduction")) cappedIds.add(c.id);
  }

  // Global cap across all subsectors (Step 7).
  const rPoolRaw = combineFractions([rBuilt, rCtr]);
  const R = Math.min(rPoolRaw, globalCap);
  if (rPoolRaw > globalCap + 1e-12) {
    boundCaps.add("global");
    for (const c of contribs) cappedIds.add(c.id);
  }

  // Attribution: distribute the (capped) pool reduction R across contributors
  // by log-share weight −ln(1−rᵢ), which is exact for multiplicative combos.
  const weights = contribs.map((c) => ({
    id: c.id,
    w: c.r > 0 && c.r < 1 ? -Math.log(1 - c.r) : Math.max(c.r, 0),
  }));
  const wsum = sumBy(weights, (x) => x.w);
  const attribution: Record<string, number> = {};
  if (wsum > 0) {
    for (const { id, w } of weights) attribution[id] = (attribution[id] ?? 0) + (R * w) / wsum;
  }
  return { R, attribution, cappedIds, boundCaps };
}

/**
 * Classify a TAZ's place type from `area_type` (if a valid enum) else the
 * activity-density thresholds (pop+emp per sq mi). Falls back to rural.
 */
export function classifyPlaceType(
  areaType: string | undefined,
  activityDensity: number | undefined,
  thresholds: Record<string, number>,
): PlaceType {
  if (
    areaType === "urban_core" ||
    areaType === "urban" ||
    areaType === "suburban" ||
    areaType === "rural"
  ) {
    return areaType;
  }
  const ad = Number.isFinite(activityDensity) ? (activityDensity as number) : 0;
  if (ad >= (thresholds.urban_core ?? Infinity)) return "urban_core";
  if (ad >= (thresholds.urban ?? Infinity)) return "urban";
  if (ad >= (thresholds.suburban ?? Infinity)) return "suburban";
  return "rural";
}
