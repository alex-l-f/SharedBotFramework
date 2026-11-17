"""
Retrieval over datasets: retrievers (``retriever``), their hybrid index
(``index``), embeddings (``embed``) and the passage contract (``pack``).
Agents use a retriever through the ``rag_search`` / ``rag_read`` tools or
as context injected into a node's instruction (``NodeDef.context``).
"""

from .pack import ContextPack, Passage, RetrievalRequest
from .retriever import (DEFAULT_MAPPING, RetrievalResult, corpus_status, get_corpus, get_retriever_def,
                        item_url, parse_item_key, run_retriever)

__all__ = ["ContextPack", "DEFAULT_MAPPING", "Passage", "RetrievalRequest", "RetrievalResult", "corpus_status",
           "get_corpus", "get_retriever_def", "item_url", "parse_item_key", "run_retriever"]
