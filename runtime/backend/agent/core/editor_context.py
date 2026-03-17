from __future__ import annotations

from typing import Any

MAX_SELECTED_TEXT_CHARS = 1200
MAX_SURROUNDING_SNIPPET_CHARS = 2500
MAX_DIFF_CHARS = 2500
MAX_PROMPT_SECTION_CHARS = 1800
MAX_OPEN_FILES = 8
MAX_DIAGNOSTICS = 5
MAX_GUIDANCE_LINES = 8

DEFAULT_CODING_SYSTEM_PROMPT = (
    "You are GoSenderr's local-first coding assistant. Keep suggestions repository-grounded, "
    "prefer small safe edits, reuse existing files and services, respect the current architecture, "
    "and avoid inventing APIs, files, or flows that are not supported by the provided context. "
    "When code help is requested, focus first on the active file, nearby snippet, diagnostics, and diff."
)


EDITOR_CONTEXT_FIELDS = (
    "active_file_path",
    "selected_text",
    "selection_start_line",
    "selection_end_line",
    "surrounding_snippet",
    "diagnostics",
    "open_files",
    "current_file_diff",
)


SEVERITY_LABELS = {
    0: "error",
    1: "warning",
    2: "information",
    3: "hint",
}


def _clip_text(value: Any, *, max_chars: int) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "…"


def _pick(raw: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in raw and raw.get(key) not in (None, "", [], {}):
            return raw.get(key)
    return None


def _normalize_diagnostic(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    message = _clip_text(item.get("message"), max_chars=240)
    if not message:
        return None
    severity_value = item.get("severity")
    if isinstance(severity_value, str):
        severity = severity_value.strip().lower() or "unknown"
    else:
        severity = SEVERITY_LABELS.get(int(severity_value or 0), "unknown")
    normalized: dict[str, Any] = {
        "message": message,
        "severity": severity,
    }
    for source_key, target_key in (
        ("source", "source"),
        ("code", "code"),
        ("startLine", "start_line"),
        ("start_line", "start_line"),
        ("endLine", "end_line"),
        ("end_line", "end_line"),
    ):
        value = item.get(source_key)
        if value not in (None, ""):
            normalized[target_key] = value
    return normalized


def normalize_editor_context(raw: dict[str, Any] | None) -> dict[str, Any]:
    payload = dict(raw or {})
    if not payload:
        return {}

    diagnostics_raw = _pick(payload, "diagnostics") or []
    diagnostics: list[dict[str, Any]] = []
    if isinstance(diagnostics_raw, list):
        for item in diagnostics_raw[:MAX_DIAGNOSTICS]:
            normalized = _normalize_diagnostic(item)
            if normalized:
                diagnostics.append(normalized)

    open_files_raw = _pick(payload, "open_files", "openFiles") or []
    open_files: list[str] = []
    if isinstance(open_files_raw, list):
        for value in open_files_raw[:MAX_OPEN_FILES]:
            text = _clip_text(value, max_chars=180)
            if text:
                open_files.append(text)

    normalized_context = {
        "active_file_path": _clip_text(_pick(payload, "active_file_path", "activeFilePath"), max_chars=240),
        "selected_text": _clip_text(_pick(payload, "selected_text", "selectedText"), max_chars=MAX_SELECTED_TEXT_CHARS),
        "selection_start_line": _pick(payload, "selection_start_line", "selectionStartLine"),
        "selection_end_line": _pick(payload, "selection_end_line", "selectionEndLine"),
        "surrounding_snippet": _clip_text(_pick(payload, "surrounding_snippet", "surroundingSnippet"), max_chars=MAX_SURROUNDING_SNIPPET_CHARS),
        "diagnostics": diagnostics,
        "open_files": open_files,
        "current_file_diff": _clip_text(_pick(payload, "current_file_diff", "currentFileDiff"), max_chars=MAX_DIFF_CHARS),
    }
    return {key: value for key, value in normalized_context.items() if value not in (None, "", [], {})}


def format_editor_context_for_prompt(
    editor_context: dict[str, Any] | None,
    *,
    include_fields: tuple[str, ...] | None = None,
    heading: str = "Editor context",
    max_chars: int = MAX_PROMPT_SECTION_CHARS,
) -> str:
    context = normalize_editor_context(editor_context)
    if not context:
        return ""

    allowed_fields = include_fields or EDITOR_CONTEXT_FIELDS
    lines: list[str] = [f"{heading}:"]

    if "active_file_path" in allowed_fields and context.get("active_file_path"):
        lines.append(f"- Active file: {context['active_file_path']}")
    if (
        "selection_start_line" in allowed_fields
        and "selection_end_line" in allowed_fields
        and context.get("selection_start_line") is not None
        and context.get("selection_end_line") is not None
    ):
        lines.append(
            f"- Selection lines: {context['selection_start_line']}-{context['selection_end_line']}"
        )
    if "selected_text" in allowed_fields and context.get("selected_text"):
        lines.append("- Selected text:")
        lines.append(context["selected_text"])
    if "surrounding_snippet" in allowed_fields and context.get("surrounding_snippet"):
        lines.append("- Nearby snippet:")
        lines.append(context["surrounding_snippet"])
    if "diagnostics" in allowed_fields and context.get("diagnostics"):
        lines.append("- Diagnostics:")
        for item in context["diagnostics"][:MAX_DIAGNOSTICS]:
            span = ""
            if item.get("start_line") is not None and item.get("end_line") is not None:
                span = f" ({item['start_line']}-{item['end_line']})"
            source = f" [{item['source']}]" if item.get("source") else ""
            lines.append(f"  - {item.get('severity', 'unknown')}{source}{span}: {item.get('message', '')}")
    if "open_files" in allowed_fields and context.get("open_files"):
        lines.append(f"- Open files: {', '.join(context['open_files'])}")
    if "current_file_diff" in allowed_fields and context.get("current_file_diff"):
        lines.append("- Current file diff:")
        lines.append(context["current_file_diff"])

    text = "\n".join(lines).strip()
    return _clip_text(text, max_chars=max_chars)


def build_coding_task_prompt(
    objective: str,
    *,
    editor_context: dict[str, Any] | None = None,
    approved_targets: list[str] | set[str] | tuple[str, ...] | None = None,
    plan_step: dict[str, Any] | None = None,
    extra_context: dict[str, Any] | None = None,
    response_contract: list[str] | tuple[str, ...] | None = None,
    heading: str = "Coding task",
    max_chars: int = 2600,
) -> str:
    lines: list[str] = [f"{heading}:", str(objective or "").strip() or "No objective provided."]

    normalized_targets = [str(path).strip() for path in (approved_targets or []) if str(path).strip()]
    if normalized_targets:
        lines.append("")
        lines.append("Approved targets:")
        for path in normalized_targets[:12]:
            lines.append(f"- {path}")

    if plan_step:
        lines.append("")
        lines.append("Current step:")
        lines.append(str(plan_step))

    if extra_context:
        for label, value in extra_context.items():
            if value in (None, "", [], {}, ()):
                continue
            lines.append("")
            lines.append(f"{label}:")
            if isinstance(value, (list, tuple, set)):
                for item in list(value)[:12]:
                    lines.append(f"- {item}")
            else:
                lines.append(str(value))

    editor_prompt = format_editor_context_for_prompt(
        editor_context,
        include_fields=(
            "active_file_path",
            "selection_start_line",
            "selection_end_line",
            "selected_text",
            "surrounding_snippet",
            "diagnostics",
            "open_files",
            "current_file_diff",
        ),
        heading="Relevant editor context",
        max_chars=1100,
    )
    if editor_prompt:
        lines.append("")
        lines.append(editor_prompt)

    guidance = list(response_contract or [])[:MAX_GUIDANCE_LINES]
    if guidance:
        lines.append("")
        lines.append("Response contract:")
        for item in guidance:
            text = str(item or "").strip()
            if text:
                lines.append(f"- {text}")

    return _clip_text("\n".join(lines).strip(), max_chars=max_chars)


def build_coding_chat_messages(
    user_request: str,
    editor_context: dict[str, Any] | None = None,
    *,
    system_prompt: str = DEFAULT_CODING_SYSTEM_PROMPT,
) -> list[dict[str, str]]:
    prompt = build_coding_task_prompt(
        str(user_request or "").strip() or "Help with the current coding task.",
        editor_context=editor_context,
        heading="User coding request",
        response_contract=(
            "Answer with concrete coding help tailored to the repository context.",
            "Prefer exact file targets, minimal changes, and short actionable reasoning.",
            "If context is incomplete, say what is missing instead of inventing details.",
        ),
        max_chars=2400,
    )
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": prompt},
    ]


def augment_ticket_description(description: str, editor_context: dict[str, Any] | None) -> str:
    base = str(description or "").strip()
    prompt_context = format_editor_context_for_prompt(
        editor_context,
        include_fields=(
            "active_file_path",
            "selection_start_line",
            "selection_end_line",
            "selected_text",
            "surrounding_snippet",
            "diagnostics",
        ),
        heading="Active editor context",
        max_chars=1200,
    )
    if not prompt_context:
        return base
    if base:
        return f"{base}\n\n{prompt_context}"
    return prompt_context
