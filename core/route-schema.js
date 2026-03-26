'use strict';

const CAPABILITY_ROUTE_LANES = Object.freeze([
  {
    id: 'chat-fast',
    label: 'Chat fast',
    summary: 'Short conversational replies and quick repo guidance.',
    loopTaskMode: 'chat',
    routeTaskMode: 'planner',
    action: 'chat',
    wrappedProfileRole: 'engine',
    executionRoleId: 'orchestrator',
  },
  {
    id: 'plan-reasoning',
    label: 'Plan reasoning',
    summary: 'Task scoping, acceptance checks, and bounded implementation plans.',
    loopTaskMode: 'planner',
    routeTaskMode: 'planner',
    action: 'plan',
    wrappedProfileRole: 'engine',
    executionRoleId: 'orchestrator',
  },
  {
    id: 'code-main',
    label: 'Code main',
    summary: 'Primary coding lane for implementation and refactors.',
    loopTaskMode: 'coder',
    routeTaskMode: 'coder',
    action: 'implement',
    wrappedProfileRole: 'workspace',
    executionRoleId: 'worker',
  },
  {
    id: 'repair-fast',
    label: 'Repair fast',
    summary: 'Focused debug and repair loops after a failing run.',
    loopTaskMode: 'repair',
    routeTaskMode: 'repair',
    action: 'repair',
    wrappedProfileRole: 'workspace',
    executionRoleId: 'worker',
  },
  {
    id: 'review-verify',
    label: 'Review verify',
    summary: 'Diff review, validation, and approval-aware analysis.',
    loopTaskMode: 'validator',
    routeTaskMode: 'validator',
    action: 'run',
    wrappedProfileRole: 'engine',
    executionRoleId: 'reviewer',
  },
  {
    id: 'research-docs',
    label: 'Research docs',
    summary: 'Documentation scouting and option comparison in safe lab trials.',
    loopTaskMode: 'research',
    routeTaskMode: 'planner',
    action: 'research',
    wrappedProfileRole: 'engine',
    executionRoleId: 'orchestrator',
  },
  {
    id: 'ops-summary',
    label: 'Ops summary',
    summary: 'Status snapshots, business-facing summaries, and operational handoffs.',
    loopTaskMode: 'summarizer',
    routeTaskMode: 'summarizer',
    action: 'summarize',
    wrappedProfileRole: 'engine',
    executionRoleId: 'orchestrator',
  },
]);

const WRAPPED_PROFILE_ROLE_DEFAULTS = Object.freeze({
  workspace: {
    id: 'workspace',
    label: 'Workspace coding model',
    summary: 'Primary repo-work profile for thread-driven coding, edits, and repair loops.',
  },
  engine: {
    id: 'engine',
    label: 'Engine control model',
    summary: 'Engine-only profile for planning, review, docs, summaries, and engine-facing operator work.',
  },
});

const EXECUTION_ROLE_DEFAULTS = Object.freeze({
  orchestrator: {
    id: 'orchestrator',
    label: 'Front-door chat / orchestrator',
    summary: 'Front-door chat, planning, docs scouting, and operator-facing summaries.',
    primaryProfileRole: 'engine',
    primaryLaneId: 'plan-reasoning',
  },
  worker: {
    id: 'worker',
    label: 'Worker',
    summary: 'Implementation and repair loops for bounded coding work.',
    primaryProfileRole: 'workspace',
    primaryLaneId: 'code-main',
  },
  reviewer: {
    id: 'reviewer',
    label: 'Reviewer / approval reasoning',
    summary: 'Diff review, validation, and approval-aware reasoning.',
    primaryProfileRole: 'engine',
    primaryLaneId: 'review-verify',
  },
});

const MODEL_EXECUTION_ROLE_DEFAULTS = Object.freeze(
  Object.fromEntries(Object.values(EXECUTION_ROLE_DEFAULTS).map((definition) => [definition.id, {
    ...definition,
    laneIds: CAPABILITY_ROUTE_LANES
      .filter((lane) => lane.executionRoleId === definition.id)
      .map((lane) => lane.id),
  }])),
);

const ROUTE_TASK_MODE_ALIASES = Object.freeze({
  implementer: 'coder',
  release: 'summarizer',
  research: 'planner',
  chat: 'planner',
});

function normalizeCapabilityLaneId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return CAPABILITY_ROUTE_LANES.some((lane) => lane.id === normalized) ? normalized : '';
}

function resolveCapabilityLane(laneId) {
  const normalized = normalizeCapabilityLaneId(laneId);
  return CAPABILITY_ROUTE_LANES.find((lane) => lane.id === normalized) || null;
}

function normalizeRouteTaskModeId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const aliased = ROUTE_TASK_MODE_ALIASES[normalized] || normalized;
  return ['planner', 'repair', 'coder', 'validator', 'summarizer'].includes(aliased) ? aliased : '';
}

function resolveLaneLoopTaskMode(laneId) {
  return resolveCapabilityLane(laneId)?.loopTaskMode || 'coder';
}

function resolveLaneRouteTaskMode(laneId) {
  return resolveCapabilityLane(laneId)?.routeTaskMode || 'coder';
}

function resolveLaneWrappedProfileRole(laneId) {
  return resolveCapabilityLane(laneId)?.wrappedProfileRole || 'workspace';
}

function resolveLaneExecutionRoleId(laneId) {
  return resolveCapabilityLane(laneId)?.executionRoleId || 'worker';
}

function resolveRouteTaskMode({ laneId = '', taskMode = '' } = {}) {
  const laneRouteTaskMode = resolveLaneRouteTaskMode(laneId);
  if (normalizeCapabilityLaneId(laneId)) {
    return laneRouteTaskMode;
  }
  return normalizeRouteTaskModeId(taskMode) || 'coder';
}

function resolveWrappedProfileRole({ laneId = '', taskMode = '' } = {}) {
  if (normalizeCapabilityLaneId(laneId)) {
    return resolveLaneWrappedProfileRole(laneId);
  }
  return ['planner', 'validator', 'summarizer'].includes(resolveRouteTaskMode({ taskMode }))
    ? 'engine'
    : 'workspace';
}

function resolveExecutionRoleId({ laneId = '', taskMode = '' } = {}) {
  if (normalizeCapabilityLaneId(laneId)) {
    return resolveLaneExecutionRoleId(laneId);
  }
  const routeTaskMode = resolveRouteTaskMode({ taskMode });
  if (routeTaskMode === 'validator') {
    return 'reviewer';
  }
  return ['planner', 'summarizer'].includes(routeTaskMode) ? 'orchestrator' : 'worker';
}

module.exports = {
  CAPABILITY_ROUTE_LANES,
  MODEL_EXECUTION_ROLE_DEFAULTS,
  WRAPPED_PROFILE_ROLE_DEFAULTS,
  normalizeCapabilityLaneId,
  normalizeRouteTaskModeId,
  resolveCapabilityLane,
  resolveExecutionRoleId,
  resolveLaneExecutionRoleId,
  resolveLaneLoopTaskMode,
  resolveLaneRouteTaskMode,
  resolveLaneWrappedProfileRole,
  resolveRouteTaskMode,
  resolveWrappedProfileRole,
};