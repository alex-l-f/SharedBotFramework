"""Team features: accounts, roles and ownership; versioned saves (409 on
conflicts) and revision history; export/import bundles."""

from __future__ import annotations

import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from sbf import auth, bundle, db
from sbf.schemas import (AgentDef, ContextDef, DatasetDef, ModelSpec, NodeDef, PersonaDef, RetrieverDef,
                         RetrieverSource, ScenarioDef, SystemDef)
from sbf.workspace import workspace


@pytest.fixture
def team(monkeypatch, scripted):
    """Accounts on, no users yet; an agent and a system to work on."""
    monkeypatch.setenv("SBF_AUTH", "on")
    with db.connect() as conn:
        conn.execute("DELETE FROM users")
        conn.execute("DELETE FROM auth_sessions")
    auth._failures.clear()
    scripted["teambot"] = ["Hello from the bot."] * 20
    workspace.agents.save(AgentDef(id="team-agent", prompt="Help.",
                                   model=ModelSpec(provider="litellm", model="script:teambot")))
    workspace.systems.save(SystemDef(id="team-sys", entry="bot", nodes=[NodeDef(id="bot", agent="team-agent")]))
    from sbf.app import app
    with TestClient(app) as client:
        yield client


def _as(client: TestClient, token: str) -> TestClient:
    client.cookies.set(auth.COOKIE, token)
    return client


def _login(client: TestClient, username: str, password: str) -> str:
    client.cookies.clear()
    res = client.post("/api/auth/login", json={"username": username, "password": password})
    assert res.status_code == 200, res.text
    return client.cookies.get(auth.COOKIE)


def test_accounts_and_roles(team, monkeypatch):
    c = team
    status = c.get("/api/auth/status").json()
    assert status["auth"] and status["setup_needed"] and not status["setup_allowed"]  # not on this machine
    assert c.get("/api/agents").status_code == 401
    assert c.post("/api/auth/setup", json={"username": "boss", "password": "longenough"}).status_code == 403

    monkeypatch.setattr(auth, "is_loopback", lambda request: True)
    assert c.post("/api/auth/setup", json={"username": "Boss", "password": "short"}).status_code == 400
    res = c.post("/api/auth/setup", json={"username": "Boss", "password": "longenough", "display_name": "The Boss"})
    assert res.status_code == 201 and res.json()["role"] == "admin" and res.json()["username"] == "boss"
    boss = c.cookies.get(auth.COOKIE)
    assert c.get("/api/auth/me").json()["display_name"] == "The Boss"
    assert c.post("/api/auth/setup", json={"username": "x2", "password": "longenough"}).status_code == 409

    # Accounts: an editor and a viewer with temporary passwords.
    ed = c.post("/api/users", json={"username": "ed", "password": "temporary1", "role": "editor"}).json()
    vi = c.post("/api/users", json={"username": "vi", "password": "temporary2", "role": "viewer"}).json()
    assert ed["must_change_password"] and "password_hash" not in ed
    assert c.post("/api/users", json={"username": "ed", "password": "temporary1"}).status_code == 400
    assert c.put(f"/api/users/{c.get('/api/auth/me').json()['id']}", json={"role": "editor"}).status_code == 400

    # Temporary password: nothing else until it is changed.
    ed_token = _login(c, "ed", "temporary1")
    assert c.get("/api/agents").status_code == 403
    assert c.post("/api/auth/password", json={"current_password": "wrong", "new_password": "x" * 9}).status_code == 400
    assert c.post("/api/auth/password",
                  json={"current_password": "temporary1", "new_password": "editorpass"}).status_code == 200
    assert c.get("/api/agents").status_code == 200
    assert c.put("/api/settings", json={}).status_code == 403  # admins only
    assert c.get("/api/users").status_code == 403

    vi_token = _login(c, "vi", "temporary2")
    c.post("/api/auth/password", json={"current_password": "temporary2", "new_password": "viewerpass"})
    agent = c.get("/api/agents/team-agent").json()
    assert agent["version"]
    assert c.put("/api/agents/team-agent", json=agent).status_code == 403
    assert "editor role" in c.delete("/api/agents/team-agent").json()["detail"]
    assert c.post("/api/systems/team-sys/validate", json={}).json()["ok"]

    # Ownership: a viewer sees their own chats and profiles only.
    vi_chat = c.post("/api/chats", json={"system_id": "team-sys"}).json()
    assert vi_chat["user_id"] == vi["id"] and vi_chat["owner"] == "vi"
    vi_profile = c.post("/api/profiles", json={"name": "vi test profile"}).json()
    _as(c, ed_token)
    ed_chat = c.post("/api/chats", json={"system_id": "team-sys"}).json()
    ed_profile = c.post("/api/profiles", json={"name": "ed test profile"}).json()
    assert {x["id"] for x in c.get("/api/chats").json()} == {ed_chat["id"]}
    assert {vi_chat["id"], ed_chat["id"]} <= {x["id"] for x in c.get("/api/chats?scope=all").json()}
    assert c.get(f"/api/chats/{vi_chat['id']}").status_code == 200  # editors read all chats
    assert c.post(f"/api/chats/{vi_chat['id']}/messages", json={"text": "hi"}).status_code == 403
    assert c.delete(f"/api/chats/{vi_chat['id']}").status_code == 403
    _as(c, vi_token)
    assert [x["id"] for x in c.get("/api/chats?scope=all").json()] == [vi_chat["id"]]
    assert c.get(f"/api/chats/{ed_chat['id']}").status_code == 404
    assert [p["id"] for p in c.get("/api/profiles?scope=all").json()] == [vi_profile["id"]]
    assert c.post("/api/chats", json={"system_id": "team-sys", "profile_id": ed_profile["id"]}).status_code == 404
    assert c.delete(f"/api/chats/{vi_chat['id']}").json() == {"ok": True}

    # Cross-site writes are refused even with a valid session.
    assert c.post("/api/profiles", json={"name": "csrf"}, headers={"Origin": "http://evil.example"}).status_code == 403
    assert c.post("/api/profiles", json={"name": "same site"},
                  headers={"Origin": "http://testserver"}).status_code == 201

    # Admin: disable the viewer (signs them out); the last admin can't go.
    _as(c, boss)
    assert c.put(f"/api/users/{vi['id']}", json={"disabled": True}).json()["disabled"]
    _as(c, vi_token)
    assert c.get("/api/agents").status_code == 401
    _as(c, boss)
    me = c.get("/api/auth/me").json()
    assert c.delete(f"/api/users/{me['id']}").status_code == 400
    reset = c.post(f"/api/users/{ed['id']}/password", json={"password": "resetpass1"}).json()
    assert reset["must_change_password"]
    _as(c, ed_token)
    assert c.get("/api/agents").status_code == 401  # signed out by the reset
    _as(c, boss)
    assert c.delete(f"/api/users/{ed['id']}").json() == {"ok": True}
    assert db.get_chat(ed_chat["id"])["user_id"] is None  # chats stay, without an owner

    # Wrong passwords are throttled.
    c.cookies.clear()
    for _ in range(auth.MAX_FAILURES):
        assert c.post("/api/auth/login", json={"username": "boss", "password": "nope"}).status_code == 401
    assert c.post("/api/auth/login", json={"username": "boss", "password": "longenough"}).status_code == 429
    _as(c, boss)
    assert c.post("/api/auth/logout").json() == {"ok": True}
    assert c.get("/api/agents").status_code == 401


def test_versions_conflicts_and_history(team, monkeypatch):
    c = team
    monkeypatch.setattr(auth, "is_loopback", lambda request: True)
    c.post("/api/auth/setup", json={"username": "ann", "password": "annpassword"})
    ann = c.cookies.get(auth.COOKIE)
    c.post("/api/users", json={"username": "bob", "password": "bobpassword", "role": "editor",
                               "must_change_password": False})
    bob = _login(c, "bob", "bobpassword")

    # Ann and Bob open the same agent; Bob saves first.
    _as(c, ann)
    mine = c.get("/api/agents/team-agent").json()
    _as(c, bob)
    theirs = c.get("/api/agents/team-agent").json()
    assert mine["version"] == theirs["version"]
    saved = c.put("/api/agents/team-agent", json={**theirs, "description": "Bob's"},
                  headers={"If-Match": theirs["version"]})
    assert saved.status_code == 200 and saved.json()["updated_by"] == "bob"
    assert saved.json()["version"] != theirs["version"]

    _as(c, ann)
    res = c.put("/api/agents/team-agent", json={**mine, "prompt": "Ann's"}, headers={"If-Match": mine["version"]})
    assert res.status_code == 409
    conflict = res.json()["conflict"]
    assert conflict["updated_by"] == "bob" and conflict["current"]["description"] == "Bob's"
    assert conflict["version"] == saved.json()["version"] and not conflict["deleted"]
    assert "changed by bob" in res.json()["detail"]
    # Merged onto Bob's version, it goes through.
    merged = c.put("/api/agents/team-agent", json={**conflict["current"], "prompt": "Ann's"},
                   headers={"If-Match": conflict["version"]}).json()
    assert merged["description"] == "Bob's" and merged["prompt"] == "Ann's" and merged["updated_by"] == "ann"
    # A stale delete is refused too; without If-Match, last write wins (scripts).
    assert c.delete("/api/agents/team-agent", headers={"If-Match": mine["version"]}).status_code == 409

    history = c.get("/api/revisions/agents/team-agent").json()
    assert [(h["action"], h["actor"]) for h in history][:3] == [("save", "ann"), ("save", "bob"), ("save", None)]
    old = c.get(f"/api/revisions/agents/team-agent/{history[2]['id']}").json()
    # Revisions come back as full definitions (defaults filled in), like a GET.
    assert old["data"]["prompt"] == "Help." and old["data"]["description"] == "" and old["data"]["max_llm_calls"] == 20
    listed = next(a for a in c.get("/api/agents").json() if a["id"] == "team-agent")
    assert listed["version"] == merged["version"]
    assert next(x for x in c.get("/api/systems").json() if x["id"] == "team-sys")["version"]
    assert c.get("/api/revisions/nope/x").status_code == 404
    assert any(r["item_id"] == "team-agent" for r in c.get("/api/revisions").json())

    # The same for the other kinds of definitions. A file written by hand is
    # kept as a baseline revision before the first change through the app.
    workspace.fragments.path("team-frag").parent.mkdir(parents=True, exist_ok=True)
    workspace.fragments.path("team-frag").write_text("zero", encoding="utf-8")
    frag = c.put("/api/fragments/team-frag", json={"text": "one"}).json()
    assert [h["action"] for h in c.get("/api/revisions/fragments/team-frag").json()] == ["save", "baseline"]
    assert c.put("/api/fragments/team-frag", json={"text": "two"}, headers={"If-Match": frag["version"]}).status_code == 200
    res = c.put("/api/fragments/team-frag", json={"text": "three"}, headers={"If-Match": frag["version"]})
    assert res.status_code == 409 and res.json()["conflict"]["current"]["text"] == "two"
    # Windows line endings in a body are stored as one newline, not doubled.
    c.put("/api/fragments/team-frag", json={"text": "a\r\n\r\nb"})
    assert workspace.fragments.get("team-frag") == "a\n\nb"
    settings = c.put("/api/settings", json=c.get("/api/settings").json()).json()  # no file yet: no version
    assert settings["version"]
    # (Versions hash the content: saving identical settings again is no conflict.)
    assert c.put("/api/settings", json={**settings, "llm_retries": 3},
                 headers={"If-Match": settings["version"]}).status_code == 200
    assert c.put("/api/settings", json={**settings, "llm_retries": 2},
                 headers={"If-Match": settings["version"]}).status_code == 409
    sc = c.post("/api/scenarios", json={"id": "team-scenario", "opening": "hi"}).json()
    assert c.put("/api/scenarios/team-scenario", json={**sc, "opening": "a"}, headers={"If-Match": sc["version"]}).status_code == 200
    assert c.put("/api/scenarios/team-scenario", json={**sc, "opening": "b"},
                 headers={"If-Match": sc["version"]}).status_code == 409
    # Deleted meanwhile: the conflict says so.
    sc2 = c.get("/api/scenarios/team-scenario").json()
    c.delete("/api/scenarios/team-scenario")
    res = c.put("/api/scenarios/team-scenario", json=sc2, headers={"If-Match": sc2["version"]})
    assert res.status_code == 409 and res.json()["conflict"]["deleted"]

    # Presence: Bob sees Ann in the editor, with unsaved changes.
    assert c.post("/api/presence", json={"resource": "agents/team-agent", "editing": True}).json() == {"others": []}
    _as(c, bob)
    others = c.post("/api/presence", json={"resource": "agents/team-agent"}).json()["others"]
    assert [(o["username"], o["editing"]) for o in others] == [("ann", True)]
    _as(c, ann)
    c.post("/api/presence", json={"resource": "agents/team-agent", "leaving": True})
    _as(c, bob)
    assert c.post("/api/presence", json={"resource": "agents/team-agent"}).json()["others"] == []


def _seed_bundle_workspace():
    from sbf.data import DatasetStore
    workspace.fragments.save("tone", "Be brief.")
    workspace.datasets.save(DatasetDef(id="kb", name="Knowledge"))
    store = DatasetStore("kb")
    store.insert_item({"title": "Box breathing", "source_type": "text", "text": "In 4, hold 4, out 4."})
    workspace.retrievers.save(RetrieverDef(id="kb-search", sources=[RetrieverSource(dataset="kb")]))
    workspace.agents.save(AgentDef(id="kb-agent", prompt="{{ fragments.tone }} Help.",
                                   model=ModelSpec(preset="helper"),
                                   tools=[{"tool": "rag_search", "config": {"retriever": "kb-search"}}]))
    workspace.systems.save(SystemDef(id="kb-sys", entry="bot", nodes=[NodeDef(
        id="bot", agent="kb-agent", context=[ContextDef(name="kb", retriever="kb-search")])]))
    workspace.personas.save(PersonaDef(id="kb-persona", profile="A user."))
    workspace.scenarios.save(ScenarioDef(id="kb-scenario", persona="kb-persona", opening="hi"))


def test_bundles(team, monkeypatch):
    c = team
    monkeypatch.setattr(auth, "is_loopback", lambda request: True)
    c.post("/api/auth/setup", json={"username": "admin1", "password": "adminpassword"})
    from sbf.schemas import ModelSpec as MS
    from sbf.settings import get_settings, save_settings
    settings = get_settings()
    save_settings(settings.model_copy(update={"models": {**settings.models,
                                                         "helper": MS(preset="default", reasoning_effort="low")}}))
    _seed_bundle_workspace()

    plan = c.post("/api/bundles/plan", json={"items": [{"kind": "systems", "id": "kb-sys"},
                                                       {"kind": "scenarios", "id": "kb-scenario"}]}).json()
    keys = [f"{i['kind']}/{i['id']}" for i in plan["items"]]
    assert keys == ["fragments/tone", "datasets/kb", "retrievers/kb-search", "agents/kb-agent", "systems/kb-sys",
                    "personas/kb-persona", "scenarios/kb-scenario"]
    agent = next(i for i in plan["items"] if i["id"] == "kb-agent")
    assert agent["reason"] == "dependency" and agent["required_by"] == ["systems/kb-sys"]
    assert plan["presets"] == ["helper"] and not plan["missing"]
    alone = c.post("/api/bundles/plan", json={"items": [{"kind": "systems", "id": "kb-sys"}],
                                              "dependencies": False}).json()
    assert [i["id"] for i in alone["items"]] == ["kb-sys"]

    res = c.post("/api/bundles/export", json={"items": [{"kind": "systems", "id": "kb-sys"}], "dataset_data": True})
    assert res.status_code == 200 and res.headers["content-type"] == "application/zip"
    blob = res.content
    names = zipfile.ZipFile(io.BytesIO(blob)).namelist()
    assert {"manifest.json", "workspace/agents/kb-agent.yaml", "workspace/fragments/tone.md",
            "data/datasets/kb/dataset.db"} <= set(names)

    # Same workspace: everything is already here.
    preview = c.post("/api/bundles/import", files={"file": ("b.zip", blob, "application/zip")}).json()
    assert {i["status"] for i in preview["items"]} == {"same"}
    assert preview["manifest"]["exported_by"] == "admin1" and preview["presets"][0]["status"] == "same"
    c.delete(f"/api/bundles/import/{preview['token']}")

    # Changed here since: "changed"; import copies of the agent and system
    # (the copied system runs the copied agent) and replace the fragment.
    workspace.fragments.save("tone", "Be very brief.")
    preview = c.post("/api/bundles/import", files={"file": ("b.zip", blob, "application/zip")}).json()
    status = {i["key"]: i["status"] for i in preview["items"]}
    assert status["fragments/tone"] == "changed" and status["agents/kb-agent"] == "same"
    compare = c.get(f"/api/bundles/import/{preview['token']}/items/fragments/tone").json()
    assert compare["bundle"]["text"] == "Be brief." and compare["local"]["text"] == "Be very brief."
    result = c.post(f"/api/bundles/import/{preview['token']}/apply", json={"actions": {
        "fragments/tone": "replace", "agents/kb-agent": "copy:kb-agent-2", "systems/kb-sys": "copy:kb-sys-2",
        "datasets/kb": "copy:kb2"}}).json()
    assert all(r["ok"] for r in result["items"]), result
    assert workspace.fragments.get("tone") == "Be brief."
    assert workspace.systems.get("kb-sys-2").nodes[0].agent == "kb-agent-2"
    # The retriever wasn't copied, so the copies still search the original dataset.
    assert workspace.agents.get("kb-agent-2").tools[0].config["retriever"] == "kb-search"
    from sbf.data import DatasetStore
    assert next(r for r in result["items"] if r["id"] == "kb")["items"] == 1
    assert DatasetStore("kb2").count_items() == 1
    from sbf import revisions
    assert revisions.last_change("systems", "kb-sys-2")["action"] == "import"
    assert c.get(f"/api/bundles/import/{preview['token']}").status_code == 404  # used up

    # Into an empty workspace: everything is new, presets are added.
    for kind, item_id in [("systems", "kb-sys"), ("systems", "kb-sys-2"), ("agents", "kb-agent"),
                          ("agents", "kb-agent-2"), ("retrievers", "kb-search"), ("datasets", "kb")]:
        workspace.collections[kind].delete(item_id)
    DatasetStore("kb").destroy()
    settings = get_settings()
    save_settings(settings.model_copy(update={"models": {k: v for k, v in settings.models.items() if k != "helper"}}))
    preview = c.post("/api/bundles/import", files={"file": ("b.zip", blob, "application/zip")}).json()
    assert {i["key"]: i["default_action"] for i in preview["items"]}["agents/kb-agent"] == "create"
    assert preview["presets"] == [{"name": "helper", "status": "new", "spec": {"preset": "default",
                                   "reasoning_effort": "low"}, "default_action": "add"}]
    result = c.post(f"/api/bundles/import/{preview['token']}/apply", json={}).json()
    assert all(r["ok"] for r in result["items"]) and result["presets"][0]["action"] == "add"
    assert "helper" in get_settings().models and DatasetStore("kb").count_items() == 1
    assert workspace.systems.get("kb-sys").nodes[0].context[0].retriever == "kb-search"

    # Not a bundle; a zip with unsafe paths.
    bad = c.post("/api/bundles/import", files={"file": ("x.zip", b"not a zip", "application/zip")})
    assert bad.status_code == 400
    evil = io.BytesIO()
    with zipfile.ZipFile(evil, "w") as zf:
        zf.writestr("manifest.json", "{}")
        zf.writestr("../escape.txt", "x")
    assert "unsafe" in c.post("/api/bundles/import", files={"file": ("e.zip", evil.getvalue())}).json()["detail"]
    with pytest.raises(bundle.BundleError):
        bundle.plan([{"kind": "nope", "id": "x"}])
