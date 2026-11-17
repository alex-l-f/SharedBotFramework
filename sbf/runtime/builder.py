"""
Compiling a system definition.

``compile_system`` resolves a ``SystemDef`` against the workspace (agents,
fragments, memory schema, retrievers, tool registry, model presets), merges node
overrides into each agent's tool bindings and model, checks the graph, and
snapshots the result. The snapshot hash is recorded with every turn, so any
transcript can be traced back to the exact prompts, tools and models that
produced it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from pydantic import ValidationError

from ..llm import resolve_spec
from ..schemas import (AgentDef, LinkDef, MemorySchema, ModeDef, ModelSpec, RetrieverDef, SystemDef,
                       ToolBinding)
from ..tools import get_tool_class
from ..workspace import NotFound, content_hash, workspace

DEFAULT_DELEGATE_PARAMETERS = {
    "type": "object",
    "properties": {"question": {
        "type": "string",
        "description": "A specific, self-contained request, including anything from the "
                       "conversation the other agent needs to answer it well."}},
    "required": ["question"],
}


class CompileError(ValueError):
    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


@dataclass
class CompiledNode:
    id: str
    node: "NodeDef"  # noqa: F821
    agent: AgentDef
    bindings: list[ToolBinding]
    model_spec: ModelSpec
    max_llm_calls: int
    modes: dict[str, ModeDef]
    delegates: list[LinkDef] = field(default_factory=list)
    handoffs: list[LinkDef] = field(default_factory=list)
    observers: list[LinkDef] = field(default_factory=list)
    user_facing: bool = False

    @property
    def label(self) -> str:
        return self.node.label or self.agent.name or self.id

    def terminal_bindings(self) -> list[ToolBinding]:
        return [b for b in self.bindings if get_tool_class(b.tool).terminal]


@dataclass
class CompiledSystem:
    system: SystemDef
    agents: dict[str, AgentDef]
    nodes: dict[str, CompiledNode]
    fragments: dict[str, str]
    memory_schema: MemorySchema | None
    snapshot: dict
    hash: str
    warnings: list[str] = field(default_factory=list)
    retrievers: dict[str, RetrieverDef] = field(default_factory=dict)
    # Enabled guards (node resolved) and the classifiers they use.
    guards: list = field(default_factory=list)
    classifiers: dict = field(default_factory=dict)

    @property
    def entry(self) -> CompiledNode:
        return self.nodes[self.system.entry]

    @property
    def memory_namespace(self) -> str:
        return self.system.memory.namespace or self.system.id

    @property
    def memory_enabled(self) -> bool:
        return bool(self.system.memory.enabled and self.memory_schema)


def _merge_bindings(agent: AgentDef, node) -> list[ToolBinding]:
    out = []
    for binding in agent.tools:
        if not binding.enabled:
            continue
        override = node.tool_config.get(binding.function_name)
        if override:
            binding = binding.model_copy(update={"config": {**binding.config, **override}})
        out.append(binding)
    out.extend(b for b in node.tools if b.enabled)
    return out


def compile_system(system: SystemDef | str, *, strict: bool = True,
                   pending: dict | None = None) -> CompiledSystem:
    """Resolve and check *system*. With ``strict`` any problem raises
    ``CompileError``; otherwise problems are returned as warnings and the
    broken parts are left out (for previews in the editor). ``pending``
    ({"agents": {id: AgentDef}, "classifiers": {id: ClassifierDef}}) are
    definitions not saved yet (the setup wizard checks a whole set first)."""
    if isinstance(system, str):
        system = workspace.systems.get(system)
    pending = pending or {}

    problems: list[str] = []
    warnings: list[str] = []
    agents: dict[str, AgentDef] = dict(pending.get("agents") or {})
    nodes: dict[str, CompiledNode] = {}
    retrievers: dict[str, RetrieverDef] = {}

    fragments = {**workspace.fragments.all(), **system.fragments}

    memory_schema = None
    if system.memory.enabled:
        if not system.memory.schema_id:
            problems.append("memory is enabled but no memory schema is selected")
        else:
            try:
                memory_schema = workspace.memory_schemas.get(system.memory.schema_id)
            except NotFound:
                problems.append(f"memory schema {system.memory.schema_id!r} not found")
            except ValidationError as exc:
                problems.append(f"memory schema {system.memory.schema_id!r} is invalid: {exc}")

    seen_ids = set()
    for node in system.nodes:
        if node.id in seen_ids:
            problems.append(f"duplicate node id {node.id!r}")
            continue
        seen_ids.add(node.id)
        try:
            agent = agents.get(node.agent) or workspace.agents.get(node.agent)
        except NotFound:
            problems.append(f"node {node.id!r}: agent {node.agent!r} not found")
            continue
        except ValidationError as exc:
            problems.append(f"node {node.id!r}: agent {node.agent!r} is invalid: {exc}")
            continue
        agents[agent.id] = agent
        try:
            spec = resolve_spec(agent.model, node.model)
        except ValueError as exc:
            problems.append(f"node {node.id!r}: {exc}")
            spec = ModelSpec()
        modes = {m.id: m for m in node.modes}
        if node.initial_mode and node.initial_mode not in modes:
            problems.append(f"node {node.id!r}: initial mode {node.initial_mode!r} is not one of its modes")
        nodes[node.id] = CompiledNode(
            id=node.id, node=node, agent=agent, bindings=_merge_bindings(agent, node),
            model_spec=spec, max_llm_calls=node.max_llm_calls or agent.max_llm_calls, modes=modes)

    if system.entry not in nodes:
        problems.append(f"entry node {system.entry!r} does not exist")

    handoff_parent: dict[str, str] = {}
    link_ids = set()
    for link in system.links:
        if link.id in link_ids:
            problems.append(f"duplicate link id {link.id!r}")
        link_ids.add(link.id)
        src, dst = nodes.get(link.source), nodes.get(link.target)
        if src is None or dst is None:
            problems.append(f"link {link.id!r}: unknown node {link.source if src is None else link.target!r}")
            continue
        if link.source == link.target:
            problems.append(f"link {link.id!r}: a node can't link to itself")
            continue
        if link.type == "delegate":
            if not link.tool_name:
                link = link.model_copy(update={"tool_name": f"ask_{link.target}"})
            src.delegates.append(link)
            if not dst.terminal_bindings():
                warnings.append(f"delegate target {dst.id!r} has no terminal tool; its last text "
                                "will be returned instead")
        elif link.type == "handoff":
            if link.target == system.entry:
                problems.append(f"link {link.id!r}: the entry node can't be a handoff target")
            elif link.target in handoff_parent:
                problems.append(f"node {link.target!r} has two handoff parents "
                                "(handoffs must form a tree from the entry node)")
            else:
                handoff_parent[link.target] = link.source
                src.handoffs.append(link)
        elif link.type == "observe":
            src.observers.append(link)
            if not dst.terminal_bindings():
                warnings.append(f"observer {dst.id!r} has no terminal tool")

    # User-facing nodes: the entry plus everything reachable by handoff.
    if system.entry in nodes:
        stack, seen = [system.entry], set()
        while stack:
            nid = stack.pop()
            if nid in seen:
                problems.append(f"handoff cycle through {nid!r}")
                break
            seen.add(nid)
            nodes[nid].user_facing = True
            stack.extend(l.target for l in nodes[nid].handoffs)
        for nid in handoff_parent:
            if nid not in seen:
                problems.append(f"handoff target {nid!r} is not reachable from the entry node")

    # Tool bindings: known tools, valid config, unique function names.
    for cnode in nodes.values():
        names: dict[str, str] = {}
        for binding in cnode.bindings:
            try:
                cls = get_tool_class(binding.tool)
            except KeyError:
                problems.append(f"node {cnode.id!r}: unknown tool {binding.tool!r}")
                continue
            try:
                tool = cls(binding, cnode, None)  # type: ignore[arg-type]
            except ValidationError as exc:
                problems.append(f"node {cnode.id!r}: tool {binding.function_name!r} config: "
                                + "; ".join(e["msg"] for e in exc.errors()))
                continue
            if binding.function_name in names:
                problems.append(f"node {cnode.id!r}: two tools named {binding.function_name!r}")
            names[binding.function_name] = binding.tool
            tool.system = None
            for issue in _check_tool(tool, cnode, memory_schema, system):
                warnings.append(f"node {cnode.id!r}: {binding.function_name}: {issue}")
            for rid in tool.retrievers():
                _need_retriever(rid, f"node {cnode.id!r}: tool {binding.function_name!r}", retrievers, problems)
        for link in cnode.delegates:
            if link.tool_name in names:
                problems.append(f"node {cnode.id!r}: delegate tool {link.tool_name!r} "
                                "clashes with another tool")
            names[link.tool_name] = "delegate"
        context_names = set()
        for c in cnode.node.context:
            if c.name in context_names:
                problems.append(f"node {cnode.id!r}: two context sources named {c.name!r}")
            context_names.add(c.name)
            _need_retriever(c.retriever, f"node {cnode.id!r}: context {c.name!r}", retrievers, problems)

    guards, classifiers = _compile_guards(system, nodes, pending.get("classifiers") or {}, problems)

    if strict and problems:
        raise CompileError(problems)

    agents = {aid: a for aid, a in agents.items() if any(n.agent.id == aid for n in nodes.values())}
    snapshot = {
        "system": system.model_dump(),
        "agents": {aid: a.model_dump(exclude={"updated_at"}) for aid, a in agents.items()},
        "fragments": fragments,
        "memory_schema": memory_schema.model_dump(exclude={"updated_at"}) if memory_schema else None,
        "models": {nid: n.model_spec.model_dump(exclude_none=True) for nid, n in nodes.items()},
    }
    if retrievers:
        # The content a turn searched: retriever definitions and the
        # version of every dataset they read.
        from ..data import DatasetStore
        snapshot["retrievers"] = {rid: r.model_dump(exclude={"updated_at"}) for rid, r in retrievers.items()}
        snapshot["datasets"] = {s.dataset: DatasetStore(s.dataset).version()
                                for r in retrievers.values() for s in r.sources}
    if classifiers:
        snapshot["classifiers"] = {cid: c.model_dump(exclude={"updated_at", "updated_by"})
                                   for cid, c in classifiers.items()}
    snapshot["system"].pop("updated_at", None)
    snapshot["system"].pop("updated_by", None)
    return CompiledSystem(system=system, agents=agents, nodes=nodes, fragments=fragments,
                          memory_schema=memory_schema, snapshot=snapshot,
                          hash=content_hash(snapshot), warnings=warnings + problems * (not strict),
                          retrievers=retrievers, guards=guards, classifiers=classifiers)


def _compile_guards(system: SystemDef, nodes: dict, pending: dict, problems: list[str]):
    """Enabled guards with their node resolved (empty = the entry), and the
    classifiers they use."""
    guards, classifiers, ids = [], {}, set()
    for guard in system.guards:
        if guard.id in ids:
            problems.append(f"duplicate guard id {guard.id!r}")
            continue
        ids.add(guard.id)
        node = guard.node or system.entry
        if node not in nodes:
            problems.append(f"guard {guard.id!r}: node {node!r} not found")
            continue
        if not guard.enabled:
            continue
        cid = guard.classifier
        if cid not in classifiers:
            try:
                classifiers[cid] = pending.get(cid) or workspace.classifiers.get(cid)
            except NotFound:
                problems.append(f"guard {guard.id!r}: classifier {cid!r} not found")
                continue
            except ValidationError as exc:
                problems.append(f"guard {guard.id!r}: classifier {cid!r} is invalid: {exc}")
                continue
        if guard.check == "output" and not nodes[node].user_facing:
            problems.append(f"guard {guard.id!r}: output guards go on nodes that talk to the user "
                            f"({node!r} doesn't)")
            continue
        guards.append(guard.model_copy(update={"node": node}))
    return guards, classifiers


def _need_retriever(rid: str, where: str, retrievers: dict, problems: list[str]) -> None:
    if not rid:
        problems.append(f"{where}: no retriever selected")
        return
    if rid in retrievers:
        return
    try:
        retrievers[rid] = workspace.retrievers.get(rid)
    except NotFound:
        problems.append(f"{where}: retriever {rid!r} not found")
    except ValidationError as exc:
        problems.append(f"{where}: retriever {rid!r} is invalid: {exc}")


def _check_tool(tool, cnode: CompiledNode, memory_schema, system: SystemDef) -> list[str]:
    issues = list(tool.check())
    if "memory" in tool.requires and not (system.memory.enabled and memory_schema):
        issues.append("needs memory, which is not enabled for this system")
    if "modes" in tool.requires and not cnode.modes:
        issues.append("needs modes, but the node defines none")
    return issues


def initial_state(compiled: CompiledSystem) -> dict:
    """Session state a new chat starts with: the system's initial state plus
    each moded node's initial mode (and the state that mode sets)."""
    state = dict(compiled.system.state)
    modes = {}
    for cnode in compiled.nodes.values():
        if not cnode.modes:
            continue
        mode_id = cnode.node.initial_mode or next(iter(cnode.modes))
        modes[cnode.id] = mode_id
        if cnode.user_facing:
            state.update(cnode.modes[mode_id].state)
    if modes:
        state["modes"] = modes
    return state
