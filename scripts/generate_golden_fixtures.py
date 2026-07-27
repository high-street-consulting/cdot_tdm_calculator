"""
generate_golden_fixtures.py — emit golden values for the JS strategy port tests.

Runs the 11 Python strategy functions on a curated set of ~15 sample TAZs with
documented parameter variations and writes the results to
``app/src/strategies/__fixtures__/golden.json``.

The TS port's Vitest suite asserts that, given identical TAZ inputs and the
same parameters, its outputs match these golden values within tolerance.

The 11 strategies chosen here mirror the user's Sprint-1 set:

  density_change, separated_bike_lanes, bike_mode_share_booster,
  transit_service_expansion, shared_micromobility,
  transit_oriented_development, vanpool, tmo_coverage, commute_program,
  telework, lane_mile_addition

TAZ selection:
  3 urban_core (+ACS), 3 urban (+ACS), 3 suburban (mixed ACS),
  3 rural (mixed ACS), 3 large-employment outliers (DIA, downtown DEN, etc.)
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prepare_taz import prepare_taz
import strategy_calculations as sc

OUT_PATH = Path(__file__).resolve().parent.parent / "app" / "src" / "strategies" / "__fixtures__" / "golden.json"


def pick_sample_tazs(df: pd.DataFrame, n_per_bucket: int = 3) -> pd.DataFrame:
    """Pick a deterministic sample spanning area types and ACS coverage states."""
    df = df.copy()
    df["has_acs"] = df["acs_total_workers"].notna() & (df["acs_total_workers"].fillna(0) > 0)

    samples: list[pd.DataFrame] = []
    # 3 urban_core with ACS, top-employment first
    samples.append(
        df[(df["area_type"] == "urban_core") & df["has_acs"]]
            .nlargest(n_per_bucket, "employment")
    )
    # 3 urban with ACS
    samples.append(
        df[(df["area_type"] == "urban") & df["has_acs"]]
            .nlargest(n_per_bucket, "employment")
    )
    # 2 suburban with ACS + 1 without
    samples.append(
        df[(df["area_type"] == "suburban") & df["has_acs"]]
            .nlargest(2, "population")
    )
    samples.append(
        df[(df["area_type"] == "suburban") & ~df["has_acs"]]
            .nlargest(1, "population")
    )
    # 2 rural with ACS + 1 without
    samples.append(
        df[(df["area_type"] == "rural") & df["has_acs"]]
            .nlargest(2, "population")
    )
    samples.append(
        df[(df["area_type"] == "rural") & ~df["has_acs"]]
            .nlargest(1, "population")
    )

    sample = pd.concat(samples).drop_duplicates("taz_id").reset_index(drop=True)
    return sample


# Each entry: (strategy_name, kwargs, label).
# The label disambiguates multiple runs of the same strategy.
RUNS: list[tuple[str, dict, str]] = [
    # 1. Density Change ----------------------------------------------------
    ("density_change", dict(pct_change_res_density=0.20), "density_change_res20"),
    ("density_change", dict(pct_change_res_density=0.20, pct_change_emp_density=0.20),
        "density_change_res20_emp20"),
    ("density_change", dict(pct_change_res_density=-0.10), "density_change_resneg10"),

    # 2. Separated Bike Lanes ---------------------------------------------
    ("separated_bike_lanes", dict(pct_parallel_vmt_affected=0.05), "bike_lanes_5pct"),
    ("separated_bike_lanes", dict(pct_parallel_vmt_affected=0.10), "bike_lanes_10pct"),
    ("separated_bike_lanes", dict(pct_parallel_vmt_affected=0.05, annual_use_days=200),
        "bike_lanes_5pct_200days"),

    # 3. Bike Mode-Share Booster ------------------------------------------
    ("bike_mode_share_booster", dict(scope_share=0.10, scope="area_vmt"),
        "bike_booster_area10"),
    ("bike_mode_share_booster", dict(scope_share=0.40, scope="commute"),
        "bike_booster_commute40"),
    ("bike_mode_share_booster",
        dict(scope_share=0.10, scope="area_vmt", adjustment_factor=0.20),
        "bike_booster_area10_adj20"),

    # 4. Transit Service Expansion ----------------------------------------
    ("transit_service_expansion",
        dict(pct_change=0.25, basis="frequency", level_of_implementation=0.60),
        "transit_freq25_imp60"),
    ("transit_service_expansion",
        dict(pct_change=0.20, basis="service_miles"),
        "transit_svc20"),
    ("transit_service_expansion",
        dict(pct_change=0.50, basis="frequency"),
        "transit_freq50"),

    # 5. Shared Micromobility ---------------------------------------------
    ("shared_micromobility",
        dict(pct_pop_access_before=0.0, pct_pop_access_after=0.30),
        "micromobility_0_30"),
    ("shared_micromobility",
        dict(pct_pop_access_before=0.0, pct_pop_access_after=0.30,
             micromobility_type="e-bikeshare"),
        "micromobility_0_30_ebike"),
    ("shared_micromobility",
        dict(pct_pop_access_before=0.0, pct_pop_access_after=0.50,
             micromobility_type="scootershare"),
        "micromobility_0_50_scooter"),
    # Fleet mix (2026-07-27): blended ratio (0.8*38.5% + 0.2*35.0% = 37.8%), plus a
    # mix whose shares do not total 1.0 to pin the normalization. The blend itself is
    # also covered data-independently by app/src/strategies/micromobilityFleetMix.test.ts.
    ("shared_micromobility",
        dict(pct_pop_access_before=0.0, pct_pop_access_after=0.30,
             pct_fleet_pedal=0.0, pct_fleet_ebike=0.20, pct_fleet_scooter=0.80),
        "micromobility_fleet_mix_scooter_ebike"),
    ("shared_micromobility",
        dict(pct_pop_access_before=0.0, pct_pop_access_after=0.30,
             pct_fleet_pedal=0.5, pct_fleet_ebike=0.5, pct_fleet_scooter=0.5),
        "micromobility_fleet_mix_unnormalized"),

    # 6. Transit Oriented Development -------------------------------------
    ("transit_oriented_development", dict(), "tod_defaults"),
    ("transit_oriented_development", dict(pct_taz_in_tod=0.30), "tod_30pct_taz"),
    ("transit_oriented_development",
        dict(pct_taz_in_tod=0.20, tod_mode_share_ratio=3.0, max_tod_transit_share=0.40),
        "tod_custom_ratio"),

    # 7. Vanpool ----------------------------------------------------------
    ("vanpool", dict(pct_trips_impacted=0.05), "vanpool_5pct"),
    ("vanpool", dict(pct_trips_impacted=0.10, pct_service_change=0.50),
        "vanpool_10pct_svc50"),

    # 8. TMO Coverage -----------------------------------------------------
    ("tmo_coverage", dict(share_before=0.0, share_after=0.40), "tmo_0_40"),
    ("tmo_coverage", dict(share_before=0.20, share_after=0.60), "tmo_20_60"),

    # 9. Commute Program --------------------------------------------------
    ("commute_program", dict(pct_eligible=0.50), "commute_prog_50"),
    ("commute_program", dict(pct_eligible=0.80, reduction_per_eligible=0.03),
        "commute_prog_80_3pct"),

    # 10. Telework --------------------------------------------------------
    ("telework", dict(pct_eligible=0.50, telework_days_per_week=2), "telework_50_2"),
    ("telework", dict(pct_eligible=0.30, telework_days_per_week=3), "telework_30_3"),
    ("telework", dict(pct_eligible=1.0, telework_days_per_week=5), "telework_full"),

    # 11. Lane-Mile Addition ----------------------------------------------
    ("lane_mile_addition",
        dict(new_lane_miles=2.0, facility_class="major_arterial"),
        "lane_mi_2_majorart"),
    ("lane_mile_addition",
        dict(new_lane_miles=1.0, facility_class="freeway"),
        "lane_mi_1_freeway"),
    ("lane_mile_addition",
        dict(new_lane_miles=5.0, facility_class="collector"),
        "lane_mi_5_collector"),

    # ---- Planner-facing split/new tiles (added with the 2025 catalog split) ----
    # 12. New / Expanded Transit Service (service_miles basis) ------------
    ("new_transit_service", dict(pct_change=0.20, level_of_implementation=1.0),
        "new_transit_svc20"),

    # 13. Transit Pass Subsidy (fare subsidy, scope=all) ------------------
    ("transit_pass_subsidy", dict(pct_fare_reduction=0.50, pct_eligible=0.40),
        "transit_pass_50_40"),

    # 14. Employee Commute Benefits / ECO Pass (fare subsidy, scope=commute)
    ("employee_commuting_benefits", dict(subsidy_amount=2.00, pct_eligible=0.50),
        "eco_pass_sub2_50"),

    # 15. Sharrows & Painted Bike Lanes (booster, scope=area_vmt) ---------
    ("sharrows_bike_lanes", dict(scope_share=0.10), "sharrows_10"),

    # 16. End-of-Trip Bicycle Facilities (booster, scope=commute) --------
    ("end_of_trip_facilities", dict(scope_share=0.40), "end_of_trip_40"),

    # 17. Residential / Employment Density (density engine, one switch) ---
    ("residential_density", dict(pct_change_res_density=0.20), "res_density_20"),
    ("employment_density", dict(pct_change_emp_density=0.20), "emp_density_20"),

    # 18. Parking pricing tiles (pricing engine) --------------------------
    ("workplace_parking_pricing", dict(new_price=5.00, share_affected=0.25),
        "workplace_parking_5_25"),
    ("parking_fees_curb_management", dict(new_price=8.00, share_affected=0.30),
        "curb_mgmt_8_30"),
    ("dynamic_parking_pricing", dict(new_price=8.00, share_affected=0.30),
        "dynamic_parking_8_30"),

    # 19. Commute Trip-Reduction Marketing / Incentives (program engine) --
    ("commute_marketing", dict(pct_eligible=0.50, reduction_per_eligible=0.01),
        "commute_mktg_50"),
    ("commute_incentives", dict(pct_eligible=0.50, reduction_per_eligible=0.03),
        "commute_incent_50"),
]

# Closed-form strategies were migrated to the YAML `compute:` DSL and are now
# validated by scripts/generate_compute_golden.py instead. Only the strategies
# still backed by a code calc fn in app/src/strategies/strategies.ts are emitted
# here, so strategies.test.ts has no skipped cases. (The Python calc fns for the
# migrated strategies remain as analysis/oracle code.)
_CODE_BACKED = {"transit_service_expansion", "shared_micromobility", "lane_mile_addition"}
RUNS = [r for r in RUNS if r[0] in _CODE_BACKED]


def _clean_float(x):
    """Convert NaN/inf to None for JSON serialisation."""
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def _taz_to_dict(row: pd.Series, columns: list[str]) -> dict:
    """Serialise a TAZ row to JSON-friendly dict, only the columns the JS port needs."""
    out: dict = {}
    for c in columns:
        v = row.get(c)
        if pd.isna(v):
            out[c] = None
        elif isinstance(v, (int,)):
            out[c] = int(v)
        elif isinstance(v, float):
            out[c] = _clean_float(v)
        else:
            out[c] = str(v) if v is not None else None
    return out


# Columns each strategy reads from the TAZ row. The fixture only emits these
# (keeps the JSON small + makes it obvious which TAZ columns matter).
STRATEGY_TAZ_COLUMNS: dict[str, list[str]] = {
    "density_change":               ["taz_id", "daily_vmt", "area_type"],
    "separated_bike_lanes":         ["taz_id", "daily_vmt", "avg_trip_length",
                                      "annual_bikeable_days_taz", "annual_bikeable_days_county"],
    "bike_mode_share_booster":      ["taz_id", "daily_vmt", "avg_trip_length", "area_type",
                                      "acs_drove_alone_share", "acs_carpool_share",
                                      "acs_bike_share", "acs_walk_share", "acs_transit_share",
                                      "acs_total_workers"],
    "transit_service_expansion":    ["taz_id", "daily_vmt", "area_type",
                                      "acs_drove_alone_share", "acs_carpool_share",
                                      "acs_transit_share", "acs_total_workers"],
    "shared_micromobility":         ["taz_id", "daily_vmt", "daily_trips", "avg_trip_length",
                                      "population", "employment"],
    "transit_oriented_development": ["taz_id", "daily_vmt", "area_type",
                                      "acs_drove_alone_share", "acs_carpool_share",
                                      "acs_transit_share", "acs_total_workers"],
    "vanpool":                      ["taz_id", "daily_vmt", "area_type",
                                      "acs_drove_alone_share", "acs_carpool_share",
                                      "acs_transit_share", "acs_total_workers"],
    "tmo_coverage":                 ["taz_id", "daily_vmt"],
    "commute_program":              ["taz_id", "daily_vmt"],
    "telework":                     ["taz_id", "daily_vmt"],
    "lane_mile_addition":           ["taz_id", "daily_vmt", "lane_mi_freeway",
                                      "lane_mi_expressway", "lane_mi_major_arterial",
                                      "lane_mi_minor_arterial", "lane_mi_collector",
                                      "lane_mi_local"],
    # Planner-facing split/new tiles. Columns mirror the engine they delegate to.
    "new_transit_service":          ["taz_id", "daily_vmt", "area_type",
                                     "acs_transit_share", "acs_drove_alone_share",
                                     "acs_carpool_share"],
    "transit_pass_subsidy":         ["taz_id", "daily_vmt", "area_type",
                                     "acs_transit_share", "acs_drove_alone_share",
                                     "acs_carpool_share"],
    "employee_commuting_benefits":  ["taz_id", "daily_vmt", "area_type",
                                     "acs_transit_share", "acs_drove_alone_share",
                                     "acs_carpool_share"],
    "sharrows_bike_lanes":          ["taz_id", "daily_vmt", "avg_trip_length", "area_type",
                                     "acs_bike_share", "acs_transit_share",
                                     "acs_drove_alone_share", "acs_carpool_share",
                                     "acs_walk_share"],
    "end_of_trip_facilities":       ["taz_id", "daily_vmt", "avg_trip_length", "area_type",
                                     "acs_bike_share", "acs_transit_share",
                                     "acs_drove_alone_share", "acs_carpool_share",
                                     "acs_walk_share"],
    "residential_density":          ["taz_id", "daily_vmt"],
    "employment_density":           ["taz_id", "daily_vmt"],
    "workplace_parking_pricing":    ["taz_id", "daily_vmt", "area_type"],
    "parking_fees_curb_management": ["taz_id", "daily_vmt", "area_type"],
    "dynamic_parking_pricing":      ["taz_id", "daily_vmt", "area_type"],
    "commute_marketing":            ["taz_id", "daily_vmt"],
    "commute_incentives":           ["taz_id", "daily_vmt"],
}


def main() -> int:
    print("Loading prepared TAZ table ...")
    prep = prepare_taz()
    df = prep.df

    sample = pick_sample_tazs(df)
    sample_ids = sample["taz_id"].tolist()
    print(f"Sample TAZs ({len(sample)}):")
    for _, row in sample.iterrows():
        acs = "ACS+" if pd.notna(row["acs_total_workers"]) and row["acs_total_workers"] > 0 else "ACS-"
        print(f"  {row['taz_id']:>6}  {row['area_type']:<12} {row['county']:<14} "
              f"pop={int(row['population']):>6,}  emp={int(row['employment']):>6,}  "
              f"vmt={int(row['daily_vmt']):>10,}  {acs}")

    # All columns any strategy needs (so the fixture has a single tazInputs blob per TAZ)
    needed_cols = sorted(set(c for cols in STRATEGY_TAZ_COLUMNS.values() for c in cols))
    print(f"\nTAZ columns emitted: {len(needed_cols)}")

    fixture: dict = {
        "_meta": {
            "generator": "scripts/generate_golden_fixtures.py",
            "python_source": "scripts/strategy_calculations.py",
            "sample_taz_ids": sample_ids,
            "strategies": sorted({r[0] for r in RUNS}),
        },
        "taz_inputs": {
            row["taz_id"]: _taz_to_dict(row, needed_cols)
            for _, row in sample.iterrows()
        },
        "cases": [],
    }

    for strat_name, kwargs, label in RUNS:
        fn = sc.STRATEGY_REGISTRY[strat_name]
        try:
            result = fn(sample, **kwargs)
        except Exception as exc:
            print(f"  [skip] {label}: {exc}")
            continue
        # The result is a DataFrame with one row per sample TAZ.
        per_taz = []
        for _, r in result.iterrows():
            per_taz.append({
                "taz_id":               str(r["taz_id"]),
                "base_vmt_purpose":     str(r["base_vmt_purpose"]),
                "base_vmt":             _clean_float(r["base_vmt"]),
                "pct_vmt_reduction":    _clean_float(r["pct_vmt_reduction"]),
                "daily_vmt_reduction":  _clean_float(r["daily_vmt_reduction"]),
                "data_assumptions":     str(r["data_assumptions"]) if pd.notna(r["data_assumptions"]) else "",
            })
        # ``inputs`` is the strategy-formatted human-readable kwargs (just the first row).
        inputs_str = str(result["inputs"].iloc[0]) if len(result) else ""
        fixture["cases"].append({
            "label":        label,
            "strategy":     strat_name,
            "kwargs":       _serialise_kwargs(kwargs),
            "inputs_str":   inputs_str,
            "per_taz":      per_taz,
        })

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(fixture, f, indent=2)
    print(f"\nWrote {OUT_PATH}")
    print(f"  {len(fixture['cases'])} strategy x parameter cases x "
          f"{len(sample)} TAZs = {len(fixture['cases']) * len(sample)} golden rows")
    return 0


def _serialise_kwargs(kw: dict) -> dict:
    """Make kwargs JSON-safe (no NaN, native types)."""
    out: dict = {}
    for k, v in kw.items():
        if isinstance(v, (int, str, bool)) or v is None:
            out[k] = v
        elif isinstance(v, float):
            out[k] = _clean_float(v)
        else:
            out[k] = str(v)
    return out


if __name__ == "__main__":
    raise SystemExit(main())
