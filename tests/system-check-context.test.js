'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSystemCheckContext } = require('../core/system-check-context');

test('system check context reuses supplied overrides so terminal and system-check can share one report context', async () => {
  const workspaceRoot = 'E:\\dev\\projects\\gosenderr-desktop-agent-PC';
  const assistantConfig = { aiProfile: 'hybrid' };
  const benchmarks = { runs: [{ id: 'bench-1' }] };
  const modelFoundry = { status: 'ready' };
  const aiStatus = { summary: 'ready' };
  const tuningSettings = { telemetry: true };
  const tuningStatus = { telemetry: { status: 'ready' } };

  const context = await buildSystemCheckContext(workspaceRoot, {
    assistantConfig,
    benchmarks,
    modelFoundry,
    aiStatus,
    tuningSettings,
    tuningStatus,
  });

  assert.equal(context.assistantConfig, assistantConfig);
  assert.equal(context.benchmarks, benchmarks);
  assert.equal(context.modelFoundry, modelFoundry);
  assert.equal(context.aiStatus, aiStatus);
  assert.equal(context.tuningSettings, tuningSettings);
  assert.equal(context.tuningStatus, tuningStatus);
});
