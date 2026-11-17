"""
Export / import API: bundles of definitions (and dataset contents).

Export: ``POST /api/bundles/plan`` shows what a selection pulls in;
``POST /api/bundles/export`` downloads the zip. Import: upload the zip
(``POST /api/bundles/import``) for a preview and a token, then apply it
with per-definition actions, or discard it. Uploads are kept a day.
"""

from __future__ import annotations

import secrets
import time

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from . import bundle
from .workspace import now_iso

router = APIRouter(prefix="/api/bundles")


class Selection(BaseModel):
    kind: str
    id: str


class PlanBody(BaseModel):
    items: list[Selection]
    dependencies: bool = True


@router.post("/plan")
def plan(body: PlanBody):
    try:
        return bundle.plan([s.model_dump() for s in body.items], body.dependencies)
    except bundle.BundleError as exc:
        raise HTTPException(400, str(exc)) from None


class ExportBody(PlanBody):
    dataset_data: bool = False


@router.post("/export")
def export(body: ExportBody):
    try:
        path = bundle.export([s.model_dump() for s in body.items], body.dependencies, body.dataset_data)
    except bundle.BundleError as exc:
        raise HTTPException(400, str(exc)) from None
    name = f"sbf-bundle-{now_iso()[:16].replace(':', '').replace('T', '-')}.zip"
    return FileResponse(path, media_type="application/zip", filename=name,
                        background=BackgroundTask(path.unlink, missing_ok=True))


def _cleanup() -> None:
    if bundle.IMPORTS_DIR.exists():
        for old in bundle.IMPORTS_DIR.glob("*.zip"):
            if time.time() - old.stat().st_mtime > 86400:
                old.unlink(missing_ok=True)


@router.post("/import", status_code=201)
async def upload(file: UploadFile = File(...)):
    """Store an uploaded bundle; returns its token and the preview."""
    _cleanup()
    bundle.IMPORTS_DIR.mkdir(parents=True, exist_ok=True)
    token = secrets.token_hex(16)
    path = bundle.IMPORTS_DIR / f"{token}.zip"
    size = 0
    with path.open("wb") as out:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > bundle.MAX_UNCOMPRESSED:
                out.close()
                path.unlink(missing_ok=True)
                raise HTTPException(413, "The bundle is too large")
            out.write(chunk)
    try:
        b = bundle.Bundle(path)
    except bundle.BundleError as exc:
        path.unlink(missing_ok=True)
        raise HTTPException(400, str(exc)) from None
    try:
        return {"token": token, "filename": file.filename, **bundle.preview(b)}
    finally:
        b.close()


@router.get("/import/{token}")
def import_preview(token: str):
    b = bundle.open_stored(token)
    try:
        return {"token": token, **bundle.preview(b)}
    finally:
        b.close()


@router.get("/import/{token}/items/{kind}/{item_id}")
def import_compare(token: str, kind: str, item_id: str):
    """A definition as in the bundle and as here (for comparing)."""
    b = bundle.open_stored(token)
    try:
        item = b.items.get(f"{kind}/{item_id}")
        if item is None:
            raise HTTPException(404, "Not in this bundle")
        local = bundle.load(kind, item_id) if bundle.exists(kind, item_id) else None
        return {"bundle": item["definition"], "local": local, "error": item["error"]}
    finally:
        b.close()


class ApplyBody(BaseModel):
    actions: dict[str, str] = Field(default_factory=dict,
                                    description='"kind/id" → create | replace | skip | copy:<new id>')
    presets: dict[str, str] = Field(default_factory=dict, description="preset → add | replace | skip")
    import_data: bool = True


@router.post("/import/{token}/apply")
def import_apply(token: str, body: ApplyBody):
    b = bundle.open_stored(token)
    try:
        result = bundle.apply(b, body.actions, body.presets, body.import_data)
    except bundle.BundleError as exc:
        raise HTTPException(400, str(exc)) from None
    finally:
        b.close()
    bundle.stored_path(token).unlink(missing_ok=True)
    return result


@router.delete("/import/{token}")
def import_discard(token: str):
    bundle.stored_path(token).unlink(missing_ok=True)
    return {"ok": True}
