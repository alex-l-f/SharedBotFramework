"""
Definition schemas: what the web UI edits and the workspace stores.

* ``AgentDef``  — a reusable agent: prompt, tools, model, limits. Agents know
  nothing about the systems they are deployed in.
* ``SystemDef`` — a multi-agent system (MAS): nodes (agent instances with
  system-specific prompt/tool/mode overrides), links between them, which
  node talks to the user, prompt fragments, memory and UI settings.
* ``DatasetDef`` — a resource repository and what extraction pulls out of
  its files.
* ``RetrieverDef`` — a search method over one or more datasets, and how its
  results are presented to agents.
* ``ClassifierDef`` — a safety classifier (MIRA's SAFER, Qwen3Guard, NVIDIA
  NemoGuard or NeMo Guardrails, an LLM judge, keyword rules); systems attach
  them to nodes as ``GuardDef`` (checking user messages or replies).

Prompts and a few link fields are Jinja templates rendered at run time; see
``sbf.runtime.prompts`` for the variables they can use.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# Ids are file names and (for nodes) ADK agent names, which must be Python
# identifiers.
SLUG_PATTERN = r"^[a-z0-9][a-z0-9_\-]*$"
IDENT_PATTERN = r"^[A-Za-z_][A-Za-z0-9_]*$"


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ModelSpec(_Model):
    """Which LLM an agent runs on. Unset fields inherit (preset → agent → node)."""
    preset: str | None = None
    provider: Literal["openrouter", "llama_cpp", "gemini", "litellm"] | None = None
    model: str | None = None
    api_base: str | None = None
    reasoning_effort: str | None = None
    temperature: float | None = None
    top_p: float | None = None
    top_k: int | None = None
    presence_penalty: float | None = None
    max_output_tokens: int | None = None

    def overlay(self, other: "ModelSpec | None") -> "ModelSpec":
        """This spec with every field *other* sets taking precedence."""
        if other is None:
            return self
        data = self.model_dump()
        data.update(other.model_dump(exclude_none=True))
        return ModelSpec.model_validate(data)


class ToolBinding(_Model):
    """One tool attached to an agent or node, with its configuration."""
    tool: str = Field(description="Registered tool id")
    name: str | None = Field(None, description="Function name shown to the model (default: tool id)")
    description: str | None = Field(None, description="Overrides the tool's model-facing description")
    config: dict[str, Any] = Field(default_factory=dict)
    budget: int | None = Field(None, description="Max calls per agent run; further calls are refused")
    result_cap: int | None = Field(None, description="Max characters of a string result")
    enabled: bool = True

    @property
    def function_name(self) -> str:
        return self.name or self.tool


class AgentDef(_Model):
    id: str = Field(pattern=SLUG_PATTERN)
    name: str = ""
    description: str = Field("", description="What the agent does; used for handoff/delegation descriptions")
    tags: list[str] = Field(default_factory=list)
    prompt: str = ""
    tools: list[ToolBinding] = Field(default_factory=list)
    model: ModelSpec = Field(default_factory=ModelSpec)
    max_llm_calls: int = 20
    reply_mode: Literal["text", "tool"] = Field(
        "text", description="text: visible model text is delivered to the user when the agent "
        "talks to the user; tool: only send_message reaches the user")
    notes: str = Field("", description="Designer notes; never sent to the model")
    updated_at: str | None = None
    updated_by: str | None = None


class ModeDef(_Model):
    """A context variant a node can switch between (switch_mode)."""
    id: str = Field(pattern=IDENT_PATTERN)
    label: str = ""
    description: str = ""
    prompt: str = ""
    state: dict[str, Any] = Field(
        default_factory=dict,
        description="Session state set on entering the mode (e.g. the active library)")


class ContextDef(_Model):
    """Retrieved material added to a node's instruction before it runs
    (retrieve-before-the-turn RAG), recomputed whenever its question or
    scope changes."""
    name: str = Field(pattern=IDENT_PATTERN, description="Template variable: {{ context.<name> }}")
    retriever: str
    label: str = Field("", description="Heading above the material when appended")
    placement: Literal["append", "template"] = Field(
        "append", description="append: added after the instruction; template: only where the "
        "prompt template uses {{ context.<name> }}")
    question: str = Field(
        "", description="Jinja template for the retrieval question; empty = the latest user "
        "message (a delegated node: its request)")
    condition: str = Field(
        "", description="Jinja expression; retrieve only when it is true (e.g. state.library)")
    scope_state_key: str = Field(
        "", description="Search only the dataset named in this session state key (e.g. library)")
    budget: int | None = Field(None, description="Characters of material (default: the retriever's)")


class NodeDef(_Model):
    id: str = Field(pattern=IDENT_PATTERN, description="Node id; also the ADK agent name")
    agent: str
    label: str = ""
    prompt_template: str = Field(
        "", description="Jinja template for the node's full instruction; "
        "empty means '{{ agent_prompt }}'")
    tools: list[ToolBinding] = Field(default_factory=list, description="System-specific extra tools")
    tool_config: dict[str, dict[str, Any]] = Field(
        default_factory=dict,
        description="Config overrides for the agent's tools, keyed by function name")
    model: ModelSpec | None = None
    max_llm_calls: int | None = None
    modes: list[ModeDef] = Field(default_factory=list)
    initial_mode: str | None = None
    inject_memory: bool = Field(False, description="Append the profile's memory snapshot to the instruction")
    context: list[ContextDef] = Field(default_factory=list,
                                      description="Retrieved material added to the instruction")
    position: dict[str, float] = Field(default_factory=lambda: {"x": 0.0, "y": 0.0})


LinkType = Literal["delegate", "handoff", "observe"]


class LinkDef(_Model):
    """A directed connection between two nodes.

    * delegate — the source gets a tool that runs the target in an isolated
      session and returns the target's terminal-tool result (agent-as-tool).
    * handoff — the source can transfer the conversation with the user to the
      target (ADK transfer_to_agent); the target becomes user-facing.
    * observe — the target runs after every completed turn of the source,
      on that turn's transcript (e.g. memory extraction).
    """
    id: str
    type: LinkType
    source: str
    target: str
    # delegate
    tool_name: str | None = Field(None, pattern=IDENT_PATTERN)
    tool_description: str = ""
    parameters: dict[str, Any] | None = Field(
        None, description="JSON schema of the delegate tool's arguments "
        "(default: one required 'question' string)")
    require_state: list[str] = Field(
        default_factory=list, description="Session state keys that must be set to delegate")
    require_state_error: str = ""
    # delegate + observe
    request_template: str = Field(
        "", description="Jinja template for the message the target receives")
    max_llm_calls: int | None = None
    nudge: str = Field(
        "", description="Reminder sent once if the target ends without its terminal tool")
    share_resources: bool = Field(
        True, description="delegate: merge resources the target retrieved back into the source; "
        "observe: give the target the turn's resources")
    # observe
    requires_profile: bool = Field(True, description="observe: only run when a user profile is active")


class MemoryConfig(_Model):
    enabled: bool = False
    schema_id: str | None = Field(None, description="Memory schema in workspace/memory_schemas")
    namespace: str | None = Field(None, description="Memory partition (default: the system id)")


class UIConfig(_Model):
    title: str = ""
    welcome: str = Field("", description="Markdown shown before the first message")
    starters: list[str] = Field(default_factory=list, description="Suggested first messages")
    require_profile: bool = False
    show_viewer: bool = True


# -------------------------------------------------------------------- safety

SafetyProvider = Literal["safer", "qwen3guard", "nemoguard", "nemo_guardrails", "llm", "keywords"]
GuardAction = Literal["block", "inform", "add_message", "flag", "regenerate", "replace"]
INPUT_ACTIONS = ("block", "inform", "add_message", "flag")
OUTPUT_ACTIONS = ("regenerate", "replace", "add_message", "flag")


class KeywordRule(_Model):
    category: str = Field(min_length=1)
    pattern: str = Field(min_length=1, description="Regular expression (case-insensitive)")

    @field_validator("pattern")
    @classmethod
    def _regex(cls, v: str) -> str:
        import re
        try:
            re.compile(v)
        except re.error as exc:
            raise ValueError(f"invalid regex: {exc}") from None
        return v


class ClassifierDef(_Model):
    """A safety classifier. Every provider answers the same question — is this
    message (or user message + reply) safe, and which categories apply — so
    any of them can guard any node.

    * ``safer``     — MIRA's SAFER classifier service (``url``, default
                      http://127.0.0.1:8100; ``threshold``)
    * ``qwen3guard`` — Qwen3Guard-Gen behind an OpenAI-compatible server
                      (``model``: e.g. provider llama_cpp + api_base)
    * ``nemoguard`` — NVIDIA's Llama 3.1 NemoGuard content-safety model (NIM,
                      build.nvidia.com or self-hosted; ``model``, ``prompt``)
    * ``nemo_guardrails`` — a NeMo Guardrails server running this
                      classifier's rails config (``rails_config``,
                      ``rails_prompts``; ``url``, default http://127.0.0.1:8300)
    * ``llm``       — any model as a judge, with ``prompt`` and ``categories``
    * ``keywords``  — regular expressions per category (no model; instant)
    """
    id: str = Field(pattern=SLUG_PATTERN)
    name: str = ""
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    provider: SafetyProvider = "safer"
    url: str = Field("", description="Service URL (safer, nemo_guardrails); empty = the default")
    model: ModelSpec = Field(default_factory=ModelSpec, description="qwen3guard, nemoguard, llm")
    threshold: float = Field(0.5, ge=0.0, le=1.0, description="safer: score above which a category applies")
    prompt: str = Field("", description="nemoguard, llm: prompt template (empty = the default)")
    categories: list[str] = Field(default_factory=list, description="llm: the categories it may report")
    keywords: list[KeywordRule] = Field(default_factory=list)
    rails_config: str = Field("", description="nemo_guardrails: config.yml (empty = the default)")
    rails_prompts: str = Field("", description="nemo_guardrails: prompts.yml (empty = the default)")
    controversial_unsafe: bool = Field(False, description="qwen3guard: treat 'Controversial' as unsafe")
    timeout: float = Field(15.0, gt=0, le=120)
    on_error: Literal["allow", "block"] = Field(
        "allow", description="When the classifier can't answer: let the message through, or treat it as unsafe")
    notes: str = ""
    updated_at: str | None = None
    updated_by: str | None = None


class GuardRule(_Model):
    """What to do with an unsafe verdict (the first rule that matches)."""
    categories: list[str] = Field(default_factory=list, description="Empty = any unsafe verdict; else any of "
                                  "these (case-insensitive, part of the category name is enough)")
    action: GuardAction
    message: str = Field("", description="block / replace / add_message: shown to the user; "
                         "inform / regenerate: told to the agent")


DEFAULT_BLOCK_MESSAGE = ("I'm not able to help with that. If you're going through something difficult, "
                         "please consider reaching out to someone you trust or a support line.")


class GuardDef(_Model):
    """A classifier attached to a node of a system.

    * ``input``  — checks each user message before the system answers. Rules:
      ``block`` (a fixed reply instead; the agents don't run), ``inform``
      (the node is told, in its instruction, what was flagged), ``add_message``
      (a fixed message for the user, e.g. crisis resources, then the agents
      answer), ``flag`` (recorded only).
    * ``output`` — checks each message the node sends before the user sees it
      (``scope`` ``exchange``: together with the user's message, as MIRA
      does). Rules: ``regenerate`` (the node is asked for a different reply,
      up to ``max_retries``, then the rule's message replaces it),
      ``replace``, ``add_message``, ``flag``.
    """
    id: str = Field(pattern=IDENT_PATTERN)
    classifier: str
    node: str = Field("", description="Node it guards (empty = the entry node)")
    check: Literal["input", "output"] = "input"
    scope: Literal["message", "exchange"] = Field(
        "message", description="output: the reply alone, or the user's message + the reply")
    rules: list[GuardRule] = Field(default_factory=list, description="Empty = block (input) / regenerate (output)")
    max_retries: int = Field(2, ge=0, le=5)
    enabled: bool = True
    position: dict[str, float] = Field(default_factory=lambda: {"x": 0.0, "y": 0.0})

    @model_validator(mode="after")
    def _actions(self):
        allowed = INPUT_ACTIONS if self.check == "input" else OUTPUT_ACTIONS
        for rule in self.rules:
            if rule.action not in allowed:
                raise ValueError(f"guard {self.id!r}: {self.check} guards can {', '.join(allowed)} "
                                 f"(not {rule.action!r})")
        return self

    def effective_rules(self) -> list[GuardRule]:
        if self.rules:
            return self.rules
        return [GuardRule(action="block" if self.check == "input" else "regenerate",
                          message=DEFAULT_BLOCK_MESSAGE)]


class SystemDef(_Model):
    id: str = Field(pattern=SLUG_PATTERN)
    name: str = ""
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    entry: str = Field(description="Node that talks to the user")
    nodes: list[NodeDef] = Field(default_factory=list)
    links: list[LinkDef] = Field(default_factory=list)
    fragments: dict[str, str] = Field(default_factory=dict, description="System prompt fragments")
    variables: dict[str, Any] = Field(default_factory=dict)
    state: dict[str, Any] = Field(default_factory=dict, description="Initial session state")
    memory: MemoryConfig = Field(default_factory=MemoryConfig)
    ui: UIConfig = Field(default_factory=UIConfig)
    guards: list[GuardDef] = Field(default_factory=list, description="Safety classifiers attached to nodes")
    notes: str = ""
    updated_at: str | None = None
    updated_by: str | None = None

    def node(self, node_id: str) -> NodeDef | None:
        return next((n for n in self.nodes if n.id == node_id), None)

    def links_from(self, node_id: str, type_: LinkType | None = None) -> list[LinkDef]:
        return [l for l in self.links
                if l.source == node_id and (type_ is None or l.type == type_)]


class MemorySlot(_Model):
    enum: str | list[str] | None = Field(None, description="Vocabulary name or inline values")
    ref: Literal["resource"] | None = None
    required: bool = False


class MemoryTemplate(_Model):
    description: str = ""
    slots: dict[str, MemorySlot] = Field(default_factory=dict)
    follow_up: bool = False
    render: str = Field("", description="Jinja template producing the note's text")


class MemorySchema(_Model):
    """A privacy-preserving memory vocabulary: notes are template + enum slots only."""
    id: str = Field(pattern=SLUG_PATTERN)
    name: str = ""
    description: str = ""
    vocabularies: dict[str, list[str]] = Field(default_factory=dict)
    labels: dict[str, str] = Field(default_factory=dict, description="Display labels for enum values")
    templates: dict[str, MemoryTemplate] = Field(default_factory=dict)
    snapshot_max_chars: int = 1200
    updated_at: str | None = None
    updated_by: str | None = None

    @model_validator(mode="after")
    def _check_vocab_refs(self):
        for key, tpl in self.templates.items():
            for slot, rule in tpl.slots.items():
                if isinstance(rule.enum, str) and rule.enum not in self.vocabularies:
                    raise ValueError(
                        f"template {key!r} slot {slot!r} uses unknown vocabulary {rule.enum!r}")
        return self

    def slot_values(self, rule: MemorySlot) -> list[str]:
        if isinstance(rule.enum, str):
            return self.vocabularies.get(rule.enum, [])
        return list(rule.enum or [])


class Fragment(_Model):
    id: str = Field(pattern=SLUG_PATTERN)
    text: str = ""

    @field_validator("text")
    @classmethod
    def _text(cls, v: str) -> str:
        return v or ""


# ------------------------------------------------------------------ RAG data

FieldType = Literal["text", "long_text", "list", "enum", "number", "boolean"]


class FieldDef(_Model):
    """One piece of information the extractor pulls out of every document."""
    name: str = Field(pattern=IDENT_PATTERN)
    type: FieldType = "text"
    description: str = Field("", description="What to extract; the extractor's instructions for this field")
    options: list[str] = Field(default_factory=list, description="Allowed values (enum)")
    required: bool = False


class ExtractionConfig(_Model):
    enabled: bool = Field(True, description="Run LLM field extraction on each document")
    model: ModelSpec = Field(default_factory=ModelSpec)
    instructions: str = Field("", description="Extra guidance for the extractor (what the library is for)")
    max_chars: int = Field(60000, ge=1000, description="Document characters sent to the extractor")


class VisionConfig(_Model):
    enabled: bool = Field(False, description="Read images, scanned pages and image-only slides with a vision model")
    model: ModelSpec = Field(default_factory=ModelSpec)
    prompt: str = Field("", description="Instructions for reading one image (default: transcribe + describe)")
    min_page_chars: int = Field(
        40, description="PDF pages / slides with less extractable text than this are read as images")
    max_images: int = Field(60, ge=1, description="Images read per document at most")


class ChunkingConfig(_Model):
    chunk_chars: int = Field(1500, ge=200, description="Target characters per chunk")
    overlap: int = Field(150, ge=0, description="Characters repeated between consecutive chunks")
    summary_chunk: bool = Field(
        True, description="Add a chunk with the title and extracted fields to each document")


class RecordsConfig(_Model):
    """Tabular files (CSV, TSV, XLSX, JSON lists): every row is an item."""
    title_field: str = Field("", description="Column used as the item title (default: title/name)")
    text_template: str = Field("", description="Jinja over `row` for the item text (default: one 'key: value' line per column)")
    extract: bool = Field(False, description="Also run field extraction on each row")


class DatasetDef(_Model):
    """A resource repository: uploaded files, processed into items whose
    fields the extraction pipeline fills in."""
    id: str = Field(pattern=SLUG_PATTERN)
    name: str = ""
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    fields: list[FieldDef] = Field(default_factory=list)
    extraction: ExtractionConfig = Field(default_factory=ExtractionConfig)
    vision: VisionConfig = Field(default_factory=VisionConfig)
    chunking: ChunkingConfig = Field(default_factory=ChunkingConfig)
    records: RecordsConfig = Field(default_factory=RecordsConfig)
    notes: str = ""
    updated_at: str | None = None
    updated_by: str | None = None

    @model_validator(mode="after")
    def _check_fields(self):
        names = [f.name for f in self.fields]
        dupes = {n for n in names if names.count(n) > 1}
        if dupes:
            raise ValueError(f"duplicate field names: {', '.join(sorted(dupes))}")
        for f in self.fields:
            if f.type == "enum" and not f.options:
                raise ValueError(f"field {f.name!r} is an enum without options")
        return self


class RetrieverSource(_Model):
    dataset: str
    where: dict[str, list[str]] = Field(
        default_factory=dict, description="Item filters: source_type, file or a field name → allowed values")
    mapping: dict[str, str] = Field(
        default_factory=dict, description="Overrides of the retriever's mapping for this dataset")


RetrieverUnit = Literal["chunks", "items", "items+chunks"]
RetrieverMethod = Literal["hybrid", "facets", "catalog", "all"]
Presentation = Literal["passages", "json", "template", "brief"]


class RetrieverDef(_Model):
    """The search layer between datasets and agents: which datasets, how
    their items map to what is searched and shown, how passages are chosen,
    and how they are presented to the model."""
    id: str = Field(pattern=SLUG_PATTERN)
    name: str = ""
    description: str = Field("", description="What it finds; the default tool description")
    tags: list[str] = Field(default_factory=list)
    sources: list[RetrieverSource] = Field(default_factory=list)
    mapping: dict[str, str] = Field(
        default_factory=dict,
        description="Retriever fields as Jinja over item/chunk: title, text, index_text, "
                    "chunk_text, chunk_index_text, url")
    unit: RetrieverUnit = Field("chunks", description="What gets searched: document chunks, whole items, or both")
    method: RetrieverMethod = "hybrid"
    k: int = Field(10, ge=1, le=200, description="Passages selected (hybrid)")
    max_per_item: int = Field(3, ge=1, description="Passages from one item at most")
    dense_weight: float = Field(1.0, ge=0)
    bm25_weight: float = Field(1.0, ge=0)
    query_rewrite: bool = Field(False, description="An LLM writes search queries from the conversation first")
    catalog_line: str = Field("", description="catalog: Jinja line per item shown to the selecting LLM")
    catalog_max: int = Field(12, ge=1, description="catalog: items the LLM may pick")
    presentation: Presentation = "passages"
    budget: int = Field(12000, ge=500, description="Characters the presentation may use")
    template: str = Field("", description="template: Jinja over passages/items/request")
    json_fields: list[str] = Field(default_factory=list, description="json: item fields to include (empty = all)")
    brief_prompt: str = Field("", description="brief: how to organize the brief (appended to the default prompt)")
    model: ModelSpec = Field(default_factory=ModelSpec, description="Model for LLM steps")
    embedder: str = Field("", description="Embedder name from settings (empty = default)")
    notes: str = ""
    updated_at: str | None = None
    updated_by: str | None = None


# --------------------------------------------------------------- simulations

class PersonaDef(_Model):
    """A simulated user: who they are and how they write. The simulator
    model plays them against a system."""
    id: str = Field(pattern=SLUG_PATTERN)
    name: str = ""
    description: str = Field("", description="One line, for lists")
    tags: list[str] = Field(default_factory=list)
    profile: str = Field("", description="Who they are and how they type: background, personality, "
                                         "tone, message length, quirks")
    model: ModelSpec = Field(default_factory=ModelSpec, description="The model playing this persona")
    notes: str = ""
    updated_at: str | None = None
    updated_by: str | None = None


class Expectation(_Model):
    """Something a good conversation should cover (graded 0-3 by the judge)."""
    name: str
    description: str = Field("", description="What it is, for the judge")
    pattern: str = Field("", description="Regex: a deterministic check that the assistant mentions it")

    @field_validator("pattern")
    @classmethod
    def _regex(cls, v: str) -> str:
        if v:
            import re
            try:
                re.compile(v)
            except re.error as exc:
                raise ValueError(f"invalid regex: {exc}") from None
        return v


class ScenarioDef(_Model):
    """What a simulated user is dealing with and wants from the conversation."""
    id: str = Field(pattern=SLUG_PATTERN)
    name: str = ""
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    persona: str = Field("", description="Default persona (a run can choose others)")
    opening: str = Field("", description="The user's first message")
    opening_mode: Literal["exact", "guide"] = Field(
        "exact", description="exact: sent as written (every run starts alike); guide: the simulator "
        "writes its own first message close to it")
    situation: str = Field("", description="What is going on, from the user's side")
    facts: dict[str, str] = Field(
        default_factory=dict, description="Details the user reveals only when asked (label → answer)")
    goal: str = Field("", description="What the user wants; when they would be satisfied")
    max_turns: int = Field(8, ge=1, le=50)
    expectations: list[Expectation] = Field(default_factory=list)
    profile: str = Field("", description="Profile whose memory the simulated user starts with (copied)")
    notes: str = ""
    updated_at: str | None = None
    updated_by: str | None = None


class Criterion(_Model):
    key: str = Field(pattern=IDENT_PATTERN)
    title: str = ""
    description: str = ""
    min: int = 1
    max: int = 5
    weight: float = Field(1.0, ge=0)

    @model_validator(mode="after")
    def _range(self):
        if self.max <= self.min:
            raise ValueError(f"criterion {self.key!r}: max must be above min")
        return self


class RubricDef(_Model):
    """How an LLM judge grades a simulated conversation."""
    id: str = Field(pattern=SLUG_PATTERN)
    name: str = ""
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    instructions: str = Field("", description="Context for the judge: what the assistant is for, what good looks like")
    criteria: list[Criterion] = Field(default_factory=list)
    grade_expectations: bool = Field(True, description="Also grade each scenario expectation 0-3")
    model: ModelSpec = Field(default_factory=ModelSpec, description="The judge model (ideally another family than the bots)")
    notes: str = ""
    updated_at: str | None = None
    updated_by: str | None = None

    @model_validator(mode="after")
    def _keys(self):
        keys = [c.key for c in self.criteria]
        dupes = {k for k in keys if keys.count(k) > 1}
        if dupes:
            raise ValueError(f"duplicate criterion keys: {', '.join(sorted(dupes))}")
        return self


class SimRunConfig(_Model):
    """A simulation run: every system × scenario × persona × repetition."""
    name: str = ""
    systems: list[str] = Field(min_length=1)
    scenarios: list[str] = Field(min_length=1)
    personas: list[str] = Field(default_factory=list, description="Empty = each scenario's own persona")
    repetitions: int = Field(1, ge=1, le=200)
    max_turns: int | None = Field(None, ge=1, le=50, description="Overrides the scenarios' max_turns")
    concurrency: int = Field(4, ge=1, le=64, description="Conversations at once")
    rubric: str = Field("", description="Judge each conversation with this rubric (optional)")
    profile_mode: Literal["none", "fresh"] = Field(
        "fresh", description="fresh: each conversation gets a new profile (memory agents run; a "
        "scenario's profile memory is copied in); none: no profile")
    simulator_model: ModelSpec | None = Field(None, description="Overrides the personas' models")
    judge_model: ModelSpec | None = Field(None, description="Overrides the rubric's model")
    notes: str = ""
