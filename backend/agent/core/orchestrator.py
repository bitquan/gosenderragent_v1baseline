from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Callable

from backend.agent.core.agent_registry import AgentDefinition, AgentRegistry, build_default_agent_registry
from backend.agent.core.permissions import PermissionRegistry, build_default_permissions
from backend.agent.core.tool_registry import ToolRegistry


class OrchestratorError(RuntimeError):
    pass


class HandoffError(OrchestratorError):
    pass


AgentHandler = Callable[["SequentialAgentOrchestrator", AgentDefinition, "OrchestrationTask", dict[str, Any] | None], dict[str, Any]]


@dataclass
class OrchestrationTask:
    objective: str
    ticket: str | None = None
    context: dict[str, Any] = field(default_factory=dict)


@dataclass
class AgentRunResult:
    agent: str
    status: str
    summary: str
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    payload: dict[str, Any] = field(default_factory=dict)
    handoff_to: str | None = None
    error: str | None = None


class SequentialAgentOrchestrator:
    def __init__(
        self,
        *,
        tool_registry: ToolRegistry,
        permission_registry: PermissionRegistry | None = None,
        agent_registry: AgentRegistry | None = None,
        handlers: dict[str, AgentHandler] | None = None,
    ) -> None:
        self.tool_registry = tool_registry
        self.permission_registry = permission_registry or build_default_permissions()
        self.agent_registry = agent_registry or build_default_agent_registry(self.permission_registry)
        self.handlers = handlers or {}
        self._active_agent: str | None = None
        self._active_tool_calls: list[dict[str, Any]] | None = None

    def execute_tool(self, agent_name: str, tool_name: str, **kwargs: Any) -> Any:
        self.permission_registry.require_allowed(agent_name, tool_name)
        tool = self.tool_registry.get(tool_name)
        result = tool.invoke(**kwargs)
        if self._active_agent == agent_name and self._active_tool_calls is not None:
            self._active_tool_calls.append({
                "tool": tool_name,
                "safety_level": tool.safety_level.value,
                "input": kwargs,
            })
        return result

    def _default_next_agent(self, current_agent: str, result: AgentRunResult) -> str | None:
        if current_agent == "planner":
            return "implementer"
        if current_agent == "implementer":
            return "validator"
        if current_agent == "validator":
            if result.status in {"failed", "needs_repair"} or result.payload.get("valid") is False:
                return "repair"
            return "release"
        if current_agent == "repair":
            return "validator"
        return None

    def _normalize_result(self, agent_name: str, raw_result: dict[str, Any], tool_calls: list[dict[str, Any]]) -> AgentRunResult:
        return AgentRunResult(
            agent=agent_name,
            status=raw_result.get("status", "completed"),
            summary=raw_result.get("summary", ""),
            tool_calls=tool_calls,
            payload=raw_result.get("payload", {}),
            handoff_to=raw_result.get("handoff_to"),
            error=raw_result.get("error"),
        )

    def run_agent(self, agent_name: str, task: OrchestrationTask, payload: dict[str, Any] | None = None) -> AgentRunResult:
        agent = self.agent_registry.get(agent_name)
        handler = self.handlers.get(agent_name)
        tool_calls: list[dict[str, Any]] = []
        previous_agent = self._active_agent
        previous_tool_calls = self._active_tool_calls
        self._active_agent = agent_name
        self._active_tool_calls = tool_calls
        try:
            if handler is None:
                raw_result = {
                    "status": "pending",
                    "summary": f"{agent_name} awaiting implementation",
                    "payload": payload or {},
                }
            else:
                raw_result = handler(self, agent, task, payload)
        finally:
            self._active_agent = previous_agent
            self._active_tool_calls = previous_tool_calls
        result = self._normalize_result(agent_name, raw_result, tool_calls)
        next_agent = result.handoff_to or self._default_next_agent(agent_name, result)
        if next_agent is not None and next_agent not in agent.handoff_targets:
            raise HandoffError(f"agent '{agent_name}' cannot hand off to '{next_agent}'")
        result.handoff_to = next_agent
        return result

    def run(self, task: OrchestrationTask, *, start_agent: str = "planner", max_steps: int = 10) -> dict[str, Any]:
        results: list[AgentRunResult] = []
        current_agent: str | None = start_agent
        payload: dict[str, Any] | None = {"task": asdict(task)}
        steps = 0
        while current_agent is not None:
            if steps >= max_steps:
                raise OrchestratorError("maximum orchestration steps exceeded")
            result = self.run_agent(current_agent, task, payload)
            results.append(result)
            if result.status == "blocked":
                break
            if result.status == "failed" and current_agent != "validator":
                break
            payload = result.payload
            current_agent = result.handoff_to
            steps += 1
        final_result = results[-1] if results else None
        return {
            "task": asdict(task),
            "results": [asdict(item) for item in results],
            "ok": bool(final_result) and final_result.status not in {"failed", "blocked"},
        }
