#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.agent.core.storage_paths import (
    assistant_desktop_build_dir,
    assistant_dev_runs_dir,
    assistant_history_path,
    assistant_memory_path,
    assistant_notification_log_path,
    assistant_repo_index_path,
    assistant_runs_dir,
    assistant_sandbox_dir,
)
REPORT_NAME = "assistant_offload_migration_report.json"


def _path_size_bytes(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_file():
        try:
            return path.stat().st_size
        except OSError:
            return 0
    total = 0
    for child in path.rglob("*"):
        if child.is_file():
            try:
                total += child.stat().st_size
            except OSError:
                continue
    return total


def _format_bytes(size: int) -> str:
    value = float(max(0, size))
    units = ["B", "KB", "MB", "GB", "TB"]
    for unit in units:
        if value < 1024.0 or unit == units[-1]:
            return f"{value:.1f}{unit}"
        value /= 1024.0
    return f"{size}B"


def _legacy_internal_paths(project_root: Path) -> list[dict[str, Any]]:
    return [
        {
            "label": "assistant runs",
            "source": project_root / "docs" / "assistant_runs",
            "target": assistant_runs_dir(project_root),
            "kind": "dir",
        },
        {
            "label": "assistant sandboxes",
            "source": project_root / ".assistant_sandboxes",
            "target": assistant_sandbox_dir(project_root),
            "kind": "dir",
        },
        {
            "label": "assistant dev runs",
            "source": project_root / ".dev_agent_runs",
            "target": assistant_dev_runs_dir(project_root),
            "kind": "dir",
        },
        {
            "label": "assistant memory",
            "source": project_root / "dev_assistant_memory.json",
            "target": assistant_memory_path(project_root),
            "kind": "file",
        },
        {
            "label": "assistant repo index",
            "source": project_root / "repo_index.json",
            "target": assistant_repo_index_path(project_root),
            "kind": "file",
        },
        {
            "label": "assistant notifications",
            "source": project_root / "notifications.log",
            "target": assistant_notification_log_path(project_root),
            "kind": "file",
        },
        {
            "label": "assistant chat history",
            "source": project_root / ".dev_assistant_history.jsonl",
            "target": assistant_history_path(project_root),
            "kind": "file",
        },
        {
            "label": "desktop build output",
            "source": project_root / "tools" / "gosenderr-desktop-agent" / "dist",
            "target": assistant_desktop_build_dir(project_root),
            "kind": "dir",
        },
    ]


def build_migration_plan(project_root: Path) -> list[dict[str, Any]]:
    plan: list[dict[str, Any]] = []
    for item in _legacy_internal_paths(project_root):
        source = Path(item["source"]).resolve()
        target = Path(item["target"]).resolve()
        exists = source.exists()
        same_path = source == target
        size_bytes = _path_size_bytes(source) if exists and not same_path else 0
        plan.append(
            {
                "label": item["label"],
                "source": str(source),
                "target": str(target),
                "kind": item["kind"],
                "exists": exists,
                "same_path": same_path,
                "size_bytes": size_bytes,
                "size_human": _format_bytes(size_bytes),
                "actionable": exists and not same_path,
            }
        )
    return plan


def _copy_item(source: Path, target: Path, kind: str) -> None:
    if kind == "dir":
        target.mkdir(parents=True, exist_ok=True)
        for child in source.iterdir():
            dest = target / child.name
            if child.is_dir():
                shutil.copytree(child, dest, dirs_exist_ok=True)
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(child, dest)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def _prune_item(source: Path, kind: str) -> None:
    if kind == "dir":
        shutil.rmtree(source, ignore_errors=True)
        return
    source.unlink(missing_ok=True)


def apply_migration(project_root: Path, *, prune: bool = False) -> dict[str, Any]:
    plan = build_migration_plan(project_root)
    moved: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    for item in plan:
        source = Path(item["source"])
        target = Path(item["target"])
        if not item["actionable"]:
            skipped.append(item)
            continue
        _copy_item(source, target, item["kind"])
        if prune:
            _prune_item(source, item["kind"])
        moved.append(
            {
                **item,
                "pruned": prune,
                "target_exists": target.exists(),
                "source_exists_after": source.exists(),
            }
        )

    report = {
        "ok": True,
        "project_root": str(project_root),
        "moved": moved,
        "skipped": skipped,
        "prune": prune,
        "total_bytes_moved": sum(int(item.get("size_bytes") or 0) for item in moved),
    }
    report_path = assistant_runs_dir(project_root) / REPORT_NAME
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    report["report_path"] = str(report_path)
    return report


def _print_human_report(plan: list[dict[str, Any]], *, applied: dict[str, Any] | None = None) -> None:
    actionable = [item for item in plan if item["actionable"]]
    print("Assistant offload migration plan")
    print(f"- actionable items: {len(actionable)}")
    print(f"- bytes eligible: {_format_bytes(sum(int(item['size_bytes']) for item in actionable))}")
    for item in plan:
        state = "move" if item["actionable"] else ("same" if item["same_path"] else "skip")
        print(f"- [{state}] {item['label']}: {item['source']} -> {item['target']} ({item['size_human']})")
    if applied is not None:
        print("")
        print(f"Applied migration. moved={len(applied['moved'])} pruned={applied['prune']}")
        print(f"Report: {applied['report_path']}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate old internal assistant artifacts to the configured external offload paths.")
    parser.add_argument("--project-root", default=str(REPO_ROOT), help="Repo root to inspect.")
    parser.add_argument("--apply", action="store_true", help="Copy files/directories to the configured offload paths.")
    parser.add_argument("--prune", action="store_true", help="Remove old internal files/directories after copy succeeds.")
    parser.add_argument("--json", action="store_true", help="Print JSON instead of human-readable output.")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    plan = build_migration_plan(project_root)
    applied = apply_migration(project_root, prune=args.prune) if args.apply else None

    if args.json:
        payload = {"plan": plan, "applied": applied}
        print(json.dumps(payload, indent=2))
        return
    _print_human_report(plan, applied=applied)


if __name__ == "__main__":
    main()