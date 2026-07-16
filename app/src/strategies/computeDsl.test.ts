// Tests for the YAML `compute:` DSL evaluator (computeDsl.ts).
//
//  1. Unit tests pin the expression language (precedence, functions, gating,
//     row_defaults precedence).
//  2. Cross-language fidelity: for every case in compute_golden.json (generated
//     by scripts/generate_compute_golden.py from the authoritative Python engine
//     ) the TypeScript evaluator must reproduce expected_pct using the SAME
//     compute block that ships in the compiled catalog. This is what guarantees
//     "author once in YAML, runs identically in Python and the app".

import { describe, it, expect } from "vitest";
import golden from "./__fixtures__/compute_golden.json";
import { CATALOG } from "./catalog";
import { evaluate, runCompute, type ComputeSpec } from "./computeDsl";

describe("computeDsl: expression language", () => {
  const ev = (e: string, s: Record<string, number> = {}) => evaluate(e, s);

  it("arithmetic precedence and parentheses", () => {
    expect(ev("1 + 2 * 3")).toBe(7);
    expect(ev("(1 + 2) * 3")).toBe(9);
    expect(ev("-2 * -3")).toBe(6);
    expect(ev("10 / 4")).toBe(2.5);
  });

  it("functions clamp/min/max/mean/abs", () => {
    expect(ev("clamp(5, 0, 1)")).toBe(1);
    expect(ev("clamp(-5, 0, 1)")).toBe(0);
    expect(ev("clamp(0.3, 0, 1)")).toBe(0.3);
    expect(ev("min(3, 1, 2)")).toBe(1);
    expect(ev("max(3, 1, 2)")).toBe(3);
    expect(ev("mean(1, 2, 3)")).toBe(2);
    expect(ev("abs(-4)")).toBe(4);
  });

  it("comparisons, and/or/not, and if()", () => {
    expect(ev("3 > 2")).toBe(1);
    expect(ev("3 < 2")).toBe(0);
    expect(ev("1 and 0")).toBe(0);
    expect(ev("1 or 0")).toBe(1);
    expect(ev("not 0")).toBe(1);
    expect(ev("if(1, 10, 20)")).toBe(10);
    expect(ev("if(0, 10, 20)")).toBe(20);
    expect(ev("if(a > b, a, b)", { a: 2, b: 9 })).toBe(9);
  });

  it("resolves names from scope and throws on unknown names/functions", () => {
    expect(ev("x * 2", { x: 21 })).toBe(42);
    expect(() => ev("nope + 1", {})).toThrow(/unknown name/);
    expect(() => ev("bogus(1)", {})).toThrow(/unknown function/);
  });

  it("scope precedence: const < row_defaults < row < params, then let", () => {
    const spec: ComputeSpec = {
      pool: "all",
      const: { k: 1 },
      row_defaults: { gate: 0 },
      let: [{ doubled: "k * 2" }],
      formula: "doubled + gate + p",
    };
    // row overrides row_defaults; params is present; let sees const
    expect(runCompute(spec, { gate: 5 }, { p: 100 })).toBe(2 + 5 + 100);
    // row_defaults supplies a missing row field
    expect(runCompute(spec, {}, { p: 0 })).toBe(2 + 0 + 0);
  });
});

interface GoldenCase {
  strategy: string;
  row: Record<string, number>;
  params: Record<string, number>;
  expected_pct: number;
}

describe("computeDsl: cross-language fidelity vs the Python engine", () => {
  const specById = new Map(
    CATALOG.strategies.filter((s) => s.compute).map((s) => [s.id, s.compute as ComputeSpec]),
  );

  for (const c of golden as unknown as GoldenCase[]) {
    it(`${c.strategy} :: ${JSON.stringify(c.params)}`, () => {
      const spec = specById.get(c.strategy);
      expect(spec, `no compute block in catalog for ${c.strategy}`).toBeDefined();
      const pct = runCompute(spec as ComputeSpec, c.row, c.params);
      expect(pct).toBeCloseTo(c.expected_pct, 10);
    });
  }
});
