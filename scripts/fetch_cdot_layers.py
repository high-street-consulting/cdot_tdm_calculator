"""
fetch_cdot_layers.py — one-shot ingester for CDOT public ArcGIS layers.

Downloads each layer to ``data/cdot_external/<slug>.geojson`` via the
public ArcGIS REST ``/query`` endpoint (anonymous, no auth). Pages with
``resultOffset`` until the server stops returning ``exceededTransferLimit``.

Run once. ``prepare_taz()`` reads from these cached files and never goes
online itself, keeping the calculator air-gapped after the initial fetch.

Layers fetched (in order):

  1. CDOT statewide road inventory
       - Highways                              (dtdapps.codot.gov server)
       - Major Roads                           (dtdapps.codot.gov server)
       - Local Roads                           (dtdapps.codot.gov server)
       - Highways: Functional Class            (dtdapps.codot.gov server)
       - Number of Lanes                       (hosted)
  2. CDOT AADT All Years                       (hosted)
  3. CDOT Urban Areas - Adjusted 2020          (dtdapps.codot.gov server)
  4. CDOT Statewide Transit
       - Statewide Transit Routes              (hosted)
       - Statewide Transit Points              (hosted)
       - Transit Sheds                         (hosted, Planning_GIS_CDOT)
  5. PACE Score Highways (1-mile state-hwy segments with LTS, Strava,
     short-trip flows, facility flags, etc.)  (services1.arcgis.com, FHU-hosted)

Re-running skips any layer whose cache file already exists, unless ``--refresh``
is passed.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = REPO_ROOT / "data" / "cdot_external"


# ---------------------------------------------------------------------------
# Source registry
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Layer:
    slug: str          # filename stem
    name: str          # human label
    url: str           # full layer URL (.../FeatureServer/<id>)
    where: str = "1=1"

LAYERS: list[Layer] = [
    # CDOT on-prem server — open_data_sde is a single FeatureServer with many
    # numbered layers; we hit specific layer IDs by index.
    Layer(
        slug="cdot_highways",
        name="CDOT Highways",
        url="https://dtdapps.codot.gov/server/rest/services/Webapps/open_data_sde/FeatureServer/7",
    ),
    Layer(
        slug="cdot_major_roads",
        name="CDOT Major Roads",
        url="https://dtdapps.codot.gov/server/rest/services/Webapps/open_data_sde/FeatureServer/17",
    ),
    Layer(
        slug="cdot_local_roads",
        name="CDOT Local Roads",
        url="https://dtdapps.codot.gov/server/rest/services/Webapps/open_data_sde/FeatureServer/14",
    ),
    Layer(
        slug="cdot_highways_functional_class",
        name="CDOT Highways: Functional Class",
        url="https://dtdapps.codot.gov/server/rest/services/Webapps/open_data_sde/FeatureServer/11",
    ),
    Layer(
        slug="cdot_urban_areas_2020",
        name="CDOT Urban Areas Adjusted 2020",
        url="https://dtdapps.codot.gov/server/rest/services/Webapps/open_data_sde/FeatureServer/34",
    ),

    # CDOT hosted (ColoradoDOT_GIS / Planning_GIS_CDOT org).
    # The standalone "Number of Lanes" feature service is only a 6-row value-
    # domain summary and is intentionally omitted; the Highways layer above
    # carries authoritative per-segment lane counts in THRULNQTY.
    Layer(
        slug="cdot_aadt_all_years",
        name="CDOT AADT All Years",
        url="https://services.arcgis.com/yzB9WM8W0BO3Ql7d/arcgis/rest/services/AADT_All_Years_Data/FeatureServer/0",
    ),
    Layer(
        slug="cdot_transit_routes",
        name="CDOT Statewide Transit Routes",
        url="https://services.arcgis.com/yzB9WM8W0BO3Ql7d/arcgis/rest/services/Statewide_Transit_Routes/FeatureServer/0",
    ),
    Layer(
        slug="cdot_transit_points",
        name="CDOT Statewide Transit Points",
        url="https://services.arcgis.com/yzB9WM8W0BO3Ql7d/arcgis/rest/services/Statewide_Transit_Points/FeatureServer/0",
    ),
    Layer(
        slug="cdot_transit_sheds",
        name="CDOT Transit Sheds",
        url="https://services.arcgis.com/yzB9WM8W0BO3Ql7d/arcgis/rest/services/Transit_Sheds/FeatureServer/0",
    ),

    # PACE — FHU-hosted on services1.arcgis.com; layer 6 is the 1-mi highway
    # segments with LTS, Strava, short-trip flows, facility flags, etc.
    Layer(
        slug="cdot_pace_highways",
        name="CDOT PACE Score (Highways layer)",
        url="https://services1.arcgis.com/bH0ZyWM4JffCJ4P5/arcgis/rest/services/CDOT_ATP_Project_Prioritization_Score/FeatureServer/6",
    ),
]


# ---------------------------------------------------------------------------
# Fetcher
# ---------------------------------------------------------------------------

def _http_get_json(url: str, params: dict, timeout: int = 120) -> dict:
    query = urllib.parse.urlencode(params)
    full = f"{url}?{query}" if "?" not in url else f"{url}&{query}"
    req = urllib.request.Request(full, headers={"User-Agent": "tdm-data-and-methods/0.1"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def fetch_layer(layer: Layer, page_size: int = 2000, max_retries: int = 3) -> dict:
    """Page through ``layer`` and return a single GeoJSON FeatureCollection."""
    query_url = layer.url.rstrip("/") + "/query"
    features: list[dict] = []
    offset = 0
    while True:
        params = {
            "where":             layer.where,
            "outFields":         "*",
            "returnGeometry":    "true",
            "outSR":             "4326",
            "f":                 "geojson",
            "resultOffset":      offset,
            "resultRecordCount": page_size,
        }
        for attempt in range(max_retries):
            try:
                page = _http_get_json(query_url, params)
                break
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
                if attempt == max_retries - 1:
                    raise
                wait = 2 ** attempt
                print(f"      retry {attempt+1}/{max_retries} after {wait}s ({e})")
                time.sleep(wait)
        feats = page.get("features", [])
        features.extend(feats)
        # Servers return one of: exceededTransferLimit (Esri JSON convention),
        # or a "properties.exceededTransferLimit" inside a geojson envelope.
        exceeded = page.get("exceededTransferLimit") \
                   or page.get("properties", {}).get("exceededTransferLimit")
        if not exceeded or not feats:
            break
        offset += len(feats)
        print(f"      ... {len(features):,} features so far")
    return {
        "type": "FeatureCollection",
        "features": features,
        "_source_url": layer.url,
        "_fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(refresh: bool = False, only: list[str] | None = None) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    targets = [l for l in LAYERS if not only or l.slug in only]
    if only:
        unknown = set(only) - {l.slug for l in LAYERS}
        if unknown:
            print(f"Unknown layer slug(s): {sorted(unknown)}", file=sys.stderr)
            sys.exit(2)

    for layer in targets:
        out = CACHE_DIR / f"{layer.slug}.geojson"
        if out.exists() and not refresh:
            size_kb = out.stat().st_size / 1024
            print(f"[skip] {layer.slug:<35}  {size_kb:>9,.0f} KB  (already cached, --refresh to re-fetch)")
            continue
        print(f"[fetch] {layer.slug:<35}  {layer.url}")
        try:
            fc = fetch_layer(layer)
        except Exception as e:
            print(f"        ERROR: {e}", file=sys.stderr)
            continue
        with open(out, "w", encoding="utf-8") as f:
            json.dump(fc, f)
        print(f"        wrote {len(fc['features']):,} features  -> {out.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true",
                        help="Re-fetch even if the cache file exists.")
    parser.add_argument("--only", nargs="+", default=None, metavar="SLUG",
                        help="Only fetch these slugs (default: all). "
                             f"Choices: {', '.join(l.slug for l in LAYERS)}")
    args = parser.parse_args()
    main(refresh=args.refresh, only=args.only)
