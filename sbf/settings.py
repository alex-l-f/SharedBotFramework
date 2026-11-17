"""
Process-wide settings.

Paths come from the environment (``SBF_WORKSPACE``, ``SBF_DATA``); everything
else lives in ``<workspace>/settings.yaml`` so it can be edited from the UI
and versioned with the definitions: model presets, the knowledge backend,
static content mounts.
"""

import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import yaml
from dotenv import load_dotenv
from pydantic import BaseModel, Field

from .schemas import ModelSpec

ROOT = Path(__file__).resolve().parent.parent

# API keys (OPENROUTER_API_KEY, GOOGLE_API_KEY, ...) are read by LiteLLM and
# google-genai from the environment.
load_dotenv(ROOT / ".env")

WORKSPACE = Path(os.getenv("SBF_WORKSPACE", ROOT / "workspace")).resolve()
DATA_DIR = Path(os.getenv("SBF_DATA", ROOT / "data")).resolve()


class KnowledgeSettings(BaseModel):
    """The library tools' default backend.

    ``embedding_service``: BotBase's embedding service. ``url`` is its base
    URL; ``processed_root`` holds one folder per library with its
    ``database.db``; ``file_root`` is where resource files (``source_path``)
    resolve.

    ``datasets``: this framework's own datasets (library id = dataset id).
    A tool binding can pick either backend for itself.
    """
    backend: Literal["embedding_service", "datasets"] = "embedding_service"
    url: str = "http://localhost:8201"
    processed_root: str = ""
    file_root: str = ""
    libraries: dict[str, dict[str, Any]] = Field(default_factory=dict)


class EmbedderSpec(BaseModel):
    """A text embedding model for the retrievers.

    * ``sentence_transformers`` — a local model (GPU when available)
    * ``litellm``               — an embeddings API LiteLLM routes
                                  (e.g. ``openai/text-embedding-3-small``)
    * ``hash``                  — hashed bag of words; no model, lexical only
                                  (tests, offline)
    """
    provider: Literal["sentence_transformers", "litellm", "hash"] = "sentence_transformers"
    model: str = "google/embeddinggemma-300m"
    api_base: str | None = None
    batch_size: int = 32


class StaticMount(BaseModel):
    """A directory served under a URL prefix (e.g. a SCORM course)."""
    prefix: str
    directory: str


class Settings(BaseModel):
    default_model: str = "default"
    models: dict[str, ModelSpec] = Field(default_factory=lambda: {
        "default": ModelSpec(provider="openrouter", model="openai/gpt-oss-20b",
                             reasoning_effort="medium"),
    })
    llm_retries: int = 4
    knowledge: KnowledgeSettings = Field(default_factory=KnowledgeSettings)
    embedders: dict[str, EmbedderSpec] = Field(default_factory=lambda: {"default": EmbedderSpec()})
    default_embedder: str = "default"
    # Files processed at once, and LLM calls (vision, extraction) in flight.
    processing_workers: int = 3
    processing_llm_calls: int = 8
    static_mounts: list[StaticMount] = Field(default_factory=list)
    # Where the open_course_page tool looks for SCORM packages.
    scorm_root: str = ""


SETTINGS_FILE = WORKSPACE / "settings.yaml"


@lru_cache(maxsize=1)
def _load(mtime: float) -> Settings:
    if not SETTINGS_FILE.exists():
        return Settings()
    data = yaml.safe_load(SETTINGS_FILE.read_text(encoding="utf-8")) or {}
    return Settings.model_validate(data)


def get_settings() -> Settings:
    """Current settings; re-read whenever settings.yaml changes on disk."""
    mtime = SETTINGS_FILE.stat().st_mtime if SETTINGS_FILE.exists() else 0.0
    return _load(mtime)


def settings_version() -> str | None:
    from .workspace import file_version
    return file_version(SETTINGS_FILE)


def save_settings(settings: Settings, expected_version: str | None = None) -> None:
    """Write settings.yaml; with ``expected_version``, only if it is still at
    that version (else ``workspace.Conflict``)."""
    from .workspace import dump_yaml, versioned_write
    versioned_write("settings", "settings", SETTINGS_FILE, dump_yaml(settings.model_dump(exclude_none=True)),
                    expected_version, lambda: get_settings().model_dump())
