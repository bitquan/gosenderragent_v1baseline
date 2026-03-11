from __future__ import annotations

import inspect
import re
import subprocess
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Callable

from backend.agent.core.notification_service import send_notification
from backend.agent.core.repo_inspection import DEFAULT_IGNORE_DIRS, repo_search


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
        if signature is not None and "context" in signature.parameters:
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
        "path": str(target.relative_to(project_root)),
        "content": content,
        "line_count": len(lines),
    }


def _search_repo_tool(project_root: Path, pattern: str, ignore_dirs: set[str] | None = None) -> dict[str, Any]:
    matches = repo_search(project_root, pattern, ignore_dirs=ignore_dirs or DEFAULT_IGNORE_DIRS)
    return {"pattern": pattern, "matches": matches, "count": len(matches)}


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
    return {"path": str(target.relative_to(project_root)), "mode": mode, "bytes_written": len(content.encode("utf-8"))}


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


def _git_status_tool(project_root: Path) -> dict[str, Any]:
    return _run_command_tool(project_root, ["git", "status", "--short"])


def _notify_tool(project_root: Path, url: str, payload: dict[str, Any]) -> dict[str, Any]:
    return send_notification(project_root, url, payload)


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
            implementation=lambda **kwargs: _read_file_tool(project_root, **_strip_reserved_tool_kwargs(kwargs)),
        )
    )
    registry.register_tool(
        ToolDefinition(
            name="search_repo",
            description="Search the repository using a glob pattern.",
            input_schema={"pattern": "str", "ignore_dirs": "set[str]?"},
            safety_level=ToolSafetyLevel.SAFE,
            implementation=lambda **kwargs: _search_repo_tool(project_root, ignore_dirs=dirs, **_strip_reserved_tool_kwargs(kwargs)),
        )
    )
    registry.register_tool(
        ToolDefinition(
            name="list_tasks",
            description="List TODO tickets from the feature board.",
            input_schema={"board_path": "str?"},
            safety_level=ToolSafetyLevel.SAFE,
            implementation=lambda **kwargs: _list_tasks_tool(project_root, **_strip_reserved_tool_kwargs(kwargs)),
        )
    )
    registry.register_tool(
        ToolDefinition(
            name="todo_board",
            description="Legacy alias for listing TODO tickets from the feature board.",
            input_schema={"board_path": "str?"},
            safety_level=ToolSafetyLevel.SAFE,
            implementation=lambda **kwargs: _todo_board_tool(project_root, **_strip_reserved_tool_kwargs(kwargs)),
        )
    )
    registry.register_tool(
        ToolDefinition(
            name="edit_file",
            description="Create or update a repository file.",
            input_schema={"path": "str", "content": "str", "mode": "replace|append"},
            safety_level=ToolSafetyLevel.CONTROLLED,
            implementation=lambda **kwargs: _edit_file_tool(project_root, **_strip_reserved_tool_kwargs(kwargs)),
        )
    )
    registry.register_tool(
        ToolDefinition(
            name="run_command",
            description="Run a shell command within the repository.",
            input_schema={"command": "str|list[str]", "cwd": "str?", "timeout": "int?"},
            safety_level=ToolSafetyLevel.PRIVILEGED,
            implementation=lambda **kwargs: _run_command_tool(project_root, **_strip_reserved_tool_kwargs(kwargs)),
        )
    )
    registry.register_tool(
        ToolDefinition(
            name="git_status",
            description="Get short git working tree status.",
            input_schema={},
            safety_level=ToolSafetyLevel.CONTROLLED,
            implementation=lambda **kwargs: _git_status_tool(project_root),
        )
    )
    registry.register_tool(
        ToolDefinition(
            name="notify",
            description="Send a notification payload to a webhook URL.",
            input_schema={"url": "str", "payload": "dict[str, Any]"},
            safety_level=ToolSafetyLevel.CONTROLLED,
            implementation=lambda **kwargs: _notify_tool(project_root, **_strip_reserved_tool_kwargs(kwargs)),
        )
    )
    return registry
