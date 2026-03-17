'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRegressionCandidates } = require('../core/regression-builder');

test('regression builder creates validation and coverage candidates', () => {
  const result = buildRegressionCandidates('/workspace', {
    review: {
      changedFiles: [
        { path: 'src/auth/login.ts', status: 'M' },
      ],
      failingLocations: [
        { path: 'src/auth/login.ts', line: 18, message: 'Login should reject empty token.' },
      ],
    },
    latestRun: {
      state: 'fail',
      label: 'Implement login flow',
    },
    approvalQueue: [],
  });

  assert.equal(result.candidateCount, 2);
  assert.match(result.candidates[0].title, /regression coverage/i);
  assert.match(result.candidates[1].title, /coverage/i);
});

test('regression builder turns held review feedback into a follow-up candidate', () => {
  const result = buildRegressionCandidates('/workspace', {
    review: {
      changedFiles: [{ path: 'src/ui/panel.tsx', status: 'M' }],
      failingLocations: [],
    },
    approvalQueue: [
      { path: 'src/ui/panel.tsx', status: 'rejected', nextAction: 'Add a regression for the loading state.' },
    ],
  });

  assert.equal(result.candidateCount, 2);
  assert.match(result.candidates[0].summary, /review feedback/i);
});

test('regression builder turns operator supervision into regression candidates', () => {
  const result = buildRegressionCandidates('/workspace', {
    review: {
      changedFiles: [{ path: 'src/ui/panel.tsx', status: 'M' }],
      failingLocations: [],
    },
    approvalQueue: [],
    operatorSupervision: {
      recent: [
        {
          verdict: 'needs-changes',
          note: 'Rerun smoke and tighten the spacing before approval.',
          path: 'src/ui/panel.tsx',
          recordedAt: '2026-03-15T18:20:00.000Z',
        },
        {
          verdict: 'approved',
          note: 'Keep the compact card layout.',
          path: 'src/ui/panel.tsx',
          recordedAt: '2026-03-15T18:25:00.000Z',
        },
      ],
    },
  });

  assert.ok(result.candidates.some((candidate) => String(candidate.category || '') === 'operator-feedback'));
  assert.ok(result.candidates.some((candidate) => String(candidate.category || '') === 'approved-behavior'));
});
