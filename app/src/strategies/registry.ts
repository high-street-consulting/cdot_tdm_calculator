// Strategy registry: UI-facing metadata for the live (implemented) strategies.
//
// Content is no longer hardcoded here: it is owned by the strategy catalog
// (strategy-catalog/, one YAML per strategy) and consumed via catalog.ts,
// which adapts each compiled record onto the StrategyMeta / StrategyInput
// shapes defined below. This module keeps the shared type exports, the derived
// CATEGORIES / STRATEGIES arrays, and getStrategy().
//
// The numeric engine stays in code: the calc functions in strategies.ts
// (STRATEGY_REGISTRY) and the constants in constants.ts remain authoritative
// for the math. `defaults` are stored in the units the strategy function
// consumes (fractions for percentages, miles for distances, etc.); the UI
// converts per-input via the slider `scale`.

import type { StrategyKey } from "./strategies";
import type { ComputeSpec } from "./computeDsl";
import type { CatalogApplicability, CatalogImage } from "./catalog";
import {
  CATEGORIES_FROM_CATALOG,
  STRATEGIES_FROM_CATALOG,
} from "./catalog";

export type StrategyCategoryId =
  | "transit"
  | "bikeped"
  | "landuse"
  | "vanpool"
  | "support"
  | "induced"
  // Present in the catalog for planned strategies; no live strategies use
  // these yet, so they never render in the picker (empty categories are
  // skipped). Kept in the union so catalog-derived data stays type-safe.
  | "parking"
  | "electrification"
  | "freight"
  | "programmatic"
  | "technology";

export interface StrategyCategory {
  id: StrategyCategoryId;
  name: string;
  cssColorVar: string;     // CSS variable token for category color
  cap: number | null;      // CAPCOA subsector cap %, applied combined across category
  image?: string;          // category fallback image (empty until art lands)
}

/**
 * Input control descriptor. The UI renders this; the strategy invocation
 * passes the bound value through to the typed strategy function under
 * `kwargs[key]`.
 *
 * The unit conversion convention: `kwargs[key]` is stored in the unit the
 * Python/TS strategy function expects (e.g., fraction 0..1 for shares),
 * even when `suffix === "%"`. The slider/number widget multiplies by
 * `scale` (default 1) for presentation, so a "50%" slider stores 0.50 in
 * state and renders as "50%".
 *
 * `source` is the short citation shown in the (i) tooltip; `instructions` is
 * the longer Markdown "how do I find this value?" help; `benchmark` is an
 * optional contextual line (e.g. peer-city values).
 */
export interface SliderInput {
  type: "slider";
  key: string;
  label: string;
  min: number;       // slider min in *display* units
  max: number;       // slider max in *display* units
  step: number;
  scale?: number;    // display = value * scale (default 100 for "%" suffix, 1 otherwise)
  suffix?: string;
  source?: string;
  instructions?: string;
  benchmark?: string;
  // ---- Redesign checklist fields (optional; catalog-sourced) ----
  /** Marks an input the user must gather ahead of time; drives "What you'll need". */
  prerequisite?: boolean;
  /** Short plain one-liner for the checklist card (distinct from `instructions`). */
  summary?: string;
  /** "Source: …" provenance line for a prerequisite input with no resource link. */
  sourceNote?: string;
  /** Structured reference links, rendered as buttons in the checklist / help block. */
  resources?: { label: string; url: string }[];
}

export interface NumberInput {
  type: "number";
  key: string;
  label: string;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  source?: string;
  instructions?: string;
  benchmark?: string;
  // ---- Redesign checklist fields (optional; catalog-sourced) ----
  /** Marks an input the user must gather ahead of time; drives "What you'll need". */
  prerequisite?: boolean;
  /** Short plain one-liner for the checklist card (distinct from `instructions`). */
  summary?: string;
  /** "Source: …" provenance line for a prerequisite input with no resource link. */
  sourceNote?: string;
  /** Structured reference links, rendered as buttons in the checklist / help block. */
  resources?: { label: string; url: string }[];
}

export interface SelectInput {
  type: "select";
  key: string;
  label: string;
  options: { value: string; label: string }[];
  source?: string;
  instructions?: string;
  benchmark?: string;
  // ---- Redesign checklist fields (optional; catalog-sourced) ----
  /** Marks an input the user must gather ahead of time; drives "What you'll need". */
  prerequisite?: boolean;
  /** Short plain one-liner for the checklist card (distinct from `instructions`). */
  summary?: string;
  /** "Source: …" provenance line for a prerequisite input with no resource link. */
  sourceNote?: string;
  /** Structured reference links, rendered as buttons in the checklist / help block. */
  resources?: { label: string; url: string }[];
}

export type StrategyInput = SliderInput | NumberInput | SelectInput;

export interface StrategyMeta {
  id: StrategyKey;
  displayName: string;
  category: StrategyCategoryId;
  description: string;
  method: string;
  source: string;
  formula: string;
  inputs: StrategyInput[];
  defaults: Record<string, number | string>;
  /** True when the strategy increases VMT rather than reducing it. */
  isInduced?: boolean;
  // ---- Catalog-sourced fields (optional; present for live strategies) ----
  /** Human-facing code (e.g. BP-01, LU-03). */
  uid?: string;
  /** Markdown long-form narrative shown in the "About this strategy" block. */
  extendedDescription?: string;
  /** Markdown methodology write-up (with inline citations/links). */
  methodologyDetail?: string;
  /** Illustrative images; empty falls back to the category image. */
  images?: CatalogImage[];
  /** Controlled-vocabulary filtering tags. */
  tags?: string[];
  /** Minimum densities / area types the strategy is recommended for. */
  applicability?: CatalogApplicability;
  /** Markdown "When to use this strategy" copy shown in the Applicability section. */
  guidance?: string;
  /** Human list for the "filled automatically" reassurance line (checklist footer). */
  autoFilledSummary?: string[];
  /**
   * Closed-form math authored in the catalog YAML. When present, the engine
   * evaluates this (computeDsl) instead of looking up a STRATEGY_REGISTRY calc
   * function; see compute.ts. Absent for complex/spatial strategies that keep
   * a hand-written (and hand-ported) calc fn.
   */
  compute?: ComputeSpec;
}

/** Categories (with CAPCOA caps), derived from the catalog's globals. */
export const CATEGORIES: StrategyCategory[] = CATEGORIES_FROM_CATALOG;

/** Live strategies, derived from the compiled catalog. */
export const STRATEGIES: StrategyMeta[] = STRATEGIES_FROM_CATALOG;

/** Look up a strategy meta by id. Throws if unknown. */
export function getStrategy(id: StrategyKey): StrategyMeta {
  const s = STRATEGIES.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown strategy id ${id}`);
  return s;
}

/**
 * True if `id` is a live catalog strategy (has a detail view). Use this, NOT
 * STRATEGY_REGISTRY, to validate a strategy id: the registry holds only the
 * code-backed strategies, while closed-form (compute-block) strategies are live
 * but not in it.
 */
export function isKnownStrategy(id: string): boolean {
  return STRATEGIES.some((s) => s.id === id);
}
