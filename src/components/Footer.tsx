// Thin app-wide footer (~45 px). Rendered at the App level on every
// view except the map (Area). One-line layout, full-bleed.

export function Footer() {
  return (
    <footer className="app-footer">
      <div className="app-footer-left">
        2026 Colorado Department of Transportation
        <span className="app-footer-sep" aria-hidden="true"> · </span>
        <a
          href="https://www.codot.gov/topcontent/accessibility"
          target="_blank"
          rel="noreferrer"
        >
          Accessibility
        </a>
        <span className="app-footer-sep" aria-hidden="true"> · </span>
        <a
          href="https://github.com/high-street-consulting/cdot_tdm_calculator"
          target="_blank"
          rel="noreferrer"
        >
          Source code
        </a>
      </div>
      <div className="app-footer-right">
        Built for Office of Innovative Mobility by{" "}
        <a
          href="https://highstreetconsulting.com"
          target="_blank"
          rel="noreferrer"
        >
          High Street
        </a>{" "}
        +{" "}
        <a href="https://www.fhueng.com" target="_blank" rel="noreferrer">
          Felsburg Holt &amp; Ullevig
        </a>
      </div>
    </footer>
  );
}
