// The Esri Search widget's Calcite input is a fixed 28px and does not stretch,
// so a taller host row left it top-aligned with dead space beneath — and on
// focus its 2px ring drew a short box floating inside the bar. app.css sizes the
// row to the control instead. These assertions pin that, and pin the reason the
// obvious alternative fix was rejected.

import { test, expect } from "@playwright/test";
import { gotoArea, waitForMapIdle } from "./helpers";

test.describe("Map search widget", () => {
  test("the Calcite input sits flush in the row, not top-aligned", async ({ page }) => {
    await gotoArea(page);
    await waitForMapIdle(page);
    const m = await page.evaluate(() => {
      const host = document.querySelector(".map-search-host") as HTMLElement;
      const ac = host.querySelector("calcite-autocomplete") as unknown as { shadowRoot: ShadowRoot };
      const inner = ac.shadowRoot.querySelector("calcite-input") as unknown as { shadowRoot: ShadowRoot };
      const input = inner.shadowRoot.querySelector("input") as HTMLElement;
      const h = host.getBoundingClientRect();
      const i = input.getBoundingClientRect();
      return { gapTop: i.top - h.top, gapBottom: h.bottom - i.bottom, hostH: h.height };
    });
    // Was 1px above / 5px below. Symmetry is the whole fix.
    expect(Math.abs(m.gapTop - m.gapBottom)).toBeLessThanOrEqual(0.5);
    // WCAG 2.2 AA 2.5.8 Target Size (Minimum) is 24x24.
    expect(m.hostH).toBeGreaterThanOrEqual(24);
  });

  test("the active-suggestion indicator is still driven by --calcite-color-focus", async ({ page }) => {
    // Guards the rejected fix: zeroing this token on .map-search-host would tidy
    // the input's focus ring AND silently make keyboard navigation of the
    // suggestions menu invisible, because an active item changes only its
    // outline — not its background.
    await gotoArea(page);
    await waitForMapIdle(page);
    const styles = await page.evaluate(async () => {
      const ac = document.querySelector(".map-search-host calcite-autocomplete") as unknown as
        { appendChild: (n: Node) => void; open: boolean };
      const item = document.createElement("calcite-autocomplete-item") as HTMLElement & { active: boolean };
      item.setAttribute("label", "probe");
      item.setAttribute("value", "probe");
      ac.appendChild(item);
      ac.open = true;
      await new Promise((r) => setTimeout(r, 400));
      const read = () => {
        const c = (item as unknown as { shadowRoot: ShadowRoot }).shadowRoot.querySelector("div.container")!;
        const cs = getComputedStyle(c);
        return { outline: `${cs.outlineStyle} ${cs.outlineWidth}`, bg: cs.backgroundColor };
      };
      const inactive = read();
      item.active = true;
      item.setAttribute("active", "");
      await new Promise((r) => setTimeout(r, 250));
      const active = read();
      item.remove();
      return { inactive, active };
    });
    expect(styles.inactive.outline).toContain("none");
    expect(styles.active.outline).toContain("solid");
    // The background does NOT change — the outline is the only cue.
    expect(styles.active.bg).toBe(styles.inactive.bg);
  });
});
