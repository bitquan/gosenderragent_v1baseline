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

# the feature board lives at the repo root under docs/
FEATURE_BOARD = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "docs", "BAT_FEATURE_BOARD.md")
)

# simplified regex: just capture the ticket id and everything after the final bracket
TICKET_RE = re.compile(r"^- `BAT<(?P<id>\d+)>`.*? (?P<desc>.+)$")


def load_tickets():
    tickets = {}
    with open(FEATURE_BOARD, "r") as f:
        for line in f:
            m = TICKET_RE.match(line.strip())
            if m:
                tickets[m.group("id")] = m.group("desc")
    return tickets


def ai_generate(prompt: str) -> str:
    """Use OpenAI API to generate boilerplate based on prompt.

    Requires OPENAI_API_KEY in environment. If not present, returns empty string.
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return ""  # no key, skip
    try:
        import openai
    except ImportError:
        return ""  # openai not installed

    openai.api_key = api_key
    resp = openai.ChatCompletion.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": "You are a code assistant."},
            {"role": "user", "content": prompt},
        ],
        max_tokens=500,
    )
    return resp.choices[0].message.content.strip()


def scaffold(ticket_id: str, use_ai: bool = False):
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

    if use_ai:
        prompt = (
            f"Generate Python boilerplate for a FastAPI/SQLAlchemy backend feature: '{desc}'.\n"
            "Include a SQLAlchemy model, a service module with basic CRUD stubs, "
            "a FastAPI router with one endpoint, and a pytest file with a skeleton test."
        )
        ai_code = ai_generate(prompt)
        if ai_code:
            print("AI-generated boilerplate: \n")
            print(ai_code)
        else:
            print("AI generation unavailable (missing key or package).\n")
    else:
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
