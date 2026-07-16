#!/usr/bin/env python3
"""Update AGOL item metadata for the two CDOT TDM Calculator TAZ layers.

These items live in the CDOT org (cdot.maps.arcgis.com) and are owned by
reichert_cdot, so you must authenticate with a CDOT account that has edit
rights — NOT the High Street partner creds in .env.

Run (from the repo root, inside the project .venv which already has `arcgis`):

    AGOL_USER=<cdot-user> AGOL_PASSWORD=<cdot-pass> \\
        .venv/bin/python scripts/update_agol_metadata.py

AGOL_URL defaults to the CDOT org; override with AGOL_URL=... if needed. Prints
only item ids + non-secret status — never credentials.

Source content of record: docs/agol_item_metadata.md
"""
import os
import sys
from arcgis.gis import GIS

DEFAULT_AGOL_URL = "https://cdot.maps.arcgis.com"

VTL_ITEM = "df319a5f8a9f48669fd7786204442600"
FL_ITEM = "c5923ca9509043e5b5b85d9e7a507b1b"

VTL_DESC = (
    "<p>Pre-rendered vector tile cache of the traffic analysis zone (TAZ) boundary "
    "geometry from the CDOT 2019 Statewide Travel Demand Model (SWTDM). This layer is "
    "for fast map display only — it has no queryable attributes.</p>"
    "<p>The CDOT TDM Calculator web application uses these tiles to draw TAZ boundaries "
    "(GPU-rendered) instead of drawing the heavier feature layer on the client. All "
    "queryable data — taz_id plus the enriched activity, network, transit, "
    "mode-share, and climate attributes — lives in the companion hosted feature "
    "layer, &quot;CDOT TDM Calculator — TAZ Enriched 2026-06-29&quot;, which the "
    "app queries by taz_id.</p>"
    "<p><b>Note:</b> this tile cache is generated from the TAZ geometry and does not "
    "auto-update from the feature layer. If the TAZ boundaries change, regenerate both "
    "this vector tile layer and the feature layer. Must remain shared publicly for the "
    "anonymous calculator app.</p>"
)

FL_DESC = (
    "<p>Per-zone enriched dataset that drives the CDOT TDM Calculator. One row per "
    "traffic analysis zone (TAZ), built by <code>scripts/prepare_taz.py</code> from "
    "CDOT 2019 Statewide Travel Demand Model (SWTDM) outputs plus background sources.</p>"
    "<p>Attribute groups include:</p>"
    "<ul>"
    "<li><b>Identity &amp; geography</b> — taz_id, county, MPO, area type, area (sq mi)</li>"
    "<li><b>Activity &amp; density</b> — population, households, employment, and "
    "population/employment/activity densities</li>"
    "<li><b>Travel</b> — daily VMT, daily trips, average trip length, observed average "
    "vehicle occupancy (avo), and the VMT-purpose split (commute / recreational / other)</li>"
    "<li><b>Network</b> — centerline and lane miles by facility class, plus bike-network "
    "centerline miles</li>"
    "<li><b>Transit</b> — vehicle-revenue hours, route count, and drive-to-transit access share</li>"
    "<li><b>Mode share</b> — ACS 5-Year (B08301) drove-alone / carpool / transit / bike / walk shares</li>"
    "<li><b>Climate</b> — NOAA NCEI 1991–2020 annual bikeable-days (TAZ and county)</li>"
    "</ul>"
    "<p>The CDOT TDM Calculator queries this layer by taz_id to pre-fill baseline "
    "conditions for the selected project area; the companion vector tile layer renders "
    "the boundaries. This 2026-06-29 edition adds observed vehicle occupancy, the "
    "VMT-purpose split, and transit-access fields. Must remain shared publicly for the "
    "anonymous calculator app.</p>"
    "<p><b>Sources:</b> CDOT 2019 SWTDM; U.S. Census Bureau ACS 5-Year (B08301); NOAA "
    "NCEI 1991–2020 daily climate normals; CDOT public highway, PACE, urban-areas, "
    "and transit feature services.</p>"
)

UPDATES = {
    VTL_ITEM: {
        "title": "CDOT TDM Calculator — TAZ Boundaries (Vector Tiles)",
        "snippet": (
            "Display-only vector tile cache of the CDOT 2019 Statewide Travel Demand "
            "Model traffic analysis zone (TAZ) boundaries. Renders TAZ outlines quickly "
            "in the CDOT TDM Calculator; queryable attributes live in the companion "
            "enriched feature layer."
        ),
        "description": VTL_DESC,
        "tags": ["CDOT", "TDM", "TDM Calculator", "Colorado", "TAZ",
                 "traffic analysis zone", "vector tiles", "boundaries"],
        "accessInformation": "Colorado Department of Transportation",
        "licenseInfo": (
            "Boundary geometry derived from the CDOT 2019 Statewide Travel Demand Model. "
            "Provided for planning and screening use within the CDOT TDM Calculator."
        ),
    },
    FL_ITEM: {
        "title": "CDOT TDM Calculator — TAZ Enriched (2026-06-29)",
        "snippet": (
            "Per-TAZ enriched dataset for the CDOT TDM Calculator: CDOT 2019 SWTDM zone "
            "geometry joined with derived activity/density, network and lane-mile, "
            "transit service, ACS mode share, observed vehicle occupancy and VMT-purpose "
            "split, and NOAA bikeable-days attributes."
        ),
        "description": FL_DESC,
        "tags": ["CDOT", "TDM", "TDM Calculator", "Colorado", "TAZ",
                 "traffic analysis zone", "VMT", "travel demand management", "mode share"],
        "accessInformation": "Colorado Department of Transportation; U.S. Census Bureau; NOAA NCEI",
        "licenseInfo": (
            "Derived from the CDOT 2019 Statewide Travel Demand Model and the listed "
            "public sources. These are modeled planning/screening estimates, not "
            "survey-grade measurements; verify against local data before use in design "
            "or funding decisions."
        ),
    },
}


def main() -> int:
    url = os.environ.get("AGOL_URL") or DEFAULT_AGOL_URL
    user = os.environ.get("AGOL_USER")
    pw = os.environ.get("AGOL_PASSWORD")
    if not (user and pw):
        print("ERROR: set AGOL_USER and AGOL_PASSWORD (CDOT-org credentials) in the environment.")
        return 2

    gis = GIS(url, user, pw)
    me = gis.users.me
    print(f"Signed in as: {me.username} ({me.role}) @ {url}")

    rc = 0
    for item_id, props in UPDATES.items():
        item = gis.content.get(item_id)
        if item is None:
            print(f"  [{item_id}] NOT FOUND or inaccessible — skipped")
            rc = 1
            continue
        owner = getattr(item, "owner", "?")
        ok = item.update(item_properties=props)
        fresh = gis.content.get(item_id)
        status = "OK" if ok else "FAILED"
        print(f"  [{item_id}] {status} | owner={owner} | type={item.type}")
        print(f"      title:   {fresh.title}")
        print(f"      snippet: {(fresh.snippet or '')[:80]}...")
        print(f"      tags:    {', '.join(fresh.tags or [])}")
        if not ok:
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
