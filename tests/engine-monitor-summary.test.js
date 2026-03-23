'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildLiveEngineMonitorSummary } = require('../core/engine-monitor-summary');

test('buildLiveEngineMonitorSummary prefers non-archived live runs', () => {
  const summary = buildLiveEngineMonitorSummary({
    tasks: [
      { id: 'task-pass', status: 'completed' },
      { id: 'task-fail', status: 'completed' },
      { id: 'task-archived', status: 'archived' },
    ],
    runLinks: [
      {
        taskId: 'task-pass',
        status: 'pass',
        summary: 'builder proof clean',
        metadata: { reviewSummary: { requiresManualReview: false } },
      },
      {
        taskId: 'task-fail',
        status: 'fail',
        summary: 'validation still failing',
        updatedAt: '2026-03-21T04:00:00.000Z',
        metadata: { reviewSummary: { pendingApprovalCount: 1 }, repairCount: 2 },
      },
      {
        taskId: 'task-archived',
        status: 'pass',
        summary: 'stale archived pass',
        updatedAt: '2026-03-21T05:00:00.000Z',
      },
    ],
  });

  assert.equal(summary.hasLiveData, true);
  assert.equal(summary.total, 2);
  assert.equal(summary.passCount, 1);
  assert.equal(summary.failCount, 1);
  assert.equal(summary.passRate, 50);
  assert.equal(summary.reviewRequiredCount, 1);
  assert.equal(summary.reviewRequiredRate, 50);
  assert.equal(summary.averageRepairAttempts, 1);
  assert.match(summary.latestProblemSummary, /validation still failing/i);
});

test('buildLiveEngineMonitorSummary returns an empty baseline when no live runs exist', () => {
  const summary = buildLiveEngineMonitorSummary({ tasks: [], runLinks: [] });

  assert.equal(summary.hasLiveData, false);
  assert.equal(summary.total, 0);
  assert.match(summary.summary, /no live engine runs yet/i);
});

test('buildLiveEngineMonitorSummary keeps only the latest run per task', () => {
  const summary = buildLiveEngineMonitorSummary({
    tasks: [
      { id: 'task-review', status: 'completed' },
      { id: 'task-builder', status: 'completed' },
    ],
    runLinks: [
      {
        taskId: 'task-review',
        runId: 'run-old-fail',
        status: 'fail',
        summary: 'old failure',
        updatedAt: '2026-03-21T04:00:00.000Z',
      },
      {
        taskId: 'task-review',
        runId: 'run-new-pass',
        status: 'pass',
        summary: 'fresh pass',
        updatedAt: '2026-03-21T05:00:00.000Z',
      },
      {
        taskId: 'task-builder',
        runId: 'run-builder-pass',
        status: 'pass',
        summary: 'builder pass',
        updatedAt: '2026-03-21T05:05:00.000Z',
      },
    ],
  });

  assert.equal(summary.hasLiveData, true);
  assert.equal(summary.total, 2);
  assert.equal(summary.passCount, 2);
  assert.equal(summary.failCount, 0);
  assert.equal(summary.passRate, 100);
  assert.equal(summary.latestProblemSummary, '');
});
