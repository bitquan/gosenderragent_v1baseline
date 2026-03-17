from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.agent.core.storage_paths import assistant_log_path


def log_path(project_root: Path) -> Path:
    return assistant_log_path(project_root)


def _legacy_log_paths(project_root: Path) -> list[Path]:
    canonical = log_path(project_root)
    candidates = [
        project_root / "backend" / "scripts" / "dev_assistant.log",
        project_root / "dev_assistant.log",
    ]
    legacy: list[Path] = []
    for candidate in candidates:
        if candidate == canonical or candidate in legacy:
            continue
        legacy.append(candidate)
    return legacy


def build_run_log_entry(
    *,
    ticket: str,
    desc: str,
    run_mode: str,
    schedule: str | None,
    ai: bool,
    write: bool,
    git: bool,
    interactive: bool,
    brainstorm: bool,
    brainstorm_notes: bool,
    template: str | None,
    created: list[str],
    diff: str,
    embedding: list[float] | None = None,
) -> dict[str, Any]:
    entry = {
        "ticket": ticket,
        "desc": desc,
        "run_mode": run_mode,
        "schedule": schedule,
        "ai": ai,
        "write": write,
        "git": git,
        "interactive": interactive,
        "brainstorm": brainstorm,
        "brainstorm_notes": brainstorm_notes,
        "template": template,
        "created_count": len(created),
        "created": created,
        "diff": diff,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if embedding is not None:
        entry["embedding"] = embedding
    return entry


def append_run_log(project_root: Path, entry: dict[str, Any]) -> Path:
    path = log_path(project_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry) + "\n")
    for legacy in _legacy_log_paths(project_root):
        try:
            legacy.parent.mkdir(parents=True, exist_ok=True)
            with open(legacy, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry) + "\n")
        except Exception:
            continue
    return path


def tail_run_log(project_root: Path, limit: int = 20) -> list[str]:
    for path in [log_path(project_root), *_legacy_log_paths(project_root)]:
        if not path.exists():
            continue
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except Exception:
            continue
        return lines[-limit:]
    return []