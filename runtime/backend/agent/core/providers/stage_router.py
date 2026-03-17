from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

from backend.agent.core.model_routing import resolve_agent_model_route

from .base import ModelProvider, NullProvider, ProviderConfig
from .factory import create_provider
from .provider_resolver import resolve_provider_name


def _provider_config(provider: Any) -> ProviderConfig | None:
    config = getattr(provider, 'config', None)
    return config if isinstance(config, ProviderConfig) else None


def _route_config(base_config: ProviderConfig, *, provider_name: str, model_name: str) -> ProviderConfig:
    updated = replace(
        base_config,
        provider_name=provider_name,
    )
    if provider_name == 'openai':
        return replace(updated, openai_model=model_name)
    if provider_name == 'ollama':
        return replace(updated, ollama_model=model_name)
    return updated


def route_provider_for_agent(provider: Any, agent_name: str, project_root: Path | None = None) -> Any:
    if provider is None:
        return None
    base_config = _provider_config(provider)
    if base_config is None:
        return provider

    effective_root = project_root or base_config.project_root
    route = resolve_agent_model_route(agent_name, effective_root)
    transport_provider_name = resolve_provider_name(base_config)
    target_provider_name = route.provider or transport_provider_name
    routed_base_config = replace(
        base_config,
        routed_agent_name=route.agent,
        routed_provider_name=target_provider_name,
        routed_model_name=route.model,
        routed_fallback_model_name=route.fallback_model,
        routed_role=route.role,
    )
    provider_name = transport_provider_name if transport_provider_name == 'local' else target_provider_name
    primary_config = _route_config(routed_base_config, provider_name=provider_name, model_name=route.model)
    primary_provider = create_provider(primary_config, explicit=provider_name)
    if not isinstance(primary_provider, NullProvider):
        return primary_provider

    if route.fallback_model and provider_name in {'ollama', 'openai', 'local'}:
        fallback_config = _route_config(routed_base_config, provider_name=provider_name, model_name=route.fallback_model)
        fallback_provider = create_provider(fallback_config, explicit=provider_name)
        if not isinstance(fallback_provider, NullProvider):
            return fallback_provider

    return provider
