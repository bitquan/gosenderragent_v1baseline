from __future__ import annotations

import os

from .base import ModelProvider, NullProvider, ProviderConfig
from .local_provider import LocalCommandProvider
from .ollama_provider import OllamaProvider
from .openai_provider import OpenAIProvider

_PROVIDER_ALIASES = {
    "": "",
    "default": "",
    "online": "openai",
    "cloud": "openai",
    "remote": "openai",
    "hosted": "openai",
    "api": "openai",
    "localcmd": "local",
    "command": "local",
    "shell": "local",
}


def _normalize_provider_name(value: str | None) -> str:
    normalized = str(value or "").strip().lower()
    return _PROVIDER_ALIASES.get(normalized, normalized)


def resolve_provider_name(config: ProviderConfig, explicit: str | None = None) -> str:
    if explicit:
        return _normalize_provider_name(explicit)
    if config.provider_name:
        return _normalize_provider_name(config.provider_name)
    env_provider = os.environ.get("AGENT_PROVIDER", "").strip().lower()
    if env_provider:
        return _normalize_provider_name(env_provider)
    if config.local_ai_cmd:
        return "local"
    if config.openai_api_key:
        return "openai"
    return "ollama"


def provider_candidates(config: ProviderConfig, preferred: str | None = None) -> list[str]:
    ordered: list[str] = []

    def push(name: str | None) -> None:
        normalized = _normalize_provider_name(name)
        if normalized and normalized not in ordered:
            ordered.append(normalized)

    push(preferred)
    push(resolve_provider_name(config, explicit=preferred if preferred else None))
    env_fallback = os.environ.get("AGENT_PROVIDER_FALLBACKS", "")
    for item in env_fallback.split(","):
        push(item)
    for item in ("local", "ollama", "openai"):
        push(item)
    return ordered


def resolve_provider(config: ProviderConfig, explicit: str | None = None) -> ModelProvider:
    for name in provider_candidates(config, preferred=explicit):
        if name == "openai":
            provider = OpenAIProvider(config)
            if provider.available():
                return provider
            continue
        if name == "local":
            provider = LocalCommandProvider(config)
            if provider.available():
                return provider
            continue
        if name == "ollama":
            provider = OllamaProvider(config)
            if provider.available():
                return provider
            continue
    return NullProvider()


def provider_diagnostics(config: ProviderConfig) -> list[str]:
    selected = resolve_provider_name(config)
    details = [f"selected provider: {selected}"]
    details.append(f"candidate order: {', '.join(provider_candidates(config, preferred=selected))}")
    details.append("OLLAMA configured" if OllamaProvider(config).available() else "OLLAMA unavailable")
    if config.openai_api_key:
        details.append("OPENAI_API_KEY set" if OpenAIProvider(config).available() else "OPENAI_API_KEY set but unavailable")
    else:
        details.append("OPENAI_API_KEY not set")
    if config.local_ai_cmd:
        details.append("LOCAL_AI_CMD set" if LocalCommandProvider(config).available() else "LOCAL_AI_CMD set but unavailable")
    else:
        details.append("LOCAL_AI_CMD not set")
    return details
