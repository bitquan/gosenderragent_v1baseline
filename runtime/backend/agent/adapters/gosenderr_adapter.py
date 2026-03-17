from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Any

from backend.agent.core.adapters.base import RepoAdapter, TicketMetadata

TICKET_RE = re.compile(r"^- `BAT<(?P<id>\d+)>`\s*(?P<desc>.+)$")

DOMAIN_KEYWORDS: dict[str, tuple[str, ...]] = {
    "dispatch": ("dispatch", "matching", "queue", "worker", "senderr"),
    "pricing": ("pricing", "fare", "surge", "demand", "heatmap"),
    "tracking": ("tracking", "location", "status", "progress"),
    "payments": ("payment", "wallet", "payout", "network pool"),
    "customer": ("customer", "booking", "job create", "job status"),
}


class GoSenderrAdapter(RepoAdapter):
    def __init__(self, project_root: Path):
        self.project_root = project_root
        self.board_path = project_root / "docs" / "BAT_FEATURE_BOARD.md"

    def load_tickets(self) -> dict[str, str]:
        tickets: dict[str, str] = {}
        if not self.board_path.exists():
            return tickets
        for line in self.board_path.read_text(encoding="utf-8").splitlines():
            match = TICKET_RE.match(line.strip())
            if match and match.group("id") not in tickets:
                tickets[match.group("id")] = match.group("desc")
        return tickets

    def parse_ticket_metadata(self, ticket_id: str, desc: str) -> TicketMetadata:
        tags = self._parse_tags(desc)
        status = tags[0] if tags else "UNKNOWN"
        priority = next((tag for tag in tags if re.fullmatch(r"P\d+", tag)), "P9")
        lower = desc.lower()
        is_fe = "FE" in tags or any(token in lower for token in ("frontend", "react", "tsx", "customer app", "senderr app"))
        is_backend = "BE" in tags or not is_fe or any(token in lower for token in ("backend", "api", "service", "model", "schema"))
        keywords = [tag.lower() for tag in tags[:4]]
        return TicketMetadata(
            ticket_id=ticket_id,
            desc=desc,
            tags=tags,
            status=status,
            priority_tag=priority,
            domain=self.classify_ticket_domain(desc),
            keywords=keywords,
            is_fe=is_fe,
            is_backend=is_backend,
        )

    def classify_ticket_domain(self, desc: str) -> str:
        lower = desc.lower()
        best = "general"
        best_score = 0
        for domain, tokens in DOMAIN_KEYWORDS.items():
            score = sum(1 for token in tokens if token in lower)
            if score > best_score:
                best = domain
                best_score = score
        return best

    def suggest_target_files(self, metadata: TicketMetadata, *, limit: int = 12) -> list[str]:
        candidates: list[str] = []
        if metadata.is_backend:
            candidates.extend([
                f"backend/app/services/{metadata.domain}.py",
                f"backend/app/api/routes/{metadata.domain}.py",
                f"backend/tests/test_{metadata.domain}.py",
            ])
        if metadata.is_fe:
            candidates.extend([
                f"frontend/apps/customer-app/src/components/{metadata.ticket_id}.tsx",
                f"frontend/apps/customer-app/src/routes/{metadata.ticket_id}.tsx",
            ])
        deduped: list[str] = []
        for path in candidates:
            if path not in deduped:
                deduped.append(path)
        return deduped[:limit]

    def validation_commands(self, metadata: TicketMetadata, *, full_verify: bool = False) -> list[list[str]]:
        commands: list[list[str]] = []
        python_bin = self.project_root / "backend" / ".venv" / "bin" / "python"
        python_cmd = str(python_bin) if python_bin.exists() else os.environ.get("PYTHON", "python3")
        if metadata.is_backend:
            commands.append([python_cmd, "-m", "compileall", "backend/app"])
            if full_verify:
                commands.append([python_cmd, "-m", "pytest", "-q", "backend/tests"])
        if metadata.is_fe:
            commands.append(["npm", "run", "--workspace", "@gosenderr/customer-app", "typecheck"])
        return commands

    def is_ticket_actionable(self, metadata: TicketMetadata) -> bool:
        return metadata.status == "TODO"

    def generate_repo_map(self) -> dict[str, Any]:
        files: list[str] = []
        try:
            result = subprocess.run(["git", "ls-files"], cwd=str(self.project_root), capture_output=True, text=True, check=False)
            if result.returncode == 0:
                files = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        except Exception:
            files = []
        directories: dict[str, int] = {}
        for path in files:
            parent = str(Path(path).parent)
            directories[parent] = directories.get(parent, 0) + 1
        return {
            "generated_at": None,
            "file_count": len(files),
            "directories": [{"path": path, "count": count} for path, count in sorted(directories.items())[:50]],
        }

    @staticmethod
    def _parse_tags(desc: str) -> list[str]:
        tags: list[str] = []
        for raw_tag in re.findall(r"\[([^\]]+)\]", desc):
            for part in re.split(r"[/,|]+", raw_tag.upper()):
                tag = part.strip()
                if tag and tag not in tags:
                    tags.append(tag)
        upper = desc.upper()
        for status in ("TODO", "DONE", "BLOCKED", "UPGRADE", "NEW FEATURE"):
            if upper.startswith(status) and status not in tags:
                tags.insert(0, status)
                break
        for match in re.findall(r"\bP\d+\b", upper):
            if match not in tags:
                tags.append(match)
        for match in re.findall(r"\b(?:DEP|RISK):[A-Z0-9_-]+\b", upper):
            if match not in tags:
                tags.append(match)
        return tags
