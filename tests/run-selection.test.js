'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeRecentRuns, parseRunMoment, selectFreshestRun } = require('../core/run-selection');

test('parseRunMoment prefers updated timestamps when available', () => {
  const run = {
    startedAt: '2026-03-21T04:00:00.000Z',
    updatedAt: '2026-03-21T05:00:00.000Z',
  };

  assert.equal(parseRunMoment(run), Date.parse('2026-03-21T05:00:00.000Z'));
});

test('mergeRecentRuns dedupes by run id and sorts newest first', () => {
  const merged = mergeRecentRuns(
    [
      { runId: 'run-older', updatedAt: '2026-03-21T04:00:00.000Z' },
      { runId: 'run-newer', updatedAt: '2026-03-21T05:00:00.000Z' },
    ],
    [
      { runId: 'run-newer', updatedAt: '2026-03-21T05:00:00.000Z' },
      { runId: 'run-oldest', updatedAt: '2026-03-21T03:00:00.000Z' },
    ],
  );

  assert.deepEqual(merged.map((item) => item.runId), ['run-newer', 'run-older', 'run-oldest']);
});

test('selectFreshestRun picks the newest run across sources', () => {
  const freshest = selectFreshestRun(
    [{ runId: 'runtime-old', updatedAt: '2026-03-21T04:00:00.000Z' }],
    [{ runId: 'taskhub-new', updatedAt: '2026-03-21T05:10:00.000Z' }],
    [{ runId: 'history-mid', updatedAt: '2026-03-21T04:30:00.000Z' }],
  );

  assert.equal(freshest.runId, 'taskhub-new');
});
