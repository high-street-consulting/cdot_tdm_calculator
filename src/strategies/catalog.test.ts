// Guards that the strategy catalog (content) and the calc-fn registry (code)
// stay in sync. A content/code mismatch fails CI here rather than at runtime.
// The golden-value tests in strategies.test.ts are unaffected; calc functions
// and constants don't change.

import { describe, test, expect } from "vitest";
import { CATALOG, STRATEGIES_FROM_CATALOG } from "./catalog";
import { STRATEGY_REGISTRY } from "./strategies";
import { AGGREGATE_REGISTRY } from "./aggregates";
import { isKnownStrategy } from "./registry";

const REGISTRY = STRATEGY_REGISTRY as Record<string, unknown>;

describe("strategy catalog ↔ calc-fn registry", () => {
  const implemented = CATALOG.strategies.filter((s) => s.status === "implemented");

  test("every implemented catalog strategy is computable (calc fn, compute block, or aggregate fn)", () => {
    for (const s of implemented) {
      const hasCalcFn = REGISTRY[s.id] !== undefined;
      const hasCompute = s.compute != null;
      const hasAggregate = s.id in AGGREGATE_REGISTRY;
      expect(
        hasCalcFn || hasCompute || hasAggregate,
        `implemented strategy "${s.id}" has no calc fn, compute block, or aggregate fn`,
      ).toBe(true);
    }
  });

  // Regression: the detail route validates ids via isKnownStrategy (catalog),
  // NOT STRATEGY_REGISTRY. A registry-backed check would bounce every
  // closed-form strategy back to the list. Every implemented strategy must be
  // routable.
  test("every implemented strategy is detail-routable (isKnownStrategy)", () => {
    for (const s of implemented) {
      expect(isKnownStrategy(s.id), `"${s.id}" is not routable`).toBe(true);
    }
  });

  test("every strategy tag is in the controlled vocabulary", () => {
    const vocab = new Set(Object.values(CATALOG.tag_catalog).flat());
    for (const s of implemented) {
      for (const t of s.tags) {
        expect(vocab.has(t), `tag "${t}" on "${s.id}" not in tag_catalog`).toBe(true);
      }
    }
  });

  test("every input default is consistent with its control", () => {
    for (const s of implemented) {
      for (const i of s.inputs) {
        if (i.control === "select") {
          const values = (i.options ?? []).map((o) => o.value);
          expect(values, `${s.id}.${i.key}`).toContain(i.default);
        } else {
          expect(typeof i.default, `${s.id}.${i.key}`).toBe("number");
        }
      }
    }
  });

  test("adapter exposes the live strategies", () => {
    expect(STRATEGIES_FROM_CATALOG.length).toBe(implemented.length);
    expect(STRATEGIES_FROM_CATALOG.length).toBeGreaterThan(0);
  });
});
