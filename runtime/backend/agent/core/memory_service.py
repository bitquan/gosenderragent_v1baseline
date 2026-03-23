from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.agent.core.storage_paths import assistant_memory_path
from backend.agent.runtime.contracts import (
    build_failure_memory_record,
    build_repair_memory_record,
    build_runtime_memory_record,
    build_strategy_memory_record,
    build_test_signal_memory_record,
)

MEMORY_PHASE_PATTERNS: tuple[dict[str, Any], ...] = (
    {
        "id": "phase-1-safe-engine-core",
        "label": "Phase 1: Safe Engine Core",
        "path_tokens": (
            "renderer/app.js",
            "renderer/styles.css",
            "main.js",
            "preload.js",
            "core/system-check.js",
            "core/engine-acceptance.js",
            "core/task-hub.js",
            "core/safety-controller.js",
        ),
        "keywords": (
            "review",
            "acceptance",
            "trust",
            "rollback",
            "checkpoint",
            "interrupt",
            "safe mode",
            "provider key",
        ),
    },
    {
        "id": "phase-2-assisted-coding-parity",
        "label": "Phase 2: Assisted Coding Parity",
        "path_tokens": (
            "integration-library/extensions/vscode-companion",
            "core/vscode-setup.js",
            "core/vscode-extension-health.js",
            "shared-runtime/agent-runtime-client.js",
        ),
        "keywords": (
            "vs code",
            "companion",
            "parity",
            "trace",
            "problems",
            "sandbox",
            "provider settings",
        ),
    },
    {
        "id": "phase-3-memory-guided-supervision",
        "label": "Phase 3: Memory-Guided Supervision",
        "path_tokens": (
            "core/learning-journal.js",
            "shared-runtime/runtime.js",
            "core/followup-recipes.js",
            "runtime/backend/agent/core/memory_service.py",
        ),
        "keywords": (
            "memory",
            "learned guidance",
            "reject pattern",
            "repair hint",
            "routing bias",
            "self-improvement",
        ),
    },
    {
        "id": "phase-4-builder-and-model-lifecycle",
        "label": "Phase 4: Builder And Model Lifecycle",
        "path_tokens": (
            "core/model-foundry.js",
            "core/promotions.js",
            "core/benchmarks.js",
            "core/training-tuning.js",
            "core/ai-center.js",
        ),
        "keywords": (
            "builder",
            "foundry",
            "promotion",
            "benchmark",
            "candidate",
            "model lifecycle",
        ),
    },
    {
        "id": "phase-5-release-training-and-convergence",
        "label": "Phase 5: Release, Training, And Convergence",
        "path_tokens": (
            "core/desktop-release.js",
            "core/app-backup-archive.js",
            "runtime/backend/scripts/dev_assistant_training.js",
            "runtime/backend/scripts/dev_assistant_training.jsonl",
        ),
        "keywords": (
            "release",
            "rollback archive",
            "training export",
            "trusted export",
            "deployment",
        ),
    },
)


def memory_path(project_root: Path) -> Path:
    return assistant_memory_path(project_root)


def load_memory(project_root: Path) -> list[dict[str, Any]]:
    path = memory_path(project_root)
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data
        except Exception:
            pass
    return []


def save_memory(project_root: Path, entries: list[dict[str, Any]]) -> None:
    try:
        path = memory_path(project_root)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(entries, indent=2), encoding="utf-8")
    except Exception:
        pass


def _normalize_memory_label(value: Any) -> str:
    return str(value or "").strip().lower()


def _normalize_text(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def _normalize_path(value: Any) -> str:
    return str(value or "").strip().replace("\\", "/")


def _compact_text(value: Any, *, max_chars: int = 180) -> str:
    text = _normalize_text(value)
    if not text:
        return ""
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."


def _is_test_file(path: str) -> bool:
    lower = str(path or "").strip().lower()
    name = Path(lower).name
    return "/tests/" in f"/{lower}" or lower.startswith("tests/") or lower.startswith("backend/tests/") or name.startswith("test_") or name.endswith("_test.py") or ".test." in name


def _memory_record(entry: dict[str, Any], key: str) -> dict[str, Any]:
    payload = entry.get(key)
    return dict(payload) if isinstance(payload, dict) else {}


def _entry_validation(entry: dict[str, Any]) -> str:
    runtime_memory = _memory_record(entry, "runtime_memory_record")
    strategy_memory = _memory_record(entry, "strategy_memory_record")
    return str(entry.get("validation") or runtime_memory.get("validation") or strategy_memory.get("validation") or "")


def _entry_strategy(entry: dict[str, Any]) -> str:
    strategy_memory = _memory_record(entry, "strategy_memory_record")
    runtime_memory = _memory_record(entry, "runtime_memory_record")
    return str(entry.get("strategy") or strategy_memory.get("strategy") or runtime_memory.get("strategy") or "")


def _entry_files(entry: dict[str, Any]) -> list[str]:
    runtime_memory = _memory_record(entry, "runtime_memory_record")
    strategy_memory = _memory_record(entry, "strategy_memory_record")
    for candidate in (entry.get("files_written"), runtime_memory.get("files_written"), strategy_memory.get("files_written")):
        if isinstance(candidate, list):
            return [str(item).strip() for item in candidate if str(item).strip()]
    return []


def _entry_patch_labels(entry: dict[str, Any]) -> list[str]:
    runtime_memory = _memory_record(entry, "runtime_memory_record")
    strategy_memory = _memory_record(entry, "strategy_memory_record")
    repair_memory = _memory_record(entry, "repair_memory_record")
    for candidate in (
        entry.get("selected_patch_labels"),
        strategy_memory.get("selected_patch_labels"),
        repair_memory.get("selected_patch_labels"),
        runtime_memory.get("selected_patch_labels"),
    ):
        if isinstance(candidate, list):
            return [str(item).strip() for item in candidate if str(item).strip()]
    return []


def _entry_fingerprint_labels(entry: dict[str, Any]) -> list[str]:
    failure_memory = _memory_record(entry, "failure_memory_record")
    test_signal = _memory_record(entry, "test_signal_memory_record")
    for candidate in (
        entry.get("validation_fingerprints"),
        failure_memory.get("fingerprints"),
        test_signal.get("fingerprint_labels"),
    ):
        if isinstance(candidate, list):
            return [str(item).strip() for item in candidate if str(item).strip()]
    return []


def _entry_retry_action(entry: dict[str, Any]) -> str:
    failure_memory = _memory_record(entry, "failure_memory_record")
    repair_memory = _memory_record(entry, "repair_memory_record")
    return str(entry.get("retry_action") or failure_memory.get("retry_action") or repair_memory.get("action") or "")


def _entry_metadata(entry: dict[str, Any]) -> dict[str, Any]:
    runtime_memory = _memory_record(entry, "runtime_memory_record")
    metadata = runtime_memory.get("metadata")
    return dict(metadata) if isinstance(metadata, dict) else {}


def _entry_review_verdict(entry: dict[str, Any]) -> str:
    metadata = _entry_metadata(entry)
    return str(entry.get("review_verdict") or metadata.get("review_verdict") or "")


def _entry_review_reason(entry: dict[str, Any]) -> str:
    metadata = _entry_metadata(entry)
    return str(entry.get("review_reason") or metadata.get("review_reason") or "")


def _entry_how_to_fix(entry: dict[str, Any]) -> str:
    metadata = _entry_metadata(entry)
    return str(entry.get("how_to_fix") or metadata.get("how_to_fix") or "")


def _entry_recommended_prompt(entry: dict[str, Any]) -> str:
    metadata = _entry_metadata(entry)
    return str(entry.get("recommended_prompt") or metadata.get("recommended_prompt") or "")


def _entry_next_action_command(entry: dict[str, Any]) -> str:
    metadata = _entry_metadata(entry)
    return str(entry.get("next_action_command") or metadata.get("next_action_command") or "")


def _entry_cooldown_until(entry: dict[str, Any]) -> str:
    failure_memory = _memory_record(entry, "failure_memory_record")
    return str(entry.get("cooldown_until") or failure_memory.get("cooldown_until") or "")


def _entry_timestamp(entry: dict[str, Any]) -> str:
    runtime_memory = _memory_record(entry, "runtime_memory_record")
    strategy_memory = _memory_record(entry, "strategy_memory_record")
    for value in (entry.get("timestamp"), runtime_memory.get("created_at"), strategy_memory.get("created_at")):
        text = str(value or "").strip()
        if text:
            return text
    return ""


def _entry_path_signals(entry: dict[str, Any]) -> list[str]:
    seen: set[str] = set()
    values: list[str] = []
    for candidate in [*_entry_files(entry), str(_entry_metadata(entry).get("active_file_path") or ""), str(entry.get("active_file_path") or "")]:
        normalized = _normalize_path(candidate)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        values.append(normalized)
    return values


def _increment_counter(counter: Counter[str], value: Any) -> None:
    normalized = _compact_text(value, max_chars=180)
    if normalized:
        counter[normalized] += 1


def _sorted_counter(counter: Counter[str], limit: int = 4) -> list[dict[str, Any]]:
    return [
        {"value": value, "count": count}
        for value, count in counter.most_common(max(1, int(limit or 4)))
    ]


def _normalize_memory_response(value: Any) -> str:
    normalized = _normalize_memory_label(value)
    if normalized in {"repair-loop", "repair", "repair-loop-retry"}:
        return "repair-loop"
    if normalized in {"retry-with-research", "research", "bridge-plan-retry", "research-expansion"}:
        return "retry-with-research"
    if normalized in {"review-interrupt", "review", "approval-review", "manual-review"}:
        return "review-interrupt"
    if normalized in {"continue-run", "continue", "run", "implement"}:
        return "continue-run"
    return normalized


def _default_prompt_for_action(action: str) -> str:
    normalized = _normalize_memory_response(action)
    if normalized == "repair-loop":
        return "Repair the latest failed run and rerun the smallest relevant validation."
    if normalized == "retry-with-research":
        return "Retry the current objective with more repo research before applying another patch."
    if normalized == "review-interrupt":
        return "Review the latest run, summarize the blockers, and clear the held approval items."
    return "Continue the current bounded objective."


def _increment_phase_counter(counter: dict[str, dict[str, Any]], match: dict[str, Any] | None) -> None:
    if not match:
        return
    match_id = str(match.get("id") or "").strip()
    match_label = str(match.get("label") or "").strip()
    if not match_id or not match_label:
        return
    current = dict(counter.get(match_id) or {"id": match_id, "label": match_label, "count": 0, "score": 0, "reason": ""})
    current["count"] = int(current.get("count", 0)) + 1
    current["score"] = int(current.get("score", 0)) + int(match.get("score", 0) or 0)
    if not current.get("reason"):
        current["reason"] = str(match.get("reason") or "").strip()
    counter[match_id] = current


def _sorted_phase_counter(counter: dict[str, dict[str, Any]], limit: int = 3) -> list[dict[str, Any]]:
    values = list(counter.values())
    values.sort(
        key=lambda item: (
            int(item.get("count", 0)),
            int(item.get("score", 0)),
            str(item.get("label") or ""),
        ),
        reverse=True,
    )
    return [
        {
            "id": str(item.get("id") or "").strip(),
            "label": str(item.get("label") or "").strip(),
            "count": int(item.get("count", 0)),
            "score": int(item.get("score", 0)),
            "reason": str(item.get("reason") or "").strip(),
        }
        for item in values[: max(1, int(limit or 3))]
    ]


def _phase_relevance_from_entry(entry: dict[str, Any]) -> dict[str, Any] | None:
    changed_paths = _entry_path_signals(entry)
    searchable_text = " ".join(
        item
        for item in (
            _normalize_text(_entry_review_reason(entry)).lower(),
            _normalize_text(_entry_how_to_fix(entry)).lower(),
            _normalize_text(_entry_recommended_prompt(entry)).lower(),
            _normalize_text(entry.get("validation")).lower(),
            " ".join(_normalize_memory_label(label) for label in _entry_fingerprint_labels(entry)),
        )
        if item
    )
    best_match: dict[str, Any] | None = None
    for definition in MEMORY_PHASE_PATTERNS:
        score = 0
        reason = ""
        for token in definition.get("path_tokens", ()):
            normalized_token = _normalize_path(token).lower()
            matched_path = next((item for item in changed_paths if normalized_token and normalized_token in _normalize_path(item).lower()), "")
            if matched_path:
                score += 3
                if not reason:
                    reason = f"Touched {matched_path}."
        for keyword in definition.get("keywords", ()):
            normalized_keyword = _normalize_memory_label(keyword)
            if normalized_keyword and normalized_keyword in searchable_text:
                score += 1
                if not reason:
                    reason = f'Objective or review text matched "{keyword}".'
        if score <= 0:
            continue
        candidate = {
            "id": str(definition.get("id") or "").strip(),
            "label": str(definition.get("label") or "").strip(),
            "score": score,
            "reason": _compact_text(reason, max_chars=140),
        }
        if best_match is None or int(candidate["score"]) > int(best_match.get("score", 0)):
            best_match = candidate
    return best_match


def relevant_success_memory(
    project_root: Path,
    *,
    strategy: str = "",
    target_path: str = "",
    active_file_path: str = "",
    limit: int = 8,
) -> list[dict[str, Any]]:
    strategy_value = _normalize_memory_label(strategy)
    target_value = str(target_path or "").strip()
    active_value = str(active_file_path or "").strip()
    target_name = Path(target_value).stem.lower() if target_value else ""
    active_name = Path(active_value).stem.lower() if active_value else ""
    ranked: list[tuple[int, dict[str, Any]]] = []

    for entry in load_memory(project_root):
        if _entry_validation(entry) != "passed":
            continue
        score = 0
        entry_strategy = _normalize_memory_label(_entry_strategy(entry))
        if strategy_value and strategy_value == entry_strategy:
            score += 20
        files = _entry_files(entry)
        if target_value and target_value in files:
            score += 40
        if active_value and active_value in files:
            score += 24
        if target_name and any(target_name in Path(path).stem.lower() for path in files):
            score += 12
        if active_name and any(active_name in Path(path).stem.lower() for path in files):
            score += 8
        if score > 0:
            ranked.append((score, entry))

    ranked.sort(key=lambda item: item[0], reverse=True)
    return [entry for _score, entry in ranked[: max(1, int(limit or 8))]]


def summarize_success_patterns(
    project_root: Path,
    *,
    strategy: str = "",
    target_path: str = "",
    active_file_path: str = "",
    limit: int = 8,
) -> dict[str, Any]:
    entries = relevant_success_memory(
        project_root,
        strategy=strategy,
        target_path=target_path,
        active_file_path=active_file_path,
        limit=limit,
    )
    label_counter: Counter[str] = Counter()
    file_counter: Counter[str] = Counter()
    for entry in entries:
        for label in _entry_patch_labels(entry):
            normalized = _normalize_memory_label(label)
            if normalized:
                label_counter[normalized] += 1
        for path in _entry_files(entry):
            normalized_path = str(path or "").strip()
            if normalized_path:
                file_counter[normalized_path] += 1
    return {
        "entries": entries,
        "preferred_labels": [label for label, _count in label_counter.most_common(4)],
        "successful_files": [path for path, _count in file_counter.most_common(6)],
    }


def summarize_strategy_patterns(
    project_root: Path,
    *,
    strategy: str = "",
    target_path: str = "",
    active_file_path: str = "",
    limit: int = 16,
) -> dict[str, Any]:
    success_summary = summarize_success_patterns(
        project_root,
        strategy=strategy,
        target_path=target_path,
        active_file_path=active_file_path,
        limit=limit,
    )
    failure_summary = summarize_failure_patterns(
        project_root,
        strategy=strategy,
        target_path=target_path,
        limit=limit,
    )
    success_count = len(list(success_summary.get("entries", []) or []))
    failure_count = len(list(failure_summary.get("entries", []) or []))
    total = success_count + failure_count
    recurring_blockers = list(failure_summary.get("recurring_blockers", []) or [])
    return {
        "success_count": success_count,
        "failure_count": failure_count,
        "success_rate": (success_count / total) if total else 0.0,
        "preferred_labels": list(success_summary.get("preferred_labels", []) or []),
        "preferred_files": list(success_summary.get("successful_files", []) or []),
        "recurring_blockers": recurring_blockers,
        "repeat_count": int(failure_summary.get("repeat_count", 0)),
        "recommended_response": str(failure_summary.get("recommended_response") or "ticket_repair"),
        "repeated_failure_actions": list(failure_summary.get("retry_actions", []) or []),
        "deprioritize_strategy": failure_count > success_count and success_count == 0,
        "confidence_boost": bool(success_count and not recurring_blockers),
    }


def rank_strategy_candidates(
    project_root: Path,
    candidates: list[str],
    *,
    active_file_path: str = "",
    limit: int = 8,
) -> list[dict[str, Any]]:
    ranked: list[dict[str, Any]] = []
    seen: set[str] = set()
    for candidate in candidates:
        strategy = str(candidate or "").strip()
        if not strategy or strategy in seen:
            continue
        seen.add(strategy)
        summary = summarize_strategy_patterns(
            project_root,
            strategy=strategy,
            active_file_path=active_file_path,
            limit=limit,
        )
        score = 0.0
        score += float(summary.get("success_count", 0)) * 3.0
        score -= float(summary.get("failure_count", 0)) * 1.5
        score -= float(len(list(summary.get("recurring_blockers", []) or []))) * 2.5
        if summary.get("confidence_boost"):
            score += 1.0
        if summary.get("deprioritize_strategy"):
            score -= 2.0
        ranked.append(
            {
                "strategy": strategy,
                "score": score,
                "success_count": int(summary.get("success_count", 0)),
                "failure_count": int(summary.get("failure_count", 0)),
                "recurring_blockers": list(summary.get("recurring_blockers", []) or []),
                "recommended_response": str(summary.get("recommended_response") or "ticket_repair"),
                "summary": summary,
            }
        )
    ranked.sort(
        key=lambda item: (
            float(item.get("score", 0.0)),
            int(item.get("success_count", 0)),
            -int(item.get("failure_count", 0)),
            str(item.get("strategy") or ""),
        ),
        reverse=True,
    )
    return ranked


def _normalize_fingerprint_labels(labels: list[str] | None) -> list[str]:
    return sorted({_normalize_memory_label(item) for item in (labels or []) if _normalize_memory_label(item)})


def _is_noisy_failure_label(label: str) -> bool:
    normalized = _normalize_memory_label(label)
    return any(token in normalized for token in ("unrelated", "selection", "fixture", "migration", "import"))


def _parse_timestamp(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        return datetime.fromisoformat(text)
    except Exception:
        return None


def relevant_failure_memory(
    project_root: Path,
    *,
    ticket: str = "",
    strategy: str = "",
    fingerprint_labels: list[str] | None = None,
    target_path: str = "",
    limit: int = 12,
) -> list[dict[str, Any]]:
    ticket_value = str(ticket or "").strip()
    strategy_value = _normalize_memory_label(strategy)
    target_value = str(target_path or "").strip()
    fingerprint_values = set(_normalize_fingerprint_labels(fingerprint_labels))
    ranked: list[tuple[int, dict[str, Any]]] = []

    for entry in load_memory(project_root):
        if _entry_validation(entry) != "failed":
            continue
        score = 0
        if ticket_value and str(entry.get("ticket") or "").strip() == ticket_value:
            score += 36
        if strategy_value and _normalize_memory_label(_entry_strategy(entry)) == strategy_value:
            score += 12
        files = _entry_files(entry)
        if target_value and target_value in files:
            score += 18
        entry_fingerprints = {_normalize_memory_label(item) for item in _entry_fingerprint_labels(entry)}
        if fingerprint_values and entry_fingerprints.intersection(fingerprint_values):
            score += 24
        if score > 0:
            ranked.append((score, entry))

    ranked.sort(
        key=lambda item: (
            item[0],
            _parse_timestamp(_entry_timestamp(item[1])) or datetime.min.replace(tzinfo=timezone.utc),
        ),
        reverse=True,
    )
    return [entry for _score, entry in ranked[: max(1, int(limit or 12))]]


def summarize_failure_patterns(
    project_root: Path,
    *,
    ticket: str = "",
    strategy: str = "",
    fingerprint_labels: list[str] | None = None,
    target_path: str = "",
    limit: int = 12,
) -> dict[str, Any]:
    entries = relevant_failure_memory(
        project_root,
        ticket=ticket,
        strategy=strategy,
        fingerprint_labels=fingerprint_labels,
        target_path=target_path,
        limit=limit,
    )
    fingerprint_counter: Counter[str] = Counter()
    retry_action_counter: Counter[str] = Counter()
    blocking_counter: Counter[str] = Counter()
    cooldown_until = None
    latest_retry_action = ""
    repeated_labels: list[str] = []
    latest_timestamp = None
    for entry in entries:
        labels = _normalize_fingerprint_labels(_entry_fingerprint_labels(entry))
        for label in labels:
            fingerprint_counter[label] += 1
            if _is_noisy_failure_label(label):
                blocking_counter[label] += 1
        retry_action = _normalize_memory_label(_entry_retry_action(entry))
        if retry_action:
            retry_action_counter[retry_action] += 1
            if not latest_retry_action:
                latest_retry_action = retry_action
        if cooldown_until is None:
            cooldown_until = _parse_timestamp(_entry_cooldown_until(entry))
        if latest_timestamp is None:
            latest_timestamp = _parse_timestamp(_entry_timestamp(entry))
    repeated_labels = [label for label, count in fingerprint_counter.items() if count >= 3]
    noisy_failure_labels = [label for label, count in blocking_counter.items() if count >= 1]
    recurring_blockers = [
        {"label": label, "count": count}
        for label, count in fingerprint_counter.most_common(5)
        if count >= 2 and (_is_noisy_failure_label(label) or label in repeated_labels)
    ]
    shared_root_likely = bool(noisy_failure_labels or any(label in {"missing-fixture-client", "migration-revision-missing", "import-setup-failure"} for label in repeated_labels))
    recommended_response = "self_heal" if shared_root_likely or max((count for count in fingerprint_counter.values()), default=0) >= 3 else "ticket_repair"
    now = datetime.now(timezone.utc)
    return {
        "entries": entries,
        "failure_count": len(entries),
        "top_fingerprints": [
            {"label": label, "count": count}
            for label, count in fingerprint_counter.most_common(5)
        ],
        "latest_retry_action": latest_retry_action,
        "retry_actions": [
            {"action": action, "count": count}
            for action, count in retry_action_counter.most_common(4)
        ],
        "cooldown_until": cooldown_until.isoformat() if cooldown_until else "",
        "cooldown_active": bool(cooldown_until and cooldown_until > now),
        "repeated_fingerprint_labels": repeated_labels,
        "repeat_count": max((count for count in fingerprint_counter.values()), default=0),
        "noisy_failure_labels": noisy_failure_labels,
        "recurring_blockers": recurring_blockers,
        "shared_root_likely": shared_root_likely,
        "recommended_response": recommended_response,
        "latest_failure_timestamp": latest_timestamp.isoformat() if latest_timestamp else "",
    }


def summarize_test_signal_patterns(
    project_root: Path,
    *,
    ticket: str = "",
    strategy: str = "",
    candidate_tests: list[str] | None = None,
    active_file_path: str = "",
    limit: int = 12,
) -> dict[str, Any]:
    success_summary = summarize_success_patterns(
        project_root,
        strategy=strategy,
        active_file_path=active_file_path,
        limit=limit,
    )
    failure_summary = summarize_failure_patterns(
        project_root,
        ticket=ticket,
        strategy=strategy,
        limit=limit,
    )
    tests = [str(path) for path in list(candidate_tests or []) if _is_test_file(str(path))]
    successful_tests = [path for path in list(success_summary.get("successful_files", []) or []) if _is_test_file(path)]
    ranked_test_files: list[str] = []
    seen: set[str] = set()
    for group in (successful_tests, tests):
        for path in group:
            normalized = str(path or "").strip()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            ranked_test_files.append(normalized)
    unrelated_count = 0
    for blocker in list(failure_summary.get("recurring_blockers", []) or []):
        if str(blocker.get("label") or "") == "unrelated-failing-test-selection":
            unrelated_count = int(blocker.get("count") or 0)
            break
    noisy_labels = list(failure_summary.get("noisy_failure_labels", []) or [])
    return {
        "ranked_test_files": ranked_test_files,
        "high_signal_test_files": successful_tests,
        "noisy_failure_labels": noisy_labels,
        "unrelated_blocker_count": unrelated_count,
        "narrow_selection": unrelated_count >= 2 or "unrelated-failing-test-selection" in noisy_labels,
        "recommended_action": "narrow_related" if unrelated_count >= 2 or "unrelated-failing-test-selection" in noisy_labels else "normal_related",
    }


def summarize_repair_patterns(
    project_root: Path,
    *,
    ticket: str = "",
    strategy: str = "",
    fingerprint_labels: list[str] | None = None,
    target_path: str = "",
    active_file_path: str = "",
    limit: int = 12,
) -> dict[str, Any]:
    success_summary = summarize_success_patterns(
        project_root,
        strategy=strategy,
        target_path=target_path,
        active_file_path=active_file_path,
        limit=limit,
    )
    failure_summary = summarize_failure_patterns(
        project_root,
        ticket=ticket,
        strategy=strategy,
        fingerprint_labels=fingerprint_labels,
        target_path=target_path,
        limit=limit,
    )
    latest_retry_action = str(failure_summary.get("latest_retry_action") or "")
    avoid_retry_action = latest_retry_action if int(failure_summary.get("repeat_count", 0)) >= 2 and latest_retry_action else ""
    return {
        "preferred_labels": list(success_summary.get("preferred_labels", []) or []),
        "successful_files": list(success_summary.get("successful_files", []) or []),
        "latest_retry_action": latest_retry_action,
        "retry_actions": list(failure_summary.get("retry_actions", []) or []),
        "repeat_count": int(failure_summary.get("repeat_count", 0)),
        "repeated_fingerprint_labels": list(failure_summary.get("repeated_fingerprint_labels", []) or []),
        "avoid_retry_action": avoid_retry_action,
        "reduce_retry_budget": bool(avoid_retry_action),
        "recurring_blockers": list(failure_summary.get("recurring_blockers", []) or []),
        "recommended_response": str(failure_summary.get("recommended_response") or "ticket_repair"),
    }


def summarize_runtime_memory_hints(
    project_root: Path,
    *,
    ticket: str = "",
    strategy: str = "",
    fingerprint_labels: list[str] | None = None,
    target_path: str = "",
    active_file_path: str = "",
    limit: int = 12,
) -> dict[str, Any]:
    entries = relevant_failure_memory(
        project_root,
        ticket=ticket,
        strategy=strategy,
        fingerprint_labels=fingerprint_labels,
        target_path=target_path or active_file_path,
        limit=limit,
    )
    reject_reasons: Counter[str] = Counter()
    fix_patterns: Counter[str] = Counter()
    failure_classes: Counter[str] = Counter()
    preferred_responses: Counter[str] = Counter()
    path_counts: Counter[str] = Counter()
    phase_counts: dict[str, dict[str, Any]] = {}
    recent_rejects: list[dict[str, Any]] = []

    for entry in entries:
        review_reason = _entry_review_reason(entry)
        how_to_fix = _entry_how_to_fix(entry)
        failure_labels = _entry_fingerprint_labels(entry)
        raw_retry_action = _entry_retry_action(entry)
        next_action_command = _entry_next_action_command(entry)
        preferred_response = _normalize_memory_response(next_action_command or raw_retry_action)
        review_verdict = _normalize_memory_label(_entry_review_verdict(entry))

        _increment_counter(reject_reasons, review_reason or (failure_labels[0] if failure_labels else "validation failure"))
        _increment_counter(fix_patterns, how_to_fix or _entry_recommended_prompt(entry) or _default_prompt_for_action(preferred_response))
        for label in failure_labels[:4]:
            _increment_counter(failure_classes, label)
        _increment_counter(preferred_responses, preferred_response)
        for path_value in _entry_path_signals(entry):
            _increment_counter(path_counts, path_value)
        _increment_phase_counter(phase_counts, _phase_relevance_from_entry(entry))

        if len(recent_rejects) < 3:
            recent_rejects.append(
                {
                    "verdict": review_verdict or "needs-changes",
                    "reason": _compact_text(review_reason or (failure_labels[0] if failure_labels else ""), max_chars=180),
                    "how_to_fix": _compact_text(how_to_fix or _entry_recommended_prompt(entry), max_chars=180),
                    "path": str(_entry_path_signals(entry)[0] if _entry_path_signals(entry) else "").strip(),
                }
            )

    top_reject_reasons = _sorted_counter(reject_reasons, 3)
    top_fix_patterns = _sorted_counter(fix_patterns, 3)
    recurring_failure_classes = _sorted_counter(failure_classes, 3)
    preferred_response_rows = _sorted_counter(preferred_responses, 3)
    top_paths = _sorted_counter(path_counts, 4)
    phase_relevance = _sorted_phase_counter(phase_counts, 3)
    recommended_response = str((preferred_response_rows[0] or {}).get("value") or "").strip()
    top_reject_reason = str((top_reject_reasons[0] or {}).get("value") or "").strip()
    top_fix_pattern = str((top_fix_patterns[0] or {}).get("value") or "").strip()
    top_phase_id = str((phase_relevance[0] or {}).get("id") or "").strip()
    top_phase_label = str((phase_relevance[0] or {}).get("label") or "").strip()
    top_phase_reason = str((phase_relevance[0] or {}).get("reason") or "").strip()
    recommended_prompt = top_fix_pattern or _default_prompt_for_action(recommended_response)
    summary = (
        f"{len(entries)} runtime reject pattern(s) matched. Most common: {top_reject_reason or 'runtime validation failure'}"
        f"{f'. Preferred response: {recommended_response}' if recommended_response else ''}"
        f"{f'. Phase focus: {top_phase_label}' if top_phase_label else ''}."
        if entries
        else "No recurring runtime reject patterns are recorded yet."
    )
    runtime_retry_action = {
        "repair-loop": "repair",
        "retry-with-research": "run",
        "continue-run": "run",
        "review-interrupt": "",
    }.get(recommended_response, "")
    return {
        "reject_count": len(entries),
        "summary": summary,
        "top_reject_reason": top_reject_reason,
        "top_fix_pattern": top_fix_pattern,
        "recommended_response": recommended_response,
        "recommended_prompt": recommended_prompt,
        "runtime_retry_action": runtime_retry_action,
        "top_reject_reasons": top_reject_reasons,
        "top_fix_patterns": top_fix_patterns,
        "recurring_failure_classes": recurring_failure_classes,
        "preferred_responses": preferred_response_rows,
        "top_paths": top_paths,
        "top_phase_id": top_phase_id,
        "top_phase_label": top_phase_label,
        "top_phase_reason": top_phase_reason,
        "phase_summary": (
            f"{top_phase_label} is showing the strongest reusable runtime guidance right now."
            + (f" {top_phase_reason}" if top_phase_reason else "")
        ) if top_phase_label else "",
        "phase_relevance": phase_relevance,
        "recent_rejects": recent_rejects,
    }


def ticket_cooldown_status(project_root: Path, ticket: str) -> dict[str, Any]:
    summary = summarize_failure_patterns(project_root, ticket=ticket)
    return {
        "ticket": str(ticket or ""),
        "cooldown_until": summary.get("cooldown_until", ""),
        "cooldown_active": bool(summary.get("cooldown_active", False)),
        "retry_action": summary.get("latest_retry_action", ""),
        "repeat_count": int(summary.get("repeat_count", 0)),
        "repeated_fingerprint_labels": list(summary.get("repeated_fingerprint_labels", [])),
    }


def record_memory(
    project_root: Path,
    ticket: str,
    strategy: str,
    files_written: list[str],
    validation_ok: bool,
    *,
    metadata: dict[str, Any] | None = None,
) -> None:
    entries = load_memory(project_root)
    details = dict(metadata or {})
    timestamp = str(details.get("timestamp") or datetime.now(timezone.utc).isoformat())
    validation_value = "passed" if validation_ok else "failed"
    files_written_payload = [str(path) for path in list(files_written or []) if str(path)]
    selected_patch_labels = [str(label) for label in list(details.get("selected_patch_labels", []) or []) if str(label)]
    fingerprint_labels = _normalize_fingerprint_labels(details.get("validation_fingerprints", []))
    retry_action = str(details.get("retry_action") or "")
    cooldown_until = str(details.get("cooldown_until") or "")
    decision_types = [str(item) for item in list(details.get("decision_types", []) or []) if str(item)]
    active_file_path = str(details.get("active_file_path") or "")
    run_id = str(details.get("run_id") or "")
    task_id = str(details.get("task_id") or "")
    runtime_memory_record = build_runtime_memory_record(
        ticket_id=ticket,
        run_id=run_id,
        task_id=task_id,
        strategy=strategy,
        action=str(details.get("action") or "run"),
        mode=str(details.get("mode") or "integrate"),
        validation=validation_value,
        files_written=files_written_payload,
        selected_patch_labels=selected_patch_labels,
        decision_types=decision_types,
        active_file_path=active_file_path,
        created_at=timestamp,
        metadata={
            "runtime_status": str(details.get("runtime_status") or ""),
            "final_state": str(details.get("final_state") or ""),
            "review_verdict": str(details.get("review_verdict") or ""),
            "review_reason": str(details.get("review_reason") or ""),
            "how_to_fix": str(details.get("how_to_fix") or ""),
            "change_summary": str(details.get("change_summary") or ""),
            "recommended_prompt": str(details.get("recommended_prompt") or ""),
            "next_action_command": str(details.get("next_action_command") or ""),
        },
    )
    failure_memory_record = build_failure_memory_record(
        ticket_id=ticket,
        run_id=run_id,
        task_id=task_id,
        strategy=strategy,
        fingerprints=fingerprint_labels,
        retry_action=retry_action,
        repair_skipped=bool(details.get("repair_skipped", False)),
        cooldown_until=cooldown_until,
        noisy_failure_labels=[str(label) for label in list(details.get("noisy_failure_labels", []) or []) if str(label)],
        recurring_blockers=[dict(item) for item in list(details.get("recurring_blockers", []) or []) if isinstance(item, dict)],
        recommended_response=str(details.get("recommended_response") or "ticket_repair"),
        created_at=timestamp,
    )
    repair_paths = [str(path) for path in list(details.get("repair_paths", []) or []) if str(path)]
    repair_memory_record = build_repair_memory_record(
        ticket_id=ticket,
        run_id=run_id,
        task_id=task_id,
        strategy=strategy,
        action=retry_action,
        attempted_paths=repair_paths,
        successful=bool(details.get("repair_ok")) if details.get("repair_ok") is not None else None,
        skipped=bool(details.get("repair_skipped", False)),
        skip_reason=str(details.get("skip_reason") or ""),
        selected_patch_labels=selected_patch_labels,
        created_at=timestamp,
    )
    test_signal_memory_record = build_test_signal_memory_record(
        ticket_id=ticket,
        run_id=run_id,
        task_id=task_id,
        fingerprint_labels=fingerprint_labels,
        noisy_labels=[str(label) for label in list(details.get("noisy_failure_labels", []) or []) if str(label)],
        failing_commands=[str(command) for command in list(details.get("failing_commands", []) or []) if str(command)],
        blocking_fingerprint_count=int(details.get("blocking_fingerprint_count") or 0),
        recommended_action=retry_action,
        created_at=timestamp,
    )
    strategy_memory_record = build_strategy_memory_record(
        ticket_id=ticket,
        run_id=run_id,
        task_id=task_id,
        strategy=strategy,
        validation=validation_value,
        files_written=files_written_payload,
        selected_patch_labels=selected_patch_labels,
        success=validation_ok,
        write_enabled=bool((details.get("write_gate") or {}).get("allow_write")) if isinstance(details.get("write_gate"), dict) else None,
        created_at=timestamp,
    )
    entries.append(
        {
            "ticket": ticket,
            "strategy": strategy,
            "files_written": files_written_payload,
            "validation": validation_value,
            "review_verdict": str(details.get("review_verdict") or ""),
            "review_reason": str(details.get("review_reason") or ""),
            "how_to_fix": str(details.get("how_to_fix") or ""),
            "recommended_prompt": str(details.get("recommended_prompt") or ""),
            "next_action_command": str(details.get("next_action_command") or ""),
            "selected_patch_labels": selected_patch_labels,
            "validation_fingerprints": fingerprint_labels,
            "retry_action": retry_action,
            "repair_skipped": bool(details.get("repair_skipped", False)),
            "cooldown_until": cooldown_until,
            "decision_types": decision_types,
            "write_gate": dict(details.get("write_gate") or {}),
            "active_file_path": active_file_path,
            "timestamp": timestamp,
            "runtime_memory_record": runtime_memory_record,
            "failure_memory_record": failure_memory_record,
            "repair_memory_record": repair_memory_record,
            "test_signal_memory_record": test_signal_memory_record,
            "strategy_memory_record": strategy_memory_record,
        }
    )
    save_memory(project_root, entries)


def summarize_pattern_quality(project_root: Path, *, limit: int = 120) -> dict[str, Any]:
    entries = load_memory(project_root)[-limit:]
    good: Counter[str] = Counter()
    bad: Counter[str] = Counter()
    sources: Counter[str] = Counter()
    for entry in entries:
        metadata = _entry_metadata(entry)
        validation = _entry_validation(entry).strip().lower()
        strategy = _entry_strategy(entry).strip().lower() or 'unknown'
        source = str(metadata.get('pattern_source') or ('test-backed' if validation == 'pass' else 'failure-backed')).strip()
        sources[source] += 1
        if validation == 'pass':
            good[strategy] += 1
        elif validation:
            bad[strategy] += 1
    def _top(counter: Counter[str]) -> list[dict[str, Any]]:
        return [
            {'label': label, 'count': count, 'confidence': round(min(0.99, 0.45 + (count * 0.08)), 2)}
            for label, count in counter.most_common(5)
        ]
    return {
        'good_patterns': _top(good),
        'bad_patterns': _top(bad),
        'source_mix': [{'label': label, 'count': count} for label, count in sources.most_common(5)],
        'summary': (f"Good patterns {sum(good.values())} • Bad patterns {sum(bad.values())} • Sources {', '.join(label for label, _ in sources.most_common(3))}".strip()),
    }


def summarize_docs_ingestion_health(project_root: Path, *, limit: int = 120) -> dict[str, Any]:
    entries = load_memory(project_root)[-limit:]
    captures = 0
    experiments = 0
    topics: Counter[str] = Counter()
    for entry in entries:
        metadata = _entry_metadata(entry)
        captures += int(metadata.get('docs_capture_count') or 0)
        experiments += int(metadata.get('docs_experiment_count') or 0)
        for item in list(metadata.get('docs_topics') or []):
            topic = str(item or '').strip()
            if topic:
                topics[topic] += 1
    return {
        'docs_capture_count': captures,
        'docs_experiment_count': experiments,
        'top_topics': [{'label': label, 'count': count} for label, count in topics.most_common(5)],
        'summary': f'Captured {captures} docs slices and {experiments} docs-backed experiment signal(s).',
    }
