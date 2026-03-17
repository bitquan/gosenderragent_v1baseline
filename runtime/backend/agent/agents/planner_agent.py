from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from backend.agent.core.audit_service import audit_ticket
from backend.agent.core.editor_context import augment_ticket_description
from backend.agent.core.planning_service import generate_plan


@dataclass
class PlannerAgent:
    name: str = "planner"

    def run(
        self,
        adapter,
        ticket_id: str,
        desc: str,
        *,
        provider: Any = None,
        project_root: Path | None = None,
        classify_ticket: Callable[[str], tuple[str, str]] | None = None,
        get_strategy: Callable[[str], Any] | None = None,
        ignore_dirs: set[str] | None = None,
        mode: str = "integrate",
        editor_context: dict[str, Any] | None = None,
        runtime_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        root = project_root or getattr(adapter, "project_root", Path.cwd())
        effective_desc = augment_ticket_description(desc, editor_context)
        audit = audit_ticket(adapter, ticket_id, effective_desc, project_root=root, classify_ticket=classify_ticket, get_strategy=get_strategy)
        audit["desc"] = desc
        plan = {}
        if audit.get("allowed"):
            plan = generate_plan(
                adapter,
                audit,
                mode=mode,
                provider=provider,
                project_root=root,
                ignore_dirs=ignore_dirs,
                editor_context=editor_context,
                runtime_context=runtime_context,
            )
        return {
            "agent": self.name,
            "ok": bool(audit.get("allowed")),
            "audit": audit,
            "plan": plan,
        }
