// Shared page-object helpers for the CDOT TDM Calculator E2E suite.
//
// TAZ selection uses the deterministic `window.__cdotSelect` hook (same code
// path a map click drives) so the calc/results/exercise tests aren't flaky on
// the WebGL canvas or the Esri search widget. The dedicated selection-bug spec
// uses REAL canvas clicks + the real search widget instead.

import { Page, Locator, expect } from "@playwright/test";

/** Downtown Steamboat Springs — Exercise 1's project area. */
export const STEAMBOAT_TAZS = ["1368", "1369", "1370", "1371", "1380"];

/**
 * Strategy display names (match the picker card aria-label + detail <h1>).
 *
 * Like INPUT below, these are AUTHORED CONTENT from strategy-catalog/strategies/
 * *.yaml `name:`. Keep every spec sourcing names from here — inlined literals
 * are what let a batch of renames go unnoticed.
 */
export const STRATEGY = {
  sharrows: "Striped Bike Lanes, Neighborhood Bikeways and Sharrows",
  /** TR-01. Note: its *id* is transit_service_expansion — not TR-06 below. */
  transitFrequency: "Transit Service Frequency Increase",
  transitPass: "Transit Pass Subsidies",
  transitShelters: "Transit Shelters",
  /** TR-06 new_transit_service. Was "Increased Transit Service". */
  transitServiceExpansion: "Transit Service Expansion",
  /** ID-01. Was "Lane Miles Added (Negative Impact on VMT)"; now covers both
      directions, though the default is still +2 lane-mi (an increase). */
  laneMiles: "Lane Miles Reduced or Lane Miles Added (Induced Demand)",
  traffic_calming: "Traffic Calming",
} as const;

/**
 * Strategy input labels, as rendered in the detail view's <label>.
 *
 * These are AUTHORED CONTENT — they come from each strategy's `inputs[].label`
 * in strategy-catalog/strategies/*.yaml, so a copy edit there renames them.
 * Centralised here (like STRATEGY above) because they were previously inlined
 * across five specs, and one rewording silently broke twelve tests. When a spec
 * fails on a label lookup, diff against the YAML and fix it in this one place.
 */
export const INPUT = {
  /** BP-02 sharrows_bike_lanes → scope_share. (BP-01 uses the same wording.) */
  bikewayVmtShare: "Share of study-area VMT affected by the bikeway",
  /** TR-01 transit_service_expansion → pct_change. */
  transitFrequencyChange: "Frequency change",
  /** TR-01 transit_service_expansion → level_of_implementation. */
  transitFrequencyScope: "Share of area routes with the frequency change",
} as const;

/**
 * Navigate to a hash route WITHOUT reloading if we're already there.
 * page.goto() to the *current* URL reloads the document on WebKit (wiping the
 * in-memory selection/basket) — unlike Chromium/Firefox — so only goto when the
 * target differs, and otherwise rely on the app's client-side routing.
 */
export async function softGoto(page: Page, hashPath: string): Promise<void> {
  if (!page.url().endsWith(hashPath)) await page.goto(hashPath);
}

export async function gotoArea(page: Page): Promise<void> {
  await softGoto(page, "/#/area");
  await waitForMapReady(page);
}

/** Wait until the ArcGIS view is ready and the selection hook is installed. */
export async function waitForMapReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      Boolean((window as unknown as { __cdotView?: { ready?: boolean } }).__cdotView?.ready) &&
      typeof (window as unknown as { __cdotSelect?: unknown }).__cdotSelect === "function",
    undefined,
    { timeout: 60_000 },
  );
}

/** Wait for the ArcGIS view to finish rendering (idle) before hit-testing. */
export async function waitForMapIdle(page: Page): Promise<void> {
  await waitForMapReady(page);
  await page
    .waitForFunction(
      () => {
        const v = (window as unknown as { __cdotView?: { updating?: boolean } }).__cdotView;
        return Boolean(v) && v!.updating === false;
      },
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(500);
}

/** Parse the first number out of a metric cell (handles − U+2212 and commas). */
export async function readNum(loc: Locator): Promise<number> {
  const t = (await loc.textContent()) ?? "";
  const m = t.replace(/[−–]/g, "-").match(/-?[\d,]*\.?\d+/);
  return m ? parseFloat(m[0].replace(/,/g, "")) : NaN;
}

// ── Basket-bar metrics (present on every route) ─────────────────────────────
function totalsVal(page: Page, label: string): Locator {
  return page
    .locator(".basket-bar .totals > div")
    .filter({ hasText: label })
    .locator(".val");
}
export const projectAreaCount = (page: Page) => readNum(totalsVal(page, "Project area"));
export const baselineVmtK = (page: Page) => readNum(totalsVal(page, "Baseline VMT"));
/** Displayed % VMT impact. Reductions render negative ("−0.60"); increases positive. */
export const basketImpactPct = (page: Page) => readNum(totalsVal(page, "Basket impact"));
export const annualReductionM = (page: Page) =>
  readNum(page.locator(".basket-bar .totals > div").filter({ hasText: "Annual" }).locator(".val"));

/**
 * Select the given TAZ ids and wait until their attributes have loaded from
 * AGOL (baseline VMT becomes non-zero). Deterministic — no map click needed.
 */
export async function selectTazs(page: Page, ids: string[]): Promise<void> {
  await waitForMapReady(page);
  await page.evaluate((list) => {
    (window as unknown as { __cdotSelect: (i: string[], m: string) => void }).__cdotSelect(list, "add");
  }, ids);
  await expect.poll(() => projectAreaCount(page), { timeout: 30_000 }).toBe(ids.length);
  await expect.poll(() => baselineVmtK(page), { timeout: 30_000 }).toBeGreaterThan(0);
}

// ── Strategy picker + detail ────────────────────────────────────────────────
/**
 * Go to the strategy list with the map CLOSED. The map is a full-bleed overlay
 * (not a route): navigating by hash alone leaves it open, and its canvas
 * intercepts pointer events over the picker. Clicking the "Strategy selection"
 * workflow step closes the overlay and lands on the list, exactly as a user does.
 */
export async function gotoStrategyList(page: Page): Promise<void> {
  // Load the app if this is the first navigation (some tests call openStrategy
  // as their first action), then close the map overlay via the workflow step.
  if (!page.url().startsWith("http")) await page.goto("/#/strategies");
  await page.locator(".basket-bar .crumb .step").filter({ hasText: "Strategy selection" }).click();
  await expect(page.getByRole("heading", { name: /Select TDM strategies/ })).toBeVisible();
}

/**
 * Ensure the strategy-list filter rail is expanded before touching the category
 * nav or tag facets. At/below RAIL_COLLAPSE_PX (see ShopBody) the rail is a
 * disclosure that starts closed, so its controls are display:none on a phone.
 * No-op at desktop widths, where the rail is always open and has no toggle —
 * which keeps rail-touching specs viewport-agnostic.
 */
export async function openFilterRail(page: Page): Promise<void> {
  const toggle = page.locator(".shop-aside-toggle");
  if ((await toggle.count()) === 0) return;
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.locator(".shop-aside .cat-nav")).toBeVisible();
}

/** Open a strategy's detail/config view from the picker by its display name. */
export async function openStrategy(page: Page, displayName: string): Promise<void> {
  await gotoStrategyList(page);
  const card = page.getByRole("button", { name: new RegExp(escapeRe(displayName)) }).first();
  await card.click();
  await expect(page.getByRole("heading", { level: 1, name: displayName })).toBeVisible();
}

/**
 * Set a strategy input by its visible label. Auto-detects the control:
 *  - range slider → sets the DISPLAY value (e.g. 25 for a 25% slider)
 *  - number field → fills the raw value
 *  - select      → selects by value or label
 */
export async function setInput(page: Page, label: string, value: string | number): Promise<void> {
  // Resolve the control via its <label for=…>, NOT getByLabel — once a value is
  // modified the app shows a reset button whose aria-label also contains the
  // input label (UI-06), which would make getByLabel ambiguous.
  //
  // Anchored + case-sensitive: a plain `hasText` string is a case-INSENSITIVE
  // substring match, so on TR-01 "Frequency change" also matched "Share of area
  // routes with the frequency change" and only resolved correctly because of
  // DOM order. Anchor the start instead of matching the whole string, because the
  // <label> can also contain a trailing "i" info glyph. `(?!\S)` (end, or
  // followed by space) rather than `\b`, so it still works for labels ending in
  // punctuation like "Fare reduction (%)".
  const labelRe = new RegExp(`^\\s*${escapeRe(label)}(?!\\S)`);
  const forId = await page.locator("label").filter({ hasText: labelRe }).first().getAttribute("for");
  const ctrl = page.locator(`[id="${forId}"]`);
  const kind = await ctrl.evaluate((el) => {
    const t = el as HTMLInputElement | HTMLSelectElement;
    if (t.tagName === "SELECT") return "select";
    return (t as HTMLInputElement).type; // "range" | "number" | ...
  });
  if (kind === "select") {
    await ctrl.selectOption(String(value)).catch(async () => {
      await ctrl.selectOption({ label: String(value) });
    });
  } else if (kind === "range") {
    await ctrl.evaluate((el, v) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, String(v));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
  } else {
    await ctrl.fill(String(value));
    await ctrl.dispatchEvent("change");
  }
}

/** Fill the per-input "Source / justification" note (textarea follows the input). */
export async function fillJustification(page: Page, text: string): Promise<void> {
  const note = page.getByLabel(/Source \/ justification/i).first();
  await note.fill(text);
}

/** Click "Add to package" / "Update selection". */
export async function addToPackage(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Add to package|Update selection/ }).click();
  // Committing bounces back to the picker.
  // The strategy list is served at both "/#/" (clean landing) and "/#/strategies".
  await expect(page).toHaveURL(/#\/(strategies)?$/);
}

// ── Results ─────────────────────────────────────────────────────────────────
export async function gotoResults(page: Page): Promise<void> {
  // Use the "Results" workflow step (closes the map overlay), not a hash-only
  // goto that would leave the overlay covering the cart. Enabled once the basket
  // has a strategy (the tests reach here after adding one).
  await page.locator(".basket-bar .crumb .step").filter({ hasText: "Results" }).click();
  await expect(page.getByRole("heading", { name: /Your strategy package/ })).toBeVisible();
}
/** Big headline % on the results page (reduction shows as a negative number).
 *  Read the visible (aria-hidden) glyph span specifically — the .big element
 *  also contains an sr-only "Reduction of 0.70 percent…" phrase whose unsigned
 *  number would otherwise be parsed first. */
export const resultsHeadlinePct = (page: Page) =>
  readNum(page.locator('.cart-hero .big [aria-hidden="true"]').first());
/** Per-strategy contribution rows on the results page. */
export const perStrategyRows = (page: Page) => page.locator(".cart-line");
export const ghgAvoidedText = (page: Page) =>
  page.locator(".co-row").filter({ hasText: /GHG (avoided|increase)/ }).locator(".v");

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Open a strategy, set inputs (by label), optionally justify, and commit it. */
export async function addStrategy(
  page: Page,
  displayName: string,
  inputs: Array<[string, string | number]> = [],
  justification?: string,
): Promise<void> {
  await openStrategy(page, displayName);
  for (const [label, value] of inputs) await setInput(page, label, value);
  if (justification) await fillJustification(page, justification);
  await addToPackage(page);
}

/** Remove a strategy from the package via its detail view. */
export async function removeStrategy(page: Page, displayName: string): Promise<void> {
  await openStrategy(page, displayName);
  await page.getByRole("button", { name: /^Remove$/ }).click();
  // The strategy list is served at both "/#/" (clean landing) and "/#/strategies".
  await expect(page).toHaveURL(/#\/(strategies)?$/);
}
