from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from backend.agent.core.adapters.base import TicketMetadata


@dataclass
class StrategyPlan:
    strategy_name: str
    steps: list[dict[str, Any]] = field(default_factory=list)
    validation_scope: list[str] = field(default_factory=list)
    repair_scope: list[str] = field(default_factory=list)


class Strategy(ABC):
    @abstractmethod
    def name(self) -> str:
        raise NotImplementedError

    @abstractmethod
    def score_targets(self, metadata: TicketMetadata, candidates: list[str]) -> list[str]:
        raise NotImplementedError

    @abstractmethod
    def build_plan(self, metadata: TicketMetadata, candidates: list[str]) -> StrategyPlan:
        raise NotImplementedError

    @abstractmethod
    def validation_scope(self, metadata: TicketMetadata) -> list[str]:
        raise NotImplementedError

    @abstractmethod
    def repair_scope(self, metadata: TicketMetadata, failures: list[dict[str, Any]]) -> list[str]:
        raise NotImplementedError
