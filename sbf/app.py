"""
FastAPI server: definition CRUD, chat runtime (SSE), memory browser,
knowledge files and static content, and the built web UI.

Every /api request passes ``auth.guard`` (sign-in and roles). Definition
writes take the version they were based on in an ``If-Match`` header and
answer 409 with the current definition when someone else saved since.

Run with ``python run.py`` (see README).
"""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, ValidationError

from . import __version__, auth, db
from .api_bundles import router as bundles_router
from .api_data import router as data_router
from .api_links import manage as links_router
from .api_links import public as public_router
from .api_links import sweep_unsaved
from .api_safety import router as safety_router
from .api_wizard import router as wizard_router
from .api_sim import router as sim_router
from .api_team import router as team_router
from .data import processor
from .sim import runner as sim_runner
from .knowledge import get_knowledge
from .memory import memory_store, registry_for_api, render_note
from .runtime import CompileError, compile_system, get_engine
from .runtime.history import events_to_messages
from .runtime.prompts import render_instruction
from .schemas import AgentDef, MemorySchema, SystemDef
from .settings import DATA_DIR, ROOT, WORKSPACE, Settings, get_settings, save_settings, settings_version
from .tools import catalog, discover
from .workspace import Conflict, NotFound, expected_version, workspace

log = logging.getLogger(__name__)

app = FastAPI(title="SharedBotFramework", version=__version__, dependencies=[Depends(auth.guard)])
api = APIRouter(prefix="/api")


class _PublicCacheControl:
    """Chat-link API answers are never reused by browsers (a link turned off
    and on again, a new message); delivered files may be, privately, briefly."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "") if scope["type"] == "http" else ""
        if not path.startswith("/api/public/"):
            return await self.inner(scope, receive, send)
        value = b"private, max-age=300" if "/r/" in path else b"no-store"

        async def send_with_header(message):
            if message["type"] == "http.response.start":
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != b"cache-control"]
                message = {**message, "headers": [*headers, (b"cache-control", value)]}
            await send(message)

        await self.inner(scope, receive, send_with_header)


app.add_middleware(_PublicCacheControl)


@app.exception_handler(NotFound)
async def _not_found(_, exc: NotFound):
    return JSONResponse({"detail": f"Not found: {exc.args[0] if exc.args else ''}"}, status_code=404)


@app.exception_handler(Conflict)
async def _conflict(_, exc: Conflict):
    return JSONResponse({"detail": str(exc), "conflict": exc.to_dict()}, status_code=409)


@app.exception_handler(CompileError)
async def _compile_error(_, exc: CompileError):
    return JSONResponse({"detail": "The system has problems", "problems": exc.problems}, status_code=422)


@app.exception_handler(ValueError)
async def _value_error(_, exc: ValueError):
    return JSONResponse({"detail": str(exc)}, status_code=400)


def _validation_detail(exc: ValidationError) -> list[str]:
    out = []
    for e in exc.errors():
        loc = ".".join(str(p) for p in e["loc"])
        msg = e["msg"].removeprefix("Value error, ")
        out.append(f"{loc}: {msg}" if loc else msg)
    return out


def _parse(model, data: dict):
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        raise HTTPException(422, detail=_validation_detail(exc)) from None


# --------------------------------------------------------------------- meta

@api.get("/meta")
def meta():
    return {"version": __version__, "workspace": str(WORKSPACE), "data": str(DATA_DIR),
            "auth": auth.auth_enabled(),
            "errors": {"agents": workspace.agents.errors(), "systems": workspace.systems.errors(),
                       "memory_schemas": workspace.memory_schemas.errors(),
                       "datasets": workspace.datasets.errors(), "retrievers": workspace.retrievers.errors(),
                       "personas": workspace.personas.errors(), "scenarios": workspace.scenarios.errors(),
                       "rubrics": workspace.rubrics.errors(), "classifiers": workspace.classifiers.errors()}}


@api.get("/tools")
def tools():
    return catalog()


@api.get("/settings")
def read_settings():
    return {**get_settings().model_dump(), "version": settings_version()}


@api.put("/settings")
def write_settings(data: dict, if_match: str | None = Header(None)):
    data.pop("version", None)
    settings = _parse(Settings, data)
    save_settings(settings, expected_version(if_match))
    return {**settings.model_dump(), "version": settings_version()}


# -------------------------------------------------------------------- agents

def _usage(agent_id: str) -> list[dict]:
    return [{"system": s.id, "name": s.name, "nodes": [n.id for n in s.nodes if n.agent == agent_id]}
            for s in workspace.systems.list() if any(n.agent == agent_id for n in s.nodes)]


@api.get("/agents")
def list_agents():
    return [{**a.model_dump(exclude={"prompt"}), "prompt_chars": len(a.prompt),
             "version": workspace.agents.version(a.id),
             "used_by": [u["system"] for u in _usage(a.id)]} for a in workspace.agents.list()]


def _body(data: dict, item_id: str | None = None) -> dict:
    """A definition from a request body, without the read-only fields."""
    data = {k: v for k, v in data.items() if k not in ("version", "used_by")}
    return {**data, "id": item_id} if item_id else data


@api.get("/agents/{agent_id}")
def get_agent(agent_id: str):
    agent = workspace.agents.get(agent_id)
    return {**workspace.agents.dump(agent), "used_by": _usage(agent_id)}


@api.post("/agents", status_code=201)
def create_agent(data: dict):
    agent = _parse(AgentDef, _body(data))
    if workspace.agents.exists(agent.id):
        raise HTTPException(409, f"Agent {agent.id!r} already exists")
    return workspace.agents.dump(workspace.agents.save(agent))


@api.put("/agents/{agent_id}")
def update_agent(agent_id: str, data: dict, if_match: str | None = Header(None)):
    agent = _parse(AgentDef, _body(data, agent_id))
    return workspace.agents.dump(workspace.agents.save(agent, expected_version(if_match)))


@api.delete("/agents/{agent_id}")
def delete_agent(agent_id: str, if_match: str | None = Header(None)):
    users = _usage(agent_id)
    if users:
        raise HTTPException(409, f"Agent is used by: {', '.join(u['system'] for u in users)}")
    workspace.agents.delete(agent_id, expected_version(if_match))
    return {"ok": True}


# ------------------------------------------------------------------- systems

@api.get("/systems")
def list_systems():
    out = []
    for s in workspace.systems.list():
        out.append({"id": s.id, "name": s.name, "description": s.description, "tags": s.tags,
                    "entry": s.entry, "nodes": [{"id": n.id, "agent": n.agent} for n in s.nodes],
                    "links": len(s.links), "updated_at": s.updated_at, "updated_by": s.updated_by,
                    "version": workspace.systems.version(s.id), "ui": s.ui.model_dump(),
                    "memory": s.memory.model_dump()})
    return out


@api.get("/systems/{system_id}")
def get_system(system_id: str):
    return workspace.systems.dump(workspace.systems.get(system_id))


@api.post("/systems", status_code=201)
def create_system(data: dict):
    system = _parse(SystemDef, _body(data))
    if workspace.systems.exists(system.id):
        raise HTTPException(409, f"System {system.id!r} already exists")
    return workspace.systems.dump(workspace.systems.save(system))


@api.put("/systems/{system_id}")
def update_system(system_id: str, data: dict, if_match: str | None = Header(None)):
    system = _parse(SystemDef, _body(data, system_id))
    return workspace.systems.dump(workspace.systems.save(system, expected_version(if_match)))


@api.delete("/systems/{system_id}")
def delete_system(system_id: str, if_match: str | None = Header(None)):
    workspace.systems.delete(system_id, expected_version(if_match))
    return {"ok": True}


class CopyBody(BaseModel):
    id: str
    name: str | None = None


@api.post("/systems/{system_id}/copy", status_code=201)
def copy_system(system_id: str, body: CopyBody):
    source = workspace.systems.get(system_id)
    if workspace.systems.exists(body.id):
        raise HTTPException(409, f"System {body.id!r} already exists")
    data = source.model_dump()
    data.update(id=body.id, name=body.name or f"{source.name or source.id} (copy)")
    return workspace.systems.dump(workspace.systems.save(_parse(SystemDef, data)))


def _draft_or_saved(system_id: str, draft: dict | None) -> SystemDef:
    if draft:
        return _parse(SystemDef, _body(draft, system_id))
    return workspace.systems.get(system_id)


class ValidateBody(BaseModel):
    draft: dict | None = None


@api.post("/systems/{system_id}/validate")
def validate_system(system_id: str, body: ValidateBody):
    system = _draft_or_saved(system_id, body.draft)
    try:
        compiled = compile_system(system)
        return {"ok": True, "problems": [], "warnings": compiled.warnings, "hash": compiled.hash,
                "user_facing": [n.id for n in compiled.nodes.values() if n.user_facing],
                "models": {nid: n.model_spec.model_dump(exclude_none=True)
                           for nid, n in compiled.nodes.items()}}
    except CompileError as exc:
        compiled = compile_system(system, strict=False)
        warnings = [w for w in compiled.warnings if w not in exc.problems]
        return {"ok": False, "problems": exc.problems, "warnings": warnings, "hash": None}


class PreviewBody(BaseModel):
    node: str
    draft: dict | None = None
    mode: str | None = None
    state: dict[str, Any] | None = None
    profile_id: int | None = None


@api.post("/systems/{system_id}/preview")
def preview_prompt(system_id: str, body: PreviewBody, request: Request):
    """The node's full instruction as the model would see it."""
    from .runtime.builder import initial_state
    _profile(body.profile_id, request)
    system = _draft_or_saved(system_id, body.draft)
    compiled = compile_system(system, strict=False)
    cnode = compiled.nodes.get(body.node)
    if cnode is None:
        raise HTTPException(404, f"Node {body.node!r} not found")
    state = {**initial_state(compiled), **(body.state or {})}
    if body.mode and body.mode in cnode.modes:
        state["modes"] = {**(state.get("modes") or {}), cnode.id: body.mode}
        state.update(cnode.modes[body.mode].state)
    snapshot = ""
    if body.profile_id and compiled.memory_enabled:
        snapshot = memory_store.profile_block(compiled.memory_namespace, compiled.memory_schema,
                                              body.profile_id)
    from .tools import get_tool_class
    tools = []
    for b in cnode.bindings:
        try:
            tool = get_tool_class(b.tool)(b, cnode, compiled)
            tools.append({"name": tool.name, "description": tool.model_description(),
                          "parameters": tool.model_parameters(), "terminal": tool.terminal})
        except Exception as exc:
            tools.append({"name": b.function_name, "error": str(exc)})
    for link in cnode.delegates:
        tools.append({"name": link.tool_name, "delegate_to": link.target,
                      "description": link.tool_description})
    # Retrieval needs a conversation; the preview shows where material goes.
    context = {c.name: f"[{c.name}: material from retriever {c.retriever!r}, retrieved when the node runs]"
               for c in cnode.node.context}
    try:
        text = render_instruction(compiled, cnode, state, user_facing=cnode.user_facing,
                                  memory_snapshot=snapshot, context=context)
    except Exception as exc:
        raise HTTPException(422, f"Template error: {exc}") from None
    return {"instruction": text, "chars": len(text), "tools": tools, "state": state,
            "handoffs": [l.target for l in cnode.handoffs], "warnings": compiled.warnings}


# ----------------------------------------------------------------- fragments

@api.get("/fragments")
def list_fragments():
    return [{"id": k, "text": v, "version": workspace.fragments.version(k)}
            for k, v in workspace.fragments.all().items()]


class FragmentBody(BaseModel):
    text: str


@api.put("/fragments/{frag_id}")
def put_fragment(frag_id: str, body: FragmentBody, if_match: str | None = Header(None)):
    version = workspace.fragments.save(frag_id, body.text, expected_version(if_match))
    return {"id": frag_id, "text": body.text, "version": version}


@api.delete("/fragments/{frag_id}")
def delete_fragment(frag_id: str, if_match: str | None = Header(None)):
    workspace.fragments.delete(frag_id, expected_version(if_match))
    return {"ok": True}


# ------------------------------------------------------------ memory schemas

@api.get("/memory-schemas")
def list_memory_schemas():
    return [{"id": m.id, "name": m.name, "description": m.description, "templates": len(m.templates),
             "updated_at": m.updated_at, "updated_by": m.updated_by,
             "version": workspace.memory_schemas.version(m.id)} for m in workspace.memory_schemas.list()]


@api.get("/memory-schemas/{schema_id}")
def get_memory_schema(schema_id: str):
    return workspace.memory_schemas.dump(workspace.memory_schemas.get(schema_id))


@api.put("/memory-schemas/{schema_id}")
def put_memory_schema(schema_id: str, data: dict, if_match: str | None = Header(None)):
    schema = _parse(MemorySchema, _body(data, schema_id))
    return workspace.memory_schemas.dump(workspace.memory_schemas.save(schema, expected_version(if_match)))


@api.delete("/memory-schemas/{schema_id}")
def delete_memory_schema(schema_id: str, if_match: str | None = Header(None)):
    workspace.memory_schemas.delete(schema_id, expected_version(if_match))
    return {"ok": True}


# ----------------------------------------------------------------- knowledge

@api.get("/knowledge/libraries")
def libraries(backend: str | None = None):
    """Libraries of a knowledge backend (default: the settings default)."""
    configured = get_settings().knowledge.libraries
    return [{**lib, "configured": lib["id"] in configured} for lib in get_knowledge(backend).libraries()]


@api.get("/knowledge/{library}/resources")
def library_resources(library: str, q: str | None = None, limit: int = 200, backend: str | None = None):
    """Resources of a library (id, title, type) — for pickers; q filters titles."""
    return get_knowledge(backend).list_resources(library, q, limit)


@api.get("/knowledge/{library}/files/{oid}")
def knowledge_file(library: str, oid: int, backend: str | None = None):
    path = get_knowledge(backend).file_path(library, oid)
    if path is None:
        raise HTTPException(404, "File not found")
    return FileResponse(path, media_type=mimetypes.guess_type(path.name)[0], filename=path.name,
                        content_disposition_type="inline")


@app.get("/scorm/{package}/{path:path}")
def scorm(package: str, path: str):
    """SCORM packages under settings.scorm_root (only dirs with imsmanifest.xml)."""
    root = get_settings().scorm_root
    if not root:
        raise HTTPException(404)
    pkg = (Path(root) / package).resolve()
    if pkg.parent != Path(root).resolve() or not (pkg / "imsmanifest.xml").is_file():
        raise HTTPException(404)
    target = (pkg / path).resolve()
    if pkg not in target.parents or not target.is_file():
        raise HTTPException(404)
    return FileResponse(target)


# ------------------------------------------------------------------ profiles

@api.get("/profiles")
def list_profiles(request: Request, scope: str = "mine"):
    """Profiles: one's own (``mine``) or everyone's (``all``; editors and admins)."""
    return db.list_profiles(user_id=auth.owner_filter(auth.current_user(request), scope))


class ProfileBody(BaseModel):
    name: str


@api.post("/profiles", status_code=201)
def create_profile(body: ProfileBody, request: Request):
    return db.create_profile(body.name, user_id=auth.current_user(request)["id"])


def _profile(profile_id: int | None, request: Request) -> dict | None:
    """A profile the user may use (404 for others' profiles a viewer can't see)."""
    if not profile_id:
        return None
    profile = db.get_profile(profile_id)
    if profile is None or not auth.can_read(auth.current_user(request), profile["user_id"], profile["origin"]):
        raise HTTPException(404, "Profile not found")
    return profile


@api.delete("/profiles/{profile_id}")
def delete_profile(profile_id: int, request: Request):
    profile = _profile(profile_id, request)
    if not auth.can_delete(auth.current_user(request), profile["user_id"], profile["origin"]):
        raise HTTPException(403, "Only its owner or an admin can delete this profile")
    db.delete_profile(profile_id)
    return {"ok": True}


# --------------------------------------------------------------------- chats

class ChatBody(BaseModel):
    system_id: str
    profile_id: int | None = None


@api.get("/chats")
def list_chats(request: Request, system_id: str | None = None, origin: str | None = "chat", limit: int = 100,
               scope: str = "mine"):
    """Chats: one's own (``mine``) or everyone's (``all``; editors and admins)."""
    user = auth.current_user(request)
    owner = auth.owner_filter(user, scope) if (origin or "chat") == "chat" else auth.owner_filter(user, "all")
    return db.list_chats(system_id, origin or None, limit, user_id=owner)


@api.post("/chats", status_code=201)
async def create_chat(body: ChatBody, request: Request):
    _profile(body.profile_id, request)
    return await get_engine().create_chat(body.system_id, body.profile_id,
                                          user_id=auth.current_user(request)["id"])


def _chat(chat_id: str, request: Request | None = None) -> dict:
    chat = db.get_chat(chat_id)
    if chat is None or (request is not None and not auth.can_read(auth.current_user(request), chat["user_id"],
                                                                  chat["origin"])):
        raise HTTPException(404, "Chat not found")
    return chat


@api.get("/chats/{chat_id}")
async def get_chat(chat_id: str, request: Request):
    chat = _chat(chat_id, request)
    engine = get_engine()
    session = await engine.get_session(chat)
    bus = engine.live.get(chat_id)
    with db.connect() as conn:
        snapshots = {str(r["turn"]): r["hash"] for r in conn.execute(
            "SELECT turn, hash FROM turn_snapshots WHERE chat_id = ?", (chat_id,)).fetchall()}
    return {"chat": chat, "outputs": db.list_outputs(chat_id), "turn_snapshots": snapshots,
            "state": dict(session.state) if session else {},
            "running": engine.is_running(chat_id),
            "observing": bool(bus and bus.turn_done and not bus.closed)}


@api.delete("/chats/{chat_id}")
async def delete_chat(chat_id: str, request: Request):
    chat = _chat(chat_id, request)
    if not auth.can_delete(auth.current_user(request), chat["user_id"], chat["origin"]):
        raise HTTPException(403, "Only its owner or an admin can delete this chat")
    await get_engine().delete_chat(chat_id)
    return {"ok": True}


def _sse(bus):
    async def gen():
        async for event in bus.stream():
            yield f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class MessageBody(BaseModel):
    text: str


@api.post("/chats/{chat_id}/messages")
async def post_message(chat_id: str, body: MessageBody, request: Request):
    """Start a turn; the response is its live event stream (SSE). The turn
    keeps running if the client disconnects. Only the chat's owner talks in
    it (simulated users talk in theirs from the server)."""
    chat = _chat(chat_id, request)
    user = auth.current_user(request)
    if chat["origin"] != "chat" or (chat["user_id"] != user["id"] and not auth.has_role(user, "admin")):
        raise HTTPException(403, "Only the chat's owner can send messages in it")
    try:
        bus = get_engine().start_turn(chat_id, body.text)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from None
    return _sse(bus)


@api.get("/chats/{chat_id}/stream")
async def attach_stream(chat_id: str, request: Request):
    """Re-attach to a running turn (replays its events so far)."""
    _chat(chat_id, request)
    bus = get_engine().live.get(chat_id)
    if bus is None or bus.closed:
        raise HTTPException(404, "No turn is running")
    return _sse(bus)


@api.get("/chats/{chat_id}/traces")
def chat_traces(chat_id: str, request: Request, turn: int | None = None):
    _chat(chat_id, request)
    return db.list_traces(chat_id, turn)


@api.get("/chats/{chat_id}/history")
async def chat_history(chat_id: str, request: Request):
    """The model-side history (ADK session events as messages)."""
    chat = _chat(chat_id, request)
    session = await get_engine().get_session(chat)
    return events_to_messages(session.events) if session else []


@api.get("/chats/{chat_id}/export")
async def export_chat(chat_id: str, request: Request):
    chat = _chat(chat_id, request)
    session = await get_engine().get_session(chat)
    with db.connect() as conn:
        hashes = [r["hash"] for r in conn.execute(
            "SELECT DISTINCT hash FROM turn_snapshots WHERE chat_id = ?", (chat_id,)).fetchall()]
        turn_map = {r["turn"]: r["hash"] for r in conn.execute(
            "SELECT turn, hash FROM turn_snapshots WHERE chat_id = ?", (chat_id,)).fetchall()}
    return {"chat": chat, "profile": db.get_profile(chat["profile_id"]),
            "outputs": db.list_outputs(chat_id), "traces": db.list_traces(chat_id),
            "history": events_to_messages(session.events) if session else [],
            "turn_snapshots": turn_map, "snapshots": {h: db.get_snapshot(h) for h in hashes}}


@api.get("/snapshots/{hash_}")
def snapshot(hash_: str):
    data = db.get_snapshot(hash_)
    if data is None:
        raise HTTPException(404)
    return data


# -------------------------------------------------------------------- memory

def _memory_ctx(system_id: str):
    system = workspace.systems.get(system_id)
    if not system.memory.enabled or not system.memory.schema_id:
        raise HTTPException(400, "Memory is not enabled for this system")
    return system.memory.namespace or system.id, workspace.memory_schemas.get(system.memory.schema_id)


@api.get("/memory/{system_id}/templates")
def memory_templates(system_id: str):
    _, schema = _memory_ctx(system_id)
    return registry_for_api(schema)


@api.get("/memory/{system_id}/notes")
def memory_notes(system_id: str, profile_id: int, request: Request, q: str | None = None,
                 template: str | None = None, limit: int = 30, offset: int = 0):
    _profile(profile_id, request)
    namespace, schema = _memory_ctx(system_id)
    return memory_store.list_notes(namespace, profile_id, schema, q, template, limit, offset)


@api.get("/memory/{system_id}/snapshot")
def memory_snapshot(system_id: str, profile_id: int, request: Request):
    _profile(profile_id, request)
    namespace, schema = _memory_ctx(system_id)
    return {"block": memory_store.profile_block(namespace, schema, profile_id)}


class NoteBody(BaseModel):
    profile_id: int
    template: str
    slots: dict[str, Any] = {}


@api.post("/memory/{system_id}/notes", status_code=201)
def memory_add(system_id: str, body: NoteBody, request: Request):
    _profile(body.profile_id, request)
    namespace, schema = _memory_ctx(system_id)
    return memory_store.add_notes(namespace, schema, body.profile_id, None,
                                  [{"template": body.template, "slots": body.slots}])[0]


class NoteUpdate(BaseModel):
    slots: dict[str, Any]


@api.put("/memory/{system_id}/notes/{note_id}")
def memory_update(system_id: str, note_id: int, body: NoteUpdate):
    _, schema = _memory_ctx(system_id)
    try:
        return memory_store.update_note(schema, note_id, body.slots)
    except KeyError:
        raise HTTPException(404) from None


@api.delete("/memory/{system_id}/notes/{note_id}")
def memory_delete(system_id: str, note_id: int):
    if not memory_store.delete_note(note_id):
        raise HTTPException(404)
    return {"ok": True}


@api.post("/memory/render-test")
def memory_render_test(data: dict):
    """Render a note with a (draft) schema — for the schema editor."""
    schema = _parse(MemorySchema, data.get("schema") or {})
    return {"text": render_note(schema, data.get("template", ""), data.get("slots") or {})}


app.include_router(api)
app.include_router(team_router)
app.include_router(data_router)
app.include_router(sim_router)
app.include_router(bundles_router)
app.include_router(links_router)
app.include_router(public_router)
app.include_router(safety_router)
app.include_router(wizard_router)

# ------------------------------------------------------------------ frontend

FRONTEND = ROOT / "frontend" / "dist"


@app.get("/c/{token}", include_in_schema=False)
def public_chat_page(token: str):
    """The standalone chat page of a chat link (its own small bundle; it
    talks only to /api/public/<token>)."""
    page = FRONTEND / "chat.html"
    if not page.exists():
        return JSONResponse({"detail": "Frontend not built"}, status_code=404)
    return FileResponse(page, headers={"Cache-Control": "no-cache", "Referrer-Policy": "no-referrer",
                                       "X-Robots-Tag": "noindex"})


@app.get("/{path:path}", include_in_schema=False)
def frontend(path: str):
    if path.startswith("api/"):
        raise HTTPException(404)
    target = (FRONTEND / path).resolve()
    if path and FRONTEND in target.parents and target.is_file():
        return FileResponse(target)
    index = FRONTEND / "index.html"
    if index.exists():
        # Revalidate on every load so a rebuilt bundle is picked up at once.
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
    return JSONResponse({"detail": "Frontend not built: cd frontend && npm install && npm run build"},
                        status_code=404)


_background: set[asyncio.Task] = set()


@app.on_event("startup")
async def _startup():
    discover()
    memory_store.ensure()
    from .safety import sync_rails
    sync_rails()
    if auth.auth_enabled() and not auth.count_users():
        log.warning("No accounts yet: open the web UI from this machine to create the first admin, "
                    "or run scripts/users.py add <name> --role admin")
    get_engine()
    processor.start()
    sim_runner.resume()
    _background.add(asyncio.get_running_loop().create_task(sweep_unsaved()))


@app.on_event("shutdown")
async def _shutdown():
    for task in _background:
        task.cancel()
    _background.clear()
