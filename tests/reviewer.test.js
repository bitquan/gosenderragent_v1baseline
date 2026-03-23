'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildReviewerSummary } = require('../core/reviewer');

test('reviewer requests a revision when the latest run failed', () => {
  const summary = buildReviewerSummary('/workspace', {
    review: {
      changedFiles: [{ path: 'src/app.ts', status: 'M' }],
      failingLocations: [{ path: 'src/app.ts', line: 42, message: 'Expected status 200' }],
      recentArtifacts: [{ path: '/workspace/docs/assistant_runs/run.md', label: 'run notes' }],
    },
    latestRun: {
      state: 'fail',
      label: 'Implement auth fix',
      blockedReason: 'Tests failed.',
    },
    approvalQueue: [],
    approvedDocReference: { exists: true, domain: 'react.dev', title: 'useEffect' },
  });

  assert.equal(summary.status, 'needs-revision');
  assert.match(summary.summary, /failed run/i);
  assert.equal(summary.failingLocationCount, 1);
  assert.equal(summary.revisionCandidates.length, 3);
  assert.ok(summary.revisionCandidates.some((candidate) => /repair/i.test(String(candidate.title || ''))));
  assert.ok(summary.revisionCandidates.some((candidate) => String(candidate.source || '') === 'reviewer-validation'));
  assert.ok(summary.revisionCandidates.some((candidate) => String(candidate.source || '') === 'reviewer-docs'));
});

test('reviewer does not misclassify runtime startup failures as code revisions', () => {
  const summary = buildReviewerSummary('/workspace', {
    review: {
      changedFiles: [{ path: 'src/app.ts', status: 'M' }],
      failingLocations: [],
      recentArtifacts: [],
    },
    latestRun: {
      state: 'fail',
      label: 'Repair latest failed run',
      stderrTail: 'Could not start the Python runtime: spawn C:\\WINDOWS\\py.exe ENOENT',
    },
    approvalQueue: [],
  });

  assert.equal(summary.status, 'ready');
  assert.match(summary.summary, /engine launch issue/i);
  assert.equal(summary.revisionCandidates.length, 0);
  assert.ok(summary.notes.some((note) => /engine launch issue/i.test(String(note.title || ''))));
});

test('reviewer stays in review mode when only approvals are pending', () => {
  const summary = buildReviewerSummary('/workspace', {
    review: {
      changedFiles: [{ path: 'docs/README.md', status: 'M' }],
      failingLocations: [],
      recentArtifacts: [],
    },
    latestRun: {
      state: 'pass',
      label: 'Docs refresh',
    },
    approvalQueue: [
      { path: 'docs/README.md', status: 'pending', nextAction: 'Review docs wording.' },
    ],
  });

  assert.equal(summary.status, 'needs-review');
  assert.match(summary.summary, /waiting on manual approvals/i);
  assert.equal(summary.pendingApprovalCount, 1);
  assert.equal(summary.revisionCandidates.length, 0);
});

test('reviewer adds a docs-aware revision suggestion when trusted docs and review friction are both present', () => {
  const summary = buildReviewerSummary('/workspace', {
    review: {
      changedFiles: [{ path: 'src/settings.ts', status: 'M' }],
      failingLocations: [{ path: 'src/settings.ts', line: 18, message: 'Configuration key mismatch' }],
      recentArtifacts: [],
    },
    latestRun: {
      state: 'pass',
      label: 'Settings cleanup',
    },
    approvalQueue: [],
    approvedDocReference: {
      exists: true,
      domain: 'code.visualstudio.com',
      title: 'Extension configuration',
    },
  });

  assert.equal(summary.status, 'needs-revision');
  assert.ok(summary.notes.some((note) => /docs-aware revision suggestion/i.test(String(note.title || ''))));
  assert.ok(summary.revisionCandidates.some((candidate) => String(candidate.source || '') === 'reviewer-docs'));
});

test('reviewer turns operator needs-changes feedback into a revision candidate automatically', () => {
  const summary = buildReviewerSummary('/workspace', {
    review: {
      changedFiles: [{ path: 'src/panel.tsx', status: 'M' }],
      failingLocations: [],
      recentArtifacts: [],
    },
    latestRun: {
      state: 'pass',
      label: 'Panel polish',
    },
    operatorSupervision: {
      recent: [
        {
          verdict: 'needs-changes',
          note: 'Tighten the spacing and rerun the smoke check.',
          path: 'src/panel.tsx',
          recordedAt: '2026-03-15T18:00:00.000Z',
        },
      ],
    },
  });

  assert.equal(summary.status, 'needs-revision');
  assert.ok(summary.notes.some((note) => /operator needs-changes/i.test(String(note.title || ''))));
  assert.ok(summary.revisionCandidates.some((candidate) => String(candidate.source || '') === 'operator-feedback'));
});

test('reviewer turns stale trusted docs into a bounded docs refresh task', () => {
  const summary = buildReviewerSummary('/workspace', {
    review: {
      changedFiles: [{ path: 'src/config.ts', status: 'M' }],
      failingLocations: [],
      recentArtifacts: [],
    },
    latestRun: {
      state: 'pass',
      label: 'Config update',
    },
    approvedDocsVault: {
      exists: true,
      freshnessLabel: 'stale',
      summary: 'Latest approved docs are stale.',
      latest: {
        domain: 'docs.python.org',
        title: 'Packaging Python Projects',
      },
    },
  });

  assert.ok(summary.notes.some((note) => /stale/i.test(String(note.title || ''))));
  assert.ok(summary.revisionCandidates.some((candidate) => String(candidate.category || '') === 'docs-refresh'));
  assert.ok(summary.revisionCandidates.some((candidate) => String(candidate.source || '') === 'trusted-docs-vault'));
});

test('reviewer requests a docs scout task when docs-sensitive review work has no trusted docs yet', () => {
  const summary = buildReviewerSummary('/workspace', {
    review: {
      changedFiles: [{ path: 'src/settings.ts', status: 'M' }],
      failingLocations: [{ path: 'src/settings.ts', line: 22, message: 'Extension configuration key mismatch' }],
      recentArtifacts: [],
    },
    latestRun: {
      state: 'pass',
      label: 'Settings and extension setup pass',
    },
  });

  assert.ok(summary.notes.some((note) => /docs are missing/i.test(String(note.title || ''))));
  assert.ok(summary.revisionCandidates.some((candidate) => String(candidate.category || '') === 'docs-scout'));
  assert.ok(summary.revisionCandidates.some((candidate) => String(candidate.source || '') === 'trusted-docs-vault'));
  assert.ok(summary.revisionCandidates.some((candidate) => Array.isArray(candidate.metadata?.recommendedSources) && candidate.metadata.recommendedSources.length > 0));
});
