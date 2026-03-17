from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, Callable

from backend.agent.core.adapters.base import RepoAdapter
from backend.agent.core.editor_context import build_coding_task_prompt, normalize_editor_context
from backend.agent.core.memory_service import summarize_success_patterns
from backend.agent.core.patch_review import generate_patch_candidates


MIN_PATCH_SCORE = 0.3


def _summarize_patch_review(selection: dict[str, Any]) -> dict[str, Any] | None:
    best = selection.get("best_candidate") if isinstance(selection, dict) else None
    if not isinstance(best, dict):
        return None
    alternates = [
        {
            "label": item.get("label"),
            "score": item.get("score"),
            "reasons": item.get("reasons", []),
            "preview": item.get("preview", ""),
        }
        for item in list(selection.get("candidates", []))[1:3]
        if isinstance(item, dict)
    ]
    return {
        "selected_label": best.get("label"),
        "selected_score": best.get("score"),
        "selected_reasons": best.get("reasons", []),
        "selected_preview": best.get("preview", ""),
        "candidate_count": len(selection.get("candidates", [])),
        "alternate_candidates": alternates,
    }


def _prompt_variants(plan: dict[str, Any], *, path: str, editor_context: dict[str, Any]) -> list[dict[str, str]]:
    approved_targets = [path]
    return [
        {
            "label": "balanced-execution",
            "prompt": build_coding_task_prompt(
                f"Modify {path} for BAT<{plan.get('ticket')}>.",
                editor_context=editor_context,
                approved_targets=approved_targets,
                extra_context={
                    "Plan": plan,
                    "Target path": path,
                },
                response_contract=(
                    "Return the complete updated contents for the single approved target file.",
                    "Do not include markdown fences.",
                ),
                heading="Execution patch request",
            ),
        },
        {
            "label": "strict-execution",
            "prompt": build_coding_task_prompt(
                f"Edit only {path} for BAT<{plan.get('ticket')}>.",
                editor_context=editor_context,
                approved_targets=approved_targets,
                extra_context={
                    "Plan": plan,
                },
                response_contract=(
                    "Stay within the target file.",
                    "Return only the full updated file contents.",
                ),
                heading="Strict execution patch request",
            ),
        },
    ]


def _write_patch(target: Path, patch_text: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.write_text(str(patch_text or ""), encoding="utf-8")
    else:
        target.write_text(str(patch_text or ""), encoding="utf-8")


def _selection_block_reason(selection: dict[str, Any]) -> str:
    best = selection.get("best_candidate") if isinstance(selection, dict) else None
    if not isinstance(best, dict):
        return "no candidate selected"
    score = float(best.get("score") or 0)
    reasons = [str(item) for item in list(best.get("reasons", []) or []) if str(item)]
    if score < MIN_PATCH_SCORE:
        return f"patch candidate below confidence threshold ({score:.2f})"
    if "references unapproved file paths" in reasons:
        return "patch candidate references unapproved file paths"
    if "placeholder patch" in reasons:
        return "patch candidate is only a placeholder"
    return ""


def execute_plan(
    adapter: RepoAdapter,
    plan: dict[str, Any],
    *,
    provider: Any = None,
    allow_write: bool = False,
    project_root: Path | None = None,
    audit_result: dict[str, Any] | None = None,
    scaffold_fn: Callable[..., list[str]] | None = None,
    repo_search_fn: Callable[[str], Any] | None = None,
    editor_context: dict[str, Any] | None = None,
    runtime_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    del adapter, audit_result
    root = project_root or Path.cwd()
    normalized_editor_context = normalize_editor_context(editor_context)
    results: list[dict[str, Any]] = []
    created: list[str] = []

    for step in list(plan.get("steps", []) or []):
        action = str(step.get("action") or "").strip()
        path = str(step.get("path") or "").strip()

        if action == "scaffold":
            ticket = str(step.get("ticket") or plan.get("ticket") or "").strip()
            generated = list(scaffold_fn(ticket, allow_slug=bool(step.get("allow_slug", True))) or []) if scaffold_fn is not None else []
            created.extend(str(item) for item in generated if str(item).strip())
            results.append({"step": step, "ok": bool(generated), "created": generated})
            continue

        if action == "search_repo":
            pattern = str(step.get("pattern") or "").strip()
            search_result = repo_search_fn(pattern) if repo_search_fn is not None else []
            results.append({"step": step, "ok": True, "result": search_result})
            continue

        if action == "run_command":
            command = step.get("cmd")
            if isinstance(command, list):
                proc = subprocess.run(command, cwd=str(root), text=True, capture_output=True, check=False)
            else:
                proc = subprocess.run(str(command or ""), cwd=str(root), shell=True, text=True, capture_output=True, check=False)
            results.append(
                {
                    "step": step,
                    "ok": proc.returncode == 0,
                    "stdout": proc.stdout,
                    "stderr": proc.stderr,
                    "returncode": proc.returncode,
                }
            )
            continue

        if action not in {"create_file", "modify_file", "append_file"}:
            results.append({"step": step, "ok": False, "error": f"unknown action: {action}"})
            continue

        if not path:
            results.append({"step": step, "ok": False, "error": "path is required"})
            continue

        target = root / path
        result: dict[str, Any] = {"step": step, "path": path, "ok": False}

        if not allow_write:
            result["error"] = "write disabled"
            results.append(result)
            continue

        if action == "append_file":
            target.parent.mkdir(parents=True, exist_ok=True)
            content = str(step.get("content") or "")
            with target.open("a", encoding="utf-8") as handle:
                handle.write(content)
            result["ok"] = True
            result["appended"] = bool(content)
            if not target.exists():
                created.append(path)
            results.append(result)
            continue

        patch_text = str(step.get("content") or "")
        selection: dict[str, Any] = {"best_candidate": None, "candidates": []}
        if provider is not None:
            selection = generate_patch_candidates(
                provider,
                _prompt_variants(plan, path=path, editor_context=normalized_editor_context),
                approved_targets=[path],
                target_path=path,
                active_file_path=str(normalized_editor_context.get("active_file_path") or ""),
                memory_hints=summarize_success_patterns(
                    root,
                    strategy=str(plan.get("strategy") or ""),
                    target_path=path,
                    active_file_path=str(normalized_editor_context.get("active_file_path") or ""),
                ),
            )
            if selection.get("best_patch"):
                patch_text = str(selection.get("best_patch") or "")
            result["ai_patch"] = patch_text
            review = _summarize_patch_review(selection)
            if review:
                result["ai_patch_review"] = review

        if provider is not None:
            block_reason = _selection_block_reason(selection)
            if block_reason:
                result["error"] = block_reason
                result["blocked"] = True
                results.append(result)
                continue

        if not patch_text:
            result["error"] = "no patch produced"
            results.append(result)
            continue

        existed_before = target.exists()
        _write_patch(target, patch_text)
        if not existed_before:
            created.append(path)
        result["ok"] = True
        result["created"] = not existed_before
        results.append(result)

    execution_summary = ""
    if provider is not None:
        try:
            execution_summary = str(
                provider.summarize(
                    build_coding_task_prompt(
                        f"Summarize execution outcome for BAT<{plan.get('ticket')}>.",
                        editor_context=normalized_editor_context,
                        approved_targets=[
                            str(item.get("path") or "") for item in results if isinstance(item, dict) and str(item.get("path") or "")
                        ],
                        extra_context={
                            "Plan": plan,
                            "Results": results,
                        },
                        response_contract=(
                            "Keep the summary brief.",
                            "Mention only the most important changed paths.",
                        ),
                        heading="Execution summary request",
                    )
                )
                or ""
            )
        except Exception:
            execution_summary = ""

    return {
        "ticket": str(plan.get("ticket") or ""),
        "results": results,
        "created": created,
        "execution_summary": execution_summary,
        "runtime_context": dict(runtime_context or {}),
        "ok": all(bool(item.get("ok", False)) for item in results) if results else True,
    }


__all__ = ["execute_plan"]
