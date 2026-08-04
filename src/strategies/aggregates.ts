// Strategies whose math needs the whole selection, not one TAZ at a time, plus
// the registry that computeStrategyRows dispatches to for them.
//
// Two members today:
//   park_and_ride       -> parkAndRide.ts (denominator is catchment commute VMT)
//   lane_mile_addition  -> below (denominator is the selection's lane-mile stock)

import { ELASTICITIES, FACILITY_TO_INDUCED_ELASTICITY } from "./constants";
import { parkAndRide, type ParkAndRideArgs } from "./parkAndRide";
import type { StrategyResult, TazInputs } from "./types";
import { buildResult } from "./util";

// ---------------------------------------------------------------------------
// Lane-Mile Addition (induced demand): `facility_class` select + lane_mi_<class>
// ---------------------------------------------------------------------------

export type FacilityClass = keyof typeof FACILITY_TO_INDUCED_ELASTICITY;

export interface LaneMileAdditionArgs {
  new_lane_miles: number;
  facility_class?: FacilityClass;
  elasticity?: number;
}

/**
 * Compute induced demand across the selection; one StrategyResult per TAZ.
 *
 * `ΔVMT% = (new_lane_miles / existing_lane_miles_in_class) × ε`, where BOTH
 * terms are project-area totals: the user enters the whole project's net change
 * in through-lane miles, and the denominator is that lane-mile stock summed over
 * every selected TAZ. The resulting percentage is uniform across the selection.
 *
 * This is deliberately an aggregate rather than a per-TAZ calc. Duranton & Turner
 * is an *area-level* elasticity relating a region's VMT to that region's lane
 * miles, so the aggregate reading is the faithful one. Evaluating it per TAZ —
 * as this did until 2026-08-04 — divided the project total by each individual
 * zone's much smaller stock, so the same project reported a larger effect the
 * more zones you selected. Five downtown Steamboat zones hold 1.61 major-arterial
 * lane-miles between them (0.70/0.52/0.31/0.08/0.00 individually), and a −0.5
 * lane-mile road diet there read −107.8% VMT instead of −18.6%.
 *
 * Note that distributing the entered total across zones by lane-mile share is
 * algebraically identical to this: zone i would take Δlm·(lm_i/ΣLM), giving
 * pct_i = (Δlm/ΣLM)·ε for every i. Same number, less machinery.
 *
 * Removal is clamped at the existing stock — you cannot take out more lanes than
 * are there — which bounds the reduction at exactly ε (60% arterial, 40%
 * collector, 100% freeway). Additions are unbounded, as induced demand has no
 * ceiling in this method.
 */
export function laneMileAddition(
  selection: TazInputs[],
  args: LaneMileAdditionArgs,
): StrategyResult[] {
  const fc = args.facility_class ?? "major_arterial";
  const elKey = FACILITY_TO_INDUCED_ELASTICITY[fc];
  if (!elKey) {
    throw new Error(`Unknown facility_class ${fc}`);
  }
  const elasticity = args.elasticity ?? ELASTICITIES[elKey];
  const col = `lane_mi_${fc}` as keyof TazInputs;

  // Existing stock in this class over the WHOLE selection.
  const existing = selection.reduce((acc, t) => {
    const v = t[col] as number | null | undefined;
    return acc + (typeof v === "number" && Number.isFinite(v) ? v : 0);
  }, 0);

  // Coerce defensively: an empty/cleared number input can reach here as "" or
  // undefined; treat a non-finite value as 0 rather than throwing on .toFixed.
  const requested = Number(args.new_lane_miles);
  const requestedSafe = Number.isFinite(requested) ? requested : 0;

  if (!(existing > 0)) {
    // Python returns 0 with a flag; mirror that.
    const inputs =
      `new_lane_mi=${requestedSafe.toFixed(2)}, class=${fc}, ε=${elasticity}, ` +
      `existing_lane_mi=0.00`;
    return selection.map((taz) =>
      buildResult({
        taz,
        strategy: "Lane-Mile Addition",
        inputs,
        pct: 0,
        basis: "all",
        assumptions: "no_existing_lane_miles_in_class",
      }),
    );
  }

  // Cannot remove more capacity than exists in the class.
  const applied = Math.max(requestedSafe, -existing);
  const clamped = applied !== requestedSafe;
  const pct = (applied / existing) * elasticity;

  const inputs =
    `new_lane_mi=${applied.toFixed(2)}, class=${fc}, ε=${elasticity}, ` +
    `existing_lane_mi=${existing.toFixed(2)}`;

  return selection.map((taz) =>
    buildResult({
      taz,
      strategy: "Lane-Mile Addition",
      inputs,
      pct,
      basis: "all",
      assumptions: clamped ? "lane_miles_removed_clamped_to_existing" : "",
    }),
  );
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * A cross-TAZ strategy: takes the whole selection and returns one result per
 * TAZ, in the same order. Args are the raw catalog input values, so each fn
 * narrows to its own shape.
 */
export type AggregateFn = (
  selection: TazInputs[],
  args: Record<string, unknown>,
) => StrategyResult[];

export const AGGREGATE_REGISTRY: Record<string, AggregateFn> = {
  park_and_ride: parkAndRide as unknown as AggregateFn,
  lane_mile_addition: laneMileAddition as unknown as AggregateFn,
};

export type { ParkAndRideArgs };
