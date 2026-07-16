"""Render the sample report and validate it against veraPDF's PDF/UA-1 profile.

This is the acceptance gate for the proof of concept: it must report zero
failures. Requires veraPDF on PATH (`brew install verapdf`).

    python verify_compliance.py
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import render

BASE = Path(__file__).parent


def main() -> int:
    out = BASE / "out"
    out.mkdir(exist_ok=True)
    pdf_path = out / "sample.pdf"
    pdf_path.write_bytes(render.render_pdf(render.load_sample()))
    print(f"Rendered {pdf_path} ({pdf_path.stat().st_size:,} bytes)")

    try:
        res = subprocess.run(
            ["verapdf", "-f", "ua1", str(pdf_path)],
            capture_output=True, text=True, check=False,
        )
    except FileNotFoundError:
        print("ERROR: veraPDF not found on PATH. Install with `brew install verapdf`.")
        return 2

    xml = res.stdout
    comp = re.search(r'isCompliant="(\w+)"', xml)
    det = re.search(
        r'<details\s+passedRules="(\d+)"\s+failedRules="(\d+)"'
        r'\s+passedChecks="(\d+)"\s+failedChecks="(\d+)"',
        xml,
    )
    compliant = bool(comp and comp.group(1) == "true")
    if det:
        pr, fr, pc, fc = det.groups()
        print(f"veraPDF PDF/UA-1: passedRules={pr} failedRules={fr} "
              f"passedChecks={pc} failedChecks={fc}")

    if not compliant:
        seen = set()
        for a, b, body in re.findall(
            r'<rule\b([^>]*)status="failed"([^>]*)>(.*?)</rule>', xml, re.S
        ):
            attrs = a + b
            clause = (re.search(r'clause="([^"]+)"', attrs) or [None, "?"])[1]
            test = (re.search(r'testNumber="([^"]+)"', attrs) or [None, "?"])[1]
            d = re.search(r"<description>(.*?)</description>", body, re.S)
            d = re.sub(r"\s+", " ", d.group(1)).strip()[:160] if d else ""
            if (clause, test) in seen:
                continue
            seen.add((clause, test))
            print(f"  FAIL {clause}-{test}: {d}")
        print("\n❌ NOT PDF/UA-1 compliant")
        return 1

    print("\n✅ PDF/UA-1 compliant — zero failures")
    return 0


if __name__ == "__main__":
    sys.exit(main())
