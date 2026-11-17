"""
Context injection: retrieve before the model runs (``NodeDef.context``).

Each context source names a retriever; its material is computed when the
node's instruction is built and cached on the run per (question, scope), so
it is retrieved once per turn — and again only if a mode switch changes the
question or the scoped dataset mid-turn. The material reaches the prompt as
``{{ context.<name> }}`` and, unless placed by the template, is appended to
the instruction under its label. Its items join the run's resources.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import TYPE_CHECKING

from ..knowledge import add_dataset_items
from ..rag import RetrievalRequest, run_retriever
from ..workspace import NotFound, workspace
from .context import clip
from .prompts import _env, base_variables, mode_variables, render

if TYPE_CHECKING:
    from .context import AgentRun

log = logging.getLogger(__name__)


def _true(expression: str, variables: dict) -> bool:
    try:
        return bool(_env.compile_expression(expression, undefined_to_none=True)(**variables))
    except Exception as exc:
        log.warning("context condition %r failed: %s", expression, exc)
        return False


async def node_context(run: "AgentRun", state: Mapping) -> dict[str, str]:
    """``{name: material}`` for the run's node in the current state."""
    sources = run.node.node.context
    if not sources:
        return {}
    compiled = run.turn.system
    variables = base_variables(compiled, run.node, state, run)
    variables["mode"] = mode_variables(run.node, state, variables)
    out: dict[str, str] = {}
    for c in sources:
        out[c.name] = ""
        if c.condition and not _true(c.condition, variables):
            continue
        scope = None
        if c.scope_state_key:
            value = state.get(c.scope_state_key)
            if not value:
                continue
            scope = [str(value)]
        question = (render(c.question, variables).strip() if c.question
                    else run.request or run.turn.user_message)
        key = (c.name, question, tuple(scope or ()))
        if key in run.context_cache:
            out[c.name] = run.context_cache[key]
            continue
        try:
            defn = compiled.retrievers.get(c.retriever) or workspace.retrievers.get(c.retriever)
            result = await run_retriever(defn, RetrievalRequest(
                question=question, conversation=run.turn.conversation, budget=c.budget, datasets=scope))
        except (NotFound, Exception) as exc:  # retrieval trouble never breaks the turn
            log.exception("context %s: retrieval failed", c.name)
            run.trace("context_error", {"name": c.name, "retriever": c.retriever,
                                        "error": clip(f"{type(exc).__name__}: {exc}", 300)})
            run.context_cache[key] = ""
            continue
        meta = result.pack.meta
        run.trace("context", {
            "name": c.name, "retriever": c.retriever, "question": clip(question, 200), "scope": scope,
            "chars": len(result.text), "selected": meta.get("selected"), "ms": (meta.get("ms") or {}).get("total"),
            "llm_calls": meta.get("llm_calls"), "cost": meta.get("cost")},
            persist={"text": result.text, "queries": meta.get("queries"),
                     "items": [p.item_key for p in result.pack.items()]})
        run.context_cache[key] = result.text
        # Ids the model sees in the material resolve in delivery/memory tools.
        add_dataset_items(run.resources, [p.item_key for p in result.pack.items()])
        out[c.name] = result.text
    return out
