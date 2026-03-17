from __future__ import annotations

from typing import Any


def build_trust_summary(
    *,
    runtime_result: dict[str, Any] | None = None,
    review_queue_summary: dict[str, Any] | None = None,
    performance_baseline: dict[str, Any] | None = None,
    cleanup_summary: dict[str, Any] | None = None,
    duplicate_summary: dict[str, Any] | None = None,
    supervision_label: dict[str, Any] | None = None,
    stage_speed_summary: dict[str, Any] | None = None,
    write_gate: dict[str, Any] | None = None,
) -> dict[str, Any]:
    runtime = dict(runtime_result or {})
    review = dict(review_queue_summary or {})
    baseline = dict(performance_baseline or {})
    cleanup = dict(cleanup_summary or {})
    duplicate = dict(duplicate_summary or {})
    supervision = dict(supervision_label or {})
    stage_speed = dict(stage_speed_summary or {})
    gate = dict(write_gate or {})
    current_performance = dict(baseline.get("current") or {})
    gain_target = dict(baseline.get("gain_target") or {})
    slowest_stage = dict(stage_speed.get("slowest_stage") or {})

    review_required = bool(review.get("requires_manual_review"))
    write_confirmation_required = bool(gate.get("requires_confirmation") and not gate.get("allow_write"))
    cleanup_gate_triggered = bool(gate.get("cleanup_gate_triggered"))
    blocked = str(runtime.get("status") or "").strip().lower() == "blocked"
    trust_state = "trusted"
    if blocked or review_required or write_confirmation_required:
        trust_state = "needs_review"
    if str(supervision.get("learning_label") or "") == "negative":
        trust_state = "rejected"

    return {
        "trust_state": trust_state,
        "status": str(runtime.get("status") or "unknown"),
        "review_required": review_required,
        "write_confirmation_required": write_confirmation_required,
        "cleanup_gate_triggered": cleanup_gate_triggered,
        "approval_queue_size": int(review.get("pending_review_count") or 0),
        "auto_approval_count": int(review.get("auto_approved_count") or 0),
        "duplicate_path_count": int(duplicate.get("duplicate_path_count") or 0),
        "cleanup_candidate_count": int(cleanup.get("candidate_count") or 0),
        "duplicate_helper_candidate_count": int(cleanup.get("duplicate_helper_candidate_count") or 0),
        "learning_label": str(supervision.get("learning_label") or "unlabeled"),
        "approval_mode": str(supervision.get("approval_mode") or "none"),
        "current_cycle_time_seconds": current_performance.get("cycle_time_seconds"),
        "speed_target_met": bool(gain_target.get("met", False)),
        "slowest_stage": str(slowest_stage.get("stage") or ""),
        "slowest_stage_seconds": slowest_stage.get("duration_seconds"),
        "summary": (
            f"trust={trust_state}; learning={str(supervision.get('learning_label') or 'unlabeled')}; "
            f"queue={int(review.get('pending_review_count') or 0)}; "
            f"duplicates={int(duplicate.get('duplicate_path_count') or 0)}; "
            f"slowest_stage={str(slowest_stage.get('stage') or 'unknown')}"
        ),
    }