from __future__ import annotations

import json
from typing import Any
from urllib import error, request

from .base import ModelProvider, ProviderConfig, ProviderMessage


class OllamaProvider(ModelProvider):
    def __init__(self, config: ProviderConfig):
        self.config = config

    def name(self) -> str:
        return "ollama"

    def available(self) -> bool:
        return bool(self.config.ollama_base_url and self.config.ollama_model)

    def _post_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        base = self.config.ollama_base_url.rstrip("/")
        target = f"{base}{path}"
        data = json.dumps(payload).encode("utf-8")
        req = request.Request(
            target,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with request.urlopen(req, timeout=self.config.request_timeout) as response:
            body = response.read().decode("utf-8")
        return json.loads(body) if body else {}

    def _request_generate(self, payload: dict[str, Any]) -> str:
        try:
            data = self._post_json("/api/generate", payload)
        except (error.URLError, TimeoutError, ValueError, OSError):
            return ""
        return str(data.get("response") or "").strip()

    def _request_chat(self, payload: dict[str, Any]) -> str:
        try:
            data = self._post_json("/api/chat", payload)
        except (error.URLError, TimeoutError, ValueError, OSError):
            return ""
        message = data.get("message") or {}
        return str(message.get("content") or "").strip()

    def generate(self, *, prompt: str | None = None, messages: list[ProviderMessage] | None = None, system_prompt: str | None = None, temperature: float | None = None) -> str:
        if messages:
            return self.chat(messages, system_prompt=system_prompt, temperature=temperature)
        payload = {
            "model": self.config.ollama_model,
            "prompt": prompt or "",
            "system": system_prompt or self.config.system_prompt,
            "stream": False,
            "options": {},
        }
        if temperature is not None:
            payload["options"]["temperature"] = temperature
        return self._request_generate(payload)

    def chat(self, messages: list[ProviderMessage], **kwargs: Any) -> str:
        system_prompt = kwargs.get("system_prompt") or self.config.system_prompt
        temperature = kwargs.get("temperature")
        payload_messages = list(messages)
        if system_prompt and not any(message.get("role") == "system" for message in payload_messages):
            payload_messages.insert(0, {"role": "system", "content": system_prompt})
        payload = {
            "model": self.config.ollama_model,
            "messages": payload_messages,
            "stream": False,
            "options": {},
        }
        if temperature is not None:
            payload["options"]["temperature"] = temperature
        return self._request_chat(payload)

    def summarize(self, text: str, **kwargs: Any) -> str:
        prompt = f"Summarize this repository or engineering context in concise actionable bullets:\n\n{text}"
        return self.generate(prompt=prompt, **kwargs)

    def propose_patch(self, prompt: str, **kwargs: Any) -> str:
        patch_prompt = f"Produce a small targeted repair suggestion for this issue. Focus on the minimal safe fix.\n\n{prompt}"
        return self.generate(prompt=patch_prompt, **kwargs)
