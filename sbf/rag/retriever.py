"""
Retrievers: the search layer between datasets and agents.

A ``RetrieverDef`` combines

* **sources** — datasets, optionally filtered, whose items are **mapped**
  (Jinja over ``item`` / ``chunk``) to what is searched (``index_text``,
  ``chunk_index_text``) and shown (``title``, ``text``, ``chunk_text``);
* a **unit** — search document chunks, whole items, or both;
* a **method** — how passages are chosen:
    hybrid   dense + BM25 top-k (RRF), at most ``max_per_item`` per item
    facets   an LLM lists the angles of the situation; coverage selection
             picks passages that cover every angle (rag_lab "facets")
    catalog  an LLM picks items from a one-line-per-item catalog
             (rag_lab "catalog")
    all      everything in scope (for small datasets, or with a brief:
             map-reduce over the whole library — rag_lab's best)
* a **presentation** — what the model sees:
    passages numbered passages with titles and item ids
    json     the items' fields as raw JSON
    template your own Jinja over the passages
    brief    an LLM brief written from the passages for this situation
             (map-reduce in batches when they don't fit one call)

``run_retriever`` takes a definition and a ``RetrievalRequest`` and returns
the text plus the pack and its metadata (queries, timings, LLM calls/cost).
Indexes are built on first use and cached until the definition, the
embedder or a source dataset's content version changes.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field

import numpy as np
from jinja2 import ChainableUndefined
from jinja2.sandbox import SandboxedEnvironment

from ..data.extract import Ledger, render_fields
from ..data.store import DatasetStore
from ..llm import complete, parse_json, resolve_spec
from ..schemas import DatasetDef, RetrieverDef
from ..workspace import NotFound, content_hash, workspace
from .embed import get_embedder
from .index import HybridIndex
from .pack import ContextPack, Passage, RetrievalRequest

DEFAULT_MAPPING = {
    "title": "{{ item.title }}",
    "text": "{{ item.summary }}",
    "index_text": "{{ item.title }}\n{{ item.summary }}",
    "chunk_text": "{{ chunk.text }}",
    "chunk_index_text": "{{ chunk.text }}",
    "url": "{{ item.url }}",
}
DEFAULT_CATALOG_LINE = "{{ item.title }} — {{ item.summary | replace('\\n', ' ') | truncate(220) }}"
MAPPING_KEYS = tuple(DEFAULT_MAPPING)

# Characters of documents per map call of a brief.
BRIEF_BATCH_CHARS = 60000

_env = SandboxedEnvironment(undefined=ChainableUndefined, autoescape=False)

FACET_PROMPT = """Someone is being helped using a library of documents. Here is their situation:

{situation}

List the distinct things to look up in the library to help fully — every angle that could have its own material: what explains the situation, each problem or need it raises, what was asked for, how and when to apply what helps, and anything else the library might address.

Write 6-12 short search queries (5-12 words each) in plain language, each covering a different angle. Do not answer. Return JSON only: {{"queries": ["..."]}}"""

REWRITE_PROMPT = """Someone is being helped using a library of documents. Here is their situation:

{situation}

Write 2-5 short search queries (3-12 words each) that would find the most useful material for what is needed now. Return JSON only: {{"queries": ["..."]}}"""

CATALOG_PROMPT = """Someone is being helped using a library of documents. Here is their situation:

{situation}

Below is the library's catalog, one document per line as "id | description".

{catalog}

Choose the documents that would help most, covering the whole situation rather than one part of it. Pick at most {n}, one per idea (skip near-duplicates), ordered from most to least important. Return JSON only: {{"ids": ["D.."]}}"""

MAP_PROMPT = """Someone is being helped using a library of documents. Here is their situation:

{situation}

Here are some documents from the library:

{docs}

Extract everything in these documents that could help in this situation: facts, definitions, explanations, practices or steps (what, how, when), and resources worth sharing. Use the documents' own terms and cite each note's document title and id. Notes only, at most 450 words. If nothing here is relevant, answer exactly NONE."""

REDUCE_PROMPT = """Someone is being helped using a library of documents. Here is their situation:

{situation}

{source}

{material}

Write one evidence brief from this for the assistant helping them (at most {words} words). Keep every distinct point that applies, citing the document titles and ids it comes from; drop duplicates and anything that doesn't fit the situation.{instructions}"""


# --------------------------------------------------------------------- corpus

@dataclass
class Entry:
    item_key: str
    dataset: str
    item_id: int
    kind: str           # item | chunk
    title: str
    text: str           # shown
    index_text: str     # searched
    url: str
    source_type: str
    label: str = ""
    order: int = 0


@dataclass
class Corpus:
    entries: list[Entry]
    index: HybridIndex
    items: dict[str, dict]         # item key → item template variables
    datasets: dict[str, str]       # dataset id → name
    versions: dict[str, int]
    warnings: list[str] = field(default_factory=list)
    built_at: float = 0.0
    build_ms: int = 0

    def mask(self, datasets: list[str] | None) -> np.ndarray | None:
        if datasets is None:
            return None
        allowed = set(datasets)
        return np.array([e.dataset in allowed for e in self.entries], dtype=bool)


def parse_item_key(key: str) -> tuple[str, int] | None:
    if not isinstance(key, str) or ":" not in key:
        return None
    dataset, _, rest = key.strip().rpartition(":")
    try:
        return dataset, int(rest.split("#")[0])
    except ValueError:
        return None


def item_url(dataset_id: str, item: dict) -> str:
    meta, fields = item.get("meta") or {}, item.get("fields") or {}
    portal = meta.get("portal_url") or fields.get("portal_url") or ""
    if item.get("source_type") == "course_page":
        return "/" + portal.lstrip("/") if portal else ""
    if meta.get("record"):
        return str(fields.get("url") or fields.get("link") or "")
    if item.get("file_id"):
        return f"/api/datasets/{dataset_id}/items/{item['id']}/file"
    return meta.get("url") or portal


def item_vars(ds: DatasetDef, item: dict) -> dict:
    fields = item.get("fields") or {}
    summary = render_fields(fields, ds.fields if not item["meta"].get("record") else None)
    if not summary:
        summary = (item.get("text") or "")[:1500]
    return {"id": item["id"], "key": f"{ds.id}:{item['id']}", "dataset": ds.id,
            "dataset_name": ds.name or ds.id, "title": item.get("title") or "",
            "source_type": item.get("source_type") or "", "text": item.get("text") or "",
            "summary": summary, "fields": fields, "meta": item.get("meta") or {},
            "url": item_url(ds.id, item)}


def _matches(where: dict[str, list[str]], item: dict, file_names: dict[int, str]) -> bool:
    for key, allowed in where.items():
        if not allowed:
            continue
        if key == "source_type":
            value = item.get("source_type")
        elif key == "file":
            value = file_names.get(item.get("file_id"))
        else:
            value = (item.get("fields") or {}).get(key, (item.get("meta") or {}).get(key))
        values = value if isinstance(value, list) else [value]
        if not any(str(v) in allowed for v in values if v is not None):
            return False
    return True


def _compile(defn: RetrieverDef, overrides: dict[str, str]) -> dict:
    mapping = {**DEFAULT_MAPPING, **{k: v for k, v in defn.mapping.items() if v},
               **{k: v for k, v in overrides.items() if v}}
    return {k: _env.from_string(v) for k, v in mapping.items() if k in MAPPING_KEYS}


def corpus_key(defn: RetrieverDef) -> str:
    versions = {s.dataset: DatasetStore(s.dataset).version() for s in defn.sources}
    embedder = get_embedder(defn.embedder)
    return content_hash({"sources": [s.model_dump() for s in defn.sources], "mapping": defn.mapping,
                         "unit": defn.unit, "embedder": embedder.key, "versions": versions})


def _load_entries(defn: RetrieverDef) -> tuple[list[Entry], dict, dict, dict, list[str]]:
    entries: list[Entry] = []
    items: dict[str, dict] = {}
    names: dict[str, str] = {}
    versions: dict[str, int] = {}
    warnings: list[str] = []
    for source in defn.sources:
        try:
            ds = workspace.datasets.get(source.dataset)
        except NotFound:
            warnings.append(f"dataset {source.dataset!r} not found")
            continue
        store = DatasetStore(ds.id)
        if not store.exists:
            warnings.append(f"dataset {ds.id!r} has no content yet")
            continue
        names[ds.id] = ds.name or ds.id
        versions[ds.id] = store.version()
        tpl = _compile(defn, source.mapping)
        file_names = {f["id"]: f["name"] for f in store.list_files()} if "file" in source.where else {}
        chunks_by_item: dict[int, list[dict]] = {}
        if defn.unit != "items":
            for c in store.chunks():
                chunks_by_item.setdefault(c["item_id"], []).append(c)
        for item in store.list_items():
            if not _matches(source.where, item, file_names):
                continue
            v = item_vars(ds, item)
            key = v["key"]
            items[key] = v
            title = tpl["title"].render(item=v, fields=v["fields"]).strip() or v["title"]
            url = tpl["url"].render(item=v, fields=v["fields"]).strip()
            base = {"item_key": key, "dataset": ds.id, "item_id": item["id"], "title": title,
                    "url": url, "source_type": v["source_type"]}
            if defn.unit in ("items", "items+chunks"):
                text = tpl["text"].render(item=v, fields=v["fields"]).strip()
                index_text = tpl["index_text"].render(item=v, fields=v["fields"]).strip()
                if text or index_text:
                    entries.append(Entry(kind="item", text=text or index_text,
                                         index_text=index_text or text, order=-1, **base))
            if defn.unit in ("chunks", "items+chunks"):
                for c in chunks_by_item.get(item["id"], []):
                    if defn.unit == "items+chunks" and c["label"] == "summary":
                        continue  # the item entry already covers it
                    cv = {"text": c["text"], "label": c["label"], "idx": c["idx"]}
                    text = tpl["chunk_text"].render(item=v, chunk=cv, fields=v["fields"]).strip()
                    index_text = tpl["chunk_index_text"].render(item=v, chunk=cv, fields=v["fields"]).strip()
                    if text or index_text:
                        entries.append(Entry(kind="chunk", text=text or index_text,
                                             index_text=index_text or text, label=c["label"],
                                             order=c["idx"], **base))
    return entries, items, names, versions, warnings


_corpora: dict[str, Corpus] = {}
_building: dict[str, asyncio.Lock] = {}
_MAX_CORPORA = 12


async def get_corpus(defn: RetrieverDef) -> Corpus:
    key = corpus_key(defn)
    if key in _corpora:
        return _corpora[key]
    lock = _building.setdefault(key, asyncio.Lock())
    async with lock:
        if key in _corpora:
            return _corpora[key]
        started = time.perf_counter()
        entries, items, names, versions, warnings = await asyncio.to_thread(_load_entries, defn)
        index = await HybridIndex.build([e.index_text for e in entries], get_embedder(defn.embedder))
        corpus = Corpus(entries, index, items, names, versions, warnings, time.time(),
                        int((time.perf_counter() - started) * 1000))
        while len(_corpora) >= _MAX_CORPORA:
            _corpora.pop(next(iter(_corpora)))
        _corpora[key] = corpus
    _building.pop(key, None)
    return corpus


def corpus_status(defn: RetrieverDef) -> dict:
    try:
        key = corpus_key(defn)
    except ValueError as exc:
        return {"built": False, "error": str(exc)}
    corpus = _corpora.get(key)
    if corpus is None:
        return {"built": False, "building": key in _building}
    return {"built": True, "entries": len(corpus.entries), "items": len(corpus.items),
            "datasets": corpus.versions, "warnings": corpus.warnings, "build_ms": corpus.build_ms,
            "embedder": corpus.index.embedder.key}


# -------------------------------------------------------------------- methods

def _helper_spec(defn: RetrieverDef):
    spec = resolve_spec(defn.model)
    return spec if defn.model.reasoning_effort else spec.model_copy(update={"reasoning_effort": "none"})


async def _json_call(defn: RetrieverDef, prompt: str, ledger: Ledger, max_tokens: int = 1500) -> dict:
    out = await complete(_helper_spec(defn), [{"role": "user", "content": prompt}],
                         max_tokens=max_tokens, temperature=0.0)
    ledger.add(out)
    data = parse_json(out.text)
    return data if isinstance(data, dict) else {}


def _string_list(value) -> list[str]:
    return [s.strip() for s in value or [] if isinstance(s, str) and s.strip()]


def _limit_per_item(corpus: Corpus, hits: list[tuple[int, float]], per_item: int,
                    k: int) -> list[tuple[int, float]]:
    out, count = [], {}
    for j, score in hits:
        key = corpus.entries[j].item_key
        if count.get(key, 0) >= per_item:
            continue
        count[key] = count.get(key, 0) + 1
        out.append((j, score))
        if len(out) >= k:
            break
    return out


def _doc_order(corpus: Corpus, picked: list[tuple[int, float]]) -> list[tuple[int, float]]:
    """Group by item (first appearance), passages in reading order."""
    first: dict[str, int] = {}
    for n, (j, _) in enumerate(picked):
        first.setdefault(corpus.entries[j].item_key, n)
    return sorted(picked, key=lambda p: (first[corpus.entries[p[0]].item_key], corpus.entries[p[0]].order))


async def _select(defn: RetrieverDef, corpus: Corpus, req: RetrievalRequest, budget: int,
                  ledger: Ledger, meta: dict) -> list[tuple[int, float]]:
    allowed = corpus.mask(req.datasets)
    queries = req.basic_queries()
    if defn.method in ("hybrid", "catalog") and defn.query_rewrite and req.conversation:
        data = await _json_call(defn, REWRITE_PROMPT.format(situation=req.situation()), ledger, 600)
        queries = _string_list(data.get("queries"))[:5] + queries[:2]
    meta["queries"] = queries

    if defn.method == "hybrid":
        hits = await corpus.index.search(queries, k=defn.k * 4, allowed=allowed, depth=max(50, defn.k * 4),
                                         dense_weight=defn.dense_weight, bm25_weight=defn.bm25_weight)
        return _limit_per_item(corpus, hits, defn.max_per_item, defn.k)

    if defn.method == "facets":
        data = await _json_call(defn, FACET_PROMPT.format(situation=req.situation()), ledger, 800)
        facets = _string_list(data.get("queries"))[:12] + queries[:2]
        meta["queries"] = facets
        picked = await corpus.index.coverage_select(
            facets, budget=int(budget * 1.05), allowed=allowed,
            item_of=[e.item_key for e in corpus.entries], per_item=defn.max_per_item)
        return _doc_order(corpus, picked)

    in_scope = [j for j, e in enumerate(corpus.entries) if allowed is None or allowed[j]]

    if defn.method == "catalog":
        keys = list(dict.fromkeys(corpus.entries[j].item_key for j in in_scope))
        line = _env.from_string(defn.catalog_line or DEFAULT_CATALOG_LINE)
        ids = {f"D{n}": key for n, key in enumerate(keys)}
        catalog = "\n".join(
            f"{did} | " + " ".join(line.render(item=corpus.items[key], fields=corpus.items[key]["fields"]).split())
            for did, key in ids.items())
        meta["catalog_chars"] = len(catalog)
        data = await _json_call(defn, CATALOG_PROMPT.format(situation=req.situation(), catalog=catalog,
                                                            n=defn.catalog_max), ledger)
        chosen = list(dict.fromkeys(ids[i] for i in _string_list(data.get("ids")) if i in ids))
        chosen = chosen[:defn.catalog_max]
        meta["picked"] = [corpus.items[k]["title"] for k in chosen]
        if not chosen:
            return []
        by_item: dict[str, list[int]] = {}
        for j in in_scope:
            by_item.setdefault(corpus.entries[j].item_key, []).append(j)
        qvec = (await corpus.index.embedder.queries([" ".join(queries)[:2000] or req.situation()[:2000]]))[0]
        out = []
        for key in chosen:
            rows = by_item.get(key, [])
            item_rows = [j for j in rows if corpus.entries[j].kind == "item"]
            if item_rows:
                out.append((item_rows[0], 1.0))
                continue
            rows.sort(key=lambda j: -float(corpus.index.vectors[j] @ qvec))
            out += [(j, float(corpus.index.vectors[j] @ qvec)) for j in rows[:defn.max_per_item]]
        return _doc_order(corpus, out) if defn.unit != "items" else out

    # all
    return _doc_order(corpus, [(j, 0.0) for j in in_scope])


# --------------------------------------------------------------- presentation

def _passage(corpus: Corpus, j: int, score: float) -> Passage:
    e = corpus.entries[j]
    return Passage(item_key=e.item_key, dataset=e.dataset, item_id=e.item_id, title=e.title, text=e.text,
                   kind=e.kind, label=e.label, source_type=e.source_type, url=e.url, score=round(score, 4),
                   fields=corpus.items[e.item_key]["fields"])


def _head(p: Passage, n: int) -> str:
    bits = [b for b in (p.source_type, f"id: {p.item_key}") if b]
    label = f" — {p.label}" if p.label and p.label != "summary" else ""
    return f"[{n}] {p.title}{label} ({'; '.join(bits)})"


def render_passages(passages: list[Passage], budget: int) -> tuple[str, int]:
    out, used = [], 0
    for p in passages:
        head = _head(p, len(out) + 1)
        body = p.text.strip()
        room = budget - used - len(head) - 3
        if room < 200:
            break
        if len(body) > room:
            body = body[:room].rsplit(" ", 1)[0] + " …"
        block = f"{head}\n{body}"
        out.append(block)
        used += len(block) + 2
    return "\n\n".join(out), len(out)


def render_json(passages: list[Passage], fields: list[str], budget: int) -> tuple[str, int]:
    rows = []
    for p in passages:
        data = p.fields if not fields else {k: p.fields.get(k) for k in fields}
        row = {"id": p.item_key, "title": p.title, **data}
        if p.kind == "chunk" and p.label != "summary":
            row["passage"] = p.text
        rows.append(row)
    while rows:
        text = json.dumps(rows, ensure_ascii=False, indent=1, default=str)
        if len(text) <= budget or len(rows) == 1:
            return text[:budget], len(rows)
        rows.pop()
    return "[]", 0


def _documents(passages: list[Passage]) -> list[str]:
    """One block per item, its passages joined in order."""
    docs: dict[str, list[Passage]] = {}
    for p in passages:
        docs.setdefault(p.item_key, []).append(p)
    out = []
    for key, ps in docs.items():
        p = ps[0]
        kind = f"{p.source_type}, " if p.source_type else ""
        out.append(f"## {p.title} ({kind}id: {key})\n" + "\n\n".join(x.text.strip() for x in ps))
    return out


def _batches(docs: list[str], limit: int) -> list[str]:
    out, cur, size = [], [], 0
    for d in docs:
        d = d[:limit]
        if cur and size + len(d) > limit:
            out.append("\n\n".join(cur))
            cur, size = [], 0
        cur.append(d)
        size += len(d)
    if cur:
        out.append("\n\n".join(cur))
    return out


async def render_brief(defn: RetrieverDef, passages: list[Passage], req: RetrievalRequest,
                       budget: int, ledger: Ledger, meta: dict) -> str:
    if not passages:
        return ""
    spec = _helper_spec(defn)
    situation = req.situation()
    words = max(80, int(budget / 6.5))
    instructions = f"\n\n{defn.brief_prompt.strip()}" if defn.brief_prompt.strip() else ""
    batches = _batches(_documents(passages), BRIEF_BATCH_CHARS)
    meta["brief_batches"] = len(batches)
    if len(batches) == 1:
        source, material = "Here are documents from the library:", batches[0]
    else:
        async def one(batch: str) -> str:
            out = await complete(spec, [{"role": "user", "content": MAP_PROMPT.format(
                situation=situation, docs=batch)}], max_tokens=1500, temperature=0.0)
            ledger.add(out)
            return out.text.strip()

        notes = [n for n in await asyncio.gather(*(one(b) for b in batches))
                 if n and n.strip().upper() != "NONE"]
        meta["brief_notes"] = len(notes)
        if not notes:
            return "The library has nothing relevant to this situation."
        source = "Readers went through the library and took these notes:"
        material = "\n\n---\n\n".join(notes)
    out = await complete(spec, [{"role": "user", "content": REDUCE_PROMPT.format(
        situation=situation, source=source, material=material, words=words,
        instructions=instructions)}], max_tokens=int(words * 2.5) + 200, temperature=0.0)
    ledger.add(out)
    return out.text.strip()[:budget]


# ------------------------------------------------------------------------ run

@dataclass
class RetrievalResult:
    text: str
    pack: ContextPack

    def to_dict(self, with_text: bool = True) -> dict:
        return {"text": self.text, "brief": self.pack.brief,
                "passages": [p.to_dict(with_text) for p in self.pack.passages], "meta": self.pack.meta}


async def run_retriever(defn: RetrieverDef, req: RetrievalRequest) -> RetrievalResult:
    started = time.perf_counter()
    budget = req.budget or defn.budget
    ledger = Ledger()
    meta: dict = {"retriever": defn.id, "method": defn.method, "presentation": defn.presentation,
                  "unit": defn.unit, "budget": budget}
    if req.datasets is not None:
        known = {s.dataset for s in defn.sources}
        meta["scope"] = req.datasets
        if not set(req.datasets) & known:
            meta["warnings"] = [f"none of {req.datasets} is a source of this retriever"]
    corpus = await get_corpus(defn)
    meta["entries"] = len(corpus.entries)
    if corpus.warnings:
        meta.setdefault("warnings", []).extend(corpus.warnings)
    t_select = time.perf_counter()
    picked = await _select(defn, corpus, req, budget, ledger, meta)
    passages = [_passage(corpus, j, s) for j, s in picked]
    t_present = time.perf_counter()
    pack = ContextPack(passages, meta=meta)
    if defn.presentation == "json":
        text, shown = render_json(passages, defn.json_fields, budget)
    elif defn.presentation == "template":
        variables = {"passages": [p.to_dict() for p in passages],
                     "items": [p.to_dict() for p in pack.items()],
                     "request": {"question": req.question, "queries": meta.get("queries", [])},
                     "budget": budget}
        text = _env.from_string(defn.template or "{% for p in passages %}{{ p.title }}\n{{ p.text }}\n\n"
                                "{% endfor %}").render(**variables).strip()[:budget]
        shown = len(passages)
    elif defn.presentation == "brief":
        text = await render_brief(defn, passages, req, budget, ledger, meta)
        pack.brief = text
        shown = len(passages)
    else:
        text, shown = render_passages(passages, budget)
    done = time.perf_counter()
    meta.update({"selected": len(passages), "shown": shown, "chars": len(text),
                 "ms": {"index": int((t_select - started) * 1000), "select": int((t_present - t_select) * 1000),
                        "present": int((done - t_present) * 1000), "total": int((done - started) * 1000)},
                 **ledger.to_dict()})
    return RetrievalResult(text, pack)


def get_retriever_def(retriever: str | RetrieverDef | dict) -> RetrieverDef:
    if isinstance(retriever, RetrieverDef):
        return retriever
    if isinstance(retriever, dict):
        return RetrieverDef.model_validate(retriever)
    return workspace.retrievers.get(retriever)
