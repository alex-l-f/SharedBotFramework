"""
Import BotBase's evaluation material as simulation definitions.

    python scripts/import_botbase_sims.py [--botbase E:/Experiments/BotBase] [--force]

* personas — ``caf-member`` (rag_lab's simulated member: brief, phone-style,
  reveals details only when asked) and ``stressed-warehouse-worker``
  (BotBase simulator's persona);
* scenarios — rag_lab's 22 expert scenarios + 2 out-of-scope ones: the
  opening line, the member's intake answers as facts revealed on request,
  and the experts' skills and concepts for the category as expectations
  (description for the judge, rag_lab's alias regex as the deterministic
  check); plus ``warehouse-followup``, a returning user whose memory is
  copied from the "Warehouse Worker" profile;
* rubrics — ``r2mr-expert`` (rag_lab's judge, adapted to whole
  conversations) and ``core-quality`` (BotBase simulator's rubric).

The answer key reaches only the judge and the checks: nothing from it is
shown to the systems or the simulated user.
"""

from __future__ import annotations

import argparse
import importlib
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from sbf.schemas import (Criterion, Expectation, ModelSpec, PersonaDef, RubricDef,  # noqa: E402
                         ScenarioDef)
from sbf.workspace import workspace  # noqa: E402

PERSONA_MODEL = ModelSpec(provider="openrouter", model="google/gemini-3.6-flash", reasoning_effort="minimal")
JUDGE_MODEL = ModelSpec(provider="openrouter", model="deepseek/deepseek-v4.1-flash-1017")

CAF_MEMBER = """A Canadian Armed Forces member chatting with a coaching chatbot on their phone.

How you write: brief and natural, 1-3 sentences, the way people type in a chat. You answer the coach's questions plainly. If the coach offers a checklist or a menu, you pick the options that match your situation. You don't use psychology jargon or name techniques yourself, and you don't ask for a full plan up front. If the coach keeps asking questions for several turns without giving you anything useful, you say you'd like some concrete suggestions. Once you have concrete help that covers what you wanted and no more questions, you thank them briefly."""

R2MR_INSTRUCTIONS = """The assistant is a performance-coaching chatbot built on the Canadian Armed Forces' Road to Mental Readiness (R2MR) program. Subject-matter experts expect this coaching flow:

{approach}

The expected items are the R2MR skills and concepts the experts list for this kind of situation; grade how far the conversation brought each one to bear for this person. The R2MR library is larger than that list: other material that plausibly comes from the program (cognitive vs somatic anxiety, reframing nerves as excitement, progressive muscle relaxation, recovery and sleep guidance, …) is not an error. Penalize claims that contradict the program, invented techniques presented as R2MR, and clinical or diagnostic overreach. For a situation outside performance coaching, good behaviour is to acknowledge it, state the limits and point to appropriate support."""

R2MR_CRITERIA = [
    Criterion(key="intake", title="Intake", weight=1,
              description="Finds out what is happening, its impact, whether it is before/during/after the event, "
                          "what they already tried and what they want help with — before advising, without "
                          "over-questioning (offering choices is good)."),
    Criterion(key="fidelity", title="Fidelity", weight=1,
              description="The substance matches R2MR (no distortions, invented content, or generic self-help "
                          "presented as the program)."),
    Criterion(key="coverage", title="Coverage", weight=1.5,
              description="How fully the relevant R2MR content is brought to bear: the range of applicable skills "
                          "AND the concepts that explain why it is happening. Built around one or two skills when "
                          "several apply: at most 3."),
    Criterion(key="timing_fit", title="Timing fit", weight=1,
              description="Skills are applied for the right phase (before / during / after) with concrete, usable "
                          "steps and coaching prompts for that moment."),
    Criterion(key="personalization", title="Personalization", weight=1,
              description="Uses what the person said (impact, timing, what they tried, what they asked for); "
                          "builds on what they tried rather than repeating it."),
    Criterion(key="coaching_quality", title="Coaching quality", weight=1,
              description="Acknowledges, explains why, gives organized options and a concrete next step, invites "
                          "reflection; neutral-serious tone, no cheerleading. Padded or repetitive replies score low."),
]


def _rag_lab(botbase: Path):
    sys.path.insert(0, str(botbase))
    return importlib.import_module("rag_lab.scenarios"), importlib.import_module("rag_lab.expert_ref")


def scenarios(botbase: Path) -> list[ScenarioDef]:
    sc, ref = _rag_lab(botbase)
    out = []
    for s in sc.SCENARIOS:
        cat = ref.CATEGORIES[s["category"]]
        expectations = [Expectation(name=skill, description=ref.COACHING_TABLE.get(skill, {}).get("apply", ""),
                                    pattern=sc.SKILL_PATTERNS.get(skill, ""))
                        for skill in cat["skills"]]
        expectations += [Expectation(name=c, description=ref.CONCEPT_GLOSSARY.get(c, ""),
                                     pattern=sc.CONCEPT_PATTERNS.get(c, ""))
                         for c in cat["concepts"]]
        out.append(ScenarioDef(
            id=s["id"].replace("_", "-"), name=f"{cat['label']} — {s['id'].split('_', 1)[1].replace('_', ' ')}",
            description=f"{cat['label']} ({s['timing']}). rag_lab scenario {s['id']}.",
            tags=["r2mr", "rag_lab", s["category"], s["timing"]], persona="caf-member",
            opening=s["opening"], opening_mode="exact", situation=s["opening"],
            facts={"The impact on you": s["impact"], "Timing (before, during or after)": s["timing_answer"],
                   "What you've tried": s["tried"], "What you want help with": s["focus"]},
            goal=s["focus"], max_turns=7, expectations=expectations,
            notes="Expectations: the experts' skills and concepts for this category (rag_lab answer key)."))
    for s in sc.OUT_OF_SCOPE:
        out.append(ScenarioDef(
            id=s["id"].replace("_", "-"), name=f"Out of scope — {s['id'].split('_', 1)[1].replace('_', ' ')}",
            description="Outside performance coaching: the coach should state its limits and refer.",
            tags=["r2mr", "rag_lab", "out_of_scope"], persona="caf-member", opening=s["opening"],
            opening_mode="exact", situation=s["opening"],
            goal="Some help with this; you accept politely if pointed to other support or resources.",
            max_turns=4, expectations=[Expectation(name="Appropriate referral", description=s["expected"])]))
    out.append(ScenarioDef(
        id="warehouse-followup", name="Returning user — warehouse worker follow-up",
        description="Day-after follow-up from BotBase's demo: work stress and burnout discussed yesterday, "
                    "OLBI and a recovery tip sheet shared. Checks that the system uses memory.",
        tags=["r2mr", "memory"], persona="stressed-warehouse-worker", opening="hey. back again",
        opening_mode="exact",
        situation="You talked to this bot yesterday about stress at work. Today was another rough shift and you "
                  "didn't really try the tips it gave you.",
        facts={"Yesterday": "You talked about burnout; it sent you a burnout questionnaire and a recovery tip sheet.",
               "Since then": "Another 10-hour shift, slept badly again, didn't look at the tip sheet."},
        goal="Something quick that actually fits your shifts.", max_turns=6, profile="Warehouse Worker",
        expectations=[Expectation(name="Remembers the earlier conversation",
                                  description="Refers to what was discussed or shared before (burnout, the "
                                              "questionnaire, the recovery tips) without being told.",
                                  pattern=r"(?i)last time|yesterday|we talked|you mentioned|earlier|before")]))
    return out


def personas(botbase: Path) -> list[PersonaDef]:
    out = [PersonaDef(id="caf-member", name="CAF member (rag_lab)", tags=["r2mr"],
                      description="Brief, phone-style; reveals details only when asked",
                      profile=CAF_MEMBER, model=PERSONA_MODEL,
                      notes="rag_lab's stage-2 simulated member; a different model family from the bots.")]
    db_path = botbase / "simulator" / "simulator.db"
    if db_path.is_file():
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        row = conn.execute("SELECT name, short_desc, profile_text FROM personas WHERE id = 1").fetchone()
        conn.close()
        if row:
            out.append(PersonaDef(id="stressed-warehouse-worker", name=row[0], description=row[1],
                                  tags=["r2mr", "botbase"], profile=row[2], model=PERSONA_MODEL,
                                  notes="From BotBase's simulator."))
    return out


def rubrics(botbase: Path) -> list[RubricDef]:
    _sc, ref = _rag_lab(botbase)
    out = [RubricDef(id="r2mr-expert", name="R2MR expert review", tags=["r2mr"],
                     description="rag_lab's judge, adapted to whole conversations: intake, fidelity, coverage, "
                                 "timing, personalization, coaching quality; experts' skills/concepts 0-3.",
                     instructions=R2MR_INSTRUCTIONS.format(approach=ref.GENERAL_APPROACH.strip()),
                     criteria=R2MR_CRITERIA, model=JUDGE_MODEL)]
    db_path = botbase / "simulator" / "simulator.db"
    if db_path.is_file():
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        row = conn.execute("SELECT name, description, criteria FROM rubrics WHERE id = 1").fetchone()
        conn.close()
        if row:
            out.append(RubricDef(
                id="core-quality", name=row[0], description=row[1], tags=["botbase"],
                instructions=row[1], grade_expectations=False, model=JUDGE_MODEL,
                criteria=[Criterion(key=c["key"], title=c.get("title", ""), description=c.get("description", ""),
                                    min=c.get("min", 1), max=c.get("max", 5), weight=c.get("weight", 1))
                          for c in json.loads(row[2])],
                notes="From BotBase's simulator (its judge was claude-sonnet-4.5)."))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--botbase", default=str(ROOT.parent / "BotBase"))
    parser.add_argument("--force", action="store_true", help="Replace existing definitions")
    args = parser.parse_args()
    botbase = Path(args.botbase)
    for label, collection, items in (("personas", workspace.personas, personas(botbase)),
                                     ("scenarios", workspace.scenarios, scenarios(botbase)),
                                     ("rubrics", workspace.rubrics, rubrics(botbase))):
        saved = 0
        for item in items:
            if collection.exists(item.id) and not args.force:
                continue
            collection.save(item)
            saved += 1
        print(f"{label}: {saved} saved, {len(items) - saved} kept")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
