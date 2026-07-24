// Aggregates strategy results across the user's selected TAZs and applies
// CAPCOA subsector caps per category. The UI's "results" panel consumes
// the AggregatedResults shape.

import { BEHAVIORAL_DEFAULTS, VMT_PURPOSE_SHARE } from "./constants";
import { CATEGORIES, getStrategy, type StrategyCategoryId, type StrategyMeta } from "./registry";
import { STRATEGY_REGISTRY, type StrategyKey } from "./strategies";
import { runCompute } from "./computeDsl";
import { AGGREGATE_REGISTRY, type ParkAndRideArgs } from "./parkAndRide";
import type { StrategyResult, TazInputs } from "./types";
import { buildResult, getAvo, imputedModeShare, imputedParking } from "./util";

/**
 * Assemble the evaluation scope for a YAML `compute` strategy: every finite
 * numeric TAZ field, plus the imputed mode shares + AVO under the canonical
 * names the formulas use (mirrors the Python helpers add_imputed_mode_shares /
 * add_imputed_avo). Parent-gate fields the app's TAZ layer doesn't carry are
 * supplied by the spec's `row_defaults`.
 */
function dslRow(
  taz: TazInputs,
  contextOverrides?: Record<string, number>,
): Record<string, number> {
  const row: Record<string, number> = {};
  for (const [k, v] of Object.entries(taz)) {
    if (typeof v === "number" && Number.isFinite(v)) row[k] = v;
  }
  const ms = imputedModeShare(taz);
  row.transit_mode_share = ms.transit;
  row.auto_mode_share = ms.auto;
  row.bike_mode_share = ms.bike;
  row.walk_mode_share = ms.walk;
  row.avo = getAvo(taz);
  const park = imputedParking(taz);
  row.parking_price = park.price;
  row.share_emp_paying = park.sharePaying;
  // Seed row-var fallbacks so a UNIFORM project-context override lands even on
  // TAZs whose data lacks the field. These names are the ContextRow.overrideKeys
  // the DetailView exposes:
  //   - avg_trip_length: bike/micromobility trip-length denominator (row var;
  //     BEHAVIORAL_DEFAULTS fallback here mirrors the spec's row_defaults=9 for
  //     the DSL bike strategies, letting the override channel replace it).
  //   - vmt_share_commute: the commute purpose split behind the "Commute VMT
  //     base"; seeding the effective value (per-TAZ field else 0.30 default) lets
  //     an override drive the pool="commute" base uniformly (see baseVmt).
  if (!(typeof taz.avg_trip_length === "number" && Number.isFinite(taz.avg_trip_length))) {
    row.avg_trip_length = BEHAVIORAL_DEFAULTS.avg_vehicle_trip_length_mi;
  }
  {
    const observed = taz.vmt_share_commute;
    row.vmt_share_commute =
      typeof observed === "number" && Number.isFinite(observed)
        ? observed
        : VMT_PURPOSE_SHARE.commute;
  }
  // Per-strategy project-context overrides win over the imputed/raw-TAZ values
  // for EVERY TAZ (applied uniformly across the selection), so a user-supplied
  // baseline (e.g. an observed transit mode share) drives the calc instead of
  // the data-derived default. Only finite overrides are applied; only keys the
  // formulas actually read (i.e. present after the seeding above, or any custom
  // per-TAZ var) are touched.
  if (contextOverrides) {
    for (const [k, v] of Object.entries(contextOverrides)) {
      if (typeof v === "number" && Number.isFinite(v)) row[k] = v;
    }
  }
  return row;
}

/**
 * Coerce basket inputs to numbers for the DSL. Boolean `select` inputs (modeled
 * as yes/no per the catalog convention) map to 1/0, mirroring the Python calc
 * functions, which accept either a bool or the option string.
 */
function numericParams(values: Record<string, number | string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "number") {
      if (Number.isFinite(v)) out[k] = v;
      continue;
    }
    const s = v.trim().toLowerCase();
    if (["yes", "true", "1"].includes(s)) out[k] = 1;
    else if (["no", "false", "0"].includes(s)) out[k] = 0;
    else {
      const n = Number(s);
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
}

export interface BasketEntry {
  /** Strategy id (matches STRATEGY_REGISTRY key). */
  id: StrategyKey;
  /** Current input values, in the strategy's native units (fractions for %). */
  values: Record<string, number | string>;
  /**
   * Snapshot of the system-default seed captured when this strategy's detail
   * view was first opened: `{ ...meta.defaults, ...TAZ-derived defaults }` for
   * the selected project area (see defaults.ts → seedDefaults). Provenance
   * baseline: an input is considered "modified by the user" when its current
   * value differs from this seed (UI-06; surfaced in the PDF/CSV exports).
   * Optional for backward compatibility with any pre-existing basket shape;
   * callers fall back to recomputing the seed when it's absent.
   */
  seededDefaults?: Record<string, number | string>;
  /**
   * Optional per-input free-text "source / justification" notes, keyed by the
   * input `key`. Captured when the user overrides a seeded default so a PD 1601
   * application can document where a non-default value came from (CMT-01).
   * Only populated for inputs the user chose to annotate; absent/empty notes
   * are not exported. Optional for backward compatibility.
   */
  inputNotes?: Record<string, string>;
  /**
   * Per-strategy overrides of the data-derived "Project context" baselines,
   * keyed by the ContextRow.overrideKey (== the per-TAZ dslRow variable, e.g.
   * "transit_mode_share", "avo", "parking_price"). When set, the override value
   * REPLACES the imputed/raw-TAZ value uniformly across every selected TAZ when
   * this strategy is computed (see dslRow / computeStrategyRows). Additive and
   * optional: absent -> byte-for-byte the pre-override behavior.
   */
  contextOverrides?: Record<string, number>;
  /**
   * Optional free-text "why" narrative for each context override, keyed by the
   * same overrideKey. Documents the justification for a non-default baseline in
   * a PD 1601 application (mirrors inputNotes for inputs). Optional/additive.
   */
  contextNotes?: Record<string, string>;
}

export interface PerStrategyAggregate {
  id: StrategyKey;
  meta: StrategyMeta;
  /** Aggregate VMT reduction (mi/day), signed: negative = increase. */
  daily_vmt_reduction: number;
  /** Aggregate base_vmt the strategy was applied to. */
  base_vmt_total: number;
  /** Aggregate pct = daily_vmt_reduction / base_vmt_total (signed). */
  pct_vmt_reduction: number;
  /** Set true after subsector cap was applied. */
  capped: boolean;
  /** Per-TAZ rows (debugging / export). */
  rows: StrategyResult[];
}

export interface AggregatedResults {
  /** Combined daily VMT reduction across all strategies (mi/day). */
  total_daily_vmt_reduction: number;
  /** total_daily_vmt_reduction / total selected baseline VMT (signed fraction). */
  total_pct_vmt_reduction: number;
  /** Selected TAZs' summed baseline VMT (mi/day). */
  baseline_vmt: number;
  /** Per-strategy rollup, in basket order. */
  per_strategy: PerStrategyAggregate[];
  /** Categories where a CAPCOA subsector cap kicked in. */
  capped_categories: StrategyCategoryId[];
  /** Total TAZs in the project area. */
  taz_count: number;
}

const PER_TAZ_REGISTRY = STRATEGY_REGISTRY as unknown as Record<
  string,
  (
    taz: TazInputs,
    args: Record<string, unknown>,
    contextOverrides?: Record<string, number>,
  ) => StrategyResult
>;

/**
 * Split a unified contextOverrides map into ROW overrides (applied per-TAZ via
 * dslRow) and CONSTANT overrides (fed to runCompute's constOverrides). A key is
 * a constant override iff it names an entry in the strategy's compiled
 * `spec.const`; everything else is a row override. With no spec constants (or no
 * overrides) `constOverrides` is undefined and `rowOverrides` is the input map
 * unchanged, so the DSL path stays byte-for-byte identical.
 */
function partitionOverrides(
  specConst: Record<string, number> | undefined,
  overrides: Record<string, number> | undefined,
): { rowOverrides: Record<string, number> | undefined; constOverrides: Record<string, number> | undefined } {
  if (!overrides || !specConst) return { rowOverrides: overrides, constOverrides: undefined };
  let rowOverrides: Record<string, number> | undefined;
  let constOverrides: Record<string, number> | undefined;
  for (const [k, v] of Object.entries(overrides)) {
    if (k in specConst) {
      (constOverrides ??= {})[k] = v;
    } else {
      (rowOverrides ??= {})[k] = v;
    }
  }
  return { rowOverrides, constOverrides };
}

/**
 * Compute one strategy's per-TAZ results (uncapped), dispatching on how its math
 * is defined. This is the single source of the dispatch, used by computeResults
 * (aggregation + caps) and by DetailView (live preview):
 *   1. YAML `compute:` block  -> evaluate via computeDsl
 *   2. AGGREGATE_REGISTRY      -> cross-TAZ fn (e.g. Park-and-Ride)
 *   3. STRATEGY_REGISTRY       -> per-TAZ hand-written calc fn (complex strategies)
 */
export function computeStrategyRows(
  id: StrategyKey,
  values: Record<string, number | string>,
  selectedTazs: TazInputs[],
  contextOverrides?: Record<string, number>,
): StrategyResult[] {
  const meta = getStrategy(id);

  if (meta.compute) {
    const spec = meta.compute;
    // Seed with the strategy's input defaults so a formula that references an
    // input the caller hasn't set (an unseeded deep-link, or an input not yet
    // touched) resolves to the default instead of throwing "unknown name".
    // Mirrors the `args.x ?? default` tolerance of the old code calc fns.
    const params = { ...numericParams(meta.defaults), ...numericParams(values) };
    const inputsStr = Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    // Partition the single unified contextOverrides map into:
    //   - CONSTANT overrides: keys that name an entry in this strategy's compiled
    //     spec.const (e.g. r_ctr, bike_len, avg_fare, max_tod_transit_share) ->
    //     fed to runCompute's constOverrides so they replace the formula constant.
    //   - ROW overrides: everything else (mode share, avo, parking price,
    //     avg_trip_length, vmt_share_commute, …) -> applied per-TAZ via dslRow,
    //     exactly as before.
    // Constants are strategy-global (not per-TAZ), so routing them through
    // runCompute rather than dslRow keeps a per-TAZ formula var from ever
    // shadowing an intended const override.
    const { rowOverrides, constOverrides } = partitionOverrides(spec.const, contextOverrides);
    return selectedTazs.map((taz) =>
      buildResult({
        taz,
        strategy: meta.displayName,
        inputs: inputsStr,
        pct: runCompute(spec, dslRow(taz, rowOverrides), params, constOverrides),
        basis: spec.pool,
        contextOverrides: rowOverrides,
      }),
    );
  }

  const aggregateFn = AGGREGATE_REGISTRY[id];
  if (aggregateFn) {
    return aggregateFn(selectedTazs, values as unknown as ParkAndRideArgs);
  }

  // Hand-written per-TAZ calc fns. Thread contextOverrides through so a
  // strategy that reads a project-context baseline (e.g. transit_service_
  // expansion's transit/auto mode share + AVO) honors the override uniformly
  // across every TAZ, matching the DSL path's dslRow semantics. Fns that don't
  // read any overridable field simply ignore the extra arg.
  //
  // Seed the strategy's input defaults and drop empty/undefined values before
  // calling the fn, so a cleared number input (which the DetailView stores as
  // "") or an unset input falls back to its default instead of reaching a calc
  // fn as "" / undefined and throwing (e.g. `args.new_lane_miles.toFixed`).
  // Mirrors the DSL path's `{ ...defaults, ...numericParams(values) }` tolerance.
  const args: Record<string, number | string> = { ...meta.defaults };
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    args[k] = v;
  }
  const fn = PER_TAZ_REGISTRY[id];
  return selectedTazs.map((taz) => fn(taz, args, contextOverrides));
}

/**
 * Options for computeResults.
 */
export interface ComputeResultsOptions {
  /**
   * PROJECT-LEVEL baseline VMT override. When a positive finite number is
   * supplied AND the derived baseline (sum of `daily_vmt` over selectedTazs) is
   * > 0, a uniform scale factor `f = baselineVmtOverride / derivedBaseline` is
   * applied to EACH TAZ's `daily_vmt` before any strategy math runs. This makes
   * `results.baseline_vmt` equal the override, scales every strategy's base_vmt
   * and absolute daily_vmt_reduction by `f` (percentages unchanged), and keeps
   * all downstream figures consistent. Null/absent/non-positive, or a derived
   * baseline of 0, leaves behavior byte-for-byte identical (no scaling). This is
   * distinct from a basket entry's per-strategy `contextOverrides`.
   */
  baselineVmtOverride?: number | null;
}

/**
 * Run all basket strategies across selected TAZs, apply subsector caps,
 * roll up to per-strategy + grand totals.
 *
 * Strategies that scope to a sub-purpose of VMT (e.g. commute) are
 * applied to the corresponding base; the aggregate `pct_vmt_reduction` is
 * always expressed against the TOTAL selected daily VMT for an
 * apples-to-apples comparison across strategies.
 *
 * A project-level `baselineVmtOverride` (see ComputeResultsOptions) uniformly
 * scales each TAZ's `daily_vmt` so the reported baseline matches an
 * observed/authoritative figure; see the option's doc for the exact semantics.
 */
export function computeResults(
  basket: BasketEntry[],
  selectedTazs: TazInputs[],
  opts?: ComputeResultsOptions,
): AggregatedResults {
  const derivedBaseline = selectedTazs.reduce(
    (acc, t) => acc + (Number.isFinite(t.daily_vmt) ? t.daily_vmt : 0),
    0,
  );

  // Project-level baseline VMT override: if a positive finite override is given
  // and the derived baseline is > 0, compute a single uniform scale factor and
  // rebuild the selection with each TAZ's daily_vmt scaled by it. Only daily_vmt
  // is touched; every other field is passed through unchanged. All strategy math
  // (base_vmt, absolute reductions, pool/aggregate bases) then flows from the
  // scaled VMT, so baseline_vmt equals the override and percentages are
  // unchanged. Otherwise `tazs` is the input array unchanged (no-op path).
  const override = opts?.baselineVmtOverride;
  const applyOverride =
    typeof override === "number" &&
    Number.isFinite(override) &&
    override > 0 &&
    derivedBaseline > 0;
  const scale = applyOverride ? override / derivedBaseline : 1;
  const tazs = applyOverride
    ? selectedTazs.map((t) => ({
        ...t,
        daily_vmt: (Number.isFinite(t.daily_vmt) ? t.daily_vmt : 0) * scale,
      }))
    : selectedTazs;

  // The reported baseline is the (scaled) sum, which equals the override when
  // applied and the plain derived sum otherwise.
  const baselineVmt = applyOverride ? derivedBaseline * scale : derivedBaseline;

  const perStrategy: PerStrategyAggregate[] = basket.map((entry) => {
    const meta = getStrategy(entry.id);
    const rows = computeStrategyRows(
      entry.id,
      entry.values,
      tazs,
      entry.contextOverrides,
    );
    let totalDelta = 0;
    let totalBase = 0;
    for (const row of rows) {
      totalDelta += row.daily_vmt_reduction;
      totalBase += row.base_vmt;
    }

    const pct = totalBase > 0 ? totalDelta / totalBase : 0;
    return {
      id: entry.id,
      meta,
      daily_vmt_reduction: totalDelta,
      base_vmt_total: totalBase,
      pct_vmt_reduction: pct,
      capped: false,
      rows,
    };
  });

  // Apply CAPCOA subsector caps. The cap is on % VMT reduction COMBINED for
  // strategies in the category, against the TOTAL selected baseline VMT
  // (mirroring the design's results panel + Python methodology guidance).
  const cappedCategories: StrategyCategoryId[] = [];
  for (const cat of CATEGORIES) {
    if (cat.cap == null) continue;
    const inCat = perStrategy.filter((p) => p.meta.category === cat.id);
    if (inCat.length === 0) continue;
    const combinedReductionPct =
      baselineVmt > 0
        ? inCat.reduce((acc, p) => acc + p.daily_vmt_reduction, 0) / baselineVmt
        : 0;
    const capFrac = cat.cap / 100; // CAPCOA cap is %
    if (combinedReductionPct > capFrac) {
      const scale = capFrac / combinedReductionPct;
      for (const p of inCat) {
        p.daily_vmt_reduction *= scale;
        p.pct_vmt_reduction =
          p.base_vmt_total > 0 ? p.daily_vmt_reduction / p.base_vmt_total : 0;
        p.capped = true;
      }
      cappedCategories.push(cat.id);
    }
  }

  const totalDelta = perStrategy.reduce((a, p) => a + p.daily_vmt_reduction, 0);
  return {
    total_daily_vmt_reduction: totalDelta,
    total_pct_vmt_reduction: baselineVmt > 0 ? totalDelta / baselineVmt : 0,
    baseline_vmt: baselineVmt,
    per_strategy: perStrategy,
    capped_categories: cappedCategories,
    taz_count: tazs.length,
  };
}
