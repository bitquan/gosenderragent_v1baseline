'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAutoFollowupPlan,
  buildFollowupRecipe,
  buildNextActionRecipe,
  buildQueuedRecipePayload,
} = require('../core/followup-recipes');

test('buildFollowupRecipe creates a docs-guided supervised loop from followups', () => {
  const recipe = buildFollowupRecipe({
    followups: [
      {
        id: 'docs-refresh-1',
        kind: 'revision',
        category: 'docs-refresh',
        title: 'Refresh trusted docs for settings',
        summary: 'Refresh the docs before the next revision.',
        candidate: {
          id: 'docs-refresh-1',
          kind: 'revision',
          category: 'docs-refresh',
          title: 'Refresh trusted docs for settings',
          objective: 'Refresh the trusted docs and compare them against the settings change.',
          summary: 'Refresh the docs before the next revision.',
          riskClass: 'low',
          targetPaths: ['src/settings.ts'],
        },
      },
      {
        id: 'revision-1',
        kind: 'revision',
        category: 'validation-repair',
        title: 'Revise src/settings.ts',
        summary: 'Apply the next repair slice.',
        candidate: {
          id: 'revision-1',
          kind: 'revision',
          category: 'validation-repair',
          title: 'Revise src/settings.ts',
          objective: 'Apply the next repair slice for the settings flow.',
          summary: 'Apply the next repair slice.',
          riskClass: 'medium',
          targetPaths: ['src/settings.ts'],
        },
      },
      {
        id: 'regression-1',
        kind: 'regression',
        category: 'coverage-gap',
        title: 'Add coverage for src/settings.ts',
        summary: 'Protect the approved behavior.',
        candidate: {
          id: 'regression-1',
          kind: 'regression',
          category: 'coverage-gap',
          title: 'Add coverage for src/settings.ts',
          objective: 'Add a regression test for the settings flow.',
          summary: 'Protect the approved behavior.',
          riskClass: 'low',
          targetPaths: ['src/settings.ts'],
        },
      },
    ],
  }, {
    reviewer: { pendingApprovalCount: 0 },
    safeMode: { active: false, controller: { manualSafeMode: false } },
  });

  assert.equal(recipe.exists, true);
  assert.equal(recipe.autoQueueEligible, true);
  assert.equal(recipe.title, 'Docs-verified repair loop');
  assert.equal(recipe.steps.length, 3);
  assert.equal(recipe.steps[0].category, 'docs-refresh');
  assert.equal(recipe.steps[2].kind, 'regression');
  assert.match(String(recipe.prompt || ''), /Refresh the trusted docs/i);
});

test('buildFollowupRecipe blocks auto queue while hard safe mode is active', () => {
  const recipe = buildFollowupRecipe({
    followups: [
      {
        id: 'docs-scout-1',
        kind: 'revision',
        category: 'docs-scout',
        candidate: {
          id: 'docs-scout-1',
          kind: 'revision',
          category: 'docs-scout',
          title: 'Scout trusted docs',
          objective: 'Capture a trusted docs source for the slice.',
          summary: 'Capture a trusted docs source.',
          riskClass: 'low',
        },
      },
    ],
  }, {
    reviewer: { pendingApprovalCount: 0 },
    safeMode: { active: true, controller: { manualSafeMode: true } },
  });

  assert.equal(recipe.exists, true);
  assert.equal(recipe.autoQueueEligible, false);
  assert.match(String(recipe.reason || ''), /safe mode/i);
});

test('buildQueuedRecipePayload materializes a task chain with followup signatures', () => {
  const payload = buildQueuedRecipePayload({
    id: 'safe-recipe:settings',
    title: 'Docs-verified repair loop',
    summary: 'Refresh docs -> revise settings -> add regression coverage',
    prompt: 'Refresh docs, revise settings, then add regression coverage.',
    steps: [
      {
        id: 'docs-refresh-1',
        kind: 'revision',
        category: 'docs-refresh',
        title: 'Refresh trusted docs',
        objective: 'Refresh the docs.',
        riskClass: 'low',
        targetPaths: ['src/settings.ts'],
      },
      {
        id: 'regression-1',
        kind: 'regression',
        category: 'coverage-gap',
        title: 'Add regression coverage',
        objective: 'Add a regression test.',
        riskClass: 'low',
        targetPaths: ['src/settings.test.ts'],
      },
    ],
  }, {
    workspaceRoot: '/workspace',
    targetWorkspaceRoot: '/workspace',
    threadId: 'thread_1',
    changeSessionId: 'session_1',
  });

  assert.equal(payload.recipe.stepCount, 2);
  assert.equal(payload.tasks.length, 2);
  assert.equal(payload.tasks[0].status, 'ready');
  assert.equal(payload.tasks[1].status, 'queued');
  assert.match(String(payload.tasks[0].metadata.followupSignature || ''), /recipe:safe-recipe:settings:docs-refresh-1/);
});

test('buildNextActionRecipe materializes a bounded recipe from the shared next-action contract', () => {
  const recipe = buildNextActionRecipe({
    task: 'Repair the renderer layout issue.',
    taskObjective: { summary: 'Repair the renderer layout issue.' },
    nextAction: {
      command: 'retry-with-research',
      label: 'Retry with research',
      summary: 'Research the renderer diff before retrying.',
      prompt: 'Research the renderer diff before retrying the layout fix.',
    },
    changedFiles: [{ path: 'renderer/app.js' }, { path: 'renderer/styles.css' }],
  });

  assert.equal(recipe.exists, true);
  assert.match(recipe.id, /safe-recipe:engine-next-action:retry-with-research/);
  assert.equal(recipe.steps.length, 1);
  assert.equal(recipe.steps[0].category, 'engine-next-action');
  assert.equal(recipe.steps[0].riskClass, 'low');
  assert.deepEqual(recipe.steps[0].targetPaths, ['renderer/app.js', 'renderer/styles.css']);
  assert.equal(recipe.steps[0].metadata.requestedModelRole, 'engine');
  assert.equal(recipe.steps[0].metadata.routeLaneId, 'research-docs');
  assert.equal(recipe.steps[0].metadata.taskMode, 'research');
  assert.equal(recipe.steps[0].metadata.autonomyDifficultyCeiling, 2);
});

test('buildNextActionRecipe carries learned phase guidance and fallback target paths', () => {
  const recipe = buildNextActionRecipe({
    task: 'Repair the renderer layout issue.',
    taskObjective: { summary: 'Repair the renderer layout issue.' },
    nextAction: {
      command: 'repair-loop',
      label: 'Repair loop',
      summary: 'Repair the renderer layout issue.',
      learned: true,
    },
    memoryHints: {
      recommendedResponse: 'repair-loop',
      recommendedPrompt: 'Repair renderer/app.js and rerun the UI shell test.',
      topRejectReason: 'Validation failed in renderer/app.js.',
      topPaths: [{ value: 'renderer/app.js', count: 2 }],
      topPhaseId: 'phase-1-safe-engine-core',
      topPhaseLabel: 'Phase 1: Safe Engine Core',
    },
  });

  assert.equal(recipe.exists, true);
  assert.deepEqual(recipe.steps[0].targetPaths, ['renderer/app.js']);
  assert.equal(recipe.steps[0].metadata.learnedFromMemory, true);
  assert.equal(recipe.steps[0].metadata.phaseId, 'phase-1-safe-engine-core');
  assert.match(String(recipe.reason || ''), /Phase 1: Safe Engine Core/i);
  assert.equal(recipe.steps[0].metadata.requestedModelRole, 'workspace');
  assert.equal(recipe.steps[0].metadata.routeLaneId, 'repair-fast');
  assert.equal(recipe.steps[0].metadata.taskMode, 'repair');
  assert.equal(recipe.steps[0].metadata.autonomyDifficultyCeiling, 3);
});

test('buildAutoFollowupPlan queues but does not auto-run while do-not-widen is active', () => {
  const plan = buildAutoFollowupPlan({
    task: 'Continue the bounded repair.',
    taskObjective: { summary: 'Continue the bounded repair.' },
    nextAction: {
      command: 'continue-run',
      label: 'Continue run',
      summary: 'Continue the bounded repair.',
      prompt: 'Continue the bounded repair.',
    },
  }, {
    settings: {
      autoQueueTaskLoopFollowups: true,
      autoRunQueuedTaskLoopFollowups: true,
    },
    safeMode: { active: false, watchOnly: false, controller: { manualSafeMode: false } },
    readiness: {
      doNotWidenYetBecause: 'Do not widen yet because safe autonomous progress is 2/5 today.',
    },
    pendingApprovals: 0,
  });

  assert.equal(plan.exists, true);
  assert.equal(plan.shouldQueue, true);
  assert.equal(plan.shouldAutoRun, false);
  assert.match(String(plan.reason || ''), /Do not widen yet/i);
  assert.equal(plan.recipe.autoQueueEligible, false);
});

test('buildAutoFollowupPlan can auto-run one extra bounded self-host follow-up when proof is proven', () => {
  const plan = buildAutoFollowupPlan({
    task: 'Continue the bounded self-host repair.',
    taskObjective: { summary: 'Continue the bounded self-host repair.' },
    nextAction: {
      command: 'continue-run',
      label: 'Continue run',
      summary: 'Continue the bounded self-host repair.',
      prompt: 'Continue the bounded self-host repair.',
    },
  }, {
    settings: {
      autoQueueTaskLoopFollowups: true,
      autoRunQueuedTaskLoopFollowups: true,
    },
    safeMode: { active: false, watchOnly: false, controller: { manualSafeMode: false } },
    readiness: {
      doNotWidenYetBecause: 'Do not widen yet because safe autonomous progress is 2/5 today.',
      selfHostExpansion: {
        eligible: true,
        status: 'ready',
        label: 'OPEN',
        summary: 'One extra supervised self-host follow-up is allowed today.',
        remainingCount: 1,
      },
    },
    pendingApprovals: 0,
  });

  assert.equal(plan.exists, true);
  assert.equal(plan.shouldQueue, true);
  assert.equal(plan.shouldAutoRun, true);
  assert.equal(plan.recipe.selfHostExpansion, true);
  assert.equal(plan.recipe.steps[0].metadata.selfHostExpansion, true);
  assert.match(String(plan.reason || ''), /self-host follow-up/i);
});

test('buildAutoFollowupPlan blocks automatic queueing while review is still holding the loop', () => {
  const plan = buildAutoFollowupPlan({
    task: 'Repair the validation path.',
    taskObjective: { summary: 'Repair the validation path.' },
    nextAction: {
      command: 'repair-loop',
      label: 'Repair loop',
      summary: 'Repair the validation path.',
      prompt: 'Repair the validation path.',
    },
    reviewBundle: {
      requiresManualReview: true,
      pendingCount: 1,
    },
  }, {
    settings: {
      autoQueueTaskLoopFollowups: true,
      autoRunQueuedTaskLoopFollowups: true,
    },
    safeMode: { active: false, watchOnly: false, controller: { manualSafeMode: false } },
    readiness: {},
    pendingApprovals: 0,
  });

  assert.equal(plan.exists, true);
  assert.equal(plan.shouldQueue, false);
  assert.equal(plan.shouldAutoRun, false);
  assert.match(String(plan.reason || ''), /review or approval/i);
});
