"""
Grading a simulated conversation (after BotBase's simulator judge and
rag_lab's expert-content grading).

Two layers:

* **deterministic checks** — each scenario expectation with a ``pattern``
  is matched against everything the assistant said (no model involved);
* **LLM judge** — the rubric's criteria scored within their ranges with a
  justification, and (``grade_expectations``) every scenario expectation
  graded 0-3: absent / named / explained / applied to this user.

Scores: ``score`` is the weighted criteria mean normalized to 0-100;
``expectation_score`` the mean expectation level / 3 (0-1).
"""

from __future__ import annotations

import re

from ..llm import complete, parse_json, resolve_spec
from ..schemas import ModelSpec, RubricDef, ScenarioDef

JUDGE_SYSTEM = ("You are a strict, fair evaluator of conversations between a user and an AI assistant. "
                "Grade the ASSISTANT only; the user's messages are context, not what you are grading. Be "
                "specific and consistent, cite moments in the transcript, and do not reward length for its "
                "own sake. Respond with a single JSON object only.")

LEVELS = """For EVERY expected item below, give a level:
  0 = absent.
  1 = named or alluded to only.
  2 = explained: what it is, why it helps or how to do it.
  3 = explained AND applied to this user's situation, with a concrete step, script or prompt they can use.
Count an item when its substance is present even if its name isn't used."""


def transcript_text(transcript: list[dict]) -> str:
    lines = []
    for m in transcript:
        who = "USER" if m["role"] == "user" else "ASSISTANT"
        lines.append(f"[{who}]\n{m['content']}")
    return "\n\n".join(lines) or "(empty conversation)"


def checks(scenario: ScenarioDef, transcript: list[dict]) -> dict[str, bool]:
    said = "\n".join(m["content"] for m in transcript if m["role"] == "assistant")
    return {e.name: bool(re.search(e.pattern, said)) for e in scenario.expectations if e.pattern}


def judge_prompt(rubric: RubricDef, scenario: ScenarioDef, transcript: list[dict]) -> str:
    parts = []
    if rubric.instructions.strip():
        parts.append(rubric.instructions.strip())
    situation = [f"Situation: {scenario.situation or scenario.description or scenario.opening}"]
    if scenario.facts:
        situation += [f"- {k}: {v}" for k, v in scenario.facts.items()]
    if scenario.goal:
        situation.append(f"What they wanted: {scenario.goal}")
    parts.append("THE USER'S SCENARIO (the assistant did not see this; it had to find it out):\n"
                 + "\n".join(situation))
    expected = rubric.grade_expectations and scenario.expectations
    if expected:
        parts.append(LEVELS + "\n" + "\n".join(
            f"- {e.name}" + (f": {e.description}" if e.description else "") for e in scenario.expectations))
    if rubric.criteria:
        parts.append("CRITERIA (score each within its range):\n" + "\n".join(
            f"- key: {c.key}\n  title: {c.title or c.key}\n  description: {c.description}\n"
            f"  range: {c.min} (worst) to {c.max} (best)" for c in rubric.criteria))
    parts.append("TRANSCRIPT:\n" + transcript_text(transcript))
    shape = ['"criteria": [{"key": "<criterion key>", "score": <number>, "justification": "<1-3 sentences>"}]']
    if expected:
        shape.append('"expectations": [{"name": "<item name>", "level": <0-3>, "evidence": "<short quote or why>"}]')
    shape.append('"comment": "<2-4 sentences: main strengths and what was missing>"')
    parts.append("Return exactly this JSON shape, every criterion and item exactly once, names verbatim:\n{\n  "
                 + ",\n  ".join(shape) + "\n}")
    return "\n\n".join(parts)


def score(rubric: RubricDef, scenario: ScenarioDef, data: dict) -> tuple[dict, float | None, float | None]:
    """Clamp and normalize the judge's JSON: (result, score 0-100, expectation score 0-1)."""
    given = {str(c.get("key")): c for c in data.get("criteria") or [] if isinstance(c, dict)}
    criteria, total, weighted = [], 0.0, 0.0
    for c in rubric.criteria:
        item = given.get(c.key)
        if item is None:
            criteria.append({"key": c.key, "title": c.title or c.key, "score": None, "min": c.min, "max": c.max,
                             "weight": c.weight, "justification": "(not graded)"})
            continue
        try:
            value = max(c.min, min(c.max, float(item.get("score"))))
        except (TypeError, ValueError):
            value = None
        criteria.append({"key": c.key, "title": c.title or c.key, "score": value, "min": c.min, "max": c.max,
                         "weight": c.weight, "justification": str(item.get("justification") or "")})
        if value is not None:
            weighted += c.weight * (value - c.min) / (c.max - c.min)
            total += c.weight
    result = {"criteria": criteria, "comment": str(data.get("comment") or "")}
    exp_score = None
    if rubric.grade_expectations and scenario.expectations:
        got = {str(e.get("name")).strip().lower(): e for e in data.get("expectations") or [] if isinstance(e, dict)}
        items = []
        for e in scenario.expectations:
            item = got.get(e.name.strip().lower()) or {}
            try:
                level = max(0, min(3, int(item.get("level"))))
            except (TypeError, ValueError):
                level = 0
            items.append({"name": e.name, "level": level, "evidence": str(item.get("evidence") or "")})
        result["expectations"] = items
        exp_score = round(sum(i["level"] for i in items) / (3 * len(items)), 3)
    return result, (round(100 * weighted / total, 1) if total else None), exp_score


async def judge(rubric: RubricDef, scenario: ScenarioDef, transcript: list[dict],
                model: ModelSpec | None = None) -> dict:
    """{status, result, score, expectation_score, model, cost, error}."""
    spec = resolve_spec(rubric.model, model)
    prompt = judge_prompt(rubric, scenario, transcript)
    messages = [{"role": "system", "content": JUDGE_SYSTEM}, {"role": "user", "content": prompt}]
    cost = 0.0
    last_error = "no reply"
    for _attempt in range(2):
        try:
            out = await complete(spec, messages, max_tokens=12000, temperature=0.0)
        except Exception as exc:
            return {"status": "failed", "error": f"{type(exc).__name__}: {exc}"[:500], "model": spec.model,
                    "cost": cost or None}
        cost += out.cost or 0.0
        try:
            data = parse_json(out.text)
            if not isinstance(data, dict):
                raise ValueError("the reply is not a JSON object")
        except ValueError as exc:
            last_error = str(exc)
            messages += [{"role": "assistant", "content": out.text},
                         {"role": "user", "content": f"That was not valid JSON ({exc}). Return only the JSON object."}]
            continue
        result, value, exp = score(rubric, scenario, data)
        return {"status": "completed", "result": result, "score": value, "expectation_score": exp,
                "model": spec.model, "cost": round(cost, 6) or None}
    return {"status": "failed", "error": last_error, "model": spec.model, "cost": round(cost, 6) or None}
