from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.agent.core.failure_taxonomy import summarize_failure_taxonomy, summarize_repair_outcomes
from backend.agent.core.artifact_service import (
    append_experiment_dataset,
    build_owner_experiment_summary_from_benchmark,
    build_training_handoff_from_dataset,
    build_experiment_artifact_path,
    build_human_summary_path,
    load_experiment_dataset,
    summarize_experiment_dataset,
    build_run_artifact_path,
    write_experiment_export,
    write_experiment_artifact,
    write_human_summary,
    write_run_artifact,
)
from backend.agent.core.dashboard_service import update_dashboard
from backend.agent.core.storage_paths import assistant_experiment_dataset_path
from backend.agent.core.cleanup_classifier import apply_cleanup_write_gate, build_cleanup_candidate_summary
from backend.agent.core.duplicate_detector import build_run_duplicate_summary
from backend.agent.core.memory_service import summarize_strategy_patterns
from backend.agent.core.performance_baseline import build_performance_baseline_scorecard
from backend.agent.core.stage_speed import build_stage_speed_summary
from backend.agent.core.supervision_labels import build_supervision_label_summary
from backend.agent.core.trust_summary import build_trust_summary
from backend.agent.core.patch_review import build_review_summary
from backend.agent.core.runtime_utils import confidence_score, json_safe
from backend.agent.runtime.contracts import (
    build_experiment_benchmark_summary,
    build_experiment_run,
    build_experiment_scenario,
    build_experiment_scorecard,
    build_owner_summary,
    build_owner_experiment_summary,
    build_recommended_action,
    build_review_queue_summary,
    build_run_summary,
    build_runtime_artifact,
    build_strategy_benchmark,
    build_test_summary,
    build_training_handoff,
)


def _artifact_paths_from_runtime_artifacts(items: list[dict[str, Any]] | None = None) -> list[str]:
    return [str(item.get("path") or "") for item in list(items or []) if isinstance(item, dict) and str(item.get("path") or "")]


def _selected_patch_labels(*, execution: dict[str, Any], repair: dict[str, Any]) -> list[str]:
    labels: list[str] = []
    for item in list(execution.get("results", []) or []):
        review = item.get("ai_patch_review") if isinstance(item, dict) else None
        label = review.get("selected_label") if isinstance(review, dict) else None
        if label:
            labels.append(str(label))
    for item in list(repair.get("repairs", []) or []):
        review = item.get("patch_review") if isinstance(item, dict) else None
        label = review.get("selected_label") if isinstance(review, dict) else None
        if label:
            labels.append(str(label))
    return labels


def _build_owner_recommended_actions(
    *,
    ticket_id: str,
    review_summary: dict[str, Any],
    validation: dict[str, Any],
    write_gate: dict[str, Any],
    runtime_failure: dict[str, Any],
    artifact_paths: list[str],
) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    review_requests = list(review_summary.get("review_requests") or [])
    retry_policy = dict(validation.get("retry_policy") or {})
    failure = dict(runtime_failure or {})
    if review_summary.get("requires_manual_review"):
        actions.append(
            build_recommended_action(
                action_id=f"review-queue:{ticket_id}",
                action_type="review-queue",
                title="Resolve pending review queue",
                reason=str(review_summary.get("summary") or "Manual review is required before the run can proceed."),
                priority="high",
                artifact_paths=artifact_paths,
                target_paths=[
                    str(item.get("context", {}).get("target_paths", [""])[0] or "")
                    for item in review_requests
                    if isinstance(item, dict) and list(item.get("context", {}).get("target_paths", []) or [])
                ],
                metadata={"review_request_count": len(review_requests)},
            )
        )
    if write_gate.get("requires_confirmation") and not write_gate.get("allow_write"):
        actions.append(
            build_recommended_action(
                action_id=f"confirm-write:{ticket_id}",
                action_type="confirm-write",
                title="Confirm write execution",
                reason=str(write_gate.get("reason") or "Manual confirmation is required before writes can continue."),
                priority="high",
                artifact_paths=artifact_paths,
                metadata={"downgraded_to_preview": bool(write_gate.get("downgraded_to_preview"))},
            )
        )
    if retry_policy and not validation.get("ok", True):
        actions.append(
            build_recommended_action(
                action_id=f"retry-policy:{ticket_id}",
                action_type=str(retry_policy.get("action") or "repair"),
                title="Run the recommended recovery step",
                reason=str(retry_policy.get("reason") or "Validation produced a retry recommendation."),
                priority="medium" if str(retry_policy.get("action") or "") == "repair" else "high",
                artifact_paths=artifact_paths,
                metadata=dict(retry_policy),
            )
        )
    if not actions:
        actions.append(
            build_recommended_action(
                action_id=f"inspect-artifacts:{ticket_id}",
                action_type="inspect-artifacts",
                title="Inspect the latest run artifacts",
                reason=str(failure.get("message") or "Review the generated summary and runtime artifact for the latest run."),
                priority="low",
                artifact_paths=artifact_paths,
            )
        )
    return actions


def _build_owner_summary_payload(
    *,
    ticket_id: str,
    audit: dict[str, Any],
    validation: dict[str, Any],
    review_summary: dict[str, Any],
    write_gate: dict[str, Any],
    runtime_task: dict[str, Any],
    runtime_run: dict[str, Any],
    runtime_result: dict[str, Any],
    runtime_failure: dict[str, Any],
    execution: dict[str, Any],
    repair: dict[str, Any],
    branch: str | None,
    runtime_artifacts: list[dict[str, Any]],
) -> dict[str, Any]:
    artifact_paths = _artifact_paths_from_runtime_artifacts(runtime_artifacts)
    test_results = [item for item in list(validation.get("results", []) or []) if isinstance(item, dict)]
    passed_count = sum(1 for item in test_results if item.get("ok", False))
    failed_count = sum(1 for item in test_results if not item.get("ok", False))
    fingerprints = [dict(item) for item in list(validation.get("fingerprints", []) or []) if isinstance(item, dict)]
    review_queue_summary = build_review_queue_summary(
        ticket_id=ticket_id,
        run_id=str(runtime_run.get("run_id") or ""),
        task_id=str(runtime_task.get("task_id") or ""),
        review_state=dict(review_summary.get("review_state") or {}),
        review_requests=list(review_summary.get("review_requests") or []),
        summary=str(review_summary.get("summary") or ""),
        artifact_refs=[dict(item) for item in list(review_summary.get("review_artifacts", []) or []) if isinstance(item, dict)],
    )
    test_summary = build_test_summary(
        ticket_id=ticket_id,
        run_id=str(runtime_run.get("run_id") or ""),
        task_id=str(runtime_task.get("task_id") or ""),
        command_count=len(list(validation.get("commands", []) or [])),
        passed_count=passed_count,
        failed_count=failed_count,
        fingerprint_count=len(fingerprints),
        blocking_fingerprint_count=sum(1 for item in fingerprints if item.get("blocking")),
        retry_action=str((validation.get("retry_policy") or {}).get("action") or ""),
        retry_reason=str((validation.get("retry_policy") or {}).get("reason") or ""),
        status="passed" if validation.get("ok", True) else ("blocked" if any(item.get("blocking") for item in fingerprints) else "failed"),
        summary=(
            "validation passed"
            if validation.get("ok", True)
            else str((validation.get("retry_policy") or {}).get("reason") or runtime_failure.get("message") or "validation requires attention")
        ),
        commands=list(validation.get("commands", []) or []),
        fingerprints=fingerprints,
    )
    run_summary = build_run_summary(
        ticket_id=ticket_id,
        run_id=str(runtime_run.get("run_id") or ""),
        task_id=str(runtime_task.get("task_id") or ""),
        action=str(runtime_task.get("action") or runtime_result.get("action") or "run"),
        mode=str(runtime_task.get("mode") or runtime_result.get("mode") or "integrate"),
        status=str(runtime_result.get("status") or "unknown"),
        final_state=str(runtime_result.get("final_state") or runtime_run.get("state") or "unknown"),
        strategy=str(audit.get("strategy") or ""),
        started_at=str(runtime_run.get("started_at") or runtime_result.get("started_at") or ""),
        finished_at=str(runtime_result.get("finished_at") or runtime_run.get("finished_at") or ""),
        branch=str(branch or ""),
        created_file_count=len(list(execution.get("created", []) or [])),
        execution_result_count=len(list(execution.get("results", []) or [])),
        repair_count=len(list(repair.get("repairs", []) or [])),
        artifact_paths=artifact_paths,
        summary=(
            str(review_summary.get("summary") or "")
            if review_summary.get("requires_manual_review")
            else (str(runtime_failure.get("message") or "") if runtime_result.get("status") != "succeeded" else "run completed successfully")
        ),
        reason=str(runtime_failure.get("message") or ""),
    )
    recommended_actions = _build_owner_recommended_actions(
        ticket_id=ticket_id,
        review_summary=review_summary,
        validation=validation,
        write_gate=write_gate,
        runtime_failure=runtime_failure,
        artifact_paths=artifact_paths,
    )
    overall_summary = run_summary.get("summary") or test_summary.get("summary") or review_queue_summary.get("summary") or "Run summary unavailable"
    return build_owner_summary(
        ticket_id=ticket_id,
        run_id=str(runtime_run.get("run_id") or ""),
        task_id=str(runtime_task.get("task_id") or ""),
        status=str(runtime_result.get("status") or "unknown"),
        summary=str(overall_summary),
        run_summary=run_summary,
        test_summary=test_summary,
        review_queue_summary=review_queue_summary,
        recommended_actions=recommended_actions,
        artifact_paths=artifact_paths,
    )


def _score_grade(value: int) -> str:
    if value >= 90:
        return "A"
    if value >= 80:
        return "B"
    if value >= 70:
        return "C"
    if value >= 60:
        return "D"
    return "F"


def _build_experiment_payload(
    *,
    ticket_id: str,
    audit: dict[str, Any],
    validation: dict[str, Any],
    review_summary: dict[str, Any],
    write_gate: dict[str, Any],
    runtime_context: dict[str, Any],
    runtime_task: dict[str, Any],
    runtime_run: dict[str, Any],
    runtime_result: dict[str, Any],
    runtime_failure: dict[str, Any],
    execution: dict[str, Any],
    repair: dict[str, Any],
    engine_decisions: list[dict[str, Any]],
    engine_metrics: dict[str, Any],
    owner_summary: dict[str, Any],
    artifact_paths: list[str],
    experiment_dataset_path: str,
    experiment_artifact_path: str,
    project_root: Path,
) -> dict[str, Any]:
    strategy = str(audit.get("strategy") or "")
    run_id = str(runtime_run.get("run_id") or "")
    task_id = str(runtime_task.get("task_id") or "")
    scenario_id = f"exp-scn-{ticket_id or 'unknown'}-{str(runtime_task.get('action') or 'run')}"
    host_boundary = dict(runtime_context.get("host_boundary") or runtime_context.get("hostBoundary") or {})
    scenario = build_experiment_scenario(
        scenario_id=scenario_id,
        ticket_id=ticket_id,
        run_id=run_id,
        task_id=task_id,
        action=str(runtime_task.get("action") or runtime_result.get("action") or "run"),
        mode=str(runtime_task.get("mode") or runtime_result.get("mode") or "integrate"),
        strategy=strategy,
        objective=str(runtime_task.get("desc") or owner_summary.get("summary") or runtime_failure.get("message") or ""),
        host_kind=str(host_boundary.get("host_kind") or host_boundary.get("hostKind") or ""),
        status="completed",
        metadata={
            "run_mode": str(runtime_task.get("run_mode") or runtime_run.get("run_mode") or "manual"),
        },
    )
    test_results = [item for item in list(validation.get("results", []) or []) if isinstance(item, dict)]
    fingerprints = [dict(item) for item in list(validation.get("fingerprints", []) or []) if isinstance(item, dict)]
    failed_count = sum(1 for item in test_results if not item.get("ok", False))
    passed_count = sum(1 for item in test_results if item.get("ok", False))
    repair_count = len(list(repair.get("repairs", []) or []))
    low_confidence_patch_count = int(next((item.get("count") for item in engine_decisions if isinstance(item, dict) and item.get("type") == "low-confidence-patches"), 0) or 0)
    review_required = bool(review_summary.get("requires_manual_review"))
    write_confirmation_required = bool(write_gate.get("requires_confirmation") and not write_gate.get("allow_write"))
    success = str(runtime_result.get("status") or "") == "succeeded"
    final_score = 100
    if not success:
        final_score -= 35
    final_score -= min(30, failed_count * 12)
    final_score -= min(18, repair_count * 6)
    final_score -= min(10, int(sum(1 for item in fingerprints if item.get("blocking"))) * 5)
    final_score -= min(15, low_confidence_patch_count * 5)
    if review_required:
        final_score -= 15
    if write_confirmation_required:
        final_score -= 5
    final_score = max(0, min(100, final_score))
    reasons: list[str] = []
    if runtime_failure.get("message"):
        reasons.append(str(runtime_failure.get("message") or ""))
    if review_required and review_summary.get("summary"):
        reasons.append(str(review_summary.get("summary") or ""))
    retry_reason = str((validation.get("retry_policy") or {}).get("reason") or "")
    if retry_reason:
        reasons.append(retry_reason)
    if not reasons and success:
        reasons.append("runtime completed successfully")
    historical_rows = load_experiment_dataset(project_root, target=Path(experiment_dataset_path)) if experiment_dataset_path else load_experiment_dataset(project_root)
    performance_baseline = build_performance_baseline_scorecard(
        history_rows=historical_rows,
        started_at=str(runtime_run.get("started_at") or runtime_result.get("started_at") or ""),
        finished_at=str(runtime_result.get("finished_at") or runtime_run.get("finished_at") or ""),
        status=str(runtime_result.get("status") or "unknown"),
        review_required=review_required,
        write_confirmation_required=write_confirmation_required,
        validation_failed_count=failed_count,
        repair_count=repair_count,
        review_queue_summary=dict(owner_summary.get("review_queue_summary") or {}),
    )
    supervision_label = build_supervision_label_summary(
        review_summary=review_summary,
        write_gate=write_gate,
        runtime_result=runtime_result,
    )
    scorecard = build_experiment_scorecard(
        ticket_id=ticket_id,
        run_id=run_id,
        task_id=task_id,
        scenario_id=scenario_id,
        strategy=strategy,
        status=str(runtime_result.get("status") or "unknown"),
        success=success,
        final_score=final_score,
        validation_passed_count=passed_count,
        validation_failed_count=failed_count,
        fingerprint_count=len(fingerprints),
        blocking_fingerprint_count=sum(1 for item in fingerprints if item.get("blocking")),
        repair_count=repair_count,
        review_required=review_required,
        write_confirmation_required=write_confirmation_required,
        low_confidence_patch_count=low_confidence_patch_count,
        created_file_count=len(list(execution.get("created", []) or [])),
        execution_result_count=len(list(execution.get("results", []) or [])),
        decision_count=len(engine_decisions),
        grade=_score_grade(final_score),
        summary=str(owner_summary.get("summary") or (reasons[0] if reasons else "experiment scorecard generated")),
        reasons=reasons,
        artifact_paths=[*artifact_paths, experiment_artifact_path],
        metadata={
            "engine_metrics": dict(engine_metrics or {}),
            "recommended_action_count": len(list(owner_summary.get("recommended_actions") or [])),
            "performance_baseline": performance_baseline,
            "supervision_label": supervision_label,
        },
    )
    strategy_summary = summarize_strategy_patterns(project_root, strategy=strategy)
    benchmark = build_strategy_benchmark(
        ticket_id=ticket_id,
        run_id=run_id,
        task_id=task_id,
        strategy=strategy,
        success_count=int(strategy_summary.get("success_count", 0)),
        failure_count=int(strategy_summary.get("failure_count", 0)),
        success_rate=float(strategy_summary.get("success_rate", 0.0)),
        repeat_count=int(strategy_summary.get("repeat_count", 0)),
        preferred_labels=list(strategy_summary.get("preferred_labels", []) or []),
        preferred_files=list(strategy_summary.get("preferred_files", []) or []),
        recurring_blockers=list(strategy_summary.get("recurring_blockers", []) or []),
        recommended_response=str(strategy_summary.get("recommended_response") or "ticket_repair"),
        confidence_boost=bool(strategy_summary.get("confidence_boost", False)),
    )
    repair_outcome_summary = dict(repair.get("repair_outcome_summary") or {})
    if not repair_outcome_summary:
        repair_rows = []
        for item in list(repair.get("repairs", []) or []):
            if not isinstance(item, dict):
                continue
            repair_rows.append({
                **item,
                "status": str(item.get("status") or ("skipped" if item.get("skipped") else "applied")),
            })
        repair_outcome_summary = summarize_repair_outcomes(
            repair_rows,
            failure_family=str((validation.get("repair_handoff") or {}).get("failureFamily") or ""),
            repair_reason_code=str((validation.get("repair_handoff") or {}).get("repairReasonCode") or ""),
            validation_ok=bool(repair.get("ok", False)),
        )
    training_signals = {
        "validation_fingerprints": [str(item.get("label") or "") for item in fingerprints if str(item.get("label") or "")],
        "retry_action": str((validation.get("retry_policy") or repair.get("retry_policy") or {}).get("action") or ""),
        "review_required": review_required,
        "write_confirmation_required": write_confirmation_required,
        "selected_patch_labels": _selected_patch_labels(execution=execution, repair=repair),
        "blocking_fingerprint_count": sum(1 for item in fingerprints if item.get("blocking")),
        "repair_paths": [str(item.get("path") or "") for item in list(repair.get("repairs", []) or []) if isinstance(item, dict) and str(item.get("path") or "")],
        "failure_taxonomy_summary": dict(validation.get("failure_taxonomy_summary") or summarize_failure_taxonomy(fingerprints)),
        "repair_reason_codes": [
            str(code)
            for code in {
                str((repair.get("repair_outcome_summary") or {}).get("repair_reason_code") or ""),
                str((validation.get("repair_handoff") or {}).get("repairReasonCode") or ""),
            }
            if str(code)
        ],
        "repair_outcome_summary": repair_outcome_summary,
        "supervision_label": supervision_label,
    }
    experiment_run = build_experiment_run(
        experiment_id=f"exp-{ticket_id or 'unknown'}-{run_id or 'run'}",
        ticket_id=ticket_id,
        run_id=run_id,
        task_id=task_id,
        strategy=strategy,
        status=str(runtime_result.get("status") or "unknown"),
        scenario=scenario,
        scorecard=scorecard,
        strategy_benchmark=benchmark,
        dataset_path=experiment_dataset_path,
        artifact_paths=[*artifact_paths, experiment_artifact_path],
        training_signals=training_signals,
        metadata={
            "runtime_status": str(runtime_result.get("status") or "unknown"),
            "final_state": str(runtime_result.get("final_state") or runtime_run.get("state") or "unknown"),
            "started_at": str(runtime_run.get("started_at") or runtime_result.get("started_at") or ""),
            "finished_at": str(runtime_result.get("finished_at") or runtime_run.get("finished_at") or ""),
            "safe_task": bool(performance_baseline.get("safe_task")),
            "performance_metrics": dict(performance_baseline.get("current") or {}),
            "supervision_label": supervision_label,
        },
    )
    return {
        "experiment_run": experiment_run,
        "experiment_scenario": scenario,
        "experiment_scorecard": scorecard,
        "strategy_benchmark": benchmark,
    }


def _build_engine_decisions(
    *,
    audit: dict[str, Any],
    execution: dict[str, Any],
    validation: dict[str, Any],
    repair: dict[str, Any],
    write_gate: dict[str, Any],
    review_summary: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    decisions: list[dict[str, Any]] = []
    confidence = audit.get("confidence")
    if confidence is not None or write_gate:
        decisions.append({
            "type": "write-confidence",
            "confidence": write_gate.get("confidence", confidence),
            "requires_confirmation": write_gate.get("requires_confirmation", confidence_score(confidence) < 0.8),
            "allow_write": write_gate.get("allow_write"),
            "downgraded_to_preview": write_gate.get("downgraded_to_preview"),
            "reason": write_gate.get("reason") or "manual confirmation required below pilot execution threshold",
        })
    retry_policy = validation.get("retry_policy") or repair.get("retry_policy") or {}
    if retry_policy:
        decisions.append({
            "type": "retry-policy",
            "action": retry_policy.get("action"),
            "reason": retry_policy.get("reason"),
        })
    if repair.get("skipped"):
        decisions.append({
            "type": "repair-skip",
            "reason": repair.get("skip_reason") or (retry_policy.get("reason") if isinstance(retry_policy, dict) else "repair skipped by policy"),
        })
    low_confidence_patches = []
    for item in execution.get("results", []) or []:
        review = item.get("ai_patch_review") if isinstance(item, dict) else None
        if isinstance(review, dict) and float(review.get("selected_score") or 0) < 0.35:
            low_confidence_patches.append({
                "path": item.get("path"),
                "score": review.get("selected_score"),
                "label": review.get("selected_label"),
            })
    if low_confidence_patches:
        decisions.append({
            "type": "low-confidence-patches",
            "count": len(low_confidence_patches),
            "patches": low_confidence_patches,
        })
    if review_summary:
        decisions.append({
            "type": "review-summary",
            "requires_manual_review": bool(review_summary.get("requires_manual_review")),
            "pending_approval_count": int(review_summary.get("pending_approval_count") or 0),
            "pending_review_count": int(review_summary.get("pending_review_count") or 0),
            "review_request_count": int(review_summary.get("review_request_count") or 0),
            "low_confidence_patch_count": int(review_summary.get("low_confidence_patch_count") or 0),
            "summary": review_summary.get("summary") or "",
        })
    return decisions


def _build_engine_metrics(
    *,
    execution: dict[str, Any],
    validation: dict[str, Any],
    repair: dict[str, Any],
    decisions: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "created_file_count": len(execution.get("created", []) or []),
        "execution_result_count": len(execution.get("results", []) or []),
        "validation_failure_count": sum(1 for item in validation.get("results", []) or [] if not item.get("ok", False)),
        "validation_fingerprint_count": len(validation.get("fingerprints", []) or []),
        "blocking_fingerprint_count": sum(1 for item in validation.get("fingerprints", []) or [] if item.get("blocking")),
        "repair_count": len(repair.get("repairs", []) or []),
        "repair_skipped": bool(repair.get("skipped")),
        "decision_count": len(decisions),
    }


@dataclass
class ReleaseAgent:
    name: str = "release"

    def run(
        self,
        ticket_id: str,
        *,
        audit: dict[str, Any],
        plan: dict[str, Any],
        execution: dict[str, Any],
        validation: dict[str, Any],
        repair: dict[str, Any],
        project_root: Path,
        mode: str,
        branch: str | None = None,
        provider: Any = None,
        decision_timeline: list[dict[str, Any]] | None = None,
        write_gate: dict[str, Any] | None = None,
        runtime_context: dict[str, Any] | None = None,
        handoff_history: list[dict[str, Any]] | None = None,
        pending_approvals: list[dict[str, Any]] | None = None,
        runtime_task: dict[str, Any] | None = None,
        runtime_run: dict[str, Any] | None = None,
        runtime_result: dict[str, Any] | None = None,
        runtime_failure: dict[str, Any] | None = None,
        runtime_events: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        timestamp = datetime.now(timezone.utc).isoformat()
        release_notes = ""
        if provider is not None:
            try:
                release_notes = provider.summarize(
                    f"Ticket: {ticket_id}\n"
                    f"Mode: {mode}\n"
                    f"Audit: {audit}\n"
                    f"Plan: {plan}\n"
                    f"Execution: {execution}\n"
                    f"Validation: {validation}\n"
                    f"Repair: {repair}"
                )
            except Exception:
                release_notes = ""
        cleanup_summary = build_cleanup_candidate_summary(
            project_root=project_root,
            execution=execution,
            repair=repair,
        )
        duplicate_summary = build_run_duplicate_summary(
            execution=execution,
            repair=repair,
        )
        stage_speed_summary = build_stage_speed_summary(
            runtime_events=list(runtime_events or []),
            started_at=str((runtime_run or {}).get("started_at") or (runtime_result or {}).get("started_at") or ""),
            finished_at=str((runtime_result or {}).get("finished_at") or (runtime_run or {}).get("finished_at") or timestamp),
        )
        effective_write_gate = apply_cleanup_write_gate(write_gate or {}, cleanup_summary)
        review_summary = build_review_summary(
            execution_results=list(execution.get("results", []) or []),
            repair_entries=list(repair.get("repairs", []) or []),
            pending_approvals=list(pending_approvals or []),
            handoff_history=list(handoff_history or []),
            runtime_context=dict(runtime_context or {}),
            runtime_task=runtime_task,
            runtime_run=runtime_run,
            write_gate=effective_write_gate,
        )
        engine_decisions = _build_engine_decisions(
            audit=audit,
            execution=execution,
            validation=validation,
            repair=repair,
            write_gate=effective_write_gate,
            review_summary=review_summary,
        )
        engine_metrics = _build_engine_metrics(
            execution=execution,
            validation=validation,
            repair=repair,
            decisions=engine_decisions,
        )
        runtime_run_payload = dict(runtime_run or {})
        runtime_task_payload = dict(runtime_task or {})
        run_target = build_run_artifact_path(
            project_root,
            {
                "timestamp": timestamp,
                "ticket": ticket_id,
                "mode": mode,
            },
        )
        summary_target = build_human_summary_path(
            project_root,
            {
                "timestamp": timestamp,
                "ticket": ticket_id,
                "mode": mode,
            },
        )
        experiment_target = build_experiment_artifact_path(
            project_root,
            {
                "timestamp": timestamp,
                "ticket": ticket_id,
                "mode": mode,
            },
        )
        experiment_dataset_target = assistant_experiment_dataset_path(project_root)
        runtime_artifacts = [
            build_runtime_artifact(
                run_id=str(runtime_run_payload.get("run_id") or ""),
                task_id=str(runtime_task_payload.get("task_id") or ""),
                ticket_id=ticket_id,
                kind="run-artifact",
                path=str(run_target),
                format="json",
                producer=self.name,
                summary="structured runtime artifact",
            ),
            build_runtime_artifact(
                run_id=str(runtime_run_payload.get("run_id") or ""),
                task_id=str(runtime_task_payload.get("task_id") or ""),
                ticket_id=ticket_id,
                kind="human-summary",
                path=str(summary_target),
                format="markdown",
                producer=self.name,
                summary="human-readable runtime summary",
            ),
            build_runtime_artifact(
                run_id=str(runtime_run_payload.get("run_id") or ""),
                task_id=str(runtime_task_payload.get("task_id") or ""),
                ticket_id=ticket_id,
                kind="experiment-artifact",
                path=str(experiment_target),
                format="json",
                producer=self.name,
                summary="experiment run and scorecard artifact",
            ),
        ] + [dict(item) for item in list(review_summary.get("review_artifacts", []) or []) if isinstance(item, dict)]
        runtime_result_payload = dict(runtime_result or {})
        inferred_status = "succeeded"
        inferred_state = "succeeded"
        inferred_ok = bool(audit.get("allowed", True)) and bool(validation.get("ok", True)) and not bool(review_summary.get("requires_manual_review"))
        if not inferred_ok:
            inferred_status = "blocked" if (not audit.get("allowed", True) or repair.get("skipped") or review_summary.get("requires_manual_review")) else "failed"
            inferred_state = inferred_status
        runtime_result_payload.setdefault("schema_version", runtime_run_payload.get("schema_version"))
        runtime_result_payload.setdefault("task_id", str(runtime_task_payload.get("task_id") or ""))
        runtime_result_payload.setdefault("run_id", str(runtime_run_payload.get("run_id") or ""))
        runtime_result_payload.setdefault("ticket", ticket_id)
        runtime_result_payload.setdefault("action", str(runtime_task_payload.get("action") or "run"))
        runtime_result_payload.setdefault("mode", mode)
        runtime_result_payload.setdefault("run_mode", str(runtime_task_payload.get("run_mode") or runtime_run_payload.get("run_mode") or "manual"))
        runtime_result_payload.setdefault("ok", inferred_ok)
        runtime_result_payload.setdefault("status", inferred_status)
        runtime_result_payload.setdefault("final_state", inferred_state)
        runtime_result_payload.setdefault("started_at", runtime_run_payload.get("started_at"))
        runtime_result_payload.setdefault("finished_at", runtime_run_payload.get("finished_at") or timestamp)
        runtime_result_payload.setdefault("failure", dict(runtime_failure or {}))
        runtime_result_payload.setdefault("metrics", dict(engine_metrics or {}))
        runtime_result_payload.setdefault("metadata", {})
        runtime_result_payload["review_state"] = dict(review_summary.get("review_state") or {})
        runtime_result_payload["review_requests"] = list(review_summary.get("review_requests") or [])
        runtime_result_payload["review_summary"] = dict(review_summary or {})
        runtime_result_payload["artifact_paths"] = [item["path"] for item in runtime_artifacts if str(item.get("path") or "")]
        owner_summary = _build_owner_summary_payload(
            ticket_id=ticket_id,
            audit=audit,
            validation=validation,
            review_summary=review_summary,
            write_gate=effective_write_gate,
            runtime_task=runtime_task_payload,
            runtime_run=runtime_run_payload,
            runtime_result=runtime_result_payload,
            runtime_failure=dict(runtime_failure or {}),
            execution=execution,
            repair=repair,
            branch=branch,
            runtime_artifacts=runtime_artifacts,
        )
        runtime_result_payload["owner_summary"] = dict(owner_summary)
        runtime_result_payload["run_summary"] = dict(owner_summary.get("run_summary") or {})
        runtime_result_payload["test_summary"] = dict(owner_summary.get("test_summary") or {})
        runtime_result_payload["review_queue_summary"] = dict(owner_summary.get("review_queue_summary") or {})
        runtime_result_payload["recommended_actions"] = list(owner_summary.get("recommended_actions") or [])
        experiment_payload = _build_experiment_payload(
            ticket_id=ticket_id,
            audit=audit,
            validation=validation,
            review_summary=review_summary,
            write_gate=effective_write_gate,
            runtime_context=runtime_context or {},
            runtime_task=runtime_task_payload,
            runtime_run=runtime_run_payload,
            runtime_result=runtime_result_payload,
            runtime_failure=dict(runtime_failure or {}),
            execution=execution,
            repair=repair,
            engine_decisions=engine_decisions,
            engine_metrics=engine_metrics,
            owner_summary=owner_summary,
            artifact_paths=runtime_result_payload["artifact_paths"],
            experiment_dataset_path=str(experiment_dataset_target),
            experiment_artifact_path=str(experiment_target),
            project_root=project_root,
        )
        performance_baseline = dict((experiment_payload.get("experiment_scorecard") or {}).get("metadata", {}).get("performance_baseline") or {})
        trust_summary = build_trust_summary(
            runtime_result=runtime_result_payload,
            review_queue_summary=dict(owner_summary.get("review_queue_summary") or {}),
            performance_baseline=performance_baseline,
            cleanup_summary=cleanup_summary,
            duplicate_summary=duplicate_summary,
            supervision_label=dict((experiment_payload.get("experiment_scorecard") or {}).get("metadata", {}).get("supervision_label") or {}),
            stage_speed_summary=stage_speed_summary,
            write_gate=effective_write_gate,
        )
        run_summary_payload = dict(owner_summary.get("run_summary") or {})
        run_summary_metadata = dict(run_summary_payload.get("metadata") or {})
        run_summary_metadata["performance_baseline"] = performance_baseline
        run_summary_metadata["cleanup_summary"] = cleanup_summary
        run_summary_metadata["duplicate_summary"] = duplicate_summary
        run_summary_metadata["supervision_label"] = dict((experiment_payload.get("experiment_scorecard") or {}).get("metadata", {}).get("supervision_label") or {})
        run_summary_metadata["stage_speed_summary"] = stage_speed_summary
        run_summary_metadata["trust_summary"] = trust_summary
        run_summary_payload["metadata"] = run_summary_metadata
        owner_summary["run_summary"] = run_summary_payload
        runtime_result_payload["owner_summary"] = dict(owner_summary)
        runtime_result_payload["run_summary"] = dict(run_summary_payload)
        experiment_scorecard_payload = dict(experiment_payload.get("experiment_scorecard") or {})
        experiment_scorecard_metadata = dict(experiment_scorecard_payload.get("metadata") or {})
        experiment_scorecard_metadata["cleanup_summary"] = cleanup_summary
        experiment_scorecard_metadata["duplicate_summary"] = duplicate_summary
        experiment_scorecard_metadata["stage_speed_summary"] = stage_speed_summary
        experiment_scorecard_metadata["trust_summary"] = trust_summary
        experiment_scorecard_payload["metadata"] = experiment_scorecard_metadata
        experiment_payload["experiment_scorecard"] = experiment_scorecard_payload
        runtime_result_payload["experiment_run"] = dict(experiment_payload.get("experiment_run") or {})
        runtime_result_payload["experiment_scenario"] = dict(experiment_payload.get("experiment_scenario") or {})
        runtime_result_payload["experiment_scorecard"] = dict(experiment_scorecard_payload)
        runtime_result_payload["strategy_benchmark"] = dict(experiment_payload.get("strategy_benchmark") or {})
        payload = json_safe({
            "timestamp": timestamp,
            "ticket": ticket_id,
            "mode": mode,
            "strategy": audit.get("strategy"),
            "audit": audit,
            "plan": plan,
            "branch": branch,
            "results": execution.get("results", []),
            "validation": validation.get("results", []),
            "validation_fingerprints": validation.get("fingerprints", []),
            "retry_policy": validation.get("retry_policy") or repair.get("retry_policy") or {},
            "repair": repair.get("repairs", []),
            "write_gate": effective_write_gate,
            "engine_decisions": engine_decisions,
            "engine_metrics": engine_metrics,
            "decision_timeline": decision_timeline or [],
            "runtime_context": runtime_context or {},
            "runtime_task": runtime_task_payload,
            "runtime_run": runtime_run_payload,
            "runtime_result": runtime_result_payload,
            "runtime_failure": dict(runtime_failure or {}),
            "runtime_events": list(runtime_events or []),
            "runtime_artifacts": runtime_artifacts,
            "review_summary": review_summary,
            "owner_summary": owner_summary,
            "run_summary": dict(run_summary_payload),
            "test_summary": dict(owner_summary.get("test_summary") or {}),
            "review_queue_summary": dict(owner_summary.get("review_queue_summary") or {}),
            "recommended_actions": list(owner_summary.get("recommended_actions") or []),
            "experiment_run": dict(experiment_payload.get("experiment_run") or {}),
            "experiment_scenario": dict(experiment_payload.get("experiment_scenario") or {}),
            "experiment_scorecard": dict(experiment_scorecard_payload),
            "strategy_benchmark": dict(experiment_payload.get("strategy_benchmark") or {}),
            "release_notes": release_notes,
            "commit_message": f"agent: {mode} BAT<{ticket_id}>" if ticket_id else "agent: runtime release",
        })
        dataset_row = json_safe({
            "timestamp": timestamp,
            "ticket": ticket_id,
            "mode": mode,
            "strategy": audit.get("strategy"),
            "run_artifact": str(run_target),
            "human_summary": str(summary_target),
            "experiment_run": dict(experiment_payload.get("experiment_run") or {}),
            "experiment_scorecard": dict(experiment_scorecard_payload),
            "strategy_benchmark": dict(experiment_payload.get("strategy_benchmark") or {}),
        })
        dataset_path = append_experiment_dataset(project_root, dataset_row, target=experiment_dataset_target)
        experiment_run = dict(experiment_payload.get("experiment_run") or {})
        experiment_run["dataset_path"] = str(dataset_path) if dataset_path else ""
        experiment_payload["experiment_run"] = experiment_run
        runtime_result_payload["experiment_run"] = experiment_run
        payload["experiment_run"] = experiment_run
        benchmark_artifact_paths = [
            str(path)
            for path in [
                str(run_target),
                str(summary_target),
                str(experiment_target),
                str(dataset_path) if dataset_path else "",
            ]
            if str(path or "")
        ]
        dataset_rows = load_experiment_dataset(project_root, target=experiment_dataset_target)
        experiment_benchmark_summary = summarize_experiment_dataset(
            project_root,
            rows=dataset_rows,
            target=experiment_dataset_target,
            artifact_paths=benchmark_artifact_paths,
        )
        owner_experiment_summary = build_owner_experiment_summary_from_benchmark(
            experiment_benchmark_summary,
            artifact_paths=benchmark_artifact_paths,
        )
        training_handoff = build_training_handoff_from_dataset(
            experiment_benchmark_summary,
            dataset_rows,
            export_path="",
            filters={},
            artifact_paths=benchmark_artifact_paths,
        )
        runtime_result_payload["experiment_benchmark_summary"] = dict(experiment_benchmark_summary)
        runtime_result_payload["owner_experiment_summary"] = dict(owner_experiment_summary)
        runtime_result_payload["training_handoff"] = dict(training_handoff)
        payload["experiment_benchmark_summary"] = dict(experiment_benchmark_summary)
        payload["owner_experiment_summary"] = dict(owner_experiment_summary)
        payload["training_handoff"] = dict(training_handoff)
        artifact = write_run_artifact(project_root, payload, target=run_target)
        summary = write_human_summary(project_root, payload, target=summary_target)
        experiment_artifact = write_experiment_artifact(
            project_root,
            json_safe({
                "timestamp": timestamp,
                "ticket": ticket_id,
                "mode": mode,
                "experiment_benchmark_summary": dict(experiment_benchmark_summary),
                "owner_experiment_summary": dict(owner_experiment_summary),
                "training_handoff": dict(training_handoff),
                **experiment_payload,
            }),
            target=experiment_target,
        )
        update_dashboard(
            project_root,
            {
                "timestamp": timestamp,
                "ticket": ticket_id,
                "mode": mode,
                "strategy": audit.get("strategy"),
                "branch": branch,
                "status": runtime_result_payload.get("status"),
                "summary": owner_summary.get("summary"),
                "review_pending_count": owner_summary.get("review_queue_summary", {}).get("pending_review_count", 0),
                "recommended_actions": list(owner_summary.get("recommended_actions") or []),
                "artifact_paths": list(owner_summary.get("artifact_paths") or []),
                "experiment_score": experiment_payload.get("experiment_scorecard", {}).get("final_score"),
                "experiment_best_strategy": experiment_benchmark_summary.get("best_strategy", {}).get("strategy"),
                "experiment_recommended_action": owner_experiment_summary.get("recommended_next_action"),
            },
        )
        return {
            "agent": self.name,
            "ok": True,
            "engine_decisions": engine_decisions,
            "engine_metrics": engine_metrics,
            "decision_timeline": decision_timeline or [],
            "review_summary": review_summary,
            "review_requests": list(review_summary.get("review_requests") or []),
            "review_state": dict(review_summary.get("review_state") or {}),
            "owner_summary": owner_summary,
            "run_summary": dict(owner_summary.get("run_summary") or {}),
            "test_summary": dict(owner_summary.get("test_summary") or {}),
            "review_queue_summary": dict(owner_summary.get("review_queue_summary") or {}),
            "recommended_actions": list(owner_summary.get("recommended_actions") or []),
            "experiment_run": dict(experiment_payload.get("experiment_run") or {}),
            "experiment_scenario": dict(experiment_payload.get("experiment_scenario") or {}),
            "experiment_scorecard": dict(experiment_scorecard_payload),
            "strategy_benchmark": dict(experiment_payload.get("strategy_benchmark") or {}),
            "experiment_benchmark_summary": dict(experiment_benchmark_summary),
            "owner_experiment_summary": dict(owner_experiment_summary),
            "training_handoff": dict(training_handoff),
            "runtime_result": runtime_result_payload,
            "runtime_artifacts": runtime_artifacts,
            "artifacts": {
                "run_artifact": str(artifact) if artifact else None,
                "human_summary": str(summary) if summary else None,
                "experiment_artifact": str(experiment_artifact) if experiment_artifact else None,
                "experiment_dataset": str(dataset_path) if dataset_path else None,
                "release_notes": release_notes,
                "commit_message": payload["commit_message"],
            },
        }
