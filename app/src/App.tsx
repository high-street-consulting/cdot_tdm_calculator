// Top-level app shell.
//
// Routing: HashRouter so each view has a deep-linkable URL (#/area,
// #/strategies, #/strategies/:id, #/cart, #/methodology, #/data). Hash
// routing avoids needing server-side rewrites on the static bitbucket
// pages deploy.
//
// Layout: a single <Layout> component owns all cross-route state: the
// selected TAZ ids, fetched TazInputs, the basket, the working-values
// draft, and the AGOL FeatureLayer ref. The MapView is mounted once at
// the Layout level and kept in the DOM with display:none on non-area
// routes so that pan/zoom is preserved when the user comes back. Route
// content is rendered via <Outlet> using `useOutletContext()` for the
// shared state, so adding a new route just means adding a `<Route>`.

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  HashRouter,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router-dom";
import type FeatureLayer from "@arcgis/core/layers/FeatureLayer";

import type { SelectionMode } from "./components/MapView";
import { ShopBody } from "./components/ShopBody";
import { CartView } from "./components/CartView";
import { ReportView } from "./components/ReportView";
import { DetailView } from "./components/DetailView";
import { MethodologyView } from "./components/MethodologyView";
import { DataSourcesView } from "./components/DataSourcesView";
import { Footer } from "./components/Footer";
import { ConfirmModal } from "./components/ConfirmModal";
import { HelpModal } from "./components/HelpModal";
import { MapLoading } from "./components/MapLoading";
import { computeResults, type AggregatedResults, type BasketEntry } from "./strategies/compute";
import { seedDefaults, isDefaultValue } from "./strategies/defaults";
import type { TazInputs } from "./strategies/types";
import { type StrategyKey } from "./strategies/strategies";
import { getStrategy, isKnownStrategy } from "./strategies/registry";
import { getStrategyContext } from "./strategies/context";

// Code-split the ArcGIS map: it's by far the heaviest dependency, so keep it
// (and the data layer it queries) out of the entry bundle. The app shell +
// landing copy paint immediately; the SDK loads in parallel and the map fills
// in. queryTaz is dynamically imported in the selection effect for the same
// reason (it pulls in @arcgis/core's FeatureLayer).
const MapCanvas = lazy(() =>
  import("./components/MapView").then((m) => ({ default: m.MapCanvas })),
);

// Default/fallback maximum number of TAZs that can be in a selection at once.
// The attribute fetch chunks at 200 ids/query and the report map chunks its
// draws, so a few hundred zones is comfortably handled; we cap here so a "Draw
// area" over a large region can't silently balloon the selection.
//
// The real reason for the cap: a "Draw area" over a big region issues ONE
// spatial query to the TAZ FeatureLayer, and AGOL silently truncates the
// returned features at the layer's `maxRecordCount` (observed to be 2000).
// Capping the selection at that limit keeps the "no silent truncation"
// guarantee aligned with the service's actual behavior. We read the live
// maxRecordCount off the layer once it loads (see the effect below) and fall
// back to this value if it isn't reported.
const DEFAULT_MAX_SELECTED_TAZS = 2000;

// ─── Route → "view" mapping ─────────────────────────────────────────
// Used to drive the header active state, basket-bar crumb step, and
// whether the persistent map is visible.
export type AppView =
  | "area"
  | "shop"
  | "detail"
  | "cart"
  | "report"
  | "methodology"
  | "datasources";

function viewFromPath(pathname: string): AppView {
  if (pathname.startsWith("/strategies/")) return "detail";
  if (pathname === "/strategies") return "shop";
  if (pathname === "/cart") return "cart";
  if (pathname === "/report") return "report";
  if (pathname === "/methodology") return "methodology";
  if (pathname === "/data") return "datasources";
  return "area";
}

// ─── Shared layout context ───────────────────────────────────────────
// Everything route components need access to. Provided once at the
// Layout level and consumed via useOutletContext().
interface LayoutContext {
  selectedTazIds: Set<string>;
  tazInputs: TazInputs[];
  loadingInputs: boolean;
  basket: BasketEntry[];
  workingValues: Record<string, number | string>;
  setWorkingValues: (
    update: (prev: Record<string, number | string>) => Record<string, number | string>,
  ) => void;
  /** Draft of the per-input "source / justification" notes for the strategy
      currently being edited (CMT-01); committed onto the basket entry. */
  workingNotes: Record<string, string>;
  setWorkingNotes: (
    update: (prev: Record<string, string>) => Record<string, string>,
  ) => void;
  /** Draft of the per-strategy "Project context" overrides (keyed by the
      ContextRow.overrideKey, e.g. transit_mode_share / avo / parking_price),
      in the variable's NATIVE units. Committed onto the basket entry as
      `contextOverrides`. Only feeds the calc for DSL-computed strategies. */
  workingContextOverrides: Record<string, number>;
  setWorkingContextOverrides: (
    update: (prev: Record<string, number>) => Record<string, number>,
  ) => void;
  /** Draft of the free-text "why" narrative for each context override, keyed by
      the same overrideKey. Committed onto the basket entry as `contextNotes`. */
  workingContextNotes: Record<string, string>;
  setWorkingContextNotes: (
    update: (prev: Record<string, string>) => Record<string, string>,
  ) => void;
  /** Snapshot of the system-default seed for the strategy currently being
      edited; the draft is compared against this to flag modified inputs. */
  seededDefaults: Record<string, number | string>;
  /** PROJECT-LEVEL baseline VMT override (a single project-wide value, distinct
      from the per-strategy contextOverrides). When set to a positive finite
      number it replaces the derived sum of TAZ daily_vmt, uniformly scaling all
      results (see computeResults). Null = use the derived baseline. Persists
      across navigation; cleared on reset. The editor UI is a later pass. */
  baselineVmtOverride: number | null;
  setBaselineVmtOverride: (v: number | null) => void;
  /** Free-text "why" narrative documenting the baseline VMT override for a
      PD 1601 application. Project-global; cleared on reset. */
  baselineVmtNote: string;
  setBaselineVmtNote: (v: string) => void;
  results: AggregatedResults;
  justAdded: StrategyKey | null;
  setJustAdded: (k: StrategyKey | null) => void;
  openDetail: (id: StrategyKey) => void;
  commitBasket: (id: StrategyKey, vals: Record<string, number | string>) => void;
  removeFromBasket: (id: StrategyKey) => void;
  /** Open the confirm-reset modal (CMT-03/15: "Start over" on the results page). */
  requestReset: () => void;
}

function useLayout(): LayoutContext {
  return useOutletContext<LayoutContext>();
}

// ─── App entry ───────────────────────────────────────────────────────
export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/area" replace />} />
          <Route path="/area" element={<AreaRoute />} />
          <Route path="/strategies" element={<ShopRoute />} />
          <Route path="/strategies/:id" element={<DetailRoute />} />
          <Route path="/cart" element={<CartRoute />} />
          <Route path="/report" element={<ReportRoute />} />
          <Route path="/methodology" element={<MethodologyView />} />
          <Route path="/data" element={<DataSourcesView />} />
          <Route path="*" element={<Navigate to="/area" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}

// ─── Layout ───────────────────────────────────────────────────────────
// Owns all shared state. Renders the chrome (header, basket-bar, footer)
// and the persistent map. The active route's content goes through
// <Outlet> below the map-host.
function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const view = viewFromPath(location.pathname);

  const [selectedTazIds, setSelectedTazIds] = useState<Set<string>>(new Set());
  // True when the last selection action would have pushed the selection past
  // the effective cap (maxSelectedTazs), so we capped it and dropped the
  // overflow. Surfaced as a
  // dismissible warning banner (distinct from inputsError) so the user knows
  // some zones weren't added instead of the app silently swallowing them.
  const [selectionCapped, setSelectionCapped] = useState(false);
  const [tazInputs, setTazInputs] = useState<TazInputs[]>([]);
  const [tazLayer, setTazLayer] = useState<FeatureLayer | null>(null);
  // Effective selection cap. Defaults to DEFAULT_MAX_SELECTED_TAZS and is
  // updated to the TAZ FeatureLayer's real query maxRecordCount once the layer
  // loads, so the cap self-corrects if CDOT changes the service.
  const [maxSelectedTazs, setMaxSelectedTazs] = useState(DEFAULT_MAX_SELECTED_TAZS);
  const [basket, setBasket] = useState<BasketEntry[]>([]);
  const [workingValues, setWorkingValues] = useState<Record<string, number | string>>({});
  // Draft of the per-input source/justification notes for the strategy
  // currently open in the detail view (CMT-01). Seeded empty for a fresh
  // strategy, or from the basket entry's inputNotes when editing one.
  const [workingNotes, setWorkingNotes] = useState<Record<string, string>>({});
  // Draft of the per-strategy "Project context" overrides for the strategy
  // currently open in the detail view, keyed by ContextRow.overrideKey and
  // stored in the variable's NATIVE units (the same units dslRow feeds the
  // calc). Seeded from the basket entry's contextOverrides when editing, or
  // empty for a fresh strategy; committed onto the entry in commitBasket.
  const [workingContextOverrides, setWorkingContextOverrides] = useState<
    Record<string, number>
  >({});
  // Draft of the free-text "why" narrative for each context override, keyed by
  // the same overrideKey (mirrors workingNotes for inputs).
  const [workingContextNotes, setWorkingContextNotes] = useState<
    Record<string, string>
  >({});
  // The system-default seed for the strategy currently open in the detail
  // view, captured in openDetail. DetailView compares the draft against this
  // to flag which inputs have been modified from default (UI-06).
  const [seededDefaults, setSeededDefaults] = useState<Record<string, number | string>>({});
  // PROJECT-LEVEL baseline VMT override + its "why" narrative. Project-global
  // (NOT per basket entry), so it lives in Layout state and is threaded into the
  // computeResults useMemo below. Defaults to no override; cleared on reset. The
  // editor/display UI is a later pass — this is just the state + wiring.
  const [baselineVmtOverride, setBaselineVmtOverride] = useState<number | null>(null);
  const [baselineVmtNote, setBaselineVmtNote] = useState<string>("");
  const [loadingInputs, setLoadingInputs] = useState(false);
  // True when the TAZ-attribute fetch failed after retries. Surfaced as a
  // banner so a failed load is visible instead of silently zeroing the results.
  const [inputsError, setInputsError] = useState(false);
  // Bumped by the "Retry" button to re-run the fetch.
  const [inputsReloadKey, setInputsReloadKey] = useState(0);
  const retryInputs = useCallback(() => setInputsReloadKey((k) => k + 1), []);
  const [justAdded, setJustAdded] = useState<StrategyKey | null>(null);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);

  // Pull TAZ attributes from AGOL whenever the selection changes. The query is
  // chunked and can flake transiently, which used to leave tazInputs empty and
  // silently zero the results. Retry a few times, and on hard failure surface a
  // visible error (with a Retry) instead of a misleading 0.
  useEffect(() => {
    if (selectedTazIds.size === 0) {
      setTazInputs([]);
      setInputsError(false);
      return;
    }
    let cancelled = false;
    setLoadingInputs(true);
    setInputsError(false);
    void (async () => {
      const attempts = 3;
      for (let i = 0; i < attempts; i++) {
        try {
          const { queryTazInputs } = await import("./data/queryTaz");
          const rows = await queryTazInputs(selectedTazIds, tazLayer);
          if (cancelled) return;
          setTazInputs(rows);
          setInputsError(false);
          setLoadingInputs(false);
          return;
        } catch (e) {
          console.error(`queryTazInputs failed (attempt ${i + 1}/${attempts}):`, e);
          if (cancelled) return;
          if (i < attempts - 1) await new Promise((r) => setTimeout(r, 700 * (i + 1)));
        }
      }
      if (cancelled) return;
      // All attempts failed: clear stale rows (so results don't show a wrong
      // number for this selection) and surface the error.
      setTazInputs([]);
      setInputsError(true);
      setLoadingInputs(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedTazIds, tazLayer, inputsReloadKey]);

  const results = useMemo(
    () => computeResults(basket, tazInputs, { baselineVmtOverride }),
    [basket, tazInputs, baselineVmtOverride],
  );

  // Derive the effective selection cap from the TAZ FeatureLayer's real query
  // maxRecordCount. A "Draw area" spatial query is silently truncated by AGOL
  // at this limit, so aligning the cap to it keeps the "no silent truncation"
  // guarantee honest, and self-corrects if CDOT changes the service. capabilities
  // only populate after the layer loads, so ensure it's loaded first, then read
  // capabilities.query.maxRecordCount (falling back to sourceJSON). Keep the
  // DEFAULT_MAX_SELECTED_TAZS default if the layer doesn't report a positive
  // number.
  useEffect(() => {
    if (!tazLayer) return;
    let cancelled = false;
    void (async () => {
      try {
        if (!tazLayer.loaded) await tazLayer.load();
      } catch {
        // Load failure: keep the default cap.
        return;
      }
      if (cancelled) return;
      const fromCaps = tazLayer.capabilities?.query?.maxRecordCount;
      const fromSource = (tazLayer.sourceJSON as { maxRecordCount?: number } | undefined)
        ?.maxRecordCount;
      const max = typeof fromCaps === "number" && fromCaps > 0 ? fromCaps : fromSource;
      if (typeof max === "number" && max > 0) {
        setMaxSelectedTazs(max);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tazLayer]);

  const handleSelectionChange = useCallback(
    (ids: string[], mode: SelectionMode) => {
      // Tracks whether this action had to drop zones to stay within the cap, so
      // we can raise the warning banner outside the state updater (no side
      // effects inside setState).
      let capped = false;
      setSelectedTazIds((prev) => {
        // "replace" (plain click / clear) never grows the selection beyond what
        // was drawn/clicked, but a replace with more ids than the cap (unlikely
        // today) is still bounded for safety.
        if (mode === "replace") {
          if (ids.length === 1 && prev.size === 1 && prev.has(ids[0])) {
            return new Set();
          }
          if (ids.length > maxSelectedTazs) {
            capped = true;
            return new Set(ids.slice(0, maxSelectedTazs));
          }
          return new Set(ids);
        }
        // "add" (draw area / shift-drag) and "toggle" (shift-click) both grow
        // the selection: stop adding once we reach the cap and flag the drop.
        const next = new Set(prev);
        for (const id of ids) {
          if (mode === "toggle" && next.has(id)) {
            next.delete(id);
            continue;
          }
          if (next.has(id)) continue;
          if (next.size >= maxSelectedTazs) {
            capped = true;
            continue;
          }
          next.add(id);
        }
        return next;
      });
      // Only surface the banner when we actually dropped zones. Once the user
      // frees up room (removes zones) and a later action fits, this stays false.
      if (capped) setSelectionCapped(true);
    },
    [maxSelectedTazs],
  );

  // A "Draw area" query truncated server-side at the layer's maxRecordCount: the
  // drawn area covered more zones than the service returns at once, and the
  // dropped ids never reach handleSelectionChange's count check, so raise the
  // same warning banner directly from this signal.
  const handleSelectionTruncated = useCallback(() => {
    setSelectionCapped(true);
  }, []);

  // Auto-clear the "selection capped" banner once the selection is comfortably
  // back below the cap (e.g. the user removed zones), and always after ~6s so a
  // stale notice doesn't linger. The banner is also manually dismissible.
  useEffect(() => {
    if (!selectionCapped) return;
    if (selectedTazIds.size < maxSelectedTazs) {
      setSelectionCapped(false);
      return;
    }
    const t = setTimeout(() => setSelectionCapped(false), 6000);
    return () => clearTimeout(t);
  }, [selectionCapped, selectedTazIds, maxSelectedTazs]);

  // Opening the detail view: seed the working-values draft from either
  // the basket entry (if already configured) or the system-default seed
  // (static catalog defaults + TAZ-derived overrides). Either way capture the
  // seed snapshot in `seededDefaults` so DetailView can flag modified inputs;
  // for an existing entry we reuse the snapshot taken when it was first
  // configured (recomputing as a fallback for entries that predate the
  // snapshot). Then navigate to /strategies/:id.
  const openDetail = useCallback(
    (id: StrategyKey) => {
      const existing = basket.find((b) => b.id === id);
      if (existing) {
        setWorkingValues({ ...existing.values });
        setWorkingNotes({ ...(existing.inputNotes ?? {}) });
        setWorkingContextOverrides({ ...(existing.contextOverrides ?? {}) });
        setWorkingContextNotes({ ...(existing.contextNotes ?? {}) });
        setSeededDefaults(existing.seededDefaults ?? seedDefaults(id, tazInputs));
      } else {
        const seed = seedDefaults(id, tazInputs);
        setWorkingValues({ ...seed });
        setWorkingNotes({});
        setWorkingContextOverrides({});
        setWorkingContextNotes({});
        setSeededDefaults(seed);
      }
      navigate(`/strategies/${id}`);
    },
    [basket, tazInputs, navigate],
  );

  // Commit the working-values draft to the basket and bounce back to
  // the strategies list with the just-added banner. Persist the seed snapshot
  // alongside the values so the "modified from default" provenance survives the
  // round trip and is available to the cart/report/CSV exports.
  const commitBasket = useCallback(
    (id: StrategyKey, vals: Record<string, number | string>) => {
      // Keep only non-empty notes, and only for inputs that actually differ
      // from the seed: a justification only makes sense for a modified value
      // (CMT-01). Drop the field entirely when there's nothing to record.
      const notes: Record<string, string> = {};
      for (const [key, note] of Object.entries(workingNotes)) {
        const text = note.trim();
        if (text && !isDefaultValue(vals[key], seededDefaults[key])) {
          notes[key] = text;
        }
      }

      // Per-strategy "Project context" overrides. Only DSL-computed strategies
      // (meta.compute) actually feed overrides into the calc, so only persist
      // them there (for a hand-written strategy the affordance isn't rendered
      // and this draft stays empty anyway). Keep an override only when it
      // differs from the row's data-derived baseline (rawValue), mirroring the
      // "modified from default" filter for inputs; drop no-op overrides so an
      // untouched value doesn't read as user-supplied. Keep a note only when it
      // annotates a surviving override and has non-empty text.
      const contextOverrides: Record<string, number> = {};
      const contextNotes: Record<string, string> = {};
      const meta = getStrategy(id);
      if (meta.compute) {
        // Baseline (rawValue) per overrideKey, from the un-overridden rows.
        const baselines: Record<string, number> = {};
        for (const row of getStrategyContext(id, tazInputs, vals)) {
          if (row.overrideKey && typeof row.rawValue === "number") {
            baselines[row.overrideKey] = row.rawValue;
          }
        }
        for (const [key, ov] of Object.entries(workingContextOverrides)) {
          if (typeof ov !== "number" || !Number.isFinite(ov)) continue;
          const base = baselines[key];
          // Tolerant compare so a re-entered value equal to the baseline (or
          // float drift from display↔native scaling) isn't stored as a change.
          if (typeof base === "number" && Math.abs(ov - base) < 1e-9) continue;
          contextOverrides[key] = ov;
        }
        for (const [key, note] of Object.entries(workingContextNotes)) {
          const text = note.trim();
          if (text && contextOverrides[key] !== undefined) {
            contextNotes[key] = text;
          }
        }
      }

      setBasket((prev) => {
        const idx = prev.findIndex((b) => b.id === id);
        const entry: BasketEntry = {
          id,
          values: { ...vals },
          seededDefaults: { ...seededDefaults },
          ...(Object.keys(notes).length > 0 ? { inputNotes: notes } : {}),
          ...(Object.keys(contextOverrides).length > 0
            ? { contextOverrides }
            : {}),
          ...(Object.keys(contextNotes).length > 0 ? { contextNotes } : {}),
        };
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = entry;
          return next;
        }
        return [...prev, entry];
      });
      setJustAdded(id);
      navigate("/strategies");
    },
    [
      navigate,
      seededDefaults,
      workingNotes,
      workingContextOverrides,
      workingContextNotes,
      tazInputs,
    ],
  );

  const removeFromBasket = useCallback((id: StrategyKey) => {
    setBasket((prev) => prev.filter((b) => b.id !== id));
  }, []);

  const isDirty =
    selectedTazIds.size > 0 ||
    basket.length > 0 ||
    Object.keys(workingValues).length > 0;

  function resetAll() {
    setSelectedTazIds(new Set());
    setTazInputs([]);
    setBasket([]);
    setWorkingValues({});
    setWorkingNotes({});
    setWorkingContextOverrides({});
    setWorkingContextNotes({});
    setBaselineVmtOverride(null);
    setBaselineVmtNote("");
    setJustAdded(null);
    navigate("/area");
  }

  // Open the confirm-reset modal: the discoverable "Start over" affordance on
  // the results page routes through the same modal as the header logo (CMT-03/15).
  const requestReset = useCallback(() => setConfirmResetOpen(true), []);

  function handleHomeNav() {
    if (!isDirty && view === "area") return;
    if (isDirty) {
      setConfirmResetOpen(true);
      return;
    }
    resetAll();
  }

  const ctx: LayoutContext = {
    selectedTazIds,
    tazInputs,
    loadingInputs,
    basket,
    workingValues,
    setWorkingValues,
    workingNotes,
    setWorkingNotes,
    workingContextOverrides,
    setWorkingContextOverrides,
    workingContextNotes,
    setWorkingContextNotes,
    seededDefaults,
    baselineVmtOverride,
    setBaselineVmtOverride,
    baselineVmtNote,
    setBaselineVmtNote,
    results,
    justAdded,
    setJustAdded,
    openDetail,
    commitBasket,
    removeFromBasket,
    requestReset,
  };

  return (
    <div className="shop-app">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <Header onHomeNav={handleHomeNav} view={view} />
      <BasketBar
        view={view}
        tazCount={selectedTazIds.size}
        basketCount={basket.length}
        totalPct={results.total_pct_vmt_reduction * 100}
        annualVMT={results.total_daily_vmt_reduction * 365}
        baselineVmt={results.baseline_vmt}
        baselineOverridden={baselineVmtOverride != null}
        canReset={selectedTazIds.size > 0 || basket.length > 0}
        onReset={requestReset}
      />

      {inputsError && selectedTazIds.size > 0 && (
        <div className="inputs-error-banner" role="alert">
          <span>
            ⚠ Couldn't load area data for the selected TAZ
            {selectedTazIds.size === 1 ? "" : "s"}. Baseline VMT and results may be
            incomplete.
          </span>
          <button
            type="button"
            className="btn btn-sm btn-neutral"
            onClick={retryInputs}
            disabled={loadingInputs}
          >
            {loadingInputs ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}

      {selectionCapped && (
        <div className="selection-cap-banner" role="status">
          <span>
            ⚠ You can select up to {maxSelectedTazs} zones. Some zones weren't
            added. Draw a smaller area, or remove zones to change your selection.
          </span>
          <button
            type="button"
            className="btn btn-sm btn-neutral"
            onClick={() => setSelectionCapped(false)}
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </div>
      )}

      <main
        id="main-content"
        className="shop-main-region"
        data-view={view}
        tabIndex={-1}
      >
        {/* Persistent map: always in DOM, hidden via the CSS data-view
            attribute on the parent so pan/zoom and selection layer
            survive nav. */}
        <div className="map-host">
          <div className="map">
            <Suspense fallback={<MapLoading />}>
              <MapCanvas
                selectedTazIds={selectedTazIds}
                onSelectionChange={handleSelectionChange}
                onSelectionTruncated={handleSelectionTruncated}
                onTazLayerReady={setTazLayer}
              />
            </Suspense>
          </div>
        </div>

        {/* Route content goes through Outlet with shared state */}
        <div className="route-outlet">
          <Outlet context={ctx} />
        </div>
      </main>

      <Footer />

      <ConfirmModal
        open={confirmResetOpen}
        title="Start a new project?"
        body="Your selected TAZs, configured strategies, and current results will be cleared. This cannot be undone."
        confirmLabel="Start over"
        cancelLabel="Keep working"
        variant="danger"
        onConfirm={() => {
          setConfirmResetOpen(false);
          resetAll();
        }}
        onCancel={() => setConfirmResetOpen(false)}
      />
    </div>
  );
}

// ─── Header ──────────────────────────────────────────────────────────
function Header({
  onHomeNav,
  view,
}: {
  onHomeNav: () => void;
  view: AppView;
}) {
  const isCalculator =
    view === "area" || view === "shop" || view === "detail" || view === "cart";
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <header className="hdr">
      <button
        type="button"
        className="hdr-home"
        onClick={onHomeNav}
        title="Start a new project"
      >
        <img src={`${import.meta.env.BASE_URL}cdot_logo.png`} alt="CDOT" />
        <span className="hdr-sep" />
        <span className="hdr-title">
          TDM Calculator
          <span className="sub">Estimate VMT reduction for Colorado projects</span>
        </span>
      </button>
      <span className="hdr-sep" />
      <nav className="hdr-nav" aria-label="Main">
        <NavLink
          to="/area"
          className={isCalculator ? "active" : ""}
          aria-current={isCalculator ? "page" : undefined}
        >
          Calculator
        </NavLink>
        <NavLink
          to="/methodology"
          className={({ isActive }) => (isActive ? "active" : "")}
          aria-current={view === "methodology" ? "page" : undefined}
        >
          Methodology
        </NavLink>
        <NavLink
          to="/data"
          className={({ isActive }) => (isActive ? "active" : "")}
          aria-current={view === "datasources" ? "page" : undefined}
        >
          Data sources
        </NavLink>
      </nav>
      <div className="hdr-spacer" />
      <button
        type="button"
        className="hdr-help"
        onClick={() => setHelpOpen(true)}
        aria-haspopup="dialog"
        title="Help & resources"
      >
        <span className="hdr-help-q" aria-hidden="true">?</span>
        <span className="hdr-help-label">Help</span>
      </button>
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </header>
  );
}

// ─── Basket bar (workflow steps + totals) ────────────────────────────
function BasketBar(props: {
  view: AppView;
  tazCount: number;
  basketCount: number;
  totalPct: number;
  annualVMT: number;
  baselineVmt: number;
  /** Whether the project baseline VMT has been overridden; drives a subtle
      "(edited)" marker on the BASELINE VMT metric. */
  baselineOverridden: boolean;
  /** Whether there's anything to reset (a selection or a non-empty basket).
      Drives whether the header "Start over" control is shown. */
  canReset: boolean;
  /** Open the confirm-reset modal (shared with the header logo). */
  onReset: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  // Remember the last strategies-flow location — the list, or the specific
  // strategy detail the user was configuring — so the "Strategy selection" step
  // returns them exactly where they left off after a detour to the map (the
  // config draft itself already persists at the AppLayout level). BasketBar is
  // mounted in the persistent layout, so this ref survives route changes.
  const lastStrategiesPath = useRef("/strategies");
  useEffect(() => {
    if (location.pathname.startsWith("/strategies")) {
      lastStrategiesPath.current = location.pathname;
    }
  }, [location.pathname]);
  const step =
    props.view === "area"
      ? 1
      : props.view === "shop" || props.view === "detail"
      ? 2
      : props.view === "cart"
      ? 3
      : 0;

  // Results are "ready" (and the (3) Results tab becomes a call-to-action)
  // once the basket has at least one strategy (mirrors the old "View results"
  // button's enabled condition). This is also the tab's click-enabled gate.
  const resultsReady = props.basketCount > 0;

  // Sliding active-indicator bar: a single underline that rests beneath the
  // active step and follows the cursor to whichever step is hovered, snapping
  // back to the active one on mouse-out. activeIndex/hoverIndex are 0-based
  // (step 1→0, 2→1, 3→2); step 0 (non-workflow view) parks off-screen.
  const activeIndex = step - 1;
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const crumbRef = useRef<HTMLElement | null>(null);
  const stepRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  const targetIndex = hoverIndex ?? activeIndex;
  // Measure the target step relative to the .crumb container and position the
  // bar. Re-run when the target changes or when a tab's width could change
  // (the cart badge appears/updates on the Results tab).
  useLayoutEffect(() => {
    function measure() {
      const el = stepRefs.current[targetIndex];
      const crumb = crumbRef.current;
      if (!el || !crumb) {
        setIndicator(null);
        return;
      }
      setIndicator({ left: el.offsetLeft, width: el.offsetWidth });
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [targetIndex, props.basketCount]);

  // Flash the totals once, the first time a selection populates them, so the
  // eye lands on the project-area figures (which replaced the old left-panel
  // "Selection" summary).
  const [flashTotals, setFlashTotals] = useState(false);
  const flashedRef = useRef(false);
  const prevTazRef = useRef(props.tazCount);
  useEffect(() => {
    const prev = prevTazRef.current;
    prevTazRef.current = props.tazCount;
    if (!flashedRef.current && prev === 0 && props.tazCount > 0) {
      flashedRef.current = true;
      setFlashTotals(true);
    }
  }, [props.tazCount]);

  return (
    <div className="basket-bar">
      <nav
        className="crumb"
        aria-label="Workflow steps"
        ref={crumbRef}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <button
          type="button"
          ref={(el) => {
            stepRefs.current[0] = el;
          }}
          className={`step ${step > 1 ? "done" : ""} ${step === 1 ? "active" : ""}`}
          aria-current={step === 1 ? "step" : undefined}
          onMouseEnter={() => setHoverIndex(0)}
          onClick={() => navigate("/area")}
        >
          <span className="n">1</span> Area selection
        </button>
        <span className="sep" aria-hidden="true">›</span>
        <button
          type="button"
          ref={(el) => {
            stepRefs.current[1] = el;
          }}
          className={`step ${step > 2 ? "done" : ""} ${step === 2 ? "active" : ""}`}
          aria-current={step === 2 ? "step" : undefined}
          onMouseEnter={() => setHoverIndex(1)}
          onClick={() => navigate(lastStrategiesPath.current)}
        >
          <span className="n">2</span> Strategy selection
        </button>
        <span className="sep" aria-hidden="true">›</span>
        <button
          type="button"
          ref={(el) => {
            stepRefs.current[2] = el;
          }}
          className={`step ${step === 3 ? "active" : ""} ${
            resultsReady && step !== 3 ? "ready" : ""
          }`}
          aria-current={step === 3 ? "step" : undefined}
          disabled={!resultsReady}
          onMouseEnter={() => setHoverIndex(2)}
          onClick={() => resultsReady && navigate("/cart")}
        >
          <span className="n">3</span> Results
          {props.basketCount > 0 && (
            <span
              className="cart-badge"
              aria-label={`${props.basketCount} ${
                props.basketCount === 1 ? "strategy" : "strategies"
              } in your basket`}
            >
              {/* Inline shopping-basket glyph (no icon lib): single-color,
                  currentColor, ~15px so it inherits the tab's text color and
                  reads clearly on both the orange ready-fill and the normal step
                  background. Immediately followed by the count so it says "N
                  items in your basket" rather than a second step number. */}
              <svg
                className="cart-icon"
                viewBox="0 0 24 24"
                width="15"
                height="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="m15 11-1 9" />
                <path d="m19 11-4-7" />
                <path d="M2 11h20" />
                <path d="m3.5 11 1.6 7.4a2 2 0 0 0 2 1.6h9.8a2 2 0 0 0 2-1.6l1.6-7.4" />
                <path d="M4.5 15.5h15" />
                <path d="m5 11 4-7" />
                <path d="m9 11 1 9" />
              </svg>
              <span className="cart-count">{props.basketCount}</span>
            </span>
          )}
        </button>
        {/* Single sliding active-indicator bar: rests under the active step and
            follows the cursor to whichever step is hovered (see BasketBar JS).
            Hidden until measured, and when no workflow step is active. */}
        {indicator && targetIndex >= 0 && (
          <span
            className="tab-indicator"
            aria-hidden="true"
            /* Inset 12px on each side to match the step's horizontal padding,
               preserving the old bar's under-the-text span. */
            style={{ left: indicator.left + 12, width: Math.max(0, indicator.width - 24) }}
          />
        )}
      </nav>
      <div
        className={`totals${flashTotals ? " flash-once" : ""}`}
        onAnimationEnd={() => setFlashTotals(false)}
      >
        <div>
          <div className="lab">Project area</div>
          <div className="val">
            {props.tazCount.toLocaleString()}
            <span className="u">TAZ</span>
          </div>
        </div>
        <div>
          <div className="lab">
            Baseline VMT
            {props.baselineOverridden && (
              <span
                className="baseline-edited-tag"
                title="Baseline VMT overridden"
              >
                (edited)
              </span>
            )}
          </div>
          <div className="val">
            {(props.baselineVmt / 1000).toLocaleString("en-US", { maximumFractionDigits: 0 })}
            <span className="u">Thousand mi/day</span>
          </div>
        </div>
        <div>
          <div className="lab">Basket impact</div>
          {/* Sign-aware: a positive total is a reduction (green, "−"); a
              negative net (e.g. an induced/road-capacity strategy dominating)
              reads as an increase (warn, "+"), CMT-06/08. */}
          <div className={`val ${props.totalPct >= 0 ? "green" : "warn"}`}>
            {props.totalPct >= 0 ? "−" : "+"}{Math.abs(props.totalPct).toFixed(2)}
            <span className="u">% VMT</span>
          </div>
        </div>
        <div>
          <div className="lab">Annual {props.annualVMT >= 0 ? "reduction" : "increase"}</div>
          <div className="val">
            {props.annualVMT >= 0 ? "" : "+"}{(Math.abs(props.annualVMT) / 1e6).toFixed(2)}
            <span className="u">Million mi/yr</span>
          </div>
        </div>
      </div>
      {props.canReset ? (
        <button
          type="button"
          className="start-over"
          onClick={props.onReset}
          title="Clear the selection and strategies to start a new project"
        >
          Start over
        </button>
      ) : (
        // Keep the grid's 4th column occupied so the metrics strip stays put
        // whether or not there's anything to reset.
        <span className="start-over-placeholder" aria-hidden="true" />
      )}
    </div>
  );
}

// ─── Route components ────────────────────────────────────────────────

function AreaRoute() {
  const navigate = useNavigate();
  const {
    selectedTazIds,
    tazInputs,
    results,
    baselineVmtOverride,
    setBaselineVmtOverride,
    baselineVmtNote,
    setBaselineVmtNote,
  } = useLayout();
  return (
    <div className="area-panel">
      <div className="area-intro">
        <h1>Start with your project area</h1>
        <p className="lede">
          The TDM Calculator estimates how much driving, vehicle miles traveled
          (VMT), that transportation demand management (TDM) strategies could
          reduce. Use it to screen strategies and produce defensible,
          source-backed estimates for plans and grant applications.
        </p>

        <h2 className="overline">How it works</h2>
        <ol className="how-steps">
          <li>
            <b>Area:</b> Select the traffic analysis zone (TAZ) shapes
            coinciding with your project location: click a TAZ to select it,
            <b> Shift-click</b> to add or remove others, or use <b>Draw area</b>{" "}
            to grab a whole region.
          </li>
          <li>
            <b>Strategies:</b> Add TDM strategies to a package and adjust each
            one to fit your project.
          </li>
          <li>
            <b>Results:</b> See the combined VMT reduction, broken out by
            strategy, with methodology you can cite.
          </li>
        </ol>
      </div>

      {selectedTazIds.size > 0 && (
        <BaselineVmtCard
          baselineVmt={results.baseline_vmt}
          derivedBaseline={tazInputs.reduce(
            (acc, t) => acc + (Number.isFinite(t.daily_vmt) ? t.daily_vmt : 0),
            0,
          )}
          override={baselineVmtOverride}
          setOverride={setBaselineVmtOverride}
          note={baselineVmtNote}
          setNote={setBaselineVmtNote}
        />
      )}

      <div className="cta">
        <button
          className="btn-next"
          disabled={selectedTazIds.size === 0}
          onClick={() => navigate("/strategies")}
        >
          Select strategies →
        </button>
        <p className="source-note">
          The calculator pre-fills baseline VMT, mode share, and density for the
          selection. Baseline data aggregates automatically from the Colorado
          Statewide Activity-Based Travel Model (StateFocus), the U.S. Census
          ACS, and CDOT public layers.
        </p>
      </div>
    </div>
  );
}

// ─── Project baseline VMT override card (area step) ──────────────────
// A compact "Project baseline VMT" control in the area rail. Shows the current
// baseline VMT (which already reflects any override) and a subtle pencil
// affordance that reveals a numeric input (NATIVE units = daily VMT, mi/day,
// no conversion) seeded from the current override if set, else the DERIVED
// baseline (sum of tazInputs[].daily_vmt), plus a strongly-encouraged "why"
// narrative. Mirrors the per-strategy context-override editor's visual language
// (pencil trigger, value box, narrative, "Modified" chip, reset-to-baseline).
function BaselineVmtCard({
  baselineVmt,
  derivedBaseline,
  override,
  setOverride,
  note,
  setNote,
}: {
  baselineVmt: number;
  derivedBaseline: number;
  override: number | null;
  setOverride: (v: number | null) => void;
  note: string;
  setNote: (v: string) => void;
}) {
  const isOverridden = override != null;
  // Editor opens automatically when an override is already set (so editing it
  // is one glance), else on clicking the pencil.
  const [open, setOpen] = useState(isOverridden);
  // Seed the edit box from the current override when set, else the derived
  // baseline. Kept as a string so the field can be cleared while typing.
  const seed = isOverridden ? override : derivedBaseline;
  const [draft, setDraft] = useState<string>(() =>
    Number.isFinite(seed) ? String(Math.round(seed)) : "",
  );

  const missingNarrative = isOverridden && note.trim().length === 0;
  const fmt = (n: number) =>
    Number.isFinite(n)
      ? Math.round(n).toLocaleString("en-US")
      : "–";

  function commitDraft(raw: string) {
    setDraft(raw);
    if (raw.trim() === "") return; // don't store an empty/NaN override mid-edit
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) return;
    setOverride(v);
  }

  function handleReset() {
    setOverride(null);
    setNote("");
    setDraft(Number.isFinite(derivedBaseline) ? String(Math.round(derivedBaseline)) : "");
    setOpen(false);
  }

  return (
    <div className={`baseline-card${isOverridden ? " is-overridden" : ""}`}>
      <div className="baseline-head">
        <span className="baseline-label">
          Project baseline VMT
          {isOverridden && <span className="baseline-chip">Modified</span>}
        </span>
        {!open && (
          <button
            type="button"
            className="baseline-ov-trigger"
            onClick={() => setOpen(true)}
            aria-label="Override the project baseline VMT"
            title="Override baseline VMT"
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
        )}
      </div>
      <div className="baseline-value">
        {fmt(baselineVmt)}
        <span className="baseline-unit">mi/day</span>
      </div>
      {/* Reference line: only shown once an override is active, so it explains
          what the (now overridden) headline replaced. When no override is set,
          the headline already IS the modeled baseline, so showing this would be
          redundant. */}
      {isOverridden && (
        <div className="baseline-modeled-ref">
          Modeled baseline (from your TAZs): {fmt(derivedBaseline)} mi/day
        </div>
      )}

      {open && (
        <div className="baseline-ov-edit">
          <label htmlFor="baseline-ov-input" className="baseline-ov-edit-label">
            Your project-specific baseline VMT
          </label>
          <div className="baseline-ov-field">
            <input
              id="baseline-ov-input"
              type="number"
              className="baseline-ov-input"
              value={draft}
              step={100}
              min={0}
              onChange={(e) => commitDraft(e.target.value)}
            />
            <span className="baseline-ov-unit">mi/day</span>
          </div>
          <p className="baseline-ov-hint">
            Replaces the modeled baseline of {fmt(derivedBaseline)} mi/day. The
            value above updates as you type.
          </p>

          <label htmlFor="baseline-ov-note" className="baseline-ov-note-label">
            Why are you overriding the baseline?
          </label>
          <textarea
            id="baseline-ov-note"
            className="baseline-ov-note"
            rows={2}
            placeholder="e.g. based on a new subdivision currently under development, or a recent local study"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {missingNarrative && (
            <div className="baseline-ov-warn" role="status">
              Add a short justification so this override is defensible in a grant
              application.
            </div>
          )}

          <div className="baseline-ov-actions">
            {isOverridden ? (
              <button
                type="button"
                className="baseline-ov-reset"
                onClick={handleReset}
              >
                Reset to modeled baseline
              </button>
            ) : (
              <button
                type="button"
                className="baseline-ov-cancel"
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

function ShopRoute() {
  const navigate = useNavigate();
  const { basket, selectedTazIds, justAdded, setJustAdded, openDetail } = useLayout();
  return (
    <ShopBody
      basket={basket}
      openDetail={openDetail}
      selectedCount={selectedTazIds.size}
      justAdded={justAdded}
      onDismissJustAdded={() => setJustAdded(null)}
      onViewResults={() => {
        setJustAdded(null);
        navigate("/cart");
      }}
      onPickArea={() => navigate("/area")}
    />
  );
}

function DetailRoute() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const {
    basket,
    workingValues,
    setWorkingValues,
    workingNotes,
    setWorkingNotes,
    workingContextOverrides,
    setWorkingContextOverrides,
    workingContextNotes,
    setWorkingContextNotes,
    seededDefaults,
    tazInputs,
    results,
    baselineVmtOverride,
    commitBasket,
    removeFromBasket,
  } = useLayout();

  // Unknown strategy id in URL → bounce back to the shop. Validate against the
  // catalog (isKnownStrategy), NOT STRATEGY_REGISTRY: the registry holds only
  // the code-backed strategies; closed-form (compute-block) ones are live too.
  if (!id || !isKnownStrategy(id)) {
    return <Navigate to="/strategies" replace />;
  }
  const strategyId = id as StrategyKey;

  return (
    <DetailView
      strategyId={strategyId}
      values={workingValues}
      setValues={setWorkingValues}
      notes={workingNotes}
      setNotes={setWorkingNotes}
      contextOverrides={workingContextOverrides}
      setContextOverrides={setWorkingContextOverrides}
      contextNotes={workingContextNotes}
      setContextNotes={setWorkingContextNotes}
      seededDefaults={seededDefaults}
      inBasket={basket.some((b) => b.id === strategyId)}
      tazInputs={tazInputs}
      baselineVmt={results.baseline_vmt}
      baselineVmtOverride={baselineVmtOverride}
      onBack={() => navigate("/strategies")}
      onAdd={() => commitBasket(strategyId, workingValues)}
      onRemove={() => {
        removeFromBasket(strategyId);
        navigate("/strategies");
      }}
    />
  );
}

function CartRoute() {
  const navigate = useNavigate();
  const {
    basket,
    results,
    tazInputs,
    selectedTazIds,
    baselineVmtOverride,
    baselineVmtNote,
    openDetail,
    removeFromBasket,
  } = useLayout();
  return (
    <CartView
      basket={basket}
      results={results}
      tazCount={selectedTazIds.size}
      tazInputs={tazInputs}
      baselineVmtOverride={baselineVmtOverride}
      baselineVmtNote={baselineVmtNote}
      onEdit={(id) => openDetail(id)}
      onRemove={(id) => removeFromBasket(id)}
      onBrowse={() => navigate("/strategies")}
      onExportPdf={() => navigate("/report")}
    />
  );
}

function ReportRoute() {
  const navigate = useNavigate();
  const {
    basket,
    results,
    tazInputs,
    selectedTazIds,
    baselineVmtOverride,
    baselineVmtNote,
  } = useLayout();
  return (
    <ReportView
      basket={basket}
      results={results}
      tazInputs={tazInputs}
      tazIds={[...selectedTazIds]}
      baselineVmtOverride={baselineVmtOverride}
      baselineVmtNote={baselineVmtNote}
      onBack={() => navigate("/cart")}
    />
  );
}
