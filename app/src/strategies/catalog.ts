// Strategy catalog adapter.
//
// The strategy *content* (names, descriptions, methodology prose, inputs,
// images, tags, and applicability) is owned by strategy-catalog/ as one YAML
// file per strategy, compiled to strategies.json and synced here as
// catalog.json (see scripts/sync-catalog.mjs + package.json's pre* hooks).
// This module loads that JSON and adapts each record onto the app's existing
// StrategyMeta / StrategyInput shape so DetailView, MethodologyView, and
// ShopBody keep working, then exposes the new fields for progressive use.
//
// The numeric engine stays in code: STRATEGY_REGISTRY (strategies.ts) and the
// constants in constants.ts remain authoritative for the math. Catalog records
// are matched to calc functions by `id` (which must equal a StrategyKey).

import catalog from "./catalog.json";
import type { ComputeSpec } from "./computeDsl";
import type { StrategyKey } from "./strategies";
import type {
  StrategyCategory,
  StrategyCategoryId,
  StrategyInput,
  StrategyMeta,
} from "./registry";

// ---- Catalog record types (mirror schema/strategy.schema.json) ----------

export interface CatalogImage {
  file: string;
  alt: string;
  caption?: string;
  credit?: string;
}

export interface CatalogApplicability {
  min_pop_density?: number | null;
  min_emp_density?: number | null;
  min_activity_density?: number | null;
  area_types?: string[];
  warn_message?: string;
}

export interface CatalogInput {
  key: string;
  label: string;
  control: "slider" | "number" | "select";
  min?: number | null;
  max?: number | null;
  step?: number | null;
  scale?: number | null;
  suffix?: string | null;
  unit?: string | null;
  options?: { value: string; label: string }[];
  default: number | string;
  tooltip?: string;
  instructions?: string;
  benchmark?: string;
  prepopulated_from?: string | null;
  // ---- Redesign checklist fields ----
  prerequisite?: boolean;
  summary?: string;
  source_note?: string;
  resources?: { label: string; url: string }[];
}

export interface CatalogStrategy {
  id: string;
  uid: string;
  name: string;
  category: string;
  status: "implemented" | "planned" | "not_recommended";
  tags: string[];
  short_description: string;
  extended_description: string;
  images: CatalogImage[];
  method: string;
  formula: string;
  methodology_detail: string;
  applicability: CatalogApplicability;
  inputs: CatalogInput[];
  notes: string;
  /** "When to use this strategy" markdown (Applicability section). */
  guidance?: string;
  /** Overrides "reduced" in the results views (e.g. "avoided"). */
  impact_direction?: string;
  /** What the reduction is measured against, e.g. "relative to lower-density development". */
  impact_qualifier?: string;
  /** Human list for the "filled automatically" reassurance line. */
  auto_filled_summary?: string[];
  /** Closed-form math (optional); see computeDsl. Absent for code-backed strategies. */
  compute?: ComputeSpec;
  // ---- CAPCOA combination tags (Phase 1; consumed by the combination engine) ----
  mechanism?: Mechanism[];
  purpose_applicability?: PurposePool[];
  purpose_scope_input?: string;
  target_population?: string;
  capcoa_subsector?: CapcoaSubsector;
  capcoa_measure?: string;
  measure_cap?: number | null;
  excluded_from_caps?: boolean;
  _defaults: Record<string, number | string>;
}

/** CAPCOA VMT mechanisms — which multiplicative factor a strategy acts on. */
export type Mechanism = "trip_generation" | "trip_length" | "mode_shift";
/** Disjoint VMT purpose pools (the combination engine's outer loop). */
export type PurposePool = "commute" | "recreational" | "other";
/** CAPCOA subsector — the cap-grouping unit (distinct from display category). */
export type CapcoaSubsector =
  | "land_use"
  | "neighborhood_design"
  | "parking"
  | "transit"
  | "commute_trip_reduction"
  | "induced";

/** Place-type-tiered CAPCOA cap tables (percent VMT), keyed by place type. */
export interface PlaceTypeCaps {
  global: Record<string, number>;
  category: Record<string, number>;
  land_use: Record<string, number>;
}

export interface CatalogCategory {
  id: string;
  name: string;
  css_color_var: string;
  cap: number | null;
  image: string;
}

export interface Catalog {
  generated_at: string;
  categories: CatalogCategory[];
  area_type_thresholds: Record<string, number>;
  tag_catalog: Record<string, string[]>;
  // CAPCOA 2021 combination caps + vocabularies (see globals.yaml).
  place_type_caps?: PlaceTypeCaps;
  ctr_subgroup_cap?: number;
  capcoa_subsectors?: CapcoaSubsector[];
  /** Displayed subsector caps (percent VMT), keyed by CAPCOA subsector. */
  capcoa_subsector_caps?: Record<string, number | null>;
  /** Human labels for the CAPCOA subsectors, keyed by subsector id. */
  capcoa_subsector_labels?: Record<string, string>;
  mechanisms?: Mechanism[];
  strategies: CatalogStrategy[];
}

export const CATALOG = catalog as unknown as Catalog;

// ---- Area-type enum → display label -------------------------------------
// Used by the Applicability section's "Recommended context" chips.
export const AREA_TYPE_LABELS: Record<string, string> = {
  urban_core: "Urban core",
  urban: "Urban",
  suburban: "Suburban",
  rural: "Rural",
};

/**
 * Human label for an area-type enum. Falls back to title-case with
 * underscores → spaces for any value not in AREA_TYPE_LABELS.
 */
export function areaTypeLabel(value: string): string {
  return (
    AREA_TYPE_LABELS[value] ??
    value
      .split("_")
      .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
      .join(" ")
  );
}

// ---- Adapters: catalog record -> existing app shapes --------------------

function toInput(i: CatalogInput): StrategyInput {
  const common = {
    key: i.key,
    label: i.label,
    source: i.tooltip, // short citation shown in the (i) tooltip + .src caption
    instructions: i.instructions || undefined, // markdown "how do I find this?"
    benchmark: i.benchmark || undefined,
    // redesign checklist fields (snake_case → camelCase)
    prerequisite: i.prerequisite,
    summary: i.summary || undefined,
    sourceNote: i.source_note || undefined,
    resources: i.resources ?? undefined,
  };
  if (i.control === "slider") {
    return {
      type: "slider",
      ...common,
      min: i.min ?? 0,
      max: i.max ?? 0,
      step: i.step ?? 1,
      scale: i.scale ?? undefined,
      suffix: i.suffix ?? undefined,
    } as StrategyInput;
  }
  if (i.control === "number") {
    return {
      type: "number",
      ...common,
      min: i.min ?? undefined,
      max: i.max ?? undefined,
      step: i.step ?? undefined,
      unit: i.unit ?? undefined,
    } as StrategyInput;
  }
  return { type: "select", ...common, options: i.options ?? [] } as StrategyInput;
}

export function toMeta(s: CatalogStrategy): StrategyMeta {
  return {
    id: s.id as StrategyKey,
    displayName: s.name,
    category: s.category as StrategyCategoryId,
    description: s.short_description,
    method: s.method,
    // legacy field kept populated for back-compat (CSV export); the methods
    // accordion + methods page now render `methodologyDetail` instead.
    source: s.methodology_detail,
    formula: s.formula,
    inputs: s.inputs.map(toInput),
    defaults: s._defaults,
    // derived; `is_induced` was intentionally dropped from the schema.
    isInduced: s.category === "induced",
    // catalog-sourced fields:
    uid: s.uid,
    extendedDescription: s.extended_description || undefined,
    methodologyDetail: s.methodology_detail || undefined,
    images: s.images ?? [],
    tags: s.tags ?? [],
    applicability: s.applicability ?? {},
    guidance: s.guidance || undefined,
    impactDirection: s.impact_direction || undefined,
    impactQualifier: s.impact_qualifier || undefined,
    autoFilledSummary: s.auto_filled_summary ?? undefined,
    compute: s.compute,
    // CAPCOA combination tags (snake_case → camelCase):
    mechanism: s.mechanism ?? undefined,
    purposeApplicability: s.purpose_applicability ?? undefined,
    purposeScopeInput: s.purpose_scope_input || undefined,
    targetPopulation: s.target_population || undefined,
    capcoaSubsector: s.capcoa_subsector ?? undefined,
    capcoaMeasure: s.capcoa_measure || undefined,
    measureCap: s.measure_cap ?? undefined,
    excludedFromCaps: s.excluded_from_caps ?? undefined,
  };
}

function toCategory(c: CatalogCategory): StrategyCategory {
  return {
    id: c.id as StrategyCategoryId,
    name: c.name,
    cssColorVar: c.css_color_var,
    cap: c.cap,
    image: c.image || undefined,
  };
}

// ---- Derived, app-facing arrays -----------------------------------------

export const CATEGORIES_FROM_CATALOG: StrategyCategory[] =
  CATALOG.categories.map(toCategory);

// Live strategies only (the picker shows just `implemented`; planned/
// not_recommended stay in the catalog but aren't compiled into catalog.json).
export const STRATEGIES_FROM_CATALOG: StrategyMeta[] = CATALOG.strategies
  .filter((s) => s.status === "implemented")
  .map(toMeta);

// ---- CAPCOA 2021 combination caps (globals) -----------------------------
// Fallbacks match tdm_strategy_combination_spec.md §3.1 in case an older
// catalog.json (pre-Phase-1) is bundled.
export const PLACE_TYPE_CAPS: PlaceTypeCaps = CATALOG.place_type_caps ?? {
  global: { urban_core: 75, urban: 40, suburban: 20, rural: 20 },
  category: { urban_core: 70, urban: 35, suburban: 15, rural: 15 },
  land_use: { urban_core: 65, urban: 30, suburban: 10, rural: 10 },
};
export const CTR_SUBGROUP_CAP: number = CATALOG.ctr_subgroup_cap ?? 45;

// Displayed subsector cap + label, keyed by CAPCOA subsector. The detail view
// prefers these over the display category's cap so the figure stays correct when
// a strategy is grouped under a category with a different cap (e.g. carshare).
export const CAPCOA_SUBSECTOR_CAPS: Record<string, number | null> =
  CATALOG.capcoa_subsector_caps ?? {};
export const CAPCOA_SUBSECTOR_LABELS: Record<string, string> =
  CATALOG.capcoa_subsector_labels ?? {};
export const AREA_TYPE_THRESHOLDS: Record<string, number> =
  CATALOG.area_type_thresholds ?? {
    urban_core: 10000,
    urban: 3500,
    suburban: 1000,
    rural: 0,
  };
