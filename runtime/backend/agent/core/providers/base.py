from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ProviderMessage = dict[str, str]


@dataclass
class ProviderConfig:
    provider_name: str = ""
    openai_api_key: str = ""
    openai_base_url: str = ""
    local_ai_cmd: str = ""
    system_prompt: str = "You are a rigorous software engineer."
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "qwen2.5-coder:7b"
    openai_model: str = "gpt-4o-mini"
    max_output_tokens: int = 1500
    request_timeout: int = 60
    project_root: Path | None = None
    routed_agent_name: str = ""
    routed_provider_name: str = ""
    routed_model_name: str = ""
    routed_fallback_model_name: str = ""
    routed_role: str = ""


class ModelProvider(ABC):
    @abstractmethod
    def name(self) -> str:
        raise NotImplementedError

    @abstractmethod
    def available(self) -> bool:
        raise NotImplementedError

    @abstractmethod
    def generate(self, *, prompt: str | None = None, messages: list[ProviderMessage] | None = None) -> str:
        raise NotImplementedError

    def stream_generate(self, *, prompt: str | None = None, messages: list[ProviderMessage] | None = None, **kwargs: Any) -> Iterator[str]:
        generated = self.generate(prompt=prompt, messages=messages, **kwargs)
        if generated:
            yield generated

    def chat(self, messages: list[ProviderMessage], **kwargs: Any) -> str:
        return self.generate(messages=messages, **kwargs)

    def summarize(self, text: str, **kwargs: Any) -> str:
        prompt = f"Summarize the following engineering context clearly and concisely:\n\n{text}"
        return self.generate(prompt=prompt, **kwargs)

    def propose_patch(self, prompt: str, **kwargs: Any) -> str:
        patch_prompt = f"Propose a targeted code patch or repair guidance for the following issue:\n\n{prompt}"
        return self.generate(prompt=patch_prompt, **kwargs)

    def preflight_check(self, **kwargs: Any) -> dict[str, Any]:
        del kwargs
        return {"ok": True}


class NullProvider(ModelProvider):
    def name(self) -> str:
        return "null"

    def available(self) -> bool:
        return False

    def generate(self, *, prompt: str | None = None, messages: list[ProviderMessage] | None = None) -> str:
        del prompt, messages
        return ""

    def preflight_check(self, **kwargs: Any) -> dict[str, Any]:
        del kwargs
        return {"ok": False, "message": "No provider is available for this route."}
