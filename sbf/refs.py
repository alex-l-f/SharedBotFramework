"""
References between definitions: which agents a system runs, which
retrievers and datasets it searches, which shared fragments its prompts
use, which model presets, …

``walk(kind, data, refs)`` visits every reference in a definition (as a
plain dict). ``Refs`` collects them, and with ``rename`` rewrites them in
the copy it returns, so a bundle can import a definition under a new id
together with everything that points at it.

Dataset ids also appear as values (a library tool's ``library`` setting, a
mode's ``state.library``); those count only when they name a dataset in
``datasets``.
"""

from __future__ import annotations

import copy
import re
from typing import Any

FRAGMENT_REF = re.compile(r"""fragments\.([A-Za-z_][A-Za-z0-9_]*)|fragments\[\s*['"]([^'"]+)['"]\s*\]""")
IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

# Order to create definitions in: what is referenced before what refers to it.
KIND_ORDER = ("memory_schemas", "fragments", "datasets", "retrievers", "classifiers", "agents", "systems",
              "personas", "scenarios", "rubrics")


class Refs:
    def __init__(self, datasets: set[str] | None = None, rename: dict[tuple[str, str], str] | None = None):
        self.datasets = datasets or set()
        self.rename = rename or {}
        self.found: list[tuple[str, str]] = []

    def ref(self, kind: str, value: Any) -> Any:
        if not isinstance(value, str) or not value:
            return value
        self.found.append((kind, value))
        return self.rename.get((kind, value), value)

    def maybe_dataset(self, value: Any) -> Any:
        if isinstance(value, str) and (value in self.datasets or ("datasets", value) in self.rename):
            return self.ref("datasets", value)
        return value

    def text(self, value: Any, local: set[str] | frozenset = frozenset()) -> Any:
        """Shared fragments a Jinja template uses (not the system's own)."""
        if not isinstance(value, str) or "fragments" not in value:
            return value

        def sub(m: re.Match) -> str:
            name = m.group(1) or m.group(2)
            if name in local:
                return m.group(0)
            new = self.ref("fragments", name)
            if new == name:
                return m.group(0)
            return f"fragments.{new}" if IDENTIFIER.fullmatch(new) else f"fragments[{new!r}]"

        return FRAGMENT_REF.sub(sub, value)


def _presets(obj: Any, refs: Refs) -> None:
    """Model presets named anywhere (ModelSpec.preset)."""
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key == "preset" and isinstance(value, str) and value:
                refs.found.append(("presets", value))
            else:
                _presets(value, refs)
    elif isinstance(obj, list):
        for value in obj:
            _presets(value, refs)


def _config(cfg: Any, refs: Refs) -> None:
    """A tool's configuration: a retriever, or a dataset as its library."""
    if not isinstance(cfg, dict):
        return
    if "retriever" in cfg:
        cfg["retriever"] = refs.ref("retrievers", cfg["retriever"])
    for key in ("library", "dataset"):
        if key in cfg:
            cfg[key] = refs.maybe_dataset(cfg[key])


def _state(state: Any, refs: Refs) -> None:
    """Session state values naming a dataset (e.g. ``library``)."""
    if not isinstance(state, dict):
        return
    for key, value in state.items():
        if "library" in key or "dataset" in key:
            state[key] = refs.maybe_dataset(value)


def walk(kind: str, data: dict, refs: Refs) -> dict:
    """Visit the references of one definition; returns a copy with any
    renames applied."""
    d = copy.deepcopy(data)
    if kind == "agents":
        d["prompt"] = refs.text(d.get("prompt", ""))
        for b in d.get("tools") or []:
            _config(b.get("config"), refs)
    elif kind == "systems":
        local = set((d.get("fragments") or {}).keys())
        for n in d.get("nodes") or []:
            n["agent"] = refs.ref("agents", n.get("agent"))
            n["prompt_template"] = refs.text(n.get("prompt_template", ""), local)
            for b in n.get("tools") or []:
                _config(b.get("config"), refs)
            for cfg in (n.get("tool_config") or {}).values():
                _config(cfg, refs)
            for m in n.get("modes") or []:
                m["prompt"] = refs.text(m.get("prompt", ""), local)
                _state(m.get("state"), refs)
            for c in n.get("context") or []:
                c["retriever"] = refs.ref("retrievers", c.get("retriever"))
                c["question"] = refs.text(c.get("question", ""), local)
        for link in d.get("links") or []:
            link["request_template"] = refs.text(link.get("request_template", ""), local)
        if d.get("fragments"):
            d["fragments"] = {k: refs.text(v, local) for k, v in d["fragments"].items()}
        _state(d.get("state"), refs)
        for guard in d.get("guards") or []:
            guard["classifier"] = refs.ref("classifiers", guard.get("classifier"))
        memory = d.get("memory") or {}
        if memory.get("schema_id"):
            memory["schema_id"] = refs.ref("memory_schemas", memory["schema_id"])
    elif kind == "retrievers":
        for source in d.get("sources") or []:
            source["dataset"] = refs.ref("datasets", source.get("dataset"))
    elif kind == "scenarios":
        if d.get("persona"):
            d["persona"] = refs.ref("personas", d["persona"])
    elif kind == "fragments":
        d["text"] = refs.text(d.get("text", ""))
    _presets(d, refs)
    return d


def references(kind: str, data: dict, datasets: set[str] | None = None) -> list[tuple[str, str]]:
    """(kind, id) pairs a definition refers to, without duplicates."""
    refs = Refs(datasets)
    walk(kind, data, refs)
    return list(dict.fromkeys(refs.found))
