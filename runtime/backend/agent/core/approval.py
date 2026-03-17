from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from backend.agent.core.tool_registry import ToolDefinition, ToolSafetyLevel
from backend.agent.runtime.contracts import (
    build_review_context,
    build_review_decision,
    build_review_request,
    summarize_review_state,
)


@dataclass(frozen=True)
class ApprovalRequest:
    id: str
    agent: str
    tool: str
    safety_level: str
    reason: str
    created_at: str
    status: str = "pending_review"
    note: str = ""
    payload: dict[str, Any] = field(default_factory=dict)
    review_context: dict[str, Any] = field(default_factory=dict)
    review_request: dict[str, Any] = field(default_factory=dict)
    review_decision: dict[str, Any] = field(default_factory=dict)


class ApprovalGate:
    def __init__(
        self,
        *,
        require_controlled: bool = True,
        require_privileged: bool = True,
        approved_request_ids: set[str] | None = None,
    ) -> None:
        self.require_controlled = require_controlled
        self.require_privileged = require_privileged
        self._approved_request_ids = {
            str(item)
            for item in set(approved_request_ids or set())
            if str(item).strip()
        }
        self._requests: dict[str, ApprovalRequest] = {}

    def _needs_approval(self, tool: ToolDefinition) -> bool:
        if tool.safety_level == ToolSafetyLevel.PRIVILEGED:
            return self.require_privileged
        if tool.safety_level == ToolSafetyLevel.CONTROLLED:
            return self.require_controlled
        return False

    def _target_paths(self, payload: dict[str, Any] | None) -> list[str]:
        data = dict(payload or {})
        candidates: list[str] = []

        direct = str(data.get("path") or data.get("path_hint") or "").strip()
        if direct:
            candidates.append(direct)

        for item in list(data.get("paths") or []):
            value = str(item or "").strip()
            if value:
                candidates.append(value)

        patch_text = str(data.get("patch_text") or data.get("patchText") or data.get("patch") or "")
        for match in re.findall(r"^\+\+\+\s+(?:[ab]/)?(.+)$", patch_text, flags=re.MULTILINE):
            value = str(match).strip()
            if value and value != "/dev/null":
                candidates.append(value)
        for match in re.findall(r"^---\s+(?:[ab]/)?(.+)$", patch_text, flags=re.MULTILINE):
            value = str(match).strip()
            if value and value != "/dev/null":
                candidates.append(value)

        seen: set[str] = set()
        ordered: list[str] = []
        for item in candidates:
            if item in seen:
                continue
            seen.add(item)
            ordered.append(item)
        return ordered[:12]

    def _patch_preview_metadata(self, payload: dict[str, Any] | None) -> dict[str, Any]:
        data = dict(payload or {})
        preview = data.get("patch_preview") or data.get("patchPreview")
        if not isinstance(preview, dict):
            return {}

        confidence = dict(preview.get("confidence") or {})
        files: list[dict[str, Any]] = []
        for item in list(preview.get("files") or [])[:12]:
            if not isinstance(item, dict):
                continue
            files.append(
                {
                    "path": str(item.get("path") or ""),
                    "operation": str(item.get("operation") or ""),
                    "status": str(item.get("status") or ""),
                    "confidence": dict(item.get("confidence") or {}),
                }
            )

        return {
            "patch_preview": {
                "ok": bool(preview.get("ok", False)),
                "dry_run": bool(preview.get("dryRun", False)),
                "message": str(preview.get("message") or ""),
                "file_count": int(preview.get("fileCount") or 0),
                "applied_file_count": int(preview.get("appliedFileCount") or 0),
                "already_applied_file_count": int(preview.get("alreadyAppliedFileCount") or 0),
                "rejected_hunk_count": int(preview.get("rejectedHunkCount") or 0),
                "automation_score": int(preview.get("automationScore") or 0),
                "automation_recommendation": str(preview.get("automationRecommendation") or ""),
                "confidence": {
                    "score": confidence.get("score"),
                    "normalized": confidence.get("normalized"),
                    "label": str(confidence.get("label") or ""),
                    "recommendation": str(confidence.get("recommendation") or ""),
                    "summary": str(confidence.get("summary") or ""),
                },
                "files": files,
            }
        }

    def request_for(
        self,
        agent_name: str,
        tool: ToolDefinition,
        payload: dict[str, Any] | None = None,
        runtime_scope: dict[str, Any] | None = None,
    ) -> ApprovalRequest | None:
        if not self._needs_approval(tool):
            return None

        request_id = f"{agent_name}:{tool.name}:{len(self._requests) + 1}"
        scope = dict(runtime_scope or {})
        patch_preview = self._patch_preview_metadata(payload)
        preview_confidence = dict(patch_preview.get("patch_preview", {}).get("confidence") or {})
        preview_score = preview_confidence.get("score")
        preview_label = str(preview_confidence.get("label") or "").strip()
        preview_suffix = ""
        if preview_label or preview_score is not None:
            preview_parts = []
            if preview_label:
                preview_parts.append(preview_label)
            if preview_score is not None:
                preview_parts.append(f"{preview_score}/100")
            preview_suffix = f" ({' '.join(preview_parts)} patch confidence)"
        review_context = build_review_context(
            run_id=str(scope.get("run_id") or ""),
            task_id=str(scope.get("task_id") or ""),
            ticket_id=str(scope.get("ticket") or ""),
            stage="tool",
            review_type="tool-approval",
            summary=f"{tool.name} requires approval before execution",
            risk_level=str(tool.safety_level.value),
            action=tool.name,
            target_paths=self._target_paths(payload),
            evidence={"payload": dict(payload or {}), "boundary": dict(tool.boundary or {}), **patch_preview},
        )
        review_request = build_review_request(
            review_id=request_id,
            run_id=str(scope.get("run_id") or ""),
            task_id=str(scope.get("task_id") or ""),
            ticket_id=str(scope.get("ticket") or ""),
            title=f"Approve {tool.name}",
            request_type="tool-approval",
            summary=f"{tool.name} is {tool.safety_level.value} and requires approval{preview_suffix}",
            requested_by=agent_name,
            state="auto_approved" if request_id in self._approved_request_ids else "pending_review",
            reason=f"{tool.name} is {tool.safety_level.value} and requires approval",
            tool_name=tool.name,
            safety_level=str(tool.safety_level.value),
            approval_request_id=request_id,
            context=review_context,
            metadata={"payload": dict(payload or {}), "boundary": dict(tool.boundary or {}), **patch_preview},
        )
        if request_id in self._approved_request_ids:
            self._requests[request_id] = ApprovalRequest(
                id=request_id,
                agent=agent_name,
                tool=tool.name,
                safety_level=str(tool.safety_level.value),
                reason=f"{tool.name} is {tool.safety_level.value} and requires approval",
                created_at=review_request["requested_at"],
                status="auto_approved",
                payload=dict(payload or {}),
                review_context=review_context,
                review_request=review_request,
                review_decision=build_review_decision(review_request=review_request, decision="auto_approved", decided_by="approval_gate"),
            )
            return None

        request = ApprovalRequest(
            id=request_id,
            agent=agent_name,
            tool=tool.name,
            safety_level=str(tool.safety_level.value),
            reason=f"{tool.name} is {tool.safety_level.value} and requires approval",
            created_at=review_request["requested_at"],
            payload=dict(payload or {}),
            review_context=review_context,
            review_request=review_request,
        )
        self._requests[request_id] = request
        return request

    def decide(self, request_id: str, decision: str, *, note: str = "") -> dict[str, Any]:
        request = self._requests.get(request_id)
        normalized = str(decision or "").strip().lower()

        if request is None:
            return {"ok": False, "error": "unknown request", "id": request_id}
        if normalized not in {"approved", "rejected", "deferred"}:
            return {"ok": False, "error": "invalid decision", "id": request_id}

        review_decision = build_review_decision(
            review_request=request.review_request,
            decision=normalized,
            decided_by="host",
            note=str(note or ""),
        )

        updated = ApprovalRequest(
            id=request.id,
            agent=request.agent,
            tool=request.tool,
            safety_level=request.safety_level,
            reason=request.reason,
            created_at=request.created_at,
            status=normalized,
            note=str(note or ""),
            payload=dict(request.payload),
            review_context=dict(request.review_context),
            review_request={**dict(request.review_request), "state": normalized},
            review_decision=review_decision,
        )
        self._requests[request_id] = updated
        if normalized == "approved":
            self._approved_request_ids.add(request_id)
        return {"ok": True, "id": request_id, "status": normalized}

    def pending(self) -> list[dict[str, Any]]:
        return [
            {
                "id": request.id,
                "agent": request.agent,
                "tool": request.tool,
                "safety_level": request.safety_level,
                "reason": request.reason,
                "created_at": request.created_at,
                "status": request.status,
                "note": request.note,
                "payload": dict(request.payload),
                "review_context": dict(request.review_context),
                "review_request": dict(request.review_request),
                "review_decision": dict(request.review_decision),
            }
            for request in self._requests.values()
            if request.status == "pending_review"
        ]

    def review_requests(self) -> list[dict[str, Any]]:
        return [
            {
                **dict(request.review_request),
                "state": request.status,
                "status": request.status,
                "note": request.note,
                "payload": dict(request.payload),
                "review_context": dict(request.review_context),
                "review_decision": dict(request.review_decision),
            }
            for request in self._requests.values()
        ]

    def approval_state(self) -> dict[str, Any]:
        pending = self.pending()
        review_state = summarize_review_state(self.review_requests())
        return {
            "pending_count": len(pending),
            "approved_count": sum(1 for item in self._requests.values() if item.status == "approved"),
            "rejected_count": sum(1 for item in self._requests.values() if item.status == "rejected"),
            "deferred_count": sum(1 for item in self._requests.values() if item.status == "deferred"),
            "auto_approved_count": sum(1 for item in self._requests.values() if item.status == "auto_approved"),
            "pending_requests": pending,
            "review_state": review_state,
            "review_requests": review_state["requests"],
        }


__all__ = ["ApprovalGate", "ApprovalRequest"]
