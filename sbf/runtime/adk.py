"""
Compiled nodes → ADK objects.

* ``build_agent`` makes an ``LlmAgent`` for a node: instruction provider,
  tools (registered plugins + delegate tools from links), handoff sub-agents,
  and — for user-facing agents in text-reply mode — the callback that
  delivers the model's visible text as the reply.
* ``AdkTool`` / ``DelegateTool`` adapt plugins and delegate links to ADK's
  ``BaseTool``: per-run call budgets, result caps, error-to-result
  conversion, sequential execution, and ending the run when a terminal tool
  accepts (``skip_summarization``).
* ``TracePlugin`` streams model/tool events to the turn's trace and tracks
  the per-run signals the runtime needs (truncation, empty responses).
"""

from __future__ import annotations

import logging
import time
from typing import Any, Awaitable, Callable

from google.adk.agents import LlmAgent
from google.adk.agents.invocation_context import LlmCallsLimitExceededError
from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.agents.run_config import RunConfig
from google.adk.apps import App
from google.adk.plugins.base_plugin import BasePlugin
from google.adk.runners import Runner
from google.adk.tools.base_tool import BaseTool
from google.genai import types

from ..llm import describe, generate_config, make_model
from ..schemas import LinkDef, ToolBinding
from ..tools import Tool, ToolContext, get_tool_class
from .builder import DEFAULT_DELEGATE_PARAMETERS, CompiledNode, CompiledSystem
from .context import AgentRun, clip, deliver_message, scopes
from .prompts import render_instruction
from .retrieval import node_context

log = logging.getLogger(__name__)

_TRUNCATION_HINT = (
    "NOTE: your previous response hit the output token limit, so this call's arguments "
    "arrived empty or cut off. Respond again far more concisely: shorter text, fewer "
    "items, less deliberation.")


def _visible_text(content) -> str:
    if not content or not content.parts:
        return ""
    return "\n".join(p.text for p in content.parts if p.text and not p.thought).strip()


async def _execute(run: AgentRun, name: str, binding: ToolBinding | None,
                   call: Callable[[ToolContext], Awaitable[Any]], tool_context) -> Any:
    run.tool_calls += 1
    if name in run.budgets:
        if run.budgets[name] <= 0:
            return (f"ERROR: the {name} budget for this run is used up. Work with what you "
                    "already have and finish now.")
        run.budgets[name] -= 1

    # ADK runs a response's tool calls concurrently; the lock (FIFO) gives
    # them the sequential semantics delivery-order-sensitive tools expect.
    async with run.lock:
        try:
            result = await call(ToolContext(run, tool_context))
        except Exception as exc:
            log.warning("%s failed: %s", name, exc, exc_info=True)
            result = (f"ERROR: {name} failed ({type(exc).__name__}: {str(exc)[:200]}). "
                      "Continue without it or tell the user that part is unavailable right now.")

    cap = binding.result_cap if binding else None
    if cap and isinstance(result, str) and len(result) > cap:
        result = (result[:cap] + f"\n[... truncated: {len(result) - cap} more characters "
                  "beyond this run's read budget]")
    if run.truncated:
        result = ({**result, "note": _TRUNCATION_HINT} if isinstance(result, dict)
                  else f"{result} {_TRUNCATION_HINT}")
    if run.finished:
        # A terminal tool accepted (or the turn was finished): stop the loop
        # without another model call.
        tool_context.actions.skip_summarization = True
    return result


class AdkTool(BaseTool):
    """A registered tool plugin bound to one node."""

    def __init__(self, tool: Tool):
        super().__init__(name=tool.name, description=tool.model_description())
        self.tool = tool

    def _get_declaration(self) -> types.FunctionDeclaration:
        return types.FunctionDeclaration(
            name=self.name, description=self.tool.model_description(),
            parameters_json_schema=self.tool.model_parameters() or {"type": "object", "properties": {}})

    async def run_async(self, *, args: dict, tool_context) -> Any:
        run = scopes.get(tool_context.session.id, tool_context.agent_name)
        return await _execute(run, self.name, self.tool.binding,
                              lambda ctx: self.tool.run(dict(args), ctx), tool_context)


class DelegateTool(BaseTool):
    """The tool a delegate link gives its source node: runs the target agent
    in an isolated session and returns its terminal-tool result."""

    def __init__(self, link: LinkDef, compiled: CompiledSystem):
        target = compiled.nodes[link.target]
        description = link.tool_description or (
            f"Delegate a task to the {target.label} agent"
            + (f" ({target.agent.description})" if target.agent.description else "")
            + ". It cannot see this conversation, so the request must be self-contained.")
        super().__init__(name=link.tool_name, description=description)
        self.link = link
        self.compiled = compiled

    def _get_declaration(self) -> types.FunctionDeclaration:
        return types.FunctionDeclaration(
            name=self.name, description=self.description,
            parameters_json_schema=self.link.parameters or DEFAULT_DELEGATE_PARAMETERS)

    async def run_async(self, *, args: dict, tool_context) -> Any:
        from .delegation import delegate
        run = scopes.get(tool_context.session.id, tool_context.agent_name)
        return await _execute(run, self.name, None,
                              lambda ctx: delegate(self.link, ctx, dict(args)), tool_context)


async def _deliver_text_reply(callback_context, llm_response):
    """after_model_callback of user-facing text-reply agents."""
    run = scopes.find(callback_context.session.id, callback_context.agent_name)
    if run is None or not llm_response.content or llm_response.partial:
        return None
    text = _visible_text(llm_response.content)
    if text:
        from ..safety import deliver_checked
        error = await deliver_checked(run, text)
        run.trace("text_reply", {"delivered": error is None or error.startswith("REPLACED"), "chars": len(text)})
    return None


def build_agent(compiled: CompiledSystem, cnode: CompiledNode, *, user_facing: bool,
                with_handoffs: bool = False, reasoning_override: str | None = None) -> LlmAgent:
    spec = cnode.model_spec
    if reasoning_override is not None:
        spec = spec.model_copy(update={"reasoning_effort": reasoning_override})

    tools: list[BaseTool] = []
    for binding in cnode.bindings:
        tools.append(AdkTool(get_tool_class(binding.tool)(binding, cnode, compiled)))
    for link in cnode.delegates:
        tools.append(DelegateTool(link, compiled))

    async def instruction(ctx: ReadonlyContext) -> str:
        run = scopes.find(ctx.session.id, cnode.id)
        context = await node_context(run, ctx.state) if run and cnode.node.context else {}
        return render_instruction(compiled, cnode, ctx.state, run, user_facing=user_facing,
                                  memory_snapshot=run.turn.memory_snapshot if run else "",
                                  context=context,
                                  safety_notes=run.turn.safety_notes.get(cnode.id, []) if run else [])

    sub_agents = []
    if with_handoffs:
        for link in cnode.handoffs:
            sub_agents.append(build_agent(compiled, compiled.nodes[link.target], user_facing=True,
                                          with_handoffs=True, reasoning_override=reasoning_override))

    return LlmAgent(
        name=cnode.id,
        description=cnode.agent.description or cnode.agent.name or cnode.id,
        model=make_model(spec),
        instruction=instruction,
        tools=tools,
        sub_agents=sub_agents,
        generate_content_config=generate_config(spec),
        after_model_callback=(_deliver_text_reply
                              if user_facing and cnode.agent.reply_mode == "text" else None),
    )


class TracePlugin(BasePlugin):

    def __init__(self):
        super().__init__(name="sbf_trace")

    async def before_model_callback(self, *, callback_context, llm_request):
        run = scopes.find(callback_context.session.id, callback_context.agent_name)
        if run is not None:
            run.model_started = time.monotonic()
            run.llm_calls += 1
            if run.user_facing and run.node.id not in run.turn.active_nodes:
                run.turn.active_nodes.append(run.node.id)
        return None

    async def after_model_callback(self, *, callback_context, llm_response):
        run = scopes.find(callback_context.session.id, callback_context.agent_name)
        if run is None or llm_response.partial:
            return None
        started, run.model_started = run.model_started, None
        usage = llm_response.usage_metadata
        stats = {
            "seconds": round(time.monotonic() - started, 1) if started else None,
            "prompt_tokens": getattr(usage, "prompt_token_count", None),
            "output_tokens": getattr(usage, "candidates_token_count", None),
            "thinking_tokens": getattr(usage, "thoughts_token_count", None),
            "model": describe(run.node.model_spec),
        }
        # A response cut off by the output cap loses its tool-call arguments
        # (LiteLLM dispatches the truncated JSON as {}); tools flag it.
        run.truncated = llm_response.finish_reason == types.FinishReason.MAX_TOKENS
        if run.truncated:
            stats["truncated"] = True
        if llm_response.error_code:
            stats["error"] = clip(f"{llm_response.error_code}: {llm_response.error_message}", 300)
        run.trace("llm_call", stats)

        run.last_response_empty = True
        if not llm_response.content:
            return None
        calls = []
        for part in llm_response.content.parts or []:
            fc = part.function_call
            if fc is None:
                continue
            # gpt-oss (harmony) can leak channel tokens into function names,
            # e.g. "search_resources<|channel|>commentary".
            if fc.name and "<|" in fc.name:
                fc.name = fc.name.split("<|", 1)[0].strip()
            calls.append({"name": fc.name, "arguments": fc.args or {}})
        run.tools_in_response = calls
        text = _visible_text(llm_response.content)
        thinking = "\n".join(p.text for p in llm_response.content.parts or []
                             if p.text and p.thought).strip()
        run.last_response_empty = not (calls or text)
        if text:
            run.last_text = text
        if text or thinking:
            run.trace("llm_output", {"text": clip(text), "thinking": clip(thinking, 400)},
                      persist={"text": text, "thinking": thinking})
        return None

    async def before_tool_callback(self, *, tool, tool_args, tool_context):
        run = scopes.find(tool_context.session.id, tool_context.agent_name)
        if run is not None:
            run.trace("tool_call", {"name": tool.name, "args": clip(tool_args, 400)},
                      persist={"name": tool.name, "args": tool_args})
        return None

    async def after_tool_callback(self, *, tool, tool_args, tool_context, result):
        run = scopes.find(tool_context.session.id, tool_context.agent_name)
        if run is None:
            return None
        run.trace("tool_result", {"name": tool.name, "result": clip(result)},
                  persist={"name": tool.name, "result": result})
        if tool.name == "transfer_to_agent":
            target = (tool_args or {}).get("agent_name")
            run.turn.emit_output("handoff", run.node.id, {"from": run.node.id, "to": target})
        return None


def make_runner(agent: LlmAgent, session_service, app_name: str) -> Runner:
    app = App(name=app_name, root_agent=agent, plugins=[TracePlugin()])
    return Runner(app=app, session_service=session_service)


async def run_until_done(runner: Runner, *, user_id: str, session_id: str, text: str,
                         max_llm_calls: int, state_delta: dict | None = None,
                         custom_metadata: dict | None = None) -> None:
    """Drive one invocation to completion, treating the call cap as an end."""
    message = types.Content(role="user", parts=[types.Part(text=text)])
    config = RunConfig(max_llm_calls=max_llm_calls,
                       **({"custom_metadata": custom_metadata} if custom_metadata else {}))
    try:
        async for _ in runner.run_async(user_id=user_id, session_id=session_id,
                                        new_message=message, state_delta=state_delta,
                                        run_config=config):
            pass
    except LlmCallsLimitExceededError as exc:
        log.warning("%s: %s", session_id, exc)
