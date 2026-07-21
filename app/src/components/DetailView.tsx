// Strategy detail / configure view. Wires each StrategyMeta input control to
// the working values dict and shows live-computed impact across the selected
// TAZs as the user adjusts inputs. Long-form content (extended description,
// methodology, per-input instructions) comes from the strategy catalog and is
// rendered as Markdown.
//
// Layout (redesign): a two-column workspace inside `.shop-detail`. The workflow
// flows down the left column (hero → applicability → what you'll need →
// configure → commit bar → methodology) while a sticky right rail holds the
// live-impact card and the project-context card. Collapses to a single column
// (rail last) below ~980px. See app/src/styles/shop.css `.detail-grid` etc.

import { useMemo, useState } from "react";
import {
  CATEGORIES,
  getStrategy,
  type StrategyCategory,
  type StrategyInput,
  type StrategyMeta,
} from "../strategies/registry";
import { CATALOG, areaTypeLabel } from "../strategies/catalog";
import { type StrategyKey } from "../strategies/strategies";
import { computeStrategyRows } from "../strategies/compute";
import {
  getStrategyContext,
  OVERRIDE_FORMATTERS,
  type ContextRow,
} from "../strategies/context";
import { isDefaultValue } from "../strategies/defaults";
import type { TazInputs } from "../strategies/types";
import { CategoryIcon } from "./CategoryIcon";
import { Markdown } from "./Markdown";

interface DetailViewProps {
  strategyId: StrategyKey;
  values: Record<string, number | string>;
  setValues: (
    update: (prev: Record<string, number | string>) => Record<string, number | string>,
  ) => void;
  /** Per-input "source / justification" notes draft (CMT-01), keyed by input key. */
  notes: Record<string, string>;
  setNotes: (
    update: (prev: Record<string, string>) => Record<string, string>,
  ) => void;
  /** Per-strategy "Project context" overrides draft, keyed by ContextRow.
      overrideKey, in the variable's NATIVE units (fractions for mode share,
      dollars for parking price, etc.). Feeds getStrategyContext so overridden
      rows display the overridden value. */
  contextOverrides: Record<string, number>;
  setContextOverrides: (
    update: (prev: Record<string, number>) => Record<string, number>,
  ) => void;
  /** Per-override free-text "why" narrative draft, keyed by the same overrideKey. */
  contextNotes: Record<string, string>;
  setContextNotes: (
    update: (prev: Record<string, string>) => Record<string, string>,
  ) => void;
  /** System-default seed for this strategy (catalog + TAZ-derived defaults).
      An input is flagged "modified" when its value differs from this. */
  seededDefaults: Record<string, number | string>;
  inBasket: boolean;
  tazInputs: TazInputs[];
  baselineVmt: number;
  /** Project-level baseline daily-VMT override (null = use the derived sum).
      Mirrors computeResults: DetailView scales each TAZ's daily_vmt by
      baselineVmtOverride / derivedBaseline so context rows + the live impact
      preview reflect the same baseline the aggregate results do. */
  baselineVmtOverride: number | null;
  onBack: () => void;
  /** Open the map overlay (the "Choose a project area" affordance). */
  onPickArea: () => void;
  onAdd: () => void;
  onRemove: () => void;
}

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** First strategy image, else the category image, else null (→ glyph). */
function heroImage(
  meta: StrategyMeta,
  cat: StrategyCategory | undefined,
): { src: string; alt: string } | null {
  const base = import.meta.env.BASE_URL;
  if (meta.images && meta.images.length > 0) {
    const img = meta.images[0];
    return { src: `${base}catalog-images/${img.file}`, alt: img.alt };
  }
  if (cat?.image) return { src: `${base}catalog-images/${cat.image}`, alt: cat.name };
  return null;
}

/** Classify aggregate activity density against the catalog's thresholds. */
function classifyAreaType(activityDensity: number): string {
  const thresholds = CATALOG.area_type_thresholds;
  let best = "rural";
  let bestThreshold = -Infinity;
  for (const [name, th] of Object.entries(thresholds)) {
    if (activityDensity >= th && th >= bestThreshold) {
      best = name;
      bestThreshold = th;
    }
  }
  return best;
}

/**
 * Evaluate a strategy's `applicability` against the selected TAZ aggregate.
 * Returns a warning when the project area doesn't meet the thresholds. No-op
 * (ok) when the strategy declares no applicability constraints.
 */
function checkApplicability(
  meta: StrategyMeta,
  tazInputs: TazInputs[],
): { ok: true } | { ok: false; message: string } {
  const a = meta.applicability;
  if (!a || tazInputs.length === 0) return { ok: true };
  const hasConstraint =
    a.min_pop_density != null ||
    a.min_emp_density != null ||
    a.min_activity_density != null ||
    (a.area_types?.length ?? 0) > 0;
  if (!hasConstraint) return { ok: true };

  let pop = 0;
  let emp = 0;
  let area = 0;
  for (const t of tazInputs) {
    if (finite(t.population)) pop += t.population;
    if (finite(t.employment)) emp += t.employment;
    if (finite(t.area_sqmi)) area += t.area_sqmi;
  }
  const popD = area > 0 ? pop / area : 0;
  const empD = area > 0 ? emp / area : 0;
  const actD = area > 0 ? (pop + emp) / area : 0;

  const reasons: string[] = [];
  if (a.min_pop_density != null && popD < a.min_pop_density)
    reasons.push(`population density ${Math.round(popD).toLocaleString()} < ${a.min_pop_density.toLocaleString()}/sq mi`);
  if (a.min_emp_density != null && empD < a.min_emp_density)
    reasons.push(`employment density ${Math.round(empD).toLocaleString()} < ${a.min_emp_density.toLocaleString()}/sq mi`);
  if (a.min_activity_density != null && actD < a.min_activity_density)
    reasons.push(`activity density ${Math.round(actD).toLocaleString()} < ${a.min_activity_density.toLocaleString()}/sq mi`);
  if (a.area_types && a.area_types.length > 0) {
    const at = classifyAreaType(actD);
    if (!a.area_types.includes(at))
      reasons.push(`area type "${at.replace("_", " ")}" is outside ${a.area_types.map((x) => x.replace("_", " ")).join(", ")}`);
  }

  if (reasons.length === 0) return { ok: true };
  const detail = `Your selected area: ${reasons.join("; ")}.`;
  return { ok: false, message: a.warn_message ? `${a.warn_message} ${detail}` : detail };
}

/** A resource link rendered as a bordered "↗ label" button (opens a new tab). */
function ResourceLink({
  label,
  url,
  small = false,
}: {
  label: string;
  url: string;
  small?: boolean;
}) {
  return (
    <a
      className={`resource-link${small ? " sm" : ""}`}
      href={url}
      target="_blank"
      rel="noopener"
    >
      <span aria-hidden="true">↗</span> {label}
    </a>
  );
}

export function DetailView({
  strategyId,
  values,
  setValues,
  notes,
  setNotes,
  contextOverrides,
  setContextOverrides,
  contextNotes,
  setContextNotes,
  seededDefaults,
  inBasket,
  tazInputs,
  baselineVmt,
  baselineVmtOverride,
  onBack,
  onPickArea,
  onAdd,
  onRemove,
}: DetailViewProps) {
  const meta = getStrategy(strategyId);
  const cat = CATEGORIES.find((c) => c.id === meta.category);
  const hero = heroImage(meta, cat);

  // With no project area selected there's nothing to compute against (baseline
  // VMT is 0), so adjusting inputs does nothing. Rather than let the controls
  // read as broken, disable every value-affecting control (and the per-input
  // reset + note capture) and explain why. The rest of the page stays browsable.
  const noArea = tazInputs.length === 0;

  // Overrides are honored by every strategy now (both the DSL evaluator and the
  // hand-written aggregate calc route context overrides into the math), so the
  // affordance is offered on any context row that maps to a per-TAZ variable
  // (i.e. carries an overrideKey). The former meta.compute gate is gone.

  // Project-level baseline VMT override: computeResults uniformly scales each
  // TAZ's daily_vmt by (override / derivedBaseline) before any strategy math.
  // Mirror that here so EVERY DetailView display (context rows derived from
  // daily_vmt, the impact %, and the annual reduction) reflects the same
  // baseline the aggregate results do. When no override applies, factor === 1
  // and scaledTazInputs is the input array unchanged (no-op).
  const scaledTazInputs = useMemo<TazInputs[]>(() => {
    const derivedBaseline = tazInputs.reduce(
      (acc, t) => acc + (Number.isFinite(t.daily_vmt) ? t.daily_vmt : 0),
      0,
    );
    const factor =
      baselineVmtOverride != null &&
      Number.isFinite(baselineVmtOverride) &&
      baselineVmtOverride > 0 &&
      derivedBaseline > 0
        ? baselineVmtOverride / derivedBaseline
        : 1;
    if (factor === 1) return tazInputs;
    return tazInputs.map((t) => ({
      ...t,
      daily_vmt: (Number.isFinite(t.daily_vmt) ? t.daily_vmt : 0) * factor,
    }));
  }, [tazInputs, baselineVmtOverride]);

  // Pass the working overrides so overridden rows render the overridden value
  // (reformatted) and carry `overridden: true`, regardless of how the strategy
  // computes. scaledTazInputs (not the raw tazInputs) so daily_vmt-derived rows
  // (e.g. "Commute VMT base") reflect the project baseline override.
  const contextRows = useMemo<ContextRow[]>(
    () =>
      getStrategyContext(strategyId, scaledTazInputs, values, contextOverrides),
    [strategyId, scaledTazInputs, values, contextOverrides],
  );

  const applicability = useMemo(
    () => checkApplicability(meta, tazInputs),
    [meta, tazInputs],
  );

  // Live recompute against the currently selected TAZs (uncapped preview),
  // via the same dispatch the results panel uses (DSL / aggregate / registry).
  // Uses scaledTazInputs so the preview's % and absolute reduction reflect the
  // project baseline override, consistent with computeResults and the context.
  const { pctReduction, dailyReduction } = useMemo(() => {
    let totalDelta = 0;
    let totalBase = 0;
    for (const row of computeStrategyRows(strategyId, values, scaledTazInputs)) {
      totalDelta += row.daily_vmt_reduction;
      totalBase += row.base_vmt;
    }
    const pct = totalBase > 0 ? totalDelta / totalBase : 0;
    return { pctReduction: pct, dailyReduction: totalDelta };
  }, [strategyId, scaledTazInputs, values]);

  const annualReduction = dailyReduction * 365;
  // Drive direction from the COMPUTED value, not the static isInduced flag, so a
  // "wrong-direction" input (a density cut, a service-frequency reduction, a
  // road diet's negative lane miles) reads correctly: dailyReduction/pctReduction
  // are signed positive = reduction, negative = increase (CMT-06/08).
  const isReduction = dailyReduction >= 0;
  const directionSign = isReduction ? "−" : "+";
  const directionLabel = isReduction ? "reduced" : "added";
  // Shared, formatted impact values: the live-impact rail card and the commit
  // bar both mirror these so committing reads as the payoff of configuring.
  const signedPct = `${directionSign}${Math.abs(pctReduction * 100).toFixed(2)}%`;
  const impactColor = isReduction ? "#245D39" : "#A55200";
  const annualM = (Math.abs(annualReduction) / 1e6).toFixed(2);
  const baselineM = ((baselineVmt * 365) / 1e6).toFixed(1);
  const tazCount = tazInputs.length;
  const tazPlural = tazCount === 1 ? "" : "s";

  // "What you'll need": the prerequisite inputs the user must gather ahead of
  // time. Hidden entirely when the strategy has none (graceful degradation).
  const prerequisiteInputs = meta.inputs.filter((i) => i.prerequisite);

  // Reassurance strip: prefer the authored auto-filled summary, else derive a
  // friendly list from the project-context row labels.
  const autoFilled =
    meta.autoFilledSummary && meta.autoFilledSummary.length > 0
      ? meta.autoFilledSummary
      : contextRows.map((r) => r.label.toLowerCase());
  // Sentence-case the reassurance line: derived context labels are lower-cased
  // above (and authored summaries vary), so capitalize the first letter so the
  // sentence never starts lowercase.
  const autoFilledJoined = joinWithAnd(autoFilled);
  const autoFilledPhrase =
    autoFilledJoined.charAt(0).toUpperCase() + autoFilledJoined.slice(1);

  const areaTypes = meta.applicability?.area_types ?? [];

  // Plain-language explanation of the "subsector cap" term, reused by the hero
  // pill's info cue and the Methodology accordion so the copy stays in sync.
  const capExplanation = cat
    ? `The most combined VMT reduction creditable across all strategies in this subsector (${cat.name}). Because these strategies affect overlapping trips, their combined effect is capped to prevent double-counting (per CAPCOA).`
    : "";

  return (
    <div className="shop-detail">
      <button className="detail-back" onClick={onBack}>← Back to strategies</button>

      <div className="detail-grid">
        {/* ───────────────────── MAIN COLUMN ───────────────────── */}
        <div className="detail-main">
          {/* HERO
              The band panel FLOATS left (see shop.css `.band-panel`) and the
              title + short description + extended description are normal-flow
              siblings after it, so the whole hero reads as one continuous text
              column that sits beside the panel and wraps full-width beneath it
              once it outruns the panel's height — no dead gap next to the panel
              for strategies whose title+short-desc don't fill it. `.dhero` is a
              flow-root so it contains the float. Below ~980px the float drops
              and the panel goes full-width on top (shop.css media query). */}
          <div className="dhero">
            <div
              className={`band-panel${hero ? " has-img" : ""}`}
              style={{ background: cat?.cssColorVar }}
            >
              {/* Imagery clip layer. The photo cover and the glyph watermark
                  bleed off the panel edges, so they live inside this inner
                  wrapper (absolute, inset 0, overflow: hidden, corners rounded
                  to match the panel) which does the clipping. The panel itself
                  is overflow: visible so the cap tooltip can escape it. This
                  layer sits behind the text (z-index 0). */}
              <div className="band-clip">
                {/* A real photo fills the band as a cover layer under a
                    dark-blue scrim (keeps the white SKU/category/cap text AA). */}
                {hero && (
                  <div
                    className="band-img"
                    role="img"
                    aria-label={hero.alt}
                    style={{ backgroundImage: `url("${hero.src}")` }}
                  />
                )}
                {/* Glyph fallback: no image → the category glyph sits as a
                    subtle, oversized watermark tucked into the panel's
                    bottom-right corner (low opacity), so the panel reads as a
                    branded SKU chip with tasteful imagery rather than a big
                    floating icon in empty space. */}
                {!hero && (
                  <div className="band-glyph" aria-hidden="true">
                    <CategoryIcon cat={meta.category} size={96} />
                  </div>
                )}
              </div>
              <div className="band-top">
                {meta.uid && <div className="sku">{meta.uid}</div>}
                {cat?.name && <div className="cat-name">{cat.name}</div>}
              </div>
              {cat?.cap != null && (
                <div className="cap-pill">
                  {cat.cap}% subsector cap
                  {/* Info cue: the standard styled `.info-i` tooltip, fed via
                      `data-tip`. The .band-panel is now overflow: visible (the
                      bled-off imagery is clipped by the inner .band-clip
                      instead), so this bubble is no longer cut off. aria-label
                      carries the same copy for screen readers; the native
                      `title` stays as a plain fallback. */}
                  <button
                    type="button"
                    className="info-i cap-info"
                    data-tip={capExplanation}
                    title={capExplanation}
                    aria-label={`What is a subsector cap? ${capExplanation}`}
                  >
                    i
                  </button>
                </div>
              )}
            </div>
            <div className="dhero-body">
              <h1>{meta.displayName}</h1>
              <div className="desc">{meta.description}</div>
              {meta.extendedDescription && (
                <Markdown className="md-prose dhero-about">
                  {meta.extendedDescription}
                </Markdown>
              )}
            </div>
            {meta.images && meta.images.length > 0 && (
              <div className="strategy-figs">
                {meta.images.map((img) => (
                  <figure key={img.file}>
                    <img
                      src={`${import.meta.env.BASE_URL}catalog-images/${img.file}`}
                      alt={img.alt}
                    />
                    {(img.caption || img.credit) && (
                      <figcaption>
                        {img.caption}
                        {img.credit && <span className="credit"> {img.credit}</span>}
                      </figcaption>
                    )}
                  </figure>
                ))}
              </div>
            )}
          </div>

          {/* APPLICABILITY (absorbs Guidance) */}
          {(areaTypes.length > 0 ||
            !applicability.ok ||
            meta.guidance) && (
            <div className="dsection applicability-section">
              <h3>Applicability</h3>
              <div className="section-sub">
                Where this strategy fits.
              </div>

              {areaTypes.length > 0 && (
                <div className="applic-context">
                  <span className="overline">Recommended context</span>
                  {areaTypes.map((at) => (
                    <span key={at} className="context-chip">
                      {areaTypeLabel(at)}
                    </span>
                  ))}
                </div>
              )}

              {/* Orange warning callout: shown ONLY when the current TAZ
                  selection is a real context mismatch (checkApplicability
                  returns a warning). No live mismatch → no callout; the static
                  `warn_message` is NOT shown as an always-on note. */}
              {!applicability.ok && (
                <div className="applic-warn" role="status">
                  <span className="ic" aria-hidden="true">!</span>
                  <div>
                    <b>Limited applicability for this area.</b>{" "}
                    {applicability.message} This strategy may estimate little or
                    no VMT effect (≈0) where an area doesn&rsquo;t meet its
                    applicability thresholds; a near-zero result reflects the
                    area, not a calculation error.
                  </div>
                </div>
              )}

              {meta.guidance && (
                <div className="applic-guidance">
                  <div className="overline">When to use this strategy</div>
                  <Markdown className="md-prose applic-guidance-body">
                    {meta.guidance}
                  </Markdown>
                </div>
              )}
            </div>
          )}

          {/* WHAT YOU'LL NEED */}
          {prerequisiteInputs.length > 0 && (
            <div className="dsection whatyouneed-section">
              <h3>What you&rsquo;ll need</h3>
              <div className="section-sub">
                Gather {prerequisiteInputs.length === 1 ? "this input" : "these inputs"} before you
                configure. Finding {prerequisiteInputs.length === 1 ? "it" : "them"} is usually the
                most time-consuming step.
              </div>

              <ol className="wyn-list">
                {prerequisiteInputs.map((inp, i) => (
                  <li className="wyn-item" key={inp.key}>
                    <span className="wyn-badge" aria-hidden="true">{i + 1}</span>
                    <div className="wyn-body">
                      <div className="wyn-head">
                        <span className="wyn-label">{inp.label}</span>
                        <span className="wyn-chip">Prerequisite</span>
                      </div>
                      {inp.summary && <div className="wyn-summary">{inp.summary}</div>}
                      {inp.resources && inp.resources.length > 0 ? (
                        <div className="wyn-links">
                          {inp.resources.map((r) => (
                            <ResourceLink key={r.url} label={r.label} url={r.url} />
                          ))}
                        </div>
                      ) : (
                        inp.sourceNote && (
                          <div className="wyn-source">Source: {inp.sourceNote}</div>
                        )
                      )}
                    </div>
                  </li>
                ))}
              </ol>

              {autoFilled.length > 0 && (
                <div className="wyn-reassure">
                  <span className="ic" aria-hidden="true">✓</span>
                  <div>
                    {autoFilledPhrase}{" "}
                    {autoFilled.length === 1 ? "is" : "are"} filled in
                    automatically from the TAZs you selected, no lookup needed.
                    See <b>Project context</b> at right.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* CONFIGURE */}
          <div className={`dsection configure-section${noArea ? " is-disabled" : ""}`}>
            <h3>Configure</h3>
            {noArea && (
              <div className="configure-hint" role="status">
                <span className="ic" aria-hidden="true">i</span>
                <div>
                  <b>Select a project area first</b> to adjust these inputs and
                  calculate results. You can still read through everything below.{" "}
                  <button
                    type="button"
                    className="configure-hint-link"
                    onClick={onPickArea}
                  >
                    Choose a project area →
                  </button>
                </div>
              </div>
            )}
            <div className="inputs-grid">
              {meta.inputs.map((inp) => {
                const seeded = seededDefaults[inp.key] ?? meta.defaults[inp.key];
                return (
                  <InputControl
                    key={inp.key}
                    input={inp}
                    value={values[inp.key] ?? meta.defaults[inp.key]}
                    seededDefault={seeded}
                    note={notes[inp.key] ?? ""}
                    disabled={noArea}
                    onChange={(v) =>
                      setValues((prev) => ({ ...prev, [inp.key]: v }))
                    }
                    onNoteChange={(text) =>
                      setNotes((prev) => ({ ...prev, [inp.key]: text }))
                    }
                    onReset={
                      seeded === undefined
                        ? undefined
                        : () => setValues((prev) => ({ ...prev, [inp.key]: seeded }))
                    }
                  />
                );
              })}
            </div>
          </div>

          {/* COMMIT BAR: live impact echo + primary add/update action.
              Sits below Configure and above Methodology (the redesign's commit
              point). Left echoes the same computed values shown in the rail. */}
          <div className="commit-bar">
            <div className="commit-impact">
              <div className="overline">Estimated impact at your settings</div>
              <div className="commit-figure">
                <span className="commit-pct" style={{ color: impactColor }}>
                  {signedPct}
                </span>
                <span className="commit-caption">
                  VMT · {annualM} million mi/yr {directionLabel}
                </span>
              </div>
            </div>
            <div className="commit-actions">
              <div className="commit-buttons">
                {inBasket && (
                  <button className="btn-rm" onClick={onRemove}>
                    Remove
                  </button>
                )}
                <button
                  className={`btn-add ${inBasket ? "added" : ""}`}
                  onClick={onAdd}
                >
                  {inBasket ? "Update selection" : "Add to package →"}
                </button>
              </div>
              <span className="commit-help">
                You can adjust the inputs again after adding.
              </span>
            </div>
          </div>

          {/* METHODOLOGY */}
          <details className="dsection methodology-accordion">
            <summary>
              <h3>Methodology</h3>
              <span className="acc-toggle" aria-hidden="true">
                <span className="acc-toggle-label"></span>
                <span className="acc-chevron">⌄</span>
              </span>
            </summary>
            <div className="methodology-body">
              <div className="method-meta">
                <div><b>Method:</b> {meta.method}</div>
                <div>
                  <b>Subsector cap:</b>{" "}
                  {cat?.cap ? `${cat.cap}% combined for ${cat.name}` : "n/a"}
                  {cat?.cap != null && (
                    <i
                      className="info-i"
                      data-tip={capExplanation}
                      aria-hidden="true"
                    >
                      i
                    </i>
                  )}
                </div>
              </div>
              {meta.methodologyDetail && (
                <Markdown className="md-prose">{meta.methodologyDetail}</Markdown>
              )}
              <div className="formula-box">{meta.formula}</div>
            </div>
          </details>
        </div>

        {/* ───────────────────── STICKY RIGHT RAIL ───────────────────── */}
        <div className="detail-rail">
          {/* LIVE IMPACT */}
          <div className="rail-card impact-card">
            <div className="overline">At your settings</div>
            <div className="impact-big" style={{ color: impactColor }}>
              {signedPct}
            </div>
            <div className="impact-sub">
              VMT · {tazCount} TAZ{tazPlural} selected
            </div>
            <div className="impact-divider">
              <div className="overline">Annual VMT {directionLabel}</div>
              <div className="impact-annual">
                {annualM}
                <span className="u">million mi/yr</span>
              </div>
              <div className="impact-baseline">of {baselineM} million mi/yr baseline</div>
            </div>
          </div>

          {/* PROJECT CONTEXT */}
          {contextRows.length > 0 && (
            <div className="rail-card ctx-card">
              <div className="overline ctx-title">Project context</div>
              <div className="ctx-sub">
                Drawn from your {tazCount} selected TAZ{tazPlural}; these
                baseline values feed the calculation.
              </div>
              <div className="ctx-list">
                {contextRows.map((row, i) => (
                  <ContextRowItem
                    key={`${row.label}-${i}`}
                    row={row}
                    // Offer the override affordance on any row that maps to a
                    // per-TAZ variable (has an overrideKey); the calc honors it
                    // for every strategy. Rows without a key render read-only.
                    overridable={!!row.overrideKey}
                    disabled={noArea}
                    // Current override in NATIVE units (undefined = none set),
                    // so the edit box can seed from the actual override value.
                    overrideNative={
                      row.overrideKey ? contextOverrides[row.overrideKey] : undefined
                    }
                    note={row.overrideKey ? contextNotes[row.overrideKey] ?? "" : ""}
                    onOverride={(native) => {
                      const key = row.overrideKey;
                      if (!key) return;
                      setContextOverrides((prev) => ({ ...prev, [key]: native }));
                    }}
                    onNoteChange={(text) => {
                      const key = row.overrideKey;
                      if (!key) return;
                      setContextNotes((prev) => ({ ...prev, [key]: text }));
                    }}
                    onReset={() => {
                      const key = row.overrideKey;
                      if (!key) return;
                      setContextOverrides((prev) => {
                        const next = { ...prev };
                        delete next[key];
                        return next;
                      });
                      setContextNotes((prev) => {
                        const next = { ...prev };
                        delete next[key];
                        return next;
                      });
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Per-strategy project-context override affordance ──────────────────
//
// Overrides are stored in the variable's NATIVE units (the same units dslRow
// feeds the calc): mode shares are FRACTIONS 0..1, avo is a plain number,
// parking_price is dollars, pop/emp density are per-sq-mi numbers. The user
// edits in DISPLAY units (mode share as a percent, the rest 1:1), so we convert
// display↔native here. Getting this wrong silently corrupts the calc, so the
// conversion is centralized in ONE place per overrideKey.

/** Which overrideKeys are fractions shown as a percent (native = %/100). */
const PERCENT_OVERRIDE_KEYS = new Set([
  "transit_mode_share",
  "auto_mode_share",
  "bike_mode_share",
  "walk_mode_share",
  // Newer overridable rows. Native value is a fraction 0..1; edited as a percent.
  "r_ctr", // TMO per-eligible reduction (e.g. 0.04 → "4%")
  "max_tod_transit_share", // TOD transit-share ceiling (e.g. 0.50 → "50%")
  "trip_red_ratio", // transit trip-reduction ratio (e.g. 0.7 → "70%")
  "adj", // bike-share boost (e.g. 0.15 → "15%")
  "vmt_share_commute", // commute purpose split (e.g. 0.30 → "30%")
]);

/** Native (calc) value → the number shown in the edit box (display units). */
function nativeToDisplay(overrideKey: string, native: number): number {
  return PERCENT_OVERRIDE_KEYS.has(overrideKey) ? native * 100 : native;
}

/** The number the user typed (display units) → native (calc) value. */
function displayToNative(overrideKey: string, display: number): number {
  return PERCENT_OVERRIDE_KEYS.has(overrideKey) ? display / 100 : display;
}

/** Unit label + step + min/max for the override edit box, keyed by overrideKey. */
function overrideEditMeta(overrideKey: string): {
  unit: string;
  step: number;
  min?: number;
  max?: number;
} {
  switch (overrideKey) {
    // Percent keys with per-key step/min/max (all display as "%", native 0..1).
    case "r_ctr": // TMO per-eligible reduction
      return { unit: "%", step: 0.5, min: 0, max: 50 };
    case "max_tod_transit_share": // TOD transit-share ceiling
      return { unit: "%", step: 1, min: 0, max: 100 };
    case "trip_red_ratio": // transit trip-reduction ratio
      return { unit: "%", step: 1, min: 0, max: 100 };
    case "adj": // bike-share boost
      return { unit: "%", step: 0.5, min: 0, max: 50 };
    case "vmt_share_commute": // commute purpose split
      return { unit: "%", step: 1, min: 0, max: 100 };
    // Miles keys (native = miles, 1:1).
    case "bike_len": // bike trip length
      return { unit: "mi", step: 0.1, min: 0.1, max: 10 };
    case "avg_trip_length": // avg vehicle trip length
      return { unit: "mi", step: 0.5, min: 0.5, max: 50 };
    // Dollars key (native = dollars, 1:1).
    case "avg_fare": // avg transit fare
      return { unit: "$ / trip", step: 0.25, min: 0, max: 20 };
    case "avo":
      return { unit: "persons / vehicle", step: 0.01, min: 1 };
    case "parking_price":
      return { unit: "$ / day", step: 0.25, min: 0 };
    case "pop_density":
      return { unit: "ppl / sq mi", step: 1, min: 0 };
    case "emp_density":
      return { unit: "jobs / sq mi", step: 1, min: 0 };
    default:
      // Fallback for the original mode-share percent keys.
      if (PERCENT_OVERRIDE_KEYS.has(overrideKey)) {
        return { unit: "%", step: 0.1, min: 0, max: 100 };
      }
      return { unit: "", step: 1 };
  }
}

/**
 * A single "Project context" row. Read-only unless `overridable` (the row maps
 * to a per-TAZ variable via its overrideKey), in which case a subtle pencil
 * affordance opens an inline override editor: a value box (in display units) +
 * a strongly-encouraged "why" narrative. The value stored via onOverride is
 * always in NATIVE units.
 */
function ContextRowItem({
  row,
  overridable,
  disabled,
  overrideNative,
  note,
  onOverride,
  onNoteChange,
  onReset,
}: {
  row: ContextRow;
  overridable: boolean;
  disabled: boolean;
  /** Current override in NATIVE units, or undefined when none is set. */
  overrideNative: number | undefined;
  note: string;
  /** Store an override (value already converted to NATIVE units). */
  onOverride: (native: number) => void;
  onNoteChange: (text: string) => void;
  onReset: () => void;
}) {
  const isOverridden = !!row.overridden;
  // The editor opens automatically for an already-overridden row (so editing an
  // existing override is one glance), or when the user clicks "Override".
  const [open, setOpen] = useState(isOverridden);

  // rawValue is always the un-overridden data baseline (getStrategyContext
  // leaves it unchanged), so it drives the "Area baseline" hint + reset target.
  const key = row.overrideKey ?? "";
  const baselineNative = row.rawValue ?? 0;
  // Seed the edit box from the CURRENT override when one is set, else the
  // baseline; converted to display units. Kept as a string so the field can be
  // cleared while typing.
  const seedNative =
    typeof overrideNative === "number" && Number.isFinite(overrideNative)
      ? overrideNative
      : baselineNative;
  const seedDisplay = key ? nativeToDisplay(key, seedNative) : seedNative;
  const [draft, setDraft] = useState<string>(() =>
    formatDisplayNumber(seedDisplay),
  );

  // A plain (non-overridable) row keeps the exact prior markup.
  if (!overridable || !row.overrideKey) {
    return (
      <div className={`ctx-item ${row.unavailable ? "unavailable" : ""}`}>
        <div className="ctx-label">{row.label}</div>
        <div className="ctx-value">
          {row.value}
          {row.unit && <span className="ctx-unit">{row.unit}</span>}
        </div>
        {row.projected && <div className="ctx-projected">→ {row.projected}</div>}
        {row.source && <div className="ctx-source">{row.source}</div>}
      </div>
    );
  }

  const meta = overrideEditMeta(key);
  const editId = `ctx-ov-${key}`;
  const noteId = `ctx-ov-note-${key}`;
  const missingNarrative = isOverridden && note.trim().length === 0;

  function commitDraft(raw: string) {
    setDraft(raw);
    if (raw.trim() === "") return; // don't store an empty/NaN override mid-edit
    const display = Number(raw);
    if (!Number.isFinite(display)) return;
    onOverride(displayToNative(key, display));
  }

  function handleReset() {
    onReset();
    setDraft(formatDisplayNumber(nativeToDisplay(key, baselineNative)));
    setOpen(false);
  }

  return (
    <div
      className={`ctx-item ctx-item-ov${isOverridden ? " is-overridden" : ""}${
        row.unavailable ? " unavailable" : ""
      }`}
    >
      <div className="ctx-label">
        {row.label}
        {isOverridden && <span className="ctx-ov-chip">Modified</span>}
      </div>
      <div className="ctx-value">
        {row.value}
        {row.unit && <span className="ctx-unit">{row.unit}</span>}
      </div>
      {row.projected && <div className="ctx-projected">→ {row.projected}</div>}
      {row.source && <div className="ctx-source">{row.source}</div>}

      {/* Override affordance: a small, quiet pencil icon in the row's top-right
          (labelled for AT), or (when open) the value box + narrative. The rail
          value above already reflects the override via getStrategyContext. */}
      {!open ? (
        <button
          type="button"
          className="ctx-ov-trigger"
          onClick={() => setOpen(true)}
          disabled={disabled}
          aria-label={`Override ${row.label} for this project`}
          title="Override this value"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M11.5 1.8a1.4 1.4 0 0 1 2 2L5 12.3l-2.7.7.7-2.7 8.5-8.5Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : (
        <div className="ctx-ov-edit">
          <label htmlFor={editId} className="ctx-ov-edit-label">
            Project-specific value
          </label>
          <div className="ctx-ov-field">
            <input
              id={editId}
              type="number"
              className="ctx-ov-input"
              value={draft}
              step={meta.step}
              min={meta.min}
              max={meta.max}
              disabled={disabled}
              onChange={(e) => commitDraft(e.target.value)}
            />
            {meta.unit && <span className="ctx-ov-unit">{meta.unit}</span>}
          </div>
          {/* Baseline reminder, formatted exactly like the rail value via the
              shared OVERRIDE_FORMATTERS so display stays consistent. */}
          <div className="ctx-ov-baseline">
            Area baseline:{" "}
            {(OVERRIDE_FORMATTERS[key] ?? String)(baselineNative)}
          </div>

          <label htmlFor={noteId} className="ctx-ov-note-label">
            Why are you overriding this?
          </label>
          <textarea
            id={noteId}
            className="ctx-ov-note"
            rows={2}
            placeholder="e.g. based on a new subdivision currently under development, or a recent local survey"
            value={note}
            disabled={disabled}
            onChange={(e) => onNoteChange(e.target.value)}
          />
          {missingNarrative && (
            <div className="ctx-ov-warn" role="status">
              Add a short justification so this override is defensible in a grant
              application.
            </div>
          )}

          <div className="ctx-ov-actions">
            {isOverridden ? (
              <button
                type="button"
                className="ctx-ov-reset"
                onClick={handleReset}
                disabled={disabled}
              >
                Reset to baseline
              </button>
            ) : (
              <button
                type="button"
                className="ctx-ov-cancel"
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Format a display-units number for the edit box seed: trim float noise but
    keep meaningful precision (mode-share percents, avo, parking dollars). */
function formatDisplayNumber(n: number): string {
  if (!Number.isFinite(n)) return "";
  // Round to 4 decimals then drop trailing zeros so "12.3000001" → "12.3".
  return String(Math.round(n * 1e4) / 1e4);
}

/** Join a short list into an English phrase: "a", "a and b", "a, b, and c". */
function joinWithAnd(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function InputControl({
  input,
  value,
  seededDefault,
  note,
  disabled = false,
  onChange,
  onNoteChange,
  onReset,
}: {
  input: StrategyInput;
  value: number | string;
  /** The system-default seed for this input (undefined if none seeded). */
  seededDefault: number | string | undefined;
  /** Current "source / justification" note for this input (CMT-01). */
  note: string;
  /** No project area selected: disable all value-affecting controls (and the
      reset + note capture) since there's nothing to compute against. */
  disabled?: boolean;
  onChange: (v: number | string) => void;
  /** Update the source/justification note for this input. */
  onNoteChange: (text: string) => void;
  /** Restore the seeded default. Undefined when there's no seed to restore to. */
  onReset?: () => void;
}) {
  // Associate each control with its visible label (and give it a stable id) so
  // it has an accessible name for screen readers and label-click focusing.
  const inputId = `inp-${input.key}`;
  const noteId = `note-${input.key}`;

  // Provenance: has the user changed this input away from the system default
  // for this project area? Drives the "Modified" chip + "Reset to default"
  // affordance (UI-06). Tolerant numeric compare so slider float drift from
  // value↔display scaling doesn't read as a spurious edit.
  const modified = !isDefaultValue(value, seededDefault);

  // A small label-row badge + reset link, shown only when modified. The chip
  // carries readable text; the reset control is a real <button> with an
  // accessible name so it's keyboard- and screen-reader-friendly.
  const provenance = modified ? (
    <span className="prov">
      <span className="prov-chip">Modified</span>
      {onReset && (
        <button
          type="button"
          className="prov-reset"
          onClick={onReset}
          disabled={disabled}
          aria-label={`Reset ${input.label} to default`}
        >
          Reset to default
        </button>
      )}
    </span>
  ) : null;

  // Always-open help block ("How to find this value") + the source/justification
  // capture. Replaces the old <details class="howto"> accordion so the
  // (often time-consuming) data-gathering guidance is front-and-center.
  const help =
    input.instructions || (input.resources && input.resources.length > 0) ? (
      <div className="howto-open">
        <div className="howto-open-head">How to find this value</div>
        {input.instructions && (
          <Markdown className="md-help">{input.instructions}</Markdown>
        )}
        {input.resources && input.resources.length > 0 && (
          <div className="howto-open-links">
            {input.resources.map((r) => (
              <ResourceLink key={r.url} label={r.label} url={r.url} small />
            ))}
          </div>
        )}
      </div>
    ) : null;

  const provNote = (
    // Source/justification capture (CMT-01): always shown so users can
    // document any input, not only overridden ones. Captured into the basket
    // entry's inputNotes and surfaced in the PDF report + on the results page.
    <div className="prov-note">
      <label htmlFor={noteId}>
        Source / justification (optional){" "}
        <i
          className="info-i"
          data-tip="Describe the source of your assumptions or steps used to choose this value. Included in the exported PDF report. Provides helpful context for grant application evaluations."
          aria-hidden="true"
        >i</i>
      </label>
      <textarea
        id={noteId}
        className="prov-note-input"
        rows={2}
        placeholder="e.g. ACS 2022 5-year estimate; local employer survey; project memo…"
        value={note}
        disabled={disabled}
        onChange={(e) => onNoteChange(e.target.value)}
      />
    </div>
  );

  if (input.type === "slider") {
    const scale = input.scale ?? 1;
    const numValue = typeof value === "number" ? value : Number(value);
    const display = numValue * scale;
    const suffix = input.suffix ?? "";
    return (
      <div className={`input-item${modified ? " is-modified" : ""}${disabled ? " is-disabled" : ""}`}>
        <div className="row">
          <span className="label-wrap">
            <label htmlFor={inputId}>{input.label}</label>
            {provenance}
          </span>
          <span className="val-display">
            {display.toLocaleString(undefined, { maximumFractionDigits: 1 })}
            {suffix}
          </span>
        </div>
        <input
          id={inputId}
          type="range"
          min={input.min}
          max={input.max}
          step={input.step}
          value={display}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value) / scale)}
        />
        <div className="range-lbls">
          <span>{input.min}{suffix}</span>
          <span>{input.max}{suffix}</span>
        </div>
        {input.source && <div className="src">{input.source}</div>}
        {input.benchmark && <div className="benchmark">{input.benchmark}</div>}
        {help}
        {provNote}
      </div>
    );
  }
  if (input.type === "number") {
    const numValue =
      value === "" || value == null ? "" : typeof value === "number" ? value : Number(value);
    return (
      <div className={`input-item${modified ? " is-modified" : ""}${disabled ? " is-disabled" : ""}`}>
        <div className="row">
          <span className="label-wrap">
            <label htmlFor={inputId}>{input.label}</label>
            {provenance}
          </span>
          <span style={{ fontSize: 11, color: "#6B6B6B" }}>{input.unit ?? ""}</span>
        </div>
        <input
          id={inputId}
          type="number"
          value={numValue}
          step={input.step ?? 1}
          min={input.min}
          max={input.max}
          disabled={disabled}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") onChange("");
            else onChange(Number(raw));
          }}
        />
        {input.source && <div className="src">{input.source}</div>}
        {input.benchmark && <div className="benchmark">{input.benchmark}</div>}
        {help}
        {provNote}
      </div>
    );
  }
  // select
  return (
    <div className={`input-item${modified ? " is-modified" : ""}${disabled ? " is-disabled" : ""}`}>
      <div className="row">
        <span className="label-wrap">
          <label htmlFor={inputId}>
            {input.label} <i className="info-i" data-tip={input.source ?? ""} aria-hidden="true">i</i>
          </label>
          {provenance}
        </span>
      </div>
      <select
        id={inputId}
        value={String(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          padding: "8px 10px",
          border: "1px solid #BEBEBE",
          borderRadius: 2,
          fontFamily: "inherit",
          fontSize: 14,
        }}
      >
        {input.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {input.benchmark && <div className="benchmark">{input.benchmark}</div>}
      {help}
      {provNote}
    </div>
  );
}
