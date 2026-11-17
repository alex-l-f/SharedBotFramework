"""
The workspace: definitions as human-readable files.

    workspace/
      settings.yaml
      agents/<id>.yaml           AgentDef
      systems/<id>.yaml          SystemDef
      memory_schemas/<id>.yaml   MemorySchema
      datasets/<id>.yaml         DatasetDef (files and items live in <data>/datasets/<id>/)
      retrievers/<id>.yaml       RetrieverDef
      personas/<id>.yaml         PersonaDef (simulated users)
      scenarios/<id>.yaml        ScenarioDef
      rubrics/<id>.yaml          RubricDef (simulation judges)
      classifiers/<id>.yaml      ClassifierDef (safety classifiers)
      guardrails/<id>/           NeMo Guardrails configs, written from classifiers
      fragments/<id>.md          shared prompt fragments (plain text)
      plugins/*.py               extra tool modules (optional)

Multi-line strings are written as YAML block scalars, so prompts stay
readable and diff cleanly under version control. Files are re-read when
they change on disk, so hand edits show up without a restart.

Concurrent edits: a definition's ``version`` is a hash of its file. A save
or delete given the version it was based on (``expected_version``) fails
with ``Conflict`` when the file has changed since, so two people editing
the same definition can't silently overwrite each other. Every write
through here is recorded in the revision history (``sbf.revisions``),
attributed to ``ACTOR`` (the signed-in user of the request).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from contextvars import ContextVar
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Generic, TypeVar

import yaml
from pydantic import BaseModel

from .schemas import (AgentDef, ClassifierDef, DatasetDef, MemorySchema, PersonaDef, RetrieverDef, RubricDef,
                      ScenarioDef, SystemDef)
from .settings import WORKSPACE


class _BlockDumper(yaml.SafeDumper):
    pass


def _str_representer(dumper, value: str):
    if "\n" in value:
        # Block scalars can't carry trailing spaces on a line; strip them so
        # the dumper doesn't fall back to an escaped one-line string.
        value = "\n".join(line.rstrip() for line in value.split("\n"))
        return dumper.represent_scalar("tag:yaml.org,2002:str", value, style="|")
    return dumper.represent_scalar("tag:yaml.org,2002:str", value)


_BlockDumper.add_representer(str, _str_representer)


def dump_yaml(data) -> str:
    return yaml.dump(data, Dumper=_BlockDumper, sort_keys=False,
                     allow_unicode=True, width=100)


def now_iso() -> str:
    """Local time with its UTC offset, so browsers in any timezone read it right."""
    return datetime.now().astimezone().isoformat(timespec="seconds")


T = TypeVar("T", bound=BaseModel)

# Who is writing: the signed-in user's username (set per request by the auth
# guard); None for scripts and background work.
ACTOR: ContextVar[str | None] = ContextVar("sbf_actor", default=None)

# Version check + write is one step for every writer in the process.
_write_lock = threading.RLock()


class NotFound(KeyError):
    pass


class Conflict(Exception):
    """A write based on a version that is no longer current."""

    def __init__(self, kind: str, item_id: str, expected: str, current: str | None,
                 data: dict | None = None):
        from . import revisions
        self.kind, self.item_id, self.expected, self.current, self.data = kind, item_id, expected, current, data
        self.last = revisions.last_change(kind, item_id) or {}
        who = self.last.get("actor") or "someone"
        if current is None:
            message = f"{item_id!r} was deleted by {who} while you were editing it"
        else:
            message = f"{item_id!r} was changed by {who} while you were editing it"
        super().__init__(message)

    def to_dict(self) -> dict:
        return {"kind": self.kind, "id": self.item_id, "expected": self.expected, "version": self.current,
                "deleted": self.current is None, "updated_by": self.last.get("actor"),
                "updated_at": self.last.get("ts"), "current": self.data}


def expected_version(if_match: str | None) -> str | None:
    """The version an If-Match request header names (None: any)."""
    value = (if_match or "").strip().removeprefix("W/").strip('"')
    return None if value in ("", "*") else value


def text_version(text: str | bytes) -> str:
    blob = text.encode("utf-8") if isinstance(text, str) else text
    return hashlib.sha256(blob).hexdigest()[:12]


def file_version(path: Path) -> str | None:
    """Hash of a file's bytes; None if it doesn't exist."""
    try:
        return text_version(path.read_bytes())
    except FileNotFoundError:
        return None


def write_text_atomic(path: Path, text: str) -> None:
    """Readers see the old file or the new one, never half of it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}-{threading.get_ident()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    for _ in range(40):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:  # Windows: a reader still has the file open
            time.sleep(0.05)
    os.replace(tmp, path)


def versioned_write(kind: str, item_id: str, path: Path, text: str | None,
                    expected_version: str | None = None,
                    current: Callable[[], dict | None] | None = None, action: str = "save") -> str | None:
    """Write (``text``) or delete (None) a definition file, if it is still at
    ``expected_version`` (None: unconditionally); records a revision.
    Returns the new version. ``current`` loads the stored data for a Conflict."""
    from . import revisions
    with _write_lock:
        if expected_version is not None:
            found = file_version(path)
            if found != expected_version:
                data = None
                if found is not None and current is not None:
                    try:
                        data = current()
                    except Exception:  # an unreadable file: report the conflict without it
                        data = None
                raise Conflict(kind, item_id, expected_version, found, data)
        revisions.ensure_baseline(kind, item_id, path)
        if text is None:
            if not path.exists():
                raise NotFound(item_id)
            path.unlink()
            version = None
        else:
            write_text_atomic(path, text)
            version = file_version(path)
        revisions.record(kind, item_id, version, "delete" if text is None else action, text or "")
        return version


class Collection(Generic[T]):
    """One directory of YAML definitions of a single schema."""

    def __init__(self, directory: Path, model: type[T]):
        self.dir = directory
        self.kind = directory.name
        self.model = model
        self._cache: dict[str, tuple[float, T]] = {}

    def _path(self, item_id: str) -> Path:
        if not re.fullmatch(r"[a-z0-9][a-z0-9_\-]*", item_id or ""):
            raise NotFound(item_id)
        return self.dir / f"{item_id}.yaml"

    def ids(self) -> list[str]:
        if not self.dir.exists():
            return []
        return sorted(p.stem for p in self.dir.glob("*.yaml"))

    def get(self, item_id: str) -> T:
        path = self._path(item_id)
        if not path.exists():
            raise NotFound(item_id)
        mtime = path.stat().st_mtime
        cached = self._cache.get(item_id)
        if cached and cached[0] == mtime:
            return cached[1]
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        data.setdefault("id", item_id)
        item = self.model.model_validate(data)
        self._cache[item_id] = (mtime, item)
        return item

    def list(self) -> list[T]:
        items = []
        for item_id in self.ids():
            try:
                items.append(self.get(item_id))
            except Exception:  # a broken file shouldn't hide the others
                continue
        return items

    def errors(self) -> dict[str, str]:
        """Files that fail validation, with the reason."""
        out = {}
        for item_id in self.ids():
            try:
                self.get(item_id)
            except Exception as exc:
                out[item_id] = str(exc)
        return out

    def exists(self, item_id: str) -> bool:
        try:
            return self._path(item_id).exists()
        except NotFound:
            return False

    def version(self, item_id: str) -> str | None:
        return file_version(self._path(item_id))

    def dump(self, item: T) -> dict:
        """The definition as the API returns it: its fields and ``version``."""
        return {**item.model_dump(), "version": self.version(item.id)}

    def to_yaml(self, item: T) -> str:
        data = item.model_dump(exclude_defaults=True)
        return dump_yaml({"id": item.id, **{k: v for k, v in data.items() if k != "id"}})

    def _current(self, item_id: str) -> Callable[[], dict]:
        return lambda: self.get(item_id).model_dump()

    def save(self, item: T, expected_version: str | None = None, action: str = "save") -> T:
        """Write the definition (stamping updated_at/updated_by); with
        ``expected_version``, only if the file is still at that version."""
        stamp: dict[str, Any] = {}
        if "updated_at" in type(item).model_fields:
            stamp["updated_at"] = now_iso()
        if "updated_by" in type(item).model_fields:
            stamp["updated_by"] = ACTOR.get()
        item = item.model_copy(update=stamp)
        try:
            versioned_write(self.kind, item.id, self._path(item.id), self.to_yaml(item),
                            expected_version, self._current(item.id), action)
        finally:
            self._cache.pop(item.id, None)
        return item

    def delete(self, item_id: str, expected_version: str | None = None) -> None:
        path = self._path(item_id)
        if not path.exists() and expected_version is None:
            raise NotFound(item_id)
        try:
            versioned_write(self.kind, item_id, path, None, expected_version, self._current(item_id))
        finally:
            self._cache.pop(item_id, None)


class Fragments:
    """Shared prompt fragments: workspace/fragments/<id>.md."""

    def __init__(self, directory: Path):
        self.dir = directory

    kind = "fragments"

    def all(self) -> dict[str, str]:
        if not self.dir.exists():
            return {}
        return {p.stem: p.read_text(encoding="utf-8")
                for p in sorted(self.dir.glob("*.md"))}

    def path(self, frag_id: str) -> Path:
        if not re.fullmatch(r"[a-z0-9][a-z0-9_\-]*", frag_id or ""):
            raise ValueError(f"invalid fragment id {frag_id!r}")
        return self.dir / f"{frag_id}.md"

    def version(self, frag_id: str) -> str | None:
        return file_version(self.path(frag_id))

    def get(self, frag_id: str) -> str:
        path = self.path(frag_id)
        if not path.exists():
            raise NotFound(frag_id)
        return path.read_text(encoding="utf-8")

    def save(self, frag_id: str, text: str, expected_version: str | None = None,
             action: str = "save") -> str | None:
        text = text.replace("\r\n", "\n")  # written in text mode: CRLF would double up on Windows
        return versioned_write(self.kind, frag_id, self.path(frag_id), text, expected_version,
                               lambda: {"id": frag_id, "text": self.get(frag_id)}, action)

    def delete(self, frag_id: str, expected_version: str | None = None) -> None:
        path = self.path(frag_id)
        if not path.exists() and expected_version is None:
            raise NotFound(frag_id)
        versioned_write(self.kind, frag_id, path, None, expected_version,
                        lambda: {"id": frag_id, "text": self.get(frag_id)})


class Workspace:
    def __init__(self, root: Path = WORKSPACE):
        self.root = root
        self.agents: Collection[AgentDef] = Collection(root / "agents", AgentDef)
        self.systems: Collection[SystemDef] = Collection(root / "systems", SystemDef)
        self.memory_schemas: Collection[MemorySchema] = Collection(
            root / "memory_schemas", MemorySchema)
        self.datasets: Collection[DatasetDef] = Collection(root / "datasets", DatasetDef)
        self.retrievers: Collection[RetrieverDef] = Collection(root / "retrievers", RetrieverDef)
        self.personas: Collection[PersonaDef] = Collection(root / "personas", PersonaDef)
        self.scenarios: Collection[ScenarioDef] = Collection(root / "scenarios", ScenarioDef)
        self.rubrics: Collection[RubricDef] = Collection(root / "rubrics", RubricDef)
        self.classifiers: Collection[ClassifierDef] = Collection(root / "classifiers", ClassifierDef)
        self.fragments = Fragments(root / "fragments")
        self.plugins_dir = root / "plugins"

    @property
    def collections(self) -> dict[str, Collection]:
        """The YAML definition collections by kind (directory name)."""
        return {c.kind: c for c in (self.agents, self.systems, self.memory_schemas, self.datasets,
                                    self.retrievers, self.personas, self.scenarios, self.rubrics,
                                    self.classifiers)}


workspace = Workspace()


def content_hash(data) -> str:
    """Stable short hash of a JSON-able structure (definition snapshots)."""
    blob = json.dumps(data, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]
