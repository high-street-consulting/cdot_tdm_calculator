// Per-strategy "Project context" rows: small fact pills shown in the
// DetailView that surface the underlying data from the user's selected TAZs.
// Each strategy gets a curated set of rows so the user can see the actual
// numbers driving the calculation (current density, mode share, lane miles,
// etc.) and, where meaningful, the before/after projection given the user's
// current input values.

import {
  BEHAVIORAL_DEFAULTS,
  ELASTICITIES,
  FACILITY_TO_INDUCED_ELASTICITY,
  PROGRAM_EFFECTS,
  VMT_PURPOSE_SHARE,
} from "./constants";
import type { StrategyKey } from "./strategies";
import type { TazInputs } from "./types";
import { imputedModeShare, imputedParking } from "./util";

export interface ContextRow {
  /** Short label shown above the value (uppercase overline style). */
  label: string;
  /** The current/baseline value, formatted for display. */
  value: string;
  /** Optional unit suffix (e.g., "/sq mi", "% VMT"). Rendered smaller. */
  unit?: string;
  /** Projected value given the user's inputs (e.g., 20% density increase). */
  projected?: string;
  /** Where this value came from. Shown small/muted under the value. */
  source?: string;
  /** True when the value couldn't be computed from the available data. */
  unavailable?: boolean;
  /**
   * When set, this data-derived row maps cleanly onto a single per-TAZ `dslRow`
   * variable and may be overridden per-strategy. The value is the variable name
   * the override replaces (e.g. "transit_mode_share", "avo", "parking_price").
   * Methodology-constant rows (elasticities, boost/substitution factors) and
   * pure-aggregate rows (commute VMT, project area, TAZ count) are NOT tagged.
   */
  overrideKey?: string;
  /**
   * The current numeric baseline behind `value`, UNformatted, so a UI can seed
   * the override input box. Only present on rows that carry an `overrideKey`.
   */
  rawValue?: number;
  /**
   * True when a `contextOverride` was supplied for this row's `overrideKey`; the
   * `value` shown is then the overridden number (reformatted). Lets the UI paint
   * a "modified" indicator.
   */
  overridden?: boolean;
  /**
   * True when the builder itself already computed `value` in an override-aware
   * way (i.e. it read the override from `contextOverrides` and folded it into a
   * derived display, like "Commute VMT base" → miles/day). getStrategyContext
   * still sets `overridden` from the override's presence, but does NOT replace
   * `value` with the generic OVERRIDE_FORMATTERS output for these rows.
   */
  computedValue?: boolean;
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Sum a numeric column across the selected TAZs (NaN/undefined → 0). */
function totalOf(tazs: TazInputs[], key: keyof TazInputs): number {
  return sum(tazs.map((t) => (finite(t[key]) ? (t[key] as number) : 0)));
}

/** Area-weighted average density = sum(value) / sum(area). */
function aggregateDensity(
  tazs: TazInputs[],
  numKey: keyof TazInputs,
): number | null {
  const area = totalOf(tazs, "area_sqmi");
  const value = totalOf(tazs, numKey);
  if (area <= 0) return null;
  return value / area;
}

/**
 * Aggregate mode share across the selected TAZs using the same imputation
 * the strategies use: ACS B08301 when present, MODE_SHARE_BY_AREA_TYPE
 * otherwise. Weighted by ACS workers when available, by population when not
 * (so area-type-imputed TAZs are still represented proportionally).
 */
function aggregateModeShare(
  tazs: TazInputs[],
  field: "transit" | "auto" | "bike" | "walk",
): { value: number; acsCovered: number; total: number } {
  let num = 0;
  let den = 0;
  let acsCovered = 0;
  for (const t of tazs) {
    const ms = imputedModeShare(t);
    const isAcs = ms.source === "acs_b08301_commute";
    if (isAcs) acsCovered += 1;
    const w = isAcs
      ? (t.acs_total_workers ?? 0)
      : (typeof t.population === "number" && t.population > 0 ? t.population : 1);
    num += w * ms[field];
    den += w;
  }
  return {
    value: den > 0 ? num / den : 0,
    acsCovered,
    total: tazs.length,
  };
}

/** Mean of a numeric column across TAZs (excluding nulls). */
function meanOf(tazs: TazInputs[], key: keyof TazInputs): number | null {
  const vals = tazs.map((t) => t[key]).filter((v): v is number => finite(v));
  if (vals.length === 0) return null;
  return sum(vals) / vals.length;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const fmt0 = (n: number) => Math.round(n).toLocaleString("en-US");
const fmt1 = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
const fmtPct1 = (frac: number) => `${(frac * 100).toFixed(1)}%`;

/**
 * Per-row formatters keyed by overrideKey, so an overridden numeric value can be
 * re-rendered exactly like the baseline it replaces. Kept in one place so the
 * builders (which set `value` + `rawValue`) and getStrategyContext (which
 * reformats the override) never drift.
 */
export const OVERRIDE_FORMATTERS: Record<string, (n: number) => string> = {
  transit_mode_share: fmtPct1,
  auto_mode_share: fmtPct1,
  bike_mode_share: fmtPct1,
  walk_mode_share: fmtPct1,
  avo: (n) => n.toFixed(2),
  pop_density: fmt0,
  emp_density: fmt0,
  parking_price: (n) => `$${n.toFixed(2)}`,
  // --- Methodology-CONSTANT overrides (DSL spec.const names) ---
  r_ctr: fmtPct1, // tmo_coverage per-eligible CTR reduction
  avg_fare: (n) => `$${n.toFixed(2)}`, // employee_commuting_benefits assumed transit fare
  max_tod_transit_share: fmtPct1, // TOD realistic transit-share ceiling
  trip_red_ratio: fmtPct1, // new_transit_service trip->VMT reduction ratio
  bike_len: (n) => `${n.toFixed(1)} mi`, // assumed bike trip length (3 bike strategies)
  adj: fmtPct1, // bike-share boost (sharrows / end-of-trip)
  // --- Aggregate / row-var overrides threaded through the compute layer ---
  vmt_share_commute: fmtPct1, // commute purpose split behind "Commute VMT base"
  avg_trip_length: (n) => `${n.toFixed(1)} mi`, // avg vehicle trip length (bike / micromobility)
};

/**
 * Effective commute purpose-share of VMT across the selection: the observed
 * VMT-weighted `vmt_share_commute` where TAZs carry it, the statewide default
 * (VMT_PURPOSE_SHARE.commute) otherwise. This is the raw baseline behind the
 * "Commute VMT base" pill and seeds its `vmt_share_commute` override, matching
 * how baseVmt/dslRow resolve the commute share per TAZ.
 */
function effectiveCommuteShare(tazs: TazInputs[]): number {
  let num = 0;
  let den = 0;
  for (const t of tazs) {
    const vmt = finite(t.daily_vmt) ? t.daily_vmt : 0;
    const observed = t.vmt_share_commute;
    const share =
      typeof observed === "number" && Number.isFinite(observed)
        ? observed
        : VMT_PURPOSE_SHARE.commute;
    num += vmt * share;
    den += vmt;
  }
  return den > 0 ? num / den : VMT_PURPOSE_SHARE.commute;
}

/**
 * The "Commute VMT base" row, override-aware. Its DISPLAYED value is ALWAYS
 * miles/day = effectiveShare × totalDailyVmt (never the raw share %):
 *  - `totalDailyVmt` is the sum of the (already baseline-scaled, since DetailView
 *    passes scaledTazInputs) `daily_vmt` over the tazs the builder receives.
 *  - `effectiveShare` is the `vmt_share_commute` override if one is present in
 *    `contextOverrides`, else the modeled share (VMT-weighted per-TAZ share /
 *    statewide default) — the same value the calc uses.
 * `rawValue` stays the MODELED share (a fraction) so the editor's % input and
 * its "Area baseline: X%" reference stay correct. `computedValue` is set so
 * getStrategyContext keeps this derived miles value instead of reformatting the
 * override as a percent.
 */
function commuteVmtBaseRow(
  tazs: TazInputs[],
  contextOverrides?: Record<string, number>,
): ContextRow {
  const modeledShare = effectiveCommuteShare(tazs);
  const ov = contextOverrides?.["vmt_share_commute"];
  const hasOverride = typeof ov === "number" && Number.isFinite(ov);
  const effShare = hasOverride ? ov : modeledShare;
  const totalDailyVmt = totalOf(tazs, "daily_vmt");
  return {
    label: "Commute VMT base",
    value: fmt0(effShare * totalDailyVmt),
    unit: "mi / day",
    source: `${Math.round(effShare * 100)}% of total VMT (CDOT default purpose split)`,
    overrideKey: "vmt_share_commute",
    // rawValue is the MODELED share so the editor seeds "Area baseline: X%".
    rawValue: modeledShare,
    overridden: hasOverride,
    computedValue: true,
  };
}

function modeShareSourceNote(agg: {
  acsCovered: number;
  total: number;
}): string {
  if (agg.total === 0) return "";
  if (agg.acsCovered === agg.total) return `ACS B08301, worker-weighted across ${agg.total} TAZs`;
  if (agg.acsCovered === 0) return `area-type defaults (no ACS coverage in selection)`;
  return `ACS B08301 for ${agg.acsCovered}/${agg.total} TAZs; area-type defaults for the rest`;
}

/**
 * Population-weighted mean of the imputed daily parking price and share-paying
 * across the selection. Colorado has no observed parking-price dataset, so the
 * engine imputes both from each TAZ's area type (see util.imputedParking).
 */
function aggregateParking(tazs: TazInputs[]): { price: number; sharePaying: number } {
  let pw = 0;
  let sw = 0;
  let wsum = 0;
  for (const t of tazs) {
    const p = imputedParking(t);
    const w = typeof t.population === "number" && t.population > 0 ? t.population : 1;
    pw += p.price * w;
    sw += p.sharePaying * w;
    wsum += w;
  }
  return wsum > 0 ? { price: pw / wsum, sharePaying: sw / wsum } : { price: 0, sharePaying: 0 };
}

/** Shared rows for the three parking-pricing tiles (workplace / curb / dynamic). */
function parkingRows(
  tazs: TazInputs[],
  values: Record<string, number | string>,
  purpose: "commute" | "all",
): ContextRow[] {
  const { price, sharePaying } = aggregateParking(tazs);
  const newPrice = Number(values["new_price"] ?? 0);
  const effectiveOld = price > 0 ? price : newPrice / 2;
  const pctChange = effectiveOld > 0 ? (newPrice - effectiveOld) / effectiveOld : 0;
  const rows: ContextRow[] = [
    {
      label: "Current daily parking price",
      value: `$${price.toFixed(2)}`,
      unit: "/ day",
      projected:
        newPrice > 0
          ? `→ $${newPrice.toFixed(2)} proposed (${pctChange >= 0 ? "+" : "−"}${Math.abs(pctChange * 100).toFixed(0)}%${price <= 0 ? ", from $0 baseline" : ""})`
          : undefined,
      source: "area-type default (no statewide observed parking-price data)",
      overrideKey: "parking_price",
      rawValue: price,
    },
  ];
  if (purpose === "commute") {
    rows.push({
      label: "Share of employees who pay",
      value: fmtPct1(sharePaying),
      source: "area-type default",
    });
  } else {
    rows.push({
      label: "Share of area VMT priced",
      value: fmtPct1(Number(values["share_affected"] ?? 0)),
      source: "User-supplied",
    });
  }
  rows.push({
    label: "Parking demand elasticity",
    value: `ε = ${ELASTICITIES.parking_demand}`,
    source: "CAPCOA parking-pricing measures",
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Per-strategy context builders
//
// Keyed by the live catalog strategy id (== StrategyKey tile). Every strategy
// whose calculation reads backend/TAZ data has an entry here so the DetailView
// "Project context" panel surfaces that data (and, where meaningful, the
// before/after projection) while the user configures inputs.
// ---------------------------------------------------------------------------

type Builder = (
  tazs: TazInputs[],
  values: Record<string, number | string>,
  contextOverrides?: Record<string, number>,
) => ContextRow[];

const builders: Partial<Record<StrategyKey, Builder>> = {
  residential_density: (tazs, values) => {
    const resD = aggregateDensity(tazs, "population");
    const delta = Number(values["pct_change_res_density"] ?? 0);
    const totalArea = totalOf(tazs, "area_sqmi");
    const rows: ContextRow[] = [];
    if (resD != null) {
      rows.push({
        label: "Current residential density",
        value: fmt0(resD),
        unit: "ppl / sq mi",
        projected:
          delta !== 0
            ? `${fmt0(resD * (1 + delta))} ppl / sq mi after ${delta >= 0 ? "+" : ""}${Math.round(delta * 100)}%`
            : undefined,
        source: "CDOT 2019 SWTDM TAZ population / area",
        overrideKey: "pop_density",
        rawValue: resD,
      });
    }
    rows.push({
      label: "Project area",
      value: fmt1(totalArea),
      unit: "sq mi",
      source: `${tazs.length} TAZ${tazs.length === 1 ? "" : "s"}`,
    });
    rows.push({
      label: "Elasticity applied",
      value: `ε_res = ${ELASTICITIES.residential_density}`,
      source: "Stevens (2016) meta-analysis",
    });
    return rows;
  },

  employment_density: (tazs, values) => {
    const empD = aggregateDensity(tazs, "employment");
    const delta = Number(values["pct_change_emp_density"] ?? 0);
    const totalArea = totalOf(tazs, "area_sqmi");
    const rows: ContextRow[] = [];
    if (empD != null) {
      rows.push({
        label: "Current employment density",
        value: fmt0(empD),
        unit: "jobs / sq mi",
        projected:
          delta !== 0
            ? `${fmt0(empD * (1 + delta))} jobs / sq mi after ${delta >= 0 ? "+" : ""}${Math.round(delta * 100)}%`
            : undefined,
        source: "CDOT 2019 SWTDM TAZ employment / area",
        overrideKey: "emp_density",
        rawValue: empD,
      });
    }
    rows.push({
      label: "Project area",
      value: fmt1(totalArea),
      unit: "sq mi",
      source: `${tazs.length} TAZ${tazs.length === 1 ? "" : "s"}`,
    });
    rows.push({
      label: "Elasticity applied",
      value: `ε_emp = ${ELASTICITIES.employment_density}`,
      source: "Stevens (2016) meta-analysis",
    });
    return rows;
  },

  separated_bike_lanes: (tazs) => {
    const days =
      meanOf(tazs, "annual_bikeable_days_taz") ??
      meanOf(tazs, "annual_bikeable_days_county") ??
      BEHAVIORAL_DEFAULTS.annual_bikeable_days;
    const avgTripLen =
      meanOf(tazs, "avg_trip_length") ?? BEHAVIORAL_DEFAULTS.avg_vehicle_trip_length_mi;
    return [
      {
        label: "Annual bikeable days",
        value: fmt0(days),
        unit: "days / year",
        source: "NOAA NCEI 1991-2020 daily normals (per-TAZ IDW)",
      },
      {
        label: "Avg vehicle trip length",
        value: avgTripLen.toFixed(1),
        unit: "mi",
        source: "CDOT 2019 SWTDM (VMT ÷ trips)",
        overrideKey: "avg_trip_length",
        rawValue: avgTripLen,
      },
      {
        label: "Bike trip length assumed",
        value: BEHAVIORAL_DEFAULTS.avg_bike_trip_length_mi.toFixed(1),
        unit: "mi",
        source: "NACTO bikeshare average",
        overrideKey: "bike_len",
        rawValue: BEHAVIORAL_DEFAULTS.avg_bike_trip_length_mi,
      },
      {
        label: "Effect size",
        value: `ε = ${ELASTICITIES.bike_facility}`,
        source: "CAPCOA T-21 (sharrows / bike lane)",
      },
    ];
  },

  sharrows_bike_lanes: (tazs) => {
    const bike = aggregateModeShare(tazs, "bike");
    const auto = aggregateModeShare(tazs, "auto");
    const boost = PROGRAM_EFFECTS.sharrows_bike_share_boost;
    return [
      {
        label: "Current bike commute share",
        value: fmtPct1(bike.value),
        projected: `${fmtPct1(bike.value * (1 + boost))} after +${Math.round(boost * 100)}% boost`,
        source: modeShareSourceNote(bike),
        overrideKey: "bike_mode_share",
        rawValue: bike.value,
      },
      {
        label: "Current auto commute share",
        value: fmtPct1(auto.value),
        source: "ACS B08301 (drove alone + carpool); area-type fallback for non-ACS TAZs",
        overrideKey: "auto_mode_share",
        rawValue: auto.value,
      },
      {
        label: "Bike-share boost",
        value: fmtPct1(boost),
        source: "CAPCOA T-21 (sharrows / bike-lane retrofit)",
        overrideKey: "adj",
        rawValue: boost,
      },
      {
        label: "Bike trip length assumed",
        value: BEHAVIORAL_DEFAULTS.avg_bike_trip_length_mi.toFixed(1),
        unit: "mi",
        source: "NACTO bikeshare average",
        overrideKey: "bike_len",
        rawValue: BEHAVIORAL_DEFAULTS.avg_bike_trip_length_mi,
      },
    ];
  },

  end_of_trip_facilities: (tazs) => {
    const bike = aggregateModeShare(tazs, "bike");
    const auto = aggregateModeShare(tazs, "auto");
    const boost = PROGRAM_EFFECTS.end_of_trip_bike_share_boost;
    return [
      {
        label: "Current bike commute share",
        value: fmtPct1(bike.value),
        projected: `${fmtPct1(bike.value * (1 + boost))} after +${Math.round(boost * 100)}% boost`,
        source: modeShareSourceNote(bike),
        overrideKey: "bike_mode_share",
        rawValue: bike.value,
      },
      {
        label: "Current auto commute share",
        value: fmtPct1(auto.value),
        source: "ACS B08301 (drove alone + carpool); area-type fallback for non-ACS TAZs",
        overrideKey: "auto_mode_share",
        rawValue: auto.value,
      },
      {
        label: "Bike-share boost",
        value: fmtPct1(boost),
        source: "CAPCOA T-21 (end-of-trip facilities)",
        overrideKey: "adj",
        rawValue: boost,
      },
      {
        label: "Bike trip length assumed",
        value: BEHAVIORAL_DEFAULTS.avg_bike_trip_length_mi.toFixed(1),
        unit: "mi",
        source: "NACTO bikeshare average",
        overrideKey: "bike_len",
        rawValue: BEHAVIORAL_DEFAULTS.avg_bike_trip_length_mi,
      },
    ];
  },

  transit_service_expansion: (tazs, values) => {
    const transit = aggregateModeShare(tazs, "transit");
    const auto = aggregateModeShare(tazs, "auto");
    const basis = String(values["basis"] ?? "frequency");
    return [
      {
        label: "Current transit commute share",
        value: fmtPct1(transit.value),
        source: modeShareSourceNote(transit),
        overrideKey: "transit_mode_share",
        rawValue: transit.value,
      },
      {
        label: "Current auto commute share",
        value: fmtPct1(auto.value),
        source: "ACS B08301 (drove alone + carpool); area-type fallback for non-ACS TAZs",
        overrideKey: "auto_mode_share",
        rawValue: auto.value,
      },
      {
        label: "Statewide AVO assumed",
        value: BEHAVIORAL_DEFAULTS.avo.toFixed(2),
        source: "NHTS 2017 statewide default",
        overrideKey: "avo",
        rawValue: BEHAVIORAL_DEFAULTS.avo,
      },
      {
        label: "Elasticity",
        value:
          basis === "frequency"
            ? `ε = ${ELASTICITIES.transit_frequency} (Handy 2013)`
            : `ε = ${ELASTICITIES.transit_service_miles} (TCRP 95)`,
      },
    ];
  },

  shared_micromobility: (tazs, values) => {
    const persons = totalOf(tazs, "population") + totalOf(tazs, "employment");
    const trips = totalOf(tazs, "daily_trips");
    const tripsPerPerson = persons > 0 ? trips / persons : 0;
    const avgTripLen =
      meanOf(tazs, "avg_trip_length") ?? BEHAVIORAL_DEFAULTS.avg_vehicle_trip_length_mi;
    const type = String(values["micromobility_type"] ?? "bikeshare");
    return [
      {
        label: "Persons in project area",
        value: fmt0(persons),
        unit: "pop + jobs",
        source: "CDOT 2019 SWTDM (population + employment)",
      },
      {
        label: "Daily vehicle trips / person",
        value: tripsPerPerson.toFixed(2),
        source: "CDOT 2019 SWTDM (trips ÷ persons)",
      },
      {
        label: "Avg vehicle trip length",
        value: avgTripLen.toFixed(1),
        unit: "mi",
        source: "CDOT 2019 SWTDM",
        overrideKey: "avg_trip_length",
        rawValue: avgTripLen,
      },
      {
        label: "Substitution ratio",
        value:
          type === "bikeshare"
            ? "19.6% (McQueen et al. 2020)"
            : type === "e-bikeshare"
            ? "35.0% (Fitch et al. 2021)"
            : "38.5% (McQueen et al. 2020)",
        source: "Share of micro trips replacing auto",
      },
    ];
  },

  transit_oriented_development: (tazs, values) => {
    const transit = aggregateModeShare(tazs, "transit");
    const ratio = Number(values["tod_mode_share_ratio"] ?? PROGRAM_EFFECTS.tod_mode_share_ratio);
    const cap = PROGRAM_EFFECTS.tod_max_transit_share;
    const projected = Math.min(transit.value * ratio, cap);
    return [
      {
        label: "Current area transit share",
        value: fmtPct1(transit.value),
        projected: `${fmtPct1(projected)} for TOD-area residents (${ratio.toFixed(1)}× multiplier, capped at ${Math.round(cap * 100)}%)`,
        source: modeShareSourceNote(transit),
        overrideKey: "transit_mode_share",
        rawValue: transit.value,
      },
      {
        label: "TOD multiplier",
        value: `${ratio.toFixed(1)}× area transit share`,
        source: "CAPCOA LUT-4 (Lund 2004 / Cervero 2007)",
      },
      {
        label: "Realistic ceiling",
        value: `${Math.round(cap * 100)}% transit share`,
        source: "High-quality rail-station TODs (max)",
        overrideKey: "max_tod_transit_share",
        rawValue: cap,
      },
    ];
  },

  vanpool: (tazs, _values, contextOverrides) => {
    const transit = aggregateModeShare(tazs, "transit");
    return [
      commuteVmtBaseRow(tazs, contextOverrides),
      {
        label: "Current transit share",
        value: fmtPct1(transit.value),
        source: modeShareSourceNote(transit),
        overrideKey: "transit_mode_share",
        rawValue: transit.value,
      },
      {
        label: "Statewide AVO",
        value: BEHAVIORAL_DEFAULTS.avo.toFixed(2),
        source: "NHTS 2017",
        overrideKey: "avo",
        rawValue: BEHAVIORAL_DEFAULTS.avo,
      },
    ];
  },

  tmo_coverage: (tazs, values, contextOverrides) => {
    const shareAfter = Number(values["share_after"] ?? 0);
    const shareBefore = Number(values["share_before"] ?? 0);
    const r = PROGRAM_EFFECTS.tmo_voluntary_ctr_per_eligible;
    return [
      commuteVmtBaseRow(tazs, contextOverrides),
      {
        label: "Coverage change",
        value: `${fmtPct1(shareBefore)} → ${fmtPct1(shareAfter)}`,
        source: "User-supplied",
      },
      {
        label: "Per-eligible reduction",
        value: fmtPct1(r),
        source: "CAPCOA TRT-1 (voluntary CTR midpoint)",
        overrideKey: "r_ctr",
        rawValue: r,
      },
    ];
  },

  commute_marketing: (tazs, values, contextOverrides) => {
    const eligible = Number(values["pct_eligible"] ?? 0);
    const r = Number(
      values["reduction_per_eligible"] ?? PROGRAM_EFFECTS.commute_marketing_per_eligible,
    );
    return [
      commuteVmtBaseRow(tazs, contextOverrides),
      // NOTE: "Per-eligible reduction" is NOT tagged — reduction_per_eligible is
      // the strategy's own Configure input, so a context override would create a
      // confusing dual edit path. Display-only.
      {
        label: "Per-eligible reduction",
        value: fmtPct1(r),
        projected: eligible > 0 ? `${fmtPct1(eligible * r)} of commute trips reduced` : undefined,
        source: "CAPCOA TRT-7 (marketing, low end)",
      },
    ];
  },

  commute_incentives: (tazs, values, contextOverrides) => {
    const eligible = Number(values["pct_eligible"] ?? 0);
    const r = Number(
      values["reduction_per_eligible"] ?? PROGRAM_EFFECTS.commute_incentive_per_eligible,
    );
    return [
      commuteVmtBaseRow(tazs, contextOverrides),
      // NOTE: "Per-eligible reduction" is NOT tagged — reduction_per_eligible is
      // the strategy's own Configure input (dual-path avoidance). Display-only.
      {
        label: "Per-eligible reduction",
        value: fmtPct1(r),
        projected: eligible > 0 ? `${fmtPct1(eligible * r)} of commute trips reduced` : undefined,
        source: "CAPCOA TRT-13 (incentive-heavy campaign)",
      },
    ];
  },

  employee_commuting_benefits: (tazs, values) => {
    const transit = aggregateModeShare(tazs, "transit");
    const auto = aggregateModeShare(tazs, "auto");
    const fare = BEHAVIORAL_DEFAULTS.avg_transit_fare;
    const subsidy = Number(values["subsidy_amount"] ?? 0);
    return [
      {
        label: "Current transit commute share",
        value: fmtPct1(transit.value),
        source: modeShareSourceNote(transit),
        overrideKey: "transit_mode_share",
        rawValue: transit.value,
      },
      {
        label: "Current auto commute share",
        value: fmtPct1(auto.value),
        source: "ACS B08301 (drove alone + carpool); area-type fallback for non-ACS TAZs",
        overrideKey: "auto_mode_share",
        rawValue: auto.value,
      },
      {
        label: "Avg transit fare assumed",
        value: `$${fare.toFixed(2)}`,
        projected:
          subsidy > 0 ? `${fmtPct1(Math.min(subsidy / fare, 1))} effective fare reduction` : undefined,
        source: "statewide default",
        overrideKey: "avg_fare",
        rawValue: fare,
      },
      {
        label: "Statewide AVO assumed",
        value: BEHAVIORAL_DEFAULTS.avo.toFixed(2),
        source: "NHTS 2017 statewide default",
        overrideKey: "avo",
        rawValue: BEHAVIORAL_DEFAULTS.avo,
      },
      {
        label: "Fare elasticity",
        value: `ε = ${ELASTICITIES.transit_fare}`,
        source: "Paulley et al. (2006) short-run",
      },
    ];
  },

  telework: (tazs, values, contextOverrides) => {
    const eligible = Number(values["pct_eligible"] ?? 0);
    const days = Number(values["telework_days_per_week"] ?? 0);
    return [
      commuteVmtBaseRow(tazs, contextOverrides),
      {
        label: "Days eliminated per eligible worker",
        value: `${days.toFixed(1)} of 5`,
        projected: `${fmtPct1(eligible * (days / 5))} of commute trips eliminated`,
        source: "User-supplied; ACS occupation mix informs eligible share",
      },
    ];
  },

  new_transit_service: (tazs) => {
    const transit = aggregateModeShare(tazs, "transit");
    const auto = aggregateModeShare(tazs, "auto");
    const tripRedRatio = PROGRAM_EFFECTS.transit_service_trip_reduction_ratio;
    return [
      {
        label: "Current transit commute share",
        value: fmtPct1(transit.value),
        source: modeShareSourceNote(transit),
        overrideKey: "transit_mode_share",
        rawValue: transit.value,
      },
      {
        label: "Current auto commute share",
        value: fmtPct1(auto.value),
        source: "ACS B08301 (drove alone + carpool); area-type fallback for non-ACS TAZs",
        overrideKey: "auto_mode_share",
        rawValue: auto.value,
      },
      {
        label: "Statewide AVO assumed",
        value: BEHAVIORAL_DEFAULTS.avo.toFixed(2),
        source: "NHTS 2017 statewide default",
        overrideKey: "avo",
        rawValue: BEHAVIORAL_DEFAULTS.avo,
      },
      {
        label: "Trip-reduction ratio",
        value: fmtPct1(tripRedRatio),
        source: "Share of new-transit trips that replace a vehicle trip",
        overrideKey: "trip_red_ratio",
        rawValue: tripRedRatio,
      },
      {
        label: "Elasticity",
        value: `ε = ${ELASTICITIES.transit_service_miles} (TCRP 95)`,
      },
    ];
  },

  transit_pass_subsidy: (tazs) => {
    const transit = aggregateModeShare(tazs, "transit");
    const auto = aggregateModeShare(tazs, "auto");
    return [
      {
        label: "Current transit commute share",
        value: fmtPct1(transit.value),
        source: modeShareSourceNote(transit),
        overrideKey: "transit_mode_share",
        rawValue: transit.value,
      },
      {
        label: "Current auto commute share",
        value: fmtPct1(auto.value),
        source: "ACS B08301 (drove alone + carpool); area-type fallback for non-ACS TAZs",
        overrideKey: "auto_mode_share",
        rawValue: auto.value,
      },
      {
        label: "Statewide AVO assumed",
        value: BEHAVIORAL_DEFAULTS.avo.toFixed(2),
        source: "NHTS 2017 statewide default",
        overrideKey: "avo",
        rawValue: BEHAVIORAL_DEFAULTS.avo,
      },
      {
        label: "Fare elasticity",
        value: `ε = ${ELASTICITIES.transit_fare}`,
        source: "Paulley et al. (2006) short-run",
      },
    ];
  },

  workplace_parking_pricing: (tazs, values) => parkingRows(tazs, values, "commute"),
  parking_fees_curb_management: (tazs, values) => parkingRows(tazs, values, "all"),
  dynamic_parking_pricing: (tazs, values) => parkingRows(tazs, values, "all"),

  lane_mile_addition: (tazs, values) => {
    const fc = String(values["facility_class"] ?? "major_arterial");
    const key = `lane_mi_${fc}` as keyof TazInputs;
    const existing = totalOf(tazs, key);
    const newLm = Number(values["new_lane_miles"] ?? 0);
    const elKey = FACILITY_TO_INDUCED_ELASTICITY[fc];
    const el = elKey ? ELASTICITIES[elKey] : 0;
    const pct = existing > 0 ? (newLm / existing) * el : 0;
    // Lane miles are bidirectional: positive = added capacity (induces VMT),
    // negative = a road diet (reduces VMT). Sign the context rows accordingly
    // (CMT-08) so a negative input doesn't render as "+-".
    const isDiet = newLm < 0;
    const capPct = existing > 0 ? (newLm / existing) * 100 : 0;
    const vmtPct = pct * 100;
    return [
      {
        label: `Existing ${fc.replace("_", " ")} lane-miles`,
        value: existing > 0 ? fmt1(existing) : "N/A",
        unit: "lane-mi",
        unavailable: existing <= 0,
        source: "CDOT 2019 SWTDM loaded network",
      },
      {
        label: isDiet ? "Proposed removal (road diet)" : "Proposed addition",
        value: newLm.toFixed(1),
        unit: "lane-mi",
        projected:
          existing > 0
            ? `${capPct >= 0 ? "+" : "−"}${Math.abs(capPct).toFixed(1)}% capacity change`
            : "no existing capacity in class",
      },
      {
        label: "Induced-demand elasticity",
        value: el.toFixed(2),
        source: "Duranton & Turner (2011) long-run",
      },
      {
        label: isDiet ? "Projected VMT change" : "Projected induced VMT",
        value:
          existing > 0
            ? `${vmtPct >= 0 ? "+" : "−"}${Math.abs(vmtPct).toFixed(2)}%`
            : "N/A",
        source: "Δ lane-miles × ε",
      },
    ];
  },
};

export function getStrategyContext(
  key: StrategyKey,
  tazInputs: TazInputs[],
  values: Record<string, number | string>,
  contextOverrides?: Record<string, number>,
): ContextRow[] {
  const fn = builders[key];
  if (!fn || tazInputs.length === 0) return [];
  // Thread the overrides into the builder so override-aware rows (e.g. the
  // "Commute VMT base" miles row) can fold the override into their own derived
  // value rather than relying on the generic reformat below.
  const rows = fn(tazInputs, values, contextOverrides);
  if (!contextOverrides) return rows;
  // Where the user has overridden a data-derived baseline, show the OVERRIDDEN
  // value (reformatted just like the original) and flag the row so the UI can
  // paint a "modified" indicator. rawValue is left unchanged so a UI can still
  // seed/reset the override input from the original baseline.
  return rows.map((row) => {
    if (row.overrideKey === undefined) return row;
    const ov = contextOverrides[row.overrideKey];
    if (typeof ov !== "number" || !Number.isFinite(ov)) return row;
    // Rows the builder already computed in an override-aware way keep their
    // derived `value` (e.g. miles/day) — only mark them overridden. All other
    // overridable rows display the overridden value directly via the formatter.
    if (row.computedValue) {
      return { ...row, overridden: true };
    }
    const format = OVERRIDE_FORMATTERS[row.overrideKey];
    return {
      ...row,
      value: format ? format(ov) : String(ov),
      overridden: true,
    };
  });
}
