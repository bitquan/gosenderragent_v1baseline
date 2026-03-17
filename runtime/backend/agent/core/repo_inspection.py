from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


DEFAULT_IGNORE_DIRS = {
    ".venv",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".git",
    "__pycache__",
    "site-packages",
    "backend/create/refresh",
    ".dev_agent_runs",
    "docs/assistant_runs",
}

TEXT_LIKE_SUFFIXES = {
    ".py",
    ".pyi",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".json",
    ".md",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".cfg",
    ".env",
    ".html",
    ".css",
    ".scss",
    ".sql",
    ".sh",
}

STOPWORDS = {
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "when",
    "where",
    "what",
    "your",
    "have",
    "will",
    "then",
    "than",
    "true",
    "false",
    "none",
    "null",
    "update",
    "create",
    "modify",
    "file",
    "code",
    "route",
    "service",
    "model",
}

MAX_TERM_COUNT = 18
MAX_CONTENT_SCAN_BYTES = 4000


def _split_identifier_terms(value: str) -> list[str]:
    text = str(value or "").strip()
    if not text:
        return []
    normalized = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    normalized = normalized.replace("/", " ").replace("_", " ").replace("-", " ").replace(".", " ")
    terms: list[str] = []
    seen: set[str] = set()
    for token in re.findall(r"[A-Za-z][A-Za-z0-9]{1,}", normalized):
        lowered = token.lower()
        if lowered in STOPWORDS or len(lowered) < 3 or lowered in seen:
            continue
        seen.add(lowered)
        terms.append(lowered)
    return terms


def _editor_context_terms(editor_context: dict[str, Any] | None, query: str = "") -> list[str]:
    payload = dict(editor_context or {})
    terms: list[str] = []
    seen: set[str] = set()

    def add_many(values: list[str]) -> None:
        nonlocal terms, seen
        for value in values:
            if value in seen:
                continue
            seen.add(value)
            terms.append(value)
            if len(terms) >= MAX_TERM_COUNT:
                return

    active_file = str(payload.get("active_file_path") or "").strip()
    if active_file:
        active_path = Path(active_file)
        add_many(_split_identifier_terms(active_path.stem))
        add_many(_split_identifier_terms(str(active_path.parent).replace("/", " ")))
    add_many(_split_identifier_terms(query))
    add_many(_split_identifier_terms(payload.get("selected_text") or ""))
    add_many(_split_identifier_terms(payload.get("surrounding_snippet") or ""))

    for item in payload.get("diagnostics") or []:
        if len(terms) >= MAX_TERM_COUNT:
            break
        if isinstance(item, dict):
            add_many(_split_identifier_terms(item.get("message") or ""))

    for entry in payload.get("open_files") or []:
        if len(terms) >= MAX_TERM_COUNT:
            break
        add_many(_split_identifier_terms(Path(str(entry)).stem))

    return terms[:MAX_TERM_COUNT]


def _read_candidate_excerpt(target: Path) -> str:
    if not target.exists() or not target.is_file():
        return ""
    suffix = target.suffix.lower()
    if suffix and suffix not in TEXT_LIKE_SUFFIXES:
        return ""
    try:
        with open(target, "r", encoding="utf-8") as handle:
            return handle.read(MAX_CONTENT_SCAN_BYTES)
    except Exception:
        return ""


def _score_candidate_path(path: str, *, active_file_path: str = "", open_files: list[str] | None = None, terms: list[str] | None = None, content_excerpt: str = "") -> tuple[int, list[str]]:
    score = 0
    reasons: list[str] = []
    normalized_path = str(path or "")
    lowered_path = normalized_path.lower()
    term_list = list(terms or [])
    active_path = str(active_file_path or "").strip()
    open_set = {str(item or "").strip() for item in (open_files or []) if str(item or "").strip()}

    if active_path and normalized_path == active_path:
        score += 120
        reasons.append("active-file")

    if active_path:
        active_obj = Path(active_path)
        candidate_obj = Path(normalized_path)
        if str(candidate_obj.parent) == str(active_obj.parent):
            score += 35
            reasons.append("same-directory")
        if candidate_obj.suffix and candidate_obj.suffix == active_obj.suffix:
            score += 12
            reasons.append("same-language")
        active_stem_terms = _split_identifier_terms(active_obj.stem)
        if active_stem_terms and any(term in lowered_path for term in active_stem_terms[:4]):
            score += 16
            reasons.append("active-stem-overlap")

    if normalized_path in open_set:
        score += 18
        reasons.append("open-file")

    path_hits = 0
    content_hits = 0
    lowered_excerpt = content_excerpt.lower()
    for term in term_list:
        if term in lowered_path:
            path_hits += 1
        elif lowered_excerpt and term in lowered_excerpt:
            content_hits += 1
    if path_hits:
        score += min(path_hits, 6) * 10
        reasons.append(f"path-term:{path_hits}")
    if content_hits:
        score += min(content_hits, 5) * 6
        reasons.append(f"content-term:{content_hits}")

    if normalized_path.startswith("backend/"):
        score += 3
    elif normalized_path.startswith("frontend/"):
        score += 2

    return score, reasons


def is_ignored(path: Path, *, ignore_dirs: set[str] | None = None) -> bool:
    dirs = ignore_dirs or DEFAULT_IGNORE_DIRS
    try:
        parts = path.parts
    except Exception:
        return False
    if str(path).endswith((".pyc", ".pyo")):
        return True
    for part in parts:
        if part in dirs:
            return True
        for banned in dirs:
            if banned in str(path):
                return True
    return False


def repo_search(project_root: Path, pattern: str, *, ignore_dirs: set[str] | None = None) -> list[str]:
    results: list[str] = []
    for path in project_root.glob(pattern):
        rel = path.relative_to(project_root)
        if is_ignored(rel, ignore_dirs=ignore_dirs):
            continue
        results.append(str(rel))
    return results


def rank_related_files(
    project_root: Path,
    *,
    candidates: list[str] | None = None,
    query: str = "",
    editor_context: dict[str, Any] | None = None,
    ignore_dirs: set[str] | None = None,
    limit: int = 8,
) -> list[dict[str, Any]]:
    items = list(candidates or iter_repo_files(project_root, ignore_dirs=ignore_dirs))
    payload = dict(editor_context or {})
    active_file_path = str(payload.get("active_file_path") or "").strip()
    open_files = [str(item) for item in (payload.get("open_files") or []) if str(item).strip()]
    terms = _editor_context_terms(payload, query=query)

    ranked: list[dict[str, Any]] = []
    for path in items:
        if not path or is_ignored(Path(path), ignore_dirs=ignore_dirs):
            continue
        target = project_root / path
        excerpt = _read_candidate_excerpt(target)
        score, reasons = _score_candidate_path(
            path,
            active_file_path=active_file_path,
            open_files=open_files,
            terms=terms,
            content_excerpt=excerpt,
        )
        if score <= 0 and terms:
            continue
        ranked.append({"path": path, "score": score, "reasons": reasons})

    ranked.sort(key=lambda item: (-int(item.get("score", 0)), str(item.get("path", ""))))
    return ranked[: max(1, int(limit or 8))]


def iter_repo_files(project_root: Path, *, ignore_dirs: set[str] | None = None) -> list[str]:
    results: list[str] = []
    for path in project_root.rglob("*"):
        rel = path.relative_to(project_root)
        if is_ignored(rel, ignore_dirs=ignore_dirs):
            continue
        results.append(str(rel))
    return results


def build_repo_index(project_root: Path, *, ignore_dirs: set[str] | None = None, output_path: Path | None = None) -> dict[str, list[str]]:
    index: dict[str, list[str]] = {}
    for entry in project_root.iterdir():
        rel = entry.relative_to(project_root)
        if is_ignored(rel, ignore_dirs=ignore_dirs):
            continue
        if entry.is_dir():
            try:
                subs = [
                    path.name
                    for path in entry.iterdir()
                    if path.is_dir() and not is_ignored(path.relative_to(project_root), ignore_dirs=ignore_dirs)
                ]
            except Exception:
                subs = []
            index[entry.name] = subs
    if output_path is not None:
        try:
            output_path.write_text(json.dumps(index, indent=2), encoding="utf-8")
        except Exception:
            pass
    return index