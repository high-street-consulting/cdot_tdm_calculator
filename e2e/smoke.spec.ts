import { test, expect } from "@playwright/test";
import { gotoArea, selectTazs, STEAMBOAT_TAZS, projectAreaCount, baselineVmtK } from "./helpers";

// Harness sanity check: dev server up, ArcGIS view ready, selection hook works,
// TAZ attributes load from AGOL. If this fails, the rest of the suite can't run.
test("harness: map loads and TAZ selection populates baseline VMT", async ({ page }) => {
  await gotoArea(page);
  await selectTazs(page, STEAMBOAT_TAZS);
  expect(await projectAreaCount(page)).toBe(STEAMBOAT_TAZS.length);
  expect(await baselineVmtK(page)).toBeGreaterThan(0);
});
