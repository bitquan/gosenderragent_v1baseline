from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from backend.agent.core.execution_service import execute_plan


@dataclass
class ImplementerAgent:
    name: str = "implementer"

    def run(
        self,
        adapter,
        plan: dict[str, Any],
        *,
        provider: Any = None,
        allow_write: bool = False,
        should_execute: bool = False,
        project_root: Path | None = None,
        audit_result: dict[str, Any] | None = None,
        scaffold_fn: Callable[..., list[str]] | None = None,
        ensure_branch_fn: Callable[[str, str], str | None] | None = None,
        editor_context: dict[str, Any] | None = None,
        runtime_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        root = project_root or getattr(adapter, "project_root", Path.cwd())
        branch = None
        if should_execute and ensure_branch_fn is not None:
            branch = ensure_branch_fn(plan.get("ticket", ""), plan.get("strategy", "unknown"))
            
        if should_execute:
            execution = execute_plan(
                adapter,
                plan,
                provider=provider,
                allow_write=allow_write,
                project_root=root,
                audit_result=audit_result,
                scaffold_fn=scaffold_fn,
                editor_context=editor_context,
                runtime_context=runtime_context,
            )
        elif plan.get("ticket") and scaffold_fn is not None:
            created = scaffold_fn(plan.get("ticket"), allow_slug=True) or []
            execution = {"results": [], "created": created, "ok": True}
        else:
            execution = {"results": [], "created": [], "ok": True}
        execution["branch"] = branch
        return {
            "agent": self.name,
            "ok": bool(execution.get("ok", True)),
            "execution": execution,
        }
