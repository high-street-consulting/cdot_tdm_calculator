import ReactDOM from "react-dom/client";

import "./styles/colors_and_type.css";
import "./styles/brand.css";
import "./styles/app.css";
import "./styles/shop.css";
import "./styles/report.css";
import "./styles/print.css";

import { App } from "./App";

// Build stamp (not rendered in the UI): log it and expose it on window so the
// live build is identifiable from the console, e.g. `window.__BUILD__`.
// Injected at build time via VITE_BUILD_* env vars (see the `build` npm script).
const buildSha = import.meta.env.VITE_BUILD_SHA ?? "dev";
const buildTime = import.meta.env.VITE_BUILD_TIME ?? "local";
window.__BUILD__ = { sha: buildSha, time: buildTime };
console.info(`CDOT TDM Calculator · build ${buildSha} · ${buildTime}`);

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");
// NOTE: StrictMode disabled in dev because the ArcGIS MapView is not
// resilient to React's intentional double-mount in development. We need the
// view instance to persist across effect tear-down + re-mount; StrictMode
// triggers a destroy that's hard to undo cleanly. Re-enable for prod.
ReactDOM.createRoot(rootEl).render(<App />);
