# AGOL item metadata: CDOT TDM Calculator TAZ layers

Ready-to-paste metadata for the two AGOL items behind the calculator's map. Both
are owned by `reichert_cdot` on `https://cdot.maps.arcgis.com` and must stay
shared **publicly** for the anonymous calculator app.

The app keys off **item IDs / service URLs**, not titles, so renaming is safe.

| Role | Item | Type |
|---|---|---|
| Display (boundaries) | `df319a5f8a9f48669fd7786204442600` | Vector Tile Service |
| Data (queryable) | `c5923ca9509043e5b5b85d9e7a507b1b` | Feature Service |

The two are paired by design: render the boundaries from the lightweight tile
cache, query attributes against the feature layer. The vector tile cache is
generated from the TAZ geometry and does **not** auto-update from the feature
layer. If the geometry changes, regenerate both.

---

## ① Vector Tile Layer (*display only*)

**Item:** `df319a5f8a9f48669fd7786204442600` (Vector Tile Service)

### Title
```
CDOT TDM Calculator: TAZ Boundaries (Vector Tiles)
```

### Summary / snippet
```
Display-only vector tile cache of the CDOT 2019 Statewide Travel Demand Model traffic analysis zone (TAZ) boundaries. Renders TAZ outlines quickly in the CDOT TDM Calculator; queryable attributes live in the companion enriched feature layer.
```

### Description
```
Pre-rendered vector tile cache of the traffic analysis zone (TAZ) boundary geometry from the CDOT 2019 Statewide Travel Demand Model (SWTDM). This layer is for fast map display only; it has no queryable attributes.

The CDOT TDM Calculator web application uses these tiles to draw TAZ boundaries (GPU-rendered) instead of drawing the heavier feature layer on the client. All queryable data (taz_id plus the enriched activity, network, transit, mode-share, and climate attributes) lives in the companion hosted feature layer, "CDOT TDM Calculator: TAZ Enriched 2026-06-29", which the app queries by taz_id.

Note: this tile cache is generated from the TAZ geometry and does not auto-update from the feature layer. If the TAZ boundaries change, regenerate both this vector tile layer and the feature layer. Must remain shared publicly for the anonymous calculator app.
```

### Tags
```
CDOT, TDM, TDM Calculator, Colorado, TAZ, traffic analysis zone, vector tiles, boundaries
```

### Credits (Attribution)
```
Colorado Department of Transportation
```

### Terms of Use
```
Boundary geometry derived from the CDOT 2019 Statewide Travel Demand Model. Provided for planning and screening use within the CDOT TDM Calculator.
```

---

## ② Feature Layer (*the queryable data*)

**Item:** `c5923ca9509043e5b5b85d9e7a507b1b` (Feature Service)
**Service URL:** `https://services.arcgis.com/yzB9WM8W0BO3Ql7d/arcgis/rest/services/CDOT_TDM_Calculator_TAZ_Enriched_2026_06_29_source_/FeatureServer/0`

### Title
```
CDOT TDM Calculator: TAZ Enriched (2026-06-29)
```

### Summary / snippet
```
Per-TAZ enriched dataset for the CDOT TDM Calculator: CDOT 2019 SWTDM zone geometry joined with derived activity/density, network and lane-mile, transit service, ACS mode share, observed vehicle occupancy and VMT-purpose split, and NOAA bikeable-days attributes.
```

### Description
```
Per-zone enriched dataset that drives the CDOT TDM Calculator. One row per traffic analysis zone (TAZ), built by scripts/prepare_taz.py from CDOT 2019 Statewide Travel Demand Model (SWTDM) outputs plus background sources.

Attribute groups include:
• Identity & geography: taz_id, county, MPO, area type, area (sq mi)
• Activity & density: population, households, employment, and population/employment/activity densities
• Travel: daily VMT, daily trips, average trip length, observed average vehicle occupancy (avo), and the VMT-purpose split (commute / recreational / other)
• Network: centerline and lane miles by facility class, plus bike-network centerline miles
• Transit: vehicle-revenue hours, route count, and drive-to-transit access share
• Mode share: ACS 5-Year (B08301) drove-alone / carpool / transit / bike / walk shares
• Climate: NOAA NCEI 1991–2020 annual bikeable-days (TAZ and county)

The CDOT TDM Calculator queries this layer by taz_id to pre-fill baseline conditions for the selected project area; the companion vector tile layer renders the boundaries. This 2026-06-29 edition adds observed vehicle occupancy, the VMT-purpose split, and transit-access fields. Must remain shared publicly for the anonymous calculator app.

Sources: CDOT 2019 SWTDM; U.S. Census Bureau ACS 5-Year (B08301); NOAA NCEI 1991–2020 daily climate normals; CDOT public highway, PACE, urban-areas, and transit feature services.
```

### Tags
```
CDOT, TDM, TDM Calculator, Colorado, TAZ, traffic analysis zone, VMT, travel demand management, mode share
```

### Credits (Attribution)
```
Colorado Department of Transportation; U.S. Census Bureau; NOAA NCEI
```

### Terms of Use
```
Derived from the CDOT 2019 Statewide Travel Demand Model and the listed public sources. These are modeled planning/screening estimates, not survey-grade measurements; verify against local data before use in design or funding decisions.
```
