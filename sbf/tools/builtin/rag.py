"""
RAG tools: an agent searches a retriever and reads items in full.

Results are registered as the run's resources under their item ids
(``<dataset>:<item>``), so delivery tools (``provide_file``,
``open_course_page``), research contracts (``return_summary``) and memory
(``record_memories``) accept them like library resources.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from ...data import DatasetStore
from ...data.extract import render_fields
from ...knowledge import add_dataset_items
from ...rag import RetrievalRequest, parse_item_key, run_retriever
from ...workspace import NotFound, workspace
from .. import Tool, ToolContext, register


class RagSearchConfig(BaseModel):
    retriever: str = Field("", description="Retriever to search")
    budget: int | None = Field(None, description="Characters of results (default: the retriever's)")
    scope_state_key: str = Field(
        "", description="Search only the dataset named in this session state key (e.g. library)")


@register
class RagSearch(Tool):
    id = "rag_search"
    category = "knowledge"
    requires = ("retriever",)
    summary = "Search a retriever (one or more datasets): passages, JSON or a brief."
    description = (
        "Search the document library for material on what you need. Returns relevant material "
        "with the id of each document it comes from (e.g. 'handbook:12'); use those ids to read "
        "a document in full or to cite it.")
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string",
                      "description": "What you need to find, as a question or a few keywords."},
            "queries": {"type": "array", "items": {"type": "string"},
                        "description": "Optional extra search queries covering other angles."},
        },
        "required": ["query"],
    }
    Config = RagSearchConfig

    def _definition(self):
        try:
            return workspace.retrievers.get(self.config.retriever)
        except NotFound:
            return None

    def model_description(self) -> str:
        if self.binding.description:
            return self.binding.description
        defn = self._definition()
        about = f" The library: {defn.description.strip()}" if defn and defn.description.strip() else ""
        return self.description + about

    def retrievers(self) -> list[str]:
        return [self.config.retriever]

    async def run(self, args: dict, ctx: ToolContext):
        query = str(args.get("query") or "").strip()
        extra = [str(q).strip() for q in args.get("queries") or [] if str(q).strip()]
        if not query and not extra:
            return "ERROR: Missing 'query' in rag_search."
        defn = ctx.system.retrievers.get(self.config.retriever) or self._definition()
        if defn is None:
            return f"ERROR: Retriever {self.config.retriever!r} does not exist."
        scope = None
        if self.config.scope_state_key:
            value = ctx.state.get(self.config.scope_state_key)
            if not value:
                return (f"ERROR: No library is active ({self.config.scope_state_key} is not set), so "
                        "there is nothing to search yet.")
            scope = [str(value)]
        req = RetrievalRequest(queries=[q for q in [query, *extra] if q], question=query or extra[0],
                               conversation=ctx.turn.conversation, budget=self.config.budget, datasets=scope)
        result = await run_retriever(defn, req)
        keys = [p.item_key for p in result.pack.items()]
        add_dataset_items(ctx.resources, keys)
        meta = result.pack.meta
        ctx.trace("retrieval", {
            "retriever": defn.id, "query": query, "selected": meta.get("selected"), "chars": len(result.text),
            "ms": (meta.get("ms") or {}).get("total"), "llm_calls": meta.get("llm_calls"),
            "cost": meta.get("cost")},
            persist={"queries": meta.get("queries"), "items": keys, "text": result.text})
        return result.text or "Nothing relevant was found in the library for this query."


class RagReadConfig(BaseModel):
    max_chars: int = Field(20000, ge=500, description="Characters of document text returned at most")


@register
class RagRead(Tool):
    id = "rag_read"
    category = "knowledge"
    summary = "Read one dataset item in full (fields and text) by its id."
    description = (
        "Read a document from the library in full: its extracted details and its complete text. Use "
        "the exact id rag_search gave you (e.g. 'handbook:12').")
    parameters = {
        "type": "object",
        "properties": {"id": {"type": "string", "description": "The document id, e.g. 'handbook:12'."}},
        "required": ["id"],
    }
    Config = RagReadConfig

    async def run(self, args: dict, ctx: ToolContext):
        key = str(args.get("id") or "").strip()
        parsed = parse_item_key(key)
        if parsed is None:
            return f"ERROR: {key!r} is not a document id; use an id like 'handbook:12' from rag_search."
        dataset, item_id = parsed
        if not workspace.datasets.exists(dataset) or not DatasetStore(dataset).exists:
            return f"ERROR: There is no library named {dataset!r}."
        item = DatasetStore(dataset).get_item(item_id)
        if item is None:
            return f"ERROR: Document {key} does not exist."
        add_dataset_items(ctx.resources, [f"{dataset}:{item_id}"])
        text = item["text"]
        cap = self.config.max_chars
        if len(text) > cap:
            text = text[:cap] + f"\n[... truncated: {len(item['text']) - cap} more characters ...]"
        fields = render_fields(item["fields"])
        parts = [f"Title: {item['title']}", f"Id: {dataset}:{item_id}"]
        if item["source_type"]:
            parts.append(f"Type: {item['source_type']}")
        if fields:
            parts.append(f"Details:\n{fields}")
        parts.append(f"Text:\n{text}" if text else "Text: (none)")
        return "\n".join(parts)
