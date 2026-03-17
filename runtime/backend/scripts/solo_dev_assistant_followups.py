from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


def _assistant_candidate_priority(row: dict[str, Any]) -> tuple[int, int, str]:
    kind = str(row.get("kind") or "")
    summary = str(row.get("summary") or "")
    occurrences = int(row.get("occurrences", 0))
    if kind == "idle-queue":
        return (0, -occurrences, summary)
    if kind in {"test", "smoke", "ui-smoke", "packaged-smoke", "review-reject"}:
        return (1, -occurrences, summary)
    if kind == "blocked-triage":
        return (2, -occurrences, summary)
    return (3, -occurrences, summary)


def synthesize_followup_bats_core(
    *,
    repo_root: Path,
    runs_dir: Path,
    followup_report_path: Path,
    followup_report_md_path: Path,
    min_occurrences: int = 2,
    max_new_bats: int = 3,
    additional_reasons: list[str] | None = None,
    assistant_only: bool = False,
    next_bat_ticket_id_fn: Callable[[str], int],
    followup_board_phrase_fn: Callable[[str], str],
    board_ticket_summary_fn: Callable[[str], str],
    load_blocked_reason_counts_fn: Callable[[], dict[str, int]],
    collect_assistant_followup_counts_fn: Callable[[], tuple[dict[str, dict[str, Any]], int]],
    merge_assistant_followup_signal_fn: Callable[[dict[str, dict[str, Any]], dict[str, Any] | None], None],
    assistant_followup_signal_from_reason_fn: Callable[[str], dict[str, Any] | None],
) -> dict[str, Any]:
    board_path = repo_root / "docs" / "BAT_FEATURE_BOARD.md"
    if not board_path.exists():
        return {"ok": False, "error": "board_missing", "inserted": []}

    board_text = board_path.read_text(encoding="utf-8")
    all_board_phrases = {
        followup_board_phrase_fn(board_ticket_summary_fn(line))
        for line in board_text.splitlines()
        if "BAT<" in line
    }
    open_todo_phrases = {
        followup_board_phrase_fn(board_ticket_summary_fn(line))
        for line in board_text.splitlines()
        if "[TODO]" in line and "BAT<" in line
    }
    counts = load_blocked_reason_counts_fn() if not assistant_only else {}
    candidate_rows: list[dict[str, Any]] = []
    scanned_artifacts = 0

    if not assistant_only:
        for reason in additional_reasons or []:
            normalized = str(reason or "").strip()
            if not normalized:
                continue
            counts[normalized] = counts.get(normalized, 0) + 1
        for reason, count in sorted(counts.items(), key=lambda item: (-item[1], item[0])):
            if count < min_occurrences:
                continue
            candidate_rows.append(
                {
                    "signature": f"blocked::{reason.lower()}",
                    "reason": reason,
                    "summary": f"Add manual-review handoff for repeated assistant block: {reason}.",
                    "occurrences": count,
                    "source_tickets": [],
                }
            )
    else:
        assistant_counts, scanned_artifacts = collect_assistant_followup_counts_fn()
        for reason in additional_reasons or []:
            merge_assistant_followup_signal_fn(
                assistant_counts,
                assistant_followup_signal_from_reason_fn(str(reason or "")),
            )
        for row in sorted(assistant_counts.values(), key=_assistant_candidate_priority):
            if int(row.get("occurrences", 0)) < min_occurrences:
                continue
            candidate_rows.append(dict(row))

    inserted: list[dict[str, Any]] = []
    updated = board_text
    next_id = next_bat_ticket_id_fn(board_text)

    for candidate in candidate_rows:
        if len(inserted) >= max_new_bats:
            break
        summary = str(candidate.get("summary") or "").strip()
        if not summary:
            continue
        phrase = followup_board_phrase_fn(summary)
        if str(candidate.get("signature") or "") == "assistant-idle-queue::self-heal-seed" and phrase in open_todo_phrases:
            continue
        if phrase in open_todo_phrases:
            continue
        ticket = f"{next_id:03d}"
        line = f"- `BAT<{ticket}>` [TODO][OPS][P1][UNTESTED] {summary}"
        if "## TODO" in updated:
            updated = updated.replace("## TODO", f"## TODO\n{line}", 1)
        else:
            suffix = "\n" if updated.endswith("\n") else "\n\n"
            updated = f"{updated}{suffix}## TODO\n{line}\n"
        all_board_phrases.add(phrase)
        open_todo_phrases.add(phrase)
        inserted.append(
            {
                "ticket": ticket,
                "reason": str(candidate.get("reason") or summary.rstrip(".")),
                "summary": summary,
                "line": line,
                "occurrences": int(candidate.get("occurrences", 0)),
                "source_tickets": list(candidate.get("source_tickets") or []),
                "signature": str(candidate.get("signature") or ""),
            }
        )
        next_id += 1

    if inserted:
        board_path.write_text(updated, encoding="utf-8")

    runs_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "ok": True,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "min_occurrences": min_occurrences,
        "max_new_bats": max_new_bats,
        "assistant_only": assistant_only,
        "inserted": inserted,
        "candidate_count": len(candidate_rows),
        "scanned_artifacts": scanned_artifacts,
        "counts": counts,
    }
    followup_report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    lines = ["# Assistant Follow-up BAT Suggestions", ""]
    if inserted:
        for row in inserted:
            lines.append(f"- BAT<{row['ticket']}>: {row.get('summary') or row['reason']}")
    else:
        lines.append("- no new follow-up BATs")
    followup_report_md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return report