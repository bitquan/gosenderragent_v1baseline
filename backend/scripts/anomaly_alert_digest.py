#!/usr/bin/env python
from __future__ import annotations

import json
import os
import sys

from app.db.session import SessionLocal
from app.services.anomaly_alerts import dispatch_token_anomaly_digest


def main() -> int:
    force = os.getenv("ANOMALY_ALERT_FORCE", "").strip().lower() in {"1", "true", "yes"}
    with SessionLocal() as db:
        payload = dispatch_token_anomaly_digest(db, force=force)
        db.commit()
    print(json.dumps(payload, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
