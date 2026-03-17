# --- {{model_file}} ---
"""Security policy model for BAT<{{ticket_id}}>."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class {{component_name}}Policy:
    max_attempts: int = 5
    lock_window_seconds: int = 900
    audit_event: str = "{{snake}}_guardrail_triggered"


# --- {{service_file}} ---
"""Security helper service for BAT<{{ticket_id}}>."""
from __future__ import annotations

import re

from app.models.{{snake}} import {{component_name}}Policy

PHONE_RE = re.compile(r"\+?\d[\d\-\s]{7,}\d")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def redact_contact_tokens(text: str) -> str:
    scrubbed = PHONE_RE.sub("[redacted-phone]", text)
    scrubbed = EMAIL_RE.sub("[redacted-email]", scrubbed)
    return scrubbed


def security_policy_snapshot() -> dict:
    policy = {{component_name}}Policy()
    return {
        "max_attempts": policy.max_attempts,
        "lock_window_seconds": policy.lock_window_seconds,
        "audit_event": policy.audit_event,
    }


# --- {{route_file}} ---
from __future__ import annotations

from fastapi import APIRouter

from app.services.{{snake}} import security_policy_snapshot

router = APIRouter(prefix="/security/{{snake}}", tags=["security"])


@router.get("/policy")
def get_policy() -> dict:
    return security_policy_snapshot()


# --- {{test_file}} ---
from __future__ import annotations

from app.services.{{snake}} import redact_contact_tokens, security_policy_snapshot


def test_redact_contact_tokens_masks_email_and_phone() -> None:
    text = "reach me at alice@example.com or +1 555 333 9999"
    scrubbed = redact_contact_tokens(text)
    assert "[redacted-email]" in scrubbed
    assert "[redacted-phone]" in scrubbed


def test_security_policy_snapshot_shape() -> None:
    payload = security_policy_snapshot()
    assert payload["max_attempts"] > 0
