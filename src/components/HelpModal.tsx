// Help & resources modal, opened from the (?) Help button in the header.
// Built on the native <dialog> element (like ConfirmModal) so the browser
// handles focus trap, ESC-to-close, and the inert background.
//
// Both assets are live: the overview video and the user guide ship from public/
// and are served by the app itself — no third-party embed, so nothing here
// phones home to YouTube or sets a cookie.

import { useEffect, useRef } from "react";

// ── Asset URLs ───────────────────────────────────────────────────────────
// All served from public/, so each must carry BASE_URL: the app is deployed
// both at a root ("/") on Cloudflare and under a subpath on IIS, and a
// hardcoded "/..." 404s on the latter.
//
// The MP4 is H.264/AAC 1280x720, re-encoded to ~5.9 MiB. Cloudflare Workers
// Static Assets caps an individual file at 25 MiB and the 30 MiB original
// would have been rejected at deploy.
const TUTORIAL_VIDEO_URL = `${import.meta.env.BASE_URL}overview_video.mp4`;
const TUTORIAL_VIDEO_POSTER = `${import.meta.env.BASE_URL}overview_video_poster.jpg`;
const TUTORIAL_VIDEO_CAPTIONS = `${import.meta.env.BASE_URL}overview_video.vtt`;
// Leave "" to fall back to the "coming soon" note.
const USER_GUIDE_URL = `${import.meta.env.BASE_URL}CDOT-TDM-Calculator-User-Guide.pdf`;

/**
 * Transcript of the narration, as a text alternative to the video (WCAG 2.1
 * 1.2.3). Captions cover the same words on-screen; this is the readable copy
 * for anyone who would rather not watch 90 seconds of screencast.
 *
 * Kept in step with public/overview_video.vtt — both were produced from one
 * transcription pass, so regenerate them together if the video is re-cut.
 */
const TRANSCRIPT: Array<[string, string]> = [
  ["0:00", "The Travel Demand Management Calculator provides a catalog of strategies that can be adapted to reduce vehicle miles traveled."],
  ["0:09", "Before getting started, review the What You'll Need section for strategies of interest to ensure you have all necessary information."],
  ["0:22", "To begin, select one or more traffic analysis zones corresponding to the geography of your project."],
  ["0:29", "Then, choose one or more strategies to model."],
  ["0:34", "Find relevant strategies by filtering based on category, tag, or keyword."],
  ["0:39", "We'll begin by configuring the employer-provided commute benefits. Let's assume that each transit trip costs $3 and that 50% of area employers participate in the program."],
  ["0:55", "Next, we'll configure the workplace parking pricing. Let's assume that workplace pricing increases to $12 per day."],
  ["1:11", "After adding to the cart, click View Results to be taken to the results screen to see the impact of these strategies."],
  ["1:18", "You can download a CSV with full calculations and underlying data, or export a PDF to share."],
  ["1:26", "For more details, see the attached user guide."],
];
// ──────────────────────────────────────────────────────────────────────────

interface HelpModalProps {
  open: boolean;
  onClose: () => void;
}

export function HelpModal({ open, onClose }: HelpModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Drive the native <dialog> imperatively to match the open prop.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      requestAnimationFrame(() => closeBtnRef.current?.focus());
    } else if (!open && d.open) {
      d.close();
      // Closing the dialog only hides it — a playing video would keep going,
      // audible and invisible, until the modal was reopened.
      const v = videoRef.current;
      if (v && !v.paused) v.pause();
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
          <h3 className="help-section-title">Overview video</h3>
          <div className="help-video">
            {/* preload="metadata": fetch the duration, not 5.9 MiB, for the
                many people who open Help and never press play. */}
            <video
              ref={videoRef}
              controls
              preload="metadata"
              poster={TUTORIAL_VIDEO_POSTER}
              playsInline
            >
              <source src={TUTORIAL_VIDEO_URL} type="video/mp4" />
              <track
                kind="captions"
                src={TUTORIAL_VIDEO_CAPTIONS}
                srcLang="en"
                label="English"
                default
              />
              Your browser cannot play this video. The transcript below covers
              the same material.
            </video>
          </div>
          <p className="help-muted">1 min 34 sec · captions and transcript included</p>

          {/* Text alternative (WCAG 2.1 1.2.3). Collapsed so it does not push
              the user guide below the fold, but it is real text in the DOM —
              searchable, selectable, and reachable by a screen reader. */}
          <details className="help-transcript">
            <summary>Read the transcript</summary>
            <dl>
              {TRANSCRIPT.map(([time, text]) => (
                <div key={time}>
                  <dt>{time}</dt>
                  <dd>{text}</dd>
                </div>
              ))}
            </dl>
          </details>
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
              <p className="help-muted">PDF · 11 pages · 1.1 MB · opens in a new tab</p>
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
