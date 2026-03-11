#!/usr/bin/env python3
"""Solo Dev Assistant v1 pipeline runner.

This script wraps `dev_assistant.py` into a deterministic solo-dev flow:
understand -> plan -> scaffold -> verify -> learn.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

import dev_assistant as assistant
from analyze_dev_assistant_log import LOG_PATH, REPORT_PATH, parse_log, render_report, load_tickets as load_ticket_board


REPO_ROOT = Path(__file__).resolve().parents[2]
RUNS_DIR = REPO_ROOT / "docs" / "assistant_runs"
CFG_PATH = REPO_ROOT / "dev_assistant.yaml"
STATE_PATH = RUNS_DIR / "assistant_state.json"
DASHBOARD_PATH = RUNS_DIR / "assistant_dashboard.json"
SUMMARY_PATH = RUNS_DIR / "assistant_summary.md"
NOTIFICATION_LOG_PATH = RUNS_DIR / "notifications.log"
REPO_MAP_PATH = RUNS_DIR / "assistant_repo_map.json"
SKILLPACKS_PATH = RUNS_DIR / "assistant_skillpacks.json"
SANDBOX_ROOT = REPO_ROOT / ".assistant_sandboxes"

IGNORED_RELATED_PATTERNS = (
    "__pycache__/",
    ".pyc",
    "node_modules/",
    "/build/",
    "/dist/",
    ".egg-info/",
)

FRONTEND_WORKSPACE_MAP = {
    "customer-app": "@gosenderr/customer-app",
    "senderr-app": "@gosenderr/senderr-app",
    "admin-app": "@gosenderr/admin-app",
    "business-app": "@gosenderr/business-app",
}

DOMAIN_PRIORITY_KEYWORDS = {
    "dispatch": ("dispatch", "matching", "match", "senderr location", "accept job"),
    "job_board": ("job board", "available jobs", "job list", "view available jobs"),
    "tracking": ("tracking", "location", "start job", "complete job", "status"),
    "pricing": ("pricing", "fare", "surge", "quote", "heatmap", "demand"),
    "reputation": ("rating", "reputation", "review", "score"),
    "payments": ("payment", "wallet", "network pool", "payout", "capture"),
}

DOMAIN_PRIORITY_ORDER = {
    "dispatch": 60,
    "job_board": 55,
    "tracking": 50,
    "pricing": 45,
    "reputation": 35,
    "payments": 30,
}

DOMAIN_TERM_EXPANSIONS = {
    "dispatch": ("dispatch", "matching", "match", "worker", "queue", "task", "background", "redis"),
    "job_board": ("job", "board", "listing", "available"),
    "tracking": ("tracking", "location", "status", "progress"),
    "pricing": ("pricing", "price", "fare", "surge", "heatmap", "demand"),
    "reputation": ("rating", "review", "reputation", "score"),
    "payments": ("payment", "wallet", "payout", "ledger", "capture"),
}

SKILLPACK_DEFAULTS = {
    "dispatch": {
        "summary": "Dispatch work should prefer matching, queue, worker, and senderr-availability flows.",
        "keywords": ["dispatch", "matching", "queue", "worker", "redis", "availability", "assignment"],
        "preferred_paths": ["backend/app/services", "backend/app/workers", "backend/tests"],
        "verification_focus": ["compile backend app", "targeted pytest dispatch/matching tests"],
    },
    "job_board": {
        "summary": "Job-board work should focus on available jobs, listing endpoints, and senderr-facing job retrieval.",
        "keywords": ["job", "board", "listing", "available", "feed"],
        "preferred_paths": ["backend/app/api/routes", "backend/app/services", "frontend/apps/senderr-app"],
        "verification_focus": ["backend route compile", "frontend workspace typecheck when UI is touched"],
    },
    "tracking": {
        "summary": "Tracking changes should preserve job lifecycle and location/status updates.",
        "keywords": ["tracking", "location", "status", "progress", "lifecycle"],
        "preferred_paths": ["backend/app/services", "backend/app/api/routes", "frontend/apps/customer-app", "frontend/apps/senderr-app"],
        "verification_focus": ["compile backend app", "frontend workspace typecheck when UI is touched"],
    },
    "pricing": {
        "summary": "Pricing work should stay scoped to fare, quote, surge, and demand logic.",
        "keywords": ["pricing", "price", "fare", "surge", "quote", "demand", "heatmap"],
        "preferred_paths": ["backend/app/services", "backend/tests", "docs"],
        "verification_focus": ["compile backend app", "targeted pytest pricing tests"],
    },
    "reputation": {
        "summary": "Reputation work should focus on ratings, reviews, and score aggregation.",
        "keywords": ["rating", "review", "reputation", "score"],
        "preferred_paths": ["backend/app/services", "backend/app/models", "backend/tests"],
        "verification_focus": ["compile backend app", "targeted pytest reputation tests"],
    },
    "payments": {
        "summary": "Payments work should preserve wallet balances, capture flows, and GoSenderr Network Pool consistency.",
        "keywords": ["payment", "wallet", "capture", "payout", "network pool", "ledger"],
        "preferred_paths": ["backend/app/services", "backend/app/models", "backend/tests"],
        "verification_focus": ["compile backend app", "targeted pytest payments tests"],
    },
}

SAFE_BLOCKED_TAGS_DEFAULT = {"SEC", "AUTH", "PAYMENT", "MIGRATION", "WALLET"}
SAFE_BLOCKED_DOMAINS_DEFAULT = {"payments"}
SAFE_BLOCKED_TERMS_DEFAULT = ("auth", "payment", "wallet", "network pool", "security", "migration")

DOMAIN_NEGATIVE_TERMS = {
    "dispatch": {"pricing", "surge", "fare", "heatmap", "demand"},
    "pricing": {"dispatch", "matching", "queue", "worker", "redis"},
    "payments": {"dispatch", "matching", "surge", "heatmap"},
}

GENERIC_BACKEND_TERMS = {
    "backend",
    "service",
    "services",
    "model",
    "models",
    "route",
    "routes",
    "api",
    "deploy",
    "move",
    "implementation",
    "feature",
    "system",
    "module",
}

STOPWORDS = {
    "add",
    "and",
    "api",
    "apps",
    "auto",
    "backend",
    "based",
    "board",
    "build",
    "customer",
    "data",
    "done",
    "feature",
    "for",
    "from",
    "frontend",
    "have",
    "into",
    "list",
    "model",
    "new",
    "only",
    "portal",
    "route",
    "senderr",
    "support",
    "system",
    "task",
    "tests",
    "the",
    "this",
    "todo",
    "with",
}


@dataclass
class CheckCommand:
    name: str
    args: list[str]
    cwd: Path
    required: bool = True  # if False, command failure is treated as warning/skipped


@dataclass
class TicketPlan:
    ticket_id: str
    desc: str
    mode: str
    tags: list[str]
    keywords: list[str]
    priority_tag: str
    domain_focus: str
    domain_terms: list[str]
    explicit_dependencies: list[str]
    prefer_domain: str | None
    frontend_workspace: str | None
    scaffold_files: list[str]
    related_files: list[str]
    existing_targets: list[str]
    new_files: list[dict]
    verify_commands: list[CheckCommand]
    ship_commands: list[str]
    repo_hint_paths: list[str] | None = None
    memory_hint_paths: list[str] | None = None
    memory_summary: dict[str, Any] | None = None


PROFILE_MAP = {
    "preview": {"use_ai": False, "write": False, "git": False},
    "write": {"use_ai": False, "write": True, "git": False},
    "aiWrite": {"use_ai": True, "write": True, "git": False},
    "aiWriteGit": {"use_ai": True, "write": True, "git": True},
}
IMPLEMENT_PROFILE_CHOICES = ("write", "aiWrite", "aiWriteGit")
SPRINT_ACTION_CHOICES = ("run", "implement")

TAG_TEMPLATE_MAP = {
    "SEC": "sec_hardening_bundle",
    "OPS": "ops_ops_bundle",
}


def _normalize_ticket_id(raw: str) -> str:
    value = assistant._normalize_ticket_id(raw)
    if not value:
        raise ValueError(f"invalid BAT ticket id: {raw}")
    return value


def _quoted(args: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in args)


def _backend_python_bin() -> str:
    backend_py = REPO_ROOT / "backend" / ".venv" / "bin" / "python"
    if backend_py.exists() and os.access(backend_py, os.X_OK):
        return str(backend_py)
    return sys.executable


def _load_root_cfg() -> dict[str, Any]:
    if not CFG_PATH.exists():
        return {}
    try:
        import yaml  # type: ignore
    except ImportError:
        return {}
    try:
        with open(CFG_PATH, encoding="utf-8") as handle:
            return yaml.safe_load(handle) or {}
    except Exception:
        return {}


def _cfg_bool(cfg: dict[str, Any], key: str, default: bool = False) -> bool:
    value = cfg.get(key, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _cfg_list(cfg: dict[str, Any], key: str, default: list[str] | tuple[str, ...] | set[str] | None = None) -> list[str]:
    value = cfg.get(key)
    if value is None:
        value = list(default or [])
    if isinstance(value, str):
        return [part.strip() for part in re.split(r"[,|]", value) if part.strip()]
    if isinstance(value, (list, tuple, set)):
        return [str(part).strip() for part in value if str(part).strip()]
    return [str(value).strip()] if str(value).strip() else []


def _ensure_runs_dir() -> None:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)


def _write_json_artifact(path: Path, payload: dict[str, Any]) -> None:
    _ensure_runs_dir()
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _load_state() -> dict[str, Any]:
    if not STATE_PATH.exists():
        return {"tickets": {}, "updated_at": None}
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"tickets": {}, "updated_at": None}
    if not isinstance(data, dict):
        return {"tickets": {}, "updated_at": None}
    data.setdefault("tickets", {})
    return data


def _load_json_dict(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _load_memory_entries() -> list[dict[str, Any]]:
    try:
        entries = assistant.load_memory()
    except Exception:
        return []
    return entries if isinstance(entries, list) else []


def _parse_memory_strategy(strategy: str) -> tuple[str | None, str | None, str | None]:
    parts = [part.strip().lower() for part in str(strategy).split(":") if part.strip()]
    if len(parts) >= 4 and parts[0] == "solo":
        return parts[1], parts[2], parts[3]
    return None, None, None


def _memory_insights_for_domain(domain_focus: str, *, mode: str | None = None) -> dict[str, Any]:
    entries = _load_memory_entries()
    successes = 0
    failures = 0
    recent_files: list[str] = []

    for entry in reversed(entries):
        if not isinstance(entry, dict):
            continue
        _command, domain, mem_mode = _parse_memory_strategy(str(entry.get("strategy", "")))
        if domain != domain_focus:
            continue
        if mode and mem_mode and mem_mode != mode:
            continue
        validation = str(entry.get("validation", "")).strip().lower()
        if validation == "passed":
            successes += 1
        elif validation == "failed":
            failures += 1
        for file_path in entry.get("files_written", []) or []:
            normalized = str(file_path).replace("\\", "/")
            if normalized and normalized not in recent_files:
                recent_files.append(normalized)

    return {
        "successes": successes,
        "failures": failures,
        "suggested_files": recent_files[:8],
    }


def _save_state(state: dict[str, Any]) -> None:
    _ensure_runs_dir()
    state["updated_at"] = datetime.now(timezone.utc).isoformat()
    STATE_PATH.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def _clean_paths(paths: list[str], *, limit: int | None = None) -> list[str]:
    cleaned: list[str] = []
    for path in paths:
        normalized = path.replace("\\", "/")
        if any(pattern in normalized for pattern in IGNORED_RELATED_PATTERNS):
            continue
        if normalized not in cleaned:
            cleaned.append(normalized)
        if limit is not None and len(cleaned) >= limit:
            break
    return cleaned


def _default_skillpacks() -> dict[str, Any]:
    packs: dict[str, Any] = {}
    for domain, payload in SKILLPACK_DEFAULTS.items():
        packs[domain] = {
            "summary": payload["summary"],
            "keywords": list(payload["keywords"]),
            "preferred_paths": list(payload["preferred_paths"]),
            "verification_focus": list(payload["verification_focus"]),
        }
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "packs": packs,
    }


def _ensure_skillpacks(*, refresh: bool = False) -> dict[str, Any]:
    if not refresh:
        existing = _load_json_dict(SKILLPACKS_PATH)
        if existing and isinstance(existing.get("packs"), dict):
            return existing
    payload = _default_skillpacks()
    _write_json_artifact(SKILLPACKS_PATH, payload)
    return payload


def _infer_domain_from_path(path: str) -> str:
    normalized = path.lower().replace("\\", "/")
    best = "general"
    best_score = 0
    for domain, terms in DOMAIN_TERM_EXPANSIONS.items():
        score = 0
        for term in terms:
            score += _path_term_overlap(normalized, term)
        if score > best_score:
            best = domain
            best_score = score
    return best if best_score > 0 else "general"


def _generate_repo_map(*, files: list[str] | None = None, max_domain_files: int = 16, max_dirs: int = 40) -> dict[str, Any]:
    repo_files = _clean_paths(files or _list_repo_files())
    interesting = [path for path in repo_files if path.startswith(("backend/", "frontend/", "docs/"))]
    directory_rows: dict[str, dict[str, Any]] = {}
    domain_rows: dict[str, dict[str, Any]] = {}

    for path in interesting:
        parent = str(Path(path).parent).replace("\\", "/")
        directory_entry = directory_rows.setdefault(parent, {"count": 0, "sample_files": [], "domains": {}})
        directory_entry["count"] += 1
        if len(directory_entry["sample_files"]) < 4:
            directory_entry["sample_files"].append(path)

        domain = _infer_domain_from_path(path)
        if domain == "general":
            continue
        directory_entry["domains"][domain] = int(directory_entry["domains"].get(domain, 0)) + 1
        domain_entry = domain_rows.setdefault(domain, {"count": 0, "files": [], "directories": []})
        domain_entry["count"] += 1
        if len(domain_entry["files"]) < max_domain_files:
            domain_entry["files"].append(path)
        if parent not in domain_entry["directories"]:
            domain_entry["directories"].append(parent)

    directories = [
        {
            "path": path,
            "count": row["count"],
            "domains": row["domains"],
            "sample_files": row["sample_files"],
        }
        for path, row in sorted(directory_rows.items(), key=lambda item: (-item[1]["count"], item[0]))[:max_dirs]
    ]
    domains = {
        domain: {
            "count": row["count"],
            "files": row["files"],
            "directories": sorted(row["directories"]),
        }
        for domain, row in sorted(domain_rows.items())
    }
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "file_count": len(interesting),
        "directories": directories,
        "domains": domains,
    }


def _ensure_repo_map(*, refresh: bool = False) -> dict[str, Any]:
    if not refresh:
        existing = _load_json_dict(REPO_MAP_PATH)
        if existing and isinstance(existing.get("domains"), dict):
            return existing
    payload = _generate_repo_map()
    _write_json_artifact(REPO_MAP_PATH, payload)
    return payload


def _repo_hint_paths_for_domain(repo_map: dict[str, Any], domain_focus: str, *, desc: str = "", limit: int = 8) -> list[str]:
    domain_row = repo_map.get("domains", {}).get(domain_focus, {})
    if not isinstance(domain_row, dict):
        return []
    files = _clean_paths(domain_row.get("files", []) or [])
    pack = _skill_pack_for_domain(domain_focus)
    preferred_paths = [str(path).replace("\\", "/") for path in pack.get("preferred_paths", [])]
    domain_terms = _engine_domain_terms(desc or domain_focus, domain_focus=domain_focus)

    def sort_key(path: str) -> tuple[int, int, str]:
        preferred = 1 if any(path.startswith(prefix.rstrip("/") + "/") or path == prefix.rstrip("/") for prefix in preferred_paths) else 0
        score = _file_relevance_score(path, domain_terms=domain_terms, domain_focus=domain_focus, prefer_domain=domain_focus)
        return (-preferred, -score, path)

    files.sort(key=sort_key)
    return files[:limit]


def _repo_domain_depth_score(repo_map: dict[str, Any], domain_focus: str) -> int:
    domain_row = repo_map.get("domains", {}).get(domain_focus, {})
    if not isinstance(domain_row, dict):
        return 0
    count = int(domain_row.get("count", 0) or 0)
    return min(10, count // 4)


def _memory_selection_bias(row: dict[str, Any]) -> int:
    insights = _memory_insights_for_domain(str(row.get("domain_focus", "general")), mode=str(row.get("mode", "")) or None)
    successes = int(insights.get("successes", 0) or 0)
    failures = int(insights.get("failures", 0) or 0)
    if successes == 0 and failures == 0:
        return 0
    if successes > failures:
        return min(12, (successes - failures) * 4)
    if failures > successes:
        return -min(12, (failures - successes) * 4)
    return 0


def _skill_pack_for_domain(domain_focus: str) -> dict[str, Any]:
    packs = _ensure_skillpacks().get("packs", {})
    pack = packs.get(domain_focus, {})
    return pack if isinstance(pack, dict) else {}


def _engine_domain_terms(
    desc: str,
    *,
    domain_focus: str,
    prefer_domain: str | None = None,
    existing_terms: list[str] | None = None,
) -> list[str]:
    terms = list(existing_terms or _extract_domain_terms(desc, prefer_domain=prefer_domain))
    pack = _skill_pack_for_domain(prefer_domain or domain_focus)
    for term in pack.get("keywords", []):
        normalized = str(term).strip().lower()
        if normalized and normalized not in terms:
            terms.append(normalized)
    return terms[:18]


def _parse_priority_tag(tags: list[str]) -> str:
    for tag in tags:
        if re.fullmatch(r"P\d+", tag):
            return tag
    return "P9"


def _priority_score(tags: list[str]) -> int:
    tag = _parse_priority_tag(tags)
    try:
        level = int(tag[1:])
    except ValueError:
        level = 9
    return max(0, 100 - level * 10)


def _domain_focus(desc: str) -> str:
    lower = desc.lower()
    best = "general"
    best_score = -1
    for domain, keywords in DOMAIN_PRIORITY_KEYWORDS.items():
        score = sum(1 for keyword in keywords if keyword in lower)
        if score > best_score:
            best = domain
            best_score = score
    return best


def _domain_score(desc: str) -> int:
    return DOMAIN_PRIORITY_ORDER.get(_domain_focus(desc), 10)


def _extract_dependency_terms(desc: str) -> list[str]:
    deps: list[str] = []
    for raw_tag in re.findall(r"\[([^\]]+)\]", desc):
        upper = raw_tag.upper()
        if "DEP:" not in upper:
            continue
        for part in re.split(r"[/,|]+", raw_tag):
            cleaned = part.strip()
            if cleaned.upper().startswith("DEP:"):
                dep = cleaned.split(":", 1)[1].strip().lower()
                if dep and dep not in deps:
                    deps.append(dep)
    return deps


def _extract_domain_terms(desc: str, *, prefer_domain: str | None = None) -> list[str]:
    lower = desc.lower().replace("-", " ")
    raw_tokens = re.findall(r"[a-z][a-z0-9_]{2,}", lower)
    terms: list[str] = []
    domain_focus = prefer_domain or _domain_focus(desc)

    for expanded in DOMAIN_TERM_EXPANSIONS.get(domain_focus, ()):
        if expanded not in terms:
            terms.append(expanded)

    for token in raw_tokens:
        if token in STOPWORDS or token in GENERIC_BACKEND_TERMS:
            continue
        if token not in terms:
            terms.append(token)

    if any(token in lower for token in ("redis", "worker", "queue", "background", "task", "tasks", "matching", "dispatch")):
        for token in ("redis", "worker", "queue", "task", "background", "matching", "dispatch"):
            if token in lower and token not in terms:
                terms.insert(0, token)

    ordered: list[str] = []
    for term in terms:
        normalized = term.strip().lower()
        if not normalized or normalized in ordered:
            continue
        ordered.append(normalized)
    return ordered[:14]


def _path_term_overlap(path: str, term: str) -> int:
    normalized = path.lower().replace("-", "_")
    stem = Path(normalized).stem
    parts = [part for part in re.split(r"[/_\.]+", normalized) if part]
    score = 0
    if term == stem:
        score += 12
    if term in parts:
        score += 8
    if f"/{term}/" in normalized:
        score += 8
    if term in stem:
        score += 6
    if term in normalized:
        score += 3
    return score


def _file_relevance_score(
    path: str,
    *,
    domain_terms: list[str],
    domain_focus: str,
    prefer_domain: str | None = None,
) -> int:
    normalized = path.lower().replace("\\", "/")
    positives = 0
    strong_hits = 0
    score = 0

    for index, term in enumerate(domain_terms):
        overlap = _path_term_overlap(normalized, term)
        if overlap <= 0:
            continue
        positives += overlap
        if overlap >= 8:
            strong_hits += 1
        score += overlap + max(0, 6 - index)

    preferred = prefer_domain or domain_focus
    for boosted in DOMAIN_TERM_EXPANSIONS.get(preferred, ()):
        overlap = _path_term_overlap(normalized, boosted)
        if overlap >= 8:
            score += 10
            strong_hits += 1

    negative_hits = 0
    for negative in DOMAIN_NEGATIVE_TERMS.get(preferred, set()):
        overlap = _path_term_overlap(normalized, negative)
        if overlap > 0:
            negative_hits += overlap

    if negative_hits and strong_hits == 0:
        score -= negative_hits * 2
    elif negative_hits and positives < negative_hits:
        score -= negative_hits

    stem = Path(normalized).stem
    if stem.count("_") >= 5 and strong_hits == 0:
        score -= 10
    if normalized.startswith("backend/tests/") and not any(term in stem for term in domain_terms):
        score -= 4
    if normalized.startswith("backend/app/") and "/services/" in normalized:
        score += 2
    return score


def _is_relevant_path(
    path: str,
    *,
    domain_terms: list[str],
    domain_focus: str,
    prefer_domain: str | None = None,
    minimum_score: int = 8,
) -> bool:
    return _file_relevance_score(
        path,
        domain_terms=domain_terms,
        domain_focus=domain_focus,
        prefer_domain=prefer_domain,
    ) >= minimum_score


def _frontend_workspace(paths: list[str]) -> str | None:
    for path in paths:
        normalized = path.replace("\\", "/")
        for folder, workspace in FRONTEND_WORKSPACE_MAP.items():
            if f"frontend/apps/{folder}/" in normalized or f"backend/frontend/apps/{folder}/" in normalized:
                return workspace
    return None


def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _recent_ticket_runs(action: str) -> dict[str, datetime]:
    suffix = "implement" if action == "implement" else "run"
    latest: dict[str, datetime] = {}
    if not RUNS_DIR.exists():
        return latest

    for artifact in RUNS_DIR.glob(f"BAT*_{suffix}.json"):
        match = re.match(r"BAT(\d+)_", artifact.name)
        if not match:
            continue
        try:
            payload = json.loads(artifact.read_text(encoding="utf-8"))
        except Exception:
            continue
        generated_at = _parse_iso_datetime(payload.get("generated_at"))
        if not generated_at:
            continue
        ticket_id = match.group(1)
        previous = latest.get(ticket_id)
        if previous is None or generated_at > previous:
            latest[ticket_id] = generated_at
    return latest


def _safe_repo_path(path: str) -> Path | None:
    target = (REPO_ROOT / path).resolve()
    if target == REPO_ROOT or REPO_ROOT in target.parents:
        return target
    return None


def _run_cmd(
    args: list[str],
    *,
    cwd: Path | None = None,
    check: bool = False,
    capture: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=str(cwd) if cwd else str(REPO_ROOT),
        text=True,
        capture_output=capture,
        check=check,
    )


def _ticket_failure_signature(check_results: list[dict[str, Any]]) -> str:
    failures: list[str] = []
    for row in check_results:
        if row.get("ok"):
            continue
        failures.append(
            "|".join(
                [
                    str(row.get("name", "")),
                    str(row.get("exit_code", "")),
                    str(row.get("stdout_tail", ""))[-280:],
                    str(row.get("stderr_tail", ""))[-280:],
                ]
            )
        )
    return "\n".join(failures)


def _state_ticket_entry(state: dict[str, Any], ticket_id: str) -> dict[str, Any]:
    tickets = state.setdefault("tickets", {})
    entry = tickets.setdefault(ticket_id, {})
    entry.setdefault("history", [])
    return entry


def _is_ticket_temporarily_blocked(state: dict[str, Any], ticket_id: str, now: datetime) -> tuple[bool, str]:
    ticket_state = state.get("tickets", {}).get(ticket_id, {})
    blocked_until = _parse_iso_datetime(ticket_state.get("blocked_until"))
    if blocked_until and blocked_until > now:
        reason = str(ticket_state.get("block_reason") or "recent repeated failures")
        return True, reason
    return False, ""


def _record_ticket_state(
    *,
    ticket_id: str,
    plan: TicketPlan,
    action: str,
    exit_code: int,
    check_results: list[dict[str, Any]],
    cfg: dict[str, Any],
    blocked_reason: str = "",
) -> None:
    state = _load_state()
    ticket_state = _state_ticket_entry(state, ticket_id)
    now = datetime.now(timezone.utc)
    entry = {
        "action": action,
        "mode": plan.mode,
        "priority": plan.priority_tag,
        "domain_focus": plan.domain_focus,
        "generated_at": now.isoformat(),
        "exit_code": exit_code,
        "all_checks_passed": all(row.get("ok") for row in check_results) if check_results else exit_code == 0,
        "failure_signature": _ticket_failure_signature(check_results),
        "blocked_reason": blocked_reason,
    }
    history = ticket_state.setdefault("history", [])
    history.append(entry)
    ticket_state["history"] = history[-12:]
    ticket_state["last_run_at"] = now.isoformat()
    ticket_state["last_action"] = action
    ticket_state["last_mode"] = plan.mode
    ticket_state["last_priority"] = plan.priority_tag
    ticket_state["last_domain_focus"] = plan.domain_focus

    block_minutes = int(cfg.get("autopilot_failure_block_minutes") or 180)
    if exit_code == 0 and all(row.get("ok") for row in check_results if not row.get("skipped")):
        ticket_state["last_success_at"] = now.isoformat()
        ticket_state.pop("blocked_until", None)
        ticket_state.pop("block_reason", None)
        ticket_state["repeat_failures"] = 0
    else:
        current_signature = entry["failure_signature"]
        previous = history[-2] if len(history) >= 2 else None
        if current_signature and previous and current_signature == previous.get("failure_signature"):
            ticket_state["repeat_failures"] = int(ticket_state.get("repeat_failures", 1)) + 1
        else:
            ticket_state["repeat_failures"] = 1
        if blocked_reason:
            ticket_state["block_reason"] = blocked_reason
        elif ticket_state.get("repeat_failures", 0) >= 3 and block_minutes > 0:
            ticket_state["block_reason"] = "repeated identical failures"
            ticket_state["blocked_until"] = (now + timedelta(minutes=block_minutes)).isoformat()
    _save_state(state)


def _ticket_selection_score(
    row: dict[str, Any],
    *,
    now: datetime,
    recent_runs: dict[str, datetime],
    state: dict[str, Any],
    repo_map: dict[str, Any],
) -> int:
    score = _priority_score(row.get("tags", [])) + _domain_score(row.get("desc", ""))
    if "BE" in row.get("tags", []):
        score += 15
    if "SEC" in row.get("tags", []):
        score += 10
    score += _repo_domain_depth_score(repo_map, str(row.get("domain_focus", "general")))
    score += _memory_selection_bias(row)
    recent_run = recent_runs.get(row["ticket_id"])
    if recent_run is None:
        score += 8
    else:
        score += min(12, int((now - recent_run).total_seconds() // 3600))
    ticket_state = state.get("tickets", {}).get(row["ticket_id"], {})
    if ticket_state.get("last_success_at"):
        score -= 5
    repeat_failures = int(ticket_state.get("repeat_failures", 0) or 0)
    score -= repeat_failures * 10
    return score


def _write_status_suggestion(ticket_id: str, plan: TicketPlan, *, exit_code: int, check_results: list[dict[str, Any]], blocked_reason: str = "") -> None:
    _ensure_runs_dir()
    suggestion = "TODO"
    rationale = "implementation requires follow-up"
    if blocked_reason:
        suggestion = "BLOCKED"
        rationale = blocked_reason
    elif exit_code == 0 and all(row.get("ok") for row in check_results if not row.get("skipped")):
        suggestion = "IN_REVIEW"
        rationale = "checks passed; ready for manual review and BAT board update"

    payload = {
        "ticket": ticket_id,
        "suggested_status": suggestion,
        "rationale": rationale,
        "mode": plan.mode,
        "priority": plan.priority_tag,
        "domain_focus": plan.domain_focus,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    (RUNS_DIR / f"BAT{ticket_id}_status_suggestion.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    md = [
        f"# BAT<{ticket_id}> Status Suggestion",
        "",
        f"- Suggested status: {suggestion}",
        f"- Rationale: {rationale}",
        f"- Mode: {plan.mode}",
        f"- Priority: {plan.priority_tag}",
        f"- Domain focus: {plan.domain_focus}",
    ]
    (RUNS_DIR / f"BAT{ticket_id}_status_suggestion.md").write_text("\n".join(md) + "\n", encoding="utf-8")


def _maybe_close_bat_ticket(ticket_id: str, *, check_results: list[dict[str, Any]], cfg: dict[str, Any]) -> dict[str, Any]:
    if not _cfg_bool(cfg, "assistant_auto_close_bats", False):
        return {"updated": False, "reason": "disabled"}

    board_path = REPO_ROOT / "docs" / "BAT_FEATURE_BOARD.md"
    if not board_path.exists():
        return {"updated": False, "reason": "board missing"}

    all_passed = all(row.get("ok") for row in check_results) if check_results else False
    if not all_passed:
        return {"updated": False, "reason": "checks not all passed"}

    try:
        lines = board_path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return {"updated": False, "reason": "read failed"}

    updated = False
    saw_test_signal = any(
        ("pytest" in str(row.get("name", "")).lower()) or ("typecheck" in str(row.get("name", "")).lower())
        for row in check_results
        if not row.get("skipped")
    )
    for index, line in enumerate(lines):
        if f"BAT<{ticket_id}>" not in line:
            continue
        new_line = line
        new_line = re.sub(r"\[TODO\]", "[DONE]", new_line, count=1)
        if saw_test_signal:
            if "[UNTESTED]" in new_line:
                new_line = new_line.replace("[UNTESTED]", "[TESTED]", 1)
            elif "[TESTED]" not in new_line and "[DONE]" in new_line:
                new_line = new_line.replace("[DONE]", "[DONE][TESTED]", 1)
        if new_line != line:
            lines[index] = new_line
            updated = True
        break

    if not updated:
        return {"updated": False, "reason": "no matching TODO line changed"}

    board_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"updated": True, "reason": "board updated", "path": str(board_path.relative_to(REPO_ROOT))}


def _update_assistant_dashboard() -> None:
    _ensure_runs_dir()
    entries: list[dict[str, Any]] = []
    for artifact in RUNS_DIR.glob("BAT*.json"):
        if artifact.name.endswith("_status_suggestion.json"):
            continue
        try:
            payload = json.loads(artifact.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(payload, dict) or "ticket" not in payload:
            continue
        entries.append(payload)

    entries.sort(key=lambda row: row.get("generated_at", ""), reverse=True)
    recent = entries[:50]
    pass_count = sum(1 for row in recent if row.get("all_checks_passed") is True)
    fail_count = sum(1 for row in recent if row.get("checks") and row.get("all_checks_passed") is False)
    dashboard = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "recent_count": len(recent),
        "pass_count": pass_count,
        "fail_count": fail_count,
        "pass_rate": round((pass_count / len(recent)) * 100, 1) if recent else 0.0,
        "recent_tickets": [
            {
                "ticket": row.get("ticket"),
                "command": row.get("command"),
                "all_checks_passed": row.get("all_checks_passed"),
                "generated_at": row.get("generated_at"),
            }
            for row in recent[:12]
        ],
    }
    DASHBOARD_PATH.write_text(json.dumps(dashboard, indent=2) + "\n", encoding="utf-8")

    lines = [
        "# Assistant Summary",
        "",
        f"- Generated: {dashboard['generated_at']}",
        f"- Recent runs: {dashboard['recent_count']}",
        f"- Pass rate: {dashboard['pass_rate']}%",
        f"- Passed: {pass_count}",
        f"- Failed: {fail_count}",
        "",
        "## Recent Tickets",
    ]
    for row in dashboard["recent_tickets"]:
        state = "PASS" if row.get("all_checks_passed") else "FAIL"
        lines.append(f"- BAT<{row.get('ticket')}> [{state}] {row.get('command')} at {row.get('generated_at')}")
    SUMMARY_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_self_critique(
    *,
    ticket_id: str,
    command: str,
    plan: TicketPlan,
    created_files: list[str],
    targeted_tests: list[str],
    check_results: list[dict[str, Any]],
    blocked_reason: str = "",
) -> dict[str, Any]:
    _ensure_runs_dir()
    strengths: list[str] = []
    gaps: list[str] = []
    next_actions: list[str] = []

    if created_files:
        strengths.append(f"Touched {len(created_files)} scaffolded or generated file(s).")
    else:
        strengths.append("Stayed integration-first without forcing new scaffold files.")

    if targeted_tests:
        strengths.append(f"Selected {len(targeted_tests)} targeted test file(s) for scoped validation.")
    elif plan.mode != "frontend":
        gaps.append("No targeted backend tests were selected for this run.")

    failing = [str(row.get("name", "unknown check")) for row in check_results if not row.get("ok")]
    if failing:
        gaps.append("Failing checks: " + ", ".join(failing[:4]))
        next_actions.append("Repair failing checks before ship automation or BAT status promotion.")
    else:
        strengths.append("Current verification set passed.")

    if blocked_reason:
        gaps.append(blocked_reason)
        next_actions.append("Tighten validation scope before the next automated repair pass.")

    pack = _skill_pack_for_domain(plan.prefer_domain or plan.domain_focus)
    for focus in pack.get("verification_focus", []):
        text = str(focus).strip()
        if text and text not in next_actions and failing:
            next_actions.append(text)

    if not next_actions:
        next_actions.append("Review the diff, update the BAT board, and continue with the next highest-priority ticket.")

    payload = {
        "ticket": ticket_id,
        "command": command,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": plan.mode,
        "priority_tag": plan.priority_tag,
        "domain_focus": plan.domain_focus,
        "skill_pack_summary": pack.get("summary", ""),
        "strengths": strengths,
        "gaps": gaps,
        "next_actions": next_actions,
    }
    critique_json = RUNS_DIR / f"BAT{ticket_id}_{command}_critique.json"
    critique_md = RUNS_DIR / f"BAT{ticket_id}_{command}_critique.md"
    critique_json.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    md_lines = [
        f"# BAT<{ticket_id}> {command.title()} Critique",
        "",
        f"- Mode: {plan.mode}",
        f"- Priority: {plan.priority_tag}",
        f"- Domain focus: {plan.domain_focus}",
        "",
        "## Strengths",
    ]
    md_lines.extend(f"- {row}" for row in strengths)
    md_lines.append("")
    md_lines.append("## Gaps")
    if gaps:
        md_lines.extend(f"- {row}" for row in gaps)
    else:
        md_lines.append("- none")
    md_lines.append("")
    md_lines.append("## Next Actions")
    md_lines.extend(f"- {row}" for row in next_actions)
    critique_md.write_text("\n".join(md_lines) + "\n", encoding="utf-8")
    return payload


def _record_engine_memory(ticket_id: str, command: str, plan: TicketPlan, created_files: list[str], all_checks_passed: bool) -> None:
    strategy = f"solo:{command}:{plan.domain_focus}:{plan.mode}"
    try:
        assistant.record_memory(ticket_id, strategy, created_files, all_checks_passed)
    except Exception:
        pass


def _safe_settings(args: argparse.Namespace, cfg: dict[str, Any]) -> dict[str, Any]:
    max_files_default = int(cfg.get("assistant_safe_max_files") or cfg.get("assistant_max_scaffold_files") or 6)
    sandbox_dir = getattr(args, "sandbox_dir", None) or cfg.get("assistant_sandbox_dir") or str(SANDBOX_ROOT)
    return {
        "enabled": bool(getattr(args, "safe_mode", False) or _cfg_bool(cfg, "assistant_safe_mode", False)),
        "max_files": max(1, int(getattr(args, "safe_max_files", 0) or max_files_default)),
        "blocked_tags": {value.upper() for value in _cfg_list(cfg, "assistant_safe_blocked_tags", SAFE_BLOCKED_TAGS_DEFAULT)},
        "blocked_domains": {value.lower() for value in _cfg_list(cfg, "assistant_safe_blocked_domains", SAFE_BLOCKED_DOMAINS_DEFAULT)},
        "blocked_terms": [value.lower() for value in _cfg_list(cfg, "assistant_safe_blocked_terms", SAFE_BLOCKED_TERMS_DEFAULT)],
        "allow_protected": bool(getattr(args, "allow_protected", False) or _cfg_bool(cfg, "assistant_safe_allow_protected", False)),
        "allow_ship": bool(getattr(args, "allow_ship_in_safe_mode", False) or _cfg_bool(cfg, "assistant_safe_allow_ship", False)),
        "prepare_sandbox": bool(getattr(args, "prepare_sandbox", False) or _cfg_bool(cfg, "assistant_safe_prepare_sandbox", False)),
        "sandbox_dir": str(sandbox_dir),
    }


def _safe_guard_reason(plan: TicketPlan, settings: dict[str, Any]) -> str:
    if not settings.get("enabled"):
        return ""
    if settings.get("allow_protected"):
        return ""
    blocked_tags = settings.get("blocked_tags", set())
    tags = {tag.upper() for tag in plan.tags}
    if blocked_tags & tags:
        return f"safe mode blocked protected tags: {', '.join(sorted(blocked_tags & tags))}"
    if str(plan.domain_focus).lower() in settings.get("blocked_domains", set()):
        return f"safe mode blocked protected domain: {plan.domain_focus}"
    lower = plan.desc.lower()
    matched_terms = [term for term in settings.get("blocked_terms", []) if term in lower]
    if matched_terms:
        return f"safe mode blocked protected terms: {', '.join(matched_terms[:4])}"
    return ""


def _current_git_branch() -> str:
    result = _run_cmd(["git", "branch", "--show-current"], capture=True)
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def _resolve_sandbox_base_dir(sandbox_dir: str) -> Path:
    candidate = Path(sandbox_dir).expanduser()
    if not candidate.is_absolute():
        candidate = (REPO_ROOT.parent / candidate).resolve()
    else:
        candidate = candidate.resolve()

    repo_root = REPO_ROOT.resolve()
    if candidate == repo_root or repo_root in candidate.parents:
        candidate = (repo_root.parent / candidate.name).resolve()
    return candidate


def _managed_sandbox_base_dirs(sandbox_dir: str | None = None) -> list[Path]:
    configured = _resolve_sandbox_base_dir(sandbox_dir or str(SANDBOX_ROOT))
    legacy = (REPO_ROOT / Path(sandbox_dir or str(SANDBOX_ROOT)).name).resolve()
    paths: list[Path] = []
    for path in (configured, legacy):
        if path not in paths:
            paths.append(path)
    return paths


def _load_sandbox_metadata(path: Path) -> dict[str, Any]:
    metadata_path = path / ".assistant_sandbox.json"
    if not metadata_path.exists():
        return {}
    try:
        data = json.loads(metadata_path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _sandbox_generated_at(metadata: dict[str, Any]) -> datetime | None:
    raw = metadata.get("generated_at")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except Exception:
        return None


def _list_sandbox_dirs(base_dir: Path) -> list[Path]:
    if not base_dir.exists():
        return []
    return sorted([path for path in base_dir.iterdir() if path.is_dir()])


def _sandbox_is_dirty(path: Path) -> bool:
    result = _run_cmd(["git", "-C", str(path), "status", "--porcelain"], capture=True)
    if result.returncode != 0:
        return True
    return bool(result.stdout.strip())


def _cleanup_stale_sandboxes(base_dir: Path, *, now: datetime | None = None, stale_after_hours: int = 24) -> list[str]:
    current = now or datetime.now(timezone.utc)
    removed: list[str] = []
    for path in _list_sandbox_dirs(base_dir):
        metadata = _load_sandbox_metadata(path)
        generated_at = _sandbox_generated_at(metadata)
        if generated_at is None:
            continue
        age = current - generated_at.astimezone(timezone.utc)
        if age < timedelta(hours=stale_after_hours):
            continue
        result = _run_cmd(["git", "worktree", "remove", "--force", str(path)], capture=True)
        if result.returncode == 0:
            removed.append(str(path))
    _run_cmd(["git", "worktree", "prune"], capture=True)
    return removed


def _find_reusable_sandbox(base_dir: Path, ticket_id: str, *, now: datetime | None = None, reuse_after_hours: int = 12) -> Path | None:
    current = now or datetime.now(timezone.utc)
    candidates: list[tuple[datetime, Path]] = []
    for path in _list_sandbox_dirs(base_dir):
        metadata = _load_sandbox_metadata(path)
        if str(metadata.get("ticket") or "") != str(ticket_id):
            continue
        if str(metadata.get("source_repo") or "") != str(REPO_ROOT):
            continue
        generated_at = _sandbox_generated_at(metadata)
        if generated_at is None:
            continue
        age = current - generated_at.astimezone(timezone.utc)
        if age > timedelta(hours=reuse_after_hours):
            continue
        candidates.append((generated_at, path))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def _sandbox_status_rows(base_dir: Path, *, now: datetime | None = None, reuse_after_hours: int = 12, stale_after_hours: int = 24) -> list[dict[str, Any]]:
    current = now or datetime.now(timezone.utc)
    rows: list[dict[str, Any]] = []
    for path in _list_sandbox_dirs(base_dir):
        metadata = _load_sandbox_metadata(path)
        generated_at = _sandbox_generated_at(metadata)
        age_hours: float | None = None
        reusable = False
        stale = False
        if generated_at is not None:
            age = current - generated_at.astimezone(timezone.utc)
            age_hours = round(age.total_seconds() / 3600, 2)
            reusable = age <= timedelta(hours=reuse_after_hours)
            stale = age > timedelta(hours=stale_after_hours)
        rows.append(
            {
                "base_dir": str(base_dir),
                "path": str(path),
                "name": path.name,
                "ticket": str(metadata.get("ticket") or ""),
                "generated_at": metadata.get("generated_at"),
                "source_repo": str(metadata.get("source_repo") or ""),
                "age_hours": age_hours,
                "reusable": reusable,
                "stale": stale,
                "has_metadata": bool(metadata),
                "dirty": _sandbox_is_dirty(path),
            }
        )
    rows.sort(key=lambda row: (row.get("ticket", ""), row.get("name", "")))
    return rows


def _collect_sandbox_status_rows(base_dirs: list[Path], *, now: datetime | None = None, reuse_after_hours: int = 12, stale_after_hours: int = 24) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for base_dir in base_dirs:
        rows.extend(_sandbox_status_rows(base_dir, now=now, reuse_after_hours=reuse_after_hours, stale_after_hours=stale_after_hours))
    rows.sort(key=lambda row: (str(row.get("ticket") or ""), str(row.get("name") or "")))
    return rows


def _cleanup_sandbox_rows(
    rows: list[dict[str, Any]],
    *,
    remove_all: bool = False,
    ticket_id: str | None = None,
    allow_dirty: bool = False,
) -> dict[str, list[dict[str, Any]]]:
    removed: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    target_ticket = str(ticket_id or "")

    for row in rows:
        if target_ticket and str(row.get("ticket") or "") != target_ticket:
            continue
        if not row.get("has_metadata"):
            skipped.append({"path": row["path"], "reason": "missing metadata"})
            continue
        if row.get("dirty") and not allow_dirty:
            skipped.append({"path": row["path"], "reason": "dirty worktree"})
            continue
        if not remove_all and not row.get("stale"):
            skipped.append({"path": row["path"], "reason": "not stale"})
            continue
        result = _run_cmd(["git", "worktree", "remove", "--force", str(row["path"])], capture=True)
        if result.returncode == 0:
            removed.append({"path": row["path"], "ticket": row.get("ticket") or "", "dirty": bool(row.get("dirty"))})
        else:
            skipped.append({
                "path": row["path"],
                "reason": result.stderr.strip() or result.stdout.strip() or "remove failed",
            })

    _run_cmd(["git", "worktree", "prune"], capture=True)
    return {"removed": removed, "skipped": skipped}


def _prepare_sandbox(ticket_id: str, sandbox_dir: str) -> dict[str, Any]:
    base_dir = _resolve_sandbox_base_dir(sandbox_dir)
    base_dir.mkdir(parents=True, exist_ok=True)
    cleaned = _cleanup_stale_sandboxes(base_dir)
    reusable = _find_reusable_sandbox(base_dir, ticket_id)
    if reusable is not None:
        return {
            "path": str(reusable),
            "base_dir": str(base_dir),
            "requested_dir": sandbox_dir,
            "ok": True,
            "stdout": "reused existing sandbox",
            "stderr": "",
            "reused": True,
            "cleaned": cleaned,
        }
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target = base_dir / f"bat{ticket_id}-{stamp}"
    result = _run_cmd(["git", "worktree", "add", "--detach", str(target), "HEAD"], capture=True)
    payload = {
        "path": str(target),
        "base_dir": str(base_dir),
        "requested_dir": sandbox_dir,
        "ok": result.returncode == 0,
        "stdout": result.stdout.strip(),
        "stderr": result.stderr.strip(),
        "reused": False,
        "cleaned": cleaned,
    }
    if result.returncode == 0:
        metadata = target / ".assistant_sandbox.json"
        metadata.write_text(json.dumps({
            "ticket": ticket_id,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source_repo": str(REPO_ROOT),
        }, indent=2) + "\n", encoding="utf-8")
    return payload


def _safe_summary(settings: dict[str, Any], *, plan: TicketPlan, sandbox: dict[str, Any] | None = None, blocked_reason: str = "", created_files: list[str] | None = None) -> dict[str, Any]:
    return {
        "enabled": bool(settings.get("enabled")),
        "max_files": int(settings.get("max_files", 0) or 0),
        "allow_ship": bool(settings.get("allow_ship")),
        "allow_protected": bool(settings.get("allow_protected")),
        "current_branch": _current_git_branch(),
        "domain_focus": plan.domain_focus,
        "protected": bool(blocked_reason),
        "blocked_reason": blocked_reason,
        "created_file_count": len(created_files or []),
        "sandbox": sandbox or {},
    }


def _post_json(url: str, payload: dict[str, Any]) -> None:
    body = json.dumps(payload).encode("utf-8")
    request = Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urlopen(request, timeout=5) as response:
        response.read()


def _notify_summary(summary: dict[str, Any]) -> None:
    cfg = _load_root_cfg()
    if not _cfg_bool(cfg, "autopilot_notify_summary", True):
        return
    _ensure_runs_dir()
    log_payload = {
        "generated_at": summary.get("generated_at"),
        "ticket": summary.get("ticket"),
        "command": summary.get("command"),
        "all_checks_passed": summary.get("all_checks_passed"),
        "mode": summary.get("mode"),
        "domain_focus": summary.get("domain_focus"),
    }
    with open(NOTIFICATION_LOG_PATH, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(log_payload) + "\n")

    url = str(cfg.get("autopilot_webhook_url") or "").strip()
    slack_url = str(cfg.get("autopilot_slack_webhook_url") or "").strip()
    if not url and not slack_url:
        return
    message = f"BAT<{summary.get('ticket')}> {summary.get('command')} {'passed' if summary.get('all_checks_passed') else 'needs attention'}"
    try:
        if url:
            _post_json(url, log_payload)
        if slack_url:
            _post_json(slack_url, {"text": message})
    except URLError:
        pass


def _parse_ticket_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    tickets = assistant.load_tickets()
    for ticket_id, desc in sorted(tickets.items(), key=lambda item: int(item[0])):
        tags = assistant.parse_tags(desc)
        status = tags[0] if tags else "UNKNOWN"
        profile = assistant.infer_profile(desc)
        if profile.is_fe and profile.is_backend:
            mode = "fullstack"
        elif profile.is_fe:
            mode = "frontend"
        else:
            mode = "backend"
        rows.append(
            {
                "ticket_id": ticket_id,
                "desc": desc,
                "tags": tags,
                "status": status,
                "priority_tag": _parse_priority_tag(tags),
                "domain_focus": _domain_focus(desc),
                "mode": mode,
            }
        )
    return rows


def _resolve_template_for_ticket(*, explicit_template: str | None, plan: TicketPlan) -> str:
    if explicit_template and explicit_template.strip() and explicit_template.strip().lower() != "auto":
        return explicit_template.strip()

    tags = {tag.upper() for tag in plan.tags}
    for tag, template in TAG_TEMPLATE_MAP.items():
        if tag in tags:
            return template
    if plan.mode == "frontend":
        return "fe_portal_bundle"
    if plan.mode == "fullstack":
        return "fullstack_bundle"
    return "be_api_bundle"


def _preflight_checks(*, plan: TicketPlan, profile_key: str, require_git_ship: bool) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []

    def add(name: str, ok: bool, detail: str) -> None:
        checks.append({"name": name, "ok": ok, "detail": detail})

    py_bin = REPO_ROOT / "backend" / ".venv" / "bin" / "python"
    add(
        "backend venv",
        py_bin.exists() and os.access(py_bin, os.X_OK),
        f"expected executable: {py_bin}",
    )

    add("feature board", (REPO_ROOT / "docs" / "BAT_FEATURE_BOARD.md").exists(), "docs/BAT_FEATURE_BOARD.md")
    add("assistant runs dir", (REPO_ROOT / "docs").exists(), "docs/")

    git_probe = _run_cmd(["git", "rev-parse", "--is-inside-work-tree"], capture=True)
    add("git repo", git_probe.returncode == 0, git_probe.stdout.strip() or git_probe.stderr.strip())

    if plan.mode in {"frontend", "fullstack"}:
        node_modules = (REPO_ROOT / "frontend" / "node_modules").exists()
        add("frontend deps", node_modules, "frontend/node_modules")

    gh_needed = require_git_ship or PROFILE_MAP.get(profile_key, {}).get("git", False)
    if gh_needed:
        gh_path = _run_cmd(["which", "gh"], capture=True)
        add("gh installed", gh_path.returncode == 0, gh_path.stdout.strip() or gh_path.stderr.strip())
        if gh_path.returncode == 0:
            gh_auth = _run_cmd(["gh", "auth", "status"], capture=True)
            add("gh auth", gh_auth.returncode == 0, (gh_auth.stdout or gh_auth.stderr).strip().splitlines()[0] if (gh_auth.stdout or gh_auth.stderr).strip() else "no output")
            remote_probe = _run_cmd(["git", "remote", "-v"], capture=True)
            add("git remote", bool(remote_probe.stdout.strip()), "requires remote for PR create")

    return checks


def _render_preflight(preflight: list[dict[str, Any]]) -> str:
    lines = ["## Preflight", ""]
    for row in preflight:
        icon = "OK" if row.get("ok") else "FAIL"
        lines.append(f"- [{icon}] {row.get('name')}: {row.get('detail')}")
    lines.append("")
    return "\n".join(lines)


def _extract_error_locations(check_results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()
    path_re = re.compile(r'((?:backend|frontend|docs)/[A-Za-z0-9_./-]+\.(?:py|ts|tsx|js|jsx|md|json|ya?ml))(?:[:](\d+))?')
    file_line_re = re.compile(r'File "((?:backend|frontend|docs)/[^"]+)", line (\d+)')

    for result in check_results:
        if result.get("ok"):
            continue
        combined = f"{result.get('stdout_tail','')}\n{result.get('stderr_tail','')}"
        for match in file_line_re.finditer(combined):
            path = match.group(1)
            line = int(match.group(2))
            key = (path, line)
            if key in seen:
                continue
            seen.add(key)
            out.append({"path": path, "line": line, "source": result.get("name", "")})
        for match in path_re.finditer(combined):
            path = match.group(1)
            line = int(match.group(2) or "1")
            key = (path, line)
            if key in seen:
                continue
            seen.add(key)
            out.append({"path": path, "line": line, "source": result.get("name", "")})
    return out[:24]


def _write_repo_file(path: str, content: str) -> bool:
    target = _safe_repo_path(path)
    if target is None:
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content.rstrip() + "\n", encoding="utf-8")
    return True


def _attempt_fix_pass(
    *,
    ticket_id: str,
    desc: str,
    profile_key: str,
    verify_commands: list[CheckCommand],
    check_results: list[dict[str, Any]],
    max_iterations: int,
) -> tuple[list[dict[str, Any]], list[str], list[dict[str, Any]]]:
    profile = PROFILE_MAP.get(profile_key, {})
    if not profile.get("use_ai"):
        return check_results, [], _extract_error_locations(check_results)

    applied_files: list[str] = []
    suggestions = _extract_error_locations(check_results)
    if not suggestions:
        return check_results, applied_files, suggestions

    current_results = check_results
    seen_failure_signatures: set[str] = set()
    for _ in range(max_iterations):
        failures = [result for result in current_results if not result.get("ok")]
        if not failures:
            return current_results, applied_files, suggestions

        failure_signature = _ticket_failure_signature(failures)
        if failure_signature and failure_signature in seen_failure_signatures:
            break
        if failure_signature:
            seen_failure_signatures.add(failure_signature)

        target_paths = sorted({row["path"] for row in suggestions})
        failure_blobs: list[str] = []
        for failure in failures:
            name = failure.get("name", "")
            blob = (failure.get("stdout_tail", "") + "\n" + failure.get("stderr_tail", "")).strip()
            if blob:
                failure_blobs.append(f"[{name}]\n{blob}")

        prompt = (
            f"Fix BAT<{ticket_id}> implementation files.\n"
            f"Description: {desc}\n"
            f"Target files:\n" + "\n".join(f"- {path}" for path in target_paths) + "\n\n"
            "Return only sections using header format exactly: # --- relative/path ---\n"
            "Patch these files with minimal safe changes to make checks pass.\n"
            "Keep existing contracts backward compatible.\n\n"
            "Failure output:\n" + "\n\n".join(failure_blobs[:4])
        )

        generated = assistant.ai_generate(prompt)
        sections = assistant._parse_generated_sections(generated) if generated else []
        if not sections:
            break

        changed_this_round = []
        for file_path, content in sections:
            if file_path not in target_paths:
                continue
            if _write_repo_file(file_path, content):
                changed_this_round.append(file_path)
        if not changed_this_round:
            break
        applied_files.extend(changed_this_round)

        failed_command_keys = {
            (tuple(result.get("args", [])), str(result.get("cwd", "")))
            for result in failures
        }
        rerun_map: dict[tuple[tuple[str, ...], str], dict[str, Any]] = {}
        for command in verify_commands:
            key = (tuple(command.args), str(command.cwd))
            if key in failed_command_keys:
                rerun_map[key] = _run_check(command)
        merged_results: list[dict[str, Any]] = []
        for result in current_results:
            key = (tuple(result.get("args", [])), str(result.get("cwd", "")))
            merged_results.append(rerun_map.get(key, result))
        current_results = merged_results
        if all(result.get("ok") for result in current_results):
            break
        suggestions = _extract_error_locations(current_results)

    return current_results, list(dict.fromkeys(applied_files)), suggestions


def _write_ship_checklist(
    *,
    ticket_id: str,
    phase: str,
    created_files: list[str],
    check_results: list[dict[str, Any]],
) -> Path:
    ensure_runs_dir()
    checklist = RUNS_DIR / f"BAT{ticket_id}_ship_checklist.md"
    lines: list[str] = []
    lines.append(f"# Ship Checklist: BAT<{ticket_id}>")
    lines.append("")
    lines.append(f"- Phase: {phase}")
    lines.append(f"- Generated: {datetime.now(timezone.utc).isoformat()}")
    lines.append("")
    lines.append("## Files")
    for path in created_files:
        lines.append(f"- `{path}`")
    lines.append("")
    lines.append("## Checks")
    if check_results:
        for row in check_results:
            icon = "PASS" if row.get("ok") else "FAIL"
            lines.append(f"- [{icon}] {row.get('name')} (exit={row.get('exit_code')})")
    else:
        lines.append("- no checks recorded")
    lines.append("")
    checklist.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return checklist


def _safe_git_ship(
    *,
    ticket_id: str,
    created_files: list[str],
    check_results: list[dict[str, Any]],
    phase: str,
    include_files: list[Path] | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {"attempted": False, "ok": False, "actions": [], "errors": []}
    include_files = include_files or []
    if not created_files:
        out["errors"].append("no created files to ship")
        return out
    if any(not row.get("ok") for row in check_results):
        out["errors"].append("verification failed; ship aborted")
        return out

    out["attempted"] = True
    branch = f"codex/bat-{ticket_id}"
    checkout = _run_cmd(["git", "checkout", "-b", branch], capture=True)
    if checkout.returncode != 0:
        fallback = _run_cmd(["git", "checkout", branch], capture=True)
        if fallback.returncode != 0:
            out["errors"].append((checkout.stderr or fallback.stderr or "branch checkout failed").strip())
            return out
    out["actions"].append(f"checked out {branch}")

    checklist = _write_ship_checklist(
        ticket_id=ticket_id,
        phase=phase,
        created_files=created_files,
        check_results=check_results,
    )

    add_paths = list(created_files)
    for path in include_files + [checklist]:
        rel = path.relative_to(REPO_ROOT)
        add_paths.append(str(rel))

    add_result = _run_cmd(["git", "add", *add_paths], capture=True)
    if add_result.returncode != 0:
        out["errors"].append((add_result.stderr or "git add failed").strip())
        return out
    out["actions"].append("git add completed")

    commit_message = f"BAT<{ticket_id}> {phase}"
    commit_result = _run_cmd(["git", "commit", "-m", commit_message], capture=True)
    if commit_result.returncode != 0:
        out["errors"].append((commit_result.stderr or "git commit failed").strip())
        return out
    out["actions"].append("git commit completed")

    gh_present = _run_cmd(["which", "gh"], capture=True)
    gh_auth = _run_cmd(["gh", "auth", "status"], capture=True) if gh_present.returncode == 0 else None
    remote_result = _run_cmd(["git", "remote", "-v"], capture=True)
    if gh_present.returncode == 0 and gh_auth and gh_auth.returncode == 0 and remote_result.stdout.strip():
        pr = _run_cmd(
            [
                "gh",
                "pr",
                "create",
                "--fill",
                "--title",
                commit_message,
                "--body-file",
                str(checklist),
            ],
            capture=True,
        )
        if pr.returncode == 0:
            out["actions"].append("gh pr create completed")
        else:
            out["errors"].append((pr.stderr or "gh pr create failed").strip())
    else:
        out["actions"].append("skipped gh pr create (gh missing/auth missing/no remote)")

    out["ok"] = len(out["errors"]) == 0
    return out

def _desc_tokens(desc: str) -> list[str]:
    cleaned = desc.lower()
    cleaned = re.sub(r"\[.*?\]", " ", cleaned)
    raw_tokens = re.findall(r"[a-z][a-z0-9_]{2,}", cleaned)
    tokens: list[str] = []
    for token in raw_tokens:
        if token in STOPWORDS:
            continue
        if token not in tokens:
            tokens.append(token)
    return tokens[:12]


def _list_repo_files() -> list[str]:
    # Prefer ripgrep for speed, but gracefully fall back when rg is not on PATH
    # (common in GUI extension hosts on macOS).
    if shutil.which("rg"):
        result = subprocess.run(
            ["rg", "--files"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            return [line.strip() for line in result.stdout.splitlines() if line.strip()]

    git_result = subprocess.run(
        ["git", "ls-files"],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    if git_result.returncode == 0:
        return [line.strip() for line in git_result.stdout.splitlines() if line.strip()]

    file_list: list[str] = []
    for path in REPO_ROOT.rglob("*"):
        if not path.is_file():
            continue
        try:
            rel = path.relative_to(REPO_ROOT)
        except ValueError:
            continue
        if _is_ignored(rel):
            continue
        file_list.append(str(rel).replace("\\", "/"))
    return file_list


def _dedupe_commands(commands: list[CheckCommand]) -> list[CheckCommand]:
    seen: set[tuple[str, tuple[str, ...], str]] = set()
    result: list[CheckCommand] = []
    for command in commands:
        key = (command.name, tuple(command.args), str(command.cwd))
        if key in seen:
            continue
        seen.add(key)
        result.append(command)
    return result


def discover_related_files(
    desc: str,
    scaffold_files: list[str],
    *,
    limit: int = 12,
    candidate_files: list[str] | None = None,
    prefer_domain: str | None = None,
) -> list[str]:
    files = _clean_paths(candidate_files or _list_repo_files())
    domain_focus = prefer_domain or _domain_focus(desc)
    domain_terms = _extract_domain_terms(desc, prefer_domain=prefer_domain)

    scored: list[tuple[int, str]] = []
    for path in files:
        if not path.startswith(("backend/", "frontend/", "docs/")):
            continue
        score = _file_relevance_score(
            path,
            domain_terms=domain_terms,
            domain_focus=domain_focus,
            prefer_domain=prefer_domain,
        )
        if score > 0:
            scored.append((score, path))

    scored.sort(key=lambda row: (-row[0], row[1]))

    related: list[str] = []
    for file_path in scaffold_files:
        if file_path not in related:
            related.append(file_path)
    for _score, file_path in scored:
        if file_path in related:
            continue
        related.append(file_path)
        if len(related) >= limit:
            break
    return related


def build_verify_commands(
    profile: assistant.TicketProfile,
    *,
    full_verify: bool,
    candidate_paths: list[str] | None = None,
) -> list[CheckCommand]:
    commands: list[CheckCommand] = []
    candidate_paths = _clean_paths(candidate_paths or [])
    if profile.is_backend:
        python_bin = _backend_python_bin()
        commands.append(
            CheckCommand(
                name="compile backend app",
                args=[python_bin, "-m", "compileall", "backend/app"],
                cwd=REPO_ROOT,
            )
        )
        if full_verify:
            commands.append(
                CheckCommand(
                    name="backend pytest",
                    args=[python_bin, "-m", "pytest", "-q", "backend/tests"],
                    cwd=REPO_ROOT,
                )
            )

    if profile.is_fe:
        workspace = _frontend_workspace(candidate_paths)
        if workspace:
            commands.append(
                CheckCommand(
                    name=f"frontend typecheck ({workspace})",
                    args=["npm", "run", "--workspace", workspace, "typecheck"],
                    cwd=REPO_ROOT / "frontend",
                )
            )
        else:
            commands.append(
                CheckCommand(
                    name="frontend typecheck",
                    args=["npm", "run", "typecheck"],
                    cwd=REPO_ROOT / "frontend",
                )
            )
        if full_verify:
            commands.append(
                CheckCommand(
                    name="frontend build",
                    args=["npm", "run", "build"],
                    cwd=REPO_ROOT / "frontend",
                    required=False,  # build failures shouldn't block integration
                )
            )
    return commands


def build_ship_commands(
    ticket_id: str,
    created_files: list[str],
    *,
    phase: str = "scaffold + verify",
    is_preview: bool = False,
) -> list[str]:
    if not created_files:
        if is_preview:
            return [
                "# preview mode: no files created; skip git steps",
            ]
        return [
            "# no new scaffold files were created; review existing-file edits before git steps",
        ]

    quoted_paths = " ".join(shlex.quote(path) for path in created_files)
    return [
        f"git checkout -b codex/bat-{ticket_id}",
        f"git add {quoted_paths}",
        f'git commit -m "BAT<{ticket_id}> {phase}"',
        f"gh pr create --fill --title 'BAT<{ticket_id}> {phase}'",
    ]


def build_ticket_plan(
    ticket_id: str,
    *,
    full_verify: bool,
    manual_desc: str | None = None,
    prefer_domain: str | None = None,
) -> TicketPlan:
    repo_map = _ensure_repo_map()
    _ensure_skillpacks()
    tickets = assistant.load_tickets()
    desc = manual_desc if manual_desc else tickets.get(ticket_id, "")
    if not desc:
        raise ValueError(f"BAT<{ticket_id}> not found in feature board")

    cfg = _load_root_cfg()
    max_related_files = max(4, int(cfg.get("assistant_max_related_files") or 12))
    max_scaffold_files = max(2, int(cfg.get("assistant_max_scaffold_files") or 8))
    profile = assistant.infer_profile(desc)
    snake = assistant.make_basename(desc)
    explicit_dependencies = _extract_dependency_terms(desc)
    domain_focus = prefer_domain or _domain_focus(desc)
    domain_terms = _engine_domain_terms(desc, domain_focus=domain_focus, prefer_domain=prefer_domain)
    repo_hint_paths = _repo_hint_paths_for_domain(repo_map, domain_focus, desc=desc, limit=max_related_files)
    # always run an audit to capture existing targets / eligibility
    audit = assistant.audit_ticket(ticket_id, desc, final_files=None)
    memory_summary = _memory_insights_for_domain(domain_focus)
    memory_hint_paths = _clean_paths(memory_summary.get("suggested_files", []) or [], limit=max_related_files)
    domain_candidate_files = _clean_paths(repo_hint_paths + memory_hint_paths, limit=max_related_files)
    existing_targets = discover_related_files(
        desc,
        [],
        limit=max_related_files,
        candidate_files=_clean_paths(audit.get("existing_targets", []) + domain_candidate_files),
        prefer_domain=prefer_domain,
    )
    new_files = audit.get("new_files", [])
    # scaffold paths are only relevant in explicit scaffold mode, caller may clear them
    scaffold_files = _clean_paths(list(assistant.default_scaffold_paths(profile, snake)), limit=max_scaffold_files)
    candidate_files = _clean_paths(existing_targets + audit.get("matches", []) + scaffold_files + domain_candidate_files)
    related_files = discover_related_files(
        desc,
        scaffold_files,
        limit=max_related_files,
        candidate_files=candidate_files,
        prefer_domain=prefer_domain,
    )
    if not related_files and existing_targets:
        related_files = existing_targets[:max_related_files]
    candidate_paths = scaffold_files + related_files + existing_targets
    verify_commands = build_verify_commands(profile, full_verify=full_verify, candidate_paths=candidate_paths)
    ship_commands = build_ship_commands(ticket_id, [], phase="plan", is_preview=True)

    if profile.is_fe and profile.is_backend:
        mode = "fullstack"
    elif profile.is_fe:
        mode = "frontend"
    else:
        mode = "backend"

    return TicketPlan(
        ticket_id=ticket_id,
        desc=desc,
        mode=mode,
        tags=profile.tags,
        keywords=profile.keywords,
        priority_tag=_parse_priority_tag(profile.tags),
        domain_focus=domain_focus,
        domain_terms=domain_terms,
        explicit_dependencies=explicit_dependencies,
        prefer_domain=prefer_domain,
        frontend_workspace=_frontend_workspace(candidate_paths),
        scaffold_files=scaffold_files,
        related_files=related_files,
        existing_targets=existing_targets,
        new_files=new_files,
        verify_commands=verify_commands,
        ship_commands=ship_commands,
        repo_hint_paths=repo_hint_paths,
        memory_hint_paths=memory_hint_paths,
        memory_summary=memory_summary,
    )


def render_plan(plan: TicketPlan) -> str:
    lines: list[str] = []
    lines.append(f"# Solo Dev Plan: BAT<{plan.ticket_id}>")
    lines.append("")
    lines.append("## Understand")
    lines.append(f"- Description: {plan.desc}")
    lines.append(f"- Mode: {plan.mode}")
    lines.append(f"- Priority: {plan.priority_tag}")
    lines.append(f"- Domain focus: {plan.domain_focus}")
    lines.append(f"- Tags: {', '.join(plan.tags) if plan.tags else 'none'}")
    lines.append(f"- Keywords: {', '.join(plan.keywords) if plan.keywords else 'none'}")
    lines.append("")

    lines.append("## Engine Insights")
    memory_summary = plan.memory_summary or {}
    lines.append(
        f"- Memory: {memory_summary.get('successes', 0)} passed / {memory_summary.get('failures', 0)} failed prior run(s) in {plan.domain_focus}"
    )
    if plan.repo_hint_paths:
        lines.append("- Repo-map hints:")
        for path in plan.repo_hint_paths[:6]:
            lines.append(f"  - {path}")
    if plan.memory_hint_paths:
        lines.append("- Memory hints:")
        for path in plan.memory_hint_paths[:6]:
            lines.append(f"  - {path}")
    lines.append("")

    lines.append("## Plan")
    if plan.existing_targets:
        lines.append("- Existing files to consider:")
        for path in plan.existing_targets:
            lines.append(f"  - {path}")
    if plan.new_files:
        lines.append("- Proposed new files:")
        for nf in plan.new_files:
            lines.append(f"  - {nf.get('path')} ({nf.get('reason')})")
    if plan.scaffold_files:
        lines.append("- Primary scaffold files:")
        for path in plan.scaffold_files:
            lines.append(f"  - {path}")
    if plan.related_files:
        lines.append("- Related files to inspect/update:")
        for path in plan.related_files:
            lines.append(f"  - {path}")
    lines.append("")

    lines.append("## Verify Commands")
    if plan.verify_commands:
        for cmd in plan.verify_commands:
            lines.append(f"- ({cmd.cwd}) `{_quoted(cmd.args)}`")
    else:
        lines.append("- none")
    lines.append("")

    lines.append("## Ship Commands")
    for command in plan.ship_commands:
        lines.append(f"- `{command}`")
    lines.append("")
    return "\n".join(lines)


def _validation_scope_terms(plan: TicketPlan) -> list[str]:
    terms = list(plan.domain_terms)
    for path in plan.related_files + plan.scaffold_files:
        terms.extend(_desc_tokens(Path(path).stem.replace("test_", " ")))
    for dep in plan.explicit_dependencies:
        if dep not in terms:
            terms.append(dep)
    deduped: list[str] = []
    for term in terms:
        normalized = term.strip().lower()
        if normalized and normalized not in deduped and normalized not in GENERIC_BACKEND_TERMS:
            deduped.append(normalized)
    return deduped[:16]


def _result_command_key(result: dict[str, Any]) -> tuple[tuple[str, ...], str]:
    return (tuple(result.get("args", [])), str(result.get("cwd", "")))


def _command_command_key(command: CheckCommand) -> tuple[tuple[str, ...], str]:
    return (tuple(command.args), str(command.cwd))


def _split_failures_by_relevance(
    plan: TicketPlan,
    check_results: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    relevant: list[dict[str, Any]] = []
    unrelated: list[dict[str, Any]] = []
    scope_terms = _engine_domain_terms(
        plan.desc,
        domain_focus=plan.domain_focus,
        prefer_domain=plan.prefer_domain,
        existing_terms=_validation_scope_terms(plan),
    )
    selected_paths = set(plan.related_files + plan.scaffold_files + plan.existing_targets)

    for result in check_results:
        if result.get("ok"):
            continue
        name = str(result.get("name", ""))
        if name.startswith("targeted pytest"):
            test_path = ""
            args = result.get("args", [])
            if args:
                test_path = str(args[-1])
            is_relevant = test_path in selected_paths or _is_relevant_path(
                test_path,
                domain_terms=scope_terms,
                domain_focus=plan.domain_focus,
                prefer_domain=plan.prefer_domain,
                minimum_score=8,
            )
            (relevant if is_relevant else unrelated).append(result)
            continue
        locations = _extract_error_locations([result])
        if locations:
            if any(
                loc["path"] in selected_paths
                or _is_relevant_path(
                    loc["path"],
                    domain_terms=scope_terms,
                    domain_focus=plan.domain_focus,
                    prefer_domain=plan.prefer_domain,
                    minimum_score=8,
                )
                for loc in locations
            ):
                relevant.append(result)
            else:
                unrelated.append(result)
            continue
        relevant.append(result)
    return relevant, unrelated


def discover_targeted_tests(plan: TicketPlan, *, max_tests: int = 4) -> list[str]:
    # only backend tests are considered; frontend work shouldn’t run them at all
    if plan.mode == "frontend":
        return []
    files = _list_repo_files()
    test_files = [path for path in files if path.startswith("backend/tests/test_") and path.endswith(".py")]
    if not test_files:
        return []

    def is_runnable_pytest(path: str) -> bool:
        target = REPO_ROOT / path
        if not target.exists():
            return False
        try:
            text = target.read_text(encoding="utf-8")
        except Exception:
            return False
        return bool(re.search(r"^\s*def\s+test_[a-zA-Z0-9_]*\s*\(", text, flags=re.MULTILINE))

    scope_terms = _engine_domain_terms(
        plan.desc,
        domain_focus=plan.domain_focus,
        prefer_domain=plan.prefer_domain,
        existing_terms=_validation_scope_terms(plan),
    )

    prioritized: list[str] = []
    for path in plan.related_files:
        if (
            path in test_files
            and path not in prioritized
            and is_runnable_pytest(path)
            and _is_relevant_path(
                path,
                domain_terms=scope_terms,
                domain_focus=plan.domain_focus,
                prefer_domain=plan.prefer_domain,
                minimum_score=8,
            )
        ):
            prioritized.append(path)

    scored: list[tuple[int, str]] = []
    for path in test_files:
        score = _file_relevance_score(
            path,
            domain_terms=scope_terms,
            domain_focus=plan.domain_focus,
            prefer_domain=plan.prefer_domain,
        )
        if score >= 8:
            scored.append((score, path))

    scored.sort(key=lambda row: (-row[0], row[1]))
    for _score, path in scored:
        if not is_runnable_pytest(path):
            continue
        if path not in prioritized:
            prioritized.append(path)
        if len(prioritized) >= max_tests:
            break

    return prioritized[:max_tests]


def render_implement_brief(
    *,
    plan: TicketPlan,
    profile: str,
    template: str,
    targeted_tests: list[str],
) -> str:
    lines: list[str] = []
    lines.append(f"# Solo Dev Implement Brief: BAT<{plan.ticket_id}>")
    lines.append("")
    lines.append("## Objective")
    lines.append(f"- {plan.desc}")
    lines.append(f"- Mode: {plan.mode}")
    lines.append(f"- Priority: {plan.priority_tag}")
    lines.append(f"- Domain focus: {plan.domain_focus}")
    if plan.frontend_workspace:
        lines.append(f"- Frontend workspace: {plan.frontend_workspace}")
    lines.append(f"- Run profile: {profile}")
    lines.append(f"- Template: {template}")
    lines.append("")

    lines.append("## Edit Targets")
    for path in plan.related_files:
        lines.append(f"- {path}")
    lines.append("")

    lines.append("## Acceptance")
    lines.append("- Keep existing API contracts backward compatible unless BAT explicitly changes shape.")
    lines.append("- Add/update tests for core behavior and authorization boundaries.")
    lines.append("- Verification commands below must pass before ship.")
    lines.append("")

    lines.append("## Verification")
    for command in plan.verify_commands:
        lines.append(f"- `{_quoted(command.args)}` (cwd: `{command.cwd}`)")
    if targeted_tests:
        lines.append("- Targeted pytest files:")
        for test_path in targeted_tests:
            lines.append(f"  - `{test_path}`")
    lines.append("")

    lines.append("## Ship")
    lines.append("- Branch format: `codex/bat-<id>`")
    lines.append("- Commit only BAT-related files.")
    lines.append("- Open PR after checks pass.")
    lines.append("")
    return "\n".join(lines)


def _run_check(command: CheckCommand) -> dict[str, Any]:
    started = datetime.now(timezone.utc)
    try:
        result = subprocess.run(
            command.args,
            cwd=str(command.cwd),
            capture_output=True,
            text=True,
            check=False,
        )
        exit_code = result.returncode
        stdout_tail = "\n".join(result.stdout.splitlines()[-40:])
        stderr_tail = "\n".join(result.stderr.splitlines()[-40:])
        error_msg = ""
        ok = result.returncode == 0
    except Exception as exc:
        # executable missing or other failure to start command
        finished = datetime.now(timezone.utc)
        msg = str(exc)
        # if the program simply isn't installed, skip the check rather than
        # crashing or treating it as a hard failure.  This lets autopilot run
        # on machines without Node, Docker, etc.
        if isinstance(exc, FileNotFoundError):
            return {
                "name": command.name,
                "cwd": str(command.cwd),
                "args": command.args,
                "exit_code": -1,
                "stdout_tail": "",
                "stderr_tail": "",
                "started_at": started.isoformat(),
                "finished_at": finished.isoformat(),
                "ok": True,
                "skipped": True,
                "error": msg,
            }
        return {
            "name": command.name,
            "cwd": str(command.cwd),
            "args": command.args,
            "exit_code": -1,
            "stdout_tail": "",
            "stderr_tail": "",
            "started_at": started.isoformat(),
            "finished_at": finished.isoformat(),
            "ok": False,
            "error": msg,
        }
    finished = datetime.now(timezone.utc)
    if not ok and not command.required:
        # treat optional checks as skipped warnings
        ok = True
        return {
            "name": command.name,
            "cwd": str(command.cwd),
            "args": command.args,
            "exit_code": exit_code,
            "stdout_tail": stdout_tail,
            "stderr_tail": stderr_tail,
            "started_at": started.isoformat(),
            "finished_at": finished.isoformat(),
            "ok": ok,
            "skipped": True,
            "error": "optional check failed",
        }
    return {
        "name": command.name,
        "cwd": str(command.cwd),
        "args": command.args,
        "exit_code": exit_code,
        "stdout_tail": stdout_tail,
        "stderr_tail": stderr_tail,
        "started_at": started.isoformat(),
        "finished_at": finished.isoformat(),
        "ok": ok,
    }
    finished = datetime.now(timezone.utc)
    return {
        "name": command.name,
        "cwd": str(command.cwd),
        "args": command.args,
        "exit_code": exit_code,
        "stdout_tail": stdout_tail,
        "stderr_tail": stderr_tail,
        "started_at": started.isoformat(),
        "finished_at": finished.isoformat(),
        "ok": ok,
    }


def run_learn(*, write_report: bool) -> str:
    entries = parse_log(LOG_PATH)
    ticket_descriptions = load_ticket_board()
    report = render_report(entries, ticket_descriptions)
    if write_report:
        REPORT_PATH.write_text(report + "\n", encoding="utf-8")
    return report


def ensure_runs_dir() -> None:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)


def run_plan_command(args: argparse.Namespace) -> int:
    ticket_id = _normalize_ticket_id(args.ticket)
    plan = build_ticket_plan(ticket_id, full_verify=args.full_verify, manual_desc=args.desc, prefer_domain=getattr(args, "prefer_domain", None))
    plan.ship_commands = build_ship_commands(ticket_id, [], phase="plan", is_preview=True)
    content = render_plan(plan)
    print(content)

    # note that brainstorming/interactive flags don't change the static plan
    if args.brainstorm or args.brainstorm_notes or args.interactive:
        print("\n(Note: brainstorm/interactive options provided; they only affect scaffolding or AI-driven runs.)")

    if args.write_plan:
        ensure_runs_dir()
        output = RUNS_DIR / f"BAT{ticket_id}_plan.md"
        output.write_text(content + "\n", encoding="utf-8")
        print(f"\nWrote {output}")
    return 0


def run_pipeline_command(args: argparse.Namespace) -> int:
    ticket_id = _normalize_ticket_id(args.ticket)
    cfg = _load_root_cfg()
    safe_settings = _safe_settings(args, cfg)
    # ensure ticket is allowed before doing any planning
    tickets = assistant.load_tickets()
    desc = args.desc if args.desc else tickets.get(ticket_id, "")
    aud = assistant.audit_ticket(ticket_id, desc, final_files=None)
    if not aud.get("allowed", True):
        print(f"Skipping BAT<{ticket_id}>: {aud.get('block_reason')}")
        return 0
    if args.profile not in PROFILE_MAP:
        raise ValueError(f"unsupported profile: {args.profile}")

    plan = build_ticket_plan(ticket_id, full_verify=args.full_verify, manual_desc=args.desc, prefer_domain=getattr(args, "prefer_domain", None))
    plan.ship_commands = build_ship_commands(ticket_id, [], phase="scaffold + verify", is_preview=args.profile == "preview")
    safe_block_reason = _safe_guard_reason(plan, safe_settings)
    print(render_plan(plan))
    resolved_template = _resolve_template_for_ticket(explicit_template=args.template, plan=plan)

    preflight = _preflight_checks(plan=plan, profile_key=args.profile, require_git_ship=args.ship)
    print(_render_preflight(preflight))
    preflight_failed = [row for row in preflight if not row.get("ok")]
    if preflight_failed and not args.skip_preflight:
        print("Preflight failed. Re-run with --skip-preflight to override.")
        return 2

    ensure_runs_dir()
    plan_out = RUNS_DIR / f"BAT{ticket_id}_plan.md"
    plan_out.write_text(render_plan(plan) + "\n", encoding="utf-8")

    sandbox_info: dict[str, Any] | None = None
    if safe_settings.get("enabled") and safe_settings.get("prepare_sandbox"):
        sandbox_info = _prepare_sandbox(ticket_id, str(safe_settings.get("sandbox_dir")))
        if sandbox_info.get("ok"):
            print(f"Prepared sandbox: {sandbox_info.get('path')}")
        else:
            print(f"Sandbox prepare failed: {sandbox_info.get('stderr') or sandbox_info.get('stdout')}")

    if safe_block_reason:
        print(f"Safe mode blocked BAT<{ticket_id}>: {safe_block_reason}")
        summary = {
            "ticket": ticket_id,
            "command": "run",
            "mode": plan.mode,
            "priority_tag": plan.priority_tag,
            "domain_focus": plan.domain_focus,
            "frontend_workspace": plan.frontend_workspace,
            "profile": args.profile,
            "template": resolved_template,
            "created_files": [],
            "ship_commands": plan.ship_commands,
            "checks": [],
            "all_checks_passed": False,
            "preflight": preflight,
            "blocked_reason": safe_block_reason,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "safe_execution": _safe_summary(safe_settings, plan=plan, sandbox=sandbox_info, blocked_reason=safe_block_reason),
        }
        summary["critique"] = _write_self_critique(
            ticket_id=ticket_id,
            command="run",
            plan=plan,
            created_files=[],
            targeted_tests=[],
            check_results=[],
            blocked_reason=safe_block_reason,
        )
        summary_out = RUNS_DIR / f"BAT{ticket_id}_run.json"
        summary_out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        _record_ticket_state(ticket_id=ticket_id, plan=plan, action="run", exit_code=2, check_results=[], cfg=cfg, blocked_reason=safe_block_reason)
        _write_status_suggestion(ticket_id, plan, exit_code=2, check_results=[], blocked_reason=safe_block_reason)
        _update_assistant_dashboard()
        _notify_summary(summary)
        return 2

    profile = PROFILE_MAP[args.profile]
    created = assistant.scaffold(
        ticket_id,
        use_ai=profile["use_ai"],
        do_write=profile["write"],
        do_git=profile["git"],
        manual_desc=args.desc,
        template=resolved_template,
        interactive=args.interactive,
        brainstorm=args.brainstorm,
        brainstorm_notes=args.brainstorm_notes,
        allow_slug=False,  # pipeline mode should not stub slug names
    )

    if safe_settings.get("enabled") and len(created) > int(safe_settings.get("max_files", 0) or 0):
        blocked_reason = f"safe mode file cap exceeded: {len(created)} > {safe_settings.get('max_files')}"
        print(blocked_reason)
        summary = {
            "ticket": ticket_id,
            "command": "run",
            "mode": plan.mode,
            "priority_tag": plan.priority_tag,
            "domain_focus": plan.domain_focus,
            "frontend_workspace": plan.frontend_workspace,
            "profile": args.profile,
            "template": resolved_template,
            "created_files": created,
            "ship_commands": plan.ship_commands,
            "checks": [],
            "all_checks_passed": False,
            "preflight": preflight,
            "blocked_reason": blocked_reason,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "safe_execution": _safe_summary(safe_settings, plan=plan, sandbox=sandbox_info, blocked_reason=blocked_reason, created_files=created),
        }
        summary["critique"] = _write_self_critique(ticket_id=ticket_id, command="run", plan=plan, created_files=created, targeted_tests=[], check_results=[], blocked_reason=blocked_reason)
        summary_out = RUNS_DIR / f"BAT{ticket_id}_run.json"
        summary_out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        _record_ticket_state(ticket_id=ticket_id, plan=plan, action="run", exit_code=3, check_results=[], cfg=cfg, blocked_reason=blocked_reason)
        _write_status_suggestion(ticket_id, plan, exit_code=3, check_results=[], blocked_reason=blocked_reason)
        _update_assistant_dashboard()
        _notify_summary(summary)
        return 3

    ship_commands = build_ship_commands(
        ticket_id,
        created,
        phase="scaffold + verify",
        is_preview=args.profile == "preview",
    )
    print("\nSuggested ship commands:")
    for command in ship_commands:
        print(f"- {command}")

    check_results: list[dict[str, Any]] = []
    if not args.skip_verify:
        print("\nRunning verification checks...")
        for command in plan.verify_commands:
            print(f"- {command.name}: {_quoted(command.args)}")
            result = _run_check(command)
            check_results.append(result)
            if result.get("skipped"):
                print(f"  SKIPPED ({result.get('error','')})")
            elif result["ok"]:
                print(f"  OK ({result['exit_code']})")
            else:
                print(f"  FAIL ({result['exit_code']})")

    fix_applied_files: list[str] = []
    fix_suggestions: list[dict[str, Any]] = []
    blocked_reason = ""
    if args.fix_loop and any(not result.get("ok") for result in check_results):
        relevant_failures, unrelated_failures = _split_failures_by_relevance(plan, check_results)
        if relevant_failures:
            print("\nFix loop: attempting AI-assisted patch pass...")
            relevant_keys = {_result_command_key(row) for row in relevant_failures}
            relevant_commands = [command for command in plan.verify_commands if _command_command_key(command) in relevant_keys]
            fixed_results, fix_applied_files, fix_suggestions = _attempt_fix_pass(
                ticket_id=ticket_id,
                desc=plan.desc,
                profile_key=args.profile,
                verify_commands=relevant_commands,
                check_results=relevant_failures,
                max_iterations=max(1, args.fix_iterations),
            )
            fixed_map = {_result_command_key(row): row for row in fixed_results}
            check_results = [fixed_map.get(_result_command_key(row), row) for row in check_results]
            if fix_applied_files:
                print(f"Applied fix updates to {len(fix_applied_files)} files.")
            elif fix_suggestions:
                print("No automatic fix applied. Suggested patch targets:")
                for row in fix_suggestions:
                    print(f"- {row['path']}:{row['line']} ({row['source']})")
        if unrelated_failures and not relevant_failures:
            blocked_reason = "blocked by unrelated failing test selection"
            print(f"\n{blocked_reason}; skipping auto-repair.")

    learn_report = ""
    if not args.skip_learn:
        learn_report = run_learn(write_report=True)
        print("\nUpdated docs/DEV_ASSISTANT_LOG_REPORT.md")

    ship_result: dict[str, Any] | None = None
    ship_requested = bool(args.ship)
    if ship_requested and safe_settings.get("enabled") and not safe_settings.get("allow_ship"):
        print("Safe mode disabled ship automation for this run.")
        ship_requested = False
    if ship_requested:
        ship_result = _safe_git_ship(
            ticket_id=ticket_id,
            created_files=created,
            check_results=check_results,
            phase="scaffold + verify",
            include_files=[plan_out],
        )
        print("\nShip automation:")
        for action in ship_result.get("actions", []):
            print(f"- {action}")
        for err in ship_result.get("errors", []):
            print(f"- ERROR: {err}")

    summary = {
        "ticket": ticket_id,
        "command": "run",
        "mode": plan.mode,
        "priority_tag": plan.priority_tag,
        "domain_focus": plan.domain_focus,
        "frontend_workspace": plan.frontend_workspace,
        "profile": args.profile,
        "template": resolved_template,
        "created_files": created,
        "ship_commands": ship_commands,
        "checks": check_results,
        "all_checks_passed": all(result.get("ok") for result in check_results) if check_results else True,
        "preflight": preflight,
        "fix_loop_enabled": bool(args.fix_loop),
        "fix_applied_files": fix_applied_files,
        "fix_suggestions": fix_suggestions,
        "blocked_reason": blocked_reason,
        "ship_result": ship_result,
        "safe_execution": _safe_summary(safe_settings, plan=plan, sandbox=sandbox_info, blocked_reason=blocked_reason, created_files=created),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    board_update = _maybe_close_bat_ticket(ticket_id, check_results=check_results, cfg=cfg)
    summary["board_update"] = board_update
    summary["critique"] = _write_self_critique(
        ticket_id=ticket_id,
        command="run",
        plan=plan,
        created_files=created,
        targeted_tests=[],
        check_results=check_results,
        blocked_reason=blocked_reason,
    )
    summary_out = RUNS_DIR / f"BAT{ticket_id}_run.json"
    summary_out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {summary_out}")
    cfg = _load_root_cfg()
    _record_ticket_state(
        ticket_id=ticket_id,
        plan=plan,
        action="run",
        exit_code=1 if any(not result.get("ok") for result in check_results) else 0,
        check_results=check_results,
        cfg=cfg,
        blocked_reason=blocked_reason,
    )
    _write_status_suggestion(ticket_id, plan, exit_code=1 if any(not result.get("ok") for result in check_results) else 0, check_results=check_results, blocked_reason=blocked_reason)
    _update_assistant_dashboard()
    _record_engine_memory(ticket_id, "run", plan, created, summary["all_checks_passed"])
    _notify_summary(summary)

    if args.print_learn and learn_report:
        print("\n" + learn_report)

    return 1 if any(not result.get("ok") for result in check_results) else 0


def run_implement_command(args: argparse.Namespace) -> int:
    ticket_id = _normalize_ticket_id(args.ticket)
    cfg = _load_root_cfg()
    safe_settings = _safe_settings(args, cfg)
    # eligibility check before planning
    tickets = assistant.load_tickets()
    desc = args.desc if args.desc else tickets.get(ticket_id, "")
    aud = assistant.audit_ticket(ticket_id, desc, final_files=None)
    if not aud.get("allowed", True):
        print(f"Skipping BAT<{ticket_id}>: {aud.get('block_reason')}")
        return 0
    if args.profile not in PROFILE_MAP:
        raise ValueError(f"unsupported profile: {args.profile}")
    if args.profile == "preview":
        raise ValueError("implement mode requires write-capable profile (write, aiWrite, or aiWriteGit)")

    plan = build_ticket_plan(ticket_id, full_verify=args.full_verify, manual_desc=args.desc, prefer_domain=getattr(args, "prefer_domain", None))
    plan.ship_commands = build_ship_commands(ticket_id, [], phase="implement pass", is_preview=False)
    safe_block_reason = _safe_guard_reason(plan, safe_settings)
    # if not explicitly scaffolding, clear any suggested new files
    if getattr(args, 'mode', None) != 'scaffold':
        plan.scaffold_files = []
    print(render_plan(plan))
    resolved_template = _resolve_template_for_ticket(explicit_template=args.template, plan=plan)

    preflight = _preflight_checks(plan=plan, profile_key=args.profile, require_git_ship=args.ship)
    print(_render_preflight(preflight))
    preflight_failed = [row for row in preflight if not row.get("ok")]
    if preflight_failed and not args.skip_preflight:
        print("Preflight failed. Re-run with --skip-preflight to override.")
        return 2

    # only discover backend pytest files when not purely frontend work
    if plan.mode == "frontend":
        targeted_tests: list[str] = []
    else:
        targeted_tests = discover_targeted_tests(plan, max_tests=args.max_targeted_tests)
    targeted_commands = [
        CheckCommand(
            name=f"targeted pytest ({Path(path).name})",
            args=[_backend_python_bin(), "-m", "pytest", "-q", path],
            cwd=REPO_ROOT,
        )
        for path in targeted_tests
    ]
    verify_commands = _dedupe_commands(plan.verify_commands + targeted_commands)

    ensure_runs_dir()
    plan_out = RUNS_DIR / f"BAT{ticket_id}_plan.md"
    plan_out.write_text(render_plan(plan) + "\n", encoding="utf-8")

    sandbox_info: dict[str, Any] | None = None
    if safe_settings.get("enabled") and safe_settings.get("prepare_sandbox"):
        sandbox_info = _prepare_sandbox(ticket_id, str(safe_settings.get("sandbox_dir")))
        if sandbox_info.get("ok"):
            print(f"Prepared sandbox: {sandbox_info.get('path')}")
        else:
            print(f"Sandbox prepare failed: {sandbox_info.get('stderr') or sandbox_info.get('stdout')}")

    if safe_block_reason:
        print(f"Safe mode blocked BAT<{ticket_id}>: {safe_block_reason}")
        summary = {
            "ticket": ticket_id,
            "command": "implement",
            "mode": plan.mode,
            "priority_tag": plan.priority_tag,
            "domain_focus": plan.domain_focus,
            "frontend_workspace": plan.frontend_workspace,
            "profile": args.profile,
            "template": resolved_template,
            "created_files": [],
            "targeted_tests": [],
            "ship_commands": plan.ship_commands,
            "checks": [],
            "all_checks_passed": False,
            "preflight": preflight,
            "blocked_reason": safe_block_reason,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "safe_execution": _safe_summary(safe_settings, plan=plan, sandbox=sandbox_info, blocked_reason=safe_block_reason),
        }
        summary["critique"] = _write_self_critique(ticket_id=ticket_id, command="implement", plan=plan, created_files=[], targeted_tests=[], check_results=[], blocked_reason=safe_block_reason)
        summary_out = RUNS_DIR / f"BAT{ticket_id}_implement.json"
        summary_out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        _record_ticket_state(ticket_id=ticket_id, plan=plan, action="implement", exit_code=2, check_results=[], cfg=cfg, blocked_reason=safe_block_reason)
        _write_status_suggestion(ticket_id, plan, exit_code=2, check_results=[], blocked_reason=safe_block_reason)
        _update_assistant_dashboard()
        _notify_summary(summary)
        return 2

    brief = render_implement_brief(
        plan=plan,
        profile=args.profile,
        template=resolved_template,
        targeted_tests=targeted_tests,
    )
    brief_out = RUNS_DIR / f"BAT{ticket_id}_implement.md"
    brief_out.write_text(brief + "\n", encoding="utf-8")
    print(f"Wrote {brief_out}")

    profile = PROFILE_MAP[args.profile]
    created = assistant.scaffold(
        ticket_id,
        use_ai=profile["use_ai"],
        do_write=profile["write"],
        do_git=profile["git"],
        manual_desc=args.desc,
        template=resolved_template,
        interactive=args.interactive,
        brainstorm=args.brainstorm,
        brainstorm_notes=args.brainstorm_notes,
        allow_slug=(getattr(args, "mode", "integrate") == "scaffold"),
    )

    if safe_settings.get("enabled") and len(created) > int(safe_settings.get("max_files", 0) or 0):
        blocked_reason = f"safe mode file cap exceeded: {len(created)} > {safe_settings.get('max_files')}"
        print(blocked_reason)
        summary = {
            "ticket": ticket_id,
            "command": "implement",
            "mode": plan.mode,
            "priority_tag": plan.priority_tag,
            "domain_focus": plan.domain_focus,
            "frontend_workspace": plan.frontend_workspace,
            "profile": args.profile,
            "template": resolved_template,
            "created_files": created,
            "targeted_tests": targeted_tests,
            "ship_commands": plan.ship_commands,
            "checks": [],
            "all_checks_passed": False,
            "preflight": preflight,
            "blocked_reason": blocked_reason,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "safe_execution": _safe_summary(safe_settings, plan=plan, sandbox=sandbox_info, blocked_reason=blocked_reason, created_files=created),
        }
        summary["critique"] = _write_self_critique(ticket_id=ticket_id, command="implement", plan=plan, created_files=created, targeted_tests=targeted_tests, check_results=[], blocked_reason=blocked_reason)
        summary_out = RUNS_DIR / f"BAT{ticket_id}_implement.json"
        summary_out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        _record_ticket_state(ticket_id=ticket_id, plan=plan, action="implement", exit_code=3, check_results=[], cfg=cfg, blocked_reason=blocked_reason)
        _write_status_suggestion(ticket_id, plan, exit_code=3, check_results=[], blocked_reason=blocked_reason)
        _update_assistant_dashboard()
        _notify_summary(summary)
        return 3

    ship_commands = build_ship_commands(
        ticket_id,
        created,
        phase="implement pass",
        is_preview=False,
    )
    print("\nSuggested ship commands:")
    for command in ship_commands:
        print(f"- {command}")

    check_results: list[dict[str, Any]] = []
    if not args.skip_verify:
        print("\nRunning verification checks...")
        for command in verify_commands:
            print(f"- {command.name}: {_quoted(command.args)}")
            result = _run_check(command)
            check_results.append(result)
            if result.get("skipped"):
                print(f"  SKIPPED ({result.get('error','')})")
            elif result["ok"]:
                print(f"  OK ({result['exit_code']})")
            else:
                print(f"  FAIL ({result['exit_code']})")

    fix_applied_files: list[str] = []
    fix_suggestions: list[dict[str, Any]] = []
    blocked_reason = ""
    if args.fix_loop and any(not result.get("ok") for result in check_results):
        relevant_failures, unrelated_failures = _split_failures_by_relevance(plan, check_results)
        if relevant_failures:
            print("\nFix loop: attempting AI-assisted patch pass...")
            relevant_keys = {_result_command_key(row) for row in relevant_failures}
            relevant_commands = [command for command in verify_commands if _command_command_key(command) in relevant_keys]
            fixed_results, fix_applied_files, fix_suggestions = _attempt_fix_pass(
                ticket_id=ticket_id,
                desc=plan.desc,
                profile_key=args.profile,
                verify_commands=relevant_commands,
                check_results=relevant_failures,
                max_iterations=max(1, args.fix_iterations),
            )
            fixed_map = {_result_command_key(row): row for row in fixed_results}
            check_results = [fixed_map.get(_result_command_key(row), row) for row in check_results]
            if fix_applied_files:
                print(f"Applied fix updates to {len(fix_applied_files)} files.")
            elif fix_suggestions:
                print("No automatic fix applied. Suggested patch targets:")
                for row in fix_suggestions:
                    print(f"- {row['path']}:{row['line']} ({row['source']})")
        if unrelated_failures and not relevant_failures:
            blocked_reason = "blocked by unrelated failing test selection"
            print(f"\n{blocked_reason}; skipping auto-repair.")

    learn_report = ""
    if not args.skip_learn:
        learn_report = run_learn(write_report=True)
        print("\nUpdated docs/DEV_ASSISTANT_LOG_REPORT.md")

    ship_result: dict[str, Any] | None = None
    ship_requested = bool(args.ship)
    if ship_requested and safe_settings.get("enabled") and not safe_settings.get("allow_ship"):
        print("Safe mode disabled ship automation for this run.")
        ship_requested = False
    if ship_requested:
        ship_result = _safe_git_ship(
            ticket_id=ticket_id,
            created_files=created,
            check_results=check_results,
            phase="implement pass",
            include_files=[plan_out, brief_out],
        )
        print("\nShip automation:")
        for action in ship_result.get("actions", []):
            print(f"- {action}")
        for err in ship_result.get("errors", []):
            print(f"- ERROR: {err}")

    summary = {
        "ticket": ticket_id,
        "command": "implement",
        "mode": plan.mode,
        "priority_tag": plan.priority_tag,
        "domain_focus": plan.domain_focus,
        "frontend_workspace": plan.frontend_workspace,
        "profile": args.profile,
        "template": resolved_template,
        "created_files": created,
        "targeted_tests": targeted_tests,
        "ship_commands": ship_commands,
        "checks": check_results,
        "all_checks_passed": all(result.get("ok") for result in check_results) if check_results else True,
        "preflight": preflight,
        "fix_loop_enabled": bool(args.fix_loop),
        "fix_applied_files": fix_applied_files,
        "fix_suggestions": fix_suggestions,
        "blocked_reason": blocked_reason,
        "ship_result": ship_result,
        "safe_execution": _safe_summary(safe_settings, plan=plan, sandbox=sandbox_info, blocked_reason=blocked_reason, created_files=created),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    board_update = _maybe_close_bat_ticket(ticket_id, check_results=check_results, cfg=cfg)
    summary["board_update"] = board_update
    summary["critique"] = _write_self_critique(
        ticket_id=ticket_id,
        command="implement",
        plan=plan,
        created_files=created,
        targeted_tests=targeted_tests,
        check_results=check_results,
        blocked_reason=blocked_reason,
    )
    summary_out = RUNS_DIR / f"BAT{ticket_id}_implement.json"
    summary_out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {summary_out}")
    exit_code = 1 if any(not result.get("ok") for result in check_results) else 0
    _record_ticket_state(
        ticket_id=ticket_id,
        plan=plan,
        action="implement",
        exit_code=exit_code,
        check_results=check_results,
        cfg=cfg,
        blocked_reason=blocked_reason,
    )
    _write_status_suggestion(ticket_id, plan, exit_code=exit_code, check_results=check_results, blocked_reason=blocked_reason)
    _update_assistant_dashboard()
    _record_engine_memory(ticket_id, "implement", plan, created, summary["all_checks_passed"])
    _notify_summary(summary)

    if args.print_learn and learn_report:
        print("\n" + learn_report)

    return exit_code


def run_learn_command(args: argparse.Namespace) -> int:
    report = run_learn(write_report=args.write_report)
    print(report)
    if args.write_report:
        print(f"\nWrote {REPORT_PATH}")
    return 0


def run_engine_refresh_command(args: argparse.Namespace) -> int:
    repo_map = _ensure_repo_map(refresh=True)
    skillpacks = _ensure_skillpacks(refresh=getattr(args, "refresh_skillpacks", False))
    print("Engine artifacts refreshed.")
    print(f"- Repo map: {REPO_MAP_PATH}")
    print(f"- Skill packs: {SKILLPACKS_PATH}")
    print(f"- Indexed files: {repo_map.get('file_count', 0)}")
    print(f"- Domains: {', '.join(sorted(skillpacks.get('packs', {}).keys()))}")
    return 0


def run_sandbox_prepare_command(args: argparse.Namespace) -> int:
    ticket_id = _normalize_ticket_id(args.ticket) if getattr(args, "ticket", None) else "adhoc"
    result = _prepare_sandbox(ticket_id, args.sandbox_dir or str(SANDBOX_ROOT))
    if result.get("ok"):
        print(f"Prepared sandbox: {result.get('path')}")
        return 0
    print(f"Sandbox preparation failed: {result.get('stderr') or result.get('stdout')}")
    return 1


def run_sandbox_status_command(args: argparse.Namespace) -> int:
    base_dirs = _managed_sandbox_base_dirs(args.sandbox_dir or str(SANDBOX_ROOT))
    rows = _collect_sandbox_status_rows(base_dirs)
    payload = {
        "base_dirs": [str(path) for path in base_dirs],
        "count": len(rows),
        "sandboxes": rows,
    }
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
        return 0
    print("Sandbox base dirs:")
    for base_dir in base_dirs:
        print(f"- {base_dir}")
    if not rows:
        print("No sandboxes found.")
        return 0
    for row in rows:
        ticket = row.get("ticket") or "adhoc"
        age = row.get("age_hours")
        age_text = f"{age}h" if age is not None else "unknown"
        flags: list[str] = []
        if row.get("reusable"):
            flags.append("reusable")
        if row.get("stale"):
            flags.append("stale")
        if row.get("dirty"):
            flags.append("dirty")
        if not row.get("has_metadata"):
            flags.append("no-metadata")
        flag_text = f" [{' '.join(flags)}]" if flags else ""
        print(f"- {row['name']} :: ticket={ticket} age={age_text} base={row['base_dir']}{flag_text}")
    return 0


def run_sandbox_clean_command(args: argparse.Namespace) -> int:
    ticket_id = _normalize_ticket_id(args.ticket) if getattr(args, "ticket", None) else None
    base_dirs = _managed_sandbox_base_dirs(args.sandbox_dir or str(SANDBOX_ROOT))
    rows = _collect_sandbox_status_rows(base_dirs)
    results = _cleanup_sandbox_rows(
        rows,
        remove_all=bool(getattr(args, "all", False)),
        ticket_id=ticket_id,
        allow_dirty=bool(getattr(args, "allow_dirty", False)),
    )
    payload = {
        "base_dirs": [str(path) for path in base_dirs],
        "ticket": ticket_id,
        "removed": results["removed"],
        "skipped": results["skipped"],
    }
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
        return 0
    print(f"Removed sandboxes: {len(results['removed'])}")
    for row in results["removed"]:
        print(f"- {row['path']}")
    if results["skipped"]:
        print("Skipped:")
        for row in results["skipped"]:
            print(f"- {row['path']} ({row['reason']})")
    return 0


def _text_filter_terms(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [part.strip().lower() for part in re.split(r"[|,]", raw) if part.strip()]


def _matches_text_filters(desc: str, require_text: str | None) -> bool:
    terms = _text_filter_terms(require_text)
    if not terms:
        return True
    lower = desc.lower()
    return any(term in lower for term in terms)


def run_sprint_command(args: argparse.Namespace) -> int:
    if args.action == "implement" and args.profile == "preview":
        raise ValueError("sprint implement requires write-capable profile (write, aiWrite, or aiWriteGit)")

    rows = _parse_ticket_rows()
    status_filter = args.status.upper() if args.status else "TODO"
    required_tag = args.require_tag.upper() if args.require_tag else ""
    require_text = str(getattr(args, "require_text", "") or "").strip()
    cooldown_minutes = max(0, int(getattr(args, "cooldown_minutes", 0) or 0))
    preferred_domain = str(getattr(args, "prefer_domain", "") or "").strip().lower()
    recent_runs = _recent_ticket_runs(args.action) if cooldown_minutes > 0 else {}
    now = datetime.now(timezone.utc)
    state = _load_state()
    repo_map = _ensure_repo_map()

    selected: list[dict[str, Any]] = []
    blocked_rows: list[str] = []
    cooled_down_rows: list[str] = []
    skipped_rows: list[tuple[int, dict[str, Any]]] = []
    for row in rows:
        if status_filter and row["status"].upper() != status_filter:
            continue
        if required_tag and required_tag not in row["tags"]:
            continue
        if require_text and not _matches_text_filters(row["desc"], require_text):
            continue
        recent_run = recent_runs.get(row["ticket_id"])
        if recent_run is not None and (now - recent_run).total_seconds() < cooldown_minutes * 60:
            cooled_down_rows.append(row["ticket_id"])
            continue
        temp_blocked, temp_reason = _is_ticket_temporarily_blocked(state, row["ticket_id"], now)
        if temp_blocked:
            blocked_rows.append(f"BAT<{row['ticket_id']}> ({temp_reason})")
            continue
        audit = assistant.audit_ticket(row["ticket_id"], row["desc"], final_files=None)
        if not audit.get("allowed", True):
            blocked_rows.append(f"BAT<{row['ticket_id']}> ({audit.get('block_reason', 'blocked')})")
            continue
        score = _ticket_selection_score(row, now=now, recent_runs=recent_runs, state=state, repo_map=repo_map)
        if preferred_domain and row.get("domain_focus") == preferred_domain:
            score += 25
        enriched = dict(row)
        enriched["selection_score"] = score
        skipped_rows.append((score, enriched))

    skipped_rows.sort(key=lambda item: (-item[0], item[1]["ticket_id"]))
    selected = [row for _score, row in skipped_rows[: max(1, args.count)]]

    if not selected:
        if cooldown_minutes > 0:
            print(f"No tickets matched sprint filters outside cooldown window ({cooldown_minutes} minutes).")
        else:
            print("No tickets matched sprint filters.")
        if blocked_rows:
            print("Blocked tickets skipped:")
            for row in blocked_rows[:10]:
                print(f"- {row}")
        return 0

    print(f"Sprint action: {args.action} | tickets: {', '.join('BAT<' + row['ticket_id'] + '>' for row in selected)}")
    if blocked_rows:
        print(f"Skipped blocked tickets: {', '.join(blocked_rows[:5])}")
    if cooled_down_rows:
        print(f"Skipped by cooldown: {', '.join('BAT<' + ticket + '>' for ticket in cooled_down_rows[:5])}")

    outcomes: list[dict[str, Any]] = []
    for row in selected:
        ticket_id = row["ticket_id"]
        # check eligibility
        tickets = assistant.load_tickets()
        desc = tickets.get(ticket_id, "")
        aud = assistant.audit_ticket(ticket_id, desc, final_files=None)
        if not aud.get("allowed", True):
            print(f"Skipping BAT<{ticket_id}> during sprint: {aud.get('block_reason')}")
            continue
        print(f"\n=== BAT<{ticket_id}> ===")
        action_args = argparse.Namespace(
            ticket=ticket_id,
            desc=None,
            mode="integrate",
            prefer_domain=preferred_domain or None,
            profile=args.profile,
            template=args.template,
            brainstorm=args.brainstorm,
            brainstorm_notes=args.brainstorm_notes,
            interactive=False,
            full_verify=args.full_verify,
            max_targeted_tests=args.max_targeted_tests,
            skip_verify=args.skip_verify,
            skip_learn=True,
            print_learn=False,
            skip_preflight=args.skip_preflight,
            ship=args.ship,
            fix_loop=args.fix_loop,
            fix_iterations=args.fix_iterations,
            safe_mode=args.safe_mode,
            safe_max_files=args.safe_max_files,
            allow_protected=args.allow_protected,
            allow_ship_in_safe_mode=args.allow_ship_in_safe_mode,
            prepare_sandbox=args.prepare_sandbox,
            sandbox_dir=args.sandbox_dir,
        )

        if args.action == "run":
            exit_code = run_pipeline_command(action_args)
            artifact = RUNS_DIR / f"BAT{ticket_id}_run.json"
        else:
            exit_code = run_implement_command(action_args)
            artifact = RUNS_DIR / f"BAT{ticket_id}_implement.json"

        artifact_payload: dict[str, Any] = {}
        if artifact.exists():
            try:
                artifact_payload = json.loads(artifact.read_text(encoding="utf-8"))
            except Exception:
                artifact_payload = {}

        outcome = {
            "ticket": ticket_id,
            "action": args.action,
            "exit_code": exit_code,
            "all_checks_passed": artifact_payload.get("all_checks_passed"),
            "artifact": str(artifact.relative_to(REPO_ROOT)) if artifact.exists() else "",
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        outcomes.append(outcome)

        if exit_code != 0 and not args.continue_on_fail:
            print("Stopping sprint due to failure (stop-on-fail enabled).")
            break

    ensure_runs_dir()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    summary_json = RUNS_DIR / f"sprint_{args.action}_{stamp}.json"
    summary_md = RUNS_DIR / f"sprint_{args.action}_{stamp}.md"
    payload = {
        "action": args.action,
        "count_requested": args.count,
        "status_filter": status_filter,
        "require_tag": required_tag or None,
        "require_text": require_text or None,
        "prefer_domain": preferred_domain or None,
        "profile": args.profile,
        "template": args.template,
        "blocked_skips": blocked_rows,
        "cooldown_skips": cooled_down_rows,
        "outcomes": outcomes,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    summary_json.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    lines = [
        f"# Sprint Summary ({args.action})",
        "",
        f"- Requested: {args.count}",
        f"- Status filter: {status_filter}",
        f"- Tag filter: {required_tag or 'none'}",
        f"- Text filter: {require_text or 'none'}",
        f"- Preferred domain: {preferred_domain or 'none'}",
        f"- Profile: {args.profile}",
        "",
        "## Outcomes",
    ]
    for row in outcomes:
        status = "PASS" if row.get("exit_code") == 0 else "FAIL"
        lines.append(f"- BAT<{row['ticket']}> [{status}] artifact: `{row.get('artifact','')}`")
    lines.append("")
    summary_md.write_text("\n".join(lines), encoding="utf-8")

    print(f"\nWrote {summary_json}")
    print(f"Wrote {summary_md}")

    if not args.skip_learn:
        _ = run_learn(write_report=True)
        print("Updated docs/DEV_ASSISTANT_LOG_REPORT.md")

    return 1 if any(row.get("exit_code") != 0 for row in outcomes) else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Solo Dev Assistant v1")
    subparsers = parser.add_subparsers(dest="command", required=True)

    plan_parser = subparsers.add_parser("plan", help="generate understand/plan output for a BAT ticket")
    plan_parser.add_argument("ticket", help="BAT ticket id (e.g. 172 or BAT<172>)")
    plan_parser.add_argument("--desc", help="manual description override")
    plan_parser.add_argument("--full-verify", action="store_true", help="include heavier verify commands")
    plan_parser.add_argument("--write-plan", action="store_true", help="write plan to docs/assistant_runs")
    plan_parser.add_argument("--brainstorm", action="store_true", help="enable keyword-driven brainstorming prompts (no effect in plan)")
    plan_parser.add_argument("--brainstorm-notes", help="seeded brainstorming notes (no effect in plan)")
    plan_parser.add_argument("--interactive", action="store_true", help="ask additional questions interactively (no effect in plan)")
    plan_parser.add_argument("--prefer-domain", help="prefer a domain such as dispatch, pricing, tracking, or payments when ranking files")
    plan_parser.set_defaults(handler=run_plan_command)

    run_parser = subparsers.add_parser("run", help="execute full solo-dev pipeline for a BAT ticket")
    run_parser.add_argument("ticket", help="BAT ticket id (e.g. 172 or BAT<172>)")
    run_parser.add_argument("--desc", help="manual description override")
    run_parser.add_argument(
        "--profile",
        default="preview",
        choices=sorted(PROFILE_MAP.keys()),
        help="scaffold profile: preview, write, aiWrite, aiWriteGit",
    )
    run_parser.add_argument("--template", default="auto", help="template name in backend/scripts/templates (or auto)")
    run_parser.add_argument("--brainstorm", action="store_true", help="enable keyword-driven brainstorming prompts")
    run_parser.add_argument("--brainstorm-notes", help="seeded brainstorming notes")
    run_parser.add_argument("--interactive", action="store_true", help="interactive prompts for brainstorm/description")
    run_parser.add_argument("--prefer-domain", help="prefer a domain such as dispatch, pricing, tracking, or payments when ranking files")
    run_parser.add_argument("--full-verify", action="store_true", help="run full test/build checks")
    run_parser.add_argument("--skip-verify", action="store_true", help="skip verify commands")
    run_parser.add_argument("--skip-preflight", action="store_true", help="skip preflight guardrails")
    run_parser.add_argument("--ship", action="store_true", help="run safe git ship automation if checks pass")
    run_parser.add_argument("--fix-loop", action="store_true", help="attempt AI fix pass when checks fail")
    run_parser.add_argument("--fix-iterations", type=int, default=1, help="max fix-loop iterations")
    run_parser.add_argument("--safe-mode", action="store_true", help="enable guardrails for protected domains and file caps")
    run_parser.add_argument("--safe-max-files", type=int, default=0, help="maximum created files allowed in safe mode")
    run_parser.add_argument("--allow-protected", action="store_true", help="override safe-mode block for protected domains")
    run_parser.add_argument("--allow-ship-in-safe-mode", action="store_true", help="allow git ship automation while safe mode is enabled")
    run_parser.add_argument("--prepare-sandbox", action="store_true", help="prepare a git worktree sandbox before the run")
    run_parser.add_argument("--sandbox-dir", help="sandbox parent directory for git worktree sandboxes")
    run_parser.add_argument("--skip-learn", action="store_true", help="skip log report refresh")
    run_parser.add_argument("--print-learn", action="store_true", help="print log report to stdout")
    run_parser.set_defaults(handler=run_pipeline_command)

    implement_parser = subparsers.add_parser(
        "implement",
        help="run implementation pipeline (plan + write-capable scaffold + verify + learn)",
    )
    implement_parser.add_argument("ticket", help="BAT ticket id (e.g. 172 or BAT<172>)")
    implement_parser.add_argument("--desc", help="manual description override")
    implement_parser.add_argument(
        "--profile",
        default="aiWriteGit",
        choices=IMPLEMENT_PROFILE_CHOICES,
        help="implementation profile: write, aiWrite, or aiWriteGit",
    )
    implement_parser.add_argument("--template", default="auto", help="template name in backend/scripts/templates (or auto)")
    implement_parser.add_argument("--brainstorm", action="store_true", help="enable keyword-driven brainstorming prompts")
    implement_parser.add_argument("--brainstorm-notes", help="seeded brainstorming notes")
    implement_parser.add_argument("--interactive", action="store_true", help="interactive prompts for brainstorm/description")
    implement_parser.add_argument("--prefer-domain", help="prefer a domain such as dispatch, pricing, tracking, or payments when ranking files")
    implement_parser.add_argument("--full-verify", action="store_true", help="run full test/build checks")
    implement_parser.add_argument("--max-targeted-tests", type=int, default=4, help="number of targeted pytest files to run")
    implement_parser.add_argument("--skip-verify", action="store_true", help="skip verify commands")
    implement_parser.add_argument("--skip-preflight", action="store_true", help="skip preflight guardrails")
    implement_parser.add_argument("--ship", action="store_true", help="run safe git ship automation if checks pass")
    implement_parser.add_argument("--fix-loop", action="store_true", help="attempt AI fix pass when checks fail")
    implement_parser.add_argument("--fix-iterations", type=int, default=1, help="max fix-loop iterations")
    implement_parser.add_argument("--safe-mode", action="store_true", help="enable guardrails for protected domains and file caps")
    implement_parser.add_argument("--safe-max-files", type=int, default=0, help="maximum created files allowed in safe mode")
    implement_parser.add_argument("--allow-protected", action="store_true", help="override safe-mode block for protected domains")
    implement_parser.add_argument("--allow-ship-in-safe-mode", action="store_true", help="allow git ship automation while safe mode is enabled")
    implement_parser.add_argument("--prepare-sandbox", action="store_true", help="prepare a git worktree sandbox before the run")
    implement_parser.add_argument("--sandbox-dir", help="sandbox parent directory for git worktree sandboxes")
    implement_parser.add_argument("--skip-learn", action="store_true", help="skip log report refresh")
    implement_parser.add_argument("--mode", choices=["audit","integrate","scaffold"], default="integrate",
        help="implementation mode: audit=inspect only, integrate=prefer existing files, scaffold=allow new file creation")
    implement_parser.add_argument("--print-learn", action="store_true", help="print log report to stdout")
    implement_parser.set_defaults(handler=run_implement_command)

    sprint_parser = subparsers.add_parser("sprint", help="batch run or implement tickets from BAT board")
    sprint_parser.add_argument("--action", default="implement", choices=SPRINT_ACTION_CHOICES, help="batch action")
    sprint_parser.add_argument("--count", type=int, default=5, help="number of tickets to process")
    sprint_parser.add_argument("--status", default="TODO", help="status tag to select (e.g. TODO, DONE)")
    sprint_parser.add_argument("--require-tag", help="optional tag filter (e.g. BE, FE, SEC, OPS)")
    sprint_parser.add_argument("--require-text", help="optional description text filter using | or comma separated terms")
    sprint_parser.add_argument("--prefer-domain", help="prefer tickets in a domain such as dispatch, pricing, tracking, or payments")
    sprint_parser.add_argument("--profile", default="write", choices=sorted(PROFILE_MAP.keys()), help="execution profile")
    sprint_parser.add_argument("--template", default="auto", help="template name in backend/scripts/templates (or auto)")
    sprint_parser.add_argument("--brainstorm", action="store_true", help="enable keyword-driven brainstorming prompts")
    sprint_parser.add_argument("--brainstorm-notes", help="seeded brainstorming notes")
    sprint_parser.add_argument("--full-verify", action="store_true", help="run full test/build checks")
    sprint_parser.add_argument("--max-targeted-tests", type=int, default=4, help="number of targeted pytest files to run")
    sprint_parser.add_argument("--skip-verify", action="store_true", help="skip verify commands")
    sprint_parser.add_argument("--skip-preflight", action="store_true", help="skip preflight guardrails")
    sprint_parser.add_argument("--ship", action="store_true", help="run safe git ship automation if checks pass")
    sprint_parser.add_argument("--fix-loop", action="store_true", help="attempt AI fix pass when checks fail")
    sprint_parser.add_argument("--fix-iterations", type=int, default=1, help="max fix-loop iterations")
    sprint_parser.add_argument("--safe-mode", action="store_true", help="enable guardrails for protected domains and file caps")
    sprint_parser.add_argument("--safe-max-files", type=int, default=0, help="maximum created files allowed in safe mode")
    sprint_parser.add_argument("--allow-protected", action="store_true", help="override safe-mode block for protected domains")
    sprint_parser.add_argument("--allow-ship-in-safe-mode", action="store_true", help="allow git ship automation while safe mode is enabled")
    sprint_parser.add_argument("--prepare-sandbox", action="store_true", help="prepare a git worktree sandbox before each run")
    sprint_parser.add_argument("--sandbox-dir", help="sandbox parent directory for git worktree sandboxes")
    sprint_parser.add_argument("--continue-on-fail", action="store_true", help="continue batch even if one ticket fails")
    sprint_parser.add_argument("--cooldown-minutes", type=int, default=0, help="skip tickets processed within the last N minutes")
    sprint_parser.add_argument("--skip-learn", action="store_true", help="skip log report refresh")
    sprint_parser.set_defaults(handler=run_sprint_command)

    learn_parser = subparsers.add_parser("learn", help="analyze assistant logs and print/write report")
    learn_parser.add_argument("--write-report", action="store_true", help="write docs/DEV_ASSISTANT_LOG_REPORT.md")
    learn_parser.set_defaults(handler=run_learn_command)

    engine_parser = subparsers.add_parser("engine-refresh", help="refresh engine repo-map and skill-pack artifacts")
    engine_parser.add_argument("--refresh-skillpacks", action="store_true", help="rewrite default skill packs artifact")
    engine_parser.set_defaults(handler=run_engine_refresh_command)

    sandbox_parser = subparsers.add_parser("sandbox-prepare", help="prepare a disposable git worktree sandbox")
    sandbox_parser.add_argument("ticket", nargs="?", help="BAT ticket id for sandbox naming")
    sandbox_parser.add_argument("--sandbox-dir", help="sandbox parent directory for git worktree sandboxes")
    sandbox_parser.set_defaults(handler=run_sandbox_prepare_command)

    sandbox_status_parser = subparsers.add_parser("sandbox-status", help="list current git worktree sandboxes and lifecycle status")
    sandbox_status_parser.add_argument("--sandbox-dir", help="sandbox parent directory for git worktree sandboxes")
    sandbox_status_parser.add_argument("--json", action="store_true", help="print sandbox status as JSON")
    sandbox_status_parser.set_defaults(handler=run_sandbox_status_command)

    sandbox_clean_parser = subparsers.add_parser("sandbox-clean", help="remove managed assistant git worktree sandboxes")
    sandbox_clean_parser.add_argument("ticket", nargs="?", help="optional BAT ticket id to target")
    sandbox_clean_parser.add_argument("--sandbox-dir", help="sandbox parent directory for git worktree sandboxes")
    sandbox_clean_parser.add_argument("--all", action="store_true", help="remove all managed sandboxes, not just stale ones")
    sandbox_clean_parser.add_argument("--allow-dirty", action="store_true", help="also remove sandboxes with uncommitted changes")
    sandbox_clean_parser.add_argument("--json", action="store_true", help="print cleanup results as JSON")
    sandbox_clean_parser.set_defaults(handler=run_sandbox_clean_command)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        code = args.handler(args)
    except ValueError as exc:
        parser.error(str(exc))
        return
    raise SystemExit(code)


if __name__ == "__main__":
    main()
