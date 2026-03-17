"""Simple ticket classifier for the dev assistant.

The classifier inspects workstream tags, keywords, and a small
vocabulary to pick a strategy for how the assistant should treat a
BAT ticket.  The result is a (strategy,reason) pair.

This module also maintains a tiny persistent history of past
classifications that can later be consulted by the assistant when
planning files.  History is stored in JSON at
`backend/scripts/assistant_history.json`.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Tuple

HISTORY_PATH = Path(__file__).resolve().parent / "assistant_history.json"

# mapping from strategy name to a simple spec used for classification
# `tags` are workstream tags that strongly indicate the strategy.
# `keywords` are lowercased substrings to look for in the description.
STRATEGY_SPECS: Dict[str, Dict[str, List[str]]] = {
    "qa_e2e": {"tags": ["QA"], "keywords": ["cypress", "e2e", "integration test", "end-to-end"]},
    "security": {"tags": ["SEC"], "keywords": ["hardening", "csrf", "xss", "auth"]},
    "ops_ci": {"tags": ["OPS", "CI"], "keywords": ["nginx", "workflow", "cron", "ci", "schedule"]},
    "frontend_feature": {"tags": ["FE"], "keywords": ["ui", "react", "component", "frontend", "client"]},
    "backend_api": {"tags": ["BE"], "keywords": ["endpoint", "api", "model", "route", "service"]},
    "docs": {"tags": ["DOC"], "keywords": ["doc", "documentation", "runbook", "playbook", "readme"]},
    "mixed": {"tags": [], "keywords": []},  # fallback
}


def load_history() -> List[Dict[str, Any]]:
    if not HISTORY_PATH.exists():
        return []
    try:
        return json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []


def save_history(entries: List[Dict[str, Any]]) -> None:
    HISTORY_PATH.write_text(json.dumps(entries, indent=2), encoding="utf-8")


def record_history(ticket: str, strategy: str, files: List[str], validation: List[str]) -> None:
    entries = load_history()
    entries.append({
        "ticket": ticket,
        "strategy": strategy,
        "files": files,
        "validation": validation,
    })
    save_history(entries)


TAG_RE = re.compile(r"\[([A-Z]+)\]")


def classify_ticket(description: str) -> Tuple[str, str]:
    """Return (strategy, reason) for a ticket description."""
    tags = TAG_RE.findall(description)
    tags = {t for t in tags}
    desc_low = description.lower()

    # first check tags priority order
    for strat, spec in STRATEGY_SPECS.items():
        for t in spec.get("tags", []):
            if t in tags:
                return strat, f"found tag [{t}]"
    # then keywords
    for strat, spec in STRATEGY_SPECS.items():
        for kw in spec.get("keywords", []):
            if kw in desc_low:
                return strat, f"keyword match '{kw}'"
    # fallback to mixed
    return "mixed", "no tag/keyword match"
