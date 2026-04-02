'use strict';

const { applyLocalModelGuardrailsToConfig, buildLocalModelInventory, buildLocalModelPolicySnapshot } = require('./training-tuning');
const { buildCapabilityDescriptor } = require('./capability-status');
const { buildEngineModelProofSnapshot, buildEngineModelProofViewModel } = require('./engine-model-proof');
const {
  CAPABILITY_ROUTE_LANES,
  MODEL_EXECUTION_ROLE_DEFAULTS,
  WRAPPED_PROFILE_ROLE_DEFAULTS,
  resolveLaneExecutionRoleId,
  normalizeRouteTaskModeId,
  resolveLaneRouteTaskMode,
  resolveLaneWrappedProfileRole,
} = require('./route-schema');

function mean(values = []) {
  const numeric = values.map((item) => Number(item || 0)).filter((item) => Number.isFinite(item));
  if (!numeric.length) {
    return 0;
  }
  return numeric.reduce((sum, item) => sum + item, 0) / numeric.length;
}

const AI_CAPABILITY_LANES = Object.freeze(
  CAPABILITY_ROUTE_LANES.map((lane) => ({
    id: lane.id,
    label: lane.label,
    summary: lane.summary,
  })),
);

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
  { id: 'repair', label: 'Repair', summary: 'Run focused repair loops with the smallest safe fix and bounded retest scope.' },
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

const WRAPPED_MODEL_ROLE_DEFAULTS = WRAPPED_PROFILE_ROLE_DEFAULTS;

const LOCAL_FIRST_BLOCK_PACKS = Object.freeze([
  { taskMode: 'planner', laneId: 'plan-reasoning', label: 'Planner' },
  { taskMode: 'coder', laneId: 'code-main', label: 'Coder' },
  { taskMode: 'validator', laneId: 'review-verify', label: 'Validator' },
]);

const LOCAL_MODEL_PROOF_CAPABILITIES = Object.freeze([
  { id: 'ask-plan', label: 'Ask/plan' },
  { id: 'code', label: 'Code' },
  { id: 'repair', label: 'Repair' },
  { id: 'review-validate', label: 'Review/validate' },
  { id: 'docs-guided', label: 'Docs-guided' },
  { id: 'scaffold-create', label: 'Scaffold/create' },
  { id: 'clone-lab-autonomy', label: 'Clone-lab autonomy' },
]);

const DOCS_GUIDED_PROOF_TAGS = Object.freeze([
  'approved-docs',
  'docs',
  'docs-guided',
  'docs-scout',
  'research-docs',
  'trusted-docs',
]);

const SCAFFOLD_PROOF_TAGS = Object.freeze([
  'builder',
  'builder-proof',
  'create-project',
  'create_project',
  'dummy-node-app',
  'recipe',
  'scaffold',
]);

const AUTONOMY_PROOF_TAGS = Object.freeze([
  'autonomy',
  'autonomy-proof',
  'autonomyproof',
  'clone-lab',
  'clone_lab',
  'lab-autonomy',
]);

function isLocalProvider(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'ollama' || normalized === 'local';
}

function usesLocalPrimaryTaskMode(taskMode) {
  const normalized = normalizeTaskModeId(taskMode) || String(taskMode || '').trim().toLowerCase();
  return ['planner', 'repair', 'coder', 'validator'].includes(normalized);
}

function normalizeWrappedProfileId(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return normalized || 'gs-dev-1-default';
}

function normalizeWrappedProfileRole(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'engine' ? 'engine' : 'workspace';
}

function capabilityLaneTaskMode(laneId) {
  return resolveLaneRouteTaskMode(laneId);
}

function capabilityLaneProfileRole(laneId) {
  return resolveLaneWrappedProfileRole(laneId);
}

function capabilityLaneModelRole(laneId) {
  return resolveLaneExecutionRoleId(laneId);
}

function normalizeTaskModeId(value) {
  const normalized = normalizeRouteTaskModeId(value);
  return GS_DEV1_TASK_MODES.some((item) => item.id === normalized) ? normalized : '';
}

function buildDefaultTaskModeRoute(taskMode, options = {}) {
  const currentProvider = String(options.currentProvider || 'ollama').trim().toLowerCase() || 'ollama';
  const localProvider = String(options.localProvider || (isLocalProvider(currentProvider) ? currentProvider : 'ollama')).trim().toLowerCase() || 'ollama';
  const localModel = String(options.localModel || 'qwen2.5-coder:7b').trim() || 'qwen2.5-coder:7b';
  const benchmarkModel = String(options.benchmarkModel || localModel).trim() || localModel;
  const benchmarkProvider = inferProviderForModel(benchmarkModel, localProvider);
  const remoteProvider = String(options.remoteProvider || 'openai').trim().toLowerCase() || 'openai';
  const remoteModel = String(options.remoteModel || options.modelLabel || 'gpt-5-mini').trim() || 'gpt-5-mini';
  const preferRemote = ['planner', 'validator', 'summarizer'].includes(taskMode) && currentProvider !== 'ollama';
  const localBenchmarkModel = isLocalProvider(benchmarkProvider) ? benchmarkModel : localModel;
  const remoteFallbackModel = remoteModel || benchmarkModel || localModel;
  const remoteFallbackProvider = remoteModel
    ? remoteProvider
    : inferProviderForModel(benchmarkModel || localModel, currentProvider);

  if (usesLocalPrimaryTaskMode(taskMode)) {
    return {
      taskMode,
      runtimeRole: taskMode === 'planner'
        ? 'planner'
        : taskMode === 'validator'
          ? 'validator'
          : 'implementer',
      provider: localProvider,
      model: taskMode === 'coder' ? localModel : localBenchmarkModel,
      fallbackModel: remoteFallbackModel,
      fallbackProvider: remoteFallbackProvider,
    };
  }

  if (taskMode === 'planner') {
    return {
      taskMode: 'planner',
      runtimeRole: 'planner',
      provider: preferRemote ? remoteProvider : currentProvider,
      model: preferRemote ? remoteModel : benchmarkModel,
      fallbackModel: benchmarkModel,
      fallbackProvider: inferProviderForModel(benchmarkModel, currentProvider),
    };
  }
  if (taskMode === 'coder') {
    return {
      taskMode: 'coder',
      runtimeRole: 'implementer',
      provider: currentProvider,
      model: localModel,
      fallbackModel: benchmarkModel,
      fallbackProvider: inferProviderForModel(benchmarkModel, currentProvider),
    };
  }
  if (taskMode === 'repair') {
    return {
      taskMode: 'repair',
      runtimeRole: 'repair',
      provider: currentProvider,
      model: localModel,
      fallbackModel: benchmarkModel,
      fallbackProvider: inferProviderForModel(benchmarkModel, currentProvider),
    };
  }
  if (taskMode === 'validator') {
    return {
      taskMode: 'validator',
      runtimeRole: 'validator',
      provider: preferRemote ? remoteProvider : currentProvider,
      model: preferRemote ? remoteModel : benchmarkModel,
      fallbackModel: localModel,
      fallbackProvider: localProvider,
    };
  }
  return {
    taskMode: 'summarizer',
    runtimeRole: 'release',
    provider: preferRemote ? remoteProvider : currentProvider,
    model: preferRemote ? remoteModel : benchmarkModel,
    fallbackModel: localModel,
    fallbackProvider: localProvider,
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
    fallbackProvider: String(value.fallbackProvider || value.fallback_provider || fallback.fallbackProvider).trim().toLowerCase() || fallback.fallbackProvider,
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
  const routingPolicy = normalizeRoutingPolicy(settings.aiRoutingPolicy, settings.aiProfile || 'hybrid-default');
  const remoteProvider = normalizeRemoteProviderId(settings.aiRemoteProvider || 'openai');
  const remotePreset = resolveRemoteProviderPreset(settings);
  const selectedRemoteProvider = providers.find((provider) => String(provider?.id || '') === remoteProvider) || null;
  const remoteAvailable = selectedRemoteProvider?.available === true;
  const baseModel = ['ollama', 'local'].includes(currentProvider)
    ? String(settings.trainingOllamaModel || settings.model || 'qwen2.5-coder:7b').trim() || 'qwen2.5-coder:7b'
    : String(settings.aiRemoteModel || settings.model || remotePreset.models?.[0]?.id || 'gpt-5-mini').trim() || 'gpt-5-mini';
  const localProvider = isLocalProvider(currentProvider)
    ? currentProvider
    : (String(settings.trainingOllamaModel || '').trim() ? 'ollama' : currentProvider);
  const localModel = String(settings.trainingOllamaModel || (isLocalProvider(currentProvider) ? baseModel : '')).trim();
  const preferLocalPrimary = routingPolicy !== 'best-available' && !!localModel;
  const benchmarkModel = String(benchmarkSummary[0]?.model || baseModel).trim() || baseModel;
  const configuredTaskModeRoutes = settings.taskModeRoutes && typeof settings.taskModeRoutes === 'object'
    ? settings.taskModeRoutes
    : {};
  const workspaceBaseProvider = String(
    settings.workspaceBaseProvider
    || settings.baseProvider
    || (preferLocalPrimary ? localProvider : currentProvider),
  ).trim().toLowerCase() || (preferLocalPrimary ? localProvider : currentProvider);
  const workspaceBaseModel = String(
    settings.workspaceBaseModel
    || settings.baseModel
    || (preferLocalPrimary ? localModel : baseModel),
  ).trim() || (preferLocalPrimary ? localModel : baseModel);
  const workspaceProviderSource = String(
    settings.workspaceProviderSource
    || settings.workspaceBaseProvider
    || settings.providerSource
    || workspaceBaseProvider,
  ).trim().toLowerCase() || workspaceBaseProvider;
  const defaultWorkspaceProfile = normalizeWrappedProfile({
    id: 'gs-dev-1-default',
    displayName: 'GS-Dev-1 Default',
    benchmarkTags: ['default', 'workspace'],
    role: 'workspace',
    baseProvider: workspaceBaseProvider,
    baseModel: workspaceBaseModel,
    providerSource: workspaceProviderSource,
    taskModeRoutes: configuredTaskModeRoutes,
  }, {
    family: 'gs-dev-1',
    baseProvider: workspaceBaseProvider,
    baseModel: workspaceBaseModel,
    providerSource: workspaceProviderSource,
    localProvider,
    localModel: workspaceBaseModel || localModel || baseModel,
    benchmarkModel,
    remoteProvider,
    remoteModel: String(settings.aiRemoteModel || remotePreset.models?.[0]?.id || 'gpt-5-mini').trim(),
    modelLabel: String(settings.model || workspaceBaseModel || baseModel).trim(),
  });
  const defaultEngineProvider = String(
    settings.engineBaseProvider
    || settings.engineProviderSource
    || (preferLocalPrimary
      ? localProvider
      : (remoteAvailable ? remoteProvider : inferProviderForModel(benchmarkModel, currentProvider))),
  ).trim().toLowerCase() || (preferLocalPrimary ? localProvider : inferProviderForModel(benchmarkModel, currentProvider));
  const defaultEngineModel = String(
    settings.engineBaseModel
    || (preferLocalPrimary
      ? localModel
      : (remoteAvailable
        ? String(settings.aiRemoteModel || remotePreset.models?.[0]?.id || benchmarkModel).trim() || benchmarkModel
        : benchmarkModel)),
  ).trim() || benchmarkModel;
  const engineProviderSource = String(
    settings.engineProviderSource
    || settings.engineBaseProvider
    || defaultEngineProvider,
  ).trim().toLowerCase() || defaultEngineProvider;
  const defaultEngineProfile = normalizeWrappedProfile({
    id: 'gse-1-engine',
    displayName: 'GSE-1 Engine',
    summary: 'Engine-only wrapped profile for planning, review, docs research, ops summaries, and engine-facing control work.',
    benchmarkTags: ['engine', 'gse-1'],
    role: 'engine',
    baseProvider: defaultEngineProvider,
    baseModel: defaultEngineModel,
    providerSource: engineProviderSource,
    taskModeRoutes: configuredTaskModeRoutes,
  }, {
    family: 'gse-1',
    baseProvider: defaultEngineProvider,
    baseModel: defaultEngineModel,
    providerSource: engineProviderSource,
    localProvider,
    localModel: defaultEngineModel || localModel,
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
      localProvider,
      localModel: localModel || baseModel,
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
    summary: 'Use route overrides where they exist and keep the active profile defaults everywhere else.',
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

function benchmarkRunPassed(run = {}) {
  return run?.ok !== false && String(run?.status || '').trim().toLowerCase() !== 'fail';
}

function buildLocalBenchmarkPack(pack = {}, capabilityLanes = [], benchmarkRuns = []) {
  const taskMode = String(pack.taskMode || '').trim().toLowerCase();
  const laneId = String(pack.laneId || '').trim().toLowerCase();
  const lane = capabilityLanes.find((item) => String(item?.id || '').trim().toLowerCase() === laneId) || null;
  const expectedProvider = String(lane?.providerSource || lane?.provider || '').trim().toLowerCase();
  const expectedModel = String(lane?.preferredModel || '').trim();
  const expectedProfileId = String(lane?.profileId || '').trim();
  const relevantRuns = (Array.isArray(benchmarkRuns) ? benchmarkRuns : []).filter((run) => {
    const runTaskMode = normalizeTaskModeId(run?.taskMode || run?.mode || '');
    if (runTaskMode !== taskMode) {
      return false;
    }
    const runProvider = String(
      run?.providerSource || inferProviderForModel(run?.baseModel || run?.model || '', expectedProvider || 'ollama')
    ).trim().toLowerCase();
    if (!isLocalProvider(runProvider)) {
      return false;
    }
    const runProfileId = String(run?.modelProfileId || run?.wrappedProfileId || run?.profileId || '').trim();
    const runBaseModel = String(run?.baseModel || run?.model || '').trim();
    return (!expectedProfileId || runProfileId === expectedProfileId)
      || (!!expectedModel && runBaseModel === expectedModel)
      || (!!expectedModel && String(run?.model || '').trim() === expectedModel);
  });
  const passRuns = relevantRuns.filter((run) => benchmarkRunPassed(run));
  const latestPassingRun = [...passRuns].sort((left, right) => String(right?.completedAt || '').localeCompare(String(left?.completedAt || '')))[0] || null;
  const status = passRuns.length > 0
    ? 'verified'
    : relevantRuns.length > 0
      ? 'next'
      : 'locked';
  const summary = status === 'verified'
    ? `${String(pack.label || taskMode).trim()} local benchmark pack is passing on ${expectedModel || 'the configured route'}.`
    : status === 'next'
      ? `${String(pack.label || taskMode).trim()} has local benchmark history, but the latest local pack is not yet passing.`
      : `${String(pack.label || taskMode).trim()} still needs a passing local benchmark pack.`;
  return {
    taskMode,
    laneId,
    label: String(pack.label || taskMode).trim(),
    status,
    provider: expectedProvider,
    model: expectedModel,
    profileId: expectedProfileId,
    runCount: relevantRuns.length,
    passCount: passRuns.length,
    latestCompletedAt: String(latestPassingRun?.completedAt || '').trim(),
    summary,
  };
}

function buildLocalRouteCoverage(capabilityLanes = [], availableModels = [], packs = []) {
  const lanes = Array.isArray(capabilityLanes) ? capabilityLanes : [];
  const expectedPacks = Array.isArray(packs) && packs.length > 0
    ? packs
    : lanes
      .filter((lane) => isLocalProvider(String(lane?.providerSource || lane?.provider || '').trim().toLowerCase()))
      .map((lane) => ({
        laneId: String(lane?.id || '').trim(),
        taskMode: String(lane?.routeTaskMode || '').trim().toLowerCase(),
        label: String(lane?.label || lane?.id || 'Local route').trim(),
      }));
  const readyOllamaModels = new Set(
    (Array.isArray(availableModels) ? availableModels : [])
      .filter((item) => String(item?.provider || '').trim().toLowerCase() === 'ollama' && item?.ready === true)
      .map((item) => String(item?.model || '').trim())
      .filter(Boolean),
  );
  const registeredOllamaModels = new Set(
    (Array.isArray(availableModels) ? availableModels : [])
      .filter((item) => (
        String(item?.provider || '').trim().toLowerCase() === 'ollama'
        && ((String(item?.source || '').trim().toLowerCase() === 'ollama' && item?.ready !== true)
          || String(item?.source || '').trim().toLowerCase() === 'ollama-store'
          || String(item?.note || '').trim().toLowerCase() === 'registered in ollama')
      ))
      .map((item) => String(item?.model || '').trim())
      .filter(Boolean),
  );
  const entries = expectedPacks.map((pack) => {
    const lane = lanes.find((item) => String(item?.id || '').trim().toLowerCase() === String(pack?.laneId || '').trim().toLowerCase()) || null;
    const configuredProvider = String(lane?.providerSource || lane?.provider || '').trim().toLowerCase();
    const model = String(lane?.preferredModel || '').trim();
    const provider = inferProviderForModel(model, configuredProvider || 'ollama');
    const local = isLocalProvider(provider);
    const liveReady = local && !!model && readyOllamaModels.has(model);
    return {
      laneId: String(pack?.laneId || lane?.id || '').trim(),
      taskMode: String(pack?.taskMode || lane?.routeTaskMode || '').trim().toLowerCase(),
      label: String(pack?.label || lane?.label || lane?.id || 'Local route').trim(),
      provider,
      model,
      local,
      liveReady,
    };
  });
  const routeLocal = entries.length > 0 && entries.every((entry) => entry.local === true);
  const requiredModels = Array.from(new Set(entries.filter((entry) => entry.local && entry.model).map((entry) => entry.model)));
  const missingLiveModels = Array.from(new Set(entries.filter((entry) => entry.local && entry.model && entry.liveReady !== true).map((entry) => entry.model)));
  const registeredButNotLiveModels = missingLiveModels.filter((model) => registeredOllamaModels.has(model));
  const status = entries.length === 0
    ? 'locked'
    : routeLocal && missingLiveModels.length === 0
      ? 'verified'
      : routeLocal || missingLiveModels.length > 0
        ? 'next'
        : 'locked';
  const summary = status === 'verified'
    ? 'The routed local coding tags are live in Ollama for every required lane.'
    : status === 'next'
      ? `Local routing exists, but ${missingLiveModels.length > 0 ? (() => {
        if (registeredButNotLiveModels.length === missingLiveModels.length) {
          return `${registeredButNotLiveModels.join(', ')} ${registeredButNotLiveModels.length === 1 ? 'is' : 'are'} registered in Ollama and not live in the running service yet`;
        }
        if (registeredButNotLiveModels.length > 0) {
          const otherMissingModels = missingLiveModels.filter((model) => !registeredOllamaModels.has(model));
          return `${registeredButNotLiveModels.join(', ')} ${registeredButNotLiveModels.length === 1 ? 'is' : 'are'} registered in Ollama and not live in the running service yet, and ${otherMissingModels.join(', ')} ${otherMissingModels.length === 1 ? 'still needs' : 'still need'} live local tags`;
        }
        return `${missingLiveModels.join(', ')} ${missingLiveModels.length === 1 ? 'is' : 'are'} not live in Ollama yet`;
      })() : 'some required lanes still need live local tags'}.`
      : 'The required planner, coder, and validator routes are not yet pinned to local tags.';
  const nextAction = missingLiveModels.length > 0
    ? `Import or activate the missing live Ollama tag${missingLiveModels.length === 1 ? '' : 's'}: ${missingLiveModels.join(', ')}.`
    : 'Keep planner, coder, and validator pinned to local routes before widening the coding block.';
  return {
    status,
    summary,
    nextAction,
    routeLocal,
    requiredModels,
    missingLiveModels,
    readyModels: requiredModels.filter((model) => readyOllamaModels.has(model)),
    entries,
  };
}

function buildLocalCodingBlockProof(options = {}) {
  const capabilityLanes = Array.isArray(options.capabilityLanes) ? options.capabilityLanes : [];
  const availableModels = Array.isArray(options.availableModels) ? options.availableModels : [];
  const benchmarkRuns = Array.isArray(options.benchmarkRuns) ? options.benchmarkRuns : [];
  const acceptance = options.acceptance && typeof options.acceptance === 'object' ? options.acceptance : {};
  const acceptanceControl = acceptance?.controlSummary && typeof acceptance.controlSummary === 'object'
    ? acceptance.controlSummary
    : {};
  const acceptanceStatus = String(
    acceptanceControl.acceptanceStatus
    || acceptance?.report?.overallStatus
    || acceptance?.overallStatus
    || ''
  ).trim().toLowerCase();
  const routeCoverage = buildLocalRouteCoverage(capabilityLanes, availableModels, LOCAL_FIRST_BLOCK_PACKS);
  const routeLocal = routeCoverage.routeLocal === true;
  const benchmarkPacks = LOCAL_FIRST_BLOCK_PACKS.map((pack) => buildLocalBenchmarkPack(pack, capabilityLanes, benchmarkRuns));
  const verifiedTaskModes = benchmarkPacks.filter((pack) => pack.status === 'verified').map((pack) => pack.taskMode);
  const missingTaskModes = benchmarkPacks.filter((pack) => pack.status !== 'verified').map((pack) => pack.taskMode);
  const benchmarkStatus = missingTaskModes.length === 0
    ? 'verified'
    : verifiedTaskModes.length > 0 || benchmarkPacks.some((pack) => pack.runCount > 0)
      ? 'next'
      : 'locked';
  const acceptanceGateStatus = acceptanceControl.safeForNextDay === true
    ? 'verified'
    : (acceptance?.exists === true || !!acceptanceStatus)
      ? 'next'
      : 'locked';
  const status = routeCoverage.status === 'verified' && benchmarkStatus === 'verified' && acceptanceGateStatus === 'verified'
    ? 'verified'
    : routeCoverage.status !== 'locked' && (benchmarkStatus !== 'locked' || acceptanceGateStatus !== 'locked')
      ? 'next'
      : 'locked';
  const summary = status === 'verified'
    ? 'Planner, coder, and validator all have passing local benchmark packs and a safe acceptance baseline.'
    : status === 'next'
      ? `${routeCoverage.status !== 'verified' ? `${routeCoverage.summary} ` : ''}Local proof is still incomplete${missingTaskModes.length ? ` for ${missingTaskModes.join(', ')}` : ''}.`.trim()
      : 'The local coding block still needs route, benchmark, and acceptance proof before widening.';
  const nextAction = routeCoverage.status !== 'verified'
    ? routeCoverage.nextAction
    : benchmarkStatus !== 'verified'
    ? `Record passing local benchmark packs for ${missingTaskModes.join(', ')} before widening the coding block.`
    : acceptanceGateStatus !== 'verified'
      ? String(acceptanceControl.nextSafeAction || acceptanceControl.nextDaySummary || 'Run acceptance with smoke coverage before widening the local coding block.')
      : 'Keep the current local coding block bounded and reuse the verified route bundle.';
  return {
    status,
    summary,
    nextAction,
    canWidenAutonomy: status === 'verified',
    routeLocal,
    route: routeCoverage,
    benchmark: {
      status: benchmarkStatus,
      verifiedTaskModes,
      missingTaskModes,
      packs: benchmarkPacks,
      summary: benchmarkStatus === 'verified'
        ? 'Planner, coder, and validator all have passing local benchmark packs.'
        : benchmarkStatus === 'next'
          ? `Local benchmark coverage exists, but ${missingTaskModes.join(', ')} still need a passing pack.`
          : 'No passing local benchmark packs are recorded yet for the planner/coder/validator block.',
    },
    acceptance: {
      status: acceptanceGateStatus,
      acceptanceStatus,
      safeForNextDay: acceptanceControl.safeForNextDay === true,
      summary: acceptanceGateStatus === 'verified'
        ? 'Acceptance and smoke are safe enough to use as the local coding gate.'
        : String(acceptanceControl.nextDaySummary || acceptanceControl.acceptanceSummary || 'Acceptance proof is not ready yet.'),
      nextAction: String(acceptanceControl.nextSafeAction || acceptanceControl.nextDaySummary || '').trim(),
    },
  };
}

function clipProofText(value, maxLength = 180) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}...` : text;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeProofTags(values = []) {
  return Array.isArray(values)
    ? Array.from(new Set(values.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)))
    : [];
}

function inferProofModelFamily(baseModel = '', fallbackFamily = '') {
  const fallback = String(fallbackFamily || '').trim().toLowerCase();
  if (fallback) {
    return fallback;
  }
  const normalized = String(baseModel || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }
  if (normalized.startsWith('deepseek')) {
    return 'deepseek-coder';
  }
  if (normalized.startsWith('qwen3')) {
    return 'qwen3';
  }
  if (normalized.startsWith('qwen')) {
    return 'qwen';
  }
  if (normalized.startsWith('phi')) {
    return 'phi';
  }
  if (normalized.startsWith('starcoder')) {
    return 'starcoder';
  }
  const family = normalized.split(/[:/]/)[0];
  return family || normalized;
}

function collectProofFailureModes(runs = []) {
  const counts = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    const label = clipProofText(
      run?.summary
      || run?.validationResult?.summary
      || run?.validationResult?.label
      || run?.status
      || 'failed run',
      120,
    );
    if (!label) {
      continue;
    }
    counts.set(label, Number(counts.get(label) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([label, count]) => ({ label, count }));
}

function findLocalPolicyModelEntry(baseModel = '', localModelPolicy = {}) {
  const normalized = String(baseModel || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return [
    ...toArray(localModelPolicy?.approvedDefaults),
    ...toArray(localModelPolicy?.candidateOnlyModels),
    ...toArray(localModelPolicy?.largerHeadroomModels),
  ].find((entry) => {
    const model = String(entry?.ollamaModel || entry?.baseModel || entry?.id || '').trim().toLowerCase();
    return model === normalized;
  }) || null;
}

function buildLocalModelHeadroom(baseModel = '', localModelPolicy = {}) {
  const policyEntry = findLocalPolicyModelEntry(baseModel, localModelPolicy);
  const target = localModelPolicy?.guardrails?.target && typeof localModelPolicy.guardrails.target === 'object'
    ? localModelPolicy.guardrails.target
    : {};
  const bundleBudgetGb = Number(target.effectiveBundleBudgetGb || 0);
  const requiredRamGb = Number(
    policyEntry?.requirements?.recommendedSystemRamGb
    || policyEntry?.requirements?.minimumSystemRamGb
    || 0,
  );
  if (!policyEntry || !bundleBudgetGb || !requiredRamGb) {
    return {
      status: 'unknown',
      capabilityState: 'missing',
      capabilityLabel: 'MISSING',
      requiredRamGb,
      bundleBudgetGb,
      marginGb: null,
      summary: 'Headroom is not recorded yet for this model.',
      shortSummary: 'headroom unknown',
    };
  }
  const marginGb = Number((bundleBudgetGb - requiredRamGb).toFixed(1));
  const capability = buildCapabilityDescriptor({
    proven: marginGb >= 0 && String(policyEntry.policyState || '').trim().toLowerCase() === 'approved-default',
    blocked: marginGb < 0,
    partial: marginGb >= 0 && String(policyEntry.policyState || '').trim().toLowerCase() !== 'approved-default',
    exists: true,
  });
  const shortSummary = `${requiredRamGb} GB RAM vs ${bundleBudgetGb} GB budget (${marginGb >= 0 ? `${marginGb} GB headroom` : `${Math.abs(marginGb)} GB over`})`;
  return {
    status: capability.capabilityState === 'verified'
      ? 'verified'
      : capability.capabilityState === 'blocked'
        ? 'blocked'
        : 'candidate',
    ...capability,
    requiredRamGb,
    bundleBudgetGb,
    marginGb,
    policyState: String(policyEntry.policyState || '').trim().toLowerCase(),
    largerHeadroom: policyEntry.largerHeadroom === true,
    summary: `${String(policyEntry.label || baseModel).trim()} uses ${requiredRamGb} GB RAM against the ${bundleBudgetGb} GB live bundle budget, leaving ${marginGb >= 0 ? `${marginGb} GB` : `${Math.abs(marginGb)} GB over budget`}.`,
    shortSummary,
  };
}

function normalizeProofProviderSource(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return isLocalProvider(normalized) ? 'local' : normalized;
}

function matchProofRunToInventoryEntry(entry = {}, run = {}) {
  const runProvider = normalizeProofProviderSource(
    run?.providerSource || inferProviderForModel(run?.baseModel || run?.model || '', entry?.providerSource || 'ollama')
  );
  if (runProvider !== 'local') {
    return false;
  }
  const entryBenchmarkId = String(entry?.benchmarkIdentity?.id || '').trim();
  const runBenchmarkId = String(run?.benchmarkIdentity?.id || run?.id || run?.outputPath || '').trim();
  if (entryBenchmarkId && runBenchmarkId && entryBenchmarkId === runBenchmarkId) {
    return true;
  }
  const sourceBenchmarks = toArray(entry?.foundryCandidate?.sourceBenchmarks).map((value) => String(value || '').trim()).filter(Boolean);
  if (runBenchmarkId && sourceBenchmarks.includes(runBenchmarkId)) {
    return true;
  }
  const entryProfileId = String(entry?.wrappedProfileId || '').trim();
  const runProfileId = String(run?.wrappedProfileId || run?.modelProfileId || run?.profileId || '').trim();
  const entryBaseModel = String(entry?.baseModel || '').trim();
  const runBaseModel = String(run?.baseModel || run?.model || '').trim();
  if (entryProfileId && runProfileId && entryProfileId === runProfileId) {
    return !entryBaseModel || !runBaseModel || entryBaseModel === runBaseModel;
  }
  return !!entryBaseModel && !!runBaseModel && entryBaseModel === runBaseModel;
}

function resolveAcceptanceProofPack(acceptance = {}) {
  const control = acceptance?.controlSummary && typeof acceptance.controlSummary === 'object'
    ? acceptance.controlSummary
    : {};
  const report = acceptance?.report && typeof acceptance.report === 'object'
    ? acceptance.report
    : {};
  return {
    autonomyProof: control.autonomyProof && typeof control.autonomyProof === 'object'
      ? control.autonomyProof
      : (report.autonomyProof && typeof report.autonomyProof === 'object' ? report.autonomyProof : (acceptance?.autonomyProof || {})),
    builderProof: control.builderProof && typeof control.builderProof === 'object'
      ? control.builderProof
      : (report.builderProof && typeof report.builderProof === 'object' ? report.builderProof : (acceptance?.builderProof || {})),
    modelParity: control.modelParity && typeof control.modelParity === 'object'
      ? control.modelParity
      : (report.modelParity && typeof report.modelParity === 'object' ? report.modelParity : (acceptance?.modelParity || {})),
  };
}

function buildAcceptanceCapabilitySignal(capabilityId = '', proofPack = {}, entry = {}, activeWrappedProfile = null, currentWorkspaceBaseModel = '') {
  const activeProfileId = String(activeWrappedProfile?.id || '').trim();
  const currentBaseModel = String(currentWorkspaceBaseModel || '').trim();
  const entryProfileId = String(entry?.wrappedProfileId || '').trim();
  const entryBaseModel = String(entry?.baseModel || '').trim();
  const isActiveEntry = (activeProfileId && entryProfileId === activeProfileId)
    || (currentBaseModel && entryBaseModel === currentBaseModel);
  if (!isActiveEntry) {
    return { status: 'missing', summary: '' };
  }
  const parityEntries = toArray(proofPack?.modelParity?.entries);
  const parityPass = (id) => parityEntries.some((item) => String(item?.id || '').trim().toLowerCase() === id && String(item?.status || '').trim().toLowerCase() === 'pass');
  if (capabilityId === 'ask-plan') {
    if (parityPass('plan')) {
      return { status: 'verified', summary: 'Ask/plan is proven by the current model parity pack.' };
    }
  }
  if (capabilityId === 'code') {
    if (parityPass('edit')) {
      return { status: 'verified', summary: 'Coding is proven by the current model parity pack.' };
    }
  }
  if (capabilityId === 'repair') {
    if (parityPass('repair')) {
      return { status: 'verified', summary: 'Repair is proven by the current model parity pack.' };
    }
  }
  if (capabilityId === 'review-validate') {
    if (parityPass('validate') || parityPass('review')) {
      return { status: 'verified', summary: 'Review/validate is proven by the current model parity pack.' };
    }
  }
  if (capabilityId === 'scaffold-create') {
    const builderStatus = String(proofPack?.builderProof?.status || '').trim().toLowerCase();
    if (builderStatus === 'pass') {
      return { status: 'verified', summary: String(proofPack.builderProof.summary || 'Scaffold/create is proven by the current builder proof pack.').trim() };
    }
    if (builderStatus) {
      return { status: ['warn', 'partial'].includes(builderStatus) ? 'next' : 'blocked', summary: String(proofPack?.builderProof?.summary || 'Builder proof is not green yet.').trim() };
    }
  }
  if (capabilityId === 'clone-lab-autonomy') {
    const autonomyStatus = String(proofPack?.autonomyProof?.status || '').trim().toLowerCase();
    if (autonomyStatus === 'pass') {
      return { status: 'verified', summary: String(proofPack.autonomyProof.summary || 'Clone-lab autonomy is proven by the current autonomy proof pack.').trim() };
    }
    if (autonomyStatus) {
      return { status: ['warn', 'partial'].includes(autonomyStatus) ? 'next' : 'blocked', summary: String(proofPack?.autonomyProof?.summary || 'Autonomy proof is not green yet.').trim() };
    }
  }
  return { status: 'missing', summary: '' };
}

function runMatchesProofCapability(run = {}, capabilityId = '') {
  const rawTaskMode = String(run?.taskMode || run?.mode || '').trim().toLowerCase();
  const normalizedTaskMode = normalizeTaskModeId(rawTaskMode) || rawTaskMode;
  const tags = normalizeProofTags(run?.benchmarkTags);
  const searchText = [
    ...tags,
    String(run?.recipe || '').trim().toLowerCase(),
    String(run?.taskId || '').trim().toLowerCase(),
    String(run?.name || '').trim().toLowerCase(),
    String(run?.summary || '').trim().toLowerCase(),
  ].join(' ');
  if (capabilityId === 'ask-plan') {
    return normalizedTaskMode === 'planner';
  }
  if (capabilityId === 'code') {
    return normalizedTaskMode === 'coder';
  }
  if (capabilityId === 'repair') {
    return normalizedTaskMode === 'repair';
  }
  if (capabilityId === 'review-validate') {
    return normalizedTaskMode === 'validator';
  }
  if (capabilityId === 'docs-guided') {
    return rawTaskMode === 'research' || DOCS_GUIDED_PROOF_TAGS.some((tag) => searchText.includes(tag));
  }
  if (capabilityId === 'scaffold-create') {
    return SCAFFOLD_PROOF_TAGS.some((tag) => searchText.includes(tag));
  }
  if (capabilityId === 'clone-lab-autonomy') {
    return AUTONOMY_PROOF_TAGS.some((tag) => searchText.includes(tag));
  }
  return false;
}

function buildLocalModelCapabilityProof(capability = {}, entry = {}, runs = [], proofPack = {}, activeWrappedProfile = null, currentWorkspaceBaseModel = '') {
  const matchingRuns = toArray(runs).filter((run) => runMatchesProofCapability(run, capability.id));
  const passRuns = matchingRuns.filter((run) => benchmarkRunPassed(run));
  const failedRuns = matchingRuns.filter((run) => !benchmarkRunPassed(run));
  const latestPassingRun = [...passRuns].sort((left, right) => String(right?.completedAt || '').localeCompare(String(left?.completedAt || '')))[0] || null;
  const acceptanceSignal = buildAcceptanceCapabilitySignal(capability.id, proofPack, entry, activeWrappedProfile, currentWorkspaceBaseModel);
  let status = 'locked';
  let summary = `${capability.label} proof is not recorded yet.`;
  if (passRuns.length > 0 || acceptanceSignal.status === 'verified') {
    status = 'verified';
    summary = passRuns.length > 0
      ? `${capability.label} proof is recorded through benchmark evidence.`
      : acceptanceSignal.summary;
  } else if (failedRuns.length > 0 || acceptanceSignal.status === 'blocked') {
    status = 'blocked';
    summary = clipProofText(
      acceptanceSignal.summary
      || failedRuns[0]?.summary
      || failedRuns[0]?.validationResult?.summary
      || `${capability.label} proof is currently failing.`,
      140,
    );
  } else if (matchingRuns.length > 0 || acceptanceSignal.status === 'next') {
    status = 'next';
    summary = clipProofText(
      acceptanceSignal.summary
      || `${capability.label} proof has some evidence, but it is not green yet.`,
      140,
    );
  }
  const descriptor = buildCapabilityDescriptor({
    proven: status === 'verified',
    blocked: status === 'blocked',
    partial: status === 'next',
    exists: true,
  });
  return {
    id: capability.id,
    label: capability.label,
    status,
    ...descriptor,
    runCount: matchingRuns.length,
    passCount: passRuns.length,
    latestCompletedAt: String(latestPassingRun?.completedAt || '').trim() || null,
    summary,
  };
}

function buildLocalModelProofMatrix(options = {}) {
  const localModelInventory = options.localModelInventory && typeof options.localModelInventory === 'object'
    ? options.localModelInventory
    : {};
  const localModelPolicy = options.localModelPolicy && typeof options.localModelPolicy === 'object'
    ? options.localModelPolicy
    : {};
  const benchmarkRuns = toArray(options.benchmarkRuns).filter((run) => isLocalProvider(run?.providerSource || inferProviderForModel(run?.baseModel || run?.model || '', 'ollama')));
  const proofPack = resolveAcceptanceProofPack(options.acceptance || {});
  const activeWrappedProfile = options.activeWrappedProfile && typeof options.activeWrappedProfile === 'object'
    ? options.activeWrappedProfile
    : null;
  const currentWorkspaceBaseModel = String(options.currentWorkspaceBaseModel || '').trim();
  const inventoryEntries = toArray(localModelInventory.entries)
    .filter((entry) => entry && typeof entry === 'object' && isLocalProvider(entry.providerSource || ''));
  const entries = inventoryEntries.map((entry) => {
    const relevantRuns = benchmarkRuns.filter((run) => matchProofRunToInventoryEntry(entry, run));
    const passedRuns = relevantRuns.filter((run) => benchmarkRunPassed(run));
    const failedRuns = relevantRuns.filter((run) => !benchmarkRunPassed(run));
    const capabilities = LOCAL_MODEL_PROOF_CAPABILITIES.map((capability) => buildLocalModelCapabilityProof(
      capability,
      entry,
      relevantRuns,
      proofPack,
      activeWrappedProfile,
      currentWorkspaceBaseModel,
    ));
    const verifiedCapabilityCount = capabilities.filter((item) => item.status === 'verified').length;
    const blockedCapabilities = capabilities.filter((item) => item.status === 'blocked');
    const missingCapabilities = capabilities.filter((item) => item.status === 'locked').map((item) => item.label);
    const attemptedCapabilities = capabilities.filter((item) => item.status !== 'locked').length;
    const descriptor = buildCapabilityDescriptor({
      proven: verifiedCapabilityCount === LOCAL_MODEL_PROOF_CAPABILITIES.length && LOCAL_MODEL_PROOF_CAPABILITIES.length > 0,
      blocked: blockedCapabilities.length > 0 && verifiedCapabilityCount === 0,
      partial: verifiedCapabilityCount > 0 || attemptedCapabilities > 0 || relevantRuns.length > 0,
      exists: true,
    });
    const headroom = buildLocalModelHeadroom(entry.baseModel, localModelPolicy);
    const failureModes = collectProofFailureModes(failedRuns);
    const successRate = relevantRuns.length > 0 ? Math.round((passedRuns.length / relevantRuns.length) * 100) : 0;
    const status = descriptor.capabilityState === 'verified'
      ? 'verified'
      : descriptor.capabilityState === 'blocked'
        ? 'blocked'
        : descriptor.capabilityState === 'candidate'
          ? 'next'
          : 'locked';
    const summary = status === 'verified'
      ? `${String(entry.label || entry.baseModel || 'Local model').trim()} proves all ${LOCAL_MODEL_PROOF_CAPABILITIES.length} tracked engine capabilities.`
      : status === 'blocked'
        ? `${String(entry.label || entry.baseModel || 'Local model').trim()} is blocked on ${blockedCapabilities.map((item) => item.label).join(', ')}.`
        : `${String(entry.label || entry.baseModel || 'Local model').trim()} proves ${verifiedCapabilityCount}/${LOCAL_MODEL_PROOF_CAPABILITIES.length} tracked capabilities${missingCapabilities.length ? ` and still needs ${missingCapabilities.slice(0, 3).join(', ')}` : ''}.`;
    return {
      id: String(entry.id || entry.label || entry.baseModel || '').trim(),
      label: String(entry.label || entry.baseModel || 'Local model').trim(),
      kind: String(entry.kind || '').trim(),
      wrappedProfileId: String(entry.wrappedProfileId || '').trim(),
      baseModel: String(entry.baseModel || '').trim(),
      providerSource: String(entry.providerSource || '').trim().toLowerCase(),
      modelFamily: inferProofModelFamily(entry.baseModel, entry.workerFamily || entry.modelFamily),
      workerVariantType: String(entry.workerVariantType || '').trim().toLowerCase(),
      promotionReadiness: String(entry.promotionReadiness || '').trim().toLowerCase(),
      localReadiness: String(entry.localReadiness || '').trim().toLowerCase(),
      benchmarkIdentity: entry.benchmarkIdentity || null,
      foundryCandidate: entry.foundryCandidate || null,
      capabilityCount: LOCAL_MODEL_PROOF_CAPABILITIES.length,
      verifiedCapabilityCount,
      missingCapabilities,
      blockedCapabilities: blockedCapabilities.map((item) => item.label),
      status,
      ...descriptor,
      summary,
      headroom,
      metrics: {
        runCount: relevantRuns.length,
        passCount: passedRuns.length,
        successRate,
        averageLatencyMs: Math.round(mean(relevantRuns.map((run) => Number(run?.latencyMs || 0)))),
        averageRepairDepth: Number(mean(relevantRuns.map((run) => Number(run?.repairDepth || 0))).toFixed(2)),
        averageApprovalCount: Number(mean(relevantRuns.map((run) => Number(run?.approvalCount || 0))).toFixed(2)),
      },
      failureModes,
      latestCompletedAt: relevantRuns.map((run) => String(run?.completedAt || '').trim()).filter(Boolean).sort().slice(-1)[0] || null,
      capabilities,
    };
  }).sort((left, right) => {
    if (right.verifiedCapabilityCount !== left.verifiedCapabilityCount) {
      return right.verifiedCapabilityCount - left.verifiedCapabilityCount;
    }
    if (right.metrics.successRate !== left.metrics.successRate) {
      return right.metrics.successRate - left.metrics.successRate;
    }
    return left.metrics.averageLatencyMs - right.metrics.averageLatencyMs;
  });

  const familyBuckets = new Map();
  for (const entry of entries) {
    const family = String(entry.modelFamily || inferProofModelFamily(entry.baseModel)).trim().toLowerCase() || 'unknown';
    const current = familyBuckets.get(family) || {
      family,
      runCount: 0,
      passCount: 0,
      latencies: [],
      repairDepths: [],
      approvalCounts: [],
      headroomMargins: [],
      failureModes: new Map(),
      models: new Set(),
    };
    current.runCount += Number(entry.metrics.runCount || 0);
    current.passCount += Number(entry.metrics.passCount || 0);
    current.latencies.push(Number(entry.metrics.averageLatencyMs || 0));
    current.repairDepths.push(Number(entry.metrics.averageRepairDepth || 0));
    current.approvalCounts.push(Number(entry.metrics.averageApprovalCount || 0));
    current.models.add(String(entry.baseModel || '').trim());
    if (Number.isFinite(entry.headroom?.marginGb)) {
      current.headroomMargins.push(Number(entry.headroom.marginGb));
    }
    for (const failure of toArray(entry.failureModes)) {
      const label = String(failure?.label || '').trim();
      if (!label) {
        continue;
      }
      current.failureModes.set(label, Number(current.failureModes.get(label) || 0) + Number(failure?.count || 0));
    }
    familyBuckets.set(family, current);
  }

  const families = Array.from(familyBuckets.values()).map((item) => {
    const successRate = item.runCount > 0 ? Math.round((item.passCount / item.runCount) * 100) : 0;
    const sortedFailureModes = Array.from(item.failureModes.entries()).sort((left, right) => right[1] - left[1]);
    const minHeadroom = item.headroomMargins.length > 0 ? Math.min(...item.headroomMargins) : null;
    const maxHeadroom = item.headroomMargins.length > 0 ? Math.max(...item.headroomMargins) : null;
    const headroomSummary = minHeadroom === null
      ? 'headroom unknown'
      : minHeadroom === maxHeadroom
        ? `${minHeadroom} GB headroom`
        : `${minHeadroom} to ${maxHeadroom} GB headroom`;
    return {
      family: item.family,
      label: item.family,
      models: Array.from(item.models).filter(Boolean),
      runCount: item.runCount,
      passCount: item.passCount,
      successRate,
      averageLatencyMs: Math.round(mean(item.latencies)),
      averageRepairDepth: Number(mean(item.repairDepths).toFixed(2)),
      averageApprovalCount: Number(mean(item.approvalCounts).toFixed(2)),
      headroomMinGb: minHeadroom,
      headroomMaxGb: maxHeadroom,
      topFailureMode: sortedFailureModes[0]?.[0] || '',
      summary: `${successRate}% success | avg ${Math.round(mean(item.latencies))} ms | ${headroomSummary}${sortedFailureModes[0]?.[0] ? ` | failure ${sortedFailureModes[0][0]}` : ''}`,
    };
  }).sort((left, right) => {
    if (right.successRate !== left.successRate) {
      return right.successRate - left.successRate;
    }
    return left.averageLatencyMs - right.averageLatencyMs;
  });

  const activeEntry = entries.find((entry) => String(entry.wrappedProfileId || '').trim() === String(activeWrappedProfile?.id || '').trim())
    || entries.find((entry) => String(entry.baseModel || '').trim() === currentWorkspaceBaseModel)
    || entries[0]
    || null;
  const matrixDescriptor = buildCapabilityDescriptor({
    capabilityState: activeEntry?.capabilityState || (entries.length > 0 ? 'candidate' : 'missing'),
  });
  return {
    status: activeEntry?.status || 'locked',
    ...matrixDescriptor,
    entryCount: entries.length,
    familyCount: families.length,
    activeEntryId: String(activeEntry?.id || '').trim(),
    activeEntry,
    entries,
    families,
    summary: activeEntry
      ? `${activeEntry.label} proves ${activeEntry.verifiedCapabilityCount}/${activeEntry.capabilityCount} tracked capabilities${activeEntry.missingCapabilities.length ? ` and still needs ${activeEntry.missingCapabilities.slice(0, 3).join(', ')}` : ''}.`
      : 'No local proof candidates are recorded yet.',
  };
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
  const registered = Array.isArray(telemetry?.models?.registered) ? telemetry.models.registered : [];
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
      ready: option?.ready === true,
      note: String(option?.note || '').trim(),
      source: String(option?.source || '').trim() || 'ollama',
    });
  }

  for (const option of registered) {
    const model = String(option?.value || option?.label || '').trim();
    if (!model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    available.push({
      model,
      label: String(option?.label || model).trim() || model,
      provider: inferProviderForModel(model, 'ollama'),
      ready: false,
      note: 'registered in Ollama',
      source: 'ollama-store',
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
  const localPrimaryTaskMode = usesLocalPrimaryTaskMode(laneTaskMode);
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
    && !localPrimaryTaskMode
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
  const storeRegistered = matched.some((item) => item.storeRegistered === true);
  return {
    provisioningState: state,
    localReadiness: local ? (localReady ? 'live' : (storeRegistered ? 'registered' : state === 'unknown' ? 'missing' : 'staged')) : 'not-local',
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
      .filter((item) => String(item?.provider || '').trim().toLowerCase() === 'ollama' && item?.ready === true)
      .map((item) => String(item?.model || '').trim())
      .filter(Boolean),
  );
  const registeredOllamaModels = new Set(
    (Array.isArray(telemetry?.models?.registered) ? telemetry.models.registered : [])
      .map((item) => String(item?.value || '').trim())
      .filter(Boolean),
  );
  const ollamaRunning = telemetry?.ollama?.running === true || telemetry?.ollama?.reachable === true;
  const ollamaModelCount = Number(telemetry?.ollama?.modelCount || 0);

  if (providerId === 'ollama') {
    const ready = model
      ? readyOllamaModels.has(model)
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
        storeRegistered: registeredOllamaModels.has(model),
        summary: `${roleId === 'engine' ? 'Engine' : 'Workspace'} role is provisioned on Ollama${model ? ` with ${model}` : ''}.`,
      };
    }
    if (model && registeredOllamaModels.has(model)) {
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
        storeRegistered: true,
        summary: `${roleId === 'engine' ? 'Engine' : 'Workspace'} role wants ${model}, but that tag is registered in Ollama and not live in the running service yet.`,
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
        storeRegistered: false,
        summary: `${roleId === 'engine' ? 'Engine' : 'Workspace'} role wants ${model || 'an Ollama model'}, but the selected model is not live in Ollama yet.`,
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
      storeRegistered: false,
      summary: `${roleId === 'engine' ? 'Engine' : 'Workspace'} role is routed to Ollama, but no live Ollama model is available yet.`,
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
      : 'Workspace coding and engine control roles are provisioned for the current route plan.';
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
  const acceptance = options.acceptance && typeof options.acceptance === 'object' ? options.acceptance : {};
  const profileId = normalizeProfileId(settings.aiProfile);
  const benchmarkSummary = summarizeBenchmarks(benchmarkRuns);
  const rawProviders = buildProviders(settings, tuningStatus, options);
  const rawWrappedProfiles = buildWrappedProfiles(settings, benchmarkSummary, rawProviders);
  const rawWorkspaceWrappedProfileId = normalizeWrappedProfileId(settings.aiWorkspaceWrappedProfileId || settings.aiWrappedProfileId || 'gs-dev-1-default');
  const rawEngineWrappedProfileId = normalizeWrappedProfileId(settings.aiEngineWrappedProfileId || 'gse-1-engine');
  const rawWorkspaceWrappedProfile = rawWrappedProfiles.find((profile) => profile.id === rawWorkspaceWrappedProfileId)
    || rawWrappedProfiles.find((profile) => profile.activeWorkspace)
    || rawWrappedProfiles.find((profile) => profile.role === 'workspace')
    || rawWrappedProfiles[0]
    || null;
  const rawEngineWrappedProfile = rawWrappedProfiles.find((profile) => profile.id === rawEngineWrappedProfileId)
    || rawWrappedProfiles.find((profile) => profile.activeEngine)
    || rawWrappedProfiles.find((profile) => profile.role === 'engine')
    || rawWorkspaceWrappedProfile
    || null;
  const guardrailSeedSettings = {
    ...settings,
    baseModel: String(settings.baseModel || rawWorkspaceWrappedProfile?.baseModel || '').trim(),
    baseProvider: String(settings.baseProvider || rawWorkspaceWrappedProfile?.baseProvider || '').trim().toLowerCase(),
    providerSource: String(settings.providerSource || rawWorkspaceWrappedProfile?.providerSource || '').trim().toLowerCase(),
    workspaceBaseModel: String(settings.workspaceBaseModel || rawWorkspaceWrappedProfile?.baseModel || settings.baseModel || '').trim(),
    workspaceBaseProvider: String(settings.workspaceBaseProvider || rawWorkspaceWrappedProfile?.baseProvider || settings.baseProvider || '').trim().toLowerCase(),
    workspaceProviderSource: String(settings.workspaceProviderSource || rawWorkspaceWrappedProfile?.providerSource || settings.providerSource || '').trim().toLowerCase(),
    engineBaseModel: String(settings.engineBaseModel || rawEngineWrappedProfile?.baseModel || settings.workspaceBaseModel || settings.baseModel || '').trim(),
    engineBaseProvider: String(settings.engineBaseProvider || rawEngineWrappedProfile?.baseProvider || settings.workspaceBaseProvider || settings.baseProvider || '').trim().toLowerCase(),
    engineProviderSource: String(settings.engineProviderSource || rawEngineWrappedProfile?.providerSource || settings.workspaceProviderSource || settings.providerSource || '').trim().toLowerCase(),
    taskModeRoutes: {
      planner: rawEngineWrappedProfile?.taskModeRoutes?.planner || rawWorkspaceWrappedProfile?.taskModeRoutes?.planner || settings.taskModeRoutes?.planner || {},
      repair: rawWorkspaceWrappedProfile?.taskModeRoutes?.repair || rawEngineWrappedProfile?.taskModeRoutes?.repair || settings.taskModeRoutes?.repair || {},
      coder: rawWorkspaceWrappedProfile?.taskModeRoutes?.coder || rawEngineWrappedProfile?.taskModeRoutes?.coder || settings.taskModeRoutes?.coder || {},
      validator: rawEngineWrappedProfile?.taskModeRoutes?.validator || rawWorkspaceWrappedProfile?.taskModeRoutes?.validator || settings.taskModeRoutes?.validator || {},
      summarizer: rawEngineWrappedProfile?.taskModeRoutes?.summarizer || rawWorkspaceWrappedProfile?.taskModeRoutes?.summarizer || settings.taskModeRoutes?.summarizer || {},
    },
  };
  const effectiveSettings = applyLocalModelGuardrailsToConfig(guardrailSeedSettings, {
    settings: guardrailSeedSettings,
  });
  const providers = buildProviders(effectiveSettings, tuningStatus, options);
  const wrappedProfiles = buildWrappedProfiles(effectiveSettings, benchmarkSummary, providers);
  const workspaceWrappedProfileId = normalizeWrappedProfileId(effectiveSettings.aiWorkspaceWrappedProfileId || effectiveSettings.aiWrappedProfileId || 'gs-dev-1-default');
  const engineWrappedProfileId = normalizeWrappedProfileId(effectiveSettings.aiEngineWrappedProfileId || 'gse-1-engine');
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
  const availableModels = buildAvailableModels(effectiveSettings, tuningStatus);
  const modelCatalog = buildModelCatalog(effectiveSettings, tuningStatus, availableModels);
  const remoteProviderPreset = resolveRemoteProviderPreset(effectiveSettings);
  const remoteModelCatalog = buildRemoteModelCatalog(effectiveSettings);
  const currentProvider = resolveCurrentProvider(String(effectiveSettings.runtime || 'ollama').trim().toLowerCase() || 'ollama', providers, effectiveSettings);
  const currentModel = ['ollama', 'local'].includes(currentProvider)
    ? String(effectiveSettings.trainingOllamaModel || effectiveSettings.model || '').trim()
    : String(effectiveSettings.aiRemoteModel || effectiveSettings.model || remoteProviderPreset.models?.[0]?.id || '').trim();
  const derivedModelLabel = ['ollama', 'local'].includes(currentProvider)
    ? (availableModels.find((item) => item.model === currentModel)?.label || currentModel)
    : (remoteModelCatalog.find((item) => item.model === currentModel)?.label || currentModel);
  const baseProvisioning = buildModelProvisioningStatus({
    settings: effectiveSettings,
    providers,
    availableModels,
    telemetry,
    currentProvider,
    currentModel,
    workspaceProfile: workspaceWrappedProfile,
    engineProfile: engineWrappedProfile,
  });
  const capabilityLanes = buildLaneAssignments(effectiveSettings, benchmarkSummary, providers, tuningStatus, wrappedProfiles);
  const routeCoverage = buildLocalRouteCoverage(capabilityLanes, availableModels);
  const provisioning = routeCoverage.status !== 'verified' && routeCoverage.missingLiveModels.length > 0 && baseProvisioning.status !== 'fail'
    ? {
      ...baseProvisioning,
      status: 'warn',
      state: 'warn',
      summary: routeCoverage.summary,
      recommendedAction: routeCoverage.nextAction,
      warnings: [...(Array.isArray(baseProvisioning.warnings) ? baseProvisioning.warnings : []), routeCoverage.summary],
      routeCoverage,
    }
    : {
      ...baseProvisioning,
      routeCoverage,
    };
  const modelRoles = buildExplicitModelRoles(capabilityLanes, wrappedProfiles, provisioning);
  const localCodingProof = buildLocalCodingBlockProof({
    capabilityLanes,
    availableModels,
    benchmarkRuns,
    acceptance,
  });
  const engineModelProof = buildEngineModelProofViewModel(buildEngineModelProofSnapshot({
    workspaceRoot,
    acceptanceState: acceptance,
    assistantConfig: effectiveSettings,
  }));
  const localModelPolicy = buildLocalModelPolicySnapshot({
    baseModel: String(rawWorkspaceWrappedProfile?.baseModel || settings.baseModel || '').trim(),
    baseProvider: String(rawWorkspaceWrappedProfile?.baseProvider || settings.baseProvider || '').trim().toLowerCase(),
    providerSource: String(rawWorkspaceWrappedProfile?.providerSource || settings.providerSource || '').trim().toLowerCase(),
    workspaceBaseModel: String(rawWorkspaceWrappedProfile?.baseModel || settings.workspaceBaseModel || settings.baseModel || '').trim(),
    workspaceBaseProvider: String(rawWorkspaceWrappedProfile?.baseProvider || settings.workspaceBaseProvider || settings.baseProvider || '').trim().toLowerCase(),
    workspaceProviderSource: String(rawWorkspaceWrappedProfile?.providerSource || settings.workspaceProviderSource || settings.providerSource || '').trim().toLowerCase(),
    engineBaseModel: String(rawEngineWrappedProfile?.baseModel || settings.engineBaseModel || settings.workspaceBaseModel || settings.baseModel || '').trim(),
    engineBaseProvider: String(rawEngineWrappedProfile?.baseProvider || settings.engineBaseProvider || settings.workspaceBaseProvider || settings.baseProvider || '').trim().toLowerCase(),
    engineProviderSource: String(rawEngineWrappedProfile?.providerSource || settings.engineProviderSource || settings.workspaceProviderSource || settings.providerSource || '').trim().toLowerCase(),
    taskModeRoutes: {
      planner: rawEngineWrappedProfile?.taskModeRoutes?.planner || rawWorkspaceWrappedProfile?.taskModeRoutes?.planner || settings.taskModeRoutes?.planner || {},
      repair: rawWorkspaceWrappedProfile?.taskModeRoutes?.repair || rawEngineWrappedProfile?.taskModeRoutes?.repair || settings.taskModeRoutes?.repair || {},
      coder: rawWorkspaceWrappedProfile?.taskModeRoutes?.coder || rawEngineWrappedProfile?.taskModeRoutes?.coder || settings.taskModeRoutes?.coder || {},
      validator: rawEngineWrappedProfile?.taskModeRoutes?.validator || rawWorkspaceWrappedProfile?.taskModeRoutes?.validator || settings.taskModeRoutes?.validator || {},
      summarizer: rawEngineWrappedProfile?.taskModeRoutes?.summarizer || rawWorkspaceWrappedProfile?.taskModeRoutes?.summarizer || settings.taskModeRoutes?.summarizer || {},
    },
  });
  const baseLocalModelInventory = buildLocalModelInventory({
    workspaceRoot,
    settings: effectiveSettings,
    telemetry,
    wrappedProfiles,
    foundryStatus: options.modelFoundry,
    benchmarkSummary,
    policySnapshot: localModelPolicy,
  });
  const localModelInventory = {
    ...baseLocalModelInventory,
    policySnapshot: localModelPolicy,
    routeCoverage,
  };
  const localModelProofMatrix = buildLocalModelProofMatrix({
    localModelInventory,
    localModelPolicy,
    benchmarkRuns,
    acceptance,
    activeWrappedProfile,
    currentWorkspaceBaseModel: String(workspaceWrappedProfile?.baseModel || effectiveSettings.workspaceBaseModel || '').trim(),
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
    localCodingProof,
    engineModelProof,
    localModelInventory,
    localModelPolicy,
    localModelProofMatrix,
    providers,
    benchmarkSummary,
    wrappedProfiles,
    taskModes: GS_DEV1_TASK_MODES,
    current: {
      workspaceRoot,
      runtime: String(effectiveSettings.runtime || 'ollama').trim().toLowerCase() || 'ollama',
      provider: currentProvider,
      modelLabel: String(effectiveSettings.model || '').trim(),
      derivedModelLabel,
      ollamaModel: String(effectiveSettings.trainingOllamaModel || '').trim() || 'qwen2.5-coder:7b',
      remoteProvider: remoteProviderPreset.id,
      remoteBaseUrl: String(remoteProviderPreset.baseUrl || '').trim(),
      remoteModel: String(effectiveSettings.aiRemoteModel || remoteProviderPreset.models?.[0]?.id || '').trim(),
      remoteApiKeyName: String(remoteProviderPreset.apiKeyName || '').trim(),
      localAiCmd: String(effectiveSettings.localAiCmd || '').trim(),
      manualMode: effectiveSettings.aiManualMode === true,
      bridgeProfile: String(effectiveSettings.aiBridgeProfile || 'llama-bridge').trim().toLowerCase() || 'llama-bridge',
      laneOverrides: normalizeLaneOverrides(effectiveSettings.aiLaneOverrides),
      wrappedProfileId: activeWrappedProfile?.id || '',
      wrappedProfile: activeWrappedProfile,
      workspaceWrappedProfileId: workspaceWrappedProfile?.id || '',
      workspaceWrappedProfile,
      engineWrappedProfileId: engineWrappedProfile?.id || '',
      engineWrappedProfile,
      localModelGuardrails: effectiveSettings.localModelGuardrails || localModelPolicy.guardrails || null,
      workerFamily: String(activeLocalInventoryEntry?.workerFamily || localModelInventory.workerFamilies?.primary || '').trim(),
      workerVariantId: String(activeLocalInventoryEntry?.workerVariantId || '').trim(),
      workerVariantType: String(activeLocalInventoryEntry?.workerVariantType || '').trim(),
      promotionPolicy: String(localModelInventory.promotionPolicy || '').trim(),
      routeCoverageStatus: String(routeCoverage.status || '').trim().toLowerCase(),
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
      benchmarkReady: localCodingProof.benchmark.status === 'verified',
      benchmarkLeader: benchmarkSummary[0] || null,
      localCodingProof,
      routeCoverage,
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
