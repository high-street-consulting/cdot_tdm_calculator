# Strategy catalog

The source of truth for TDM strategy content in the CDOT TDM Calculator: one
YAML file per strategy, validated against a schema and compiled to a single
JSON the app consumes. This replaces the Google Sheet (which couldn't model
one-strategy-to-many-inputs or hold long-form descriptions and per-input
guidance) and externalizes the metadata currently hardcoded in
`app/src/strategies/registry.ts`.

## Layout

```
strategy-catalog/
  strategies/            one <id>.yaml per live strategy  ← edit these
  strategies/todo/       stubs for not-yet-built strategies (validated, NOT compiled)
  images/                illustrative images/diagrams referenced by strategies
  schema/strategy.schema.json   JSON Schema for a strategy record
  globals.yaml           categories (+ CAPCOA caps), area-type thresholds, tag catalog
  build.py               validate + compile → compiled/strategies.json
  compiled/strategies.json   generated output (do not hand-edit)
```

The 11 files were bootstrapped from `app/src/strategies/registry.ts`; the YAML
is now the source of truth.

## Editing workflow

1. Edit a file in `strategies/` (or copy an existing one to add a strategy).
2. Run `python3 build.py`. It validates every file and rebuilds
   `compiled/strategies.json`, then prints a punch list of blank
   narrative/image/instruction fields still to fill.
3. Commit the YAML change and the regenerated `compiled/strategies.json`.

Validate-only (for CI / pre-commit): `python3 build.py --check` exits non-zero
on any schema or cross-check error.

Dependencies: `pip install pyyaml jsonschema`.

## Stubs (`strategies/todo/`)

`strategies/todo/` holds one stub per strategy from the master spreadsheet that
isn't built yet — `id`, `uid`, `name`, `category`, `status`, `short_description`,
and a `notes` line capturing the spreadsheet's priority tier and methodology
note. The remaining fields are blank.

`build.py` validates these against the schema and flags any `id`/`uid` collision
with a live strategy, but does **not** compile them into `strategies.json`, so
they never reach the app while incomplete. When a stub is ready, fill in its
fields and move the file up from `strategies/todo/` into `strategies/`.

`status` values: `planned` (will be built), `not_recommended` (quantification
not recommended per Handy et al. 2025 or the spreadsheet — kept for the record).
Several stubs already have Python reference implementations in
`scripts/strategy_calculations.py` (noted in their `notes`); those are the
quickest to promote.

Only Must Have (Tier 1) and Nice to Have (Tier 2) strategies are stubbed; the
spreadsheet's "If Possible" (Tier 3) and "None" (Tier 4) rows are intentionally
omitted.

## What goes where

A strategy file holds **content**: identifiers, names, descriptions, images,
the human-readable formula/method/source, references, applicability thresholds,
and the user-facing input definitions (control type, range, default, tooltip,
and the how-to-find-it instructions).

### Computing the math: `compute:` block vs. code

A strategy's VMT-reduction math lives in one of two places, picked by complexity:

- **Closed-form → in the YAML, in a `compute:` block.** If the per-TAZ reduction
  is arithmetic over inputs, named constants, and already-imputed TAZ fields
  (mode share, AVO, parking), put it in an optional `compute:` block. It's the
  executable formula, evaluated **identically** by `scripts/strategy_compute.py`
  (analysis) and `app/src/strategies/computeDsl.ts` (the app) — so the YAML is the
  single source of truth and there's no calc function to write or hand-translate.
  Most strategies are this. See [`COMPUTE_DSL.md`](./COMPUTE_DSL.md)
  for the full grammar (`+ - * /`, comparisons, `and`/`or`/`not`, and
  `clamp`/`min`/`max`/`mean`/`abs`/`if`), the `pool` / `const` / `row_defaults` /
  `let` / `formula` shape, scope precedence, and how imputed fields reach scope.
  `traffic_calming.yaml` and `transit_pass_subsidy.yaml` are good examples.

- **Complex → stays in code.** When the math can't be a formula — a multi-value
  `select` that switches the formula, a select→constant lookup, a dynamic TAZ
  column, or cross-TAZ / spatial work — the calc function stays in
  `scripts/strategy_calculations.py`, is hand-translated to a TypeScript port, and
  is pinned to the Python by a golden test. Today that's `transit_service_expansion`,
  `shared_micromobility`, `lane_mile_addition`, and `park_and_ride`.

Either way, math is matched to a strategy by `id` (must equal the app's
`StrategyKey`): a `compute:` block wins; otherwise the app falls back to the code
registry. Shared constants for the code path stay in
`app/src/strategies/constants.ts` and `scripts/strategy_calculations.py`. The
`method`/`formula`/`methodology_detail` fields hold the human-readable prose in
both cases (they describe the math; the `compute:` block, when present, *is* it).

See `separated_bike_lanes.yaml` for a fully filled-in example (extended
description, per-input instructions, methodology with inline citations/links,
tags, and commented templates for images and applicability). The other 10 files
are seeded with the app's existing data and have blank narrative fields ready to
complete.

## Field reference

The schema (`schema/strategy.schema.json`) is authoritative. Highlights:

- `id` — stable snake_case key; must match the app's `StrategyKey`. Never rename.
- `uid` — human-facing code (TR-01, LU-03). Stable.
- `status` — `implemented` | `planned` | `not_recommended`. Lets the catalog
  hold the full ~68-row master list, including strategies where quantification
  is not recommended, without breaking the app.
- `tags` — controlled-vocabulary filtering (vocabulary in `globals.yaml`).
- `extended_description` — Markdown long-form narrative for the strategy.
- `methodology_detail` — Markdown for the methodology accordion + methods page;
  holds the method explanation, effect sizes, and citations/source links written
  inline as Markdown.
- `images` — files under `images/`; empty falls back to the category image.
- `applicability` — minimum densities / area types; the app warns when a
  selected project area doesn't meet them.
- `inputs[]` — one entry per UI control, each with `tooltip` (short) and
  `instructions` (the paragraph on how to find the value).
- `compute` — optional closed-form math block (`pool`, `const`, `row_defaults`,
  `let`, `formula`). Present ⇒ the app evaluates it (computeDsl) instead of a code
  calc fn. See "Computing the math" above and the skill reference for the grammar.

## How this maps to the planned enhancements

- Unique identifier per strategy → `uid`
- Expanded descriptions → `extended_description`
- Minimum densities + warnings → `applicability`
- Tagging and filtering → `tags` (vocabulary in `globals.yaml`)
- Separating similar strategies / keyword density → one YAML file per
  real-world concept (a strategy that splits becomes multiple files with
  distinct `id`/`uid`, not a single record with aliases)
- Input data guidance → per-input `instructions`
- Strategy sorting → `name` / `category`
- Methodology accordion + canonical link → `methodology_detail` (prose,
  citations, and source links inline as Markdown)
- Per-category-then-per-strategy imagery → `images` with category fallback
- Pre-populated sliders / benchmarks → input `prepopulated_from`, `benchmark`

`is_induced` is intentionally **not** a field: a strategy increases VMT when its
`category` is `induced`, so the app derives that flag from the category.

## Wiring into the app (later, not done here)

`compiled/strategies.json` is shaped to match the app's `StrategyMeta`
(plus a derived `_defaults` map). When ready, `registry.ts` can import the JSON
instead of holding the hardcoded array, and the new fields can drive the
detail/methodology views. This scaffold does not modify any app source.
