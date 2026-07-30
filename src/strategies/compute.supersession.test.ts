// CAPCOA hard supersessions (spec §4.1), wired into computeResults.
//
// T-5/T-6 (a comprehensive commute trip reduction program) already account for the
// combined effect of the individual commute measures T-7..T-11, so crediting both
// double counts. Rules live in globals.yaml and match on `capcoa_measure`.
//
// Our mapping: tmo_coverage and commute_incentives are T-5; commute_marketing T-7;
// employee_commuting_benefits T-9; end_of_trip_facilities T-10; vanpool T-11;
// workplace_parking_pricing T-12 (deliberately NOT superseded - the fact sheet
// allows T-12/T-13 alongside T-5, bounded by the 45% CTR cap).

import { describe, it, expect } from "vitest";
import { computeResults, type BasketEntry } from "./compute";
import type { TazInputs } from "./types";

const TAZS: TazInputs[] = [
  { taz_id: "1", daily_vmt: 100000, avg_trip_length: 12, area_type: "urban" } as unknown as TazInputs,
  { taz_id: "2", daily_vmt: 60000, avg_trip_length: 9, area_type: "urban" } as unknown as TazInputs,
];

const TMO: BasketEntry = {
  id: "tmo_coverage" as never,
  values: { share_before: 0, share_after: 0.5 },
};
const MARKETING: BasketEntry = {
  id: "commute_marketing" as never,
  values: { pct_eligible: 0.5, reduction_per_eligible: 0.01 },
};
const BENEFITS: BasketEntry = {
  id: "employee_commuting_benefits" as never,
  values: { subsidy_amount: 2, pct_eligible: 0.5 },
};
const PARKING: BasketEntry = {
  id: "workplace_parking_pricing" as never,
  values: { new_price: 8, share_affected: 0.3 },
};

const by = (res: ReturnType<typeof computeResults>, id: string) =>
  res.per_strategy.find((p) => (p.id as string) === id)!;

describe("T-5 supersedes the individual CTR measures", () => {
  it("zeroes the superseded strategies' contribution to the combined total", () => {
    const res = computeResults([TMO, MARKETING, BENEFITS], TAZS);
    const marketing = by(res, "commute_marketing");
    const benefits = by(res, "employee_commuting_benefits");

    for (const p of [marketing, benefits]) {
      expect(p.superseded).toBe(true);
      expect(p.supersededBy).toBe("TMO or TMA Coverage Expansion");
      expect(p.combined_daily_vmt_reduction).toBe(0);
      // Standalone figures survive, so the detail view still shows the strategy's
      // own effect; only its share of the package is removed.
      expect(p.daily_vmt_reduction).toBeGreaterThan(0);
    }
    expect(by(res, "tmo_coverage").superseded).toBeFalsy();
  });

  it("makes the total identical to the superseding strategy alone", () => {
    const withAll = computeResults([TMO, MARKETING, BENEFITS], TAZS);
    const tmoOnly = computeResults([TMO], TAZS);
    expect(withAll.total_daily_vmt_reduction).toBeCloseTo(
      tmoOnly.total_daily_vmt_reduction,
      6,
    );
  });

  it("is what changed: the old behaviour double counted", () => {
    // Without the rule these would have compounded into a larger total. Guard that
    // the superseded measures really are excluded, not merely damped by the cap.
    const withAll = computeResults([TMO, MARKETING, BENEFITS], TAZS);
    const marketingOnly = computeResults([MARKETING], TAZS);
    expect(marketingOnly.total_daily_vmt_reduction).toBeGreaterThan(0);
    expect(withAll.total_daily_vmt_reduction).toBeLessThan(
      computeResults([TMO], TAZS).total_daily_vmt_reduction +
        marketingOnly.total_daily_vmt_reduction,
    );
  });

  it("leaves T-12 (workplace parking pricing) creditable alongside T-5", () => {
    const res = computeResults([TMO, PARKING], TAZS);
    expect(by(res, "workplace_parking_pricing").superseded).toBeFalsy();
    expect(by(res, "workplace_parking_pricing").combined_daily_vmt_reduction)
      .toBeGreaterThan(0);
    // And it still compounds with the program rather than being additive.
    expect(res.total_daily_vmt_reduction).toBeLessThan(
      res.sum_standalone_daily_vmt_reduction,
    );
  });

  it("does nothing when no superseding measure is in the basket", () => {
    const res = computeResults([MARKETING, BENEFITS], TAZS);
    expect(by(res, "commute_marketing").superseded).toBeFalsy();
    expect(by(res, "employee_commuting_benefits").superseded).toBeFalsy();
    expect(res.total_daily_vmt_reduction).toBeGreaterThan(0);
  });

  it("attributed contributions still sum to the combined total", () => {
    const res = computeResults([TMO, MARKETING, BENEFITS, PARKING], TAZS);
    const sum = res.per_strategy.reduce(
      (a, p) => a + p.combined_daily_vmt_reduction,
      0,
    );
    expect(sum).toBeCloseTo(res.total_daily_vmt_reduction, 6);
  });
});
