"""
The setup wizard: a few plain answers become ordinary definitions — new
agents (or existing ones), an optional new classifier, and a system wiring
them together — which the main editors can refine afterwards.

``draft(answers)`` builds the definitions and checks them (nothing is
written); ``create(answers)`` writes them, all or nothing.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field

from .runtime.builder import CompileError, compile_system
from .schemas import (SLUG_PATTERN, AgentDef, ClassifierDef, ContextDef, GuardDef, GuardRule, LinkDef,
                      MemoryConfig, ModelSpec, NodeDef, SystemDef, ToolBinding, UIConfig)
from .workspace import workspace

CRISIS_CATEGORIES = ["self-harm", "suicide", "self harm"]


class NewAgent(BaseModel):
    name: str = ""
    role: str = Field("", description="One line: what this agent is, e.g. 'a friendly study coach'")
    instructions: str = Field("", description="How it should behave, in plain words")
    model_preset: str = Field("", description="A model preset from the settings (empty = the default)")


class AgentChoice(BaseModel):
    existing: str = Field("", description="Use this saved agent instead of creating one")
    new: NewAgent = Field(default_factory=NewAgent)


class Helper(AgentChoice):
    kind: Literal["researcher", "specialist", "memory", "delegate"]
    retriever: str = Field("", description="researcher: what it searches")


class Knowledge(BaseModel):
    retriever: str = ""
    mode: Literal["none", "context", "tool"] = Field(
        "none", description="context: material is added to the prompt every turn; tool: the agent searches")


class Safety(BaseModel):
    classifier: str = Field("", description="A saved classifier")
    new_classifier: ClassifierDef | None = None
    input_policy: Literal["none", "block", "inform", "flag"] = "inform"
    output_policy: Literal["none", "regenerate", "flag"] = "regenerate"
    crisis_message: str = Field("", description="Shown to the user when a message is about self-harm")
    block_message: str = ""
    safe_reply: str = Field("", description="Replaces a reply that is still flagged after retries")


class WizardAnswers(BaseModel):
    id: str = Field(pattern=SLUG_PATTERN)
    name: str = ""
    description: str = ""
    main: AgentChoice = Field(default_factory=AgentChoice)
    helpers: list[Helper] = Field(default_factory=list)
    knowledge: Knowledge = Field(default_factory=Knowledge)
    memory: MemoryConfig = Field(default_factory=MemoryConfig)
    safety: Safety = Field(default_factory=Safety)
    ui: UIConfig = Field(default_factory=UIConfig)


class Draft(BaseModel):
    system: SystemDef
    agents: list[AgentDef] = Field(default_factory=list, description="New agents")
    classifiers: list[ClassifierDef] = Field(default_factory=list, description="New classifiers")
    problems: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "agent"


def _ident(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:30] or "node"


class _Ids:
    """New ids that collide with nothing saved and nothing in this draft."""

    def __init__(self):
        self.taken = set(workspace.agents.ids())

    def agent(self, name: str, system_id: str) -> str:
        """The agent's name as its id; prefixed with the system's id if taken."""
        base = _slug(name)
        if base in self.taken:
            base = _slug(f"{system_id}-{name}") if not base.startswith(system_id) else base
        candidate, n = base, 2
        while candidate in self.taken:
            candidate, n = f"{base}-{n}", n + 1
        self.taken.add(candidate)
        return candidate


def _model(preset: str) -> ModelSpec:
    return ModelSpec(preset=preset) if preset else ModelSpec()


MAIN_PROMPT = """You are {name}{role}.

{instructions}

Keep replies clear and conversational. Ask a short question when you need more information before helping."""

RESEARCHER_PROMPT = """You are {name}{role}, a research helper. You never talk to the user: another agent sends you a question.

{instructions}

Search with rag_search (try a few phrasings if the first results are thin), then finish with return_summary: a direct answer, the key points, and the ids of the items you used. Say plainly when the material doesn't cover the question."""

SPECIALIST_PROMPT = """You are {name}{role}. The conversation has been handed to you because it is in your area.

{instructions}

When the user's needs move outside your area, say so and suggest they start a new conversation."""

MEMORY_PROMPT = """You are a memory keeper. After each turn you read what was said and record what is worth remembering for next time, as notes from the memory templates (never free text, never names or identifying details). Record nothing when nothing new and useful was said. Finish with record_memories."""


def _new_agent(ids: _Ids, choice: AgentChoice, *, fallback_name: str, prompt: str, tools: list[ToolBinding],
               system_id: str) -> AgentDef:
    new = choice.new
    name = new.name.strip() or fallback_name
    role = f", {new.role.strip()}" if new.role.strip() else ""
    text = prompt.format(name=name, role=role, instructions=new.instructions.strip() or "").replace("\n\n\n", "\n\n")
    return AgentDef(id=ids.agent(name, system_id), name=name, description=new.role.strip() or name,
                    tags=["wizard"], prompt=text.strip(), tools=tools, model=_model(new.model_preset),
                    notes=f"Created by the setup wizard for system {system_id!r}.")


def build(answers: WizardAnswers) -> Draft:
    """The definitions the answers describe (not checked or saved)."""
    ids = _Ids()
    sid = answers.id
    agents: list[AgentDef] = []
    nodes: list[NodeDef] = []
    links: list[LinkDef] = []

    knowledge = answers.knowledge if answers.knowledge.retriever else Knowledge()
    main_tools = []
    if knowledge.mode == "tool":
        main_tools.append(ToolBinding(tool="rag_search", config={"retriever": knowledge.retriever}))
    if answers.main.existing:
        main_agent_id = answers.main.existing
    else:
        agent = _new_agent(ids, answers.main, fallback_name=answers.name or "Assistant", prompt=MAIN_PROMPT,
                           tools=main_tools, system_id=sid)
        agents.append(agent)
        main_agent_id = agent.id
    main = NodeDef(id="main", agent=main_agent_id, label=answers.main.new.name or "", position={"x": 80, "y": 200},
                   inject_memory=answers.memory.enabled,
                   context=[ContextDef(name="knowledge", retriever=knowledge.retriever, label="Relevant material")]
                   if knowledge.mode == "context" else [],
                   tools=main_tools if answers.main.existing else [])
    nodes.append(main)

    node_ids = {"main"}
    for i, helper in enumerate(answers.helpers):
        label = helper.new.name or {"researcher": "Researcher", "specialist": "Specialist", "memory": "Memory keeper",
                                    "delegate": "Helper"}[helper.kind]
        if helper.existing:
            agent_id = helper.existing
        else:
            if helper.kind == "researcher":
                tools = [ToolBinding(tool="rag_search", config={"retriever": helper.retriever or knowledge.retriever}),
                         ToolBinding(tool="return_summary")]
                prompt = RESEARCHER_PROMPT
            elif helper.kind == "memory":
                tools, prompt = [ToolBinding(tool="record_memories")], MEMORY_PROMPT
            elif helper.kind == "specialist":
                tools, prompt = [], SPECIALIST_PROMPT
            else:
                tools = [ToolBinding(tool="return_result")]
                prompt = "You are {name}{role}. You receive a task from another agent.\n\n{instructions}\n\nFinish with return_result."
            agent = _new_agent(ids, helper, fallback_name=label, prompt=prompt, tools=tools, system_id=sid)
            agents.append(agent)
            agent_id = agent.id
        nid = base = _ident(label)
        n = 2
        while nid in node_ids:
            nid, n = f"{base}_{n}", n + 1
        node_ids.add(nid)
        nodes.append(NodeDef(id=nid, agent=agent_id, label=label, position={"x": 460, "y": 60 + i * 170}))
        if helper.kind in ("researcher", "delegate"):
            links.append(LinkDef(id=f"main_to_{nid}", type="delegate", source="main", target=nid,
                                 tool_name=f"ask_{nid}"[:60],
                                 tool_description=helper.new.role or f"Ask the {label} agent"))
        elif helper.kind == "specialist":
            links.append(LinkDef(id=f"main_to_{nid}", type="handoff", source="main", target=nid))
        else:
            links.append(LinkDef(id=f"main_to_{nid}", type="observe", source="main", target=nid))

    classifiers: list[ClassifierDef] = []
    guards: list[GuardDef] = []
    s = answers.safety
    classifier_id = s.classifier
    if s.new_classifier is not None:
        classifiers.append(s.new_classifier)
        classifier_id = s.new_classifier.id
    if classifier_id:
        if s.input_policy != "none" or s.crisis_message:
            rules = []
            if s.crisis_message:
                rules.append(GuardRule(categories=CRISIS_CATEGORIES, action="add_message", message=s.crisis_message))
            if s.input_policy != "none":
                rules.append(GuardRule(action=s.input_policy, message=s.block_message))
            else:
                rules.append(GuardRule(action="flag"))
            guards.append(GuardDef(id="input_check", classifier=classifier_id, node="main", check="input",
                                   rules=rules, position={"x": -260, "y": 120}))
        if s.output_policy != "none":
            guards.append(GuardDef(id="reply_check", classifier=classifier_id, node="main", check="output",
                                   scope="exchange", rules=[GuardRule(action=s.output_policy, message=s.safe_reply)],
                                   position={"x": -260, "y": 300}))

    ui = answers.ui.model_copy(update={"title": answers.ui.title or answers.name})
    system = SystemDef(id=sid, name=answers.name, description=answers.description, tags=["wizard"], entry="main",
                       nodes=nodes, links=links, memory=answers.memory, ui=ui, guards=guards,
                       notes="Created by the setup wizard; refine it here.")
    return Draft(system=system, agents=agents, classifiers=classifiers)


def draft(answers: WizardAnswers) -> Draft:
    """Build and check: problems (it can't be created as is) and warnings."""
    d = build(answers)
    if workspace.systems.exists(d.system.id):
        d.problems.append(f"a system with the id {d.system.id!r} already exists")
    for c in d.classifiers:
        if workspace.classifiers.exists(c.id):
            d.problems.append(f"a classifier with the id {c.id!r} already exists")
    try:
        compiled = compile_system(d.system, pending={"agents": {a.id: a for a in d.agents},
                                                     "classifiers": {c.id: c for c in d.classifiers}})
        d.warnings = compiled.warnings
    except CompileError as exc:
        d.problems += exc.problems
    return d


def create(answers: WizardAnswers) -> Draft:
    """Write the drafted definitions — classifiers, agents, then the system;
    if any write fails, the ones already written are removed."""
    d = draft(answers)
    if d.problems:
        raise ValueError("; ".join(d.problems))
    written: list[tuple] = []
    try:
        for c in d.classifiers:
            workspace.classifiers.save(c)
            written.append((workspace.classifiers, c.id))
        for a in d.agents:
            workspace.agents.save(a)
            written.append((workspace.agents, a.id))
        workspace.systems.save(d.system)
    except Exception:
        for collection, item_id in reversed(written):
            collection.delete(item_id)
        raise
    if d.classifiers:
        from .safety import sync_rails
        sync_rails()
    return d
