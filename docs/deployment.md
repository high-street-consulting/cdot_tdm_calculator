# Deploying the TDM Calculator

The calculator (`app/`) is a **static Vite SPA**. It uses **HashRouter** (routes
like `#/area`), so it needs **no server-side URL rewriting** on any host; a
plain file copy is enough. The @arcgis/core SDK loads its own worker/WASM/i18n
assets from Esri's CDN at runtime, so the build output is just JS/CSS/images, and
**no special MIME configuration** is required anywhere.

There are two base-path builds:

| Script | `--base` | For |
|---|---|---|
| `npm run build`    | `/cdot_tdm_calculator/` | Bitbucket Pages (served under a subpath) |
| `npm run build:cf` | `/`                     | Cloudflare Pages / IIS root / any root-served host |

Both emit to `app/dist/`. The build stamps the git SHA + build time into the
bundle (visible via the browser console / `window.__BUILD__`).

---

## 1. Cloudflare Pages: interim production

**Primary URL:** https://tdm.highstreet.work/ (custom domain, a proxied CNAME to
the Pages project, in the Cloudflare-managed `highstreet.work` zone).
**Default alias:** https://cdot-tdm-calculator.pages.dev/

### Automated (Bitbucket Pipeline)
`bitbucket-pipelines.yml` deploys to Cloudflare on every push, **once these
repository variables are set** (Repo → Settings → Repository variables):

- `CLOUDFLARE_API_TOKEN`: mark **Secured**. Create at Cloudflare dashboard →
  *My Profile → API Tokens → Create Token*. Use a token with the
  **Account → Cloudflare Pages → Edit** permission (the "Cloudflare Pages: Edit"
  preset works).
- `CLOUDFLARE_ACCOUNT_ID`: from the Cloudflare dashboard (Workers & Pages →
  right sidebar, or `npx wrangler whoami`).

Until `CLOUDFLARE_API_TOKEN` is present, the pipeline's Cloudflare step logs
"skipping" and does nothing, so it's safe to merge before the secrets exist.

### Manual (local)
```bash
cd app
npm run build:cf
npx wrangler pages deploy dist --project-name=cdot-tdm-calculator --branch=main
```
First run needs `npx wrangler login` (interactive) or the env vars above.

---

## 2. Bitbucket Pages: legacy fallback

**URL:** https://high-street.bitbucket.io/cdot_tdm_calculator/

Automated by the same pipeline (runs first). Needs `BITBUCKET_ACCESS_TOKEN`
(write access to `high-street/high-street.bitbucket.io`). This host rate-limits
bursty static loads (the reason for the Cloudflare move), so keep it only as a
fallback; it can be dropped from the pipeline once Cloudflare/IIS is the agreed
production.

---

## 3. IIS (on-prem): long-term production

The planned long-term deployment is a **local build + file copy to an IIS
server**. Because the app is static + HashRouter, this is deliberately simple:

1. **Build** (from `app/`):
   ```bash
   npm ci
   npm run build:cf      # base=/ , if the site is served at the IIS site ROOT
   ```
   If the app will live under a **virtual directory** instead (e.g.
   `https://server/tdm/`), add a script `"build:iis": "... vite build --base=/tdm/"`
   and use that; the base must match the URL path or assets 404.

2. **Copy** `app/dist/*` into the IIS site's physical folder, e.g.:
   ```
   robocopy app\dist C:\inetpub\wwwroot\tdm-calculator /MIR
   ```
   (`/MIR` mirrors, so it deletes stale files; point it at the right folder.)

3. **No URL Rewrite module needed**: HashRouter keeps all routing client-side.
   `/` serves `index.html`; deep links like `.../#/strategies` are handled in
   the browser.

4. **MIME types**: all emitted types (`.js`, `.css`, `.svg`, `.png`, `.ico`,
   `.html`) are IIS defaults. Nothing to add.

### Optional `web.config` (caching only)
Drop this in the site root for good cache behavior. Hashed `/assets/*` files are
immutable (safe to cache forever); `index.html` must not be cached so new
deploys are picked up:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <staticContent>
      <clientCache cacheControlMode="UseMaxAge" cacheControlMaxAge="365.00:00:00" />
    </staticContent>
    <httpProtocol>
      <customHeaders>
        <!-- Never cache the app shell so new builds are picked up immediately. -->
        <add name="Cache-Control" value="no-cache" />
      </customHeaders>
    </httpProtocol>
  </system.webServer>
  <location path="assets">
    <system.webServer>
      <httpProtocol>
        <customHeaders>
          <clear />
          <add name="Cache-Control" value="public, max-age=31536000, immutable" />
        </customHeaders>
      </httpProtocol>
    </system.webServer>
  </location>
</configuration>
```

### Notes for the IIS move
- **AGOL data layers are external** (hosted on `cdot.maps.arcgis.com` /
  `services.arcgis.com`) and must stay shared **public**; nothing about them
  changes when the app host moves.
- The app calls Esri services + `js.arcgis.com` from the browser, so the IIS
  server needs no outbound access; only clients do.
- Confirm the eventual URL/base path early; it's the one build-time decision
  that affects the artifact (see step 1).
