#!/usr/bin/env python3
"""Bridge stdin prompt -> GPT4All local API, stdout response.

Designed for LOCAL_AI_CMD usage in dev_assistant.py:
  LOCAL_AI_CMD="backend/.venv/bin/python backend/scripts/local_ai_gpt4all_bridge.py"
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request


def _http_json(method: str, url: str, payload: dict | None, timeout: float) -> dict:
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url=url, data=data, method=method.upper())
    req.add_header("Content-Type", "application/json")
    api_key = os.environ.get("GPT4ALL_API_KEY", "local")
    if api_key:
        req.add_header("Authorization", f"Bearer {api_key}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", errors="replace")
        return json.loads(body) if body else {}


def _resolve_model(base_url: str, timeout: float) -> str:
    configured = os.environ.get("GPT4ALL_MODEL", "").strip()
    if configured:
        return configured
    try:
        payload = _http_json("GET", f"{base_url}/models", None, timeout)
        data = payload.get("data")
        if isinstance(data, list) and data:
            first = data[0]
            if isinstance(first, dict):
                model_id = str(first.get("id", "")).strip()
                if model_id:
                    return model_id
    except Exception:
        pass
    return "gpt4all-local"


def main() -> int:
    prompt = sys.stdin.read().strip()
    if not prompt:
        print("")
        return 0

    base_url = os.environ.get("GPT4ALL_API_BASE", "http://127.0.0.1:4891/v1").strip().rstrip("/")
    timeout = float(os.environ.get("GPT4ALL_TIMEOUT_SECONDS", "90"))
    model = _resolve_model(base_url, timeout)
    system_prompt = os.environ.get("ASSISTANT_SYSTEM_PROMPT", "You are a rigorous software engineer.").strip()

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
        "stream": False,
    }

    try:
        response = _http_json("POST", f"{base_url}/chat/completions", payload, timeout)
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            print(
                "GPT4All API returned 401 Unauthorized. Set gosenderrDevAssistant.openaiKey to your GPT4All API key.",
                file=sys.stderr,
            )
            return 1
        print(f"GPT4All API HTTP error: {exc.code}", file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(
            "GPT4All local API unreachable. In GPT4All enable Local API Server and keep it running.",
            file=sys.stderr,
        )
        print(str(exc), file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"GPT4All bridge error: {exc}", file=sys.stderr)
        return 1

    choices = response.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict):
                content = str(message.get("content", "")).strip()
                print(content)
                return 0
            text = str(first.get("text", "")).strip()
            if text:
                print(text)
                return 0

    print("")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
