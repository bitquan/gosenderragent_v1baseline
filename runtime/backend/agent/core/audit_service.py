from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import Any, Callable

from backend.agent.core.adapters.base import RepoAdapter, TicketMetadata
from backend.agent.core.memory_service import rank_strategy_candidates, summarize_strategy_patterns
from backend.agent.core.storage_paths import assistant_dev_runs_dir


def compute_risk(project_root: Path, desc: str, ticket: str | None = None) -> str:
    """Estimate risk using keywords and prior run artifacts."""
    txt = desc.upper()
    high = ["AUTH", "PAYMENT", "MIGRATION", "SECURITY", "LIFECYCLE", "WALLET"]
    medium = ["API", "DATABASE", "SERVICE"]
    if any(token in txt for token in high):
        base = "high"
    elif any(token in txt for token in medium):
        base = "medium"
    else:
        base = "low"

    if ticket:
        runs = assistant_dev_runs_dir(project_root)
        if runs.exists():
            for artifact in runs.glob(f"*{ticket}.json"):
                try:
                    data = json.loads(artifact.read_text(encoding="utf-8"))
                except Exception:
                    continue
                if not data.get("audit", {}).get("allowed", True):
                    return "high"
                if data.get("mode") == "execute" and not all(result.get("ok") for result in data.get("validation", [])):
                    return "medium"
    return base


def _derive_strategy(metadata: TicketMetadata) -> str:
    if metadata.is_backend:
        return "backend_api"
    if metadata.is_fe:
        return "frontend_feature"
    if metadata.domain in {"docs", "documentation"}:
        return "docs"
    return "mixed"


def _normalize_validation(commands: list[list[str]]) -> list[str]:
    return [shlex.join(command) for command in commands if command]


def _build_status_map(adapter: RepoAdapter) -> dict[str, str]:
    status_map: dict[str, str] = {}
    for ticket_id, ticket_desc in adapter.load_tickets().items():
        metadata = adapter.parse_ticket_metadata(ticket_id, ticket_desc)
        status_map[ticket_id] = metadata.status
    return status_map


def _candidate_strategies(metadata: TicketMetadata, *, current_strategy: str, derived_strategy: str) -> list[str]:
    candidates: list[str] = [current_strategy, derived_strategy, "mixed"]
    if metadata.is_backend:
        candidates.append("backend_api")
    if metadata.is_fe:
        candidates.append("frontend_feature")
    if metadata.domain in {"docs", "documentation"}:
        candidates.append("docs")
    if any(tag in {"OPS", "CI"} for tag in list(metadata.tags or [])):
        candidates.append("ops_ci")
    return [str(item) for item in candidates if str(item)]


def _confidence_from_strategy_memory(current_strategy: str, ranking: list[dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    current = next((item for item in ranking if str(item.get("strategy") or "") == current_strategy), None)
    if current is None:
        return "low", {}
    blockers = list(current.get("recurring_blockers", []) or [])
    success_count = int(current.get("success_count", 0))
    failure_count = int(current.get("failure_count", 0))
    confidence = "low"
    if success_count >= 2 and not blockers:
        confidence = "high"
    elif success_count >= 1:
        confidence = "medium"
    if blockers or failure_count > success_count:
        confidence = "medium" if success_count > failure_count else "low"
    return confidence, dict(current)


def _apply_strategy_memory(
    *,
    project_root: Path,
    metadata: TicketMetadata,
    current_strategy: str,
    reason: str,
) -> tuple[str, str, str, dict[str, Any]]:
    candidates = _candidate_strategies(metadata, current_strategy=current_strategy, derived_strategy=_derive_strategy(metadata))
    ranking = rank_strategy_candidates(project_root, candidates)
    confidence, current_summary = _confidence_from_strategy_memory(current_strategy, ranking)
    top = ranking[0] if ranking else {}
    chosen_strategy = current_strategy
    override_applied = False
    if current_strategy == "mixed" and top and str(top.get("strategy") or "") != "mixed":
        if int(top.get("success_count", 0)) >= 1 and float(top.get("score", 0.0)) > 0.0:
            chosen_strategy = str(top.get("strategy") or current_strategy)
            reason = f"{reason}; strategy memory preferred {chosen_strategy}"
            override_applied = True
            confidence, current_summary = _confidence_from_strategy_memory(chosen_strategy, ranking)
    memory_hints = {
        "override_applied": override_applied,
        "chosen_strategy": chosen_strategy,
        "current_strategy": current_strategy,
        "ranking": ranking,
        "current_strategy_summary": current_summary or summarize_strategy_patterns(project_root, strategy=current_strategy),
        "top_strategy_summary": dict(top),
        "escalate_on_blockers": bool((current_summary or {}).get("recurring_blockers")) and str((current_summary or {}).get("recommended_response") or "") == "self_heal",
    }
    return chosen_strategy, reason, confidence, memory_hints


def _initial_result(
    *,
    ticket_id: str,
    desc: str,
    strategy: str,
    reason: str,
    metadata: TicketMetadata,
    risk: str,
    validation: list[str],
) -> dict[str, Any]:
    return {
        "ticket": ticket_id,
        "strategy": strategy,
        "reason": reason,
        "status": metadata.status,
        "metadata": metadata,
        "proposed_files": [],
        "matches": [],
        "existing_targets": [],
        "new_files": [],
        "confidence": "low",
        "validation": validation,
        "allowed": True,
        "block_reason": "",
        "risk": risk,
        "desc": desc,
        "strategy_memory_hints": {},
    }


def audit_ticket(
    adapter: RepoAdapter,
    ticket_id: str,
    desc: str,
    final_files: list[str] | None = None,
    *,
    project_root: Path | None = None,
    classify_ticket: Callable[[str], tuple[str, str]] | None = None,
    get_strategy: Callable[[str], Any] | None = None,
) -> dict[str, Any]:
    del final_files  # reserved for compatibility with legacy callers

    if not desc:
        desc = adapter.load_tickets().get(ticket_id, "")

    metadata = adapter.parse_ticket_metadata(ticket_id, desc)
    derived_strategy = _derive_strategy(metadata)
    strategy = derived_strategy
    reason = f"derived from adapter domain {metadata.domain}"
    if classify_ticket is not None:
        strategy, reason = classify_ticket(desc)
    if get_strategy is not None:
        get_strategy(strategy)

    root = project_root or getattr(adapter, "project_root", Path.cwd())
    strategy, reason, confidence, strategy_memory_hints = _apply_strategy_memory(
        project_root=root,
        metadata=metadata,
        current_strategy=strategy,
        reason=reason,
    )
    risk = compute_risk(root, desc, ticket_id)
    validation = _normalize_validation(adapter.validation_commands(metadata, full_verify=False))
    result = _initial_result(
        ticket_id=ticket_id,
        desc=desc,
        strategy=strategy,
        reason=reason,
        metadata=metadata,
        risk=risk,
        validation=validation,
    )
    result["confidence"] = confidence
    result["strategy_memory_hints"] = strategy_memory_hints

    if metadata.status in {"DONE", "BLOCKED"}:
        result["allowed"] = False
        result["block_reason"] = f"status is {metadata.status}"
        return result

    if not adapter.is_ticket_actionable(metadata):
        result["allowed"] = False
        result["block_reason"] = "no actionable status tag"
        return result

    status_map = _build_status_map(adapter)
    completed: set[str] = set()
    try:
        from backend.agent.core.state_service import load_state

        completed = set(load_state(root).get("completed", []))
    except Exception:
        completed = set()
    for tag in metadata.tags:
        if not tag.startswith("DEP:"):
            continue
        dep = tag.split(":", 1)[1]
        if dep in completed:
            continue
        dep_status = status_map.get(dep)
        if dep_status is None:
            result["allowed"] = False
            result["block_reason"] = f"blocked by dependency {dep} (missing)"
            return result
        if dep_status != "DONE":
            result["allowed"] = False
            result["block_reason"] = f"blocked by dependency {dep} status {dep_status}"
            return result

    return result