from __future__ import annotations

from pathlib import Path
from typing import Any

from backend.agent.core.adapters.base import RepoAdapter, TicketMetadata
from backend.agent.core.editor_context import format_editor_context_for_prompt, normalize_editor_context
from backend.agent.core.repo_inspection import is_ignored
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


def _rank_existing_targets(matches: list[str]) -> list[str]:
    scores: dict[str, int] = {}
    for match in matches:
        lower = match.lower()
        scores[match] = sum(1 for keyword in DOMAIN_KEYWORDS if keyword in lower)
    return [match for match, score in sorted(scores.items(), key=lambda item: item[1], reverse=True) if score > 0][:5]


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
) -> dict[str, Any]:
    metadata = _metadata_from_audit(adapter, audit_result)
    strategy_name = audit_result.get("strategy", "mixed")
    root = project_root or getattr(adapter, "project_root", Path.cwd())

    matches = _scan_matches(root, strategy_name, ignore_dirs=ignore_dirs)
    if not matches:
        matches = _fallback_matches(root, ignore_dirs=ignore_dirs)

    existing_targets = _rank_existing_targets(matches)
    if strategy_name == "mixed" and audit_result.get("reason") == "no tag/keyword match":
        matches = []
        existing_targets = []

    proposed_files, new_files = _proposed_files(adapter, metadata, strategy_name, matches)
    confidence = "high" if existing_targets else "low"
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
            editor_prompt = format_editor_context_for_prompt(
                normalize_editor_context(editor_context),
                include_fields=(
                    "active_file_path",
                    "selection_start_line",
                    "selection_end_line",
                    "selected_text",
                    "surrounding_snippet",
                    "diagnostics",
                ),
                heading="Relevant editor context",
                max_chars=900,
            )
            model_summary = provider.summarize(
                f"Ticket: {audit_result.get('ticket')}\n"
                f"Strategy: {strategy_name}\n"
                f"Reason: {audit_result.get('reason', '')}\n"
                f"Existing targets: {existing_targets}\n"
                f"Proposed files: {proposed_files}\n"
                f"Steps: {steps}"
                + (f"\n{editor_prompt}" if editor_prompt else "")
            )
        except Exception:
            model_summary = ""

    return {
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
        "editor_context": normalize_editor_context(editor_context),
        "model_summary": model_summary,
    }