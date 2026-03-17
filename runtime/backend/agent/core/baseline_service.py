from __future__ import annotations

import json
import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from backend.agent.core.storage_paths import assistant_dev_runs_dir, assistant_runs_dir


_TARGETED_TEST_RE = re.compile(r"targeted pytest \(([^)]+)\)", re.IGNORECASE)
_MISSING_FIXTURE_RE = re.compile(r"fixture ['\"]([^'\"]+)['\"] not found", re.IGNORECASE)
_MODULE_NOT_FOUND_RE = re.compile(r"ModuleNotFoundError:\s+No module named ['\"]?([^'\"\s]+)", re.IGNORECASE)
_IMPORT_ERROR_RE = re.compile(r"(?:ImportError|cannot import name)[:\s].+", re.IGNORECASE)
_CONFTEST_RE = re.compile(r"conftest\.py|ConftestImportFailure|ImportError while loading conftest", re.IGNORECASE)
_PATH_RE = re.compile(r"((?:backend|frontend|docs)/[A-Za-z0-9_./-]+\.(?:py|ts|tsx|js|jsx|md|json|ya?ml))(?::(\d+))?")
_PLACEHOLDER_RE = re.compile(r"generated for BAT<|placeholder|NotImplementedError|stub", re.IGNORECASE)
_NON_RUNTIME_ARTIFACT_RE = re.compile(
    r"(?:^assistant_|^engine_|_status_suggestion\.json$|_critique\.json$|(?:^|_)plan\.json$|_bundle\.json$|_execution\.json$|_report\.json$|_summary\.json$)",
    re.IGNORECASE,
)

SHARED_ROOT_FAMILIES = {
    "missing_fixture",
    "conftest_import",
    "missing_dependency",
    "import_setup",
    "placeholder_stub",
}


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", str(value or "").strip().lower()).strip("-")
    return slug or "baseline-repair"


def _parse_iso(value: Any) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _combined_check_text(check: dict[str, Any]) -> str:
    return "\n".join(
        [
            str(check.get("name") or ""),
            str(check.get("message") or ""),
            str(check.get("stdout_tail") or ""),
            str(check.get("stderr_tail") or ""),
        ]
    )


def _targeted_test_path(check: dict[str, Any]) -> str:
    name = str(check.get("name") or "")
    match = _TARGETED_TEST_RE.search(name)
    if match:
        return match.group(1)
    args = check.get("args") or []
    for item in args:
        text = str(item or "")
        if text.endswith(".py") and ("tests/" in text or text.startswith("backend/tests/")):
            return text
    return ""


def _extract_path(text: str) -> str:
    match = _PATH_RE.search(text)
    return match.group(1) if match else ""


def _normalize_run_checks(run: dict[str, Any]) -> list[dict[str, Any]]:
    checks = run.get("checks")
    if isinstance(checks, list):
        return [item for item in checks if isinstance(item, dict)]
    validation = run.get("validation")
    if isinstance(validation, list):
        return [item for item in validation if isinstance(item, dict)]
    return []


def _classify_check(check: dict[str, Any]) -> dict[str, Any]:
    text = _combined_check_text(check)
    targeted_path = _targeted_test_path(check)
    path_hint = _extract_path(text) or targeted_path

    fixture_match = _MISSING_FIXTURE_RE.search(text)
    if fixture_match:
        fixture = fixture_match.group(1)
        summary = f"missing fixture '{fixture}'"
        fixture_path_hint = "backend/tests/conftest.py" if targeted_path.startswith("backend/tests/") else (path_hint or "conftest.py")
        return {
            "family": "missing_fixture",
            "signature": f"missing_fixture:{fixture.lower()}",
            "summary": summary,
            "shared_root": True,
            "path_hint": fixture_path_hint,
            "affected_path": targeted_path or path_hint,
        }

    if _CONFTEST_RE.search(text):
        return {
            "family": "conftest_import",
            "signature": "conftest_import",
            "summary": "broken conftest/import setup",
            "shared_root": True,
            "path_hint": path_hint or "conftest.py",
        }

    module_match = _MODULE_NOT_FOUND_RE.search(text)
    if module_match:
        module_name = module_match.group(1)
        return {
            "family": "missing_dependency",
            "signature": f"missing_dependency:{module_name.lower()}",
            "summary": f"missing dependency/import '{module_name}'",
            "shared_root": True,
            "path_hint": path_hint,
        }

    if _IMPORT_ERROR_RE.search(text):
        return {
            "family": "import_setup",
            "signature": f"import_setup:{(path_hint or str(check.get('name') or 'import')).lower()}",
            "summary": "broken import/setup path",
            "shared_root": True,
            "path_hint": path_hint,
        }

    if _PLACEHOLDER_RE.search(text):
        return {
            "family": "placeholder_stub",
            "signature": f"placeholder_stub:{(path_hint or str(check.get('name') or 'stub')).lower()}",
            "summary": "broken placeholder/stub pattern",
            "shared_root": True,
            "path_hint": path_hint,
        }

    if path_hint:
        return {
            "family": "path_hotspot",
            "signature": f"path_hotspot:{path_hint.lower()}",
            "summary": f"repeated hotspot in {Path(path_hint).name}",
            "shared_root": path_hint.endswith("conftest.py"),
            "path_hint": path_hint,
        }

    fallback = str(check.get("name") or check.get("message") or "validation failure").strip() or "validation failure"
    return {
        "family": "check_failure",
        "signature": f"check_failure:{fallback.lower()}",
        "summary": fallback,
        "shared_root": False,
        "path_hint": "",
    }


def _hotspot_signature(hotspot: dict[str, Any] | None) -> str:
    if not isinstance(hotspot, dict):
        return ""
    return str(hotspot.get("signature") or "").strip().lower()


def _hotspot_summary(hotspot: dict[str, Any] | None) -> str:
    if not isinstance(hotspot, dict):
        return "baseline failure"
    summary = str(hotspot.get("summary") or "").strip()
    if summary:
        return summary
    path_hint = str(hotspot.get("path_hint") or "").strip()
    if path_hint:
        return f"issue near {Path(path_hint).name}"
    family = str(hotspot.get("family") or "baseline").strip().replace("_", " ")
    return family or "baseline failure"


def _run_generated_at(run: dict[str, Any]) -> datetime | None:
    return _parse_iso(run.get("generated_at") or run.get("timestamp"))


def _artifact_terminal_state(run: dict[str, Any]) -> str:
    for source in (
        dict(run.get("experiment_scorecard") or {}),
        dict(run.get("run_summary") or {}),
        run,
    ):
        for key in ("final_state", "status", "state"):
            value = str(source.get(key) or "").strip().lower()
            if value:
                return value
    return ""


def is_runtime_execution_run(run: dict[str, Any], *, artifact_name: str = "") -> bool:
    if not isinstance(run, dict):
        return False
    if artifact_name and _NON_RUNTIME_ARTIFACT_RE.search(artifact_name):
        return False
    if run.get("synthetic") is True and str(run.get("mode") or "").strip().lower() == "baseline-repair":
        return False
    if isinstance(run.get("outcomes"), list) and "count_requested" in run:
        return False
    checks = _normalize_run_checks(run)
    if checks:
        return True
    if "all_checks_passed" in run:
        return True
    terminal_state = _artifact_terminal_state(run)
    if terminal_state:
        return True
    scorecard = dict(run.get("experiment_scorecard") or {})
    if scorecard and any(key in scorecard for key in ("success", "status", "repair_count", "review_required")):
        return True
    run_summary = dict(run.get("run_summary") or {})
    if run_summary and any(key in run_summary for key in ("final_state", "status", "repair_count")):
        return True
    repair = dict(run.get("repair") or {})
    if isinstance(repair.get("repairs"), list):
        return True
    return False


def is_baseline_relevant_run(run: dict[str, Any], *, artifact_name: str = "") -> bool:
    return is_runtime_execution_run(run, artifact_name=artifact_name) or _repair_run_hotspot(run) is not None


def _repair_run_hotspot(run: dict[str, Any]) -> dict[str, Any] | None:
    if run.get("synthetic") is not True:
        return None
    if str(run.get("mode") or "").strip().lower() != "baseline-repair":
        return None
    if run.get("all_checks_passed") is not True:
        return None
    generated_at = _run_generated_at(run)
    if generated_at is None:
        return None
    summary = str(run.get("summary") or run.get("desc") or "").strip()
    path_hint = str(run.get("path_hint") or "").strip()
    classified = _classify_check(
        {
            "name": summary or str(run.get("objective_id") or run.get("ticket") or "baseline repair"),
            "stdout_tail": summary,
            "stderr_tail": path_hint,
        }
    )
    return {
        **classified,
        "generated_at": generated_at,
        "summary": summary or classified.get("summary") or "baseline repair",
        "path_hint": path_hint or classified.get("path_hint") or "",
    }


def _cluster_is_resolved(cluster: dict[str, Any], recent_runs: list[dict[str, Any]]) -> bool:
    hotspot = dict(cluster or {})
    latest_failure_at: datetime | None = None
    for run in recent_runs or []:
        generated_at = _run_generated_at(run)
        if generated_at is None:
            continue
        for check in _normalize_run_checks(run):
            if check.get("ok") is True:
                continue
            if _check_matches_hotspot(check, hotspot):
                if latest_failure_at is None or generated_at > latest_failure_at:
                    latest_failure_at = generated_at

    if latest_failure_at is None:
        return False

    for run in recent_runs or []:
        generated_at = _run_generated_at(run)
        if generated_at is None or generated_at < latest_failure_at:
            continue
        for check in _normalize_run_checks(run):
            if check.get("ok") is not True:
                continue
            if _check_matches_hotspot(check, hotspot):
                return True

    for run in recent_runs or []:
        repaired = _repair_run_hotspot(run)
        if not repaired:
            continue
        if repaired["generated_at"] < latest_failure_at:
            continue
        if _check_matches_hotspot(
            {
                "name": repaired.get("summary") or "baseline repair",
                "stdout_tail": repaired.get("summary") or "",
                "stderr_tail": repaired.get("path_hint") or "",
            },
            hotspot,
        ):
            return True
    return False


def _check_matches_hotspot(check: dict[str, Any], hotspot: dict[str, Any] | None) -> bool:
    if not hotspot:
        return False
    classified = _classify_check(check)
    signature = _hotspot_signature(hotspot)
    if signature and classified.get("signature") == signature:
        return True
    hotspot_path = str(hotspot.get("path_hint") or "").strip().lower()
    classified_path = str(classified.get("path_hint") or "").strip().lower()
    if hotspot_path and classified_path and hotspot_path == classified_path:
        return True
    return bool(
        str(hotspot.get("family") or "").strip().lower()
        and str(hotspot.get("family") or "").strip().lower() == str(classified.get("family") or "").strip().lower()
        and str(hotspot.get("summary") or "").strip().lower() == str(classified.get("summary") or "").strip().lower()
    )


def cluster_failures(recent_runs: list[dict[str, Any]], *, min_occurrences: int = 2) -> list[dict[str, Any]]:
    counts: Counter[str] = Counter()
    meta: dict[str, dict[str, Any]] = {}

    for run in recent_runs or []:
        ticket = str(run.get("ticket") or "").strip()
        generated_at = str(run.get("generated_at") or run.get("timestamp") or "").strip()
        for check in _normalize_run_checks(run):
            if check.get("ok") is True:
                continue
            classified = _classify_check(check)
            signature = classified["signature"]
            counts[signature] += 1
            entry = meta.setdefault(
                signature,
                {
                    **classified,
                    "tickets": set(),
                    "examples": [],
                },
            )
            if ticket:
                entry["tickets"].add(ticket)
            if len(entry["examples"]) < 4:
                entry["examples"].append(
                    {
                        "ticket": ticket,
                        "generated_at": generated_at,
                        "name": str(check.get("name") or ""),
                        "path_hint": classified.get("path_hint") or "",
                    }
                )

    clusters: list[dict[str, Any]] = []
    for signature, occurrences in counts.items():
        if occurrences < max(1, min_occurrences):
            continue
        entry = dict(meta[signature])
        tickets = sorted(entry.pop("tickets", set()))
        entry["signature"] = signature
        entry["occurrences"] = occurrences
        entry["unique_ticket_count"] = len(tickets)
        entry["tickets"] = tickets
        entry["severity"] = 100 if entry.get("shared_root") else (80 if occurrences >= 3 else 55)
        entry["repair_scope"] = "shared-root" if entry.get("shared_root") else "ticket-local"
        clusters.append(entry)

    clusters.sort(
        key=lambda item: (
            -int(item.get("severity") or 0),
            -int(item.get("occurrences") or 0),
            str(item.get("summary") or ""),
        )
    )
    return clusters


def select_hotspot(clusters: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not clusters:
        return None
    shared = [item for item in clusters if item.get("shared_root")]
    if shared:
        return shared[0]
    return clusters[0]


def collect_hotspot_checks(recent_runs: list[dict[str, Any]], hotspot: dict[str, Any] | None, *, limit: int = 6) -> list[dict[str, Any]]:
    if not hotspot:
        return []
    matched: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for run in recent_runs or []:
        ticket = str(run.get("ticket") or "").strip()
        generated_at = str(run.get("generated_at") or run.get("timestamp") or "").strip()
        for check in _normalize_run_checks(run):
            if check.get("ok") is True:
                continue
            if not _check_matches_hotspot(check, hotspot):
                continue
            key = (
                str(check.get("name") or "").strip(),
                " ".join(str(item) for item in (check.get("args") or [])),
                ticket,
            )
            if key in seen:
                continue
            seen.add(key)
            row = dict(check)
            row.setdefault("ticket", ticket)
            row.setdefault("generated_at", generated_at)
            matched.append(row)
            if len(matched) >= max(1, limit):
                return matched
    return matched


def build_shared_root_repair_objective(hotspot: dict[str, Any] | None, recent_runs: list[dict[str, Any]], *, limit: int = 6) -> dict[str, Any] | None:
    if not hotspot or not hotspot.get("shared_root"):
        return None
    summary = _hotspot_summary(hotspot)
    family = str(hotspot.get("family") or "baseline").strip().lower()
    path_hint = str(hotspot.get("path_hint") or "").strip()
    objective_id = f"baseline-repair-{_slugify(family)}-{_slugify(path_hint or summary)}".strip("-")
    checks = collect_hotspot_checks(recent_runs, hotspot, limit=limit)
    desc = (
        f"Repair the shared-root baseline hotspot '{summary}' so repo-wide validation returns to green. "
        "Pause normal backlog work until this repair validates cleanly."
    )
    return {
        "objective_id": objective_id,
        "ticket": objective_id,
        "desc": desc,
        "summary": summary,
        "family": family,
        "path_hint": path_hint,
        "shared_root": True,
        "repair_scope": str(hotspot.get("repair_scope") or "shared-root"),
        "source_tickets": list(hotspot.get("tickets") or []),
        "occurrences": int(hotspot.get("occurrences") or 0),
        "checks": checks,
        "synthetic": True,
    }


def analyze_baseline_health(recent_runs: list[dict[str, Any]], failure_clusters: list[dict[str, Any]]) -> dict[str, Any]:
    recent_failures = 0
    for run in recent_runs or []:
        checks = _normalize_run_checks(run)
        if any(check.get("ok") is False for check in checks):
            recent_failures += 1

    active_failure_clusters = [item for item in failure_clusters if not _cluster_is_resolved(item, recent_runs)]
    active_recent_failures = 0
    for run in recent_runs or []:
        generated_at = _run_generated_at(run)
        checks = _normalize_run_checks(run)
        if not checks:
            continue
        unresolved_failure = False
        for check in checks:
            if check.get("ok") is not False:
                continue
            if any(_check_matches_hotspot(check, cluster) for cluster in active_failure_clusters):
                unresolved_failure = True
                break
            if generated_at is None:
                unresolved_failure = True
                break
        if unresolved_failure:
            active_recent_failures += 1

    hotspot = select_hotspot(active_failure_clusters)
    shared_root_clusters = [item for item in active_failure_clusters if item.get("shared_root")]
    repeated_hotspots = [item for item in active_failure_clusters if int(item.get("occurrences") or 0) >= 3]
    repeated_ticket_local_hotspots = [item for item in repeated_hotspots if not item.get("shared_root")]

    state = "green"
    reason = "Baseline healthy."
    if shared_root_clusters:
        state = "red"
        if hotspot and hotspot.get("shared_root"):
            reason = f"Shared-root failure repeated: {_hotspot_summary(hotspot)}"
        elif hotspot:
            reason = f"Repeated hotspot failure: {_hotspot_summary(hotspot)}"
        else:
            reason = "Repeated baseline failures detected."
    elif repeated_ticket_local_hotspots:
        state = "yellow"
        if hotspot:
            reason = f"Repeated hotspot failure: {_hotspot_summary(hotspot)}"
        else:
            reason = "Repeated hotspot failures detected."
    elif active_failure_clusters or active_recent_failures:
        state = "yellow"
        reason = "Recent failures detected; baseline should be watched."

    backlog_paused = state == "red"
    self_heal_active = state == "red"
    return {
        "state": state,
        "blocked": backlog_paused,
        "reason": reason,
        "recentFailureCount": active_recent_failures,
        "clusterCount": len(failure_clusters),
        "clusters": failure_clusters,
        "hotspot": hotspot,
        "selfHealMode": self_heal_active,
        "backlogPaused": backlog_paused,
        "resumeCondition": "Resume backlog only after hotspot repair validates cleanly and baseline returns to green.",
    }


def is_baseline_blocked(baseline_state: dict[str, Any] | None) -> bool:
    if not isinstance(baseline_state, dict):
        return False
    return str(baseline_state.get("state") or "").lower() == "red" or bool(baseline_state.get("blocked"))


def load_recent_runs(project_root: Path, *, lookback_hours: int = 24, limit: int = 40) -> list[dict[str, Any]]:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max(1, lookback_hours))
    candidates: list[tuple[datetime, dict[str, Any]]] = []

    roots = [
        assistant_runs_dir(project_root),
        assistant_dev_runs_dir(project_root),
    ]
    seen: set[Path] = set()

    for root in roots:
        if not root.exists():
            continue
        for artifact in root.glob("*.json"):
            if artifact in seen:
                continue
            seen.add(artifact)
            if artifact.name.endswith("_status_suggestion.json") or artifact.name.startswith("assistant_"):
                continue
            try:
                payload = json.loads(artifact.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(payload, dict):
                continue
            if not is_baseline_relevant_run(payload, artifact_name=artifact.name):
                continue
            generated_at = _parse_iso(payload.get("generated_at") or payload.get("timestamp"))
            if generated_at is None:
                try:
                    generated_at = datetime.fromtimestamp(artifact.stat().st_mtime, tz=timezone.utc)
                except Exception:
                    generated_at = None
            if generated_at is None or generated_at < cutoff:
                continue
            payload.setdefault("generated_at", generated_at.isoformat())
            payload.setdefault("_artifact_name", artifact.name)
            candidates.append((generated_at, payload))

    candidates.sort(key=lambda item: item[0], reverse=True)
    return [payload for _generated_at, payload in candidates[: max(1, limit)]]


__all__ = [
    "analyze_baseline_health",
    "build_shared_root_repair_objective",
    "cluster_failures",
    "collect_hotspot_checks",
    "is_baseline_blocked",
    "is_baseline_relevant_run",
    "is_runtime_execution_run",
    "load_recent_runs",
    "select_hotspot",
]