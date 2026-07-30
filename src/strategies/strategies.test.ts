// Golden-value tests: assert the TS strategy port matches the Python output
// captured by scripts/generate_golden_fixtures.py for the same TAZs and
// parameters. The TS port mirrors Python's add_imputed_mode_shares
// (source="auto"): ACS B08301 per-TAZ when present, MODE_SHARE_BY_AREA_TYPE
// fallback otherwise, so every TAZ should produce a numerically matching
// result regardless of ACS coverage.

import { describe, it, expect } from "vitest";
import golden from "./__fixtures__/golden.json";
import { STRATEGY_REGISTRY } from "./strategies";
import type { TazInputs } from "./types";

const REGISTRY = STRATEGY_REGISTRY as Record<
  string,
  ((taz: TazInputs, args: unknown) => { pct_vmt_reduction: number; daily_vmt_reduction: number; base_vmt: number; base_vmt_purpose: string }) | undefined
>;

interface GoldenPerTaz {
  taz_id: string;
  base_vmt_purpose: string;
  base_vmt: number | null;
  pct_vmt_reduction: number | null;
  daily_vmt_reduction: number | null;
  data_assumptions: string;
}

interface GoldenCase {
  label: string;
  strategy: string;
  kwargs: Record<string, unknown>;
  inputs_str: string;
  per_taz: GoldenPerTaz[];
}

type GoldenFixture = {
  _meta: { sample_taz_ids: string[]; strategies: string[] };
  taz_inputs: Record<string, TazInputs>;
  cases: GoldenCase[];
};

const fixture = golden as unknown as GoldenFixture;
const tazInputs = fixture.taz_inputs;

const VMT_TOL_MI = 0.5; // daily_vmt_reduction tolerance (mi/day)

describe("strategy port: golden-value tests", () => {
  for (const c of fixture.cases) {
    const fn = REGISTRY[c.strategy];
    if (!fn) {
      it.skip(`${c.strategy} (${c.label}): not in TS registry (closed-form: see computeDsl.test)`, () => {});
      continue;
    }

    describe(`${c.strategy} :: ${c.label}`, () => {
      for (const expected of c.per_taz) {
        const taz = tazInputs[expected.taz_id];
        if (!taz) {
          it.skip(`TAZ ${expected.taz_id}: no inputs`, () => {});
          continue;
        }

        it(`TAZ ${expected.taz_id}`, () => {
          const actual = fn(taz, c.kwargs);

          if (expected.pct_vmt_reduction == null) {
            // Python emitted NaN/None; TS should produce 0.
            expect(actual.pct_vmt_reduction).toBe(0);
            return;
          }
          expect(actual.pct_vmt_reduction).toBeCloseTo(expected.pct_vmt_reduction, 6);
          expect(Math.abs(actual.daily_vmt_reduction - (expected.daily_vmt_reduction ?? 0))).toBeLessThan(VMT_TOL_MI);
          expect(actual.base_vmt).toBeCloseTo(expected.base_vmt ?? 0, 3);
          expect(actual.base_vmt_purpose).toBe(expected.base_vmt_purpose);
        });
      }
    });
  }
});
