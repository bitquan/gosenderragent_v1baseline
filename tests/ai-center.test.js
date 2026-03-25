'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAiStatus, normalizeRemoteProviderSecretName, resolveRemoteProviderPreset } = require('../core/ai-center');

test('ai center summarizes profiles, providers, and benchmark leaders', () => {
  const status = buildAiStatus({
    settings: {
      runtime: 'hybrid',
      model: 'GPT-5.4 Pro',
      trainingOllamaModel: 'qwen2.5-coder:7b',
      aiProfile: 'hybrid-default',
      aiRoutingPolicy: 'hybrid-default',
      localAiCmd: 'llama_bridge',
      aiWrappedProfiles: [
        {
          id: 'gse-1-engine',
          displayName: 'GSE-1 Engine',
          role: 'engine',
          family: 'gse-1',
          baseModel: 'qwen2.5-coder:14b',
          baseProvider: 'ollama',
          providerSource: 'ollama',
        },
      ],
    },
    tuningStatus: {
      telemetry: {
        ollama: {
          running: true,
          reachable: true,
          modelCount: 3,
        },
        cpuUsagePercent: 21,
        memory: {
          usedPercent: 48,
        },
        thermal: {
          state: 'nominal',
        },
        runtime: {
          activeRuns: 1,
          schedulerRunning: false,
        },
        trustSummary: {
          status: 'ready',
        },
      },
    },
    benchmarkRuns: [
      { model: 'qwen2.5-coder:7b', ok: true, status: 'pass', latencyMs: 1200, repairDepth: 1, approvalCount: 0, completedAt: '2026-03-15T10:00:00Z' },
      { model: 'qwen2.5-coder:7b', ok: false, status: 'fail', latencyMs: 1400, repairDepth: 2, approvalCount: 1, completedAt: '2026-03-15T11:00:00Z' },
      { model: 'gpt-5.4-pro', ok: true, status: 'pass', latencyMs: 2100, repairDepth: 1, approvalCount: 0, completedAt: '2026-03-15T12:00:00Z' },
    ],
    modelFoundry: {
      candidates: [
        {
          id: 'candidate-local-gs-dev-1',
          title: 'Local GS-Dev-1 bundle',
          modelProfileId: 'gs-dev-1-default',
          baseModel: 'qwen2.5-coder:7b',
          providerSource: 'ollama',
          sourceBenchmarks: ['bench-local-gs-dev-1'],
          safetyLevel: 'candidate',
        },
      ],
    },
    secretAvailability: {
      OPENAI_API_KEY: true,
    },
  });

  assert.equal(status.ok, true);
  assert.equal(status.profileId, 'hybrid-default');
  assert.equal(status.current.runtime, 'hybrid');
  assert.equal(status.providers.some((provider) => provider.id === 'ollama' && provider.available), true);
  assert.equal(status.remoteProviders.some((provider) => provider.id === 'openai' && provider.available), true);
  assert.equal(status.capabilityLanes.length >= 6, true);
  assert.equal(status.benchmarkSummary[0].model, 'gpt-5.4-pro');
  assert.equal(Array.isArray(status.routingPolicies), true);
  assert.equal(status.availableModels.length >= 1, true);
  assert.equal(Array.isArray(status.modelCatalog), true);
  assert.equal(status.current.provider, 'ollama');
  assert.equal(status.current.wrappedProfileId, 'gs-dev-1-default');
  assert.equal(status.gsDev1.activeWrappedProfile.id, 'gs-dev-1-default');
  assert.equal(status.dualModel.workspaceProfile.id, 'gs-dev-1-default');
  assert.equal(status.dualModel.engineProfile.id, 'gse-1-engine');
  assert.equal(Array.isArray(status.modelRoles), true);
  assert.equal(status.modelRoles.length, 3);
  assert.equal(Array.isArray(status.dualModel.executionRoles), true);
  assert.equal(status.provisioning.status, 'ready');
  assert.equal(status.wrappedProfiles[0].taskModeRoutes.coder.runtimeRole, 'implementer');
  const codeLane = status.capabilityLanes.find((lane) => lane.id === 'code-main');
  const chatLane = status.capabilityLanes.find((lane) => lane.id === 'chat-fast');
  const planLane = status.capabilityLanes.find((lane) => lane.id === 'plan-reasoning');
  const reviewLane = status.capabilityLanes.find((lane) => lane.id === 'review-verify');
  const repairLane = status.capabilityLanes.find((lane) => lane.id === 'repair-fast');
  const researchLane = status.capabilityLanes.find((lane) => lane.id === 'research-docs');
  const opsLane = status.capabilityLanes.find((lane) => lane.id === 'ops-summary');
  const orchestratorRole = status.modelRoles.find((role) => role.id === 'orchestrator');
  const workerRole = status.modelRoles.find((role) => role.id === 'worker');
  const reviewerRole = status.modelRoles.find((role) => role.id === 'reviewer');
  assert.equal(codeLane.profileRole, 'workspace');
  assert.equal(repairLane.profileRole, 'workspace');
  assert.equal(planLane.profileRole, 'engine');
  assert.equal(reviewLane.profileRole, 'engine');
  assert.equal(researchLane.profileRole, 'engine');
  assert.equal(opsLane.profileRole, 'engine');
  assert.equal(planLane.provider, 'ollama');
  assert.equal(planLane.preferredModel, 'qwen2.5-coder:7b');
  assert.equal(reviewLane.provider, 'ollama');
  assert.equal(reviewLane.preferredModel, 'qwen2.5-coder:7b');
  assert.equal(chatLane.modelRoleId, 'orchestrator');
  assert.equal(codeLane.modelRoleId, 'worker');
  assert.equal(planLane.modelRoleId, 'orchestrator');
  assert.equal(reviewLane.modelRoleId, 'reviewer');
  assert.equal(orchestratorRole.wrappedProfileId, 'gse-1-engine');
  assert.equal(workerRole.wrappedProfileId, 'gs-dev-1-default');
  assert.equal(reviewerRole.wrappedProfileId, 'gse-1-engine');
  assert.deepEqual(orchestratorRole.laneIds, ['chat-fast', 'plan-reasoning', 'research-docs', 'ops-summary']);
  assert.deepEqual(workerRole.laneIds, ['code-main', 'repair-fast']);
  assert.deepEqual(reviewerRole.laneIds, ['review-verify']);
  assert.equal(workerRole.provisioningState, 'ready');
  assert.equal(reviewerRole.provisioningState, 'ready');
  assert.equal(typeof orchestratorRole.fallbackModel, 'string');
  assert.equal(status.localModelInventory.status, 'ready');
  assert.equal(Array.isArray(status.localModelInventory.entries), true);
  assert.equal(status.localModelInventory.workerFamilies.primary, 'qwen');
  assert.equal(status.localModelInventory.promotionPolicy, 'manual-promote');
  assert.equal(status.localModelInventory.entries.some((entry) => entry.wrappedProfileId === 'gs-dev-1-default'), true);
  assert.equal(status.localModelInventory.entries.some((entry) => entry.kind === 'foundry-candidate'), true);
  assert.equal(status.gsDev1.localInventoryEntry.wrappedProfileId, 'gs-dev-1-default');
  assert.equal(status.gsDev1.localInventoryEntry.foundryCandidate.id, 'candidate-local-gs-dev-1');
  assert.equal(status.current.workerFamily, 'qwen');
  assert.equal(status.current.promotionPolicy, 'manual-promote');
});

test('ai center keeps synthesized default wrapped profiles local-first when remote fallback is available', () => {
  const status = buildAiStatus({
    settings: {
      runtime: 'hybrid',
      trainingOllamaModel: 'qwen2.5-coder:7b',
      aiProfile: 'hybrid-default',
      aiRoutingPolicy: 'hybrid-default',
      aiRemoteProvider: 'openai',
      aiRemoteModel: 'gpt-5.4',
    },
    tuningStatus: {
      telemetry: {
        ollama: { running: true, reachable: true, modelCount: 1 },
        memory: { usedPercent: 34 },
        cpuUsagePercent: 14,
        thermal: { state: 'nominal' },
        runtime: { activeRuns: 0, schedulerRunning: false },
      },
    },
    benchmarkRuns: [
      { model: 'gpt-5.4', ok: true, status: 'pass', latencyMs: 1600, repairDepth: 0, approvalCount: 0, completedAt: '2026-03-15T14:00:00Z' },
    ],
    secretAvailability: {
      OPENAI_API_KEY: true,
    },
  });

  assert.equal(status.dualModel.engineProfile.baseProvider, 'ollama');
  assert.equal(status.dualModel.engineProfile.baseModel, 'qwen2.5-coder:7b');
  assert.equal(status.capabilityLanes.find((lane) => lane.id === 'plan-reasoning')?.provider, 'ollama');
  assert.equal(status.capabilityLanes.find((lane) => lane.id === 'review-verify')?.provider, 'ollama');
  assert.equal(status.capabilityLanes.find((lane) => lane.id === 'plan-reasoning')?.fallbackProvider, 'openai');
});

test('ai center marks the local coding block verified only after local planner coder and validator benchmark packs plus acceptance proof', () => {
  const status = buildAiStatus({
    settings: {
      runtime: 'ollama',
      trainingOllamaModel: 'qwen2.5-coder:14b',
      aiProfile: 'hybrid-default',
      aiRoutingPolicy: 'hybrid-default',
      aiWorkspaceWrappedProfileId: 'gs-dev-1-default',
      aiEngineWrappedProfileId: 'gse-1-engine',
      aiWrappedProfiles: [
        {
          id: 'gs-dev-1-default',
          displayName: 'GS-Dev-1 Default',
          role: 'workspace',
          baseModel: 'qwen2.5-coder:14b',
          baseProvider: 'ollama',
          providerSource: 'ollama',
        },
        {
          id: 'gse-1-engine',
          displayName: 'GSE-1 Engine',
          role: 'engine',
          baseModel: 'qwen2.5-coder:7b',
          baseProvider: 'ollama',
          providerSource: 'ollama',
        },
      ],
    },
    tuningStatus: {
      telemetry: {
        ollama: { running: true, reachable: true, modelCount: 2 },
        memory: { usedPercent: 42 },
        cpuUsagePercent: 22,
        thermal: { state: 'nominal' },
        runtime: { activeRuns: 0, schedulerRunning: false },
      },
    },
    benchmarkRuns: [
      { id: 'bench-plan', model: 'qwen2.5-coder:7b', modelProfileId: 'gse-1-engine', baseModel: 'qwen2.5-coder:7b', providerSource: 'ollama', taskMode: 'planner', status: 'pass', ok: true, completedAt: '2026-03-25T10:00:00Z' },
      { id: 'bench-code', model: 'qwen2.5-coder:14b', modelProfileId: 'gs-dev-1-default', baseModel: 'qwen2.5-coder:14b', providerSource: 'ollama', taskMode: 'coder', status: 'pass', ok: true, completedAt: '2026-03-25T10:05:00Z' },
      { id: 'bench-validate', model: 'qwen2.5-coder:7b', modelProfileId: 'gse-1-engine', baseModel: 'qwen2.5-coder:7b', providerSource: 'ollama', taskMode: 'validator', status: 'pass', ok: true, completedAt: '2026-03-25T10:10:00Z' },
    ],
    acceptance: {
      exists: true,
      report: {
        overallStatus: 'pass',
        summary: 'Acceptance passed.',
        checks: [
          { id: 'smoke', label: 'Smoke', status: 'pass', summary: 'Smoke passed.' },
          { id: 'smoke-ui', label: 'UI smoke', status: 'pass', summary: 'UI smoke passed.' },
        ],
      },
      controlSummary: {
        acceptanceStatus: 'pass',
        safeForNextDay: true,
        nextDaySummary: 'Acceptance and smoke are healthy enough for the next day\'s bounded work.',
        nextSafeAction: 'Keep the next slice bounded.',
      },
    },
  });

  assert.equal(status.localCodingProof.status, 'verified');
  assert.equal(status.localCodingProof.benchmark.status, 'verified');
  assert.deepEqual(status.localCodingProof.benchmark.verifiedTaskModes.sort(), ['coder', 'planner', 'validator']);
  assert.equal(status.localCodingProof.acceptance.status, 'verified');
  assert.equal(status.localCodingProof.canWidenAutonomy, true);
  assert.equal(status.gsDev1.benchmarkReady, true);
});

test('ai center keeps the local coding block in next state when local benchmark coverage is incomplete', () => {
  const status = buildAiStatus({
    settings: {
      runtime: 'ollama',
      trainingOllamaModel: 'qwen2.5-coder:14b',
      aiProfile: 'hybrid-default',
      aiRoutingPolicy: 'hybrid-default',
      aiWorkspaceWrappedProfileId: 'gs-dev-1-default',
      aiEngineWrappedProfileId: 'gse-1-engine',
      aiWrappedProfiles: [
        {
          id: 'gs-dev-1-default',
          displayName: 'GS-Dev-1 Default',
          role: 'workspace',
          baseModel: 'qwen2.5-coder:14b',
          baseProvider: 'ollama',
          providerSource: 'ollama',
        },
        {
          id: 'gse-1-engine',
          displayName: 'GSE-1 Engine',
          role: 'engine',
          baseModel: 'qwen2.5-coder:7b',
          baseProvider: 'ollama',
          providerSource: 'ollama',
        },
      ],
    },
    tuningStatus: {
      telemetry: {
        ollama: { running: true, reachable: true, modelCount: 2 },
        memory: { usedPercent: 42 },
        cpuUsagePercent: 22,
        thermal: { state: 'nominal' },
        runtime: { activeRuns: 0, schedulerRunning: false },
      },
    },
    benchmarkRuns: [
      { id: 'bench-plan', model: 'qwen2.5-coder:7b', modelProfileId: 'gse-1-engine', baseModel: 'qwen2.5-coder:7b', providerSource: 'ollama', taskMode: 'planner', status: 'pass', ok: true, completedAt: '2026-03-25T10:00:00Z' },
      { id: 'bench-code', model: 'qwen2.5-coder:14b', modelProfileId: 'gs-dev-1-default', baseModel: 'qwen2.5-coder:14b', providerSource: 'ollama', taskMode: 'coder', status: 'pass', ok: true, completedAt: '2026-03-25T10:05:00Z' },
    ],
    acceptance: {
      exists: true,
      report: {
        overallStatus: 'warn',
        summary: 'Acceptance has warnings.',
        checks: [
          { id: 'smoke-ui', label: 'UI smoke', status: 'pass', summary: 'UI smoke passed.' },
        ],
      },
      controlSummary: {
        acceptanceStatus: 'warn',
        safeForNextDay: false,
        nextDaySummary: 'Proceed with caution - acceptance raised warnings.',
        nextSafeAction: 'Finish the remaining gate before widening.',
      },
    },
  });

  assert.equal(status.localCodingProof.status, 'next');
  assert.equal(status.localCodingProof.benchmark.status, 'next');
  assert.deepEqual(status.localCodingProof.benchmark.missingTaskModes, ['validator']);
  assert.equal(status.localCodingProof.acceptance.status, 'next');
  assert.equal(status.localCodingProof.canWidenAutonomy, false);
});

test('ai center applies manual lane overrides without losing benchmark context', () => {
  const status = buildAiStatus({
    settings: {
      runtime: 'hybrid',
      model: 'GPT-5.4 Pro',
      trainingOllamaModel: 'qwen2.5-coder:7b',
      aiProfile: 'custom',
      aiRoutingPolicy: 'custom',
      aiLaneOverrides: {
        'plan-reasoning': { mode: 'benchmark' },
        'code-main': { mode: 'model', provider: 'ollama', model: 'qwen2.5-coder:14b' },
      },
    },
    tuningStatus: {
      telemetry: {
        ollama: {
          running: true,
          reachable: true,
          modelCount: 2,
        },
        models: {
          availableOptions: [
            { value: 'qwen2.5-coder:7b', label: 'Qwen2.5 Coder 7B', source: 'ollama', ready: true },
            { value: 'qwen2.5-coder:14b', label: 'Qwen2.5 Coder 14B', source: 'ollama', ready: true },
          ],
        },
        memory: { usedPercent: 40 },
        cpuUsagePercent: 18,
        thermal: { state: 'nominal' },
        runtime: { activeRuns: 0, schedulerRunning: false },
      },
    },
    benchmarkRuns: [
      { model: 'gpt-5.4-pro', ok: true, status: 'pass', latencyMs: 1800, repairDepth: 1, approvalCount: 0, completedAt: '2026-03-15T12:00:00Z' },
    ],
    secretAvailability: {
      OPENAI_API_KEY: true,
    },
  });

  const planLane = status.capabilityLanes.find((lane) => lane.id === 'plan-reasoning');
  const codeLane = status.capabilityLanes.find((lane) => lane.id === 'code-main');

  assert.equal(planLane.preferredModel, 'gpt-5.4-pro');
  assert.equal(planLane.source, 'override');
  assert.equal(codeLane.preferredModel, 'qwen2.5-coder:14b');
  assert.equal(codeLane.provider, 'ollama');
  assert.equal(codeLane.override.mode, 'model');
});

test('ai center exposes remote provider presets and selector-backed remote models', () => {
  const status = buildAiStatus({
    settings: {
      runtime: 'openai',
      aiRemoteProvider: 'openrouter',
      aiRemoteModel: 'openai/gpt-oss-20b',
      aiProfile: 'best-available',
      aiRoutingPolicy: 'best-available',
      trainingOllamaModel: 'qwen2.5-coder:14b',
    },
    tuningStatus: {
      telemetry: {
        ollama: {
          running: false,
          reachable: false,
          modelCount: 0,
        },
        memory: { usedPercent: 39 },
        cpuUsagePercent: 12,
        thermal: { state: 'nominal' },
        runtime: { activeRuns: 0, schedulerRunning: false },
      },
    },
    secretAvailability: {
      OPENROUTER_API_KEY: true,
    },
  });

  assert.equal(status.current.provider, 'openrouter');
  assert.equal(status.current.remoteProvider, 'openrouter');
  assert.equal(status.current.remoteModel, 'openai/gpt-oss-20b');
  assert.equal(status.remoteProviders.some((provider) => provider.id === 'openrouter' && provider.available === true), true);
  assert.equal(status.remoteModelCatalog.some((model) => model.model === 'openai/gpt-oss-20b'), true);
});

test('ai center keeps fixed-provider key slots canonical and sanitizes custom-compatible slots', () => {
  const fixedPreset = resolveRemoteProviderPreset({
    aiRemoteProvider: 'openai',
    aiRemoteApiKeyName: 'sk-proj-should-not-be-a-slot',
  });
  const customPreset = resolveRemoteProviderPreset({
    aiRemoteProvider: 'custom-compatible',
    aiRemoteApiKeyName: 'sk-proj-should-not-be-a-slot',
    aiRemoteBaseUrl: 'https://provider.example/v1',
  });
  const fixedStatus = buildAiStatus({
    settings: {
      runtime: 'openai',
      aiRemoteProvider: 'openai',
      aiRemoteApiKeyName: 'sk-proj-should-not-be-a-slot',
      aiRemoteModel: 'gpt-4o-mini',
    },
    tuningStatus: {
      telemetry: {
        ollama: { running: false, reachable: false, modelCount: 0 },
        memory: { usedPercent: 31 },
        cpuUsagePercent: 8,
        thermal: { state: 'nominal' },
        runtime: { activeRuns: 0, schedulerRunning: false },
      },
    },
    secretAvailability: {
      OPENAI_API_KEY: true,
    },
  });
  const customStatus = buildAiStatus({
    settings: {
      runtime: 'openai',
      aiRemoteProvider: 'custom-compatible',
      aiRemoteApiKeyName: 'sk-proj-should-not-be-a-slot',
      aiRemoteBaseUrl: 'https://provider.example/v1',
      aiRemoteModel: 'gpt-4o-mini',
    },
    tuningStatus: {
      telemetry: {
        ollama: { running: false, reachable: false, modelCount: 0 },
        memory: { usedPercent: 31 },
        cpuUsagePercent: 8,
        thermal: { state: 'nominal' },
        runtime: { activeRuns: 0, schedulerRunning: false },
      },
    },
    secretAvailability: {
      OPENAI_COMPAT_API_KEY: true,
    },
  });

  assert.equal(normalizeRemoteProviderSecretName('OPENAI_COMPAT_API_KEY'), 'OPENAI_COMPAT_API_KEY');
  assert.equal(normalizeRemoteProviderSecretName('sk-proj-should-not-be-a-slot'), 'OPENAI_COMPAT_API_KEY');
  assert.equal(fixedPreset.apiKeyName, 'OPENAI_API_KEY');
  assert.equal(customPreset.apiKeyName, 'OPENAI_COMPAT_API_KEY');
  assert.equal(fixedStatus.current.remoteApiKeyName, 'OPENAI_API_KEY');
  assert.equal(customStatus.current.remoteApiKeyName, 'OPENAI_COMPAT_API_KEY');
  assert.equal(fixedStatus.remoteProviders.find((provider) => provider.id === 'openai')?.secretName, 'OPENAI_API_KEY');
  assert.equal(customStatus.remoteProviders.find((provider) => provider.id === 'custom-compatible')?.secretName, 'OPENAI_COMPAT_API_KEY');
  assert.equal(customStatus.remoteProviders.find((provider) => provider.id === 'custom-compatible')?.detail.includes('sk-proj-should-not-be-a-slot'), false);
});

test('ai center keeps persisted GS-Dev-1 wrapped profiles active alongside classic profile presets', () => {
  const status = buildAiStatus({
    settings: {
      runtime: 'ollama',
      trainingOllamaModel: 'qwen2.5-coder:14b',
      aiProfile: 'custom',
      aiRoutingPolicy: 'custom',
      aiWrappedProfileId: 'gs-dev-1-review',
      aiWrappedProfiles: [
        {
          id: 'gs-dev-1-review',
          displayName: 'GS-Dev-1 Review',
          baseModel: 'qwen2.5-coder:14b',
          baseProvider: 'ollama',
          taskModeRoutes: {
            planner: { provider: 'openai', model: 'gpt-5.4-pro' },
            coder: { provider: 'ollama', model: 'qwen2.5-coder:14b' },
            validator: { provider: 'openai', model: 'gpt-5.4-pro' },
            summarizer: { provider: 'openai', model: 'gpt-4.1-mini' },
          },
          benchmarkTags: ['review-heavy'],
        },
      ],
    },
    tuningStatus: {
      telemetry: {
        ollama: { running: true, reachable: true, modelCount: 2 },
        memory: { usedPercent: 38 },
        cpuUsagePercent: 16,
        thermal: { state: 'nominal' },
        runtime: { activeRuns: 0, schedulerRunning: false },
      },
    },
    benchmarkRuns: [
      { modelProfileId: 'gs-dev-1-review', model: 'qwen2.5-coder:14b', baseModel: 'qwen2.5-coder:14b', taskMode: 'coder', providerSource: 'ollama', ok: true, status: 'pass', latencyMs: 900, repairDepth: 0, approvalCount: 0, completedAt: '2026-03-15T13:00:00Z' },
    ],
  });

  assert.equal(status.current.wrappedProfileId, 'gs-dev-1-review');
  assert.equal(status.gsDev1.activeWrappedProfile.displayName, 'GS-Dev-1 Review');
  assert.equal(status.wrappedProfiles.some((profile) => profile.id === 'gs-dev-1-review' && profile.active), true);
  assert.equal(status.benchmarkSummary[0].modelProfileId, 'gs-dev-1-review');
  assert.deepEqual(status.benchmarkSummary[0].taskModes, ['coder']);
});

test('ai center reports provisioning blockers when runtime wants Ollama without a ready model', () => {
  const status = buildAiStatus({
    settings: {
      runtime: 'ollama',
      trainingOllamaModel: 'qwen2.5-coder:14b',
      aiProfile: 'hybrid-default',
      aiRoutingPolicy: 'hybrid-default',
    },
    tuningStatus: {
      telemetry: {
        ollama: {
          running: false,
          reachable: false,
          modelCount: 0,
          selectedModel: 'qwen2.5-coder:14b',
          selectedModelReady: false,
        },
        models: {
          availableOptions: [],
        },
        memory: { usedPercent: 38 },
        cpuUsagePercent: 11,
        thermal: { state: 'nominal' },
        runtime: { activeRuns: 0, schedulerRunning: false },
      },
    },
  });

  assert.equal(status.provisioning.status, 'fail');
  assert.match(status.provisioning.summary, /Ollama/i);
  assert.match(status.provisioning.recommendedAction, /Ollama model/i);
});
