from __future__ import annotations

import json
from pathlib import Path
from typing import Any


STATE_FILE = ".dev_assistant_state.json"


def state_path(project_root: Path) -> Path:
    return project_root / STATE_FILE


def load_state(project_root: Path) -> dict[str, Any]:
    path = state_path(project_root)
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"completed": []}


def save_state(project_root: Path, state: dict[str, Any]) -> None:
    try:
        state_path(project_root).write_text(json.dumps(state), encoding="utf-8")
    except Exception:
        pass


def mark_audited(state: dict[str, Any], ticket: str) -> dict[str, Any]:
    audited = list(dict.fromkeys([*state.get("auditedTickets", []), ticket]))
    state["auditedTickets"] = audited
    return state


def mark_completed(state: dict[str, Any], ticket: str) -> dict[str, Any]:
    completed = list(dict.fromkeys([*state.get("completed", []), ticket]))
    state["completed"] = completed
    return state


def record_last_run(state: dict[str, Any], ticket: str, summary: str | None = None) -> dict[str, Any]:
    state["last_run"] = ticket
    if summary is not None:
        state["last_run_summary"] = summary
    return state


def record_last_failure(state: dict[str, Any], ticket: str) -> dict[str, Any]:
    state["lastFailedTicket"] = ticket
    return state


def clear_last_failure(state: dict[str, Any]) -> dict[str, Any]:
    state.pop("lastFailedTicket", None)
    return state