from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

from backend.agent.adapters.gosenderr_adapter import GoSenderrAdapter
from backend.agent.core.adapters.base import RepoAdapter, TicketMetadata
from backend.agent.core.artifact_service import (
    _filter_project_target_paths,
    append_owner_automation_history,
    append_project_maintenance_history,
    append_self_improvement_history,
    append_self_improvement_seed,
    load_self_improvement_seeds,
    build_owner_experiment_summary_from_benchmark,
    build_training_handoff_from_dataset,
    filter_self_improvement_paths,
    filter_experiment_dataset,
    load_experiment_dataset,
    summarize_owner_automation_history,
    summarize_owner_automation_work,
    summarize_project_maintenance_history,
    summarize_project_maintenance_work,
    summarize_self_improvement_work,
    summarize_self_improvement_history,
    summarize_experiment_dataset,
    write_owner_automation_export,
    write_project_maintenance_export,
    write_self_improvement_export,
    write_experiment_export,
)
from backend.agent.core.engine_baseline_summary import build_engine_baseline_summary, write_engine_baseline_summary
from backend.agent.core.engine_daily_report import build_engine_daily_report, write_engine_daily_report
from backend.agent.core.storage_paths import (
    assistant_experiment_dataset_path,
    assistant_log_path,
    assistant_log_report_path,
    assistant_owner_automation_history_path,
    assistant_owner_automation_queue_path,
    assistant_project_maintenance_history_path,
    assistant_project_maintenance_queue_path,
    assistant_runs_dir,
    assistant_self_improvement_history_path,
    assistant_self_improvement_queue_path,
    assistant_self_improvement_seed_path,
    assistant_training_output_path,
)
from backend.agent.core.editor_context import augment_ticket_description, build_coding_chat_messages, normalize_editor_context
from backend.agent.core.providers.base import NullProvider, ProviderConfig
from backend.agent.core.providers.factory import create_provider
from backend.agent.core.approval import ApprovalGate
from backend.agent.core.tool_loop import run_tool_loop
from backend.agent.runtime.lab_docker_runner import run_lab_container_contract
from backend.agent.runtime.lab_runtime_adapter import run_lab_training_scenario
from backend.agent.runtime.contracts import (
    DEV_ENGINE_LOOP_STEPS,
    RECOVERY_LADDER_STEPS,
    build_checkpoint_ref,
    build_failure_class,
    build_interrupt_request,
    build_operator_execution_result,
    build_recovery_ladder_state,
    build_review_bundle,
    build_task_objective,
    build_workbench_artifact,
)

RUNTIME_ROOT = Path(__file__).resolve().parents[3]
APP_ROOT = RUNTIME_ROOT.parent
DEFAULT_COMPATIBILITY_PROJECT_ROOT = Path("/Users/papadev/dev/gosenderr_v1")


def _resolve_default_project_root() -> Path:
    for raw_value in (
        os.environ.get("PROJECT_ROOT"),
        os.environ.get("DESKTOP_AGENT_TARGET_WORKSPACE"),
        os.environ.get("GOSENDERR_TARGET_WORKSPACE_ROOT"),
    ):
        text = str(raw_value or "").strip()
        if not text:
            continue
        candidate = Path(text).expanduser()
        resolved = candidate.resolve() if candidate.is_absolute() else (Path.cwd() / candidate).resolve()
        if resolved.exists() and resolved.is_dir():
            return resolved
    if DEFAULT_COMPATIBILITY_PROJECT_ROOT.exists() and DEFAULT_COMPATIBILITY_PROJECT_ROOT.is_dir():
        return DEFAULT_COMPATIBILITY_PROJECT_ROOT.resolve()
    return APP_ROOT


REPO_ROOT = _resolve_default_project_root()
SCRIPTS_DIR = RUNTIME_ROOT / "backend" / "scripts"
_SCRIPT_CACHE: dict[str, ModuleType] = {}

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
if str(RUNTIME_ROOT) not in sys.path:
    sys.path.insert(0, str(RUNTIME_ROOT))


class RuntimeApiError(RuntimeError):
    pass


class _PreparedSelfImprovementAdapter(RepoAdapter):
    def __init__(self, project_root: Path, *, ticket_id: str, objective: str, target_paths: list[str]) -> None:
        self.project_root = project_root
        self._ticket_id = str(ticket_id or "").strip()
        self._objective = str(objective or "").strip()
        self._target_paths = [str(path) for path in list(target_paths or []) if str(path)]

    def load_tickets(self) -> dict[str, str]:
        return {self._ticket_id: self._objective}

    def parse_ticket_metadata(self, ticket_id: str, desc: str) -> TicketMetadata:
        return TicketMetadata(
            ticket_id=str(ticket_id or self._ticket_id),
            desc=str(desc or self._objective),
            tags=["OPS"],
            status="PREPARED",
            priority_tag="P2",
            domain="assistant_runtime",
            keywords=["self-improvement", "assistant-runtime"],
            is_fe=False,
            is_backend=True,
        )

    def classify_ticket_domain(self, desc: str) -> str:
        del desc
        return "assistant_runtime"

    def suggest_target_files(self, metadata: TicketMetadata, *, limit: int = 12) -> list[str]:
        del metadata, limit
        return list(self._target_paths)

    def validation_commands(self, metadata: TicketMetadata, *, full_verify: bool = False) -> list[list[str]]:
        del metadata, full_verify
        return []

    def is_ticket_actionable(self, metadata: TicketMetadata) -> bool:
        del metadata
        return True

    def generate_repo_map(self) -> dict[str, Any]:
        return {"project_root": str(self.project_root), "target_paths": list(self._target_paths)}


class _PreparedProjectMaintenanceAdapter(RepoAdapter):
    def __init__(self, project_root: Path, *, ticket_id: str, objective: str, target_paths: list[str]) -> None:
        self.project_root = project_root
        self._ticket_id = str(ticket_id or "").strip()
        self._objective = str(objective or "").strip()
        self._target_paths = [str(path) for path in list(target_paths or []) if str(path)]

    def load_tickets(self) -> dict[str, str]:
        return {self._ticket_id: self._objective}

    def parse_ticket_metadata(self, ticket_id: str, desc: str) -> TicketMetadata:
        return TicketMetadata(
            ticket_id=str(ticket_id or self._ticket_id),
            desc=str(desc or self._objective),
            tags=["OPS"],
            status="PREPARED",
            priority_tag="P2",
            domain="project_maintenance",
            keywords=["project-maintenance", "bounded-maintenance"],
            is_fe=False,
            is_backend=True,
        )

    def classify_ticket_domain(self, desc: str) -> str:
        del desc
        return "project_maintenance"

    def suggest_target_files(self, metadata: TicketMetadata, *, limit: int = 12) -> list[str]:
        del metadata, limit
        return list(self._target_paths)

    def validation_commands(self, metadata: TicketMetadata, *, full_verify: bool = False) -> list[list[str]]:
        del metadata, full_verify
        return []

    def is_ticket_actionable(self, metadata: TicketMetadata) -> bool:
        del metadata
        return True

    def generate_repo_map(self) -> dict[str, Any]:
        return {"project_root": str(self.project_root), "target_paths": list(self._target_paths)}


class _PreparedOwnerAutomationAdapter(RepoAdapter):
    def __init__(self, project_root: Path, *, ticket_id: str, objective: str, target_paths: list[str], category: str) -> None:
        self.project_root = project_root
        self._ticket_id = str(ticket_id or "").strip()
        self._objective = str(objective or "").strip()
        self._target_paths = [str(path) for path in list(target_paths or []) if str(path)]
        self._category = str(category or "maintenance").strip() or "maintenance"

    def load_tickets(self) -> dict[str, str]:
        return {self._ticket_id: self._objective}

    def parse_ticket_metadata(self, ticket_id: str, desc: str) -> TicketMetadata:
        return TicketMetadata(
            ticket_id=str(ticket_id or self._ticket_id),
            desc=str(desc or self._objective),
            tags=["OPS"],
            status="PREPARED",
            priority_tag="P2",
            domain="owner_automation",
            keywords=["owner-automation", self._category, "bounded-runtime"],
            is_fe=False,
            is_backend=True,
        )

    def classify_ticket_domain(self, desc: str) -> str:
        del desc
        return "owner_automation"

    def suggest_target_files(self, metadata: TicketMetadata, *, limit: int = 12) -> list[str]:
        del metadata, limit
        return list(self._target_paths)

    def validation_commands(self, metadata: TicketMetadata, *, full_verify: bool = False) -> list[list[str]]:
        del metadata, full_verify
        return []

    def is_ticket_actionable(self, metadata: TicketMetadata) -> bool:
        del metadata
        return True

    def generate_repo_map(self) -> dict[str, Any]:
        return {
            "project_root": str(self.project_root),
            "target_paths": list(self._target_paths),
            "category": self._category,
        }


def _facade_run_ticket(*args: Any, **kwargs: Any) -> dict[str, Any]:
    from backend.agent.core.runtime_facade import run_ticket as facade_run_ticket

    return facade_run_ticket(*args, **kwargs)


def _load_script_module(name: str, file_name: str) -> ModuleType:
    cached = _SCRIPT_CACHE.get(name)
    if cached is not None:
        return cached
    file_path = SCRIPTS_DIR / file_name
    spec = importlib.util.spec_from_file_location(name, file_path)
    if spec is None or spec.loader is None:
        raise RuntimeApiError(f"unable to load script module: {file_name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    _SCRIPT_CACHE[name] = module
    return module


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        if not path.exists():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


def _json_safe(value: Any) -> Any:
    if is_dataclass(value) and not isinstance(value, type):
        return {key: _json_safe(item) for key, item in asdict(value).items()}
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    return value


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_json_safe(payload), indent=2) + "\n", encoding="utf-8")


def _normalize_ticket_id(value: str | None) -> str:
    raw = str(value or "").strip()
    if not raw:
        raise RuntimeApiError("ticket id is required")
    if raw.isdigit():
        return raw
    if raw.upper().startswith("BAT<") and raw.endswith(">"):
        middle = raw[4:-1]
        if middle.isdigit():
            return middle
    raise RuntimeApiError(f"invalid ticket id: {value}")


def _normalize_runtime_task_mode(value: str | None) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"coder", "repair", "planner", "validator", "research", "chat", "summarizer"}:
        return normalized
    return ""


def _normalize_runtime_lane_id(value: str | None) -> str:
    return str(value or "").strip().lower()


def _explicit_orchestration_steps(payload: dict[str, Any] | None) -> list[dict[str, Any]]:
    source = dict(payload or {})
    steps = list(source.get("steps") or [])
    if not steps:
        steps = list(dict(source.get("context") or {}).get("steps") or [])
    return [dict(item) for item in steps if isinstance(item, dict)]


def _step_requires_material_mutation(step: dict[str, Any]) -> bool:
    action = str(step.get("action") or "").strip().lower()
    if action == "smart_patch":
        return not bool(step.get("dry_run", step.get("dryRun", False)))
    return action in {"edit_file", "write_file", "synthesize_edit", "modify_file"}


def _orchestration_expects_mutation(payload: dict[str, Any] | None, result: dict[str, Any] | None = None) -> bool:
    source = dict(payload or {})
    runtime_result = dict(result or {})
    explicit_steps = _explicit_orchestration_steps(source)
    if explicit_steps:
        return any(_step_requires_material_mutation(step) for step in explicit_steps)
    metadata = dict(source.get("metadata") or {})
    runtime_task = dict(runtime_result.get("runtime_task") or {})
    lane_id = _normalize_runtime_lane_id(
        source.get("laneId")
        or source.get("lane_id")
        or metadata.get("lane_id")
        or metadata.get("laneId")
        or runtime_task.get("lane_id")
        or runtime_task.get("laneId")
    )
    if lane_id in {"code-main", "repair-fast"}:
        return True
    task_mode = _normalize_runtime_task_mode(
        source.get("taskMode")
        or source.get("task_mode")
        or metadata.get("taskMode")
        or metadata.get("task_mode")
        or runtime_task.get("task_mode")
        or runtime_task.get("taskMode")
    )
    return task_mode in {"coder", "repair"}


def _orchestration_changed_paths(result: dict[str, Any] | None) -> list[str]:
    runtime_result = dict(result or {})
    runtime_context = dict(runtime_result.get("runtime_context") or {})
    changed_files = list(runtime_context.get("changed_files") or runtime_context.get("changedFiles") or [])
    paths: list[str] = []
    for item in changed_files:
        if isinstance(item, dict):
            path_value = str(item.get("path") or "").strip()
            if path_value:
                normalized = path_value.replace("\\", "/").lower()
                if normalized == ".gos-lab.json" or normalized.startswith(".gos-lab-recipes/"):
                    continue
                paths.append(path_value)
    return paths


def _orchestration_has_mutating_tool_events(result: dict[str, Any] | None) -> bool:
    runtime_result = dict(result or {})
    for item in list(runtime_result.get("runtime_events") or []):
        if not isinstance(item, dict):
            continue
        data = dict(item.get("data") or {})
        tool = str(data.get("tool") or item.get("tool") or "").strip().lower()
        if tool in {"edit_file", "smart_patch", "write_file"}:
            return True
    return False


def _mark_orchestration_noop_failure(result: dict[str, Any] | None, objective: str = "") -> dict[str, Any]:
    runtime_result = dict(result or {})
    failure_message = (
        f'The coding run did not apply any file changes for "{objective}".'
        if str(objective or "").strip()
        else "The coding run did not apply any file changes."
    )
    runtime_failure = dict(runtime_result.get("runtime_failure") or {})
    runtime_failure.update(
        {
            "kind": "no-op-edit",
            "message": failure_message,
            "stage": "apply",
            "retryable": True,
            "blocking": True,
            "retry_policy": {
                "action": "repair-loop",
                "reason": "no-op-edit",
            },
        }
    )
    review_summary = dict(runtime_result.get("review_summary") or {})
    review_summary["summary"] = failure_message
    review_summary["requires_manual_review"] = False
    run_summary = dict(runtime_result.get("run_summary") or {})
    run_summary["summary"] = failure_message
    runtime_status = dict(runtime_result.get("runtime_result") or {})
    runtime_status["ok"] = False
    runtime_status["status"] = "failed"
    runtime_status["final_state"] = "failed"
    runtime_events = list(runtime_result.get("runtime_events") or [])
    runtime_events.append(
        {
            "schema_version": "2026-03-13",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "run_id": str((runtime_result.get("runtime_run") or {}).get("run_id") or ""),
            "task_id": str((runtime_result.get("runtime_run") or {}).get("task_id") or ""),
            "ticket": str(runtime_result.get("ticket") or ""),
            "stage": "apply",
            "event": "no-op-detected",
            "state": "failed",
            "level": "warning",
            "summary": failure_message,
            "data": {
                "reason": "no-op-edit",
            },
        }
    )
    runtime_result["ok"] = False
    runtime_result["runtime_failure"] = runtime_failure
    runtime_result["review_summary"] = review_summary
    runtime_result["run_summary"] = run_summary
    runtime_result["runtime_result"] = runtime_status
    runtime_result["runtime_events"] = runtime_events
    return runtime_result


def _solo_namespace(command: str, ticket_id: str | None = None, payload: dict[str, Any] | None = None) -> SimpleNamespace:
    data = dict(payload or {})
    selected_action = str(data.get("action") or command or "").strip().lower()
    profile_default = "preview" if selected_action in {"plan", "run"} else "aiWrite"
    return SimpleNamespace(
        ticket=ticket_id,
        desc=data.get("desc"),
        profile=data.get("profile") or profile_default,
        template=data.get("template") or "auto",
        brainstorm=bool(data.get("brainstorm", False)),
        brainstorm_notes=data.get("brainstormNotes") or data.get("brainstorm_notes"),
        interactive=bool(data.get("interactive", False)),
        prefer_domain=data.get("preferDomain") or data.get("prefer_domain"),
        full_verify=bool(data.get("fullVerify", False)),
        max_targeted_tests=int(data.get("maxTargetedTests", 4) or 4),
        skip_verify=bool(data.get("skipVerify", False)),
        skip_preflight=bool(data.get("skipPreflight", False)),
        ship=bool(data.get("ship", False)),
        fix_loop=bool(data.get("fixLoop", False)),
        fix_iterations=int(data.get("fixIterations", 1) or 1),
        safe_mode=bool(data.get("safeMode", False)),
        safe_max_files=int(data.get("safeMaxFiles", 0) or 0),
        allow_protected=bool(data.get("allowProtected", False)),
        allow_ship_in_safe_mode=bool(data.get("allowShipInSafeMode", False)),
        prepare_sandbox=bool(data.get("prepareSandbox", False)),
        sandbox_dir=data.get("sandboxDir"),
        skip_learn=bool(data.get("skipLearn", False)),
        print_learn=bool(data.get("printLearn", False)),
        mode=data.get("mode") or "integrate",
        action=data.get("action") or "implement",
        count=int(data.get("count", 5) or 5),
        status=data.get("status") or "TODO",
        require_tag=data.get("requireTag") or data.get("require_tag"),
        require_text=data.get("requireText") or data.get("require_text"),
        continue_on_fail=bool(data.get("continueOnFail", False)),
        cooldown_minutes=int(data.get("cooldownMinutes", 0) or 0),
        synthesize_followups=bool(data.get("synthesizeFollowups", data.get("synthesize_followups", False))),
        followup_min_occurrences=int(data.get("followupMinOccurrences", 2) or 2),
        followup_max_new_bats=int(data.get("followupMaxNewBats", 3) or 3),
        host_boundary=data.get("hostBoundary") or data.get("host_boundary") or {},
        model_profile_id=data.get("modelProfileId") or data.get("model_profile_id"),
        task_mode_routes=data.get("taskModeRoutes") or data.get("task_mode_routes") or {},
    )


def _runs_dir(project_root: Path | None = None) -> Path:
    return assistant_runs_dir(project_root or REPO_ROOT)


def _default_log_path(project_root: Path | None = None) -> Path:
    return assistant_log_path(project_root or REPO_ROOT)


def _default_report_path(project_root: Path | None = None) -> Path:
    return assistant_log_report_path(project_root or REPO_ROOT)


def _default_training_output_path(project_root: Path | None = None) -> Path:
    return assistant_training_output_path(project_root or REPO_ROOT)


def _default_experiment_dataset_path(project_root: Path | None = None) -> Path:
    return assistant_experiment_dataset_path(project_root or REPO_ROOT)


def _default_self_improvement_queue_path(project_root: Path | None = None) -> Path:
    return assistant_self_improvement_queue_path(project_root or REPO_ROOT)


def _default_self_improvement_history_path(project_root: Path | None = None) -> Path:
    return assistant_self_improvement_history_path(project_root or REPO_ROOT)


def _default_self_improvement_seed_path(project_root: Path | None = None) -> Path:
    return assistant_self_improvement_seed_path(project_root or REPO_ROOT)


def _default_project_maintenance_queue_path(project_root: Path | None = None) -> Path:
    return assistant_project_maintenance_queue_path(project_root or REPO_ROOT)


def _default_project_maintenance_history_path(project_root: Path | None = None) -> Path:
    return assistant_project_maintenance_history_path(project_root or REPO_ROOT)


def _default_owner_automation_queue_path(project_root: Path | None = None) -> Path:
    return assistant_owner_automation_queue_path(project_root or REPO_ROOT)


def _default_owner_automation_history_path(project_root: Path | None = None) -> Path:
    return assistant_owner_automation_history_path(project_root or REPO_ROOT)


def _selected_project_root(payload: dict[str, Any] | None = None) -> Path:
    data = dict(payload or {})
    raw_root = (
        data.get("targetWorkspaceRoot")
        or data.get("target_workspace_root")
        or data.get("projectRoot")
        or data.get("project_root")
        or data.get("repoRoot")
        or data.get("repo_root")
        or data.get("workspace")
    )
    if raw_root is None or not str(raw_root).strip():
        return REPO_ROOT
    candidate = Path(str(raw_root)).expanduser()
    resolved = candidate.resolve() if candidate.is_absolute() else (REPO_ROOT / candidate).resolve()
    if not resolved.exists() or not resolved.is_dir():
        raise RuntimeApiError(f"invalid project root: {raw_root}")
    return resolved


def _selected_self_improvement_task(payload: dict[str, Any], summary: dict[str, Any]) -> dict[str, Any]:
    direct_task = payload.get("task")
    if isinstance(direct_task, dict):
        return dict(direct_task)
    task_id = str(payload.get("taskId") or payload.get("task_id") or "").strip()
    prepared_tasks = [dict(item) for item in list(summary.get("prepared_tasks") or []) if isinstance(item, dict)]
    if task_id:
        for item in prepared_tasks:
            if str(item.get("task_id") or "") == task_id:
                return item
        raise RuntimeApiError(f"unknown self-improvement task: {task_id}")
    if prepared_tasks:
        return prepared_tasks[0]
    raise RuntimeApiError("no prepared self-improvement tasks are available")


def _selected_project_maintenance_task(payload: dict[str, Any], summary: dict[str, Any]) -> dict[str, Any]:
    direct_task = payload.get("task")
    if isinstance(direct_task, dict):
        return dict(direct_task)
    task_id = str(payload.get("taskId") or payload.get("task_id") or "").strip()
    prepared_tasks = [dict(item) for item in list(summary.get("prepared_tasks") or []) if isinstance(item, dict)]
    if task_id:
        for item in prepared_tasks:
            if str(item.get("task_id") or "") == task_id:
                return item
        raise RuntimeApiError(f"unknown project maintenance task: {task_id}")
    if prepared_tasks:
        return prepared_tasks[0]
    raise RuntimeApiError("no prepared project maintenance tasks are available")


def _selected_owner_automation_task(payload: dict[str, Any], summary: dict[str, Any]) -> dict[str, Any]:
    direct_task = payload.get("task")
    if isinstance(direct_task, dict):
        return dict(direct_task)
    task_id = str(payload.get("taskId") or payload.get("task_id") or "").strip()
    prepared_tasks = [dict(item) for item in list(summary.get("prepared_tasks") or []) if isinstance(item, dict)]
    if task_id:
        for item in prepared_tasks:
            if str(item.get("task_id") or "") == task_id:
                return item
        raise RuntimeApiError(f"unknown owner automation task: {task_id}")
    if prepared_tasks:
        return prepared_tasks[0]
    raise RuntimeApiError("no prepared owner automation tasks are available")


def _requested_owner_goals(payload: dict[str, Any]) -> list[Any]:
    requested = payload.get("ownerGoals") or payload.get("owner_goals") or payload.get("goals")
    goals: list[Any] = []
    if isinstance(requested, list):
        goals.extend(requested)
    elif requested is not None:
        goals.append(requested)
    single_goal = payload.get("goal")
    if single_goal is not None:
        goals.append(single_goal)
    return [item for item in goals if item is not None]


def _self_improvement_task_status(runtime_result: dict[str, Any]) -> str:
    review_state = dict(runtime_result.get("review_state") or {})
    runtime_failure = dict(runtime_result.get("runtime_failure") or {})
    if bool(review_state.get("requires_manual_review")):
        return "review"
    if bool(runtime_result.get("ok", False)):
        return "succeeded"
    if bool(runtime_failure.get("blocking", False)):
        return "blocked"
    return "failed"


def _project_maintenance_task_status(runtime_result: dict[str, Any], host_boundary: dict[str, Any] | None = None) -> str:
    review_state = dict(runtime_result.get("review_state") or {})
    runtime_failure = dict(runtime_result.get("runtime_failure") or {})
    boundary = dict(host_boundary or {})
    if bool(runtime_result.get("ok", False)):
        if bool(review_state.get("requires_manual_review")) or bool(boundary.get("require_review", boundary.get("requireReview", False))):
            return "pending_review"
        return "succeeded"
    if bool(runtime_failure.get("blocking", False)):
        return "blocked"
    if bool(review_state.get("requires_manual_review")):
        return "pending_review"
    return "failed"


def _owner_automation_task_status(runtime_result: dict[str, Any], host_boundary: dict[str, Any] | None = None) -> str:
    review_state = dict(runtime_result.get("review_state") or {})
    runtime_failure = dict(runtime_result.get("runtime_failure") or {})
    boundary = dict(host_boundary or {})
    if bool(runtime_result.get("ok", False)):
        if bool(review_state.get("requires_manual_review")) or bool(boundary.get("require_review", boundary.get("requireReview", False))):
            return "pending_review"
        return "succeeded"
    if bool(runtime_failure.get("blocking", False)):
        return "blocked"
    if bool(review_state.get("requires_manual_review")):
        return "pending_review"
    return "failed"


def _latest_matching_artifact(pattern: str, *, started_mtime_ns: int, allow_fallback: bool = True) -> Path | None:
    runs_dir = _runs_dir()
    candidates = sorted(runs_dir.glob(pattern), key=lambda item: item.stat().st_mtime_ns if item.exists() else 0, reverse=True)
    for candidate in candidates:
        try:
            if candidate.stat().st_mtime_ns >= started_mtime_ns:
                return candidate
        except FileNotFoundError:
            continue
    return candidates[0] if allow_fallback and candidates else None


def _resolve_artifact_path(value: Any) -> Path | None:
    text = str(value or "").strip()
    if not text:
        return None
    candidate = Path(text)
    if candidate.is_absolute():
        return candidate
    return (REPO_ROOT / candidate).resolve()


def _blocked_sprint_reasons(artifact: dict[str, Any] | None) -> list[str]:
    if not isinstance(artifact, dict):
        return []
    outcomes = artifact.get("outcomes")
    if not isinstance(outcomes, list) or not outcomes:
        return []
    reasons: list[str] = []
    for outcome in outcomes:
        if not isinstance(outcome, dict):
            return []
        outcome_artifact = _read_json(_resolve_artifact_path(outcome.get("artifact")))
        reason = str((outcome_artifact or {}).get("blocked_reason") or "").strip()
        if not reason:
            return []
        reasons.append(reason)
    deduped: list[str] = []
    seen: set[str] = set()
    for reason in reasons:
        if reason in seen:
            continue
        seen.add(reason)
        deduped.append(reason)
    return deduped


def _solo_result(action: str, ticket_id: str, exit_code: int, artifact_path: Path | None) -> dict[str, Any]:
    artifact = _read_json(artifact_path) if artifact_path else None
    checks = list(artifact.get("checks", [])) if isinstance(artifact, dict) else []
    ok = exit_code == 0
    if isinstance(artifact, dict) and "all_checks_passed" in artifact:
        ok = ok and bool(artifact.get("all_checks_passed"))
    runtime_context = dict((artifact or {}).get("runtime_context") or (artifact or {}).get("runtimeContext") or {}) if isinstance(artifact, dict) else {}
    trust_summary = _extract_trust_summary(artifact)
    review_summary = dict((artifact or {}).get("review_summary") or (artifact or {}).get("reviewSummary") or {}) if isinstance(artifact, dict) else {}
    run_summary = dict((artifact or {}).get("run_summary") or (artifact or {}).get("runSummary") or {}) if isinstance(artifact, dict) else {}
    test_summary = dict((artifact or {}).get("test_summary") or (artifact or {}).get("testSummary") or {}) if isinstance(artifact, dict) else {}
    experiment_benchmark_summary = dict((artifact or {}).get("experiment_benchmark_summary") or (artifact or {}).get("experimentBenchmarkSummary") or {}) if isinstance(artifact, dict) else {}
    owner_experiment_summary = dict((artifact or {}).get("owner_experiment_summary") or (artifact or {}).get("ownerExperimentSummary") or {}) if isinstance(artifact, dict) else {}
    training_handoff = dict((artifact or {}).get("training_handoff") or (artifact or {}).get("trainingHandoff") or {}) if isinstance(artifact, dict) else {}
    operator_execution = _build_operator_execution_payload(
        task=str((artifact or {}).get("desc") or f"{action.upper()} BAT<{ticket_id}>") if isinstance(artifact, dict) else f"{action.upper()} BAT<{ticket_id}>",
        task_mode=str((artifact or {}).get("task_mode") or (artifact or {}).get("taskMode") or ""),
        action=action,
        ticket_id=ticket_id,
        run_id="",
        status="completed",
        run_state="succeeded" if ok else "failed",
        current_stage="runtime",
        result_summary=str(review_summary.get("summary") or run_summary.get("summary") or test_summary.get("summary") or ""),
        runtime_context=runtime_context,
        review_summary=review_summary,
        trust_summary=trust_summary,
        run_summary=run_summary,
        test_summary=test_summary,
        benchmark_summary=experiment_benchmark_summary,
        owner_experiment_summary=owner_experiment_summary,
        training_handoff=training_handoff,
        artifact_paths=[str(artifact_path)] if artifact_path else [],
        runtime_task=dict((artifact or {}).get("runtime_task") or (artifact or {}).get("runtimeTask") or {}) if isinstance(artifact, dict) else {},
        runtime_run=dict((artifact or {}).get("runtime_run") or (artifact or {}).get("runtimeRun") or {}) if isinstance(artifact, dict) else {},
        runtime_result=dict((artifact or {}).get("runtime_result") or (artifact or {}).get("runtimeResult") or {}) if isinstance(artifact, dict) else {},
        runtime_failure=dict((artifact or {}).get("runtime_failure") or (artifact or {}).get("runtimeFailure") or {}) if isinstance(artifact, dict) else {},
        runtime_events=list((artifact or {}).get("runtime_events") or (artifact or {}).get("runtimeEvents") or []) if isinstance(artifact, dict) else [],
        review_state=dict((artifact or {}).get("review_state") or (artifact or {}).get("reviewState") or {}) if isinstance(artifact, dict) else {},
        review_requests=list((artifact or {}).get("review_requests") or (artifact or {}).get("reviewRequests") or []) if isinstance(artifact, dict) else [],
        recommended_actions=list((artifact or {}).get("recommended_actions") or (artifact or {}).get("recommendedActions") or []) if isinstance(artifact, dict) else [],
        retry_available=not ok,
        repair_available=bool(ticket_id),
    )
    return {
        "ok": ok,
        "action": action,
        "ticket": ticket_id,
        "exitCode": exit_code,
        "checks": checks,
        "artifact": artifact,
        "artifactPaths": [str(artifact_path)] if artifact_path else [],
        "label": f"{action.upper()} BAT<{ticket_id}>",
        "runtimeContext": runtime_context,
        "reviewRequests": list((artifact or {}).get("review_requests") or (artifact or {}).get("reviewRequests") or []) if isinstance(artifact, dict) else [],
        "reviewState": dict((artifact or {}).get("review_state") or (artifact or {}).get("reviewState") or {}) if isinstance(artifact, dict) else {},
        "reviewSummary": review_summary,
        "trustSummary": trust_summary,
        "ownerSummary": dict((artifact or {}).get("owner_summary") or (artifact or {}).get("ownerSummary") or {}) if isinstance(artifact, dict) else {},
        "runSummary": run_summary,
        "testSummary": test_summary,
        "reviewQueueSummary": dict((artifact or {}).get("review_queue_summary") or (artifact or {}).get("reviewQueueSummary") or {}) if isinstance(artifact, dict) else {},
        "recommendedActions": list((artifact or {}).get("recommended_actions") or (artifact or {}).get("recommendedActions") or []) if isinstance(artifact, dict) else [],
        "experimentRun": dict((artifact or {}).get("experiment_run") or (artifact or {}).get("experimentRun") or {}) if isinstance(artifact, dict) else {},
        "experimentScenario": dict((artifact or {}).get("experiment_scenario") or (artifact or {}).get("experimentScenario") or {}) if isinstance(artifact, dict) else {},
        "experimentScorecard": dict((artifact or {}).get("experiment_scorecard") or (artifact or {}).get("experimentScorecard") or {}) if isinstance(artifact, dict) else {},
        "strategyBenchmark": dict((artifact or {}).get("strategy_benchmark") or (artifact or {}).get("strategyBenchmark") or {}) if isinstance(artifact, dict) else {},
        "experimentBenchmarkSummary": experiment_benchmark_summary,
        "ownerExperimentSummary": owner_experiment_summary,
        "trainingHandoff": training_handoff,
        "operatorExecution": operator_execution,
    }


def _extract_trust_summary(payload: dict[str, Any] | None) -> dict[str, Any]:
    source = dict(payload or {}) if isinstance(payload, dict) else {}
    run_summary = dict(source.get("run_summary") or source.get("runSummary") or {})
    experiment_scorecard = dict(source.get("experiment_scorecard") or source.get("experimentScorecard") or {})
    return dict(
        source.get("trust_summary")
        or source.get("trustSummary")
        or (run_summary.get("metadata") or {}).get("trust_summary")
        or (experiment_scorecard.get("metadata") or {}).get("trust_summary")
        or {}
    )


def _extract_queue_trust_payload(
    queue_summary: dict[str, Any] | None,
    history_summary: dict[str, Any] | None = None,
) -> dict[str, Any]:
    queue = dict(queue_summary or {})
    history = dict(history_summary or {})
    metadata = dict(queue.get("metadata") or {})
    return {
        "trustSummary": dict(metadata.get("last_trust_summary") or history.get("last_trust_summary") or {}),
        "trustSignalCount": int(metadata.get("trust_signal_count") or history.get("trust_signal_count") or 0),
        "trustStateCounts": dict(metadata.get("trust_state_counts") or history.get("trust_state_counts") or {}),
        "learningLabelCounts": dict(metadata.get("learning_label_counts") or history.get("learning_label_counts") or {}),
        "approvalModeCounts": dict(metadata.get("approval_mode_counts") or history.get("approval_mode_counts") or {}),
    }


def _queue_trust_export_fields(
    queue_summary: dict[str, Any] | None,
    history_summary: dict[str, Any] | None = None,
) -> dict[str, Any]:
    trust_payload = _extract_queue_trust_payload(queue_summary, history_summary)
    return {
        "trust_summary": dict(trust_payload.get("trustSummary") or {}),
        "trust_signal_count": int(trust_payload.get("trustSignalCount") or 0),
        "trust_state_counts": dict(trust_payload.get("trustStateCounts") or {}),
        "learning_label_counts": dict(trust_payload.get("learningLabelCounts") or {}),
        "approval_mode_counts": dict(trust_payload.get("approvalModeCounts") or {}),
    }


def _augment_nested_queue_trust(summary_payload: dict[str, Any] | None) -> dict[str, Any]:
    payload = dict(summary_payload or {})
    queue_summary = dict(payload.get("queue_summary") or payload.get("queueSummary") or {})
    history_summary = dict(payload.get("history_summary") or payload.get("historySummary") or {})
    payload.update(_queue_trust_export_fields(queue_summary, history_summary))
    return payload


def _build_task_objective_payload(
    *,
    task: str,
    task_mode: str,
    action: str,
    lane_id: str = "",
    lane_label: str = "",
    runtime_task: dict[str, Any] | None = None,
) -> dict[str, Any]:
    metadata = dict((runtime_task or {}).get("metadata") or {})
    seed = dict(metadata.get("task_objective") or metadata.get("taskObjective") or {})
    return build_task_objective(
        summary=str(seed.get("summary") or task or ""),
        kind=str(seed.get("kind") or action or task_mode or ""),
        source=str(seed.get("source") or metadata.get("surface") or "desktop-runtime"),
        task_mode=str(task_mode or ""),
        action=str(action or ""),
        lane_id=str(lane_id or metadata.get("lane_id") or metadata.get("laneId") or ""),
        lane_label=str(lane_label or metadata.get("lane_label") or metadata.get("laneLabel") or ""),
        loop_steps=list(seed.get("loop_steps") or seed.get("loopSteps") or DEV_ENGINE_LOOP_STEPS),
        metadata={
            "ticket": str((runtime_task or {}).get("ticket") or ""),
        },
    )


def _build_failure_class_payload(
    *,
    runtime_failure: dict[str, Any] | None = None,
    review_summary: dict[str, Any] | None = None,
    run_state: str = "",
) -> dict[str, Any]:
    failure = dict(runtime_failure or {})
    review = dict(review_summary or {})
    if failure:
        code = str(failure.get("kind") or "").strip().lower()
        code = {
            "review-required": "reviewer-block",
            "ticket-blocked": "risky-interrupt",
            "tool-loop-failure": "validation-failure",
        }.get(code, code)
        return build_failure_class(
            code=code,
            summary=str(failure.get("message") or ""),
            stage=str(failure.get("stage") or ""),
            retryable=bool(failure.get("retryable", False)),
            blocking=bool(failure.get("blocking", False)),
            metadata={
                "details": dict(failure.get("details") or {}),
                "retry_policy": dict(failure.get("retry_policy") or {}),
                "run_state": str(run_state or ""),
            },
        )
    if bool(review.get("requires_manual_review")):
        return build_failure_class(
            code="reviewer-block",
            summary=str(review.get("summary") or "manual review required"),
            stage="review",
            retryable=False,
            blocking=True,
            metadata={"run_state": str(run_state or "")},
        )
    return {}


def _build_recovery_ladder_payload(
    *,
    runtime_run: dict[str, Any] | None = None,
    runtime_failure: dict[str, Any] | None = None,
    runtime_events: list[dict[str, Any]] | None = None,
    validation: dict[str, Any] | None = None,
    repair: dict[str, Any] | None = None,
    review_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    run = dict(runtime_run or {})
    failure = dict(runtime_failure or {})
    retry_policy = dict(failure.get("retry_policy") or (validation or {}).get("retry_policy") or (repair or {}).get("retry_policy") or {})
    retry_action = str(retry_policy.get("action") or "").strip().lower()
    next_step = {
        "repair": "repair-oriented-route",
        "run": "local-targeted-coding",
        "plan": "bridge-plan-retry",
        "implement": "stronger-coding-route",
    }.get(retry_action, "")
    current_step = {
        "planning": "local-targeted-coding",
        "implementing": "local-targeted-coding",
        "executing": "local-targeted-coding",
        "validating": "repair-oriented-route" if not dict(validation or {}).get("ok", True) else "validate",
        "repairing": "repair-oriented-route",
        "releasing": "interrupt-or-rollback" if bool(dict(review_state or {}).get("requires_manual_review")) else "review",
        "blocked": "interrupt-or-rollback",
        "failed": "interrupt-or-rollback",
        "succeeded": "continue-stop",
    }.get(str(run.get("state") or run.get("current_stage") or "").strip().lower(), "")
    ladder_state = str(run.get("state") or "").strip().lower()
    if ladder_state == "blocked":
        ladder_state = "blocked"
    elif ladder_state == "failed":
        ladder_state = "failed"
    elif ladder_state == "succeeded":
        ladder_state = "completed"
    else:
        ladder_state = "running"
    history = [
        {
            "stage": str(item.get("stage") or ""),
            "state": str(item.get("state") or ""),
            "summary": str(item.get("summary") or ""),
            "entered_at": str(item.get("timestamp") or item.get("entered_at") or ""),
        }
        for item in list(runtime_events or [])
        if isinstance(item, dict) and str(item.get("summary") or "")
    ]
    return build_recovery_ladder_state(
        state=ladder_state,
        current_step=current_step,
        next_step=next_step,
        available_steps=RECOVERY_LADDER_STEPS,
        history=history[-8:],
        metadata={
            "retry_policy": retry_policy,
            "repair_skipped": bool(dict(repair or {}).get("skipped", False)),
            "repair_count": len(list(dict(repair or {}).get("repairs") or [])),
        },
    )


def _build_checkpoint_ref_payload(
    *,
    run_id: str,
    artifact_paths: list[str] | None = None,
) -> dict[str, Any]:
    paths = [str(path) for path in list(artifact_paths or []) if str(path)]
    if not paths:
        return {}
    primary_path = paths[0]
    return build_checkpoint_ref(
        ref_id=str(run_id or primary_path),
        label="latest-runtime-artifact",
        kind="artifact-ref",
        path=primary_path,
        summary="Latest runtime artifact recorded for trace, retry, and review.",
        metadata={"artifact_paths": paths},
    )


def _build_interrupt_request_payload(
    *,
    review_summary: dict[str, Any] | None = None,
    review_state: dict[str, Any] | None = None,
    review_requests: list[dict[str, Any]] | None = None,
    runtime_failure: dict[str, Any] | None = None,
) -> dict[str, Any]:
    review = dict(review_summary or {})
    state = dict(review_state or {})
    requests = [dict(item) for item in list(review_requests or []) if isinstance(item, dict)]
    pending_approvals = [dict(item) for item in list(review.get("pending_approvals") or []) if isinstance(item, dict)]
    failure = dict(runtime_failure or {})
    if pending_approvals:
        return build_interrupt_request(
            kind="approval",
            summary=str(review.get("summary") or f"{len(pending_approvals)} approval request(s) pending"),
            active=True,
            requested_action="approve-risky-action",
            allowed_actions=["approve-risky-action", "open-trace", "resume-interrupted-task"],
            request_count=len(pending_approvals),
            metadata={"requests": pending_approvals[:5], "review_requests": requests[:5]},
        )
    if bool(state.get("requires_manual_review")) or bool(review.get("requires_manual_review")):
        return build_interrupt_request(
            kind="review",
            summary=str(review.get("summary") or "manual review required"),
            active=True,
            requested_action="resolve-review",
            allowed_actions=["open-trace", "review-findings", "resume-interrupted-task"],
            request_count=int(state.get("pending_review_count") or review.get("pending_review_count") or len(requests)),
            metadata={"review_requests": requests[:5]},
        )
    if failure and bool(failure.get("blocking", False)):
        return build_interrupt_request(
            kind="runtime-block",
            summary=str(failure.get("message") or "runtime blocked"),
            active=True,
            requested_action="rollback-or-interrupt",
            allowed_actions=["open-trace", "retry"],
            request_count=1,
            metadata={"failure_kind": str(failure.get("kind") or "")},
        )
    return {}


def _build_review_bundle_payload(
    *,
    review_summary: dict[str, Any] | None = None,
    review_state: dict[str, Any] | None = None,
    review_requests: list[dict[str, Any]] | None = None,
    trust_summary: dict[str, Any] | None = None,
    runtime_failure: dict[str, Any] | None = None,
    runtime_context: dict[str, Any] | None = None,
    ok: bool = False,
) -> dict[str, Any]:
    review = dict(review_summary or {})
    state = dict(review_state or {})
    requests = [dict(item) for item in list(review_requests or []) if isinstance(item, dict)]
    failure = dict(runtime_failure or {})
    changed_files = [
        dict(item)
        for item in list((runtime_context or {}).get("changed_files") or (runtime_context or {}).get("changedFiles") or [])
        if isinstance(item, dict)
    ]
    verdict = "observed"
    failure_kind = str(failure.get("kind") or "").strip().lower()
    if bool(review.get("requires_manual_review")) or bool(state.get("requires_manual_review")):
        verdict = "pending-review"
    elif failure_kind in {"validation-failure", "empty-proposal", "parse-failure", "invalid-change-set"}:
        verdict = "repair-required"
    elif ok and int(review.get("low_confidence_patch_count") or 0) > 0:
        verdict = "approved-with-warnings"
    elif ok:
        verdict = "approved"
    elif failure:
        verdict = "blocked"
    first_request = requests[0] if requests else {}
    first_changed_path = str((changed_files[0] or {}).get("path") or "").strip() if changed_files else ""
    review_reason = str(review.get("summary") or first_request.get("summary") or failure.get("message") or "").strip()
    review_next_action = str(
        review.get("next_action")
        or review.get("nextAction")
        or first_request.get("next_action")
        or first_request.get("nextAction")
        or ""
    ).strip()
    change_summary = (
        f"{len(changed_files)} changed file(s) touched"
        + (f", starting with {first_changed_path}" if first_changed_path else "")
        if changed_files
        else "No changed files were captured yet."
    )
    if verdict == "pending-review":
        reason = review_reason or "Manual review or approval is still required before the run can continue."
        how_to_fix = review_next_action or "Review the held findings, inspect the changed files, and clear the pending approvals."
        fix_actions = ["review-interrupt", "open-files", "open-trace"]
    elif verdict == "repair-required":
        reason = review_reason or {
            "empty-proposal": "The engine returned no usable edits for the current bounded objective.",
            "parse-failure": "The engine response could not be parsed into a valid change set.",
            "invalid-change-set": "The proposed patch was outside the allowed workspace bounds or otherwise unsafe.",
            "validation-failure": "Validation failed for the current bounded change.",
        }.get(failure_kind, "The run needs another bounded repair pass before it can be approved.")
        how_to_fix = review_next_action or {
            "empty-proposal": "Retry with more repo research or a tighter prompt before asking for another patch.",
            "parse-failure": "Retry from a smaller bridge plan or stronger structured prompt so the next change set parses cleanly.",
            "invalid-change-set": "Keep the next patch inside the allowed target paths or retry it in the sandbox/worktree first.",
            "validation-failure": "Repair the failing validation path and rerun the smallest relevant check before continuing.",
        }.get(failure_kind, "Run one bounded repair pass and rerun the most relevant validation before continuing.")
        fix_actions = [
            "retry-with-research" if failure_kind in {"empty-proposal", "parse-failure"} else "repair-loop",
            "open-trace",
            "open-files",
        ]
        if failure_kind == "invalid-change-set":
            fix_actions.insert(1, "open-sandbox")
    elif verdict == "approved-with-warnings":
        reason = review_reason or "The run is usable, but low-confidence changes still deserve a spot check."
        how_to_fix = review_next_action or "Inspect the changed files and rerun the most relevant validation before promotion."
        fix_actions = ["open-files", "open-trace", "continue-run"]
    elif verdict == "approved":
        reason = review_reason or "The current bounded run cleared validation and review gates."
        how_to_fix = review_next_action or "Keep the next slice bounded and continue from the latest objective."
        fix_actions = ["continue-run", "open-files"]
    else:
        reason = review_reason or "The run is blocked by the current runtime or review gate."
        how_to_fix = review_next_action or "Resolve the blocking issue, inspect the latest trace, and roll back the last pass if needed."
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
        summary=str(review.get("summary") or ""),
        reason=reason,
        how_to_fix=how_to_fix,
        change_summary=change_summary,
        approval_state=verdict,
        approved=verdict in {"approved", "approved-with-warnings"},
        requires_manual_review=bool(review.get("requires_manual_review") or state.get("requires_manual_review")),
        request_count=len(requests),
        pending_count=int(state.get("pending_review_count") or review.get("pending_review_count") or 0),
        fix_actions=fix_actions,
        trust_summary=dict(trust_summary or {}),
        review_requests=requests[:5],
        metadata={
            "low_confidence_patch_count": int(review.get("low_confidence_patch_count") or 0),
            "failure_kind": failure_kind,
        },
    )


def _build_workbench_artifacts_payload(
    *,
    runtime_context: dict[str, Any] | None = None,
    artifact_paths: list[str] | None = None,
) -> list[dict[str, Any]]:
    changed_files = [dict(item) for item in list((runtime_context or {}).get("changed_files") or (runtime_context or {}).get("changedFiles") or []) if isinstance(item, dict)]
    rows: list[dict[str, Any]] = []
    for item in changed_files[:8]:
        rows.append(
            build_workbench_artifact(
                kind="changed-file",
                label=str(item.get("path") or ""),
                path=str(item.get("path") or ""),
                summary=str(item.get("status") or "changed"),
                status="available",
            )
        )
    for raw_path in [str(path) for path in list(artifact_paths or []) if str(path)][:6]:
        rows.append(
            build_workbench_artifact(
                kind="runtime-artifact",
                label=Path(raw_path).name,
                path=raw_path,
                summary="runtime artifact",
                status="available",
            )
        )
    return rows[:10]


def _camelize_operator_execution(payload: dict[str, Any] | None) -> dict[str, Any]:
    source = dict(payload or {})
    stage_summary = dict(source.get("stage_summary") or {})
    benchmark_metadata = dict(source.get("benchmark_metadata") or {})
    learning_metadata = dict(source.get("learning_metadata") or {})
    output_tail = dict(source.get("output_tail") or {})
    task_objective = dict(source.get("task_objective") or {})
    failure_class = dict(source.get("failure_class") or {})
    recovery_ladder = dict(source.get("recovery_ladder") or {})
    checkpoint_ref = dict(source.get("checkpoint_ref") or {})
    interrupt_request = dict(source.get("interrupt_request") or {})
    review_bundle = dict(source.get("review_bundle") or {})
    return {
        "task": str(source.get("task") or ""),
        "taskMode": str(source.get("task_mode") or ""),
        "action": str(source.get("action") or ""),
        "laneId": str(source.get("lane_id") or ""),
        "laneLabel": str(source.get("lane_label") or ""),
        "ticket": str(source.get("ticket") or ""),
        "modelProfileId": str(source.get("model_profile_id") or ""),
        "modelRole": str(source.get("model_role") or ""),
        "modelDisplayName": str(source.get("model_display_name") or ""),
        "baseModel": str(source.get("base_model") or ""),
        "providerSource": str(source.get("provider_source") or ""),
        "runId": str(source.get("run_id") or ""),
        "status": str(source.get("status") or ""),
        "runState": str(source.get("run_state") or ""),
        "stageSummary": {
            "currentStage": str(stage_summary.get("current_stage") or ""),
            "summary": str(stage_summary.get("summary") or ""),
            "finalState": str(stage_summary.get("final_state") or ""),
        },
        "resultSummary": str(source.get("result_summary") or ""),
        "diffSummary": str(source.get("diff_summary") or ""),
        "changedFiles": [
            {
                "path": str(item.get("path") or ""),
                "status": str(item.get("status") or ""),
            }
            for item in list(source.get("changed_files") or [])
            if isinstance(item, dict) and str(item.get("path") or "")
        ],
        "changedFileCount": int(source.get("changed_file_count") or 0),
        "outputTail": {
            "combined": str(output_tail.get("combined") or ""),
            "stdout": str(output_tail.get("stdout") or ""),
            "stderr": str(output_tail.get("stderr") or ""),
        },
        "reviewSummary": dict(source.get("review_summary") or {}),
        "trustSummary": dict(source.get("trust_summary") or {}),
        "runSummary": dict(source.get("run_summary") or {}),
        "testSummary": dict(source.get("test_summary") or {}),
        "benchmarkMetadata": dict(benchmark_metadata or {}),
        "learningMetadata": dict(learning_metadata or {}),
        "artifactPaths": [str(path) for path in list(source.get("artifact_paths") or []) if str(path)],
        "validationCommands": [str(command) for command in list(source.get("validation_commands") or []) if str(command)],
        "retryAvailable": bool(source.get("retry_available", False)),
        "repairAvailable": bool(source.get("repair_available", False)),
        "taskObjective": {
            "summary": str(task_objective.get("summary") or ""),
            "kind": str(task_objective.get("kind") or ""),
            "source": str(task_objective.get("source") or ""),
            "taskMode": str(task_objective.get("task_mode") or ""),
            "action": str(task_objective.get("action") or ""),
            "laneId": str(task_objective.get("lane_id") or ""),
            "laneLabel": str(task_objective.get("lane_label") or ""),
            "loopSteps": [str(item) for item in list(task_objective.get("loop_steps") or []) if str(item)],
            "metadata": dict(task_objective.get("metadata") or {}),
        },
        "failureClass": {
            "code": str(failure_class.get("code") or ""),
            "summary": str(failure_class.get("summary") or ""),
            "stage": str(failure_class.get("stage") or ""),
            "retryable": bool(failure_class.get("retryable", False)),
            "blocking": bool(failure_class.get("blocking", False)),
            "metadata": dict(failure_class.get("metadata") or {}),
        },
        "recoveryLadder": {
            "state": str(recovery_ladder.get("state") or ""),
            "currentStep": str(recovery_ladder.get("current_step") or ""),
            "nextStep": str(recovery_ladder.get("next_step") or ""),
            "availableSteps": [str(item) for item in list(recovery_ladder.get("available_steps") or []) if str(item)],
            "history": [dict(item) for item in list(recovery_ladder.get("history") or []) if isinstance(item, dict)],
            "metadata": dict(recovery_ladder.get("metadata") or {}),
        },
        "checkpointRef": {
            "refId": str(checkpoint_ref.get("ref_id") or ""),
            "label": str(checkpoint_ref.get("label") or ""),
            "kind": str(checkpoint_ref.get("kind") or ""),
            "path": str(checkpoint_ref.get("path") or ""),
            "summary": str(checkpoint_ref.get("summary") or ""),
            "metadata": dict(checkpoint_ref.get("metadata") or {}),
        },
        "interruptRequest": {
            "kind": str(interrupt_request.get("kind") or ""),
            "summary": str(interrupt_request.get("summary") or ""),
            "active": bool(interrupt_request.get("active", False)),
            "requestedAction": str(interrupt_request.get("requested_action") or ""),
            "allowedActions": [str(item) for item in list(interrupt_request.get("allowed_actions") or []) if str(item)],
            "requestCount": int(interrupt_request.get("request_count") or 0),
            "metadata": dict(interrupt_request.get("metadata") or {}),
        },
        "reviewBundle": {
            "verdict": str(review_bundle.get("verdict") or ""),
            "decisionLabel": str(review_bundle.get("decision_label") or ""),
            "summary": str(review_bundle.get("summary") or ""),
            "reason": str(review_bundle.get("reason") or ""),
            "howToFix": str(review_bundle.get("how_to_fix") or ""),
            "changeSummary": str(review_bundle.get("change_summary") or ""),
            "approvalState": str(review_bundle.get("approval_state") or ""),
            "approved": bool(review_bundle.get("approved", False)),
            "requiresManualReview": bool(review_bundle.get("requires_manual_review", False)),
            "requestCount": int(review_bundle.get("request_count") or 0),
            "pendingCount": int(review_bundle.get("pending_count") or 0),
            "fixActions": [str(item) for item in list(review_bundle.get("fix_actions") or []) if str(item)],
            "trustSummary": dict(review_bundle.get("trust_summary") or {}),
            "reviewRequests": [dict(item) for item in list(review_bundle.get("review_requests") or []) if isinstance(item, dict)],
            "metadata": dict(review_bundle.get("metadata") or {}),
        },
        "workbenchArtifacts": [dict(item) for item in list(source.get("workbench_artifacts") or []) if isinstance(item, dict)],
    }


def _build_operator_execution_payload(
    *,
    task: str,
    task_mode: str,
    action: str,
    ticket_id: str,
    run_id: str,
    status: str,
    run_state: str,
    current_stage: str,
    result_summary: str,
    runtime_context: dict[str, Any] | None = None,
    review_summary: dict[str, Any] | None = None,
    trust_summary: dict[str, Any] | None = None,
    run_summary: dict[str, Any] | None = None,
    test_summary: dict[str, Any] | None = None,
    benchmark_summary: dict[str, Any] | None = None,
    owner_experiment_summary: dict[str, Any] | None = None,
    training_handoff: dict[str, Any] | None = None,
    artifact_paths: list[str] | None = None,
    operator_execution: dict[str, Any] | None = None,
    runtime_task: dict[str, Any] | None = None,
    runtime_run: dict[str, Any] | None = None,
    runtime_result: dict[str, Any] | None = None,
    runtime_failure: dict[str, Any] | None = None,
    runtime_events: list[dict[str, Any]] | None = None,
    review_state: dict[str, Any] | None = None,
    review_requests: list[dict[str, Any]] | None = None,
    recommended_actions: list[dict[str, Any]] | None = None,
    lane_id: str = "",
    lane_label: str = "",
    model_profile_id: str = "",
    model_role: str = "",
    model_display_name: str = "",
    base_model: str = "",
    provider_source: str = "",
    retry_available: bool = False,
    repair_available: bool = False,
) -> dict[str, Any]:
    seed = dict(operator_execution or {})
    effective_artifact_paths = [str(path) for path in list(artifact_paths or seed.get("artifactPaths") or seed.get("artifact_paths") or []) if str(path)]
    validation_commands = [
        str(item).strip()
        for item in list(
            seed.get("validationCommands")
            or seed.get("validation_commands")
            or ((runtime_result or {}).get("validation") or {}).get("commands")
            or ((runtime_context or {}).get("validation_scope") or {}).get("commands")
            or ((runtime_context or {}).get("validationScope") or {}).get("commands")
            or []
        )
        if str(item).strip()
    ]
    memory_hints = dict(
        seed.get("memoryHints")
        or seed.get("memory_hints")
        or (seed.get("learningMetadata") or {}).get("memoryHints")
        or (seed.get("learning_metadata") or {}).get("memory_hints")
        or (runtime_result or {}).get("memory_hints")
        or (runtime_result or {}).get("memoryHints")
        or ((runtime_context or {}).get("memory_state") or {}).get("memory_hints")
        or ((runtime_context or {}).get("memoryState") or {}).get("memoryHints")
        or {}
    )
    task_objective = _build_task_objective_payload(
        task=str(seed.get("task") or task or ""),
        task_mode=str(seed.get("taskMode") or seed.get("task_mode") or task_mode or ""),
        action=str(seed.get("action") or action or ""),
        lane_id=str(seed.get("laneId") or seed.get("lane_id") or lane_id or ""),
        lane_label=str(seed.get("laneLabel") or seed.get("lane_label") or lane_label or ""),
        runtime_task=runtime_task,
    )
    failure_class = _build_failure_class_payload(
        runtime_failure=runtime_failure or seed.get("failureClass") or seed.get("failure_class"),
        review_summary=review_summary or seed.get("reviewSummary") or seed.get("review_summary"),
        run_state=str(seed.get("runState") or seed.get("run_state") or run_state or ""),
    )
    recovery_ladder = _build_recovery_ladder_payload(
        runtime_run=runtime_run,
        runtime_failure=runtime_failure,
        runtime_events=runtime_events,
        validation=dict((runtime_result or {}).get("validation") or {}),
        repair=dict((runtime_result or {}).get("repair") or {}),
        review_state=review_state,
    )
    checkpoint_ref = _build_checkpoint_ref_payload(
        run_id=str(seed.get("runId") or seed.get("run_id") or run_id or ""),
        artifact_paths=effective_artifact_paths,
    )
    interrupt_request = _build_interrupt_request_payload(
        review_summary=review_summary or seed.get("reviewSummary") or seed.get("review_summary"),
        review_state=review_state,
        review_requests=review_requests,
        runtime_failure=runtime_failure,
    )
    review_bundle = _build_review_bundle_payload(
        review_summary=review_summary or seed.get("reviewSummary") or seed.get("review_summary"),
        review_state=review_state,
        review_requests=review_requests,
        trust_summary=trust_summary or seed.get("trustSummary") or seed.get("trust_summary"),
        runtime_failure=runtime_failure,
        runtime_context=runtime_context,
        ok=str(run_state or "").strip().lower() == "succeeded",
    )
    workbench_artifacts = _build_workbench_artifacts_payload(
        runtime_context=runtime_context,
        artifact_paths=effective_artifact_paths,
    )
    payload = build_operator_execution_result(
        task=str(seed.get("task") or task or ""),
        task_mode=str(seed.get("taskMode") or seed.get("task_mode") or task_mode or ""),
        action=str(seed.get("action") or action or ""),
        ticket_id=str(seed.get("ticket") or ticket_id or ""),
        run_id=str(seed.get("runId") or seed.get("run_id") or run_id or ""),
        status=str(seed.get("status") or status or ""),
        run_state=str(seed.get("runState") or seed.get("run_state") or run_state or ""),
        current_stage=str(
            (seed.get("stageSummary") or {}).get("currentStage")
            or (seed.get("stage_summary") or {}).get("current_stage")
            or current_stage
            or "runtime"
        ),
        result_summary=str(seed.get("resultSummary") or seed.get("result_summary") or result_summary or ""),
        changed_files=list((runtime_context or {}).get("changed_files") or (runtime_context or {}).get("changedFiles") or []),
        review_summary=review_summary,
        trust_summary=trust_summary,
        run_summary=run_summary,
        test_summary=test_summary,
        benchmark_metadata={
            "experiment_benchmark_summary": dict(benchmark_summary or {}),
            "owner_experiment_summary": dict(owner_experiment_summary or {}),
        },
        learning_metadata={
            "training_handoff": dict(training_handoff or {}),
            "memory_hints": memory_hints,
        },
        artifact_paths=effective_artifact_paths,
        validation_commands=validation_commands,
        lane_id=str(seed.get("laneId") or seed.get("lane_id") or lane_id or ""),
        lane_label=str(seed.get("laneLabel") or seed.get("lane_label") or lane_label or ""),
        model_profile_id=str(seed.get("modelProfileId") or seed.get("model_profile_id") or model_profile_id or ""),
        model_role=str(seed.get("modelRole") or seed.get("model_role") or model_role or ""),
        model_display_name=str(seed.get("modelDisplayName") or seed.get("model_display_name") or model_display_name or ""),
        base_model=str(seed.get("baseModel") or seed.get("base_model") or base_model or ""),
        provider_source=str(seed.get("providerSource") or seed.get("provider_source") or provider_source or ""),
        retry_available=bool(seed.get("retryAvailable", seed.get("retry_available", retry_available))),
        repair_available=bool(seed.get("repairAvailable", seed.get("repair_available", repair_available))),
        task_objective=task_objective,
        failure_class=failure_class,
        recovery_ladder=recovery_ladder,
        checkpoint_ref=checkpoint_ref,
        interrupt_request=interrupt_request,
        review_bundle=review_bundle,
        workbench_artifacts=workbench_artifacts,
    )
    return _camelize_operator_execution(payload)


def _runtime_args(**overrides: Any) -> SimpleNamespace:
    base = {
        "write": False,
        "plan": False,
        "execute": False,
        "autopilot": False,
        "batch": False,
        "schedule": None,
        "pilot": False,
        "implement": False,
        "confirm": False,
        "repair": False,
        "repair_last": False,
        "notify_url": None,
        "ci_report": None,
        "ai": False,
        "git": False,
        "interactive": False,
        "brainstorm": False,
        "brainstorm_notes": False,
        "template": None,
        "train": False,
        "openai": False,
        "fine_tune_model": None,
        "config": {},
        "editor_context": {},
    }
    base.update(overrides)
    return SimpleNamespace(**base)


def _build_orchestration_provider(payload: dict[str, Any] | None, project_root: Path) -> Any:
    source = dict(payload or {})
    metadata = dict(source.get('metadata') or {})
    provider_source = str(
        metadata.get('providerSource')
        or metadata.get('provider_source')
        or source.get('providerSource')
        or source.get('provider_source')
        or ''
    ).strip()
    base_model = str(
        metadata.get('baseModel')
        or metadata.get('base_model')
        or source.get('baseModel')
        or source.get('base_model')
        or os.environ.get('OLLAMA_MODEL')
        or ''
    ).strip()
    config = ProviderConfig(
        provider_name=provider_source,
        openai_api_key=str(os.environ.get('OPENAI_API_KEY') or ''),
        openai_base_url=str(os.environ.get('OPENAI_BASE_URL') or ''),
        local_ai_cmd=str(os.environ.get('LOCAL_AI_CMD') or ''),
        ollama_base_url=str(os.environ.get('OLLAMA_BASE_URL') or 'http://localhost:11434'),
        ollama_model=base_model or str(os.environ.get('OLLAMA_MODEL') or 'qwen2.5-coder:7b'),
        openai_model=base_model or str(os.environ.get('OPENAI_MODEL') or 'gpt-4o-mini'),
        project_root=project_root,
    )
    provider = create_provider(config, explicit=provider_source or None)
    return None if isinstance(provider, NullProvider) else provider


def run_ticket(ticket_id: str, mode: str, options: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(options or {})
    normalized = _normalize_ticket_id(ticket_id)
    editor_context = normalize_editor_context(payload.get("editor_context") or payload.get("editorContext"))
    if mode in {"plan", "run", "implement"}:
        solo = _load_script_module("runtime_api_solo_dev_assistant", "solo_dev_assistant.py")
        runs_dir = _runs_dir()
        started_mtime_ns = runs_dir.stat().st_mtime_ns if runs_dir.exists() else 0
        args = _solo_namespace(mode, normalized, payload)
        ticket_desc = payload.get("desc") or GoSenderrAdapter(REPO_ROOT).load_tickets().get(normalized, "")
        args.desc = augment_ticket_description(ticket_desc, editor_context)
        args.editor_context = editor_context
        if mode == "plan":
            args.write_plan = True
            exit_code = solo.run_plan_command(args)
            artifact_path = runs_dir / f"BAT{normalized}_plan.md"
            if not artifact_path.exists():
                artifact_path = _latest_matching_artifact(f"BAT{normalized}_plan.md", started_mtime_ns=started_mtime_ns)
            return {
                "ok": exit_code == 0,
                "action": mode,
                "ticket": normalized,
                "exitCode": exit_code,
                "checks": [],
                "artifact": {"path": str(artifact_path)} if artifact_path else None,
                "artifactPaths": [str(artifact_path)] if artifact_path else [],
                "label": f"PLAN BAT<{normalized}>",
            }
        exit_code = solo.run_pipeline_command(args) if mode == "run" else solo.run_implement_command(args)
        artifact_path = runs_dir / f"BAT{normalized}_{mode}.json"
        if not artifact_path.exists():
            artifact_path = _latest_matching_artifact(f"BAT{normalized}_{mode}.json", started_mtime_ns=started_mtime_ns)
        return _solo_result(mode, normalized, exit_code, artifact_path)

    adapter = GoSenderrAdapter(REPO_ROOT)
    runtime_result = _facade_run_ticket(
        adapter,
        normalized,
        mode=mode,
        args=_runtime_args(
            plan=bool(payload.get("plan", False)),
            execute=bool(payload.get("execute", False)),
            write=bool(payload.get("write", False)),
            confirm=bool(payload.get("confirm", False)),
            repair=bool(payload.get("repair", False)),
            template=payload.get("template"),
            brainstorm=bool(payload.get("brainstorm", False)),
            brainstorm_notes=payload.get("brainstormNotes") or payload.get("brainstorm_notes"),
            interactive=bool(payload.get("interactive", False)),
            ai=bool(payload.get("ai", False)),
            git=bool(payload.get("git", False)),
            editor_context=editor_context,
            host_boundary=payload.get("hostBoundary") or payload.get("host_boundary") or {},
        ),
        project_root=REPO_ROOT,
        editor_context=editor_context,
    )
    validation = runtime_result.get("validation", {}) if isinstance(runtime_result, dict) else {}
    trust_summary = _extract_trust_summary(runtime_result)
    task_summary = str(
        runtime_result.get("desc")
        or payload.get("desc")
        or payload.get("objective")
        or f"{mode.upper()} BAT<{normalized}>"
    )
    operator_execution = _build_operator_execution_payload(
        task=task_summary,
        task_mode=str(runtime_result.get("runtime_task", {}).get("task_mode") or ""),
        action=mode,
        ticket_id=normalized,
        run_id=str(runtime_result.get("runtime_run", {}).get("run_id") or ""),
        status=str(runtime_result.get("runtime_result", {}).get("status") or ""),
        run_state=str(runtime_result.get("runtime_result", {}).get("final_state") or ""),
        current_stage=str(runtime_result.get("runtime_run", {}).get("current_stage") or "runtime"),
        result_summary=str(
            runtime_result.get("runtime_result", {}).get("summary")
            or runtime_result.get("review_summary", {}).get("summary")
            or runtime_result.get("run_summary", {}).get("summary")
            or runtime_result.get("test_summary", {}).get("summary")
            or ""
        ),
        runtime_context=dict(runtime_result.get("runtime_context") or {}),
        review_summary=dict(runtime_result.get("review_summary") or {}),
        trust_summary=trust_summary,
        run_summary=dict(runtime_result.get("run_summary") or {}),
        test_summary=dict(runtime_result.get("test_summary") or {}),
        benchmark_summary=dict(runtime_result.get("experiment_benchmark_summary") or {}),
        owner_experiment_summary=dict(runtime_result.get("owner_experiment_summary") or {}),
        training_handoff=dict(runtime_result.get("training_handoff") or {}),
        artifact_paths=[
            str(path)
            for path in [
                runtime_result.get("artifacts", {}).get("run_artifact"),
                runtime_result.get("artifacts", {}).get("human_summary"),
                runtime_result.get("artifacts", {}).get("experiment_artifact"),
                runtime_result.get("artifacts", {}).get("experiment_dataset"),
            ]
            if str(path or "")
        ],
        operator_execution=dict(runtime_result.get("operator_execution") or {}),
        runtime_task=dict(runtime_result.get("runtime_task") or {}),
        runtime_run=dict(runtime_result.get("runtime_run") or {}),
        runtime_result=runtime_result,
        runtime_failure=dict(runtime_result.get("runtime_failure") or {}),
        runtime_events=list(runtime_result.get("runtime_events") or []),
        review_state=dict(runtime_result.get("review_state") or {}),
        review_requests=list(runtime_result.get("review_requests") or []),
        recommended_actions=list(runtime_result.get("recommended_actions") or []),
        retry_available=bool(runtime_result.get("runtime_failure", {}).get("retryable")),
        repair_available=bool(normalized),
    )
    return {
        "ok": bool(runtime_result.get("ok", False)),
        "action": mode,
        "ticket": normalized,
        "exitCode": 0 if runtime_result.get("ok", False) else 1,
        "checks": list(validation.get("results", [])) if isinstance(validation, dict) else [],
        "artifact": runtime_result,
        "artifactPaths": [
            str(path)
            for path in [
                runtime_result.get("artifacts", {}).get("run_artifact"),
                runtime_result.get("artifacts", {}).get("human_summary"),
                runtime_result.get("artifacts", {}).get("experiment_artifact"),
                runtime_result.get("artifacts", {}).get("experiment_dataset"),
            ]
            if str(path or "")
        ],
        "label": f"{mode.upper()} BAT<{normalized}>",
        "editor_context": editor_context,
        "runtimeContext": dict(runtime_result.get("runtime_context") or {}),
        "runtimeTask": dict(runtime_result.get("runtime_task") or {}),
        "runtimeRun": dict(runtime_result.get("runtime_run") or {}),
        "runtimeResult": dict(runtime_result.get("runtime_result") or {}),
        "runtimeFailure": dict(runtime_result.get("runtime_failure") or {}),
        "runtimeEvents": list(runtime_result.get("runtime_events") or []),
        "reviewRequests": list(runtime_result.get("review_requests") or []),
        "reviewState": dict(runtime_result.get("review_state") or {}),
        "reviewSummary": dict(runtime_result.get("review_summary") or {}),
        "trustSummary": trust_summary,
        "ownerSummary": dict(runtime_result.get("owner_summary") or {}),
        "runSummary": dict(runtime_result.get("run_summary") or {}),
        "testSummary": dict(runtime_result.get("test_summary") or {}),
        "reviewQueueSummary": dict(runtime_result.get("review_queue_summary") or {}),
        "recommendedActions": list(runtime_result.get("recommended_actions") or []),
        "experimentRun": dict(runtime_result.get("experiment_run") or {}),
        "experimentScenario": dict(runtime_result.get("experiment_scenario") or {}),
        "experimentScorecard": dict(runtime_result.get("experiment_scorecard") or {}),
        "strategyBenchmark": dict(runtime_result.get("strategy_benchmark") or {}),
        "experimentBenchmarkSummary": dict(runtime_result.get("experiment_benchmark_summary") or {}),
        "ownerExperimentSummary": dict(runtime_result.get("owner_experiment_summary") or {}),
        "trainingHandoff": dict(runtime_result.get("training_handoff") or {}),
        "operatorExecution": operator_execution,
    }


def run_batch(action: str, filters: dict[str, Any] | None = None, options: dict[str, Any] | None = None) -> dict[str, Any]:
    selected_action = str(action or "implement").strip().lower()
    if selected_action not in {"plan", "run", "implement"}:
        raise RuntimeApiError(f"unsupported batch action: {action}")
    solo = _load_script_module("runtime_api_solo_dev_assistant", "solo_dev_assistant.py")
    combined = dict(filters or {})
    combined.update(options or {})
    combined["action"] = selected_action
    runs_dir = _runs_dir()
    started_mtime_ns = runs_dir.stat().st_mtime_ns if runs_dir.exists() else 0
    exit_code = solo.run_sprint_command(_solo_namespace("sprint", None, combined))
    artifact_path = _latest_matching_artifact(
        f"sprint_{selected_action}_*.json",
        started_mtime_ns=started_mtime_ns,
        allow_fallback=False,
    )
    artifact = _read_json(artifact_path) if artifact_path else None
    blocked_reasons = _blocked_sprint_reasons(artifact)
    if artifact_path is None and exit_code == 0:
        summary = "No eligible tickets matched current sprint filters."
        return {
            "ok": True,
            "action": selected_action,
            "ticket": "",
            "exitCode": 0,
            "checks": [],
            "artifact": {
                "summary": summary,
                "outcomes": [],
                "count_requested": combined.get("count", 5),
                "status_filter": combined.get("status", "TODO"),
                "require_tag": combined.get("requireTag") or None,
                "require_text": combined.get("requireText") or None,
                "prefer_domain": combined.get("preferDomain") or None,
            },
            "artifactPaths": [],
            "label": f"SPRINT {selected_action.upper()} x{combined.get('count', 5)}",
            "blockedReason": summary,
            "noop": True,
        }
    if blocked_reasons:
        summary = "; ".join(blocked_reasons)
        return {
            "ok": True,
            "action": selected_action,
            "ticket": "",
            "exitCode": 0,
            "checks": [],
            "artifact": artifact,
            "artifactPaths": [str(artifact_path)] if artifact_path else [],
            "label": f"SPRINT {selected_action.upper()} x{combined.get('count', 5)}",
            "blockedReason": summary,
            "followupReport": dict(artifact.get("followup_report") or {}),
            "noop": True,
        }
    return {
        "ok": exit_code == 0,
        "action": selected_action,
        "ticket": "",
        "exitCode": exit_code,
        "checks": [],
        "artifact": artifact,
        "artifactPaths": [str(artifact_path)] if artifact_path else [],
        "label": f"SPRINT {selected_action.upper()} x{combined.get('count', 5)}",
        "blockedReason": "" if artifact_path else "No eligible tickets matched current sprint filters.",
        "followupReport": dict((artifact or {}).get("followup_report") or {}),
    }


def chat(prompt: str, context: dict[str, Any] | None = None) -> dict[str, Any]:
    assistant = _load_script_module("runtime_api_dev_assistant", "dev_assistant.py")
    payload_context = dict(context or {})
    env_overrides = dict(payload_context.get("env", {}))
    editor_context = normalize_editor_context(payload_context.get("editor_context") or payload_context.get("editorContext"))
    original: dict[str, str | None] = {}
    for key, value in env_overrides.items():
        original[key] = os.environ.get(key)
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = str(value)
    try:
        if editor_context:
            reply = assistant.ai_generate(messages=build_coding_chat_messages(prompt, editor_context))
        else:
            reply = assistant.ai_generate(prompt=prompt)
    finally:
        for key, value in original.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
    return {"ok": True, "reply": str(reply or "")}


def train(options: dict[str, Any] | None = None) -> dict[str, Any]:
    trainer = _load_script_module("runtime_api_train_dev_assistant", "train_dev_assistant.py")
    payload = dict(options or {})
    repo_root = Path(payload.get("repoRoot") or payload.get("repo_root") or payload.get("workspace") or REPO_ROOT)
    output_path = Path(payload.get("output") or _default_training_output_path())
    log_path = Path(payload.get("log") or getattr(trainer, "LOG_DEFAULT", _default_log_path()))
    board_path = Path(payload.get("board") or payload.get("boardPath") or getattr(trainer, "BOARD_DEFAULT", repo_root / "docs" / "BAT_FEATURE_BOARD.md"))
    min_diff = int(payload.get("minDiff", 1) or 1)
    runs_dirs_payload = payload.get("runsDir", payload.get("runs_dir", []))
    if isinstance(runs_dirs_payload, (str, Path)):
        runs_dirs_input = [Path(runs_dirs_payload)]
    else:
        runs_dirs_input = [Path(item) for item in runs_dirs_payload or []]
    assistant_only = bool(payload.get("assistantOnly", payload.get("assistant_only", True)))
    min_examples = int(payload.get("minExamples", payload.get("min_examples", 2)) or 2)
    min_log_examples = int(payload.get("minLogExamples", payload.get("min_log_examples", 1)) or 1)
    min_artifact_examples = int(payload.get("minArtifactExamples", payload.get("min_artifact_examples", 1)) or 1)
    fail_on_quality_gate = bool(payload.get("failOnQualityGate", payload.get("fail_on_quality_gate", False)))
    local_export_format = str(payload.get("localExportFormat", payload.get("local_export_format", "")) or "").strip()
    local_base_model = str(payload.get("localBaseModel", payload.get("local_base_model", "")) or "").strip()
    env_overrides = dict(payload.get("envOverrides", payload.get("env_overrides", {})) or {})
    tuning = {
        "profile": str(payload.get("profile", "") or "").strip(),
        "thread_limit": int(payload.get("threadLimit", payload.get("thread_limit", 0)) or 0),
        "cpu_limit_percent": int(payload.get("cpuLimitPercent", payload.get("cpu_limit_percent", 0)) or 0),
        "thermal_ceiling_c": int(payload.get("thermalCeilingC", payload.get("thermal_ceiling_c", 0)) or 0),
    }
    original: dict[str, str | None] = {}
    for key, value in env_overrides.items():
        original[key] = os.environ.get(key)
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = str(value)
    try:
        dataset = trainer.build_training_dataset(
            log_path=log_path,
            runs_dirs=runs_dirs_input,
            board_path=board_path,
            assistant_only=assistant_only,
            min_diff=min_diff,
            min_examples=min_examples,
            min_log_examples=min_log_examples,
            min_artifact_examples=min_artifact_examples,
        )
        quality_gate = dict(dataset.get("quality_gate") or {})
        lines = [json.dumps(example, ensure_ascii=False) for example in dataset["examples"]]
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
        local_export = {}
        if getattr(trainer, "normalize_local_export_format", None) is not None and getattr(trainer, "write_local_training_export", None) is not None:
            normalized_format = trainer.normalize_local_export_format(local_export_format)
            if normalized_format:
                local_export = trainer.write_local_training_export(
                    repo_root=repo_root,
                    dataset=dataset,
                    output_path=output_path,
                    export_format=normalized_format,
                    base_model=local_base_model or os.environ.get("OLLAMA_MODEL") or "qwen2.5-coder:7b",
                )
        if getattr(trainer, "write_training_status", None) is not None:
            trainer.write_training_status(
                repo_root=repo_root,
                output_path=output_path,
                dataset=dataset,
                quality_gate=quality_gate,
                local_export=local_export,
                tuning=tuning,
            )
    finally:
        for key, value in original.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
    ok = bool(quality_gate.get("passed", True) or not fail_on_quality_gate)
    return {
        "ok": ok,
        "repoRoot": str(repo_root),
        "outputPath": str(output_path),
        "logPath": str(log_path),
        "boardPath": str(board_path),
        "runsDirs": list(dataset.get("runs_dirs", [])),
        "assistantOnly": assistant_only,
        "entryCount": int(dataset.get("log_entry_count", 0)),
        "artifactEntryCount": int(dataset.get("artifact_entry_count", 0)),
        "exampleCount": len(lines),
        "logExampleCount": int(dataset.get("log_example_count", 0)),
        "artifactExampleCount": int(dataset.get("artifact_example_count", 0)),
        "skippedEmptyCount": int(dataset.get("skipped_empty_count", 0)),
        "skippedMinDiffCount": int(dataset.get("skipped_min_diff_count", 0)),
        "minDiff": min_diff,
        "qualityGate": quality_gate,
        "localExport": local_export,
        "tuning": tuning,
        "artifactPaths": [str(output_path)],
        "summary": (
            f"Generated {len(lines)} training examples "
            f"({int(dataset.get('log_example_count', 0))} log + {int(dataset.get('artifact_example_count', 0))} artifact) "
            f"from {int(dataset.get('log_entry_count', 0))} log entries and {int(dataset.get('artifact_entry_count', 0))} run artifacts."
        ),
        "label": "TRAIN ASSISTANT",
    }


def checkpoint_merge(options: dict[str, Any] | None = None) -> dict[str, Any]:
    merger = _load_script_module("runtime_api_merge_local_checkpoints", "merge_local_checkpoints.py")
    payload = dict(options or {})
    project_root = _selected_project_root(payload)
    base_path = Path(
        payload.get("basePath")
        or payload.get("base_path")
        or payload.get("baseModelPath")
        or payload.get("base_model_path")
        or ""
    )
    secondary_path = Path(
        payload.get("secondaryPath")
        or payload.get("secondary_path")
        or payload.get("secondaryModelPath")
        or payload.get("secondary_model_path")
        or ""
    )
    if not str(base_path).strip():
        raise RuntimeApiError("checkpoint-merge requires basePath")
    if not str(secondary_path).strip():
        raise RuntimeApiError("checkpoint-merge requires secondaryPath")
    requested_output = str(
        payload.get("outputPath")
        or payload.get("output_path")
        or payload.get("outputDir")
        or payload.get("output_dir")
        or ""
    ).strip()
    if requested_output:
        output_dir = Path(requested_output)
    else:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        merge_name = str(payload.get("mergeName") or payload.get("merge_name") or secondary_path.name or "merge").strip()
        output_dir = _default_training_output_path(project_root).parent / "checkpoint_merges" / f"{stamp}-{merge_name.lower().replace(' ', '-')}"
    result = merger.merge_checkpoint_bundle(
        base_path=base_path,
        secondary_path=secondary_path,
        output_dir=output_dir,
        merge_name=str(payload.get("mergeName") or payload.get("merge_name") or "").strip(),
        alpha=float(payload.get("alpha", payload.get("mergeAlpha", payload.get("merge_alpha", 0.2))) or 0.2),
        method=str(payload.get("method") or "linear").strip().lower() or "linear",
        ollama_model_name=str(payload.get("ollamaModelName") or payload.get("ollama_model_name") or "").strip(),
        dry_run=bool(payload.get("dryRun", payload.get("dry_run", False))),
    )
    manifest = dict(result.get("checkpoint_merge") or {})
    artifact_paths = [str(output_dir)]
    manifest_path = str(result.get("manifest_path") or "").strip()
    if manifest_path:
        artifact_paths.append(manifest_path)
    return {
        "ok": bool(result.get("ok", False)),
        "projectRoot": str(project_root),
        "outputPath": str(output_dir),
        "artifactPaths": artifact_paths,
        "checkpointMerge": manifest,
        "summary": str(result.get("summary") or "Prepared checkpoint merge."),
        "label": "CHECKPOINT MERGE",
    }


def summarize_experiments(options: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(options or {})
    dataset_path = Path(payload.get("dataset") or payload.get("datasetPath") or _default_experiment_dataset_path())
    rows = load_experiment_dataset(REPO_ROOT, target=dataset_path)
    rows = filter_experiment_dataset(
        rows,
        ticket=str(payload.get("ticket") or ""),
        strategy=str(payload.get("strategy") or ""),
        status=str(payload.get("status") or ""),
        review_required=payload.get("reviewRequired") if "reviewRequired" in payload else payload.get("review_required"),
        min_score=int(payload.get("minScore")) if payload.get("minScore") is not None else (int(payload.get("min_score")) if payload.get("min_score") is not None else None),
        limit=int(payload.get("limit", 0) or 0),
    )
    summary = summarize_experiment_dataset(REPO_ROOT, rows=rows, target=dataset_path)
    return {
        "ok": True,
        "datasetPath": str(dataset_path),
        "rowCount": len(rows),
        "artifactPaths": [str(dataset_path)],
        "benchmarkSummary": summary,
        "ownerExperimentSummary": build_owner_experiment_summary_from_benchmark(summary, artifact_paths=[str(dataset_path)]),
        "summary": f"Summarized {len(rows)} experiment rows across {int(summary.get('strategy_count', 0))} strategies.",
        "label": "EXPERIMENT SUMMARY",
    }


def summarize_engine_baseline(options: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(options or {})
    project_root = _selected_project_root(payload)
    summary = build_engine_baseline_summary(
        project_root,
        lookback_hours=int(payload.get("lookbackHours", payload.get("lookback_hours", 72)) or 72),
        run_limit=int(payload.get("runLimit", payload.get("run_limit", 40)) or 40),
        experiment_limit=int(payload.get("experimentLimit", payload.get("experiment_limit", 80)) or 80),
        training_limit=int(payload.get("trainingLimit", payload.get("training_limit", 120)) or 120),
    )
    output_dir = Path(payload.get("outputDir") or payload.get("output_dir")).expanduser().resolve() if payload.get("outputDir") or payload.get("output_dir") else None
    written = write_engine_baseline_summary(project_root, summary, output_dir=output_dir)
    return {
        "ok": True,
        "projectRoot": str(project_root),
        "baseline": dict(summary.get("baseline") or {}),
        "runtime": dict(summary.get("runtime") or {}),
        "experiments": dict(summary.get("experiments") or {}),
        "training": dict(summary.get("training") or {}),
        "commonFailureFingerprints": [dict(item) for item in list(summary.get("common_failure_fingerprints") or []) if isinstance(item, dict)],
        "commonRecommendedActions": [dict(item) for item in list(summary.get("common_recommended_actions") or []) if isinstance(item, dict)],
        "artifactPaths": [str(path) for path in written.values() if path],
        "summary": f"Summarized {int((summary.get('runtime') or {}).get('run_count', 0))} recent engine runs.",
        "label": "ENGINE BASELINE SUMMARY",
    }


def summarize_engine_daily_report(options: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(options or {})
    project_root = _selected_project_root(payload)
    report = build_engine_daily_report(
        project_root,
        lookback_hours=int(payload.get("lookbackHours", payload.get("lookback_hours", 24)) or 24),
        run_limit=int(payload.get("runLimit", payload.get("run_limit", 30)) or 30),
        experiment_limit=int(payload.get("experimentLimit", payload.get("experiment_limit", 60)) or 60),
        training_limit=int(payload.get("trainingLimit", payload.get("training_limit", 120)) or 120),
    )
    output_dir = Path(payload.get("outputDir") or payload.get("output_dir")).expanduser().resolve() if payload.get("outputDir") or payload.get("output_dir") else None
    written = write_engine_daily_report(project_root, report, output_dir=output_dir)
    return {
        "ok": True,
        "projectRoot": str(project_root),
        "baseline": dict(report.get("baseline") or {}),
        "runtime": dict(report.get("runtime") or {}),
        "experiments": dict(report.get("experiments") or {}),
        "training": dict(report.get("training") or {}),
        "dailyFocus": dict(report.get("daily_focus") or {}),
        "topBlockers": [dict(item) for item in list(report.get("top_blockers") or []) if isinstance(item, dict)],
        "retryActions": [dict(item) for item in list(report.get("retry_actions") or []) if isinstance(item, dict)],
        "commonRecommendedActions": [dict(item) for item in list(report.get("common_recommended_actions") or []) if isinstance(item, dict)],
        "artifactPaths": [str(path) for path in written.values() if path],
        "summary": str((report.get("daily_focus") or {}).get("reason") or "Engine daily report prepared."),
        "label": "ENGINE DAILY REPORT",
    }


def export_experiment_dataset(options: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(options or {})
    dataset_path = Path(payload.get("dataset") or payload.get("datasetPath") or _default_experiment_dataset_path())
    output_path = Path(payload.get("output") or payload.get("outputPath") or (dataset_path.parent / "experiment_export.json"))
    rows = filter_experiment_dataset(
        load_experiment_dataset(REPO_ROOT, target=dataset_path),
        ticket=str(payload.get("ticket") or ""),
        strategy=str(payload.get("strategy") or ""),
        status=str(payload.get("status") or ""),
        review_required=payload.get("reviewRequired") if "reviewRequired" in payload else payload.get("review_required"),
        min_score=int(payload.get("minScore")) if payload.get("minScore") is not None else (int(payload.get("min_score")) if payload.get("min_score") is not None else None),
        limit=int(payload.get("limit", 0) or 0),
    )
    benchmark_summary = summarize_experiment_dataset(REPO_ROOT, rows=rows, target=dataset_path, artifact_paths=[str(dataset_path), str(output_path)])
    export_payload = {
        "dataset_path": str(dataset_path),
        "filters": {
            "ticket": str(payload.get("ticket") or ""),
            "strategy": str(payload.get("strategy") or ""),
            "status": str(payload.get("status") or ""),
            "review_required": payload.get("reviewRequired") if "reviewRequired" in payload else payload.get("review_required"),
            "min_score": payload.get("minScore", payload.get("min_score")),
            "limit": int(payload.get("limit", 0) or 0),
        },
        "benchmark_summary": benchmark_summary,
        "rows": rows,
    }
    written = write_experiment_export(REPO_ROOT, export_payload, target=output_path, suffix="dataset-export")
    return {
        "ok": written is not None,
        "datasetPath": str(dataset_path),
        "outputPath": str(written) if written else None,
        "rowCount": len(rows),
        "artifactPaths": [str(path) for path in [written, dataset_path] if path],
        "benchmarkSummary": benchmark_summary,
        "summary": f"Exported {len(rows)} experiment rows.",
        "label": "EXPERIMENT EXPORT",
    }


def prepare_training_handoff(options: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(options or {})
    dataset_path = Path(payload.get("dataset") or payload.get("datasetPath") or _default_experiment_dataset_path())
    output_path = Path(payload.get("output") or payload.get("outputPath") or (dataset_path.parent / "training_handoff.json"))
    rows = filter_experiment_dataset(
        load_experiment_dataset(REPO_ROOT, target=dataset_path),
        ticket=str(payload.get("ticket") or ""),
        strategy=str(payload.get("strategy") or ""),
        status=str(payload.get("status") or ""),
        review_required=payload.get("reviewRequired") if "reviewRequired" in payload else payload.get("review_required"),
        min_score=int(payload.get("minScore")) if payload.get("minScore") is not None else (int(payload.get("min_score")) if payload.get("min_score") is not None else None),
        limit=int(payload.get("limit", 0) or 0),
    )
    benchmark_summary = summarize_experiment_dataset(REPO_ROOT, rows=rows, target=dataset_path, artifact_paths=[str(dataset_path), str(output_path)])
    handoff = build_training_handoff_from_dataset(
        benchmark_summary,
        rows,
        export_path=str(output_path),
        filters={
            "ticket": str(payload.get("ticket") or ""),
            "strategy": str(payload.get("strategy") or ""),
            "status": str(payload.get("status") or ""),
        },
        artifact_paths=[str(dataset_path), str(output_path)],
    )
    written = write_experiment_export(REPO_ROOT, handoff, target=output_path, suffix="training-handoff")
    return {
        "ok": written is not None,
        "datasetPath": str(dataset_path),
        "outputPath": str(written) if written else None,
        "handoff": handoff,
        "artifactPaths": [str(path) for path in [written, dataset_path] if path],
        "summary": f"Prepared training handoff from {len(rows)} experiment rows.",
        "label": "TRAINING HANDOFF",
    }


def summarize_self_improvement(options: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(options or {})
    summary = summarize_self_improvement_work(
        REPO_ROOT,
        history_limit=int(payload.get("historyLimit", payload.get("history_limit", 40)) or 40),
        max_candidates=int(payload.get("limit", 8) or 8),
    )
    queue_summary = dict(summary.get("queue_summary") or {})
    recommendation = dict(summary.get("recommendation") or {})
    prepared_tasks = [dict(item) for item in list(summary.get("prepared_tasks") or []) if isinstance(item, dict)]
    backlog_export = [dict(item) for item in list(summary.get("backlog_export") or []) if isinstance(item, dict)]
    history_summary = dict(summary.get("history_summary") or {})
    trust_payload = _extract_queue_trust_payload(queue_summary, history_summary)
    return {
        "ok": True,
        "queueSummary": queue_summary,
        **trust_payload,
        "recommendation": recommendation,
        "preparedTasks": prepared_tasks,
        "backlogExport": backlog_export,
        "historySummary": history_summary,
        "artifactPaths": list(queue_summary.get("artifact_paths") or []),
        "summary": str(queue_summary.get("summary") or "Self-improvement queue summarized."),
        "label": "SELF-IMPROVEMENT SUMMARY",
    }


def summarize_project_maintenance(options: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(options or {})
    project_root = _selected_project_root(payload)
    summary = summarize_project_maintenance_work(
        project_root,
        history_limit=int(payload.get("historyLimit", payload.get("history_limit", 40)) or 40),
        max_candidates=int(payload.get("limit", 8) or 8),
    )
    project_profile = dict(summary.get("project_profile") or {})
    health_summary = dict(summary.get("health_summary") or {})
    queue_summary = dict(summary.get("queue_summary") or {})
    recommendation = dict(summary.get("recommendation") or {})
    prepared_tasks = [dict(item) for item in list(summary.get("prepared_tasks") or []) if isinstance(item, dict)]
    history_summary = dict(summary.get("history_summary") or {})
    trust_payload = _extract_queue_trust_payload(queue_summary, history_summary)
    return {
        "ok": True,
        "projectRoot": str(project_root),
        "projectProfile": project_profile,
        "projectHealthSummary": health_summary,
        "queueSummary": queue_summary,
        **trust_payload,
        "recommendation": recommendation,
        "preparedTasks": prepared_tasks,
        "historySummary": history_summary,
        "artifactPaths": list(queue_summary.get("artifact_paths") or []),
        "summary": str(queue_summary.get("summary") or "Project maintenance queue summarized."),
        "label": "PROJECT MAINTENANCE SUMMARY",
    }


def summarize_owner_automation(options: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(options or {})
    project_root = _selected_project_root(payload)
    summary = summarize_owner_automation_work(
        project_root,
        owner_goals=_requested_owner_goals(payload),
        history_limit=int(payload.get("historyLimit", payload.get("history_limit", 40)) or 40),
        max_candidates=int(payload.get("limit", 8) or 8),
    )
    project_profile = dict(summary.get("project_profile") or {})
    health_summary = dict(summary.get("health_summary") or {})
    owner_goals = [dict(item) for item in list(summary.get("owner_goals") or []) if isinstance(item, dict)]
    owner_goal_plan = dict(summary.get("owner_goal_plan") or {})
    queue_summary = dict(summary.get("queue_summary") or {})
    recommendation = dict(summary.get("recommendation") or {})
    prepared_tasks = [dict(item) for item in list(summary.get("prepared_tasks") or []) if isinstance(item, dict)]
    history_summary = dict(summary.get("history_summary") or {})
    project_maintenance_summary = _augment_nested_queue_trust(summary.get("project_maintenance_summary") or {})
    trust_payload = _extract_queue_trust_payload(queue_summary, history_summary)
    return {
        "ok": True,
        "projectRoot": str(project_root),
        "projectProfile": project_profile,
        "projectHealthSummary": health_summary,
        "ownerGoals": owner_goals,
        "ownerGoalPlan": owner_goal_plan,
        "queueSummary": queue_summary,
        **trust_payload,
        "recommendation": recommendation,
        "preparedTasks": prepared_tasks,
        "historySummary": history_summary,
        "projectMaintenanceSummary": project_maintenance_summary,
        "artifactPaths": list(queue_summary.get("artifact_paths") or []),
        "summary": str(queue_summary.get("summary") or "Owner automation queue summarized."),
        "label": "OWNER AUTOMATION SUMMARY",
    }


def export_project_maintenance_queue(options: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(options or {})
    project_root = _selected_project_root(payload)
    output_path = Path(payload.get("output") or payload.get("outputPath") or _default_project_maintenance_queue_path(project_root))
    summary = summarize_project_maintenance_work(
        project_root,
        history_limit=int(payload.get("historyLimit", payload.get("history_limit", 40)) or 40),
        max_candidates=int(payload.get("limit", 8) or 8),
    )
    export_payload = {
        "project_profile": dict(summary.get("project_profile") or {}),
        "health_summary": dict(summary.get("health_summary") or {}),
        "queue_summary": dict(summary.get("queue_summary") or {}),
        "recommendation": dict(summary.get("recommendation") or {}),
        "prepared_tasks": [dict(item) for item in list(summary.get("prepared_tasks") or []) if isinstance(item, dict)],
        "candidates": [dict(item) for item in list(summary.get("candidates") or []) if isinstance(item, dict)],
        "history_summary": dict(summary.get("history_summary") or {}),
    }
    export_payload.update(_queue_trust_export_fields(export_payload["queue_summary"], export_payload["history_summary"]))
    written = write_project_maintenance_export(project_root, export_payload, target=output_path, suffix="queue")
    trust_payload = _extract_queue_trust_payload(export_payload["queue_summary"], export_payload["history_summary"])
    return {
        "ok": written is not None,
        "projectRoot": str(project_root),
        "outputPath": str(written) if written else None,
        "projectProfile": export_payload["project_profile"],
        "projectHealthSummary": export_payload["health_summary"],
        "queueSummary": export_payload["queue_summary"],
        **trust_payload,
        "recommendation": export_payload["recommendation"],
        "preparedTasks": export_payload["prepared_tasks"],
        "historySummary": export_payload["history_summary"],
        "artifactPaths": [str(path) for path in [written] if path],
        "summary": str((export_payload["queue_summary"] or {}).get("summary") or "Project maintenance queue exported."),
        "label": "PROJECT MAINTENANCE EXPORT",
    }


def export_owner_automation_queue(options: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(options or {})
    project_root = _selected_project_root(payload)
    output_path = Path(payload.get("output") or payload.get("outputPath") or _default_owner_automation_queue_path(project_root))
    summary = summarize_owner_automation_work(
        project_root,
        owner_goals=_requested_owner_goals(payload),
        history_limit=int(payload.get("historyLimit", payload.get("history_limit", 40)) or 40),
        max_candidates=int(payload.get("limit", 8) or 8),
    )
    export_payload = {
        "project_profile": dict(summary.get("project_profile") or {}),
        "health_summary": dict(summary.get("health_summary") or {}),
        "owner_goals": [dict(item) for item in list(summary.get("owner_goals") or []) if isinstance(item, dict)],
        "owner_goal_plan": dict(summary.get("owner_goal_plan") or {}),
        "queue_summary": dict(summary.get("queue_summary") or {}),
        "recommendation": dict(summary.get("recommendation") or {}),
        "prepared_tasks": [dict(item) for item in list(summary.get("prepared_tasks") or []) if isinstance(item, dict)],
        "candidates": [dict(item) for item in list(summary.get("candidates") or []) if isinstance(item, dict)],
        "history_summary": dict(summary.get("history_summary") or {}),
        "project_maintenance_summary": _augment_nested_queue_trust(summary.get("project_maintenance_summary") or {}),
    }
    export_payload.update(_queue_trust_export_fields(export_payload["queue_summary"], export_payload["history_summary"]))
    written = write_owner_automation_export(project_root, export_payload, target=output_path, suffix="queue")
    trust_payload = _extract_queue_trust_payload(export_payload["queue_summary"], export_payload["history_summary"])
    return {
        "ok": written is not None,
        "projectRoot": str(project_root),
        "outputPath": str(written) if written else None,
        "projectProfile": export_payload["project_profile"],
        "projectHealthSummary": export_payload["health_summary"],
        "ownerGoals": export_payload["owner_goals"],
        "ownerGoalPlan": export_payload["owner_goal_plan"],
        "queueSummary": export_payload["queue_summary"],
        **trust_payload,
        "recommendation": export_payload["recommendation"],
        "preparedTasks": export_payload["prepared_tasks"],
        "historySummary": export_payload["history_summary"],
        "projectMaintenanceSummary": export_payload["project_maintenance_summary"],
        "artifactPaths": [str(path) for path in [written] if path],
        "summary": str((export_payload["queue_summary"] or {}).get("summary") or "Owner automation queue exported."),
        "label": "OWNER AUTOMATION EXPORT",
    }


def execute_owner_automation_task(options: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(options or {})
    project_root = _selected_project_root(payload)
    summary = summarize_owner_automation_work(
        project_root,
        owner_goals=_requested_owner_goals(payload),
        history_limit=int(payload.get("historyLimit", payload.get("history_limit", 40)) or 40),
        max_candidates=int(payload.get("limit", 8) or 8),
    )
    task = _selected_owner_automation_task(payload, summary)
    runtime_task = dict(task.get("runtime_task") or {})
    selected_root = _selected_project_root(
        {
            "projectRoot": payload.get("projectRoot")
            or payload.get("project_root")
            or (task.get("host_boundary") or {}).get("project_root")
            or (runtime_task.get("host_boundary") or {}).get("project_root")
            or runtime_task.get("metadata", {}).get("project_root"),
        }
    )
    raw_target_paths = [
        str(path)
        for path in list(task.get("target_paths") or runtime_task.get("metadata", {}).get("target_paths") or [])
        if str(path)
    ]
    if not raw_target_paths:
        raise RuntimeApiError("owner automation task has no target paths")
    target_paths = [str(path) for path in _filter_project_target_paths(selected_root, raw_target_paths) if str(path)]
    if len(target_paths) != len(raw_target_paths):
        history_path = append_owner_automation_history(
            selected_root,
            {
                "task_id": str(task.get("task_id") or ""),
                "candidate_id": str(task.get("candidate_id") or ""),
                "goal_id": str(task.get("goal_id") or ""),
                "status": "blocked",
                "ok": False,
                "action": str(runtime_task.get("action") or task.get("action") or "implement"),
                "mode": str(task.get("mode") or runtime_task.get("mode") or "integrate"),
                "category": str(task.get("category") or runtime_task.get("metadata", {}).get("owner_automation_category") or "maintenance"),
                "target_paths": raw_target_paths,
                "blocked_reason": "owner automation execution is limited to prepared project-scoped targets",
            },
        )
        queue_export = export_owner_automation_queue(
            {
                "projectRoot": str(selected_root),
                "ownerGoals": _requested_owner_goals(payload),
                "output": payload.get("output") or payload.get("outputPath") or _default_owner_automation_queue_path(selected_root),
                "historyLimit": payload.get("historyLimit", payload.get("history_limit", 40)),
                "limit": payload.get("limit", 8),
            }
        )
        return {
            "ok": False,
            "projectRoot": str(selected_root),
            "taskId": str(task.get("task_id") or ""),
            "status": "blocked",
            "blockedReason": "owner automation execution is limited to prepared project-scoped targets",
            "artifactPaths": [
                str(path)
                for path in [history_path, queue_export.get("outputPath") or _default_owner_automation_history_path(selected_root)]
                if str(path or "")
            ],
            "queueSummary": dict(queue_export.get("queueSummary") or {}),
            "historySummary": summarize_owner_automation_history(selected_root),
            "label": "OWNER AUTOMATION RUN",
        }

    task_id = str(task.get("task_id") or runtime_task.get("metadata", {}).get("owner_automation_task_id") or "owner-auto-task")
    action = str(runtime_task.get("action") or task.get("action") or "implement")
    category = str(task.get("category") or runtime_task.get("metadata", {}).get("owner_automation_category") or "maintenance")
    host_boundary = {
        **dict(task.get("host_boundary") or {}),
        **dict(runtime_task.get("host_boundary") or {}),
        **dict(payload.get("hostBoundary") or payload.get("host_boundary") or {}),
        "owner_automation_only": True,
        "approval_protected_only": True,
        "sandbox_required": True,
        "require_review": True,
        "allowed_target_paths": target_paths,
        "project_root": str(selected_root),
        "owner_automation_depth": 1,
        "max_owner_automation_tasks": 1,
        "allow_followup_execution": False,
    }
    adapter = _PreparedOwnerAutomationAdapter(
        selected_root,
        ticket_id=task_id,
        objective=str(task.get("objective") or runtime_task.get("desc") or task.get("title") or "Owner automation task"),
        target_paths=target_paths,
        category=category,
    )
    editor_context = normalize_editor_context(payload.get("editor_context") or payload.get("editorContext") or {})
    runtime_result = _facade_run_ticket(
        adapter,
        task_id,
        mode=str(task.get("mode") or runtime_task.get("mode") or payload.get("mode") or "integrate"),
        args=_runtime_args(
            execute=action in {"run", "implement"},
            write=action == "implement",
            confirm=bool(payload.get("confirm", True)),
            repair=bool(payload.get("repair", False)),
            host_boundary=host_boundary,
            editor_context=editor_context,
        ),
        project_root=selected_root,
        editor_context=editor_context,
    )
    status = _owner_automation_task_status(runtime_result, host_boundary)
    trust_summary = _extract_trust_summary(runtime_result)
    history_entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "task_id": task_id,
        "candidate_id": str(task.get("candidate_id") or ""),
        "goal_id": str(task.get("goal_id") or ""),
        "ticket": str(runtime_result.get("ticket") or task_id),
        "status": status,
        "ok": bool(runtime_result.get("ok", False)),
        "action": action,
        "mode": str(task.get("mode") or runtime_task.get("mode") or "integrate"),
        "category": category,
        "target_paths": target_paths,
        "artifact_paths": [
            str(path)
            for path in [
                runtime_result.get("artifacts", {}).get("run_artifact"),
                runtime_result.get("artifacts", {}).get("human_summary"),
                runtime_result.get("artifacts", {}).get("experiment_artifact"),
                runtime_result.get("artifacts", {}).get("experiment_dataset"),
            ]
            if str(path or "")
        ],
        "review_state": dict(runtime_result.get("review_state") or {}),
        "review_summary": dict(runtime_result.get("review_summary") or {}),
        "trust_summary": trust_summary,
        "owner_summary": dict(runtime_result.get("owner_summary") or {}),
        "run_summary": dict(runtime_result.get("run_summary") or {}),
        "test_summary": dict(runtime_result.get("test_summary") or {}),
        "review_queue_summary": dict(runtime_result.get("review_queue_summary") or {}),
        "recommended_actions": list(runtime_result.get("recommended_actions") or []),
        "runtime_result": dict(runtime_result.get("runtime_result") or {}),
        "runtime_failure": dict(runtime_result.get("runtime_failure") or {}),
        "experiment_run": dict(runtime_result.get("experiment_run") or {}),
        "owner_experiment_summary": dict(runtime_result.get("owner_experiment_summary") or {}),
        "training_handoff": dict(runtime_result.get("training_handoff") or {}),
    }
    history_path = append_owner_automation_history(selected_root, history_entry)
    queue_export = export_owner_automation_queue(
        {
            "projectRoot": str(selected_root),
            "ownerGoals": _requested_owner_goals(payload),
            "output": payload.get("output") or payload.get("outputPath") or _default_owner_automation_queue_path(selected_root),
            "historyLimit": payload.get("historyLimit", payload.get("history_limit", 40)),
            "limit": payload.get("limit", 8),
        }
    )
    history_summary = summarize_owner_automation_history(
        selected_root,
        limit=int(payload.get("historyLimit", payload.get("history_limit", 40)) or 40),
    )
    recommended_next_action = "inspect-runtime-artifacts"
    if status == "pending_review":
        recommended_next_action = "resolve-review-gate"
    elif status == "blocked":
        recommended_next_action = "manual-owner-automation-triage"
    elif status == "failed":
        recommended_next_action = "inspect-failure-and-reprepare"
    return {
        "ok": bool(runtime_result.get("ok", False)) or status == "pending_review",
        "projectRoot": str(selected_root),
        "taskId": task_id,
        "status": status,
        "action": "owner-automation-run",
        "ticket": str(runtime_result.get("ticket") or task_id),
        "exitCode": 0 if bool(runtime_result.get("ok", False)) or status == "pending_review" else 1,
        "artifact": runtime_result,
        "artifactPaths": [
            str(path)
            for path in [
                history_path,
                queue_export.get("outputPath"),
                runtime_result.get("artifacts", {}).get("run_artifact"),
                runtime_result.get("artifacts", {}).get("human_summary"),
                runtime_result.get("artifacts", {}).get("experiment_artifact"),
                runtime_result.get("artifacts", {}).get("experiment_dataset"),
            ]
            if str(path or "")
        ],
        "queueSummary": dict(queue_export.get("queueSummary") or {}),
        "historySummary": history_summary,
        "projectProfile": dict(queue_export.get("projectProfile") or {}),
        "projectHealthSummary": dict(queue_export.get("projectHealthSummary") or {}),
        "ownerGoals": [dict(item) for item in list(queue_export.get("ownerGoals") or []) if isinstance(item, dict)],
        "ownerGoalPlan": dict(queue_export.get("ownerGoalPlan") or {}),
        "projectMaintenanceSummary": dict(queue_export.get("projectMaintenanceSummary") or {}),
        "reviewRequests": list(runtime_result.get("review_requests") or []),
        "reviewState": dict(runtime_result.get("review_state") or {}),
        "reviewSummary": dict(runtime_result.get("review_summary") or {}),
        "trustSummary": trust_summary,
        "ownerSummary": dict(runtime_result.get("owner_summary") or {}),
        "runSummary": dict(runtime_result.get("run_summary") or {}),
        "testSummary": dict(runtime_result.get("test_summary") or {}),
        "reviewQueueSummary": dict(runtime_result.get("review_queue_summary") or {}),
        "recommendedActions": list(runtime_result.get("recommended_actions") or []),
        "runtimeContext": dict(runtime_result.get("runtime_context") or {}),
        "runtimeTask": dict(runtime_result.get("runtime_task") or {}),
        "runtimeRun": dict(runtime_result.get("runtime_run") or {}),
        "runtimeResult": dict(runtime_result.get("runtime_result") or {}),
        "runtimeFailure": dict(runtime_result.get("runtime_failure") or {}),
        "runtimeEvents": list(runtime_result.get("runtime_events") or []),
        "experimentRun": dict(runtime_result.get("experiment_run") or {}),
        "experimentScenario": dict(runtime_result.get("experiment_scenario") or {}),
        "experimentScorecard": dict(runtime_result.get("experiment_scorecard") or {}),
        "strategyBenchmark": dict(runtime_result.get("strategy_benchmark") or {}),
        "ownerExperimentSummary": dict(runtime_result.get("owner_experiment_summary") or {}),
        "trainingHandoff": dict(runtime_result.get("training_handoff") or {}),
        "recommendedNextAction": recommended_next_action,
        "ownerAutomationStatus": {
            "task_id": task_id,
            "status": status,
            "history_entry_count": int(history_summary.get("entry_count") or 0),
            "execution_status_counts": dict(history_summary.get("status_counts") or {}),
            "category": category,
        },
        "summary": str(
            (runtime_result.get("review_summary") or {}).get("summary")
            or (runtime_result.get("run_summary") or {}).get("summary")
            or f"Executed owner automation task {task_id}."
        ),
        "label": "OWNER AUTOMATION RUN",
    }


def execute_project_maintenance_task(options: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(options or {})
    project_root = _selected_project_root(payload)
    summary = summarize_project_maintenance_work(
        project_root,
        history_limit=int(payload.get("historyLimit", payload.get("history_limit", 40)) or 40),
        max_candidates=int(payload.get("limit", 8) or 8),
    )
    task = _selected_project_maintenance_task(payload, summary)
    runtime_task = dict(task.get("runtime_task") or {})
    selected_root = _selected_project_root(
        {
            "projectRoot": payload.get("projectRoot")
            or payload.get("project_root")
            or (task.get("host_boundary") or {}).get("project_root")
            or (runtime_task.get("host_boundary") or {}).get("project_root")
            or runtime_task.get("metadata", {}).get("project_root"),
        }
    )
    raw_target_paths = [
        str(path)
        for path in list(task.get("target_paths") or runtime_task.get("metadata", {}).get("target_paths") or [])
        if str(path)
    ]
    if not raw_target_paths:
        raise RuntimeApiError("project maintenance task has no target paths")
    target_paths = [str(path) for path in _filter_project_target_paths(selected_root, raw_target_paths) if str(path)]
    if len(target_paths) != len(raw_target_paths):
        history_path = append_project_maintenance_history(
            selected_root,
            {
                "task_id": str(task.get("task_id") or ""),
                "candidate_id": str(task.get("candidate_id") or ""),
                "profile_id": str(task.get("profile_id") or ""),
                "status": "blocked",
                "ok": False,
                "action": str(runtime_task.get("action") or task.get("action") or "implement"),
                "mode": str(task.get("mode") or runtime_task.get("mode") or "integrate"),
                "target_paths": raw_target_paths,
                "blocked_reason": "project maintenance execution is limited to prepared project-scoped targets",
            },
        )
        queue_export = export_project_maintenance_queue(
            {
                "projectRoot": str(selected_root),
                "output": payload.get("output") or payload.get("outputPath") or _default_project_maintenance_queue_path(selected_root),
                "historyLimit": payload.get("historyLimit", payload.get("history_limit", 40)),
                "limit": payload.get("limit", 8),
            }
        )
        return {
            "ok": False,
            "projectRoot": str(selected_root),
            "taskId": str(task.get("task_id") or ""),
            "status": "blocked",
            "blockedReason": "project maintenance execution is limited to prepared project-scoped targets",
            "artifactPaths": [
                str(path)
                for path in [history_path, queue_export.get("outputPath") or _default_project_maintenance_history_path(selected_root)]
                if str(path or "")
            ],
            "queueSummary": dict(queue_export.get("queueSummary") or {}),
            "historySummary": summarize_project_maintenance_history(selected_root),
            "label": "PROJECT MAINTENANCE RUN",
        }

    task_id = str(task.get("task_id") or runtime_task.get("metadata", {}).get("project_maintenance_task_id") or "project-maint-task")
    action = str(runtime_task.get("action") or task.get("action") or "implement")
    host_boundary = {
        **dict(task.get("host_boundary") or {}),
        **dict(runtime_task.get("host_boundary") or {}),
        **dict(payload.get("hostBoundary") or payload.get("host_boundary") or {}),
        "project_maintenance_only": True,
        "approval_protected_only": True,
        "sandbox_required": True,
        "require_review": True,
        "allowed_target_paths": target_paths,
        "project_root": str(selected_root),
        "project_maintenance_depth": 1,
        "max_project_maintenance_tasks": 1,
        "allow_followup_execution": False,
    }
    adapter = _PreparedProjectMaintenanceAdapter(
        selected_root,
        ticket_id=task_id,
        objective=str(task.get("objective") or runtime_task.get("desc") or task.get("title") or "Project maintenance task"),
        target_paths=target_paths,
    )
    editor_context = normalize_editor_context(payload.get("editor_context") or payload.get("editorContext") or {})
    runtime_result = _facade_run_ticket(
        adapter,
        task_id,
        mode=str(task.get("mode") or runtime_task.get("mode") or payload.get("mode") or "integrate"),
        args=_runtime_args(
            execute=action in {"run", "implement"},
            write=action == "implement",
            confirm=bool(payload.get("confirm", True)),
            repair=bool(payload.get("repair", False)),
            host_boundary=host_boundary,
            editor_context=editor_context,
        ),
        project_root=selected_root,
        editor_context=editor_context,
    )
    status = _project_maintenance_task_status(runtime_result, host_boundary)
    trust_summary = _extract_trust_summary(runtime_result)
    history_entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "task_id": task_id,
        "candidate_id": str(task.get("candidate_id") or ""),
        "profile_id": str(task.get("profile_id") or ""),
        "ticket": str(runtime_result.get("ticket") or task_id),
        "status": status,
        "ok": bool(runtime_result.get("ok", False)),
        "action": action,
        "mode": str(task.get("mode") or runtime_task.get("mode") or "integrate"),
        "target_paths": target_paths,
        "artifact_paths": [
            str(path)
            for path in [
                runtime_result.get("artifacts", {}).get("run_artifact"),
                runtime_result.get("artifacts", {}).get("human_summary"),
                runtime_result.get("artifacts", {}).get("experiment_artifact"),
                runtime_result.get("artifacts", {}).get("experiment_dataset"),
            ]
            if str(path or "")
        ],
        "review_state": dict(runtime_result.get("review_state") or {}),
        "review_summary": dict(runtime_result.get("review_summary") or {}),
        "trust_summary": trust_summary,
        "owner_summary": dict(runtime_result.get("owner_summary") or {}),
        "run_summary": dict(runtime_result.get("run_summary") or {}),
        "test_summary": dict(runtime_result.get("test_summary") or {}),
        "review_queue_summary": dict(runtime_result.get("review_queue_summary") or {}),
        "recommended_actions": list(runtime_result.get("recommended_actions") or []),
        "runtime_result": dict(runtime_result.get("runtime_result") or {}),
        "runtime_failure": dict(runtime_result.get("runtime_failure") or {}),
        "experiment_run": dict(runtime_result.get("experiment_run") or {}),
        "owner_experiment_summary": dict(runtime_result.get("owner_experiment_summary") or {}),
        "training_handoff": dict(runtime_result.get("training_handoff") or {}),
    }
    history_path = append_project_maintenance_history(selected_root, history_entry)
    queue_export = export_project_maintenance_queue(
        {
            "projectRoot": str(selected_root),
            "output": payload.get("output") or payload.get("outputPath") or _default_project_maintenance_queue_path(selected_root),
            "historyLimit": payload.get("historyLimit", payload.get("history_limit", 40)),
            "limit": payload.get("limit", 8),
        }
    )
    history_summary = summarize_project_maintenance_history(
        selected_root,
        limit=int(payload.get("historyLimit", payload.get("history_limit", 40)) or 40),
    )
    recommended_next_action = "inspect-runtime-artifacts"
    if status == "pending_review":
        recommended_next_action = "resolve-review-gate"
    elif status == "blocked":
        recommended_next_action = "manual-project-maintenance-triage"
    elif status == "failed":
        recommended_next_action = "inspect-failure-and-reprepare"
    return {
        "ok": bool(runtime_result.get("ok", False)) or status == "pending_review",
        "projectRoot": str(selected_root),
        "taskId": task_id,
        "status": status,
        "action": "project-maintenance-run",
        "ticket": str(runtime_result.get("ticket") or task_id),
        "exitCode": 0 if bool(runtime_result.get("ok", False)) or status == "pending_review" else 1,
        "artifact": runtime_result,
        "artifactPaths": [
            str(path)
            for path in [
                history_path,
                queue_export.get("outputPath"),
                runtime_result.get("artifacts", {}).get("run_artifact"),
                runtime_result.get("artifacts", {}).get("human_summary"),
                runtime_result.get("artifacts", {}).get("experiment_artifact"),
                runtime_result.get("artifacts", {}).get("experiment_dataset"),
            ]
            if str(path or "")
        ],
        "queueSummary": dict(queue_export.get("queueSummary") or {}),
        "historySummary": history_summary,
        "projectProfile": dict(queue_export.get("projectProfile") or {}),
        "projectHealthSummary": dict(queue_export.get("projectHealthSummary") or {}),
        "reviewRequests": list(runtime_result.get("review_requests") or []),
        "reviewState": dict(runtime_result.get("review_state") or {}),
        "reviewSummary": dict(runtime_result.get("review_summary") or {}),
        "trustSummary": trust_summary,
        "ownerSummary": dict(runtime_result.get("owner_summary") or {}),
        "runSummary": dict(runtime_result.get("run_summary") or {}),
        "testSummary": dict(runtime_result.get("test_summary") or {}),
        "reviewQueueSummary": dict(runtime_result.get("review_queue_summary") or {}),
        "recommendedActions": list(runtime_result.get("recommended_actions") or []),
        "runtimeContext": dict(runtime_result.get("runtime_context") or {}),
        "runtimeTask": dict(runtime_result.get("runtime_task") or {}),
        "runtimeRun": dict(runtime_result.get("runtime_run") or {}),
        "runtimeResult": dict(runtime_result.get("runtime_result") or {}),
        "runtimeFailure": dict(runtime_result.get("runtime_failure") or {}),
        "runtimeEvents": list(runtime_result.get("runtime_events") or []),
        "experimentRun": dict(runtime_result.get("experiment_run") or {}),
        "experimentScenario": dict(runtime_result.get("experiment_scenario") or {}),
        "experimentScorecard": dict(runtime_result.get("experiment_scorecard") or {}),
        "strategyBenchmark": dict(runtime_result.get("strategy_benchmark") or {}),
        "ownerExperimentSummary": dict(runtime_result.get("owner_experiment_summary") or {}),
        "trainingHandoff": dict(runtime_result.get("training_handoff") or {}),
        "recommendedNextAction": recommended_next_action,
        "projectMaintenanceStatus": {
            "task_id": task_id,
            "status": status,
            "history_entry_count": int(history_summary.get("entry_count") or 0),
            "execution_status_counts": dict(history_summary.get("status_counts") or {}),
        },
        "summary": str(
            (runtime_result.get("review_summary") or {}).get("summary")
            or (runtime_result.get("run_summary") or {}).get("summary")
            or f"Executed project maintenance task {task_id}."
        ),
        "label": "PROJECT MAINTENANCE RUN",
    }


def export_self_improvement_queue(options: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(options or {})
    output_path = Path(payload.get("output") or payload.get("outputPath") or _default_self_improvement_queue_path())
    summary = summarize_self_improvement_work(
        REPO_ROOT,
        history_limit=int(payload.get("historyLimit", payload.get("history_limit", 40)) or 40),
        max_candidates=int(payload.get("limit", 8) or 8),
    )
    export_payload = {
        "queue_summary": dict(summary.get("queue_summary") or {}),
        "recommendation": dict(summary.get("recommendation") or {}),
        "prepared_tasks": [dict(item) for item in list(summary.get("prepared_tasks") or []) if isinstance(item, dict)],
        "candidates": [dict(item) for item in list(summary.get("candidates") or []) if isinstance(item, dict)],
        "backlog_export": [dict(item) for item in list(summary.get("backlog_export") or []) if isinstance(item, dict)],
        "history_summary": dict(summary.get("history_summary") or {}),
    }
    export_payload.update(_queue_trust_export_fields(export_payload["queue_summary"], export_payload["history_summary"]))
    written = write_self_improvement_export(REPO_ROOT, export_payload, target=output_path, suffix="queue")
    trust_payload = _extract_queue_trust_payload(export_payload["queue_summary"], export_payload["history_summary"])
    return {
        "ok": written is not None,
        "outputPath": str(written) if written else None,
        "queueSummary": export_payload["queue_summary"],
        **trust_payload,
        "recommendation": export_payload["recommendation"],
        "preparedTasks": export_payload["prepared_tasks"],
        "backlogExport": export_payload["backlog_export"],
        "historySummary": export_payload["history_summary"],
        "artifactPaths": [str(path) for path in [written] if path],
        "summary": str((export_payload["queue_summary"] or {}).get("summary") or "Self-improvement queue exported."),
        "label": "SELF-IMPROVEMENT EXPORT",
    }


def bootstrap_self_improvement_backlog(options: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(options or {})
    seed_requests = [
        dict(item)
        for item in list(payload.get("seeds") or payload.get("payloads") or [])
        if isinstance(item, dict)
    ]
    if not seed_requests:
        raise RuntimeApiError("self-improvement bootstrap requires at least one seed request")

    history_limit = int(payload.get("historyLimit", payload.get("history_limit", 40)) or 40)
    queue_limit = int(payload.get("limit", 8) or 8)
    pause_stale = bool(payload.get("pauseExisting", payload.get("pause_existing", True)))
    paused_seed_ids: list[str] = []
    requested_seed_ids = {
        str(item.get("seedId") or item.get("seed_id") or "").strip()
        for item in seed_requests
        if str(item.get("seedId") or item.get("seed_id") or "").strip()
    }

    if pause_stale:
        active_seeds = load_self_improvement_seeds(REPO_ROOT, limit=0, active_only=True)
        for item in active_seeds:
            requested_by = str(item.get("requested_by") or item.get("requestedBy") or "").strip()
            target_paths = [
                str(path)
                for path in list(item.get("target_paths") or item.get("targetPaths") or [])
                if str(path)
            ]
            seed_id = str(item.get("seed_id") or item.get("seedId") or "").strip()
            should_pause = False
            if requested_by != "operator-batch" and not any(
                path.startswith("docs/assistant_runs/") for path in target_paths
            ):
                should_pause = requested_by == "bootstrap" and seed_id not in requested_seed_ids
            else:
                should_pause = True
            if not should_pause:
                continue
            if not seed_id:
                continue
            append_self_improvement_seed(
                REPO_ROOT,
                {
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "seed_id": seed_id,
                    "status": "paused",
                    "target_paths": target_paths,
                    "requested_by": "bootstrap",
                    "notes": "Paused by bootstrap-self-improvement so bug-focused starter slices stay on top.",
                },
            )
            paused_seed_ids.append(seed_id)

    seeded_results = [
        seed_self_improvement_task(
            {
                **seed_request,
                "historyLimit": history_limit,
                "limit": queue_limit,
            }
        )
        for seed_request in seed_requests
    ]
    queue_export = export_self_improvement_queue(
        {
            "output": payload.get("output") or payload.get("outputPath") or _default_self_improvement_queue_path(),
            "historyLimit": history_limit,
            "limit": queue_limit,
        }
    )
    return {
        "ok": True,
        "pausedSeedIds": paused_seed_ids,
        "seeded": [
            {
                "seedId": str(item.get("seedId") or ""),
                "taskId": str(item.get("taskId") or ""),
                "summary": str(item.get("summary") or ""),
            }
            for item in seeded_results
        ],
        "queueSummary": dict(queue_export.get("queueSummary") or {}),
        "preparedTasks": [dict(item) for item in list(queue_export.get("preparedTasks") or []) if isinstance(item, dict)],
        "backlogExport": [dict(item) for item in list(queue_export.get("backlogExport") or []) if isinstance(item, dict)],
        "artifactPaths": [str(path) for path in list(queue_export.get("artifactPaths") or []) if str(path)],
        "summary": f"Bootstrapped {len(seeded_results)} self-improvement slice(s).",
        "label": "SELF-IMPROVEMENT BOOTSTRAP",
    }


def seed_self_improvement_task(options: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(options or {})
    raw_target_paths = [
        str(path)
        for path in [
            *(list(payload.get("targetPaths") or []) if isinstance(payload.get("targetPaths"), list) else []),
            *(list(payload.get("target_paths") or []) if isinstance(payload.get("target_paths"), list) else []),
            payload.get("targetPath"),
            payload.get("target_path"),
        ]
        if str(path or "").strip()
    ]
    target_paths = filter_self_improvement_paths(raw_target_paths)
    if not target_paths or len(target_paths) != len(raw_target_paths):
        raise RuntimeApiError("self-improvement seeding is limited to assistant-owned paths")
    seed_id = str(payload.get("seedId") or payload.get("seed_id") or f"seed-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}").strip()
    title = str(payload.get("title") or "").strip() or f"Operator-seeded self-improvement for {target_paths[0]}"
    summary_text = str(payload.get("summary") or payload.get("objective") or "").strip() or f"Operator-seeded self-improvement slice for {', '.join(target_paths[:2])}."
    seed_entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "seed_id": seed_id,
        "status": "active",
        "title": title,
        "summary": summary_text,
        "objective": str(payload.get("objective") or summary_text),
        "target_paths": target_paths,
        "requested_by": str(payload.get("requestedBy") or payload.get("requested_by") or "operator"),
        "priority": str(payload.get("priority") or "medium"),
        "severity": int(payload.get("severity") or 0),
        "notes": str(payload.get("notes") or ""),
        "source_tickets": [str(ticket) for ticket in list(payload.get("sourceTickets") or payload.get("source_tickets") or []) if str(ticket)],
    }
    seed_path = append_self_improvement_seed(REPO_ROOT, seed_entry)
    queue_export = export_self_improvement_queue(
        {
            "output": payload.get("output") or payload.get("outputPath") or _default_self_improvement_queue_path(),
            "historyLimit": payload.get("historyLimit", payload.get("history_limit", 40)),
            "limit": payload.get("limit", 8),
        }
    )
    seeded_task = next(
        (dict(item) for item in list(queue_export.get("preparedTasks") or []) if str((item.get("metadata") or {}).get("seed_id") or "") == seed_id),
        {},
    )
    seeded_candidate = next(
        (dict(item) for item in list((queue_export.get("queueSummary") or {}).get("top_candidates") or []) if str((item.get("metadata") or {}).get("seed_id") or "") == seed_id),
        {},
    )
    return {
        "ok": seed_path is not None,
        "seedId": seed_id,
        "taskId": str(seeded_task.get("task_id") or ""),
        "candidate": seeded_candidate,
        "task": seeded_task,
        "queueSummary": dict(queue_export.get("queueSummary") or {}),
        "recommendation": dict(queue_export.get("recommendation") or {}),
        "preparedTasks": [dict(item) for item in list(queue_export.get("preparedTasks") or []) if isinstance(item, dict)],
        "backlogExport": [dict(item) for item in list(queue_export.get("backlogExport") or []) if isinstance(item, dict)],
        "artifactPaths": [str(path) for path in [seed_path, queue_export.get("outputPath") or _default_self_improvement_seed_path()] if str(path or "")],
        "summary": f"Seeded self-improvement task request {seed_id}.",
        "label": "SELF-IMPROVEMENT SEED",
    }


def execute_self_improvement_task(options: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(options or {})
    summary = summarize_self_improvement_work(
        REPO_ROOT,
        history_limit=int(payload.get("historyLimit", payload.get("history_limit", 40)) or 40),
        max_candidates=int(payload.get("limit", 8) or 8),
    )
    task = _selected_self_improvement_task(payload, summary)
    runtime_task = dict(task.get("runtime_task") or {})
    task_metadata = {
        **dict(runtime_task.get("metadata") or {}),
        **dict(task.get("metadata") or {}),
    }
    raw_target_paths = [str(path) for path in list(task.get("target_paths") or runtime_task.get("metadata", {}).get("target_paths") or []) if str(path)]
    target_paths = filter_self_improvement_paths(raw_target_paths)
    if not target_paths:
        raise RuntimeApiError("self-improvement task has no target paths")
    if len(target_paths) != len(raw_target_paths):
        history_path = append_self_improvement_history(
            REPO_ROOT,
            {
                "task_id": str(task.get("task_id") or ""),
                "candidate_id": str(task.get("candidate_id") or ""),
                "status": "blocked",
                "ok": False,
                "action": str(runtime_task.get("action") or task.get("action") or "implement"),
                "target_paths": raw_target_paths,
                "blocked_reason": "self-improvement execution is limited to assistant-owned desktop-agent paths",
            },
        )
        queue_export = export_self_improvement_queue(
            {
                "output": payload.get("output") or payload.get("outputPath") or _default_self_improvement_queue_path(),
                "historyLimit": payload.get("historyLimit", payload.get("history_limit", 40)),
                "limit": payload.get("limit", 8),
            }
        )
        return {
            "ok": False,
            "taskId": str(task.get("task_id") or ""),
            "status": "blocked",
            "blockedReason": "self-improvement execution is limited to assistant-owned desktop-agent paths",
            "artifactPaths": [str(path) for path in [history_path, queue_export.get("outputPath") or _default_self_improvement_history_path()] if str(path or "")],
            "queueSummary": dict(queue_export.get("queueSummary") or {}),
            "historySummary": summarize_self_improvement_history(REPO_ROOT),
            "label": "SELF-IMPROVEMENT RUN",
        }

    task_id = str(task.get("task_id") or runtime_task.get("metadata", {}).get("self_improvement_task_id") or "self-task")
    seed_id = str(task_metadata.get("seed_id") or "")
    action = str(runtime_task.get("action") or task.get("action") or "implement")
    host_boundary = {
        **dict(task.get("host_boundary") or {}),
        **dict(runtime_task.get("host_boundary") or {}),
        **dict(payload.get("hostBoundary") or payload.get("host_boundary") or {}),
        "self_improvement_only": True,
        "approval_protected_only": True,
        "allowed_target_paths": target_paths,
        "self_improvement_depth": 1,
        "max_self_improvement_tasks": 1,
        "allow_followup_execution": False,
    }
    adapter = _PreparedSelfImprovementAdapter(
        REPO_ROOT,
        ticket_id=task_id,
        objective=str(task.get("objective") or runtime_task.get("desc") or task.get("title") or "Self-improvement task"),
        target_paths=target_paths,
    )
    runtime_result = _facade_run_ticket(
        adapter,
        task_id,
        mode=str(task.get("mode") or runtime_task.get("mode") or payload.get("mode") or "integrate"),
        args=_runtime_args(
            execute=action in {"run", "implement"},
            write=action == "implement",
            confirm=bool(payload.get("confirm", True)),
            repair=bool(payload.get("repair", True)),
            host_boundary=host_boundary,
            editor_context=normalize_editor_context(payload.get("editor_context") or payload.get("editorContext") or {}),
        ),
        project_root=REPO_ROOT,
        editor_context=normalize_editor_context(payload.get("editor_context") or payload.get("editorContext") or {}),
    )
    status = _self_improvement_task_status(runtime_result)
    trust_summary = _extract_trust_summary(runtime_result)
    history_entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "task_id": task_id,
        "candidate_id": str(task.get("candidate_id") or ""),
        "ticket": str(runtime_result.get("ticket") or task_id),
        "status": status,
        "ok": bool(runtime_result.get("ok", False)),
        "action": action,
        "mode": str(task.get("mode") or runtime_task.get("mode") or "integrate"),
        "target_paths": target_paths,
        "artifact_paths": [
            str(path)
            for path in [
                runtime_result.get("artifacts", {}).get("run_artifact"),
                runtime_result.get("artifacts", {}).get("human_summary"),
            ]
            if str(path or "")
        ],
        "review_state": dict(runtime_result.get("review_state") or {}),
        "review_summary": dict(runtime_result.get("review_summary") or {}),
        "trust_summary": trust_summary,
        "owner_summary": dict(runtime_result.get("owner_summary") or {}),
        "run_summary": dict(runtime_result.get("run_summary") or {}),
        "test_summary": dict(runtime_result.get("test_summary") or {}),
        "recommended_actions": list(runtime_result.get("recommended_actions") or []),
    }
    history_path = append_self_improvement_history(REPO_ROOT, history_entry)
    if seed_id:
        append_self_improvement_seed(
            REPO_ROOT,
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "seed_id": seed_id,
                "status": status,
                "task_id": task_id,
                "candidate_id": str(task.get("candidate_id") or ""),
                "target_paths": target_paths,
            },
        )
    queue_export = export_self_improvement_queue(
        {
            "output": payload.get("output") or payload.get("outputPath") or _default_self_improvement_queue_path(),
            "historyLimit": payload.get("historyLimit", payload.get("history_limit", 40)),
            "limit": payload.get("limit", 8),
        }
    )
    history_summary = summarize_self_improvement_history(
        REPO_ROOT,
        limit=int(payload.get("historyLimit", payload.get("history_limit", 40)) or 40),
    )
    return {
        "ok": bool(runtime_result.get("ok", False)) or status == "review",
        "taskId": task_id,
        "status": status,
        "action": "self-improvement-run",
        "ticket": str(runtime_result.get("ticket") or task_id),
        "exitCode": 0 if bool(runtime_result.get("ok", False)) or status == "review" else 1,
        "artifact": runtime_result,
        "artifactPaths": [
            str(path)
            for path in [
                history_path,
                queue_export.get("outputPath"),
                runtime_result.get("artifacts", {}).get("run_artifact"),
                runtime_result.get("artifacts", {}).get("human_summary"),
            ]
            if str(path or "")
        ],
        "queueSummary": dict(queue_export.get("queueSummary") or {}),
        "historySummary": history_summary,
        "reviewRequests": list(runtime_result.get("review_requests") or []),
        "reviewState": dict(runtime_result.get("review_state") or {}),
        "reviewSummary": dict(runtime_result.get("review_summary") or {}),
        "trustSummary": trust_summary,
        "ownerSummary": dict(runtime_result.get("owner_summary") or {}),
        "runSummary": dict(runtime_result.get("run_summary") or {}),
        "testSummary": dict(runtime_result.get("test_summary") or {}),
        "reviewQueueSummary": dict(runtime_result.get("review_queue_summary") or {}),
        "recommendedActions": list(runtime_result.get("recommended_actions") or []),
        "runtimeContext": dict(runtime_result.get("runtime_context") or {}),
        "runtimeTask": dict(runtime_result.get("runtime_task") or {}),
        "runtimeRun": dict(runtime_result.get("runtime_run") or {}),
        "runtimeResult": dict(runtime_result.get("runtime_result") or {}),
        "runtimeFailure": dict(runtime_result.get("runtime_failure") or {}),
        "runtimeEvents": list(runtime_result.get("runtime_events") or []),
        "summary": str((runtime_result.get("review_summary") or {}).get("summary") or (runtime_result.get("run_summary") or {}).get("summary") or f"Executed self-improvement task {task_id}."),
        "label": "SELF-IMPROVEMENT RUN",
    }


def analyze_logs(options: dict[str, Any] | None = None) -> dict[str, Any]:
    analyzer = _load_script_module("runtime_api_analyze_dev_assistant_log", "analyze_dev_assistant_log.py")
    payload = dict(options or {})
    log_path = Path(payload.get("log") or getattr(analyzer, "LOG_PATH", _default_log_path()))
    write_report = bool(payload.get("writeReport", payload.get("write_report", True)))
    entries = analyzer.parse_log(log_path)
    tickets = analyzer.load_tickets()
    report = analyzer.render_report(entries, tickets)
    report_path = Path(payload.get("reportPath") or _default_report_path())
    ticket_ids = sorted({str(entry.get("ticket") or "") for entry in entries if entry.get("ticket")})
    recommendations = report.count("\n- ") if "## Recommendations" in report else 0
    if write_report:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(report + "\n", encoding="utf-8")
    return {
        "ok": True,
        "report": report,
        "logPath": str(log_path),
        "reportPath": str(report_path) if write_report else None,
        "entryCount": len(entries),
        "ticketCount": len(ticket_ids),
        "recommendationCount": recommendations,
        "artifactPaths": [str(report_path)] if write_report else [],
        "summary": f"Analyzed {len(entries)} log entries across {len(ticket_ids)} BATs.",
        "label": "ANALYZE LOG",
    }


def start_scheduler(options: dict[str, Any] | None = None) -> dict[str, Any]:
    del options
    autopilot = _load_script_module("runtime_api_autopilot", "autopilot.py")
    autopilot.main()
    return {"ok": True, "running": False, "message": "scheduler stopped"}


def stop_scheduler() -> dict[str, Any]:
    return {"ok": True, "message": "scheduler stop is managed by the host process"}


def orchestrate(options: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(options or {})
    metadata = dict(payload.get("metadata") or {})
    objective = str(payload.get("objective") or payload.get("prompt") or "").strip()
    if not objective:
        raise RuntimeApiError("orchestrate requires an objective")
    selected_root = _selected_project_root(payload)
    approved_ids = {str(item) for item in payload.get("approvedRequests", []) if str(item).strip()}
    approval_protected_only = bool(payload.get("approvalProtectedOnly", payload.get("approval_protected_only", True)))
    gate = ApprovalGate(
        require_controlled=bool(payload.get("approvalGated", True)) and approval_protected_only,
        require_privileged=bool(payload.get("approvalGated", True)),
        approved_request_ids=approved_ids,
    )
    for item in list(payload.get("approvalDecisions", []) or []):
        if not isinstance(item, dict):
            continue
        gate.decide(str(item.get("id") or ""), str(item.get("decision") or ""), note=str(item.get("note") or ""))
    provider = _build_orchestration_provider(payload, selected_root)
    result = run_tool_loop(
        project_root=selected_root,
        objective=objective,
        ticket=str(payload.get("ticket") or "").strip() or None,
        context={
            **dict(payload.get("context") or {}),
            "host_boundary": payload.get("hostBoundary") or payload.get("host_boundary") or {},
            "project_root": str(selected_root),
            "editor_context": dict(payload.get("editorContext") or payload.get("editor_context") or {}),
            "task_mode": str(payload.get("taskMode") or payload.get("task_mode") or metadata.get("task_mode") or metadata.get("taskMode") or ""),
            "lane_id": str(payload.get("laneId") or payload.get("lane_id") or metadata.get("lane_id") or metadata.get("laneId") or ""),
            "lane_label": str(payload.get("laneLabel") or payload.get("lane_label") or metadata.get("lane_label") or metadata.get("laneLabel") or ""),
            "validation": dict(payload.get("validation") or {}),
            "repair": dict(payload.get("repair") or {}),
            "artifact_paths": list(payload.get("artifactPaths") or payload.get("artifact_paths") or []),
        },
        approval_gate=gate,
        provider=provider,
        max_steps=int(payload.get("maxSteps", 10) or 10),
    )
    if _orchestration_expects_mutation(payload, result):
        changed_paths = _orchestration_changed_paths(result)
        if result.get('ok') and not changed_paths and not _orchestration_has_mutating_tool_events(result):
            result = _mark_orchestration_noop_failure(result, objective)
    trust_summary = _extract_trust_summary(result)
    operator_execution = _build_operator_execution_payload(
        task=objective,
        task_mode=str((result.get("runtime_task") or {}).get("task_mode") or "coder"),
        action="orchestrate",
        ticket_id=str(payload.get("ticket") or ""),
        run_id=str((result.get("runtime_run") or {}).get("run_id") or ""),
        status=str((result.get("runtime_result") or {}).get("status") or ""),
        run_state=str((result.get("runtime_result") or {}).get("final_state") or ""),
        current_stage=str((result.get("runtime_run") or {}).get("current_stage") or "tool-loop"),
        result_summary=str(
            (result.get("review_summary") or {}).get("summary")
            or (result.get("run_summary") or {}).get("summary")
            or (result.get("test_summary") or {}).get("summary")
            or ""
        ),
        runtime_context=dict(result.get("runtime_context") or {}),
        review_summary=dict(result.get("review_summary") or {}),
        trust_summary=trust_summary,
        run_summary=dict(result.get("run_summary") or {}),
        test_summary=dict(result.get("test_summary") or {}),
        benchmark_summary=dict(result.get("experiment_benchmark_summary") or {}),
        owner_experiment_summary=dict(result.get("owner_experiment_summary") or {}),
        training_handoff=dict(result.get("training_handoff") or {}),
        artifact_paths=[str(path) for path in list(result.get("artifact_paths") or []) if str(path)],
        runtime_task=dict(result.get("runtime_task") or {}),
        runtime_run=dict(result.get("runtime_run") or {}),
        runtime_result=dict(result.get("runtime_result") or {}),
        runtime_failure=dict(result.get("runtime_failure") or {}),
        runtime_events=list(result.get("runtime_events") or []),
        review_state=dict(result.get("review_state") or {}),
        review_requests=list(result.get("review_requests") or []),
        recommended_actions=list(result.get("recommended_actions") or []),
        lane_id=str(((payload.get("metadata") or {}).get("lane_id") or "")),
        lane_label=str(((payload.get("metadata") or {}).get("lane_label") or "")),
        model_profile_id=str(((payload.get("metadata") or {}).get("modelProfileId") or "")),
        model_role=str(((payload.get("metadata") or {}).get("modelRole") or "")),
        model_display_name=str(((payload.get("metadata") or {}).get("modelDisplayName") or "")),
        base_model=str(((payload.get("metadata") or {}).get("baseModel") or "")),
        provider_source=str(((payload.get("metadata") or {}).get("providerSource") or "")),
        retry_available=bool((result.get("runtime_failure") or {}).get("retryable")),
        repair_available=True,
    )
    return {
        "ok": bool(result.get("ok", False)),
        "action": "orchestrate",
        "ticket": str(payload.get("ticket") or ""),
        "exitCode": 0 if result.get("ok") else (2 if result.get("pending_approvals") else 1),
        "checks": [],
        "projectRoot": str(selected_root),
        "artifact": result,
        "artifactPaths": [],
        "label": "ORCHESTRATE TOOL LOOP",
        "approvalRequests": list(result.get("pending_approvals") or []),
        "approvalState": dict(result.get("approval_state") or {}),
        "reviewRequests": list(result.get("review_requests") or []),
        "reviewState": dict(result.get("review_state") or {}),
        "reviewSummary": dict(result.get("review_summary") or {}),
        "trustSummary": trust_summary,
        "ownerSummary": dict(result.get("owner_summary") or {}),
        "runSummary": dict(result.get("run_summary") or {}),
        "testSummary": dict(result.get("test_summary") or {}),
        "reviewQueueSummary": dict(result.get("review_queue_summary") or {}),
        "recommendedActions": list(result.get("recommended_actions") or []),
        "experimentRun": dict(result.get("experiment_run") or {}),
        "experimentScenario": dict(result.get("experiment_scenario") or {}),
        "experimentScorecard": dict(result.get("experiment_scorecard") or {}),
        "strategyBenchmark": dict(result.get("strategy_benchmark") or {}),
        "experimentBenchmarkSummary": dict(result.get("experiment_benchmark_summary") or {}),
        "ownerExperimentSummary": dict(result.get("owner_experiment_summary") or {}),
        "trainingHandoff": dict(result.get("training_handoff") or {}),
        "runtimeContext": dict(result.get("runtime_context") or {}),
        "runtimeTask": dict(result.get("runtime_task") or {}),
        "runtimeRun": dict(result.get("runtime_run") or {}),
        "runtimeResult": dict(result.get("runtime_result") or {}),
        "runtimeFailure": dict(result.get("runtime_failure") or {}),
        "runtimeEvents": list(result.get("runtime_events") or []),
        "toolAuditTrail": list(result.get("tool_audit_trail") or []),
        "operatorExecution": operator_execution,
    }


def dispatch_action(request: dict[str, Any]) -> dict[str, Any]:
    action = str(request.get("action") or "").strip().lower()
    host_boundary = dict(request.get("hostBoundary") or request.get("host_boundary") or {})
    self_improvement_only = bool(
        host_boundary.get("selfImprovementOnly")
        or host_boundary.get("self_improvement_only")
        or str(request.get("autonomyMode") or "").strip().lower() in {"self", "self-improve", "self-only", "assistant"}
        or request.get("selfImprovementOnly") is True
    )
    if action == "plan":
        return run_ticket(str(request.get("ticket") or ""), "plan", request)
    if action == "run":
        return run_ticket(str(request.get("ticket") or ""), "run", request)
    if action == "implement":
        return run_ticket(str(request.get("ticket") or ""), "implement", request)
    if action == "sprint":
        return run_batch(
            str(request.get("sprintAction") or "run"),
            {
                "count": request.get("count", 5),
                "status": request.get("status", "TODO"),
                "requireTag": request.get("requireTag"),
                "requireText": request.get("requireText"),
                "preferDomain": request.get("preferDomain"),
            },
            request,
        )
    if action == "autopilot":
        return run_batch(
            str(request.get("sprintAction") or request.get("autopilotAction") or "implement"),
            {
                "count": request.get("count", request.get("autopilotCount", 1)),
                "status": request.get("status", "TODO"),
                "requireTag": request.get("requireTag"),
                "requireText": request.get("requireText"),
                "preferDomain": request.get("preferDomain"),
            },
            request,
        )
    if action == "self-improve":
        request = dict(request)
        request.setdefault("synthesizeFollowups", True)
        host_boundary = dict(request.get("hostBoundary") or request.get("host_boundary") or {})
        host_boundary.setdefault("selfImprovementOnly", True)
        host_boundary.setdefault("approvalProtectedOnly", True)
        request["hostBoundary"] = host_boundary
        request.setdefault("requireTag", "OPS")
        request.setdefault("preferDomain", "assistant_runtime")
        return run_batch(
            str(request.get("sprintAction") or request.get("autopilotAction") or request.get("selfImproveAction") or "implement"),
            {
                "count": request.get("count", request.get("autopilotCount", request.get("selfImproveCount", 2))),
                "status": request.get("status", "TODO"),
                "requireTag": request.get("requireTag") or None,
                "requireText": request.get("requireText"),
                "preferDomain": request.get("preferDomain"),
            },
            request,
        )
    if action == "analyze-log":
        return analyze_logs({"writeReport": True})
    if action == "experiment-summary":
        return summarize_experiments(request)
    if action in {"engine-baseline-summary", "engine-baseline"}:
        return summarize_engine_baseline(request)
    if action in {"engine-daily-report", "engine-daily"}:
        return summarize_engine_daily_report(request)
    if action == "experiment-export":
        return export_experiment_dataset(request)
    if action == "self-improvement-summary":
        return summarize_self_improvement(request)
    if action == "self-improvement-seed":
        return seed_self_improvement_task(request)
    if action == "self-improvement-export":
        return export_self_improvement_queue(request)
    if action == "self-improvement-run":
        return execute_self_improvement_task(request)
    if action in {"project-maintenance", "project-maintenance-summary"}:
        return summarize_project_maintenance(request)
    if action == "project-maintenance-export":
        return export_project_maintenance_queue(request)
    if action == "project-maintenance-run":
        return execute_project_maintenance_task(request)
    if action in {"owner-automation", "owner-automation-summary"}:
        return summarize_owner_automation(request)
    if action == "owner-automation-export":
        return export_owner_automation_queue(request)
    if action == "owner-automation-run":
        return execute_owner_automation_task(request)
    if action == "training-handoff":
        return prepare_training_handoff(request)
    if action == "train":
        return train(request)
    if action == "checkpoint-merge":
        return checkpoint_merge(request)
    if action == "orchestrate":
        return orchestrate(request)
    if action == "lab-train":
        result = run_lab_training_scenario(request)
        return {
            "ok": bool(result.get("ok", False)),
            "action": "lab-train",
            "ticket": str(result.get("ticket_id") or ""),
            "exitCode": 0 if result.get("ok", False) else 1,
            "checks": list((result.get("runtime_result") or {}).get("validation", {}).get("results", []) or []),
            "artifact": result,
            "artifactPaths": [
                str(path)
                for path in [
                    (result.get("lab_outputs") or {}).get("run_summary"),
                    (result.get("lab_outputs") or {}).get("scorecard"),
                    (result.get("lab_outputs") or {}).get("container_contract"),
                ]
                if str(path or "")
            ],
            "label": f"LAB TRAIN {result.get('scenario_id', '')}",
            "runtimeContext": dict((result.get("runtime_result") or {}).get("runtime_context") or {}),
        }
    if action == "lab-train-docker":
        contract_path = str(request.get("contractPath") or request.get("contract_path") or "").strip()
        if not contract_path:
            raise RuntimeApiError("lab-train-docker requires contractPath")
        timeout = request.get("timeout")
        result = run_lab_container_contract(contract_path, timeout=int(timeout) if timeout is not None else None)
        return {
            "ok": bool(result.get("ok", False)),
            "action": "lab-train-docker",
            "ticket": str(result.get("ticket_id") or ""),
            "exitCode": int(result.get("exit_code", 1)) if result.get("exit_code") is not None else 1,
            "checks": [],
            "artifact": result,
            "artifactPaths": [
                str(path)
                for path in [
                    result.get("contract_path"),
                    result.get("result_path"),
                ]
                if str(path or "")
            ],
            "label": f"LAB TRAIN DOCKER {result.get('scenario_id', '')}",
        }
    if action == "lab-run-task":
        from backend.agent.runtime.lab_task_launcher import run_lab_task

        result = run_lab_task(request)
        return {
            "ok": bool(result.get("ok", False)),
            "action": "lab-run-task",
            "ticket": str(result.get("ticket_id") or ""),
            "exitCode": 0 if result.get("ok", False) else 1,
            "checks": [],
            "artifact": result,
            "artifactPaths": [
                str(path)
                for path in [
                    result.get("contract_path"),
                    result.get("container_result_path"),
                ]
                if str(path or "")
            ],
            "label": f"LAB RUN TASK {result.get('scenario_id', '')}",
        }
    raise RuntimeApiError(f"unsupported action: {action}")


def _parse_payload(value: str | None) -> dict[str, Any]:
    if not value:
        return {}
    try:
        payload = json.loads(value)
    except json.JSONDecodeError as exc:
        raise RuntimeApiError(f"invalid payload json: {exc}") from exc
    if not isinstance(payload, dict):
        raise RuntimeApiError("payload must decode to an object")
    return payload


def _emit_result(result_file: str | None, payload: dict[str, Any]) -> None:
    if result_file:
        _write_json(Path(result_file), payload)
    else:
        print(json.dumps(_json_safe(payload)))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Runtime API boundary for GoSenderr agent hosts")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("action", "chat", "train", "analyze-logs", "scheduler-start", "scheduler-stop"):
        sub = subparsers.add_parser(command)
        sub.add_argument("--payload-json", help="json payload object")
        sub.add_argument("--result-file", help="path for structured json result")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        payload = _parse_payload(getattr(args, "payload_json", None))
        if args.command == "action":
            result = dispatch_action(payload.get("request", payload))
            _emit_result(args.result_file, result)
            return int(result.get("exitCode", 0) or 0)
        if args.command == "chat":
            result = chat(str(payload.get("prompt") or ""), payload.get("context") or {})
            _emit_result(args.result_file, result)
            return 0
        if args.command == "train":
            result = train(payload)
            _emit_result(args.result_file, result)
            return 0
        if args.command == "analyze-logs":
            result = analyze_logs(payload)
            _emit_result(args.result_file, result)
            return 0
        if args.command == "scheduler-start":
            started = {"ok": True, "running": True, "message": "scheduler starting"}
            _emit_result(args.result_file, started)
            start_scheduler(payload)
            return 0
        if args.command == "scheduler-stop":
            result = stop_scheduler()
            _emit_result(args.result_file, result)
            return 0
        raise RuntimeApiError(f"unsupported command: {args.command}")
    except RuntimeApiError as exc:
        error_payload = {"ok": False, "error": str(exc)}
        _emit_result(getattr(args, "result_file", None), error_payload)
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
