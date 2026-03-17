from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.agent.core.validation_service import build_validation_plan, run_validation_plan
from backend.agent.core.runtime_context import extract_runtime_context


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
        provider: Any = None,
        project_root: Path | None = None,
        should_validate: bool = False,
        runtime_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        del provider
        normalized_runtime_context = extract_runtime_context(runtime_context)
        if not should_validate:
            return {
                "agent": self.name,
                "ok": True,
                "validation": {
                    "results": [],
                    "ok": True,
                    "commands": [],
                    "scope": [],
                    "related_targets": [],
                    "runtime_context": normalized_runtime_context,
                },
            }
        root = project_root or getattr(adapter, "project_root", Path.cwd())
        validation_plan = build_validation_plan(
            adapter,
            ticket_id,
            audit_result,
            plan,
            runtime_context=normalized_runtime_context,
        )
        validation = run_validation_plan(validation_plan, project_root=root, runtime_context=normalized_runtime_context)
        return {
            "agent": self.name,
            "ok": bool(validation.get("ok", True)),
            "validation": validation,
        }
