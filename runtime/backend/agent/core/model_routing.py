from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from backend.agent.core.config_loader import load_project_config


@dataclass(frozen=True)
class AgentModelRoute:
    agent: str
    role: str
    model_role: str
    wrapped_profile_role: str
    task_mode: str
    provider: str
    model: str
    fallback_model: str
    fallback_provider: str
    purpose: str

    def to_dict(self) -> dict[str, str]:
        return {key: str(value) for key, value in asdict(self).items()}


DEFAULT_AGENT_MODEL_ROUTES: dict[str, AgentModelRoute] = {
    'planner': AgentModelRoute(
        agent='planner',
        role='reasoning',
        model_role='orchestrator',
        wrapped_profile_role='engine',
        task_mode='planner',
        provider='ollama',
        model='qwen2.5-coder:7b',
        fallback_model='qwen2.5-coder:14b',
        fallback_provider='ollama',
        purpose='Bound ticket scope, choose files, and prepare a safe implementation plan.',
    ),
    'implementer': AgentModelRoute(
        agent='implementer',
        role='coding',
        model_role='worker',
        wrapped_profile_role='workspace',
        task_mode='coder',
        provider='ollama',
        model='qwen2.5-coder:14b',
        fallback_model='qwen2.5-coder:3b',
        fallback_provider='ollama',
        purpose='Write bounded code changes, reuse existing patterns, and keep diffs small.',
    ),
    'validator': AgentModelRoute(
        agent='validator',
        role='verification',
        model_role='reviewer',
        wrapped_profile_role='engine',
        task_mode='validator',
        provider='ollama',
        model='qwen2.5-coder:7b',
        fallback_model='qwen2.5-coder:14b',
        fallback_provider='ollama',
        purpose='Review diffs, interpret failing checks, and decide repair versus release.',
    ),
    'repair': AgentModelRoute(
        agent='repair',
        role='repair',
        model_role='worker',
        wrapped_profile_role='workspace',
        task_mode='repair',
        provider='ollama',
        model='qwen2.5-coder:7b',
        fallback_model='qwen2.5-coder:3b',
        fallback_provider='ollama',
        purpose='Repair targeted failures with the smallest safe fix and fast retest loop.',
    ),
    'release': AgentModelRoute(
        agent='release',
        role='release',
        model_role='orchestrator',
        wrapped_profile_role='engine',
        task_mode='summarizer',
        provider='ollama',
        model='qwen2.5-coder:7b',
        fallback_model='qwen2.5-coder:14b',
        fallback_provider='ollama',
        purpose='Prepare trusted summaries, release-facing artifacts, and training handoff output.',
    ),
}

AGENT_ROUTE_ALIASES: dict[str, str] = {
    'coder': 'implementer',
    'summarizer': 'release',
}
AGENT_TASK_MODE_NAMES: dict[str, str] = {
    'planner': 'planner',
    'implementer': 'coder',
    'coder': 'coder',
    'validator': 'validator',
    'repair': 'repair',
    'release': 'summarizer',
    'summarizer': 'summarizer',
}


def _normalized_string(value: Any, fallback: str) -> str:
    text = str(value or '').strip()
    return text or fallback


def _routing_config(project_root: Path | None) -> dict[str, Any]:
    if project_root is None:
        return {}
    config = load_project_config(project_root)
    raw = config.get('assistant_agent_model_routing')
    return raw if isinstance(raw, dict) else {}


def _project_config(project_root: Path | None) -> dict[str, Any]:
    if project_root is None:
        return {}
    config = load_project_config(project_root)
    return config if isinstance(config, dict) else {}


def _task_mode_route_config(project_root: Path | None, task_mode: str) -> dict[str, Any]:
    config = _project_config(project_root)
    task_routes = config.get('assistant_task_mode_routes')
    if isinstance(task_routes, dict):
        route = task_routes.get(task_mode)
        if isinstance(route, dict):
            return route
    provider = config.get(f'assistant_task_mode_{task_mode}_provider')
    model = config.get(f'assistant_task_mode_{task_mode}_model')
    fallback_model = config.get(f'assistant_task_mode_{task_mode}_fallback_model')
    fallback_provider = config.get(f'assistant_task_mode_{task_mode}_fallback_provider')
    route: dict[str, Any] = {}
    if provider:
        route['provider'] = provider
    if model:
        route['model'] = model
    if fallback_model:
        route['fallback_model'] = fallback_model
    if fallback_provider:
        route['fallback_provider'] = fallback_provider
    return route


def _review_lane_override(project_root: Path | None, lane: str) -> dict[str, Any]:
    config = _project_config(project_root)
    payload = config.get(f'assistant_{lane}_route')
    if isinstance(payload, dict):
        return payload
    route: dict[str, Any] = {}
    for key in ('provider', 'model', 'fallback_model', 'fallback_provider'):
        value = config.get(f'assistant_{lane}_{key}')
        if value:
            route[key] = value
    return route


def resolve_agent_model_route(agent_name: str, project_root: Path | None = None) -> AgentModelRoute:
    normalized_name = str(agent_name or '').strip().lower()
    canonical_name = AGENT_ROUTE_ALIASES.get(normalized_name, normalized_name)
    task_mode = AGENT_TASK_MODE_NAMES.get(normalized_name, AGENT_TASK_MODE_NAMES.get(canonical_name, normalized_name or 'planner'))
    default = DEFAULT_AGENT_MODEL_ROUTES.get(canonical_name)
    if default is None:
        return AgentModelRoute(
            agent=normalized_name or 'unknown',
            role='reasoning',
            model_role='orchestrator',
            wrapped_profile_role='engine',
            task_mode='planner',
            provider='ollama',
            model='qwen2.5-coder:7b',
            fallback_model='qwen2.5-coder:14b',
            fallback_provider='ollama',
            purpose='Fallback agent route.',
        )
    route_config = _routing_config(project_root).get(canonical_name)
    task_mode_config = _task_mode_route_config(project_root, task_mode)
    config = route_config if isinstance(route_config, dict) else {}
    if task_mode_config:
        config = {**task_mode_config, **config}
    if canonical_name == 'validator':
        review_override = _review_lane_override(project_root, 'reviewer')
        if review_override:
            config = {**config, **review_override}
    elif canonical_name == 'release':
        approval_override = _review_lane_override(project_root, 'approver')
        if approval_override:
            config = {**config, **approval_override}
    if not config:
        return AgentModelRoute(
            agent=normalized_name or default.agent,
            role=default.role,
            model_role=default.model_role,
            wrapped_profile_role=default.wrapped_profile_role,
            task_mode=default.task_mode,
            provider=default.provider,
            model=default.model,
            fallback_model=default.fallback_model,
            fallback_provider=default.fallback_provider,
            purpose=default.purpose,
        )
    return AgentModelRoute(
        agent=normalized_name or default.agent,
        role=_normalized_string(config.get('role'), default.role),
        model_role=_normalized_string(config.get('model_role'), default.model_role),
        wrapped_profile_role=_normalized_string(config.get('wrapped_profile_role'), default.wrapped_profile_role),
        task_mode=_normalized_string(config.get('task_mode'), default.task_mode),
        provider=_normalized_string(config.get('provider'), default.provider),
        model=_normalized_string(config.get('model'), default.model),
        fallback_model=_normalized_string(config.get('fallback_model'), default.fallback_model),
        fallback_provider=_normalized_string(config.get('fallback_provider'), default.fallback_provider),
        purpose=_normalized_string(config.get('purpose'), default.purpose),
    )


def build_agent_model_routing_summary(project_root: Path | None = None) -> dict[str, dict[str, str]]:
    summary = {
        name: resolve_agent_model_route(name, project_root).to_dict()
        for name in DEFAULT_AGENT_MODEL_ROUTES
    }
    summary['coder'] = resolve_agent_model_route('coder', project_root).to_dict()
    summary['summarizer'] = resolve_agent_model_route('summarizer', project_root).to_dict()
    return summary
