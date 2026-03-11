from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def dashboard_path(project_root: Path) -> Path:
    return project_root / ".dev_agent_runs" / "dashboard.json"


def load_dashboard(project_root: Path) -> list[dict[str, Any]]:
    path = dashboard_path(project_root)
    try:
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data
    except Exception:
        pass
    return []


def update_dashboard(project_root: Path, entry: dict[str, Any]) -> None:
    path = dashboard_path(project_root)
    data = load_dashboard(project_root)
    data.append(entry)
    data = data[-100:]
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception:
        pass