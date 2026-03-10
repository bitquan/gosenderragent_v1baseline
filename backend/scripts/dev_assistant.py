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
        from openai import OpenAI
    except ImportError:
        return ""  # openai not installed

    client = OpenAI(api_key=api_key)
    # use the new responses API
    resp = client.responses.create(
        model="gpt-4o-mini",
        input=[
            {"role": "system", "content": "You are a code assistant."},
            {"role": "user", "content": prompt},
        ],
        max_output_tokens=500,
    )
    # the response structure may contain 'output_text' summary
    if hasattr(resp, "output_text") and resp.output_text:
        return resp.output_text.strip()
    # fallback parse first message
    try:
        return resp.output[0].content[0].text
    except Exception:
        return ""


def make_basename(desc: str) -> str:
    # remove bracketed tags like [DONE], [BE], [P1], [TESTED]
    cleaned = re.sub(r"\[.*?\]", "", desc)
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "_", cleaned).strip("_")
    return cleaned.lower()


def write_stub(path: str, content: str = ""):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        print(f"skipping existing file {path}")
        return False
    with open(path, "w") as f:
        f.write(content)
    print(f"created {path}")
    return True


def scaffold(ticket_id: str, use_ai: bool = False, do_write: bool = False, do_git: bool = False):
    tickets = load_tickets()
    desc = tickets.get(ticket_id)
    if not desc:
        print(f"ticket {ticket_id} not found in {FEATURE_BOARD}")
        sys.exit(1)

    print(f"Scaffolding for BAT<{ticket_id}>: {desc}\n")

    # build clean base name for files
    snake = make_basename(desc)
    model_file = f"app/models/{snake}.py"
    service_file = f"app/services/{snake}.py"
    route_file = f"app/api/routes/{snake}.py"
    test_file = f"tests/test_{snake}.py"

    print("Suggested files to create:")
    for path in (model_file, service_file, route_file, test_file):
        print("  ", path)
    print()

    ai_code = ""
    if use_ai:
        prompt = (
            f"You are an assistant for the GoSenderr codebase. "
            f"Generate Python boilerplate for a FastAPI/SQLAlchemy backend feature described as: '{desc}'.\n"
            "Follow project conventions: models live in app.models, services in app.services, "
            "routers in app.api.routes, and tests in backend/tests. "
            "Use Pydantic schemas where appropriate and keep imports relative. "
            "Output all code sections in a single response."
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

    # if requested, write stub files
    if do_write:
        created = []
        for path in (model_file, service_file, route_file, test_file):
            header = f"# generated for BAT<{ticket_id}>: {desc}\n"
            write_stub(path, header)
            created.append(path)
        # if AI output is present, dump to companion file
        if ai_code:
            ai_path = f"generated_{snake}.txt"
            write_stub(ai_path, ai_code)
            created.append(ai_path)

        # optionally commit with git
        if do_git and created:
            # create branch
            branch = f"bat-{ticket_id}"
            os.system(f"git checkout -b {branch}")
            for fpath in created:
                os.system(f"git add {fpath}")
            os.system(f"git commit -m 'scaffold for BAT<{ticket_id}>'")
            print(f"Committed files on branch {branch}")


def main():
    parser = argparse.ArgumentParser(description="Dev assistant prototype")
    parser.add_argument("ticket", help="BAT ticket id (just number, e.g. 170)")
    parser.add_argument("--ai", action="store_true", help="invoke AI to generate code")
    parser.add_argument("--write", action="store_true", help="actually create stub files")
    parser.add_argument("--git", action="store_true", help="open git branch and commit new files")
    args = parser.parse_args()
    scaffold(args.ticket, use_ai=args.ai, do_write=args.write, do_git=args.git)


if __name__ == "__main__":
    main()
