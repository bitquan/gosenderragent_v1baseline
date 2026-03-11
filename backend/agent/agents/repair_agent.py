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
        editor_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not should_repair or validation.get("ok", True):
            return {
                "agent": self.name,
                "ok": True,
                "repair": {"repairs": [], "ok": True},
            }
        root = project_root or getattr(adapter, "project_root", Path.cwd())
        repair = attempt_repair(adapter, plan, validation, provider=provider, project_root=root, editor_context=editor_context)
        return {
            "agent": self.name,
            "ok": bool(repair.get("ok", False)),
            "repair": repair,
        }
