#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.agent.core.engine_daily_report import (  # noqa: E402
    build_engine_daily_report,
    render_engine_daily_report,
    write_engine_daily_report,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build the engine daily report from recent runtime and experiment artifacts.")
    parser.add_argument("--project-root", default=str(REPO_ROOT), help="project root to inspect")
    parser.add_argument("--lookback-hours", type=int, default=24, help="lookback window for runtime and experiment artifacts")
    parser.add_argument("--run-limit", type=int, default=30, help="maximum recent runtime artifacts to analyze")
    parser.add_argument("--experiment-limit", type=int, default=60, help="maximum recent experiment rows to analyze")
    parser.add_argument("--training-limit", type=int, default=120, help="maximum training rows to analyze")
    parser.add_argument("--output-dir", help="optional directory for the generated json and markdown summaries")
    parser.add_argument("--json", action="store_true", help="print json instead of markdown")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    project_root = Path(args.project_root).expanduser().resolve()
    report = build_engine_daily_report(
        project_root,
        lookback_hours=args.lookback_hours,
        run_limit=args.run_limit,
        experiment_limit=args.experiment_limit,
        training_limit=args.training_limit,
    )
    output_dir = Path(args.output_dir).expanduser().resolve() if args.output_dir else None
    written = write_engine_daily_report(project_root, report, output_dir=output_dir)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(render_engine_daily_report(report).rstrip())
        print("")
        print(f"JSON: {written['json']}")
        print(f"Markdown: {written['markdown']}")
        if written.get("canonical_markdown"):
            print(f"Canonical Markdown: {written['canonical_markdown']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())