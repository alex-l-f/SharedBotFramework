"""
Tool registry with auto-discovery.

Every module in ``sbf/tools/builtin/`` and every ``*.py`` in
``workspace/plugins/`` is imported at startup; ``@register`` on a ``Tool``
subclass adds it to the catalog the UI offers and bindings resolve against.
"""

from __future__ import annotations

import importlib
import importlib.util
import logging
import pkgutil

from .base import NoConfig, Tool, ToolContext

log = logging.getLogger(__name__)

_REGISTRY: dict[str, type[Tool]] = {}
_discovered = False


def register(cls: type[Tool]) -> type[Tool]:
    if not getattr(cls, "id", None):
        raise ValueError(f"{cls.__name__} has no id")
    if cls.id in _REGISTRY and _REGISTRY[cls.id] is not cls:
        log.warning("Tool %r re-registered by %s", cls.id, cls.__module__)
    _REGISTRY[cls.id] = cls
    return cls


def discover() -> None:
    global _discovered
    if _discovered:
        return
    from . import builtin
    for mod in pkgutil.iter_modules(builtin.__path__):
        importlib.import_module(f"{builtin.__name__}.{mod.name}")
    from ..workspace import workspace
    if workspace.plugins_dir.exists():
        for path in sorted(workspace.plugins_dir.glob("*.py")):
            spec = importlib.util.spec_from_file_location(f"sbf_plugins.{path.stem}", path)
            try:
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
            except Exception:
                log.exception("Failed to load tool plugin %s", path)
    _discovered = True


def get_tool_class(tool_id: str) -> type[Tool]:
    discover()
    try:
        return _REGISTRY[tool_id]
    except KeyError:
        raise KeyError(f"Unknown tool {tool_id!r}") from None


def catalog() -> list[dict]:
    discover()
    return [cls.describe() for cls in sorted(_REGISTRY.values(), key=lambda c: (c.category, c.id))]


__all__ = ["NoConfig", "Tool", "ToolContext", "register", "discover", "get_tool_class", "catalog"]
