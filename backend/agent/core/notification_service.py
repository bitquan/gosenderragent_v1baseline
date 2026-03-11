from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def send_notification(project_root: Path, url: str, payload: dict[str, Any]) -> dict[str, Any]:
    log_path = project_root / "notifications.log"
    logged = False
    sent = False
    error = ""
    try:
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"url": url, "payload": payload}) + "\n")
        logged = True
    except Exception as exc:
        error = str(exc)

    try:
        import requests

        requests.post(url, json=payload, timeout=5)
        sent = True
    except Exception as exc:
        if not error:
            error = str(exc)

    return {
        "url": url,
        "payload": payload,
        "logged": logged,
        "sent": sent,
        "ok": logged or sent,
        "error": error,
    }


def send_slack_webhook(project_root: Path, url: str, message: str) -> dict[str, Any]:
    return send_notification(project_root, url, {"text": message})