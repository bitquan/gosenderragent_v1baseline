'use strict';

const { applyDecision, normalizeReviewDecisions } = require('./review-approval-state');

const DEFAULT_ALLOWED_SOURCES = new Set([
  'changed-file',
  'failing-location',
  'patch-review',
  'review-summary',
  'runtime-approval',
]);

function shouldAutoApproveQueueItem(item = {}, options = {}) {
  const autoApproveLowRisk = options.autoApproveLowRisk !== false;
  const isLowRiskApprovalPath = typeof options.isLowRiskApprovalPath === 'function'
    ? options.isLowRiskApprovalPath
    : () => false;
  const isProtectedApprovalPath = typeof options.isProtectedApprovalPath === 'function'
    ? options.isProtectedApprovalPath
    : () => false;
  const allowedSources = options.allowedSources instanceof Set
    ? options.allowedSources
    : new Set(Array.isArray(options.allowedSources) ? options.allowedSources : Array.from(DEFAULT_ALLOWED_SOURCES));

  if (!autoApproveLowRisk) {
    return false;
  }

  const status = String(item.status || 'pending').trim().toLowerCase() || 'pending';
  const source = String(item.source || '').trim().toLowerCase();
  const relativePath = String(item.path || '').trim();

  if (status !== 'pending' || !relativePath) {
    return false;
  }
  if (source === 'protected-bat') {
    return false;
  }
  if (allowedSources.size > 0 && !allowedSources.has(source)) {
    return false;
  }
  if (isProtectedApprovalPath(relativePath)) {
    return false;
  }
  return isLowRiskApprovalPath(relativePath);
}

function collectAutoApprovedDecisions(queue = [], decisions = {}, options = {}) {
  let nextDecisions = normalizeReviewDecisions(decisions);
  const approvedItems = [];
  const note = String(options.note || 'auto-approved low-risk review item').trim();

  for (const item of Array.isArray(queue) ? queue : []) {
    if (!shouldAutoApproveQueueItem(item, options)) {
      continue;
    }
    const result = applyDecision(nextDecisions, {
      path: item.path,
      approvalKey: item.approvalKey || '',
    }, 'approved', note);
    nextDecisions = result.decisions;
    approvedItems.push({
      ...item,
      status: result.decision.status,
      note: result.decision.note,
      updatedAt: result.decision.updatedAt,
    });
  }

  return {
    decisions: nextDecisions,
    approvedItems,
  };
}

module.exports = {
  collectAutoApprovedDecisions,
  shouldAutoApproveQueueItem,
};
