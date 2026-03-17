from __future__ import annotations

from collections import Counter
from typing import Any


def _normalize_path(value: Any) -> str:
    raw = str(value or "").strip().replace("\\", "/")
    while raw.startswith("./"):
        raw = raw[2:]
    return raw


def build_run_duplicate_summary(
    *,
    execution: dict[str, Any] | None = None,
    repair: dict[str, Any] | None = None,
) -> dict[str, Any]:
    touch_points: list[tuple[str, str]] = []
    for item in list((execution or {}).get("results", []) or []):
        if not isinstance(item, dict):
            continue
        path = _normalize_path(item.get("path"))
        if path:
            touch_points.append((path, "execution-result"))
    for item in list((execution or {}).get("created", []) or []):
        path = _normalize_path(item)
        if path:
            touch_points.append((path, "execution-created"))
    for item in list((repair or {}).get("repairs", []) or []):
        if not isinstance(item, dict):
            continue
        path = _normalize_path(item.get("path"))
        if path:
            touch_points.append((path, "repair"))

    path_counter = Counter(path for path, _source in touch_points)
    duplicate_paths = [path for path, count in path_counter.items() if count > 1]
    duplicate_rows = [
        {
            "path": path,
            "count": int(path_counter[path]),
            "sources": [source for candidate_path, source in touch_points if candidate_path == path],
        }
        for path in sorted(duplicate_paths)
    ]
    total_touches = len(touch_points)
    duplicate_touch_count = sum(max(0, int(path_counter[path]) - 1) for path in duplicate_paths)
    duplicate_edit_rate = (float(duplicate_touch_count) / float(total_touches)) if total_touches else 0.0
    return {
        "touch_count": total_touches,
        "unique_path_count": len(path_counter),
        "duplicate_path_count": len(duplicate_paths),
        "duplicate_touch_count": duplicate_touch_count,
        "duplicate_edit_rate": duplicate_edit_rate,
        "paths": duplicate_rows,
        "summary": (
            f"{len(duplicate_paths)} duplicate path(s) detected across {total_touches} touch(es)"
            if duplicate_paths
            else "no duplicate paths detected in current run touches"
        ),
    }