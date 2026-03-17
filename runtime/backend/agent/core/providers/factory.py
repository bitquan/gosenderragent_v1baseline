from __future__ import annotations

from .base import ModelProvider, ProviderConfig
from .provider_resolver import provider_diagnostics, resolve_provider


def create_provider(config: ProviderConfig, explicit: str | None = None) -> ModelProvider:
    return resolve_provider(config, explicit=explicit)


__all__ = ["create_provider", "provider_diagnostics"]
