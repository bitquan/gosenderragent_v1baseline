#!/usr/bin/env python3
"""Detect newly added TODO BAT entries from docs/BAT_FEATURE_BOARD.md git diff."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BAT_PATH = "docs/BAT_FEATURE_BOARD.md"
LINE_RE = re.compile(r"^\+\s*-\s*`BAT<(?P<id>\d+)>`\s*\[(?P<status>[^\]]+)\].*$")


def run_diff(base: str, head: str) -> str:
    cmd = ["git", "diff", "--unified=0", base, head, "--", BAT_PATH]
    result = subprocess.run(cmd, cwd=str(REPO_ROOT), check=False, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "git diff failed")
    return result.stdout


def detect_new_todo_bats(diff_text: str) -> list[str]:
    ids: list[str] = []
    seen: set[str] = set()
    for line in diff_text.splitlines():
        if line.startswith("+++"):
            continue
        m = LINE_RE.match(line)
        if not m:
            continue
        ticket_id = m.group("id")
        status = m.group("status").strip().upper()
        if status != "TODO":
            continue
        if ticket_id not in seen:
            seen.add(ticket_id)
            ids.append(ticket_id)
    return ids


def main() -> None:
    parser = argparse.ArgumentParser(description="Detect newly added TODO BAT entries")
    parser.add_argument("--base", default="HEAD^", help="Base ref (default: HEAD^)")
    parser.add_argument("--head", default="HEAD", help="Head ref (default: HEAD)")
    parser.add_argument("--json", action="store_true", help="Emit JSON output")
    args = parser.parse_args()

    diff_text = run_diff(args.base, args.head)
    ids = detect_new_todo_bats(diff_text)

    if args.json:
        print(json.dumps({"bat_ids": ids}))
    else:
        print(",".join(ids))


if __name__ == "__main__":
    main()
