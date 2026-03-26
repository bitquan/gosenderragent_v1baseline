'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAutonomousActionSummary,
  buildAutonomyRescopeTask,
  buildTaskAutonomyAssessment,
  inferModelLevel,
} = require('../core/autonomous-actions');

test('inferModelLevel stays conservative for smaller local models and rewards stronger engine roles', () => {
  assert.equal(inferModelLevel({ baseModel: 'qwen2.5-coder:7b' }).level, 2);
  assert.equal(inferModelLevel({ modelProfileId: 'gs-dev-1-default', baseModel: 'qwen2.5-coder:14b' }).level, 3);
  assert.equal(inferModelLevel({ modelProfileId: 'gse-1-engine', baseModel: 'gpt-5.4' }).level, 5);
});

test('buildAutonomousActionSummary scores model fit, daily progress, and overscoped work', () => {
  const now = '2026-03-16T16:30:00.000Z';
  const summary = buildAutonomousActionSummary({
    now,
    modelRoles: {
      workspace: {
        modelProfileId: 'gs-dev-1-lite',
        modelDisplayName: 'GS-Dev-1 Lite',
        baseModel: 'qwen2.5-coder:7b',
        providerSource: 'local',
      },
      engine: {
        modelProfileId: 'gse-1-engine',
        modelDisplayName: 'GSE-1 Engine',
        baseModel: 'gpt-5.4',
        providerSource: 'openai',
      },
    },
    runtimeState: {
      runs: [
        {
          runId: 'run-1',
          action: 'orchestrate',
          task: 'Refactor the renderer routing, repair, and trust handoff.',
          taskMode: 'coder',
          modelRole: 'workspace',
          state: 'fail',
          startedAt: '2026-03-16T15:00:00.000Z',
          endedAt: '2026-03-16T15:15:00.000Z',
          operatorExecution: {
            task: 'Refactor the renderer routing, repair, and trust handoff.',
            taskMode: 'coder',
            modelRole: 'workspace',
            changedFiles: [
              { path: 'main.js', status: 'M' },
              { path: 'renderer/app.js', status: 'M' },
              { path: 'core/system-check.js', status: 'M' },
              { path: 'core/mvp-readiness.js', status: 'M' },
            ],
            reviewSummary: {
              requiresManualReview: true,
              pendingApprovalCount: 1,
              lowConfidencePatchCount: 1,
              summary: 'Needs another review pass.',
            },
            trustSummary: {
              trust_state: 'needs_review',
              summary: 'Trust still needs repair.',
            },
          },
        },
        {
          runId: 'run-2',
          action: 'orchestrate',
          task: 'Summarize the latest review blockers.',
          taskMode: 'planner',
          modelRole: 'engine',
          state: 'pass',
          startedAt: '2026-03-16T14:00:00.000Z',
          endedAt: '2026-03-16T14:02:00.000Z',
          operatorExecution: {
            task: 'Summarize the latest review blockers.',
            taskMode: 'planner',
            modelRole: 'engine',
            changedFiles: [],
            reviewSummary: {
              requiresManualReview: false,
              pendingApprovalCount: 0,
              lowConfidencePatchCount: 0,
              summary: 'No manual blockers.',
            },
            trustSummary: {
              trust_state: 'ready',
              summary: 'Trust is clear.',
            },
          },
        },
      ],
    },
  });

  assert.equal(summary.status, 'fail');
  assert.equal(summary.actionCount, 2);
  assert.equal(summary.overscopedCount, 1);
  assert.equal(summary.dailyTarget.safeCount, 1);
  assert.equal(summary.validationToday.passCount, 0);
  assert.equal(summary.validationToday.failCount, 0);
  assert.equal(summary.validationToday.reviewBlockedCount, 0);
  assert.equal(summary.highestRiskAction.runId, 'run-1');
  assert.equal(summary.highestRiskAction.capabilityFit, 'overscoped');
  assert.equal(summary.highestRiskAction.difficultyLevel, 5);
  assert.equal(summary.highestRiskAction.modelLevel, 2);
  assert.match(summary.recommendedNextSafeAction, /Rescope/i);
  assert.match(summary.summary, /overscoped/i);
});

test('buildAutonomousActionSummary respects path filters using existing changed-file metadata', () => {
  const summary = buildAutonomousActionSummary({
    filters: { path: 'renderer/app.js' },
    modelRoles: {
      workspace: {
        modelProfileId: 'gs-dev-1-default',
        modelDisplayName: 'GS-Dev-1',
        baseModel: 'qwen2.5-coder:14b',
      },
    },
    runtimeState: {
      runs: [
        {
          runId: 'run-renderer',
          action: 'implement',
          task: 'Patch renderer status cards',
          taskMode: 'coder',
          modelRole: 'workspace',
          state: 'pass',
          operatorExecution: {
            changedFiles: [{ path: 'renderer/app.js', status: 'M' }],
          },
        },
        {
          runId: 'run-core',
          action: 'implement',
          task: 'Patch system check',
          taskMode: 'coder',
          modelRole: 'workspace',
          state: 'pass',
          operatorExecution: {
            changedFiles: [{ path: 'core/system-check.js', status: 'M' }],
          },
        },
      ],
    },
  });

  assert.equal(summary.actionCount, 1);
  assert.equal(summary.latestActions[0].runId, 'run-renderer');
});

test('buildAutonomousActionSummary uses current-workspace proof actions and ignores foreign or non-daily evidence', () => {
  const workspaceRoot = 'E:/dev/projects/gosenderr-desktop-agent-PC';
  const summary = buildAutonomousActionSummary({
    now: '2026-03-17T18:30:00.000Z',
    workspaceRoot,
    targetWorkspaceRoot: workspaceRoot,
    dailyTarget: 5,
    modelRoles: {
      workspace: {
        modelProfileId: 'gs-dev-1-default',
        modelDisplayName: 'GS-Dev-1',
        baseModel: 'qwen2.5-coder:14b',
        providerSource: 'ollama',
      },
      engine: {
        modelProfileId: 'gse-1-engine',
        modelDisplayName: 'GSE-1 Engine',
        baseModel: 'gpt-5.4',
        providerSource: 'openai',
      },
    },
    runtimeState: {
      runs: [
        {
          runId: 'foreign-run',
          workspaceRoot: 'E:/dev/projects/other-repo',
          targetWorkspaceRoot: 'E:/dev/projects/other-repo',
          task: 'Repair a different repo.',
          taskMode: 'coder',
          modelRole: 'workspace',
          state: 'fail',
          operatorExecution: {
            task: 'Repair a different repo.',
            changedFiles: [{ path: 'main.js', status: 'M' }],
            reviewSummary: { requiresManualReview: true, pendingApprovalCount: 1 },
            trustSummary: { trust_state: 'needs_review' },
          },
        },
        {
          runId: 'promotion-run',
          workspaceRoot,
          targetWorkspaceRoot: workspaceRoot,
          task: 'Summarize promotion export status for the latest candidate.',
          taskMode: 'summarizer',
          modelRole: 'engine',
          state: 'pass',
          operatorExecution: {
            task: 'Summarize promotion export status for the latest candidate.',
            changedFiles: [],
            reviewSummary: { requiresManualReview: false, pendingApprovalCount: 0 },
            trustSummary: { trust_state: 'ready' },
          },
        },
      ],
    },
    proofActions: Array.from({ length: 5 }, (_, index) => ({
      runId: `proof-${index + 1}`,
      workspaceRoot,
      targetWorkspaceRoot: workspaceRoot,
      task: `Autonomy proof step ${index + 1}`,
      taskMode: 'planner',
      modelRole: 'engine',
      state: 'pass',
      startedAt: `2026-03-17T1${index}:00:00.000Z`,
      endedAt: `2026-03-17T1${index}:01:00.000Z`,
      metadata: {
        autonomyProof: true,
        workspaceScopeRoot: workspaceRoot,
        requestedModelRole: 'engine',
      },
      operatorExecution: {
        task: `Autonomy proof step ${index + 1}`,
        taskMode: 'planner',
        modelRole: 'engine',
        changedFiles: [],
        reviewSummary: {
          requiresManualReview: false,
          pendingApprovalCount: 0,
          lowConfidencePatchCount: 0,
        },
        trustSummary: {
          trust_state: 'ready',
          summary: 'Trust is clear.',
        },
      },
    })),
  });

  assert.equal(summary.workspaceScoped, true);
  assert.equal(summary.currentWorkspaceActionCount, 5);
  assert.equal(summary.currentWorkspaceSafeCount, 5);
  assert.equal(summary.currentWorkspaceOverscopedCount, 0);
  assert.equal(summary.historicalActionCount, 5);
  assert.equal(summary.actionCount, 5);
  assert.equal(summary.dailyTarget.safeCount, 5);
  assert.equal(summary.dailyTarget.met, true);
  assert.equal(summary.latestActions.every((item) => item.runId !== 'foreign-run'), true);
  assert.equal(summary.status, 'ready');
});

test('buildAutonomousActionSummary ignores runtime bootstrap failures in daily validation counts', () => {
  const workspaceRoot = 'E:/dev/projects/gosenderr-desktop-agent-PC';
  const summary = buildAutonomousActionSummary({
    now: '2026-03-26T21:00:00.000Z',
    workspaceRoot,
    targetWorkspaceRoot: workspaceRoot,
    modelRoles: {
      workspace: {
        modelProfileId: 'gs-dev-1-default',
        modelDisplayName: 'GS-Dev-1',
        baseModel: 'qwen2.5-coder:14b',
        providerSource: 'ollama',
      },
      engine: {
        modelProfileId: 'gse-1-engine',
        modelDisplayName: 'GSE-1 Engine',
        baseModel: 'gpt-5.4',
        providerSource: 'openai',
      },
    },
    runtimeState: {
      runs: [
        {
          runId: 'bootstrap-fail',
          workspaceRoot,
          targetWorkspaceRoot: workspaceRoot,
          task: 'Set up the workspace coding model, engine control model, and verify the route plan is ready.',
          taskMode: 'coder',
          modelRole: 'workspace',
          state: 'fail',
          startedAt: '2026-03-26T20:46:55.111Z',
          endedAt: '2026-03-26T20:46:55.130Z',
          stderrTail: 'Could not start the Python runtime: spawn C:\\WINDOWS\\py.exe ENOENT',
          operatorExecution: {
            task: 'Set up the workspace coding model, engine control model, and verify the route plan is ready.',
            taskMode: 'coder',
            modelRole: 'workspace',
            outputTail: {
              stderr: 'Could not start the Python runtime: spawn C:\\WINDOWS\\py.exe ENOENT',
            },
          },
        },
        {
          runId: 'validation-pass',
          workspaceRoot,
          targetWorkspaceRoot: workspaceRoot,
          task: 'Acceptance and review summary',
          taskMode: 'validator',
          modelRole: 'engine',
          state: 'pass',
          startedAt: '2026-03-26T20:41:27.017Z',
          endedAt: '2026-03-26T20:41:27.017Z',
          operatorExecution: {
            task: 'Acceptance and review summary',
            taskMode: 'validator',
            modelRole: 'engine',
            changedFiles: [],
            reviewSummary: {
              requiresManualReview: false,
              pendingApprovalCount: 0,
              lowConfidencePatchCount: 0,
            },
            trustSummary: {
              trust_state: 'ready',
              summary: 'Trust is clear.',
            },
          },
        },
      ],
    },
  });

  assert.equal(summary.actionCount, 1);
  assert.equal(summary.validationToday.passCount, 1);
  assert.equal(summary.validationToday.failCount, 0);
  assert.equal(summary.status, 'ready');
});

test('buildTaskAutonomyAssessment blocks overscoped coding tasks before launch', () => {
  const assessment = buildTaskAutonomyAssessment({
    objective: 'Run benchmark-grade promotion export with repair and trust handoff.',
    riskClass: 'high',
    capabilities: ['code-main', 'repair-fast', 'review-verify'],
    acceptanceChecks: [
      'Run acceptance.',
      'Summarize the diff.',
      'Capture promotion metadata.',
    ],
    sliceTargetPaths: [
      'main.js',
      'renderer/app.js',
      'core/system-check.js',
      'core/mvp-readiness.js',
    ],
    slices: [{ id: 'scope' }, { id: 'implement' }, { id: 'validate' }],
  }, {
    workspace: {
      modelProfileId: 'gs-dev-1-lite',
      modelDisplayName: 'GS-Dev-1 Lite',
      baseModel: 'qwen2.5-coder:7b',
      providerSource: 'local',
    },
    engine: {
      modelProfileId: 'gse-1-engine',
      modelDisplayName: 'GSE-1 Engine',
      baseModel: 'gpt-5.4',
      providerSource: 'openai',
    },
  });

  assert.equal(assessment.requestedModelRole, 'workspace');
  assert.equal(assessment.capabilityFit, 'overscoped');
  assert.equal(assessment.safeToLaunch, false);
  assert.equal(assessment.modelLevel, 2);
  assert.equal(assessment.difficultyLevel, 5);
  assert.match(assessment.recommendedAction, /Rescope/i);
});

test('buildAutonomyRescopeTask produces a bounded lab-safe follow-up payload', () => {
  const task = buildAutonomyRescopeTask({
    objective: 'Run benchmark-grade promotion export with repair and trust handoff.',
    taskMode: 'coder',
    laneId: 'code-main',
    sliceTargetPaths: [
      'main.js',
      'renderer/app.js',
      'core/system-check.js',
    ],
  }, {
    requestedModelRole: 'workspace',
    modelLevel: 2,
    blockingReason: 'Rescope this task before retrying.',
  });

  assert.equal(task.status, 'needs-rescope');
  assert.equal(task.ring, 'lab');
  assert.equal(task.sliceTargetPaths.length, 2);
  assert.equal(task.metadata.lastBlockedBy, 'model-fit');
  assert.equal(task.metadata.requestedModelRole, 'workspace');
  assert.equal(task.metadata.routeLaneId, 'code-main');
  assert.match(task.metadata.followupSignature, /^autonomy-rescope:/);
  assert.match(task.objective, /lab-safe slice/i);
  assert.equal(Array.isArray(task.slices), true);
  assert.equal(task.slices.length, 3);
});
