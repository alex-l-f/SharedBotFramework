"""Engine behaviour on a scripted model: delegation, observers, recovery, validation."""

from __future__ import annotations

import asyncio

import pytest

from sbf import db
from sbf.runtime import CompileError, compile_system
from sbf.runtime.engine import FALLBACK_REPLY, Engine
from sbf.schemas import (AgentDef, LinkDef, MemoryConfig, MemorySchema, MemorySlot, MemoryTemplate,
                         ModeDef, ModelSpec, NodeDef, SystemDef, ToolBinding)
from sbf.workspace import workspace


def script_model(key: str) -> ModelSpec:
    return ModelSpec(provider="litellm", model=f"script:{key}")


@pytest.fixture
def system():
    workspace.agents.save(AgentDef(
        id="front", prompt="You are the front desk. Mode: {{ mode.label }}.",
        tools=[ToolBinding(tool="send_message"), ToolBinding(tool="finish_turn"),
               ToolBinding(tool="switch_mode")],
        model=script_model("front")))
    workspace.agents.save(AgentDef(
        id="helper", prompt="You answer questions.",
        tools=[ToolBinding(tool="return_result")], model=script_model("helper")))
    workspace.agents.save(AgentDef(
        id="watcher", prompt="You keep notes.",
        tools=[ToolBinding(tool="record_memories")], model=script_model("watcher")))
    workspace.memory_schemas.save(MemorySchema(
        id="tiny", vocabularies={"moods": ["calm", "tense"]},
        templates={"mood": MemoryTemplate(description="User mood.",
                                          slots={"mood": MemorySlot(enum="moods", required=True)},
                                          render="User seemed {{ label(mood) }}.")}))
    system = SystemDef(
        id="test-sys", entry="front",
        nodes=[NodeDef(id="front", agent="front",
                       modes=[ModeDef(id="a", label="Alpha", state={"library": "lib_a"}),
                              ModeDef(id="b", label="Beta")],
                       initial_mode="a", inject_memory=True),
               NodeDef(id="helper", agent="helper"),
               NodeDef(id="watcher", agent="watcher")],
        links=[LinkDef(id="d1", type="delegate", source="front", target="helper",
                       tool_name="ask_helper", require_state=["library"],
                       request_template="Q: {{ args.question }} (lib {{ state.library }})"),
               LinkDef(id="o1", type="observe", source="front", target="watcher",
                       request_template="{{ turn.surface | join('\n') }}")],
        memory=MemoryConfig(enabled=True, schema_id="tiny"))
    workspace.systems.save(system)
    return system


def run(coro):
    return asyncio.run(coro)


def test_compile_and_prompt(system):
    compiled = compile_system("test-sys")
    assert compiled.entry.user_facing and not compiled.nodes["helper"].user_facing
    assert [l.tool_name for l in compiled.nodes["front"].delegates] == ["ask_helper"]
    from sbf.runtime.builder import initial_state
    from sbf.runtime.prompts import render_instruction
    state = initial_state(compiled)
    assert state["library"] == "lib_a" and state["modes"] == {"front": "a"}
    text = render_instruction(compiled, compiled.entry, state, user_facing=True)
    assert text.startswith("You are the front desk. Mode: Alpha.")
    assert "REPLYING" in text  # text-reply note for user-facing text agents


def test_compile_problems(system):
    bad = system.model_copy(update={"links": system.links + [
        LinkDef(id="h1", type="handoff", source="helper", target="front")]})
    with pytest.raises(CompileError) as exc:
        compile_system(bad)
    assert any("entry node can't be a handoff target" in p for p in exc.value.problems)


def test_turn_with_delegate_and_observer(system, scripted, requests_seen):
    profile = db.create_profile("Tester")
    scripted["front"] = [("tool", "ask_helper", {"question": "what is 6x7?"}),
                         "The answer is 42."]
    scripted["helper"] = [("tool", "return_result", {"result": "42"})]
    scripted["watcher"] = [("tool", "record_memories", {"memories": [{"template": "mood", "mood": "calm"}]})]

    async def go():
        engine = Engine()
        chat = await engine.create_chat("test-sys", profile["id"])
        return await engine.run_turn(chat["id"], "hello"), chat

    turn, chat = run(go())
    outputs = db.list_outputs(chat["id"])
    assert [o["type"] for o in outputs] == ["user", "message"]
    assert outputs[1]["content"] == "The answer is 42."
    # The helper got the rendered request, the front got the helper's result back.
    helper_req = requests_seen["helper"][0].contents[-1].parts[0].text
    assert helper_req == "Q: what is 6x7? (lib lib_a)"
    tool_response = requests_seen["front"][1].contents[-1].parts[0].function_response.response
    assert tool_response["result"] == "42"
    # Observer wrote a note through record_memories.
    from sbf.memory import memory_store
    notes = memory_store.list_notes("test-sys", profile["id"])["memories"]
    assert [n["rendered"] for n in notes] == ["User seemed calm."]
    events = [(t["agent"], t["event"]) for t in db.list_traces(chat["id"])]
    assert ("helper", "spawn") in events and ("watcher", "result") in events


def test_delegate_requires_state(system, scripted, requests_seen):
    scripted["front"] = [("tool", "switch_mode", {"target_mode": "b"}),
                         ("tool", "ask_helper", {"question": "x"}),
                         "Done."]

    async def go():
        engine = Engine()
        chat = await engine.create_chat("test-sys")
        await engine.run_turn(chat["id"], "hi")
        return chat

    chat = run(go())
    results = [t["data"]["result"] for t in db.list_traces(chat["id"])
               if t["event"] == "tool_result" and t["data"]["name"] == "ask_helper"]
    assert results and "unavailable until library is set" in str(results[0])
    assert "helper" not in requests_seen  # never spawned
    assert [o["type"] for o in db.list_outputs(chat["id"])] == ["user", "mode", "message"]


def test_fallback_reply_when_model_stays_silent(system, scripted):
    scripted["front"] = []  # every call returns empty text

    async def go():
        engine = Engine()
        chat = await engine.create_chat("test-sys")
        await engine.run_turn(chat["id"], "hello?")
        return chat

    chat = run(go())
    outputs = db.list_outputs(chat["id"])
    assert outputs[-1]["type"] == "message" and outputs[-1]["content"] == FALLBACK_REPLY
    events = [t["event"] for t in db.list_traces(chat["id"])]
    assert events.count("reply_recovery") == 2 and "reply_fallback" in events


def test_repeat_guard_and_budget(system, scripted):
    agent = workspace.agents.get("front")
    workspace.agents.save(agent.model_copy(update={"reply_mode": "tool", "tools": [
        ToolBinding(tool="send_message", budget=2), ToolBinding(tool="finish_turn")]}))
    scripted["front"] = [("tool", "send_message", {"message": "Hello there!"}),
                         ("tool", "send_message", {"message": "Hello there!"}),
                         ("tool", "send_message", {"message": "Third"}),
                         ("tool", "finish_turn", {})]

    async def go():
        engine = Engine()
        chat = await engine.create_chat("test-sys")
        await engine.run_turn(chat["id"], "hi")
        return chat

    chat = run(go())
    results = [str(t["data"]["result"]) for t in db.list_traces(chat["id"])
               if t["event"] == "tool_result" and t["data"]["name"] == "send_message"]
    assert results[1].startswith("SUPPRESSED") and "budget" in results[2]
    assert [o["content"] for o in db.list_outputs(chat["id"]) if o["type"] == "message"] == ["Hello there!"]
