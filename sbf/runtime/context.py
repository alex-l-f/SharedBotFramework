"""
Run-time context: one ``Turn`` per user message, one ``AgentRun`` per agent
invocation inside it (the user-facing agents in the chat session, plus each
delegate/observer sub-run in its own session).

ADK hands tools and callbacks only a session id and an agent name, so runs
are registered in ``scopes`` under the ADK session id they execute in and
looked up from there.
"""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import TYPE_CHECKING, Any, AsyncIterator

from .. import db
from ..workspace import now_iso

if TYPE_CHECKING:
    from .builder import CompiledNode, CompiledSystem

UNSET = object()


def clip(value, limit: int = 600) -> str:
    """A value as a display string, truncated for live transport."""
    if value is None:
        return ""
    if not isinstance(value, str):
        try:
            value = json.dumps(value, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            value = str(value)
    return value if len(value) <= limit else value[:limit] + " …[truncated]"


class EventBus:
    """Live event stream of one turn. Any number of subscribers (the chat
    SSE request, a reconnecting client) each get the full history so far
    followed by new events."""

    def __init__(self):
        self._subscribers: list[asyncio.Queue] = []
        self._history: list[dict] = []
        self.closed = False
        self.turn_done = False

    def put(self, event: dict) -> None:
        if self.closed:
            return
        if event.get("kind") == "turn_done":
            self.turn_done = True
        self._history.append(event)
        for queue in self._subscribers:
            queue.put_nowait(event)

    def close(self) -> None:
        if not self.closed:
            self.put({"kind": "end"})
            self.closed = True

    async def stream(self) -> AsyncIterator[dict]:
        queue: asyncio.Queue = asyncio.Queue()
        for event in self._history:
            queue.put_nowait(event)
        self._subscribers.append(queue)
        try:
            while True:
                event = await queue.get()
                yield event
                if event.get("kind") == "end":
                    return
        finally:
            self._subscribers.remove(queue)


class ResourceRegistry:
    """Items retrieved during a run, addressable by their public id."""

    def __init__(self, items: list[dict] | None = None):
        self._items: dict[str, dict] = {}
        for item in items or []:
            self.add(item)

    def add(self, item: dict) -> None:
        self._items[str(item.get("id"))] = item

    def get(self, item_id: str) -> dict | None:
        return self._items.get(str(item_id))

    def ids(self) -> set[str]:
        return set(self._items)

    def all(self) -> list[dict]:
        return list(self._items.values())

    def merge(self, other: "ResourceRegistry") -> None:
        for key, item in other._items.items():
            self._items.setdefault(key, item)

    def clear(self) -> None:
        self._items.clear()

    def copy(self) -> "ResourceRegistry":
        return ResourceRegistry(self.all())


@dataclass
class Turn:
    chat_id: str
    turn: int
    system: "CompiledSystem"
    profile: dict | None
    user_message: str
    bus: EventBus
    resources: ResourceRegistry = field(default_factory=ResourceRegistry)
    outputs: list[dict] = field(default_factory=list)
    sent_messages: list[str] = field(default_factory=list)
    has_responded: bool = False
    memory_snapshot: str = ""
    # The conversational surface so far ({role, content}), this turn's user
    # message included: what retrievers see as the situation.
    conversation: list[dict] = field(default_factory=list)
    active_nodes: list[str] = field(default_factory=list)
    # False: nothing goes to the database; outputs are kept on ``sink`` (an
    # unsaved chat's in-memory transcript) instead.
    persist: bool = True
    sink: list[dict] | None = None
    # Safety guards (sbf.safety.guards): notes for nodes' instructions, the
    # feedback / replacement of a blocked reply, regenerations per node, verdicts.
    safety_notes: dict[str, list[str]] = field(default_factory=dict)
    guard_feedback: str = ""
    guard_replacement: str = ""
    guard_retries: dict[str, int] = field(default_factory=dict)
    guard_events: list[dict] = field(default_factory=list)

    def emit_output(self, type_: str, node: str | None, payload: dict) -> None:
        output = {"type": type_, "node": node, "turn": self.turn, "ts": now_iso(), **payload}
        if self.persist:
            output["id"] = db.add_output(self.chat_id, self.turn, type_, node, payload)
        elif self.sink is not None:
            output["id"] = len(self.sink) + 1
            self.sink.append(output)
        self.outputs.append(output)
        self.bus.put({"kind": "output", **output})

    def trace(self, agent: str, run: str | None, event: str, data: dict | None = None,
              persist: dict | None = None) -> None:
        """Stream *data* (small, clipped) live and store it with *persist*
        merged over it — the same keys, with full values and any extras."""
        data = data or {}
        if self.persist:
            try:
                db.add_trace(self.chat_id, self.turn, agent, run, event,
                             {**data, **persist} if persist else data)
            except Exception:
                pass  # instrumentation must never take down the turn
        self.bus.put({"kind": "trace", "agent": agent, "run": run, "event": event,
                      "turn": self.turn, "ts": now_iso(), "data": data})

    def surface(self, entry_label: str | None = None) -> list[str]:
        """The conversational surface of this turn: what the user said, what
        they were told, and delivery/mode events. Model monologue and tool
        traffic stay out."""
        lines = []
        for out in self.outputs:
            t = out["type"]
            if t == "user":
                if out.get("content", "").strip():
                    lines.append(f"user: {out['content'].strip()}")
            elif t == "message":
                lines.append(f"{entry_label or out.get('node') or 'assistant'}: {out['content'].strip()}")
            elif t == "mode":
                lines.append(f"event: switched topic mode to {out.get('mode', '?')}")
            elif t in ("file", "viewer"):
                lines.append(f"event: delivered resource {out.get('resource_id') or out.get('title')} to the user")
            elif t == "handoff":
                lines.append(f"event: conversation handed to {out.get('to')}")
        return lines


@dataclass
class AgentRun:
    node: "CompiledNode"
    turn: Turn
    kind: str  # conversation | delegate | observe
    user_facing: bool
    resources: ResourceRegistry
    budgets: dict[str, int] = field(default_factory=dict)
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    tool_calls: int = 0
    llm_calls: int = 0
    terminal_result: Any = UNSET
    done: bool = False
    last_text: str = ""
    truncated: bool = False
    last_response_empty: bool = False
    tools_in_response: list[dict] = field(default_factory=list)
    model_started: float | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    request: str = ""  # delegate/observe: the message the run was started with
    # Injected context per (name, question, scope), so it is retrieved once
    # per change rather than on every model call.
    context_cache: dict[tuple, str] = field(default_factory=dict)

    @property
    def finished(self) -> bool:
        return self.done or self.terminal_result is not UNSET

    def trace(self, event: str, data: dict | None = None, persist=None, agent: str | None = None):
        self.turn.trace(agent or self.node.id, self.id, event, data, persist)


class _Scopes:
    """ADK session id → {agent name → AgentRun}."""

    def __init__(self):
        self._scopes: dict[str, dict[str, AgentRun]] = {}

    def register(self, session_id: str, runs: dict[str, AgentRun]) -> None:
        self._scopes[session_id] = runs

    def release(self, session_id: str) -> None:
        self._scopes.pop(session_id, None)

    def find(self, session_id: str, agent_name: str) -> AgentRun | None:
        return (self._scopes.get(session_id) or {}).get(agent_name)

    def get(self, session_id: str, agent_name: str) -> AgentRun:
        run = self.find(session_id, agent_name)
        if run is None:
            raise RuntimeError(f"No run registered for agent {agent_name!r} in session {session_id!r}")
        return run


scopes = _Scopes()


# ------------------------------------------------------------- delivery

# How similar (0..1) a new message must be to an already-sent one this turn
# to be suppressed as a repeat. Small models re-emit their previous message
# near-verbatim instead of ending the turn.
SIMILARITY_THRESHOLD = 0.90


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip().casefold()


def _similarity(a: str, b: str) -> float:
    m = SequenceMatcher(None, a, b)
    if m.real_quick_ratio() < SIMILARITY_THRESHOLD or m.quick_ratio() < SIMILARITY_THRESHOLD:
        return 0.0
    return m.ratio()


def deliver_message(run: AgentRun, text: str) -> str | None:
    """Deliver *text* to the user; returns a SUPPRESSED notice for repeats."""
    turn = run.turn
    normalized = _normalize(text)
    if not normalized:
        return "ERROR: empty message"
    for prior in turn.sent_messages:
        score = _similarity(normalized, prior)
        if score >= SIMILARITY_THRESHOLD:
            return (f"SUPPRESSED: this message is {round(score * 100)}% identical to one you "
                    "already sent this turn, so it was NOT delivered. Do not repeat yourself. "
                    "Say something genuinely new, or if you have nothing to add, end your turn.")
    turn.sent_messages.append(normalized)
    turn.has_responded = True
    turn.emit_output("message", run.node.id, {"content": text.strip()})
    return None
