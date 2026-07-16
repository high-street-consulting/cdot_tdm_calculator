// Enriched checks drawn from the Requirements doc (beyond the exercise scripts):
// UI-06 override indication, UI-07 info tooltips, OR-01/02 outputs, AC-03
// accessibility link, DG-01 in-app help, DG-02 methodology, plus the data-sources
// page. These are cross-engine so browser-specific UI regressions surface.

import { test, expect } from "@playwright/test";
import { gotoArea, selectTazs, openStrategy, setInput, STEAMBOAT_TAZS, STRATEGY } from "./helpers";

test.describe("Requirements — UI / outputs / accessibility / docs", () => {
  test("UI-06: overriding a default shows a clear 'modified' affordance", async ({ page }) => {
    await gotoArea(page);
    await selectTazs(page, STEAMBOAT_TAZS);
    await openStrategy(page, STRATEGY.sharrows);
    // No reset control before the value is changed…
    const reset = page.getByRole("button", { name: /Reset Share of area VMT treated to default/i });
    await expect(reset).toHaveCount(0);
    await setInput(page, "Share of area VMT treated", 25);
    // …and it appears once the value differs from the default.
    await expect(reset).toBeVisible();
  });

  test("UI-07: inputs carry contextual info tooltips", async ({ page }) => {
    await openStrategy(page, STRATEGY.transitFrequency);
    const info = page.locator(".info-i[data-tip]").first();
    await expect(info).toBeAttached();
    expect((await info.getAttribute("data-tip"))?.length ?? 0).toBeGreaterThan(0);
  });

  test("DG-01: header Help opens the Help & resources modal", async ({ page }) => {
    await page.goto("/#/area");
    await page.getByRole("button", { name: /Help/ }).click();
    await expect(page.getByRole("heading", { name: /Help & resources/ })).toBeVisible();
  });

  test("DG-02 / navigation: Methodology and Data sources pages load", async ({ page }) => {
    await page.goto("/#/area");
    await page.getByRole("link", { name: /Methodology/ }).click();
    await expect(page).toHaveURL(/#\/methodology/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    await page.getByRole("link", { name: /Data sources/ }).click();
    await expect(page).toHaveURL(/#\/data/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("AC-03: footer links to the CDOT accessibility page", async ({ page }) => {
    await page.goto("/#/strategies");
    const link = page.getByRole("link", { name: /Accessibility/ });
    await expect(link).toHaveAttribute("href", /codot\.gov\/.*accessibility/i);
  });

  test("UI-03: strategies are organized by category (picker filter)", async ({ page }) => {
    await page.goto("/#/strategies");
    // Category chips in the sidebar act as filters.
    await expect(page.locator(".cat-nav button").first()).toBeVisible();
    const before = await page.locator(".product-card").count();
    await page.locator(".cat-nav button").filter({ hasText: /Transit/ }).first().click();
    const after = await page.locator(".product-card").count();
    expect(after).toBeLessThanOrEqual(before);
    expect(after).toBeGreaterThan(0);
  });
});
