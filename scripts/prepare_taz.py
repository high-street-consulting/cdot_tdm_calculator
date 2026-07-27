"""
strategy_calculations.py — CDOT TDM strategy calculator.

This first revision lands the data-preparation pipeline only. ``prepare_taz()``
loads the three published TDM data files

  * ``data/TDM OD Matrices and Loaded Network/CDOT_2019_TAZ.json``      — zones
  * ``data/TDM OD Matrices and Loaded Network/CDOT_2019_LoadNetwork.json`` — links
  * ``outputs/transit_metrics_per_taz.geojson``                         — transit metrics

and returns a single per-TAZ ``pandas.DataFrame`` carrying every input the
strategy functions (added in a follow-up commit) need: stocks (pop, hh, emp),
activity (VMT, trips, avg trip length), densities, an NCHRP-style area type,
network attributes (lane-miles by facility class, intersection density,
length-weighted speed and operating cost), and transit metrics.

Design choices for v1:

* **Pure derivations only.** No external API calls (ACS, GTFS, NOAA, GBFS).
  Everything comes from the three files listed above.
* **Fail gracefully.** Missing inputs fall back to documented defaults; the
  per-TAZ ``data_quality`` column flags which fields were imputed.
* **Spatial join via link midpoints.** Each link is assigned to the TAZ
  containing its representative point. Fast (rtree-backed), unique assignment,
  and accurate to within a few percent for lane-miles since links rarely
  straddle TAZ boundaries far from centroids. Note the caveat in docstrings.
* **Projected to EPSG:26913** (NAD83 UTM Zone 13N) for area, length, and
  spatial-join calculations. Matches the published ``Area`` field to ~0.03%.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import Point


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

from paths import DATA_DIR, OUTPUTS_DIR

DEFAULT_TAZ_PATH = DATA_DIR / "tdm" / "CDOT_2019_TAZ.json"
DEFAULT_NETWORK_PATH = DATA_DIR / "tdm" / "CDOT_2019_LoadNetwork.json"
DEFAULT_TRANSIT_PATH = OUTPUTS_DIR / "transit_metrics_per_taz.geojson"

# CDOT public layers cached by scripts/fetch_cdot_layers.py. Each path is
# read lazily; missing files are reported via PreparedTAZ.quality and that
# section of the per-TAZ table is left as NaN / 0 with a `has_*` flag = False.
CDOT_CACHE_DIR = DATA_DIR / "cdot_external"
CDOT_HIGHWAYS_PATH       = CDOT_CACHE_DIR / "cdot_highways.geojson"
CDOT_MAJOR_ROADS_PATH    = CDOT_CACHE_DIR / "cdot_major_roads.geojson"
CDOT_LOCAL_ROADS_PATH    = CDOT_CACHE_DIR / "cdot_local_roads.geojson"
CDOT_PACE_PATH           = CDOT_CACHE_DIR / "cdot_pace_highways.geojson"
CDOT_URBAN_AREAS_PATH    = CDOT_CACHE_DIR / "cdot_urban_areas_2020.geojson"
CDOT_TRANSIT_ROUTES_PATH = CDOT_CACHE_DIR / "cdot_transit_routes.geojson"
CDOT_TRANSIT_POINTS_PATH = CDOT_CACHE_DIR / "cdot_transit_points.geojson"

# Background data populated by scripts/fetch_background_data.py.
EXTERNAL_CACHE_DIR        = DATA_DIR / "external"
ACS_MODE_SHARE_PATH       = EXTERNAL_CACHE_DIR / "acs_mode_share_bg.csv"
NOAA_BIKEABLE_COUNTY_PATH = EXTERNAL_CACHE_DIR / "noaa_bikeable_days_county.csv"
NOAA_BIKEABLE_TAZ_PATH    = EXTERNAL_CACHE_DIR / "noaa_bikeable_days_taz.csv"

# CDOT custom TDM extract (one row per TAZ) carrying behavioral measures the
# published TDM zone file does NOT have: average vehicle occupancy (AVO),
# model average trip length, mode-choice volumes, and VMT split by trip purpose.
# Joined on the new-TAZ id (``TAZ`` column == ``TAZ_new_ID`` == ``taz_id``).
#
# Read from ``data/tdm`` alongside the other original CDOT source files (the zone
# and network JSON, the transit OMX matrices). This previously pointed at a
# separate ``data/TDM Custom Output`` folder holding a re-saved copy; the two were
# verified numerically identical (8045 rows, every column, zero differing values),
# so consolidating onto the original source location changes no result.
EXTRA_TAZ_DATA_PATH = DATA_DIR / "tdm" / "HighStreetData_ExtraTAZData.xlsx"

# How the six VMT-by-purpose columns in the CDOT extract collapse onto the
# calculator's three purposes (commute / recreational / other). Mapping chosen
# 2026-06-15: work is commute; social/recreational is recreational; personal-
# business, school, meal, and shopping are all "other".
VMT_PURPOSE_COLUMN_MAP: dict[str, list[str]] = {
    "commute":      ["VMT_Work"],
    "recreational": ["VMT_SocRec"],
    "other":        ["VMT_prnsl", "VMT_Sch", "VMT_Meal", "VMT_Shop"],
}

# Raw CDOT mode-choice volume columns, carried through to the prepared table
# under ``tdm_`` names. Their exact units/semantics are pending confirmation
# from CDOT, so prepare_taz does NOT derive mode share from them yet.
TDM_MODE_COLUMN_MAP: dict[str, str] = {
    "TransitShare": "tdm_transit",
    "WalkTran":     "tdm_walk_to_transit",
    "DriveTran":    "tdm_drive_to_transit",
    "BikeShare":    "tdm_bike",
    "WalkShare":    "tdm_walk",
    "VehShareDA":   "tdm_veh_drive_alone",
    "VehShareS2":   "tdm_veh_shared_ride2",
    "VehSahreS3":   "tdm_veh_shared_ride3p",
    "SchBus":       "tdm_school_bus",
}

PROJ_CRS = "EPSG:26913"        # NAD83 UTM Zone 13N — covers all of Colorado
SQM_PER_SQMI = 2_589_988.110336

# Loaded-network facility type codes (TransCAD/Caliper convention used by CDOT 2019 TDM).
FACILITY_TYPE_NAMES: dict[int, str] = {
    0: "other",
    1: "freeway",
    2: "expressway",
    3: "major_arterial",
    4: "minor_arterial",
    5: "collector",
    6: "local",
    8: "centroid_connector",
}

# NCHRP-style area-type thresholds keyed on activity density (pop + emp) per sq mi.
# Tunable from prepare_taz(area_type_thresholds=...).
AREA_TYPE_THRESHOLDS: dict[str, float] = {
    "urban_core": 10_000.0,
    "urban":       3_500.0,
    "suburban":    1_000.0,
    # everything below the suburban floor is "rural"
}

# Bike-impedance cost threshold (per-link). Links with ABImp_Bike above this
# value are treated as effectively non-bikeable (interstates, expressways).
# 100 was chosen by inspection — separates collector/local (single-digit cost)
# from freeway/expressway links (cost in the hundreds to thousands).
BIKEABLE_IMPEDANCE_MAX = 100.0


# ---------------------------------------------------------------------------
# Loaders
# ---------------------------------------------------------------------------

def load_taz(path: str | Path = DEFAULT_TAZ_PATH, crs: str = PROJ_CRS) -> gpd.GeoDataFrame:
    """Load TAZ polygons, project to ``crs`` (default UTM 13N)."""
    gdf = gpd.read_file(path)
    return gdf.to_crs(crs)


def load_network(path: str | Path = DEFAULT_NETWORK_PATH, crs: str = PROJ_CRS) -> gpd.GeoDataFrame:
    """Load loaded-network links, project to ``crs`` (default UTM 13N)."""
    gdf = gpd.read_file(path)
    return gdf.to_crs(crs)


def load_transit_metrics(path: str | Path = DEFAULT_TRANSIT_PATH) -> pd.DataFrame:
    """Load per-TAZ transit metrics. Geometry is discarded — TAZ_new_ID is the join key."""
    gdf = gpd.read_file(path)
    return pd.DataFrame(gdf.drop(columns="geometry"))


# ---------------------------------------------------------------------------
# Derivations: TAZ-level (no spatial joins)
# ---------------------------------------------------------------------------

def _derive_area_type(activity_density: pd.Series,
                      thresholds: dict[str, float]) -> pd.Series:
    """Bucket activity density (pop + emp per sq mi) into urban_core/urban/suburban/rural."""
    ac = activity_density.fillna(0.0)
    out = pd.Series("rural", index=ac.index, dtype="object")
    out[ac >= thresholds["suburban"]]   = "suburban"
    out[ac >= thresholds["urban"]]      = "urban"
    out[ac >= thresholds["urban_core"]] = "urban_core"
    return out


def derive_taz_core(taz_gdf: gpd.GeoDataFrame,
                    area_type_thresholds: dict[str, float] | None = None) -> pd.DataFrame:
    """
    Build the core per-TAZ table from the projected TAZ GeoDataFrame.

    Returns a plain DataFrame keyed on a string ``taz_id`` and carrying:
      stocks, activity, areas, densities, area_type, and a per-row
      ``geometry_area_sqmi`` derived directly from the projected geometry.
    """
    thresholds = area_type_thresholds or AREA_TYPE_THRESHOLDS

    geom_sqmi = taz_gdf.geometry.area / SQM_PER_SQMI

    pop = taz_gdf["TOT_2019_POP"].fillna(0).astype(float)
    hh  = taz_gdf["TOTAL_2019_HHS"].fillna(0).astype(float)
    emp = taz_gdf["Empl_2019"].fillna(0).astype(float)
    vmt = taz_gdf["VMT"].fillna(0).astype(float)
    trips = taz_gdf["rptTrips"].fillna(0).astype(float)

    # Activity density is in pop+emp per sq mi. Fall back to a 1 sq mi floor
    # so the tiny micro-TAZs don't blow density to infinity.
    safe_area = geom_sqmi.where(geom_sqmi > 0.01, 0.01)
    pop_density = pop / safe_area
    emp_density = emp / safe_area
    activity_density = (pop + emp) / safe_area

    # Raw VMT/trips division. External / gateway zones (e.g. DIA, freeway
    # through-zones) have ~all through-VMT but ~0 produced trips, which yields
    # absurd ratios — NaN them out below so they don't poison downstream means.
    raw_atl = vmt / trips.replace(0, np.nan)
    trip_origin = (pop + emp) > 0
    reliable_atl = trip_origin & (trips >= 5)
    avg_trip_length = raw_atl.where(reliable_atl)

    df = pd.DataFrame({
        "taz_id":               taz_gdf["TAZ_new_ID"].astype("Int64").astype(str),
        "taz_8045_seq_id":      taz_gdf["TAZ_8045_seq_ID"].astype("Int64"),
        "taz_6440_id":          taz_gdf["TAZ_6440_ID"].astype("Int64"),
        "county":               taz_gdf["COUNTY"],
        "fips_co":              taz_gdf["FIPS_CO"],
        "geoid":                taz_gdf["Geoid"].astype(str),
        "mpo":                  taz_gdf["MPO_MODEL"],
        "district":             taz_gdf["District"],
        "subregion_id":         taz_gdf["SubRegionID"],
        "fare_zone":            taz_gdf["FARE_ZONE"],
        "fare_zone_cdot":       taz_gdf["FARE_ZONE_CDOT"],
        "area_sqmi_attr":       taz_gdf["Area"].astype(float),
        "area_sqmi":            geom_sqmi.astype(float),
        "population":           pop,
        "households":           hh,
        "hh_pop":               taz_gdf["HH_POP_2019"].fillna(0).astype(float),
        "gq_pop":               taz_gdf["GQ_POP_2019"].fillna(0).astype(float),
        "person_per_hh":        taz_gdf["PERSON_HH"].fillna(0).astype(float),
        "employment":           emp,
        "hh_low_income":        taz_gdf["LO_I_2019_HH"].fillna(0).astype(float),
        "hh_med_income":        taz_gdf["ME_I_2019_HH"].fillna(0).astype(float),
        "hh_high_income":       taz_gdf["HI_I_2019_HH"].fillna(0).astype(float),
        "daily_vmt":            vmt,
        "daily_trips":          trips,
        "avg_trip_length":      avg_trip_length,
        "pop_density":          pop_density,
        "emp_density":          emp_density,
        "activity_density":     activity_density,
        "area_type":            _derive_area_type(activity_density, thresholds),
    })
    return df.reset_index(drop=True)


# ---------------------------------------------------------------------------
# Derivations: spatial joins to the loaded network
# ---------------------------------------------------------------------------

def _facility_label(code: Any) -> str:
    """Map a numeric facility-type code to a snake_case label, with a safe fallback."""
    try:
        return FACILITY_TYPE_NAMES.get(int(code), "other")
    except (TypeError, ValueError):
        return "other"


def derive_network_attributes(taz_gdf: gpd.GeoDataFrame,
                              network_gdf: gpd.GeoDataFrame) -> pd.DataFrame:
    """
    Spatial-join links to TAZs (by link midpoint) and aggregate per TAZ.

    Returns a DataFrame indexed by string ``taz_id`` with:
      * network_centerline_mi               total link length in the TAZ
      * network_lane_mi                     length * LANE
      * lane_mi_<facility>                  per facility class (freeway, major_arterial, ...)
      * network_vmt                         sum Tot_VMT on links assigned to the TAZ
      * network_daily_flow                  sum Tot_DyFlow on links assigned to the TAZ
      * length_weighted_speed               sum(FFSpeed * Length) / sum(Length)
      * length_weighted_auto_op_cost_pk     sum(AutoOpRate_PK * Length) / sum(Length)
      * bike_centerline_mi                  total length of "bikeable" links
                                            (ABImp_Bike <= BIKEABLE_IMPEDANCE_MAX)
      * n_links_assigned                    diagnostic
    """
    # Project both to the same projected CRS (defensive — caller should have already).
    if network_gdf.crs != taz_gdf.crs:
        network_gdf = network_gdf.to_crs(taz_gdf.crs)

    # Link midpoint as join probe.
    midpoints = gpd.GeoDataFrame(
        {"_link_idx": np.arange(len(network_gdf))},
        geometry=network_gdf.geometry.interpolate(0.5, normalized=True),
        crs=network_gdf.crs,
    )

    taz_index = taz_gdf[["TAZ_new_ID", "geometry"]].copy()
    taz_index["TAZ_new_ID"] = taz_index["TAZ_new_ID"].astype("Int64").astype(str)

    joined = gpd.sjoin(midpoints, taz_index, predicate="within", how="left")
    # `Length` is in miles in the source data (verified against geometry to ~0.03%).
    lengths = network_gdf["Length"].fillna(0).astype(float).to_numpy()
    lanes   = network_gdf["LANE"].fillna(0).astype(float).to_numpy()
    fac     = network_gdf["[FACILITY TYPE]"].apply(_facility_label).to_numpy()
    vmt     = network_gdf["Tot_VMT"].fillna(0).astype(float).to_numpy()
    flow    = network_gdf["Tot_DyFlow"].fillna(0).astype(float).to_numpy()
    speed   = network_gdf["FFSpeed"].fillna(0).astype(float).to_numpy()
    opcost  = network_gdf["AutoOpRate_PK"].fillna(0).astype(float).to_numpy()
    bike_imp = network_gdf["ABImp_Bike"].fillna(np.inf).astype(float).to_numpy()
    is_bike = bike_imp <= BIKEABLE_IMPEDANCE_MAX

    work = pd.DataFrame({
        "taz_id":   joined["TAZ_new_ID"].to_numpy(),
        "length":   lengths[joined["_link_idx"].to_numpy()] if False else lengths,
        "lane_mi":  lengths * lanes,
        "facility": fac,
        "vmt":      vmt,
        "flow":     flow,
        "spd_x_len":  speed * lengths,
        "opc_x_len":  opcost * lengths,
        "bike_mi":  np.where(is_bike, lengths, 0.0),
    })
    work = work.dropna(subset=["taz_id"])

    grouped = work.groupby("taz_id", as_index=True)
    agg = grouped.agg(
        network_centerline_mi=("length", "sum"),
        network_lane_mi=("lane_mi", "sum"),
        network_vmt=("vmt", "sum"),
        network_daily_flow=("flow", "sum"),
        _spd_x_len_sum=("spd_x_len", "sum"),
        _opc_x_len_sum=("opc_x_len", "sum"),
        bike_centerline_mi=("bike_mi", "sum"),
        n_links_assigned=("length", "size"),
    )
    agg["length_weighted_speed"] = np.where(
        agg["network_centerline_mi"] > 0,
        agg["_spd_x_len_sum"] / agg["network_centerline_mi"],
        np.nan,
    )
    agg["length_weighted_auto_op_cost_pk"] = np.where(
        agg["network_centerline_mi"] > 0,
        agg["_opc_x_len_sum"] / agg["network_centerline_mi"],
        np.nan,
    )
    agg = agg.drop(columns=["_spd_x_len_sum", "_opc_x_len_sum"])

    # Lane-miles by facility class, wide-pivoted with a stable column order.
    fac_pivot = (
        work.groupby(["taz_id", "facility"])["lane_mi"]
            .sum()
            .unstack("facility", fill_value=0.0)
    )
    fac_pivot.columns = [f"lane_mi_{c}" for c in fac_pivot.columns]
    # Guarantee every known facility column exists, even if empty.
    for code, name in FACILITY_TYPE_NAMES.items():
        col = f"lane_mi_{name}"
        if col not in fac_pivot.columns:
            fac_pivot[col] = 0.0
    fac_pivot = fac_pivot[[f"lane_mi_{n}" for n in FACILITY_TYPE_NAMES.values()]]

    return agg.join(fac_pivot, how="outer").fillna(0.0).reset_index()


def derive_intersection_density(taz_gdf: gpd.GeoDataFrame,
                                network_gdf: gpd.GeoDataFrame,
                                dedupe_decimals: int = 0) -> pd.DataFrame:
    """
    Compute true intersections (nodes with >= 3 incident links) per TAZ and per sq mi.

    ``dedupe_decimals`` is the number of decimal places used to round node
    coordinates (in the projected CRS, meters) before counting incident links.
    0 = whole-meter snap, which is plenty for catching coincident endpoints.

    Centroid-connector links are excluded so the count reflects the real road
    network, not the dummy access geometry.
    """
    if network_gdf.crs != taz_gdf.crs:
        network_gdf = network_gdf.to_crs(taz_gdf.crs)

    real_links = network_gdf[network_gdf["[FACILITY TYPE]"] != 8]
    coords: list[tuple[float, float]] = []
    for geom in real_links.geometry:
        if geom is None or geom.is_empty:
            continue
        cs = list(geom.coords)
        if not cs:
            continue
        coords.append(cs[0])
        coords.append(cs[-1])

    nodes = pd.DataFrame(coords, columns=["x", "y"])
    nodes["key"] = list(zip(nodes["x"].round(dedupe_decimals),
                            nodes["y"].round(dedupe_decimals)))
    incident = nodes.groupby("key").size().rename("incident_links")
    intersections = incident[incident >= 3].reset_index()
    intersections[["x", "y"]] = pd.DataFrame(intersections["key"].tolist(),
                                             index=intersections.index)

    pts = gpd.GeoDataFrame(
        intersections.drop(columns=["key"]),
        geometry=[Point(x, y) for x, y in zip(intersections["x"], intersections["y"])],
        crs=network_gdf.crs,
    )
    taz_index = taz_gdf[["TAZ_new_ID", "geometry"]].copy()
    taz_index["TAZ_new_ID"] = taz_index["TAZ_new_ID"].astype("Int64").astype(str)

    joined = gpd.sjoin(pts, taz_index, predicate="within", how="left")
    counts = (
        joined.dropna(subset=["TAZ_new_ID"])
              .groupby("TAZ_new_ID")
              .size()
              .rename("intersection_count")
              .reset_index()
              .rename(columns={"TAZ_new_ID": "taz_id"})
    )
    return counts


# ---------------------------------------------------------------------------
# Derivations: cached CDOT external layers
# ---------------------------------------------------------------------------
#
# All five derivations below follow the same pattern:
#   1. Project the source GeoDataFrame into the TAZ CRS (defensive).
#   2. Take a representative point (line midpoint or polygon centroid) per
#      source feature and spatial-join it to the containing TAZ.
#   3. Aggregate using sum / length-weighted mean.
#
# Using midpoints (rather than full geometric overlay) is fast and accurate
# enough at this scale — typical CDOT segments are short relative to a TAZ.
# Linear-referenced segments that span two TAZs are credited to the one
# containing the midpoint, which is acceptable noise on a statewide rollup.

def _midpoint_sjoin(source_gdf: gpd.GeoDataFrame,
                    taz_gdf: gpd.GeoDataFrame) -> pd.Series:
    """Return a Series, indexed like ``source_gdf``, of containing-TAZ taz_id strings."""
    if source_gdf.crs != taz_gdf.crs:
        source_gdf = source_gdf.to_crs(taz_gdf.crs)
    mids = gpd.GeoDataFrame(
        {"_src_idx": np.arange(len(source_gdf))},
        geometry=source_gdf.geometry.interpolate(0.5, normalized=True),
        crs=source_gdf.crs,
    )
    taz_idx = taz_gdf[["TAZ_new_ID", "geometry"]].copy()
    taz_idx["TAZ_new_ID"] = taz_idx["TAZ_new_ID"].astype("Int64").astype(str)
    joined = gpd.sjoin(mids, taz_idx, predicate="within", how="left")
    return joined.set_index("_src_idx")["TAZ_new_ID"]


def derive_state_highways(taz_gdf: gpd.GeoDataFrame,
                          hwy_gdf: gpd.GeoDataFrame) -> pd.DataFrame:
    """
    Per-TAZ rollups of the CDOT state-highway segment inventory.

    Output columns (per TAZ):
      * state_hwy_centerline_mi        sum(SEG_LENGTH)
      * state_hwy_lane_mi              sum(SEG_LENGTH * THRULNQTY) — total
                                       through-lane-miles. THRULNQTY counts
                                       lanes through the segment (both
                                       directions on undivided roads).
      * state_hwy_aadt_avg             length-weighted AADT20 (2020 AADT)
      * state_hwy_speed_limit_avg      length-weighted SPEEDLIM
      * state_hwy_shoulder_wd_avg      length-weighted PRIOUTSHLDWD
      * state_hwy_low_shoulder_mi      sum length where shoulder <= 2 ft
                                       (bike-LTS proxy)
      * state_hwy_vmt                  sum(VMT) — segment VMT from CDOT
      * state_hwy_divided_mi           sum length where ISDIVIDED='Y'
      * state_hwy_n_segments           count
    """
    taz_id = _midpoint_sjoin(hwy_gdf, taz_gdf)

    length = hwy_gdf["SEG_LENGTH"].fillna(0).astype(float).to_numpy()
    lanes  = hwy_gdf["THRULNQTY"].fillna(0).astype(float).to_numpy()
    aadt   = hwy_gdf["AADT20"].fillna(hwy_gdf["AADT"].fillna(0)).astype(float).to_numpy()
    speed  = hwy_gdf["SPEEDLIM"].fillna(0).astype(float).to_numpy()
    shldwd = hwy_gdf["PRIOUTSHLDWD"].fillna(0).astype(float).to_numpy()
    vmt    = hwy_gdf["VMT"].fillna(0).astype(float).to_numpy()
    divided = (hwy_gdf["ISDIVIDED"].astype(str).str.upper() == "Y").to_numpy()

    work = pd.DataFrame({
        "taz_id":            taz_id.to_numpy(),
        "length":            length,
        "lane_mi":           length * lanes,
        "vmt":               vmt,
        "low_shoulder_mi":   np.where(shldwd <= 2, length, 0.0),
        "divided_mi":        np.where(divided, length, 0.0),
        "_aadt_x_len":       aadt * length,
        "_spd_x_len":        speed * length,
        "_shld_x_len":       shldwd * length,
    }).dropna(subset=["taz_id"])

    grp = work.groupby("taz_id", as_index=True)
    agg = grp.agg(
        state_hwy_centerline_mi=("length", "sum"),
        state_hwy_lane_mi=("lane_mi", "sum"),
        state_hwy_vmt=("vmt", "sum"),
        state_hwy_low_shoulder_mi=("low_shoulder_mi", "sum"),
        state_hwy_divided_mi=("divided_mi", "sum"),
        state_hwy_n_segments=("length", "size"),
        _aadt_x_len_sum=("_aadt_x_len", "sum"),
        _spd_x_len_sum=("_spd_x_len", "sum"),
        _shld_x_len_sum=("_shld_x_len", "sum"),
    )
    L = agg["state_hwy_centerline_mi"]
    agg["state_hwy_aadt_avg"]        = np.where(L > 0, agg["_aadt_x_len_sum"] / L, np.nan)
    agg["state_hwy_speed_limit_avg"] = np.where(L > 0, agg["_spd_x_len_sum"]  / L, np.nan)
    agg["state_hwy_shoulder_wd_avg"] = np.where(L > 0, agg["_shld_x_len_sum"] / L, np.nan)
    return agg.drop(columns=[c for c in agg if c.startswith("_")]).reset_index()


def derive_pace(taz_gdf: gpd.GeoDataFrame, pace_gdf: gpd.GeoDataFrame) -> pd.DataFrame:
    """
    Per-TAZ rollups of CDOT PACE Score 1-mile state-highway segments.

    Output columns:
      * pace_segments_mi               sum(Length) of PACE segments in TAZ
      * pace_lts_avg                   length-weighted LTS (1-4)
      * pace_low_stress_mi             sum length where LTS in {1, 2}
      * pace_low_stress_share          fraction
      * pace_existing_bike_mi          sum length where FacBikePed == 'Yes'
      * pace_existing_bike_share       fraction
      * pace_no_facility_share         fraction where FacNone == 'Yes'
      * pace_strava_2022, pace_strava_2023  sum Strava rides
      * pace_short_trips_existing      sum ExShortTrp
      * pace_short_trips_2030          sum FutShortTr
      * pace_crashes_total             sum Tot_Crash
    """
    taz_id = _midpoint_sjoin(pace_gdf, taz_gdf)

    length = pace_gdf["Length"].fillna(0).astype(float).to_numpy()
    lts    = pace_gdf["LTS"].fillna(0).astype(float).to_numpy()
    has_fac  = (pace_gdf["FacBikePed"].astype(str).str.strip().str.casefold() == "yes").to_numpy()
    no_fac   = (pace_gdf["FacNone"].astype(str).str.strip().str.casefold() == "yes").to_numpy()

    def _col(name: str) -> np.ndarray:
        return pace_gdf[name].fillna(0).astype(float).to_numpy() if name in pace_gdf.columns \
            else np.zeros(len(pace_gdf))

    work = pd.DataFrame({
        "taz_id":          taz_id.to_numpy(),
        "length":          length,
        "_lts_x_len":      lts * length,
        "low_stress_mi":   np.where(np.isin(lts, [1, 2]), length, 0.0),
        "existing_fac_mi": np.where(has_fac, length, 0.0),
        "no_fac_mi":       np.where(no_fac, length, 0.0),
        "strava_2022":     _col("Strava2022"),
        "strava_2023":     _col("Strava2023"),
        "short_existing":  _col("ExShortTrp"),
        "short_2030":      _col("FutShortTr"),
        "crashes":         _col("Tot_Crash"),
    }).dropna(subset=["taz_id"])

    grp = work.groupby("taz_id", as_index=True)
    agg = grp.agg(
        pace_segments_mi=("length", "sum"),
        pace_low_stress_mi=("low_stress_mi", "sum"),
        pace_existing_bike_mi=("existing_fac_mi", "sum"),
        pace_no_facility_mi=("no_fac_mi", "sum"),
        pace_strava_2022=("strava_2022", "sum"),
        pace_strava_2023=("strava_2023", "sum"),
        pace_short_trips_existing=("short_existing", "sum"),
        pace_short_trips_2030=("short_2030", "sum"),
        pace_crashes_total=("crashes", "sum"),
        _lts_x_len_sum=("_lts_x_len", "sum"),
    )
    L = agg["pace_segments_mi"]
    agg["pace_lts_avg"]              = np.where(L > 0, agg["_lts_x_len_sum"] / L, np.nan)
    agg["pace_low_stress_share"]     = np.where(L > 0, agg["pace_low_stress_mi"]    / L, 0.0)
    agg["pace_existing_bike_share"]  = np.where(L > 0, agg["pace_existing_bike_mi"] / L, 0.0)
    agg["pace_no_facility_share"]    = np.where(L > 0, agg["pace_no_facility_mi"]   / L, 0.0)
    return agg.drop(columns=["_lts_x_len_sum"]).reset_index()


def derive_minor_road_centerlines(taz_gdf: gpd.GeoDataFrame,
                                  major_gdf: gpd.GeoDataFrame | None,
                                  local_gdf: gpd.GeoDataFrame | None) -> pd.DataFrame:
    """
    Centerline miles per TAZ for CDOT Major Roads and Local Roads.

    These layers carry centerline geometry but few attributes; v1 only
    extracts length-per-TAZ so we have full off-state-highway road coverage
    (intersection density, walkable network density, etc. live downstream).
    """
    out_frames = []
    for label, gdf in [("major", major_gdf), ("local", local_gdf)]:
        if gdf is None:
            continue
        taz_id = _midpoint_sjoin(gdf, taz_gdf)
        # Source SEG_LENGTH is in miles for the CDOT minor-road layers.
        length = gdf["SEG_LENGTH"].fillna(0).astype(float).to_numpy() \
            if "SEG_LENGTH" in gdf.columns else (gdf.geometry.length.to_numpy() / 1609.344)
        work = pd.DataFrame({"taz_id": taz_id.to_numpy(), "length": length}) \
            .dropna(subset=["taz_id"])
        agg = work.groupby("taz_id")["length"].sum() \
            .rename(f"cdot_{label}_road_mi")
        out_frames.append(agg)
    if not out_frames:
        return pd.DataFrame(columns=["taz_id"])
    return pd.concat(out_frames, axis=1).fillna(0.0).reset_index() \
        .rename(columns={"index": "taz_id"})


def derive_urban_areas(taz_gdf: gpd.GeoDataFrame,
                       ua_gdf: gpd.GeoDataFrame) -> pd.DataFrame:
    """
    Spatial-join each TAZ representative-point to the CDOT Urban Areas
    polygon containing it. Returns ``cdot_urban_area_name`` and
    ``cdot_urban_area_type`` (e.g. 'Rural', '2  Small Urban', '3  Urbanized',
    '4  Large Urban').
    """
    if ua_gdf.crs != taz_gdf.crs:
        ua_gdf = ua_gdf.to_crs(taz_gdf.crs)
    taz_pts = gpd.GeoDataFrame(
        {"taz_id": taz_gdf["TAZ_new_ID"].astype("Int64").astype(str)},
        geometry=taz_gdf.geometry.representative_point(),
        crs=taz_gdf.crs,
    )
    cols = [c for c in ("ua_name", "ua_type") if c in ua_gdf.columns]
    joined = gpd.sjoin(taz_pts, ua_gdf[cols + ["geometry"]],
                       predicate="within", how="left")
    return joined[["taz_id"] + cols].rename(columns={
        "ua_name": "cdot_urban_area_name",
        "ua_type": "cdot_urban_area_type",
    })


def derive_transit_inventory(taz_gdf: gpd.GeoDataFrame,
                             routes_gdf: gpd.GeoDataFrame | None,
                             points_gdf: gpd.GeoDataFrame | None) -> pd.DataFrame:
    """
    Per-TAZ GTFS-derived transit inventory:
      * transit_stop_count    number of CDOT statewide transit stops in TAZ
      * transit_route_count   number of routes intersecting TAZ
      * transit_agency_count  number of distinct agencies serving TAZ
    """
    taz_idx = taz_gdf[["TAZ_new_ID", "geometry"]].copy()
    taz_idx["TAZ_new_ID"] = taz_idx["TAZ_new_ID"].astype("Int64").astype(str)

    parts: list[pd.DataFrame] = []

    if points_gdf is not None and len(points_gdf):
        pts = points_gdf.to_crs(taz_gdf.crs) if points_gdf.crs != taz_gdf.crs else points_gdf
        agency_field = "agency_id" if "agency_id" in pts.columns else None
        keep = ["geometry"] + ([agency_field] if agency_field else [])
        joined = gpd.sjoin(pts[keep], taz_idx, predicate="within", how="left") \
            .dropna(subset=["TAZ_new_ID"])
        stop_counts = joined.groupby("TAZ_new_ID").size().rename("transit_stop_count")
        parts.append(stop_counts)
        if agency_field:
            agency_counts = joined.groupby("TAZ_new_ID")[agency_field].nunique() \
                .rename("transit_agency_count")
            parts.append(agency_counts)

    if routes_gdf is not None and len(routes_gdf):
        rts = routes_gdf.to_crs(taz_gdf.crs) if routes_gdf.crs != taz_gdf.crs else routes_gdf
        joined = gpd.sjoin(rts[["geometry"]], taz_idx, predicate="intersects", how="left") \
            .dropna(subset=["TAZ_new_ID"])
        route_counts = joined.groupby("TAZ_new_ID").size().rename("transit_route_count")
        parts.append(route_counts)

    if not parts:
        return pd.DataFrame(columns=["taz_id"])
    return (pd.concat(parts, axis=1)
              .fillna(0)
              .astype(int)
              .reset_index()
              .rename(columns={"TAZ_new_ID": "taz_id"}))


def _maybe_load(path: Path, crs: str) -> gpd.GeoDataFrame | None:
    """Read a cached GeoJSON if it exists, project to ``crs``. Return None if missing."""
    if not path.exists():
        return None
    return gpd.read_file(path).to_crs(crs)


def _maybe_load_csv(path: Path) -> pd.DataFrame | None:
    """Read a cached CSV if it exists, return DataFrame. Return None if missing."""
    if not path.exists():
        return None
    return pd.read_csv(path, dtype=str)


def _maybe_load_excel(path: Path) -> pd.DataFrame | None:
    """Read an .xlsx if it exists, return DataFrame. Return None if missing."""
    if not path.exists():
        return None
    return pd.read_excel(path)


def derive_extra_taz_data(taz_df: pd.DataFrame,
                          extra_df: pd.DataFrame) -> pd.DataFrame:
    """
    Per-TAZ behavioral measures from the CDOT custom extract
    (``data/TDM Custom Output/HighStreetData_ExtraTAZData.xlsx``), joined on
    ``taz_id`` (the extract's ``TAZ`` column is the new-TAZ id).

    Returns a DataFrame with one row per TAZ in ``taz_df`` and these columns:

      avo                       Average vehicle occupancy (model-reported).
      tdm_avg_trip_length_mi    Model-reported average trip length (mi).
      vmt_commute / vmt_recreational / vmt_other
                                Daily VMT (mi) for each calculator purpose,
                                summed from the six purpose columns per
                                ``VMT_PURPOSE_COLUMN_MAP``.
      vmt_share_commute / vmt_share_recreational / vmt_share_other
                                Per-TAZ purpose split (fractions summing to 1).
                                NaN where the TAZ has no purpose VMT.
      tdm_*                     Raw mode-choice volume columns carried through
                                verbatim (see ``TDM_MODE_COLUMN_MAP``). Units
                                pending CDOT confirmation; no overall mode share
                                is derived from them here.
      drive_to_transit_share / walk_to_transit_share
                                Transit-access composition from ``DriveTran`` /
                                ``WalkTran`` (which sum to ``TransitShare``).
                                A within-transit ratio, so it is robust to the
                                undocumented absolute unit. NaN where the TAZ
                                has no transit access.

    The extract's TAZ id joins 1:1 with the published zone file (8,045 zones).
    """
    extra = extra_df.copy()
    extra["taz_id"] = pd.to_numeric(extra["TAZ"], errors="coerce").astype("Int64").astype(str)

    out = pd.DataFrame({"taz_id": extra["taz_id"]})
    out["avo"] = pd.to_numeric(extra["AVO"], errors="coerce")
    out["tdm_avg_trip_length_mi"] = pd.to_numeric(extra["AvgTripLen"], errors="coerce")

    # VMT by purpose -> calculator's three buckets, plus per-TAZ shares.
    purpose_totals = {}
    for purpose, cols in VMT_PURPOSE_COLUMN_MAP.items():
        present = [c for c in cols if c in extra.columns]
        vals = extra[present].apply(pd.to_numeric, errors="coerce")
        total = vals.sum(axis=1, min_count=1)
        out[f"vmt_{purpose}"] = total
        purpose_totals[purpose] = total

    vmt_all = sum(purpose_totals.values())  # element-wise Series sum
    denom = vmt_all.where(vmt_all > 0)
    for purpose in VMT_PURPOSE_COLUMN_MAP:
        out[f"vmt_share_{purpose}"] = purpose_totals[purpose] / denom

    # Raw mode-choice volumes, carried through under tdm_ names (semantics TBD).
    for src, dest in TDM_MODE_COLUMN_MAP.items():
        if src in extra.columns:
            out[dest] = pd.to_numeric(extra[src], errors="coerce")

    # Transit-access split (walk-to-transit vs drive-to-transit). Unlike the
    # other mode columns, this pair is internally consistent — WalkTran +
    # DriveTran == TransitShare to the decimal — so the *composition* is robust
    # regardless of the (undocumented) absolute unit. Computed only where the
    # TAZ has transit access; NaN otherwise (the calculator falls back there).
    walk_acc  = pd.to_numeric(extra.get("WalkTran"),  errors="coerce")
    drive_acc = pd.to_numeric(extra.get("DriveTran"), errors="coerce")
    if walk_acc is not None and drive_acc is not None:
        total_acc = (walk_acc + drive_acc)
        denom = total_acc.where(total_acc > 0)
        out["drive_to_transit_share"] = drive_acc / denom
        out["walk_to_transit_share"]  = walk_acc / denom

    return taz_df[["taz_id"]].merge(out, on="taz_id", how="left")


def derive_acs_mode_share(taz_df: pd.DataFrame,
                          acs_df: pd.DataFrame) -> pd.DataFrame:
    """
    Per-TAZ ACS commute mode share, joined on the 12-digit block-group GEOID
    (``taz.geoid``). Returns a DataFrame with one row per TAZ and these
    columns (all named with ``acs_`` prefix so they don't collide):

      acs_total_workers, acs_drove_alone_share, acs_carpool_share,
      acs_transit_share, acs_bike_share, acs_walk_share,
      acs_taxi_moto_other_share, acs_wfh_share

    Source: Census ACS 5-Year Detailed Table B08301, fetched via
    ``scripts/fetch_background_data.py``.
    """
    acs = acs_df.copy()
    # Coerce numeric columns; share columns may have empty strings from the API.
    share_cols = [c for c in acs.columns if c.endswith("_share")]
    for c in share_cols:
        acs[c] = pd.to_numeric(acs[c], errors="coerce")
    acs["total_workers"] = pd.to_numeric(acs["total_workers"], errors="coerce")
    acs = acs.rename(columns={"total_workers": "acs_total_workers"})
    for c in share_cols:
        acs = acs.rename(columns={c: f"acs_{c}"})

    out = taz_df[["taz_id", "geoid"]].copy()
    out["geoid_bg"] = out["geoid"].astype(str).str.zfill(12).str.slice(0, 12)
    out = out.merge(acs.drop(columns=["geoid_bg"], errors="ignore")
                       .assign(geoid_bg=acs["geoid_bg"]),
                    on="geoid_bg", how="left")
    return out.drop(columns=["geoid", "geoid_bg"])


def derive_noaa_bikeable_days_county(taz_df: pd.DataFrame,
                                      noaa_df: pd.DataFrame) -> pd.DataFrame:
    """
    Per-TAZ annual bikeable days, joined on county FIPS (``taz.fips_co``).
    The county value is the mean of bikeable_days across stations falling
    inside that county's polygons (provided by NOAA NCEI 1991-2020 daily
    climate normals via ``scripts/fetch_background_data.py``).

    Used as a fallback when no per-TAZ IDW interpolation is available.
    """
    noaa = noaa_df.copy()
    noaa["fips_co"] = pd.to_numeric(noaa["fips_co"], errors="coerce").astype("Int64")
    noaa["bikeable_days"] = pd.to_numeric(noaa["bikeable_days"], errors="coerce")
    noaa["n_stations"]    = pd.to_numeric(noaa["n_stations"], errors="coerce").astype("Int64")
    noaa = noaa.rename(columns={
        "bikeable_days": "annual_bikeable_days_county",
        "n_stations":    "county_stations_used",
    })

    out = taz_df[["taz_id", "fips_co"]].copy()
    out["fips_co"] = pd.to_numeric(out["fips_co"], errors="coerce").astype("Int64")
    out = out.merge(noaa[["fips_co", "annual_bikeable_days_county", "county_stations_used"]],
                    on="fips_co", how="left")
    return out.drop(columns=["fips_co"])


def derive_noaa_bikeable_days_taz(taz_df: pd.DataFrame,
                                  noaa_taz_df: pd.DataFrame) -> pd.DataFrame:
    """
    Per-TAZ IDW-interpolated bikeable days, joined on ``taz_id``.
    Source: NOAA NCEI 1991-2020 daily climate normals interpolated via
    inverse-distance weighting (k=5, p=2) from HCN/CRN/GSN station data.

    Returns columns:
      annual_bikeable_days_taz   IDW-interpolated bikeable days per year
      nearest_station_km          distance from TAZ representative point to
                                  the single closest station
      n_stations_used             k actually used (typically 5)
    """
    out = noaa_taz_df.copy()
    out["taz_id"] = out["taz_id"].astype(str)
    for c in ("annual_bikeable_days_taz", "nearest_station_km"):
        if c in out.columns:
            out[c] = pd.to_numeric(out[c], errors="coerce")
    if "n_stations_used" in out.columns:
        out["n_stations_used"] = pd.to_numeric(out["n_stations_used"],
                                                errors="coerce").astype("Int64")
    return taz_df[["taz_id"]].merge(
        out[["taz_id", "annual_bikeable_days_taz",
              "nearest_station_km", "n_stations_used"]],
        on="taz_id", how="left",
    )


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

@dataclass
class PreparedTAZ:
    """
    Wrapper returned by ``prepare_taz()``.

    Attributes
    ----------
    df : pandas.DataFrame
        The per-TAZ table with all derived inputs (one row per TAZ).
    quality : pandas.DataFrame
        TAZ-level data-quality flags. One row per TAZ; columns are
        ``has_population``, ``has_employment``, ``has_vmt``, ``has_network_links``,
        ``has_transit_service``, plus an overall ``missing_inputs`` count.
    crs : str
        The projected CRS used for all area / length / spatial-join computations.
    """
    df: pd.DataFrame
    quality: pd.DataFrame
    crs: str


def prepare_taz(taz_path: str | Path = DEFAULT_TAZ_PATH,
                network_path: str | Path = DEFAULT_NETWORK_PATH,
                transit_path: str | Path = DEFAULT_TRANSIT_PATH,
                cdot_cache_dir: str | Path = CDOT_CACHE_DIR,
                external_cache_dir: str | Path = EXTERNAL_CACHE_DIR,
                extra_taz_path: str | Path = EXTRA_TAZ_DATA_PATH,
                crs: str = PROJ_CRS,
                area_type_thresholds: dict[str, float] | None = None) -> PreparedTAZ:
    """
    Build the enriched per-TAZ DataFrame that the strategy functions consume.

    The returned ``PreparedTAZ.df`` has one row per TAZ in the input file. Inputs
    derived from the three local TDM files are always populated; inputs derived
    from the cached CDOT external layers (``data/cdot_external/*.geojson``,
    populated by ``scripts/fetch_cdot_layers.py``) are populated where the cache
    file exists and filled with zeros / NaN otherwise. The corresponding
    ``has_*`` flag in ``PreparedTAZ.quality`` marks which sections were
    available.
    """
    taz_gdf = load_taz(taz_path, crs=crs)
    net_gdf = load_network(network_path, crs=crs)
    transit_df = load_transit_metrics(transit_path)

    core = derive_taz_core(taz_gdf, area_type_thresholds=area_type_thresholds)
    netattr = derive_network_attributes(taz_gdf, net_gdf)
    intersections = derive_intersection_density(taz_gdf, net_gdf)

    cache_dir = Path(cdot_cache_dir)
    hwy_gdf    = _maybe_load(cache_dir / "cdot_highways.geojson",       crs)
    major_gdf  = _maybe_load(cache_dir / "cdot_major_roads.geojson",    crs)
    local_gdf  = _maybe_load(cache_dir / "cdot_local_roads.geojson",    crs)
    pace_gdf   = _maybe_load(cache_dir / "cdot_pace_highways.geojson",  crs)
    ua_gdf     = _maybe_load(cache_dir / "cdot_urban_areas_2020.geojson", crs)
    routes_gdf = _maybe_load(cache_dir / "cdot_transit_routes.geojson", crs)
    points_gdf = _maybe_load(cache_dir / "cdot_transit_points.geojson", crs)

    state_hwy   = derive_state_highways(taz_gdf, hwy_gdf) if hwy_gdf is not None else None
    pace        = derive_pace(taz_gdf, pace_gdf) if pace_gdf is not None else None
    minor_roads = derive_minor_road_centerlines(taz_gdf, major_gdf, local_gdf) \
        if major_gdf is not None or local_gdf is not None else None
    urban_areas = derive_urban_areas(taz_gdf, ua_gdf) if ua_gdf is not None else None
    transit_inv = derive_transit_inventory(taz_gdf, routes_gdf, points_gdf) \
        if (routes_gdf is not None or points_gdf is not None) else None

    # Background-data caches (ACS commute mode share, NOAA bikeable days).
    ext_dir = Path(external_cache_dir)
    acs_df          = _maybe_load_csv(ext_dir / "acs_mode_share_bg.csv")
    noaa_county_df  = _maybe_load_csv(ext_dir / "noaa_bikeable_days_county.csv")
    noaa_taz_df     = _maybe_load_csv(ext_dir / "noaa_bikeable_days_taz.csv")

    # CDOT custom extract: AVO, model trip length, VMT-by-purpose, mode volumes.
    extra_df = _maybe_load_excel(Path(extra_taz_path))

    transit_df = transit_df.rename(columns={
        "TAZ_new_ID":      "taz_id_int",
        "TAZ_VMT":         "transit_vmt",
        "TAZ_VRH":         "transit_vrh",
        "TAZ_PMT":         "transit_pmt",
        "TAZ_PMT_origin":  "transit_pmt_origin",
        "TAZ_PMT_dest":    "transit_pmt_dest",
    })
    transit_df["taz_id"] = transit_df["taz_id_int"].astype("Int64").astype(str)
    transit_df = transit_df[[
        "taz_id", "transit_pmt", "transit_pmt_origin", "transit_pmt_dest",
        "transit_vrh", "transit_vmt",
    ]]

    df = (
        core
        .merge(netattr, on="taz_id", how="left")
        .merge(intersections, on="taz_id", how="left")
        .merge(transit_df, on="taz_id", how="left")
    )
    for extra in (state_hwy, pace, minor_roads, urban_areas, transit_inv):
        if extra is not None and len(extra):
            df = df.merge(extra, on="taz_id", how="left")

    # Background data: ACS mode share + NOAA bikeable days. Derivations are
    # built against the core taz_df (post-core) so the geoid/fips_co columns
    # exist; we then merge their per-TAZ output onto the running df.
    if acs_df is not None:
        df = df.merge(derive_acs_mode_share(core, acs_df), on="taz_id", how="left")
    if noaa_county_df is not None:
        df = df.merge(derive_noaa_bikeable_days_county(core, noaa_county_df),
                      on="taz_id", how="left")
    if noaa_taz_df is not None:
        df = df.merge(derive_noaa_bikeable_days_taz(core, noaa_taz_df),
                      on="taz_id", how="left")
    if extra_df is not None:
        df = df.merge(derive_extra_taz_data(core, extra_df), on="taz_id", how="left")

    # Network metrics: TAZs with no overlapping links -> zeros.
    net_fill_zero = [c for c in df.columns if c.startswith(("lane_mi_", "network_", "bike_"))]
    net_fill_zero += ["intersection_count"]
    df[net_fill_zero] = df[net_fill_zero].fillna(0.0)
    df["intersection_count"] = df["intersection_count"].astype(int)
    df["intersection_density"] = np.where(
        df["area_sqmi"] > 0,
        df["intersection_count"] / df["area_sqmi"],
        0.0,
    )

    # Transit metrics from the TDM-derived file: non-served TAZs -> zeros.
    transit_cols = ["transit_pmt", "transit_pmt_origin", "transit_pmt_dest",
                    "transit_vrh", "transit_vmt"]
    df[transit_cols] = df[transit_cols].fillna(0.0)

    # CDOT external derivations: TAZs with no overlapping features -> zeros
    # for numeric columns; leave the urban-area NAME column as NaN so it can
    # be distinguished from a TAZ that landed in a polygon called "Rural".
    cdot_zero_cols = [c for c in df.columns
                      if c.startswith(("state_hwy_", "pace_", "cdot_major_road",
                                        "cdot_local_road", "transit_stop_",
                                        "transit_route_", "transit_agency_"))]
    for c in cdot_zero_cols:
        if pd.api.types.is_numeric_dtype(df[c]):
            df[c] = df[c].fillna(0.0)

    quality = pd.DataFrame({
        "taz_id":                  df["taz_id"],
        "has_population":          df["population"] > 0,
        "has_employment":          df["employment"] > 0,
        "has_trip_origin":         (df["population"] + df["employment"]) > 0,
        "has_vmt":                 df["daily_vmt"] > 0,
        "has_reliable_trip_len":   df["avg_trip_length"].notna(),
        "has_network_links":       df["network_centerline_mi"] > 0,
        "has_transit_service":     df["transit_vrh"] > 0,
        "has_state_hwy":           df.get("state_hwy_centerline_mi", pd.Series(0)).gt(0),
        "has_pace_coverage":       df.get("pace_segments_mi",        pd.Series(0)).gt(0),
        "has_cdot_urban_area":     df.get("cdot_urban_area_name",    pd.Series([np.nan]*len(df))).notna(),
        "has_cdot_transit_stop":   df.get("transit_stop_count",      pd.Series(0)).gt(0),
        "has_acs_mode_share":      df.get("acs_total_workers",       pd.Series([np.nan]*len(df))).notna(),
        "has_county_bikeable_days":df.get("annual_bikeable_days_county", pd.Series([np.nan]*len(df))).notna(),
        "has_taz_bikeable_days":   df.get("annual_bikeable_days_taz",    pd.Series([np.nan]*len(df))).notna(),
        "has_tdm_avo":             df.get("avo",               pd.Series([np.nan]*len(df))).notna(),
        "has_tdm_vmt_purpose":     df.get("vmt_share_commute", pd.Series([np.nan]*len(df))).notna(),
        "has_tdm_trip_length":     df.get("tdm_avg_trip_length_mi", pd.Series([np.nan]*len(df))).notna(),
        "has_transit_access_split":df.get("drive_to_transit_share", pd.Series([np.nan]*len(df))).notna(),
    })
    quality["missing_inputs"] = (~quality.drop(columns=["taz_id"])).sum(axis=1)

    return PreparedTAZ(df=df.reset_index(drop=True), quality=quality, crs=crs)


# ---------------------------------------------------------------------------
# CLI / smoke test
# ---------------------------------------------------------------------------

def _summary(prepared: PreparedTAZ) -> None:
    df = prepared.df
    q = prepared.quality
    n = len(df)
    print(f"\nPrepared TAZ table: {n:,} rows, {df.shape[1]} columns")
    print(f"  CRS used: {prepared.crs}")
    print()
    print("Area type distribution:")
    print(df["area_type"].value_counts().to_string())
    print()
    print(f"Statewide rollups:")
    print(f"  Population:                {df['population'].sum():,.0f}")
    print(f"  Households:                {df['households'].sum():,.0f}")
    print(f"  Employment:                {df['employment'].sum():,.0f}")
    print(f"  Daily VMT (TAZ produced):  {df['daily_vmt'].sum():,.0f}")
    print(f"  Daily VMT (network links): {df['network_vmt'].sum():,.0f}")
    print(f"  Daily trips:               {df['daily_trips'].sum():,.0f}")
    print(f"  Centerline miles:          {df['network_centerline_mi'].sum():,.0f}")
    print(f"  Lane-miles:                {df['network_lane_mi'].sum():,.0f}")
    print(f"  Lane-miles freeway:        {df['lane_mi_freeway'].sum():,.0f}")
    print(f"  Lane-miles major arterial: {df['lane_mi_major_arterial'].sum():,.0f}")
    print(f"  Lane-miles minor arterial: {df['lane_mi_minor_arterial'].sum():,.0f}")
    print(f"  Lane-miles collector:      {df['lane_mi_collector'].sum():,.0f}")
    print(f"  Lane-miles local:          {df['lane_mi_local'].sum():,.0f}")
    print(f"  Bike-friendly centerline:  {df['bike_centerline_mi'].sum():,.0f}")
    print(f"  Intersections (>= 3 way):  {df['intersection_count'].sum():,}")
    print(f"  Transit PMT:               {df['transit_pmt'].sum():,.0f}")
    print(f"  Transit VRH:               {df['transit_vrh'].sum():,.0f}")
    print()
    atl = df["avg_trip_length"].dropna()
    if len(atl):
        print(f"  Avg trip length (reliable): "
              f"median={atl.median():.2f} mi, mean={atl.mean():.2f} mi, "
              f"p95={atl.quantile(0.95):.2f} mi  (n={len(atl):,})")
    print()
    cdot_sections = [
        ("State Hwy centerline mi (CDOT)", "state_hwy_centerline_mi"),
        ("State Hwy lane-mi (CDOT)",       "state_hwy_lane_mi"),
        ("State Hwy VMT (CDOT)",           "state_hwy_vmt"),
        ("State Hwy low-shoulder mi",      "state_hwy_low_shoulder_mi"),
        ("Major road centerline mi",       "cdot_major_road_mi"),
        ("Local road centerline mi",       "cdot_local_road_mi"),
        ("PACE segment mi",                "pace_segments_mi"),
        ("PACE existing bike-fac mi",      "pace_existing_bike_mi"),
        ("PACE low-stress mi (LTS 1-2)",   "pace_low_stress_mi"),
        ("PACE Strava 2023 trips",         "pace_strava_2023"),
        ("PACE short trips (existing)",    "pace_short_trips_existing"),
        ("PACE short trips (2030 fcst)",   "pace_short_trips_2030"),
        ("Transit stops (statewide)",      "transit_stop_count"),
        ("Transit routes (statewide)",     "transit_route_count"),
    ]
    print("CDOT external rollups:")
    for label, col in cdot_sections:
        if col in df.columns:
            print(f"  {label:<32} {df[col].sum():>14,.0f}")
    if "cdot_urban_area_type" in df.columns:
        print(f"\nCDOT Urban Area type assignments:")
        print(df["cdot_urban_area_type"].fillna("(outside any UA = Rural)").value_counts().to_string())
    print()
    print("Data-quality coverage (count of TAZs):")
    flags = ["has_population", "has_employment", "has_trip_origin", "has_vmt",
             "has_reliable_trip_len", "has_network_links", "has_transit_service",
             "has_state_hwy", "has_pace_coverage", "has_cdot_urban_area",
             "has_cdot_transit_stop", "has_acs_mode_share",
             "has_county_bikeable_days", "has_taz_bikeable_days",
             "has_tdm_avo", "has_tdm_vmt_purpose", "has_tdm_trip_length",
             "has_transit_access_split"]
    for f in flags:
        if f in q.columns:
            print(f"  {f:<26} {q[f].sum():>6,} / {n:,} ({q[f].mean()*100:5.1f}%)")


if __name__ == "__main__":
    import sys, io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    print("Loading TAZ + network + transit metrics ...")
    prep = prepare_taz()
    _summary(prep)
