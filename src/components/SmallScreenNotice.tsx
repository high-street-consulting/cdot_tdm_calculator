// Advisory shown on phone-width screens: the tool works here, but it was built
// for a desktop display.
//
// Deliberately NOT styled like .inputs-error-banner / .selection-cap-banner.
// Those are amber because something has gone wrong; nothing has gone wrong here,
// and borrowing the alarm colour for advice makes the real warnings cheaper.

import { useState } from "react";
import { useIsNarrowViewport } from "../hooks/useIsNarrowViewport";

/** Matches the 760px breakpoint in mobile.css where the layout restructures for
    phones. At 900px the rail merely collapses and the app is still comfortable,
    so warning there would be crying wolf. */
const SMALL_SCREEN_PX = 760;

const DISMISS_KEY = "cdot-tdm-small-screen-notice-dismissed";

/** Session-scoped so a reload does not re-nag, but a later visit still informs a
    first-time reader. localStorage would silence it permanently on a device the
    user may only occasionally use for this. */
function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false; // private mode / storage disabled — just show it.
  }
}

export function SmallScreenNotice() {
  const isSmall = useIsNarrowViewport(SMALL_SCREEN_PX);
  const [dismissed, setDismissed] = useState(readDismissed);

  if (!isSmall || dismissed) return null;

  return (
    <div className="small-screen-notice" role="status">
      <span>
        <b>Best on a desktop screen.</b> Everything works here, but the map and
        strategy panels have room to breathe on a larger display.
      </span>
      <button
        type="button"
        className="btn btn-sm btn-neutral"
        onClick={() => {
          setDismissed(true);
          try {
            sessionStorage.setItem(DISMISS_KEY, "1");
          } catch {
            /* Storage unavailable: dismissing still works for this page view. */
          }
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
