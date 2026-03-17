from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.agent.core.storage_paths import assistant_runs_dir
from backend.agent.runtime import runtime_api


DEFAULT_OWNER_GOALS: list[dict[str, str]] = [
    {
        "goal": "Improve engine testing-week reliability for summaries, review signals, and bounded repair follow-ups.",
        "category": "testing",
    }
]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pick_task(prepared_tasks: list[dict[str, Any]]) -> dict[str, Any] | None:
    for difficulty in ("low", "medium", "high"):
        for task in prepared_tasks:
            metadata = dict(task.get("metadata") or {})
            if metadata.get("difficulty") == difficulty:
                return task
    return prepared_tasks[0] if prepared_tasks else None


def _task_snapshot(task: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(task, dict):
        return None
    metadata = dict(task.get("metadata") or {})
    runtime_task = dict(task.get("runtime_task") or {})
    host_boundary = dict(runtime_task.get("host_boundary") or {})
    return {
        "taskId": str(task.get("task_id") or ""),
        "title": str(task.get("title") or task.get("objective") or task.get("task_id") or ""),
        "difficulty": str(metadata.get("difficulty") or "unknown"),
        "targetPaths": [str(path) for path in list(task.get("target_paths") or []) if str(path)],
        "requiresReview": bool(host_boundary.get("require_review")),
        "sandboxRequired": bool(host_boundary.get("sandbox_required")),
        "allowedTargetPaths": [str(path) for path in list(host_boundary.get("allowed_target_paths") or []) if str(path)],
    }


def _queue_snapshot(summary: dict[str, Any]) -> dict[str, Any]:
    queue_summary = dict(summary.get("queueSummary") or {})
    metadata = dict(queue_summary.get("metadata") or {})
    recommendation = dict(summary.get("recommendation") or {})
    return {
        "summary": str(summary.get("summary") or queue_summary.get("summary") or ""),
        "totalCandidates": int(queue_summary.get("total_candidates") or 0),
        "eligibleCandidates": int(queue_summary.get("eligible_candidate_count") or 0),
        "blockedCandidates": int(queue_summary.get("blocked_candidate_count") or 0),
        "preferredDifficulty": str(recommendation.get("metadata", {}).get("preferred_difficulty") or "unknown"),
        "difficultyCounts": dict(metadata.get("candidate_difficulty_counts") or {}),
    }


def _artifact_paths(*results: dict[str, Any]) -> list[str]:
    seen: set[str] = set()
    artifact_paths: list[str] = []
    for result in results:
        for path in list(result.get("artifactPaths") or []):
            text = str(path or "")
            if text and text not in seen:
                seen.add(text)
                artifact_paths.append(text)
        for key in ("outputPath", "datasetPath"):
            text = str(result.get(key) or "")
            if text and text not in seen:
                seen.add(text)
                artifact_paths.append(text)
    return artifact_paths


def build_engine_day1_bundle(
    project_root: Path,
    *,
    project_maintenance_root: Path | None = None,
    owner_automation_root: Path | None = None,
    owner_goals: list[dict[str, Any]] | None = None,
    baseline_lookback_hours: int = 72,
    daily_lookback_hours: int = 24,
    run_limit: int = 20,
    experiment_limit: int = 40,
    training_limit: int = 80,
    history_limit: int = 10,
    queue_limit: int = 3,
) -> dict[str, Any]:
    project_root = Path(project_root).expanduser().resolve()
    project_maintenance_root = Path(project_maintenance_root or project_root).expanduser().resolve()
    owner_automation_root = Path(owner_automation_root or project_root).expanduser().resolve()
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

    project_maintenance = runtime_api.summarize_project_maintenance(
        {
            "projectRoot": str(project_maintenance_root),
            "historyLimit": history_limit,
            "limit": queue_limit,
        }
    )
    project_maintenance_export = runtime_api.export_project_maintenance_queue(
        {
            "projectRoot": str(project_maintenance_root),
            "historyLimit": history_limit,
            "limit": queue_limit,
        }
    )

    owner_automation = runtime_api.summarize_owner_automation(
        {
            "projectRoot": str(owner_automation_root),
            "ownerGoals": requested_owner_goals,
            "historyLimit": history_limit,
            "limit": queue_limit,
        }
    )
    owner_automation_export = runtime_api.export_owner_automation_queue(
        {
            "projectRoot": str(owner_automation_root),
            "ownerGoals": requested_owner_goals,
            "historyLimit": history_limit,
            "limit": queue_limit,
        }
    )

    self_task = _pick_task([dict(item) for item in list(self_improvement.get("preparedTasks") or []) if isinstance(item, dict)])
    maintenance_task = _pick_task([dict(item) for item in list(project_maintenance.get("preparedTasks") or []) if isinstance(item, dict)])
    owner_task = _pick_task([dict(item) for item in list(owner_automation.get("preparedTasks") or []) if isinstance(item, dict)])

    bundle = {
        "generated_at": _utc_now(),
        "project_root": str(project_root),
        "project_maintenance_root": str(project_maintenance_root),
        "owner_automation_root": str(owner_automation_root),
        "owner_goals": requested_owner_goals,
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
            },
            "project_maintenance": {
                "summary": project_maintenance,
                "export": project_maintenance_export,
                "snapshot": _queue_snapshot(project_maintenance),
                "recommendedTask": _task_snapshot(maintenance_task),
            },
            "owner_automation": {
                "summary": owner_automation,
                "export": owner_automation_export,
                "snapshot": _queue_snapshot(owner_automation),
                "recommendedTask": _task_snapshot(owner_task),
            },
        },
        "bounded_run_plan": [
            {
                "category": "self_improvement",
                "action": "self-improvement-run",
                "projectRoot": str(project_root),
                "recommendedTask": _task_snapshot(self_task),
                "note": "Run at most one low-difficulty self-improvement task on Day 1 after reviewing the exported queue.",
            },
            {
                "category": "project_maintenance",
                "action": "project-maintenance-run",
                "projectRoot": str(project_maintenance_root),
                "recommendedTask": _task_snapshot(maintenance_task),
                "note": "Use one prepared maintenance task only if its target paths stay inside the selected project root.",
            },
            {
                "category": "owner_automation",
                "action": "owner-automation-run",
                "projectRoot": str(owner_automation_root),
                "recommendedTask": _task_snapshot(owner_task),
                "note": "Keep owner automation to one prepared task with review and sandbox protections intact.",
            },
        ],
        "review_targets": [
            {
                "title": "Baseline blockers",
                "reason": str(baseline.get("summary") or "Review baseline failures and repeated fingerprints before task execution."),
                "artifactPaths": _artifact_paths(baseline),
            },
            {
                "title": "Queue boundaries",
                "reason": "Confirm self-improvement, project-maintenance, and owner-automation queues stay bounded and review-protected.",
                "artifactPaths": _artifact_paths(self_improvement_export, project_maintenance_export, owner_automation_export),
            },
            {
                "title": "Experiment quality",
                "reason": str(experiments.get("summary") or "Inspect benchmark summary before and after Day 1 execution."),
                "artifactPaths": _artifact_paths(experiments, training_handoff),
            },
            {
                "title": "Daily report",
                "reason": str(daily.get("summary") or "Use the daily report to compare post-run blockers and recommended actions."),
                "artifactPaths": _artifact_paths(daily),
            },
        ],
    }
    bundle["artifact_paths"] = _artifact_paths(
        baseline,
        daily,
        experiments,
        training_handoff,
        self_improvement,
        self_improvement_export,
        project_maintenance,
        project_maintenance_export,
        owner_automation,
        owner_automation_export,
    )
    return bundle


def render_engine_day1_bundle(bundle: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append("# Engine Test Week Day 1 Bundle")
    lines.append("")
    lines.append(f"Generated: {bundle.get('generated_at', '')}")
    lines.append(f"Project root: {bundle.get('project_root', '')}")
    lines.append("")
    lines.append("## Existing runtime and report actions")
    lines.append("")
    lines.append("- `engine-baseline-summary` for the recent baseline window")
    lines.append("- `engine-daily-report` for the post-run operating view")
    lines.append("- `self-improvement-summary` and `self-improvement-export`")
    lines.append("- `project-maintenance-summary` and `project-maintenance-export`")
    lines.append("- `owner-automation-summary` and `owner-automation-export`")
    lines.append("- `experiment-summary` and `training-handoff`")
    lines.append("")
    lines.append("## Bounded Day 1 task mix")
    lines.append("")
    for item in list(bundle.get("bounded_run_plan") or []):
        recommended_task = dict(item.get("recommendedTask") or {})
        if recommended_task:
            lines.append(
                f"- {item.get('category', '')}: {recommended_task.get('taskId', '')} "
                f"({recommended_task.get('difficulty', 'unknown')}) — {recommended_task.get('title', '')}"
            )
        else:
            lines.append(f"- {item.get('category', '')}: queue-only review; no prepared task selected")
        lines.append(f"  - {item.get('note', '')}")
    lines.append("")
    lines.append("## Queue review snapshots")
    lines.append("")
    for category, payload in dict(bundle.get("queues") or {}).items():
        snapshot = dict(payload.get("snapshot") or {})
        lines.append(
            f"- {category}: {snapshot.get('eligibleCandidates', 0)} eligible / "
            f"{snapshot.get('blockedCandidates', 0)} blocked / "
            f"{snapshot.get('totalCandidates', 0)} total"
        )
        if snapshot.get("preferredDifficulty"):
            lines.append(f"  - preferred difficulty: {snapshot.get('preferredDifficulty', 'unknown')}")
        if snapshot.get("summary"):
            lines.append(f"  - {snapshot.get('summary', '')}")
    lines.append("")
    lines.append("## Artifacts to inspect")
    lines.append("")
    for item in list(bundle.get("review_targets") or []):
        lines.append(f"- {item.get('title', '')}: {item.get('reason', '')}")
        for path in list(item.get("artifactPaths") or []):
            lines.append(f"  - {path}")
    lines.append("")
    lines.append("## Day 1 checklist")
    lines.append("")
    lines.append("- [ ] Capture baseline summary and daily report outputs.")
    lines.append("- [ ] Review queue exports for self-improvement, project maintenance, and owner automation.")
    lines.append("- [ ] Run at most one prepared task per category, preferring low difficulty.")
    lines.append("- [ ] Inspect `runSummary`, `testSummary`, `reviewSummary`, and `reviewQueueSummary` after each run.")
    lines.append("- [ ] Compare experiment summary and training handoff before and after bounded runs.")
    lines.append("- [ ] Record blockers, review gates, and any operator-trust concerns.")
    lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def write_engine_day1_bundle(project_root: Path, bundle: dict[str, Any], *, output_dir: Path | None = None) -> dict[str, Path]:
    target_dir = Path(output_dir or assistant_runs_dir(project_root)).expanduser().resolve()
    target_dir.mkdir(parents=True, exist_ok=True)
    json_path = target_dir / "engine_day1_bundle.json"
    markdown_path = target_dir / "engine_day1_bundle.md"
    json_path.write_text(json.dumps(bundle, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_engine_day1_bundle(bundle), encoding="utf-8")
    return {"json": json_path, "markdown": markdown_path}