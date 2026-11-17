"""Template-memory tools: recall (memory_search) and extraction (record_memories)."""

from __future__ import annotations

import json

from pydantic import BaseModel, Field

from ...memory import memory_store, prompt_lines, slot_union_properties, validate_note
from .. import Tool, ToolContext, register


@register
class MemorySearch(Tool):
    id = "memory_search"
    category = "memory"
    requires = ("memory",)
    summary = "Keyword search over the active profile's past-session memory notes."
    description = (
        "Keyword search over the structured memory notes from this user's past sessions (skills "
        "practised, resources shared, assessments taken, upcoming events, follow-ups). Use it when "
        "the user refers to something from before, or when their history would materially improve "
        "your coaching. Notes are anonymized templates with timestamps — evidence that something "
        "happened, never a transcript. Finding nothing is a normal outcome.")
    parameters = {
        "type": "object",
        "properties": {"query": {"type": "string",
                                 "description": "Keywords to look for (e.g. 'breathing practice', "
                                                "'burnout assessment'). Plain words work best."}},
        "required": ["query"],
    }

    async def run(self, args: dict, ctx: ToolContext):
        query = (args.get("query") or "").strip()
        if not query:
            return "ERROR: Missing 'query' argument in memory_search."
        if not ctx.system.memory_enabled:
            return "ERROR: Memory is not available in this deployment."
        if not ctx.profile:
            return ("No user profile is active in this session, so there is no past-session "
                    "memory to search.")
        # The live chat is excluded: its content is already in context.
        hits = memory_store.search(ctx.system.memory_namespace, ctx.profile["id"], query,
                                   limit=5, exclude_chat=ctx.chat_id)
        ctx.trace("search", {"query": query, "hits": len(hits)},
                  persist={"results": hits}, agent="memory")
        if not hits:
            return "No matching notes in this user's past-session memory. That is a normal outcome — do not invent a memory."
        return {"hits": hits}


class RecordMemoriesConfig(BaseModel):
    max_notes: int = Field(0, description="Most notes accepted per call (0 = no limit)")


@register
class RecordMemories(Tool):
    id = "record_memories"
    category = "memory"
    terminal = True
    requires = ("memory",)
    summary = "Memory agent's output contract: anonymous template notes (written to the store)."
    description = (
        "Record the durable, anonymous memory notes from this session. REQUIRED final step of "
        "every run — nothing you write outside this call is kept. Pass an empty list when nothing "
        "new is worth remembering (a normal outcome).")
    Config = RecordMemoriesConfig

    def model_description(self) -> str:
        base = self.binding.description or self.description
        schema = self.system.memory_schema if self.system else None
        if schema is None:
            return base
        return base + "\n\nAvailable templates:\n" + "\n".join(prompt_lines(schema))

    def model_parameters(self) -> dict:
        schema = self.system.memory_schema if self.system else None
        item = {"type": "object", "properties": {"template": {"type": "string"}}, "required": ["template"]}
        if schema is not None:
            item["properties"] = {"template": {"type": "string", "enum": list(schema.templates)},
                                  **slot_union_properties(schema)}
        return {
            "type": "object",
            "properties": {"memories": {"type": "array", "items": item,
                                        "description": "New memory notes, one per template instance. "
                                                       "Do not repeat notes that already exist."}},
            "required": ["memories"],
        }

    async def run(self, args: dict, ctx: ToolContext):
        entries = args.get("memories")
        if not isinstance(entries, list):
            return "ERROR: record_memories requires a 'memories' array."
        schema = ctx.system.memory_schema
        if schema is None or not ctx.system.memory_enabled:
            return "ERROR: memory is not enabled for this system."
        if self.config.max_notes and len(entries) > self.config.max_notes:
            return f"ERROR: at most {self.config.max_notes} notes per call; keep only the most important."
        records, problems = [], []
        for i, entry in enumerate(entries):
            if not isinstance(entry, dict):
                problems.append(f"entry {i}: not an object")
                continue
            template = entry.get("template")
            slots = {k: v for k, v in entry.items() if k != "template" and v not in (None, "")}
            if slots.get("resource") is not None:
                res = ctx.resources.get(str(slots["resource"]))
                if res is None:
                    problems.append(f"entry {i} ({template}): resource {slots['resource']!r} was not "
                                    "retrieved this session — cite only ids from the session summary")
                    continue
                slots.update(resource=res.get("oid"), provider=res.get("library"),
                             title=res.get("title", ""))
            clean, errors = validate_note(schema, template, slots)
            if errors:
                problems.append(f"entry {i} ({template}): " + "; ".join(errors))
                continue
            records.append({"template": template, "slots": clean})
        if problems:
            return ("ERROR: some entries were rejected — fix them and call record_memories again "
                    "with the full corrected list:\n" + json.dumps(problems, ensure_ascii=False))
        stored = []
        if records and ctx.profile:
            stored = memory_store.add_notes(ctx.system.memory_namespace, schema, ctx.profile["id"],
                                            ctx.chat_id, records)
        ctx.trace("write", {"rows": len(stored), "profile": (ctx.profile or {}).get("id")},
                  persist={"stored": stored}, agent="memory")
        ctx.finish({"recorded": len(stored), "notes": [s["rendered"] for s in stored]})
        return f"Recorded {len(records)} memory note(s). Run complete."

    @classmethod
    def fallback_result(cls, run):
        return {"recorded": 0, "notes": [], "complete": False}
