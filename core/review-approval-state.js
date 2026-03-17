'use strict';

const { normalizeReviewPath } = require('./review');

function normalizeDecision(value = {}) {
  return {
    status: String(value.status || 'pending').trim().toLowerCase() || 'pending',
    note: String(value.note || '').trim(),
    updatedAt: String(value.updatedAt || value.updated_at || '').trim(),
  };
}

function isProtectedApprovalKey(key) {
  return String(key || '').startsWith('approval::protected-bat::');
}

function normalizeReviewDecisions(value = {}, options = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const normalized = {};
  const validKeys = new Set(
    Array.isArray(options.queue)
      ? options.queue.map((item) => String(item?.approvalKey || '')).filter(Boolean)
      : [],
  );
  const preservedKeys = new Set(
    Array.isArray(options.preserveKeys)
      ? options.preserveKeys.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
  );
  for (const [rawKey, rawDecision] of Object.entries(input)) {
    const key = isProtectedApprovalKey(rawKey) ? String(rawKey).trim() : normalizeReviewPath(rawKey);
    if (!key) continue;
    if (isProtectedApprovalKey(key) && validKeys.size > 0 && !validKeys.has(key) && !preservedKeys.has(key)) continue;
    normalized[key] = normalizeDecision(rawDecision);
  }
  return normalized;
}

function normalizeReviewSelection(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    path: normalizeReviewPath(input.path || ''),
    approvalKey: String(input.approvalKey || '').trim(),
    line: Math.max(1, Number(input.line || 1)),
    ticket: String(input.ticket || '').trim(),
    source: String(input.source || '').trim(),
    kind: String(input.kind || '').trim(),
    detail: String(input.detail || '').trim(),
  };
}

function decisionForItem(decisions = {}, item = {}) {
  const map = decisions && typeof decisions === 'object' ? decisions : {};
  const approvalKey = String(item.approvalKey || '').trim();
  const path = normalizeReviewPath(item.path || '');
  if (approvalKey && map[approvalKey]) {
    return normalizeDecision(map[approvalKey]);
  }
  if (path && map[path]) {
    return normalizeDecision(map[path]);
  }
  return normalizeDecision();
}

function resolveSaveApproval(decisions = {}, target = {}) {
  const map = decisions && typeof decisions === 'object' ? decisions : {};
  const approvalKey = String(target.approvalKey || '').trim();
  const path = normalizeReviewPath(target.path || '');
  if (approvalKey && map[approvalKey]) {
    return { key: approvalKey, decision: normalizeDecision(map[approvalKey]) };
  }
  if (path && map[path]) {
    return { key: path, decision: normalizeDecision(map[path]) };
  }
  return { key: approvalKey || path, decision: normalizeDecision() };
}

function findApprovalItem(queue = [], target = {}) {
  const items = Array.isArray(queue) ? queue : [];
  const normalized = normalizeReviewSelection(target);
  if (normalized.approvalKey) {
    const byKey = items.find((item) => String(item?.approvalKey || '').trim() === normalized.approvalKey);
    if (byKey) return byKey;
  }
  if (normalized.ticket) {
    const byTicket = items.find((item) => String(item?.ticket || '').trim() === normalized.ticket);
    if (byTicket) return byTicket;
  }
  if (normalized.path) {
    const byPathAndLine = items.find((item) => normalizeReviewPath(item?.path) === normalized.path && Math.max(1, Number(item?.line || 1)) === normalized.line);
    if (byPathAndLine) return byPathAndLine;
    const byPath = items.find((item) => normalizeReviewPath(item?.path) === normalized.path);
    if (byPath) return byPath;
  }
  return null;
}

function applyDecision(decisions = {}, target = {}, status = 'pending', note = '') {
  const normalized = normalizeReviewDecisions(decisions);
  const approvalKey = String(target.approvalKey || '').trim();
  const path = normalizeReviewPath(target.path || '');
  const key = approvalKey || path;
  if (!key) {
    return { decisions: normalized, key: '', decision: normalizeDecision() };
  }
  const decision = normalizeDecision({
    status,
    note,
    updatedAt: new Date().toISOString(),
  });
  normalized[key] = decision;
  return {
    decisions: normalized,
    key,
    decision,
  };
}

module.exports = {
  applyDecision,
  decisionForItem,
  findApprovalItem,
  normalizeReviewDecisions,
  normalizeReviewSelection,
  resolveSaveApproval,
};
