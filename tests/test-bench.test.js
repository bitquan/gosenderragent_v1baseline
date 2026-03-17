'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTestBenchSnapshot } = require('../core/test-bench');

test('test bench picks a preferred path from reviewer and failing locations', () => {
  const snapshot = buildTestBenchSnapshot('/workspace', {
    review: {
      changedFiles: [{ path: 'src/editor.ts', status: 'M' }],
      failingLocations: [{ path: 'src/editor.ts', line: 9, message: 'Expected cursor to reset.' }],
      recentArtifacts: [{ path: '/workspace/docs/assistant_runs/run.md', label: 'run notes' }],
    },
    reviewer: {
      status: 'needs-revision',
      summary: 'Reviewer wants a revision pass.',
      notes: [{ title: 'Validation finding', detail: 'Reset cursor state.', path: 'src/editor.ts' }],
      revisionCandidates: [],
    },
    regression: {
      candidateCount: 1,
      candidates: [{ id: 'validation', title: 'Add regression coverage', targetPaths: ['src/editor.ts'] }],
    },
    docsVault: {
      exists: true,
      count: 1,
      freshnessLabel: 'fresh',
      summary: '1 approved doc source across 1 domain.',
      latest: {
        domain: 'react.dev',
        title: 'useMemo',
      },
    },
    latestRun: {
      label: 'Repair editor flow',
      state: 'fail',
    },
  });

  assert.equal(snapshot.status, 'needs-revision');
  assert.equal(snapshot.preferredPath, 'src/editor.ts');
  assert.equal(snapshot.changedFiles.length, 1);
  assert.equal(snapshot.failingLocations.length, 1);
  assert.equal(snapshot.followups.length, 1);
  assert.equal(snapshot.followups[0].kind, 'regression');
  assert.equal(snapshot.docsContext.exists, true);
  assert.equal(snapshot.docsContext.freshnessLabel, 'fresh');
});

test('test bench builds a prioritized follow-up queue from reviewer and regression signals', () => {
  const snapshot = buildTestBenchSnapshot('/workspace', {
    reviewer: {
      revisionCandidates: [
        {
          id: 'revision-1',
          title: 'Revise src/editor.ts',
          summary: 'Tighten the editor flow before approval.',
          targetPaths: ['src/editor.ts'],
          source: 'reviewer',
        },
      ],
    },
    regression: {
      candidates: [
        {
          id: 'regression-1',
          title: 'Add regression coverage for src/editor.ts',
          summary: 'Lock the approved editor behavior.',
          targetPaths: ['src/editor.ts'],
          source: 'regression-builder',
        },
      ],
    },
  });

  assert.equal(snapshot.followups.length, 2);
  assert.equal(snapshot.followups[0].id, 'revision-1');
  assert.equal(snapshot.followups[0].kind, 'revision');
  assert.equal(snapshot.followups[0].actionLabel, 'Create revision task');
  assert.equal(snapshot.followups[1].id, 'regression-1');
  assert.equal(snapshot.followups[1].kind, 'regression');
  assert.equal(snapshot.followups[1].actionLabel, 'Create regression task');
});

test('test bench adds a docs refresh follow-up when the trusted docs vault is stale', () => {
  const snapshot = buildTestBenchSnapshot('/workspace', {
    review: {
      changedFiles: [{ path: 'src/app.tsx', status: 'M' }],
    },
    reviewer: {
      status: 'needs-review',
      summary: 'Reviewer wants a clean docs-guided pass.',
      notes: [],
      revisionCandidates: [],
    },
    docsVault: {
      exists: true,
      freshnessLabel: 'stale',
      summary: 'Latest approved docs are stale.',
      recommendedSources: [
        { domain: 'react.dev', label: 'React', reason: 'React docs fit this UI slice.' },
      ],
      latest: {
        domain: 'react.dev',
        title: 'Components and Props',
      },
    },
  });

  assert.ok(snapshot.followups.some((item) => String(item.candidate?.category || '') === 'docs-refresh'));
  assert.ok(snapshot.followups.some((item) => String(item.actionLabel || '') === 'Create docs task'));
  assert.match(String(snapshot.docsContext.recommendedAction || ''), /refresh/i);
  assert.equal(snapshot.docsContext.recommendedSources[0].domain, 'react.dev');
});

test('test bench keeps docs scout follow-ups actionable without extra UI state', () => {
  const snapshot = buildTestBenchSnapshot('/workspace', {
    reviewer: {
      revisionCandidates: [
        {
          id: 'docs-scout-1',
          category: 'docs-scout',
          title: 'Scout trusted docs for settings',
          objective: 'Capture a trusted docs source for the settings slice, then summarize the next safe revision.',
          summary: 'Capture a trusted docs source for the settings slice.',
          targetPaths: ['src/settings.ts'],
          source: 'trusted-docs-vault',
        },
      ],
    },
  });

  assert.equal(snapshot.followups.length, 1);
  assert.equal(snapshot.followups[0].actionLabel, 'Create docs scout task');
  assert.deepEqual(snapshot.followups[0].candidate.capabilities, ['research-docs', 'plan-reasoning']);
  assert.equal(snapshot.nextSafeAction.exists, true);
  assert.equal(snapshot.nextSafeAction.autoQueueEligible, true);
  assert.equal(snapshot.nextSafeAction.actionLabel, 'Queue docs scout');
  assert.match(String(snapshot.nextSafeAction.prompt || ''), /trusted docs source/i);
});

test('test bench blocks auto-queue when approvals are still pending', () => {
  const snapshot = buildTestBenchSnapshot('/workspace', {
    reviewer: {
      pendingApprovalCount: 2,
      revisionCandidates: [
        {
          id: 'docs-refresh-1',
          category: 'docs-refresh',
          title: 'Refresh trusted docs for settings',
          summary: 'Refresh the docs before the next revision.',
          targetPaths: ['src/settings.ts'],
          riskClass: 'low',
          source: 'trusted-docs-vault',
        },
      ],
    },
    docsVault: {
      exists: true,
      freshnessLabel: 'stale',
      summary: 'Latest approved docs are stale.',
    },
  });

  assert.equal(snapshot.nextSafeAction.exists, true);
  assert.equal(snapshot.nextSafeAction.autoQueueEligible, false);
  assert.match(String(snapshot.nextSafeAction.reason || ''), /pending approvals/i);
});
