// Results / cart view: combined VMT reduction, per-strategy contribution
// breakdown, subsector-cap note, co-benefits, export buttons.

import { CATEGORIES, getStrategy } from "../strategies/registry";
import {
  purposePoolsLabel,
  strategyPools,
  type AggregatedResults,
  type BasketEntry,
} from "../strategies/compute";
import { isDefaultValue } from "../strategies/defaults";
import type { StrategyKey } from "../strategies/strategies";
import type { TazInputs } from "../strategies/types";
import { downloadResultsCsv } from "../data/exportCsv";
import { annualVmtToGhgTonnes, ANNUAL_VMT_PER_CAR } from "../strategies/ghg";
import { getStrategyContext, OVERRIDE_FORMATTERS } from "../strategies/context";
import { CategoryIcon } from "./CategoryIcon";

/** Human label for each cap tier, used in the CAPPED info tooltip. */
const CAP_TIER_LABEL: Record<string, string> = {
  measure: "measure maximum",
  land_use: "land-use maximum",
  category: "category maximum",
  ctr: "commute-trip-reduction maximum",
  global: "overall maximum",
};

/** Format a cap percent: integers bare, otherwise one decimal (e.g. 15.7). */
function fmtCapPct(x: number): string {
  return x % 1 === 0 ? String(x) : x.toFixed(1);
}

interface CartViewProps {
  basket: BasketEntry[];
  results: AggregatedResults;
  tazCount: number;
  /** Per-TAZ baseline attributes for the selection, included in the CSV. */
  tazInputs: TazInputs[];
  /** PROJECT-LEVEL baseline VMT override (native mi/day), or null when the
      modeled/derived baseline is in use. When set, surfaced as a note near the
      summary and passed into the CSV export. */
  baselineVmtOverride: number | null;
  /** Free-text "why" narrative documenting the baseline override. */
  baselineVmtNote: string;
  onEdit: (id: StrategyKey) => void;
  onRemove: (id: StrategyKey) => void;
  onBrowse: () => void;
  /** Open the printable PDF report (navigates to #/report). */
  onExportPdf: () => void;
}

export function CartView({
  basket,
  results,
  tazCount,
  tazInputs,
  baselineVmtOverride,
  baselineVmtNote,
  onEdit,
  onRemove,
  onBrowse,
  onExportPdf,
}: CartViewProps) {
  if (basket.length === 0) {
    return (
      <div className="cart-view">
        <div className="cart-main">
          <div className="cart-empty">
            <h1>No strategies in your package yet</h1>
            <p>Add TDM strategies to see combined VMT reduction, GHG co-benefits, and per-strategy contributions.</p>
            <button
              onClick={onBrowse}
              className="cart-empty-cta"
            >
              Browse strategies
            </button>
          </div>
        </div>
      </div>
    );
  }

  const totalPct = results.total_pct_vmt_reduction * 100;
  const dailyReduced = results.total_daily_vmt_reduction;
  const annualReduced = dailyReduced * 365;
  const ghgTonnes = annualVmtToGhgTonnes(annualReduced);
  // Net direction follows the computed sign (positive = a reduction). When the
  // package nets to an increase, the abs-row labels read "added"/"increase"
  // rather than "reduced" (CMT-06/08).
  const netReduces = dailyReduced >= 0;

  // Multiplicative combination adjustment: the gap between the additive sum of
  // each strategy's standalone reduction and the (damped) combined total, i.e.
  // the reduction "lost" to overlap + CAPCOA caps. Shown as its own line in the
  // category breakdown so the standalone category subtotals reconcile with the
  // combined headline. Negative delta (less reduction) → renders as "+".
  const combinationAdjustmentDelta =
    results.total_daily_vmt_reduction - results.sum_standalone_daily_vmt_reduction;
  const combinationAdjustmentPct =
    results.baseline_vmt > 0 ? combinationAdjustmentDelta / results.baseline_vmt : 0;
  const hasCombinationAdjustment = Math.abs(combinationAdjustmentPct * 100) >= 0.005;

  return (
    <div className="cart-view">
      <div className="cart-main">
        <div className="cart-hero">
          <div>
            <h1 className="ov">Your strategy package</h1>
            {/* aria-label is prohibited on a plain <div>; expose the value to AT
                via an sr-only phrase and hide the decorative glyph rendering. */}
            <div className="big">
              <span className="sr-only">
                {`${totalPct >= 0 ? "Reduction" : "Increase"} of ${Math.abs(totalPct).toFixed(2)} percent VMT versus baseline`}
              </span>
              <span aria-hidden="true">
                {totalPct >= 0 ? "−" : "+"}
                {Math.abs(totalPct).toFixed(2)}
                <span className="pct">% VMT</span>
              </span>
            </div>
            <div className="sub">
              vs. baseline · {basket.length} strateg{basket.length === 1 ? "y" : "ies"} · {tazCount} TAZ{tazCount === 1 ? "" : "s"}
            </div>
            <p className="hero-note">
              Combined reduction across all VMT, adjusted for overlapping impacts.{" "}
              <a href="#/methodology">How it's calculated →</a>
            </p>
            <div className="abs-row">
              <div className="c">
                <div className="lab">Daily VMT {netReduces ? "reduced" : "added"}</div>
                <div className="v">
                  {Math.round(Math.abs(dailyReduced)).toLocaleString()}
                  <span className="u">mi/day</span>
                </div>
              </div>
              <div className="c">
                <div className="lab">Annual VMT {netReduces ? "reduced" : "added"}</div>
                <div className="v">
                  {(Math.abs(annualReduced) / 1e6).toFixed(2)}
                  <span className="u">million mi/yr</span>
                </div>
              </div>
              <div className="c">
                <div className="lab">{netReduces ? "GHG avoided" : "GHG increase"}</div>
                <div className="v">
                  {Math.round(Math.abs(ghgTonnes)).toLocaleString()}
                  <span className="u">tons CO₂e/yr</span>
                </div>
              </div>
            </div>
          </div>
          <div className="right">
            <div className="badge-count">{basket.length} strategies selected</div>
          </div>
        </div>

        {baselineVmtOverride != null && (
          <div className="baseline-override-note">
            <span className="ic">✎</span>
            <div>
              <b>
                Baseline VMT overridden to{" "}
                {Math.round(baselineVmtOverride).toLocaleString("en-US")} mi/day
              </b>
              {baselineVmtNote.trim() && ` — ${baselineVmtNote.trim()}`}
            </div>
          </div>
        )}

        <div className="cart-section-head">
          <h2>Selected strategies</h2>
          <span className="meta">Click edit to revise inputs for any strategy.</span>
        </div>
        {CATEGORIES.map((cat) => {
          const list = results.per_strategy.filter((p) => p.meta.category === cat.id);
          if (list.length === 0) return null;
          return (
            <div key={cat.id} style={{ marginBottom: 16 }}>
              <div className="cat-section-head">
                <span
                  className="cat-section-ic"
                  style={{
                    background: `color-mix(in srgb, ${cat.cssColorVar} 14%, #fff)`,
                    color: cat.cssColorVar,
                  }}
                  aria-hidden="true"
                >
                  <CategoryIcon cat={cat.id} size={14} />
                </span>
                {cat.name} ({list.length})
              </div>
              <ul className="cart-line-list">
                {list.map((p) => {
                  const entry = basket.find((b) => b.id === p.id);
                  const basisLabel = purposePoolsLabel(
                    strategyPools(p.meta, entry?.values ?? {}),
                  );
                  const capPct = p.cap != null ? fmtCapPct(p.cap.capPct) : null;
                  const capTip = p.cap
                    ? `Limited by the ${CAP_TIER_LABEL[p.cap.tier] ?? "maximum"} (${capPct}%). See the Methodology page for how caps are set.`
                    : "This strategy's combined reduction was limited by a maximum. See the Methodology page for how the cap is set.";
                  return (
                  <li key={p.id} className="cart-line">
                    <div className="stripe" style={{ background: cat.cssColorVar }} />
                    <div className="content">
                      <div className="ln-head">
                        <span className="nm">{p.meta.displayName}</span>
                        {p.capped && (
                          <span
                            className="capped-tag"
                            style={{
                              fontSize: 10, color: "var(--cdot-orange-press)",
                              background: "#FFF1E8", padding: "2px 6px",
                              borderRadius: 2, fontWeight: 600,
                              display: "inline-flex", alignItems: "center", gap: 4,
                            }}
                          >
                            {capPct != null ? `CAPPED · max ${capPct}%` : "CAPPED"}
                            <a
                              className="info-i capped-info"
                              href="#/methodology"
                              data-tip={capTip}
                              aria-label={`Why is this capped? ${capTip}`}
                              style={{ width: 14, height: 14, fontSize: 10 }}
                            >
                              i
                            </a>
                          </span>
                        )}
                      </div>
                      <BasketInputs basket={basket} id={p.id} tazInputs={tazInputs} />
                    </div>
                    <div className="right">
                      {/* Sign follows the computed contribution (positive =
                          reduction, "−"); keep isInduced only for the warn tint
                          so capacity strategies stay visually flagged (CMT-06/08). */}
                      <div className={`contrib ${p.meta.isInduced ? "warn" : ""}`}>
                        {p.pct_vmt_reduction >= 0 ? "−" : "+"}
                        {(Math.abs(p.pct_vmt_reduction) * 100).toFixed(2)}
                        <span className="u">% VMT</span>
                      </div>
                      <div className="contrib-basis" style={{ fontSize: 11, color: "#6B6B6B", marginTop: 2 }}>
                        from {basisLabel}
                      </div>
                      <div className="ln-actions">
                        <button onClick={() => onEdit(p.id)}>Edit</button>
                        <button className="rm" onClick={() => onRemove(p.id)}>Remove</button>
                      </div>
                    </div>
                  </li>
                  );
                })}
              </ul>
            </div>
          );
        })}

        {results.overlap_warnings.length > 0 && (
          <div className="overlap-note">
            <h3>Potential overlaps</h3>
            <div className="sub">Review to avoid potential double counting.</div>
            <ul>
              {results.overlap_warnings.map((w) => (
                <li key={`${w.a}-${w.b}`}>
                  <b>{getStrategy(w.a).displayName}</b> and{" "}
                  <b>{getStrategy(w.b).displayName}</b> both act on{" "}
                  {purposePoolsLabel(w.pools)} via {w.mechanism.replace(/_/g, " ")}.
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <aside className="cart-side">
        <div className="card cart-breakdown">
          <h3 id="cart-breakdown-h">Reduction by category</h3>
          <table className="cat-table" aria-labelledby="cart-breakdown-h">
            <thead>
              <tr>
                <th scope="col"><span className="sr-only">Category icon</span></th>
                <th scope="col"><span className="sr-only">Category</span></th>
                <th scope="col" className="col-h">VMT</th>
              </tr>
            </thead>
            <tbody>
              {CATEGORIES.map((cat) => {
                const list = results.per_strategy.filter((p) => p.meta.category === cat.id);
                if (list.length === 0) return null;
                // Standalone per-category subtotal (matches each strategy's line
                // above). The multiplicative overlap/cap effect is shown as its
                // own "Multiplicative combination" row below, so the category
                // rows + that adjustment reconcile to the combined headline.
                const sumDelta = list.reduce((a, p) => a + p.daily_vmt_reduction, 0);
                const sumPct = results.baseline_vmt > 0 ? sumDelta / results.baseline_vmt : 0;
                const capped = list.some((p) => p.capped);
                return (
                  <tr key={cat.id} className={capped ? "capped" : ""}>
                    <td className="cat-ic-cell">
                      <span
                        className="cat-ic-badge"
                        style={{
                          background: `color-mix(in srgb, ${cat.cssColorVar} 14%, #fff)`,
                          color: cat.cssColorVar,
                        }}
                      >
                        <CategoryIcon cat={cat.id} size={12} />
                      </span>
                    </td>
                    <th scope="row" className="nm">
                      {cat.name} <span className="count">({list.length})</span>
                    </th>
                    <td className="v">
                      {sumPct >= 0 ? "−" : "+"}{(Math.abs(sumPct) * 100).toFixed(2)}%
                    </td>
                  </tr>
                );
              })}
              {hasCombinationAdjustment && (
                <tr className="cat-adjustment-row">
                  <td className="cat-ic-cell" aria-hidden="true" />
                  <th scope="row" className="nm">
                    Multiplicative combination{" "}
                    <span className="count">(overlap &amp; caps)</span>
                  </th>
                  <td className="v">
                    {combinationAdjustmentPct >= 0 ? "−" : "+"}
                    {(Math.abs(combinationAdjustmentPct) * 100).toFixed(2)}%
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card cart-cobenefits">
          <h3>Co-benefits</h3>
          <div className="co-row">
            <span className="nm">GHG avoided</span>
            <span className="v">{Math.round(ghgTonnes).toLocaleString()} metric tons/yr</span>
          </div>
          <div className="co-row">
            <span className="nm">Cars off-road equivalent</span>
            <span className="v">{Math.round(annualReduced / ANNUAL_VMT_PER_CAR).toLocaleString()}</span>
          </div>
        </div>

        <div className="card cart-actions">
          <h3>Export</h3>
          <button
            className="btn-primary"
            onClick={onExportPdf}
            disabled={basket.length === 0}
          >
            Export PDF report
          </button>
          <button
            className="btn-outline-ca"
            onClick={() =>
              downloadResultsCsv(basket, results, tazCount, tazInputs, {
                baselineVmtOverride,
                baselineVmtNote,
              })
            }
            disabled={basket.length === 0}
          >
            Download CSV
          </button>
        </div>
      </aside>
    </div>
  );
}

function BasketInputs({
  basket,
  id,
  tazInputs,
}: {
  basket: BasketEntry[];
  id: StrategyKey;
  tazInputs: TazInputs[];
}) {
  const entry = basket.find((b) => b.id === id);
  if (!entry) return null;
  const meta = getStrategy(id);
  // Source/justification notes the user entered for modified inputs (CMT-01).
  // inputNotes is only populated for still-modified, non-empty inputs.
  const notes = meta.inputs
    .map((inp) => {
      const text = entry.inputNotes?.[inp.key]?.trim();
      return text ? { label: inp.label, text } : null;
    })
    .filter((n): n is { label: string; text: string } => n !== null);
  // Project-context baseline overrides (transit share, AVO, density, parking
  // price, …) the user pinned for this strategy, plus their "why" narrative
  // (mirrors inputNotes but for data-derived baselines rather than inputs).
  // Map each overrideKey → its human label via the strategy's context rows.
  const overrideRows = deriveContextOverrides(entry, tazInputs);
  return (
    <>
      <div className="ln-params">
        {meta.inputs.map((inp) => {
          const v = entry.values[inp.key];
          const scale = inp.type === "slider" ? inp.scale ?? 1 : 1;
          const display = typeof v === "number" ? v * scale : v;
          const suffix =
            inp.type === "slider" ? inp.suffix ?? "" : inp.type === "number" ? ` ${inp.unit ?? ""}` : "";
          // Mark params the user changed from the seeded default for this area
          // (UI-06); derived from the basket entry's seed snapshot.
          const seeded = entry.seededDefaults?.[inp.key] ?? meta.defaults[inp.key];
          const modified = !isDefaultValue(v, seeded);
          return (
            <span key={inp.key} className={`param${modified ? " modified" : ""}`}>
              <span className="k">{inp.label}:</span>{" "}
              <span className="v">
                {typeof display === "number"
                  ? display.toLocaleString(undefined, { maximumFractionDigits: 2 })
                  : display}
                {suffix}
              </span>
              {modified && (
                <span className="param-mod" title="Changed from default"> ·&nbsp;modified</span>
              )}
            </span>
          );
        })}
      </div>
      {notes.length > 0 && (
        <div className="ln-justify">
          <div className="ln-justify-h">Justification for changed inputs</div>
          {notes.map((n) => (
            <div className="ln-justify-row" key={n.label}>
              <span className="k">{n.label}:</span> <span className="t">{n.text}</span>
            </div>
          ))}
        </div>
      )}
      {overrideRows.length > 0 && (
        <div className="ln-justify ln-overrides">
          <div className="ln-justify-h">Project context overrides</div>
          {overrideRows.map((o) => (
            <div className="ln-justify-row" key={o.key}>
              <span className="k">{o.label}:</span>{" "}
              <span className="v">{o.value}</span>
              {o.note && <span className="t"> — {o.note}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Build the list of project-context baseline overrides the user pinned on a
 * basket entry, each resolved to its human label + display-unit value via the
 * strategy's context rows (so an overrideKey like "transit_mode_share" becomes
 * "Current transit commute share" and a fraction becomes "12.3%"). Returns []
 * when the entry carries no overrides. `note` is the optional "why" narrative.
 */
function deriveContextOverrides(
  entry: BasketEntry,
  tazInputs: TazInputs[],
): { key: string; label: string; value: string; note?: string }[] {
  const overrides = entry.contextOverrides;
  if (!overrides || Object.keys(overrides).length === 0) return [];
  // Label lookup: the context rows tag each override with the row's label.
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
