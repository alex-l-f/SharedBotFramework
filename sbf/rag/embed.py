"""
Text embeddings for the retrievers, cached on disk.

Embedders are named in settings (``embedders``); every vector is cached in
``<data>/embeddings.db`` keyed by model and text hash, so rebuilding an
index, or another retriever over the same texts, costs nothing.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import sqlite3
import threading

import numpy as np

from ..settings import DATA_DIR, EmbedderSpec, get_settings

CACHE_PATH = DATA_DIR / "embeddings.db"
_TOKEN_RE = re.compile(r"\w+", re.UNICODE)
HASH_DIM = 1024


def tokenize(text: str) -> list[str]:
    return _TOKEN_RE.findall(text.lower())


def _normalize(v: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(v, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return (v / norms).astype(np.float32)


class _Cache:
    def __init__(self):
        self._lock = threading.Lock()
        self._ready = False

    def _conn(self):
        conn = sqlite3.connect(CACHE_PATH, timeout=30)
        if not self._ready:
            with self._lock:
                CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("CREATE TABLE IF NOT EXISTS vectors (model TEXT, kind TEXT, hash TEXT, "
                             "vec BLOB, PRIMARY KEY (model, kind, hash))")
                self._ready = True
        return conn

    def get(self, model: str, kind: str, hashes: list[str]) -> dict[str, np.ndarray]:
        out = {}
        conn = self._conn()
        try:
            for i in range(0, len(hashes), 500):
                part = hashes[i:i + 500]
                rows = conn.execute(
                    f"SELECT hash, vec FROM vectors WHERE model = ? AND kind = ? AND hash IN "
                    f"({','.join('?' * len(part))})", (model, kind, *part)).fetchall()
                out.update({h: np.frombuffer(v, dtype=np.float32) for h, v in rows})
        finally:
            conn.close()
        return out

    def put(self, model: str, kind: str, items: dict[str, np.ndarray]) -> None:
        conn = self._conn()
        try:
            with conn:
                conn.executemany("INSERT OR REPLACE INTO vectors VALUES (?, ?, ?, ?)",
                                 [(model, kind, h, v.astype(np.float32).tobytes()) for h, v in items.items()])
        finally:
            conn.close()


_cache = _Cache()
_models: dict[str, object] = {}
_model_lock = threading.Lock()


def _st_model(name: str):
    with _model_lock:
        if name not in _models:
            import torch
            from sentence_transformers import SentenceTransformer
            cuda = torch.cuda.is_available()
            _models[name] = SentenceTransformer(
                name, device="cuda" if cuda else "cpu",
                model_kwargs={"dtype": torch.bfloat16} if cuda else {},
                tokenizer_kwargs={"padding_side": "left"})
        return _models[name]


class Embedder:
    def __init__(self, name: str, spec: EmbedderSpec):
        self.name = name
        self.spec = spec
        self.key = f"{spec.provider}:{spec.model}"
        self._lock = threading.Lock()

    async def documents(self, texts: list[str]) -> np.ndarray:
        return await self._embed(texts, "d")

    async def queries(self, texts: list[str]) -> np.ndarray:
        return await self._embed(texts, "q")

    async def _embed(self, texts: list[str], kind: str) -> np.ndarray:
        if not texts:
            return np.zeros((0, 1), dtype=np.float32)
        hashes = [hashlib.sha256(t.encode("utf-8")).hexdigest()[:24] for t in texts]
        cached = await asyncio.to_thread(_cache.get, self.key, kind, list(set(hashes)))
        missing = list(dict.fromkeys(t for t, h in zip(texts, hashes) if h not in cached))
        if missing:
            vecs = await self._compute(missing, kind)
            fresh = {hashlib.sha256(t.encode("utf-8")).hexdigest()[:24]: v for t, v in zip(missing, vecs)}
            await asyncio.to_thread(_cache.put, self.key, kind, fresh)
            cached.update(fresh)
        return np.stack([cached[h] for h in hashes]).astype(np.float32)

    async def _compute(self, texts: list[str], kind: str) -> np.ndarray:
        provider = self.spec.provider
        if provider == "hash":
            return _hash_vectors(texts)
        if provider == "sentence_transformers":
            return await asyncio.to_thread(self._st, texts, kind)
        import litellm
        out = []
        for i in range(0, len(texts), max(1, self.spec.batch_size)):
            batch = texts[i:i + self.spec.batch_size]
            kwargs = {"api_base": self.spec.api_base} if self.spec.api_base else {}
            resp = await litellm.aembedding(model=self.spec.model, input=batch,
                                            num_retries=get_settings().llm_retries, **kwargs)
            out.extend(d["embedding"] for d in resp.data)
        return _normalize(np.array(out, dtype=np.float32))

    def _st(self, texts: list[str], kind: str) -> np.ndarray:
        model = _st_model(self.spec.model)
        with self._lock:
            encode = getattr(model, "encode_query" if kind == "q" else "encode_document", None) or model.encode
            v = encode(texts, batch_size=self.spec.batch_size, show_progress_bar=False,
                       normalize_embeddings=True)
        return np.asarray(v, dtype=np.float32)


def _hash_vectors(texts: list[str]) -> np.ndarray:
    out = np.zeros((len(texts), HASH_DIM), dtype=np.float32)
    for i, text in enumerate(texts):
        for tok in tokenize(text):
            h = int(hashlib.md5(tok.encode("utf-8")).hexdigest(), 16)
            out[i, h % HASH_DIM] += 1.0 if (h >> 20) & 1 else -1.0
    return _normalize(out)


_embedders: dict[tuple, Embedder] = {}


def get_embedder(name: str = "") -> Embedder:
    settings = get_settings()
    name = name or settings.default_embedder
    spec = settings.embedders.get(name)
    if spec is None:
        raise ValueError(f"Unknown embedder {name!r} (settings.embedders)")
    key = (name, spec.provider, spec.model, spec.api_base)
    if key not in _embedders:
        _embedders[key] = Embedder(name, spec)
    return _embedders[key]
