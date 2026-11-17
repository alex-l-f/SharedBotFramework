"""
Chat links: a system published at a secret URL (``/c/<token>``) for people
without an account, in a standalone chat page with none of the management
interface.

Per link (``LinkSettings``): whether transcripts are kept, whether returning
visitors are remembered (a memory profile per visitor), what the page shows
(title, welcome, starters, a notice to accept first), an access code,
expiry, and limits (turns per conversation, messages per minute,
conversations in total).

Visitors are anonymous: a random id in a cookie scoped to the link's API
path; the database keeps only its hash. Saved conversations are ordinary
chats (origin 'link') that editors read in the chat view. Unsaved ones live
only in the server's memory (see ``runtime.engine``) and leave nothing here
but content-free counts: when they started and ended, and how many turns.

Tables (in ``sbf.db``): chat_links, link_visitors, link_conversations.
"""

from __future__ import annotations

import collections
import hashlib
import json
import secrets
import threading
import time
from datetime import datetime

from pydantic import BaseModel, Field

from . import db
from .workspace import now_iso

_SCHEMA = """
CREATE TABLE IF NOT EXISTS chat_links (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    system_id TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    settings TEXT NOT NULL,
    access_hash TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_by TEXT,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS link_visitors (
    link_id TEXT NOT NULL,
    visitor TEXT NOT NULL,
    profile_id INTEGER,
    granted INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (link_id, visitor)
);
CREATE TABLE IF NOT EXISTS link_conversations (
    chat_id TEXT PRIMARY KEY,
    link_id TEXT NOT NULL,
    visitor TEXT NOT NULL,
    saved INTEGER NOT NULL,
    profile_id INTEGER,
    consented_at TEXT,
    started_at TEXT NOT NULL,
    last_at TEXT NOT NULL,
    turns INTEGER NOT NULL DEFAULT 0,
    ended_at TEXT,
    ended_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_link_conv ON link_conversations(link_id, visitor, started_at);
"""

_ready = False
_lock = threading.Lock()


def _connect():
    global _ready
    if not _ready:
        with _lock:
            with db.connect() as conn:
                conn.executescript(_SCHEMA)
            _ready = True
    return db.connect()


class LinkSettings(BaseModel):
    save_transcripts: bool = Field(True, description="Keep transcripts (editors can read them); "
                                   "off: conversations exist only in server memory while open")
    remember_visitors: bool = Field(False, description="A memory profile per visitor (cookie in their "
                                    "browser), so the system's memory works across visits")
    title: str = Field("", description="Page title (default: the system's UI title or name)")
    welcome: str | None = Field(None, description="Markdown before the first message (default: the system's)")
    starters: list[str] | None = Field(None, description="Suggested first messages (default: the system's)")
    notice: str = Field("", description="Markdown shown before the chat starts (e.g. what is recorded)")
    require_consent: bool = Field(False, description="Visitors must accept the notice to start")
    expires_at: str | None = Field(None, description="ISO date/time after which the link stops working")
    max_turns: int = Field(40, ge=1, le=500, description="Messages per conversation")
    max_conversations: int | None = Field(None, ge=1, description="Conversations in total (all visitors)")
    messages_per_minute: int = Field(8, ge=1, le=120, description="Per visitor")
    idle_minutes: int = Field(60, ge=5, le=1440, description="Unsaved conversations are dropped after this "
                              "long without a message")


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _row(row) -> dict | None:
    if row is None:
        return None
    d = dict(row)
    d["settings"] = LinkSettings.model_validate(json.loads(d["settings"] or "{}")).model_dump()
    d["active"] = bool(d["active"])
    d["has_access_code"] = bool(d.pop("access_hash", None))
    d["path"] = f"/c/{d['token']}"
    return d


def _access_hash(link_id: str) -> str | None:
    with _connect() as conn:
        row = conn.execute("SELECT access_hash FROM chat_links WHERE id = ?", (link_id,)).fetchone()
    return row["access_hash"] if row else None


# ------------------------------------------------------------------- links

def create_link(label: str, system_id: str, settings: LinkSettings, access_code: str | None = None,
                actor: str | None = None, active: bool = True) -> dict:
    from .auth import hash_password
    link_id, token, ts = secrets.token_hex(5), secrets.token_urlsafe(18), now_iso()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO chat_links (id, token, label, system_id, active, settings, access_hash, created_by, "
            "created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (link_id, token, label.strip()[:120] or system_id, system_id, int(active),
             settings.model_dump_json(), hash_password(access_code) if access_code else None, actor, ts, actor, ts))
    return get_link(link_id)


def get_link(link_id: str) -> dict | None:
    with _connect() as conn:
        return _row(conn.execute("SELECT * FROM chat_links WHERE id = ?", (link_id,)).fetchone())


def by_token(token: str) -> dict | None:
    with _connect() as conn:
        return _row(conn.execute("SELECT * FROM chat_links WHERE token = ?", (token or "",)).fetchone())


def list_links(system_id: str | None = None) -> list[dict]:
    sql, params = "SELECT * FROM chat_links", []
    if system_id:
        sql += " WHERE system_id = ?"
        params.append(system_id)
    with _connect() as conn:
        rows = conn.execute(sql + " ORDER BY created_at DESC", params).fetchall()
        stats = {r["link_id"]: dict(r) for r in conn.execute(
            "SELECT link_id, COUNT(*) AS conversations, COUNT(DISTINCT visitor) AS visitors, "
            "SUM(turns) AS turns, MAX(last_at) AS last_used FROM link_conversations GROUP BY link_id")}
    out = []
    for row in rows:
        link = _row(row)
        s = stats.get(link["id"], {})
        link["stats"] = {"conversations": s.get("conversations", 0), "visitors": s.get("visitors", 0),
                         "turns": s.get("turns") or 0, "last_used": s.get("last_used")}
        out.append(link)
    return out


def update_link(link_id: str, *, label: str | None = None, system_id: str | None = None,
                active: bool | None = None, settings: LinkSettings | None = None,
                access_code: str | None = None, actor: str | None = None) -> dict:
    """``access_code``: None keeps it, "" removes it, otherwise sets it (and
    visitors who entered the old one must enter the new one)."""
    from .auth import hash_password
    sets, params = ["updated_by = ?", "updated_at = ?"], [actor, now_iso()]
    if label is not None:
        sets.append("label = ?")
        params.append(label.strip()[:120] or system_id or "link")
    if system_id is not None:
        sets.append("system_id = ?")
        params.append(system_id)
    if active is not None:
        sets.append("active = ?")
        params.append(int(active))
    if settings is not None:
        sets.append("settings = ?")
        params.append(settings.model_dump_json())
    if access_code is not None:
        sets.append("access_hash = ?")
        params.append(hash_password(access_code) if access_code else None)
    with _connect() as conn:
        conn.execute(f"UPDATE chat_links SET {', '.join(sets)} WHERE id = ?", (*params, link_id))
        if access_code is not None:  # a new code (or none): everyone is asked again
            conn.execute("UPDATE link_visitors SET granted = 0 WHERE link_id = ?", (link_id,))
    return get_link(link_id)


def rotate_token(link_id: str) -> dict:
    """A new URL; the old one stops working (and visitors start afresh)."""
    with _connect() as conn:
        conn.execute("UPDATE chat_links SET token = ? WHERE id = ?", (secrets.token_urlsafe(18), link_id))
    return get_link(link_id)


def delete_link(link_id: str) -> dict:
    """Remove a link with its visitors' profiles (and memory) and its saved
    conversations' records; returns the saved chat ids for the caller to
    delete (engine.delete_chat)."""
    with _connect() as conn:
        chats = [r["chat_id"] for r in conn.execute(
            "SELECT chat_id FROM link_conversations WHERE link_id = ? AND saved = 1", (link_id,))]
        profiles = [r["profile_id"] for r in conn.execute(
            "SELECT profile_id FROM link_visitors WHERE link_id = ? AND profile_id IS NOT NULL", (link_id,))]
        conn.execute("DELETE FROM link_conversations WHERE link_id = ?", (link_id,))
        conn.execute("DELETE FROM link_visitors WHERE link_id = ?", (link_id,))
        conn.execute("DELETE FROM chat_links WHERE id = ?", (link_id,))
    for profile_id in profiles:
        db.delete_profile(profile_id)  # and its memory notes
    return {"chats": chats, "profiles": len(profiles)}


def status(link: dict) -> str:
    """active | disabled | expired | full"""
    if not link["active"]:
        return "disabled"
    expires = link["settings"].get("expires_at")
    if expires:
        try:
            when = datetime.fromisoformat(expires)
            now = datetime.now(when.tzinfo) if when.tzinfo else datetime.now()
            if now >= when:
                return "expired"
        except ValueError:
            pass
    limit = link["settings"].get("max_conversations")
    if limit and count_conversations(link["id"]) >= limit:
        return "full"
    return "active"


def check_access_code(link: dict, code: str) -> bool:
    from .auth import verify_password
    stored = _access_hash(link["id"])
    return bool(stored) and verify_password(code or "", stored)


# ---------------------------------------------------------------- visitors

def visitor(link_id: str, cookie_value: str) -> dict:
    """The visitor of a cookie value (created on first sight)."""
    vid, ts = _hash(cookie_value), now_iso()
    with _connect() as conn:
        conn.execute("INSERT INTO link_visitors (link_id, visitor, first_seen, last_seen) VALUES (?, ?, ?, ?) "
                     "ON CONFLICT(link_id, visitor) DO UPDATE SET last_seen = excluded.last_seen",
                     (link_id, vid, ts, ts))
        return dict(conn.execute("SELECT * FROM link_visitors WHERE link_id = ? AND visitor = ?",
                                 (link_id, vid)).fetchone())


def grant(link_id: str, visitor_id: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE link_visitors SET granted = 1 WHERE link_id = ? AND visitor = ?", (link_id, visitor_id))


def visitor_profile(link: dict, v: dict) -> int | None:
    """The visitor's memory profile, when the link remembers visitors."""
    if not link["settings"]["remember_visitors"]:
        return None
    if v.get("profile_id") and db.get_profile(v["profile_id"]):
        return v["profile_id"]
    profile = db.create_profile(f"link {link['id']} visitor {v['visitor'][:10]}", origin="link")
    with _connect() as conn:
        conn.execute("UPDATE link_visitors SET profile_id = ? WHERE link_id = ? AND visitor = ?",
                     (profile["id"], link["id"], v["visitor"]))
    return profile["id"]


# ----------------------------------------------------------- conversations

def add_conversation(link: dict, visitor_id: str, chat_id: str, saved: bool, profile_id: int | None,
                     consented: bool) -> None:
    ts = now_iso()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO link_conversations (chat_id, link_id, visitor, saved, profile_id, consented_at, "
            "started_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (chat_id, link["id"], visitor_id, int(saved), profile_id, ts if consented else None, ts, ts))


def conversation(chat_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM link_conversations WHERE chat_id = ?", (chat_id,)).fetchone()
    return dict(row) if row else None


def note_turn(chat_id: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE link_conversations SET turns = turns + 1, last_at = ? WHERE chat_id = ?",
                     (now_iso(), chat_id))


def end_conversation(chat_id: str, by: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE link_conversations SET ended_at = ?, ended_by = ? WHERE chat_id = ? AND ended_at IS NULL",
                     (now_iso(), by, chat_id))


def list_conversations(link_id: str, visitor_id: str | None = None, limit: int = 500) -> list[dict]:
    sql, params = "SELECT * FROM link_conversations WHERE link_id = ?", [link_id]
    if visitor_id:
        sql += " AND visitor = ?"
        params.append(visitor_id)
    with _connect() as conn:
        rows = conn.execute(sql + " ORDER BY started_at DESC LIMIT ?", (*params, limit)).fetchall()
    return [dict(r) for r in rows]


def count_conversations(link_id: str) -> int:
    with _connect() as conn:
        return conn.execute("SELECT COUNT(*) FROM link_conversations WHERE link_id = ?", (link_id,)).fetchone()[0]


def unsaved_limits() -> dict[str, float]:
    """Idle limit (seconds) of each open unsaved conversation, by chat id."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT c.chat_id, l.settings FROM link_conversations c JOIN chat_links l ON l.id = c.link_id "
            "WHERE c.saved = 0 AND c.ended_at IS NULL").fetchall()
    return {r["chat_id"]: LinkSettings.model_validate(json.loads(r["settings"])).idle_minutes * 60 for r in rows}


def close_orphans(live: set[str]) -> None:
    """Unsaved conversations that are no longer in memory (dropped, or lost in
    a restart) are over."""
    with _connect() as conn:
        rows = conn.execute("SELECT chat_id FROM link_conversations WHERE saved = 0 AND ended_at IS NULL").fetchall()
    for r in rows:
        if r["chat_id"] not in live:
            end_conversation(r["chat_id"], "idle")


# -------------------------------------------------------------- rate limit

_recent: dict[tuple[str, str], collections.deque] = {}


def allow_message(link: dict, visitor_id: str) -> bool:
    """At most ``messages_per_minute`` per visitor of a link."""
    window = _recent.setdefault((link["id"], visitor_id), collections.deque())
    now = time.monotonic()
    while window and now - window[0] > 60:
        window.popleft()
    if len(window) >= link["settings"]["messages_per_minute"]:
        return False
    window.append(now)
    return True
