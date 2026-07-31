// Build the self-contained static package CDOT hosts on IIS.
//
//   node scripts/package-iis.mjs [outDir]     (default: ../handoff)
//
// Produces  <outDir>/cdot-tdm-calculator_<sha>_<date>_iis.zip  containing a single
// cdot-tdm-calculator-iis/ folder: the built app, deploy/iis/web.config, and
// deploy/iis/README.txt with its {{PLACEHOLDERS}} filled from the actual build.
//
// Two things differ from the Cloudflare build, both deliberate:
//
//   --base=./      Relative asset URLs, so the same package works at a site root
//                  OR inside a virtual directory with no rebuild. Safe because the
//                  app uses hash routing: the document path never changes, so
//                  relative URLs always resolve. (Request the directory WITH a
//                  trailing slash; IIS normally redirects to add it.)
//   --sourcemap false
//                  Drops ~35 MB of maps and avoids shipping source to a
//                  third-party-hosted server.
//
// Everything else — the licence notices in public/, the catalog sync — comes from
// the normal build, so the package cannot drift from what the app actually ships.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_ROOT = resolve(process.argv[2] ?? join(ROOT, "..", "handoff"));
const FOLDER = "cdot-tdm-calculator-iis";

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: "pipe", ...opts });

const sha = run("git", ["rev-parse", "--short", "HEAD"]).trim();
const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
const dirty = run("git", ["status", "--porcelain"]).trim();
if (dirty) {
  console.warn("  WARNING: working tree is dirty; the package will not match "
    + `commit ${sha} exactly.`);
}
const date = new Date().toISOString().slice(0, 10);
const stage = join(OUT_ROOT, `_stage_${sha}`);
const pkgDir = join(stage, FOLDER);

console.log(`  Building ${sha} (${branch}) for IIS ...`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(pkgDir, { recursive: true });

// Same pipeline as build:cf (catalog sync + licences + typecheck), different flags.
run("npm", ["run", "sync:catalog"]);
run("npm", ["run", "licenses:third-party"]);
run("npx", ["tsc", "-b", "--noEmit"]);
run("npx", [
  "vite", "build",
  "--base=./",
  "--sourcemap", "false",
  "--outDir", pkgDir,
  "--emptyOutDir",
], {
  env: {
    ...process.env,
    NODE_OPTIONS: "--max-old-space-size=4096",
    VITE_BUILD_SHA: sha,
    VITE_BUILD_TIME: new Date().toISOString().slice(0, 16) + "Z",
  },
});

cpSync(join(ROOT, "deploy/iis/web.config"), join(pkgDir, "web.config"));

const count = (dir) =>
  run("bash", ["-c", `find ${JSON.stringify(dir)} -type f | wc -l`]).trim();
const mb = (dir) =>
  (Number(run("bash", ["-c", `find ${JSON.stringify(dir)} -type f -exec cat {} + | wc -c`]).trim())
    / 1048576).toFixed(1);

const zipName = `cdot-tdm-calculator_${sha}_${date}_iis.zip`;
const zipPath = join(OUT_ROOT, zipName);

// README needs the zip size, so template it after a first pass, then rezip.
const writeReadme = (zipMb) => {
  const tpl = readFileSync(join(ROOT, "deploy/iis/README.txt"), "utf8");
  writeFileSync(join(pkgDir, "README.txt"), tpl
    .replaceAll("{{COMMIT}}", sha)
    .replaceAll("{{BRANCH}}", branch)
    .replaceAll("{{BUILT}}", date)
    .replaceAll("{{FILES}}", count(pkgDir))
    .replaceAll("{{SIZE_MB}}", mb(pkgDir))
    .replaceAll("{{ZIP_MB}}", zipMb));
};

writeReadme("~4");
rmSync(zipPath, { force: true });
run("bash", ["-c", `cd ${JSON.stringify(stage)} && zip -rq ${JSON.stringify(zipPath)} ${FOLDER} -x '*/.DS_Store'`]);
const zipMb = (Number(run("bash", ["-c", `wc -c < ${JSON.stringify(zipPath)}`]).trim()) / 1048576).toFixed(1);
writeReadme(zipMb);
rmSync(zipPath, { force: true });
run("bash", ["-c", `cd ${JSON.stringify(stage)} && zip -rq ${JSON.stringify(zipPath)} ${FOLDER} -x '*/.DS_Store'`]);

run("bash", ["-c", `unzip -tq ${JSON.stringify(zipPath)}`]);
console.log(`  Files    : ${count(pkgDir)}  (${mb(pkgDir)} MB on disk)`);
console.log(`  Package  : ${zipPath} (${zipMb} MB, integrity OK)`);
console.log(`  Staged at: ${stage}  — serve it to smoke-test, then delete`);
if (!existsSync(join(pkgDir, "THIRD-PARTY-LICENSES.txt"))) {
  console.warn("  WARNING: THIRD-PARTY-LICENSES.txt missing from the package.");
}
