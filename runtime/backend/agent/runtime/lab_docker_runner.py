from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Sequence


class LabDockerContractError(RuntimeError):
    pass


def load_container_contract(contract_path: str | Path) -> dict[str, Any]:
    path = Path(contract_path).expanduser().resolve()
    if not path.exists() or not path.is_file():
        raise LabDockerContractError(f"container contract not found: {path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise LabDockerContractError(f"invalid container contract json: {path}") from exc
    if not isinstance(payload, dict):
        raise LabDockerContractError(f"container contract must decode to an object: {path}")
    if str(payload.get("kind") or "") != "docker-lab-contract":
        raise LabDockerContractError(f"unsupported container contract kind: {payload.get('kind')}")
    payload["contract_path"] = str(path)
    return payload


def build_docker_run_args(contract: dict[str, Any], *, docker_command: str = "docker") -> list[str]:
    image = str(contract.get("image") or "").strip()
    if not image:
        raise LabDockerContractError("container contract is missing image")

    args: list[str] = [docker_command, "run", "--rm"]

    working_dir = str(contract.get("working_dir") or "").strip()
    if working_dir:
        args.extend(["-w", working_dir])

    for mount_key in ("workspace_mount", "artifact_mount", "repo_mount"):
        mount = dict(contract.get(mount_key) or {})
        source = str(mount.get("source") or "").strip()
        target = str(mount.get("target") or "").strip()
        mode = str(mount.get("mode") or "rw").strip() or "rw"
        if source and target:
            args.extend(["-v", f"{source}:{target}:{mode}"])

    environment = dict(contract.get("environment") or {})
    for key in sorted(environment):
        value = environment[key]
        args.extend(["-e", f"{key}={value}"])

    args.append(image)

    command = list(contract.get("command") or [])
    if not command:
        raise LabDockerContractError("container contract is missing command")
    args.extend(str(item) for item in command)
    return args


def _default_runner(command: Sequence[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, text=True, check=False, **kwargs)


def _write_run_result(contract_path: Path, payload: dict[str, Any]) -> Path:
    output_path = contract_path.with_name("container_run_result.json")
    output_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return output_path


def run_lab_container_contract(
    contract_path: str | Path,
    *,
    docker_command: str = "docker",
    runner: Callable[..., Any] = _default_runner,
    timeout: int | None = None,
) -> dict[str, Any]:
    contract = load_container_contract(contract_path)
    resolved_contract_path = Path(str(contract.get("contract_path") or contract_path)).resolve()
    docker_args = build_docker_run_args(contract, docker_command=docker_command)

    artifact_mount = dict(contract.get("artifact_mount") or {})
    artifact_source = str(artifact_mount.get("source") or "").strip()
    if artifact_source:
        Path(artifact_source).mkdir(parents=True, exist_ok=True)

    run_result = runner(docker_args, timeout=timeout)
    payload = {
        "ok": int(getattr(run_result, "returncode", 1) or 0) == 0,
        "kind": "docker-lab-run-result",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "contract_path": str(resolved_contract_path),
        "image": str(contract.get("image") or ""),
        "command": list(docker_args),
        "exit_code": int(getattr(run_result, "returncode", 1) or 0),
        "stdout": str(getattr(run_result, "stdout", "") or ""),
        "stderr": str(getattr(run_result, "stderr", "") or ""),
        "scenario_id": str(contract.get("scenario_id") or ""),
        "ticket_id": str(contract.get("ticket_id") or ""),
    }
    result_path = _write_run_result(resolved_contract_path, payload)
    return {
        **payload,
        "result_path": str(result_path),
    }


__all__ = [
    "LabDockerContractError",
    "build_docker_run_args",
    "load_container_contract",
    "run_lab_container_contract",
]
