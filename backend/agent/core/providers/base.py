from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ProviderMessage = dict[str, str]


@dataclass
class ProviderConfig:
    provider_name: str = ""
    openai_api_key: str = ""
    local_ai_cmd: str = ""
    system_prompt: str = "You are a rigorous software engineer."
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "qwen2.5-coder:7b"
    openai_model: str = "gpt-4o-mini"
    max_output_tokens: int = 1500
    request_timeout: int = 60
    project_root: Path | None = None


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

    def chat(self, messages: list[ProviderMessage], **kwargs: Any) -> str:
        return self.generate(messages=messages, **kwargs)

    def summarize(self, text: str, **kwargs: Any) -> str:
        prompt = f"Summarize the following engineering context clearly and concisely:\n\n{text}"
        return self.generate(prompt=prompt, **kwargs)

    def propose_patch(self, prompt: str, **kwargs: Any) -> str:
        patch_prompt = f"Propose a targeted code patch or repair guidance for the following issue:\n\n{prompt}"
        return self.generate(prompt=patch_prompt, **kwargs)


class NullProvider(ModelProvider):
    def name(self) -> str:
        return "null"

    def available(self) -> bool:
        return False

    def generate(self, *, prompt: str | None = None, messages: list[ProviderMessage] | None = None) -> str:
        del prompt, messages
        return ""
