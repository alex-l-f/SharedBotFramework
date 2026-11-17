"""
Manage accounts from the server's machine (e.g. the first admin, or a
forgotten admin password).

    python scripts/users.py list
    python scripts/users.py add <username> [--role viewer|editor|admin] [--name "Display Name"]
    python scripts/users.py password <username>        # sets a new password (prompted)
    python scripts/users.py role <username> <role>
    python scripts/users.py disable|enable <username>
    python scripts/users.py sign-out <username>         # ends all their sessions

Passwords are prompted for, never taken as arguments (shell history).
"""

from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sbf import auth, db  # noqa: E402


def _ask_password() -> str:
    first = getpass.getpass("Password: ")
    if getpass.getpass("Repeat: ") != first:
        raise SystemExit("The passwords differ")
    auth.check_password(first)
    return first


def _user(username: str) -> dict:
    row = auth.find_user(username)
    if row is None:
        raise SystemExit(f"No user {username!r}")
    return auth.public(row)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    add = sub.add_parser("add")
    add.add_argument("username")
    add.add_argument("--role", default=None, choices=auth.ROLES,
                     help="default: admin for the first account, else viewer")
    add.add_argument("--name", default="")
    add.add_argument("--temporary", action="store_true", help="They must change the password when signing in")
    pw = sub.add_parser("password")
    pw.add_argument("username")
    pw.add_argument("--temporary", action="store_true")
    role = sub.add_parser("role")
    role.add_argument("username")
    role.add_argument("role", choices=auth.ROLES)
    for name in ("disable", "enable", "sign-out"):
        sub.add_parser(name).add_argument("username")
    args = parser.parse_args()

    try:
        if args.cmd == "list":
            for u in auth.list_users():
                flags = [f for f, on in (("disabled", u["disabled"]), ("temporary password", u["must_change_password"]))
                         if on]
                print(f"{u['username']:<20} {u['role']:<7} {u['display_name']:<24} last sign-in: "
                      f"{u['last_login'] or '-'}  {', '.join(flags)}")
        elif args.cmd == "add":
            first = auth.count_users() == 0
            user = auth.create_user(args.username, _ask_password(), args.role or ("admin" if first else "viewer"),
                                    args.name, args.temporary)
            if first:
                adopted = db.adopt_unowned(user["id"])
                print(f"Earlier chats and profiles now belong to {user['username']}: {adopted}")
            print(f"Created {user['username']} ({user['role']})")
        elif args.cmd == "password":
            user = _user(args.username)
            auth.set_password(user["id"], _ask_password(), must_change=args.temporary)
            auth.end_user_sessions(user["id"])
            print(f"Password set; {user['username']} was signed out everywhere")
        elif args.cmd == "role":
            print(auth.update_user(_user(args.username)["id"], role=args.role)["role"])
        elif args.cmd in ("disable", "enable"):
            auth.update_user(_user(args.username)["id"], disabled=args.cmd == "disable")
            print(f"{args.username}: {args.cmd}d")
        elif args.cmd == "sign-out":
            print(f"Ended {auth.end_user_sessions(_user(args.username)['id'])} session(s)")
    except ValueError as exc:
        raise SystemExit(str(exc)) from None
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
