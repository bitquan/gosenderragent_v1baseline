from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from backend.agent.core.config_loader import load_project_config


def _load_cfg(project_root: Path) -> dict[str, Any]:
    return load_project_config(project_root)


def _resolve_path(project_root: Path, raw_value: str | Path | None, default: Path) -> Path:
    if raw_value is None:
        return default
    text = str(raw_value).strip()
    if not text:
        return default
    candidate = Path(text).expanduser()
    if candidate.is_absolute():
        return candidate
    return (project_root / candidate).resolve()


def _cfg_or_env_path(project_root: Path, *, env_key: str, cfg_key: str) -> Path | None:
    env_value = os.environ.get(env_key)
    if env_value and env_value.strip():
        return _resolve_path(project_root, env_value, project_root)
    cfg_value = _load_cfg(project_root).get(cfg_key)
    if cfg_value is None or not str(cfg_value).strip():
        return None
    return _resolve_path(project_root, cfg_value, project_root)


def assistant_artifacts_root(project_root: Path) -> Path | None:
    return _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_ARTIFACT_ROOT",
        cfg_key="assistant_artifacts_root",
    )


def assistant_runs_dir(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_RUNS_DIR",
        cfg_key="assistant_runs_dir",
    )
    if explicit is not None:
        return explicit
    root = assistant_artifacts_root(project_root)
    if root is not None:
        return root / "assistant_runs"
    return project_root / "docs" / "assistant_runs"


def assistant_sandbox_dir(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_SANDBOX_DIR",
        cfg_key="assistant_sandbox_dir",
    )
    if explicit is not None:
        return explicit
    root = assistant_artifacts_root(project_root)
    if root is not None:
        return root / "assistant_sandboxes"
    return project_root / ".assistant_sandboxes"


def assistant_dev_data_dir(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_DEV_DATA_DIR",
        cfg_key="assistant_dev_data_dir",
    )
    if explicit is not None:
        return explicit
    root = assistant_artifacts_root(project_root)
    if root is not None:
        return root / "dev_data"
    return project_root


def assistant_dev_runs_dir(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_DEV_RUNS_DIR",
        cfg_key="assistant_dev_runs_dir",
    )
    if explicit is not None:
        return explicit
    data_dir = assistant_dev_data_dir(project_root)
    if data_dir == project_root:
        return project_root / ".dev_agent_runs"
    return data_dir / ".dev_agent_runs"


def assistant_repo_index_path(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_REPO_INDEX_PATH",
        cfg_key="assistant_repo_index_path",
    )
    if explicit is not None:
        return explicit
    data_dir = assistant_dev_data_dir(project_root)
    return (data_dir if data_dir != project_root else project_root) / "repo_index.json"


def assistant_memory_path(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_MEMORY_PATH",
        cfg_key="assistant_memory_path",
    )
    if explicit is not None:
        return explicit
    data_dir = assistant_dev_data_dir(project_root)
    return (data_dir if data_dir != project_root else project_root) / "dev_assistant_memory.json"


def assistant_notification_log_path(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_NOTIFICATION_LOG_PATH",
        cfg_key="assistant_notification_log_path",
    )
    if explicit is not None:
        return explicit
    data_dir = assistant_dev_data_dir(project_root)
    return (data_dir if data_dir != project_root else project_root) / "notifications.log"


def assistant_log_path(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_LOG_PATH",
        cfg_key="assistant_log_path",
    )
    if explicit is not None:
        return explicit
    data_dir = assistant_dev_data_dir(project_root)
    return (data_dir if data_dir != project_root else project_root / "backend" / "scripts") / "dev_assistant.log"


def assistant_log_report_path(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_LOG_REPORT_PATH",
        cfg_key="assistant_log_report_path",
    )
    if explicit is not None:
        return explicit
    data_dir = assistant_dev_data_dir(project_root)
    return (data_dir if data_dir != project_root else project_root / "docs") / "DEV_ASSISTANT_LOG_REPORT.md"


def assistant_training_output_path(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_TRAINING_OUTPUT_PATH",
        cfg_key="assistant_training_output_path",
    )
    if explicit is not None:
        return explicit
    data_dir = assistant_dev_data_dir(project_root)
    return (data_dir if data_dir != project_root else project_root / "backend" / "scripts") / "dev_assistant_training.jsonl"


def assistant_experiments_dir(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_EXPERIMENTS_DIR",
        cfg_key="assistant_experiments_dir",
    )
    if explicit is not None:
        return explicit
    data_dir = assistant_dev_data_dir(project_root)
    if data_dir != project_root:
        return data_dir / "experiments"
    return assistant_dev_runs_dir(project_root) / "experiments"


def assistant_experiment_dataset_path(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_EXPERIMENT_DATASET_PATH",
        cfg_key="assistant_experiment_dataset_path",
    )
    if explicit is not None:
        return explicit
    data_dir = assistant_dev_data_dir(project_root)
    return (data_dir if data_dir != project_root else project_root) / "dev_assistant_experiments.jsonl"


def assistant_experiment_exports_dir(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_EXPERIMENT_EXPORTS_DIR",
        cfg_key="assistant_experiment_exports_dir",
    )
    if explicit is not None:
        return explicit
    return assistant_experiments_dir(project_root) / "exports"


def assistant_self_improvement_dir(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_SELF_IMPROVEMENT_DIR",
        cfg_key="assistant_self_improvement_dir",
    )
    if explicit is not None:
        return explicit
    return assistant_dev_runs_dir(project_root) / "self_improvement"


def assistant_self_improvement_queue_path(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_SELF_IMPROVEMENT_QUEUE_PATH",
        cfg_key="assistant_self_improvement_queue_path",
    )
    if explicit is not None:
        return explicit
    return assistant_self_improvement_dir(project_root) / "queue_summary.json"


def assistant_self_improvement_history_path(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_SELF_IMPROVEMENT_HISTORY_PATH",
        cfg_key="assistant_self_improvement_history_path",
    )
    if explicit is not None:
        return explicit
    return assistant_self_improvement_dir(project_root) / "execution_history.jsonl"


def assistant_self_improvement_seed_path(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_SELF_IMPROVEMENT_SEED_PATH",
        cfg_key="assistant_self_improvement_seed_path",
    )
    if explicit is not None:
        return explicit
    return assistant_self_improvement_dir(project_root) / "seed_requests.jsonl"


def assistant_project_maintenance_dir(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_PROJECT_MAINTENANCE_DIR",
        cfg_key="assistant_project_maintenance_dir",
    )
    if explicit is not None:
        return explicit
    return assistant_dev_runs_dir(project_root) / "project_maintenance"


def assistant_project_maintenance_profile_path(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_PROJECT_MAINTENANCE_PROFILE_PATH",
        cfg_key="assistant_project_maintenance_profile_path",
    )
    if explicit is not None:
        return explicit
    return assistant_project_maintenance_dir(project_root) / "project_profile.json"


def assistant_project_maintenance_queue_path(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_PROJECT_MAINTENANCE_QUEUE_PATH",
        cfg_key="assistant_project_maintenance_queue_path",
    )
    if explicit is not None:
        return explicit
    return assistant_project_maintenance_dir(project_root) / "queue_summary.json"


def assistant_project_maintenance_history_path(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_PROJECT_MAINTENANCE_HISTORY_PATH",
        cfg_key="assistant_project_maintenance_history_path",
    )
    if explicit is not None:
        return explicit
    return assistant_project_maintenance_dir(project_root) / "execution_history.jsonl"


def assistant_owner_automation_dir(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_OWNER_AUTOMATION_DIR",
        cfg_key="assistant_owner_automation_dir",
    )
    if explicit is not None:
        return explicit
    return assistant_dev_runs_dir(project_root) / "owner_automation"


def assistant_owner_automation_queue_path(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_OWNER_AUTOMATION_QUEUE_PATH",
        cfg_key="assistant_owner_automation_queue_path",
    )
    if explicit is not None:
        return explicit
    return assistant_owner_automation_dir(project_root) / "queue_summary.json"


def assistant_owner_automation_history_path(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_OWNER_AUTOMATION_HISTORY_PATH",
        cfg_key="assistant_owner_automation_history_path",
    )
    if explicit is not None:
        return explicit
    return assistant_owner_automation_dir(project_root) / "execution_history.jsonl"


def assistant_history_path(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_HISTORY_PATH",
        cfg_key="assistant_history_path",
    )
    if explicit is not None:
        return explicit
    data_dir = assistant_dev_data_dir(project_root)
    return (data_dir if data_dir != project_root else project_root) / ".dev_assistant_history.jsonl"


def assistant_scheduler_log_path(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_SCHEDULER_LOG_PATH",
        cfg_key="assistant_scheduler_log_path",
    )
    if explicit is not None:
        return explicit
    return assistant_runs_dir(project_root) / "autopilot_scheduler.log"


def assistant_runtime_state_path(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_RUNTIME_STATE_PATH",
        cfg_key="assistant_runtime_state_path",
    )
    if explicit is not None:
        return explicit
    return assistant_runs_dir(project_root) / "runtime_state.json"


def assistant_desktop_build_dir(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_DESKTOP_BUILD_DIR",
        cfg_key="assistant_desktop_build_dir",
    )
    if explicit is not None:
        return explicit
    root = assistant_artifacts_root(project_root)
    if root is not None:
        return root / "desktop_builds"
    return project_root / "tools" / "gosenderr-desktop-agent" / "dist"


def assistant_test_artifacts_dir(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_TEST_ARTIFACTS_DIR",
        cfg_key="assistant_test_artifacts_dir",
    )
    if explicit is not None:
        return explicit
    root = assistant_artifacts_root(project_root)
    if root is not None:
        return root / "test_artifacts"
    return project_root / "test_artifacts"


def assistant_tmp_dir(project_root: Path) -> Path:
    explicit = _cfg_or_env_path(
        project_root,
        env_key="GOSENDERR_ASSISTANT_TMP_DIR",
        cfg_key="assistant_tmp_dir",
    )
    if explicit is not None:
        return explicit
    root = assistant_artifacts_root(project_root)
    if root is not None:
        return root / "tmp"
    return project_root / "tmp"
