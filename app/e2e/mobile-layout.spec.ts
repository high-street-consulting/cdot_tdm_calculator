// Narrow-viewport layout guards.
//
// The app is desktop-first: every view is a fixed rail beside a flexible pane,
// and those only collapse below the breakpoints in styles/mobile.css. These
// tests pin the things that were actually broken on a phone:
//
//   • the Area step's 360px rail left the map a 15-50px sliver — the pane
//     covered the map;
//   • the header ran Methodology / Data sources / Help off the right edge, and
//     an ancestor's overflow:hidden meant they could not be scrolled to;
//   • the basket bar clipped its whole four-metric strip;
//   • the footer nowrap-ellipsised away the Accessibility and Source code links.
//
// Only meaningful at phone widths, so they skip on the desktop projects. Run
// them with: npx playwright test mobile-layout --project=mobile-chrome

import { test, expect, type Page, type Locator } from "@playwright/test";
import {
  gotoArea, gotoStrategyList, selectTazs, waitForMapIdle, projectAreaCount, STEAMBOAT_TAZS,
} from "./helpers";

/** Width at/below which mobile.css stacks the Area step (see that file). */
const AREA_STACK_PX = 760;

test.beforeEach(({ viewport }) => {
  test.skip(
    (viewport?.width ?? Number.MAX_SAFE_INTEGER) > AREA_STACK_PX,
    "narrow-viewport layout only",
  );
});

type Box = { x: number; y: number; width: number; height: number };

async function box(loc: Locator): Promise<Box> {
  const b = await loc.boundingBox();
  if (!b) throw new Error("element has no box (not rendered)");
  return b;
}

/** Viewport width, for "is this on screen" assertions. */
function vw(page: Page): number {
  return page.viewportSize()!.width;
}

/** Fails if the element extends past either edge of the viewport. */
async function expectWithinViewport(page: Page, loc: Locator, label: string) {
  const b = await box(loc);
  expect(Math.round(b.x), `${label} starts off the left edge`).toBeGreaterThanOrEqual(-1);
  expect(Math.round(b.x + b.width), `${label} runs past the right edge`).toBeLessThanOrEqual(
    vw(page) + 1,
  );
}

test.describe("Area step", () => {
  test("the map is full-bleed on top and keeps the larger share of the step", async ({
    page,
  }) => {
    await gotoArea(page);

    const overlay = await box(page.locator(".map-overlay"));
    const map = await box(page.locator(".map-overlay > .map-host"));
    const panel = await box(page.locator(".map-overlay > .area-panel"));

    // The regression: a 360px rail beside the map left it 15-50px wide.
    expect(Math.round(map.width), "map should span the overlay").toBe(
      Math.round(overlay.width),
    );
    expect(map.height, "map needs usable height").toBeGreaterThanOrEqual(200);

    // Map first, panel below it — the map is the instrument of this step.
    expect(map.y, "map should sit above the panel").toBeLessThan(panel.y);
    expect(
      map.height,
      "the panel must not take more of the step than the map",
    ).toBeGreaterThanOrEqual(panel.height);
  });

  test("the 'Select strategies' CTA stays on screen without scrolling the panel", async ({
    page,
  }) => {
    await gotoArea(page);
    const cta = page.locator(".area-panel .btn-next");
    const panel = page.locator(".map-overlay > .area-panel");

    // The panel is capped, so its intro copy genuinely overflows — which is what
    // makes the sticky footer necessary rather than incidental.
    const scroll = await panel.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(scroll.scrollHeight, "panel content should overflow").toBeGreaterThan(
      scroll.clientHeight,
    );
    expect(
      await page.locator(".area-panel > .cta").evaluate((el) => getComputedStyle(el).position),
      "CTA should be pinned, not just last in the panel",
    ).toBe("sticky");

    // Visible at rest, and still visible after the panel is scrolled.
    await expect(cta).toBeInViewport();
    await expectWithinViewport(page, cta, "Select strategies button");
    await panel.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(cta).toBeInViewport();

    // And it still works: enabled once an area is selected.
    await expect(cta).toBeDisabled();
    await selectTazs(page, STEAMBOAT_TAZS);
    await expect(cta).toBeEnabled();
    await expect(cta).toBeInViewport();
  });

  test("every map tool is reachable in the bottom strip", async ({ page }) => {
    await gotoArea(page);
    const tools = page.locator(".map-tools-overlay .map-tool");
    const n = await tools.count();
    expect(n).toBeGreaterThan(0);

    const map = await box(page.locator(".map-overlay > .map-host"));
    for (let i = 0; i < n; i++) {
      const tool = tools.nth(i);
      const label = (await tool.textContent())?.trim() ?? `tool ${i}`;
      // The strip scrolls horizontally rather than stacking into the map.
      await tool.scrollIntoViewIfNeeded();
      await expectWithinViewport(page, tool, `map tool "${label}"`);
      const b = await box(tool);
      expect(b.height, `map tool "${label}" touch target`).toBeGreaterThanOrEqual(40);
      expect(
        b.y + b.height,
        `map tool "${label}" should stay inside the map`,
      ).toBeLessThanOrEqual(map.y + map.height + 1);
    }

    // The search box shares the map: it must not collapse (app.css caps it at
    // calc(100vw - 460px), which goes negative at phone widths).
    const search = page.locator(".map-search-host");
    expect((await box(search)).width, "map search box width").toBeGreaterThan(180);
  });

  test("tapping the map selects a TAZ", async ({ page }) => {
    // The real WebGL hit-test on a phone-sized map — the counterpart to
    // bug-map-selection.spec.ts, which skips narrow viewports because its click
    // offsets assume a desktop-width surface. Derive the point from the measured
    // surface so it stays inside the map whatever share the stacked layout gives.
    await gotoArea(page);
    const surface = page.locator(".esri-view-surface").first();
    await waitForMapIdle(page);
    const b = await box(surface);
    await surface.click({
      position: { x: Math.round(b.width / 2), y: Math.round(b.height / 2) },
    });
    await expect
      .poll(() => projectAreaCount(page), {
        timeout: 15_000,
        message: "a tap mid-map should select exactly one TAZ",
      })
      .toBe(1);
  });
});

test.describe("App chrome", () => {
  test("header nav and Help are all on screen and clickable", async ({ page }) => {
    await gotoArea(page);

    for (const name of ["Calculator", "Methodology", "Data sources"]) {
      const item = page.locator(".hdr-nav").getByText(name, { exact: true });
      await expect(item).toBeVisible();
      await expectWithinViewport(page, item, `nav item "${name}"`);
    }
    const help = page.locator(".hdr-help");
    await expect(help).toBeVisible();
    await expectWithinViewport(page, help, "Help button");

    // Reachable in practice, not just positioned on screen.
    await page.locator(".hdr-nav").getByText("Methodology", { exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: /Methodology/i })).toBeVisible();
  });

  test("basket bar shows all four project metrics", async ({ page }) => {
    await gotoArea(page);
    await selectTazs(page, STEAMBOAT_TAZS);

    // The whole strip used to be clipped off the right edge by the crumb.
    for (const label of [
      "Project area",
      "Baseline VMT",
      "Basket impact",
      "Annual",
    ]) {
      const metric = page
        .locator(".basket-bar .totals > div")
        .filter({ hasText: label })
        .first();
      await expect(metric).toBeVisible();
      await expectWithinViewport(page, metric, `metric "${label}"`);
    }

    // The three workflow steps stay reachable: the crumb scrolls instead of
    // clipping whatever doesn't fit.
    const step3 = page.locator(".basket-bar .crumb .step").filter({ hasText: "Results" });
    await step3.scrollIntoViewIfNeeded();
    await expectWithinViewport(page, step3, "Results step");
  });

  test("footer keeps the Accessibility and Source code links", async ({ page }) => {
    await gotoArea(page);
    for (const name of ["Accessibility", "Source code", "High Street"]) {
      const link = page.locator(".app-footer").getByRole("link", { name });
      await expect(link).toBeVisible();
      await expectWithinViewport(page, link, `footer link "${name}"`);
    }

    // toBeVisible() is satisfied by ellipsised text, so assert the halves aren't
    // clipping: the one-line footer nowrapped and cut both of them off.
    for (const half of [".app-footer-left", ".app-footer-right"]) {
      const clipped = await page.locator(half).evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(clipped, `${half} is truncating its text`).toBeLessThanOrEqual(0);
    }
  });

  test("no view scrolls the page sideways", async ({ page }) => {
    const overflow = () =>
      page.evaluate(() => {
        const de = document.documentElement;
        return de.scrollWidth - de.clientWidth;
      });

    await gotoArea(page);
    expect(await overflow(), "Area step").toBeLessThanOrEqual(0);

    await selectTazs(page, STEAMBOAT_TAZS);
    await gotoStrategyList(page);
    expect(await overflow(), "Strategy list").toBeLessThanOrEqual(0);

    await page.locator(".hdr-nav").getByText("Methodology", { exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: /Methodology/i })).toBeVisible();
    expect(await overflow(), "Methodology").toBeLessThanOrEqual(0);
  });
});

test.describe("Strategy list", () => {
  test("filter rail collapses so strategy cards are above the fold", async ({ page }) => {
    await gotoArea(page);
    await selectTazs(page, STEAMBOAT_TAZS);
    await gotoStrategyList(page);

    const toggle = page.locator(".shop-aside-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Collapsed: the ~550px of categories and tag facets are out of the layout
    // AND out of the a11y tree, so cards are the first thing on screen.
    const cats = page.locator(".shop-aside .cat-nav");
    await expect(cats).toBeHidden();
    await expect(page.locator(".product-card").first()).toBeInViewport();

    // Expanding reveals them and reports state.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(cats).toBeVisible();

    // Choosing a category filters, and the badge counts what's hidden when the
    // rail is closed again.
    await page.locator(".shop-aside .cat-nav button").nth(1).click();
    await toggle.click();
    await expect(page.locator(".shop-aside-badge")).toHaveText("1 active");
  });
});
