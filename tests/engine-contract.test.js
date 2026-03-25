'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTerminalRoutingSummary,
  getChatModeConfig,
  inferChatModeRouting,
  parseChatModeDirective,
  resolveExecutionModelRole,
  resolveModelProfileSelection,
  resolveTaskLoopLane,
} = require('../core/engine-contract');

test('engine contract keeps human-first chat modes explicit', () => {
  assert.equal(getChatModeConfig('auto').label, 'Auto');
  assert.match(getChatModeConfig('auto').meta, /manager pick the right behavior/i);
  assert.equal(getChatModeConfig('ask').label, 'Ask');
  assert.match(getChatModeConfig('ask').meta, /Human-style help/i);
  assert.equal(getChatModeConfig('edit').requiresEditConfirmation, true);
  assert.equal(getChatModeConfig('agent').allowsExecution, true);
});

test('engine contract parses slash directives and routes modes safely', () => {
  const directive = parseChatModeDirective('/plan tighten the routing drift');
  const autoDirective = parseChatModeDirective('/auto');
  const autoRoute = inferChatModeRouting('auto', 'repair the failing validation path');
  const askRoute = inferChatModeRouting('ask', 'why is the review blocked?');
  const planRoute = inferChatModeRouting('plan', 'plan the next safe coding task');
  const editRoute = inferChatModeRouting('edit', 'repair the failing validation path');
  const agentRoute = inferChatModeRouting('agent', 'research why the docs path is failing');

  assert.equal(directive.mode, 'plan');
  assert.equal(directive.message, 'tighten the routing drift');
  assert.equal(autoDirective.mode, 'auto');
  assert.equal(autoDirective.message, '');
  assert.equal(autoRoute.effectiveChatMode, 'agent');
  assert.equal(askRoute.modeAllowsExecution, false);
  assert.equal(planRoute.suggestedLaneId, 'plan-reasoning');
  assert.equal(editRoute.suggestedLaneId, 'repair-fast');
  assert.equal(editRoute.modeRequiresEditConfirmation, true);
  assert.equal(agentRoute.suggestedLaneId, 'research-docs');
  assert.equal(agentRoute.modeAllowsExecution, true);
});

test('engine contract keeps engine and workspace roles aligned with lanes', () => {
  assert.equal(resolveExecutionModelRole({ laneId: 'plan-reasoning' }), 'engine');
  assert.equal(resolveExecutionModelRole({ laneId: 'review-verify' }), 'engine');
  assert.equal(resolveExecutionModelRole({ laneId: 'code-main' }), 'workspace');
  assert.equal(resolveExecutionModelRole({ laneId: 'repair-fast' }), 'workspace');
});

test('engine contract resolves model profile selection without inventing a second routing truth', () => {
  const selection = resolveModelProfileSelection({
    modelProfileId: 'shared-default',
    modelDisplayName: 'Shared Default',
    baseModel: 'qwen2.5-coder:14b',
    baseProvider: 'ollama',
    providerSource: 'ollama',
    workspaceModelProfileId: 'workspace-profile',
    workspaceModelDisplayName: 'Workspace Profile',
    workspaceBaseModel: 'qwen2.5-coder:14b',
    workspaceBaseProvider: 'ollama',
    workspaceProviderSource: 'ollama',
    engineModelProfileId: 'engine-profile',
    engineModelDisplayName: 'Engine Profile',
    engineBaseModel: 'gpt-4.1-mini',
    engineBaseProvider: 'openai',
    engineProviderSource: 'openai',
    taskModeRoutes: {
      planner: { provider: 'ollama', model: 'qwen2.5-coder:7b' },
      coder: { provider: 'ollama', model: 'qwen2.5-coder:14b' },
      validator: { provider: 'ollama', model: 'qwen2.5-coder:7b' },
      summarizer: { provider: 'openai', model: 'gpt-4.1-mini' },
    },
  }, {
    laneId: 'plan-reasoning',
    taskMode: 'planner',
    action: 'plan',
  });

  assert.equal(selection.modelRole, 'engine');
  assert.equal(selection.active.modelProfileId, 'engine-profile');
  assert.equal(selection.active.baseProvider, 'ollama');
  assert.equal(selection.active.baseModel, 'qwen2.5-coder:7b');
  assert.equal(selection.workspace.modelProfileId, 'workspace-profile');
});

test('buildTerminalRoutingSummary exposes one canonical mode/lane/action summary', () => {
  const summary = buildTerminalRoutingSummary({
    chatMode: 'auto',
    message: 'repair the failing validation path',
  });

  assert.equal(summary.modeLabel, 'Auto');
  assert.equal(summary.effectiveModeLabel, 'Agent');
  assert.equal(summary.suggestedLaneId, 'repair-fast');
  assert.equal(summary.action, resolveTaskLoopLane('repair-fast').action);
  assert.match(summary.modeInstruction, /Act like a strong coding teammate/i);
});
