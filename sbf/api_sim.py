"""
Simulations API: personas, scenarios and rubrics (definitions), and runs
(plan, start, watch, cancel, retry, re-judge, summarize, export).
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel, ValidationError

from .schemas import ModelSpec, PersonaDef, RubricDef, ScenarioDef, SimRunConfig
from .sim import cleanup_conversation, create_run, plan, results, runner, store
from .sim.judge import judge_prompt
from .sim.simulator import system_prompt
from .workspace import expected_version, workspace

router = APIRouter(prefix="/api")


def _parse(model, data: dict):
    from .app import _validation_detail
    data = {k: v for k, v in data.items() if k not in ("version", "used_by")}
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        raise HTTPException(422, detail=_validation_detail(exc)) from None


# --------------------------------------------------------------- definitions

def _persona_users(persona_id: str) -> list[str]:
    return [s.id for s in workspace.scenarios.list() if s.persona == persona_id]


def _crud(path: str, collection, model, label: str, users=None):
    """list / get / create / update / delete routes for a definition collection."""

    def summary(item) -> dict:
        return {**collection.dump(item), **({"used_by": users(item.id)} if users else {})}

    @router.get(f"/{path}", name=f"list_{path}")
    def list_items():
        return [summary(i) for i in collection.list()]

    @router.get(f"/{path}/{{item_id}}", name=f"get_{path}")
    def get_item(item_id: str):
        return summary(collection.get(item_id))

    @router.post(f"/{path}", status_code=201, name=f"create_{path}")
    def create_item(data: dict):
        item = _parse(model, data)
        if collection.exists(item.id):
            raise HTTPException(409, f"{label} {item.id!r} already exists")
        return summary(collection.save(item))

    @router.put(f"/{path}/{{item_id}}", name=f"update_{path}")
    def update_item(item_id: str, data: dict, if_match: str | None = Header(None)):
        return summary(collection.save(_parse(model, {**data, "id": item_id}), expected_version(if_match)))

    @router.delete(f"/{path}/{{item_id}}", name=f"delete_{path}")
    def delete_item(item_id: str, if_match: str | None = Header(None)):
        collection.get(item_id)
        used = users(item_id) if users else []
        if used:
            raise HTTPException(409, f"{label} is used by: {', '.join(used)}")
        collection.delete(item_id, expected_version(if_match))
        return {"ok": True}


_crud("personas", workspace.personas, PersonaDef, "Persona", _persona_users)
_crud("scenarios", workspace.scenarios, ScenarioDef, "Scenario")
_crud("rubrics", workspace.rubrics, RubricDef, "Rubric")


class PromptPreviewBody(BaseModel):
    persona: str | dict | None = None
    scenario: str | dict
    rubric: str | dict | None = None


@router.post("/simulations/preview-prompts")
def preview_prompts(body: PromptPreviewBody):
    """The simulator's system prompt for a persona × scenario (persona: the
    scenario's own when omitted) and, with a rubric, the judge's."""
    scenario = (_parse(ScenarioDef, {"id": "draft", **body.scenario}) if isinstance(body.scenario, dict)
                else workspace.scenarios.get(body.scenario))
    if isinstance(body.persona, dict):
        persona = _parse(PersonaDef, {"id": "draft", **body.persona})
    elif body.persona or scenario.persona:
        persona = workspace.personas.get(body.persona or scenario.persona)
    else:
        persona = None
    out = {"simulator": system_prompt(persona, scenario) if persona else None}
    if body.rubric:
        rubric = (_parse(RubricDef, {"id": "draft", **body.rubric}) if isinstance(body.rubric, dict)
                  else workspace.rubrics.get(body.rubric))
        out["judge"] = judge_prompt(rubric, scenario, [{"role": "user", "content": "…"},
                                                       {"role": "assistant", "content": "…"}])
    return out


# ---------------------------------------------------------------------- runs

def _run_detail(run: dict, rubric: str | None = None) -> dict:
    judged = results.latest_judgments(run["id"], rubric or run["config"].get("rubric") or None)
    convs = []
    for c in store.list_conversations(run["id"]):
        j = judged.get(c["id"])
        m = c["metrics"]
        convs.append({**{k: c[k] for k in ("id", "idx", "system_id", "scenario_id", "persona_id", "rep",
                                           "status", "chat_id", "turns", "ended_by", "error", "started_at",
                                           "finished_at")},
                      "seconds": round(sum(m.get("turn_seconds", [])), 1),
                      "checks": m.get("checks"),
                      "score": j["score"] if j else None,
                      "expectation_score": j["expectation_score"] if j else None,
                      "judge_status": j["status"] if j else None})
    counts: dict[str, int] = {}
    for c in convs:
        counts[c["status"]] = counts.get(c["status"], 0) + 1
    return {**run, "conversations": convs, "counts": counts, "active": runner.running(run["id"]),
            "judging": runner.is_judging(run["id"])}


def _get_run(run_id: str) -> dict:
    run = store.get_run(run_id)
    if run is None:
        raise HTTPException(404, "Run not found")
    return run


@router.get("/simulations")
def list_runs():
    return [{**r, "active": runner.running(r["id"]), "judging": runner.is_judging(r["id"])}
            for r in store.list_runs()]


@router.post("/simulations/plan")
def plan_run(data: dict):
    """What a config would run: conversation count and problems, without starting."""
    config = _parse(SimRunConfig, data)
    conversations, definitions, problems = plan(config)
    max_turns = sum(config.max_turns or definitions["scenarios"].get(c["scenario_id"], {}).get("max_turns", 0)
                    for c in conversations)
    return {"conversations": len(conversations), "max_turns": max_turns, "problems": problems,
            "judged": bool(config.rubric), "sample": conversations[:12]}


@router.post("/simulations", status_code=201)
async def start_run(data: dict):
    config = _parse(SimRunConfig, data)
    try:
        run = create_run(config)
    except ValueError as exc:
        raise HTTPException(422, detail=[str(exc)]) from None
    return _run_detail(run)


@router.get("/simulations/{run_id}")
def get_run(run_id: str, rubric: str | None = None):
    """The run and its conversations, scored by ``rubric`` (default: the run's)."""
    return _run_detail(_get_run(run_id), rubric)


@router.post("/simulations/{run_id}/cancel")
async def cancel_run(run_id: str):
    _get_run(run_id)
    runner.cancel(run_id)
    return _run_detail(_get_run(run_id))


class RetryBody(BaseModel):
    conversation_ids: list[int] | None = None


@router.post("/simulations/{run_id}/retry")
async def retry(run_id: str, body: RetryBody | None = None):
    """Run failed / cancelled conversations again (fresh chats)."""
    _get_run(run_id)
    if runner.running(run_id):
        raise HTTPException(409, "The run is still going; retry once it has finished")
    ids = set(body.conversation_ids) if body and body.conversation_ids else None
    todo = [c for c in store.list_conversations(run_id)
            if c["status"] in ("failed", "cancelled") and (ids is None or c["id"] in ids)]
    for conv in todo:
        await cleanup_conversation(conv)
        store.reset_conversation(conv["id"])
    if todo:
        store.update_run(run_id, status="queued", finished_at=None, error=None)
        runner.start(run_id)
    return {"retried": len(todo)}


class JudgeBody(BaseModel):
    rubric: str
    conversation_ids: list[int] | None = None
    model: ModelSpec | None = None


@router.post("/simulations/{run_id}/judge")
async def rejudge(run_id: str, body: JudgeBody):
    """Grade the run's finished conversations with a rubric (in the background)."""
    _get_run(run_id)
    rubric = workspace.rubrics.get(body.rubric)
    try:
        n = runner.rejudge(run_id, rubric, body.conversation_ids, body.model)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from None
    return {"judging": n}


@router.delete("/simulations/{run_id}")
async def delete_run(run_id: str):
    _get_run(run_id)
    if runner.running(run_id) or runner.is_judging(run_id):
        raise HTTPException(409, "Cancel the run (and wait for it to stop) before deleting it")
    for conv in store.delete_run(run_id):
        await cleanup_conversation(conv)
    return {"ok": True}


@router.get("/simulations/{run_id}/summary")
def run_summary(run_id: str, rubric: str | None = None):
    _get_run(run_id)
    return results.summary(run_id, rubric)


@router.get("/simulations/{run_id}/export")
def export_run(run_id: str, format: str = "jsonl", full: bool = True, rubric: str | None = None):
    """jsonl: one record per conversation (transcript, metrics, judgments and,
    with full, outputs, traces and the definitions); csv: one row each."""
    run = _get_run(run_id)
    if format == "csv":
        return PlainTextResponse(results.csv_text(run_id, rubric), media_type="text/csv",
                                 headers={"Content-Disposition": f'attachment; filename="{run_id}.csv"'})
    if format != "jsonl":
        raise HTTPException(400, "format must be jsonl or csv")

    def lines():
        yield json.dumps({"type": "run", **run}, ensure_ascii=False, default=str) + "\n"
        for record in results.records(run_id, full=full):
            yield json.dumps({"type": "conversation", **record}, ensure_ascii=False, default=str) + "\n"

    return StreamingResponse(lines(), media_type="application/x-ndjson",
                             headers={"Content-Disposition": f'attachment; filename="{run_id}.jsonl"'})


@router.get("/simulations/conversations/{conv_id}")
def get_conversation(conv_id: int):
    conv = store.get_conversation(conv_id)
    if conv is None:
        raise HTTPException(404, "Conversation not found")
    run = _get_run(conv["run_id"])
    defs = run["definitions"]
    return {**conv, "run": {k: run[k] for k in ("id", "name", "status", "config", "systems")},
            "transcript": results.transcript(conv["chat_id"]),
            "judgments": store.judgments(conversation_id=conv_id),
            "scenario": defs.get("scenarios", {}).get(conv["scenario_id"]),
            "persona": defs.get("personas", {}).get(conv["persona_id"])}
