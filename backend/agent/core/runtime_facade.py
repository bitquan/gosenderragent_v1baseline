from __future__ import annotations

import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from backend.agent.core.artifact_service import append_ci_report, write_human_summary, write_run_artifact
from backend.agent.core.audit_service import audit_ticket
from backend.agent.core.editor_context import normalize_editor_context
from backend.agent.core.log_service import append_run_log, build_run_log_entry
from backend.agent.core.memory_service import record_memory
from backend.agent.core.notification_service import send_notification
from backend.agent.core.state_service import clear_last_failure, load_state, mark_audited, mark_completed, record_last_failure, record_last_run, save_state
from backend.agent.core.training_service import run_training
from backend.agent.runtime.agent_runtime import run_ticket_runtime


def _deps_from_desc(desc: str) -> list[str]:
    import re

    return re.findall(r"\bDEP:([A-Z0-9_-]+)\b", desc.upper())


def _run_mode(args: Any) -> str:
    if getattr(args, "autopilot", False):
        return "scheduled" if getattr(args, "schedule", None) else "autopilot"
    if getattr(args, "batch", False):
        return "batch"
    if getattr(args, "schedule", None):
        return "scheduled"
    if getattr(args, "pilot", False):
        return "pilot"
    return "manual"


def _base_result(ticket_id: str, mode: str, desc: str = "") -> dict[str, Any]:
    return {
        "ticket": ticket_id,
        "mode": mode,
        "desc": desc,
        "editor_context": {},
        "audit": {},
        "plan": {},
        "execution": {"results": [], "created": [], "ok": True},
        "validation": {"results": [], "ok": True},
        "repair": {"repairs": [], "ok": True},
        "reasoning": {},
        "state_updates": {},
        "artifacts": {},
        "notifications": [],
        "training": {"triggered": False, "ok": True, "command": []},
        "ok": True,
    }


def _diff_text(project_root: Path, created: list[str]) -> str:
    if not created:
        return ""
    try:
        return subprocess.check_output(["git", "diff", "HEAD~1", "HEAD", "--", *created], cwd=str(project_root), text=True, stderr=subprocess.DEVNULL)
    except Exception:
        try:
            return subprocess.check_output(["git", "diff", "--", *created], cwd=str(project_root), text=True, stderr=subprocess.DEVNULL)
        except Exception:
            return ""


def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _json_safe(val) for key, val in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    if hasattr(value, "__dict__"):
        return _json_safe(vars(value))
    return value


def run_ticket(
    adapter,
    ticket_id: str,
    *,
    mode: str = "integrate",
    provider: Any = None,
    args: Any = None,
    project_root: Path | None = None,
    classify_ticket: Callable[[str], tuple[str, str]] | None = None,
    get_strategy: Callable[[str], Any] | None = None,
    ignore_dirs: set[str] | None = None,
    scaffold_fn: Callable[..., list[str]] | None = None,
    ensure_branch_fn: Callable[[str, str], str | None] | None = None,
    should_auto_implement_fn: Callable[[dict[str, Any]], bool] | None = None,
    compute_embedding_fn: Callable[[str], list[float]] | None = None,
    store_embedding_fn: Callable[[str, str, list[float]], None] | None = None,
    editor_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    root = project_root or getattr(adapter, "project_root", Path.cwd())
    args = args or object()
    desc = adapter.load_tickets().get(ticket_id, "")
    result = _base_result(ticket_id, _run_mode(args), desc)
    normalized_editor_context = normalize_editor_context(editor_context)
    result["editor_context"] = normalized_editor_context

    state = load_state(root)
    deps = _deps_from_desc(desc)
    if deps:
        completed = set(state.get("completed", []))
        missing = [dep for dep in deps if dep not in completed]
        if missing:
            result["audit"] = {"ticket": ticket_id, "allowed": False, "block_reason": f"dependencies not completed: {', '.join(missing)}"}
            result["ok"] = False
            return result

    if getattr(args, "write", False) and state.get("auditEnforced") and state.get("last_run") != ticket_id:
        result["audit"] = {"ticket": ticket_id, "allowed": False, "block_reason": f"Audit enforced: please run {ticket_id} before implementing."}
        result["ok"] = False
        return result

    runtime_result = run_ticket_runtime(
        adapter,
        ticket_id,
        mode=mode,
        provider=provider,
        args=args,
        project_root=root,
        classify_ticket=classify_ticket,
        get_strategy=get_strategy,
        ignore_dirs=ignore_dirs,
        scaffold_fn=scaffold_fn,
        ensure_branch_fn=ensure_branch_fn,
        should_auto_implement_fn=should_auto_implement_fn,
        editor_context=normalized_editor_context,
    )
    result.update(runtime_result)
    audit = result["audit"]
    plan = result["plan"]
    execution = result["execution"]
    validation = result["validation"]
    repair = result["repair"]
    created = list(execution.get("created", []))
    branch = execution.get("branch")
    if getattr(args, "plan", False):
        if getattr(args, "notify_url", None):
            result["notifications"].append(send_notification(root, args.notify_url, {"ticket": ticket_id, "mode": "plan"}))
        return result

    current_state = load_state(root)
    state_updates: dict[str, Any] = {}
    if getattr(args, "repair_last", False) and created:
        clear_last_failure(current_state)
        state_updates["cleared_last_failure"] = True
    if getattr(args, "write", False) and not created and not getattr(args, "repair_last", False):
        record_last_failure(current_state, ticket_id)
        state_updates["lastFailedTicket"] = ticket_id
        result["ok"] = False
    if not getattr(args, "write", False):
        mark_audited(current_state, ticket_id)
        state_updates["auditedTickets"] = current_state.get("auditedTickets", [])
    diff_text = _diff_text(root, created)
    run_summary = diff_text.strip()[:1000] if diff_text else f"created {len(created)} file(s)"
    record_last_run(current_state, ticket_id, run_summary)
    state_updates["last_run"] = ticket_id
    state_updates["last_run_summary"] = run_summary
    run_mode = _run_mode(args)
    if run_mode in {"autopilot", "batch", "scheduled"} and result["ok"] and (getattr(args, "write", False) or getattr(args, "implement", False)):
        mark_completed(current_state, ticket_id)
        state_updates["completed"] = current_state.get("completed", [])
    save_state(root, current_state)
    result["state_updates"] = state_updates

    record_memory(root, ticket_id, audit.get("strategy", ""), created, result["ok"])

    entry = build_run_log_entry(
        ticket=ticket_id,
        desc=desc,
        run_mode=run_mode,
        schedule=getattr(args, "schedule", None),
        ai=bool(getattr(args, "ai", False)),
        write=bool(getattr(args, "write", False)),
        git=bool(getattr(args, "git", False)),
        interactive=bool(getattr(args, "interactive", False)),
        brainstorm=bool(getattr(args, "brainstorm", False)),
        brainstorm_notes=bool(getattr(args, "brainstorm_notes", False)),
        template=getattr(args, "template", None),
        created=created,
        diff=diff_text,
    )
    if compute_embedding_fn is not None:
        try:
            embedding = compute_embedding_fn(desc or "")
            entry["embedding"] = embedding
            if store_embedding_fn is not None:
                store_embedding_fn(ticket_id, desc or "", embedding)
        except Exception:
            pass
    append_run_log(root, entry)

    if getattr(args, "ci_report", None):
        append_ci_report(args.ci_report, {"ticket": ticket_id, "ok": result["ok"], "branch": branch})
    if getattr(args, "notify_url", None):
        result["notifications"].append(send_notification(root, args.notify_url, {"ticket": ticket_id, "ok": result["ok"], "branch": branch}))
    return result


def run_autopilot(adapter, *, count: int = 1, args: Any = None, provider: Any = None, project_root: Path | None = None, classify_ticket: Callable[[str], tuple[str, str]] | None = None, get_strategy: Callable[[str], Any] | None = None, ignore_dirs: set[str] | None = None, scaffold_fn: Callable[..., list[str]] | None = None, ensure_branch_fn: Callable[[str, str], str | None] | None = None, should_auto_implement_fn: Callable[[dict[str, Any]], bool] | None = None) -> dict[str, Any]:
    root = project_root or getattr(adapter, "project_root", Path.cwd())
    args = args or object()
    state = load_state(root)
    tickets = adapter.load_tickets()
    todos = [ticket_id for ticket_id, desc in tickets.items() if "TODO" in desc.upper() and ticket_id not in state.get("completed", [])]
    blocked: list[str] = []
    selected: list[str] = []
    for ticket_id in todos:
        deps = _deps_from_desc(tickets.get(ticket_id, ""))
        completed = set(state.get("completed", []))
        if any(dep not in completed for dep in deps):
            blocked.append(ticket_id)
            continue
        audit = audit_ticket(adapter, ticket_id, tickets.get(ticket_id, ""), project_root=root, classify_ticket=classify_ticket, get_strategy=get_strategy)
        if audit.get("allowed"):
            selected.append(ticket_id)
    selected = selected[:count]
    results = [run_ticket(adapter, ticket_id, mode="integrate", provider=provider, args=args, project_root=root, classify_ticket=classify_ticket, get_strategy=get_strategy, ignore_dirs=ignore_dirs, scaffold_fn=scaffold_fn, ensure_branch_fn=ensure_branch_fn, should_auto_implement_fn=should_auto_implement_fn) for ticket_id in selected]
    training = run_training(root, getattr(args, "config", {}) or {}, args, _run_mode(args))
    return {"mode": "autopilot", "selected_tickets": selected, "blocked_tickets": blocked, "results": results, "training": training, "ok": all(item.get("ok", False) for item in results) if results else True}


def run_pilot(adapter, *, count: int = 1, args: Any = None, provider: Any = None, project_root: Path | None = None, classify_ticket: Callable[[str], tuple[str, str]] | None = None, get_strategy: Callable[[str], Any] | None = None, ignore_dirs: set[str] | None = None, scaffold_fn: Callable[..., list[str]] | None = None, ensure_branch_fn: Callable[[str, str], str | None] | None = None) -> dict[str, Any]:
    root = project_root or getattr(adapter, "project_root", Path.cwd())
    tickets = adapter.load_tickets()
    allowed = {"DOC", "QA", "FE", "CI"}
    excluded = {"AUTH", "PAYMENT", "MIGRATION", "SECURITY", "LIFECYCLE", "WALLET"}
    selected: list[str] = []
    for ticket_id, desc in tickets.items():
        if len(selected) >= count:
            break
        upper = desc.upper()
        audit = audit_ticket(adapter, ticket_id, desc, project_root=root, classify_ticket=classify_ticket, get_strategy=get_strategy)
        if not audit.get("allowed"):
            continue
        if not any(token in upper for token in allowed):
            continue
        if any(token in upper for token in excluded):
            continue
        selected.append(ticket_id)
    results = [run_ticket(adapter, ticket_id, mode="integrate", provider=provider, args=args, project_root=root, classify_ticket=classify_ticket, get_strategy=get_strategy, ignore_dirs=ignore_dirs, scaffold_fn=scaffold_fn, ensure_branch_fn=ensure_branch_fn) for ticket_id in selected]
    return {"mode": "pilot", "selected_tickets": selected, "results": results, "ok": all(item.get("ok", False) for item in results) if results else True}


def summarize_repo(adapter, *, args: Any = None) -> dict[str, Any]:
    del args
    return {"repo": adapter.generate_repo_map(), "ok": True}