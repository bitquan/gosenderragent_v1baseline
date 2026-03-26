'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DesktopAgentRuntimeService,
  resolveTaskLoopLane,
  resolveExecutionModelRole,
} = require('../host/agent-runtime-service');

function createService(overrides = {}) {
  const runtime = overrides.runtime || {
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
  const createdLabs = [];
  const createdTasks = [];
  const createLab = overrides.createLab || ((workspaceRoot, payload) => {
    const result = {
      ok: true,
      workspaceRoot,
      labRoot: `E:\\labs\\${String(payload?.name || 'engine-run').trim() || 'engine-run'}`,
      recipe: String(payload?.recipe || '').trim(),
    };
    createdLabs.push(result);
    return result;
  });
  const createTask = overrides.createTask || ((_workspaceRoot, payload) => {
    const result = {
      ok: true,
      task: {
        id: `task-${createdTasks.length + 1}`,
        title: String(payload?.title || '').trim(),
        objective: String(payload?.objective || '').trim(),
        status: String(payload?.status || '').trim(),
        metadata: payload?.metadata || {},
      },
    };
    createdTasks.push(result.task);
    return result;
  });
  const service = new DesktopAgentRuntimeService({
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
        planner: { provider: 'ollama', model: 'qwen2.5-coder:7b' },
        coder: { provider: 'ollama', model: 'qwen2.5-coder:7b' },
        validator: { provider: 'ollama', model: 'qwen2.5-coder:7b' },
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
    createLab,
    createTask,
    ...(overrides.serviceOptions || {}),
  });
  return {
    service,
    runtime,
    createdLabs,
    createdTasks,
  };
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
  const { service } = createService();
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
  assert.equal(planned.request.baseProvider, 'ollama');
  assert.equal(planned.request.baseModel, 'qwen2.5-coder:7b');

  const coding = service.buildTaskLoopRequest({
    laneId: 'code-main',
    task: 'Patch the repo task with bounded edits',
  });
  assert.equal(coding.request.modelProfileId, 'gs-dev-1-default');
  assert.equal(coding.request.modelRole, 'workspace');
  assert.equal(coding.request.baseProvider, 'ollama');

  const blocked = service.startTaskLoop({
    laneId: 'ops-summary',
    task: 'Summarize the latest run',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.blockedBy, 'task-mode');
  assert.equal(blocked.taskMode, 'summarizer');
  assert.equal(blocked.laneId, 'ops-summary');
  assert.equal(blocked.request.baseProvider, 'openai');
});

test('execution model role follows the existing lane split', () => {
  assert.equal(resolveExecutionModelRole({ laneId: 'code-main', taskMode: 'coder', action: 'implement' }), 'workspace');
  assert.equal(resolveExecutionModelRole({ laneId: 'repair-fast', taskMode: 'repair', action: 'repair' }), 'workspace');
  assert.equal(resolveExecutionModelRole({ laneId: 'plan-reasoning', taskMode: 'planner', action: 'plan' }), 'engine');
  assert.equal(resolveExecutionModelRole({ laneId: 'review-verify', taskMode: 'validator', action: 'run' }), 'engine');
  assert.equal(resolveExecutionModelRole({ laneId: 'ops-summary', taskMode: 'summarizer', action: 'summarize' }), 'engine');
});

test('task-loop coding defaults to a clone lab for autonomy proof work', () => {
  const { service, runtime, createdLabs } = createService();

  const result = service.startTaskLoop({
    laneId: 'code-main',
    task: 'Patch the repo task with bounded edits',
  });

  assert.equal(result.ok, true);
  assert.equal(createdLabs.length, 1);
  assert.equal(result.autoCreatedLab, true);
  assert.equal(runtime.workspaceRoot, createdLabs[0].labRoot);
  assert.equal(result.request.labRoot, createdLabs[0].labRoot);
  assert.equal(result.request.hostBoundary.hostKind, 'lab');
});

test('overscoped autonomy work is converted into a needs-rescope follow-up task', () => {
  const { service, createdTasks } = createService();

  const result = service.startTaskLoop({
    laneId: 'code-main',
    task: 'Refactor the renderer routing, repair, trust handoff, promotion export, and release notes in one pass.',
    objective: 'Refactor the renderer routing, repair, trust handoff, promotion export, and release notes in one pass.',
    riskClass: 'high',
    capabilities: ['code-main', 'repair-fast', 'review-verify'],
    acceptanceChecks: ['Run acceptance.', 'Summarize the diff.', 'Capture promotion metadata.'],
    sliceTargetPaths: ['main.js', 'renderer/app.js', 'core/system-check.js', 'core/mvp-readiness.js'],
    slices: [{ id: 'scope' }, { id: 'implement' }, { id: 'validate' }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.blockedBy, 'model-fit');
  assert.equal(createdTasks.length, 1);
  assert.equal(createdTasks[0].status, 'needs-rescope');
  assert.equal(createdTasks[0].metadata.lastBlockedBy, 'model-fit');
  assert.match(createdTasks[0].objective, /lab-safe slice/i);
});

test('immediate empty-patch failures queue a bounded rescope follow-up', () => {
  const runtime = {
    workspaceRoot: '',
    setWorkspaceRoot(nextRoot) {
      this.workspaceRoot = nextRoot;
    },
    run() {
      return {
        ok: false,
        runId: 'run-empty-patch',
        state: 'fail',
        blockedReason: 'Provider returned an empty patch for the requested change.',
      };
    },
  };
  const { service, createdTasks } = createService({ runtime });

  const result = service.handleRun('repair', {
    workspaceRoot: 'E:\repo',
    targetWorkspaceRoot: 'E:\repo',
    metadata: {
      operator_loop: true,
      taskMode: 'repair',
      lane_id: 'repair-fast',
    },
    taskMode: 'repair',
    objective: 'Repair the current validation failure without widening scope.',
    ticket: 'AUTONOMY-BASE-002',
  });

  assert.equal(result.runId, 'run-empty-patch');
  assert.equal(result.autoRescoped, true);
  assert.equal(createdTasks.length, 1);
  assert.equal(createdTasks[0].metadata.lastBlockedBy, 'empty-patch');
});

test('repair loop reuses bounded validation commands from the latest failed run', () => {
  let capturedRequest = null;
  const runtime = {
    workspaceRoot: '',
    setWorkspaceRoot(nextRoot) {
      this.workspaceRoot = nextRoot;
    },
    getStatus() {
      return {
        latest: [
          {
            runId: 'failed-run-1',
            ticket: 'BAT-42',
            state: 'fail',
            operatorExecution: {
              validationCommands: ['npm run test:ui-shell', 'node --test tests/system-check.test.js'],
            },
          },
        ],
      };
    },
    run(request) {
      capturedRequest = request;
      return {
        ok: true,
        runId: 'run-repair-1',
        state: 'running',
      };
    },
  };
  const { service } = createService({ runtime });

  const result = service.runRepairLoop({ workspaceRoot: 'E:\\repo' });

  assert.equal(result.ok, true);
  assert.equal(result.ticket, 'BAT-42');
  assert.deepEqual(capturedRequest.validationCommands, ['npm run test:ui-shell', 'node --test tests/system-check.test.js']);
});
