from __future__ import annotations

from typing import Any

from backend.agent.runtime.contracts import (
    append_agent_output,
    build_agent_output,
    build_runtime_event,
    build_runtime_result,
    transition_runtime_run,
)


class RuntimeOrchestrationDriver:
    def __init__(self, payload: dict[str, Any], *, ticket_id: str) -> None:
        self.payload = payload
        self.ticket_id = str(ticket_id or "")
        self.payload.setdefault("runtime_task", {})
        self.payload.setdefault("runtime_run", {})
        self.payload.setdefault("runtime_events", [])

    @property
    def runtime_task(self) -> dict[str, Any]:
        return dict(self.payload.get("runtime_task") or {})

    @property
    def runtime_run(self) -> dict[str, Any]:
        return dict(self.payload.get("runtime_run") or {})

    def emit_orchestration_event(
        self,
        *,
        stage: str,
        event: str,
        summary: str,
        level: str = "info",
        state: str | None = None,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        runtime_run = self.runtime_run
        runtime_task = self.runtime_task
        payload = build_runtime_event(
            run_id=str(runtime_run.get("run_id") or ""),
            task_id=str(runtime_task.get("task_id") or ""),
            ticket_id=self.ticket_id,
            stage=stage,
            event=event,
            state=str(state or runtime_run.get("state") or "created"),
            summary=summary,
            level=level,
            data=dict(data or {}),
        )
        self.payload.setdefault("runtime_events", []).append(payload)
        return payload

    def enter_stage(
        self,
        *,
        next_state: str,
        stage: str,
        summary: str,
        level: str = "info",
        **data: Any,
    ) -> dict[str, Any]:
        runtime_run = transition_runtime_run(
            self.runtime_run,
            next_state,
            stage=stage,
            summary=summary,
            data=data,
        )
        self.payload["runtime_run"] = runtime_run
        self.emit_orchestration_event(
            stage=stage,
            event="state-transition",
            summary=summary,
            level=level,
            state=str(runtime_run.get("state") or next_state),
            data=data,
        )
        return runtime_run

    def append_agent_output(
        self,
        *,
        agent_name: str,
        stage: str,
        decision: str,
        summary: str,
        confidence: float | int | str | None = None,
        ok: bool | None = None,
        artifacts: list[str] | None = None,
        level: str | None = None,
        **metadata: Any,
    ) -> dict[str, Any]:
        runtime_run = self.runtime_run
        runtime_task = self.runtime_task
        output = build_agent_output(
            run_id=str(runtime_run.get("run_id") or ""),
            task_id=str(runtime_task.get("task_id") or ""),
            ticket_id=self.ticket_id,
            agent_name=agent_name,
            stage=stage,
            decision=decision,
            summary=summary,
            confidence=confidence,
            ok=ok,
            artifacts=artifacts,
            metadata=metadata,
        )
        self.payload["runtime_run"] = append_agent_output(runtime_run, output)
        self.emit_orchestration_event(
            stage=stage,
            event="agent-output",
            summary=summary,
            level=level or ("info" if ok is not False else "warning"),
            data={
                "agent": agent_name,
                "decision": decision,
                "confidence": output.get("agent_confidence"),
                "artifacts": [str(item) for item in list(artifacts or []) if str(item)],
                **metadata,
            },
        )
        return output

    def finalize_runtime_result(
        self,
        *,
        ok: bool,
        failure: dict[str, Any] | None = None,
        artifact_paths: list[str] | None = None,
        metrics: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload = build_runtime_result(
            task=self.runtime_task,
            runtime_run=self.runtime_run,
            ok=bool(ok),
            failure=dict(failure or {}),
            artifact_paths=[str(path) for path in list(artifact_paths or []) if str(path)],
            metrics=dict(metrics or {}),
            metadata=dict(metadata or {}),
        )
        self.payload["runtime_result"] = payload
        return payload


__all__ = ["RuntimeOrchestrationDriver"]