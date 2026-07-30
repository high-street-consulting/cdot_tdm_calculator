import { describe, it, expect } from "vitest";
import {
  combineFractions,
  combinePool,
  classifyPlaceType,
  type Contributor,
} from "./combineEngine";
import type { PlaceTypeCaps } from "./catalog";

const CAPS: PlaceTypeCaps = {
  global: { urban_core: 75, urban: 40, suburban: 20, rural: 20 },
  category: { urban_core: 70, urban: 35, suburban: 15, rural: 15 },
  land_use: { urban_core: 65, urban: 30, suburban: 10, rural: 10 },
};
const CTR = 45;

const c = (id: string, subsector: Contributor["subsector"], r: number): Contributor => ({
  id,
  subsector,
  r,
  measureCapped: false,
});

describe("combineFractions", () => {
  it("multiplicative dampening (CAPCOA)", () => {
    // 10% + 10% -> 19%, not 20%
    expect(combineFractions([0.1, 0.1])).toBeCloseTo(0.19, 12);
    expect(combineFractions([])).toBe(0);
    expect(combineFractions([0.25])).toBeCloseTo(0.25, 12);
  });
});

describe("combinePool caps", () => {
  it("combines within subsector multiplicatively when no cap binds", () => {
    const res = combinePool(
      [c("a", "neighborhood_design", 0.1), c("b", "neighborhood_design", 0.1)],
      "urban",
      CAPS,
      CTR,
    );
    expect(res.R).toBeCloseTo(0.19, 12);
    expect(res.cappedIds.size).toBe(0);
    // attribution sums to R and splits ~evenly for equal contributors
    const sum = Object.values(res.attribution).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(res.R, 12);
    expect(res.attribution.a).toBeCloseTo(res.attribution.b, 12);
  });

  it("clamps the land-use subcategory cap (suburban = 10%)", () => {
    const res = combinePool([c("t1", "land_use", 0.5)], "suburban", CAPS, CTR);
    expect(res.R).toBeCloseTo(0.1, 12);
    expect(res.boundCaps.has("land_use")).toBe(true);
    expect(res.cappedIds.has("t1")).toBe(true);
    expect(res.cappedBy.t1).toEqual({ tier: "land_use", capPct: 10 });
  });

  it("clamps the CTR subgroup cap (45%)", () => {
    const res = combinePool(
      [
        c("x", "commute_trip_reduction", 0.2),
        c("y", "commute_trip_reduction", 0.2),
        c("z", "commute_trip_reduction", 0.2),
      ],
      "urban_core",
      CAPS,
      CTR,
    );
    // 1-0.8^3 = 0.488 -> capped to 0.45
    expect(res.R).toBeCloseTo(0.45, 12);
    expect(res.boundCaps.has("ctr")).toBe(true);
  });

  it("clamps the global maximum (urban_core = 75%)", () => {
    const res = combinePool(
      [
        c("lu", "land_use", 0.6), // land_use cap 65% -> ok
        c("tr", "transit", 0.5),
        c("ct", "commute_trip_reduction", 0.45),
      ],
      "urban_core",
      CAPS,
      CTR,
    );
    // built-env combine(0.6, 0, 0, 0.5) = 0.8 -> category cap 70% -> 0.70
    // global combine(0.70, 0.45) = 0.835 -> 0.75
    expect(res.R).toBeCloseTo(0.75, 12);
    expect(res.boundCaps.has("category")).toBe(true);
    expect(res.boundCaps.has("global")).toBe(true);
    // attribution still sums to the capped R
    const sum = Object.values(res.attribution).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(res.R, 10);
  });

  it("flags a per-measure cap via measureCapped", () => {
    const res = combinePool(
      [{ id: "m", subsector: "land_use", r: 0.3, measureCapped: true }],
      "urban_core",
      CAPS,
      CTR,
    );
    expect(res.cappedIds.has("m")).toBe(true);
    expect(res.boundCaps.has("measure")).toBe(true);
    expect(res.cappedBy.m).toEqual({ tier: "measure", capPct: 30 });
  });
});

describe("classifyPlaceType", () => {
  const th = { urban_core: 10000, urban: 3500, suburban: 1000, rural: 0 };
  it("prefers a valid area_type enum", () => {
    expect(classifyPlaceType("suburban", 99999, th)).toBe("suburban");
  });
  it("falls back to activity-density thresholds", () => {
    expect(classifyPlaceType(undefined, 12000, th)).toBe("urban_core");
    expect(classifyPlaceType(undefined, 4000, th)).toBe("urban");
    expect(classifyPlaceType(undefined, 1500, th)).toBe("suburban");
    expect(classifyPlaceType(undefined, 100, th)).toBe("rural");
    expect(classifyPlaceType("bogus", undefined, th)).toBe("rural");
  });
});
