// TAZ-aware default values for strategy inputs.
//
// `registry.ts` carries static defaults (e.g. "20% density increase") that
// reflect a reasonable starting point regardless of which TAZs the user picks.
// This module layers TAZ-derived defaults on top, for example the
// "Annual ridable days" input for the bike-lane strategy should start at the
// NOAA-interpolated bikeable-days value for the selected zones, not blank.
//
// Callers (App.tsx → openDetail) merge:
//   { ...meta.defaults, ...computeDataAwareDefaults(key, tazInputs) }
// when the strategy isn't already in the basket. If it IS in the basket,
// the user's saved values win: never overwrite their choices.

import { BEHAVIORAL_DEFAULTS } from "./constants";
import { getStrategy } from "./registry";
import type { StrategyKey } from "./strategies";
import type { TazInputs } from "./types";

const finite = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x);

/** Area-weighted mean of a per-TAZ value (NaN/null entries excluded). */
function weightedMean(
  tazs: TazInputs[],
  valueKey: keyof TazInputs,
  weightKey: keyof TazInputs,
): number | null {
  let num = 0;
  let den = 0;
  for (const t of tazs) {
    const v = t[valueKey];
    const w = t[weightKey];
    if (!finite(v) || !finite(w) || w <= 0) continue;
    num += v * w;
    den += w;
  }
  return den > 0 ? num / den : null;
}

/** Simple mean over non-null TAZ values. */
function mean(tazs: TazInputs[], key: keyof TazInputs): number | null {
  let n = 0;
  let s = 0;
  for (const t of tazs) {
    const v = t[key];
    if (finite(v)) {
      s += v;
      n += 1;
    }
  }
  return n > 0 ? s / n : null;
}

type Builder = (tazs: TazInputs[]) => Record<string, number | string>;

const builders: Partial<Record<StrategyKey, Builder>> = {
  // Annual ridable days from the TAZ's NOAA-interpolated value, area-
  // weighted across the selection, then the statewide default. Rounded to whole
  // days for the UI input.
  separated_bike_lanes: (tazs) => {
    if (tazs.length === 0) return {};
    const days =
      weightedMean(tazs, "annual_bikeable_days_taz", "area_sqmi") ??
      mean(tazs, "annual_bikeable_days_taz") ??
      BEHAVIORAL_DEFAULTS.annual_bikeable_days;
    const out: Record<string, number | string> = {};
    if (Number.isFinite(days)) out.annual_use_days = Math.round(days);
    return out;
  },
};

/**
 * Return TAZ-derived defaults for a strategy. Empty object if the strategy
 * doesn't have any data-aware defaults (or no TAZs are selected).
 */
export function computeDataAwareDefaults(
  key: StrategyKey,
  tazInputs: TazInputs[],
): Record<string, number | string> {
  const fn = builders[key];
  if (!fn || tazInputs.length === 0) return {};
  return fn(tazInputs);
}

/**
 * The authoritative "system default" seed for a strategy in the context of the
 * selected project area: the static catalog defaults overlaid with any
 * TAZ-derived defaults (e.g. NOAA bikeable days). This is the single source of
 * truth used both to seed a fresh working-values draft AND as the baseline that
 * the UI/exports compare against to flag which inputs the user has modified
 * (requirement UI-06; provenance snapshot stored on each BasketEntry).
 *
 * Computed in exactly one place so the "modified vs. default" comparison can
 * never drift from how the draft was seeded.
 */
export function seedDefaults(
  key: StrategyKey,
  tazInputs: TazInputs[],
): Record<string, number | string> {
  return {
    ...getStrategy(key).defaults,
    ...computeDataAwareDefaults(key, tazInputs),
  };
}

/**
 * Tolerant "is this value still the seeded default?" comparison for a single
 * input. Numbers are compared with a small epsilon (slider math can introduce
 * tiny float drift, e.g. value × scale ÷ scale); strings/selects compare
 * exactly. A missing seed entry counts as "not modified" so newly-added inputs
 * don't spuriously flag.
 */
export function isDefaultValue(
  current: number | string | undefined,
  seeded: number | string | undefined,
): boolean {
  if (seeded === undefined) return true;
  if (current === undefined) return true;
  if (typeof current === "number" && typeof seeded === "number") {
    return Math.abs(current - seeded) <= 1e-9 + Math.abs(seeded) * 1e-9;
  }
  return String(current) === String(seeded);
}
