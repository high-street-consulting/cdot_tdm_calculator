// Exercise 2 — Local Jurisdiction Planner Flow: Comparing & Presenting Outputs.
// "Build two different scenarios, compare the resulting VMT-reduction outputs,
//  and interpret them for a decision-maker."
//
// NOTE: the app has no built-in saved-"scenario" object or side-by-side compare
// (a known gap vs OR-06 charts too), so "comparing scenarios" is exercised as
// two sequential configurations whose results we capture and compare. The test
// asserts the results are distinct, broken out per strategy (OR-02), and that
// geographic context changes the outcome (MC-01 geographic context).

import { test, expect } from "@playwright/test";
import {
  gotoArea, selectTazs, addStrategy, removeStrategy, gotoResults,
  STEAMBOAT_TAZS, STRATEGY, resultsHeadlinePct, perStrategyRows,
} from "./helpers";

// Denver-metro TAZ ids (urban context) to contrast with resort Steamboat.
const DENVER_TAZS = ["7100", "7102", "7813"];

test.describe("Exercise 2 — comparing strategy scenarios", () => {
  test("two strategy combinations produce distinct, per-strategy results", async ({ page }) => {
    await gotoArea(page);
    await selectTazs(page, STEAMBOAT_TAZS);

    // Scenario A — bike-only.
    await addStrategy(page, STRATEGY.sharrows, [["Share of area VMT treated", 25]]);
    await gotoResults(page);
    const scenarioA = Math.abs(await resultsHeadlinePct(page));
    await expect(perStrategyRows(page)).toHaveCount(1);
    expect(scenarioA).toBeGreaterThan(0);

    // Scenario B — transit-only (swap the combination).
    await removeStrategy(page, STRATEGY.sharrows);
    await addStrategy(page, STRATEGY.transitFrequency, [["Frequency change", 100], ["Implementation level", 40]]);
    await gotoResults(page);
    const scenarioB = Math.abs(await resultsHeadlinePct(page));
    await expect(perStrategyRows(page)).toHaveCount(1);
    expect(scenarioB).toBeGreaterThan(0);

    // The two scenarios must be comparable AND distinguishable.
    expect(Math.abs(scenarioA - scenarioB)).toBeGreaterThan(0);
  });

  test("geographic context changes the estimate (same strategy, different area)", async ({ page }) => {
    // Resort context (Steamboat).
    await gotoArea(page);
    await selectTazs(page, STEAMBOAT_TAZS);
    await addStrategy(page, STRATEGY.sharrows, [["Share of area VMT treated", 25]]);
    await gotoResults(page);
    const resort = Math.abs(await resultsHeadlinePct(page));

    // Urban context (Denver). The basket + selection live in in-memory SPA
    // state, so a full reload gives a clean session.
    await page.reload();
    await gotoArea(page);
    await selectTazs(page, DENVER_TAZS);
    await addStrategy(page, STRATEGY.sharrows, [["Share of area VMT treated", 25]]);
    await gotoResults(page);
    const urban = Math.abs(await resultsHeadlinePct(page));

    expect(resort).toBeGreaterThan(0);
    expect(urban).toBeGreaterThan(0);
    // Different underlying TAZ data (VMT, mode share, density) → different result.
    expect(Math.abs(resort - urban)).toBeGreaterThan(0);
  });
});
