"""
generate_compute_golden.py — validate every YAML `compute:` block against the
authoritative Python engine, and emit a golden fixture for the app's TS test.

For each closed-form (compute-block) strategy this:
  1. evaluates the compiled YAML `compute` block with the Python DSL evaluator
     (scripts/strategy_compute.run_compute)
  2. runs the matching authoritative function in strategy_calculations.py
  3. asserts the two agree (the DSL faithfully reproduces the hand-coded math)
  4. writes the cases to app/src/strategies/__fixtures__/compute_golden.json

The app's computeDsl.test.ts then asserts the TypeScript evaluator reproduces
expected_pct for the same {row, params} — so the two evaluators are pinned to
the Python engine and to each other.

Run from the repo root or scripts/:  python scripts/generate_compute_golden.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import strategy_calculations as sc  # noqa: E402
from strategy_compute import run_compute  # noqa: E402

CATALOG = HERE.parent / "strategy-catalog" / "compiled" / "strategies.json"
OUT = HERE.parent / "app" / "src" / "strategies" / "__fixtures__" / "compute_golden.json"
TOL = 1e-9


def base_row(**extra) -> pd.DataFrame:
    row = dict(
        taz_id=1, area_type="urban", daily_vmt=100000.0,
        population=2000.0, employment=1500.0, daily_trips=8000.0, avg_trip_length=5.0,
        vmt_share_commute=0.30, vmt_share_recreational=0.20, vmt_share_other=0.50,
    )
    row.update(extra)
    return pd.DataFrame([row])


def _imputed_row(df: pd.DataFrame, *extra_cols: str) -> dict:
    """Pull the values the engine imputes (mode shares + AVO) plus named extras."""
    imp = sc.add_imputed_avo(sc.add_imputed_mode_shares(df))
    row = dict(
        transit_mode_share=float(imp["transit_mode_share"].iloc[0]),
        auto_mode_share=float(imp["auto_mode_share"].iloc[0]),
        avo=float(imp["avo"].iloc[0]),
    )
    for c in extra_cols:
        row[c] = float(df[c].iloc[0])
    return row


# Each handler returns (pct_engine, dsl_row, dsl_params).
def case_traffic_calming(p):
    pct = float(sc.strategy_traffic_calming(base_row(), **p)["pct_vmt_reduction"].iloc[0])
    return pct, {}, p


def case_ped(p):
    pct = float(sc.strategy_pedestrian_network_improvements(base_row(), **p)["pct_vmt_reduction"].iloc[0])
    return pct, {}, p


def case_carshare(p):
    pct = float(sc.strategy_carshare(base_row(), **p)["pct_vmt_reduction"].iloc[0])
    return pct, {}, p


def case_wayfinding(p):
    gate = {k: p[k] for k in ("transit_vrh", "transit_route_count", "bike_centerline_mi")}
    df = base_row(**gate)
    pct = float(sc.strategy_wayfinding(df, loi_transit=p["loi_transit"], loi_active=p["loi_active"])
                ["pct_vmt_reduction"].iloc[0])
    row = _imputed_row(df, *gate.keys())
    return pct, row, dict(loi_transit=p["loi_transit"], loi_active=p["loi_active"])


def case_transit_shelters(p):
    df = base_row()
    pct = float(sc.strategy_transit_shelters(
        df, level_of_implementation=p["level_of_implementation"],
        brt_stop_share=p["brt"])["pct_vmt_reduction"].iloc[0])
    row = _imputed_row(df)
    return pct, row, dict(level_of_implementation=p["level_of_implementation"],
                          brt_stop_share=p["brt"])


def _generic_row() -> dict:
    """Imputed mode shares + AVO + avg_trip_length on the base TAZ — a superset
    of the row fields any of the migrated closed-form strategies read."""
    df = base_row()
    row = _imputed_row(df)
    imp = sc.add_imputed_mode_shares(df)
    row["bike_mode_share"] = float(imp["bike_mode_share"].iloc[0])
    row["walk_mode_share"] = float(imp["walk_mode_share"].iloc[0])
    row["avg_trip_length"] = float(df["avg_trip_length"].iloc[0])
    pk = sc.add_imputed_parking(df)
    row["parking_price"] = float(pk["current_parking_price"].iloc[0])
    return row


def case_generic(sid):
    """Engine oracle via the Python registry; DSL params == the user inputs."""
    def handler(p):
        pct = float(sc.STRATEGY_REGISTRY[sid](base_row(), **p)["pct_vmt_reduction"].iloc[0])
        return pct, _generic_row(), p
    return handler


CASES = [
    ("traffic_calming", case_traffic_calming,
     dict(streets_with_calming=4, total_streets=10, intersections_with_calming=2, total_intersections=8)),
    ("traffic_calming", case_traffic_calming,
     dict(streets_with_calming=10, total_streets=10, intersections_with_calming=0, total_intersections=0)),
    ("traffic_calming", case_traffic_calming,
     dict(streets_with_calming=0, total_streets=10, intersections_with_calming=5, total_intersections=10)),
    ("pedestrian_network_improvements", case_ped,
     dict(existing_sidewalk_mi=9.0, sidewalk_mi_with_measure=10.0)),
    ("pedestrian_network_improvements", case_ped,
     dict(existing_sidewalk_mi=5.0, sidewalk_mi_with_measure=6.0)),
    ("pedestrian_network_improvements", case_ped,
     dict(existing_sidewalk_mi=2.0, sidewalk_mi_with_measure=20.0)),
    ("car_share_access", case_carshare, dict(service_area_share=1.0)),
    ("car_share_access", case_carshare, dict(service_area_share=0.5)),
    ("wayfinding", case_wayfinding,
     dict(loi_transit=0.5, loi_active=0.5, transit_vrh=10.0, transit_route_count=2.0, bike_centerline_mi=5.0)),
    ("wayfinding", case_wayfinding,
     dict(loi_transit=1.0, loi_active=0.0, transit_vrh=10.0, transit_route_count=2.0, bike_centerline_mi=0.0)),
    ("wayfinding", case_wayfinding,
     dict(loi_transit=1.0, loi_active=1.0, transit_vrh=0.0, transit_route_count=0.0, bike_centerline_mi=5.0)),
    ("transit_shelters", case_transit_shelters, dict(level_of_implementation=1.0, brt=0.0)),
    ("transit_shelters", case_transit_shelters, dict(level_of_implementation=0.5, brt=0.0)),
    # brt=1.0 reproduces the pre-2026-07-27 all-or-nothing zeroing; brt=0.4 pins the
    # partial exclusion the share-based input added.
    ("transit_shelters", case_transit_shelters, dict(level_of_implementation=1.0, brt=1.0)),
    ("transit_shelters", case_transit_shelters, dict(level_of_implementation=1.0, brt=0.4)),

    # --- batch 2: the 14 migrated closed-form strategies (engine oracle) ---
    ("residential_density", case_generic("residential_density"), dict(pct_change_res_density=0.20)),
    ("residential_density", case_generic("residential_density"), dict(pct_change_res_density=-0.10)),
    ("employment_density", case_generic("employment_density"), dict(pct_change_emp_density=0.20)),
    ("tmo_coverage", case_generic("tmo_coverage"), dict(share_before=0.0, share_after=0.40)),
    ("tmo_coverage", case_generic("tmo_coverage"), dict(share_before=0.20, share_after=0.60)),
    ("commute_marketing", case_generic("commute_marketing"), dict(pct_eligible=0.5, reduction_per_eligible=0.01)),
    ("commute_incentives", case_generic("commute_incentives"), dict(pct_eligible=0.5, reduction_per_eligible=0.03)),
    ("telework", case_generic("telework"), dict(pct_eligible=0.5, telework_days_per_week=2)),
    ("telework", case_generic("telework"), dict(pct_eligible=1.0, telework_days_per_week=5)),
    ("vanpool", case_generic("vanpool"), dict(pct_trips_impacted=0.05, pct_service_change=0.5)),
    ("transit_oriented_development", case_generic("transit_oriented_development"), dict(pct_taz_in_tod=0.30, tod_mode_share_ratio=4.9)),
    ("new_transit_service", case_generic("new_transit_service"), dict(pct_change=0.20, level_of_implementation=1.0)),
    ("sharrows_bike_lanes", case_generic("sharrows_bike_lanes"), dict(scope_share=0.10)),
    ("end_of_trip_facilities", case_generic("end_of_trip_facilities"), dict(scope_share=0.40)),
    ("transit_pass_subsidy", case_generic("transit_pass_subsidy"), dict(pct_fare_reduction=0.50, pct_eligible=0.40)),
    ("employee_commuting_benefits", case_generic("employee_commuting_benefits"), dict(subsidy_amount=2.00, pct_eligible=0.50)),
    ("separated_bike_lanes", case_generic("separated_bike_lanes"), dict(pct_parallel_vmt_affected=0.05, annual_use_days=200)),

    # --- batch 3: parking pricing tiles (engine oracle; reads imputed parking_price) ---
    ("workplace_parking_pricing", case_generic("workplace_parking_pricing"), dict(new_price=5.0, share_affected=0.25)),
    ("workplace_parking_pricing", case_generic("workplace_parking_pricing"), dict(new_price=12.0, share_affected=0.25)),
    ("parking_fees_curb_management", case_generic("parking_fees_curb_management"), dict(new_price=8.0, share_affected=0.30)),
    ("dynamic_parking_pricing", case_generic("dynamic_parking_pricing"), dict(new_price=8.0, share_affected=0.30)),
]


def main() -> int:
    specs = {s["id"]: s.get("compute") for s in json.load(open(CATALOG))["strategies"]}
    fixture = []
    failures = 0

    for sid, handler, p in CASES:
        spec = specs.get(sid)
        if spec is None:
            print(f"  [skip] {sid}: no compute block in compiled catalog")
            failures += 1
            continue
        pct_engine, row, dsl_params = handler(p)
        pct_dsl = run_compute(spec, row=row, params=dsl_params)
        ok = abs(pct_dsl - pct_engine) <= TOL
        if not ok:
            failures += 1
        print(f"  {'ok ' if ok else 'FAIL'} {sid:35s} engine={pct_engine:+.7%}  dsl_py={pct_dsl:+.7%}")
        fixture.append(dict(strategy=sid, row=row, params=dsl_params, expected_pct=pct_engine))

    if failures:
        print(f"\n✗ {failures} mismatch(es) — DSL does not reproduce the engine. Fixture NOT written.")
        return 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    json.dump(fixture, open(OUT, "w"), indent=2)
    print(f"\n✓ all {len(fixture)} cases match the engine. Wrote {OUT.relative_to(HERE.parent)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
