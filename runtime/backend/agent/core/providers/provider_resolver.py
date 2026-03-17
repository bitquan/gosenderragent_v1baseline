from __future__ import annotations

import os

from .base import ModelProvider, NullProvider, ProviderConfig
from .local_provider import LocalCommandProvider
from .ollama_provider import OllamaProvider
from .openai_provider import OpenAIProvider


def resolve_provider_name(config: ProviderConfig, explicit: str | None = None) -> str:
    if explicit:
        return explicit.strip().lower()
    if config.provider_name:
        return config.provider_name.strip().lower()
    env_provider = os.environ.get("AGENT_PROVIDER", "").strip().lower()
    if env_provider:
        return env_provider
    if config.openai_api_key:
        return "openai"
    if config.local_ai_cmd:
        return "local"
    return "ollama"


def resolve_provider(config: ProviderConfig, explicit: str | None = None) -> ModelProvider:
    name = resolve_provider_name(config, explicit=explicit)
    if name == "openai":
        provider = OpenAIProvider(config)
        return provider if provider.available() else NullProvider()
    if name == "local":
        provider = LocalCommandProvider(config)
        return provider if provider.available() else NullProvider()
    if name == "ollama":
        return OllamaProvider(config)
    return NullProvider()


def provider_diagnostics(config: ProviderConfig) -> list[str]:
    selected = resolve_provider_name(config)
    details = [f"selected provider: {selected}"]
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
