// Build-stamp env vars injected at build time by the `build` npm script and
// read via import.meta.env. Not shown in the UI; inspect via the browser
// console or `window.__BUILD__` to confirm which build is live.
interface ImportMetaEnv {
  readonly VITE_BUILD_SHA?: string;
  readonly VITE_BUILD_TIME?: string;
}

interface Window {
  __BUILD__?: { sha: string; time: string };
}
