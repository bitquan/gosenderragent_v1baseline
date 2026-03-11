#!/usr/bin/env python3
"""Generate fine-tuning data from the dev_assistant log.

This script reads `dev_assistant.log` entries and emits a JSONL file where
"prompt" is the ticket description and "completion" is the diff of files
that were created/modified.  The resulting dataset can be used with OpenAI's
fine-tuning API or any other model training pipeline.

Usage:
    python scripts/train_dev_assistant.py --output training.jsonl
    python scripts/train_dev_assistant.py --log other.log --output training.jsonl

Options:
    --log      path to a log file (defaults to scripts/dev_assistant.log)
    --output   where to write the jsonl training file (required).
    --min-diff only include entries whose diff length exceeds this many
               characters (default 1).

The script does not invoke OpenAI itself; you can upload the generated file via
`openai api fine_tunes.create -t training.jsonl -m <base-model>` or use your
own training workflow.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

LOG_DEFAULT = Path(__file__).resolve().parent / "dev_assistant.log"


def load_entries(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            rows.append(payload)
    return rows


def make_training_example(entry: dict[str, Any]) -> dict[str, str] | None:
    desc = entry.get("desc") or ""
    diff = entry.get("diff") or ""
    if not diff.strip():
        return None
    prompt = f"Scaffold BAT<{entry.get('ticket','')}>, description:\n{desc}\n\n"
    completion = diff.strip() + "\n"
    return {"prompt": prompt, "completion": completion}


def main() -> None:
    parser = argparse.ArgumentParser(description="Create fine-tuning data from dev_assistant.log")
    parser.add_argument("--log", type=Path, default=LOG_DEFAULT, help="path to dev_assistant.log")
    parser.add_argument("--output", type=Path, required=True, help="output jsonl file")
    parser.add_argument("--min-diff", type=int, default=1, help="minimum diff length to include")
    parser.add_argument("--fine-tune-model", help="if provided, automatically start an OpenAI fine-tune job using this base model")
    parser.add_argument("--openai", action="store_true", help="alias for --fine-tune-model with default model gpt-4o-mini")
    args = parser.parse_args()

    entries = load_entries(args.log)
    out_lines: list[str] = []
    for e in entries:
        ex = make_training_example(e)
        if not ex:
            continue
        if len(ex["completion"]) < args.min_diff:
            continue
        out_lines.append(json.dumps(ex, ensure_ascii=False))

    args.output.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    print(f"wrote {len(out_lines)} examples to {args.output}")

    # optional fine-tune call
    model_to_use = None
    if args.openai and not args.fine_tune_model:
        model_to_use = "gpt-4o-mini"
    elif args.fine_tune_model:
        model_to_use = args.fine_tune_model
    if model_to_use:
        key = os.environ.get("OPENAI_API_KEY")
        if not key:
            print("OPENAI_API_KEY not set; cannot launch fine-tune")
            return
        try:
            import subprocess
            print(f"starting fine-tune with model {model_to_use}...")
            subprocess.check_call([
                "openai", "api", "fine_tunes.create",
                "-t", str(args.output),
                "-m", model_to_use,
            ])
        except Exception as e:
            print(f"fine-tune invocation failed: {e}")


if __name__ == "__main__":
    main()
