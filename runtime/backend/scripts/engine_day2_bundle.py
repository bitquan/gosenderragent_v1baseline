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

from backend.agent.core.engine_day2_support import (  # noqa: E402
    DEFAULT_OWNER_GOALS,
    build_engine_day2_bundle,
    render_engine_day2_bundle,
    write_engine_day2_bundle,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build a bounded Day 2 self-improvement stress bundle for operator review.")
    parser.add_argument("--project-root", default=str(REPO_ROOT), help="project root to inspect")
    parser.add_argument("--owner-goal", action="append", default=[], help="optional operator goal metadata to carry into the Day 2 bundle; may be repeated")
    parser.add_argument("--baseline-lookback-hours", type=int, default=72, help="lookback window for the engine baseline summary")
    parser.add_argument("--daily-lookback-hours", type=int, default=24, help="lookback window for the engine daily report")
    parser.add_argument("--run-limit", type=int, default=20, help="maximum recent runtime artifacts to analyze")
    parser.add_argument("--experiment-limit", type=int, default=40, help="maximum recent experiment rows to analyze")
    parser.add_argument("--training-limit", type=int, default=80, help="maximum training rows to analyze")
    parser.add_argument("--history-limit", type=int, default=10, help="history window for queue summaries")
    parser.add_argument("--queue-limit", type=int, default=5, help="maximum prepared self-improvement tasks to inspect")
    parser.add_argument("--output-dir", help="optional directory for the generated json and markdown summaries")
    parser.add_argument("--json", action="store_true", help="print json instead of markdown")
    return parser


def _owner_goals(values: list[str]) -> list[dict[str, str]]:
    goals = [value.strip() for value in values if value and value.strip()]
    if not goals:
        return list(DEFAULT_OWNER_GOALS)
    return [{"goal": goal, "category": "testing"} for goal in goals]


def main() -> int:
    args = build_parser().parse_args()
    project_root = Path(args.project_root).expanduser().resolve()
    bundle = build_engine_day2_bundle(
        project_root,
        owner_goals=_owner_goals(args.owner_goal),
        baseline_lookback_hours=args.baseline_lookback_hours,
        daily_lookback_hours=args.daily_lookback_hours,
        run_limit=args.run_limit,
        experiment_limit=args.experiment_limit,
        training_limit=args.training_limit,
        history_limit=args.history_limit,
        queue_limit=args.queue_limit,
    )
    output_dir = Path(args.output_dir).expanduser().resolve() if args.output_dir else None
    written = write_engine_day2_bundle(project_root, bundle, output_dir=output_dir)

    if args.json:
        print(json.dumps(bundle, indent=2))
    else:
        print(render_engine_day2_bundle(bundle).rstrip())
        print("")
        print(f"JSON: {written['json']}")
        print(f"Markdown: {written['markdown']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
