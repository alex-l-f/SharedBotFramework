"""
Tool plugin API.

A tool is a ``Tool`` subclass registered with ``@register``. It declares:

* ``id``          — registry key, referenced by agent/node tool bindings
* ``parameters``  — JSON schema of the arguments the model passes
* ``Config``      — pydantic model of its per-binding configuration; the web
                    UI renders a form from its JSON schema
* ``terminal``    — ``True`` for output-contract tools (``return_summary``,
                    ``record_memories``): an accepted call ends the agent's
                    run, and its payload becomes the run's result

and implements ``async run(args, ctx)``. ``ctx`` (``ToolContext``) is the
tool's view of the running system: session state, the user-facing output
channel, the trace, retrieved resources, services.

Drop a module defining tools into ``sbf/tools/builtin/`` or
``workspace/plugins/`` and it is discovered at startup.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, ClassVar

from pydantic import BaseModel, ConfigDict

from ..schemas import ToolBinding

if TYPE_CHECKING:
    from ..runtime.builder import CompiledNode, CompiledSystem
    from ..runtime.context import AgentRun


class NoConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ToolContext:
    """What a running tool can see and do."""

    def __init__(self, run: "AgentRun", adk_tool_context):
        self.run = run
        self.adk = adk_tool_context

    # -- where we are
    @property
    def turn(self):
        return self.run.turn

    @property
    def node(self) -> "CompiledNode":
        return self.run.node

    @property
    def system(self) -> "CompiledSystem":
        return self.run.turn.system

    @property
    def chat_id(self) -> str:
        return self.run.turn.chat_id

    @property
    def profile(self) -> dict | None:
        return self.run.turn.profile

    @property
    def state(self):
        """Session state (writes are persisted as an ADK state delta)."""
        return self.adk.state

    @property
    def resources(self):
        """Items retrieved in this agent run, addressable by id."""
        return self.run.resources

    @property
    def user_facing(self) -> bool:
        return self.run.user_facing

    # -- effects
    def emit(self, type_: str, payload: dict) -> None:
        """Send a user-facing output (file card, viewer page, ...)."""
        self.run.turn.emit_output(type_, self.run.node.id, payload)

    async def deliver(self, text: str) -> str | None:
        """Deliver to the user behind the node's output guards; returns what the
        model should be told (None: delivered)."""
        from ..safety import deliver_checked
        return await deliver_checked(self.run, text)

    def deliver_message(self, text: str) -> str | None:
        """Deliver a chat message to the user; returns an error string if suppressed."""
        from ..runtime.context import deliver_message
        return deliver_message(self.run, text)

    def trace(self, event: str, data: dict | None = None, persist=None, agent: str | None = None) -> None:
        self.run.trace(event, data, persist, agent=agent)

    def finish(self, result: Any) -> None:
        """Terminal tools: accept *result* as the run's output and end the run."""
        self.run.terminal_result = result

    def end_turn(self) -> None:
        """End the user-facing agent's turn (finish_turn)."""
        self.run.done = True


class Tool:
    id: ClassVar[str]
    label: ClassVar[str] = ""
    category: ClassVar[str] = "general"
    summary: ClassVar[str] = ""
    description: ClassVar[str] = ""
    parameters: ClassVar[dict] = {"type": "object", "properties": {}}
    Config: ClassVar[type[BaseModel]] = NoConfig
    terminal: ClassVar[bool] = False
    # Free-form requirement labels shown in the UI ("knowledge", "memory", "modes").
    requires: ClassVar[tuple[str, ...]] = ()

    def __init__(self, binding: ToolBinding, node: "CompiledNode", system: "CompiledSystem"):
        self.binding = binding
        self.node = node
        self.system = system
        self.config = self.Config.model_validate(binding.config or {})

    @property
    def name(self) -> str:
        return self.binding.function_name

    def model_description(self) -> str:
        """Description sent to the model (bindings may override it)."""
        return self.binding.description or self.description

    def model_parameters(self) -> dict:
        """Argument schema sent to the model; override for dynamic schemas."""
        return self.parameters

    def check(self) -> list[str]:
        """Problems with this binding in this system, shown when validating."""
        return []

    def retrievers(self) -> list[str]:
        """Retriever ids this binding uses (compiled into the system snapshot)."""
        return []

    async def run(self, args: dict, ctx: ToolContext) -> Any:
        raise NotImplementedError

    @classmethod
    def fallback_result(cls, run: "AgentRun") -> Any:
        """Terminal tools: the result when a run ends without an accepted call."""
        return {"result": run.last_text or "", "complete": False,
                "note": "The agent ended without its structured result; treat with caution."}

    @classmethod
    def config_schema(cls) -> dict:
        """The Config JSON schema, with defaults filled in for fields that
        use a default factory (pydantic leaves those out)."""
        schema = cls.Config.model_json_schema()
        try:
            defaults = cls.Config().model_dump(mode="json")
        except Exception:  # a config with required fields
            return schema
        for key, prop in (schema.get("properties") or {}).items():
            if "default" not in prop and key in defaults:
                prop["default"] = defaults[key]
        return schema

    @classmethod
    def describe(cls) -> dict:
        return {
            "id": cls.id,
            "label": cls.label or cls.id.replace("_", " ").capitalize(),
            "category": cls.category,
            "summary": cls.summary or cls.description.split(". ")[0],
            "description": cls.description,
            "parameters": cls.parameters,
            "config_schema": cls.config_schema(),
            "terminal": cls.terminal,
            "requires": list(cls.requires),
        }
