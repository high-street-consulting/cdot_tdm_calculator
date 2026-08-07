// The "Add to package" button must always be anchored to an edge of its card.
//
// It has two intended states: side-by-side (impact left, action flush right)
// above the 980px stacking breakpoint, and stacked (impact over action, both
// flush left) at or below it.
//
// The regression this guards: .commit-bar used to rely on flex-wrap to produce
// the stacked state. Between 981px and ~1090px the row was too narrow to fit but
// no media query had kicked in, so it wrapped while .commit-actions still
// right-aligned its contents inside its own box — sized to the help text, not
// the card. The button ended up floating in the middle of the card, aligned to
// nothing. The fix makes the impact column the shrink track and states the
// stack explicitly, so no width is left to improvise.

import { test, expect } from "@playwright/test";
import { STEAMBOAT_TAZS, STRATEGY, gotoArea, selectTazs, openStrategy } from "./helpers";

/** Card padding is 22px; allow a little slack for borders/rounding. */
const FLUSH = 30;
/** Matches the .shop-detail stacking breakpoint in shop.css. */
const STACK_PX = 980;

const WIDTHS = [390, 760, 900, 979, 981, 1024, 1060, 1200, 1680];

test("the commit button stays anchored at every width", async ({ page }) => {
  test.slow();
  await gotoArea(page);
  await selectTazs(page, STEAMBOAT_TAZS);
  await openStrategy(page, STRATEGY.sharrows);

  const bar = page.locator(".commit-bar");
  const button = page.locator(".commit-bar .btn-add");
  await expect(button).toBeVisible();

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    // Let the reflow settle before measuring.
    await page.waitForTimeout(250);

    const b = (await bar.boundingBox())!;
    const btn = (await button.boundingBox())!;
    const insetLeft = Math.round(btn.x - b.x);
    const insetRight = Math.round(b.x + b.width - (btn.x + btn.width));

    // Whichever state applies, the button hugs one edge — never both large,
    // which is precisely the "floating mid-card" failure.
    if (width <= STACK_PX) {
      expect(insetLeft, `at ${width}px the stacked button should be flush left`).toBeLessThanOrEqual(FLUSH);
    } else {
      expect(insetRight, `at ${width}px the button should be flush right`).toBeLessThanOrEqual(FLUSH);
    }
    expect(
      Math.min(insetLeft, insetRight),
      `at ${width}px the button is anchored to neither edge (L=${insetLeft}, R=${insetRight})`,
    ).toBeLessThanOrEqual(FLUSH);

    // And it must stay inside its card.
    expect(insetLeft, `at ${width}px the button overflows the card`).toBeGreaterThanOrEqual(-1);
    expect(insetRight, `at ${width}px the button overflows the card`).toBeGreaterThanOrEqual(-1);
  }
});

// The methodology accordion's chevron. It was typeset as U+2304 "⌄", whose ink
// sits near the bottom of its em box, so the caret looked dropped even though
// flexbox had centred its box exactly. A box-geometry assertion would NOT have
// caught that — every box already shared a centre line — so what is pinned here
// is the cause: the mark is drawn in CSS, with no glyph to sag.
test.describe("Methodology accordion chevron", () => {
  test("is drawn in CSS, not typeset, and flips with the open state", async ({ page }) => {
    await gotoArea(page);
    await selectTazs(page, STEAMBOAT_TAZS);
    await openStrategy(page, STRATEGY.sharrows);

    const chevron = page.locator(".acc-chevron").first();
    await chevron.scrollIntoViewIfNeeded();

    const closed = await chevron.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { text: el.textContent ?? "", border: cs.borderRightWidth, transform: cs.transform };
    });
    // No character to mis-position.
    expect(closed.text.trim()).toBe("");
    expect(closed.border).not.toBe("0px");

    await page.locator(".methodology-accordion > summary").first().click();
    await expect(page.locator(".methodology-accordion")).toHaveAttribute("open", "");
    // Poll: the flip is a .15s transition, so reading the transform the instant
    // the attribute lands still returns the closed matrix.
    await expect
      .poll(() => chevron.evaluate((el) => getComputedStyle(el).transform))
      .not.toBe(closed.transform);
  });
});

// The app shell's banner row. .shop-app is a grid whose footer is pinned by
// number (grid-row: 5), so a conditional banner rendered as a direct child used
// to auto-place into the content row and push <main> down onto the footer —
// they overlapped, and the banner itself was crushed to ~21px with its text
// clipped. Every banner now lives inside .app-banners, which occupies a row of
// its own and collapses to zero when empty.
test.describe("App shell banner row", () => {
  test("a banner never pushes main onto the footer", async ({ page }) => {
    await gotoArea(page);
    const box = async () =>
      page.evaluate(() => {
        const m = document.querySelector(".shop-main-region")!.getBoundingClientRect();
        const f = document.querySelector(".app-footer")?.getBoundingClientRect();
        return { mainBottom: m.bottom, footerTop: f ? f.top : Number.POSITIVE_INFINITY };
      });

    const before = await box();
    expect(before.mainBottom).toBeLessThanOrEqual(before.footerTop + 1);

    // Inject a banner the way the real ones render, then re-measure.
    await page.evaluate(() => {
      const slot = document.querySelector(".app-banners")!;
      const el = document.createElement("div");
      el.className = "inputs-error-banner";
      el.dataset.testInjected = "1";
      el.textContent = "Injected banner for layout assertion";
      slot.appendChild(el);
    });
    await page.waitForTimeout(200);

    const after = await box();
    expect(after.mainBottom).toBeLessThanOrEqual(after.footerTop + 1);
    // And the banner keeps its own height rather than being squeezed away.
    const h = await page.locator("[data-test-injected]").evaluate((el) => el.getBoundingClientRect().height);
    expect(h).toBeGreaterThan(20);
  });
});
