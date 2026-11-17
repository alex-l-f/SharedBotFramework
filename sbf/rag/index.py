"""
Hybrid search over a list of entries: exact dense cosine + BM25, fused with
reciprocal rank fusion (each query contributes its own rankings, RAG-Fusion
style) — the index rag_lab used for every ranking retriever.
"""

from __future__ import annotations

from collections import defaultdict

import numpy as np
from rank_bm25 import BM25Okapi

from .embed import Embedder, tokenize


def rrf(rankings: list[list[int]], weights: list[float], k: int = 60) -> dict[int, float]:
    scores: dict[int, float] = defaultdict(float)
    for ranking, w in zip(rankings, weights):
        for rank, j in enumerate(ranking, start=1):
            scores[j] += w / (k + rank)
    return scores


class HybridIndex:
    def __init__(self, texts: list[str], vectors: np.ndarray, embedder: Embedder):
        self.texts = texts
        self.vectors = vectors
        self.embedder = embedder
        self.bm25 = BM25Okapi([tokenize(t) or ["∅"] for t in texts]) if texts else None

    @classmethod
    async def build(cls, texts: list[str], embedder: Embedder) -> "HybridIndex":
        vectors = await embedder.documents(texts) if texts else np.zeros((0, 1), dtype=np.float32)
        return cls(texts, vectors, embedder)

    def __len__(self):
        return len(self.texts)

    def _dense(self, qvec: np.ndarray, allowed: np.ndarray | None, n: int) -> list[int]:
        sims = self.vectors @ qvec
        if allowed is not None:
            sims = np.where(allowed, sims, -np.inf)
        order = np.argsort(-sims)[:n]
        return [int(j) for j in order if np.isfinite(sims[j])]

    def _bm25(self, query: str, allowed: np.ndarray | None, n: int) -> list[int]:
        toks = tokenize(query)
        if not toks or self.bm25 is None:
            return []
        scores = self.bm25.get_scores(toks)
        if allowed is not None:
            scores = np.where(allowed, scores, 0)
        order = np.argsort(-scores)[:n]
        return [int(j) for j in order if scores[j] > 0]

    async def search(self, queries: list[str], *, k: int = 10, allowed: np.ndarray | None = None,
                     dense_weight: float = 1.0, bm25_weight: float = 1.0,
                     depth: int = 50) -> list[tuple[int, float]]:
        """(entry position, fused score), best first."""
        queries = [q.strip() for q in queries if q and q.strip()]
        if not queries or not len(self):
            return []
        rankings, weights = [], []
        if dense_weight > 0:
            qvecs = await self.embedder.queries(queries)
            for v in qvecs:
                rankings.append(self._dense(v, allowed, depth))
                weights.append(dense_weight)
        if bm25_weight > 0:
            for q in queries:
                rankings.append(self._bm25(q, allowed, depth))
                weights.append(bm25_weight)
        fused = rrf(rankings, weights)
        return sorted(fused.items(), key=lambda x: -x[1])[:k]

    async def coverage_select(self, facets: list[str], *, budget: int, allowed: np.ndarray | None,
                              item_of: list[str], per_facet: int = 15, per_item: int = 2,
                              redundancy: float = 0.93) -> list[tuple[int, float]]:
        """Greedy facility-location selection (rag_lab 'facets'): each pick
        maximizes how much it raises every facet's best match, so one
        well-covered angle can't crowd out the others."""
        candidates: list[int] = []
        for f in facets:
            for j, _ in await self.search([f], k=per_facet, allowed=allowed):
                if j not in candidates:
                    candidates.append(j)
        if not candidates:
            return []
        fvec = await self.embedder.queries(facets)
        cvec = self.vectors[candidates]
        sim = fvec @ cvec.T
        best = np.zeros(len(facets))
        alive = np.ones(len(candidates), bool)
        chosen: list[tuple[int, float]] = []
        picked_rows: list[int] = []
        per: dict[str, int] = defaultdict(int)
        used = 0
        while alive.any() and used < budget:
            gain = np.clip(sim - best[:, None], 0, None).sum(0) + 0.1 * sim.max(0)
            gain[~alive] = -1
            c = int(gain.argmax())
            alive[c] = False
            j = candidates[c]
            if per[item_of[j]] >= per_item:
                continue
            if picked_rows and float((cvec[picked_rows] @ cvec[c]).max()) > redundancy:
                continue
            chosen.append((j, float(gain[c])))
            picked_rows.append(c)
            per[item_of[j]] += 1
            used += len(self.texts[j])
            best = np.maximum(best, sim[:, c])
        return chosen
