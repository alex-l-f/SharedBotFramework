"""
Terminal chat client for a running server (handy for smoke tests).

    python scripts/chat_cli.py r2mr-coach --profile "Test user" "I'm stressed before my exam"
    python scripts/chat_cli.py r2mr-coach --chat <chat_id> "follow-up message"

Each message is one turn; with no messages it reads lines from stdin.
``--trace`` prints agent events as they stream.
"""

from __future__ import annotations

import argparse
import json
import sys

import httpx


def stream_turn(client: httpx.Client, chat_id: str, text: str, trace: bool) -> None:
    with client.stream("POST", f"/api/chats/{chat_id}/messages", json={"text": text},
                       timeout=None) as resp:
        resp.raise_for_status()
        for line in resp.iter_lines():
            if not line.startswith("data: "):
                continue
            ev = json.loads(line[6:])
            kind = ev.get("kind")
            if kind == "output":
                t = ev["type"]
                if t == "message":
                    print(f"\n[{ev.get('node')}] {ev['content']}\n")
                elif t in ("file", "viewer"):
                    print(f"  <{t}: {ev.get('title')} ({ev.get('resource_id')}) {ev.get('url')}>")
                elif t == "mode":
                    print(f"  <mode → {ev.get('label')}>")
                elif t == "handoff":
                    print(f"  <handoff {ev.get('from')} → {ev.get('to')}>")
            elif kind == "trace" and trace:
                data = json.dumps(ev.get("data"), ensure_ascii=False)
                print(f"    · {ev['agent']}:{ev['event']} {data[:220]}")
            elif kind == "error":
                print(f"  !! {ev.get('message')}")
            elif kind == "turn_done":
                print("  -- turn done --")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("system")
    p.add_argument("messages", nargs="*")
    p.add_argument("--server", default="http://127.0.0.1:5600")
    p.add_argument("--profile", help="Profile name (created if missing)")
    p.add_argument("--chat", help="Continue an existing chat id")
    p.add_argument("--trace", action="store_true")
    args = p.parse_intermixed_args()

    client = httpx.Client(base_url=args.server, timeout=30)
    chat_id = args.chat
    if not chat_id:
        profile_id = None
        if args.profile:
            profiles = {pr["name"]: pr["id"] for pr in client.get("/api/profiles").json()}
            profile_id = profiles.get(args.profile) or client.post(
                "/api/profiles", json={"name": args.profile}).json()["id"]
        resp = client.post("/api/chats", json={"system_id": args.system, "profile_id": profile_id})
        resp.raise_for_status()
        chat_id = resp.json()["id"]
    print(f"chat {chat_id}")
    messages = args.messages or (line.strip() for line in sys.stdin if line.strip())
    for text in messages:
        print(f"> {text}")
        stream_turn(client, chat_id, text, args.trace)


if __name__ == "__main__":
    main()
