import {
  BEHAVIORAL_DEFAULTS,
  MODE_SHARE_BY_AREA_TYPE,
  VMT_PURPOSE_SHARE,
  type AreaType,
  type TripPurpose,
} from "./constants";
import type { TazInputs, StrategyResult } from "./types";

export function baseVmt(
  taz: TazInputs,
  purpose: TripPurpose = "all",
  contextOverrides?: Record<string, number>,
): number {
  const v = Number.isFinite(taz.daily_vmt) ? taz.daily_vmt : 0;
  if (purpose === "all") return v;
  // Prefer the observed per-TAZ VMT-purpose split (TDM model, published on the
  // enriched layer) where present; fall back to the statewide constant. Mirrors
  // Python _base_vmt. A project-context override of `vmt_share_<purpose>` (e.g.
  // vmt_share_commute) wins uniformly over both, so overriding the commute
  // purpose share re-scales the commute VMT base fed to every commute strategy.
  const share = overrideNum(
    contextOverrides,
    `vmt_share_${purpose}`,
    (() => {
      const observed = (taz as Record<string, unknown>)[`vmt_share_${purpose}`];
      return typeof observed === "number" && Number.isFinite(observed)
        ? observed
        : VMT_PURPOSE_SHARE[purpose];
    })(),
  );
  return v * share;
}

/**
 * Format a numeric value as a signed percentage (e.g. -0.25 -> "-25%").
 * Mirrors Python's f"{x:+.0%}".
 */
export function fmtPct(x: number, places = 0): string {
  if (!Number.isFinite(x)) return "0%";
  const sign = x >= 0 ? "+" : "-";
  return `${sign}${(Math.abs(x) * 100).toFixed(places)}%`;
}

export function fmtPctUnsigned(x: number, places = 0): string {
  if (!Number.isFinite(x)) return "0%";
  return `${(x * 100).toFixed(places)}%`;
}

/** Lower-clamp a number (returns Math.max(x, lower)). */
export function clipLower(x: number, lower: number): number {
  return x < lower ? lower : x;
}

/** Join non-empty assumption flags with "; ". Mirrors Python _join_assumptions. */
export function joinAssumptions(...parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => Boolean(p)).join("; ");
}

/** Build the canonical StrategyResult from per-strategy ingredients. */
export function buildResult(args: {
  taz: TazInputs;
  strategy: string;
  inputs: string;
  pct: number;
  basis: TripPurpose;
  assumptions?: string;
  /**
   * Project-context overrides forwarded to baseVmt so a `vmt_share_<purpose>`
   * override (e.g. vmt_share_commute) re-scales the purpose-scoped base VMT.
   * Absent -> byte-for-byte the pre-override base VMT.
   */
  contextOverrides?: Record<string, number>;
}): StrategyResult {
  const base = baseVmt(args.taz, args.basis, args.contextOverrides);
  const pct = Number.isFinite(args.pct) ? args.pct : 0;
  return {
    taz_id: args.taz.taz_id,
    strategy: args.strategy,
    inputs: args.inputs,
    base_vmt_purpose: args.basis,
    base_vmt: base,
    pct_vmt_reduction: pct,
    daily_vmt_reduction: -base * pct,
    data_assumptions: args.assumptions ?? "",
  };
}

/**
 * Per-TAZ mode share, mirroring the Python `add_imputed_mode_shares` helper
 * with `source="auto"`. ACS B08301 values are used when present; the
 * area-type defaults from MODE_SHARE_BY_AREA_TYPE fill in when the row's
 * ACS data is suppressed (small / low-population block groups).
 *
 * The function always returns a value, so callers never have to handle a
 * null. The returned `source` field disambiguates so strategy results can
 * flag whether area-type imputation was used.
 */
export interface ImputedModeShare {
  transit: number;
  auto: number;
  bike: number;
  walk: number;
  source: "acs_b08301_commute" | "imputed_from_area_type";
}

export function imputedModeShare(taz: TazInputs): ImputedModeShare {
  const total = taz.acs_total_workers;
  if (typeof total === "number" && total > 0 && taz.acs_transit_share != null) {
    return {
      transit: taz.acs_transit_share,
      auto: (taz.acs_drove_alone_share ?? 0) + (taz.acs_carpool_share ?? 0),
      bike: taz.acs_bike_share ?? 0,
      walk: taz.acs_walk_share ?? 0,
      source: "acs_b08301_commute",
    };
  }
  const at = (taz.area_type as AreaType) ?? "rural";
  const row = MODE_SHARE_BY_AREA_TYPE[at] ?? MODE_SHARE_BY_AREA_TYPE.rural;
  return {
    transit: row.transit,
    auto: row.auto,
    bike: row.bike,
    walk: row.walk,
    source: "imputed_from_area_type",
  };
}

/**
 * Per-TAZ parking baselines, mirroring Python's `add_imputed_parking`: the
 * current daily parking price and the share of employees who pay for parking
 * are keyed on `area_type`. Unknown area types fall back to $0 / 5% (matching
 * the Python `.fillna(0.0)` / `.fillna(0.05)`).
 */
export interface ImputedParking {
  price: number;
  sharePaying: number;
}

export function imputedParking(taz: TazInputs): ImputedParking {
  const at = (taz.area_type as AreaType) ?? "rural";
  const priceMap: Record<AreaType, number> = {
    urban_core: BEHAVIORAL_DEFAULTS.current_parking_price_urban_core,
    urban:      BEHAVIORAL_DEFAULTS.current_parking_price_urban,
    suburban:   BEHAVIORAL_DEFAULTS.current_parking_price_suburban,
    rural:      BEHAVIORAL_DEFAULTS.current_parking_price_rural,
  };
  const shareMap: Record<AreaType, number> = {
    urban_core: BEHAVIORAL_DEFAULTS.share_emp_paying_parking_urban_core,
    urban:      BEHAVIORAL_DEFAULTS.share_emp_paying_parking_urban,
    suburban:   BEHAVIORAL_DEFAULTS.share_emp_paying_parking_suburban,
    rural:      BEHAVIORAL_DEFAULTS.share_emp_paying_parking_rural,
  };
  return {
    price: priceMap[at] ?? 0.0,
    sharePaying: shareMap[at] ?? 0.05,
  };
}

/** AVO defaults to statewide BEHAVIORAL_DEFAULTS unless overridden per-TAZ. */
export function getAvo(taz: TazInputs, override?: number): number {
  if (typeof override === "number" && Number.isFinite(override)) return override;
  const fromTaz = (taz as Record<string, unknown>)["avo"];
  if (typeof fromTaz === "number" && Number.isFinite(fromTaz)) return fromTaz;
  return BEHAVIORAL_DEFAULTS.avo;
}

/**
 * Resolve a value that a hand-written (non-DSL) strategy reads, honoring a
 * project-context override the same way `dslRow` does: if the override map
 * carries a FINITE number for `key`, it wins uniformly over the derived value;
 * otherwise the derived value is used unchanged. With no map (or a non-finite
 * entry) this is byte-for-byte the pre-override behavior. Keep the finite check
 * identical to dslRow so the DSL and non-DSL paths override identically.
 */
export function overrideNum(
  contextOverrides: Record<string, number> | undefined,
  key: string,
  derived: number,
): number {
  const v = contextOverrides?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : derived;
}

/** Number with thousands separators (en-US). */
export function fmtInt(x: number): string {
  if (!Number.isFinite(x)) return "0";
  return Math.round(x).toLocaleString("en-US");
}
