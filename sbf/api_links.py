"""
Chat links API.

* ``/api/links`` — managing links (editors): create, change, turn off,
  replace the URL, delete; their conversations and counts.
* ``/api/public/{token}`` — the standalone chat page's API, open to anyone
  with the link (no account). It shows a visitor only their own
  conversations, only what the user side of a chat sees (messages, files,
  course pages — no traces, no internal events), and serves only the files
  and course pages delivered in that conversation.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import auth, db, links
from .links import LinkSettings
from .runtime import get_engine
from .workspace import ACTOR, NotFound, workspace

log = logging.getLogger(__name__)

manage = APIRouter(prefix="/api/links")
public = APIRouter(prefix="/api/public/{token}")

MAX_MESSAGE = 4000
PUBLIC_OUTPUTS = {
    "user": ("content",),
    "message": ("content",),
    "file": ("resource_id", "title", "source_type", "source_file", "url", "mime", "note", "summary"),
    "viewer": ("resource_id", "lesson_id", "title", "section", "url", "note", "summary"),
}


# ------------------------------------------------------------------ manage

class LinkBody(BaseModel):
    label: str = ""
    system_id: str
    active: bool = True
    settings: LinkSettings = Field(default_factory=LinkSettings)
    access_code: str | None = Field(None, description="Set an access code (stored hashed)")


class LinkUpdate(BaseModel):
    label: str | None = None
    system_id: str | None = None
    active: bool | None = None
    settings: LinkSettings | None = None
    access_code: str | None = Field(None, description='None keeps it, "" removes it')


def _check_code(code: str | None) -> None:
    if code and not 8 <= len(code) <= 200:
        raise HTTPException(400, "Access codes need 8 to 200 characters")


def _system(system_id: str) -> None:
    if not workspace.systems.exists(system_id):
        raise HTTPException(400, f"System {system_id!r} not found")


def _managed(link_id: str) -> dict:
    link = links.get_link(link_id)
    if link is None:
        raise HTTPException(404, "Link not found")
    return link


def _with_stats(link: dict) -> dict:
    stats = next((l["stats"] for l in links.list_links() if l["id"] == link["id"]), {})
    live = sum(1 for c in get_engine().unsaved.values() if c["chat"].get("link_id") == link["id"])
    return {**link, "stats": {**stats, "live_unsaved": live}, "status": links.status(link)}


@manage.get("")
def list_links(system_id: str | None = None):
    return [{**l, "status": links.status(l)} for l in links.list_links(system_id)]


@manage.post("", status_code=201)
def create_link(body: LinkBody):
    _system(body.system_id)
    _check_code(body.access_code)
    link = links.create_link(body.label, body.system_id, body.settings, body.access_code or None,
                             ACTOR.get(), body.active)
    return _with_stats(link)


@manage.get("/{link_id}")
def get_link(link_id: str):
    return _with_stats(_managed(link_id))


@manage.put("/{link_id}")
def update_link(link_id: str, body: LinkUpdate):
    _managed(link_id)
    if body.system_id is not None:
        _system(body.system_id)
    _check_code(body.access_code)
    link = links.update_link(link_id, label=body.label, system_id=body.system_id, active=body.active,
                             settings=body.settings, access_code=body.access_code, actor=ACTOR.get())
    return _with_stats(link)


@manage.post("/{link_id}/rotate")
def rotate(link_id: str):
    _managed(link_id)
    return _with_stats(links.rotate_token(link_id))


@manage.delete("/{link_id}")
async def delete_link(link_id: str):
    """Delete the link, its saved conversations and its visitors' memory."""
    _managed(link_id)
    engine = get_engine()
    for chat_id, record in list(engine.unsaved.items()):
        if record["chat"].get("link_id") == link_id:
            await engine.delete_chat(chat_id)
    removed = links.delete_link(link_id)
    for chat_id in removed["chats"]:
        await engine.delete_chat(chat_id)
    return {"ok": True, "conversations": len(removed["chats"]), "profiles": removed["profiles"]}


@manage.get("/{link_id}/conversations")
def link_conversations(link_id: str):
    """Saved ones open in the chat view (``chat_id``); unsaved ones are counts only."""
    link = _managed(link_id)
    engine = get_engine()
    idle = link["settings"]["idle_minutes"] * 60
    out = []
    for c in links.list_conversations(link_id):
        chat = db.get_chat(c["chat_id"]) if c["saved"] else None
        recent = (datetime.now().astimezone() - datetime.fromisoformat(c["last_at"])).total_seconds() < idle
        out.append({"id": c["chat_id"], "saved": bool(c["saved"]), "visitor": c["visitor"][:8],
                    "remembered": c["profile_id"] is not None, "started_at": c["started_at"],
                    "last_at": c["last_at"], "turns": c["turns"], "ended_at": c["ended_at"],
                    "ended_by": c["ended_by"], "consented_at": c["consented_at"],
                    "title": chat["title"] if chat else None, "system_id": chat["system_id"] if chat else None,
                    "live": c["chat_id"] in engine.unsaved or (chat is not None and not c["ended_at"] and recent)})
    return out


# ------------------------------------------------------------------ public

def _link(token: str) -> dict:
    link = links.by_token(token)
    if link is None:
        raise HTTPException(404, "This chat link doesn't exist or has been replaced.")
    if not link["active"]:
        raise HTTPException(410, "This chat link has been turned off.")
    return link


def _cookie(link: dict) -> str:
    return f"sbf_v_{link['id']}"


def _visitor(request: Request, response: Response, link: dict, token: str) -> dict:
    """The visitor of this browser (a new random id in a cookie on first sight)."""
    value = request.cookies.get(_cookie(link))
    if not value:
        value = secrets.token_urlsafe(24)
        secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
        remember = link["settings"]["remember_visitors"]
        response.set_cookie(_cookie(link), value, httponly=True, samesite="lax", secure=secure,
                            path=f"/api/public/{token}", max_age=365 * 86400 if remember else None)
    return links.visitor(link["id"], value)


def _needs_code(link: dict, v: dict) -> bool:
    return link["has_access_code"] and not v["granted"]


def _gate(link: dict, v: dict) -> None:
    if _needs_code(link, v):
        raise HTTPException(403, "Enter the access code first.")


def _system_ui(link: dict) -> dict:
    try:
        system = workspace.systems.get(link["system_id"])
    except NotFound:
        return {}
    return {"title": system.ui.title or system.name or system.id, "welcome": system.ui.welcome,
            "starters": system.ui.starters, "show_viewer": system.ui.show_viewer}


@public.get("")
def info(token: str, request: Request, response: Response):
    """What the chat page shows before anything else."""
    link = _link(token)
    v = _visitor(request, response, link, token)
    s, ui = link["settings"], _system_ui(link)
    state = links.status(link) if ui else "unavailable"
    title = s["title"] or ui.get("title") or "Chat"
    if _needs_code(link, v):  # the rest of the page is for those who have the code
        return {"title": title, "status": state, "needs_code": True}
    return {"title": title,
            "welcome": s["welcome"] if s["welcome"] is not None else ui.get("welcome", ""),
            "starters": s["starters"] if s["starters"] is not None else ui.get("starters", []),
            "show_viewer": ui.get("show_viewer", True), "notice": s["notice"],
            "require_consent": s["require_consent"], "saving": s["save_transcripts"],
            "remembers": s["remember_visitors"], "max_turns": s["max_turns"],
            "idle_minutes": s["idle_minutes"], "status": state,
            "needs_code": _needs_code(link, v)}


class CodeBody(BaseModel):
    code: str


@public.post("/access")
def access(token: str, body: CodeBody, request: Request, response: Response):
    link = _link(token)
    v = _visitor(request, response, link, token)
    key = f"link:{link['id']}|{auth.client_ip(request)}"
    if auth.throttled(key):
        raise HTTPException(429, "Too many attempts; wait 15 minutes and try again.")
    if not links.check_access_code(link, body.code):
        auth.note_failure(key)
        raise HTTPException(403, "That code isn't right.")
    auth.clear_failures(key)
    links.grant(link["id"], v["visitor"])
    return {"ok": True}


def _public_url(url: str, token: str, chat_id: str) -> str:
    return f"/api/public/{token}/r/{chat_id}{url}" if url.startswith("/") else url


def public_output(o: dict, token: str, chat_id: str) -> dict | None:
    """An output as the visitor may see it (None: not for them)."""
    fields = PUBLIC_OUTPUTS.get(o.get("type"))
    if fields is None:
        return None
    out = {"id": o.get("id"), "type": o["type"], "turn": o.get("turn"), "ts": o.get("ts"),
           **{k: o[k] for k in fields if k in o}}
    if out.get("url"):
        out["url"] = _public_url(out["url"], token, chat_id)
    return out


def _public_event(event: dict, token: str, chat_id: str) -> dict | None:
    kind = event.get("kind")
    if kind == "output":
        out = public_output(event, token, chat_id)
        return {"kind": "output", **out} if out else None
    if kind in ("turn_start", "turn_done"):
        return {"kind": kind, "turn": event.get("turn")}
    if kind == "error":
        return {"kind": "error", "message": "Something went wrong on our side. Please try again."}
    if kind == "end":
        return {"kind": "end"}
    return None  # traces and internal events stay inside


def _sse(bus, token: str, chat_id: str) -> StreamingResponse:
    async def gen():
        async for event in bus.stream():
            out = _public_event(event, token, chat_id)
            if out:
                yield f"data: {json.dumps(out, ensure_ascii=False, default=str)}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _conversation(link: dict, v: dict, chat_id: str) -> tuple[dict, dict]:
    """A conversation of this visitor and its chat (404 for anyone else's)."""
    conv = links.conversation(chat_id)
    if conv is None or conv["link_id"] != link["id"] or conv["visitor"] != v["visitor"]:
        raise HTTPException(404, "Conversation not found.")
    chat = get_engine().get_chat(chat_id)
    if chat is None:
        raise HTTPException(410, "This conversation has ended.")
    return conv, chat


def _summary(conv: dict, chat: dict | None) -> dict:
    engine = get_engine()
    return {"id": conv["chat_id"], "title": (chat or {}).get("title"), "turns": conv["turns"],
            "started_at": conv["started_at"], "last_at": conv["last_at"],
            "ended": bool(conv["ended_at"]), "saved": bool(conv["saved"]),
            "running": engine.is_running(conv["chat_id"])}


@public.get("/conversations")
def my_conversations(token: str, request: Request, response: Response):
    """This visitor's conversations that can still be opened, newest first."""
    link = _link(token)
    v = _visitor(request, response, link, token)
    _gate(link, v)
    engine = get_engine()
    out = []
    for conv in links.list_conversations(link["id"], v["visitor"], limit=50):
        chat = engine.get_chat(conv["chat_id"])
        if chat is not None:
            out.append(_summary(conv, chat))
    return out


class StartBody(BaseModel):
    consent: bool = False


@public.post("/conversations", status_code=201)
async def start_conversation(token: str, body: StartBody, request: Request, response: Response):
    link = _link(token)
    v = _visitor(request, response, link, token)
    _gate(link, v)
    state = links.status(link)
    if state != "active":
        raise HTTPException(409, {"expired": "This chat link has expired.",
                                  "full": "This chat link isn't taking new conversations."}.get(state, state))
    s = link["settings"]
    if s["require_consent"] and not body.consent:
        raise HTTPException(400, "Please read and accept the notice first.")
    profile_id = links.visitor_profile(link, v)
    try:
        chat = await get_engine().create_chat(link["system_id"], profile_id, origin="link", link_id=link["id"],
                                              saved=s["save_transcripts"])
    except Exception as exc:
        log.exception("link %s: could not start a conversation", link["id"])
        raise HTTPException(503, "This chat isn't available right now.") from exc
    links.add_conversation(link, v["visitor"], chat["id"], s["save_transcripts"], profile_id, body.consent)
    return _summary(links.conversation(chat["id"]), chat)


@public.get("/conversations/{chat_id}")
def get_conversation(token: str, chat_id: str, request: Request, response: Response):
    link = _link(token)
    v = _visitor(request, response, link, token)
    _gate(link, v)
    conv, chat = _conversation(link, v, chat_id)
    outputs = [o for o in (public_output(o, token, chat_id) for o in get_engine().outputs(chat_id)) if o]
    return {**_summary(conv, chat), "outputs": outputs}


class MessageBody(BaseModel):
    text: str


@public.post("/conversations/{chat_id}/messages")
async def send(token: str, chat_id: str, body: MessageBody, request: Request, response: Response):
    """Start a turn; the response is its event stream (SSE), user-side events only."""
    link = _link(token)
    v = _visitor(request, response, link, token)
    _gate(link, v)
    conv, chat = _conversation(link, v, chat_id)
    state = links.status(link)
    if state == "expired":
        raise HTTPException(409, "This chat link has expired.")
    if conv["ended_at"]:
        raise HTTPException(409, "This conversation has ended. Start a new one.")
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "Write a message first.")
    if len(text) > MAX_MESSAGE:
        raise HTTPException(400, f"Messages can be at most {MAX_MESSAGE} characters.")
    if conv["turns"] >= link["settings"]["max_turns"]:
        raise HTTPException(409, "This conversation has reached its message limit. Start a new one.")
    if not links.allow_message(link, v["visitor"]):
        raise HTTPException(429, "You're sending messages quickly. Wait a moment and try again.")
    try:
        bus = get_engine().start_turn(chat_id, text)
    except RuntimeError:
        raise HTTPException(409, "Wait for the reply before sending another message.") from None
    links.note_turn(chat_id)
    return _sse(bus, token, chat_id)


@public.get("/conversations/{chat_id}/stream")
async def attach(token: str, chat_id: str, request: Request, response: Response):
    """Re-attach to a reply in progress (replays it so far)."""
    link = _link(token)
    v = _visitor(request, response, link, token)
    _gate(link, v)
    _conversation(link, v, chat_id)
    bus = get_engine().live.get(chat_id)
    if bus is None or bus.closed:
        raise HTTPException(404, "No reply in progress.")
    return _sse(bus, token, chat_id)


@public.post("/conversations/{chat_id}/end")
async def end(token: str, chat_id: str, request: Request, response: Response):
    """The visitor ends the conversation; an unsaved one is erased now."""
    link = _link(token)
    v = _visitor(request, response, link, token)
    conv, chat = _conversation(link, v, chat_id)
    links.end_conversation(chat_id, "visitor")
    if chat.get("unsaved"):
        await get_engine().delete_chat(chat_id)
    return {"ok": True, "erased": bool(chat.get("unsaved"))}


_FILE = re.compile(r"api/knowledge/([^/]+)/files/(\d+)")
_ITEM_FILE = re.compile(r"api/datasets/([^/]+)/items/(\d+)/file")
_SCORM = re.compile(r"scorm/([^/]+)/(.+)")


@public.get("/r/{chat_id}/{path:path}")
def resource(token: str, chat_id: str, path: str, request: Request, response: Response):
    """A file or course page delivered in this conversation (and the course
    package's own assets)."""
    from .api_data import item_file
    from .app import knowledge_file, scorm
    link = _link(token)
    v = _visitor(request, response, link, token)
    _gate(link, v)
    _conversation(link, v, chat_id)
    delivered = [o["url"].split("#")[0] for o in get_engine().outputs(chat_id)
                 if o.get("type") in ("file", "viewer") and str(o.get("url") or "").startswith("/")]
    packages = {u.split("/")[2] for u in delivered if u.startswith("/scorm/") and u.count("/") >= 3}
    query = request.url.query
    target = "/" + path + (f"?{query}" if query else "")
    scorm_match = _SCORM.fullmatch(path)
    if target not in delivered and not (scorm_match and scorm_match.group(1) in packages):
        raise HTTPException(404, "Not available.")
    if m := _FILE.fullmatch(path):
        return knowledge_file(m.group(1), int(m.group(2)), backend=request.query_params.get("backend"))
    if m := _ITEM_FILE.fullmatch(path):
        return item_file(m.group(1), int(m.group(2)))
    if scorm_match:
        return scorm(scorm_match.group(1), scorm_match.group(2))
    raise HTTPException(404, "Not available.")


# ---------------------------------------------------------------- sweeper

async def sweep_unsaved(every: float = 60) -> None:
    """Drop unsaved conversations idle past their link's limit; a server
    restart has already lost the ones it had."""
    links.close_orphans(set(get_engine().unsaved))
    while True:
        await asyncio.sleep(every)
        try:
            engine = get_engine()
            await engine.drop_idle(links.unsaved_limits())
            links.close_orphans(set(engine.unsaved))
        except Exception:
            log.exception("sweeping unsaved conversations failed")
