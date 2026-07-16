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
  /** Human list for the "filled automatically" reassurance line. */
  auto_filled_summary?: string[];
  /** Closed-form math (optional); see computeDsl. Absent for code-backed strategies. */
  compute?: ComputeSpec;
  _defaults: Record<string, number | string>;
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
    autoFilledSummary: s.auto_filled_summary ?? undefined,
    compute: s.compute,
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
