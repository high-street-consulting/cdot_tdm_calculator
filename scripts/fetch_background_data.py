"""
fetch_background_data.py - one-shot ingester for behavioral defaults.

Pulls two external datasets and caches them locally so ``prepare_taz`` can
join them into the per-TAZ table:

  1. ACS B08301 (Means of Transportation to Work) by block group from the
     Census API. Replaces the area-type mode share defaults with observed
     commute mode share for ~3,500 Colorado block groups.
     Source: Census Bureau ACS 5-Year Detailed Tables, 2022 vintage.

     REQUIRES a Census API key. Free signup (1 minute, email confirmation):
       https://api.census.gov/data/key_signup.html
     Pass via the CENSUS_API_KEY environment variable.

  2. NOAA NCEI 1991-2020 Daily Climate Normals per station, then IDW-interpolated
     to each Colorado TAZ centroid (k=5 nearest stations, p=2 distance exponent).
     Replaces the statewide 230-day default for ``annual_bikeable_days``
     with a per-TAZ value that captures sub-county elevation/climate variation.

     Bikeable days are computed *exactly* from daily normals:
       for each day-of-year d in 1..365:
           if 32 <= TMAX_NORMAL[d] <= 95:
               contribution[d] = 1 - precip_probability[d]
           else:
               contribution[d] = 0
       bikeable_days = sum(contribution)

     No inclusion-exclusion needed - each day either satisfies all conditions
     or doesn't, and precip probability is multiplied in directly.
     Source: https://www.ncei.noaa.gov/data/normals-daily/1991-2020/access/

Outputs:
  data/external/acs_mode_share_bg.csv          (one row per block-group GEOID)
  data/external/noaa_bikeable_days_county.csv  (one row per CO county FIPS)
  data/external/noaa_bikeable_days_taz.csv     (one row per CO TAZ, IDW interp)

CLI:
  python scripts/fetch_background_data.py [--only acs|noaa] [--refresh]

Re-runs skip files that already exist unless --refresh is passed.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from paths import DATA_DIR

CACHE_DIR = DATA_DIR / "external"


# ---------------------------------------------------------------------------
# Census ACS B08301 - Means of Transportation to Work, by block group
# ---------------------------------------------------------------------------

ACS_YEAR    = 2022
ACS_DATASET = "acs/acs5"
STATE_FIPS  = "08"   # Colorado

# All 64 Colorado county FIPS codes.
CO_COUNTIES_FIPS = [
    "001","003","005","007","009","011","013","014","015","017",
    "019","021","023","025","027","029","031","033","035","037",
    "039","041","043","045","047","049","051","053","055","057",
    "059","061","063","065","067","069","071","073","075","077",
    "079","081","083","085","087","089","091","093","095","097",
    "099","101","103","105","107","109","111","113","115","117",
    "119","121","123","125",
]

# B08301 variable -> output column suffix (we compute share = var / total_workers).
B08301_VARS: dict[str, str] = {
    "B08301_001E": "total_workers",
    "B08301_003E": "drove_alone",
    "B08301_004E": "carpool",
    "B08301_010E": "transit",
    "B08301_018E": "bike",
    "B08301_019E": "walk",
    "B08301_020E": "taxi_moto_other",
    "B08301_021E": "wfh",
}


def fetch_acs_mode_share(year: int = ACS_YEAR,
                          counties: list[str] | None = None,
                          api_key: str | None = None,
                          timeout: int = 90) -> list[dict]:
    """
    Query the Census ACS API once per county and return per-block-group rows.

    Each row has the 12-digit block-group GEOID, total_workers, and a
    ``<mode>_share`` for each mode in B08301_VARS.

    ``api_key`` defaults to the ``CENSUS_API_KEY`` environment variable.
    Get one at https://api.census.gov/data/key_signup.html (free, instant).
    """
    api_key = api_key or os.environ.get("CENSUS_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Census ACS requires an API key. Set CENSUS_API_KEY env var "
            "(get one at https://api.census.gov/data/key_signup.html)."
        )
    counties = counties or CO_COUNTIES_FIPS
    var_str = ",".join(B08301_VARS.keys())
    rows: list[dict] = []
    for i, county_fips in enumerate(counties):
        url = (f"https://api.census.gov/data/{year}/{ACS_DATASET}"
               f"?get={var_str}"
               f"&for=block%20group:*"
               f"&in=state:{STATE_FIPS}+county:{county_fips}"
               f"&key={api_key}")
        try:
            data = json.loads(urllib.request.urlopen(url, timeout=timeout).read())
        except (urllib.error.URLError, urllib.error.HTTPError) as e:
            print(f"  ERR county {county_fips}: {e}", file=sys.stderr)
            continue
        header = data[0]
        for record in data[1:]:
            d = dict(zip(header, record))
            try:
                total = int(d["B08301_001E"])
            except (TypeError, ValueError):
                continue
            if total <= 0:
                continue
            geoid_bg = f"{d['state']}{d['county']}{d['tract']}{d['block group']}"
            out = {"geoid_bg": geoid_bg, "total_workers": total}
            for var, label in B08301_VARS.items():
                if label == "total_workers":
                    continue
                try:
                    val = int(d[var])
                    out[f"{label}_share"] = round(val / total, 6)
                except (TypeError, ValueError):
                    out[f"{label}_share"] = None
            rows.append(out)
        if (i + 1) % 16 == 0:
            print(f"    ... fetched {i+1}/{len(counties)} counties, {len(rows):,} block groups so far")
    return rows


def write_acs_csv(rows: list[dict], out_path: Path) -> None:
    cols = ["geoid_bg", "total_workers"] + [f"{label}_share"
            for var, label in B08301_VARS.items() if label != "total_workers"]
    with out_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=cols)
        writer.writeheader()
        writer.writerows(rows)


# ---------------------------------------------------------------------------
# NOAA NCEI 1991-2020 Monthly Climate Normals, aggregated to CO county
# ---------------------------------------------------------------------------

NCEI_DAILY_NORMALS_BASE   = "https://www.ncei.noaa.gov/data/normals-daily/1991-2020/access"
GHCND_STATIONS_INVENTORY  = "https://www.ncei.noaa.gov/pub/data/ghcn/daily/ghcnd-stations.txt"

# Daily-normals CSV fields. TMAX/TMIN are degrees F, PRCP_PCTALL is a
# percentage (0-100) of historical years that recorded measurable precip
# on that calendar day.
TMAX_NORMAL_FIELD       = "DLY-TMAX-NORMAL"
PRECIP_PROBABILITY_FIELD = "DLY-PRCP-PCTALL-GE001HI"

# Bikeable-day thresholds. A day's bikeable-contribution is multiplied by
# (1 - precip_probability). Days outside the temperature range contribute 0.
BIKEABLE_TMAX_MIN_F = 32.0   # below freezing: TMAX below this means whole-day freeze
BIKEABLE_TMAX_MAX_F = 95.0   # extreme heat threshold


def fetch_co_stations(prefixes: tuple[str, ...] = ("USC", "USW"),
                      networks: tuple[str, ...] = ("HCN", "CRN", "GSN")) -> list[dict]:
    """
    Parse ghcnd-stations.txt and return CO rows.

    Filtered to:
      * ``prefixes``: station ID prefix (default USC = cooperative observer,
        USW = weather bureau).
      * ``networks``: high-quality network flags (HCN = Historical Climatology
        Network, CRN = Climate Reference Network, GSN = Global Surface Network).
        These stations have the longest, most complete records and are far
        more likely to have a 1991-2020 normals file. Pass ``networks=()``
        to skip this filter (slower but more comprehensive).

    The ghcnd-stations.txt layout (fixed-width):
      cols 1-11   ID
      cols 13-20  LAT
      cols 22-30  LON
      cols 32-37  ELEV (m)
      cols 39-40  STATE
      cols 42-71  NAME
      cols 73-75  GSN flag
      cols 77-79  HCN/CRN flag
      cols 81-85  WMO ID
    """
    raw = urllib.request.urlopen(GHCND_STATIONS_INVENTORY, timeout=120).read() \
        .decode("utf-8", errors="replace")
    stations: list[dict] = []
    for line in raw.splitlines():
        if len(line) < 71:
            continue
        if line[38:40].strip() != "CO":
            continue
        station_id = line[0:11].strip()
        if prefixes and not station_id.startswith(prefixes):
            continue
        if networks:
            gsn_flag = line[72:75].strip() if len(line) >= 75 else ""
            hcn_flag = line[76:79].strip() if len(line) >= 79 else ""
            station_networks = {gsn_flag, hcn_flag} - {""}
            if not (station_networks & set(networks)):
                continue
        try:
            stations.append({
                "station_id": station_id,
                "lat":  float(line[12:20]),
                "lon":  float(line[21:30]),
                "elev_m": float(line[31:37]) if line[31:37].strip() not in ("", "-") else None,
                "name": line[41:71].strip(),
            })
        except ValueError:
            continue
    return stations


def fetch_station_bikeable_days(station_id: str,
                                tmax_min_f: float = BIKEABLE_TMAX_MIN_F,
                                tmax_max_f: float = BIKEABLE_TMAX_MAX_F,
                                timeout: int = 30) -> dict | None:
    """
    Pull one station's 1991-2020 DAILY climate normals and return the expected
    number of bikeable days per year.

    Each row in the daily-normals CSV is one calendar day (Jan 1 .. Dec 31,
    plus Feb 29) carrying the long-term normal values. For each row:

      contribution = 0                                if TMAX not in [tmax_min_f, tmax_max_f]
      contribution = 1 - precip_probability/100        otherwise

    The sum over 365 days is the expected number of bikeable days. This is
    *exact* — no inclusion-exclusion needed because each day either contributes
    or doesn't, and precip probability is folded in multiplicatively.

    Returns None if:
      - station has no 1991-2020 daily-normals file (HTTP 404)
      - file is incomplete (< 300 valid daily rows)
      - required fields (TMAX-NORMAL, PRCP-PCTALL-GE001HI) are absent
    """
    url = f"{NCEI_DAILY_NORMALS_BASE}/{station_id}.csv"
    try:
        text = urllib.request.urlopen(url, timeout=timeout).read() \
            .decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    except urllib.error.URLError:
        return None

    rows = list(csv.reader(text.splitlines()))
    if len(rows) < 300:  # incomplete record
        return None
    header = rows[0]
    if TMAX_NORMAL_FIELD not in header or PRECIP_PROBABILITY_FIELD not in header:
        return None

    tmax_idx = header.index(TMAX_NORMAL_FIELD)
    prcp_idx = header.index(PRECIP_PROBABILITY_FIELD)

    total_bikeable    = 0.0
    valid_days        = 0
    in_temp_range_days = 0
    sentinel_skipped  = 0

    for r in rows[1:]:
        if len(r) <= max(tmax_idx, prcp_idx):
            continue
        try:
            tmax = float(r[tmax_idx])
            prcp_prob = float(r[prcp_idx])
        except (TypeError, ValueError):
            continue
        # NCEI sentinel values: -7777, -8888, -9999
        if tmax < -100 or tmax > 200 or prcp_prob < 0 or prcp_prob > 100:
            sentinel_skipped += 1
            continue
        valid_days += 1
        if tmax_min_f <= tmax <= tmax_max_f:
            in_temp_range_days += 1
            total_bikeable += (1.0 - prcp_prob / 100.0)

    if valid_days < 300:
        return None

    # Scale to a full 365-day year (in case Feb 29 or a few days are filtered).
    bikeable = total_bikeable * (365.0 / valid_days)

    return {
        "station_id":          station_id,
        "lat":                 None,  # supplied by caller from the inventory
        "lon":                 None,
        "bikeable_days":       round(bikeable, 1),
        "in_temp_range_days":  int(round(in_temp_range_days * 365.0 / valid_days)),
        "n_valid_days":        valid_days,
    }


def _load_taz_for_spatial() -> "geopandas.GeoDataFrame":
    """Load CO TAZ polygons in EPSG:4326 (lat/lon) for spatial work."""
    import geopandas as gpd
    taz_path = DATA_DIR / "TDM OD Matrices and Loaded Network" / "CDOT_2019_TAZ.json"
    taz = gpd.read_file(taz_path)
    if taz.crs is None:
        return taz.set_crs("EPSG:4326")
    return taz.to_crs("EPSG:4326")


def aggregate_stations_to_county(station_records: list[dict]) -> list[dict]:
    """
    Spatial-join station coordinates to CO TAZ polygons (which carry COUNTY +
    FIPS_CO) and aggregate by county. Used for QA / overview stats.
    """
    import geopandas as gpd
    from shapely.geometry import Point

    taz = _load_taz_for_spatial()[["COUNTY", "FIPS_CO", "geometry"]]
    pts = gpd.GeoDataFrame(
        station_records,
        geometry=[Point(s["lon"], s["lat"]) for s in station_records],
        crs="EPSG:4326",
    )
    joined = gpd.sjoin(pts, taz, predicate="within", how="left")
    joined = joined.dropna(subset=["COUNTY"])

    out: list[dict] = []
    for (fips, county), grp in joined.groupby(["FIPS_CO", "COUNTY"]):
        out.append({
            "fips_co":           int(fips),
            "county":            county,
            "n_stations":        len(grp),
            "bikeable_days":     round(grp["bikeable_days"].mean(), 1),
        })
    out.sort(key=lambda r: r["fips_co"])
    return out


def interpolate_bikeable_days_to_tazs(station_records: list[dict],
                                      k: int = 5,
                                      p: float = 2.0) -> list[dict]:
    """
    Inverse Distance Weighted interpolation of per-station bikeable_days to each
    Colorado TAZ centroid (using representative-point for irregular polygons).

    For each TAZ, the k nearest stations are weighted by 1 / distance^p and the
    weighted mean of their bikeable_days is the interpolated estimate. ``p=2``
    is the standard IDW choice; higher p makes the interpolation more local.

    Returns one row per TAZ with the interpolated value plus diagnostic columns:
      annual_bikeable_days_taz   IDW-interpolated bikeable days
      nearest_station_km          distance from TAZ to its single closest station
      n_stations_used             k (== min(k, len(stations)))
    """
    import numpy as np
    import pandas as pd

    taz = _load_taz_for_spatial()
    taz_pts = taz.geometry.representative_point()
    target_coords = np.column_stack([taz_pts.y.to_numpy(), taz_pts.x.to_numpy()])  # (lat, lon)

    station_coords = np.array([(s["lat"], s["lon"]) for s in station_records])
    station_days   = np.array([s["bikeable_days"] for s in station_records])

    # Pairwise distances in degrees, then convert to km via equirectangular approx
    # at CO latitude (~39N): 1 deg lat ≈ 111 km, 1 deg lon at 39N ≈ 87 km.
    # We keep a single km/deg factor (111) since IDW is invariant to a global
    # rescaling — the WEIGHTS are what matter and they only depend on relative
    # distances. (Reporting nearest_station_km in this same unit.)
    diff = target_coords[:, None, :] - station_coords[None, :, :]
    dist_deg = np.sqrt((diff ** 2).sum(axis=-1))           # (n_taz, n_stations)
    dist_km  = dist_deg * 111.0

    k_eff = min(k, len(station_records))
    nearest_idx  = np.argpartition(dist_km, k_eff - 1, axis=1)[:, :k_eff]
    nearest_dist = np.take_along_axis(dist_km, nearest_idx, axis=1)
    nearest_vals = station_days[nearest_idx]

    weights = 1.0 / (nearest_dist ** p + 1e-9)
    weights = weights / weights.sum(axis=1, keepdims=True)
    interpolated = (weights * nearest_vals).sum(axis=1)
    nearest_km   = nearest_dist.min(axis=1)

    out: list[dict] = []
    taz_ids = taz["TAZ_new_ID"]
    for i in range(len(taz)):
        tid = taz_ids.iloc[i]
        if pd.isna(tid):
            continue
        out.append({
            "taz_id":                    str(int(tid)),
            "annual_bikeable_days_taz":  round(float(interpolated[i]), 1),
            "nearest_station_km":        round(float(nearest_km[i]), 1),
            "n_stations_used":           int(k_eff),
        })
    return out


def write_noaa_county_csv(rows: list[dict], out_path: Path) -> None:
    cols = ["fips_co", "county", "n_stations", "bikeable_days"]
    with out_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=cols)
        writer.writeheader()
        writer.writerows(rows)


def write_noaa_taz_csv(rows: list[dict], out_path: Path) -> None:
    cols = ["taz_id", "annual_bikeable_days_taz", "nearest_station_km", "n_stations_used"]
    with out_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=cols)
        writer.writeheader()
        writer.writerows(rows)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def run_acs(refresh: bool) -> None:
    out = CACHE_DIR / "acs_mode_share_bg.csv"
    if out.exists() and not refresh:
        print(f"[skip] {out.name} (already cached, --refresh to re-fetch)")
        return
    print(f"[fetch] ACS B08301 ({ACS_YEAR} 5-year) for CO block groups ...")
    rows = fetch_acs_mode_share()
    write_acs_csv(rows, out)
    print(f"        wrote {len(rows):,} block groups -> {out.relative_to(DATA_DIR)}")


def run_noaa(refresh: bool, max_stations: int | None = None,
             idw_k: int = 5, idw_p: float = 2.0) -> None:
    out_county = CACHE_DIR / "noaa_bikeable_days_county.csv"
    out_taz    = CACHE_DIR / "noaa_bikeable_days_taz.csv"
    if out_county.exists() and out_taz.exists() and not refresh:
        print(f"[skip] noaa cache files already present (--refresh to re-fetch)")
        return
    print("[fetch] NOAA NCEI 1991-2020 station inventory (CO, HCN/CRN/GSN only) ...",
          flush=True)
    co_stations = fetch_co_stations()
    print(f"        found {len(co_stations):,} high-quality CO stations", flush=True)
    if max_stations:
        co_stations = co_stations[:max_stations]
        print(f"        limiting to first {max_stations} for testing", flush=True)

    print(f"[fetch] downloading per-station 1991-2020 DAILY normals "
          f"(thresholds: {BIKEABLE_TMAX_MIN_F:.0f} <= TMAX <= {BIKEABLE_TMAX_MAX_F:.0f} F) ...",
          flush=True)
    records = []
    for i, st in enumerate(co_stations):
        rec = fetch_station_bikeable_days(st["station_id"], timeout=20)
        if rec is not None:
            rec["lat"] = st["lat"]
            rec["lon"] = st["lon"]
            records.append(rec)
            print(f"    [ok] {st['station_id']} {st['name'][:30]:<30}  "
                  f"bikeable={rec['bikeable_days']:.0f}", flush=True)
        else:
            print(f"    [--] {st['station_id']} {st['name'][:30]:<30}  no normals", flush=True)
    print(f"        retained {len(records)}/{len(co_stations)} stations with usable normals",
          flush=True)

    if not records:
        print("        ERROR: no usable station data; aborting.", flush=True)
        return

    print("[agg]   spatial-joining stations to CO county polygons (QA) ...", flush=True)
    county_rows = aggregate_stations_to_county(records)
    write_noaa_county_csv(county_rows, out_county)
    counties_with_data = len(county_rows)
    avg_bd_county = sum(r["bikeable_days"] for r in county_rows) / max(1, counties_with_data)
    print(f"        {counties_with_data} counties with direct station data, "
          f"avg bikeable days = {avg_bd_county:.1f}", flush=True)
    print(f"        wrote -> {out_county.relative_to(DATA_DIR)}", flush=True)

    print(f"[interp] IDW interpolation to TAZ centroids (k={idw_k}, p={idw_p}) ...",
          flush=True)
    taz_rows = interpolate_bikeable_days_to_tazs(records, k=idw_k, p=idw_p)
    write_noaa_taz_csv(taz_rows, out_taz)
    if taz_rows:
        vals = [r["annual_bikeable_days_taz"] for r in taz_rows]
        nks  = [r["nearest_station_km"] for r in taz_rows]
        print(f"        {len(taz_rows):,} TAZs interpolated. bikeable days: "
              f"min={min(vals):.0f} max={max(vals):.0f} median={sorted(vals)[len(vals)//2]:.0f}",
              flush=True)
        print(f"        nearest-station distance: median={sorted(nks)[len(nks)//2]:.1f} km, "
              f"p95={sorted(nks)[int(len(nks)*0.95)]:.1f} km", flush=True)
        print(f"        wrote -> {out_taz.relative_to(DATA_DIR)}", flush=True)


def main(only: str | None, refresh: bool, max_stations: int | None) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if only in (None, "acs"):
        run_acs(refresh=refresh)
    if only in (None, "noaa"):
        run_noaa(refresh=refresh, max_stations=max_stations)


if __name__ == "__main__":
    import io as _io
    sys.stdout = _io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", choices=["acs", "noaa"], default=None,
                        help="Fetch only one source (default: both).")
    parser.add_argument("--refresh", action="store_true",
                        help="Re-fetch even if the cache file exists.")
    parser.add_argument("--max-stations", type=int, default=None,
                        help="Limit NOAA station probes (for testing).")
    args = parser.parse_args()
    main(only=args.only, refresh=args.refresh, max_stations=args.max_stations)
