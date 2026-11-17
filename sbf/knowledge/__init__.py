"""
Knowledge access for the library tools (search / examine / deliver).

Two backends implement ``KnowledgeBackend``:

* ``embedding_service`` — BotBase's embedding service (hybrid HNSW + BM25
  over each library's index) for search, resource rows read straight from
  each library's ``database.db``;
* ``datasets`` — this framework's datasets (library id = dataset id),
  searched with a hybrid index over their chunks.

A tool binding picks one (``backend`` in its config) or uses the default in
settings; resources remember the backend they came from, so delivery tools
find their files.

A resource as tools see it is the library row (or the item's fields) plus:
    id       public id, ``RES_00012`` (what the model cites)
    oid      integer row / item id
    library  library id
    backend  the backend it came from
    url      where the frontend fetches/opens it
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Protocol

import httpx

from ..settings import get_settings


class KnowledgeBackend(Protocol):
    def libraries(self) -> list[dict]: ...
    async def search(self, library: str, queries: list[str], k: int = 10,
                     language: str | None = None) -> dict[int, float]: ...
    def get(self, library: str, oid: int) -> dict | None: ...
    def list_resources(self, library: str, q: str | None = None, limit: int = 200) -> list[dict]: ...
    def file_path(self, library: str, oid: int) -> Path | None: ...


def public_id(oid: int) -> str:
    return f"RES_{str(oid).zfill(5)}"


def parse_public_id(resource_id: str) -> int | None:
    if not isinstance(resource_id, str) or not resource_id.startswith("RES_"):
        return None
    try:
        return int(resource_id[4:])
    except ValueError:
        return None


def public_resource(library: str, row: dict) -> dict:
    item = {k: v for k, v in row.items() if k != "embedding"}
    oid = row["id"]
    item["oid"] = oid
    item["id"] = public_id(oid)
    item["library"] = library
    item["backend"] = "embedding_service"
    portal = (row.get("portal_url") or "").strip()
    if (row.get("source_type") or "") == "course_page":
        url = "/" + portal.lstrip("/") if portal else ""
    elif row.get("source_path"):
        url = f"/api/knowledge/{library}/files/{oid}"
    else:
        url = portal
    item["url"] = url
    item["portalURL"] = url
    return item


class EmbeddingServiceBackend:
    def __init__(self, url: str, processed_root: str, file_root: str, labels: dict):
        self.url = url.rstrip("/")
        self.processed_root = Path(processed_root) if processed_root else None
        self.file_root = Path(file_root).resolve() if file_root else None
        self.labels = labels

    def _db_path(self, library: str) -> Path | None:
        if not self.processed_root or not library or "/" in library or "\\" in library:
            return None
        path = self.processed_root / library / "database.db"
        return path if path.exists() else None

    def libraries(self) -> list[dict]:
        out = []
        if not self.processed_root or not self.processed_root.exists():
            return out
        for d in sorted(self.processed_root.iterdir()):
            db_path = d / "database.db"
            if not db_path.exists():
                continue
            meta = self.labels.get(d.name, {})
            try:
                with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
                    count = conn.execute("SELECT COUNT(*) FROM resources").fetchone()[0]
            except sqlite3.Error:
                count = None
            out.append({"id": d.name, "label": meta.get("label", d.name),
                        "description": meta.get("description", ""), "resources": count})
        return out

    async def search(self, library: str, queries: list[str], k: int = 10,
                     language: str | None = None) -> dict[int, float]:
        payload = {"provider": library, "queries": [q.strip() for q in queries if q.strip()],
                   "k": k, "language": None if language in (None, "", "all") else language}
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(f"{self.url}/search", json=payload)
            resp.raise_for_status()
        scores = resp.json().get("resource_scores") or {}
        return {int(rid): float(score) for rid, score in scores.items()}

    def get(self, library: str, oid: int) -> dict | None:
        db_path = self._db_path(library)
        if db_path is None:
            return None
        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM resources WHERE id = ?", (int(oid),)).fetchone()
        return public_resource(library, dict(row)) if row else None

    def list_resources(self, library: str, q: str | None = None, limit: int = 200) -> list[dict]:
        db_path = self._db_path(library)
        if db_path is None:
            return []
        sql, params = "SELECT id, title, source_type FROM resources", []
        if q:
            sql += " WHERE title LIKE ?"
            params.append(f"%{q}%")
        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
            rows = conn.execute(sql + " ORDER BY id LIMIT ?", params + [limit]).fetchall()
        return [{"id": public_id(r[0]), "oid": r[0], "title": r[1], "source_type": r[2] or ""}
                for r in rows]

    def file_path(self, library: str, oid: int) -> Path | None:
        """The resource's file on disk, or None if it has none / it's missing."""
        item = self.get(library, oid)
        if not item or not self.file_root or not item.get("source_path"):
            return None
        path = (self.file_root / item["source_path"]).resolve()
        if self.file_root not in path.parents or not path.is_file():
            return None
        return path


class DatasetBackend:
    """Libraries are datasets; search is hybrid over each dataset's chunks,
    scored per item by its best chunk."""

    def libraries(self) -> list[dict]:
        from ..data import DatasetStore
        from ..workspace import workspace
        out = []
        for ds in workspace.datasets.list():
            store = DatasetStore(ds.id)
            out.append({"id": ds.id, "label": ds.name or ds.id, "description": ds.description,
                        "resources": store.count_items() if store.exists else 0})
        return out

    @staticmethod
    def _retriever(library: str):
        from ..schemas import RetrieverDef, RetrieverSource
        return RetrieverDef(id=f"library-{library}".lower().replace("_", "-"),
                            sources=[RetrieverSource(dataset=library)], unit="chunks")

    async def search(self, library: str, queries: list[str], k: int = 10,
                     language: str | None = None) -> dict[int, float]:
        from ..rag import get_corpus
        corpus = await get_corpus(self._retriever(library))
        hits = await corpus.index.search(queries, k=k * 8, depth=max(50, k * 8))
        scores: dict[int, float] = {}
        for j, score in hits:
            oid = corpus.entries[j].item_id
            if oid not in scores:
                scores[oid] = score
            if len(scores) >= k:
                break
        return scores

    def get(self, library: str, oid: int) -> dict | None:
        from ..data import DatasetStore
        from ..rag import item_url
        from ..workspace import workspace
        if not workspace.datasets.exists(library):
            return None
        store = DatasetStore(library)
        item = store.get_item(int(oid)) if store.exists else None
        if item is None:
            return None
        f = store.get_file(item["file_id"]) if item.get("file_id") else None
        meta = {k: v for k, v in item["meta"].items() if k not in ("record", "row", "file")}
        out = {**meta, **item["fields"], "title": item["title"], "source_type": item["source_type"]}
        if not out.get("description"):
            from ..data.extract import render_fields
            out["description"] = render_fields(item["fields"]) or item["text"][:500]
        if f is not None and not item["meta"].get("record"):
            out.setdefault("source_file", f["name"])
            out["source_path"] = f["name"]
        out["full_transcript"] = item["text"]
        url = item_url(library, item)
        out.update(id=public_id(item["id"]), oid=item["id"], library=library, backend="datasets",
                   url=url, portalURL=url)
        return out

    def list_resources(self, library: str, q: str | None = None, limit: int = 200) -> list[dict]:
        from ..data import DatasetStore
        from ..workspace import workspace
        if not workspace.datasets.exists(library) or not DatasetStore(library).exists:
            return []
        return [{"id": public_id(i["id"]), "oid": i["id"], "title": i["title"],
                 "source_type": i["source_type"]}
                for i in DatasetStore(library).list_items(q=q, limit=limit, with_text=False)]

    def file_path(self, library: str, oid: int) -> Path | None:
        from ..data import DatasetStore
        from ..workspace import workspace
        if not workspace.datasets.exists(library):
            return None
        store = DatasetStore(library)
        item = store.get_item(int(oid)) if store.exists else None
        if not item or not item.get("file_id") or item["meta"].get("record"):
            return None
        f = store.get_file(item["file_id"])
        if f is None:
            return None
        path = store.file_path(f)
        return path if path.is_file() else None


BACKENDS = ("embedding_service", "datasets")


def get_knowledge(backend: str | None = None) -> KnowledgeBackend:
    """The named backend, or the settings default."""
    k = get_settings().knowledge
    backend = backend or k.backend
    if backend == "datasets":
        return DatasetBackend()
    if backend != "embedding_service":
        raise ValueError(f"Unknown knowledge backend {backend!r}")
    return EmbeddingServiceBackend(k.url, k.processed_root, k.file_root, k.libraries)


def add_dataset_items(registry, keys: list[str]) -> None:
    """Register dataset items (``<dataset>:<item>`` keys) in a run's
    resource registry, shaped like library resources, so delivery and
    memory tools resolve the ids a retriever showed the model."""
    from ..rag import parse_item_key
    backend = DatasetBackend()
    for key in keys:
        if registry.get(key) is not None:
            continue
        parsed = parse_item_key(key)
        item = backend.get(*parsed) if parsed else None
        if item is not None:
            item["id"] = key
            registry.add(item)
