# --- {{model_file}} ---
"""Fullstack scaffold (backend-first) for BAT<{{ticket_id}}>."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class {{component_name}}State:
    ticket: str = "{{ticket_id}}"
    feature: str = "{{snake}}"


# --- {{service_file}} ---
"""Backend service seam for fullstack BAT<{{ticket_id}}>."""
from __future__ import annotations

from app.models.{{snake}} import {{component_name}}State


def get_{{snake}}_state() -> dict:
    state = {{component_name}}State()
    return {"ticket": state.ticket, "feature": state.feature}


# --- {{route_file}} ---
from __future__ import annotations

from fastapi import APIRouter

from app.services.{{snake}} import get_{{snake}}_state

router = APIRouter(prefix="/feature/{{snake}}", tags=["feature"])


@router.get("/state")
def read_{{snake}}_state() -> dict:
    return get_{{snake}}_state()


# --- {{test_file}} ---
from __future__ import annotations

from app.services.{{snake}} import get_{{snake}}_state


def test_{{snake}}_state_shape() -> None:
    payload = get_{{snake}}_state()
    assert payload["ticket"] == "{{ticket_id}}"
