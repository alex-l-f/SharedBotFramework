"""ADK session events → OpenAI-style messages (the raw, model-side view of a chat)."""

from __future__ import annotations

import json


def _response_content(response) -> str:
    # ADK wraps non-dict tool results as {"result": value}.
    if isinstance(response, dict) and set(response) == {"result"}:
        response = response["result"]
    if isinstance(response, str):
        return response
    return json.dumps(response, ensure_ascii=False, default=str)


def events_to_messages(events) -> list[dict]:
    messages: list[dict] = []
    for event in events:
        if not event.content or not event.content.parts:
            continue
        parts = event.content.parts
        meta = event.custom_metadata or {}
        if event.author == "user":
            text = "".join(p.text for p in parts if p.text)
            if text:
                messages.append({"role": "user", "content": text,
                                 **({"nudge": True} if meta.get("sbf_nudge") else {})})
            continue
        responses = [p.function_response for p in parts if p.function_response]
        if responses:
            for fr in responses:
                messages.append({"role": "tool", "agent": event.author, "tool_call_id": fr.id or "",
                                 "name": fr.name or "", "content": _response_content(fr.response)})
            continue
        message: dict = {"role": "assistant", "agent": event.author, "content": None}
        text = "".join(p.text for p in parts if p.text and not p.thought)
        reasoning = "".join(p.text for p in parts if p.text and p.thought)
        if text:
            message["content"] = text
        if reasoning:
            message["reasoning"] = reasoning
        calls = [p.function_call for p in parts if p.function_call]
        if calls:
            message["tool_calls"] = [{"id": fc.id or "", "type": "function", "function": {
                "name": fc.name or "", "arguments": json.dumps(fc.args or {}, ensure_ascii=False)}}
                for fc in calls]
        if message["content"] is not None or calls or reasoning:
            messages.append(message)
    return messages
