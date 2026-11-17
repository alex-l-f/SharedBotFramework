"""Generic structured-output contract for delegate/observer agents."""

from __future__ import annotations

import json

from pydantic import BaseModel, Field

from .. import Tool, ToolContext, register


class ReturnResultConfig(BaseModel):
    result_schema: dict = Field(
        default_factory=lambda: {"type": "object",
                                 "properties": {"result": {"type": "string",
                                                           "description": "Your complete answer."}},
                                 "required": ["result"]},
        description="JSON schema of the result object the agent must return")


@register
class ReturnResult(Tool):
    id = "return_result"
    category = "results"
    terminal = True
    summary = "Finish the run with a structured result (schema set per binding)."
    description = ("Finish your task and return your result to the agent that asked for it. "
                   "REQUIRED final step — nothing you write outside this call is returned.")
    Config = ReturnResultConfig

    def model_parameters(self) -> dict:
        return self.config.result_schema

    async def run(self, args: dict, ctx: ToolContext):
        missing = [k for k in self.config.result_schema.get("required", [])
                   if args.get(k) in (None, "", [])]
        if missing:
            return f"ERROR: missing required field(s) {json.dumps(missing)}; call {self.name} again."
        ctx.finish(dict(args))
        return "Result accepted. Run complete."
