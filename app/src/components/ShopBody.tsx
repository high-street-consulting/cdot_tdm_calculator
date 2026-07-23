// Strategy picker. Sidebar filters by category and tags; main grid shows
// strategies, sortable by name / category / id.

import { useEffect, useMemo, useState } from "react";
import { CATEGORIES, getStrategy, STRATEGIES, type StrategyCategoryId, type StrategyMeta } from "../strategies/registry";
import { CATALOG } from "../strategies/catalog";
import type { BasketEntry } from "../strategies/compute";
import type { StrategyKey } from "../strategies/strategies";
import { CategoryIcon } from "./CategoryIcon";

interface ShopBodyProps {
  basket: BasketEntry[];
  openDetail: (id: StrategyKey) => void;
  selectedCount: number;
  justAdded: StrategyKey | null;
  onDismissJustAdded: () => void;
  onViewResults: () => void;
  onPickArea: () => void;
}

type SortKey = "name" | "category" | "uid";

// Left-panel tag facets, grouped under these labels.
const FACET_LABELS: Record<string, string> = {
  audience: "Audience",
  lever: "Lever",
  trip_purpose: "Trip purpose",
  mode: "Mode",
  context: "Context",
};

// Acronyms that should stay uppercase (CSS `text-transform: capitalize` on the
// chip leaves already-uppercase letters alone, so "MPO" renders as "MPO").
const TAG_ACRONYMS: Record<string, string> = { mpo: "MPO", dot: "DOT" };
const prettyTag = (t: string) =>
  t.split("-").map((w) => TAG_ACRONYMS[w] ?? w).join(" ");

// Tag filter: "matches any". A strategy is shown if it carries at least one
// of the selected tags, regardless of facet.
function matchesTags(s: StrategyMeta, selected: Set<string>): boolean {
  if (selected.size === 0) return true;
  return (s.tags ?? []).some((t) => selected.has(t));
}

export function ShopBody({
  basket,
  openDetail,
  selectedCount,
  justAdded,
  onDismissJustAdded,
  onViewResults,
  onPickArea,
}: ShopBodyProps) {
  const [catFilter, setCatFilter] = useState<StrategyCategoryId | null>(null);
  const [query, setQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<SortKey>("name");

  const inBasket = useMemo(() => new Set(basket.map((b) => b.id)), [basket]);
  const basketCountByCat = useMemo(() => {
    const m: Record<string, number> = {};
    for (const b of basket) {
      const s = STRATEGIES.find((x) => x.id === b.id);
      if (s) m[s.category] = (m[s.category] ?? 0) + 1;
    }
    return m;
  }, [basket]);

  // Tags actually used by at least one live strategy, plus per-tag counts.
  const { usedTags, tagCounts } = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of STRATEGIES) for (const t of s.tags ?? []) counts[t] = (counts[t] ?? 0) + 1;
    return { usedTags: new Set(Object.keys(counts)), tagCounts: counts };
  }, []);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = STRATEGIES.filter((s) => {
      if (catFilter && s.category !== catFilter) return false;
      if (!matchesTags(s, selectedTags)) return false;
      if (!q) return true;
      return (
        s.displayName.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        (s.uid ?? "").toLowerCase().includes(q) ||
        s.method.toLowerCase().includes(q) ||
        (s.tags ?? []).some((t) => t.toLowerCase().includes(q)) ||
        (CATEGORIES.find((c) => c.id === s.category)?.name ?? "").toLowerCase().includes(q)
      );
    });
    const catIndex = (id: StrategyCategoryId) => CATEGORIES.findIndex((c) => c.id === id);
    return filtered.sort((a, b) => {
      if (sortBy === "category") {
        const d = catIndex(a.category) - catIndex(b.category);
        if (d !== 0) return d;
        return a.displayName.localeCompare(b.displayName);
      }
      if (sortBy === "uid") return (a.uid ?? "").localeCompare(b.uid ?? "");
      return a.displayName.localeCompare(b.displayName);
    });
  }, [query, catFilter, selectedTags, sortBy]);

  const hasFilters = catFilter !== null || query.trim() !== "" || selectedTags.size > 0;

  const toggleTag = (t: string) =>
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  const clearFilters = () => {
    setQuery("");
    setCatFilter(null);
    setSelectedTags(new Set());
    setSortBy("name");
  };

  return (
    <div className="shop-body">
      <aside className="shop-aside">
        <h2 className="aside-title">Filter strategies</h2>
        <h3>Categories</h3>
        <div className="cat-nav">
          <button className={!catFilter ? "on" : ""} onClick={() => setCatFilter(null)}>
            <span
              className="cat-ic"
              style={{ background: "#F2F2F2", color: "#6B6B6B" }}
              aria-hidden="true"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z" />
              </svg>
            </span>
            <span>All strategies</span>
            <span className="n">{STRATEGIES.length}</span>
          </button>
          {CATEGORIES.map((c) => {
            const n = STRATEGIES.filter((s) => s.category === c.id).length;
            if (n === 0) return null;
            const inB = basketCountByCat[c.id] ?? 0;
            return (
              <button
                key={c.id}
                className={catFilter === c.id ? "on" : ""}
                onClick={() => setCatFilter(catFilter === c.id ? null : c.id)}
              >
                <span
                  className="cat-ic"
                  style={{ background: `color-mix(in srgb, ${c.cssColorVar} 14%, #fff)`, color: c.cssColorVar }}
                >
                  <CategoryIcon cat={c.id} size={16} />
                </span>
                <span>
                  {c.name}
                  {inB > 0 && (
                    <span style={{ display: "block", fontSize: 10, color: "var(--cdot-green)", fontWeight: 600 }}>
                      {inB} in basket
                    </span>
                  )}
                </span>
                <span className="n">{n}</span>
              </button>
            );
          })}
        </div>

        <h3>Tags</h3>
        <div className="tag-facets">
          {Object.entries(CATALOG.tag_catalog).map(([facet, tags]) => {
            const used = tags
              .filter((t) => usedTags.has(t))
              .sort((a, b) => prettyTag(a).localeCompare(prettyTag(b)));
            if (used.length === 0) return null;
            return (
              <div className="tag-group" key={facet}>
                <div className="tag-group-label">{FACET_LABELS[facet] ?? facet}</div>
                <div className="tag-chips">
                  {used.map((t) => {
                    const on = selectedTags.has(t);
                    return (
                      <button
                        key={t}
                        type="button"
                        className={`tag-chip ${on ? "on" : ""}`}
                        onClick={() => toggleTag(t)}
                        aria-pressed={on}
                      >
                        {prettyTag(t)}
                        <span className="tc">{tagCounts[t] ?? 0}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {hasFilters && (
          <button type="button" className="link-btn clear-filters" onClick={clearFilters}>
            Clear all filters
          </button>
        )}

        {selectedCount === 0 && (
          <div className="shop-aside-status">
            <button type="button" className="link-btn" onClick={onPickArea}>
              Pick a project area
            </button>{" "}
            to enable strategies.
          </div>
        )}
      </aside>
      <div className="shop-main">
        {justAdded && (
          <AddedBanner
            key={justAdded}
            strategyId={justAdded}
            basketCount={basket.length}
            onDismiss={onDismissJustAdded}
            onViewResults={onViewResults}
          />
        )}
        <div className="shop-head">
          <div>
            <h1>Select TDM strategies</h1>
            <div className="sub">
              Click a strategy to configure inputs and add to your package.
            </div>
          </div>
          <label className="sort">
            Sort
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortKey)}>
              <option value="name">Name (A–Z)</option>
              <option value="category">Category</option>
              <option value="uid">ID</option>
            </select>
          </label>
        </div>
        <div className="shop-search">
          <span className="ic" aria-hidden="true">⌕</span>
          <label htmlFor="shop-search-input" className="sr-only">
            Search strategies
          </label>
          <input
            id="shop-search-input"
            placeholder="Search strategies by name, category, tag, or methodology…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="shop-search-clr"
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>
        <div className="shop-result-count">
          {items.length} of {STRATEGIES.length} strategies
        </div>
        <div className="product-grid">
          {items.map((s) => (
            <ProductCard
              key={s.id}
              s={s}
              inBasket={inBasket.has(s.id)}
              onOpen={() => openDetail(s.id)}
            />
          ))}
        </div>
        {items.length === 0 && (
          <div className="shop-empty">
            <div className="shop-empty-icon" aria-hidden="true">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" strokeLinecap="round" />
              </svg>
            </div>
            <h2>No strategies match your filters</h2>
            <p>
              Try a different search term, category, or tag, or clear the filters
              to see all {STRATEGIES.length} modeled strategies.
            </p>
            <button
              type="button"
              className="btn-outline"
              onClick={clearFilters}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Confirmation banner shown at the top of the shop view after a strategy
// is added/updated. Auto-dismisses after 7 seconds (matches the design's
// banner-progress keyframe duration); manual × dismiss also supported.
function AddedBanner({
  strategyId,
  basketCount,
  onDismiss,
  onViewResults,
}: {
  strategyId: StrategyKey;
  basketCount: number;
  onDismiss: () => void;
  onViewResults: () => void;
}) {
  const meta = getStrategy(strategyId);
  const cat = CATEGORIES.find((c) => c.id === meta.category);
  useEffect(() => {
    const t = setTimeout(onDismiss, 7000);
    return () => clearTimeout(t);
  }, [onDismiss]);
  return (
    <div className="added-banner" role="status">
      <span
        className="added-banner-swatch"
        style={{ background: cat?.cssColorVar ?? "var(--cdot-green)" }}
      />
      <span className="added-banner-icon" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 14.59l-4.3-4.3 1.42-1.41L11 13.76l5.88-5.88 1.42 1.42z" />
        </svg>
      </span>
      <div className="added-banner-body">
        <span className="added-banner-name">{meta.displayName}</span>
        <span className="added-banner-sub">
          {" "}added to your package · {basketCount} strateg{basketCount === 1 ? "y" : "ies"} total
        </span>
      </div>
      <button type="button" className="added-banner-cta" onClick={onViewResults}>
        View results →
      </button>
      <button
        type="button"
        className="added-banner-dismiss"
        onClick={onDismiss}
        title="Dismiss"
        aria-label="Dismiss notification"
      >
        ×
      </button>
      <div className="added-banner-progress" />
    </div>
  );
}

function ProductCard({
  s,
  inBasket,
  onOpen,
}: {
  s: StrategyMeta;
  inBasket: boolean;
  onOpen: () => void;
}) {
  const cat = CATEGORIES.find((c) => c.id === s.category);
  // Keyboard accessibility: the card is the primary control for opening a
  // strategy, so it must be focusable and operable with Enter/Space (not just
  // a mouse click). role="button" + tabIndex + onKeyDown gives it native-button
  // semantics without breaking the card's flex layout.
  const ariaLabel = `${s.displayName}, ${cat?.name ?? ""}${
    inBasket ? ", in your package" : ""
  }. Open to configure and add to package.`;
  return (
    <div
      className={`product-card ${inBasket ? "in-basket" : ""} ${s.isInduced ? "warn" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
          e.preventDefault(); // Space would otherwise scroll the page
          onOpen();
        }
      }}
    >
      <div className="band" style={{ background: cat?.cssColorVar }} />
      <div className="body">
        <div className="name-row" style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <span
            className="card-cat-ic"
            style={{
              background: `color-mix(in srgb, ${cat?.cssColorVar ?? "#888"} 14%, #fff)`,
              color: cat?.cssColorVar ?? "#888",
              flexShrink: 0,
              width: 32,
              height: 32,
              borderRadius: 4,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              marginTop: 1,
            }}
            aria-hidden="true"
          >
            <CategoryIcon cat={s.category} size={20} />
          </span>
          <div className="name" style={{ flex: 1, minWidth: 0 }}>{s.displayName}</div>
          {inBasket && <span className="in-basket-dot">✓</span>}
        </div>
        <div className="desc-row">
          <div className="desc">{s.description}</div>
        </div>
        {(s.tags ?? []).length > 0 && (
          <div className="card-tags">
            {(s.tags ?? []).map((t) => (
              <span key={t} className="card-tag">{prettyTag(t)}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
