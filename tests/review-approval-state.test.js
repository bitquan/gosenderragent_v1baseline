'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyDecision,
  decisionForItem,
  findApprovalItem,
  normalizeReviewDecisions,
  normalizeReviewSelection,
  resolveSaveApproval,
} = require('../core/review-approval-state');

test('normalizeReviewDecisions prunes stale protected approval keys when queue is provided', () => {
  const decisions = normalizeReviewDecisions(
    {
      'approval::protected-bat::docs/BAT_FEATURE_BOARD.md::500::2': { status: 'approved', updatedAt: '2026-03-12T00:00:00Z' },
      'approval::protected-bat::docs/BAT_FEATURE_BOARD.md::999::9': { status: 'deferred', updatedAt: '2026-03-12T01:00:00Z' },
      'docs/notes.md': { status: 'approved', updatedAt: '2026-03-12T02:00:00Z' },
    },
    {
      queue: [{ approvalKey: 'approval::protected-bat::docs/BAT_FEATURE_BOARD.md::500::2' }],
    },
  );

  assert.equal(decisions['approval::protected-bat::docs/BAT_FEATURE_BOARD.md::500::2'].status, 'approved');
  assert.equal(decisions['docs/notes.md'].status, 'approved');
  assert.equal('approval::protected-bat::docs/BAT_FEATURE_BOARD.md::999::9' in decisions, false);
});

test('normalizeReviewDecisions keeps a selected protected approval key even after it leaves the queue', () => {
  const decisions = normalizeReviewDecisions(
    {
      'approval::protected-bat::docs/BAT_FEATURE_BOARD.md::500::2': { status: 'approved', updatedAt: '2026-03-12T00:00:00Z' },
      'approval::protected-bat::docs/BAT_FEATURE_BOARD.md::999::9': { status: 'deferred', updatedAt: '2026-03-12T01:00:00Z' },
    },
    {
      queue: [{ approvalKey: 'approval::protected-bat::docs/BAT_FEATURE_BOARD.md::999::9' }],
      preserveKeys: ['approval::protected-bat::docs/BAT_FEATURE_BOARD.md::500::2'],
    },
  );

  assert.equal(decisions['approval::protected-bat::docs/BAT_FEATURE_BOARD.md::500::2'].status, 'approved');
  assert.equal('approval::protected-bat::docs/BAT_FEATURE_BOARD.md::999::9' in decisions, true);
});

test('resolveSaveApproval prefers keyed protected review decisions over path-only state', () => {
  const approval = resolveSaveApproval(
    {
      'docs/BAT_FEATURE_BOARD.md': { status: 'approved' },
      'approval::protected-bat::docs/BAT_FEATURE_BOARD.md::500::2': { status: 'deferred' },
    },
    {
      path: 'docs/BAT_FEATURE_BOARD.md',
      approvalKey: 'approval::protected-bat::docs/BAT_FEATURE_BOARD.md::500::2',
    },
  );

  assert.equal(approval.key, 'approval::protected-bat::docs/BAT_FEATURE_BOARD.md::500::2');
  assert.equal(approval.decision.status, 'deferred');
});

test('findApprovalItem resolves queue items by ticket', () => {
  const queue = [
    { approvalKey: 'approval::protected-bat::docs/BAT_FEATURE_BOARD.md::500::2', ticket: '500', path: 'docs/BAT_FEATURE_BOARD.md', line: 2 },
    { approvalKey: 'docs/notes.md', ticket: '', path: 'docs/notes.md', line: 1 },
  ];

  const item = findApprovalItem(queue, { ticket: '500' });
  assert.equal(item?.approvalKey, 'approval::protected-bat::docs/BAT_FEATURE_BOARD.md::500::2');
});

test('applyDecision and decisionForItem keep keyed protected BAT decisions isolated', () => {
  const applied = applyDecision({}, {
    path: 'docs/BAT_FEATURE_BOARD.md',
    approvalKey: 'approval::protected-bat::docs/BAT_FEATURE_BOARD.md::500::2',
  }, 'approved', 'looks good');

  assert.equal(applied.key, 'approval::protected-bat::docs/BAT_FEATURE_BOARD.md::500::2');
  assert.equal(decisionForItem(applied.decisions, {
    path: 'docs/BAT_FEATURE_BOARD.md',
    approvalKey: 'approval::protected-bat::docs/BAT_FEATURE_BOARD.md::500::2',
    source: 'protected-bat',
  }).status, 'approved');
});

test('normalizeReviewSelection sanitizes persisted review focus', () => {
  const selection = normalizeReviewSelection({
    path: '/docs/BAT_FEATURE_BOARD.md',
    approvalKey: ' approval::protected-bat::docs/BAT_FEATURE_BOARD.md::500::2 ',
    line: 0,
    ticket: '500',
  });

  assert.equal(selection.path, 'docs/BAT_FEATURE_BOARD.md');
  assert.equal(selection.approvalKey, 'approval::protected-bat::docs/BAT_FEATURE_BOARD.md::500::2');
  assert.equal(selection.line, 1);
});