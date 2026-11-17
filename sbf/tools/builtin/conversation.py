"""Conversation control: messages to the user, ending the turn, switching modes."""

from __future__ import annotations

from pydantic import BaseModel, Field

from .. import Tool, ToolContext, register


@register
class SendMessage(Tool):
    id = "send_message"
    category = "conversation"
    summary = "Send a markdown message to the user."
    description = (
        "Responds to the user with a message. This should be used to provide information to the "
        "user, or to ask them a question. This should be used as often as possible to keep the "
        "user informed and engaged. Supports markdown formatting. Send each distinct message "
        "exactly once — resending the same or a near-identical message is suppressed.")
    parameters = {
        "type": "object",
        "properties": {"message": {"type": "string",
                                   "description": "The message to send to the user. Supports markdown formatting."}},
        "required": ["message"],
    }

    async def run(self, args: dict, ctx: ToolContext):
        if "message" not in args:
            return "ERROR: Missing 'message' argument in send_message command"
        if not ctx.user_facing:
            return "ERROR: this agent does not talk to the user directly."
        error = await ctx.deliver(args["message"])
        if error:
            return error
        return ("Message delivered to the user. Do not send this message (or a rephrasing of it) "
                "again. When there is nothing left to do this turn, call finish_turn.")


@register
class FinishTurn(Tool):
    id = "finish_turn"
    category = "conversation"
    summary = "End the turn and hand control back to the user."
    description = (
        "Ends the current turn and hands control back to the user. It MAY be called in the same "
        "response as send_message — the message is delivered first, then the turn ends. It must "
        "NOT be combined with any other tool: make those calls, read their results, and only "
        "then — when nothing is left to do — finish the turn.")

    async def run(self, args: dict, ctx: ToolContext):
        # Every other tool returns information that should be read before
        # deciding the turn is over; send_message is exempt because forcing
        # an extra round trip makes small models replay their message.
        siblings = sorted({t.get("name", "?") for t in ctx.run.tools_in_response
                           if t.get("name") not in (self.name, "send_message")})
        if siblings:
            return ("ERROR: finish_turn cannot be called alongside other tools (except "
                    f"send_message). This response also contained: {', '.join(siblings)}. Wait "
                    "for those tools' results, decide what (if anything) still needs to happen, "
                    "then call finish_turn.")
        turn = ctx.turn
        # A delivered file or course page counts as responding, but the user
        # still needs words: what it is and why they got it.
        if turn.has_responded and not turn.sent_messages:
            return ("ERROR: you delivered a file or course page but never sent a message. Call "
                    "send_message to tell the user what it is and why, then call finish_turn.")
        if turn.has_responded:
            ctx.end_turn()
            return "Message(s) sent to user. Waiting for reply."
        return ("ERROR: Must respond to user at least once. Make sure to send your message BEFORE "
                "calling the finish turn function. The user cannot see this error.")


class SwitchModeConfig(BaseModel):
    reset_resources: bool = Field(True, description="Forget resources retrieved before the switch "
                                  "(they belong to the previous mode's library)")
    target_description: str = Field(
        "The mode to switch to. Use 'router' if you need to ask the user which topic fits best. "
        "Otherwise pick the most relevant content topic.",
        description="Description of the target_mode argument")


@register
class SwitchMode(Tool):
    id = "switch_mode"
    category = "conversation"
    requires = ("modes",)
    summary = "Switch the node to another of its modes (prompt + state, e.g. the active library)."
    description = (
        "Switch the chatbot to a different topic mode. Each mode has its own focus area, prompt, "
        "and resource library. Switching rebuilds the search context to point at the new topic's "
        "library and updates how you should approach the conversation. Call this when the user's "
        "needs no longer fit the current topic. After calling, briefly acknowledge the switch to "
        "the user, then continue helping them in the new mode.")
    Config = SwitchModeConfig

    def model_parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "target_mode": {"type": "string", "enum": list(self.node.modes),
                                "description": self.config.target_description},
                "reason": {"type": "string",
                           "description": "Brief reason for the switch (1 sentence). Used for "
                                          "logging and to seed your acknowledgement to the user."},
            },
            "required": ["target_mode"],
        }

    async def run(self, args: dict, ctx: ToolContext):
        target = args.get("target_mode")
        if not target:
            return "ERROR: Missing 'target_mode' argument."
        modes = ctx.node.modes
        if target not in modes:
            return f"ERROR: Unknown mode {target!r}. Valid modes: {', '.join(modes)}"
        mode = modes[target]
        current = dict(ctx.state.get("modes") or {})
        current[ctx.node.id] = target
        ctx.state["modes"] = current
        # Keys earlier modes set but this one doesn't are cleared, so e.g. the
        # router (no library) really has no library.
        for other in modes.values():
            for key in other.state:
                if key not in mode.state:
                    ctx.state[key] = None
        for key, value in mode.state.items():
            ctx.state[key] = value
        if self.config.reset_resources:
            ctx.resources.clear()
        ctx.emit("mode", {"mode": target, "label": mode.label or target})
        changes = ", ".join(f"{k}={v!r}" for k, v in mode.state.items())
        others = ", ".join(m for m in modes if m != target)
        return (f"Switched to mode '{target}' ({mode.label or target}). "
                + (f"State now: {changes}. " if changes else "")
                + f"Reason: {args.get('reason') or ''}. Other available modes: {others}.")
