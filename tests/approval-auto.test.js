'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { collectAutoApprovedDecisions, shouldAutoApproveQueueItem } = require('../core/approval-auto');

test('shouldAutoApproveQueueItem accepts pending low-risk changed files', () => {
  const approved = shouldAutoApproveQueueItem({
    path: 'docs/ENGINE_TEST_WEEK.md',
    status: 'pending',
    source: 'changed-file',
  }, {
    autoApproveLowRisk: true,
    isLowRiskApprovalPath: (value) => String(value).startsWith('docs/'),
    isProtectedApprovalPath: () => false,
  });

  assert.equal(approved, true);
});

test('shouldAutoApproveQueueItem rejects protected and protected-bat entries', () => {
  assert.equal(shouldAutoApproveQueueItem({
    path: 'docs/BAT_FEATURE_BOARD.md',
    status: 'pending',
    source: 'protected-bat',
  }, {
    autoApproveLowRisk: true,
    isLowRiskApprovalPath: () => true,
    isProtectedApprovalPath: () => false,
  }), false);

  assert.equal(shouldAutoApproveQueueItem({
    path: 'backend/tests/test_auth_guard.py',
    status: 'pending',
    source: 'changed-file',
  }, {
    autoApproveLowRisk: true,
    isLowRiskApprovalPath: () => true,
    isProtectedApprovalPath: () => true,
  }), false);
});

test('collectAutoApprovedDecisions approves only sensible low-risk items', () => {
  const result = collectAutoApprovedDecisions([
    {
      path: 'docs/ENGINE_TEST_WEEK.md',
      approvalKey: 'docs/ENGINE_TEST_WEEK.md',
      status: 'pending',
      source: 'changed-file',
    },
    {
      path: 'backend/app/security.py',
      approvalKey: 'backend/app/security.py',
      status: 'pending',
      source: 'changed-file',
    },
  ], {}, {
    autoApproveLowRisk: true,
    isLowRiskApprovalPath: (value) => String(value).startsWith('docs/'),
    isProtectedApprovalPath: (value) => String(value).includes('security'),
  });

  assert.equal(result.approvedItems.length, 1);
  assert.equal(result.approvedItems[0].path, 'docs/ENGINE_TEST_WEEK.md');
  assert.equal(result.decisions['docs/ENGINE_TEST_WEEK.md'].status, 'approved');
  assert.equal(result.decisions['backend/app/security.py'], undefined);
});
