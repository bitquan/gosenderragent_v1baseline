from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.agent.core.engine_day1_support import DEFAULT_OWNER_GOALS, _artifact_paths, _queue_snapshot, _task_snapshot
from backend.agent.core.storage_paths import assistant_runs_dir
from backend.agent.runtime import runtime_api


DAY2_SIGNAL_HINTS: list[str] = [
    "repeated failures",
    "repeated review requests",
    "blocked targets",
    "history tracking",
    "non-recursive safeguards",
    "self-only path boundaries",
]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pick_stress_task(prepared_tasks: list[dict[str, Any]]) -> dict[str, Any] | None:
    for difficulty in ("medium", "low", "high"):
        for task in prepared_tasks:
            metadata = dict(task.get("metadata") or {})
            if str(metadata.get("difficulty") or "").lower() == difficulty:
                return task
    return prepared_tasks[0] if prepared_tasks else None


def build_engine_day2_bundle(
    project_root: Path,
    *,
    baseline_lookback_hours: int = 72,
    daily_lookback_hours: int = 24,
    run_limit: int = 20,
    experiment_limit: int = 40,
    training_limit: int = 80,
    history_limit: int = 10,
    queue_limit: int = 5,
    owner_goals: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    project_root = Path(project_root).expanduser().resolve()
    requested_owner_goals = [dict(item) for item in list(owner_goals or DEFAULT_OWNER_GOALS) if isinstance(item, dict)]

    baseline = runtime_api.summarize_engine_baseline(
        {
            "projectRoot": str(project_root),
            "lookbackHours": baseline_lookback_hours,
            "runLimit": run_limit,
            "experimentLimit": experiment_limit,
            "trainingLimit": training_limit,
        }
    )
    daily = runtime_api.summarize_engine_daily_report(
        {
            "projectRoot": str(project_root),
            "lookbackHours": daily_lookback_hours,
            "runLimit": run_limit,
            "experimentLimit": experiment_limit,
            "trainingLimit": training_limit,
        }
    )
    experiments = runtime_api.summarize_experiments({"limit": experiment_limit})
    training_handoff = runtime_api.prepare_training_handoff({"limit": training_limit})

    self_improvement = runtime_api.summarize_self_improvement({"historyLimit": history_limit, "limit": queue_limit})
    self_improvement_export = runtime_api.export_self_improvement_queue({"historyLimit": history_limit, "limit": queue_limit})
    self_task = _pick_stress_task([dict(item) for item in list(self_improvement.get("preparedTasks") or []) if isinstance(item, dict)])

    bundle = {
        "generated_at": _utc_now(),
        "project_root": str(project_root),
        "owner_goals": requested_owner_goals,
        "stress_policy": {
            "preferred_difficulties": ["medium", "low"],
            "blocked_difficulties": ["high"],
            "max_tasks_per_slice": 1,
            "self_improvement_repair": True,
            "followup_execution": False,
            "looping": False,
            "self_only_paths": True,
        },
        "pre_run": {
            "baseline": baseline,
            "daily_report": daily,
            "experiment_summary": experiments,
            "training_handoff": training_handoff,
        },
        "queues": {
            "self_improvement": {
                "summary": self_improvement,
                "export": self_improvement_export,
                "snapshot": _queue_snapshot(self_improvement),
                "recommendedTask": _task_snapshot(self_task),
            }
        },
        "bounded_stress_plan": [
            {
                "category": "self_improvement",
                "action": "self-improvement-run",
                "projectRoot": str(project_root),
                "recommendedTask": _task_snapshot(self_task),
                "expectedSignals": list(DAY2_SIGNAL_HINTS),
                "note": "Run one medium-first self-improvement slice, then refresh queue/history and inspect review, repair, and recursion signals before any follow-up.",
            }
        ],
        "focus_questions": [
            "Does it stay in bounds?",
            "Does it keep producing useful tasks?",
            "Does history update correctly?",
            "Does it stop recursion properly?",
        ],
        "reporting_refresh": [
            {
                "name": "engine-baseline-summary",
                "reason": "Confirm repeated self-work does not regress runtime health or increase unsafe blocker patterns.",
            },
            {
                "name": "engine-daily-report",
                "reason": "Inspect review-required rate, executed repairs, summary quality, and recommendation quality after each slice.",
            },
            {
                "name": "self-improvement-summary and self-improvement-export",
                "reason": "Check queue refresh, history tracking, blocked targets, and remaining prepared tasks after each run.",
            },
            {
                "name": "experiment-summary and training-handoff",
                "reason": "Verify repeated self-improvement runs still generate usable experiment and training signals.",
            },
        ],
        "review_targets": [
            {
                "title": "Day 2 self-improvement gates",
                "reason": "Confirm medium-only stress selection, self-only path boundaries, and non-recursive protections before execution.",
                "artifactPaths": _artifact_paths(self_improvement_export),
            },
            {
                "title": "History and review behavior",
                "reason": "Use self-improvement queue/history artifacts to inspect repeated reviews, blocked targets, and history update quality.",
                "artifactPaths": _artifact_paths(self_improvement),
            },
            {
                "title": "Repair and summary quality",
                "reason": str(daily.get("summary") or "Compare executed repairs, summary clarity, and recommended actions after each self-improvement slice."),
                "artifactPaths": _artifact_paths(baseline, daily, experiments, training_handoff),
            },
        ],
        "success_criteria": [
            "It stays inside engine-owned self-improvement paths.",
            "It does not trigger uncontrolled recursion or looping.",
            "History updates stay clear and reviewable.",
            "Summaries remain useful instead of nonsensical.",
        ],
    }
    bundle["artifact_paths"] = _artifact_paths(
        baseline,
        daily,
        experiments,
        training_handoff,
        self_improvement,
        self_improvement_export,
    )
    return bundle


def render_engine_day2_bundle(bundle: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append("# Engine Test Week Day 2 Bundle")
    lines.append("")
    lines.append(f"Generated: {bundle.get('generated_at', '')}")
    lines.append(f"Project root: {bundle.get('project_root', '')}")
    lines.append("")
    lines.append("## Day 2 readiness analysis")
    lines.append("")
    lines.append("- Day 2 is self-improvement only.")
    lines.append("- The runtime already exposes queue summaries, history, review signals, repair counts, and bounded self-only host boundaries.")
    lines.append("- The safest escalation is medium-first self-improvement task selection with high difficulty still blocked.")
    lines.append("- Repair follow-up stays enabled only for the executed self-improvement slice.")
    lines.append("")
    lines.append("## Proposed Day 2 self-improvement stress plan")
    lines.append("")
    for item in list(bundle.get("bounded_stress_plan") or []):
        recommended_task = dict(item.get("recommendedTask") or {})
        if recommended_task:
            lines.append(
                f"- {item.get('category', '')}: {recommended_task.get('taskId', '')} "
                f"({recommended_task.get('difficulty', 'unknown')}) — {recommended_task.get('title', '')}"
            )
        else:
            lines.append(f"- {item.get('category', '')}: queue-only review; no prepared task selected")
        lines.append(f"  - {item.get('note', '')}")
        signals = [str(signal) for signal in list(item.get("expectedSignals") or []) if str(signal)]
        if signals:
            lines.append(f"  - expected signals: {', '.join(signals)}")
    lines.append("")
    lines.append("## Queue stress snapshot")
    lines.append("")
    snapshot = dict((bundle.get("queues") or {}).get("self_improvement") or {}).get("snapshot") or {}
    lines.append(
        f"- self_improvement: {snapshot.get('eligibleCandidates', 0)} eligible / "
        f"{snapshot.get('blockedCandidates', 0)} blocked / "
        f"{snapshot.get('totalCandidates', 0)} total"
    )
    if snapshot.get("preferredDifficulty"):
        lines.append(f"  - preferred difficulty: {snapshot.get('preferredDifficulty', 'unknown')}")
    if snapshot.get("difficultyCounts"):
        lines.append(f"  - difficulty counts: {snapshot.get('difficultyCounts')}")
    if snapshot.get("summary"):
        lines.append(f"  - {snapshot.get('summary', '')}")
    lines.append("")
    lines.append("## Focus questions")
    lines.append("")
    for question in list(bundle.get("focus_questions") or []):
        lines.append(f"- {question}")
    lines.append("")
    lines.append("## Reporting to refresh after each run")
    lines.append("")
    for item in list(bundle.get("reporting_refresh") or []):
        lines.append(f"- {item.get('name', '')}: {item.get('reason', '')}")
    lines.append("")
    lines.append("## Day 2 checklist")
    lines.append("")
    lines.append("- [ ] Review the self-improvement queue export before executing any medium task.")
    lines.append("- [ ] Run exactly one prepared self-improvement task, allowing only low or medium difficulty.")
    lines.append("- [ ] Confirm blocked targets remain blocked and self-only path boundaries stay intact.")
    lines.append("- [ ] Inspect `runSummary`, `testSummary`, `reviewSummary`, and history updates after the run.")
    lines.append("- [ ] Refresh baseline, daily report, self-improvement queue, experiment summary, and training handoff.")
    lines.append("- [ ] Stop if recursion signals, nonsense summaries, or uncontrolled retries appear.")
    lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def write_engine_day2_bundle(project_root: Path, bundle: dict[str, Any], *, output_dir: Path | None = None) -> dict[str, Path]:
    target_dir = Path(output_dir or assistant_runs_dir(project_root)).expanduser().resolve()
    target_dir.mkdir(parents=True, exist_ok=True)
    json_path = target_dir / "engine_day2_bundle.json"
    markdown_path = target_dir / "engine_day2_bundle.md"
    json_path.write_text(json.dumps(bundle, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_engine_day2_bundle(bundle), encoding="utf-8")
    return {"json": json_path, "markdown": markdown_path}
