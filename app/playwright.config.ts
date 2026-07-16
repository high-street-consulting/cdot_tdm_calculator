import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// End-to-end tests for the CDOT TDM Calculator, run across the three browser
// engines the user base spans:
//   • Blink   → chromium            (Chrome / Edge / Brave / Opera share this engine)
//   • Gecko   → firefox
//   • WebKit  → webkit              (Safari)
//
// PLUS the real Chrome and Edge builds when installed — Edge is where the "can't
// select TAZs" bug was reported, so testing the actual Edge channel matters.
// Those channel projects are auto-added when the browser is detected on disk
// (any platform), or forced with PW_CHANNELS=1. Skip them with PW_NO_CHANNELS=1.
//
// Tests hit the LIVE public AGOL services (cdot.maps.arcgis.com / services.arcgis.com),
// so they require network access and are paced for a heavy WebGL map.
const anyExists = (paths: string[]) =>
  paths.some((p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });
const forceChannels = process.env.PW_CHANNELS === "1";
const noChannels = process.env.PW_NO_CHANNELS === "1";
const edgeInstalled =
  !noChannels &&
  (forceChannels ||
    anyExists([
      "/Applications/Microsoft Edge.app",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "/opt/microsoft/msedge/msedge",
    ]));
const chromeInstalled =
  !noChannels &&
  (forceChannels ||
    anyExists([
      "/Applications/Google Chrome.app",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "/opt/google/chrome/chrome",
    ]));

export default defineConfig({
  testDir: "./e2e",
  // The ArcGIS map + live feature-layer queries are slow to settle.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: process.env.CI ? 1 : 2,
  retries: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:5180",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
  projects: [
    { name: "chromium-blink", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox-gecko", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    // Real browser channels, auto-added when installed. `msedge` exercises the
    // actual Edge build where the TAZ-selection bug was reported.
    ...(chromeInstalled
      ? [{ name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } }]
      : []),
    ...(edgeInstalled
      ? [{ name: "msedge", use: { ...devices["Desktop Edge"], channel: "msedge" } }]
      : []),
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5180",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
