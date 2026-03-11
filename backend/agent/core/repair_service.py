from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from backend.agent.core.adapters.base import RepoAdapter
from backend.agent.core.editor_context import format_editor_context_for_prompt, normalize_editor_context
from backend.agent.core.validation_service import run_validation_plan


def analyze_failures(validation_result: dict[str, Any], plan: dict[str, Any], audit_result: dict[str, Any]) -> dict[str, Any]:
    related = set(validation_result.get("related_targets", []))
    related.update(path for path in plan.get("existing_targets", []) or [])
    for item in plan.get("new_files", []) or []:
        if isinstance(item, dict) and item.get("path"):
            related.add(item["path"])

    combined = "\n".join(
        result.get("stderr", "") + result.get("stdout", "")
        for result in validation_result.get("results", [])
    )
    found = re.findall(r"([\w\-/]+\.(?:py|ts|tsx|js))", combined)
    matched = [path for path in found if path in related]
    return {
        "ticket": validation_result.get("ticket") or audit_result.get("ticket"),
        "related_targets": sorted(related),
        "detected_paths": found,
        "repairable_paths": matched,
        "ok": bool(matched),
    }


def attempt_repair(
    adapter: RepoAdapter,
    plan: dict[str, Any],
    validation_result: dict[str, Any],
    *,
    provider: Any = None,
    max_retries: int = 3,
    project_root: Path | None = None,
    editor_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    del adapter
    root = project_root or Path.cwd()
    analysis = analyze_failures(validation_result, plan, {"ticket": plan.get("ticket")})
    repairs: list[dict[str, Any]] = []
    current = validation_result
    repair_guidance = ""
    failure_explanation = ""
    retry_summaries: list[str] = []
    editor_prompt = format_editor_context_for_prompt(
        normalize_editor_context(editor_context),
        include_fields=(
            "active_file_path",
            "selected_text",
            "surrounding_snippet",
            "diagnostics",
            "current_file_diff",
        ),
        heading="Relevant editor context",
        max_chars=900,
    )

    if provider is not None:
        try:
            failure_explanation = provider.summarize(
                f"Explain these validation failures briefly and focus on actionable repair context.\n\n"
                f"Ticket: {plan.get('ticket')}\n"
                f"Validation: {validation_result}\n"
                f"Repairable paths: {analysis.get('repairable_paths', [])}"
                + (f"\n{editor_prompt}" if editor_prompt else "")
            )
        except Exception:
            failure_explanation = ""
        try:
            repair_guidance = provider.propose_patch(
                f"Ticket: {plan.get('ticket')}\n"
                f"Plan: {plan}\n"
                f"Validation: {validation_result}\n"
                f"Repairable paths: {analysis.get('repairable_paths', [])}"
                + (f"\n{editor_prompt}" if editor_prompt else "")
            )
        except Exception:
            repair_guidance = ""

    for _ in range(max_retries):
        targets = analysis.get("repairable_paths", [])
        if not targets:
            break
        for path in targets:
            target = root / path
            if not target.exists():
                continue
            patch_text = "# repair attempt"
            if provider is not None:
                try:
                    candidate = provider.propose_patch(
                        f"Ticket: {plan.get('ticket')}\n"
                        f"Target path: {path}\n"
                        f"Plan: {plan}\n"
                        f"Validation: {current}"
                        + (f"\n{editor_prompt}" if editor_prompt else "")
                    )
                    if candidate:
                        patch_text = candidate.strip()
                except Exception:
                    patch_text = "# repair attempt"
            with open(target, "a", encoding="utf-8") as handle:
                if not patch_text.startswith("\n"):
                    patch_text = "\n" + patch_text
                if not patch_text.endswith("\n"):
                    patch_text += "\n"
                handle.write(patch_text)
            repair_entry = {"path": path}
            if provider is not None:
                repair_entry["patch_preview"] = patch_text.strip()
            repairs.append(repair_entry)
        rerun_plan = {
            "ticket": validation_result.get("ticket"),
            "scope": validation_result.get("scope", []),
            "related_targets": validation_result.get("related_targets", []),
            "commands": validation_result.get("commands", []),
        }
        current = run_validation_plan(rerun_plan, project_root=root)
        if provider is not None:
            try:
                retry_summary = provider.summarize(
                    f"Summarize this repair retry outcome briefly.\n\n"
                    f"Ticket: {plan.get('ticket')}\n"
                    f"Current validation: {current}"
                )
                if retry_summary:
                    retry_summaries.append(retry_summary)
            except Exception:
                pass
        if current.get("ok"):
            break
        analysis = analyze_failures(current, plan, {"ticket": plan.get("ticket")})

    return {
        "ticket": plan.get("ticket"),
        "analysis": analysis,
        "repairs": repairs,
        "failure_explanation": failure_explanation,
        "repair_guidance": repair_guidance,
        "retry_summaries": retry_summaries,
        "validation": current,
        "ok": current.get("ok", False),
    }