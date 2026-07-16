// CSV export for the calculator's results pane. Produces two stacked
// sections in a single file:
//   1. Project summary (totals, selected TAZ count, GHG, etc.)
//   2. Per-strategy rows with their configured inputs + impact
//
// Plain string concatenation, no library. Browser download via a blob URL.

import type { AggregatedResults, BasketEntry } from "../strategies/compute";
import { CATEGORIES, getStrategy } from "../strategies/registry";
import { isDefaultValue } from "../strategies/defaults";
import { annualVmtToGhgTonnes, ANNUAL_VMT_PER_CAR } from "../strategies/ghg";
import { getStrategyContext, OVERRIDE_FORMATTERS } from "../strategies/context";
import type { TazInputs } from "../strategies/types";

// RFC-4180-ish field escaping. Quote if the field has a comma, quote, or newline.
function escapeField(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function row(cells: unknown[]): string {
  return cells.map(escapeField).join(",");
}

/** Project-level baseline VMT override + its "why" narrative, threaded from the
    Layout state so the CSV documents the override for a PD 1601 application. */
export interface BaselineOverrideOpts {
  baselineVmtOverride?: number | null;
  baselineVmtNote?: string;
}

export function buildResultsCsv(
  basket: BasketEntry[],
  results: AggregatedResults,
  tazCount: number,
  tazInputs: TazInputs[] = [],
  baselineOpts: BaselineOverrideOpts = {},
): string {
  const lines: string[] = [];
  const now = new Date().toISOString();

  // --- Section 1: project summary ----------------------------------------
  lines.push("# CDOT TDM Calculator: results export");
  lines.push(`# Generated: ${now}`);
  lines.push(`# Methodology: scripts/strategy_calculations.py reference`);
  lines.push("");
  lines.push("[Project summary]");
  lines.push(row(["Metric", "Value", "Units"]));
  lines.push(row(["TAZs selected", tazCount, "TAZ"]));
  lines.push(row(["Baseline VMT", Math.round(results.baseline_vmt), "mi/day"]));
  // Project-level baseline VMT override provenance (CMT-01 parallel): when the
  // user overrode the modeled baseline, document the overridden value + "why"
  // narrative. Omitted entirely when no override is active.
  if (
    baselineOpts.baselineVmtOverride != null &&
    Number.isFinite(baselineOpts.baselineVmtOverride)
  ) {
    lines.push(
      row([
        "Baseline VMT override",
        Math.round(baselineOpts.baselineVmtOverride),
        "mi/day",
      ]),
    );
    lines.push(
      row([
        "Baseline VMT override justification",
        (baselineOpts.baselineVmtNote ?? "").trim(),
        "",
      ]),
    );
  }
  lines.push(row(["Strategies in package", basket.length, "count"]));
  lines.push(
    row([
      "Combined VMT reduction",
      (results.total_pct_vmt_reduction * 100).toFixed(4),
      "%",
    ]),
  );
  lines.push(
    row([
      "Daily VMT reduced",
      Math.round(results.total_daily_vmt_reduction),
      "mi/day",
    ]),
  );
  const annualVmt = results.total_daily_vmt_reduction * 365;
  lines.push(row(["Annual VMT reduced", Math.round(annualVmt), "mi/yr"]));
  const ghgT = annualVmtToGhgTonnes(annualVmt);
  lines.push(row(["GHG avoided", Math.round(ghgT), "t CO2e/yr"]));
  lines.push(
    row([
      "Cars off-road equivalent",
      Math.round(annualVmt / ANNUAL_VMT_PER_CAR),
      "cars",
    ]),
  );
  if (results.capped_categories.length > 0) {
    lines.push(
      row([
        "Subsector caps applied to",
        results.capped_categories
          .map(
            (id) => CATEGORIES.find((c) => c.id === id)?.name ?? id,
          )
          .join("; "),
        "",
      ]),
    );
  }

  // --- Section 2: project area, TAZ baseline ---------------------------
  // All baseline TAZ attributes for the selected project area, one row per
  // TAZ, the underlying data the calculation runs on (CDOT Requirements
  // §4.4: CSV export "including all baseline data ... for further analysis").
  const num = (v: unknown, digits = 0): string =>
    typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "";
  lines.push("");
  lines.push("[Project area: TAZ baseline]");
  lines.push(
    row([
      "TAZ id",
      "County",
      "MPO",
      "Area type",
      "Area (sq mi)",
      "Population",
      "Employment",
      "Households",
      "Pop density (/sq mi)",
      "Emp density (/sq mi)",
      "Activity density (/sq mi)",
      "Daily VMT (mi/day)",
      "Daily trips",
      "Avg trip length (mi)",
      "ACS drove-alone share",
      "ACS carpool share",
      "ACS transit share",
      "ACS bike share",
      "ACS walk share",
    ]),
  );
  for (const t of tazInputs) {
    lines.push(
      row([
        t.taz_id,
        t.county,
        t.mpo,
        t.area_type,
        num(t.area_sqmi, 3),
        num(t.population),
        num(t.employment),
        num(t.households),
        num(t.pop_density, 1),
        num(t.emp_density, 1),
        num(t.activity_density, 1),
        num(t.daily_vmt),
        num(t.daily_trips),
        num(t.avg_trip_length, 2),
        num(t.acs_drove_alone_share, 4),
        num(t.acs_carpool_share, 4),
        num(t.acs_transit_share, 4),
        num(t.acs_bike_share, 4),
        num(t.acs_walk_share, 4),
      ]),
    );
  }

  // --- Section 3: per-strategy ------------------------------------------
  lines.push("");
  lines.push("[Strategies]");
  lines.push(
    row([
      "Strategy id",
      "Strategy",
      "Category",
      "% VMT reduction",
      "Daily VMT reduction (mi/day)",
      "Annual VMT reduction (mi/yr)",
      "Capped",
      // Each input is tagged (user-set) when the value was changed from the
      // system default for this project area, or (default) when left as seeded
      // Provenance per OR-05 ("distinguish user inputs from baseline").
      "Inputs",
      "Methodology",
      "Formula",
      "Source / citation",
    ]),
  );
  for (const p of results.per_strategy) {
    const entry = basket.find((b) => b.id === p.id);
    const meta = getStrategy(p.id);
    const inputsStr = entry
      ? meta.inputs
          .map((inp) => {
            const v = entry.values[inp.key];
            if (v == null) return null;
            const scale =
              inp.type === "slider" ? inp.scale ?? 1 : 1;
            const display = typeof v === "number" ? v * scale : v;
            const suffix =
              inp.type === "slider"
                ? inp.suffix ?? ""
                : inp.type === "number"
                ? ` ${inp.unit ?? ""}`.trimEnd()
                : "";
            // Provenance tag: compare against the seed captured when the
            // strategy was configured (fall back to catalog defaults for
            // entries lacking a snapshot).
            const seeded =
              entry.seededDefaults?.[inp.key] ?? meta.defaults[inp.key];
            const isDefault = isDefaultValue(v, seeded);
            const tag = isDefault ? "default" : "user-set";
            // Append the user's optional source/justification note for a
            // modified input so the CSV documents provenance for PD 1601
            // (CMT-01). Inner quotes are escaped by escapeField at row build.
            const note = !isDefault
              ? entry.inputNotes?.[inp.key]?.trim()
              : undefined;
            const tagStr = note ? `${tag}; source: "${note}"` : tag;
            return `${inp.label}=${display}${suffix} (${tagStr})`;
          })
          .filter(Boolean)
          .join("; ")
      : "";
    const cat = CATEGORIES.find((c) => c.id === p.meta.category);
    const annual = p.daily_vmt_reduction * 365;
    lines.push(
      row([
        p.id,
        p.meta.displayName,
        cat?.name ?? p.meta.category,
        (p.pct_vmt_reduction * 100).toFixed(4),
        Math.round(p.daily_vmt_reduction),
        Math.round(annual),
        p.capped ? "Y" : "N",
        inputsStr,
        p.meta.method,
        p.meta.formula,
        p.meta.source,
      ]),
    );
  }

  // --- Section 3b: per-strategy project-context baseline overrides -------
  // Where the user pinned a data-derived baseline (transit share, AVO,
  // density, parking price, …) for a strategy, document the overridden value
  // (in display units) and its "why" narrative — parallel to the input-level
  // source/justification notes above (CMT-01). Section omitted when no
  // strategy carries any override.
  const overrideRows: string[] = [];
  for (const p of results.per_strategy) {
    const entry = basket.find((b) => b.id === p.id);
    const overrides = entry?.contextOverrides;
    if (!entry || !overrides || Object.keys(overrides).length === 0) continue;
    // Map each overrideKey → its human label via the strategy's context rows.
    const ctxRows = getStrategyContext(p.id, tazInputs, entry.values);
    const labelByKey = new Map<string, string>();
    for (const r of ctxRows) {
      if (r.overrideKey) labelByKey.set(r.overrideKey, r.label);
    }
    for (const [key, v] of Object.entries(overrides)) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const format = OVERRIDE_FORMATTERS[key];
      const value = format ? format(v) : String(v);
      const note = entry.contextNotes?.[key]?.trim() ?? "";
      overrideRows.push(
        row([p.id, p.meta.displayName, labelByKey.get(key) ?? key, value, note]),
      );
    }
  }
  if (overrideRows.length > 0) {
    lines.push("");
    lines.push("[Context overrides]");
    lines.push(
      row([
        "Strategy id",
        "Strategy",
        "Context override",
        "Overridden value",
        "Justification",
      ]),
    );
    lines.push(...overrideRows);
  }

  // --- Section 4: per-strategy × per-TAZ (detail) ------------------------
  lines.push("");
  lines.push("[Strategy × TAZ detail]");
  lines.push(
    row([
      "Strategy id",
      "TAZ id",
      "Base VMT purpose",
      "Base VMT (mi/day)",
      "% VMT reduction",
      "Daily VMT reduction (mi/day)",
      "Data assumptions",
    ]),
  );
  for (const p of results.per_strategy) {
    for (const r of p.rows) {
      lines.push(
        row([
          p.id,
          r.taz_id,
          r.base_vmt_purpose,
          r.base_vmt.toFixed(2),
          (r.pct_vmt_reduction * 100).toFixed(6),
          r.daily_vmt_reduction.toFixed(4),
          r.data_assumptions,
        ]),
      );
    }
  }

  return lines.join("\n") + "\n";
}

/** Browser download via a blob URL. */
export function downloadResultsCsv(
  basket: BasketEntry[],
  results: AggregatedResults,
  tazCount: number,
  tazInputs: TazInputs[] = [],
  baselineOpts: BaselineOverrideOpts = {},
  filename?: string,
): void {
  const csv = buildResultsCsv(basket, results, tazCount, tazInputs, baselineOpts);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date()
    .toISOString()
    .replace(/[:T]/g, "-")
    .replace(/\..*$/, "");
  const a = document.createElement("a");
  a.href = url;
  a.download = filename ?? `cdot-tdm-calculator-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so download starts cleanly in all browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
