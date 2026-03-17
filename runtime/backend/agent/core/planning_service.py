from __future__ import annotations

from pathlib import Path
from typing import Any

from backend.agent.core.adapters.base import RepoAdapter, TicketMetadata
from backend.agent.core.editor_context import build_coding_task_prompt, normalize_editor_context
from backend.agent.core.memory_service import summarize_strategy_patterns
from backend.agent.core.repo_inspection import is_ignored, rank_related_files
from backend.agent.core.strategies.catalog import get_strategy

DOMAIN_KEYWORDS = [
	"pricing",
	"fare",
	"quote",
	"estimate",
	"surge",
	"demand",
	"zone",
	"dispatch",
	"matching",
	"wallet",
	"checkout",
	"component",
	"route",
	"service",
	"hook",
	"ui",
	"button",
]


_CONFIDENCE_RANK = {"low": 0, "medium": 1, "high": 2}


def _merge_confidence_levels(primary: str, secondary: str) -> str:
	left = str(primary or "low").strip().lower() or "low"
	right = str(secondary or "low").strip().lower() or "low"
	return left if _CONFIDENCE_RANK.get(left, 0) <= _CONFIDENCE_RANK.get(right, 0) else right


def _metadata_from_audit(adapter: RepoAdapter, audit_result: dict[str, Any]) -> TicketMetadata:
	metadata = audit_result.get("metadata")
	if metadata is not None:
		return metadata
	return adapter.parse_ticket_metadata(audit_result["ticket"], audit_result.get("desc", ""))


def _scan_matches(project_root: Path, strategy_name: str, *, ignore_dirs: set[str] | None = None) -> list[str]:
	strategy = get_strategy(strategy_name)
	matches: list[str] = []
	for path in project_root.rglob("*"):
		rel = path.relative_to(project_root)
		if is_ignored(rel, ignore_dirs=ignore_dirs):
			continue
		if strategy.matches_file(str(rel)):
			matches.append(str(rel))
	return matches


def _fallback_matches(project_root: Path, *, ignore_dirs: set[str] | None = None) -> list[str]:
	matches: list[str] = []
	for path in project_root.rglob("*"):
		rel = path.relative_to(project_root)
		if is_ignored(rel, ignore_dirs=ignore_dirs):
			continue
		lower = str(rel).lower()
		if any(keyword in lower for keyword in DOMAIN_KEYWORDS):
			matches.append(str(rel))
	return matches


def _rank_existing_targets(
	matches: list[str],
	*,
	project_root: Path,
	editor_context: dict[str, Any] | None = None,
	query: str = "",
) -> list[str]:
	ranked_related = rank_related_files(
		project_root,
		candidates=matches,
		query=query,
		editor_context=editor_context,
		limit=max(len(matches), 8),
	)
	prioritized = [str(item.get("path")) for item in ranked_related if str(item.get("path"))]
	scores: dict[str, int] = {}
	for match in matches:
		lower = match.lower()
		scores[match] = sum(1 for keyword in DOMAIN_KEYWORDS if keyword in lower)
	keyword_ranked = [match for match, score in sorted(scores.items(), key=lambda item: item[1], reverse=True) if score > 0]
	ordered: list[str] = []
	seen: set[str] = set()
	for group in (prioritized, keyword_ranked, matches):
		for match in group:
			if match in seen:
				continue
			seen.add(match)
			ordered.append(match)
	return ordered[:5]


def _prioritize_memory_targets(paths: list[str], preferred_files: list[str]) -> list[str]:
	preferred = [str(path) for path in list(preferred_files or []) if str(path)]
	if not paths or not preferred:
		return paths
	ordered: list[str] = []
	seen: set[str] = set()
	for candidate in preferred:
		for path in paths:
			if path in seen:
				continue
			if path == candidate or Path(path).name == Path(candidate).name:
				seen.add(path)
				ordered.append(path)
	for path in paths:
		if path in seen:
			continue
		seen.add(path)
		ordered.append(path)
	return ordered


def _matches_allowed_target(path: str, allowed_targets: list[str]) -> bool:
	normalized = str(path or "").strip()
	if not normalized:
		return False
	for allowed in [str(item or "").strip().rstrip("/") for item in list(allowed_targets or []) if str(item or "").strip()]:
		if normalized == allowed or normalized.startswith(f"{allowed}/"):
			return True
	return False


def _apply_bounded_target_boundary(plan: dict[str, Any], runtime_context: dict[str, Any] | None = None) -> dict[str, Any]:
	context = dict(runtime_context or {})
	host_boundary = dict(context.get("host_boundary") or context.get("hostBoundary") or {})
	self_improvement_only = bool(host_boundary.get("self_improvement_only", host_boundary.get("selfImprovementOnly", False)))
	project_maintenance_only = bool(host_boundary.get("project_maintenance_only", host_boundary.get("projectMaintenanceOnly", False)))
	owner_automation_only = bool(host_boundary.get("owner_automation_only", host_boundary.get("ownerAutomationOnly", False)))
	if not self_improvement_only and not project_maintenance_only and not owner_automation_only:
		return plan
	allowed_targets = [
		str(path) for path in list(host_boundary.get("allowed_target_paths", host_boundary.get("allowedTargetPaths", [])) or []) if str(path)
	]
	boundary_name = "self-improvement" if self_improvement_only else ("project-maintenance" if project_maintenance_only else "owner-automation")
	next_plan = dict(plan)
	if not allowed_targets:
		next_plan["allowed"] = False
		next_plan["block_reason"] = f"{boundary_name} boundary resolved no allowed targets"
		next_plan["matches"] = []
		next_plan["existing_targets"] = []
		next_plan["proposed_files"] = []
		next_plan["new_files"] = []
		next_plan["steps"] = []
		return next_plan
	next_plan["matches"] = [path for path in list(plan.get("matches") or []) if _matches_allowed_target(str(path), allowed_targets)]
	next_plan["existing_targets"] = [path for path in list(plan.get("existing_targets") or []) if _matches_allowed_target(str(path), allowed_targets)]
	next_plan["proposed_files"] = [path for path in list(plan.get("proposed_files") or []) if _matches_allowed_target(str(path), allowed_targets)]
	next_plan["new_files"] = [
		item for item in list(plan.get("new_files") or [])
		if isinstance(item, dict) and _matches_allowed_target(str(item.get("path") or ""), allowed_targets)
	]
	next_plan["steps"] = [
		step for step in list(plan.get("steps") or [])
		if str(step.get("action") or "") == "scaffold" or _matches_allowed_target(str(step.get("path") or ""), allowed_targets)
	]
	if not next_plan["existing_targets"] and not next_plan["proposed_files"] and not next_plan["new_files"]:
		next_plan["allowed"] = False
		next_plan["block_reason"] = f"{boundary_name} boundary removed all out-of-scope targets"
	return next_plan


def _proposed_files(adapter: RepoAdapter, metadata: TicketMetadata, strategy_name: str, matches: list[str]) -> tuple[list[str], list[dict[str, str]]]:
	proposed: list[str] = []
	if strategy_name == "qa_e2e":
		proposed.extend(["frontend/**/cypress.config.*", "frontend/**/cypress/e2e/**/*", "package.json", ".github/workflows/**/*.yml"])
	elif strategy_name == "backend_api":
		proposed.extend(["backend/app/models/*.py", "backend/app/api/routes/*.py"])
	for suggestion in adapter.suggest_target_files(metadata, limit=12):
		if suggestion not in proposed:
			proposed.append(suggestion)

	if not proposed:
		proposed = matches[:5]

	new_files = [{"path": path, "reason": "adapter suggestion"} for path in proposed if "*" not in path]
	return proposed, new_files


def _apply_strategy_guard(audit_result: dict[str, Any], proposed: list[str], final_files: list[str] | None = None) -> tuple[bool, str]:
	strategy = get_strategy(audit_result.get("strategy", "mixed"))
	for pattern in strategy.anti_patterns:
		for path in (proposed + (final_files or [])):
			if pattern.search(path):
				return False, f"Strategy mismatch: {audit_result.get('strategy')} ticket should not touch {path}"
	return True, ""


def generate_plan(
	adapter: RepoAdapter,
	audit_result: dict[str, Any],
	mode: str = "integrate",
	*,
	provider: Any = None,
	project_root: Path | None = None,
	ignore_dirs: set[str] | None = None,
	final_files: list[str] | None = None,
	editor_context: dict[str, Any] | None = None,
	runtime_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
	metadata = _metadata_from_audit(adapter, audit_result)
	strategy_name = audit_result.get("strategy", "mixed")
	root = project_root or getattr(adapter, "project_root", Path.cwd())

	matches = _scan_matches(root, strategy_name, ignore_dirs=ignore_dirs)
	if not matches:
		matches = _fallback_matches(root, ignore_dirs=ignore_dirs)

	normalized_editor_context = normalize_editor_context(editor_context)
	existing_targets = _rank_existing_targets(
		matches,
		project_root=root,
		editor_context=normalized_editor_context,
		query=audit_result.get("desc", ""),
	)
	strategy_patterns = summarize_strategy_patterns(
		root,
		strategy=strategy_name,
		active_file_path=str(normalized_editor_context.get("active_file_path") or ""),
	)
	existing_targets = _prioritize_memory_targets(existing_targets, list(strategy_patterns.get("preferred_files", []) or []))
	if strategy_name == "mixed" and audit_result.get("reason") == "no tag/keyword match":
		matches = []
		existing_targets = []

	proposed_files, new_files = _proposed_files(adapter, metadata, strategy_name, matches)
	confidence = "high" if existing_targets else "low"
	if not existing_targets and strategy_patterns.get("success_count"):
		confidence = "medium"
	if strategy_patterns.get("recurring_blockers"):
		confidence = "medium" if confidence == "high" else "low"
	elif strategy_patterns.get("confidence_boost") and confidence == "low":
		confidence = "medium"
	audit_confidence = str(audit_result.get("confidence") or "").strip().lower()
	if audit_confidence:
		confidence = _merge_confidence_levels(confidence, audit_confidence)
	allowed, block_reason = _apply_strategy_guard(audit_result, proposed_files, final_files=final_files)
	steps: list[dict[str, Any]] = []
	if mode == "scaffold":
		steps.append({"action": "scaffold", "ticket": audit_result["ticket"], "reason": "scaffold mode", "allow_slug": True})
	elif existing_targets:
		for match in existing_targets[:3]:
			steps.append({"action": "modify_file", "path": match, "reason": "update related file"})
	else:
		steps.append({"action": "scaffold", "ticket": audit_result["ticket"], "reason": "initial scaffold", "allow_slug": True})
	if mode == "scaffold" or not existing_targets:
		for new_file in new_files:
			steps.append({"action": "create_file", "path": new_file.get("path"), "reason": new_file.get("reason", "proposed new file")})
	if "npm" in audit_result.get("reason", ""):
		steps.append({"action": "install_dependency", "name": "npm"})

	model_summary = ""
	if provider is not None:
		try:
			model_summary = provider.summarize(
				build_coding_task_prompt(
					f"Summarize the best repository-grounded implementation approach for BAT<{audit_result.get('ticket')}>.",
					editor_context=normalize_editor_context(editor_context),
					approved_targets=existing_targets or proposed_files,
					extra_context={
						"Strategy": strategy_name,
						"Reason": audit_result.get("reason", ""),
						"Proposed files": proposed_files,
						"Planned steps": steps,
					},
					response_contract=(
						"Summarize in concise actionable bullets.",
						"Prioritize the most likely files to touch first.",
					),
					heading="Planning summary request",
				)
			)
		except Exception:
			model_summary = ""

	plan = {
		"ticket": audit_result["ticket"],
		"strategy": strategy_name,
		"mode": mode,
		"proposed_files": proposed_files,
		"matches": matches,
		"existing_targets": existing_targets,
		"new_files": new_files,
		"confidence": confidence,
		"allowed": allowed,
		"block_reason": block_reason,
		"steps": steps,
		"validation": audit_result.get("validation", []),
		"editor_context": normalized_editor_context,
		"runtime_context": dict(runtime_context or {}),
		"memory_hints": {
			"strategy_patterns": strategy_patterns,
			"audit_strategy_memory": dict(audit_result.get("strategy_memory_hints") or {}),
		},
		"model_summary": model_summary,
	}
	return _apply_bounded_target_boundary(plan, runtime_context=runtime_context)
