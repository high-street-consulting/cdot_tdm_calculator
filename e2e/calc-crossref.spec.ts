// Cross-reference the app's results against the documented Python calculation
// behavior (scripts/strategy_calculations.py + the compiled catalog):
//   • Sign convention  — reductions are negative; induced demand is positive.
//   • Subsector caps   — combined reduction within a category never exceeds the
//                        documented CAPCOA cap (MC-07).
//   • Aggregation      — the results headline equals the live basket total.
//   • Monotonicity     — a larger implementation level yields a larger reduction.
//
// The per-strategy math itself is already pinned to Python by unit/golden tests
// (twin evaluators + generate_compute_golden). These E2E checks validate the
// full live pipeline (AGOL data → TS engine → display) against those documented
// rules.

import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import {
  gotoArea, selectTazs, addStrategy, gotoResults, STEAMBOAT_TAZS, STRATEGY, INPUT,
  basketImpactPct, resultsHeadlinePct,
} from "./helpers";

// Documented subsector caps (percent), read from the compiled catalog.
const catalog = JSON.parse(readFileSync("src/strategies/catalog.json", "utf8")) as {
  categories: Array<{ id: string; cap: number | null }>;
};
const capFor = (id: string) => catalog.categories.find((c) => c.id === id)?.cap ?? null;

test.describe("Calculation cross-reference (vs. Python calc documentation)", () => {
  test("sign convention: a reduction strategy is negative", async ({ page }) => {
    await gotoArea(page);
    await selectTazs(page, STEAMBOAT_TAZS);
    await addStrategy(page, STRATEGY.sharrows, [[INPUT.bikewayVmtShare, 25]]);
    expect(await basketImpactPct(page), "reduction should render as negative % VMT").toBeLessThan(0);
  });

  test("sign convention: induced demand (added lane miles) is positive", async ({ page }) => {
    await gotoArea(page);
    await selectTazs(page, STEAMBOAT_TAZS);
    // Default 2.0 lane-mi on a major arterial → an INCREASE in VMT.
    await addStrategy(page, STRATEGY.laneMiles, []);
    expect(await basketImpactPct(page), "induced demand should render as a positive % (increase)").toBeGreaterThan(0);
  });

  test("subsector cap: combined transit reduction never exceeds the documented cap", async ({ page }) => {
    const transitCap = capFor("transit");
    expect(transitCap, "transit cap should be documented in the catalog").toBeGreaterThan(0);

    await gotoArea(page);
    await selectTazs(page, STEAMBOAT_TAZS);
    // Stack several transit strategies, pushed high, to probe the cap.
    await addStrategy(page, STRATEGY.transitFrequency, [[INPUT.transitFrequencyChange, 100], [INPUT.transitFrequencyScope, 100]]);
    await addStrategy(page, STRATEGY.transitPass, []);
    await addStrategy(page, STRATEGY.transitShelters, []);
    await addStrategy(page, STRATEGY.transitServiceExpansion, []);

    const magnitude = Math.abs(await basketImpactPct(page));
    expect(magnitude).toBeGreaterThan(0);
    // MC-07: combined within-category reduction is capped.
    expect(magnitude).toBeLessThanOrEqual((transitCap as number) + 0.01);
  });

  test("aggregation + monotonicity: headline == basket total, and grows with input", async ({ page }) => {
    await gotoArea(page);
    await selectTazs(page, STEAMBOAT_TAZS);

    await addStrategy(page, STRATEGY.sharrows, [[INPUT.bikewayVmtShare, 10]]);
    await gotoResults(page);
    const headlineLow = await resultsHeadlinePct(page);
    const barLow = await basketImpactPct(page);
    // Aggregation: results headline agrees with the live basket total.
    expect(Math.abs(Math.abs(headlineLow) - Math.abs(barLow))).toBeLessThan(0.05);

    // Monotonicity: raise the treated share → larger reduction magnitude.
    await addStrategy(page, STRATEGY.sharrows, [[INPUT.bikewayVmtShare, 40]]);
    await gotoResults(page);
    const headlineHigh = Math.abs(await resultsHeadlinePct(page));
    expect(headlineHigh).toBeGreaterThan(Math.abs(headlineLow));
  });
});
