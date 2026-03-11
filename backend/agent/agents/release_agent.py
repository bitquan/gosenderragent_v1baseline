from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.agent.core.artifact_service import write_human_summary, write_run_artifact
from backend.agent.core.dashboard_service import update_dashboard


def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _json_safe(val) for key, val in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    if hasattr(value, "__dict__"):
        return _json_safe(vars(value))
    return value


@dataclass
class ReleaseAgent:
    name: str = "release"

    def run(
        self,
        ticket_id: str,
        *,
        audit: dict[str, Any],
        plan: dict[str, Any],
        execution: dict[str, Any],
        validation: dict[str, Any],
        repair: dict[str, Any],
        project_root: Path,
        mode: str,
        branch: str | None = None,
        provider: Any = None,
    ) -> dict[str, Any]:
        timestamp = datetime.now(timezone.utc).isoformat()
        release_notes = ""
        if provider is not None:
            try:
                release_notes = provider.summarize(
                    f"Ticket: {ticket_id}\n"
                    f"Mode: {mode}\n"
                    f"Audit: {audit}\n"
                    f"Plan: {plan}\n"
                    f"Execution: {execution}\n"
                    f"Validation: {validation}\n"
                    f"Repair: {repair}"
                )
            except Exception:
                release_notes = ""
        payload = _json_safe({
            "timestamp": timestamp,
            "ticket": ticket_id,
            "mode": mode,
            "strategy": audit.get("strategy"),
            "audit": audit,
            "plan": plan,
            "branch": branch,
            "results": execution.get("results", []),
            "validation": validation.get("results", []),
            "repair": repair.get("repairs", []),
            "release_notes": release_notes,
            "commit_message": f"agent: {mode} BAT<{ticket_id}>" if ticket_id else "agent: runtime release",
        })
        artifact = write_run_artifact(project_root, payload)
        summary = write_human_summary(project_root, payload)
        update_dashboard(project_root, {"timestamp": timestamp, "ticket": ticket_id, "mode": mode, "strategy": audit.get("strategy"), "branch": branch})
        return {
            "agent": self.name,
            "ok": True,
            "artifacts": {
                "run_artifact": str(artifact) if artifact else None,
                "human_summary": str(summary) if summary else None,
                "release_notes": release_notes,
                "commit_message": payload["commit_message"],
            },
        }
