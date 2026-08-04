"""
strategy_calculations.py - CDOT TDM strategy functions (engines + planner tiles).

Each function takes the per-TAZ DataFrame produced by ``prepare_taz.prepare_taz``
plus user inputs and returns a per-TAZ result table. Formulas come from
``scripts/Methods_Research_Updated.xlsx`` (the Methods sheet); related rows
from the spreadsheet were merged into a single ENGINE function with parameter
switches so the math has one home. Three additional strategies (Park and Ride,
Mobility Hub, Traffic Calming) were added beyond the spreadsheet formulas using
the alternative approaches discussed below.

This module exposes two layers:

  * ENGINE functions - the original parameter-switched implementations (one per
    formula family). These hold the math and stay callable directly: Mobility
    Hub stacks them and ``generate_golden_fixtures.py`` pins to them. They are
    retained in ``STRATEGY_REGISTRY`` under their original keys for back-compat.

  * PLANNER-FACING strategies - thin wrappers that fix an engine's switch to a
    single real-world intervention so the calculator catalog has one tile per
    concept (easier for planners to navigate, even though several tiles share
    math). They delegate to an engine and only relabel the result. These map
    1:1 to the YAML files in ``strategy-catalog/strategies/`` by id.

# Planner-facing catalog (26 tiles)
#   tile id (= STRATEGY_REGISTRY key)   ->  engine + fixed switch

  Transit
    transit_service_expansion        Transit Service Expansion (frequency basis)
    new_transit_service              New / Expanded Transit Service     (service_miles)
    transit_pass_subsidy             Transit Pass Subsidy               (fare, scope=all)
    employee_commuting_benefits      Employee Commute Benefits / ECO Pass (fare, scope=commute)
  Bike
    separated_bike_lanes             Separated & Protected Bike Lanes
    sharrows_bike_lanes              Sharrows & Painted Bike Lanes      (booster, scope=area_vmt)
    end_of_trip_facilities           End-of-Trip Bicycle Facilities     (booster, scope=commute)
    shared_micromobility             Shared Micromobility
  Land Use
    residential_density              Increase Residential Density       (density, emp=0)
    employment_density               Increase Employment Density        (density, res=0)
    transit_oriented_development     Transit Oriented Development
    affordable_housing               Affordable Housing / Infill
  Parking
    workplace_parking_pricing        Workplace Parking Pricing          (pricing, commute)
    parking_fees_curb_management     Parking Fees / Curb Management      (pricing, all)
    dynamic_parking_pricing          Dynamic Parking Pricing            (pricing, all)
    unbundled_parking                Unbundled Parking (Multifamily)
    parking_cashout                  Parking Cash-Out
  Vanpool / Programs
    vanpool                          Vanpool
    tmo_coverage                     TMO Coverage
    commute_marketing                Commute Trip-Reduction Marketing   (program, ~1%)
    commute_incentives               Commute Trip-Reduction Incentives  (program, ~3%)
    telework                         Telework
  Induced Demand
    lane_mile_addition               Lane-Mile Addition
  Additional (Handy 2025 flagged "quantification not recommended" - alternatives below)
    park_and_ride                    Park and Ride   (legacy CAPCOA 2010 T-22; dropped from 2021 handbook)
    mobility_hub                     Mobility Hub    (composite stack of constituent strategies)
    traffic_calming                  Traffic Calming (connectivity proxy OR mode-shift, basis switch)

# Engine functions (retained under their original keys for back-compat)
    transit_service_expansion   (basis switch: frequency | service_miles)
    transit_fare_subsidy        (scope switch: all | commute)
    bike_mode_share_booster     (scope switch: area_vmt | commute)
    density_change              (residential + employment density)
    parking_pricing             (trip_purpose switch: commute | all)
    commute_program             (effect-size switch: marketing | blended | incentive)

# Result schema

Every strategy returns a DataFrame with these columns (one row per input TAZ):

  taz_id              str
  strategy            str   strategy name
  inputs              str   user-supplied parameters (human-readable)
  base_vmt_purpose    str   'all' | 'commute' | 'recreational'
  base_vmt            float VMT the elasticity is applied to (mi/day)
  pct_vmt_reduction   float negative = reduction (fraction, not percent)
  daily_vmt_reduction float positive = miles saved per day (= -base_vmt * pct)
  data_assumptions    str   semicolon-separated list of defaults used. EMPTY
                            when the calc ran entirely on observed TAZ data.

# Sign convention

  pct_vmt_reduction  < 0  => VMT reduction (good)
  pct_vmt_reduction  > 0  => VMT increase  (induced demand, fare hike, etc.)
  daily_vmt_reduction > 0 => miles saved per day
  daily_vmt_reduction < 0 => miles added per day

# Behavioral defaults (used when the TDM lacks the input)

When the CDOT custom TDM extract is available (loaded by ``prepare_taz`` from
``data/TDM Custom Output/HighStreetData_ExtraTAZData.xlsx``), the prepared TAZ
table carries observed per-TAZ ``avo`` and a per-TAZ VMT-by-purpose split
(``vmt_share_commute`` / ``vmt_share_recreational`` / ``vmt_share_other``).
``add_imputed_avo`` and ``_base_vmt`` use these wherever present and fall back
to the statewide constants otherwise; each result row's ``data_assumptions``
flags whether the observed value or the default was used.

The prepared TAZ table still does NOT carry: mode share, current parking price,
share of employees paying for parking, average transit fare, vehicle ownership
cost, bike/micromobility trip lengths, or annual bikeable days. These are
imputed from the area-type defaults in ``MODE_SHARE_BY_AREA_TYPE`` and
``BEHAVIORAL_DEFAULTS``. Callers can override per-TAZ by adding the matching
column to the prepared DataFrame before invoking a strategy. Every result row
flags which defaults were used.

# Stacking

Combine multiple strategies multiplicatively:  retained_vmt = product(1 + r_i)
where r_i is each strategy's ``pct_vmt_reduction``. Some pairs target the same
employee decision and must NOT be stacked (e.g., Parking Pricing with
trip_purpose='commute' + Parking Cash-Out).
"""

from __future__ import annotations

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Constants & defaults
# ---------------------------------------------------------------------------

# Behavioral inputs the TDM TAZ does not carry. Override per-TAZ by adding
# the corresponding column to the prepared DataFrame.
BEHAVIORAL_DEFAULTS: dict[str, float] = {
    "avo":                           1.20,    # NHTS 2017 national avg
    "avg_commute_length_mi":        10.5,    # NHTS 2017
    "avg_vehicle_trip_length_mi":   9.0,
    "avg_bike_trip_length_mi":      1.5,     # NACTO bikeshare avg
    "avg_walk_trip_length_mi":      0.5,     # NHTS 2017
    "avg_micro_trip_length_mi":     1.0,     # NACTO shared micromobility
    "daily_micro_trips_per_person": 0.05,
    "micro_substitution_ratio":     0.20,    # legacy: blended default (used only when type is unspecified)
    "annual_vehicle_ownership_cost":12_300,  # AAA 2024 "Your Driving Costs"
    "avg_transit_fare":             2.50,    # statewide blended (RTD ~$3, MMT ~$1.50)
    "annual_bikeable_days":         230,     # CO county-avg NOAA climatology
    "share_emp_paying_parking_urban_core": 0.55,
    "share_emp_paying_parking_urban":      0.25,
    "share_emp_paying_parking_suburban":   0.10,
    "share_emp_paying_parking_rural":      0.05,
    "current_parking_price_urban_core":   12.0,
    "current_parking_price_urban":         6.0,
    "current_parking_price_suburban":      3.0,
    "current_parking_price_rural":         0.0,
}

# Area-type defaults for mode share. Rough state-CO values combining NHTS 2017,
# ACS S0801 ranges, and CDOT/MPO surveys. Each row sums to 1.0.
MODE_SHARE_BY_AREA_TYPE: dict[str, dict[str, float]] = {
    # area_type:  transit, auto,  bike,  walk,  other
    "urban_core": {"transit": 0.15, "auto": 0.65, "bike": 0.04, "walk": 0.13, "other": 0.03},
    "urban":      {"transit": 0.06, "auto": 0.81, "bike": 0.02, "walk": 0.08, "other": 0.03},
    "suburban":   {"transit": 0.02, "auto": 0.92, "bike": 0.01, "walk": 0.03, "other": 0.02},
    "rural":      {"transit": 0.01, "auto": 0.94, "bike": 0.01, "walk": 0.02, "other": 0.02},
}

# Shared-micromobility substitution ratios by service type. The substitution
# ratio is the share of micromobility trips that replace what would otherwise
# have been an auto trip (vs. replacing walk / transit / induced trips).
# CAPCOA's updated micromobility guidance uses different ratios per type since
# e-bikes and scooters tend to capture longer / more auto-substituting trips
# than pedal bikeshare.
MICRO_SUBSTITUTION_BY_TYPE: dict[str, dict[str, str | float]] = {
    "bikeshare":   {"ratio": 0.196, "source": "McQueen et al. 2020"},
    "e-bikeshare": {"ratio": 0.350, "source": "Fitch et al. 2021"},
    "scootershare":{"ratio": 0.385, "source": "McQueen et al. 2020"},
}

# Elasticities and effect sizes sourced from Methods_Research_Updated.xlsx
# Sources & Notes sheet. Each is keyed for traceability.
ELASTICITIES: dict[str, float] = {
    "transit_frequency":         0.50,   # Handy 2013
    "transit_service_miles":     0.75,   # TCRP 95 midpoint (0.7-0.8)
    "transit_fare":             -0.30,   # Paulley 2006 short-run
    "parking_demand":           -0.40,   # Lehner & Peer 2019
    "vehicle_ownership_cost":   -0.40,   # Litman 2020
    "residential_density":      -0.22,   # Stevens 2016
    "employment_density":       -0.07,   # Stevens 2016
    "intersection_density":     -0.12,   # Stevens 2016 (used by Traffic Calming connectivity basis)
    "bike_facility":             0.07,   # CAPCOA 2021 T-19-A effect size (positive magnitude)
    "induced_demand_freeway":    1.00,   # Duranton & Turner 2011 long-run
    "induced_demand_arterial":   0.60,
    "induced_demand_collector":  0.40,
}

# Pre-quantified program effect sizes (used where elasticity isn't appropriate).
PROGRAM_EFFECTS: dict[str, float] = {
    "tmo_voluntary_ctr_per_eligible":    0.04,  # CAPCOA 2021 T-5 midpoint (formerly TRT-1)
    "parking_cashout_per_eligible":      0.12,  # CAPCOA 2021 T-13 midpoint (formerly TRT-15)
    "commute_program_per_eligible":      0.02,  # midpoint of CAPCOA 2021 T-7 marketing (1%) and CTR program ranges
    "commute_marketing_per_eligible":    0.01,  # marketing/outreach-only (CAPCOA 2021 T-7 low end)
    "commute_incentive_per_eligible":    0.03,  # incentive-heavy campaign (2010 TRT-13 evidence base)
    "tod_mode_share_ratio":              4.9,   # CAPCOA 2021 T-3 (formerly LUT-4) - TOD transit MS / area transit MS
    "tod_max_transit_share":             0.50,  # realistic ceiling for TOD-resident transit MS
    "tod_default_pct_taz_in_tod":        0.10,  # default share of TAZ within TOD walkshed
    "sharrows_bike_share_boost":         0.15,  # default for scope='area_vmt' (CAPCOA 2021 T-19-A / T-20)
    "end_of_trip_bike_share_boost":      0.05,  # default for scope='commute' (CAPCOA 2021 T-10)
    "traffic_calming_bike_share_boost":  0.08,  # CAPCOA 2021 T-19-A midpoint (formerly T-19)
    "traffic_calming_walk_share_boost":  0.10,  # CAPCOA 2021 T-18 Pedestrian Network (formerly T-20)
    "mobility_hub_composite_discount":   0.80,  # discount factor for stacked-effect double-counting
    "affordable_housing_vmt_reduction":  0.06,  # CAPCOA 2021 T-4 per-unit (formerly LU-1)
    "vehicle_ownership_to_vmt_factor":   0.50,  # share of ownership change that becomes VMT change
    "trip_to_vmt_factor":                1.00,  # neutral; tune if trip-based reductions need scaling
    "transit_service_trip_reduction_ratio": 0.7,
}

# Map facility class string to induced-demand elasticity key.
FACILITY_TO_INDUCED_ELASTICITY: dict[str, str] = {
    "freeway":            "induced_demand_freeway",
    "expressway":         "induced_demand_freeway",
    "major_arterial":     "induced_demand_arterial",
    "minor_arterial":     "induced_demand_arterial",
    "collector":          "induced_demand_collector",
    "local":              "induced_demand_collector",
}

# VMT-by-purpose share assumption (TDM doesn't split by purpose - same default
# used in prepare_taz). Replace with calibrated CDOT figures when available.
VMT_PURPOSE_SHARE: dict[str, float] = {
    "commute":      0.30,
    "recreational": 0.20,
    "other":        0.50,
}


# ---------------------------------------------------------------------------
# Method constants for the six CAPCOA / derived strategies
#   (source: tdm_strategy_methods.md — Implementation Spec)
#
# These six methods follow the CAPCOA combination framework. Subsector caps
# (Plan/Community scale) are applied per measure; the calculator's stacking
# layer is responsible for the within-subsector multiplicative combination and
# the multi-subsector 70% cap. Each measure here applies its own measure max /
# subsector cap before returning, so a single-measure run is already bounded.
# ---------------------------------------------------------------------------

# CAPCOA Plan/Community-scale subsector caps (Handbook Ch. 3, pp. 62-65).
CAPCOA_SUBSECTOR_CAPS: dict[str, float] = {
    "neighborhood_design": 0.10,   # T-18..T-22 (incl. SDT-2 legacy, Carshare, Wayfinding-active)
    "transit":             0.15,   # T-25..T-29, T-46 (incl. Wayfinding-transit)
}

# 1. Traffic Calming (CAPCOA 2010 SDT-2). LEGACY: reclassified as the
# non-quantified Measure T-35 in the 2021/2024 Handbook. Retained per client
# request for a standalone traffic-calming credit; flagged as legacy in output.
TRAFFIC_CALMING_SDT2: dict[str, float] = {
    "min_effect": 0.0025,   # 0.25% VMT (CAPCOA 2010 SDT-2 low end)
    "max_effect": 0.0100,   # 1.00% VMT (CAPCOA 2010 SDT-2 high end = measure max)
}

# 2. Carshare (CAPCOA T-21). The verbatim T-21 equation and its constants were
# NOT captured during research and the fact-sheet PDF was unreachable at
# implementation time (HTTP 404). The values below are LABELED PLACEHOLDERS,
# exposed here so the team can recalibrate without code changes. Confirm
# against the T-21 fact sheet before locking (spec §2, outstanding item #1).
# The structural form used is unit-consistent: area VMT reduction is the share
# of the population who become members times the per-member VMT reduction
# fraction, capped at the measure/subsector max.
CARSHARE_T21: dict[str, float] = {
    "participation_rate":  0.02,   # PLACEHOLDER: share of service-area residents who join
    "member_vmt_reduction": 0.30,  # PLACEHOLDER: per-member VMT reduction fraction
    "measure_max": 0.10,           # Neighborhood Design subsector cap (stand-in for measure max)
}

# 3. Transit Shelters (CAPCOA T-46). Verbatim T-46 equation/constants likewise
# NOT captured (fact-sheet PDF unreadable at implementation time).
# shelter_ridership_uplift and measure_max are LABELED PLACEHOLDERS - confirm
# against the T-46 fact sheet (spec §3, outstanding item #2). The ridership ->
# VMT conversion reuses the T-26 machinery, with the FHWA mode-shift factor G
# (=1/avg occupancy) replaced by the per-TAZ observed AVO where available.
TRANSIT_SHELTERS_T46: dict[str, float] = {
    "shelter_ridership_uplift": 0.0050,  # PLACEHOLDER: ridership uplift at improved stops
    "measure_max": 0.15,                 # Transit subsector cap (stand-in for measure max)
}

# 4. Pedestrian Network Improvements (CAPCOA T-18). Fully verified/verbatim.
PED_NETWORK_T18: dict[str, float] = {
    "elasticity": -0.05,   # household VMT w.r.t. sidewalk-to-street ratio (Frank 2011; Handy 2014)
    "measure_max": 0.064,  # 6.4% measure maximum (FHWA 2019 short-trip derivation; spec §4)
}

# 5. Park-and-Ride (DERIVED; Duncan & Cao 2020). Defensible for the US
# auto-oriented commuter context that matches Colorado (spec §5).
PARK_AND_RIDE_DERIVED: dict[str, float] = {
    "diversion_isolated":     0.80,  # D: share who would otherwise drive all the way (isolated facility)
    "diversion_alt":          0.32,  # D: with a comparable alternative facility nearby
    "vnet_fallback_isolated": 19.0,  # mi/round trip avoided VMT fallback (isolated; embeds diversion)
    "vnet_fallback_alt":      10.0,  # mi/round trip avoided VMT fallback (alternative; embeds diversion)
    "utilization_default":    0.70,  # occupied / total spaces (planning default)
    "sanity_ceiling_pct":     0.05,  # flag commute-VMT reductions above this share for review
    # Commute share of DRIVE-ACCESS transit trips. Scopes the demand ceiling when
    # the user supplies a TOTAL daily transit trip count (the number agencies can
    # actually source) instead of a commute-only count.
    # PLACEHOLDER pending a Colorado source: the CDOT 2019 model's transit
    # matrices are segmented by access mode (Dacc/Wacc), not trip purpose, and the
    # custom TAZ extract splits VMT by purpose for autos only - neither yields a
    # transit trip-purpose split. 0.80 is the agreed interim value (2026-07-27).
    # It applies to the drive-access subset, NOT to transit ridership overall:
    # park-and-ride parking is dominated by all-day, peak-period commute use, so
    # its commute share is far higher than transit's commute share generally.
    "commute_share_of_drive_access": 0.80,
}

# 6. Wayfinding (DERIVED, two-channel; assumption-bounded). No empirical VMT
# effect size exists for wayfinding in any mode; this credits a small, capped,
# mode-specific friction-reduction uplift routed through the T-26 (transit) and
# T-18 (active) conversion machinery. Uplifts are the agreed conservative
# defaults, exposed here for recalibration (spec §6, outstanding item #5).
WAYFINDING_DERIVED: dict[str, float] = {
    "ridership_uplift":     0.0025,  # transit channel assumed ridership uplift (0.25%)
    "connectivity_uplift":  0.0025,  # active-mode channel assumed connectivity uplift (0.25%)
    "ped_elasticity":      -0.05,    # borrowed T-18 elasticity (structure, not a measured effect)
    "channel_cap":          0.005,   # 0.5% per-channel cap (guardrail)
}


# ---------------------------------------------------------------------------
# Imputation helpers
# ---------------------------------------------------------------------------

def add_imputed_mode_shares(taz_df: pd.DataFrame,
                            mode_share_table: dict | None = None,
                            source: str = "auto") -> pd.DataFrame:
    """
    Add ``transit/auto/bike/walk_mode_share`` columns to the prepared TAZ table.

    ``source`` controls where the values come from:

      ``'auto'`` (default)
        Per-TAZ ACS commute mode share from prepare_taz (columns
        ``acs_transit_share`` etc.) takes precedence wherever it is present.
        TAZs with no ACS coverage fall back to area-type defaults.
        ``mode_share_basis`` is set per-row to ``'acs_b08301_commute'``
        when ACS is used, ``'imputed_from_area_type'`` otherwise.

      ``'area_type'``
        Always use the area-type defaults in ``mode_share_table``
        (backwards-compatible behavior).

      ``'acs'``
        ACS-only. TAZs without ACS coverage get NaN mode shares.

    Notes:
      - ACS B08301 is COMMUTE mode share. For all-trip strategies this slightly
        overstates auto share (commute is more auto-skewed than the all-trip
        mix). Pragmatic; better than the area-type defaults regardless.
      - ACS doesn't report walk and other separately the same way the area-type
        table does. We map ACS columns to:
            transit = acs_transit_share
            auto    = acs_drove_alone_share + acs_carpool_share
            bike    = acs_bike_share
            walk    = acs_walk_share
        The remainder (taxi/moto/other + wfh) is left out of the four canonical
        shares; sums need not equal 1.0 when ACS is the source.
    """
    out = taz_df.copy()
    if source not in ("auto", "area_type", "acs"):
        raise ValueError("source must be 'auto', 'area_type', or 'acs'")

    has_acs = "acs_transit_share" in out.columns and out["acs_transit_share"].notna().any()
    use_acs_per_row = pd.Series(False, index=out.index)

    if has_acs and source in ("auto", "acs"):
        use_acs_per_row = out["acs_transit_share"].notna()

    table = mode_share_table or MODE_SHARE_BY_AREA_TYPE
    fallback = table.get("rural", {})

    def _area_type_share(area_type, key):
        return table.get(area_type, fallback).get(key, 0.0)

    if source != "acs":
        area_transit = out["area_type"].map(lambda t: _area_type_share(t, "transit"))
        area_auto    = out["area_type"].map(lambda t: _area_type_share(t, "auto"))
        area_bike    = out["area_type"].map(lambda t: _area_type_share(t, "bike"))
        area_walk    = out["area_type"].map(lambda t: _area_type_share(t, "walk"))
    else:
        area_transit = area_auto = area_bike = area_walk = pd.Series(np.nan, index=out.index)

    if has_acs:
        acs_transit = out["acs_transit_share"]
        acs_auto    = out["acs_drove_alone_share"].fillna(0) + out["acs_carpool_share"].fillna(0)
        acs_bike    = out["acs_bike_share"]
        acs_walk    = out["acs_walk_share"]
    else:
        acs_transit = acs_auto = acs_bike = acs_walk = pd.Series(np.nan, index=out.index)

    out["transit_mode_share"] = acs_transit.where(use_acs_per_row, area_transit)
    out["auto_mode_share"]    = acs_auto.where(use_acs_per_row, area_auto)
    out["bike_mode_share"]    = acs_bike.where(use_acs_per_row, area_bike)
    out["walk_mode_share"]    = acs_walk.where(use_acs_per_row, area_walk)

    basis = pd.Series("imputed_from_area_type", index=out.index)
    basis[use_acs_per_row] = "acs_b08301_commute"
    if source == "acs":
        basis[~use_acs_per_row] = "no_acs_coverage"
    out["mode_share_basis"] = basis
    return out


def add_imputed_avo(taz_df: pd.DataFrame, avo: float | None = None) -> pd.DataFrame:
    """
    Ensure an ``avo`` column exists, and tag its provenance in ``avo_basis``.

    Precedence:
      * a per-TAZ ``avo`` column already on the table (the CDOT TDM extract
        populates this via ``prepare_taz``) is used wherever it is non-null;
      * any remaining rows fall back to ``avo`` (the explicit argument) or the
        statewide ``BEHAVIORAL_DEFAULTS['avo']``.

    ``avo_basis`` is set per-row to ``'tdm_model'`` where the observed value was
    used and ``'statewide_default'`` where the fallback filled in. Returns a copy.
    """
    out = taz_df.copy()
    default = avo if avo is not None else BEHAVIORAL_DEFAULTS["avo"]
    if "avo" in out.columns:
        observed = pd.to_numeric(out["avo"], errors="coerce")
        out["avo_basis"] = np.where(observed.notna(), "tdm_model", "statewide_default")
        out["avo"] = observed.fillna(default)
    else:
        out["avo"] = default
        out["avo_basis"] = "statewide_default"
    return out


def add_imputed_parking(taz_df: pd.DataFrame) -> pd.DataFrame:
    """Add ``current_parking_price`` and ``share_emp_paying_parking`` columns
    keyed on ``area_type``. Returns a copy."""
    out = taz_df.copy()
    price_map = {
        "urban_core": BEHAVIORAL_DEFAULTS["current_parking_price_urban_core"],
        "urban":      BEHAVIORAL_DEFAULTS["current_parking_price_urban"],
        "suburban":   BEHAVIORAL_DEFAULTS["current_parking_price_suburban"],
        "rural":      BEHAVIORAL_DEFAULTS["current_parking_price_rural"],
    }
    share_map = {
        "urban_core": BEHAVIORAL_DEFAULTS["share_emp_paying_parking_urban_core"],
        "urban":      BEHAVIORAL_DEFAULTS["share_emp_paying_parking_urban"],
        "suburban":   BEHAVIORAL_DEFAULTS["share_emp_paying_parking_suburban"],
        "rural":      BEHAVIORAL_DEFAULTS["share_emp_paying_parking_rural"],
    }
    if "current_parking_price" not in out.columns:
        out["current_parking_price"] = out["area_type"].map(price_map).fillna(0.0)
    if "share_emp_paying_parking" not in out.columns:
        out["share_emp_paying_parking"] = out["area_type"].map(share_map).fillna(0.05)
    return out


# ---------------------------------------------------------------------------
# Result formatting helpers
# ---------------------------------------------------------------------------

_PURPOSE_TO_SHARE = {
    "all":          1.0,
    "commute":      VMT_PURPOSE_SHARE["commute"],
    "recreational": VMT_PURPOSE_SHARE["recreational"],
    "other":        VMT_PURPOSE_SHARE["other"],
}


def _base_vmt(taz_df: pd.DataFrame, purpose: str = "all") -> pd.Series:
    """
    Return the VMT base for a given trip purpose.

    For purposes other than ``'all'``, a per-TAZ purpose split from the CDOT TDM
    extract (``vmt_share_commute`` / ``vmt_share_recreational`` /
    ``vmt_share_other``, added by ``prepare_taz``) is used wherever present;
    rows without it fall back to the statewide ``VMT_PURPOSE_SHARE`` constant.
    """
    if purpose not in _PURPOSE_TO_SHARE:
        raise ValueError(f"purpose must be one of {list(_PURPOSE_TO_SHARE)}")
    daily = taz_df["daily_vmt"].fillna(0.0)
    if purpose == "all":
        return daily * 1.0

    share_col = f"vmt_share_{purpose}"
    default_share = _PURPOSE_TO_SHARE[purpose]
    if share_col in taz_df.columns:
        share = pd.to_numeric(taz_df[share_col], errors="coerce").fillna(default_share)
    else:
        share = pd.Series(default_share, index=taz_df.index)
    return daily * share


def _avo_assumption(taz_df: pd.DataFrame) -> str:
    """Summarise AVO provenance into a single ``data_assumptions`` flag."""
    if "avo_basis" not in taz_df.columns:
        return "avo=statewide_default"
    n_obs = (taz_df["avo_basis"] == "tdm_model").sum()
    if n_obs == len(taz_df):
        return "avo=tdm_model"
    if n_obs == 0:
        return "avo=statewide_default"
    return "avo=tdm_model_where_available"


def _purpose_assumption(taz_df: pd.DataFrame, purpose: str) -> str:
    """Summarise VMT-purpose-split provenance into a single flag (no flag for 'all')."""
    if purpose == "all":
        return ""
    share_col = f"vmt_share_{purpose}"
    if share_col not in taz_df.columns:
        return "vmt_purpose=statewide_default_split"
    n_obs = pd.to_numeric(taz_df[share_col], errors="coerce").notna().sum()
    if n_obs == len(taz_df):
        return "vmt_purpose=tdm_model"
    if n_obs == 0:
        return "vmt_purpose=statewide_default_split"
    return "vmt_purpose=tdm_model_where_available"


def _result(taz_df: pd.DataFrame,
            strategy: str,
            inputs: str,
            pct_red: pd.Series | float,
            base_vmt: pd.Series,
            assumptions: pd.Series | str,
            purpose: str = "all") -> pd.DataFrame:
    """Assemble the canonical result DataFrame."""
    if np.ndim(pct_red) == 0:
        pct_red = pd.Series(pct_red, index=taz_df.index)
    if isinstance(assumptions, str):
        assumptions = pd.Series(assumptions, index=taz_df.index)
    return pd.DataFrame({
        "taz_id":              taz_df["taz_id"].values,
        "strategy":            strategy,
        "inputs":              inputs,
        "base_vmt_purpose":    purpose,
        "base_vmt":            base_vmt.values,
        "pct_vmt_reduction":   pct_red.values,
        "daily_vmt_reduction": (-base_vmt.values * pct_red.values),
        "data_assumptions":    assumptions.values,
    })


def _join_assumptions(*parts: str) -> str:
    """Combine non-empty assumption flags into a single semicolon-joined string."""
    return "; ".join(p for p in parts if p)


# ===========================================================================
#                                   TRANSIT
# ===========================================================================

def strategy_transit_service_expansion(
    taz_df: pd.DataFrame,
    pct_change: float,
    basis: str = "frequency",
    level_of_implementation: float = 1.0,
    elasticity: float | None = None,
    trip_reduction_ratio: float | None = None,
) -> pd.DataFrame:
    """
    1. Transit Service Expansion.

    Covers Methods rows 1, 2, 3 (Increased Frequency, New Intercity Service,
    New Local Service). ``basis`` selects the elasticity and formula form:

      basis='frequency'       (Handy 2013, ε=0.50)
        %ΔVMT = -L * (pct_change * transit_MS * ε * 1/AVO) / auto_MS

      basis='service_miles'   (TCRP 95, ε=0.75)
        %ΔVMT = -L * pct_change * transit_MS * ε * (1/AVO) * trip_reduction_ratio

    ``pct_change`` is signed: positive = service expansion, negative = service cut.

    Data assumptions: transit/auto mode share and AVO are imputed from
    ``area_type`` defaults when not in the TAZ table.
    """
    if basis not in ("frequency", "service_miles"):
        raise ValueError("basis must be 'frequency' or 'service_miles'")
    if elasticity is None:
        elasticity = ELASTICITIES["transit_frequency"] if basis == "frequency" \
            else ELASTICITIES["transit_service_miles"]
    if trip_reduction_ratio is None:
        trip_reduction_ratio = PROGRAM_EFFECTS["transit_service_trip_reduction_ratio"]

    df = add_imputed_avo(add_imputed_mode_shares(taz_df))
    if basis == "frequency":
        pct = -level_of_implementation * (
            pct_change * df["transit_mode_share"] * elasticity * (1.0 / df["avo"])
        ) / df["auto_mode_share"].clip(lower=1e-9)
    else:  # service_miles
        pct = -level_of_implementation * pct_change * df["transit_mode_share"] \
              * elasticity * (1.0 / df["avo"]) * trip_reduction_ratio

    inputs = (f"basis={basis}, Δ={pct_change:+.0%}, L={level_of_implementation:.0%}, "
              f"ε={elasticity}"
              + (f", trip_red_ratio={trip_reduction_ratio}" if basis == "service_miles" else ""))
    assumptions = pd.Series(_join_assumptions(
        "mode_share=imputed_from_area_type",
        _avo_assumption(df),
    ), index=df.index)
    return _result(df, "Transit Service Expansion", inputs, pct,
                   _base_vmt(df, "all"), assumptions)


def strategy_new_transit_service(
    taz_df: pd.DataFrame,
    pct_change: float,
    level_of_implementation: float = 1.0,
    elasticity: float | None = None,
    trip_reduction_ratio: float | None = None,
) -> pd.DataFrame:
    """
    New / Expanded Transit Service (planner-facing tile).

    Thin wrapper over :func:`strategy_transit_service_expansion` fixed to
    ``basis='service_miles'`` (TCRP 95, ε=0.75) - the new-route / new-revenue-
    mile framing, as distinct from the headway-improvement framing of the
    Transit Service Expansion (frequency) tile. Math is identical to the
    engine's service-miles branch.
    """
    res = strategy_transit_service_expansion(
        taz_df, pct_change, basis="service_miles",
        level_of_implementation=level_of_implementation,
        elasticity=elasticity, trip_reduction_ratio=trip_reduction_ratio,
    )
    res["strategy"] = "New / Expanded Transit Service"
    return res


def strategy_transit_fare_subsidy(
    taz_df: pd.DataFrame,
    pct_fare_reduction: float | None = None,
    subsidy_amount: float | None = None,
    avg_fare: float | None = None,
    pct_eligible: float = 1.0,
    scope: str = "all",
    pct_otherwise_drive: float = 0.85,
    elasticity: float | None = None,
) -> pd.DataFrame:
    """
    2. Transit Fare Subsidy.

    Covers Methods rows 18 and 22 (Pass Subsidy + Employee Commute Benefits /
    ECO Pass). Provide EITHER ``pct_fare_reduction`` (positive magnitude,
    e.g. 0.50 = 50% off) OR ``subsidy_amount`` together with ``avg_fare`` —
    in which case pct_fare_reduction = subsidy_amount / avg_fare.

      scope='all'      general fare subsidy (Methods row 22)
        %ΔVMT = (pct_fare_red * eligible * ε * transit_MS * 1/AVO) / auto_MS

      scope='commute'  employer/ECO-Pass subsidy (Methods row 18)
        %ΔCommute VMT = (pct_fare_red * eligible * ε * transit_MS
                         * 1/AVO * pct_otherwise_drive) / auto_MS

    ε defaults to -0.30 (Paulley 2006 short-run fare elasticity).
    """
    if scope not in ("all", "commute"):
        raise ValueError("scope must be 'all' or 'commute'")
    if pct_fare_reduction is None:
        if subsidy_amount is None:
            raise ValueError("Provide either pct_fare_reduction or subsidy_amount.")
        fare = avg_fare if avg_fare is not None else BEHAVIORAL_DEFAULTS["avg_transit_fare"]
        pct_fare_reduction = subsidy_amount / fare
    else:
        fare = avg_fare
    if elasticity is None:
        elasticity = ELASTICITIES["transit_fare"]

    df = add_imputed_avo(add_imputed_mode_shares(taz_df))
    pct = (pct_fare_reduction * pct_eligible * elasticity
           * df["transit_mode_share"] * (1.0 / df["avo"])) \
          / df["auto_mode_share"].clip(lower=1e-9)
    if scope == "commute":
        pct = pct * pct_otherwise_drive

    if subsidy_amount is not None:
        inputs = (f"subsidy=${subsidy_amount:.2f}/avg_fare=${fare:.2f} "
                  f"({pct_fare_reduction:.0%} effective), eligible={pct_eligible:.0%}, "
                  f"scope={scope}, ε={elasticity}")
        used_fare_default = avg_fare is None
    else:
        inputs = (f"Δfare={pct_fare_reduction:.0%}, eligible={pct_eligible:.0%}, "
                  f"scope={scope}, ε={elasticity}")
        used_fare_default = False

    purpose = "commute" if scope == "commute" else "all"
    assumptions = pd.Series(_join_assumptions(
        "mode_share=imputed_from_area_type",
        _avo_assumption(df),
        _purpose_assumption(df, purpose),
        "avg_transit_fare=statewide_default" if used_fare_default else "",
    ), index=df.index)
    return _result(df, "Transit Fare Subsidy", inputs, pct,
                   _base_vmt(df, purpose), assumptions, purpose=purpose)


def strategy_transit_pass_subsidy(
    taz_df: pd.DataFrame,
    pct_fare_reduction: float | None = None,
    subsidy_amount: float | None = None,
    avg_fare: float | None = None,
    pct_eligible: float = 1.0,
    elasticity: float | None = None,
) -> pd.DataFrame:
    """
    Transit Pass Subsidy (planner-facing tile).

    General, all-trip fare reduction / pass subsidy. Wrapper over
    :func:`strategy_transit_fare_subsidy` fixed to ``scope='all'``.
    """
    res = strategy_transit_fare_subsidy(
        taz_df, pct_fare_reduction=pct_fare_reduction, subsidy_amount=subsidy_amount,
        avg_fare=avg_fare, pct_eligible=pct_eligible, scope="all", elasticity=elasticity,
    )
    res["strategy"] = "Transit Pass Subsidy"
    return res


def strategy_employee_commute_benefits(
    taz_df: pd.DataFrame,
    pct_fare_reduction: float | None = None,
    subsidy_amount: float | None = None,
    avg_fare: float | None = None,
    pct_eligible: float = 1.0,
    pct_otherwise_drive: float = 0.85,
    elasticity: float | None = None,
) -> pd.DataFrame:
    """
    Employee Commute Benefits / ECO Pass (planner-facing tile).

    Employer-provided commute fare benefit, scoped to commute VMT. Wrapper over
    :func:`strategy_transit_fare_subsidy` fixed to ``scope='commute'``.
    """
    res = strategy_transit_fare_subsidy(
        taz_df, pct_fare_reduction=pct_fare_reduction, subsidy_amount=subsidy_amount,
        avg_fare=avg_fare, pct_eligible=pct_eligible, scope="commute",
        pct_otherwise_drive=pct_otherwise_drive, elasticity=elasticity,
    )
    res["strategy"] = "Employee Commute Benefits / ECO Pass"
    return res


# ===========================================================================
#                                   BIKE
# ===========================================================================

def strategy_separated_bike_lanes(
    taz_df: pd.DataFrame,
    pct_parallel_vmt_affected: float,
    annual_use_days: float | None = None,
    avg_bike_trip_length: float | None = None,
    elasticity: float | None = None,
) -> pd.DataFrame:
    """
    3. Separated & Protected Bike Lanes.

    Methods row 4.
    %ΔVMT = -pct_parallel_vmt * (annual_use_days/365) * ε
            * avg_bike_trip_len / avg_vehicle_trip_len

    Bikeable days are an estimate of how many days per year are comfortable
    for cycling - specifically, days where the typical daytime high is between
    32°F and 95°F, adjusted for the chance of rain or snow on that calendar
    day. The estimate uses 30-year climate averages from NOAA weather stations
    across Colorado, and each TAZ gets its own value by taking a weighted
    average of the five nearest stations (closer stations count more). The
    underlying data is fetched and cached by
    ``scripts/fetch_background_data.py``.

    Data assumptions:
      - annual_use_days: per-TAZ IDW value from NOAA daily normals when
        available, then county mean, then statewide default (230)
      - avg_bike_trip_length defaults to 1.5 mi (NACTO)
      - avg_vehicle_trip_length uses per-TAZ ``avg_trip_length``;
        falls back to 9.0 mi for TAZs with no reliable value
      - ε defaults to +0.07 (CAPCOA 2021 T-19-A "Construct or Improve Bike Facility" effect-size midpoint)
    """
    if elasticity is None:
        elasticity = ELASTICITIES["bike_facility"]
    if avg_bike_trip_length is None:
        avg_bike_trip_length = BEHAVIORAL_DEFAULTS["avg_bike_trip_length_mi"]
    veh_len = taz_df["avg_trip_length"].fillna(BEHAVIORAL_DEFAULTS["avg_vehicle_trip_length_mi"])

    # Per-TAZ annual bikeable days, preferring per-TAZ IDW interpolation, then
    # county mean, then statewide default. If the caller passed a scalar
    # ``annual_use_days``, it overrides all three sources.
    if annual_use_days is not None:
        days = pd.Series(annual_use_days, index=taz_df.index)
        days_source = "user_specified"
    elif "annual_bikeable_days_taz" in taz_df.columns \
            and taz_df["annual_bikeable_days_taz"].notna().any():
        # IDW-interpolated per-TAZ value, statewide default for any row that
        # somehow lacks one. The interpolation draws from the k nearest stations
        # regardless of county, so in practice it is populated for every TAZ.
        #
        # There used to be an annual_bikeable_days_county step in between. It was
        # dropped: that column is a QA/overview aggregate of stations falling
        # INSIDE each county, so it is null for the 39 of Colorado's 64 counties
        # that contain no NOAA station — it was 45% populated, and measurably
        # never reached, because the IDW column is 100% populated.
        days = taz_df["annual_bikeable_days_taz"].fillna(
            BEHAVIORAL_DEFAULTS["annual_bikeable_days"])
        days_source = "noaa_taz_idw"
    else:
        days = pd.Series(BEHAVIORAL_DEFAULTS["annual_bikeable_days"], index=taz_df.index)
        days_source = "statewide_default"

    pct = -pct_parallel_vmt_affected * (days / 365.0) * elasticity \
          * avg_bike_trip_length / veh_len.clip(lower=0.5)
    inputs = (f"parallel_vmt={pct_parallel_vmt_affected:.0%}, "
              f"days_source={days_source} (median={days.median():.0f}), "
              f"bike_len={avg_bike_trip_length:.1f}mi, ε={elasticity}")
    assumptions = pd.Series(_join_assumptions(
        f"annual_use_days={days_source}",
        "avg_bike_trip_length=NACTO_default",
    ), index=taz_df.index)
    return _result(taz_df, "Separated & Protected Bike Lanes", inputs, pct,
                   _base_vmt(taz_df, "all"), assumptions)


def strategy_bike_mode_share_booster(
    taz_df: pd.DataFrame,
    scope_share: float,
    scope: str = "area_vmt",
    adjustment_factor: float | None = None,
    avg_bike_trip_length: float | None = None,
) -> pd.DataFrame:
    """
    4. Bike Mode-Share Booster.

    Covers Methods rows 5 and 23 (Sharrows / Bike Lane + End-of-Trip
    Facilities). The intervention boosts bike mode share by
    ``adjustment_factor`` and the boost is applied to a fraction of trips
    given by ``scope_share``:

      scope='area_vmt'   sharrows / bike lane across an area (Methods row 5)
        %ΔVMT = -scope_share * bike_len * (bike_MS * adj) / (veh_len * auto_MS)

      scope='commute'    end-of-trip facilities at workplaces (Methods row 23)
        %ΔCommute VMT = -scope_share * bike_len * (bike_MS * adj) / (veh_len * auto_MS)

    Defaults for adjustment_factor:
      area_vmt = +0.15 (CAPCOA 2021 T-19-A / T-20 bike facility / network expansion)
      commute  = +0.05 (CAPCOA 2021 T-10 "Provide End-of-Trip Bicycle Facilities")
    """
    if scope not in ("area_vmt", "commute"):
        raise ValueError("scope must be 'area_vmt' or 'commute'")
    if adjustment_factor is None:
        adjustment_factor = PROGRAM_EFFECTS["sharrows_bike_share_boost"] if scope == "area_vmt" \
            else PROGRAM_EFFECTS["end_of_trip_bike_share_boost"]
    if avg_bike_trip_length is None:
        avg_bike_trip_length = BEHAVIORAL_DEFAULTS["avg_bike_trip_length_mi"]

    df = add_imputed_mode_shares(taz_df)
    veh_len = df["avg_trip_length"].fillna(BEHAVIORAL_DEFAULTS["avg_vehicle_trip_length_mi"])
    bike_ms_boost = df["bike_mode_share"] * adjustment_factor
    pct = -scope_share * avg_bike_trip_length * bike_ms_boost \
          / (veh_len.clip(lower=0.5) * df["auto_mode_share"].clip(lower=1e-9))

    inputs = (f"scope={scope}, scope_share={scope_share:.0%}, "
              f"adj={adjustment_factor:+.0%}, bike_len={avg_bike_trip_length:.1f}mi")
    purpose = "commute" if scope == "commute" else "all"
    assumptions = pd.Series(_join_assumptions(
        "mode_share=imputed_from_area_type",
        _purpose_assumption(df, purpose),
    ), index=df.index)
    return _result(df, "Bike Mode-Share Booster", inputs, pct,
                   _base_vmt(df, purpose), assumptions, purpose=purpose)


def strategy_sharrows_bike_lanes(
    taz_df: pd.DataFrame,
    scope_share: float,
    adjustment_factor: float | None = None,
    avg_bike_trip_length: float | None = None,
) -> pd.DataFrame:
    """
    Sharrows & Painted Bike Lanes (planner-facing tile).

    Area-wide lower-grade bike infrastructure (sharrows, painted lanes). Wrapper
    over :func:`strategy_bike_mode_share_booster` fixed to ``scope='area_vmt'``
    (default mode-share boost +15%, CAPCOA 2021 T-19-A / T-20). For physically
    separated facilities use Separated & Protected Bike Lanes instead.
    """
    res = strategy_bike_mode_share_booster(
        taz_df, scope_share, scope="area_vmt",
        adjustment_factor=adjustment_factor, avg_bike_trip_length=avg_bike_trip_length,
    )
    res["strategy"] = "Sharrows & Painted Bike Lanes"
    return res


def strategy_end_of_trip_facilities(
    taz_df: pd.DataFrame,
    scope_share: float,
    adjustment_factor: float | None = None,
    avg_bike_trip_length: float | None = None,
) -> pd.DataFrame:
    """
    End-of-Trip Bicycle Facilities (planner-facing tile).

    Workplace bike parking, showers, and lockers, scoped to commute VMT. Wrapper
    over :func:`strategy_bike_mode_share_booster` fixed to ``scope='commute'``
    (default mode-share boost +5%, CAPCOA 2021 T-10).
    """
    res = strategy_bike_mode_share_booster(
        taz_df, scope_share, scope="commute",
        adjustment_factor=adjustment_factor, avg_bike_trip_length=avg_bike_trip_length,
    )
    res["strategy"] = "End-of-Trip Bicycle Facilities"
    return res


def strategy_shared_micromobility(
    taz_df: pd.DataFrame,
    pct_pop_access_before: float,
    pct_pop_access_after: float,
    micromobility_type: str = "bikeshare",
    daily_micro_trips_per_person: float | None = None,
    substitution_ratio: float | None = None,
    avg_micro_trip_length: float | None = None,
    pct_fleet_pedal: float | None = None,
    pct_fleet_ebike: float | None = None,
    pct_fleet_scooter: float | None = None,
) -> pd.DataFrame:
    """
    5. Shared Micromobility.

    Methods row 6.
    %ΔVMT = -Δaccess * daily_micro_trips * sub_ratio * avg_micro_len
            / (daily_veh_trips_per_person * avg_veh_trip_len)

    ``micromobility_type`` selects the per-type substitution ratio (the share
    of micromobility trips that replace what would otherwise have been an auto
    trip). CAPCOA's updated guidance differentiates because longer / more
    car-substituting trips are typical for e-bikes and scooters than for
    pedal bikeshare:

      * 'bikeshare'    -> 19.6% (McQueen et al. 2020)
      * 'e-bikeshare'  -> 35.0% (Fitch et al. 2021)
      * 'scootershare' -> 38.5% (McQueen et al. 2020)

    **Fleet mix (2026-07-27).** Real systems are rarely single-device: a city may
    run mostly scooters while requiring e-bikes in the same permit. Pass the three
    ``pct_fleet_*`` shares to blend the ratios by fleet composition::

        sub_ratio = SUM(share_i x ratio_i) / SUM(share_i)

    The shares are normalized, so they need not total exactly 1.0; only their
    relative proportions matter. If every share is 0 (or none are passed), the
    single-device ``micromobility_type`` ratio is used instead, which keeps direct
    callers and the analysis scripts working unchanged.

    Pass ``substitution_ratio`` explicitly to override everything above.

    Other defaults: daily_micro_trips/person = 0.05, avg_micro_trip_length = 1.0
    mi (NACTO).
    """
    if micromobility_type not in MICRO_SUBSTITUTION_BY_TYPE:
        raise ValueError(
            f"micromobility_type must be one of {list(MICRO_SUBSTITUTION_BY_TYPE)}; "
            f"got {micromobility_type!r}."
        )

    if daily_micro_trips_per_person is None:
        daily_micro_trips_per_person = BEHAVIORAL_DEFAULTS["daily_micro_trips_per_person"]
    if avg_micro_trip_length is None:
        avg_micro_trip_length = BEHAVIORAL_DEFAULTS["avg_micro_trip_length_mi"]

    # Fleet mix -> share-weighted substitution ratio. Keys mirror
    # MICRO_SUBSTITUTION_BY_TYPE so the per-device ratios stay single-sourced.
    fleet = {
        "bikeshare":    max(float(pct_fleet_pedal or 0.0), 0.0),
        "e-bikeshare":  max(float(pct_fleet_ebike or 0.0), 0.0),
        "scootershare": max(float(pct_fleet_scooter or 0.0), 0.0),
    }
    fleet_total = sum(fleet.values())

    if substitution_ratio is not None:
        sub_assumption = f"substitution_ratio={substitution_ratio:.0%}_user_specified"
    elif fleet_total > 0:
        substitution_ratio = sum(
            share * float(MICRO_SUBSTITUTION_BY_TYPE[k]["ratio"])
            for k, share in fleet.items()
        ) / fleet_total
        mix_desc = "+".join(
            f"{k}:{share / fleet_total:.0%}"
            for k, share in fleet.items() if share > 0
        )
        sub_assumption = (f"substitution_ratio={substitution_ratio:.1%}"
                          f"_blended_from_fleet_mix({mix_desc})")
    else:
        substitution_ratio = float(MICRO_SUBSTITUTION_BY_TYPE[micromobility_type]["ratio"])
        sub_source = MICRO_SUBSTITUTION_BY_TYPE[micromobility_type]["source"]
        sub_assumption = f"substitution_ratio={micromobility_type}={substitution_ratio:.0%}_per_{sub_source.replace(' ','_')}"

    persons = (taz_df["population"] + taz_df["employment"]).clip(lower=1.0)
    daily_veh_trips_per_person = taz_df["daily_trips"].fillna(0) / persons
    veh_len = taz_df["avg_trip_length"].fillna(BEHAVIORAL_DEFAULTS["avg_vehicle_trip_length_mi"])
    dd_access = pct_pop_access_after - pct_pop_access_before
    pct = -1.0 * (dd_access * daily_micro_trips_per_person * substitution_ratio
                  * avg_micro_trip_length) \
          / (daily_veh_trips_per_person.clip(lower=1e-3) * veh_len.clip(lower=0.5))

    inputs = (f"type={micromobility_type}, "
              f"access {pct_pop_access_before:.0%}→{pct_pop_access_after:.0%}, "
              f"micro_trips/pp={daily_micro_trips_per_person}, "
              f"sub={substitution_ratio:.1%}, micro_len={avg_micro_trip_length:.1f}mi")
    assumptions = pd.Series(_join_assumptions(
        "daily_micro_trips_per_person=NACTO_default",
        sub_assumption,
        "avg_micro_trip_length=NACTO_default",
    ), index=taz_df.index)
    return _result(taz_df, "Shared Micromobility", inputs, pct,
                   _base_vmt(taz_df, "all"), assumptions)


# ===========================================================================
#                                  LAND USE
# ===========================================================================

def strategy_density_change(
    taz_df: pd.DataFrame,
    pct_change_res_density: float,
    pct_change_emp_density: float = 0.0,
    res_elasticity: float | None = None,
    emp_elasticity: float | None = None,
) -> pd.DataFrame:
    """
    6. Density Change.

    Covers Methods rows 7 and 8 (Increased Residential Density + Mixed-Use
    Development). Corresponds to CAPCOA 2021 T-1 "Increase Residential Density"
    and T-2 "Increase Job Density".

    With emp_change=0 (default) this reduces to the residential-density-only
    formula:
        %ΔVMT = pct_change_res_density * ε_res

    With both res and emp changes, the combined effect is multiplicative:
        %ΔVMT = (1 + r_res)(1 + r_emp) - 1
        where r_res = pct_change_res_density * ε_res
              r_emp = pct_change_emp_density * ε_emp

    Defaults: ε_res = -0.22, ε_emp = -0.07 (Stevens 2016).
    """
    if res_elasticity is None:
        res_elasticity = ELASTICITIES["residential_density"]
    if emp_elasticity is None:
        emp_elasticity = ELASTICITIES["employment_density"]
    r_res = pct_change_res_density * res_elasticity
    r_emp = pct_change_emp_density * emp_elasticity
    pct = (1.0 + r_res) * (1.0 + r_emp) - 1.0
    inputs = (f"Δres={pct_change_res_density:+.0%}, Δemp={pct_change_emp_density:+.0%}, "
              f"ε_res={res_elasticity}, ε_emp={emp_elasticity}")
    return _result(taz_df, "Density Change", inputs, pct,
                   _base_vmt(taz_df, "all"),
                   pd.Series("", index=taz_df.index))


def strategy_residential_density(
    taz_df: pd.DataFrame,
    pct_change_res_density: float,
    res_elasticity: float | None = None,
) -> pd.DataFrame:
    """
    Increase Residential Density (planner-facing tile, CAPCOA 2021 T-1).

    Wrapper over :func:`strategy_density_change` with employment density held at
    zero, so %ΔVMT = pct_change_res_density * ε_res (ε_res = -0.22, Stevens 2016).
    """
    res = strategy_density_change(
        taz_df, pct_change_res_density, pct_change_emp_density=0.0,
        res_elasticity=res_elasticity,
    )
    res["strategy"] = "Increase Residential Density"
    return res


def strategy_employment_density(
    taz_df: pd.DataFrame,
    pct_change_emp_density: float,
    emp_elasticity: float | None = None,
) -> pd.DataFrame:
    """
    Increase Employment Density / Mixed-Use (planner-facing tile, CAPCOA 2021 T-2).

    Wrapper over :func:`strategy_density_change` with residential density held at
    zero, so %ΔVMT = pct_change_emp_density * ε_emp (ε_emp = -0.07, Stevens 2016).
    """
    res = strategy_density_change(
        taz_df, pct_change_res_density=0.0,
        pct_change_emp_density=pct_change_emp_density, emp_elasticity=emp_elasticity,
    )
    res["strategy"] = "Increase Employment Density (Mixed-Use)"
    return res


def strategy_transit_oriented_development(
    taz_df: pd.DataFrame,
    pct_taz_in_tod: float | None = None,
    tod_mode_share_ratio: float | None = None,
    max_tod_transit_share: float | None = None,
) -> pd.DataFrame:
    """
    7. Transit Oriented Development.

    Methods row 9. Implements CAPCOA 2021 T-3 "Provide Transit-Oriented
    Development" (formerly LUT-4 in the 2010 edition) using its multiplicative
    interpretation of the TOD effect: TOD residents have transit mode share
    ~4.9x the surrounding area (per CAPCOA citing Lund 2004 / Cervero 2007 /
    Chatman 2013):

      1. Inside the TOD walkshed, transit mode share = area_transit_MS x
         ``tod_mode_share_ratio`` (default 4.9), CAPPED at
         ``max_tod_transit_share`` (default 0.50, a realistic ceiling for
         even high-quality rail-station TODs).
      2. The increment in transit mode share comes out of auto, so the
         per-TOD-resident auto VMT reduction is:
             (capped_tod_transit_MS - area_transit_MS) / area_auto_MS
      3. Scaled to the TAZ by ``pct_taz_in_tod`` (the share of TAZ population
         living within the TOD walkshed; default 10%).

    %ΔVMT = -pct_taz_in_tod * (capped_tod_transit_MS - area_transit_MS) / auto_MS

    Defaults produce per-TAZ VMT reductions of roughly 5-15% for urban_core
    TAZs at 10% TOD coverage, matching the lower half of CAPCOA 2021 T-3's
    documented 9-45% range (the upper end of which assumes most/all of the
    project area is in TOD).

    Source: CAPCOA 2021 Handbook Measure T-3; Lund et al. 2004 TOD travel
    characteristics; Cervero 2007; Chatman 2013; CARB TOD 2025 brief.

    Caveat: For TAZs with already-high baseline transit_MS (e.g., urban_core
    near a rail station), the ratio quickly hits the cap and the effect is
    bounded by ``max_tod_transit_share`` rather than the multiplier.
    """
    if pct_taz_in_tod is None:
        pct_taz_in_tod = PROGRAM_EFFECTS["tod_default_pct_taz_in_tod"]
    if tod_mode_share_ratio is None:
        tod_mode_share_ratio = PROGRAM_EFFECTS["tod_mode_share_ratio"]
    if max_tod_transit_share is None:
        max_tod_transit_share = PROGRAM_EFFECTS["tod_max_transit_share"]

    df = add_imputed_mode_shares(taz_df)
    transit_ms = df["transit_mode_share"]
    auto_ms    = df["auto_mode_share"].clip(lower=1e-9)
    tod_transit_ms = (transit_ms * tod_mode_share_ratio).clip(upper=max_tod_transit_share)
    delta_transit_ms = tod_transit_ms - transit_ms
    pct = -pct_taz_in_tod * delta_transit_ms / auto_ms

    cap_hit_rate = float((transit_ms * tod_mode_share_ratio > max_tod_transit_share).mean())
    inputs = (f"pct_taz_in_tod={pct_taz_in_tod:.0%}, "
              f"tod_ratio={tod_mode_share_ratio:.1f}x, "
              f"max_share_cap={max_tod_transit_share:.0%}, "
              f"cap_hit={cap_hit_rate:.0%}")
    assumptions = pd.Series(_join_assumptions(
        "mode_share=imputed_from_area_type",
        f"tod_mode_share_ratio={tod_mode_share_ratio}_per_CAPCOA_2021_T-3",
        f"max_tod_transit_share={max_tod_transit_share:.0%}_realistic_ceiling",
    ), index=df.index)
    return _result(df, "Transit Oriented Development", inputs, pct,
                   _base_vmt(df, "all"), assumptions)


def strategy_affordable_housing(
    taz_df: pd.DataFrame,
    pct_units_affordable: float,
    reduction_per_affordable_unit: float | None = None,
) -> pd.DataFrame:
    """
    8. Affordable Housing / Infill.

    Methods row 24.
    %ΔVMT = -pct_units_affordable * reduction_per_affordable_unit
    Default per-unit reduction: 6% (CAPCOA 2021 T-4 "Integrate Affordable and
    Below Market Rate Housing", formerly LU-1 in the 2010 edition).
    """
    if reduction_per_affordable_unit is None:
        reduction_per_affordable_unit = PROGRAM_EFFECTS["affordable_housing_vmt_reduction"]
    pct = -pct_units_affordable * reduction_per_affordable_unit
    inputs = (f"affordable_share={pct_units_affordable:.0%}, "
              f"per-unit-reduction={reduction_per_affordable_unit:.0%}")
    return _result(taz_df, "Affordable Housing / Infill", inputs, pct,
                   _base_vmt(taz_df, "all"),
                   pd.Series("", index=taz_df.index))


# ===========================================================================
#                                  PARKING
# ===========================================================================

def strategy_parking_pricing(
    taz_df: pd.DataFrame,
    new_price: float,
    existing_price: float | None = None,
    share_affected: float | None = None,
    trip_purpose: str = "commute",
    elasticity: float | None = None,
    vmt_to_trips_ratio: float | None = None,
) -> pd.DataFrame:
    """
    9. Parking Pricing.

    Covers Methods rows 12, 13, 14 (Workplace Parking Pricing + Parking Fees /
    Curb Management + Dynamic Parking Pricing).

      trip_purpose='commute'   (Methods row 12 - workplace pricing)
        %ΔCommute VMT = pct_price_change * ε * share_affected * vmt_to_trips_ratio
        share_affected = share of commuters whose parking price changes
          (default = share_emp_paying_parking from area-type imputation)

      trip_purpose='all'       (Methods rows 13, 14 - curb mgmt / dynamic pricing)
        %ΔVMT = pct_price_change * ε * share_affected * vmt_to_trips_ratio
        share_affected = fraction of area VMT subject to the new pricing
          (no default — user must pass)

    ``existing_price`` defaults to the area-type-imputed ``current_parking_price``
    column. When the imputed baseline is $0, the formula models introducing
    pricing as a 100% increase (treating effective baseline = new_price / 2).

    ε defaults to -0.40 (Lehner & Peer 2019). For modest price changes only -
    the linear elasticity overstates response for >50% price hikes.
    """
    if trip_purpose not in ("commute", "all"):
        raise ValueError("trip_purpose must be 'commute' or 'all'")
    if elasticity is None:
        elasticity = ELASTICITIES["parking_demand"]
    if vmt_to_trips_ratio is None:
        vmt_to_trips_ratio = PROGRAM_EFFECTS["trip_to_vmt_factor"]

    df = add_imputed_parking(taz_df)
    old = pd.Series(existing_price, index=df.index) if existing_price is not None \
        else df["current_parking_price"]
    if share_affected is None:
        if trip_purpose == "commute":
            share = df["share_emp_paying_parking"]
            share_assumed = True
        else:
            raise ValueError(
                "share_affected is required when trip_purpose='all' "
                "(fraction of area VMT subject to pricing)."
            )
    else:
        share = pd.Series(share_affected, index=df.index)
        share_assumed = False

    effective_old = old.where(old > 0, new_price / 2.0)
    pct_price = (new_price - effective_old) / effective_old
    pct = pct_price * elasticity * share * vmt_to_trips_ratio

    inputs = (f"new=${new_price:.2f}/day, purpose={trip_purpose}, "
              f"share_affected={'imputed' if share_assumed else f'{share_affected:.0%}'}, "
              f"ε={elasticity}")
    purpose = "commute" if trip_purpose == "commute" else "all"
    assumptions_parts = []
    if existing_price is None:
        assumptions_parts.append("existing_price=area_type_default")
    if share_assumed:
        assumptions_parts.append("share_paying=area_type_default")
    assumptions_parts.append(_purpose_assumption(df, purpose))
    assumptions = pd.Series(_join_assumptions(*assumptions_parts), index=df.index)
    return _result(df, "Parking Pricing", inputs, pct,
                   _base_vmt(df, purpose), assumptions, purpose=purpose)


def strategy_workplace_parking_pricing(
    taz_df: pd.DataFrame,
    new_price: float,
    existing_price: float | None = None,
    share_affected: float | None = None,
    elasticity: float | None = None,
    vmt_to_trips_ratio: float | None = None,
) -> pd.DataFrame:
    """
    Workplace Parking Pricing (planner-facing tile).

    Employer-charged commuter parking, scoped to commute VMT. Wrapper over
    :func:`strategy_parking_pricing` fixed to ``trip_purpose='commute'``;
    ``share_affected`` defaults to the area-type share of employees who pay for
    parking when not supplied.
    """
    res = strategy_parking_pricing(
        taz_df, new_price, existing_price=existing_price, share_affected=share_affected,
        trip_purpose="commute", elasticity=elasticity, vmt_to_trips_ratio=vmt_to_trips_ratio,
    )
    res["strategy"] = "Workplace Parking Pricing"
    return res


def strategy_parking_fees_curb_management(
    taz_df: pd.DataFrame,
    new_price: float,
    share_affected: float,
    existing_price: float | None = None,
    elasticity: float | None = None,
    vmt_to_trips_ratio: float | None = None,
) -> pd.DataFrame:
    """
    Parking Fees / Curb Management (planner-facing tile).

    Municipal on-/off-street parking pricing applied across an area. Wrapper
    over :func:`strategy_parking_pricing` fixed to ``trip_purpose='all'``;
    ``share_affected`` (fraction of area VMT subject to the pricing) is required.
    """
    res = strategy_parking_pricing(
        taz_df, new_price, existing_price=existing_price, share_affected=share_affected,
        trip_purpose="all", elasticity=elasticity, vmt_to_trips_ratio=vmt_to_trips_ratio,
    )
    res["strategy"] = "Parking Fees / Curb Management"
    return res


def strategy_dynamic_parking_pricing(
    taz_df: pd.DataFrame,
    new_price: float,
    share_affected: float,
    existing_price: float | None = None,
    elasticity: float | None = None,
    vmt_to_trips_ratio: float | None = None,
) -> pd.DataFrame:
    """
    Dynamic Parking Pricing (planner-facing tile).

    Demand-responsive (time/location-varying) pricing. Uses the same area-wide
    elasticity engine as Parking Fees / Curb Management (``trip_purpose='all'``)
    with ``new_price`` interpreted as the average resulting price. Handy et al.
    2025 flag standalone quantification as "not recommended"; treat results as
    effect-size estimates.
    """
    res = strategy_parking_pricing(
        taz_df, new_price, existing_price=existing_price, share_affected=share_affected,
        trip_purpose="all", elasticity=elasticity, vmt_to_trips_ratio=vmt_to_trips_ratio,
    )
    res["strategy"] = "Dynamic Parking Pricing"
    return res


def strategy_unbundled_parking(
    taz_df: pd.DataFrame,
    annual_parking_cost: float,
    avg_vehicle_cost: float | None = None,
    elasticity: float | None = None,
    adjustment_factor: float | None = None,
) -> pd.DataFrame:
    """
    10. Unbundled Parking (Multifamily Housing).

    Methods row 10.
    %ΔVMT = (annual_parking_cost / avg_vehicle_cost) * ε_ownership * adj_factor

    Defaults: avg_vehicle_cost = $12,300/yr (AAA 2024), ε = -0.40 (Litman 2020),
    adj_factor = 0.50 (vehicle-ownership change → VMT change).
    """
    if avg_vehicle_cost is None:
        avg_vehicle_cost = BEHAVIORAL_DEFAULTS["annual_vehicle_ownership_cost"]
    if elasticity is None:
        elasticity = ELASTICITIES["vehicle_ownership_cost"]
    if adjustment_factor is None:
        adjustment_factor = PROGRAM_EFFECTS["vehicle_ownership_to_vmt_factor"]
    pct = (annual_parking_cost / avg_vehicle_cost) * elasticity * adjustment_factor
    inputs = (f"annual_park_cost=${annual_parking_cost:,.0f}, "
              f"veh_cost=${avg_vehicle_cost:,.0f}, ε={elasticity}, adj={adjustment_factor}")
    assumptions = pd.Series(_join_assumptions(
        "avg_vehicle_cost=AAA_default",
    ), index=taz_df.index)
    return _result(taz_df, "Unbundled Parking", inputs, pct,
                   _base_vmt(taz_df, "all"), assumptions)


def strategy_parking_cashout(
    taz_df: pd.DataFrame,
    pct_eligible_employees: float,
    reduction_per_eligible: float | None = None,
) -> pd.DataFrame:
    """
    11. Parking Cash-Out.

    Methods row 11.
    %ΔCommute VMT = -pct_eligible * reduction_per_eligible
    Default reduction = 12% (CAPCOA 2021 T-13 "Implement Employee Parking
    Cash-Out" midpoint, formerly TRT-15 in the 2010 edition).
    """
    if reduction_per_eligible is None:
        reduction_per_eligible = PROGRAM_EFFECTS["parking_cashout_per_eligible"]
    pct = -pct_eligible_employees * reduction_per_eligible
    inputs = (f"eligible={pct_eligible_employees:.0%}, "
              f"per-eligible-reduction={reduction_per_eligible:.0%}")
    return _result(taz_df, "Parking Cash-Out", inputs, pct,
                   _base_vmt(taz_df, "commute"),
                   _purpose_assumption(taz_df, "commute"), purpose="commute")


# ===========================================================================
#                              VANPOOL / PROGRAMS
# ===========================================================================

def strategy_vanpool(
    taz_df: pd.DataFrame,
    pct_trips_impacted: float,
    pct_service_change: float = 1.0,
    elasticity: float | None = None,
) -> pd.DataFrame:
    """
    12. Vanpool.

    Methods row 15. Treated as a transit-style service expansion scoped to
    commute VMT (CAPCOA 2021 T-11 "Provide Employer-Sponsored Vanpool",
    formerly TRT-3 in the 2010 edition):
    %ΔCommute VMT = -pct_trips_impacted * pct_service_change
                    * transit_MS * ε * 1/AVO

    Data assumptions: transit mode share + AVO imputed from area_type.
    """
    if elasticity is None:
        elasticity = ELASTICITIES["transit_service_miles"]
    df = add_imputed_avo(add_imputed_mode_shares(taz_df))
    pct = -pct_trips_impacted * pct_service_change \
          * df["transit_mode_share"] * elasticity * (1.0 / df["avo"])
    inputs = (f"trips_impacted={pct_trips_impacted:.0%}, "
              f"Δservice={pct_service_change:+.0%}, ε={elasticity}")
    assumptions = pd.Series(_join_assumptions(
        "mode_share=imputed_from_area_type",
        _avo_assumption(df),
        _purpose_assumption(df, "commute"),
    ), index=df.index)
    return _result(df, "Vanpool", inputs, pct,
                   _base_vmt(df, "commute"), assumptions, purpose="commute")


def strategy_tmo_coverage(
    taz_df: pd.DataFrame,
    share_before: float,
    share_after: float,
    reduction_per_eligible: float | None = None,
) -> pd.DataFrame:
    """
    13. TMO Coverage.

    Covers Methods rows 16 and 17 (Establishing a New TMO + Joining an
    Existing TMO; identical formula, only the framing differs).

    %ΔCommute VMT = -(share_after - share_before) * reduction_per_eligible
    Default reduction = 4% (CAPCOA 2021 T-5 "Implement Commute Trip Reduction
    Program (Voluntary)" midpoint, formerly TRT-1 in the 2010 edition).
    """
    if reduction_per_eligible is None:
        reduction_per_eligible = PROGRAM_EFFECTS["tmo_voluntary_ctr_per_eligible"]
    pct = -(share_after - share_before) * reduction_per_eligible
    inputs = (f"share {share_before:.0%}→{share_after:.0%}, "
              f"r_CTR={reduction_per_eligible:.0%}")
    return _result(taz_df, "TMO Coverage", inputs, pct,
                   _base_vmt(taz_df, "commute"),
                   _purpose_assumption(taz_df, "commute"), purpose="commute")


def strategy_commute_program(
    taz_df: pd.DataFrame,
    pct_eligible: float,
    reduction_per_eligible: float | None = None,
) -> pd.DataFrame:
    """
    14. Commute Program (Marketing / Incentives).

    Covers Methods rows 20 and 21 (Marketing Campaign + Incentive Campaigns;
    same formula form, just different default effect sizes — 1% vs 3%).

    %ΔCommute VMT = -pct_eligible * reduction_per_eligible
    Default = 2% (midpoint). Override for marketing-only (~1%) or
    incentive-only (~3%) campaigns.

    Sources: CAPCOA 2021 T-7 "Implement Commute Trip Reduction Marketing"
    (marketing); the 2010 standalone "Trip Reduction Incentive" measure
    (T-13) was folded into T-5 / T-7 / T-8 in the 2021 edition, so the
    incentive-only effect size is retained here from the 2010 evidence base.
    """
    if reduction_per_eligible is None:
        reduction_per_eligible = PROGRAM_EFFECTS["commute_program_per_eligible"]
    pct = -pct_eligible * reduction_per_eligible
    inputs = f"eligible={pct_eligible:.0%}, per-eligible-reduction={reduction_per_eligible:.1%}"
    return _result(taz_df, "Commute Program (Marketing/Incentives)", inputs, pct,
                   _base_vmt(taz_df, "commute"),
                   _purpose_assumption(taz_df, "commute"), purpose="commute")


def strategy_commute_marketing(
    taz_df: pd.DataFrame,
    pct_eligible: float,
    reduction_per_eligible: float | None = None,
) -> pd.DataFrame:
    """
    Commute Trip-Reduction Marketing (planner-facing tile, CAPCOA 2021 T-7).

    Outreach / marketing-only commute program. Wrapper over
    :func:`strategy_commute_program` defaulting to the marketing-only effect
    size (~1% per eligible commuter).
    """
    if reduction_per_eligible is None:
        reduction_per_eligible = PROGRAM_EFFECTS["commute_marketing_per_eligible"]
    res = strategy_commute_program(taz_df, pct_eligible,
                                   reduction_per_eligible=reduction_per_eligible)
    res["strategy"] = "Commute Trip-Reduction Marketing"
    return res


def strategy_commute_incentives(
    taz_df: pd.DataFrame,
    pct_eligible: float,
    reduction_per_eligible: float | None = None,
) -> pd.DataFrame:
    """
    Commute Trip-Reduction Incentives (planner-facing tile).

    Financial / non-financial incentive campaign (transit benefits, rewards).
    Wrapper over :func:`strategy_commute_program` defaulting to the
    incentive-campaign effect size (~3% per eligible commuter).
    """
    if reduction_per_eligible is None:
        reduction_per_eligible = PROGRAM_EFFECTS["commute_incentive_per_eligible"]
    res = strategy_commute_program(taz_df, pct_eligible,
                                   reduction_per_eligible=reduction_per_eligible)
    res["strategy"] = "Commute Trip-Reduction Incentives"
    return res


def strategy_telework(
    taz_df: pd.DataFrame,
    pct_eligible: float,
    telework_days_per_week: float,
) -> pd.DataFrame:
    """
    15. Telework.

    Methods row 19.
    %ΔCommute VMT = -pct_eligible * telework_days/5

    The spreadsheet formula multiplies by avg_trip_length, which yields miles
    not a percentage; interpreted as the intent (eliminate commute round-trip
    on telework days) the percentage reduction is as above.
    """
    if not 0 <= telework_days_per_week <= 5:
        raise ValueError("telework_days_per_week must be 0-5")
    pct = -pct_eligible * (telework_days_per_week / 5.0)
    inputs = f"eligible={pct_eligible:.0%}, days/wk={telework_days_per_week}"
    return _result(taz_df, "Telework", inputs, pct,
                   _base_vmt(taz_df, "commute"),
                   _purpose_assumption(taz_df, "commute"), purpose="commute")


# ===========================================================================
#                              INDUCED DEMAND
# ===========================================================================

def strategy_lane_mile_addition(
    taz_df: pd.DataFrame,
    new_lane_miles: float,
    facility_class: str = "major_arterial",
    elasticity: float | None = None,
) -> pd.DataFrame:
    """
    16. Lane-Mile Addition (induced demand).

    Methods row 25.
    %ΔVMT = (new_lane_miles / existing_lane_miles_in_class) * ε

    Default elasticity by facility class (Duranton & Turner 2011 long-run):
      freeway / expressway              +1.0
      major_arterial / minor_arterial   +0.6
      collector / local                 +0.4

    AGGREGATE, not per-TAZ. Both terms are project-area totals: ``new_lane_miles``
    is the whole project's net change in through-lane miles, and the denominator
    is ``lane_mi_<facility_class>`` summed over every row of ``taz_df``. The
    resulting percentage is uniform across the frame.

    Duranton & Turner is an *area-level* elasticity relating a region's VMT to
    that region's lane miles, so the aggregate reading is the faithful one.
    Dividing the project total by each zone's own much smaller stock — which this
    did until 2026-08-04 — made the same project report a larger effect the more
    zones were selected, and readily produced reductions beyond -100%.
    Distributing the entered total across zones by lane-mile share is
    algebraically identical to the aggregate form and is not done separately.

    Removal is clamped at the existing stock (you cannot take out more lanes than
    are there), bounding the reduction at exactly ε. Additions are unbounded.
    Returns 0 reduction, with a flag, when the frame has no lane-miles in the
    class at all.
    """
    if elasticity is None:
        key = FACILITY_TO_INDUCED_ELASTICITY.get(facility_class)
        if key is None:
            raise ValueError(f"Unknown facility_class {facility_class!r}. "
                             f"Use one of {list(FACILITY_TO_INDUCED_ELASTICITY)}.")
        elasticity = ELASTICITIES[key]
    col = f"lane_mi_{facility_class}"
    if col not in taz_df.columns:
        raise KeyError(f"Prepared TAZ table missing column {col!r}.")
    existing_total = float(taz_df[col].fillna(0.0).clip(lower=0.0).sum())
    assumptions = pd.Series("", index=taz_df.index)

    if existing_total <= 0:
        inputs = (f"new_lane_mi={new_lane_miles:.2f}, class={facility_class}, "
                  f"ε={elasticity}, existing_lane_mi=0.00")
        assumptions[:] = "no_existing_lane_miles_in_class"
        return _result(taz_df, "Lane-Mile Addition", inputs,
                       pd.Series(0.0, index=taz_df.index),
                       _base_vmt(taz_df, "all"), assumptions)

    applied = max(float(new_lane_miles), -existing_total)
    if applied != float(new_lane_miles):
        assumptions[:] = "lane_miles_removed_clamped_to_existing"
    pct = pd.Series((applied / existing_total) * elasticity, index=taz_df.index)
    inputs = (f"new_lane_mi={applied:.2f}, class={facility_class}, "
              f"ε={elasticity}, existing_lane_mi={existing_total:.2f}")
    return _result(taz_df, "Lane-Mile Addition", inputs, pct,
                   _base_vmt(taz_df, "all"), assumptions)


# ===========================================================================
#         ADDITIONAL STRATEGIES (Handy 2025 "quant not recommended")
# ===========================================================================
# The three strategies below are flagged "Quantification Not Recommended" by
# Handy et al. 2025 in the source spreadsheet. The implementations follow
# Handy's "alternative approaches" guidance:
#   - Park and Ride        -> legacy 2010 CAPCOA T-22; the 2021 handbook dropped P&R entirely
#   - Mobility Hub         -> composite stack of constituent strategies
#   - Traffic Calming      -> connectivity proxy OR mode-shift, basis switch

def select_pr_catchment(
    taz_df: pd.DataFrame,
    facility_lon: float,
    facility_lat: float,
    l_access_mi: float,
    taz_path=None,
    crs: str = "EPSG:26913",
) -> pd.Series:
    """
    Boolean Series (aligned to ``taz_df``) flagging the Park-and-Ride catchment:
    TAZs whose centroid lies within ``l_access_mi`` straight-line distance of the
    facility at (``facility_lon``, ``facility_lat``) in WGS84 degrees.

    Geometry is loaded lazily from the published TDM zone file (the same
    precalculated TAZ source ``prepare_taz`` consumes - no new dataset, no
    routing). Straight-line centroid distance approximates the network access
    distance ``L_access``; the catchment is intentionally generous since access
    drives rarely exceed the crow-flight radius by much at TAZ scale. For a
    network-distance catchment, pass ``catchment_taz_ids`` to
    :func:`strategy_park_and_ride` directly instead.
    """
    # Lazy imports: keep geopandas/shapely out of this module's top-level deps
    # (only Park-and-Ride's spatial catchment needs them).
    import geopandas as gpd
    from shapely.geometry import Point
    from prepare_taz import load_taz, DEFAULT_TAZ_PATH

    taz_gdf = load_taz(taz_path or DEFAULT_TAZ_PATH, crs=crs)
    centroids = taz_gdf.geometry.centroid
    ids = taz_gdf["TAZ_new_ID"].astype("Int64").astype(str)

    facility_pt = (
        gpd.GeoSeries([Point(facility_lon, facility_lat)], crs="EPSG:4326")
        .to_crs(crs).iloc[0]
    )
    dist_mi = centroids.distance(facility_pt) / 1609.344  # projected metres -> miles
    in_catchment_ids = set(ids[dist_mi <= l_access_mi])
    return taz_df["taz_id"].isin(in_catchment_ids)


def strategy_park_and_ride(
    taz_df: pd.DataFrame,
    n_spaces: float,
    l_access_mi: float,
    facility_lon: float | None = None,
    facility_lat: float | None = None,
    catchment_taz_ids=None,
    utilization: float | None = None,
    isolated_facility: bool = True,
    l_commute_catchment_mi: float | None = None,
    total_transit_trips_catchment: float | None = None,
    drive_access_share: float | None = None,
    commute_share_of_drive_access: float | None = None,
) -> pd.DataFrame:
    """
    17. Park and Ride (DERIVED method; Duncan & Cao 2020 + local TAZ data).

    Replaces the legacy CAPCOA 2010 T-22 trip-substitution credit. No CARB brief
    or CAPCOA measure quantifies P&R; this method is built on the only US
    empirical source that isolates the *marginal* VMT effect of P&R (Duncan &
    Cao 2020), with the avoided mileage reconstructed from local Colorado TAZ
    trip lengths so the result stays consistent with the rest of the calculator.

    Trip pool: COMMUTE. P&R round trips are overwhelmingly home-based-work, so
    the reduction is computed against - and combined only with - the commute
    VMT pool, never all-trip VMT.

    Spatial catchment
    -----------------
    P&R savings accrue along the corridor riders come from, not at the lot. The
    denominator is the commute VMT *produced by the catchment TAZs* - the set of
    TAZs within ``l_access_mi`` of the facility. The catchment is resolved one of
    three ways, in priority order:
      1. ``catchment_taz_ids`` - an explicit list (e.g. a network-distance
         catchment computed upstream);
      2. ``facility_lon`` / ``facility_lat`` - a straight-line centroid catchment
         built by :func:`select_pr_catchment` from the published TAZ geometry;
      3. neither - the entire ``taz_df`` is treated as the catchment (flagged).

    Method (spec §5.3, §5.6) - dual supply/demand-side with binding constraint
    ------------------------------------------------------------------------
    The credited diverted round trips are computed two ways and the **lower
    (binding)** value is used. Supply is bounded by parking capacity; demand is
    bounded by how many catchment transit commuters actually drive to transit::

        D            = 0.80 if isolated_facility else 0.32          # diversion fraction
        # avoided VMT per diverted round trip, from local trip lengths:
        V_net        = max(2 * (L_commute_catchment - l_access), 0) # apply_D = True
        #   ...or the Duncan & Cao fallback (19 / 10 mi) which already embeds the
        #   diversion behaviour, so D is NOT also applied (apply_D = False).
        supply       = n_spaces * utilization * (D if apply_D else 1)
        demand       = (total_transit_trips * drive_access_share
                        * commute_share_of_drive_access * (D if apply_D else 1))
        diverted     = min(supply, demand)                          # demand omitted if no data
        daily_saved  = diverted * V_net
        pct_commute  = daily_saved / commute_vmt(catchment)

    ``drive_access_share`` defaults to the **observed** per-TAZ
    ``drive_to_transit_share`` (commute-VMT-weighted mean over the catchment) -
    the drive-to-transit access split carried through from the CDOT extract -
    falling back to a passed value only when no observed split exists. The access
    split scopes the rider pool; it is never multiplied into VMT directly.

    ``total_transit_trips_catchment`` is an **all-purpose** daily transit trip
    count (renamed 2026-07-27 from ``total_transit_commute_trips_catchment``:
    agencies rarely publish a commute-only figure, per the 2026-07-21 content
    review). Because this method's pool is commute VMT, the count is scoped back
    to commute travel by ``commute_share_of_drive_access`` - the commute share of
    the drive-access subset, which defaults to
    ``PARK_AND_RIDE_DERIVED["commute_share_of_drive_access"]``. Without that
    factor a total-trip count would inflate the ceiling and silently make the
    method supply-side-only for most catchments.

    ``l_commute_catchment_mi`` defaults to the **observed** catchment trip length
    (commute-VMT-weighted mean of ``tdm_avg_trip_length_mi`` / ``avg_trip_length``).
    A single average trip length stands in for the production-end commute length
    (flagged; spec §5.7).

    The reduction is reported per-TAZ: every catchment TAZ carries the same
    ``pct_vmt_reduction`` against its own commute VMT (0 outside the catchment),
    so summing ``daily_vmt_reduction`` reproduces the facility-level saving.

    Caps & flags
    ------------
    No subsector cap (standalone measure). Commute-VMT reductions above
    ``sanity_ceiling_pct`` (5%) are flagged for review. A supply >> demand gap is
    a data-quality flag, not a larger credit. Defensible for the US auto-oriented
    commuter context that matches Colorado (Duncan & Cao); international P&R can
    increase VKT (Mingardo 2013; Parkhurst 2000) - out of scope here.

    Sources:
      - Duncan, M., & Cao, J. (2020). Marginal Impacts of Park-and-Ride
        Facilities in the Twin Cities. TRR 2674. doi:10.1177/0361198120945696
      - Duncan, M. (2019). Transport Policy 81. doi:10.1016/j.tranpol.2017.12.005
    """
    K = PARK_AND_RIDE_DERIVED
    if utilization is None:
        utilization = K["utilization_default"]
    # Accept a Python bool (direct callers) or the catalog select string
    # ("isolated" / "alternative") that the app passes through.
    is_isolated = isolated_facility if isinstance(isolated_facility, bool) \
        else str(isolated_facility).strip().lower() in ("isolated", "true", "1", "yes")
    D = K["diversion_isolated"] if is_isolated else K["diversion_alt"]

    # --- Resolve the spatial catchment ---
    catchment_basis = ""
    if catchment_taz_ids is not None:
        mask = taz_df["taz_id"].isin({str(t) for t in catchment_taz_ids})
        catchment_basis = "catchment=explicit_taz_ids"
    elif facility_lon is not None and facility_lat is not None:
        mask = select_pr_catchment(taz_df, facility_lon, facility_lat, l_access_mi)
        catchment_basis = f"catchment=centroid_within_{l_access_mi:.1f}mi"
    else:
        mask = pd.Series(True, index=taz_df.index)
        catchment_basis = "catchment=ENTIRE_taz_df_(no_facility_location_supplied)"

    commute_vmt = _base_vmt(taz_df, "commute")
    catch_commute_vmt = commute_vmt.where(mask, 0.0)
    catch_total = float(catch_commute_vmt.sum())
    weights = catch_commute_vmt  # commute-VMT weights within the catchment

    # --- L_commute_catchment: prefer observed trip length over the catchment ---
    len_source = "user_specified"
    if l_commute_catchment_mi is None:
        if "tdm_avg_trip_length_mi" in taz_df.columns \
                and taz_df["tdm_avg_trip_length_mi"].notna().any():
            len_series = pd.to_numeric(taz_df["tdm_avg_trip_length_mi"], errors="coerce")
            len_source = "tdm_model_trip_length"
        else:
            len_series = pd.to_numeric(taz_df.get("avg_trip_length"), errors="coerce")
            len_source = "derived_avg_trip_length"
        valid = len_series.notna() & (weights > 0)
        if valid.any():
            l_commute_catchment_mi = float(
                (len_series[valid] * weights[valid]).sum() / weights[valid].sum())
        else:
            l_commute_catchment_mi = None
            len_source = "unavailable"

    # --- V_net: local trip lengths if available, else Duncan & Cao fallback ---
    if l_commute_catchment_mi is not None:
        v_net = max(2.0 * (l_commute_catchment_mi - l_access_mi), 0.0)
        apply_d = True
        vnet_source = f"local_2x({l_commute_catchment_mi:.1f}-{l_access_mi:.1f})"
    else:
        v_net = K["vnet_fallback_isolated"] if is_isolated else K["vnet_fallback_alt"]
        apply_d = False  # fallback already embeds diversion - do NOT also apply D
        vnet_source = "duncan_cao_fallback_embeds_D"

    d_factor = D if apply_d else 1.0

    # --- Supply-side (parking capacity) ---
    diverted_supply = n_spaces * utilization * d_factor

    # --- Demand-side (drive-access transit commuters in catchment) ---
    das_source = ""
    if drive_access_share is None:
        if "drive_to_transit_share" in taz_df.columns \
                and (taz_df["drive_to_transit_share"].notna() & (weights > 0)).any():
            das = pd.to_numeric(taz_df["drive_to_transit_share"], errors="coerce")
            valid = das.notna() & (weights > 0)
            drive_access_share = float(
                (das[valid] * weights[valid]).sum() / weights[valid].sum())
            das_source = "observed_drive_to_transit_share"
    else:
        das_source = "user_specified"

    if commute_share_of_drive_access is None:
        commute_share_of_drive_access = K["commute_share_of_drive_access"]

    flags = [catchment_basis]
    if total_transit_trips_catchment is not None and drive_access_share is not None:
        # The trip count is all-purpose; scope it to commute travel (this method's
        # pool) via the commute share of the drive-access subset.
        diverted_demand = (total_transit_trips_catchment * drive_access_share
                           * commute_share_of_drive_access * d_factor)
        diverted_trips = min(diverted_supply, diverted_demand)
        flags.append(f"drive_access_share={das_source}({drive_access_share:.0%})")
        flags.append(
            f"commute_share_of_drive_access={commute_share_of_drive_access:.0%}_PLACEHOLDER")
        if diverted_supply > 2.0 * diverted_demand:
            flags.append("supply>>demand_ceiling_check_review_utilization_or_catchment")
    else:
        diverted_trips = diverted_supply
        flags.append("no_demand_ceiling_(supply_side_only)")

    daily_saved_total = diverted_trips * v_net
    pct_red = (daily_saved_total / catch_total) if catch_total > 0 else 0.0
    if pct_red > K["sanity_ceiling_pct"]:
        flags.append(f"exceeds_{K['sanity_ceiling_pct']:.0%}_commute_VMT_sanity_ceiling_review")

    # Uniform percent on catchment TAZs, 0 elsewhere.
    pct = pd.Series(np.where(mask, -pct_red, 0.0), index=taz_df.index)

    inputs = (f"N_spaces={n_spaces:,.0f}, U={utilization:.0%}, "
              f"L_access={l_access_mi:.1f}mi, isolated={is_isolated} (D={D}), "
              f"V_net={v_net:.1f}mi/rt ({vnet_source}), "
              f"catchment_commute_VMT={catch_total:,.0f}")
    assumptions = pd.Series(_join_assumptions(
        f"L_commute={len_source}",
        _purpose_assumption(taz_df, "commute"),
        "DERIVED_Duncan_Cao_2020_US_commuter_context",
        *flags,
    ), index=taz_df.index)
    return _result(taz_df, "Park and Ride", inputs, pct,
                   commute_vmt, assumptions, purpose="commute")


# Components recognized by strategy_mobility_hub. Each maps to a constituent
# strategy function; the kwargs supplied via ``components`` are forwarded.
_MOBILITY_HUB_COMPONENT_FNS: dict[str, str] = {
    "shared_micromobility":    "strategy_shared_micromobility",
    "transit_frequency_boost": "strategy_transit_service_expansion",
    "end_of_trip_facilities":  "strategy_bike_mode_share_booster",
}

_MOBILITY_HUB_DEFAULT_COMPONENTS: dict[str, dict] = {
    "shared_micromobility":    dict(pct_pop_access_before=0.0, pct_pop_access_after=0.30),
    "transit_frequency_boost": dict(pct_change=0.10, basis="frequency",
                                    level_of_implementation=1.0),
    "end_of_trip_facilities":  dict(scope_share=0.40, scope="commute"),
}


def strategy_mobility_hub(
    taz_df: pd.DataFrame,
    catchment_share: float,
    components: dict[str, dict] | None = None,
    composite_discount: float | None = None,
) -> pd.DataFrame:
    """
    18. Mobility Hub (composite stack).

    Methods row 23 (Handy et al. 2025: "Quantification Not Recommended.
    Utilize alternative interactions"). Implementation follows Handy's
    "alternative interactions" guidance: model the hub as a multiplicative
    stack of its constituent strategies, scaled by the catchment-area share
    of the TAZ and a discount factor (CAPCOA 2021 stacking guidance) to avoid double-counting
    overlapping user populations.

    %ΔVMT_area = catchment_share * composite_discount * (prod(1 + r_i) - 1)

    ``components`` is a dict mapping component name -> kwargs for the
    constituent strategy. Recognized components:
      - 'shared_micromobility'    (strategy_shared_micromobility)
      - 'transit_frequency_boost' (strategy_transit_service_expansion, frequency)
      - 'end_of_trip_facilities'  (strategy_bike_mode_share_booster, commute)

    Pass ``components=None`` to use a default urban_core deployment bundle
    (30% micromobility access, 10% effective frequency boost, 40% employee
    end-of-trip facilities). Pass ``composite_discount=1.0`` to disable the
    double-counting discount.

    Sources:
      - SANDAG (2021). Mobility Hubs Implementation Strategy.
      - Caltrans (2023). Mobility Hubs Practitioner Guide.
      - LADOT (2020). Mobility Hubs Reader's Guide.
      - TCRP Report 188 (2017). Shared Mobility and the Transformation of
        Public Transit.

    Caveat: empirical evidence base is thin (a handful of pilots, not
    statewide). Treat results as effect-size estimates, not predictions.
    """
    if composite_discount is None:
        composite_discount = PROGRAM_EFFECTS["mobility_hub_composite_discount"]
    if components is None:
        components = _MOBILITY_HUB_DEFAULT_COMPONENTS

    component_fns = {
        "shared_micromobility":    strategy_shared_micromobility,
        "transit_frequency_boost": strategy_transit_service_expansion,
        "end_of_trip_facilities":  strategy_bike_mode_share_booster,
    }

    combined = np.ones(len(taz_df))
    used = []
    for name, kw in components.items():
        if name not in component_fns:
            raise ValueError(
                f"Unknown mobility hub component {name!r}. "
                f"Choose from {list(component_fns)}."
            )
        result = component_fns[name](taz_df, **kw)
        combined = combined * (1.0 + result["pct_vmt_reduction"].fillna(0.0).values)
        used.append(name)

    stacked_pct = combined - 1.0
    pct = pd.Series(catchment_share * composite_discount * stacked_pct,
                    index=taz_df.index)

    inputs = (f"catchment={catchment_share:.0%}, discount={composite_discount:.0%}, "
              f"components={','.join(used)}")
    assumptions = pd.Series(_join_assumptions(
        "composite_stack=CAPCOA_discounted",
        "components_share_assumptions_with_constituent_strategies",
    ), index=taz_df.index)
    return _result(taz_df, "Mobility Hub", inputs, pct,
                   _base_vmt(taz_df, "all"), assumptions)


def strategy_traffic_calming(
    taz_df: pd.DataFrame,
    pct_streets_with_calming: float | None = None,
    pct_intersections_with_calming: float | None = None,
) -> pd.DataFrame:
    """
    19. Traffic Calming (CAPCOA 2010 SDT-2 - LEGACY method).

    Implements the 2010 CAPCOA Measure SDT-2, the only published method that
    assigns traffic calming a discrete VMT credit. In the 2021/2024 CAPCOA
    Handbook traffic calming was reclassified as Measure T-35, a supporting /
    *non-quantified* measure folded into pedestrian network improvements - it no
    longer carries a standalone VMT credit. This implementation is retained per
    client request for a standalone traffic-calming credit and is flagged as a
    legacy method in the output ``data_assumptions``.

    Trip pool: ALL_TRIPS. Subsector: Neighborhood Design, Plan/Community scale
    (shares the 10% Neighborhood Design subsector cap in combination).

    Method (spec §1): the VMT reduction scales the published 0.25%-1.00% SDT-2
    range by the project's traffic-calming coverage - the mean of the share of
    streets and the share of intersections that receive calming improvements::

        coverage          = mean(available of the two shares)   # 0..1
        A                 = clamp(MIN + coverage*(MAX-MIN), 0, MAX)
        pct_vmt_reduction = -A          # codebase sign convention: negative = reduction

    Simplified 2026-07-27 (content review): the two coverage **shares** are taken
    directly, replacing four raw counts (streets_with_calming / total_streets /
    intersections_with_calming / total_intersections). Counting every street and
    intersection in a large area was the most tedious input in the calculator and
    bought no precision: SDT-2 resolves to a single 0.25%-1.00% band, so only the
    ratio was ever used. This does NOT address the reviewer's deeper point - that
    planners think in terms of the number of calming devices per corridor - which
    the source literature cannot support.

    A share of 0 means "this project does not calm any of these", so the other
    share is used alone rather than averaged against a zero. Both zero means no
    calming at all and returns 0, not the 0.25% floor. Inputs are project-level,
    so the reduction is applied uniformly to every TAZ in ``taz_df``.

    Caps: measure max = 1.00% (applied here); then the Neighborhood Design
    subsector cap (10%) applies in combination downstream.

    Sources:
      - CAPCOA (2010). Quantifying GHG Mitigation Measures, Measure SDT-2, p.190.
      - SMAQMD. Recommended Guidance for Land Use Emission Reductions v3.0
        (SDT-2 coverage variable definitions).
    """
    min_e = TRAFFIC_CALMING_SDT2["min_effect"]
    max_e = TRAFFIC_CALMING_SDT2["max_effect"]

    # A share of 0 (or None) means "this project doesn't calm any of these", so it
    # is left out of the mean rather than dragging the other share toward zero.
    coverages = []
    for share in (pct_streets_with_calming, pct_intersections_with_calming):
        if share is not None and share > 0:
            coverages.append(min(max(float(share), 0.0), 1.0))

    if not coverages:
        # Nothing calmed -> no credit (not the 0.25% floor). The app reaches this
        # with both sliders at their 0% default.
        pct = pd.Series(0.0, index=taz_df.index)
        inputs = "coverage=0% (no streets or intersections calmed)"
        assumptions = pd.Series(_join_assumptions(
            "LEGACY_CAPCOA_2010_SDT-2_superseded_by_nonquantified_T-35",
            "no_coverage_entered_zero_credit",
        ), index=taz_df.index)
        return _result(taz_df, "Traffic Calming", inputs, pct,
                       _base_vmt(taz_df, "all"), assumptions)

    coverage = float(np.clip(np.mean(coverages), 0.0, 1.0))
    A = float(np.clip(min_e + coverage * (max_e - min_e), 0.0, max_e))
    pct = pd.Series(-A, index=taz_df.index)

    n_used = len(coverages)
    inputs = (f"coverage={coverage:.0%} ({n_used} of 2 measures), "
              f"SDT-2_range={min_e:.2%}-{max_e:.2%}, A={A:.2%}")
    assumptions = pd.Series(_join_assumptions(
        "LEGACY_CAPCOA_2010_SDT-2_superseded_by_nonquantified_T-35",
        "coverage=single_measure_only" if n_used == 1 else "",
    ), index=taz_df.index)
    return _result(taz_df, "Traffic Calming", inputs, pct,
                   _base_vmt(taz_df, "all"), assumptions)


# ===========================================================================
#   CAPCOA / DERIVED SPEC STRATEGIES  (tdm_strategy_methods.md)
# ===========================================================================
# Four additional strategies translated from the Implementation Spec. Two more
# from the same spec (Park-and-Ride §5, Traffic Calming §1) replaced the legacy
# functions above. All follow the CAPCOA combination framework: each applies its
# own measure max / subsector cap, returns a fraction (negative = reduction),
# and declares its trip pool so the stacking layer can segregate trip pools.


def strategy_carshare(
    taz_df: pd.DataFrame,
    service_area_share: float = 1.0,
    participation_rate: float | None = None,
    member_vmt_reduction: float | None = None,
    measure_max: float | None = None,
) -> pd.DataFrame:
    """
    20. Carshare (CAPCOA T-21).

    Subsector: Neighborhood Design, Plan/Community scale (10% subsector cap).
    Trip pool: ALL_TRIPS.

    Mechanism: carshare reduces VMT primarily by lowering private vehicle
    ownership and shifting members toward as-needed vehicle access, transit, and
    active modes. The credit is the share of the service-area population who
    become members times the per-member VMT reduction, capped at the measure /
    subsector maximum::

        member_pop_share = participation_rate * service_area_share
        A                = min(member_pop_share * member_vmt_reduction, measure_max)
        pct_vmt_reduction = -A

    .. warning::
       The verbatim T-21 equation and constants were NOT captured during
       research and the T-21 fact-sheet PDF was unreachable at implementation
       time (HTTP 404). ``participation_rate`` and ``member_vmt_reduction`` are
       LABELED PLACEHOLDERS (see ``CARSHARE_T21``); the output flags this. The
       structural form is unit-consistent and the result is bounded by the
       Neighborhood Design subsector cap, but the two constants MUST be confirmed
       against the T-21 fact sheet before the numbers are relied upon
       (spec §2; outstanding item #1). Confirm: member- vs household-based
       denominator, the per-participant reduction constant, and the measure max.

    Inputs:
      service_area_share - share of each TAZ's population within the carshare
        service area (default 1.0 = treat the whole TAZ as served).

    Applied per-TAZ against all-trip VMT.
    """
    p_rate = participation_rate if participation_rate is not None else CARSHARE_T21["participation_rate"]
    m_red  = member_vmt_reduction if member_vmt_reduction is not None else CARSHARE_T21["member_vmt_reduction"]
    cap    = measure_max if measure_max is not None else CARSHARE_T21["measure_max"]

    member_pop_share = p_rate * service_area_share
    a_raw = member_pop_share * m_red
    a = min(a_raw, cap)
    pct = pd.Series(-a, index=taz_df.index)

    inputs = (f"service_area_share={service_area_share:.0%}, "
              f"participation_rate={p_rate:.1%}, member_vmt_reduction={m_red:.0%}, "
              f"A={a:.2%} (cap={cap:.0%})")
    placeholder = (participation_rate is None) or (member_vmt_reduction is None)
    assumptions = pd.Series(_join_assumptions(
        "CAPCOA_T-21_constants=PLACEHOLDER_confirm_against_fact_sheet" if placeholder else "",
        "subsector=neighborhood_design_10pct_cap",
    ), index=taz_df.index)
    return _result(taz_df, "Carshare", inputs, pct,
                   _base_vmt(taz_df, "all"), assumptions)


def strategy_transit_shelters(
    taz_df: pd.DataFrame,
    level_of_implementation: float = 1.0,
    shelter_ridership_uplift: float | None = None,
    measure_max: float | None = None,
    brt_stop_share: float = 0.0,
) -> pd.DataFrame:
    """
    21. Transit Shelters (CAPCOA T-46).

    Subsector: Transit, Plan/Community scale (15% Transit subsector cap).
    Trip pool: ALL_TRIPS.

    Mechanism: shelters / station improvements raise transit's attractiveness,
    producing a small ridership gain that converts to a VMT reduction via the
    same ridership-to-VMT machinery as T-26 (Increase Transit Service
    Frequency)::

        A = LOI * shelter_ridership_uplift * transit_MS * (1/AVO) / vehicle_MS
        pct_vmt_reduction = -clamp(A, 0, measure_max)

    The FHWA mode-shift factor G (=1/avg occupancy 1.7 = 0.578 in the T-26
    reference) is replaced here by the **observed per-TAZ AVO** (1/AVO) wherever
    the TDM model supplies it, falling back to the statewide default otherwise.

    Overlap with T-28 (Bus Rapid Transit): T-28 already funds station
    improvements, so shelters at BRT stations would be double-counted.
    ``brt_stop_share`` is the share of the area's transit stops already covered
    by BRT station investment, and the credit is scaled by ``1 - brt_stop_share``
    (a **partial** exclusion, default 0.0).

    Changed 2026-07-27 (content review): this replaced an all-or-nothing
    ``brt_covers_all_routes`` flag that zeroed the whole credit. A BRT corridor
    inside a project area almost never means every route in that area is BRT, so
    the flag was either never true or wildly over-applied. ``brt_stop_share=1.0``
    reproduces the old zeroing behaviour.

    .. warning::
       The verbatim T-46 equation and constants were NOT captured during
       research (fact-sheet PDF unreadable at implementation time).
       ``shelter_ridership_uplift`` and ``measure_max`` are LABELED PLACEHOLDERS
       (see ``TRANSIT_SHELTERS_T46``); the output flags this. Confirm against the
       T-46 fact sheet before relying on the numbers (spec §3; outstanding #2).
    """
    cap = measure_max if measure_max is not None else TRANSIT_SHELTERS_T46["measure_max"]
    uplift = shelter_ridership_uplift if shelter_ridership_uplift is not None \
        else TRANSIT_SHELTERS_T46["shelter_ridership_uplift"]
    # Share of area stops already covered by BRT station investment. Clamped so a
    # stray >1 or <0 can't flip the credit's sign.
    brt = min(max(float(brt_stop_share), 0.0), 1.0)

    df = add_imputed_avo(add_imputed_mode_shares(taz_df))
    a_raw = level_of_implementation * uplift * df["transit_mode_share"] \
        * (1.0 / df["avo"]) / df["auto_mode_share"].clip(lower=1e-9)
    a = a_raw.clip(lower=0.0, upper=cap)
    pct = -a * (1.0 - brt)

    inputs = (f"LOI={level_of_implementation:.0%}, "
              f"shelter_ridership_uplift={uplift:.2%}, cap={cap:.0%}, "
              f"G=1/AVO(observed), brt_stop_share={brt:.0%}")
    placeholder = (shelter_ridership_uplift is None) or (measure_max is None)
    assumptions = pd.Series(_join_assumptions(
        "mode_share=imputed_from_area_type",
        _avo_assumption(df),
        "CAPCOA_T-46_constants=PLACEHOLDER_confirm_against_fact_sheet" if placeholder else "",
        f"BRT_station_overlap_excluded={brt:.0%}_of_stops" if brt > 0 else "",
        "subsector=transit_15pct_cap",
    ), index=df.index)
    return _result(df, "Transit Shelters", inputs, pct,
                   _base_vmt(df, "all"), assumptions)


def strategy_pedestrian_network_improvements(
    taz_df: pd.DataFrame,
    existing_sidewalk_mi: float,
    sidewalk_mi_with_measure: float,
    elasticity: float | None = None,
    measure_max: float | None = None,
) -> pd.DataFrame:
    """
    22. Pedestrian Network Improvements (CAPCOA T-18 - verbatim).

    Subsector: Neighborhood Design, Plan/Community scale (10% subsector cap).
    Trip pool: HOUSEHOLD (household vehicle travel). The calculator does not
    carry a household-only VMT split, so the reduction is applied to all-trip
    VMT and flagged ``trip_pool=household_approx_as_all``.

    Mechanism (verbatim, T-18 fact sheet pp.133-136): added sidewalk coverage
    (new sidewalk + repaired substandard sidewalk) shifts short trips from
    driving to walking::

        A = ((C / B) - 1) * D
        pct_vmt_reduction = clamp(A, -measure_max, 0)

    where B = existing sidewalk miles, C = sidewalk miles with the measure (both
    measured on **both sides of the street** within a ~0.6-mile-radius study
    area), and D = -0.05 (elasticity of household VMT w.r.t. the
    sidewalk-to-street ratio; Frank 2011, Handy 2014). A is already negative when
    C > B, matching the codebase sign convention (negative = reduction).

    Caps: measure max ``Amax`` = 6.4% (FHWA 2019 short-trip derivation; the fact
    sheet also references 3.4% in one place - 6.4% is used per the cap
    derivation and worked example, flagged for reviewer confirmation). Then the
    Neighborhood Design subsector cap (10%) applies in combination.

    Worked example (unit test): B=9, C=10 -> A=((10/9)-1)*-0.05 = -0.56% ~= -0.6%.

    Inputs are project-level sidewalk mileage, applied uniformly to every TAZ in
    ``taz_df`` (the study area).
    """
    if existing_sidewalk_mi is None or existing_sidewalk_mi <= 0:
        raise ValueError("existing_sidewalk_mi (B) must be > 0.")
    d = elasticity if elasticity is not None else PED_NETWORK_T18["elasticity"]
    cap = measure_max if measure_max is not None else PED_NETWORK_T18["measure_max"]

    a_raw = ((sidewalk_mi_with_measure / existing_sidewalk_mi) - 1.0) * d
    a = float(np.clip(a_raw, -cap, 0.0))
    pct = pd.Series(a, index=taz_df.index)

    inputs = (f"B={existing_sidewalk_mi:.2f}mi, C={sidewalk_mi_with_measure:.2f}mi, "
              f"D={d}, A={a:.2%} (Amax={cap:.1%})")
    assumptions = pd.Series(_join_assumptions(
        "trip_pool=household_approx_as_all",
        "Amax=6.4pct_flag_3.4pct_discrepancy_for_reviewer" if cap == PED_NETWORK_T18["measure_max"] else "",
        "subsector=neighborhood_design_10pct_cap",
    ), index=taz_df.index)
    return _result(taz_df, "Pedestrian Network Improvements", inputs, pct,
                   _base_vmt(taz_df, "all"), assumptions)


def strategy_wayfinding(
    taz_df: pd.DataFrame,
    loi_transit: float = 0.0,
    loi_active: float = 0.0,
    transit_present: bool | None = None,
    active_present: bool | None = None,
    ridership_uplift: float | None = None,
    connectivity_uplift: float | None = None,
) -> pd.DataFrame:
    """
    23. Wayfinding (DERIVED, two-channel; assumption-bounded).

    Trip pool: ALL_TRIPS (combined active-mode + transit substitution both draw
    from the general trip pool; segregated from commute-only measures).

    No empirical VMT effect size exists for wayfinding in any mode. This credits
    a small, capped, mode-specific friction-reduction uplift routed through the
    CAPCOA T-26 (transit) and T-18 (active-mode) conversion machinery, with a
    conservative assumed uplift of 0.25% per channel. Two channels combine
    multiplicatively::

        ch_transit = clamp(LOI_transit * R_UPLIFT * transit_MS * (1/AVO) / vehicle_MS, 0, CAP)
        ch_active  = clamp(LOI_active  * C_UPLIFT * |PED_ELASTICITY|,                  0, CAP)
        pct_vmt_reduction = -(1 - (1 - ch_transit)*(1 - ch_active))

    The transit channel's mode-shift factor uses the **observed per-TAZ AVO**
    (1/AVO) in place of the fixed 0.578 reference. Per-channel cap = 0.5%.

    Guardrails (spec §6.1) - parent-gated: each channel is creditable only where
    the parent modal investment exists. The transit channel requires transit
    service (auto-detected from ``transit_vrh`` / ``transit_route_count`` when
    ``transit_present`` is None); the active channel requires an existing
    bike/ped network (auto-detected from ``bike_centerline_mi``). A channel whose
    parent is absent returns 0.

    .. note::
       Assumption-based, not empirically derived. The active-mode channel is the
       weaker analogy - a usability multiplier on *existing* infrastructure
       borrowing the T-18 -0.05 elasticity as structure, not a measured
       wayfinding effect. Creditable only alongside the parent modal investment;
       never claim wayfinding as an independent strategy. Uplifts are exposed via
       ``WAYFINDING_DERIVED`` for recalibration (outstanding item #5).
    """
    r_uplift = ridership_uplift if ridership_uplift is not None else WAYFINDING_DERIVED["ridership_uplift"]
    c_uplift = connectivity_uplift if connectivity_uplift is not None else WAYFINDING_DERIVED["connectivity_uplift"]
    cap = WAYFINDING_DERIVED["channel_cap"]
    ped_e = abs(WAYFINDING_DERIVED["ped_elasticity"])

    df = add_imputed_avo(add_imputed_mode_shares(taz_df))

    # Parent-gating (per-TAZ). Auto-detect from the prepared table when the
    # caller doesn't assert presence explicitly.
    if transit_present is None:
        t_serv = df.get("transit_vrh", pd.Series(0.0, index=df.index)).fillna(0.0)
        t_rte = df.get("transit_route_count", pd.Series(0.0, index=df.index)).fillna(0.0)
        transit_gate = (t_serv > 0) | (t_rte > 0)
    else:
        transit_gate = pd.Series(bool(transit_present), index=df.index)
    if active_present is None:
        bike_mi = df.get("bike_centerline_mi", pd.Series(0.0, index=df.index)).fillna(0.0)
        active_gate = bike_mi > 0
    else:
        active_gate = pd.Series(bool(active_present), index=df.index)

    ch_transit_raw = loi_transit * r_uplift * df["transit_mode_share"] \
        * (1.0 / df["avo"]) / df["auto_mode_share"].clip(lower=1e-9)
    ch_transit = ch_transit_raw.clip(lower=0.0, upper=cap).where(transit_gate, 0.0)

    ch_active_raw = loi_active * c_uplift * ped_e
    ch_active = pd.Series(np.clip(ch_active_raw, 0.0, cap), index=df.index).where(active_gate, 0.0)

    combined = 1.0 - (1.0 - ch_transit) * (1.0 - ch_active)
    pct = -combined

    inputs = (f"LOI_transit={loi_transit:.0%} (gated={transit_gate.mean():.0%} of TAZs), "
              f"LOI_active={loi_active:.0%} (gated={active_gate.mean():.0%}), "
              f"uplift={r_uplift:.2%}/channel, cap={cap:.1%}/channel")
    assumptions = pd.Series(_join_assumptions(
        "ASSUMPTION_BASED_no_empirical_wayfinding_effect_size",
        "parent_gated_requires_modal_investment",
        "mode_share=imputed_from_area_type",
        _avo_assumption(df),
    ), index=df.index)
    return _result(df, "Wayfinding", inputs, pct,
                   _base_vmt(df, "all"), assumptions)


# ---------------------------------------------------------------------------
# Registry & summarize
# ---------------------------------------------------------------------------

# Planner-facing catalog: one entry per real-world tile (matches the YAML ids in
# strategy-catalog/strategies/). Several tiles share an engine via thin wrappers.
STRATEGY_REGISTRY: dict[str, callable] = {
    # --- Transit ---
    "transit_service_expansion":       strategy_transit_service_expansion,  # frequency basis
    "new_transit_service":             strategy_new_transit_service,
    "transit_pass_subsidy":            strategy_transit_pass_subsidy,
    "employee_commuting_benefits":     strategy_employee_commute_benefits,
    # --- Bike / micromobility ---
    "separated_bike_lanes":            strategy_separated_bike_lanes,
    "sharrows_bike_lanes":             strategy_sharrows_bike_lanes,
    "end_of_trip_facilities":          strategy_end_of_trip_facilities,
    "shared_micromobility":            strategy_shared_micromobility,
    # --- Land use ---
    "residential_density":             strategy_residential_density,
    "employment_density":              strategy_employment_density,
    "transit_oriented_development":    strategy_transit_oriented_development,
    "affordable_housing":              strategy_affordable_housing,
    # --- Parking ---
    "workplace_parking_pricing":       strategy_workplace_parking_pricing,
    "parking_fees_curb_management":    strategy_parking_fees_curb_management,
    "dynamic_parking_pricing":         strategy_dynamic_parking_pricing,
    "unbundled_parking":               strategy_unbundled_parking,
    "parking_cashout":                 strategy_parking_cashout,
    # --- Vanpool / programs ---
    "vanpool":                         strategy_vanpool,
    "tmo_coverage":                    strategy_tmo_coverage,
    "commute_marketing":               strategy_commute_marketing,
    "commute_incentives":              strategy_commute_incentives,
    "telework":                        strategy_telework,
    # --- Induced demand ---
    "lane_mile_addition":              strategy_lane_mile_addition,
    # --- Additional ---
    "park_and_ride":                   strategy_park_and_ride,
    "mobility_hub":                    strategy_mobility_hub,
    "traffic_calming":                 strategy_traffic_calming,
    # --- CAPCOA / derived spec strategies (tdm_strategy_methods.md) ---
    "car_share_access":                strategy_carshare,
    "transit_shelters":                strategy_transit_shelters,
    "pedestrian_network_improvements": strategy_pedestrian_network_improvements,
    "wayfinding":                      strategy_wayfinding,
}

# Merged engine functions retained under their original keys for back-compat:
# Mobility Hub stacks them directly and generate_golden_fixtures.py pins to
# them. The planner-facing tiles above are thin wrappers around these. Merged in
# for any caller that still looks a strategy up by its pre-split key.
ENGINE_REGISTRY: dict[str, callable] = {
    "transit_fare_subsidy":            strategy_transit_fare_subsidy,
    "bike_mode_share_booster":         strategy_bike_mode_share_booster,
    "density_change":                  strategy_density_change,
    "parking_pricing":                 strategy_parking_pricing,
    "commute_program":                 strategy_commute_program,
}
STRATEGY_REGISTRY.update(ENGINE_REGISTRY)


def summarize(*results: pd.DataFrame) -> pd.DataFrame:
    """Stack per-strategy result frames into one long table for side-by-side viewing."""
    return pd.concat(results, ignore_index=True)


# ---------------------------------------------------------------------------
# CLI smoke test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys, io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

    from prepare_taz import prepare_taz

    print("Loading prepared TAZ table ...")
    prep = prepare_taz()
    df = prep.df
    df = add_imputed_parking(add_imputed_avo(add_imputed_mode_shares(df)))

    top_emp = df.nlargest(3, "employment")
    top_pop = df.nlargest(2, "population")
    sample = pd.concat([top_emp, top_pop]).drop_duplicates("taz_id").head(5).reset_index(drop=True)
    print(f"\nSmoke-testing on 5 TAZs: {sample['taz_id'].tolist()}")
    print(f"Area types: {sample['area_type'].tolist()}\n")

    runs = [
        ("transit_service_expansion",     dict(pct_change=0.25, basis="frequency",
                                                level_of_implementation=0.60)),
        ("transit_service_expansion",     dict(pct_change=0.20, basis="service_miles")),
        ("transit_fare_subsidy",          dict(pct_fare_reduction=0.50, pct_eligible=0.40,
                                                scope="all")),
        ("transit_fare_subsidy",          dict(subsidy_amount=2.00, pct_eligible=0.50,
                                                scope="commute")),
        ("separated_bike_lanes",          dict(pct_parallel_vmt_affected=0.05)),
        ("bike_mode_share_booster",       dict(scope_share=0.10, scope="area_vmt")),
        ("bike_mode_share_booster",       dict(scope_share=0.40, scope="commute")),
        ("shared_micromobility",          dict(pct_pop_access_before=0.0,
                                                pct_pop_access_after=0.30)),
        ("density_change",                dict(pct_change_res_density=0.20)),
        ("density_change",                dict(pct_change_res_density=0.20,
                                                pct_change_emp_density=0.20)),
        ("transit_oriented_development",  dict()),
        ("affordable_housing",            dict(pct_units_affordable=0.30)),
        ("parking_pricing",               dict(new_price=15.0, trip_purpose="commute")),
        ("parking_pricing",               dict(new_price=8.0, trip_purpose="all",
                                                share_affected=0.30)),
        ("unbundled_parking",             dict(annual_parking_cost=1800)),
        ("parking_cashout",               dict(pct_eligible_employees=0.40)),
        ("vanpool",                       dict(pct_trips_impacted=0.05)),
        ("tmo_coverage",                  dict(share_before=0.0, share_after=0.40)),
        ("commute_program",               dict(pct_eligible=0.50)),
        ("telework",                      dict(pct_eligible=0.50, telework_days_per_week=2)),
        ("lane_mile_addition",            dict(new_lane_miles=2.0, facility_class="major_arterial")),
        ("park_and_ride",                 dict(n_spaces=200, l_access_mi=4.0,
                                                isolated_facility=True,
                                                total_transit_trips_catchment=500)),
        ("mobility_hub",                  dict(catchment_share=0.30)),
        ("traffic_calming",               dict(pct_streets_with_calming=0.15,
                                                pct_intersections_with_calming=0.15)),
        # CAPCOA / derived spec strategies (tdm_strategy_methods.md)
        ("car_share_access",              dict(service_area_share=0.5)),
        ("transit_shelters",              dict(level_of_implementation=0.5)),
        ("pedestrian_network_improvements", dict(existing_sidewalk_mi=9.0,
                                                  sidewalk_mi_with_measure=10.0)),
        ("wayfinding",                    dict(loi_transit=1.0, loi_active=1.0)),
        # Planner-facing split tiles (thin wrappers over the engines above)
        ("new_transit_service",           dict(pct_change=0.20)),
        ("transit_pass_subsidy",          dict(pct_fare_reduction=0.50, pct_eligible=0.40)),
        ("employee_commuting_benefits",   dict(subsidy_amount=2.00, pct_eligible=0.50)),
        ("sharrows_bike_lanes",           dict(scope_share=0.10)),
        ("end_of_trip_facilities",        dict(scope_share=0.40)),
        ("residential_density",           dict(pct_change_res_density=0.20)),
        ("employment_density",            dict(pct_change_emp_density=0.20)),
        ("workplace_parking_pricing",     dict(new_price=15.0)),
        ("parking_fees_curb_management",  dict(new_price=8.0, share_affected=0.30)),
        ("dynamic_parking_pricing",       dict(new_price=8.0, share_affected=0.30)),
        ("commute_marketing",             dict(pct_eligible=0.50)),
        ("commute_incentives",            dict(pct_eligible=0.50)),
    ]

    for name, kwargs in runs:
        fn = STRATEGY_REGISTRY[name]
        res = fn(sample, **kwargs)
        med_pct = res["pct_vmt_reduction"].median()
        med_red = res["daily_vmt_reduction"].median()
        n_assumed = (res["data_assumptions"].astype(str).str.len() > 0).sum()
        kw_str = ", ".join(f"{k}={v}" for k, v in list(kwargs.items())[:2])
        label = f"{name} ({kw_str})"[:60]
        print(f"  {label:<62}  median %Δ={med_pct:+7.2%}  "
              f"Δ={med_red:>10,.0f} mi/day  ({n_assumed}/{len(res)} used defaults)")

    print(f"\n{len(STRATEGY_REGISTRY)} strategies registered, "
          f"{len(runs)} parameter variants tested.")
