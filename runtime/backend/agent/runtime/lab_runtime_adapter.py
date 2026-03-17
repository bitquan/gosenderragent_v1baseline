from __future__ import annotations

import json
import os
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Iterator

from backend.agent.adapters.gosenderr_adapter import GoSenderrAdapter
from backend.agent.core.adapters.base import TicketMetadata


REPO_ROOT = Path(__file__).resolve().parents[3]


def _default_facade_run_ticket(*args: Any, **kwargs: Any) -> dict[str, Any]:
    from backend.agent.core.runtime_facade import run_ticket as facade_run_ticket

    return facade_run_ticket(*args, **kwargs)


@dataclass
class LabTrainingScenario:
    scenario_id: str
    workspace_path: str
    ticket_id: str
    goal: str = ""
    mode: str = "integrate"
    allowed_tools: list[str] = field(default_factory=list)
    expected_tests: list[str] = field(default_factory=list)
    approval_required: bool = True
    repair_retries: int = 2
    scoring_metadata: dict[str, Any] = field(default_factory=dict)
    ticket_desc: str = ""
    validation_commands: list[str] = field(default_factory=list)
    artifact_root: str | None = None
    scorecard_output_path: str | None = None
    task_path: str | None = None
    editor_context: dict[str, Any] = field(default_factory=dict)
    host_boundary: dict[str, Any] = field(default_factory=dict)
    runtime_overrides: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "LabTrainingScenario":
        scenario_id = str(payload.get("scenario_id") or payload.get("scenarioId") or "").strip()
        workspace_path = str(payload.get("workspace_path") or payload.get("workspacePath") or "").strip()
        ticket_id = str(payload.get("ticket_id") or payload.get("ticketId") or payload.get("ticket") or "").strip()
        if not scenario_id:
            raise ValueError("scenario_id is required")
        if not workspace_path:
            raise ValueError("workspace_path is required")
        if not ticket_id:
            raise ValueError("ticket_id is required")
        return cls(
            scenario_id=scenario_id,
            workspace_path=workspace_path,
            ticket_id=ticket_id,
            goal=str(payload.get("goal") or ""),
            mode=str(payload.get("mode") or "integrate").strip() or "integrate",
            allowed_tools=[str(item) for item in list(payload.get("allowed_tools") or payload.get("allowedTools") or []) if str(item).strip()],
            expected_tests=[str(item) for item in list(payload.get("expected_tests") or payload.get("expectedTests") or []) if str(item).strip()],
            approval_required=bool(payload.get("approval_required", payload.get("approvalRequired", True))),
            repair_retries=max(1, int(payload.get("repair_retries", payload.get("repairRetries", 2)) or 2)),
            scoring_metadata=dict(payload.get("scoring_metadata") or payload.get("scoringMetadata") or {}),
            ticket_desc=str(payload.get("ticket_desc") or payload.get("ticketDesc") or ""),
            validation_commands=[str(item) for item in list(payload.get("validation_commands") or payload.get("validationCommands") or []) if str(item).strip()],
            artifact_root=str(payload.get("artifact_root") or payload.get("artifactRoot") or "").strip() or None,
            scorecard_output_path=str(payload.get("scorecard_output_path") or payload.get("scorecardOutputPath") or "").strip() or None,
            task_path=str(payload.get("task_path") or payload.get("taskPath") or "").strip() or None,
            editor_context=dict(payload.get("editor_context") or payload.get("editorContext") or {}),
            host_boundary=dict(payload.get("host_boundary") or payload.get("hostBoundary") or {}),
            runtime_overrides=dict(payload.get("runtime_overrides") or payload.get("runtimeOverrides") or {}),
        )


class LabRepoAdapter(GoSenderrAdapter):
    def __init__(self, project_root: Path, *, tickets: dict[str, str], validation_commands: list[str] | None = None):
        super().__init__(project_root)
        self._tickets = {str(key): str(value) for key, value in dict(tickets).items() if str(key).strip()}
        self._validation_commands = [str(item) for item in list(validation_commands or []) if str(item).strip()]

    def load_tickets(self) -> dict[str, str]:
        return dict(self._tickets)

    def parse_ticket_metadata(self, ticket_id: str, desc: str) -> TicketMetadata:
        resolved_desc = str(desc or self._tickets.get(ticket_id) or f"TODO [LAB] {ticket_id}")
        return super().parse_ticket_metadata(ticket_id, resolved_desc)

    def validation_commands(self, metadata: TicketMetadata, *, full_verify: bool = False) -> list[list[str]]:
        del metadata, full_verify
        if self._validation_commands:
            return [["sh", "-lc", command] for command in self._validation_commands]
        return []


def map_scenario_to_runtime_request(scenario: LabTrainingScenario) -> dict[str, Any]:
    host_boundary = {
        "host_kind": "lab",
        "action": "training",
        "sandbox_required": True,
        "approval_protected_only": bool(scenario.approval_required),
        **dict(scenario.host_boundary or {}),
    }
    return {
        "ticket_id": scenario.ticket_id,
        "mode": scenario.mode,
        "args": {
            "write": True,
            "execute": True,
            "confirm": not scenario.approval_required,
            "repair": True,
            "max_retry_rounds": scenario.repair_retries,
            "ai": bool(dict(scenario.runtime_overrides or {}).get("ai", True)),
            "git": bool(dict(scenario.runtime_overrides or {}).get("git", False)),
            "template": dict(scenario.runtime_overrides or {}).get("template"),
            "host_boundary": host_boundary,
            "editor_context": dict(scenario.editor_context or {}),
            "config": {
                "lab_scenario_id": scenario.scenario_id,
                "lab_goal": scenario.goal,
                "lab_allowed_tools": list(scenario.allowed_tools),
                "lab_expected_tests": list(scenario.expected_tests),
                "lab_scoring_metadata": dict(scenario.scoring_metadata or {}),
            },
            **{
                key: value
                for key, value in dict(scenario.runtime_overrides or {}).items()
                if key not in {"template", "ai", "git"}
            },
        },
    }


def _lab_artifact_root(workspace_root: Path, scenario: LabTrainingScenario) -> Path:
    if scenario.artifact_root:
        candidate = Path(scenario.artifact_root).expanduser()
        if candidate.is_absolute():
            return candidate
        return (workspace_root / candidate).resolve()
    return (workspace_root / ".agent_lab_artifacts").resolve()


def build_lab_container_contract(
    scenario: LabTrainingScenario,
    *,
    artifact_root: Path | None = None,
) -> dict[str, Any]:
    workspace_root = Path(scenario.workspace_path).expanduser().resolve()
    resolved_artifact_root = (artifact_root or _lab_artifact_root(workspace_root, scenario)).resolve()
    docker_image = str(
        dict(scenario.host_boundary or {}).get("docker_image")
        or dict(scenario.host_boundary or {}).get("dockerImage")
        or dict(scenario.runtime_overrides or {}).get("docker_image")
        or "gosenderr-agent-lab:latest"
    ).strip() or "gosenderr-agent-lab:latest"
    payload = {
        "action": "lab-train",
        "scenario_id": scenario.scenario_id,
        "workspace_path": "/workspace",
        "ticket_id": scenario.ticket_id,
        "goal": scenario.goal,
        "mode": scenario.mode,
        "allowed_tools": list(scenario.allowed_tools),
        "expected_tests": list(scenario.expected_tests),
        "approval_required": scenario.approval_required,
        "repair_retries": scenario.repair_retries,
        "scoring_metadata": dict(scenario.scoring_metadata or {}),
        **({"ticket_desc": scenario.ticket_desc} if scenario.ticket_desc else {}),
        **({"validation_commands": list(scenario.validation_commands)} if scenario.validation_commands else {}),
        "artifact_root": "/artifacts",
        **({"scorecard_output_path": scenario.scorecard_output_path} if scenario.scorecard_output_path else {}),
        **({"task_path": scenario.task_path} if scenario.task_path else {}),
        "editor_context": dict(scenario.editor_context or {}),
        "host_boundary": {
            "host_kind": "lab",
            "execution_mode": "docker-contract",
            "sandbox_required": True,
            "docker_image": docker_image,
            **dict(scenario.host_boundary or {}),
        },
        "runtime_overrides": dict(scenario.runtime_overrides or {}),
    }
    return {
        "kind": "docker-lab-contract",
        "phase": "contract-only",
        "scenario_id": scenario.scenario_id,
        "ticket_id": scenario.ticket_id,
        "image": docker_image,
        "workspace_mount": {
            "source": str(workspace_root),
            "target": "/workspace",
            "mode": "rw",
        },
        "artifact_mount": {
            "source": str(resolved_artifact_root),
            "target": "/artifacts",
            "mode": "rw",
        },
        "repo_mount": {
            "source": str(REPO_ROOT),
            "target": "/opt/gosenderr_v1",
            "mode": "rw",
        },
        "working_dir": "/workspace",
        "environment": {
            "GOSENDERR_ASSISTANT_ARTIFACT_ROOT": "/artifacts",
            "GOSENDERR_LAB_SCENARIO_ID": scenario.scenario_id,
            "GOSENDERR_LAB_TICKET_ID": scenario.ticket_id,
        },
        "command": [
            "python",
            "-m",
            "backend.agent.runtime.runtime_api",
            "action",
            "--payload-json",
            json.dumps(payload, separators=(",", ":")),
        ],
        "payload": payload,
    }


def _build_runtime_args(runtime_request: dict[str, Any]) -> SimpleNamespace:
    payload = dict(runtime_request.get("args") or {})
    return SimpleNamespace(
        write=bool(payload.get("write", True)),
        plan=bool(payload.get("plan", False)),
        execute=bool(payload.get("execute", True)),
        autopilot=bool(payload.get("autopilot", False)),
        batch=bool(payload.get("batch", False)),
        schedule=payload.get("schedule"),
        pilot=bool(payload.get("pilot", False)),
        implement=bool(payload.get("implement", True)),
        confirm=bool(payload.get("confirm", False)),
        repair=bool(payload.get("repair", True)),
        repair_last=bool(payload.get("repair_last", payload.get("repairLast", False))),
        notify_url=payload.get("notify_url", payload.get("notifyUrl")),
        ci_report=payload.get("ci_report", payload.get("ciReport")),
        ai=bool(payload.get("ai", True)),
        git=bool(payload.get("git", False)),
        interactive=bool(payload.get("interactive", False)),
        brainstorm=bool(payload.get("brainstorm", False)),
        brainstorm_notes=payload.get("brainstorm_notes", payload.get("brainstormNotes")),
        template=payload.get("template"),
        train=bool(payload.get("train", False)),
        openai=bool(payload.get("openai", False)),
        fine_tune_model=payload.get("fine_tune_model", payload.get("fineTuneModel")),
        config=dict(payload.get("config") or {}),
        editor_context=dict(payload.get("editor_context") or payload.get("editorContext") or {}),
        max_retry_rounds=max(1, int(payload.get("max_retry_rounds", payload.get("maxRetryRounds", 2)) or 2)),
        host_boundary=dict(payload.get("host_boundary") or payload.get("hostBoundary") or {}),
    )


@contextmanager
def _temporary_env(updates: dict[str, str | None]) -> Iterator[None]:
    previous: dict[str, str | None] = {}
    for key, value in updates.items():
        previous[key] = os.environ.get(key)
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _scorecard_payload(scenario: LabTrainingScenario, runtime_result: dict[str, Any]) -> dict[str, Any]:
    validation_rows = [item for item in list(runtime_result.get("validation", {}).get("results", []) or []) if isinstance(item, dict)]
    passed_checks = sum(1 for item in validation_rows if item.get("ok", False))
    failed_checks = sum(1 for item in validation_rows if not item.get("ok", False))
    retries_used = len(list(runtime_result.get("repair", {}).get("repairs", []) or []))
    decisions = list(runtime_result.get("engine_decisions", []) or [])
    approval_triggered = any(
        (item.get("type") == "review-summary" and item.get("requires_manual_review"))
        or (item.get("type") == "write-confidence" and item.get("requires_confirmation"))
        for item in decisions
        if isinstance(item, dict)
    )
    success = bool(runtime_result.get("ok", False))
    score = 100
    if not success:
        score -= 40
    score -= min(20, retries_used * 8)
    if approval_triggered:
        score -= 5
    score = max(0, score)

    return {
        "scenario_id": scenario.scenario_id,
        "success": success,
        "tests_passed": passed_checks,
        "tests_failed": failed_checks,
        "retries_used": retries_used,
        "wrong_file_edits": 0,
        "approval_triggered": approval_triggered,
        "final_score": score,
        "metadata": dict(scenario.scoring_metadata or {}),
    }


def _write_lab_outputs(
    *,
    scenario: LabTrainingScenario,
    artifact_root: Path,
    runtime_result: dict[str, Any],
    container_contract: dict[str, Any],
) -> dict[str, str]:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    base = artifact_root / "lab_runs" / scenario.scenario_id / stamp
    base.mkdir(parents=True, exist_ok=True)

    summary_payload = {
        "scenario_id": scenario.scenario_id,
        "ticket_id": scenario.ticket_id,
        "goal": scenario.goal,
        "workspace_path": str(Path(scenario.workspace_path).resolve()),
        "runtime_ok": bool(runtime_result.get("ok", False)),
        "run_mode": str(runtime_result.get("mode") or ""),
        "changed_files": [
            str(item.get("path") or "")
            for item in list(runtime_result.get("execution", {}).get("results", []) or [])
            if isinstance(item, dict)
        ],
        "artifacts": dict(runtime_result.get("artifacts") or {}),
        "repair_attempts": len(list(runtime_result.get("repair", {}).get("repairs", []) or [])),
        "runtime_context": dict(runtime_result.get("runtime_context") or {}),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    scorecard_payload = _scorecard_payload(scenario, runtime_result)

    summary_path = base / "run_summary.json"
    scorecard_path = base / "scorecard.json"
    contract_path = base / "container_contract.json"
    summary_path.write_text(json.dumps(summary_payload, indent=2) + "\n", encoding="utf-8")
    scorecard_path.write_text(json.dumps(scorecard_payload, indent=2) + "\n", encoding="utf-8")
    contract_path.write_text(json.dumps(container_contract, indent=2) + "\n", encoding="utf-8")

    return {
        "run_summary": str(summary_path),
        "scorecard": str(scorecard_path),
        "container_contract": str(contract_path),
    }


def run_lab_training_scenario(
    payload: dict[str, Any],
    *,
    provider: Any = None,
    facade_run_ticket_fn: Callable[..., dict[str, Any]] = _default_facade_run_ticket,
) -> dict[str, Any]:
    scenario = LabTrainingScenario.from_payload(payload)
    workspace_root = Path(scenario.workspace_path).expanduser().resolve()
    if not workspace_root.exists() or not workspace_root.is_dir():
        raise ValueError(f"workspace_path does not exist or is not a directory: {workspace_root}")

    ticket_desc = str(scenario.ticket_desc or scenario.goal or f"LAB scenario {scenario.scenario_id}").strip()
    if not ticket_desc.upper().startswith(("TODO", "DONE", "BLOCKED", "UPGRADE", "NEW FEATURE")):
        ticket_desc = f"TODO [LAB] {ticket_desc}"

    board_path = workspace_root / "docs" / "BAT_FEATURE_BOARD.md"
    if board_path.exists():
        adapter = GoSenderrAdapter(workspace_root)
        tickets = adapter.load_tickets()
        if scenario.ticket_id not in tickets:
            raise ValueError(f"ticket_id {scenario.ticket_id} is not present in {workspace_root / 'docs' / 'BAT_FEATURE_BOARD.md'}")
    else:
        adapter = LabRepoAdapter(
            workspace_root,
            tickets={scenario.ticket_id: ticket_desc},
            validation_commands=scenario.validation_commands,
        )

    runtime_request = map_scenario_to_runtime_request(scenario)
    runtime_args = _build_runtime_args(runtime_request)
    artifact_root = _lab_artifact_root(workspace_root, scenario)
    artifact_root.mkdir(parents=True, exist_ok=True)
    container_contract = build_lab_container_contract(scenario, artifact_root=artifact_root)

    env_overrides = {
        "GOSENDERR_ASSISTANT_ARTIFACT_ROOT": str(artifact_root),
    }
    with _temporary_env(env_overrides):
        runtime_result = facade_run_ticket_fn(
            adapter,
            runtime_request["ticket_id"],
            mode=runtime_request["mode"],
            provider=provider,
            args=runtime_args,
            project_root=workspace_root,
            editor_context=dict(runtime_args.editor_context or {}),
        )
    lab_outputs = _write_lab_outputs(
        scenario=scenario,
        artifact_root=artifact_root,
        runtime_result=runtime_result,
        container_contract=container_contract,
    )
    return {
        "ok": bool(runtime_result.get("ok", False)),
        "scenario_id": scenario.scenario_id,
        "ticket_id": scenario.ticket_id,
        "workspace_path": str(workspace_root),
        "artifact_root": str(artifact_root),
        **({"scorecard_output_path": scenario.scorecard_output_path} if scenario.scorecard_output_path else {}),
        **({"task_path": scenario.task_path} if scenario.task_path else {}),
        "container_contract": container_contract,
        "runtime_result": runtime_result,
        "lab_outputs": lab_outputs,
    }


__all__ = [
    "LabTrainingScenario",
    "build_lab_container_contract",
    "map_scenario_to_runtime_request",
    "run_lab_training_scenario",
]