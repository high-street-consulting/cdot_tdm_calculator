# End-to-end tests (Playwright)

Cross-browser E2E suite for the CDOT TDM Calculator, built from the **Full
Testing & Feedback Plan** (Exercise 1 & 2) and enriched from the **Requirements**
doc, with targeted regressions for two reported bugs.

## Engines

Tests run across the three bundled engines the user base spans, **plus the real
Chrome and Edge builds when they're installed** (auto-detected):

| Playwright project | Engine | Covers | When |
|---|---|---|---|
| `chromium-blink` | Blink | Chrome, Edge, Brave, Opera | always |
| `firefox-gecko` | Gecko | Firefox | always |
| `webkit` | WebKit | Safari | always |
| `chrome` | Blink (real Chrome) | Chrome channel | if installed |
| `msedge` | Blink (real Edge) | **Edge channel** | if installed |

`msedge` exercises the actual Edge build where the "can't select TAZs" bug was
reported. The channel projects auto-add when the browser is found on disk; force
them with `PW_CHANNELS=1`, or disable with `PW_NO_CHANNELS=1` (e.g. in CI).

```bash
npx playwright test --project=msedge   # just the real Edge build
```

## Running

```bash
cd app
npm run test:e2e                       # all specs, all three engines
npm run test:e2e -- --project=chromium-blink   # one engine
npm run test:e2e -- bug-map-selection          # one spec
npm run test:e2e:ui                     # interactive UI mode
npx playwright show-report              # open the last HTML report
```

The suite **hits the live public AGOL services** (`cdot.maps.arcgis.com` /
`services.arcgis.com`), so it needs network access. The dev server is started
automatically by Playwright (`webServer` → `npm run dev` on :5180).

## What's covered

| Spec | Source | Focus |
|---|---|---|
| `smoke.spec.ts` | — | harness sanity (map loads, selection works, per engine) |
| `exercise1.spec.ts` | Testing Plan Ex.1 | MPO/Steamboat flow: select TAZs 1368/69/70/71/80, configure Sharrows + Transit Frequency with justification, review results, GHG, PDF/CSV export, methodology, input sensitivity |
| `exercise2.spec.ts` | Testing Plan Ex.2 | two-scenario compare (per-strategy breakout), geographic-context sensitivity |
| `bug-map-selection.spec.ts` | reported bug | **real** canvas hit-test selection (Edge repro), shift-click, clear, TAZ-ID search discovery |
| `bug-vmt-surfacing.spec.ts` | reported bug | live basket total + results page reflect the reduction, agree, and respond to changes |
| `requirements.spec.ts` | Requirements | UI-03/06/07, DG-01/02, AC-03, navigation |
| `calc-crossref.spec.ts` | Python calc docs | sign convention, subsector caps (MC-07), aggregation, monotonicity |

## Cross-reference to the Python engine

The per-strategy math is already pinned to the Python engine by unit/golden
tests (twin evaluators `scripts/strategy_compute.py` ⇄
`app/src/strategies/computeDsl.ts`, plus `generate_compute_golden.py` for
closed-form strategies and hand-port golden tests for code strategies).
`calc-crossref.spec.ts` validates the **full live pipeline** (AGOL data → TS
engine → display) against the *documented calculation behavior*: the negative-=
reduction sign convention, the CAPCOA subsector caps (read from the compiled
catalog), aggregation consistency (results headline == live basket total), and
monotonic response to inputs.

## Design notes

- **Deterministic selection.** Calc/results/exercise specs select TAZs via the
  `window.__cdotSelect` test hook (installed by `MapView`), which drives the same
  selection path a map click does — so those tests aren't flaky on the WebGL
  canvas or the Esri search widget. The **bug** spec deliberately uses **real**
  canvas clicks + the real search widget to reproduce the reported issue.
- **Map idle.** Canvas hit-tests wait for `view.updating === false`
  (`waitForMapIdle`) before clicking, so a failure means selection is genuinely
  broken (the Edge symptom) rather than a timing artifact.
- **Known gaps surfaced, not hidden.** Exercise 2 notes that the app has no
  saved-scenario object or presentation charts (OR-06) — the test compares two
  sequential configurations instead.
