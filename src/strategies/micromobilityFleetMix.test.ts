// Shared Micromobility fleet mix (added 2026-07-27 content review).
//
// The blended substitution ratio is the one piece of new arithmetic, so it is
// pinned here rather than in golden.json: these assertions are independent of the
// TAZ dataset, whereas regenerating golden.json requires the private data repo and
// rebaselines every strategy at once.
//
// The Python twin (scripts/strategy_calculations.py::strategy_shared_micromobility)
// implements the same blend; generate_golden_fixtures.py carries matching fleet-mix
// scenarios for whenever the fixtures are next regenerated against real TAZ data.

import { describe, it, expect } from "vitest";
import { sharedMicromobility } from "./strategies";
import { MICRO_SUBSTITUTION_BY_TYPE } from "./constants";
import type { TazInputs } from "./types";

const TAZ = {
  taz_id: "1",
  daily_vmt: 100000,
  avg_trip_length: 10,
  area_type: "urban",
  population: 5000,
  employment: 1000,
  daily_trips: 24000,
} as unknown as TazInputs;

const PEDAL = MICRO_SUBSTITUTION_BY_TYPE.bikeshare.ratio; // 0.196
const EBIKE = MICRO_SUBSTITUTION_BY_TYPE["e-bikeshare"].ratio; // 0.350
const SCOOTER = MICRO_SUBSTITUTION_BY_TYPE.scootershare.ratio; // 0.385

const ACCESS = { pct_pop_access_before: 0, pct_pop_access_after: 0.3 };

/** pct_vmt_reduction scales linearly in the substitution ratio, so the ratio can
 *  be recovered from a run by dividing out a single-device reference run. */
function ratioOf(args: Parameters<typeof sharedMicromobility>[1]): number {
  const mixed = sharedMicromobility(TAZ, args).pct_vmt_reduction!;
  const reference = sharedMicromobility(TAZ, {
    ...ACCESS,
    substitution_ratio: 1,
  }).pct_vmt_reduction!;
  return mixed / reference;
}

describe("shared micromobility fleet mix", () => {
  it("blends the device ratios in proportion to fleet share", () => {
    // Denver's case: scooter-dominant with permit-required e-bikes.
    const expected = 0.8 * SCOOTER + 0.2 * EBIKE; // 37.8%
    expect(
      ratioOf({ ...ACCESS, pct_fleet_scooter: 0.8, pct_fleet_ebike: 0.2 }),
    ).toBeCloseTo(expected, 9);
  });

  it("normalizes shares that do not total 100%", () => {
    // Equal thirds however they are expressed.
    const expected = (PEDAL + EBIKE + SCOOTER) / 3;
    for (const share of [0.5, 1 / 3, 1]) {
      expect(
        ratioOf({
          ...ACCESS,
          pct_fleet_pedal: share,
          pct_fleet_ebike: share,
          pct_fleet_scooter: share,
        }),
      ).toBeCloseTo(expected, 9);
    }
  });

  it("a single-device mix equals that device's ratio", () => {
    expect(ratioOf({ ...ACCESS, pct_fleet_scooter: 1 })).toBeCloseTo(SCOOTER, 9);
    expect(ratioOf({ ...ACCESS, pct_fleet_pedal: 1 })).toBeCloseTo(PEDAL, 9);
  });

  it("falls back to micromobility_type when no fleet share is given", () => {
    expect(ratioOf({ ...ACCESS })).toBeCloseTo(PEDAL, 9);
    expect(
      ratioOf({ ...ACCESS, micromobility_type: "scootershare" }),
    ).toBeCloseTo(SCOOTER, 9);
    // All-zero shares are "no mix entered", not a zero-substitution fleet.
    expect(
      ratioOf({
        ...ACCESS,
        micromobility_type: "e-bikeshare",
        pct_fleet_pedal: 0,
        pct_fleet_ebike: 0,
        pct_fleet_scooter: 0,
      }),
    ).toBeCloseTo(EBIKE, 9);
  });

  it("an explicit substitution_ratio still overrides the fleet mix", () => {
    expect(
      ratioOf({
        ...ACCESS,
        substitution_ratio: 0.5,
        pct_fleet_scooter: 1,
      }),
    ).toBeCloseTo(0.5, 9);
  });

  it("reports the blend in the assumptions string", () => {
    const r = sharedMicromobility(TAZ, {
      ...ACCESS,
      pct_fleet_scooter: 0.8,
      pct_fleet_ebike: 0.2,
    });
    expect(r.data_assumptions).toContain("blended_from_fleet_mix");
    expect(r.data_assumptions).toContain("scootershare:80%");
    expect(r.data_assumptions).toContain("e-bikeshare:20%");
  });
});
