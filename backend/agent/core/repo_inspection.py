from __future__ import annotations

import json
from pathlib import Path


DEFAULT_IGNORE_DIRS = {
    ".venv",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".git",
    "__pycache__",
    "site-packages",
    "backend/create/refresh",
    ".dev_agent_runs",
    "docs/assistant_runs",
}


def is_ignored(path: Path, *, ignore_dirs: set[str] | None = None) -> bool:
    dirs = ignore_dirs or DEFAULT_IGNORE_DIRS
    try:
        parts = path.parts
    except Exception:
        return False
    if str(path).endswith((".pyc", ".pyo")):
        return True
    for part in parts:
        if part in dirs:
            return True
        for banned in dirs:
            if banned in str(path):
                return True
    return False


def repo_search(project_root: Path, pattern: str, *, ignore_dirs: set[str] | None = None) -> list[str]:
    results: list[str] = []
    for path in project_root.glob(pattern):
        rel = path.relative_to(project_root)
        if is_ignored(rel, ignore_dirs=ignore_dirs):
            continue
        results.append(str(rel))
    return results


def iter_repo_files(project_root: Path, *, ignore_dirs: set[str] | None = None) -> list[str]:
    results: list[str] = []
    for path in project_root.rglob("*"):
        rel = path.relative_to(project_root)
        if is_ignored(rel, ignore_dirs=ignore_dirs):
            continue
        results.append(str(rel))
    return results


def build_repo_index(project_root: Path, *, ignore_dirs: set[str] | None = None, output_path: Path | None = None) -> dict[str, list[str]]:
    index: dict[str, list[str]] = {}
    for entry in project_root.iterdir():
        rel = entry.relative_to(project_root)
        if is_ignored(rel, ignore_dirs=ignore_dirs):
            continue
        if entry.is_dir():
            try:
                subs = [
                    path.name
                    for path in entry.iterdir()
                    if path.is_dir() and not is_ignored(path.relative_to(project_root), ignore_dirs=ignore_dirs)
                ]
            except Exception:
                subs = []
            index[entry.name] = subs
    if output_path is not None:
        try:
            output_path.write_text(json.dumps(index, indent=2), encoding="utf-8")
        except Exception:
            pass
    return index