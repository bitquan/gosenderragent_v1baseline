#!/usr/bin/env python3
"""Simple scheduler that runs GoSenderr assistant jobs on cron schedules.

Configuration is read from dev_assistant.yaml at project root. Example:

```yaml
autopilot_jobs:
  - name: every_5_minutes
    cron: "*/5 * * * *"
  - name: nightly
    cron: "0 2 * * *"
```

This script uses APScheduler to schedule jobs.

Default behavior (recommended):
  Executes solo assistant sprint mode for audit-first/task-aware runs:
  `python backend/scripts/solo_dev_assistant.py sprint ...`

Legacy behavior:
  Set `autopilot_runner: legacy` in `dev_assistant.yaml` to run:
  `python backend/scripts/dev_assistant.py --autopilot`
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Any


# scheduler imports are delayed so the module can be imported during tests even if
# APScheduler isn't installed.  main() will bail out if dependencies are missing.

BlockingScheduler = None
CronTrigger = None

def _load_scheduler():
    global BlockingScheduler, CronTrigger
    try:
        from apscheduler.schedulers.blocking import BlockingScheduler as _BS
        from apscheduler.triggers.cron import CronTrigger as _CT
        BlockingScheduler = _BS
        CronTrigger = _CT
        return True
    except ImportError:
        print("APScheduler required. install with `pip install apscheduler`")
        return False


# when invoked from backend/scripts, the repo root is two levels up
ROOT = Path(__file__).resolve().parents[2]
CFG_PATH = ROOT / "dev_assistant.yaml"


def load_cfg() -> dict[str, Any]:
    if CFG_PATH.exists():
        try:
            import yaml  # type: ignore
        except ImportError:
            return {}
        try:
            with open(CFG_PATH, encoding="utf-8") as f:
                return yaml.safe_load(f) or {}
        except Exception:
            return {}
    return {}


def _cfg_bool(cfg: dict[str, Any], key: str, default: bool = False) -> bool:
    value = cfg.get(key, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _build_autopilot_cmd(cfg: dict[str, Any], cron_expr: str | None = None) -> list[str]:
    runner = str(cfg.get("autopilot_runner") or "solo").strip().lower()
    if runner in {"legacy", "dev_assistant", "v1"}:
        cmd = [sys.executable, str(ROOT / "backend" / "scripts" / "dev_assistant.py"), "--autopilot"]
        if cron_expr:
            cmd.extend(["--schedule", cron_expr])
        return cmd

    action = str(cfg.get("autopilot_action") or "implement").strip().lower()
    if action not in {"run", "implement"}:
        action = "implement"
    try:
        count_value = int(cfg.get("autopilot_count") or 1)
    except (TypeError, ValueError):
        count_value = 1
    count = max(1, count_value)
    try:
        cooldown_value = int(cfg.get("autopilot_ticket_cooldown_minutes") or 30)
    except (TypeError, ValueError):
        cooldown_value = 30
    cooldown_minutes = max(0, cooldown_value)
    status = str(cfg.get("autopilot_status") or "TODO").strip() or "TODO"
    profile = str(cfg.get("autopilot_profile") or ("aiWrite" if action == "implement" else "aiWrite")).strip()
    if action == "implement" and profile == "preview":
        profile = "aiWrite"
    template = str(cfg.get("autopilot_template") or "auto").strip() or "auto"

    cmd = [
        sys.executable,
        str(ROOT / "backend" / "scripts" / "solo_dev_assistant.py"),
        "sprint",
        "--action",
        action,
        "--count",
        str(count),
        "--status",
        status,
        "--profile",
        profile,
        "--template",
        template,
        "--cooldown-minutes",
        str(cooldown_minutes),
    ]

    require_tag = str(cfg.get("autopilot_require_tag") or "").strip()
    if require_tag:
        cmd.extend(["--require-tag", require_tag])

    require_text = str(cfg.get("autopilot_require_text") or "").strip()
    if require_text:
        cmd.extend(["--require-text", require_text])

    prefer_domain = str(cfg.get("autopilot_prefer_domain") or "").strip().lower()
    if prefer_domain:
        cmd.extend(["--prefer-domain", prefer_domain])

    if _cfg_bool(cfg, "autopilot_brainstorm", False):
        cmd.append("--brainstorm")
    if _cfg_bool(cfg, "autopilot_full_verify", False):
        cmd.append("--full-verify")
    if _cfg_bool(cfg, "autopilot_skip_verify", False):
        cmd.append("--skip-verify")
    if _cfg_bool(cfg, "autopilot_skip_preflight", False):
        cmd.append("--skip-preflight")
    if _cfg_bool(cfg, "autopilot_fix_loop", True):
        cmd.append("--fix-loop")
    if _cfg_bool(cfg, "autopilot_continue_on_fail", True):
        cmd.append("--continue-on-fail")
    if _cfg_bool(cfg, "autopilot_skip_learn", False):
        cmd.append("--skip-learn")
    if _cfg_bool(cfg, "assistant_safe_mode", False):
        cmd.append("--safe-mode")
    try:
        safe_max_files = int(cfg.get("assistant_safe_max_files") or 0)
    except (TypeError, ValueError):
        safe_max_files = 0
    if safe_max_files > 0:
        cmd.extend(["--safe-max-files", str(safe_max_files)])
    if _cfg_bool(cfg, "assistant_safe_allow_protected", False):
        cmd.append("--allow-protected")
    if _cfg_bool(cfg, "assistant_safe_allow_ship", False):
        cmd.append("--allow-ship-in-safe-mode")
    if _cfg_bool(cfg, "assistant_safe_prepare_sandbox", False):
        cmd.append("--prepare-sandbox")
    sandbox_dir = str(cfg.get("assistant_sandbox_dir") or "").strip()
    if sandbox_dir:
        cmd.extend(["--sandbox-dir", sandbox_dir])
    if cron_expr:
        cmd.extend(["--brainstorm-notes", f"scheduled:{cron_expr}"])
    return cmd


def run_autopilot(cron_expr: str | None = None):
    cfg = load_cfg()
    cmd = _build_autopilot_cmd(cfg, cron_expr)
    print("autopilot: invoking", " ".join(cmd))
    subprocess.run(cmd, cwd=str(ROOT))


def parse_cron(expr: str) -> dict[str, str]:
    # simple 5-field cron (minute hour day month weekday)
    parts = expr.strip().split()
    if len(parts) != 5:
        raise ValueError(f"invalid cron expression: {expr}")
    return {
        "minute": parts[0],
        "hour": parts[1],
        "day": parts[2],
        "month": parts[3],
        "day_of_week": parts[4],
    }


def main() -> None:
    # ensure scheduler library is available before doing anything
    if not _load_scheduler():
        sys.exit(1)

    cfg = load_cfg()
    jobs = cfg.get("autopilot_jobs") or []
    if not isinstance(jobs, list):
        print("no autopilot_jobs configured in dev_assistant.yaml")
        return
    scheduler = BlockingScheduler()
    for job in jobs:
        name = job.get("name") or "unnamed"
        cron = job.get("cron")
        if not cron:
            continue
        try:
            trigger_args = parse_cron(cron)
        except Exception as e:
            print(f"skipping job {name}: {e}")
            continue
        # schedule run_autopilot with the cron expression so the CLI can log it
        scheduler.add_job(lambda expr=cron: run_autopilot(expr), CronTrigger(**trigger_args), id=name)
        print(f"scheduled job '{name}' -> {cron}")

    try:
        print("Starting autopilot scheduler (Ctrl-C to stop)")
        scheduler.start()
    except KeyboardInterrupt:
        print("stopping autopilot")


if __name__ == "__main__":
    main()
