"""
The simulated user: an LLM plays a persona in a scenario, one message at a
time (after BotBase's simulator and rag_lab's multi-turn stage).

The persona model sees the conversation with roles flipped (it is the
"assistant" of its own API call) and what the user would have seen of the
system's turn: its messages, plus a note for every file or page it showed.
It reveals the scenario's facts only when asked, never writes the
assistant's part, and ends the conversation with ``[END]`` once it has what
it came for.
"""

from __future__ import annotations

from ..llm import Completion, complete, resolve_spec
from ..schemas import ModelSpec, PersonaDef, ScenarioDef

END = "[END]"
NO_REPLY = "(no reply)"
NO_REPLY_SEEN = "[Nothing arrived from the assistant.]"

PROMPT = """You are role-playing a person chatting with an AI assistant. Stay fully in character for the whole conversation; never mention being an AI, a simulation or a test.

WHO YOU ARE
{profile}

YOUR SITUATION
{situation}{facts}

WHAT YOU WANT
{goal}

HOW TO WRITE
- {opening_rule}
- After that, write the way you would actually type in a chat: your vocabulary, tone, message length and quirks. Answer what the assistant asks; reveal the details of your situation only when asked or when it naturally fits, a little at a time.
- React to what the assistant actually says: follow up, push back, get confused, or ask for something concrete if it keeps asking questions without helping.
- Don't use jargon or name specific techniques unless the assistant brought them up first.
- You only ever write as yourself. Never write the assistant's part, continue its message or give yourself advice. If nothing arrived from the assistant, react the way someone would (for example, ask whether they're still there).
- When you have what you came for, or you would realistically stop replying, write a short closing message (or nothing) and end it with {end} on its own line.

Write only your next chat message."""


def _facts(scenario: ScenarioDef) -> str:
    if not scenario.facts:
        return ""
    lines = "\n".join(f"- {label}: {answer}" for label, answer in scenario.facts.items())
    return f"\n\nDetails you know (share them only when asked or when they fit):\n{lines}"


def system_prompt(persona: PersonaDef, scenario: ScenarioDef) -> str:
    if scenario.opening and scenario.opening_mode == "exact":
        opening = f'Your first message was: "{scenario.opening}"'
    elif scenario.opening:
        opening = f'Your first message is close to: "{scenario.opening}"'
    else:
        opening = "Open the chat in your own words, the way this person would."
    return PROMPT.format(profile=persona.profile.strip() or persona.name or "An ordinary person.",
                         situation=scenario.situation.strip() or scenario.description.strip()
                         or "(see your first message)",
                         facts=_facts(scenario), goal=scenario.goal.strip() or "Help with your situation.",
                         opening_rule=opening, end=END)


def persona_messages(persona: PersonaDef, scenario: ScenarioDef, transcript: list[dict]) -> list[dict]:
    messages = [{"role": "system", "content": system_prompt(persona, scenario)}]
    if not transcript:
        messages.append({"role": "user", "content": "(Open the chat with your first message.)"})
    for m in transcript:
        if m["role"] == "user":
            messages.append({"role": "assistant", "content": m["content"]})
        else:
            seen = NO_REPLY_SEEN if m["content"] == NO_REPLY else m["content"]
            messages.append({"role": "user", "content": seen})
    return messages


async def next_message(persona: PersonaDef, scenario: ScenarioDef, transcript: list[dict],
                       model: ModelSpec | None = None) -> tuple[str, bool, Completion | None]:
    """(message, ended, completion). The opening of an 'exact' scenario is
    sent as written, without a model call."""
    if not transcript and scenario.opening and scenario.opening_mode == "exact":
        return scenario.opening.strip(), False, None
    spec = resolve_spec(persona.model, model)
    # A person typing in a chat doesn't deliberate; a thinking model can
    # also spend its whole reply budget before writing anything.
    reasoning = None if (model and model.reasoning_effort) or persona.model.reasoning_effort else "none"
    out = await complete(spec, persona_messages(persona, scenario, transcript),
                         max_tokens=1200, reasoning=reasoning)
    text = out.text
    ended = END in text
    text = text.replace(END, "").strip().strip('"').strip()
    return text, ended, out


def assistant_view(outputs: list[dict]) -> str:
    """What the user saw of a system turn, as text."""
    parts = []
    for o in outputs:
        t = o.get("type")
        if t == "message" and (o.get("content") or "").strip():
            parts.append(o["content"].strip())
        elif t == "file":
            parts.append(f"[The assistant shared a file: {o.get('title') or o.get('source_file') or 'file'}"
                         f"{' — ' + o['note'] if o.get('note') else ''}]")
        elif t == "viewer":
            parts.append(f"[The assistant opened a page beside the chat: {o.get('title') or 'page'}"
                         f"{' — ' + o['note'] if o.get('note') else ''}]")
    return "\n\n".join(parts) or NO_REPLY
