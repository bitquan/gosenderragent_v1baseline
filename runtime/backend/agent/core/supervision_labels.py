from __future__ import annotations

from typing import Any


def _normalize_text(value: Any) -> str:
    return " ".join(str(value or "").strip().lower().split())


def _classify_rejection_reason(reason: str) -> list[str]:
    text = _normalize_text(reason)
    if not text:
        return ["other"]
    labels: list[str] = []
    if any(token in text for token in ("scope drift", "out of scope", "too broad", "scope", "drift")):
        labels.append("scope_drift")
    if any(token in text for token in ("weak summary", "summary", "unclear", "missing evidence", "insufficient evidence")):
        labels.append("weak_summary")
    if any(token in text for token in ("low-confidence", "low confidence", "confidence")):
        labels.append("low_confidence_patch")
    if any(token in text for token in ("protected", "auth", "payment", "wallet", "migration", "security", "network pool")):
        labels.append("protected_path_touch")
    if any(token in text for token in ("duplicate", "already exists", "repeat", "duplicated")):
        labels.append("duplicate_work")
    if any(token in text for token in ("noisy repair", "repair loop", "too many files", "too many edits", "churn")):
        labels.append("noisy_repair")
    return labels or ["other"]


def build_supervision_label_summary(
    *,
    review_summary: dict[str, Any] | None = None,
    write_gate: dict[str, Any] | None = None,
    runtime_result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    review = dict(review_summary or {})
    review_state = dict(review.get("review_state") or {})
    review_requests = [dict(item) for item in list(review.get("review_requests") or []) if isinstance(item, dict)]
    gate = dict(write_gate or {})
    result = dict(runtime_result or {})
    approved_count = int(review_state.get("approved_count") or 0)
    rejected_count = int(review_state.get("rejected_count") or 0)
    deferred_count = int(review_state.get("deferred_count") or 0)
    pending_review_count = int(review_state.get("pending_review_count") or 0)
    auto_approved_count = int(review_state.get("auto_approved_count") or 0)
    rejection_reasons = [
        str(item.get("reason") or item.get("summary") or "").strip()
        for item in review_requests
        if str(item.get("state") or item.get("status") or "").strip().lower() == "rejected"
        and str(item.get("reason") or item.get("summary") or "").strip()
    ]
    rejection_reason_labels = []
    seen_labels: set[str] = set()
    for reason in rejection_reasons:
        for label in _classify_rejection_reason(reason):
            if label not in seen_labels:
                seen_labels.add(label)
                rejection_reason_labels.append(label)

    outcome = "unlabeled"
    learning_label = "unlabeled"
    approval_mode = "none"
    if rejected_count > 0 or rejection_reasons:
        outcome = "rejected"
        learning_label = "negative"
        approval_mode = "human"
    elif approved_count > 0:
        outcome = "approved"
        learning_label = "positive"
        approval_mode = "human"
    elif auto_approved_count > 0:
        outcome = "auto_approved"
        learning_label = "positive"
        approval_mode = "auto"
    elif deferred_count > 0:
        outcome = "deferred"
        learning_label = "pending"
        approval_mode = "human"
    elif bool(gate.get("requires_confirmation")) and not bool(gate.get("allow_write")):
        outcome = "write_confirmation_required"
        learning_label = "pending"
        approval_mode = "gate"
    elif pending_review_count > 0 or bool(review.get("requires_manual_review")):
        outcome = "pending_review"
        learning_label = "pending"
        approval_mode = "human"

    return {
        "outcome": outcome,
        "learning_label": learning_label,
        "approval_mode": approval_mode,
        "rejection_reasons": rejection_reasons,
        "rejection_reason_labels": rejection_reason_labels,
        "evidence": {
            "approved_count": approved_count,
            "rejected_count": rejected_count,
            "deferred_count": deferred_count,
            "pending_review_count": pending_review_count,
            "auto_approved_count": auto_approved_count,
            "write_confirmation_required": bool(gate.get("requires_confirmation") and not gate.get("allow_write")),
            "runtime_status": str(result.get("status") or "unknown"),
        },
        "summary": (
            f"supervision outcome: {outcome}; learning label: {learning_label}"
            + (f"; rejection reasons: {', '.join(rejection_reason_labels)}" if rejection_reason_labels else "")
        ),
    }