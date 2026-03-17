from __future__ import annotations

import inspect
import json
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Callable

from backend.agent.core.notification_service import send_notification
from backend.agent.core.repo_inspection import DEFAULT_IGNORE_DIRS, rank_related_files, repo_search
from backend.agent.core.runtime_context import extract_runtime_context
from backend.agent.core.storage_paths import assistant_dev_runs_dir, assistant_runs_dir, assistant_test_artifacts_dir


class ToolRegistrationError(ValueError):
    pass


class ToolNotFoundError(KeyError):
    pass


class ToolExecutionError(RuntimeError):
    pass


class ToolSafetyLevel(str, Enum):
    SAFE = "safe"
    CONTROLLED = "controlled"
    PRIVILEGED = "privileged"


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    input_schema: dict[str, Any] | list[str] | str | None
    safety_level: ToolSafetyLevel
    implementation: Callable[..., Any]
    boundary: dict[str, Any] | None = None

    def invoke(self, **kwargs: Any) -> Any:
        return self.implementation(**kwargs)


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolDefinition] = {}

    def register(self, tool: ToolDefinition) -> ToolDefinition:
        if tool.name in self._tools:
            raise ToolRegistrationError(f"tool already registered: {tool.name}")
        self._tools[tool.name] = tool
        return tool

    def register_tool(self, tool: ToolDefinition) -> ToolDefinition:
        return self.register(tool)

    def get(self, name: str) -> ToolDefinition:
        if name not in self._tools:
            raise ToolNotFoundError(f"unknown tool: {name}")
        return self._tools[name]

    def get_tool(self, name: str) -> ToolDefinition:
        return self.get(name)

    def list_tools(self) -> list[ToolDefinition]:
        return [self._tools[name] for name in sorted(self._tools)]

    def call(self, name: str, **kwargs: Any) -> Any:
        return self.get(name).invoke(**kwargs)

    def run_tool(self, name: str, args: dict[str, Any] | None = None, context: dict[str, Any] | None = None) -> Any:
        tool = self.get_tool(name)
        payload = dict(args or {})
        if context is None:
            return tool.invoke(**payload)
        try:
            signature = inspect.signature(tool.implementation)
        except (TypeError, ValueError):
            signature = None
        accepts_kwargs = bool(signature and any(param.kind == inspect.Parameter.VAR_KEYWORD for param in signature.parameters.values()))
        if signature is not None and ("context" in signature.parameters or accepts_kwargs):
            payload["context"] = context
        return tool.invoke(**payload)


def _strip_reserved_tool_kwargs(kwargs: dict[str, Any]) -> dict[str, Any]:
    clean = dict(kwargs)
    clean.pop("context", None)
    return clean


def _resolve_repo_path(project_root: Path, path: str) -> Path:
    target = (project_root / path).resolve()
    root = project_root.resolve()
    if target != root and root not in target.parents:
        raise ToolExecutionError(f"path escapes project root: {path}")
    return target


def _relative_repo_path(project_root: Path, target: Path) -> str:
    return str(target.relative_to(project_root.resolve()))


def _display_path(project_root: Path, target: Path) -> str:
    try:
        return _relative_repo_path(project_root, target)
    except ValueError:
        return str(target)


def _runtime_editor_context(context: dict[str, Any] | None) -> dict[str, Any]:
    runtime_context = extract_runtime_context(context)
    return dict(runtime_context.get("editor_context") or {})


def _runtime_related_files(context: dict[str, Any] | None) -> list[str]:
    runtime_context = extract_runtime_context(context)
    return [str(path).strip() for path in list(runtime_context.get("related_files", []) or []) if str(path).strip()]


def _runtime_changed_files(context: dict[str, Any] | None) -> list[str]:
    runtime_context = extract_runtime_context(context)
    return [
        str(item.get("path") or "").strip()
        for item in list(runtime_context.get("changed_files", []) or [])
        if isinstance(item, dict) and str(item.get("path") or "").strip()
    ]


def _runtime_artifact_context(context: dict[str, Any] | None) -> dict[str, Any]:
    runtime_context = extract_runtime_context(context)
    return dict(runtime_context.get("artifact_context") or {})


def _read_file_tool(project_root: Path, path: str, start_line: int | None = None, end_line: int | None = None) -> dict[str, Any]:
    target = _resolve_repo_path(project_root, path)
    text = target.read_text(encoding="utf-8")
    lines = text.splitlines()
    if start_line is not None or end_line is not None:
        start = max((start_line or 1) - 1, 0)
        end = end_line or len(lines)
        content = "\n".join(lines[start:end])
    else:
        content = text
    return {
        "path": _relative_repo_path(project_root, target),
        "content": content,
        "line_count": len(lines),
    }


def _search_repo_tool(
    project_root: Path,
    pattern: str,
    ignore_dirs: set[str] | None = None,
    query: str | None = None,
    editor_context: dict[str, Any] | None = None,
    limit: int = 20,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    effective_editor_context = editor_context or _runtime_editor_context(context)
    matches = repo_search(project_root, pattern, ignore_dirs=ignore_dirs or DEFAULT_IGNORE_DIRS)
    ranked_matches = rank_related_files(
        project_root,
        candidates=matches,
        query=str(query or ""),
        editor_context=effective_editor_context,
        ignore_dirs=ignore_dirs or DEFAULT_IGNORE_DIRS,
        limit=limit,
    ) if (query or effective_editor_context) else []
    ordered_matches = [item["path"] for item in ranked_matches] if ranked_matches else matches
    return {
        "pattern": pattern,
        "matches": ordered_matches,
        "count": len(matches),
        "ranked_matches": ranked_matches,
    }


def _list_files_tool(
    project_root: Path,
    pattern: str = "**/*",
    include_dirs: bool = False,
    ignore_dirs: set[str] | None = None,
    limit: int = 200,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    prioritized = _runtime_related_files(context)
    matches = repo_search(project_root, pattern, ignore_dirs=ignore_dirs or DEFAULT_IGNORE_DIRS)
    if not include_dirs:
        matches = [match for match in matches if (project_root / match).is_file()]
    ordered: list[str] = []
    seen: set[str] = set()
    for group in (prioritized, matches):
        for match in group:
            if match in seen or match not in matches:
                continue
            seen.add(match)
            ordered.append(match)
    return {
        "pattern": pattern,
        "matches": ordered[: max(1, int(limit or 200))],
        "count": len(matches),
        "truncated": len(matches) > max(1, int(limit or 200)),
        "include_dirs": bool(include_dirs),
    }


def _edit_file_tool(project_root: Path, path: str, content: str, mode: str = "replace") -> dict[str, Any]:
    target = _resolve_repo_path(project_root, path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if mode == "append":
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(content)
    elif mode == "replace":
        target.write_text(content, encoding="utf-8")
    else:
        raise ToolExecutionError(f"unsupported edit mode: {mode}")
    return {"path": _relative_repo_path(project_root, target), "mode": mode, "bytes_written": len(content.encode("utf-8"))}


def _smart_patch_tool(
    project_root: Path,
    patch_text: str | None = None,
    patch: str | None = None,
    patchText: str | None = None,
    dry_run: bool = True,
    allow_partial: bool = False,
) -> dict[str, Any]:
    payload = str(patch_text or patchText or patch or "")
    if not payload.strip():
        raise ToolExecutionError("smart_patch requires patch_text")

    script_path = project_root / "scripts" / "smart-patch.js"
    if not script_path.exists():
        raise ToolExecutionError(f"smart patch script not found: {script_path}")

    command = [
        "node",
        str(script_path),
        "--workspace",
        str(project_root),
        "--json",
    ]
    if dry_run:
        command.append("--dry-run")
    if allow_partial:
        command.append("--allow-partial")

    proc = subprocess.run(
        command,
        cwd=str(project_root),
        input=payload,
        capture_output=True,
        text=True,
        check=False,
    )

    stdout = str(proc.stdout or "").strip()
    if not stdout:
        raise ToolExecutionError(f"smart patch tool returned no output (exit {proc.returncode})")

    try:
        result = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise ToolExecutionError(f"smart patch tool returned invalid JSON: {exc}") from exc

    if not isinstance(result, dict):
        raise ToolExecutionError("smart patch tool returned a non-object payload")

    result["command"] = command
    result["returncode"] = proc.returncode
    if proc.stderr:
        result["stderr"] = proc.stderr
    return result


def _run_command_tool(project_root: Path, command: str | list[str], cwd: str | None = None, timeout: int = 60) -> dict[str, Any]:
    working_dir = _resolve_repo_path(project_root, cwd) if cwd else project_root
    shell = isinstance(command, str)
    proc = subprocess.run(
        command,
        cwd=str(working_dir),
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout,
        shell=shell,
    )
    return {
        "command": command,
        "cwd": str(working_dir.relative_to(project_root) if working_dir != project_root else Path(".")),
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "returncode": proc.returncode,
        "ok": proc.returncode == 0,
    }


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", str(value or "").strip().lower()).strip("-")
    return slug or "artifact"


def _run_tests_tool(
    project_root: Path,
    command: str | list[str],
    cwd: str | None = None,
    timeout: int = 180,
    artifact_name: str | None = None,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    del context
    result = _run_command_tool(project_root, command, cwd=cwd, timeout=timeout)
    artifacts_dir = assistant_test_artifacts_dir(project_root)
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc)
    base_name = artifact_name or (" ".join(command) if isinstance(command, list) else str(command))
    target = artifacts_dir / f"{stamp.strftime('%Y%m%dT%H%M%S')}-{_slugify(base_name)[:80]}.json"
    payload = {
        "timestamp": stamp.isoformat(),
        "command": command,
        "cwd": result.get("cwd"),
        "stdout": result.get("stdout"),
        "stderr": result.get("stderr"),
        "returncode": result.get("returncode"),
        "ok": result.get("ok"),
    }
    target.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return {
        **result,
        "artifact_path": _display_path(project_root, target),
    }


def _git_diff_tool(
    project_root: Path,
    paths: list[str] | tuple[str, ...] | None = None,
    staged: bool = False,
    base_ref: str | None = None,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    command: list[str] = ["git", "diff"]
    if staged:
        command.append("--staged")
    if base_ref:
        command.append(str(base_ref))
    normalized_paths = [str(path).strip() for path in (paths or _runtime_changed_files(context) or []) if str(path).strip()]
    if normalized_paths:
        command.append("--")
        command.extend(normalized_paths)
    proc = subprocess.run(command, cwd=str(project_root), capture_output=True, text=True, check=False)
    return {
        "command": command,
        "paths": normalized_paths,
        "staged": bool(staged),
        "base_ref": str(base_ref or ""),
        "diff": proc.stdout,
        "stderr": proc.stderr,
        "returncode": proc.returncode,
        "ok": proc.returncode == 0,
    }


def _git_status_tool(project_root: Path) -> dict[str, Any]:
    return _run_command_tool(project_root, ["git", "status", "--short"])


def _notify_tool(project_root: Path, url: str, payload: dict[str, Any]) -> dict[str, Any]:
    return send_notification(project_root, url, payload)


def _artifact_roots(project_root: Path) -> list[Path]:
    roots: list[Path] = []
    for candidate in (assistant_dev_runs_dir(project_root), assistant_runs_dir(project_root), assistant_test_artifacts_dir(project_root)):
        resolved = candidate.resolve()
        if resolved not in roots:
            roots.append(resolved)
    return roots


def _resolve_artifact_path(project_root: Path, path: str) -> Path:
    roots = _artifact_roots(project_root)
    candidate = Path(path).expanduser()
    if candidate.is_absolute():
        resolved = candidate.resolve()
        if any(resolved == root or root in resolved.parents for root in roots):
            return resolved
        raise ToolExecutionError(f"artifact path escapes allowed roots: {path}")
    project_relative = (project_root.resolve() / candidate).resolve()
    if project_relative.exists() and any(project_relative == root or root in project_relative.parents for root in roots):
        return project_relative
    for root in roots:
        resolved = (root / candidate).resolve()
        if resolved.exists() and (resolved == root or root in resolved.parents):
            return resolved
    fallback = (roots[0] / candidate).resolve()
    if any(fallback == root or root in fallback.parents for root in roots):
        return fallback
    raise ToolExecutionError(f"artifact path escapes allowed roots: {path}")


def _latest_artifact(project_root: Path, artifact_kind: str) -> Path | None:
    kind = str(artifact_kind or "any").strip().lower() or "any"
    if kind == "run":
        roots = [assistant_dev_runs_dir(project_root).resolve()]
    elif kind in {"summary", "human_summary"}:
        roots = [assistant_runs_dir(project_root).resolve()]
    elif kind in {"test", "test_artifact"}:
        roots = [assistant_test_artifacts_dir(project_root).resolve()]
    else:
        roots = _artifact_roots(project_root)

    files: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        files.extend([path for path in root.rglob("*") if path.is_file()])
    if not files:
        return None
    files.sort(key=lambda item: item.stat().st_mtime, reverse=True)
    return files[0]


def _inspect_artifact_tool(
    project_root: Path,
    path: str | None = None,
    artifact_kind: str = "any",
    max_chars: int = 4000,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    artifact_context = _runtime_artifact_context(context)
    default_path = path
    if not default_path:
        referenced = [str(item).strip() for item in list(artifact_context.get("referenced_paths", []) or []) if str(item).strip()]
        default_path = referenced[0] if referenced else ""
    if not default_path:
        default_path = str(artifact_context.get("latest_run_artifact") or artifact_context.get("latest_summary_artifact") or artifact_context.get("latest_test_artifact") or "")
    target = _resolve_artifact_path(project_root, default_path) if default_path else _latest_artifact(project_root, artifact_kind)
    if target is None or not target.exists():
        return {
            "ok": False,
            "artifact_kind": artifact_kind,
            "path": str(path or ""),
            "error": "artifact not found",
        }

    text = target.read_text(encoding="utf-8")
    parsed = None
    content_type = "text"
    if target.suffix.lower() == ".json":
        try:
            parsed = json.loads(text)
            content_type = "json"
        except Exception:
            parsed = None
    return {
        "ok": True,
        "artifact_kind": artifact_kind,
        "path": _display_path(project_root, target),
        "content_type": content_type,
        "updated_at": datetime.fromtimestamp(target.stat().st_mtime, tz=timezone.utc).isoformat(),
        "preview": text[: max(1, int(max_chars or 4000))],
        "data": parsed,
    }


def _todo_board_tool(project_root: Path, board_path: str = "docs/BAT_FEATURE_BOARD.md") -> dict[str, Any]:
    target = _resolve_repo_path(project_root, board_path)
    if not target.exists():
        return {"board": board_path, "todos": [], "count": 0}
    todos: list[dict[str, str]] = []
    pattern = re.compile(r"BAT<(.*?)>.*?(TODO[^\n`]*)", re.IGNORECASE)
    for line in target.read_text(encoding="utf-8").splitlines():
        if "TODO" not in line.upper() or "BAT<" not in line:
            continue
        match = pattern.search(line)
        if match:
            ticket = match.group(1).strip()
        else:
            ticket = ""
        todos.append({"ticket": ticket, "line": line.strip()})
    return {"board": board_path, "todos": todos, "count": len(todos)}


def _list_tasks_tool(project_root: Path, board_path: str = "docs/BAT_FEATURE_BOARD.md") -> dict[str, Any]:
    return _todo_board_tool(project_root, board_path=board_path)


def build_default_tool_registry(project_root: Path, *, ignore_dirs: set[str] | None = None) -> ToolRegistry:
    dirs = ignore_dirs or DEFAULT_IGNORE_DIRS
    registry = ToolRegistry()
    registry.register_tool(
        ToolDefinition(
            name="read_file",
            description="Read a repository file, optionally within a line range.",
            input_schema={"path": "str", "start_line": "int?", "end_line": "int?"},
            safety_level=ToolSafetyLevel.SAFE,
            implementation=lambda context=None, **kwargs: _read_file_tool(project_root, **_strip_reserved_tool_kwargs(kwargs)),
            boundary={"kind": "read", "writes_repo": False, "executes_process": False, "network_access": False},
        )
    )
    registry.register_tool(
        ToolDefinition(
            name="search_repo",
            description="Search the repository using a glob pattern.",
            input_schema={"pattern": "str", "ignore_dirs": "set[str]?", "query": "str?", "editor_context": "dict[str, Any]?", "limit": "int?"},
            safety_level=ToolSafetyLevel.SAFE,
            implementation=lambda context=None, **kwargs: _search_repo_tool(project_root, ignore_dirs=dirs, context=context, **_strip_reserved_tool_kwargs(kwargs)),
            boundary={"kind": "read", "writes_repo": False, "executes_process": False, "network_access": False},
        )
    )
    registry.register_tool(
        ToolDefinition(
            name="list_files",
            description="List repository files using a glob pattern.",
            input_schema={"pattern": "str?", "include_dirs": "bool?", "limit": "int?"},
            safety_level=ToolSafetyLevel.SAFE,
            implementation=lambda context=None, **kwargs: _list_files_tool(project_root, ignore_dirs=dirs, context=context, **_strip_reserved_tool_kwargs(kwargs)),
            boundary={"kind": "read", "writes_repo": False, "executes_process": False, "network_access": False},
        )
    )
    registry.register_tool(
        ToolDefinition(
            name="list_tasks",
            description="List TODO tickets from the feature board.",
            input_schema={"board_path": "str?"},
            safety_level=ToolSafetyLevel.SAFE,
            implementation=lambda context=None, **kwargs: _list_tasks_tool(project_root, **_strip_reserved_tool_kwargs(kwargs)),
            boundary={"kind": "read", "writes_repo": False, "executes_process": False, "network_access": False},
        )
    )
    registry.register_tool(
        ToolDefinition(
            name="todo_board",
            description="Legacy alias for listing TODO tickets from the feature board.",
            input_schema={"board_path": "str?"},
            safety_level=ToolSafetyLevel.SAFE,
            implementation=lambda context=None, **kwargs: _todo_board_tool(project_root, **_strip_reserved_tool_kwargs(kwargs)),
            boundary={"kind": "read", "writes_repo": False, "executes_process": False, "network_access": False},
        )
    )
    registry.register_tool(
        ToolDefinition(
            name="edit_file",
            description="Create or update a repository file.",
            input_schema={"path": "str", "content": "str", "mode": "replace|append"},
            safety_level=ToolSafetyLevel.CONTROLLED,
            implementation=lambda context=None, **kwargs: _edit_file_tool(project_root, **_strip_reserved_tool_kwargs(kwargs)),
            boundary={"kind": "write", "writes_repo": True, "executes_process": False, "network_access": False},
        )
    )
    registry.register_tool(
        ToolDefinition(
            name="smart_patch",
            description="Apply a unified diff with dry-run support and structured reject reporting.",
            input_schema={"patch_text": "str", "dry_run": "bool?", "allow_partial": "bool?"},
            safety_level=ToolSafetyLevel.CONTROLLED,
            implementation=lambda context=None, **kwargs: _smart_patch_tool(project_root, **_strip_reserved_tool_kwargs(kwargs)),
            boundary={"kind": "write", "writes_repo": True, "executes_process": True, "network_access": False},
        )
    )
    registry.register_tool(
        ToolDefinition(
            name="run_command",
            description="Run a shell command within the repository.",
            input_schema={"command": "str|list[str]", "cwd": "str?", "timeout": "int?"},
            safety_level=ToolSafetyLevel.PRIVILEGED,
            implementation=lambda context=None, **kwargs: _run_command_tool(project_root, **_strip_reserved_tool_kwargs(kwargs)),
            boundary={"kind": "exec", "writes_repo": False, "executes_process": True, "network_access": False},
        )
    )
    registry.register_tool(
        ToolDefinition(
            name="run_tests",
            description="Run a focused test command and store the result as an artifact.",
            input_schema={"command": "str|list[str]", "cwd": "str?", "timeout": "int?", "artifact_name": "str?"},
            safety_level=ToolSafetyLevel.PRIVILEGED,
            implementation=lambda context=None, **kwargs: _run_tests_tool(project_root, context=context, **_strip_reserved_tool_kwargs(kwargs)),
            boundary={"kind": "exec", "writes_repo": False, "executes_process": True, "network_access": False},
        )
    )
    registry.register_tool(
        ToolDefinition(
            name="git_diff",
            description="Collect git diff output for the current repository state.",
            input_schema={"paths": "list[str]?", "staged": "bool?", "base_ref": "str?"},
            safety_level=ToolSafetyLevel.SAFE,
            implementation=lambda context=None, **kwargs: _git_diff_tool(project_root, context=context, **_strip_reserved_tool_kwargs(kwargs)),
            boundary={"kind": "inspect", "writes_repo": False, "executes_process": False, "network_access": False},
        )
    )
    registry.register_tool(
        ToolDefinition(
            name="git_status",
            description="Get short git working tree status.",
            input_schema={},
            safety_level=ToolSafetyLevel.SAFE,
            implementation=lambda context=None, **kwargs: _git_status_tool(project_root),
            boundary={"kind": "inspect", "writes_repo": False, "executes_process": True, "network_access": False},
        )
    )
    registry.register_tool(
        ToolDefinition(
            name="inspect_artifact",
            description="Inspect a recent run, summary, or test artifact.",
            input_schema={"path": "str?", "artifact_kind": "run|summary|test|any?", "max_chars": "int?"},
            safety_level=ToolSafetyLevel.SAFE,
            implementation=lambda context=None, **kwargs: _inspect_artifact_tool(project_root, context=context, **_strip_reserved_tool_kwargs(kwargs)),
            boundary={"kind": "artifact-read", "writes_repo": False, "executes_process": False, "network_access": False},
        )
    )
    registry.register_tool(
        ToolDefinition(
            name="notify",
            description="Send a notification payload to a webhook URL.",
            input_schema={"url": "str", "payload": "dict[str, Any]"},
            safety_level=ToolSafetyLevel.CONTROLLED,
            implementation=lambda context=None, **kwargs: _notify_tool(project_root, **_strip_reserved_tool_kwargs(kwargs)),
            boundary={"kind": "network", "writes_repo": False, "executes_process": False, "network_access": True},
        )
    )
    return registry
