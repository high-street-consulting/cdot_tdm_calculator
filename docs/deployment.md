# Deploying the TDM Calculator

The calculator is a **static Vite SPA** built from this repository root. It uses **HashRouter** (routes
like `#/area`), so it needs **no server-side URL rewriting** on any host; a
plain file copy is enough. The @arcgis/core SDK loads its own worker/WASM/i18n
assets from Esri's CDN at runtime, so the build output is just JS/CSS/images, and
**no special MIME configuration** is required anywhere.

There are two base-path builds:

| Script | `--base` | For |
|---|---|---|
| `npm run build`    | `/cdot_tdm_calculator/` | Bitbucket Pages (served under a subpath) |
| `npm run build:cf` | `/`                     | Cloudflare Worker (Static Assets) / IIS root / any root-served host |

Both emit to `dist/`. The build stamps the git SHA + build time into the
bundle (visible via the browser console / `window.__BUILD__`).

---

## 1. Cloudflare Worker (Static Assets): production

**URL:** https://tdm.highstreet.work/ — a custom domain bound to the Worker
`cdot-tdm-calculator-app`, in the Cloudflare-managed `highstreet.work` zone.
workers.dev is disabled for it, so there is no second public alias.

This is a **Worker with Static Assets, not Cloudflare Pages** — Cloudflare's
"Connect to Git" now defaults static sites to a Worker. `wrangler.jsonc` at the
repo root is what makes it one (`assets.directory: ./dist`, SPA
`not_found_handling`); without it `wrangler deploy` has nothing to ship.

### Automated (Git integration)
Pushing to `main` on GitHub builds and deploys. The build settings live in the
Cloudflare dashboard, not in this repo:

| Setting | Value |
|---|---|
| Root directory | `/` — the app is at the repository root |
| Build command | `npm run build:cf` |
| Deploy command | `npx wrangler deploy` |
| Output directory | `./dist` |
| Build variable | `NODE_VERSION=24` |

`build:cf` sets `NODE_OPTIONS=--max-old-space-size=4096`; without it `vite build`
runs out of heap on `@arcgis/core` plus sourcemaps.

### Manual (local)
```bash
npm run build:cf
npx wrangler deploy
```
Needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in the environment (or
`npx wrangler login`). The token needs **Workers Scripts: Edit** — a Pages-scoped
token is not sufficient.

Confirm which build is live by comparing the commit in `window.__BUILD__.sha`
against the short SHA you pushed.

---

## 2. Accessibility-review snapshot

**URL:** https://tdm-a11y.highstreet.work/ — a *separate* Worker
(`cdot-tdm-calculator-a11y`) so production deploys cannot move the build a
reviewer is looking at.

Frozen at the `a11y-review-*` tag / `accessibility-review-*` branch. To refresh
it, check out that ref and deploy it by name:

```bash
npm run build:cf
npx wrangler deploy --name cdot-tdm-calculator-a11y
```

Findings from a review land on the review branch, so the URL stays stable while
`main` moves.

---

## 3. IIS (on-prem): long-term production

Built and packaged by one command — do not hand-assemble it:

```bash
node scripts/package-iis.mjs
# -> ../handoff/cdot-tdm-calculator_<sha>_<date>_iis.zip
```

That runs the normal pipeline (catalog sync, third-party licence generation,
typecheck) and then a build with the two flags that make it an IIS artifact
rather than a Cloudflare one:

- `--base=./` — **relative** asset URLs, so a single package works at the IIS
  site root *or* inside a virtual directory with no rebuild. There is no
  per-path `build:iis` variant to maintain. This is safe because the app is
  hash-routed: the document path never changes, so relative URLs always resolve.
  The one caveat is to request the directory **with a trailing slash**; IIS
  normally redirects to add it.
- `--sourcemap false` — drops ~35 MB of maps and avoids shipping source to a
  third-party-hosted server.

It stamps `deploy/iis/README.txt` with the real commit, branch, file count and
sizes, includes `deploy/iis/web.config`, zips, and verifies integrity. It warns
if the working tree is dirty so a package cannot claim a commit it does not match.

### Deploying the package
1. Unzip and copy the **contents** of `cdot-tdm-calculator-iis/` into the site or
   virtual directory (not the folder itself, unless you want the app served from
   a path ending in `/cdot-tdm-calculator-iis/`).
2. **No URL Rewrite module needed.** HashRouter keeps routing client-side, so IIS
   only ever serves the directory itself. `web.config` deliberately contains no
   `<rewrite>` section — that module is not installed by default.
3. `web.config` (shipped in the package, source of truth `deploy/iis/web.config`)
   sets the SVG MIME type defensively, enables static compression, caches
   `/assets/*` immutably and marks `index.html` no-cache so updates are picked up.

### Outbound access is the requirement people miss
The app fetches its map, basemap and TAZ data from Esri **at runtime, from the
end user's browser** — so the relevant policy is client/proxy egress, not the IIS
server's. If those hosts are blocked the map silently fails to draw while the rest
of the page renders, which looks like an app bug rather than a firewall rule. The
package README lists the exact hosts.

---

### Notes for the IIS move
- **AGOL data layers are external** (hosted on `cdot.maps.arcgis.com` /
  `services.arcgis.com`) and must stay shared **public**; nothing about them
  changes when the app host moves.
- The app calls Esri services + `js.arcgis.com` from the browser, so the IIS
  server needs no outbound access; only clients do.
- The URL/base path is **no longer a build-time decision**: the package uses
  relative asset URLs, so the same zip works at the site root or under any
  virtual directory. Only the trailing slash matters (see step 1).
