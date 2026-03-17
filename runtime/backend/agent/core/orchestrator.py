from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from backend.agent.core.agent_registry import AgentRegistry, build_default_agent_registry
from backend.agent.core.approval import ApprovalGate
from backend.agent.core.permissions import PermissionRegistry, build_default_permissions
from backend.agent.core.tool_registry import ToolExecutionError, ToolNotFoundError, ToolRegistry, ToolSafetyLevel
from backend.agent.runtime.contracts import (
    build_runtime_event,
    build_tool_error,
    build_tool_permission_decision,
    build_tool_request,
    build_tool_result,
)


@dataclass(frozen=True)
class OrchestrationTask:
    objective: str
    ticket: str | None = None
    context: dict[str, Any] | None = None


Handler = Callable[["SequentialAgentOrchestrator", Any, OrchestrationTask, dict[str, Any]], dict[str, Any]]


class SequentialAgentOrchestrator:
    def __init__(
        self,
        *,
        tool_registry: ToolRegistry,
        handlers: dict[str, Handler] | None = None,
        approval_gate: ApprovalGate | None = None,
        permission_registry: PermissionRegistry | None = None,
        agent_registry: AgentRegistry | None = None,
    ) -> None:
        self.tool_registry = tool_registry
        self.permission_registry = permission_registry or build_default_permissions()
        self.agent_registry = agent_registry or build_default_agent_registry(self.permission_registry)
        self.approval_gate = approval_gate or ApprovalGate()
        self.handlers = dict(handlers or {})
        self._tool_call_sequence = 0
        self._tool_audit_trail: list[dict[str, Any]] = []
        self._tool_runtime_events: list[dict[str, Any]] = []
        self._active_task: OrchestrationTask | None = None

    def _runtime_scope(self) -> dict[str, str]:
        context = dict((self._active_task.context if self._active_task else {}) or {})
        runtime_task = dict(context.get("runtime_task") or context.get("runtimeTask") or {})
        runtime_run = dict(context.get("runtime_run") or context.get("runtimeRun") or {})
        return {
            "run_id": str(runtime_run.get("run_id") or ""),
            "task_id": str(runtime_task.get("task_id") or ""),
            "ticket": str(runtime_task.get("ticket") or (self._active_task.ticket if self._active_task else "") or ""),
        }

    def _active_context(self) -> dict[str, Any]:
        return dict((self._active_task.context if self._active_task else {}) or {})

    def _next_tool_call_id(self, agent_name: str, tool_name: str) -> str:
        self._tool_call_sequence += 1
        scope = self._runtime_scope()
        base = scope["run_id"] or "tool-run"
        return f"{base}:{agent_name}:{tool_name}:{self._tool_call_sequence}"

    def _record_tool_entry(
        self,
        *,
        request: dict[str, Any],
        permission: dict[str, Any],
        result: dict[str, Any],
        error: dict[str, Any] | None = None,
    ) -> None:
        self._tool_audit_trail.append(
            {
                "request": dict(request),
                "permission_decision": dict(permission),
                "result": dict(result),
                "error": dict(error or {}),
            }
        )

    def _record_tool_event(self, request: dict[str, Any], event: str, summary: str, *, level: str = "info", data: dict[str, Any] | None = None) -> None:
        scope = self._runtime_scope()
        self._tool_runtime_events.append(
            build_runtime_event(
                run_id=scope["run_id"],
                task_id=scope["task_id"],
                ticket_id=scope["ticket"],
                stage="tool",
                event=event,
                state="executing",
                level=level,
                summary=summary,
                data={
                    "tool_call_id": request.get("tool_call_id"),
                    "agent": request.get("agent"),
                    "tool": request.get("tool"),
                    **dict(data or {}),
                },
            )
        )

    def _needs_tool_approval(self, tool) -> bool:
        if tool.safety_level == ToolSafetyLevel.PRIVILEGED:
            return bool(self.approval_gate.require_privileged)
        if tool.safety_level == ToolSafetyLevel.CONTROLLED:
            return bool(self.approval_gate.require_controlled)
        return False

    def _approval_payload(self, tool_name: str, tool, kwargs: dict[str, Any]) -> dict[str, Any]:
        payload = dict(kwargs)
        if tool_name != "smart_patch" or not self._needs_tool_approval(tool):
            return payload

        preview_args = dict(kwargs)
        preview_args["dry_run"] = True
        try:
            preview = self.tool_registry.run_tool(tool_name, args=preview_args, context=self._active_context())
            if isinstance(preview, dict):
                payload["patch_preview"] = {
                    "ok": bool(preview.get("ok", False)),
                    "dryRun": bool(preview.get("dryRun", True)),
                    "message": str(preview.get("message") or ""),
                    "fileCount": int(preview.get("fileCount") or 0),
                    "appliedFileCount": int(preview.get("appliedFileCount") or 0),
                    "alreadyAppliedFileCount": int(preview.get("alreadyAppliedFileCount") or 0),
                    "rejectedHunkCount": int(preview.get("rejectedHunkCount") or 0),
                    "automationScore": int(preview.get("automationScore") or 0),
                    "automationRecommendation": str(preview.get("automationRecommendation") or ""),
                    "confidence": dict(preview.get("confidence") or {}),
                    "files": [
                        {
                            "path": str(item.get("path") or ""),
                            "operation": str(item.get("operation") or ""),
                            "status": str(item.get("status") or ""),
                            "confidence": dict(item.get("confidence") or {}),
                        }
                        for item in list(preview.get("files") or [])[:12]
                        if isinstance(item, dict)
                    ],
                }
        except Exception as exc:
            payload["patch_preview"] = {
                "ok": False,
                "message": str(exc),
                "confidence": {
                    "score": 0,
                    "normalized": 0,
                    "label": "very-low",
                    "recommendation": "manual-review",
                    "summary": "Patch preview could not be generated before approval.",
                },
            }
        return payload

    def execute_tool(self, agent_name: str, tool_name: str, **kwargs: Any) -> dict[str, Any]:
        scope = self._runtime_scope()
        started_at = None
        try:
            tool = self.tool_registry.get_tool(tool_name)
            request_payload = build_tool_request(
                tool_call_id=self._next_tool_call_id(agent_name, tool_name),
                run_id=scope["run_id"],
                task_id=scope["task_id"],
                ticket_id=scope["ticket"],
                agent_name=agent_name,
                tool_name=tool_name,
                args=kwargs,
                safety_level=tool.safety_level.value,
                boundary=tool.boundary,
            )
            self._record_tool_event(request_payload, "tool-requested", f"{agent_name} requested {tool_name}")

            self.permission_registry.require_tool_permission(agent_name, tool_name)

            approval_request = self.approval_gate.request_for(
                agent_name,
                tool,
                payload=self._approval_payload(tool_name, tool, kwargs),
                runtime_scope=scope,
            )
            if approval_request is not None:
                permission = build_tool_permission_decision(
                    request=request_payload,
                    allowed=False,
                    requires_approval=True,
                    status="approval_required",
                    reason=request_payload.get("tool", "tool") + " requires approval before execution",
                    source="approval_gate",
                    approval_request_id=approval_request.id,
                )
                result_payload = build_tool_result(
                    request=request_payload,
                    ok=False,
                    status="blocked",
                    permission=permission,
                    output={
                        "pending_approval": True,
                        "approval_request": {
                            "id": approval_request.id,
                            "agent": approval_request.agent,
                            "tool": approval_request.tool,
                            "safety_level": approval_request.safety_level,
                            "reason": approval_request.reason,
                            "created_at": approval_request.created_at,
                            "status": approval_request.status,
                            "note": approval_request.note,
                            "payload": dict(approval_request.payload),
                            "review_context": dict(approval_request.review_context),
                            "review_request": dict(approval_request.review_request),
                            "review_decision": dict(approval_request.review_decision),
                        },
                    },
                )
                self._record_tool_entry(request=request_payload, permission=permission, result=result_payload)
                self._record_tool_event(request_payload, "tool-blocked", f"{agent_name} blocked on approval for {tool_name}", level="warning", data={"approval_request_id": approval_request.id})
                return {
                    "ok": False,
                    "pending_approval": True,
                    "approval_request": dict(result_payload["output"]["approval_request"]),
                    "tool_request": request_payload,
                    "tool_permission": permission,
                    "tool_result": result_payload,
                }

            permission = build_tool_permission_decision(
                request=request_payload,
                allowed=True,
                requires_approval=False,
                status="allowed",
                reason=f"{agent_name} is allowed to use {tool_name}",
                source="permission_registry",
            )
            started_at = permission.get("decided_at")
            payload = self.tool_registry.run_tool(tool_name, args=kwargs, context=self._active_context())
            if isinstance(payload, dict):
                result_payload = build_tool_result(
                    request=request_payload,
                    ok=True,
                    status="succeeded",
                    permission=permission,
                    output=dict(payload),
                    started_at=started_at,
                )
                self._record_tool_entry(request=request_payload, permission=permission, result=result_payload)
                self._record_tool_event(request_payload, "tool-completed", f"{agent_name} completed {tool_name}")
                return {"ok": True, **payload, "tool_request": request_payload, "tool_permission": permission, "tool_result": result_payload}
            result_payload = build_tool_result(
                request=request_payload,
                ok=True,
                status="succeeded",
                permission=permission,
                output={"result": payload},
                started_at=started_at,
            )
            self._record_tool_entry(request=request_payload, permission=permission, result=result_payload)
            self._record_tool_event(request_payload, "tool-completed", f"{agent_name} completed {tool_name}")
            return {"ok": True, "result": payload, "tool_request": request_payload, "tool_permission": permission, "tool_result": result_payload}
        except (ToolNotFoundError, ToolExecutionError, PermissionError) as exc:
            request_payload = locals().get("request_payload") or build_tool_request(
                tool_call_id=self._next_tool_call_id(agent_name, tool_name),
                run_id=scope["run_id"],
                task_id=scope["task_id"],
                ticket_id=scope["ticket"],
                agent_name=agent_name,
                tool_name=tool_name,
                args=kwargs,
            )
            permission = build_tool_permission_decision(
                request=request_payload,
                allowed=False,
                requires_approval=False,
                status="denied" if isinstance(exc, PermissionError) else "error",
                reason=str(exc),
                source="permission_registry" if isinstance(exc, PermissionError) else "tool_registry",
            )
            error = build_tool_error(
                request=request_payload,
                kind="permission-error" if isinstance(exc, PermissionError) else "tool-execution-error",
                message=str(exc),
                details={"exception_type": exc.__class__.__name__},
            )
            result_payload = build_tool_result(
                request=request_payload,
                ok=False,
                status="failed",
                permission=permission,
                error=error,
                started_at=started_at,
            )
            self._record_tool_entry(request=request_payload, permission=permission, result=result_payload, error=error)
            self._record_tool_event(request_payload, "tool-failed", f"{agent_name} failed {tool_name}", level="error", data={"message": str(exc)})
            return {
                "ok": False,
                "error": str(exc),
                "tool": tool_name,
                "agent": agent_name,
                "tool_request": request_payload,
                "tool_permission": permission,
                "tool_error": error,
                "tool_result": result_payload,
            }

    def run(self, task: OrchestrationTask, *, max_steps: int = 10) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        trace: list[dict[str, Any]] = []
        status = "completed"
        self._active_task = task

        try:
            order = ["planner", "implementer", "validator", "repair", "release"]
            for index, agent_name in enumerate(order):
                if index >= max(1, int(max_steps or 10)):
                    status = "truncated"
                    break

                handler = self.handlers.get(agent_name)
                if handler is None:
                    trace.append({"agent": agent_name, "status": "skipped", "reason": "missing handler"})
                    continue

                agent = self.agent_registry.get_agent(agent_name)
                result = handler(self, agent, task, payload)
                step_status = str(result.get("status") or "completed")
                trace.append(
                    {
                        "agent": agent_name,
                        "status": step_status,
                        "summary": str(result.get("summary") or ""),
                    }
                )
                payload = dict(result.get("payload") or payload)

                if step_status in {"blocked", "failed", "error"}:
                    status = step_status
                    break
        finally:
            self._active_task = None

        return {
            "ok": status in {"completed", "truncated"},
            "status": status,
            "trace": trace,
            "payload": payload,
            "tool_audit_trail": self.tool_audit_trail(),
            "tool_runtime_events": self.tool_runtime_events(),
        }

    def pending_approvals(self) -> list[dict[str, Any]]:
        return self.approval_gate.pending()

    def approval_state(self) -> dict[str, Any]:
        return self.approval_gate.approval_state()

    def review_requests(self) -> list[dict[str, Any]]:
        return self.approval_gate.review_requests()

    def permission_state(self) -> dict[str, Any]:
        return self.permission_registry.describe_all()

    def tool_audit_trail(self) -> list[dict[str, Any]]:
        return [dict(item) for item in self._tool_audit_trail]

    def tool_runtime_events(self) -> list[dict[str, Any]]:
        return [dict(item) for item in self._tool_runtime_events]


__all__ = ["OrchestrationTask", "SequentialAgentOrchestrator"]
