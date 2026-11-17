"""
RAG data API: datasets (definitions, files, items, processing) and
retrievers (definitions, index status, test runs).
"""

from __future__ import annotations

import asyncio
import hashlib
import mimetypes
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, ValidationError

from .data import DatasetStore, extraction_hash, file_kind, processor
from .data.convert import KINDS
from .data.extract import Ledger, extract_fields
from .rag import (DEFAULT_MAPPING, RetrievalRequest, corpus_status, get_corpus, item_url, run_retriever)
from .rag.retriever import DEFAULT_CATALOG_LINE, _load_entries
from .schemas import DatasetDef, RetrieverDef
from .settings import get_settings
from .workspace import Conflict, NotFound, _write_lock, content_hash, expected_version, workspace

router = APIRouter(prefix="/api")


def _parse(model, data: dict):
    from .app import _validation_detail
    data = {k: v for k, v in data.items() if k not in ("version", "used_by")}
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        raise HTTPException(422, detail=_validation_detail(exc)) from None


def _dataset(dataset_id: str) -> DatasetDef:
    return workspace.datasets.get(dataset_id)


def _hash_for(ds: DatasetDef) -> str | None:
    return extraction_hash(ds) if ds.fields and ds.extraction.enabled else None


def _retriever_users(dataset_id: str) -> list[str]:
    return [r.id for r in workspace.retrievers.list() if any(s.dataset == dataset_id for s in r.sources)]


def _dataset_summary(ds: DatasetDef) -> dict:
    store = DatasetStore(ds.id)
    return {**workspace.datasets.dump(ds), "stats": store.stats(_hash_for(ds)), "processing": processor.busy(ds.id),
            "used_by": _retriever_users(ds.id)}


# ------------------------------------------------------------------ datasets

@router.get("/datasets")
def list_datasets():
    return [_dataset_summary(ds) for ds in workspace.datasets.list()]


@router.post("/datasets", status_code=201)
def create_dataset(data: dict):
    ds = _parse(DatasetDef, data)
    if workspace.datasets.exists(ds.id):
        raise HTTPException(409, f"Dataset {ds.id!r} already exists")
    workspace.datasets.save(ds)
    return _dataset_summary(ds)


@router.get("/datasets/{dataset_id}")
def get_dataset(dataset_id: str):
    ds = _dataset(dataset_id)
    store = DatasetStore(ds.id)
    return {**_dataset_summary(ds), "files": store.list_files() if store.exists else [],
            "extraction_hash": _hash_for(ds), "accepted": sorted(e for exts in KINDS.values() for e in exts)}


@router.put("/datasets/{dataset_id}")
def update_dataset(dataset_id: str, data: dict, if_match: str | None = Header(None)):
    ds = _parse(DatasetDef, {**data, "id": dataset_id})
    return _dataset_summary(workspace.datasets.save(ds, expected_version(if_match)))


@router.delete("/datasets/{dataset_id}")
def delete_dataset(dataset_id: str, if_match: str | None = Header(None)):
    _dataset(dataset_id)
    users = _retriever_users(dataset_id)
    if users:
        raise HTTPException(409, f"Dataset is used by retrievers: {', '.join(users)}")
    if processor.busy(dataset_id):
        raise HTTPException(409, "Dataset files are still being processed")
    workspace.datasets.delete(dataset_id, expected_version(if_match))
    DatasetStore(dataset_id).destroy()
    return {"ok": True}


_SAFE_NAME = re.compile(r"[^\w.\- ()]+", re.UNICODE)


@router.post("/datasets/{dataset_id}/files", status_code=201)
async def upload_files(dataset_id: str, files: list[UploadFile] = File(...)):
    _dataset(dataset_id)
    store = DatasetStore(dataset_id)
    store.files_dir.mkdir(parents=True, exist_ok=True)
    added, skipped = [], []
    for upload in files:
        name = Path(upload.filename or "file").name
        safe = _SAFE_NAME.sub("_", name).strip() or "file"
        tmp = store.files_dir / f".upload-{hashlib.sha1(name.encode()).hexdigest()[:8]}"
        digest, size = hashlib.sha256(), 0
        with tmp.open("wb") as out:
            while chunk := await upload.read(1 << 20):
                digest.update(chunk)
                size += len(chunk)
                out.write(chunk)
        sha = digest.hexdigest()
        existing = store.find_file(sha)
        if existing is not None:
            tmp.unlink()
            skipped.append({"name": name, "reason": f"same content as {existing['name']}"})
            continue
        f = store.add_file(name, "", kind=file_kind(name), mime=upload.content_type or mimetypes.guess_type(name)[0],
                           size=size, sha256=sha)
        rel = f"{f['id']}-{safe}"
        tmp.replace(store.files_dir / rel)
        store.set_file_path(f["id"], rel)
        processor.enqueue(dataset_id, f["id"], "full")
        added.append({**store.get_file(f["id"]), "items": 0})
    return {"added": added, "skipped": skipped}


@router.delete("/datasets/{dataset_id}/files/{file_id}")
def delete_file(dataset_id: str, file_id: int):
    _dataset(dataset_id)
    store = DatasetStore(dataset_id)
    if store.get_file(file_id) is None:
        raise HTTPException(404, "File not found")
    if (dataset_id, file_id) in processor.pending:
        raise HTTPException(409, "The file is being processed; try again when it is done")
    store.delete_file(file_id)
    return {"ok": True}


@router.get("/datasets/{dataset_id}/files/{file_id}/raw")
def file_raw(dataset_id: str, file_id: int):
    _dataset(dataset_id)
    store = DatasetStore(dataset_id)
    f = store.get_file(file_id)
    path = store.file_path(f) if f else None
    if path is None or not path.is_file():
        raise HTTPException(404, "File not found")
    return FileResponse(path, media_type=f.get("mime") or mimetypes.guess_type(f["name"])[0],
                        filename=f["name"], content_disposition_type="inline")


class ProcessBody(BaseModel):
    mode: str = Field("full", description="full | fields | chunks")
    file_ids: list[int] | None = None
    only_stale: bool = False


@router.post("/datasets/{dataset_id}/process")
async def process(dataset_id: str, body: ProcessBody):  # async: queues on the server loop
    ds = _dataset(dataset_id)
    store = DatasetStore(dataset_id)
    if not store.exists:
        return {"queued": 0}
    files = store.list_files()
    if body.file_ids is not None:
        files = [f for f in files if f["id"] in set(body.file_ids)]
    if body.only_stale:
        current = _hash_for(ds)
        stale = {i["file_id"] for i in store.list_items(with_text=False)
                 if current and i.get("chars") and (i.get("extraction_hash") or "") not in (current, "n/a")}
        files = [f for f in files if f["id"] in stale]
    queued = 0
    for f in files:
        if f["status"] == "unsupported" and body.mode != "full":
            continue
        if not f["linked"] or body.mode != "full" or Path(f["path"]).is_file():
            queued += processor.enqueue(dataset_id, f["id"], body.mode)
    return {"queued": queued}


@router.get("/datasets/{dataset_id}/items")
def list_items(dataset_id: str, q: str | None = None, file_id: int | None = None,
               limit: int = 100, offset: int = 0):
    ds = _dataset(dataset_id)
    store = DatasetStore(dataset_id)
    if not store.exists:
        return {"total": 0, "items": []}
    current = _hash_for(ds)
    items = store.list_items(q=q, file_id=file_id, limit=limit, offset=offset, with_text=False)
    for i in items:
        i["key"] = f"{dataset_id}:{i['id']}"
        i["stale"] = bool(current and i.get("chars") and (i.get("extraction_hash") or "") not in (current, "n/a"))
    return {"total": store.count_items(q, file_id=file_id), "items": items}


@router.get("/datasets/{dataset_id}/items/{item_id}")
def get_item(dataset_id: str, item_id: int):
    _dataset(dataset_id)
    store = DatasetStore(dataset_id)
    item = store.get_item(item_id) if store.exists else None
    if item is None:
        raise HTTPException(404, "Item not found")
    f = store.get_file(item["file_id"]) if item.get("file_id") else None
    return {**item, "key": f"{dataset_id}:{item_id}", "url": item_url(dataset_id, item),
            "file": f, "sections": store.sections(item_id), "chunks": store.chunks(item_id),
            "version": _item_version(item)}


def _item_version(item: dict) -> str:
    """What an item edit is based on: its title and fields (re-extraction changes them too)."""
    return content_hash({"title": item.get("title"), "fields": item.get("fields")})[:12]


class ItemUpdate(BaseModel):
    title: str | None = None
    fields: dict[str, Any] | None = None


@router.put("/datasets/{dataset_id}/items/{item_id}")
def update_item(dataset_id: str, item_id: int, body: ItemUpdate, if_match: str | None = Header(None)):
    _dataset(dataset_id)
    store = DatasetStore(dataset_id)
    with _write_lock:
        item = store.get_item(item_id)
        if item is None:
            raise HTTPException(404, "Item not found")
        expected = expected_version(if_match)
        if expected is not None and _item_version(item) != expected:
            raise Conflict("items", f"{dataset_id}:{item_id}", expected, _item_version(item),
                           {"title": item["title"], "fields": item["fields"]})
        store.update_item(item_id, **body.model_dump(exclude_none=True))
    return get_item(dataset_id, item_id)


@router.get("/datasets/{dataset_id}/items/{item_id}/file")
def item_file(dataset_id: str, item_id: int):
    _dataset(dataset_id)
    store = DatasetStore(dataset_id)
    item = store.get_item(item_id) if store.exists else None
    f = store.get_file(item["file_id"]) if item and item.get("file_id") else None
    path = store.file_path(f) if f else None
    if path is None or not path.is_file():
        raise HTTPException(404, "File not found")
    return FileResponse(path, media_type=mimetypes.guess_type(f["name"])[0] or f.get("mime"),
                        filename=f["name"], content_disposition_type="inline")


class ExtractPreviewBody(BaseModel):
    item_id: int
    draft: dict | None = None


@router.post("/datasets/{dataset_id}/extract-preview")
async def extract_preview(dataset_id: str, body: ExtractPreviewBody):
    """Run field extraction on one item with the (draft) definition, without saving."""
    ds = _parse(DatasetDef, {**body.draft, "id": dataset_id}) if body.draft else _dataset(dataset_id)
    if not ds.fields:
        raise HTTPException(400, "Define at least one field first")
    item = DatasetStore(dataset_id).get_item(body.item_id)
    if item is None:
        raise HTTPException(404, "Item not found")
    ledger = Ledger()
    fields, problems = await extract_fields(ds, item["title"], item["source_type"], item["text"], ledger)
    return {"fields": fields, "problems": problems, "current": item["fields"], **ledger.to_dict()}


# ---------------------------------------------------------------- retrievers

def _retriever_usage(retriever_id: str) -> list[dict]:
    out = []
    for s in workspace.systems.list():
        nodes = set()
        for n in s.nodes:
            if any(c.retriever == retriever_id for c in n.context):
                nodes.add(n.id)
            if any(b.config.get("retriever") == retriever_id for b in n.tools):
                nodes.add(n.id)
            # tool_config: function name → config overrides (plain dicts).
            if any(cfg.get("retriever") == retriever_id for cfg in n.tool_config.values()
                   if isinstance(cfg, dict)):
                nodes.add(n.id)
        if nodes:
            out.append({"kind": "system", "id": s.id, "nodes": sorted(nodes)})
    for a in workspace.agents.list():
        if any(b.config.get("retriever") == retriever_id for b in a.tools):
            out.append({"kind": "agent", "id": a.id})
    return out


@router.get("/rag/meta")
def rag_meta():
    """Choices and defaults for the retriever editor."""
    settings = get_settings()
    return {"methods": ["hybrid", "facets", "catalog", "all"],
            "presentations": ["passages", "json", "template", "brief"],
            "units": ["chunks", "items", "items+chunks"],
            "default_mapping": DEFAULT_MAPPING, "default_catalog_line": DEFAULT_CATALOG_LINE,
            "embedders": list(settings.embedders), "default_embedder": settings.default_embedder,
            "mapping_variables": {
                "item": ["id", "key", "dataset", "dataset_name", "title", "source_type", "text", "summary",
                         "fields", "meta", "url"],
                "chunk": ["text", "label", "idx"]}}


@router.get("/retrievers")
def list_retrievers():
    return [{**workspace.retrievers.dump(r), "used_by": _retriever_usage(r.id), "index": corpus_status(r)}
            for r in workspace.retrievers.list()]


@router.post("/retrievers", status_code=201)
def create_retriever(data: dict):
    r = _parse(RetrieverDef, data)
    if workspace.retrievers.exists(r.id):
        raise HTTPException(409, f"Retriever {r.id!r} already exists")
    return workspace.retrievers.dump(workspace.retrievers.save(r))


@router.get("/retrievers/{retriever_id}")
def get_retriever(retriever_id: str):
    r = workspace.retrievers.get(retriever_id)
    return {**workspace.retrievers.dump(r), "used_by": _retriever_usage(r.id), "index": corpus_status(r)}


@router.put("/retrievers/{retriever_id}")
def update_retriever(retriever_id: str, data: dict, if_match: str | None = Header(None)):
    r = _parse(RetrieverDef, {**data, "id": retriever_id})
    return workspace.retrievers.dump(workspace.retrievers.save(r, expected_version(if_match)))


@router.delete("/retrievers/{retriever_id}")
def delete_retriever(retriever_id: str, if_match: str | None = Header(None)):
    workspace.retrievers.get(retriever_id)
    users = _retriever_usage(retriever_id)
    if users:
        raise HTTPException(409, "Retriever is used by: " + ", ".join(f"{u['kind']} {u['id']}" for u in users))
    workspace.retrievers.delete(retriever_id, expected_version(if_match))
    return {"ok": True}


def _draft_or_saved(retriever_id: str | None, draft: dict | None) -> RetrieverDef:
    if draft is not None:
        return _parse(RetrieverDef, {**draft, "id": draft.get("id") or retriever_id or "draft"})
    if not retriever_id:
        raise HTTPException(400, "Give a retriever id or a draft")
    return workspace.retrievers.get(retriever_id)


class IndexBody(BaseModel):
    draft: dict | None = None


@router.post("/retrievers/{retriever_id}/index")
async def build_index(retriever_id: str, body: IndexBody | None = None):
    defn = _draft_or_saved(retriever_id, body.draft if body else None)
    await get_corpus(defn)
    return corpus_status(defn)


class EntriesBody(BaseModel):
    draft: dict | None = None
    limit: int = 20


@router.post("/retrievers/{retriever_id}/entries")
async def sample_entries(retriever_id: str, body: EntriesBody):
    """What the mapping produces: the first entries, as searched and shown."""
    defn = _draft_or_saved(retriever_id, body.draft)
    entries, items, _names, _versions, warnings = await asyncio.to_thread(_load_entries, defn)
    return {"total": len(entries), "items": len(items), "warnings": warnings,
            "entries": [{"item_key": e.item_key, "kind": e.kind, "title": e.title, "label": e.label,
                         "text": e.text[:2000], "index_text": e.index_text[:2000], "url": e.url}
                        for e in entries[:max(1, min(body.limit, 200))]]}


class RunBody(BaseModel):
    retriever: str | None = None
    draft: dict | None = None
    query: str = ""
    queries: list[str] = Field(default_factory=list)
    conversation: list[dict] = Field(default_factory=list)
    budget: int | None = None
    datasets: list[str] | None = None


@router.post("/retrievers/run")
async def run(body: RunBody):
    """Run a retriever (saved or draft) on a test request; for comparing methods."""
    defn = _draft_or_saved(body.retriever, body.draft)
    query = body.query.strip()
    if not query and not body.queries and not body.conversation:
        raise HTTPException(400, "Give a query, queries or a conversation")
    conversation = [m for m in body.conversation if m.get("role") in ("user", "assistant") and m.get("content")]
    req = RetrievalRequest(queries=[q for q in [query, *body.queries] if q.strip()], question=query,
                           conversation=conversation, budget=body.budget, datasets=body.datasets or None)
    try:
        result = await run_retriever(defn, req)
    except NotFound as exc:
        raise HTTPException(404, f"Not found: {exc}") from None
    return result.to_dict()
