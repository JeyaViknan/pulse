"""Filesystem locations shared by the pipeline and the server (SPEC §12)."""

from __future__ import annotations

import os
from pathlib import Path

#: Repository root: the directory containing ``pyproject.toml``.
ROOT = Path(os.environ.get("PULSE_ROOT", Path(__file__).resolve().parents[2]))

DATA_DIR = ROOT / "data"
INTERIM_DIR = DATA_DIR / "interim"
PROCESSED_DIR = DATA_DIR / "processed"
ARTIFACTS_DIR = ROOT / "artifacts"
SESSIONS_DIR = ROOT / "sessions"
REPORTS_DIR = ROOT / "reports"
WEB_DIST_DIR = ROOT / "web" / "dist"

DEFAULT_ARTIFACT = ARTIFACTS_DIR / "pulse_v1"
