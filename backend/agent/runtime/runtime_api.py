from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

from backend.agent.adapters.gosenderr_adapter import GoSenderrAdapter
from backend.agent.core.editor_context import augment_ticket_description, normalize_editor_context
from backend.agent.core.runtime_facade import run_autopilot as facade_run_autopilot
from backend.agent.core.runtime_facade import run_ticket as facade_run_ticket

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / "backend" / "scripts"
RUNS_DIR = REPO_ROOT / "docs" / "assistant_runs"
_REPORT_PATH = REPO_ROOT / "docs" / "DEV_ASSISTANT_LOG_REPORT.md"
_TRAINING_OUTPUT = REPO_ROOT / "backend" / "scripts" / "dev_assistant_training.jsonl"
_SCRIPT_CACHE: dict[str, ModuleType] = {}

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


class RuntimeApiError(RuntimeError):
    pass


def _load_script_module(name: str, file_name: str) -> ModuleType:
    cached = _SCRIPT_CACHE.get(name)
    if cached is not None:
        return cached
    file_path = SCRIPTS_DIR / file_name
    spec = importlib.util.spec_from_file_location(name, file_path)
    if spec is None or spec.loader is None:
        raise RuntimeApiError(f"unable to load script module: {file_name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    _SCRIPT_CACHE[name] = module
    return module


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        if not path.exists():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _normalize_ticket_id(value: str | None) -> str:
    raw = str(value or "").strip()
    if not raw:
        raise RuntimeApiError("ticket id is required")
    if raw.isdigit():
        return raw
    if raw.upper().startswith("BAT<") and raw.endswith(">"):
        middle = raw[4:-1]
        if middle.isdigit():
            return middle
    raise RuntimeApiError(f"invalid ticket id: {value}")


def _solo_namespace(command: str, ticket_id: str | None = None, payload: dict[str, Any] | None = None) -> SimpleNamespace:
    data = dict(payload or {})
    selected_action = str(data.get("action") or command or "").strip().lower()
    profile_default = "preview" if selected_action == "run" else "aiWrite"
    return SimpleNamespace(
        ticket=ticket_id,
        desc=data.get("desc"),
        profile=data.get("profile") or profile_default,
        template=data.get("template") or "auto",
        brainstorm=bool(data.get("brainstorm", False)),
        brainstorm_notes=data.get("brainstormNotes") or data.get("brainstorm_notes"),
        interactive=bool(data.get("interactive", False)),
        prefer_domain=data.get("preferDomain") or data.get("prefer_domain"),
        full_verify=bool(data.get("fullVerify", False)),
        max_targeted_tests=int(data.get("maxTargetedTests", 4) or 4),
        skip_verify=bool(data.get("skipVerify", False)),
        skip_preflight=bool(data.get("skipPreflight", False)),
        ship=bool(data.get("ship", False)),
        fix_loop=bool(data.get("fixLoop", False)),
        fix_iterations=int(data.get("fixIterations", 1) or 1),
        safe_mode=bool(data.get("safeMode", False)),
        safe_max_files=int(data.get("safeMaxFiles", 0) or 0),
        allow_protected=bool(data.get("allowProtected", False)),
        allow_ship_in_safe_mode=bool(data.get("allowShipInSafeMode", False)),
        prepare_sandbox=bool(data.get("prepareSandbox", False)),
        sandbox_dir=data.get("sandboxDir"),
        skip_learn=bool(data.get("skipLearn", False)),
        print_learn=bool(data.get("printLearn", False)),
        mode=data.get("mode") or "integrate",
        action=data.get("action") or "implement",
        count=int(data.get("count", 5) or 5),
        status=data.get("status") or "TODO",
        require_tag=data.get("requireTag") or data.get("require_tag"),
        require_text=data.get("requireText") or data.get("require_text"),
        continue_on_fail=bool(data.get("continueOnFail", False)),
        cooldown_minutes=int(data.get("cooldownMinutes", 0) or 0),
    )


def _latest_matching_artifact(pattern: str, *, started_mtime_ns: int) -> Path | None:
    candidates = sorted(RUNS_DIR.glob(pattern), key=lambda item: item.stat().st_mtime_ns if item.exists() else 0, reverse=True)
    for candidate in candidates:
        try:
            if candidate.stat().st_mtime_ns >= started_mtime_ns:
                return candidate
        except FileNotFoundError:
            continue
    return candidates[0] if candidates else None


def _solo_result(action: str, ticket_id: str, exit_code: int, artifact_path: Path | None) -> dict[str, Any]:
    artifact = _read_json(artifact_path) if artifact_path else None
    checks = list(artifact.get("checks", [])) if isinstance(artifact, dict) else []
    ok = exit_code == 0
    if isinstance(artifact, dict) and "all_checks_passed" in artifact:
        ok = ok and bool(artifact.get("all_checks_passed"))
    return {
        "ok": ok,
        "action": action,
        "ticket": ticket_id,
        "exitCode": exit_code,
        "checks": checks,
        "artifact": artifact,
        "artifactPaths": [str(artifact_path)] if artifact_path else [],
        "label": f"{action.upper()} BAT<{ticket_id}>",
    }


def _runtime_args(**overrides: Any) -> SimpleNamespace:
    base = {
        "write": False,
        "plan": False,
        "execute": False,
        "autopilot": False,
        "batch": False,
        "schedule": None,
        "pilot": False,
        "implement": False,
        "confirm": False,
        "repair": False,
        "repair_last": False,
        "notify_url": None,
        "ci_report": None,
        "ai": False,
        "git": False,
        "interactive": False,
        "brainstorm": False,
        "brainstorm_notes": False,
        "template": None,
        "train": False,
        "openai": False,
        "fine_tune_model": None,
        "config": {},
        "editor_context": {},
    }
    base.update(overrides)
    return SimpleNamespace(**base)


def run_ticket(ticket_id: str, mode: str, options: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = dict(options or {})
    normalized = _normalize_ticket_id(ticket_id)
    editor_context = normalize_editor_context(payload.get("editor_context") or payload.get("editorContext"))
    if mode in {"run", "implement"}:
        solo = _load_script_module("runtime_api_solo_dev_assistant", "solo_dev_assistant.py")
        started_mtime_ns = RUNS_DIR.stat().st_mtime_ns if RUNS_DIR.exists() else 0
        args = _solo_namespace(mode, normalized, payload)
        ticket_desc = payload.get("desc") or GoSenderrAdapter(REPO_ROOT).load_tickets().get(normalized, "")
        args.desc = augment_ticket_description(ticket_desc, editor_context)
        args.editor_context = editor_context
        exit_code = solo.run_pipeline_command(args) if mode == "run" else solo.run_implement_command(args)
        artifact_path = RUNS_DIR / f"BAT{normalized}_{mode}.json"
        if not artifact_path.exists():
            artifact_path = _latest_matching_artifact(f"BAT{normalized}_{mode}.json", started_mtime_ns=started_mtime_ns)
        return _solo_result(mode, normalized, exit_code, artifact_path)

    adapter = GoSenderrAdapter(REPO_ROOT)
    runtime_result = facade_run_ticket(
        adapter,
        normalized,
        mode=mode,
        args=_runtime_args(
            plan=bool(payload.get("plan", False)),
            execute=bool(payload.get("execute", False)),
            write=bool(payload.get("write", False)),
            confirm=bool(payload.get("confirm", False)),
            repair=bool(payload.get("repair", False)),
            template=payload.get("template"),
            brainstorm=bool(payload.get("brainstorm", False)),
            brainstorm_notes=payload.get("brainstormNotes") or payload.get("brainstorm_notes"),
            interactive=bool(payload.get("interactive", False)),
            ai=bool(payload.get("ai", False)),
            git=bool(payload.get("git", False)),
            editor_context=editor_context,
        ),
        project_root=REPO_ROOT,
        editor_context=editor_context,
    )
    validation = runtime_result.get("validation", {}) if isinstance(runtime_result, dict) else {}
    return {
        "ok": bool(runtime_result.get("ok", False)),
        "action": mode,
        "ticket": normalized,
        "exitCode": 0 if runtime_result.get("ok", False) else 1,
        "checks": list(validation.get("results", [])) if isinstance(validation, dict) else [],
        "artifact": runtime_result,
        "artifactPaths": [str(runtime_result.get("artifacts", {}).get("run_artifact"))] if runtime_result.get("artifacts", {}).get("run_artifact") else [],
        "label": f"{mode.upper()} BAT<{normalized}>",
        "editor_context": editor_context,
    }


def run_batch(action: str, filters: dict[str, Any] | None = None, options: dict[str, Any] | None = None) -> dict[str, Any]:
    selected_action = str(action or "implement").strip().lower()
    if selected_action not in {"run", "implement"}:
        raise RuntimeApiError(f"unsupported batch action: {action}")
    solo = _load_script_module("runtime_api_solo_dev_assistant", "solo_dev_assistant.py")
    combined = dict(filters or {})
    combined.update(options or {})
    combined["action"] = selected_action
    started_mtime_ns = RUNS_DIR.stat().st_mtime_ns if RUNS_DIR.exists() else 0
    exit_code = solo.run_sprint_command(_solo_namespace("sprint", None, combined))
    artifact_path = _latest_matching_artifact(f"sprint_{selected_action}_*.json", started_mtime_ns=started_mtime_ns)
    artifact = _read_json(artifact_path) if artifact_path else None
    return {
        "ok": exit_code == 0,
        "action": selected_action,
        "ticket": "",
        "exitCode": exit_code,
        "checks": [],
        "artifact": artifact,
        "artifactPaths": [str(artifact_path)] if artifact_path else [],
        "label": f"SPRINT {selected_action.upper()} x{combined.get('count', 5)}",
    }


def chat(prompt: str, context: dict[str, Any] | None = None) -> dict[str, Any]:
    assistant = _load_script_module("runtime_api_dev_assistant", "dev_assistant.py")
    env_overrides = dict((context or {}).get("env", {}))
    original: dict[str, str | None] = {}
    for key, value in env_overrides.items():
        original[key] = os.environ.get(key)
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = str(value)
    try:
        reply = assistant.ai_generate(prompt=prompt)
    finally:
        for key, value in original.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
    return {"ok": True, "reply": str(reply or "")}


def train(options: dict[str, Any] | None = None) -> dict[str, Any]:
    trainer = _load_script_module("runtime_api_train_dev_assistant", "train_dev_assistant.py")
    payload = dict(options or {})
    output_path = Path(payload.get("output") or _TRAINING_OUTPUT)
    log_path = Path(payload.get("log") or trainer.LOG_DEFAULT)
    min_diff = int(payload.get("minDiff", 1) or 1)
    entries = trainer.load_entries(log_path)
    lines: list[str] = []
    for entry in entries:
        example = trainer.make_training_example(entry)
        if not example:
            continue
        if len(example.get("completion", "")) < min_diff:
            continue
        lines.append(json.dumps(example, ensure_ascii=False))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    return {
        "ok": True,
        "outputPath": str(output_path),
        "exampleCount": len(lines),
        "label": "TRAIN ASSISTANT",
    }


def analyze_logs(options: dict[str, Any] | None = None) -> dict[str, Any]:
    analyzer = _load_script_module("runtime_api_analyze_dev_assistant_log", "analyze_dev_assistant_log.py")
    payload = dict(options or {})
    log_path = Path(payload.get("log") or analyzer.LOG_PATH)
    write_report = bool(payload.get("writeReport", payload.get("write_report", True)))
    entries = analyzer.parse_log(log_path)
    tickets = analyzer.load_tickets()
    report = analyzer.render_report(entries, tickets)
    report_path = Path(payload.get("reportPath") or _REPORT_PATH)
    if write_report:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(report + "\n", encoding="utf-8")
    return {
        "ok": True,
        "report": report,
        "reportPath": str(report_path) if write_report else None,
        "entryCount": len(entries),
        "label": "ANALYZE LOG",
    }


def start_scheduler(options: dict[str, Any] | None = None) -> dict[str, Any]:
    del options
    autopilot = _load_script_module("runtime_api_autopilot", "autopilot.py")
    autopilot.main()
    return {"ok": True, "running": False, "message": "scheduler stopped"}


def stop_scheduler() -> dict[str, Any]:
    return {"ok": True, "message": "scheduler stop is managed by the host process"}


def dispatch_action(request: dict[str, Any]) -> dict[str, Any]:
    action = str(request.get("action") or "").strip().lower()
    if action == "run":
        return run_ticket(str(request.get("ticket") or ""), "run", request)
    if action == "implement":
        return run_ticket(str(request.get("ticket") or ""), "implement", request)
    if action == "sprint":
        return run_batch(
            str(request.get("sprintAction") or "run"),
            {
                "count": request.get("count", 5),
                "status": request.get("status", "TODO"),
                "requireTag": request.get("requireTag"),
                "requireText": request.get("requireText"),
                "preferDomain": request.get("preferDomain"),
            },
            request,
        )
    if action == "autopilot":
        return run_batch(
            str(request.get("sprintAction") or request.get("autopilotAction") or "implement"),
            {
                "count": request.get("count", request.get("autopilotCount", 1)),
                "status": request.get("status", "TODO"),
                "requireTag": request.get("requireTag"),
                "requireText": request.get("requireText"),
                "preferDomain": request.get("preferDomain"),
            },
            request,
        )
    if action == "analyze-log":
        return analyze_logs({"writeReport": True})
    if action == "train":
        return train(request)
    raise RuntimeApiError(f"unsupported action: {action}")


def _parse_payload(value: str | None) -> dict[str, Any]:
    if not value:
        return {}
    try:
        payload = json.loads(value)
    except json.JSONDecodeError as exc:
        raise RuntimeApiError(f"invalid payload json: {exc}") from exc
    if not isinstance(payload, dict):
        raise RuntimeApiError("payload must decode to an object")
    return payload


def _emit_result(result_file: str | None, payload: dict[str, Any]) -> None:
    if result_file:
        _write_json(Path(result_file), payload)
    else:
        print(json.dumps(payload))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Runtime API boundary for GoSenderr agent hosts")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("action", "chat", "train", "analyze-logs", "scheduler-start", "scheduler-stop"):
        sub = subparsers.add_parser(command)
        sub.add_argument("--payload-json", help="json payload object")
        sub.add_argument("--result-file", help="path for structured json result")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        payload = _parse_payload(getattr(args, "payload_json", None))
        if args.command == "action":
            result = dispatch_action(payload.get("request", payload))
            _emit_result(args.result_file, result)
            return int(result.get("exitCode", 0) or 0)
        if args.command == "chat":
            result = chat(str(payload.get("prompt") or ""), payload.get("context") or {})
            _emit_result(args.result_file, result)
            return 0
        if args.command == "train":
            result = train(payload)
            _emit_result(args.result_file, result)
            return 0
        if args.command == "analyze-logs":
            result = analyze_logs(payload)
            _emit_result(args.result_file, result)
            return 0
        if args.command == "scheduler-start":
            started = {"ok": True, "running": True, "message": "scheduler starting"}
            _emit_result(args.result_file, started)
            start_scheduler(payload)
            return 0
        if args.command == "scheduler-stop":
            result = stop_scheduler()
            _emit_result(args.result_file, result)
            return 0
        raise RuntimeApiError(f"unsupported command: {args.command}")
    except RuntimeApiError as exc:
        error_payload = {"ok": False, "error": str(exc)}
        _emit_result(getattr(args, "result_file", None), error_payload)
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
