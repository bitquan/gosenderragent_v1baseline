from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from backend.agent.core.artifact_service import append_ci_report, write_human_summary, write_run_artifact
from backend.agent.core.audit_service import audit_ticket
from backend.agent.core.baseline_service import analyze_baseline_health, build_shared_root_repair_objective, cluster_failures, is_baseline_blocked, load_recent_runs, select_hotspot
from backend.agent.core.editor_context import normalize_editor_context
from backend.agent.core.log_service import append_run_log, build_run_log_entry
from backend.agent.core.memory_service import record_memory, ticket_cooldown_status
from backend.agent.core.notification_service import send_notification
from backend.agent.core.runtime_utils import diff_text, extract_deps_from_desc, run_mode
from backend.agent.core.state_service import clear_last_failure, load_state, mark_audited, mark_completed, record_last_failure, record_last_run, save_state
from backend.agent.core.training_service import run_training
from backend.agent.runtime.agent_runtime import run_ticket_runtime


def _base_result(ticket_id: str, mode: str, desc: str = "") -> dict[str, Any]:
    return {
        "ticket": ticket_id,
        "mode": mode,
        "desc": desc,
        "editor_context": {},
        "runtime_context": {},
        "audit": {},
        "plan": {},
        "execution": {"results": [], "created": [], "ok": True},
        "validation": {"results": [], "ok": True},
        "repair": {"repairs": [], "ok": True},
        "reasoning": {},
        "state_updates": {},
        "artifacts": {},
        "notifications": [],
        "runtime_task": {},
        "runtime_run": {},
        "runtime_result": {},
        "runtime_failure": {},
        "runtime_events": [],
        "runtime_artifacts": [],
        "training": {"triggered": False, "ok": True, "command": []},
        "ok": True,
    }


def _cooldown_until(retry_policy: dict[str, Any]) -> str:
    seconds = int((retry_policy or {}).get("cooldown_seconds") or 0)
    if seconds <= 0:
        return ""
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def _row_matches_hotspot(ticket_id: str, desc: str, hotspot: dict[str, Any] | None) -> bool:
    if not hotspot:
        return False
    text = str(desc or "").lower()
    path_hint = str(hotspot.get("path_hint") or "").strip().lower()
    summary = str(hotspot.get("summary") or "").strip().lower()
    family = str(hotspot.get("family") or "").strip().lower()
    if path_hint and (path_hint.lower() in text or Path(path_hint).name.lower() in text):
        return True
    if family in {"missing_fixture", "conftest_import", "missing_dependency", "import_setup", "placeholder_stub"}:
        keywords = ["baseline", "fixture", "conftest", "import", "dependency", "hotspot", "validation", "repair"]
        return any(keyword in text for keyword in keywords)
    return bool(summary and summary in text)


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
    result = _base_result(ticket_id, run_mode(args), desc)
    normalized_editor_context = normalize_editor_context(editor_context)
    result["editor_context"] = normalized_editor_context

    state = load_state(root)
    deps = extract_deps_from_desc(desc)
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
    write_gate = dict(result.get("write_gate") or {})
    if getattr(args, "repair_last", False) and created:
        clear_last_failure(current_state)
        state_updates["cleared_last_failure"] = True
    if getattr(args, "write", False) and write_gate.get("allow_write") and not created and not getattr(args, "repair_last", False):
        if validation.get("ok", True):
            state_updates["no_op_success"] = True
        else:
            record_last_failure(current_state, ticket_id)
            state_updates["lastFailedTicket"] = ticket_id
            result["ok"] = False
    if not getattr(args, "write", False) or not write_gate.get("allow_write"):
        mark_audited(current_state, ticket_id)
        state_updates["auditedTickets"] = current_state.get("auditedTickets", [])
    diff_text_value = diff_text(root, created)
    run_summary = diff_text_value.strip()[:1000] if diff_text_value else f"created {len(created)} file(s)"
    record_last_run(current_state, ticket_id, run_summary)
    state_updates["last_run"] = ticket_id
    state_updates["last_run_summary"] = run_summary
    current_run_mode = run_mode(args)
    if current_run_mode in {"autopilot", "batch", "scheduled"} and result["ok"] and write_gate.get("allow_write") and (getattr(args, "write", False) or getattr(args, "implement", False)):
        mark_completed(current_state, ticket_id)
        state_updates["completed"] = current_state.get("completed", [])
    save_state(root, current_state)
    result["state_updates"] = state_updates

    selected_patch_labels: list[str] = []
    for item in execution.get("results", []) or []:
        review = item.get("ai_patch_review") if isinstance(item, dict) else None
        label = review.get("selected_label") if isinstance(review, dict) else None
        if label:
            selected_patch_labels.append(str(label))
    for item in repair.get("repairs", []) or []:
        review = item.get("patch_review") if isinstance(item, dict) else None
        label = review.get("selected_label") if isinstance(review, dict) else None
        if label:
            selected_patch_labels.append(str(label))

    record_memory(
        root,
        ticket_id,
        audit.get("strategy", ""),
        created,
        result["ok"],
        metadata={
            "selected_patch_labels": selected_patch_labels,
            "validation_fingerprints": [
                str(item.get("label") or "")
                for item in list(result.get("validation", {}).get("fingerprints", []) or [])
                if str(item.get("label") or "")
            ],
            "retry_action": str((result.get("validation", {}).get("retry_policy") or result.get("repair", {}).get("retry_policy") or {}).get("action") or ""),
            "repair_skipped": bool(result.get("repair", {}).get("skipped", False)),
            "cooldown_until": _cooldown_until(result.get("validation", {}).get("retry_policy") or result.get("repair", {}).get("retry_policy") or {}),
            "decision_types": [
                str(item.get("type") or "")
                for item in list(result.get("engine_decisions", []) or [])
                if str(item.get("type") or "")
            ],
            "write_gate": dict(result.get("write_gate") or {}),
            "active_file_path": normalized_editor_context.get("active_file_path", ""),
            "run_id": str((result.get("runtime_run") or {}).get("run_id") or ""),
            "task_id": str((result.get("runtime_task") or {}).get("task_id") or ""),
            "action": str((result.get("runtime_task") or {}).get("action") or "run"),
            "mode": str((result.get("runtime_task") or {}).get("mode") or mode),
            "runtime_status": str((result.get("runtime_result") or {}).get("status") or ""),
            "final_state": str((result.get("runtime_result") or {}).get("final_state") or ""),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    )

    entry = build_run_log_entry(
        ticket=ticket_id,
        desc=desc,
        run_mode=current_run_mode,
        schedule=getattr(args, "schedule", None),
        ai=bool(getattr(args, "ai", False)),
        write=bool(getattr(args, "write", False)),
        git=bool(getattr(args, "git", False)),
        interactive=bool(getattr(args, "interactive", False)),
        brainstorm=bool(getattr(args, "brainstorm", False)),
        brainstorm_notes=bool(getattr(args, "brainstorm_notes", False)),
        template=getattr(args, "template", None),
        created=created,
        diff=diff_text_value,
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
    recent_runs = load_recent_runs(root)
    baseline_clusters = cluster_failures(recent_runs)
    baseline = analyze_baseline_health(recent_runs, baseline_clusters)
    hotspot = select_hotspot(baseline_clusters)
    repair_objective = build_shared_root_repair_objective(hotspot, recent_runs) if hotspot else None
    self_heal_mode = is_baseline_blocked(baseline)
    blocked: list[str] = []
    selected: list[str] = []
    selected_objectives: list[dict[str, Any]] = []

    if self_heal_mode:
        if repair_objective:
            selected_objectives = [repair_objective]
            blocked.extend(todos)
        else:
            hotspot_candidates = [
                ticket_id
                for ticket_id in todos
                if _row_matches_hotspot(ticket_id, tickets.get(ticket_id, ""), hotspot)
            ]
            if hotspot_candidates:
                selected = hotspot_candidates[:1]
                blocked.extend([ticket_id for ticket_id in todos if ticket_id not in selected])
            else:
                blocked.extend(todos)
                return {
                    "mode": "autopilot",
                    "selected_tickets": [],
                    "selected_objectives": [],
                    "blocked_tickets": blocked,
                    "results": [],
                    "training": run_training(root, getattr(args, "config", {}) or {}, args, _run_mode(args)),
                    "baseline": baseline,
                    "ok": True,
                }

    if selected_objectives:
        training = run_training(root, getattr(args, "config", {}) or {}, args, _run_mode(args))
        return {
            "mode": "autopilot",
            "selected_tickets": [],
            "selected_objectives": selected_objectives,
            "blocked_tickets": blocked,
            "results": [],
            "training": training,
            "baseline": baseline,
            "ok": True,
        }

    for ticket_id in todos:
        if self_heal_mode and selected and ticket_id not in selected:
            continue
        cooldown = ticket_cooldown_status(root, ticket_id)
        if cooldown.get("cooldown_active"):
            blocked.append(ticket_id)
            continue
        deps = _deps_from_desc(tickets.get(ticket_id, ""))
        completed = set(state.get("completed", []))
        if any(dep not in completed for dep in deps):
            blocked.append(ticket_id)
            continue
        audit = audit_ticket(adapter, ticket_id, tickets.get(ticket_id, ""), project_root=root, classify_ticket=classify_ticket, get_strategy=get_strategy)
        if audit.get("allowed"):
            selected.append(ticket_id)
    selected = selected[:count] if not (self_heal_mode and selected) else selected[:1]
    results = [run_ticket(adapter, ticket_id, mode="integrate", provider=provider, args=args, project_root=root, classify_ticket=classify_ticket, get_strategy=get_strategy, ignore_dirs=ignore_dirs, scaffold_fn=scaffold_fn, ensure_branch_fn=ensure_branch_fn, should_auto_implement_fn=should_auto_implement_fn) for ticket_id in selected]
    training = run_training(root, getattr(args, "config", {}) or {}, args, _run_mode(args))
    return {"mode": "autopilot", "selected_tickets": selected, "selected_objectives": [], "blocked_tickets": blocked, "results": results, "training": training, "baseline": baseline, "ok": all(item.get("ok", False) for item in results) if results else True}


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