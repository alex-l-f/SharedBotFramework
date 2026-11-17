"""
The chat engine: sessions and turns.

A chat is an ADK session in a persistent SQLite session service (session
id = chat id). A turn compiles the chat's system from the current
definitions, records the snapshot hash, runs the user-facing agent tree for
one invocation, makes sure the user got a reply, emits ``turn_done``, then
runs observers (e.g. memory extraction) while the event stream stays open
for their traces.

Unsaved chats (``saved=False``; public links that keep no transcripts) run
the same way, but their ADK session, transcript and traces exist only in
this process: nothing about the conversation is written to disk, and it is
gone once dropped (idle, ended by the visitor, or a server restart).
Memory notes a memory agent records stay (they are template notes, never
transcript text).
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid

from google.adk.events import Event
from google.adk.sessions import InMemorySessionService
from google.adk.sessions.sqlite_session_service import SqliteSessionService
from google.genai import types

from .. import db
from ..memory import memory_store
from ..settings import DATA_DIR
from ..workspace import now_iso
from .adk import build_agent, make_runner, run_until_done
from .builder import CompiledSystem, compile_system, initial_state
from .context import AgentRun, EventBus, Turn, clip, deliver_message, scopes
from .delegation import run_observers

log = logging.getLogger(__name__)

APP_NAME = "sbf"

# What the user gets when no model call manages a reply (an upstream outage
# during recovery, say), so a turn never ends in silence.
FALLBACK_REPLY = ("Sorry, I couldn't put my reply together just then. "
                  "Could you send your last message again?")


def conversation_surface(chat_id: str) -> list[dict]:
    """What the user saw so far, as {role, content} messages."""
    out = []
    for o in get_engine().outputs(chat_id):
        if o["type"] == "user":
            out.append({"role": "user", "content": o.get("content") or ""})
        elif o["type"] == "message" and o.get("content"):
            if out and out[-1]["role"] == "assistant":
                out[-1]["content"] += "\n\n" + o["content"]
            else:
                out.append({"role": "assistant", "content": o["content"]})
    return out


def adk_user(profile_id: int | None) -> str:
    return f"profile:{profile_id}" if profile_id else "anonymous"


class Engine:
    def __init__(self):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.sessions = SqliteSessionService(str(DATA_DIR / "sessions.db"))
        # Unsaved chats: chat id → {"chat", "outputs", "touched" (monotonic)}.
        self.memory_sessions = InMemorySessionService()
        self.unsaved: dict[str, dict] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self.live: dict[str, EventBus] = {}
        self._tasks: set[asyncio.Task] = set()

    # ------------------------------------------------------------- chats

    async def create_chat(self, system_id: str, profile_id: int | None = None, *,
                          origin: str = "chat", run_id: str | None = None,
                          chat_id: str | None = None, compiled: CompiledSystem | None = None,
                          user_id: int | None = None, link_id: str | None = None,
                          saved: bool = True) -> dict:
        compiled = compiled or compile_system(system_id)
        if profile_id and db.get_profile(profile_id) is None:
            raise ValueError(f"Unknown profile {profile_id}")
        chat_id = chat_id or str(uuid.uuid4())
        service = self.sessions if saved else self.memory_sessions
        await service.create_session(app_name=APP_NAME, user_id=adk_user(profile_id),
                                     session_id=chat_id, state=initial_state(compiled))
        if saved:
            return db.create_chat(chat_id, compiled.system.id, profile_id, origin=origin, run_id=run_id,
                                  user_id=user_id, link_id=link_id)
        ts = now_iso()
        chat = {"id": chat_id, "system_id": compiled.system.id, "profile_id": profile_id, "title": None,
                "origin": origin, "run_id": run_id, "user_id": user_id, "link_id": link_id, "turns": 0,
                "created_at": ts, "updated_at": ts, "unsaved": True}
        self.unsaved[chat_id] = {"chat": chat, "outputs": [], "touched": time.monotonic()}
        return dict(chat)

    def get_chat(self, chat_id: str) -> dict | None:
        """A chat, saved or unsaved."""
        record = self.unsaved.get(chat_id)
        return dict(record["chat"]) if record else db.get_chat(chat_id)

    def outputs(self, chat_id: str) -> list[dict]:
        """What the user saw, saved or unsaved."""
        record = self.unsaved.get(chat_id)
        return list(record["outputs"]) if record else db.list_outputs(chat_id)

    def _service(self, chat: dict):
        return self.memory_sessions if chat.get("unsaved") else self.sessions

    async def get_session(self, chat: dict):
        return await self._service(chat).get_session(app_name=APP_NAME, user_id=adk_user(chat["profile_id"]),
                                                     session_id=chat["id"])

    async def delete_chat(self, chat_id: str) -> None:
        chat = self.get_chat(chat_id)
        if chat is None:
            return
        try:
            await self._service(chat).delete_session(app_name=APP_NAME, user_id=adk_user(chat["profile_id"]),
                                                     session_id=chat_id)
        except Exception:
            pass
        if chat.get("unsaved"):
            self.unsaved.pop(chat_id, None)
            self.live.pop(chat_id, None)
        else:
            db.delete_chat(chat_id)

    async def drop_idle(self, max_idle: dict[str, float] | None = None, default: float = 3600) -> int:
        """Drop unsaved chats idle longer than their limit (seconds; by chat id,
        else ``default``) and not mid-turn."""
        now = time.monotonic()
        dropped = 0
        for chat_id, record in list(self.unsaved.items()):
            limit = (max_idle or {}).get(chat_id, default)
            if now - record["touched"] > limit and not self.is_running(chat_id):
                await self.delete_chat(chat_id)
                dropped += 1
        return dropped

    # -------------------------------------------------------------- turns

    def is_running(self, chat_id: str) -> bool:
        """A turn is in progress (its observers may still run after this is False)."""
        bus = self.live.get(chat_id)
        return bool(bus and not bus.turn_done)

    def start_turn(self, chat_id: str, text: str) -> EventBus:
        """Run a turn in the background; returns its live event stream."""
        if self.is_running(chat_id):
            raise RuntimeError("A turn is already running in this chat")
        bus = EventBus()
        self.live[chat_id] = bus
        task = asyncio.create_task(self.run_turn(chat_id, text, bus))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return bus

    async def run_live_turn(self, chat_id: str, text: str, compiled: CompiledSystem | None = None) -> Turn:
        """Run a turn in the caller's task, on a live stream the chat page can
        attach to (simulations)."""
        if self.is_running(chat_id):
            raise RuntimeError("A turn is already running in this chat")
        bus = EventBus()
        self.live[chat_id] = bus
        return await self.run_turn(chat_id, text, bus, compiled=compiled)

    async def run_turn(self, chat_id: str, text: str, bus: EventBus | None = None,
                       compiled: CompiledSystem | None = None) -> Turn:
        """Run one turn, then its observers. The chat is locked only for the
        turn itself: once the user has the reply, they can send the next
        message while observers (memory extraction, …) still run.
        ``compiled`` pins the definitions (a simulation run compiles once)."""
        bus = bus or EventBus()
        lock = self._locks.setdefault(chat_id, asyncio.Lock())
        try:
            async with lock:
                turn = await self._turn(chat_id, text, bus, compiled)
            await run_observers(turn)
            turn.trace(turn.system.entry.id, None, "turn_done", {})
            return turn
        except Exception as exc:
            log.exception("%s: turn failed", chat_id)
            bus.put({"kind": "error", "message": f"{type(exc).__name__}: {exc}"})
            bus.put({"kind": "turn_done"})
            raise
        finally:
            bus.close()

    async def _turn(self, chat_id: str, text: str, bus: EventBus,
                    compiled: CompiledSystem | None = None) -> Turn:
        chat = self.get_chat(chat_id)
        if chat is None:
            raise KeyError(f"Unknown chat {chat_id}")
        text = (text or "").strip()
        if not text:
            raise ValueError("A turn needs a user message")
        if compiled is None or compiled.system.id != chat["system_id"]:
            compiled = compile_system(chat["system_id"])
        db.save_snapshot(compiled.hash, compiled.snapshot)  # definitions, not conversation
        record = self.unsaved.get(chat_id)
        if record is None:
            turn_no = db.begin_turn(chat_id, text)
            db.link_turn_snapshot(chat_id, turn_no, compiled.hash)
        else:
            record["chat"]["turns"] = turn_no = record["chat"]["turns"] + 1
            record["chat"]["updated_at"] = now_iso()
            record["chat"]["snapshot"] = compiled.hash
            record["touched"] = time.monotonic()
        profile = db.get_profile(chat["profile_id"])
        turn = Turn(chat_id=chat_id, turn=turn_no, system=compiled, profile=profile,
                    user_message=text, bus=bus, persist=record is None)
        if record is not None:
            turn.sink = record["outputs"]
        bus.put({"kind": "turn_start", "turn": turn_no, "snapshot": compiled.hash})
        turn.conversation = conversation_surface(chat_id) + [{"role": "user", "content": text}]
        turn.emit_output("user", None, {"content": text})

        entry = compiled.entry
        if compiled.guards:
            from ..safety import check_input
            blocked = await check_input(turn)
            if blocked is not None:
                await self._blocked_turn(chat, turn, blocked)
                bus.put({"kind": "turn_done", "turn": turn_no})
                return turn
        if compiled.memory_enabled and profile and any(
                n.node.inject_memory for n in compiled.nodes.values() if n.user_facing):
            turn.memory_snapshot = memory_store.profile_block(
                compiled.memory_namespace, compiled.memory_schema, profile["id"], exclude_chat=chat_id)
            if turn.memory_snapshot:
                turn.trace("memory", None, "inject", {"chars": len(turn.memory_snapshot)},
                           persist={"block": turn.memory_snapshot})

        # One run per user-facing node; they share the turn's resources.
        runs = {nid: AgentRun(node=n, turn=turn, kind="conversation", user_facing=True,
                              resources=turn.resources,
                              budgets={b.function_name: b.budget for b in n.bindings if b.budget})
                for nid, n in compiled.nodes.items() if n.user_facing}
        scopes.register(chat_id, runs)
        user = adk_user(chat["profile_id"])
        max_calls = max(n.max_llm_calls for n in compiled.nodes.values() if n.user_facing)
        service = self._service(chat)
        try:
            runner = make_runner(build_agent(compiled, entry, user_facing=True, with_handoffs=True),
                                 service, APP_NAME)
            turn.trace(entry.id, None, "turn_start", {"user_message": clip(text, 300),
                                                      "snapshot": compiled.hash})
            try:
                await run_until_done(runner, user_id=user, session_id=chat_id, text=text,
                                     max_llm_calls=max_calls)
            except Exception as exc:
                # An upstream failure that outlasted retries: recovery still
                # owes the user a reply.
                log.exception("%s: agent run failed", chat_id)
                turn.trace(entry.id, None, "run_error", {"error": clip(f"{type(exc).__name__}: {exc}", 300)})
            await self._ensure_reply(compiled, turn, runs, runner, user, service)
        finally:
            scopes.release(chat_id)

        bus.put({"kind": "turn_done", "turn": turn_no})
        return turn

    async def _blocked_turn(self, chat: dict, turn: Turn, reply: str) -> None:
        """An input guard blocked the message: the fixed reply goes out, and
        the exchange is recorded in the session so later turns see it."""
        entry = turn.system.entry
        turn.emit_output("message", entry.id, {"content": reply, "safety": True})
        turn.has_responded = True
        service = self._service(chat)
        session = await self.get_session(chat)
        for author, role, text in (("user", "user", turn.user_message), (entry.id, "model", reply)):
            await service.append_event(session=session, event=Event(
                author=author, invocation_id="guard",
                content=types.Content(role=role, parts=[types.Part(text=text)])))
            session = await self.get_session(chat)

    def _reply_missing(self, turn: Turn, runs: dict[str, AgentRun]) -> bool:
        """Nothing reached the user, or the last response hit the output cap
        before writing anything (the answer never came)."""
        last = next((runs[n] for n in reversed(turn.active_nodes) if n in runs), None)
        return (not turn.has_responded
                or bool(last and last.truncated and last.last_response_empty))

    async def _ensure_reply(self, compiled: CompiledSystem, turn: Turn,
                            runs: dict[str, AgentRun], runner, user: str, service) -> None:
        """A miss is first nudged on the same model, then retried with
        thinking off; a miss caused by the output cap skips the nudge (the
        model spent its budget thinking and tends to do it again). If no
        model call delivers anything, a fixed message does."""
        last = next((runs[n] for n in reversed(turn.active_nodes) if n in runs), None)
        truncated = bool(last and last.truncated)
        attempts = ([] if truncated else ["same"]) + ["no_thinking"]
        for attempt in attempts:
            if not self._reply_missing(turn, runs):
                return
            if attempt == "no_thinking":
                runner = make_runner(build_agent(compiled, compiled.entry, user_facing=True,
                                                 with_handoffs=True, reasoning_override="none"),
                                     service, APP_NAME)
            why = ("Your last response ran out of output space before any reply was written, so "
                   "the user has not received your answer." if truncated
                   else turn.guard_feedback or "No reply reached the user this turn.")
            text_mode = compiled.entry.agent.reply_mode == "text"
            how = ("Write your reply to the user now." if text_mode
                   else "Deliver your reply now with the send_message tool.")
            turn.trace(compiled.entry.id, None, "reply_recovery",
                       {"after_truncation": truncated, "thinking": attempt == "same"})
            for run in runs.values():
                run.done = False
            try:
                await run_until_done(runner, user_id=user, session_id=turn.chat_id,
                                     text=f"{why} {how}", max_llm_calls=3,
                                     custom_metadata={"sbf_nudge": True})
            except Exception as exc:
                log.warning("%s: reply recovery failed: %s", turn.chat_id, exc)
            truncated = bool(last and last.truncated)
        if self._reply_missing(turn, runs):
            deliver_message(runs[compiled.entry.id], turn.guard_replacement or FALLBACK_REPLY)
            # Recorded in the session too, so later turns see what was said.
            chat = self.get_chat(turn.chat_id)
            session = await self.get_session(chat)
            await service.append_event(session=session, event=Event(
                author=compiled.entry.id, invocation_id="fallback",
                content=types.Content(role="model", parts=[types.Part(
                    text=turn.guard_replacement or FALLBACK_REPLY)])))
            turn.trace(compiled.entry.id, None, "reply_fallback", {})


engine: Engine | None = None


def get_engine() -> Engine:
    global engine
    if engine is None:
        engine = Engine()
    return engine
