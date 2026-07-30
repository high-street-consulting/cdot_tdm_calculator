# CDOT TDM Calculator: Requirements Implementation Status

Status of the web calculator against the **CDOT TDM Calculator Requirements**
document (March 2026, Task Order #12). That document is a client deliverable and
lives in the private data repository, not here; the requirement IDs below
(`DI-05`, `UI-06`, …) are the reference points.

- **Assessed:** 2026-06-30, against `main` (deployed at `high-street.bitbucket.io/cdot_tdm_calculator/`).
- **Legend:** ✅ Implemented · 🟡 Partial / adapted · ⬜ Not yet built · 🔵 External / process task (not app code).

## Headline

The project is **well past the Sprint-1 proof of concept**; it is a working React single-page web application. **Essentially all "Must Have" functional requirements are implemented.** The remaining work is concentrated in: (1) **external compliance** items (third-party accessibility audit + VPAT, CDOT OIT/AWS production hosting), (2) **user-facing documentation** (user guide, quick-start, tutorial video; the in-app Help modal is scaffolded to hold the last two), and (3) a few **Should/Could-Have** enhancements (corridor select-link analysis, presentation charts, save/resume).

---

## User stories (§3)

| ID | Persona | Status | Notes |
|----|---------|--------|-------|
| US-1 | CDOT OIM analyst | ✅ | All acceptance criteria met: map area selection, pre-filled baseline, multiple configurable strategies, individual + combined VMT (% and absolute), PDF report. |
| US-2 | MPO planner | ✅ | CO-specific data, in-tool methodology, GHG estimate, PDF + CSV export all present. |
| US-3 | Local jurisdiction planner | 🟡 | Per-strategy % ✅; geographic context partially applied (area-specific baseline + per-strategy applicability/warnings); **no side-by-side scenario comparison** and **no presentation charts** (OR-06) yet. |

---

## 4.1 User Interface & Experience

| ID | Pri | Status | Notes |
|----|-----|--------|-------|
| UI-01 | Must | ✅ | React SPA, no install, deployed to static hosting. |
| UI-02 | Must | ✅ | ArcGIS map; click / shift-click / draw-area TAZ selection + TAZ-ID search. |
| UI-03 | Must | ✅ (adapted) | Strategies organized by category with a category filter sidebar + cards rather than literal collapsible accordions; the "manage visual complexity" intent is met. |
| UI-04 | Must | ✅ | Live cumulative VMT/% in the basket bar, updates as strategies change. |
| UI-05 | Must | ✅ | Inputs pre-filled from the enriched TAZ layer (ACS mode share, density, baseline VMT, trip length, transit service, AVO). |
| UI-06 | Must | ✅ | Overridable inputs with explicit "modified from default" indication (seeded-defaults comparison). |
| UI-07 | Must | ✅ | "i" info icons with tooltips (input, source, limitations). |
| UI-08 | Could | ⬜ | No save/resume (export-import of in-progress project state). |

## 4.2 Methodology & Calculations

| ID | Pri | Status | Notes |
|----|-----|--------|-------|
| MC-01 | Must | ✅ | ~26 strategies across Transit, Bike/Ped, Land Use, Parking, Supportive, Induced, covering the Methods-Research set incl. all Sprint-1 representatives. |
| MC-02 | Must | ✅ | Each strategy uses its Methods-Research method (effect size / elasticity / induced demand). |
| MC-03 | Must | ✅ | CAPCOA-adapted effect-size formulas, localized with Colorado parameters. |
| MC-04 | Must | ✅ | Elasticities/sources documented per strategy (Handy, CAPCOA, Western States Handbook). |
| MC-01b | Should | 🟡 | Geographic context partially handled: area-specific baseline data + per-strategy `applicability.area_types` and warnings. Not every strategy scales its effect size by context. |
| MC-05 | Should | ✅ | VMT→GHG via MOVES CO blended rate (0.412 kg CO₂e/VMT) in `strategies/ghg.ts`. |
| MC-06 | Should | ⬜ | No corridor-level select-link analysis (corridor definitions not yet provided; see constraints §6.2). |
| MC-07 | Should | ✅ | CAPCOA subsector caps applied per category (`cap` on each category). |

## 4.3 Data & Integration

| ID | Pri | Status | Notes |
|----|-----|--------|-------|
| DI-01 | Must | ✅ | Existing conditions from ACS (B08301 mode share), SWTDM (VMT, trips, trip length, AVO), transit service, density. |
| DI-02 | Must | ✅ | Baseline VMT from the CDOT Statewide Travel Demand Model (currently 2019 SWTDM). **2025 base-year refresh pending** (external, expected summer 2026). |
| DI-03 | Could | 🟡 | Bike-network mileage (`bike_centerline_mi`) present, sourced from CDOT/model rather than OSM. |
| DI-04 | Could | ⬜ | National Zoning Atlas not integrated; land-use inputs are user-supplied / density-based. |
| DI-05 | Must | ✅ | Scripted, repeatable data prep + publish (`scripts/prepare_taz.py`, `publish_enriched_taz.py`). |
| DI-06 | Could | ⬜ | No micromobility-feed integration (RideReport/NABSA); a shared-micromobility *strategy* exists but not the data feed. |

## 4.4 Outputs & Reporting

| ID | Pri | Status | Notes |
|----|-----|--------|-------|
| OR-01 | Must | ✅ | Total VMT reduction as % and absolute. |
| OR-02 | Must | ✅ | Per-strategy contribution broken out (cart + report). |
| OR-03 | Should | ✅ | GHG (t CO₂e/yr) + "cars off-road" co-benefit in cart and report. |
| OR-04 | Must | ✅ | Formatted report with inputs, strategies, methodology refs, results. Accessible PDF/UA via server-side WeasyPrint is a PoC in `report_service/` (production wiring TBD). |
| OR-05 | Should | ✅ | CSV export of results (`data/exportCsv.ts`). |
| OR-06 | Could | ⬜ | No charts/graphics; contributions shown numerically. |

## 4.5 Accessibility & Compliance

| ID | Pri | Status | Notes |
|----|-----|--------|-------|
| AC-01 | Must | 🟡 | Built to accessibility best practices (skip link, ARIA, accessible native-`<dialog>` modals, keyboard selection, accessible PDF approach). **Formal WCAG 2.1/2.2 AA conformance pending the AC-04 audit.** |
| AC-02 | Must | 🟡 | Screen-reader-compatible interface is the chosen path; a phone-based alternative is not established. |
| AC-03 | Must | ✅ | Footer links to the CDOT Accessibility page. |
| AC-04 | Must | 🔵 | Third-party audit + VPAT: not yet conducted (external; budget 1–3 weeks before release). |
| AC-05 | Must | 🔵 | CDOT Communications (F. Michaels) accessibility coordination: process item. |

## 4.6 Documentation & User Guidance

| ID | Pri | Status | Notes |
|----|-----|--------|-------|
| DG-01 | Must | ✅ | In-app tooltips / info icons per input. |
| DG-02 | Must | ✅ | In-app Methodology view + per-strategy method/formula/sources. |
| DG-03 | Should | ⬜ | One-page quick-start not yet written. |
| DG-04 | Should | ⬜ | Full user guide not yet written (in-app Help modal is scaffolded to link to it). |
| DG-05 | Should | ⬜ | 5-minute narrated video not yet produced (Help modal scaffolded to embed it). |
| DG-06 | Should | ✅ | Per-strategy limitations / assumptions / warnings documented for defensibility. |

## 5. Technology Stack

| Area | Status | Notes |
|------|--------|-------|
| React SPA | ✅ | React + Vite + TypeScript. |
| ArcGIS Maps SDK for JS | ✅ | v5; map, geocoder search, spatial query. |
| Calcite Design System | 🟡 | Evaluated; app uses custom CSS + Calcite font tokens rather than full Calcite components. |
| AGOL hosted feature layers | ✅ | Enriched TAZ feature layer + vector tile layer for display. |
| GTFS → hosted service | 🟡 | Transit service attributes baked into the enriched TAZ layer rather than a standalone GTFS-derived service. |
| Pre-computed lookup tables | ✅ | The enriched per-TAZ table is the precomputed input. |
| Hosting (AWS/S3 via CDOT OIT) | ⬜ | Currently on High Street Bitbucket Pages (staging). AWS hosting is documented (`docs/aws-hosting-recommendation.md`) but **production provisioning with CDOT OIT is pending.** |

## 8. Sprint 1: Lo-Fi Proof of Concept

✅ **Complete and superseded.** The Python calculation engine (`scripts/`) validated the methodology for the representative strategies; that engine has since been generalized (closed-form math now lives in the YAML compute DSL, twin-evaluated in Python and TypeScript) and the full web application has been built on top of it.

---

## Remaining work, prioritized

**Required for release (Must-Have / compliance):**
1. **AC-04: Third-party accessibility audit + VPAT** (external; 1–3 wks). Gating for public release.
2. **AC-01 / AC-02: Accessibility remediation** from the audit; settle the non-visual access alternative.
3. **Production hosting** on CDOT OIT AWS/S3 (tech-stack §5.1; coordinate with OIT); currently staging only.
4. **AC-05**: Engage CDOT Communications for the compliance review.
5. **DI-02**: Refresh baseline to the **2025 SWTDM** base year when available (formulas are %-based, so no recalibration expected).

**Strongly desired (Should-Have):**
6. **DG-04 user guide**, **DG-03 quick-start**, **DG-05 tutorial video**: the Help modal is already wired to host the guide link + video.
7. **MC-06 corridor-level select-link analysis**, once CDOT provides corridor definitions.
8. **MC-01b**: broaden geographic-context scaling of effect sizes across more strategies.

**Nice to have (Could-Have):**
9. **OR-06** presentation charts/graphics; **UI-08** save/resume; **DI-04** National Zoning Atlas land-use; **DI-06** micromobility data feeds; **DI-03** OSM bike facilities.
