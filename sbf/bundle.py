"""
Bundles: definitions (and optionally dataset contents) packed into one zip
file, to move them between workspaces or share them.

    manifest.json                     what is inside, who exported it, when
    workspace/<kind>/<id>.yaml        definitions, as in the workspace
    workspace/fragments/<id>.md       shared prompt fragments
    data/datasets/<id>/dataset.db     a dataset's items and chunks (optional)
    data/datasets/<id>/files/<name>   its uploaded files (optional)

The manifest also carries the model presets the definitions name, so an
import can add the ones the target workspace lacks.

Export can add everything the selected definitions depend on (a system's
agents, retrievers, datasets, memory schema, fragments; a scenario's
persona; …). Import previews each definition as new / same / changed /
invalid, then creates, replaces, skips or copies it under a new id
(references to it from the bundle's other definitions follow the new id).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

import yaml

from . import __version__
from .data import DatasetStore, processor
from .refs import KIND_ORDER, Refs, references, walk
from .settings import DATA_DIR, get_settings, save_settings, settings_version
from .workspace import ACTOR, NotFound, now_iso, text_version, workspace

FORMAT = "sbf-bundle"
FORMAT_VERSION = 1
MAX_UNCOMPRESSED = 8 * 1024 ** 3
STAMPS = ("updated_at", "updated_by")
IMPORTS_DIR = DATA_DIR / "imports"
_SAFE_FILE = re.compile(r"[^\\/:*?\"<>|\x00-\x1f]+")


class BundleError(ValueError):
    pass


# ------------------------------------------------------------------ helpers

def _kinds() -> tuple[str, ...]:
    return tuple(k for k in KIND_ORDER if k == "fragments" or k in workspace.collections)


def exists(kind: str, item_id: str) -> bool:
    if kind == "fragments":
        try:
            return workspace.fragments.path(item_id).exists()
        except ValueError:
            return False
    return workspace.collections[kind].exists(item_id)


def load(kind: str, item_id: str) -> dict:
    """A definition as plain data."""
    if kind == "fragments":
        return {"id": item_id, "text": workspace.fragments.get(item_id)}
    return workspace.collections[kind].get(item_id).model_dump()


def _file(kind: str, item_id: str) -> Path:
    if kind == "fragments":
        return workspace.fragments.path(item_id)
    return workspace.collections[kind]._path(item_id)


def _member(kind: str, item_id: str) -> str:
    return f"workspace/{kind}/{item_id}.{'md' if kind == 'fragments' else 'yaml'}"


def _comparable(data: dict | None) -> dict | None:
    return None if data is None else {k: v for k, v in data.items() if k not in STAMPS}


def _key(kind: str, item_id: str) -> str:
    return f"{kind}/{item_id}"


# ------------------------------------------------------------------- export

def plan(selected: list[dict], include_dependencies: bool = True) -> dict:
    """What an export of ``selected`` ({kind, id}) contains: the items (with
    why each is there), the model presets they name, and references to
    definitions that don't exist."""
    datasets = set(workspace.datasets.ids())
    items: dict[str, dict] = {}
    presets: set[str] = set()
    missing: dict[str, dict] = {}
    queue = [(s["kind"], s["id"], None) for s in selected]
    while queue:
        kind, item_id, parent = queue.pop(0)
        key = _key(kind, item_id)
        if kind not in _kinds():
            raise BundleError(f"Unknown kind {kind!r}")
        if not exists(kind, item_id):
            entry = missing.setdefault(key, {"kind": kind, "id": item_id, "required_by": []})
            if parent:
                entry["required_by"].append(parent)
            continue
        if key in items:
            if parent and parent not in items[key]["required_by"]:
                items[key]["required_by"].append(parent)
            continue
        data = load(kind, item_id)
        items[key] = {"kind": kind, "id": item_id, "name": data.get("name") or "",
                      "reason": "dependency" if parent else "selected", "required_by": [parent] if parent else [],
                      "updated_at": data.get("updated_at"), "updated_by": data.get("updated_by")}
        for ref_kind, ref_id in references(kind, data, datasets):
            if ref_kind == "presets":
                presets.add(ref_id)
            elif include_dependencies:
                queue.append((ref_kind, ref_id, key))
    known = get_settings().models
    ordered = sorted(items.values(), key=lambda i: (KIND_ORDER.index(i["kind"]), i["id"]))
    return {"items": ordered, "presets": sorted(p for p in presets if p in known),
            "unknown_presets": sorted(p for p in presets if p not in known),
            "missing": list(missing.values())}


def export(selected: list[dict], include_dependencies: bool = True, dataset_data: bool = False) -> Path:
    """Write a bundle to a temporary zip file and return its path."""
    contents = plan(selected, include_dependencies)
    if not contents["items"]:
        raise BundleError("Nothing to export")
    settings = get_settings()
    warnings = [f"{m['kind']}/{m['id']} is referenced but doesn't exist" for m in contents["missing"]]
    warnings += [f"model preset {p!r} is referenced but not defined" for p in contents["unknown_presets"]]
    fd, name = tempfile.mkstemp(prefix="sbf-bundle-", suffix=".zip")
    os.close(fd)
    tmp = Path(name)
    manifest_items = []
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in contents["items"]:
            kind, item_id = item["kind"], item["id"]
            blob = _file(kind, item_id).read_bytes()
            zf.writestr(_member(kind, item_id), blob)
            entry = {**{k: item[k] for k in ("kind", "id", "name", "reason", "updated_at", "updated_by")},
                     "version": text_version(blob), "data": False}
            if kind == "datasets" and dataset_data:
                entry["data"], entry["data_warnings"] = _export_dataset(zf, item_id)
                warnings += [f"dataset {item_id}: {w}" for w in entry["data_warnings"]]
            manifest_items.append(entry)
        manifest = {"format": FORMAT, "format_version": FORMAT_VERSION, "sbf_version": __version__,
                    "exported_at": now_iso(), "exported_by": ACTOR.get(), "items": manifest_items,
                    "presets": {p: settings.models[p].model_dump(exclude_none=True) for p in contents["presets"]},
                    "warnings": warnings}
        zf.writestr("manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))
    return tmp


def _export_dataset(zf: zipfile.ZipFile, dataset_id: str) -> tuple[bool, list[str]]:
    store = DatasetStore(dataset_id)
    if not store.exists:
        return False, []
    warnings = []
    with tempfile.TemporaryDirectory() as tmpdir:
        copy = Path(tmpdir) / "dataset.db"
        src, dst = sqlite3.connect(store.db_path), sqlite3.connect(copy)
        try:
            src.backup(dst)  # a consistent snapshot, WAL included
        finally:
            src.close()
            dst.close()
        zf.write(copy, f"data/datasets/{dataset_id}/dataset.db")
    linked = 0
    for f in store.list_files():
        path = store.file_path(f)
        if f.get("linked"):
            linked += 1
        elif path.is_file():
            zf.write(path, f"data/datasets/{dataset_id}/files/{path.name}")
    if linked:
        warnings.append(f"{linked} linked file(s) point outside the dataset and are not included; "
                        "their extracted text is")
    return True, warnings


# ------------------------------------------------------------------- import

def _safe_member(name: str) -> bool:
    path = PurePosixPath(name)
    return not path.is_absolute() and ".." not in path.parts and "\\" not in name


class Bundle:
    """An uploaded bundle (zip), checked and parsed."""

    def __init__(self, path: Path):
        self.path = path
        try:
            self.zf = zipfile.ZipFile(path)
        except zipfile.BadZipFile:
            raise BundleError("Not a zip file") from None
        try:
            self._read()
        except BaseException:
            self.zf.close()  # so the upload can be deleted (Windows)
            raise

    def _read(self) -> None:
        names = self.zf.namelist()
        if any(not _safe_member(n) for n in names):
            raise BundleError("The bundle contains unsafe file names")
        if sum(i.file_size for i in self.zf.infolist()) > MAX_UNCOMPRESSED:
            raise BundleError("The bundle is too large")
        if "manifest.json" not in names:
            raise BundleError("Not a bundle (no manifest.json)")
        try:
            self.manifest = json.loads(self.zf.read("manifest.json"))
        except (ValueError, UnicodeDecodeError):
            raise BundleError("manifest.json is not valid JSON") from None
        if self.manifest.get("format") != FORMAT:
            raise BundleError("Not an SBF bundle")
        if int(self.manifest.get("format_version", 0)) > FORMAT_VERSION:
            raise BundleError("The bundle comes from a newer SBF version")
        self.names = set(names)
        self.items: dict[str, dict] = {}
        for entry in self.manifest.get("items") or []:
            kind, item_id = entry.get("kind"), entry.get("id")
            if kind not in _kinds() or not isinstance(item_id, str):
                continue
            self.items[_key(kind, item_id)] = {**entry, "data": entry.get("data", False), **self._parse(kind, item_id)}

    def close(self) -> None:
        self.zf.close()

    def _parse(self, kind: str, item_id: str) -> dict:
        member = _member(kind, item_id)
        if member not in self.names:
            return {"error": "missing from the bundle", "definition": None}
        try:
            text = self.zf.read(member).decode("utf-8")
            if kind == "fragments":
                workspace.fragments.path(item_id)  # validates the id
                return {"error": None, "definition": {"id": item_id, "text": text}}
            raw = yaml.safe_load(text) or {}
            raw.setdefault("id", item_id)
            model = workspace.collections[kind].model.model_validate(raw)
            return {"error": None, "definition": model.model_dump()}
        except Exception as exc:  # report it; the other definitions can still be imported
            return {"error": str(exc).splitlines()[0][:300], "definition": None}

    def has_data(self, dataset_id: str) -> bool:
        return f"data/datasets/{dataset_id}/dataset.db" in self.names


def preview(bundle: Bundle) -> dict:
    """Each definition's status against this workspace, and the presets."""
    local_datasets = set(workspace.datasets.ids())
    bundle_datasets = {i["id"] for i in bundle.items.values() if i["kind"] == "datasets"}
    items = []
    for key, item in bundle.items.items():
        kind, item_id = item["kind"], item["id"]
        local = load(kind, item_id) if exists(kind, item_id) else None
        if item["error"]:
            status = "invalid"
        elif local is None:
            status = "new"
        else:
            status = "same" if _comparable(local) == _comparable(item["definition"]) else "changed"
        refs = references(kind, item["definition"], local_datasets | bundle_datasets) if item["definition"] else []
        unresolved = [f"{k}/{i}" for k, i in refs
                      if k != "presets" and _key(k, i) not in bundle.items and not exists(k, i)]
        entry = {"key": key, "kind": kind, "id": item_id, "name": (item["definition"] or {}).get("name") or "",
                 "status": status, "error": item["error"],
                 "bundle": {"updated_at": item.get("updated_at"), "updated_by": item.get("updated_by")},
                 "local": {"updated_at": local.get("updated_at"), "updated_by": local.get("updated_by")}
                 if local else None,
                 "unresolved": unresolved, "default_action": {"new": "create", "same": "skip",
                                                              "changed": "skip"}.get(status, "skip")}
        if kind == "datasets":
            entry["has_data"] = bundle.has_data(item_id)
            store = DatasetStore(item_id)
            entry["local_items"] = store.count_items() if local is not None and store.exists else 0
        items.append(entry)
    items.sort(key=lambda i: (KIND_ORDER.index(i["kind"]), i["id"]))
    known = get_settings().models
    presets = []
    for name, spec in (bundle.manifest.get("presets") or {}).items():
        if name not in known:
            status = "new"
        else:
            status = "same" if known[name].model_dump(exclude_none=True) == spec else "changed"
        presets.append({"name": name, "status": status, "spec": spec,
                        "default_action": "add" if status == "new" else "skip"})
    m = bundle.manifest
    return {"manifest": {k: m.get(k) for k in ("sbf_version", "exported_at", "exported_by", "warnings")},
            "items": items, "presets": presets}


def apply(bundle: Bundle, actions: dict[str, str], preset_actions: dict[str, str] | None = None,
          import_data: bool = True) -> dict:
    """Import: ``actions`` maps "kind/id" to create | replace | skip |
    copy:<new id> (default: create the new ones, skip the rest);
    ``preset_actions`` maps a preset name to add | replace | skip."""
    status = {i["key"]: i for i in preview(bundle)["items"]}
    renames: dict[tuple[str, str], str] = {}
    chosen: dict[str, str] = {}
    for key, entry in status.items():
        action = (actions or {}).get(key) or entry["default_action"]
        if action.startswith("copy:"):
            new_id = action.split(":", 1)[1].strip()
            if not new_id:
                raise BundleError(f"{key}: give the copy an id")
            renames[(entry["kind"], entry["id"])] = new_id
        elif action not in ("create", "replace", "skip"):
            raise BundleError(f"{key}: unknown action {action!r}")
        chosen[key] = action
    datasets = set(workspace.datasets.ids()) | {i["id"] for i in bundle.items.values() if i["kind"] == "datasets"}
    results = []
    for key in sorted(status, key=lambda k: (KIND_ORDER.index(status[k]["kind"]), status[k]["id"])):
        entry, action = status[key], chosen[key]
        kind, item_id = entry["kind"], entry["id"]
        target = renames.get((kind, item_id), item_id)
        result = {"key": key, "kind": kind, "id": item_id, "target": target, "action": action, "ok": True}
        results.append(result)
        if action == "skip":
            continue
        try:
            if entry["status"] == "invalid":
                raise BundleError(f"invalid: {entry['error']}")
            if action == "create" and exists(kind, target):
                raise BundleError("already exists here (choose replace or copy)")
            if action.startswith("copy:") and exists(kind, target):
                raise BundleError(f"{target!r} already exists here")
            data = walk(kind, bundle.items[key]["definition"], Refs(datasets, renames))
            data["id"] = target
            if kind == "fragments":
                workspace.fragments.save(target, data["text"], action="import")
            else:
                collection = workspace.collections[kind]
                collection.save(collection.model.model_validate(data), action="import")
            if kind == "datasets" and import_data and bundle.has_data(item_id):
                result["items"] = _import_dataset(bundle, item_id, target)
        except Exception as exc:  # one failure doesn't stop the others
            result.update(ok=False, error=str(exc).splitlines()[0][:300])
    preset_results = _import_presets(bundle, preset_actions or {})
    return {"items": results, "presets": preset_results}


def _import_dataset(bundle: Bundle, dataset_id: str, target: str) -> int:
    """Replace the target dataset's contents with the bundle's; returns its item count."""
    if processor.busy(target):
        raise BundleError("its files are being processed; import the data when that is done")
    store = DatasetStore(target)
    old_version = store.version()
    store.destroy()
    store.files_dir.mkdir(parents=True, exist_ok=True)
    prefix = f"data/datasets/{dataset_id}/"
    for name in bundle.names:
        if not name.startswith(prefix) or name.endswith("/"):
            continue
        rest = name[len(prefix):]
        if rest == "dataset.db":
            dest = store.db_path
        elif rest.startswith("files/") and _SAFE_FILE.fullmatch(rest[len("files/"):]):
            dest = store.files_dir / rest[len("files/"):]
        else:
            continue
        with bundle.zf.open(name) as src, dest.open("wb") as out:
            shutil.copyfileobj(src, out, 1 << 20)
    # Indexes key on the dataset version: move past both so nothing stale is reused.
    with store.connect() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key = 'version'").fetchone()
        conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('version', ?)",
                     (str(max(old_version, int(row["value"]) if row else 0) + 1),))
    return store.count_items()


def _import_presets(bundle: Bundle, preset_actions: dict[str, str]) -> list[dict]:
    presets = bundle.manifest.get("presets") or {}
    if not presets:
        return []
    from .schemas import ModelSpec
    settings = get_settings()
    models = dict(settings.models)
    results = []
    for name, spec in presets.items():
        exists_here = name in models
        action = preset_actions.get(name) or ("skip" if exists_here else "add")
        if action == "skip" or (action == "add" and exists_here):
            results.append({"name": name, "action": "skip" if action == "skip" else "kept", "ok": True})
            continue
        try:
            models[name] = ModelSpec.model_validate(spec)
            results.append({"name": name, "action": action, "ok": True})
        except Exception as exc:
            results.append({"name": name, "action": action, "ok": False, "error": str(exc).splitlines()[0]})
    if any(r["ok"] and r["action"] in ("add", "replace") for r in results):
        save_settings(settings.model_copy(update={"models": models}), settings_version())
    return results


# ----------------------------------------------------------------- uploads

def stored_path(token: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{32}", token or ""):
        raise NotFound(token)
    path = IMPORTS_DIR / f"{token}.zip"
    if not path.is_file():
        raise NotFound(token)
    return path


def open_stored(token: str) -> Bundle:
    return Bundle(stored_path(token))
