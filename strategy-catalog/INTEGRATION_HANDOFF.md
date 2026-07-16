# Handoff: integrate the strategy catalog into the calculator app

This describes how to wire the new strategy catalog (`strategy-catalog/`) into the
working SPA (`app/`), replacing the hardcoded strategy metadata with the compiled
JSON, surfacing the new content fields (extended description, images, methodology
detail, per-input instructions, applicability), and adding tag-based filtering and
sorting to the picker.

Read `strategy-catalog/README.md` first for the catalog's structure and field
semantics. This document assumes that context.

## Goal

Today, `app/src/strategies/registry.ts` hardcodes `CATEGORIES` and `STRATEGIES`
(`StrategyMeta[]`). The catalog now owns that content as per-strategy YAML compiled
to `strategy-catalog/compiled/strategies.json`. The app should consume that JSON as
its single source of strategy content. The numeric engine stays in code: the calc
functions in `app/src/strategies/strategies.ts` (`STRATEGY_REGISTRY`) and the
constants in `constants.ts` are unchanged and remain authoritative for the math.

Keep the change additive and low-risk: introduce an adapter that maps the catalog
records onto the existing `StrategyMeta`/`StrategyInput` shape so `DetailView`,
`MethodologyView`, and `ShopBody` keep working, then progressively surface the new
fields.

## Compiled JSON shape

`strategy-catalog/compiled/strategies.json`:

```jsonc
{
  "generated_at": "2026-05-30T...Z",
  "categories": [
    { "id": "transit", "name": "Transit strategies",
      "css_color_var": "var(--cdot-dark-blue)", "cap": 15, "image": "" },
    // ...
  ],
  "area_type_thresholds": { "urban_core": 10000, "urban": 3500, "suburban": 1000, "rural": 0 },
  "tag_catalog": {
    "audience":     ["employer","developer","local-government","transit-agency","mpo"],
    "lever":        ["infrastructure","pricing","service","program","policy","land-use","technology"],
    "trip_purpose": ["commute","all-trips","recreational"],
    "mode":         ["transit","bike","walk","micromobility","vanpool","auto"],
    "context":      ["urban","suburban","rural","corridor","site"]
  },
  "strategies": [
    {
      "id": "separated_bike_lanes",          // == StrategyKey (calc fn key)
      "uid": "BP-01",
      "name": "Separated & protected bike lanes",
      "category": "bikeped",
      "status": "implemented",
      "tags": ["infrastructure","bike","corridor","local-government"],
      "short_description": "...",
      "extended_description": "...markdown...",
      "images": [{ "file": "separated_bike_lanes/x.png", "alt": "...", "caption": "...", "credit": "..." }],
      "method": "Adapted CAPCOA T-19-A",
      "formula": "ΔVMT% = ...",
      "methodology_detail": "...markdown with inline links...",
      "applicability": { "min_activity_density": 1000, "area_types": ["urban_core","urban"], "warn_message": "..." },
      "inputs": [
        { "key": "pct_parallel_vmt_affected", "label": "...", "control": "slider",
          "min": 0, "max": 30, "step": 1, "scale": 100, "suffix": "%",
          "default": 0.05, "tooltip": "...", "instructions": "...markdown...",
          "benchmark": "...", "prepopulated_from": "annual_bikeable_days_taz" }
      ],
      "notes": "...",
      "_defaults": { "pct_parallel_vmt_affected": 0.05 }   // derived defaults map
    }
  ]
}
```

Only `status: "implemented"` strategies are compiled in; `strategy-catalog/strategies/todo/`
stubs are excluded by `build.py`. As stubs are promoted, they appear here automatically.

## Step 1 — get the JSON into the app

Prefer a static module import over a runtime fetch (type-checked, no network, bundled):

1. Add an npm script that copies the compiled JSON into the app on every dev/build run.
   In `app/package.json`:

   ```jsonc
   "scripts": {
     "sync:catalog": "node scripts/sync-catalog.mjs",
     "predev": "npm run sync:catalog",
     "prebuild": "npm run sync:catalog",
     "pretest": "npm run sync:catalog"
   }
   ```

   `app/scripts/sync-catalog.mjs`:

   ```js
   import { copyFileSync, mkdirSync } from "node:fs";
   import { dirname, resolve } from "node:path";
   const src = resolve("../strategy-catalog/compiled/strategies.json");
   const dst = resolve("src/strategies/catalog.json");
   mkdirSync(dirname(dst), { recursive: true });
   copyFileSync(src, dst);
   console.log(`synced catalog → ${dst}`);
   ```

   (Alternative: point `build.py`'s `OUT_PATH` directly at `app/src/strategies/catalog.json`.
   The copy script keeps the catalog repo and app build decoupled, which is cleaner.)

2. Ensure `app/tsconfig.json` has `"resolveJsonModule": true` and `"esModuleInterop": true`.

3. Commit the synced `catalog.json` (so CI/builds without the sibling folder still work),
   or `.gitignore` it and rely on the prebuild step — pick one and be consistent.

## Step 2 — types + adapter

Add `app/src/strategies/catalog.ts`:

```ts
import catalog from "./catalog.json";
import { STRATEGY_REGISTRY, type StrategyKey } from "./strategies";
import type { StrategyMeta, StrategyInput, StrategyCategoryId } from "./registry";

// ---- Catalog record types (mirror schema/strategy.schema.json) ----
export interface CatalogImage { file: string; alt: string; caption?: string; credit?: string; }
export interface CatalogInput {
  key: string; label: string; control: "slider" | "number" | "select";
  min?: number; max?: number; step?: number; scale?: number; suffix?: string;
  unit?: string; options?: { value: string; label: string }[];
  default: number | string; tooltip?: string; instructions?: string;
  benchmark?: string; prepopulated_from?: string | null;
}
export interface CatalogStrategy {
  id: string; uid: string; name: string; category: string;
  status: "implemented" | "planned" | "not_recommended";
  tags: string[]; short_description: string; extended_description: string;
  images: CatalogImage[]; method: string; formula: string;
  methodology_detail: string;
  applicability: { min_pop_density?: number | null; min_emp_density?: number | null;
    min_activity_density?: number | null; area_types?: string[]; warn_message?: string };
  inputs: CatalogInput[]; notes: string; _defaults: Record<string, number | string>;
}

export const CATALOG = catalog as unknown as {
  categories: { id: string; name: string; css_color_var: string; cap: number | null; image: string }[];
  area_type_thresholds: Record<string, number>;
  tag_catalog: Record<string, string[]>;
  strategies: CatalogStrategy[];
};

// ---- Adapter: CatalogStrategy -> existing StrategyMeta ----
function toInput(i: CatalogInput): StrategyInput {
  const common = { key: i.key, label: i.label,
    source: i.tooltip,          // existing UI shows `source` in the (i) tooltip
    helperText: i.instructions, // now richer markdown; render separately (Step 4)
  };
  if (i.control === "slider")
    return { type: "slider", ...common, min: i.min!, max: i.max!, step: i.step!,
             scale: i.scale, suffix: i.suffix } as StrategyInput;
  if (i.control === "number")
    return { type: "number", ...common, min: i.min, max: i.max, step: i.step, unit: i.unit } as StrategyInput;
  return { type: "select", ...common, options: i.options! } as StrategyInput;
}

export function toMeta(s: CatalogStrategy): StrategyMeta & {
  uid: string; extendedDescription: string; methodologyDetail: string;
  images: CatalogImage[]; tags: string[]; applicability: CatalogStrategy["applicability"];
} {
  return {
    id: s.id as StrategyKey,
    displayName: s.name,
    category: s.category as StrategyCategoryId,
    description: s.short_description,
    method: s.method,
    source: s.methodology_detail,         // legacy field; methods accordion uses methodologyDetail
    formula: s.formula,
    inputs: s.inputs.map(toInput),
    defaults: s._defaults,
    isInduced: s.category === "induced",  // derived; is_induced was dropped from the schema
    // new fields:
    uid: s.uid,
    extendedDescription: s.extended_description,
    methodologyDetail: s.methodology_detail,
    images: s.images,
    tags: s.tags,
    applicability: s.applicability,
  };
}

// Live strategies only, and guard that every implemented strategy has a calc fn.
export const STRATEGIES_FROM_CATALOG = CATALOG.strategies
  .filter((s) => s.status === "implemented")
  .map(toMeta);
```

Then in `registry.ts`, replace the hardcoded `STRATEGIES` array and `CATEGORIES`
with values derived from the catalog (keep the `StrategyMeta`/`StrategyInput`/
`StrategyCategory` type exports and `getStrategy()`; extend `StrategyMeta` with the
new optional fields `uid`, `extendedDescription`, `methodologyDetail`, `images`,
`tags`, `applicability`). `CATEGORIES` maps from `CATALOG.categories`
(`css_color_var` → `cssColorVar`, `image`, etc.). Drop `capLabel` from the type and
compose "<name> combined" in the UI where the cap tooltip is rendered.

Add a vitest guard (extends the existing test suite) so a content/code mismatch
fails CI:

```ts
test("every implemented catalog strategy has a calc fn", () => {
  for (const s of CATALOG.strategies.filter((x) => x.status === "implemented"))
    expect(STRATEGY_REGISTRY[s.id as StrategyKey]).toBeDefined();
});
```

The golden-value tests are unaffected — calc functions and constants don't change.

## Step 3 — markdown rendering

`extended_description`, `methodology_detail`, and per-input `instructions` are
Markdown (with inline links in methodology). Add a renderer:

- `npm i react-markdown remark-gfm` and a small wrapper `<Markdown>` component.
- Render links with `target="_blank" rel="noopener noreferrer"`.
- Content is first-party (from this repo), so XSS risk is low, but still avoid
  `dangerouslySetInnerHTML`; react-markdown sanitizes by default.

If adding a dependency is undesirable, a minimal renderer covering paragraphs,
bold/italic, inline code, links, and lists is sufficient for this content.

## Step 4 — surface the new fields per component

**`DetailView.tsx`**

- Description area: keep `displayName` + `short_description`; add the
  `extendedDescription` Markdown below it in an "About this strategy" block.
- Images: render `images[]` (figure + `caption`, `alt`, small `credit`). If empty,
  fall back to the category image (`CATALOG.categories[].image`); if that's also
  empty, keep the current `CategoryIcon` glyph. Wire this as a helper
  `strategyImage(meta)`.
- Methodology: convert the current static "Methodology" section into a collapsible
  accordion. Render `methodologyDetail` (Markdown, includes citations/links) plus
  the existing `formula-box`. Stop using `meta.source` for display.
- Inputs: today `InputControl` shows `input.source` both as the `(i)` tooltip and as
  the `.src` caption. Split these: `tooltip` stays the short `(i)` hover; render
  `instructions` (Markdown) as expandable help under the control (e.g. a "How do I
  find this?" disclosure). Show `benchmark` as a muted line when present.
- Applicability: compute whether the selected TAZ aggregate meets
  `applicability` and show a warning banner when it doesn't (see Step 5).

**`MethodologyView.tsx`**

- The methods page should reproduce the same methodology content. Replace the
  per-strategy `source` paragraph in `StrategyDoc` with the `methodologyDetail`
  Markdown (and keep the formula). This satisfies the "identical content on the
  methods page" enhancement. The elasticity/defaults tables stay as-is (they read
  `constants.ts`).

**`ShopBody.tsx` / `ProductCard`**

- `ProductCard` already shows `displayName`, `description`, `method` — no change
  needed, though you may add the `uid` as a small label and the category image as a
  card thumbnail when available.

## Step 5 — tag filtering + sorting (picker)

`ShopBody.tsx` currently filters by a single `catFilter` and a free-text `query`.
Add tag filters and sort options alongside them.

**Filter panel (sidebar).** Below the existing Categories list, render the tag
catalog grouped by facet:

```tsx
const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
// CATALOG.tag_catalog: { audience: [...], lever: [...], ... }
```

For each group (`audience`, `lever`, `trip_purpose`, `mode`, `context`) render the
tags as toggle chips. Only show tags that are actually used by at least one live
strategy (compute a `usedTags` set), and show a per-tag count. Toggling adds/removes
from `selectedTags`. Add a "Clear filters" affordance that also clears `selectedTags`.

**Filter semantics.** Combine with the existing category + search filters:

```ts
function matchesTags(s: StrategyMeta, selected: Set<string>): boolean {
  if (selected.size === 0) return true;
  // OR within a facet group, AND across groups.
  const stratTags = new Set(s.tags ?? []);
  for (const [, groupTags] of Object.entries(CATALOG.tag_catalog)) {
    const selectedInGroup = groupTags.filter((t) => selected.has(t));
    if (selectedInGroup.length === 0) continue;            // group not constrained
    if (!selectedInGroup.some((t) => stratTags.has(t)))    // strategy must hit one
      return false;
  }
  return true;
}
```

Rationale: within one facet ("mode": bike OR transit) users want a union; across
facets ("mode": bike AND "audience": employer) they want an intersection. Document
this in the UI (e.g. a one-line hint) so it's predictable.

**Caveat — tags need backfilling.** Only `separated_bike_lanes` currently has tags
populated; the other live strategies have `tags: []`. With AND-across-facets
semantics, an untagged strategy is excluded as soon as any facet is constrained.
Two options: (a) treat missing tags as "no opinion" and don't exclude untagged
strategies (more forgiving while tags are sparse), or (b) keep strict semantics and
backfill tags in the YAML first. Recommend (b) plus a short task to populate `tags`
across the 11 live strategies; until then, expect thin filter results. Flag this to
the catalog owner.

**Sorting.** Add a sort control (`name` A–Z, `category`, and optionally `uid`).
`sort_order` was intentionally dropped from the schema, so sort on `displayName` /
`category` / `uid`. Apply sort after filtering in the `items` memo.

**Result count + empty state.** The existing empty state and "Clear filters" button
already exist; extend the clear handler to reset `selectedTags` and the sort.

## Step 6 — planned vs. implemented in the UI

The compiled JSON contains only `implemented` strategies, so the picker shows just
those. If you later want "coming soon" cards, change `build.py` to also emit
`planned` strategies (or compile the `todo/` folder behind a flag) and render them
disabled in `ProductCard`. Out of scope for the first integration.

## Suggested order of work

1. Sync script + `catalog.json` import + `resolveJsonModule` (Step 1).
2. `catalog.ts` types + adapter; refactor `registry.ts` to derive from it; add the
   calc-fn guard test (Step 2). Ship this first — the app should look identical.
3. Markdown component (Step 3).
4. `DetailView` accordion + extended description + per-input instructions; images
   with category fallback (Step 4).
5. Applicability warning banner (Steps 4–5).
6. `MethodologyView` to `methodologyDetail` (Step 4).
7. Tag filter panel + sorting in `ShopBody` (Step 5).

## Open questions to resolve before/while building

- `catalog.json`: commit it, or generate on prebuild only? (Affects CI without the
  sibling folder.)
- Markdown: add `react-markdown`, or hand-roll a minimal renderer?
- Tag filter when tags are sparse: forgiving (untagged always shown) vs. strict +
  backfill tags first? (Recommend backfill.)
- Category images: `CATALOG.categories[].image` is empty pending art from the team;
  keep the `CategoryIcon` fallback until assets land.
- Cap label: confirm the UI composes "<category name> combined" now that
  `cap_label` is removed from the data.
