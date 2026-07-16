// Constants ported from scripts/strategy_calculations.py.
//
// Where the Python falls back to area-type mode share defaults when ACS is
// missing, the calculator deliberately diverges: strategies that depend on
// mode share return a `no_acs_coverage` result for TAZs without ACS coverage
// instead of silently substituting MODE_SHARE_BY_AREA_TYPE. See
// docs (memory: feedback-acs-required).

export const BEHAVIORAL_DEFAULTS = {
  avo: 1.2,                         // NHTS 2017 national avg
  avg_commute_length_mi: 10.5,      // NHTS 2017
  avg_vehicle_trip_length_mi: 9.0,
  avg_bike_trip_length_mi: 1.5,     // NACTO bikeshare avg
  avg_walk_trip_length_mi: 0.5,     // NHTS 2017
  avg_micro_trip_length_mi: 1.0,    // NACTO shared micromobility
  daily_micro_trips_per_person: 0.05,
  annual_vehicle_ownership_cost: 12_300, // AAA 2024
  avg_transit_fare: 2.5,
  annual_bikeable_days: 230,        // CO county-avg NOAA climatology
  // Parking baselines imputed by area type (parking pricing engine). Copied
  // verbatim from scripts/strategy_calculations.py BEHAVIORAL_DEFAULTS.
  share_emp_paying_parking_urban_core: 0.55,
  share_emp_paying_parking_urban:      0.25,
  share_emp_paying_parking_suburban:   0.10,
  share_emp_paying_parking_rural:      0.05,
  current_parking_price_urban_core:   12.0,
  current_parking_price_urban:         6.0,
  current_parking_price_suburban:      3.0,
  current_parking_price_rural:         0.0,
} as const;

// Area-type mode share defaults. Used when a TAZ lacks ACS B08301 coverage
// (small / suppressed Census block groups). Values copied verbatim from
// scripts/strategy_calculations.py MODE_SHARE_BY_AREA_TYPE; see that file's
// docstring for sources (NHTS 2017, ACS S0801 ranges, CDOT/MPO surveys).
export type AreaType = "urban_core" | "urban" | "suburban" | "rural";

export const MODE_SHARE_BY_AREA_TYPE: Record<
  AreaType,
  { transit: number; auto: number; bike: number; walk: number; other: number }
> = {
  urban_core: { transit: 0.15, auto: 0.65, bike: 0.04, walk: 0.13, other: 0.03 },
  urban:      { transit: 0.06, auto: 0.81, bike: 0.02, walk: 0.08, other: 0.03 },
  suburban:   { transit: 0.02, auto: 0.92, bike: 0.01, walk: 0.03, other: 0.02 },
  rural:      { transit: 0.01, auto: 0.94, bike: 0.01, walk: 0.02, other: 0.02 },
};

export const MICRO_SUBSTITUTION_BY_TYPE: Record<
  string,
  { ratio: number; source: string }
> = {
  bikeshare:    { ratio: 0.196, source: "McQueen et al. 2020" },
  "e-bikeshare":{ ratio: 0.350, source: "Fitch et al. 2021" },
  scootershare: { ratio: 0.385, source: "McQueen et al. 2020" },
};

// Elasticities and effect sizes (Methods_Research_Updated.xlsx).
export const ELASTICITIES = {
  transit_frequency:      0.50,    // Handy 2013
  transit_service_miles:  0.75,    // TCRP 95 midpoint
  transit_fare:          -0.30,    // Paulley 2006 short-run
  parking_demand:        -0.40,
  vehicle_ownership_cost:-0.40,
  residential_density:   -0.22,    // Stevens 2016
  employment_density:    -0.07,    // Stevens 2016
  intersection_density:  -0.12,    // Stevens 2016
  bike_facility:          0.07,    // CAPCOA T-21
  induced_demand_freeway: 1.00,    // Duranton & Turner 2011 long-run
  induced_demand_arterial:0.60,
  induced_demand_collector:0.40,
} as const;

export const PROGRAM_EFFECTS = {
  tmo_voluntary_ctr_per_eligible: 0.04,   // CAPCOA TRT-1 midpoint
  parking_cashout_per_eligible:   0.12,
  commute_program_per_eligible:   0.02,   // midpoint (CAPCOA 2021 T-7 / CTR)
  commute_marketing_per_eligible: 0.01,   // marketing/outreach-only (CAPCOA 2021 T-7 low end)
  commute_incentive_per_eligible: 0.03,   // incentive-heavy campaign (2010 TRT-13 evidence)
  trip_to_vmt_factor:             1.0,    // neutral vmt↔trips ratio (parking pricing engine)
  tod_mode_share_ratio:           4.9,    // CAPCOA LUT-4
  tod_max_transit_share:          0.50,
  tod_default_pct_taz_in_tod:     0.10,
  sharrows_bike_share_boost:      0.15,
  end_of_trip_bike_share_boost:   0.05,
  transit_service_trip_reduction_ratio: 0.7,
} as const;

export const FACILITY_TO_INDUCED_ELASTICITY: Record<string, keyof typeof ELASTICITIES> = {
  freeway:        "induced_demand_freeway",
  expressway:     "induced_demand_freeway",
  major_arterial: "induced_demand_arterial",
  minor_arterial: "induced_demand_arterial",
  collector:      "induced_demand_collector",
  local:          "induced_demand_collector",
};

// Trip purpose -> share-of-daily-VMT, used to scope strategies that act only
// on commute or recreational VMT (e.g., telework, vanpool).
export const VMT_PURPOSE_SHARE = {
  all:          1.0,
  commute:      0.30,
  recreational: 0.20,
  other:        0.50,
} as const;

export type TripPurpose = keyof typeof VMT_PURPOSE_SHARE;

// Park-and-Ride (DERIVED; Duncan & Cao 2020). Mirrors PARK_AND_RIDE_DERIVED in
// scripts/strategy_calculations.py; keep in sync (this is a hand-ported complex
// strategy; the port is pinned to Python by parkAndRide.test.ts).
export const PARK_AND_RIDE_DERIVED = {
  diversion_isolated: 0.8, // D: share who would otherwise drive all the way (isolated)
  diversion_alt: 0.32, // D: with a comparable alternative facility nearby
  vnet_fallback_isolated: 19.0, // mi/round trip avoided VMT fallback (isolated; embeds D)
  vnet_fallback_alt: 10.0, // mi/round trip avoided VMT fallback (alternative; embeds D)
  utilization_default: 0.7, // occupied / total spaces (planning default)
  sanity_ceiling_pct: 0.05, // flag commute-VMT reductions above this share for review
} as const;
