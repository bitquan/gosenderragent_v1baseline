from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def _parse_iso(value: Any) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def build_stage_speed_summary(
    *,
    runtime_events: list[dict[str, Any]] | None = None,
    started_at: str = "",
    finished_at: str = "",
) -> dict[str, Any]:
    stage_entries: list[tuple[str, datetime]] = []
    seen: set[tuple[str, str]] = set()
    for item in list(runtime_events or []):
        if not isinstance(item, dict):
            continue
        if str(item.get("event") or "") != "state-transition":
            continue
        stage = str(item.get("stage") or "runtime").strip() or "runtime"
        moment = _parse_iso(item.get("timestamp"))
        if moment is None:
            continue
        marker = (stage, moment.isoformat())
        if marker in seen:
            continue
        seen.add(marker)
        stage_entries.append((stage, moment))
    stage_entries.sort(key=lambda item: item[1])
    finished = _parse_iso(finished_at)
    rows: list[dict[str, Any]] = []
    for index, (stage, entered_at) in enumerate(stage_entries):
        next_timestamp = stage_entries[index + 1][1] if index + 1 < len(stage_entries) else finished
        duration_seconds = None
        if next_timestamp is not None:
            delta = (next_timestamp - entered_at).total_seconds()
            if delta >= 0:
                duration_seconds = float(delta)
        rows.append(
            {
                "stage": stage,
                "entered_at": entered_at.isoformat(),
                "duration_seconds": duration_seconds,
            }
        )
    measured = [float(item.get("duration_seconds")) for item in rows if item.get("duration_seconds") is not None]
    slowest = max(rows, key=lambda item: float(item.get("duration_seconds") or -1.0)) if rows else {}
    return {
        "stage_count": len(rows),
        "stages": rows,
        "total_measured_seconds": sum(measured) if measured else 0.0,
        "slowest_stage": {
            "stage": str(slowest.get("stage") or ""),
            "duration_seconds": slowest.get("duration_seconds"),
        } if slowest else {},
        "summary": (
            f"{len(rows)} stage timing row(s) captured; slowest stage: {slowest.get('stage', 'unknown')}"
            if rows
            else "no stage timing rows captured"
        ),
    }