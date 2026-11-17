"""
Import BotBase's processed R2MR libraries as datasets, plus retrievers and
systems to compare retrieval methods on them.

    python scripts/import_botbase_datasets.py [--botbase E:/Experiments/BotBase] [--force]

For every library in ``settings.knowledge.libraries`` (BotBase's
``processed_resources/<lib>/``):

* a dataset with the same id, whose fields describe what BotBase's summary
  step extracted (summary_topic, description, keywords, takeaways), so new
  uploads can be extracted the same way;
* one item per resource **with the same id** (RES ids and memory notes stay
  valid), its fields from the database row, its sections from BotBase's
  transcript JSON when present, and **BotBase's own chunks** (the embedding
  service's ``embedded_texts.pkl``), so the datasets backend searches the
  same passages;
* the resource's file, linked in place (not copied).

Then, unless they exist (``--force`` replaces them):

* retrievers ``r2mr-hybrid`` (search across all topics), ``r2mr-catalog``
  (LLM picks from a catalog of every resource) and ``r2mr-mapreduce``
  (a brief from a full read of the library — rag_lab's best);
* systems ``r2mr-coach-datasets`` (r2mr-coach with its library tools on the
  datasets backend instead of BotBase's embedding service) and
  ``r2mr-coach-catalog`` (that, plus the catalog retriever's material
  injected into the coach's instruction in topic modes).
"""

from __future__ import annotations

import argparse
import json
import pickle
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from sbf.data import DatasetStore, extraction_hash, file_kind  # noqa: E402
from sbf.schemas import (ChunkingConfig, ContextDef, DatasetDef, ExtractionConfig, FieldDef,  # noqa: E402
                         ModelSpec, RetrieverDef, RetrieverSource)
from sbf.settings import get_settings  # noqa: E402
from sbf.workspace import workspace  # noqa: E402

FIELDS = [
    FieldDef(name="summary_topic", type="text", required=True,
             description="The main topic of the resource, in a few words."),
    FieldDef(name="description", type="long_text", required=True,
             description="A 2-4 sentence summary of what the resource covers and teaches."),
    FieldDef(name="keywords", type="list",
             description="5-10 key terms: the skills, concepts and models it covers."),
    FieldDef(name="takeaways", type="list",
             description="3-6 practical takeaways someone should remember."),
]
INSTRUCTIONS = ("The library supports a coach in the Road to Mental Readiness (R2MR) program for "
                "Canadian Armed Forces members: stress, coping, recovery, mental skills and performance.")
META_COLUMNS = ("physical_address", "portal_url", "lesson_id")
LIBRARY_DESCRIPTION = ("The R2MR training library (skill guides, fact sheets, slide decks, e-learning "
                       "course pages, video transcripts): stress and coping, recovery and sleep, "
                       "trainable mental skills, and performing under pressure.")


def _list(value) -> list[str]:
    if isinstance(value, list):
        return value
    if not value:
        return []
    try:
        data = json.loads(value)
        return [str(v) for v in data] if isinstance(data, list) else [str(data)]
    except ValueError:
        return [v.strip() for v in str(value).split(",") if v.strip()]


def _transcript(botbase: Path, row: dict) -> list[dict] | None:
    """Sections from BotBase's transcript JSON, if there is one."""
    folder, name = row.get("physical_address") or "", row.get("source_file") or ""
    if not folder or not name:
        return None
    path = botbase / "data" / "Transcripts" / folder / f"with summary_{name}.json"
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    sections = [{"label": s.get("label") or "", "kind": s.get("section_type") or "text",
                 "text": (s.get("text") or "").strip()} for s in data.get("sections") or []]
    return [s for s in sections if s["text"]] or None


def import_library(botbase: Path, lib: str, info: dict, force: bool) -> int:
    folder = botbase / "processed_resources" / lib
    if not (folder / "database.db").is_file():
        print(f"  {lib}: no database, skipped")
        return 0
    if workspace.datasets.exists(lib) and not force:
        print(f"  {lib}: dataset exists (use --force to replace)")
        return 0
    ds = DatasetDef(
        id=lib, name=info.get("label") or lib, description=info.get("description") or "",
        tags=["r2mr", "botbase"], fields=FIELDS,
        extraction=ExtractionConfig(model=ModelSpec(preset="helper"), instructions=INSTRUCTIONS),
        chunking=ChunkingConfig(chunk_chars=4000, overlap=0, summary_chunk=True),
        notes="Imported from BotBase (scripts/import_botbase_datasets.py): item ids, fields and chunks "
              "are BotBase's own.")
    workspace.datasets.save(ds)
    store = DatasetStore(lib)
    store.destroy()
    current = extraction_hash(ds)

    texts = pickle.load(open(folder / "embedded_texts.pkl", "rb"))
    mapping = pickle.load(open(folder / "text_to_resource_mapping.pkl", "rb"))
    chunks: dict[int, list[dict]] = {}
    for idx in sorted(texts):
        text = texts[idx]
        chunks.setdefault(int(mapping[idx]), []).append(
            {"label": "summary" if text.startswith("Title: ") else "", "text": text})

    conn = sqlite3.connect(f"file:{folder / 'database.db'}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute("SELECT * FROM resources ORDER BY id")]
    conn.close()
    file_root = Path(get_settings().knowledge.file_root or botbase / "data")
    linked = 0
    for row in rows:
        file_id = None
        if row.get("source_path") and (row.get("source_type") or "") != "course_page":
            path = (file_root / row["source_path"]).resolve()
            if path.is_file():
                f = store.add_file(row.get("source_file") or path.name, str(path), linked=True,
                                   kind=file_kind(path.name), size=path.stat().st_size, status="ready")
                file_id = f["id"]
                linked += 1
        text = row.get("full_transcript") or row.get("description") or ""
        fields = {"summary_topic": row.get("summary_topic") or None,
                  "description": row.get("description") or None,
                  "keywords": _list(row.get("keywords")) or None,
                  "takeaways": _list(row.get("takeaways")) or None}
        meta = {k: row[k] for k in META_COLUMNS if row.get(k)}
        if row.get("source_file"):
            meta["file"] = row["source_file"]
        store.insert_item({
            "file_id": file_id, "title": row.get("title") or "", "source_type": row.get("source_type") or "",
            "text": text, "fields": fields, "meta": meta, "extraction_hash": current,
            "sections": _transcript(botbase, row) or ([{"label": "", "text": text}] if text else []),
            "chunks": chunks.get(row["id"], []),
        }, item_id=row["id"])
    print(f"  {lib}: {len(rows)} items, {sum(len(c) for c in chunks.values())} chunks, {linked} files linked")
    return len(rows)


def make_retrievers(libs: list[str], force: bool) -> None:
    sources = [RetrieverSource(dataset=lib) for lib in libs]
    helper = ModelSpec(preset="helper")
    retrievers = [
        RetrieverDef(
            id="r2mr-hybrid", name="R2MR — hybrid search (all topics)", description=LIBRARY_DESCRIPTION,
            tags=["r2mr"], sources=sources, unit="chunks", method="hybrid", k=10, max_per_item=2,
            presentation="passages", budget=12000, model=helper,
            notes="Plain hybrid (dense + BM25, RRF) over BotBase's chunks of every topic library: "
                  "rag_lab's 'hybrid'. Scope it to the active topic with scope_state_key: library to "
                  "emulate production's one-topic search."),
        RetrieverDef(
            id="r2mr-catalog", name="R2MR — catalog (LLM picks resources)", description=LIBRARY_DESCRIPTION,
            tags=["r2mr"], sources=sources, unit="items", method="catalog", catalog_max=10,
            catalog_line="{{ item.title }} ({{ item.source_type }}) — {{ fields.summary_topic }}: "
                         "{{ fields.description | replace('\\n', ' ') | truncate(180) }}",
            mapping={"text": "{{ fields.description }}\n{% if fields.takeaways %}Takeaways: "
                             "{{ fields.takeaways | join('; ') }}\n{% endif %}{{ item.text | truncate(900) }}"},
            presentation="passages", budget=12000, model=helper,
            notes="One line per resource shown to an LLM, which picks what fits the whole situation; "
                  "each pick is shown with its summary, takeaways and the start of its text. Close to "
                  "rag_lab's 'catalog' (which used graph entities rather than documents)."),
        RetrieverDef(
            id="r2mr-mapreduce", name="R2MR — map-reduce brief (full read)", description=LIBRARY_DESCRIPTION,
            tags=["r2mr"], sources=sources, unit="items", method="all",
            mapping={"text": "{{ item.text }}", "index_text": "{{ item.title }}\n{{ item.summary }}"},
            presentation="brief", budget=8000, model=helper,
            brief_prompt="Organize it as: why this is happening (concepts), what can help (practices, "
                         "with how and when to use them relative to their situation), resources.",
            notes="Every resource's full text read in batches for this person's situation, notes merged "
                  "into one brief: rag_lab's 'mapreduce', its best retriever (~15 LLM calls per "
                  "retrieval)."),
    ]
    for r in retrievers:
        if workspace.retrievers.exists(r.id) and not force:
            print(f"  retriever {r.id}: exists")
            continue
        workspace.retrievers.save(r)
        print(f"  retriever {r.id}: saved")


def make_systems(force: bool) -> None:
    if not workspace.systems.exists("r2mr-coach"):
        print("  r2mr-coach not found (run scripts/import_botbase.py first); no systems made")
        return
    base = workspace.systems.get("r2mr-coach")
    on_datasets = {"backend": "datasets"}

    def with_datasets(system):
        nodes = []
        for node in system.nodes:
            overrides = dict(node.tool_config)
            names = {"coach": ("provide_file", "open_course_page"),
                     "summarizer": ("search_resources", "examine_resource")}.get(node.id, ())
            for name in names:
                overrides[name] = {**overrides.get(name, {}), **on_datasets}
            nodes.append(node.model_copy(update={"tool_config": overrides}))
        return system.model_copy(update={"nodes": nodes})

    variants = []
    datasets = with_datasets(base).model_copy(update={
        "id": "r2mr-coach-datasets", "name": "R2MR Coach (datasets backend)",
        "tags": [*base.tags, "datasets"],
        "description": "r2mr-coach with its library tools on this framework's datasets instead of "
                       "BotBase's embedding service: same libraries, ids and chunks, our own index.",
        "notes": "Compare with r2mr-coach to check the datasets backend against the embedding service."})
    variants.append(datasets)
    nodes = []
    for node in datasets.nodes:
        if node.id == "coach":
            node = node.model_copy(update={"context": [ContextDef(
                name="library_material", retriever="r2mr-catalog", label="Library material for this person",
                condition="mode.id and mode.id != 'router'")]})
        nodes.append(node)
    variants.append(datasets.model_copy(update={
        "id": "r2mr-coach-catalog", "name": "R2MR Coach (+ injected catalog material)", "nodes": nodes,
        "description": "r2mr-coach-datasets plus, in topic modes, material the r2mr-catalog retriever "
                       "picks for the whole conversation, injected into the coach's instruction before "
                       "it replies (rag_lab's 'inject' delivery).",
        "notes": "Swap the context retriever to r2mr-mapreduce for rag_lab's best (slower, ~15 LLM "
                 "calls per turn)."}))
    for system in variants:
        if workspace.systems.exists(system.id) and not force:
            print(f"  system {system.id}: exists")
            continue
        workspace.systems.save(system)
        print(f"  system {system.id}: saved")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--botbase", default=str(ROOT.parent / "BotBase"))
    parser.add_argument("--force", action="store_true", help="Replace existing datasets/retrievers/systems")
    args = parser.parse_args()
    botbase = Path(args.botbase)
    libraries = get_settings().knowledge.libraries
    if not libraries:
        print("No libraries in settings.knowledge.libraries (run scripts/import_botbase.py first)")
        return 1
    print("Datasets:")
    for lib, info in libraries.items():
        import_library(botbase, lib, info, args.force)
    print("Retrievers:")
    make_retrievers([lib for lib in libraries if workspace.datasets.exists(lib)], args.force)
    print("Systems:")
    make_systems(args.force)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
