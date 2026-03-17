# --- {{model_file}} ---
"""Ops control model scaffold for BAT<{{ticket_id}}>."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class {{component_name}}Runbook:
    check_name: str
    required: bool = True


# --- {{service_file}} ---
"""Ops readiness helpers for BAT<{{ticket_id}}>."""
from __future__ import annotations

from app.models.{{snake}} import {{component_name}}Runbook


def build_{{snake}}_runbook() -> list[dict]:
    checks = [
        {{component_name}}Runbook(check_name="service_up"),
        {{component_name}}Runbook(check_name="db_reachable"),
        {{component_name}}Runbook(check_name="redis_reachable"),
    ]
    return [{"check_name": check.check_name, "required": check.required} for check in checks]


# --- {{route_file}} ---
from __future__ import annotations

from fastapi import APIRouter

from app.services.{{snake}} import build_{{snake}}_runbook

router = APIRouter(prefix="/ops/{{snake}}", tags=["ops"])


@router.get("/runbook")
def get_runbook() -> dict:
    return {"checks": build_{{snake}}_runbook()}


# --- {{test_file}} ---
from __future__ import annotations

from app.services.{{snake}} import build_{{snake}}_runbook


def test_{{snake}}_runbook_contains_core_checks() -> None:
    checks = build_{{snake}}_runbook()
    names = {row["check_name"] for row in checks}
    assert {"service_up", "db_reachable", "redis_reachable"}.issubset(names)
