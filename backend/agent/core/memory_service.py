from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def memory_path(project_root: Path) -> Path:
    return project_root / "dev_assistant_memory.json"


def load_memory(project_root: Path) -> list[dict[str, Any]]:
    path = memory_path(project_root)
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data
        except Exception:
            pass
    return []


def save_memory(project_root: Path, entries: list[dict[str, Any]]) -> None:
    try:
        memory_path(project_root).write_text(json.dumps(entries, indent=2), encoding="utf-8")
    except Exception:
        pass


def record_memory(project_root: Path, ticket: str, strategy: str, files_written: list[str], validation_ok: bool) -> None:
    entries = load_memory(project_root)
    entries.append(
        {
            "ticket": ticket,
            "strategy": strategy,
            "files_written": files_written,
            "validation": "passed" if validation_ok else "failed",
        }
    )
    save_memory(project_root, entries)