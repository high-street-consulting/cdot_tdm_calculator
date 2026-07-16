// Exercise 1 — MPO Planner Flow (from the Full Testing & Feedback Plan).
// "You're a planner with the City of Steamboat preparing an MMOF application for
//  the downtown Steamboat Springs area (TAZs 1368, 1369, 1370, 1371, 1380).
//  Select and evaluate two strategies: Striped Bike Lanes/Neighborhood Bikeways/
//  Sharrows, and Transit Service Frequency Increase."
//
// Enriched with the matching requirements: US-1/US-2 acceptance criteria,
// UI-06 (override + justification), DG-02 (methodology in-tool), OR-03 (GHG),
// OR-04/05 (PDF + CSV export), and an input-sensitivity check.

import { test, expect } from "@playwright/test";
import {
  STEAMBOAT_TAZS, STRATEGY, gotoArea, selectTazs, addStrategy, gotoResults,
  resultsHeadlinePct, perStrategyRows, basketImpactPct, annualReductionM, ghgAvoidedText, readNum,
} from "./helpers";

test.describe("Exercise 1 — MPO Planner: Steamboat downtown MMOF", () => {
  test("select area, configure two strategies with justification, review results", async ({ page }) => {
    // 1. Define the project area (US-1: select geographic units).
    await gotoArea(page);
    await selectTazs(page, STEAMBOAT_TAZS);

    // 2. Strategy 1 — Striped Bike Lanes / Bikeways / Sharrows.
    //    Exercise: ~25% of downtown VMT is the realistic max for this context.
    await addStrategy(
      page,
      STRATEGY.sharrows,
      [["Share of area VMT treated", 25]],
      "Lincoln Ave (~50% of VMT) is unsuitable for bikes; ~25% of streets already have "
        + "sharrows/routes; remaining ~25% is the realistic treatable share.",
    );

    // 3. Strategy 2 — Transit Service Frequency Increase.
    //    Exercise: double frequency (100%) on the Yellow Route (~40% of the system).
    await addStrategy(
      page,
      STRATEGY.transitFrequency,
      [["Frequency change", 100], ["Implementation level", 40]],
      "Yellow Route runs every 30 min and is ~40% of the downtown system; a 100% "
        + "frequency increase at 40% implementation ~doubles frequency along that line.",
    );

    // 4. Results (US-1: individual + combined VMT; OR-01/02/03).
    await gotoResults(page);

    const headline = await resultsHeadlinePct(page); // reduction renders negative
    expect(headline, "combined VMT reduction should be a non-zero reduction").toBeLessThan(0);

    // Results headline must agree with the live basket-bar impact (consistency —
    // guards the "VMT change not surfaced" bug).
    const barImpact = await basketImpactPct(page);
    expect(Math.abs(Math.abs(headline) - Math.abs(barImpact))).toBeLessThan(0.05);

    // Per-strategy contributions broken out (OR-02) — both strategies present.
    await expect(perStrategyRows(page)).toHaveCount(2);
    await expect(page.locator(".cart-line").filter({ hasText: "Striped Bike Lanes" })).toBeVisible();
    await expect(page.locator(".cart-line").filter({ hasText: "Transit Service Frequency" })).toBeVisible();

    // OR-01: absolute annual reduction shown too.
    expect(await annualReductionM(page)).toBeGreaterThan(0);

    // OR-03: GHG co-benefit derived from VMT.
    await expect(ghgAvoidedText(page)).toBeVisible();
    expect(await readNum(ghgAvoidedText(page))).toBeGreaterThan(0);

    // OR-04 / OR-05: exportable to PDF and CSV.
    await expect(page.getByRole("button", { name: /Export PDF report/ })).toBeEnabled();
    await expect(page.getByRole("button", { name: /Download CSV/ })).toBeEnabled();
  });

  test("methodology is accessible in-tool for citation (DG-02 / US-2)", async ({ page }) => {
    await page.goto("/#/area");
    await page.getByRole("link", { name: /Methodology/ }).click();
    await expect(page).toHaveURL(/#\/methodology/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("results are sensitive to input changes (US-1 configurable parameters)", async ({ page }) => {
    await gotoArea(page);
    await selectTazs(page, STEAMBOAT_TAZS);

    await addStrategy(page, STRATEGY.sharrows, [["Share of area VMT treated", 25]]);
    await gotoResults(page);
    const strong = Math.abs(await resultsHeadlinePct(page));
    expect(strong).toBeGreaterThan(0);

    // Re-open and dial the treated share down — reduction magnitude must shrink.
    await addStrategy(page, STRATEGY.sharrows, [["Share of area VMT treated", 5]]);
    await gotoResults(page);
    const weak = Math.abs(await resultsHeadlinePct(page));

    expect(weak).toBeLessThan(strong);
    expect(weak).toBeGreaterThan(0);
  });
});
