// Generates public/THIRD-PARTY-LICENSES.txt from the PRODUCTION dependency tree.
//
// Why this exists: the source repo only *references* its dependencies, but the
// built bundle in dist/ contains them compiled in — and that bundle is what we
// hand to CDOT for IIS hosting and deploy to Cloudflare. MIT, BSD, ISC and
// Apache-2.0 all require their copyright notice to travel with copies or
// substantial portions of the work, so the artifact has to carry these notices.
// Two dependencies go further and are called out at the top of the output:
// Esri's stack is proprietary (Master License Agreement, redistribution allowed
// unmodified with the notice attached) and amCharts 5 is "linkware", which
// explicitly requires its LICENSE file to ship alongside.
//
// Written into public/ rather than dist/ so Vite copies it verbatim on every
// build, and so it is reviewable in the repo. Regenerate with:
//   npm run licenses:third-party
// It runs automatically as part of prebuild / build:cf.
//
// Scope is deliberately `npm ls --omit=dev`: devDependencies (Vite, TypeScript,
// Playwright, Vitest) are build tooling and are never distributed.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(APP_DIR, "public", "THIRD-PARTY-LICENSES.txt");

/** Filenames a package might use for its license text, in preference order. */
const LICENSE_FILES = [
  "LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md", "license.txt",
  "LICENCE", "LICENCE.md", "LICENCE.txt", "COPYING", "COPYING.md",
];

/** Packages whose terms go beyond "keep the notice" and deserve prominence. */
const HIGHLIGHTED = {
  "@arcgis/core":
    "Esri proprietary (Master License Agreement). Redistribution of the\n" +
    "    unmodified library is permitted under the MLA with this notice attached;\n" +
    "    it is NOT an open-source license. Building or running this project\n" +
    "    requires appropriate Esri entitlement.",
  "@amcharts/amcharts5":
    "\"Linkware\" license. Free to bundle, including commercially, on the\n" +
    "    conditions that this LICENSE text ships with the distribution and that\n" +
    "    the amCharts branding link on generated content is not hidden or altered.\n" +
    "    Reaches the bundle transitively via @arcgis/core's popup charts.",
};

function productionPackagePaths() {
  // `npm ls` exits non-zero on peer-dependency warnings; the tree on stdout is
  // still valid, so never let that fail the build.
  let out = "";
  try {
    out = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], {
      cwd: APP_DIR,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    out = err.stdout ?? "";
  }
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function normalizeLicense(pkg) {
  const { license, licenses } = pkg;
  if (typeof license === "string") return license;
  if (license && typeof license === "object" && license.type) return license.type;
  if (Array.isArray(licenses) && licenses.length) {
    return licenses.map((l) => (typeof l === "string" ? l : l.type)).filter(Boolean).join(" OR ");
  }
  return null;
}

function readLicenseText(dir) {
  for (const name of LICENSE_FILES) {
    const p = join(dir, name);
    if (existsSync(p)) {
      try { return readFileSync(p, "utf8").trim(); } catch { /* unreadable */ }
    }
  }
  // Some packages ship the text in a licenses/ directory instead.
  const licDir = join(dir, "licenses");
  if (existsSync(licDir)) {
    try {
      const files = readdirSync(licDir).filter((f) => /licen[cs]e/i.test(f));
      if (files.length) return readFileSync(join(licDir, files[0]), "utf8").trim();
    } catch { /* ignore */ }
  }
  return null;
}

const packages = new Map();
for (const dir of productionPackagePaths()) {
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) continue;
  let meta;
  try { meta = JSON.parse(readFileSync(pj, "utf8")); } catch { continue; }
  if (!meta.name) continue;
  // Skip this application's own package entry.
  if (meta.name === "cdot-tdm-calculator") continue;
  packages.set(meta.name, {
    name: meta.name,
    version: meta.version ?? "",
    license: normalizeLicense(meta) ?? "(not declared in package.json)",
    homepage: meta.homepage ?? (typeof meta.repository === "string" ? meta.repository : meta.repository?.url) ?? "",
    text: readLicenseText(dir),
  });
}

const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));

const counts = sorted.reduce((acc, p) => {
  acc[p.license] = (acc[p.license] ?? 0) + 1;
  return acc;
}, {});

const rule = "=".repeat(78);
const lines = [];

lines.push(rule);
lines.push("THIRD-PARTY SOFTWARE NOTICES");
lines.push("CDOT TDM Calculator");
lines.push(rule);
lines.push("");
lines.push("The CDOT TDM Calculator itself is licensed under the Apache License 2.0");
lines.push("(see LICENSE in the source repository).");
lines.push("");
lines.push("This file lists the third-party packages compiled into the distributed");
lines.push("application bundle, with their licenses and copyright notices. Build-only");
lines.push("tooling (devDependencies) is excluded: it is not distributed.");
lines.push("");
lines.push(`Generated from the production dependency tree — ${sorted.length} packages.`);
lines.push("Regenerate with: npm run licenses:third-party");
lines.push("");
lines.push("License summary:");
for (const [lic, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  lines.push(`  ${String(n).padStart(4)}  ${lic}`);
}
lines.push("");

const highlighted = sorted.filter((p) => HIGHLIGHTED[p.name]);
if (highlighted.length) {
  lines.push(rule);
  lines.push("NOTICES REQUIRING PARTICULAR ATTENTION");
  lines.push(rule);
  lines.push("");
  for (const p of highlighted) {
    lines.push(`  ${p.name}@${p.version}`);
    lines.push(`    ${HIGHLIGHTED[p.name]}`);
    lines.push("");
  }
}

lines.push(rule);
lines.push("PACKAGES");
lines.push(rule);
lines.push("");

for (const p of sorted) {
  lines.push("-".repeat(78));
  lines.push(`${p.name}@${p.version}`);
  lines.push(`License: ${p.license}`);
  if (p.homepage) lines.push(`Homepage: ${p.homepage.replace(/^git\+/, "").replace(/\.git$/, "")}`);
  lines.push("");
  lines.push(p.text ?? "  [No license text file shipped with this package. The license identifier\n   above is taken from its package.json.]");
  lines.push("");
}

writeFileSync(OUT, lines.join("\n") + "\n", "utf8");

const kb = Math.round(Buffer.byteLength(lines.join("\n"), "utf8") / 1024);
const missing = sorted.filter((p) => !p.text).length;
console.log(
  `licenses:third-party — ${sorted.length} production packages → public/THIRD-PARTY-LICENSES.txt (${kb} KB)` +
    (missing ? `; ${missing} without a bundled license text file` : ""),
);
