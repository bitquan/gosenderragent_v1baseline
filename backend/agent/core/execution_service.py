from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, Callable

from backend.agent.core.adapters.base import RepoAdapter
from backend.agent.core.editor_context import format_editor_context_for_prompt, normalize_editor_context


def _approved_targets(plan: dict[str, Any], audit_result: dict[str, Any] | None = None) -> set[str]:
    approved: set[str] = set()
    for key in ("existing_targets", "proposed_files"):
        for path in plan.get(key, []) or []:
            if isinstance(path, str) and "*" not in path:
                approved.add(path)
    for item in plan.get("new_files", []) or []:
        path = item.get("path") if isinstance(item, dict) else None
        if path:
            approved.add(path)
    if audit_result:
        for key in ("existing_targets", "proposed_files"):
            for path in audit_result.get(key, []) or []:
                if isinstance(path, str) and "*" not in path:
                    approved.add(path)
        for item in audit_result.get("new_files", []) or []:
            path = item.get("path") if isinstance(item, dict) else None
            if path:
                approved.add(path)
    return approved


def _path_allowed(path: str, approved: set[str]) -> bool:
    if not path:
        return False
    if not approved:
        return True
    return path in approved


def _build_step_prompt(plan: dict[str, Any], step: dict[str, Any], approved: set[str], editor_context: dict[str, Any] | None = None) -> str:
    editor_prompt = format_editor_context_for_prompt(
        normalize_editor_context(editor_context),
        include_fields=(
            "active_file_path",
            "selection_start_line",
            "selection_end_line",
            "selected_text",
            "surrounding_snippet",
            "current_file_diff",
        ),
        heading="Relevant editor context",
        max_chars=900,
    )
    return (
        f"Ticket: {plan.get('ticket')}\n"
        f"Strategy: {plan.get('strategy', '')}\n"
        f"Approved targets: {sorted(approved)}\n"
        f"Step: {step}\n"
        "Produce a minimal safe code patch or code snippet for this approved step."
        + (f"\n{editor_prompt}" if editor_prompt else "")
    )


def _provider_patch(provider: Any, plan: dict[str, Any], step: dict[str, Any], approved: set[str], editor_context: dict[str, Any] | None = None) -> str:
    if provider is None:
        return ""
    try:
        return str(provider.propose_patch(_build_step_prompt(plan, step, approved, editor_context)) or "").strip()
    except Exception:
        return ""


def _provider_summary(provider: Any, plan: dict[str, Any], results: list[dict[str, Any]]) -> str:
    if provider is None:
        return ""
    try:
        return str(
            provider.summarize(
                f"Ticket: {plan.get('ticket')}\n"
                f"Strategy: {plan.get('strategy', '')}\n"
                f"Execution results: {results}"
            )
            or ""
        ).strip()
    except Exception:
        return ""


def execute_plan(
    adapter: RepoAdapter,
    plan: dict[str, Any],
    *,
    provider: Any = None,
    sandbox: Any = None,
    allow_write: bool = False,
    project_root: Path | None = None,
    audit_result: dict[str, Any] | None = None,
    scaffold_fn: Callable[..., list[str]] | None = None,
    repo_search_fn: Callable[[str], list[str]] | None = None,
    editor_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    del adapter, sandbox
    root = project_root or Path.cwd()
    approved = _approved_targets(plan, audit_result)
    results: list[dict[str, Any]] = []
    touched_files: list[str] = []

    for step in plan.get("steps", []):
        action = step.get("action")
        if action == "scaffold":
            created: list[str] = []
            if scaffold_fn is not None:
                created = scaffold_fn(step.get("ticket"), allow_slug=step.get("allow_slug", True)) or []
            step_result = {"step": step, "ok": bool(created) or scaffold_fn is not None, "created": created}
            summary = _provider_summary(provider, plan, [step_result])
            if summary:
                step_result["ai_summary"] = summary
            results.append(step_result)
            touched_files.extend(created)
            continue

        if action in {"create_file", "modify_file", "append_file"}:
            path = step.get("path") or ""
            if not _path_allowed(path, approved):
                results.append({"step": step, "ok": False, "error": "path not approved"})
                continue
            target = root / path
            ai_patch = _provider_patch(provider, plan, step, approved, editor_context)
            if not allow_write:
                step_result = {"step": step, "ok": True, "skipped": True, "path": path}
                if ai_patch:
                    step_result["ai_patch"] = ai_patch
                results.append(step_result)
                continue
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                if action == "create_file":
                    if not target.exists():
                        content = ai_patch or f"# created by plan for {plan.get('ticket')}\n"
                        if not content.endswith("\n"):
                            content += "\n"
                        target.write_text(content, encoding="utf-8")
                elif action == "modify_file":
                    if target.exists():
                        with open(target, "a", encoding="utf-8") as handle:
                            patch_text = ai_patch or "# modification from plan"
                            if not patch_text.startswith("\n"):
                                patch_text = "\n" + patch_text
                            if not patch_text.endswith("\n"):
                                patch_text += "\n"
                            handle.write(patch_text)
                elif action == "append_file":
                    with open(target, "a", encoding="utf-8") as handle:
                        content = ai_patch or step.get("content", "")
                        handle.write(content)
                step_result = {"step": step, "ok": True, "path": path}
                if ai_patch:
                    step_result["ai_patch"] = ai_patch
                results.append(step_result)
                touched_files.append(path)
            except Exception as exc:
                results.append({"step": step, "ok": False, "error": str(exc), "path": path})
            continue

        if action == "run_command":
            cmd = step.get("cmd")
            proc = subprocess.run(cmd, shell=True, cwd=str(root), text=True, capture_output=True)
            results.append({
                "step": step,
                "ok": proc.returncode == 0,
                "stdout": proc.stdout,
                "stderr": proc.stderr,
                "returncode": proc.returncode,
            })
            continue

        if action == "search_repo":
            pattern = step.get("pattern", "")
            found = repo_search_fn(pattern) if repo_search_fn is not None else []
            results.append({"step": step, "ok": True, "result": found})
            continue

        if action == "install_dependency":
            results.append({"step": step, "ok": True, "skipped": True})
            continue

        results.append({"step": step, "ok": False, "error": "unknown action"})

    return {
        "ticket": plan.get("ticket"),
        "ok": all(result.get("ok", False) for result in results if "ok" in result) if results else True,
        "results": results,
        "created": touched_files,
        "approved_targets": sorted(approved),
        "execution_summary": _provider_summary(provider, plan, results),
    }