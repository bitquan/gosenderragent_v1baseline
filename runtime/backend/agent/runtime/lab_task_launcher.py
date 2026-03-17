from __future__ import annotations

import argparse
from dataclasses import asdict, is_dataclass
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from backend.agent.runtime.runtime_api import RuntimeApiError, dispatch_action


class LabTaskLaunchError(RuntimeError):
    pass


DispatchFn = Callable[[dict[str, Any]], dict[str, Any]]
ReadJsonFn = Callable[[Path], dict[str, Any] | None]


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def _read_structured_file(path: Path) -> dict[str, Any] | None:
    suffix = path.suffix.lower()
    if suffix in {".yaml", ".yml"}:
        try:
            import yaml  # type: ignore

            payload = yaml.safe_load(path.read_text(encoding="utf-8"))
        except Exception:
            return None
        return payload if isinstance(payload, dict) else None
    return _read_json(path)


def _timestamp_slug() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _normalize_scenario_payload(request: dict[str, Any]) -> dict[str, Any]:
    payload = dict(request or {})
    payload.pop("action", None)
    workspace_path = str(payload.get("workspace_path") or payload.get("workspacePath") or "").strip()
    ticket_id = str(payload.get("ticket_id") or payload.get("ticketId") or payload.get("ticket") or "").strip()
    if not workspace_path:
        raise LabTaskLaunchError("workspace_path is required")
    if not ticket_id:
        raise LabTaskLaunchError("ticket_id is required")
    scenario_id = str(payload.get("scenario_id") or payload.get("scenarioId") or "").strip() or f"SCN-{_timestamp_slug()}"
    payload["scenario_id"] = scenario_id
    payload["workspace_path"] = workspace_path
    payload["ticket_id"] = ticket_id
    return payload


def _default_scenario_path(payload: dict[str, Any]) -> Path:
    workspace_root = Path(str(payload.get("workspace_path") or "")).expanduser().resolve()
    scenario_id = str(payload.get("scenario_id") or "scenario").strip() or "scenario"
    return workspace_root / ".agent_lab_artifacts" / "lab_scenarios" / f"{scenario_id}.json"


def _load_required_json(path: Path, *, label: str) -> dict[str, Any]:
    payload = _read_structured_file(path)
    if not payload:
        raise LabTaskLaunchError(f"unable to read {label}: {path}")
    return payload


def _default_lab_root(task_path: Path) -> Path:
    parent = task_path.parent
    if parent.name == "tasks":
        return parent.parent.resolve()
    return parent.resolve()


def _resolve_task_path(value: Any, *, base: Path) -> Path:
    candidate = Path(str(value)).expanduser()
    if candidate.is_absolute():
        return candidate.resolve()
    return (base / candidate).resolve()


def _write_structured_file(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    suffix = path.suffix.lower()
    if suffix in {".yaml", ".yml"}:
        try:
            import yaml  # type: ignore

            text = yaml.safe_dump(payload, sort_keys=False)
        except Exception:
            text = json.dumps(payload, indent=2) + "\n"
    else:
        text = json.dumps(payload, indent=2) + "\n"
    path.write_text(text, encoding="utf-8")


def _task_lab_root(task_path: str | Path) -> Path:
    return _default_lab_root(Path(task_path).expanduser().resolve())


def list_lab_tasks(lab_root: str | Path) -> dict[str, Any]:
    root = Path(lab_root).expanduser().resolve()
    tasks_dir = root / "tasks"
    task_files = sorted(list(tasks_dir.glob("*.yml")) + list(tasks_dir.glob("*.yaml")) + list(tasks_dir.glob("*.json")))
    entries = []
    for path in task_files:
        payload = _read_structured_file(path)
        if not payload:
            continue
        entries.append(
            {
                "task_file": str(path),
                "task_id": str(payload.get("id") or payload.get("task_id") or payload.get("ticket_id") or ""),
                "scenario_id": str(payload.get("scenario") or payload.get("scenario_id") or ""),
                "goal": str(payload.get("goal") or ""),
                "approval_required": bool(payload.get("approval_required", payload.get("approvalRequired", False))),
            }
        )
    return {"ok": True, "lab_root": str(root), "tasks": entries, "count": len(entries)}


def _scenario_baseline_dir(scenario_root: Path) -> Path:
    return scenario_root / ".baseline"


def reset_lab_scenario(scenario_path: str | Path) -> dict[str, Any]:
    scenario_root = Path(scenario_path).expanduser().resolve()
    baseline_root = _scenario_baseline_dir(scenario_root)
    if not baseline_root.exists() or not baseline_root.is_dir():
        raise LabTaskLaunchError(f"scenario baseline not found: {baseline_root}")

    removed: list[str] = []
    restored: list[str] = []

    for child in list(scenario_root.iterdir()):
        if child.name == ".baseline":
            continue
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()
        removed.append(str(child.relative_to(scenario_root)))

    for source in baseline_root.rglob("*"):
        relative = source.relative_to(baseline_root)
        target = scenario_root / relative
        if source.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        try:
            os.chmod(target, source.stat().st_mode)
        except Exception:
            pass
        restored.append(str(relative))

    return {
        "ok": True,
        "scenario_path": str(scenario_root),
        "baseline_path": str(baseline_root),
        "removed": removed,
        "restored": restored,
    }


def reset_lab_task_state(task_path: str | Path) -> dict[str, Any]:
    payload = resolve_lab_task_request(task_path)
    scenario_reset = reset_lab_scenario(payload["workspace_path"])
    artifact_root = Path(str(payload.get("artifact_root") or "")).expanduser().resolve()
    scorecard_path = Path(str(payload.get("scorecard_output_path") or "")).expanduser().resolve()
    removed: list[str] = []

    if artifact_root.exists():
        shutil.rmtree(artifact_root)
        removed.append(str(artifact_root))
    if scorecard_path.exists():
        scorecard_path.unlink()
        removed.append(str(scorecard_path))

    memory_path = artifact_root / "dev_data" / "dev_assistant_memory.json"
    if memory_path.exists():
        memory_path.unlink()
        removed.append(str(memory_path))

    return {
        "ok": True,
        "task_path": str(Path(task_path).expanduser().resolve()),
        "task_id": str(payload.get("ticket_id") or ""),
        "scenario_id": str(payload.get("scenario_id") or ""),
        "scenario_reset": scenario_reset,
        "removed": removed,
    }


def clone_lab_task(
    task_path: str | Path,
    *,
    new_task_id: str,
    new_scenario_id: str | None = None,
) -> dict[str, Any]:
    source_path = Path(task_path).expanduser().resolve()
    source = _load_required_json(source_path, label="task file")
    source_lab_root = _task_lab_root(source_path)
    old_scenario_id = str(source.get("scenario") or source.get("scenario_id") or "").strip()
    target_scenario_id = str(new_scenario_id or old_scenario_id).strip()
    if not new_task_id.strip():
        raise LabTaskLaunchError("new_task_id is required")
    if not target_scenario_id:
        raise LabTaskLaunchError("scenario id is required")

    cloned = dict(source)
    cloned["id"] = new_task_id
    cloned["scenario"] = target_scenario_id
    if str(source.get("scorecard_output_path") or "").strip():
        cloned["scorecard_output_path"] = str(source_lab_root / "scorecards" / f"{new_task_id}.json")
    if str(source.get("artifact_root") or "").strip():
        cloned["artifact_root"] = str(source_lab_root / "artifacts" / new_task_id)

    target_task_path = source_path.parent / f"{new_task_id}{source_path.suffix}"
    _write_structured_file(target_task_path, cloned)

    source_scenario_root = source_lab_root / "scenarios" / old_scenario_id
    target_scenario_root = source_lab_root / "scenarios" / target_scenario_id
    copied_scenario = False
    if source_scenario_root.exists() and source_scenario_root.is_dir() and source_scenario_root != target_scenario_root and not target_scenario_root.exists():
        shutil.copytree(source_scenario_root, target_scenario_root)
        copied_scenario = True

    return {
        "ok": True,
        "task_path": str(target_task_path),
        "task_id": new_task_id,
        "scenario_id": target_scenario_id,
        "copied_scenario": copied_scenario,
        "scenario_path": str(target_scenario_root),
    }


def resolve_lab_task_request(task_path: str | Path, overrides: dict[str, Any] | None = None) -> dict[str, Any]:
    path = Path(task_path).expanduser().resolve()
    task = _load_required_json(path, label="task file")
    task_id = str(task.get("id") or task.get("task_id") or task.get("ticket_id") or task.get("ticket") or "").strip()
    scenario_id = str(task.get("scenario") or task.get("scenario_id") or task.get("scenarioId") or "").strip()
    if not task_id:
        raise LabTaskLaunchError(f"task file missing id: {path}")
    if not scenario_id:
        raise LabTaskLaunchError(f"task file missing scenario: {path}")

    lab_root = _default_lab_root(path)
    workspace_value = (
        task.get("workspace_path")
        or task.get("workspacePath")
        or task.get("scenario_path")
        or task.get("scenarioPath")
        or (lab_root / "scenarios" / scenario_id)
    )
    workspace_path = str(_resolve_task_path(workspace_value, base=lab_root)).strip()
    goal = str(task.get("goal") or task.get("description") or f"run lab scenario {scenario_id}")
    repair_retries = int(task.get("max_repair_attempts") or task.get("repair_retries") or task.get("repairRetries") or 2)
    payload = {
        "scenario_id": scenario_id,
        "workspace_path": workspace_path,
        "ticket_id": task_id,
        "task_path": str(path),
        "goal": goal,
        "allowed_tools": [str(item) for item in list(task.get("allowed_tools") or task.get("allowedTools") or []) if str(item).strip()],
        "expected_tests": [str(item) for item in list(task.get("expected_tests") or task.get("expectedTests") or []) if str(item).strip()],
        "validation_commands": [
            str(item)
            for item in list(task.get("validation_commands") or task.get("validationCommands") or task.get("test_commands") or task.get("testCommands") or [])
            if str(item).strip()
        ],
        "approval_required": bool(task.get("approval_required", task.get("approvalRequired", False))),
        "repair_retries": max(1, repair_retries),
        "artifact_root": str(_resolve_task_path(task.get("artifact_root") or task.get("artifactRoot") or (lab_root / "artifacts" / task_id), base=lab_root)),
        "scorecard_output_path": str(_resolve_task_path(task.get("scorecard_output_path") or task.get("scorecardOutputPath") or (lab_root / "scorecards" / f"{task_id}.json"), base=lab_root)),
        "ticket_desc": str(task.get("ticket_desc") or task.get("ticketDesc") or f"TODO [LAB] {goal}"),
        "scoring_metadata": {
            "task_id": task_id,
            "expected_tests_pass": bool(task.get("expected_tests_pass", task.get("expectedTestsPass", False))),
            **dict(task.get("scoring_metadata") or task.get("scoringMetadata") or {}),
        },
    }
    runtime_overrides = dict(task.get("runtime_overrides") or task.get("runtimeOverrides") or {})
    if runtime_overrides:
        payload["runtime_overrides"] = runtime_overrides
    if overrides:
        payload.update({key: value for key, value in dict(overrides).items() if key not in {"action", "taskPath", "task_path"}})
    return payload


def _resolve_scorecard_path(summary: dict[str, Any]) -> Path:
    direct_path = str(summary.get("scorecard_path") or summary.get("scorecardPath") or "").strip()
    if direct_path:
        return Path(direct_path).expanduser().resolve()
    lab_train = dict(summary.get("lab_train") or {})
    artifact = dict(lab_train.get("artifact") or {})
    lab_outputs = dict(artifact.get("lab_outputs") or {})
    scorecard_path = str(lab_outputs.get("scorecard") or "").strip()
    if not scorecard_path:
        raise LabTaskLaunchError("lab-run-task result did not include a scorecard path")
    return Path(scorecard_path).expanduser().resolve()


def _resolve_training_output_path(summary: dict[str, Any], output_path: str | Path | None = None) -> Path:
    if output_path:
        return Path(output_path).expanduser().resolve()
    lab_train = dict(summary.get("lab_train") or {})
    artifact = dict(lab_train.get("artifact") or {})
    artifact_root = str(artifact.get("artifact_root") or "").strip()
    if artifact_root:
        return Path(artifact_root).expanduser().resolve() / "lab_training_data.jsonl"
    return Path(summary.get("contract_path") or ".").expanduser().resolve().parent / "lab_training_data.jsonl"


def _resolve_contract_path(lab_train_result: dict[str, Any]) -> Path:
    artifact = dict(lab_train_result.get("artifact") or {})
    lab_outputs = dict(artifact.get("lab_outputs") or {})
    contract_path = str(lab_outputs.get("container_contract") or "").strip()
    if not contract_path:
        raise LabTaskLaunchError("lab-train did not emit a container contract path")
    return Path(contract_path).expanduser().resolve()


def _resolve_container_result_path(lab_docker_result: dict[str, Any]) -> Path:
    artifact = dict(lab_docker_result.get("artifact") or {})
    result_path = str(artifact.get("result_path") or "").strip()
    if not result_path:
        raise LabTaskLaunchError("lab-train-docker did not emit a container result path")
    return Path(result_path).expanduser().resolve()


def _summary_payload(
    *,
    scenario_id: str,
    ticket_id: str,
    contract_path: Path,
    container_result_path: Path,
    lab_train_result: dict[str, Any],
    lab_docker_result: dict[str, Any],
    container_result: dict[str, Any],
) -> dict[str, Any]:
    lab_train_artifact = dict(lab_train_result.get("artifact") or {})
    lab_outputs = dict(lab_train_artifact.get("lab_outputs") or {})
    return {
        "ok": bool(lab_train_result.get("ok", False)) and bool(lab_docker_result.get("ok", False)),
        "scenario_id": scenario_id,
        "ticket_id": ticket_id,
        "contract_path": str(contract_path),
        "container_result_path": str(container_result_path),
        "run_summary_path": str(lab_outputs.get("run_summary") or ""),
        "scorecard_path": str(lab_outputs.get("scorecard") or ""),
        "lab_train": lab_train_result,
        "lab_train_docker": lab_docker_result,
        "container_result": container_result,
        "summary": {
            "lab_train_ok": bool(lab_train_result.get("ok", False)),
            "lab_train_docker_ok": bool(lab_docker_result.get("ok", False)),
            "container_exit_code": int(container_result.get("exit_code", 1) or 0),
            "label": f"LAB TASK {scenario_id}",
        },
    }


def _copy_task_scorecard(summary: dict[str, Any], output_path: str | Path | None) -> str | None:
    if not output_path:
        return None
    scorecard_path = _resolve_scorecard_path(summary)
    destination = Path(output_path).expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(scorecard_path, destination)
    return str(destination)


def run_lab_task(
    request: dict[str, Any],
    *,
    dispatch_fn: DispatchFn = dispatch_action,
    read_json_fn: ReadJsonFn = _read_json,
) -> dict[str, Any]:
    payload = dict(request or {})
    if str(payload.get("action") or "").strip().lower() == "lab-run-task":
        payload = {key: value for key, value in payload.items() if key != "action"}
    task_path = str(payload.get("taskPath") or payload.get("task_path") or "").strip()
    if task_path:
        payload = resolve_lab_task_request(task_path, overrides=payload)

    scenario_id = str(payload.get("scenario_id") or payload.get("scenarioId") or "").strip()
    ticket_id = str(payload.get("ticket_id") or payload.get("ticketId") or payload.get("ticket") or "").strip()

    lab_train_result = dispatch_fn({
        **payload,
        "action": "lab-train",
    })
    contract_path = _resolve_contract_path(lab_train_result)

    lab_docker_result = dispatch_fn({
        "action": "lab-train-docker",
        "contractPath": str(contract_path),
        **({"timeout": payload.get("timeout")} if payload.get("timeout") is not None else {}),
    })
    container_result_path = _resolve_container_result_path(lab_docker_result)
    container_result = read_json_fn(container_result_path)
    if not container_result:
        raise LabTaskLaunchError(f"unable to read container result: {container_result_path}")

    summary = _summary_payload(
        scenario_id=scenario_id or str(container_result.get("scenario_id") or ""),
        ticket_id=ticket_id or str(container_result.get("ticket_id") or ""),
        contract_path=contract_path,
        container_result_path=container_result_path,
        lab_train_result=lab_train_result,
        lab_docker_result=lab_docker_result,
        container_result=container_result,
    )
    if task_path:
        summary["task_path"] = task_path
        summary["task_id"] = ticket_id
        copied_scorecard = _copy_task_scorecard(summary, payload.get("scorecard_output_path"))
        if copied_scorecard:
            summary["task_scorecard_path"] = copied_scorecard
    return summary


def generate_lab_scenario(request: dict[str, Any], *, output_path: str | Path | None = None) -> dict[str, Any]:
    task_path = str(dict(request or {}).get("taskPath") or dict(request or {}).get("task_path") or "").strip()
    payload = resolve_lab_task_request(task_path, overrides=request) if task_path else _normalize_scenario_payload(request)
    scenario_path = Path(output_path).expanduser().resolve() if output_path else _default_scenario_path(payload)
    scenario_path.parent.mkdir(parents=True, exist_ok=True)
    scenario_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return {
        "ok": True,
        "scenario_id": str(payload.get("scenario_id") or ""),
        "ticket_id": str(payload.get("ticket_id") or ""),
        "scenario_path": str(scenario_path),
        "payload": payload,
    }


def solve_lab_scenario(
    scenario_path: str | Path,
    *,
    dispatch_fn: DispatchFn = dispatch_action,
    read_json_fn: ReadJsonFn = _read_json,
) -> dict[str, Any]:
    path = Path(scenario_path).expanduser().resolve()
    payload = _load_required_json(path, label="scenario file")
    return run_lab_task(payload, dispatch_fn=dispatch_fn, read_json_fn=read_json_fn)


def score_lab_result(result: dict[str, Any] | str | Path, *, read_json_fn: ReadJsonFn = _read_json) -> dict[str, Any]:
    summary = result if isinstance(result, dict) else _load_required_json(Path(result).expanduser().resolve(), label="lab result")
    scorecard_path = _resolve_scorecard_path(summary)
    scorecard = read_json_fn(scorecard_path)
    if not scorecard:
        raise LabTaskLaunchError(f"unable to read scorecard: {scorecard_path}")
    container_result = dict(summary.get("container_result") or {})
    return {
        "ok": bool(summary.get("ok", False)),
        "scenario_id": str(summary.get("scenario_id") or scorecard.get("scenario_id") or ""),
        "ticket_id": str(summary.get("ticket_id") or ""),
        "scorecard_path": str(scorecard_path),
        "final_score": int(scorecard.get("final_score", 0) or 0),
        "tests_passed": int(scorecard.get("tests_passed", 0) or 0),
        "tests_failed": int(scorecard.get("tests_failed", 0) or 0),
        "approval_triggered": bool(scorecard.get("approval_triggered", False)),
        "container_exit_code": int(container_result.get("exit_code", 1) or 0),
    }


def store_lab_training_data(
    result: dict[str, Any] | str | Path,
    *,
    output_path: str | Path | None = None,
    read_json_fn: ReadJsonFn = _read_json,
) -> dict[str, Any]:
    summary = result if isinstance(result, dict) else _load_required_json(Path(result).expanduser().resolve(), label="lab result")
    scoring = score_lab_result(summary, read_json_fn=read_json_fn)
    output = _resolve_training_output_path(summary, output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    lab_train = dict(summary.get("lab_train") or {})
    artifact = dict(lab_train.get("artifact") or {})
    training_row = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "scenario_id": scoring["scenario_id"],
        "ticket_id": scoring["ticket_id"],
        "ok": bool(summary.get("ok", False)),
        "final_score": scoring["final_score"],
        "tests_passed": scoring["tests_passed"],
        "tests_failed": scoring["tests_failed"],
        "approval_triggered": scoring["approval_triggered"],
        "container_exit_code": scoring["container_exit_code"],
        "goal": str(artifact.get("runtime_result", {}).get("goal") or artifact.get("goal") or ""),
        "contract_path": str(summary.get("contract_path") or ""),
        "container_result_path": str(summary.get("container_result_path") or ""),
    }
    with output.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(training_row, ensure_ascii=False) + "\n")
    return {
        "ok": True,
        "output_path": str(output),
        "training_row": training_row,
    }


def repeat_lab_task(
    request: dict[str, Any] | str | Path,
    *,
    count: int,
    dispatch_fn: DispatchFn = dispatch_action,
    read_json_fn: ReadJsonFn = _read_json,
) -> dict[str, Any]:
    if count < 1:
        raise LabTaskLaunchError("repeat count must be at least 1")
    if isinstance(request, dict):
        payload = dict(request)
    else:
        payload = _load_required_json(Path(request).expanduser().resolve(), label="scenario file")
    attempts: list[dict[str, Any]] = []
    for index in range(count):
        result = run_lab_task(payload, dispatch_fn=dispatch_fn, read_json_fn=read_json_fn)
        attempts.append({
            "attempt": index + 1,
            "ok": bool(result.get("ok", False)),
            "scenario_id": str(result.get("scenario_id") or ""),
            "ticket_id": str(result.get("ticket_id") or ""),
            "contract_path": str(result.get("contract_path") or ""),
            "container_result_path": str(result.get("container_result_path") or ""),
        })
    return {
        "ok": all(item.get("ok", False) for item in attempts),
        "scenario_id": str(payload.get("scenario_id") or ""),
        "ticket_id": str(payload.get("ticket_id") or ""),
        "count": count,
        "success_count": sum(1 for item in attempts if item.get("ok", False)),
        "failure_count": sum(1 for item in attempts if not item.get("ok", False)),
        "attempts": attempts,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Lab-only launcher for end-to-end training task execution")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--payload-json", help="json payload for the lab task")
    group.add_argument("--task", help="path to a yaml/json task file in the lab repo")
    parser.add_argument("--result-file", help="path for structured json result")
    return parser


def build_command_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Lab-only helper commands for scenario lifecycle management")
    subparsers = parser.add_subparsers(dest="command", required=True)

    generate = subparsers.add_parser("generate-scenario")
    generate_group = generate.add_mutually_exclusive_group(required=True)
    generate_group.add_argument("--payload-json")
    generate_group.add_argument("--task-file")
    generate.add_argument("--scenario-file")

    solve = subparsers.add_parser("solve-scenario")
    solve.add_argument("--scenario-file", required=True)
    solve.add_argument("--result-file")

    run_task = subparsers.add_parser("run-task")
    run_task.add_argument("--task-file", required=True)
    run_task.add_argument("--result-file")

    reset_scenario = subparsers.add_parser("reset-scenario")
    reset_scenario.add_argument("--scenario-path", required=True)
    reset_scenario.add_argument("--output-file")

    reset_task = subparsers.add_parser("reset-task")
    reset_task.add_argument("--task-file", required=True)
    reset_task.add_argument("--output-file")

    clone_task = subparsers.add_parser("clone-task")
    clone_task.add_argument("--task-file", required=True)
    clone_task.add_argument("--new-task-id", required=True)
    clone_task.add_argument("--new-scenario-id")
    clone_task.add_argument("--output-file")

    list_tasks = subparsers.add_parser("list-tasks")
    list_tasks.add_argument("--lab-root", required=True)
    list_tasks.add_argument("--output-file")

    score = subparsers.add_parser("score-result")
    score.add_argument("--result-file", required=True)
    score.add_argument("--output-file")

    store = subparsers.add_parser("store-training-data")
    store.add_argument("--result-file", required=True)
    store.add_argument("--output-file")

    repeat = subparsers.add_parser("repeat")
    repeat.add_argument("--scenario-file", required=True)
    repeat.add_argument("--count", type=int, required=True)
    repeat.add_argument("--output-file")

    return parser


def _emit_payload(payload: dict[str, Any], output_file: str | None = None) -> None:
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

    safe_payload = _json_safe(payload)
    if output_file:
        path = Path(str(output_file)).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(safe_payload, indent=2) + "\n", encoding="utf-8")
    else:
        print(json.dumps(safe_payload))


def _handle_command(argv: list[str]) -> int:
    parser = build_command_parser()
    args = parser.parse_args(argv)
    if args.command == "generate-scenario":
        if args.task_file:
            payload = {"taskPath": str(args.task_file)}
        else:
            payload = json.loads(str(args.payload_json or "{}"))
            if not isinstance(payload, dict):
                raise LabTaskLaunchError("payload json must decode to an object")
        result = generate_lab_scenario(payload, output_path=args.scenario_file)
        _emit_payload(result)
        return 0
    if args.command == "solve-scenario":
        result = solve_lab_scenario(args.scenario_file)
        _emit_payload(result, args.result_file)
        return 0 if result.get("ok") else 1
    if args.command == "score-result":
        result = score_lab_result(args.result_file)
        _emit_payload(result, args.output_file)
        return 0 if result.get("ok") else 1
    if args.command == "run-task":
        result = run_lab_task({"taskPath": str(args.task_file)})
        _emit_payload(result, args.result_file)
        return 0 if result.get("ok") else 1
    if args.command == "reset-scenario":
        result = reset_lab_scenario(args.scenario_path)
        _emit_payload(result, args.output_file)
        return 0
    if args.command == "reset-task":
        result = reset_lab_task_state(args.task_file)
        _emit_payload(result, args.output_file)
        return 0
    if args.command == "clone-task":
        result = clone_lab_task(args.task_file, new_task_id=str(args.new_task_id), new_scenario_id=args.new_scenario_id)
        _emit_payload(result, args.output_file)
        return 0
    if args.command == "list-tasks":
        result = list_lab_tasks(args.lab_root)
        _emit_payload(result, args.output_file)
        return 0
    if args.command == "store-training-data":
        result = store_lab_training_data(args.result_file, output_path=args.output_file)
        _emit_payload(result)
        return 0
    if args.command == "repeat":
        result = repeat_lab_task(args.scenario_file, count=int(args.count or 0))
        _emit_payload(result, args.output_file)
        return 0 if result.get("ok") else 1
    raise LabTaskLaunchError(f"unsupported command: {args.command}")


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and not str(argv[0]).startswith("-"):
        try:
            return _handle_command(argv)
        except (LabTaskLaunchError, RuntimeApiError, json.JSONDecodeError) as exc:
            print(json.dumps({"ok": False, "error": str(exc)}))
            return 1

    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.task:
            payload = {"taskPath": str(args.task)}
        else:
            payload = json.loads(str(args.payload_json or "{}"))
            if not isinstance(payload, dict):
                raise LabTaskLaunchError("payload json must decode to an object")
        result = run_lab_task(payload)
        _emit_payload(result, args.result_file)
        return 0 if result.get("ok") else 1
    except (LabTaskLaunchError, RuntimeApiError, json.JSONDecodeError) as exc:
        error_payload = {"ok": False, "error": str(exc)}
        _emit_payload(error_payload, args.result_file)
        return 1


__all__ = [
    "LabTaskLaunchError",
    "generate_lab_scenario",
    "clone_lab_task",
    "list_lab_tasks",
    "repeat_lab_task",
    "resolve_lab_task_request",
    "reset_lab_scenario",
    "reset_lab_task_state",
    "run_lab_task",
    "score_lab_result",
    "solve_lab_scenario",
    "store_lab_training_data",
]


if __name__ == "__main__":
    raise SystemExit(main())
