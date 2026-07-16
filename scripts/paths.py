"""Shared filesystem locations for the offline data pipeline.

The travel-model inputs (``data/``) and generated artifacts (``outputs/``) are
NOT part of the public code repository — they live in the private data repo.
Point these environment variables at your local checkout of it:

    export TDM_DATA_DIR=/path/to/tdm-private-data/data
    export TDM_OUTPUTS_DIR=/path/to/tdm-private-data/outputs

Both default to ``<repo>/data`` and ``<repo>/outputs``, which matches the
combined private working tree, so nothing needs to be set there. The web app
does not use any of this — it reads TAZ data from published AGOL layers at
runtime.
"""
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

DATA_DIR = Path(os.environ.get("TDM_DATA_DIR") or REPO_ROOT / "data")
OUTPUTS_DIR = Path(os.environ.get("TDM_OUTPUTS_DIR") or REPO_ROOT / "outputs")
