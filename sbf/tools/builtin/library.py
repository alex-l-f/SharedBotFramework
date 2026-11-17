"""
Library tools: search, read, and deliver resources from a knowledge library.

The active library is fixed in a binding's config or, by default, read from
session state (``library``), which modes set — so one agent can serve
several topic libraries. ``backend`` picks where libraries come from
(BotBase's embedding service or this framework's datasets); delivery tools
also accept dataset item ids from ``rag_search`` (``<dataset>:<item>``).
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from ...knowledge import get_knowledge, parse_public_id
from ...settings import get_settings
from .. import Tool, ToolContext, register

NO_LIBRARY = ("ERROR: No topic library is active. Use switch_mode to select a topic before "
              "searching for resources.")


class LibraryConfig(BaseModel):
    library: str = Field("", description="Fixed library id; empty = read it from session state")
    library_state_key: str = Field("library", description="State key holding the active library")
    backend: Literal["", "embedding_service", "datasets"] = Field(
        "", description="Where libraries come from (empty = the settings default)")


def active_library(config: LibraryConfig, ctx: ToolContext) -> str | None:
    return config.library or ctx.state.get(config.library_state_key) or None


def lookup_resource(ctx: ToolContext, config: LibraryConfig, resource_id: str) -> dict | None:
    """A resource retrieved this run, or a direct lookup in the active library."""
    item = ctx.resources.get(resource_id)
    if item is not None:
        return item
    from ...rag import parse_item_key
    key = parse_item_key(resource_id) if not str(resource_id).startswith("RES_") else None
    if key is not None:
        item = get_knowledge("datasets").get(*key)
        if item is not None:
            item["id"] = resource_id
            item["explanation"] = "Retrieved directly from the dataset."
            ctx.resources.add(item)
        return item
    oid = parse_public_id(resource_id)
    library = active_library(config, ctx)
    if oid is None or not library:
        return None
    item = get_knowledge(config.backend or None).get(library, oid)
    if item is not None:
        item["explanation"] = "Retrieved directly from database."
        ctx.resources.add(item)
    return item


class SearchConfig(LibraryConfig):
    k: int = Field(10, ge=1, le=50, description="Results per search")
    description_chars: int = Field(100, description="Description characters shown per hit")


@register
class SearchResources(Tool):
    id = "search_resources"
    category = "knowledge"
    requires = ("knowledge",)
    summary = "Hybrid search over the active resource library."
    description = (
        "Search the resource collection for helpful documents. If used multiple times, will avoid "
        "returning resources already acquired to allow for new resources to be discovered.")
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string",
                      "description": "The query, or queries, to search the resource portal with, in "
                                     "addition to the collected user details. Should be a comma "
                                     "separated list of queries."},
            "language": {"type": "string",
                         "description": "The language the retrieved resources should be in. Should "
                                        "match the language of the conversation, unless otherwise "
                                        "specified, or there is a lack of target language resources. "
                                        "Also supports 'all' to search all resources, regardless of "
                                        "language."},
        },
        "required": ["query"],
    }
    Config = SearchConfig

    async def run(self, args: dict, ctx: ToolContext):
        if "query" not in args:
            return "ERROR: Missing 'query' in search_resources"
        library = active_library(self.config, ctx)
        if not library:
            return NO_LIBRARY
        queries = [q for q in str(args["query"]).split(",") if q.strip()]
        backend = get_knowledge(self.config.backend or None)
        scores = await backend.search(library, queries, k=self.config.k,
                                      language=args.get("language", "all"))
        known = ctx.resources.ids()
        found = []
        for oid, score in scores.items():
            item = backend.get(library, oid)
            if not item or item["id"] in known:
                continue
            item["explanation"] = f"Selected with relevance score: {score:.3f}"
            ctx.resources.add(item)
            found.append(item)
        summary = (f"Searched database {library} for: {queries[0] if queries else ''}\n"
                   f"Found {len(found)} relevant resources")
        n = self.config.description_chars
        return {
            "resources": [{
                "id": r["id"], "title": r.get("title", ""),
                "description": (r.get("description") or "")[:n] + "...",
                "physical_address": r.get("physical_address", ""),
                # 'course_page' resources open with open_course_page;
                # everything else is a file for provide_file.
                "source_type": r.get("source_type") or "",
            } for r in found],
            "search_summary": summary,
        }


@register
class ExamineResource(Tool):
    id = "examine_resource"
    category = "knowledge"
    requires = ("knowledge",)
    summary = "Full record of one resource (incl. its transcript)."
    description = (
        "Returns all information about a selected resource. Use this tool to help provide more "
        "information about a resource if the user requests it, or if you think it might help you "
        "answer a user's query. This takes some time to complete, so use it only as necessary.")
    parameters = {
        "type": "object",
        "properties": {"resource_id": {"type": "string",
                                       "description": "The exact ID of the resource you want more information on."}},
        "required": ["resource_id"],
    }
    Config = LibraryConfig

    async def run(self, args: dict, ctx: ToolContext):
        if "resource_id" not in args:
            return "ERROR: Missing 'resource_id' in examine_resource"
        rid = args["resource_id"]
        item = lookup_resource(ctx, self.config, rid)
        if item is None:
            return f"ERROR: Resource with ID {rid} not found"
        return "\n".join(f"{k}: {v}" for k, v in item.items() if k not in ("url",))


class DeliveryConfig(LibraryConfig):
    unserved_types: list[str] = Field(
        default_factory=lambda: ["pdf"],
        description="Source types never sent to the user; their content must be read and relayed")
    research_tool: str = Field(
        "examine_resource",
        description="Tool the agent should use to read an unserved document "
                    "(e.g. ask_library when research is delegated)")


def _not_found(resource_id: str, config: DeliveryConfig, ctx: ToolContext) -> str:
    source = "search_resources" if config.research_tool == "examine_resource" else config.research_tool
    library = active_library(config, ctx)
    where = f"the active topic library ({library})" if library else "any active topic library"
    return (f"ERROR: Resource {resource_id} does not exist in {where}, so nothing was shown to the "
            f"user. Use only ids that {source} returned for this topic.")


def _unavailable(kind: str, resource_id: str, item: dict, problem: str) -> str:
    title = item.get("title") or resource_id
    return (f"ERROR: {kind} {resource_id} ('{title}') can't be shown: {problem}. Nothing was shown "
            "to the user, so don't refer to it as on screen (briefly correct yourself if you "
            "already introduced it) and continue without it.")


def _unserved(resource_id: str, item: dict, config: DeliveryConfig) -> str:
    source_type = (item.get("source_type") or "").lower()
    title = item.get("title") or resource_id
    if config.research_tool == "examine_resource":
        how = (f"call examine_resource on {resource_id}, read its full_transcript, and explain the "
               "content in your own words.")
    else:
        how = (f"call {config.research_tool} with a question that names it (e.g. \"What does "
               f"'{title}' say about ...?\"). The library summarizer reads its transcript and "
               "returns a summary for you to relay in your own words.")
    return (f"ERROR: {source_type.upper()} documents are not sent to the user, so '{title}' was "
            f"NOT delivered. Instead, {how}")


@register
class ProvideFile(Tool):
    id = "provide_file"
    category = "knowledge"
    requires = ("knowledge",)
    summary = "Send a resource file to the user (player / download card)."
    description = (
        "Send a specific resource file directly to the user. The frontend will embed a "
        "video/audio player or render a download link as appropriate for the file type. Use this "
        "when the user has agreed they want the file, or when the most helpful response is to "
        "hand them the source material (a guided practice audio or walkthrough video). PDF "
        "documents are never sent: their content is read and summarized for the user instead. "
        "Always send a brief send_message FIRST introducing the file, then call provide_file.")
    parameters = {
        "type": "object",
        "properties": {
            "resource_id": {"type": "string",
                            "description": "Exact resource ID, e.g. 'RES_00012'. Get this from a "
                                           "previous search_resources call."},
            "note": {"type": "string",
                     "description": "Optional 1-line note shown alongside the file (e.g. 'A "
                                    "10-minute guided breathing practice')."},
        },
        "required": ["resource_id"],
    }
    Config = DeliveryConfig

    async def run(self, args: dict, ctx: ToolContext):
        rid = args.get("resource_id")
        if not rid:
            return "ERROR: Missing 'resource_id' argument."
        item = lookup_resource(ctx, self.config, rid)
        if item is None:
            return _not_found(rid, self.config, ctx)
        source_type = (item.get("source_type") or "").lower()
        if source_type == "course_page":
            return (f"ERROR: Resource {rid} is an e-learning course page, not a file. Use "
                    "open_course_page to show it to the user.")
        if source_type in self.config.unserved_types:
            return _unserved(rid, item, self.config)
        if not item.get("source_path"):
            return _unavailable("File", rid, item, "it has no file on the server")
        backend = get_knowledge(item.get("backend") or self.config.backend or None)
        if backend.file_path(item["library"], item["oid"]) is None:
            return _unavailable("File", rid, item, "its file is missing on the server")
        payload = {
            "resource_id": rid, "title": item.get("title", ""), "source_type": item.get("source_type") or "",
            "source_file": item.get("source_file") or "", "url": item["url"],
            "mime": mimetypes.guess_type(item.get("source_file") or item.get("source_path") or "")[0],
            "note": args.get("note") or "", "summary": (item.get("description") or "")[:240],
        }
        ctx.emit("file", payload)
        ctx.turn.has_responded = True
        return f"Sent file '{payload['title'] or rid}' ({payload['source_type']}) to user. URL: {payload['url']}"


# ------------------------------------------------------------- course pages

_COURSE_URL = re.compile(r"^/?scorm/([^/]+)/scormcontent/index\.html#/lessons/([^/?#]+)$")


@lru_cache(maxsize=16)
def _rise_lesson_ids(index_path: str, mtime: float) -> frozenset[str] | None:
    """Lesson ids in the Rise course JSON embedded in scormcontent/index.html."""
    try:
        text = Path(index_path).read_text(encoding="utf-8")
        m = re.search(r'deserialize\("([^"]+)"\)', text)
        if not m:
            return None
        course = json.loads(base64.b64decode(m.group(1))).get("course") or {}
    except (OSError, ValueError):
        return None
    return frozenset(lesson["id"] for lesson in course.get("lessons", [])
                     if lesson.get("type") != "section" and lesson.get("id"))


def course_page_problem(url: str, scorm_root: str) -> str | None:
    """Why *url* would not open its lesson in the viewer, or None if it would."""
    m = _COURSE_URL.match(url or "")
    if not m:
        return "its link is not a course-viewer link"
    package, lesson_id = m.groups()
    pkg_dir = Path(scorm_root or ".") / package
    if not (pkg_dir / "imsmanifest.xml").is_file():
        return f"its e-learning package ({package}) is not installed"
    index = pkg_dir / "scormcontent" / "index.html"
    try:
        ids = _rise_lesson_ids(str(index), os.path.getmtime(index))
    except OSError:
        ids = None
    if ids is None:
        return "its e-learning package could not be read"
    if lesson_id not in ids:
        return "its lesson no longer exists in the e-learning course"
    return None


@register
class OpenCoursePage(Tool):
    id = "open_course_page"
    category = "knowledge"
    requires = ("knowledge",)
    summary = "Open an e-learning (SCORM/Rise) lesson in the viewer beside the chat."
    description = (
        "Open a page from the e-learning course in the user's content viewer, right beside the "
        "chat. Use this for resources with source_type 'course_page' — interactive lessons from "
        "the online course (text, videos, practice activities). Use it when a course page is the "
        "best way to teach or practise what the user is asking about, or when they ask to see the "
        "course material. Always send a brief send_message FIRST introducing the page, then call "
        "open_course_page.")
    parameters = {
        "type": "object",
        "properties": {
            "resource_id": {"type": "string",
                            "description": "Exact resource ID, e.g. 'RES_00042'. Get this from a "
                                           "previous search_resources call. The resource must be a "
                                           "course page."},
            "note": {"type": "string",
                     "description": "Optional 1-line note shown alongside the page (e.g. 'A short "
                                    "practice activity for identifying your stressors')."},
        },
        "required": ["resource_id"],
    }
    Config = DeliveryConfig

    async def run(self, args: dict, ctx: ToolContext):
        rid = args.get("resource_id")
        if not rid:
            return "ERROR: Missing 'resource_id' argument."
        item = lookup_resource(ctx, self.config, rid)
        if item is None:
            return _not_found(rid, self.config, ctx)
        source_type = (item.get("source_type") or "").lower()
        if source_type != "course_page":
            if source_type in self.config.unserved_types:
                return _unserved(rid, item, self.config)
            return (f"ERROR: Resource {rid} is a '{item.get('source_type') or 'file'}' resource, "
                    "not a course page. Use provide_file to send files.")
        # Checked before anything reaches the frontend: the viewer opens the
        # moment the output arrives, so a dead link would greet the user.
        problem = course_page_problem(item["url"], get_settings().scorm_root)
        if problem:
            return _unavailable("Course page", rid, item, problem)
        payload = {
            "resource_id": rid, "lesson_id": item.get("lesson_id") or "", "title": item.get("title", ""),
            "section": item.get("physical_address") or "", "url": item["url"],
            "note": args.get("note") or "", "summary": (item.get("description") or "")[:240],
        }
        ctx.emit("viewer", payload)
        ctx.turn.has_responded = True
        return f"Opened course page '{payload['title'] or rid}' in the user's viewer. Section: {payload['section']}."


# ------------------------------------------------------------ summary contract

_CONFIDENCE = ("high", "medium", "low")


class ReturnSummaryConfig(BaseModel):
    max_resources: int = 4
    max_key_points: int = 6
    unserved_types: list[str] = Field(default_factory=lambda: ["pdf"],
                                      description="Cited resources of these types are flagged deliverable: false")


@register
class ReturnSummary(Tool):
    id = "return_summary"
    category = "knowledge"
    terminal = True
    summary = "Research agent's output contract: answer, key points, cited resources, confidence."
    description = (
        "Finish the research run and hand your findings back to the coach. REQUIRED final step of "
        "every run — nothing you write outside this call reaches the coach. Cite only resource ids "
        "you actually retrieved in this run.")
    parameters = {
        "type": "object",
        "properties": {
            "answer": {"type": "string",
                       "description": "2-6 sentences (at most ~120 words) directly answering the "
                                      "coach's question. Quote canonical program definitions "
                                      "verbatim where they matter."},
            "key_points": {"type": "array", "items": {"type": "string"},
                           "description": "Up to 6 short bullets (20 words each at most) the coach can use directly."},
            "resources": {
                "type": "array",
                "items": {"type": "object", "properties": {
                    "id": {"type": "string"}, "title": {"type": "string"},
                    "source_type": {"type": "string"}, "why_relevant": {"type": "string"}},
                    "required": ["id"]},
                "description": "At most 4 resources worth delivering to the user, by exact id from "
                               "your own search results (e.g. 'RES_00012'). Never invent an id. "
                               "Keep why_relevant to one short line."},
            "confidence": {"type": "string", "enum": list(_CONFIDENCE),
                           "description": "high: the library clearly answers this. medium: partial "
                                          "coverage. low: the library doesn't really cover it."},
            "notes": {"type": "string",
                      "description": "Gaps, contradictions, or 'library does not cover X'. Honest "
                                     "emptiness beats padding."},
        },
        "required": ["answer", "confidence"],
    }
    Config = ReturnSummaryConfig

    async def run(self, args: dict, ctx: ToolContext):
        answer = (args.get("answer") or "").strip()
        if not answer:
            return "ERROR: return_summary requires a non-empty 'answer'."
        confidence = (args.get("confidence") or "").lower()
        if confidence not in _CONFIDENCE:
            confidence = "low"
        resources, unknown = [], []
        for r in args.get("resources") or []:
            if not isinstance(r, dict):
                continue
            known = ctx.resources.get(r.get("id"))
            if known is None:
                unknown.append(r.get("id"))
                continue
            # Trust the retrieved row over the model's recollection.
            source_type = known.get("source_type") or r.get("source_type") or ""
            resources.append({
                "id": r["id"], "title": r.get("title") or known.get("title", ""),
                "source_type": source_type, "why_relevant": r.get("why_relevant", ""),
                "deliverable": source_type.lower() not in self.config.unserved_types,
            })
        if unknown:
            return ("ERROR: return_summary cites resource ids that were not retrieved in this run: "
                    f"{json.dumps(unknown)}. Cite only ids from your own search_resources results, "
                    "then call return_summary again.")
        key_points = [str(p).strip() for p in args.get("key_points") or [] if str(p).strip()]
        # Over-long lists are trimmed rather than bounced: a rejection costs
        # another full generation.
        ctx.finish({
            "answer": answer,
            "key_points": key_points[:self.config.max_key_points],
            "resources": resources[:self.config.max_resources],
            "confidence": confidence,
            "notes": (args.get("notes") or "").strip(),
            "source": f"library:{ctx.state.get('library')}",
        })
        return "Summary accepted. Run complete."

    @classmethod
    def fallback_result(cls, run):
        return {"answer": run.last_text or "The summarizer did not produce an answer.",
                "key_points": [], "resources": [], "confidence": "low",
                "notes": "Summarizer run ended without a structured return_summary call; treat this "
                         "answer with caution."}
