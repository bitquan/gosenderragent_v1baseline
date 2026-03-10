#!/usr/bin/env python3
"""Simple prototype of a developer assistant that can scaffold code for a BAT ticket.

Usage:
    python backend/scripts/dev_assistant.py BAT_ID

The script reads the feature board markdown to locate the ticket description, then
prints a set of suggested file paths and basic stub content.  It's intentionally
naive; later versions could actually modify files or commit to git automatically.
"""

import argparse
import os
import re
import sys

FEATURE_BOARD = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "docs", "BAT_FEATURE_BOARD.md")
)

TICKET_RE = re.compile(r"- `BAT<(?P<id>\d+)> \[(?P<status>[^\]]+)\].*?\] (?P<desc>.+)")


def load_tickets():
    tickets = {}
    with open(FEATURE_BOARD, "r") as f:
        for line in f:
            m = TICKET_RE.match(line.strip())
            if m:
                tickets[m.group("id")] = m.group("desc")
    return tickets


def scaffold(ticket_id: str):
    tickets = load_tickets()
    desc = tickets.get(ticket_id)
    if not desc:
        print(f"ticket {ticket_id} not found in {FEATURE_BOARD}")
        sys.exit(1)

    print(f"Scaffolding for BAT<{ticket_id}>: {desc}\n")

    # simple heuristics to suggest file names
    snake = re.sub(r"[^a-z0-9]+", "_", desc.lower()).strip("_")
    model_file = f"app/models/{snake}.py"
    service_file = f"app/services/{snake}.py"
    route_file = f"app/api/routes/{snake}.py"
    test_file = f"tests/test_{snake}.py"

    print("Suggested files to create:")
    for path in (model_file, service_file, route_file, test_file):
        print("  ", path)
    print()

    print("Example stub content for model:")
    print("""
from sqlalchemy import Column, Integer, String
from app.db.session import Base

class TODOModel(Base):
    __tablename__ = 'todo_models'
    id = Column(Integer, primary_key=True)
""")
    # more sophisticated generation could go here


def main():
    parser = argparse.ArgumentParser(description="Dev assistant prototype")
    parser.add_argument("ticket", help="BAT ticket id (just number, e.g. 170)")
    args = parser.parse_args()
    scaffold(args.ticket)


if __name__ == "__main__":
    main()
