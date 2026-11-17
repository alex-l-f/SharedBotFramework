"""
Port the BotBase R2MR coaching bot into the workspace.

Reads BotBase's own prompt modules and memory registry (so nothing is
retyped by hand) and writes:

    agents/          coach, library_summarizer, memory_keeper, topic_librarian
    fragments/       r2mr_coach_role, r2mr_tone, r2mr_router_overlay
    memory_schemas/  r2mr
    systems/         r2mr-coach (BotBase "multi"), r2mr-single (BotBase "single")
    settings.yaml    model presets + knowledge/SCORM paths (only if missing)

Then checks fidelity: for every mode, the instruction this framework renders
must equal the prompt BotBase builds (get_prompt + its text-reply note).

    python scripts/import_botbase.py [--botbase E:/Experiments/BotBase] [--force-settings]
"""

from __future__ import annotations

import argparse
import importlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from sbf.schemas import (AgentDef, LinkDef, MemorySchema, MemorySlot, MemoryTemplate, ModeDef,  # noqa: E402
                         ModelSpec, NodeDef, SystemDef, ToolBinding, UIConfig, MemoryConfig)
from sbf.settings import KnowledgeSettings, Settings, SETTINGS_FILE, StaticMount  # noqa: E402

# BotBase's memory renderer as Jinja (render_memory in memory_templates.py).
RENDER = {
    "topic_discussed": "Discussed {{ label(theme) }}{% if topic %} (topic area: {{ label(topic) }}){% endif %}.",
    "skill_introduced": "Introduced the skill: {{ label(skill) }}{% if reason %} (context: {{ label(reason) }}){% endif %}.",
    "skill_practiced": "User practised {{ label(skill) }} during the session — it {{ label(outcome) }}.",
    "practice_commitment": "User agreed to practise {{ label(skill) }} on their own{% if timeframe %} ({{ label(timeframe) }}){% endif %}. Follow up on how it went.",
    "resource_shared": "Shared the resource {{ resource_name() }}{% if purpose %} for {{ label(purpose) }}{% endif %}. Worth asking whether they got to it.",
    "assessment_result": "User completed the {{ label(assessment) }}{% if band and band != 'not_scored' %} — result band: {{ label(band) }}{% endif %}.",
    "upcoming_event": "User is preparing for a {{ label(event_type) }}{% if timeframe %} ({{ label(timeframe) }}){% endif %}{% if concern and concern != 'none_stated' %}; main concern: {{ label(concern) }}{% endif %}. Ask how preparation (or the event itself) went.",
    "event_outcome": "The {{ label(event_type) }} the user was preparing for {{ label(result) }}.",
    "stress_reported": "User reported {{ label(level or 'ongoing') }} stress related to {{ label(area) }}.",
    "distress_supported": "User showed signs of distress ({{ label(indicator) }}); support given: {{ label(action) }}. Check in gently.",
    "preference_noted": "Coaching preference: {{ label(preference) }}.",
    "goal_set": "User set a goal: {{ label(goal_area) }}{% if timeframe %} ({{ label(timeframe) }}){% endif %}. Ask about progress.",
}

VOCAB_NAMES = ["TOPIC_KEYS", "THEMES", "SKILLS", "SKILL_REASONS", "PRACTICE_OUTCOMES", "ASSESSMENTS",
               "BANDS", "STRESSOR_AREAS", "LEVELS", "EVENT_TYPES", "TIMEFRAMES", "CONCERNS",
               "EVENT_OUTCOMES", "DISTRESS_INDICATORS", "SUPPORT_ACTIONS", "PREFERENCES",
               "GOAL_AREAS", "RESOURCE_PURPOSES"]

COACH_TEMPLATE = (
    "{% if mode.id != 'router' %}{{ fragments.r2mr_coach_role }}{% endif %}"
    "{{ mode.prompt }}{{ fragments.r2mr_tone }}"
    "{% if mode.id == 'router' %}{{ fragments.r2mr_router_overlay }}{% else %}{{ agent_prompt }}{% endif %}")

SUMMARIZER_REQUEST = (
    "COACH QUESTION:\n{{ args.question }}"
    "{% if turn.user_message %}\n\nUSER'S CURRENT MESSAGE (verbatim):\n{{ turn.user_message }}{% endif %}"
    "\n\nACTIVE TOPIC LIBRARY: {{ state.library }}")

MEMORY_REQUEST = (
    "TURN TRANSCRIPT (conversational surface only):\n"
    "{{ turn.surface | join('\\n') if turn.surface else '(empty turn)' }}\n\n"
    "{% if memory.notes %}EXISTING NOTES for this user (do NOT duplicate):"
    "{% for n in memory.notes %}\n- [{{ (n.ts or '')[:10] }}] {{ n.rendered }}{% endfor %}"
    "{% else %}EXISTING NOTES for this user: none yet.{% endif %}\n\n"
    "{% if turn.resources %}RESOURCES FROM THIS TURN (only these ids may be cited, and only if "
    "actually delivered to the user):"
    "{% for r in turn.resources %}\n- {{ r.id }} — '{{ r.title }}' ({{ r.source_type }}){% endfor %}"
    "{% else %}RESOURCES FROM THIS TURN: none.{% endif %}")

WELCOME = (
    "I help with stress, recovery, performance under pressure, and the mental skills behind them — "
    "all drawn from the Canadian Armed Forces' R2MR program. I can explain concepts, walk you "
    "through techniques, send you guided practices and one-page reference cards, and run quick "
    "self-assessments.\n\n"
    "- **Stress** — understand what's happening in your body, take the PSS, identify your coping style.\n"
    "- **Mental skills** — practise breathing, mindfulness, PMR, visualization, self-talk, goal-setting.\n"
    "- **Recovery** — recharge after demanding periods, take the OLBI burnout assessment.\n"
    "- **Performance** — prepare for high-stakes events, mindset and confidence work.\n"
    "- **R2MR / sleep** — programme overview and military shift-work / fatigue guidance.")

STARTERS = [
    "I'm stressed and want to understand what's happening to me.",
    "Walk me through a quick breathing or relaxation exercise.",
    "I have a big event coming up and want to be ready.",
    "I'm feeling burned out and can't seem to recharge.",
    "I'd like to take a self-assessment.",
    "Tell me about R2MR.",
]


def load_botbase(path: Path):
    sys.path.insert(0, str(path))
    prompts = importlib.import_module("prompts")
    return {
        "prompts": prompts,
        "topics": importlib.import_module("prompts.topics"),
        "overlay": importlib.import_module("prompts.coach_overlay"),
        "tone": importlib.import_module("prompts.tone"),
        "summarizer": importlib.import_module("prompts.summarizer"),
        "memory_agent": importlib.import_module("prompts.memory_agent"),
        "mt": importlib.import_module("memory_templates"),
        "ask_library": importlib.import_module("tools.ask_library"),
    }


def memory_schema(mt, topics) -> MemorySchema:
    vocabularies = {name.lower(): list(getattr(mt, name)) for name in VOCAB_NAMES}
    by_identity = {id(getattr(mt, name)): name.lower() for name in VOCAB_NAMES}
    labels = dict(mt._LABELS)
    for key, topic in topics.TOPICS.items():
        labels.setdefault(key, topic["label"])
    templates = {}
    for key, spec in mt.TEMPLATES.items():
        slots = {}
        for name, rule in spec["slots"].items():
            if rule.get("ref") == "resource":
                slots[name] = MemorySlot(ref="resource", required=bool(rule.get("required")))
            else:
                vocab = by_identity.get(id(rule["enum"]))
                slots[name] = MemorySlot(enum=vocab or list(rule["enum"]), required=bool(rule.get("required")))
        templates[key] = MemoryTemplate(description=spec["description"], slots=slots,
                                        follow_up=spec["follow_up"], render=RENDER[key])
    return MemorySchema(id="r2mr", name="R2MR coaching memory",
                        description="Privacy-preserving coaching notes (stress/coping, task performance, "
                                    "distress, continuity). Ported from BotBase memory_templates.py.",
                        vocabularies=vocabularies, labels=labels, templates=templates)


def check_memory_render(schema: MemorySchema, mt) -> int:
    """Render every template with every value of its first slot and compare."""
    from sbf.memory.templates import render_note
    checked = 0
    for key, tpl in schema.templates.items():
        names = list(tpl.slots)
        base = {}
        for name in names:
            rule = tpl.slots[name]
            if rule.ref == "resource":
                base.update(resource=3, provider="coping_stress", title="Stress Fact Sheet")
            else:
                base[name] = schema.slot_values(rule)[0]
        variants = [base, {k: v for k, v in base.items()
                           if k in ("resource", "provider", "title") or tpl.slots.get(k, MemorySlot()).required}]
        for slots in variants:
            ours = render_note(schema, key, slots)
            theirs = mt.render_memory(key, slots)
            assert ours == theirs, f"{key}: {ours!r} != {theirs!r}"
            checked += 1
    return checked


def build(bb, ws, args):
    topics_mod, overlay = bb["topics"], bb["overlay"]
    TOPICS, ROUTER = topics_mod.TOPICS, topics_mod.ROUTER_MODE

    # Fragments shared by both R2MR systems.
    ws.fragments.save("r2mr_coach_role", overlay.COACH_ROLE)
    ws.fragments.save("r2mr_tone", bb["tone"].TONE)
    ws.fragments.save("r2mr_router_overlay", overlay._ROUTER_OVERLAY)

    ask_schema = bb["ask_library"].AskLibrary.schema["function"]

    delegated = {"research_tool": "ask_library"}
    agents = [
        AgentDef(
            id="coach", name="Coach", tags=["core", "coaching", "orchestrator"],
            description="User-facing coach and orchestrator: owns the conversation and every "
                        "user-facing action, delegates research and recalls past sessions.",
            prompt=overlay._COACH_OVERLAY,
            tools=[ToolBinding(tool="send_message"),
                   ToolBinding(tool="memory_search"),
                   ToolBinding(tool="switch_mode"),
                   ToolBinding(tool="provide_file", config=delegated),
                   ToolBinding(tool="open_course_page", config=delegated),
                   ToolBinding(tool="finish_turn")],
            max_llm_calls=20, reply_mode="text",
            notes="Ported from BotBase (multi architecture). The prompt is BotBase's coach "
                  "overlay; the R2MR role, topic prompts and tone come from the system."),
        AgentDef(
            id="library_summarizer", name="Library summarizer", tags=["core", "research"],
            description="Read-only research agent: searches a resource library, reads what it "
                        "needs, returns a structured summary with cited resource ids.",
            prompt=bb["summarizer"].PROMPT,
            tools=[ToolBinding(tool="search_resources", budget=6),
                   ToolBinding(tool="examine_resource", budget=5, result_cap=12000),
                   ToolBinding(tool="return_summary")],
            model=ModelSpec(preset="helper"), max_llm_calls=12,
            notes="Ported from BotBase. Budgets: 6 searches, 5 examines (12000 chars each)."),
        AgentDef(
            id="memory_keeper", name="Memory keeper", tags=["core", "memory"],
            description="Archivist: after each turn, records what is worth remembering as "
                        "anonymous template notes (never free text).",
            prompt=bb["memory_agent"].PROMPT,
            tools=[ToolBinding(tool="record_memories")],
            model=ModelSpec(preset="helper"), max_llm_calls=3,
            notes="Ported from BotBase. Its only tool is the record_memories output contract."),
        AgentDef(
            id="topic_librarian", name="Topic librarian (single agent)", tags=["baseline"],
            description="BotBase's single-agent baseline: one agent that searches, reads and "
                        "delivers resources itself. Its prompt comes entirely from the system's modes.",
            prompt="",
            tools=[ToolBinding(tool=t) for t in ("send_message", "search_resources", "examine_resource",
                                                  "switch_mode", "provide_file", "open_course_page")],
            max_llm_calls=20, reply_mode="text"),
    ]
    for agent in agents:
        ws.agents.save(agent)

    schema = memory_schema(bb["mt"], topics_mod)
    ws.memory_schemas.save(schema)
    n = check_memory_render(schema, bb["mt"])
    print(f"memory schema r2mr: {len(schema.templates)} templates, {n} renders match BotBase")

    def modes(multi: bool) -> list[ModeDef]:
        out = []
        for key, topic in TOPICS.items():
            prompt = importlib.import_module(f"prompts.{topic['prompt_module']}").PROMPT
            if multi:
                prompt = overlay.adapt_for_coach(prompt)
            out.append(ModeDef(id=key, label=topic["label"], description=topic["short_description"],
                               prompt=prompt, state={"library": topic["provider"]}))
        return out

    multi = SystemDef(
        id="r2mr-coach", name="R2MR Coach",
        description="BotBase's multi-agent R2MR coaching system: a user-facing coach with topic "
                    "modes, a library summarizer behind ask_library, and a memory keeper that "
                    "records anonymous template notes after every turn.",
        tags=["r2mr", "coaching", "botbase"],
        entry="coach",
        nodes=[
            NodeDef(id="coach", agent="coach", label="Coach", prompt_template=COACH_TEMPLATE,
                    modes=modes(True), initial_mode=ROUTER, inject_memory=True,
                    position={"x": 80, "y": 160}),
            NodeDef(id="summarizer", agent="library_summarizer", label="Library summarizer",
                    position={"x": 460, "y": 60}),
            NodeDef(id="memory", agent="memory_keeper", label="Memory keeper",
                    position={"x": 460, "y": 300}),
        ],
        links=[
            LinkDef(id="ask_library", type="delegate", source="coach", target="summarizer",
                    tool_name="ask_library", tool_description=ask_schema["description"],
                    parameters=ask_schema["parameters"], require_state=["library"],
                    require_state_error="ERROR: No topic library is active. Use switch_mode to "
                                        "select a topic before asking the library.",
                    request_template=SUMMARIZER_REQUEST, max_llm_calls=12,
                    nudge="Reminder: nothing you write as text reaches the coach. Finish now by "
                          "calling return_summary with your findings so far."),
            LinkDef(id="memory_extraction", type="observe", source="coach", target="memory",
                    request_template=MEMORY_REQUEST, max_llm_calls=3, requires_profile=True,
                    nudge="Reminder: nothing you write as text is kept. Finish now by calling "
                          "record_memories — with an empty list if nothing is worth recording."),
        ],
        memory=MemoryConfig(enabled=True, schema_id="r2mr", namespace="r2mr"),
        ui=UIConfig(title="R2MR Coach", welcome=WELCOME, starters=STARTERS, require_profile=True),
    )
    single = SystemDef(
        id="r2mr-single", name="R2MR Librarian (single agent)",
        description="BotBase's single-agent baseline: one topic-aware agent with direct library "
                    "access. No memory. The comparison target for r2mr-coach.",
        tags=["r2mr", "baseline", "botbase"],
        entry="bot",
        nodes=[NodeDef(id="bot", agent="topic_librarian", label="Librarian",
                       prompt_template="{{ mode.prompt }}{{ fragments.r2mr_tone }}",
                       modes=modes(False), initial_mode=ROUTER, position={"x": 80, "y": 160})],
        ui=UIConfig(title="R2MR Librarian", welcome=WELCOME, starters=STARTERS),
    )
    ws.systems.save(multi)
    ws.systems.save(single)

    if args.force_settings or not SETTINGS_FILE.exists():
        bb_root = args.botbase.resolve()
        settings = Settings(
            default_model="default",
            models={
                "default": ModelSpec(provider="openrouter", model="qwen/qwen3.8-flash",
                                     reasoning_effort="medium", temperature=1.0, top_p=0.95,
                                     top_k=20, max_output_tokens=16384),
                "helper": ModelSpec(preset="default", reasoning_effort="low"),
            },
            knowledge=KnowledgeSettings(
                url="http://localhost:8201",
                processed_root=str(bb_root / "processed_resources"),
                file_root=str(bb_root / "data"),
                libraries={k: {"label": t["label"], "description": t["short_description"]}
                           for k, t in TOPICS.items() if t["provider"]}),
            scorm_root=str(bb_root),
        )
        from sbf.settings import save_settings
        save_settings(settings)
        print(f"wrote {SETTINGS_FILE}")
    return TOPICS, ROUTER


def check_fidelity(bb, TOPICS):
    """Our rendered instruction for each mode == BotBase's coach prompt."""
    from sbf.runtime.builder import compile_system, initial_state
    from sbf.runtime.prompts import REPLY_NOTE, render_instruction

    get_prompt = bb["prompts"].get_prompt
    for system_id, node_id, arch in (("r2mr-coach", "coach", "multi"), ("r2mr-single", "bot", "single")):
        compiled = compile_system(system_id)
        cnode = compiled.nodes[node_id]
        for mode in TOPICS:
            state = {**initial_state(compiled), "modes": {node_id: mode}}
            ours = render_instruction(compiled, cnode, state, user_facing=True)
            theirs = get_prompt(mode, arch) + REPLY_NOTE
            if ours != theirs:
                import difflib
                diff = "\n".join(list(difflib.unified_diff(theirs.splitlines(), ours.splitlines(),
                                                           "botbase", "sbf", lineterm=""))[:40])
                raise SystemExit(f"{system_id}/{mode}: prompt differs from BotBase\n{diff}")
        print(f"{system_id}: all {len(TOPICS)} mode prompts identical to BotBase ({arch})")
        if compiled.warnings:
            print("  warnings:", *compiled.warnings, sep="\n   - ")


def import_memory(botbase: Path, schema_id: str = "r2mr", namespace: str = "r2mr") -> None:
    """Copy BotBase's user profiles and their template notes (memory.db).
    A profile that already exists here keeps its own notes."""
    import json
    import sqlite3

    from sbf import db
    from sbf.memory import memory_store
    from sbf.workspace import workspace

    src = botbase / "memory.db"
    if not src.exists():
        return
    schema = workspace.memory_schemas.get(schema_id)
    memory_store.ensure()
    existing = {p["name"] for p in db.list_profiles()}
    conn = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    for prof in conn.execute("SELECT * FROM user_profiles").fetchall():
        if prof["name"] in existing:
            print(f"profile {prof['name']!r} already exists; skipped")
            continue
        new = db.create_profile(prof["name"])
        rows = conn.execute("SELECT * FROM memories WHERE profile_id = ? ORDER BY ts, id",
                            (prof["id"],)).fetchall()
        records = [{"template": r["template"], "slots": json.loads(r["slots"]), "ts": r["ts"],
                    "chat_id": r["chat_id"]} for r in rows]
        memory_store.replace_notes(namespace, schema, new["id"], records)
        print(f"profile {prof['name']!r}: {len(records)} notes imported")
    conn.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--botbase", type=Path, default=Path("E:/Experiments/BotBase"))
    parser.add_argument("--force-settings", action="store_true",
                        help="Overwrite workspace/settings.yaml")
    parser.add_argument("--no-memory", action="store_true",
                        help="Don't copy BotBase's profiles and memory notes")
    args = parser.parse_args()
    bb = load_botbase(args.botbase)
    from sbf.workspace import workspace
    TOPICS, _ = build(bb, workspace, args)
    check_fidelity(bb, TOPICS)
    if not args.no_memory:
        import_memory(args.botbase)


if __name__ == "__main__":
    main()
