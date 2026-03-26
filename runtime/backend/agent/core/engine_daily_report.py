from __future__ import annotations

from collections import Counter
import json
from datetime import datetime, timezone
from pathlib import Path
import re
from typing import Any

from backend.agent.core.artifact_service import summarize_experiment_dataset
from backend.agent.core.engine_baseline_summary import (
    _filter_recent_rows,
    _load_jsonl,
    _parse_training_next_actions,
    _top_counter_rows,
    build_engine_baseline_summary,
)
from backend.agent.core.storage_paths import assistant_experiment_dataset_path, assistant_runs_dir, assistant_training_output_path


_BOARD_ITEM_RE = re.compile(r"^\s*-\s+BAT<(?P<ticket>[^>]+)>\s+(?P<status>[A-Z-]+):\s+(?P<desc>.+)$")
_BOARD_BULLET_RE = re.compile(r"^\s*-\s+(?P<text>.+)$")
_MISSING_CAPABILITY_TICKETS = {
    "AUTONOMY-BASE-001",
    "AUTONOMY-BASE-002",
    "MODEL-PARITY-001",
    "PERF-ENGINE-001",
    "MODEL-BASE-007",
    "UIUX-CLEANUP-003",
    "QUALITY-ROUTE-002",
    "OPS-006",
    "AUDIT-001",
}


def _safe_rate(numerator: int | float, denominator: int | float) -> float:
    return float(numerator) / float(denominator) if denominator else 0.0


def _qwen_guardrails() -> list[str]:
    return [
        "Force short numbered plans with 3-5 concrete steps.",
        "Prefer direct file edits and minimal diffs over speculative rewrites.",
        "Run targeted validation first before broader verification.",
        "Escalate to review after repeated low-confidence or repair-heavy attempts.",
    ]


def _normalize_text(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def _category_for_maintenance_item(text: str) -> str:
    lowered = _normalize_text(text).lower()
    if not lowered:
        return "implement"
    if any(token in lowered for token in ("remove", "retire", "archive", "delete", "stale doc", "stale docs", "duplicate")):
        return "remove"
    if any(token in lowered for token in ("upgrade", "update", "promote", "rollback", "release", "package", "import")):
        return "upgrade"
    if any(token in lowered for token in ("fix", "broken", "failure", "queue", "blocker", "unify", "align", "honest", "gating")):
        return "fix"
    if any(token in lowered for token in ("test", "proof", "validate", "validation", "acceptance", "rerun", "coverage")):
        return "test"
    if any(token in lowered for token in ("tune", "latency", "performance", "reduce", "shrink", "rescope", "parity", "vocabulary", "wording")):
        return "tune"
    return "implement"


def _read_board_state(project_root: Path) -> dict[str, Any]:
    board_path = project_root / "docs" / "BAT_FEATURE_BOARD.md"
    state: dict[str, Any] = {
        "working": [],
        "broken": [],
        "todo_items": [],
        "done_items": [],
    }
    if not board_path.exists():
        return state

    section = ""
    audit_bucket = ""
    seen_tickets: set[str] = set()
    for raw_line in board_path.read_text(encoding="utf-8").splitlines():
        stripped = str(raw_line or "").strip()
        if stripped.startswith("## "):
            section = stripped
            audit_bucket = ""
            continue

        if section == "## 3. Current Audit Snapshot":
            if stripped == "What is working:":
                audit_bucket = "working"
                continue
            if stripped == "What is still broken:":
                audit_bucket = "broken"
                continue
            bullet_match = _BOARD_BULLET_RE.match(stripped)
            if audit_bucket and bullet_match:
                text = _normalize_text(bullet_match.group("text"))
                if text:
                    state[audit_bucket].append(text)
            continue

        if section == "## 9. Active Board":
            item_match = _BOARD_ITEM_RE.match(stripped)
            if not item_match:
                continue
            ticket = _normalize_text(item_match.group("ticket"))
            if not ticket or ticket in seen_tickets:
                continue
            seen_tickets.add(ticket)
            status = _normalize_text(item_match.group("status")).upper() or "TODO"
            desc = _normalize_text(item_match.group("desc"))
            item = {
                "ticket": ticket,
                "status": status,
                "desc": desc,
                "summary": desc,
            }
            if status == "DONE":
                state["done_items"].append(item)
            else:
                state["todo_items"].append(item)

    return state


def _maintenance_item(
    label: str,
    *,
    category: str,
    source: str,
    status: str,
    ticket: str = "",
    details: str = "",
) -> dict[str, str]:
    return {
        "label": _normalize_text(label),
        "category": _normalize_text(category) or "implement",
        "source": _normalize_text(source) or "daily-report",
        "status": _normalize_text(status) or "open",
        "ticket": _normalize_text(ticket),
        "details": _normalize_text(details),
    }


def _append_unique_item(items: list[dict[str, str]], seen: set[tuple[str, str, str]], item: dict[str, str]) -> None:
    key = (
        _normalize_text(item.get("status")).lower(),
        _normalize_text(item.get("ticket")).lower(),
        _normalize_text(item.get("label")).lower(),
    )
    if key in seen or not key[2]:
        return
    seen.add(key)
    items.append(item)


def _build_maintenance_checklist(
    project_root: Path,
    *,
    baseline_summary: dict[str, Any],
    daily_focus: dict[str, Any],
    blocker_rows: list[dict[str, Any]],
    retry_rows: list[dict[str, Any]],
    training_action_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    board_state = _read_board_state(project_root)
    baseline = dict(baseline_summary.get("baseline") or {})
    runtime = dict(baseline_summary.get("runtime") or {})
    daily_quota_proof = dict(baseline_summary.get("daily_quota_proof") or {})
    fingerprints = [dict(item) for item in list(baseline_summary.get("common_failure_fingerprints") or []) if isinstance(item, dict)]

    completed_today: list[dict[str, str]] = []
    open_today: list[dict[str, str]] = []
    new_problems_today: list[dict[str, str]] = []
    missing_today: list[dict[str, str]] = []
    notes: list[str] = []
    seen: set[tuple[str, str, str]] = set()

    open_board_items = [dict(item) for item in list(board_state.get("todo_items") or []) if isinstance(item, dict)]
    missing_capability_items = [
        item
        for item in open_board_items
        if str(item.get("ticket") or "") in _MISSING_CAPABILITY_TICKETS
    ]

    completed_today.append(
        _maintenance_item(
            "Reviewed runtime baseline state.",
            category="audit",
            source="daily-report",
            status="completed",
            details=f"{baseline.get('state', 'unknown')} baseline; blocked={bool(baseline.get('blocked', False))}; {baseline.get('reason', 'n/a')}",
        )
    )
    completed_today.append(
        _maintenance_item(
            "Reviewed review, repair, and validation pressure.",
            category="audit",
            source="daily-report",
            status="completed",
            details=(
                f"{runtime.get('run_count', 0)} runs; "
                f"{runtime.get('review_request_count', 0)} review-held; "
                f"{runtime.get('repair_attempt_count', 0)} executed repairs; "
                f"{dict(daily_quota_proof.get('validation') or {}).get('pass_count', 0)} pass / "
                f"{dict(daily_quota_proof.get('validation') or {}).get('fail_count', 0)} fail today"
            ),
        )
    )
    completed_today.append(
        _maintenance_item(
            "Reviewed board backlog and current audit snapshot.",
            category="audit",
            source="board",
            status="completed",
            details=f"{len(open_board_items)} active TODO BAT items; {len(list(board_state.get('broken') or []))} current broken audit bullets.",
        )
    )
    completed_today.append(
        _maintenance_item(
            "Reviewed missing engine capability gaps for faster returns.",
            category="audit",
            source="board",
            status="completed",
            details=f"{len(missing_capability_items)} priority capability gaps still open.",
        )
    )

    for item in open_board_items[:8]:
        desc = str(item.get("desc") or "")
        ticket = str(item.get("ticket") or "")
        _append_unique_item(
            open_today,
            seen,
            _maintenance_item(
                desc,
                category=_category_for_maintenance_item(desc),
                source="board",
                status="open",
                ticket=f"BAT<{ticket}>" if ticket else "",
            ),
        )
    for text in list(board_state.get("broken") or [])[:6]:
        _append_unique_item(
            open_today,
            seen,
            _maintenance_item(
                text,
                category=_category_for_maintenance_item(text),
                source="board-audit",
                status="open",
            ),
        )

    for row in fingerprints[:4]:
        label = _normalize_text(row.get("label"))
        count = int(row.get("count") or 0)
        if not label:
            continue
        _append_unique_item(
            new_problems_today,
            seen,
            _maintenance_item(
                f"Observed recent failure fingerprint: {label}",
                category=_category_for_maintenance_item(label),
                source="runtime-fingerprint",
                status="new",
                details=f"{count} recent hit(s)",
            ),
        )
    for row in blocker_rows[:4]:
        label = _normalize_text(row.get("label"))
        count = int(row.get("count") or 0)
        if not label:
            continue
        _append_unique_item(
            new_problems_today,
            seen,
            _maintenance_item(
                f"Observed blocker trend: {label}",
                category=_category_for_maintenance_item(label),
                source="experiment-blocker",
                status="new",
                details=f"{count} recent hit(s)",
            ),
        )
    if not bool(runtime.get("has_true_execution_runs", False)):
        _append_unique_item(
            new_problems_today,
            seen,
            _maintenance_item(
                "No true execution runs were recorded in the selected audit window.",
                category="test",
                source="runtime-window",
                status="new",
            ),
        )

    for item in missing_capability_items[:6]:
        desc = str(item.get("desc") or "")
        ticket = str(item.get("ticket") or "")
        _append_unique_item(
            missing_today,
            seen,
            _maintenance_item(
                desc,
                category=_category_for_maintenance_item(desc),
                source="board-capability-gap",
                status="missing",
                ticket=f"BAT<{ticket}>" if ticket else "",
            ),
        )

    for action in list(daily_focus.get("operator_actions") or [])[:4]:
        text = _normalize_text(action)
        if text:
            notes.append(text)
    if retry_rows:
        notes.append(
            f"Retry pressure still leans to {retry_rows[0].get('action', 'repair')} ({int(retry_rows[0].get('count') or 0)} recent experiment rows)."
        )
    if training_action_rows:
        notes.append(
            f"Most common training next action is {training_action_rows[0].get('label', 'inspect artifacts')} ({int(training_action_rows[0].get('count') or 0)} rows)."
        )
    if list(board_state.get("broken") or []):
        notes.append(f"Board still flags: {list(board_state.get('broken') or [])[0]}")

    audit_log: list[dict[str, str]] = []
    for bucket_name, bucket in (
        ("verified", completed_today),
        ("open", open_today),
        ("new", new_problems_today),
        ("missing", missing_today),
    ):
        for item in bucket[:8]:
            audit_log.append(
                {
                    "kind": bucket_name,
                    "category": str(item.get("category") or ""),
                    "ticket": str(item.get("ticket") or ""),
                    "label": str(item.get("label") or ""),
                    "source": str(item.get("source") or ""),
                    "details": str(item.get("details") or ""),
                }
            )

    deduped_notes: list[str] = []
    seen_notes: set[str] = set()
    for note in notes:
        key = _normalize_text(note).lower()
        if not key or key in seen_notes:
            continue
        seen_notes.add(key)
        deduped_notes.append(_normalize_text(note))

    return {
        "completed_today": completed_today,
        "open_today": open_today,
        "new_problems_today": new_problems_today,
        "missing_today": missing_today,
        "audit_notes": deduped_notes[:6],
        "audit_log": audit_log[:24],
    }


def _format_checklist_item(item: dict[str, Any], *, default_status: str = "open") -> str:
    status = _normalize_text(item.get("status") or default_status).lower() or default_status
    category = _normalize_text(item.get("category") or "note").lower() or "note"
    ticket = _normalize_text(item.get("ticket"))
    source = _normalize_text(item.get("source"))
    label = _normalize_text(item.get("label"))
    details = _normalize_text(item.get("details"))
    tags = [status, category]
    if ticket:
        tags.append(ticket)
    if source:
        tags.append(source)
    detail_suffix = f" ({details})" if details else ""
    return f"- [{' | '.join(tags)}] {label}{detail_suffix}"


def _focus_payload(
    baseline_summary: dict[str, Any],
    benchmark_summary: dict[str, Any],
    blocker_rows: list[dict[str, Any]],
    retry_rows: list[dict[str, Any]],
    action_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    baseline = dict(baseline_summary.get("baseline") or {})
    runtime = dict(baseline_summary.get("runtime") or {})
    review_request_count = int(runtime.get("review_request_count") or 0)
    review_required_count = int(benchmark_summary.get("review_required_count") or 0)
    low_confidence_run_count = int(benchmark_summary.get("low_confidence_run_count") or 0)
    average_repair_count = float(benchmark_summary.get("average_repair_count") or 0.0)

    suggested_workstream = "continue-safe-engine-slices"
    reason = "Recent signals are stable enough for another small engine-owned improvement slice."
    if bool(baseline.get("blocked")):
        suggested_workstream = "unblock-runtime"
        reason = str(baseline.get("reason") or "Baseline is currently blocked by recent failures.")
    elif review_request_count > 0 or review_required_count > 0:
        suggested_workstream = "review-and-triage"
        reason = "Recent runs or experiments still require manual review before widening scope."
    elif blocker_rows and int(blocker_rows[0].get("count") or 0) >= 2:
        suggested_workstream = "stabilize-validation"
        reason = f"Repeated blocker detected: {blocker_rows[0].get('label', 'validation failure')}."
    elif low_confidence_run_count > 0:
        suggested_workstream = "tighten-small-model-scope"
        reason = "Low-confidence patches were observed in recent experiments."
    elif average_repair_count >= 1.0:
        suggested_workstream = "reduce-repair-loops"
        reason = "Repair pressure is still elevated across recent experiments."

    operator_actions: list[str] = []
    if review_request_count > 0 or review_required_count > 0:
        operator_actions.append("Clear review-required runs before scheduling broader autonomous work.")
    if blocker_rows:
        operator_actions.append(
            f"Target the top blocker first: {blocker_rows[0].get('label', 'unknown blocker')} ({int(blocker_rows[0].get('count') or 0)} hits)."
        )
    if retry_rows:
        operator_actions.append(
            f"Bias the next slice toward a single retry policy: {retry_rows[0].get('action', 'repair')} ({int(retry_rows[0].get('count') or 0)} recent experiment rows)."
        )
    if action_rows:
        operator_actions.append(f"Keep the next operator-visible action narrow: {action_rows[0].get('label', 'inspect artifacts')}.")

    deduped_actions: list[str] = []
    seen: set[str] = set()
    for label in operator_actions:
        key = " ".join(label.strip().lower().split())
        if not key or key in seen:
            continue
        seen.add(key)
        deduped_actions.append(label)

    return {
        "suggested_workstream": suggested_workstream,
        "reason": reason,
        "operator_actions": deduped_actions[:4],
        "qwen_guardrails": _qwen_guardrails(),
    }


def build_engine_daily_report(
    project_root: Path,
    *,
    lookback_hours: int = 24,
    run_limit: int = 30,
    experiment_limit: int = 60,
    training_limit: int = 120,
) -> dict[str, Any]:
    baseline_summary = build_engine_baseline_summary(
        project_root,
        lookback_hours=lookback_hours,
        run_limit=run_limit,
        experiment_limit=experiment_limit,
        training_limit=training_limit,
    )

    experiment_dataset_path = assistant_experiment_dataset_path(project_root)
    experiment_rows = _filter_recent_rows(
        _load_jsonl(experiment_dataset_path),
        lookback_hours=lookback_hours,
        limit=experiment_limit,
    )
    benchmark_summary = summarize_experiment_dataset(project_root, rows=experiment_rows, target=experiment_dataset_path)

    blocker_rows = [dict(item) for item in list(benchmark_summary.get("repeated_blockers") or []) if isinstance(item, dict)]
    retry_rows = [dict(item) for item in list(benchmark_summary.get("retry_actions") or []) if isinstance(item, dict)]

    training_output_path = assistant_training_output_path(project_root)
    training_rows = _load_jsonl(training_output_path)[: max(1, training_limit)] if training_output_path.exists() else []
    training_action_counter: Counter[str] = Counter()
    for row in training_rows:
        for label in _parse_training_next_actions(row):
            normalized = str(label or "").strip()
            if normalized:
                training_action_counter[normalized] += 1
    training_action_rows = _top_counter_rows(training_action_counter, {key.lower(): key for key in training_action_counter}, limit=4)

    focus = _focus_payload(
        baseline_summary,
        benchmark_summary,
        blocker_rows,
        retry_rows,
        [dict(item) for item in list(baseline_summary.get("common_recommended_actions") or []) if isinstance(item, dict)]
        or training_action_rows,
    )

    experiments = dict(baseline_summary.get("experiments") or {})
    retry_policy_repair_count = sum(
        int(item.get("count") or 0)
        for item in retry_rows
        if str(item.get("action") or "").strip().lower() == "repair"
    )
    experiments.update(
        {
            "strategy_count": int(benchmark_summary.get("strategy_count") or 0),
            "low_confidence_run_count": int(benchmark_summary.get("low_confidence_run_count") or 0),
            "low_confidence_patch_rate": float(benchmark_summary.get("low_confidence_patch_rate") or 0.0),
            "average_repair_count": float(benchmark_summary.get("average_repair_count") or 0.0),
            "retry_policy_repair_count": retry_policy_repair_count,
            "recommended_next_strategy": str(benchmark_summary.get("recommended_next_strategy") or ""),
            "recommended_next_action": str(benchmark_summary.get("recommended_next_action") or ""),
            "best_strategy": dict(benchmark_summary.get("best_strategy") or {}),
            "weakest_strategy": dict(benchmark_summary.get("weakest_strategy") or {}),
        }
    )

    training = dict(baseline_summary.get("training") or {})
    training.update(
        {
            "next_action_rows": training_action_rows,
        }
    )

    maintenance_checklist = _build_maintenance_checklist(
        project_root,
        baseline_summary=baseline_summary,
        daily_focus=focus,
        blocker_rows=blocker_rows,
        retry_rows=retry_rows,
        training_action_rows=training_action_rows,
    )

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "project_root": str(project_root),
        "window": {
            "lookback_hours": int(lookback_hours),
            "run_limit": int(run_limit),
            "experiment_limit": int(experiment_limit),
            "training_limit": int(training_limit),
        },
        "baseline": dict(baseline_summary.get("baseline") or {}),
        "runtime": dict(baseline_summary.get("runtime") or {}),
        "experiments": experiments,
        "training": training,
        "daily_quota_proof": dict(baseline_summary.get("daily_quota_proof") or {}),
        "daily_focus": focus,
        "maintenance_checklist": maintenance_checklist,
        "top_blockers": blocker_rows[:6],
        "retry_actions": retry_rows[:5],
        "common_failure_fingerprints": [
            dict(item)
            for item in list(baseline_summary.get("common_failure_fingerprints") or [])
            if isinstance(item, dict)
        ][:6],
        "common_recommended_actions": [
            dict(item)
            for item in list(baseline_summary.get("common_recommended_actions") or [])
            if isinstance(item, dict)
        ][:6],
    }


def render_engine_daily_report(report: dict[str, Any]) -> str:
    baseline = dict(report.get("baseline") or {})
    runtime = dict(report.get("runtime") or {})
    experiments = dict(report.get("experiments") or {})
    training = dict(report.get("training") or {})
    daily_quota_proof = dict(report.get("daily_quota_proof") or {})
    daily_focus = dict(report.get("daily_focus") or {})
    maintenance = dict(report.get("maintenance_checklist") or {})
    blockers = [dict(item) for item in list(report.get("top_blockers") or []) if isinstance(item, dict)]
    retry_actions = [dict(item) for item in list(report.get("retry_actions") or []) if isinstance(item, dict)]
    fingerprints = [dict(item) for item in list(report.get("common_failure_fingerprints") or []) if isinstance(item, dict)]
    actions = [dict(item) for item in list(report.get("common_recommended_actions") or []) if isinstance(item, dict)]
    training_actions = [dict(item) for item in list(training.get("next_action_rows") or []) if isinstance(item, dict)]
    completed_today = [dict(item) for item in list(maintenance.get("completed_today") or []) if isinstance(item, dict)]
    open_today = [dict(item) for item in list(maintenance.get("open_today") or []) if isinstance(item, dict)]
    new_problems_today = [dict(item) for item in list(maintenance.get("new_problems_today") or []) if isinstance(item, dict)]
    missing_today = [dict(item) for item in list(maintenance.get("missing_today") or []) if isinstance(item, dict)]
    audit_notes = [str(item) for item in list(maintenance.get("audit_notes") or []) if str(item).strip()]
    audit_log = [dict(item) for item in list(maintenance.get("audit_log") or []) if isinstance(item, dict)]

    def _percent(value: Any) -> str:
        return f"{float(value or 0.0) * 100:.1f}%"

    lines = [
        "# Engine Daily Report",
        "",
        f"- Generated: {report.get('generated_at', '')}",
        f"- Project root: {report.get('project_root', '')}",
        f"- Window: last {dict(report.get('window') or {}).get('lookback_hours', 0)}h",
        "",
        "## Daily Focus",
        "",
        f"- Suggested workstream: {daily_focus.get('suggested_workstream', 'continue-safe-engine-slices')}",
        f"- Reason: {daily_focus.get('reason', 'n/a')}",
        "",
        "## Maintenance Checklist",
        "",
        "### Completed Today",
        "",
    ]
    if completed_today:
        lines.extend(_format_checklist_item(item, default_status="completed") for item in completed_today)
    else:
        lines.append("- [completed | audit] No completed audit checks recorded yet.")

    lines.extend(["", "### Open Today", ""])
    if open_today:
        lines.extend(_format_checklist_item(item, default_status="open") for item in open_today)
    else:
        lines.append("- [open | audit] No open maintenance actions were generated.")

    lines.extend(["", "### New Problems Today", ""])
    if new_problems_today:
        lines.extend(_format_checklist_item(item, default_status="new") for item in new_problems_today)
    else:
        lines.append("- [new | audit] No new problems were detected in the selected window.")

    lines.extend(["", "### Missing For Faster Returns", ""])
    if missing_today:
        lines.extend(_format_checklist_item(item, default_status="missing") for item in missing_today)
    else:
        lines.append("- [missing | audit] No missing capability gaps were flagged.")

    lines.extend(["", "### Audit Notes", ""])
    if audit_notes:
        lines.extend(f"- {item}" for item in audit_notes)
    else:
        lines.append("- No extra audit notes were generated.")

    lines.extend(["", "### Audit Log", ""])
    if audit_log:
        lines.extend(_format_checklist_item(item, default_status=str(item.get("kind") or "audit")) for item in audit_log)
    else:
        lines.append("- [audit] No audit log entries were recorded.")

    lines.extend([
        "",
        "## Daily Quota Proof",
        "",
        f"- Focus task: {dict(daily_quota_proof.get('focus_task') or {}).get('title', '') or 'none recorded'}",
        f"- Safe autonomous actions today: {dict(daily_quota_proof.get('autonomous') or {}).get('safe_count', 0)}/{dict(daily_quota_proof.get('autonomous') or {}).get('target', 5)}",
        f"- Safe self-improvement today: {dict(daily_quota_proof.get('self_improvement') or {}).get('safe_count', 0)}/{dict(daily_quota_proof.get('self_improvement') or {}).get('target', 5)}",
        f"- Blocked or rescoped tasks today: {daily_quota_proof.get('blocked_rescoped_count', 0)}",
        f"- Validation today: {dict(daily_quota_proof.get('validation') or {}).get('pass_count', 0)} pass / {dict(daily_quota_proof.get('validation') or {}).get('fail_count', 0)} fail / {dict(daily_quota_proof.get('validation') or {}).get('review_blocked_count', 0)} review-held",
        f"- Do not widen yet because: {daily_quota_proof.get('do_not_widen_yet_because', '') or 'daily quota proof is currently clear'}",
        "",
        "### Operator Actions",
        "",
    ])
    operator_actions = [str(item) for item in list(daily_focus.get("operator_actions") or []) if str(item).strip()]
    if operator_actions:
        lines.extend(f"- {item}" for item in operator_actions)
    else:
        lines.append("- Continue with the next small engine-owned slice.")

    lines.extend(["", "### Small-Model Guardrails", ""])
    lines.extend(f"- {item}" for item in list(daily_focus.get("qwen_guardrails") or []))

    lines.extend(
        [
            "",
            "## Runtime Snapshot",
            "",
            f"- Baseline state: {baseline.get('state', 'unknown')}",
            f"- Blocked: {baseline.get('blocked', False)}",
            f"- Baseline reason: {baseline.get('reason', 'n/a')}",
            f"- Runs analyzed: {runtime.get('run_count', 0)}",
            f"- Success rate: {_percent(runtime.get('success_rate', 0.0))} ({runtime.get('success_count', 0)}/{runtime.get('run_count', 0)})",
            f"- Review request rate: {_percent(runtime.get('review_request_rate', 0.0))} ({runtime.get('review_request_count', 0)}/{runtime.get('run_count', 0)})",
            f"- Executed repair attempts: {runtime.get('repair_attempt_count', 0)} total across {runtime.get('repair_run_count', 0)} repaired runs",
            "",
            "## Experiment Pressure",
            "",
            f"- Experiment rows analyzed: {experiments.get('row_count', 0)}",
            f"- Strategy count: {experiments.get('strategy_count', 0)}",
            f"- Review-required rate: {_percent(experiments.get('review_required_rate', 0.0))}",
            f"- Low-confidence run rate: {_percent(experiments.get('low_confidence_patch_rate', 0.0))} ({experiments.get('low_confidence_run_count', 0)} runs)",
            f"- Average executed repairs per experiment row: {float(experiments.get('average_repair_count', 0.0)):.2f}",
            f"- Retry policy recommending repair: {experiments.get('retry_policy_repair_count', 0)} experiment rows",
            f"- Recommended next action: {experiments.get('recommended_next_action', '') or 'inspect-artifacts'}",
            f"- Recommended next strategy: {experiments.get('recommended_next_strategy', '') or 'n/a'}",
        ]
    )
    if not bool(runtime.get("has_true_execution_runs", False)):
        insert_at = lines.index("## Experiment Pressure") - 1
        lines.insert(insert_at, "- No true execution runs found in the selected window.")
        lines.insert(insert_at, "")

    best_strategy = dict(experiments.get("best_strategy") or {})
    weakest_strategy = dict(experiments.get("weakest_strategy") or {})
    if best_strategy:
        lines.append(
            f"- Best strategy: {best_strategy.get('strategy', '')} ({_percent(best_strategy.get('success_rate', 0.0))} success, avg score {float(best_strategy.get('average_score', 0.0)):.1f})"
        )
    if weakest_strategy:
        lines.append(
            f"- Weakest strategy: {weakest_strategy.get('strategy', '')} ({_percent(weakest_strategy.get('success_rate', 0.0))} success, avg score {float(weakest_strategy.get('average_score', 0.0)):.1f})"
        )
    model_profile_counts = dict(experiments.get("model_profile_counts") or {})
    if model_profile_counts:
        top_profile = max(model_profile_counts.items(), key=lambda item: item[1])
        lines.append(f"- Top model profile: {top_profile[0]} ({top_profile[1]} rows)")

    lines.extend(["", "## Top Blockers", ""])
    if blockers:
        lines.extend(f"- {item.get('label', '')}: {item.get('count', 0)}" for item in blockers)
    else:
        lines.append("- none observed in the selected window")

    lines.extend(["", "## Common Failure Fingerprints", ""])
    if fingerprints:
        lines.extend(f"- {item.get('label', '')}: {item.get('count', 0)}" for item in fingerprints)
    else:
        lines.append("- none observed in the selected window")

    lines.extend(["", "## Retry Policy Mix", ""])
    if retry_actions:
        lines.extend(f"- {item.get('action', '')}: {item.get('count', 0)}" for item in retry_actions)
    else:
        lines.append("- none observed in the selected window")

    lines.extend(["", "## Recommended Actions", ""])
    if actions:
        lines.extend(f"- {item.get('label', '')}: {item.get('count', 0)}" for item in actions)
    else:
        lines.append("- none observed in the selected window")

    lines.extend(
        [
            "",
            "## Training Signal Coverage",
            "",
            f"- Training rows analyzed: {training.get('row_count', 0)}",
            f"- Artifact-backed rows: {training.get('artifact_example_count', 0)}",
            f"- Log-backed rows: {training.get('log_example_count', 0)}",
        ]
    )
    if training_actions:
        lines.extend(["", "### Training Next Actions", ""])
        lines.extend(f"- {item.get('label', '')}: {item.get('count', 0)}" for item in training_actions)

    return "\n".join(lines) + "\n"


def write_engine_daily_report(
    project_root: Path,
    report: dict[str, Any],
    *,
    output_dir: Path | None = None,
    write_canonical_markdown: bool = True,
) -> dict[str, Path]:
    target_dir = output_dir or assistant_runs_dir(project_root)
    target_dir.mkdir(parents=True, exist_ok=True)
    json_path = target_dir / "engine_daily_report.json"
    md_path = target_dir / "engine_daily_report.md"
    markdown = render_engine_daily_report(report)
    json_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(markdown, encoding="utf-8")
    written = {"json": json_path, "markdown": md_path}
    if write_canonical_markdown:
        canonical_md_path = project_root / "docs" / "ENGINE_DAILY_REPORT.md"
        canonical_md_path.parent.mkdir(parents=True, exist_ok=True)
        canonical_md_path.write_text(markdown, encoding="utf-8")
        written["canonical_markdown"] = canonical_md_path
    return written


__all__ = [
    "build_engine_daily_report",
    "render_engine_daily_report",
    "write_engine_daily_report",
]
