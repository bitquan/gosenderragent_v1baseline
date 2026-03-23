'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSafetyStatus, applySafetyModeToRequest } = require('../core/safety-controller');

test('safety controller enters safe mode for live app self-targeting without a lab', () => {
  const result = buildSafetyStatus({
    workspaceRoot: '/app',
    targetWorkspaceRoot: '/app',
    labRoot: '',
    appRoot: '/app',
    baseline: { state: 'green', blocked: false },
    backups: ['backup-1'],
  });

  assert.equal(result.active, true);
  assert.equal(result.restrictToLabs, true);
  assert.equal(result.blockAutonomy, true);
  assert.equal(result.rollbackAvailable, true);
  assert.match(String(result.summary || ''), /lab clone|live desktop repo/i);
});

test('safety controller forces approval gating while safe mode is active', () => {
  const applied = applySafetyModeToRequest('plan', {
    autoApproveLowRisk: true,
    humanApprovalProtectedOnly: true,
  }, {
    active: true,
    summary: 'Safe mode active.',
  });

  assert.equal(applied.blocked, false);
  assert.equal(applied.request.autoApproveLowRisk, false);
  assert.equal(applied.request.approvalGated, true);
  assert.equal(applied.request.humanApprovalProtectedOnly, false);
});

test('safety controller pauses training and promotions when baseline self-heal is active', () => {
  const result = buildSafetyStatus({
    workspaceRoot: '/workspace',
    targetWorkspaceRoot: '/workspace',
    labRoot: '',
    appRoot: '/app',
    baseline: { state: 'red', blocked: true, reason: 'Baseline unstable.' },
    backups: [],
  });

  assert.equal(result.active, true);
  assert.equal(result.blockTraining, true);
  assert.equal(result.blockBenchmarks, true);
  assert.equal(result.blockPromotions, true);

  const applied = applySafetyModeToRequest('train', {}, result);
  assert.equal(applied.blocked, true);
  assert.match(String(applied.message || ''), /baseline|safe/i);
});

test('manual safe mode becomes a hard stop and reports paused systems', () => {
  const result = buildSafetyStatus({
    workspaceRoot: '/workspace',
    targetWorkspaceRoot: '/workspace',
    labRoot: '',
    appRoot: '/app',
    baseline: { state: 'green', blocked: false },
    assistantConfig: { safeMode: true },
    schedulerRunning: true,
    backups: ['backup-1'],
  });

  assert.equal(result.active, true);
  assert.equal(result.blockAutonomy, true);
  assert.equal(result.blockTraining, true);
  assert.equal(result.blockBenchmarks, true);
  assert.equal(result.blockPromotions, true);
  assert.deepEqual(result.pausedSystems, ['autonomy', 'scheduler', 'training', 'benchmarks', 'promotions']);
  assert.equal(result.controller.manualSafeMode, true);
});

test('infrastructure failures do not force self-work safe mode', () => {
  const result = buildSafetyStatus({
    workspaceRoot: '/workspace',
    targetWorkspaceRoot: '/workspace',
    labRoot: '',
    appRoot: '/app',
    baseline: { state: 'green', blocked: false },
    latestRuntime: {
      state: 'fail',
      label: 'Task: Repair the latest failed validation path and rerun the relevant checks',
      stderrTail: 'Could not start the Python runtime: spawn C:\\WINDOWS\\py.exe ENOENT',
    },
    backups: [],
  });

  assert.equal(result.active, false);
  assert.equal(result.blockAutonomy, false);
  assert.equal(result.blockPromotions, false);
});
