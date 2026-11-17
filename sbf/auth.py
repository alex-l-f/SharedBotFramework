"""
Accounts, sign-in sessions and roles.

Roles, each able to do everything the one before can:

* ``viewer`` — reads every definition and result, chats with systems (their
  own chats and profiles), plans simulations, exports bundles
* ``editor`` — creates, edits and deletes definitions and data, runs
  retrievers and simulations, imports bundles; reads everyone's chats
* ``admin``  — settings and accounts; deletes anyone's chats and profiles

Signing in sets an HttpOnly session cookie holding a random token; the
database keeps only its SHA-256. Sessions last ``SESSION_DAYS`` from the
last request. Passwords are hashed with scrypt.

The first account (an admin) is created on the sign-in page, which offers
this only while no account exists and only to a browser on the server's own
machine; or with ``python scripts/users.py add``.

``SBF_AUTH=off`` (environment) turns accounts off: every request acts as a
local admin. For single-user development and tests only.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import time
from urllib.parse import urlsplit

from fastapi import HTTPException, Request

from . import db
from .workspace import ACTOR, now_iso

ROLES = ("viewer", "editor", "admin")
COOKIE = "sbf_session"  # + "_<port>" when the URL has a port (see cookie_name)
SESSION_DAYS = 14
USERNAME = re.compile(r"[a-z0-9][a-z0-9._-]{1,39}")

LOCAL_USER = {"id": None, "username": "local", "display_name": "Local user", "role": "admin",
              "must_change_password": False, "disabled": False}


def auth_enabled() -> bool:
    return os.getenv("SBF_AUTH", "on").strip().lower() not in ("off", "0", "false", "no")


# ----------------------------------------------------------------- passwords

_SCRYPT = {"n": 2 ** 14, "r": 8, "p": 1}


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, dklen=32, **_SCRYPT)
    b64 = lambda b: base64.b64encode(b).decode("ascii")  # noqa: E731
    return f"scrypt${_SCRYPT['n']}${_SCRYPT['r']}${_SCRYPT['p']}${b64(salt)}${b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, digest = stored.split("$")
        if algo != "scrypt":
            return False
        expected = base64.b64decode(digest)
        actual = hashlib.scrypt(password.encode("utf-8"), salt=base64.b64decode(salt), dklen=len(expected),
                                n=int(n), r=int(r), p=int(p))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def check_password(password: str) -> None:
    if len(password or "") < 8:
        raise ValueError("Passwords need at least 8 characters")
    if len(password) > 200:
        raise ValueError("Passwords can have at most 200 characters")


# --------------------------------------------------------------------- users

def public(row) -> dict | None:
    """A user without the password hash."""
    if row is None:
        return None
    d = dict(row)
    d.pop("password_hash", None)
    d["must_change_password"] = bool(d.get("must_change_password"))
    d["disabled"] = bool(d.get("disabled"))
    return d


def count_users() -> int:
    with db.connect() as conn:
        return conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]


def list_users() -> list[dict]:
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT u.*, (SELECT COUNT(*) FROM auth_sessions s WHERE s.user_id = u.id AND s.expires > ?) AS sessions "
            "FROM users u ORDER BY u.username", (time.time(),)).fetchall()
    return [public(r) for r in rows]


def get_user(user_id: int) -> dict | None:
    with db.connect() as conn:
        return public(conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())


def find_user(username: str) -> dict | None:
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ?", ((username or "").strip(),)).fetchone()
    return dict(row) if row else None


def _check_role(role: str) -> None:
    if role not in ROLES:
        raise ValueError(f"Unknown role {role!r} (one of {', '.join(ROLES)})")


def create_user(username: str, password: str, role: str = "viewer", display_name: str = "",
                must_change_password: bool = False) -> dict:
    username = (username or "").strip().lower()
    if not USERNAME.fullmatch(username):
        raise ValueError("Usernames are 2-40 characters: lowercase letters, digits, '.', '_' or '-'")
    _check_role(role)
    check_password(password)
    with db.connect() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO users (username, display_name, role, password_hash, must_change_password, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (username, (display_name or "").strip()[:80] or username, role, hash_password(password),
                 int(must_change_password), now_iso()))
        except sqlite3.IntegrityError:
            raise ValueError(f"The username {username!r} is taken") from None
    return get_user(cur.lastrowid)


def _admins(conn, excluding: int) -> int:
    return conn.execute("SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?",
                        (excluding,)).fetchone()[0]


def update_user(user_id: int, *, display_name: str | None = None, role: str | None = None,
                disabled: bool | None = None) -> dict:
    user = get_user(user_id)
    if user is None:
        raise KeyError(user_id)
    with db.connect() as conn:
        losing_admin = user["role"] == "admin" and ((role is not None and role != "admin") or disabled)
        if losing_admin and not _admins(conn, user_id):
            raise ValueError("Keep at least one active admin")
        if display_name is not None:
            conn.execute("UPDATE users SET display_name = ? WHERE id = ?",
                         (display_name.strip()[:80] or user["username"], user_id))
        if role is not None:
            _check_role(role)
            conn.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))
        if disabled is not None:
            conn.execute("UPDATE users SET disabled = ? WHERE id = ?", (int(disabled), user_id))
            if disabled:
                conn.execute("DELETE FROM auth_sessions WHERE user_id = ?", (user_id,))
    return get_user(user_id)


def set_password(user_id: int, password: str, *, must_change: bool = False) -> None:
    check_password(password)
    with db.connect() as conn:
        conn.execute("UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?",
                     (hash_password(password), int(must_change), user_id))


def delete_user(user_id: int) -> None:
    """Delete an account; their chats and profiles stay, without an owner."""
    user = get_user(user_id)
    if user is None:
        raise KeyError(user_id)
    with db.connect() as conn:
        if user["role"] == "admin" and not _admins(conn, user_id):
            raise ValueError("Keep at least one active admin")
        conn.execute("DELETE FROM auth_sessions WHERE user_id = ?", (user_id,))
        conn.execute("UPDATE chats SET user_id = NULL WHERE user_id = ?", (user_id,))
        conn.execute("UPDATE profiles SET user_id = NULL WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))


def authenticate(username: str, password: str) -> dict | None:
    """The user, if the password is right and the account is active."""
    row = find_user(username)
    if row is None:
        verify_password(password, hash_password("timing"))  # same work for unknown names
        return None
    if not verify_password(password, row["password_hash"]) or row["disabled"]:
        return None
    return public(row)


# ------------------------------------------------------------------ sessions

def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("ascii", errors="ignore")).hexdigest()


def create_session(user_id: int, user_agent: str = "", ip: str = "") -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    with db.connect() as conn:
        conn.execute("DELETE FROM auth_sessions WHERE expires < ?", (now,))
        conn.execute(
            "INSERT INTO auth_sessions (token_hash, user_id, created, expires, last_seen, user_agent, ip) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (_token_hash(token), user_id, now, now + SESSION_DAYS * 86400, now, (user_agent or "")[:200], ip or ""))
        conn.execute("UPDATE users SET last_login = ? WHERE id = ?", (now_iso(), user_id))
    return token


def session_user(token: str | None) -> dict | None:
    """The active user of a session token; slides the expiry."""
    if not token:
        return None
    now = time.time()
    with db.connect() as conn:
        row = conn.execute(
            "SELECT s.last_seen, s.expires, u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token_hash = ?", (_token_hash(token),)).fetchone()
        if row is None or row["expires"] < now or row["disabled"]:
            return None
        if now - row["last_seen"] > 600:
            conn.execute("UPDATE auth_sessions SET last_seen = ?, expires = ? WHERE token_hash = ?",
                         (now, now + SESSION_DAYS * 86400, _token_hash(token)))
    user = public(row)
    user.pop("last_seen", None)
    user.pop("expires", None)
    return user


def end_session(token: str | None) -> None:
    if token:
        with db.connect() as conn:
            conn.execute("DELETE FROM auth_sessions WHERE token_hash = ?", (_token_hash(token),))


def end_user_sessions(user_id: int, keep_token: str | None = None) -> int:
    with db.connect() as conn:
        return conn.execute("DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?",
                            (user_id, _token_hash(keep_token) if keep_token else "")).rowcount


# ------------------------------------------------------------ login throttle

_failures: dict[str, list[float]] = {}
MAX_FAILURES, WINDOW = 5, 900


def throttled(key: str) -> bool:
    recent = [t for t in _failures.get(key, []) if time.time() - t < WINDOW]
    _failures[key] = recent
    return len(recent) >= MAX_FAILURES


def note_failure(key: str) -> None:
    _failures.setdefault(key, []).append(time.time())


def clear_failures(key: str) -> None:
    _failures.pop(key, None)


# --------------------------------------------------------------- permissions

def has_role(user: dict, role: str) -> bool:
    return ROLES.index(user["role"]) >= ROLES.index(role)


# Requests open to anyone (signing in, the sign-in page's status check).
PUBLIC = {("GET", "/api/auth/status"), ("POST", "/api/auth/login"), ("POST", "/api/auth/setup"),
          ("POST", "/api/auth/logout")}

# Requests a signed-in user may make before changing a temporary password.
PASSWORD_CHANGE = {("GET", "/api/auth/me"), ("POST", "/api/auth/password")}

# Writes (POST/PUT/DELETE) a viewer may make; any other write needs an editor.
VIEWER_WRITES = {
    ("POST", "/api/chats"), ("POST", "/api/chats/{chat_id}/messages"), ("DELETE", "/api/chats/{chat_id}"),
    ("POST", "/api/profiles"), ("DELETE", "/api/profiles/{profile_id}"),
    ("POST", "/api/systems/{system_id}/validate"), ("POST", "/api/systems/{system_id}/preview"),
    ("POST", "/api/memory/render-test"), ("POST", "/api/simulations/preview-prompts"),
    ("POST", "/api/simulations/plan"), ("POST", "/api/presence"), ("POST", "/api/bundles/plan"),
    ("POST", "/api/bundles/export"), ("PUT", "/api/auth/me"), ("POST", "/api/auth/password"),
}

ADMIN_PREFIXES = ("/api/users",)
ADMIN_ROUTES = {("PUT", "/api/settings")}
# Chat links carry their secret URL: editors only, reading included.
EDITOR_PREFIXES = ("/api/links",)
# The standalone chat page's API: open to anyone with a link (sbf.api_links checks it).
PUBLIC_PREFIX = "/api/public/"


def required_role(method: str, path: str) -> str:
    """The least role that may make this request (``path``: the route template)."""
    if path.startswith(ADMIN_PREFIXES) or (method, path) in ADMIN_ROUTES:
        return "admin"
    if path.startswith(EDITOR_PREFIXES):
        return "editor"
    if method in ("GET", "HEAD", "OPTIONS") or (method, path) in VIEWER_WRITES:
        return "viewer"
    return "editor"


def cookie_name(request: Request) -> str:
    """Cookies are per host, not per port: two servers on one machine (say
    a sandbox next to the real one) would otherwise share, and overwrite,
    one session cookie."""
    port = request.url.port
    return f"{COOKIE}_{port}" if port else COOKIE


def session_token(request: Request) -> str | None:
    return request.cookies.get(cookie_name(request))


def client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


def is_loopback(request: Request) -> bool:
    return client_ip(request) in ("127.0.0.1", "::1", "localhost")


def _same_origin(request: Request) -> bool:
    """Browsers send Origin on cross-site writes; refuse those (CSRF)."""
    origin = request.headers.get("origin")
    if not origin or origin == "null":
        return origin is None
    hosts = {(request.headers.get(h) or "").lower() for h in ("host", "x-forwarded-host")} - {""}
    return urlsplit(origin).netloc.lower() in hosts


async def guard(request: Request) -> None:
    """App-wide dependency: who is asking, and may they? (async, so the
    ACTOR it sets reaches sync endpoints)."""
    route = request.scope.get("route")
    path = getattr(route, "path", request.url.path)
    method = request.method
    if not (path.startswith("/api/") or path.startswith("/scorm/")):
        return  # the web UI itself (it shows the sign-in page)
    if method not in ("GET", "HEAD", "OPTIONS") and not _same_origin(request):
        raise HTTPException(403, "Cross-site request refused")
    if (method, path) in PUBLIC or path.startswith(PUBLIC_PREFIX):
        return
    if not auth_enabled():
        user = LOCAL_USER
    else:
        user = session_user(request.cookies.get(cookie_name(request)))
        if user is None:
            raise HTTPException(401, "Sign in to continue")
        if user["must_change_password"] and (method, path) not in PASSWORD_CHANGE:
            raise HTTPException(403, "Change your temporary password first")
    need = required_role(method, path)
    if not has_role(user, need):
        raise HTTPException(403, f"This needs the {need} role (you are {user['role']})")
    request.state.user = user
    ACTOR.set(user["username"])


def current_user(request: Request) -> dict:
    return getattr(request.state, "user", None) or LOCAL_USER


# ----------------------------------------------------------------- ownership

def can_read(user: dict, owner_id: int | None, origin: str = "chat") -> bool:
    """Chats and profiles: the owner, and editors and admins (simulations: anyone)."""
    if origin == "simulation":
        return True
    return (owner_id is not None and owner_id == user["id"]) or has_role(user, "editor")


def can_delete(user: dict, owner_id: int | None, origin: str = "chat") -> bool:
    if origin == "simulation":
        return has_role(user, "editor")
    return (owner_id is not None and owner_id == user["id"]) or has_role(user, "admin")


def owner_filter(user: dict, scope: str):
    """``user_id`` for list queries: one's own (``mine``), or everyone's
    (``all``; editors and admins). Without accounts, everything."""
    if user["id"] is None:
        return db._OWNER_ANY
    if scope == "all" and has_role(user, "editor"):
        return db._OWNER_ANY
    return user["id"]
