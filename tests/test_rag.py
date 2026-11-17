"""RAG data: conversion, the extraction pipeline, retrievers, RAG tools and
context injection — on fake LLMs and the hashing embedder (no network, no
model downloads)."""

from __future__ import annotations

import asyncio
import json
import shutil
import time
from pathlib import Path

import pytest

from sbf.data import DatasetStore, extraction_hash
from sbf.data.convert import convert
from sbf.data.extract import chunk_sections
from sbf.data.jobs import process_file
from sbf.llm import Completion
from sbf.rag import RetrievalRequest, run_retriever
from sbf.schemas import (AgentDef, ChunkingConfig, ContextDef, DatasetDef, ExtractionConfig, FieldDef,
                         ModelSpec, NodeDef, RetrieverDef, RetrieverSource, SystemDef, ToolBinding,
                         VisionConfig)
from sbf.settings import EmbedderSpec, get_settings, save_settings
from sbf.workspace import workspace

CALLS: list[dict] = []


async def fake_complete(spec, messages, **kwargs):
    content = messages[-1]["content"]
    CALLS.append({"model": spec.model, "content": content, "n": len(messages)})
    if isinstance(content, list):  # vision
        return Completion("A diagram titled Box Breathing: inhale 4, hold 4, exhale 4, hold 4.", cost=0.001)
    text = content
    if "Fix these problems" in text:
        return Completion(json.dumps({"topic": "Breathing", "keywords": ["breath"], "level": "beginner"}))
    if "Return one JSON object" in messages[0]["content"]:
        doc = messages[0]["content"]
        if "Box Breathing" in doc and len(messages) == 1:
            # First try breaks the enum; the retry fixes it.
            return Completion(json.dumps({"topic": "Breathing", "keywords": "breath, calm", "level": "expert"}))
        topic = "Sleep" if "sleep" in doc.lower() else "Breathing" if "breath" in doc.lower() else "Other"
        return Completion(json.dumps({"topic": topic, "keywords": [topic.lower()], "level": "beginner"}))
    if '"queries"' in text:
        return Completion(json.dumps({"queries": ["sleep hygiene routine", "breathing to calm down"]}))
    if '"ids"' in text:
        return Completion(json.dumps({"ids": ["D1"]}))
    if "evidence brief" in text:
        return Completion("BRIEF: sleep routine and box breathing (data:1, data:2).")
    return Completion("NONE")


@pytest.fixture
def fake_llm(monkeypatch):
    import sbf.data.extract as extract
    import sbf.rag.retriever as retriever
    monkeypatch.setattr(extract, "complete", fake_complete)
    monkeypatch.setattr(retriever, "complete", fake_complete)
    settings = get_settings()
    settings.embedders = {"default": EmbedderSpec(provider="hash", model="hash")}
    save_settings(settings)
    CALLS.clear()
    return CALLS


def _png(path: Path) -> Path:
    from PIL import Image
    Image.new("RGB", (60, 40), "white").save(path)
    return path


# ------------------------------------------------------------------ convert

def test_convert_formats(tmp_path):
    vision_off, vision_on = VisionConfig(), VisionConfig(enabled=True)

    md = tmp_path / "guide.md"
    md.write_text("# Sleep guide\nIntro text.\n## Routine\nGo to bed at the same time.\n", encoding="utf-8")
    doc = convert(md, md.name, vision_off)
    assert doc.title == "Sleep guide" and [s.label for s in doc.sections] == ["Sleep guide", "Routine"]

    html = tmp_path / "page.html"
    html.write_text("<html><title>T</title><body><h1>Head</h1><p>Para one.</p><ul><li>Item</li></ul>"
                    "<script>x()</script></body></html>", encoding="utf-8")
    doc = convert(html, html.name, vision_off)
    assert doc.title == "T" and "Para one." in doc.text and "- Item" in doc.text and "x()" not in doc.text

    import docx
    d = docx.Document()
    d.add_heading("Breathing", level=1)
    d.add_paragraph("Inhale slowly.")
    table = d.add_table(rows=1, cols=2)
    table.rows[0].cells[0].text, table.rows[0].cells[1].text = "Step", "Count"
    d.save(tmp_path / "doc.docx")
    doc = convert(tmp_path / "doc.docx", "doc.docx", vision_off)
    assert doc.sections[0].label == "Breathing" and "Step | Count" in doc.text

    from pptx import Presentation
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    slide.shapes.title.text = "Stress"
    slide.placeholders[1].text = "Stress is the body's response to demands."
    slide.notes_slide.notes_text_frame.text = "Speaker note."
    prs.save(tmp_path / "deck.pptx")
    doc = convert(tmp_path / "deck.pptx", "deck.pptx", vision_off)
    assert doc.sections[0].label == "Slide 1: Stress" and "Notes: Speaker note." in doc.text

    csv_path = tmp_path / "rows.csv"
    csv_path.write_text("name,phone\nClinic A,555-1\nClinic B,555-2\n", encoding="utf-8")
    assert convert(csv_path, csv_path.name, vision_off).records == [
        {"name": "Clinic A", "phone": "555-1"}, {"name": "Clinic B", "phone": "555-2"}]

    js = tmp_path / "items.json"
    js.write_text(json.dumps({"items": [{"title": "A"}, {"title": "B"}]}), encoding="utf-8")
    assert len(convert(js, js.name, vision_off).records) == 2

    import openpyxl
    wb = openpyxl.Workbook()
    wb.active.append(["title", "n"])
    wb.active.append(["Row", 3])
    wb.save(tmp_path / "sheet.xlsx")
    assert convert(tmp_path / "sheet.xlsx", "sheet.xlsx", vision_off).records == [{"title": "Row", "n": 3}]

    vtt = tmp_path / "talk.vtt"
    vtt.write_text("WEBVTT\n\n1\n00:00.000 --> 00:02.000\nHello there.\n\n2\n00:02.000 --> 00:04.000\n"
                   "General Kenobi.\n", encoding="utf-8")
    assert convert(vtt, vtt.name, vision_off).text == "Hello there. General Kenobi."

    # An image-only PDF is a scan: a warning without vision, an image to read with it.
    from PIL import Image
    Image.new("RGB", (200, 100), "white").save(tmp_path / "scan.pdf")
    doc = convert(tmp_path / "scan.pdf", "scan.pdf", vision_off)
    assert doc.warnings and doc.sections[0].image is None
    doc = convert(tmp_path / "scan.pdf", "scan.pdf", vision_on)
    assert doc.sections[0].image and doc.sections[0].source == "vision"

    png = _png(tmp_path / "pic.png")
    assert convert(png, png.name, vision_off).unsupported
    assert convert(png, png.name, vision_on).sections[0].image
    assert convert(tmp_path / "x.mp4", "x.mp4", vision_off).unsupported


def test_chunking():
    text = " ".join(f"Sentence number {i} is here." for i in range(200))
    chunks = chunk_sections([{"label": "Page 1", "text": text}, {"label": "Page 2", "text": "Short."}],
                            ChunkingConfig(chunk_chars=500, overlap=60))
    assert len(chunks) > 5
    assert all(len(c["text"]) <= 560 for c in chunks)
    # Consecutive chunks overlap.
    assert chunks[1]["text"][:20] in chunks[0]["text"]
    assert chunks[-1]["text"].endswith("Short.") and chunks[-1]["label"] == "Page 1 – Page 2"


# ----------------------------------------------------------------- pipeline

FIELDS = [FieldDef(name="topic", required=True, description="Main topic"),
          FieldDef(name="keywords", type="list"),
          FieldDef(name="level", type="enum", options=["beginner", "advanced"])]


def _add(store: DatasetStore, src: Path) -> int:
    store.files_dir.mkdir(parents=True, exist_ok=True)
    f = store.add_file(src.name, "")
    shutil.copy(src, store.files_dir / f"{f['id']}-{src.name}")
    store.set_file_path(f["id"], f"{f['id']}-{src.name}")
    return f["id"]


@pytest.fixture
def dataset(fake_llm, tmp_path):
    ds = DatasetDef(id="data", name="Data", fields=FIELDS,
                    extraction=ExtractionConfig(model=ModelSpec(provider="litellm", model="x")),
                    vision=VisionConfig(enabled=True, model=ModelSpec(provider="litellm", model="v")),
                    chunking=ChunkingConfig(chunk_chars=400, overlap=40))
    workspace.datasets.save(ds)
    store = DatasetStore("data")
    store.destroy()
    (tmp_path / "sleep.txt").write_text("Sleep hygiene: keep a regular sleep routine, dark room, no "
                                        "screens before bed. " * 6, encoding="utf-8")
    (tmp_path / "work.md").write_text("# Workload\nPlan your shifts and take breaks.\n", encoding="utf-8")
    png = _png(tmp_path / "breathing.png")
    (tmp_path / "clinics.csv").write_text("name,city\nClinic A,Ottawa\nClinic B,Halifax\n", encoding="utf-8")
    ids = [_add(store, p) for p in (tmp_path / "sleep.txt", png, tmp_path / "work.md", tmp_path / "clinics.csv")]
    for fid in ids:
        asyncio.run(process_file("data", fid))
    return ds, store, ids


def test_pipeline(dataset):
    ds, store, ids = dataset
    files = {f["name"]: f for f in store.list_files()}
    assert all(f["status"] == "ready" for f in files.values()), files
    sleep = store.list_items(file_id=ids[0])[0]
    assert sleep["fields"] == {"topic": "Sleep", "keywords": ["sleep"], "level": "beginner"}
    assert sleep["extraction_hash"] == extraction_hash(ds)
    # The image went through vision, then extraction: the bad enum was retried.
    image = store.list_items(file_id=ids[1])[0]
    assert "Box Breathing" in image["text"] and image["fields"]["level"] == "beginner"
    assert files["breathing.png"]["cost"] > 0
    # Each document gets a summary chunk first; table rows become items.
    chunks = store.chunks(sleep["id"])
    assert chunks[0]["label"] == "summary" and chunks[0]["text"].startswith("Title: sleep\ntopic: Sleep")
    rows = store.list_items(file_id=ids[3])
    assert [r["title"] for r in rows] == ["Clinic A", "Clinic B"] and rows[0]["fields"]["city"] == "Ottawa"
    assert store.stats(extraction_hash(ds))["stale"] == 0

    # Changing the fields makes extracted items stale; re-extraction keeps item ids.
    ds2 = ds.model_copy(update={"fields": FIELDS + [FieldDef(name="audience")]})
    workspace.datasets.save(ds2)
    assert store.stats(extraction_hash(ds2))["stale"] == 3
    asyncio.run(process_file("data", ids[0], "fields"))
    assert store.list_items(file_id=ids[0])[0]["id"] == sleep["id"]
    assert store.stats(extraction_hash(ds2))["stale"] == 2
    asyncio.run(process_file("data", ids[0], "full"))
    assert store.list_items(file_id=ids[0])[0]["id"] == sleep["id"]

    # Reprocessing a file we can't read (video) keeps text it got elsewhere.
    video = store.add_file("talk.mp4", "talk.mp4", status="ready")
    (store.files_dir / "talk.mp4").write_bytes(b"\x00")
    store.insert_item({"file_id": video["id"], "title": "talk", "source_type": "video",
                       "text": "Imported transcript about sleep."})
    asyncio.run(process_file("data", video["id"], "full"))
    assert store.list_items(file_id=video["id"])[0]["text"] == "Imported transcript about sleep."
    assert store.get_file(video["id"])["status"] == "ready"


def _retriever(**kw) -> RetrieverDef:
    base = dict(id="r", sources=[RetrieverSource(dataset="data")],
                model=ModelSpec(provider="litellm", model="helper"))
    return RetrieverDef(**{**base, **kw})


def test_retrievers(dataset):
    run = lambda defn, **req: asyncio.run(run_retriever(defn, RetrievalRequest(**req)))  # noqa: E731

    result = run(_retriever(k=3), queries=["sleep routine"])
    assert result.pack.passages[0].title == "sleep" and "[1] sleep" in result.text
    assert "id: data:1" in result.text and result.pack.meta["llm_calls"] == 0

    # Items unit + raw JSON, filtered to records.
    result = run(_retriever(unit="items", presentation="json", k=5,
                            sources=[RetrieverSource(dataset="data", where={"source_type": ["record"]})]),
                 queries=["Ottawa clinic"])
    rows = json.loads(result.text)
    assert {r["title"] for r in rows} == {"Clinic A", "Clinic B"} and rows[0]["city"] in ("Ottawa", "Halifax")

    # Mapping: the shown title comes from a field.
    result = run(_retriever(mapping={"title": "{{ fields.topic or item.title }}"}, k=1),
                 queries=["shifts breaks workload"])
    assert result.pack.passages[0].title == "Other"

    # catalog: the LLM picks D1 (second item in catalog order).
    result = run(_retriever(method="catalog", unit="items"), question="I can't calm down")
    assert len(result.pack.items()) == 1 and result.pack.meta["llm_calls"] == 1

    # facets: LLM angles + coverage selection.
    result = run(_retriever(method="facets", max_per_item=1),
                 conversation=[{"role": "user", "content": "I sleep badly and panic at work"}])
    assert result.pack.meta["queries"][:2] == ["sleep hygiene routine", "breathing to calm down"]
    assert len({p.item_key for p in result.pack.passages}) == len(result.pack.passages)

    # all + brief: everything in scope, briefed in one call.
    result = run(_retriever(method="all", unit="items", presentation="brief"), question="help")
    assert result.text.startswith("BRIEF:") and result.pack.meta["brief_batches"] == 1

    # Scope to a dataset the retriever doesn't read: nothing, with a warning.
    result = run(_retriever(), queries=["sleep"], datasets=["elsewhere"])
    assert result.pack.passages == [] and result.pack.meta["warnings"]


# ------------------------------------------------- agents: tools + context

def test_rag_tool_and_context(dataset, scripted, requests_seen):
    from sbf import db
    from sbf.runtime.engine import Engine

    workspace.retrievers.save(_retriever(id="sleepy", description="Wellbeing handouts.", k=2))
    workspace.agents.save(AgentDef(
        id="ragger", prompt="Help the user.",
        tools=[ToolBinding(tool="rag_search", config={"retriever": "sleepy"}),
               ToolBinding(tool="provide_file"), ToolBinding(tool="send_message"),
               ToolBinding(tool="finish_turn")],
        model=ModelSpec(provider="litellm", model="script:ragger")))
    workspace.systems.save(SystemDef(id="rag-sys", entry="ragger", nodes=[NodeDef(
        id="ragger", agent="ragger",
        context=[ContextDef(name="handouts", retriever="sleepy", label="Library material")])]))
    scripted["ragger"] = [("tool", "rag_search", {"query": "sleep routine"}),
                          ("tool", "provide_file", {"resource_id": "data:1"}),
                          "Here is a sleep handout."]

    async def go():
        engine = Engine()
        chat = await engine.create_chat("rag-sys")
        await engine.run_turn(chat["id"], "How do I sleep better?")
        return chat["id"]

    chat_id = asyncio.run(go())
    instruction = requests_seen["ragger"][0].config.system_instruction
    assert "====\n\nLIBRARY MATERIAL\n\n[1] sleep" in instruction
    traces = {t["event"]: t for t in db.list_traces(chat_id)}
    assert traces["context"]["data"]["name"] == "handouts" and "[1] sleep" in traces["context"]["data"]["text"]
    assert traces["retrieval"]["data"]["items"][0] == "data:1"
    files = [o for o in db.list_outputs(chat_id) if o["type"] == "file"]
    assert files and files[0]["url"] == "/api/datasets/data/items/1/file"
    # Context is computed once per turn, not per model call.
    assert sum(1 for t in db.list_traces(chat_id) if t["event"] == "context") == 1


def test_dataset_backend_for_library_tools(dataset):
    from sbf.knowledge import get_knowledge
    backend = get_knowledge("datasets")
    assert {l["id"] for l in backend.libraries()} >= {"data"}
    scores = asyncio.run(backend.search("data", ["sleep routine"], k=2))
    best = next(iter(scores))
    item = backend.get("data", best)
    assert item["id"] == f"RES_{best:05d}" and item["title"] == "sleep" and item["backend"] == "datasets"
    assert "regular sleep routine" in item["full_transcript"] and item["topic"] == "Sleep"
    assert backend.file_path("data", best).name.endswith("sleep.txt")


def test_dataset_api(fake_llm, tmp_path):
    from fastapi.testclient import TestClient
    from sbf.app import app

    with TestClient(app) as client:
        r = client.post("/api/datasets", json={"id": "up", "fields": [{"name": "topic"}],
                                               "extraction": {"model": {"provider": "litellm", "model": "x"}}})
        assert r.status_code == 201, r.text
        files = [("files", ("a.txt", b"Breathing helps you calm down.", "text/plain")),
                 ("files", ("b.txt", b"Breathing helps you calm down.", "text/plain"))]
        r = client.post("/api/datasets/up/files", files=files)
        body = r.json()
        assert len(body["added"]) == 1 and body["skipped"][0]["reason"].startswith("same content")
        for _ in range(100):
            detail = client.get("/api/datasets/up").json()
            if detail["files"][0]["status"] == "ready":
                break
            time.sleep(0.05)
        assert detail["files"][0]["status"] == "ready" and detail["stats"]["items"] == 1
        items = client.get("/api/datasets/up/items").json()["items"]
        assert items[0]["fields"] == {"topic": "Breathing"} and not items[0]["stale"]

        r = client.post("/api/retrievers", json={"id": "up-r", "sources": [{"dataset": "up"}]})
        assert r.status_code == 201
        r = client.post("/api/retrievers/run", json={"retriever": "up-r", "query": "calm breathing"})
        assert r.json()["passages"][0]["item_key"] == f"up:{items[0]['id']}"
        r = client.post("/api/retrievers/up-r/entries", json={"limit": 5})
        assert r.json()["entries"][0]["kind"] == "chunk"
        assert client.delete("/api/datasets/up").status_code == 409  # used by up-r
        assert client.get(f"/api/datasets/up/items/{items[0]['id']}/file").status_code == 200
        r = client.get(f"/api/datasets/up/items?file_id={items[0]['file_id']}")
        assert r.json()["total"] == 1

        # Usage: node tool_config overrides are plain dicts (regression: 500 on list).
        workspace.systems.save(SystemDef(id="uses-up-r", entry="n", nodes=[NodeDef(
            id="n", agent="ragger", tool_config={"rag_search": {"retriever": "up-r"}, "other": {}})]))
        r = client.get("/api/retrievers")
        assert r.status_code == 200, r.text
        used = next(x for x in r.json() if x["id"] == "up-r")["used_by"]
        assert used == [{"kind": "system", "id": "uses-up-r", "nodes": ["n"]}]
        assert client.get("/api/retrievers/up-r").status_code == 200
        assert client.delete("/api/retrievers/up-r").status_code == 409
        workspace.systems.delete("uses-up-r")
        assert client.delete("/api/retrievers/up-r").status_code == 200
