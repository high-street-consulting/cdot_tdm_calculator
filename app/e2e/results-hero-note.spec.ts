// The results headline must describe what actually happened, not the common case.
//
// The hero note used to read "Combined reduction across all VMT, adjusted for
// overlapping impacts" unconditionally — so a single-strategy package claimed an
// overlap adjustment it hadn't made, contradicting the breakdown table below it,
// which shows its "Overlap & cap adjustment" row only when one occurred.

import { test, expect } from "@playwright/test";
import {
  STEAMBOAT_TAZS, STRATEGY, INPUT, gotoArea, selectTazs, addStrategy, gotoResults,
} from "./helpers";

const OVERLAP_CLAUSE = /adjusted for overlapping impacts/i;
const heroNote = (page: import("@playwright/test").Page) => page.locator(".cart-hero .hero-note");
const adjustmentRow = (page: import("@playwright/test").Page) =>
  page.locator(".cart-adjustment-row, .cat-adjustment-row");

test.describe("Results headline", () => {
  test("a single strategy claims no overlap adjustment", async ({ page }) => {
    await gotoArea(page);
    await selectTazs(page, STEAMBOAT_TAZS);
    await addStrategy(page, STRATEGY.sharrows, [[INPUT.bikewayVmtShare, 25]]);
    await gotoResults(page);

    await expect(heroNote(page)).toBeVisible();
    await expect(heroNote(page)).not.toHaveText(OVERLAP_CLAUSE);
    // Nothing to overlap with, so the breakdown agrees.
    await expect(adjustmentRow(page)).toHaveCount(0);
  });

  test("a package that really does overlap keeps the clause", async ({ page }) => {
    await gotoArea(page);
    await selectTazs(page, STEAMBOAT_TAZS);
    // Two transit strategies in one pool, the first pushed hard enough that the
    // dampening clears the 0.005pp materiality threshold. NOTE: at a 100%
    // frequency change these two do not move the total measurably, and both
    // assertions below would pass vacuously — hence 200.
    await addStrategy(page, STRATEGY.transitFrequency, [
      [INPUT.transitFrequencyChange, 200],
      [INPUT.transitFrequencyScope, 100],
    ]);
    await addStrategy(page, STRATEGY.transitPass, []);
    await gotoResults(page);

    await expect(heroNote(page)).toHaveText(OVERLAP_CLAUSE);
    // Asserted positively in both tests, so the headline and the breakdown are
    // pinned to each other without either test being able to pass vacuously.
    await expect(adjustmentRow(page)).toHaveCount(1);
  });

  test("the note tracks reduction vs increase", async ({ page }) => {
    await gotoArea(page);
    await selectTazs(page, STEAMBOAT_TAZS);
    // Induced demand only: the package INCREASES VMT.
    await addStrategy(page, STRATEGY.laneMiles, []);
    await gotoResults(page);

    await expect(heroNote(page)).toHaveText(/Combined increase across all VMT/i);
    await expect(heroNote(page)).not.toHaveText(/Combined reduction/i);
  });
});
