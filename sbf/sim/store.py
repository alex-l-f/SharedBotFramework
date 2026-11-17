"""
Simulation runs in ``sbf.db``.

    sim_runs           one per run: config, the definitions it ran on
                       (personas, scenarios, rubric) and each system's
                       snapshot hash, status and timing
    sim_conversations  one per system × scenario × persona × repetition: its
                       chat (an ordinary chat with origin 'simulation'), the
                       throwaway profile, outcome and metrics
    sim_judgments      the judge's grades of a conversation, one per rubric
                       applied (a run's rubric, or a later re-judge)
"""

from __future__ import annotations

import json
import threading
from typing import Any

from .. import db
from ..workspace import now_iso

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sim_runs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    config TEXT NOT NULL,
    definitions TEXT NOT NULL,
    systems TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
);
CREATE TABLE IF NOT EXISTS sim_conversations (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    system_id TEXT NOT NULL,
    scenario_id TEXT NOT NULL,
    persona_id TEXT NOT NULL,
    rep INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    chat_id TEXT,
    profile_id INTEGER,
    turns INTEGER NOT NULL DEFAULT 0,
    ended_by TEXT,
    error TEXT,
    started_at TEXT,
    finished_at TEXT,
    metrics TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_simconv_run ON sim_conversations(run_id, idx);
CREATE TABLE IF NOT EXISTS sim_judgments (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    rubric_id TEXT NOT NULL,
    rubric TEXT NOT NULL,
    model TEXT,
    status TEXT NOT NULL,
    result TEXT,
    score REAL,
    expectation_score REAL,
    error TEXT,
    cost REAL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_simjudge_conv ON sim_judgments(conversation_id, id);
"""

RUN_DONE = ("completed", "cancelled", "failed")
CONV_DONE = ("completed", "failed", "cancelled")

_ready = False
_lock = threading.Lock()


def _connect():
    global _ready
    if not _ready:
        with _lock:
            with db.connect() as conn:
                conn.executescript(_SCHEMA)
                if "created_by" not in {r[1] for r in conn.execute("PRAGMA table_info(sim_runs)")}:
                    conn.execute("ALTER TABLE sim_runs ADD COLUMN created_by TEXT")
            _ready = True
    return db.connect()


def _loads(value, default):
    if not value:
        return default
    try:
        return json.loads(value)
    except ValueError:
        return default


def _dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _run(row) -> dict:
    d = dict(row)
    for key, default in (("config", {}), ("definitions", {}), ("systems", {})):
        d[key] = _loads(d.get(key), default)
    return d


def _conv(row) -> dict:
    d = dict(row)
    d["metrics"] = _loads(d.get("metrics"), {})
    return d


def _judgment(row) -> dict:
    d = dict(row)
    d["rubric"] = _loads(d.get("rubric"), {})
    d["result"] = _loads(d.get("result"), {})
    return d


# --------------------------------------------------------------------- runs

def create_run(run_id: str, name: str, config: dict, definitions: dict,
               conversations: list[dict], created_by: str | None = None) -> dict:
    with _connect() as conn:
        conn.execute("INSERT INTO sim_runs (id, name, status, config, definitions, created_by, created_at) "
                     "VALUES (?, ?, 'queued', ?, ?, ?, ?)",
                     (run_id, name, _dumps(config), _dumps(definitions), created_by, now_iso()))
        conn.executemany(
            "INSERT INTO sim_conversations (run_id, idx, system_id, scenario_id, persona_id, rep) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            [(run_id, i, c["system_id"], c["scenario_id"], c["persona_id"], c["rep"])
             for i, c in enumerate(conversations)])
    return get_run(run_id)


def get_run(run_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM sim_runs WHERE id = ?", (run_id,)).fetchone()
    return _run(row) if row else None


def list_runs(limit: int = 200) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM sim_runs ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        counts = {}
        for r in conn.execute("SELECT run_id, status, COUNT(*) AS n FROM sim_conversations GROUP BY run_id, status"):
            counts.setdefault(r["run_id"], {})[r["status"]] = r["n"]
        scores = {r["run_id"]: (r["score"], r["n"]) for r in conn.execute(
            "SELECT j.run_id, AVG(j.score) AS score, COUNT(*) AS n FROM sim_judgments j "
            "JOIN sim_runs r ON r.id = j.run_id "
            "WHERE j.status = 'completed' AND j.id IN (SELECT MAX(id) FROM sim_judgments GROUP BY conversation_id) "
            "GROUP BY j.run_id")}
    out = []
    for row in rows:
        d = _run(row)
        d.pop("definitions", None)
        d["counts"] = counts.get(d["id"], {})
        score = scores.get(d["id"])
        d["mean_score"] = round(score[0], 1) if score and score[0] is not None else None
        out.append(d)
    return out


def update_run(run_id: str, **values: Any) -> None:
    if not values:
        return
    sets = ", ".join(f"{k} = ?" for k in values)
    params = [_dumps(v) if k in ("config", "definitions", "systems") else v for k, v in values.items()]
    with _connect() as conn:
        conn.execute(f"UPDATE sim_runs SET {sets} WHERE id = ?", (*params, run_id))


def delete_run(run_id: str) -> list[dict]:
    """Delete a run's records; returns its conversations (chats/profiles to clean up)."""
    convs = list_conversations(run_id)
    with _connect() as conn:
        conn.execute("DELETE FROM sim_judgments WHERE run_id = ?", (run_id,))
        conn.execute("DELETE FROM sim_conversations WHERE run_id = ?", (run_id,))
        conn.execute("DELETE FROM sim_runs WHERE id = ?", (run_id,))
    return convs


def active_runs() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM sim_runs WHERE status IN ('queued', 'running')").fetchall()
    return [_run(r) for r in rows]


# ------------------------------------------------------------ conversations

def list_conversations(run_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM sim_conversations WHERE run_id = ? ORDER BY idx",
                            (run_id,)).fetchall()
    return [_conv(r) for r in rows]


def get_conversation(conv_id: int) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM sim_conversations WHERE id = ?", (conv_id,)).fetchone()
    return _conv(row) if row else None


def update_conversation(conv_id: int, **values: Any) -> None:
    if not values:
        return
    sets = ", ".join(f"{k} = ?" for k in values)
    params = [_dumps(v) if k == "metrics" else v for k, v in values.items()]
    with _connect() as conn:
        conn.execute(f"UPDATE sim_conversations SET {sets} WHERE id = ?", (*params, conv_id))


def reset_conversation(conv_id: int) -> None:
    """Back to queued (retry): its old chat and profile are cleaned up by the caller."""
    with _connect() as conn:
        conn.execute("UPDATE sim_conversations SET status = 'queued', chat_id = NULL, profile_id = NULL, "
                     "turns = 0, ended_by = NULL, error = NULL, started_at = NULL, finished_at = NULL, "
                     "metrics = '{}' WHERE id = ?", (conv_id,))
        conn.execute("DELETE FROM sim_judgments WHERE conversation_id = ?", (conv_id,))


# ---------------------------------------------------------------- judgments

def add_judgment(conv: dict, rubric: dict, model: str, status: str, result: dict | None,
                 score: float | None, expectation_score: float | None, error: str | None,
                 cost: float | None) -> int:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO sim_judgments (conversation_id, run_id, rubric_id, rubric, model, status, result, "
            "score, expectation_score, error, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (conv["id"], conv["run_id"], rubric.get("id", ""), _dumps(rubric), model, status,
             _dumps(result or {}), score, expectation_score, error, cost, now_iso()))
        return cur.lastrowid


def judgments(run_id: str | None = None, conversation_id: int | None = None) -> list[dict]:
    sql, params = "SELECT * FROM sim_judgments WHERE 1=1", []
    if run_id:
        sql += " AND run_id = ?"
        params.append(run_id)
    if conversation_id is not None:
        sql += " AND conversation_id = ?"
        params.append(conversation_id)
    with _connect() as conn:
        return [_judgment(r) for r in conn.execute(sql + " ORDER BY id", params).fetchall()]
