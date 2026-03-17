from __future__ import annotations

from dataclasses import dataclass, field
import re
from typing import Any, Pattern

from backend.agent.core.adapters.base import TicketMetadata
from backend.agent.core.strategies.base import Strategy as BaseStrategy, StrategyPlan


@dataclass
class PathStrategy(BaseStrategy):
    strategy_name: str
    allowed_patterns: list[Pattern[str]] = field(default_factory=list)
    anti_patterns: list[Pattern[str]] = field(default_factory=list)
    description: str = ""

    def name(self) -> str:
        return self.strategy_name

    def matches_file(self, path: str) -> bool:
        return any(pattern.search(path) for pattern in self.allowed_patterns)

    def is_anti(self, path: str) -> bool:
        return any(pattern.search(path) for pattern in self.anti_patterns)

    def score_targets(self, metadata: TicketMetadata, candidates: list[str]) -> list[str]:
        keywords = [metadata.domain.lower(), *[keyword.lower() for keyword in metadata.keywords]]
        scored: list[tuple[int, str]] = []
        for candidate in candidates:
            score = 0
            lower = candidate.lower()
            if self.matches_file(candidate):
                score += 5
            score += sum(1 for keyword in keywords if keyword and keyword in lower)
            scored.append((score, candidate))
        ranked = [candidate for score, candidate in sorted(scored, key=lambda item: item[0], reverse=True) if score > 0]
        return ranked or candidates[:5]

    def build_plan(self, metadata: TicketMetadata, candidates: list[str]) -> StrategyPlan:
        ranked = self.score_targets(metadata, candidates)
        steps = [
            {"type": "inspect", "strategy": self.strategy_name, "targets": ranked[:3]},
            {"type": "implement", "strategy": self.strategy_name, "ticket": metadata.ticket_id},
            {"type": "validate", "strategy": self.strategy_name, "scope": self.validation_scope(metadata)},
        ]
        return StrategyPlan(
            strategy_name=self.strategy_name,
            steps=steps,
            validation_scope=self.validation_scope(metadata),
            repair_scope=self.repair_scope(metadata, []),
        )

    def validation_scope(self, metadata: TicketMetadata) -> list[str]:
        if self.strategy_name == "backend_api":
            return ["backend/tests", "backend/app"]
        if self.strategy_name == "frontend_feature":
            return ["frontend/apps", "frontend/packages"]
        if self.strategy_name == "qa_e2e":
            return ["frontend", ".github/workflows"]
        if self.strategy_name == "docs":
            return ["docs", "README.md"]
        if self.strategy_name == "ops_ci":
            return ["deploy", ".github/workflows", "Dockerfile"]
        if self.strategy_name == "security":
            return ["backend/app", "backend/tests"]
        return ["."]

    def repair_scope(self, metadata: TicketMetadata, failures: list[dict[str, Any]]) -> list[str]:
        scoped = [str(failure.get("path") or "") for failure in failures if failure.get("path")]
        return scoped or self.validation_scope(metadata)


STRATEGIES: dict[str, PathStrategy] = {
    "backend_api": PathStrategy(
        strategy_name="backend_api",
        allowed_patterns=[
            re.compile(r"backend/app/.*\.py$"),
            re.compile(r"backend/tests/.*\.py$"),
        ],
        anti_patterns=[re.compile(r"frontend/"), re.compile(r"cypress")],
        description="Backend fastapi/sqlalchemy/service scaffolds",
    ),
    "frontend_feature": PathStrategy(
        strategy_name="frontend_feature",
        allowed_patterns=[
            re.compile(r"frontend/.*\.(ts|tsx|js|jsx)$"),
            re.compile(r"packages/.*"),
        ],
        anti_patterns=[re.compile(r"backend/app/")],
        description="Frontend React/TypeScript features",
    ),
    "qa_e2e": PathStrategy(
        strategy_name="qa_e2e",
        allowed_patterns=[
            re.compile(r"cypress"),
            re.compile(r"\.cy\.(ts|js)$"),
            re.compile(r"\.github/workflows/.*cypress.*"),
        ],
        anti_patterns=[re.compile(r"backend/app/")],
        description="End‑to‑end/QA test configuration",
    ),
    "docs": PathStrategy(
        strategy_name="docs",
        allowed_patterns=[re.compile(r"docs/"), re.compile(r"\.md$")],
        anti_patterns=[re.compile(r"backend/"), re.compile(r"frontend/")],
        description="Documentation and runbooks",
    ),
    "ops_ci": PathStrategy(
        strategy_name="ops_ci",
        allowed_patterns=[
            re.compile(r"\.yml$"),
            re.compile(r"Dockerfile"),
            re.compile(r"deploy/"),
            re.compile(r"scripts/.*sh"),
        ],
        anti_patterns=[re.compile(r"frontend/.*\.(tsx?|jsx?)$")],
        description="Ops or CI configuration",
    ),
    "security": PathStrategy(
        strategy_name="security",
        allowed_patterns=[
            re.compile(r"backend/.*auth.*"),
            re.compile(r"security"),
            re.compile(r"hardening"),
        ],
        anti_patterns=[re.compile(r"frontend/")],
        description="Security hardening",
    ),
    "mixed": PathStrategy(
        strategy_name="mixed",
        allowed_patterns=[re.compile(r".*")],
        anti_patterns=[],
        description="Uncategorized or mixed-domain tasks",
    ),
}


def get_strategy(name: str) -> PathStrategy:
    return STRATEGIES.get(name, STRATEGIES["mixed"])


def list_strategies() -> list[PathStrategy]:
    return list(STRATEGIES.values())