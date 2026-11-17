"""
Instruction rendering.

A node's instruction is recomputed from session state on every model call
(an ADK instruction provider), so a mode switch takes effect mid-turn. It is
the node's ``prompt_template`` (default ``{{ agent_prompt }}``) rendered
with Jinja, followed by the reply note (user-facing agents in text-reply
mode), the memory snapshot (nodes with ``inject_memory``) and retrieved
context (``NodeDef.context`` with placement 'append').

Template variables:

    agent_prompt   the agent's own prompt, rendered with these variables
    mode           current mode {id, label, description, prompt} (empty if none)
    modes          all modes of the node
    state          session state
    vars           the system's variables
    fragments      prompt fragments (shared + system), rendered on access
    system         {id, name, description}
    node / agent   {id, label/name, ...}
    turn           {user_message} (when a turn is running)
    context        retrieved material by context name (nodes with context)
    now            current local date-time (ISO)
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import TYPE_CHECKING, Any

from jinja2 import ChainableUndefined
from jinja2.sandbox import SandboxedEnvironment

if TYPE_CHECKING:
    from .builder import CompiledNode, CompiledSystem
    from .context import AgentRun

_env = SandboxedEnvironment(undefined=ChainableUndefined, autoescape=False,
                            keep_trailing_newline=True)

REPLY_NOTE = """

====

REPLYING

Anything you write as plain text (outside tool calls and outside your thinking) is delivered to the user as your reply, exactly as if you had passed it to send_message. So simply write your answer; send_message still works but is not required. A response with no tool calls ends your turn, so there is no need to call finish_turn after a plain-text answer. Text written in the same response as a tool call is delivered before the tool runs, which is the right way to introduce a file or course page."""


def render(template: str, variables: dict) -> str:
    if not template:
        return ""
    if "{" not in template:
        return template
    return _env.from_string(template).render(**variables)


class _Fragments(Mapping):
    """Fragments rendered lazily with the current variables."""

    def __init__(self, raw: dict[str, str], variables: dict, depth: int = 0):
        self._raw = raw
        self._vars = variables
        self._depth = depth

    def __getitem__(self, key: str) -> str:
        text = self._raw[key]
        if self._depth >= 4:
            return text
        return render(text, {**self._vars, "fragments": _Fragments(self._raw, self._vars, self._depth + 1)})

    def __iter__(self):
        return iter(self._raw)

    def __len__(self):
        return len(self._raw)


def current_mode_id(cnode: "CompiledNode", state: Mapping) -> str | None:
    if not cnode.modes:
        return None
    modes = state.get("modes") or {}
    mode = modes.get(cnode.id) if isinstance(modes, dict) else None
    if mode in cnode.modes:
        return mode
    return cnode.node.initial_mode if cnode.node.initial_mode in cnode.modes else next(iter(cnode.modes))


def base_variables(compiled: "CompiledSystem", cnode: "CompiledNode | None", state: Mapping,
                   run: "AgentRun | None" = None, **extra) -> dict:
    variables: dict[str, Any] = {
        "state": dict(state),
        "vars": compiled.system.variables,
        "system": {"id": compiled.system.id, "name": compiled.system.name,
                   "description": compiled.system.description},
        "now": datetime.now().isoformat(timespec="minutes"),
        "turn": {"user_message": run.turn.user_message if run else ""},
    }
    if cnode is not None:
        variables["node"] = {"id": cnode.id, "label": cnode.node.label or cnode.id}
        variables["agent"] = {"id": cnode.agent.id, "name": cnode.agent.name or cnode.agent.id,
                              "description": cnode.agent.description}
        variables["modes"] = [{"id": m.id, "label": m.label or m.id, "description": m.description}
                              for m in cnode.modes.values()]
    variables.update(extra)
    variables["fragments"] = _Fragments(compiled.fragments, variables)
    return variables


def mode_variables(cnode: "CompiledNode", state: Mapping, variables: dict) -> dict:
    """The current mode as a template variable (its prompt rendered)."""
    mode_id = current_mode_id(cnode, state)
    if not mode_id:
        return {"id": None, "label": "", "description": "", "prompt": ""}
    mode = cnode.modes[mode_id]
    out = {"id": mode.id, "label": mode.label or mode.id, "description": mode.description, "prompt": ""}
    out["prompt"] = render(mode.prompt, {**variables, "mode": out})
    return out


def context_heading(name: str, label: str) -> str:
    return (label or name.replace("_", " ")).upper()


def render_instruction(compiled: "CompiledSystem", cnode: "CompiledNode", state: Mapping,
                       run: "AgentRun | None" = None, *, user_facing: bool = False,
                       memory_snapshot: str = "", context: dict[str, str] | None = None,
                       safety_notes: list[str] | None = None) -> str:
    context = context or {}
    variables = base_variables(compiled, cnode, state, run, context=context)
    variables["mode"] = mode_variables(cnode, state, variables)
    variables["agent_prompt"] = render(cnode.agent.prompt, variables)
    text = render(cnode.node.prompt_template or "{{ agent_prompt }}", variables)
    if user_facing and cnode.agent.reply_mode == "text":
        text += REPLY_NOTE
    if cnode.node.inject_memory and memory_snapshot:
        text += memory_snapshot
    for c in cnode.node.context:
        block = context.get(c.name)
        if c.placement == "append" and block:
            text += f"\n\n====\n\n{context_heading(c.name, c.label)}\n\n{block}"
    if safety_notes:
        text += "\n\n====\n\nSAFETY CHECK (this turn)\n\n" + "\n".join(f"- {n}" for n in safety_notes)
    return text
