"""
The retrieval contract shared by every retriever (after rag_lab's pack.py):
a ``RetrievalRequest`` in, a ``ContextPack`` of passages out, presented to
the model as text within a character budget.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class RetrievalRequest:
    queries: list[str] = field(default_factory=list)   # search queries (a tool's arguments)
    question: str = ""                                 # what is needed, in words
    conversation: list[dict] = field(default_factory=list)  # {"role": user|assistant, "content"}
    budget: int | None = None                          # characters (default: the retriever's)
    datasets: list[str] | None = None                  # restrict to these sources

    def user_messages(self) -> list[str]:
        return [m["content"] for m in self.conversation
                if m.get("role") == "user" and m.get("content")]

    def basic_queries(self) -> list[str]:
        """The explicit queries, else the situation as the user put it: the
        question, the opening message, the latest one, all user turns."""
        qs = [q for q in self.queries if q and q.strip()]
        if self.question and self.question not in qs:
            qs.insert(0, self.question)
        if qs:
            return qs
        users = self.user_messages()
        if users:
            qs.append(users[0])
            if len(users) > 1:
                qs += [users[-1], " ".join(users)]
        return qs

    def transcript(self, limit: int = 6000) -> str:
        lines = [f"{'USER' if m['role'] == 'user' else 'ASSISTANT'}: {m['content']}"
                 for m in self.conversation
                 if m.get("role") in ("user", "assistant") and m.get("content")]
        return "\n".join(lines)[-limit:]

    def situation(self) -> str:
        parts = []
        transcript = self.transcript()
        if transcript:
            parts.append(f"The conversation so far:\n{transcript}")
        if self.question:
            parts.append(f"What is needed now: {self.question}")
        elif self.queries:
            parts.append("Searching for: " + "; ".join(self.queries))
        return "\n\n".join(parts) or "(no situation given)"


@dataclass
class Passage:
    item_key: str          # "<dataset>:<item id>" — what the model cites
    dataset: str
    item_id: int
    title: str
    text: str
    kind: str = "chunk"    # chunk | item | brief
    label: str = ""        # page / slide / section
    source_type: str = ""
    url: str = ""
    score: float = 0.0
    fields: dict = field(default_factory=dict)

    def to_dict(self, with_text: bool = True) -> dict:
        d = asdict(self)
        if not with_text:
            d.pop("text")
        return d


@dataclass
class ContextPack:
    passages: list[Passage] = field(default_factory=list)
    brief: str = ""
    meta: dict = field(default_factory=dict)

    def items(self) -> list[Passage]:
        """The first passage of each item, in order."""
        seen, out = set(), []
        for p in self.passages:
            if p.item_key not in seen:
                seen.add(p.item_key)
                out.append(p)
        return out
