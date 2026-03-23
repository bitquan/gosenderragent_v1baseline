from __future__ import annotations

import json
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from backend.agent.core.config_loader import load_project_config
from backend.agent.core.storage_paths import (
    assistant_docs_cache_dir,
    assistant_docs_experiments_dir,
    assistant_docs_import_queue_path,
    assistant_docs_registry_path,
)

REGISTRY_SCHEMA_VERSION = "2026-03-19"
DEFAULT_VERIFIED_SOURCES: list[dict[str, Any]] = [
    {"id": "vscode-api", "title": "VS Code API", "url": "https://code.visualstudio.com/api", "domain": "code.visualstudio.com", "topics": ["vscode", "extensions", "editor"], "priority": 100},
    {"id": "node-api", "title": "Node.js API", "url": "https://nodejs.org/api/", "domain": "nodejs.org", "topics": ["node", "javascript", "runtime"], "priority": 98},
    {"id": "electron-docs", "title": "Electron Docs", "url": "https://www.electronjs.org/docs/latest/", "domain": "www.electronjs.org", "topics": ["electron", "desktop", "ipc"], "priority": 97},
    {"id": "openai-docs", "title": "OpenAI Docs", "url": "https://platform.openai.com/docs/overview", "domain": "platform.openai.com", "topics": ["openai", "models", "agents"], "priority": 95},
    {"id": "ollama-docs", "title": "Ollama Docs", "url": "https://ollama.com/library", "domain": "ollama.com", "topics": ["ollama", "local-models"], "priority": 92},
    {"id": "ue5-docs", "title": "Unreal Engine 5 Docs", "url": "https://dev.epicgames.com/documentation/en-us/unreal-engine", "domain": "dev.epicgames.com", "topics": ["ue5", "c++", "game-dev"], "priority": 88},
]

_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_RE = re.compile(r"<script.*?</script>|<style.*?</style>", re.IGNORECASE | re.DOTALL)

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()

def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default

def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

def _project_topics(project_root: Path) -> list[str]:
    cfg = load_project_config(project_root)
    topics = [str(item).strip() for item in list(cfg.get("assistant_docs_priority_topics", []) or []) if str(item).strip()]
    if topics:
        return topics[:16]
    return ["electron", "node", "openai", "ollama", "vscode", "testing", "python", "javascript"]

def load_docs_registry(project_root: Path) -> dict[str, Any]:
    payload = _read_json(assistant_docs_registry_path(project_root), {})
    if not isinstance(payload, dict):
        payload = {}
    payload.setdefault("schema_version", REGISTRY_SCHEMA_VERSION)
    payload.setdefault("generated_at", _now())
    payload.setdefault("sources", [])
    payload.setdefault("captures", [])
    return payload

def save_docs_registry(project_root: Path, payload: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(payload or {})
    normalized["schema_version"] = REGISTRY_SCHEMA_VERSION
    normalized["updated_at"] = _now()
    _write_json(assistant_docs_registry_path(project_root), normalized)
    return normalized

def ensure_seeded_docs_registry(project_root: Path) -> dict[str, Any]:
    registry = load_docs_registry(project_root)
    sources = [dict(item) for item in list(registry.get("sources", []) or []) if isinstance(item, dict)]
    known = {str(item.get("id") or "").strip() for item in sources}
    for source in DEFAULT_VERIFIED_SOURCES:
        if source["id"] not in known:
            sources.append({**source, "verified": True, "seeded": True, "added_at": _now(), "capture_count": 0, "last_status": "seeded"})
    sources.sort(key=lambda item: int(item.get("priority", 0)), reverse=True)
    registry["sources"] = sources
    return save_docs_registry(project_root, registry)

def load_docs_import_queue(project_root: Path) -> list[dict[str, Any]]:
    payload = _read_json(assistant_docs_import_queue_path(project_root), [])
    return [dict(item) for item in payload if isinstance(item, dict)]

def save_docs_import_queue(project_root: Path, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = [dict(item) for item in items if isinstance(item, dict)]
    _write_json(assistant_docs_import_queue_path(project_root), normalized)
    return normalized

def bootstrap_docs_import_queue(project_root: Path) -> list[dict[str, Any]]:
    registry = ensure_seeded_docs_registry(project_root)
    queue = load_docs_import_queue(project_root)
    known = {(str(item.get("source_id") or ""), str(item.get("topic") or "")) for item in queue}
    topics = _project_topics(project_root)
    for source in list(registry.get("sources", []) or []):
        source_id = str(source.get("id") or "")
        if not source_id:
            continue
        source_topics = [str(item).strip() for item in list(source.get("topics", []) or []) if str(item).strip()]
        matched = [topic for topic in topics if topic in source_topics] or source_topics[:2] or topics[:2]
        for topic in matched[:2]:
            key = (source_id, topic)
            if key in known:
                continue
            queue.append({
                "source_id": source_id,
                "topic": topic,
                "url": str(source.get("url") or ""),
                "priority": int(source.get("priority", 0)),
                "status": "queued",
                "created_at": _now(),
            })
            known.add(key)
    queue.sort(key=lambda item: int(item.get("priority", 0)), reverse=True)
    return save_docs_import_queue(project_root, queue)

def summarize_docs_registry(registry: dict[str, Any]) -> dict[str, Any]:
    sources = [dict(item) for item in list(registry.get("sources", []) or []) if isinstance(item, dict)]
    captures = [dict(item) for item in list(registry.get("captures", []) or []) if isinstance(item, dict)]
    domains = sorted({str(item.get("domain") or "") for item in sources if str(item.get("domain") or "")})
    topics: list[str] = []
    for source in sources:
        for topic in list(source.get("topics", []) or []):
            value = str(topic).strip()
            if value and value not in topics:
                topics.append(value)
    return {
        "source_count": len(sources),
        "capture_count": len(captures),
        "domains": domains[:12],
        "priority_topics": topics[:12],
        "latest_capture_at": str((captures[-1] if captures else {}).get("captured_at") or ""),
    }

def _verified_domain(url: str, domain: str) -> bool:
    try:
        parsed = urlparse(url)
        host = str(parsed.netloc or "").lower()
    except Exception:
        return False
    domain_value = str(domain or "").lower().strip()
    return bool(host and domain_value and (host == domain_value or host.endswith("." + domain_value)))

def _html_to_text(html: str) -> str:
    html = _SCRIPT_RE.sub(" ", html)
    text = _TAG_RE.sub(" ", html)
    text = re.sub(r"\s+", " ", text).strip()
    return text

def fetch_verified_doc_source(source: dict[str, Any], *, timeout: int = 12) -> dict[str, Any]:
    url = str(source.get("url") or "").strip()
    domain = str(source.get("domain") or "").strip()
    if not url or not _verified_domain(url, domain):
        return {"ok": False, "error": "unverified-domain", "url": url}
    request = urllib.request.Request(url, headers={"User-Agent": "GoSenderrDesktopAgent/1.0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        content_type = str(response.headers.get("Content-Type") or "")
        raw = response.read(250000)
    text = raw.decode("utf-8", errors="ignore")
    if "html" in content_type.lower():
        text = _html_to_text(text)
    return {"ok": True, "url": url, "content_type": content_type, "text": text[:120000]}

def capture_doc_content(project_root: Path, *, source_id: str, title: str, url: str, topic: str, content: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    registry = ensure_seeded_docs_registry(project_root)
    cache_dir = assistant_docs_cache_dir(project_root)
    cache_dir.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r"[^a-z0-9]+", "-", f"{source_id}-{topic}".lower()).strip("-") or source_id
    cache_path = cache_dir / f"{slug}.md"
    cache_path.write_text(content, encoding="utf-8")
    capture = {
        "source_id": source_id,
        "title": title,
        "url": url,
        "topic": topic,
        "captured_at": _now(),
        "cache_path": str(cache_path),
        "summary": content[:320],
        "metadata": dict(metadata or {}),
    }
    captures = [dict(item) for item in list(registry.get("captures", []) or []) if isinstance(item, dict)]
    captures.append(capture)
    registry["captures"] = captures[-200:]
    for source in registry.get("sources", []):
        if str(source.get("id") or "") == source_id:
            source["capture_count"] = int(source.get("capture_count", 0)) + 1
            source["last_status"] = "captured"
            source["last_capture_at"] = capture["captured_at"]
            break
    save_docs_registry(project_root, registry)
    return capture

def run_docs_import_worker(project_root: Path, *, limit: int = 3) -> dict[str, Any]:
    registry = ensure_seeded_docs_registry(project_root)
    queue = bootstrap_docs_import_queue(project_root)
    processed: list[dict[str, Any]] = []
    remaining: list[dict[str, Any]] = []
    sources_by_id = {str(item.get("id") or ""): item for item in list(registry.get("sources", []) or []) if isinstance(item, dict)}
    for item in queue:
        if len(processed) >= max(1, int(limit or 3)):
            remaining.append(item)
            continue
        if str(item.get("status") or "") not in {"queued", "retry"}:
            remaining.append(item)
            continue
        source = sources_by_id.get(str(item.get("source_id") or ""))
        if not source:
            item["status"] = "missing-source"
            processed.append(item)
            continue
        try:
            fetched = fetch_verified_doc_source(source)
            if fetched.get("ok"):
                capture = capture_doc_content(
                    project_root,
                    source_id=str(source.get("id") or ""),
                    title=str(source.get("title") or ""),
                    url=str(source.get("url") or ""),
                    topic=str(item.get("topic") or ""),
                    content=str(fetched.get("text") or ""),
                    metadata={"content_type": str(fetched.get("content_type") or "")},
                )
                item["status"] = "done"
                item["captured_at"] = str(capture.get("captured_at") or "")
                item["cache_path"] = str(capture.get("cache_path") or "")
            else:
                item["status"] = "retry"
                item["error"] = str(fetched.get("error") or "fetch-failed")
                remaining.append(item)
        except Exception as exc:
            item["status"] = "retry"
            item["error"] = str(exc)
            remaining.append(item)
        processed.append(dict(item))
    save_docs_import_queue(project_root, remaining)
    return {
        "processed": processed,
        "processed_count": len(processed),
        "remaining_count": len(remaining),
        "registry_summary": summarize_docs_registry(load_docs_registry(project_root)),
        "queue_path": str(assistant_docs_import_queue_path(project_root)),
    }

def build_docs_context_snapshot(project_root: Path) -> dict[str, Any]:
    registry = ensure_seeded_docs_registry(project_root)
    queue = bootstrap_docs_import_queue(project_root)
    summary = summarize_docs_registry(registry)
    return {
        "registry_path": str(assistant_docs_registry_path(project_root)),
        "cache_dir": str(assistant_docs_cache_dir(project_root)),
        "queue_path": str(assistant_docs_import_queue_path(project_root)),
        "queue_count": len(queue),
        **summary,
    }

def build_docs_experiment_plan(project_root: Path, *, runtime_context: dict[str, Any] | None = None, limit: int = 3) -> dict[str, Any]:
    registry = load_docs_registry(project_root)
    captures = [dict(item) for item in list(registry.get("captures", []) or []) if isinstance(item, dict)]
    runtime_payload = dict(runtime_context or {})
    related_files = [str(path).strip() for path in list(runtime_payload.get("related_files", []) or []) if str(path).strip()]
    experiments: list[dict[str, Any]] = []
    for capture in reversed(captures[-12:]):
        topic = str(capture.get("topic") or "")
        target_path = related_files[0] if related_files else ""
        experiments.append({
            "id": f"docs-exp-{len(experiments)+1}",
            "kind": "docs-micro-check",
            "topic": topic,
            "source_id": str(capture.get("source_id") or ""),
            "prompt": f"Compare the current implementation against trusted docs for {topic} and report the smallest mismatch.",
            "target_path": target_path,
            "difficulty": 1 if not target_path else 2,
            "cache_path": str(capture.get("cache_path") or ""),
        })
        if len(experiments) >= max(1, int(limit or 3)):
            break
    experiments_dir = assistant_docs_experiments_dir(project_root)
    experiments_dir.mkdir(parents=True, exist_ok=True)
    plan = {
        "generated_at": _now(),
        "experiments": experiments,
        "experiments_dir": str(experiments_dir),
    }
    _write_json(experiments_dir / "latest_docs_experiment_plan.json", plan)
    return plan

__all__ = [
    "DEFAULT_VERIFIED_SOURCES",
    "REGISTRY_SCHEMA_VERSION",
    "bootstrap_docs_import_queue",
    "build_docs_context_snapshot",
    "build_docs_experiment_plan",
    "capture_doc_content",
    "ensure_seeded_docs_registry",
    "fetch_verified_doc_source",
    "load_docs_import_queue",
    "load_docs_registry",
    "run_docs_import_worker",
    "save_docs_import_queue",
    "save_docs_registry",
    "summarize_docs_registry",
]
