from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable


def resolve_sandbox_base_dir(repo_root: Path, sandbox_dir: str) -> Path:
    candidate = Path(sandbox_dir).expanduser()
    if not candidate.is_absolute():
        candidate = (repo_root.parent / candidate).resolve()
    else:
        candidate = candidate.resolve()

    resolved_repo_root = repo_root.resolve()
    if candidate == resolved_repo_root or resolved_repo_root in candidate.parents:
        candidate = (resolved_repo_root.parent / candidate.name).resolve()
    return candidate


def managed_sandbox_base_dirs(repo_root: Path, sandbox_root: Path, sandbox_dir: str | None = None) -> list[Path]:
    configured = resolve_sandbox_base_dir(repo_root, sandbox_dir or str(sandbox_root))
    legacy = (repo_root / Path(sandbox_dir or str(sandbox_root)).name).resolve()
    paths: list[Path] = []
    for path in (configured, legacy):
        if path not in paths:
            paths.append(path)
    return paths


def load_sandbox_metadata(path: Path) -> dict[str, Any]:
    metadata_path = path / ".assistant_sandbox.json"
    if not metadata_path.exists():
        return {}
    try:
        data = json.loads(metadata_path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def sandbox_generated_at(metadata: dict[str, Any], *, datetime_cls: Any = datetime) -> datetime | None:
    raw = metadata.get("generated_at")
    if not raw:
        return None
    try:
        return datetime_cls.fromisoformat(str(raw).replace("Z", "+00:00"))
    except Exception:
        return None


def list_sandbox_dirs(base_dir: Path) -> list[Path]:
    if not base_dir.exists():
        return []
    return sorted(path for path in base_dir.iterdir() if path.is_dir())


def sandbox_is_dirty(path: Path, *, run_cmd: Callable[..., Any]) -> bool:
    result = run_cmd(["git", "-C", str(path), "status", "--porcelain"], capture=True)
    if result.returncode != 0:
        return True
    return bool(result.stdout.strip())


def cleanup_stale_sandboxes(
    base_dir: Path,
    *,
    run_cmd: Callable[..., Any],
    now: datetime | None = None,
    stale_after_hours: int = 24,
    datetime_cls: Any = datetime,
    timezone_value: Any = timezone,
) -> list[str]:
    current = now or datetime_cls.now(timezone_value.utc)
    removed: list[str] = []
    for path in list_sandbox_dirs(base_dir):
        metadata = load_sandbox_metadata(path)
        generated_at = sandbox_generated_at(metadata, datetime_cls=datetime_cls)
        if generated_at is None:
            continue
        age = current - generated_at.astimezone(timezone_value.utc)
        if age < timedelta(hours=stale_after_hours):
            continue
        result = run_cmd(["git", "worktree", "remove", "--force", str(path)], capture=True)
        if result.returncode == 0:
            removed.append(str(path))
    run_cmd(["git", "worktree", "prune"], capture=True)
    return removed


def find_reusable_sandbox(
    base_dir: Path,
    ticket_id: str,
    *,
    repo_root: Path,
    now: datetime | None = None,
    reuse_after_hours: int = 12,
    datetime_cls: Any = datetime,
    timezone_value: Any = timezone,
) -> Path | None:
    current = now or datetime_cls.now(timezone_value.utc)
    candidates: list[tuple[datetime, Path]] = []
    for path in list_sandbox_dirs(base_dir):
        metadata = load_sandbox_metadata(path)
        if str(metadata.get("ticket") or "") != str(ticket_id):
            continue
        if str(metadata.get("source_repo") or "") != str(repo_root):
            continue
        generated_at = sandbox_generated_at(metadata, datetime_cls=datetime_cls)
        if generated_at is None:
            continue
        age = current - generated_at.astimezone(timezone_value.utc)
        if age > timedelta(hours=reuse_after_hours):
            continue
        candidates.append((generated_at, path))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def sandbox_status_rows(
    base_dir: Path,
    *,
    run_cmd: Callable[..., Any],
    now: datetime | None = None,
    reuse_after_hours: int = 12,
    stale_after_hours: int = 24,
    datetime_cls: Any = datetime,
    timezone_value: Any = timezone,
) -> list[dict[str, Any]]:
    current = now or datetime_cls.now(timezone_value.utc)
    rows: list[dict[str, Any]] = []
    for path in list_sandbox_dirs(base_dir):
        metadata = load_sandbox_metadata(path)
        generated_at = sandbox_generated_at(metadata, datetime_cls=datetime_cls)
        age_hours: float | None = None
        reusable = False
        stale = False
        if generated_at is not None:
            age = current - generated_at.astimezone(timezone_value.utc)
            age_hours = round(age.total_seconds() / 3600, 2)
            reusable = age <= timedelta(hours=reuse_after_hours)
            stale = age > timedelta(hours=stale_after_hours)
        rows.append(
            {
                "base_dir": str(base_dir),
                "path": str(path),
                "name": path.name,
                "ticket": str(metadata.get("ticket") or ""),
                "generated_at": metadata.get("generated_at"),
                "source_repo": str(metadata.get("source_repo") or ""),
                "age_hours": age_hours,
                "reusable": reusable,
                "stale": stale,
                "has_metadata": bool(metadata),
                "dirty": sandbox_is_dirty(path, run_cmd=run_cmd),
            }
        )
    rows.sort(key=lambda row: (row.get("ticket", ""), row.get("name", "")))
    return rows


def collect_sandbox_status_rows(
    base_dirs: list[Path],
    *,
    sandbox_status_rows_fn: Callable[..., list[dict[str, Any]]],
    now: datetime | None = None,
    reuse_after_hours: int = 12,
    stale_after_hours: int = 24,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for base_dir in base_dirs:
        rows.extend(sandbox_status_rows_fn(base_dir, now=now, reuse_after_hours=reuse_after_hours, stale_after_hours=stale_after_hours))
    rows.sort(key=lambda row: (str(row.get("ticket") or ""), str(row.get("name") or "")))
    return rows


def cleanup_sandbox_rows(
    rows: list[dict[str, Any]],
    *,
    run_cmd: Callable[..., Any],
    remove_all: bool = False,
    ticket_id: str | None = None,
    allow_dirty: bool = False,
) -> dict[str, list[dict[str, Any]]]:
    removed: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    target_ticket = str(ticket_id or "")

    for row in rows:
        if target_ticket and str(row.get("ticket") or "") != target_ticket:
            continue
        if not row.get("has_metadata"):
            skipped.append({"path": row["path"], "reason": "missing metadata"})
            continue
        if row.get("dirty") and not allow_dirty:
            skipped.append({"path": row["path"], "reason": "dirty worktree"})
            continue
        if not remove_all and not row.get("stale"):
            skipped.append({"path": row["path"], "reason": "not stale"})
            continue
        result = run_cmd(["git", "worktree", "remove", "--force", str(row["path"])], capture=True)
        if result.returncode == 0:
            removed.append({"path": row["path"], "ticket": row.get("ticket") or "", "dirty": bool(row.get("dirty"))})
        else:
            skipped.append({
                "path": row["path"],
                "reason": result.stderr.strip() or result.stdout.strip() or "remove failed",
            })

    run_cmd(["git", "worktree", "prune"], capture=True)
    return {"removed": removed, "skipped": skipped}


def trim_sandbox_pool(
    base_dir: Path,
    *,
    run_cmd: Callable[..., Any],
    sandbox_status_rows_fn: Callable[..., list[dict[str, Any]]],
    max_active: int,
) -> list[str]:
    if max_active <= 0:
        return []
    rows = sandbox_status_rows_fn(base_dir, reuse_after_hours=0, stale_after_hours=10_000)
    if len(rows) < max_active:
        return []

    removable = [row for row in rows if row.get("has_metadata") and not row.get("dirty")]
    removable.sort(key=lambda row: float(row.get("age_hours") or 0), reverse=True)
    active_count = len(rows)
    removed: list[str] = []
    for row in removable:
        if active_count < max_active:
            break
        result = run_cmd(["git", "worktree", "remove", "--force", str(row["path"])], capture=True)
        if result.returncode == 0:
            removed.append(str(row["path"]))
            active_count -= 1
    run_cmd(["git", "worktree", "prune"], capture=True)
    return removed


def prepare_sandbox(
    ticket_id: str,
    sandbox_dir: str,
    *,
    repo_root: Path,
    sandbox_root: Path,
    load_root_cfg_fn: Callable[[], dict[str, Any]],
    cfg_int_fn: Callable[[dict[str, Any], str, int], int],
    run_cmd: Callable[..., Any],
    datetime_cls: Any = datetime,
    timezone_value: Any = timezone,
    cleanup_stale_sandboxes_fn: Callable[..., list[str]],
    find_reusable_sandbox_fn: Callable[..., Path | None],
    trim_sandbox_pool_fn: Callable[..., list[str]],
    resolve_sandbox_base_dir_fn: Callable[[str], Path],
) -> dict[str, Any]:
    del sandbox_root
    base_dir = resolve_sandbox_base_dir_fn(sandbox_dir)
    base_dir.mkdir(parents=True, exist_ok=True)
    cfg = load_root_cfg_fn()
    reuse_after_hours = max(0, cfg_int_fn(cfg, "assistant_sandbox_reuse_hours", 12))
    stale_after_hours = max(1, cfg_int_fn(cfg, "assistant_sandbox_stale_hours", 24))
    max_active = max(0, cfg_int_fn(cfg, "assistant_sandbox_max_active", 0))
    cleaned = cleanup_stale_sandboxes_fn(base_dir, stale_after_hours=stale_after_hours)
    reusable = find_reusable_sandbox_fn(base_dir, ticket_id, reuse_after_hours=reuse_after_hours)
    if reusable is not None:
        return {
            "path": str(reusable),
            "base_dir": str(base_dir),
            "requested_dir": sandbox_dir,
            "ok": True,
            "stdout": "reused existing sandbox",
            "stderr": "",
            "reused": True,
            "cleaned": cleaned,
            "trimmed": [],
        }
    trimmed = trim_sandbox_pool_fn(base_dir, max_active=max(1, max_active) - 1) if max_active else []
    stamp = datetime_cls.now(timezone_value.utc).strftime("%Y%m%dT%H%M%SZ")
    target = base_dir / f"bat{ticket_id}-{stamp}"
    result = run_cmd(["git", "worktree", "add", "--detach", str(target), "HEAD"], capture=True)
    payload = {
        "path": str(target),
        "base_dir": str(base_dir),
        "requested_dir": sandbox_dir,
        "ok": result.returncode == 0,
        "stdout": result.stdout.strip(),
        "stderr": result.stderr.strip(),
        "reused": False,
        "cleaned": cleaned,
        "trimmed": trimmed,
    }
    if result.returncode == 0:
        metadata = target / ".assistant_sandbox.json"
        metadata.write_text(json.dumps({
            "ticket": ticket_id,
            "generated_at": datetime_cls.now(timezone_value.utc).isoformat(),
            "source_repo": str(repo_root),
        }, indent=2) + "\n", encoding="utf-8")
    return payload


def finalize_sandbox(
    sandbox: dict[str, Any] | None,
    *,
    run_cmd: Callable[..., Any],
    sandbox_is_dirty_fn: Callable[[Path], bool],
    load_sandbox_metadata_fn: Callable[[Path], dict[str, Any]],
    cleanup_sandbox_rows_fn: Callable[..., dict[str, list[dict[str, Any]]]],
) -> dict[str, Any]:
    del run_cmd
    if not isinstance(sandbox, dict) or not sandbox.get("ok"):
        return {"attempted": False, "reason": "no-sandbox"}
    path_value = str(sandbox.get("path") or "").strip()
    if not path_value:
        return {"attempted": False, "reason": "missing-path"}
    path = Path(path_value)
    if not path.exists():
        return {"attempted": False, "reason": "missing-on-disk", "path": path_value}
    metadata = load_sandbox_metadata_fn(path)
    result = cleanup_sandbox_rows_fn(
        [
            {
                "path": path_value,
                "ticket": str(metadata.get("ticket") or ""),
                "has_metadata": bool(metadata),
                "stale": True,
                "dirty": sandbox_is_dirty_fn(path),
            }
        ],
        remove_all=True,
        allow_dirty=False,
    )
    return {
        "attempted": True,
        "path": path_value,
        "removed": bool(result.get("removed")),
        "skipped": list(result.get("skipped") or []),
    }