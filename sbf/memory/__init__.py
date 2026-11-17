"""
Privacy-preserving template memory, driven by a ``MemorySchema``.

A note is a template key plus slot values, where every slot is an enum from
the schema's vocabularies or a reference to a retrieved library resource —
nothing the user literally said can be stored. Ported from BotBase's
``memory_templates.py`` / ``memory.py``, with the R2MR vocabulary moved into
a data file (``workspace/memory_schemas/*.yaml``) and notes partitioned by a
namespace so different systems keep separate memories.
"""

from .store import MemoryStore, memory_store
from .templates import (
    prompt_lines,
    registry_for_api,
    render_note,
    slot_union_properties,
    validate_note,
)

__all__ = [
    "MemoryStore", "memory_store", "prompt_lines", "registry_for_api",
    "render_note", "slot_union_properties", "validate_note",
]
