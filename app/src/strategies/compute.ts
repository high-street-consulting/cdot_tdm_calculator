// Aggregates strategy results across the user's selected TAZs and applies
// CAPCOA subsector caps per category. The UI's "results" panel consumes
// the AggregatedResults shape.

import { BEHAVIORAL_DEFAULTS, VMT_PURPOSE_SHARE } from "./constants";
import {
  getStrategy,
  type CapcoaSubsector,
  type PurposePool,
  type StrategyCategoryId,
  type StrategyMeta,
} from "./registry";
import {
  AREA_TYPE_THRESHOLDS,
  CTR_SUBGROUP_CAP,
  PLACE_TYPE_CAPS,
} from "./catalog";
import { STRATEGY_REGISTRY, type StrategyKey } from "./strategies";
import { runCompute } from "./computeDsl";
import { AGGREGATE_REGISTRY, type ParkAndRideArgs } from "./parkAndRide";
import type { StrategyResult, TazInputs, TripPurpose } from "./types";
import { baseVmt, buildResult, getAvo, imputedModeShare, imputedParking } from "./util";
import {
  classifyPlaceType,
  combinePool,
  type BindingCap,
  type Contributor,
} from "./combineEngine";

const PURPOSE_POOLS: PurposePool[] = ["commute", "recreational", "other"];

/** Display category → CAPCOA subsector fallback (used only if a strategy is untagged). */
const CATEGORY_TO_SUBSECTOR: Record<string, CapcoaSubsector> = {
  landuse: "land_use",
  bikeped: "neighborhood_design",
  transit: "transit",
  vanpool: "commute_trip_reduction",
  support: "commute_trip_reduction",
  parking: "parking",
  induced: "induced",
};

/** Purpose pools a strategy runs in, honoring its optional runtime scope input. */
function resolvedPools(
  meta: StrategyMeta,
  values: Record<string, number | string>,
): PurposePool[] {
  let pools: PurposePool[] =
    meta.purposeApplicability && meta.purposeApplicability.length > 0
      ? [...meta.purposeApplicability]
      : meta.compute?.pool === "commute"
        ? ["commute"]
        : meta.compute?.pool === "recreational"
          ? ["recreational"]
          : meta.compute?.pool === "other"
            ? ["other"]
            : [...PURPOSE_POOLS];
  if (meta.purposeScopeInput) {
    const v = values[meta.purposeScopeInput];
    if (v != null && String(v).toLowerCase() === "commute") {
      pools = pools.filter((p) => p === "commute");
    }
  }
  return pools;
}

function subsectorOf(meta: StrategyMeta): CapcoaSubsector {
  return meta.capcoaSubsector ?? CATEGORY_TO_SUBSECTOR[meta.category] ?? "neighborhood_design";
}

/**
 * Public: the purpose pools a strategy acts on given its current input values
 * (honoring a `purpose_scope_input` selector). Used by the UI to label which
 * VMT a strategy's percentage applies to.
 */
export function strategyPools(
  meta: StrategyMeta,
  values: Record<string, number | string> = {},
): PurposePool[] {
  return resolvedPools(meta, values);
}

/** Human label for a strategy's purpose pools, e.g. "all trips", "commute trips". */
export function purposePoolsLabel(pools: PurposePool[]): string {
  const set = new Set(pools);
  if (set.size >= 3) return "all trips";
  const names: Record<PurposePool, string> = {
    commute: "commute",
    recreational: "recreational",
    other: "other",
  };
  const parts = (["commute", "recreational", "other"] as PurposePool[])
    .filter((p) => set.has(p))
    .map((p) => names[p]);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return `${parts[0]} trips`;
  return `${parts.join(" + ")} trips`;
}

/**
 * The base pool for a strategy's standalone reduction, narrowed to "commute"
 * when a scope-gating select input (purposeScopeInput) is set to "commute".
 * Falls back to the input's catalog default when the caller hasn't set it.
 */
function scopeBasis(
  meta: StrategyMeta,
  values: Record<string, number | string>,
  defaultPool: TripPurpose,
): TripPurpose {
  const input = meta.purposeScopeInput;
  if (input) {
    const raw = values[input] ?? meta.defaults[input];
    if (raw != null && String(raw).toLowerCase() === "commute") return "commute";
  }
  return defaultPool;
}

function activityDensityOf(taz: TazInputs): number {
  if (typeof taz.activity_density === "number" && Number.isFinite(taz.activity_density)) {
    return taz.activity_density;
  }
  const pop = typeof taz.pop_density === "number" ? taz.pop_density : 0;
  const emp = typeof taz.emp_density === "number" ? taz.emp_density : 0;
  return pop + emp;
}

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
  /**
   * STANDALONE VMT reduction (mi/day, positive = saved), i.e. the strategy's
   * own effect as if applied alone — the sum of its per-TAZ rows. This is the
   * "gross" lever size shown per strategy; it does NOT include the multiplicative
   * damping / caps from combining with other strategies (see
   * `combined_daily_vmt_reduction` for the strategy's attributed share of the
   * combined total).
   */
  daily_vmt_reduction: number;
  /** Aggregate base_vmt the strategy was applied to (standalone). */
  base_vmt_total: number;
  /** Standalone pct = daily_vmt_reduction / base_vmt_total (signed). */
  pct_vmt_reduction: number;
  /**
   * The strategy's attributed share of the COMBINED total (mi/day, positive =
   * saved), after multiplicative overlap + CAPCOA caps. Σ over strategies equals
   * `total_daily_vmt_reduction`. Log-share attribution within each purpose pool.
   */
  combined_daily_vmt_reduction: number;
  /** True when a measure / subsector / category / global cap reduced this strategy. */
  capped: boolean;
  /**
   * When capped, the tightest cap that bound this strategy: its tier
   * ('measure' | 'land_use' | 'category' | 'ctr' | 'global') and the ceiling in
   * PERCENT VMT (e.g. 30). Undefined when not capped.
   */
  cap?: BindingCap;
  /** Per-TAZ rows (debugging / export). */
  rows: StrategyResult[];
}

/** A soft overlap warning: two strategies share a mechanism + population in a pool. */
export interface OverlapWarning {
  a: StrategyKey;
  b: StrategyKey;
  mechanism: string;
  target_population: string;
  /** The purpose pools both strategies act on (the overlapping trip types). */
  pools: PurposePool[];
  reason: string;
}

export interface AggregatedResults {
  /**
   * Combined net daily VMT reduction across all strategies (mi/day, positive =
   * saved). Computed by the CAPCOA combination engine: per purpose pool,
   * strategies combine multiplicatively within/across subsectors under the
   * place-type nested caps; pools sum; induced-demand (VMT-increase) strategies
   * are added as a net delta. This is ≤ the sum of standalone reductions.
   */
  total_daily_vmt_reduction: number;
  /** total_daily_vmt_reduction / total selected baseline VMT (signed fraction). */
  total_pct_vmt_reduction: number;
  /**
   * Sum of the per-strategy STANDALONE reductions (mi/day). The gap between this
   * and total_daily_vmt_reduction is the overlap + cap adjustment.
   */
  sum_standalone_daily_vmt_reduction: number;
  /** Selected TAZs' summed baseline VMT (mi/day). */
  baseline_vmt: number;
  /** Per-strategy rollup, in basket order. */
  per_strategy: PerStrategyAggregate[];
  /** Display categories where any strategy was reduced by a cap. */
  capped_categories: StrategyCategoryId[];
  /** Soft overlap warnings (shared mechanism + population within a pool). */
  overlap_warnings: OverlapWarning[];
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
    // A scope-gated strategy (purpose_scope_input, e.g. transit_pass_subsidy's
    // vmt_scope) narrows its base pool when the user picks "commute", so the
    // standalone preview matches the pool the combination engine will use.
    const basis = scopeBasis(meta, values, spec.pool);
    return selectedTazs.map((taz) =>
      buildResult({
        taz,
        strategy: meta.displayName,
        inputs: inputsStr,
        pct: runCompute(spec, dslRow(taz, rowOverrides), params, constOverrides),
        basis,
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

  // ---- STANDALONE per-strategy rollup (unchanged semantics) -------------
  // Each strategy's own effect, summed over its per-TAZ rows. This drives the
  // per-strategy display and is NOT damped by combination (see combineEngine).
  const perStrategy: PerStrategyAggregate[] = basket.map((entry) => {
    const meta = getStrategy(entry.id);
    const rows = computeStrategyRows(entry.id, entry.values, tazs, entry.contextOverrides);
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
      combined_daily_vmt_reduction: 0, // filled by the combination engine below
      capped: false,
      rows,
    };
  });
  const byId = new Map(perStrategy.map((p) => [p.id as string, p]));

  // ---- CAPCOA combination engine (per purpose pool, per TAZ) -------------
  // Pool-base overrides: a `vmt_share_<purpose>` context override redefines the
  // SIZE of a purpose pool, so it applies project-wide (merged across entries),
  // not per strategy. Other overrides already flowed into each strategy's pct
  // via computeStrategyRows above.
  const poolOverrides: Record<string, number> = {};
  for (const entry of basket) {
    for (const [k, v] of Object.entries(entry.contextOverrides ?? {})) {
      if (k.startsWith("vmt_share_") && Number.isFinite(v)) poolOverrides[k] = v;
    }
  }

  // Total base VMT per pool across the selection (used to turn each strategy's
  // standalone reduction into a pool-relative fraction).
  const poolBase: Record<PurposePool, number> = { commute: 0, recreational: 0, other: 0 };
  for (const taz of tazs) {
    for (const P of PURPOSE_POOLS) poolBase[P] += baseVmt(taz, P, poolOverrides);
  }

  // Per-reducer: resolved pools, subsector, and pool-relative reduction fraction.
  interface Reducer {
    id: string;
    meta: StrategyMeta;
    pools: PurposePool[];
    subsector: CapcoaSubsector;
    r: number; // reduction fraction of each of its pools' base (>0 = reduction)
    measureCapped: boolean;
  }
  const reducers: Reducer[] = [];
  let inducedDelta = 0; // net mi/day from induced-demand (bypass), signed (+saved)
  for (const entry of basket) {
    const p = byId.get(entry.id as string)!;
    if (p.meta.excludedFromCaps) {
      inducedDelta += p.daily_vmt_reduction; // usually negative (a VMT increase)
      p.combined_daily_vmt_reduction = p.daily_vmt_reduction;
      continue;
    }
    const pools = resolvedPools(p.meta, entry.values);
    const denom = pools.reduce((a, P) => a + poolBase[P], 0);
    let r = denom > 0 ? p.daily_vmt_reduction / denom : 0; // fraction of its pools
    let measureCapped = false;
    const cap = p.meta.measureCap;
    if (typeof cap === "number" && Number.isFinite(cap) && r > cap / 100) {
      r = cap / 100;
      measureCapped = true;
    }
    reducers.push({ id: entry.id as string, meta: p.meta, pools, subsector: subsectorOf(p.meta), r, measureCapped });
  }

  // Run the engine per TAZ per pool; accumulate savings + attribution + caps.
  const attributed: Record<string, number> = {};
  const cappedIds = new Set<string>();
  // Per strategy, the tightest binding cap seen across pools/TAZs (lowest %).
  const cappedByStrategy: Record<string, BindingCap> = {};
  let poolSavings = 0;
  for (const taz of tazs) {
    const placeType = classifyPlaceType(taz.area_type, activityDensityOf(taz), AREA_TYPE_THRESHOLDS);
    for (const P of PURPOSE_POOLS) {
      const basePt = baseVmt(taz, P, poolOverrides);
      if (basePt <= 0) continue;
      const contribs: Contributor[] = reducers
        .filter((rd) => rd.pools.includes(P) && rd.r !== 0)
        .map((rd) => ({ id: rd.id, subsector: rd.subsector, r: rd.r, measureCapped: rd.measureCapped }));
      if (contribs.length === 0) continue;
      const res = combinePool(contribs, placeType, PLACE_TYPE_CAPS, CTR_SUBGROUP_CAP);
      poolSavings += basePt * res.R;
      for (const [id, share] of Object.entries(res.attribution)) {
        attributed[id] = (attributed[id] ?? 0) + basePt * share;
      }
      for (const id of res.cappedIds) cappedIds.add(id);
      for (const [id, cap] of Object.entries(res.cappedBy)) {
        const cur = cappedByStrategy[id];
        if (!cur || cap.capPct < cur.capPct) cappedByStrategy[id] = cap;
      }
    }
  }

  // Fill combined attribution + capped flags on the reducer strategies.
  for (const rd of reducers) {
    const p = byId.get(rd.id)!;
    p.combined_daily_vmt_reduction = attributed[rd.id] ?? 0;
    p.capped = cappedIds.has(rd.id);
    if (cappedByStrategy[rd.id]) p.cap = cappedByStrategy[rd.id];
  }

  const cappedCategories: StrategyCategoryId[] = Array.from(
    new Set(perStrategy.filter((p) => p.capped).map((p) => p.meta.category)),
  );

  const totalDelta = poolSavings + inducedDelta;
  const sumStandalone = perStrategy.reduce((a, p) => a + p.daily_vmt_reduction, 0);
  return {
    total_daily_vmt_reduction: totalDelta,
    total_pct_vmt_reduction: baselineVmt > 0 ? totalDelta / baselineVmt : 0,
    sum_standalone_daily_vmt_reduction: sumStandalone,
    baseline_vmt: baselineVmt,
    per_strategy: perStrategy,
    capped_categories: cappedCategories,
    overlap_warnings: detectOverlaps(reducers),
    taz_count: tazs.length,
  };
}

/**
 * Soft overlap warnings (spec §4.2): two selected strategies that share a
 * purpose pool AND the same dominant mechanism AND the same target_population
 * pull from the same behavioral pool; their combined credit is bounded by the
 * caps, but the overlap warrants analyst review. Non-blocking.
 */
function detectOverlaps(
  reducers: { id: string; meta: StrategyMeta; pools: PurposePool[] }[],
): OverlapWarning[] {
  const out: OverlapWarning[] = [];
  for (let i = 0; i < reducers.length; i++) {
    for (let j = i + 1; j < reducers.length; j++) {
      const a = reducers[i];
      const b = reducers[j];
      const sharedPools = a.pools.filter((p) => b.pools.includes(p));
      if (sharedPools.length === 0) continue;
      const mechA = a.meta.mechanism?.[0];
      const mechB = b.meta.mechanism?.[0];
      const popA = a.meta.targetPopulation;
      const popB = b.meta.targetPopulation;
      if (mechA && mechA === mechB && popA && popA === popB) {
        out.push({
          a: a.id as StrategyKey,
          b: b.id as StrategyKey,
          mechanism: mechA,
          target_population: popA,
          pools: sharedPools,
          reason: `${a.meta.displayName} and ${b.meta.displayName} both act on ${popA} trips via ${mechA.replace(/_/g, " ")}; their combined credit is bounded by the caps but overlaps — review.`,
        });
      }
    }
  }
  return out;
}
