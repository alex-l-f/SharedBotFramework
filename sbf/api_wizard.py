"""
Setup wizard API: answers → a checked draft of the definitions, then create
them (editors).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from . import wizard
from .workspace import workspace

router = APIRouter(prefix="/api/wizard")


@router.post("/draft")
def draft(answers: wizard.WizardAnswers):
    """What would be created, and whether it can be (nothing is saved)."""
    return wizard.draft(answers).model_dump()


@router.post("/create", status_code=201)
def create(answers: wizard.WizardAnswers):
    try:
        d = wizard.create(answers)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return {**d.model_dump(), "version": workspace.systems.version(d.system.id)}
