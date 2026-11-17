"""
Revision history of definitions (``revisions`` in ``sbf.db``).

Every save and delete made through the workspace records the file's new
content, its version, who made it and when. Before the first recorded
change of a file that already exists (written by hand, by a script, or
before history existed), its current content is kept as a ``baseline``
revision, so any edit can be undone.

Kinds are the workspace collections (agents, systems, …), ``fragments``
and ``settings``.
"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

from . import db
from .workspace import ACTOR, now_iso, text_version

KEEP = 200  # revisions kept per definition


def record(kind: str, item_id: str, version: str | None, action: str, content: str,
           actor: str | None = None, ts: str | None = None) -> int:
    with db.connect() as conn:
        cur = conn.execute(
            "INSERT INTO revisions (kind, item_id, version, action, actor, ts, content) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (kind, item_id, version, action, actor if actor is not None else ACTOR.get(), ts or now_iso(), content))
        conn.execute(
            "DELETE FROM revisions WHERE kind = ? AND item_id = ? AND id NOT IN "
            "(SELECT id FROM revisions WHERE kind = ? AND item_id = ? ORDER BY id DESC LIMIT ?)",
            (kind, item_id, kind, item_id, KEEP))
    return cur.lastrowid


def ensure_baseline(kind: str, item_id: str, path: Path) -> None:
    """Keep the file's current content if it isn't the latest revision
    (first change, or the file was edited outside the app since)."""
    try:
        blob = path.read_bytes()
    except FileNotFoundError:
        return
    version = text_version(blob)
    with db.connect() as conn:
        last = conn.execute("SELECT version FROM revisions WHERE kind = ? AND item_id = ? ORDER BY id DESC LIMIT 1",
                            (kind, item_id)).fetchone()
    if last is not None and last["version"] == version:
        return
    text = blob.decode("utf-8", errors="replace").replace("\r\n", "\n")
    stamp = re.search(r"^updated_at: '?([^'\n]+)'?$", text, re.M)
    who = re.search(r"^updated_by: '?([^'\n]+)'?$", text, re.M)
    ts = stamp.group(1) if stamp else datetime.fromtimestamp(path.stat().st_mtime).astimezone().isoformat(
        timespec="seconds")
    record(kind, item_id, version, "baseline" if last is None else "external", text,
           actor=who.group(1) if who else "", ts=ts)


def history(kind: str, item_id: str, limit: int = 100) -> list[dict]:
    """Newest first, without content."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT id, kind, item_id, version, action, actor, ts, length(content) AS size FROM revisions "
            "WHERE kind = ? AND item_id = ? ORDER BY id DESC LIMIT ?", (kind, item_id, limit)).fetchall()
    return [dict(r) for r in rows]


def get(rev_id: int) -> dict | None:
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM revisions WHERE id = ?", (rev_id,)).fetchone()
    return dict(row) if row else None


def last_change(kind: str, item_id: str) -> dict | None:
    with db.connect() as conn:
        row = conn.execute("SELECT id, version, action, actor, ts FROM revisions WHERE kind = ? AND item_id = ? "
                           "ORDER BY id DESC LIMIT 1", (kind, item_id)).fetchone()
    return dict(row) if row else None


def recent(limit: int = 50, actor: str | None = None) -> list[dict]:
    """The latest changes across all definitions (activity feed)."""
    sql = "SELECT id, kind, item_id, version, action, actor, ts FROM revisions WHERE action IN ('save', 'delete', 'import')"
    params: list = []
    if actor:
        sql += " AND actor = ?"
        params.append(actor)
    with db.connect() as conn:
        rows = conn.execute(sql + " ORDER BY id DESC LIMIT ?", (*params, limit)).fetchall()
    return [dict(r) for r in rows]
