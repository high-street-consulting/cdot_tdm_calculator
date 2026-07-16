// Bug regression — VMT-reduction changes must be surfaced in the results.
// Users report the results pane sometimes NOT reflecting configured strategies.
// These tests assert the live basket-bar total and the results page both show a
// real (non-zero) reduction that agrees with each other.

import { test, expect } from "@playwright/test";
import {
  gotoArea, selectTazs, addStrategy, gotoResults, STEAMBOAT_TAZS, STRATEGY,
  basketImpactPct, resultsHeadlinePct, perStrategyRows, baselineVmtK,
} from "./helpers";

test.describe("Bug regression — VMT change surfaced in results", () => {
  test("live basket impact updates when a configured strategy is added (UI-04)", async ({ page }) => {
    await gotoArea(page);
    await selectTazs(page, STEAMBOAT_TAZS);
    // No strategies → 0% impact (the app renders "−0.00", i.e. negative zero).
    expect(Math.abs(await basketImpactPct(page)), "no strategies → 0% impact").toBeLessThan(0.005);

    await addStrategy(page, STRATEGY.sharrows, [["Share of area VMT treated", 25]]);

    // Back on the picker the basket bar must immediately show a reduction.
    await expect
      .poll(() => basketImpactPct(page), { timeout: 15_000, message: "impact should update live" })
      .toBeLessThan(0);
  });

  test("results page reflects the reduction (not zero / not stale)", async ({ page }) => {
    await gotoArea(page);
    await selectTazs(page, STEAMBOAT_TAZS);
    await addStrategy(page, STRATEGY.sharrows, [["Share of area VMT treated", 25]]);

    const barImpact = await basketImpactPct(page);
    expect(barImpact).toBeLessThan(0);

    await gotoResults(page);
    const headline = await resultsHeadlinePct(page);
    expect(headline, "results headline must show the reduction").toBeLessThan(0);
    await expect(perStrategyRows(page)).toHaveCount(1);

    // The results headline must agree with the live basket bar (the core of the
    // "not surfaced correctly" report — a mismatch or zero here is the bug).
    expect(Math.abs(Math.abs(headline) - Math.abs(barImpact))).toBeLessThan(0.05);
  });

  test("hard AGOL failure surfaces a Retry banner (and recovers)", async ({ page }) => {
    await gotoArea(page);

    // Make ONLY the TAZ-attribute fetch fail — not the map/basemap or the
    // map's own hit-test queries. The attribute query (queryTaz.ts) is the
    // one whose outFields include the long attribute columns (e.g. "county"),
    // whereas the map layer only ever queries outFields=["taz_id"]. Match on
    // that signature (URL query string OR POST body) so map load + selection
    // via __cdotSelect (cached geometry) still work.
    const isAttrQuery = (r: import("@playwright/test").Route) => {
      const req = r.request();
      if (!/\/FeatureServer\/0\/query/.test(req.url())) return false;
      const hay = `${req.url()} ${req.postData() ?? ""}`;
      return /county/.test(hay);
    };
    await page.route("**/FeatureServer/0/query**", (r) => {
      if (isAttrQuery(r)) return r.abort();
      return r.continue();
    });

    // Select TAZs via the deterministic hook (same path a map click drives).
    await page.evaluate(() => (window as any).__cdotSelect(["1368", "1369"], "add"));

    // The guard retries (~700ms + 1400ms backoff) before giving up, so allow a
    // generous timeout for the banner to appear.
    await expect(page.getByRole("alert")).toContainText(/Couldn.t load area data/i, {
      timeout: 20_000,
    });

    // Recover: stop failing the attribute query, hit Retry, and confirm the
    // banner clears and the baseline VMT loads (a real number, not a zeroed
    // "not surfaced" result).
    await page.unroute("**/FeatureServer/0/query**");
    await page.getByRole("button", { name: /Retry/ }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect.poll(() => baselineVmtK(page), { timeout: 30_000 }).toBeGreaterThan(0);
  });

  test("adding a second reducing strategy increases the total reduction", async ({ page }) => {
    await gotoArea(page);
    await selectTazs(page, STEAMBOAT_TAZS);

    await addStrategy(page, STRATEGY.sharrows, [["Share of area VMT treated", 25]]);
    const one = Math.abs(await basketImpactPct(page));

    await addStrategy(page, STRATEGY.transitFrequency, [["Frequency change", 100], ["Implementation level", 40]]);
    const two = Math.abs(await basketImpactPct(page));

    expect(two).toBeGreaterThan(one);
  });
});
