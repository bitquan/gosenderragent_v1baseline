from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.agent.core.repair_service import attempt_repair


@dataclass
class RepairAgent:
    name: str = "repair"

    def run(
        self,
        adapter,
        plan: dict[str, Any],
        validation: dict[str, Any],
        *,
        provider: Any = None,
        project_root: Path | None = None,
        should_repair: bool = False,
        max_retries: int = 3,
        editor_context: dict[str, Any] | None = None,
        runtime_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not should_repair or validation.get("ok", True):
            return {
                "agent": self.name,
                "ok": True,
                "repair": {"repairs": [], "ok": True},
            }
        root = project_root or getattr(adapter, "project_root", Path.cwd())
        repair = attempt_repair(
            adapter,
            plan,
            validation,
            provider=provider,
            max_retries=max_retries,
            project_root=root,
            editor_context=editor_context,
            runtime_context=runtime_context,
        )
        return {
            "agent": self.name,
            "ok": bool(repair.get("ok", False)),
            "repair": repair,
        }
