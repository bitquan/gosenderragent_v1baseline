from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Any


def should_trigger_training(config: dict[str, Any], run_mode: str | None, args: Any) -> bool:
    auto_train = bool(config.get("autopilot_auto_train", False))
    return bool(getattr(args, "train", False) or (auto_train and run_mode in {"autopilot", "batch", "scheduled"}))


def build_training_command(project_root: Path, *, openai: bool = False, fine_tune_model: str | None = None) -> list[str]:
    del project_root
    cmd = [sys.executable, "backend/scripts/train_dev_assistant.py", "--output", "scripts/dev_assistant_training.jsonl"]
    if openai:
        cmd.append("--openai")
    if fine_tune_model:
        cmd.extend(["--fine-tune-model", fine_tune_model])
    return cmd


def run_training(project_root: Path, config: dict[str, Any], args: Any, run_mode: str | None) -> dict[str, Any]:
    should_run = should_trigger_training(config, run_mode, args)
    if not should_run:
        return {"ok": True, "triggered": False, "command": []}
    cmd = build_training_command(project_root, openai=bool(getattr(args, "openai", False)), fine_tune_model=getattr(args, "fine_tune_model", None))
    proc = subprocess.run(cmd, cwd=str(project_root), capture_output=True, text=True, check=False)
    return {
        "ok": proc.returncode == 0,
        "triggered": True,
        "command": cmd,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "returncode": proc.returncode,
    }