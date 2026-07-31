CDOT TDM Calculator — static build for IIS
==========================================

Build provenance
----------------
  Source commit : {{COMMIT}}
  Branch        : {{BRANCH}}
  Repository    : github.com/high-street-consulting/cdot_tdm_calculator
  Built         : {{BUILT}} (UTC)
  Contents      : {{FILES}} files, {{SIZE_MB}} MB on disk ({{ZIP_MB}} MB zipped)

The running app reports the same commit in the browser console on load, and at
`window.__BUILD__` — useful for confirming which build a given server is on.


What this is
------------
A self-contained static single-page application. To host it, IIS only has to
serve files. Specifically, it does NOT require:

  * any server-side code, .NET runtime, or particular application pool identity
  * the URL Rewrite Module (see "Routing" below)
  * a database, or any inbound service

To deploy: unzip, then copy the CONTENTS of the extracted
"cdot-tdm-calculator-iis" folder — index.html, assets/, web.config and the
icons — into the target site or virtual directory. Copy the contents rather
than the folder itself, unless you intend the app to be served from a path
ending in /cdot-tdm-calculator-iis/.


Where it can be deployed
------------------------
Asset paths in index.html are RELATIVE ("./assets/..."), so this build works
both at a site root and inside a virtual directory, with no rebuild:

    https://example.codot.gov/                 -> works
    https://example.codot.gov/tdm-calculator/  -> works

One caveat: request the directory WITH a trailing slash. IIS normally issues
that redirect automatically for a directory request, so this is rarely an issue
in practice, but a link written as ".../tdm-calculator" (no slash) that is not
redirected will resolve the relative asset paths one level too high.

If you would prefer absolute paths pinned to a known path, we can supply a
rebuild — it is a one-line build flag on our side.


Routing
-------
The app uses hash-based routing: every internal route is of the form

    /#/methodology     /#/cart     /#/strategies/...

The part after "#" never reaches the server, so IIS only ever serves the
directory itself. There are no deep-link 404s to handle and no rewrite rules to
install. web.config contains no <rewrite> section for this reason.


Outbound network access (REQUIRED)
----------------------------------
This is the one hosting requirement that is easy to miss. The calculator loads
its map, its geographic data, and part of the Esri SDK at RUNTIME, from the
browser. If the client network blocks these hosts, the map will not draw and
zone selection will not work — the rest of the page will still render, which can
make the failure look like a bug rather than a network policy.

Allow HTTPS (443) to:

    js.arcgis.com             Esri SDK assets + Calcite UI components
    basemaps.arcgis.com       basemap styles
    vectortileservices.arcgis.com   basemap vector tiles
    cdn.arcgis.com            Esri static resources
    static.arcgis.com         Esri static resources
    www.arcgis.com            Esri portal metadata
    services.arcgis.com       hosted feature services (TAZ data)
    services6.arcgis.com      hosted feature services
    cdot.maps.arcgis.com      CDOT's ArcGIS Online organization (TAZ layers)
    geocode.arcgis.com        address/place search box
    fonts.googleapis.com      web font (cosmetic only; safe to block)

Note these are reached by the END USER'S browser, not by the IIS server itself,
so the relevant policy is the client/proxy egress rules, not the server's.

All layers consumed are public; the build contains no credentials, API keys, or
tokens (verified before packaging).


Contents
--------
  index.html            application entry point (do not cache — see web.config)
  assets/               content-hashed JS/CSS (safe to cache indefinitely)
  catalog-images/       strategy imagery
  *.png, *.ico          icons
  web.config            IIS MIME, compression and caching configuration
  THIRD-PARTY-LICENSES.txt  copyright notices for every third-party package
                        compiled into this build (see "Licensing" below)

Source maps are intentionally excluded to keep the package small; they can be
provided on request.


Licensing
---------
The calculator itself is licensed under the Apache License 2.0.

THIRD-PARTY-LICENSES.txt lists every third-party package compiled into this
build, with its license and copyright notice. It must be retained and served
alongside the application — it is reachable at /THIRD-PARTY-LICENSES.txt once
deployed. Two entries are worth CDOT's attention specifically:

  * Esri (@arcgis/core, Calcite) is proprietary, licensed under the Esri Master
    License Agreement rather than an open-source license. Redistribution of the
    unmodified library is permitted under that agreement with the copyright
    notice attached, which this package satisfies.

  * amCharts 5 is included transitively through Esri's popup charts under a
    "linkware" license, which requires its LICENSE text to ship with the
    distribution (it is in THIRD-PARTY-LICENSES.txt) and its branding link not
    to be hidden on content it generates.

The CDOT name and logo are trademarks and are NOT covered by the Apache-2.0
grant on the source code.


Updating
--------
Replace the entire directory contents with a newer package. Because asset
filenames are content-hashed and index.html is served no-cache (per web.config),
returning users pick up the new version on their next load without needing to
clear their cache.


Contact
-------
High Street Consulting Group — egge@highstreetconsulting.com
