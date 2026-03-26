'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createCandidate,
  listPromotionState,
  promoteCandidate,
  rollbackPromotion,
} = require('../core/promotions');
const { recordBenchmarkRun } = require('../core/benchmarks');
const { writeAcceptanceReport } = require('../core/engine-acceptance');
const { seedModelFoundryCandidate } = require('../core/model-foundry');
const { readAssistantConfig } = require('../host/assistant-config');

function exec(command, args, cwd) {
  childProcess.execFileSync(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function makeWorkspace() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-agent-promotions-'));
  const artifactsRoot = path.join(workspaceRoot, 'artifacts');
  const benchmarkRoot = path.join(artifactsRoot, 'benchmarks');
  const promotionsRoot = path.join(artifactsRoot, 'assistant_promotions');
  fs.mkdirSync(artifactsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, 'dev_assistant.local.yaml'),
    `assistant_artifacts_root: ${artifactsRoot}\nassistant_benchmark_root: ${benchmarkRoot}\nassistant_promotions_root: ${promotionsRoot}\n`,
    'utf8',
  );
  exec('git', ['init'], workspaceRoot);
  exec('git', ['config', 'user.email', 'test@example.com'], workspaceRoot);
  exec('git', ['config', 'user.name', 'Test'], workspaceRoot);
  fs.writeFileSync(path.join(workspaceRoot, 'README.md'), '# live\n', 'utf8');
  exec('git', ['add', 'README.md', 'dev_assistant.local.yaml'], workspaceRoot);
  exec('git', ['commit', '-m', 'init'], workspaceRoot);
  return {
    workspaceRoot,
    artifactsRoot,
    benchmarkRoot,
    promotionsRoot,
  };
}

test('promotion candidate can move lab changes into live and roll them back', () => {
  const { workspaceRoot } = makeWorkspace();
  const labRoot = path.join(workspaceRoot, 'artifacts', 'assistant_labs', 'persistent', 'self-host');
  fs.mkdirSync(path.dirname(labRoot), { recursive: true });

  try {
    exec('git', ['clone', '--no-hardlinks', workspaceRoot, labRoot], workspaceRoot);
    fs.writeFileSync(
      path.join(labRoot, '.gos-lab.json'),
      `${JSON.stringify({ sourceRoot: workspaceRoot, recipe: 'self-host' }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(labRoot, 'README.md'), '# candidate change\n', 'utf8');

    const created = createCandidate(workspaceRoot, {
      labRoot,
      targetWorkspaceRoot: workspaceRoot,
      verification: { ok: true },
      name: 'self-host-candidate',
      modelProfileId: 'gs-dev-1-default',
      baseModel: 'qwen2.5-coder:14b',
      taskMode: 'coder',
    });

    recordBenchmarkRun(workspaceRoot, {
      id: 'bench-self-host-candidate',
      name: 'self-host-candidate-benchmark',
      model: 'qwen2.5-coder:14b',
      modelProfileId: 'gs-dev-1-default',
      baseModel: 'qwen2.5-coder:14b',
      providerSource: 'ollama',
      taskMode: 'coder',
      labRoot,
      targetRoot: workspaceRoot,
      status: 'pass',
      ok: true,
    });

    assert.equal(created.ok, true);
    assert.equal(created.candidate.status, 'candidate');
    assert.equal(created.candidate.modelProfileId, 'gs-dev-1-default');

    writeAcceptanceReport(workspaceRoot, {
      runId: 'acceptance-promote-pass',
      label: 'engine-acceptance',
      checks: [{ status: 'pass' }],
      training: { trustSummary: { status: 'ready' } },
    });

    const promoted = promoteCandidate(workspaceRoot, {
      candidateId: created.candidate.id,
    });

    assert.equal(promoted.ok, true);
    assert.equal(promoted.candidate.status, 'promoted');
    assert.match(fs.readFileSync(path.join(workspaceRoot, 'README.md'), 'utf8'), /candidate change/);

    const rolledBack = rollbackPromotion(workspaceRoot, {
      backupId: promoted.backup.id,
    });

    assert.equal(rolledBack.ok, true);
    assert.equal(fs.readFileSync(path.join(workspaceRoot, 'README.md'), 'utf8'), '# live\n');

    const state = listPromotionState(workspaceRoot, { labRoot });
    assert.equal(state.candidates.length >= 1, true);
    assert.equal(state.backups.length >= 1, true);
    assert.equal(state.candidates[0].baseModel, 'qwen2.5-coder:14b');
    assert.equal(state.currentCandidateIdentity.wrappedProfileId, 'gs-dev-1-default');
    assert.equal(state.currentBenchmarkIdentity.id, 'bench-self-host-candidate');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('promotion can activate and roll back a benchmark-backed local route bundle', () => {
  const { workspaceRoot } = makeWorkspace();
  const labRoot = path.join(workspaceRoot, 'artifacts', 'assistant_labs', 'persistent', 'route-bundle');
  fs.mkdirSync(path.dirname(labRoot), { recursive: true });

  try {
    fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), [
      'assistant_model_profile_id: gs-dev-1-default',
      'assistant_model_display_name: GS-Dev-1 Default',
      'assistant_model_base_model: qwen2.5-coder:7b',
      'assistant_model_base_provider: ollama',
      'assistant_model_provider_source: ollama',
      'assistant_workspace_model_profile_id: gs-dev-1-default',
      'assistant_workspace_model_display_name: GS-Dev-1 Default',
      'assistant_workspace_model_base_model: qwen2.5-coder:7b',
      'assistant_workspace_model_base_provider: ollama',
      'assistant_workspace_model_provider_source: ollama',
      'assistant_engine_model_profile_id: gse-1-engine',
      'assistant_engine_model_display_name: GSE-1 Engine',
      'assistant_engine_model_base_model: qwen2.5-coder:7b',
      'assistant_engine_model_base_provider: ollama',
      'assistant_engine_model_provider_source: ollama',
      'assistant_task_mode_planner_provider: openai',
      'assistant_task_mode_planner_model: gpt-4.1-mini',
      'assistant_task_mode_repair_provider: openai',
      'assistant_task_mode_repair_model: gpt-4.1-mini',
      'assistant_task_mode_coder_provider: openai',
      'assistant_task_mode_coder_model: gpt-4.1-mini',
      'assistant_task_mode_validator_provider: openai',
      'assistant_task_mode_validator_model: gpt-4.1-mini',
    ].join('\n') + '\n', 'utf8');

    exec('git', ['clone', '--no-hardlinks', workspaceRoot, labRoot], workspaceRoot);
    fs.writeFileSync(
      path.join(labRoot, '.gos-lab.json'),
      `${JSON.stringify({ sourceRoot: workspaceRoot, recipe: 'route-bundle' }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(labRoot, 'README.md'), '# route bundle candidate\n', 'utf8');

    recordBenchmarkRun(workspaceRoot, {
      id: 'bench-route-bundle',
      name: 'route-bundle-benchmark',
      model: 'qwen2.5-coder:14b',
      modelProfileId: 'gs-dev-1-default',
      baseModel: 'qwen2.5-coder:14b',
      providerSource: 'ollama',
      taskMode: 'coder',
      labRoot,
      targetRoot: workspaceRoot,
      status: 'pass',
      ok: true,
    });

    seedModelFoundryCandidate(workspaceRoot, {
      candidate: {
        id: 'foundry-route-bundle',
        type: 'route-bundle',
        title: 'Local qwen route bundle',
        sourceBenchmarks: ['bench-route-bundle'],
        targetLanes: ['chat-fast', 'code-main', 'repair-fast', 'review-verify'],
        modelProfileId: 'gs-dev-1-default',
        baseModel: 'qwen2.5-coder:14b',
        providerSource: 'ollama',
        taskMode: 'coder',
        rollbackSource: 'last-known-good',
      },
    });

    const created = createCandidate(workspaceRoot, {
      labRoot,
      targetWorkspaceRoot: workspaceRoot,
      verification: { ok: true },
      name: 'local-route-bundle',
      foundryCandidateId: 'foundry-route-bundle',
      modelProfileId: 'gs-dev-1-default',
      baseModel: 'qwen2.5-coder:14b',
      providerSource: 'ollama',
      taskMode: 'coder',
      variantType: 'route-bundle',
      targetLanes: ['chat-fast', 'code-main', 'repair-fast', 'review-verify'],
    });

    writeAcceptanceReport(workspaceRoot, {
      runId: 'acceptance-route-bundle-pass',
      label: 'engine-acceptance',
      checks: [{ id: 'smoke', label: 'Renderer smoke', status: 'pass' }],
      training: { trustSummary: { status: 'ready' } },
    });

    const promoted = promoteCandidate(workspaceRoot, {
      candidateId: created.candidate.id,
    });

    assert.equal(promoted.ok, true);
    assert.equal(promoted.routeActivation?.ok, true);
    assert.equal(promoted.candidate.routeBundlePromotion.status, 'promoted');

    const activeConfig = readAssistantConfig(workspaceRoot);
    assert.equal(activeConfig.taskModeRoutes.planner.provider, 'ollama');
    assert.equal(activeConfig.taskModeRoutes.planner.model, 'qwen2.5-coder:14b');
    assert.equal(activeConfig.taskModeRoutes.repair.provider, 'ollama');
    assert.equal(activeConfig.taskModeRoutes.repair.model, 'qwen2.5-coder:14b');
    assert.equal(activeConfig.taskModeRoutes.coder.provider, 'ollama');
    assert.equal(activeConfig.taskModeRoutes.coder.model, 'qwen2.5-coder:14b');
    assert.equal(activeConfig.taskModeRoutes.validator.provider, 'ollama');
    assert.equal(activeConfig.taskModeRoutes.validator.model, 'qwen2.5-coder:14b');
    assert.equal(activeConfig.workspaceBaseModel, 'qwen2.5-coder:14b');
    assert.equal(activeConfig.engineBaseModel, 'qwen2.5-coder:14b');

    const rolledBack = rollbackPromotion(workspaceRoot, {
      backupId: promoted.backup.id,
    });

    assert.equal(rolledBack.ok, true);
    const restoredConfig = readAssistantConfig(workspaceRoot);
    assert.equal(restoredConfig.taskModeRoutes.planner.provider, 'openai');
    assert.equal(restoredConfig.taskModeRoutes.planner.model, 'gpt-4.1-mini');
    assert.equal(restoredConfig.taskModeRoutes.repair.provider, 'openai');
    assert.equal(restoredConfig.taskModeRoutes.repair.model, 'gpt-4.1-mini');
    assert.equal(restoredConfig.taskModeRoutes.coder.provider, 'openai');
    assert.equal(restoredConfig.taskModeRoutes.coder.model, 'gpt-4.1-mini');
    assert.equal(restoredConfig.taskModeRoutes.validator.provider, 'openai');
    assert.equal(restoredConfig.taskModeRoutes.validator.model, 'gpt-4.1-mini');
    assert.equal(restoredConfig.workspaceBaseModel, 'qwen2.5-coder:7b');
    assert.equal(restoredConfig.engineBaseModel, 'qwen2.5-coder:7b');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('createCandidate defaults promotion target to the lab source root when no target root is supplied', () => {
  const { workspaceRoot } = makeWorkspace();
  const externalLiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-agent-live-target-'));
  const labRoot = path.join(workspaceRoot, 'artifacts', 'assistant_labs', 'scratch', 'self-host');
  fs.mkdirSync(path.dirname(labRoot), { recursive: true });

  try {
    exec('git', ['init'], externalLiveRoot);
    exec('git', ['config', 'user.email', 'test@example.com'], externalLiveRoot);
    exec('git', ['config', 'user.name', 'Test'], externalLiveRoot);
    fs.writeFileSync(path.join(externalLiveRoot, 'README.md'), '# external live\n', 'utf8');
    exec('git', ['add', 'README.md'], externalLiveRoot);
    exec('git', ['commit', '-m', 'init'], externalLiveRoot);

    exec('git', ['clone', '--no-hardlinks', externalLiveRoot, labRoot], workspaceRoot);
    fs.writeFileSync(
      path.join(labRoot, '.gos-lab.json'),
      `${JSON.stringify({ sourceRoot: externalLiveRoot, recipe: 'benchmark-self-host' }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(labRoot, 'README.md'), '# from self-host candidate\n', 'utf8');

    const created = createCandidate(workspaceRoot, {
      labRoot,
      verification: { ok: true },
      name: 'self-host-default-target',
    });

    assert.equal(created.ok, true);
    assert.equal(created.candidate.targetWorkspaceRoot, externalLiveRoot);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(externalLiveRoot, { recursive: true, force: true });
  }
});

test('promoteCandidate blocks live promotion when the latest acceptance report is missing', () => {
  const { workspaceRoot } = makeWorkspace();
  const labRoot = path.join(workspaceRoot, 'artifacts', 'assistant_labs', 'scratch', 'self-host');
  fs.mkdirSync(path.dirname(labRoot), { recursive: true });

  try {
    exec('git', ['clone', '--no-hardlinks', workspaceRoot, labRoot], workspaceRoot);
    fs.writeFileSync(
      path.join(labRoot, '.gos-lab.json'),
      `${JSON.stringify({ sourceRoot: workspaceRoot, recipe: 'self-host' }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(labRoot, 'README.md'), '# gated candidate\n', 'utf8');

    const created = createCandidate(workspaceRoot, {
      labRoot,
      verification: { ok: true },
      name: 'gated-candidate',
    });

    assert.equal(created.ok, true);
    assert.throws(() => promoteCandidate(workspaceRoot, {
      candidateId: created.candidate.id,
    }), /acceptance/i);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('promoteCandidate blocks route-bundle promotion without matching foundry proof', () => {
  const { workspaceRoot } = makeWorkspace();
  const labRoot = path.join(workspaceRoot, 'artifacts', 'assistant_labs', 'scratch', 'missing-foundry');
  fs.mkdirSync(path.dirname(labRoot), { recursive: true });

  try {
    exec('git', ['clone', '--no-hardlinks', workspaceRoot, labRoot], workspaceRoot);
    fs.writeFileSync(
      path.join(labRoot, '.gos-lab.json'),
      `${JSON.stringify({ sourceRoot: workspaceRoot, recipe: 'self-host' }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(labRoot, 'README.md'), '# missing foundry\n', 'utf8');

    recordBenchmarkRun(workspaceRoot, {
      id: 'bench-missing-foundry',
      name: 'missing-foundry-benchmark',
      model: 'qwen2.5-coder:14b',
      modelProfileId: 'gs-dev-1-default',
      baseModel: 'qwen2.5-coder:14b',
      providerSource: 'ollama',
      taskMode: 'coder',
      labRoot,
      targetRoot: workspaceRoot,
      status: 'pass',
      ok: true,
    });

    const created = createCandidate(workspaceRoot, {
      labRoot,
      verification: { ok: true },
      name: 'missing-foundry-route-bundle',
      modelProfileId: 'gs-dev-1-default',
      baseModel: 'qwen2.5-coder:14b',
      providerSource: 'ollama',
      taskMode: 'coder',
      variantType: 'route-bundle',
      targetLanes: ['code-main'],
    });

    writeAcceptanceReport(workspaceRoot, {
      runId: 'acceptance-missing-foundry-pass',
      label: 'engine-acceptance',
      checks: [{ id: 'smoke', label: 'Renderer smoke', status: 'pass' }],
      training: { trustSummary: { status: 'ready' } },
    });

    assert.equal(created.ok, true);
    assert.throws(() => promoteCandidate(workspaceRoot, {
      candidateId: created.candidate.id,
    }), /foundry/i);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('listPromotionState surfaces the first ready candidate when no lab is selected', () => {
  const { workspaceRoot } = makeWorkspace();
  const labRoot = path.join(workspaceRoot, 'artifacts', 'assistant_labs', 'persistent', 'parity-ready');
  fs.mkdirSync(path.dirname(labRoot), { recursive: true });

  try {
    exec('git', ['clone', '--no-hardlinks', workspaceRoot, labRoot], workspaceRoot);
    fs.writeFileSync(
      path.join(labRoot, '.gos-lab.json'),
      `${JSON.stringify({ sourceRoot: workspaceRoot, recipe: 'phase-2-parity' }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(path.join(labRoot, 'README.md'), '# parity ready candidate\n', 'utf8');

    const created = createCandidate(workspaceRoot, {
      labRoot,
      targetWorkspaceRoot: workspaceRoot,
      verification: { ok: true },
      name: 'parity-ready-candidate',
      modelProfileId: 'gs-dev-1-default',
      baseModel: 'qwen2.5-coder:14b',
      taskMode: 'coder',
    });

    recordBenchmarkRun(workspaceRoot, {
      id: 'bench-parity-ready',
      name: 'parity-ready-benchmark',
      model: 'qwen2.5-coder:14b',
      modelProfileId: 'gs-dev-1-default',
      baseModel: 'qwen2.5-coder:14b',
      providerSource: 'ollama',
      taskMode: 'coder',
      labRoot,
      targetRoot: workspaceRoot,
      status: 'pass',
      ok: true,
    });

    writeAcceptanceReport(workspaceRoot, {
      runId: 'acceptance-parity-ready',
      label: 'engine-acceptance',
      checks: [{ status: 'pass' }],
      training: { trustSummary: { status: 'ready' } },
    });

    const state = listPromotionState(workspaceRoot);

    assert.equal(created.ok, true);
    assert.equal(state.promotionGate.status, 'ready');
    assert.equal(state.currentCandidateId, created.candidate.id);
    assert.equal(state.currentCandidateIdentity.candidateId, created.candidate.id);
    assert.equal(state.currentBenchmarkIdentity.id, 'bench-parity-ready');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('listPromotionState filters out candidates from unrelated temp workspaces', () => {
  const { workspaceRoot, promotionsRoot } = makeWorkspace();
  fs.mkdirSync(promotionsRoot, { recursive: true });

  try {
    fs.writeFileSync(path.join(promotionsRoot, 'candidates.json'), JSON.stringify([
      {
        id: 'candidate_current_workspace',
        name: 'current-workspace-candidate',
        status: 'candidate',
        workspaceRoot,
        targetWorkspaceRoot: workspaceRoot,
        labRoot: path.join(workspaceRoot, 'artifacts', 'assistant_labs', 'persistent', 'self-host'),
        sourceRoot: workspaceRoot,
        verification: { ok: true },
      },
      {
        id: 'candidate_foreign_workspace',
        name: 'foreign-temp-candidate',
        status: 'candidate',
        workspaceRoot: 'C:\\Users\\benzo\\AppData\\Local\\Temp\\desktop-agent-promotions-foreign',
        targetWorkspaceRoot: 'C:\\Users\\benzo\\AppData\\Local\\Temp\\desktop-agent-promotions-foreign',
        labRoot: 'C:\\Users\\benzo\\AppData\\Local\\Temp\\desktop-agent-promotions-foreign\\artifacts\\assistant_labs\\persistent\\self-host',
        sourceRoot: 'C:\\Users\\benzo\\AppData\\Local\\Temp\\desktop-agent-promotions-foreign',
        verification: { ok: true },
      },
    ], null, 2), 'utf8');

    const state = listPromotionState(workspaceRoot);

    assert.equal(state.candidateCount, 1);
    assert.equal(state.candidates[0].id, 'candidate_current_workspace');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
