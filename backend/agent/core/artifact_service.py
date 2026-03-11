from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def runs_dir(project_root: Path) -> Path:
    return project_root / ".dev_agent_runs"


def write_run_artifact(project_root: Path, payload: dict[str, Any]) -> Path | None:
    try:
        base = runs_dir(project_root)
        base.mkdir(parents=True, exist_ok=True)
    except Exception:
        return None

    now = datetime.now(timezone.utc)
    timestamp = payload.get("timestamp") or now.isoformat()
    mode = payload.get("mode", "run")
    ticket = payload.get("ticket", "unknown")
    name = f"{now.strftime('%Y%m%dT%H%M%S')}-{mode}-{ticket}.json"
    target = base / name
    try:
        target.write_text(json.dumps({**payload, "timestamp": timestamp}, indent=2), encoding="utf-8")
        return target
    except Exception:
        return None


def write_human_summary(project_root: Path, payload: dict[str, Any]) -> Path | None:
    target_dir = project_root / "docs" / "assistant_runs"
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
    except Exception:
        return None
    ticket = payload.get("ticket", "unknown")
    mode = payload.get("mode", "run")
    now = datetime.now(timezone.utc)
    name = f"{now.strftime('%Y%m%dT%H%M%S')}-{mode}-{ticket}.md"
    target = target_dir / name
    lines = [
        f"# Assistant Run {ticket}",
        "",
        f"- mode: {mode}",
        f"- strategy: {payload.get('strategy', '')}",
        f"- branch: {payload.get('branch', '')}",
    ]
    try:
        target.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return target
    except Exception:
        return None


def append_ci_report(path: str | Path, row: dict[str, Any]) -> None:
    try:
        target = Path(path)
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(row) + "\n")
    except Exception:
        pass