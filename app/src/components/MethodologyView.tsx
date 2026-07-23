// Methodology page. Content sourced from:
//   scripts/strategy_calculations.py (formulas, elasticities, citations)
//   scripts/prepare_taz.py            (aggregation + area-type classification)
//   src/strategies/{constants,registry}.ts (the canonical TS values)

import {
  BEHAVIORAL_DEFAULTS,
  ELASTICITIES,
  MICRO_SUBSTITUTION_BY_TYPE,
  MODE_SHARE_BY_AREA_TYPE,
  PROGRAM_EFFECTS,
  VMT_PURPOSE_SHARE,
} from "../strategies/constants";
import { CATEGORIES, STRATEGIES, type StrategyMeta } from "../strategies/registry";
import { CategoryIcon } from "./CategoryIcon";
import { Markdown } from "./Markdown";

export function MethodologyView() {
  return (
    <div className="doc-view">
      <div className="doc-hero">
        <div className="overline">Documentation</div>
        <h1>Methodology</h1>
        <p>
          The calculator estimates VMT reduction from Transportation Demand
          Management strategies using effect-size estimation methodology
          adapted from the CAPCOA Handbook (2021), localized with Colorado-
          specific parameters from the Western States Handbook, the CDOT
          2019 Statewide Travel Demand Model, and ACS commute mode share.
          The numeric implementation is a TypeScript port of the Python
          reference in <code>scripts/strategy_calculations.py</code>,
          verified by 360 golden-value tests.
        </p>
      </div>

      <section className="doc-section">
        <h2>Calculation flow</h2>
        <ol className="doc-steps">
          <li>
            <b>Define a project area.</b> The user selects one or more TAZs on
            the map. Per-TAZ baseline attributes (population, employment,
            daily VMT, network lane miles, ACS commute mode share, NOAA
            bikeable days) are queried from the enriched hosted feature layer.
          </li>
          <li>
            <b>Configure strategies.</b> Each strategy reads the per-TAZ
            attributes plus user-supplied inputs (sliders, numbers,
            selectors) and computes <code>pct_vmt_reduction</code> and{" "}
            <code>daily_vmt_reduction</code> per TAZ. Strategies that act on
            a sub-purpose of VMT (commute, recreational) scope the base
            accordingly using <code>VMT_PURPOSE_SHARE</code>.
          </li>
          <li>
            <b>Aggregate.</b> Daily-VMT reductions sum across the selected
            TAZs. Per-strategy aggregate <code>pct_vmt_reduction</code> ={" "}
            <code>sum(daily_vmt_reduction) / sum(base_vmt)</code>.
          </li>
          <li>
            <b>Apply subsector caps.</b> Per CAPCOA, the combined VMT
            reduction within a category is capped (e.g. 15% for transit
            strategies combined). When the sum exceeds the cap, each
            in-category strategy is scaled down by{" "}
            <code>cap ÷ combined_pct</code>.
          </li>
          <li>
            <b>Convert to GHG.</b> Annual VMT × MOVES emission factor.
            Statewide blended rate ~0.412 kg CO₂e per VMT.
          </li>
        </ol>
      </section>

      <section className="doc-section">
        <h2>Estimation horizon</h2>
        <p>
          The calculator produces an <b>annual (single-year) VMT-reduction
          estimate</b>: the steady-state effect of the selected strategies on
          one year of driving for the project area. It does not project a
          multi-year or cumulative ("surplus") VMT trajectory. Multi-year and
          horizon analyses (for example, a 10-year reduction for a PD 1601
          application) depend on growth assumptions and phased deployment
          schedules that the tool does not yet model. Cumulative,
          multi-year forecasting is a planned future enhancement that will
          require growth assumptions and/or coordinated model runs; for now,
          extend the annual estimate using your own horizon and growth
          assumptions where a multi-year figure is needed.
        </p>
      </section>

      <section className="doc-section">
        <h2>Mode share imputation</h2>
        <p>
          Strategies that depend on commute mode share read per-TAZ ACS
          B08301 columns where available. When the Census record is
          suppressed (small / low-population block groups), the calculator
          falls back to area-type-keyed defaults, matching the Python
          reference's <code>add_imputed_mode_shares(source="auto")</code>{" "}
          behavior.
        </p>
        <p className="doc-sub">
          Area type is classified per TAZ in{" "}
          <code>prepare_taz.py</code> from activity density (population +
          employment per sq mi) against NCHRP-style thresholds:
        </p>
        <table className="doc-table">
          <thead>
            <tr>
              <th scope="col">Area type</th>
              <th scope="col">Activity density</th>
              <th scope="col">Transit</th>
              <th scope="col">Auto</th>
              <th scope="col">Bike</th>
              <th scope="col">Walk</th>
              <th scope="col">Other</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>urban_core</td>
              <td>≥ 10,000 / sq mi</td>
              <td>{(MODE_SHARE_BY_AREA_TYPE.urban_core.transit * 100).toFixed(0)}%</td>
              <td>{(MODE_SHARE_BY_AREA_TYPE.urban_core.auto * 100).toFixed(0)}%</td>
              <td>{(MODE_SHARE_BY_AREA_TYPE.urban_core.bike * 100).toFixed(0)}%</td>
              <td>{(MODE_SHARE_BY_AREA_TYPE.urban_core.walk * 100).toFixed(0)}%</td>
              <td>{(MODE_SHARE_BY_AREA_TYPE.urban_core.other * 100).toFixed(0)}%</td>
            </tr>
            <tr>
              <td>urban</td>
              <td>≥ 3,500 / sq mi</td>
              <td>{(MODE_SHARE_BY_AREA_TYPE.urban.transit * 100).toFixed(0)}%</td>
              <td>{(MODE_SHARE_BY_AREA_TYPE.urban.auto * 100).toFixed(0)}%</td>
              <td>{(MODE_SHARE_BY_AREA_TYPE.urban.bike * 100).toFixed(0)}%</td>
              <td>{(MODE_SHARE_BY_AREA_TYPE.urban.walk * 100).toFixed(0)}%</td>
              <td>{(MODE_SHARE_BY_AREA_TYPE.urban.other * 100).toFixed(0)}%</td>
            </tr>
            <tr>
              <td>suburban</td>
              <td>≥ 1,000 / sq mi</td>
              <td>{(MODE_SHARE_BY_AREA_TYPE.suburban.transit * 100).toFixed(0)}%</td>
              <td>{(MODE_SHARE_BY_AREA_TYPE.suburban.auto * 100).toFixed(0)}%</td>
              <td>{(MODE_SHARE_BY_AREA_TYPE.suburban.bike * 100).toFixed(0)}%</td>
              <td>{(MODE_SHARE_BY_AREA_TYPE.suburban.walk * 100).toFixed(0)}%</td>
              <td>{(MODE_SHARE_BY_AREA_TYPE.suburban.other * 100).toFixed(0)}%</td>
            </tr>
            <tr>
              <td>rural</td>
              <td>&lt; 1,000 / sq mi</td>
              <td>{(MODE_SHARE_BY_AREA_TYPE.rural.transit * 100).toFixed(0)}%</td>
              <td>{(MODE_SHARE_BY_AREA_TYPE.rural.auto * 100).toFixed(0)}%</td>
              <td>{(MODE_SHARE_BY_AREA_TYPE.rural.bike * 100).toFixed(0)}%</td>
              <td>{(MODE_SHARE_BY_AREA_TYPE.rural.walk * 100).toFixed(0)}%</td>
              <td>{(MODE_SHARE_BY_AREA_TYPE.rural.other * 100).toFixed(0)}%</td>
            </tr>
          </tbody>
        </table>
        <p className="doc-sub">
          Sources: NHTS 2017, ACS S0801 ranges, and CDOT / MPO surveys.
          Verbatim from <code>MODE_SHARE_BY_AREA_TYPE</code> in{" "}
          <code>strategy_calculations.py</code>.
        </p>
      </section>

      <section className="doc-section">
        <h2>Strategy formulas</h2>
        <p>
          Each strategy below shows the formula, its elasticity or effect
          size, and the citation it's drawn from. User inputs (sliders,
          numbers, selectors) feed the formula's terms.
        </p>
        {CATEGORIES.map((cat) => {
          const list = STRATEGIES.filter((s) => s.category === cat.id);
          if (list.length === 0) return null;
          return (
            <div key={cat.id} className="doc-cat">
              <div className="doc-cat-head">
                <span
                  className="doc-cat-ic"
                  style={{
                    background: `color-mix(in srgb, ${cat.cssColorVar} 14%, #fff)`,
                    color: cat.cssColorVar,
                  }}
                >
                  <CategoryIcon cat={cat.id} size={18} />
                </span>
                <h3>{cat.name}</h3>
                {cat.cap != null && (
                  <span className="doc-cat-cap">
                    Subsector cap: {cat.cap}% combined
                  </span>
                )}
              </div>
              {list.map((s) => (
                <StrategyDoc key={s.id} s={s} />
              ))}
            </div>
          );
        })}
      </section>

      <section className="doc-section">
        <h2>Elasticities and effect sizes</h2>
        <table className="doc-table">
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Value</th>
              <th scope="col">Citation</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>transit_frequency</td><td>+{ELASTICITIES.transit_frequency}</td><td>Handy et al. (2013)</td></tr>
            <tr><td>transit_service_miles</td><td>+{ELASTICITIES.transit_service_miles}</td><td>TCRP Report 95 midpoint</td></tr>
            <tr><td>transit_fare</td><td>{ELASTICITIES.transit_fare}</td><td>Paulley et al. (2006) short-run</td></tr>
            <tr><td>parking_demand</td><td>{ELASTICITIES.parking_demand}</td><td>Lehner & Peer (2019)</td></tr>
            <tr><td>vehicle_ownership_cost</td><td>{ELASTICITIES.vehicle_ownership_cost}</td><td>Litman (2020)</td></tr>
            <tr><td>residential_density</td><td>{ELASTICITIES.residential_density}</td><td>Stevens (2016)</td></tr>
            <tr><td>employment_density</td><td>{ELASTICITIES.employment_density}</td><td>Stevens (2016)</td></tr>
            <tr><td>intersection_density</td><td>{ELASTICITIES.intersection_density}</td><td>Stevens (2016)</td></tr>
            <tr><td>bike_facility</td><td>+{ELASTICITIES.bike_facility}</td><td>CAPCOA T-21 effect size</td></tr>
            <tr><td>induced_demand_freeway</td><td>+{ELASTICITIES.induced_demand_freeway}</td><td>Duranton & Turner (2011) long-run</td></tr>
            <tr><td>induced_demand_arterial</td><td>+{ELASTICITIES.induced_demand_arterial}</td><td>Duranton & Turner (2011)</td></tr>
            <tr><td>induced_demand_collector</td><td>+{ELASTICITIES.induced_demand_collector}</td><td>Duranton & Turner (2011)</td></tr>
          </tbody>
        </table>

        <h3>Pre-quantified program effects</h3>
        <table className="doc-table">
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Value</th>
              <th scope="col">Use</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>tmo_voluntary_ctr_per_eligible</td><td>{(PROGRAM_EFFECTS.tmo_voluntary_ctr_per_eligible * 100).toFixed(0)}%</td><td>TMO coverage: CAPCOA TRT-1 midpoint</td></tr>
            <tr><td>commute_program_per_eligible</td><td>{(PROGRAM_EFFECTS.commute_program_per_eligible * 100).toFixed(0)}%</td><td>Marketing / incentives: CAPCOA TRT-7 midpoint</td></tr>
            <tr><td>parking_cashout_per_eligible</td><td>{(PROGRAM_EFFECTS.parking_cashout_per_eligible * 100).toFixed(0)}%</td><td>Parking cash-out: CAPCOA TRT-15</td></tr>
            <tr><td>tod_mode_share_ratio</td><td>{PROGRAM_EFFECTS.tod_mode_share_ratio.toFixed(1)}×</td><td>TOD-resident transit share vs. area: CAPCOA LUT-4</td></tr>
            <tr><td>tod_max_transit_share</td><td>{(PROGRAM_EFFECTS.tod_max_transit_share * 100).toFixed(0)}%</td><td>Realistic ceiling for TOD-resident transit share</td></tr>
            <tr><td>sharrows_bike_share_boost</td><td>+{(PROGRAM_EFFECTS.sharrows_bike_share_boost * 100).toFixed(0)}%</td><td>Sharrows / on-street bike: CAPCOA T-19</td></tr>
            <tr><td>end_of_trip_bike_share_boost</td><td>+{(PROGRAM_EFFECTS.end_of_trip_bike_share_boost * 100).toFixed(0)}%</td><td>End-of-trip facilities: CAPCOA T-29</td></tr>
          </tbody>
        </table>

        <h3>Shared micromobility substitution ratios</h3>
        <table className="doc-table">
          <thead>
            <tr>
              <th scope="col">Type</th>
              <th scope="col">Auto-trip substitution</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(MICRO_SUBSTITUTION_BY_TYPE).map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{(v.ratio * 100).toFixed(1)}%</td>
                <td>{v.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="doc-section">
        <h2>Behavioral defaults</h2>
        <p>
          Statewide values used when a strategy needs a parameter that
          isn't carried per-TAZ in the loaded data. Override per-TAZ by
          adding a matching column to the prepared TAZ table.
        </p>
        <table className="doc-table">
          <thead>
            <tr><th scope="col">Parameter</th><th scope="col">Value</th><th scope="col">Citation</th></tr>
          </thead>
          <tbody>
            <tr><td>avo (average vehicle occupancy)</td><td>{BEHAVIORAL_DEFAULTS.avo}</td><td>NHTS 2017 national average</td></tr>
            <tr><td>avg_commute_length_mi</td><td>{BEHAVIORAL_DEFAULTS.avg_commute_length_mi} mi</td><td>NHTS 2017</td></tr>
            <tr><td>avg_vehicle_trip_length_mi</td><td>{BEHAVIORAL_DEFAULTS.avg_vehicle_trip_length_mi} mi</td><td>NHTS 2017</td></tr>
            <tr><td>avg_bike_trip_length_mi</td><td>{BEHAVIORAL_DEFAULTS.avg_bike_trip_length_mi} mi</td><td>NACTO bikeshare avg</td></tr>
            <tr><td>avg_walk_trip_length_mi</td><td>{BEHAVIORAL_DEFAULTS.avg_walk_trip_length_mi} mi</td><td>NHTS 2017</td></tr>
            <tr><td>avg_micro_trip_length_mi</td><td>{BEHAVIORAL_DEFAULTS.avg_micro_trip_length_mi} mi</td><td>NACTO shared micromobility</td></tr>
            <tr><td>daily_micro_trips_per_person</td><td>{BEHAVIORAL_DEFAULTS.daily_micro_trips_per_person}</td><td>NACTO bikeshare adoption</td></tr>
            <tr><td>annual_vehicle_ownership_cost</td><td>${BEHAVIORAL_DEFAULTS.annual_vehicle_ownership_cost.toLocaleString()}/yr</td><td>AAA "Your Driving Costs" 2024</td></tr>
            <tr><td>avg_transit_fare</td><td>${BEHAVIORAL_DEFAULTS.avg_transit_fare.toFixed(2)}</td><td>Statewide blended (RTD ~$3, MMT ~$1.50)</td></tr>
            <tr><td>annual_bikeable_days</td><td>{BEHAVIORAL_DEFAULTS.annual_bikeable_days} days</td><td>Statewide fallback (NOAA county avg)</td></tr>
          </tbody>
        </table>
      </section>

      <section className="doc-section">
        <h2>Trip-purpose VMT split</h2>
        <p>
          The 2019 SWTDM doesn't publish a per-purpose VMT split, so we
          use a calibrated default to scope strategies that act on
          commute-only or recreational-only VMT.
        </p>
        <table className="doc-table">
          <thead><tr><th scope="col">Purpose</th><th scope="col">Share of daily VMT</th></tr></thead>
          <tbody>
            <tr><td>Commute</td><td>{(VMT_PURPOSE_SHARE.commute * 100).toFixed(0)}%</td></tr>
            <tr><td>Recreational</td><td>{(VMT_PURPOSE_SHARE.recreational * 100).toFixed(0)}%</td></tr>
            <tr><td>Other</td><td>{(VMT_PURPOSE_SHARE.other * 100).toFixed(0)}%</td></tr>
          </tbody>
        </table>
        <p className="doc-sub">
          Replace with calibrated CDOT figures (HBW / HBO / NHB) when
          available.
        </p>
      </section>

      <section className="doc-section">
        <h2>Validation</h2>
        <p>
          The TypeScript port in <code>src/strategies/</code> is verified
          against the Python source by 360 golden-value tests
          (30 strategy-parameter cases × 12 representative TAZs spanning
          urban_core / urban / suburban / rural with mixed ACS coverage).
          Each TS strategy must reproduce the Python result for the same
          inputs within 1e-6 (fraction) on{" "}
          <code>pct_vmt_reduction</code> and 0.5 mi/day on{" "}
          <code>daily_vmt_reduction</code>. Regenerate the fixtures with
          <code>scripts/generate_golden_fixtures.py</code> when the Python
          formulas change.
        </p>
      </section>
    </div>
  );
}

function StrategyDoc({ s }: { s: StrategyMeta }) {
  return (
    <div className="doc-strat">
      <div className="doc-strat-head">
        <h4>{s.uid ? `${s.uid} · ${s.displayName}` : s.displayName}</h4>
        <span className="doc-strat-method">{s.method}</span>
      </div>
      <div className="doc-strat-formula">{s.formula}</div>
      {s.methodologyDetail ? (
        <Markdown className="doc-strat-source">{s.methodologyDetail}</Markdown>
      ) : (
        <p className="doc-strat-source">{s.source}</p>
      )}
    </div>
  );
}
