from __future__ import annotations

import json
from collections.abc import Iterator
from http import HTTPStatus
from typing import Any
from urllib import error, request

from .base import ModelProvider, ProviderConfig, ProviderMessage


class OllamaProvider(ModelProvider):
    def __init__(self, config: ProviderConfig):
        self.config = config

    def name(self) -> str:
        return "ollama"

    def available(self) -> bool:
        if not (self.config.ollama_base_url and self.config.ollama_model):
            return False
        base = self.config.ollama_base_url.rstrip("/")
        target = f"{base}/api/tags"
        req = request.Request(target, method="GET")
        try:
            with request.urlopen(req, timeout=min(int(self.config.request_timeout or 60), 5)) as response:
                return 200 <= getattr(response, "status", 200) < 500
        except (error.URLError, TimeoutError, ValueError, OSError):
            return False

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

    def _stream_json(self, path: str, payload: dict[str, Any]) -> Iterator[dict[str, Any]]:
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
            for raw_line in response:
                line = raw_line.decode("utf-8").strip()
                if not line:
                    continue
                try:
                    payload_line = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(payload_line, dict):
                    yield payload_line

    def _http_error_message(self, exc: error.HTTPError) -> str:
        status = exc.code if isinstance(exc.code, int) else 0
        reason = exc.reason if exc.reason is not None else HTTPStatus(status).phrase if status else ''
        body_text = ''
        try:
            payload = exc.read().decode("utf-8")
            parsed = json.loads(payload) if payload else {}
            if isinstance(parsed, dict):
                body_text = str(parsed.get("error") or parsed.get("message") or '').strip()
            if not body_text:
                body_text = str(payload or '').strip()
        except Exception:
            body_text = ''
        details = body_text or str(reason or '').strip() or 'ollama request failed'
        prefix = f"Ollama request failed ({status})" if status else 'Ollama request failed'
        return f"{prefix}: {details}" if details else prefix

    def _request_generate(self, payload: dict[str, Any]) -> str:
        try:
            data = self._post_json("/api/generate", payload)
        except error.HTTPError as exc:
            raise RuntimeError(self._http_error_message(exc)) from exc
        except (error.URLError, TimeoutError, ValueError, OSError):
            return ""
        return str(data.get("response") or "").strip()

    def _request_chat(self, payload: dict[str, Any]) -> str:
        try:
            data = self._post_json("/api/chat", payload)
        except error.HTTPError as exc:
            raise RuntimeError(self._http_error_message(exc)) from exc
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

    def preflight_check(self, **kwargs: Any) -> dict[str, Any]:
        payload = {
            "model": self.config.ollama_model,
            "prompt": str(kwargs.get("prompt") or "Reply with READY."),
            "system": str(kwargs.get("system_prompt") or self.config.system_prompt),
            "stream": False,
            "keep_alive": "0s",
            "options": {
                "temperature": 0,
                "num_predict": 1,
            },
        }
        try:
            self._post_json("/api/generate", payload)
        except error.HTTPError as exc:
            return {"ok": False, "message": self._http_error_message(exc)}
        except (error.URLError, TimeoutError, ValueError, OSError) as exc:
            return {"ok": False, "message": str(exc) or "Ollama request failed."}
        return {"ok": True}

    def summarize(self, text: str, **kwargs: Any) -> str:
        prompt = f"Summarize this repository or engineering context in concise actionable bullets:\n\n{text}"
        return self.generate(prompt=prompt, **kwargs)

    def propose_patch(self, prompt: str, **kwargs: Any) -> str:
        patch_prompt = f"Produce a small targeted repair suggestion for this issue. Focus on the minimal safe fix.\n\n{prompt}"
        return self.generate(prompt=patch_prompt, **kwargs)

    def stream_generate(self, *, prompt: str | None = None, messages: list[ProviderMessage] | None = None, system_prompt: str | None = None, temperature: float | None = None) -> Iterator[str]:
        payload_options: dict[str, Any] = {}
        if temperature is not None:
            payload_options["temperature"] = temperature
        try:
            if messages:
                payload_messages = list(messages)
                if system_prompt and not any(message.get("role") == "system" for message in payload_messages):
                    payload_messages.insert(0, {"role": "system", "content": system_prompt})
                payload = {
                    "model": self.config.ollama_model,
                    "messages": payload_messages,
                    "stream": True,
                    "options": payload_options,
                }
                for item in self._stream_json("/api/chat", payload):
                    content = str((item.get("message") or {}).get("content") or "")
                    if content:
                        yield content
                return
            payload = {
                "model": self.config.ollama_model,
                "prompt": prompt or "",
                "system": system_prompt or self.config.system_prompt,
                "stream": True,
                "options": payload_options,
            }
            for item in self._stream_json("/api/generate", payload):
                content = str(item.get("response") or "")
                if content:
                    yield content
        except error.HTTPError as exc:
            raise RuntimeError(self._http_error_message(exc)) from exc
        except (error.URLError, TimeoutError, ValueError, OSError):
            fallback = self.generate(prompt=prompt, messages=messages, system_prompt=system_prompt, temperature=temperature)
            if fallback:
                yield fallback
