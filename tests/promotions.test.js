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
  fs.mkdirSync(artifactsRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.local.yaml'), `assistant_artifacts_root: ${artifactsRoot}\nassistant_benchmark_root: ${benchmarkRoot}\n`, 'utf8');
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
