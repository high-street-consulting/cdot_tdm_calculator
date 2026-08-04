// Per-TAZ calc functions for the COMPLEX strategies: the ones whose math can't
// be expressed as a YAML `compute:` block (multi-value selects that switch the
// formula, select->constant lookups, or a dynamic TAZ column). Everything
// closed-form now lives in the catalog YAML and runs through computeDsl.ts; see
// compute.ts for the dispatch. The cross-TAZ strategies (Park-and-Ride, and
// Lane-Mile Addition since 2026-08-04) live in parkAndRide.ts / aggregates.ts.
//
// Each function mirrors methods/strategy_calculations.py and is pinned to the
// Python engine by the golden-value tests in strategies.test.ts.
//
// Kept here:
//   transit_service_expansion  : `basis` select (frequency | service_miles)
//   shared_micromobility       : `micromobility_type` select -> substitution ratio

import {
  BEHAVIORAL_DEFAULTS,
  ELASTICITIES,
  MICRO_SUBSTITUTION_BY_TYPE,
  PROGRAM_EFFECTS,
} from "./constants";
import type { TazInputs, StrategyResult } from "./types";
import {
  buildResult,
  clipLower,
  fmtInt,
  fmtPct,
  fmtPctUnsigned,
  getAvo,
  imputedModeShare,
  joinAssumptions,
  overrideNum,
} from "./util";

// ---------------------------------------------------------------------------
// Transit Service Expansion (Methods rows 1, 2, 3): `basis` select
// ---------------------------------------------------------------------------

export type TransitBasis = "frequency" | "service_miles";

export interface TransitServiceExpansionArgs {
  pct_change: number;
  basis?: TransitBasis;
  level_of_implementation?: number;
  elasticity?: number;
  trip_reduction_ratio?: number;
  avo?: number;
}

export function transitServiceExpansion(
  taz: TazInputs,
  args: TransitServiceExpansionArgs,
  contextOverrides?: Record<string, number>,
): StrategyResult {
  const basis = args.basis ?? "frequency";
  const L = args.level_of_implementation ?? 1.0;
  const elasticity =
    args.elasticity ??
    (basis === "frequency"
      ? ELASTICITIES.transit_frequency
      : ELASTICITIES.transit_service_miles);
  const tripRedRatio =
    args.trip_reduction_ratio ?? PROGRAM_EFFECTS.transit_service_trip_reduction_ratio;
  const inputs =
    `basis=${basis}, Δ=${fmtPct(args.pct_change)}, L=${fmtPctUnsigned(L)}, ` +
    `ε=${elasticity}` +
    (basis === "service_miles" ? `, trip_red_ratio=${tripRedRatio}` : "");

  // Project-context overrides win over the imputed/data-derived baselines,
  // applied UNIFORMLY across every selected TAZ (same semantics as dslRow in
  // compute.ts). Only finite overrides for the keys this formula reads
  // (transit_mode_share / auto_mode_share / avo) are honored.
  const ms = imputedModeShare(taz);
  const transitShare = overrideNum(contextOverrides, "transit_mode_share", ms.transit);
  const autoShare = overrideNum(contextOverrides, "auto_mode_share", ms.auto);
  const avo = overrideNum(contextOverrides, "avo", getAvo(taz, args.avo));
  let pct: number;
  if (basis === "frequency") {
    pct =
      (-L * (args.pct_change * transitShare * elasticity * (1 / avo))) /
      clipLower(autoShare, 1e-9);
  } else {
    pct =
      -L *
      args.pct_change *
      transitShare *
      elasticity *
      (1 / avo) *
      tripRedRatio;
  }
  return buildResult({
    taz,
    strategy: "Transit Service Expansion",
    inputs,
    pct,
    basis: "all",
    assumptions: joinAssumptions(
      "mode_share=imputed_from_area_type",
      "avo=statewide_default",
    ),
  });
}

// ---------------------------------------------------------------------------
// Shared Micromobility (Methods row 6): `micromobility_type` select
// ---------------------------------------------------------------------------

export type MicromobilityType = keyof typeof MICRO_SUBSTITUTION_BY_TYPE;

export interface SharedMicromobilityArgs {
  pct_pop_access_before: number;
  pct_pop_access_after: number;
  micromobility_type?: MicromobilityType;
  daily_micro_trips_per_person?: number;
  substitution_ratio?: number;
  avg_micro_trip_length?: number;
  /**
   * Fleet composition. Blends the per-device substitution ratios by share so a
   * mixed fleet (scooters plus permit-required e-bikes, say) is representable.
   * Normalized, so the three need not total 100%. All zero or absent falls back to
   * the single-device `micromobility_type` ratio.
   */
  pct_fleet_pedal?: number;
  pct_fleet_ebike?: number;
  pct_fleet_scooter?: number;
}

export function sharedMicromobility(
  taz: TazInputs,
  args: SharedMicromobilityArgs,
  contextOverrides?: Record<string, number>,
): StrategyResult {
  const type = args.micromobility_type ?? "bikeshare";
  const cfg = MICRO_SUBSTITUTION_BY_TYPE[type];
  if (!cfg) {
    throw new Error(`Unknown micromobility_type ${type}`);
  }
  const dailyMicro = args.daily_micro_trips_per_person ?? BEHAVIORAL_DEFAULTS.daily_micro_trips_per_person;
  const microLen = args.avg_micro_trip_length ?? BEHAVIORAL_DEFAULTS.avg_micro_trip_length_mi;
  // Fleet mix -> share-weighted substitution ratio. Keys mirror
  // MICRO_SUBSTITUTION_BY_TYPE so the per-device ratios stay single-sourced.
  const fleet: [MicromobilityType, number][] = [
    ["bikeshare", Math.max(args.pct_fleet_pedal ?? 0, 0)],
    ["e-bikeshare", Math.max(args.pct_fleet_ebike ?? 0, 0)],
    ["scootershare", Math.max(args.pct_fleet_scooter ?? 0, 0)],
  ];
  const fleetTotal = fleet.reduce((a, [, share]) => a + share, 0);

  let subRatio: number;
  let subAssumption: string;
  if (args.substitution_ratio != null) {
    subRatio = args.substitution_ratio;
    subAssumption = `substitution_ratio=${fmtPctUnsigned(subRatio)}_user_specified`;
  } else if (fleetTotal > 0) {
    subRatio =
      fleet.reduce(
        (a, [k, share]) => a + share * MICRO_SUBSTITUTION_BY_TYPE[k].ratio,
        0,
      ) / fleetTotal;
    const mixDesc = fleet
      .filter(([, share]) => share > 0)
      .map(([k, share]) => `${k}:${fmtPctUnsigned(share / fleetTotal)}`)
      .join("+");
    subAssumption = `substitution_ratio=${fmtPctUnsigned(subRatio, 1)}_blended_from_fleet_mix(${mixDesc})`;
  } else {
    subRatio = cfg.ratio;
    const src = cfg.source.replace(/ /g, "_");
    subAssumption = `substitution_ratio=${type}=${fmtPctUnsigned(subRatio)}_per_${src}`;
  }

  const persons = clipLower((taz.population ?? 0) + (taz.employment ?? 0), 1.0);
  const dailyVehTripsPerPerson = (taz.daily_trips ?? 0) / persons;
  // avg_trip_length is a project-context row var (see context.ts): honor a
  // uniform override the same way dslRow does, else fall back to the per-TAZ
  // value, else the statewide behavioral default.
  const vehLen = overrideNum(
    contextOverrides,
    "avg_trip_length",
    taz.avg_trip_length ?? BEHAVIORAL_DEFAULTS.avg_vehicle_trip_length_mi,
  );
  const ddAccess = args.pct_pop_access_after - args.pct_pop_access_before;
  const pct =
    (-1 * (ddAccess * dailyMicro * subRatio * microLen)) /
    (clipLower(dailyVehTripsPerPerson, 1e-3) * clipLower(vehLen, 0.5));

  const inputs =
    `type=${type}, access ${fmtPctUnsigned(args.pct_pop_access_before)}→${fmtPctUnsigned(args.pct_pop_access_after)}, ` +
    `micro_trips/pp=${dailyMicro}, sub=${(subRatio * 100).toFixed(1)}%, ` +
    `micro_len=${microLen.toFixed(1)}mi`;
  return buildResult({
    taz,
    strategy: "Shared Micromobility",
    inputs,
    pct,
    basis: "all",
    assumptions: joinAssumptions(
      "daily_micro_trips_per_person=NACTO_default",
      subAssumption,
      "avg_micro_trip_length=NACTO_default",
    ),
  });
}

// Lane-Mile Addition (induced demand) used to live here as a per-TAZ calc fn.
// Its denominator is the whole selection's lane-mile stock, not one zone's, so
// it is now an aggregate: see `aggregates.ts`.

// ---------------------------------------------------------------------------
// Registry: string id -> calc fn, for the complex (code-backed) strategies.
// Closed-form strategies are NOT here; they dispatch to computeDsl via their
// catalog `compute:` block (see compute.ts). Cross-TAZ strategies are NOT here
// either; they dispatch via AGGREGATE_REGISTRY (see aggregates.ts).
// ---------------------------------------------------------------------------

export const STRATEGY_REGISTRY = {
  transit_service_expansion:       transitServiceExpansion,
  shared_micromobility:            sharedMicromobility,
} as const;

// A catalog strategy id. Closed-form strategies are driven by their YAML
// `compute:` block and intentionally are NOT keys of STRATEGY_REGISTRY, so this
// is the broad id type used app-wide (basket, defaults, UI). The registry is a
// subset; look up with a guard (see compute.ts).
export type StrategyKey = string;

/** Keys that have a code-backed calc fn in STRATEGY_REGISTRY. */
export type CalcFnKey = keyof typeof STRATEGY_REGISTRY;

// re-export commonly-needed helpers so callers don't reach into util.ts
export { fmtInt };
