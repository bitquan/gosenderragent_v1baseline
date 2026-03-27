from __future__ import annotations

from collections.abc import Iterator
from typing import Any, cast

from .base import ModelProvider, ProviderConfig, ProviderMessage


class OpenAIProvider(ModelProvider):
    def __init__(self, config: ProviderConfig):
        self.config = config

    def _create_client(self):
        from openai import OpenAI

        client_kwargs: dict[str, object] = {
            "api_key": self.config.openai_api_key,
        }
        if self.config.openai_base_url:
            client_kwargs["base_url"] = self.config.openai_base_url
        return OpenAI(**client_kwargs)

    def _build_payload(
        self,
        *,
        prompt: str | None = None,
        messages: list[ProviderMessage] | None = None,
        system_prompt: str | None = None,
    ) -> list[ProviderMessage]:
        if messages:
            payload = list(messages)
            if not payload or payload[0].get("role") != "system":
                payload.insert(0, {"role": "system", "content": system_prompt or self.config.system_prompt})
            return payload
        return [
            {"role": "system", "content": system_prompt or self.config.system_prompt},
            {"role": "user", "content": prompt or ""},
        ]

    def _read_stream_delta(self, content: Any) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, dict):
                    parts.append(str(item.get("text") or ""))
                else:
                    parts.append(str(getattr(item, "text", "") or ""))
            return "".join(parts)
        return ""

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
        client = self._create_client()
        payload = self._build_payload(prompt=prompt, messages=messages, system_prompt=system_prompt)
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

    def stream_generate(self, *, prompt: str | None = None, messages: list[ProviderMessage] | None = None, system_prompt: str | None = None, temperature: float | None = None) -> Iterator[str]:
        if not self.available():
            return
        client = self._create_client()
        payload = self._build_payload(prompt=prompt, messages=messages, system_prompt=system_prompt)
        chat_kwargs: dict[str, object] = {
            "model": self.config.openai_model,
            "messages": cast(list[dict[str, str]], payload),
            "max_tokens": self.config.max_output_tokens,
            "stream": True,
        }
        if temperature is not None:
            chat_kwargs["temperature"] = temperature
        try:
            stream = client.chat.completions.create(**chat_kwargs)
            for chunk in stream:
                try:
                    delta = self._read_stream_delta(chunk.choices[0].delta.content)
                except Exception:
                    delta = ""
                if delta:
                    yield delta
        except Exception:
            fallback = self.generate(prompt=prompt, messages=messages, system_prompt=system_prompt, temperature=temperature)
            if fallback:
                yield fallback
