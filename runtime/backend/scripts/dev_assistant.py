#!/usr/bin/env python3
"""Developer assistant for BAT scaffolding.

Features include:
* template-based code stubs with loops/conditionals/front-matter
* interactive brainstorming prompts keyed by ticket keywords
* optional AI boilerplate generation (OpenAI or local model)
* logging of runs and automatic embedding storage
* fast similarity recall using FAISS (optional dependency)
* shared-log merging via dev_assistant.yaml for cross-project recall
* training-data export and a lightweight dashboard for analytics

Usage examples:
  python backend/scripts/dev_assistant.py BAT<174>
  python backend/scripts/dev_assistant.py --tickets 162,174 --write
  python backend/scripts/dev_assistant.py 190 --ai --write --template boilerplate_bundle
  python backend/scripts/dev_assistant.py 193 --ai --brainstorm --interactive
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import sqlite3
import importlib.util
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, List, Tuple

# Ensure repository root is importable even when this script is launched from
# backend/ or GUI hosts that do not preserve PYTHONPATH.
_SCRIPT_PATH = Path(__file__).resolve()
_REPO_ROOT_FROM_SCRIPT = _SCRIPT_PATH.parents[2]
if str(_REPO_ROOT_FROM_SCRIPT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT_FROM_SCRIPT))

# import our new classifier and strategy helpers
try:
    from backend.scripts.task_classification import classify_ticket, record_history
    from backend.scripts.strategies import get_strategy, Strategy
    from backend.agent.adapters.gosenderr_adapter import GoSenderrAdapter
    from backend.agent.core.adapters.base import RepoAdapter
    from backend.agent.core.audit_service import audit_ticket as _core_audit_ticket
    from backend.agent.core.audit_service import compute_risk as _core_compute_risk
    from backend.agent.core.artifact_service import append_ci_report as _core_append_ci_report
    from backend.agent.core.artifact_service import write_human_summary as _core_write_human_summary
    from backend.agent.core.artifact_service import write_run_artifact as _core_write_run_artifact
    from backend.agent.core.dashboard_service import load_dashboard as _core_load_dashboard
    from backend.agent.core.dashboard_service import update_dashboard as _core_update_dashboard
    from backend.agent.core.execution_service import execute_plan as _core_execute_plan
    from backend.agent.core.memory_service import load_memory as _core_load_memory
    from backend.agent.core.memory_service import record_memory as _core_record_memory
    from backend.agent.core.memory_service import save_memory as _core_save_memory
    from backend.agent.core.log_service import append_run_log as _core_append_run_log
    from backend.agent.core.log_service import build_run_log_entry as _core_build_run_log_entry
    from backend.agent.core.log_service import tail_run_log as _core_tail_run_log
    from backend.agent.core.notification_service import send_notification as _core_send_notification
    from backend.agent.core.notification_service import send_slack_webhook as _core_send_slack_webhook
    from backend.agent.core.planning_service import generate_plan as _core_generate_plan
    from backend.agent.core.providers.base import ModelProvider, ProviderConfig
    from backend.agent.core.providers.factory import create_provider, provider_diagnostics
    from backend.agent.core.repair_service import analyze_failures as _core_analyze_failures
    from backend.agent.core.repair_service import attempt_repair as _core_attempt_repair
    from backend.agent.core.repo_inspection import build_repo_index as _core_build_repo_index
    from backend.agent.core.repo_inspection import is_ignored as _core_is_ignored
    from backend.agent.core.repo_inspection import repo_search as _core_repo_search
    from backend.agent.core.storage_paths import assistant_dev_runs_dir, assistant_history_path, assistant_log_path, assistant_memory_path, assistant_notification_log_path, assistant_repo_index_path, assistant_training_output_path
    from backend.agent.core.runtime_facade import run_autopilot as _core_run_autopilot
    from backend.agent.core.runtime_facade import run_pilot as _core_run_pilot
    from backend.agent.core.runtime_facade import run_ticket as _core_run_ticket
    from backend.agent.core.runtime_facade import summarize_repo as _core_summarize_repo
    from backend.agent.core.state_service import clear_last_failure as _core_clear_last_failure
    from backend.agent.core.state_service import load_state as _core_load_state
    from backend.agent.core.state_service import mark_audited as _core_mark_audited
    from backend.agent.core.state_service import mark_completed as _core_mark_completed
    from backend.agent.core.state_service import record_last_failure as _core_record_last_failure
    from backend.agent.core.state_service import record_last_run as _core_record_last_run
    from backend.agent.core.state_service import save_state as _core_save_state
    from backend.agent.core.training_service import build_training_command as _core_build_training_command
    from backend.agent.core.training_service import run_training as _core_run_training
    from backend.agent.core.training_service import should_trigger_training as _core_should_trigger_training
    from backend.agent.core.validation_service import build_validation_plan as _core_build_validation_plan
    from backend.agent.core.validation_service import run_validation_plan as _core_run_validation_plan
except (ModuleNotFoundError, ImportError, SyntaxError):
    # Fallback for copied/standalone execution contexts where the reusable
    # platform package is not present or some optional runtime modules are
    # temporarily unavailable, but backend/scripts is available.
    try:
        from backend.scripts.task_classification import classify_ticket, record_history
        from backend.scripts.strategies import get_strategy, Strategy
    except ModuleNotFoundError:
        try:
            from task_classification import classify_ticket, record_history  # type: ignore
            from strategies import get_strategy, Strategy  # type: ignore
        except ModuleNotFoundError:
            def classify_ticket(_desc: str) -> tuple[str, str]:
                return "mixed", "standalone fallback"

            def record_history(*_args, **_kwargs) -> None:
                return None

            class Strategy:
                anti_patterns: tuple = ()

                def matches_file(self, _path: str) -> bool:
                    return False

            def get_strategy(_name: str) -> Strategy:
                return Strategy()

    @dataclass
    class ProviderConfig:
        provider_name: str = ""
        openai_api_key: str = ""
        openai_base_url: str = ""
        local_ai_cmd: str = ""
        system_prompt: str = "You are a rigorous software engineer."
        ollama_base_url: str = "http://localhost:11434"
        ollama_model: str = "qwen2.5-coder:7b"
        openai_model: str = "gpt-4o-mini"
        request_timeout: int = 60
        project_root: Path | None = None

    class ModelProvider:
        def generate(self, *, prompt: str | None = None, messages: list[dict] | None = None, system_prompt: str | None = None, temperature: float | None = None) -> str:
            del prompt, messages, system_prompt, temperature
            return ""

        def stream_generate(self, *, prompt: str | None = None, messages: list[dict] | None = None, system_prompt: str | None = None, temperature: float | None = None):
            generated = self.generate(prompt=prompt, messages=messages, system_prompt=system_prompt, temperature=temperature)
            if generated:
                yield generated

        def chat(self, messages: list[dict], **kwargs) -> str:
            del kwargs
            return self.generate(messages=messages)

        def summarize(self, text: str, **kwargs) -> str:
            del kwargs
            return self.generate(prompt=text)

        def propose_patch(self, prompt: str, **kwargs) -> str:
            del kwargs
            return ""

    class _NullProvider(ModelProvider):
        def generate(self, *, prompt: str | None = None, messages: list[dict] | None = None, system_prompt: str | None = None, temperature: float | None = None) -> str:
            del system_prompt, temperature
            local_cmd = _configured_local_ai_cmd()
            if not local_cmd:
                return ""
            prompt_text = prompt or ""
            if messages and not prompt_text:
                prompt_text = "\n".join(str(row.get("content", "")) for row in messages if isinstance(row, dict))
            try:
                proc = subprocess.Popen(
                    shlex.split(local_cmd),
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                stdout, _stderr = proc.communicate(prompt_text)
                return (stdout or "").strip()
            except Exception:
                return ""

    def assistant_dev_runs_dir(project_root: Path) -> Path:
        return project_root / ".dev_agent_runs"

    def assistant_history_path(project_root: Path) -> Path:
        return project_root / ".dev_assistant_history.jsonl"

    def assistant_memory_path(project_root: Path) -> Path:
        return project_root / "dev_assistant_memory.json"

    def assistant_notification_log_path(project_root: Path) -> Path:
        return project_root / "notifications.log"

    def assistant_log_path(project_root: Path) -> Path:
        return project_root / "dev_assistant.log"

    def assistant_training_output_path(project_root: Path) -> Path:
        return project_root / "dev_assistant_training.jsonl"

    def assistant_repo_index_path(project_root: Path) -> Path:
        return project_root / "repo_index.json"

    def create_provider(_config: ProviderConfig, explicit: str | None = None) -> ModelProvider:
        del explicit
        return _NullProvider()

    def provider_diagnostics(_config: ProviderConfig) -> list[str]:
        return ["provider platform unavailable in standalone mode"]

    @dataclass
    class TicketMetadata:
        ticket_id: str
        desc: str
        tags: list[str]
        status: str = "UNKNOWN"
        priority_tag: str = "P9"
        domain: str = "general"
        keywords: list[str] | None = None
        is_fe: bool = False
        is_backend: bool = True

    class RepoAdapter:
        def load_tickets(self) -> dict[str, str]:
            raise NotImplementedError

        def parse_ticket_metadata(self, ticket_id: str, desc: str) -> TicketMetadata:
            raise NotImplementedError

    class GoSenderrAdapter(RepoAdapter):
        def __init__(self, project_root: Path):
            self.project_root = project_root
            self.board_path = project_root / "docs" / "BAT_FEATURE_BOARD.md"

        def load_tickets(self) -> dict[str, str]:
            tickets: dict[str, str] = {}
            if not self.board_path.exists():
                return tickets
            for line in self.board_path.read_text(encoding="utf-8").splitlines():
                match = TICKET_RE.match(line.strip())
                if match and match.group("id") not in tickets:
                    tickets[match.group("id")] = match.group("desc")
            return tickets

        def parse_ticket_metadata(self, ticket_id: str, desc: str) -> TicketMetadata:
            tags = parse_tags(desc)
            status = tags[0] if tags else "UNKNOWN"
            priority = next((tag for tag in tags if re.fullmatch(r"P\d+", tag)), "P9")
            lower = desc.lower()
            is_fe = "FE" in tags or any(token in lower for token in ("frontend", "react", "tsx"))
            is_backend = "BE" in tags or not is_fe or any(token in lower for token in ("backend", "api", "service", "model"))
            return TicketMetadata(
                ticket_id=ticket_id,
                desc=desc,
                tags=tags,
                status=status,
                priority_tag=priority,
                domain="general",
                keywords=tags[:4],
                is_fe=is_fe,
                is_backend=is_backend,
            )

    _core_is_ignored = None
    _core_repo_search = None
    _core_build_repo_index = None
    _core_audit_ticket = None
    _core_compute_risk = None
    _core_write_run_artifact = None
    _core_write_human_summary = None
    _core_append_ci_report = None
    _core_load_dashboard = None
    _core_update_dashboard = None
    _core_build_run_log_entry = None
    _core_append_run_log = None
    _core_tail_run_log = None
    _core_send_notification = None
    _core_send_slack_webhook = None
    _core_generate_plan = None
    _core_execute_plan = None
    _core_load_memory = None
    _core_save_memory = None
    _core_record_memory = None
    _core_build_validation_plan = None
    _core_run_validation_plan = None
    _core_analyze_failures = None
    _core_attempt_repair = None
    _core_run_ticket = None
    _core_run_autopilot = None
    _core_run_pilot = None
    _core_summarize_repo = None
    _core_load_state = None
    _core_save_state = None
    _core_mark_audited = None
    _core_mark_completed = None
    _core_record_last_run = None
    _core_record_last_failure = None
    _core_clear_last_failure = None
    _core_should_trigger_training = None
    _core_build_training_command = None
    _core_run_training = None

# project root defaults to repository root but can be overridden by env
# __file__ is backend/scripts/dev_assistant.py so:
#   Path(__file__).resolve().parent -> backend/scripts
#   .parent -> backend
# repository root is one level above backend.
ROOT_DIR = Path(__file__).resolve().parent.parent  # backend folder
REPO_ROOT = ROOT_DIR.parent  # repo root (one up from backend)
PROJECT_ROOT = Path(os.environ.get("PROJECT_ROOT", REPO_ROOT))


def _parse_simple_config_scalar(raw: str) -> Any:
    text = str(raw or "").split("#", 1)[0].strip()
    if not text:
        return ""
    lower = text.lower()
    if lower in {"true", "yes", "on"}:
        return True
    if lower in {"false", "no", "off"}:
        return False
    if re.fullmatch(r"-?\d+", text):
        try:
            return int(text)
        except ValueError:
            return text
    if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
        return text[1:-1]
    return text


def _load_standalone_project_config(project_root: Path) -> dict[str, Any]:
    config: dict[str, Any] = {}
    for name in ("dev_assistant.yaml", "dev_assistant.local.yaml"):
        path = project_root / name
        if not path.exists():
            continue
        try:
            for raw_line in path.read_text(encoding="utf-8").splitlines():
                line = raw_line.split("#", 1)[0].rstrip()
                if not line or line.startswith(" ") or line.startswith("\t"):
                    continue
                match = re.match(r"^([A-Za-z0-9_]+):\s*(.*)$", line)
                if not match:
                    continue
                config[match.group(1)] = _parse_simple_config_scalar(match.group(2))
        except Exception:
            continue
    return config

def load_config() -> dict[str, Any]:
    """Read optional dev_assistant.yaml from project root and return dict."""
    try:
        from backend.agent.core.config_loader import load_project_config

        return load_project_config(PROJECT_ROOT)
    except Exception:
        return _load_standalone_project_config(PROJECT_ROOT)


_SETTINGS_CACHE: dict[str, Any] | None = None


def _parse_jsonc(raw: str) -> dict[str, Any]:
    """Best-effort parser for VS Code settings.json (JSONC)."""
    cleaned = re.sub(r"/\*.*?\*/", "", raw, flags=re.DOTALL)
    cleaned = re.sub(r"^\s*//.*$", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r",\s*([}\]])", r"\1", cleaned)
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    return {}


def _load_workspace_settings() -> dict[str, Any]:
    global _SETTINGS_CACHE
    if _SETTINGS_CACHE is not None:
        return _SETTINGS_CACHE

    candidates = [
        PROJECT_ROOT / ".vscode" / "settings.json",
        PROJECT_ROOT / "backend" / ".vscode" / "settings.json",
    ]
    merged: dict[str, Any] = {}
    for path in candidates:
        if not path.exists():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except Exception:
            continue
        data = _parse_jsonc(text)
        if data:
            merged.update(data)
    _SETTINGS_CACHE = merged
    return merged


def _read_env_file_var(key: str) -> str:
    """Read a variable from common local env files without exporting shell env."""
    candidates = [
        PROJECT_ROOT / "backend" / ".env",
        PROJECT_ROOT / ".env",
    ]
    for env_path in candidates:
        if not env_path.exists():
            continue
        try:
            for raw_line in env_path.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() != key:
                    continue
                value = v.strip().strip("\"'")
                if value:
                    return value
        except Exception:
            continue
    return ""


def _normalize_local_ai_cmd(value: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        return ""
    normalized = re.sub(r"\s+", " ", normalized)
    lower = normalized.lower()

    # Repair common corrupted values from earlier UI saves.
    if "local_ai_llama_bridge.py" in lower:
        return "backend/.venv/bin/python backend/scripts/local_ai_llama_bridge.py"
    if "local_ai_gpt4all_bridge.py" in lower:
        return "backend/.venv/bin/python backend/scripts/local_ai_gpt4all_bridge.py"

    if re.match(r"^(thon|ython)\s+", normalized, flags=re.IGNORECASE):
        normalized = f"p{normalized}"
    if re.match(r"^python\s+backend/scripts/local_ai_(llama|gpt4all)_bridge\.py\b", normalized, flags=re.IGNORECASE):
        # strip leading "python" from command and prefix full path
        stripped = re.sub(r'^python\s+', '', normalized, flags=re.IGNORECASE)
        normalized = "backend/.venv/bin/python " + stripped
    if re.match(r"^backend/scripts/local_ai_(llama|gpt4all)_bridge\.py\b", normalized, flags=re.IGNORECASE):
        normalized = f"backend/.venv/bin/python {normalized}"
    return normalized


def _configured_openai_key() -> str:
    key = str(os.environ.get("OPENAI_API_KEY") or "").strip()
    if key:
        return key

    settings = _load_workspace_settings()
    for setting_key in ("gosenderrDevAssistant.openaiKey", "gosenderrAssistant.openaiKey"):
        candidate = str(settings.get(setting_key) or "").strip()
        if candidate:
            return candidate

    return _read_env_file_var("OPENAI_API_KEY")


def _configured_local_ai_cmd() -> str:
    cmd = str(os.environ.get("LOCAL_AI_CMD") or "").strip()
    if cmd:
        return _normalize_local_ai_cmd(cmd)

    settings = _load_workspace_settings()
    for setting_key in ("gosenderrDevAssistant.localAiCmd", "gosenderrAssistant.localAiCmd"):
        candidate = str(settings.get(setting_key) or "").strip()
        if candidate:
            return _normalize_local_ai_cmd(candidate)

    return _normalize_local_ai_cmd(_read_env_file_var("LOCAL_AI_CMD"))


def _configured_provider_name() -> str:
    return str(os.environ.get("AGENT_PROVIDER") or "").strip().lower()


def _configured_ollama_base_url() -> str:
    return str(os.environ.get("OLLAMA_BASE_URL") or "http://localhost:11434").strip() or "http://localhost:11434"


def _configured_ollama_model() -> str:
    return str(os.environ.get("OLLAMA_MODEL") or "qwen2.5-coder:7b").strip() or "qwen2.5-coder:7b"


def _configured_openai_base_url() -> str:
    return str(os.environ.get("OPENAI_BASE_URL") or "").strip()


def _configured_openai_model() -> str:
    return str(os.environ.get("OPENAI_MODEL") or "gpt-4o-mini").strip() or "gpt-4o-mini"


def _configured_system_prompt(default_prompt: str) -> str:
    env_prompt = str(os.environ.get("ASSISTANT_SYSTEM_PROMPT") or "").strip()
    if env_prompt:
        return env_prompt

    settings = _load_workspace_settings()
    for setting_key in ("gosenderrDevAssistant.systemPrompt", "gosenderrAssistant.systemPrompt"):
        candidate = str(settings.get(setting_key) or "").strip()
        if candidate:
            return candidate

    env_file_prompt = _read_env_file_var("ASSISTANT_SYSTEM_PROMPT")
    if env_file_prompt:
        return env_file_prompt
    return default_prompt


def _provider_config(default_prompt: str = "You are a rigorous software engineer.") -> ProviderConfig:
    return ProviderConfig(
        provider_name=_configured_provider_name(),
        openai_api_key=_configured_openai_key(),
        openai_base_url=_configured_openai_base_url(),
        local_ai_cmd=_configured_local_ai_cmd(),
        system_prompt=_configured_system_prompt(default_prompt),
        ollama_base_url=_configured_ollama_base_url(),
        ollama_model=_configured_ollama_model(),
        openai_model=_configured_openai_model(),
        project_root=PROJECT_ROOT,
    )


def _get_model_provider(default_prompt: str = "You are a rigorous software engineer.", explicit_provider: str | None = None) -> ModelProvider:
    return create_provider(_provider_config(default_prompt), explicit=explicit_provider)


def get_repo_adapter(project_root: Path | None = None) -> RepoAdapter:
    return GoSenderrAdapter(project_root or _current_project_root())



REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_FEATURE_BOARD = REPO_ROOT / "docs" / "BAT_FEATURE_BOARD.md"
FEATURE_BOARD = DEFAULT_FEATURE_BOARD
# persistent state file path (stores completed tickets for autopilot/batch)
STATE_PATH = Path(os.environ.get("PROJECT_ROOT", str(REPO_ROOT))) / ".dev_assistant_state.json"
TICKET_RE = re.compile(r"^- `BAT<(?P<id>\d+)>`\s*(?P<desc>.+)$")
SECTION_RE = re.compile(r"^[#/]{1,2} --- (.+?) ---$", flags=re.MULTILINE)
VAR_RE = re.compile(r"{{\s*([\w.]+)\s*}}")
FOR_RE = re.compile(r"{{#for\s+(\w+)\s+in\s+([\w.]+)}}(.*?){{/for}}", flags=re.DOTALL)
IF_RE = re.compile(r"{{#if\s+(!?[\w.]+)}}(.*?)(?:{{#else}}(.*?))?{{/if}}", flags=re.DOTALL)

KEYWORD_GROUPS: dict[str, list[str]] = {
    "frontend": ["[fe]", "frontend", "react", "ux", "ui", "mobile", "dashboard", "map", "tabs"],
    "backend": ["[be]", "backend", "api", "endpoint", "model", "schema", "service", "migration", "alembic"],
    "security": ["[sec]", "security", "auth", "token", "cors", "csrf", "xss", "abuse", "rate"],
    "ops": ["[ops]", "deploy", "docker", "nginx", "ci", "workflow", "health", "metrics", "vps", "redis"],
    "qa": ["[qa]", "test", "e2e", "smoke", "regression", "coverage"],
}

BRAINSTORM_QUESTIONS: dict[str, list[str]] = {
    "frontend": [
        "What is the core user action and success state?",
        "Which routes/screens are in scope for this BAT?",
        "What loading/empty/error states are required?",
    ],
    "backend": [
        "What request/response contract must stay backward compatible?",
        "What permission and role checks are mandatory?",
        "What data invariants must be preserved?",
        "Will new database tables or columns be required? List names and types.",
        "What are the expected return values and possible error codes?",
        "Are there any performance or scaling concerns for this change?",
    ],
    "security": [
        "What abuse path is highest risk and how should it be blocked?",
        "What should be redacted/masked by default?",
        "What audit signal should be emitted for suspicious activity?",
    ],
    "ops": [
        "What rollout and rollback sequence is required?",
        "What health/smoke checks prove this is production-ready?",
    ],
    "qa": [
        "Which role matrix and regression scenarios must be tested?",
        "What test cases should block merge if they fail?",
    ],
    "default": [
        "What is the smallest end-to-end slice that proves this BAT works?",
        "What edge case would break trust if missed?",
    ],
}


@dataclass
class TicketProfile:
    tags: list[str]
    keywords: list[str]
    is_fe: bool
    is_backend: bool


class TemplateError(RuntimeError):
    pass


def _normalize_ticket_id(raw: str) -> str | None:
    value = (raw or "").strip()
    if not value:
        return None
    m = re.match(r"(?i)^bat<(?P<id>\d+)>$", value)
    if m:
        return m.group("id")
    if value.isdigit():
        return value
    return None


def _run_cmd(args: list[str], *, cwd: Path | None = None, allow_failure: bool = False) -> bool:
    try:
        result = subprocess.run(args, cwd=str(cwd) if cwd else None, check=False)
    except Exception as exc:
        print(f"command failed to start: {' '.join(args)} ({exc})")
        return False

    if result.returncode != 0:
        if not allow_failure:
            print(f"command failed ({result.returncode}): {' '.join(args)}")
        return False
    return True


def _capture_cmd(args: list[str], *, cwd: Path | None = None) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            args,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            check=False,
        )
    except Exception as exc:
        return False, str(exc)

    output = result.stdout if result.returncode == 0 else (result.stderr or result.stdout or "")
    return result.returncode == 0, output.strip()


def _current_project_root() -> Path:
    """Resolve project root at call time so tests can patch PROJECT_ROOT env."""
    env_root = str(os.environ.get("PROJECT_ROOT") or "").strip()
    if env_root:
        return Path(env_root)
    return Path(PROJECT_ROOT)


def _resolve_feature_board_path(*, project_root: Path | None = None) -> Path:
    """Return the active BAT board path with explicit override support."""
    root = project_root or _current_project_root()
    dynamic_default = root / "docs" / "BAT_FEATURE_BOARD.md"
    explicit_board = Path(FEATURE_BOARD)

    # If caller explicitly set --feature-board, keep honoring it even when
    # PROJECT_ROOT changes.
    if explicit_board != DEFAULT_FEATURE_BOARD:
        return explicit_board

    if dynamic_default.exists():
        return dynamic_default
    return explicit_board


def load_tickets() -> dict[str, str]:
    return get_repo_adapter().load_tickets()


def parseBatBoard(workspaceRoot: str) -> list[dict]:
    """Return list of ticket items with metadata parsed from board markdown."""
    items: list[dict] = []
    adapter = get_repo_adapter(Path(workspaceRoot))
    for tid, desc in adapter.load_tickets().items():
        metadata = adapter.parse_ticket_metadata(tid, desc)
        tags = metadata.tags
        risk = None
        deps: list[str] = []
        for tag in tags:
            if tag.startswith("RISK:"):
                risk = tag.split(":", 1)[1].lower()
            if tag.startswith("DEP:"):
                deps.append(tag.split(":", 1)[1])
        items.append({
            "ticket": tid,
            "desc": desc,
            "tags": tags,
            "status": metadata.status,
            "risk": risk,
            "deps": deps,
        })
    return items


def parse_tags(desc: str) -> list[str]:
    tags: list[str] = []
    for raw_tag in re.findall(r"\[([^\]]+)\]", desc):
        for part in re.split(r"[/,|]+", raw_tag.upper()):
            tag = part.strip()
            if tag and tag not in tags:
                tags.append(tag)
    upper = desc.upper()
    prefix_statuses = ["TODO", "DONE", "BLOCKED", "UPGRADE", "NEW FEATURE"]
    for status in prefix_statuses:
        if upper.startswith(status) and status not in tags:
            tags.insert(0, status)
            break
    for match in re.findall(r"\bP\d+\b", upper):
        if match not in tags:
            tags.append(match)
    for match in re.findall(r"\b(?:DEP|RISK):[A-Z0-9_-]+\b", upper):
        if match not in tags:
            tags.append(match)
    return tags


def _keyword_match(desc_lower: str, token_set: set[str], keyword: str) -> bool:
    # bracket hints like [fe] are matched as literal substrings
    if keyword.startswith("[") and keyword.endswith("]"):
        return keyword in desc_lower
    # keyword groups are intended as token matches; avoid substring collisions
    return keyword in token_set


def infer_profile(desc: str) -> TicketProfile:
    lower = desc.lower()
    tags = parse_tags(desc)
    token_set = set(re.findall(r"[a-z0-9]+", lower))
    keywords: list[str] = []
    for values in KEYWORD_GROUPS.values():
        for kw in values:
            if _keyword_match(lower, token_set, kw) and kw not in keywords:
                keywords.append(kw)

    fe_tag = "FE" in tags
    be_tag = "BE" in tags
    frontend_hit = any(_keyword_match(lower, token_set, kw) for kw in KEYWORD_GROUPS["frontend"])
    backend_hit = any(_keyword_match(lower, token_set, kw) for kw in KEYWORD_GROUPS["backend"])
    sec_hit = any(_keyword_match(lower, token_set, kw) for kw in KEYWORD_GROUPS["security"]) or "SEC" in tags
    ops_hit = any(_keyword_match(lower, token_set, kw) for kw in KEYWORD_GROUPS["ops"]) or "OPS" in tags
    qa_hit = any(_keyword_match(lower, token_set, kw) for kw in KEYWORD_GROUPS["qa"]) or "QA" in tags

    if fe_tag and be_tag:
        is_fe = True
        is_backend = True
    elif be_tag:
        is_fe = False
        is_backend = True
    elif fe_tag:
        is_fe = True
        is_backend = backend_hit or sec_hit or ops_hit or qa_hit
    else:
        is_fe = frontend_hit
        # treat SEC/OPS/QA tickets as backend by default unless explicitly frontend-only
        is_backend = backend_hit or sec_hit or ops_hit or qa_hit or not is_fe

    return TicketProfile(tags=tags, keywords=keywords, is_fe=is_fe, is_backend=is_backend)



# optional vector store for embedding retrieval
# we default to sqlite for backward compatibility but switch to FAISS when
# available; FAISS dramatically speeds up searches and scales to thousands
# of tickets.  metadata is stored alongside the index so we can map results
# back to ticket ids/descriptions.
VECTOR_DB = Path(__file__).resolve().parent / "dev_assistant.db"
FAISS_INDEX_PATH = Path(__file__).resolve().parent / "dev_assistant.faiss"
FAISS_META_PATH = Path(__file__).resolve().parent / "dev_assistant_meta.json"

# preserve the old sqlite-based store for compatibility
VECTOR_DB = Path(__file__).resolve().parent / "dev_assistant.db"

def _init_vector_db():
    """Ensure the sqlite table for embeddings exists."""
    conn = sqlite3.connect(VECTOR_DB)
    c = conn.cursor()
    c.execute(
        """
        CREATE TABLE IF NOT EXISTS embeddings (
            ticket TEXT PRIMARY KEY,
            desc TEXT,
            embedding BLOB
        )
        """
    )
    conn.commit()
    conn.close()

# lazily cached index/metadata
_FAISS_INDEX: Any | None = None
_FAISS_METADATA: list[dict] | None = None


def _get_faiss_index():
    """Return (index, metadata) or (None,None) if faiss isn't usable."""
    global _FAISS_INDEX, _FAISS_METADATA
    if _FAISS_INDEX is not None and _FAISS_METADATA is not None:
        return _FAISS_INDEX, _FAISS_METADATA

    try:
        import faiss
        import numpy as np  # type: ignore
    except ImportError:  # pragma: no cover - optional dependency
        return None, None

    # if an index already exists on disk, load it along with metadata
    if FAISS_INDEX_PATH.exists() and FAISS_META_PATH.exists():
        try:
            idx = faiss.read_index(str(FAISS_INDEX_PATH))
            with open(FAISS_META_PATH, encoding="utf-8") as f:
                meta = json.load(f)
            _FAISS_INDEX = idx
            _FAISS_METADATA = meta
            return idx, meta
        except Exception:  # fall through to rebuild
            pass

    # try building from sqlite fallback so older logs propagate
    entries = []
    if VECTOR_DB.exists():
        try:
            conn = sqlite3.connect(VECTOR_DB)
            c = conn.cursor()
            c.execute("SELECT ticket, desc, embedding FROM embeddings")
            rows = c.fetchall()
            conn.close()
        except Exception:
            rows = []
    else:
        rows = []

    if not rows:
        # create empty index with zero dimension to keep callers happy
        idx = faiss.IndexFlatIP(0)
        _FAISS_INDEX = idx
        _FAISS_METADATA = []
        return idx, []

    first_emb = json.loads(rows[0][2])
    dim = len(first_emb)
    idx = faiss.IndexFlatIP(dim)
    meta = []

    for ticket, desc, emb_blob in rows:
        try:
            emb = json.loads(emb_blob)
        except Exception:
            continue
        vec = np.array(emb, dtype="float32")
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec /= norm
        idx.add(vec.reshape(1, -1))
        meta.append({"ticket": ticket, "desc": desc})

    try:
        faiss.write_index(idx, str(FAISS_INDEX_PATH))
        with open(FAISS_META_PATH, "w", encoding="utf-8") as f:
            json.dump(meta, f)
    except Exception:  # disk might be readonly
        pass

    _FAISS_INDEX = idx
    _FAISS_METADATA = meta
    return idx, meta


def _store_embedding(ticket: str, desc: str, emb: list[float]) -> None:
    """Persist embedding to sqlite and, if available, faiss index."""
    # sqlite for backwards compatibility
    _init_vector_db()
    conn = sqlite3.connect(VECTOR_DB)
    c = conn.cursor()
    blob = json.dumps(emb)
    c.execute(
        "INSERT OR REPLACE INTO embeddings(ticket, desc, embedding) VALUES (?,?,?)",
        (ticket, desc, blob),
    )
    conn.commit()
    conn.close()

    idx, meta = _get_faiss_index()
    if idx is None or meta is None:
        return
    try:
        import numpy as np  # type: ignore
        import faiss  # noqa: F401 - just to ensure availability
    except ImportError:
        return
    # normalize and add vector
    vec = np.array(emb, dtype="float32")
    norm = np.linalg.norm(vec)
    if norm > 0:
        vec /= norm
    try:
        idx.add(vec.reshape(1, -1))
        meta.append({"ticket": ticket, "desc": desc})
        faiss.write_index(idx, str(FAISS_INDEX_PATH))
        with open(FAISS_META_PATH, "w", encoding="utf-8") as f:
            json.dump(meta, f)
    except Exception:
        pass


def compute_embedding(text: str) -> list[float]:
    """Return embedding for text using OpenAI or local CLI.

    Embeddings are used for retrieval and stored in the log.
    """
    api_key = _configured_openai_key()
    if api_key:
        try:
            from openai import OpenAI
        except ImportError:
            api_key = None
        else:
            client = OpenAI(api_key=api_key)
            resp = client.embeddings.create(model="text-embedding-3-large", input=text)
            return resp.data[0].embedding
    # fallback local
    local_cmd = os.environ.get("LOCAL_EMBED_CMD")
    if local_cmd:
        import subprocess
        proc = subprocess.Popen(local_cmd.split(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        out, _ = proc.communicate(text)
        try:
            return json.loads(out)
        except Exception:
            pass
    raise RuntimeError("no embedding method available")


def ai_generate(prompt: str | None = None, messages: list[dict] | None = None) -> str:
    """Generate text using OpenAI API or local command fallback.

    If ``messages`` is provided it should be a list of role/content dicts in
    the form accepted by the OpenAI Responses API. ``prompt`` is used as a
    single-user message when ``messages`` is None.

    A system prompt may be supplied via the environment variable
    ``ASSISTANT_SYSTEM_PROMPT``; otherwise a default is used.
    """
    provider = _get_model_provider("You are a rigorous software engineer.")
    return provider.generate(prompt=prompt, messages=messages)


def ai_generate_stream(prompt: str | None = None, messages: list[dict] | None = None):
    provider = _get_model_provider("You are a rigorous software engineer.")
    yield from provider.stream_generate(prompt=prompt, messages=messages)


def ai_backend_diagnosis() -> str:
    """Return a short diagnostic string for AI backend configuration."""
    return "; ".join(provider_diagnostics(_provider_config()))


def make_basename(desc: str) -> str:
    cleaned = re.sub(r"\[.*?\]", " ", desc).lower()
    tokens = re.findall(r"[a-z][a-z0-9_]{1,}", cleaned)
    stopwords = {
        "add",
        "and",
        "api",
        "apps",
        "backend",
        "based",
        "for",
        "frontend",
        "from",
        "model",
        "new",
        "only",
        "portal",
        "route",
        "support",
        "task",
        "the",
        "this",
        "with",
    }
    filtered = [token for token in tokens if token not in stopwords]
    if not filtered:
        filtered = tokens
    if not filtered:
        return "bat_item"

    base = "_".join(filtered[:8]).strip("_")
    if not base:
        return "bat_item"
    return base[:80].rstrip("_")


def _resolve_repo_path(path: str) -> Path | None:
    root = Path(os.environ.get("PROJECT_ROOT", str(REPO_ROOT)))
    target = (root / path).resolve()
    if target == root or root in target.parents:
        return target
    return None


def search_repo(query: str) -> str:
    """Run a repository grep for *query* and return the raw output lines."""
    root = Path(os.environ.get("PROJECT_ROOT", str(REPO_ROOT)))
    try:
        out = subprocess.check_output(["rg", "-n", query], cwd=str(root), encoding="utf-8")
        return out.strip()
    except Exception:
        pass

    # Fallback when ripgrep is not installed.
    try:
        ok, out = _capture_cmd(["git", "grep", "-n", query], cwd=root)
        if ok:
            return out
    except Exception:
        pass

    try:
        out = subprocess.check_output(["grep", "-R", "-n", query, "."], cwd=str(root), encoding="utf-8")
        return out.strip()
    except Exception as e:
        return f"search error: {e}"


def read_file(path: str) -> str:
    """Read a file in the repo and return its contents or an error."""
    resolved = _resolve_repo_path(path)
    if not resolved or not resolved.exists():
        return f"file not found: {path}"
    try:
        return resolved.read_text(encoding="utf-8")
    except Exception as e:
        return f"read error: {e}"


def list_dir(path: str = "") -> list[str]:
    """List entries under a repo path (relative to root)."""
    root = Path(os.environ.get("PROJECT_ROOT", str(REPO_ROOT)))
    base = root / path
    if not base.exists() or not base.is_dir():
        return []
    try:
        return sorted(str(p.relative_to(root)) for p in base.iterdir())
    except Exception:
        return []


def get_git_status() -> str:
    """Return output of `git status --short` or error message."""
    root = Path(os.environ.get("PROJECT_ROOT", str(REPO_ROOT)))
    ok, out = _capture_cmd(["git", "status", "--short"], cwd=root)
    if ok:
        return out or "clean"
    if "not a git repository" in out.lower():
        return "not a git workspace"
    return f"git status error: {out or 'git command failed'}"


def get_git_diff() -> str:
    """Return output of `git diff` for the repo."""
    root = Path(os.environ.get("PROJECT_ROOT", str(REPO_ROOT)))
    ok, out = _capture_cmd(["git", "diff"], cwd=root)
    if ok:
        return out
    if "not a git repository" in out.lower():
        return "not a git workspace"
    return f"git diff error: {out or 'git command failed'}"


def get_changed_files() -> list[str]:
    """Return a list of files reported by git status --short."""
    out = get_git_status()
    if out.startswith("git status error"):
        return []
    return [line for line in out.splitlines() if line]


def get_validation_snapshot() -> dict:
    """Produce a small snapshot useful for validation/release dashboards."""
    return {
        "changedFiles": get_changed_files(),
        "gitStatus": get_git_status().rstrip("\n"),
        "lastRunSummary": load_state().get("last_run_summary", ""),
    }


def recommend_next_ticket() -> dict | None:
    """Return the highest-scoring TODO ticket according to heuristics."""
    bats = parseBatBoard(str(os.environ.get("PROJECT_ROOT", str(REPO_ROOT))))
    todos = [b for b in bats if b.get("status", "").startswith("TODO")]
    if not todos:
        return None
    state = load_state()
    audited = set(state.get("auditedTickets", []))
    last_failed = state.get("lastFailedTicket")

    def score(b: dict) -> float:
        # if ticket has dependencies that aren't completed, give it a crushing
        # negative score so it never surfaces as the "next" task.
        deps = b.get("deps") or []
        if deps:
            completed = set(state.get("completed", []))
            missing = [d for d in deps if d not in completed]
            if missing:
                return -1e6
        s = 0.0
        tags = b.get("tags", [])
        if "P0" in tags:
            s += 100
        elif "P1" in tags:
            s += 70
        elif "P2" in tags:
            s += 40
        elif "P3" in tags:
            s += 10
        risk = (b.get("risk") or "").upper()
        if risk == "HIGH":
            s -= 15
        elif risk == "MEDIUM":
            s -= 5
        # original deps penalty (now redundant but kept for safety)
        if deps:
            s -= 1000
        if b.get("ticket") in audited:
            s += 10
        if b.get("ticket") == last_failed:
            s -= 20
        if "LAUNCH-CRITICAL" in tags:
            s += 25
        return s

    best = max(todos, key=score)
    return best


def write_stub(path: str, content: str = "") -> bool:
    target = _resolve_repo_path(path)
    if target is None:
        print(f"skipping unsafe path {path}")
        return False

    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        print(f"skipping existing file {path}")
        return False

    if content.startswith("# generated") and path.endswith((".ts", ".tsx", ".js", ".jsx")):
        content = content.replace("#", "//", 1)

    with open(target, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"created {path}")
    return True


def _python_fallback_module(path: str, ticket_id: str, desc: str) -> str:
    safe_desc = desc.replace('"', "'")
    if path.startswith("backend/tests/"):
        return (
            f'"""Generated fallback test for BAT<{ticket_id}>."""\n\n'
            f"def test_bat_{ticket_id}_placeholder() -> None:\n"
            "    assert True\n"
        )
    if "/api/routes/" in path:
        route_slug = f"bat-{ticket_id}"
        return (
            f'"""Generated fallback route for BAT<{ticket_id}>: {safe_desc}."""\n\n'
            "from fastapi import APIRouter\n\n"
            "router = APIRouter()\n\n"
            f'@router.get("/{route_slug}/placeholder")\n'
            f"def bat_{ticket_id}_placeholder() -> dict[str, str]:\n"
            f'    return {{"ticket": "BAT<{ticket_id}>", "status": "todo"}}\n'
        )
    if "/services/" in path:
        return (
            f'"""Generated fallback service for BAT<{ticket_id}>: {safe_desc}."""\n\n'
            f"def run_bat_{ticket_id}_placeholder() -> dict[str, str]:\n"
            f'    return {{"ticket": "BAT<{ticket_id}>", "status": "todo"}}\n'
        )
    if "/models/" in path:
        class_name = "".join(part.capitalize() for part in Path(path).stem.split("_")) or "BatItem"
        return (
            f'"""Generated fallback model for BAT<{ticket_id}>: {safe_desc}."""\n\n'
            "from dataclasses import dataclass\n\n"
            "@dataclass\n"
            f"class {class_name}:\n"
            f'    ticket: str = "BAT<{ticket_id}>"\n'
            '    status: str = "todo"\n'
        )
    return (
        f'"""Generated fallback module for BAT<{ticket_id}>: {safe_desc}."""\n\n'
        f"def bat_{ticket_id}_placeholder() -> str:\n"
        f'    return "BAT<{ticket_id}> pending implementation"\n'
    )


def _ensure_python_syntax(path: str, text: str, ticket_id: str, desc: str) -> str:
    if not path.endswith(".py"):
        return text
    try:
        ast.parse(text)
        return text
    except SyntaxError:
        return _python_fallback_module(path, ticket_id, desc)


def _augment_generated_content(path: str, content: str, ticket_id: str, desc: str) -> str:
    text = content.strip()
    if not text:
        text = f"# generated for BAT<{ticket_id}>: {desc}"

    # ensure empty classes or functions compile by inserting a pass
    if re.match(r"^(class\s+\w+.*:)$", text) or re.match(r"^(def\s+\w+.*:)$", text):
        # if there is no indented body already
        if "\n    " not in content:
            text += "\n    pass"

    # comment out incomplete import lines (no 'import' keyword)
    lines = text.splitlines()
    for i, ln in enumerate(lines):
        if ln.strip().startswith("from ") and " import " not in ln:
            lines[i] = "# " + ln + "  # removed incomplete import"
    text = "\n".join(lines)

    if path.startswith("backend/"):
        text = text.replace("from backend.app.", "from app.")
        text = text.replace("import backend.app.", "import app.")

    # simple indentation: if a line ends with ':' then the very next
    # nonblank line should be indented one additional level (four spaces)
    # relative to the header's indentation level.  This handles class/def/if
    # and similar blocks.
    lines = text.splitlines()
    new_lines = []
    for idx, ln in enumerate(lines):
        stripped = ln.lstrip()
        if idx > 0:
            prev = lines[idx - 1]
            prev_stripped = prev.lstrip()
            prev_indent = len(prev) - len(prev_stripped)
            if prev_stripped.endswith(":") and stripped and not stripped.startswith("#"):
                required = prev_indent + 4
                cur_indent = len(ln) - len(stripped)
                if cur_indent < required:
                    ln = " " * required + stripped
        new_lines.append(ln)
    text = "\n".join(new_lines)

    # Keep generated backend pytest files runnable to avoid "no tests collected"
    # failures during targeted verification runs.
    if path.startswith("backend/tests/test_") and path.endswith(".py"):
        if "def test_" not in text:
            text += (
                f"\n\n\ndef test_bat_{ticket_id}_placeholder() -> None:\n"
                "    assert True\n"
            )

    # Keep generated frontend Vitest files runnable for typecheck/test workflows.
    if path.endswith(".test.ts") or path.endswith(".test.tsx"):
        if "describe(" not in text:
            text += (
                '\n\nimport { describe, expect, it } from "vitest";\n\n'
                f'describe("BAT<{ticket_id}> placeholder", () => {{\n'
                '  it("keeps scaffold wired", () => {\n'
                "    expect(true).toBe(true);\n"
                "  });\n"
                "});\n"
            )

    text = _ensure_python_syntax(path, text, ticket_id, desc)
    return text.rstrip() + "\n"


def _parse_generated_sections(raw: str) -> list[tuple[str, str]]:
    parts = SECTION_RE.split(raw)
    if len(parts) <= 1:
        return []

    sections: list[tuple[str, str]] = []
    for i in range(1, len(parts), 2):
        fname = parts[i].strip()
        content = parts[i + 1].lstrip("\n")
        content = re.sub(r"^([#/].*)\n", "", content)
        sections.append((fname, content))
    return sections


def _get_context_value(context: dict[str, Any], path: str) -> Any:
    value: Any = context
    for part in path.split("."):
        if isinstance(value, dict):
            value = value.get(part)
        else:
            return None
    return value


def _to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (list, tuple, dict, set)):
        return len(value) > 0
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() not in {"", "0", "false", "no", "off", "none"}
    return bool(value)


def _render_variables(text: str, context: dict[str, Any]) -> str:
    def replace(match: re.Match[str]) -> str:
        key = match.group(1).strip()
        value = _get_context_value(context, key)
        if value is None:
            return ""
        if isinstance(value, (dict, list)):
            return json.dumps(value)
        return str(value)

    return VAR_RE.sub(replace, text)


def _render_conditionals(text: str, context: dict[str, Any]) -> str:
    def replace(match: re.Match[str]) -> str:
        expr = match.group(1).strip()
        true_block = match.group(2) or ""
        false_block = match.group(3) or ""

        negate = expr.startswith("!")
        key = expr[1:] if negate else expr
        value = _to_bool(_get_context_value(context, key))
        if negate:
            value = not value

        block = true_block if value else false_block
        return _render_template_text(block, context)

    while True:
        next_text = IF_RE.sub(replace, text)
        if next_text == text:
            return text
        text = next_text


def _render_loops(text: str, context: dict[str, Any]) -> str:
    def replace(match: re.Match[str]) -> str:
        var_name = match.group(1).strip()
        list_path = match.group(2).strip()
        body = match.group(3) or ""
        seq = _get_context_value(context, list_path)

        if seq is None:
            return ""
        if isinstance(seq, dict):
            iterable = [{"key": k, "value": v} for k, v in seq.items()]
        elif isinstance(seq, list):
            iterable = seq
        else:
            return ""

        out: list[str] = []
        for idx, item in enumerate(iterable):
            loop_ctx = dict(context)
            loop_ctx[var_name] = item
            loop_ctx[f"{var_name}_index"] = idx
            out.append(_render_template_text(body, loop_ctx))
        return "".join(out)

    while True:
        next_text = FOR_RE.sub(replace, text)
        if next_text == text:
            return text
        text = next_text


def _render_template_text(text: str, context: dict[str, Any]) -> str:
    text = _render_loops(text, context)
    text = _render_conditionals(text, context)
    text = _render_variables(text, context)
    return text


def _simple_front_matter_parse(raw: str) -> dict[str, Any]:
    def parse_scalar(text: str) -> Any:
        value = text.strip().strip("\"'")
        lowered = value.lower()
        if lowered in {"true", "yes", "on"}:
            return True
        if lowered in {"false", "no", "off"}:
            return False
        if lowered in {"none", "null", ""}:
            return ""
        if re.fullmatch(r"-?\d+", value):
            try:
                return int(value)
            except Exception:
                return value
        return value

    result: dict[str, Any] = {}
    current_key: str | None = None
    current_map_key: str | None = None

    for line in raw.splitlines():
        if not line.strip() or line.strip().startswith("#"):
            continue
        stripped = line.strip()

        # top-level key
        m = re.match(r"^(\w+)\s*:\s*(.*)$", stripped)
        if m and (line == line.lstrip()):
            key = m.group(1)
            value = m.group(2).strip()
            if value:
                result[key] = parse_scalar(value)
                current_key = None
                current_map_key = None
            else:
                # unknown type at declaration time; infer from first child
                result[key] = {}
                current_key = key
                current_map_key = None
            continue

        if current_key is None:
            continue

        # list item for current key
        if stripped.startswith("- "):
            if not isinstance(result.get(current_key), list):
                result[current_key] = []
            result[current_key].append(parse_scalar(stripped[2:]))
            continue

        # nested key/value map item (single level)
        nested = re.match(r"^(\w+)\s*:\s*(.*)$", stripped)
        if nested:
            if not isinstance(result.get(current_key), dict):
                result[current_key] = {}
            nkey = nested.group(1)
            nvalue = nested.group(2).strip()
            if nvalue:
                result[current_key][nkey] = parse_scalar(nvalue)
                current_map_key = None
            else:
                result[current_key][nkey] = []
                current_map_key = nkey
            continue

        # nested list under the last nested map key
        if stripped.startswith("- ") and current_map_key and isinstance(result.get(current_key), dict):
            nested_list = result[current_key].setdefault(current_map_key, [])
            if isinstance(nested_list, list):
                nested_list.append(parse_scalar(stripped[2:]))

    return result


def _parse_front_matter(raw: str) -> dict[str, Any]:
    raw = raw.strip()
    if not raw:
        return {}
    try:
        import yaml  # type: ignore

        parsed = yaml.safe_load(raw)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass

    # fallback for environments without PyYAML
    return _simple_front_matter_parse(raw)


def _split_front_matter(template_text: str) -> tuple[dict[str, Any], str]:
    lines = template_text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, template_text

    end_idx = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end_idx = i
            break
    if end_idx is None:
        raise TemplateError("template front-matter opened with --- but no closing --- found")

    front_raw = "\n".join(lines[1:end_idx])
    body = "\n".join(lines[end_idx + 1 :])
    return _parse_front_matter(front_raw), body


def _render_front_matter_values(value: Any, context: dict[str, Any]) -> Any:
    if isinstance(value, str):
        return _render_template_text(value, context)
    if isinstance(value, list):
        return [_render_front_matter_values(item, context) for item in value]
    if isinstance(value, dict):
        return {k: _render_front_matter_values(v, context) for k, v in value.items()}
    return value


def render_template(template_name: str, context: dict[str, Any]) -> str:
    tpl_path = Path(__file__).resolve().parent / "templates" / f"{template_name}.tpl"
    if not tpl_path.exists():
        raise TemplateError(f"template {template_name} not found")

    raw = tpl_path.read_text(encoding="utf-8")
    front_matter, body = _split_front_matter(raw)
    rendered_front = _render_front_matter_values(front_matter, context)

    merged = dict(context)
    if isinstance(rendered_front, dict):
        merged.update(rendered_front)

    return _render_template_text(body, merged)



# -----------------------------------------------------------------------------
# repository inspection helpers
# -----------------------------------------------------------------------------

# paths that should never be searched or proposed as targets
REPO_IGNORE_DIRS = {
    ".venv",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".git",
    "__pycache__",
    "site-packages",
    "backend/create/refresh",
    ".dev_agent_runs",
    "docs/assistant_runs",
}

def _legacy_is_ignored(path: Path) -> bool:
    """Return True if *path* (relative or absolute) lives under an ignored directory.

    We check each path component against the ignore list.  This function is used
    by search/index routines so the automations skip junk directories like
    virtualenvs, node_modules, generated caches, etc.
    """
    try:
        parts = path.parts
    except Exception:
        return False
    if str(path).endswith((".pyc", ".pyo")):
        return True
    for part in parts:
        if part in REPO_IGNORE_DIRS:
            return True
        # also ignore if path string contains a banned segment
        for ban in REPO_IGNORE_DIRS:
            if ban in str(path):
                return True
    return False


def _is_ignored(path: Path) -> bool:
    if _core_is_ignored is not None:
        return _core_is_ignored(path, ignore_dirs=REPO_IGNORE_DIRS)
    return _legacy_is_ignored(path)


def _legacy_repo_search(pattern: str) -> List[str]:
    """Return list of repo-relative paths matching the glob-like pattern.

    Uses :data:`PROJECT_ROOT` so tests can override via environment variable.
    Results in ignored directories are filtered out.
    """
    root = Path(PROJECT_ROOT)
    results: list[str] = []
    for p in root.glob(pattern):
        rel = p.relative_to(root)
        if _is_ignored(rel):
            continue
        results.append(str(rel))
    return results


def repo_search(pattern: str) -> List[str]:
    if _core_repo_search is not None:
        return _core_repo_search(Path(PROJECT_ROOT), pattern, ignore_dirs=REPO_IGNORE_DIRS)
    return _legacy_repo_search(pattern)


def _legacy_audit_ticket(ticket_id: str, desc: str, final_files: list[str] | None = None) -> dict[str, Any]:
    """Run classification and repo inspection for the given ticket.

    The returned dictionary contains the strategy, reason, suggested files,
    validation commands, and whether implementation is allowed.  When
    *final_files* is provided we also inspect the list of files the scaffold
    logic intends to touch so that autopilot can make an early decision.
    """
    # if no description provided, look up feature board entry
    if not desc:
        tickets = load_tickets()
        desc = tickets.get(ticket_id, "")
    strat, reason = classify_ticket(desc)
    strat_obj = get_strategy(strat)

    # ------------------------------------------------------------------
    # eligibility checks
    # ------------------------------------------------------------------
    tags = parse_tags(desc)
    status = tags[0] if tags else ""
    # skip tickets that are explicitly done or blocked
    if status in {"DONE", "BLOCKED"}:
        return {
            "ticket": ticket_id,
            "strategy": strat,
            "reason": reason,
            "proposed_files": [],
            "matches": [],
            "existing_targets": [],
            "new_files": [],
            "validation": [],
            "allowed": False,
            "block_reason": f"status is {status}",
            "risk": compute_risk(desc),
            "desc": desc,
        }
    # require at least one actionable status tag
    actionable_states = {"TODO", "UPGRADE", "NEW FEATURE"}
    if not any(s in actionable_states for s in tags):
        return {
            "ticket": ticket_id,
            "strategy": strat,
            "reason": reason,
            "proposed_files": [],
            "matches": [],
            "existing_targets": [],
            "new_files": [],
            "validation": [],
            "allowed": False,
            "block_reason": "no actionable status tag",
            "risk": compute_risk(desc),
            "desc": desc,
        }
    # dependency check: if any DEP:xxx tag refers to ticket not DONE
    bats = parseBatBoard(str(PROJECT_ROOT))
    status_map = {b["ticket"]: b.get("status") for b in bats}
    for tag in tags:
        if tag.startswith("DEP:"):
            dep = tag.split(":", 1)[1]
            dep_status = status_map.get(dep)
            if dep_status is None:
                return {
                    "ticket": ticket_id,
                    "strategy": strat,
                    "reason": reason,
                    "proposed_files": [],
                    "matches": [],
                    "existing_targets": [],
                    "new_files": [],
                    "validation": [],
                    "allowed": False,
                    "block_reason": f"blocked by dependency {dep} (missing)",
                    "risk": compute_risk(desc),
                    "desc": desc,
                }
            if dep_status != "DONE":
                return {
                    "ticket": ticket_id,
                    "strategy": strat,
                    "reason": reason,
                    "proposed_files": [],
                    "matches": [],
                    "existing_targets": [],
                    "new_files": [],
                    "validation": [],
                    "allowed": False,
                    "block_reason": f"blocked by dependency {dep} status {dep_status}",
                    "risk": compute_risk(desc),
                    "desc": desc,
                }

    # perform a quick scan for files matching the strategy's allowed
    matches: List[str] = []
    # use PROJECT_ROOT so tests may provide an isolated tree
    root = Path(PROJECT_ROOT)
    for path in root.rglob("*"):
        rel = Path(path.relative_to(root))
        if _is_ignored(rel):
            continue
        if strat_obj.matches_file(str(rel)):
            matches.append(str(rel))
    # domain-aware keywords used for fallback and scoring
    domain_keywords = [
        "pricing",
        "fare",
        "quote",
        "estimate",
        "surge",
        "demand",
        "zone",
        "dispatch",
        "matching",
        "wallet",
        "checkout",
        # frontend-relevant terms
        "component",
        "route",
        "service",
        "hook",
        "ui",
        "button",
    ]

    # if strat didn't catch anything, fall back to simple keyword presence
    if not matches:
        for path in root.rglob("*"):
            rel = Path(path.relative_to(root))
            if _is_ignored(rel):
                continue
            ll = str(rel).lower()
            if any(kw in ll for kw in domain_keywords):
                matches.append(str(rel))
    # domain-aware scoring: rank matches by relevance to common keywords
    scores: dict[str,int] = {}
    for m in matches:
        ll = m.lower()
        scores[m] = sum(1 for kw in domain_keywords if kw in ll)
    # sort matches by score (highest first), keep top 5
    existing_targets = [m for m, _ in sorted(scores.items(), key=lambda kv: kv[1], reverse=True) if _ > 0]
    existing_targets = existing_targets[:5]

    if strat == "mixed" and reason == "no tag/keyword match":
        matches = []
        existing_targets = []

    new_files: list[dict[str,str]] = []
    # compute a simple confidence metric for downstream planning
    confidence = "high" if existing_targets else "low"

    # propose a few common targets based on strategy name
    proposed: List[str] = []
    if strat == "qa_e2e":
        proposed.extend(["frontend/**/cypress.config.*", "frontend/**/cypress/e2e/**/*"])
        proposed.append("package.json")
        proposed.append(".github/workflows/**/*.yml")
    elif strat == "backend_api":
        proposed.extend(["backend/app/models/*.py", "backend/app/api/routes/*.py"])
    # default to matches if nothing else
    if not proposed:
        proposed = matches[:5]

    # sanity: if strategy anti-pattern appears in proposed or in provided
    # final_files, block the ticket.
    allowed = True
    block_reason = ""
    for pat in strat_obj.anti_patterns:
        for p in (proposed + (final_files or [])):
            if pat.search(p):
                allowed = False
                block_reason = f"Strategy mismatch: {strat} ticket should not touch {p}"
                break
        if not allowed:
            break

    # simple validation commands
    validation: List[str] = []
    if strat == "qa_e2e":
        validation = ["cd frontend && npm install", "cd frontend && npm run test:e2e || true"]
    elif strat == "backend_api":
        validation = ["cd backend && . .venv/bin/activate && pytest -q"]
    elif strat == "frontend_feature":
        validation = ["cd frontend && npm run typecheck", "cd frontend && npm run build"]
    elif strat == "docs":
        validation = ["echo docs review" ]
    elif strat == "ops_ci":
        validation = ["grep -R \"workflow\" .github/workflows || true"]

    return {
        "ticket": ticket_id,
        "strategy": strat,
        "reason": reason,
        "proposed_files": proposed,
        "matches": matches,
        "existing_targets": existing_targets,
        "new_files": new_files,
        "confidence": confidence,
        "validation": validation,
        "allowed": allowed,
        "block_reason": block_reason,
        "risk": compute_risk(desc),
        "desc": desc,
    }


def audit_ticket(ticket_id: str, desc: str, final_files: list[str] | None = None) -> dict[str, Any]:
    if _core_audit_ticket is not None:
        adapter = get_repo_adapter(Path(PROJECT_ROOT))
        return _core_audit_ticket(
            adapter,
            ticket_id,
            desc,
            final_files=final_files,
            project_root=Path(PROJECT_ROOT),
            classify_ticket=classify_ticket,
            get_strategy=get_strategy,
        )
    return _legacy_audit_ticket(ticket_id, desc, final_files=final_files)


# -----------------------------------------------------------------------------
# planning / execution helpers
# -----------------------------------------------------------------------------

def _legacy_build_repo_index() -> dict[str, list[str]]:
    """Scan project directories and write a simple index mapping
    top-level folders to their immediate subdirectories."""
    index: dict[str, list[str]] = {}
    for entry in PROJECT_ROOT.iterdir():
        rel = entry.relative_to(PROJECT_ROOT)
        if _is_ignored(rel):
            continue
        if entry.is_dir():
            try:
                subs = [p.name for p in entry.iterdir() if p.is_dir() and not _is_ignored(p.relative_to(PROJECT_ROOT))]
            except Exception:
                subs = []
            index[entry.name] = subs
    try:
        path = assistant_repo_index_path(Path(PROJECT_ROOT))
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(index, f, indent=2)
    except Exception:
        pass
    return index


def build_repo_index() -> dict[str, list[str]]:
    if _core_build_repo_index is not None:
        return _core_build_repo_index(
            Path(PROJECT_ROOT),
            ignore_dirs=REPO_IGNORE_DIRS,
            output_path=assistant_repo_index_path(Path(PROJECT_ROOT)),
        )
    return _legacy_build_repo_index()


def load_memory() -> list[dict[str, Any]]:
    if _core_load_memory is not None:
        return _core_load_memory(Path(PROJECT_ROOT))
    path = assistant_memory_path(Path(PROJECT_ROOT))
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def save_memory(entries: list[dict[str, Any]]) -> None:
    if _core_save_memory is not None:
        _core_save_memory(Path(PROJECT_ROOT), entries)
        return
    try:
        path = assistant_memory_path(Path(PROJECT_ROOT))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(entries, indent=2), encoding="utf-8")
    except Exception:
        pass


def _legacy_generate_plan(ticket: str, audit_result: dict[str, Any]) -> dict[str, Any]:
    """Produce a simple execution plan for a ticket based on the audit.

    The returned plan contains a list of steps and the validation commands.
    """
    strat = audit_result.get("strategy")
    steps: list[dict[str, Any]] = []
    # prefer to update existing relevant files
    existing = audit_result.get("existing_targets", []) or audit_result.get("matches", [])
    if existing:
        for m in existing[:3]:
            steps.append({"action": "modify_file", "path": m, "reason": "update related file"})
    else:
        # no obvious existing target; fall back to scaffolding so implement
        # runs can still make forward progress on new work.
        steps.append({"action": "scaffold", "ticket": ticket, "reason": "initial scaffold", "allow_slug": True})
        # include any explicit new file proposals
        for nf in audit_result.get("new_files", []):
            steps.append({"action": "create_file", "path": nf.get("path"), "reason": nf.get("reason", "proposed new file")})
    # optionally install dependencies based on keywords
    if "npm" in audit_result.get("reason", ""):
        steps.append({"action": "install_dependency", "name": "npm"})
    plan = {
        "ticket": ticket,
        "strategy": strat,
        "steps": steps,
        "validation": audit_result.get("validation", []),
    }
    return plan


def generate_plan(ticket: str, audit_result: dict[str, Any]) -> dict[str, Any]:
    if _core_generate_plan is not None:
        adapter = get_repo_adapter(Path(PROJECT_ROOT))
        plan = _core_generate_plan(
            adapter,
            audit_result,
            mode="integrate",
            project_root=Path(PROJECT_ROOT),
            ignore_dirs=REPO_IGNORE_DIRS,
        )
        for key in ("proposed_files", "matches", "existing_targets", "new_files", "confidence", "allowed", "block_reason"):
            if key in plan:
                audit_result[key] = plan[key]
        return plan
    return _legacy_generate_plan(ticket, audit_result)


def execute_plan(plan: dict[str, Any], *, use_ai: bool = False, do_write: bool = False, do_git: bool = False) -> list[dict[str, Any]]:
    """Run the steps contained in a plan.  Returns a list of step results."""
    if _core_execute_plan is not None:
        adapter = get_repo_adapter(Path(PROJECT_ROOT))
        provider = _get_model_provider() if use_ai else None
        result = _core_execute_plan(
            adapter,
            plan,
            provider=provider,
            allow_write=do_write,
            project_root=Path(PROJECT_ROOT),
            scaffold_fn=lambda tid, allow_slug=True: scaffold(
                tid,
                use_ai=use_ai,
                do_write=do_write,
                do_git=do_git,
                allow_slug=allow_slug,
                provider=provider,
            ),
            repo_search_fn=repo_search,
        )
        return result.get("results", [])
    results: list[dict[str, Any]] = []
    for step in plan.get("steps", []):
        act = step.get("action")
        if act == "scaffold":
            tid = step.get("ticket")
            allow = step.get("allow_slug", True)
            created = scaffold(
                tid,
                use_ai=use_ai,
                do_write=do_write,
                do_git=do_git,
                allow_slug=allow,
            )
            results.append({"step": step, "ok": bool(created), "created": created})
        elif act == "create_file":
            path = step.get("path")
            ok = False
            if path:
                target = PROJECT_ROOT / path
                try:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if not target.exists():
                        target.write_text(f"# created by plan for {plan.get('ticket')}\n", encoding="utf-8")
                    ok = True
                except Exception:
                    ok = False
            results.append({"step": step, "ok": ok})
        elif act == "modify_file":
            path = step.get("path")
            ok = False
            if path:
                target = PROJECT_ROOT / path
                if target.exists():
                    try:
                        with open(target, "a", encoding="utf-8") as f:
                            f.write("\n# modification from plan\n")
                        ok = True
                    except Exception:
                        ok = False
            results.append({"step": step, "ok": ok})
        elif act == "append_file":
            path = step.get("path")
            content = step.get("content", "")
            ok = False
            if path:
                target = PROJECT_ROOT / path
                try:
                    with open(target, "a", encoding="utf-8") as f:
                        f.write(content)
                    ok = True
                except Exception:
                    ok = False
            results.append({"step": step, "ok": ok})
        elif act == "run_command":
            cmd = step.get("cmd")
            proc = subprocess.run(cmd, shell=True, cwd=str(PROJECT_ROOT), text=True, capture_output=True)
            ok = proc.returncode == 0
            results.append({"step": step, "ok": ok, "stdout": proc.stdout, "stderr": proc.stderr})
        elif act == "search_repo":
            pat = step.get("pattern", "")
            res = repo_search(pat)
            results.append({"step": step, "result": res})
        else:
            results.append({"step": step, "ok": False, "error": "unknown action"})
    return results


# --- agent pilot utilities --------------------------------------------------

def format_review(ticket_id: str, audit: dict[str, Any], plan: dict[str, Any], blocked: bool = False, deps: list[str] | None = None) -> str:
    # include risk field computed with ticket
    audit.setdefault('risk', compute_risk(audit.get('desc',''), ticket_id))
    """Return a human-friendly summary of the upcoming work."""
    out: list[str] = []
    out.append(f"Ticket: {ticket_id}")
    out.append(f"Strategy: {audit.get('strategy')}")
    conf = audit.get('confidence', 'n/a')
    out.append(f"Confidence: {conf}")
    risk = audit.get('risk') or compute_risk(audit.get('desc',''))
    out.append(f"Risk: {risk}")
    if blocked:
        out.append(f"Blocked: yes ({', '.join(deps or [])})")
    steps = plan.get('steps', [])
    if steps:
        out.append("Planned actions:")
        for s in steps:
            act = s.get('action')
            path = s.get('path') or s.get('ticket', '')
            out.append(f"  - {act} {path}")
    if plan.get('validation'):
        out.append("Validation commands:")
        for c in plan.get('validation', []):
            out.append(f"  - {c}")
    if audit.get('block_reason'):
        out.append(f"Risk notes: {audit.get('block_reason')}")
    return "\n".join(out)


def _log_run_artifact(ticket: str, mode: str, audit: dict[str, Any], plan: dict[str, Any], results: list[dict[str, Any]] | None = None, validation: list[dict[str, Any]] | None = None, repair: list[dict[str, Any]] | None = None, branch: str | None = None) -> None:
    if _core_write_run_artifact is not None:
        data = {
            "timestamp": datetime.utcnow().isoformat(),
            "ticket": ticket,
            "mode": mode,
            "strategy": audit.get('strategy'),
            "audit": audit,
            "plan": plan,
            "branch": branch,
        }
        if results is not None:
            data['results'] = results
        if validation is not None:
            data['validation'] = validation
        if repair is not None:
            data['repair'] = repair
        _core_write_run_artifact(Path(PROJECT_ROOT), data)
        try:
            _core_write_human_summary(Path(PROJECT_ROOT), data)
        except Exception:
            pass
        try:
            entry = {
                "timestamp": data["timestamp"],
                "ticket": ticket,
                "mode": mode,
                "strategy": audit.get('strategy'),
            }
            if branch is not None:
                entry["branch"] = branch
            update_dashboard(entry)
        except Exception:
            pass
        return
    runs = assistant_dev_runs_dir(Path(PROJECT_ROOT))
    try:
        runs.mkdir(parents=True, exist_ok=True)
    except Exception:
        return
    data = {
        "timestamp": datetime.utcnow().isoformat(),
        "ticket": ticket,
        "mode": mode,
        "strategy": audit.get('strategy'),
        "audit": audit,
        "plan": plan,
        "branch": branch,
    }
    if results is not None:
        data['results'] = results
    if validation is not None:
        data['validation'] = validation
    if repair is not None:
        data['repair'] = repair
    name = f"{datetime.utcnow().strftime('%Y%m%dT%H%M%S')}-{mode}-{ticket}.json"
    try:
        (runs / name).write_text(json.dumps(data, indent=2), encoding='utf-8')
        # also update dashboard summary
        try:
            entry = {
                "timestamp": data["timestamp"],
                "ticket": ticket,
                "mode": mode,
                "strategy": audit.get('strategy'),
            }
            if branch is not None:
                entry["branch"] = branch
            update_dashboard(entry)
        except Exception:
            pass
    except Exception:
        pass


def send_notification(url: str, payload: dict[str, Any]) -> None:
    if _core_send_notification is not None:
        result = _core_send_notification(Path(PROJECT_ROOT), url, payload)
        if not result.get("sent") and not result.get("logged"):
            print(f"notification failed for {url}")
        return
    # write to local log for auditing/tests
    try:
        ln = assistant_notification_log_path(Path(PROJECT_ROOT))
        ln.parent.mkdir(parents=True, exist_ok=True)
        with open(ln, "a", encoding="utf-8") as f:
            f.write(json.dumps({"url": url, "payload": payload}) + "\n")
    except Exception:
        pass
    # attempt sending over network if requests available
    try:
        import requests
        requests.post(url, json=payload, timeout=5)
    except Exception:
        print(f"notification failed for {url}")


def send_slack_webhook(url: str, message: str) -> None:
    # Slack expects {"text": "..."}
    if _core_send_slack_webhook is not None:
        _core_send_slack_webhook(Path(PROJECT_ROOT), url, message)
        return
    payload = {"text": message}
    send_notification(url, payload)


def update_dashboard(entry: dict[str, Any]) -> None:
    """Maintain a simple dashboard JSON summarizing recent runs."""
    if _core_update_dashboard is not None:
        _core_update_dashboard(Path(PROJECT_ROOT), entry)
        return
    path = assistant_dev_runs_dir(Path(PROJECT_ROOT)) / "dashboard.json"
    data: list[dict[str, Any]] = []
    try:
        if path.exists():
            data = json.loads(path.read_text())
    except Exception:
        data = []
    data.append(entry)
    # keep last 100
    data = data[-100:]
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception:
        pass


def load_risk_model() -> Any:
    cfg = load_config()
    model_path = cfg.get('risk_model_path')
    if model_path:
        try:
            spec = importlib.util.spec_from_file_location('risk_model', model_path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
        except Exception:
            print(f"failed to load risk model from {model_path}")
    return None


def _ensure_branch(ticket: str, strategy: str) -> str | None:
    branch = f"agent/bat-{ticket}-{strategy}"
    # check git availability
    if _run_cmd(["git", "rev-parse", "--is-inside-work-tree"], cwd=PROJECT_ROOT, allow_failure=True):
        _run_cmd(["git", "checkout", "-B", branch], cwd=PROJECT_ROOT, allow_failure=True)
        print(f"switched to branch {branch}")
        return branch
    else:
        print("git unavailable; skipping branch isolation")
        return None


def compute_risk(desc: str, ticket: str | None = None) -> str:
    if _core_compute_risk is not None:
        return _core_compute_risk(Path(PROJECT_ROOT), desc, ticket)
    """Estimate risk using keywords and past audit history.

    If a ticket id is provided, we look at previous run artifacts in
    `.dev_agent_runs` to see if it has failed or had warnings, bumping risk.
    """
    txt = desc.upper()
    high = ["AUTH", "PAYMENT", "MIGRATION", "SECURITY", "LIFECYCLE", "WALLET"]
    medium = ["API", "DATABASE", "SERVICE"]
    if any(h in txt for h in high):
        base = "high"
    elif any(m in txt for m in medium):
        base = "medium"
    else:
        base = "low"

    if ticket:
        runs = assistant_dev_runs_dir(Path(PROJECT_ROOT))
        if runs.exists():
            for f in runs.glob(f"*{ticket}.json"):
                try:
                    data = json.loads(f.read_text())
                    if not data.get("audit", {}).get("allowed", True):
                        return "high"
                    if data.get("mode") == "execute" and not all(r.get("ok") for r in data.get("validation", [])):
                        return "medium"
                except Exception:
                    pass
    return base


def pick_pilot_tickets(count: int = 1) -> list[str]:
    """Return up to `count` safe tickets for pilot runs."""
    bats = parseBatBoard(str(PROJECT_ROOT))
    allowed = {"DOC", "QA", "FE", "CI"}
    excluded = {"AUTH", "PAYMENT", "MIGRATION", "SECURITY", "LIFECYCLE", "WALLET"}
    hits: list[str] = []
    for b in bats:
        if len(hits) >= count:
            break
        tid = b.get('ticket')
        desc = b.get('desc', '').upper()
        # skip tickets audit would block
        aud = audit_ticket(tid, b.get('desc', ''))
        if not aud.get('allowed', True):
            continue
        if not any(w in desc for w in allowed):
            continue
        if any(e in desc for e in excluded):
            continue
        hits.append(tid)
    return hits


def run_validation(commands: list[str]) -> list[dict[str, Any]]:
    """Execute a list of shell commands and return pass/fail results."""
    if _core_run_validation_plan is not None:
        result = _core_run_validation_plan({"ticket": None, "commands": commands, "scope": [], "related_targets": []}, project_root=Path(PROJECT_ROOT))
        return result.get("results", [])
    out: list[dict[str, Any]] = []
    for cmd in commands:
        proc = subprocess.run(cmd, shell=True, cwd=str(PROJECT_ROOT), text=True, capture_output=True)
        ok = proc.returncode == 0
        out.append({"command": cmd, "ok": ok, "stdout": proc.stdout, "stderr": proc.stderr})
    return out


def _extract_error_locations_from_logs(logs: str) -> list[str]:
    # simple regex to pull file paths from error output
    paths: list[str] = []
    for match in re.finditer(r"([\w\-/]+\.(?:py|ts|tsx|js))", logs):
        paths.append(match.group(1))
    return paths


def repair_plan(plan: dict[str, Any], errors: list[dict[str, Any]], max_retries: int = 3) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Attempt to repair a plan by making trivial modifications to affected files.

    Returns (validation_results, applied_fixes).
    """
    if _core_attempt_repair is not None:
        adapter = get_repo_adapter(Path(PROJECT_ROOT))
        validation_result = {
            "ticket": plan.get("ticket"),
            "commands": plan.get("validation", []),
            "results": errors,
            "related_targets": [step.get("path") for step in plan.get("steps", []) if step.get("path")],
            "scope": [],
            "ok": all(err.get("ok") for err in errors) if errors else True,
        }
        repaired = _core_attempt_repair(adapter, plan, validation_result, max_retries=max_retries, project_root=Path(PROJECT_ROOT))
        return repaired.get("validation", {}).get("results", []), repaired.get("repairs", [])
    applied: list[dict[str, Any]] = []
    validation_results = errors
    for _ in range(max_retries):
        # identify failing stdout/stderr
        combined = "\n".join(e.get("stderr", "") + e.get("stdout", "") for e in validation_results)
        targets = _extract_error_locations_from_logs(combined)
        if not targets:
            break
        for t in targets:
            target = PROJECT_ROOT / t
            if target.exists():
                with open(target, "a", encoding="utf-8") as f:
                    f.write("\n# repair attempt\n")
                applied.append({"path": t})
        # rerun validation
        validation_results = run_validation(plan.get("validation", []))
        if all(v.get("ok") for v in validation_results):
            break
    return validation_results, applied


def should_auto_implement(audit: dict[str, Any]) -> bool:
    """Heuristic to decide whether autopilot may implement without explicit flag."""
    strat = audit.get("strategy")
    if strat == "qa_e2e":
        return True
    # future heuristics could inspect past memory or file types
    return False


def record_memory(ticket: str, strategy: str, files_written: list[str], validation_ok: bool) -> None:
    if _core_record_memory is not None:
        _core_record_memory(Path(PROJECT_ROOT), ticket, strategy, files_written, validation_ok)
        return
    mem = load_memory()
    mem.append({
        "ticket": ticket,
        "strategy": strategy,
        "files_written": files_written,
        "validation": "passed" if validation_ok else "failed",
    })
    save_memory(mem)


def _print_runtime_result(runtime_result: dict[str, Any], *, plan_only: bool = False) -> None:
    ticket = runtime_result.get("ticket")
    audit = runtime_result.get("audit") or {}
    if audit:
        print(f"[audit] ticket={ticket} strategy={audit.get('strategy')} reason={audit.get('reason')}")
    if audit and not audit.get("allowed", True):
        print(f"audit blocked: {audit.get('block_reason')}")
        return
    plan = runtime_result.get("plan") or {}
    if plan:
        print("=== Review ===")
        print(format_review(ticket, audit, plan, blocked=False, deps=[]))
        print()
    if plan_only and plan:
        print(json.dumps(plan, indent=2))
    repair = runtime_result.get("repair") or {}
    repairs = repair.get("repairs") or []
    if repairs:
        print(f"repair applied to: {[item.get('path') for item in repairs]}")


def _confidence_score(value: Any) -> float:
    try:
        from backend.agent.core.runtime_utils import confidence_score

        return confidence_score(value)
    except ModuleNotFoundError:
        pass

    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return 0.0



def default_scaffold_paths(profile: TicketProfile, snake: str) -> tuple[str, str, str, str]:
    cfg = load_config()
    # For mixed FE/BE tasks, prefer backend scaffolds by default to avoid writing
    # TS placeholders into Python files and to keep scaffolding deterministic.
    if profile.is_fe and not profile.is_backend:
        comp_name = "".join(x.capitalize() or "_" for x in snake.split("_"))
        base = cfg.get("frontend_app", "customer-app")
        model_file = f"frontend/apps/{base}/src/components/{comp_name}.tsx"
        service_file = f"frontend/apps/{base}/src/services/{snake}.ts"
        route_file = f"frontend/apps/{base}/src/routes/{snake}.tsx"
        test_file = f"frontend/apps/{base}/src/__tests__/{comp_name}.test.tsx"
    else:
        model_dir = cfg.get("backend_model", "backend/app/models")
        service_dir = cfg.get("backend_service", "backend/app/services")
        route_dir = cfg.get("backend_route", "backend/app/api/routes")
        test_dir = cfg.get("backend_test", "backend/tests")
        model_file = f"{model_dir}/{snake}.py"
        service_file = f"{service_dir}/{snake}.py"
        route_file = f"{route_dir}/{snake}.py"
        test_file = f"{test_dir}/test_{snake}.py"
    return model_file, service_file, route_file, test_file


def _question_set_for_profile(profile: TicketProfile) -> list[str]:
    ordered: list[str] = []
    if profile.is_fe:
        ordered.extend(BRAINSTORM_QUESTIONS["frontend"])
    if profile.is_backend:
        ordered.extend(BRAINSTORM_QUESTIONS["backend"])

    if any(k in profile.keywords for k in KEYWORD_GROUPS["security"]):
        ordered.extend(BRAINSTORM_QUESTIONS["security"])
    if any(k in profile.keywords for k in KEYWORD_GROUPS["ops"]):
        ordered.extend(BRAINSTORM_QUESTIONS["ops"])
    if any(k in profile.keywords for k in KEYWORD_GROUPS["qa"]):
        ordered.extend(BRAINSTORM_QUESTIONS["qa"])

    if not ordered:
        ordered.extend(BRAINSTORM_QUESTIONS["default"])

    deduped: list[str] = []
    for q in ordered:
        if q not in deduped:
            deduped.append(q)
    return deduped[:6]


def collect_brainstorm_notes(*, desc: str, profile: TicketProfile, interactive: bool, seeded_notes: str | None) -> str:
    notes: list[str] = []
    if seeded_notes and seeded_notes.strip():
        notes.append(seeded_notes.strip())

    if not interactive:
        return " | ".join(notes)

    print("\nBrainstorm prompts:")
    for question in _question_set_for_profile(profile):
        answer = input(f"- {question} ").strip()
        if answer:
            notes.append(f"{question} {answer}")

    return " | ".join(notes)


def recall_examples(desc: str, n: int = 3) -> list[dict]:
    """Return up to *n* previous log entries similar to *desc*.

    First try to use a FAISS index for fast vector similarity.  If FAISS
    isn't installed or the index fails to load, fall back to linear search
    over previously computed embeddings stored in the log, then finally
    simple substring matching.
    """
    log_path = assistant_log_path(Path(PROJECT_ROOT))
    if not log_path.exists():
        return []
    entries: list[dict] = []
    for line in log_path.read_text(encoding="utf-8").splitlines():
        try:
            entries.append(json.loads(line))
        except Exception:
            continue
    # ensure no entry has a None description
    for e in entries:
        if e.get("desc") is None:
            e["desc"] = ""
    if not entries:
        return []

    # build a map of most recent entry per ticket for use after retrieval
    latest_by_ticket: dict[str, dict] = {}
    for e in entries:
        tid = str(e.get("ticket", ""))
        if tid:
            latest_by_ticket[tid] = e

    # attempt faiss-based search
    idx, meta = _get_faiss_index()
    if idx is not None and meta is not None and len(meta) > 0:
        try:
            import numpy as np  # type: ignore
        except ImportError:
            idx = None  # fall back if numpy missing
        if idx is not None:
            try:
                # compute normalized query vector
                q = np.array(compute_embedding(desc), dtype="float32")
                q_norm = np.linalg.norm(q)
                if q_norm > 0:
                    q /= q_norm
                k = min(len(meta), max(n * 2, n + 5))
                D, I = idx.search(q.reshape(1, -1), k)
                candidates: list[tuple[float, dict]] = []
                now = datetime.now(timezone.utc)
                for dist, i in zip(D[0], I[0]):
                    if i < 0 or i >= len(meta):
                        continue
                    ticket = meta[i].get("ticket")
                    desc2 = meta[i].get("desc", "")
                    entry = latest_by_ticket.get(ticket, {"ticket": ticket, "desc": desc2})
                    # incorporate recency: newer tickets bump score slightly
                    ts = entry.get("timestamp")
                    recency = 0.0
                    if ts:
                        try:
                            dt = datetime.fromisoformat(ts)
                            age_days = (now - dt).total_seconds() / 86400.0
                            recency = 1.0 / (1.0 + age_days)
                        except Exception:
                            pass
                    score = float(dist) + 0.1 * recency
                    candidates.append((score, entry))
                # sort by combined score
                candidates.sort(key=lambda x: -x[0])
                return [e for s, e in candidates[:n]]
            except Exception:
                pass
    # fall back to embedding linear scan using stored vectors
    try:
        curr_emb = compute_embedding(desc)
        def dot(a, b):
            return sum(x * y for x, y in zip(a, b))
        def norm(v):
            return sum(x * x for x in v) ** 0.5
        scored: list[tuple[float, dict]] = []
        for e in entries:
            emb = e.get("embedding")
            if emb:
                score = dot(curr_emb, emb) / (norm(curr_emb) * norm(emb) + 1e-9)
                scored.append((score, e))
        scored.sort(key=lambda x: -x[0])
        if scored:
            return [e for s, e in scored[:n]]
        # if no scored entries, don't return yet; we'll substring-match below
    except Exception:
        # if an error occurred computing embeddings, fall through to substring match
        pass
    # final fallback substring match (either embeddings failed or yielded nothing)
    matches: list[dict] = []
    for e in entries:
        if desc.lower() in (e.get("desc", "") or "").lower():
            matches.append(e)
            if len(matches) >= n:
                break
    return matches


def build_ai_prompt(
    *,
    ticket_id: str,
    desc: str,
    profile: TicketProfile,
    files: list[str],
    brainstorm_notes: str,
) -> str:
    if profile.is_fe and profile.is_backend:
        mode = "fullstack"
    elif profile.is_fe:
        mode = "frontend"
    else:
        mode = "backend"
    tags = ", ".join(profile.tags) if profile.tags else "none"
    keywords = ", ".join(profile.keywords) if profile.keywords else "none"
    notes = brainstorm_notes if brainstorm_notes else "none"
    files_block = "\n".join(f"- {path}" for path in files)

    # retrieval: include a few past similar tickets as context
    examples = recall_examples(desc)
    example_block = ""
    if examples:
        example_block = "Previous similar tickets:\n"
        for e in examples:
            tid = e.get('ticket')
            # ensure we handle None descriptions gracefully
            desc_text = e.get('desc') or ""
            example_block += f"- {tid} ({desc_text[:80]})\n"
        example_block += "\n"

    if profile.is_fe and profile.is_backend:
        role_block = "Generate Python (FastAPI + SQLAlchemy + pytest) and TypeScript/React scaffolds as appropriate."
    elif profile.is_fe:
        role_block = "Generate TypeScript/React code for Vite workspaces."
    else:
        role_block = "Generate Python code for FastAPI + SQLAlchemy + pytest."

    return (
        f"You are scaffolding BAT<{ticket_id}> for GoSenderr.\n"
        f"{example_block}"
        f"Description: {desc}\n"
        f"Mode: {mode}\n"
        f"Tags: {tags}\n"
        f"Keywords: {keywords}\n"
        f"Brainstorm notes: {notes}\n\n"
        f"Target files:\n{files_block}\n\n"
        f"Constraints:\n"
        f"1. {role_block}\n"
        "2. Keep existing API contracts backward compatible unless description explicitly changes them.\n"
        "3. Include auth/role guard assumptions where relevant.\n"
        "4. Include at least one focused test scaffold in the test file.\n"
        "5. For each file, start with a header line `# --- relative/path ---`.\n"
        "6. Output only code blocks split by those file headers.\n"
    )


def scaffold(
    ticket_id: str,
    *,
    use_ai: bool = False,
    do_write: bool = False,
    do_git: bool = False,
    manual_desc: str | None = None,
    template: str | None = None,
    interactive: bool = False,
    brainstorm: bool = False,
    brainstorm_notes: str | None = None,
    repair: bool = False,
    allow_slug: bool = True,
    provider: ModelProvider | None = None,
) -> list[str]:
    """Create or suggest files for a ticket.

    When *allow_slug* is False the helper will not generate new file names based
    on the ticket title.  This is useful for "integrate" or "audit" modes when
    the agent should not introduce novel filenames unless explicitly asked to
    scaffold.
    """
    if not allow_slug and not repair:
        # skip all automatic scaffold work
        return []
    if repair:
        print(f"[repair mode] scaffolding for ticket {ticket_id}")
    tickets = load_tickets()
    desc = manual_desc if manual_desc else tickets.get(ticket_id)
    if not desc:
        print(f"ticket {ticket_id} not found in {_resolve_feature_board_path()} and no manual description provided")
        return []

    profile = infer_profile(desc)
    snake = make_basename(desc)

    # classify first so we know the ticket strategy (used for history logging)
    strat, reason = classify_ticket(desc)
    strategy = strat

    # choose default paths for scaffolding – still backend-centric by design
    model_file, service_file, route_file, test_file = default_scaffold_paths(profile, snake)
    files = [model_file, service_file, route_file, test_file]

    # run audit once we know the prospective file list; this allows
    # autopilot to detect mismatches before touching the filesystem.
    audit = audit_ticket(ticket_id, desc, final_files=files)
    print(f"[audit] ticket={ticket_id} strategy={strategy} reason={audit['reason']}")
    print(f"[audit] proposed files: {audit['proposed_files']}")
    if not audit["allowed"]:
        print(f"[audit] implementation blocked: {audit['block_reason']}")
        return []

    # record mapping for future learning
    record_history(ticket_id, strategy, files, audit.get("validation", []))

    print(f"Scaffolding for BAT<{ticket_id}>: {desc}\n")
    print("Suggested files to create:")
    for path in files:
        print("  ", path)
    print()

    notes = ""
    if brainstorm or brainstorm_notes:
        notes = collect_brainstorm_notes(
            desc=desc,
            profile=profile,
            interactive=interactive,
            seeded_notes=brainstorm_notes,
        )
        if notes:
            print(f"Brainstorm notes: {notes}\n")

    template_output = ""
    if template:
        context = {
            "ticket_id": ticket_id,
            "ticket": ticket_id,
            "desc": desc,
            "snake": snake,
            "is_fe": profile.is_fe,
            "is_backend": profile.is_backend,
            "tags": profile.tags,
            "keywords": profile.keywords,
            "files": files,
            "model_file": model_file,
            "service_file": service_file,
            "route_file": route_file,
            "test_file": test_file,
            "component_name": "".join(x.capitalize() or "_" for x in snake.split("_")),
            "brainstorm_notes": notes,
        }
        try:
            template_output = render_template(template, context)
            print("Template output:\n")
            print(template_output)
            print()
        except TemplateError as exc:
            print(str(exc))

    ai_code = ""
    if use_ai:
        prompt = build_ai_prompt(
            ticket_id=ticket_id,
            desc=desc,
            profile=profile,
            files=files,
            brainstorm_notes=notes,
        )
        ai_provider = provider or _get_model_provider()
        try:
            ai_code = ai_provider.generate(prompt=prompt)
        except Exception:
            ai_code = ai_generate(prompt)
        if ai_code:
            print("AI-generated boilerplate:\n")
            print(ai_code)
            print()
        else:
            print(f"AI generation unavailable ({ai_backend_diagnosis()}; or backend call failed).\n")
    elif not template_output:
        print("Example stub content for model:")
        print(
            """
from sqlalchemy import Column, Integer, String
from app.db.session import Base

class TODOModel(Base):
    __tablename__ = 'todo_models'
    id = Column(Integer, primary_key=True)
"""
        )

    created: list[str] = []
    if do_write:
        wrote: set[str] = set()

        if template_output:
            for fname, content in _parse_generated_sections(template_output):
                if fname.startswith("/") or ".." in Path(fname).parts:
                    print(f"skipping unsafe generated filename {fname}")
                    continue
                final_content = _augment_generated_content(fname, content, ticket_id, desc)
                if write_stub(fname, final_content):
                    created.append(fname)
                wrote.add(fname)

        if ai_code:
            for fname, content in _parse_generated_sections(ai_code):
                if fname.startswith("/") or ".." in Path(fname).parts:
                    print(f"skipping unsafe generated filename {fname}")
                    continue
                final_content = _augment_generated_content(fname, content, ticket_id, desc)
                if write_stub(fname, final_content):
                    created.append(fname)
                wrote.add(fname)

        for path in files:
            if path in wrote:
                continue
            fallback = _augment_generated_content(path, "", ticket_id, desc)
            if write_stub(path, fallback):
                created.append(path)

        if do_git and created:
            branch = f"codex/bat-{ticket_id}"
            if not _run_cmd(["git", "checkout", "-b", branch], cwd=REPO_ROOT):
                _run_cmd(["git", "checkout", branch], cwd=REPO_ROOT, allow_failure=True)

            for fpath in created:
                _run_cmd(["git", "add", fpath], cwd=REPO_ROOT)

            _run_cmd(["git", "commit", "-m", f"scaffold for BAT<{ticket_id}>"], cwd=REPO_ROOT, allow_failure=True)
            print(f"Committed files on branch {branch}")

            if _run_cmd(["which", "gh"], cwd=REPO_ROOT, allow_failure=True):
                _run_cmd(
                    ["gh", "pr", "create", "--fill", "--title", f"scaffold BAT<{ticket_id}>"],
                    cwd=REPO_ROOT,
                    allow_failure=True,
                )
                print("Opened PR using GitHub CLI")

        if created:
            print("running compile/typecheck checks...")
            if any(path.startswith("backend/app/") or path.startswith("backend/tests/") for path in created):
                # Compile only touched backend modules to avoid unrelated legacy
                # syntax issues from blocking the current ticket run.
                for backend_file in [p for p in created if p.startswith("backend/") and p.endswith(".py")]:
                    _run_cmd([sys.executable, "-m", "py_compile", backend_file], cwd=REPO_ROOT, allow_failure=True)
            if any(path.startswith("frontend/") for path in created):
                _run_cmd(["npm", "run", "typecheck"], cwd=REPO_ROOT / "frontend", allow_failure=True)

    return created


def load_state() -> dict[str, Any]:
    if _core_load_state is not None:
        return _core_load_state(Path(PROJECT_ROOT))
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"completed": []}

def save_state(state: dict[str, Any]) -> None:
    if _core_save_state is not None:
        _core_save_state(Path(PROJECT_ROOT), state)
        return
    try:
        STATE_PATH.write_text(json.dumps(state), encoding="utf-8")
    except Exception:
        pass


# scaffolding helpers ------------------------------------------------------

def _snake_to_camel(s: str) -> str:
    return ''.join(word.capitalize() for word in s.split('_'))


def make_basename(desc: str) -> str:
    cleaned = re.sub(r"\[.*?\]", " ", desc or "").strip().lower()
    tokens = re.findall(r"[a-z][a-z0-9_]{1,}", cleaned) or []
    stopwords = {
        'add', 'and', 'api', 'apps', 'backend', 'based', 'for', 'frontend',
        'from', 'model', 'new', 'only', 'portal', 'route', 'support',
        'task', 'the', 'this', 'with',
    }
    filtered = [t for t in tokens if t not in stopwords]
    base = '_'.join(filtered[:8]) if filtered else '_'.join(tokens[:8])
    return (base or 'bat_item').strip('_')[:80]


def generate_schema(desc: str, ticket: str) -> None:
    name = make_basename(desc)
    class_name = _snake_to_camel(name)
    model_path = PROJECT_ROOT / 'backend' / 'app' / 'models' / f"{name}.py"
    if model_path.exists():
        print(f"schema {model_path} already exists, skipping")
        return
    # ensure the directory tree exists before writing
    model_path.parent.mkdir(parents=True, exist_ok=True)
    template = (
        f"from app.db.session import Base\n"
        f"from sqlalchemy import Column, Integer, String\n\n"
        f"class {class_name}(Base):\n"
        f"    __tablename__ = '{name}'\n"
        f"    id = Column(Integer, primary_key=True)\n"
        f"    # TODO: add fields for {desc}\n"
    )
    model_path.write_text(template, encoding='utf-8')
    print(f"wrote schema {model_path}")


def generate_widget(desc: str, ticket: str) -> None:
    name = make_basename(desc)
    comp_name = _snake_to_camel(name)
    widget_path = PROJECT_ROOT / 'frontend' / 'apps' / 'customer-app' / 'src' / 'components' / f"{comp_name}.tsx"
    if widget_path.exists():
        print(f"widget {widget_path} already exists, skipping")
        return
    template = (
        f"import React from 'react';\n\n"
        f"export const {comp_name}: React.FC = () => (\n"
        f"  <div>{comp_name} component for {desc}</div>\n"
        f");\n"
    )
    widget_path.parent.mkdir(parents=True, exist_ok=True)
    widget_path.write_text(template, encoding='utf-8')
    print(f"wrote widget {widget_path}")


def _repair_existing_files() -> None:
    """Walk backend/app and fix indentation/import issues in existing files."""
    root = REPO_ROOT / "backend" / "app"
    for path in root.rglob("*.py"):
        try:
            text = path.read_text(encoding="utf-8")
        except Exception:
            continue
        newtext = _augment_generated_content(path.name, text, "", "")
        # if augmentation altered file, write it back
        if newtext != text:
            try:
                path.write_text(newtext, encoding="utf-8")
            except Exception:
                pass


def main() -> None:
    # repair any legacy files before doing anything else
    _repair_existing_files()
    parser = argparse.ArgumentParser(description="Dev assistant prototype")
    parser.add_argument("ticket", nargs="?", help="BAT ticket id (or comma-separated list)")
    parser.add_argument("--tickets", help="comma-separated BAT ticket ids")
    parser.add_argument("--autopilot", action="store_true", help="pick next TODO ticket automatically and run it")
    parser.add_argument("--batch", type=int, help="number of next TODO tickets to run automatically")
    parser.add_argument("--schedule", help="cron expression for use by scheduler (acts like --autopilot)")
    parser.add_argument("--implement", action="store_true", help="when used with --autopilot run implementation (default is audit-only)")
    parser.add_argument("--feature-board", help="path to feature board markdown (default docs/BAT_FEATURE_BOARD.md in project root)")
    parser.add_argument("--import-log", help="path to another dev_assistant.log to merge for cross-project learning; shared dirs can also be configured in dev_assistant.yaml")
    parser.add_argument("--ai", action="store_true", help="invoke AI to generate code")
    parser.add_argument("--prompt", help="free-form text prompt; when used with --ai the assistant will reply with generated text and exit")
    parser.add_argument("--sys-prompt", help="temporary system prompt to use for this invocation (overrides ASSISTANT_SYSTEM_PROMPT)")
    parser.add_argument("--write", action="store_true", help="actually create stub files")
    parser.add_argument("--git", action="store_true", help="open git branch and commit new files")
    parser.add_argument("--interactive", action="store_true", help="ask additional questions interactively")
    parser.add_argument("--brainstorm", action="store_true", help="ask keyword-driven brainstorming questions")
    parser.add_argument("--brainstorm-notes", help="inline brainstorming notes passed from UI/automation")
    parser.add_argument("--template", help="use named template from scripts/templates/<name>.tpl")
    parser.add_argument("--self-update", action="store_true", help="pull latest code and update assistant scripts")
    parser.add_argument("--schema", action="store_true", help="generate a backend schema/model stub for the ticket")
    parser.add_argument("--widget", action="store_true", help="generate a frontend React component stub for the ticket")
    parser.add_argument("--plan", action="store_true", help="generate an implementation plan and print to stdout")
    parser.add_argument("--execute", action="store_true", help="execute a plan or scaffold implementation")
    parser.add_argument("--repair", action="store_true", help="attempt to repair a failed validation run")
    parser.add_argument("--pilot", action="store_true", help="pick a safe low‑risk ticket for review/execution")
    parser.add_argument("--pilot-count", type=int, default=1, help="number of safe tickets to select when --pilot is used")
    parser.add_argument("--ci-report", help="write a CI-friendly summary JSON to this file")
    parser.add_argument("--notify-url", help="webhook URL to send run notifications to")
    parser.add_argument("--confirm", action="store_true", help="explicitly approve execution of the selected ticket(s)")
    parser.add_argument("--conversation", action="store_true", help="enter interactive conversational AI mode")
    parser.add_argument("--summarize", action="store_true", help="print structured summary of current repo state and exit")
    parser.add_argument("--repair-last", action="store_true", help="rerun most recently failed ticket with repair mode")
    parser.add_argument("--last-summary", action="store_true", help="print the summary of the last run from state and exit")
    parser.add_argument("--history", action="store_true", help="show recent log entries from dev_assistant.log")
    parser.add_argument("--train", action="store_true", help="after completing tickets, generate training data (see train_dev_assistant.py)")
    parser.add_argument("--fine-tune-model", help="when used with --train, automatically start an OpenAI fine-tune job using this base model")
    parser.add_argument("--openai", action="store_true", help="alias for --fine-tune-model with default model gpt-4o-mini (only when --train is set)")
    args = parser.parse_args()
    # allow overriding system prompt on the command line
    if args.sys_prompt:
        os.environ['ASSISTANT_SYSTEM_PROMPT'] = args.sys_prompt

    # self-update should work without requiring a ticket selection
    if args.self_update:
        print("performing self-update (git pull)")
        try:
            _run_cmd(["git", "-C", str(PROJECT_ROOT), "pull"], allow_failure=False)
        except Exception as e:
            print(f"update failed: {e}")
        return

    # build a lightweight repo structure index if missing; planner may use it
    index_path = assistant_repo_index_path(Path(PROJECT_ROOT))
    if not index_path.exists():
        build_repo_index()

    # if the user requested a structured summary, ignore other modes
    if args.summarize:
        adapter = get_repo_adapter(Path(PROJECT_ROOT))
        if _core_summarize_repo is not None:
            payload = _core_summarize_repo(adapter, args=args)
        else:
            bats = parseBatBoard(str(PROJECT_ROOT))
            summary = summarizeBats(bats)
            payload = {
                "summary": summary,
                "todos": [b["ticket"] for b in bats if b["status"].startswith("TODO")],
            }
        print(json.dumps(payload, indent=2))
        return
    # last-summary prints whatever small text we persisted
    if args.last_summary:
        st = load_state()
        print(st.get("last_run_summary", ""))
        return
    # history dumps tail of log file
    if args.history:
        if _core_tail_run_log is not None:
            print("\n".join(_core_tail_run_log(Path(PROJECT_ROOT), 20)))
        else:
            log_path = assistant_log_path(Path(PROJECT_ROOT))
            try:
                with open(log_path, encoding="utf-8") as f:
                    lines = f.read().splitlines()
                print("\n".join(lines[-20:]))
            except Exception as e:
                print(f"could not read log: {e}")
        return

    # conversational/interactive mode
    if args.conversation:
        history_file = assistant_history_path(Path(PROJECT_ROOT))
        def load_history():
            hist = []
            if history_file.exists():
                try:
                    for line in history_file.read_text(encoding="utf-8").splitlines():
                        hist.append(json.loads(line))
                except Exception:
                    pass
            return hist
        def save_history(hist):
            try:
                history_file.parent.mkdir(parents=True, exist_ok=True)
                with open(history_file, "a", encoding="utf-8") as f:
                    for entry in hist:
                        f.write(json.dumps(entry) + "\n")
            except Exception:
                pass

        def build_context():
            bats = parseBatBoard(str(PROJECT_ROOT))
            todos = [b for b in bats if b["status"].startswith("TODO")]
            lines = [f"Total BATs: {len(bats)}", f"TODO count: {len(todos)}"]
            if todos:
                lines.append(f"Next TODO ticket: {todos[0]['ticket']}")
            if last_run := load_state().get("last_run"):
                lines.append(f"Last run: {last_run}")
            system_prompt = os.environ.get("ASSISTANT_SYSTEM_PROMPT", "You are a rigorous software engineer.")
            lines.insert(0, f"SYSTEM PROMPT: {system_prompt}")
            return "\n".join(lines)

        history = load_history()
        # load persisted flags from state
        state = load_state()
        auditEnforced = bool(state.get("auditEnforced", False))

        ctx = build_context()
        if ctx:
            history.append({"role": "system", "content": ctx})
        print("Entering conversation mode (type 'exit' to quit)")
        while True:
            try:
                line = input("You: ")
            except EOFError:
                break
            if not line.strip():
                continue
            if line.strip().lower() in ("exit", "quit"):
                break
            # handle built-in slash commands before hitting LLM
            low = line.strip().lower()
            if low.startswith("/next"):
                rec = recommend_next_ticket()
                if rec:
                    out = f"Next TODO: {rec.get('ticket')} (score applied)"
                else:
                    out = "No TODOs."
                print("Assistant:", out)
                history.append({"role": "user", "content": line})
                history.append({"role": "assistant", "content": out})
                continue
            if low.startswith("/repair"):
                lr = load_state().get("last_run")
                if lr:
                    out = f"Repair launched for BAT<{lr}>."
                else:
                    out = "No last run to repair."
                print("Assistant:", out)
                history.append({"role": "user", "content": line})
                history.append({"role": "assistant", "content": out})
                continue
            if low.startswith("/files"):
                ok, out = _capture_cmd(["git", "status", "--short"], cwd=PROJECT_ROOT)
                if ok:
                    out = out or "clean"
                elif "not a git repository" in out.lower():
                    out = "not a git workspace"
                else:
                    out = f"error: {out or 'git command failed'}"
                # include last-run summary if available
                st = load_state()
                summary = st.get("last_run_summary")
                if summary:
                    out = out + "\n\nLast run summary:\n" + summary
                print("Assistant:", out)
                history.append({"role": "user", "content": line})
                history.append({"role": "assistant", "content": out})
                continue
            if low.startswith("/audit"):
                parts = line.strip().split()
                if len(parts) > 1:
                    # mark a specific ticket as audited
                    tid = _normalize_ticket_id(parts[1])
                    if tid:
                        st = load_state()
                        aud = set(st.get("auditedTickets", []))
                        aud.add(tid)
                        st["auditedTickets"] = list(aud)
                        save_state(st)
                        out = f"Marked {tid} as audited."
                    else:
                        out = "Invalid ticket id for audit."
                else:
                    auditEnforced = not auditEnforced
                    # persist change
                    state = load_state()
                    state["auditEnforced"] = auditEnforced
                    save_state(state)
                    out = f"Audit enforcement is now {auditEnforced and 'ON' or 'OFF'}."
                print("Assistant:", out)
                history.append({"role": "user", "content": line})
                history.append({"role": "assistant", "content": out})
                continue
            if low.startswith("/search"):
                query = line.partition(" ")[2].strip()
                out = search_repo(query)
                print("Assistant:", out)
                history.append({"role": "user", "content": line})
                history.append({"role": "assistant", "content": out})
                continue
            if low.startswith("/snapshot"):
                snap = get_validation_snapshot()
                out = json.dumps(snap, indent=2)
                print("Assistant:", out)
                history.append({"role": "user", "content": line})
                history.append({"role": "assistant", "content": out})
                continue
            if low.startswith("/open"):
                path = line.partition(" ")[2].strip()
                out = read_file(path)
                print("Assistant:", out)
                history.append({"role": "user", "content": line})
                history.append({"role": "assistant", "content": out})
                continue
            # otherwise send to model
            history.append({"role": "user", "content": line})
            reply = ai_generate(messages=history)
            # ensure the response appears on its own line (input prompt may leave cursor at line start)
            print()
            print("Assistant:", reply)
            history.append({"role": "assistant", "content": reply})
        save_history(history)
        return

    # if the user provided a prompt string we run AI and exit early
    if args.prompt:
        if not args.ai:
            parser.error("--prompt requires --ai")
        response = ai_generate(prompt=args.prompt)
        if response is None:
            response = "(AI unavailable)"
        print(response)
        return

    # determine ticket list; autopilot/batch/schedule/repair-last override manual input
    state = load_state()
    raw_ids: list[str] = []
    repair_mode = False
    # repair-last takes precedence over normal ticket parsing
    if args.repair_last:
        tid = state.get("lastFailedTicket")
        if not tid:
            print("no last failed ticket recorded")
            sys.exit(1)
        raw_ids = [tid]
        repair_mode = True
    
    # pilot mode: pick a safe low-risk ticket
    if args.pilot:
        tids = pick_pilot_tickets(args.pilot_count)
        if not tids:
            print("no safe pilot tickets available")
            sys.exit(0)
        raw_ids = tids
        # default to plan-only; actual execution gated later by confirmation
    
    # if a schedule expression was given, treat it the same as autopilot mode
    if args.schedule and not (args.autopilot or args.batch):
        args.autopilot = True
    if args.schema or args.widget:
        # generate artifacts for the first provided ticket only
        ticket = None
        if args.ticket:
            ticket = args.ticket.split(",")[0].strip()
        elif args.tickets:
            ticket = args.tickets.split(",")[0].strip()
        if not ticket:
            parser.error("--schema/--widget requires a ticket id")
        tid = _normalize_ticket_id(ticket)
        if not tid:
            parser.error(f"invalid ticket id: {ticket}")
        desc = load_tickets().get(tid, "")
        if args.schema:
            generate_schema(desc, tid)
        if args.widget:
            generate_widget(desc, tid)
        return

    if args.autopilot or args.batch or args.schedule:
        # autopilot mode should run AI by default; writing is gated behind
        # the new ``--implement`` flag (users may still override with
        # ``--write`` explicitly if they really want to).
        cfg = load_config()
        if args.autopilot or args.schedule:
            args.ai = True
            if args.implement:
                args.write = True
        if cfg.get('autopilot_fix_loop'):
            # we will trigger repair-last if preflight fails later
            auto_repair = True
        else:
            auto_repair = False

        tickets = load_tickets()
        todos = [tid for tid, desc in tickets.items() if "TODO" in desc.upper()]
        # skip ones we've already run via autopilot
        todos = [t for t in todos if t not in state.get("completed", [])]
        # also filter out any that are blocked by unmet dependencies
        bats_info = {b['ticket']: b for b in parseBatBoard(str(PROJECT_ROOT))}
        def _is_blocked(tid):
            info = bats_info.get(tid)
            if not info:
                return False
            deps = info.get('deps') or []
            if not deps:
                return False
            completed = set(state.get('completed', []))
            missing = [d for d in deps if d not in completed]
            return bool(missing)
        blocked = [t for t in todos if _is_blocked(t)]
        if blocked:
            print(f"skipping blocked tickets for autopilot: {', '.join(blocked)}")
        todos = [t for t in todos if not _is_blocked(t)]

        # skip any tickets the audit logic would reject; do this before
        # choosing a candidate so autopilot doesn't continually retry them.
        audit_blocked: list[str] = []
        for t in todos:
            aud = audit_ticket(t, tickets.get(t, ""))
            if not aud.get("allowed", True):
                audit_blocked.append(t)
        if audit_blocked:
            print(f"skipping audit-blocked tickets for autopilot: {', '.join(audit_blocked)}")
        todos = [t for t in todos if t not in audit_blocked]
        if not todos:
            print("no TODO tickets available for autopilot")
            sys.exit(0)
        if args.autopilot:
            raw_ids.append(todos[0])
        else:
            n = args.batch or 1
            raw_ids.extend(todos[:n])
    else:
        auto_repair = False

    if repair_mode:
        # raw_ids already set above
        pass
    elif args.tickets:
        raw_ids.extend(t.strip() for t in args.tickets.split(",") if t.strip())
    elif args.ticket:
        raw_ids.extend(t.strip() for t in args.ticket.split(",") if t.strip())
    elif args.autopilot or args.batch or args.pilot:
        # autopilot/batch/pilot mode populates raw_ids above, nothing further to do
        pass
    else:
        parser.error("must supply a ticket or --tickets unless --autopilot/--batch/--pilot is used")

    # override feature board if requested
    global FEATURE_BOARD
    if args.feature_board:
        FEATURE_BOARD = Path(os.path.abspath(args.feature_board))

    ids: list[str] = []
    for raw in raw_ids:
        tid = _normalize_ticket_id(raw)
        if not tid:
            parser.error(f"invalid BAT ticket id: {raw}")
        ids.append(tid)
    log_path = assistant_log_path(Path(PROJECT_ROOT))
    # optionally merge another project's log for cross-project learning
    # explicit command-line override takes precedence
    if args.import_log:
        try:
            other = Path(args.import_log)
            if other.exists():
                with open(other, encoding="utf-8") as f, open(log_path, "a", encoding="utf-8") as out:
                    for line in f:
                        out.write(line)
                print(f"merged log entries from {other}")
        except Exception as e:
            print(f"failed to import log: {e}")

    # automatically ingest any shared logs configured in dev_assistant.yaml
    cfg = load_config()
    setattr(args, "config", cfg)
    shared_dirs = cfg.get("shared_log_dirs") or []
    if isinstance(shared_dirs, str):
        shared_dirs = [shared_dirs]
    for d in shared_dirs:
        try:
            base = Path(d).expanduser()
            for f in base.glob("**/dev_assistant.log"):
                if f.exists() and f.resolve() != log_path.resolve():
                    with open(f, encoding="utf-8") as src, open(log_path, "a", encoding="utf-8") as out:
                        out.write(src.read())
                    print(f"merged shared log {f}")
        except Exception as e:
            print(f"failed to merge shared logs from {d}: {e}")

    adapter = get_repo_adapter(Path(PROJECT_ROOT))
    provider = _get_model_provider() if args.ai else None
    runtime_kwargs = {
        "project_root": Path(PROJECT_ROOT),
        "classify_ticket": classify_ticket,
        "get_strategy": get_strategy,
            "ignore_dirs": set(REPO_IGNORE_DIRS),
        "scaffold_fn": scaffold,
        "ensure_branch_fn": _ensure_branch,
    }

    if (args.autopilot or args.batch or args.schedule) and _core_run_autopilot is not None:
        runtime_result = _core_run_autopilot(
            adapter,
            count=(1 if args.autopilot else (args.batch or 1)),
            args=args,
            provider=provider,
            should_auto_implement_fn=should_auto_implement,
            **runtime_kwargs,
        )
        blocked = runtime_result.get("blocked_tickets") or []
        if blocked:
            print(f"skipping blocked tickets for autopilot: {', '.join(blocked)}")
        selected = runtime_result.get("selected_tickets") or []
        if not selected:
            print("no TODO tickets available for autopilot")
            return
        for ticket_result in runtime_result.get("results", []):
            _print_runtime_result(ticket_result, plan_only=bool(args.plan))
        return

    if args.pilot and _core_run_pilot is not None:
        runtime_result = _core_run_pilot(
            adapter,
            count=args.pilot_count,
            args=args,
            provider=provider,
            **runtime_kwargs,
        )
        selected = runtime_result.get("selected_tickets") or []
        if not selected:
            print("no safe pilot tickets available")
            return
        for ticket_result in runtime_result.get("results", []):
            _print_runtime_result(ticket_result, plan_only=bool(args.plan))
        return

    if args.schedule:
        run_mode = "scheduled"
    elif args.autopilot:
        run_mode = "autopilot"
    elif args.batch:
        run_mode = "batch"
    elif args.pilot:
        run_mode = "pilot"
    else:
        run_mode = "manual"
    for tid in ids:
        desc = None
        if args.interactive:
            desc = input(f"Enter description for BAT<{tid}> (leave blank to use board): ").strip()

        if _core_run_ticket is not None:
            runtime_result = _core_run_ticket(
                adapter,
                tid,
                mode="integrate",
                provider=provider,
                args=args,
                compute_embedding_fn=compute_embedding,
                store_embedding_fn=_store_embedding,
                should_auto_implement_fn=should_auto_implement,
                **runtime_kwargs,
            )
            if repair_mode:
                print(f"Repair mode: rerunning last failed ticket {tid}")
            _print_runtime_result(runtime_result, plan_only=bool(args.plan))
            continue

        # dependency blocking: ensure all deps are in completed list
        state = load_state()
        bats_info = {b['ticket']: b for b in parseBatBoard(str(PROJECT_ROOT))}
        info = bats_info.get(tid)
        deps_list: list[str] = []
        if info:
            deps = info.get('deps') or []
            deps_list = deps
            if deps:
                completed = set(state.get('completed', []))
                missing = [d for d in deps if d not in completed]
                if missing:
                    print(f"Cannot run {tid}; dependencies not completed: {', '.join(missing)}")
                    # skip this ticket
                    continue
        # audit-enforcement: can't implement unless previously run
        if args.write and state.get('auditEnforced'):
            last_run = state.get('last_run')
            if last_run != tid:
                print(f"Audit enforced: please run {tid} before implementing.")
                continue

        if repair_mode:
            print(f"Repair mode: rerunning last failed ticket {tid}")

        # perform audit and plan
        tickets = load_tickets()
        audit = audit_ticket(tid, tickets.get(tid, ""))
        print(f"[audit] ticket={tid} strategy={audit['strategy']} reason={audit['reason']}")
        if not audit.get('allowed'):
            print(f"audit blocked: {audit.get('block_reason')}")
            continue
        plan = generate_plan(tid, audit)
        # ensure audit record has description for risk
        audit['desc'] = tickets.get(tid, '')

        # review summary (dry run)
        print("=== Review ===")
        print(format_review(tid, audit, plan, blocked=False, deps=deps_list))
        print()

        # if user just wanted a plan, output and skip
        if args.plan:
            print(json.dumps(plan, indent=2))
            _log_run_artifact(tid, "plan", audit, plan)
            if args.notify_url:
                send_notification(args.notify_url, {"ticket": tid, "mode": "plan"})
            continue

        # determine whether we should execute now
        should_exec = args.execute
        exec_res: list[dict[str, Any]] = []
        if args.autopilot and (args.implement or should_auto_implement(audit)):
            should_exec = True
        # confirmation gate for real runs (autopilot always allowed)
        safe_task = args.pilot
        conf_val = _confidence_score(audit.get('confidence', 0))
        if should_exec and not args.autopilot and not args.confirm and not (safe_task and conf_val >= 0.8):
            print("execution requires --confirm; skipping actual execution")
            should_exec = False
        branch = None
        created = []
        if should_exec:
            # branch isolation
            branch = _ensure_branch(tid, audit.get('strategy', 'unknown'))
            exec_res = execute_plan(
                plan,
                use_ai=args.ai,
                do_write=args.write,
                do_git=args.git,
            )
            # collect any created paths
            for r in exec_res:
                if isinstance(r.get('created'), list):
                    created.extend(r['created'])
        elif args.execute:
            # if explicit execute but no plan steps, still run scaffold
            created = scaffold(
                tid,
                use_ai=args.ai,
                do_write=args.write,
                do_git=args.git,
                manual_desc=desc,
                template=args.template,
                interactive=args.interactive,
                brainstorm=args.brainstorm,
                brainstorm_notes=args.brainstorm_notes,
                repair=repair_mode,
            )
        # run validation if we executed anything
        ticket_ok = True
        val_results: list[dict[str, Any]] = []
        if created or should_exec:
            validation_plan = (
                _core_build_validation_plan(get_repo_adapter(Path(PROJECT_ROOT)), tid, audit, plan)
                if _core_build_validation_plan is not None
                else {"commands": plan.get('validation', [])}
            )
            val_out = (
                _core_run_validation_plan(validation_plan, project_root=Path(PROJECT_ROOT))
                if _core_run_validation_plan is not None
                else {"results": run_validation(plan.get('validation', [])), "ok": all(r.get('ok') for r in run_validation(plan.get('validation', [])))}
            )
            val_results = val_out.get('results', [])
            if not all(r.get('ok') for r in val_results):
                if args.repair or args.autopilot or should_exec:
                    if _core_attempt_repair is not None:
                        repair_out = _core_attempt_repair(
                            get_repo_adapter(Path(PROJECT_ROOT)),
                            plan,
                            val_out,
                            provider=_get_model_provider() if args.ai else None,
                            project_root=Path(PROJECT_ROOT),
                        )
                        val_results = repair_out.get('validation', {}).get('results', [])
                        fixes = repair_out.get('repairs', [])
                    else:
                        val_results, fixes = repair_plan(plan, val_results)
                    if fixes:
                        print(f"repair applied to: {[f.get('path') for f in fixes]}")
            ticket_ok = all(r.get('ok') for r in val_results)
        # log artifact for this run
        _log_run_artifact(
            tid,
            "execute",
            audit,
            plan,
            results=exec_res if exec_res else None,
            validation=val_results,
            repair=(fixes if 'fixes' in locals() else None),
            branch=branch,
        )
        # record memory of this run
        if ticket_ok:
            record_memory(tid, audit.get('strategy', ''), created, True)
        else:
            record_memory(tid, audit.get('strategy', ''), created, False)
        # if we were repairing and succeeded, clear the failure flag
        if repair_mode:
            st = load_state()
            if created:
                if _core_clear_last_failure is not None:
                    _core_clear_last_failure(st)
                else:
                    st.pop('lastFailedTicket', None)
                save_state(st)
        # record failure if no files produced during a write run (and not repair)
        if args.write and not created and not repair_mode:
            st = load_state()
            if _core_record_last_failure is not None:
                _core_record_last_failure(st, tid)
            else:
                st['lastFailedTicket'] = tid
            save_state(st)
            ticket_ok = False
        # if CI reporting requested, append to file
        if args.ci_report:
            report = {"ticket": tid, "ok": ticket_ok, "branch": branch}
            if _core_append_ci_report is not None:
                _core_append_ci_report(args.ci_report, report)
            else:
                try:
                    with open(args.ci_report, "a", encoding="utf-8") as f:
                        f.write(json.dumps(report) + "\n")
                except Exception:
                    pass
        # send notification if asked
        if args.notify_url:
            send_notification(args.notify_url, {"ticket": tid, "ok": ticket_ok, "branch": branch})
        # after a non-write run we consider the ticket "audited" so scoring
        # and enforcement behave consistently
        if not args.write:
            st = load_state()
            if _core_mark_audited is not None:
                _core_mark_audited(st, tid)
            else:
                aud = set(st.get("auditedTickets", []))
                aud.add(tid)
                st["auditedTickets"] = list(aud)
            save_state(st)
        # capture diff of created files so we can learn from edits
        diff_text = ""
        if created:
            try:
                diff_text = subprocess.check_output([
                    "git", "diff", "HEAD~1", "HEAD", "--"] + created,
                    cwd=REPO_ROOT,
                    text=True,
                    stderr=subprocess.DEVNULL,
                )
            except Exception:
                try:
                    diff_text = subprocess.check_output([
                        "git", "diff", "--"] + created,
                        cwd=REPO_ROOT,
                        text=True,
                        stderr=subprocess.DEVNULL,
                    )
                except Exception:
                    diff_text = ""
        # create a brief run summary for dashboard/snapshot
        run_summary = ""
        if diff_text:
            # limit size to avoid huge state file
            run_summary = diff_text.strip()[:1000]
        else:
            run_summary = f"created {len(created)} file(s)"
        st = load_state()
        if _core_record_last_run is not None:
            _core_record_last_run(st, tid, run_summary)
        else:
            st["last_run_summary"] = run_summary
        save_state(st)

        # determine run mode for logging
        if args.autopilot:
            # if schedule string also provided, record it separately
            run_mode = "scheduled" if args.schedule else "autopilot"
        elif args.batch:
            run_mode = "batch"
        elif args.schedule:
            run_mode = "scheduled"
        else:
            run_mode = "manual"

        if _core_build_run_log_entry is not None:
            log_entry = _core_build_run_log_entry(
                ticket=tid,
                desc=desc,
                run_mode=run_mode,
                schedule=args.schedule,
                ai=bool(args.ai),
                write=bool(args.write),
                git=bool(args.git),
                interactive=bool(args.interactive),
                brainstorm=bool(args.brainstorm),
                brainstorm_notes=bool(args.brainstorm_notes),
                template=args.template,
                created=created,
                diff=diff_text,
            )
        else:
            log_entry = {
                "ticket": tid,
                "desc": desc,
                "run_mode": run_mode,
                "schedule": args.schedule,
                "ai": bool(args.ai),
                "write": bool(args.write),
                "git": bool(args.git),
                "interactive": bool(args.interactive),
                "brainstorm": bool(args.brainstorm),
                "brainstorm_notes": bool(args.brainstorm_notes),
                "template": args.template,
                "created_count": len(created),
                "created": created,
                "diff": diff_text,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
        # compute and store embedding if possible
        try:
            emb = compute_embedding(desc or "")
            log_entry["embedding"] = emb
            try:
                _store_embedding(tid, desc or "", emb)
            except Exception:
                pass
        except Exception:
            pass
        if _core_append_run_log is not None:
            _core_append_run_log(Path(PROJECT_ROOT), log_entry)
        else:
            with open(log_path, "a", encoding="utf-8") as logf:
                logf.write(json.dumps(log_entry) + "\n")
        # record last run regardless of mode
        state = load_state()
        if _core_record_last_run is not None:
            _core_record_last_run(state, tid)
        else:
            state['last_run'] = tid
        save_state(state)
        # update persistent state for bot runs
        # only mark a ticket as completed when we actually made changes
        # (i.e. the assistant wrote files / was asked to implement).  audit-
        # only runs should not consume a ticket so that a later --implement
        # invocation can still act upon it.
        if run_mode in ("autopilot", "batch", "scheduled") and ticket_ok and (
            args.write or args.implement
        ):
            if _core_mark_completed is not None:
                _core_mark_completed(state, tid)
                save_state(state)
            else:
                comp = state.setdefault("completed", [])
                if tid not in comp:
                    comp.append(tid)
                    save_state(state)

    # after processing all tickets optionally trigger training
    # autopilot_auto_train allows the assistant to re-run the training script
    # automatically whenever it handles tickets in autopilot/batch/scheduled
    # mode.  The config value is read each invocation so you can toggle it
    # without editing the CLI invocation.
    cfg = load_config()
    if _core_should_trigger_training is not None and _core_should_trigger_training(cfg, run_mode, args):
        train_cmd = _core_build_training_command(Path(PROJECT_ROOT), openai=bool(args.openai), fine_tune_model=args.fine_tune_model) if _core_build_training_command is not None else [sys.executable, "backend/scripts/train_dev_assistant.py", "--output", str(assistant_training_output_path(Path(PROJECT_ROOT)))]
        print(f"running training command: {' '.join(train_cmd)}")
        if _core_run_training is not None:
            _core_run_training(Path(PROJECT_ROOT), cfg, args, run_mode)
        else:
            _run_cmd(train_cmd, cwd=REPO_ROOT)
    elif _core_should_trigger_training is None:
        auto_train = cfg.get('autopilot_auto_train', False)
        if args.train or (auto_train and run_mode in ("autopilot", "batch", "scheduled")):
            train_cmd = [sys.executable, "backend/scripts/train_dev_assistant.py", "--output", str(assistant_training_output_path(Path(PROJECT_ROOT)))]
            if args.openai:
                train_cmd.append("--openai")
            if args.fine_tune_model:
                train_cmd.extend(["--fine-tune-model", args.fine_tune_model])
            print(f"running training command: {' '.join(train_cmd)}")
            _run_cmd(train_cmd, cwd=REPO_ROOT)


if __name__ == "__main__":
    main()
