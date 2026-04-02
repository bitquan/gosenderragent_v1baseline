'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeLoopTaskModeId,
  normalizeRouteTaskModeId,
  resolveExecutionRoleId,
  resolveRouteTaskMode,
  resolveWrappedProfileRole,
} = require('../core/route-schema');

test('loop task mode aliases normalize to canonical loop modes', () => {
  assert.equal(normalizeLoopTaskModeId('chat'), 'chat');
  assert.equal(normalizeLoopTaskModeId('research'), 'research');
  assert.equal(normalizeLoopTaskModeId('plan'), 'planner');
  assert.equal(normalizeLoopTaskModeId('run'), 'validator');
  assert.equal(normalizeLoopTaskModeId('implementer'), 'coder');
  assert.equal(normalizeLoopTaskModeId('release'), 'summarizer');
  assert.equal(normalizeLoopTaskModeId('review'), 'validator');
});

test('route task mode aliases collapse into the routing contract', () => {
  assert.equal(normalizeRouteTaskModeId('chat'), 'planner');
  assert.equal(normalizeRouteTaskModeId('research'), 'planner');
  assert.equal(normalizeRouteTaskModeId('plan'), 'planner');
  assert.equal(normalizeRouteTaskModeId('run'), 'validator');
  assert.equal(normalizeRouteTaskModeId('review'), 'validator');
  assert.equal(normalizeRouteTaskModeId('summary'), 'summarizer');
  assert.equal(normalizeRouteTaskModeId('implementer'), 'coder');
});

test('lane, task mode, wrapped profile, and execution role resolution stays aligned', () => {
  assert.equal(resolveRouteTaskMode({ laneId: 'chat-fast', taskMode: 'coder' }), 'planner');
  assert.equal(resolveRouteTaskMode({ laneId: 'code-main', taskMode: 'validator' }), 'coder');
  assert.equal(resolveWrappedProfileRole({ taskMode: 'validator' }), 'engine');
  assert.equal(resolveWrappedProfileRole({ taskMode: 'coder' }), 'workspace');
  assert.equal(resolveExecutionRoleId({ taskMode: 'validator' }), 'reviewer');
  assert.equal(resolveExecutionRoleId({ taskMode: 'summarizer' }), 'orchestrator');
});