from __future__ import annotations

from collections import Counter
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from backend.agent.core.baseline_service import analyze_baseline_health, cluster_failures, is_runtime_execution_run, load_recent_runs
from backend.agent.core.storage_paths import (
    assistant_experiment_dataset_path,
    assistant_runs_dir,
    assistant_self_improvement_history_path,
    assistant_training_output_path,
)


_TASK_HUB_FILE_NAME = "task-hub.json"
_SELF_IMPROVEMENT_SAFE_STATUSES = {"succeeded", "review"}


def _parse_iso(value: Any) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _normalize_checks(run: dict[str, Any]) -> list[dict[str, Any]]:
    checks = run.get("checks")
    if isinstance(checks, list):
        return [item for item in checks if isinstance(item, dict)]
    validation = run.get("validation")
    if isinstance(validation, list):
        return [item for item in validation if isinstance(item, dict)]
    return []


def _safe_rate(numerator: int | float, denominator: int | float) -> float:
    return float(numerator) / float(denominator) if denominator else 0.0


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    try:
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = str(raw_line or "").strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except Exception:
                continue
            if isinstance(payload, dict):
                rows.append(payload)
    except Exception:
        return []
    return rows


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _filter_recent_rows(rows: list[dict[str, Any]], *, lookback_hours: int, limit: int) -> list[dict[str, Any]]:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max(1, lookback_hours))
    selected: list[tuple[datetime, dict[str, Any]]] = []
    for row in rows:
        timestamp = _parse_iso(row.get("timestamp"))
        if timestamp is None:
            experiment_run = dict(row.get("experiment_run") or {})
            timestamp = _parse_iso(experiment_run.get("timestamp"))
        if timestamp is None or timestamp < cutoff:
            continue
        selected.append((timestamp, row))
    selected.sort(key=lambda item: item[0], reverse=True)
    return [row for _timestamp, row in selected[: max(1, limit)]]


def _local_day_key(timestamp: datetime | None = None) -> str:
    moment = (timestamp or datetime.now(timezone.utc)).astimezone()
    return moment.date().isoformat()


def _is_daily_focus_entity(item: dict[str, Any]) -> bool:
    metadata = dict(item.get("metadata") or {})
    signature = str(metadata.get("followupSignature") or "").strip().lower()
    return bool(
        metadata.get("dailyTask") is True
        or signature.startswith("daily-task:")
    )


def _task_timestamp(task: dict[str, Any]) -> datetime | None:
    return _parse_iso(task.get("updatedAt")) or _parse_iso(task.get("createdAt"))


def _matches_roadmap_day(task: dict[str, Any], roadmap_day: str) -> bool:
    target_day = str(roadmap_day or "").strip()
    if not target_day:
        return False
    metadata = dict(task.get("metadata") or {})
    metadata_day = str(metadata.get("roadmapDay") or "").strip()
    if metadata_day:
        return metadata_day == target_day
    timestamp = _task_timestamp(task)
    return _local_day_key(timestamp) == target_day if timestamp is not None else False


def _is_blocked_or_rescoped_task(task: dict[str, Any]) -> bool:
    metadata = dict(task.get("metadata") or {})
    status = str(task.get("status") or "").strip().lower()
    return bool(
        status in {"needs-rescope", "blocked"}
        or str(metadata.get("lastBlockedBy") or "").strip()
        or str(metadata.get("lastBlockedReason") or "").strip()
    )


def _artifact_success(run: dict[str, Any]) -> bool:
    terminal_state = _artifact_terminal_state(run)
    scorecard = dict(run.get("experiment_scorecard") or {})
    if scorecard:
        if "success" in scorecard:
            return bool(scorecard.get("success"))
        if terminal_state:
            return terminal_state in {"succeeded", "success", "passed", "pass", "ok", "completed", "complete"}
    if "all_checks_passed" in run:
        return bool(run.get("all_checks_passed"))
    if terminal_state:
        return terminal_state in {"succeeded", "success", "passed", "pass", "ok", "completed", "complete"}
    checks = _normalize_checks(run)
    if checks:
        return all(item.get("ok") is not False for item in checks)
    return False


def _artifact_terminal_state(run: dict[str, Any]) -> str:
    for source in (
        dict(run.get("experiment_scorecard") or {}),
        dict(run.get("run_summary") or {}),
        run,
    ):
        for key in ("final_state", "status", "state"):
            value = str(source.get(key) or "").strip().lower()
            if value:
                return value
    return ""


def _artifact_review_requested(run: dict[str, Any]) -> bool:
    review_summary = dict(run.get("review_queue_summary") or {})
    if not review_summary:
        owner_summary = dict(run.get("owner_summary") or {})
        review_summary = dict(owner_summary.get("review_queue_summary") or {})
    if review_summary:
        if bool(review_summary.get("requires_manual_review")):
            return True
        if int(review_summary.get("pending_review_count") or 0) > 0:
            return True
        if int(review_summary.get("total_count") or 0) > 0:
            return True
    scorecard = dict(run.get("experiment_scorecard") or {})
    if bool(scorecard.get("review_required", False)):
        return True
    return _artifact_terminal_state(run) in {"pending_review", "approved", "rejected", "deferred"}


def _artifact_repair_count(run: dict[str, Any]) -> int:
    scorecard = dict(run.get("experiment_scorecard") or {})
    if scorecard:
        return int(scorecard.get("repair_count") or 0)
    run_summary = dict(run.get("run_summary") or {})
    if run_summary:
        return int(run_summary.get("repair_count") or 0)
    repair = dict(run.get("repair") or {})
    repairs = repair.get("repairs")
    if isinstance(repairs, list):
        return len([item for item in repairs if isinstance(item, dict)])
    return 0


def _normalize_label(text: Any) -> str:
    return " ".join(str(text or "").strip().lower().split())


def _counter_add(counter: Counter[str], display: dict[str, str], text: Any, increment: int = 1) -> None:
    label = str(text or "").strip()
    normalized = _normalize_label(label)
    if not normalized:
        return
    counter[normalized] += int(increment)
    display.setdefault(normalized, label)


def _iter_artifact_recommended_actions(run: dict[str, Any]) -> list[str]:
    labels: list[str] = []
    owner_summary = dict(run.get("owner_summary") or {})
    recommended_actions = list(owner_summary.get("recommended_actions") or run.get("recommended_actions") or [])
    for item in recommended_actions:
        if not isinstance(item, dict):
            continue
        label = str(item.get("title") or item.get("action_type") or item.get("reason") or "").strip()
        if label:
            labels.append(label)
    critique = dict(run.get("critique") or {})
    for item in list(critique.get("next_actions") or []):
        label = str(item or "").strip()
        if label:
            labels.append(label)
    benchmark_summary = dict(run.get("experiment_benchmark_summary") or {})
    if benchmark_summary.get("recommended_next_action"):
        labels.append(str(benchmark_summary.get("recommended_next_action") or ""))
    owner_experiment_summary = dict(run.get("owner_experiment_summary") or {})
    if owner_experiment_summary.get("recommended_next_action"):
        labels.append(str(owner_experiment_summary.get("recommended_next_action") or ""))
    training_handoff = dict(run.get("training_handoff") or {})
    if training_handoff.get("recommended_focus"):
        labels.append(str(training_handoff.get("recommended_focus") or ""))
    deduped: list[str] = []
    seen: set[str] = set()
    for label in labels:
        normalized = _normalize_label(label)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(label)
    return deduped


def _parse_training_next_actions(row: dict[str, Any]) -> list[str]:
    completion = str(row.get("completion") or "")
    if not completion.strip():
        return []
    actions: list[str] = []
    in_section = False
    for raw_line in completion.splitlines():
        line = str(raw_line or "").rstrip()
        stripped = line.strip()
        if not stripped:
            if in_section:
                break
            continue
        if stripped.lower() == "next actions:":
            in_section = True
            continue
        if in_section and stripped.endswith(":") and not stripped.startswith("-"):
            break
        if in_section and stripped.startswith("-"):
            action = stripped.lstrip("-").strip()
            if action:
                actions.append(action)
    return actions


def _top_counter_rows(counter: Counter[str], display: dict[str, str], *, limit: int = 5) -> list[dict[str, Any]]:
    return [
        {"label": display.get(label, label), "count": count}
        for label, count in counter.most_common(max(1, limit))
    ]


def _build_daily_quota_proof(
    project_root: Path,
    runtime_runs: list[dict[str, Any]],
    *,
    roadmap_day: str | None = None,
) -> dict[str, Any]:
    active_day = str(roadmap_day or _local_day_key()).strip() or _local_day_key()
    task_hub = _load_json(assistant_runs_dir(project_root) / _TASK_HUB_FILE_NAME)
    tasks = [dict(item) for item in list(task_hub.get("tasks") or []) if isinstance(item, dict)]
    daily_tasks = [task for task in tasks if _is_daily_focus_entity(task)]
    focus_candidates = [task for task in daily_tasks if _matches_roadmap_day(task, active_day)]
    focus_candidates.sort(
        key=lambda item: (
            1 if str(item.get("status") or "").strip().lower() in {"completed", "cancelled", "done", "archived"} else 0,
            -((_task_timestamp(item) or datetime.fromtimestamp(0, timezone.utc)).timestamp()),
        )
    )
    focus_task = focus_candidates[0] if focus_candidates else {}
    blocked_rescoped = [
        task
        for task in tasks
        if _matches_roadmap_day(task, active_day) and _is_blocked_or_rescoped_task(task)
    ]
    blocked_rescoped.sort(
        key=lambda item: -((_task_timestamp(item) or datetime.fromtimestamp(0, timezone.utc)).timestamp())
    )

    runtime_today = [
        run
        for run in runtime_runs
        if _local_day_key(_parse_iso(run.get("endedAt")) or _parse_iso(run.get("startedAt")) or datetime.now(timezone.utc)) == active_day
    ]
    autonomous_safe_count = sum(
        1
        for run in runtime_today
        if _artifact_success(run) and not _artifact_review_requested(run)
    )
    validation_pass_count = sum(1 for run in runtime_today if _artifact_success(run))
    validation_fail_count = sum(
        1
        for run in runtime_today
        if _artifact_terminal_state(run) in {"failed", "fail", "rejected", "cancelled", "canceled"}
    )
    review_blocked_count = sum(1 for run in runtime_today if _artifact_review_requested(run))

    self_improvement_history = _load_jsonl(assistant_self_improvement_history_path(project_root))
    self_improvement_today = [
        row
        for row in self_improvement_history
        if _local_day_key(_parse_iso(row.get("timestamp")) or datetime.now(timezone.utc)) == active_day
    ]
    self_improvement_safe_count = sum(
        1
        for row in self_improvement_today
        if str(row.get("status") or "").strip().lower() in _SELF_IMPROVEMENT_SAFE_STATUSES
    )

    do_not_widen_reason = ""
    if blocked_rescoped:
        do_not_widen_reason = (
            f"Do not widen yet because {len(blocked_rescoped)} task(s) are still blocked or need rescope in today's task hub focus."
        )
    elif autonomous_safe_count < 5:
        do_not_widen_reason = (
            f"Do not widen yet because safe autonomous progress is {autonomous_safe_count}/5 today."
        )
    elif self_improvement_safe_count < 5:
        do_not_widen_reason = (
            f"Do not widen yet because safe self-improvement progress is {self_improvement_safe_count}/5 today."
        )
    elif validation_fail_count > 0:
        do_not_widen_reason = "Do not widen yet because validation is still failing today."
    elif not focus_task:
        do_not_widen_reason = "Do not widen yet because today's focus task is missing from the task hub."

    return {
        "roadmap_day": active_day,
        "focus_task": {
            "task_id": str(focus_task.get("id") or "").strip(),
            "goal_id": str(focus_task.get("goalId") or "").strip(),
            "title": str(focus_task.get("title") or focus_task.get("objective") or "").strip(),
            "status": str(focus_task.get("status") or "").strip().lower(),
            "updated_at": str(focus_task.get("updatedAt") or "").strip(),
        }
        if focus_task
        else {},
        "autonomous": {
            "target": 5,
            "safe_count": autonomous_safe_count,
            "met": autonomous_safe_count >= 5,
        },
        "self_improvement": {
            "target": 5,
            "safe_count": self_improvement_safe_count,
            "met": self_improvement_safe_count >= 5,
        },
        "blocked_rescoped_count": len(blocked_rescoped),
        "validation": {
            "pass_count": validation_pass_count,
            "fail_count": validation_fail_count,
            "review_blocked_count": review_blocked_count,
        },
        "do_not_widen_yet_because": do_not_widen_reason,
    }


def _model_variant_counts(rows: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    profile_counts: Counter[str] = Counter()
    base_model_counts: Counter[str] = Counter()
    task_mode_counts: Counter[str] = Counter()
    provider_source_counts: Counter[str] = Counter()
    for row in rows:
        experiment_run = dict(row.get("experiment_run") or {})
        metadata = dict(experiment_run.get("metadata") or row.get("metadata") or {})
        for key, counter in (
            ("model_profile_id", profile_counts),
            ("base_model", base_model_counts),
            ("task_mode", task_mode_counts),
            ("provider_source", provider_source_counts),
        ):
            value = str(
                metadata.get(key)
                or metadata.get("".join(part.title() if index else part for index, part in enumerate(key.split("_"))))
                or row.get(key)
                or ""
            ).strip()
            if value:
                counter[value] += 1
    return {
        "model_profile_counts": dict(profile_counts),
        "base_model_counts": dict(base_model_counts),
        "task_mode_counts": dict(task_mode_counts),
        "provider_source_counts": dict(provider_source_counts),
    }


def build_engine_baseline_summary(
    project_root: Path,
    *,
    lookback_hours: int = 72,
    run_limit: int = 40,
    experiment_limit: int = 80,
    training_limit: int = 120,
) -> dict[str, Any]:
    recent_runs = load_recent_runs(project_root, lookback_hours=lookback_hours, limit=run_limit)
    runtime_runs = [run for run in recent_runs if is_runtime_execution_run(run, artifact_name=str(run.get("_artifact_name") or ""))]
    failure_clusters = cluster_failures(recent_runs)
    baseline = analyze_baseline_health(recent_runs, failure_clusters)

    experiment_dataset_path = assistant_experiment_dataset_path(project_root)
    experiment_rows = _filter_recent_rows(
        _load_jsonl(experiment_dataset_path),
        lookback_hours=lookback_hours,
        limit=experiment_limit,
    )

    training_output_path = assistant_training_output_path(project_root)
    training_rows = _load_jsonl(training_output_path)[: max(1, training_limit)] if training_output_path.exists() else []

    success_count = sum(1 for run in runtime_runs if _artifact_success(run))
    review_request_count = sum(1 for run in runtime_runs if _artifact_review_requested(run))
    repair_attempt_count = sum(_artifact_repair_count(run) for run in runtime_runs)
    repair_run_count = sum(1 for run in runtime_runs if _artifact_repair_count(run) > 0)

    fingerprint_counter: Counter[str] = Counter()
    fingerprint_display: dict[str, str] = {}
    for cluster in failure_clusters:
        _counter_add(
            fingerprint_counter,
            fingerprint_display,
            cluster.get("summary") or cluster.get("signature") or "runtime failure",
            int(cluster.get("occurrences") or 0),
        )
    for row in experiment_rows:
        experiment_run = dict(row.get("experiment_run") or {})
        training_signals = dict(experiment_run.get("training_signals") or {})
        for label in list(training_signals.get("validation_fingerprints") or []):
            _counter_add(fingerprint_counter, fingerprint_display, label, 1)

    recommended_counter: Counter[str] = Counter()
    recommended_display: dict[str, str] = {}
    for run in recent_runs:
        for label in _iter_artifact_recommended_actions(run):
            _counter_add(recommended_counter, recommended_display, label, 1)
    for row in training_rows:
        for label in _parse_training_next_actions(row):
            _counter_add(recommended_counter, recommended_display, label, 1)

    experiment_review_required_count = 0
    for row in experiment_rows:
        scorecard = dict(row.get("experiment_scorecard") or {})
        if bool(scorecard.get("review_required", False)):
            experiment_review_required_count += 1
    model_variant_counts = _model_variant_counts(experiment_rows)
    daily_quota_proof = _build_daily_quota_proof(project_root, runtime_runs)

    artifact_training_rows = 0
    for row in training_rows:
        prompt = str(row.get("prompt") or "")
        if prompt.startswith("Implement BAT<"):
            artifact_training_rows += 1

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "project_root": str(project_root),
        "window": {
            "lookback_hours": int(lookback_hours),
            "run_limit": int(run_limit),
            "experiment_limit": int(experiment_limit),
            "training_limit": int(training_limit),
        },
        "baseline": baseline,
        "runtime": {
            "run_count": len(runtime_runs),
            "success_count": success_count,
            "success_rate": _safe_rate(success_count, len(runtime_runs)),
            "review_request_count": review_request_count,
            "review_request_rate": _safe_rate(review_request_count, len(runtime_runs)),
            "repair_attempt_count": repair_attempt_count,
            "repair_run_count": repair_run_count,
            "average_repair_attempts_per_run": _safe_rate(repair_attempt_count, len(runtime_runs)),
            "has_true_execution_runs": bool(runtime_runs),
        },
        "experiments": {
            "dataset_path": str(experiment_dataset_path),
            "row_count": len(experiment_rows),
            "review_required_count": experiment_review_required_count,
            "review_required_rate": _safe_rate(experiment_review_required_count, len(experiment_rows)),
            **model_variant_counts,
        },
        "training": {
            "dataset_path": str(training_output_path),
            "row_count": len(training_rows),
            "artifact_example_count": artifact_training_rows,
            "log_example_count": max(0, len(training_rows) - artifact_training_rows),
        },
        "daily_quota_proof": daily_quota_proof,
        "common_failure_fingerprints": _top_counter_rows(fingerprint_counter, fingerprint_display, limit=6),
        "common_recommended_actions": _top_counter_rows(recommended_counter, recommended_display, limit=6),
    }


def render_engine_baseline_summary(summary: dict[str, Any]) -> str:
    runtime = dict(summary.get("runtime") or {})
    baseline = dict(summary.get("baseline") or {})
    experiments = dict(summary.get("experiments") or {})
    training = dict(summary.get("training") or {})
    daily_quota_proof = dict(summary.get("daily_quota_proof") or {})
    fingerprints = [dict(item) for item in list(summary.get("common_failure_fingerprints") or []) if isinstance(item, dict)]
    actions = [dict(item) for item in list(summary.get("common_recommended_actions") or []) if isinstance(item, dict)]

    def _percent(value: Any) -> str:
        return f"{float(value or 0.0) * 100:.1f}%"

    lines = [
        "# Engine Baseline Summary",
        "",
        f"- Generated: {summary.get('generated_at', '')}",
        f"- Project root: {summary.get('project_root', '')}",
        f"- Window: last {dict(summary.get('window') or {}).get('lookback_hours', 0)}h",
        "",
        "## Baseline State",
        "",
        f"- State: {baseline.get('state', 'unknown')}",
        f"- Blocked: {baseline.get('blocked', False)}",
        f"- Reason: {baseline.get('reason', 'n/a')}",
        f"- Active recent failures: {baseline.get('recentFailureCount', 0)}",
        "",
        "## Runtime Baseline",
        "",
        f"- Runs analyzed: {runtime.get('run_count', 0)}",
        f"- Success rate: {_percent(runtime.get('success_rate', 0.0))} ({runtime.get('success_count', 0)}/{runtime.get('run_count', 0)})",
        f"- Review request rate: {_percent(runtime.get('review_request_rate', 0.0))} ({runtime.get('review_request_count', 0)}/{runtime.get('run_count', 0)})",
        f"- Executed repair attempts: {runtime.get('repair_attempt_count', 0)} total across {runtime.get('repair_run_count', 0)} repaired runs",
        f"- Average executed repairs per analyzed run: {float(runtime.get('average_repair_attempts_per_run', 0.0)):.2f}",
        "",
        "## Daily Quota Proof",
        "",
        f"- Focus task: {dict(daily_quota_proof.get('focus_task') or {}).get('title', '') or 'none recorded'}",
        f"- Safe autonomous actions today: {dict(daily_quota_proof.get('autonomous') or {}).get('safe_count', 0)}/{dict(daily_quota_proof.get('autonomous') or {}).get('target', 5)}",
        f"- Safe self-improvement today: {dict(daily_quota_proof.get('self_improvement') or {}).get('safe_count', 0)}/{dict(daily_quota_proof.get('self_improvement') or {}).get('target', 5)}",
        f"- Blocked or rescoped tasks today: {daily_quota_proof.get('blocked_rescoped_count', 0)}",
        f"- Validation today: {dict(daily_quota_proof.get('validation') or {}).get('pass_count', 0)} pass / {dict(daily_quota_proof.get('validation') or {}).get('fail_count', 0)} fail / {dict(daily_quota_proof.get('validation') or {}).get('review_blocked_count', 0)} review-held",
        f"- Do not widen yet because: {daily_quota_proof.get('do_not_widen_yet_because', '') or 'daily quota proof is currently clear'}",
        "",
        "## Common Failure Fingerprints",
        "",
    ]
    if not bool(runtime.get("has_true_execution_runs", False)):
        lines.insert(lines.index("## Common Failure Fingerprints") - 1, "- No true execution runs found in the selected window.")
        lines.insert(lines.index("## Common Failure Fingerprints") - 1, "")
    if fingerprints:
        lines.extend(f"- {item.get('label', '')}: {item.get('count', 0)}" for item in fingerprints)
    else:
        lines.append("- none observed in the selected window")

    lines.extend(["", "## Common Recommended Actions", ""])
    if actions:
        lines.extend(f"- {item.get('label', '')}: {item.get('count', 0)}" for item in actions)
    else:
        lines.append("- none observed in the selected window")

    lines.extend(
        [
            "",
            "## Experiment And Training Signals",
            "",
            f"- Experiment rows analyzed: {experiments.get('row_count', 0)}",
            f"- Experiment review-required rate: {_percent(experiments.get('review_required_rate', 0.0))}",
            f"- Training rows analyzed: {training.get('row_count', 0)}",
            f"- Artifact-backed training rows: {training.get('artifact_example_count', 0)}",
            f"- Log-backed training rows: {training.get('log_example_count', 0)}",
        ]
    )
    return "\n".join(lines) + "\n"


def write_engine_baseline_summary(
    project_root: Path,
    summary: dict[str, Any],
    *,
    output_dir: Path | None = None,
    write_canonical_markdown: bool = True,
) -> dict[str, Path]:
    target_dir = output_dir or assistant_runs_dir(project_root)
    target_dir.mkdir(parents=True, exist_ok=True)
    json_path = target_dir / "engine_baseline_summary.json"
    md_path = target_dir / "engine_baseline_summary.md"
    json_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    markdown = render_engine_baseline_summary(summary)
    md_path.write_text(markdown, encoding="utf-8")
    written = {"json": json_path, "markdown": md_path}
    if write_canonical_markdown:
        canonical_md_path = project_root / "docs" / "ENGINE_BASELINE.md"
        canonical_md_path.parent.mkdir(parents=True, exist_ok=True)
        canonical_md_path.write_text(markdown, encoding="utf-8")
        written["canonical_markdown"] = canonical_md_path
    return written


__all__ = [
    "build_engine_baseline_summary",
    "render_engine_baseline_summary",
    "write_engine_baseline_summary",
]
