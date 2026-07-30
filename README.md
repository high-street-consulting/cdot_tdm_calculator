# CDOT TDM Calculator

A web-based calculator that estimates the vehicle-miles-traveled (VMT) reduction
of Transportation Demand Management (TDM) strategies for transportation projects
across Colorado, supporting PD 1601 analysis, grant applications, and planning.
Built for the CDOT Office of Innovative Mobility.

**Live:** https://tdm.highstreet.work/

## Repository layout

The calculator **is** this repository — `src/`, `public/`, `e2e/` and the build
config sit at the root, so `npm install && npm run dev` works from a fresh clone
with no subdirectory to descend into.

| Path | What it is |
|---|---|
| `src/`, `index.html` | The calculator: a React + Vite + TypeScript single-page app (ArcGIS Maps SDK for the interactive map). |
| `e2e/` | Playwright end-to-end suite (desktop engines + phone viewports). |
| `scripts/` | Build-time Node scripts: catalog sync and third-party licence generation. |
| `strategy-catalog/` | TDM strategy **content**: one YAML per strategy + `build.py` that validates and compiles them to `compiled/strategies.json` (the app's data). Closed-form math lives in each YAML's `compute:` block (see [`strategy-catalog/COMPUTE_DSL.md`](strategy-catalog/COMPUTE_DSL.md)). |
| `methods/` | The Python **calculation engine** (`strategy_calculations.py`, `strategy_compute.py`) that the TypeScript port is validated against, plus the golden-fixture generators. |
| `report_service/` | Proof-of-concept server-side accessible-PDF export (WeasyPrint). |
| `docs/` | Deployment, methodology, and status docs — including [`docs/app-architecture.md`](docs/app-architecture.md), the app's design decisions and known issues. |

> **The data pipeline lives in a separate private repository.** The travel-model
> inputs, the generated artifacts (`data/`, `outputs/`) and the offline scripts
> that build and publish the TAZ layer are **not** here. The app never needs
> them — it reads TAZ data from published AGOL layers at runtime.
>
> The one seam runs the other way: the publishing script in that repo reads this
> app's `TAZ_FIELDS` list out of `src/data/queryTaz.ts` to decide which
> attributes to publish, so the hosted layer can never drift from what the app
> queries. Point its `$TDM_APP_DIR` at a checkout of this repo.

## Prerequisites

- **Node ≥ 22** (repo targets 24; see `.nvmrc`) for the web app.
- **Python 3.12** with [`uv`](https://docs.astral.sh/uv/) for the calculation engine in `methods/`.

The web app has **no data dependency** — you can clone, build, and run it without
the private data repo.

## The web app

```bash
npm install
npm run dev        # dev server at http://localhost:5180
npm run build      # production build
npm run build:cf   # production build for Cloudflare / root-served hosts
```

Testing:

```bash
npm test           # unit tests (Vitest)
npm run test:e2e   # cross-browser E2E (Playwright: Blink/Gecko/WebKit, + real
                   # Chrome/Edge when installed). See e2e/README.md.
```

The app reads its strategy data from `src/strategies/catalog.json`, which is
synced from `strategy-catalog/compiled/strategies.json` automatically before
dev/build/test (the `sync:catalog` npm script). The compiled catalog and the
golden fixtures are committed, so the app builds and its tests pass on a bare
checkout of this repo alone.

## Strategy catalog & calculation engine

A strategy lives in **two places** kept in sync by its stable `id`:

- **Content**: `strategy-catalog/strategies/<id>.yaml` (names, descriptions,
  UI inputs, and, for closed-form strategies, the `compute:` block).
- **Math**: the `compute:` block (evaluated identically in Python and the app),
  or, for complex strategies, a Python calc function in
  `methods/strategy_calculations.py` with a hand-ported TypeScript twin pinned by
  a golden test.

After editing a YAML, recompile and commit the output:

```bash
cd strategy-catalog && python build.py    # -> compiled/strategies.json
```

See the `tdm-strategy` authoring guide and `strategy-catalog/README.md` for the
full workflow, conventions, and the `compute:` DSL reference.

## Data pipeline

The offline pipeline that builds and publishes the TAZ layer lives in the
**private data repository**, not here — it needs the travel-model inputs, which
are not public. That covers `prepare_taz.py`, `publish_enriched_taz.py`,
`transit_metrics_per_taz.py` and `fetch_background_data.py`.

Nothing in this repository depends on it: the compiled catalog and the golden
fixtures are committed, so a bare checkout builds, runs and tests on its own.

The dependency runs the other way. `publish_enriched_taz.py` reads the
`TAZ_FIELDS` array out of `src/data/queryTaz.ts` and publishes exactly those
attributes, so the hosted layer cannot carry fields the app does not read, nor
omit ones it does. Point that script at a checkout of this repo:

```bash
export TDM_APP_DIR=/path/to/cdot-tdm-calculator
```

Adding a field to `TAZ_FIELDS` therefore requires a republish before the app can
read it — the publish script fails loudly if the assembled table can't satisfy
the contract.

## Deployment

Production is **Cloudflare Pages** (`tdm.highstreet.work`). The app is a static
build with no server-side or data dependency, so it can be built and deployed
straight from this repo (Cloudflare Pages Git integration, a CI workflow, or a
manual `npm run build:cf` + upload). The long-term target is an on-prem IIS host
(static file copy). See [`docs/deployment.md`](docs/deployment.md) for the full
hosting matrix and IIS handoff.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).

Copyright 2026 Colorado Department of Transportation. Built for the CDOT Office
of Innovative Mobility by High Street Consulting Group and Felsburg Holt &
Ullevig.

### Third-party dependencies

The Apache-2.0 grant above covers the code in this repository. It does **not**
extend to the dependencies this project builds against, some of which are not
open source:

- **Esri** — `@arcgis/core` and the Calcite component library are proprietary,
  licensed under the [Esri Master License Agreement](https://www.esri.com/en-us/legal/terms/full-master-agreement),
  not an OSI-approved license. They are referenced rather than vendored, but you
  need appropriate Esri entitlement to build or run this project, and any bundle
  you distribute contains them and must carry their copyright notice.
- **amCharts 5** — reaches the built bundle transitively through `@arcgis/core`,
  under a "linkware" license: free to redistribute provided its LICENSE text
  ships with the distribution and its branding link is not hidden or altered.

`public/THIRD-PARTY-LICENSES.txt` carries the full notices for every package
compiled into the distributable. It is regenerated on every build
(`npm run licenses:third-party`) so it cannot drift from `package.json`, is
served at `/THIRD-PARTY-LICENSES.txt` on any deployment, and is included in the
IIS handoff package.

### Trademarks

Apache-2.0 grants no trademark rights (see section 6 of the license). The
Colorado Department of Transportation name, the CDOT logo
(`public/cdot_logo.png` and the favicons derived from it), and the marks of
the contributing firms are **excluded from this license**. Forks and derivative
works must remove or replace CDOT branding unless separately authorized by CDOT.
