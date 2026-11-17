"""
Running simulations.

``create_run`` expands a ``SimRunConfig`` into its conversations (system ×
scenario × persona × repetition, interleaved so systems are compared on
the same scenario close together in time), freezes the personas, scenarios
and rubric it uses, and starts it. ``runner`` executes runs as tasks in
the server's event loop:

* every system is compiled once and pinned for the whole run (its
  snapshot hash is recorded), so editing definitions mid-run changes
  nothing;
* conversations run ``concurrency`` at a time. Each is an ordinary chat
  (origin 'simulation') driven turn by turn on a live stream — open it in
  the chat page to watch — with a throwaway profile so memory agents run;
* after the last turn, deterministic checks and (with a rubric) the LLM
  judge grade it.

A run interrupted by a server restart resumes its queued conversations;
the ones that were mid-way are marked failed and can be retried.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid

from .. import db
from ..memory import memory_store
from ..runtime import CompileError, compile_system, get_engine
from ..schemas import PersonaDef, RubricDef, ScenarioDef, SimRunConfig
from ..workspace import ACTOR, NotFound, now_iso, workspace
from . import results, store
from .judge import checks, judge
from .simulator import assistant_view, next_message

log = logging.getLogger(__name__)


def plan(config: SimRunConfig) -> tuple[list[dict], dict, list[str]]:
    """(conversations, frozen definitions, problems)."""
    problems: list[str] = []
    for sid in config.systems:
        if not workspace.systems.exists(sid):
            problems.append(f"system {sid!r} not found")
    scenarios, personas = {}, {}
    for scid in config.scenarios:
        try:
            scenarios[scid] = workspace.scenarios.get(scid)
        except NotFound:
            problems.append(f"scenario {scid!r} not found")
    persona_ids = set(config.personas)
    for scen in scenarios.values():
        if not config.personas:
            if not scen.persona:
                problems.append(f"scenario {scen.id!r} has no persona; pick personas for the run")
            persona_ids.add(scen.persona)
    for pid in persona_ids - {""}:
        try:
            personas[pid] = workspace.personas.get(pid)
        except NotFound:
            problems.append(f"persona {pid!r} not found")
    rubric = None
    if config.rubric:
        try:
            rubric = workspace.rubrics.get(config.rubric)
        except NotFound:
            problems.append(f"rubric {config.rubric!r} not found")
    conversations = []
    for rep in range(1, config.repetitions + 1):
        for scid, scen in scenarios.items():
            for pid in (config.personas or [scen.persona]):
                for sid in config.systems:
                    conversations.append({"system_id": sid, "scenario_id": scid, "persona_id": pid, "rep": rep})
    definitions = {"personas": {k: v.model_dump() for k, v in personas.items()},
                   "scenarios": {k: v.model_dump() for k, v in scenarios.items()},
                   "rubric": rubric.model_dump() if rubric else None}
    return conversations, definitions, problems


def create_run(config: SimRunConfig) -> dict:
    conversations, definitions, problems = plan(config)
    if problems:
        raise ValueError("; ".join(problems))
    run_id = f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4]}"
    name = config.name or f"{', '.join(config.systems)} × {len(config.scenarios)} scenario(s)"
    run = store.create_run(run_id, name, config.model_dump(), definitions, conversations, ACTOR.get())
    runner.start(run_id)
    return run


async def cleanup_conversation(conv: dict) -> None:
    """Delete a conversation's chat (and its session) and throwaway profile."""
    if conv.get("chat_id"):
        await get_engine().delete_chat(conv["chat_id"])
    if conv.get("profile_id"):
        profile = db.get_profile(conv["profile_id"])
        if profile and profile.get("origin") == "simulation":
            db.delete_profile(conv["profile_id"])


class Runner:
    def __init__(self):
        self.tasks: dict[str, asyncio.Task] = {}
        self.judging: dict[str, asyncio.Task] = {}
        self.cancelled: set[str] = set()

    def running(self, run_id: str) -> bool:
        task = self.tasks.get(run_id)
        return bool(task and not task.done())

    def is_judging(self, run_id: str) -> bool:
        task = self.judging.get(run_id)
        return bool(task and not task.done())

    def rejudge(self, run_id: str, rubric: RubricDef, conv_ids: list[int] | None = None,
                model=None, concurrency: int = 4) -> int:
        """Grade a run's finished conversations with a rubric, in the background."""
        if self.is_judging(run_id):
            raise RuntimeError("This run is already being judged")
        run = store.get_run(run_id)
        convs = [c for c in store.list_conversations(run_id)
                 if c["status"] == "completed" and c["chat_id"] and (conv_ids is None or c["id"] in conv_ids)]
        slots = asyncio.Semaphore(concurrency)

        async def one(conv):
            async with slots:
                scenario = ScenarioDef.model_validate(run["definitions"]["scenarios"][conv["scenario_id"]])
                try:
                    await judge_conversation(conv, rubric, scenario, model)
                except Exception:
                    log.exception("re-judging conversation %s failed", conv["id"])

        async def all_():
            await asyncio.gather(*(one(c) for c in convs))

        task = asyncio.get_running_loop().create_task(all_())
        self.judging[run_id] = task
        task.add_done_callback(lambda _t: self.judging.pop(run_id, None))
        return len(convs)

    def start(self, run_id: str) -> None:
        if self.running(run_id):
            return
        self.cancelled.discard(run_id)
        task = asyncio.get_running_loop().create_task(self._run(run_id))
        self.tasks[run_id] = task
        task.add_done_callback(lambda _t: self.tasks.pop(run_id, None))

    def resume(self) -> None:
        """At startup: runs left running by a restart continue."""
        for run in store.active_runs():
            for conv in store.list_conversations(run["id"]):
                if conv["status"] in ("running", "judging"):
                    store.update_conversation(conv["id"], status="failed", finished_at=now_iso(),
                                              error="interrupted by a server restart")
            self.start(run["id"])

    def cancel(self, run_id: str) -> None:
        """Queued conversations are cancelled; running ones stop after their current turn."""
        self.cancelled.add(run_id)
        for conv in store.list_conversations(run_id):
            if conv["status"] == "queued":
                store.update_conversation(conv["id"], status="cancelled")
        if not self.running(run_id):
            run = store.get_run(run_id)
            if run and run["status"] not in store.RUN_DONE:
                store.update_run(run_id, status="cancelled", finished_at=now_iso())

    async def _run(self, run_id: str) -> None:
        run = store.get_run(run_id)
        if run is None:
            return
        config = SimRunConfig.model_validate(run["config"])
        store.update_run(run_id, status="running", started_at=run["started_at"] or now_iso())
        try:
            compiled = {}
            for sid in config.systems:
                compiled[sid] = compile_system(sid)
                db.save_snapshot(compiled[sid].hash, compiled[sid].snapshot)
        except (CompileError, NotFound) as exc:
            store.update_run(run_id, status="failed", finished_at=now_iso(),
                             error=f"system can't be compiled: {exc}")
            return
        store.update_run(run_id, systems={sid: c.hash for sid, c in compiled.items()})
        slots = asyncio.Semaphore(config.concurrency)

        async def one(conv: dict):
            async with slots:
                if run_id in self.cancelled:
                    store.update_conversation(conv["id"], status="cancelled")
                    return
                await self._conversation(run, config, conv, compiled[conv["system_id"]])

        queued = [c for c in store.list_conversations(run_id) if c["status"] == "queued"]
        await asyncio.gather(*(one(c) for c in queued))
        status = "cancelled" if run_id in self.cancelled else "completed"
        store.update_run(run_id, status=status, finished_at=now_iso())

    async def _conversation(self, run: dict, config: SimRunConfig, conv: dict, compiled) -> None:
        run_id = run["id"]
        defs = run["definitions"]
        persona = PersonaDef.model_validate(defs["personas"][conv["persona_id"]])
        scenario = ScenarioDef.model_validate(defs["scenarios"][conv["scenario_id"]])
        max_turns = config.max_turns or scenario.max_turns
        engine = get_engine()
        metrics: dict = {"turn_seconds": [], "simulator": {"calls": 0, "cost": 0.0, "tokens": 0}, "warnings": []}
        store.update_conversation(conv["id"], status="running", started_at=now_iso())
        chat_id = None
        try:
            profile_id = None
            if config.profile_mode == "fresh":
                profile = db.create_profile(f"sim {run_id} #{conv['idx'] + 1}", origin="simulation")
                profile_id = profile["id"]
                if scenario.profile:
                    source = db.find_profile(scenario.profile)
                    if source:
                        metrics["memory_copied"] = memory_store.copy_profile(source["id"], profile_id)
                    else:
                        metrics["warnings"].append(f"profile {scenario.profile!r} not found; started empty")
            chat = await engine.create_chat(conv["system_id"], profile_id, origin="simulation",
                                            run_id=run_id, compiled=compiled)
            chat_id = chat["id"]
            store.update_conversation(conv["id"], chat_id=chat_id, profile_id=profile_id)
            seen: list[dict] = []
            ended_by = "max_turns"
            for n in range(max_turns):
                if run_id in self.cancelled:
                    ended_by = "cancelled"
                    break
                text, ended, out = await next_message(persona, scenario, seen, config.simulator_model)
                if out is not None:
                    sim = metrics["simulator"]
                    sim["calls"] += 1
                    sim["cost"] += out.cost or 0.0
                    sim["tokens"] += out.usage.get("total_tokens") or 0
                if not text:
                    ended_by = "persona" if ended else "empty_message"
                    break
                seen.append({"role": "user", "content": text})
                started = time.perf_counter()
                turn = await engine.run_live_turn(chat_id, text, compiled)
                metrics["turn_seconds"].append(round(time.perf_counter() - started, 2))
                seen.append({"role": "assistant", "content": assistant_view(turn.outputs)})
                store.update_conversation(conv["id"], turns=n + 1, metrics=metrics)
                if ended:
                    ended_by = "persona"
                    break
            metrics["simulator"]["cost"] = round(metrics["simulator"]["cost"], 6)
            metrics["chat"] = results.chat_metrics(chat_id)
            transcript = results.transcript(chat_id)
            metrics["checks"] = checks(scenario, transcript)
            store.update_conversation(conv["id"], ended_by=ended_by, metrics=metrics)
            rubric = defs.get("rubric")
            if rubric and transcript and ended_by != "cancelled":
                store.update_conversation(conv["id"], status="judging")
                await judge_conversation(store.get_conversation(conv["id"]), RubricDef.model_validate(rubric),
                                         scenario, config.judge_model, transcript)
            store.update_conversation(conv["id"], status="cancelled" if ended_by == "cancelled" else "completed",
                                      finished_at=now_iso())
        except Exception as exc:
            log.exception("simulation %s #%s failed", run_id, conv["idx"])
            metrics["chat"] = results.chat_metrics(chat_id) if chat_id else {}
            store.update_conversation(conv["id"], status="failed", finished_at=now_iso(), metrics=metrics,
                                      error=f"{type(exc).__name__}: {exc}"[:1000])


async def judge_conversation(conv: dict, rubric: RubricDef, scenario: ScenarioDef, model=None,
                             transcript: list[dict] | None = None) -> dict:
    transcript = transcript if transcript is not None else results.transcript(conv["chat_id"])
    graded = await judge(rubric, scenario, transcript, model)
    store.add_judgment(conv, rubric.model_dump(), graded.get("model") or "", graded["status"],
                       graded.get("result"), graded.get("score"), graded.get("expectation_score"),
                       graded.get("error"), graded.get("cost"))
    return graded


runner = Runner()
