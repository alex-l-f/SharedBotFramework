"""
Safety API: classifier definitions (``/api/classifiers``), trying one on
messages, checking that its service answers, and the providers' defaults.
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field, ValidationError

from .safety import classify, provider_meta, sync_rails
from .safety.classifiers import DEFAULT_URLS
from .schemas import ClassifierDef
from .workspace import expected_version, workspace

router = APIRouter(prefix="/api")


def _parse(data: dict) -> ClassifierDef:
    from .app import _validation_detail
    data = {k: v for k, v in data.items() if k not in ("version", "used_by")}
    try:
        return ClassifierDef.model_validate(data)
    except ValidationError as exc:
        raise HTTPException(422, detail=_validation_detail(exc)) from None


def _used_by(classifier_id: str) -> list[dict]:
    return [{"system": s.id, "guards": [g.id for g in s.guards if g.classifier == classifier_id]}
            for s in workspace.systems.list() if any(g.classifier == classifier_id for g in s.guards)]


def _summary(c: ClassifierDef) -> dict:
    return {**workspace.classifiers.dump(c), "used_by": _used_by(c.id)}


@router.get("/safety/meta")
def meta():
    return provider_meta()


@router.get("/classifiers")
def list_classifiers():
    return [_summary(c) for c in workspace.classifiers.list()]


@router.get("/classifiers/{classifier_id}")
def get_classifier(classifier_id: str):
    return _summary(workspace.classifiers.get(classifier_id))


@router.post("/classifiers", status_code=201)
def create_classifier(data: dict):
    c = _parse(data)
    if workspace.classifiers.exists(c.id):
        raise HTTPException(409, f"Classifier {c.id!r} already exists")
    workspace.classifiers.save(c)
    sync_rails()
    return _summary(c)


@router.put("/classifiers/{classifier_id}")
def update_classifier(classifier_id: str, data: dict, if_match: str | None = Header(None)):
    c = workspace.classifiers.save(_parse({**data, "id": classifier_id}), expected_version(if_match))
    sync_rails()
    return _summary(c)


@router.delete("/classifiers/{classifier_id}")
def delete_classifier(classifier_id: str, if_match: str | None = Header(None)):
    workspace.classifiers.get(classifier_id)
    users = _used_by(classifier_id)
    if users:
        raise HTTPException(409, "Classifier is used by: " + ", ".join(u["system"] for u in users))
    workspace.classifiers.delete(classifier_id, expected_version(if_match))
    sync_rails()
    return {"ok": True}


class TestBody(BaseModel):
    classifier: str | None = None
    draft: dict | None = None
    messages: list[dict] = Field(min_length=1, description="[{role, content}], the last one is classified")


@router.post("/classifiers/test")
async def test(body: TestBody):
    """Classify messages with a saved classifier or a draft (a draft
    nemo_guardrails classifier runs the saved config — save to try edits)."""
    if body.draft is not None:
        defn = _parse({"id": body.draft.get("id") or body.classifier or "draft", **body.draft})
    elif body.classifier:
        defn = workspace.classifiers.get(body.classifier)
    else:
        raise HTTPException(400, "Give a classifier id or a draft")
    verdict = await classify(defn, body.messages)
    return verdict.to_dict()


@router.get("/classifiers/{classifier_id}/status")
async def status(classifier_id: str):
    """Whether the classifier's service answers (model-based ones: not checked)."""
    c = workspace.classifiers.get(classifier_id)
    probe = {"safer": "/health", "nemo_guardrails": "/v1/rails/configs"}.get(c.provider)
    if probe is None:
        return {"checked": False, "ok": None, "detail": "Uses a model API; try it with a test message."}
    url = (c.url or DEFAULT_URLS[c.provider]).rstrip("/") + probe
    try:
        async with httpx.AsyncClient(timeout=4) as client:
            res = await client.get(url)
        ok = res.status_code == 200
        detail = res.text[:300]
        if ok and c.provider == "nemo_guardrails" and c.id not in detail:
            ok, detail = False, f"The guardrails server is up but doesn't serve config {c.id!r} yet: {detail}"
        return {"checked": True, "ok": ok, "detail": detail, "url": url}
    except httpx.HTTPError as exc:
        return {"checked": True, "ok": False, "detail": f"{type(exc).__name__}: {exc}", "url": url}
