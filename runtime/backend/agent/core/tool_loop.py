from __future__ import annotations

import re
from typing import Any

from backend.agent.core.approval import ApprovalGate
from backend.agent.core.orchestrator import OrchestrationTask, SequentialAgentOrchestrator
from backend.agent.core.runtime_context import build_runtime_context
from backend.agent.core.tool_registry import build_default_tool_registry
from backend.agent.runtime.contracts import (
    DEV_ENGINE_LOOP_STEPS,
    RECOVERY_LADDER_STEPS,
    build_checkpoint_ref,
    build_failure_class,
    build_interrupt_request,
    build_recovery_ladder_state,
    build_review_bundle,
    build_runtime_failure,
    build_runtime_run,
    build_runtime_task,
    build_task_objective,
    build_workbench_artifact,
)
from backend.agent.runtime.orchestration_driver import RuntimeOrchestrationDriver
from backend.agent.core.patch_review import build_review_summary

_OBJECTIVE_PATH_RE = re.compile(r'([A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+)')


def _extract_explicit_objective_paths(objective: str) -> list[str]:
    text = str(objective or '').strip()
    if not text:
        return []
    paths: list[str] = []
    seen: set[str] = set()
    for match in _OBJECTIVE_PATH_RE.findall(text):
        candidate = str(match or '').strip().strip('`"\')]}.,:;!?')
        if not candidate:
            continue
        normalized = candidate.replace('\\', '/')
        leaf = normalized.rsplit('/', 1)[-1]
        if '.' not in leaf and leaf.upper() not in {'README', 'LICENSE', 'AGENTS'}:
            continue
        lowered = normalized.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        paths.append(normalized)
    return paths[:5]


def _parse_bullet_list(raw: str) -> list[str]:
    items = [
        str(item or '').strip().strip('.')
        for item in re.split(r',|;|•|\n', str(raw or ''))
    ]
    return [item for item in items if item][:6]


def _synthesize_append_section_step(objective: str, explicit_paths: list[str]) -> dict[str, Any] | None:
    if not explicit_paths:
        return None
    text = str(objective or '').strip()
    lowered = text.lower()
    if not any(token in lowered for token in ('add a short section', 'add a section', 'append a section', 'append section')):
        return None
    title_match = re.search(r'(?:called|titled)\s+(.+?)(?:\s+with\b|\.|$)', text, re.IGNORECASE)
    bullets_match = re.search(r'bullets?\s*:\s*(.+?)(?:\.\s+Then\b|$)', text, re.IGNORECASE)
    title = str(title_match.group(1) if title_match else '').strip().strip(' "\'`')
    bullets = _parse_bullet_list(bullets_match.group(1) if bullets_match else '')
    if not title or not bullets:
        return None
    content_lines = ['', f'## {title}', '']
    content_lines.extend(f'- {item}' for item in bullets)
    content = '\n'.join(content_lines).rstrip() + '\n'
    return {
        'action': 'edit_file',
        'path': explicit_paths[0],
        'content': content,
        'mode': 'append',
    }


def _tool_loop_task_objective(objective: str, runtime_task: dict[str, Any]) -> dict[str, Any]:
    return build_task_objective(
        summary=str(objective or ""),
        kind="orchestrate",
        source="tool-loop",
        task_mode=str(runtime_task.get("task_mode") or ""),
        action=str(runtime_task.get("action") or ""),
        loop_steps=DEV_ENGINE_LOOP_STEPS,
    )


def _tool_loop_execution_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    payload = dict(result.get("payload") or {})
    return [dict(item) for item in list(payload.get("execution") or []) if isinstance(item, dict)]


def _tool_loop_failure_kind(result: dict[str, Any]) -> str:
    if bool(result.get("pending_approvals")):
        return "risky-interrupt"
    if bool(result.get("ok")):
        return ""
    execution_rows = _tool_loop_execution_rows(result)
    if not execution_rows:
        return "empty-proposal"
    text_parts = [str(result.get("summary") or ""), str(result.get("status") or "")]
    for item in execution_rows:
        step = dict(item.get("step") or {})
        step_result = dict(item.get("result") or {})
        text_parts.extend(
            [
                str(step.get("action") or ""),
                str(step.get("path") or ""),
                str(step_result.get("error") or ""),
                str(step_result.get("message") or ""),
            ]
        )
    haystack = " ".join(part.strip().lower() for part in text_parts if str(part).strip())
    if any(token in haystack for token in ["invalid", "unknown step action", "outside allowed", "malformed"]):
        return "invalid-change-set"
    return "validation-failure"


def _tool_loop_retry_policy(kind: str) -> dict[str, Any]:
    return {
        "empty-proposal": {
            "action": "run",
            "reason": "Tool loop produced no actionable steps. Retry with research first.",
        },
        "invalid-change-set": {
            "action": "plan",
            "reason": "Tool loop produced an invalid bounded step set. Rebuild the plan before retrying.",
        },
        "validation-failure": {
            "action": "repair",
            "reason": "Tool loop failed after execution. Repair or retry the bounded loop.",
        },
        "risky-interrupt": {
            "action": "",
            "reason": "Tool loop is waiting on manual approval.",
        },
    }.get(kind, {})


def _tool_loop_failure_class(result: dict[str, Any], runtime_failure: dict[str, Any]) -> dict[str, Any]:
    if runtime_failure:
        return build_failure_class(
            code=str(runtime_failure.get("kind") or "tool-loop-failure"),
            summary=str(runtime_failure.get("message") or ""),
            stage=str(runtime_failure.get("stage") or "tool-loop"),
            retryable=bool(runtime_failure.get("retryable", False)),
            blocking=bool(runtime_failure.get("blocking", False)),
            metadata={
                "retry_policy": dict(runtime_failure.get("retry_policy") or {}),
                "details": dict(runtime_failure.get("details") or {}),
            },
        )
    if bool(result.get("pending_approvals")):
        return build_failure_class(
            code="risky-interrupt",
            summary="Tool loop is waiting on manual approval.",
            stage="tool-loop",
            retryable=False,
            blocking=True,
        )
    if not bool(result.get("ok")):
        code = _tool_loop_failure_kind(result)
        return build_failure_class(
            code=code,
            summary=str(result.get("summary") or result.get("status") or "Tool loop failed."),
            stage="tool-loop",
            retryable=code in {"empty-proposal", "invalid-change-set", "validation-failure"},
            blocking=False,
        )
    return {}


def _tool_loop_recovery_ladder(result: dict[str, Any], runtime_run: dict[str, Any]) -> dict[str, Any]:
    failure_kind = _tool_loop_failure_kind(result)
    if bool(result.get("pending_approvals")):
        state = "blocked"
        current_step = "interrupt-or-rollback"
        next_step = "interrupt-or-rollback"
    elif bool(result.get("ok")):
        state = "completed"
        current_step = "continue-stop"
        next_step = ""
    elif failure_kind == "empty-proposal":
        state = "failed"
        current_step = "research-expansion"
        next_step = "research-expansion"
    elif failure_kind == "invalid-change-set":
        state = "failed"
        current_step = "bridge-plan-retry"
        next_step = "bridge-plan-retry"
    else:
        state = "failed"
        current_step = "repair-oriented-route"
        next_step = "repair-oriented-route"
    return build_recovery_ladder_state(
        state=state,
        current_step=current_step,
        next_step=next_step,
        available_steps=RECOVERY_LADDER_STEPS,
        history=[
            {
                "stage": str(item.get("stage") or ""),
                "state": str(item.get("state") or ""),
                "summary": str(item.get("summary") or ""),
                "entered_at": str(item.get("timestamp") or item.get("entered_at") or ""),
            }
            for item in list(result.get("runtime_events") or [])
            if isinstance(item, dict) and str(item.get("summary") or "")
        ][-8:],
        metadata={
            "run_state": str(runtime_run.get("state") or ""),
            "failure_code": failure_kind,
            "tool_call_count": len(list(result.get("tool_audit_trail") or [])),
            "pending_approval_count": len(list(result.get("pending_approvals") or [])),
        },
    )


def _tool_loop_interrupt_request(result: dict[str, Any]) -> dict[str, Any]:
    pending_approvals = [dict(item) for item in list(result.get("pending_approvals") or []) if isinstance(item, dict)]
    if pending_approvals:
        return build_interrupt_request(
            kind="approval",
            summary=f"{len(pending_approvals)} approval request(s) pending before the tool loop can continue.",
            active=True,
            requested_action="approve-risky-action",
            allowed_actions=["approve-risky-action", "open-trace", "resume-interrupted-task"],
            request_count=len(pending_approvals),
            metadata={"requests": pending_approvals[:5]},
        )
    failure_kind = _tool_loop_failure_kind(result)
    if failure_kind and not bool(result.get("ok")):
        return build_interrupt_request(
            kind="runtime-block",
            summary=str(result.get("summary") or "Tool loop blocked."),
            active=True,
            requested_action="retry-with-research" if failure_kind == "empty-proposal" else ("bridge-plan-retry" if failure_kind == "invalid-change-set" else "repair-loop"),
            allowed_actions=["open-trace", "open-files", "retry-with-research", "bridge-plan-retry", "repair-loop", "rollback-last-pass"],
            request_count=1,
            metadata={"failure_kind": failure_kind},
        )
    return {}


def _tool_loop_review_bundle(result: dict[str, Any]) -> dict[str, Any]:
    review_summary = dict(result.get("review_summary") or {})
    review_requests = [dict(item) for item in list(result.get("review_requests") or []) if isinstance(item, dict)]
    failure_kind = _tool_loop_failure_kind(result)
    verdict = (
        "pending-review"
        if bool(review_summary.get("requires_manual_review"))
        else (
            "approved-with-warnings"
            if bool(result.get("ok")) and int(review_summary.get("low_confidence_patch_count") or 0) > 0
            else (
                "approved"
                if bool(result.get("ok"))
                else ("repair-required" if failure_kind in {"empty-proposal", "invalid-change-set", "validation-failure"} else "blocked")
            )
        )
    )
    first_request = review_requests[0] if review_requests else {}
    planned_files = [
        str((dict(item.get("step") or {}).get("path") or dict(item.get("result") or {}).get("path") or dict(item.get("result") or {}).get("output_path") or "")).strip()
        for item in _tool_loop_execution_rows(result)
    ]
    planned_files = [item for item in planned_files if item]
    change_summary = (
        f"{len(planned_files)} planned file(s)"
        + (f", starting with {planned_files[0]}" if planned_files else "")
        if planned_files
        else "No planned files were captured yet."
    )
    review_reason = str(review_summary.get("summary") or first_request.get("summary") or "").strip()
    review_next_action = str(review_summary.get("next_action") or review_summary.get("nextAction") or first_request.get("next_action") or first_request.get("nextAction") or "").strip()
    if verdict == "pending-review":
        reason = review_reason or "The tool loop is waiting on manual review before it can continue."
        how_to_fix = review_next_action or "Review the held tool-loop findings and clear the pending approval items."
        fix_actions = ["review-interrupt", "open-files", "open-trace"]
    elif verdict == "repair-required":
        reason = review_reason or (
            "The tool loop needs another bounded repair pass before approval."
            if failure_kind == "validation-failure"
            else "The tool loop needs another bounded retry before it can be approved."
        )
        how_to_fix = review_next_action or (
            "Retry with more repo research before generating the next step."
            if failure_kind == "empty-proposal"
            else "Repair the failing step and rerun the smallest relevant validation."
        )
        fix_actions = ["retry-with-research" if failure_kind == "empty-proposal" else "repair-loop", "open-trace", "open-files"]
    elif verdict == "approved-with-warnings":
        reason = review_reason or "The tool loop succeeded, but low-confidence findings still deserve a spot check."
        how_to_fix = review_next_action or "Inspect the proposed file set and rerun the most relevant checks before promotion."
        fix_actions = ["open-files", "open-trace", "continue-run"]
    elif verdict == "approved":
        reason = review_reason or "The tool loop cleared the current review and validation gates."
        how_to_fix = review_next_action or "Keep the next step bounded and continue from the latest objective."
        fix_actions = ["continue-run", "open-files"]
    else:
        reason = review_reason or "The tool loop is blocked by the current runtime or review gate."
        how_to_fix = review_next_action or "Inspect the trace, fix the blocking issue, and retry the next bounded step."
        fix_actions = ["review-interrupt", "rollback-last-pass", "open-trace"]
    return build_review_bundle(
        verdict=verdict,
        decision_label={
            "pending-review": "Review required",
            "repair-required": "Repair required",
            "approved-with-warnings": "Approved with warnings",
            "approved": "Approved",
            "blocked": "Blocked",
        }.get(verdict, "Observed"),
        summary=str(review_summary.get("summary") or ""),
        reason=reason,
        how_to_fix=how_to_fix,
        change_summary=change_summary,
        approval_state=verdict,
        approved=verdict in {"approved", "approved-with-warnings"},
        requires_manual_review=bool(review_summary.get("requires_manual_review")),
        request_count=len(review_requests),
        pending_count=int(review_summary.get("pending_review_count") or 0),
        fix_actions=fix_actions,
        review_requests=review_requests[:5],
        metadata={
            "failure_kind": failure_kind,
            "low_confidence_patch_count": int(review_summary.get("low_confidence_patch_count") or 0),
        },
    )


def _tool_loop_workbench_artifacts(result: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in _tool_loop_execution_rows(result):
        step = dict(item.get("step") or {})
        step_result = dict(item.get("result") or {})
        step_path = str(step.get("path") or "")
        if not step_path:
            step_path = str(step_result.get("path") or step_result.get("output_path") or "")
        if step_path:
            rows.append(
                build_workbench_artifact(
                    kind="planned-file",
                    label=step_path,
                    path=step_path,
                    summary=str(step.get("action") or "planned step"),
                    status="planned",
                )
            )
        artifact_path = str(step_result.get("artifact") or step_result.get("output_path") or "")
        if not artifact_path:
            continue
        rows.append(
            build_workbench_artifact(
                kind="tool-loop-artifact",
                label=artifact_path.split("/")[-1].split("\\")[-1],
                path=artifact_path,
                summary=str(step_result.get("message") or step.get("action") or "tool loop artifact"),
                status="available",
            )
        )
    return rows[:8]


def _tool_loop_checkpoint_ref(result: dict[str, Any], runtime_run: dict[str, Any]) -> dict[str, Any]:
    execution_rows = _tool_loop_execution_rows(result)
    planned_paths = [
        str(dict(item.get("step") or {}).get("path") or "")
        for item in execution_rows
        if str(dict(item.get("step") or {}).get("path") or "")
    ]
    return build_checkpoint_ref(
        ref_id=str(runtime_run.get("run_id") or result.get("status") or "tool-loop"),
        label="tool-loop-checkpoint",
        kind="tool-loop-run",
        path="",
        summary="Latest tool-loop state captured for retry, review, and approval follow-up.",
        metadata={
            "planned_paths": planned_paths[:8],
            "pending_approval_count": len(list(result.get("pending_approvals") or [])),
            "tool_call_count": len(list(result.get("tool_audit_trail") or [])),
        },
    )


def _planner_handler(orchestrator, _agent, task, payload):
    context = dict(task.context or {})
    plan_steps = list(context.get("steps") or [])
    search_pattern = str(context.get("search_pattern") or "**/*")
    explicit_paths = _extract_explicit_objective_paths(task.objective)
    tasks_payload = orchestrator.execute_tool("planner", "list_tasks", board_path=context.get("board_path", "docs/BAT_FEATURE_BOARD.md"))
    search_payload = orchestrator.execute_tool(
        "planner",
        "search_repo",
        pattern=search_pattern,
        query=task.objective,
        editor_context=context.get("editor_context"),
        limit=5,
    )

    if not plan_steps:
        synthesized_edit = _synthesize_append_section_step(task.objective, explicit_paths)
        if synthesized_edit:
            plan_steps = [synthesized_edit]
        else:
            target_files = [str(item) for item in context.get("target_files", []) if str(item).strip()]
            for path in explicit_paths:
                if path not in target_files:
                    target_files.append(path)
            if target_files:
                if context.get("content_by_path") or str(context.get("default_content") or '').strip():
                    plan_steps = [
                        {
                            "action": "edit_file",
                            "path": item,
                            "content": context.get("content_by_path", {}).get(item, context.get("default_content", "")),
                            "mode": context.get("edit_mode", "replace"),
                        }
                        for item in target_files
                    ]
                else:
                    plan_steps = [{"action": "inspect_file", "path": item} for item in target_files[:3]]
            else:
                ranked_matches = [
                    str(item.get("path") or "").strip()
                    for item in list((search_payload or {}).get("ranked_matches", []) or [])
                    if isinstance(item, dict) and str(item.get("path") or "").strip()
                ]
                matches = ranked_matches or list((search_payload or {}).get("matches", []))
                plan_steps = [{"action": "inspect_file", "path": item} for item in matches[:3]]

    return {
        "status": "completed",
        "summary": f"Prepared {len(plan_steps)} tool-loop step(s).",
        "payload": {
            "task": {"objective": task.objective, "ticket": task.ticket},
            "tasks_payload": tasks_payload,
            "search_payload": search_payload,
            "plan": {
                "objective": task.objective,
                "ticket": task.ticket,
                "steps": plan_steps,
            },
        },
    }


def _implementer_handler(orchestrator, _agent, _task, payload):
    data = dict(payload or {})
    plan = dict(data.get("plan") or {})
    executed: list[dict[str, Any]] = []
    blocked = False

    for step in list(plan.get("steps") or []):
        action = str(step.get("action") or "").strip().lower()
        if action == "inspect_file":
            result = orchestrator.execute_tool("implementer", "read_file", path=step.get("path"), start_line=1, end_line=120)
        elif action == "edit_file":
            result = orchestrator.execute_tool(
                "implementer",
                "edit_file",
                path=step.get("path"),
                content=step.get("content", ""),
                mode=step.get("mode", "replace"),
            )
        elif action == "smart_patch":
            result = orchestrator.execute_tool(
                "implementer",
                "smart_patch",
                patch_text=step.get("patch_text") or step.get("patchText") or step.get("patch", ""),
                dry_run=bool(step.get("dry_run", step.get("dryRun", False))),
                allow_partial=bool(step.get("allow_partial", step.get("allowPartial", False))),
            )
        elif action == "run_command":
            result = orchestrator.execute_tool(
                "implementer",
                "run_command",
                command=step.get("command") or step.get("cmd"),
                cwd=step.get("cwd"),
                timeout=int(step.get("timeout", 60) or 60),
            )
        else:
            result = {"ok": False, "error": f"unknown step action: {action}", "step": step}
        executed.append({"step": step, "result": result})
        if isinstance(result, dict) and result.get("pending_approval"):
            blocked = True

    return {
        "status": "blocked" if blocked else "completed",
        "summary": "Awaiting approval for controlled edits." if blocked else f"Executed {len(executed)} tool-loop step(s).",
        "payload": {
            **data,
            "execution": executed,
            "pending_approvals": orchestrator.pending_approvals(),
        },
    }


def _validator_handler(orchestrator, _agent, _task, payload):
    data = dict(payload or {})
    git_status = orchestrator.execute_tool("validator", "git_status")
    pending = list(data.get("pending_approvals") or []) or orchestrator.pending_approvals()
    return {
        "status": "blocked" if pending else "completed",
        "summary": "Validation deferred until approvals are resolved." if pending else "Validation snapshot captured.",
        "payload": {
            **data,
            "validation": {
                "git_status": git_status,
                "valid": not pending,
            },
            "pending_approvals": pending,
        },
    }


def _repair_handler(_orchestrator, _agent, _task, payload):
    data = dict(payload or {})
    return {
        "status": "completed",
        "summary": "Repair loop idle.",
        "payload": {
            **data,
            "repair": {"attempted": False},
        },
    }


def _release_handler(orchestrator, _agent, _task, payload):
    data = dict(payload or {})
    pending = list(data.get("pending_approvals") or []) or orchestrator.pending_approvals()
    return {
        "status": "blocked" if pending else "completed",
        "summary": "Release snapshot blocked pending approval." if pending else "Release snapshot ready.",
        "payload": {
            **data,
            "release": {
                "status": "ready" if not pending else "blocked",
                "pending_approvals": pending,
            },
        },
    }


def build_tool_loop_orchestrator(project_root, *, approval_gate: ApprovalGate | None = None) -> SequentialAgentOrchestrator:
    return SequentialAgentOrchestrator(
        tool_registry=build_default_tool_registry(project_root),
        handlers={
            "planner": _planner_handler,
            "implementer": _implementer_handler,
            "validator": _validator_handler,
            "repair": _repair_handler,
            "release": _release_handler,
        },
        approval_gate=approval_gate,
    )


def run_tool_loop(
    *,
    project_root,
    objective: str,
    ticket: str | None = None,
    context: dict[str, Any] | None = None,
    approval_gate: ApprovalGate | None = None,
    max_steps: int = 10,
) -> dict[str, Any]:
    orchestrator = build_tool_loop_orchestrator(project_root, approval_gate=approval_gate)
    task_context = dict(context or {})
    runtime_task = build_runtime_task(
        ticket_id=str(ticket or ""),
        desc=str(objective or ""),
        action="orchestrate",
        mode="tool-loop",
        run_mode="manual",
        editor_context=task_context.get("editor_context") or task_context.get("editorContext") or {},
        host_boundary=task_context.get("host_boundary") or task_context.get("hostBoundary") or {},
        requested_capabilities={"tool_execution": True},
    )
    runtime_run = build_runtime_run(task=runtime_task)
    orchestration_payload = {
        "runtime_task": runtime_task,
        "runtime_run": runtime_run,
        "runtime_events": [],
    }
    orchestration = RuntimeOrchestrationDriver(orchestration_payload, ticket_id=str(ticket or ""))
    orchestration.enter_stage(
        next_state="planning",
        stage="tool-loop",
        summary="tool loop planning prepared",
        objective=objective,
    )
    orchestration.enter_stage(
        next_state="executing",
        stage="tool-loop",
        summary="tool loop started",
        objective=objective,
    )
    runtime_run = orchestration_payload["runtime_run"]
    task_context["runtime_task"] = runtime_task
    task_context["runtime_run"] = runtime_run
    task_context["runtime_context"] = build_runtime_context(
        project_root,
        ticket_id=str(ticket or ""),
        desc=str(objective or ""),
        editor_context=task_context.get("editor_context") or task_context.get("editorContext"),
        approval_state=orchestrator.approval_state(),
        permission_state=orchestrator.permission_state(),
        host_boundary=task_context.get("host_boundary") or task_context.get("hostBoundary") or {},
    )
    task = OrchestrationTask(objective=objective, ticket=ticket, context=task_context)
    result = orchestrator.run(task, max_steps=max_steps)
    result["pending_approvals"] = orchestrator.pending_approvals()
    result["approval_state"] = orchestrator.approval_state()
    result["review_requests"] = orchestrator.review_requests()
    result["review_state"] = dict(result["approval_state"].get("review_state") or {})
    result["permission_state"] = orchestrator.permission_state()
    result["runtime_context"] = build_runtime_context(
        project_root,
        ticket_id=str(ticket or ""),
        desc=str(objective or ""),
        editor_context=task_context.get("editor_context") or task_context.get("editorContext"),
        approval_state=result["approval_state"],
        permission_state=result["permission_state"],
        host_boundary=task_context.get("host_boundary") or task_context.get("hostBoundary") or {},
    )
    result["requires_approval"] = bool(result["pending_approvals"])
    result["review_summary"] = build_review_summary(
        execution_results=[item.get("result") for item in list(result.get("payload", {}).get("execution", []) or []) if isinstance(item, dict)],
        pending_approvals=list(result.get("pending_approvals") or []),
        runtime_context={
            "run_id": runtime_run.get("run_id"),
            "task_id": runtime_task.get("task_id"),
            "ticket": runtime_task.get("ticket"),
            **dict(result.get("runtime_context") or {}),
        },
    )
    final_state = "blocked" if result["requires_approval"] else ("succeeded" if result.get("ok") else "failed")
    orchestration_payload["runtime_run"] = runtime_run
    if final_state == "succeeded":
        orchestration.enter_stage(
            next_state="releasing",
            stage="tool-loop",
            summary="tool loop packaging runtime outputs",
            status=result.get("status"),
            tool_call_count=len(result.get("tool_audit_trail") or []),
            approval_pending_count=len(result.get("pending_approvals") or []),
        )
    orchestration.enter_stage(
        next_state=final_state,
        stage="tool-loop",
        summary="tool loop blocked pending approval" if final_state == "blocked" else ("tool loop completed" if final_state == "succeeded" else "tool loop failed"),
        status=result.get("status"),
        tool_call_count=len(result.get("tool_audit_trail") or []),
        approval_pending_count=len(result.get("pending_approvals") or []),
    )
    runtime_run = orchestration_payload["runtime_run"]
    runtime_failure = {}
    if final_state == "failed":
        failure_kind = _tool_loop_failure_kind(result)
        retry_policy = _tool_loop_retry_policy(failure_kind)
        runtime_failure = build_runtime_failure(
            ticket_id=str(ticket or ""),
            run_id=str(runtime_run.get("run_id") or ""),
            task_id=str(runtime_task.get("task_id") or ""),
            stage="tool-loop",
            kind=failure_kind or "tool-loop-failure",
            message=str(result.get("summary") or f"tool loop ended with status {result.get('status')}"),
            retryable=bool(retry_policy.get("action")),
            blocking=False,
            retry_policy=retry_policy,
            details={
                "trace": list(result.get("trace") or []),
                "planned_step_count": len(_tool_loop_execution_rows(result)),
            },
        )
    task_objective = _tool_loop_task_objective(objective, runtime_task)
    failure_class = _tool_loop_failure_class(result, runtime_failure)
    recovery_ladder = _tool_loop_recovery_ladder(result, runtime_run)
    checkpoint_ref = _tool_loop_checkpoint_ref(result, runtime_run)
    interrupt_request = _tool_loop_interrupt_request(result)
    review_bundle = _tool_loop_review_bundle(result)
    workbench_artifacts = _tool_loop_workbench_artifacts(result)
    result["runtime_task"] = runtime_task
    result["runtime_run"] = runtime_run
    result["runtime_failure"] = runtime_failure
    orchestration_payload["runtime_task"] = runtime_task
    orchestration_payload["runtime_failure"] = runtime_failure
    orchestration.finalize_runtime_result(
        ok=final_state == "succeeded",
        failure=runtime_failure,
        metrics={
            "tool_call_count": len(result.get("tool_audit_trail") or []),
            "approval_pending_count": len(result.get("pending_approvals") or []),
        },
        metadata={"tool_loop_status": result.get("status")},
    )
    result["runtime_result"] = dict(orchestration_payload.get("runtime_result") or {})
    result["runtime_result"]["task_objective"] = dict(task_objective)
    result["runtime_result"]["failure_class"] = dict(failure_class)
    result["runtime_result"]["recovery_ladder"] = dict(recovery_ladder)
    result["runtime_result"]["checkpoint_ref"] = dict(checkpoint_ref)
    result["runtime_result"]["interrupt_request"] = dict(interrupt_request)
    result["runtime_result"]["review_bundle"] = dict(review_bundle)
    result["runtime_result"]["workbench_artifacts"] = list(workbench_artifacts)
    result["runtime_result"]["review_state"] = dict(result.get("review_state") or {})
    result["runtime_result"]["review_summary"] = dict(result.get("review_summary") or {})
    result["runtime_events"] = list(orchestration_payload.get("runtime_events") or []) + list(result.get("tool_runtime_events") or [])
    return result
