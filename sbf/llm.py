"""
Model construction: a resolved ``ModelSpec`` becomes what an ADK
``LlmAgent`` takes — a ``LiteLlm`` for OpenAI-compatible providers
(OpenRouter, llama.cpp, anything LiteLLM routes), a plain model name for
Gemini (ADK's native client) — plus its ``GenerateContentConfig``.

Resolution order: settings preset (the spec's ``preset`` or the default) →
agent spec → node override → call-site overrides (e.g. thinking off for a
recovery retry).

``complete`` makes a single LiteLLM call from the same specs, for work done
outside an agent (extraction, vision, retriever steps).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

import requests
from google.adk.models.base_llm import BaseLlm
from google.adk.models.lite_llm import LiteLlm
from google.genai import types

from .schemas import ModelSpec
from .settings import get_settings


def _preset(name: str, seen: tuple[str, ...] = ()) -> ModelSpec:
    """A preset with the presets it builds on (``preset:`` inside a preset) applied."""
    models = get_settings().models
    if name not in models:
        raise ValueError(f"Unknown model preset {name!r}")
    if name in seen:
        raise ValueError(f"Model presets form a cycle: {' -> '.join(seen + (name,))}")
    spec = models[name]
    if spec.preset and spec.preset != name:
        return _preset(spec.preset, seen + (name,)).overlay(spec)
    return spec


def resolve_spec(*specs: ModelSpec | None) -> ModelSpec:
    """Merge specs left to right on top of their preset."""
    settings = get_settings()
    merged = ModelSpec()
    for spec in specs:
        merged = merged.overlay(spec)
    preset_name = merged.preset or settings.default_model
    try:
        preset = _preset(preset_name)
    except ValueError:
        if merged.preset:
            raise
        preset = ModelSpec()
    resolved = preset.overlay(merged)
    return resolved.model_copy(update={"preset": preset_name})


def generate_config(spec: ModelSpec) -> types.GenerateContentConfig:
    config = types.GenerateContentConfig(
        temperature=spec.temperature,
        top_p=spec.top_p,
        presence_penalty=spec.presence_penalty,
        max_output_tokens=spec.max_output_tokens or 16384,
    )
    # The config types top_k as a float; vLLM-style servers reject 20.0.
    if spec.top_k is not None:
        config.top_k = int(spec.top_k)
    return config


def _served_model(api_base: str) -> str:
    """The model id a llama.cpp-style server is serving (it serves one)."""
    try:
        resp = requests.get(f"{api_base.rstrip('/')}/models", timeout=3)
        resp.raise_for_status()
        return resp.json()["data"][0]["id"]
    except (requests.RequestException, ValueError, KeyError, IndexError):
        return "local"


def make_model(spec: ModelSpec) -> str | BaseLlm:
    retries = get_settings().llm_retries
    provider = spec.provider or "openrouter"
    effort = (spec.reasoning_effort or "").strip().lower()

    if provider == "openrouter":
        if not os.getenv("OPENROUTER_API_KEY"):
            raise RuntimeError("OPENROUTER_API_KEY is not set (add it to .env)")
        if not spec.model:
            raise ValueError("An OpenRouter model id is required")
        # OpenRouter's unified reasoning control; 'off' / '' send none.
        extra = {"reasoning": {"effort": effort}} if effort not in ("", "off") else {}
        return LiteLlm(model=f"openrouter/{spec.model}", num_retries=retries,
                       **({"extra_body": extra} if extra else {}))

    if provider == "llama_cpp":
        api_base = spec.api_base or os.getenv("LLAMA_CPP_URL", "http://localhost:8080/v1")
        # llama.cpp / ninfer toggle thinking via chat_template_kwargs.
        extra: dict = {"chat_template_kwargs": {"enable_thinking": effort != "none"}}
        if effort not in ("none", "off", ""):
            extra["reasoning_effort"] = effort
        return LiteLlm(model=f"openai/{spec.model or _served_model(api_base)}",
                       api_base=api_base, api_key="-", num_retries=retries,
                       extra_body=extra)

    if provider == "litellm":
        kwargs = {"api_base": spec.api_base} if spec.api_base else {}
        if effort not in ("", "off"):
            kwargs["reasoning_effort"] = effort
        return LiteLlm(model=spec.model, num_retries=retries, **kwargs)

    # gemini: ADK resolves the bare model name to its google-genai client.
    return spec.model or "gemini-2.5-flash"


def litellm_kwargs(spec: ModelSpec) -> dict:
    """``litellm.acompletion`` arguments for a resolved spec — the same
    provider mapping as ``make_model``, for direct calls outside an agent
    (extraction, vision, retriever steps)."""
    provider = spec.provider or "openrouter"
    effort = (spec.reasoning_effort or "").strip().lower()
    kwargs: dict = {"num_retries": get_settings().llm_retries}
    if provider == "openrouter":
        if not os.getenv("OPENROUTER_API_KEY"):
            raise RuntimeError("OPENROUTER_API_KEY is not set (add it to .env)")
        if not spec.model:
            raise ValueError("An OpenRouter model id is required")
        kwargs["model"] = f"openrouter/{spec.model}"
        extra: dict = {"usage": {"include": True}}
        if effort not in ("", "off"):
            extra["reasoning"] = {"effort": effort}
        kwargs["extra_body"] = extra
    elif provider == "llama_cpp":
        api_base = spec.api_base or os.getenv("LLAMA_CPP_URL", "http://localhost:8080/v1")
        extra = {"chat_template_kwargs": {"enable_thinking": effort != "none"}}
        if effort not in ("none", "off", ""):
            extra["reasoning_effort"] = effort
        kwargs.update(model=f"openai/{spec.model or _served_model(api_base)}", api_base=api_base,
                      api_key="-", extra_body=extra)
    elif provider == "litellm":
        kwargs["model"] = spec.model
        if spec.api_base:
            kwargs["api_base"] = spec.api_base
        if effort not in ("", "off"):
            kwargs["reasoning_effort"] = effort
    else:
        kwargs["model"] = f"gemini/{spec.model or 'gemini-2.5-flash'}"
    for key in ("temperature", "top_p", "presence_penalty"):
        if getattr(spec, key) is not None:
            kwargs[key] = getattr(spec, key)
    if spec.top_k is not None:
        kwargs["top_k"] = int(spec.top_k)
    kwargs["max_tokens"] = spec.max_output_tokens or 16384
    return kwargs


@dataclass
class Completion:
    text: str
    reasoning: str = ""
    finish_reason: str = ""
    usage: dict = field(default_factory=dict)
    cost: float | None = None


async def complete(spec: ModelSpec, messages: list[dict], *, max_tokens: int | None = None,
                   temperature: float | None = None, reasoning: str | None = None) -> Completion:
    """One chat completion. ``reasoning`` overrides the spec's effort
    ('none' turns thinking off for cheap helper calls)."""
    import litellm

    litellm.suppress_debug_info = True
    if reasoning is not None:
        spec = spec.model_copy(update={"reasoning_effort": reasoning})
    kwargs = litellm_kwargs(spec)
    if max_tokens:
        kwargs["max_tokens"] = max_tokens
    if temperature is not None:
        kwargs["temperature"] = temperature
    try:
        resp = await litellm.acompletion(messages=messages, **kwargs)
    except litellm.BadRequestError as exc:
        # Some models can't turn thinking off; use the lightest setting instead.
        if (spec.reasoning_effort or "").lower() != "none" or "reasoning" not in str(exc).lower():
            raise
        return await complete(spec, messages, max_tokens=max_tokens, temperature=temperature,
                              reasoning="low")
    choice = resp.choices[0]
    message = choice.message
    usage = resp.get("usage") or {}
    usage = usage.model_dump() if hasattr(usage, "model_dump") else dict(usage)
    cost = usage.get("cost")
    if cost is None:
        cost = (getattr(resp, "_hidden_params", None) or {}).get("response_cost")
    return Completion(text=(message.content or "").strip(),
                      reasoning=getattr(message, "reasoning_content", None) or "",
                      finish_reason=choice.finish_reason or "",
                      usage={k: usage.get(k) for k in ("prompt_tokens", "completion_tokens", "total_tokens")
                             if usage.get(k) is not None},
                      cost=float(cost) if isinstance(cost, (int, float)) else None)


def parse_json(text: str):
    """The JSON value in a model reply (tolerates code fences and prose around it)."""
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        text = text.rsplit("```", 1)[0]
    try:
        return json.loads(text)
    except ValueError:
        pass
    for open_, close in (("{", "}"), ("[", "]")):
        start, end = text.find(open_), text.rfind(close)
        if 0 <= start < end:
            try:
                return json.loads(text[start:end + 1])
            except ValueError:
                continue
    raise ValueError("the reply is not valid JSON")


def describe(spec: ModelSpec) -> str:
    bits = [spec.provider or "openrouter", spec.model or "(served)"]
    if spec.reasoning_effort:
        bits.append(f"effort={spec.reasoning_effort}")
    return " ".join(bits)
