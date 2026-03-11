# --- {{model_file}} ---
"""Generated model scaffold for BAT<{{ticket_id}}>."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone


@dataclass(slots=True)
class {{component_name}}Record:
    """Typed payload model used by the service layer."""

    ticket_id: str = "{{ticket_id}}"
    metric: str = "placeholder"
    value: float = 0.0
    captured_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


# --- {{service_file}} ---
"""Generated service scaffold for BAT<{{ticket_id}}>."""
from __future__ import annotations

from app.models.{{snake}} import {{component_name}}Record


def build_{{snake}}_summary() -> dict:
    rows = [
        {{component_name}}Record(metric="jobs_total", value=0.0),
        {{component_name}}Record(metric="jobs_active", value=0.0),
        {{component_name}}Record(metric="senderr_idle_minutes", value=0.0),
    ]
    return {
        "ticket": "{{ticket_id}}",
        "rows": [
            {
                "metric": row.metric,
                "value": row.value,
                "captured_at": row.captured_at.isoformat(),
            }
            for row in rows
        ],
    }


# --- {{route_file}} ---
"""Generated API route scaffold for BAT<{{ticket_id}}>."""
from __future__ import annotations

from fastapi import APIRouter

from app.services.{{snake}} import build_{{snake}}_summary

router = APIRouter(prefix="/admin/analytics/{{snake}}", tags=["admin-analytics"])


@router.get("/summary")
def get_{{snake}}_summary() -> dict:
    return build_{{snake}}_summary()


# --- {{test_file}} ---
from __future__ import annotations

from app.services.{{snake}} import build_{{snake}}_summary


def test_{{snake}}_summary_shape() -> None:
    payload = build_{{snake}}_summary()
    assert payload["ticket"] == "{{ticket_id}}"
    assert isinstance(payload["rows"], list)
