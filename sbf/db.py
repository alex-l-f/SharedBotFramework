"""
Runtime database (``<data>/sbf.db``).

ADK keeps each chat's model-facing history (events, state) in its own
SQLite session store (``<data>/sessions.db``). This database holds what the
framework adds around it:

* chats      — one row per conversation: system, profile, origin (chat UI,
               a simulation run, or a public chat link)
* outputs    — the transcript as the user saw it: user messages, delivered
               replies, files, viewer pages, mode switches (render + export)
* traces     — every agent event (model calls, tool calls/results, spawns),
               the analysis corpus
* snapshots  — the resolved definitions a turn ran on, keyed by content hash
* profiles   — end users (memory scope); ``origin`` 'simulation' marks the
               throwaway profiles of simulated users
* users, auth_sessions — accounts and sign-in sessions (``sbf.auth``);
               chats and profiles have an owner (``user_id``, NULL when
               created without accounts)
* revisions  — every saved version of every definition (``sbf.revisions``)

Memory notes live in the same file (``sbf.memory.store``).
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from typing import Any

from .settings import DATA_DIR
from .workspace import now_iso

DB_PATH = DATA_DIR / "sbf.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    origin TEXT NOT NULL DEFAULT 'user',
    user_id INTEGER,
    created_at TEXT NOT NULL,
    last_active TEXT
);
CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    system_id TEXT NOT NULL,
    profile_id INTEGER,
    title TEXT,
    origin TEXT NOT NULL DEFAULT 'chat',
    run_id TEXT,
    user_id INTEGER,
    link_id TEXT,
    turns INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_system ON chats(system_id, updated_at);
CREATE TABLE IF NOT EXISTS outputs (
    id INTEGER PRIMARY KEY,
    chat_id TEXT NOT NULL,
    turn INTEGER NOT NULL,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    node TEXT,
    payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outputs_chat ON outputs(chat_id, id);
CREATE TABLE IF NOT EXISTS traces (
    id INTEGER PRIMARY KEY,
    chat_id TEXT NOT NULL,
    turn INTEGER NOT NULL,
    ts TEXT NOT NULL,
    agent TEXT NOT NULL,
    run TEXT,
    event TEXT NOT NULL,
    data TEXT
);
CREATE INDEX IF NOT EXISTS idx_traces_chat ON traces(chat_id, id);
CREATE TABLE IF NOT EXISTS snapshots (
    hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turn_snapshots (
    chat_id TEXT NOT NULL,
    turn INTEGER NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (chat_id, turn)
);
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_login TEXT
);
CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created REAL NOT NULL,
    expires REAL NOT NULL,
    last_seen REAL NOT NULL,
    user_agent TEXT,
    ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE TABLE IF NOT EXISTS revisions (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    version TEXT,
    action TEXT NOT NULL,
    actor TEXT,
    ts TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_revisions_item ON revisions(kind, item_id, id);
"""

_init_lock = threading.Lock()
_initialized = False


def _migrate(conn) -> None:
    """Columns added after a database was created."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(profiles)")}
    if "origin" not in cols:
        conn.execute("ALTER TABLE profiles ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'")
    if "user_id" not in cols:
        conn.execute("ALTER TABLE profiles ADD COLUMN user_id INTEGER")
    chat_cols = {r[1] for r in conn.execute("PRAGMA table_info(chats)")}
    if "user_id" not in chat_cols:
        conn.execute("ALTER TABLE chats ADD COLUMN user_id INTEGER")
    if "link_id" not in chat_cols:
        conn.execute("ALTER TABLE chats ADD COLUMN link_id TEXT")
    conn.commit()


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


@contextmanager
def connect():
    global _initialized
    if not _initialized:
        with _init_lock:
            if not _initialized:
                DATA_DIR.mkdir(parents=True, exist_ok=True)
                conn = sqlite3.connect(DB_PATH)
                conn.execute("PRAGMA journal_mode=WAL")
                conn.executescript(_SCHEMA)
                _migrate(conn)
                conn.close()
                _initialized = True
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        with conn:
            yield conn
    finally:
        conn.close()


# ------------------------------------------------------------------ profiles

_OWNER_ANY = object()


def list_profiles(origin: str | None = "user", user_id=_OWNER_ANY) -> list[dict]:
    """Profiles of an origin; ``user_id`` limits them to one owner."""
    clauses, params = [], []
    if origin:
        clauses.append("p.origin = ?")
        params.append(origin)
    if user_id is not _OWNER_ANY:
        clauses.append("p.user_id IS ?")
        params.append(user_id)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with connect() as conn:
        count = ("(SELECT COUNT(*) FROM memories m WHERE m.profile_id = p.id)"
                 if _has_table(conn, "memories") else "0")
        rows = conn.execute(
            f"SELECT p.*, u.username AS owner, {count} AS memories FROM profiles p "
            f"LEFT JOIN users u ON u.id = p.user_id {where} "
            "ORDER BY COALESCE(p.last_active, p.created_at) DESC", params).fetchall()
    return [dict(r) for r in rows]


def _has_table(conn, name: str) -> bool:
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                        (name,)).fetchone() is not None


def create_profile(name: str, origin: str = "user", user_id: int | None = None) -> dict:
    name = (name or "").strip()
    if not name or len(name) > 80:
        raise ValueError("Profile name must be 1-80 characters")
    with connect() as conn:
        try:
            cur = conn.execute("INSERT INTO profiles (name, origin, user_id, created_at) VALUES (?, ?, ?, ?)",
                               (name, origin, user_id, now_iso()))
        except sqlite3.IntegrityError:
            raise ValueError(f"A profile named {name!r} already exists") from None
        return dict(conn.execute("SELECT * FROM profiles WHERE id = ?",
                                 (cur.lastrowid,)).fetchone())


def find_profile(name: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM profiles WHERE name = ?", (name,)).fetchone()
    return dict(row) if row else None


def get_profile(profile_id: int | None) -> dict | None:
    if not profile_id:
        return None
    with connect() as conn:
        row = conn.execute("SELECT * FROM profiles WHERE id = ?", (profile_id,)).fetchone()
    return dict(row) if row else None


def delete_profile(profile_id: int) -> bool:
    """Delete a profile and its memory notes."""
    from .memory import memory_store
    memory_store.delete_profile_notes(profile_id)
    with connect() as conn:
        cur = conn.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))
    return cur.rowcount > 0


# --------------------------------------------------------------------- chats

def create_chat(chat_id: str, system_id: str, profile_id: int | None,
                origin: str = "chat", run_id: str | None = None,
                title: str | None = None, user_id: int | None = None, link_id: str | None = None) -> dict:
    ts = now_iso()
    with connect() as conn:
        conn.execute(
            "INSERT INTO chats (id, system_id, profile_id, title, origin, run_id, user_id, link_id, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (chat_id, system_id, profile_id, title, origin, run_id, user_id, link_id, ts, ts))
    return get_chat(chat_id)


def get_chat(chat_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT c.*, u.username AS owner FROM chats c "
                           "LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?", (chat_id,)).fetchone()
    return dict(row) if row else None


def adopt_unowned(user_id: int) -> dict:
    """Give chats and profiles made before accounts existed to ``user_id``
    (the first admin)."""
    with connect() as conn:
        chats = conn.execute("UPDATE chats SET user_id = ? WHERE user_id IS NULL AND origin = 'chat'",
                             (user_id,)).rowcount
        profiles = conn.execute("UPDATE profiles SET user_id = ? WHERE user_id IS NULL AND origin = 'user'",
                                (user_id,)).rowcount
    return {"chats": chats, "profiles": profiles}


def list_chats(system_id: str | None = None, origin: str | None = "chat",
               limit: int = 100, user_id=_OWNER_ANY) -> list[dict]:
    """Chats, newest first; ``user_id`` limits them to one owner."""
    sql = ("SELECT c.*, p.name AS profile_name, u.username AS owner FROM chats c "
           "LEFT JOIN profiles p ON p.id = c.profile_id LEFT JOIN users u ON u.id = c.user_id WHERE 1=1")
    params: list = []
    if user_id is not _OWNER_ANY:
        sql += " AND c.user_id IS ?"
        params.append(user_id)
    if system_id:
        sql += " AND c.system_id = ?"
        params.append(system_id)
    if origin:
        sql += " AND c.origin = ?"
        params.append(origin)
    sql += " ORDER BY c.updated_at DESC LIMIT ?"
    params.append(limit)
    with connect() as conn:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]


def begin_turn(chat_id: str, first_message: str) -> int:
    """Increment the chat's turn counter; returns the new turn number."""
    with connect() as conn:
        row = conn.execute("SELECT turns, title FROM chats WHERE id = ?", (chat_id,)).fetchone()
        turn = row["turns"] + 1
        title = row["title"] or first_message.strip().replace("\n", " ")[:60]
        conn.execute("UPDATE chats SET turns = ?, title = ?, updated_at = ? WHERE id = ?",
                     (turn, title, now_iso(), chat_id))
    return turn


def delete_chat(chat_id: str) -> None:
    with connect() as conn:
        for table in ("outputs", "traces", "turn_snapshots"):
            conn.execute(f"DELETE FROM {table} WHERE chat_id = ?", (chat_id,))
        conn.execute("DELETE FROM chats WHERE id = ?", (chat_id,))


# ------------------------------------------------------------ outputs/traces

def add_output(chat_id: str, turn: int, type_: str, node: str | None, payload: dict) -> int:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO outputs (chat_id, turn, ts, type, node, payload) VALUES (?, ?, ?, ?, ?, ?)",
            (chat_id, turn, now_iso(), type_, node, _dumps(payload)))
    return cur.lastrowid


def list_outputs(chat_id: str) -> list[dict]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM outputs WHERE chat_id = ? ORDER BY id",
                            (chat_id,)).fetchall()
    return [{"id": r["id"], "turn": r["turn"], "ts": r["ts"], "type": r["type"],
             "node": r["node"], **json.loads(r["payload"])} for r in rows]


def add_trace(chat_id: str, turn: int, agent: str, run: str | None, event: str, data) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO traces (chat_id, turn, ts, agent, run, event, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (chat_id, turn, now_iso(), agent, run, event, _dumps(data)))


def list_traces(chat_id: str, turn: int | None = None) -> list[dict]:
    sql = "SELECT * FROM traces WHERE chat_id = ?"
    params: list = [chat_id]
    if turn is not None:
        sql += " AND turn = ?"
        params.append(turn)
    with connect() as conn:
        rows = conn.execute(sql + " ORDER BY id", params).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["data"] = json.loads(d["data"]) if d["data"] else None
        except json.JSONDecodeError:
            pass
        out.append(d)
    return out


# ----------------------------------------------------------------- snapshots

def save_snapshot(hash_: str, data: dict) -> None:
    with connect() as conn:
        conn.execute("INSERT OR IGNORE INTO snapshots (hash, created_at, data) VALUES (?, ?, ?)",
                     (hash_, now_iso(), _dumps(data)))


def link_turn_snapshot(chat_id: str, turn: int, hash_: str) -> None:
    with connect() as conn:
        conn.execute("INSERT OR REPLACE INTO turn_snapshots (chat_id, turn, hash) VALUES (?, ?, ?)",
                     (chat_id, turn, hash_))


def get_snapshot(hash_: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT data FROM snapshots WHERE hash = ?", (hash_,)).fetchone()
    return json.loads(row["data"]) if row else None
