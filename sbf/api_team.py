"""
Team API: signing in, accounts (admins), who else is on a page (presence),
and the revision history of definitions.
"""

from __future__ import annotations

import time

import yaml
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from . import auth, db, revisions
from .settings import Settings
from .workspace import workspace

router = APIRouter(prefix="/api")


def _set_cookie(request: Request, response: Response, token: str) -> None:
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(auth.cookie_name(request), token, max_age=auth.SESSION_DAYS * 86400, httponly=True,
                        samesite="lax", secure=secure, path="/")


# ---------------------------------------------------------------------- auth

@router.get("/auth/status")
def status(request: Request):
    """For the sign-in page: are accounts on, who is signed in, and can the
    first admin be created from this browser?"""
    if not auth.auth_enabled():
        return {"auth": False, "user": auth.LOCAL_USER, "setup_needed": False, "setup_allowed": False}
    user = auth.session_user(auth.session_token(request))
    setup_needed = auth.count_users() == 0
    return {"auth": True, "user": user, "setup_needed": setup_needed,
            "setup_allowed": setup_needed and auth.is_loopback(request)}


class LoginBody(BaseModel):
    username: str
    password: str


@router.post("/auth/login")
def login(body: LoginBody, request: Request, response: Response):
    if not auth.auth_enabled():
        return auth.LOCAL_USER
    key = f"{body.username.strip().lower()}|{auth.client_ip(request)}"
    if auth.throttled(key):
        raise HTTPException(429, "Too many failed attempts; wait 15 minutes and try again")
    user = auth.authenticate(body.username, body.password)
    if user is None:
        auth.note_failure(key)
        raise HTTPException(401, "Wrong username or password")
    auth.clear_failures(key)
    _set_cookie(request, response, auth.create_session(user["id"], request.headers.get("user-agent", ""),
                                                       auth.client_ip(request)))
    return user


class SetupBody(BaseModel):
    username: str
    password: str
    display_name: str = ""


@router.post("/auth/setup", status_code=201)
def setup(body: SetupBody, request: Request, response: Response):
    """Create the first account (an admin): only while there is none, and
    only from the server's own machine."""
    if not auth.auth_enabled():
        raise HTTPException(400, "Accounts are turned off (SBF_AUTH=off)")
    if auth.count_users():
        raise HTTPException(409, "An admin already exists; sign in instead")
    if not auth.is_loopback(request):
        raise HTTPException(403, "Create the first admin from the server's own machine, or with scripts/users.py")
    user = auth.create_user(body.username, body.password, "admin", body.display_name)
    adopted = db.adopt_unowned(user["id"])
    _set_cookie(request, response, auth.create_session(user["id"], request.headers.get("user-agent", ""),
                                                       auth.client_ip(request)))
    return {**user, "adopted": adopted}


@router.post("/auth/logout")
def logout(request: Request, response: Response):
    auth.end_session(auth.session_token(request))
    response.delete_cookie(auth.cookie_name(request), path="/")
    return {"ok": True}


@router.get("/auth/me")
def me(request: Request):
    return auth.current_user(request)


class MeBody(BaseModel):
    display_name: str


@router.put("/auth/me")
def update_me(body: MeBody, request: Request):
    user = auth.current_user(request)
    if user["id"] is None:
        raise HTTPException(400, "Accounts are turned off")
    return auth.update_user(user["id"], display_name=body.display_name)


class PasswordBody(BaseModel):
    current_password: str
    new_password: str


@router.post("/auth/password")
def change_password(body: PasswordBody, request: Request):
    """Change one's own password; signs out one's other sessions."""
    user = auth.current_user(request)
    if user["id"] is None:
        raise HTTPException(400, "Accounts are turned off")
    if auth.authenticate(user["username"], body.current_password) is None:
        raise HTTPException(400, "The current password is wrong")
    if body.new_password == body.current_password:
        raise HTTPException(400, "Choose a new password")
    auth.set_password(user["id"], body.new_password)
    ended = auth.end_user_sessions(user["id"], keep_token=auth.session_token(request))
    return {"ok": True, "other_sessions_ended": ended}


# --------------------------------------------------------------------- users

@router.get("/users")
def list_users():
    return auth.list_users()


class NewUserBody(BaseModel):
    username: str
    password: str
    role: str = "viewer"
    display_name: str = ""
    must_change_password: bool = True


@router.post("/users", status_code=201)
def create_user(body: NewUserBody):
    return auth.create_user(body.username, body.password, body.role, body.display_name,
                            body.must_change_password)


class UserUpdate(BaseModel):
    display_name: str | None = None
    role: str | None = None
    disabled: bool | None = None


def _other_user(user_id: int) -> dict:
    target = auth.get_user(user_id)
    if target is None:
        raise HTTPException(404, "User not found")
    return target


@router.put("/users/{user_id}")
def update_user(user_id: int, body: UserUpdate, request: Request):
    _other_user(user_id)
    if user_id == auth.current_user(request)["id"] and body.disabled:
        raise HTTPException(400, "You can't disable your own account")
    return auth.update_user(user_id, **body.model_dump(exclude_none=True))


class ResetBody(BaseModel):
    password: str
    must_change_password: bool = True


@router.post("/users/{user_id}/password")
def reset_password(user_id: int, body: ResetBody, request: Request):
    """Set someone's password (by default a temporary one they must change);
    signs them out everywhere."""
    _other_user(user_id)
    auth.set_password(user_id, body.password, must_change=body.must_change_password)
    keep = auth.session_token(request) if user_id == auth.current_user(request)["id"] else None
    auth.end_user_sessions(user_id, keep_token=keep)
    return auth.get_user(user_id)


@router.post("/users/{user_id}/sign-out")
def sign_out_user(user_id: int, request: Request):
    _other_user(user_id)
    keep = auth.session_token(request) if user_id == auth.current_user(request)["id"] else None
    return {"ended": auth.end_user_sessions(user_id, keep_token=keep)}


@router.delete("/users/{user_id}")
def delete_user(user_id: int, request: Request):
    _other_user(user_id)
    if user_id == auth.current_user(request)["id"]:
        raise HTTPException(400, "You can't delete your own account")
    auth.delete_user(user_id)
    return {"ok": True}


# ------------------------------------------------------------------ presence

PRESENCE_TTL = 45  # seconds without a heartbeat before someone is gone
_presence: dict[str, dict[str, dict]] = {}


class PresenceBody(BaseModel):
    resource: str
    editing: bool = False
    leaving: bool = False


@router.post("/presence")
def presence(body: PresenceBody, request: Request):
    """Heartbeat from an open editor (every ~15 s): returns the others who
    have the same resource open, and whether they have unsaved changes."""
    user = auth.current_user(request)
    me_key = user["username"]
    now = time.time()
    here = _presence.setdefault(body.resource[:200], {})
    if body.leaving:
        here.pop(me_key, None)
    else:
        here[me_key] = {"username": user["username"], "display_name": user.get("display_name") or user["username"],
                        "editing": body.editing, "seen": now}
    for resource in list(_presence):
        for name, entry in list(_presence[resource].items()):
            if now - entry["seen"] > PRESENCE_TTL:
                del _presence[resource][name]
        if not _presence[resource]:
            del _presence[resource]
    others = [{"username": e["username"], "display_name": e["display_name"], "editing": e["editing"],
               "seconds_ago": round(now - e["seen"])}
              for name, e in _presence.get(body.resource[:200], {}).items() if name != me_key]
    return {"others": others}


# ----------------------------------------------------------------- revisions

KINDS = (*workspace.collections, "fragments", "settings")


def _kind(kind: str) -> str:
    if kind not in KINDS:
        raise HTTPException(404, f"Unknown kind {kind!r}")
    return kind


@router.get("/revisions")
def recent_changes(limit: int = 50, actor: str | None = None):
    """The latest changes to any definition (activity)."""
    return revisions.recent(min(limit, 500), actor)


@router.get("/revisions/{kind}/{item_id}")
def item_history(kind: str, item_id: str, limit: int = 100):
    return revisions.history(_kind(kind), item_id, min(limit, 500))


@router.get("/revisions/{kind}/{item_id}/{rev_id}")
def item_revision(kind: str, item_id: str, rev_id: int):
    """One revision: its file content and the parsed definition (``data``)."""
    rev = revisions.get(rev_id)
    if rev is None or rev["kind"] != _kind(kind) or rev["item_id"] != item_id:
        raise HTTPException(404, "Revision not found")
    content = rev["content"].replace("\r\n", "\n")
    if rev["action"] == "delete":
        data = None
    elif kind == "fragments":
        data = {"id": item_id, "text": content}
    else:
        data = yaml.safe_load(content) or {}
        model = Settings if kind == "settings" else workspace.collections[kind].model
        try:  # the full definition, defaults included (as the editors load it)
            data = model.model_validate({"id": item_id, **data} if kind != "settings" else data).model_dump()
        except ValueError:
            pass  # saved under an older schema: as written
    return {**rev, "content": content, "data": data}

