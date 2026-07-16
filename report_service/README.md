# Report PDF service (accessible PDF/UA-1) — proof of concept

A small server-side step that turns the TDM Calculator's report data into a
**tagged PDF/UA-1** that passes [veraPDF](https://verapdf.org/) with **zero
failures**. This is the accessibility path for the "Export PDF report" feature
(Section 508 / WCAG 2.2 AA target; PDF/UA-1 is the machine-verifiable layer a
third-party audit + VPAT will check).

## Why this exists (the short version)

The browser's `window.print()` "Save as PDF" — and every client-side JS PDF
library tested (PDFKit) — **cannot** produce a PDF/UA-1 file. Measured with
veraPDF, browser print output fails because it:

- omits the **PDF/UA identifier** XMP metadata,
- **drops `<img>` alt text** (so the project-area map has no text alternative),
- leaves **hyperlinks untagged** (no `/Contents`).

None of these are fixable from browser code. Rendering the *same* report HTML
through **WeasyPrint** server-side fixes all of them automatically and produces
a fully conformant tagged PDF. This service is that step.

## Run it

Requires Python 3.12, [`uv`](https://docs.astral.sh/uv/), and (for the
compliance gate) veraPDF: `brew install verapdf`. WeasyPrint also needs Pango:
`brew install pango`.

```bash
cd report_service
uv venv --python 3.12 venv
uv pip install --python venv -r requirements.txt

# 1) Prove compliance (the acceptance gate — must print zero failures)
./venv/bin/python verify_compliance.py

# 2) Run the test server
./venv/bin/uvicorn app:app --reload --port 8000
#   GET  http://localhost:8000/report/sample.pdf    (quick demo)
#   GET  http://localhost:8000/report/sample.html   (pre-PDF layout)
#   POST http://localhost:8000/report/pdf           (body = report JSON)
```

## Contract with the app

The React app already computes everything the report needs. To wire the
"Export PDF report" button to this service, POST the report data as JSON
(shape: see `sample_payload.json`) to `/report/pdf` and stream back the PDF.
The project-area map is sent as a `map_data_uri` (the same PNG the app captures
offscreen via the ArcGIS view's `takeScreenshot`), with `map_alt` as its text
alternative.

## Files

| File | Purpose |
|---|---|
| `templates/report.html.j2` | WeasyPrint-safe HTML/CSS template (semantic headings, `<th scope>` tables, `<img alt>`, real links) |
| `render.py` | payload → HTML → tagged PDF/UA-1 (`write_pdf(pdf_variant="pdf/ua-1")`) |
| `app.py` | FastAPI test server |
| `sample_payload.json` | demo report data |
| `verify_compliance.py` | renders the sample, runs veraPDF, asserts zero failures |

## Deployment note (for CDOT OIT)

This runs anywhere Python + Pango run. Per requirements §5.1 ("AWS web server
or S3 bucket"), the **web-server** option supports it directly; it can also run
as an **AWS Lambda** (container image with WeasyPrint's native libs) behind API
Gateway, keeping the front end static. The report contains only public model
data (TAZ statistics), so there is no sensitive-data flow.

## Accessibility scope

veraPDF verifies the machine-checkable PDF/UA-1 requirements (tag structure,
metadata, alt-text presence, font embedding, reading order tags). It does **not**
judge whether alt text is *meaningful* — that's a human-review item for the VPAT.
The project-area map's `/Alt` describes the area, and the report's TAZ table is
the accessible data equivalent of the map for screen-reader users.
