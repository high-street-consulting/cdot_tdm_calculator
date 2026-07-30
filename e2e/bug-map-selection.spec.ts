// Bug regression — selecting TAZs on the map.
// Users report this failing in Edge (Blink engine). These tests drive the REAL
// map (canvas hit-test + the Esri search widget), NOT the deterministic test
// hook, so an engine that can't register a map selection fails here — which is
// exactly the reported symptom. Run against the real Edge build with:
//   PW_CHANNELS=1 npx playwright test bug-map-selection --project=msedge

import { test, expect } from "@playwright/test";
import { gotoArea, projectAreaCount, waitForMapIdle } from "./helpers";

test.describe("Bug regression — TAZ map selection (reported broken in Edge)", () => {
  // The click positions below are ABSOLUTE offsets inside the map surface, tuned
  // for a desktop-width map at the default Denver extent. On a phone the Area
  // step stacks and the surface is only ~390x225 (see styles/mobile.css), so
  // those offsets land outside it and Playwright clicks straight through to the
  // area panel underneath. This is desktop geometry, and the reported bug was a
  // desktop-Edge one; phone tap-to-select is covered by mobile-layout.spec.ts,
  // which derives its click point from the measured surface instead.
  test.beforeEach(({ viewport }) => {
    test.skip(
      (viewport?.width ?? Number.MAX_SAFE_INTEGER) <= 760,
      "hard-coded surface offsets assume a desktop-width map",
    );
  });

  test("clicking the map selects a TAZ", async ({ page }) => {
    await gotoArea(page);
    const surface = page.locator(".esri-view-surface").first();
    await expect(surface).toBeVisible();
    await waitForMapIdle(page); // let the (transparent) feature layer settle for hit-test

    // Click mid-map, below the search overlay — at the default Denver extent
    // this is over a TAZ. Uses the real WebGL hit-test path.
    await surface.click({ position: { x: 360, y: 320 } });

    await expect
      .poll(() => projectAreaCount(page), {
        timeout: 15_000,
        message: "a single map click should select exactly one TAZ (the Edge bug)",
      })
      .toBe(1);
  });

  test("shift-click adds a second TAZ", async ({ page }) => {
    await gotoArea(page);
    const surface = page.locator(".esri-view-surface").first();
    await waitForMapIdle(page);
    // Both points are well clear of the search / tool overlays.
    await surface.click({ position: { x: 360, y: 360 } });
    await expect.poll(() => projectAreaCount(page)).toBe(1);
    await surface.click({ position: { x: 640, y: 470 }, modifiers: ["Shift"] });
    await expect.poll(() => projectAreaCount(page)).toBeGreaterThanOrEqual(2);
  });

  test("clicking a selected TAZ again, then Clear selection, empties the set", async ({ page }) => {
    await gotoArea(page);
    const surface = page.locator(".esri-view-surface").first();
    await waitForMapIdle(page);
    await surface.click({ position: { x: 360, y: 320 } });
    await expect.poll(() => projectAreaCount(page)).toBe(1);
    await page.getByRole("button", { name: /Clear selection/ }).click();
    await expect.poll(() => projectAreaCount(page)).toBe(0);
  });

  test("TAZ-ID search surfaces the matching zone (keyboard-accessible discovery)", async ({ page, browserName }) => {
    // The Esri Search widget's text input can't be reliably driven in headless
    // WebKit (keystrokes don't land / suggestions never fetch). This discovery
    // check runs on Blink + Gecko; core selection is covered cross-engine by the
    // canvas-click tests above and the deterministic __cdotSelect hook.
    test.skip(browserName === "webkit", "Esri search input not drivable in headless WebKit");
    // The keyboard-accessible path: typing a TAZ id must surface that exact zone
    // as a suggestion (so a keyboard user can find it). Driving the final
    // click-to-select on the Esri widget's async, self-reflowing suggestion menu
    // is not reliably automatable headless, so the actual selection→results
    // behavior is covered by the canvas-click tests above and the deterministic
    // __cdotSelect hook used throughout the calc/results specs.
    await gotoArea(page);
    const search = page.getByPlaceholder(/Search address, place, or TAZ ID/i);
    await search.click();
    await search.focus();
    // Real keystrokes (not fill) so the Esri widget fires its suggestion fetch.
    await page.keyboard.type("1368", { delay: 120 });
    // The TAZ suggestion is the option whose text is exactly the id (address
    // geocoder results read like "1368 N Bannock St, …").
    await expect(page.getByRole("option", { name: "1368", exact: true })).toBeAttached({ timeout: 15_000 });
  });
});
