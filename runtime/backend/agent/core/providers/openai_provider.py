from __future__ import annotations

from typing import cast

from .base import ModelProvider, ProviderConfig, ProviderMessage


class OpenAIProvider(ModelProvider):
    def __init__(self, config: ProviderConfig):
        self.config = config

    def name(self) -> str:
        return "openai"

    def available(self) -> bool:
        if not self.config.openai_api_key:
            return False
        try:
            from openai import OpenAI as _OpenAI  # noqa: F401
        except ImportError:
            return False
        return True

    def generate(self, *, prompt: str | None = None, messages: list[ProviderMessage] | None = None, system_prompt: str | None = None, temperature: float | None = None) -> str:
        if not self.available():
            return ""
        from openai import OpenAI

        client_kwargs = {
            "api_key": self.config.openai_api_key,
        }
        if self.config.openai_base_url:
            client_kwargs["base_url"] = self.config.openai_base_url
        client = OpenAI(**client_kwargs)
        if messages:
            payload = list(messages)
            if not payload or payload[0].get("role") != "system":
                payload.insert(0, {"role": "system", "content": system_prompt or self.config.system_prompt})
        else:
            payload = [
                {"role": "system", "content": system_prompt or self.config.system_prompt},
                {"role": "user", "content": prompt or ""},
            ]
        if hasattr(client, "responses"):
            kwargs: dict[str, object] = {
                "model": self.config.openai_model,
                "input": cast(list[dict[str, str]], payload),
                "max_output_tokens": self.config.max_output_tokens,
            }
            if temperature is not None:
                kwargs["temperature"] = temperature
            response = client.responses.create(**kwargs)
            if getattr(response, "output_text", None):
                return str(response.output_text).strip()
            try:
                return str(response.output[0].content[0].text or "").strip()
            except Exception:
                return ""

        chat_kwargs: dict[str, object] = {
            "model": self.config.openai_model,
            "messages": cast(list[dict[str, str]], payload),
            "max_tokens": self.config.max_output_tokens,
        }
        if temperature is not None:
            chat_kwargs["temperature"] = temperature
        response = client.chat.completions.create(**chat_kwargs)
        try:
            return str(response.choices[0].message.content or "").strip()
        except Exception:
            return ""

    def chat(self, messages: list[ProviderMessage], **kwargs) -> str:
        return self.generate(messages=messages, **kwargs)
