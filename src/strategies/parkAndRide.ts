// Park-and-Ride (DERIVED; Duncan & Cao 2020): a COMPLEX, cross-TAZ strategy.
//
// Unlike the per-TAZ calc functions in strategies.ts and the closed-form YAML
// `compute:` strategies, P&R's denominator is the commute VMT summed over the
// whole catchment, and its observed inputs are VMT-weighted means across that
// catchment. So it cannot be a per-TAZ function or a YAML formula; it is a
// hand-written port of scripts/strategy_calculations.py::strategy_park_and_ride,
// pinned to the Python output by parkAndRide.test.ts (the "complex path":
// translate Python -> TS, verify identical via a golden test).
//
// App scenario: the calculator has no TAZ geometry or explicit catchment list at
// runtime, so the user's selected TAZs ARE the catchment (the Python priority-3
// fallback). Observed commute trip length is taken from avg_trip_length where
// present; with no drive-access / transit-trip data the credit is supply-side
// only (also a Python-supported path). These approximations are documented in
// park_and_ride.yaml notes.

import { PARK_AND_RIDE_DERIVED as K } from "./constants";
import type { StrategyResult, TazInputs } from "./types";
import { baseVmt, buildResult, fmtInt } from "./util";

export interface ParkAndRideArgs {
  n_spaces: number;
  l_access_mi: number;
  utilization?: number;
  /** Python bool or the catalog select string ("isolated" / "alternative"). */
  isolated_facility?: boolean | string;
  l_commute_catchment_mi?: number | null;
  /**
   * ALL-PURPOSE daily transit trips originating in the catchment. Renamed
   * 2026-07-27 from `total_transit_commute_trips_catchment` (agencies rarely
   * publish a commute-only figure); scoped back to commute travel by
   * `commute_share_of_drive_access` below.
   */
  total_transit_trips_catchment?: number | null;
  drive_access_share?: number | null;
  /** Commute share of the drive-access subset; defaults to the derived constant. */
  commute_share_of_drive_access?: number | null;
}

/** Compute Park-and-Ride across the catchment; one StrategyResult per TAZ. */
export function parkAndRide(catchment: TazInputs[], args: ParkAndRideArgs): StrategyResult[] {
  const util = args.utilization ?? K.utilization_default;
  const isIsolated =
    typeof args.isolated_facility === "boolean"
      ? args.isolated_facility
      : ["isolated", "true", "1", "yes"].includes(
          String(args.isolated_facility ?? "isolated").trim().toLowerCase(),
        );
  const D = isIsolated ? K.diversion_isolated : K.diversion_alt;

  // Catchment = the whole selected set. Commute VMT is the denominator + weights.
  const commuteVmt = catchment.map((t) => baseVmt(t, "commute"));
  const catchTotal = commuteVmt.reduce((a, b) => a + b, 0);

  // L_commute: commute-VMT-weighted trip length over the catchment. Prefer the
  // observed TDM model trip length where any catchment TAZ has it, else fall
  // back to avg_trip_length (mirrors Python).
  let lCommute = args.l_commute_catchment_mi ?? null;
  if (lCommute == null) {
    const hasTdm = catchment.some(
      (t) => typeof t.tdm_avg_trip_length_mi === "number" && Number.isFinite(t.tdm_avg_trip_length_mi),
    );
    let num = 0;
    let den = 0;
    catchment.forEach((t, i) => {
      const raw = hasTdm ? t.tdm_avg_trip_length_mi : t.avg_trip_length;
      const len = typeof raw === "number" ? raw : NaN;
      const w = commuteVmt[i];
      if (Number.isFinite(len) && w > 0) {
        num += len * w;
        den += w;
      }
    });
    lCommute = den > 0 ? num / den : null;
  }

  // V_net: local trip lengths if available, else Duncan & Cao fallback (which
  // already embeds the diversion behaviour, so D is NOT also applied).
  let vNet: number;
  let applyD: boolean;
  if (lCommute != null) {
    vNet = Math.max(2 * (lCommute - args.l_access_mi), 0);
    applyD = true;
  } else {
    vNet = isIsolated ? K.vnet_fallback_isolated : K.vnet_fallback_alt;
    applyD = false;
  }
  const dFactor = applyD ? D : 1;

  const divertedSupply = args.n_spaces * util * dFactor;

  // Drive-to-transit access share: the passed value, else the observed per-TAZ
  // drive_to_transit_share, commute-VMT-weighted over the catchment.
  let das = args.drive_access_share ?? null;
  if (das == null) {
    let num = 0;
    let den = 0;
    catchment.forEach((t, i) => {
      const raw = t.drive_to_transit_share;
      const w = commuteVmt[i];
      if (typeof raw === "number" && Number.isFinite(raw) && w > 0) {
        num += raw * w;
        den += w;
      }
    });
    das = den > 0 ? num / den : null;
  }

  // Demand ceiling only when the user supplies a real catchment transit-trip
  // count (>0) AND a drive-access share is available; otherwise supply-side
  // only. A default/blank count of 0 is treated as "no demand data" (not a 0
  // ceiling), an intentional divergence from the Python `is not None` check,
  // which the app never relies on.
  //
  // The count is ALL-PURPOSE, so it is scoped to commute travel (this method's
  // pool) by the commute share of the drive-access subset. Without that factor a
  // total-trip count would inflate the ceiling and quietly make the method
  // supply-side-only for most catchments.
  const totalTransit = args.total_transit_trips_catchment ?? 0;
  const commuteShare =
    args.commute_share_of_drive_access ?? K.commute_share_of_drive_access;
  let diverted: number;
  if (totalTransit > 0 && das != null) {
    diverted = Math.min(
      divertedSupply,
      totalTransit * das * commuteShare * dFactor,
    );
  } else {
    diverted = divertedSupply;
  }

  const dailySaved = diverted * vNet;
  const pctRed = catchTotal > 0 ? dailySaved / catchTotal : 0;

  const inputs =
    `N_spaces=${fmtInt(args.n_spaces)}, U=${(util * 100).toFixed(0)}%, ` +
    `L_access=${args.l_access_mi}mi, isolated=${isIsolated} (D=${D}), ` +
    `V_net=${vNet.toFixed(1)}mi/rt, catchment_commute_VMT=${fmtInt(catchTotal)}`;

  // Uniform percent on every catchment TAZ, against its own commute VMT. No
  // subsector cap (standalone measure).
  return catchment.map((t) =>
    buildResult({ taz: t, strategy: "Park and Ride", inputs, pct: -pctRed, basis: "commute" }),
  );
}

/** Strategies whose math needs the whole catchment, not one TAZ at a time. */
export const AGGREGATE_REGISTRY: Record<
  string,
  (catchment: TazInputs[], args: ParkAndRideArgs) => StrategyResult[]
> = {
  park_and_ride: parkAndRide,
};
