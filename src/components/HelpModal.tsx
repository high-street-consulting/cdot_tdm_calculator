// Help & resources modal, opened from the (?) Help button in the header.
// Built on the native <dialog> element (like ConfirmModal) so the browser
// handles focus trap, ESC-to-close, and the inert background.
//
// The user guide link is live (public/CDOT-TDM-Calculator-User-Guide.pdf); the
// tutorial video is still a placeholder. Drop the embed URL into the constant
// below and the placeholder is automatically replaced by the live embed, with
// no other code changes needed.

import { useEffect, useRef } from "react";

// ── Configure these when the assets exist ────────────────────────────────
// Tutorial video: a privacy-friendly EMBED url (not the watch page). For
// YouTube use the no-cookie embed form, e.g.
//   "https://www.youtube-nocookie.com/embed/VIDEO_ID"
// Leave "" to show the "coming soon" placeholder.
const TUTORIAL_VIDEO_EMBED_URL = "";
// Full user guide: a link opened in a new tab (PDF or web page). Leave "" to
// show the "coming soon" note. Served from public/, so it must carry BASE_URL —
// the app is deployed both at a root ("/") and under a subpath on IIS.
const USER_GUIDE_URL = `${import.meta.env.BASE_URL}CDOT-TDM-Calculator-User-Guide.pdf`;
// ──────────────────────────────────────────────────────────────────────────

interface HelpModalProps {
  open: boolean;
  onClose: () => void;
}

export function HelpModal({ open, onClose }: HelpModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Drive the native <dialog> imperatively to match the open prop.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      requestAnimationFrame(() => closeBtnRef.current?.focus());
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="help-modal"
      aria-labelledby="help-modal-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // Click on the backdrop (the dialog element itself) closes it.
        if (e.target === dialogRef.current) onClose();
      }}
    >
      <div className="help-modal-inner">
        <button
          ref={closeBtnRef}
          type="button"
          className="help-modal-close"
          aria-label="Close help"
          onClick={onClose}
        >
          ×
        </button>

        <h2 id="help-modal-title" className="help-modal-title">Help &amp; resources</h2>
        <p className="help-modal-intro">
          New to the TDM Calculator? Watch the quick tutorial, or open the full
          user guide for step-by-step instructions.
        </p>

        <section className="help-section">
          <h3 className="help-section-title">Tutorial video</h3>
          {TUTORIAL_VIDEO_EMBED_URL ? (
            <div className="help-video">
              <iframe
                src={TUTORIAL_VIDEO_EMBED_URL}
                title="TDM Calculator tutorial"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
          ) : (
            <div className="help-video help-video--placeholder" aria-hidden="true">
              <span className="help-placeholder-icon">▶</span>
              <span>Tutorial video coming soon</span>
            </div>
          )}
        </section>

        <section className="help-section">
          <h3 className="help-section-title">User guide</h3>
          {USER_GUIDE_URL ? (
            <>
              <a
                className="btn btn-brand"
                href={USER_GUIDE_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open the full user guide ↗
              </a>
              {/* Say what the link costs before it is followed — a bare "↗" on a
                  3 MB download is a poor deal on a phone or a metered connection. */}
              <p className="help-muted">PDF · 11 pages · 3 MB · opens in a new tab</p>
            </>
          ) : (
            <p className="help-muted">The full user guide will be available here soon.</p>
          )}
        </section>

        <div className="help-modal-actions">
          <button type="button" className="btn btn-neutral" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
