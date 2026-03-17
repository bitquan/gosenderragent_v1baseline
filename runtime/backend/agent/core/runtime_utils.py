from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any


def extract_deps_from_desc(desc: str) -> list[str]:
    return re.findall(r"\bDEP:([A-Z0-9_-]+)\b", str(desc or "").upper())


def run_mode(args: Any) -> str:
    if getattr(args, "autopilot", False):
        return "scheduled" if getattr(args, "schedule", None) else "autopilot"
    if getattr(args, "batch", False):
        return "batch"
    if getattr(args, "schedule", None):
        return "scheduled"
    if getattr(args, "pilot", False):
        return "pilot"
    return "manual"


def confidence_score(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value or "").strip().lower()
    if text == "high":
        return 1.0
    if text == "medium":
        return 0.8
    if text == "low":
        return 0.2
    try:
        return float(text)
    except Exception:
        return 0.0


def diff_text(project_root: Path, created: list[str]) -> str:
    if not created:
        return ""
    try:
        return subprocess.check_output(["git", "diff", "HEAD~1", "HEAD", "--", *created], cwd=str(project_root), text=True, stderr=subprocess.DEVNULL)
    except Exception:
        try:
            return subprocess.check_output(["git", "diff", "--", *created], cwd=str(project_root), text=True, stderr=subprocess.DEVNULL)
        except Exception:
            return ""


def json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): json_safe(val) for key, val in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    if hasattr(value, "__dict__"):
        return json_safe(vars(value))
    return value
