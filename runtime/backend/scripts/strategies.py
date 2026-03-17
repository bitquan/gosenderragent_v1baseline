"""Backward-compatible strategy exports for the legacy dev assistant."""

from __future__ import annotations

try:
	from backend.agent.core.strategies.catalog import STRATEGIES, PathStrategy as Strategy, get_strategy
except ModuleNotFoundError:
	from dataclasses import dataclass, field
	import re
	from typing import List, Pattern

	@dataclass
	class Strategy:
		strategy_name: str
		allowed_patterns: List[Pattern] = field(default_factory=list)
		anti_patterns: List[Pattern] = field(default_factory=list)
		description: str = ""

		@property
		def name(self) -> str:
			return self.strategy_name

		def matches_file(self, path: str) -> bool:
			return any(pattern.search(path) for pattern in self.allowed_patterns)

		def is_anti(self, path: str) -> bool:
			return any(pattern.search(path) for pattern in self.anti_patterns)

		def validation_scope(self, _metadata=None) -> list[str]:
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

	STRATEGIES: dict[str, Strategy] = {
		"backend_api": Strategy(
			strategy_name="backend_api",
			allowed_patterns=[
				re.compile(r"backend/app/.*\.py$"),
				re.compile(r"backend/tests/.*\.py$"),
			],
			anti_patterns=[re.compile(r"frontend/"), re.compile(r"cypress")],
			description="Backend fastapi/sqlalchemy/service scaffolds",
		),
		"frontend_feature": Strategy(
			strategy_name="frontend_feature",
			allowed_patterns=[re.compile(r"frontend/.*\.(ts|tsx|js|jsx)$"), re.compile(r"packages/.*")],
			anti_patterns=[re.compile(r"backend/app/")],
			description="Frontend React/TypeScript features",
		),
		"qa_e2e": Strategy(
			strategy_name="qa_e2e",
			allowed_patterns=[re.compile(r"cypress"), re.compile(r"\.cy\.(ts|js)$"), re.compile(r"\.github/workflows/.*cypress.*")],
			anti_patterns=[re.compile(r"backend/app/")],
			description="End‑to‑end/QA test configuration",
		),
		"docs": Strategy(
			strategy_name="docs",
			allowed_patterns=[re.compile(r"docs/"), re.compile(r"\.md$")],
			anti_patterns=[re.compile(r"backend/"), re.compile(r"frontend/")],
			description="Documentation and runbooks",
		),
		"ops_ci": Strategy(
			strategy_name="ops_ci",
			allowed_patterns=[re.compile(r"\.yml$"), re.compile(r"Dockerfile"), re.compile(r"deploy/"), re.compile(r"scripts/.*sh")],
			anti_patterns=[re.compile(r"frontend/.*\.(tsx?|jsx?)$")],
			description="Ops or CI configuration",
		),
		"security": Strategy(
			strategy_name="security",
			allowed_patterns=[re.compile(r"backend/.*auth.*"), re.compile(r"security"), re.compile(r"hardening")],
			anti_patterns=[re.compile(r"frontend/")],
			description="Security hardening",
		),
		"mixed": Strategy(
			strategy_name="mixed",
			allowed_patterns=[re.compile(r".*")],
			anti_patterns=[],
			description="Uncategorized or mixed-domain tasks",
		),
	}

	def get_strategy(name: str) -> Strategy:
		return STRATEGIES.get(name, STRATEGIES["mixed"])

__all__ = ["Strategy", "STRATEGIES", "get_strategy"]
