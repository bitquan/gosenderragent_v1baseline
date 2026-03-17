from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any


SAFE_TASK_RULE = "review_required=false and write_confirmation_required=false"
PERFORMANCE_BASELINE_MISSING_SIGNALS = [
    "duplicate_file_edit_rate",
    "rollback_rate",
    "summary_quality_training_handoff_acceptance",
]


def _parse_iso(value: Any) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _elapsed_seconds(started_at: Any, finished_at: Any) -> float | None:
    started = _parse_iso(started_at)
    finished = _parse_iso(finished_at)
    if started is None or finished is None:
        return None
    delta = (finished - started).total_seconds()
    if delta < 0:
        return None
    return float(delta)


def _safe_rate(numerator: int | float, denominator: int | float) -> float | None:
    if not denominator:
        return None
    return float(numerator) / float(denominator)


def _median_or_none(values: list[float]) -> float | None:
    cleaned = [float(value) for value in values if value is not None]
    if not cleaned:
        return None
    return float(median(cleaned))


def _tasks_per_hour(cycle_time_seconds: float | None) -> float | None:
    if cycle_time_seconds is None or cycle_time_seconds <= 0:
        return None
    return 3600.0 / float(cycle_time_seconds)


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value or "").strip().lower()
    return text in {"1", "true", "yes", "y", "on"}


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return int(default)


def _as_float(value: Any) -> float | None:
    if value in {None, ""}:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _read_json(path: str) -> dict[str, Any]:
    target = Path(str(path or "").strip())
    if not target.exists() or not target.is_file():
        return {}
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _row_scorecard(row: dict[str, Any]) -> dict[str, Any]:
    experiment_run = dict(row.get("experiment_run") or {})
    return dict(row.get("experiment_scorecard") or experiment_run.get("scorecard") or {})


def _row_experiment_run(row: dict[str, Any]) -> dict[str, Any]:
    return dict(row.get("experiment_run") or {})


def _row_status(row: dict[str, Any]) -> str:
    experiment_run = _row_experiment_run(row)
    scorecard = _row_scorecard(row)
    return str(scorecard.get("status") or experiment_run.get("status") or "unknown").strip().lower() or "unknown"


def _row_safe_task(row: dict[str, Any]) -> bool:
    experiment_run = _row_experiment_run(row)
    metadata = dict(experiment_run.get("metadata") or {})
    if "safe_task" in metadata:
        return _as_bool(metadata.get("safe_task"))
    scorecard = _row_scorecard(row)
    return not bool(scorecard.get("review_required", False)) and not bool(scorecard.get("write_confirmation_required", False))


def _artifact_metrics(row: dict[str, Any]) -> dict[str, Any]:
    artifact = _read_json(str(row.get("run_artifact") or ""))
    if not artifact:
        return {}
    run_summary = dict(artifact.get("run_summary") or {})
    runtime_result = dict(artifact.get("runtime_result") or {})
    review_queue_summary = dict(artifact.get("review_queue_summary") or {})
    scorecard = dict(artifact.get("experiment_scorecard") or {})
    total_requests = _as_int(review_queue_summary.get("total_count"), 0)
    return {
        "cycle_time_seconds": _elapsed_seconds(
            run_summary.get("started_at") or runtime_result.get("started_at"),
            run_summary.get("finished_at") or runtime_result.get("finished_at"),
        ),
        "first_pass_validation": bool(
            _as_int(scorecard.get("validation_failed_count"), 0) == 0
            and _as_int(scorecard.get("repair_count"), _as_int(run_summary.get("repair_count"), 0)) == 0
            and _row_status(row) not in {"failed", "blocked"}
        ),
        "repair_rounds": _as_int(scorecard.get("repair_count"), _as_int(run_summary.get("repair_count"), 0)),
        "approval_queue_size": _as_int(review_queue_summary.get("pending_review_count"), 0),
        "auto_approval_rate": _safe_rate(_as_int(review_queue_summary.get("auto_approved_count"), 0), total_requests),
    }


def _row_current_metrics(row: dict[str, Any]) -> dict[str, Any]:
    experiment_run = _row_experiment_run(row)
    metadata = dict(experiment_run.get("metadata") or {})
    performance = dict(metadata.get("performance_metrics") or {})
    if performance:
        return {
            "cycle_time_seconds": _as_float(performance.get("cycle_time_seconds")),
            "first_pass_validation": _as_bool(performance.get("first_pass_validation")),
            "repair_rounds": _as_int(performance.get("repair_rounds"), 0),
            "approval_queue_size": _as_int(performance.get("approval_queue_size"), 0),
            "auto_approval_rate": _as_float(performance.get("auto_approval_rate")),
        }
    return _artifact_metrics(row)


def build_performance_baseline_scorecard(
    *,
    history_rows: list[dict[str, Any]] | None = None,
    started_at: str = "",
    finished_at: str = "",
    status: str = "unknown",
    review_required: bool = False,
    write_confirmation_required: bool = False,
    validation_failed_count: int = 0,
    repair_count: int = 0,
    review_queue_summary: dict[str, Any] | None = None,
) -> dict[str, Any]:
    safe_task = not review_required and not write_confirmation_required
    review_state = dict(review_queue_summary or {})
    total_requests = _as_int(review_state.get("total_count"), 0)
    current_cycle_time_seconds = _elapsed_seconds(started_at, finished_at)
    current_auto_approval_rate = _safe_rate(_as_int(review_state.get("auto_approved_count"), 0), total_requests)
    current = {
        "cycle_time_seconds": current_cycle_time_seconds,
        "tasks_per_hour": _tasks_per_hour(current_cycle_time_seconds),
        "first_pass_validation": bool(int(validation_failed_count or 0) == 0 and int(repair_count or 0) == 0 and str(status or "").strip().lower() not in {"failed", "blocked"}),
        "repair_rounds": int(repair_count or 0),
        "approval_queue_size": _as_int(review_state.get("pending_review_count"), 0),
        "auto_approval_rate": current_auto_approval_rate,
        "status": str(status or "unknown"),
        "review_required": bool(review_required),
        "write_confirmation_required": bool(write_confirmation_required),
    }

    safe_rows = [dict(row) for row in list(history_rows or []) if isinstance(row, dict) and _row_safe_task(row)]
    cycle_times: list[float] = []
    repair_rounds: list[float] = []
    approval_queue_sizes: list[float] = []
    auto_approval_rates: list[float] = []
    first_pass_success_count = 0
    failure_count = 0
    blocked_count = 0
    for row in safe_rows:
        metrics = _row_current_metrics(row)
        cycle_time = _as_float(metrics.get("cycle_time_seconds"))
        if cycle_time is not None:
            cycle_times.append(cycle_time)
        repair_round = _as_float(metrics.get("repair_rounds"))
        if repair_round is not None:
            repair_rounds.append(repair_round)
        approval_queue_size = _as_float(metrics.get("approval_queue_size"))
        if approval_queue_size is not None:
            approval_queue_sizes.append(approval_queue_size)
        auto_approval_rate = _as_float(metrics.get("auto_approval_rate"))
        if auto_approval_rate is not None:
            auto_approval_rates.append(auto_approval_rate)
        if _as_bool(metrics.get("first_pass_validation")):
            first_pass_success_count += 1
        row_status = _row_status(row)
        if row_status == "failed":
            failure_count += 1
        if row_status == "blocked":
            blocked_count += 1

    baseline_cycle_time_seconds = _median_or_none(cycle_times)
    baseline_tasks_per_hour = _tasks_per_hour(baseline_cycle_time_seconds)
    current_tasks_per_hour = _as_float(current.get("tasks_per_hour"))
    cycle_time_reduction_ratio = None
    if baseline_cycle_time_seconds and current_cycle_time_seconds is not None:
        cycle_time_reduction_ratio = max(-1.0, min(1.0, (baseline_cycle_time_seconds - current_cycle_time_seconds) / baseline_cycle_time_seconds))
    throughput_increase_ratio = None
    if baseline_tasks_per_hour and current_tasks_per_hour is not None:
        throughput_increase_ratio = max(-1.0, min(10.0, (current_tasks_per_hour - baseline_tasks_per_hour) / baseline_tasks_per_hour))

    baseline = {
        "sample_size": len(safe_rows),
        "metric_sample_sizes": {
            "cycle_time": len(cycle_times),
            "repair_rounds": len(repair_rounds),
            "approval_queue_size": len(approval_queue_sizes),
            "auto_approval_rate": len(auto_approval_rates),
        },
        "median_cycle_time_seconds": baseline_cycle_time_seconds,
        "safe_tasks_per_hour": baseline_tasks_per_hour,
        "first_pass_validation_rate": _safe_rate(first_pass_success_count, len(safe_rows)),
        "median_repair_rounds": _median_or_none(repair_rounds),
        "median_approval_queue_size": _median_or_none(approval_queue_sizes),
        "auto_approval_rate": _median_or_none(auto_approval_rates),
        "failure_rate": _safe_rate(failure_count, len(safe_rows)),
        "blocked_rate": _safe_rate(blocked_count, len(safe_rows)),
        "rollback_rate": None,
    }
    current_failed = str(status or "").strip().lower() == "failed"
    current_blocked = str(status or "").strip().lower() == "blocked"
    return {
        "metric_version": "v1",
        "safe_task": safe_task,
        "safe_task_rule": SAFE_TASK_RULE,
        "comparison_scope": "historical safe tasks from experiment dataset",
        "current": current,
        "baseline": baseline,
        "gain_target": {
            "cycle_time_reduction_ratio_target": 0.5,
            "throughput_increase_ratio_target": 0.5,
            "cycle_time_reduction_ratio": cycle_time_reduction_ratio,
            "throughput_increase_ratio": throughput_increase_ratio,
            "current_failed": current_failed,
            "current_blocked": current_blocked,
            "met": bool(
                not current_failed
                and not current_blocked
                and (
                    (cycle_time_reduction_ratio is not None and cycle_time_reduction_ratio >= 0.5)
                    or (throughput_increase_ratio is not None and throughput_increase_ratio >= 0.5)
                )
            ),
        },
        "missing_signals": list(PERFORMANCE_BASELINE_MISSING_SIGNALS),
    }