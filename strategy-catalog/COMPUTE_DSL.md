# The `compute:` DSL — closed-form strategy math

A closed-form strategy puts its VMT-reduction math in a `compute:` block in its
YAML instead of a Python calc function. The block is the **single source of
truth**: one evaluator runs it in both languages — `scripts/strategy_compute.py`
(`run_compute`, for analysis) and `app/src/strategies/computeDsl.ts`
(`runCompute`, in the app) — so the math is authored once and never
hand-translated. `build.py` passes the block through to
`compiled/strategies.json`; the app reads it from `catalog.json` and
`compute.ts` evaluates it (no `STRATEGY_REGISTRY` entry needed).

Use a `compute:` block whenever the per-TAZ reduction is arithmetic over user
inputs, named constants, and already-imputed TAZ fields (mode share, AVO,
parking). **Most strategies are this.** When the math can't be a formula — a
multi-value `select` that switches the formula, a select→constant lookup, a
dynamic TAZ column, or cross-TAZ / spatial work — the strategy stays in code
instead (see the README's *"Computing the math"* section).

## Shape

```yaml
compute:
  pool: all                # base-VMT trip pool: all | commute | recreational | other
  const:                   # named numeric constants (cite sources in methodology_detail)
    min_effect: 0.0025
  row_defaults:            # fallbacks for TAZ fields the app may not carry (e.g. transit_vrh)
    transit_vrh: 0
  let:                     # ordered intermediate bindings; each is a single { name: expr }
    - coverage: "clamp(cov_raw, 0, 1)"
  formula: "-A"            # final expression -> pct_vmt_reduction (negative = reduction)
```

- **`pool`** — which base-VMT trip pool the reduction applies to: `all`,
  `commute`, `recreational`, or `other`.
- **`const`** — named numeric constants. Cite their sources in
  `methodology_detail`.
- **`row_defaults`** — fallback values for TAZ fields the app may not carry on
  every row (e.g. `transit_vrh`); used only where the row lacks the field.
- **`let`** — ordered list of intermediate bindings, each a single
  `{ name: expression }`. Later bindings may reference earlier ones.
- **`formula`** — the final expression; its value is `pct_vmt_reduction`.

## Sign convention

`formula` returns `pct_vmt_reduction`, where **negative = reduction** and
positive = increase (e.g. induced demand). Most strategies negate a positive
effect, e.g. `formula: "-A"`.

## Scope precedence

Names resolve with later sources overriding earlier ones:

```
const  <  row_defaults  <  row (imputed TAZ fields)  <  params (user inputs)  <  let bindings
```

User inputs are keyed by `inputs[].key`.

## Grammar

- **Operators:** `+ - * /`, unary `-`, comparisons `== != < <= > >=`, and
  `and` / `or` / `not` (numeric: true/false → 1/0; truthy iff ≠ 0).
- **Functions:** `clamp(x, lo, hi)`, `min(...)`, `max(...)`, `mean(...)`,
  `abs(x)`, `if(cond, a, b)`.
- Nothing else: no other identifiers, no property access, no host calls — only
  arithmetic over names in scope.

## Imputed TAZ fields

Imputed fields reach scope under the canonical names the Python helpers
produce: `transit_mode_share`, `auto_mode_share`, `bike_mode_share`,
`walk_mode_share`, `avo`. The app builds these in `compute.ts::dslRow` via the
same `imputedModeShare` / `getAvo` helpers as the code path. Imputation stays in
code; the formula only *reads* the result.

## Boolean `select` inputs

For a yes/no `select` input, the host coerces the chosen option string to
`1`/`0`, so reference the input key directly in the formula — e.g.
`a * (1 - brt_covers_all_routes)`.

## Workflow

1. Edit the `compute:` block in the strategy YAML.
2. `python scripts/generate_compute_golden.py` — asserts the block reproduces
   the authoritative Python function **and** writes the app fixture
   `app/src/strategies/__fixtures__/compute_golden.json`.
3. `cd app && npm test` — `computeDsl.test.ts` pins the TS evaluator to that
   fixture.
4. Keep the matching `strategy_*` Python function in
   `scripts/strategy_calculations.py` as the cross-check oracle.
5. `python build.py` to recompile `compiled/strategies.json` (commit it
   alongside the YAML).

## Examples

`traffic_calming.yaml` and `transit_pass_subsidy.yaml` are good, current
strategies to copy from.
