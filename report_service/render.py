"""Render the TDM Calculator report to a tagged PDF/UA-1 with WeasyPrint.

The React app holds all the report data already (AggregatedResults, the
basket + configured inputs, the queried TAZ rows, and the offscreen map
screenshot). This service takes that data as JSON, renders it through a
WeasyPrint-safe HTML template, and returns a PDF that passes veraPDF's
PDF/UA-1 profile with zero failures — something the browser's window.print()
cannot do (it omits the PDF/UA XMP identifier, drops <img> alt text, and
leaves links untagged).
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from weasyprint import HTML

BASE = Path(__file__).parent
_env = Environment(
    loader=FileSystemLoader(str(BASE / "templates")),
    autoescape=select_autoescape(["html", "xml"]),
)


def _data_uri(path: Path, mime: str = "image/png") -> str:
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()


def render_html(payload: dict) -> str:
    payload = dict(payload)
    payload.setdefault("title", "TDM Strategy Package — VMT Reduction Report")
    return _env.get_template("report.html.j2").render(**payload)


def render_pdf(payload: dict) -> bytes:
    """Render to a tagged PDF/UA-1. `base_url` lets relative asset refs resolve."""
    html = render_html(payload)
    return HTML(string=html, base_url=str(BASE)).write_pdf(pdf_variant="pdf/ua-1")


def load_sample() -> dict:
    """The bundled demo payload, with the logo + a placeholder map inlined as
    data URIs (the app sends the live map screenshot the same way)."""
    payload = json.loads((BASE / "sample_payload.json").read_text())
    logo = BASE / "assets" / "cdot_logo.png"
    sample_map = BASE / "assets" / "sample_map.png"
    if logo.exists():
        payload["logo_data_uri"] = _data_uri(logo)
    if sample_map.exists():
        payload["map_data_uri"] = _data_uri(sample_map)
    return payload
