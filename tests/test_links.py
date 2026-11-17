"""Chat links: the standalone chat API for visitors without accounts —
saved and unsaved conversations, visitor isolation, access codes, consent,
limits, delivered files only, and link management."""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from sbf import auth, db, links
from sbf.runtime import get_engine
from sbf.schemas import AgentDef, ModelSpec, NodeDef, SystemDef, UIConfig
from sbf.workspace import workspace


@pytest.fixture
def client(scripted):
    scripted["linkbot"] = ["Hi! How can I help?"] * 50
    workspace.agents.save(AgentDef(id="link-agent", prompt="Help.",
                                   model=ModelSpec(provider="litellm", model="script:linkbot")))
    workspace.systems.save(SystemDef(id="link-sys", name="Link system", entry="bot",
                                     nodes=[NodeDef(id="bot", agent="link-agent")],
                                     ui=UIConfig(title="Coach", welcome="Welcome!", starters=["Hello"])))
    links._recent.clear()
    auth._failures.clear()
    from sbf.app import app
    with TestClient(app) as c:
        yield c


def _events(res) -> list[dict]:
    return [json.loads(line[6:]) for line in res.text.splitlines() if line.startswith("data: ")]


def _link(c, **settings) -> dict:
    res = c.post("/api/links", json={"label": "Pilot", "system_id": "link-sys", "settings": settings})
    assert res.status_code == 201, res.text
    return res.json()


def test_saved_link(client):
    c = client
    link = _link(c, notice="We keep transcripts for research.", require_consent=True)
    assert link["path"] == f"/c/{link['token']}" and link["status"] == "active"
    base = f"/api/public/{link['token']}"

    info = c.get(base).json()
    assert info["title"] == "Coach" and info["welcome"] == "Welcome!" and info["starters"] == ["Hello"]
    assert info["saving"] and info["require_consent"] and not info["needs_code"]
    assert c.post(f"{base}/conversations", json={}).status_code == 400  # notice not accepted
    conv = c.post(f"{base}/conversations", json={"consent": True}).json()

    events = _events(c.post(f"{base}/conversations/{conv['id']}/messages", json={"text": "hello there"}))
    kinds = {e["kind"] for e in events}
    assert kinds <= {"turn_start", "output", "turn_done", "end"}  # no traces
    replies = [e for e in events if e["kind"] == "output" and e["type"] == "message"]
    assert replies[0]["content"] == "Hi! How can I help?" and "node" not in replies[0]

    detail = c.get(f"{base}/conversations/{conv['id']}").json()
    assert [o["type"] for o in detail["outputs"]] == ["user", "message"] and detail["turns"] == 1
    assert [x["id"] for x in c.get(f"{base}/conversations").json()] == [conv["id"]]

    # A saved conversation is an ordinary chat (origin 'link'), readable in the management UI.
    chat = db.get_chat(conv["id"])
    assert chat["origin"] == "link" and chat["link_id"] == link["id"] and chat["title"] == "hello there"
    assert db.list_traces(conv["id"])
    listed = c.get(f"/api/links/{link['id']}/conversations").json()
    assert listed[0]["saved"] and listed[0]["turns"] == 1 and listed[0]["consented_at"]
    assert c.get(f"/api/links/{link['id']}").json()["stats"]["conversations"] == 1
    assert conv["id"] not in {x["id"] for x in c.get("/api/chats").json()}  # not among the team's own chats

    # Another browser (no visitor cookie) sees none of it.
    other = TestClient(c.app)
    assert other.get(f"{base}/conversations").json() == []
    assert other.get(f"{base}/conversations/{conv['id']}").status_code == 404
    assert other.post(f"{base}/conversations/{conv['id']}/messages", json={"text": "x"}).status_code == 404

    # The standalone page is served without an account.
    page = c.get(link["path"])
    assert page.status_code in (200, 404)  # 404 only when the frontend isn't built
    if page.status_code == 200:
        assert page.headers["referrer-policy"] == "no-referrer"

    # Turning the link off, and replacing its URL.
    c.put(f"/api/links/{link['id']}", json={"active": False})
    assert c.get(base).status_code == 410
    c.put(f"/api/links/{link['id']}", json={"active": True})
    rotated = c.post(f"/api/links/{link['id']}/rotate").json()
    assert c.get(base).status_code == 404 and c.get(f"/api/public/{rotated['token']}").status_code == 200

    # Deleting the link deletes its saved conversations.
    assert c.delete(f"/api/links/{link['id']}").json()["conversations"] == 1
    assert db.get_chat(conv["id"]) is None


def test_unsaved_link(client):
    c = client
    link = _link(c, save_transcripts=False)
    base = f"/api/public/{link['token']}"
    conv = c.post(f"{base}/conversations", json={}).json()
    assert not conv["saved"]
    events = _events(c.post(f"{base}/conversations/{conv['id']}/messages", json={"text": "my private worry"}))
    assert any(e.get("type") == "message" for e in events)
    events = _events(c.post(f"{base}/conversations/{conv['id']}/messages", json={"text": "and another"}))
    detail = c.get(f"{base}/conversations/{conv['id']}").json()
    assert [o["type"] for o in detail["outputs"]] == ["user", "message", "user", "message"]
    assert [o["id"] for o in detail["outputs"]] == [1, 2, 3, 4]

    # Nothing of the conversation is in the database: no chat, outputs or traces.
    assert db.get_chat(conv["id"]) is None
    with db.connect() as conn:
        for table in ("outputs", "traces", "turn_snapshots"):
            assert not conn.execute(f"SELECT 1 FROM {table} WHERE chat_id = ?", (conv["id"],)).fetchone()
    assert conv["id"] in get_engine().unsaved
    # The link keeps counts only.
    listed = c.get(f"/api/links/{link['id']}/conversations").json()
    assert listed[0]["turns"] == 2 and not listed[0]["saved"] and listed[0]["title"] is None and listed[0]["live"]

    # Ending it erases it.
    assert c.post(f"{base}/conversations/{conv['id']}/end").json() == {"ok": True, "erased": True}
    assert conv["id"] not in get_engine().unsaved
    assert c.get(f"{base}/conversations/{conv['id']}").status_code == 410
    assert links.conversation(conv["id"])["ended_by"] == "visitor"

    # Idle ones are dropped by the sweeper's rule.
    conv2 = c.post(f"{base}/conversations", json={}).json()
    engine = get_engine()
    assert asyncio.run(engine.drop_idle({conv2["id"]: 0})) == 1
    links.close_orphans(set(engine.unsaved))
    assert links.conversation(conv2["id"])["ended_by"] == "idle"


def test_link_limits_and_access(client):
    c = client
    link = _link(c, max_turns=1, messages_per_minute=2, remember_visitors=True)
    assert c.put(f"/api/links/{link['id']}", json={"access_code": "short"}).json()["detail"] ==         "Access codes need 8 to 200 characters"
    c.put(f"/api/links/{link['id']}", json={"access_code": "open sesame"})
    base = f"/api/public/{link['token']}"
    locked = c.get(base)
    assert locked.json() == {"title": "Coach", "status": "active", "needs_code": True}  # nothing else yet
    assert locked.headers["cache-control"] == "no-store"
    assert c.post(f"{base}/conversations", json={}).status_code == 403
    assert c.post(f"{base}/access", json={"code": "wrong"}).status_code == 403
    assert c.post(f"{base}/access", json={"code": "open sesame"}).json() == {"ok": True}
    info = c.get(base).json()
    assert not info["needs_code"] and info["welcome"] == "Welcome!" and info["idle_minutes"] == 60
    # A new code asks everyone again.
    c.put(f"/api/links/{link['id']}", json={"access_code": "new sesame"})
    assert c.get(base).json()["needs_code"]
    assert c.post(f"{base}/access", json={"code": "new sesame"}).json() == {"ok": True}

    conv = c.post(f"{base}/conversations", json={}).json()
    assert c.post(f"{base}/conversations/{conv['id']}/messages", json={"text": "x" * 5000}).status_code == 400
    c.post(f"{base}/conversations/{conv['id']}/messages", json={"text": "one"})
    res = c.post(f"{base}/conversations/{conv['id']}/messages", json={"text": "two"})
    assert res.status_code == 409 and "limit" in res.json()["detail"]
    # Remembered visitors keep one memory profile across conversations.
    conv2 = c.post(f"{base}/conversations", json={}).json()
    c1, c2 = links.conversation(conv["id"]), links.conversation(conv2["id"])
    assert c1["profile_id"] and c1["profile_id"] == c2["profile_id"]
    assert db.get_profile(c1["profile_id"])["origin"] == "link"
    assert all(p["id"] != c1["profile_id"] for p in db.list_profiles())  # not in the profile list
    c.post(f"{base}/conversations/{conv2['id']}/messages", json={"text": "three"})
    conv3 = c.post(f"{base}/conversations", json={}).json()
    res = c.post(f"{base}/conversations/{conv3['id']}/messages", json={"text": "four"})
    assert res.status_code == 429  # 2 messages a minute

    c.put(f"/api/links/{link['id']}", json={"settings": {**link["settings"], "max_conversations": 3}})
    assert c.get(base).json()["status"] == "full"
    assert c.post(f"{base}/conversations", json={}).status_code == 409
    c.put(f"/api/links/{link['id']}", json={"settings": {**link["settings"], "expires_at": "2000-01-01T00:00:00"}})
    assert c.get(base).json()["status"] == "expired"
    deleted = c.delete(f"/api/links/{link['id']}").json()
    assert deleted["profiles"] == 1 and db.get_profile(c1["profile_id"]) is None


def test_delivered_files_only(client, tmp_path, monkeypatch):
    c = client
    pkg = tmp_path / "course1"
    (pkg / "scormcontent" / "lib").mkdir(parents=True)
    (pkg / "imsmanifest.xml").write_text("<manifest/>")
    (pkg / "scormcontent" / "index.html").write_text("<html>lesson</html>")
    (pkg / "scormcontent" / "lib" / "app.js").write_text("// app")
    other = tmp_path / "course2"
    (other / "scormcontent").mkdir(parents=True)
    (other / "imsmanifest.xml").write_text("<manifest/>")
    (other / "scormcontent" / "index.html").write_text("<html>other</html>")
    from sbf.settings import get_settings
    monkeypatch.setattr("sbf.app.get_settings", lambda: get_settings().model_copy(update={"scorm_root": str(tmp_path)}))

    link = _link(c, save_transcripts=False)
    base = f"/api/public/{link['token']}"
    conv = c.post(f"{base}/conversations", json={}).json()
    get_engine().unsaved[conv["id"]]["outputs"].append(
        {"id": 1, "type": "viewer", "turn": 1, "title": "Lesson", "node": "bot",
         "url": "/scorm/course1/scormcontent/index.html#/lessons/abc"})
    shown = c.get(f"{base}/conversations/{conv['id']}").json()["outputs"][0]
    prefix = f"{base}/r/{conv['id']}"
    assert shown["url"] == f"{prefix}/scorm/course1/scormcontent/index.html#/lessons/abc" and "node" not in shown
    assert c.get(f"{prefix}/scorm/course1/scormcontent/index.html").text == "<html>lesson</html>"
    assert c.get(f"{prefix}/scorm/course1/scormcontent/lib/app.js").status_code == 200  # the package's assets
    assert c.get(f"{prefix}/scorm/course2/scormcontent/index.html").status_code == 404  # never delivered
    assert c.get(f"{prefix}/api/knowledge/lib/files/1").json()["detail"] == "Not available."
    assert TestClient(c.app).get(f"{prefix}/scorm/course1/scormcontent/index.html").status_code == 404


def test_link_roles():
    assert auth.required_role("GET", "/api/links") == "editor"
    assert auth.required_role("GET", "/api/links/{link_id}/conversations") == "editor"
