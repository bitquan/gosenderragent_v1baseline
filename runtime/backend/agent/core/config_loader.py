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
