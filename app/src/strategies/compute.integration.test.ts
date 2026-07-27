// Integration test for the compute.ts dispatch: drives the real computeResults
// entry point with a basket spanning all three execution paths:
//   - YAML compute block  (traffic_calming, pedestrian_network, car_share,
//                           wayfinding, transit_shelters)
//   - aggregate fn         (park_and_ride)
// over real selected TAZs. Guards the wiring, not just the evaluator.

import { describe, it, expect } from "vitest";
import {
  computeResults,
  computeStrategyRows,
  type AggregatedResults,
  type BasketEntry,
} from "./compute";
import type { TazInputs } from "./types";

// Two urban TAZs. transit_vrh / bike_centerline_mi present so wayfinding's
// parent gates open (the app TAZ layer doesn't carry these yet, see
// wayfinding.yaml note, but the dispatch must handle them when present).
const TAZS: TazInputs[] = [
  {
    taz_id: "1", daily_vmt: 100000, avg_trip_length: 12, area_type: "urban",
    transit_vrh: 10, transit_route_count: 2, bike_centerline_mi: 5,
  } as unknown as TazInputs,
  {
    taz_id: "2", daily_vmt: 60000, avg_trip_length: 9, area_type: "urban",
    transit_vrh: 4, transit_route_count: 1, bike_centerline_mi: 3,
  } as unknown as TazInputs,
];

const BASKET: BasketEntry[] = [
  { id: "traffic_calming" as never, values: { streets_with_calming: 4, total_streets: 10, intersections_with_calming: 2, total_intersections: 8 } },
  { id: "pedestrian_network_improvements" as never, values: { existing_sidewalk_mi: 9, sidewalk_mi_with_measure: 10 } },
  { id: "car_share_access" as never, values: { service_area_share: 1.0 } },
  { id: "wayfinding" as never, values: { loi_transit: 0.5, loi_active: 0.5 } },
  { id: "transit_shelters" as never, values: { level_of_implementation: 1.0, brt_stop_share: 0 } },
  { id: "park_and_ride" as never, values: { n_spaces: 200, l_access_mi: 4, utilization: 0.7, isolated_facility: "isolated", total_transit_trips_catchment: 0 } },
];

describe("computeResults dispatch (DSL + aggregate + registry)", () => {
  const res = computeResults(BASKET, TAZS);
  const by = new Map(res.per_strategy.map((p) => [p.id as string, p]));

  it("returns a finite result for every basket strategy", () => {
    expect(res.per_strategy).toHaveLength(BASKET.length);
    for (const p of res.per_strategy) {
      expect(Number.isFinite(p.daily_vmt_reduction)).toBe(true);
      expect(Number.isFinite(p.pct_vmt_reduction)).toBe(true);
    }
    expect(Number.isFinite(res.total_daily_vmt_reduction)).toBe(true);
  });

  // Aggregate pct_vmt_reduction is positive-for-reduction (daily_vmt_reduction =
  // miles saved); the per-TAZ rows keep the raw signed fraction (negative).
  it("closed-form DSL strategies match their known per-area percentages", () => {
    // traffic_calming: coverage=mean(0.4,0.25)=0.325 -> A=0.0025+0.325*0.0075
    expect(by.get("traffic_calming")!.pct_vmt_reduction).toBeCloseTo(0.0049375, 9);
    expect(by.get("traffic_calming")!.rows[0].pct_vmt_reduction).toBeCloseTo(-0.0049375, 9);
    // pedestrian: ((10/9)-1)*-0.05
    expect(by.get("pedestrian_network_improvements")!.pct_vmt_reduction).toBeCloseTo(0.00555556, 7);
    // carshare: min(0.02*1.0*0.30, 0.10)
    expect(by.get("car_share_access")!.pct_vmt_reduction).toBeCloseTo(0.006, 9);
  });

  it("a DSL strategy with no user-set inputs falls back to defaults (no crash)", () => {
    // Regression: runCompute throws "unknown name" if a formula references an
    // input absent from the passed values; computeStrategyRows must seed the
    // strategy's defaults so an unseeded detail view (deep-link / untouched
    // input) computes instead of crashing the DetailView.
    expect(() => computeStrategyRows("new_transit_service", {}, TAZS)).not.toThrow();
    const rows = computeStrategyRows("new_transit_service", {}, TAZS);
    expect(rows).toHaveLength(TAZS.length);
    expect(Number.isFinite(rows[0].pct_vmt_reduction)).toBe(true);
  });

  it("imputation-dependent + aggregate strategies produce reductions", () => {
    expect(by.get("wayfinding")!.pct_vmt_reduction).toBeGreaterThan(0); // gates open here
    expect(by.get("transit_shelters")!.pct_vmt_reduction).toBeGreaterThan(0);
    const pnr = by.get("park_and_ride")!;
    expect(pnr.pct_vmt_reduction).toBeGreaterThan(0);
    expect(pnr.rows[0].base_vmt_purpose).toBe("commute");
  });
});

describe("per-strategy context overrides feed the calculation", () => {
  // new_transit_service is a DSL strategy whose formula is linear in
  // transit_mode_share (-level * pct_change * transit_mode_share * … ), so
  // raising the baseline transit share must scale the reduction up, uniformly
  // across every selected TAZ.
  const inputs = { pct_change: 0.5, level_of_implementation: 1.0 };

  it("overriding transit_mode_share changes computeStrategyRows output", () => {
    const base = computeStrategyRows("new_transit_service" as never, inputs, TAZS);
    const overridden = computeStrategyRows(
      "new_transit_service" as never,
      inputs,
      TAZS,
      { transit_mode_share: 0.5 }, // much higher than any imputed baseline
    );

    // Both paths still produce a row per TAZ.
    expect(base).toHaveLength(TAZS.length);
    expect(overridden).toHaveLength(TAZS.length);

    // Every TAZ's reduction changed (override wins over the imputed value) and,
    // being a larger transit share, is strictly larger in magnitude.
    for (let i = 0; i < TAZS.length; i++) {
      expect(overridden[i].pct_vmt_reduction).not.toBeCloseTo(base[i].pct_vmt_reduction, 9);
      expect(Math.abs(overridden[i].pct_vmt_reduction)).toBeGreaterThan(
        Math.abs(base[i].pct_vmt_reduction),
      );
    }
  });

  // The override is applied uniformly: pct reduction is linear in the override,
  // so the ratio of overridden to a proportionally-scaled override is exact.
  it("applies the override uniformly across TAZs", () => {
    const a = computeStrategyRows("new_transit_service" as never, inputs, TAZS, {
      transit_mode_share: 0.2,
    });
    const b = computeStrategyRows("new_transit_service" as never, inputs, TAZS, {
      transit_mode_share: 0.4,
    });
    // Doubling the overridden transit share doubles each TAZ's pct reduction.
    for (let i = 0; i < TAZS.length; i++) {
      expect(b[i].pct_vmt_reduction).toBeCloseTo(a[i].pct_vmt_reduction * 2, 9);
    }
  });

  // Backward compatibility: no override arg == byte-for-byte identical output.
  it("no override arg leaves results unchanged", () => {
    const withoutArg = computeStrategyRows("new_transit_service" as never, inputs, TAZS);
    const withEmpty = computeStrategyRows("new_transit_service" as never, inputs, TAZS, {});
    for (let i = 0; i < TAZS.length; i++) {
      expect(withEmpty[i].pct_vmt_reduction).toBe(withoutArg[i].pct_vmt_reduction);
    }
  });

  // Non-DSL path: transit_service_expansion is a HAND-WRITTEN calc fn (not a
  // YAML compute block), so this proves contextOverrides is now threaded into
  // and applied by the registry path too. The frequency formula is linear in
  // transit_mode_share, so raising the baseline transit share scales each TAZ's
  // reduction up; a no-override call stays byte-for-byte identical.
  it("overriding a non-DSL (registry) strategy changes its result", () => {
    const tseInputs = { pct_change: 0.5, basis: "frequency", level_of_implementation: 1.0 };
    const base = computeStrategyRows("transit_service_expansion" as never, tseInputs, TAZS);
    const overridden = computeStrategyRows(
      "transit_service_expansion" as never,
      tseInputs,
      TAZS,
      { transit_mode_share: 0.5 }, // well above any imputed urban baseline
    );
    const withEmpty = computeStrategyRows(
      "transit_service_expansion" as never,
      tseInputs,
      TAZS,
      {},
    );

    expect(base).toHaveLength(TAZS.length);
    expect(overridden).toHaveLength(TAZS.length);

    for (let i = 0; i < TAZS.length; i++) {
      // Override wins over the imputed value and, being a larger transit share,
      // yields a strictly larger reduction magnitude — uniformly per TAZ.
      expect(overridden[i].pct_vmt_reduction).not.toBeCloseTo(base[i].pct_vmt_reduction, 9);
      expect(Math.abs(overridden[i].pct_vmt_reduction)).toBeGreaterThan(
        Math.abs(base[i].pct_vmt_reduction),
      );
      // No override (empty map) == byte-for-byte the pre-override result.
      expect(withEmpty[i].pct_vmt_reduction).toBe(base[i].pct_vmt_reduction);
    }
  });

  // computeResults threads each entry's contextOverrides into its strategy.
  it("computeResults applies per-entry contextOverrides", () => {
    const plain = computeResults(
      [{ id: "new_transit_service" as never, values: inputs }],
      TAZS,
    );
    const withOverride = computeResults(
      [
        {
          id: "new_transit_service" as never,
          values: inputs,
          contextOverrides: { transit_mode_share: 0.5 },
        },
      ],
      TAZS,
    );
    expect(withOverride.total_daily_vmt_reduction).not.toBeCloseTo(
      plain.total_daily_vmt_reduction,
      3,
    );
    expect(withOverride.total_daily_vmt_reduction).toBeGreaterThan(
      plain.total_daily_vmt_reduction,
    );
  });
});

describe("methodology-constant overrides route through runCompute", () => {
  // tmo_coverage is a DSL strategy: -(share_after - share_before) * r_ctr, where
  // r_ctr (0.04) is a spec.const. Overriding r_ctr must scale each TAZ's
  // reduction linearly, proving the const-override channel + partition.
  const inputs = { share_before: 0.1, share_after: 0.5 };

  it("overriding a spec.const (r_ctr) changes computeStrategyRows output", () => {
    const base = computeStrategyRows("tmo_coverage" as never, inputs, TAZS);
    const overridden = computeStrategyRows("tmo_coverage" as never, inputs, TAZS, {
      r_ctr: 0.08, // double the CAPCOA midpoint
    });
    for (let i = 0; i < TAZS.length; i++) {
      // r_ctr doubled -> pct reduction doubled (linear in the const).
      expect(overridden[i].pct_vmt_reduction).toBeCloseTo(base[i].pct_vmt_reduction * 2, 12);
      expect(overridden[i].pct_vmt_reduction).not.toBe(base[i].pct_vmt_reduction);
    }
  });

  it("a const override never leaks into an unrelated strategy's row scope", () => {
    // r_ctr is not a var in new_transit_service; passing it must be inert there
    // (partition keeps it out of dslRow because it isn't in that spec.const).
    const base = computeStrategyRows(
      "new_transit_service" as never,
      { pct_change: 0.5, level_of_implementation: 1.0 },
      TAZS,
    );
    const withStray = computeStrategyRows(
      "new_transit_service" as never,
      { pct_change: 0.5, level_of_implementation: 1.0 },
      TAZS,
      { r_ctr: 0.99 },
    );
    for (let i = 0; i < TAZS.length; i++) {
      expect(withStray[i].pct_vmt_reduction).toBe(base[i].pct_vmt_reduction);
    }
  });
});

describe("commute VMT base override (vmt_share_commute)", () => {
  // telework is pool="commute": -pct_eligible * (telework_days/5) applied to the
  // commute VMT base = daily_vmt * vmt_share_commute. Overriding the commute
  // share must re-scale base_vmt and hence the daily_vmt_reduction, uniformly.
  const inputs = { pct_eligible: 0.4, telework_days_per_week: 2 };

  it("overriding vmt_share_commute changes a commute strategy's result", () => {
    // TAZS carry no vmt_share_commute field, so the effective default is 0.30.
    const base = computeStrategyRows("telework" as never, inputs, TAZS);
    const overridden = computeStrategyRows("telework" as never, inputs, TAZS, {
      vmt_share_commute: 0.6, // double the 0.30 default
    });
    for (let i = 0; i < TAZS.length; i++) {
      // pct reduction is unchanged (independent of the base), but the base VMT
      // and thus the mi/day reduction double.
      expect(overridden[i].pct_vmt_reduction).toBeCloseTo(base[i].pct_vmt_reduction, 12);
      expect(overridden[i].base_vmt).toBeCloseTo(base[i].base_vmt * 2, 6);
      expect(overridden[i].daily_vmt_reduction).toBeCloseTo(
        base[i].daily_vmt_reduction * 2,
        6,
      );
    }
  });

  it("flows through computeResults for a commute strategy", () => {
    const plain = computeResults([{ id: "telework" as never, values: inputs }], TAZS);
    const withOverride = computeResults(
      [{ id: "telework" as never, values: inputs, contextOverrides: { vmt_share_commute: 0.6 } }],
      TAZS,
    );
    expect(withOverride.total_daily_vmt_reduction).toBeCloseTo(
      plain.total_daily_vmt_reduction * 2,
      3,
    );
  });
});

describe("row-var override (avg_trip_length) on DSL and registry paths", () => {
  // separated_bike_lanes (DSL) divides by avg_trip_length; shared_micromobility
  // (hand-written registry) divides by it too. Both must honor a uniform
  // override — the DSL via dslRow's seeded fallback, the registry via overrideNum.
  it("changes both a DSL and a registry strategy's result", () => {
    const bikeInputs = { pct_parallel_vmt_affected: 0.5, annual_use_days: 250 };
    const bikeBase = computeStrategyRows("separated_bike_lanes" as never, bikeInputs, TAZS);
    const bikeOv = computeStrategyRows("separated_bike_lanes" as never, bikeInputs, TAZS, {
      avg_trip_length: 4, // shorter trips -> larger per-mile bike substitution
    });

    const microInputs = {
      micromobility_type: "bikeshare",
      pct_pop_access_before: 0,
      pct_pop_access_after: 1,
    };
    const microBase = computeStrategyRows("shared_micromobility" as never, microInputs, TAZS);
    const microOv = computeStrategyRows("shared_micromobility" as never, microInputs, TAZS, {
      avg_trip_length: 4,
    });

    for (let i = 0; i < TAZS.length; i++) {
      expect(bikeOv[i].pct_vmt_reduction).not.toBeCloseTo(bikeBase[i].pct_vmt_reduction, 9);
      expect(microOv[i].pct_vmt_reduction).not.toBeCloseTo(microBase[i].pct_vmt_reduction, 9);
    }
  });
});

describe("backward compatibility: no override == byte-for-byte identical", () => {
  // A basket spanning const-tagged, commute-base, and row-var strategies must be
  // untouched when no overrides / an empty map is supplied.
  const cases: Array<[string, Record<string, number | string>]> = [
    ["tmo_coverage", { share_before: 0.1, share_after: 0.5 }],
    ["telework", { pct_eligible: 0.4, telework_days_per_week: 2 }],
    ["separated_bike_lanes", { pct_parallel_vmt_affected: 0.5, annual_use_days: 250 }],
    ["employee_commuting_benefits", { subsidy_amount: 1.5, pct_eligible: 0.3 }],
    ["transit_oriented_development", { pct_taz_in_tod: 0.1, tod_mode_share_ratio: 4.9 }],
  ];

  it.each(cases)("%s: undefined vs empty vs no-arg all match", (id, values) => {
    const noArg = computeStrategyRows(id as never, values, TAZS);
    const empty = computeStrategyRows(id as never, values, TAZS, {});
    const undef = computeStrategyRows(id as never, values, TAZS, undefined);
    for (let i = 0; i < TAZS.length; i++) {
      expect(empty[i].pct_vmt_reduction).toBe(noArg[i].pct_vmt_reduction);
      expect(empty[i].base_vmt).toBe(noArg[i].base_vmt);
      expect(empty[i].daily_vmt_reduction).toBe(noArg[i].daily_vmt_reduction);
      expect(undef[i].pct_vmt_reduction).toBe(noArg[i].pct_vmt_reduction);
    }
  });
});

describe("project-level baseline VMT override (computeResults opts)", () => {
  // Derived baseline = 100000 + 60000 = 160000 mi/day across TAZS.
  const DERIVED = 160000;
  // A basket of strategies whose reductions derive from the VMT base: a
  // total-VMT DSL strategy (car_share_access) and a commute-pool strategy
  // (telework). Their base_vmt and absolute reduction scale linearly with the
  // daily_vmt the override rewrites. (park_and_ride is deliberately excluded
  // from the SCALING assertion — its reduction is supply-side, driven by
  // parking spaces × trip length, not daily_vmt, so it doesn't scale with the
  // baseline. It's still covered by the byte-for-byte / no-op tests below.)
  const basket: BasketEntry[] = [
    { id: "car_share_access" as never, values: { service_area_share: 1.0 } },
    { id: "telework" as never, values: { pct_eligible: 0.4, telework_days_per_week: 2 } },
  ];
  // A superset basket that also includes the aggregate park_and_ride, used only
  // where the assertion is scale-agnostic (baseline equality, byte-for-byte, no-op).
  const basketWithPnr: BasketEntry[] = [
    ...basket,
    {
      id: "park_and_ride" as never,
      values: {
        n_spaces: 200, l_access_mi: 4, utilization: 0.7,
        isolated_facility: "isolated", total_transit_trips_catchment: 0,
      },
    },
  ];

  it("reports baseline_vmt equal to the override", () => {
    const override = 500000;
    const res = computeResults(basketWithPnr, TAZS, { baselineVmtOverride: override });
    expect(res.baseline_vmt).toBeCloseTo(override, 6);
  });

  it("scales total_daily_vmt_reduction by override/derived, percentages unchanged", () => {
    const override = 500000;
    const f = override / DERIVED;
    const plain = computeResults(basket, TAZS);
    const scaled = computeResults(basket, TAZS, { baselineVmtOverride: override });

    // Absolute reduction scales by the uniform factor f...
    expect(scaled.total_daily_vmt_reduction).toBeCloseTo(
      plain.total_daily_vmt_reduction * f,
      3,
    );
    // ...while the aggregate % (reduction / baseline) is invariant.
    expect(scaled.total_pct_vmt_reduction).toBeCloseTo(plain.total_pct_vmt_reduction, 12);

    // Every strategy's base_vmt and absolute reduction scale by f; its pct is
    // unchanged.
    const plainBy = new Map(plain.per_strategy.map((p) => [p.id as string, p]));
    for (const p of scaled.per_strategy) {
      const b = plainBy.get(p.id as string)!;
      expect(p.base_vmt_total).toBeCloseTo(b.base_vmt_total * f, 3);
      expect(p.daily_vmt_reduction).toBeCloseTo(b.daily_vmt_reduction * f, 3);
      expect(p.pct_vmt_reduction).toBeCloseTo(b.pct_vmt_reduction, 12);
    }
  });

  it("null / absent / non-positive / zero-derived override is byte-for-byte identical", () => {
    const plain = computeResults(basketWithPnr, TAZS);
    const cases: Array<AggregatedResults> = [
      computeResults(basketWithPnr, TAZS, {}),
      computeResults(basketWithPnr, TAZS, { baselineVmtOverride: null }),
      computeResults(basketWithPnr, TAZS, { baselineVmtOverride: 0 }),
      computeResults(basketWithPnr, TAZS, { baselineVmtOverride: -100 }),
      computeResults(basketWithPnr, TAZS, { baselineVmtOverride: NaN }),
      computeResults(basketWithPnr, TAZS, { baselineVmtOverride: Infinity }),
    ];
    for (const res of cases) {
      expect(res.baseline_vmt).toBe(plain.baseline_vmt);
      expect(res.total_daily_vmt_reduction).toBe(plain.total_daily_vmt_reduction);
      expect(res.total_pct_vmt_reduction).toBe(plain.total_pct_vmt_reduction);
      expect(res.per_strategy).toHaveLength(plain.per_strategy.length);
      for (let i = 0; i < plain.per_strategy.length; i++) {
        expect(res.per_strategy[i].daily_vmt_reduction).toBe(
          plain.per_strategy[i].daily_vmt_reduction,
        );
        expect(res.per_strategy[i].base_vmt_total).toBe(
          plain.per_strategy[i].base_vmt_total,
        );
      }
    }
  });

  it("no-op when the derived baseline is 0 (override cannot be applied)", () => {
    const zeroTazs: TazInputs[] = [
      { taz_id: "z", daily_vmt: 0, area_type: "urban" } as unknown as TazInputs,
    ];
    const res = computeResults(basketWithPnr, zeroTazs, { baselineVmtOverride: 500000 });
    // Derived baseline is 0, so no scale factor exists -> baseline stays 0.
    expect(res.baseline_vmt).toBe(0);
    expect(res.total_daily_vmt_reduction).toBe(
      computeResults(basketWithPnr, zeroTazs).total_daily_vmt_reduction,
    );
  });
});
