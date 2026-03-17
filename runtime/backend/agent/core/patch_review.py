from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from backend.agent.runtime.contracts import (
	build_review_artifact,
	build_review_context,
	build_review_request,
	summarize_review_state,
)


def _clip_preview(text: str, *, max_chars: int = 220) -> str:
	payload = str(text or "").strip()
	if len(payload) <= max_chars:
		return payload
	return payload[: max_chars - 1].rstrip() + "…"


def _extract_repo_paths(text: str) -> list[str]:
	return [
		str(path)
		for path in re.findall(r"((?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+\.(?:py|ts|tsx|js|jsx))", str(text or ""))
	]


def _is_test_path(path: str) -> bool:
	lower = str(path or "").strip().lower()
	name = Path(lower).name
	return "/tests/" in f"/{lower}" or lower.startswith("tests/") or name.startswith("test_") or name.endswith("_test.py") or ".test." in name


def _looks_like_placeholder_patch(text: str) -> bool:
	payload = str(text or "").strip().lower()
	if not payload:
		return True
	return payload in {"# repair attempt", "# modification from plan", "repair attempt", "modification from plan"}


def _score_candidate(
	*,
	label: str,
	patch: str,
	approved_targets: list[str],
	target_path: str,
	active_file_path: str,
	memory_hints: dict[str, Any],
) -> tuple[float, list[str]]:
	reasons: list[str] = []
	score = 0.2
	payload = str(patch or "").strip()
	if not payload:
		return 0.0, ["empty patch"]
	if _looks_like_placeholder_patch(payload):
		return 0.05, ["placeholder patch"]

	score += 0.25
	reasons.append("non-empty patch")

	if "```" in payload:
		score -= 0.12
		reasons.append("contains markdown fences")

	preferred_labels = {
		str(item).strip().lower()
		for item in list(memory_hints.get("preferred_labels", []) or [])
		if str(item).strip()
	}
	if preferred_labels and label.lower() in preferred_labels:
		score += 0.18
		reasons.append("matches memory preferred strategy")

	normalized_target = str(target_path or "").strip().lower()
	normalized_active = str(active_file_path or "").strip().lower()
	if normalized_target:
		target_name = Path(normalized_target).name
		if normalized_target in payload.lower() or target_name in payload:
			score += 0.14
			reasons.append("mentions target path")
	if normalized_active:
		active_name = Path(normalized_active).name
		if normalized_active in payload.lower() or active_name in payload:
			score += 0.08
			reasons.append("mentions active file")

	extracted = _extract_repo_paths(payload)
	approved = {str(path).strip().lower() for path in approved_targets if str(path).strip()}
	if approved and extracted:
		outside = [path for path in extracted if str(path).lower() not in approved]
		if outside:
			score -= min(0.45, 0.16 * len(outside))
			reasons.append("references unapproved file paths")
		else:
			score += 0.08
			reasons.append("stays within approved targets")

	target_is_test = _is_test_path(target_path)
	if extracted and target_path:
		test_refs = [path for path in extracted if _is_test_path(path)]
		non_test_refs = [path for path in extracted if not _is_test_path(path)]
		if not target_is_test and test_refs:
			score -= min(0.35, 0.18 * len(test_refs))
			reasons.append("references test files while editing source target")
		if target_is_test and non_test_refs and approved and any(str(path).lower() not in approved for path in non_test_refs):
			score -= min(0.2, 0.1 * len(non_test_refs))
			reasons.append("references non-target source files while editing test target")

	score = max(0.0, min(1.0, score))
	return score, reasons


def generate_patch_candidates(
	provider: Any,
	prompt_variants: list[dict[str, str]],
	*,
	approved_targets: list[str] | None = None,
	target_path: str = "",
	active_file_path: str = "",
	memory_hints: dict[str, Any] | None = None,
) -> dict[str, Any]:
	approved = [str(path).strip() for path in list(approved_targets or []) if str(path).strip()]
	hints = dict(memory_hints or {})
	candidates: list[dict[str, Any]] = []

	for index, variant in enumerate(prompt_variants or []):
		label = str(variant.get("label") or f"variant-{index + 1}").strip()
		prompt = str(variant.get("prompt") or "")
		patch = ""
		error = ""
		try:
			patch = str(provider.propose_patch(prompt) or "")
		except Exception as exc:
			error = str(exc)

		score, reasons = _score_candidate(
			label=label,
			patch=patch,
			approved_targets=approved,
			target_path=target_path,
			active_file_path=active_file_path,
			memory_hints=hints,
		)
		if error:
			score = 0.0
			reasons.append(f"provider error: {error}")
		candidates.append(
			{
				"label": label,
				"score": round(score, 4),
				"reasons": reasons,
				"preview": _clip_preview(patch),
				"patch": patch,
			}
		)

	if not candidates:
		candidates.append(
			{
				"label": "no-candidate",
				"score": 0.0,
				"reasons": ["no prompt variants provided"],
				"preview": "",
				"patch": "",
			}
		)

	ranked = sorted(candidates, key=lambda row: (-float(row.get("score") or 0), str(row.get("label") or "")))
	best = ranked[0]
	best_candidate = {
		"label": best.get("label"),
		"score": best.get("score"),
		"reasons": best.get("reasons", []),
		"preview": best.get("preview", ""),
	}
	return {
		"best_patch": best.get("patch", ""),
		"best_candidate": best_candidate,
		"candidates": [
			{
				"label": row.get("label"),
				"score": row.get("score"),
				"reasons": row.get("reasons", []),
				"preview": row.get("preview", ""),
			}
			for row in ranked
		],
		"memory_hints": hints,
	}


def _runtime_scope(
	*,
	runtime_context: dict[str, Any] | None = None,
	runtime_task: dict[str, Any] | None = None,
	runtime_run: dict[str, Any] | None = None,
) -> dict[str, str]:
	context = dict(runtime_context or {})
	task = dict(runtime_task or {})
	run = dict(runtime_run or {})
	return {
		"run_id": str(run.get("run_id") or context.get("run_id") or ""),
		"task_id": str(task.get("task_id") or context.get("task_id") or ""),
		"ticket": str(task.get("ticket") or run.get("ticket") or context.get("ticket") or ""),
	}


def _artifact_ref(artifact: dict[str, Any]) -> dict[str, Any]:
	return {
		"review_id": str(artifact.get("review_id") or ""),
		"kind": str(artifact.get("kind") or "review-artifact"),
		"label": str(artifact.get("label") or ""),
		"path": str(artifact.get("path") or ""),
		"format": str(artifact.get("format") or "json"),
		"summary": str(artifact.get("summary") or ""),
	}


def _build_patch_risk_review_request(
	*,
	source: str,
	path: str,
	review: dict[str, Any],
	reason: str,
	blocked: bool,
	runtime_context: dict[str, Any] | None = None,
	runtime_task: dict[str, Any] | None = None,
	runtime_run: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
	scope = _runtime_scope(runtime_context=runtime_context, runtime_task=runtime_task, runtime_run=runtime_run)
	selected_label = str(review.get("selected_label") or "")
	selected_score = float(review.get("selected_score") or 0)
	selected_preview = str(review.get("selected_preview") or "")
	review_id = f"patch-risk:{source}:{path or selected_label or 'unknown'}"
	artifacts = [
		build_review_artifact(
			run_id=scope["run_id"],
			task_id=scope["task_id"],
			ticket_id=scope["ticket"],
			review_id=review_id,
			kind="patch-preview",
			label=selected_label,
			path=path,
			format="text",
			summary=f"Patch preview for {path or 'unknown path'}",
			metadata={
				"preview": selected_preview,
				"selected_score": selected_score,
				"selected_reasons": list(review.get("selected_reasons", []) or []),
				"candidate_count": int(review.get("candidate_count") or 0),
				"alternate_candidates": list(review.get("alternate_candidates", []) or []),
				"source": source,
				"blocked": blocked,
			},
		),
	]
	context = build_review_context(
		run_id=scope["run_id"],
		task_id=scope["task_id"],
		ticket_id=scope["ticket"],
		stage="implementation" if source == "execution" else "repair",
		review_type="patch-risk",
		summary=reason,
		risk_level="low-confidence",
		action="modify_file" if source == "execution" else "repair_file",
		target_paths=[path] if path else [],
		evidence={
			"source": source,
			"path": path,
			"blocked": blocked,
			"selected_label": selected_label,
			"selected_score": selected_score,
			"selected_reasons": list(review.get("selected_reasons", []) or []),
			"alternate_candidates": list(review.get("alternate_candidates", []) or []),
			"reason": reason,
		},
	)
	request = build_review_request(
		review_id=review_id,
		run_id=scope["run_id"],
		task_id=scope["task_id"],
		ticket_id=scope["ticket"],
		title=f"Review low-confidence patch for {path or 'unknown path'}",
		request_type="patch-risk",
		summary=reason,
		requested_by="implementer" if source == "execution" else "repair",
		state="pending_review",
		reason=reason,
		context=context,
		artifact_refs=[_artifact_ref(item) for item in artifacts],
		metadata={
			"path": path,
			"source": source,
			"blocked": blocked,
			"selected_label": selected_label,
			"selected_score": selected_score,
		},
	)
	return request, artifacts


def _build_write_gate_review_request(
	*,
	write_gate: dict[str, Any],
	runtime_context: dict[str, Any] | None = None,
	runtime_task: dict[str, Any] | None = None,
	runtime_run: dict[str, Any] | None = None,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
	payload = dict(write_gate or {})
	if not payload.get("requested_write") or payload.get("allow_write") or not payload.get("requires_confirmation"):
		return None, []
	scope = _runtime_scope(runtime_context=runtime_context, runtime_task=runtime_task, runtime_run=runtime_run)
	review_id = f"write-gate:{scope['run_id'] or scope['ticket'] or 'runtime'}"
	artifacts = [
		build_review_artifact(
			run_id=scope["run_id"],
			task_id=scope["task_id"],
			ticket_id=scope["ticket"],
			review_id=review_id,
			kind="write-gate",
			label="write-confirmation",
			format="json",
			summary="Write gate requires confirmation before execution can continue",
			metadata=payload,
		),
	]
	context = build_review_context(
		run_id=scope["run_id"],
		task_id=scope["task_id"],
		ticket_id=scope["ticket"],
		stage="release",
		review_type="write-confirmation",
		summary=str(payload.get("reason") or "manual confirmation required before writes"),
		risk_level="runtime-gate",
		action="write",
		target_paths=[str(path) for path in list((runtime_context or {}).get("related_files", []) or []) if str(path)][:5],
		evidence=dict(payload),
	)
	request = build_review_request(
		review_id=review_id,
		run_id=scope["run_id"],
		task_id=scope["task_id"],
		ticket_id=scope["ticket"],
		title="Confirm runtime write gate",
		request_type="write-confirmation",
		summary=str(payload.get("reason") or "manual confirmation required before writes"),
		requested_by="runtime",
		state="pending_review",
		reason=str(payload.get("reason") or "manual confirmation required before writes"),
		context=context,
		artifact_refs=[_artifact_ref(item) for item in artifacts],
		metadata=dict(payload),
	)
	return request, artifacts


def build_review_summary(
	*,
	execution_results: list[dict[str, Any]] | None = None,
	repair_entries: list[dict[str, Any]] | None = None,
	pending_approvals: list[dict[str, Any]] | None = None,
	handoff_history: list[dict[str, Any]] | None = None,
	runtime_context: dict[str, Any] | None = None,
	runtime_task: dict[str, Any] | None = None,
	runtime_run: dict[str, Any] | None = None,
	write_gate: dict[str, Any] | None = None,
) -> dict[str, Any]:
	execution_rows = list(execution_results or [])
	repair_rows = list(repair_entries or [])
	pending = list(pending_approvals or [])
	low_confidence: list[dict[str, Any]] = []
	review_requests = [
		dict(item.get("review_request") or item)
		for item in pending
		if isinstance(item, dict)
	]
	runtime_scope = dict(runtime_context or {})
	review_artifacts: list[dict[str, Any]] = []

	for row in execution_rows:
		if isinstance(row, dict) and isinstance(row.get("review_request"), dict):
			review_requests.append(dict(row.get("review_request") or {}))
			review_artifacts.extend([dict(item) for item in list(row.get("review_artifacts", []) or []) if isinstance(item, dict)])
		review = row.get("ai_patch_review") if isinstance(row, dict) else None
		if not isinstance(review, dict):
			continue
		score = float(review.get("selected_score") or 0)
		if score < 0.35:
			entry = {
				"path": str(row.get("path") or ""),
				"score": score,
				"label": str(review.get("selected_label") or ""),
				"source": "execution",
			}
			low_confidence.append(entry)
			if not isinstance(row.get("review_request"), dict):
				request, artifacts = _build_patch_risk_review_request(
					source="execution",
					path=str(row.get("path") or ""),
					review=review,
					reason=str(row.get("error") or f"low-confidence patch decision for {row.get('path') or 'unknown path'}"),
					blocked=bool(row.get("blocked")),
					runtime_context=runtime_scope,
					runtime_task=runtime_task,
					runtime_run=runtime_run,
				)
				review_requests.append(request)
				review_artifacts.extend(artifacts)

	for row in repair_rows:
		if isinstance(row, dict) and isinstance(row.get("review_request"), dict):
			review_requests.append(dict(row.get("review_request") or {}))
			review_artifacts.extend([dict(item) for item in list(row.get("review_artifacts", []) or []) if isinstance(item, dict)])
		review = row.get("patch_review") if isinstance(row, dict) else None
		if not isinstance(review, dict):
			continue
		score = float(review.get("selected_score") or 0)
		if score and score < 0.35:
			entry = {
				"path": str(row.get("path") or ""),
				"score": score,
				"label": str(review.get("selected_label") or ""),
				"source": "repair",
			}
			low_confidence.append(entry)
			if not isinstance(row.get("review_request"), dict):
				request, artifacts = _build_patch_risk_review_request(
					source="repair",
					path=str(row.get("path") or ""),
					review=review,
					reason=str(row.get("skip_reason") or f"low-confidence repair patch decision for {row.get('path') or 'unknown path'}"),
					blocked=bool(row.get("skipped")),
					runtime_context=runtime_scope,
					runtime_task=runtime_task,
					runtime_run=runtime_run,
				)
				review_requests.append(request)
				review_artifacts.extend(artifacts)

	write_gate_request, write_gate_artifacts = _build_write_gate_review_request(
		write_gate=write_gate or {},
		runtime_context=runtime_scope,
		runtime_task=runtime_task,
		runtime_run=runtime_run,
	)
	if write_gate_request is not None:
		review_requests.append(write_gate_request)
		review_artifacts.extend(write_gate_artifacts)

	unique_review_requests: list[dict[str, Any]] = []
	seen_review_ids: set[str] = set()
	for item in review_requests:
		if not isinstance(item, dict):
			continue
		review_id = str(item.get("review_id") or item.get("approval_request_id") or "")
		if review_id and review_id in seen_review_ids:
			continue
		if review_id:
			seen_review_ids.add(review_id)
		unique_review_requests.append(dict(item))
	review_requests = unique_review_requests

	review_state = summarize_review_state(review_requests)
	requires_manual_review = bool(review_state.get("requires_manual_review") or low_confidence)
	summary_parts: list[str] = []
	if review_state.get("pending_review_count"):
		summary_parts.append(f"{int(review_state.get('pending_review_count') or 0)} review request(s) pending")
	if low_confidence:
		summary_parts.append(f"{len(low_confidence)} low-confidence patch decision(s)")
	if not summary_parts:
		summary_parts.append("no manual review blockers detected")

	return {
		"requires_manual_review": requires_manual_review,
		"pending_approval_count": len(pending),
		"review_request_count": len(review_requests),
		"pending_review_count": int(review_state.get("pending_review_count") or 0),
		"low_confidence_patch_count": len(low_confidence),
		"summary": "; ".join(summary_parts),
		"pending_approvals": pending,
		"review_requests": review_requests,
		"review_state": {
			**review_state,
			"requires_manual_review": requires_manual_review,
		},
		"review_artifacts": review_artifacts,
		"low_confidence_patches": low_confidence,
		"handoff_history": list(handoff_history or []),
		"runtime_context": dict(runtime_context or {}),
	}


__all__ = [
	"build_review_summary",
	"generate_patch_candidates",
]
