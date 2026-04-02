from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from backend.agent.core.approval import ApprovalGate
from backend.agent.core.editor_context import build_coding_task_prompt, normalize_editor_context
from backend.agent.core.orchestrator import OrchestrationTask, SequentialAgentOrchestrator
from backend.agent.core.patch_review import generate_patch_candidates
from backend.agent.core.runtime_context import build_runtime_context, extract_runtime_context
from backend.agent.core.tool_registry import build_default_tool_registry
from backend.agent.runtime.contracts import (
    DEV_ENGINE_LOOP_STEPS,
    RECOVERY_LADDER_STEPS,
    build_checkpoint_ref,
    build_failure_class,
    build_interrupt_request,
    build_recovery_ladder_state,
    build_review_bundle,
    build_runtime_failure,
    build_runtime_run,
    build_runtime_task,
    build_task_objective,
    build_workbench_artifact,
)
from backend.agent.runtime.orchestration_driver import RuntimeOrchestrationDriver
from backend.agent.core.patch_review import build_review_summary

_OBJECTIVE_PATH_RE = re.compile(r'([A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*\.[A-Za-z0-9_.-]+)')
_MUTATION_KEYWORDS = ('repair', 'fix', 'edit', 'modify', 'implement', 'patch', 'update', 'change', 'append', 'add', 'create', 'write')
_SOURCE_SUFFIXES = {'.py', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.css', '.scss', '.html', '.json'}
_PREFERRED_MUTATION_DIRS = ('src', 'app', 'lib', 'server', 'renderer', 'renderer-src', 'test', 'tests')
_MIN_PATCH_SCORE = 0.3
_FENCED_BLOCK_RE = re.compile(r"```(?P<lang>[A-Za-z0-9_-]*)[ \t]*\n?(?P<body>[\s\S]*?)\n?```")
_SHELL_APPEND_COMMAND_RE = re.compile(
    r'^(?:echo|printf)\s+(?P<body>"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'|[^>]+?)\s*>>\s*(?P<path>[^\s]+)\s*$',
    re.IGNORECASE,
)
_SHELL_HEREDOC_WRITE_RE = re.compile(
    r'^cat\s+(?:(?P<operator_a>>>|>)\s*(?P<path_a>[^\s]+)\s+<<(?P<quote_a>[\'\"]?)(?P<tag_a>[A-Za-z0-9_.-]+)(?P=quote_a)|<<(?P<quote_b>[\'\"]?)(?P<tag_b>[A-Za-z0-9_.-]+)(?P=quote_b)\s*(?P<operator_b>>>|>)\s*(?P<path_b>[^\s]+))\s*$',
    re.IGNORECASE,
)
_SYNTHESIZED_RESPONSE_PREAMBLE_RE = re.compile(
    r'^(?:here(?: is|\'s)\b|updated (?:file|contents)\b|complete updated file\b|file contents\b|use (?:this|the following)\b|write (?:this|the following)\b|replace the file with\b)',
    re.IGNORECASE,
)
_SYNTHESIZED_REVIEW_HEADER_RE = re.compile(
    r'^(?:#{1,6}\s*suggested fix\b|\*\*suggested fix:?\*\*|\*\*minimal change:?\*\*|suggested fix:|minimal change:|recommended change:|proposed change:)',
    re.IGNORECASE,
)
_SYNTHESIZED_REVIEW_PROSE_RE = re.compile(
    r'^(?:update\b|replace\b|change\b|modify\b|the fix\b|this fix\b|apply\b|use\b).*',
    re.IGNORECASE,
)
_SYNTHESIZED_INSTRUCTION_LINE_RE = re.compile(
    r'^(?:do not\b|return only\b|stay inside\b|make the smallest\b|do not modify\b|do not include\b|//\s*your repair suggestion here\b|#\s*your repair suggestion here\b|your repair suggestion here\b)',
    re.IGNORECASE,
)
_CODE_LIKE_LINE_RE = re.compile(
    r'^(?:[\'"`]|const\b|let\b|var\b|function\b|async\b|class\b|module\.exports\b|exports\.|if\b|for\b|while\b|switch\b|return\b|import\b|export\b|from\b|def\b|class\b|try\b|except\b|with\b|@|/\*|//|[{\[]|<[^>]+>|[A-Za-z_$][A-Za-z0-9_$]*\s*=)',
    re.IGNORECASE,
)


def _extract_explicit_objective_paths(objective: str) -> list[str]:
    text = str(objective or '').strip()
    if not text:
        return []
    paths: list[str] = []
    seen: set[str] = set()
    for match in _OBJECTIVE_PATH_RE.findall(text):
        candidate = str(match or '').strip().strip('`"\')]}.,:;!?')
        if not candidate:
            continue
        normalized = candidate.replace('\\', '/')
        leaf = normalized.rsplit('/', 1)[-1]
        if '.' not in leaf and leaf.upper() not in {'README', 'LICENSE', 'AGENTS'}:
            continue
        lowered = normalized.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        paths.append(normalized)
    return paths[:5]


def _is_missing_file_read(result: dict[str, Any] | None) -> bool:
    payload = dict(result or {})
    if payload.get('ok') is True:
        return False
    message = ' '.join(
        str(part or '').strip().lower()
        for part in (
            payload.get('error'),
            payload.get('message'),
        )
        if str(part or '').strip()
    )
    return any(token in message for token in (
        'no such file or directory',
        'cannot find the file',
        'does not exist',
        'errno 2',
    ))


def _parse_bullet_list(raw: str) -> list[str]:
    items = [
        str(item or '').strip().strip('.')
        for item in re.split(r',|;|•|\n', str(raw or ''))
    ]
    return [item for item in items if item][:6]


def _objective_requires_write(objective: str, context: dict[str, Any] | None = None) -> bool:
    payload = dict(context or {})
    runtime_task = dict(payload.get('runtime_task') or payload.get('runtimeTask') or {})
    lane_id = str(runtime_task.get('lane_id') or runtime_task.get('laneId') or '').strip().lower()
    task_mode = str(runtime_task.get('task_mode') or runtime_task.get('taskMode') or '').strip().lower()
    if lane_id in {'repair-fast', 'code-main'} or task_mode in {'repair', 'coder'}:
        return True
    lowered = str(objective or '').strip().lower()
    return any(token in lowered for token in _MUTATION_KEYWORDS)


def _is_source_candidate(path: str) -> bool:
    target = Path(str(path or '').strip())
    if not target.name:
        return False
    lower_name = target.name.lower()
    if target.suffix.lower() not in _SOURCE_SUFFIXES:
        return False
    if lower_name.endswith('.test.js') or lower_name.endswith('.test.ts') or lower_name.endswith('.spec.js') or lower_name.endswith('.spec.ts'):
        return False
    return True


def _is_test_candidate(path: str) -> bool:
    target = Path(str(path or '').strip())
    if not target.name:
        return False
    lower_name = target.name.lower()
    if lower_name.endswith(('.test.js', '.test.ts', '.spec.js', '.spec.ts')):
        return True
    parts = [part.lower() for part in target.parts]
    return any(part in {'test', 'tests'} for part in parts)


def _is_repair_objective(objective: str, context: dict[str, Any] | None = None) -> bool:
    payload = dict(context or {})
    runtime_task = dict(payload.get('runtime_task') or payload.get('runtimeTask') or {})
    lane_id = str(runtime_task.get('lane_id') or runtime_task.get('laneId') or '').strip().lower()
    task_mode = str(runtime_task.get('task_mode') or runtime_task.get('taskMode') or '').strip().lower()
    if lane_id == 'repair-fast' or task_mode == 'repair':
        return True
    lowered = str(objective or '').strip().lower()
    return 'repair' in lowered or 'fix' in lowered


def _is_low_signal_mutation_target(path: str) -> bool:
    normalized = str(path or '').strip().replace('\\', '/').lower()
    if not normalized:
        return True
    leaf = normalized.rsplit('/', 1)[-1]
    if leaf in {'readme.md', '.gos-lab.json'}:
        return True
    return normalized.startswith('.gos-lab-recipes/') or normalized.startswith('docs/')


def _merge_target_candidates(primary: list[str], secondary: list[str], *, limit: int = 6) -> list[str]:
    merged: list[str] = []
    seen: set[str] = set()
    for item in [*list(primary or []), *list(secondary or [])]:
        candidate = str(item or '').strip().replace('\\', '/')
        if not candidate:
            continue
        lowered = candidate.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        merged.append(candidate)
        if len(merged) >= limit:
            break
    return merged


def _discover_repo_mutation_targets(project_root: str | Path | None, *, limit: int = 6) -> list[str]:
    root = Path(str(project_root or '')).resolve() if str(project_root or '').strip() else None
    if root is None or not root.exists():
        return []
    candidates: list[str] = []
    seen: set[str] = set()

    def add(path: Path) -> None:
        try:
            relative = path.relative_to(root).as_posix()
        except ValueError:
            return
        lowered = relative.lower()
        if lowered in seen or _is_low_signal_mutation_target(relative):
            return
        seen.add(lowered)
        candidates.append(relative)

    for folder in _PREFERRED_MUTATION_DIRS:
        base = root / folder
        if not base.exists() or not base.is_dir():
            continue
        for file_path in sorted(base.rglob('*')):
            if not file_path.is_file() or file_path.suffix.lower() not in _SOURCE_SUFFIXES:
                continue
            add(file_path)
            if len(candidates) >= limit:
                return candidates[:limit]
    package_json = root / 'package.json'
    if package_json.exists() and package_json.is_file():
        add(package_json)
    return candidates[:limit]


def _select_preferred_mutation_target(targets: list[str]) -> str:
    filtered = [item for item in list(targets or []) if not _is_low_signal_mutation_target(item)] or list(targets or [])
    preferred_non_json = next(
        (
            item for item in filtered
            if _is_source_candidate(item) and Path(str(item)).suffix.lower() != '.json'
        ),
        '',
    )
    if preferred_non_json:
        return preferred_non_json
    preferred_source = next((item for item in filtered if _is_source_candidate(item)), '')
    return preferred_source or (filtered[0] if filtered else '')


def _synthesized_execution_steps(targets: list[str], objective: str, context: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    normalized_targets = [str(item).strip() for item in list(targets or []) if str(item).strip()]
    if not normalized_targets:
        return []
    if not _objective_requires_write(objective, context):
        return [{"action": "inspect_file", "path": item} for item in normalized_targets[:3]]
    lowered_objective = str(objective or '').strip().lower()
    if len(normalized_targets) > 1 and any(token in lowered_objective for token in ('create', 'scaffold', 'starter', 'new file', 'new files')):
        return [
            {"action": "synthesize_edit", "path": item, "reason": "write-capable scaffold target"}
            for item in normalized_targets[:4]
        ]
    filtered_targets = [item for item in normalized_targets if not _is_low_signal_mutation_target(item)] or normalized_targets
    preferred_target = _select_preferred_mutation_target(filtered_targets)
    inspect_targets: list[str] = []
    if _is_repair_objective(objective, context):
        preferred_test = next((item for item in filtered_targets if _is_test_candidate(item)), '')
        if preferred_test:
            inspect_targets.append(preferred_test)
        if preferred_target:
            inspect_targets.append(preferred_target)
        for candidate in filtered_targets:
            if len(inspect_targets) >= 2:
                break
            if candidate not in inspect_targets:
                inspect_targets.append(candidate)
    else:
        inspect_targets = filtered_targets[:2]
    steps = [{"action": "inspect_file", "path": item} for item in inspect_targets]
    steps.append({"action": "synthesize_edit", "path": preferred_target, "reason": "write-capable fallback for mutation objective"})
    return steps


def _synthesized_patch_variants(objective: str, path: str, content: str, editor_context: dict[str, Any] | None = None) -> list[dict[str, str]]:
    normalized_editor_context = normalize_editor_context(editor_context)
    first_line = str(content.splitlines()[0] if content.splitlines() else '').strip()
    extra_context = {
        'Objective': objective,
        'Current file path': path,
        'Current file contents': content,
    }
    return [
        {
            'label': 'balanced-tool-loop-edit',
            'prompt': build_coding_task_prompt(
                f"Update {path} to satisfy the current coding objective.",
                editor_context=normalized_editor_context,
                approved_targets=[path],
                extra_context=extra_context,
                response_contract=(
                    'Return the complete updated contents for the approved target file only.',
                    'Make the smallest safe change that resolves the issue.',
                ),
                heading='Tool-loop synthesized edit request',
            ),
        },
        {
            'label': 'strict-tool-loop-edit',
            'prompt': build_coding_task_prompt(
                f"Edit only {path}. Return the full updated file contents with no markdown fences.",
                editor_context=normalized_editor_context,
                approved_targets=[path],
                extra_context=extra_context,
                response_contract=(
                    'Stay inside the approved target file.',
                    'Return only the full updated file contents.',
                ),
                heading='Strict tool-loop edit request',
            ),
        },
        {
            'label': 'verbatim-tool-loop-edit',
            'prompt': build_coding_task_prompt(
                f"Rewrite only {path}. Return the exact updated file text and nothing else.",
                editor_context=normalized_editor_context,
                approved_targets=[path],
                extra_context={
                    **extra_context,
                    'Expected first line': first_line,
                },
                response_contract=(
                    'Do not describe the fix.',
                    'Do not return shell commands, diffs, markdown fences, or placeholders.',
                    'Return only the full updated file contents for the approved target file.',
                ),
                heading='Verbatim tool-loop edit request',
            ),
        },
    ]


def _unwrap_single_fenced_block(text: str) -> str:
    sanitized = str(text or '').strip()
    fenced = re.match(r"^```[A-Za-z0-9_-]*[ \t]*\n?(?P<body>[\s\S]*?)\n?```\s*$", sanitized)
    if fenced:
        return str(fenced.group('body') or '').strip()
    return sanitized


def _strip_model_control_tokens(text: str) -> str:
    lines = [
        line
        for line in str(text or '').splitlines()
        if not any(token in str(line or '') for token in ('<|im_start|>', '<|im_end|>', '<s>', '</s>'))
    ]
    return '\n'.join(lines).strip()


def _extract_synthesized_content(path: str, patch: str) -> str:
    sanitized = _unwrap_single_fenced_block(patch)
    if '```' not in sanitized:
        return sanitized

    target_name = Path(str(path or '').strip()).name.lower()
    blocks: list[tuple[str, str, int]] = []
    for match in _FENCED_BLOCK_RE.finditer(sanitized):
        language = str(match.group('lang') or '').strip().lower()
        body = str(match.group('body') or '').strip()
        if not body:
            continue
        blocks.append((language, body, match.start()))

    if not blocks:
        return sanitized

    prefix_by_index = {index: sanitized[:start].lower() for index, (_language, _body, start) in enumerate(blocks)}
    for index, (language, body, _start) in enumerate(blocks):
        prefix = prefix_by_index[index]
        if language == 'json':
            continue
        if 'updated file contents' in prefix[-200:] or 'updated contents' in prefix[-200:]:
            return body

    for language, body, _start in blocks:
        if language != 'json':
            return body

    json_candidates: list[str] = []
    for language, body, _start in blocks:
        if language != 'json':
            continue
        json_candidates.append(body)
    for candidate in json_candidates:
        try:
            import json
            payload = json.loads(candidate)
        except Exception:
            continue
        if not isinstance(payload, dict):
            continue
        payload_path = str(payload.get('file_path') or payload.get('path') or '').strip().replace('\\', '/').lower()
        updated_contents = str(payload.get('updated_contents') or payload.get('content') or '').strip()
        if not updated_contents:
            continue
        if payload_path and Path(payload_path).name.lower() != target_name:
            continue
        return updated_contents

    return sanitized


def _translate_shell_append_response(path: str, current_content: str, patch: str) -> str:
    sanitized = _strip_model_control_tokens(_unwrap_single_fenced_block(patch))
    match = _SHELL_APPEND_COMMAND_RE.match(str(sanitized or '').strip())
    if not match:
        return ''

    command_path = str(match.group('path') or '').strip().strip('"\'"`').replace('\\', '/')
    target_path = str(path or '').strip().replace('\\', '/')
    if command_path:
        command_name = Path(command_path).name.lower()
        target_name = Path(target_path).name.lower()
        if command_path.lower() != target_path.lower() and command_name != target_name:
            return ''

    body = str(match.group('body') or '')
    if len(body) >= 2 and body[0] == body[-1] and body[0] in {'"', "'"}:
        body = body[1:-1]
    body = body.replace('\\n', '\n')
    existing = str(current_content or '')
    if existing and not existing.endswith('\n'):
        existing += '\n'
    appended = body
    if appended and not appended.endswith('\n'):
        appended += '\n'
    return existing + appended


def _translate_shell_write_response(path: str, current_content: str, patch: str) -> str:
    sanitized = _strip_model_control_tokens(_unwrap_single_fenced_block(patch))
    lines = str(sanitized or '').splitlines()
    if len(lines) < 3:
        return ''

    header = str(lines[0] or '').strip()
    match = _SHELL_HEREDOC_WRITE_RE.match(header)
    if not match:
        return ''

    command_path = str(match.group('path_a') or match.group('path_b') or '').strip().strip('"\'"`').replace('\\', '/')
    target_path = str(path or '').strip().replace('\\', '/')
    if command_path:
        command_name = Path(command_path).name.lower()
        target_name = Path(target_path).name.lower()
        if command_path.lower() != target_path.lower() and command_name != target_name:
            return ''

    tag = str(match.group('tag_a') or match.group('tag_b') or '').strip()
    if not tag or str(lines[-1] or '').strip() != tag:
        return ''

    body = '\n'.join(lines[1:-1])
    operator = str(match.group('operator_a') or match.group('operator_b') or '>').strip()
    if operator == '>>':
        existing = str(current_content or '')
        if existing and not existing.endswith('\n'):
            existing += '\n'
        if body and not body.endswith('\n'):
            body += '\n'
        return existing + body
    return body


def _looks_like_code_line(path: str, line: str) -> bool:
    stripped = str(line or '').strip()
    if not stripped:
        return False
    suffix = Path(str(path or '').strip()).suffix.lower()
    if suffix in {'.json'}:
        return stripped.startswith('{') or stripped.startswith('[') or stripped.startswith('"')
    if suffix in {'.html'}:
        return stripped.startswith('<')
    return bool(_CODE_LIKE_LINE_RE.match(stripped))


def _validation_failure_summary(validation_rows: list[dict[str, Any]]) -> str:
    for row in list(validation_rows or []):
        output = f"{str(row.get('stdout') or '')}\n{str(row.get('stderr') or '')}"
        for line in output.splitlines():
            stripped = str(line or '').strip()
            if not stripped:
                continue
            if stripped.startswith('>') or stripped.startswith('✔') or stripped == '^':
                continue
            if stripped.lower().startswith('node.js v') or re.match(r'^at\s.+$', stripped, re.IGNORECASE):
                continue
            return stripped
    return 'Validation failed.'


def _strip_synthesized_response_preamble(path: str, patch: str) -> str:
    sanitized = str(patch or '').strip()
    if not sanitized or '\n' not in sanitized:
        return sanitized

    lines = sanitized.splitlines()
    changed = False
    while lines and _SYNTHESIZED_RESPONSE_PREAMBLE_RE.match(str(lines[0] or '').strip()):
        changed = True
        lines.pop(0)
        while lines and not str(lines[0] or '').strip():
            lines.pop(0)

    saw_review_header = False
    while lines:
        current = str(lines[0] or '').strip()
        if not current:
            if changed or saw_review_header:
                changed = True
                lines.pop(0)
                continue
            break
        if _SYNTHESIZED_REVIEW_HEADER_RE.match(current):
            changed = True
            saw_review_header = True
            lines.pop(0)
            continue
        if saw_review_header and not _looks_like_code_line(path, current):
            if _SYNTHESIZED_REVIEW_PROSE_RE.match(current) or current.endswith('.') or current.endswith(':'):
                changed = True
                lines.pop(0)
                continue
        break

    if not lines:
        return ''

    target_path = str(path or '').strip().replace('\\', '/').lower()
    target_name = Path(target_path).name.lower()
    first_line = str(lines[0] or '').strip().strip('`')
    normalized_first = first_line.replace('\\', '/').strip().strip(':').lower()
    file_markers = {
        target_path,
        target_name,
        f'file: {target_path}',
        f'file: {target_name}',
        f'path: {target_path}',
        f'path: {target_name}',
    }
    if normalized_first in file_markers:
        changed = True
        lines.pop(0)
        while lines and re.fullmatch(r'[-=]{3,}', str(lines[0] or '').strip()):
            lines.pop(0)
        while lines and not str(lines[0] or '').strip():
            lines.pop(0)

    return '\n'.join(lines).strip() if changed else sanitized


def _strip_synthesized_instruction_lines(patch: str) -> str:
    sanitized = str(patch or '').strip()
    if not sanitized or '\n' not in sanitized:
        return sanitized

    lines = sanitized.splitlines()
    changed = False
    while lines:
        current = str(lines[0] or '').strip()
        if not current:
            if changed:
                lines.pop(0)
                continue
            break
        if _SYNTHESIZED_INSTRUCTION_LINE_RE.match(current):
            changed = True
            lines.pop(0)
            continue
        break
    return '\n'.join(lines).strip() if changed else sanitized


def _translate_append_objective_response(objective: str, current_content: str, patch: str) -> str:
    lowered_objective = str(objective or '').strip().lower()
    if not any(token in lowered_objective for token in ('append', 'add a single line', 'add one line', 'append a line')):
        return ''

    sanitized = _strip_model_control_tokens(_unwrap_single_fenced_block(patch))
    if not sanitized:
        return ''
    if any(token in sanitized for token in ('>>', '<<', 'apply_patch')):
        return ''

    candidate = sanitized.strip()
    if not candidate:
        return ''
    if len(candidate.splitlines()) > 4:
        return ''
    if candidate in str(current_content or ''):
        return ''

    existing = str(current_content or '')
    if existing and not existing.endswith('\n'):
        existing += '\n'
    if not candidate.endswith('\n'):
        candidate += '\n'
    return existing + candidate


def _looks_like_shell_command_response(path: str, patch: str) -> bool:
    sanitized = _strip_model_control_tokens(_unwrap_single_fenced_block(patch))
    if not sanitized:
        return False
    if _translate_shell_append_response(path, '', sanitized):
        return False
    if _translate_shell_write_response(path, '', sanitized):
        return False
    first_line = str(sanitized.splitlines()[0] if sanitized.splitlines() else sanitized).strip().lower()
    command_prefixes = (
        'echo ',
        'printf ',
        'cat ',
        'sed ',
        'python ',
        'node ',
        'npm ',
        'git ',
        'apply_patch',
        'powershell ',
        'pwsh ',
        'bash ',
        'cmd ',
    )
    if first_line.startswith(command_prefixes):
        return True
    target_name = Path(str(path or '').strip()).name.lower()
    return bool(target_name and target_name in sanitized.lower() and ('>>' in sanitized or '>' in sanitized))


def _normalize_synthesized_content(objective: str, path: str, current_content: str, patch: str) -> str:
    sanitized = _strip_model_control_tokens(_extract_synthesized_content(path, patch))
    translated_append = _translate_shell_append_response(path, current_content, sanitized)
    if translated_append:
        return translated_append
    translated_shell_write = _translate_shell_write_response(path, current_content, sanitized)
    if translated_shell_write:
        return translated_shell_write
    stripped_preamble = _strip_synthesized_response_preamble(path, sanitized)
    if stripped_preamble != sanitized:
        sanitized = stripped_preamble
    stripped_instruction_lines = _strip_synthesized_instruction_lines(sanitized)
    if stripped_instruction_lines != sanitized:
        sanitized = stripped_instruction_lines
    inferred_append = _translate_append_objective_response(objective, current_content, sanitized)
    if inferred_append:
        return inferred_append
    if _looks_like_shell_command_response(path, sanitized):
        return ''
    if '```' in sanitized:
        return ''
    return sanitized


def _recover_candidate_content_from_selection(selection: dict[str, Any], objective: str, path: str, current_content: str) -> tuple[str, dict[str, Any]]:
    for candidate in list(selection.get('candidates') or []):
        raw_patch = str(candidate.get('patch') or '')
        if not raw_patch.strip():
            continue
        normalized = _normalize_synthesized_content(objective, path, current_content, raw_patch)
        if normalized.strip():
            return normalized, {
                'label': str(candidate.get('label') or ''),
                'score': float(candidate.get('score') or 0),
            }
    return '', {}


def _selection_provider_error(selection: dict[str, Any]) -> str:
    for candidate in list(selection.get('candidates') or []):
        for reason in list(candidate.get('reasons') or []):
            text = str(reason or '').strip()
            if not text:
                continue
            if text.lower().startswith('provider error:'):
                return text.split(':', 1)[1].strip() or text
    return ''


def _select_synthesized_patch(provider: Any, objective: str, path: str, content: str, editor_context: dict[str, Any] | None = None) -> dict[str, Any]:
    if provider is None:
        return {'ok': False, 'error': 'no provider available for synthesized edit'}
    selection = generate_patch_candidates(
        provider,
        _synthesized_patch_variants(objective, path, content, editor_context=editor_context),
        approved_targets=[path],
        target_path=path,
        active_file_path=str((normalize_editor_context(editor_context) or {}).get('active_file_path') or path),
        include_patch_text=True,
    )
    best = dict(selection.get('best_candidate') or {})
    score = float(best.get('score') or 0)
    reasons = [str(item) for item in list(best.get('reasons') or []) if str(item)]
    patch = str(selection.get('best_patch') or '')
    if not patch.strip():
        recovered_content, recovered_candidate = _recover_candidate_content_from_selection(selection, objective, path, content)
        if recovered_content:
            selection['recovered_candidate'] = recovered_candidate
            return {'ok': True, 'content': recovered_content, 'selection': selection}
        provider_error = _selection_provider_error(selection)
        if provider_error:
            return {'ok': False, 'error': provider_error, 'selection': selection}
        return {'ok': False, 'error': 'provider returned an empty patch', 'selection': selection}
    if score < _MIN_PATCH_SCORE:
        return {'ok': False, 'error': f'patch candidate below confidence threshold ({score:.2f})', 'selection': selection}
    if 'references unapproved file paths' in reasons:
        return {'ok': False, 'error': 'patch candidate references unapproved file paths', 'selection': selection}
    if 'placeholder patch' in reasons:
        return {'ok': False, 'error': 'patch candidate is only a placeholder', 'selection': selection}
    sanitized = _normalize_synthesized_content(objective, path, content, patch)
    if not sanitized.strip():
        recovered_content, recovered_candidate = _recover_candidate_content_from_selection(selection, objective, path, content)
        if recovered_content:
            selection['recovered_candidate'] = recovered_candidate
            return {'ok': True, 'content': recovered_content, 'selection': selection}
        provider_error = _selection_provider_error(selection)
        if provider_error:
            return {'ok': False, 'error': provider_error, 'selection': selection}
        if _looks_like_shell_command_response(path, patch):
            return {'ok': False, 'error': 'patch candidate returned a shell command instead of file contents', 'selection': selection}
        return {'ok': False, 'error': 'patch candidate did not normalize into file contents', 'selection': selection}
    return {'ok': True, 'content': sanitized, 'selection': selection}


def _synthesize_append_section_step(objective: str, explicit_paths: list[str]) -> dict[str, Any] | None:
    if not explicit_paths:
        return None
    text = str(objective or '').strip()
    lowered = text.lower()
    if not any(token in lowered for token in ('add a short section', 'add a section', 'append a section', 'append section')):
        return None
    title_match = re.search(r'(?:called|titled)\s+(.+?)(?:\s+with\b|\.|$)', text, re.IGNORECASE)
    bullets_match = re.search(r'bullets?\s*:\s*(.+?)(?:\.\s+Then\b|$)', text, re.IGNORECASE)
    title = str(title_match.group(1) if title_match else '').strip().strip(' "\'`')
    bullets = _parse_bullet_list(bullets_match.group(1) if bullets_match else '')
    if not title or not bullets:
        return None
    content_lines = ['', f'## {title}', '']
    content_lines.extend(f'- {item}' for item in bullets)
    content = '\n'.join(content_lines).rstrip() + '\n'
    return {
        'action': 'edit_file',
        'path': explicit_paths[0],
        'content': content,
        'mode': 'append',
    }


def _tool_loop_task_objective(objective: str, runtime_task: dict[str, Any]) -> dict[str, Any]:
    return build_task_objective(
        summary=str(objective or ""),
        kind="orchestrate",
        source="tool-loop",
        task_mode=str(runtime_task.get("task_mode") or ""),
        action=str(runtime_task.get("action") or ""),
        loop_steps=DEV_ENGINE_LOOP_STEPS,
    )


def _tool_loop_execution_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    payload = dict(result.get("payload") or {})
    return [dict(item) for item in list(payload.get("execution") or []) if isinstance(item, dict)]


def _tool_loop_result_summary(result: dict[str, Any]) -> str:
    summary = str(result.get('summary') or '').strip()
    if summary:
        return summary
    for item in reversed(list(result.get('trace') or [])):
        text = str(dict(item).get('summary') or '').strip() if isinstance(item, dict) else ''
        if text:
            return text
    return str(result.get('status') or '').strip()


def _tool_loop_observed_changed_files(result: dict[str, Any]) -> list[dict[str, str]]:
    changed: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in _tool_loop_execution_rows(result):
        step = dict(item.get("step") or {})
        step_result = dict(item.get("result") or {})
        path = str(step_result.get("path") or step_result.get("output_path") or step.get("path") or "").strip().replace('\\', '/')
        if not path:
            continue
        lowered = path.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        status = str(step_result.get("status") or "").strip().upper()
        if not status:
            if str(step.get("action") or "").strip().lower() in {"synthesize_edit", "edit_file", "modify_file", "smart_patch"}:
                status = "M"
            elif str(step.get("action") or "").strip().lower() in {"create_file"}:
                status = "A"
            else:
                status = "M"
        changed.append({"path": path, "status": status})
    return changed


def _merge_changed_file_sets(primary: list[dict[str, Any]] | None, secondary: list[dict[str, Any]] | None, *, limit: int = 12) -> list[dict[str, str]]:
    merged: list[dict[str, str]] = []
    seen: set[str] = set()
    for group in (list(primary or []), list(secondary or [])):
        for item in group:
            if not isinstance(item, dict):
                continue
            path = str(item.get("path") or "").strip().replace('\\', '/')
            if not path:
                continue
            lowered = path.lower()
            if lowered in seen:
                continue
            seen.add(lowered)
            merged.append({"path": path, "status": str(item.get("status") or "M").strip() or "M"})
            if len(merged) >= limit:
                return merged
    return merged


def _tool_loop_expects_mutation(context: dict[str, Any] | None = None) -> bool:
    source = dict(context or {})
    lane_id = str(source.get('lane_id') or source.get('laneId') or '').strip().lower()
    task_mode = str(source.get('task_mode') or source.get('taskMode') or '').strip().lower()
    if lane_id in {'code-main', 'repair-fast'}:
        return True
    if task_mode in {'coder', 'repair'}:
        return True
    for step in list(source.get('steps') or []):
        if not isinstance(step, dict):
            continue
        action = str(step.get('action') or '').strip().lower()
        if action in {'edit_file', 'smart_patch', 'synthesize_edit', 'modify_file'}:
            return True
    return False


def _tool_loop_provider_preflight(provider: Any, context: dict[str, Any] | None = None) -> dict[str, Any]:
    if provider is None or not _tool_loop_expects_mutation(context):
        return {'ok': True}
    preflight = getattr(provider, 'preflight_check', None)
    if not callable(preflight):
        return {'ok': True}
    try:
        result = preflight()
    except Exception as exc:
        return {'ok': False, 'message': str(exc) or 'Provider preflight failed.'}
    if isinstance(result, dict):
        return {
            'ok': bool(result.get('ok', False)),
            'message': str(result.get('message') or '').strip(),
        }
    return {'ok': bool(result), 'message': ''}


def _tool_loop_failure_kind(result: dict[str, Any]) -> str:
    if bool(result.get("pending_approvals")):
        return "risky-interrupt"
    if bool(result.get("ok")):
        return ""
    text_parts = [str(result.get("summary") or ""), str(result.get("status") or "")]
    haystack = " ".join(part.strip().lower() for part in text_parts if str(part).strip())
    if any(token in haystack for token in ["ollama request failed", "provider preflight failed", "requires more system memory", "route is not ready"]):
        return "route-not-ready"
    execution_rows = _tool_loop_execution_rows(result)
    if not execution_rows:
        return "empty-proposal"
    for item in execution_rows:
        step = dict(item.get("step") or {})
        step_result = dict(item.get("result") or {})
        text_parts.extend(
            [
                str(step.get("action") or ""),
                str(step.get("path") or ""),
                str(step_result.get("error") or ""),
                str(step_result.get("message") or ""),
            ]
        )
    haystack = " ".join(part.strip().lower() for part in text_parts if str(part).strip())
    if any(token in haystack for token in ["invalid", "unknown step action", "outside allowed", "malformed"]):
        return "invalid-change-set"
    return "validation-failure"


def _tool_loop_retry_policy(kind: str) -> dict[str, Any]:
    return {
        "empty-proposal": {
            "action": "run",
            "reason": "Tool loop produced no actionable steps. Retry with research first.",
        },
        "invalid-change-set": {
            "action": "plan",
            "reason": "Tool loop produced an invalid bounded step set. Rebuild the plan before retrying.",
        },
        "route-not-ready": {
            "action": "",
            "reason": "The selected route is not ready on this machine. Switch to a live model or import a smaller local tag before retrying.",
        },
        "validation-failure": {
            "action": "repair",
            "reason": "Tool loop failed after execution. Repair or retry the bounded loop.",
        },
        "risky-interrupt": {
            "action": "",
            "reason": "Tool loop is waiting on manual approval.",
        },
    }.get(kind, {})


def _tool_loop_failure_class(result: dict[str, Any], runtime_failure: dict[str, Any]) -> dict[str, Any]:
    if runtime_failure:
        return build_failure_class(
            code=str(runtime_failure.get("kind") or "tool-loop-failure"),
            summary=str(runtime_failure.get("message") or ""),
            stage=str(runtime_failure.get("stage") or "tool-loop"),
            retryable=bool(runtime_failure.get("retryable", False)),
            blocking=bool(runtime_failure.get("blocking", False)),
            metadata={
                "retry_policy": dict(runtime_failure.get("retry_policy") or {}),
                "details": dict(runtime_failure.get("details") or {}),
            },
        )
    if bool(result.get("pending_approvals")):
        return build_failure_class(
            code="risky-interrupt",
            summary="Tool loop is waiting on manual approval.",
            stage="tool-loop",
            retryable=False,
            blocking=True,
        )
    if not bool(result.get("ok")):
        code = _tool_loop_failure_kind(result)
        return build_failure_class(
            code=code,
            summary=_tool_loop_result_summary(result) or "Tool loop failed.",
            stage="tool-loop",
            retryable=code in {"empty-proposal", "invalid-change-set", "validation-failure"},
            blocking=False,
        )
    return {}


def _tool_loop_recovery_ladder(result: dict[str, Any], runtime_run: dict[str, Any]) -> dict[str, Any]:
    failure_kind = _tool_loop_failure_kind(result)
    if bool(result.get("pending_approvals")):
        state = "blocked"
        current_step = "interrupt-or-rollback"
        next_step = "interrupt-or-rollback"
    elif bool(result.get("ok")):
        state = "completed"
        current_step = "continue-stop"
        next_step = ""
    elif failure_kind == "empty-proposal":
        state = "failed"
        current_step = "research-expansion"
        next_step = "research-expansion"
    elif failure_kind == "invalid-change-set":
        state = "failed"
        current_step = "bridge-plan-retry"
        next_step = "bridge-plan-retry"
    elif failure_kind == "route-not-ready":
        state = "failed"
        current_step = "interrupt-or-rollback"
        next_step = ""
    else:
        state = "failed"
        current_step = "repair-oriented-route"
        next_step = "repair-oriented-route"
    return build_recovery_ladder_state(
        state=state,
        current_step=current_step,
        next_step=next_step,
        available_steps=RECOVERY_LADDER_STEPS,
        history=[
            {
                "stage": str(item.get("stage") or ""),
                "state": str(item.get("state") or ""),
                "summary": str(item.get("summary") or ""),
                "entered_at": str(item.get("timestamp") or item.get("entered_at") or ""),
            }
            for item in list(result.get("runtime_events") or [])
            if isinstance(item, dict) and str(item.get("summary") or "")
        ][-8:],
        metadata={
            "run_state": str(runtime_run.get("state") or ""),
            "failure_code": failure_kind,
            "tool_call_count": len(list(result.get("tool_audit_trail") or [])),
            "pending_approval_count": len(list(result.get("pending_approvals") or [])),
        },
    )


def _tool_loop_interrupt_request(result: dict[str, Any]) -> dict[str, Any]:
    pending_approvals = [dict(item) for item in list(result.get("pending_approvals") or []) if isinstance(item, dict)]
    if pending_approvals:
        return build_interrupt_request(
            kind="approval",
            summary=f"{len(pending_approvals)} approval request(s) pending before the tool loop can continue.",
            active=True,
            requested_action="approve-risky-action",
            allowed_actions=["approve-risky-action", "open-trace", "resume-interrupted-task"],
            request_count=len(pending_approvals),
            metadata={"requests": pending_approvals[:5]},
        )
    failure_kind = _tool_loop_failure_kind(result)
    if failure_kind and not bool(result.get("ok")):
        return build_interrupt_request(
            kind="runtime-block",
            summary=str(result.get("summary") or "Tool loop blocked."),
            active=True,
            requested_action="retry-with-research" if failure_kind == "empty-proposal" else ("bridge-plan-retry" if failure_kind == "invalid-change-set" else ("open-trace" if failure_kind == "route-not-ready" else "repair-loop")),
            allowed_actions=["open-trace", "open-files", "retry-with-research", "bridge-plan-retry", "repair-loop", "rollback-last-pass"],
            request_count=1,
            metadata={"failure_kind": failure_kind},
        )
    return {}


def _tool_loop_review_bundle(result: dict[str, Any]) -> dict[str, Any]:
    review_summary = dict(result.get("review_summary") or {})
    review_requests = [dict(item) for item in list(result.get("review_requests") or []) if isinstance(item, dict)]
    failure_kind = _tool_loop_failure_kind(result)
    verdict = (
        "pending-review"
        if bool(review_summary.get("requires_manual_review"))
        else (
            "approved-with-warnings"
            if bool(result.get("ok")) and int(review_summary.get("low_confidence_patch_count") or 0) > 0
            else (
                "approved"
                if bool(result.get("ok"))
                else ("repair-required" if failure_kind in {"empty-proposal", "invalid-change-set", "validation-failure"} else "blocked")
            )
        )
    )
    first_request = review_requests[0] if review_requests else {}
    changed_files = _merge_changed_file_sets(
        list((dict(result.get("runtime_context") or {}).get("changed_files") or [])),
        _tool_loop_observed_changed_files(result),
    )
    change_summary = (
        f"{len(changed_files)} changed file(s) touched"
        + (f", starting with {changed_files[0].get('path') or ''}" if changed_files else "")
        if changed_files
        else "No changed files were captured yet."
    )
    review_reason = str(review_summary.get("summary") or first_request.get("summary") or "").strip()
    review_next_action = str(review_summary.get("next_action") or review_summary.get("nextAction") or first_request.get("next_action") or first_request.get("nextAction") or "").strip()
    if verdict == "pending-review":
        reason = review_reason or "The tool loop is waiting on manual review before it can continue."
        how_to_fix = review_next_action or "Review the held tool-loop findings and clear the pending approval items."
        fix_actions = ["review-interrupt", "open-files", "open-trace"]
    elif verdict == "repair-required":
        reason = review_reason or (
            "The tool loop needs another bounded repair pass before approval."
            if failure_kind == "validation-failure"
            else "The tool loop needs another bounded retry before it can be approved."
        )
        how_to_fix = review_next_action or (
            "Retry with more repo research before generating the next step."
            if failure_kind == "empty-proposal"
            else "Repair the failing step and rerun the smallest relevant validation."
        )
        fix_actions = ["retry-with-research" if failure_kind == "empty-proposal" else "repair-loop", "open-trace", "open-files"]
    elif verdict == "approved-with-warnings":
        reason = review_reason or "The tool loop succeeded, but low-confidence findings still deserve a spot check."
        how_to_fix = review_next_action or "Inspect the proposed file set and rerun the most relevant checks before promotion."
        fix_actions = ["open-files", "open-trace", "continue-run"]
    elif verdict == "approved":
        reason = review_reason or "The tool loop cleared the current review and validation gates."
        how_to_fix = review_next_action or "Keep the next step bounded and continue from the latest objective."
        fix_actions = ["continue-run", "open-files"]
    else:
        reason = review_reason or "The tool loop is blocked by the current runtime or review gate."
        how_to_fix = review_next_action or "Inspect the trace, fix the blocking issue, and retry the next bounded step."
        fix_actions = ["review-interrupt", "rollback-last-pass", "open-trace"]
    return build_review_bundle(
        verdict=verdict,
        decision_label={
            "pending-review": "Review required",
            "repair-required": "Repair required",
            "approved-with-warnings": "Approved with warnings",
            "approved": "Approved",
            "blocked": "Blocked",
        }.get(verdict, "Observed"),
        summary=str(review_summary.get("summary") or ""),
        reason=reason,
        how_to_fix=how_to_fix,
        change_summary=change_summary,
        approval_state=verdict,
        approved=verdict in {"approved", "approved-with-warnings"},
        requires_manual_review=bool(review_summary.get("requires_manual_review")),
        request_count=len(review_requests),
        pending_count=int(review_summary.get("pending_review_count") or 0),
        fix_actions=fix_actions,
        review_requests=review_requests[:5],
        metadata={
            "failure_kind": failure_kind,
            "low_confidence_patch_count": int(review_summary.get("low_confidence_patch_count") or 0),
        },
    )


def _tool_loop_workbench_artifacts(result: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in _tool_loop_execution_rows(result):
        step = dict(item.get("step") or {})
        step_result = dict(item.get("result") or {})
        step_path = str(step.get("path") or "")
        if not step_path:
            step_path = str(step_result.get("path") or step_result.get("output_path") or "")
        if step_path:
            rows.append(
                build_workbench_artifact(
                    kind="planned-file",
                    label=step_path,
                    path=step_path,
                    summary=str(step.get("action") or "planned step"),
                    status="planned",
                )
            )
        artifact_path = str(step_result.get("artifact") or step_result.get("output_path") or "")
        if not artifact_path:
            continue
        rows.append(
            build_workbench_artifact(
                kind="tool-loop-artifact",
                label=artifact_path.split("/")[-1].split("\\")[-1],
                path=artifact_path,
                summary=str(step_result.get("message") or step.get("action") or "tool loop artifact"),
                status="available",
            )
        )
    return rows[:8]


def _tool_loop_checkpoint_ref(result: dict[str, Any], runtime_run: dict[str, Any]) -> dict[str, Any]:
    execution_rows = _tool_loop_execution_rows(result)
    planned_paths = [
        str(dict(item.get("step") or {}).get("path") or "")
        for item in execution_rows
        if str(dict(item.get("step") or {}).get("path") or "")
    ]
    return build_checkpoint_ref(
        ref_id=str(runtime_run.get("run_id") or result.get("status") or "tool-loop"),
        label="tool-loop-checkpoint",
        kind="tool-loop-run",
        path="",
        summary="Latest tool-loop state captured for retry, review, and approval follow-up.",
        metadata={
            "planned_paths": planned_paths[:8],
            "pending_approval_count": len(list(result.get("pending_approvals") or [])),
            "tool_call_count": len(list(result.get("tool_audit_trail") or [])),
        },
    )


def _planner_handler(orchestrator, _agent, task, payload):
    context = dict(task.context or {})
    plan_steps = list(context.get("steps") or [])
    search_pattern = str(context.get("search_pattern") or "**/*")
    explicit_paths = _extract_explicit_objective_paths(task.objective)
    tasks_payload = orchestrator.execute_tool("planner", "list_tasks", board_path=context.get("board_path", "docs/BAT_FEATURE_BOARD.md"))
    search_payload = orchestrator.execute_tool(
        "planner",
        "search_repo",
        pattern=search_pattern,
        query=task.objective,
        editor_context=context.get("editor_context"),
        limit=5,
    )

    if not plan_steps:
        synthesized_edit = _synthesize_append_section_step(task.objective, explicit_paths)
        if synthesized_edit:
            plan_steps = [synthesized_edit]
        else:
            target_files = [str(item) for item in context.get("target_files", []) if str(item).strip()]
            for path in explicit_paths:
                if path not in target_files:
                    target_files.append(path)
            if target_files:
                if context.get("content_by_path") or str(context.get("default_content") or '').strip():
                    plan_steps = [
                        {
                            "action": "edit_file",
                            "path": item,
                            "content": context.get("content_by_path", {}).get(item, context.get("default_content", "")),
                            "mode": context.get("edit_mode", "replace"),
                        }
                        for item in target_files
                    ]
                else:
                    plan_steps = _synthesized_execution_steps(target_files, task.objective, context)
            else:
                ranked_matches = [
                    str(item.get("path") or "").strip()
                    for item in list((search_payload or {}).get("ranked_matches", []) or [])
                    if isinstance(item, dict) and str(item.get("path") or "").strip()
                ]
                matches = ranked_matches or list((search_payload or {}).get("matches", []))
                if _objective_requires_write(task.objective, context):
                    non_low_signal_matches = [item for item in matches if not _is_low_signal_mutation_target(item)]
                    if non_low_signal_matches:
                        matches = non_low_signal_matches
                    else:
                        matches = _merge_target_candidates(
                            _discover_repo_mutation_targets(context.get("project_root"), limit=6),
                            matches,
                            limit=6,
                        )
                plan_steps = _synthesized_execution_steps(matches[:3], task.objective, context)

    return {
        "status": "completed",
        "summary": f"Prepared {len(plan_steps)} tool-loop step(s).",
        "payload": {
            "task": {"objective": task.objective, "ticket": task.ticket},
            "tasks_payload": tasks_payload,
            "search_payload": search_payload,
            "plan": {
                "objective": task.objective,
                "ticket": task.ticket,
                "steps": plan_steps,
            },
        },
    }


def _implementer_handler(orchestrator, _agent, _task, payload):
    data = dict(payload or {})
    plan = dict(data.get("plan") or {})
    task_payload = dict(data.get('task') or {})
    objective = str(task_payload.get('objective') or '')
    context = dict(orchestrator._active_context() or {})
    provider = context.get('provider')
    normalized_editor_context = normalize_editor_context(context.get('editor_context') or context.get('editorContext') or {})
    executed: list[dict[str, Any]] = []
    blocked = False
    failed_result: dict[str, Any] | None = None

    for step in list(plan.get("steps") or []):
        action = str(step.get("action") or "").strip().lower()
        if action == "inspect_file":
            result = orchestrator.execute_tool("implementer", "read_file", path=step.get("path"), start_line=1, end_line=120)
        elif action in {"synthesize_edit", "modify_file"}:
            target_path = str(step.get('path') or '').strip()
            try:
                file_snapshot = orchestrator.execute_tool("implementer", "read_file", path=target_path, start_line=1, end_line=240)
            except Exception as exc:
                file_snapshot = {'ok': False, 'error': str(exc), 'path': target_path}
            if isinstance(file_snapshot, dict) and file_snapshot.get('ok') is False and not _is_missing_file_read(file_snapshot):
                result = file_snapshot
            else:
                selected = _select_synthesized_patch(
                    provider,
                    objective,
                    target_path,
                    str((file_snapshot or {}).get('content') or ''),
                    editor_context=normalized_editor_context,
                )
                if not selected.get('ok'):
                    result = {
                        'ok': False,
                        'error': str(selected.get('error') or 'synthesized edit failed'),
                        'path': target_path,
                        'selection': dict(selected.get('selection') or {}),
                    }
                else:
                    result = orchestrator.execute_tool(
                        'implementer',
                        'edit_file',
                        path=target_path,
                        content=str(selected.get('content') or ''),
                        mode='replace',
                    )
                    if isinstance(result, dict):
                        result['selection'] = dict(selected.get('selection') or {})
        elif action == "edit_file":
            result = orchestrator.execute_tool(
                "implementer",
                "edit_file",
                path=step.get("path"),
                content=step.get("content", ""),
                mode=step.get("mode", "replace"),
            )
        elif action == "smart_patch":
            result = orchestrator.execute_tool(
                "implementer",
                "smart_patch",
                patch_text=step.get("patch_text") or step.get("patchText") or step.get("patch", ""),
                dry_run=bool(step.get("dry_run", step.get("dryRun", False))),
                allow_partial=bool(step.get("allow_partial", step.get("allowPartial", False))),
            )
        elif action == "run_command":
            result = orchestrator.execute_tool(
                "implementer",
                "run_command",
                command=step.get("command") or step.get("cmd"),
                cwd=step.get("cwd"),
                timeout=int(step.get("timeout", 60) or 60),
            )
        else:
            result = {"ok": False, "error": f"unknown step action: {action}", "step": step}
        executed.append({"step": step, "result": result})
        if isinstance(result, dict) and result.get("pending_approval"):
            blocked = True
            break
        if isinstance(result, dict) and result.get('ok') is False:
            failed_result = dict(result)
            break

    return {
        "status": "blocked" if blocked else ("failed" if failed_result else "completed"),
        "summary": (
            "Awaiting approval for controlled edits."
            if blocked
            else (
                str(failed_result.get('error') or failed_result.get('message') or 'Tool-loop execution failed.')
                if failed_result
                else f"Executed {len(executed)} tool-loop step(s)."
            )
        ),
        "payload": {
            **data,
            "execution": executed,
            "pending_approvals": orchestrator.pending_approvals(),
        },
    }


def _validator_handler(orchestrator, _agent, task, payload):
    data = dict(payload or {})
    context = dict(task.context or {})
    git_status = orchestrator.execute_tool("validator", "git_status")
    pending = list(data.get("pending_approvals") or []) or orchestrator.pending_approvals()
    runtime_context = extract_runtime_context(context)
    failure_checks = list(dict(runtime_context.get('failure_output') or {}).get('checks') or [])
    validation_command = ''
    if failure_checks:
        validation_command = str(dict(failure_checks[0]).get('command') or '').strip()
    elif _is_repair_objective(task.objective, context):
        project_root = Path(str(context.get('project_root') or '')).resolve() if str(context.get('project_root') or '').strip() else None
        if project_root and (project_root / 'package.json').exists():
            validation_command = 'npm test'
    validation_result = None
    if validation_command and not pending:
        validation_result = orchestrator.execute_tool(
            'validator',
            'run_command',
            command=validation_command,
            cwd=str(context.get('project_root') or ''),
            timeout=120,
        )
    validation_rows = []
    if isinstance(validation_result, dict) and not validation_result.get('pending_approval'):
        validation_rows.append(
            {
                'command': validation_command,
                'ok': bool(validation_result.get('ok', False)),
                'returncode': int(validation_result.get('returncode') or 0),
                'stdout': str(validation_result.get('stdout') or ''),
                'stderr': str(validation_result.get('stderr') or ''),
            }
        )
    valid = not pending and (not validation_rows or all(bool(item.get('ok')) for item in validation_rows))
    status = 'blocked' if pending else ('failed' if not valid else 'completed')
    summary = 'Validation deferred until approvals are resolved.' if pending else ('Validation snapshot captured.' if valid else _validation_failure_summary(validation_rows))
    return {
        "status": status,
        "summary": summary,
        "payload": {
            **data,
            "validation": {
                "git_status": git_status,
                "valid": valid,
                "results": validation_rows,
            },
            "pending_approvals": pending,
        },
    }


def _repair_handler(_orchestrator, _agent, _task, payload):
    data = dict(payload or {})
    return {
        "status": "completed",
        "summary": "Repair loop idle.",
        "payload": {
            **data,
            "repair": {"attempted": False},
        },
    }


def _release_handler(orchestrator, _agent, _task, payload):
    data = dict(payload or {})
    pending = list(data.get("pending_approvals") or []) or orchestrator.pending_approvals()
    return {
        "status": "blocked" if pending else "completed",
        "summary": "Release snapshot blocked pending approval." if pending else "Release snapshot ready.",
        "payload": {
            **data,
            "release": {
                "status": "ready" if not pending else "blocked",
                "pending_approvals": pending,
            },
        },
    }


def build_tool_loop_orchestrator(project_root, *, approval_gate: ApprovalGate | None = None) -> SequentialAgentOrchestrator:
    return SequentialAgentOrchestrator(
        tool_registry=build_default_tool_registry(project_root),
        handlers={
            "planner": _planner_handler,
            "implementer": _implementer_handler,
            "validator": _validator_handler,
            "repair": _repair_handler,
            "release": _release_handler,
        },
        approval_gate=approval_gate,
    )


def run_tool_loop(
    *,
    project_root,
    objective: str,
    ticket: str | None = None,
    context: dict[str, Any] | None = None,
    approval_gate: ApprovalGate | None = None,
    provider: Any = None,
    max_steps: int = 10,
) -> dict[str, Any]:
    orchestrator = build_tool_loop_orchestrator(project_root, approval_gate=approval_gate)
    task_context = dict(context or {})
    task_context["provider"] = provider
    runtime_task_metadata = {
        'task_mode': str(task_context.get('task_mode') or task_context.get('taskMode') or '').strip().lower(),
        'lane_id': str(task_context.get('lane_id') or task_context.get('laneId') or '').strip().lower(),
        'lane_label': str(task_context.get('lane_label') or task_context.get('laneLabel') or '').strip(),
    }
    runtime_task = build_runtime_task(
        ticket_id=str(ticket or ""),
        desc=str(objective or ""),
        action="orchestrate",
        mode="tool-loop",
        run_mode="manual",
        editor_context=task_context.get("editor_context") or task_context.get("editorContext") or {},
        host_boundary=task_context.get("host_boundary") or task_context.get("hostBoundary") or {},
        requested_capabilities={"tool_execution": True},
        metadata=runtime_task_metadata,
    )
    runtime_run = build_runtime_run(task=runtime_task)
    orchestration_payload = {
        "runtime_task": runtime_task,
        "runtime_run": runtime_run,
        "runtime_events": [],
    }
    orchestration = RuntimeOrchestrationDriver(orchestration_payload, ticket_id=str(ticket or ""))
    orchestration.enter_stage(
        next_state="planning",
        stage="tool-loop",
        summary="tool loop planning prepared",
        objective=objective,
    )
    orchestration.enter_stage(
        next_state="executing",
        stage="tool-loop",
        summary="tool loop started",
        objective=objective,
    )
    runtime_run = orchestration_payload["runtime_run"]
    task_context["runtime_task"] = runtime_task
    task_context["runtime_run"] = runtime_run
    task_context["runtime_context"] = build_runtime_context(
        project_root,
        ticket_id=str(ticket or ""),
        desc=str(objective or ""),
        editor_context=task_context.get("editor_context") or task_context.get("editorContext"),
        validation=dict(task_context.get('validation') or {}),
        repair=dict(task_context.get('repair') or {}),
        artifact_paths=list(task_context.get('artifact_paths') or task_context.get('artifactPaths') or []),
        approval_state=orchestrator.approval_state(),
        permission_state=orchestrator.permission_state(),
        host_boundary=task_context.get("host_boundary") or task_context.get("hostBoundary") or {},
    )
    preflight = _tool_loop_provider_preflight(provider, task_context)
    task = OrchestrationTask(objective=objective, ticket=ticket, context=task_context)
    if not preflight.get('ok', False):
        result = {
            'ok': False,
            'status': 'failed',
            'summary': str(preflight.get('message') or 'Provider preflight failed.'),
            'trace': [
                {
                    'agent': 'provider-preflight',
                    'status': 'failed',
                    'summary': str(preflight.get('message') or 'Provider preflight failed.'),
                }
            ],
            'payload': {'execution': [], 'pending_approvals': []},
            'tool_audit_trail': [],
            'tool_runtime_events': [],
        }
    else:
        result = orchestrator.run(task, max_steps=max_steps)
    result["pending_approvals"] = orchestrator.pending_approvals()
    result["approval_state"] = orchestrator.approval_state()
    result["review_requests"] = orchestrator.review_requests()
    result["review_state"] = dict(result["approval_state"].get("review_state") or {})
    result["permission_state"] = orchestrator.permission_state()
    result["runtime_context"] = build_runtime_context(
        project_root,
        ticket_id=str(ticket or ""),
        desc=str(objective or ""),
        editor_context=task_context.get("editor_context") or task_context.get("editorContext"),
        validation=dict((result.get('payload', {}) or {}).get('validation') or task_context.get('validation') or {}),
        repair=dict((result.get('payload', {}) or {}).get('repair') or task_context.get('repair') or {}),
        artifact_paths=list(task_context.get('artifact_paths') or task_context.get('artifactPaths') or []),
        approval_state=result["approval_state"],
        permission_state=result["permission_state"],
        host_boundary=task_context.get("host_boundary") or task_context.get("hostBoundary") or {},
    )
    observed_changed_files = _tool_loop_observed_changed_files(result)
    if observed_changed_files:
        result["runtime_context"]["changed_files"] = _merge_changed_file_sets(
            list((result.get("runtime_context") or {}).get("changed_files") or []),
            observed_changed_files,
        )
    result["requires_approval"] = bool(result["pending_approvals"])
    result["review_summary"] = build_review_summary(
        execution_results=[item.get("result") for item in list(result.get("payload", {}).get("execution", []) or []) if isinstance(item, dict)],
        pending_approvals=list(result.get("pending_approvals") or []),
        runtime_context={
            "run_id": runtime_run.get("run_id"),
            "task_id": runtime_task.get("task_id"),
            "ticket": runtime_task.get("ticket"),
            **dict(result.get("runtime_context") or {}),
        },
    )
    final_state = "blocked" if result["requires_approval"] else ("succeeded" if result.get("ok") else "failed")
    orchestration_payload["runtime_run"] = runtime_run
    if final_state == "succeeded":
        orchestration.enter_stage(
            next_state="releasing",
            stage="tool-loop",
            summary="tool loop packaging runtime outputs",
            status=result.get("status"),
            tool_call_count=len(result.get("tool_audit_trail") or []),
            approval_pending_count=len(result.get("pending_approvals") or []),
        )
    orchestration.enter_stage(
        next_state=final_state,
        stage="tool-loop",
        summary="tool loop blocked pending approval" if final_state == "blocked" else ("tool loop completed" if final_state == "succeeded" else "tool loop failed"),
        status=result.get("status"),
        tool_call_count=len(result.get("tool_audit_trail") or []),
        approval_pending_count=len(result.get("pending_approvals") or []),
    )
    runtime_run = orchestration_payload["runtime_run"]
    runtime_failure = {}
    if final_state == "failed":
        failure_kind = _tool_loop_failure_kind(result)
        retry_policy = _tool_loop_retry_policy(failure_kind)
        runtime_failure = build_runtime_failure(
            ticket_id=str(ticket or ""),
            run_id=str(runtime_run.get("run_id") or ""),
            task_id=str(runtime_task.get("task_id") or ""),
            stage="tool-loop",
            kind=failure_kind or "tool-loop-failure",
            message=_tool_loop_result_summary(result) or f"tool loop ended with status {result.get('status')}",
            retryable=bool(retry_policy.get("action")),
            blocking=False,
            retry_policy=retry_policy,
            details={
                "trace": list(result.get("trace") or []),
                "planned_step_count": len(_tool_loop_execution_rows(result)),
            },
        )
    task_objective = _tool_loop_task_objective(objective, runtime_task)
    failure_class = _tool_loop_failure_class(result, runtime_failure)
    recovery_ladder = _tool_loop_recovery_ladder(result, runtime_run)
    checkpoint_ref = _tool_loop_checkpoint_ref(result, runtime_run)
    interrupt_request = _tool_loop_interrupt_request(result)
    review_bundle = _tool_loop_review_bundle(result)
    workbench_artifacts = _tool_loop_workbench_artifacts(result)
    result["runtime_task"] = runtime_task
    result["runtime_run"] = runtime_run
    result["runtime_failure"] = runtime_failure
    orchestration_payload["runtime_task"] = runtime_task
    orchestration_payload["runtime_failure"] = runtime_failure
    orchestration.finalize_runtime_result(
        ok=final_state == "succeeded",
        failure=runtime_failure,
        metrics={
            "tool_call_count": len(result.get("tool_audit_trail") or []),
            "approval_pending_count": len(result.get("pending_approvals") or []),
        },
        metadata={"tool_loop_status": result.get("status")},
    )
    result["runtime_result"] = dict(orchestration_payload.get("runtime_result") or {})
    result["runtime_result"]["task_objective"] = dict(task_objective)
    result["runtime_result"]["failure_class"] = dict(failure_class)
    result["runtime_result"]["recovery_ladder"] = dict(recovery_ladder)
    result["runtime_result"]["checkpoint_ref"] = dict(checkpoint_ref)
    result["runtime_result"]["interrupt_request"] = dict(interrupt_request)
    result["runtime_result"]["review_bundle"] = dict(review_bundle)
    result["runtime_result"]["workbench_artifacts"] = list(workbench_artifacts)
    result["runtime_result"]["review_state"] = dict(result.get("review_state") or {})
    result["runtime_result"]["review_summary"] = dict(result.get("review_summary") or {})
    result["runtime_events"] = list(orchestration_payload.get("runtime_events") or []) + list(result.get("tool_runtime_events") or [])
    return result
