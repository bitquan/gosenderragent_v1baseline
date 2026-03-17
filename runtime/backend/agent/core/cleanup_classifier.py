from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Any


ENGINE_OWNED_PREFIXES = (
    "backend/agent/",
    "backend/scripts/",
    "backend/tests/",
    "core/",
    "shared-runtime/",
    "shared-ui/",
    "host/",
    "renderer/",
    "scripts/",
    "tests/",
    "runtime/backend/",
    "tools/gosenderr-desktop-agent/",
    "tools/vscode-dev-assistant-extension/",
    "docs/",
    "tmp/",
)
TEMP_SEGMENTS = {"tmp", "temp", "__pycache__", ".pytest_cache"}
TEMP_SUFFIXES = {".tmp", ".temp", ".bak", ".old", ".orig", ".rej", ".pyc", ".pyo"}
TEMP_PREFIXES = ("tmp_", "temp_", "debug_")
HELPER_TOKENS = {"helper", "helpers", "util", "utils", "bridge", "adapter", "core"}


def _normalize_repo_path(path: Any) -> str:
    raw = str(path or "").strip().replace("\\", "/")
    while raw.startswith("./"):
        raw = raw[2:]
    return raw


def _is_engine_owned(path: str) -> bool:
    normalized = _normalize_repo_path(path)
    return any(normalized.startswith(prefix) for prefix in ENGINE_OWNED_PREFIXES)


def _touched_paths(execution: dict[str, Any], repair: dict[str, Any]) -> list[str]:
    seen: set[str] = set()
    paths: list[str] = []
    for item in list(execution.get("results", []) or []):
        if not isinstance(item, dict):
            continue
        normalized = _normalize_repo_path(item.get("path"))
        if normalized and normalized not in seen:
            seen.add(normalized)
            paths.append(normalized)
    for item in list(execution.get("created", []) or []):
        normalized = _normalize_repo_path(item)
        if normalized and normalized not in seen:
            seen.add(normalized)
            paths.append(normalized)
    for item in list(repair.get("repairs", []) or []):
        if not isinstance(item, dict):
            continue
        normalized = _normalize_repo_path(item.get("path"))
        if normalized and normalized not in seen:
            seen.add(normalized)
            paths.append(normalized)
    return [path for path in paths if _is_engine_owned(path)]


def _is_temp_artifact_candidate(path: str) -> bool:
    normalized = _normalize_repo_path(path)
    target = Path(normalized)
    if normalized.startswith("tmp/"):
        return True
    if target.suffix.lower() in TEMP_SUFFIXES:
        return True
    if any(part.lower() in TEMP_SEGMENTS for part in target.parts):
        return True
    return target.name.lower().startswith(TEMP_PREFIXES)


def _is_helper_module(path: str) -> bool:
    target = Path(_normalize_repo_path(path))
    name_tokens = {token for token in target.stem.lower().replace("-", "_").split("_") if token}
    parent_tokens = {token.lower() for token in target.parts}
    return bool(name_tokens & HELPER_TOKENS or parent_tokens & HELPER_TOKENS)


def _duplicate_helper_candidates(project_root: Path, touched_paths: list[str]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for path in touched_paths:
        if not _is_helper_module(path):
            continue
        target = Path(project_root, path)
        file_name = target.name
        if not file_name:
            continue
        duplicate_paths = sorted(
            {
                _normalize_repo_path(match.relative_to(project_root))
                for match in project_root.rglob(file_name)
                if match.is_file()
                and match != target
                and _is_engine_owned(match.relative_to(project_root))
            }
        )
        if not duplicate_paths:
            continue
        candidates.append(
            {
                "kind": "duplicate-helper-module",
                "path": path,
                "candidate_paths": duplicate_paths,
                "risk": "low",
                "reason": f"matching helper/module filename also exists in {len(duplicate_paths)} engine-owned path(s)",
            }
        )
    return candidates


def build_cleanup_candidate_summary(
    *,
    project_root: Path,
    execution: dict[str, Any] | None = None,
    repair: dict[str, Any] | None = None,
) -> dict[str, Any]:
    touched_paths = _touched_paths(dict(execution or {}), dict(repair or {}))
    candidates: list[dict[str, Any]] = []
    for path in touched_paths:
        if _is_temp_artifact_candidate(path):
            candidates.append(
                {
                    "kind": "temp-artifact",
                    "path": path,
                    "candidate_paths": [path],
                    "risk": "low",
                    "reason": "path looks like a temporary or stale generated artifact",
                }
            )
    candidates.extend(_duplicate_helper_candidates(project_root, touched_paths))
    counter = Counter(str(item.get("kind") or "unknown") for item in candidates)
    summary_parts: list[str] = []
    if counter.get("duplicate-helper-module"):
        summary_parts.append(f"{counter['duplicate-helper-module']} duplicate helper/module candidate(s)")
    if counter.get("temp-artifact"):
        summary_parts.append(f"{counter['temp-artifact']} temp artifact candidate(s)")
    return {
        "candidate_count": len(candidates),
        "touched_path_count": len(touched_paths),
        "safe_delete_candidate_count": int(counter.get("temp-artifact", 0)),
        "duplicate_helper_candidate_count": int(counter.get("duplicate-helper-module", 0)),
        "candidates": candidates,
        "summary": "; ".join(summary_parts) if summary_parts else "no cleanup candidates detected in current touched paths",
    }


def apply_cleanup_write_gate(write_gate: dict[str, Any] | None, cleanup_summary: dict[str, Any] | None) -> dict[str, Any]:
    payload = dict(write_gate or {})
    summary = dict(cleanup_summary or {})
    duplicate_helper_candidate_count = int(summary.get("duplicate_helper_candidate_count") or 0)
    if not payload.get("requested_write") or duplicate_helper_candidate_count <= 0:
        return payload
    result = dict(payload)
    result["requires_confirmation"] = True
    result["allow_write"] = False
    result["downgraded_to_preview"] = True
    result["cleanup_gate_triggered"] = True
    result["cleanup_gate_reason_code"] = "duplicate-helper-candidate"
    result["cleanup_candidate_count"] = int(summary.get("candidate_count") or 0)
    result["cleanup_duplicate_helper_candidate_count"] = duplicate_helper_candidate_count
    result["reason"] = (
        f"cleanup write requires confirmation: duplicate helper/module candidates detected ({duplicate_helper_candidate_count})"
    )
    return result
