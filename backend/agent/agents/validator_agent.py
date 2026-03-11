from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.agent.core.validation_service import build_validation_plan, run_validation_plan


@dataclass
class ValidatorAgent:
    name: str = "validator"

    def run(
        self,
        adapter,
        ticket_id: str,
        audit_result: dict[str, Any],
        plan: dict[str, Any],
        *,
        project_root: Path | None = None,
        should_validate: bool = False,
    ) -> dict[str, Any]:
        if not should_validate:
            return {
                "agent": self.name,
                "ok": True,
                "validation": {"results": [], "ok": True, "commands": [], "scope": [], "related_targets": []},
            }
        root = project_root or getattr(adapter, "project_root", Path.cwd())
        validation_plan = build_validation_plan(adapter, ticket_id, audit_result, plan)
        validation = run_validation_plan(validation_plan, project_root=root)
        return {
            "agent": self.name,
            "ok": bool(validation.get("ok", True)),
            "validation": validation,
        }
