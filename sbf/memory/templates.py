"""Validation, rendering and tool-schema helpers for a ``MemorySchema``."""

from __future__ import annotations

from jinja2.sandbox import SandboxedEnvironment

from ..schemas import MemorySchema

_env = SandboxedEnvironment(autoescape=False, trim_blocks=True, lstrip_blocks=True)


def label(schema: MemorySchema, value) -> str:
    v = str(value or "")
    return schema.labels.get(v, v.replace("_", " "))


def _resource_name(slots: dict) -> str:
    title = (slots.get("title") or "").strip()
    if title:
        return f"'{title}'"
    return f"resource #{slots.get('resource', '?')} ({slots.get('provider', '?')})"


def render_note(schema: MemorySchema, template: str, slots: dict) -> str:
    """Deterministic human-readable line for a validated note."""
    spec = schema.templates.get(template)
    if spec is None or not spec.render:
        return f"{template}: {slots}"
    variables = {name: None for name in spec.slots}
    variables.update(slots)
    variables["label"] = lambda v: label(schema, v)
    variables["resource_name"] = lambda: _resource_name(slots)
    return _env.from_string(spec.render).render(**variables).strip()


def validate_note(schema: MemorySchema, template: str, slots: dict | None,
                  ) -> tuple[dict, list[str]]:
    """Check one note against the schema; returns (clean_slots, errors).

    Resource references are stored as provider (library id) + integer id +
    a title snapshot; anything not registered is rejected, which is the
    privacy contract's enforcement point.
    """
    spec = schema.templates.get(template)
    if spec is None:
        return {}, [f"unknown template {template!r}"]
    slots = slots or {}
    errors: list[str] = []
    clean: dict = {}

    for name, rule in spec.slots.items():
        if rule.ref == "resource":
            if slots.get("resource") is None and slots.get("provider") is None:
                if rule.required:
                    errors.append("missing required resource reference")
                continue
            provider = slots.get("provider")
            if not provider:
                errors.append("resource reference has no library")
                continue
            try:
                clean["resource"] = int(slots.get("resource"))
            except (TypeError, ValueError):
                errors.append(f"resource id must be an integer, got {slots.get('resource')!r}")
                continue
            clean["provider"] = str(provider)
            if slots.get("title") is not None:
                clean["title"] = str(slots["title"])[:200]
            continue
        value = slots.get(name)
        if value is None or value == "":
            if rule.required:
                errors.append(f"missing required slot '{name}'")
            continue
        allowed = schema.slot_values(rule)
        if value not in allowed:
            errors.append(f"slot '{name}' must be one of {allowed}, got {value!r}")
            continue
        clean[name] = value

    permitted = set(spec.slots) | {"provider", "resource", "title"}
    extras = [k for k in slots if k not in permitted]
    if extras:
        errors.append(f"unknown slot(s) {extras} — free-form values are not storable")
    return clean, errors


def prompt_lines(schema: MemorySchema) -> list[str]:
    """One line per template, for the extraction tool's description."""
    lines = []
    for key, spec in schema.templates.items():
        parts = []
        for name, rule in spec.slots.items():
            req = "required" if rule.required else "optional"
            if rule.ref == "resource":
                parts.append(f"{name} ({req}: RES_xxxxx id from this session)")
            else:
                parts.append(f"{name} ({req})")
        lines.append(f"- {key}: {spec.description} Slots: {', '.join(parts)}.")
    return lines


def slot_union_properties(schema: MemorySchema) -> dict:
    """JSON-schema properties for every slot name across all templates."""
    props: dict = {}
    for spec in schema.templates.values():
        for name, rule in spec.slots.items():
            if name in props:
                continue
            if rule.ref == "resource":
                props[name] = {"type": "string",
                               "description": "Exact resource id retrieved this session, e.g. 'RES_00004'."}
            else:
                props[name] = {"type": "string", "enum": schema.slot_values(rule)}
    return props


def registry_for_api(schema: MemorySchema) -> dict:
    out = {}
    for key, spec in schema.templates.items():
        slots = {}
        for name, rule in spec.slots.items():
            if rule.ref == "resource":
                slots[name] = {"ref": "resource", "required": rule.required}
            else:
                slots[name] = {"enum": schema.slot_values(rule), "required": rule.required}
        out[key] = {"description": spec.description, "follow_up": spec.follow_up, "slots": slots}
    return out
