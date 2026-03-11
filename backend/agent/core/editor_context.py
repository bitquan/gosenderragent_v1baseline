from __future__ import annotations

from typing import Any

MAX_SELECTED_TEXT_CHARS = 1200
MAX_SURROUNDING_SNIPPET_CHARS = 2500
MAX_DIFF_CHARS = 2500
MAX_PROMPT_SECTION_CHARS = 1800
MAX_OPEN_FILES = 8
MAX_DIAGNOSTICS = 5


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
