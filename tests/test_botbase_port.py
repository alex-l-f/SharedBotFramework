"""The R2MR port renders exactly BotBase's prompts and memory notes.

Runs the import script into the isolated test workspace; skipped when the
BotBase checkout isn't available.
"""

from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path

import pytest

BOTBASE = Path("E:/Experiments/BotBase")
pytestmark = pytest.mark.skipif(not (BOTBASE / "prompts").is_dir(), reason="BotBase checkout not found")


def _load_script():
    path = Path(__file__).resolve().parent.parent / "scripts" / "import_botbase.py"
    spec = importlib.util.spec_from_file_location("import_botbase", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_port_matches_botbase():
    script = _load_script()
    bb = script.load_botbase(BOTBASE)
    from sbf.workspace import workspace
    topics, _ = script.build(bb, workspace, argparse.Namespace(botbase=BOTBASE, force_settings=True))
    script.check_fidelity(bb, topics)  # raises SystemExit with a diff on any mismatch

    from sbf.runtime import compile_system
    compiled = compile_system("r2mr-coach")
    assert compiled.entry.id == "coach" and set(compiled.nodes) == {"coach", "summarizer", "memory"}
    assert [l.tool_name for l in compiled.entry.delegates] == ["ask_library"]
    assert [l.target for l in compiled.entry.observers] == ["memory"]
    assert compiled.nodes["summarizer"].model_spec.reasoning_effort == "low"
