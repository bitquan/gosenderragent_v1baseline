'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildModelInstallPresets,
  buildLocalModelInventory,
  buildTrainingModelSelectorOptions,
  buildTrainingTrustSummary,
  collectTrainingTelemetry,
  discoverConfiguredOllamaModels,
  discoverStoredModels,
  normalizeTrainingTuningSettings,
  resolveExistingModelStorageRoot,
  resolveOllamaHomeRoot,
  TRAINING_TELEMETRY_STALE_MS,
  TRAINING_TRUST_REASON_CODES,
} = require('../core/training-tuning');

test('buildTrainingTrustSummary reports ready when resource guardrails are healthy', () => {
  const now = Date.now();
  const summary = buildTrainingTrustSummary({
    lastUpdatedAt: new Date(now - 5_000).toISOString(),
    nowMs: now,
    settings: {
      trainingProfile: 'medium',
      trainingAutoStartOllama: true,
    },
    cpuUsagePercent: 21,
    memory: { usedPercent: 48 },
    thermal: { state: 'nominal' },
    runtime: {
      activeRuns: 0,
      schedulerRunning: false,
      cpuLimitPercent: 55,
      thermalCeilingC: 80,
      threadLimit: 4,
    },
    ollama: {
      running: true,
      selectedModel: 'qwen2.5-coder:7b',
      selectedModelReady: true,
    },
    models: { storageReachable: true },
  });

  assert.equal(summary.status, 'ready');
  assert.equal(summary.trustState, 'ready');
  assert.equal(summary.pauseSuggested, false);
  assert.equal(summary.telemetryFresh, true);
  assert.equal(typeof summary.telemetryAgeMs, 'number');
  assert.equal(summary.primaryReason, null);
  assert.equal(summary.recommendedNextStep, 'Proceed with a targeted learn or self-improve run.');
  assert.match(summary.summary, /inside the current resource guardrails/i);
});

test('buildTrainingTrustSummary marks stale telemetry as caution when freshness is the main issue', () => {
  const now = Date.now();
  const summary = buildTrainingTrustSummary({
    lastUpdatedAt: new Date(now - (TRAINING_TELEMETRY_STALE_MS + 5_000)).toISOString(),
    nowMs: now,
    settings: {
      trainingProfile: 'medium',
      trainingAutoStartOllama: true,
    },
    cpuUsagePercent: 18,
    memory: { usedPercent: 42 },
    thermal: { state: 'nominal' },
    runtime: {
      activeRuns: 0,
      schedulerRunning: false,
      cpuLimitPercent: 55,
      thermalCeilingC: 80,
      threadLimit: 4,
    },
    ollama: {
      running: true,
      selectedModel: 'qwen2.5-coder:7b',
      selectedModelReady: true,
    },
    models: { storageReachable: true },
  });

  assert.equal(summary.status, 'caution');
  assert.equal(summary.trustState, 'caution');
  assert.equal(summary.telemetryFresh, false);
  assert.ok(Number(summary.telemetryAgeMs) > TRAINING_TELEMETRY_STALE_MS);
  assert.equal(summary.primaryReason, TRAINING_TRUST_REASON_CODES.TELEMETRY_STALE);
  assert.ok(summary.reasonCodes.includes(TRAINING_TRUST_REASON_CODES.TELEMETRY_STALE));
  assert.match(summary.recommendedNextStep, /refresh tuning telemetry|reconnect the host/i);
});

test('buildTrainingTrustSummary escalates to pause on thermal pressure', () => {
  const now = Date.now();
  const summary = buildTrainingTrustSummary({
    lastUpdatedAt: new Date(now - 2_000).toISOString(),
    nowMs: now,
    settings: {
      trainingProfile: 'medium',
      trainingPauseOnThermal: true,
    },
    cpuUsagePercent: 35,
    memory: { usedPercent: 54 },
    thermal: { state: 'heavy' },
    runtime: {
      activeRuns: 0,
      schedulerRunning: false,
      cpuLimitPercent: 55,
      thermalCeilingC: 80,
      threadLimit: 4,
    },
    ollama: {
      running: true,
      selectedModel: 'qwen2.5-coder:7b',
      selectedModelReady: true,
    },
    models: { storageReachable: true },
  });

  assert.equal(summary.status, 'pause');
  assert.equal(summary.trustState, 'pauseSuggested');
  assert.equal(summary.pauseSuggested, true);
  assert.equal(summary.primaryReason, TRAINING_TRUST_REASON_CODES.THERMAL_PRESSURE);
  assert.ok(summary.reasonCodes.includes(TRAINING_TRUST_REASON_CODES.THERMAL_PRESSURE));
  assert.match(summary.recommendedNextStep, /cool down|quieter adaptive profile/i);
  assert.equal(summary.recoverable, true);
  assert.equal(summary.fallbackPlan?.recommendedProfile, 'low');
  assert.match(String(summary.fallbackPlan?.summary || ''), /quiet profile|smaller supervised slice/i);
});

test('buildTrainingTrustSummary keeps multiple normalized reasons with one deterministic primary reason', () => {
  const now = Date.now();
  const summary = buildTrainingTrustSummary({
    lastUpdatedAt: new Date(now - 2_000).toISOString(),
    nowMs: now,
    settings: {
      trainingProfile: 'medium',
      trainingAutoStartOllama: false,
      trainingOllamaModel: 'custom-model:latest',
    },
    cpuUsagePercent: 25,
    memory: { usedPercent: 62 },
    thermal: { state: 'nominal' },
    runtime: {
      activeRuns: 1,
      schedulerRunning: true,
      cpuLimitPercent: 55,
      thermalCeilingC: 80,
      threadLimit: 4,
    },
    ollama: {
      running: false,
      selectedModel: 'custom-model:latest',
      selectedModelReady: false,
    },
    models: { storageReachable: false },
  });

  assert.equal(summary.status, 'caution');
  assert.equal(summary.trustState, 'caution');
  assert.equal(summary.primaryReason, TRAINING_TRUST_REASON_CODES.ACTIVE_RUN_IN_PROGRESS);
  assert.deepEqual(summary.reasonCodes.slice(0, 4), [
    TRAINING_TRUST_REASON_CODES.ACTIVE_RUN_IN_PROGRESS,
    TRAINING_TRUST_REASON_CODES.SCHEDULER_ACTIVE,
    TRAINING_TRUST_REASON_CODES.OLLAMA_NOT_RUNNING,
    TRAINING_TRUST_REASON_CODES.SELECTED_MODEL_NOT_READY,
  ]);
  assert.ok(summary.reasonCodes.includes(TRAINING_TRUST_REASON_CODES.PROVIDER_UNAVAILABLE));
  assert.match(summary.recommendedNextStep, /targeted checks|scheduler cycle/i);
});

test('collectTrainingTelemetry surfaces selected model readiness and caution summary', async () => {
  const telemetry = await collectTrainingTelemetry({
    settings: {
      trainingProfile: 'medium',
      trainingAutoStartOllama: false,
      trainingOllamaModel: 'custom-model:latest',
      trainingModelStorageRoot: '/path/that/does/not/exist',
    },
    activeRuns: 1,
    schedulerRunning: true,
  });

  assert.equal(telemetry.ollama.selectedModel, 'custom-model:latest');
  assert.equal(telemetry.ollama.selectedModelReady, false);
  assert.equal(telemetry.lastUpdatedAt, telemetry.sampledAt);
  assert.equal(telemetry.trustSummary.telemetryFresh, true);
  assert.equal(telemetry.trustSummary.status === 'caution' || telemetry.trustSummary.status === 'pause', true);
  assert.equal(['caution', 'pauseSuggested'].includes(telemetry.trustSummary.trustState), true);
  assert.ok(Array.isArray(telemetry.trustSummary.reasonCodes));
  assert.ok(
    telemetry.trustSummary.reasonCodes.includes(TRAINING_TRUST_REASON_CODES.ACTIVE_RUN_IN_PROGRESS)
    || telemetry.trustSummary.reasonCodes.includes(TRAINING_TRUST_REASON_CODES.OLLAMA_NOT_RUNNING)
  );
  assert.equal(typeof telemetry.trustSummary.primaryReason === 'string' || telemetry.trustSummary.primaryReason === null, true);
  assert.equal(typeof telemetry.trustSummary.recommendedNextStep === 'string' || telemetry.trustSummary.recommendedNextStep === null, true);
  assert.ok(telemetry.trustSummary.fallbackPlan);
  assert.equal(telemetry.trustSummary.fallbackPlan.ecoMode, true);
});

test('buildLocalModelInventory connects wrapped profiles and foundry candidates through one readiness path', () => {
  const inventory = buildLocalModelInventory({
    settings: {
      trainingOllamaModel: 'qwen2.5-coder:14b',
    },
    telemetry: {
      trustSummary: {
        status: 'ready',
        summary: 'Local tuning is healthy.',
      },
      models: {
        storageRoot: 'E:\\models',
        storageReachable: true,
        registeredRoot: 'E:\\ollama-home\\models',
        registeredReachable: true,
        registered: [
          { value: 'qwen2.5-coder:14b', source: 'ollama-store', ready: true },
        ],
        discovered: [
          {
            fileName: 'Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf',
            source: 'storage',
            importTag: 'qwen2.5-coder:14b',
            ollamaModel: 'qwen2.5-coder:14b',
          },
        ],
        availableOptions: [
          { value: 'qwen2.5-coder:14b', label: 'Qwen2.5 Coder 14B', source: 'ollama', ready: true },
        ],
      },
    },
    wrappedProfiles: [
      {
        id: 'gse-1-engine',
        displayName: 'GSE-1 Engine',
        role: 'engine',
        family: 'gse-1',
        baseModel: 'qwen2.5-coder:14b',
        providerSource: 'ollama',
      },
      {
        id: 'gs-dev-1-default',
        displayName: 'GS-Dev-1 Workspace',
        role: 'workspace',
        family: 'gs-dev-1',
        baseModel: 'qwen2.5-coder:14b',
        providerSource: 'ollama',
      },
    ],
    foundryStatus: {
      candidates: [
        {
          id: 'candidate-local-qwen',
          title: 'Local qwen bundle',
          modelProfileId: 'gs-dev-1-default',
          baseModel: 'qwen2.5-coder:14b',
          providerSource: 'ollama',
          sourceBenchmarks: ['bench-local-qwen'],
          safetyLevel: 'candidate',
        },
      ],
    },
    benchmarkSummary: [
      {
        id: 'bench-local-qwen',
        modelProfileId: 'gs-dev-1-default',
        baseModel: 'qwen2.5-coder:14b',
        providerSource: 'ollama',
        taskMode: 'coder',
        passRate: 100,
        status: 'pass',
      },
    ],
  });

  assert.equal(inventory.status, 'ready');
  assert.equal(inventory.localCount, 3);
  assert.equal(inventory.candidateCount, 1);
  const engineEntry = inventory.entries.find((entry) => entry.wrappedProfileId === 'gse-1-engine');
  const workspaceEntry = inventory.entries.find((entry) => entry.wrappedProfileId === 'gs-dev-1-default' && entry.kind === 'wrapped-profile');
  const candidateEntry = inventory.entries.find((entry) => entry.kind === 'foundry-candidate');
  assert.equal(engineEntry.localReadiness, 'ready');
  assert.equal(workspaceEntry.installState, 'installed');
  assert.equal(workspaceEntry.foundryCandidate.id, 'candidate-local-qwen');
  assert.equal(workspaceEntry.benchmarkIdentity.id, 'bench-local-qwen');
  assert.equal(candidateEntry.localReadiness, 'ready');
});

test('normalizeTrainingTuningSettings applies the Windows hardware target preset', () => {
  const settings = normalizeTrainingTuningSettings({
    trainingHardwareTarget: 'windows-i9-32gb-rtx4060-8gb',
  });

  assert.equal(settings.trainingHardwareTarget, 'windows-i9-32gb-rtx4060-8gb');
  assert.equal(settings.trainingProfile, 'high');
  assert.equal(settings.trainingOllamaModel, 'qwen2.5-coder:14b');
  assert.equal(settings.hardwareTargetPreset.label.includes('RTX 4060'), true);
});

test('buildModelInstallPresets includes curated Hugging Face metadata and download commands', () => {
  const presets = buildModelInstallPresets('/Users/papadev/dev/gosenderr-desktop-agent', {
    trainingHardwareTarget: 'windows-i9-32gb-rtx4060-8gb',
  });

  const qwen14b = presets.find((item) => item.id === 'qwen-coder-14b-q4km');
  assert.ok(qwen14b);
  assert.equal(qwen14b.sourcePortal, 'huggingface');
  assert.match(String(qwen14b.sourceUrl || ''), /huggingface\.co\/Qwen\/Qwen2\.5-Coder-14B-Instruct-GGUF/i);
  assert.equal(qwen14b.hardwareRecommended, true);
  assert.match(String(qwen14b.downloadCommand || ''), /ollama pull/i);
});

test('discoverConfiguredOllamaModels reads registered manifests from the configured Ollama store', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-ollama-store-'));
  const modelsRoot = path.join(tempRoot, 'models');
  const manifestsRoot = path.join(tempRoot, 'ollama-home', 'models', 'manifests', 'registry.ollama.ai', 'library');
  try {
    fs.mkdirSync(path.join(manifestsRoot, 'qwen2.5-coder'), { recursive: true });
    fs.mkdirSync(path.join(manifestsRoot, 'gosenderr-qwen-local'), { recursive: true });
    fs.writeFileSync(path.join(manifestsRoot, 'qwen2.5-coder', '14b'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(manifestsRoot, 'gosenderr-qwen-local', 'latest'), '{}\n', 'utf8');

    const discovered = discoverConfiguredOllamaModels({
      trainingModelStorageRoot: modelsRoot,
    });

    assert.equal(discovered.exists, true);
    assert.deepEqual(discovered.models.map((item) => item.value), [
      'gosenderr-qwen-local:latest',
      'qwen2.5-coder:14b',
    ]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildTrainingModelSelectorOptions merges configured Ollama manifests with stored GGUF files', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-ollama-selector-'));
  const modelsRoot = path.join(tempRoot, 'models');
  const manifestsRoot = path.join(tempRoot, 'ollama-home', 'models', 'manifests', 'registry.ollama.ai', 'library');
  try {
    fs.mkdirSync(modelsRoot, { recursive: true });
    fs.mkdirSync(path.join(manifestsRoot, 'qwen2.5-coder'), { recursive: true });
    fs.writeFileSync(path.join(modelsRoot, 'DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf'), 'gguf', 'utf8');
    fs.writeFileSync(path.join(manifestsRoot, 'qwen2.5-coder', '14b'), '{}\n', 'utf8');

    const selector = buildTrainingModelSelectorOptions({
      trainingModelStorageRoot: modelsRoot,
      trainingOllamaModel: 'qwen2.5-coder:14b',
    }, []);

    assert.ok(selector.options.some((item) => item.value === 'qwen2.5-coder:14b' && item.ready === true));
    assert.ok(selector.options.some((item) => item.value === 'deepseek-coder-v2-lite-instruct:q4-k-m' && item.ready === false));
    assert.equal(selector.registered[0].value, 'qwen2.5-coder:14b');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('discoverStoredModels falls back to sibling ollama-home models when configured shared folder is stale', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-ollama-storage-fallback-'));
  const staleModelsRoot = path.join(tempRoot, 'models');
  const siblingOllamaModelsRoot = path.join(tempRoot, 'ollama-home', 'models');
  try {
    fs.mkdirSync(siblingOllamaModelsRoot, { recursive: true });
    fs.writeFileSync(path.join(siblingOllamaModelsRoot, 'Qwen3-14B-Q4_K_M.gguf'), 'gguf', 'utf8');

    const discovered = discoverStoredModels({
      trainingModelStorageRoot: staleModelsRoot,
    });

    assert.equal(discovered.exists, true);
    assert.equal(discovered.storageRoot, siblingOllamaModelsRoot);
    assert.equal(discovered.models.length, 1);
    assert.equal(discovered.models[0].fileName, 'Qwen3-14B-Q4_K_M.gguf');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('resolveExistingModelStorageRoot and resolveOllamaHomeRoot support models stored inside ollama-home', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-ollama-home-storage-'));
  const siblingOllamaModelsRoot = path.join(tempRoot, 'ollama-home', 'models');
  try {
    fs.mkdirSync(siblingOllamaModelsRoot, { recursive: true });
    fs.writeFileSync(path.join(siblingOllamaModelsRoot, 'tiny-aya-global-q4_0.gguf'), 'gguf', 'utf8');

    const resolvedStorageRoot = resolveExistingModelStorageRoot(path.join(tempRoot, 'models'));
    const resolvedOllamaHome = resolveOllamaHomeRoot({
      trainingModelStorageRoot: resolvedStorageRoot,
    });

    assert.equal(resolvedStorageRoot, siblingOllamaModelsRoot);
    assert.equal(resolvedOllamaHome, path.join(tempRoot, 'ollama-home'));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
