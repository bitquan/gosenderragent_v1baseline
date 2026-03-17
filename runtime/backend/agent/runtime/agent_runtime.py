from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from backend.agent.agents import ImplementerAgent, PlannerAgent, ReleaseAgent, RepairAgent, ValidatorAgent
from backend.agent.core.editor_context import normalize_editor_context
from backend.agent.core.runtime_context import build_runtime_context
from backend.agent.core.agent_registry import AgentRegistry, build_default_agent_registry
from backend.agent.core.model_routing import build_agent_model_routing_summary
from backend.agent.core.providers.stage_router import route_provider_for_agent
from backend.agent.core.memory_service import record_memory, summarize_failure_patterns, summarize_runtime_memory_hints
from backend.agent.core.permissions import PermissionRegistry, ToolPermissionError, build_default_permissions
from backend.agent.core.runtime_utils import confidence_score, diff_text, run_mode
from backend.agent.runtime.contracts import (
    DEV_ENGINE_LOOP_STEPS,
    RECOVERY_LADDER_STEPS,
    build_checkpoint_ref,
    build_failure_class,
    build_interrupt_request,
    build_operator_execution_result,
    build_recovery_ladder_state,
    build_review_bundle,
    build_runtime_failure,
    build_runtime_result,
    build_runtime_run,
    build_runtime_task,
    build_task_objective,
    build_workbench_artifact,
)
from backend.agent.runtime.orchestration_driver import RuntimeOrchestrationDriver


RUNTIME_AGENT_REQUIRED_TOOLS: dict[str, tuple[str, ...]] = {
    "planner": ("read_file", "search_repo", "list_tasks"),
    "implementer": ("read_file", "search_repo", "edit_file", "smart_patch", "run_command"),
    "validator": ("read_file", "search_repo", "run_command"),
    "repair": ("read_file", "search_repo", "edit_file", "smart_patch", "run_command"),
    "release": ("read_file", "git_status", "notify"),
}


def _selected_patch_labels(result: dict[str, Any]) -> list[str]:
    labels: list[str] = []
    for item in list(result.get("execution", {}).get("results", []) or []):
        review = item.get("ai_patch_review") if isinstance(item, dict) else None
        label = review.get("selected_label") if isinstance(review, dict) else None
        if label:
            labels.append(str(label))
    for item in list(result.get("repair", {}).get("repairs", []) or []):
        review = item.get("patch_review") if isinstance(item, dict) else None
        label = review.get("selected_label") if isinstance(review, dict) else None
        if label:
            labels.append(str(label))
    return labels


def _base_result(ticket_id: str, mode: str, desc: str = "") -> dict[str, Any]:
    return {
        "ticket": ticket_id,
        "mode": mode,
        "desc": desc,
        "editor_context": {},
        "runtime_context": {},
        "audit": {},
        "plan": {},
        "execution": {"results": [], "created": [], "ok": True},
        "validation": {"results": [], "ok": True},
        "repair": {"repairs": [], "ok": True},
        "reasoning": {},
        "artifacts": {},
        "write_gate": {},
        "review_requests": [],
        "review_state": {},
        "review_summary": {},
        "owner_summary": {},
        "run_summary": {},
        "test_summary": {},
        "review_queue_summary": {},
        "recommended_actions": [],
        "experiment_run": {},
        "experiment_scenario": {},
        "experiment_scorecard": {},
        "strategy_benchmark": {},
        "experiment_benchmark_summary": {},
        "owner_experiment_summary": {},
        "training_handoff": {},
        "engine_decisions": [],
        "engine_metrics": {},
        "decision_timeline": [],
        "agent_results": [],
        "runtime_task": {},
        "runtime_run": {},
        "runtime_result": {},
        "runtime_failure": {},
        "runtime_events": [],
        "runtime_artifacts": [],
        "ok": True,
    }


def _timeline_event(stage: str, event: str, summary: str, **fields: Any) -> dict[str, Any]:
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "stage": str(stage or "runtime"),
        "event": str(event or "decision"),
        "summary": str(summary or ""),
    }
    for key, value in fields.items():
        if value is not None:
            payload[str(key)] = value
    return payload


def _runtime_action(args: Any) -> str:
    if bool(getattr(args, "plan", False)):
        return "plan"
    if bool(getattr(args, "repair", False)) and not bool(getattr(args, "execute", False) or getattr(args, "write", False) or getattr(args, "implement", False)):
        return "repair"
    if bool(getattr(args, "implement", False) or getattr(args, "write", False)):
        return "implement"
    if bool(getattr(args, "execute", False)):
        return "run"
    return "review"


def _transition_runtime(
    result: dict[str, Any],
    *,
    ticket_id: str,
    next_state: str,
    stage: str,
    summary: str,
    level: str = "info",
    **data: Any,
) -> None:
    RuntimeOrchestrationDriver(result, ticket_id=ticket_id).enter_stage(
        next_state=next_state,
        stage=stage,
        summary=summary,
        level=level,
        **data,
    )


def _record_agent_output(
    result: dict[str, Any],
    *,
    ticket_id: str,
    agent_name: str,
    stage: str,
    decision: str,
    summary: str,
    confidence: float | int | None = None,
    ok: bool | None = None,
    artifacts: list[str] | None = None,
    **metadata: Any,
) -> None:
    RuntimeOrchestrationDriver(result, ticket_id=ticket_id).append_agent_output(
        agent_name=agent_name,
        stage=stage,
        decision=decision,
        summary=summary,
        confidence=confidence,
        ok=ok,
        artifacts=artifacts,
        **metadata,
    ) 


def _dict_items(values: Any) -> list[dict[str, Any]]:
    return [dict(item) for item in list(values or []) if isinstance(item, dict)]


def _created_paths(result: dict[str, Any]) -> list[str]:
    execution = dict(result.get("execution") or {})
    return [str(path) for path in list(execution.get("created") or []) if str(path or "")]


def _runtime_changed_files(result: dict[str, Any]) -> list[dict[str, Any]]:
    runtime_context = dict(result.get("runtime_context") or {})
    return _dict_items(runtime_context.get("changed_files") or runtime_context.get("changedFiles") or [])


def _classify_validation_failure_kind(result: dict[str, Any]) -> str:
    validation = dict(result.get("validation") or {})
    repair = dict(result.get("repair") or {})
    retry_policy = dict(validation.get("retry_policy") or repair.get("retry_policy") or {})
    explicit_code = str(
        validation.get("failure_class")
        or validation.get("failureClass")
        or retry_policy.get("failure_class")
        or retry_policy.get("failureClass")
        or ""
    ).strip().lower()
    if explicit_code:
        return explicit_code

    created_paths = _created_paths(result)
    changed_files = _runtime_changed_files(result)
    fingerprints = _dict_items(validation.get("fingerprints"))
    text_parts = [
        str(validation.get("summary") or ""),
        str(repair.get("skip_reason") or ""),
        str(retry_policy.get("reason") or ""),
    ]
    for item in fingerprints:
        text_parts.extend(
            [
                str(item.get("label") or ""),
                str(item.get("summary") or ""),
                str(item.get("message") or ""),
                str(item.get("kind") or ""),
                str(item.get("code") or ""),
                str(item.get("type") or ""),
            ]
        )
    haystack = " ".join(part.strip().lower() for part in text_parts if str(part).strip())
    no_material_change = not created_paths and not changed_files

    if any(token in haystack for token in ["invalid change set", "invalid-change-set", "invalid patch", "malformed patch", "outside allowed", "outside target", "unsafe path", "blocked path", "path filter"]):
        return "invalid-change-set"
    if any(token in haystack for token in ["parse failure", "parse-failure", "unable to parse", "parser", "syntax", "json decode", "yaml parse"]):
        return "parse-failure"
    if no_material_change and any(token in haystack for token in ["no-op", "noop", "no changes", "no changed files", "0 changed files", "empty proposal", "empty patch", "no edits", "did not produce edits"]):
        return "empty-proposal"
    if no_material_change and not list(validation.get("commands") or []):
        return "empty-proposal"
    return "validation-failure"


def _derive_runtime_failure(result: dict[str, Any]) -> dict[str, Any]:
    runtime_task = dict(result.get("runtime_task") or {})
    runtime_run = dict(result.get("runtime_run") or {})
    ticket_id = str(result.get("ticket") or runtime_task.get("ticket") or "")
    audit = dict(result.get("audit") or {})
    validation = dict(result.get("validation") or {})
    repair = dict(result.get("repair") or {})
    review_state = dict(result.get("review_state") or {})
    review_summary = dict(result.get("review_summary") or {})

    if review_state.get("requires_manual_review"):
        return build_runtime_failure(
            ticket_id=ticket_id,
            run_id=str(runtime_run.get("run_id") or ""),
            task_id=str(runtime_task.get("task_id") or ""),
            stage="release",
            kind="review-required",
            message=str(review_summary.get("summary") or "manual review required before runtime can complete"),
            retryable=False,
            blocking=True,
            details={
                "review_state": review_state,
                "review_summary": review_summary,
            },
        )

    if audit and not audit.get("allowed", True):
        return build_runtime_failure(
            ticket_id=ticket_id,
            run_id=str(runtime_run.get("run_id") or ""),
            task_id=str(runtime_task.get("task_id") or ""),
            stage="planning",
            kind="ticket-blocked",
            message=str(audit.get("block_reason") or "ticket is not eligible for execution"),
            retryable=False,
            blocking=True,
            details={"audit": audit},
        )

    if validation.get("ok", True):
        return {}

    retry_policy = dict(validation.get("retry_policy") or repair.get("retry_policy") or {})
    stage = "repair" if repair else "validation"
    failure_kind = _classify_validation_failure_kind(result)
    default_message = {
        "empty-proposal": "The engine returned no usable edits for the requested objective.",
        "parse-failure": "The engine response could not be parsed into a valid change proposal.",
        "invalid-change-set": "The proposed change set was unsafe or invalid for the current workspace bounds.",
        "validation-failure": "validation failed",
    }.get(failure_kind, "validation failed")
    fingerprint_rows = _dict_items(validation.get("fingerprints"))
    message = str(repair.get("skip_reason") or retry_policy.get("reason") or default_message)
    return build_runtime_failure(
        ticket_id=ticket_id,
        run_id=str(runtime_run.get("run_id") or ""),
        task_id=str(runtime_task.get("task_id") or ""),
        stage=stage,
        kind=failure_kind,
        message=message,
        retryable=str(retry_policy.get("action") or "repair").strip().lower() in {"repair", "run", "plan", "implement"},
        blocking=bool(any(item.get("blocking") for item in fingerprint_rows)),
        retry_policy=retry_policy,
        fingerprints=fingerprint_rows,
        details={
            "repair_skipped": bool(repair.get("skipped", False)),
            "skip_reason": str(repair.get("skip_reason") or ""),
            "created_paths": _created_paths(result)[:8],
            "changed_file_count": len(_runtime_changed_files(result)),
            "fingerprint_labels": [str(item.get("label") or "") for item in fingerprint_rows if str(item.get("label") or "")],
            "validation_command_count": len(list(validation.get("commands") or [])),
        },
    )


def _build_task_objective_contract(result: dict[str, Any], *, desc: str) -> dict[str, Any]:
    runtime_task = dict(result.get("runtime_task") or {})
    metadata = dict(runtime_task.get("metadata") or {})
    seed = dict(metadata.get("task_objective") or metadata.get("taskObjective") or {})
    return build_task_objective(
        summary=str(seed.get("summary") or desc or result.get("ticket") or ""),
        kind=str(seed.get("kind") or runtime_task.get("action") or result.get("mode") or ""),
        source=str(seed.get("source") or metadata.get("surface") or "desktop-runtime"),
        task_mode=str(runtime_task.get("task_mode") or metadata.get("taskMode") or metadata.get("task_mode") or ""),
        action=str(runtime_task.get("action") or ""),
        lane_id=str(metadata.get("lane_id") or metadata.get("laneId") or ""),
        lane_label=str(metadata.get("lane_label") or metadata.get("laneLabel") or ""),
        loop_steps=list(seed.get("loop_steps") or seed.get("loopSteps") or DEV_ENGINE_LOOP_STEPS),
        metadata={
            "ticket": str(result.get("ticket") or ""),
            "mode": str(result.get("mode") or ""),
            "model_role": str(metadata.get("modelRole") or metadata.get("model_role") or ""),
        },
    )


def _build_failure_class_contract(result: dict[str, Any]) -> dict[str, Any]:
    runtime_failure = dict(result.get("runtime_failure") or {})
    review_summary = dict(result.get("review_summary") or {})
    if runtime_failure:
        code = str(runtime_failure.get("kind") or "").strip().lower()
        code = {
            "review-required": "reviewer-block",
            "ticket-blocked": "risky-interrupt",
            "tool-loop-failure": "validation-failure",
        }.get(code, code)
        return build_failure_class(
            code=code,
            summary=str(runtime_failure.get("message") or ""),
            stage=str(runtime_failure.get("stage") or ""),
            retryable=bool(runtime_failure.get("retryable", False)),
            blocking=bool(runtime_failure.get("blocking", False)),
            metadata={
                "details": dict(runtime_failure.get("details") or {}),
                "retry_policy": dict(runtime_failure.get("retry_policy") or {}),
            },
        )
    if bool(review_summary.get("requires_manual_review")):
        return build_failure_class(
            code="reviewer-block",
            summary=str(review_summary.get("summary") or "manual review required"),
            stage="review",
            retryable=False,
            blocking=True,
            metadata={
                "pending_review_count": int(review_summary.get("pending_review_count") or 0),
            },
        )
    return {}


def _build_recovery_ladder_contract(result: dict[str, Any]) -> dict[str, Any]:
    runtime_run = dict(result.get("runtime_run") or {})
    runtime_failure = dict(result.get("runtime_failure") or {})
    validation = dict(result.get("validation") or {})
    repair = dict(result.get("repair") or {})
    retry_policy = dict(runtime_failure.get("retry_policy") or validation.get("retry_policy") or repair.get("retry_policy") or {})
    retry_action = str(retry_policy.get("action") or "").strip().lower()
    failure_code = str(runtime_failure.get("kind") or "").strip().lower()
    review_required = bool(result.get("review_state", {}).get("requires_manual_review"))
    stage_or_state = str(runtime_run.get("state") or runtime_run.get("current_stage") or "").strip().lower()
    next_step = {
        "repair": "repair-oriented-route",
        "run": "local-targeted-coding",
        "plan": "bridge-plan-retry",
        "implement": "stronger-coding-route",
    }.get(retry_action, "")
    if review_required or stage_or_state == "blocked":
        current_step = "interrupt-or-rollback"
        next_step = "interrupt-or-rollback"
    elif failure_code == "empty-proposal":
        current_step = "research-expansion"
        next_step = "research-expansion"
    elif failure_code == "parse-failure":
        current_step = "bridge-plan-retry"
        next_step = "bridge-plan-retry"
    elif failure_code == "invalid-change-set":
        current_step = "sandbox-retry" if bool(runtime_failure.get("blocking", False)) else "stronger-coding-route"
        next_step = current_step
    elif failure_code == "validation-failure":
        current_step = "repair-oriented-route"
        next_step = next_step or "repair-oriented-route"
    else:
        current_step = {
            "planning": "local-targeted-coding",
            "implementing": "local-targeted-coding",
            "executing": "local-targeted-coding",
            "validating": "repair-oriented-route" if not validation.get("ok", True) else "validate",
            "repairing": "repair-oriented-route",
            "releasing": "interrupt-or-rollback" if review_required else "review",
            "blocked": "interrupt-or-rollback",
            "failed": "interrupt-or-rollback",
            "succeeded": "continue-stop",
        }.get(stage_or_state, "")
    history = [
        {
            "stage": str(item.get("stage") or ""),
            "state": str(item.get("state") or ""),
            "summary": str(item.get("summary") or ""),
            "entered_at": str(item.get("timestamp") or item.get("entered_at") or ""),
        }
        for item in list(result.get("runtime_events") or [])
        if isinstance(item, dict) and str(item.get("summary") or "")
    ]
    if failure_code and str(runtime_failure.get("message") or ""):
        history.append(
            {
                "stage": str(runtime_failure.get("stage") or stage_or_state or "runtime"),
                "state": "blocked" if review_required or bool(runtime_failure.get("blocking", False)) else ("failed" if failure_code else stage_or_state),
                "summary": str(runtime_failure.get("message") or ""),
                "entered_at": str(runtime_run.get("updated_at") or runtime_run.get("finished_at") or ""),
            }
        )
    ladder_state = str(runtime_run.get("state") or "").strip().lower()
    if ladder_state == "blocked":
        ladder_state = "blocked"
    elif ladder_state in {"failed"}:
        ladder_state = "failed"
    elif ladder_state in {"succeeded"}:
        ladder_state = "completed"
    else:
        ladder_state = "running"
    return build_recovery_ladder_state(
        state=ladder_state,
        current_step=current_step,
        next_step=next_step,
        available_steps=RECOVERY_LADDER_STEPS,
        history=history[-8:],
        metadata={
            "retry_policy": retry_policy,
            "repair_skipped": bool(repair.get("skipped", False)),
            "repair_count": len(list(repair.get("repairs") or [])),
            "failure_code": failure_code,
            "review_required": review_required,
            "changed_file_count": len(_runtime_changed_files(result)),
            "self_heal_policy": dict((result.get("runtime_context") or {}).get("self_heal_policy") or {}),
        },
    )


def _build_checkpoint_ref_contract(result: dict[str, Any]) -> dict[str, Any]:
    runtime_run = dict(result.get("runtime_run") or {})
    artifacts = dict(result.get("artifacts") or {})
    validation = dict(result.get("validation") or {})
    created_paths = _created_paths(result)
    changed_files = _runtime_changed_files(result)
    related_targets = [str(path) for path in list(validation.get("related_targets") or []) if str(path or "")]
    artifact_paths = [
        str(path)
        for path in [
            artifacts.get("run_artifact"),
            artifacts.get("human_summary"),
            artifacts.get("experiment_artifact"),
            artifacts.get("experiment_dataset"),
        ]
        if str(path or "")
    ]
    primary_path = str(
        artifacts.get("run_artifact")
        or artifacts.get("human_summary")
        or artifacts.get("experiment_artifact")
        or ""
    )
    ref_id = str(runtime_run.get("run_id") or primary_path or result.get("ticket") or "")
    if not ref_id and not primary_path:
        return {}
    return build_checkpoint_ref(
        ref_id=ref_id,
        label="latest-runtime-artifact" if primary_path else "runtime-checkpoint",
        kind="artifact-ref" if primary_path else "runtime-checkpoint",
        path=primary_path,
        summary="Latest runtime artifact recorded for trace, retry, and review." if primary_path else "Latest runtime state captured even though no dedicated artifact file was emitted yet.",
        metadata={
            "artifact_paths": artifact_paths,
            "related_targets": related_targets[:8],
            "created_paths": created_paths[:8],
            "changed_files": changed_files[:8],
            "validation_command_count": len(list(validation.get("commands") or [])),
        },
    )


def _build_interrupt_request_contract(result: dict[str, Any]) -> dict[str, Any]:
    review_summary = dict(result.get("review_summary") or {})
    review_state = dict(result.get("review_state") or {})
    runtime_failure = dict(result.get("runtime_failure") or {})
    review_requests = [dict(item) for item in list(result.get("review_requests") or []) if isinstance(item, dict)]
    pending_approvals = [dict(item) for item in list(review_summary.get("pending_approvals") or []) if isinstance(item, dict)]
    if pending_approvals:
        return build_interrupt_request(
            kind="approval",
            summary=str(review_summary.get("summary") or f"{len(pending_approvals)} approval request(s) pending"),
            active=True,
            requested_action="approve-risky-action",
            allowed_actions=["approve-risky-action", "open-trace", "resume-interrupted-task"],
            request_count=len(pending_approvals),
            metadata={"requests": pending_approvals[:5], "review_requests": review_requests[:5]},
        )
    if bool(review_state.get("requires_manual_review")):
        return build_interrupt_request(
            kind="review",
            summary=str(review_summary.get("summary") or "manual review required"),
            active=True,
            requested_action="resolve-review",
            allowed_actions=["open-trace", "open-files", "review-findings", "resume-interrupted-task"],
            request_count=int(review_state.get("pending_review_count") or len(review_requests)),
            metadata={"review_requests": review_requests[:5]},
        )
    if runtime_failure and bool(runtime_failure.get("blocking", False)):
        failure_kind = str(runtime_failure.get("kind") or "").strip().lower()
        return build_interrupt_request(
            kind="runtime-block",
            summary=str(runtime_failure.get("message") or "runtime blocked"),
            active=True,
            requested_action="retry-with-research" if failure_kind in {"empty-proposal", "parse-failure"} else ("repair-loop" if failure_kind == "validation-failure" else "rollback-or-interrupt"),
            allowed_actions=["open-trace", "open-files", "retry-with-research", "repair-loop", "rollback-last-pass", "rollback-or-interrupt"],
            request_count=1,
            metadata={"failure_kind": str(runtime_failure.get("kind") or "")},
        )
    return {}


def _build_review_bundle_details(
    *,
    verdict: str,
    review_summary: dict[str, Any],
    review_state: dict[str, Any],
    review_requests: list[dict[str, Any]],
    runtime_failure: dict[str, Any],
    changed_files: list[dict[str, Any]],
    repair: dict[str, Any],
) -> dict[str, Any]:
    failure_kind = str(runtime_failure.get("kind") or "").strip().lower()
    pending_count = int(review_state.get("pending_review_count") or review_summary.get("pending_review_count") or 0)
    low_confidence_patch_count = int(review_summary.get("low_confidence_patch_count") or 0)
    first_request = review_requests[0] if review_requests else {}
    first_changed_path = str((changed_files[0] or {}).get("path") or "").strip() if changed_files else ""
    review_next_action = str(
        review_summary.get("next_action")
        or review_summary.get("nextAction")
        or first_request.get("next_action")
        or first_request.get("nextAction")
        or ""
    ).strip()
    review_reason = str(
        review_summary.get("summary")
        or first_request.get("summary")
        or runtime_failure.get("message")
        or ""
    ).strip()
    change_summary = (
        f"{len(changed_files)} changed file(s) touched"
        + (f", starting with {first_changed_path}" if first_changed_path else "")
        if changed_files
        else "No changed files were captured yet."
    )
    fix_actions: list[str] = []
    reason = review_reason
    how_to_fix = ""

    if verdict == "pending-review":
        reason = review_reason or "Manual review or approval is still required before the run can continue."
        how_to_fix = review_next_action or (
            "Open the latest trace or changed files, address the held review items, and clear the pending approvals."
            if pending_count
            else "Review the latest bounded run and either approve it or request a focused revision."
        )
        fix_actions = ["review-interrupt", "open-files", "open-trace"]
    elif verdict == "repair-required":
        reason = review_reason or {
            "empty-proposal": "The engine returned no usable edits for the current bounded objective.",
            "parse-failure": "The engine response could not be parsed into a valid change set.",
            "invalid-change-set": "The proposed patch was outside the allowed workspace bounds or otherwise unsafe.",
            "validation-failure": "Validation failed for the current bounded change.",
        }.get(failure_kind, "The run needs another bounded repair pass before it can be approved.")
        how_to_fix = review_next_action or {
            "empty-proposal": "Retry with more repo research or a tighter prompt before asking for another patch.",
            "parse-failure": "Retry from a smaller bridge plan or stronger structured prompt so the next change set parses cleanly.",
            "invalid-change-set": "Keep the next patch inside the allowed target paths or retry it in the sandbox/worktree first.",
            "validation-failure": "Repair the failing validation path and rerun the smallest relevant check before continuing.",
        }.get(failure_kind, "Run one bounded repair pass and rerun the most relevant validation before continuing.")
        fix_actions = [
            "retry-with-research" if failure_kind in {"empty-proposal", "parse-failure"} else "repair-loop",
            "open-trace",
            "open-files",
        ]
        if failure_kind == "invalid-change-set":
            fix_actions.insert(1, "open-sandbox")
    elif verdict == "approved-with-warnings":
        reason = review_reason or "The run is usable, but low-confidence changes still deserve a spot check."
        how_to_fix = review_next_action or "Inspect the changed files and rerun the most relevant validation before promotion."
        fix_actions = ["open-files", "open-trace", "continue-run"]
    elif verdict == "approved":
        reason = review_reason or "The current bounded run cleared validation and review gates."
        how_to_fix = review_next_action or "Keep the next slice bounded and continue from the latest objective."
        fix_actions = ["continue-run", "open-files"]
    else:
        reason = review_reason or "The run is blocked by the current runtime or review gate."
        how_to_fix = review_next_action or (
            "Resolve the blocking issue, inspect the latest trace, and roll back the last pass if the current change should not continue."
        )
        fix_actions = ["review-interrupt", "rollback-last-pass", "open-trace"]

    return {
        "decision_label": {
            "pending-review": "Review required",
            "repair-required": "Repair required",
            "approved-with-warnings": "Approved with warnings",
            "approved": "Approved",
            "blocked": "Blocked",
        }.get(verdict, "Observed"),
        "reason": reason,
        "how_to_fix": how_to_fix,
        "change_summary": change_summary,
        "approval_state": verdict or ("approved" if verdict == "approved-with-warnings" else "observed"),
        "approved": verdict in {"approved", "approved-with-warnings"},
        "fix_actions": fix_actions,
        "metadata": {
            "low_confidence_patch_count": low_confidence_patch_count,
            "failure_kind": failure_kind,
            "repair_skipped": bool(repair.get("skipped", False)),
        },
    }


def _build_review_bundle_contract(result: dict[str, Any]) -> dict[str, Any]:
    review_summary = dict(result.get("review_summary") or {})
    review_state = dict(result.get("review_state") or {})
    review_requests = [dict(item) for item in list(result.get("review_requests") or []) if isinstance(item, dict)]
    runtime_failure = dict(result.get("runtime_failure") or {})
    verdict = "observed"
    failure_kind = str(runtime_failure.get("kind") or "").strip().lower()
    if bool(review_summary.get("requires_manual_review")) or bool(review_state.get("requires_manual_review")):
        verdict = "pending-review"
    elif failure_kind in {"validation-failure", "empty-proposal", "parse-failure", "invalid-change-set"}:
        verdict = "repair-required"
    elif bool(result.get("ok", False)) and int(review_summary.get("low_confidence_patch_count") or 0) > 0:
        verdict = "approved-with-warnings"
    elif bool(result.get("ok", False)):
        verdict = "approved"
    elif runtime_failure:
        verdict = "blocked"
    details = _build_review_bundle_details(
        verdict=verdict,
        review_summary=review_summary,
        review_state=review_state,
        review_requests=review_requests,
        runtime_failure=runtime_failure,
        changed_files=_runtime_changed_files(result),
        repair=dict(result.get("repair") or {}),
    )
    return build_review_bundle(
        verdict=verdict,
        summary=str(review_summary.get("summary") or ""),
        decision_label=str(details.get("decision_label") or ""),
        reason=str(details.get("reason") or ""),
        how_to_fix=str(details.get("how_to_fix") or ""),
        change_summary=str(details.get("change_summary") or ""),
        approval_state=str(details.get("approval_state") or ""),
        approved=bool(details.get("approved")),
        requires_manual_review=bool(review_summary.get("requires_manual_review") or review_state.get("requires_manual_review")),
        request_count=len(review_requests),
        pending_count=int(review_state.get("pending_review_count") or review_summary.get("pending_review_count") or 0),
        fix_actions=list(details.get("fix_actions") or []),
        trust_summary=dict((result.get("run_summary", {}).get("metadata") or {}).get("trust_summary") or {}),
        review_requests=review_requests[:5],
        metadata=dict(details.get("metadata") or {}),
    )


def _build_workbench_artifacts_contract(result: dict[str, Any]) -> list[dict[str, Any]]:
    runtime_context = dict(result.get("runtime_context") or {})
    changed_files = [dict(item) for item in list(runtime_context.get("changed_files") or runtime_context.get("changedFiles") or []) if isinstance(item, dict)]
    artifacts = dict(result.get("artifacts") or {})
    rows: list[dict[str, Any]] = []
    for item in changed_files[:8]:
        rows.append(
            build_workbench_artifact(
                kind="changed-file",
                label=str(item.get("path") or ""),
                path=str(item.get("path") or ""),
                summary=str(item.get("status") or "changed"),
                status="available",
            )
        )
    for kind, raw_path in (
        ("run-artifact", artifacts.get("run_artifact")),
        ("human-summary", artifacts.get("human_summary")),
        ("benchmark-artifact", artifacts.get("experiment_artifact")),
        ("benchmark-dataset", artifacts.get("experiment_dataset")),
    ):
        if not str(raw_path or ""):
            continue
        rows.append(
            build_workbench_artifact(
                kind=kind,
                label=str(raw_path).split("/")[-1].split("\\")[-1],
                path=str(raw_path),
                summary=kind.replace("-", " "),
                status="available",
            )
        )
    return rows[:10]


def _requested_execution(audit: dict[str, Any], args: Any, should_auto_implement_fn: Callable[[dict[str, Any]], bool] | None) -> bool:
    should_exec = bool(getattr(args, "execute", False) or getattr(args, "write", False))
    if getattr(args, "autopilot", False) and (getattr(args, "implement", False) or (should_auto_implement_fn and should_auto_implement_fn(audit))):
        should_exec = True
    return should_exec


def _runtime_memory_hints(
    project_root: Path,
    *,
    ticket_id: str,
    strategy: str,
    validation: dict[str, Any] | None = None,
    editor_context: dict[str, Any] | None = None,
    runtime_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    validation_payload = dict(validation or {})
    editor_payload = dict(editor_context or {})
    runtime_payload = dict(runtime_context or {})
    target_path = str(editor_payload.get("active_file_path") or runtime_payload.get("active_file_path") or "").strip()
    if not target_path:
        changed_files = [dict(item) for item in list(runtime_payload.get("changed_files") or runtime_payload.get("changedFiles") or []) if isinstance(item, dict)]
        target_path = str((changed_files[0] or {}).get("path") or "").strip()
    return summarize_runtime_memory_hints(
        project_root,
        ticket=ticket_id,
        strategy=strategy,
        fingerprint_labels=[str(item.get("label") or "") for item in list(validation_payload.get("fingerprints", []) or []) if str(item.get("label") or "")],
        target_path=target_path,
        active_file_path=str(editor_payload.get("active_file_path") or "").strip(),
    )


def _memory_state_payload(failure_memory: dict[str, Any] | None = None, memory_hints: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(failure_memory or {})
    hints = dict(memory_hints or {})
    if hints:
        payload["memory_hints"] = hints
        payload["summary"] = str(hints.get("summary") or payload.get("summary") or "")
        payload["recommended_response"] = str(hints.get("recommended_response") or payload.get("recommended_response") or "")
        payload["top_reject_reason"] = str(hints.get("top_reject_reason") or "")
        payload["top_phase_label"] = str(hints.get("top_phase_label") or "")
    return payload


def _tune_retry_policy_with_memory(
    retry_policy: dict[str, Any] | None,
    *,
    failure_memory: dict[str, Any] | None = None,
    memory_hints: dict[str, Any] | None = None,
) -> dict[str, Any]:
    policy = dict(retry_policy or {})
    hints = dict(memory_hints or {})
    if int(hints.get("reject_count", 0) or 0) < 2:
        return policy
    learned_action = str(hints.get("runtime_retry_action") or "").strip().lower()
    if not learned_action:
        return policy
    current_action = str(policy.get("action") or "").strip().lower()
    repeat_count = int((failure_memory or {}).get("repeat_count", 0) or 0)
    should_override = False
    if learned_action == "repair" and current_action != "repair":
        should_override = True
    elif learned_action == "run" and current_action == "repair" and repeat_count >= 2:
        should_override = True
    elif learned_action == "run" and not current_action:
        should_override = True
    if not should_override:
        return policy
    learned_reason = str(hints.get("top_reject_reason") or hints.get("summary") or "").strip()
    learned_phase_label = str(hints.get("top_phase_label") or "").strip()
    learned_prompt = str(hints.get("recommended_prompt") or "").strip()
    suffix = f" Learned guidance{f' for {learned_phase_label}' if learned_phase_label else ''}: {learned_reason or learned_prompt}".strip()
    policy["action"] = learned_action
    policy["reason"] = f"{str(policy.get('reason') or '').strip()}{suffix}".strip()
    policy["learned_guidance"] = True
    policy["learned_phase_id"] = str(hints.get("top_phase_id") or "").strip()
    policy["learned_phase_label"] = learned_phase_label
    policy["learned_prompt"] = learned_prompt
    return policy


def _build_write_gate(audit: dict[str, Any], args: Any, *, requested_execution: bool, host_boundary: dict[str, Any] | None = None) -> dict[str, Any]:
    confidence = confidence_score(audit.get("confidence", 0))
    requested_write = bool(getattr(args, "write", False))
    confirm_override = bool(getattr(args, "confirm", False))
    boundary = dict(host_boundary or {})
    approval_protected_only = bool(boundary.get("approval_protected_only", boundary.get("approvalProtectedOnly", False)))
    auto_approve_low_risk = bool(boundary.get("auto_approve_low_risk", boundary.get("autoApproveLowRisk", False)))
    requires_confirmation = bool(approval_protected_only or confidence < 0.8)
    allow_write = bool(
        requested_write
        and (
            confirm_override
            or (not requires_confirmation and (confidence >= 0.8 or auto_approve_low_risk))
        )
    )
    downgraded_to_preview = bool(requested_execution and requested_write and not allow_write)
    if requested_write and approval_protected_only and not confirm_override:
        reason = "approval-protected execution requires confirmation before writes"
    elif requested_write and not allow_write:
        reason = "manual confirmation required below pilot execution threshold"
    else:
        reason = "writes permitted"
    return {
        "requested_execution": bool(requested_execution),
        "requested_write": requested_write,
        "allow_write": allow_write,
        "downgraded_to_preview": downgraded_to_preview,
        "confidence": audit.get("confidence"),
        "confidence_score": confidence,
        "requires_confirmation": requires_confirmation,
        "reason": reason,
    }


def _orchestrate_retry_flow(
    *,
    ticket_id: str,
    audit: dict[str, Any],
    plan: dict[str, Any],
    validation: dict[str, Any],
    repairer: RepairAgent,
    adapter: Any,
    provider: Any,
    project_root: Path,
    args: Any,
    editor_context: dict[str, Any],
    runtime_context: dict[str, Any] | None = None,
    decision_timeline: list[dict[str, Any]],
    force_repair: bool = False,
) -> dict[str, Any]:
    failure_memory = summarize_failure_patterns(
        project_root,
        ticket=ticket_id,
        strategy=str(audit.get("strategy") or ""),
        fingerprint_labels=[str(item.get("label") or "") for item in list(validation.get("fingerprints", []) or [])],
    )
    memory_hints = _runtime_memory_hints(
        project_root,
        ticket_id=ticket_id,
        strategy=str(audit.get("strategy") or ""),
        validation=validation,
        editor_context=editor_context,
        runtime_context=runtime_context,
    )
    retry_policy = _tune_retry_policy_with_memory(
        validation.get("retry_policy") or {},
        failure_memory=failure_memory,
        memory_hints=memory_hints,
    )
    max_retry_rounds = max(1, int(getattr(args, "max_retry_rounds", 2) or 2))
    policy_attempts = max(1, int(retry_policy.get("max_attempts") or 1))
    repair_attempt_budget = min(max_retry_rounds, policy_attempts)
    action = str(retry_policy.get("action") or "repair")

    decision_timeline.append(
        _timeline_event(
            "validation",
            "retry-policy",
            retry_policy.get("reason") or "retry policy selected",
            action=action,
            max_attempts=repair_attempt_budget,
            cooldown_seconds=int(retry_policy.get("cooldown_seconds") or 0),
            failure_repeat_count=int(failure_memory.get("repeat_count", 0)),
            learned_response=str(memory_hints.get("recommended_response") or ""),
        )
    )

    if validation.get("ok", True):
        if force_repair:
            decision_timeline.append(
                _timeline_event(
                    "repair",
                    "requested",
                    "explicit repair request forwarded to repair agent",
                    action="repair",
                )
            )
            return repairer.run(
                adapter,
                plan,
                validation,
                provider=provider,
                project_root=project_root,
                should_repair=True,
                max_retries=repair_attempt_budget,
                editor_context=editor_context,
                runtime_context=runtime_context or {},
            )
        return {
            "agent": repairer.name,
            "ok": True,
            "repair": {
                "repairs": [],
                "ok": True,
                "retry_policy": retry_policy,
                "failure_memory": failure_memory,
                "memory_hints": memory_hints,
            },
        }

    if action != "repair":
        decision_timeline.append(
            _timeline_event(
                "repair",
                "skipped",
                retry_policy.get("reason") or "repair skipped by runtime policy",
                action=action,
            )
        )
        return {
            "agent": repairer.name,
            "ok": False,
            "repair": {
                "repairs": [],
                "ok": False,
                "retry_policy": retry_policy,
                "failure_memory": failure_memory,
                "memory_hints": memory_hints,
                "skipped": True,
                "skip_reason": retry_policy.get("reason") or "repair skipped by runtime policy",
                "validation": validation,
            },
        }

    host_boundary = dict((runtime_context or {}).get("host_boundary") or (runtime_context or {}).get("hostBoundary") or {})
    is_lab_mode = str(host_boundary.get("host_kind") or host_boundary.get("hostKind") or "").strip().lower() == "lab"

    if failure_memory.get("cooldown_active") and not is_lab_mode:
        skip_reason = f"repair cooldown active until {failure_memory.get('cooldown_until')}"
        decision_timeline.append(_timeline_event("repair", "cooldown-skip", skip_reason, action=action))
        return {
            "agent": repairer.name,
            "ok": False,
            "repair": {
                "repairs": [],
                "ok": False,
                "retry_policy": retry_policy,
                "failure_memory": failure_memory,
                "memory_hints": memory_hints,
                "skipped": True,
                "skip_reason": skip_reason,
                "validation": validation,
            },
        }

    if int(failure_memory.get("repeat_count", 0)) >= repair_attempt_budget and not is_lab_mode:
        skip_reason = f"repair halted after repeated fingerprint failures ({failure_memory.get('repeat_count')})"
        decision_timeline.append(_timeline_event("repair", "repeat-halt", skip_reason, action=action))
        return {
            "agent": repairer.name,
            "ok": False,
            "repair": {
                "repairs": [],
                "ok": False,
                "retry_policy": retry_policy,
                "failure_memory": failure_memory,
                "memory_hints": memory_hints,
                "skipped": True,
                "skip_reason": skip_reason,
                "validation": validation,
            },
        }

    decision_timeline.append(
        _timeline_event(
            "repair",
            "attempting",
            "repair loop started",
            action=action,
            max_retries=repair_attempt_budget,
        )
    )
    return repairer.run(
        adapter,
        plan,
        validation,
        provider=provider,
        project_root=project_root,
        should_repair=True,
        max_retries=repair_attempt_budget,
        editor_context=editor_context,
        runtime_context=runtime_context or {},
    )
def _refresh_runtime_context(
    root: Path,
    *,
    ticket_id: str,
    desc: str,
    editor_context: dict[str, Any],
    plan: dict[str, Any] | None = None,
    validation: dict[str, Any] | None = None,
    repair: dict[str, Any] | None = None,
    artifact_paths: list[str] | None = None,
    approval_state: dict[str, Any] | None = None,
    permission_state: dict[str, Any] | None = None,
    memory_state: dict[str, Any] | None = None,
    host_boundary: dict[str, Any] | None = None,
    self_heal_policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return build_runtime_context(
        root,
        ticket_id=ticket_id,
        desc=desc,
        editor_context=editor_context,
        plan=plan,
        validation=validation,
        repair=repair,
        artifact_paths=artifact_paths,
        approval_state=approval_state,
        permission_state=permission_state,
        memory_state=memory_state,
        host_boundary=host_boundary,
        self_heal_policy=self_heal_policy,
    )


def _host_boundary(args: Any) -> dict[str, Any]:
    boundary = dict(getattr(args, "host_boundary", {}) or getattr(args, "hostBoundary", {}) or {})
    if not boundary:
        return {}
    return {
        "host_kind": str(boundary.get("host_kind") or boundary.get("hostKind") or boundary.get("host") or ""),
        "action": str(boundary.get("action") or ""),
        "autonomy_mode": str(boundary.get("autonomy_mode") or boundary.get("autonomyMode") or ""),
        "self_improvement_only": bool(boundary.get("self_improvement_only", boundary.get("selfImprovementOnly", False))),
        "project_maintenance_only": bool(boundary.get("project_maintenance_only", boundary.get("projectMaintenanceOnly", False))),
        "owner_automation_only": bool(boundary.get("owner_automation_only", boundary.get("ownerAutomationOnly", False))),
        "approval_protected_only": bool(boundary.get("approval_protected_only", boundary.get("approvalProtectedOnly", False))),
        "auto_approve_low_risk": bool(boundary.get("auto_approve_low_risk", boundary.get("autoApproveLowRisk", False))),
        "baseline_self_heal_priority": bool(boundary.get("baseline_self_heal_priority", boundary.get("baselineSelfHealPriority", False))),
        "sandbox_required": bool(boundary.get("sandbox_required", boundary.get("sandboxRequired", False))),
        "require_review": bool(boundary.get("require_review", boundary.get("requireReview", False))),
        "allowed_target_paths": [str(path) for path in list(boundary.get("allowed_target_paths", boundary.get("allowedTargetPaths", [])) or []) if str(path)],
        "project_root": str(boundary.get("project_root") or boundary.get("projectRoot") or ""),
        "self_improvement_depth": int(boundary.get("self_improvement_depth", boundary.get("selfImprovementDepth", 0)) or 0),
        "max_self_improvement_tasks": int(boundary.get("max_self_improvement_tasks", boundary.get("maxSelfImprovementTasks", 0)) or 0),
        "project_maintenance_depth": int(boundary.get("project_maintenance_depth", boundary.get("projectMaintenanceDepth", 0)) or 0),
        "max_project_maintenance_tasks": int(boundary.get("max_project_maintenance_tasks", boundary.get("maxProjectMaintenanceTasks", 0)) or 0),
        "owner_automation_depth": int(boundary.get("owner_automation_depth", boundary.get("ownerAutomationDepth", 0)) or 0),
        "max_owner_automation_tasks": int(boundary.get("max_owner_automation_tasks", boundary.get("maxOwnerAutomationTasks", 0)) or 0),
        "allow_followup_execution": bool(boundary.get("allow_followup_execution", boundary.get("allowFollowupExecution", False))),
        "execution_mode": str(boundary.get("execution_mode") or boundary.get("executionMode") or ""),
        "docker_image": str(boundary.get("docker_image") or boundary.get("dockerImage") or ""),
        "container_workdir": str(boundary.get("container_workdir") or boundary.get("containerWorkdir") or ""),
    }


def _self_heal_policy(validation: dict[str, Any] | None, failure_memory: dict[str, Any] | None, runtime_context: dict[str, Any] | None) -> dict[str, Any]:
    validation_payload = dict(validation or {})
    retry_policy = dict(validation_payload.get("retry_policy") or {})
    memory_payload = dict(failure_memory or {})
    runtime_payload = dict(runtime_context or {})
    baseline_state = dict(runtime_payload.get("baseline_state") or {})
    memory_hints = dict(memory_payload.get("memory_hints") or {})
    enabled = bool(
        retry_policy.get("baseline_self_heal_priority")
        or memory_payload.get("recommended_response") == "self_heal"
        or str(memory_hints.get("recommended_response") or "").strip().lower() in {"repair-loop", "retry-with-research"}
    )
    return {
        "enabled": enabled,
        "reason": str(memory_hints.get("top_reject_reason") or retry_policy.get("self_heal_reason") or baseline_state.get("reason") or ""),
        "recommended_response": str(memory_hints.get("recommended_response") or memory_payload.get("recommended_response") or "ticket_repair"),
        "recommended_prompt": str(memory_hints.get("recommended_prompt") or ""),
        "top_phase_label": str(memory_hints.get("top_phase_label") or ""),
        "cooldown_active": bool(memory_payload.get("cooldown_active", False)),
        "repeat_count": int(memory_payload.get("repeat_count", 0)),
    }


def _require_agent_capabilities(
    agent_name: str,
    *,
    agent_registry: AgentRegistry,
    permission_registry: PermissionRegistry,
) -> None:
    agent = agent_registry.get_agent(agent_name)
    declared_tools = set(agent.allowed_tools)
    required_tools = RUNTIME_AGENT_REQUIRED_TOOLS.get(agent_name, ())
    missing_declared = [tool_name for tool_name in required_tools if tool_name not in declared_tools]
    if missing_declared:
        raise ToolPermissionError(f"agent '{agent_name}' is missing declared tools: {', '.join(missing_declared)}")
    for tool_name in required_tools:
        permission_registry.require_tool_permission(agent_name, tool_name)


def run_ticket_runtime(
    adapter,
    ticket_id: str,
    *,
    mode: str = "integrate",
    provider: Any = None,
    args: Any = None,
    project_root: Path | None = None,
    classify_ticket: Callable[[str], tuple[str, str]] | None = None,
    get_strategy: Callable[[str], Any] | None = None,
    ignore_dirs: set[str] | None = None,
    scaffold_fn: Callable[..., list[str]] | None = None,
    ensure_branch_fn: Callable[[str, str], str | None] | None = None,
    should_auto_implement_fn: Callable[[dict[str, Any]], bool] | None = None,
    permission_registry: PermissionRegistry | None = None,
    agent_registry: AgentRegistry | None = None,
    editor_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    root = project_root or getattr(adapter, "project_root", Path.cwd())
    args = args or object()
    desc = adapter.load_tickets().get(ticket_id, "")
    result = _base_result(ticket_id, run_mode(args), desc)
    normalized_editor_context = normalize_editor_context(editor_context or getattr(args, "editor_context", None))
    result["editor_context"] = normalized_editor_context
    decision_timeline: list[dict[str, Any]] = result["decision_timeline"]
    permissions = permission_registry or build_default_permissions()
    agents = agent_registry or build_default_agent_registry(permissions, project_root=root)
    result["agent_model_routing"] = build_agent_model_routing_summary(root)
    host_boundary = _host_boundary(args)
    runtime_task = build_runtime_task(
        ticket_id=ticket_id,
        desc=desc,
        action=_runtime_action(args),
        mode=mode,
        run_mode=run_mode(args),
        editor_context=normalized_editor_context,
        host_boundary=host_boundary,
        requested_capabilities={
            "write": bool(getattr(args, "write", False)),
            "execute": bool(getattr(args, "execute", False)),
            "repair": bool(getattr(args, "repair", False)),
            "confirm": bool(getattr(args, "confirm", False)),
        },
    )
    result["runtime_task"] = runtime_task
    result["runtime_run"] = build_runtime_run(task=runtime_task, host_boundary=host_boundary)
    runtime_context = _refresh_runtime_context(
        root,
        ticket_id=ticket_id,
        desc=desc,
        editor_context=normalized_editor_context,
        permission_state=permissions.describe_all(),
        host_boundary=host_boundary,
    )
    result["runtime_context"] = runtime_context
    for agent_name in ("planner", "implementer", "validator", "repair", "release"):
        _require_agent_capabilities(agent_name, agent_registry=agents, permission_registry=permissions)

    _transition_runtime(
        result,
        ticket_id=ticket_id,
        next_state="planning",
        stage="planning",
        summary="planner evaluating ticket and generating plan",
    )

    planner = PlannerAgent()
    implementer = ImplementerAgent()
    validator = ValidatorAgent()
    repairer = RepairAgent()
    releaser = ReleaseAgent()
    planner_provider = route_provider_for_agent(provider, planner.name, root)
    implementer_provider = route_provider_for_agent(provider, implementer.name, root)
    validator_provider = route_provider_for_agent(provider, validator.name, root)
    repair_provider = route_provider_for_agent(provider, repairer.name, root)
    release_provider = route_provider_for_agent(provider, releaser.name, root)

    planner_result = planner.run(
        adapter,
        ticket_id,
        desc,
        provider=planner_provider,
        project_root=root,
        classify_ticket=classify_ticket,
        get_strategy=get_strategy,
        ignore_dirs=ignore_dirs,
        mode=mode,
        editor_context=normalized_editor_context,
        runtime_context=runtime_context,
    )
    result["agent_results"].append({"agent": planner.name, "ok": planner_result.get("ok", False)})
    result["audit"] = planner_result.get("audit", {})
    result["plan"] = planner_result.get("plan", {})
    audit = result["audit"]
    plan = result["plan"]
    _record_agent_output(
        result,
        ticket_id=ticket_id,
        agent_name=planner.name,
        stage="planning",
        decision="allowed" if audit.get("allowed") else "blocked",
        summary=str(audit.get("block_reason") or plan.get("model_summary") or f"planner selected {audit.get('strategy') or 'unknown'} strategy"),
        confidence=audit.get("confidence"),
        ok=bool(planner_result.get("ok", False)),
        artifacts=[str(path) for path in list(plan.get("existing_targets", []) or [])[:5]],
        strategy=audit.get("strategy"),
        proposed_files=list(plan.get("proposed_files", []) or []),
    )
    runtime_context = _refresh_runtime_context(
        root,
        ticket_id=ticket_id,
        desc=desc,
        editor_context=normalized_editor_context,
        plan=plan,
        permission_state=permissions.describe_all(),
        host_boundary=host_boundary,
    )
    result["runtime_context"] = runtime_context
    if not audit.get("allowed"):
        decision_timeline.append(
            _timeline_event(
                "eligibility",
                "blocked",
                audit.get("block_reason") or "ticket is not eligible for execution",
                allowed=False,
            )
        )
        _transition_runtime(
            result,
            ticket_id=ticket_id,
            next_state="blocked",
            stage="planning",
            summary=str(audit.get("block_reason") or "ticket is not eligible for execution"),
            level="warning",
            allowed=False,
        )
        result["runtime_failure"] = _derive_runtime_failure(result)
        result["runtime_result"] = build_runtime_result(
            task=result["runtime_task"],
            runtime_run=result["runtime_run"],
            ok=False,
            failure=result["runtime_failure"],
            artifact_paths=[],
            metrics={
                "validation_failure_count": 0,
                "repair_count": 0,
                "decision_count": len(decision_timeline),
            },
        )
        result["ok"] = False
        return result
    decision_timeline.append(
        _timeline_event(
            "eligibility",
            "allowed",
            "ticket passed eligibility checks",
            strategy=audit.get("strategy"),
            confidence=audit.get("confidence"),
        )
    )

    should_exec = _requested_execution(audit, args, should_auto_implement_fn)
    write_gate = _build_write_gate(audit, args, requested_execution=should_exec, host_boundary=host_boundary)
    result["write_gate"] = write_gate
    decision_timeline.append(
        _timeline_event(
            "execution",
            "write-gate",
            write_gate.get("reason") or "write gate evaluated",
            requested_execution=write_gate.get("requested_execution"),
            requested_write=write_gate.get("requested_write"),
            allow_write=write_gate.get("allow_write"),
            downgraded_to_preview=write_gate.get("downgraded_to_preview"),
            confidence=write_gate.get("confidence"),
        )
    )

    _transition_runtime(
        result,
        ticket_id=ticket_id,
        next_state="implementing" if should_exec else "validating",
        stage="implementation" if should_exec else "validation",
        summary="implementer preparing execution" if should_exec else "execution skipped; moving to validation boundary",
        requested_execution=bool(should_exec),
        allow_write=bool(write_gate.get("allow_write")),
    )

    implementer_result = implementer.run(
        adapter,
        plan,
        provider=implementer_provider,
        allow_write=bool(write_gate.get("allow_write")),
        should_execute=should_exec,
        project_root=root,
        audit_result=audit,
        scaffold_fn=scaffold_fn,
        ensure_branch_fn=ensure_branch_fn,
        editor_context=normalized_editor_context,
        runtime_context=runtime_context,
    )
    result["agent_results"].append({"agent": implementer.name, "ok": implementer_result.get("ok", False)})
    result["execution"] = implementer_result.get("execution", result["execution"])
    branch = result["execution"].get("branch")
    created = list(result["execution"].get("created", []))
    _record_agent_output(
        result,
        ticket_id=ticket_id,
        agent_name=implementer.name,
        stage="implementation",
        decision="executed" if should_exec else "skipped",
        summary=(result["execution"].get("execution_summary") or f"implementer processed {len(result['execution'].get('results', []) or [])} execution result(s)"),
        confidence=write_gate.get("confidence"),
        ok=bool(implementer_result.get("ok", False)),
        artifacts=created,
        allow_write=bool(write_gate.get("allow_write")),
        branch=branch,
        requested_execution=bool(should_exec),
    )
    runtime_context = _refresh_runtime_context(
        root,
        ticket_id=ticket_id,
        desc=desc,
        editor_context=normalized_editor_context,
        plan=plan,
        artifact_paths=created,
        permission_state=permissions.describe_all(),
        host_boundary=host_boundary,
    )
    result["runtime_context"] = runtime_context

    if result["runtime_run"].get("state") != "validating":
        _transition_runtime(
            result,
            ticket_id=ticket_id,
            next_state="validating",
            stage="validation",
            summary="validator evaluating execution outcome",
            created_count=len(created),
        )

    validator_result = validator.run(
        adapter,
        ticket_id,
        audit,
        plan,
        provider=validator_provider,
        project_root=root,
        should_validate=bool(created or should_exec),
        runtime_context=runtime_context,
    )
    result["agent_results"].append({"agent": validator.name, "ok": validator_result.get("ok", False)})
    result["validation"] = validator_result.get("validation", result["validation"])
    validation = result["validation"]
    _record_agent_output(
        result,
        ticket_id=ticket_id,
        agent_name=validator.name,
        stage="validation",
        decision="passed" if validation.get("ok", True) else "failed",
        summary=f"validator ran {len(validation.get('commands', []) or [])} command(s) with {len(validation.get('fingerprints', []) or [])} fingerprint(s)",
        confidence=1.0 if validation.get("ok", True) else 0.35,
        ok=bool(validator_result.get("ok", False)),
        artifacts=[str(path) for path in list(validation.get("related_targets", []) or [])[:5]],
        retry_policy=dict(validation.get("retry_policy") or {}),
    )
    failure_memory = summarize_failure_patterns(
        root,
        ticket=ticket_id,
        strategy=str(audit.get("strategy") or ""),
        fingerprint_labels=[str(item.get("label") or "") for item in list(validation.get("fingerprints", []) or [])],
    )
    validation["retry_policy"] = _tune_retry_policy_with_memory(
        validation.get("retry_policy") or {},
        failure_memory=failure_memory,
        memory_hints=_runtime_memory_hints(
            root,
            ticket_id=ticket_id,
            strategy=str(audit.get("strategy") or ""),
            validation=validation,
            editor_context=normalized_editor_context,
            runtime_context=runtime_context,
        ),
    )
    validation_memory_hints = _runtime_memory_hints(
        root,
        ticket_id=ticket_id,
        strategy=str(audit.get("strategy") or ""),
        validation=validation,
        editor_context=normalized_editor_context,
        runtime_context=runtime_context,
    )
    memory_state = _memory_state_payload(failure_memory, validation_memory_hints)
    self_heal_policy = _self_heal_policy(validation, memory_state, runtime_context)
    runtime_context = _refresh_runtime_context(
        root,
        ticket_id=ticket_id,
        desc=desc,
        editor_context=normalized_editor_context,
        plan=plan,
        validation=validation,
        artifact_paths=created,
        permission_state=permissions.describe_all(),
        memory_state=memory_state,
        host_boundary=host_boundary,
        self_heal_policy=self_heal_policy,
    )
    result["runtime_context"] = runtime_context

    should_attempt_repair = bool(
        getattr(args, "repair", False)
        or not validation.get("ok")
        or getattr(args, "autopilot", False)
        or should_exec
    )
    if should_attempt_repair:
        if bool(getattr(args, "repair", False) or not validation.get("ok", True)):
            _transition_runtime(
                result,
                ticket_id=ticket_id,
                next_state="repairing",
                stage="repair",
                summary="repair flow evaluating validation outcome",
                validation_ok=bool(validation.get("ok", True)),
            )
        repair_result = _orchestrate_retry_flow(
            ticket_id=ticket_id,
            audit=audit,
            plan=plan,
            validation=validation,
            repairer=repairer,
            adapter=adapter,
            provider=repair_provider,
            project_root=root,
            args=args,
            editor_context=normalized_editor_context,
            runtime_context=runtime_context,
            decision_timeline=decision_timeline,
            force_repair=bool(getattr(args, "repair", False)),
        )
    else:
        repair_result = {"agent": repairer.name, "ok": True, "repair": {"repairs": [], "ok": True}}
    result["agent_results"].append({"agent": repairer.name, "ok": repair_result.get("ok", True)})
    result["repair"] = repair_result.get("repair", result["repair"])
    _record_agent_output(
        result,
        ticket_id=ticket_id,
        agent_name=repairer.name,
        stage="repair",
        decision="skipped" if result["repair"].get("skipped") else ("repaired" if result["repair"].get("repairs") else "noop"),
        summary=str(result["repair"].get("skip_reason") or f"repair agent produced {len(result['repair'].get('repairs', []) or [])} repair attempt(s)"),
        confidence=1.0 if result["repair"].get("ok", False) else 0.4,
        ok=bool(repair_result.get("ok", True)),
        artifacts=[str(item.get("path") or "") for item in list(result["repair"].get("repairs", []) or []) if isinstance(item, dict) and str(item.get("path") or "")],
        retry_policy=dict(result["repair"].get("retry_policy") or {}),
    )
    if result["repair"].get("validation"):
        result["validation"] = result["repair"]["validation"]
    artifact_paths = list(result.get("artifacts", {}).get("artifactPaths", []) or [])
    artifact_paths.extend(str(path) for path in result["repair"].get("artifact_paths", []) or [] if str(path))
    runtime_context = _refresh_runtime_context(
        root,
        ticket_id=ticket_id,
        desc=desc,
        editor_context=normalized_editor_context,
        plan=plan,
        validation=result["validation"],
        repair=result["repair"],
        artifact_paths=artifact_paths,
        permission_state=permissions.describe_all(),
        memory_state=_memory_state_payload(failure_memory, validation_memory_hints),
        host_boundary=host_boundary,
        self_heal_policy=_self_heal_policy(result["validation"], _memory_state_payload(failure_memory, validation_memory_hints), runtime_context),
    )
    result["runtime_context"] = runtime_context

    if result["repair"].get("skipped"):
        decision_timeline.append(
            _timeline_event(
                "repair",
                "skipped",
                result["repair"].get("skip_reason") or "repair skipped",
                action=(result["repair"].get("retry_policy") or {}).get("action"),
            )
        )
    elif result["repair"].get("repairs"):
        decision_timeline.append(
            _timeline_event(
                "repair",
                "completed",
                f"applied {len(result['repair'].get('repairs', []))} repair attempt(s)",
                ok=result["repair"].get("ok", False),
            )
        )

    if result["runtime_run"].get("state") not in {"releasing", "blocked", "failed", "succeeded"}:
        _transition_runtime(
            result,
            ticket_id=ticket_id,
            next_state="releasing",
            stage="release",
            summary="release agent packaging runtime outputs",
        )

    release_mode = "plan" if getattr(args, "plan", False) else "execute"
    release_result = releaser.run(
        ticket_id,
        audit=audit,
        plan=plan,
        execution=result["execution"],
        validation=result["validation"],
        repair=result["repair"],
        decision_timeline=decision_timeline,
        write_gate=write_gate,
        runtime_context=runtime_context,
        project_root=root,
        mode=release_mode,
        branch=branch,
        provider=release_provider,
        runtime_task=result.get("runtime_task"),
        runtime_run=result.get("runtime_run"),
        runtime_result=result.get("runtime_result"),
        runtime_failure=result.get("runtime_failure"),
        runtime_events=result.get("runtime_events"),
    )
    result["agent_results"].append({"agent": releaser.name, "ok": release_result.get("ok", False)})
    result["artifacts"] = release_result.get("artifacts", {})
    result["engine_decisions"] = release_result.get("engine_decisions", [])
    result["engine_metrics"] = release_result.get("engine_metrics", {})
    result["decision_timeline"] = release_result.get("decision_timeline", decision_timeline)
    result["runtime_artifacts"] = release_result.get("runtime_artifacts", [])
    result["review_summary"] = dict(release_result.get("review_summary") or {})
    result["review_requests"] = list(release_result.get("review_requests") or [])
    result["review_state"] = dict(release_result.get("review_state") or {})
    result["owner_summary"] = dict(release_result.get("owner_summary") or {})
    result["run_summary"] = dict(release_result.get("run_summary") or {})
    result["test_summary"] = dict(release_result.get("test_summary") or {})
    result["review_queue_summary"] = dict(release_result.get("review_queue_summary") or {})
    result["recommended_actions"] = list(release_result.get("recommended_actions") or [])
    result["experiment_run"] = dict(release_result.get("experiment_run") or {})
    result["experiment_scenario"] = dict(release_result.get("experiment_scenario") or {})
    result["experiment_scorecard"] = dict(release_result.get("experiment_scorecard") or {})
    result["strategy_benchmark"] = dict(release_result.get("strategy_benchmark") or {})
    result["experiment_benchmark_summary"] = dict(release_result.get("experiment_benchmark_summary") or {})
    result["owner_experiment_summary"] = dict(release_result.get("owner_experiment_summary") or {})
    result["training_handoff"] = dict(release_result.get("training_handoff") or {})
    _record_agent_output(
        result,
        ticket_id=ticket_id,
        agent_name=releaser.name,
        stage="release",
        decision="packaged",
        summary="release agent wrote runtime artifacts and summary outputs",
        confidence=1.0,
        ok=bool(release_result.get("ok", False)),
        artifacts=[
            str(result.get("artifacts", {}).get("run_artifact") or ""),
            str(result.get("artifacts", {}).get("human_summary") or ""),
            str(result.get("artifacts", {}).get("experiment_artifact") or ""),
        ],
        decision_count=len(result.get("engine_decisions", []) or []),
    )
    runtime_context = _refresh_runtime_context(
        root,
        ticket_id=ticket_id,
        desc=desc,
        editor_context=normalized_editor_context,
        plan=plan,
        validation=result["validation"],
        repair=result["repair"],
        artifact_paths=[
            str(path)
            for path in [
                result.get("artifacts", {}).get("run_artifact"),
                result.get("artifacts", {}).get("human_summary"),
            ]
            if str(path or "")
        ],
        permission_state=permissions.describe_all(),
        memory_state=_memory_state_payload(failure_memory, validation_memory_hints),
        host_boundary=host_boundary,
        self_heal_policy=_self_heal_policy(result["validation"], _memory_state_payload(failure_memory, validation_memory_hints), runtime_context),
    )
    result["runtime_context"] = runtime_context

    if provider is not None:
        try:
            result["reasoning"]["summary"] = provider.summarize(
                f"Ticket: {ticket_id}\nAudit: {audit}\nPlan: {plan}\nExecution: {result['execution']}\nValidation ok: {result['validation'].get('ok', True)}\nRepair: {result['repair']}"
            )
        except Exception:
            result["reasoning"]["summary"] = ""

    result["execution"]["diff"] = diff_text(root, created)
    if result["review_state"].get("requires_manual_review"):
        decision_timeline.append(
            _timeline_event(
                "review",
                "pending-review",
                str(result["review_summary"].get("summary") or "manual review required"),
                pending_review_count=int(result["review_state"].get("pending_review_count") or 0),
                review_request_count=int(result["review_state"].get("total_count") or 0),
            )
        )
    result["ok"] = bool(audit.get("allowed")) and bool(result["validation"].get("ok", True)) and not bool(result["review_state"].get("requires_manual_review"))
    final_state = "succeeded"
    if not result["ok"]:
        final_state = "blocked" if (result["repair"].get("skipped") or result["review_state"].get("requires_manual_review")) else "failed"
    _transition_runtime(
        result,
        ticket_id=ticket_id,
        next_state=final_state,
        stage="runtime",
        summary=(
            "runtime completed successfully"
            if final_state == "succeeded"
            else (result["review_summary"].get("summary") or result["repair"].get("skip_reason") or "runtime completed with failures")
        ),
        ok=bool(result["ok"]),
    )
    result["runtime_failure"] = _derive_runtime_failure(result)
    task_objective_contract = _build_task_objective_contract(result, desc=desc)
    failure_class_contract = _build_failure_class_contract(result)
    recovery_ladder_contract = _build_recovery_ladder_contract(result)
    checkpoint_ref_contract = _build_checkpoint_ref_contract(result)
    interrupt_request_contract = _build_interrupt_request_contract(result)
    review_bundle_contract = _build_review_bundle_contract(result)
    workbench_artifacts_contract = _build_workbench_artifacts_contract(result)
    artifact_paths = [
        str(path)
        for path in [
            result.get("artifacts", {}).get("run_artifact"),
            result.get("artifacts", {}).get("human_summary"),
            result.get("artifacts", {}).get("experiment_artifact"),
            result.get("artifacts", {}).get("experiment_dataset"),
        ]
        if str(path or "")
    ]
    RuntimeOrchestrationDriver(result, ticket_id=ticket_id).finalize_runtime_result(
        ok=bool(result["ok"]),
        failure=result["runtime_failure"],
        artifact_paths=artifact_paths,
        metrics={
            **dict(result.get("engine_metrics") or {}),
            "decision_count": len(result.get("decision_timeline", []) or []),
            "runtime_event_count": len(result.get("runtime_events", []) or []),
        },
        metadata={
            "review_state": dict(result.get("review_state") or {}),
        },
    )
    result["runtime_result"]["task_objective"] = dict(task_objective_contract)
    result["runtime_result"]["failure_class"] = dict(failure_class_contract)
    result["runtime_result"]["recovery_ladder"] = dict(recovery_ladder_contract)
    result["runtime_result"]["checkpoint_ref"] = dict(checkpoint_ref_contract)
    result["runtime_result"]["interrupt_request"] = dict(interrupt_request_contract)
    result["runtime_result"]["review_bundle"] = dict(review_bundle_contract)
    result["runtime_result"]["workbench_artifacts"] = list(workbench_artifacts_contract)
    execution_summary = str(
        result.get("review_summary", {}).get("summary")
        or result.get("run_summary", {}).get("summary")
        or result.get("test_summary", {}).get("summary")
        or result.get("owner_summary", {}).get("summary")
        or result.get("runtime_failure", {}).get("message")
        or result.get("repair", {}).get("skip_reason")
        or ""
    )
    runtime_task_metadata = dict(result.get("runtime_task", {}).get("metadata") or {})
    result["runtime_result"]["review_state"] = dict(result.get("review_state") or {})
    result["runtime_result"]["review_requests"] = list(result.get("review_requests") or [])
    result["runtime_result"]["review_summary"] = dict(result.get("review_summary") or {})
    result["runtime_result"]["owner_summary"] = dict(result.get("owner_summary") or {})
    result["runtime_result"]["run_summary"] = dict(result.get("run_summary") or {})
    result["runtime_result"]["test_summary"] = dict(result.get("test_summary") or {})
    result["runtime_result"]["review_queue_summary"] = dict(result.get("review_queue_summary") or {})
    result["runtime_result"]["recommended_actions"] = list(result.get("recommended_actions") or [])
    result["runtime_result"]["experiment_run"] = dict(result.get("experiment_run") or {})
    result["runtime_result"]["experiment_scenario"] = dict(result.get("experiment_scenario") or {})
    result["runtime_result"]["experiment_scorecard"] = dict(result.get("experiment_scorecard") or {})
    result["runtime_result"]["strategy_benchmark"] = dict(result.get("strategy_benchmark") or {})
    result["runtime_result"]["experiment_benchmark_summary"] = dict(result.get("experiment_benchmark_summary") or {})
    result["runtime_result"]["owner_experiment_summary"] = dict(result.get("owner_experiment_summary") or {})
    result["runtime_result"]["training_handoff"] = dict(result.get("training_handoff") or {})
    result["runtime_result"]["memory_hints"] = dict(validation_memory_hints)
    result["runtime_result"]["summary"] = execution_summary
    result["operator_execution"] = build_operator_execution_result(
        task=str(desc or ticket_id or ""),
        task_mode=str(result.get("runtime_task", {}).get("task_mode") or ""),
        action=str(result.get("runtime_task", {}).get("action") or mode or "run"),
        lane_id=str(runtime_task_metadata.get("lane_id") or ""),
        lane_label=str(runtime_task_metadata.get("lane_label") or ""),
        ticket_id=ticket_id,
        model_profile_id=str(
            result.get("runtime_task", {}).get("model_profile_id")
            or runtime_task_metadata.get("modelProfileId")
            or runtime_task_metadata.get("model_profile_id")
            or ""
        ),
        model_role=str(runtime_task_metadata.get("modelRole") or runtime_task_metadata.get("model_role") or ""),
        model_display_name=str(runtime_task_metadata.get("modelDisplayName") or runtime_task_metadata.get("model_display_name") or ""),
        base_model=str(runtime_task_metadata.get("baseModel") or runtime_task_metadata.get("base_model") or ""),
        provider_source=str(runtime_task_metadata.get("providerSource") or runtime_task_metadata.get("provider_source") or ""),
        run_id=str(result.get("runtime_run", {}).get("run_id") or ""),
        status=str(result.get("runtime_result", {}).get("status") or ""),
        run_state=str(result.get("runtime_result", {}).get("final_state") or ""),
        current_stage=str(result.get("runtime_run", {}).get("current_stage") or "runtime"),
        result_summary=execution_summary,
        changed_files=list(result.get("runtime_context", {}).get("changed_files") or []),
        review_summary=dict(result.get("review_summary") or {}),
        trust_summary=dict((result.get("run_summary", {}).get("metadata") or {}).get("trust_summary") or {}),
        run_summary=dict(result.get("run_summary") or {}),
        test_summary=dict(result.get("test_summary") or {}),
        benchmark_metadata={
            "experiment_benchmark_summary": dict(result.get("experiment_benchmark_summary") or {}),
            "owner_experiment_summary": dict(result.get("owner_experiment_summary") or {}),
        },
        learning_metadata={
            "training_handoff": dict(result.get("training_handoff") or {}),
            "memory_hints": dict(validation_memory_hints),
        },
        artifact_paths=artifact_paths,
        retry_available=bool(result.get("runtime_failure", {}).get("retryable")),
        repair_available=bool(ticket_id),
        task_objective=task_objective_contract,
        failure_class=failure_class_contract,
        recovery_ladder=recovery_ladder_contract,
        checkpoint_ref=checkpoint_ref_contract,
        interrupt_request=interrupt_request_contract,
        review_bundle=review_bundle_contract,
        workbench_artifacts=workbench_artifacts_contract,
    )
    result["runtime_result"]["operator_execution"] = dict(result.get("operator_execution") or {})
    validation_payload = dict(result.get("validation") or {})
    failure_memory_payload = summarize_failure_patterns(
        root,
        ticket=ticket_id,
        strategy=str(audit.get("strategy") or ""),
        fingerprint_labels=[str(item.get("label") or "") for item in list(validation_payload.get("fingerprints", []) or []) if str(item.get("label") or "")],
    )
    runtime_memory_hints = summarize_runtime_memory_hints(
        root,
        ticket=ticket_id,
        strategy=str(audit.get("strategy") or ""),
        fingerprint_labels=[str(item.get("label") or "") for item in list(validation_payload.get("fingerprints", []) or []) if str(item.get("label") or "")],
        target_path=str(normalized_editor_context.get("active_file_path") or ""),
        active_file_path=str(normalized_editor_context.get("active_file_path") or ""),
    )
    record_memory(
        root,
        ticket_id,
        str(audit.get("strategy") or ""),
        list(result.get("execution", {}).get("created", []) or []),
        bool(result.get("ok", False)),
        metadata={
            "run_id": str(result.get("runtime_run", {}).get("run_id") or ""),
            "task_id": str(result.get("runtime_task", {}).get("task_id") or ""),
            "action": str(result.get("runtime_task", {}).get("action") or "run"),
            "mode": str(result.get("runtime_task", {}).get("mode") or result.get("mode") or "integrate"),
            "selected_patch_labels": _selected_patch_labels(result),
            "validation_fingerprints": [
                str(item.get("label") or "")
                for item in list(validation_payload.get("fingerprints", []) or [])
                if str(item.get("label") or "")
            ],
            "retry_action": str((validation_payload.get("retry_policy") or result.get("repair", {}).get("retry_policy") or {}).get("action") or ""),
            "repair_skipped": bool(result.get("repair", {}).get("skipped", False)),
            "cooldown_until": str(failure_memory_payload.get("cooldown_until") or ""),
            "decision_types": [
                str(item.get("type") or item.get("event") or "")
                for item in list(result.get("decision_timeline", []) or [])
                if str(item.get("type") or item.get("event") or "")
            ],
            "write_gate": dict(result.get("write_gate") or {}),
            "active_file_path": str(normalized_editor_context.get("active_file_path") or ""),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "runtime_status": str(result.get("runtime_result", {}).get("status") or ""),
            "final_state": str(result.get("runtime_result", {}).get("final_state") or ""),
            "repair_paths": [
                str(item.get("path") or "")
                for item in list(result.get("repair", {}).get("repairs", []) or [])
                if isinstance(item, dict) and str(item.get("path") or "")
            ],
            "repair_ok": result.get("repair", {}).get("ok"),
            "skip_reason": str(result.get("repair", {}).get("skip_reason") or ""),
            "noisy_failure_labels": list(failure_memory_payload.get("noisy_failure_labels", []) or []),
            "recurring_blockers": list(failure_memory_payload.get("recurring_blockers", []) or []),
            "recommended_response": str(failure_memory_payload.get("recommended_response") or "ticket_repair"),
            "review_verdict": str(review_bundle_contract.get("verdict") or ""),
            "review_reason": str(review_bundle_contract.get("reason") or ""),
            "how_to_fix": str(review_bundle_contract.get("how_to_fix") or ""),
            "change_summary": str(review_bundle_contract.get("change_summary") or ""),
            "recommended_prompt": str(runtime_memory_hints.get("recommended_prompt") or review_bundle_contract.get("how_to_fix") or ""),
            "next_action_command": str(runtime_memory_hints.get("recommended_response") or ""),
            "failing_commands": [
                str(item.get("command") or "")
                for item in list(validation_payload.get("results", []) or [])
                if isinstance(item, dict) and not item.get("ok", False) and str(item.get("command") or "")
            ],
            "blocking_fingerprint_count": int((validation_payload.get("engine_metrics") or {}).get("blocking_fingerprint_count") or 0),
        },
    )
    return result
