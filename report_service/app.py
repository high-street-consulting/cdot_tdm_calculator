"""Test server for the CDOT TDM Calculator accessible-PDF proof of concept.

Run (from this directory):
    uvicorn app:app --reload --port 8000

Endpoints:
    GET  /health             → {"status": "ok"}
    GET  /report/sample.pdf  → render the bundled sample payload (quick demo)
    GET  /report/sample.html → the pre-PDF HTML (useful for debugging layout)
    POST /report/pdf         → body = report JSON (see sample_payload.json),
                               returns a tagged PDF/UA-1 download

This is a proof of concept to validate the server-side approach with veraPDF
before coordinating production hosting with CDOT OIT (per requirements §5.1,
the AWS "web server" hosting option supports this; it could also run as a
Lambda behind API Gateway).
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, Response

import render

app = FastAPI(title="CDOT TDM Calculator — Report PDF service (PoC)")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/report/pdf")
async def report_pdf(request: Request) -> Response:
    payload = await request.json()
    pdf = render.render_pdf(payload)
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="cdot-tdm-report.pdf"'},
    )


@app.get("/report/sample.pdf")
def sample_pdf() -> Response:
    pdf = render.render_pdf(render.load_sample())
    return Response(content=pdf, media_type="application/pdf")


@app.get("/report/sample.html", response_class=HTMLResponse)
def sample_html() -> str:
    return render.render_html(render.load_sample())
