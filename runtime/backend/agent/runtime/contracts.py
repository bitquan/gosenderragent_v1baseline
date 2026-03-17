from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


RUNTIME_CONTRACT_SCHEMA_VERSION = "2026-03-13"
TERMINAL_RUNTIME_STATES = {"succeeded", "failed", "blocked"}
REVIEW_LIFECYCLE_STATES = {"pending_review", "approved", "rejected", "deferred", "auto_approved"}
DEV_ENGINE_LOOP_STEPS = [
    "goal",
    "observe",
    "research",
    "propose",
    "apply",
    "validate",
    "review",
    "learn",
    "continue-stop",
]
RECOVERY_LADDER_STEPS = [
    "local-targeted-coding",
    "research-expansion",
    "stronger-coding-route",
    "repair-oriented-route",
    "bridge-plan-retry",
    "sandbox-retry",
    "interrupt-or-rollback",
]
_RUNTIME_STATE_TRANSITIONS: dict[str, set[str]] = {
    "created": {"planning", "blocked", "failed"},
    "planning": {"implementing", "executing", "validating", "repairing", "releasing", "blocked", "failed"},
    "implementing": {"validating", "repairing", "releasing", "blocked", "failed"},
    "executing": {"validating", "repairing", "releasing", "blocked", "failed"},
    "validating": {"repairing", "releasing", "blocked", "failed"},
    "repairing": {"validating", "releasing", "blocked", "failed"},
    "releasing": {"succeeded", "failed", "blocked"},
    "succeeded": set(),
    "failed": set(),
    "blocked": set(),
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _runtime_status(state: str) -> str:
    if state == "blocked":
        return "blocked"
    if state in TERMINAL_RUNTIME_STATES:
        return "completed"
    return "running"


def _task_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


def _normalize_string_list(values: list[Any] | tuple[Any, ...] | None = None) -> list[str]:
    return [str(item) for item in list(values or []) if str(item)]


def _normalize_dict_list(values: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    return [dict(item) for item in list(values or []) if isinstance(item, dict)]


def _normalize_review_state(state: Any, *, default: str = "pending_review") -> str:
    normalized = str(state or "").strip().lower()
    if normalized == "pending":
        normalized = "pending_review"
    if not normalized:
        normalized = default
    if normalized not in REVIEW_LIFECYCLE_STATES:
        raise ValueError(f"invalid review state: {state}")
    return normalized


def _normalize_confidence_value(confidence: Any) -> float | None:
    if confidence is None:
        return None
    if isinstance(confidence, (int, float)):
        return float(confidence)
    label = str(confidence or "").strip().lower()
    if not label:
        return None
    if label == "low":
        return 0.35
    if label == "medium":
        return 0.65
    if label == "high":
        return 0.9
    try:
        return float(label)
    except ValueError:
        return None


def build_runtime_task(
    *,
    ticket_id: str,
    desc: str,
    action: str,
    mode: str,
    run_mode: str,
    editor_context: dict[str, Any] | None = None,
    host_boundary: dict[str, Any] | None = None,
    requested_capabilities: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    stamp = _task_timestamp()
    normalized_action = str(action or "run").strip().lower() or "run"
    metadata_payload = dict(metadata or {})
    task_mode = str(
        metadata_payload.get("task_mode")
        or metadata_payload.get("taskMode")
        or metadata_payload.get("task_mode_id")
        or metadata_payload.get("taskModeId")
        or ""
    ).strip().lower()
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "task_id": f"task-{ticket_id or 'unknown'}-{normalized_action}-{stamp}",
        "ticket": str(ticket_id or ""),
        "desc": str(desc or ""),
        "action": normalized_action,
        "mode": str(mode or "integrate"),
        "run_mode": str(run_mode or "manual"),
        "task_mode": task_mode,
        "requested_at": _utc_now(),
        "editor_context": dict(editor_context or {}),
        "host_boundary": dict(host_boundary or {}),
        "requested_capabilities": dict(requested_capabilities or {}),
        "metadata": dict(metadata or {}),
    }


def build_runtime_run(
    *,
    task: dict[str, Any],
    host_boundary: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    timestamp = _utc_now()
    initial_state = "created"
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "run_id": f"run-{task.get('ticket') or 'unknown'}-{_task_timestamp()}",
        "task_id": str(task.get("task_id") or ""),
        "ticket": str(task.get("ticket") or ""),
        "action": str(task.get("action") or "run"),
        "mode": str(task.get("mode") or "integrate"),
        "run_mode": str(task.get("run_mode") or "manual"),
        "status": _runtime_status(initial_state),
        "state": initial_state,
        "task_mode": str(task.get("task_mode") or task.get("taskMode") or ""),
        "current_stage": "runtime",
        "started_at": timestamp,
        "updated_at": timestamp,
        "finished_at": None,
        "host_boundary": dict(host_boundary or task.get("host_boundary") or {}),
        "metadata": dict(metadata or {}),
        "state_history": [
            {
                "state": initial_state,
                "stage": "runtime",
                "summary": "runtime run created",
                "entered_at": timestamp,
                "data": {},
            }
        ],
        "stage_history": [
            {
                "stage": "runtime",
                "state": initial_state,
                "summary": "runtime run created",
                "entered_at": timestamp,
                "data": {},
            }
        ],
        "agent_outputs": [],
    }


def transition_runtime_run(
    runtime_run: dict[str, Any],
    next_state: str,
    *,
    stage: str,
    summary: str,
    timestamp: str | None = None,
    data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = dict(runtime_run or {})
    current_state = str(payload.get("state") or "created")
    normalized_next_state = str(next_state or current_state).strip().lower() or current_state
    allowed = _RUNTIME_STATE_TRANSITIONS.get(current_state, set())
    if normalized_next_state != current_state and normalized_next_state not in allowed:
        raise ValueError(f"invalid runtime transition: {current_state} -> {normalized_next_state}")
    moment = str(timestamp or _utc_now())
    payload["state"] = normalized_next_state
    payload["status"] = _runtime_status(normalized_next_state)
    payload["current_stage"] = str(stage or payload.get("current_stage") or "runtime")
    payload["updated_at"] = moment
    if normalized_next_state in TERMINAL_RUNTIME_STATES:
        payload["finished_at"] = moment
    history = list(payload.get("state_history", []) or [])
    history.append(
        {
            "state": normalized_next_state,
            "stage": str(stage or "runtime"),
            "summary": str(summary or ""),
            "entered_at": moment,
            "data": dict(data or {}),
        }
    )
    payload["state_history"] = history
    stage_history = list(payload.get("stage_history", []) or [])
    stage_history.append(
        {
            "stage": str(stage or payload.get("current_stage") or "runtime"),
            "state": normalized_next_state,
            "summary": str(summary or ""),
            "entered_at": moment,
            "data": dict(data or {}),
        }
    )
    payload["stage_history"] = stage_history
    return payload


def build_agent_output(
    *,
    run_id: str,
    task_id: str,
    ticket_id: str,
    agent_name: str,
    stage: str,
    decision: str,
    summary: str,
    confidence: float | int | None = None,
    ok: bool | None = None,
    artifacts: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
    created_at: str | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "ticket": str(ticket_id or ""),
        "agent": str(agent_name or ""),
        "stage": str(stage or "runtime"),
        "agent_decision": str(decision or ""),
        "agent_summary": str(summary or ""),
        "agent_confidence": _normalize_confidence_value(confidence),
        "agent_artifacts": [str(item) for item in list(artifacts or []) if str(item)],
        "ok": None if ok is None else bool(ok),
        "created_at": str(created_at or _utc_now()),
        "metadata": dict(metadata or {}),
    }


def append_agent_output(runtime_run: dict[str, Any], agent_output: dict[str, Any]) -> dict[str, Any]:
    payload = dict(runtime_run or {})
    outputs = list(payload.get("agent_outputs", []) or [])
    outputs.append(dict(agent_output or {}))
    payload["agent_outputs"] = outputs
    return payload


def build_runtime_event(
    *,
    run_id: str,
    task_id: str,
    ticket_id: str,
    stage: str,
    event: str,
    summary: str,
    state: str,
    level: str = "info",
    data: dict[str, Any] | None = None,
    timestamp: str | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "timestamp": str(timestamp or _utc_now()),
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "ticket": str(ticket_id or ""),
        "stage": str(stage or "runtime"),
        "event": str(event or "state-transition"),
        "state": str(state or "created"),
        "level": str(level or "info"),
        "summary": str(summary or ""),
        "data": dict(data or {}),
    }


def build_runtime_failure(
    *,
    ticket_id: str,
    run_id: str,
    task_id: str,
    stage: str,
    kind: str,
    message: str,
    retryable: bool,
    blocking: bool,
    retry_policy: dict[str, Any] | None = None,
    fingerprints: list[dict[str, Any]] | None = None,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "ticket": str(ticket_id or ""),
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "stage": str(stage or "runtime"),
        "kind": str(kind or "runtime-failure"),
        "message": str(message or "runtime failure"),
        "retryable": bool(retryable),
        "blocking": bool(blocking),
        "retry_policy": dict(retry_policy or {}),
        "fingerprints": [dict(item) for item in list(fingerprints or []) if isinstance(item, dict)],
        "details": dict(details or {}),
    }


def build_runtime_artifact(
    *,
    run_id: str,
    task_id: str,
    ticket_id: str,
    kind: str,
    path: str,
    format: str,
    producer: str,
    summary: str = "",
    metadata: dict[str, Any] | None = None,
    created_at: str | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "ticket": str(ticket_id or ""),
        "kind": str(kind or "artifact"),
        "path": str(path or ""),
        "format": str(format or "json"),
        "producer": str(producer or "runtime"),
        "created_at": str(created_at or _utc_now()),
        "summary": str(summary or ""),
        "metadata": dict(metadata or {}),
    }


def build_task_objective(
    *,
    summary: str,
    kind: str = "",
    source: str = "",
    task_mode: str = "",
    action: str = "",
    lane_id: str = "",
    lane_label: str = "",
    loop_steps: list[str] | tuple[str, ...] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "summary": str(summary or ""),
        "kind": str(kind or ""),
        "source": str(source or ""),
        "task_mode": str(task_mode or ""),
        "action": str(action or ""),
        "lane_id": str(lane_id or ""),
        "lane_label": str(lane_label or ""),
        "loop_steps": _normalize_string_list(loop_steps or DEV_ENGINE_LOOP_STEPS),
        "metadata": dict(metadata or {}),
    }


def build_failure_class(
    *,
    code: str,
    summary: str,
    stage: str = "",
    retryable: bool = False,
    blocking: bool = False,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "code": str(code or ""),
        "summary": str(summary or ""),
        "stage": str(stage or ""),
        "retryable": bool(retryable),
        "blocking": bool(blocking),
        "metadata": dict(metadata or {}),
    }


def build_recovery_ladder_state(
    *,
    state: str,
    current_step: str = "",
    next_step: str = "",
    available_steps: list[str] | tuple[str, ...] | None = None,
    history: list[dict[str, Any]] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "state": str(state or ""),
        "current_step": str(current_step or ""),
        "next_step": str(next_step or ""),
        "available_steps": _normalize_string_list(available_steps or RECOVERY_LADDER_STEPS),
        "history": _normalize_dict_list(history),
        "metadata": dict(metadata or {}),
    }


def build_checkpoint_ref(
    *,
    ref_id: str,
    label: str = "",
    kind: str = "",
    path: str = "",
    summary: str = "",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "ref_id": str(ref_id or ""),
        "label": str(label or ""),
        "kind": str(kind or ""),
        "path": str(path or ""),
        "summary": str(summary or ""),
        "metadata": dict(metadata or {}),
    }


def build_interrupt_request(
    *,
    kind: str,
    summary: str,
    active: bool,
    requested_action: str = "",
    allowed_actions: list[str] | tuple[str, ...] | None = None,
    request_count: int = 0,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "kind": str(kind or ""),
        "summary": str(summary or ""),
        "active": bool(active),
        "requested_action": str(requested_action or ""),
        "allowed_actions": _normalize_string_list(allowed_actions),
        "request_count": int(request_count or 0),
        "metadata": dict(metadata or {}),
    }


def build_review_bundle(
    *,
    verdict: str,
    summary: str,
    requires_manual_review: bool = False,
    request_count: int = 0,
    pending_count: int = 0,
    decision_label: str = "",
    reason: str = "",
    how_to_fix: str = "",
    change_summary: str = "",
    approval_state: str = "",
    approved: bool | None = None,
    fix_actions: list[str] | None = None,
    trust_summary: dict[str, Any] | None = None,
    review_requests: list[dict[str, Any]] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    normalized_verdict = str(verdict or "")
    derived_approved = bool(approved) if approved is not None else normalized_verdict in {"approved", "approved-with-warnings"}
    derived_decision_label = str(
        decision_label
        or {
            "approved": "Approved",
            "approved-with-warnings": "Approved with warnings",
            "pending-review": "Review required",
            "repair-required": "Repair required",
            "blocked": "Blocked",
        }.get(normalized_verdict, "Observed")
    )
    derived_approval_state = str(approval_state or normalized_verdict or ("approved" if derived_approved else "observed"))
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "verdict": normalized_verdict,
        "decision_label": derived_decision_label,
        "summary": str(summary or ""),
        "reason": str(reason or ""),
        "how_to_fix": str(how_to_fix or ""),
        "change_summary": str(change_summary or ""),
        "approval_state": derived_approval_state,
        "approved": derived_approved,
        "requires_manual_review": bool(requires_manual_review),
        "request_count": int(request_count or 0),
        "pending_count": int(pending_count or 0),
        "fix_actions": _normalize_string_list(fix_actions),
        "trust_summary": dict(trust_summary or {}),
        "review_requests": _normalize_dict_list(review_requests),
        "metadata": dict(metadata or {}),
    }


def build_workbench_artifact(
    *,
    kind: str,
    label: str,
    path: str = "",
    summary: str = "",
    status: str = "",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "kind": str(kind or ""),
        "label": str(label or ""),
        "path": str(path or ""),
        "summary": str(summary or ""),
        "status": str(status or ""),
        "metadata": dict(metadata or {}),
    }


def build_operator_execution_result(
    *,
    task: str,
    task_mode: str,
    action: str,
    ticket_id: str,
    run_id: str,
    status: str,
    run_state: str,
    current_stage: str,
    result_summary: str,
    changed_files: list[dict[str, Any]] | None = None,
    diff_summary: str = "",
    output_tail: dict[str, Any] | None = None,
    review_summary: dict[str, Any] | None = None,
    trust_summary: dict[str, Any] | None = None,
    run_summary: dict[str, Any] | None = None,
    test_summary: dict[str, Any] | None = None,
    benchmark_metadata: dict[str, Any] | None = None,
    learning_metadata: dict[str, Any] | None = None,
    artifact_paths: list[str] | None = None,
    lane_id: str = "",
    lane_label: str = "",
    model_profile_id: str = "",
    model_role: str = "",
    model_display_name: str = "",
    base_model: str = "",
    provider_source: str = "",
    retry_available: bool = False,
    repair_available: bool = False,
    task_objective: dict[str, Any] | None = None,
    failure_class: dict[str, Any] | None = None,
    recovery_ladder: dict[str, Any] | None = None,
    checkpoint_ref: dict[str, Any] | None = None,
    interrupt_request: dict[str, Any] | None = None,
    review_bundle: dict[str, Any] | None = None,
    workbench_artifacts: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    normalized_changed_files = [
        {
            "path": str(item.get("path") or ""),
            "status": str(item.get("status") or ""),
        }
        for item in list(changed_files or [])
        if isinstance(item, dict) and str(item.get("path") or "")
    ]
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "task": str(task or ""),
        "task_mode": str(task_mode or ""),
        "action": str(action or ""),
        "lane_id": str(lane_id or ""),
        "lane_label": str(lane_label or ""),
        "ticket": str(ticket_id or ""),
        "model_profile_id": str(model_profile_id or ""),
        "model_role": str(model_role or ""),
        "model_display_name": str(model_display_name or ""),
        "base_model": str(base_model or ""),
        "provider_source": str(provider_source or ""),
        "run_id": str(run_id or ""),
        "status": str(status or ""),
        "run_state": str(run_state or ""),
        "stage_summary": {
            "current_stage": str(current_stage or "runtime"),
            "summary": str(result_summary or ""),
            "final_state": str(run_state or ""),
        },
        "result_summary": str(result_summary or ""),
        "diff_summary": str(diff_summary or ""),
        "changed_files": normalized_changed_files,
        "changed_file_count": len(normalized_changed_files),
        "output_tail": {
            "combined": str((output_tail or {}).get("combined") or ""),
            "stdout": str((output_tail or {}).get("stdout") or ""),
            "stderr": str((output_tail or {}).get("stderr") or ""),
        },
        "review_summary": dict(review_summary or {}),
        "trust_summary": dict(trust_summary or {}),
        "run_summary": dict(run_summary or {}),
        "test_summary": dict(test_summary or {}),
        "benchmark_metadata": dict(benchmark_metadata or {}),
        "learning_metadata": dict(learning_metadata or {}),
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "retry_available": bool(retry_available),
        "repair_available": bool(repair_available),
        "task_objective": dict(task_objective or {}),
        "failure_class": dict(failure_class or {}),
        "recovery_ladder": dict(recovery_ladder or {}),
        "checkpoint_ref": dict(checkpoint_ref or {}),
        "interrupt_request": dict(interrupt_request or {}),
        "review_bundle": dict(review_bundle or {}),
        "workbench_artifacts": _normalize_dict_list(workbench_artifacts),
    }


def build_review_context(
    *,
    run_id: str,
    task_id: str,
    ticket_id: str,
    stage: str,
    review_type: str,
    summary: str,
    risk_level: str = "",
    action: str = "",
    target_paths: list[str] | None = None,
    evidence: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "ticket": str(ticket_id or ""),
        "stage": str(stage or "runtime"),
        "review_type": str(review_type or "review"),
        "summary": str(summary or ""),
        "risk_level": str(risk_level or ""),
        "action": str(action or ""),
        "target_paths": [str(path) for path in list(target_paths or []) if str(path)],
        "evidence": dict(evidence or {}),
        "metadata": dict(metadata or {}),
    }


def build_review_request(
    *,
    review_id: str,
    run_id: str,
    task_id: str,
    ticket_id: str,
    title: str,
    request_type: str,
    summary: str,
    requested_by: str,
    state: str = "pending_review",
    reason: str = "",
    tool_name: str = "",
    safety_level: str = "",
    approval_request_id: str = "",
    context: dict[str, Any] | None = None,
    artifact_refs: list[dict[str, Any]] | None = None,
    metadata: dict[str, Any] | None = None,
    requested_at: str | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "review_id": str(review_id or ""),
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "ticket": str(ticket_id or ""),
        "title": str(title or "review request"),
        "request_type": str(request_type or "approval"),
        "state": _normalize_review_state(state),
        "summary": str(summary or ""),
        "reason": str(reason or ""),
        "requested_by": str(requested_by or ""),
        "tool": str(tool_name or ""),
        "safety_level": str(safety_level or ""),
        "approval_request_id": str(approval_request_id or review_id or ""),
        "requested_at": str(requested_at or _utc_now()),
        "context": dict(context or {}),
        "artifact_refs": [dict(item) for item in list(artifact_refs or []) if isinstance(item, dict)],
        "metadata": dict(metadata or {}),
    }


def build_review_decision(
    *,
    review_request: dict[str, Any],
    decision: str,
    decided_by: str = "host",
    note: str = "",
    metadata: dict[str, Any] | None = None,
    decided_at: str | None = None,
) -> dict[str, Any]:
    normalized = _normalize_review_state(decision)
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "review_id": str(review_request.get("review_id") or review_request.get("approval_request_id") or ""),
        "run_id": str(review_request.get("run_id") or ""),
        "task_id": str(review_request.get("task_id") or ""),
        "ticket": str(review_request.get("ticket") or ""),
        "decision": normalized,
        "state": normalized,
        "decided_by": str(decided_by or "host"),
        "note": str(note or ""),
        "decided_at": str(decided_at or _utc_now()),
        "metadata": dict(metadata or {}),
    }


def build_review_artifact(
    *,
    run_id: str,
    task_id: str,
    ticket_id: str,
    review_id: str,
    kind: str,
    summary: str,
    label: str = "",
    path: str = "",
    format: str = "json",
    metadata: dict[str, Any] | None = None,
    created_at: str | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "ticket": str(ticket_id or ""),
        "review_id": str(review_id or ""),
        "kind": str(kind or "review-artifact"),
        "label": str(label or ""),
        "path": str(path or ""),
        "format": str(format or "json"),
        "summary": str(summary or ""),
        "created_at": str(created_at or _utc_now()),
        "metadata": dict(metadata or {}),
    }


def summarize_review_state(review_requests: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    requests = [dict(item) for item in list(review_requests or []) if isinstance(item, dict)]
    counts = {state: 0 for state in REVIEW_LIFECYCLE_STATES}
    for item in requests:
        counts[_normalize_review_state(item.get("state") or item.get("status") or "pending_review")] += 1
    return {
        "pending_review_count": counts["pending_review"],
        "approved_count": counts["approved"],
        "rejected_count": counts["rejected"],
        "deferred_count": counts["deferred"],
        "auto_approved_count": counts["auto_approved"],
        "total_count": len(requests),
        "requires_manual_review": counts["pending_review"] > 0,
        "requests": requests,
    }


def build_run_summary(
    *,
    ticket_id: str,
    run_id: str,
    task_id: str,
    action: str,
    mode: str,
    status: str,
    final_state: str,
    strategy: str = "",
    started_at: str = "",
    finished_at: str = "",
    branch: str = "",
    created_file_count: int = 0,
    execution_result_count: int = 0,
    repair_count: int = 0,
    artifact_paths: list[str] | None = None,
    summary: str = "",
    reason: str = "",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "ticket": str(ticket_id or ""),
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "action": str(action or "run"),
        "mode": str(mode or "integrate"),
        "status": str(status or "unknown"),
        "final_state": str(final_state or status or "unknown"),
        "strategy": str(strategy or ""),
        "started_at": str(started_at or ""),
        "finished_at": str(finished_at or ""),
        "branch": str(branch or ""),
        "created_file_count": int(created_file_count or 0),
        "execution_result_count": int(execution_result_count or 0),
        "repair_count": int(repair_count or 0),
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "summary": str(summary or ""),
        "reason": str(reason or ""),
        "metadata": dict(metadata or {}),
    }


def build_test_summary(
    *,
    ticket_id: str,
    run_id: str,
    task_id: str,
    command_count: int,
    passed_count: int,
    failed_count: int,
    fingerprint_count: int,
    blocking_fingerprint_count: int,
    retry_action: str = "",
    retry_reason: str = "",
    status: str = "passed",
    summary: str = "",
    commands: list[str] | None = None,
    fingerprints: list[dict[str, Any]] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "ticket": str(ticket_id or ""),
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "status": str(status or "passed"),
        "command_count": int(command_count or 0),
        "passed_count": int(passed_count or 0),
        "failed_count": int(failed_count or 0),
        "fingerprint_count": int(fingerprint_count or 0),
        "blocking_fingerprint_count": int(blocking_fingerprint_count or 0),
        "retry_action": str(retry_action or ""),
        "retry_reason": str(retry_reason or ""),
        "summary": str(summary or ""),
        "commands": [str(command) for command in list(commands or []) if str(command)],
        "fingerprints": [dict(item) for item in list(fingerprints or []) if isinstance(item, dict)],
        "metadata": dict(metadata or {}),
    }


def build_review_queue_summary(
    *,
    ticket_id: str,
    run_id: str,
    task_id: str,
    review_state: dict[str, Any] | None = None,
    review_requests: list[dict[str, Any]] | None = None,
    summary: str = "",
    artifact_refs: list[dict[str, Any]] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    state = dict(review_state or summarize_review_state(review_requests))
    requests = [dict(item) for item in list(review_requests or state.get("requests") or []) if isinstance(item, dict)]
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "ticket": str(ticket_id or ""),
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "pending_review_count": int(state.get("pending_review_count") or 0),
        "approved_count": int(state.get("approved_count") or 0),
        "rejected_count": int(state.get("rejected_count") or 0),
        "deferred_count": int(state.get("deferred_count") or 0),
        "auto_approved_count": int(state.get("auto_approved_count") or 0),
        "total_count": int(state.get("total_count") or len(requests)),
        "requires_manual_review": bool(state.get("requires_manual_review", False)),
        "summary": str(summary or ""),
        "requests": requests,
        "artifact_refs": [dict(item) for item in list(artifact_refs or []) if isinstance(item, dict)],
        "metadata": dict(metadata or {}),
    }


def build_recommended_action(
    *,
    action_id: str,
    action_type: str,
    title: str,
    reason: str,
    priority: str = "medium",
    status: str = "recommended",
    artifact_paths: list[str] | None = None,
    target_paths: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "action_id": str(action_id or ""),
        "action_type": str(action_type or "next-step"),
        "title": str(title or "Recommended action"),
        "reason": str(reason or ""),
        "priority": str(priority or "medium"),
        "status": str(status or "recommended"),
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "target_paths": [str(path) for path in list(target_paths or []) if str(path)],
        "metadata": dict(metadata or {}),
    }


def build_owner_summary(
    *,
    ticket_id: str,
    run_id: str,
    task_id: str,
    status: str,
    summary: str,
    run_summary: dict[str, Any],
    test_summary: dict[str, Any],
    review_queue_summary: dict[str, Any],
    recommended_actions: list[dict[str, Any]] | None = None,
    artifact_paths: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "ticket": str(ticket_id or ""),
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "status": str(status or "unknown"),
        "summary": str(summary or ""),
        "run_summary": dict(run_summary or {}),
        "test_summary": dict(test_summary or {}),
        "review_queue_summary": dict(review_queue_summary or {}),
        "recommended_actions": [dict(item) for item in list(recommended_actions or []) if isinstance(item, dict)],
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "metadata": dict(metadata or {}),
    }


def build_experiment_scenario(
    *,
    scenario_id: str,
    ticket_id: str,
    run_id: str,
    task_id: str,
    action: str,
    mode: str,
    strategy: str,
    objective: str = "",
    host_kind: str = "",
    status: str = "candidate",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "scenario_id": str(scenario_id or ""),
        "ticket": str(ticket_id or ""),
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "action": str(action or "run"),
        "mode": str(mode or "integrate"),
        "strategy": str(strategy or ""),
        "objective": str(objective or ""),
        "host_kind": str(host_kind or ""),
        "status": str(status or "candidate"),
        "metadata": dict(metadata or {}),
    }


def build_experiment_scorecard(
    *,
    ticket_id: str,
    run_id: str,
    task_id: str,
    scenario_id: str,
    strategy: str,
    status: str,
    success: bool,
    final_score: int,
    validation_passed_count: int,
    validation_failed_count: int,
    fingerprint_count: int,
    blocking_fingerprint_count: int,
    repair_count: int,
    review_required: bool,
    write_confirmation_required: bool,
    low_confidence_patch_count: int,
    created_file_count: int,
    execution_result_count: int,
    decision_count: int,
    grade: str = "C",
    summary: str = "",
    reasons: list[str] | None = None,
    artifact_paths: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "ticket": str(ticket_id or ""),
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "scenario_id": str(scenario_id or ""),
        "strategy": str(strategy or ""),
        "status": str(status or "unknown"),
        "success": bool(success),
        "final_score": int(final_score or 0),
        "grade": str(grade or "C"),
        "validation_passed_count": int(validation_passed_count or 0),
        "validation_failed_count": int(validation_failed_count or 0),
        "fingerprint_count": int(fingerprint_count or 0),
        "blocking_fingerprint_count": int(blocking_fingerprint_count or 0),
        "repair_count": int(repair_count or 0),
        "review_required": bool(review_required),
        "write_confirmation_required": bool(write_confirmation_required),
        "low_confidence_patch_count": int(low_confidence_patch_count or 0),
        "created_file_count": int(created_file_count or 0),
        "execution_result_count": int(execution_result_count or 0),
        "decision_count": int(decision_count or 0),
        "summary": str(summary or ""),
        "reasons": [str(item) for item in list(reasons or []) if str(item)],
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "metadata": dict(metadata or {}),
    }


def build_strategy_benchmark(
    *,
    ticket_id: str,
    run_id: str,
    task_id: str,
    strategy: str,
    success_count: int,
    failure_count: int,
    success_rate: float,
    repeat_count: int = 0,
    preferred_labels: list[str] | None = None,
    preferred_files: list[str] | None = None,
    recurring_blockers: list[dict[str, Any]] | None = None,
    recommended_response: str = "",
    confidence_boost: bool = False,
    benchmark_score: float | int | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    score = benchmark_score
    if score is None:
        score = max(
            0.0,
            min(
                100.0,
                (float(success_rate or 0.0) * 100.0)
                - (float(repeat_count or 0) * 5.0)
                - (float(len(list(recurring_blockers or []))) * 4.0)
                + (5.0 if confidence_boost else 0.0),
            ),
        )
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "ticket": str(ticket_id or ""),
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "strategy": str(strategy or ""),
        "success_count": int(success_count or 0),
        "failure_count": int(failure_count or 0),
        "success_rate": float(success_rate or 0.0),
        "repeat_count": int(repeat_count or 0),
        "preferred_labels": [str(item) for item in list(preferred_labels or []) if str(item)],
        "preferred_files": [str(item) for item in list(preferred_files or []) if str(item)],
        "recurring_blockers": [dict(item) for item in list(recurring_blockers or []) if isinstance(item, dict)],
        "recommended_response": str(recommended_response or ""),
        "confidence_boost": bool(confidence_boost),
        "benchmark_score": float(score or 0.0),
        "metadata": dict(metadata or {}),
    }


def build_experiment_run(
    *,
    experiment_id: str,
    ticket_id: str,
    run_id: str,
    task_id: str,
    strategy: str,
    status: str,
    scenario: dict[str, Any],
    scorecard: dict[str, Any],
    strategy_benchmark: dict[str, Any],
    dataset_path: str = "",
    artifact_paths: list[str] | None = None,
    training_signals: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "experiment_id": str(experiment_id or ""),
        "ticket": str(ticket_id or ""),
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "strategy": str(strategy or ""),
        "status": str(status or "unknown"),
        "scenario": dict(scenario or {}),
        "scorecard": dict(scorecard or {}),
        "strategy_benchmark": dict(strategy_benchmark or {}),
        "dataset_path": str(dataset_path or ""),
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "training_signals": dict(training_signals or {}),
        "metadata": dict(metadata or {}),
    }


def build_experiment_benchmark_summary(
    *,
    dataset_path: str,
    total_runs: int,
    strategy_count: int,
    success_count: int,
    failure_count: int,
    blocked_count: int,
    review_required_count: int,
    low_confidence_run_count: int,
    average_repair_count: float,
    validation_passed_count: int,
    validation_failed_count: int,
    success_rate: float,
    failure_rate: float,
    blocked_rate: float,
    review_required_rate: float,
    low_confidence_patch_rate: float,
    validation_pass_rate: float,
    validation_fail_rate: float,
    strategy_summaries: list[dict[str, Any]] | None = None,
    repeated_blockers: list[dict[str, Any]] | None = None,
    retry_actions: list[dict[str, Any]] | None = None,
    best_strategy: dict[str, Any] | None = None,
    weakest_strategy: dict[str, Any] | None = None,
    recommended_next_strategy: str = "",
    recommended_next_action: str = "",
    artifact_paths: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "dataset_path": str(dataset_path or ""),
        "total_runs": int(total_runs or 0),
        "strategy_count": int(strategy_count or 0),
        "success_count": int(success_count or 0),
        "failure_count": int(failure_count or 0),
        "blocked_count": int(blocked_count or 0),
        "review_required_count": int(review_required_count or 0),
        "low_confidence_run_count": int(low_confidence_run_count or 0),
        "average_repair_count": float(average_repair_count or 0.0),
        "validation_passed_count": int(validation_passed_count or 0),
        "validation_failed_count": int(validation_failed_count or 0),
        "success_rate": float(success_rate or 0.0),
        "failure_rate": float(failure_rate or 0.0),
        "blocked_rate": float(blocked_rate or 0.0),
        "review_required_rate": float(review_required_rate or 0.0),
        "low_confidence_patch_rate": float(low_confidence_patch_rate or 0.0),
        "validation_pass_rate": float(validation_pass_rate or 0.0),
        "validation_fail_rate": float(validation_fail_rate or 0.0),
        "strategy_summaries": [dict(item) for item in list(strategy_summaries or []) if isinstance(item, dict)],
        "repeated_blockers": [dict(item) for item in list(repeated_blockers or []) if isinstance(item, dict)],
        "retry_actions": [dict(item) for item in list(retry_actions or []) if isinstance(item, dict)],
        "best_strategy": dict(best_strategy or {}),
        "weakest_strategy": dict(weakest_strategy or {}),
        "recommended_next_strategy": str(recommended_next_strategy or ""),
        "recommended_next_action": str(recommended_next_action or ""),
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "metadata": dict(metadata or {}),
    }


def build_owner_experiment_summary(
    *,
    dataset_path: str,
    total_runs: int,
    summary: str,
    best_strategy: dict[str, Any] | None = None,
    weakest_strategy: dict[str, Any] | None = None,
    recommended_next_strategy: str = "",
    recommended_next_action: str = "",
    repeated_blockers: list[dict[str, Any]] | None = None,
    artifact_paths: list[str] | None = None,
    benchmark_summary: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "dataset_path": str(dataset_path or ""),
        "total_runs": int(total_runs or 0),
        "summary": str(summary or ""),
        "best_strategy": dict(best_strategy or {}),
        "weakest_strategy": dict(weakest_strategy or {}),
        "recommended_next_strategy": str(recommended_next_strategy or ""),
        "recommended_next_action": str(recommended_next_action or ""),
        "repeated_blockers": [dict(item) for item in list(repeated_blockers or []) if isinstance(item, dict)],
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "benchmark_summary": dict(benchmark_summary or {}),
        "metadata": dict(metadata or {}),
    }


def build_training_handoff(
    *,
    dataset_path: str,
    export_path: str,
    total_runs: int,
    selected_run_count: int,
    recommended_strategy: str,
    recommended_focus: str,
    filters: dict[str, Any] | None = None,
    schema_fields: list[str] | None = None,
    strategy_summaries: list[dict[str, Any]] | None = None,
    repeated_blockers: list[dict[str, Any]] | None = None,
    selected_runs: list[dict[str, Any]] | None = None,
    artifact_paths: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "dataset_path": str(dataset_path or ""),
        "export_path": str(export_path or ""),
        "total_runs": int(total_runs or 0),
        "selected_run_count": int(selected_run_count or 0),
        "recommended_strategy": str(recommended_strategy or ""),
        "recommended_focus": str(recommended_focus or ""),
        "filters": dict(filters or {}),
        "schema_fields": [str(item) for item in list(schema_fields or []) if str(item)],
        "strategy_summaries": [dict(item) for item in list(strategy_summaries or []) if isinstance(item, dict)],
        "repeated_blockers": [dict(item) for item in list(repeated_blockers or []) if isinstance(item, dict)],
        "selected_runs": [dict(item) for item in list(selected_runs or []) if isinstance(item, dict)],
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "metadata": dict(metadata or {}),
    }


def build_self_improvement_candidate(
    *,
    candidate_id: str,
    kind: str,
    source: str,
    title: str,
    summary: str,
    priority: str,
    score: float,
    occurrences: int,
    eligible: bool,
    eligibility_reason: str = "",
    recommended_next_step: str = "",
    advisory_reason_code: str = "",
    advisory_summary: str = "",
    target_paths: list[str] | None = None,
    source_tickets: list[str] | None = None,
    evidence: dict[str, Any] | None = None,
    artifact_paths: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "candidate_id": str(candidate_id or ""),
        "kind": str(kind or ""),
        "source": str(source or ""),
        "title": str(title or ""),
        "summary": str(summary or ""),
        "priority": str(priority or "medium"),
        "score": float(score or 0.0),
        "occurrences": int(occurrences or 0),
        "eligible": bool(eligible),
        "eligibility_reason": str(eligibility_reason or ""),
        "recommended_next_step": str(recommended_next_step or ""),
        "advisory_reason_code": str(advisory_reason_code or ""),
        "advisory_summary": str(advisory_summary or ""),
        "target_paths": [str(path) for path in list(target_paths or []) if str(path)],
        "source_tickets": [str(ticket) for ticket in list(source_tickets or []) if str(ticket)],
        "evidence": dict(evidence or {}),
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "metadata": dict(metadata or {}),
    }


def build_project_profile(
    *,
    profile_id: str,
    project_root: str,
    name: str,
    project_kind: str,
    repo_index_path: str = "",
    top_level_directories: list[str] | None = None,
    source_roots: list[str] | None = None,
    test_roots: list[str] | None = None,
    docs_roots: list[str] | None = None,
    config_files: list[str] | None = None,
    entry_points: list[str] | None = None,
    language_counts: dict[str, Any] | None = None,
    architecture: dict[str, Any] | None = None,
    artifact_paths: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "profile_id": str(profile_id or ""),
        "project_root": str(project_root or ""),
        "name": str(name or ""),
        "project_kind": str(project_kind or "unknown"),
        "repo_index_path": str(repo_index_path or ""),
        "top_level_directories": [str(item) for item in list(top_level_directories or []) if str(item)],
        "source_roots": [str(item) for item in list(source_roots or []) if str(item)],
        "test_roots": [str(item) for item in list(test_roots or []) if str(item)],
        "docs_roots": [str(item) for item in list(docs_roots or []) if str(item)],
        "config_files": [str(item) for item in list(config_files or []) if str(item)],
        "entry_points": [str(item) for item in list(entry_points or []) if str(item)],
        "language_counts": dict(language_counts or {}),
        "architecture": dict(architecture or {}),
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "metadata": dict(metadata or {}),
    }


def build_project_health_summary(
    *,
    profile_id: str,
    status: str,
    score: float,
    grade: str,
    summary: str,
    repo_file_count: int,
    source_file_count: int,
    test_file_count: int,
    doc_file_count: int,
    config_file_count: int,
    missing_test_count: int = 0,
    repeated_failure_count: int = 0,
    baseline_state: str = "",
    top_hotspots: list[dict[str, Any]] | None = None,
    signals: list[dict[str, Any]] | None = None,
    artifact_paths: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "profile_id": str(profile_id or ""),
        "status": str(status or "unknown"),
        "score": float(score or 0.0),
        "grade": str(grade or "N/A"),
        "summary": str(summary or ""),
        "repo_file_count": int(repo_file_count or 0),
        "source_file_count": int(source_file_count or 0),
        "test_file_count": int(test_file_count or 0),
        "doc_file_count": int(doc_file_count or 0),
        "config_file_count": int(config_file_count or 0),
        "missing_test_count": int(missing_test_count or 0),
        "repeated_failure_count": int(repeated_failure_count or 0),
        "baseline_state": str(baseline_state or ""),
        "top_hotspots": [dict(item) for item in list(top_hotspots or []) if isinstance(item, dict)],
        "signals": [dict(item) for item in list(signals or []) if isinstance(item, dict)],
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "metadata": dict(metadata or {}),
    }


def build_project_maintenance_candidate(
    *,
    candidate_id: str,
    profile_id: str,
    kind: str,
    source: str,
    title: str,
    summary: str,
    priority: str,
    score: float,
    occurrences: int,
    eligible: bool,
    eligibility_reason: str = "",
    target_paths: list[str] | None = None,
    source_tickets: list[str] | None = None,
    evidence: dict[str, Any] | None = None,
    artifact_paths: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "candidate_id": str(candidate_id or ""),
        "profile_id": str(profile_id or ""),
        "kind": str(kind or ""),
        "source": str(source or ""),
        "title": str(title or ""),
        "summary": str(summary or ""),
        "priority": str(priority or "medium"),
        "score": float(score or 0.0),
        "occurrences": int(occurrences or 0),
        "eligible": bool(eligible),
        "eligibility_reason": str(eligibility_reason or ""),
        "target_paths": [str(path) for path in list(target_paths or []) if str(path)],
        "source_tickets": [str(ticket) for ticket in list(source_tickets or []) if str(ticket)],
        "evidence": dict(evidence or {}),
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "metadata": dict(metadata or {}),
    }


def build_project_maintenance_task(
    *,
    task_id: str,
    profile_id: str,
    candidate_id: str,
    title: str,
    objective: str,
    priority: str,
    status: str,
    action: str,
    mode: str,
    target_paths: list[str] | None = None,
    host_boundary: dict[str, Any] | None = None,
    runtime_task: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "task_id": str(task_id or ""),
        "profile_id": str(profile_id or ""),
        "candidate_id": str(candidate_id or ""),
        "title": str(title or ""),
        "objective": str(objective or ""),
        "priority": str(priority or "medium"),
        "status": str(status or "prepared"),
        "action": str(action or "implement"),
        "mode": str(mode or "integrate"),
        "target_paths": [str(path) for path in list(target_paths or []) if str(path)],
        "host_boundary": dict(host_boundary or {}),
        "runtime_task": dict(runtime_task or {}),
        "metadata": dict(metadata or {}),
    }


def build_project_maintenance_queue_summary(
    *,
    queue_id: str,
    profile_id: str,
    summary: str,
    total_candidates: int,
    eligible_candidate_count: int,
    blocked_candidate_count: int,
    prepared_task_count: int,
    source_counts: dict[str, Any] | None = None,
    top_candidates: list[dict[str, Any]] | None = None,
    prepared_tasks: list[dict[str, Any]] | None = None,
    artifact_paths: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "queue_id": str(queue_id or ""),
        "profile_id": str(profile_id or ""),
        "summary": str(summary or ""),
        "total_candidates": int(total_candidates or 0),
        "eligible_candidate_count": int(eligible_candidate_count or 0),
        "blocked_candidate_count": int(blocked_candidate_count or 0),
        "prepared_task_count": int(prepared_task_count or 0),
        "source_counts": dict(source_counts or {}),
        "top_candidates": [dict(item) for item in list(top_candidates or []) if isinstance(item, dict)],
        "prepared_tasks": [dict(item) for item in list(prepared_tasks or []) if isinstance(item, dict)],
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "metadata": dict(metadata or {}),
    }


def build_project_maintenance_recommendation(
    *,
    recommendation_id: str,
    profile_id: str,
    summary: str,
    recommended_action: str,
    priority: str,
    candidate: dict[str, Any] | None = None,
    task: dict[str, Any] | None = None,
    artifact_paths: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "recommendation_id": str(recommendation_id or ""),
        "profile_id": str(profile_id or ""),
        "summary": str(summary or ""),
        "recommended_action": str(recommended_action or ""),
        "priority": str(priority or "medium"),
        "candidate": dict(candidate or {}),
        "task": dict(task or {}),
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "metadata": dict(metadata or {}),
    }


def build_self_improvement_task(
    *,
    task_id: str,
    candidate_id: str,
    title: str,
    objective: str,
    priority: str,
    status: str,
    action: str,
    mode: str,
    target_paths: list[str] | None = None,
    host_boundary: dict[str, Any] | None = None,
    runtime_task: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "task_id": str(task_id or ""),
        "candidate_id": str(candidate_id or ""),
        "title": str(title or ""),
        "objective": str(objective or ""),
        "priority": str(priority or "medium"),
        "status": str(status or "prepared"),
        "action": str(action or "implement"),
        "mode": str(mode or "integrate"),
        "target_paths": [str(path) for path in list(target_paths or []) if str(path)],
        "host_boundary": dict(host_boundary or {}),
        "runtime_task": dict(runtime_task or {}),
        "metadata": dict(metadata or {}),
    }


def build_self_improvement_queue_summary(
    *,
    queue_id: str,
    summary: str,
    total_candidates: int,
    eligible_candidate_count: int,
    blocked_candidate_count: int,
    prepared_task_count: int,
    source_counts: dict[str, Any] | None = None,
    top_candidates: list[dict[str, Any]] | None = None,
    prepared_tasks: list[dict[str, Any]] | None = None,
    artifact_paths: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "queue_id": str(queue_id or ""),
        "summary": str(summary or ""),
        "total_candidates": int(total_candidates or 0),
        "eligible_candidate_count": int(eligible_candidate_count or 0),
        "blocked_candidate_count": int(blocked_candidate_count or 0),
        "prepared_task_count": int(prepared_task_count or 0),
        "source_counts": dict(source_counts or {}),
        "top_candidates": [dict(item) for item in list(top_candidates or []) if isinstance(item, dict)],
        "prepared_tasks": [dict(item) for item in list(prepared_tasks or []) if isinstance(item, dict)],
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "metadata": dict(metadata or {}),
    }


def build_self_improvement_recommendation(
    *,
    recommendation_id: str,
    summary: str,
    recommended_action: str,
    priority: str,
    candidate: dict[str, Any] | None = None,
    task: dict[str, Any] | None = None,
    artifact_paths: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "recommendation_id": str(recommendation_id or ""),
        "summary": str(summary or ""),
        "recommended_action": str(recommended_action or ""),
        "priority": str(priority or "medium"),
        "candidate": dict(candidate or {}),
        "task": dict(task or {}),
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "metadata": dict(metadata or {}),
    }


def build_owner_goal(
    *,
    goal_id: str,
    title: str,
    raw_goal: str,
    normalized_goal: str,
    category: str,
    priority: str,
    status: str = "normalized",
    target_paths: list[str] | None = None,
    constraints: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "goal_id": str(goal_id or ""),
        "title": str(title or ""),
        "raw_goal": str(raw_goal or ""),
        "normalized_goal": str(normalized_goal or ""),
        "category": str(category or "analysis/reporting"),
        "priority": str(priority or "medium"),
        "status": str(status or "normalized"),
        "target_paths": [str(path) for path in list(target_paths or []) if str(path)],
        "constraints": dict(constraints or {}),
        "metadata": dict(metadata or {}),
    }


def build_owner_goal_plan(
    *,
    plan_id: str,
    project_root: str,
    summary: str,
    total_goals: int,
    category_counts: dict[str, Any] | None = None,
    goals: list[dict[str, Any]] | None = None,
    artifact_paths: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "plan_id": str(plan_id or ""),
        "project_root": str(project_root or ""),
        "summary": str(summary or ""),
        "total_goals": int(total_goals or 0),
        "category_counts": dict(category_counts or {}),
        "goals": [dict(item) for item in list(goals or []) if isinstance(item, dict)],
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "metadata": dict(metadata or {}),
    }


def build_owner_automation_candidate(
    *,
    candidate_id: str,
    goal_id: str,
    category: str,
    source: str,
    title: str,
    summary: str,
    priority: str,
    score: float,
    eligible: bool,
    action: str,
    mode: str,
    eligibility_reason: str = "",
    target_paths: list[str] | None = None,
    evidence: dict[str, Any] | None = None,
    artifact_paths: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "candidate_id": str(candidate_id or ""),
        "goal_id": str(goal_id or ""),
        "category": str(category or "analysis/reporting"),
        "source": str(source or "owner_goal"),
        "title": str(title or ""),
        "summary": str(summary or ""),
        "priority": str(priority or "medium"),
        "score": float(score or 0.0),
        "eligible": bool(eligible),
        "action": str(action or "implement"),
        "mode": str(mode or "integrate"),
        "eligibility_reason": str(eligibility_reason or ""),
        "target_paths": [str(path) for path in list(target_paths or []) if str(path)],
        "evidence": dict(evidence or {}),
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "metadata": dict(metadata or {}),
    }


def build_owner_automation_task(
    *,
    task_id: str,
    goal_id: str,
    candidate_id: str,
    title: str,
    objective: str,
    category: str,
    priority: str,
    status: str,
    action: str,
    mode: str,
    target_paths: list[str] | None = None,
    host_boundary: dict[str, Any] | None = None,
    runtime_task: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "task_id": str(task_id or ""),
        "goal_id": str(goal_id or ""),
        "candidate_id": str(candidate_id or ""),
        "title": str(title or ""),
        "objective": str(objective or ""),
        "category": str(category or "analysis/reporting"),
        "priority": str(priority or "medium"),
        "status": str(status or "prepared"),
        "action": str(action or "implement"),
        "mode": str(mode or "integrate"),
        "target_paths": [str(path) for path in list(target_paths or []) if str(path)],
        "host_boundary": dict(host_boundary or {}),
        "runtime_task": dict(runtime_task or {}),
        "metadata": dict(metadata or {}),
    }


def build_owner_automation_queue_summary(
    *,
    queue_id: str,
    profile_id: str,
    summary: str,
    total_goals: int,
    total_candidates: int,
    eligible_candidate_count: int,
    blocked_candidate_count: int,
    prepared_task_count: int,
    category_counts: dict[str, Any] | None = None,
    top_candidates: list[dict[str, Any]] | None = None,
    prepared_tasks: list[dict[str, Any]] | None = None,
    artifact_paths: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "queue_id": str(queue_id or ""),
        "profile_id": str(profile_id or ""),
        "summary": str(summary or ""),
        "total_goals": int(total_goals or 0),
        "total_candidates": int(total_candidates or 0),
        "eligible_candidate_count": int(eligible_candidate_count or 0),
        "blocked_candidate_count": int(blocked_candidate_count or 0),
        "prepared_task_count": int(prepared_task_count or 0),
        "category_counts": dict(category_counts or {}),
        "top_candidates": [dict(item) for item in list(top_candidates or []) if isinstance(item, dict)],
        "prepared_tasks": [dict(item) for item in list(prepared_tasks or []) if isinstance(item, dict)],
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "metadata": dict(metadata or {}),
    }


def build_owner_automation_recommendation(
    *,
    recommendation_id: str,
    profile_id: str,
    summary: str,
    recommended_action: str,
    priority: str,
    goal: dict[str, Any] | None = None,
    plan: dict[str, Any] | None = None,
    candidate: dict[str, Any] | None = None,
    task: dict[str, Any] | None = None,
    artifact_paths: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "recommendation_id": str(recommendation_id or ""),
        "profile_id": str(profile_id or ""),
        "summary": str(summary or ""),
        "recommended_action": str(recommended_action or ""),
        "priority": str(priority or "medium"),
        "goal": dict(goal or {}),
        "plan": dict(plan or {}),
        "candidate": dict(candidate or {}),
        "task": dict(task or {}),
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "metadata": dict(metadata or {}),
    }


def build_runtime_result(
    *,
    task: dict[str, Any],
    runtime_run: dict[str, Any],
    ok: bool,
    failure: dict[str, Any] | None = None,
    artifact_paths: list[str] | None = None,
    metrics: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
    task_objective: dict[str, Any] | None = None,
    failure_class: dict[str, Any] | None = None,
    recovery_ladder: dict[str, Any] | None = None,
    checkpoint_ref: dict[str, Any] | None = None,
    interrupt_request: dict[str, Any] | None = None,
    review_bundle: dict[str, Any] | None = None,
    workbench_artifacts: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    state = str(runtime_run.get("state") or "created")
    status = "blocked" if state == "blocked" else ("succeeded" if ok else "failed")
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "task_id": str(task.get("task_id") or ""),
        "run_id": str(runtime_run.get("run_id") or ""),
        "ticket": str(task.get("ticket") or runtime_run.get("ticket") or ""),
        "action": str(task.get("action") or "run"),
        "mode": str(task.get("mode") or runtime_run.get("mode") or "integrate"),
        "run_mode": str(task.get("run_mode") or runtime_run.get("run_mode") or "manual"),
        "task_mode": str(task.get("task_mode") or task.get("taskMode") or runtime_run.get("task_mode") or runtime_run.get("taskMode") or ""),
        "ok": bool(ok),
        "status": status,
        "final_state": state,
        "started_at": runtime_run.get("started_at"),
        "finished_at": runtime_run.get("finished_at"),
        "artifact_paths": [str(path) for path in list(artifact_paths or []) if str(path)],
        "failure": dict(failure or {}),
        "metrics": dict(metrics or {}),
        "metadata": dict(metadata or {}),
        "task_objective": dict(task_objective or {}),
        "failure_class": dict(failure_class or {}),
        "recovery_ladder": dict(recovery_ladder or {}),
        "checkpoint_ref": dict(checkpoint_ref or {}),
        "interrupt_request": dict(interrupt_request or {}),
        "review_bundle": dict(review_bundle or {}),
        "workbench_artifacts": _normalize_dict_list(workbench_artifacts),
    }


def build_runtime_memory_record(
    *,
    ticket_id: str,
    run_id: str = "",
    task_id: str = "",
    strategy: str = "",
    action: str = "run",
    mode: str = "integrate",
    validation: str = "",
    files_written: list[str] | None = None,
    selected_patch_labels: list[str] | None = None,
    decision_types: list[str] | None = None,
    active_file_path: str = "",
    created_at: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "ticket": str(ticket_id or ""),
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "strategy": str(strategy or ""),
        "action": str(action or "run"),
        "mode": str(mode or "integrate"),
        "validation": str(validation or ""),
        "files_written": [str(path) for path in list(files_written or []) if str(path)],
        "selected_patch_labels": [str(label) for label in list(selected_patch_labels or []) if str(label)],
        "decision_types": [str(item) for item in list(decision_types or []) if str(item)],
        "active_file_path": str(active_file_path or ""),
        "created_at": str(created_at or _utc_now()),
        "metadata": dict(metadata or {}),
    }


def build_failure_memory_record(
    *,
    ticket_id: str,
    run_id: str = "",
    task_id: str = "",
    strategy: str = "",
    fingerprints: list[str] | None = None,
    retry_action: str = "",
    repair_skipped: bool = False,
    cooldown_until: str = "",
    noisy_failure_labels: list[str] | None = None,
    recurring_blockers: list[dict[str, Any]] | None = None,
    recommended_response: str = "",
    created_at: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    normalized_fingerprints = [str(label) for label in list(fingerprints or []) if str(label)]
    repeated_fingerprints = sorted({label for label in normalized_fingerprints if normalized_fingerprints.count(label) >= 2})
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "ticket": str(ticket_id or ""),
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "strategy": str(strategy or ""),
        "fingerprints": normalized_fingerprints,
        "retry_action": str(retry_action or ""),
        "repair_skipped": bool(repair_skipped),
        "cooldown_until": str(cooldown_until or ""),
        "repeated_fingerprint_labels": repeated_fingerprints,
        "repeat_count": max((normalized_fingerprints.count(label) for label in set(normalized_fingerprints)), default=0),
        "noisy_failure_labels": [str(label) for label in list(noisy_failure_labels or []) if str(label)],
        "recurring_blockers": [dict(item) for item in list(recurring_blockers or []) if isinstance(item, dict)],
        "recommended_response": str(recommended_response or "ticket_repair"),
        "created_at": str(created_at or _utc_now()),
        "metadata": dict(metadata or {}),
    }


def build_repair_memory_record(
    *,
    ticket_id: str,
    run_id: str = "",
    task_id: str = "",
    strategy: str = "",
    action: str = "",
    attempted_paths: list[str] | None = None,
    successful: bool | None = None,
    skipped: bool = False,
    skip_reason: str = "",
    selected_patch_labels: list[str] | None = None,
    created_at: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "ticket": str(ticket_id or ""),
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "strategy": str(strategy or ""),
        "action": str(action or ""),
        "attempted_paths": [str(path) for path in list(attempted_paths or []) if str(path)],
        "repair_count": len([str(path) for path in list(attempted_paths or []) if str(path)]),
        "successful": None if successful is None else bool(successful),
        "skipped": bool(skipped),
        "skip_reason": str(skip_reason or ""),
        "selected_patch_labels": [str(label) for label in list(selected_patch_labels or []) if str(label)],
        "created_at": str(created_at or _utc_now()),
        "metadata": dict(metadata or {}),
    }


def build_test_signal_memory_record(
    *,
    ticket_id: str,
    run_id: str = "",
    task_id: str = "",
    fingerprint_labels: list[str] | None = None,
    noisy_labels: list[str] | None = None,
    failing_commands: list[str] | None = None,
    blocking_fingerprint_count: int = 0,
    recommended_action: str = "",
    created_at: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "ticket": str(ticket_id or ""),
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "fingerprint_labels": [str(label) for label in list(fingerprint_labels or []) if str(label)],
        "noisy_labels": [str(label) for label in list(noisy_labels or []) if str(label)],
        "failing_commands": [str(command) for command in list(failing_commands or []) if str(command)],
        "blocking_fingerprint_count": int(blocking_fingerprint_count or 0),
        "recommended_action": str(recommended_action or ""),
        "created_at": str(created_at or _utc_now()),
        "metadata": dict(metadata or {}),
    }


def build_strategy_memory_record(
    *,
    ticket_id: str,
    run_id: str = "",
    task_id: str = "",
    strategy: str = "",
    validation: str = "",
    files_written: list[str] | None = None,
    selected_patch_labels: list[str] | None = None,
    success: bool | None = None,
    write_enabled: bool | None = None,
    created_at: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "ticket": str(ticket_id or ""),
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "strategy": str(strategy or ""),
        "validation": str(validation or ""),
        "files_written": [str(path) for path in list(files_written or []) if str(path)],
        "selected_patch_labels": [str(label) for label in list(selected_patch_labels or []) if str(label)],
        "success": None if success is None else bool(success),
        "write_enabled": None if write_enabled is None else bool(write_enabled),
        "created_at": str(created_at or _utc_now()),
        "metadata": dict(metadata or {}),
    }


def build_tool_request(
    *,
    tool_call_id: str,
    run_id: str,
    task_id: str,
    ticket_id: str,
    agent_name: str,
    tool_name: str,
    args: dict[str, Any] | None = None,
    safety_level: str = "safe",
    boundary: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
    requested_at: str | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "tool_call_id": str(tool_call_id or ""),
        "run_id": str(run_id or ""),
        "task_id": str(task_id or ""),
        "ticket": str(ticket_id or ""),
        "agent": str(agent_name or ""),
        "tool": str(tool_name or ""),
        "args": dict(args or {}),
        "safety_level": str(safety_level or "safe"),
        "boundary": dict(boundary or {}),
        "requested_at": str(requested_at or _utc_now()),
        "metadata": dict(metadata or {}),
    }


def build_tool_permission_decision(
    *,
    request: dict[str, Any],
    allowed: bool,
    requires_approval: bool,
    status: str,
    reason: str,
    source: str,
    approval_request_id: str = "",
    note: str = "",
    decided_at: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "tool_call_id": str(request.get("tool_call_id") or ""),
        "run_id": str(request.get("run_id") or ""),
        "task_id": str(request.get("task_id") or ""),
        "ticket": str(request.get("ticket") or ""),
        "agent": str(request.get("agent") or ""),
        "tool": str(request.get("tool") or ""),
        "allowed": bool(allowed),
        "requires_approval": bool(requires_approval),
        "status": str(status or ("allowed" if allowed else "denied")),
        "reason": str(reason or ""),
        "source": str(source or "permission_registry"),
        "approval_request_id": str(approval_request_id or ""),
        "note": str(note or ""),
        "decided_at": str(decided_at or _utc_now()),
        "metadata": dict(metadata or {}),
    }


def build_tool_error(
    *,
    request: dict[str, Any],
    kind: str,
    message: str,
    retryable: bool = False,
    details: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "tool_call_id": str(request.get("tool_call_id") or ""),
        "run_id": str(request.get("run_id") or ""),
        "task_id": str(request.get("task_id") or ""),
        "ticket": str(request.get("ticket") or ""),
        "agent": str(request.get("agent") or ""),
        "tool": str(request.get("tool") or ""),
        "kind": str(kind or "tool-error"),
        "message": str(message or "tool execution failed"),
        "retryable": bool(retryable),
        "details": dict(details or {}),
        "metadata": dict(metadata or {}),
    }


def build_tool_result(
    *,
    request: dict[str, Any],
    ok: bool,
    status: str,
    permission: dict[str, Any] | None = None,
    output: Any = None,
    error: dict[str, Any] | None = None,
    started_at: str | None = None,
    finished_at: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTRACT_SCHEMA_VERSION,
        "tool_call_id": str(request.get("tool_call_id") or ""),
        "run_id": str(request.get("run_id") or ""),
        "task_id": str(request.get("task_id") or ""),
        "ticket": str(request.get("ticket") or ""),
        "agent": str(request.get("agent") or ""),
        "tool": str(request.get("tool") or ""),
        "ok": bool(ok),
        "status": str(status or ("succeeded" if ok else "failed")),
        "started_at": str(started_at or _utc_now()),
        "finished_at": str(finished_at or _utc_now()),
        "safety_level": str(request.get("safety_level") or "safe"),
        "boundary": dict(request.get("boundary") or {}),
        "permission": dict(permission or {}),
        "output": output,
        "error": dict(error or {}),
        "metadata": dict(metadata or {}),
    }


__all__ = [
    "RUNTIME_CONTRACT_SCHEMA_VERSION",
    "REVIEW_LIFECYCLE_STATES",
    "TERMINAL_RUNTIME_STATES",
    "build_experiment_run",
    "build_experiment_scenario",
    "build_experiment_scorecard",
    "build_experiment_benchmark_summary",
    "build_owner_summary",
    "build_owner_experiment_summary",
    "build_recommended_action",
    "build_review_artifact",
    "build_review_bundle",
    "build_review_context",
    "build_review_decision",
    "build_review_queue_summary",
    "build_review_request",
    "build_run_summary",
    "build_checkpoint_ref",
    "build_failure_class",
    "build_test_summary",
    "build_task_objective",
    "build_runtime_artifact",
    "build_agent_output",
    "build_runtime_event",
    "build_runtime_failure",
    "build_runtime_memory_record",
    "build_runtime_result",
    "build_runtime_run",
    "build_runtime_task",
    "build_recovery_ladder_state",
    "build_workbench_artifact",
    "build_interrupt_request",
    "build_strategy_benchmark",
    "build_project_health_summary",
    "build_project_maintenance_candidate",
    "build_project_maintenance_queue_summary",
    "build_project_maintenance_recommendation",
    "build_project_maintenance_task",
    "build_project_profile",
    "build_self_improvement_candidate",
    "build_self_improvement_queue_summary",
    "build_self_improvement_recommendation",
    "build_self_improvement_task",
    "build_training_handoff",
    "build_failure_memory_record",
    "build_repair_memory_record",
    "build_strategy_memory_record",
    "build_test_signal_memory_record",
    "append_agent_output",
    "build_tool_error",
    "build_tool_permission_decision",
    "build_tool_request",
    "build_tool_result",
    "summarize_review_state",
    "transition_runtime_run",
]
