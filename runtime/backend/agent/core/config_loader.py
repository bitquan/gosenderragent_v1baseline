from __future__ import annotations

from pathlib import Path
from typing import Any


def _merge_dicts(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in override.items():
        existing = merged.get(key)
        if isinstance(existing, dict) and isinstance(value, dict):
            merged[str(key)] = _merge_dicts(existing, value)
        else:
            merged[str(key)] = value
    return merged


def _parse_scalar(raw: str) -> Any:
    text = str(raw or "").strip()
    if not text:
        return ""
    if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
        return text[1:-1]
    lowered = text.lower()
    if lowered in {"true", "yes", "on"}:
        return True
    if lowered in {"false", "no", "off"}:
        return False
    try:
        return int(text)
    except ValueError:
        return text


def _parse_basic_yaml(raw: str) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    active_list_key = ""
    active_item: dict[str, Any] | None = None
    for raw_line in str(raw or "").splitlines():
        line = raw_line.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        stripped = line.strip()
        if indent == 0:
            active_item = None
            if stripped.endswith(":") and ":" not in stripped[:-1]:
                active_list_key = stripped[:-1].strip()
                payload[active_list_key] = []
                continue
            active_list_key = ""
            if ":" not in stripped:
                continue
            key, value = stripped.split(":", 1)
            payload[key.strip()] = _parse_scalar(value)
            continue
        if active_list_key and stripped.startswith("- "):
            value = stripped[2:].strip()
            if ":" in value:
                key, item_value = value.split(":", 1)
                active_item = {key.strip(): _parse_scalar(item_value)}
                payload[active_list_key].append(active_item)
            else:
                payload[active_list_key].append(_parse_scalar(value))
                active_item = None
            continue
        if active_list_key and active_item is not None and ":" in stripped:
            key, value = stripped.split(":", 1)
            active_item[key.strip()] = _parse_scalar(value)
    return payload


def load_project_config(project_root: Path, *, base_name: str = "dev_assistant.yaml", local_name: str = "dev_assistant.local.yaml") -> dict[str, Any]:
    try:
        import yaml  # type: ignore
    except ImportError:
        yaml = None

    config: dict[str, Any] = {}
    for file_name in (base_name, local_name):
        config_path = project_root / file_name
        if not config_path.exists():
            continue
        try:
            raw = config_path.read_text(encoding="utf-8")
            payload = (yaml.safe_load(raw) if yaml is not None else _parse_basic_yaml(raw)) or {}
        except Exception:
            try:
                payload = _parse_basic_yaml(config_path.read_text(encoding="utf-8"))
            except Exception:
                continue
        if isinstance(payload, dict):
            config = _merge_dicts(config, payload)
    return config


_ALLOWED_PROVIDER_VALUES = {"", "auto", "openai", "ollama", "local", "anthropic", "azure-openai"}
_LOCAL_PROVIDER_VALUES = {"ollama", "local"}
_LOCAL_APPROVED_DEFAULT_MODELS = {"qwen2.5-coder:7b", "qwen2.5-coder:3b"}


def _check_local_default_guardrail(provider: str, model: str, label: str, warnings: list[str]) -> None:
    normalized_provider = str(provider or "").strip().lower()
    normalized_model = str(model or "").strip()
    if normalized_provider not in _LOCAL_PROVIDER_VALUES or not normalized_model:
        return
    if normalized_model not in _LOCAL_APPROVED_DEFAULT_MODELS:
        warnings.append(
            f"{label} pins local model '{normalized_model}', which exceeds the 32 GB default-bundle guardrail; the runtime will fall back to qwen2.5-coder:7b."
        )


def _as_trimmed_text(value: Any) -> str:
    return str(value or "").strip()


def validate_config_coherence(project_root: Path) -> dict[str, Any]:
    cfg = load_project_config(project_root)
    warnings: list[str] = []
    errors: list[str] = []

    def _check_path(cfg_key: str) -> None:
        raw = cfg.get(cfg_key)
        if raw is None or not str(raw).strip():
            return
        candidate = Path(str(raw).strip()).expanduser()
        if not candidate.is_absolute() and not str(raw).strip().startswith('.'):
            warnings.append(f"{cfg_key} is relative; prefer an absolute or workspace-relative path.")

    def _check_route(prefix: str) -> None:
        provider = _as_trimmed_text(cfg.get(f'assistant_task_mode_{prefix}_provider')).lower()
        model = _as_trimmed_text(cfg.get(f'assistant_task_mode_{prefix}_model'))
        if provider and provider not in _ALLOWED_PROVIDER_VALUES:
            warnings.append(f"assistant_task_mode_{prefix}_provider uses unknown provider '{provider}'.")
        if provider in {'openai', 'azure-openai', 'anthropic'} and not model:
            warnings.append(f"assistant_task_mode_{prefix}_provider is set to {provider} but no model is pinned.")
        if provider in {'local', 'ollama'} and not model:
            warnings.append(f"assistant_task_mode_{prefix}_provider is set to {provider} but no local model is pinned.")
        _check_local_default_guardrail(provider, model, f'assistant_task_mode_{prefix}_model', warnings)

    for key in (
        'assistant_artifacts_root',
        'assistant_promotions_root',
        'assistant_benchmark_root',
        'assistant_labs_root',
        'assistant_model_foundry_root',
        'assistant_training_model_storage_root',
        'assistant_runs_dir',
        'assistant_dev_runs_dir',
    ):
        _check_path(key)

    for lane in ('planner', 'repair', 'coder', 'validator', 'summarizer'):
        _check_route(lane)

    base_provider = _as_trimmed_text(cfg.get('assistant_model_base_provider')).lower()
    provider_source = _as_trimmed_text(cfg.get('assistant_model_provider_source')).lower()
    engine_provider = _as_trimmed_text(cfg.get('assistant_engine_model_base_provider')).lower()
    _check_local_default_guardrail(base_provider or provider_source, _as_trimmed_text(cfg.get('assistant_model_base_model')), 'assistant_model_base_model', warnings)
    _check_local_default_guardrail(_as_trimmed_text(cfg.get('assistant_workspace_model_base_provider')).lower() or _as_trimmed_text(cfg.get('assistant_workspace_model_provider_source')).lower(), _as_trimmed_text(cfg.get('assistant_workspace_model_base_model')), 'assistant_workspace_model_base_model', warnings)
    _check_local_default_guardrail(engine_provider or _as_trimmed_text(cfg.get('assistant_engine_model_provider_source')).lower(), _as_trimmed_text(cfg.get('assistant_engine_model_base_model')), 'assistant_engine_model_base_model', warnings)
    if base_provider and provider_source and base_provider != provider_source:
        warnings.append('assistant_model_base_provider and assistant_model_provider_source diverge; routing may look inconsistent in the UI.')
    if engine_provider == 'openai' and _as_trimmed_text(cfg.get('assistant_engine_model_base_model')) == '':
        errors.append('assistant_engine_model_base_provider is openai but assistant_engine_model_base_model is empty.')
    if cfg.get('assistant_auto_run_queued_task_loop_followups') is True and cfg.get('assistant_auto_queue_task_loop_followups') is not True:
        warnings.append('assistant_auto_run_queued_task_loop_followups is enabled without assistant_auto_queue_task_loop_followups.')
    if cfg.get('assistant_self_improvement_only') is True and _as_trimmed_text(cfg.get('assistant_autonomy_mode')).lower() not in {'self', 'guided', ''}:
        warnings.append('assistant_self_improvement_only is enabled while assistant_autonomy_mode is not self/guided.')

    status = 'ok'
    if errors:
        status = 'error'
    elif warnings:
        status = 'warn'
    return {
        'status': status,
        'ok': not errors,
        'warning_count': len(warnings),
        'error_count': len(errors),
        'warnings': warnings,
        'errors': errors,
        'summary': errors[0] if errors else (warnings[0] if warnings else 'Configuration is coherent.'),
    }
