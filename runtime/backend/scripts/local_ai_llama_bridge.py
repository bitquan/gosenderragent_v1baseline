#!/usr/bin/env python3
"""Bridge stdin prompt -> llama.cpp -> stdout response.

Designed for LOCAL_AI_CMD usage in dev_assistant.py:
  LOCAL_AI_CMD="backend/.venv/bin/python backend/scripts/local_ai_llama_bridge.py"
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path


def _repo_root() -> Path:
    # backend/scripts/<this file> -> repo root
    return Path(__file__).resolve().parents[2]


ANSI_RE = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]")


def _resolve_llama_bin(root: Path) -> str:
    configured = os.environ.get("LLAMA_SIMPLE_BIN", "").strip()
    if configured:
        return configured
    default = root / "llama.cpp" / "build" / "bin" / "llama-simple"
    if default.exists():
        return str(default)
    fallback = os.environ.get("LLAMA_CHAT_BIN", "").strip()
    if fallback:
        return fallback
    simple_chat = root / "llama.cpp" / "build" / "bin" / "llama-simple-chat"
    if simple_chat.exists():
        return str(simple_chat)
    return "llama-simple"


def _resolve_model_path() -> str:
    configured = os.environ.get("LLAMA_MODEL_PATH", "").strip()
    if configured and Path(configured).exists():
        return configured

    home = Path.home()
    candidates = [
        home / "large-storage" / "models" / "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
        home / "large-storage" / "models" / "tiny-aya-global-q4_0.gguf",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return ""


def _clean_output(raw: str, prompt: str) -> str:
    text = ANSI_RE.sub("", raw).replace("\r", "").strip()
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped == ">":
            continue
        if stripped.startswith("> "):
            stripped = stripped[2:].lstrip()
        lines.append(stripped)
    text = "\n".join(lines).strip()
    bos = "<BOS_TOKEN>"
    if text.startswith(bos):
        text = text[len(bos) :].lstrip()
    trimmed_prompt = prompt.strip()
    if trimmed_prompt and text.startswith(trimmed_prompt):
        text = text[len(trimmed_prompt) :].lstrip()
    if "<|im_start|>assistant" in text:
        text = text.split("<|im_start|>assistant", 1)[1].lstrip()
    text = text.replace("<|im_end|>", "").strip()
    return text.strip()


def _build_model_prompt(raw_prompt: str) -> str:
    # dev_assistant local path often sends tagged transcript blocks:
    # [system]: ...
    # [user]: ...
    # Collapse this to a cleaner single turn and render Qwen chat template.
    system_chunks: list[str] = []
    user_chunks: list[str] = []
    for line in raw_prompt.splitlines():
        stripped = line.strip()
        if stripped.lower().startswith("[system]:"):
            system_chunks.append(stripped[len("[system]:") :].strip())
        elif stripped.lower().startswith("[user]:"):
            user_chunks.append(stripped[len("[user]:") :].strip())

    if user_chunks:
        user_text = user_chunks[-1]
        if system_chunks:
            system_text = " ".join(system_chunks).strip()
        else:
            system_text = "You are a concise senior coding assistant. Reply directly."
        return (
            f"<|im_start|>system\n{system_text}\n<|im_end|>\n"
            f"<|im_start|>user\n{user_text}\n<|im_end|>\n"
            "<|im_start|>assistant\n"
        )

    trimmed = raw_prompt.strip()
    return (
        "<|im_start|>system\nYou are a concise senior coding assistant. Reply directly.\n<|im_end|>\n"
        f"<|im_start|>user\n{trimmed}\n<|im_end|>\n"
        "<|im_start|>assistant\n"
    )


def main() -> int:
    raw_prompt = sys.stdin.read().strip()
    if not raw_prompt:
        print("")
        return 0
    prompt = _build_model_prompt(raw_prompt)

    root = _repo_root()
    # simple dispatch example: choose a lightweight handler for trivial
    # prompts and the full Qwen model for heavier work.  you can further
    # customise the heuristics or add explicit keyword routing.
    trimmed = raw_prompt.strip()
    # echo back very short messages without calling any model
    if len(trimmed.split()) < 3:
        sys.stdout.write(trimmed)
        return 0
    # if the prompt mentions "search" or "test", use a tiny built‑in CLI to
    # save the big model from spinning up (this requires building bonzai,
    # tiny-aya, or any small binary and pointing FAST_MODEL_BIN at it).
    if re.search(r"\b(search|test|open)\b", trimmed, re.IGNORECASE):
        fast = os.environ.get("FAST_MODEL_BIN", "")
        if fast and Path(fast).exists():
            llama_bin = fast
            # model_path may not be needed for tiny binaries, but keep for safety
            model_path = _resolve_model_path()
        # otherwise fall through to the normal heavy model

    llama_bin = _resolve_llama_bin(root) if 'llama_bin' not in locals() else llama_bin
    model_path = _resolve_model_path() if 'model_path' not in locals() else model_path
    if not model_path:
        print(
            "No local GGUF model found. Set LLAMA_MODEL_PATH to a valid model file.",
            file=sys.stderr,
        )
        return 1

    n_predict = os.environ.get("LLAMA_N_PREDICT", "384").strip()
    n_gpu_layers = os.environ.get("LLAMA_N_GPU_LAYERS", "99").strip()
    n_ctx = os.environ.get("LLAMA_N_CTX", "8192").strip()
    timeout_seconds = int(os.environ.get("LLAMA_TIMEOUT_SECONDS", "180").strip())

    is_chat_bin = "simple-chat" in os.path.basename(llama_bin)
    if is_chat_bin:
        cmd = [
            llama_bin,
            "-m",
            model_path,
            "-c",
            n_ctx,
            "-ngl",
            n_gpu_layers,
        ]
        stdin_text = f"{prompt}\n"
    else:
        cmd = [
            llama_bin,
            "-m",
            model_path,
            "-n",
            n_predict,
            "-ngl",
            n_gpu_layers,
            prompt,
        ]
        stdin_text = None

    try:
        proc = subprocess.run(
            cmd,
            input=stdin_text,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except FileNotFoundError:
        print(
            f"llama binary not found: {llama_bin}. Build llama.cpp first.",
            file=sys.stderr,
        )
        return 1
    except subprocess.TimeoutExpired:
        print(
            f"llama.cpp timed out after {timeout_seconds}s. Try reducing LLAMA_N_PREDICT.",
            file=sys.stderr,
        )
        return 1
    except Exception as exc:
        print(f"llama bridge error: {exc}", file=sys.stderr)
        return 1

    if proc.returncode != 0:
        err = (proc.stderr or "").strip()
        print(err or f"llama-simple exited with code {proc.returncode}", file=sys.stderr)
        return 1

    cleaned = _clean_output(proc.stdout or "", prompt)
    print(cleaned)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
