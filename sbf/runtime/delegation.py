"""
Sub-runs: delegate links (agent-as-tool) and observe links (post-turn).

Each spawn runs its target node on its own ``Runner`` with a fresh in-memory
session seeded with a copy of the parent's session state — the context
isolation of BotBase's summarizer and memory agent: none of the sub-run's
traffic enters the parent's history. The run ends when the target's
terminal tool accepts a call; a run that ends without one is reminded once,
and if it still doesn't comply its terminal tool's fallback result stands in.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from google.adk.sessions import InMemorySessionService

from ..memory import memory_store
from ..schemas import LinkDef
from ..tools import get_tool_class
from .adk import build_agent, make_runner, run_until_done
from .builder import CompiledNode
from .context import UNSET, AgentRun, ResourceRegistry, Turn, clip, scopes
from .prompts import base_variables, render

if TYPE_CHECKING:
    from ..tools import ToolContext

log = logging.getLogger(__name__)

# A nudge is a short second invocation: one model call to act on the
# reminder, one spare in case it first answers in prose.
NUDGE_MAX_LLM_CALLS = 2

DEFAULT_NUDGE = ("Reminder: nothing you write as plain text is returned. Finish now by calling "
                 "{tool} with your results so far.")

DEFAULT_OBSERVE_TEMPLATE = """TURN TRANSCRIPT (conversational surface only):
{{ turn.surface | join('\n') if turn.surface else '(empty turn)' }}"""


async def run_subagent(turn: Turn, cnode: CompiledNode, kind: str, request: str, *,
                       state: dict, resources: ResourceRegistry, max_llm_calls: int | None,
                       nudge: str = "") -> AgentRun:
    compiled = turn.system
    run = AgentRun(node=cnode, turn=turn, kind=kind, user_facing=False, resources=resources,
                   budgets={b.function_name: b.budget for b in cnode.bindings if b.budget},
                   request=request)
    session_id = f"{turn.chat_id}:{cnode.id}:{run.id}"
    service = InMemorySessionService()
    runner = make_runner(build_agent(compiled, cnode, user_facing=False), service, f"sbf_{kind}")
    await service.create_session(app_name=f"sbf_{kind}", user_id=cnode.id,
                                 session_id=session_id, state=state)
    scopes.register(session_id, {cnode.id: run})
    terminal = cnode.terminal_bindings()
    try:
        await run_until_done(runner, user_id=cnode.id, session_id=session_id, text=request,
                             max_llm_calls=max_llm_calls or cnode.max_llm_calls)
        if terminal and not run.finished:
            reminder = nudge or DEFAULT_NUDGE.format(tool=terminal[0].function_name)
            run.trace("nudge", {"text": clip(reminder, 200)})
            await run_until_done(runner, user_id=cnode.id, session_id=session_id, text=reminder,
                                 max_llm_calls=NUDGE_MAX_LLM_CALLS)
    finally:
        scopes.release(session_id)
    return run


def _result(run: AgentRun) -> Any:
    if run.terminal_result is not UNSET:
        return run.terminal_result
    terminal = run.node.terminal_bindings()
    if terminal:
        return get_tool_class(terminal[0].tool).fallback_result(run)
    return {"result": run.last_text or "", "complete": True}


async def delegate(link: LinkDef, ctx: "ToolContext", args: dict) -> Any:
    """Body of a delegate tool call."""
    parent = ctx.run
    turn = parent.turn
    target = turn.system.nodes[link.target]
    state = dict(ctx.state.to_dict() if hasattr(ctx.state, "to_dict") else ctx.state)

    missing = [key for key in link.require_state if not state.get(key)]
    if missing:
        return link.require_state_error or (
            f"ERROR: {link.tool_name} is unavailable until {', '.join(missing)} is set.")
    required = (link.parameters or {}).get("required") or (
        ["question"] if link.parameters is None else [])
    empty = [k for k in required if not str(args.get(k) or "").strip()]
    if empty:
        return f"ERROR: Missing {', '.join(repr(k) for k in empty)} argument in {link.tool_name}."

    variables = base_variables(turn.system, target, state, parent, args=args,
                               parent={"id": parent.node.id, "label": parent.node.label})
    request = render(link.request_template or "{{ args.question or args | tojson }}", variables)

    turn.trace(target.id, None, "spawn", {
        "from": parent.node.id, "via": link.tool_name, "request": clip(request, 300),
        "model": target.model_spec.model or target.model_spec.provider},
        persist={"from": parent.node.id, "via": link.tool_name, "args": args, "request": request})

    resources = ResourceRegistry()
    run = await run_subagent(turn, target, "delegate", request, state=state, resources=resources,
                             max_llm_calls=link.max_llm_calls, nudge=link.nudge)
    result = _result(run)
    if isinstance(result, dict):
        result = {**result, "timestamp": datetime.now().isoformat(timespec="seconds"),
                  "tool_calls": run.tool_calls}
    if link.share_resources:
        # Ids the target cites (e.g. in a summary) resolve in the parent's
        # delivery tools.
        parent.resources.merge(resources)
    turn.trace(target.id, run.id, "result", {
        "complete": run.terminal_result is not UNSET, "tool_calls": run.tool_calls,
        "result": clip(result, 500)}, persist={"result": result})
    return result


async def run_observers(turn: Turn) -> None:
    """Run every observe link whose source took part in this turn."""
    compiled = turn.system
    for node_id in list(turn.active_nodes) or [compiled.system.entry]:
        source = compiled.nodes.get(node_id)
        if source is None:
            continue
        for link in source.observers:
            if link.requires_profile and not turn.profile:
                continue
            try:
                await _observe(turn, source, link)
            except Exception as exc:
                log.exception("observer %s failed", link.target)
                turn.trace(link.target, None, "error", {"error": clip(f"{type(exc).__name__}: {exc}", 300)})


async def _observe(turn: Turn, source: CompiledNode, link: LinkDef) -> None:
    compiled = turn.system
    target = compiled.nodes[link.target]
    notes = []
    if compiled.memory_enabled and turn.profile:
        notes = memory_store.list_notes(compiled.memory_namespace, turn.profile["id"],
                                        compiled.memory_schema, limit=20)["memories"]
    resources = turn.resources.copy() if link.share_resources else ResourceRegistry()
    variables = base_variables(compiled, target, {}, None)
    variables["turn"] = {"user_message": turn.user_message,
                         "surface": turn.surface(source.id),
                         "resources": resources.all()}
    variables["memory"] = {"notes": notes}
    variables["profile"] = turn.profile or {}
    request = render(link.request_template or DEFAULT_OBSERVE_TEMPLATE, variables)

    turn.trace(target.id, None, "spawn", {"from": source.id, "observe": True,
                                          "request": clip(request, 300), "prior_notes": len(notes)},
               persist={"from": source.id, "request": request})
    run = await run_subagent(turn, target, "observe", request, state={}, resources=resources,
                             max_llm_calls=link.max_llm_calls, nudge=link.nudge)
    result = _result(run)
    turn.trace(target.id, run.id, "result", {"complete": run.terminal_result is not UNSET,
                                             "tool_calls": run.tool_calls,
                                             "result": clip(result, 500)},
               persist={"result": result})
