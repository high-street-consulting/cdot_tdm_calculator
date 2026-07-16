// Data sources page. Documents the inputs to the offline pipeline that
// produces the AGOL feature layer the SPA reads at runtime. Sourced from:
//   scripts/prepare_taz.py             (TAZ + loaded network + transit metrics)
//   scripts/fetch_background_data.py   (ACS + NOAA)
//   scripts/fetch_cdot_layers.py       (highways, PACE, urban areas, transit)
//   scripts/publish_enriched_taz.py    (the AGOL publish step)


const TAZ_ITEM_ID =
  (import.meta.env.VITE_TAZ_LAYER_URL as string | undefined)?.split(
    "FeatureServer",
  )[0] ?? "https://services.arcgis.com/yzB9WM8W0BO3Ql7d/arcgis/rest/services/CDOT_TDM_Calculator_TAZ_Enriched_source_/";
const VTL_ITEM_ID =
  (import.meta.env.VITE_VTL_ITEM_ID as string | undefined) ??
  "df319a5f8a9f48669fd7786204442600";
const PORTAL_URL =
  (import.meta.env.VITE_PORTAL_URL as string | undefined) ??
  "https://cdot.maps.arcgis.com";

export function DataSourcesView() {
  return (
    <div className="doc-view">
      <div className="doc-hero">
        <div className="overline">Documentation</div>
        <h1>Data sources</h1>
        <p>
          Every input that drives a strategy is published to a single AGOL
          hosted feature layer: the "enriched TAZ" layer. That layer is
          assembled offline by joining the CDOT 2019 Statewide Travel
          Demand Model to ACS commute mode share, NOAA climate normals,
          and CDOT public roadway / transit / PACE layers. The calculator
          queries that single layer at runtime and never calls the
          underlying source APIs.
        </p>
      </div>

      <section className="doc-section">
        <h2>The enriched TAZ layer</h2>
        <table className="doc-table">
          <tbody>
            <tr>
              <th>Hosted on</th>
              <td><a href={PORTAL_URL} target="_blank" rel="noreferrer">{PORTAL_URL}</a></td>
            </tr>
            <tr>
              <th>Vector tile layer</th>
              <td><code>{VTL_ITEM_ID}</code></td>
            </tr>
            <tr>
              <th>Feature service</th>
              <td><a href={TAZ_ITEM_ID} target="_blank" rel="noreferrer">{TAZ_ITEM_ID}</a></td>
            </tr>
            <tr>
              <th>Records</th>
              <td>8,045 TAZ polygons covering all of Colorado</td>
            </tr>
            <tr>
              <th>Columns</th>
              <td>
                112 fields including population, employment, daily VMT,
                avg trip length, area type, per-facility lane miles,
                transit PMT / VRH / VMT, ACS B08301 mode share, NOAA
                annual bikeable days, CDOT urban area, state highway
                inventory, PACE LTS, and quality flags.
              </td>
            </tr>
            <tr>
              <th>Produced by</th>
              <td>
                <code>scripts/publish_enriched_taz.py</code> (runs{" "}
                <code>prepare_taz()</code> → GeoJSON → AGOL hosted feature
                layer; the vector tile layer is published from that feature
                layer in AGOL)
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="doc-section">
        <h2>Source datasets</h2>

        <div className="doc-src">
          <h3>CDOT 2019 Statewide Travel Demand Model</h3>
          <ul className="doc-meta">
            <li><b>Vintage:</b> 2019 base year (a 2025-base update is expected summer 2026)</li>
            <li><b>Files:</b> <code>data/TDM OD Matrices and Loaded Network/CDOT_2019_TAZ.json</code> and <code>CDOT_2019_LoadNetwork.json</code></li>
            <li><b>Provides:</b> TAZ geometry + attributes (population, households, employment, daily VMT, daily trips, county / MPO / district / fare zone), and the loaded network with per-link facility type, lane count, VMT, daily flow, free-flow speed, and auto operating cost</li>
            <li><b>Loader:</b> <code>prepare_taz.load_taz()</code> and <code>load_network()</code></li>
          </ul>
        </div>

        <div className="doc-src">
          <h3>U.S. Census ACS 5-Year (B08301)</h3>
          <ul className="doc-meta">
            <li><b>Vintage:</b> Latest available 5-year release at fetch time (refresh annually)</li>
            <li><b>Geography:</b> Block group, joined onto the TAZ's 12-digit GEOID</li>
            <li><b>Provides:</b> <code>acs_total_workers</code>, <code>acs_drove_alone_share</code>, <code>acs_carpool_share</code>, <code>acs_transit_share</code>, <code>acs_bike_share</code>, <code>acs_walk_share</code>, <code>acs_wfh_share</code></li>
            <li><b>Coverage:</b> ~70% of Colorado TAZs. ACS suppresses small / low-worker block groups; the calculator falls back to area-type defaults for those</li>
            <li><b>Fetcher:</b> <code>scripts/fetch_background_data.py</code> (needs a free Census API key set as <code>CENSUS_API_KEY</code>)</li>
          </ul>
        </div>

        <div className="doc-src">
          <h3>NOAA NCEI 1991-2020 Daily Climate Normals</h3>
          <ul className="doc-meta">
            <li><b>Vintage:</b> 30-year climate normals, 1991-2020</li>
            <li><b>Stations:</b> Colorado HCN / CRN / GSN stations (subset that publishes daily-normal products)</li>
            <li><b>Provides:</b> <code>annual_bikeable_days_taz</code> (per-TAZ IDW interpolation, k=5, p=2) and <code>annual_bikeable_days_county</code> fallback. "Bikeable" = daytime high between 32°F and 95°F with no rain or snow</li>
            <li><b>Used by:</b> separated bike lanes strategy (the <code>annual_use_days</code> input pre-populates from this)</li>
            <li><b>Fetcher:</b> <code>scripts/fetch_background_data.py</code> (no auth required)</li>
          </ul>
        </div>

        <div className="doc-src">
          <h3>CDOT public layers</h3>
          <p>
            Five spatial layers pulled from CDOT's public ArcGIS services
            and joined per-TAZ. All cached locally in{" "}
            <code>data/cdot_external/</code> and rolled up via{" "}
            <code>prepare_taz.derive_*</code> functions.
          </p>
          <ul className="doc-meta">
            <li>
              <b>State Highway Inventory:</b> segment length, through-lane
              count (THRULNQTY), AADT20, speed limit, shoulder width,
              divided flag. Rolls up to{" "}
              <code>state_hwy_centerline_mi</code>,{" "}
              <code>state_hwy_lane_mi</code>, length-weighted AADT / speed
              / shoulder, low-shoulder mi.
            </li>
            <li>
              <b>Major / Local Roads:</b> centerline mileage off the state
              system, joined to{" "}
              <code>cdot_major_road_mi</code> and{" "}
              <code>cdot_local_road_mi</code>.
            </li>
            <li>
              <b>PACE (CDOT ATP Project Prioritization Score):</b>{" "}
              1-mile segments with Level of Traffic Stress (LTS),
              existing bike-facility flag, Strava trip counts, short-trip
              demand. Joined to <code>pace_segments_mi</code>,{" "}
              <code>pace_lts_avg</code>,{" "}
              <code>pace_low_stress_share</code>, plus Strava and short-
              trip totals.
            </li>
            <li>
              <b>CDOT Urban Areas 2020:</b> point-in-polygon assigns the
              CDOT urban-area name + type (Rural / Small Urban / Urbanized
              / Large Urban) to each TAZ.
            </li>
            <li>
              <b>Statewide Transit Routes + Points:</b> GTFS-derived
              stop / route / agency counts per TAZ. Joined to{" "}
              <code>transit_stop_count</code>,{" "}
              <code>transit_route_count</code>,{" "}
              <code>transit_agency_count</code>.
            </li>
          </ul>
          <p className="doc-sub">
            Fetcher: <code>scripts/fetch_cdot_layers.py</code>. No auth
            required for the public services.
          </p>
        </div>

        <div className="doc-src">
          <h3>Transit ridership metrics (CDOT 2019 SWTDM)</h3>
          <ul className="doc-meta">
            <li><b>Source:</b> Transit assignment outputs from the same 2019 SWTDM run</li>
            <li><b>Provides:</b> <code>transit_pmt</code> (passenger-miles traveled), <code>transit_vrh</code> (vehicle revenue hours), <code>transit_vmt</code>, and origin / destination splits per TAZ</li>
            <li><b>File:</b> <code>outputs/transit_metrics_per_taz.geojson</code> (produced by <code>scripts/transit_metrics_per_taz.py</code>)</li>
          </ul>
        </div>
      </section>

      <section className="doc-section">
        <h2>Derived per-TAZ fields</h2>
        <p>
          <code>prepare_taz.py</code> computes these from the source data
          and surfaces them as their own columns so strategy functions
          don't have to recompute on every run:
        </p>
        <ul className="doc-list">
          <li><code>area_type</code>: urban_core / urban / suburban / rural, classified from activity density</li>
          <li><code>pop_density</code>, <code>emp_density</code>, <code>activity_density</code>: per sq mi</li>
          <li><code>avg_trip_length</code>: daily_vmt ÷ rptTrips, reliable when trip-origin TAZ has ≥5 trips</li>
          <li><code>lane_mi_&lt;facility_class&gt;</code>: link length × LANE, aggregated per facility class (freeway, expressway, major / minor arterial, collector, local, centroid_connector)</li>
          <li><code>intersection_density</code>: count of 3+ way intersections per sq mi (centroid connectors excluded)</li>
          <li><code>length_weighted_speed</code>, <code>length_weighted_auto_op_cost_pk</code>: link-length weighted averages</li>
        </ul>
      </section>

      <section className="doc-section">
        <h2>Data not currently used</h2>
        <p>
          A few sources are fetched and cached but aren't yet read by any
          strategy. They're available for future expansion:
        </p>
        <ul className="doc-list">
          <li>PACE Strava 2022 / 2023 ride counts: proxy for revealed bicycling demand</li>
          <li>PACE short-trip flows (existing + 2030 forecast): could inform bike-mode-shift estimates</li>
          <li>CDOT AADT (all years): could supplement / cross-check the loaded-network VMT</li>
          <li>Transit sheds: could refine TOD walkshed estimation</li>
        </ul>
      </section>
    </div>
  );
}
