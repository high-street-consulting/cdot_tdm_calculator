# CDOT TDM Calculator

A web-based calculator that estimates the vehicle-miles-traveled (VMT) reduction
of Transportation Demand Management (TDM) strategies for transportation projects
across Colorado, supporting PD 1601 analysis, grant applications, and planning.
Built for the CDOT Office of Innovative Mobility.

**Live:** https://tdm.highstreet.work/

## Repository layout

| Path | What it is |
|---|---|
| `app/` | The calculator: a React + Vite + TypeScript single-page app (ArcGIS Maps SDK for the interactive map). |
| `strategy-catalog/` | TDM strategy **content**: one YAML per strategy + `build.py` that validates and compiles them to `compiled/strategies.json` (the app's data). Closed-form math lives in each YAML's `compute:` block (see [`strategy-catalog/COMPUTE_DSL.md`](strategy-catalog/COMPUTE_DSL.md)). |
| `scripts/` | The Python **calculation engine** (`strategy_calculations.py`) and offline data pipeline: TAZ data prep (`prepare_taz.py`), AGOL publishing (`publish_enriched_taz.py`), and helpers. |
| `report_service/` | Proof-of-concept server-side accessible-PDF export (WeasyPrint). |
| `docs/` | Deployment, methodology, and status docs. |

> **Data lives in a separate private repository.** The travel-model inputs and
> generated artifacts (the old `data/` and `outputs/` trees) are **not** in this
> repo. The web app never needs them — it reads TAZ data from published AGOL
> layers at runtime. Only the offline data pipeline in `scripts/` touches them;
> see [Data pipeline](#data-pipeline) below.

## Prerequisites

- **Node ≥ 22** (repo targets 24; see `app/.nvmrc`) for the web app.
- **Python 3.12** with [`uv`](https://docs.astral.sh/uv/) for the calculation engine and data scripts.

The web app has **no data dependency** — you can clone, build, and run it without
the private data repo.

## The web app

```bash
cd app
npm install
npm run dev        # dev server at http://localhost:5180
npm run build      # production build
npm run build:cf   # production build for Cloudflare / root-served hosts
```

Testing:

```bash
npm test           # unit tests (Vitest)
npm run test:e2e   # cross-browser E2E (Playwright: Blink/Gecko/WebKit, + real
                   # Chrome/Edge when installed). See app/e2e/README.md.
```

The app reads its strategy data from `app/src/strategies/catalog.json`, which is
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
  `scripts/strategy_calculations.py` with a hand-ported TypeScript twin pinned by
  a golden test.

After editing a YAML, recompile and commit the output:

```bash
cd strategy-catalog && python build.py    # -> compiled/strategies.json
```

See the `tdm-strategy` authoring guide and `strategy-catalog/README.md` for the
full workflow, conventions, and the `compute:` DSL reference.

## Data pipeline

The scripts in `scripts/` that regenerate the app's TAZ data layer
(`prepare_taz.py`, `publish_enriched_taz.py`, `transit_metrics_per_taz.py`,
`fetch_background_data.py`) read the private travel-model inputs. Point them at
your local checkout of the private data repo via environment variables (see
`scripts/paths.py`):

```bash
export TDM_DATA_DIR=/path/to/tdm-private-data/data
export TDM_OUTPUTS_DIR=/path/to/tdm-private-data/outputs
```

Both default to `./data` and `./outputs` when unset. Credentials for the Census
API and AGOL publishing go in `.env` (copy `.env.example`). None of this is
needed to run the web app.

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
