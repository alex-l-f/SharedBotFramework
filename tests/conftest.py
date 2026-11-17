"""
Test setup: an isolated workspace + data dir (set before ``sbf`` is
imported) and a scripted fake LLM so the runtime runs without network.

A test agent's model spec is ``{provider: litellm, model: "script:<key>"}``;
``scripted`` maps each key to a list of responses consumed in order. A
response is a string (text reply) or ``("tool", name, args)``.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="sbf-test-"))
os.environ["SBF_WORKSPACE"] = str(_TMP / "workspace")
os.environ["SBF_DATA"] = str(_TMP / "data")
os.environ.setdefault("OPENROUTER_API_KEY", "test")
# Accounts off except where a test turns them on (tests/test_team.py).
os.environ["SBF_AUTH"] = "off"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from google.adk.models.base_llm import BaseLlm  # noqa: E402
from google.adk.models.llm_response import LlmResponse  # noqa: E402
from google.genai import types  # noqa: E402

SCRIPTS: dict[str, list] = {}
REQUESTS: dict[str, list] = {}


class ScriptedLlm(BaseLlm):
    async def generate_content_async(self, llm_request, stream: bool = False):
        key = self.model.removeprefix("script:")
        REQUESTS.setdefault(key, []).append(llm_request)
        queue = SCRIPTS.get(key) or []
        step = queue.pop(0) if queue else ""
        if isinstance(step, tuple):
            _, name, args = step
            part = types.Part(function_call=types.FunctionCall(name=name, args=args))
        else:
            part = types.Part(text=step) if step else types.Part(text="")
        yield LlmResponse(content=types.Content(role="model", parts=[part]),
                          finish_reason=types.FinishReason.STOP)


@pytest.fixture
def scripted(monkeypatch):
    import sbf.runtime.adk as adk

    def fake_make_model(spec):
        return ScriptedLlm(model=spec.model or "script:default")

    monkeypatch.setattr(adk, "make_model", fake_make_model)
    SCRIPTS.clear()
    REQUESTS.clear()
    return SCRIPTS


@pytest.fixture
def requests_seen():
    return REQUESTS
