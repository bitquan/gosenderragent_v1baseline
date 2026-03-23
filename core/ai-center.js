'use strict';

const { buildLocalModelInventory } = require('./training-tuning');

function mean(values = []) {
  const numeric = values.map((item) => Number(item || 0)).filter((item) => Number.isFinite(item));
  if (!numeric.length) {
    return 0;
  }
  return numeric.reduce((sum, item) => sum + item, 0) / numeric.length;
}

const AI_CAPABILITY_LANES = Object.freeze([
  { id: 'chat-fast', label: 'Chat fast', summary: 'Short conversational replies and quick repo guidance.' },
  { id: 'plan-reasoning', label: 'Plan reasoning', summary: 'Task scoping, acceptance checks, and bounded implementation plans.' },
  { id: 'code-main', label: 'Code main', summary: 'Primary coding lane for implementation and refactors.' },
  { id: 'repair-fast', label: 'Repair fast', summary: 'Focused debug and repair loops after a failing run.' },
  { id: 'review-verify', label: 'Review verify', summary: 'Diff review, validation, and approval-aware analysis.' },
  { id: 'research-docs', label: 'Research docs', summary: 'Documentation scouting and option comparison in safe lab trials.' },
  { id: 'ops-summary', label: 'Ops summary', summary: 'Status snapshots, business-facing summaries, and operational handoffs.' },
]);

const AI_PROFILE_PRESETS = Object.freeze([
  {
    id: 'local-fast',
    label: 'Local Fast',
    summary: 'Favor the fastest local model for nearly everything and only fall back when the lane is blocked.',
    routingPolicy: 'local-first',
  },
  {
    id: 'balanced-local',
    label: 'Balanced Local',
    summary: 'Keep local models primary, but allow higher-quality fallbacks for planning and review when benchmarks justify it.',
    routingPolicy: 'balanced-local',
  },
  {
    id: 'hybrid-default',
    label: 'Hybrid Default',
    summary: 'Use local-first routing with benchmark-based escalation for hard tasks, repairs, or reviews.',
    routingPolicy: 'hybrid-default',
  },
  {
    id: 'best-available',
    label: 'Best Available',
    summary: 'Route each lane to the highest-scoring provider available, even if it is not local.',
    routingPolicy: 'best-available',
  },
  {
    id: 'custom',
    label: 'Custom',
    summary: 'Use the saved routing overrides for this workspace and lab combination.',
    routingPolicy: 'custom',
  },
]);

const GS_DEV1_TASK_MODES = Object.freeze([
  { id: 'planner', label: 'Planner', summary: 'Scope work, shape acceptance, and prepare bounded implementation plans.' },
  { id: 'coder', label: 'Coder', summary: 'Implement bounded code changes using the engine\'s existing implementer behavior.' },
  { id: 'validator', label: 'Validator', summary: 'Review diffs, run checks, and decide whether repair or release should follow.' },
  { id: 'summarizer', label: 'Summarizer', summary: 'Prepare summaries, reports, and release-facing output without widening execution scope.' },
]);

const GS_DEV1_RUNTIME_POLICY_DEFAULTS = Object.freeze({
  policyId: 'gosenderr-runtime-policy',
  boundedAutonomy: true,
  preserveTrustSurfaces: true,
  preserveReviewQueue: true,
  preserveSummarySurfaces: true,
});

const GS_DEV1_TRUST_REQUIREMENTS_DEFAULTS = Object.freeze({
  requireReview: true,
  requireTrustedBenchmarks: true,
  requireApprovalSignals: true,
  trustSummaryFamily: 'existing',
});

const WRAPPED_MODEL_ROLE_DEFAULTS = Object.freeze({
  workspace: {
    id: 'workspace',
    label: 'Workspace coding model',
    summary: 'Primary repo-work profile for thread-driven coding, edits, and repair loops.',
  },
  engine: {
    id: 'engine',
    label: 'GSE-1 engine model',
    summary: 'Engine-only profile for planning, review, docs, summaries, and engine-facing operator work.',
  },
});

const MODEL_EXECUTION_ROLE_DEFAULTS = Object.freeze({
  orchestrator: {
    id: 'orchestrator',
    label: 'Front-door chat / orchestrator',
    summary: 'Front-door chat, planning, docs scouting, and operator-facing summaries.',
    laneIds: ['chat-fast', 'plan-reasoning', 'research-docs', 'ops-summary'],
    primaryProfileRole: 'engine',
    primaryLaneId: 'plan-reasoning',
  },
  worker: {
    id: 'worker',
    label: 'Worker',
    summary: 'Implementation and repair loops for bounded coding work.',
    laneIds: ['code-main', 'repair-fast'],
    primaryProfileRole: 'workspace',
    primaryLaneId: 'code-main',
  },
  reviewer: {
    id: 'reviewer',
    label: 'Reviewer / approval reasoning',
    summary: 'Diff review, validation, and approval-aware reasoning.',
    laneIds: ['review-verify'],
    primaryProfileRole: 'engine',
    primaryLaneId: 'review-verify',
  },
});

const CAPABILITY_LANE_PROFILE_ROLE_MAP = Object.freeze({
  'chat-fast': 'engine',
  'code-main': 'workspace',
  'repair-fast': 'workspace',
  'plan-reasoning': 'engine',
  'review-verify': 'engine',
  'research-docs': 'engine',
  'ops-summary': 'engine',
});

const CAPABILITY_LANE_MODEL_ROLE_MAP = Object.freeze({
  'chat-fast': 'orchestrator',
  'plan-reasoning': 'orchestrator',
  'research-docs': 'orchestrator',
  'ops-summary': 'orchestrator',
  'code-main': 'worker',
  'repair-fast': 'worker',
  'review-verify': 'reviewer',
});

function normalizeWrappedProfileId(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return normalized || 'gs-dev-1-default';
}

function normalizeWrappedProfileRole(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'engine' ? 'engine' : 'workspace';
}

function capabilityLaneTaskMode(laneId) {
  const normalized = String(laneId || '').trim().toLowerCase();
  if (normalized === 'chat-fast') {
    return 'planner';
  }
  if (normalized === 'plan-reasoning') {
    return 'planner';
  }
  if (normalized === 'review-verify') {
    return 'validator';
  }
  if (normalized === 'ops-summary') {
    return 'summarizer';
  }
  if (normalized === 'research-docs') {
    return 'planner';
  }
  return 'coder';
}

function capabilityLaneProfileRole(laneId) {
  const normalized = String(laneId || '').trim().toLowerCase();
  return CAPABILITY_LANE_PROFILE_ROLE_MAP[normalized] || 'workspace';
}

function capabilityLaneModelRole(laneId) {
  const normalized = String(laneId || '').trim().toLowerCase();
  return CAPABILITY_LANE_MODEL_ROLE_MAP[normalized] || 'worker';
}

function normalizeTaskModeId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'implementer') {
    return 'coder';
  }
  if (normalized === 'release') {
    return 'summarizer';
  }
  return GS_DEV1_TASK_MODES.some((item) => item.id === normalized) ? normalized : '';
}

function buildDefaultTaskModeRoute(taskMode, options = {}) {
  const currentProvider = String(options.currentProvider || 'ollama').trim().toLowerCase() || 'ollama';
  const localModel = String(options.localModel || 'qwen2.5-coder:7b').trim() || 'qwen2.5-coder:7b';
  const benchmarkModel = String(options.benchmarkModel || localModel).trim() || localModel;
  const remoteProvider = String(options.remoteProvider || 'openai').trim().toLowerCase() || 'openai';
  const remoteModel = String(options.remoteModel || options.modelLabel || 'gpt-5-mini').trim() || 'gpt-5-mini';
  const preferRemote = ['planner', 'validator', 'summarizer'].includes(taskMode) && currentProvider !== 'ollama';

  if (taskMode === 'planner') {
    return {
      taskMode: 'planner',
      runtimeRole: 'planner',
      provider: preferRemote ? remoteProvider : currentProvider,
      model: preferRemote ? remoteModel : benchmarkModel,
      fallbackModel: benchmarkModel,
    };
  }
  if (taskMode === 'coder') {
    return {
      taskMode: 'coder',
      runtimeRole: 'implementer',
      provider: currentProvider,
      model: localModel,
      fallbackModel: benchmarkModel,
    };
  }
  if (taskMode === 'validator') {
    return {
      taskMode: 'validator',
      runtimeRole: 'validator',
      provider: preferRemote ? remoteProvider : currentProvider,
      model: preferRemote ? remoteModel : benchmarkModel,
      fallbackModel: localModel,
    };
  }
  return {
    taskMode: 'summarizer',
    runtimeRole: 'release',
    provider: preferRemote ? remoteProvider : currentProvider,
    model: preferRemote ? remoteModel : benchmarkModel,
    fallbackModel: localModel,
  };
}

function normalizeTaskModeRoute(taskMode, value = {}, options = {}) {
  const fallback = buildDefaultTaskModeRoute(taskMode, options);
  if (!value || typeof value !== 'object') {
    return fallback;
  }
  return {
    taskMode,
    runtimeRole: String(value.runtimeRole || value.runtime_role || fallback.runtimeRole).trim().toLowerCase() || fallback.runtimeRole,
    provider: String(value.provider || fallback.provider).trim().toLowerCase() || fallback.provider,
    model: String(value.model || fallback.model).trim() || fallback.model,
    fallbackModel: String(value.fallbackModel || value.fallback_model || fallback.fallbackModel).trim() || fallback.fallbackModel,
  };
}

function normalizeWrappedTaskModeRoutes(value = {}, options = {}) {
  const input = value && typeof value === 'object' ? value : {};
  return GS_DEV1_TASK_MODES.reduce((accumulator, taskMode) => {
    accumulator[taskMode.id] = normalizeTaskModeRoute(taskMode.id, input[taskMode.id], options);
    return accumulator;
  }, {});
}

function uniqueStrings(values = []) {
  return Array.from(new Set(
    values
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  ));
}

function normalizeWrappedProfile(value = {}, options = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const family = String(input.family || options.family || 'gs-dev-1').trim().toLowerCase() || 'gs-dev-1';
  const role = normalizeWrappedProfileRole(input.role || options.role);
  const roleConfig = WRAPPED_MODEL_ROLE_DEFAULTS[role];
  const benchmarkTags = Array.isArray(input.benchmarkTags)
    ? input.benchmarkTags.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const profileId = normalizeWrappedProfileId(input.id || input.profileId || options.defaultId || 'gs-dev-1-default');
  const displayName = String(input.displayName || input.label || input.name || options.displayName || 'GS-Dev-1').trim() || 'GS-Dev-1';
  const baseProvider = String(input.baseProvider || options.baseProvider || 'ollama').trim().toLowerCase() || 'ollama';
  const baseModel = String(input.baseModel || options.baseModel || 'qwen2.5-coder:7b').trim() || 'qwen2.5-coder:7b';
  const providerSource = String(input.providerSource || input.baseSource || options.providerSource || baseProvider).trim().toLowerCase() || baseProvider;
  const taskModeRoutes = normalizeWrappedTaskModeRoutes(input.taskModeRoutes || input.task_mode_routes, {
    currentProvider: baseProvider,
    localModel: baseModel,
    benchmarkModel: options.benchmarkModel || baseModel,
    remoteProvider: options.remoteProvider || 'openai',
    remoteModel: options.remoteModel || options.modelLabel || 'gpt-5-mini',
    modelLabel: options.modelLabel || baseModel,
  });
  return {
    id: profileId,
    profileId,
    type: 'wrapped-model-profile',
    family,
    role,
    roleLabel: roleConfig.label,
    roleSummary: roleConfig.summary,
    label: displayName,
    displayName,
    summary: String(input.summary || 'Wrap the base model with GoSenderr routing, trust, benchmark, export, and promotion policy.').trim(),
    baseModel,
    baseProvider,
    providerSource,
    taskModeRoutes,
    taskModes: GS_DEV1_TASK_MODES,
    runtimePolicy: {
      ...GS_DEV1_RUNTIME_POLICY_DEFAULTS,
      ...(input.runtimePolicy && typeof input.runtimePolicy === 'object' ? input.runtimePolicy : {}),
    },
    trustRequirements: {
      ...GS_DEV1_TRUST_REQUIREMENTS_DEFAULTS,
      ...(input.trustRequirements && typeof input.trustRequirements === 'object' ? input.trustRequirements : {}),
    },
    benchmarkTags: Array.from(new Set([family, role, baseProvider, ...benchmarkTags])),
    datasetExport: {
      eligible: input.datasetExport?.eligible !== false,
      trustedOnly: input.datasetExport?.trustedOnly !== false,
      approvalRequired: input.datasetExport?.approvalRequired !== false,
    },
    foundry: {
      seedable: input.foundry?.seedable !== false,
      candidateId: String(input.foundry?.candidateId || '').trim(),
    },
    promotion: {
      channel: String(input.promotion?.channel || 'candidate').trim().toLowerCase() || 'candidate',
      rollbackReady: input.promotion?.rollbackReady !== false,
      variantType: String(input.promotion?.variantType || 'wrapped').trim().toLowerCase() || 'wrapped',
    },
    benchmarkIdentity: {
      profileId,
      baseModel,
      providerSource,
    },
  };
}

function buildWrappedProfiles(settings = {}, benchmarkSummary = [], providers = []) {
  const currentProvider = resolveCurrentProvider(String(settings.runtime || 'ollama').trim().toLowerCase() || 'ollama', providers, settings);
  const remoteProvider = normalizeRemoteProviderId(settings.aiRemoteProvider || 'openai');
  const remotePreset = resolveRemoteProviderPreset(settings);
  const selectedRemoteProvider = providers.find((provider) => String(provider?.id || '') === remoteProvider) || null;
  const remoteAvailable = selectedRemoteProvider?.available === true;
  const baseModel = ['ollama', 'local'].includes(currentProvider)
    ? String(settings.trainingOllamaModel || settings.model || 'qwen2.5-coder:7b').trim() || 'qwen2.5-coder:7b'
    : String(settings.aiRemoteModel || settings.model || remotePreset.models?.[0]?.id || 'gpt-5-mini').trim() || 'gpt-5-mini';
  const benchmarkModel = String(benchmarkSummary[0]?.model || baseModel).trim() || baseModel;
  const defaultWorkspaceProfile = normalizeWrappedProfile({
    id: 'gs-dev-1-default',
    displayName: 'GS-Dev-1 Default',
    benchmarkTags: ['default', 'workspace'],
    role: 'workspace',
  }, {
    family: 'gs-dev-1',
    baseProvider: currentProvider,
    baseModel,
    providerSource: currentProvider,
    benchmarkModel,
    remoteProvider,
    remoteModel: String(settings.aiRemoteModel || remotePreset.models?.[0]?.id || 'gpt-5-mini').trim(),
    modelLabel: String(settings.model || baseModel).trim(),
  });
  const defaultEngineProvider = remoteAvailable ? remoteProvider : inferProviderForModel(benchmarkModel, currentProvider);
  const defaultEngineModel = remoteAvailable
    ? String(settings.aiRemoteModel || remotePreset.models?.[0]?.id || benchmarkModel).trim() || benchmarkModel
    : benchmarkModel;
  const defaultEngineProfile = normalizeWrappedProfile({
    id: 'gse-1-engine',
    displayName: 'GSE-1 Engine',
    summary: 'Engine-only wrapped profile for planning, review, docs research, ops summaries, and engine-facing control work.',
    benchmarkTags: ['engine', 'gse-1'],
    role: 'engine',
  }, {
    family: 'gse-1',
    baseProvider: defaultEngineProvider,
    baseModel: defaultEngineModel,
    providerSource: defaultEngineProvider,
    benchmarkModel,
    remoteProvider,
    remoteModel: String(settings.aiRemoteModel || remotePreset.models?.[0]?.id || defaultEngineModel).trim(),
    modelLabel: String(settings.aiRemoteModel || defaultEngineModel).trim(),
  });
  const storedProfiles = Array.isArray(settings.aiWrappedProfiles) ? settings.aiWrappedProfiles : [];
  const workspaceSelectedId = normalizeWrappedProfileId(settings.aiWorkspaceWrappedProfileId || settings.aiWrappedProfileId || defaultWorkspaceProfile.id);
  const engineSelectedId = normalizeWrappedProfileId(settings.aiEngineWrappedProfileId || defaultEngineProfile.id);
  const profiles = [defaultWorkspaceProfile, defaultEngineProfile];
  for (const candidate of storedProfiles) {
    const normalized = normalizeWrappedProfile(candidate, {
      family: candidate?.family || undefined,
      role: candidate?.role || undefined,
      baseProvider: currentProvider,
      baseModel,
      providerSource: currentProvider,
      benchmarkModel,
      remoteProvider,
      remoteModel: String(settings.aiRemoteModel || remotePreset.models?.[0]?.id || 'gpt-5-mini').trim(),
      modelLabel: String(settings.model || baseModel).trim(),
    });
    if (!profiles.some((item) => item.id === normalized.id)) {
      profiles.push(normalized);
    }
  }
  return profiles.map((profile) => ({
    ...profile,
    active: profile.id === workspaceSelectedId,
    activeWorkspace: profile.id === workspaceSelectedId,
    activeEngine: profile.id === engineSelectedId,
  }));
}

const AI_ROUTING_POLICIES = Object.freeze([
  {
    id: 'local-fast',
    label: 'Local Fast',
    summary: 'Keep routing on the lightest local path unless the lane is explicitly overridden.',
  },
  {
    id: 'balanced-local',
    label: 'Balanced Local',
    summary: 'Prefer local lanes, but allow stronger benchmarked routes for planning, review, and docs work.',
  },
  {
    id: 'hybrid-default',
    label: 'Hybrid Default',
    summary: 'Use local-first routing with benchmark-driven escalation for harder reasoning lanes.',
  },
  {
    id: 'best-available',
    label: 'Best Available',
    summary: 'Route each lane to the best benchmark leader that is currently reachable.',
  },
  {
    id: 'custom',
    label: 'Custom',
    summary: 'Use lane overrides where they exist and inherit the current workspace defaults everywhere else.',
  },
]);

const REMOTE_PROVIDER_PRESETS = Object.freeze([
  {
    id: 'openai',
    label: 'OpenAI',
    summary: 'Official OpenAI-compatible remote route for hard reasoning, review, and vision follow-ups.',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyName: 'OPENAI_API_KEY',
      models: [
        { id: 'gpt-5-mini', label: 'GPT-5 Mini' },
        { id: 'gpt-5.4', label: 'GPT-5.4' },
        { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
      ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    summary: 'OpenAI-compatible routing across many hosted providers and open-weight models.',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyName: 'OPENROUTER_API_KEY',
    models: [
      { id: 'openai/gpt-oss-20b', label: 'GPT OSS 20B' },
      { id: 'openai/gpt-oss-120b', label: 'GPT OSS 120B' },
    ],
  },
  {
    id: 'groq',
    label: 'Groq',
    summary: 'OpenAI-compatible low-latency inference for lightweight reasoning and ops summaries.',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyName: 'GROQ_API_KEY',
    models: [
      { id: 'openai/gpt-oss-20b', label: 'GPT OSS 20B' },
      { id: 'openai/gpt-oss-120b', label: 'GPT OSS 120B' },
    ],
  },
  {
    id: 'together',
    label: 'Together',
    summary: 'OpenAI-compatible hosted open-weight coding and reasoning models.',
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyName: 'TOGETHER_API_KEY',
    models: [
      { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', label: 'Qwen2.5 Coder 32B' },
      { id: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', label: 'Llama 3.1 70B Turbo' },
    ],
  },
  {
    id: 'huggingface',
    label: 'Hugging Face Router',
    summary: 'OpenAI-compatible router for vetted hosted models plus Hugging Face model discovery.',
    baseUrl: 'https://router.huggingface.co/v1',
    apiKeyName: 'HUGGINGFACE_API_KEY',
    models: [
      { id: 'openai/gpt-oss-120b:groq', label: 'GPT OSS 120B via Groq' },
      { id: 'meta-llama/Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B Instruct' },
    ],
  },
  {
    id: 'custom-compatible',
    label: 'Custom Compatible',
    summary: 'Bring your own OpenAI-compatible endpoint, key name, and model selector.',
    baseUrl: '',
    apiKeyName: 'OPENAI_COMPAT_API_KEY',
    models: [],
  },
]);

const PROVIDER_CATALOG = Object.freeze([
  { id: 'ollama', label: 'Ollama', summary: 'Local model server for the default code-first path.' },
  { id: 'local', label: 'Local Bridge', summary: 'External local command bridge for custom local models or wrappers.' },
  ...REMOTE_PROVIDER_PRESETS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    summary: provider.summary,
    baseUrl: provider.baseUrl,
    apiKeyName: provider.apiKeyName,
    remote: true,
  })),
]);

const AI_BRIDGE_PROFILES = Object.freeze([
  {
    id: 'llama-bridge',
    label: 'Llama Bridge',
    summary: 'Use the bundled llama local bridge for selector-first local coding.',
    command: 'backend/.venv/bin/python backend/scripts/local_ai_llama_bridge.py',
  },
  {
    id: 'gpt4all-bridge',
    label: 'GPT4All Bridge',
    summary: 'Use the bundled GPT4All bridge for local chat or lighter coding experiments.',
    command: 'backend/.venv/bin/python backend/scripts/local_ai_gpt4all_bridge.py',
  },
  {
    id: 'custom',
    label: 'Custom',
    summary: 'Reveal manual text fields and provide a custom bridge command yourself.',
    command: '',
  },
]);

function normalizeProfileId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return AI_PROFILE_PRESETS.some((item) => item.id === normalized) ? normalized : 'hybrid-default';
}

function normalizeRoutingPolicy(value, fallback = 'hybrid-default') {
  const normalized = String(value || '').trim().toLowerCase();
  if (AI_ROUTING_POLICIES.some((item) => item.id === normalized)) {
    return normalized;
  }
  const normalizedFallback = String(fallback || '').trim().toLowerCase();
  if (AI_ROUTING_POLICIES.some((item) => item.id === normalizedFallback)) {
    return normalizedFallback;
  }
  return 'hybrid-default';
}

function normalizeRemoteProviderId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return REMOTE_PROVIDER_PRESETS.some((item) => item.id === normalized) ? normalized : 'openai';
}

function normalizeRemoteProviderSecretName(value, fallback = 'OPENAI_COMPAT_API_KEY') {
  const defaultName = String(fallback || 'OPENAI_COMPAT_API_KEY').trim() || 'OPENAI_COMPAT_API_KEY';
  const normalized = String(value || '').trim();
  if (!normalized) {
    return defaultName;
  }
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized) ? normalized : defaultName;
}

function resolveRemoteProviderPreset(settings = {}) {
  const selectedId = normalizeRemoteProviderId(settings.aiRemoteProvider || 'openai');
  const preset = REMOTE_PROVIDER_PRESETS.find((item) => item.id === selectedId) || REMOTE_PROVIDER_PRESETS[0];
  if (selectedId !== 'custom-compatible') {
    return preset;
  }
  return {
    ...preset,
    baseUrl: String(settings.aiRemoteBaseUrl || '').trim(),
    apiKeyName: normalizeRemoteProviderSecretName(
      settings.aiRemoteApiKeyName,
      preset.apiKeyName || 'OPENAI_COMPAT_API_KEY',
    ),
  };
}

function listRemoteProviderSecretNames() {
  return Array.from(new Set(
    REMOTE_PROVIDER_PRESETS
      .map((item) => String(item.apiKeyName || '').trim())
      .filter(Boolean),
  ));
}

function normalizeLaneOverride(value = {}) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const mode = String(value.mode || '').trim().toLowerCase();
  if (!['inherit', 'benchmark', 'model', 'current'].includes(mode)) {
    return null;
  }
  if (mode === 'inherit') {
    return null;
  }
  const provider = String(value.provider || '').trim().toLowerCase();
  const model = String(value.model || '').trim();
  if (mode === 'model' && !model) {
    return null;
  }
  return {
    mode,
    provider,
    model,
  };
}

function normalizeLaneOverrides(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  return AI_CAPABILITY_LANES.reduce((accumulator, lane) => {
    const normalized = normalizeLaneOverride(input[lane.id]);
    if (normalized) {
      accumulator[lane.id] = normalized;
    }
    return accumulator;
  }, {});
}

function classifyPressure(value, thresholds = {}) {
  const numeric = Math.max(0, Number(value || 0));
  if (numeric >= Number(thresholds.critical || 90)) {
    return 'critical';
  }
  if (numeric >= Number(thresholds.high || 80)) {
    return 'high';
  }
  if (numeric >= Number(thresholds.elevated || 65)) {
    return 'elevated';
  }
  return 'normal';
}

function normalizeThermalPressure(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['heavy', 'limited', 'serious', 'critical'].includes(normalized)) {
    return 'high';
  }
  if (['warm', 'elevated', 'fair'].includes(normalized)) {
    return 'elevated';
  }
  if (['nominal', 'normal', 'none'].includes(normalized)) {
    return 'normal';
  }
  return 'unknown';
}

function summarizeResourcePolicy(telemetry = {}, providers = []) {
  const memoryUsedPercent = Number(telemetry?.memory?.usedPercent || telemetry?.memoryUsedPercent || 0);
  const cpuUsagePercent = Number(telemetry?.cpuUsagePercent || 0);
  const thermalState = String(telemetry?.thermal?.state || telemetry?.thermalState || 'unknown');
  const activeRuns = Number(telemetry?.runtime?.activeRuns || telemetry?.activeRuns || 0);
  const schedulerRunning = telemetry?.runtime?.schedulerRunning === true || telemetry?.schedulerRunning === true;
  const storageReachable = telemetry?.models?.storageReachable !== false;
  const memoryPressure = classifyPressure(memoryUsedPercent, { elevated: 70, high: 85, critical: 92 });
  const cpuPressure = classifyPressure(cpuUsagePercent, { elevated: 60, high: 80, critical: 92 });
  const thermalPressure = normalizeThermalPressure(thermalState);
  const activeRunContention = activeRuns >= 2 ? 'high' : activeRuns >= 1 ? 'elevated' : 'normal';
  const providerBlockers = providers.filter((provider) => provider.available !== true).map((provider) => provider.id);
  const shouldThrottle = [memoryPressure, cpuPressure, thermalPressure, activeRunContention].some((value) => ['high', 'critical'].includes(value))
    || !storageReachable;
  const recommendedProfileId = shouldThrottle ? 'local-fast' : 'hybrid-default';
  let summary = 'Guardrails look healthy for benchmarked hybrid routing.';
  if (!storageReachable) {
    summary = 'Model storage is unreachable, so background work should stay paused until storage comes back.';
  } else if (thermalPressure === 'high') {
    summary = 'Thermal pressure is high, so the engine should prefer lighter lanes and pause background learning.';
  } else if (memoryPressure === 'high' || memoryPressure === 'critical') {
    summary = 'Memory pressure is high, so the engine should downgrade model size and keep background work quiet.';
  } else if (cpuPressure === 'high' || cpuPressure === 'critical') {
    summary = 'CPU pressure is high, so routing should stay conservative until the machine cools off.';
  } else if (activeRunContention === 'high') {
    summary = 'Multiple active runs are competing for the machine, so new heavy work should queue behind the current load.';
  }
  return {
    memoryPressure,
    cpuPressure,
    thermalPressure,
    activeRunContention,
    schedulerRunning,
    storageReachable,
    providerBlockers,
    recommendedProfileId,
    shouldThrottleBackgroundWork: shouldThrottle,
    summary,
  };
}

function summarizeBenchmarks(runs = []) {
  const buckets = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    const actualModel = String(run?.model || run?.runtime || 'unknown').trim() || 'unknown';
    const profileKey = String(run?.modelProfileId || run?.profileId || '').trim();
    const modelKey = profileKey ? `${profileKey}::${actualModel}` : actualModel;
    const current = buckets.get(modelKey) || {
      model: actualModel,
      modelProfileId: profileKey,
      baseModel: String(run?.baseModel || '').trim(),
      taskModes: new Set(),
      providerSources: new Set(),
      runCount: 0,
      passCount: 0,
      latencies: [],
      repairDepths: [],
      approvalCounts: [],
      latestCompletedAt: '',
    };
    current.runCount += 1;
    if (run?.ok !== false && String(run?.status || '').toLowerCase() !== 'fail') {
      current.passCount += 1;
    }
    current.latencies.push(Number(run?.latencyMs || 0));
    current.repairDepths.push(Number(run?.repairDepth || 0));
    current.approvalCounts.push(Number(run?.approvalCount || 0));
    if (run?.taskMode) {
      current.taskModes.add(String(run.taskMode).trim());
    }
    if (run?.providerSource) {
      current.providerSources.add(String(run.providerSource).trim());
    }
    if (!current.baseModel && run?.baseModel) {
      current.baseModel = String(run.baseModel).trim();
    }
    const completedAt = String(run?.completedAt || '');
    if (completedAt && completedAt > current.latestCompletedAt) {
      current.latestCompletedAt = completedAt;
    }
    buckets.set(modelKey, current);
  }

  return Array.from(buckets.values())
    .map((item) => ({
      model: item.model,
      modelProfileId: item.modelProfileId || '',
      baseModel: item.baseModel || '',
      taskModes: Array.from(item.taskModes),
      providerSources: Array.from(item.providerSources),
      runCount: item.runCount,
      passRate: item.runCount > 0 ? Math.round((item.passCount / item.runCount) * 100) : 0,
      averageLatencyMs: Math.round(mean(item.latencies)),
      averageRepairDepth: Number(mean(item.repairDepths).toFixed(2)),
      averageApprovalCount: Number(mean(item.approvalCounts).toFixed(2)),
      latestCompletedAt: item.latestCompletedAt || null,
    }))
    .sort((left, right) => {
      if (right.passRate !== left.passRate) {
        return right.passRate - left.passRate;
      }
      return left.averageLatencyMs - right.averageLatencyMs;
    });
}

function inferProviderForModel(model = '', fallbackProvider = 'ollama') {
  const normalized = String(model || '').trim().toLowerCase();
  if (!normalized) {
    return fallbackProvider;
  }
  if (/^(gpt|o[13]|openai)/.test(normalized) || normalized.includes('gpt-')) {
    return 'openai';
  }
  if (normalized.startsWith('local:')) {
    return 'local';
  }
  return fallbackProvider;
}

function resolveCurrentProvider(runtimeMode = 'ollama', providers = [], settings = {}) {
  const runtime = String(runtimeMode || 'ollama').trim().toLowerCase() || 'ollama';
  const selectedRemoteProvider = normalizeRemoteProviderId(settings.aiRemoteProvider || 'openai');
  if (['ollama', 'local'].includes(runtime)) {
    return runtime;
  }
  if (runtime === 'openai') {
    return selectedRemoteProvider;
  }
  if (runtime === 'hybrid') {
    if (providers.some((provider) => provider.id === 'ollama' && provider.available === true)) {
      return 'ollama';
    }
    if (providers.some((provider) => provider.id === 'local' && provider.available === true)) {
      return 'local';
    }
    if (providers.some((provider) => provider.id === selectedRemoteProvider && provider.available === true)) {
      return selectedRemoteProvider;
    }
  }
  return 'ollama';
}

function buildAvailableModels(settings = {}, tuningStatus = {}) {
  const telemetry = tuningStatus?.telemetry || {};
  const options = Array.isArray(telemetry?.models?.availableOptions) ? telemetry.models.availableOptions : [];
  const available = [];
  const seen = new Set();

  for (const option of options) {
    const model = String(option?.value || option?.label || '').trim();
    if (!model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    available.push({
      model,
      label: String(option?.label || model).trim() || model,
      provider: inferProviderForModel(model, String(option?.source || '').trim().toLowerCase() === 'local' ? 'local' : 'ollama'),
      ready: option?.ready !== false,
      note: String(option?.note || '').trim(),
      source: String(option?.source || '').trim() || 'ollama',
    });
  }

  const currentModel = String(settings.trainingOllamaModel || settings.model || '').trim();
  if (currentModel && !seen.has(currentModel)) {
    available.unshift({
      model: currentModel,
      label: currentModel,
      provider: inferProviderForModel(currentModel, 'ollama'),
      ready: false,
      note: 'current setting',
      source: 'current',
    });
  }

  return available;
}

function buildRemoteModelCatalog(settings = {}) {
  const preset = resolveRemoteProviderPreset(settings);
  const currentModel = String(settings.aiRemoteModel || settings.model || '').trim();
  const catalog = [];
  const seen = new Set();

  for (const item of Array.isArray(preset.models) ? preset.models : []) {
    const model = String(item?.id || item?.model || '').trim();
    if (!model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    catalog.push({
      model,
      label: String(item?.label || model).trim() || model,
      provider: preset.id,
      source: preset.id,
      note: preset.summary,
      ready: true,
    });
  }

  if (currentModel && !seen.has(currentModel)) {
    catalog.unshift({
      model: currentModel,
      label: currentModel,
      provider: preset.id,
      source: 'current',
      note: 'current setting',
      ready: false,
    });
  }

  return catalog;
}

function buildModelCatalog(settings = {}, tuningStatus = {}, availableModels = []) {
  const recommended = Array.isArray(tuningStatus?.recommendedModels) ? tuningStatus.recommendedModels : [];
  const catalog = [];
  const seen = new Set();

  for (const item of availableModels) {
    const key = `${String(item?.provider || 'ollama').trim().toLowerCase()}::${String(item?.model || '').trim()}`;
    if (!String(item?.model || '').trim() || seen.has(key)) {
      continue;
    }
    seen.add(key);
    catalog.push({
      model: String(item.model || '').trim(),
      label: String(item.label || item.model || '').trim(),
      provider: String(item.provider || 'ollama').trim().toLowerCase(),
      ready: item.ready !== false,
      source: 'discovered',
      note: String(item.note || '').trim(),
    });
  }

  for (const item of recommended) {
    const model = String(item?.ollamaModel || '').trim();
    if (!model) {
      continue;
    }
    const key = `ollama::${model}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    catalog.push({
      model,
      label: String(item?.label || model).trim(),
      provider: 'ollama',
      ready: false,
      source: 'recommended',
      note: String(item?.sizeLabel || item?.fileName || '').trim(),
    });
  }

  const currentModel = String(settings.trainingOllamaModel || settings.model || '').trim();
  if (currentModel) {
    const key = `${inferProviderForModel(currentModel, 'ollama')}::${currentModel}`;
    if (!seen.has(key)) {
      catalog.unshift({
        model: currentModel,
        label: currentModel,
        provider: inferProviderForModel(currentModel, 'ollama'),
        ready: false,
        source: 'current',
        note: 'current setting',
      });
    }
  }

  return catalog;
}

function defaultLaneRoute(lane, options = {}) {
  const routingPolicy = options.routingPolicy || 'hybrid-default';
  const laneTaskMode = capabilityLaneTaskMode(lane.id);
  const profileRole = capabilityLaneProfileRole(lane.id);
  const modelRoleId = capabilityLaneModelRole(lane.id);
  const inheritedProfile = profileRole === 'engine'
    ? (options.engineProfile || options.workspaceProfile || null)
    : (options.workspaceProfile || options.engineProfile || null);
  const inheritedRoute = inheritedProfile?.taskModeRoutes?.[laneTaskMode] || null;
  const currentProvider = String(inheritedRoute?.provider || inheritedProfile?.baseProvider || options.currentProvider || 'ollama').trim().toLowerCase() || 'ollama';
  const currentModel = String(inheritedRoute?.model || inheritedProfile?.baseModel || options.currentModel || 'qwen2.5-coder:7b').trim() || 'qwen2.5-coder:7b';
  const fallbackModel = String(inheritedRoute?.fallbackModel || inheritedRoute?.fallback_model || currentModel).trim() || currentModel;
  const fallbackProvider = String(inheritedRoute?.fallbackProvider || inheritedRoute?.fallback_provider || currentProvider).trim().toLowerCase() || currentProvider;
  const bestModel = options.bestModel || currentModel;
  const bestProvider = options.bestProvider || inferProviderForModel(bestModel, currentProvider);
  const benchmarkAllowed = !!bestModel && bestModel !== currentModel;
  const heavyReasoningLane = ['plan-reasoning', 'review-verify', 'research-docs', 'ops-summary'].includes(lane.id);
  const roleConfig = WRAPPED_MODEL_ROLE_DEFAULTS[profileRole];
  const modelRoleConfig = MODEL_EXECUTION_ROLE_DEFAULTS[modelRoleId];
  const inheritedFields = {
    profileRole,
    profileId: inheritedProfile?.id || '',
    profileLabel: inheritedProfile?.displayName || inheritedProfile?.label || roleConfig.label,
    profileFamily: inheritedProfile?.family || (profileRole === 'engine' ? 'gse-1' : 'gs-dev-1'),
    routeTaskMode: laneTaskMode,
    inheritsFromLabel: roleConfig.label,
    modelRoleId,
    modelRoleLabel: modelRoleConfig?.label || 'Worker',
    modelRoleSummary: modelRoleConfig?.summary || 'Bounded coding work.',
    fallbackModel,
    fallbackProvider,
  };

  if (routingPolicy === 'best-available' && benchmarkAllowed) {
    return {
      ...inheritedFields,
      provider: bestProvider,
      preferredModel: bestModel,
      source: 'benchmark',
      sourceLabel: 'Benchmark leader',
      providerSource: bestProvider,
    };
  }

  if (
    benchmarkAllowed
    && ['balanced-local', 'hybrid-default'].includes(routingPolicy)
    && heavyReasoningLane
  ) {
    return {
      ...inheritedFields,
      provider: bestProvider,
      preferredModel: bestModel,
      source: 'benchmark',
      sourceLabel: 'Benchmark leader',
      providerSource: bestProvider,
    };
  }

  return {
    ...inheritedFields,
    provider: currentProvider,
    preferredModel: currentModel,
    source: 'default',
    sourceLabel: `Inherited from ${roleConfig.label}`,
    providerSource: currentProvider,
  };
}

function resolveLaneAssignment(lane, options = {}) {
  const defaultRoute = defaultLaneRoute(lane, options);
  const override = options.laneOverrides?.[lane.id] || null;
  if (!override) {
    return defaultRoute;
  }
  if (override.mode === 'benchmark' && options.bestModel) {
    return {
      profileRole: defaultRoute.profileRole,
      profileId: defaultRoute.profileId,
      profileLabel: defaultRoute.profileLabel,
      profileFamily: defaultRoute.profileFamily,
      routeTaskMode: defaultRoute.routeTaskMode,
      inheritsFromLabel: defaultRoute.inheritsFromLabel,
      modelRoleId: defaultRoute.modelRoleId,
      modelRoleLabel: defaultRoute.modelRoleLabel,
      modelRoleSummary: defaultRoute.modelRoleSummary,
      provider: options.bestProvider,
      preferredModel: options.bestModel,
      source: 'override',
      sourceLabel: 'Manual benchmark override',
      overrideMode: 'benchmark',
      providerSource: options.bestProvider,
      fallbackModel: defaultRoute.fallbackModel,
      fallbackProvider: defaultRoute.fallbackProvider,
    };
  }
  if (override.mode === 'current') {
    return {
      profileRole: defaultRoute.profileRole,
      profileId: defaultRoute.profileId,
      profileLabel: defaultRoute.profileLabel,
      profileFamily: defaultRoute.profileFamily,
      routeTaskMode: defaultRoute.routeTaskMode,
      inheritsFromLabel: defaultRoute.inheritsFromLabel,
      modelRoleId: defaultRoute.modelRoleId,
      modelRoleLabel: defaultRoute.modelRoleLabel,
      modelRoleSummary: defaultRoute.modelRoleSummary,
      provider: options.currentProvider,
      preferredModel: options.currentModel,
      source: 'override',
      sourceLabel: 'Pinned to current route',
      overrideMode: 'current',
      providerSource: options.currentProvider,
      fallbackModel: defaultRoute.fallbackModel,
      fallbackProvider: defaultRoute.fallbackProvider,
    };
  }
  if (override.mode === 'model' && override.model) {
    const provider = override.provider || inferProviderForModel(override.model, options.currentProvider);
    return {
      profileRole: defaultRoute.profileRole,
      profileId: defaultRoute.profileId,
      profileLabel: defaultRoute.profileLabel,
      profileFamily: defaultRoute.profileFamily,
      routeTaskMode: defaultRoute.routeTaskMode,
      inheritsFromLabel: defaultRoute.inheritsFromLabel,
      modelRoleId: defaultRoute.modelRoleId,
      modelRoleLabel: defaultRoute.modelRoleLabel,
      modelRoleSummary: defaultRoute.modelRoleSummary,
      provider,
      preferredModel: override.model,
      source: 'override',
      sourceLabel: 'Manual lane override',
      overrideMode: 'model',
      providerSource: provider,
      fallbackModel: defaultRoute.fallbackModel,
      fallbackProvider: defaultRoute.fallbackProvider,
    };
  }
  return defaultRoute;
}

function buildLaneAssignments(settings = {}, benchmarkSummary = [], providers = [], tuningStatus = {}, wrappedProfiles = []) {
  const currentRuntime = String(settings.runtime || 'ollama').trim().toLowerCase() || 'ollama';
  const selectedRemotePreset = resolveRemoteProviderPreset(settings);
  const currentProvider = resolveCurrentProvider(currentRuntime, providers, settings);
  const currentModel = ['ollama', 'local'].includes(currentProvider)
    ? (String(settings.trainingOllamaModel || settings.model || '').trim() || 'qwen2.5-coder:7b')
    : (String(settings.aiRemoteModel || settings.model || selectedRemotePreset.models?.[0]?.id || 'gpt-5-mini').trim() || 'gpt-5-mini');
  const routingPolicy = normalizeRoutingPolicy(settings.aiRoutingPolicy, settings.aiProfile || 'hybrid-default');
  const bestModel = benchmarkSummary[0]?.model || currentModel;
  const bestProvider = inferProviderForModel(bestModel, currentProvider);
  const laneOverrides = normalizeLaneOverrides(settings.aiLaneOverrides);
  const availableModels = buildAvailableModels(settings, tuningStatus);
  const workspaceProfileId = normalizeWrappedProfileId(settings.aiWorkspaceWrappedProfileId || settings.aiWrappedProfileId || 'gs-dev-1-default');
  const engineProfileId = normalizeWrappedProfileId(settings.aiEngineWrappedProfileId || 'gse-1-engine');
  const workspaceProfile = wrappedProfiles.find((profile) => profile.id === workspaceProfileId)
    || wrappedProfiles.find((profile) => profile.activeWorkspace)
    || wrappedProfiles.find((profile) => profile.role === 'workspace')
    || wrappedProfiles[0]
    || null;
  const engineProfile = wrappedProfiles.find((profile) => profile.id === engineProfileId)
    || wrappedProfiles.find((profile) => profile.activeEngine)
    || wrappedProfiles.find((profile) => profile.role === 'engine')
    || workspaceProfile
    || null;
  return AI_CAPABILITY_LANES.map((lane) => ({
    ...lane,
    ...resolveLaneAssignment(lane, {
      routingPolicy,
      currentProvider,
      currentModel,
      bestModel,
      bestProvider,
      laneOverrides,
      workspaceProfile,
      engineProfile,
    }),
    currentProvider,
    currentModel,
    defaultProvider: defaultLaneRoute(lane, {
      routingPolicy,
      currentProvider,
      currentModel,
      bestModel,
      bestProvider,
      workspaceProfile,
      engineProfile,
    }).provider,
    defaultModel: defaultLaneRoute(lane, {
      routingPolicy,
      currentProvider,
      currentModel,
      bestModel,
      bestProvider,
      workspaceProfile,
      engineProfile,
    }).preferredModel,
    override: laneOverrides[lane.id] || null,
    availableModels,
  }));
}

function summarizeExecutionRoleProvisioning(roleLanes = [], provisioning = {}) {
  const provisioningRoles = Array.isArray(provisioning?.roles) ? provisioning.roles : [];
  const matched = [];
  for (const lane of roleLanes) {
    const match = provisioningRoles.find((item) => (
      String(item?.wrappedProfileId || '').trim() === String(lane?.profileId || '').trim()
      || String(item?.wrappedProfileRole || item?.role || '').trim().toLowerCase() === String(lane?.profileRole || '').trim().toLowerCase()
    ));
    if (match && !matched.some((item) => String(item?.wrappedProfileId || item?.role || '') === String(match?.wrappedProfileId || match?.role || ''))) {
      matched.push(match);
    }
  }
  const failed = matched.filter((item) => item.state === 'fail');
  const warned = matched.filter((item) => item.state === 'warn');
  const state = failed.length > 0 ? 'fail' : warned.length > 0 ? 'warn' : matched.length > 0 ? 'ready' : 'unknown';
  const local = matched.some((item) => item.local === true);
  const localReady = matched.some((item) => item.localReady === true);
  return {
    provisioningState: state,
    localReadiness: local ? (localReady ? 'ready' : state === 'unknown' ? 'fail' : state) : 'not-local',
    localReady,
    provisioningSummary: matched[0]?.summary || '',
  };
}

function buildExplicitModelRoles(capabilityLanes = [], wrappedProfiles = [], provisioning = {}) {
  const lanes = Array.isArray(capabilityLanes) ? capabilityLanes : [];
  const profiles = Array.isArray(wrappedProfiles) ? wrappedProfiles : [];
  return Object.values(MODEL_EXECUTION_ROLE_DEFAULTS).map((definition) => {
    const roleLanes = lanes.filter((lane) => String(lane?.modelRoleId || '').trim() === definition.id);
    const primaryLane = roleLanes.find((lane) => String(lane?.profileRole || '').trim() === definition.primaryProfileRole)
      || roleLanes.find((lane) => String(lane?.id || '').trim() === definition.primaryLaneId)
      || roleLanes[0]
      || null;
    const primaryProfile = profiles.find((profile) => profile.id === primaryLane?.profileId)
      || profiles.find((profile) => String(profile?.role || '').trim() === definition.primaryProfileRole)
      || profiles[0]
      || null;
    const provisioningSummary = summarizeExecutionRoleProvisioning(roleLanes, provisioning);
    const laneMappings = roleLanes.map((lane) => ({
      laneId: String(lane?.id || '').trim(),
      laneLabel: String(lane?.label || '').trim(),
      taskMode: String(lane?.routeTaskMode || '').trim().toLowerCase(),
      wrappedProfileId: String(lane?.profileId || '').trim(),
      wrappedProfileRole: String(lane?.profileRole || '').trim().toLowerCase(),
      provider: String(lane?.provider || '').trim().toLowerCase(),
      providerSource: String(lane?.providerSource || lane?.provider || '').trim().toLowerCase(),
      preferredModel: String(lane?.preferredModel || '').trim(),
      fallbackModel: String(lane?.fallbackModel || '').trim(),
      fallbackProvider: String(lane?.fallbackProvider || '').trim().toLowerCase(),
      source: String(lane?.source || '').trim().toLowerCase(),
    }));
    const wrappedProfileIds = uniqueStrings(laneMappings.map((lane) => lane.wrappedProfileId));
    const taskModes = uniqueStrings(laneMappings.map((lane) => lane.taskMode));
    const primaryRoute = primaryLane?.routeTaskMode
      ? primaryProfile?.taskModeRoutes?.[primaryLane.routeTaskMode] || {}
      : {};
    const supportingProfileIds = wrappedProfileIds.filter((profileId) => profileId !== String(primaryProfile?.id || '').trim());
    return {
      id: definition.id,
      label: definition.label,
      summary: primaryProfile
        ? `${definition.label} is anchored to ${primaryProfile.displayName || primaryProfile.label || primaryProfile.id}${supportingProfileIds.length > 0 ? ` with ${supportingProfileIds.length} supporting wrapped profile lane binding(s)` : ''}.`
        : definition.summary,
      wrappedProfileId: String(primaryProfile?.id || '').trim(),
      wrappedProfileLabel: String(primaryProfile?.displayName || primaryProfile?.label || '').trim(),
      wrappedProfileRole: String(primaryProfile?.role || definition.primaryProfileRole).trim().toLowerCase(),
      wrappedProfileIds,
      baseModel: String(primaryProfile?.baseModel || primaryLane?.preferredModel || '').trim(),
      baseProvider: String(primaryProfile?.baseProvider || primaryLane?.provider || '').trim().toLowerCase(),
      providerSource: String(primaryProfile?.providerSource || primaryLane?.providerSource || primaryLane?.provider || '').trim().toLowerCase(),
      fallbackModel: String(primaryRoute?.fallbackModel || primaryLane?.fallbackModel || '').trim(),
      fallbackProvider: String(primaryRoute?.fallbackProvider || primaryLane?.fallbackProvider || primaryLane?.provider || '').trim().toLowerCase(),
      laneIds: roleLanes.map((lane) => String(lane?.id || '').trim()).filter(Boolean),
      taskModes,
      laneMappings,
      provisioningState: provisioningSummary.provisioningState,
      provisioningSummary: provisioningSummary.provisioningSummary,
      localReadiness: provisioningSummary.localReadiness,
      localReady: provisioningSummary.localReady,
    };
  });
}

function buildProviders(settings = {}, tuningStatus = {}, options = {}) {
  const telemetry = tuningStatus?.telemetry || {};
  const runtimeMode = String(settings.runtime || 'ollama').trim().toLowerCase() || 'ollama';
  const localCmd = String(settings.localAiCmd || '').trim();
  const secretAvailability = options.secretAvailability && typeof options.secretAvailability === 'object'
    ? options.secretAvailability
    : {};
  const selectedRemoteProvider = normalizeRemoteProviderId(settings.aiRemoteProvider || 'openai');
  const selectedRemotePreset = resolveRemoteProviderPreset(settings);
  return PROVIDER_CATALOG.map((provider) => {
    if (provider.id === 'ollama') {
      return {
        ...provider,
        available: telemetry?.ollama?.reachable === true || telemetry?.ollama?.running === true,
        active: runtimeMode === 'ollama' || runtimeMode === 'hybrid',
        detail: telemetry?.ollama?.running
          ? `${telemetry.ollama.modelCount || 0} model(s) ready`
          : 'Ollama idle',
      };
    }
    if (provider.id === 'local') {
      return {
        ...provider,
        available: !!localCmd,
        active: runtimeMode === 'local',
        detail: localCmd || 'No local bridge command configured.',
      };
    }
    const preset = REMOTE_PROVIDER_PRESETS.find((item) => item.id === provider.id) || selectedRemotePreset;
    const secretName = String(
      provider.id === 'custom-compatible'
        ? normalizeRemoteProviderSecretName(
          settings.aiRemoteApiKeyName,
          preset?.apiKeyName || 'OPENAI_COMPAT_API_KEY',
        )
        : (preset?.apiKeyName || provider.apiKeyName || ''),
    ).trim();
    const hasSecret = !!secretAvailability[secretName];
    return {
      ...provider,
      available: hasSecret,
      active: (runtimeMode === 'openai' && provider.id === selectedRemoteProvider)
        || (runtimeMode === 'hybrid' && provider.id === selectedRemoteProvider && telemetry?.ollama?.reachable !== true && telemetry?.ollama?.running !== true && !localCmd),
      detail: hasSecret
        ? `${secretName} configured • ${String((provider.id === 'custom-compatible' ? settings.aiRemoteBaseUrl : (preset?.baseUrl || provider.baseUrl)) || '').trim() || 'compatible endpoint'}`
        : `${secretName || 'API key'} missing • ${String((provider.id === 'custom-compatible' ? settings.aiRemoteBaseUrl : (preset?.baseUrl || provider.baseUrl)) || '').trim() || 'compatible endpoint'}`,
      secretName,
      baseUrl: String((provider.id === 'custom-compatible' ? settings.aiRemoteBaseUrl : (preset?.baseUrl || provider.baseUrl)) || '').trim(),
      supportsVision: provider.id === 'openai' || provider.id === 'huggingface',
    };
  });
}

function providerStatusForRole(roleId, profile = {}, providers = [], availableModels = [], telemetry = {}) {
  const providerId = String(profile?.baseProvider || profile?.providerSource || 'ollama').trim().toLowerCase() || 'ollama';
  const model = String(profile?.baseModel || '').trim();
  const wrappedProfileRole = String(profile?.role || roleId).trim().toLowerCase() || roleId;
  const wrappedProfileId = String(profile?.id || profile?.profileId || '').trim();
  const wrappedProfileLabel = String(profile?.displayName || profile?.label || WRAPPED_MODEL_ROLE_DEFAULTS[wrappedProfileRole]?.label || roleId).trim();
  const provider = providers.find((item) => String(item?.id || '').trim().toLowerCase() === providerId) || null;
  const readyOllamaModels = new Set(
    (Array.isArray(availableModels) ? availableModels : [])
      .filter((item) => String(item?.provider || '').trim().toLowerCase() === 'ollama' && item?.ready !== false)
      .map((item) => String(item?.model || '').trim())
      .filter(Boolean),
  );
  const ollamaRunning = telemetry?.ollama?.running === true || telemetry?.ollama?.reachable === true;
  const ollamaModelCount = Number(telemetry?.ollama?.modelCount || 0);

  if (providerId === 'ollama') {
    const ready = model
      ? (readyOllamaModels.has(model) || (readyOllamaModels.size === 0 && ollamaModelCount > 0))
      : ollamaModelCount > 0;
    if (ready && ollamaRunning) {
      return {
        role: roleId,
        wrappedProfileRole,
        wrappedProfileId,
        wrappedProfileLabel,
        provider: providerId,
        providerSource: providerId,
        model,
        state: 'ready',
        local: true,
        localReady: true,
        summary: `${roleId === 'engine' ? 'Engine' : 'Workspace'} role is provisioned on Ollama${model ? ` with ${model}` : ''}.`,
      };
    }
    if (ollamaRunning && ollamaModelCount > 0) {
      return {
        role: roleId,
        wrappedProfileRole,
        wrappedProfileId,
        wrappedProfileLabel,
        provider: providerId,
        providerSource: providerId,
        model,
        state: 'warn',
        local: true,
        localReady: false,
        summary: `${roleId === 'engine' ? 'Engine' : 'Workspace'} role wants ${model || 'an Ollama model'}, but the selected model is not ready yet.`,
      };
    }
    return {
      role: roleId,
      wrappedProfileRole,
      wrappedProfileId,
      wrappedProfileLabel,
      provider: providerId,
      providerSource: providerId,
      model,
      state: 'fail',
      local: true,
      localReady: false,
      summary: `${roleId === 'engine' ? 'Engine' : 'Workspace'} role is routed to Ollama, but no ready Ollama model is available yet.`,
    };
  }

  if (providerId === 'local') {
    return {
      role: roleId,
      wrappedProfileRole,
      wrappedProfileId,
      wrappedProfileLabel,
      provider: providerId,
      providerSource: providerId,
      model,
      state: provider?.available === true ? 'ready' : 'fail',
      local: true,
      localReady: provider?.available === true,
      summary: provider?.available === true
        ? `${roleId === 'engine' ? 'Engine' : 'Workspace'} role is provisioned through the Local AI bridge.`
        : `${roleId === 'engine' ? 'Engine' : 'Workspace'} role expects a Local AI bridge, but no local command is configured.`,
    };
  }

  return {
    role: roleId,
    wrappedProfileRole,
    wrappedProfileId,
    wrappedProfileLabel,
    provider: providerId,
    providerSource: providerId,
    model,
    state: provider?.available === true ? 'ready' : 'fail',
    local: false,
    localReady: false,
    summary: provider?.available === true
      ? `${roleId === 'engine' ? 'Engine' : 'Workspace'} role is provisioned through ${provider?.label || providerId}.`
      : `${roleId === 'engine' ? 'Engine' : 'Workspace'} role expects ${provider?.label || providerId}, but the required API key is not configured.`,
  };
}

function buildModelProvisioningStatus(options = {}) {
  const settings = options.settings && typeof options.settings === 'object' ? options.settings : {};
  const providers = Array.isArray(options.providers) ? options.providers : [];
  const availableModels = Array.isArray(options.availableModels) ? options.availableModels : [];
  const telemetry = options.telemetry && typeof options.telemetry === 'object' ? options.telemetry : {};
  const workspaceRole = providerStatusForRole('workspace', options.workspaceProfile, providers, availableModels, telemetry);
  const engineRole = providerStatusForRole('engine', options.engineProfile, providers, availableModels, telemetry);
  const roles = [workspaceRole, engineRole];
  const failedRoles = roles.filter((item) => item.state === 'fail');
  const warnedRoles = roles.filter((item) => item.state === 'warn');
  const status = failedRoles.length > 0 ? 'fail' : warnedRoles.length > 0 ? 'warn' : 'ready';
  const selectedProvider = String(options.currentProvider || settings.runtime || 'ollama').trim().toLowerCase() || 'ollama';
  const selectedModel = String(options.currentModel || settings.model || settings.trainingOllamaModel || '').trim();
  const summary = failedRoles.length > 0
    ? failedRoles[0].summary
    : warnedRoles.length > 0
      ? warnedRoles[0].summary
      : 'Workspace and engine model roles are provisioned for the current routing plan.';
  let recommendedAction = 'Keep the next slice bounded and reuse the current model routing.';
  if (failedRoles.some((item) => item.provider === 'ollama')) {
    recommendedAction = `Import or select a ready Ollama model${selectedModel ? ` (${selectedModel})` : ''} before asking the engine for local coding work.`;
  } else if (failedRoles.some((item) => item.provider === 'local')) {
    recommendedAction = 'Set a working Local AI command before routing either model role through the local bridge.';
  } else if (failedRoles.length > 0) {
    recommendedAction = 'Configure the required remote provider key before asking the engine to use that role.';
  } else if (warnedRoles.some((item) => item.provider === 'ollama')) {
    recommendedAction = `Finish provisioning the selected Ollama model${selectedModel ? ` (${selectedModel})` : ''} or switch to a ready one before widening scope.`;
  }
  return {
    status,
    state: status,
    summary,
    recommendedAction,
    currentProvider: selectedProvider,
    currentModel: selectedModel,
    roles,
    blockers: failedRoles.map((item) => item.summary),
    warnings: warnedRoles.map((item) => item.summary),
    ollama: {
      running: telemetry?.ollama?.running === true || telemetry?.ollama?.reachable === true,
      modelCount: Number(telemetry?.ollama?.modelCount || 0),
      selectedModel: String(telemetry?.ollama?.selectedModel || settings.trainingOllamaModel || '').trim(),
      selectedModelReady: telemetry?.ollama?.selectedModelReady === true,
    },
  };
}

function buildAiStatus(options = {}) {
  const workspaceRoot = String(options.workspaceRoot || '').trim();
  const settings = options.settings && typeof options.settings === 'object' ? options.settings : {};
  const tuningStatus = options.tuningStatus && typeof options.tuningStatus === 'object' ? options.tuningStatus : {};
  const benchmarkRuns = Array.isArray(options.benchmarkRuns) ? options.benchmarkRuns : [];
  const profileId = normalizeProfileId(settings.aiProfile);
  const benchmarkSummary = summarizeBenchmarks(benchmarkRuns);
  const providers = buildProviders(settings, tuningStatus, options);
  const wrappedProfiles = buildWrappedProfiles(settings, benchmarkSummary, providers);
  const workspaceWrappedProfileId = normalizeWrappedProfileId(settings.aiWorkspaceWrappedProfileId || settings.aiWrappedProfileId || 'gs-dev-1-default');
  const engineWrappedProfileId = normalizeWrappedProfileId(settings.aiEngineWrappedProfileId || 'gse-1-engine');
  const workspaceWrappedProfile = wrappedProfiles.find((profile) => profile.id === workspaceWrappedProfileId)
    || wrappedProfiles.find((profile) => profile.activeWorkspace)
    || wrappedProfiles.find((profile) => profile.role === 'workspace')
    || wrappedProfiles[0]
    || null;
  const engineWrappedProfile = wrappedProfiles.find((profile) => profile.id === engineWrappedProfileId)
    || wrappedProfiles.find((profile) => profile.activeEngine)
    || wrappedProfiles.find((profile) => profile.role === 'engine')
    || workspaceWrappedProfile
    || null;
  const activeWrappedProfile = workspaceWrappedProfile;
  const telemetry = tuningStatus?.telemetry || {};
  const resourcePolicy = summarizeResourcePolicy(telemetry, providers);
  const availableModels = buildAvailableModels(settings, tuningStatus);
  const modelCatalog = buildModelCatalog(settings, tuningStatus, availableModels);
  const remoteProviderPreset = resolveRemoteProviderPreset(settings);
  const remoteModelCatalog = buildRemoteModelCatalog(settings);
  const currentProvider = resolveCurrentProvider(String(settings.runtime || 'ollama').trim().toLowerCase() || 'ollama', providers, settings);
  const currentModel = ['ollama', 'local'].includes(currentProvider)
    ? String(settings.trainingOllamaModel || settings.model || '').trim()
    : String(settings.aiRemoteModel || settings.model || remoteProviderPreset.models?.[0]?.id || '').trim();
  const derivedModelLabel = ['ollama', 'local'].includes(currentProvider)
    ? (availableModels.find((item) => item.model === currentModel)?.label || currentModel)
    : (remoteModelCatalog.find((item) => item.model === currentModel)?.label || currentModel);
  const provisioning = buildModelProvisioningStatus({
    settings,
    providers,
    availableModels,
    telemetry,
    currentProvider,
    currentModel,
    workspaceProfile: workspaceWrappedProfile,
    engineProfile: engineWrappedProfile,
  });
  const capabilityLanes = buildLaneAssignments(settings, benchmarkSummary, providers, tuningStatus, wrappedProfiles);
  const modelRoles = buildExplicitModelRoles(capabilityLanes, wrappedProfiles, provisioning);
  const localModelInventory = buildLocalModelInventory({
    workspaceRoot,
    settings,
    telemetry,
    wrappedProfiles,
    foundryStatus: options.modelFoundry,
    benchmarkSummary,
  });
  const activeLocalInventoryEntry = localModelInventory.entries.find((entry) => (
    entry.kind === 'wrapped-profile'
    && String(entry.wrappedProfileId || '').trim() === String(activeWrappedProfile?.id || '').trim()
  )) || null;
  const routingPolicies = AI_ROUTING_POLICIES.map((policy) => ({
    ...policy,
    active: policy.id === normalizeRoutingPolicy(settings.aiRoutingPolicy, profileId),
  }));
  return {
    ok: true,
    profileId,
    routingPolicy: normalizeRoutingPolicy(settings.aiRoutingPolicy, AI_PROFILE_PRESETS.find((item) => item.id === profileId)?.routingPolicy || profileId),
    routingPolicies,
    profiles: AI_PROFILE_PRESETS.map((profile) => ({
      ...profile,
      active: profile.id === profileId,
    })),
    capabilityLanes,
    modelRoles,
    localModelInventory,
    providers,
    benchmarkSummary,
    wrappedProfiles,
    taskModes: GS_DEV1_TASK_MODES,
    current: {
      workspaceRoot,
      runtime: String(settings.runtime || 'ollama').trim().toLowerCase() || 'ollama',
      provider: currentProvider,
      modelLabel: String(settings.model || '').trim(),
      derivedModelLabel,
      ollamaModel: String(settings.trainingOllamaModel || '').trim() || 'qwen2.5-coder:7b',
      remoteProvider: remoteProviderPreset.id,
      remoteBaseUrl: String(remoteProviderPreset.baseUrl || '').trim(),
      remoteModel: String(settings.aiRemoteModel || remoteProviderPreset.models?.[0]?.id || '').trim(),
      remoteApiKeyName: String(remoteProviderPreset.apiKeyName || '').trim(),
      localAiCmd: String(settings.localAiCmd || '').trim(),
      manualMode: settings.aiManualMode === true,
      bridgeProfile: String(settings.aiBridgeProfile || 'llama-bridge').trim().toLowerCase() || 'llama-bridge',
      laneOverrides: normalizeLaneOverrides(settings.aiLaneOverrides),
      wrappedProfileId: activeWrappedProfile?.id || '',
      wrappedProfile: activeWrappedProfile,
      workspaceWrappedProfileId: workspaceWrappedProfile?.id || '',
      workspaceWrappedProfile,
      engineWrappedProfileId: engineWrappedProfile?.id || '',
      engineWrappedProfile,
      workerFamily: String(activeLocalInventoryEntry?.workerFamily || localModelInventory.workerFamilies?.primary || '').trim(),
      workerVariantId: String(activeLocalInventoryEntry?.workerVariantId || '').trim(),
      workerVariantType: String(activeLocalInventoryEntry?.workerVariantType || '').trim(),
      promotionPolicy: String(localModelInventory.promotionPolicy || '').trim(),
    },
    availableModels,
    modelCatalog,
    remoteProviders: providers.filter((provider) => provider.remote === true),
    remoteModelCatalog,
    bridgeProfiles: AI_BRIDGE_PROFILES,
    telemetry: {
      sampledAt: telemetry.sampledAt || null,
      cpuUsagePercent: Number(telemetry?.cpuUsagePercent || 0),
      memoryUsedPercent: Number(telemetry?.memory?.usedPercent || 0),
      thermalState: String(telemetry?.thermal?.state || 'unknown'),
      trustSummary: telemetry?.trustSummary || {},
      activeRuns: Number(telemetry?.runtime?.activeRuns || 0),
      schedulerRunning: !!telemetry?.runtime?.schedulerRunning,
    },
    provisioning,
    resourcePolicy,
    gsDev1: {
      wrappedProfiles,
      activeWrappedProfile,
      localInventoryEntry: activeLocalInventoryEntry,
      benchmarkReady: benchmarkSummary.length > 0,
      benchmarkLeader: benchmarkSummary[0] || null,
      datasetExportEligible: activeWrappedProfile?.datasetExport?.eligible === true,
      promotionReady: activeWrappedProfile?.promotion?.rollbackReady === true,
    },
    dualModel: {
      workspaceProfileId: workspaceWrappedProfile?.id || '',
      workspaceProfile: workspaceWrappedProfile,
      engineProfileId: engineWrappedProfile?.id || '',
      engineProfile: engineWrappedProfile,
      roleSummary: {
        workspace: WRAPPED_MODEL_ROLE_DEFAULTS.workspace,
        engine: WRAPPED_MODEL_ROLE_DEFAULTS.engine,
      },
      executionRoles: modelRoles,
    },
  };
}

module.exports = {
  AI_CAPABILITY_LANES,
  AI_BRIDGE_PROFILES,
  GS_DEV1_TASK_MODES,
  MODEL_EXECUTION_ROLE_DEFAULTS,
  AI_PROFILE_PRESETS,
  AI_ROUTING_POLICIES,
  PROVIDER_CATALOG,
  REMOTE_PROVIDER_PRESETS,
  buildAiStatus,
  buildModelProvisioningStatus,
  listRemoteProviderSecretNames,
  normalizeLaneOverrides,
  normalizeProfileId,
  normalizeRemoteProviderId,
  normalizeRoutingPolicy,
  normalizeWrappedProfile,
  normalizeWrappedProfileId,
  resolveRemoteProviderPreset,
  summarizeBenchmarks,
  normalizeRemoteProviderSecretName,
};
