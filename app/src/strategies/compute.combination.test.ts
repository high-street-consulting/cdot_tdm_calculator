// Tests for the CAPCOA combination engine wired into computeResults (Phase 2):
// multiplicative within-pool damping, purpose-scope gating, and soft overlap
// warnings. Cap-tier behavior is unit-tested in combineEngine.test.ts.

import { describe, it, expect } from "vitest";
import { computeResults, type BasketEntry } from "./compute";
import type { TazInputs } from "./types";

const TAZS: TazInputs[] = [
  { taz_id: "1", daily_vmt: 100000, avg_trip_length: 12, area_type: "urban" } as unknown as TazInputs,
  { taz_id: "2", daily_vmt: 60000, avg_trip_length: 9, area_type: "urban" } as unknown as TazInputs,
];
const COMMUTE_BASE = (100000 + 60000) * 0.3; // default vmt_share_commute = 0.30

describe("within-pool multiplicative damping", () => {
  // telework (CTR, trip_generation, commute): -0.4*(2/5) = -0.16
  // tmo_coverage (CTR, mode_shift, commute): -(0.5-0.1)*0.04 = -0.016
  // Same subsector + pool -> combine 1-(1-0.16)(1-0.016) = 0.17344 < 0.176 sum.
  const basket: BasketEntry[] = [
    { id: "telework" as never, values: { pct_eligible: 0.4, telework_days_per_week: 2 } },
    { id: "tmo_coverage" as never, values: { share_before: 0.1, share_after: 0.5 } },
  ];
  const res = computeResults(basket, TAZS);

  it("total is the damped combination, strictly below the standalone sum", () => {
    expect(res.sum_standalone_daily_vmt_reduction).toBeCloseTo(COMMUTE_BASE * 0.176, 3);
    expect(res.total_daily_vmt_reduction).toBeCloseTo(COMMUTE_BASE * 0.17344, 2);
    expect(res.total_daily_vmt_reduction).toBeLessThan(
      res.sum_standalone_daily_vmt_reduction,
    );
  });

  it("keeps per-strategy STANDALONE percentages intact", () => {
    // Aggregate rollup convention: pct is positive-for-reduction.
    const by = new Map(res.per_strategy.map((p) => [p.id as string, p]));
    expect(by.get("telework")!.pct_vmt_reduction).toBeCloseTo(0.16, 9);
    expect(by.get("tmo_coverage")!.pct_vmt_reduction).toBeCloseTo(0.016, 9);
  });

  it("attributes the combined total across strategies (Σ combined = total)", () => {
    const sumCombined = res.per_strategy.reduce(
      (a, p) => a + p.combined_daily_vmt_reduction,
      0,
    );
    expect(sumCombined).toBeCloseTo(res.total_daily_vmt_reduction, 6);
  });
});

describe("purpose-scope gating (transit_pass_subsidy vmt_scope)", () => {
  const vals = { pct_fare_reduction: 0.5, pct_eligible: 0.4 };
  const all = computeResults(
    [{ id: "transit_pass_subsidy" as never, values: { ...vals, vmt_scope: "all" } }],
    TAZS,
  );
  const commute = computeResults(
    [{ id: "transit_pass_subsidy" as never, values: { ...vals, vmt_scope: "commute" } }],
    TAZS,
  );

  it("commute scope applies the reduction only to the commute pool (~0.30x)", () => {
    expect(all.total_daily_vmt_reduction).toBeGreaterThan(0);
    expect(commute.total_daily_vmt_reduction).toBeLessThan(all.total_daily_vmt_reduction);
    expect(commute.total_daily_vmt_reduction).toBeCloseTo(
      all.total_daily_vmt_reduction * 0.3,
      2,
    );
  });
});

describe("soft overlap warnings (shared mechanism + population + pool)", () => {
  // employee_commuting_benefits (T-9) and workplace_parking_pricing (T-12) are both
  // mode_shift + commute target population in the commute pool -> should warn
  // (non-blocking). Neither is superseded here: no T-5/T-6 program is in the basket,
  // and T-12 stays creditable alongside T-5 in any case.
  //
  // This pair replaced commute_marketing + commute_incentives, which is now a HARD
  // supersession rather than a soft overlap: commute_incentives is T-5, which
  // absorbs T-7 marketing outright (see compute.supersession.test.ts). A superseded
  // strategy contributes nothing and so is no longer a candidate for an overlap
  // warning; the stronger rule replaces the weaker one.
  const res = computeResults(
    [
      { id: "employee_commuting_benefits" as never, values: {} },
      { id: "workplace_parking_pricing" as never, values: {} },
    ],
    TAZS,
  );
  it("emits a warning for the overlapping commute pair", () => {
    const w = res.overlap_warnings.find(
      (x) =>
        (x.a === "employee_commuting_benefits" &&
          x.b === "workplace_parking_pricing") ||
        (x.a === "workplace_parking_pricing" &&
          x.b === "employee_commuting_benefits"),
    );
    expect(w).toBeTruthy();
    expect(w!.mechanism).toBe("mode_shift");
    expect(w!.target_population).toBe("commute");
    expect(w!.pools).toContain("commute");
  });
});
