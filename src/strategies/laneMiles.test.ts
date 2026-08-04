// Lane-Mile Addition (induced demand) behaviour that golden.json cannot express.
//
// golden.json pins the TS port to the Python engine over one fixed 12-TAZ sample,
// so it cannot vary the selection — and varying the selection is exactly what
// broke before 2026-08-04: the entered project total was divided by each zone's
// own lane-mile stock, so the same project reported a bigger effect the more
// zones you selected, with no floor at -100%. These assertions are independent
// of the private TAZ dataset, like micromobilityFleetMix.test.ts.

import { describe, it, expect } from "vitest";
import { laneMileAddition } from "./aggregates";
import type { TazInputs } from "./types";

/** Minimal TAZ carrying just what this strategy reads. */
function taz(id: string, laneMiMajorArterial: number, dailyVmt: number): TazInputs {
  return {
    taz_id: id,
    daily_vmt: dailyVmt,
    lane_mi_major_arterial: laneMiMajorArterial,
    lane_mi_collector: 0,
  } as unknown as TazInputs;
}

// Downtown Steamboat Springs, the tutorial-video example: 1.61 major-arterial
// lane-miles across five zones, very unevenly distributed, one with none at all.
const STEAMBOAT = [
  taz("1368", 0.70, 6295.6),
  taz("1369", 0.08, 3116.9),
  taz("1370", 0.31, 2213.1),
  taz("1371", 0.52, 4602.6),
  taz("1380", 0.00, 1337.6),
];

const EPS_ARTERIAL = 0.6;

describe("laneMileAddition: aggregate denominator", () => {
  it("divides the project total by the selection's whole lane-mile stock", () => {
    const rows = laneMileAddition(STEAMBOAT, {
      new_lane_miles: -0.5,
      facility_class: "major_arterial",
    });
    // (-0.5 / 1.61) * 0.6 = -18.63%, NOT the -107.8% the per-TAZ form produced.
    expect(rows[0].pct_vmt_reduction).toBeCloseTo((-0.5 / 1.61) * EPS_ARTERIAL, 9);
  });

  it("reports the same percentage for every zone in the selection", () => {
    const rows = laneMileAddition(STEAMBOAT, {
      new_lane_miles: -0.5,
      facility_class: "major_arterial",
    });
    const pcts = new Set(rows.map((r) => r.pct_vmt_reduction));
    expect(pcts.size).toBe(1);
    // Including the zone with no arterial of its own: an area-level elasticity
    // applies to the area, and its VMT is part of that area.
    expect(rows).toHaveLength(5);
  });

  it("does not grow the effect as more zones are added to the selection", () => {
    // The regression itself. Splitting the SAME 1.61 lane-miles across more zones
    // must not change the answer.
    const oneZone = laneMileAddition([taz("A", 1.61, 17565.8)], {
      new_lane_miles: -0.5,
      facility_class: "major_arterial",
    });
    const fiveZones = laneMileAddition(STEAMBOAT, {
      new_lane_miles: -0.5,
      facility_class: "major_arterial",
    });
    expect(fiveZones[0].pct_vmt_reduction).toBeCloseTo(oneZone[0].pct_vmt_reduction, 12);
  });

  it("scales the percentage down as the selection widens", () => {
    const downtown = laneMileAddition(STEAMBOAT, {
      new_lane_miles: -0.5,
      facility_class: "major_arterial",
    });
    const countywide = laneMileAddition([...STEAMBOAT, taz("rural", 40, 500000)], {
      new_lane_miles: -0.5,
      facility_class: "major_arterial",
    });
    expect(Math.abs(countywide[0].pct_vmt_reduction)).toBeLessThan(
      Math.abs(downtown[0].pct_vmt_reduction),
    );
  });
});

describe("laneMileAddition: removal clamp", () => {
  it("cannot remove more lane miles than the selection has", () => {
    const rows = laneMileAddition(STEAMBOAT, {
      new_lane_miles: -20,
      facility_class: "major_arterial",
    });
    // Bound is the elasticity itself, not an invented cap.
    expect(rows[0].pct_vmt_reduction).toBeCloseTo(-EPS_ARTERIAL, 9);
    expect(rows.every((r) => r.data_assumptions === "lane_miles_removed_clamped_to_existing")).toBe(true);
  });

  it("never returns a reduction beyond -100% at any facility class", () => {
    for (const fc of ["freeway", "expressway", "major_arterial", "minor_arterial", "collector", "local"] as const) {
      const rows = laneMileAddition(
        [taz("A", 0.05, 10000)].map((t) => ({ ...t, [`lane_mi_${fc}`]: 0.05 }) as TazInputs),
        { new_lane_miles: -999, facility_class: fc },
      );
      expect(rows[0].pct_vmt_reduction).toBeGreaterThanOrEqual(-1);
    }
  });

  it("leaves additions unbounded — induced demand has no ceiling here", () => {
    const rows = laneMileAddition(STEAMBOAT, {
      new_lane_miles: 16.1,
      facility_class: "major_arterial",
    });
    expect(rows[0].pct_vmt_reduction).toBeCloseTo(6.0, 9); // +600%
    expect(rows[0].data_assumptions).toBe("");
  });

  it("reports the applied value and the denominator so the number is auditable", () => {
    const rows = laneMileAddition(STEAMBOAT, {
      new_lane_miles: -20,
      facility_class: "major_arterial",
    });
    expect(rows[0].inputs).toBe(
      "new_lane_mi=-1.61, class=major_arterial, ε=0.6, existing_lane_mi=1.61",
    );
  });
});

describe("laneMileAddition: no stock in the class", () => {
  it("returns zero with a flag when the selection has none of that class", () => {
    const rows = laneMileAddition(STEAMBOAT, {
      new_lane_miles: -2,
      facility_class: "collector",
    });
    expect(rows.every((r) => r.pct_vmt_reduction === 0)).toBe(true);
    expect(rows.every((r) => r.data_assumptions === "no_existing_lane_miles_in_class")).toBe(true);
  });

  it("treats a cleared input as no change rather than throwing", () => {
    const rows = laneMileAddition(STEAMBOAT, {
      new_lane_miles: "" as unknown as number,
      facility_class: "major_arterial",
    });
    expect(rows[0].pct_vmt_reduction).toBe(0);
  });
});
