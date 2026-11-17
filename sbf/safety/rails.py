"""
NeMo Guardrails configurations: each ``nemo_guardrails`` classifier is a
folder ``<workspace>/guardrails/<classifier id>/`` (config.yml, prompts.yml)
that the guardrails server (scripts/run_guardrails.py) serves under that
config id, reloading when the files change.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from ..workspace import workspace, write_text_atomic
from .classifiers import DEFAULT_RAILS_CONFIG, DEFAULT_RAILS_PROMPTS


def rails_dir() -> Path:
    return workspace.root / "guardrails"


def sync_rails() -> list[str]:
    """Write every nemo_guardrails classifier's folder; remove folders whose
    classifier is gone. Returns the config ids."""
    root = rails_dir()
    ids = []
    for c in workspace.classifiers.list():
        if c.provider != "nemo_guardrails":
            continue
        folder = root / c.id
        for name, text in (("config.yml", c.rails_config or DEFAULT_RAILS_CONFIG),
                           ("prompts.yml", c.rails_prompts or DEFAULT_RAILS_PROMPTS)):
            path = folder / name
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                write_text_atomic(path, text)
        ids.append(c.id)
    if root.exists():
        for folder in root.iterdir():
            if folder.is_dir() and folder.name not in ids:
                shutil.rmtree(folder, ignore_errors=True)
    return ids
