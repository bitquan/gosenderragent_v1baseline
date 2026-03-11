from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, Callable

from backend.agent.agents import ImplementerAgent, PlannerAgent, ReleaseAgent, RepairAgent, ValidatorAgent
from backend.agent.core.editor_context import normalize_editor_context
from backend.agent.core.agent_registry import AgentRegistry, build_default_agent_registry
from backend.agent.core.permissions import PermissionRegistry, ToolPermissionError, build_default_permissions


RUNTIME_AGENT_REQUIRED_TOOLS: dict[str, tuple[str, ...]] = {
    "planner": ("read_file", "search_repo", "list_tasks"),
    "implementer": ("read_file", "search_repo", "edit_file", "run_command"),
    "validator": ("read_file", "search_repo", "run_command"),
    "repair": ("read_file", "search_repo", "edit_file", "run_command"),
    "release": ("read_file", "git_status", "notify"),
}


def _deps_from_desc(desc: str) -> list[str]:
    import re

    return re.findall(r"\bDEP:([A-Z0-9_-]+)\b", desc.upper())


def _run_mode(args: Any) -> str:
    if getattr(args, "autopilot", False):
        return "scheduled" if getattr(args, "schedule", None) else "autopilot"
    if getattr(args, "batch", False):
        return "batch"
    if getattr(args, "schedule", None):
        return "scheduled"
    if getattr(args, "pilot", False):
        return "pilot"
    return "manual"


def _base_result(ticket_id: str, mode: str, desc: str = "") -> dict[str, Any]:
    return {
        "ticket": ticket_id,
        "mode": mode,
        "desc": desc,
        "editor_context": {},
        "audit": {},
        "plan": {},
        "execution": {"results": [], "created": [], "ok": True},
        "validation": {"results": [], "ok": True},
        "repair": {"repairs": [], "ok": True},
        "reasoning": {},
        "artifacts": {},
        "agent_results": [],
        "ok": True,
    }


def _diff_text(project_root: Path, created: list[str]) -> str:
    if not created:
        return ""
    try:
        return subprocess.check_output(["git", "diff", "HEAD~1", "HEAD", "--", *created], cwd=str(project_root), text=True, stderr=subprocess.DEVNULL)
    except Exception:
        try:
            return subprocess.check_output(["git", "diff", "--", *created], cwd=str(project_root), text=True, stderr=subprocess.DEVNULL)
        except Exception:
            return ""


def _require_agent_capabilities(
    agent_name: str,
    *,
    agent_registry: AgentRegistry,
    permission_registry: PermissionRegistry,
) -> None:
    agent = agent_registry.get_agent(agent_name)
    declared_tools = set(agent.allowed_tools)
    required_tools = RUNTIME_AGENT_REQUIRED_TOOLS.get(agent_name, ())
    missing_declared = [tool_name for tool_name in required_tools if tool_name not in declared_tools]
    if missing_declared:
        raise ToolPermissionError(f"agent '{agent_name}' is missing declared tools: {', '.join(missing_declared)}")
    for tool_name in required_tools:
        permission_registry.require_tool_permission(agent_name, tool_name)


def run_ticket_runtime(
    adapter,
    ticket_id: str,
    *,
    mode: str = "integrate",
    provider: Any = None,
    args: Any = None,
    project_root: Path | None = None,
    classify_ticket: Callable[[str], tuple[str, str]] | None = None,
    get_strategy: Callable[[str], Any] | None = None,
    ignore_dirs: set[str] | None = None,
    scaffold_fn: Callable[..., list[str]] | None = None,
    ensure_branch_fn: Callable[[str, str], str | None] | None = None,
    should_auto_implement_fn: Callable[[dict[str, Any]], bool] | None = None,
    permission_registry: PermissionRegistry | None = None,
    agent_registry: AgentRegistry | None = None,
    editor_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    root = project_root or getattr(adapter, "project_root", Path.cwd())
    args = args or object()
    desc = adapter.load_tickets().get(ticket_id, "")
    result = _base_result(ticket_id, _run_mode(args), desc)
    normalized_editor_context = normalize_editor_context(editor_context or getattr(args, "editor_context", None))
    result["editor_context"] = normalized_editor_context

    permissions = permission_registry or build_default_permissions()
    agents = agent_registry or build_default_agent_registry(permissions)
    for agent_name in ("planner", "implementer", "validator", "repair", "release"):
        _require_agent_capabilities(agent_name, agent_registry=agents, permission_registry=permissions)

    planner = PlannerAgent()
    implementer = ImplementerAgent()
    validator = ValidatorAgent()
    repairer = RepairAgent()
    releaser = ReleaseAgent()

    planner_result = planner.run(
        adapter,
        ticket_id,
        desc,
        provider=provider,
        project_root=root,
        classify_ticket=classify_ticket,
        get_strategy=get_strategy,
        ignore_dirs=ignore_dirs,
        mode=mode,
        editor_context=normalized_editor_context,
    )
    result["agent_results"].append({"agent": planner.name, "ok": planner_result.get("ok", False)})
    result["audit"] = planner_result.get("audit", {})
    result["plan"] = planner_result.get("plan", {})
    audit = result["audit"]
    plan = result["plan"]
    if not audit.get("allowed"):
        result["ok"] = False
        return result

    should_exec = bool(getattr(args, "execute", False))
    if getattr(args, "autopilot", False) and (getattr(args, "implement", False) or (should_auto_implement_fn and should_auto_implement_fn(audit))):
        should_exec = True
    conf_val = audit.get("confidence", 0) or 0
    if should_exec and not getattr(args, "autopilot", False) and not getattr(args, "confirm", False) and not (getattr(args, "pilot", False) and conf_val >= 0.8):
        should_exec = False

    implementer_result = implementer.run(
        adapter,
        plan,
        provider=provider,
        allow_write=bool(getattr(args, "write", False)),
        should_execute=should_exec,
        project_root=root,
        audit_result=audit,
        scaffold_fn=scaffold_fn if getattr(args, "execute", False) else None,
        ensure_branch_fn=ensure_branch_fn,
        editor_context=normalized_editor_context,
    )
    result["agent_results"].append({"agent": implementer.name, "ok": implementer_result.get("ok", False)})
    result["execution"] = implementer_result.get("execution", result["execution"])
    branch = result["execution"].get("branch")
    created = list(result["execution"].get("created", []))

    validator_result = validator.run(
        adapter,
        ticket_id,
        audit,
        plan,
        project_root=root,
        should_validate=bool(created or should_exec),
    )
    result["agent_results"].append({"agent": validator.name, "ok": validator_result.get("ok", False)})
    result["validation"] = validator_result.get("validation", result["validation"])

    repair_result = repairer.run(
        adapter,
        plan,
        result["validation"],
        provider=provider,
        project_root=root,
        should_repair=bool(not result["validation"].get("ok") and (getattr(args, "repair", False) or getattr(args, "autopilot", False) or should_exec)),
        editor_context=normalized_editor_context,
    )
    result["agent_results"].append({"agent": repairer.name, "ok": repair_result.get("ok", True)})
    result["repair"] = repair_result.get("repair", result["repair"])
    if result["repair"].get("validation"):
        result["validation"] = result["repair"]["validation"]

    release_mode = "plan" if getattr(args, "plan", False) else "execute"
    release_result = releaser.run(
        ticket_id,
        audit=audit,
        plan=plan,
        execution=result["execution"],
        validation=result["validation"],
        repair=result["repair"],
        project_root=root,
        mode=release_mode,
        branch=branch,
        provider=provider,
    )
    result["agent_results"].append({"agent": releaser.name, "ok": release_result.get("ok", False)})
    result["artifacts"] = release_result.get("artifacts", {})

    if provider is not None:
        try:
            result["reasoning"]["summary"] = provider.summarize(
                f"Ticket: {ticket_id}\nAudit: {audit}\nPlan: {plan}\nExecution: {result['execution']}\nValidation ok: {result['validation'].get('ok', True)}\nRepair: {result['repair']}"
            )
        except Exception:
            result["reasoning"]["summary"] = ""

    result["execution"]["diff"] = _diff_text(root, created)
    result["ok"] = bool(audit.get("allowed")) and bool(result["validation"].get("ok", True))
    return result
