from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Any

from backend.agent.core.storage_paths import assistant_dev_runs_dir, assistant_log_path, assistant_runs_dir, assistant_training_output_path


def should_trigger_training(config: dict[str, Any], run_mode: str | None, args: Any) -> bool:
    auto_train = bool(config.get("autopilot_auto_train", False))
    return bool(getattr(args, "train", False) or (auto_train and run_mode in {"autopilot", "batch", "scheduled"}))


def build_training_command(
    project_root: Path,
    *,
    openai: bool = False,
    fine_tune_model: str | None = None,
    local_export_format: str | None = None,
    local_base_model: str | None = None,
    min_examples: int | None = None,
    min_log_examples: int | None = None,
    min_artifact_examples: int | None = None,
    fail_on_quality_gate: bool = False,
) -> list[str]:
    output_path = assistant_training_output_path(project_root)
    cmd = [
        sys.executable,
        "backend/scripts/train_dev_assistant.py",
        "--output",
        str(output_path),
        "--log",
        str(assistant_log_path(project_root)),
        "--runs-dir",
        str(assistant_runs_dir(project_root)),
        "--runs-dir",
        str(assistant_dev_runs_dir(project_root)),
        "--assistant-only",
    ]
    if min_examples is not None:
        cmd.extend(["--min-examples", str(int(min_examples))])
    if min_log_examples is not None:
        cmd.extend(["--min-log-examples", str(int(min_log_examples))])
    if min_artifact_examples is not None:
        cmd.extend(["--min-artifact-examples", str(int(min_artifact_examples))])
    if fail_on_quality_gate:
        cmd.append("--fail-on-quality-gate")
    if openai:
        cmd.append("--openai")
    if fine_tune_model:
        cmd.extend(["--fine-tune-model", fine_tune_model])
    if local_export_format:
        cmd.extend(["--local-export-format", local_export_format])
    if local_base_model:
        cmd.extend(["--local-base-model", local_base_model])
    return cmd


def run_training(project_root: Path, config: dict[str, Any], args: Any, run_mode: str | None) -> dict[str, Any]:
    should_run = should_trigger_training(config, run_mode, args)
    if not should_run:
        return {"ok": True, "triggered": False, "command": []}
    cmd = build_training_command(
        project_root,
        openai=bool(getattr(args, "openai", False)),
        fine_tune_model=getattr(args, "fine_tune_model", None),
        min_examples=int(config.get("assistant_training_min_examples", 2) or 2),
        min_log_examples=int(config.get("assistant_training_min_log_examples", 1) or 1),
        min_artifact_examples=int(config.get("assistant_training_min_artifact_examples", 1) or 1),
        fail_on_quality_gate=bool(config.get("assistant_training_fail_on_quality_gate", False)),
    )
    proc = subprocess.run(cmd, cwd=str(project_root), capture_output=True, text=True, check=False)
    return {
        "ok": proc.returncode == 0,
        "triggered": True,
        "command": cmd,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "returncode": proc.returncode,
    }