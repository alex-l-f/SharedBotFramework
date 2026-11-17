"""
Simulations: LLM-played users (personas in scenarios) run against systems,
singly or in batches, judged by an LLM rubric, with raw data export.

Definitions live in the workspace (``PersonaDef``, ``ScenarioDef``,
``RubricDef``); runs in ``sbf.db`` (``store``); conversations are ordinary
chats with origin 'simulation'.
"""

from . import results, store
from .runner import cleanup_conversation, create_run, judge_conversation, plan, runner

__all__ = ["cleanup_conversation", "create_run", "judge_conversation", "plan", "results", "runner", "store"]
