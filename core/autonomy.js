'use strict';

const SELF_IMPROVEMENT_REQUIRE_TAG = 'OPS';

const AUTONOMY_MODE_PRESETS = {
  safe: {
    autoSynthesizeBats: false,
    autoRetryUntilPass: false,
    autoBrainstormOnFailure: false,
    autoApproveLowRisk: false,
    humanApprovalProtectedOnly: false,
    sandboxRequired: true,
    baselineSelfHealPriority: true,
    supervisedAutoRunRecipes: false,
    autoQueueTaskLoopFollowups: false,
    autoRunQueuedTaskLoopFollowups: false,
    maxRetryRounds: 1,
  },
  guided: {
    autoSynthesizeBats: true,
    autoRetryUntilPass: true,
    autoBrainstormOnFailure: true,
    autoApproveLowRisk: true,
    humanApprovalProtectedOnly: true,
    sandboxRequired: true,
    baselineSelfHealPriority: true,
    supervisedAutoRunRecipes: false,
    autoQueueTaskLoopFollowups: true,
    autoRunQueuedTaskLoopFollowups: false,
    maxRetryRounds: 2,
  },
  full: {
    autoSynthesizeBats: true,
    autoRetryUntilPass: true,
    autoBrainstormOnFailure: true,
    autoApproveLowRisk: true,
    humanApprovalProtectedOnly: true,
    sandboxRequired: true,
    baselineSelfHealPriority: true,
    supervisedAutoRunRecipes: true,
    autoQueueTaskLoopFollowups: true,
    autoRunQueuedTaskLoopFollowups: false,
    maxRetryRounds: 4,
  },
  self: {
    autoSynthesizeBats: true,
    autoRetryUntilPass: true,
    autoBrainstormOnFailure: true,
    autoApproveLowRisk: false,
    humanApprovalProtectedOnly: true,
    sandboxRequired: true,
    baselineSelfHealPriority: true,
    supervisedAutoRunRecipes: true,
    autoQueueTaskLoopFollowups: true,
    autoRunQueuedTaskLoopFollowups: false,
    maxRetryRounds: 3,
  },
};

const SAFETY_LEVEL_PRESETS = Object.freeze({
  locked: Object.freeze({
    id: 'locked',
    label: 'Locked',
    summary: 'Review, inspect, and monitor only. No code execution, training, benchmarks, or promotion work.',
    autonomyMode: 'safe',
    requireExplicitApproval: true,
    requireLabForCodeActions: true,
    requireLabForAutonomyActions: true,
    blockedActions: ['run', 'implement', 'repair', 'autopilot', 'self-improve', 'train', 'learn', 'benchmark', 'engine-benchmark', 'promote', 'candidate-promote'],
    overrides: {
      autoSynthesizeBats: false,
      autoRetryUntilPass: false,
      autoBrainstormOnFailure: false,
      autoApproveLowRisk: false,
      humanApprovalProtectedOnly: false,
      sandboxRequired: true,
      baselineSelfHealPriority: true,
      autoQueueTaskLoopFollowups: false,
      autoRunQueuedTaskLoopFollowups: false,
      maxRetryRounds: 1,
    },
  }),
  guarded: Object.freeze({
    id: 'guarded',
    label: 'Guarded',
    summary: 'Allow planning and bounded lab work, but pause autonomy, training, and promotions until the operator is ready.',
    autonomyMode: 'safe',
    requireExplicitApproval: true,
    requireLabForCodeActions: true,
    requireLabForAutonomyActions: true,
    blockedActions: ['autopilot', 'self-improve', 'train', 'learn', 'promote', 'candidate-promote'],
    overrides: {
      autoSynthesizeBats: false,
      autoRetryUntilPass: false,
      autoBrainstormOnFailure: true,
      autoApproveLowRisk: false,
      humanApprovalProtectedOnly: false,
      sandboxRequired: true,
      baselineSelfHealPriority: true,
      autoQueueTaskLoopFollowups: false,
      autoRunQueuedTaskLoopFollowups: false,
      maxRetryRounds: 1,
    },
  }),
  'supervised-auto': Object.freeze({
    id: 'supervised-auto',
    label: 'Supervised Auto',
    summary: 'Default balanced mode. The engine can work in bounded scopes, but approvals and safety guardrails stay active.',
    autonomyMode: 'guided',
    requireExplicitApproval: true,
    requireLabForCodeActions: false,
    requireLabForAutonomyActions: false,
    blockedActions: [],
    overrides: {},
  }),
  builder: Object.freeze({
    id: 'builder',
    label: 'Builder',
    summary: 'Allow wider coding loops with retries, while still respecting sandboxing and protection rules.',
    autonomyMode: 'full',
    requireExplicitApproval: false,
    requireLabForCodeActions: false,
    requireLabForAutonomyActions: false,
    blockedActions: [],
    overrides: {},
  }),
  'lab-full-auto': Object.freeze({
    id: 'lab-full-auto',
    label: 'Lab Full Auto',
    summary: 'Aggressive automation is allowed, but only inside labs. Live promotion still stays explicit.',
    autonomyMode: 'self',
    requireExplicitApproval: false,
    requireLabForCodeActions: true,
    requireLabForAutonomyActions: true,
    blockedActions: ['promote', 'candidate-promote'],
    overrides: {},
  }),
  custom: Object.freeze({
    id: 'custom',
    label: 'Custom',
    summary: 'Manual safety shaping for advanced operators.',
    autonomyMode: 'guided',
    requireExplicitApproval: false,
    requireLabForCodeActions: false,
    requireLabForAutonomyActions: false,
    blockedActions: [],
    overrides: {},
  }),
});

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (['self-improve', 'self_only', 'self-only', 'assistant'].includes(mode)) {
    return 'self';
  }
  return Object.prototype.hasOwnProperty.call(AUTONOMY_MODE_PRESETS, mode) ? mode : 'guided';
}

function normalizeSafetyLevel(value) {
  const level = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SAFETY_LEVEL_PRESETS, level) ? level : 'supervised-auto';
}

function coerceBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const text = String(value).trim().toLowerCase();
  if (!text) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(text)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(text)) {
    return false;
  }
  return fallback;
}

function clampRetryRounds(value, fallback) {
  const num = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(8, Math.max(1, num));
}

function resolveAutonomySettings(input = {}) {
  const hasExplicitSafetyLevel = input.safetyLevel !== undefined && input.safetyLevel !== null && String(input.safetyLevel).trim() !== '';
  const safetyLevel = normalizeSafetyLevel(input.safetyLevel);
  const safetyPreset = SAFETY_LEVEL_PRESETS[safetyLevel];
  const mode = !hasExplicitSafetyLevel || safetyLevel === 'custom'
    ? normalizeMode(input.autonomyMode)
    : normalizeMode(safetyPreset.autonomyMode || input.autonomyMode);
  const preset = AUTONOMY_MODE_PRESETS[mode];
  const fallback = {
    ...preset,
    ...(safetyPreset.overrides || {}),
  };
  const selfImprovementOnly = coerceBoolean(input.selfImprovementOnly, mode === 'self');
  return {
    safetyLevel,
    safetySummary: safetyPreset.summary,
    safetyLabel: safetyPreset.label,
    blockedActions: [...(safetyPreset.blockedActions || [])],
    requireExplicitApproval: safetyPreset.requireExplicitApproval === true,
    requireLabForCodeActions: safetyPreset.requireLabForCodeActions === true,
    requireLabForAutonomyActions: safetyPreset.requireLabForAutonomyActions === true,
    autonomyMode: mode,
    selfImprovementOnly,
    autoSynthesizeBats: coerceBoolean(input.autoSynthesizeBats, fallback.autoSynthesizeBats),
    autoRetryUntilPass: coerceBoolean(input.autoRetryUntilPass, fallback.autoRetryUntilPass),
    autoBrainstormOnFailure: coerceBoolean(input.autoBrainstormOnFailure, fallback.autoBrainstormOnFailure),
    autoApproveLowRisk: coerceBoolean(input.autoApproveLowRisk, fallback.autoApproveLowRisk),
    humanApprovalProtectedOnly: coerceBoolean(input.humanApprovalProtectedOnly, fallback.humanApprovalProtectedOnly),
    sandboxRequired: coerceBoolean(input.sandboxRequired, fallback.sandboxRequired),
    baselineSelfHealPriority: coerceBoolean(input.baselineSelfHealPriority, fallback.baselineSelfHealPriority),
    supervisedAutoRunRecipes: coerceBoolean(input.supervisedAutoRunRecipes, fallback.supervisedAutoRunRecipes),
    autoQueueTaskLoopFollowups: coerceBoolean(input.autoQueueTaskLoopFollowups, fallback.autoQueueTaskLoopFollowups),
    autoRunQueuedTaskLoopFollowups: coerceBoolean(input.autoRunQueuedTaskLoopFollowups, fallback.autoRunQueuedTaskLoopFollowups),
    maxRetryRounds: clampRetryRounds(input.maxRetryRounds, fallback.maxRetryRounds),
  };
}

function applyAutonomyToRequest(request = {}, { action = '', sprintAction = '' } = {}) {
  const resolved = resolveAutonomySettings(request);
  const normalizedAction = String(action || '').trim().toLowerCase();
  const normalizedSprintAction = String(sprintAction || '').trim().toLowerCase();
  const sprintLike = normalizedAction === 'sprint' || normalizedAction === 'autopilot' || normalizedAction === 'self-improve';
  const implementLike = normalizedAction === 'implement' || normalizedAction === 'run' || normalizedSprintAction === 'implement' || normalizedSprintAction === 'run';

  const next = {
    ...request,
    safetyLevel: resolved.safetyLevel,
    autonomyMode: resolved.autonomyMode,
    selfImprovementOnly: resolved.selfImprovementOnly,
    autoSynthesizeBats: resolved.autoSynthesizeBats,
    autoRetryUntilPass: resolved.autoRetryUntilPass,
    autoBrainstormOnFailure: resolved.autoBrainstormOnFailure,
    autoApproveLowRisk: resolved.autoApproveLowRisk,
    humanApprovalProtectedOnly: resolved.humanApprovalProtectedOnly,
    sandboxRequired: resolved.sandboxRequired,
    baselineSelfHealPriority: resolved.baselineSelfHealPriority,
    supervisedAutoRunRecipes: resolved.supervisedAutoRunRecipes,
    autoQueueTaskLoopFollowups: resolved.autoQueueTaskLoopFollowups,
    autoRunQueuedTaskLoopFollowups: resolved.autoRunQueuedTaskLoopFollowups,
    maxRetryRounds: resolved.maxRetryRounds,
  };

  if (resolved.selfImprovementOnly && sprintLike && next.requireTag === undefined) {
    next.requireTag = SELF_IMPROVEMENT_REQUIRE_TAG;
  }

  if (resolved.sandboxRequired && next.prepareSandbox === undefined) {
    next.prepareSandbox = true;
  }
  if (resolved.autoRetryUntilPass) {
    if (next.fixLoop === undefined) {
      next.fixLoop = true;
    }
    if (next.fixIterations === undefined) {
      next.fixIterations = resolved.maxRetryRounds;
    }
    if ((implementLike || sprintLike) && next.continueOnFail === undefined) {
      next.continueOnFail = true;
    }
  }
  if (resolved.autoBrainstormOnFailure && next.brainstorm === undefined) {
    next.brainstorm = true;
  }
  if (resolved.autoSynthesizeBats && sprintLike && next.synthesizeFollowups === undefined) {
    next.synthesizeFollowups = true;
  }
  return next;
}

function applySafetyLevelToRequest(action, request = {}, safetySettings = {}) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  const blockedActions = Array.isArray(safetySettings.blockedActions) ? safetySettings.blockedActions : [];
  const hasLab = !!String(request.labRoot || '').trim();
  const next = {
    ...request,
    safetyLevel: safetySettings.safetyLevel || request.safetyLevel || 'supervised-auto',
  };

  if (safetySettings.requireExplicitApproval) {
    next.autoApproveLowRisk = false;
    next.humanApprovalProtectedOnly = false;
    next.approvalGated = true;
  }

  if (blockedActions.includes(normalizedAction)) {
    return {
      blocked: true,
      message: safetySettings.safetySummary || 'The current safety level blocks this action.',
      request: next,
    };
  }

  if (safetySettings.requireLabForCodeActions && !hasLab && ['run', 'implement', 'repair'].includes(normalizedAction)) {
    return {
      blocked: true,
      message: safetySettings.safetySummary || 'This safety level allows coding work only inside a lab.',
      request: next,
    };
  }

  if (safetySettings.requireLabForAutonomyActions && !hasLab && ['autopilot', 'self-improve'].includes(normalizedAction)) {
    return {
      blocked: true,
      message: safetySettings.safetySummary || 'This safety level allows autonomy only inside a lab.',
      request: next,
    };
  }

  return {
    blocked: false,
    message: '',
    request: next,
  };
}

module.exports = {
  SELF_IMPROVEMENT_REQUIRE_TAG,
  AUTONOMY_MODE_PRESETS,
  SAFETY_LEVEL_PRESETS,
  normalizeSafetyLevel,
  resolveAutonomySettings,
  applyAutonomyToRequest,
  applySafetyLevelToRequest,
};
