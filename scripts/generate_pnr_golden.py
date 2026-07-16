"""
generate_pnr_golden.py — golden fixture for the hand-ported Park-and-Ride TS fn.

Park-and-Ride is a COMPLEX, cross-TAZ strategy: it stays in Python
(strategy_calculations.py::strategy_park_and_ride) and is hand-ported to
app/src/strategies/parkAndRide.ts. This script runs the Python engine on a few
controlled multi-TAZ scenarios — using the same path the app takes (whole set as
catchment, supply-side only, observed trip length from avg_trip_length) — and
writes the per-TAZ results to app/src/strategies/__fixtures__/pnr_golden.json.

parkAndRide.test.ts then asserts the TS port reproduces these values. This is
the "verify outputs are identical" gate for the complex (translate-by-hand) path.

Run:  python scripts/generate_pnr_golden.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import strategy_calculations as sc  # noqa: E402

OUT = HERE.parent / "app" / "src" / "strategies" / "__fixtures__" / "pnr_golden.json"


def frame(rows: list[dict]) -> pd.DataFrame:
    # No vmt_share_commute column -> Python uses the 0.30 default, matching the
    # TS VMT_PURPOSE_SHARE.commute constant the port relies on.
    return pd.DataFrame([{"area_type": "urban", **r} for r in rows])


SCENARIOS = [
    {
        "label": "isolated_local_vnet",
        "rows": [
            {"taz_id": "1", "daily_vmt": 120000.0, "avg_trip_length": 12.0},
            {"taz_id": "2", "daily_vmt": 80000.0, "avg_trip_length": 8.0},
            {"taz_id": "3", "daily_vmt": 50000.0, "avg_trip_length": 15.0},
        ],
        "args": dict(n_spaces=200, l_access_mi=4, utilization=0.7, isolated_facility="isolated"),
    },
    {
        "label": "alternative_facility",
        "rows": [
            {"taz_id": "10", "daily_vmt": 90000.0, "avg_trip_length": 10.0},
            {"taz_id": "11", "daily_vmt": 60000.0, "avg_trip_length": 6.0},
        ],
        "args": dict(n_spaces=500, l_access_mi=2, utilization=0.6, isolated_facility="alternative"),
    },
    {
        "label": "no_trip_length_fallback_vnet",
        "rows": [
            # avg_trip_length present but null (as in the app TAZ layer) -> the
            # observed-length path finds nothing valid -> Duncan & Cao fallback V_net.
            {"taz_id": "20", "daily_vmt": 70000.0, "avg_trip_length": None},
            {"taz_id": "21", "daily_vmt": 40000.0, "avg_trip_length": None},
        ],
        "args": dict(n_spaces=300, l_access_mi=3, utilization=0.7, isolated_facility="isolated"),
    },
    {
        "label": "tdm_trip_length_preferred",
        "rows": [
            # both avg_trip_length and tdm present -> L_commute uses tdm (model).
            {"taz_id": "30", "daily_vmt": 100000.0, "avg_trip_length": 8.0, "tdm_avg_trip_length_mi": 14.0},
            {"taz_id": "31", "daily_vmt": 50000.0, "avg_trip_length": 7.0, "tdm_avg_trip_length_mi": 11.0},
        ],
        "args": dict(n_spaces=250, l_access_mi=4, utilization=0.7, isolated_facility="isolated"),
    },
    {
        "label": "demand_ceiling_observed",
        "rows": [
            # observed VMT-commute split + drive-to-transit share; total>0 -> demand binds.
            {"taz_id": "40", "daily_vmt": 80000.0, "avg_trip_length": 10.0,
             "vmt_share_commute": 0.35, "drive_to_transit_share": 0.5},
            {"taz_id": "41", "daily_vmt": 40000.0, "avg_trip_length": 9.0,
             "vmt_share_commute": 0.28, "drive_to_transit_share": 0.6},
        ],
        "args": dict(n_spaces=200, l_access_mi=4, utilization=0.7, isolated_facility="isolated",
                     total_transit_commute_trips_catchment=100),
    },
]

# Columns the TS port reads from each TAZ.
TAZ_COLS = ["taz_id", "daily_vmt", "avg_trip_length", "tdm_avg_trip_length_mi",
            "drive_to_transit_share", "vmt_share_commute"]


def main() -> int:
    out = []
    for sc_def in SCENARIOS:
        df = frame(sc_def["rows"])
        # The catchment is the whole set (no facility location). Per-scenario args
        # carry any demand inputs (total_transit_commute_trips_catchment); observed
        # drive-access + trip length come from the row columns.
        result = sc.strategy_park_and_ride(df, **sc_def["args"])
        taz_inputs = [
            {c: (None if pd.isna(r.get(c)) else r.get(c)) for c in TAZ_COLS}
            for r in sc_def["rows"]
        ]
        expected = [
            {
                "taz_id": str(r["taz_id"]),
                "pct_vmt_reduction": float(r["pct_vmt_reduction"]),
                "base_vmt": float(r["base_vmt"]),
                "daily_vmt_reduction": float(r["daily_vmt_reduction"]),
            }
            for _, r in result.iterrows()
        ]
        out.append({"label": sc_def["label"], "taz_inputs": taz_inputs,
                    "args": sc_def["args"], "expected": expected})
        tot = sum(e["daily_vmt_reduction"] for e in expected)
        print(f"  {sc_def['label']:30s} {len(expected)} TAZs, total saved = {tot:,.0f} mi/day")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    json.dump(out, open(OUT, "w"), indent=2)
    print(f"\nWrote {OUT.relative_to(HERE.parent)} ({len(out)} scenarios)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
