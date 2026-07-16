"""Transit metrics per TAZ (CDOT 2019 TDM).

Computes three metrics per Traffic Analysis Zone:

  * VMT  — daily vehicle miles traveled (revenue service)
  * VRH  — daily vehicle revenue hours
  * PMT  — daily passenger miles traveled

Method
------
Inputs:
  data/TDM OD Matrices and Loaded Network/
    CDOT_2019_TransitNetwork.json   route LineStrings + period trip counts
    CDOT_2019_TAZ.json              TAZ polygons (TAZ_new_ID == OMX zone ID)
    {AM,MD,PM,EL}_Transit.omx       transit OD trip matrices (Dacc,Degr,Wacc)

Per-route quantities:
  daily_trips = AM_TRIPS + MD_TRIPS + PM_TRIPS + EL_TRIPS
  route_VMT   = ROUTE_MILE * daily_trips
  route_VRH   = route_VMT / mode_speed_mph[MODE]

Per-TAZ allocation of route-level metrics:
  Each route is overlaid on TAZs (planar CRS); the share of route length
  inside each TAZ multiplies route_VMT and route_VRH.

Per-TAZ PMT (from OMX OD matrices):
  daily_trips_OD = sum over {AM,MD,PM,EL} of (Wacc + Dacc + Degr)
  PMT_OD         = daily_trips_OD * centroid_distance(O, D)   [miles]
  PMT is split 50/50 between origin TAZ and destination TAZ.
  External zones (10001-10046) are dropped — no polygon centroid.

Outputs:
  outputs/transit_metrics_per_taz.csv
  outputs/transit_metrics_per_taz.geojson
  outputs/transit_metrics_per_taz_map.png
"""

from __future__ import annotations

import json
from pathlib import Path

import geopandas as gpd
import matplotlib.pyplot as plt
import numpy as np
import openmatrix as omx
import pandas as pd
import shapely
from matplotlib.colors import LogNorm
from shapely.geometry import shape

from paths import DATA_DIR, OUTPUTS_DIR

DATA = DATA_DIR / "TDM OD Matrices and Loaded Network"
OUT = OUTPUTS_DIR
OUT.mkdir(exist_ok=True)

TRANSIT_FP = DATA / "CDOT_2019_TransitNetwork.json"
TAZ_FP = DATA / "CDOT_2019_TAZ.json"
OMX_FPS = {p: DATA / f"{p}_Transit.omx" for p in ("AM", "MD", "PM", "EL")}

# Planar CRS for length / distance work (UTM 13N covers Colorado).
PLANAR_CRS = "EPSG:26913"
M_PER_MI = 1609.344

# OMX missing-value sentinel (-DBL_MAX).
OMX_SENTINEL = -1.7976931348623157e308

# Mode → assumed average operating speed (mph). Used to convert VMT to VRH.
# CDOT TDM mode codes are not formally documented in the inputs; these are
# reasonable defaults grouped by typical service character. Override as needed.
MODE_SPEED_MPH: dict[int, float] = {
    # rail / commuter rail / BRT-like
    4: 30.0, 10: 30.0, 11: 30.0, 15: 30.0, 18: 30.0, 21: 30.0, 50: 30.0, 55: 35.0,
    # express / regional bus
    7: 25.0, 8: 25.0, 9: 25.0, 12: 22.0, 13: 22.0,
    # local / circulator / shuttle bus
    5: 13.0, 6: 13.0, 17: 13.0, 19: 13.0, 20: 13.0,
}
DEFAULT_SPEED_MPH = 15.0


# ----------------------------------------------------------------------------
# Loaders
# ----------------------------------------------------------------------------
def load_taz() -> gpd.GeoDataFrame:
    print(f"Reading TAZ polygons: {TAZ_FP.name}")
    gdf = gpd.read_file(TAZ_FP)
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    gdf = gdf.to_crs(PLANAR_CRS)
    gdf = gdf[["TAZ_new_ID", "TAZ_8045_seq_ID", "COUNTY", "MPO_MODEL", "geometry"]].copy()
    gdf["TAZ_new_ID"] = gdf["TAZ_new_ID"].astype(int)
    # Some polygons in this dataset have ring self-intersections; repair them
    # so downstream intersections don't blow up with TopologyException.
    invalid = ~gdf.geometry.is_valid
    if invalid.any():
        print(f"  repairing {int(invalid.sum())} invalid TAZ geometries")
        gdf.loc[invalid, "geometry"] = gdf.loc[invalid, "geometry"].apply(shapely.make_valid)
    print(f"  {len(gdf)} TAZ polygons (CRS={gdf.crs.to_string()})")
    return gdf


def load_routes() -> gpd.GeoDataFrame:
    print(f"Reading transit network: {TRANSIT_FP.name}")
    with open(TRANSIT_FP) as fh:
        gj = json.load(fh)
    feats = gj["features"]
    rows = []
    geoms = []
    for ft in feats:
        p = ft["properties"]
        rows.append(p)
        geoms.append(shape(ft["geometry"]) if ft.get("geometry") else None)
    df = pd.DataFrame(rows)
    gdf = gpd.GeoDataFrame(df, geometry=geoms, crs="EPSG:4326").to_crs(PLANAR_CRS)
    for col in ("AM_TRIPS", "MD_TRIPS", "PM_TRIPS", "EL_TRIPS", "ROUTE_MILE", "MODE"):
        gdf[col] = pd.to_numeric(gdf[col], errors="coerce")
    print(f"  {len(gdf)} route LineStrings (CRS={gdf.crs.to_string()})")
    return gdf


def load_total_daily_trips_matrix() -> tuple[np.ndarray, dict[int, int]]:
    """Return (T, zone_id_to_idx) where T[i,j] is total daily transit trips."""
    total: np.ndarray | None = None
    zone_index: dict[int, int] | None = None
    for period, fp in OMX_FPS.items():
        print(f"Reading OMX: {fp.name}")
        with omx.open_file(fp, "r") as f:
            mapping = {int(k): int(v) for k, v in f.mapping("Row index").items()}
            if zone_index is None:
                zone_index = mapping
            elif mapping != zone_index:
                raise RuntimeError(f"Zone mapping mismatch in {fp.name}")
            period_total: np.ndarray | None = None
            for mat_name in ("Wacc", "Dacc", "Degr"):
                if mat_name not in f.list_matrices():
                    continue
                a = np.asarray(f[mat_name], dtype=np.float64)
                # Mask out -DBL_MAX sentinel and any non-finite values.
                bad = (a <= OMX_SENTINEL / 2) | ~np.isfinite(a)
                a = np.where(bad, 0.0, a)
                period_total = a if period_total is None else period_total + a
        if period_total is None:
            raise RuntimeError(f"No usable trip matrices in {fp.name}")
        total = period_total if total is None else total + period_total
        print(f"  {period}: trip sum = {period_total.sum():,.0f}")
    assert total is not None and zone_index is not None
    print(f"Total daily transit trips (OMX): {total.sum():,.0f}")
    return total, zone_index


# ----------------------------------------------------------------------------
# Route-level metrics → per-TAZ via length share
# ----------------------------------------------------------------------------
def route_metrics(routes: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    trips = (
        routes[["AM_TRIPS", "MD_TRIPS", "PM_TRIPS", "EL_TRIPS"]]
        .fillna(0.0)
        .sum(axis=1)
    )
    miles = routes["ROUTE_MILE"].fillna(0.0)
    speed = routes["MODE"].map(MODE_SPEED_MPH).fillna(DEFAULT_SPEED_MPH)
    out = routes.copy()
    out["DAILY_TRIPS"] = trips
    out["ROUTE_VMT"] = miles * trips
    out["ROUTE_VRH"] = out["ROUTE_VMT"] / speed
    return out


def allocate_routes_to_taz(
    routes: gpd.GeoDataFrame, taz: gpd.GeoDataFrame
) -> pd.DataFrame:
    """Length-share allocation of ROUTE_VMT and ROUTE_VRH to TAZs."""
    print("Overlaying routes on TAZs (length-share allocation)...")
    # Build a minimal routes layer to keep overlay light.
    r = routes[["ROUTE_ID", "ROUTE_VMT", "ROUTE_VRH", "geometry"]].copy()
    r["_route_len_m"] = r.geometry.length

    t = taz[["TAZ_new_ID", "geometry"]].copy()

    # Spatial join + clip yields a row per (route, intersecting TAZ).
    # `overlay(how='intersection')` would also work but is heavier.
    cand = gpd.sjoin(r, t, how="inner", predicate="intersects")
    print(f"  candidate route×TAZ pairs: {len(cand)}")

    # Compute clipped length for each candidate via vectorized shapely.
    cand = cand.merge(
        t.rename(columns={"geometry": "_taz_geom"}),
        on="TAZ_new_ID",
        how="left",
    )
    route_arr = np.asarray(cand.geometry.values)
    taz_arr = np.asarray(cand["_taz_geom"].values)
    inter = shapely.intersection(route_arr, taz_arr)
    cand["_inter_len_m"] = shapely.length(inter)

    # Drop near-zero overlaps.
    cand = cand[cand["_inter_len_m"] > 1e-3].copy()
    cand["_share"] = cand["_inter_len_m"] / cand["_route_len_m"].clip(lower=1e-9)
    cand["TAZ_VMT"] = cand["ROUTE_VMT"] * cand["_share"]
    cand["TAZ_VRH"] = cand["ROUTE_VRH"] * cand["_share"]

    agg = cand.groupby("TAZ_new_ID", as_index=False)[["TAZ_VMT", "TAZ_VRH"]].sum()
    print(f"  TAZs touched by transit: {len(agg)}")
    return agg


# ----------------------------------------------------------------------------
# OMX OD trips → per-TAZ PMT via centroid distance
# ----------------------------------------------------------------------------
def pmt_per_taz(
    trips: np.ndarray,
    zone_index: dict[int, int],
    taz: gpd.GeoDataFrame,
) -> pd.DataFrame:
    print("Computing PMT from OMX OD matrix × centroid distances...")
    n = trips.shape[0]
    centroids = taz.geometry.representative_point()
    cx = centroids.x.to_numpy()
    cy = centroids.y.to_numpy()
    taz_id = taz["TAZ_new_ID"].to_numpy()

    # Build OMX-index → (x,y) arrays. Externals stay NaN.
    X = np.full(n, np.nan)
    Y = np.full(n, np.nan)
    for tid, x, y in zip(taz_id, cx, cy):
        idx = zone_index.get(int(tid))
        if idx is not None:
            X[idx] = x
            Y[idx] = y

    valid = ~np.isnan(X)
    print(f"  zones with centroid: {valid.sum()} of {n} (externals dropped)")

    rows, cols = np.nonzero(trips > 0)
    keep = valid[rows] & valid[cols]
    rows = rows[keep]
    cols = cols[keep]
    t_vals = trips[rows, cols]
    print(f"  nonzero internal OD pairs: {len(rows):,}")

    dx = X[rows] - X[cols]
    dy = Y[rows] - Y[cols]
    dist_mi = np.sqrt(dx * dx + dy * dy) / M_PER_MI
    pmt = t_vals * dist_mi  # passenger-miles per OD pair

    origin_pmt = np.zeros(n)
    dest_pmt = np.zeros(n)
    np.add.at(origin_pmt, rows, 0.5 * pmt)
    np.add.at(dest_pmt, cols, 0.5 * pmt)
    total_pmt = origin_pmt + dest_pmt

    print(f"  total daily PMT: {total_pmt.sum():,.0f} pax-mi")

    # Map back to TAZ_new_ID.
    idx_to_tid = {idx: tid for tid, idx in zone_index.items()}
    out = pd.DataFrame(
        {
            "TAZ_new_ID": [idx_to_tid[i] for i in range(n) if valid[i]],
            "TAZ_PMT_origin": origin_pmt[valid],
            "TAZ_PMT_dest": dest_pmt[valid],
            "TAZ_PMT": total_pmt[valid],
        }
    )
    return out


# ----------------------------------------------------------------------------
# Map
# ----------------------------------------------------------------------------
def make_map(taz: gpd.GeoDataFrame, out_png: Path) -> None:
    print(f"Rendering validation map → {out_png.name}")
    metrics = [
        ("TAZ_PMT", "Passenger Miles Traveled (daily)"),
        ("TAZ_VRH", "Vehicle Revenue Hours (daily)"),
        ("TAZ_VMT", "Vehicle Miles Traveled (daily)"),
    ]
    fig, axes = plt.subplots(1, 3, figsize=(22, 9), constrained_layout=True)

    for ax, (col, title) in zip(axes, metrics):
        vals = taz[col].fillna(0.0)
        positive = vals[vals > 0]
        if len(positive) == 0:
            taz.plot(ax=ax, color="lightgrey", edgecolor="none")
            ax.set_title(f"{title}\n(no data)")
            continue
        vmin = max(positive.min(), 1e-3)
        vmax = positive.quantile(0.99)
        # Background: TAZs with zero metric in pale grey.
        taz.plot(ax=ax, color="#eeeeee", edgecolor="none", linewidth=0)
        # Foreground: TAZs with positive metric.
        active = taz[vals > 0].copy()
        active[col] = vals[vals > 0]
        active.plot(
            column=col,
            ax=ax,
            cmap="viridis",
            norm=LogNorm(vmin=vmin, vmax=vmax),
            legend=True,
            legend_kwds={"label": col, "shrink": 0.6},
            edgecolor="none",
        )
        ax.set_title(f"{title}\nsum = {vals.sum():,.0f}", fontsize=12)
        ax.set_axis_off()

    fig.suptitle("CDOT 2019 TDM — Transit metrics per TAZ", fontsize=16, y=1.02)
    fig.savefig(out_png, dpi=150, bbox_inches="tight")
    plt.close(fig)


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
def main() -> None:
    taz = load_taz()
    routes = load_routes()
    routes = route_metrics(routes)

    # Route-derived TAZ metrics.
    rt_alloc = allocate_routes_to_taz(routes, taz)

    # OMX-derived TAZ PMT.
    trip_matrix, zone_index = load_total_daily_trips_matrix()
    pmt = pmt_per_taz(trip_matrix, zone_index, taz)

    out = taz.merge(rt_alloc, on="TAZ_new_ID", how="left").merge(
        pmt, on="TAZ_new_ID", how="left"
    )
    for c in ("TAZ_VMT", "TAZ_VRH", "TAZ_PMT", "TAZ_PMT_origin", "TAZ_PMT_dest"):
        out[c] = out[c].fillna(0.0)

    csv_path = OUT / "transit_metrics_per_taz.csv"
    geojson_path = OUT / "transit_metrics_per_taz.geojson"
    map_path = OUT / "transit_metrics_per_taz_map.png"

    cols = [
        "TAZ_new_ID", "TAZ_8045_seq_ID", "COUNTY", "MPO_MODEL",
        "TAZ_VMT", "TAZ_VRH", "TAZ_PMT", "TAZ_PMT_origin", "TAZ_PMT_dest",
    ]
    out[cols].to_csv(csv_path, index=False)
    out[cols + ["geometry"]].to_crs("EPSG:4326").to_file(geojson_path, driver="GeoJSON")

    print("\n=== Totals (daily) ===")
    print(f"  VMT: {out['TAZ_VMT'].sum():>14,.0f}")
    print(f"  VRH: {out['TAZ_VRH'].sum():>14,.1f}")
    print(f"  PMT: {out['TAZ_PMT'].sum():>14,.0f}")
    print(f"\nWrote: {csv_path.relative_to(OUT)}")
    print(f"Wrote: {geojson_path.relative_to(OUT)}")

    make_map(out, map_path)
    print(f"Wrote: {map_path.relative_to(OUT)}")


if __name__ == "__main__":
    main()
