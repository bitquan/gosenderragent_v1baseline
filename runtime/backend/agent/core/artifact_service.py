from __future__ import annotations

from collections import Counter
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.agent.core.baseline_service import analyze_baseline_health, cluster_failures, load_recent_runs
from backend.agent.core.config_loader import load_project_config
from backend.agent.core.failure_taxonomy import describe_failure_label, summarize_failure_taxonomy
from backend.agent.core.memory_service import load_memory, summarize_failure_patterns
from backend.agent.core.repo_inspection import build_repo_index, iter_repo_files
from backend.agent.core.storage_paths import assistant_dev_runs_dir, assistant_experiment_dataset_path, assistant_experiment_exports_dir, assistant_experiments_dir, assistant_owner_automation_dir, assistant_owner_automation_history_path, assistant_owner_automation_queue_path, assistant_project_maintenance_dir, assistant_project_maintenance_history_path, assistant_project_maintenance_profile_path, assistant_project_maintenance_queue_path, assistant_repo_index_path, assistant_runs_dir, assistant_self_improvement_dir, assistant_self_improvement_history_path, assistant_self_improvement_queue_path, assistant_self_improvement_seed_path
from backend.agent.runtime.contracts import build_experiment_benchmark_summary, build_owner_automation_candidate, build_owner_automation_queue_summary, build_owner_automation_recommendation, build_owner_automation_task, build_owner_experiment_summary, build_owner_goal, build_owner_goal_plan, build_project_health_summary, build_project_maintenance_candidate, build_project_maintenance_queue_summary, build_project_maintenance_recommendation, build_project_maintenance_task, build_project_profile, build_runtime_task, build_self_improvement_candidate, build_self_improvement_queue_summary, build_self_improvement_recommendation, build_self_improvement_task, build_training_handoff
from backend.scripts.solo_dev_assistant_config import ASSISTANT_SELF_PATH_PREFIXES


SELF_IMPROVEMENT_TASK_LIMIT = 5
SELF_IMPROVEMENT_DAILY_TARGET = 5
PROJECT_MAINTENANCE_TASK_LIMIT = 3
OWNER_AUTOMATION_TASK_LIMIT = 4
_CONFIG_SUFFIXES = {".json", ".toml", ".ini", ".cfg", ".yaml", ".yml", ".env"}
_SOURCE_SUFFIXES = {".py", ".js", ".jsx", ".ts", ".tsx"}
_OWNER_AUTOMATION_CATEGORIES = {
    "maintenance",
    "documentation",
    "testing",
    "cleanup",
    "scaffolding",
    "analysis/reporting",
}
_ENTRY_POINT_NAMES = {
    "README.md",
    "backend/app/main.py",
    "backend/main.py",
    "app/main.py",
    "app/api/main.py",
    "frontend/package.json",
    "frontend/index.html",
    "package.json",
    "manage.py",
}
_DIFFICULTY_LEVELS = ("low", "medium", "high")
_TESTING_WEEK_PREFERRED_DIFFICULTY = "low"
_DIFFICULTY_SCORE_NUDGES = {
    "low": 10.0,
    "medium": 0.0,
    "high": -8.0,
}
_SELF_IMPROVEMENT_RECENT_DUPLICATE_PENALTIES = {
    "succeeded": 18.0,
    "review": 18.0,
    "failed": 12.0,
    "blocked": 12.0,
}
_SELF_IMPROVEMENT_SAFE_STATUSES = {"succeeded", "review"}


def _extract_agent_routes(payload: dict[str, Any]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for key in ("agent_routes", "agentRoutes", "model_routing", "modelRouting"):
        raw = payload.get(key)
        if isinstance(raw, list):
            for item in raw:
                if isinstance(item, dict):
                    candidates.append(item)
        elif isinstance(raw, dict):
            for lane, item in raw.items():
                if isinstance(item, dict):
                    candidates.append({"agent": lane, **item})
    runtime_result = payload.get("runtime_result") or payload.get("runtimeResult")
    if isinstance(runtime_result, dict):
        route_snapshot = runtime_result.get("agent_route_snapshot") or runtime_result.get("agentRouteSnapshot")
        if isinstance(route_snapshot, list):
            for item in route_snapshot:
                if isinstance(item, dict):
                    candidates.append(item)
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in candidates:
        agent = str(item.get("agent") or item.get("role") or item.get("lane") or item.get("stage") or "").strip()
        provider = str(item.get("provider") or item.get("provider_name") or item.get("providerName") or "").strip()
        model = str(item.get("model") or item.get("model_name") or item.get("modelName") or "").strip()
        if not agent and not provider and not model:
            continue
        key = f"{agent}|{provider}|{model}"
        if key in seen:
            continue
        seen.add(key)
        normalized.append({
            "agent": agent,
            "provider": provider,
            "model": model,
            "stage": str(item.get("stage") or "").strip(),
            "source": str(item.get("source") or item.get("route_source") or item.get("routeSource") or "").strip(),
        })
    return normalized


def _build_operator_proof_bundle(payload: dict[str, Any]) -> dict[str, Any]:
    owner_summary = dict(payload.get("owner_summary") or {})
    run_summary = dict(owner_summary.get("run_summary") or payload.get("run_summary") or {})
    test_summary = dict(owner_summary.get("test_summary") or payload.get("test_summary") or {})
    review_queue = dict(owner_summary.get("review_queue_summary") or payload.get("review_queue_summary") or {})
    artifact_paths = [str(path) for path in list(owner_summary.get("artifact_paths") or payload.get("artifact_paths") or []) if str(path)]
    changed_file_count = int(run_summary.get("created_file_count") or 0)
    execution_result_count = int(run_summary.get("execution_result_count") or 0)
    passed_count = int(test_summary.get("passed_count") or 0)
    failed_count = int(test_summary.get("failed_count") or 0)
    command_count = int(test_summary.get("command_count") or 0)
    pending_review_count = int(review_queue.get("pending_review_count") or 0)
    approval_request_count = int(review_queue.get("approval_request_count") or 0)
    routes = _extract_agent_routes(payload)
    provider_names = sorted({str(item.get("provider") or "").strip() for item in routes if str(item.get("provider") or "").strip()})
    model_names = sorted({str(item.get("model") or "").strip() for item in routes if str(item.get("model") or "").strip()})
    final_state = str(run_summary.get("final_state") or payload.get("final_state") or payload.get("finalState") or "").strip()
    status = str(run_summary.get("status") or payload.get("status") or "").strip()
    proof_ready = bool(artifact_paths or execution_result_count > 0 or command_count > 0 or changed_file_count > 0)
    summary_parts = []
    if changed_file_count > 0:
        summary_parts.append(f"{changed_file_count} changed file(s)")
    if command_count > 0:
        summary_parts.append(f"{command_count} test command(s)")
    if approval_request_count > 0 or pending_review_count > 0:
        summary_parts.append(f"{approval_request_count + pending_review_count} approval/review item(s)")
    if artifact_paths:
        summary_parts.append(f"{len(artifact_paths)} artifact(s)")
    visibility_summary = ", ".join(summary_parts) if summary_parts else "No operator proof artifacts were captured yet."
    return {
        "status": status,
        "final_state": final_state,
        "proof_ready": proof_ready,
        "changed_file_count": changed_file_count,
        "execution_result_count": execution_result_count,
        "test_command_count": command_count,
        "passed_test_count": passed_count,
        "failed_test_count": failed_count,
        "pending_review_count": pending_review_count,
        "approval_request_count": approval_request_count,
        "artifact_count": len(artifact_paths),
        "artifact_paths": artifact_paths[:8],
        "providers": provider_names,
        "models": model_names,
        "agent_routes": routes,
        "summary": visibility_summary,
    }


def runs_dir(project_root: Path) -> Path:
    return assistant_dev_runs_dir(project_root)


def _payload_datetime(payload: dict[str, Any]) -> datetime:
    timestamp = str(payload.get("timestamp") or "").strip()
    if timestamp:
        normalized = timestamp.replace("Z", "+00:00")
        try:
            return datetime.fromisoformat(normalized)
        except ValueError:
            pass
    return datetime.now(timezone.utc)


def build_run_artifact_path(project_root: Path, payload: dict[str, Any]) -> Path:
    moment = _payload_datetime(payload)
    mode = payload.get("mode", "run")
    ticket = payload.get("ticket", "unknown")
    name = f"{moment.strftime('%Y%m%dT%H%M%S')}-{mode}-{ticket}.json"
    return runs_dir(project_root) / name


def write_run_artifact(project_root: Path, payload: dict[str, Any], *, target: Path | None = None) -> Path | None:
    try:
        base = runs_dir(project_root)
        base.mkdir(parents=True, exist_ok=True)
    except Exception:
        return None

    timestamp = payload.get("timestamp") or _payload_datetime(payload).isoformat()
    resolved_target = target or build_run_artifact_path(project_root, payload)
    try:
        resolved_target.parent.mkdir(parents=True, exist_ok=True)
        proof_bundle = dict(payload.get("proof_bundle") or payload.get("proofBundle") or _build_operator_proof_bundle(payload))
        resolved_target.write_text(json.dumps({**payload, "timestamp": timestamp, "proof_bundle": proof_bundle}, indent=2, default=str), encoding="utf-8")
        return resolved_target
    except Exception:
        return None


def build_experiment_artifact_path(project_root: Path, payload: dict[str, Any]) -> Path:
    moment = _payload_datetime(payload)
    mode = payload.get("mode", "run")
    ticket = payload.get("ticket", "unknown")
    name = f"{moment.strftime('%Y%m%dT%H%M%S')}-{mode}-{ticket}-experiment.json"
    return assistant_experiments_dir(project_root) / name


def write_experiment_artifact(project_root: Path, payload: dict[str, Any], *, target: Path | None = None) -> Path | None:
    try:
        base = assistant_experiments_dir(project_root)
        base.mkdir(parents=True, exist_ok=True)
    except Exception:
        return None

    timestamp = payload.get("timestamp") or _payload_datetime(payload).isoformat()
    resolved_target = target or build_experiment_artifact_path(project_root, payload)
    try:
        resolved_target.parent.mkdir(parents=True, exist_ok=True)
        resolved_target.write_text(json.dumps({**payload, "timestamp": timestamp}, indent=2, default=str), encoding="utf-8")
        return resolved_target
    except Exception:
        return None


def build_human_summary_path(project_root: Path, payload: dict[str, Any]) -> Path:
    ticket = payload.get("ticket", "unknown")
    mode = payload.get("mode", "run")
    moment = _payload_datetime(payload)
    name = f"{moment.strftime('%Y%m%dT%H%M%S')}-{mode}-{ticket}.md"
    return assistant_runs_dir(project_root) / name


def write_human_summary(project_root: Path, payload: dict[str, Any], *, target: Path | None = None) -> Path | None:
    target_dir = assistant_runs_dir(project_root)
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
    except Exception:
        return None
    ticket = payload.get("ticket", "unknown")
    mode = payload.get("mode", "run")
    resolved_target = target or build_human_summary_path(project_root, payload)
    owner_summary = dict(payload.get("owner_summary") or {})
    run_summary = dict(owner_summary.get("run_summary") or payload.get("run_summary") or {})
    test_summary = dict(owner_summary.get("test_summary") or payload.get("test_summary") or {})
    review_queue = dict(owner_summary.get("review_queue_summary") or payload.get("review_queue_summary") or {})
    experiment_scorecard = dict(payload.get("experiment_scorecard") or {})
    recommended_actions = [dict(item) for item in list(owner_summary.get("recommended_actions") or payload.get("recommended_actions") or []) if isinstance(item, dict)]
    artifact_paths = [str(path) for path in list(owner_summary.get("artifact_paths") or payload.get("artifact_paths") or []) if str(path)]
    benchmark_summary = dict(payload.get("experiment_benchmark_summary") or {})
    owner_experiment_summary = dict(payload.get("owner_experiment_summary") or {})
    performance_baseline = dict((experiment_scorecard.get("metadata") or {}).get("performance_baseline") or {})
    cleanup_summary = dict((run_summary.get("metadata") or {}).get("cleanup_summary") or (experiment_scorecard.get("metadata") or {}).get("cleanup_summary") or {})
    duplicate_summary = dict((run_summary.get("metadata") or {}).get("duplicate_summary") or (experiment_scorecard.get("metadata") or {}).get("duplicate_summary") or {})
    supervision_label = dict((run_summary.get("metadata") or {}).get("supervision_label") or (experiment_scorecard.get("metadata") or {}).get("supervision_label") or {})
    stage_speed_summary = dict((run_summary.get("metadata") or {}).get("stage_speed_summary") or (experiment_scorecard.get("metadata") or {}).get("stage_speed_summary") or {})
    trust_summary = dict((run_summary.get("metadata") or {}).get("trust_summary") or (experiment_scorecard.get("metadata") or {}).get("trust_summary") or {})
    proof_bundle = dict(payload.get("proof_bundle") or payload.get("proofBundle") or _build_operator_proof_bundle(payload))
    lines = [
        f"# Assistant Run {ticket}",
        "",
        f"- mode: {mode}",
        f"- strategy: {payload.get('strategy', '')}",
        f"- branch: {payload.get('branch', '')}",
    ]
    if owner_summary.get("summary"):
        lines.extend(["", "## Owner Summary", "", str(owner_summary.get("summary") or "")])
    if run_summary:
        lines.extend(
            [
                "",
                "## Run Summary",
                "",
                f"- status: {run_summary.get('status', '')}",
                f"- final_state: {run_summary.get('final_state', '')}",
                f"- created_files: {run_summary.get('created_file_count', 0)}",
                f"- execution_results: {run_summary.get('execution_result_count', 0)}",
                f"- repairs: {run_summary.get('repair_count', 0)}",
            ]
        )
        if run_summary.get("reason"):
            lines.append(f"- reason: {run_summary.get('reason', '')}")
    if test_summary:
        lines.extend(
            [
                "",
                "## Test Summary",
                "",
                f"- status: {test_summary.get('status', '')}",
                f"- commands: {test_summary.get('command_count', 0)}",
                f"- passed: {test_summary.get('passed_count', 0)}",
                f"- failed: {test_summary.get('failed_count', 0)}",
                f"- fingerprints: {test_summary.get('fingerprint_count', 0)}",
            ]
        )
        if test_summary.get("retry_reason"):
            lines.append(f"- retry_reason: {test_summary.get('retry_reason', '')}")
    if review_queue:
        lines.extend(
            [
                "",
                "## Review Queue",
                "",
                f"- pending_review: {review_queue.get('pending_review_count', 0)}",
                f"- total_requests: {review_queue.get('total_count', 0)}",
                f"- requires_manual_review: {review_queue.get('requires_manual_review', False)}",
            ]
        )
        if review_queue.get("summary"):
            lines.append(f"- summary: {review_queue.get('summary', '')}")
    if recommended_actions:
        lines.extend(["", "## Recommended Actions", ""])
        for item in recommended_actions[:5]:
            lines.append(f"- [{item.get('priority', 'medium')}] {item.get('title', '')}: {item.get('reason', '')}")
    if owner_experiment_summary:
        lines.extend(["", "## Experiment Summary", ""])
        if owner_experiment_summary.get("summary"):
            lines.append(str(owner_experiment_summary.get("summary") or ""))
        if owner_experiment_summary.get("recommended_next_strategy"):
            lines.append(f"- recommended_strategy: {owner_experiment_summary.get('recommended_next_strategy', '')}")
        if owner_experiment_summary.get("recommended_next_action"):
            lines.append(f"- recommended_action: {owner_experiment_summary.get('recommended_next_action', '')}")
    if performance_baseline:
        current_performance = dict(performance_baseline.get("current") or {})
        baseline_performance = dict(performance_baseline.get("baseline") or {})
        gain_target = dict(performance_baseline.get("gain_target") or {})
        lines.extend(
            [
                "",
                "## Performance Baseline",
                "",
                f"- safe_task: {performance_baseline.get('safe_task', False)}",
                f"- comparison_scope: {performance_baseline.get('comparison_scope', '')}",
                f"- current_cycle_time_seconds: {current_performance.get('cycle_time_seconds')}",
                f"- baseline_median_cycle_time_seconds: {baseline_performance.get('median_cycle_time_seconds')}",
                f"- current_tasks_per_hour: {current_performance.get('tasks_per_hour')}",
                f"- baseline_safe_tasks_per_hour: {baseline_performance.get('safe_tasks_per_hour')}",
                f"- baseline_first_pass_validation_rate: {baseline_performance.get('first_pass_validation_rate')}",
                f"- baseline_median_repair_rounds: {baseline_performance.get('median_repair_rounds')}",
                f"- baseline_failure_rate: {baseline_performance.get('failure_rate')}",
                f"- baseline_blocked_rate: {baseline_performance.get('blocked_rate')}",
                f"- target_met: {gain_target.get('met', False)}",
            ]
        )
        missing_signals = [str(item) for item in list(performance_baseline.get("missing_signals") or []) if str(item)]
        if missing_signals:
            lines.append(f"- missing_signals: {', '.join(missing_signals)}")
    if cleanup_summary:
        lines.extend(
            [
                "",
                "## Cleanup Candidates",
                "",
                f"- candidate_count: {cleanup_summary.get('candidate_count', 0)}",
                f"- touched_path_count: {cleanup_summary.get('touched_path_count', 0)}",
                f"- duplicate_helper_candidate_count: {cleanup_summary.get('duplicate_helper_candidate_count', 0)}",
                f"- safe_delete_candidate_count: {cleanup_summary.get('safe_delete_candidate_count', 0)}",
                f"- summary: {cleanup_summary.get('summary', '')}",
            ]
        )
        for item in list(cleanup_summary.get("candidates") or [])[:5]:
            if not isinstance(item, dict):
                continue
            lines.append(
                f"- [{item.get('kind', 'candidate')}] {item.get('path', '')}: {item.get('reason', '')}"
            )
    if duplicate_summary:
        lines.extend(
            [
                "",
                "## Duplicate Edit Signals",
                "",
                f"- touch_count: {duplicate_summary.get('touch_count', 0)}",
                f"- unique_path_count: {duplicate_summary.get('unique_path_count', 0)}",
                f"- duplicate_path_count: {duplicate_summary.get('duplicate_path_count', 0)}",
                f"- duplicate_touch_count: {duplicate_summary.get('duplicate_touch_count', 0)}",
                f"- duplicate_edit_rate: {duplicate_summary.get('duplicate_edit_rate', 0.0)}",
                f"- summary: {duplicate_summary.get('summary', '')}",
            ]
        )
        for item in list(duplicate_summary.get("paths") or [])[:5]:
            if not isinstance(item, dict):
                continue
            lines.append(
                f"- {item.get('path', '')}: count={item.get('count', 0)} sources={', '.join(str(source) for source in list(item.get('sources') or []))}"
            )
    if supervision_label:
        lines.extend(
            [
                "",
                "## Supervision Label",
                "",
                f"- outcome: {supervision_label.get('outcome', '')}",
                f"- learning_label: {supervision_label.get('learning_label', '')}",
                f"- approval_mode: {supervision_label.get('approval_mode', '')}",
                f"- summary: {supervision_label.get('summary', '')}",
            ]
        )
        rejection_reasons = [str(item) for item in list(supervision_label.get("rejection_reasons") or []) if str(item)]
        if rejection_reasons:
            lines.append(f"- rejection_reasons: {' | '.join(rejection_reasons[:3])}")
    if stage_speed_summary:
        lines.extend(
            [
                "",
                "## Stage Speed",
                "",
                f"- stage_count: {stage_speed_summary.get('stage_count', 0)}",
                f"- total_measured_seconds: {stage_speed_summary.get('total_measured_seconds', 0.0)}",
                f"- slowest_stage: {dict(stage_speed_summary.get('slowest_stage') or {}).get('stage', '')}",
                f"- slowest_stage_seconds: {dict(stage_speed_summary.get('slowest_stage') or {}).get('duration_seconds')}",
                f"- summary: {stage_speed_summary.get('summary', '')}",
            ]
        )
        for item in list(stage_speed_summary.get("stages") or [])[:6]:
            if not isinstance(item, dict):
                continue
            lines.append(
                f"- {item.get('stage', '')}: entered_at={item.get('entered_at', '')} duration_seconds={item.get('duration_seconds')}"
            )
    if trust_summary:
        lines.extend(
            [
                "",
                "## Trust Summary",
                "",
                f"- trust_state: {trust_summary.get('trust_state', '')}",
                f"- learning_label: {trust_summary.get('learning_label', '')}",
                f"- approval_mode: {trust_summary.get('approval_mode', '')}",
                f"- approval_queue_size: {trust_summary.get('approval_queue_size', 0)}",
                f"- duplicate_path_count: {trust_summary.get('duplicate_path_count', 0)}",
                f"- cleanup_candidate_count: {trust_summary.get('cleanup_candidate_count', 0)}",
                f"- current_cycle_time_seconds: {trust_summary.get('current_cycle_time_seconds')}",
                f"- speed_target_met: {trust_summary.get('speed_target_met', False)}",
                f"- slowest_stage: {trust_summary.get('slowest_stage', '')}",
                f"- summary: {trust_summary.get('summary', '')}",
            ]
        )
    if benchmark_summary:
        lines.extend(
            [
                "",
                "## Experiment Benchmark",
                "",
                f"- total_runs: {benchmark_summary.get('total_runs', 0)}",
                f"- success_rate: {benchmark_summary.get('success_rate', 0.0)}",
                f"- failure_rate: {benchmark_summary.get('failure_rate', 0.0)}",
                f"- blocked_rate: {benchmark_summary.get('blocked_rate', 0.0)}",
                f"- review_required_rate: {benchmark_summary.get('review_required_rate', 0.0)}",
                f"- low_confidence_patch_rate: {benchmark_summary.get('low_confidence_patch_rate', 0.0)}",
            ]
        )
        best_strategy = dict(benchmark_summary.get("best_strategy") or {})
        weakest_strategy = dict(benchmark_summary.get("weakest_strategy") or {})
        if best_strategy.get("strategy"):
            lines.append(f"- best_strategy: {best_strategy.get('strategy', '')}")
        if weakest_strategy.get("strategy"):
            lines.append(f"- weakest_strategy: {weakest_strategy.get('strategy', '')}")
    if artifact_paths:
        lines.extend(["", "## Artifact Links", ""])
        lines.extend(f"- {path}" for path in artifact_paths[:10])
    try:
        resolved_target.parent.mkdir(parents=True, exist_ok=True)
        resolved_target.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return resolved_target
    except Exception:
        return None


def append_ci_report(path: str | Path, row: dict[str, Any]) -> None:
    try:
        target = Path(path)
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, default=str) + "\n")
    except Exception:
        pass


def append_experiment_dataset(project_root: Path, row: dict[str, Any], *, target: Path | None = None) -> Path | None:
    resolved_target = target or assistant_experiment_dataset_path(project_root)
    try:
        resolved_target.parent.mkdir(parents=True, exist_ok=True)
        with open(resolved_target, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
        return resolved_target
    except Exception:
        return None


def load_experiment_dataset(project_root: Path, *, target: Path | None = None) -> list[dict[str, Any]]:
    resolved_target = target or assistant_experiment_dataset_path(project_root)
    if not resolved_target.exists():
        return []
    rows: list[dict[str, Any]] = []
    try:
        for line in resolved_target.read_text(encoding="utf-8").splitlines():
            text = line.strip()
            if not text:
                continue
            payload = json.loads(text)
            if isinstance(payload, dict):
                rows.append(payload)
    except Exception:
        return []
    return rows


def filter_experiment_dataset(
    rows: list[dict[str, Any]],
    *,
    ticket: str = "",
    strategy: str = "",
    status: str = "",
    review_required: bool | None = None,
    min_score: int | None = None,
    limit: int = 0,
) -> list[dict[str, Any]]:
    filtered: list[dict[str, Any]] = []
    ticket_value = str(ticket or "").strip()
    strategy_value = str(strategy or "").strip().lower()
    status_value = str(status or "").strip().lower()
    for row in rows:
        if not isinstance(row, dict):
            continue
        experiment_run = dict(row.get("experiment_run") or {})
        scorecard = dict(row.get("experiment_scorecard") or experiment_run.get("scorecard") or {})
        row_ticket = str(row.get("ticket") or experiment_run.get("ticket") or "").strip()
        row_strategy = str(row.get("strategy") or experiment_run.get("strategy") or scorecard.get("strategy") or "").strip().lower()
        row_status = str(scorecard.get("status") or experiment_run.get("status") or "").strip().lower()
        row_review_required = bool(scorecard.get("review_required", False))
        row_score = int(scorecard.get("final_score") or 0)
        if ticket_value and row_ticket != ticket_value:
            continue
        if strategy_value and row_strategy != strategy_value:
            continue
        if status_value and row_status != status_value:
            continue
        if review_required is not None and row_review_required is not bool(review_required):
            continue
        if min_score is not None and row_score < int(min_score):
            continue
        filtered.append(row)
    if limit > 0:
        return filtered[:limit]
    return filtered


def _safe_rate(numerator: int | float, denominator: int | float) -> float:
    return float(numerator) / float(denominator) if denominator else 0.0


def _experiment_model_metadata(row: dict[str, Any]) -> dict[str, str]:
    experiment_run = dict(row.get("experiment_run") or {})
    metadata = dict(experiment_run.get("metadata") or row.get("metadata") or {})
    model_profile = str(
        metadata.get("model_profile_id")
        or metadata.get("modelProfileId")
        or row.get("model_profile_id")
        or row.get("modelProfileId")
        or ""
    ).strip()
    base_model = str(
        metadata.get("base_model")
        or metadata.get("baseModel")
        or row.get("base_model")
        or row.get("baseModel")
        or ""
    ).strip()
    task_mode = str(
        metadata.get("task_mode")
        or metadata.get("taskMode")
        or row.get("task_mode")
        or row.get("taskMode")
        or ""
    ).strip()
    provider_source = str(
        metadata.get("provider_source")
        or metadata.get("providerSource")
        or row.get("provider_source")
        or row.get("providerSource")
        or ""
    ).strip()
    return {
        "model_profile_id": model_profile,
        "base_model": base_model,
        "task_mode": task_mode,
        "provider_source": provider_source,
    }


def _strategy_row_summary(strategy: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(rows)
    success_count = 0
    failure_count = 0
    blocked_count = 0
    review_required_count = 0
    low_confidence_count = 0
    total_score = 0
    total_repair_count = 0
    blocker_counter: Counter[str] = Counter()
    family_counter: Counter[str] = Counter()
    retry_counter: Counter[str] = Counter()
    for row in rows:
        experiment_run = dict(row.get("experiment_run") or {})
        scorecard = dict(row.get("experiment_scorecard") or experiment_run.get("scorecard") or {})
        training_signals = dict(experiment_run.get("training_signals") or {})
        status = str(scorecard.get("status") or experiment_run.get("status") or "").strip().lower()
        if status == "succeeded" or bool(scorecard.get("success", False)):
            success_count += 1
        elif status == "blocked":
            blocked_count += 1
        else:
            failure_count += 1
        if scorecard.get("review_required", False):
            review_required_count += 1
        if int(scorecard.get("low_confidence_patch_count") or 0) > 0:
            low_confidence_count += 1
        total_score += int(scorecard.get("final_score") or 0)
        total_repair_count += int(scorecard.get("repair_count") or 0)
        for label in list(training_signals.get("validation_fingerprints") or []):
            text = str(label or "").strip().lower()
            if text:
                blocker_counter[text] += 1
                family_counter[str(describe_failure_label(text).get("failure_family") or "generic-validation")] += 1
        action = str(training_signals.get("retry_action") or "").strip().lower()
        if action:
            retry_counter[action] += 1
    return {
        "strategy": str(strategy or ""),
        "total_runs": total,
        "success_count": success_count,
        "failure_count": failure_count,
        "blocked_count": blocked_count,
        "success_rate": _safe_rate(success_count, total),
        "failure_rate": _safe_rate(failure_count, total),
        "blocked_rate": _safe_rate(blocked_count, total),
        "review_required_rate": _safe_rate(review_required_count, total),
        "low_confidence_patch_rate": _safe_rate(low_confidence_count, total),
        "average_score": _safe_rate(total_score, total),
        "average_repair_count": _safe_rate(total_repair_count, total),
        "repeated_blockers": [{"label": label, "count": count} for label, count in blocker_counter.most_common(5)],
        "failure_families": [{"family": family, "count": count} for family, count in family_counter.most_common(4)],
        "retry_actions": [{"action": label, "count": count} for label, count in retry_counter.most_common(4)],
    }


def _repeated_task_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        experiment_run = dict(row.get("experiment_run") or {})
        ticket = str(experiment_run.get("ticket") or row.get("ticket") or "").strip()
        if ticket:
            grouped.setdefault(ticket, []).append(row)

    repeated_rows: list[dict[str, Any]] = []
    for ticket, ticket_rows in grouped.items():
        if len(ticket_rows) < 2:
            continue
        strategy_counter: Counter[str] = Counter()
        status_counter: Counter[str] = Counter()
        total_score = 0
        for row in ticket_rows:
            experiment_run = dict(row.get("experiment_run") or {})
            scorecard = dict(row.get("experiment_scorecard") or experiment_run.get("scorecard") or {})
            strategy_counter[str(experiment_run.get("strategy") or row.get("strategy") or "unknown")] += 1
            status_counter[str(scorecard.get("status") or experiment_run.get("status") or "unknown")] += 1
            total_score += int(scorecard.get("final_score") or 0)
        repeated_rows.append(
            {
                "ticket": ticket,
                "run_count": len(ticket_rows),
                "strategies": [{"strategy": strategy, "count": count} for strategy, count in strategy_counter.most_common()],
                "statuses": [{"status": status, "count": count} for status, count in status_counter.most_common()],
                "average_score": _safe_rate(total_score, len(ticket_rows)),
            }
        )
    repeated_rows.sort(
        key=lambda item: (int(item.get("run_count") or 0), float(item.get("average_score") or 0.0), str(item.get("ticket") or "")),
        reverse=True,
    )
    return {
        "repeat_ticket_count": len(repeated_rows),
        "repeat_run_count": sum(int(item.get("run_count") or 0) for item in repeated_rows),
        "top_repeated_tasks": repeated_rows[:5],
        "comparison_summary": (
            f"{len(repeated_rows)} repeated task group(s) detected"
            if repeated_rows
            else "No repeated task benchmark groups detected"
        ),
    }


def summarize_experiment_dataset(
    project_root: Path,
    *,
    rows: list[dict[str, Any]] | None = None,
    target: Path | None = None,
    artifact_paths: list[str] | None = None,
) -> dict[str, Any]:
    resolved_target = target or assistant_experiment_dataset_path(project_root)
    dataset_rows = [dict(item) for item in list(rows or load_experiment_dataset(project_root, target=resolved_target)) if isinstance(item, dict)]
    total_runs = len(dataset_rows)
    status_counter: Counter[str] = Counter()
    blocker_counter: Counter[str] = Counter()
    taxonomy_items: list[dict[str, Any]] = []
    repair_reason_counter: Counter[str] = Counter()
    retry_counter: Counter[str] = Counter()
    strategy_groups: dict[str, list[dict[str, Any]]] = {}
    review_required_count = 0
    low_confidence_run_count = 0
    total_repair_count = 0
    validation_passed_count = 0
    validation_failed_count = 0
    model_profile_counter: Counter[str] = Counter()
    base_model_counter: Counter[str] = Counter()
    task_mode_counter: Counter[str] = Counter()
    provider_source_counter: Counter[str] = Counter()
    for row in dataset_rows:
        experiment_run = dict(row.get("experiment_run") or {})
        scorecard = dict(row.get("experiment_scorecard") or experiment_run.get("scorecard") or {})
        training_signals = dict(experiment_run.get("training_signals") or {})
        strategy = str(row.get("strategy") or experiment_run.get("strategy") or scorecard.get("strategy") or "unknown").strip() or "unknown"
        strategy_groups.setdefault(strategy, []).append(row)
        status = str(scorecard.get("status") or experiment_run.get("status") or "unknown").strip().lower() or "unknown"
        status_counter[status] += 1
        model_metadata = _experiment_model_metadata(row)
        if model_metadata["model_profile_id"]:
            model_profile_counter[model_metadata["model_profile_id"]] += 1
        if model_metadata["base_model"]:
            base_model_counter[model_metadata["base_model"]] += 1
        if model_metadata["task_mode"]:
            task_mode_counter[model_metadata["task_mode"]] += 1
        if model_metadata["provider_source"]:
            provider_source_counter[model_metadata["provider_source"]] += 1
        if scorecard.get("review_required", False):
            review_required_count += 1
        if int(scorecard.get("low_confidence_patch_count") or 0) > 0:
            low_confidence_run_count += 1
        total_repair_count += int(scorecard.get("repair_count") or 0)
        validation_passed_count += int(scorecard.get("validation_passed_count") or 0)
        validation_failed_count += int(scorecard.get("validation_failed_count") or 0)
        for label in list(training_signals.get("validation_fingerprints") or []):
            text = str(label or "").strip().lower()
            if text:
                blocker_counter[text] += 1
                taxonomy_items.append({"label": text})
                repair_reason_counter[str(describe_failure_label(text).get("repair_reason_code") or "generic_validation_failure")] += 1
        for reason_code in list(training_signals.get("repair_reason_codes") or []):
            text = str(reason_code or "").strip().lower()
            if text:
                repair_reason_counter[text] += 1
        action = str(training_signals.get("retry_action") or "").strip().lower()
        if action:
            retry_counter[action] += 1
    strategy_summaries = [_strategy_row_summary(strategy, group_rows) for strategy, group_rows in strategy_groups.items()]
    strategy_summaries.sort(
        key=lambda item: (
            float(item.get("average_score", 0.0)),
            float(item.get("success_rate", 0.0)),
            -float(item.get("failure_rate", 0.0)),
            str(item.get("strategy") or ""),
        ),
        reverse=True,
    )
    best_strategy = dict(strategy_summaries[0]) if strategy_summaries else {}
    weakest_strategy = dict(sorted(strategy_summaries, key=lambda item: (float(item.get("average_score", 0.0)), float(item.get("success_rate", 0.0)), -float(item.get("failure_rate", 0.0))))[0]) if strategy_summaries else {}
    repeated_blockers = [{"label": label, "count": count} for label, count in blocker_counter.most_common(6)]
    retry_actions = [{"action": label, "count": count} for label, count in retry_counter.most_common(5)]
    failure_taxonomy_summary = summarize_failure_taxonomy(taxonomy_items)
    repair_reason_codes = [{"reason_code": code, "count": count} for code, count in repair_reason_counter.most_common(6)]
    repeated_task_summary = _repeated_task_summary(dataset_rows)
    recommended_next_strategy = str(best_strategy.get("strategy") or "")
    recommended_next_action = "inspect-artifacts"
    if review_required_count:
        recommended_next_action = "resolve-review-queue"
    elif repeated_blockers and repeated_blockers[0].get("count", 0) >= 2:
        recommended_next_action = "reduce-repeat-blockers"
    elif low_confidence_run_count:
        recommended_next_action = "favor-higher-confidence-strategy"
    elif recommended_next_strategy:
        recommended_next_action = "continue-best-strategy"
    return build_experiment_benchmark_summary(
        dataset_path=str(resolved_target),
        total_runs=total_runs,
        strategy_count=len(strategy_summaries),
        success_count=int(status_counter.get("succeeded", 0)),
        failure_count=int(status_counter.get("failed", 0)),
        blocked_count=int(status_counter.get("blocked", 0)),
        review_required_count=review_required_count,
        low_confidence_run_count=low_confidence_run_count,
        average_repair_count=_safe_rate(total_repair_count, total_runs),
        validation_passed_count=validation_passed_count,
        validation_failed_count=validation_failed_count,
        success_rate=_safe_rate(int(status_counter.get("succeeded", 0)), total_runs),
        failure_rate=_safe_rate(int(status_counter.get("failed", 0)), total_runs),
        blocked_rate=_safe_rate(int(status_counter.get("blocked", 0)), total_runs),
        review_required_rate=_safe_rate(review_required_count, total_runs),
        low_confidence_patch_rate=_safe_rate(low_confidence_run_count, total_runs),
        validation_pass_rate=_safe_rate(validation_passed_count, validation_passed_count + validation_failed_count),
        validation_fail_rate=_safe_rate(validation_failed_count, validation_passed_count + validation_failed_count),
        strategy_summaries=strategy_summaries,
        repeated_blockers=repeated_blockers,
        retry_actions=retry_actions,
        best_strategy=best_strategy,
        weakest_strategy=weakest_strategy,
        recommended_next_strategy=recommended_next_strategy,
        recommended_next_action=recommended_next_action,
        artifact_paths=artifact_paths,
        metadata={
            "status_counts": dict(status_counter),
            "failure_taxonomy_summary": failure_taxonomy_summary,
            "repair_reason_codes": repair_reason_codes,
            "repeated_task_summary": repeated_task_summary,
            "comparison_summary": str(repeated_task_summary.get("comparison_summary") or ""),
            "model_profile_counts": dict(model_profile_counter),
            "base_model_counts": dict(base_model_counter),
            "task_mode_counts": dict(task_mode_counter),
            "provider_source_counts": dict(provider_source_counter),
        },
    )


def build_owner_experiment_summary_from_benchmark(
    benchmark_summary: dict[str, Any],
    *,
    artifact_paths: list[str] | None = None,
) -> dict[str, Any]:
    best_strategy = dict(benchmark_summary.get("best_strategy") or {})
    weakest_strategy = dict(benchmark_summary.get("weakest_strategy") or {})
    recommended_strategy = str(benchmark_summary.get("recommended_next_strategy") or "")
    recommended_action = str(benchmark_summary.get("recommended_next_action") or "")
    total_runs = int(benchmark_summary.get("total_runs") or 0)
    summary_parts = [f"{total_runs} experiment runs tracked"] if total_runs else ["No experiment runs tracked yet"]
    metadata = dict(benchmark_summary.get("metadata") or {})
    repeated_task_summary = dict(metadata.get("repeated_task_summary") or {})
    failure_taxonomy_summary = dict(metadata.get("failure_taxonomy_summary") or {})
    if best_strategy.get("strategy"):
        summary_parts.append(f"best strategy: {best_strategy.get('strategy')}")
    if weakest_strategy.get("strategy") and weakest_strategy.get("strategy") != best_strategy.get("strategy"):
        summary_parts.append(f"weakest strategy: {weakest_strategy.get('strategy')}")
    if recommended_action:
        summary_parts.append(f"next action: {recommended_action}")
    if repeated_task_summary.get("repeat_ticket_count"):
        summary_parts.append(f"repeated tasks: {repeated_task_summary.get('repeat_ticket_count')}")
    if failure_taxonomy_summary.get("primary_failure_family"):
        summary_parts.append(f"top failure family: {failure_taxonomy_summary.get('primary_failure_family')}")
    return build_owner_experiment_summary(
        dataset_path=str(benchmark_summary.get("dataset_path") or ""),
        total_runs=total_runs,
        summary="; ".join(summary_parts),
        best_strategy=best_strategy,
        weakest_strategy=weakest_strategy,
        recommended_next_strategy=recommended_strategy,
        recommended_next_action=recommended_action,
        repeated_blockers=list(benchmark_summary.get("repeated_blockers") or []),
        artifact_paths=artifact_paths,
        benchmark_summary=benchmark_summary,
        metadata={
            "failure_taxonomy_summary": failure_taxonomy_summary,
            "repair_reason_codes": list(metadata.get("repair_reason_codes") or []),
            "repeated_task_summary": repeated_task_summary,
            "comparison_summary": str(metadata.get("comparison_summary") or ""),
        },
    )


def build_training_handoff_from_dataset(
    benchmark_summary: dict[str, Any],
    rows: list[dict[str, Any]],
    *,
    export_path: str = "",
    filters: dict[str, Any] | None = None,
    artifact_paths: list[str] | None = None,
) -> dict[str, Any]:
    recommended_strategy = str(benchmark_summary.get("recommended_next_strategy") or "")
    selected_rows = list(rows)
    if recommended_strategy:
        preferred = [row for row in rows if str((row.get("experiment_run") or {}).get("strategy") or row.get("strategy") or "") == recommended_strategy]
        if preferred:
            selected_rows = preferred
    selected_rows = selected_rows[:25]
    selected_runs = []
    for row in selected_rows:
        experiment_run = dict(row.get("experiment_run") or {})
        scorecard = dict(row.get("experiment_scorecard") or experiment_run.get("scorecard") or {})
        training_signals = dict(experiment_run.get("training_signals") or {})
        model_metadata = _experiment_model_metadata(row)
        failure_taxonomy_summary = dict(training_signals.get("failure_taxonomy_summary") or summarize_failure_taxonomy(training_signals.get("validation_fingerprints") or []))
        selected_runs.append(
            {
                "experiment_id": str(experiment_run.get("experiment_id") or ""),
                "ticket": str(experiment_run.get("ticket") or row.get("ticket") or ""),
                "strategy": str(experiment_run.get("strategy") or row.get("strategy") or ""),
                "status": str(scorecard.get("status") or experiment_run.get("status") or ""),
                "final_score": int(scorecard.get("final_score") or 0),
                "review_required": bool(scorecard.get("review_required", False)),
                "model_profile_id": model_metadata["model_profile_id"],
                "base_model": model_metadata["base_model"],
                "task_mode": model_metadata["task_mode"],
                "provider_source": model_metadata["provider_source"],
                "training_signals": training_signals,
                "failure_taxonomy_summary": failure_taxonomy_summary,
                "repair_reason_codes": list(training_signals.get("repair_reason_codes") or []),
                "repair_outcome_summary": dict(training_signals.get("repair_outcome_summary") or {}),
                "artifact_paths": list(experiment_run.get("artifact_paths") or []),
            }
        )
    metadata = dict(benchmark_summary.get("metadata") or {})
    return build_training_handoff(
        dataset_path=str(benchmark_summary.get("dataset_path") or ""),
        export_path=str(export_path or ""),
        total_runs=int(benchmark_summary.get("total_runs") or 0),
        selected_run_count=len(selected_runs),
        recommended_strategy=recommended_strategy,
        recommended_focus=str(benchmark_summary.get("recommended_next_action") or ""),
        filters=dict(filters or {}),
        schema_fields=[
            "experiment_run.experiment_id",
            "experiment_run.ticket",
            "experiment_run.strategy",
            "experiment_scorecard.status",
            "experiment_scorecard.final_score",
            "experiment_scorecard.review_required",
            "experiment_run.metadata.model_profile_id",
            "experiment_run.metadata.base_model",
            "experiment_run.metadata.task_mode",
            "experiment_run.metadata.provider_source",
            "experiment_run.training_signals",
            "experiment_run.training_signals.failure_taxonomy_summary",
            "experiment_run.training_signals.repair_reason_codes",
            "experiment_run.training_signals.repair_outcome_summary",
            "strategy_benchmark",
        ],
        strategy_summaries=list(benchmark_summary.get("strategy_summaries") or []),
        repeated_blockers=list(benchmark_summary.get("repeated_blockers") or []),
        selected_runs=selected_runs,
        artifact_paths=artifact_paths,
        metadata={
            "retry_actions": list(benchmark_summary.get("retry_actions") or []),
            "failure_taxonomy_summary": dict(metadata.get("failure_taxonomy_summary") or {}),
            "repair_reason_codes": list(metadata.get("repair_reason_codes") or []),
            "repeated_task_summary": dict(metadata.get("repeated_task_summary") or {}),
            "comparison_summary": str(metadata.get("comparison_summary") or ""),
            "model_profile_counts": dict(metadata.get("model_profile_counts") or {}),
            "base_model_counts": dict(metadata.get("base_model_counts") or {}),
            "task_mode_counts": dict(metadata.get("task_mode_counts") or {}),
            "provider_source_counts": dict(metadata.get("provider_source_counts") or {}),
        },
    )


def build_experiment_export_path(project_root: Path, payload: dict[str, Any], *, suffix: str = "summary") -> Path:
    moment = _payload_datetime(payload)
    name = f"{moment.strftime('%Y%m%dT%H%M%S')}-{suffix}.json"
    return assistant_experiment_exports_dir(project_root) / name


def write_experiment_export(project_root: Path, payload: dict[str, Any], *, target: Path | None = None, suffix: str = "summary") -> Path | None:
    resolved_target = target or build_experiment_export_path(project_root, payload, suffix=suffix)
    try:
        resolved_target.parent.mkdir(parents=True, exist_ok=True)
        resolved_target.write_text(json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8")
        return resolved_target
    except Exception:
        return None


def _self_improvement_priority(score: float) -> str:
    if score >= 85.0:
        return "high"
    if score >= 65.0:
        return "medium"
    return "low"


def is_self_improvement_path(path: str) -> bool:
    normalized = str(path or "").strip()
    if not normalized:
        return False
    return any(normalized.startswith(prefix) for prefix in ASSISTANT_SELF_PATH_PREFIXES)


def filter_self_improvement_paths(paths: list[str] | None = None) -> list[str]:
    filtered: list[str] = []
    seen: set[str] = set()
    for raw in list(paths or []):
        normalized = str(raw or "").strip()
        if not normalized or normalized in seen or not is_self_improvement_path(normalized):
            continue
        seen.add(normalized)
        filtered.append(normalized)
    return filtered


def load_self_improvement_history(project_root: Path, *, limit: int = 50) -> list[dict[str, Any]]:
    path = assistant_self_improvement_history_path(project_root)
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
    rows.sort(key=lambda item: str(item.get("timestamp") or ""), reverse=True)
    return rows[:limit] if limit > 0 else rows


def append_self_improvement_history(project_root: Path, entry: dict[str, Any]) -> Path | None:
    path = assistant_self_improvement_history_path(project_root)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = dict(entry or {})
        if not str(payload.get("timestamp") or ""):
            payload["timestamp"] = datetime.now(timezone.utc).isoformat()
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, default=str) + "\n")
        return path
    except Exception:
        return None


def load_self_improvement_seeds(project_root: Path, *, limit: int = 0, active_only: bool = True) -> list[dict[str, Any]]:
    path = assistant_self_improvement_seed_path(project_root)
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
    rows.sort(key=lambda item: str(item.get("timestamp") or ""), reverse=True)
    if active_only:
        latest_by_seed: dict[str, dict[str, Any]] = {}
        for item in rows:
            seed_id = str(item.get("seed_id") or item.get("seedId") or "").strip()
            if seed_id and seed_id not in latest_by_seed:
                latest_by_seed[seed_id] = item
        rows = [
            item
            for item in latest_by_seed.values()
            if str(item.get("status") or "active").strip().lower() in {"active", "prepared", "queued"}
        ]
        rows.sort(key=lambda item: str(item.get("timestamp") or ""), reverse=True)
    return rows[:limit] if limit > 0 else rows


def append_self_improvement_seed(project_root: Path, entry: dict[str, Any]) -> Path | None:
    path = assistant_self_improvement_seed_path(project_root)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = dict(entry or {})
        if not str(payload.get("timestamp") or ""):
            payload["timestamp"] = datetime.now(timezone.utc).isoformat()
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, default=str) + "\n")
        return path
    except Exception:
        return None


def _self_improvement_candidate_signature(candidate_id: Any, target_paths: list[str] | None = None) -> str:
    normalized_candidate = str(candidate_id or "").strip()
    normalized_paths = sorted(filter_self_improvement_paths(target_paths or []))
    if not normalized_candidate and not normalized_paths:
        return ""
    return f"{normalized_candidate}::{'|'.join(normalized_paths)}"


def _self_improvement_history_signature(entry: dict[str, Any]) -> str:
    return _self_improvement_candidate_signature(
        entry.get("candidate_id") or entry.get("candidateId"),
        list(entry.get("target_paths") or entry.get("targetPaths") or []),
    )


def _entry_trust_summary(entry: dict[str, Any]) -> dict[str, Any]:
    payload = dict(entry or {})
    run_summary = dict(payload.get("run_summary") or payload.get("runSummary") or {})
    return dict(
        payload.get("trust_summary")
        or payload.get("trustSummary")
        or (run_summary.get("metadata") or {}).get("trust_summary")
        or {}
    )


def _summarize_history_trust_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    trust_state_counts: Counter[str] = Counter()
    learning_label_counts: Counter[str] = Counter()
    approval_mode_counts: Counter[str] = Counter()
    last_trust_summary: dict[str, Any] = {}
    trust_signal_count = 0
    for item in rows:
        trust_summary = _entry_trust_summary(item)
        if not trust_summary:
            continue
        trust_signal_count += 1
        if not last_trust_summary:
            last_trust_summary = dict(trust_summary)
        trust_state = str(trust_summary.get("trust_state") or "unknown").strip() or "unknown"
        learning_label = str(trust_summary.get("learning_label") or "unlabeled").strip() or "unlabeled"
        approval_mode = str(trust_summary.get("approval_mode") or "none").strip() or "none"
        trust_state_counts[trust_state] += 1
        learning_label_counts[learning_label] += 1
        approval_mode_counts[approval_mode] += 1
    return {
        "trust_signal_count": trust_signal_count,
        "trust_state_counts": dict(trust_state_counts),
        "learning_label_counts": dict(learning_label_counts),
        "approval_mode_counts": dict(approval_mode_counts),
        "last_trust_summary": last_trust_summary,
    }


def _summarize_self_improvement_history_rows(rows: list[dict[str, Any]], project_root: Path) -> dict[str, Any]:
    latest_by_task: dict[str, dict[str, Any]] = {}
    latest_by_signature: dict[str, dict[str, Any]] = {}
    for item in rows:
        task_id = str(item.get("task_id") or "")
        if task_id and task_id not in latest_by_task:
            latest_by_task[task_id] = item
        signature = _self_improvement_history_signature(item)
        if signature and signature not in latest_by_signature:
            latest_by_signature[signature] = item
    trust_rollup = _summarize_history_trust_rows(rows)
    return {
        "entry_count": len(rows),
        "status_counts": dict(Counter(str(item.get("status") or "unknown") for item in rows)),
        "latest_by_task": latest_by_task,
        "latest_by_signature": latest_by_signature,
        "last_execution": dict(rows[0]) if rows else {},
        "artifact_path": str(assistant_self_improvement_history_path(project_root)),
        **trust_rollup,
    }


def summarize_self_improvement_history(project_root: Path, *, limit: int = 50) -> dict[str, Any]:
    rows = load_self_improvement_history(project_root, limit=limit)
    return _summarize_self_improvement_history_rows(rows, project_root)


def _apply_self_improvement_duplicate_guard(
    candidates: list[dict[str, Any]],
    history_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    latest_by_signature: dict[str, dict[str, Any]] = {}
    execution_count_by_signature: Counter[str] = Counter()
    for row in history_rows:
        signature = _self_improvement_history_signature(row)
        if not signature:
            continue
        execution_count_by_signature[signature] += 1
        if signature not in latest_by_signature:
            latest_by_signature[signature] = dict(row)

    adjusted: list[dict[str, Any]] = []
    duplicate_candidate_count = 0
    for candidate in candidates:
        updated = dict(candidate)
        metadata = dict(updated.get("metadata") or {})
        signature = _self_improvement_candidate_signature(
            updated.get("candidate_id") or updated.get("candidateId"),
            list(updated.get("target_paths") or updated.get("targetPaths") or []),
        )
        latest = dict(latest_by_signature.get(signature) or {})
        duplicate_count = int(execution_count_by_signature.get(signature, 0))
        status = str(latest.get("status") or "").strip().lower()
        penalty = float(_SELF_IMPROVEMENT_RECENT_DUPLICATE_PENALTIES.get(status, 0.0) if latest else 0.0)
        if penalty > 0.0:
            duplicate_candidate_count += 1
            updated["score"] = max(0.0, float(updated.get("score") or 0.0) - penalty)
            updated["recommended_next_step"] = "review-other-candidates-first"
            updated["advisory_reason_code"] = "recent_duplicate"
            updated["advisory_summary"] = "Recent self-improvement history already executed the same candidate and target-path signature."
        metadata.update(
            {
                "candidate_signature": signature,
                "recent_duplicate": penalty > 0.0,
                "recent_duplicate_count": duplicate_count,
                "recent_duplicate_penalty": penalty,
                "recent_duplicate_last_status": str(latest.get("status") or ""),
                "recent_duplicate_last_timestamp": str(latest.get("timestamp") or ""),
            }
        )
        updated["metadata"] = metadata
        adjusted.append(updated)

    return adjusted, {
        "duplicate_candidate_count": duplicate_candidate_count,
        "recent_signature_count": len(latest_by_signature),
    }


def load_runtime_history_artifacts(project_root: Path, *, limit: int = 40) -> list[dict[str, Any]]:
    candidates: list[Path] = []
    for base in (assistant_dev_runs_dir(project_root), assistant_runs_dir(project_root)):
        if not base.exists():
            continue
        candidates.extend(path for path in base.glob("*.json") if path.is_file())
    deduped: list[Path] = []
    seen: set[Path] = set()
    for path in sorted(candidates, key=lambda item: item.stat().st_mtime_ns if item.exists() else 0, reverse=True):
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        deduped.append(path)
    artifacts: list[dict[str, Any]] = []
    for path in deduped:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(payload, dict):
            continue
        if not any(key in payload for key in ("owner_summary", "review_summary", "runtime_result", "followup_report", "results")):
            continue
        artifacts.append({**payload, "_artifact_path": str(path)})
        if limit > 0 and len(artifacts) >= limit:
            break
    return artifacts


def _artifact_result_paths(payload: dict[str, Any]) -> list[str]:
    paths: list[str] = []
    for item in list(payload.get("results") or []) if isinstance(payload, dict) else []:
        if isinstance(item, dict) and str(item.get("path") or ""):
            paths.append(str(item.get("path") or ""))
    for action in list((payload.get("owner_summary") or {}).get("recommended_actions") or []):
        if isinstance(action, dict):
            paths.extend(str(path) for path in list(action.get("target_paths") or []) if str(path))
    for request in list(payload.get("review_requests") or []):
        if isinstance(request, dict):
            context = dict(request.get("context") or {})
            paths.extend(str(path) for path in list(context.get("target_paths") or []) if str(path))
    return filter_self_improvement_paths(paths)


def _self_improvement_experiment_row_targets(row: dict[str, Any]) -> list[str]:
    experiment_run = dict(row.get("experiment_run") or {})
    training_signals = dict(experiment_run.get("training_signals") or {})
    strategy_benchmark = dict(row.get("strategy_benchmark") or experiment_run.get("strategy_benchmark") or {})
    paths: list[str] = []
    paths.extend(str(path) for path in list(training_signals.get("repair_paths") or []) if str(path))
    paths.extend(str(path) for path in list(strategy_benchmark.get("preferred_files") or []) if str(path))
    return filter_self_improvement_paths(paths)


def _is_self_improvement_experiment_row(row: dict[str, Any]) -> bool:
    experiment_run = dict(row.get("experiment_run") or {})
    ticket = str(experiment_run.get("ticket") or row.get("ticket") or "").strip().lower()
    if ticket.startswith("self-") or ticket.startswith("self-task-"):
        return True
    return bool(_self_improvement_experiment_row_targets(row))


def _normalize_difficulty(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    return normalized if normalized in _DIFFICULTY_LEVELS else "medium"


def _difficulty_score_nudge(value: Any) -> float:
    return float(_DIFFICULTY_SCORE_NUDGES.get(_normalize_difficulty(value), 0.0))


def _difficulty_rank(value: Any) -> int:
    normalized = _normalize_difficulty(value)
    try:
        return _DIFFICULTY_LEVELS.index(normalized)
    except ValueError:
        return _DIFFICULTY_LEVELS.index(_TESTING_WEEK_PREFERRED_DIFFICULTY)


def _difficulty_within_budget(value: Any, max_difficulty: Any) -> bool:
    return _difficulty_rank(value) <= _difficulty_rank(max_difficulty)


def _preferred_self_improvement_difficulty(history_summary: dict[str, Any] | None = None) -> str:
    summary = dict(history_summary or {})
    status_counts = dict(summary.get("status_counts") or {})
    trust_state_counts = dict(summary.get("trust_state_counts") or {})
    successful_runs = int(status_counts.get("succeeded") or 0) + int(status_counts.get("review") or 0)
    failed_runs = int(status_counts.get("failed") or 0) + int(status_counts.get("blocked") or 0)
    trusted_runs = int(trust_state_counts.get("trusted") or 0)
    if successful_runs >= 8 and trusted_runs >= 4 and failed_runs <= 1:
        return "high"
    if successful_runs >= 3 and trusted_runs >= 1 and failed_runs <= 2:
        return "medium"
    return _TESTING_WEEK_PREFERRED_DIFFICULTY


def _difficulty_counts(items: list[dict[str, Any]]) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for item in items:
        metadata = dict(item.get("metadata") or {}) if isinstance(item, dict) else {}
        counts[_normalize_difficulty(metadata.get("difficulty"))] += 1
    return {level: int(counts.get(level, 0)) for level in _DIFFICULTY_LEVELS}


def _infer_self_improvement_difficulty(
    kind: str,
    *,
    target_paths: list[str],
    occurrences: int,
    severity: int = 0,
) -> str:
    target_count = len([path for path in list(target_paths or []) if str(path)])
    if kind == "operator-seed":
        if severity >= 8 or target_count >= 3 or occurrences >= 5:
            return "high"
        if severity >= 4 or target_count >= 2 or occurrences >= 2:
            return "medium"
        return "low"
    if kind in {"memory-hotspot", "owner-summary"}:
        return "low" if target_count <= 2 and occurrences <= 3 and severity <= 4 else "medium"
    if kind == "benchmark-hotspot":
        return "low" if target_count <= 1 and severity <= 3 else "medium"
    if kind in {"review-outcome", "repeated-failure"}:
        return "medium" if target_count <= 1 and occurrences <= 3 and severity <= 6 else "high"
    return "medium"


def _infer_project_maintenance_difficulty(
    kind: str,
    *,
    target_paths: list[str],
    occurrences: int,
    severity: int = 0,
) -> str:
    target_count = len([path for path in list(target_paths or []) if str(path)])
    if kind in {"missing-tests", "docs-gap"}:
        return "low" if target_count <= 4 and occurrences <= 6 else "medium"
    if kind == "owner-requested-maintenance":
        return "low" if target_count <= 2 and occurrences <= 3 else "medium"
    if kind in {"baseline-hotspot", "repeated-failure"}:
        return "medium" if target_count <= 2 and severity <= 6 else "high"
    return "medium"


def _infer_owner_goal_difficulty(category: str, *, explicit_target_count: int, filtered_target_count: int) -> str:
    if category in {"documentation", "analysis/reporting"}:
        return "low"
    if category == "testing":
        return "low" if filtered_target_count <= 3 else "medium"
    if category == "maintenance":
        return "low" if explicit_target_count > 0 and filtered_target_count <= 1 else "medium"
    if category == "cleanup":
        return "medium"
    if category == "scaffolding":
        return "medium" if filtered_target_count <= 2 else "high"
    return "medium"


def _infer_owner_automation_difficulty(
    category: str,
    *,
    target_paths: list[str],
    explicit_targets: bool,
    reused_signals: int,
) -> str:
    target_count = len([path for path in list(target_paths or []) if str(path)])
    if category in {"documentation", "analysis/reporting"}:
        return "low"
    if category == "testing":
        return "low" if target_count <= 3 else "medium"
    if category == "maintenance":
        if explicit_targets and target_count <= 1 and reused_signals <= 1:
            return "low"
        return "medium" if target_count <= 3 else "high"
    if category == "cleanup":
        return "medium" if target_count <= 2 else "high"
    if category == "scaffolding":
        return "medium" if explicit_targets and target_count <= 2 else "high"
    return "medium"


def _candidate_score(kind: str, *, occurrences: int, eligible: bool, severity: int = 0, difficulty: str = "medium") -> float:
    base_scores = {
        "operator-seed": 84.0,
        "review-outcome": 86.0,
        "repeated-failure": 82.0,
        "memory-hotspot": 78.0,
        "benchmark-hotspot": 74.0,
        "owner-summary": 70.0,
    }
    score = float(base_scores.get(kind, 60.0))
    score += min(20.0, float(max(occurrences, 0)) * 4.0)
    score += float(max(severity, 0))
    score += _difficulty_score_nudge(difficulty)
    score -= 35.0 if not eligible else 0.0
    return score


def _candidate_score_breakdown(
    kind: str,
    *,
    occurrences: int,
    eligible: bool,
    severity: int = 0,
    difficulty: str = "medium",
    target_count: int = 0,
) -> dict[str, float]:
    base_scores = {
        "operator-seed": 84.0,
        "review-outcome": 86.0,
        "repeated-failure": 82.0,
        "memory-hotspot": 78.0,
        "benchmark-hotspot": 74.0,
        "owner-summary": 70.0,
    }
    normalized_difficulty = _normalize_difficulty(difficulty)
    complexity = {"low": 20.0, "medium": 55.0, "high": 85.0}.get(normalized_difficulty, 55.0)
    impact = min(100.0, float(base_scores.get(kind, 60.0)) + min(20.0, float(max(occurrences, 0)) * 4.0) + float(max(severity, 0)) * 2.0)
    safety = max(0.0, min(100.0, (88.0 if eligible else 28.0) + (8.0 if normalized_difficulty == "low" else (-12.0 if normalized_difficulty == "high" else 0.0))))
    testability = max(10.0, min(100.0, 86.0 - (float(max(target_count - 1, 0)) * 10.0) - (15.0 if not eligible else 0.0)))
    resource_cost = max(5.0, min(100.0, complexity + float(max(target_count - 1, 0)) * 10.0 + (0.0 if eligible else 15.0)))
    return {
        "impact": round(impact, 2),
        "safety": round(safety, 2),
        "complexity": round(complexity, 2),
        "testability": round(testability, 2),
        "resource_cost": round(resource_cost, 2),
    }


def _default_self_improvement_candidate_guidance(*, eligible: bool, eligibility_reason: str) -> tuple[str, str, str]:
    if eligible:
        return (
            "prepare-runtime-execution",
            "eligible",
            "Candidate is ready for a bounded self-improvement slice.",
        )
    return (
        "manual-self-improvement-triage",
        "blocked_no_self_paths",
        str(eligibility_reason or "Candidate did not resolve to assistant-owned engine paths."),
    )


def _build_candidate(
    *,
    candidate_id: str,
    kind: str,
    source: str,
    title: str,
    summary: str,
    occurrences: int,
    target_paths: list[str],
    source_tickets: list[str],
    artifact_paths: list[str],
    eligibility_reason: str,
    evidence: dict[str, Any] | None = None,
    severity: int = 0,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    eligible = bool(target_paths)
    difficulty = _infer_self_improvement_difficulty(
        kind,
        target_paths=target_paths,
        occurrences=occurrences,
        severity=severity,
    )
    score = _candidate_score(
        kind,
        occurrences=occurrences,
        eligible=eligible,
        severity=severity,
        difficulty=difficulty,
    )
    score_breakdown = _candidate_score_breakdown(
        kind,
        occurrences=occurrences,
        eligible=eligible,
        severity=severity,
        difficulty=difficulty,
        target_count=len([path for path in list(target_paths or []) if str(path)]),
    )
    metadata = {
        **dict(metadata or {}),
        "difficulty": difficulty,
        "difficulty_nudge": _difficulty_score_nudge(difficulty),
        "testing_week_preference": _TESTING_WEEK_PREFERRED_DIFFICULTY,
        "score_breakdown": score_breakdown,
    }
    recommended_next_step, advisory_reason_code, advisory_summary = _default_self_improvement_candidate_guidance(
        eligible=eligible,
        eligibility_reason=str(eligibility_reason or ""),
    )
    candidate = build_self_improvement_candidate(
        candidate_id=candidate_id,
        kind=kind,
        source=source,
        title=title,
        summary=summary,
        priority=_self_improvement_priority(score),
        score=score,
        occurrences=occurrences,
        eligible=eligible,
        eligibility_reason=("" if eligible else str(eligibility_reason or "no engine-owned target paths available")),
        recommended_next_step=recommended_next_step,
        advisory_reason_code=advisory_reason_code,
        advisory_summary=advisory_summary,
        target_paths=target_paths,
        source_tickets=source_tickets,
        evidence=evidence,
        artifact_paths=artifact_paths,
        metadata=metadata,
    )
    return candidate


def _candidate_backlog_entry(candidate: dict[str, Any], prepared_task_id: str = "") -> dict[str, Any]:
    metadata = dict(candidate.get("metadata") or {})
    recent_duplicate = bool(metadata.get("recent_duplicate", False))
    status = "prepared" if candidate.get("eligible") else "blocked"
    if recent_duplicate:
        status = "deprioritized"
    return {
        "ticket": str(prepared_task_id or candidate.get("candidate_id") or ""),
        "title": str(candidate.get("title") or ""),
        "status": status,
        "priority": str(candidate.get("priority") or "medium"),
        "kind": str(candidate.get("kind") or ""),
        "bat_bucket": "assistant_runtime",
        "tags": ["OPS", "BE"],
        "reason_code": str(candidate.get("advisory_reason_code") or ""),
        "recommended_action": str(candidate.get("recommended_next_step") or ""),
        "summary": str(candidate.get("advisory_summary") or candidate.get("summary") or ""),
        "target_paths": [str(path) for path in list(candidate.get("target_paths") or []) if str(path)],
        "source_tickets": [str(ticket) for ticket in list(candidate.get("source_tickets") or []) if str(ticket)],
        "score": float(candidate.get("score") or 0.0),
        "score_breakdown": dict(metadata.get("score_breakdown") or {}),
        "duplicate_guard": {
            "recent_duplicate": recent_duplicate,
            "recent_duplicate_count": int(metadata.get("recent_duplicate_count") or 0),
            "recent_duplicate_last_status": str(metadata.get("recent_duplicate_last_status") or ""),
        },
    }


def _normalize_self_improvement_task_token(value: Any, fallback: str) -> str:
    raw = str(value or "").strip().lower()
    token = "".join(char if char.isalnum() else "-" for char in raw).strip("-")
    while "--" in token:
        token = token.replace("--", "-")
    token = token[:72].strip("-")
    return token or fallback


def _self_improvement_task_identity(candidate: dict[str, Any], index: int) -> tuple[str, str]:
    metadata = dict(candidate.get("metadata") or {})
    base = (
        str(metadata.get("seed_id") or "").strip()
        or str(candidate.get("candidate_id") or "").strip()
        or f"slice-{index:03d}"
    )
    token = _normalize_self_improvement_task_token(base, f"slice-{index:03d}")
    return (f"self-task-{token}", f"self-{token}")


def summarize_self_improvement_work(
    project_root: Path,
    *,
    history_limit: int = 40,
    max_candidates: int = 8,
    experiment_rows: list[dict[str, Any]] | None = None,
    memory_entries: list[dict[str, Any]] | None = None,
    run_artifacts: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    artifacts = [dict(item) for item in list(run_artifacts or load_runtime_history_artifacts(project_root, limit=history_limit)) if isinstance(item, dict)]
    memory_rows = [dict(item) for item in list(memory_entries or load_memory(project_root)) if isinstance(item, dict)]
    dataset_rows = [dict(item) for item in list(experiment_rows or load_experiment_dataset(project_root)) if isinstance(item, dict)]
    history_rows = load_self_improvement_history(project_root, limit=history_limit)
    history_summary = _summarize_self_improvement_history_rows(history_rows, project_root)
    preferred_difficulty = _preferred_self_improvement_difficulty(history_summary)
    artifact_paths = [str(item.get("_artifact_path") or "") for item in artifacts if str(item.get("_artifact_path") or "")]
    candidates: list[dict[str, Any]] = []

    failure_summary = summarize_failure_patterns(project_root, limit=history_limit)
    recurring_blockers = [dict(item) for item in list(failure_summary.get("recurring_blockers") or []) if isinstance(item, dict)]
    failed_entries = [entry for entry in memory_rows if str(entry.get("validation") or "") == "failed"]
    failure_paths = filter_self_improvement_paths(
        [
            str(path)
            for entry in failed_entries
            for path in list(entry.get("files_written") or [])
            if str(path)
        ]
    )
    failure_tickets = sorted({str(entry.get("ticket") or "") for entry in failed_entries if str(entry.get("ticket") or "")})
    if recurring_blockers or failure_paths:
        blocker_labels = ", ".join(str(item.get("label") or "") for item in recurring_blockers[:3] if str(item.get("label") or ""))
        candidates.append(
            _build_candidate(
                candidate_id="self-repeated-failure",
                kind="repeated-failure",
                source="memory.failure_patterns",
                title="Reduce repeated assistant runtime failures",
                summary=(
                    f"Recurring failure blockers detected: {blocker_labels}."
                    if blocker_labels
                    else "Repeated assistant runtime failures detected from memory history."
                ),
                occurrences=max(int(failure_summary.get("repeat_count") or 0), len(recurring_blockers), len(failure_tickets), 1),
                target_paths=failure_paths[:5],
                source_tickets=failure_tickets[:8],
                artifact_paths=artifact_paths[:6],
                eligibility_reason="repeated failures did not map to engine-owned files",
                evidence={
                    "recurring_blockers": recurring_blockers,
                    "recommended_response": str(failure_summary.get("recommended_response") or ""),
                },
                severity=6 if str(failure_summary.get("recommended_response") or "") == "self_heal" else 0,
            )
        )

    safe_failure_file_counter: Counter[str] = Counter(
        str(path)
        for entry in failed_entries
        for path in list(entry.get("files_written") or [])
        if is_self_improvement_path(str(path or ""))
    )
    if safe_failure_file_counter:
        hotspot_path, hotspot_count = safe_failure_file_counter.most_common(1)[0]
        hotspot_tickets = sorted(
            {
                str(entry.get("ticket") or "")
                for entry in failed_entries
                if hotspot_path in [str(path) for path in list(entry.get("files_written") or [])]
                and str(entry.get("ticket") or "")
            }
        )
        candidates.append(
            _build_candidate(
                candidate_id="self-memory-hotspot",
                kind="memory-hotspot",
                source="memory.failed_file_hotspots",
                title=f"Stabilize self-improvement hotspot in {hotspot_path}",
                summary=f"The same engine-owned path appears in {hotspot_count} failed memory entries.",
                occurrences=hotspot_count,
                target_paths=[hotspot_path],
                source_tickets=hotspot_tickets[:8],
                artifact_paths=artifact_paths[:6],
                eligibility_reason="memory hotspot did not resolve to engine-owned paths",
                evidence={"path": hotspot_path, "count": hotspot_count},
                severity=4,
            )
        )

    rejected_count = 0
    deferred_count = 0
    review_targets: list[str] = []
    review_tickets: list[str] = []
    review_artifacts: list[str] = []
    for artifact in artifacts:
        review_state = dict(artifact.get("review_state") or (artifact.get("review_summary") or {}).get("review_state") or {})
        review_requests = [dict(item) for item in list(artifact.get("review_requests") or []) if isinstance(item, dict)]
        local_rejected = int(review_state.get("rejected_count") or 0)
        local_deferred = int(review_state.get("deferred_count") or 0)
        if not local_rejected and not local_deferred:
            local_rejected = sum(1 for item in review_requests if str(item.get("state") or item.get("status") or "") == "rejected")
            local_deferred = sum(1 for item in review_requests if str(item.get("state") or item.get("status") or "") == "deferred")
        if not local_rejected and not local_deferred:
            continue
        rejected_count += local_rejected
        deferred_count += local_deferred
        review_targets.extend(_artifact_result_paths(artifact))
        if str(artifact.get("ticket") or ""):
            review_tickets.append(str(artifact.get("ticket") or ""))
        if str(artifact.get("_artifact_path") or ""):
            review_artifacts.append(str(artifact.get("_artifact_path") or ""))
    if rejected_count or deferred_count:
        candidates.append(
            _build_candidate(
                candidate_id="self-review-outcomes",
                kind="review-outcome",
                source="review.rejected_or_deferred",
                title="Resolve rejected or deferred self-improvement reviews",
                summary=(
                    f"Review history includes {rejected_count} rejected and {deferred_count} deferred self-path outcomes."
                ),
                occurrences=rejected_count + deferred_count,
                target_paths=filter_self_improvement_paths(review_targets)[:5],
                source_tickets=sorted({ticket for ticket in review_tickets if ticket})[:8],
                artifact_paths=sorted({path for path in review_artifacts if path})[:8],
                eligibility_reason="review outcomes did not reference engine-owned paths",
                evidence={"rejected_count": rejected_count, "deferred_count": deferred_count},
                severity=8,
            )
        )

    owner_action_count = 0
    owner_targets: list[str] = []
    owner_tickets: list[str] = []
    owner_titles: list[str] = []
    owner_artifacts: list[str] = []
    for artifact in artifacts:
        owner_summary = dict(artifact.get("owner_summary") or {})
        recommended_actions = [dict(item) for item in list(owner_summary.get("recommended_actions") or []) if isinstance(item, dict)]
        if not recommended_actions:
            continue
        owner_action_count += len(recommended_actions)
        owner_targets.extend(_artifact_result_paths(artifact))
        owner_titles.extend(str(item.get("title") or "") for item in recommended_actions if str(item.get("title") or ""))
        if str(artifact.get("ticket") or ""):
            owner_tickets.append(str(artifact.get("ticket") or ""))
        if str(artifact.get("_artifact_path") or ""):
            owner_artifacts.append(str(artifact.get("_artifact_path") or ""))
    if owner_action_count:
        candidates.append(
            _build_candidate(
                candidate_id="self-owner-summary",
                kind="owner-summary",
                source="owner_summary.recommended_actions",
                title="Follow owner-facing self-improvement signals",
                summary=(
                    "Owner summaries already recommend follow-up work for self-owned paths"
                    + (f": {', '.join(owner_titles[:3])}." if owner_titles else ".")
                ),
                occurrences=owner_action_count,
                target_paths=filter_self_improvement_paths(owner_targets)[:5],
                source_tickets=sorted({ticket for ticket in owner_tickets if ticket})[:8],
                artifact_paths=sorted({path for path in owner_artifacts if path})[:8],
                eligibility_reason="owner summaries did not reference engine-owned paths",
                evidence={"recommended_titles": owner_titles[:5]},
                severity=2,
            )
        )

    self_experiment_rows = [row for row in dataset_rows if _is_self_improvement_experiment_row(row)]
    benchmark_summary = summarize_experiment_dataset(project_root, rows=self_experiment_rows) if self_experiment_rows else {}
    weakest_strategy = str((benchmark_summary.get("weakest_strategy") or {}).get("strategy") or "")
    weakest_tickets = [
        str((row.get("experiment_run") or {}).get("ticket") or row.get("ticket") or "")
        for row in self_experiment_rows
        if weakest_strategy
        and str((row.get("experiment_run") or {}).get("strategy") or row.get("strategy") or "") == weakest_strategy
        and str((row.get("experiment_scorecard") or {}).get("status") or (row.get("experiment_run") or {}).get("status") or "").lower() in {"failed", "blocked"}
    ]
    benchmark_targets: list[str] = []
    for row in self_experiment_rows:
        row_ticket = str((row.get("experiment_run") or {}).get("ticket") or row.get("ticket") or "")
        if row_ticket in weakest_tickets:
            benchmark_targets.extend(_self_improvement_experiment_row_targets(row))
    for artifact in artifacts:
        if str(artifact.get("ticket") or "") in weakest_tickets:
            benchmark_targets.extend(_artifact_result_paths(artifact))
    if benchmark_summary:
        repeated_blockers = [dict(item) for item in list(benchmark_summary.get("repeated_blockers") or []) if isinstance(item, dict)]
        candidates.append(
            _build_candidate(
                candidate_id="self-benchmark-hotspot",
                kind="benchmark-hotspot",
                source="experiment.benchmark_summary",
                title="Address benchmark weak spots in self-improvement history",
                summary=(
                    f"Weakest observed strategy: {weakest_strategy or 'unknown'}; recommended next action: {str(benchmark_summary.get('recommended_next_action') or 'inspect-artifacts')}."
                ),
                occurrences=max(len(weakest_tickets), int((repeated_blockers[0].get("count") or 0) if repeated_blockers else 0), 1),
                target_paths=filter_self_improvement_paths(benchmark_targets)[:5],
                source_tickets=sorted({ticket for ticket in weakest_tickets if ticket})[:8],
                artifact_paths=[str(benchmark_summary.get("dataset_path") or ""), *artifact_paths[:4]],
                eligibility_reason="benchmark hotspots did not map to engine-owned paths",
                evidence={
                    "weakest_strategy": dict(benchmark_summary.get("weakest_strategy") or {}),
                    "repeated_blockers": repeated_blockers[:5],
                    "recommended_next_action": str(benchmark_summary.get("recommended_next_action") or ""),
                },
                severity=4 if repeated_blockers else 0,
            )
        )

    seed_rows = load_self_improvement_seeds(project_root, limit=max(history_limit, max_candidates * 2, 8), active_only=True)
    seed_artifact_path = str(assistant_self_improvement_seed_path(project_root))
    for seed in seed_rows:
        seed_id = str(seed.get("seed_id") or seed.get("seedId") or "").strip()
        if not seed_id:
            continue
        raw_targets = [str(path) for path in list(seed.get("target_paths") or seed.get("targetPaths") or []) if str(path)]
        title = str(seed.get("title") or "").strip() or f"Operator-seeded self-improvement for {raw_targets[0] if raw_targets else seed_id}"
        summary_text = str(seed.get("summary") or seed.get("objective") or "").strip() or f"Operator-seeded self-improvement slice for {', '.join(raw_targets[:2])}."
        candidates.append(
            _build_candidate(
                candidate_id=f"self-seed-{seed_id}",
                kind="operator-seed",
                source="operator.seed",
                title=title,
                summary=summary_text,
                occurrences=max(int(seed.get("occurrences") or 1), 1),
                target_paths=filter_self_improvement_paths(raw_targets)[:5],
                source_tickets=[str(ticket) for ticket in list(seed.get("source_tickets") or seed.get("sourceTickets") or []) if str(ticket)],
                artifact_paths=[seed_artifact_path] if seed_artifact_path else [],
                eligibility_reason="seeded request did not resolve to assistant-owned paths",
                evidence={
                    "seed_id": seed_id,
                    "requested_by": str(seed.get("requested_by") or seed.get("requestedBy") or "operator"),
                    "notes": str(seed.get("notes") or ""),
                },
                severity=int(seed.get("severity") or 0),
                metadata={
                    "seed_id": seed_id,
                    "seed_status": str(seed.get("status") or "active"),
                    "requested_by": str(seed.get("requested_by") or seed.get("requestedBy") or "operator"),
                },
            )
        )

    candidates = [dict(item) for item in candidates if isinstance(item, dict)]
    candidates, duplicate_guard = _apply_self_improvement_duplicate_guard(candidates, history_rows)
    candidates.sort(
        key=lambda item: (
            float(item.get("score", 0.0)),
            bool(item.get("eligible", False)),
            int(item.get("occurrences", 0)),
            str(item.get("title") or ""),
        ),
        reverse=True,
    )
    if max_candidates > 0:
        candidates = candidates[:max_candidates]

    prepared_tasks: list[dict[str, Any]] = []
    latest_by_task = dict(history_summary.get("latest_by_task") or {})
    eligible_candidates = [item for item in candidates if item.get("eligible")]
    bounded_candidates = [
        item
        for item in eligible_candidates
        if _difficulty_within_budget((item.get("metadata") or {}).get("difficulty"), preferred_difficulty)
    ]
    for index, candidate in enumerate(bounded_candidates[:SELF_IMPROVEMENT_TASK_LIMIT], start=1):
        title = str(candidate.get("title") or f"Self improvement task {index}")
        target_paths = [str(path) for path in list(candidate.get("target_paths") or []) if str(path)]
        task_id, ticket_id = _self_improvement_task_identity(candidate, index)
        latest_execution = dict(latest_by_task.get(task_id) or {})
        objective = (
            f"{candidate.get('summary') or title} Stay within self-owned engine paths only: "
            + ", ".join(target_paths[:4])
        )
        runtime_task = build_runtime_task(
            ticket_id=ticket_id,
            desc=objective,
            action="implement",
            mode="integrate",
            run_mode="manual",
            editor_context={},
            host_boundary={
                "self_improvement_only": True,
                "approval_protected_only": True,
            },
            requested_capabilities={
                "write": True,
                "execute": True,
                "repair": True,
                "confirm": True,
            },
            metadata={
                "source_candidate_id": str(candidate.get("candidate_id") or ""),
                "target_paths": target_paths,
                "kind": str(candidate.get("kind") or ""),
                "self_improvement_task_id": task_id,
                "difficulty": str((candidate.get("metadata") or {}).get("difficulty") or "medium"),
                "seed_id": str((candidate.get("metadata") or {}).get("seed_id") or ""),
            },
        )
        prepared_tasks.append(
            build_self_improvement_task(
                task_id=task_id,
                candidate_id=str(candidate.get("candidate_id") or ""),
                title=title,
                objective=objective,
                priority=str(candidate.get("priority") or "medium"),
                status=str(latest_execution.get("status") or "prepared"),
                action="implement",
                mode="integrate",
                target_paths=target_paths,
                host_boundary={
                    "self_improvement_only": True,
                    "approval_protected_only": True,
                },
                runtime_task=runtime_task,
                metadata={
                    "source": str(candidate.get("source") or ""),
                    "source_tickets": list(candidate.get("source_tickets") or []),
                    "difficulty": str((candidate.get("metadata") or {}).get("difficulty") or "medium"),
                    "seed_id": str((candidate.get("metadata") or {}).get("seed_id") or ""),
                    "score_breakdown": dict((candidate.get("metadata") or {}).get("score_breakdown") or {}),
                    "recent_duplicate": bool((candidate.get("metadata") or {}).get("recent_duplicate", False)),
                    "recent_duplicate_count": int((candidate.get("metadata") or {}).get("recent_duplicate_count", 0) or 0),
                    "recent_duplicate_last_status": str((candidate.get("metadata") or {}).get("recent_duplicate_last_status") or ""),
                    "recent_duplicate_last_timestamp": str((candidate.get("metadata") or {}).get("recent_duplicate_last_timestamp") or ""),
                    "last_execution": latest_execution,
                },
            )
        )

    prepared_task_ids = {str(item.get("candidate_id") or ""): str(item.get("task_id") or "") for item in prepared_tasks}
    backlog_export = [_candidate_backlog_entry(candidate, prepared_task_ids.get(str(candidate.get("candidate_id") or ""), "")) for candidate in candidates]
    queue_summary = build_self_improvement_queue_summary(
        queue_id=f"self-improvement-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
        summary=(
            f"Prepared {len(prepared_tasks)} self-improvement task(s) from {len(candidates)} candidate(s)."
            if candidates
            else "No self-improvement candidates are ready yet."
        ),
        total_candidates=len(candidates),
        eligible_candidate_count=len(eligible_candidates),
        blocked_candidate_count=max(0, len(candidates) - len(eligible_candidates)),
        prepared_task_count=len(prepared_tasks),
        source_counts=dict(Counter(str(item.get("kind") or "unknown") for item in candidates)),
        top_candidates=candidates[:5],
        prepared_tasks=prepared_tasks,
        artifact_paths=[
            str(path)
            for path in [assistant_self_improvement_queue_path(project_root), history_summary.get("artifact_path"), seed_artifact_path, *(artifact_paths[:6]), str(benchmark_summary.get("dataset_path") or "")]
            if str(path or "")
        ],
        metadata={
            "history_limit": int(history_limit or 0),
            "self_path_prefixes": list(ASSISTANT_SELF_PATH_PREFIXES),
            "history_entry_count": int(history_summary.get("entry_count") or 0),
            "execution_status_counts": dict(history_summary.get("status_counts") or {}),
            "last_execution": dict(history_summary.get("last_execution") or {}),
            "trust_signal_count": int(history_summary.get("trust_signal_count") or 0),
            "trust_state_counts": dict(history_summary.get("trust_state_counts") or {}),
            "learning_label_counts": dict(history_summary.get("learning_label_counts") or {}),
            "approval_mode_counts": dict(history_summary.get("approval_mode_counts") or {}),
            "last_trust_summary": dict(history_summary.get("last_trust_summary") or {}),
            "preferred_difficulty": preferred_difficulty,
            "candidate_difficulty_counts": _difficulty_counts(candidates),
            "prepared_task_difficulty_counts": _difficulty_counts(prepared_tasks),
            "recent_duplicate_candidate_count": int(duplicate_guard.get("duplicate_candidate_count") or 0),
            "recent_duplicate_signature_count": int(duplicate_guard.get("recent_signature_count") or 0),
            "recent_duplicate_prepared_task_count": sum(
                1
                for item in prepared_tasks
                if bool((item.get("metadata") or {}).get("recent_duplicate", False))
            ),
            "seed_candidate_count": sum(1 for item in candidates if str(item.get("kind") or "") == "operator-seed"),
            "backlog_export_count": len(backlog_export),
            "score_visibility": backlog_export[:5],
        },
    )
    top_candidate = dict(eligible_candidates[0]) if eligible_candidates else (dict(candidates[0]) if candidates else {})
    top_task = dict(prepared_tasks[0]) if prepared_tasks else {}
    recommendation = build_self_improvement_recommendation(
        recommendation_id=f"self-improvement-rec-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
        summary=(
            f"Prepare normal runtime execution for {top_candidate.get('title', 'the leading self-improvement candidate')}."
            if top_task
            else (
                f"Manual triage required for {top_candidate.get('title', 'the leading self-improvement candidate')}."
                if top_candidate
                else "Collect more history before preparing self-improvement work."
            )
        ),
        recommended_action=(
            "prepare-runtime-execution"
            if top_task
            else ("manual-self-improvement-triage" if top_candidate else "observe-more-history")
        ),
        priority=str(top_candidate.get("priority") or "low"),
        candidate=top_candidate,
        task=top_task,
        artifact_paths=list(queue_summary.get("artifact_paths") or []),
        metadata={
            "eligible_candidate_count": len(eligible_candidates),
            "preferred_difficulty": preferred_difficulty,
            "candidate_difficulty_counts": _difficulty_counts(candidates),
            "recommended_difficulty": str((top_candidate.get("metadata") or {}).get("difficulty") or "medium"),
        },
    )
    return {
        "queue_summary": queue_summary,
        "recommendation": recommendation,
        "candidates": candidates,
        "prepared_tasks": prepared_tasks,
        "backlog_export": backlog_export,
        "history_summary": history_summary,
    }


def build_self_improvement_export_path(project_root: Path, payload: dict[str, Any], *, suffix: str = "queue") -> Path:
    moment = _payload_datetime(payload)
    return assistant_self_improvement_dir(project_root) / f"{moment.strftime('%Y%m%dT%H%M%S')}-{suffix}.json"


def write_self_improvement_export(project_root: Path, payload: dict[str, Any], *, target: Path | None = None, suffix: str = "queue") -> Path | None:
    resolved_target = target or build_self_improvement_export_path(project_root, payload, suffix=suffix)
    try:
        resolved_target.parent.mkdir(parents=True, exist_ok=True)
        resolved_target.write_text(json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8")
        return resolved_target
    except Exception:
        return None


def _safe_write_json(target: Path, payload: dict[str, Any]) -> Path | None:
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload, indent=2, default=str) + "\n", encoding="utf-8")
        return target
    except Exception:
        return None


def _normalize_project_target_path(project_root: Path, raw_path: str) -> str:
    text = str(raw_path or "").strip()
    if not text:
        return ""
    root = project_root.resolve()
    candidate = Path(text).expanduser()
    try:
        resolved = candidate.resolve() if candidate.is_absolute() else (root / candidate).resolve()
        relative = resolved.relative_to(root)
    except Exception:
        return ""
    normalized = str(relative).replace("\\", "/")
    return normalized if normalized and not normalized.startswith("../") else ""


def _filter_project_target_paths(project_root: Path, paths: list[str] | None = None) -> list[str]:
    filtered: list[str] = []
    seen: set[str] = set()
    for raw_path in list(paths or []):
        normalized = _normalize_project_target_path(project_root, str(raw_path or ""))
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        filtered.append(normalized)
    return filtered


def _project_language_key(path: str) -> str:
    suffix = Path(path).suffix.lower()
    mapping = {
        ".py": "python",
        ".ts": "typescript",
        ".tsx": "typescript-react",
        ".js": "javascript",
        ".jsx": "javascript-react",
        ".md": "markdown",
        ".json": "json",
        ".yaml": "yaml",
        ".yml": "yaml",
        ".toml": "toml",
        ".html": "html",
        ".css": "css",
        ".scss": "scss",
        ".sql": "sql",
        ".sh": "shell",
    }
    return mapping.get(suffix, suffix.lstrip(".") or "other")


def _project_group_root(path: str) -> str:
    parts = Path(path).parts
    if not parts:
        return ""
    if parts[0] in {"backend", "frontend"} and len(parts) > 1:
        return "/".join(parts[:2])
    return parts[0]


def _is_test_path(path: str) -> bool:
    normalized = str(path or "")
    name = Path(normalized).name.lower()
    return (
        "/tests/" in f"/{normalized}/"
        or "/__tests__/" in f"/{normalized}/"
        or name.startswith("test_")
        or ".test." in name
        or ".spec." in name
    )


def _is_doc_path(path: str) -> bool:
    normalized = str(path or "")
    return normalized == "README.md" or normalized.startswith("docs/") or Path(normalized).suffix.lower() == ".md"


def _suggest_test_path(source_path: str) -> str:
    target = Path(source_path)
    stem = target.stem
    suffix = target.suffix.lower()
    if suffix == ".py":
        if source_path.startswith("backend/"):
            return f"backend/tests/test_{stem}.py"
        return f"tests/test_{stem}.py"
    if suffix in {".ts", ".tsx", ".js", ".jsx"}:
        test_suffix = ".test" + suffix
        if source_path.startswith("frontend/"):
            return f"frontend/tests/{stem}{test_suffix}"
        return f"tests/{stem}{test_suffix}"
    return ""


def _project_kind(paths: list[str]) -> str:
    has_backend = any(path.startswith("backend/") or path.startswith("app/") for path in paths)
    has_frontend = any(path.startswith("frontend/") for path in paths)
    has_tools = any(path.startswith("tools/") for path in paths)
    if has_backend and has_frontend:
        return "mixed-fullstack"
    if has_backend and has_tools:
        return "backend-with-tooling"
    if has_backend:
        return "backend-service"
    if has_frontend:
        return "frontend-app"
    return "generic-codebase"


def _maintenance_priority(score: float) -> str:
    if score >= 85.0:
        return "high"
    if score >= 65.0:
        return "medium"
    return "low"


def _maintenance_score(kind: str, *, occurrences: int, eligible: bool, severity: int = 0) -> float:
    base = {
        "baseline-hotspot": 84.0,
        "repeated-failure": 80.0,
        "missing-tests": 72.0,
        "owner-requested-maintenance": 70.0,
        "docs-gap": 64.0,
    }.get(kind, 60.0)
    score = float(base + min(20, max(occurrences, 0) * 3) + max(severity, 0))
    if not eligible:
        score -= 35.0
    return score


def _normalize_goal_text(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def _owner_goal_category(*, raw_goal: str, category_hint: str = "") -> str:
    hint = _normalize_goal_text(category_hint).lower()
    if hint in _OWNER_AUTOMATION_CATEGORIES:
        return hint
    text = _normalize_goal_text(raw_goal).lower()
    if any(token in text for token in ("scaffold", "bootstrap", "create module", "create package", "factory")):
        return "scaffolding"
    if any(token in text for token in ("document", "docs", "readme", "architecture", "api overview")):
        return "documentation"
    if any(token in text for token in ("test", "coverage", "pytest", "spec", "qa")):
        return "testing"
    if any(token in text for token in ("cleanup", "clean up", "remove dead", "prune", "tidy", "refactor")):
        return "cleanup"
    if any(token in text for token in ("report", "analyze", "analysis", "summary", "audit", "profile")):
        return "analysis/reporting"
    return "maintenance"


def _owner_goal_priority(category: str, raw_goal: str) -> str:
    text = _normalize_goal_text(raw_goal).lower()
    if any(token in text for token in ("urgent", "critical", "blocker", "broken", "failing")):
        return "high"
    if category in {"maintenance", "testing"}:
        return "high"
    if category in {"cleanup", "documentation", "scaffolding"}:
        return "medium"
    return "low"


def _owner_goal_title(raw_goal: str, fallback: str) -> str:
    text = _normalize_goal_text(raw_goal)
    if not text:
        return fallback
    sentence = text.split(".", 1)[0].strip()
    return sentence[:96] if sentence else fallback


def _owner_automation_action(category: str) -> str:
    return "run" if category == "analysis/reporting" else "implement"


def _owner_automation_mode(category: str) -> str:
    return "review" if category == "analysis/reporting" else "integrate"


def _owner_automation_score(category: str, *, eligible: bool, explicit_targets: bool, reused_signals: int) -> float:
    base = {
        "maintenance": 82.0,
        "testing": 78.0,
        "documentation": 68.0,
        "cleanup": 66.0,
        "scaffolding": 64.0,
        "analysis/reporting": 60.0,
    }.get(category, 58.0)
    score = base + (8.0 if explicit_targets else 0.0) + min(12.0, float(max(reused_signals, 0) * 3))
    if not eligible:
        score -= 35.0
    return score


def _owner_goal_seed_items(project_root: Path, maintenance_summary: dict[str, Any]) -> list[dict[str, Any]]:
    recommendation = dict(maintenance_summary.get("recommendation") or {})
    task = dict(recommendation.get("task") or {})
    candidate = dict(recommendation.get("candidate") or {})
    goal_text = str(task.get("objective") or candidate.get("summary") or recommendation.get("summary") or "").strip()
    if goal_text:
        return [
            {
                "title": str(task.get("title") or candidate.get("title") or "Leading maintenance goal"),
                "goal": goal_text,
                "category": "maintenance",
                "target_paths": list(task.get("target_paths") or candidate.get("target_paths") or []),
                "metadata": {"seeded": True, "project_root": str(project_root)},
            }
        ]
    return [
        {
            "title": "Summarize project health",
            "goal": "Analyze the current project health and prepare a bounded owner automation summary.",
            "category": "analysis/reporting",
            "target_paths": ["README.md", "docs/OWNER_AUTOMATION_REPORT.md"],
            "metadata": {"seeded": True, "project_root": str(project_root)},
        }
    ]


def _normalize_owner_goals(project_root: Path, owner_goals: list[Any] | None, maintenance_summary: dict[str, Any]) -> list[dict[str, Any]]:
    raw_items = [item for item in list(owner_goals or []) if item is not None]
    if not raw_items:
        raw_items = _owner_goal_seed_items(project_root, maintenance_summary)
    goals: list[dict[str, Any]] = []
    for index, raw_item in enumerate(raw_items, start=1):
        payload = {"goal": raw_item} if not isinstance(raw_item, dict) else dict(raw_item)
        raw_goal = _normalize_goal_text(payload.get("goal") or payload.get("objective") or payload.get("summary") or payload.get("title") or "")
        if not raw_goal:
            continue
        category = _owner_goal_category(raw_goal=raw_goal, category_hint=str(payload.get("category") or ""))
        title = _normalize_goal_text(payload.get("title") or "") or _owner_goal_title(raw_goal, f"Owner goal {index}")
        requested_targets = list(payload.get("target_paths") or payload.get("targetPaths") or [])
        explicit_targets = _filter_project_target_paths(project_root, requested_targets)
        goals.append(
            build_owner_goal(
                goal_id=f"owner-goal-{index:03d}",
                title=title,
                raw_goal=raw_goal,
                normalized_goal=raw_goal.lower(),
                category=category,
                priority=str(payload.get("priority") or _owner_goal_priority(category, raw_goal)),
                status="normalized",
                target_paths=explicit_targets,
                constraints={
                    "project_root": str(project_root),
                    "require_review": True,
                    "sandbox_required": True,
                    "approval_protected_only": True,
                },
                metadata={
                    **dict(payload.get("metadata") or {}),
                    "raw_requested_target_count": len(requested_targets),
                    "filtered_target_count": len(explicit_targets),
                    "difficulty": _infer_owner_goal_difficulty(
                        category,
                        explicit_target_count=len(requested_targets),
                        filtered_target_count=len(explicit_targets),
                    ),
                    "testing_week_preference": _TESTING_WEEK_PREFERRED_DIFFICULTY,
                },
            )
        )
    return goals


def _owner_automation_candidate_targets(
    project_root: Path,
    goal: dict[str, Any],
    maintenance_summary: dict[str, Any],
) -> tuple[list[str], dict[str, Any]]:
    explicit_targets = [str(path) for path in list(goal.get("target_paths") or []) if str(path)]
    raw_requested_target_count = int((goal.get("metadata") or {}).get("raw_requested_target_count") or 0)
    if explicit_targets:
        return explicit_targets, {"explicit_target_count": len(explicit_targets), "signal_sources": ["owner-goal"]}
    if raw_requested_target_count > 0:
        return [], {"explicit_target_count": 0, "signal_sources": ["owner-goal"], "blocked_invalid_explicit_targets": True}

    category = str(goal.get("category") or "maintenance")
    profile = dict(maintenance_summary.get("project_profile") or {})
    health_summary = dict(maintenance_summary.get("health_summary") or {})
    recommendation = dict(maintenance_summary.get("recommendation") or {})
    candidates = [dict(item) for item in list(maintenance_summary.get("candidates") or []) if isinstance(item, dict)]
    matching_kinds = {
        "maintenance": {"repeated-failure", "baseline-hotspot", "owner-requested-maintenance"},
        "documentation": {"docs-gap"},
        "testing": {"missing-tests"},
        "cleanup": {"baseline-hotspot", "repeated-failure"},
        "scaffolding": {"missing-tests", "docs-gap"},
        "analysis/reporting": set(),
    }.get(category, {"repeated-failure"})

    derived_paths: list[str] = []
    signal_sources: list[str] = []
    for candidate in candidates:
        if matching_kinds and str(candidate.get("kind") or "") not in matching_kinds:
            continue
        signal_sources.append(str(candidate.get("kind") or "unknown"))
        for path in list(candidate.get("target_paths") or []):
            normalized = str(path or "")
            if normalized and normalized not in derived_paths:
                derived_paths.append(normalized)

    for path in list(((health_summary.get("metadata") or {}).get("missing_test_suggestions") or [])):
        normalized = str(path or "")
        if category in {"testing", "scaffolding"} and normalized and normalized not in derived_paths:
            signal_sources.append("health.missing_test_suggestions")
            derived_paths.append(normalized)

    if category in {"documentation", "analysis/reporting"}:
        for path in ["README.md", "docs/ARCHITECTURE.md", "docs/API_OVERVIEW.md", "docs/OWNER_AUTOMATION_REPORT.md"]:
            normalized = _normalize_project_target_path(project_root, path)
            if normalized and normalized not in derived_paths:
                signal_sources.append("docs.default")
                derived_paths.append(normalized)

    if category == "scaffolding":
        for path in [
            "README.md",
            "docs/OWNER_AUTOMATION_REPORT.md",
            str(next(iter(list(profile.get("test_roots") or [])), "tests")),
        ]:
            normalized = _normalize_project_target_path(project_root, path)
            if normalized and normalized not in derived_paths:
                signal_sources.append("profile.scaffold")
                derived_paths.append(normalized)

    recommendation_task = dict(recommendation.get("task") or {})
    for path in list(recommendation_task.get("target_paths") or []):
        normalized = str(path or "")
        if category in {"maintenance", "cleanup"} and normalized and normalized not in derived_paths:
            signal_sources.append("maintenance.recommendation")
            derived_paths.append(normalized)

    return derived_paths[:6], {"explicit_target_count": 0, "signal_sources": signal_sources[:6]}


def _build_project_maintenance_candidate_entry(
    *,
    project_root: Path,
    profile_id: str,
    candidate_id: str,
    kind: str,
    source: str,
    title: str,
    summary: str,
    occurrences: int,
    target_paths: list[str],
    source_tickets: list[str],
    artifact_paths: list[str],
    eligibility_reason: str,
    evidence: dict[str, Any] | None = None,
    severity: int = 0,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    normalized_targets = _filter_project_target_paths(project_root, target_paths)
    eligible = bool(normalized_targets)
    difficulty = _infer_project_maintenance_difficulty(
        kind,
        target_paths=normalized_targets,
        occurrences=occurrences,
        severity=severity,
    )
    score = _maintenance_score(kind, occurrences=occurrences, eligible=eligible, severity=severity) + _difficulty_score_nudge(difficulty)
    metadata = {
        **dict(metadata or {}),
        "difficulty": difficulty,
        "difficulty_nudge": _difficulty_score_nudge(difficulty),
        "testing_week_preference": _TESTING_WEEK_PREFERRED_DIFFICULTY,
    }
    return build_project_maintenance_candidate(
        candidate_id=candidate_id,
        profile_id=profile_id,
        kind=kind,
        source=source,
        title=title,
        summary=summary,
        priority=_maintenance_priority(score),
        score=score,
        occurrences=occurrences,
        eligible=eligible,
        eligibility_reason="" if eligible else str(eligibility_reason or "no project-scoped target paths available"),
        target_paths=normalized_targets,
        source_tickets=source_tickets,
        evidence=evidence,
        artifact_paths=artifact_paths,
        metadata=metadata,
    )


def load_project_maintenance_history(project_root: Path, *, limit: int = 50) -> list[dict[str, Any]]:
    path = assistant_project_maintenance_history_path(project_root)
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
    rows.sort(key=lambda item: str(item.get("timestamp") or ""), reverse=True)
    return rows[:limit] if limit > 0 else rows


def append_project_maintenance_history(project_root: Path, entry: dict[str, Any]) -> Path | None:
    path = assistant_project_maintenance_history_path(project_root)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = dict(entry or {})
        if not str(payload.get("timestamp") or ""):
            payload["timestamp"] = datetime.now(timezone.utc).isoformat()
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, default=str) + "\n")
        return path
    except Exception:
        return None


def summarize_project_maintenance_history(project_root: Path, *, limit: int = 50) -> dict[str, Any]:
    rows = load_project_maintenance_history(project_root, limit=limit)
    latest_by_task: dict[str, dict[str, Any]] = {}
    for item in rows:
        task_id = str(item.get("task_id") or "")
        if task_id and task_id not in latest_by_task:
            latest_by_task[task_id] = item
    trust_rollup = _summarize_history_trust_rows(rows)
    return {
        "entry_count": len(rows),
        "status_counts": dict(Counter(str(item.get("status") or "unknown") for item in rows)),
        "latest_by_task": latest_by_task,
        "last_execution": dict(rows[0]) if rows else {},
        "artifact_path": str(assistant_project_maintenance_history_path(project_root)),
        **trust_rollup,
    }


def load_owner_automation_history(project_root: Path, *, limit: int = 50) -> list[dict[str, Any]]:
    path = assistant_owner_automation_history_path(project_root)
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
    rows.sort(key=lambda item: str(item.get("timestamp") or ""), reverse=True)
    return rows[:limit] if limit > 0 else rows


def append_owner_automation_history(project_root: Path, entry: dict[str, Any]) -> Path | None:
    path = assistant_owner_automation_history_path(project_root)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = dict(entry or {})
        if not str(payload.get("timestamp") or ""):
            payload["timestamp"] = datetime.now(timezone.utc).isoformat()
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, default=str) + "\n")
        return path
    except Exception:
        return None


def summarize_owner_automation_history(project_root: Path, *, limit: int = 50) -> dict[str, Any]:
    rows = load_owner_automation_history(project_root, limit=limit)
    latest_by_task: dict[str, dict[str, Any]] = {}
    for item in rows:
        task_id = str(item.get("task_id") or "")
        if task_id and task_id not in latest_by_task:
            latest_by_task[task_id] = item
    trust_rollup = _summarize_history_trust_rows(rows)
    return {
        "entry_count": len(rows),
        "status_counts": dict(Counter(str(item.get("status") or "unknown") for item in rows)),
        "latest_by_task": latest_by_task,
        "last_execution": dict(rows[0]) if rows else {},
        "artifact_path": str(assistant_owner_automation_history_path(project_root)),
        **trust_rollup,
    }


def summarize_project_maintenance_work(
    project_root: Path,
    *,
    history_limit: int = 40,
    max_candidates: int = 8,
    memory_entries: list[dict[str, Any]] | None = None,
    run_artifacts: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    root = project_root.resolve()
    repo_index_path = assistant_repo_index_path(root)
    repo_index = build_repo_index(root, output_path=repo_index_path)
    repo_files = [str(path) for path in iter_repo_files(root) if str(path)]
    source_files = [path for path in repo_files if Path(path).suffix.lower() in _SOURCE_SUFFIXES and not _is_test_path(path)]
    test_files = [path for path in repo_files if _is_test_path(path)]
    doc_files = [path for path in repo_files if _is_doc_path(path)]
    config_files = [
        path
        for path in repo_files
        if Path(path).name in {"package.json", "pyproject.toml", "requirements.txt", "Dockerfile", "docker-compose.yml"}
        or Path(path).suffix.lower() in _CONFIG_SUFFIXES
    ]
    language_counts = dict(Counter(_project_language_key(path) for path in repo_files))
    top_level_directories = sorted(str(item) for item in repo_index.keys())
    source_roots = sorted({_project_group_root(path) for path in source_files if _project_group_root(path)})
    test_roots = sorted({_project_group_root(path) for path in test_files if _project_group_root(path)})
    docs_roots = sorted({_project_group_root(path) for path in doc_files if _project_group_root(path)})
    entry_points = sorted(path for path in repo_files if path in _ENTRY_POINT_NAMES)

    profile = build_project_profile(
        profile_id=f"project-profile-{root.name}",
        project_root=str(root),
        name=root.name,
        project_kind=_project_kind(repo_files),
        repo_index_path=str(repo_index_path),
        top_level_directories=top_level_directories,
        source_roots=source_roots,
        test_roots=test_roots,
        docs_roots=docs_roots,
        config_files=sorted(config_files)[:12],
        entry_points=entry_points[:12],
        language_counts=language_counts,
        architecture={
            "has_backend": any(path.startswith("backend/") for path in repo_files),
            "has_frontend": any(path.startswith("frontend/") for path in repo_files),
            "has_docs": bool(doc_files),
            "has_tests": bool(test_files),
            "top_level_counts": {key: len(value or []) for key, value in repo_index.items()},
        },
        artifact_paths=[str(repo_index_path), str(assistant_project_maintenance_profile_path(root))],
        metadata={
            "repo_file_count": len(repo_files),
            "source_file_count": len(source_files),
            "test_file_count": len(test_files),
        },
    )

    memory_rows = [dict(item) for item in list(memory_entries or load_memory(root)) if isinstance(item, dict)]
    artifacts = [dict(item) for item in list(run_artifacts or load_runtime_history_artifacts(root, limit=history_limit)) if isinstance(item, dict)]
    history_summary = summarize_project_maintenance_history(root, limit=history_limit)
    recent_runs = load_recent_runs(root, lookback_hours=72, limit=history_limit)
    failure_clusters = cluster_failures(recent_runs)
    baseline = analyze_baseline_health(recent_runs, failure_clusters)
    failure_summary = summarize_failure_patterns(root, limit=history_limit)

    test_stems = {
        Path(path).stem.replace("test_", "").replace(".test", "").replace(".spec", "")
        for path in test_files
    }
    missing_test_sources = [
        path
        for path in source_files
        if Path(path).stem not in test_stems
        and not path.endswith("__init__.py")
        and not path.endswith("conftest.py")
    ]
    missing_test_suggestions = [item for item in [_suggest_test_path(path) for path in missing_test_sources[:6]] if item]
    recurring_blockers = [dict(item) for item in list(failure_summary.get("recurring_blockers") or []) if isinstance(item, dict)]

    health_signals: list[dict[str, Any]] = []
    if baseline:
        health_signals.append(
            {
                "kind": "baseline",
                "status": str(baseline.get("state") or "unknown"),
                "summary": str(baseline.get("reason") or ""),
            }
        )
    if missing_test_sources:
        health_signals.append(
            {
                "kind": "missing-tests",
                "count": len(missing_test_sources),
                "summary": f"{len(missing_test_sources)} source files do not have an obvious matching test.",
            }
        )
    if recurring_blockers:
        health_signals.append(
            {
                "kind": "recurring-blockers",
                "count": len(recurring_blockers),
                "summary": f"{len(recurring_blockers)} recurring blocker fingerprints were found in memory.",
            }
        )
    readme_missing = "README.md" not in repo_files
    if readme_missing or not doc_files:
        health_signals.append(
            {
                "kind": "docs-gap",
                "count": 1 if readme_missing else 0,
                "summary": "Project documentation coverage is thin or missing a root README.",
            }
        )

    health_score = 100.0
    health_score -= min(28.0, float(len(missing_test_sources)) * 2.5)
    health_score -= min(18.0, float(len(recurring_blockers)) * 4.0)
    if str(baseline.get("state") or "").lower() == "red":
        health_score -= 24.0
    elif str(baseline.get("state") or "").lower() == "yellow":
        health_score -= 12.0
    if readme_missing:
        health_score -= 8.0
    if not doc_files:
        health_score -= 6.0
    health_score = max(0.0, min(100.0, health_score))
    health_status = "green" if health_score >= 80 else ("yellow" if health_score >= 60 else "red")
    health_grade = "A" if health_score >= 90 else ("B" if health_score >= 80 else ("C" if health_score >= 70 else ("D" if health_score >= 60 else "F")))

    health_summary = build_project_health_summary(
        profile_id=str(profile.get("profile_id") or ""),
        status=health_status,
        score=health_score,
        grade=health_grade,
        summary=(
            f"{root.name} scored {health_score:.1f}/100 with baseline {str(baseline.get('state') or 'unknown')} and {len(missing_test_sources)} likely test gaps."
        ),
        repo_file_count=len(repo_files),
        source_file_count=len(source_files),
        test_file_count=len(test_files),
        doc_file_count=len(doc_files),
        config_file_count=len(config_files),
        missing_test_count=len(missing_test_sources),
        repeated_failure_count=max(int(failure_summary.get("repeat_count") or 0), len(recurring_blockers)),
        baseline_state=str(baseline.get("state") or "unknown"),
        top_hotspots=[dict(item) for item in failure_clusters[:5]],
        signals=health_signals,
        artifact_paths=[str(repo_index_path), str(assistant_project_maintenance_queue_path(root))],
        metadata={
            "project_kind": str(profile.get("project_kind") or "unknown"),
            "baseline_reason": str(baseline.get("reason") or ""),
            "missing_test_suggestions": missing_test_suggestions[:6],
        },
    )

    artifact_paths = [str(item.get("_artifact_path") or "") for item in artifacts if str(item.get("_artifact_path") or "")]
    candidates: list[dict[str, Any]] = []

    if failure_clusters or recurring_blockers:
        hotspot = dict(baseline.get("hotspot") or (failure_clusters[0] if failure_clusters else {}))
        hotspot_paths = _filter_project_target_paths(
            root,
            [
                str(hotspot.get("path_hint") or ""),
                *[
                    str(path)
                    for row in memory_rows
                    for path in list(row.get("files_written") or [])
                    if str(path)
                ],
            ],
        )
        candidates.append(
            _build_project_maintenance_candidate_entry(
                project_root=root,
                profile_id=str(profile.get("profile_id") or ""),
                candidate_id="project-repeated-failure",
                kind="repeated-failure",
                source="memory.failure_patterns",
                title="Reduce recurring maintenance failures",
                summary=str(baseline.get("reason") or "Recurring failures were detected in project maintenance signals."),
                occurrences=max(int(failure_summary.get("repeat_count") or 0), len(recurring_blockers), len(failure_clusters), 1),
                target_paths=hotspot_paths,
                source_tickets=sorted({str(row.get("ticket") or "") for row in memory_rows if str(row.get("ticket") or "")})[:8],
                artifact_paths=artifact_paths[:6],
                eligibility_reason="failure signals did not resolve to project-local targets",
                evidence={
                    "recurring_blockers": recurring_blockers,
                    "baseline": baseline,
                },
                severity=8 if str(baseline.get("state") or "").lower() == "red" else 4,
            )
        )

    hotspot = dict(baseline.get("hotspot") or {})
    if hotspot:
        candidates.append(
            _build_project_maintenance_candidate_entry(
                project_root=root,
                profile_id=str(profile.get("profile_id") or ""),
                candidate_id="project-baseline-hotspot",
                kind="baseline-hotspot",
                source="baseline.health",
                title="Stabilize the active baseline hotspot",
                summary=str(hotspot.get("summary") or baseline.get("reason") or "A repeated validation hotspot needs maintenance."),
                occurrences=max(int(hotspot.get("occurrences") or 0), 1),
                target_paths=[str(hotspot.get("path_hint") or "")],
                source_tickets=list(hotspot.get("tickets") or [])[:8],
                artifact_paths=artifact_paths[:6],
                eligibility_reason="baseline hotspot did not map to a project-local path",
                evidence={"hotspot": hotspot, "baseline": baseline},
                severity=10 if bool(hotspot.get("shared_root")) else 5,
            )
        )

    if missing_test_sources:
        candidates.append(
            _build_project_maintenance_candidate_entry(
                project_root=root,
                profile_id=str(profile.get("profile_id") or ""),
                candidate_id="project-missing-tests",
                kind="missing-tests",
                source="repo.test_gap_analysis",
                title="Backfill missing targeted tests",
                summary=f"Found {len(missing_test_sources)} source files without an obvious matching test file.",
                occurrences=len(missing_test_sources),
                target_paths=[*missing_test_sources[:4], *missing_test_suggestions[:2]],
                source_tickets=[],
                artifact_paths=[str(repo_index_path)],
                eligibility_reason="no project-local test maintenance targets were derived",
                evidence={
                    "source_paths": missing_test_sources[:8],
                    "suggested_test_paths": missing_test_suggestions[:8],
                },
                severity=4,
            )
        )

    owner_targets: list[str] = []
    owner_titles: list[str] = []
    owner_tickets: list[str] = []
    owner_artifacts: list[str] = []
    for artifact in artifacts:
        owner_summary = dict(artifact.get("owner_summary") or {})
        for action in [dict(item) for item in list(owner_summary.get("recommended_actions") or []) if isinstance(item, dict)]:
            owner_titles.append(str(action.get("title") or ""))
            owner_targets.extend(str(path) for path in list(action.get("target_paths") or []) if str(path))
            if str(artifact.get("ticket") or ""):
                owner_tickets.append(str(artifact.get("ticket") or ""))
            if str(artifact.get("_artifact_path") or ""):
                owner_artifacts.append(str(artifact.get("_artifact_path") or ""))
    if owner_titles or owner_targets:
        candidates.append(
            _build_project_maintenance_candidate_entry(
                project_root=root,
                profile_id=str(profile.get("profile_id") or ""),
                candidate_id="project-owner-maintenance",
                kind="owner-requested-maintenance",
                source="owner_summary.recommended_actions",
                title="Follow owner-requested maintenance",
                summary=(
                    "Owner-facing summaries already request maintenance follow-up"
                    + (f": {', '.join(title for title in owner_titles[:3] if title)}." if any(owner_titles) else ".")
                ),
                occurrences=max(len(owner_titles), len(owner_targets), 1),
                target_paths=owner_targets[:6],
                source_tickets=sorted({ticket for ticket in owner_tickets if ticket})[:8],
                artifact_paths=sorted({path for path in owner_artifacts if path})[:8],
                eligibility_reason="owner-requested maintenance targets were outside the selected project root",
                evidence={"recommended_titles": [title for title in owner_titles[:5] if title]},
                severity=3,
            )
        )

    doc_target_paths = _filter_project_target_paths(root, ["README.md", "docs/ARCHITECTURE.md", "docs/API_OVERVIEW.md"])
    if readme_missing or not doc_files:
        candidates.append(
            _build_project_maintenance_candidate_entry(
                project_root=root,
                profile_id=str(profile.get("profile_id") or ""),
                candidate_id="project-docs-gap",
                kind="docs-gap",
                source="repo.documentation_signals",
                title="Refresh project maintenance documentation",
                summary="Documentation coverage looks stale or incomplete for the current project layout.",
                occurrences=1 + int(readme_missing),
                target_paths=doc_target_paths,
                source_tickets=[],
                artifact_paths=[str(repo_index_path)],
                eligibility_reason="no project-local documentation targets were available",
                evidence={
                    "readme_missing": readme_missing,
                    "doc_file_count": len(doc_files),
                    "source_root_count": len(source_roots),
                },
                severity=2,
            )
        )

    candidates = [dict(item) for item in candidates if isinstance(item, dict)]
    candidates.sort(
        key=lambda item: (
            float(item.get("score", 0.0)),
            bool(item.get("eligible", False)),
            int(item.get("occurrences", 0)),
            str(item.get("title") or ""),
        ),
        reverse=True,
    )
    if max_candidates > 0:
        candidates = candidates[:max_candidates]

    prepared_tasks: list[dict[str, Any]] = []
    eligible_candidates = [item for item in candidates if item.get("eligible")]
    latest_by_task = dict(history_summary.get("latest_by_task") or {})
    for index, candidate in enumerate(eligible_candidates[:PROJECT_MAINTENANCE_TASK_LIMIT], start=1):
        candidate_targets = [str(path) for path in list(candidate.get("target_paths") or []) if str(path)]
        evidence = dict(candidate.get("evidence") or {})
        suggested_test_paths = _filter_project_target_paths(root, list(evidence.get("suggested_test_paths") or []))
        allowed_target_paths: list[str] = []
        for path in [*candidate_targets, *suggested_test_paths[:2]]:
            if path not in allowed_target_paths:
                allowed_target_paths.append(path)
        task_id = f"project-maint-task-{index:03d}"
        objective = (
            f"{candidate.get('summary') or candidate.get('title')}. Keep maintenance scoped to project root {root} "
            f"and the prepared target paths only."
        )
        runtime_task = build_runtime_task(
            ticket_id=task_id,
            desc=objective,
            action="implement",
            mode="integrate",
            run_mode="manual",
            editor_context={},
            host_boundary={
                "project_maintenance_only": True,
                "approval_protected_only": True,
                "sandbox_required": True,
                "require_review": True,
                "allowed_target_paths": allowed_target_paths,
                "project_root": str(root),
            },
            requested_capabilities={
                "write": True,
                "execute": False,
                "repair": False,
                "confirm": True,
            },
            metadata={
                "project_profile_id": str(profile.get("profile_id") or ""),
                "source_candidate_id": str(candidate.get("candidate_id") or ""),
                "project_root": str(root),
                "target_paths": allowed_target_paths,
                "project_maintenance_task_id": task_id,
                "difficulty": str((candidate.get("metadata") or {}).get("difficulty") or "medium"),
            },
        )
        prepared_tasks.append(
            build_project_maintenance_task(
                task_id=task_id,
                profile_id=str(profile.get("profile_id") or ""),
                candidate_id=str(candidate.get("candidate_id") or ""),
                title=str(candidate.get("title") or f"Project maintenance task {index}"),
                objective=objective,
                priority=str(candidate.get("priority") or "medium"),
                status=str(dict(latest_by_task.get(task_id) or {}).get("status") or "prepared"),
                action="implement",
                mode="integrate",
                target_paths=allowed_target_paths,
                host_boundary=dict(runtime_task.get("host_boundary") or {}),
                runtime_task=runtime_task,
                metadata={
                    "source": str(candidate.get("source") or ""),
                    "source_tickets": list(candidate.get("source_tickets") or []),
                    "suggested_test_paths": suggested_test_paths[:4],
                    "difficulty": str((candidate.get("metadata") or {}).get("difficulty") or "medium"),
                    "last_execution": dict(latest_by_task.get(task_id) or {}),
                },
            )
        )

    queue_summary = build_project_maintenance_queue_summary(
        queue_id=f"project-maintenance-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
        profile_id=str(profile.get("profile_id") or ""),
        summary=(
            f"Prepared {len(prepared_tasks)} project-maintenance task(s) from {len(candidates)} candidate(s)."
            if candidates
            else "No project-maintenance candidates are ready yet."
        ),
        total_candidates=len(candidates),
        eligible_candidate_count=len(eligible_candidates),
        blocked_candidate_count=max(0, len(candidates) - len(eligible_candidates)),
        prepared_task_count=len(prepared_tasks),
        source_counts=dict(Counter(str(item.get("kind") or "unknown") for item in candidates)),
        top_candidates=candidates[:5],
        prepared_tasks=prepared_tasks,
        artifact_paths=[
            str(path)
            for path in [
                assistant_project_maintenance_queue_path(root),
                assistant_project_maintenance_profile_path(root),
                history_summary.get("artifact_path"),
                repo_index_path,
                *artifact_paths[:6],
            ]
            if str(path or "")
        ],
        metadata={
            "project_root": str(root),
            "project_kind": str(profile.get("project_kind") or "unknown"),
            "health_status": str(health_summary.get("status") or "unknown"),
            "health_grade": str(health_summary.get("grade") or "N/A"),
            "baseline_state": str(baseline.get("state") or "unknown"),
            "history_limit": int(history_limit or 0),
            "history_entry_count": int(history_summary.get("entry_count") or 0),
            "execution_status_counts": dict(history_summary.get("status_counts") or {}),
            "last_execution": dict(history_summary.get("last_execution") or {}),
            "trust_signal_count": int(history_summary.get("trust_signal_count") or 0),
            "trust_state_counts": dict(history_summary.get("trust_state_counts") or {}),
            "learning_label_counts": dict(history_summary.get("learning_label_counts") or {}),
            "approval_mode_counts": dict(history_summary.get("approval_mode_counts") or {}),
            "last_trust_summary": dict(history_summary.get("last_trust_summary") or {}),
            "preferred_difficulty": _TESTING_WEEK_PREFERRED_DIFFICULTY,
            "candidate_difficulty_counts": _difficulty_counts(candidates),
            "prepared_task_difficulty_counts": _difficulty_counts(prepared_tasks),
        },
    )

    top_candidate = dict(eligible_candidates[0]) if eligible_candidates else (dict(candidates[0]) if candidates else {})
    top_task = dict(prepared_tasks[0]) if prepared_tasks else {}
    recommendation = build_project_maintenance_recommendation(
        recommendation_id=f"project-maintenance-rec-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
        profile_id=str(profile.get("profile_id") or ""),
        summary=(
            f"Prepare runtime-shaped maintenance for {top_candidate.get('title', 'the leading candidate')}."
            if top_task
            else (
                f"Manual maintenance triage is required for {top_candidate.get('title', 'the leading candidate')}."
                if top_candidate
                else "Collect more project signals before preparing maintenance work."
            )
        ),
        recommended_action=(
            "prepare-runtime-maintenance"
            if top_task
            else ("manual-maintenance-triage" if top_candidate else "observe-more-project-signals")
        ),
        priority=str(top_candidate.get("priority") or "low"),
        candidate=top_candidate,
        task=top_task,
        artifact_paths=list(queue_summary.get("artifact_paths") or []),
        metadata={
            "eligible_candidate_count": len(eligible_candidates),
            "preferred_difficulty": _TESTING_WEEK_PREFERRED_DIFFICULTY,
            "candidate_difficulty_counts": _difficulty_counts(candidates),
            "recommended_difficulty": str((top_candidate.get("metadata") or {}).get("difficulty") or "medium"),
        },
    )
    return {
        "project_profile": profile,
        "health_summary": health_summary,
        "queue_summary": queue_summary,
        "recommendation": recommendation,
        "candidates": candidates,
        "prepared_tasks": prepared_tasks,
        "history_summary": history_summary,
    }


def summarize_owner_automation_work(
    project_root: Path,
    *,
    owner_goals: list[Any] | None = None,
    history_limit: int = 40,
    max_candidates: int = 8,
) -> dict[str, Any]:
    root = project_root.resolve()
    maintenance_summary = summarize_project_maintenance_work(
        root,
        history_limit=history_limit,
        max_candidates=max_candidates,
    )
    profile = dict(maintenance_summary.get("project_profile") or {})
    health_summary = dict(maintenance_summary.get("health_summary") or {})
    history_summary = summarize_owner_automation_history(root, limit=history_limit)
    normalized_goals = _normalize_owner_goals(root, owner_goals, maintenance_summary)
    goal_plan = build_owner_goal_plan(
        plan_id=f"owner-goal-plan-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
        project_root=str(root),
        summary=f"Normalized {len(normalized_goals)} owner goal(s) into bounded automation candidates.",
        total_goals=len(normalized_goals),
        category_counts=dict(Counter(str(item.get("category") or "unknown") for item in normalized_goals)),
        goals=normalized_goals,
        artifact_paths=[
            str(path)
            for path in [
                assistant_owner_automation_queue_path(root),
                assistant_project_maintenance_queue_path(root),
                assistant_project_maintenance_profile_path(root),
            ]
            if str(path)
        ],
        metadata={
            "project_profile_id": str(profile.get("profile_id") or ""),
            "health_status": str(health_summary.get("status") or "unknown"),
            "history_limit": int(history_limit or 0),
        },
    )

    candidates: list[dict[str, Any]] = []
    for index, goal in enumerate(normalized_goals, start=1):
        derived_targets, derived_evidence = _owner_automation_candidate_targets(root, goal, maintenance_summary)
        eligible = bool(derived_targets)
        category = str(goal.get("category") or "maintenance")
        action = _owner_automation_action(category)
        mode = _owner_automation_mode(category)
        difficulty = _infer_owner_automation_difficulty(
            category,
            target_paths=derived_targets,
            explicit_targets=bool(goal.get("target_paths")),
            reused_signals=len(list(derived_evidence.get("signal_sources") or [])),
        )
        score = _owner_automation_score(
            category,
            eligible=eligible,
            explicit_targets=bool(goal.get("target_paths")),
            reused_signals=len(list(derived_evidence.get("signal_sources") or [])),
        ) + _difficulty_score_nudge(difficulty)
        candidates.append(
            build_owner_automation_candidate(
                candidate_id=f"owner-auto-candidate-{index:03d}",
                goal_id=str(goal.get("goal_id") or ""),
                category=category,
                source="owner_goal.plan",
                title=str(goal.get("title") or f"Owner automation candidate {index}"),
                summary=str(goal.get("raw_goal") or goal.get("title") or ""),
                priority=str(goal.get("priority") or "medium"),
                score=score,
                eligible=eligible,
                action=action,
                mode=mode,
                eligibility_reason="" if eligible else "owner goal did not resolve to project-scoped target paths",
                target_paths=derived_targets,
                evidence={
                    **derived_evidence,
                    "goal": dict(goal),
                    "maintenance_recommendation": dict(maintenance_summary.get("recommendation") or {}),
                },
                artifact_paths=list(goal_plan.get("artifact_paths") or []),
                metadata={
                    "project_root": str(root),
                    "project_profile_id": str(profile.get("profile_id") or ""),
                    "difficulty": difficulty,
                    "difficulty_nudge": _difficulty_score_nudge(difficulty),
                    "testing_week_preference": _TESTING_WEEK_PREFERRED_DIFFICULTY,
                },
            )
        )

    candidates.sort(
        key=lambda item: (
            float(item.get("score", 0.0)),
            bool(item.get("eligible", False)),
            str(item.get("priority") or ""),
            str(item.get("title") or ""),
        ),
        reverse=True,
    )
    if max_candidates > 0:
        candidates = candidates[:max_candidates]

    prepared_tasks: list[dict[str, Any]] = []
    eligible_candidates = [item for item in candidates if item.get("eligible")]
    latest_by_task = dict(history_summary.get("latest_by_task") or {})
    for index, candidate in enumerate(eligible_candidates[:OWNER_AUTOMATION_TASK_LIMIT], start=1):
        candidate_targets = [str(path) for path in list(candidate.get("target_paths") or []) if str(path)]
        task_id = f"owner-auto-task-{index:03d}"
        category = str(candidate.get("category") or "maintenance")
        action = str(candidate.get("action") or _owner_automation_action(category))
        mode = str(candidate.get("mode") or _owner_automation_mode(category))
        objective = (
            f"{candidate.get('summary') or candidate.get('title')}. Keep owner automation scoped to project root {root} "
            f"and the prepared target paths only."
        )
        runtime_task = build_runtime_task(
            ticket_id=task_id,
            desc=objective,
            action=action,
            mode=mode,
            run_mode="manual",
            editor_context={},
            host_boundary={
                "owner_automation_only": True,
                "approval_protected_only": True,
                "sandbox_required": True,
                "require_review": True,
                "allowed_target_paths": candidate_targets,
                "project_root": str(root),
                "owner_automation_depth": 1,
                "max_owner_automation_tasks": 1,
                "allow_followup_execution": False,
            },
            requested_capabilities={
                "write": action == "implement",
                "execute": action == "run",
                "repair": False,
                "confirm": True,
            },
            metadata={
                "project_profile_id": str(profile.get("profile_id") or ""),
                "owner_goal_id": str(candidate.get("goal_id") or ""),
                "owner_automation_candidate_id": str(candidate.get("candidate_id") or ""),
                "owner_automation_category": category,
                "project_root": str(root),
                "target_paths": candidate_targets,
                "owner_automation_task_id": task_id,
                "difficulty": str((candidate.get("metadata") or {}).get("difficulty") or "medium"),
            },
        )
        prepared_tasks.append(
            build_owner_automation_task(
                task_id=task_id,
                goal_id=str(candidate.get("goal_id") or ""),
                candidate_id=str(candidate.get("candidate_id") or ""),
                title=str(candidate.get("title") or f"Owner automation task {index}"),
                objective=objective,
                category=category,
                priority=str(candidate.get("priority") or "medium"),
                status=str(dict(latest_by_task.get(task_id) or {}).get("status") or "prepared"),
                action=action,
                mode=mode,
                target_paths=candidate_targets,
                host_boundary=dict(runtime_task.get("host_boundary") or {}),
                runtime_task=runtime_task,
                metadata={
                    "goal": next((dict(goal) for goal in normalized_goals if str(goal.get("goal_id") or "") == str(candidate.get("goal_id") or "")), {}),
                    "signal_sources": list((candidate.get("evidence") or {}).get("signal_sources") or []),
                    "difficulty": str((candidate.get("metadata") or {}).get("difficulty") or "medium"),
                    "last_execution": dict(latest_by_task.get(task_id) or {}),
                },
            )
        )

    queue_summary = build_owner_automation_queue_summary(
        queue_id=f"owner-automation-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
        profile_id=str(profile.get("profile_id") or ""),
        summary=(
            f"Prepared {len(prepared_tasks)} owner automation task(s) from {len(candidates)} candidate(s) across {len(normalized_goals)} goal(s)."
            if normalized_goals
            else "No owner automation goals are ready yet."
        ),
        total_goals=len(normalized_goals),
        total_candidates=len(candidates),
        eligible_candidate_count=len(eligible_candidates),
        blocked_candidate_count=max(0, len(candidates) - len(eligible_candidates)),
        prepared_task_count=len(prepared_tasks),
        category_counts=dict(Counter(str(item.get("category") or "unknown") for item in normalized_goals)),
        top_candidates=candidates[:5],
        prepared_tasks=prepared_tasks,
        artifact_paths=[
            str(path)
            for path in [
                assistant_owner_automation_queue_path(root),
                history_summary.get("artifact_path"),
                assistant_project_maintenance_queue_path(root),
                assistant_project_maintenance_profile_path(root),
                assistant_repo_index_path(root),
            ]
            if str(path)
        ],
        metadata={
            "project_root": str(root),
            "project_kind": str(profile.get("project_kind") or "unknown"),
            "health_status": str(health_summary.get("status") or "unknown"),
            "health_grade": str(health_summary.get("grade") or "N/A"),
            "used_project_maintenance_signals": True,
            "prepared_categories": sorted({str(item.get("category") or "") for item in prepared_tasks if str(item.get("category") or "")}),
            "history_limit": int(history_limit or 0),
            "history_entry_count": int(history_summary.get("entry_count") or 0),
            "execution_status_counts": dict(history_summary.get("status_counts") or {}),
            "last_execution": dict(history_summary.get("last_execution") or {}),
            "trust_signal_count": int(history_summary.get("trust_signal_count") or 0),
            "trust_state_counts": dict(history_summary.get("trust_state_counts") or {}),
            "learning_label_counts": dict(history_summary.get("learning_label_counts") or {}),
            "approval_mode_counts": dict(history_summary.get("approval_mode_counts") or {}),
            "last_trust_summary": dict(history_summary.get("last_trust_summary") or {}),
            "preferred_difficulty": _TESTING_WEEK_PREFERRED_DIFFICULTY,
            "candidate_difficulty_counts": _difficulty_counts(candidates),
            "prepared_task_difficulty_counts": _difficulty_counts(prepared_tasks),
        },
    )

    top_goal = dict(normalized_goals[0]) if normalized_goals else {}
    top_candidate = dict(eligible_candidates[0]) if eligible_candidates else (dict(candidates[0]) if candidates else {})
    top_task = dict(prepared_tasks[0]) if prepared_tasks else {}
    recommendation = build_owner_automation_recommendation(
        recommendation_id=f"owner-automation-rec-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
        profile_id=str(profile.get("profile_id") or ""),
        summary=(
            f"Prepare bounded runtime-shaped owner automation for {top_candidate.get('title', 'the leading owner goal')}."
            if top_task
            else (
                f"Refine owner goal scope for {top_candidate.get('title', 'the leading owner goal')}."
                if top_candidate
                else "Provide at least one bounded owner goal to prepare automation work."
            )
        ),
        recommended_action=(
            "prepare-owner-automation-task"
            if top_task
            else ("refine-owner-goal-scope" if top_candidate else "capture-owner-goal")
        ),
        priority=str(top_candidate.get("priority") or top_goal.get("priority") or "medium"),
        goal=top_goal,
        plan=goal_plan,
        candidate=top_candidate,
        task=top_task,
        artifact_paths=list(queue_summary.get("artifact_paths") or []),
        metadata={
            "eligible_candidate_count": len(eligible_candidates),
            "preferred_difficulty": _TESTING_WEEK_PREFERRED_DIFFICULTY,
            "candidate_difficulty_counts": _difficulty_counts(candidates),
            "recommended_difficulty": str((top_candidate.get("metadata") or {}).get("difficulty") or "medium"),
        },
    )

    return {
        "project_profile": profile,
        "health_summary": health_summary,
        "owner_goals": normalized_goals,
        "owner_goal_plan": goal_plan,
        "queue_summary": queue_summary,
        "recommendation": recommendation,
        "candidates": candidates,
        "prepared_tasks": prepared_tasks,
        "history_summary": history_summary,
        "project_maintenance_summary": {
            "queue_summary": dict(maintenance_summary.get("queue_summary") or {}),
            "recommendation": dict(maintenance_summary.get("recommendation") or {}),
            "history_summary": dict(maintenance_summary.get("history_summary") or {}),
        },
    }


def build_owner_automation_export_path(project_root: Path, payload: dict[str, Any], *, suffix: str = "queue") -> Path:
    moment = _payload_datetime(payload)
    return assistant_owner_automation_dir(project_root) / f"{moment.strftime('%Y%m%dT%H%M%S')}-{suffix}.json"


def write_owner_automation_export(project_root: Path, payload: dict[str, Any], *, target: Path | None = None, suffix: str = "queue") -> Path | None:
    resolved_target = target or build_owner_automation_export_path(project_root, payload, suffix=suffix)
    return _safe_write_json(resolved_target, payload)


def build_project_maintenance_export_path(project_root: Path, payload: dict[str, Any], *, suffix: str = "queue") -> Path:
    moment = _payload_datetime(payload)
    return assistant_project_maintenance_dir(project_root) / f"{moment.strftime('%Y%m%dT%H%M%S')}-{suffix}.json"


def write_project_maintenance_export(project_root: Path, payload: dict[str, Any], *, target: Path | None = None, suffix: str = "queue") -> Path | None:
    resolved_target = target or build_project_maintenance_export_path(project_root, payload, suffix=suffix)
    _safe_write_json(assistant_project_maintenance_profile_path(project_root), dict(payload.get("project_profile") or {}))
    return _safe_write_json(resolved_target, payload)
