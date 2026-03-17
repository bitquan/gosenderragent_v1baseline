from __future__ import annotations

from collections import Counter
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.agent.core.artifact_service import summarize_experiment_dataset
from backend.agent.core.engine_baseline_summary import (
    _filter_recent_rows,
    _load_jsonl,
    _parse_training_next_actions,
    _top_counter_rows,
    build_engine_baseline_summary,
)
from backend.agent.core.storage_paths import assistant_experiment_dataset_path, assistant_runs_dir, assistant_training_output_path


def _safe_rate(numerator: int | float, denominator: int | float) -> float:
    return float(numerator) / float(denominator) if denominator else 0.0


def _qwen_guardrails() -> list[str]:
    return [
        "Force short numbered plans with 3-5 concrete steps.",
        "Prefer direct file edits and minimal diffs over speculative rewrites.",
        "Run targeted validation first before broader verification.",
        "Escalate to review after repeated low-confidence or repair-heavy attempts.",
    ]


def _focus_payload(
    baseline_summary: dict[str, Any],
    benchmark_summary: dict[str, Any],
    blocker_rows: list[dict[str, Any]],
    retry_rows: list[dict[str, Any]],
    action_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    baseline = dict(baseline_summary.get("baseline") or {})
    runtime = dict(baseline_summary.get("runtime") or {})
    review_request_count = int(runtime.get("review_request_count") or 0)
    review_required_count = int(benchmark_summary.get("review_required_count") or 0)
    low_confidence_run_count = int(benchmark_summary.get("low_confidence_run_count") or 0)
    average_repair_count = float(benchmark_summary.get("average_repair_count") or 0.0)

    suggested_workstream = "continue-safe-engine-slices"
    reason = "Recent signals are stable enough for another small engine-owned improvement slice."
    if bool(baseline.get("blocked")):
        suggested_workstream = "unblock-runtime"
        reason = str(baseline.get("reason") or "Baseline is currently blocked by recent failures.")
    elif review_request_count > 0 or review_required_count > 0:
        suggested_workstream = "review-and-triage"
        reason = "Recent runs or experiments still require manual review before widening scope."
    elif blocker_rows and int(blocker_rows[0].get("count") or 0) >= 2:
        suggested_workstream = "stabilize-validation"
        reason = f"Repeated blocker detected: {blocker_rows[0].get('label', 'validation failure')}."
    elif low_confidence_run_count > 0:
        suggested_workstream = "tighten-small-model-scope"
        reason = "Low-confidence patches were observed in recent experiments."
    elif average_repair_count >= 1.0:
        suggested_workstream = "reduce-repair-loops"
        reason = "Repair pressure is still elevated across recent experiments."

    operator_actions: list[str] = []
    if review_request_count > 0 or review_required_count > 0:
        operator_actions.append("Clear review-required runs before scheduling broader autonomous work.")
    if blocker_rows:
        operator_actions.append(
            f"Target the top blocker first: {blocker_rows[0].get('label', 'unknown blocker')} ({int(blocker_rows[0].get('count') or 0)} hits)."
        )
    if retry_rows:
        operator_actions.append(
            f"Bias the next slice toward a single retry policy: {retry_rows[0].get('action', 'repair')} ({int(retry_rows[0].get('count') or 0)} recent experiment rows)."
        )
    if action_rows:
        operator_actions.append(f"Keep the next operator-visible action narrow: {action_rows[0].get('label', 'inspect artifacts')}.")

    deduped_actions: list[str] = []
    seen: set[str] = set()
    for label in operator_actions:
        key = " ".join(label.strip().lower().split())
        if not key or key in seen:
            continue
        seen.add(key)
        deduped_actions.append(label)

    return {
        "suggested_workstream": suggested_workstream,
        "reason": reason,
        "operator_actions": deduped_actions[:4],
        "qwen_guardrails": _qwen_guardrails(),
    }


def build_engine_daily_report(
    project_root: Path,
    *,
    lookback_hours: int = 24,
    run_limit: int = 30,
    experiment_limit: int = 60,
    training_limit: int = 120,
) -> dict[str, Any]:
    baseline_summary = build_engine_baseline_summary(
        project_root,
        lookback_hours=lookback_hours,
        run_limit=run_limit,
        experiment_limit=experiment_limit,
        training_limit=training_limit,
    )

    experiment_dataset_path = assistant_experiment_dataset_path(project_root)
    experiment_rows = _filter_recent_rows(
        _load_jsonl(experiment_dataset_path),
        lookback_hours=lookback_hours,
        limit=experiment_limit,
    )
    benchmark_summary = summarize_experiment_dataset(project_root, rows=experiment_rows, target=experiment_dataset_path)

    blocker_rows = [dict(item) for item in list(benchmark_summary.get("repeated_blockers") or []) if isinstance(item, dict)]
    retry_rows = [dict(item) for item in list(benchmark_summary.get("retry_actions") or []) if isinstance(item, dict)]

    training_output_path = assistant_training_output_path(project_root)
    training_rows = _load_jsonl(training_output_path)[: max(1, training_limit)] if training_output_path.exists() else []
    training_action_counter: Counter[str] = Counter()
    for row in training_rows:
        for label in _parse_training_next_actions(row):
            normalized = str(label or "").strip()
            if normalized:
                training_action_counter[normalized] += 1
    training_action_rows = _top_counter_rows(training_action_counter, {key.lower(): key for key in training_action_counter}, limit=4)

    focus = _focus_payload(
        baseline_summary,
        benchmark_summary,
        blocker_rows,
        retry_rows,
        [dict(item) for item in list(baseline_summary.get("common_recommended_actions") or []) if isinstance(item, dict)]
        or training_action_rows,
    )

    experiments = dict(baseline_summary.get("experiments") or {})
    retry_policy_repair_count = sum(
        int(item.get("count") or 0)
        for item in retry_rows
        if str(item.get("action") or "").strip().lower() == "repair"
    )
    experiments.update(
        {
            "strategy_count": int(benchmark_summary.get("strategy_count") or 0),
            "low_confidence_run_count": int(benchmark_summary.get("low_confidence_run_count") or 0),
            "low_confidence_patch_rate": float(benchmark_summary.get("low_confidence_patch_rate") or 0.0),
            "average_repair_count": float(benchmark_summary.get("average_repair_count") or 0.0),
            "retry_policy_repair_count": retry_policy_repair_count,
            "recommended_next_strategy": str(benchmark_summary.get("recommended_next_strategy") or ""),
            "recommended_next_action": str(benchmark_summary.get("recommended_next_action") or ""),
            "best_strategy": dict(benchmark_summary.get("best_strategy") or {}),
            "weakest_strategy": dict(benchmark_summary.get("weakest_strategy") or {}),
        }
    )

    training = dict(baseline_summary.get("training") or {})
    training.update(
        {
            "next_action_rows": training_action_rows,
        }
    )

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "project_root": str(project_root),
        "window": {
            "lookback_hours": int(lookback_hours),
            "run_limit": int(run_limit),
            "experiment_limit": int(experiment_limit),
            "training_limit": int(training_limit),
        },
        "baseline": dict(baseline_summary.get("baseline") or {}),
        "runtime": dict(baseline_summary.get("runtime") or {}),
        "experiments": experiments,
        "training": training,
        "daily_quota_proof": dict(baseline_summary.get("daily_quota_proof") or {}),
        "daily_focus": focus,
        "top_blockers": blocker_rows[:6],
        "retry_actions": retry_rows[:5],
        "common_recommended_actions": [
            dict(item)
            for item in list(baseline_summary.get("common_recommended_actions") or [])
            if isinstance(item, dict)
        ][:6],
    }


def render_engine_daily_report(report: dict[str, Any]) -> str:
    baseline = dict(report.get("baseline") or {})
    runtime = dict(report.get("runtime") or {})
    experiments = dict(report.get("experiments") or {})
    training = dict(report.get("training") or {})
    daily_quota_proof = dict(report.get("daily_quota_proof") or {})
    daily_focus = dict(report.get("daily_focus") or {})
    blockers = [dict(item) for item in list(report.get("top_blockers") or []) if isinstance(item, dict)]
    retry_actions = [dict(item) for item in list(report.get("retry_actions") or []) if isinstance(item, dict)]
    actions = [dict(item) for item in list(report.get("common_recommended_actions") or []) if isinstance(item, dict)]
    training_actions = [dict(item) for item in list(training.get("next_action_rows") or []) if isinstance(item, dict)]

    def _percent(value: Any) -> str:
        return f"{float(value or 0.0) * 100:.1f}%"

    lines = [
        "# Engine Daily Report",
        "",
        f"- Generated: {report.get('generated_at', '')}",
        f"- Project root: {report.get('project_root', '')}",
        f"- Window: last {dict(report.get('window') or {}).get('lookback_hours', 0)}h",
        "",
        "## Daily Focus",
        "",
        f"- Suggested workstream: {daily_focus.get('suggested_workstream', 'continue-safe-engine-slices')}",
        f"- Reason: {daily_focus.get('reason', 'n/a')}",
        "",
        "## Daily Quota Proof",
        "",
        f"- Focus task: {dict(daily_quota_proof.get('focus_task') or {}).get('title', '') or 'none recorded'}",
        f"- Safe autonomous actions today: {dict(daily_quota_proof.get('autonomous') or {}).get('safe_count', 0)}/{dict(daily_quota_proof.get('autonomous') or {}).get('target', 5)}",
        f"- Safe self-improvement today: {dict(daily_quota_proof.get('self_improvement') or {}).get('safe_count', 0)}/{dict(daily_quota_proof.get('self_improvement') or {}).get('target', 5)}",
        f"- Blocked or rescoped tasks today: {daily_quota_proof.get('blocked_rescoped_count', 0)}",
        f"- Validation today: {dict(daily_quota_proof.get('validation') or {}).get('pass_count', 0)} pass / {dict(daily_quota_proof.get('validation') or {}).get('fail_count', 0)} fail / {dict(daily_quota_proof.get('validation') or {}).get('review_blocked_count', 0)} review-held",
        f"- Do not widen yet because: {daily_quota_proof.get('do_not_widen_yet_because', '') or 'daily quota proof is currently clear'}",
        "",
        "### Operator Actions",
        "",
    ]
    operator_actions = [str(item) for item in list(daily_focus.get("operator_actions") or []) if str(item).strip()]
    if operator_actions:
        lines.extend(f"- {item}" for item in operator_actions)
    else:
        lines.append("- Continue with the next small engine-owned slice.")

    lines.extend(["", "### Small-Model Guardrails", ""])
    lines.extend(f"- {item}" for item in list(daily_focus.get("qwen_guardrails") or []))

    lines.extend(
        [
            "",
            "## Runtime Snapshot",
            "",
            f"- Baseline state: {baseline.get('state', 'unknown')}",
            f"- Blocked: {baseline.get('blocked', False)}",
            f"- Baseline reason: {baseline.get('reason', 'n/a')}",
            f"- Runs analyzed: {runtime.get('run_count', 0)}",
            f"- Success rate: {_percent(runtime.get('success_rate', 0.0))} ({runtime.get('success_count', 0)}/{runtime.get('run_count', 0)})",
            f"- Review request rate: {_percent(runtime.get('review_request_rate', 0.0))} ({runtime.get('review_request_count', 0)}/{runtime.get('run_count', 0)})",
            f"- Executed repair attempts: {runtime.get('repair_attempt_count', 0)} total across {runtime.get('repair_run_count', 0)} repaired runs",
            "",
            "## Experiment Pressure",
            "",
            f"- Experiment rows analyzed: {experiments.get('row_count', 0)}",
            f"- Strategy count: {experiments.get('strategy_count', 0)}",
            f"- Review-required rate: {_percent(experiments.get('review_required_rate', 0.0))}",
            f"- Low-confidence run rate: {_percent(experiments.get('low_confidence_patch_rate', 0.0))} ({experiments.get('low_confidence_run_count', 0)} runs)",
            f"- Average executed repairs per experiment row: {float(experiments.get('average_repair_count', 0.0)):.2f}",
            f"- Retry policy recommending repair: {experiments.get('retry_policy_repair_count', 0)} experiment rows",
            f"- Recommended next action: {experiments.get('recommended_next_action', '') or 'inspect-artifacts'}",
            f"- Recommended next strategy: {experiments.get('recommended_next_strategy', '') or 'n/a'}",
        ]
    )
    if not bool(runtime.get("has_true_execution_runs", False)):
        insert_at = lines.index("## Experiment Pressure") - 1
        lines.insert(insert_at, "- No true execution runs found in the selected window.")
        lines.insert(insert_at, "")

    best_strategy = dict(experiments.get("best_strategy") or {})
    weakest_strategy = dict(experiments.get("weakest_strategy") or {})
    if best_strategy:
        lines.append(
            f"- Best strategy: {best_strategy.get('strategy', '')} ({_percent(best_strategy.get('success_rate', 0.0))} success, avg score {float(best_strategy.get('average_score', 0.0)):.1f})"
        )
    if weakest_strategy:
        lines.append(
            f"- Weakest strategy: {weakest_strategy.get('strategy', '')} ({_percent(weakest_strategy.get('success_rate', 0.0))} success, avg score {float(weakest_strategy.get('average_score', 0.0)):.1f})"
        )
    model_profile_counts = dict(experiments.get("model_profile_counts") or {})
    if model_profile_counts:
        top_profile = max(model_profile_counts.items(), key=lambda item: item[1])
        lines.append(f"- Top model profile: {top_profile[0]} ({top_profile[1]} rows)")

    lines.extend(["", "## Top Blockers", ""])
    if blockers:
        lines.extend(f"- {item.get('label', '')}: {item.get('count', 0)}" for item in blockers)
    else:
        lines.append("- none observed in the selected window")

    lines.extend(["", "## Retry Policy Mix", ""])
    if retry_actions:
        lines.extend(f"- {item.get('action', '')}: {item.get('count', 0)}" for item in retry_actions)
    else:
        lines.append("- none observed in the selected window")

    lines.extend(["", "## Recommended Actions", ""])
    if actions:
        lines.extend(f"- {item.get('label', '')}: {item.get('count', 0)}" for item in actions)
    else:
        lines.append("- none observed in the selected window")

    lines.extend(
        [
            "",
            "## Training Signal Coverage",
            "",
            f"- Training rows analyzed: {training.get('row_count', 0)}",
            f"- Artifact-backed rows: {training.get('artifact_example_count', 0)}",
            f"- Log-backed rows: {training.get('log_example_count', 0)}",
        ]
    )
    if training_actions:
        lines.extend(["", "### Training Next Actions", ""])
        lines.extend(f"- {item.get('label', '')}: {item.get('count', 0)}" for item in training_actions)

    return "\n".join(lines) + "\n"


def write_engine_daily_report(
    project_root: Path,
    report: dict[str, Any],
    *,
    output_dir: Path | None = None,
    write_canonical_markdown: bool = True,
) -> dict[str, Path]:
    target_dir = output_dir or assistant_runs_dir(project_root)
    target_dir.mkdir(parents=True, exist_ok=True)
    json_path = target_dir / "engine_daily_report.json"
    md_path = target_dir / "engine_daily_report.md"
    markdown = render_engine_daily_report(report)
    json_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(markdown, encoding="utf-8")
    written = {"json": json_path, "markdown": md_path}
    if write_canonical_markdown:
        canonical_md_path = project_root / "docs" / "ENGINE_DAILY_REPORT.md"
        canonical_md_path.parent.mkdir(parents=True, exist_ok=True)
        canonical_md_path.write_text(markdown, encoding="utf-8")
        written["canonical_markdown"] = canonical_md_path
    return written


__all__ = [
    "build_engine_daily_report",
    "render_engine_daily_report",
    "write_engine_daily_report",
]
