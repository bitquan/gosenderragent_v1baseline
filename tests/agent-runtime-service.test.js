'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DesktopAgentRuntimeService,
  resolveTaskLoopLane,
  resolveExecutionModelRole,
} = require('../host/agent-runtime-service');

function createService() {
  const runtime = {
    workspaceRoot: '',
    setWorkspaceRoot(nextRoot) {
      this.workspaceRoot = nextRoot;
    },
    run(request) {
      return {
        ok: true,
        runId: 'run-task-loop',
        state: 'running',
        request,
      };
    },
  };
  return new DesktopAgentRuntimeService({
    runtime,
    getWorkspaceRoot: () => 'E:\\repo',
    setWorkspaceRoot: (value) => value || 'E:\\repo',
    getSelectedLabRoot: () => '',
    buildEditorContext: () => ({}),
    readAssistantConfig: () => ({
      modelProfileId: 'gs-dev-1-default',
      modelDisplayName: 'Workspace Coding Model',
      baseModel: 'qwen2.5-coder:7b',
      baseProvider: 'ollama',
      providerSource: 'ollama',
      workspaceModelProfileId: 'gs-dev-1-default',
      workspaceModelDisplayName: 'Workspace Coding Model',
      workspaceBaseModel: 'qwen2.5-coder:7b',
      workspaceBaseProvider: 'ollama',
      workspaceProviderSource: 'ollama',
      engineModelProfileId: 'gse-1-engine',
      engineModelDisplayName: 'GSE-1 Engine',
      engineBaseModel: 'gpt-5.4',
      engineBaseProvider: 'openai',
      engineProviderSource: 'openai',
      taskModeRoutes: {
        planner: { provider: 'openai', model: 'gpt-5.4' },
        coder: { provider: 'ollama', model: 'qwen2.5-coder:7b' },
        validator: { provider: 'openai', model: 'gpt-5.4' },
        summarizer: { provider: 'openai', model: 'gpt-4.1-mini' },
      },
      selfImprovementOnly: false,
    }),
    getAutonomySettings: () => ({
      safetyLevel: 'balanced',
      autonomyMode: 'bounded',
      selfImprovementOnly: false,
      humanApprovalProtectedOnly: false,
    }),
    applyAutonomyToRequest: (request) => request,
    getSafetyStatus: () => ({
      ok: true,
      state: 'ready',
      active: false,
      restrictToLabs: false,
      blockAutonomy: false,
      summary: '',
    }),
  });
}

test('task loop lanes map capability lanes into existing runtime actions', () => {
  assert.deepEqual(resolveTaskLoopLane('plan-reasoning'), {
    laneId: 'plan-reasoning',
    laneLabel: 'Plan reasoning',
    taskMode: 'planner',
    action: 'plan',
  });
  assert.deepEqual(resolveTaskLoopLane('code-main'), {
    laneId: 'code-main',
    laneLabel: 'Code main',
    taskMode: 'coder',
    action: 'implement',
  });
  assert.deepEqual(resolveTaskLoopLane('repair-fast'), {
    laneId: 'repair-fast',
    laneLabel: 'Repair fast',
    taskMode: 'repair',
    action: 'repair',
  });
  assert.deepEqual(resolveTaskLoopLane('review-verify'), {
    laneId: 'review-verify',
    laneLabel: 'Review verify',
    taskMode: 'validator',
    action: 'run',
  });
  assert.deepEqual(resolveTaskLoopLane('ops-summary'), {
    laneId: 'ops-summary',
    laneLabel: 'Ops summary',
    taskMode: 'summarizer',
    action: 'summarize',
  });
});

test('buildTaskLoopRequest preserves lane metadata and keeps summarizer off the engine start path', () => {
  const service = createService();
  const planned = service.buildTaskLoopRequest({
    laneId: 'review-verify',
    task: 'Run the bounded verification checks',
  });
  assert.equal(planned.action, 'run');
  assert.equal(planned.taskMode, 'validator');
  assert.equal(planned.laneId, 'review-verify');
  assert.equal(planned.request.task, 'Run the bounded verification checks');
  assert.equal(planned.request.metadata.lane_id, 'review-verify');
  assert.equal(planned.request.metadata.task_mode, 'validator');
  assert.equal(planned.request.modelProfileId, 'gse-1-engine');
  assert.equal(planned.request.modelRole, 'engine');
  assert.equal(planned.request.modelDisplayName, 'GSE-1 Engine');

  const coding = service.buildTaskLoopRequest({
    laneId: 'code-main',
    task: 'Patch the repo task with bounded edits',
  });
  assert.equal(coding.request.modelProfileId, 'gs-dev-1-default');
  assert.equal(coding.request.modelRole, 'workspace');

  const blocked = service.startTaskLoop({
    laneId: 'ops-summary',
    task: 'Summarize the latest run',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.blockedBy, 'task-mode');
  assert.equal(blocked.taskMode, 'summarizer');
  assert.equal(blocked.laneId, 'ops-summary');
});

test('execution model role follows the existing lane split', () => {
  assert.equal(resolveExecutionModelRole({ laneId: 'code-main', taskMode: 'coder', action: 'implement' }), 'workspace');
  assert.equal(resolveExecutionModelRole({ laneId: 'repair-fast', taskMode: 'repair', action: 'repair' }), 'workspace');
  assert.equal(resolveExecutionModelRole({ laneId: 'plan-reasoning', taskMode: 'planner', action: 'plan' }), 'engine');
  assert.equal(resolveExecutionModelRole({ laneId: 'review-verify', taskMode: 'validator', action: 'run' }), 'engine');
  assert.equal(resolveExecutionModelRole({ laneId: 'ops-summary', taskMode: 'summarizer', action: 'summarize' }), 'engine');
});
