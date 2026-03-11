from __future__ import annotations

import shlex
import subprocess

from .base import ModelProvider, ProviderConfig, ProviderMessage


class LocalCommandProvider(ModelProvider):
    def __init__(self, config: ProviderConfig):
        self.config = config

    def name(self) -> str:
        return "local"

    def available(self) -> bool:
        return bool(self.config.local_ai_cmd)

    def generate(self, *, prompt: str | None = None, messages: list[ProviderMessage] | None = None, system_prompt: str | None = None, temperature: float | None = None) -> str:
        del temperature
        if not self.available():
            return ""
        text = ""
        if messages:
            has_system = any(message.get("role") == "system" for message in messages)
            if not has_system and (system_prompt or self.config.system_prompt):
                text += f"[system]: {system_prompt or self.config.system_prompt}\n"
            for message in messages:
                text += f"[{message.get('role')}]: {message.get('content')}\n"
        else:
            if system_prompt or self.config.system_prompt:
                text += (system_prompt or self.config.system_prompt) + "\n"
            text += prompt or ""
        try:
            proc = subprocess.Popen(
                shlex.split(self.config.local_ai_cmd),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=str(self.config.project_root) if self.config.project_root else None,
            )
            out, _err = proc.communicate(text, timeout=120)
            if proc.returncode == 0:
                return out.strip()
        except Exception:
            return ""
        return ""

    def chat(self, messages: list[ProviderMessage], **kwargs) -> str:
        return self.generate(messages=messages, **kwargs)
