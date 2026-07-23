// Printable report view: a formatted, vector-text PDF report of the user's
// calculator results, suitable for project records and grant applications.
//
// Approach: a dedicated print layout (this component) + the browser's native
// print-to-PDF, rather than jsPDF/html2canvas. The design team's reference
// (docs/design/project/PrintApp.jsx + print.html) and the pre-existing
// styles/print.css both point at a print-layout direction. Native printing
// gives crisp, selectable, searchable, accessible vector text and lets the
// print engine handle page breaks across the long methodology / per-strategy
// sections; html2canvas would rasterize everything (blurry text, large
// files, manual page-slicing). Triggered from CartView's "Export PDF" button,
// which routes here (#/report) and calls window.print() once mounted.
//
// The report renders the four content blocks required by the requirements
// (§4.4 Outputs & Reporting):
//   1. Project area + all user inputs (selected TAZs, per-strategy parameters)
//   2. Selected strategies (the basket)
//   3. Methodology references (the citations/notes each strategy surfaces)
//   4. Results (aggregated VMT reduction, per-strategy contributions, GHG)

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { CATEGORIES, getStrategy } from "../strategies/registry";
import type { AggregatedResults, BasketEntry } from "../strategies/compute";
import { isDefaultValue } from "../strategies/defaults";
import type { TazInputs } from "../strategies/types";
import { annualVmtToGhgTonnes, ANNUAL_VMT_PER_CAR } from "../strategies/ghg";
import { getStrategyContext, OVERRIDE_FORMATTERS } from "../strategies/context";
import { captureProjectAreaMap } from "../data/reportMap";
import { CategoryIcon } from "./CategoryIcon";
import { Markdown } from "./Markdown";

interface ReportViewProps {
  basket: BasketEntry[];
  results: AggregatedResults;
  tazInputs: TazInputs[];
  /** Selected TAZ ids in selection order (basket may be configured before
      inputs finish loading; ids are the source of truth for the area). */
  tazIds: string[];
  /** PROJECT-LEVEL baseline VMT override (native mi/day), or null when the
      modeled/derived baseline is in use. Documented in the printed report. */
  baselineVmtOverride: number | null;
  /** Free-text "why" narrative documenting the baseline override. */
  baselineVmtNote: string;
  onBack: () => void;
}

/**
 * Render a single configured input as a "Label: value unit" pair, plus a
 * `modified` flag marking whether the user changed the value from the system
 * default for this project area (OR-04: distinguish user inputs from
 * baseline/defaults). `modified` derives from the seed snapshot persisted on
 * the basket entry, falling back to catalog defaults for entries that predate
 * the snapshot.
 */
function describeInput(
  entry: BasketEntry,
  meta: ReturnType<typeof getStrategy>,
): { label: string; value: string; modified: boolean; note?: string }[] {
  return meta.inputs
    .map((inp) => {
      const v = entry.values[inp.key];
      if (v == null) return null;
      const scale = inp.type === "slider" ? inp.scale ?? 1 : 1;
      const display = typeof v === "number" ? v * scale : v;
      const suffix =
        inp.type === "slider"
          ? inp.suffix ?? ""
          : inp.type === "number"
          ? inp.unit
            ? ` ${inp.unit}`
            : ""
          : "";
      // For selects, show the option label rather than the raw value.
      let valueStr: string;
      if (inp.type === "select") {
        const opt = inp.options.find((o) => o.value === v);
        valueStr = opt?.label ?? String(display);
      } else if (typeof display === "number") {
        valueStr =
          display.toLocaleString(undefined, { maximumFractionDigits: 2 }) +
          suffix;
      } else {
        valueStr = `${display}${suffix}`;
      }
      const seeded = entry.seededDefaults?.[inp.key] ?? meta.defaults[inp.key];
      const modified = !isDefaultValue(v, seeded);
      // Surface the optional source/justification note only for modified inputs
      // that carry one (CMT-01).
      const note = modified ? entry.inputNotes?.[inp.key]?.trim() || undefined : undefined;
      return { label: inp.label, value: valueStr, modified, note };
    })
    .filter(
      (x): x is { label: string; value: string; modified: boolean; note: string | undefined } =>
        x !== null,
    );
}

/**
 * Resolve the project-context baseline overrides pinned on a basket entry into
 * printable rows: each overrideKey (e.g. "transit_mode_share") mapped to its
 * human label + display-unit value via the strategy's context rows, plus the
 * optional "why" narrative. Documents WHICH baseline was overridden, to WHAT,
 * and WHY, alongside the per-input source/justification notes (CMT-01). Returns
 * [] when the entry carries no overrides.
 */
function describeOverrides(
  entry: BasketEntry,
  tazInputs: TazInputs[],
): { key: string; label: string; value: string; note?: string }[] {
  const overrides = entry.contextOverrides;
  if (!overrides || Object.keys(overrides).length === 0) return [];
  const rows = getStrategyContext(entry.id, tazInputs, entry.values);
  const labelByKey = new Map<string, string>();
  for (const r of rows) {
    if (r.overrideKey) labelByKey.set(r.overrideKey, r.label);
  }
  return Object.entries(overrides)
    .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
    .map(([key, v]) => {
      const format = OVERRIDE_FORMATTERS[key];
      return {
        key,
        label: labelByKey.get(key) ?? key,
        value: format ? format(v) : String(v),
        note: entry.contextNotes?.[key]?.trim() || undefined,
      };
    });
}

export function ReportView({
  basket,
  results,
  tazInputs,
  tazIds,
  baselineVmtOverride,
  baselineVmtNote,
  onBack,
}: ReportViewProps) {
  const navigate = useNavigate();

  // Static project-area map image (rendered offscreen) + whether that render
  // has settled (succeeded, failed, or timed out). The auto-print waits on it.
  const [mapImg, setMapImg] = useState<string | null>(null);
  const [mapSettled, setMapSettled] = useState(false);
  // Stable dependency: tazIds is a fresh array each render.
  const tazKey = tazIds.join(",");

  // Nothing to report on → bounce back to the cart. (Guards a direct
  // #/report deep link with an empty basket.)
  useEffect(() => {
    if (basket.length === 0) {
      navigate("/cart", { replace: true });
    }
  }, [basket.length, navigate]);

  // Render the project-area map once. A safety timer guarantees `mapSettled`
  // flips even if the offscreen capture stalls, so auto-print never hangs.
  useEffect(() => {
    if (basket.length === 0) return;
    if (tazIds.length === 0) {
      setMapSettled(true);
      return;
    }
    let cancelled = false;
    const safety = setTimeout(() => {
      if (!cancelled) setMapSettled(true);
    }, 16000);
    captureProjectAreaMap(tazIds)
      .then((url) => {
        if (!cancelled) setMapImg(url);
      })
      .catch(() => {
        /* logged inside captureProjectAreaMap */
      })
      .finally(() => {
        if (!cancelled) {
          clearTimeout(safety);
          setMapSettled(true);
        }
      });
    return () => {
      cancelled = true;
      clearTimeout(safety);
    };
    // tazIds is intentionally tracked via tazKey (stable string).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basket.length, tazKey]);

  // Open the print dialog automatically once the report has painted AND the
  // project-area map has settled (so the map is included in the printout).
  // A short delay lets fonts settle so the printed text isn't reflowed.
  useEffect(() => {
    if (basket.length === 0 || !mapSettled) return;
    let cancelled = false;
    const run = async () => {
      if (document.fonts?.ready) {
        try {
          await document.fonts.ready;
        } catch {
          /* ignore */
        }
      }
      await new Promise((r) => setTimeout(r, 350));
      if (!cancelled) window.print();
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [basket.length, mapSettled]);

  if (basket.length === 0) return null;

  const generated = new Date();
  const totalPct = results.total_pct_vmt_reduction * 100;
  const dailyReduced = results.total_daily_vmt_reduction;
  const annualReduced = dailyReduced * 365;
  const ghgTonnes = annualVmtToGhgTonnes(annualReduced);
  const carsEquiv = annualReduced / ANNUAL_VMT_PER_CAR;
  const tazCount = tazIds.length || results.taz_count;

  // Index the queried TAZ rows by id for the project-area roster.
  const inputsById = new Map(tazInputs.map((t) => [t.taz_id, t]));

  // Strategies that surfaced a methodology note, in basket order.
  const methodEntries = results.per_strategy.map((p) => ({
    p,
    meta: getStrategy(p.id),
  }));

  return (
    <div className="report-view">
      {/* Screen-only toolbar; hidden in print. */}
      <div className="report-toolbar" role="toolbar" aria-label="Report actions">
        <button type="button" className="report-back" onClick={onBack}>
          ← Back to results
        </button>
        <div className="report-toolbar-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => window.print()}
          >
            Print / Save as PDF
          </button>
        </div>
      </div>

      <article className="report-doc">
        {/* ── Report header / cover band ──────────────────────────── */}
        <header className="report-head">
          <img
            className="report-logo"
            src={`${import.meta.env.BASE_URL}cdot_logo.png`}
            alt="Colorado Department of Transportation"
          />
          <div className="report-head-text">
            <div className="report-overline">CDOT TDM Calculator</div>
            <h1>TDM Strategy Package: VMT Reduction Report</h1>
            <div className="report-meta">
              Generated{" "}
              {generated.toLocaleString(undefined, {
                dateStyle: "long",
                timeStyle: "short",
              })}{" "}
              · {basket.length} strateg{basket.length === 1 ? "y" : "ies"} ·{" "}
              {tazCount} TAZ{tazCount === 1 ? "" : "s"}
            </div>
          </div>
        </header>

        {/* ── Results headline (aggregated VMT + GHG) ─────────────── */}
        <section className="report-section report-results-hero">
          <h2 className="report-section-title">Results summary</h2>
          <div className="report-hero-grid">
            <div className="report-hero-big">
              <div className="report-hero-num">
                {totalPct >= 0 ? "−" : "+"}
                {Math.abs(totalPct).toFixed(2)}
                <span className="u">% VMT</span>
              </div>
              <div className="report-hero-sub">
                {totalPct >= 0 ? "reduction" : "increase"} vs. baseline
              </div>
            </div>
            <dl className="report-stat-grid">
              <div>
                <dt>Baseline VMT</dt>
                <dd>
                  {Math.round(results.baseline_vmt).toLocaleString()}
                  <span className="u">mi/day</span>
                </dd>
              </div>
              <div>
                <dt>Daily VMT reduced</dt>
                <dd>
                  {Math.round(dailyReduced).toLocaleString()}
                  <span className="u">mi/day</span>
                </dd>
              </div>
              <div>
                <dt>Annual VMT reduced</dt>
                <dd>
                  {(annualReduced / 1e6).toFixed(2)}
                  <span className="u">million mi/yr</span>
                </dd>
              </div>
              <div>
                <dt>GHG avoided</dt>
                <dd>
                  {Math.round(ghgTonnes).toLocaleString()}
                  <span className="u">tons CO₂e/yr</span>
                </dd>
              </div>
              <div>
                <dt>Cars off-road equiv.</dt>
                <dd>
                  {Math.round(carsEquiv).toLocaleString()}
                  <span className="u">vehicles</span>
                </dd>
              </div>
              <div>
                <dt>Strategies</dt>
                <dd>
                  {basket.length}
                  <span className="u">selected</span>
                </dd>
              </div>
            </dl>
          </div>

          {baselineVmtOverride != null && (
            <p className="report-baseline-override">
              <b>
                Baseline VMT overridden to{" "}
                {Math.round(baselineVmtOverride).toLocaleString()} mi/day.
              </b>{" "}
              The modeled baseline (aggregated from the selected TAZs) was
              replaced with a project-specified value; all baseline and absolute
              VMT figures above reflect this override.
              {baselineVmtNote.trim() && (
                <>
                  {" "}
                  <span className="report-baseline-override-note">
                    Justification: {baselineVmtNote.trim()}
                  </span>
                </>
              )}
            </p>
          )}

          {results.capped_categories.length > 0 && (
            <p className="report-cap-note">
              <b>Subsector cap applied</b> to{" "}
              {results.capped_categories
                .map((id) => CATEGORIES.find((c) => c.id === id)?.name ?? id)
                .join(", ")}
              . Per CAPCOA methodology, combined reductions within a category
              are capped to prevent double-counting; affected strategies are
              flagged below.
            </p>
          )}
        </section>

        {/* ── Per-strategy contributions (Results detail) ─────────── */}
        <section className="report-section">
          <h2 className="report-section-title">Per-strategy contribution</h2>
          <table className="report-table report-contrib-table">
            <thead>
              <tr>
                <th scope="col">Strategy</th>
                <th scope="col">Category</th>
                <th scope="col" className="num">% VMT</th>
                <th scope="col" className="num">Daily mi</th>
                <th scope="col" className="num">Annual mi/yr</th>
              </tr>
            </thead>
            <tbody>
              {results.per_strategy.map((p) => {
                const cat = CATEGORIES.find((c) => c.id === p.meta.category);
                const annual = p.daily_vmt_reduction * 365;
                // Sign follows the computed contribution (positive = reduction),
                // not the static isInduced flag (CMT-06/08).
                const sign = p.pct_vmt_reduction >= 0 ? "−" : "+";
                return (
                  <tr key={p.id}>
                    <td>
                      {p.meta.uid ? (
                        <span className="report-uid">{p.meta.uid}</span>
                      ) : null}
                      {p.meta.displayName}
                      {p.capped && <span className="report-tag">CAPPED</span>}
                    </td>
                    <td>{cat?.name ?? p.meta.category}</td>
                    <td className="num">
                      {sign}
                      {(Math.abs(p.pct_vmt_reduction) * 100).toFixed(2)}%
                    </td>
                    <td className="num">
                      {sign}
                      {Math.round(Math.abs(p.daily_vmt_reduction)).toLocaleString()}
                    </td>
                    <td className="num">
                      {sign}
                      {Math.round(Math.abs(annual)).toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={2}>Combined (after caps)</th>
                <td className="num">
                  {totalPct >= 0 ? "−" : "+"}
                  {Math.abs(totalPct).toFixed(2)}%
                </td>
                <td className="num">
                  {totalPct >= 0 ? "−" : "+"}
                  {Math.round(Math.abs(dailyReduced)).toLocaleString()}
                </td>
                <td className="num">
                  {totalPct >= 0 ? "−" : "+"}
                  {Math.round(Math.abs(annualReduced)).toLocaleString()}
                </td>
              </tr>
            </tfoot>
          </table>
        </section>

        {/* ── Project area + all user inputs ──────────────────────── */}
        <section className="report-section">
          <h2 className="report-section-title">
            Project area &amp; configured inputs
          </h2>
          <p className="report-lede">
            The estimate applies the selected strategies to the{" "}
            {tazCount} traffic analysis zone{tazCount === 1 ? "" : "s"} below.
            Baseline VMT, mode share, and density are aggregated from the
            Colorado Statewide Travel Model, U.S. Census ACS, and CDOT public
            layers.
          </p>

          <div className="report-map-wrap">
            {mapImg ? (
              <img
                className="report-map"
                src={mapImg}
                alt={`Map of the ${tazCount} selected traffic analysis zone${
                  tazCount === 1 ? "" : "s"
                }`}
              />
            ) : mapSettled ? (
              <p className="report-empty">Project-area map unavailable.</p>
            ) : (
              <p className="report-empty">Rendering project-area map…</p>
            )}
          </div>

          <h3 className="report-sub">Selected traffic analysis zones</h3>
          {tazInputs.length > 0 ? (
            <table className="report-table">
              <thead>
                <tr>
                  <th scope="col">TAZ</th>
                  <th scope="col">Area type</th>
                  <th scope="col" className="num">Daily VMT</th>
                  <th scope="col" className="num">Population</th>
                  <th scope="col" className="num">Employment</th>
                </tr>
              </thead>
              <tbody>
                {tazIds.map((id) => {
                  const t = inputsById.get(id);
                  return (
                    <tr key={id}>
                      <td>{id}</td>
                      <td>{t?.area_type ?? "–"}</td>
                      <td className="num">
                        {t && Number.isFinite(t.daily_vmt)
                          ? Math.round(t.daily_vmt).toLocaleString()
                          : "–"}
                      </td>
                      <td className="num">
                        {t?.population != null
                          ? Math.round(t.population).toLocaleString()
                          : "–"}
                      </td>
                      <td className="num">
                        {t?.employment != null
                          ? Math.round(t.employment).toLocaleString()
                          : "–"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total ({tazCount})</th>
                  <td />
                  <td className="num">
                    {Math.round(results.baseline_vmt).toLocaleString()}
                  </td>
                  <td />
                  <td />
                </tr>
              </tfoot>
            </table>
          ) : (
            <p className="report-empty">
              {tazCount > 0
                ? "TAZ baseline attributes are still loading; re-export once the area finishes loading."
                : "No project area selected."}
            </p>
          )}

          <h3 className="report-sub">Configured strategy parameters</h3>
          <div className="report-inputs">
            {results.per_strategy.map((p) => {
              const entry = basket.find((b) => b.id === p.id);
              if (!entry) return null;
              const meta = getStrategy(p.id);
              const pairs = describeInput(entry, meta);
              const overrides = describeOverrides(entry, tazInputs);
              return (
                <div key={p.id} className="report-input-block">
                  <div className="report-input-name">
                    {meta.uid ? (
                      <span className="report-uid">{meta.uid}</span>
                    ) : null}
                    {meta.displayName}
                  </div>
                  {pairs.length > 0 ? (
                    <dl className="report-input-list">
                      {pairs.map((pr) => (
                        <div key={pr.label}>
                          <dt>{pr.label}</dt>
                          <dd>
                            {pr.value}
                            {pr.modified ? (
                              <span className="report-input-mod"> (modified)</span>
                            ) : (
                              <span className="report-input-def"> (default)</span>
                            )}
                            {pr.note && (
                              <span className="report-input-note">
                                {" "}
                                Source / justification: {pr.note}
                              </span>
                            )}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <div className="report-input-default">
                      No adjustable inputs; uses modeled defaults.
                    </div>
                  )}
                  {overrides.length > 0 && (
                    <div className="report-overrides">
                      <div className="report-overrides-head">
                        Project context overrides
                      </div>
                      <dl className="report-input-list">
                        {overrides.map((o) => (
                          <div key={o.key}>
                            <dt>{o.label}</dt>
                            <dd>
                              {o.value}
                              <span className="report-input-mod"> (overridden)</span>
                              {o.note && (
                                <span className="report-input-note">
                                  {" "}
                                  Justification: {o.note}
                                </span>
                              )}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* ── Selected strategies + methodology references ────────── */}
        <section className="report-section report-method-section">
          <h2 className="report-section-title">
            Selected strategies &amp; methodology
          </h2>
          <p className="report-lede">
            Each strategy below lists the calculation method, formula, and the
            source citations behind its effect size. Figures follow effect-size
            estimation adapted from the CAPCOA Handbook (2021), localized with
            Colorado-specific parameters; the full methodology is documented in
            the calculator&rsquo;s Methodology reference.
          </p>

          {CATEGORIES.map((cat) => {
            const inCat = methodEntries.filter(
              (m) => m.meta.category === cat.id,
            );
            if (inCat.length === 0) return null;
            return (
              <div key={cat.id} className="report-method-cat">
                <div className="report-method-cat-head">
                  <span
                    className="report-cat-ic"
                    style={{
                      background: `color-mix(in srgb, ${cat.cssColorVar} 14%, #fff)`,
                      color: cat.cssColorVar,
                    }}
                    aria-hidden="true"
                  >
                    <CategoryIcon cat={cat.id} size={14} />
                  </span>
                  <h3>{cat.name}</h3>
                  {cat.cap != null && (
                    <span className="report-cat-cap">
                      Subsector cap {cat.cap}% combined
                    </span>
                  )}
                </div>
                {inCat.map(({ p, meta }) => (
                  <div key={p.id} className="report-method-strat">
                    <div className="report-method-strat-head">
                      <h4>
                        {meta.uid ? `${meta.uid} · ` : ""}
                        {meta.displayName}
                      </h4>
                      <span className="report-method-tag">{meta.method}</span>
                    </div>
                    {meta.formula && (
                      <div className="report-formula">{meta.formula}</div>
                    )}
                    {meta.methodologyDetail ? (
                      <Markdown className="report-method-detail">
                        {meta.methodologyDetail}
                      </Markdown>
                    ) : (
                      <p className="report-method-detail">{meta.source}</p>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </section>

        <footer className="report-foot">
          <span>
            CDOT TDM Calculator · Estimates are screening-level and intended to
            support planning and grant applications.
          </span>
          <span>
            Generated {generated.toLocaleDateString()} ·
            high-street.bitbucket.io/cdot_tdm_calculator
          </span>
        </footer>
      </article>
    </div>
  );
}
