from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from backend.agent.core.engine_day1_support import DEFAULT_OWNER_GOALS, build_engine_day1_bundle, write_engine_day1_bundle
from backend.agent.core.storage_paths import assistant_runs_dir
from backend.agent.runtime import runtime_api


SAFE_DIFFICULTIES = {"low", "medium"}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _bundle_path(project_root: Path) -> Path:
    return assistant_runs_dir(project_root) / "engine_day1_bundle.json"


def _execution_path(project_root: Path) -> Path:
    return assistant_runs_dir(project_root) / "engine_day1_execution.json"


def _execution_markdown_path(project_root: Path) -> Path:
    return assistant_runs_dir(project_root) / "engine_day1_execution.md"


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_or_build_day1_bundle(
    project_root: Path,
    *,
    bundle_path: Path | None = None,
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
) -> tuple[dict[str, Any], Path]:
    project_root = Path(project_root).expanduser().resolve()
    selected_bundle_path = Path(bundle_path or _bundle_path(project_root)).expanduser().resolve()
    if selected_bundle_path.exists():
        return _load_json(selected_bundle_path), selected_bundle_path
    bundle = build_engine_day1_bundle(
        project_root,
        project_maintenance_root=project_maintenance_root,
        owner_automation_root=owner_automation_root,
        owner_goals=owner_goals or list(DEFAULT_OWNER_GOALS),
        baseline_lookback_hours=baseline_lookback_hours,
        daily_lookback_hours=daily_lookback_hours,
        run_limit=run_limit,
        experiment_limit=experiment_limit,
        training_limit=training_limit,
        history_limit=history_limit,
        queue_limit=queue_limit,
    )
    written = write_engine_day1_bundle(project_root, bundle, output_dir=selected_bundle_path.parent)
    return bundle, written["json"]


def _executor_for(category: str) -> tuple[str, Callable[[dict[str, Any]], dict[str, Any]]]:
    if category == "self_improvement":
        return "self-improvement-run", runtime_api.execute_self_improvement_task
    if category == "project_maintenance":
        return "project-maintenance-run", runtime_api.execute_project_maintenance_task
    if category == "owner_automation":
        return "owner-automation-run", runtime_api.execute_owner_automation_task
    raise ValueError(f"unsupported Day 1 category: {category}")


def _plan_item(bundle: dict[str, Any], category: str) -> dict[str, Any]:
    for item in list(bundle.get("bounded_run_plan") or []):
        if str(item.get("category") or "") == category:
            return dict(item)
    return {}


def _safe_selection(bundle: dict[str, Any], category: str) -> dict[str, Any]:
    item = _plan_item(bundle, category)
    recommended = dict(item.get("recommendedTask") or {})
    difficulty = str(recommended.get("difficulty") or "unknown").lower()
    target_paths = [str(path) for path in list(recommended.get("targetPaths") or []) if str(path)]
    if not recommended or not str(recommended.get("taskId") or "").strip():
        return {
            "category": category,
            "action": item.get("action") or _executor_for(category)[0],
            "attempted": False,
            "skipReason": "no safe prepared task surfaced by the Day 1 bundle",
            "selectedTask": None,
            "projectRoot": str(item.get("projectRoot") or ""),
        }
    if difficulty not in SAFE_DIFFICULTIES:
        return {
            "category": category,
            "action": item.get("action") or _executor_for(category)[0],
            "attempted": False,
            "skipReason": f"recommended task difficulty {difficulty or 'unknown'} is outside the Day 1 safe window",
            "selectedTask": recommended,
            "projectRoot": str(item.get("projectRoot") or ""),
        }
    if not target_paths:
        return {
            "category": category,
            "action": item.get("action") or _executor_for(category)[0],
            "attempted": False,
            "skipReason": "recommended task has no prepared target paths",
            "selectedTask": recommended,
            "projectRoot": str(item.get("projectRoot") or ""),
        }
    return {
        "category": category,
        "action": item.get("action") or _executor_for(category)[0],
        "attempted": True,
        "skipReason": "",
        "selectedTask": recommended,
        "projectRoot": str(item.get("projectRoot") or ""),
    }


def _trust_notes(result: dict[str, Any]) -> list[str]:
    notes: list[str] = []
    status = str(result.get("status") or "")
    review_state = dict(result.get("reviewState") or {})
    if status in {"review", "pending_review"} or bool(review_state.get("requires_manual_review")):
        notes.append("Manual review remains required before accepting this slice.")
    review_requests = list(result.get("reviewRequests") or [])
    if review_requests:
        notes.append(f"{len(review_requests)} review request(s) were recorded.")
    recommended_next_action = str(result.get("recommendedNextAction") or "").strip()
    if recommended_next_action:
        notes.append(f"Recommended next action: {recommended_next_action}.")
    return notes


def _blocker_notes(result: dict[str, Any]) -> list[str]:
    notes: list[str] = []
    status = str(result.get("status") or "")
    blocked_reason = str(result.get("blockedReason") or "").strip()
    if blocked_reason:
        notes.append(blocked_reason)
    runtime_failure = dict(result.get("runtimeFailure") or {})
    message = str(runtime_failure.get("message") or "").strip()
    if message:
        notes.append(message)
    if status == "failed":
        summary = str((result.get("testSummary") or {}).get("summary") or (result.get("runSummary") or {}).get("summary") or "").strip()
        if summary:
            notes.append(summary)
    seen: set[str] = set()
    deduped: list[str] = []
    for note in notes:
        if note and note not in seen:
            seen.add(note)
            deduped.append(note)
    return deduped


def _refresh_reports(
    project_root: Path,
    *,
    baseline_lookback_hours: int,
    daily_lookback_hours: int,
    run_limit: int,
    experiment_limit: int,
    training_limit: int,
) -> dict[str, Any]:
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
    return {
        "baseline": baseline,
        "daily_report": daily,
        "experiment_summary": experiments,
        "training_handoff": training_handoff,
    }


def _execution_record(selection: dict[str, Any], result: dict[str, Any] | None = None) -> dict[str, Any]:
    if result is None:
        return {
            "category": selection["category"],
            "action": selection["action"],
            "attempted": False,
            "status": "skipped",
            "selectedTask": selection.get("selectedTask"),
            "projectRoot": selection.get("projectRoot"),
            "skipReason": selection.get("skipReason") or "",
            "reviewState": {},
            "runSummary": {},
            "testSummary": {},
            "recommendedActions": [],
            "trustNotes": [],
            "blockerNotes": [selection.get("skipReason") or "skipped"],
            "artifactPaths": [],
        }
    return {
        "category": selection["category"],
        "action": selection["action"],
        "attempted": True,
        "status": str(result.get("status") or "unknown"),
        "selectedTask": selection.get("selectedTask"),
        "projectRoot": str(result.get("projectRoot") or selection.get("projectRoot") or ""),
        "taskId": str(result.get("taskId") or (selection.get("selectedTask") or {}).get("taskId") or ""),
        "ticket": str(result.get("ticket") or ""),
        "reviewState": dict(result.get("reviewState") or {}),
        "reviewSummary": dict(result.get("reviewSummary") or {}),
        "runSummary": dict(result.get("runSummary") or {}),
        "testSummary": dict(result.get("testSummary") or {}),
        "reviewQueueSummary": dict(result.get("reviewQueueSummary") or {}),
        "recommendedActions": [dict(item) for item in list(result.get("recommendedActions") or []) if isinstance(item, dict)],
        "recommendedNextAction": str(result.get("recommendedNextAction") or ""),
        "artifactPaths": [str(path) for path in list(result.get("artifactPaths") or []) if str(path)],
        "trustNotes": _trust_notes(result),
        "blockerNotes": _blocker_notes(result),
        "summary": str(result.get("summary") or ""),
    }


def build_engine_day1_execution(
    project_root: Path,
    *,
    bundle_path: Path | None = None,
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
    bundle, selected_bundle_path = load_or_build_day1_bundle(
        project_root,
        bundle_path=bundle_path,
        project_maintenance_root=project_maintenance_root,
        owner_automation_root=owner_automation_root,
        owner_goals=owner_goals,
        baseline_lookback_hours=baseline_lookback_hours,
        daily_lookback_hours=daily_lookback_hours,
        run_limit=run_limit,
        experiment_limit=experiment_limit,
        training_limit=training_limit,
        history_limit=history_limit,
        queue_limit=queue_limit,
    )

    owner_goal_payload = [dict(item) for item in list(bundle.get("owner_goals") or owner_goals or DEFAULT_OWNER_GOALS) if isinstance(item, dict)]
    selections = [_safe_selection(bundle, category) for category in ("self_improvement", "project_maintenance", "owner_automation")]
    execution_records: list[dict[str, Any]] = []
    artifact_paths: list[str] = [str(selected_bundle_path)]

    for selection in selections:
        if not selection.get("attempted"):
            execution_records.append(_execution_record(selection))
            continue
        action_name, executor = _executor_for(str(selection["category"]))
        selected_task = dict(selection.get("selectedTask") or {})
        payload: dict[str, Any] = {
            "taskId": str(selected_task.get("taskId") or ""),
            "historyLimit": history_limit,
            "limit": queue_limit,
            "confirm": True,
        }
        if selection["category"] == "self_improvement":
            payload["repair"] = False
        else:
            payload["projectRoot"] = selection.get("projectRoot") or str(project_root)
        if selection["category"] == "owner_automation":
            payload["ownerGoals"] = owner_goal_payload

        result = executor(payload)
        record = _execution_record({**selection, "action": action_name}, result)
        execution_records.append(record)
        for path in list(result.get("artifactPaths") or []):
            text = str(path or "")
            if text and text not in artifact_paths:
                artifact_paths.append(text)

    post_run = _refresh_reports(
        project_root,
        baseline_lookback_hours=baseline_lookback_hours,
        daily_lookback_hours=daily_lookback_hours,
        run_limit=run_limit,
        experiment_limit=experiment_limit,
        training_limit=training_limit,
    )
    for result in post_run.values():
        for path in list(result.get("artifactPaths") or []):
            text = str(path or "")
            if text and text not in artifact_paths:
                artifact_paths.append(text)

    blocker_notes: list[str] = []
    trust_notes: list[str] = []
    status_counts: dict[str, int] = {}
    executed_count = 0
    skipped_count = 0
    for record in execution_records:
        status = str(record.get("status") or "unknown")
        status_counts[status] = int(status_counts.get(status, 0)) + 1
        if bool(record.get("attempted")):
            executed_count += 1
        else:
            skipped_count += 1
        for note in list(record.get("blockerNotes") or []):
            if note and note not in blocker_notes:
                blocker_notes.append(note)
        for note in list(record.get("trustNotes") or []):
            if note and note not in trust_notes:
                trust_notes.append(note)

    execution = {
        "generated_at": _utc_now(),
        "project_root": str(project_root),
        "bundle_path": str(selected_bundle_path),
        "owner_goals": owner_goal_payload,
        "policy": {
            "max_tasks_per_slice": 1,
            "allowed_difficulties": sorted(SAFE_DIFFICULTIES),
            "followup_execution": False,
            "self_improvement_repair": False,
            "looping": False,
        },
        "selection_summary": selections,
        "execution_records": execution_records,
        "post_run": post_run,
        "execution_summary": {
            "executed_count": executed_count,
            "skipped_count": skipped_count,
            "status_counts": status_counts,
        },
        "trust_notes": trust_notes,
        "blocker_notes": blocker_notes,
        "artifact_paths": artifact_paths,
    }
    return execution


def render_engine_day1_execution(execution: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append("# Engine Test Week Day 1 Execution")
    lines.append("")
    lines.append(f"Generated: {execution.get('generated_at', '')}")
    lines.append(f"Bundle: {execution.get('bundle_path', '')}")
    lines.append("")
    lines.append("## Safe execution analysis")
    lines.append("")
    lines.append("- Uses task IDs surfaced by the Day 1 bundle only.")
    lines.append("- Executes at most one prepared task per slice.")
    lines.append("- Only low or medium difficulty tasks are allowed.")
    lines.append("- Self-improvement runs disable repair follow-up for Day 1 safety.")
    lines.append("- Existing review, approval, sandbox, and target boundary protections stay inside the runtime API.")
    lines.append("")
    lines.append("## Slice execution results")
    lines.append("")
    for record in list(execution.get("execution_records") or []):
        title = str(record.get("category") or "")
        task = dict(record.get("selectedTask") or {})
        status = str(record.get("status") or "unknown")
        if bool(record.get("attempted")):
            lines.append(
                f"- {title}: {status} — {record.get('taskId', task.get('taskId', ''))} "
                f"({task.get('difficulty', 'unknown')})"
            )
        else:
            lines.append(f"- {title}: skipped — {record.get('skipReason', '')}")
        summary = str((record.get("runSummary") or {}).get("summary") or (record.get("testSummary") or {}).get("summary") or record.get("summary") or "").strip()
        if summary:
            lines.append(f"  - {summary}")
        for note in list(record.get("trustNotes") or []):
            lines.append(f"  - trust: {note}")
        for note in list(record.get("blockerNotes") or []):
            lines.append(f"  - blocker: {note}")
    lines.append("")
    lines.append("## Post-run reporting refresh")
    lines.append("")
    post_run = dict(execution.get("post_run") or {})
    for key in ("baseline", "daily_report", "experiment_summary", "training_handoff"):
        result = dict(post_run.get(key) or {})
        if not result:
            continue
        lines.append(f"- {key}: {result.get('summary', '')}")
        for path in list(result.get("artifactPaths") or []):
            lines.append(f"  - {path}")
    lines.append("")
    lines.append("## Final notes")
    lines.append("")
    for note in list(execution.get("trust_notes") or []):
        lines.append(f"- trust: {note}")
    for note in list(execution.get("blocker_notes") or []):
        lines.append(f"- blocker: {note}")
    lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def write_engine_day1_execution(project_root: Path, execution: dict[str, Any], *, output_dir: Path | None = None) -> dict[str, Path]:
    target_dir = Path(output_dir or assistant_runs_dir(project_root)).expanduser().resolve()
    target_dir.mkdir(parents=True, exist_ok=True)
    json_path = target_dir / _execution_path(project_root).name
    markdown_path = target_dir / _execution_markdown_path(project_root).name
    json_path.write_text(json.dumps(execution, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_engine_day1_execution(execution), encoding="utf-8")
    return {"json": json_path, "markdown": markdown_path}