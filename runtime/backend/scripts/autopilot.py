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
import os
from pathlib import Path
from typing import Any


REPO_ROOT = Path(os.environ.get("PROJECT_ROOT", str(Path(__file__).resolve().parents[2]))).expanduser().resolve()
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.agent.core.config_loader import load_project_config
from backend.agent.core.training_service import build_training_command
from backend.agent.runtime import runtime_api
from backend.scripts.solo_dev_assistant_config import SELF_IMPROVEMENT_AUTONOMY_MODES


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
ROOT = REPO_ROOT
CFG_PATH = ROOT / "dev_assistant.yaml"


def load_cfg() -> dict[str, Any]:
    return load_project_config(ROOT)


def _cfg_bool(cfg: dict[str, Any], key: str, default: bool = False) -> bool:
    value = cfg.get(key, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _cfg_int(cfg: dict[str, Any], key: str, default: int) -> int:
    try:
        return int(cfg.get(key, default) or default)
    except (TypeError, ValueError):
        return default


def _solo_script_cmd(*parts: str) -> list[str]:
    return [sys.executable, str(ROOT / "backend" / "scripts" / "solo_dev_assistant.py"), *parts]


def _train_script_cmd(cfg: dict[str, Any] | None = None) -> list[str]:
    cfg = cfg or load_cfg()
    return build_training_command(
        ROOT,
        openai=_cfg_bool(cfg, "assistant_training_openai", False),
        fine_tune_model=str(cfg.get("assistant_training_fine_tune_model") or "").strip() or None,
        min_examples=int(cfg.get("assistant_training_min_examples", 2) or 2),
        min_log_examples=int(cfg.get("assistant_training_min_log_examples", 1) or 1),
        min_artifact_examples=int(cfg.get("assistant_training_min_artifact_examples", 1) or 1),
        fail_on_quality_gate=_cfg_bool(cfg, "assistant_training_fail_on_quality_gate", False),
    )


def _analyze_script_cmd() -> list[str]:
    return [
        sys.executable,
        str(ROOT / "backend" / "scripts" / "analyze_dev_assistant_log.py"),
        "--write-report",
    ]


def _difficulty_rank(value: Any) -> int:
    levels = ("low", "medium", "high")
    normalized = str(value or "low").strip().lower() or "low"
    try:
        return levels.index(normalized)
    except ValueError:
        return 0


def _self_improvement_enabled(cfg: dict[str, Any]) -> bool:
    mode = str(cfg.get("assistant_autonomy_mode") or "").strip().lower()
    return mode in SELF_IMPROVEMENT_AUTONOMY_MODES or _cfg_bool(cfg, "autopilot_self_improve", False)


def _max_self_improvement_difficulty(cfg: dict[str, Any]) -> str:
    value = str(cfg.get("autopilot_self_improve_max_difficulty") or "low").strip().lower() or "low"
    return value if value in {"low", "medium", "high"} else "low"


def _pick_prepared_self_improvement_task(prepared_tasks: list[dict[str, Any]], max_difficulty: str) -> dict[str, Any]:
    allowed_rank = _difficulty_rank(max_difficulty)
    ordered = sorted(
        [dict(item) for item in list(prepared_tasks or []) if isinstance(item, dict)],
        key=lambda item: (
            _difficulty_rank((item.get("metadata") or {}).get("difficulty")),
            str(item.get("title") or ""),
        ),
    )
    for task in ordered:
        if _difficulty_rank((task.get("metadata") or {}).get("difficulty")) <= allowed_rank:
            return task
    return {}


def _run_prepared_self_improvement(cfg: dict[str, Any]) -> dict[str, Any]:
    if not _self_improvement_enabled(cfg):
        return {"enabled": False, "executed": False, "reason": "disabled"}
    queue_limit = max(1, _cfg_int(cfg, "autopilot_self_improve_limit", 8))
    history_limit = max(8, _cfg_int(cfg, "autopilot_self_improve_history_limit", 40))
    max_difficulty = _max_self_improvement_difficulty(cfg)
    try:
        summary = runtime_api.summarize_self_improvement({"limit": queue_limit, "historyLimit": history_limit})
    except Exception as exc:
        print(f"autopilot: self-improvement summary failed ({exc})")
        return {"enabled": True, "executed": False, "reason": "summary-failed"}
    prepared_tasks = [dict(item) for item in list(summary.get("preparedTasks") or summary.get("prepared_tasks") or []) if isinstance(item, dict)]
    selected = _pick_prepared_self_improvement_task(prepared_tasks, max_difficulty)
    if not selected:
        print(f"autopilot: no prepared self-improvement tasks fit the {max_difficulty} difficulty budget")
        return {"enabled": True, "executed": False, "reason": "no-prepared-task", "summary": summary}
    task_id = str(selected.get("task_id") or selected.get("taskId") or "").strip()
    label = str(selected.get("title") or task_id or "self-improvement task")
    print(f"autopilot: executing self-improvement slice {label}")
    try:
        result = runtime_api.execute_self_improvement_task({
            "taskId": task_id,
            "limit": queue_limit,
            "historyLimit": history_limit,
        })
    except Exception as exc:
        print(f"autopilot: self-improvement execution failed ({exc})")
        return {"enabled": True, "executed": False, "reason": "execution-failed", "taskId": task_id}
    status = str(result.get("status") or "").strip().lower()
    ok = bool(result.get("ok", False)) or status == "review"
    print(
        "autopilot: self-improvement result",
        label,
        f"status={status or 'unknown'}",
        f"ok={'yes' if ok else 'no'}",
    )
    return {
        "enabled": True,
        "executed": True,
        "ok": ok,
        "status": status,
        "taskId": task_id,
        "result": result,
    }


def _run_closed_learn_loop(cfg: dict[str, Any]) -> None:
    analyze_cmd = _analyze_script_cmd()
    print("autopilot: analyzing assistant logs", " ".join(analyze_cmd))
    analyze_result = subprocess.run(analyze_cmd, cwd=str(ROOT))
    if analyze_result.returncode != 0:
        print(f"autopilot: analyze-log failed ({analyze_result.returncode}); skipping training")
        return

    train_cmd = _train_script_cmd(cfg)
    print("autopilot: training assistant", " ".join(train_cmd))
    train_result = subprocess.run(train_cmd, cwd=str(ROOT))
    if train_result.returncode != 0:
        print(f"autopilot: training exited with status {train_result.returncode}")


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
    self_mode = str(cfg.get("assistant_autonomy_mode") or "").strip().lower() in {"self", "self-improve", "self-only", "assistant"}
    if require_tag:
        cmd.extend(["--require-tag", require_tag])

    require_text = str(cfg.get("autopilot_require_text") or "").strip()
    if require_text:
        cmd.extend(["--require-text", require_text])

    prefer_domain = str(cfg.get("autopilot_prefer_domain") or "").strip().lower()
    if self_mode and prefer_domain in {"", "dispatch", "pricing", "tracking", "payments", "marketplace"}:
        prefer_domain = "assistant_runtime"
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
    if _cfg_bool(cfg, "autopilot_synthesize_followups", True):
        cmd.append("--synthesize-followups")
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
    if _cfg_bool(cfg, "autopilot_refresh_engine", True):
        refresh_cmd = _solo_script_cmd("engine-refresh")
        print("autopilot: refreshing engine", " ".join(refresh_cmd))
        subprocess.run(refresh_cmd, cwd=str(ROOT))

    self_improvement = _run_prepared_self_improvement(cfg)
    if self_improvement.get("executed"):
        if _cfg_bool(cfg, "autopilot_auto_train", False) and self_improvement.get("ok"):
            _run_closed_learn_loop(cfg)
        return

    cmd = _build_autopilot_cmd(cfg, cron_expr)
    print("autopilot: invoking", " ".join(cmd))
    result = subprocess.run(cmd, cwd=str(ROOT))

    if _cfg_bool(cfg, "autopilot_auto_train", False) and result.returncode == 0:
        _run_closed_learn_loop(cfg)


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
    scheduler = BlockingScheduler()
    try:
        interval_seconds = int(cfg.get("autopilot_interval_seconds") or 0)
    except (TypeError, ValueError):
        interval_seconds = 0

    if interval_seconds > 0:
        print(f"autopilot interval loop enabled -> every {interval_seconds}s")
        scheduler.add_job(
            lambda: run_autopilot(f"interval:{interval_seconds}s"),
            'interval',
            seconds=interval_seconds,
            id='interval_loop',
            max_instances=1,
            coalesce=True,
        )
        print("autopilot: running once immediately on scheduler start")
        run_autopilot(f"interval:{interval_seconds}s:startup")
    else:
        jobs = cfg.get("autopilot_jobs") or []
        if not isinstance(jobs, list):
            print("no autopilot_jobs configured in dev_assistant.yaml")
            return
        enabled_jobs = [job for job in jobs if isinstance(job, dict) and _cfg_bool(job, "enabled", False)]
        if not enabled_jobs:
            print("no enabled autopilot_jobs configured in dev_assistant.yaml")
            return
        for job in enabled_jobs:
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
