from __future__ import annotations

import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.agent.core.baseline_service import analyze_baseline_health, cluster_failures, load_recent_runs
from backend.agent.core.editor_context import normalize_editor_context
from backend.agent.core.repo_inspection import extract_explicit_repo_paths, rank_related_files
from backend.agent.core.storage_paths import assistant_config_validation, assistant_dev_runs_dir, assistant_docs_cache_dir, assistant_docs_import_queue_path, assistant_docs_registry_dir, assistant_runs_dir, assistant_test_artifacts_dir


MAX_RELATED_FILES = 8
MAX_CHANGED_FILES = 20
MAX_FAILURE_CHECKS = 5
MAX_FAILURE_SUMMARY_CHARS = 1200
RUNTIME_CONTEXT_SCHEMA_VERSION = "2026-03-12"

_FAILURE_PATH_PATTERNS = (
    re.compile(r"([A-Za-z]:[\\/][^\s:\"'<>|]+\.[A-Za-z0-9]+)(?::\d+(?::\d+)?)?"),
    re.compile(r"(/[^\s:\"'<>|]+\.[A-Za-z0-9]+)(?::\d+(?::\d+)?)?"),
    re.compile(r"((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)(?::\d+(?::\d+)?)?"),
)


def _empty_runtime_context() -> dict[str, Any]:
    return {
        "schema_version": RUNTIME_CONTEXT_SCHEMA_VERSION,
        "ticket": "",
        "desc": "",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "editor_context": {},
        "active_file_path": "",
        "related_files": [],
        "related_file_details": [],
        "changed_files": [],
        "failure_output": {},
        "validation_scope": {},
        "artifact_context": {},
        "baseline_state": {},
        "approval_state": {},
        "permission_state": {},
        "memory_state": {},
        "docs_state": {},
        "config_state": {},
        "host_boundary": {},
        "self_heal_policy": {},
    }


def _clip_text(value: Any, *, max_chars: int) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "…"


def _display_path(project_root: Path, target: Path) -> str:
    try:
        return str(target.resolve().relative_to(project_root.resolve()))
    except Exception:
        return str(target)


def _normalize_changed_files(project_root: Path) -> list[dict[str, str]]:
    try:
        proc = subprocess.run(
            ["git", "status", "--short"],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            check=False,
        )
    except Exception:
        return []

    changed: list[dict[str, str]] = []
    for raw_line in proc.stdout.splitlines()[:MAX_CHANGED_FILES]:
        line = str(raw_line or "").rstrip()
        if not line:
            continue
        status = line[:2].strip() or "??"
        path = line[3:].strip() if len(line) > 3 else ""
        if path:
            changed.append({"path": path, "status": status})
    return changed


def _normalize_candidate_repo_path(project_root: Path, raw_path: Any) -> str:
    text = str(raw_path or "").strip().rstrip(")]},;.")
    if not text:
        return ""
    normalized = text.replace("\\", "/")
    if normalized.startswith("./"):
        normalized = normalized[2:]
    if re.match(r"^[A-Za-z]:/", normalized) or normalized.startswith("/"):
        try:
            return str(Path(normalized).resolve().relative_to(project_root.resolve())).replace("\\", "/")
        except Exception:
            return ""
    candidate = (project_root / normalized).resolve()
    try:
        relative = candidate.relative_to(project_root.resolve())
    except Exception:
        return ""
    return str(relative).replace("\\", "/") if candidate.exists() else ""


def _failure_output_candidates(project_root: Path, validation: dict[str, Any] | None = None, repair: dict[str, Any] | None = None) -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()
    payloads = [dict(validation or {}), dict(repair or {})]
    texts: list[str] = []

    for payload in payloads:
        for item in list(payload.get("results", []) or []):
            if not isinstance(item, dict) or item.get("ok", False):
                continue
            texts.append(str(item.get("stdout") or ""))
            texts.append(str(item.get("stderr") or ""))
        failure_output = dict(payload.get("failure_output") or payload.get("failureOutput") or {})
        if failure_output:
            texts.append(str(failure_output.get("summary") or ""))
            for item in list(failure_output.get("checks", []) or []):
                if not isinstance(item, dict):
                    continue
                texts.append(str(item.get("stdout") or ""))
                texts.append(str(item.get("stderr") or ""))
        for item in list(payload.get("repairs", []) or []):
            if not isinstance(item, dict):
                continue
            normalized = _normalize_candidate_repo_path(project_root, item.get("path"))
            if normalized and normalized not in seen:
                seen.add(normalized)
                candidates.append(normalized)

    for text in texts:
        for pattern in _FAILURE_PATH_PATTERNS:
            for match in pattern.findall(text):
                normalized = _normalize_candidate_repo_path(project_root, match)
                if not normalized or normalized in seen:
                    continue
                seen.add(normalized)
                candidates.append(normalized)
    return candidates


def _repair_focused_editor_context(
    project_root: Path,
    editor_context: dict[str, Any] | None,
    *,
    validation: dict[str, Any] | None = None,
    repair: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    normalized = normalize_editor_context(editor_context)
    failure_candidates = _failure_output_candidates(project_root, validation=validation, repair=repair)
    if not failure_candidates or str(normalized.get("active_file_path") or "").strip():
        return normalized, failure_candidates

    focused = dict(normalized)
    focused["active_file_path"] = failure_candidates[0]
    open_files = [str(item).strip() for item in list(focused.get("open_files") or []) if str(item).strip()]
    focused["open_files"] = [failure_candidates[0], *[item for item in open_files if item != failure_candidates[0]]]
    return focused, failure_candidates


def _candidate_related_files(
    project_root: Path,
    plan: dict[str, Any] | None,
    editor_context: dict[str, Any],
    *,
    desc: str = "",
    validation: dict[str, Any] | None = None,
    repair: dict[str, Any] | None = None,
) -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()
    payload = dict(plan or {})

    def add_candidate(raw_path: Any, *, front: bool = False) -> None:
        text = _normalize_candidate_repo_path(project_root, raw_path)
        if not text or text in seen:
            return
        seen.add(text)
        if front:
            candidates.insert(0, text)
        else:
            candidates.append(text)

    for path in payload.get("existing_targets", []) or []:
        add_candidate(path)
    for path in payload.get("proposed_files", []) or []:
        text = str(path or "").strip()
        if text and "*" not in text:
            add_candidate(text)
    for item in payload.get("new_files", []) or []:
        add_candidate(item.get("path") if isinstance(item, dict) else item)
    for path in _failure_output_candidates(project_root, validation=validation, repair=repair):
        add_candidate(path, front=True)
    for path in reversed(extract_explicit_repo_paths(project_root, desc, require_exists=True, limit=5)):
        add_candidate(path, front=True)
    active_file = str(editor_context.get("active_file_path") or "").strip()
    if active_file:
        add_candidate(active_file, front=True)
    return candidates


def _normalize_related_files(
    project_root: Path,
    *,
    ticket_id: str = "",
    desc: str = "",
    editor_context: dict[str, Any] | None = None,
    plan: dict[str, Any] | None = None,
    validation: dict[str, Any] | None = None,
    repair: dict[str, Any] | None = None,
) -> tuple[list[str], list[dict[str, Any]]]:
    normalized_editor, _ = _repair_focused_editor_context(
        project_root,
        editor_context,
        validation=validation,
        repair=repair,
    )
    candidates = _candidate_related_files(
        project_root,
        plan,
        normalized_editor,
        desc=desc,
        validation=validation,
        repair=repair,
    )
    ranked = rank_related_files(
        project_root,
        candidates=candidates or None,
        query=" ".join(part for part in (ticket_id, desc) if part),
        editor_context=normalized_editor,
        limit=MAX_RELATED_FILES,
    )
    if not ranked and candidates:
        ranked = [{"path": path, "score": 0, "reasons": ["plan-target"]} for path in candidates[:MAX_RELATED_FILES]]
    return [str(item.get("path") or "") for item in ranked if str(item.get("path") or "")], ranked


def _normalize_failure_checks(validation: dict[str, Any] | None) -> list[dict[str, Any]]:
    payload = dict(validation or {})
    failures: list[dict[str, Any]] = []
    for item in list(payload.get("results", []) or [])[:MAX_FAILURE_CHECKS]:
        if not isinstance(item, dict) or item.get("ok", False):
            continue
        failures.append(
            {
                "command": str(item.get("command") or ""),
                "returncode": int(item.get("returncode") or 0),
                "stdout": _clip_text(item.get("stdout"), max_chars=MAX_FAILURE_SUMMARY_CHARS),
                "stderr": _clip_text(item.get("stderr"), max_chars=MAX_FAILURE_SUMMARY_CHARS),
            }
        )
    return failures


def _normalize_failure_output(validation: dict[str, Any] | None, repair: dict[str, Any] | None) -> dict[str, Any]:
    payload = dict(validation or {})
    repair_payload = dict(repair or {})
    checks = _normalize_failure_checks(payload)
    fingerprints = [
        {
            "label": str(item.get("label") or ""),
            "blocking": bool(item.get("blocking", False)),
            "summary": str(item.get("summary") or ""),
        }
        for item in list(payload.get("fingerprints", []) or [])
        if isinstance(item, dict)
    ]
    summary = ""
    if fingerprints:
        summary = str(fingerprints[0].get("summary") or "")
    elif checks:
        summary = checks[0].get("stderr") or checks[0].get("stdout") or checks[0].get("command") or ""
    if repair_payload.get("skip_reason") and not summary:
        summary = str(repair_payload.get("skip_reason") or "")
    return {
        "summary": _clip_text(summary, max_chars=280),
        "checks": checks,
        "fingerprints": fingerprints,
        "retry_policy": dict(payload.get("retry_policy") or repair_payload.get("retry_policy") or {}),
        "repair_skipped": bool(repair_payload.get("skipped", False)),
        "skip_reason": str(repair_payload.get("skip_reason") or ""),
    }


def _normalize_validation_scope(
    validation: dict[str, Any] | None,
    repair: dict[str, Any] | None,
    *,
    previous_scope: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = dict(validation or {})
    repair_payload = dict(repair or {})
    previous = dict(previous_scope or {})
    commands = [str(item).strip() for item in list(payload.get("commands", []) or []) if str(item).strip()]
    if not commands:
        commands = [str(item).strip() for item in list((repair_payload.get("validation") or {}).get("commands", []) or []) if str(item).strip()]
    scope = [str(item).strip() for item in list(payload.get("scope", []) or []) if str(item).strip()]
    if not scope:
        scope = [str(item).strip() for item in list((repair_payload.get("validation") or {}).get("scope", []) or []) if str(item).strip()]
    related_targets = [str(item).strip() for item in list(payload.get("related_targets", []) or payload.get("relatedTargets", []) or []) if str(item).strip()]
    if not related_targets:
        related_targets = [str(item).strip() for item in list((repair_payload.get("validation") or {}).get("related_targets", []) or (repair_payload.get("validation") or {}).get("relatedTargets", []) or []) if str(item).strip()]
    full_verify = bool(payload.get("full_verify") or payload.get("fullVerify"))
    if not commands and previous:
        commands = [str(item).strip() for item in list(previous.get("commands", []) or []) if str(item).strip()]
        if not scope:
            scope = [str(item).strip() for item in list(previous.get("scope", []) or []) if str(item).strip()]
        if not related_targets:
            related_targets = [str(item).strip() for item in list(previous.get("related_targets", []) or previous.get("relatedTargets", []) or []) if str(item).strip()]
        full_verify = bool(previous.get("full_verify") or previous.get("fullVerify") or full_verify)
    source = "none"
    if commands:
        source = "full-verify" if full_verify else "targeted"
    return {
        "commands": commands,
        "command_count": len(commands),
        "scope": scope,
        "related_targets": related_targets,
        "full_verify": full_verify,
        "source": source,
    }


def _latest_artifact_path(project_root: Path, root: Path) -> str:
    if not root.exists():
        return ""
    files = [path for path in root.glob("*") if path.is_file()]
    if not files:
        return ""
    files.sort(key=lambda item: item.stat().st_mtime, reverse=True)
    return _display_path(project_root, files[0])


def _normalize_artifact_context(project_root: Path, artifact_paths: list[str] | None = None) -> dict[str, Any]:
    referenced = [str(path).strip() for path in (artifact_paths or []) if str(path).strip()]
    return {
        "referenced_paths": referenced,
        "latest_run_artifact": _latest_artifact_path(project_root, assistant_dev_runs_dir(project_root)),
        "latest_summary_artifact": _latest_artifact_path(project_root, assistant_runs_dir(project_root)),
        "latest_test_artifact": _latest_artifact_path(project_root, assistant_test_artifacts_dir(project_root)),
    }


def _normalize_baseline_state(project_root: Path) -> dict[str, Any]:
    recent_runs = load_recent_runs(project_root)
    clusters = cluster_failures(recent_runs)
    baseline = analyze_baseline_health(recent_runs, clusters)
    hotspot = baseline.get("hotspot") if isinstance(baseline, dict) else None
    return {
        "state": str((baseline or {}).get("state") or "green"),
        "blocked": bool((baseline or {}).get("blocked", False)),
        "reason": str((baseline or {}).get("reason") or ""),
        "recent_failure_count": int((baseline or {}).get("recentFailureCount") or 0),
        "cluster_count": int((baseline or {}).get("clusterCount") or 0),
        "hotspot": {
            "family": str((hotspot or {}).get("family") or ""),
            "summary": str((hotspot or {}).get("summary") or ""),
            "path_hint": str((hotspot or {}).get("path_hint") or ""),
            "shared_root": bool((hotspot or {}).get("shared_root", False)),
        } if isinstance(hotspot, dict) else {},
    }




def _normalize_docs_state(project_root: Path) -> dict[str, Any]:
    registry_dir = assistant_docs_registry_dir(project_root)
    cache_dir = assistant_docs_cache_dir(project_root)
    queue_path = assistant_docs_import_queue_path(project_root)
    queue_count = 0
    if queue_path.exists():
        try:
            import json
            payload = json.loads(queue_path.read_text(encoding="utf-8"))
            if isinstance(payload, list):
                queue_count = len(payload)
            elif isinstance(payload, dict) and isinstance(payload.get('items'), list):
                queue_count = len(payload.get('items') or [])
        except Exception:
            queue_count = 0
    return {
        'registry_path': _display_path(project_root, registry_dir),
        'cache_path': _display_path(project_root, cache_dir),
        'queue_path': _display_path(project_root, queue_path),
        'registry_exists': registry_dir.exists(),
        'cache_exists': cache_dir.exists(),
        'queue_exists': queue_path.exists(),
        'queue_count': queue_count,
    }


def _normalize_config_state(project_root: Path) -> dict[str, Any]:
    return dict(assistant_config_validation(project_root) or {})


def _stable_runtime_sections(project_root: Path, previous_context: dict[str, Any] | None = None) -> dict[str, Any]:
    previous = normalize_runtime_context(previous_context)
    baseline_state = dict(previous.get("baseline_state") or previous.get("baselineState") or {})
    docs_state = dict(previous.get("docs_state") or previous.get("docsState") or {})
    config_state = dict(previous.get("config_state") or previous.get("configState") or {})
    return {
        "baseline_state": baseline_state or _normalize_baseline_state(project_root),
        "docs_state": docs_state or _normalize_docs_state(project_root),
        "config_state": config_state or _normalize_config_state(project_root),
    }

def normalize_runtime_context(raw: dict[str, Any] | None) -> dict[str, Any]:
    payload = dict(raw or {})
    editor_context = normalize_editor_context(payload.get("editor_context") or payload.get("editorContext") or payload.get("editor") or {})
    related_details = [
        {
            "path": str(item.get("path") or ""),
            "score": int(item.get("score") or 0),
            "reasons": [str(reason) for reason in list(item.get("reasons", []) or []) if str(reason)],
        }
        for item in list(payload.get("related_file_details", []) or payload.get("relatedFilesDetailed", []) or [])
        if isinstance(item, dict) and str(item.get("path") or "")
    ][:MAX_RELATED_FILES]
    related_files = [str(path).strip() for path in list(payload.get("related_files", []) or []) if str(path).strip()][:MAX_RELATED_FILES]
    if not related_files and related_details:
        related_files = [item["path"] for item in related_details]
    changed_files = [
        {
            "path": str(item.get("path") or ""),
            "status": str(item.get("status") or ""),
        }
        for item in list(payload.get("changed_files", []) or payload.get("changedFiles", []) or [])
        if isinstance(item, dict) and str(item.get("path") or "")
    ][:MAX_CHANGED_FILES]
    normalized = _empty_runtime_context()
    normalized.update({
        "schema_version": str(payload.get("schema_version") or payload.get("schemaVersion") or RUNTIME_CONTEXT_SCHEMA_VERSION),
        "ticket": str(payload.get("ticket") or ""),
        "desc": str(payload.get("desc") or ""),
        "generated_at": str(payload.get("generated_at") or payload.get("generatedAt") or datetime.now(timezone.utc).isoformat()),
        "editor_context": editor_context,
        "active_file_path": str(editor_context.get("active_file_path") or payload.get("active_file_path") or ""),
        "related_files": related_files,
        "related_file_details": related_details,
        "changed_files": changed_files,
        "failure_output": dict(payload.get("failure_output") or payload.get("failureOutput") or {}),
        "validation_scope": dict(payload.get("validation_scope") or payload.get("validationScope") or {}),
        "artifact_context": dict(payload.get("artifact_context") or payload.get("artifactContext") or {}),
        "baseline_state": dict(payload.get("baseline_state") or payload.get("baselineState") or {}),
        "approval_state": dict(payload.get("approval_state") or payload.get("approvalState") or {}),
        "permission_state": dict(payload.get("permission_state") or payload.get("permissionState") or {}),
        "memory_state": dict(payload.get("memory_state") or payload.get("memoryState") or {}),
        "docs_state": dict(payload.get("docs_state") or payload.get("docsState") or {}),
        "config_state": dict(payload.get("config_state") or payload.get("configState") or {}),
        "host_boundary": dict(payload.get("host_boundary") or payload.get("hostBoundary") or {}),
        "self_heal_policy": dict(payload.get("self_heal_policy") or payload.get("selfHealPolicy") or {}),
    })
    return normalized


def build_runtime_context(
    project_root: Path,
    *,
    ticket_id: str = "",
    desc: str = "",
    editor_context: dict[str, Any] | None = None,
    plan: dict[str, Any] | None = None,
    validation: dict[str, Any] | None = None,
    repair: dict[str, Any] | None = None,
    artifact_paths: list[str] | None = None,
    approval_state: dict[str, Any] | None = None,
    permission_state: dict[str, Any] | None = None,
    memory_state: dict[str, Any] | None = None,
    host_boundary: dict[str, Any] | None = None,
    self_heal_policy: dict[str, Any] | None = None,
    previous_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    previous = normalize_runtime_context(previous_context)
    stable_sections = _stable_runtime_sections(project_root, previous)
    normalized_editor, failure_candidates = _repair_focused_editor_context(
        project_root,
        editor_context,
        validation=validation,
        repair=repair,
    )
    related_files, related_details = _normalize_related_files(
        project_root,
        ticket_id=ticket_id,
        desc=desc,
        editor_context=normalized_editor,
        plan=plan,
        validation=validation,
        repair=repair,
    )
    return normalize_runtime_context(
        {
            "schema_version": RUNTIME_CONTEXT_SCHEMA_VERSION,
            "ticket": ticket_id,
            "desc": desc,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "editor_context": normalized_editor,
            "active_file_path": normalized_editor.get("active_file_path", "") or (failure_candidates[0] if failure_candidates else ""),
            "related_files": related_files,
            "related_file_details": related_details,
            "changed_files": _normalize_changed_files(project_root),
            "failure_output": _normalize_failure_output(validation, repair),
            "validation_scope": _normalize_validation_scope(validation, repair, previous_scope=previous.get("validation_scope") or previous.get("validationScope") or {}),
            "artifact_context": _normalize_artifact_context(project_root, artifact_paths=artifact_paths),
            "baseline_state": stable_sections["baseline_state"],
            "approval_state": dict(approval_state or {}),
            "permission_state": dict(permission_state or {}),
            "memory_state": dict(memory_state or {}),
            "docs_state": stable_sections["docs_state"],
            "config_state": stable_sections["config_state"],
            "host_boundary": dict(host_boundary or {}),
            "self_heal_policy": dict(self_heal_policy or {}),
        }
    )


def extract_runtime_context(context: dict[str, Any] | None) -> dict[str, Any]:
    payload = dict(context or {})
    if "runtime_context" in payload and isinstance(payload.get("runtime_context"), dict):
        return normalize_runtime_context(payload.get("runtime_context"))
    if "runtimeContext" in payload and isinstance(payload.get("runtimeContext"), dict):
        return normalize_runtime_context(payload.get("runtimeContext"))
    return normalize_runtime_context(payload)


__all__ = [
    "RUNTIME_CONTEXT_SCHEMA_VERSION",
    "build_runtime_context",
    "extract_runtime_context",
    "normalize_runtime_context",
]