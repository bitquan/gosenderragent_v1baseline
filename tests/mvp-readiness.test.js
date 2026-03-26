'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMvpReadiness } = require('../core/mvp-readiness');

test('mvp readiness maps a fully healthy workspace to the 12-month baseline end state', () => {
  const workspaceRoot = '/workspace/gosenderr-desktop-agent-PC';
  const readiness = buildMvpReadiness({
    generatedAt: '2026-03-16T18:00:00.000Z',
    workspaceRoot,
    targetWorkspaceRoot: workspaceRoot,
    manager: {
      summaryText: 'Engine, review, and operator summaries are healthy.',
      safeMode: { active: false, watchOnly: false },
      approvals: { total: 0 },
      autonomousActions: {
        actionCount: 5,
        overscopedCount: 0,
        recommendedNextSafeAction: 'Keep the next autonomous slice bounded to the current model envelope.',
        dailyTarget: {
          target: 5,
          safeCount: 5,
          met: true,
        },
      },
    },
    promotions: {
      promotionGate: { status: 'ready', summary: 'Candidate is promotable.' },
      backups: [{ id: 'backup-1' }],
      readyCandidates: [{ id: 'candidate-1' }],
    },
    learningJournal: {
      trainingReadiness: { status: 'ready', summary: 'Training handoff is ready.' },
      gsDev1ExportReadiness: { status: 'ready', summary: 'Trusted export is ready.' },
      operatorSupervision: { count: 2 },
    },
    selfImprovement: {
      preparedTaskCount: 3,
      historyCount: 7,
      safeExecutionCount: 7,
      recommendedNextSafeAction: 'Queue the next safe self-improvement slice after review clears.',
      dailyTarget: {
        target: 5,
        safeCount: 5,
        met: true,
      },
    },
    taskHub: {
      tasks: [{
        id: 'task-1',
        title: 'Finish the unified daily quota proof surface',
        status: 'ready',
        slices: [{ id: 'slice-1' }],
        workspaceRoot,
        targetWorkspaceRoot: workspaceRoot,
        metadata: {
          dailyTask: true,
          roadmapDay: '2026-03-16',
          roadmapMonth: 'month-1-engine-baseline',
          workspaceScopeRoot: workspaceRoot,
        },
      }],
      recipes: [
        { id: 'recipe-1', workspaceRoot, targetWorkspaceRoot: workspaceRoot },
        { id: 'recipe-2', workspaceRoot, targetWorkspaceRoot: workspaceRoot },
      ],
      runs: [{ id: 'run-1', workspaceRoot, targetWorkspaceRoot: workspaceRoot }],
    },
    modelFoundry: {
      candidateCount: 1,
      suggested: [{ id: 'foundry-1' }],
      summary: 'Model Foundry has a candidate ready.',
    },
    modelRoles: {
      workspace: { modelProfileId: 'gs-dev-1-default' },
      engine: { modelProfileId: 'gse-1-engine' },
      laneAssignments: [
        { laneId: 'chat-fast', role: 'workspace' },
        { laneId: 'code-main', role: 'workspace' },
        { laneId: 'repair-fast', role: 'workspace' },
        { laneId: 'plan-reasoning', role: 'engine' },
        { laneId: 'review-verify', role: 'engine' },
        { laneId: 'research-docs', role: 'engine' },
        { laneId: 'ops-summary', role: 'engine' },
      ],
    },
    modelProvisioning: {
      status: 'ready',
      summary: 'Workspace and engine model provisioning are trustworthy.',
    },
    acceptance: {
      exists: true,
      report: {
        overallStatus: 'pass',
        summary: 'All tracked acceptance checks passed.',
        modelParity: {
          status: 'pass',
          capabilityCount: 5,
          readyCount: 5,
          widenReady: true,
          summary: 'Local-vs-remote parity is PROVEN across 5/5 core coding capabilities.',
        },
        checks: [
          { id: 'tests', status: 'pass', summary: 'Tests passed.' },
          { id: 'smoke-ui', status: 'pass', summary: 'UI smoke passed.' },
          { id: 'self-host-bootstrap', status: 'pass', summary: 'Bootstrap passed.' },
          { id: 'self-host-tests', status: 'pass', summary: 'Self-host tests passed.' },
          { id: 'self-host-smoke', status: 'pass', summary: 'Self-host smoke passed.' },
        ],
      },
    },
    vscodeSetup: {
      companionInstall: {
        available: true,
        installed: true,
      },
    },
    extensionHealth: {
      exists: true,
      status: 'ready',
      summary: 'GoSenderr VS Code Companion is aligned enough for the current desktop baseline.',
      nextStep: 'Keep the extension aligned with the desktop contracts as you tune the engine.',
    },
    reviewer: {
      status: 'ready',
      summary: 'Reviewer is satisfied with the current slice.',
    },
    regression: {
      candidateCount: 1,
      summary: 'One regression candidate is available.',
    },
    testBench: {
      status: 'ready',
      summary: 'Validation and review are healthy.',
    },
    integrations: {
      installed: [{ id: 'integration-1' }],
      library: [{ id: 'template-1' }],
    },
    appRollbacks: {
      backups: [{ id: 'rollback-1' }],
    },
    benchmarks: {
      runs: [{ id: 'benchmark-1' }],
    },
    updates: {
      workspace: {
        state: 'current',
      },
    },
  });

  assert.equal(readiness.ok, true);
  assert.equal(readiness.percent, 100);
  assert.equal(readiness.phasePercent, 100);
  assert.equal(readiness.roadmapPercent, 100);
  assert.equal(readiness.status, 'strong');
  assert.equal(readiness.phaseStatus, 'strong');
  assert.equal(readiness.currentPhase.number, 5);
  assert.equal(readiness.currentPhase.id, 'phase-5-release-training-and-convergence');
  assert.equal(readiness.currentMonth.number, 12);
  assert.equal(readiness.currentMonth.id, 'month-12-supervised-autonomy-convergence');
  assert.equal(readiness.phaseGate.ok, true);
  assert.equal(readiness.hardGate.ok, true);
  assert.match(readiness.phaseProof, /Phase 5|structural baseline proof/i);
   assert.ok(Array.isArray(readiness.phaseScorecards));
   assert.equal(readiness.phaseScorecards.length, 5);
   assert.match(readiness.internalAudit.summary, /Month 12|PASS/i);
  assert.equal(readiness.phaseNextMilestone, null);
  assert.equal(readiness.nextMilestone, null);
  assert.equal(readiness.roadmapNextMilestone, null);
  assert.equal(readiness.dailyTargets.autonomous.safeCount, 5);
  assert.equal(readiness.dailyTargets.selfImprovement.safeCount, 5);
  assert.equal(readiness.dailyQuotaProof.focusTask.title, 'Finish the unified daily quota proof surface');
  assert.equal(readiness.dailyQuotaProof.blockedRescopedCount, 0);
  assert.equal(readiness.overscopedActionCount, 0);
  assert.match(readiness.summary, /5-phase MVP readiness is 100%/i);
  assert.equal(readiness.selfHostExpansion.eligible, false);
  assert.equal(readiness.selfHostExpansionProgress.label, 'NOT USED');
  assert.equal(readiness.modelParity.label, 'PROVEN');
  assert.equal(readiness.nextPhasePreview, null);
  assert.ok(readiness.phases.some((item) => item.id === 'phase-1-safe-engine-core' && item.status === 'ready'));
  assert.ok(readiness.milestones.some((item) => item.id === 'month-2-gse1-engine-brain' && item.status === 'ready'));
});

test('mvp readiness blocks Month 1 when the engine baseline is still unsafe', () => {
  const workspaceRoot = '/workspace/gosenderr-desktop-agent-PC';
  const readiness = buildMvpReadiness({
    generatedAt: '2026-03-16T18:00:00.000Z',
    workspaceRoot,
    targetWorkspaceRoot: workspaceRoot,
    manager: {
      summaryText: 'Safe mode engaged.',
      safeMode: { active: true, watchOnly: false },
      approvals: { total: 1 },
      autonomousActions: {
        actionCount: 2,
        overscopedCount: 2,
        recommendedNextSafeAction: 'Rescope the next autonomous task before it runs again.',
        dailyTarget: {
          target: 5,
          safeCount: 1,
          met: false,
        },
      },
    },
    promotions: {
      promotionGate: { status: 'blocked', summary: 'Acceptance has not passed yet.' },
      backups: [],
      readyCandidates: [],
    },
    learningJournal: {
      trainingReadiness: { status: 'idle', summary: '' },
      gsDev1ExportReadiness: { status: 'idle', summary: '' },
      operatorSupervision: { count: 0 },
    },
    selfImprovement: {
      preparedTaskCount: 0,
      historyCount: 0,
      dailyTarget: {
        target: 5,
        safeCount: 0,
        met: false,
      },
    },
    taskHub: {
      tasks: [{
        id: 'task-unsafe-1',
        title: 'Rescope the overscoped autonomous slice',
        status: 'needs-rescope',
        workspaceRoot,
        targetWorkspaceRoot: workspaceRoot,
        metadata: {
          dailyTask: true,
          roadmapDay: '2026-03-16',
          roadmapMonth: 'month-1-engine-baseline',
          lastBlockedBy: 'model-fit',
          lastBlockedReason: 'Task exceeds the active model envelope.',
          workspaceScopeRoot: workspaceRoot,
        },
      }],
      recipes: [],
      runs: [],
    },
    modelFoundry: {
      candidateCount: 0,
      suggested: [],
      summary: '',
    },
    modelRoles: {
      workspace: { modelProfileId: 'gs-dev-1-default' },
      engine: { modelProfileId: '' },
      laneAssignments: [
        { laneId: 'chat-fast', role: 'workspace' },
      ],
    },
    acceptance: {
      exists: true,
      report: {
        overallStatus: 'warn',
        summary: 'Acceptance still has warnings.',
      },
    },
  });

  assert.equal(readiness.currentPhase.number, 1);
  assert.equal(readiness.currentPhase.id, 'phase-1-safe-engine-core');
  assert.deepEqual(readiness.currentPhase.monthNumbers, [1, 2]);
  assert.equal(readiness.phaseGate.ok, false);
  assert.equal(readiness.phaseGate.label, 'BLOCKED');
  assert.equal(readiness.phaseNextMilestone.id, 'phase-1-safe-engine-core');
  assert.match(readiness.phaseProof, /internal month audit|Month 1/i);
   assert.match(readiness.internalAudit.summary, /Month 1|BLOCKED/i);
  assert.equal(readiness.currentMonth.number, 1);
  assert.equal(readiness.currentMonth.id, 'month-1-engine-baseline');
  assert.equal(readiness.hardGate.ok, false);
  assert.equal(readiness.hardGate.label, 'BLOCKED');
  assert.equal(readiness.roadmapNextMilestone.id, 'month-1-engine-baseline');
  assert.equal(readiness.dailyQuotaProof.focusTask.title, 'Rescope the overscoped autonomous slice');
  assert.equal(readiness.dailyQuotaProof.blockedRescopedCount, 1);
  assert.equal(readiness.overscopedActionCount, 2);
  assert.equal(readiness.dailyTargets.autonomous.met, false);
  assert.equal(readiness.dailyTargets.selfImprovement.met, false);
  assert.match(readiness.doNotWidenYetBecause, /operator baseline acceptance path is not proven/i);
  assert.equal(readiness.recommendedNextSafeAction, 'Rescope the next autonomous task before it runs again.');
  assert.match(readiness.summary, /phase 1/i);
  assert.equal(readiness.selfHostExpansion.eligible, false);
  assert.equal(readiness.selfHostExpansionProgress.label, 'NOT USED');
  assert.match(readiness.phaseCloseout.summary, /Close Phase 1/i);
  assert.equal(readiness.nextPhasePreview.id, 'phase-2-assisted-coding-parity');
  assert.match(readiness.hardGate.reasons.join(' '), /operator baseline acceptance|acceptance/i);
  assert.match(readiness.hardGate.reasons.join(' '), /self-improvement/i);
});

test('mvp readiness opens one extra self-host expansion lane when proof is proven and only quota gates remain', () => {
  const workspaceRoot = '/workspace/gosenderr-desktop-agent-PC';
  const readiness = buildMvpReadiness({
    generatedAt: '2026-03-17T20:00:00.000Z',
    workspaceRoot,
    targetWorkspaceRoot: workspaceRoot,
    manager: {
      summaryText: 'Engine baseline is healthy enough for one more bounded self-host follow-up.',
      safeMode: { active: false, watchOnly: false },
      approvals: { total: 0 },
      autonomousActions: {
        actionCount: 2,
        overscopedCount: 0,
        recommendedNextSafeAction: 'Keep the next slice bounded and supervised.',
        dailyTarget: {
          target: 5,
          safeCount: 2,
          met: false,
        },
      },
    },
    learningJournal: {
      trainingReadiness: { status: 'ready', summary: 'Training handoff is ready.' },
      gsDev1ExportReadiness: { status: 'ready', summary: 'Trusted export is ready.' },
      operatorSupervision: { count: 1 },
    },
    selfImprovement: {
      preparedTaskCount: 1,
      historyCount: 1,
      dailyTarget: {
        target: 5,
        safeCount: 0,
        met: false,
      },
    },
    taskHub: {
      tasks: [{
        id: 'task-focus-1',
        title: 'Keep the self-host repair slice bounded',
        status: 'ready',
        slices: [{ id: 'slice-1' }],
        workspaceRoot,
        targetWorkspaceRoot: workspaceRoot,
        metadata: {
          dailyTask: true,
          roadmapDay: '2026-03-17',
          roadmapMonth: 'month-1-engine-baseline',
          workspaceScopeRoot: workspaceRoot,
        },
      }],
      recipes: [],
      runs: [],
    },
    modelFoundry: {
      candidateCount: 0,
      suggested: [],
      summary: '',
    },
    modelProvisioning: {
      status: 'ready',
      summary: 'Workspace and engine model roles are provisioned.',
    },
    modelRoles: {
      workspace: { modelProfileId: 'gs-dev-1-default' },
      engine: { modelProfileId: 'gse-1-engine' },
      laneAssignments: [
        { laneId: 'chat-fast', role: 'workspace' },
        { laneId: 'plan-reasoning', role: 'engine' },
      ],
    },
    acceptance: {
      exists: true,
      report: {
        overallStatus: 'pass',
        summary: 'Acceptance passed.',
        checks: [
          { id: 'self-host-bootstrap', status: 'pass', summary: 'Bootstrap passed.' },
          { id: 'self-host-tests', status: 'pass', summary: 'Tests passed.' },
          { id: 'self-host-smoke', status: 'pass', summary: 'Smoke passed.' },
        ],
      },
    },
  });

  assert.equal(readiness.currentPhase.id, 'phase-1-safe-engine-core');
  assert.equal(readiness.phaseGate.ok, false);
  assert.equal(readiness.selfHostProof.label, 'PROVEN');
  assert.equal(readiness.selfHostExpansion.eligible, true);
  assert.equal(readiness.selfHostExpansion.label, 'OPEN');
  assert.equal(readiness.selfHostExpansion.remainingCount, 1);
  assert.equal(readiness.selfHostExpansionProgress.label, 'NOT USED');
  assert.match(readiness.dailyQuotaProof.doNotWidenYetBecause, /One extra supervised self-host follow-up is still allowed/i);
  assert.match(readiness.phaseCloseout.nextAction, /auto-run one bounded self-host follow-up|one more bounded self-host follow-up/i);
  assert.equal(readiness.nextPhasePreview.id, 'phase-2-assisted-coding-parity');
});

test('mvp readiness treats a queued self-host expansion as unavailable and tracks the real outcome separately', () => {
  const workspaceRoot = '/workspace/gosenderr-desktop-agent-PC';
  const readiness = buildMvpReadiness({
    generatedAt: '2026-03-17T20:00:00.000Z',
    workspaceRoot,
    targetWorkspaceRoot: workspaceRoot,
    manager: {
      summaryText: 'The engine has already queued the one extra self-host follow-up.',
      safeMode: { active: false, watchOnly: false },
      approvals: { total: 0 },
      autonomousActions: {
        actionCount: 2,
        overscopedCount: 0,
        recommendedNextSafeAction: 'Keep the next slice bounded and supervised.',
        dailyTarget: {
          target: 5,
          safeCount: 2,
          met: false,
        },
      },
    },
    learningJournal: {
      trainingReadiness: { status: 'ready', summary: 'Training handoff is ready.' },
      gsDev1ExportReadiness: { status: 'ready', summary: 'Trusted export is ready.' },
      operatorSupervision: { count: 1 },
    },
    selfImprovement: {
      preparedTaskCount: 1,
      historyCount: 1,
      dailyTarget: {
        target: 5,
        safeCount: 0,
        met: false,
      },
    },
    taskHub: {
      tasks: [{
        id: 'task-focus-1',
        title: 'Keep the self-host repair slice bounded',
        status: 'ready',
        slices: [{ id: 'slice-1' }],
        workspaceRoot,
        targetWorkspaceRoot: workspaceRoot,
        metadata: {
          dailyTask: true,
          roadmapDay: '2026-03-17',
          roadmapMonth: 'month-1-engine-baseline',
          workspaceScopeRoot: workspaceRoot,
        },
      }, {
        id: 'task-self-host-1',
        title: 'Run one extra bounded self-host follow-up',
        status: 'ready',
        workspaceRoot,
        targetWorkspaceRoot: workspaceRoot,
        metadata: {
          roadmapDay: '2026-03-17',
          selfHostExpansion: true,
          workspaceScopeRoot: workspaceRoot,
        },
      }],
      recipes: [],
      runs: [],
      runLinks: [],
    },
    modelProvisioning: {
      status: 'ready',
      summary: 'Workspace and engine model roles are provisioned.',
    },
    modelRoles: {
      workspace: { modelProfileId: 'gs-dev-1-default' },
      engine: { modelProfileId: 'gse-1-engine' },
      laneAssignments: [
        { laneId: 'chat-fast', role: 'workspace' },
        { laneId: 'plan-reasoning', role: 'engine' },
      ],
    },
    acceptance: {
      exists: true,
      report: {
        overallStatus: 'pass',
        summary: 'Acceptance passed.',
        checks: [
          { id: 'self-host-bootstrap', status: 'pass', summary: 'Bootstrap passed.' },
          { id: 'self-host-tests', status: 'pass', summary: 'Tests passed.' },
          { id: 'self-host-smoke', status: 'pass', summary: 'Smoke passed.' },
        ],
      },
    },
  });

  assert.equal(readiness.selfHostExpansion.eligible, false);
  assert.equal(readiness.selfHostExpansion.label, 'QUEUED');
  assert.equal(readiness.selfHostExpansionProgress.label, 'QUEUED');
  assert.match(readiness.selfHostExpansion.summary, /queued but not consumed yet/i);
  assert.match(readiness.phaseCloseout.blockers.join(' '), /queued/i);
});

test('mvp readiness lets repo-scoped builder proof close Month 9 even when task-hub runs are cold', () => {
  const workspaceRoot = '/workspace/gosenderr-desktop-agent-PC';
  const readiness = buildMvpReadiness({
    generatedAt: '2026-03-17T22:30:00.000Z',
    workspaceRoot,
    targetWorkspaceRoot: workspaceRoot,
    manager: {
      summaryText: 'Baseline proof is healthy.',
      safeMode: { active: false, watchOnly: false },
      approvals: { total: 0 },
      autonomousActions: {
        actionCount: 5,
        overscopedCount: 0,
        recommendedNextSafeAction: 'Keep the next slice bounded.',
        dailyTarget: {
          target: 5,
          safeCount: 5,
          met: true,
        },
      },
    },
    promotions: {
      promotionGate: { status: 'ready', summary: 'Candidate is promotable.' },
      backups: [{ id: 'backup-1' }],
      readyCandidates: [{ id: 'candidate-1' }],
    },
    learningJournal: {
      trainingReadiness: { status: 'ready', summary: 'Training handoff is ready.' },
      gsDev1ExportReadiness: { status: 'ready', summary: 'Trusted export is ready.' },
      operatorSupervision: { count: 2 },
    },
    selfImprovement: {
      preparedTaskCount: 3,
      historyCount: 7,
      safeExecutionCount: 7,
      dailyTarget: {
        target: 5,
        safeCount: 5,
        met: true,
      },
    },
    taskHub: {
      tasks: [{
        id: 'task-1',
        title: 'Finish the unified daily quota proof surface',
        status: 'ready',
        slices: [{ id: 'slice-1' }],
        workspaceRoot,
        targetWorkspaceRoot: workspaceRoot,
        metadata: {
          dailyTask: true,
          roadmapDay: '2026-03-17',
          roadmapMonth: 'month-1-engine-baseline',
          workspaceScopeRoot: workspaceRoot,
        },
      }],
      recipes: [
        { id: 'recipe-1', workspaceRoot, targetWorkspaceRoot: workspaceRoot },
        { id: 'recipe-2', workspaceRoot, targetWorkspaceRoot: workspaceRoot },
      ],
      runs: [],
    },
    modelFoundry: {
      candidateCount: 1,
      suggested: [{ id: 'foundry-1' }],
      summary: 'Model Foundry has a candidate ready.',
    },
    modelRoles: {
      workspace: { modelProfileId: 'gs-dev-1-default' },
      engine: { modelProfileId: 'gse-1-engine' },
      laneAssignments: [
        { laneId: 'chat-fast', role: 'workspace' },
        { laneId: 'code-main', role: 'workspace' },
        { laneId: 'repair-fast', role: 'workspace' },
        { laneId: 'plan-reasoning', role: 'engine' },
        { laneId: 'review-verify', role: 'engine' },
        { laneId: 'research-docs', role: 'engine' },
        { laneId: 'ops-summary', role: 'engine' },
      ],
    },
    modelProvisioning: {
      status: 'ready',
      summary: 'Workspace and engine model provisioning are trustworthy.',
    },
    acceptance: {
      exists: true,
      report: {
        overallStatus: 'pass',
        summary: 'All tracked acceptance checks passed.',
        builderProof: {
          target: 1,
          safeCount: 1,
          overscopedCount: 0,
          actionCount: 1,
          workspaceScoped: true,
          workspaceRoot,
          summary: 'Repo-scoped builder proof captured 1/1 safe current-workspace builder run.',
          actions: [
            {
              runId: 'builder-proof-1',
              workspaceRoot,
              targetWorkspaceRoot: workspaceRoot,
              state: 'pass',
            },
          ],
        },
        checks: [
          { id: 'tests', status: 'pass', summary: 'Tests passed.' },
          { id: 'smoke-ui', status: 'pass', summary: 'UI smoke passed.' },
          { id: 'self-host-bootstrap', status: 'pass', summary: 'Bootstrap passed.' },
          { id: 'self-host-tests', status: 'pass', summary: 'Self-host tests passed.' },
          { id: 'self-host-smoke', status: 'pass', summary: 'Self-host smoke passed.' },
        ],
      },
    },
    vscodeSetup: {
      companionInstall: {
        available: true,
        installed: true,
      },
    },
    extensionHealth: {
      exists: true,
      status: 'ready',
      summary: 'GoSenderr VS Code Companion is aligned enough for the current desktop baseline.',
      nextStep: 'Keep the extension aligned with the desktop contracts as you tune the engine.',
    },
    reviewer: {
      status: 'ready',
      summary: 'Reviewer is satisfied with the current slice.',
    },
    regression: {
      candidateCount: 1,
      summary: 'One regression candidate is available.',
    },
    testBench: {
      status: 'ready',
      summary: 'Validation and review are healthy.',
    },
    integrations: {
      installed: [{ id: 'integration-1' }],
      library: [{ id: 'template-1' }],
    },
    appRollbacks: {
      backups: [{ id: 'rollback-1' }],
    },
    benchmarks: {
      runs: [{ id: 'benchmark-1' }],
    },
    updates: {
      workspace: {
        state: 'current',
      },
    },
  });

  const month9 = readiness.milestones.find((item) => item.id === 'month-9-builder-delivery');
  assert.equal(month9.hardGate.ok, true);
  assert.equal(readiness.currentPhase.id, 'phase-5-release-training-and-convergence');
});
