from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class TicketMetadata:
    ticket_id: str
    desc: str
    tags: list[str] = field(default_factory=list)
    status: str = "UNKNOWN"
    priority_tag: str = "P9"
    domain: str = "general"
    keywords: list[str] = field(default_factory=list)
    is_fe: bool = False
    is_backend: bool = True


class RepoAdapter(ABC):
    @abstractmethod
    def load_tickets(self) -> dict[str, str]:
        raise NotImplementedError

    @abstractmethod
    def parse_ticket_metadata(self, ticket_id: str, desc: str) -> TicketMetadata:
        raise NotImplementedError

    @abstractmethod
    def classify_ticket_domain(self, desc: str) -> str:
        raise NotImplementedError

    @abstractmethod
    def suggest_target_files(self, metadata: TicketMetadata, *, limit: int = 12) -> list[str]:
        raise NotImplementedError

    @abstractmethod
    def validation_commands(self, metadata: TicketMetadata, *, full_verify: bool = False) -> list[list[str]]:
        raise NotImplementedError

    @abstractmethod
    def is_ticket_actionable(self, metadata: TicketMetadata) -> bool:
        raise NotImplementedError

    @abstractmethod
    def generate_repo_map(self) -> dict[str, Any]:
        raise NotImplementedError
