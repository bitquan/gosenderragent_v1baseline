'use strict';

const {
  CAPABILITY_ROUTE_LANES,
  normalizeCapabilityLaneId,
  normalizeLoopTaskModeId,
  resolveRouteTaskMode,
  resolveWrappedProfileRole,
} = require('./route-schema');
const { applyLocalModelGuardrailsToConfig } = require('./training-tuning');

const CHAT_MODE_CONFIG = Object.freeze({
  auto: {
    id: 'auto',
    label: 'Auto',
    meta: 'Let the manager pick the right behavior for the request and current safety state.',
    suggestedNextAction: 'Classify the request, stay conversational by default, and only step into execution when the request and gates clearly support it.',
    instruction: 'Act like a strong coding teammate. Decide when this should stay Ask, become Plan, prepare an Edit, or step into Agent mode. Stay grounded, explain the choice briefly when it matters, and keep all execution inside the current gates.',
    allowsExecution: true,
    requiresEditConfirmation: false,
  },
  ask: {
    id: 'ask',
    label: 'Ask',
    meta: 'Human-style help, explanation, and repo guidance only.',
    suggestedNextAction: 'Answer naturally, keep the thread conversational, and avoid mutating work from Ask mode.',
    instruction: 'Be warm, collaborative, plain-English, and honest. Prefer short paragraphs and only use bullets when the content is clearly list-shaped. Do not launch edits or runs from Ask mode.',
    allowsExecution: false,
    requiresEditConfirmation: false,
  },
  plan: {
    id: 'plan',
    label: 'Plan',
    meta: 'Scoped planning, risks, and next steps without launching work.',
    suggestedNextAction: 'Talk through the plan, risks, and next bounded step before changing code.',
    instruction: 'Prefer scoped plans, risks, and next steps. Keep the conversation collaborative and do not launch edit work directly from Plan mode.',
    allowsExecution: false,
    requiresEditConfirmation: false,
  },
  edit: {
    id: 'edit',
    label: 'Edit',
    meta: 'Prepare code changes and diffs, but require explicit confirmation before execution.',
    suggestedNextAction: 'Prepare the edit path and confirm before running code changes.',
    instruction: 'Focus on code changes, diffs, and repair paths. Stay conversational when the request is conceptual, and require explicit confirmation before executing edits.',
    allowsExecution: false,
    requiresEditConfirmation: true,
  },
  agent: {
    id: 'agent',
    label: 'Agent',
    meta: 'Bounded execution through the safe engine loop only when current gates allow it.',
    suggestedNextAction: 'Use the bounded engine loop and only act when the current gates are healthy.',
    instruction: 'Act through the existing engine loop only when the current safety, review, and autonomy gates allow it. Keep responses human and accountable, not command-console styled.',
    allowsExecution: true,
    requiresEditConfirmation: false,
  },
});

const TASK_LOOP_LANE_MAP = Object.freeze(
  Object.fromEntries(CAPABILITY_ROUTE_LANES.map((lane) => [lane.id, {
    laneId: lane.id,
    laneLabel: lane.label,
    taskMode: lane.loopTaskMode,
    action: lane.action,
  }])),
);

function clipText(value, maxLength = 180) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}...` : text;
}

function resolveChatModeValue(value) {
  const mode = String(value || 'auto').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(CHAT_MODE_CONFIG, mode) ? mode : 'auto';
}

function getChatModeConfig(value) {
  return CHAT_MODE_CONFIG[resolveChatModeValue(value)];
}

function parseChatModeDirective(value) {
  const message = String(value || '').trim();
  const match = message.match(/^\/(auto|ask|plan|edit|agent)(?:\s+(.*))?$/i);
  if (!match) {
    return { mode: '', message };
  }
  return {
    mode: resolveChatModeValue(match[1]),
    message: String(match[2] || '').trim(),
  };
}

function normalizeTaskLoopLane(laneId) {
  return normalizeCapabilityLaneId(laneId) || 'code-main';
}

function resolveTaskLoopLane(laneId) {
  return TASK_LOOP_LANE_MAP[normalizeTaskLoopLane(laneId)];
}

function taskModeFromAction(action) {
  const normalized = String(action || '').trim().toLowerCase();
  if (normalized === 'plan') {
    return 'planner';
  }
  if (normalized === 'run') {
    return 'validator';
  }
  if (normalized === 'repair') {
    return 'repair';
  }
  if (normalized === 'summarize') {
    return 'summarizer';
  }
  if (normalized === 'research') {
    return 'research';
  }
  if (normalized === 'chat') {
    return 'chat';
  }
  return 'coder';
}

function normalizeTaskLoopMode(mode, action = '') {
  const normalized = normalizeLoopTaskModeId(mode);
  if (normalized) {
    return normalized;
  }
  return taskModeFromAction(action);
}

function resolveTaskLoopAction(mode) {
  const normalized = normalizeTaskLoopMode(mode);
  if (normalized === 'repair') {
    return 'repair';
  }
  if (normalized === 'research') {
    return 'research';
  }
  if (normalized === 'chat') {
    return 'chat';
  }
  if (normalized === 'planner') {
    return 'plan';
  }
  if (normalized === 'validator') {
    return 'run';
  }
  if (normalized === 'summarizer') {
    return '';
  }
  return 'implement';
}

function resolveExecutionModelRole({ taskMode = '', action = '', laneId = '' } = {}) {
  const normalizedTaskMode = normalizeTaskLoopMode(taskMode || taskModeFromAction(action));
  return resolveWrappedProfileRole({
    laneId,
    taskMode: normalizedTaskMode,
  });
}

function resolveTaskModeRouteKey({ taskMode = '', laneId = '' } = {}) {
  return resolveRouteTaskMode({
    laneId,
    taskMode: normalizeTaskLoopMode(taskMode || ''),
  });
}

function resolveModelProfileSelection(assistantConfig = {}, { taskMode = '', action = '', laneId = '' } = {}) {
  const effectiveConfig = applyLocalModelGuardrailsToConfig(assistantConfig, {
    settings: assistantConfig,
  });
  const modelRole = resolveExecutionModelRole({ taskMode, action, laneId });
  const routeKey = resolveTaskModeRouteKey({ taskMode, laneId });
  const routeConfig = effectiveConfig.taskModeRoutes && typeof effectiveConfig.taskModeRoutes === 'object'
    ? (effectiveConfig.taskModeRoutes[routeKey] || (routeKey === 'repair' ? effectiveConfig.taskModeRoutes.coder : {}) || {})
    : {};
  const workspace = {
    modelProfileId: String(effectiveConfig.workspaceModelProfileId || effectiveConfig.modelProfileId || '').trim(),
    modelDisplayName: String(effectiveConfig.workspaceModelDisplayName || effectiveConfig.modelDisplayName || '').trim(),
    baseModel: String(effectiveConfig.workspaceBaseModel || effectiveConfig.baseModel || '').trim(),
    baseProvider: String(effectiveConfig.workspaceBaseProvider || effectiveConfig.baseProvider || '').trim().toLowerCase(),
    providerSource: String(effectiveConfig.workspaceProviderSource || effectiveConfig.providerSource || '').trim().toLowerCase(),
  };
  const engine = {
    modelProfileId: String(effectiveConfig.engineModelProfileId || workspace.modelProfileId || '').trim(),
    modelDisplayName: String(effectiveConfig.engineModelDisplayName || workspace.modelDisplayName || '').trim(),
    baseModel: String(effectiveConfig.engineBaseModel || workspace.baseModel || '').trim(),
    baseProvider: String(effectiveConfig.engineBaseProvider || workspace.baseProvider || '').trim().toLowerCase(),
    providerSource: String(effectiveConfig.engineProviderSource || workspace.providerSource || '').trim().toLowerCase(),
  };
  const activeBase = modelRole === 'engine' ? engine : workspace;
  const routeProvider = String(routeConfig.provider || '').trim().toLowerCase();
  const routeModel = String(routeConfig.model || '').trim();
  const active = {
    ...activeBase,
    baseModel: routeModel || activeBase.baseModel,
    baseProvider: routeProvider || activeBase.baseProvider,
    providerSource: routeProvider || activeBase.providerSource || activeBase.baseProvider,
  };
  return {
    modelRole,
    wrappedProfileRole: modelRole,
    workspace,
    engine,
    active,
    localModelGuardrails: effectiveConfig.localModelGuardrails || null,
  };
}

function inferChatModeRouting(chatMode, message = '') {
  const mode = resolveChatModeValue(chatMode);
  const modeConfig = getChatModeConfig(mode);
  const lower = String(message || '').trim().toLowerCase();
  const hasModeSwitchIntent = /\b(switch|set|use|go to)\b/.test(lower) && /\b(auto|ask|plan|edit|agent)\b/.test(lower);
  const hasControlIntent = /\b(turn|enable|disable|set|switch|pause|release|audit|review|show|hide|open|close)\b/.test(lower)
    && /\b(auto[- ]?run|auto[- ]?queue|recipes?|manager|worker|mode|transparency|safe mode|risky work|inbox|review)\b/.test(lower);
  const hasQuestionIntent = /(^|\s)(why|what|how|explain|summarize|show me|tell me)\b/.test(lower) || /\?$/.test(lower);
  const hasPlanIntent = /\b(plan|scope|safest next slice|next slice|risks?|acceptance checks?|steps?)\b/.test(lower);
  const hasOpsIntent = /(status|summary|health|why|what happened|what is happening|what's happening|inbox|review|route|routing|model)/.test(lower);
  const hasRepoStateIntent = /(current run|latest run|current workspace|repo state|workspace state|blocked right now|next safe action|acceptance|trust|review blocked|roadmap|what needs fixing)/.test(lower);
  const hasDocsIntent = /(\bdocs\b|\bdocumentation\b|\breference\b|\bapi\b|\bguide\b|\bmanual\b|\bmdn\b|\bnode\b|\bpython\b|\bvs code\b|\bvscode\b|\bmicrosoft docs\b)/.test(lower);
  const hasResearchIntent = hasDocsIntent || (/\bresearch\b/.test(lower) && !hasRepoStateIntent);
  const hasReviewIntent = /(review|diff|verify|validate)/.test(lower);
  const hasRepairIntent = /\b(repair|fix|failed|failing|broken|debug)\b/.test(lower);
  const hasEditIntent = /\b(edit|change|patch|update|refactor|implement|build|code)\b/.test(lower);
  const hasExecutionIntent = /\b(run|launch|execute|queue|continue|retry|repair|fix|ship|apply|turn|enable|disable|set|switch|pause|release|audit)\b/.test(lower);
  const effectiveMode = mode === 'auto'
    ? (hasModeSwitchIntent || hasControlIntent || (hasExecutionIntent && !hasQuestionIntent)
      ? 'agent'
      : hasPlanIntent
        ? 'plan'
        : hasEditIntent || hasRepairIntent || hasReviewIntent
          ? 'edit'
          : 'ask')
    : mode;
  const effectiveConfig = getChatModeConfig(effectiveMode);

  if (effectiveMode === 'plan') {
    return {
      chatMode: mode,
      effectiveChatMode: effectiveMode,
      suggestedTaskMode: 'planner',
      suggestedLaneId: hasResearchIntent ? 'research-docs' : 'plan-reasoning',
      modeAllowsExecution: effectiveConfig.allowsExecution,
      modeRequiresEditConfirmation: effectiveConfig.requiresEditConfirmation,
      suggestedNextAction: effectiveConfig.suggestedNextAction,
    };
  }

  if (effectiveMode === 'edit') {
    return {
      chatMode: mode,
      effectiveChatMode: effectiveMode,
      suggestedTaskMode: hasReviewIntent ? 'validator' : hasRepairIntent ? 'repair' : 'coder',
      suggestedLaneId: hasReviewIntent ? 'review-verify' : hasRepairIntent ? 'repair-fast' : 'code-main',
      modeAllowsExecution: effectiveConfig.allowsExecution,
      modeRequiresEditConfirmation: effectiveConfig.requiresEditConfirmation,
      suggestedNextAction: effectiveConfig.suggestedNextAction,
    };
  }

  if (effectiveMode === 'agent') {
    return {
      chatMode: mode,
      effectiveChatMode: effectiveMode,
      suggestedTaskMode: hasResearchIntent ? 'research' : hasOpsIntent ? 'summarizer' : hasRepairIntent ? 'repair' : 'coder',
      suggestedLaneId: hasResearchIntent ? 'research-docs' : hasOpsIntent ? 'ops-summary' : hasRepairIntent ? 'repair-fast' : 'code-main',
      modeAllowsExecution: effectiveConfig.allowsExecution,
      modeRequiresEditConfirmation: effectiveConfig.requiresEditConfirmation,
      suggestedNextAction: effectiveConfig.suggestedNextAction,
    };
  }

  return {
    chatMode: mode,
    effectiveChatMode: effectiveMode,
    suggestedTaskMode: hasResearchIntent ? 'research' : hasOpsIntent ? 'summarizer' : 'chat',
    suggestedLaneId: hasResearchIntent ? 'research-docs' : hasOpsIntent ? 'ops-summary' : 'chat-fast',
    modeAllowsExecution: effectiveConfig.allowsExecution,
    modeRequiresEditConfirmation: effectiveConfig.requiresEditConfirmation,
    suggestedNextAction: effectiveConfig.suggestedNextAction,
  };
}

function shouldUseCodingChatContext({ chatMode = 'auto', suggestedTaskMode = '', suggestedLaneId = '', message = '' } = {}) {
  const resolvedMode = resolveChatModeValue(chatMode);
  const laneId = normalizeCapabilityLaneId(suggestedLaneId) || '';
  const taskMode = normalizeTaskLoopMode(suggestedTaskMode || '');
  if (resolvedMode === 'agent' || resolvedMode === 'edit') {
    return true;
  }
  if (['code-main', 'repair-fast', 'review-verify'].includes(laneId)) {
    return true;
  }
  if (['coder', 'repair', 'validator'].includes(taskMode)) {
    return true;
  }
  if (resolvedMode === 'plan') {
    return false;
  }
  if (['chat-fast', 'plan-reasoning', 'research-docs', 'ops-summary'].includes(laneId)) {
    return false;
  }
  if (['chat', 'planner', 'research', 'summarizer'].includes(taskMode)) {
    return false;
  }
  return /\b(stack trace|traceback|line\s+\d+|failing test|test failure|error|exception|diff|snippet)\b/.test(String(message || '').trim().toLowerCase());
}

function buildTerminalRoutingSummary({ chatMode = 'ask', message = '' } = {}) {
  const route = inferChatModeRouting(chatMode, message);
  const lane = resolveTaskLoopLane(route.suggestedLaneId);
  const routeTaskMode = resolveTaskModeRouteKey({
    laneId: route.suggestedLaneId,
    taskMode: route.suggestedTaskMode,
  });
  const modeConfig = getChatModeConfig(chatMode);
  const effectiveConfig = getChatModeConfig(route.effectiveChatMode || chatMode);
  return {
    ...route,
    routeTaskMode,
    modeLabel: modeConfig.label,
    modeMeta: modeConfig.meta,
    modeInstruction: modeConfig.instruction,
    effectiveModeLabel: effectiveConfig.label,
    effectiveModeMeta: effectiveConfig.meta,
    laneLabel: lane.laneLabel,
    action: lane.action || resolveTaskLoopAction(route.suggestedTaskMode),
  };
}

function buildHumanPromptInstruction(chatMode) {
  const modeConfig = getChatModeConfig(chatMode);
  return clipText(modeConfig.instruction, 260);
}

module.exports = {
  CHAT_MODE_CONFIG,
  TASK_LOOP_LANE_MAP,
  buildHumanPromptInstruction,
  buildTerminalRoutingSummary,
  getChatModeConfig,
  inferChatModeRouting,
  normalizeTaskLoopLane,
  normalizeTaskLoopMode,
  parseChatModeDirective,
  resolveChatModeValue,
  resolveExecutionModelRole,
  resolveModelProfileSelection,
  resolveTaskModeRouteKey,
  resolveTaskLoopAction,
  resolveTaskLoopLane,
  shouldUseCodingChatContext,
  taskModeFromAction,
};
