"""
What a simulation produced: transcripts, metrics, per-system summaries and
raw exports.

Everything is derived from the stored chat (outputs, traces, the ADK
session) plus the run's records, so a conversation can be re-judged or
re-exported at any time.
"""

from __future__ import annotations

import csv
import io
import math
from collections import Counter, defaultdict

from .. import db
from . import store
from .simulator import assistant_view


# ---------------------------------------------------------------- transcript

def transcript(chat_id: str | None) -> list[dict]:
    """The conversation as the user saw it: user messages and, per turn, the
    assistant's messages with a note for each file / page it showed."""
    if not chat_id:
        return []
    by_turn: dict[int, list[dict]] = defaultdict(list)
    users: dict[int, str] = {}
    for o in db.list_outputs(chat_id):
        if o["type"] == "user":
            users[o["turn"]] = o.get("content") or ""
        else:
            by_turn[o["turn"]].append(o)
    out = []
    for turn in sorted(set(users) | set(by_turn)):
        if turn in users:
            out.append({"role": "user", "content": users[turn], "turn": turn})
        out.append({"role": "assistant", "content": assistant_view(by_turn.get(turn, [])), "turn": turn})
    return out


# ------------------------------------------------------------------- metrics

def chat_metrics(chat_id: str | None) -> dict:
    """Model calls, tokens, tools, retrieval and recovery events of a chat."""
    if not chat_id:
        return {}
    llm: dict[str, dict] = defaultdict(lambda: {"calls": 0, "prompt_tokens": 0, "output_tokens": 0,
                                                "thinking_tokens": 0, "seconds": 0.0})
    tools: Counter = Counter()
    events: Counter = Counter()
    retrieval = {"calls": 0, "llm_calls": 0, "cost": 0.0}
    for t in db.list_traces(chat_id):
        d = t["data"] if isinstance(t["data"], dict) else {}
        ev = t["event"]
        if ev == "llm_call":
            a = llm[t["agent"]]
            a["calls"] += 1
            for k in ("prompt_tokens", "output_tokens", "thinking_tokens"):
                a[k] += int(d.get(k) or 0)
            a["seconds"] += float(d.get("seconds") or 0)
        elif ev == "tool_call":
            tools[d.get("name") or "?"] += 1
        elif ev in ("retrieval", "context"):
            retrieval["calls"] += 1
            retrieval["llm_calls"] += int(d.get("llm_calls") or 0)
            retrieval["cost"] += float(d.get("cost") or 0)
        elif ev in ("reply_recovery", "reply_fallback", "run_error", "context_error", "nudge"):
            events[ev] += 1
    total = {k: sum(a[k] for a in llm.values()) for k in ("calls", "prompt_tokens", "output_tokens",
                                                          "thinking_tokens")}
    for a in llm.values():
        a["seconds"] = round(a["seconds"], 2)
    retrieval["cost"] = round(retrieval["cost"], 6)
    return {"llm": dict(llm), "llm_total": total, "tools": dict(tools), "retrieval": retrieval,
            "events": dict(events)}


def latest_judgments(run_id: str, rubric_id: str | None = None) -> dict[int, dict]:
    """conversation id → its most recent judgment (for one rubric if given)."""
    out: dict[int, dict] = {}
    for j in store.judgments(run_id):
        if rubric_id and j["rubric_id"] != rubric_id:
            continue
        out[j["conversation_id"]] = j
    return out


# ------------------------------------------------------------------- summary

def _stats(values: list[float]) -> dict | None:
    values = [v for v in values if v is not None]
    if not values:
        return None
    n = len(values)
    mean = sum(values) / n
    sd = math.sqrt(sum((v - mean) ** 2 for v in values) / (n - 1)) if n > 1 else 0.0
    half = 1.96 * sd / math.sqrt(n) if n > 1 else 0.0
    return {"n": n, "mean": round(mean, 3), "sd": round(sd, 3),
            "ci95": [round(mean - half, 3), round(mean + half, 3)]}


def summary(run_id: str, rubric_id: str | None = None) -> dict:
    run = store.get_run(run_id)
    if run is None:
        return {}
    rubric_id = rubric_id or run["config"].get("rubric") or None
    convs = store.list_conversations(run_id)
    judged = latest_judgments(run_id, rubric_id)
    systems: dict[str, list[dict]] = defaultdict(list)
    for c in convs:
        systems[c["system_id"]].append(c)
    out_systems = []
    matrix: dict[str, dict[str, dict]] = defaultdict(dict)
    for sid, cs in systems.items():
        js = [judged.get(c["id"]) for c in cs]
        done = [c for c in cs if c["status"] == "completed"]
        checks = [sum(m.values()) / len(m) for c in done if (m := c["metrics"].get("checks"))]
        criteria: dict[str, list[float]] = defaultdict(list)
        expectations: dict[str, list[float]] = defaultdict(list)
        for j in js:
            if not j or j["status"] != "completed":
                continue
            for cr in j["result"].get("criteria") or []:
                if cr.get("score") is not None:
                    criteria[cr["key"]].append(cr["score"])
            for e in j["result"].get("expectations") or []:
                expectations[e["name"]].append(e["level"])
        out_systems.append({
            "system": sid, "snapshot": run["systems"].get(sid), "conversations": len(cs),
            "status": dict(Counter(c["status"] for c in cs)),
            "ended_by": dict(Counter(c["ended_by"] for c in done if c["ended_by"])),
            "score": _stats([j["score"] for j in js if j and j["status"] == "completed"]),
            "expectation_score": _stats([j["expectation_score"] for j in js if j and j["status"] == "completed"]),
            "check_recall": _stats(checks),
            "turns": _stats([c["turns"] for c in done]),
            "seconds_per_turn": _stats([s for c in done for s in c["metrics"].get("turn_seconds", [])]),
            "llm_calls": _stats([c["metrics"].get("chat", {}).get("llm_total", {}).get("calls") for c in done]),
            "tokens": _stats([(c["metrics"].get("chat", {}).get("llm_total", {}).get("prompt_tokens") or 0)
                              + (c["metrics"].get("chat", {}).get("llm_total", {}).get("output_tokens") or 0)
                              for c in done]),
            "criteria": {k: _stats(v) for k, v in criteria.items()},
            "expectations": {k: _stats(v) for k, v in expectations.items()},
            "issues": dict(sum((Counter(c["metrics"].get("chat", {}).get("events", {})) for c in cs), Counter())),
        })
        by_scenario: dict[str, list[float]] = defaultdict(list)
        for c, j in zip(cs, js):
            if j and j["status"] == "completed" and j["score"] is not None:
                by_scenario[c["scenario_id"]].append(j["score"])
        for scen, values in by_scenario.items():
            matrix[sid][scen] = _stats(values)
    costs = {"simulator": round(sum(c["metrics"].get("simulator", {}).get("cost") or 0 for c in convs), 4),
             "retrieval": round(sum(c["metrics"].get("chat", {}).get("retrieval", {}).get("cost") or 0
                                    for c in convs), 4),
             "judge": round(sum(j["cost"] or 0 for j in judged.values()), 4)}
    return {"run": run_id, "rubric": rubric_id, "systems": out_systems, "by_scenario": matrix, "costs": costs,
            "rubrics": sorted({j["rubric_id"] for j in store.judgments(run_id)})}


# -------------------------------------------------------------------- export

def conversation_record(run: dict, conv: dict, judgments: list[dict], *, full: bool = True) -> dict:
    """Everything about one conversation, for offline analysis."""
    defs = run["definitions"]
    record = {
        "run_id": run["id"], "run_name": run["name"], "conversation_id": conv["id"], "index": conv["idx"],
        "system": conv["system_id"], "snapshot": run["systems"].get(conv["system_id"]),
        "scenario": conv["scenario_id"], "persona": conv["persona_id"], "rep": conv["rep"],
        "status": conv["status"], "turns": conv["turns"], "ended_by": conv["ended_by"], "error": conv["error"],
        "started_at": conv["started_at"], "finished_at": conv["finished_at"], "chat_id": conv["chat_id"],
        "metrics": conv["metrics"], "transcript": transcript(conv["chat_id"]),
        "judgments": [{k: j[k] for k in ("rubric_id", "model", "status", "score", "expectation_score",
                                         "result", "error", "cost", "created_at")} for j in judgments],
    }
    if full and conv["chat_id"]:
        record["outputs"] = db.list_outputs(conv["chat_id"])
        record["traces"] = db.list_traces(conv["chat_id"])
        record["scenario_def"] = defs.get("scenarios", {}).get(conv["scenario_id"])
        record["persona_def"] = defs.get("personas", {}).get(conv["persona_id"])
    return record


def records(run_id: str, *, full: bool = True):
    run = store.get_run(run_id)
    by_conv: dict[int, list[dict]] = defaultdict(list)
    for j in store.judgments(run_id):
        by_conv[j["conversation_id"]].append(j)
    for conv in store.list_conversations(run_id):
        yield conversation_record(run, conv, by_conv.get(conv["id"], []), full=full)


def csv_text(run_id: str, rubric_id: str | None = None) -> str:
    """One row per conversation: identifiers, outcome, metrics and the
    latest judgment's scores (one column per criterion / expectation)."""
    run = store.get_run(run_id)
    rubric_id = rubric_id or run["config"].get("rubric") or None
    judged = latest_judgments(run_id, rubric_id)
    convs = store.list_conversations(run_id)
    crit_keys, exp_names, check_names = [], [], []
    for j in judged.values():
        for c in j["result"].get("criteria") or []:
            if c["key"] not in crit_keys:
                crit_keys.append(c["key"])
        for e in j["result"].get("expectations") or []:
            if e["name"] not in exp_names:
                exp_names.append(e["name"])
    for c in convs:
        for name in c["metrics"].get("checks") or {}:
            if name not in check_names:
                check_names.append(name)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["run_id", "conversation_id", "system", "snapshot", "scenario", "persona", "rep", "status",
                "turns", "ended_by", "seconds_total", "llm_calls", "prompt_tokens", "output_tokens",
                "simulator_cost", "retrieval_cost", "judge_cost", "rubric", "score", "expectation_score"]
               + [f"crit:{k}" for k in crit_keys] + [f"exp:{n}" for n in exp_names]
               + [f"check:{n}" for n in check_names] + ["chat_id", "error"])
    for c in convs:
        m, j = c["metrics"], judged.get(c["id"])
        total = m.get("chat", {}).get("llm_total", {})
        crit = {x["key"]: x["score"] for x in (j["result"].get("criteria") or [])} if j else {}
        exp = {x["name"]: x["level"] for x in (j["result"].get("expectations") or [])} if j else {}
        w.writerow([run_id, c["id"], c["system_id"], run["systems"].get(c["system_id"]), c["scenario_id"],
                    c["persona_id"], c["rep"], c["status"], c["turns"], c["ended_by"],
                    round(sum(m.get("turn_seconds", [])), 2), total.get("calls"), total.get("prompt_tokens"),
                    total.get("output_tokens"), m.get("simulator", {}).get("cost"),
                    m.get("chat", {}).get("retrieval", {}).get("cost"), j["cost"] if j else None,
                    j["rubric_id"] if j else None, j["score"] if j else None,
                    j["expectation_score"] if j else None]
                   + [crit.get(k) for k in crit_keys] + [exp.get(n) for n in exp_names]
                   + [int(m["checks"][n]) if n in (m.get("checks") or {}) else None for n in check_names]
                   + [c["chat_id"], c["error"]])
    return buf.getvalue()
