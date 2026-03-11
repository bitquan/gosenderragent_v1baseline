from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import Any, Callable

from backend.agent.core.adapters.base import RepoAdapter, TicketMetadata


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
        runs = project_root / ".dev_agent_runs"
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
    strategy = _derive_strategy(metadata)
    reason = f"derived from adapter domain {metadata.domain}"
    if classify_ticket is not None:
        strategy, reason = classify_ticket(desc)
    if get_strategy is not None:
        get_strategy(strategy)

    root = project_root or getattr(adapter, "project_root", Path.cwd())
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

    if metadata.status in {"DONE", "BLOCKED"}:
        result["allowed"] = False
        result["block_reason"] = f"status is {metadata.status}"
        return result

    if not adapter.is_ticket_actionable(metadata):
        result["allowed"] = False
        result["block_reason"] = "no actionable status tag"
        return result

    status_map = _build_status_map(adapter)
    for tag in metadata.tags:
        if not tag.startswith("DEP:"):
            continue
        dep = tag.split(":", 1)[1]
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