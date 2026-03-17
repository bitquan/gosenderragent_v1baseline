'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SELF_IMPROVEMENT_REQUIRE_TAG,
  AUTONOMY_MODE_PRESETS,
  SAFETY_LEVEL_PRESETS,
  resolveAutonomySettings,
  applyAutonomyToRequest,
  applySafetyLevelToRequest,
} = require('../core/autonomy');

test('resolveAutonomySettings uses guided preset by default', () => {
  const settings = resolveAutonomySettings();
  assert.equal(settings.autonomyMode, 'guided');
  assert.equal(settings.autoSynthesizeBats, AUTONOMY_MODE_PRESETS.guided.autoSynthesizeBats);
  assert.equal(settings.maxRetryRounds, AUTONOMY_MODE_PRESETS.guided.maxRetryRounds);
});

test('resolveAutonomySettings allows override toggles on top of mode preset', () => {
  const settings = resolveAutonomySettings({
    autonomyMode: 'full',
    autoApproveLowRisk: false,
    supervisedAutoRunRecipes: false,
    maxRetryRounds: 7,
  });
  assert.equal(settings.autonomyMode, 'full');
  assert.equal(settings.autoApproveLowRisk, false);
  assert.equal(settings.supervisedAutoRunRecipes, false);
  assert.equal(settings.maxRetryRounds, 7);
});

test('resolveAutonomySettings supports self-improvement-only preset aliases', () => {
  const settings = resolveAutonomySettings({
    autonomyMode: 'self-improve',
  });
  assert.equal(settings.autonomyMode, 'self');
  assert.equal(settings.selfImprovementOnly, true);
  assert.equal(settings.autoApproveLowRisk, AUTONOMY_MODE_PRESETS.self.autoApproveLowRisk);
});

test('resolveAutonomySettings maps guarded safety level to a stricter runtime profile', () => {
  const settings = resolveAutonomySettings({
    safetyLevel: 'guarded',
    autonomyMode: 'full',
  });

  assert.equal(settings.safetyLevel, 'guarded');
  assert.equal(settings.autonomyMode, SAFETY_LEVEL_PRESETS.guarded.autonomyMode);
  assert.equal(settings.requireLabForCodeActions, true);
  assert.ok(settings.blockedActions.includes('candidate-promote'));
});

test('applyAutonomyToRequest injects sandbox, retry, brainstorm, and followup flags', () => {
  const request = applyAutonomyToRequest({
    autonomyMode: 'full',
  }, {
    action: 'self-improve',
  });

  assert.equal(request.prepareSandbox, true);
  assert.equal(request.fixLoop, true);
  assert.equal(request.fixIterations, 4);
  assert.equal(request.continueOnFail, true);
  assert.equal(request.brainstorm, true);
  assert.equal(request.synthesizeFollowups, true);
  assert.equal(request.supervisedAutoRunRecipes, true);
});

test('applyAutonomyToRequest preserves explicit caller overrides', () => {
  const request = applyAutonomyToRequest({
    autonomyMode: 'full',
    prepareSandbox: false,
    fixIterations: 2,
    brainstorm: false,
  }, {
    action: 'implement',
  });

  assert.equal(request.prepareSandbox, false);
  assert.equal(request.fixIterations, 2);
  assert.equal(request.brainstorm, false);
});

test('applyAutonomyToRequest scopes sprint-like actions to assistant ops in self mode', () => {
  const request = applyAutonomyToRequest({
    autonomyMode: 'self',
  }, {
    action: 'autopilot',
    sprintAction: 'implement',
  });

  assert.equal(request.selfImprovementOnly, true);
  assert.equal(request.requireTag, SELF_IMPROVEMENT_REQUIRE_TAG);
  assert.equal(request.prepareSandbox, true);
});

test('applySafetyLevelToRequest blocks live coding work for guarded mode', () => {
  const safety = resolveAutonomySettings({
    safetyLevel: 'guarded',
  });

  const result = applySafetyLevelToRequest('implement', {
    workspaceRoot: '/tmp/workspace',
    targetWorkspaceRoot: '/tmp/workspace',
    labRoot: '',
  }, safety);

  assert.equal(result.blocked, true);
  assert.match(result.message, /lab/i);
  assert.equal(result.request.approvalGated, true);
});

test('applySafetyLevelToRequest blocks training in locked mode', () => {
  const safety = resolveAutonomySettings({
    safetyLevel: 'locked',
  });

  const result = applySafetyLevelToRequest('train', {
    workspaceRoot: '/tmp/workspace',
  }, safety);

  assert.equal(result.blocked, true);
  assert.match(result.message, /review|monitor|training|safety/i);
});
