'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseBatBoard, collectProtectedBatReviewSignals } = require('../core/board');
const { buildApprovalDecisionKey, buildApprovalQueue } = require('../core/approval-queue');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-approval-queue-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'docs', 'BAT_FEATURE_BOARD.md'),
    [
      '- `BAT<500>` [TODO][OPS][P1] Review payment protection handoff.',
      '- `BAT<502>` [TODO][OPS][P1] Review migration protection handoff.',
      '- `BAT<503>` [TODO][OPS][P1] Review network pool protection handoff.',
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

function buildProtectedQueue(workspaceRoot, decisions = {}) {
  const bats = parseBatBoard(workspaceRoot).map((item) => ({
    ...item,
    safeBlockedReason: item.ticket === '500'
      ? 'safe mode blocked protected domain: payments'
      : item.ticket === '502'
        ? 'safe mode blocked protected terms: migration'
        : 'safe mode blocked protected terms: network pool',
  }));
  return buildApprovalQueue({
    workspaceRoot,
    review: { changedFiles: [], failingLocations: [], recentArtifacts: [] },
    recentRuns: [],
    decisions,
    bats,
    autonomy: {
      humanApprovalProtectedOnly: true,
      autoApproveLowRisk: true,
    },
    approvalRequiredPath: () => true,
    isProtectedApprovalPath: () => false,
    isLowRiskApprovalPath: () => true,
    collectRuntimeApprovalSignals: () => [],
    collectProtectedBatReviewSignals,
  });
}

test('buildApprovalQueue keeps separate protected BAT handoffs on the board file', () => {
  const workspaceRoot = makeWorkspace();
  try {
    const queue = buildProtectedQueue(workspaceRoot);

    assert.equal(queue.length, 3);
    assert.deepEqual(queue.map((item) => item.ticket).sort(), ['500', '502', '503']);
    assert.equal(new Set(queue.map((item) => item.approvalKey)).size, 3);
    assert.ok(queue.every((item) => item.path === 'docs/BAT_FEATURE_BOARD.md'));
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('buildApprovalQueue only honors keyed decisions for protected BAT handoffs', () => {
  const workspaceRoot = makeWorkspace();
  try {
    const protectedApprovalKey = buildApprovalDecisionKey({
      path: 'docs/BAT_FEATURE_BOARD.md',
      source: 'protected-bat',
      line: 2,
      ticket: '502',
    });

    const queueWithPathApproval = buildProtectedQueue(workspaceRoot, {
      'docs/BAT_FEATURE_BOARD.md': { status: 'approved', note: '', updatedAt: '2026-03-13T00:00:00Z' },
    });
    assert.equal(queueWithPathApproval.length, 3);

    const queueWithKeyedApproval = buildProtectedQueue(workspaceRoot, {
      [protectedApprovalKey]: { status: 'approved', note: 'reviewed', updatedAt: '2026-03-13T00:00:00Z' },
    });
    assert.deepEqual(queueWithKeyedApproval.map((item) => item.ticket).sort(), ['500', '503']);
    assert.ok(queueWithKeyedApproval.every((item) => item.approvalKey !== protectedApprovalKey));
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});