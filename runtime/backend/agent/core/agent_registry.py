from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.agent.core.model_routing import resolve_agent_model_route
from backend.agent.core.permissions import PermissionRegistry, build_default_permissions


class AgentRegistrationError(ValueError):
    pass


class AgentNotFoundError(KeyError):
    pass


@dataclass(frozen=True)
class AgentDefinition:
    name: str
    purpose: str
    allowed_tools: tuple[str, ...]
    default_model_role: str
    handoff_targets: tuple[str, ...]

    @property
    def default_provider_role(self) -> str:
        return self.default_model_role


class AgentRegistry:
    def __init__(self) -> None:
        self._agents: dict[str, AgentDefinition] = {}

    def register(self, agent: AgentDefinition) -> AgentDefinition:
        if agent.name in self._agents:
            raise AgentRegistrationError(f"agent already registered: {agent.name}")
        self._agents[agent.name] = agent
        return agent

    def register_agent(self, agent: AgentDefinition) -> AgentDefinition:
        return self.register(agent)

    def get(self, name: str) -> AgentDefinition:
        if name not in self._agents:
            raise AgentNotFoundError(f"unknown agent: {name}")
        return self._agents[name]

    def get_agent(self, name: str) -> AgentDefinition:
        return self.get(name)

    def list_agents(self) -> list[AgentDefinition]:
        return [self._agents[name] for name in sorted(self._agents)]

    def all_agents(self) -> list[AgentDefinition]:
        return self.list_agents()


DEFAULT_AGENT_SPECS: dict[str, dict[str, Any]] = {
    "planner": {
        "purpose": "Analyze repo context, collect constraints, and prepare a safe implementation plan.",
        "default_model_role": "reasoning",
        "handoff_targets": ("implementer",),
    },
    "implementer": {
        "purpose": "Apply approved changes to repository files and prepare code for validation.",
        "default_model_role": "coding",
        "handoff_targets": ("validator",),
    },
    "validator": {
        "purpose": "Run validation commands and decide whether repair or release should follow.",
        "default_model_role": "verification",
        "handoff_targets": ("repair", "release"),
    },
    "repair": {
        "purpose": "Repair validation failures with targeted code changes and re-handoff for validation.",
        "default_model_role": "repair",
        "handoff_targets": ("validator", "release"),
    },
    "release": {
        "purpose": "Prepare release-facing status, git state, and notifications without broad repo mutation.",
        "default_model_role": "release",
        "handoff_targets": (),
    },
}


def build_default_agent_registry(
    permission_registry: PermissionRegistry | None = None,
    project_root: Path | None = None,
) -> AgentRegistry:
    permissions = permission_registry or build_default_permissions()
    registry = AgentRegistry()
    for name, spec in DEFAULT_AGENT_SPECS.items():
        route = resolve_agent_model_route(name, project_root)
        registry.register_agent(
            AgentDefinition(
                name=name,
                purpose=spec["purpose"],
                allowed_tools=tuple(sorted(permissions.allowed_tools(name))),
                default_model_role=route.role,
                handoff_targets=tuple(spec["handoff_targets"]),
            )
        )
    return registry
