from __future__ import annotations

from dataclasses import dataclass


class ToolPermissionError(PermissionError):
    pass


@dataclass(frozen=True)
class AgentPermissionSet:
    agent_name: str
    allowed_tools: frozenset[str]


class PermissionRegistry:
    def __init__(self) -> None:
        self._permissions: dict[str, AgentPermissionSet] = {}

    def register(self, permission_set: AgentPermissionSet) -> AgentPermissionSet:
        self._permissions[permission_set.agent_name] = permission_set
        return permission_set

    def get(self, agent_name: str) -> AgentPermissionSet:
        if agent_name not in self._permissions:
            raise ToolPermissionError(f"no permission set registered for agent: {agent_name}")
        return self._permissions[agent_name]

    def allowed_tools(self, agent_name: str) -> set[str]:
        return set(self.get(agent_name).allowed_tools)

    def is_allowed(self, agent_name: str, tool_name: str) -> bool:
        return tool_name in self.get(agent_name).allowed_tools

    def can_use_tool(self, agent_name: str, tool_name: str) -> bool:
        return self.is_allowed(agent_name, tool_name)

    def require_allowed(self, agent_name: str, tool_name: str) -> None:
        if not self.is_allowed(agent_name, tool_name):
            raise ToolPermissionError(f"agent '{agent_name}' is not allowed to use tool '{tool_name}'")

    def require_tool_permission(self, agent_name: str, tool_name: str) -> None:
        self.require_allowed(agent_name, tool_name)


DEFAULT_AGENT_TOOL_ALLOWLISTS: dict[str, set[str]] = {
    "planner": {"read_file", "search_repo", "list_tasks", "todo_board"},
    "implementer": {"read_file", "search_repo", "edit_file", "run_command"},
    "validator": {"read_file", "search_repo", "run_command"},
    "repair": {"read_file", "search_repo", "edit_file", "run_command"},
    "release": {"read_file", "git_status", "notify"},
}


def build_default_permissions() -> PermissionRegistry:
    registry = PermissionRegistry()
    for agent_name, tools in DEFAULT_AGENT_TOOL_ALLOWLISTS.items():
        registry.register(AgentPermissionSet(agent_name=agent_name, allowed_tools=frozenset(sorted(tools))))
    return registry
