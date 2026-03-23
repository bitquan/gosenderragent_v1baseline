#!/usr/bin/env python3
"""Generate curated training data from assistant logs and run artifacts."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = Path(os.environ.get("PROJECT_ROOT", str(SCRIPT_DIR.parents[1]))).expanduser().resolve()
if str(REPO_ROOT) not in sys.path:
	 sys.path.insert(0, str(REPO_ROOT))

from backend.agent.core.storage_paths import assistant_dev_data_dir, assistant_dev_runs_dir, assistant_log_path, assistant_runs_dir, assistant_training_output_path
from backend.scripts.solo_dev_assistant_config import ASSISTANT_SELF_PATH_PREFIXES


LOG_DEFAULT = assistant_log_path(REPO_ROOT)
OUTPUT_DEFAULT = assistant_training_output_path(REPO_ROOT)
RUNS_DEFAULT = assistant_runs_dir(REPO_ROOT)
BOARD_DEFAULT = REPO_ROOT / "docs" / "BAT_FEATURE_BOARD.md"
LOCAL_EXPORT_DEFAULT_FORMAT = "qwen-ollama"
LOCAL_EXPORT_SYSTEM_PROMPT = "You are GitHub Copilot working on the GoSenderr dev agent platform. Stay repository-grounded, concise, and safe."


def load_entries(path: Path) -> list[dict[str, Any]]:
	rows: list[dict[str, Any]] = []
	if not path.exists():
		return rows
	for line in path.read_text(encoding="utf-8").splitlines():
		line = line.strip()
		if not line:
			continue
		try:
			payload = json.loads(line)
		except json.JSONDecodeError:
			continue
		if isinstance(payload, dict):
			rows.append(payload)
	return rows


def load_ticket_board(path: Path) -> dict[str, str]:
	tickets: dict[str, str] = {}
	if not path.exists():
		return tickets
	for line in path.read_text(encoding="utf-8").splitlines():
		line = line.strip()
		if not line.startswith("- `BAT<"):
			continue
		try:
			head, desc = line.split("`", 2)[1], line.split("`", 2)[2].strip()
			ticket_id = head.removeprefix("BAT<").removesuffix(">")
		except Exception:
			continue
		if ticket_id.isdigit() and ticket_id not in tickets:
			tickets[ticket_id] = desc
	return tickets


def _dedupe_paths(paths: list[Path]) -> list[Path]:
	seen: set[Path] = set()
	result: list[Path] = []
	for path in paths:
		resolved = path.expanduser()
		if resolved in seen:
			continue
		seen.add(resolved)
		result.append(resolved)
	return result


def resolve_runs_dirs(paths: list[Path] | None = None) -> list[Path]:
	candidates = list(paths or [])
	if not candidates:
		candidates.extend([
			RUNS_DEFAULT,
			assistant_dev_runs_dir(REPO_ROOT),
			REPO_ROOT / ".dev_agent_runs",
		])
	return _dedupe_paths(candidates)


def load_artifact_entries(runs_dirs: list[Path]) -> list[dict[str, Any]]:
	rows: list[dict[str, Any]] = []
	for runs_dir in _dedupe_paths(runs_dirs):
		if not runs_dir.exists():
			continue
		for pattern in ("BAT*_implement.json", "BAT*_run.json"):
			for artifact in sorted(runs_dir.glob(pattern)):
				try:
					payload = json.loads(artifact.read_text(encoding="utf-8"))
				except Exception:
					continue
				if isinstance(payload, dict):
					payload.setdefault("_artifact_path", str(artifact))
					rows.append(payload)
	return rows


def make_training_example(entry: dict[str, Any]) -> dict[str, str] | None:
	desc = entry.get("desc") or ""
	diff = entry.get("diff") or ""
	if not diff.strip():
		return None
	prompt = f"Scaffold BAT<{entry.get('ticket', '')}>, description:\n{desc}\n\n"
	completion = diff.strip() + "\n"
	return {"prompt": prompt, "completion": completion}


def _artifact_example_metadata(entry: dict[str, Any]) -> dict[str, Any]:
	trust_summary = dict(entry.get("trust_summary") or {})
	experiment_benchmark_summary = dict(entry.get("experiment_benchmark_summary") or {})
	approved = str(entry.get("review_state") or entry.get("approval_state") or "").strip().lower() in {"approved", "trusted"}
	trusted = str(trust_summary.get("trust_state") or "").strip().lower() == "trusted" or bool(entry.get("trusted"))
	return {
		"gs_dev1_profile_id": str(entry.get("model_profile_id") or entry.get("modelProfileId") or "").strip(),
		"gs_dev1_base_model": str(entry.get("base_model") or entry.get("baseModel") or entry.get("model") or "").strip(),
		"gs_dev1_task_mode": str(entry.get("task_mode") or entry.get("taskMode") or "").strip(),
		"gs_dev1_trust_state": str(trust_summary.get("trust_state") or "").strip(),
		"gs_dev1_approval_state": str(entry.get("approval_state") or entry.get("review_state") or "").strip(),
		"gs_dev1_benchmark_tags": list(experiment_benchmark_summary.get("benchmark_tags") or entry.get("benchmark_tags") or []),
		"gs_dev1_dataset_eligible": bool(trusted or approved),
	}


def is_assistant_self_artifact(entry: dict[str, Any]) -> bool:
	if str(entry.get("domain_focus") or "").strip().lower() == "assistant_runtime":
		return True
	if str(entry.get("priority_tag") or "").strip().upper() == "OPS":
		return True
	for path in entry.get("created_files") or []:
		if str(path).startswith(ASSISTANT_SELF_PATH_PREFIXES):
			return True
	return False


def make_artifact_training_example(
	entry: dict[str, Any],
	*,
	tickets: dict[str, str],
	assistant_only: bool = False,
) -> dict[str, Any] | None:
	if not entry.get("all_checks_passed"):
		return None
	if assistant_only and not is_assistant_self_artifact(entry):
		return None
	ticket_id = str(entry.get("ticket") or "").strip()
	desc = tickets.get(ticket_id, "").strip()
	if not ticket_id or not desc:
		return None
	checks = [row for row in (entry.get("checks") or []) if isinstance(row, dict)]
	targeted = list(entry.get("targeted_tests") or [])
	created = list(entry.get("created_files") or [])
	critique = entry.get("critique") or {}
	strengths = [str(row).strip() for row in critique.get("strengths") or [] if str(row).strip()]
	next_actions = [str(row).strip() for row in critique.get("next_actions") or [] if str(row).strip()]
	verified_checks = [str(row.get("name") or "").strip() for row in checks if row.get("ok") and str(row.get("name") or "").strip()]
	prompt = (
		f"Implement BAT<{ticket_id}> safely in the GoSenderr dev agent platform.\n"
		f"Domain: {entry.get('domain_focus') or 'unknown'}\n"
		f"Priority: {entry.get('priority_tag') or 'unknown'}\n"
		f"Mode: {entry.get('mode') or 'unknown'}\n\n"
		f"Ticket description:\n{desc}\n"
	)
	completion_lines = ["Implementation summary:"]
	if created:
		completion_lines.append("Touched files:")
		completion_lines.extend(f"- {row}" for row in created)
	if targeted:
		completion_lines.append("Targeted tests:")
		completion_lines.extend(f"- {row}" for row in targeted)
	if verified_checks:
		completion_lines.append("Verified checks:")
		completion_lines.extend(f"- {row}" for row in verified_checks)
	if strengths:
		completion_lines.append("Strengths:")
		completion_lines.extend(f"- {row}" for row in strengths)
	if next_actions:
		completion_lines.append("Next actions:")
		completion_lines.extend(f"- {row}" for row in next_actions)
	if len(completion_lines) == 1:
		return None
	return {
		"prompt": prompt,
		"completion": "\n".join(completion_lines).strip() + "\n",
		"metadata": _artifact_example_metadata(entry),
	}


def collect_training_examples(
	*,
	log_entries: list[dict[str, Any]],
	artifact_entries: list[dict[str, Any]],
	tickets: dict[str, str],
	assistant_only: bool,
	min_diff: int,
) -> list[dict[str, str]]:
	examples: list[dict[str, str]] = []
	seen: set[tuple[str, str]] = set()
	for entry in log_entries:
		example = make_training_example(entry)
		if not example or len(example["completion"]) < min_diff:
			continue
		key = (example["prompt"], example["completion"])
		if key in seen:
			continue
		seen.add(key)
		examples.append(example)
	for entry in artifact_entries:
		example = make_artifact_training_example(entry, tickets=tickets, assistant_only=assistant_only)
		if not example or len(example["completion"]) < min_diff:
			continue
		key = (example["prompt"], example["completion"])
		if key in seen:
			continue
		seen.add(key)
		examples.append(example)
	return examples


def evaluate_training_quality(
	*,
	dataset: dict[str, Any],
	min_examples: int,
	min_log_examples: int,
	min_artifact_examples: int,
) -> dict[str, Any]:
	example_count = int(dataset.get("example_count", 0))
	log_example_count = int(dataset.get("log_example_count", 0))
	artifact_example_count = int(dataset.get("artifact_example_count", 0))
	checks = [
		{
			"name": "example_count",
			"ok": example_count >= min_examples,
			"actual": example_count,
			"minimum": min_examples,
		},
		{
			"name": "log_example_count",
			"ok": log_example_count >= min_log_examples,
			"actual": log_example_count,
			"minimum": min_log_examples,
		},
		{
			"name": "artifact_example_count",
			"ok": artifact_example_count >= min_artifact_examples,
			"actual": artifact_example_count,
			"minimum": min_artifact_examples,
		},
	]
	passed = all(check["ok"] for check in checks)
	failures = [
		f"{check['name']} {check['actual']} < {check['minimum']}"
		for check in checks
		if not check["ok"]
	]
	return {
		"passed": passed,
		"state": "ready" if passed else "warn",
		"checks": checks,
		"summary": "dataset ready for training" if passed else "; ".join(failures),
	}


def normalize_local_export_format(value: str | None) -> str:
	format_name = str(value or "").strip().lower()
	if format_name in {"qwen", "ollama", "qwen-ollama", "qwen_ollama"}:
		return LOCAL_EXPORT_DEFAULT_FORMAT
	return ""


def _build_local_messages_example(example: dict[str, str]) -> dict[str, Any] | None:
	prompt = str(example.get("prompt") or "").strip()
	completion = str(example.get("completion") or "").strip()
	if not prompt or not completion:
		return None
	return {
		"messages": [
			{"role": "system", "content": LOCAL_EXPORT_SYSTEM_PROMPT},
			{"role": "user", "content": prompt},
			{"role": "assistant", "content": completion},
		],
	}


def write_local_training_export(
	*,
	repo_root: Path,
	dataset: dict[str, Any],
	output_path: Path,
	export_format: str,
	base_model: str,
) -> dict[str, Any]:
	format_name = normalize_local_export_format(export_format)
	if not format_name:
		return {}
	stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
	exports_root = assistant_dev_data_dir(repo_root) / "local_training_exports" / format_name
	bundle_dir = exports_root / stamp
	bundle_dir.mkdir(parents=True, exist_ok=True)
	message_examples = [
		row for row in (
			_build_local_messages_example(example)
			for example in dataset.get("examples") or []
		)
		if row
	]
	messages_path = bundle_dir / "train.messages.jsonl"
	messages_path.write_text(
		"\n".join(json.dumps(row, ensure_ascii=False) for row in message_examples) + ("\n" if message_examples else ""),
		encoding="utf-8",
	)
	modelfile_path = bundle_dir / "Modelfile"
	modelfile_path.write_text(
		"\n".join([
			f"FROM {base_model}",
			"# Replace ./adapter with the LoRA/QLoRA adapter directory produced by your local trainer.",
			"ADAPTER ./adapter",
			"PARAMETER temperature 0.2",
			f"SYSTEM {json.dumps(LOCAL_EXPORT_SYSTEM_PROMPT)}",
			"",
		]),
		encoding="utf-8",
	)
	manifest_path = bundle_dir / "manifest.json"
	manifest = {
		"kind": "assistant-local-training-export",
		"generated_at": datetime.now(timezone.utc).isoformat(),
		"variant_id": f"{format_name}-{stamp}",
		"worker_family": "qwen",
		"worker_variant_type": "adapter-export",
		"format": format_name,
		"provider": "ollama",
		"base_model": base_model,
		"dataset_path": str(output_path),
		"bundle_dir": str(bundle_dir),
		"adapter_dir": str(bundle_dir / "adapter"),
		"adapter_artifact": str(bundle_dir / "adapter"),
		"messages_path": str(messages_path),
		"modelfile_path": str(modelfile_path),
		"ollama_model_name": "gosenderr-qwen-local",
		"promotion_policy_default": "manual-promote",
		"promotion_readiness": "exported",
		"rollback_source": base_model,
		"tensor_merge_supported": True,
		"example_count": len(message_examples),
		"quality_gate": dataset.get("quality_gate") or {},
		"notes": [
			"Ollama does not run fine-tuning directly; train a local adapter with your preferred Qwen-compatible trainer, then import it with the generated Modelfile.",
			"The exported JSONL uses system/user/assistant chat messages suitable for local instruction tuning workflows.",
		],
		"recommended_steps": [
			"Train a LoRA/QLoRA adapter from train.messages.jsonl with a Qwen-compatible local trainer.",
			"Place the resulting adapter folder beside the generated Modelfile as ./adapter or update the ADAPTER path.",
			"Run `ollama create gosenderr-qwen-local -f Modelfile` to register the tuned model in Ollama.",
		],
	}
	manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
	readme_path = bundle_dir / "README.md"
	readme_path.write_text(
		"\n".join([
			"# Local Qwen / Ollama training export",
			"",
			f"Base model: `{base_model}`",
			f"Export format: `{format_name}`",
			"",
			"Files:",
			"- `train.messages.jsonl` — chat-style training rows for local instruction tuning",
			"- `manifest.json` — export metadata and recommended steps",
			"- `Modelfile` — Ollama import template for the trained adapter",
			"",
			"Suggested workflow:",
			"1. Train a Qwen-compatible LoRA/QLoRA adapter from `train.messages.jsonl` using your local trainer.",
			"2. Put the adapter folder next to `Modelfile` as `./adapter`, or update the `ADAPTER` line.",
			"3. Create the Ollama model:",
			"   `ollama create gosenderr-qwen-local -f Modelfile`",
			"4. Point the engine to the new local model name in runtime settings.",
		]),
		encoding="utf-8",
	)
	return {
		"requested": True,
		"ready": True,
		"format": format_name,
		"provider": "ollama",
		"base_model": base_model,
		"bundle_dir": str(bundle_dir),
		"messages_path": str(messages_path),
		"manifest_path": str(manifest_path),
		"modelfile_path": str(modelfile_path),
		"readme_path": str(readme_path),
		"example_count": len(message_examples),
	}


def build_training_dataset(
	*,
	log_path: Path,
	runs_dirs: list[Path] | None,
	board_path: Path,
	assistant_only: bool,
	min_diff: int,
	min_examples: int = 2,
	min_log_examples: int = 1,
	min_artifact_examples: int = 1,
) -> dict[str, Any]:
	resolved_runs_dirs = resolve_runs_dirs(runs_dirs)
	log_entries = load_entries(log_path)
	artifact_entries = load_artifact_entries(resolved_runs_dirs)
	tickets = load_ticket_board(board_path)
	examples: list[dict[str, str]] = []
	seen: set[tuple[str, str]] = set()
	log_example_count = 0
	artifact_example_count = 0
	gs_dev1_eligible_example_count = 0
	skipped_empty = 0
	skipped_min_diff = 0

	for entry in log_entries:
		example = make_training_example(entry)
		if not example:
			skipped_empty += 1
			continue
		if len(example["completion"]) < min_diff:
			skipped_min_diff += 1
			continue
		key = (example["prompt"], example["completion"])
		if key in seen:
			continue
		seen.add(key)
		examples.append(example)
		log_example_count += 1

	for entry in artifact_entries:
		example = make_artifact_training_example(entry, tickets=tickets, assistant_only=assistant_only)
		if not example:
			skipped_empty += 1
			continue
		if len(example["completion"]) < min_diff:
			skipped_min_diff += 1
			continue
		key = (example["prompt"], example["completion"])
		if key in seen:
			continue
		seen.add(key)
		examples.append(example)
		artifact_example_count += 1
		if bool(dict(example.get("metadata") or {}).get("gs_dev1_dataset_eligible")):
			gs_dev1_eligible_example_count += 1

	dataset = {
		"examples": examples,
		"log_entries": log_entries,
		"artifact_entries": artifact_entries,
		"tickets": tickets,
		"runs_dirs": [str(path) for path in resolved_runs_dirs],
		"log_entry_count": len(log_entries),
		"artifact_entry_count": len(artifact_entries),
		"log_example_count": log_example_count,
		"artifact_example_count": artifact_example_count,
		"gs_dev1_eligible_example_count": gs_dev1_eligible_example_count,
		"example_count": len(examples),
		"skipped_empty_count": skipped_empty,
		"skipped_min_diff_count": skipped_min_diff,
		"assistant_only": bool(assistant_only),
		"board_path": str(board_path),
		"log_path": str(log_path),
	}
	dataset["quality_gate"] = evaluate_training_quality(
		dataset=dataset,
		min_examples=min_examples,
		min_log_examples=min_log_examples,
		min_artifact_examples=min_artifact_examples,
	)
	return dataset


def write_training_status(
	*,
	repo_root: Path,
	output_path: Path,
	dataset: dict[str, Any],
	quality_gate: dict[str, Any],
	model_to_use: str | None = None,
	fine_tune_requested: bool = False,
	local_export: dict[str, Any] | None = None,
	tuning: dict[str, Any] | None = None,
) -> Path:
	runs_dir = assistant_runs_dir(repo_root)
	runs_dir.mkdir(parents=True, exist_ok=True)
	payload = {
		"generated_at": datetime.now(timezone.utc).isoformat(),
		"ok": bool(quality_gate.get("passed", False)),
		"output_path": str(output_path),
		"example_count": int(dataset.get("example_count", 0)),
		"log_example_count": int(dataset.get("log_example_count", 0)),
		"artifact_example_count": int(dataset.get("artifact_example_count", 0)),
		"gs_dev1_eligible_example_count": int(dataset.get("gs_dev1_eligible_example_count", 0)),
		"log_entry_count": int(dataset.get("log_entry_count", 0)),
		"artifact_entry_count": int(dataset.get("artifact_entry_count", 0)),
		"quality_gate": quality_gate,
		"fine_tune_requested": bool(fine_tune_requested),
		"fine_tune_model": model_to_use or "",
		"local_export": local_export or {},
		"tuning": tuning or {},
	}
	status_path = runs_dir / "assistant_training_status.json"
	status_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
	return status_path


def main() -> None:
	parser = argparse.ArgumentParser(description="Create curated training data from assistant logs and run artifacts")
	parser.add_argument("--log", type=Path, default=LOG_DEFAULT, help="path to dev_assistant.log")
	parser.add_argument("--runs-dir", type=Path, action="append", default=[], help="run artifact directory to scan (repeatable)")
	parser.add_argument("--board", type=Path, default=BOARD_DEFAULT, help="path to BAT board")
	parser.add_argument("--output", type=Path, default=OUTPUT_DEFAULT, help="output jsonl file")
	parser.add_argument("--assistant-only", action="store_true", help="only include assistant self-build artifact examples")
	parser.add_argument("--min-diff", type=int, default=1, help="minimum completion length to include")
	parser.add_argument("--min-examples", type=int, default=2, help="minimum total examples required for a healthy dataset")
	parser.add_argument("--min-log-examples", type=int, default=1, help="minimum log-derived examples required for a healthy dataset")
	parser.add_argument("--min-artifact-examples", type=int, default=1, help="minimum artifact-derived examples required for a healthy dataset")
	parser.add_argument("--fail-on-quality-gate", action="store_true", help="exit non-zero when the dataset quality gate is not satisfied")
	parser.add_argument("--fine-tune-model", help="start an OpenAI fine-tune job using this base model")
	parser.add_argument("--openai", action="store_true", help="alias for --fine-tune-model with default model gpt-4o-mini")
	parser.add_argument("--local-export-format", help="export a local Qwen/Ollama tuning bundle (example: qwen-ollama)")
	parser.add_argument("--local-base-model", help="base local model name to reference in the export bundle")
	parser.add_argument("--training-profile", default="medium", help="resource tuning profile label (low, medium, high)")
	parser.add_argument("--thread-limit", type=int, help="requested thread limit for the tuned run")
	parser.add_argument("--cpu-limit-percent", type=int, help="requested CPU ceiling for the tuned run")
	parser.add_argument("--thermal-ceiling-c", type=int, help="requested thermal ceiling for the tuned run")
	args = parser.parse_args()

	dataset = build_training_dataset(
		log_path=args.log,
		runs_dirs=args.runs_dir,
		board_path=args.board,
		assistant_only=bool(args.assistant_only),
		min_diff=args.min_diff,
		min_examples=args.min_examples,
		min_log_examples=args.min_log_examples,
		min_artifact_examples=args.min_artifact_examples,
	)
	out_lines = [json.dumps(example, ensure_ascii=False) for example in dataset["examples"]]

	args.output.parent.mkdir(parents=True, exist_ok=True)
	args.output.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
	print(
		"wrote "
		f"{dataset['example_count']} examples "
		f"({dataset['log_example_count']} log + {dataset['artifact_example_count']} artifact) "
		f"to {args.output}"
	)
	quality_gate = dataset.get("quality_gate") or {}
	print(f"quality gate: {quality_gate.get('state', 'idle')} • {quality_gate.get('summary', 'n/a')}")
	local_export: dict[str, Any] = {}
	local_export_format = normalize_local_export_format(args.local_export_format)
	if local_export_format:
		local_export = write_local_training_export(
			repo_root=REPO_ROOT,
			dataset=dataset,
			output_path=args.output,
			export_format=local_export_format,
			base_model=str(args.local_base_model or os.environ.get("OLLAMA_MODEL") or "qwen2.5-coder:7b").strip() or "qwen2.5-coder:7b",
		)
		print(
			"local export: "
			f"{local_export.get('format', local_export_format)} • "
			f"{local_export.get('bundle_dir', '')}"
		)

	model_to_use = None
	if args.openai and not args.fine_tune_model:
		model_to_use = "gpt-4o-mini"
	elif args.fine_tune_model:
		model_to_use = args.fine_tune_model

	write_training_status(
		repo_root=REPO_ROOT,
		output_path=args.output,
		dataset=dataset,
		quality_gate=quality_gate,
		model_to_use=model_to_use,
		fine_tune_requested=bool(model_to_use),
		local_export=local_export,
		tuning={
			"profile": str(args.training_profile or "medium"),
			"thread_limit": int(args.thread_limit or 0),
			"cpu_limit_percent": int(args.cpu_limit_percent or 0),
			"thermal_ceiling_c": int(args.thermal_ceiling_c or 0),
		},
	)

	if args.fail_on_quality_gate and not quality_gate.get("passed", False):
		raise SystemExit(2)

	if not model_to_use:
		return

	key = os.environ.get("OPENAI_API_KEY")
	if not key:
		print("OPENAI_API_KEY not set; cannot launch fine-tune")
		return

	try:
		print(f"starting fine-tune with model {model_to_use}...")
		subprocess.check_call(
			[
				"openai",
				"api",
				"fine_tunes.create",
				"-t",
				str(args.output),
				"-m",
				model_to_use,
			]
		)
	except Exception as exc:
		print(f"fine-tune invocation failed: {exc}")


if __name__ == "__main__":
	main()
