from __future__ import annotations

import shlex
import subprocess
from pathlib import Path
from typing import Any

from backend.agent.core.adapters.base import RepoAdapter
from backend.agent.core.strategies.catalog import get_strategy


def _metadata(adapter: RepoAdapter, audit_result: dict[str, Any]):
    metadata = audit_result.get("metadata")
    if metadata is not None:
        return metadata
    return adapter.parse_ticket_metadata(audit_result.get("ticket", ""), audit_result.get("desc", ""))


def _related_targets(plan: dict[str, Any]) -> list[str]:
    targets: list[str] = []
    for step in plan.get("steps", []):
        path = step.get("path")
        if path and path not in targets:
            targets.append(path)
    for path in plan.get("existing_targets", []) or []:
        if path not in targets:
            targets.append(path)
    return targets


def _targeted_validation_commands(adapter: RepoAdapter, audit_result: dict[str, Any], related: list[str]) -> list[str]:
    metadata = _metadata(adapter, audit_result)
    commands = [shlex.join(cmd) for cmd in adapter.validation_commands(metadata, full_verify=False) if cmd]
    if not related:
        return commands

    if audit_result.get("strategy") == "backend_api":
        backend_tests = [path for path in related if path.startswith("backend/tests/")]
        if backend_tests:
            return [f"cd backend && . .venv/bin/activate && pytest -q {' '.join(path.replace('backend/', '', 1) for path in backend_tests)}"]
    if audit_result.get("strategy") == "frontend_feature":
        frontend_tests = [path for path in related if path.endswith((".test.ts", ".test.tsx"))]
        if frontend_tests:
            return [f"cd frontend && npm run typecheck"]
    return commands


def build_validation_plan(
    adapter: RepoAdapter,
    ticket: str,
    audit_result: dict[str, Any],
    plan: dict[str, Any],
    full_verify: bool = False,
) -> dict[str, Any]:
    metadata = _metadata(adapter, audit_result)
    strategy = get_strategy(audit_result.get("strategy", "mixed"))
    related = _related_targets(plan)

    if full_verify:
        commands = [shlex.join(cmd) for cmd in adapter.validation_commands(metadata, full_verify=True) if cmd]
    elif plan.get("validation"):
        commands = list(plan.get("validation", []))
    else:
        commands = _targeted_validation_commands(adapter, audit_result, related)

    return {
        "ticket": ticket,
        "strategy": audit_result.get("strategy", "mixed"),
        "scope": strategy.validation_scope(metadata),
        "related_targets": related,
        "commands": commands,
        "full_verify": full_verify,
    }


def run_validation_plan(validation_plan: dict[str, Any], *, project_root: Path | None = None) -> dict[str, Any]:
    root = project_root or Path.cwd()
    results: list[dict[str, Any]] = []
    for command in validation_plan.get("commands", []):
        proc = subprocess.run(command, shell=True, cwd=str(root), text=True, capture_output=True)
        results.append({
            "command": command,
            "ok": proc.returncode == 0,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "returncode": proc.returncode,
        })
    return {
        "ticket": validation_plan.get("ticket"),
        "scope": validation_plan.get("scope", []),
        "related_targets": validation_plan.get("related_targets", []),
        "commands": validation_plan.get("commands", []),
        "results": results,
        "ok": all(result.get("ok", False) for result in results) if results else True,
    }