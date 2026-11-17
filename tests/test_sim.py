"""Simulations: planning, a batch run end to end (scripted bot, fake
simulated user and judge), scoring, summaries, export and cleanup."""

from __future__ import annotations

import asyncio
import json

import pytest

from sbf import db
from sbf.llm import Completion
from sbf.memory import memory_store
from sbf.schemas import (AgentDef, Criterion, Expectation, MemorySchema, MemorySlot, MemoryTemplate, ModelSpec,
                         NodeDef, PersonaDef, RubricDef, ScenarioDef, SimRunConfig, SystemDef)
from sbf.sim import create_run, plan, results, runner, store
from sbf.sim.judge import score
from sbf.workspace import workspace

PERSONA_CALLS: list[list[dict]] = []


async def fake_persona(spec, messages, **kw):
    PERSONA_CALLS.append(messages)
    replies = sum(1 for m in messages if m["role"] == "user" and not m["content"].startswith("("))
    if replies >= 2:
        return Completion("ok thanks, that helps.\n[END]", cost=0.0001, usage={"total_tokens": 50})
    return Completion("how do i actually do that?", cost=0.0001, usage={"total_tokens": 40})


async def fake_judge(spec, messages, **kw):
    prompt = messages[-1]["content"]
    assert "THE USER'S SCENARIO" in prompt and "[ASSISTANT]" in prompt
    return Completion(json.dumps({
        "criteria": [{"key": "helpful", "score": 4, "justification": "Gave a technique."},
                     {"key": "concise", "score": 9, "justification": "Out of range, clamped."}],
        "expectations": [{"name": "Breathing", "level": 3, "evidence": "box breathing"},
                         {"name": "Sleep", "level": 0}],
        "comment": "Fine."}), cost=0.002)


@pytest.fixture
def sim_setup(scripted, monkeypatch):
    import sbf.sim.judge as judge_mod
    import sbf.sim.simulator as sim_mod
    monkeypatch.setattr(sim_mod, "complete", fake_persona)
    monkeypatch.setattr(judge_mod, "complete", fake_judge)
    PERSONA_CALLS.clear()
    scripted["simbot"] = ["Try box breathing: in 4, hold 4, out 4, hold 4."] * 40
    workspace.agents.save(AgentDef(id="simbot", prompt="Help.",
                                   model=ModelSpec(provider="litellm", model="script:simbot")))
    for sid in ("sim-a", "sim-b"):
        workspace.systems.save(SystemDef(id=sid, entry="bot", nodes=[NodeDef(id="bot", agent="simbot")]))
    workspace.personas.save(PersonaDef(id="jordan", name="Jordan", profile="A tired warehouse worker.",
                                       model=ModelSpec(provider="litellm", model="sim")))
    workspace.scenarios.save(ScenarioDef(
        id="cant-sleep", persona="jordan", opening="i can't sleep before my shifts",
        situation="Night shifts, wakes at 3am.", facts={"Tried": "Melatonin, didn't help."},
        goal="Something to try tonight.", max_turns=5, profile="Jordan (real)",
        expectations=[Expectation(name="Breathing", pattern=r"(?i)breath"),
                      Expectation(name="Sleep", description="Sleep hygiene", pattern=r"(?i)sleep hygiene")]))
    workspace.rubrics.save(RubricDef(id="basic", criteria=[
        Criterion(key="helpful", weight=2), Criterion(key="concise", weight=1)],
        model=ModelSpec(provider="litellm", model="judge")))
    schema = MemorySchema(id="tiny-sim", vocabularies={"moods": ["calm", "tense"]},
                          templates={"mood": MemoryTemplate(slots={"mood": MemorySlot(enum="moods", required=True)},
                                                            render="User seemed {{ label(mood) }}.")})
    memory_store.ensure()
    real = db.find_profile("Jordan (real)") or db.create_profile("Jordan (real)")
    memory_store.delete_profile_notes(real["id"])
    memory_store.add_notes("ns", schema, real["id"], None, [{"template": "mood", "slots": {"mood": "tense"}}])
    return real


def test_plan_problems(sim_setup):
    workspace.scenarios.save(ScenarioDef(id="no-persona", opening="hi"))
    convs, _defs, problems = plan(SimRunConfig(systems=["sim-a", "nope"], scenarios=["cant-sleep", "no-persona"]))
    assert "system 'nope' not found" in problems
    assert any("no-persona" in p and "no persona" in p for p in problems)
    convs, defs, problems = plan(SimRunConfig(systems=["sim-a", "sim-b"], scenarios=["cant-sleep"],
                                              repetitions=2, rubric="basic"))
    assert not problems and len(convs) == 4 and defs["rubric"]["id"] == "basic"
    # Systems interleave within a repetition.
    assert [c["system_id"] for c in convs[:2]] == ["sim-a", "sim-b"]


def test_batch_run(sim_setup):
    real = sim_setup

    async def go():
        run = create_run(SimRunConfig(name="t", systems=["sim-a", "sim-b"], scenarios=["cant-sleep"],
                                      repetitions=2, concurrency=2, rubric="basic"))
        await runner.tasks[run["id"]]
        return run["id"]

    run_id = asyncio.run(go())
    run = store.get_run(run_id)
    assert run["status"] == "completed" and set(run["systems"]) == {"sim-a", "sim-b"}
    convs = store.list_conversations(run_id)
    assert len(convs) == 4 and all(c["status"] == "completed" for c in convs), convs
    c = convs[0]
    # Exact opening (no model call), a follow-up, then a closing message with [END].
    assert c["turns"] == 3 and c["ended_by"] == "persona"
    assert c["metrics"]["simulator"]["calls"] == 2 and c["metrics"]["memory_copied"] == 1
    assert c["metrics"]["checks"] == {"Breathing": True, "Sleep": False}
    assert len(c["metrics"]["turn_seconds"]) == 3
    t = results.transcript(c["chat_id"])
    assert t[0] == {"role": "user", "content": "i can't sleep before my shifts", "turn": 1}
    assert t[1]["content"].startswith("Try box breathing")
    # The simulated user saw the assistant's replies with roles flipped.
    assert PERSONA_CALLS[0][1] == {"role": "assistant", "content": "i can't sleep before my shifts"}
    # Judged: helpful 4/5 (w2) → 0.75, concise clamped to 5 → 1.0 ⇒ (2*.75+1)/3 = 83.3
    j = results.latest_judgments(run_id)[c["id"]]
    assert j["score"] == 83.3 and j["expectation_score"] == 0.5

    summary = results.summary(run_id)
    a = next(s for s in summary["systems"] if s["system"] == "sim-a")
    assert a["score"]["n"] == 2 and a["score"]["mean"] == 83.3 and a["check_recall"]["mean"] == 0.5
    assert summary["by_scenario"]["sim-a"]["cant-sleep"]["n"] == 2

    rows = results.csv_text(run_id).strip().splitlines()
    assert len(rows) == 5 and "crit:helpful" in rows[0] and "check:Breathing" in rows[0]
    record = next(results.records(run_id))
    assert record["transcript"] and record["traces"] and record["scenario_def"]["id"] == "cant-sleep"

    # Simulated users stay out of the profile list; deleting the run removes them and the chats.
    sim_profiles = [p for p in db.list_profiles(origin="simulation") if p["name"].startswith(f"sim {run_id}")]
    assert len(sim_profiles) == 4
    assert all(not p["name"].startswith("sim ") for p in db.list_profiles())
    assert real["id"] in {p["id"] for p in db.list_profiles()}

    from fastapi.testclient import TestClient
    from sbf.app import app
    with TestClient(app) as client:
        detail = client.get(f"/api/simulations/{run_id}").json()
        assert detail["counts"] == {"completed": 4} and detail["conversations"][0]["score"] == 83.3
        assert client.get(f"/api/simulations/{run_id}/export?format=csv").status_code == 200
        lines = client.get(f"/api/simulations/{run_id}/export").text.strip().splitlines()
        assert len(lines) == 5 and json.loads(lines[0])["type"] == "run"
        conv = client.get(f"/api/simulations/conversations/{c['id']}").json()
        assert conv["persona"]["id"] == "jordan" and conv["judgments"][0]["score"] == 83.3
        prompts = client.post("/api/simulations/preview-prompts",
                              json={"persona": "jordan", "scenario": "cant-sleep", "rubric": "basic"}).json()
        assert "Melatonin" in prompts["simulator"] and "CRITERIA" in prompts["judge"]
        # The persona defaults to the scenario's own.
        prompts = client.post("/api/simulations/preview-prompts", json={"scenario": "cant-sleep"}).json()
        assert "A tired warehouse worker." in prompts["simulator"]
        listed = next(r for r in client.get("/api/simulations").json() if r["id"] == run_id)
        assert listed["judging"] is False and listed["mean_score"] == 83.3
        assert client.get(f"/api/simulations/{run_id}?rubric=other").json()["conversations"][0]["score"] is None
        assert client.delete("/api/personas/jordan").status_code == 409  # used by cant-sleep
        assert client.delete(f"/api/simulations/{run_id}").json() == {"ok": True}
    assert store.get_run(run_id) is None
    assert db.get_chat(c["chat_id"]) is None
    assert not [p for p in db.list_profiles(origin="simulation") if p["name"].startswith(f"sim {run_id}")]


def test_score_normalization():
    rubric = RubricDef(id="r", criteria=[Criterion(key="a", min=0, max=10), Criterion(key="b", weight=0)],
                       grade_expectations=True)
    scenario = ScenarioDef(id="s", expectations=[Expectation(name="X"), Expectation(name="Y")])
    result, value, exp = score(rubric, scenario, {
        "criteria": [{"key": "a", "score": "7"}, {"key": "b", "score": 1}],
        "expectations": [{"name": "x", "level": 5}, {"name": "Y", "level": "bad"}]})
    assert value == 70.0 and exp == 0.5
    assert [e["level"] for e in result["expectations"]] == [3, 0]
