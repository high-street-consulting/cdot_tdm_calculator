// "Reference layers" picker for the TAZ selection map.
//
// Renders nothing at all when no layer is available, which is the required
// degraded state: if every source is unreachable the feature is simply absent
// rather than showing an empty or broken control.
//
// Collapsed by default so it stays out of the way of the selection tools; the
// count of enabled layers is shown on the toggle so state is legible while closed.

import { useId, useState } from "react";
import type { ProbedReferenceLayer } from "../data/referenceLayers";

interface ReferenceLayersProps {
  /** Only the layers that loaded. Empty renders nothing. */
  available: ProbedReferenceLayer[];
  /** Ids currently switched on. */
  enabled: Set<string>;
  onToggle: (id: string, on: boolean) => void;
}

export function ReferenceLayers({
  available,
  enabled,
  onToggle,
}: ReferenceLayersProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  if (available.length === 0) return null;

  const onCount = available.filter((a) => enabled.has(a.def.id)).length;

  return (
    <div className="map-reflayers">
      <button
        type="button"
        className={`map-tool ${onCount > 0 ? "active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        title="Show optional context layers on the map. These are for reference only and never change your results."
      >
        Reference layers{onCount > 0 ? ` (${onCount})` : ""}
      </button>
      {open && (
        <div className="map-reflayers-panel" id={panelId}>
          <p className="map-reflayers-note">
            Context only. These never affect your selection or results, and they
            draw beneath the zone boundaries.
          </p>
          {/* No colour swatch: each layer draws in its publisher's own symbology,
              which for World Transit Lines is multi-colour by mode, so a single
              swatch would misrepresent it. Hover text names the colours instead. */}
          {available.map(({ def }) => (
            <label key={def.id} className="map-reflayers-item" title={def.hint}>
              <input
                type="checkbox"
                checked={enabled.has(def.id)}
                onChange={(e) => onToggle(def.id, e.target.checked)}
              />
              <span>{def.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
