from __future__ import annotations

import re
import shlex
import subprocess
from pathlib import Path
from typing import Any

from backend.agent.core.adapters.base import RepoAdapter
from backend.agent.core.failure_taxonomy import describe_failure_label, summarize_failure_taxonomy
from backend.agent.core.memory_service import summarize_test_signal_patterns
from backend.agent.core.strategies.catalog import get_strategy


MISSING_FIXTURE_CLIENT_RE = re.compile(r"(?:missing fixture|fixture) ['\"]client['\"] (?:not found)?|fixture ['\"]client['\"] not found", re.IGNORECASE)
UNRELATED_SELECTION_RE = re.compile(r"blocked by unrelated failing test selection", re.IGNORECASE)
MIGRATION_REVISION_RE = re.compile(r"(can't locate revision|revision .* not present|alembic.*revision)", re.IGNORECASE)
IMPORT_SETUP_RE = re.compile(r"(ImportError|ModuleNotFoundError|cannot import name|No module named)", re.IGNORECASE)
ASSERTION_RE = re.compile(r"AssertionError|\bassert\b", re.IGNORECASE)
TRACEBACK_PATH_RE = re.compile(r"([\w./-]+\.(?:py|ts|tsx|js|jsx))")
MODULE_HINT_RE = re.compile(r"No module named ['\"]([A-Za-z_][\w.]*)['\"]", re.IGNORECASE)


def classify_validation_fingerprint(command: str, stdout: str, stderr: str) -> dict[str, Any]:
    combined = "\n".join([str(stderr or ""), str(stdout or "")]).strip()
    summary = combined.splitlines()[0].strip() if combined else "validation failure"
    label = "generic-validation-failure"
    retry_strategy = "repair"
    blocking = False
    path_hints = sorted({str(item) for item in TRACEBACK_PATH_RE.findall(combined) if str(item).strip()})
    module_hints = sorted({str(item) for item in MODULE_HINT_RE.findall(combined) if str(item).strip()})
    target_bias = "mixed"

    if MISSING_FIXTURE_CLIENT_RE.search(combined):
        label = "missing-fixture-client"
        retry_strategy = "handoff"
        blocking = True
        summary = "baseline setup failure: missing fixture 'client'"
        target_bias = "test-support"
    elif UNRELATED_SELECTION_RE.search(combined):
        label = "unrelated-failing-test-selection"
        retry_strategy = "rescope"
        blocking = True
        summary = "blocked by unrelated failing test selection"
    elif MIGRATION_REVISION_RE.search(combined):
        label = "migration-revision-missing"
        retry_strategy = "handoff"
        blocking = True
        summary = "baseline migration revision mismatch"
    elif IMPORT_SETUP_RE.search(combined):
        label = "import-setup-failure"
        retry_strategy = "handoff"
        blocking = True
        summary = "import or dependency setup failure"
        target_bias = "import-repair"
    elif ASSERTION_RE.search(combined):
        label = "assertion-failure"
        retry_strategy = "repair"
        summary = summary or "assertion failure"
        target_bias = "source"

    descriptor = describe_failure_label(label, summary=summary)

    return {
        "label": label,
        "summary": summary,
        "command": str(command or ""),
        "retry_strategy": retry_strategy,
        "blocking": blocking,
        "path_hints": path_hints,
        "module_hints": module_hints,
        "target_bias": target_bias,
        "failure_family": str(descriptor.get("failure_family") or ""),
        "repair_reason_code": str(descriptor.get("repair_reason_code") or ""),
        "operator_action": str(descriptor.get("operator_action") or ""),
    }


def fingerprint_validation_results(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    fingerprints: list[dict[str, Any]] = []
    for result in results:
        if result.get("ok", False):
            continue
        fingerprints.append(
            classify_validation_fingerprint(
                str(result.get("command") or ""),
                str(result.get("stdout") or ""),
                str(result.get("stderr") or ""),
            )
        )
    return fingerprints


def recommend_retry_policy(
    fingerprints: list[dict[str, Any]],
    *,
    baseline_state: dict[str, Any] | None = None,
    failure_memory: dict[str, Any] | None = None,
    runtime_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    def _policy(action: str, reason: str, *, max_attempts: int, cooldown_seconds: int) -> dict[str, Any]:
        return {
            "action": action,
            "reason": reason,
            "max_attempts": int(max_attempts),
            "cooldown_seconds": int(cooldown_seconds),
            "baseline_self_heal_priority": False,
            "self_heal_reason": "",
        }

    baseline = dict(baseline_state or {})
    memory = dict(failure_memory or {})
    context = dict(runtime_context or {})

    host_boundary = dict(context.get("host_boundary") or context.get("hostBoundary") or {})
    is_lab_mode = str(host_boundary.get("host_kind") or host_boundary.get("hostKind") or "").strip().lower() == "lab"

    def _apply_self_heal(policy: dict[str, Any], reason: str) -> dict[str, Any]:
        if not reason:
            return policy
        updated = dict(policy)
        updated["baseline_self_heal_priority"] = True
        updated["self_heal_reason"] = reason
        if updated.get("action") == "repair":
            updated["action"] = "handoff"
            updated["max_attempts"] = 1
            updated["cooldown_seconds"] = max(int(updated.get("cooldown_seconds") or 0), 1800)
            updated["reason"] = reason
        return updated

    labels = [str(item.get("label") or "") for item in fingerprints]
    baseline_reason = ""
    hotspot = dict(baseline.get("hotspot") or {})
    if baseline.get("blocked"):
        baseline_reason = str(baseline.get("reason") or "baseline is currently blocked")
    elif hotspot.get("shared_root"):
        baseline_reason = str(hotspot.get("summary") or baseline.get("reason") or "shared baseline hotspot detected")
    elif str(memory.get("recommended_response") or "") == "self_heal":
        baseline_reason = "recurring blocker memory suggests baseline self-heal first"

    if not fingerprints:
        return _apply_self_heal(_policy("repair", "no blocking validation fingerprints", max_attempts=2, cooldown_seconds=0), baseline_reason)
    if "missing-fixture-client" in labels and is_lab_mode:
        return _policy("repair", "lab scenario missing fixture should be repaired in-place", max_attempts=2, cooldown_seconds=0)
    if "import-setup-failure" in labels and is_lab_mode:
        return _policy("repair", "lab import/setup failure should be repaired in-place", max_attempts=2, cooldown_seconds=0)
    if "missing-fixture-client" in labels:
        return _apply_self_heal(_policy("handoff", "baseline setup failure: missing fixture 'client'", max_attempts=1, cooldown_seconds=3600), baseline_reason or "baseline setup failure: missing fixture 'client'")
    if "unrelated-failing-test-selection" in labels:
        return _apply_self_heal(_policy("rescope", "blocked by unrelated failing test selection", max_attempts=1, cooldown_seconds=900), baseline_reason)
    if "migration-revision-missing" in labels:
        return _apply_self_heal(_policy("handoff", "baseline migration revision mismatch", max_attempts=1, cooldown_seconds=3600), baseline_reason or "baseline migration revision mismatch")
    if "unrelated-failing-test-selection" in list(memory.get("repeated_fingerprint_labels", []) or []) and any(item.get("blocking") for item in fingerprints):
        return _apply_self_heal(_policy("rescope", "recurring unrelated test blocker memory suggests narrower validation selection", max_attempts=1, cooldown_seconds=900), baseline_reason)
    if all(item.get("blocking") for item in fingerprints):
        primary = fingerprints[0]
        action = str(primary.get("retry_strategy") or "handoff")
        cooldown = 900 if action == "rescope" else (3600 if action == "handoff" else 0)
        attempts = 1 if action in {"handoff", "rescope"} else 2
        return _apply_self_heal(_policy(action, str(primary.get("summary") or "validation blocked"), max_attempts=attempts, cooldown_seconds=cooldown), baseline_reason)
    return _apply_self_heal(_policy("repair", "validation failures appear repairable", max_attempts=2, cooldown_seconds=0), baseline_reason)


def build_repair_handoff(validation_result: dict[str, Any] | None) -> dict[str, Any]:
    payload = dict(validation_result or {})
    fingerprints = [item for item in list(payload.get("fingerprints", []) or []) if isinstance(item, dict)]
    retry_policy = dict(payload.get("retry_policy") or {})
    related_targets = [str(item) for item in list(payload.get("related_targets", []) or []) if str(item)]
    commands = [str(item) for item in list(payload.get("commands", []) or []) if str(item)]
    results = [item for item in list(payload.get("results", []) or []) if isinstance(item, dict)]

    primary = next((item for item in fingerprints if item.get("blocking")), None) or (fingerprints[0] if fingerprints else None)
    path_hints = [str(item) for item in list((primary or {}).get("path_hints", []) or []) if str(item)]
    first_failed = next((item for item in results if not item.get("ok", False)), None)
    first_error_line = ""
    if first_failed is not None:
        combined = "\n".join([str(first_failed.get("stderr") or ""), str(first_failed.get("stdout") or "")]).strip()
        first_error_line = combined.splitlines()[0].strip() if combined else ""

    failing_scope = path_hints[0] if path_hints else (related_targets[0] if related_targets else None)
    failing_reason = str((primary or {}).get("summary") or retry_policy.get("reason") or first_error_line or "").strip() or None
    probable_cause = str((primary or {}).get("label") or "").strip() or None
    reproduction_hint = str((first_failed or {}).get("command") or (commands[0] if commands else "")).strip() or None
    suggested_repair_boundary = path_hints[0] if path_hints else (related_targets[0] if related_targets else None)
    severity = "high" if bool((primary or {}).get("blocking")) else ("medium" if not payload.get("ok", True) else "low")
    confidence = 0.85 if primary and primary.get("blocking") else (0.7 if primary else (0.45 if first_failed else 0.2))
    taxonomy = summarize_failure_taxonomy(fingerprints)

    return {
        "failingScope": failing_scope,
        "failingReason": failing_reason,
        "probableCause": probable_cause,
        "reproductionHint": reproduction_hint,
        "reproductionSteps": [step for step in [reproduction_hint] if step],
        "suggestedRepairBoundary": suggested_repair_boundary,
        "severity": severity,
        "confidence": float(confidence),
        "failureFamily": str((primary or {}).get("failure_family") or taxonomy.get("primary_failure_family") or ""),
        "repairReasonCode": str((primary or {}).get("repair_reason_code") or taxonomy.get("primary_repair_reason_code") or ""),
        "operatorAction": str((primary or {}).get("operator_action") or (taxonomy.get("operator_actions") or [""])[0] or ""),
    }


def _metadata(adapter: RepoAdapter, audit_result: dict[str, Any]):
    metadata = audit_result.get("metadata")
    if metadata is not None:
        return metadata
    return adapter.parse_ticket_metadata(audit_result.get("ticket", ""), audit_result.get("desc", ""))


def _related_targets(plan: dict[str, Any]) -> list[str]:
    targets: list[str] = []
    for step in plan.get("steps", []):
        path = step.get("path")
        if path and path not in targets:
            targets.append(path)
    for path in plan.get("existing_targets", []) or []:
        if path not in targets:
            targets.append(path)
    return targets


def _prioritize_tests_with_memory(test_paths: list[str], ranked_tests: list[str]) -> list[str]:
    if not test_paths or not ranked_tests:
        return test_paths
    ordered: list[str] = []
    seen: set[str] = set()
    for candidate in ranked_tests:
        for path in test_paths:
            if path in seen:
                continue
            if path == candidate or Path(path).name == Path(candidate).name:
                seen.add(path)
                ordered.append(path)
    for path in test_paths:
        if path in seen:
            continue
        seen.add(path)
        ordered.append(path)
    return ordered


def _targeted_validation_commands(adapter: RepoAdapter, audit_result: dict[str, Any], related: list[str], *, project_root: Path | None = None) -> tuple[list[str], dict[str, Any]]:
    metadata = _metadata(adapter, audit_result)
    commands = [shlex.join(cmd) for cmd in adapter.validation_commands(metadata, full_verify=False) if cmd]
    if not related:
        return commands, {"ranked_test_files": [], "narrow_selection": False}

    if audit_result.get("strategy") == "backend_api":
        backend_tests = [path for path in related if path.startswith("backend/tests/")]
        if backend_tests:
            memory_hints = summarize_test_signal_patterns(
                project_root or getattr(adapter, "project_root", Path.cwd()),
                ticket=str(audit_result.get("ticket") or ""),
                strategy=str(audit_result.get("strategy") or ""),
                candidate_tests=backend_tests,
            )
            ordered_tests = _prioritize_tests_with_memory(backend_tests, list(memory_hints.get("ranked_test_files", []) or []))
            if memory_hints.get("narrow_selection"):
                narrowed_limit = 1 if memory_hints.get("high_signal_test_files") else min(2, len(ordered_tests))
                ordered_tests = ordered_tests[: max(1, narrowed_limit)]
            return [f"cd backend && . .venv/bin/activate && pytest -q {' '.join(path.replace('backend/', '', 1) for path in ordered_tests)}"], memory_hints
    if audit_result.get("strategy") == "frontend_feature":
        frontend_tests = [path for path in related if path.endswith((".test.ts", ".test.tsx"))]
        if frontend_tests:
            return [f"cd frontend && npm run typecheck"], {"ranked_test_files": frontend_tests, "narrow_selection": False}
    return commands, {"ranked_test_files": [], "narrow_selection": False}


def build_validation_plan(
    adapter: RepoAdapter,
    ticket: str,
    audit_result: dict[str, Any],
    plan: dict[str, Any],
    full_verify: bool = False,
    runtime_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    metadata = _metadata(adapter, audit_result)
    strategy = get_strategy(audit_result.get("strategy", "mixed"))
    related = _related_targets(plan)

    if full_verify:
        commands = [shlex.join(cmd) for cmd in adapter.validation_commands(metadata, full_verify=True) if cmd]
        memory_hints = {"ranked_test_files": [], "narrow_selection": False}
    elif plan.get("validation"):
        commands = list(plan.get("validation", []))
        memory_hints = dict((plan.get("memory_hints") or {}).get("validation") or {})
    else:
        commands, memory_hints = _targeted_validation_commands(adapter, audit_result, related, project_root=getattr(adapter, "project_root", Path.cwd()))

    return {
        "ticket": ticket,
        "strategy": audit_result.get("strategy", "mixed"),
        "scope": strategy.validation_scope(metadata),
        "related_targets": related,
        "commands": commands,
        "full_verify": full_verify,
        "runtime_context": dict(runtime_context or {}),
        "memory_hints": memory_hints,
    }


def run_validation_plan(
    validation_plan: dict[str, Any],
    *,
    project_root: Path | None = None,
    runtime_context: dict[str, Any] | None = None,
    baseline_state: dict[str, Any] | None = None,
    failure_memory: dict[str, Any] | None = None,
) -> dict[str, Any]:
    root = project_root or Path.cwd()
    results: list[dict[str, Any]] = []
    for command in validation_plan.get("commands", []):
        proc = subprocess.run(command, shell=True, cwd=str(root), text=True, capture_output=True)
        results.append({
            "command": command,
            "ok": proc.returncode == 0,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "returncode": proc.returncode,
        })
    fingerprints = fingerprint_validation_results(results)
    effective_runtime_context = dict(runtime_context or validation_plan.get("runtime_context") or {})
    retry_policy = recommend_retry_policy(
        fingerprints,
        baseline_state=baseline_state or effective_runtime_context.get("baseline_state") or effective_runtime_context.get("baselineState") or {},
        failure_memory=failure_memory or effective_runtime_context.get("memory_state") or effective_runtime_context.get("memoryState") or {},
        runtime_context=effective_runtime_context,
    )
    payload = {
        "ticket": validation_plan.get("ticket"),
        "scope": validation_plan.get("scope", []),
        "related_targets": validation_plan.get("related_targets", []),
        "commands": validation_plan.get("commands", []),
        "results": results,
        "fingerprints": fingerprints,
        "retry_policy": retry_policy,
        "runtime_context": effective_runtime_context,
        "memory_hints": dict(validation_plan.get("memory_hints") or {}),
        "engine_metrics": {
            "failing_command_count": sum(1 for result in results if not result.get("ok", False)),
            "fingerprint_count": len(fingerprints),
            "blocking_fingerprint_count": sum(1 for item in fingerprints if item.get("blocking")),
        },
        "failure_taxonomy_summary": summarize_failure_taxonomy(fingerprints),
        "ok": all(result.get("ok", False) for result in results) if results else True,
    }
    payload["repair_handoff"] = build_repair_handoff(payload)
    return payload