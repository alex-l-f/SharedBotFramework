"""
Guards: classifiers attached to the nodes of a running system.

Input guards check the user's message before any agent runs (all input
guards of the system run, in parallel); output guards check each message a
node sends before the user sees it (``deliver_checked``). Every verdict is
a ``guard`` trace; what happens on an unsafe verdict is the first matching
rule of the guard (see ``GuardDef``).
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from ..schemas import GuardDef, GuardRule
from .classifiers import Verdict, classify

if TYPE_CHECKING:
    from ..runtime.context import AgentRun, Turn

INFORM_NOTE = ("A safety check flagged the user's last message ({categories}). Respond with care: acknowledge "
               "what they said, don't give details that could cause harm, and point to appropriate support "
               "(a trusted person, a professional, or a crisis line) where it fits.")
REGENERATE_NOTE = ("Your last message was NOT delivered: a safety check flagged it ({categories}). Write a "
                   "different reply that avoids this — no harmful details, no diagnoses or medication advice, "
                   "and point to appropriate support where it fits.")
PRIORITY = {"block": 0, "regenerate": 0, "replace": 1, "inform": 2, "add_message": 3, "flag": 4}


def matching_rule(guard: GuardDef, verdict: Verdict) -> GuardRule | None:
    """The first rule for an unsafe verdict (rules naming categories match
    when any verdict category contains, or is contained in, one of them)."""
    if verdict.safe:
        return None
    found = [c.lower() for c in verdict.categories]
    for rule in guard.effective_rules():
        if not rule.categories:
            return rule
        wanted = [c.lower() for c in rule.categories]
        if any(w in f or f in w for w in wanted for f in found):
            return rule
    return None


def _cats(verdict: Verdict) -> str:
    return ", ".join(verdict.categories) or verdict.label


async def _run(turn: "Turn", guards: list[GuardDef], messages: list[dict]) -> list[tuple[GuardDef, Verdict]]:
    classifiers = turn.system.classifiers
    verdicts = await asyncio.gather(*(classify(classifiers[g.classifier], messages) for g in guards))
    return list(zip(guards, verdicts))


def _trace(turn: "Turn", run_id: str | None, guard: GuardDef, verdict: Verdict, rule: GuardRule | None,
           outcome: str) -> None:
    data = {"guard": guard.id, "classifier": guard.classifier, "check": guard.check, "safe": verdict.safe,
            "label": verdict.label, "categories": verdict.categories, "action": rule.action if rule else None,
            "outcome": outcome, "latency_ms": verdict.latency_ms, "error": verdict.error}
    turn.trace(guard.node, run_id, "guard", data, persist={"scores": verdict.scores, "detail": verdict.detail})
    turn.guard_events.append(data)


async def check_input(turn: "Turn") -> str | None:
    """Run the system's input guards on the user's message. Returns the reply
    that replaces the agents' (a ``block`` rule), else None; ``inform`` notes
    go to ``turn.safety_notes`` and ``add_message`` messages to the user."""
    guards = [g for g in turn.system.guards if g.check == "input"]
    if not guards:
        return None
    results = await _run(turn, guards, [{"role": "user", "content": turn.user_message}])
    blocked: str | None = None
    for guard, verdict in sorted(results, key=lambda gv: PRIORITY[(matching_rule(*gv) or GuardRule(action="flag")).action]):
        rule = matching_rule(guard, verdict)
        if rule is None or blocked is not None:
            _trace(turn, None, guard, verdict, rule, "passed" if rule is None else "superseded")
            continue
        if rule.action == "block":
            blocked = rule.message or "I can't help with that."
        elif rule.action == "inform":
            turn.safety_notes.setdefault(guard.node, []).append(
                rule.message or INFORM_NOTE.format(categories=_cats(verdict)))
        elif rule.action == "add_message" and rule.message:
            turn.emit_output("message", guard.node, {"content": rule.message, "safety": True})
            turn.safety_notes.setdefault(guard.node, []).append(
                f"Before your reply, the user was shown this safety message: \"{rule.message}\". "
                "Don't repeat it; continue the conversation with care.")
        _trace(turn, None, guard, verdict, rule, rule.action)
    return blocked


async def deliver_checked(run: "AgentRun", text: str) -> str | None:
    """``deliver_message`` behind the node's output guards. Returns what the
    agent is told (None: delivered as written)."""
    from ..runtime.context import deliver_message
    turn = run.turn
    guards = [g for g in turn.system.guards if g.check == "output" and g.node == run.node.id]
    if not guards or not text.strip():
        return deliver_message(run, text)
    by_scope: dict[str, list[GuardDef]] = {}
    for g in guards:
        by_scope.setdefault(g.scope, []).append(g)
    results: list[tuple[GuardDef, Verdict]] = []
    for scope, group in by_scope.items():
        messages = ([{"role": "user", "content": turn.user_message}] if scope == "exchange" else []) + \
                   [{"role": "assistant", "content": text}]
        results += await _run(turn, group, messages)
    matched = sorted(((g, v, matching_rule(g, v)) for g, v in results),
                     key=lambda t: PRIORITY[t[2].action] if t[2] else 9)
    top = next(((g, v, r) for g, v, r in matched if r), None)
    for g, v, r in matched:
        if r is None:
            _trace(turn, run.id, g, v, None, "passed")
    if top is None:
        return deliver_message(run, text)
    guard, verdict, rule = top
    others = [(g, v, r) for g, v, r in matched if r and g is not guard]
    if rule.action == "regenerate":
        tries = turn.guard_retries.get(run.node.id, 0)
        if tries < guard.max_retries:
            turn.guard_retries[run.node.id] = tries + 1
            turn.guard_feedback = REGENERATE_NOTE.format(categories=_cats(verdict))
            turn.guard_replacement = rule.message or turn.guard_replacement
            _trace(turn, run.id, guard, verdict, rule, f"regenerate ({tries + 1}/{guard.max_retries})")
            for g, v, r in others:
                _trace(turn, run.id, g, v, r, "superseded")
            return "BLOCKED: " + turn.guard_feedback
        rule = GuardRule(action="replace", message=rule.message)
    if rule.action == "replace":
        _trace(turn, run.id, guard, verdict, rule, "replaced")
        for g, v, r in others:
            _trace(turn, run.id, g, v, r, "superseded")
        deliver_message(run, rule.message or "I'm sorry — I can't send that reply.")
        turn.guard_feedback = ""
        return ("REPLACED: a safety check stopped your message and the user was shown a safety message "
                "instead. Do not send anything else this turn; end your turn.")
    error = deliver_message(run, text)
    for g, v, r in [(guard, verdict, rule), *others]:
        if r.action == "add_message" and r.message and error is None:
            deliver_message(run, r.message)
        _trace(turn, run.id, g, v, r, r.action)
    return error
