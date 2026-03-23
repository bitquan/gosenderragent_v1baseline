'use strict';

const { normalizeReviewPath } = require('./review');

function buildApprovalDecisionKey(item = {}) {
  const path = normalizeReviewPath(item.path || '');
  const source = String(item.source || '').trim().toLowerCase();
  const ticket = String(item.ticket || '').trim();
  const line = Math.max(1, Number(item.line || 1));
  if (source === 'protected-bat') {
    return `approval::protected-bat::${path}::${ticket || '?'}::${line}`;
  }
  return path;
}

function normalizeDecision(decision = {}) {
  return {
    status: String(decision.status || 'pending').trim().toLowerCase() || 'pending',
    note: String(decision.note || '').trim(),
    updatedAt: String(decision.updatedAt || decision.updated_at || '').trim(),
  };
}

function decisionForQueueItem(decisions, item) {
  const map = decisions && typeof decisions === 'object' ? decisions : {};
  const approvalKey = buildApprovalDecisionKey(item);
  if (approvalKey && map[approvalKey]) {
    return { key: approvalKey, decision: normalizeDecision(map[approvalKey]) };
  }
  if (String(item?.source || '').trim().toLowerCase() === 'protected-bat') {
    return { key: approvalKey, decision: normalizeDecision() };
  }
  const path = normalizeReviewPath(item.path || '');
  if (path && map[path]) {
    return { key: path, decision: normalizeDecision(map[path]) };
  }
  return { key: approvalKey || path, decision: normalizeDecision() };
}

function pushUnique(items, seen, item) {
  const key = `${item.approvalKey || item.path}::${item.source || ''}`;
  if (!item.path || seen.has(key)) {
    return;
  }
  seen.add(key);
  items.push(item);
}

function normalizeChangedFiles(review) {
  return Array.isArray(review?.changedFiles) ? review.changedFiles : [];
}

function normalizeFailingLocations(review) {
  return Array.isArray(review?.failingLocations) ? review.failingLocations : [];
}

function buildApprovalQueue(options = {}) {
  const decisions = options.decisions && typeof options.decisions === 'object' ? options.decisions : {};
  const collectRuntimeApprovalSignals = typeof options.collectRuntimeApprovalSignals === 'function'
    ? options.collectRuntimeApprovalSignals
    : () => [];
  const collectProtectedBatReviewSignals = typeof options.collectProtectedBatReviewSignals === 'function'
    ? options.collectProtectedBatReviewSignals
    : () => [];
  const approvalRequiredPath = typeof options.approvalRequiredPath === 'function'
    ? options.approvalRequiredPath
    : () => true;
  const includeChangedFiles = options.includeChangedFiles !== false;

  const queue = [];
  const seen = new Set();

  const addCandidate = (raw, defaults = {}) => {
    const path = normalizeReviewPath(raw?.path || defaults.path || '');
    if (!path) {
      return;
    }
    const item = {
      path,
      line: Math.max(1, Number(raw?.line || defaults.line || 1)),
      source: String(raw?.source || defaults.source || 'changed-file').trim() || 'changed-file',
      detail: String(raw?.detail || defaults.detail || '').trim(),
      ticket: String(raw?.ticket || defaults.ticket || '').trim(),
      nextAction: String(raw?.nextAction || defaults.nextAction || '').trim(),
      protectedWhy: String(raw?.protectedWhy || defaults.protectedWhy || '').trim(),
    };
    item.approvalKey = buildApprovalDecisionKey(item);
    const resolved = decisionForQueueItem(decisions, item);
    item.approvalKey = resolved.key || item.approvalKey;
    item.status = resolved.decision.status;
    item.note = resolved.decision.note;
    item.updatedAt = resolved.decision.updatedAt;
    if (item.source !== 'protected-bat' && !approvalRequiredPath(item.path)) {
      return;
    }
    if (item.status === 'approved') {
      return;
    }
    pushUnique(queue, seen, item);
  };

  if (includeChangedFiles) {
    for (const changed of normalizeChangedFiles(options.review)) {
      addCandidate(changed, { source: 'changed-file', detail: changed?.status || 'changed file pending review' });
    }
  }

  for (const failing of normalizeFailingLocations(options.review)) {
    addCandidate(failing, { source: 'failing-location', detail: failing?.summary || failing?.detail || 'validation handoff' });
  }

  for (const signal of collectRuntimeApprovalSignals(options.recentRuns || [])) {
    addCandidate(signal, { source: signal?.source || 'runtime-approval' });
  }

  for (const signal of collectProtectedBatReviewSignals(options.workspaceRoot, options.bats || [])) {
    addCandidate(signal, { source: 'protected-bat' });
  }

  queue.sort((left, right) => {
    const sourceRank = (value) => {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized === 'protected-bat') return 0;
      if (normalized === 'runtime-approval') return 1;
      if (normalized === 'patch-review') return 2;
      if (normalized === 'review-summary') return 3;
      if (normalized === 'failing-location') return 4;
      return 5;
    };
    const statusRank = (value) => {
      const normalized = String(value || 'pending').trim().toLowerCase();
      if (normalized === 'pending') return 0;
      if (normalized === 'deferred') return 1;
      if (normalized === 'rejected') return 2;
      return 3;
    };
    return statusRank(left.status) - statusRank(right.status)
      || sourceRank(left.source) - sourceRank(right.source)
      || left.path.localeCompare(right.path)
      || (Number(left.line || 1) - Number(right.line || 1));
  });

  return queue;
}

module.exports = {
  buildApprovalDecisionKey,
  buildApprovalQueue,
};
