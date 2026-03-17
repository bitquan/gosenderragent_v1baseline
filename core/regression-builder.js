'use strict';

const path = require('path');

function clipText(value, maxLength = 160) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}…` : text;
}

function normalizeChangedFiles(review = {}) {
  return Array.isArray(review.changedFiles) ? review.changedFiles : [];
}

function normalizeFailingLocations(review = {}) {
  return Array.isArray(review.failingLocations) ? review.failingLocations : [];
}

function isTestPath(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\./.test(normalized);
}

function basenameLabel(value) {
  const normalized = String(value || '').trim();
  return normalized ? path.basename(normalized) : '';
}

function buildCandidateId(prefix, value = '') {
  return `${prefix}:${String(value || '').trim().toLowerCase() || 'item'}`;
}

function buildRegressionCandidates(targetWorkspaceRoot, payload = {}) {
  const review = payload.review && typeof payload.review === 'object' ? payload.review : {};
  const latestRun = payload.latestRun && typeof payload.latestRun === 'object' ? payload.latestRun : {};
  const approvalQueue = Array.isArray(payload.approvalQueue) ? payload.approvalQueue : [];
  const operatorSupervision = payload.operatorSupervision && typeof payload.operatorSupervision === 'object'
    ? payload.operatorSupervision
    : {};
  const changedFiles = normalizeChangedFiles(review);
  const failingLocations = normalizeFailingLocations(review);
  const candidates = [];

  const pushCandidate = (candidate) => {
    const id = String(candidate?.id || '').trim();
    if (!id || candidates.some((item) => item.id === id)) {
      return;
    }
    candidates.push(candidate);
  };

  if (failingLocations.length > 0) {
    const firstFailure = failingLocations[0] || {};
    pushCandidate({
      id: buildCandidateId('validation-regression', firstFailure.path || latestRun.runId || latestRun.id || 'validation'),
      kind: 'regression',
      category: 'validation',
      title: `Add regression coverage for ${basenameLabel(firstFailure.path) || 'the failing path'}`,
      objective: clipText(firstFailure.message || 'Create a focused regression test that catches the latest failing validation path.'),
      summary: 'The latest failing location should become a replayable regression scenario.',
      targetPaths: firstFailure.path ? [String(firstFailure.path)] : [],
      source: 'regression-builder',
    });
  }

  const rejectedOrDeferred = approvalQueue.filter((item) => ['rejected', 'deferred'].includes(String(item?.status || '').trim().toLowerCase()));
  if (rejectedOrDeferred.length > 0) {
    const firstHeld = rejectedOrDeferred[0] || {};
    pushCandidate({
      id: buildCandidateId('review-regression', firstHeld.path || 'review'),
      kind: 'regression',
      category: 'review-feedback',
      title: `Capture review regression for ${basenameLabel(firstHeld.path) || 'the held change'}`,
      objective: clipText(firstHeld.nextAction || 'Turn the rejected or deferred review feedback into a repeatable regression scenario or test.'),
      summary: 'Review feedback should become a reusable scenario so the same miss is less likely to return.',
      targetPaths: firstHeld.path ? [String(firstHeld.path)] : [],
      source: 'regression-builder',
    });
  }

  const recentOperatorFeedback = Array.isArray(operatorSupervision.recent) ? operatorSupervision.recent : [];
  const recentNeedsChanges = recentOperatorFeedback.find((item) => String(item?.verdict || '').trim().toLowerCase() === 'needs-changes') || null;
  if (recentNeedsChanges) {
    pushCandidate({
      id: buildCandidateId('operator-feedback-regression', recentNeedsChanges.path || recentNeedsChanges.recordedAt || 'operator'),
      kind: 'regression',
      category: 'operator-feedback',
      title: `Capture operator feedback for ${basenameLabel(recentNeedsChanges.path) || 'the latest revision loop'}`,
      objective: clipText(String(recentNeedsChanges.note || 'Turn the latest operator needs-changes note into a replayable regression scenario or validation check.')),
      summary: 'Operator needs-changes feedback should become replayable coverage so the same miss is less likely to return.',
      targetPaths: recentNeedsChanges.path ? [String(recentNeedsChanges.path)] : [],
      source: 'regression-builder-operator',
    });
  }

  const recentApproval = recentOperatorFeedback.find((item) => String(item?.verdict || '').trim().toLowerCase() === 'approved') || null;
  if (recentApproval && recentApproval.path && !isTestPath(recentApproval.path)) {
    pushCandidate({
      id: buildCandidateId('approved-behavior-regression', recentApproval.path),
      kind: 'regression',
      category: 'approved-behavior',
      title: `Lock approved behavior for ${basenameLabel(recentApproval.path) || 'the latest approved change'}`,
      objective: clipText(String(recentApproval.note || 'Capture the latest approved behavior with lightweight regression coverage.')),
      summary: 'Approved operator supervision should become a replayable regression check when practical.',
      targetPaths: [String(recentApproval.path)],
      source: 'regression-builder-operator',
    });
  }

  const changedPaths = changedFiles.map((item) => String(item?.path || item || '').trim()).filter(Boolean);
  const codePaths = changedPaths.filter((item) => !isTestPath(item));
  const testPaths = changedPaths.filter((item) => isTestPath(item));
  if (codePaths.length > 0 && testPaths.length === 0) {
    pushCandidate({
      id: buildCandidateId('coverage-gap', codePaths[0]),
      kind: 'regression',
      category: 'coverage-gap',
      title: `Add coverage for ${basenameLabel(codePaths[0]) || 'the latest code change'}`,
      objective: 'Create or update a regression test for the latest code-only change before promotion.',
      summary: 'Code changed without an obvious nearby test update. Add lightweight coverage before promoting live.',
      targetPaths: [codePaths[0]],
      source: 'regression-builder',
    });
  }

  const summary = candidates.length > 0
    ? `${candidates.length} regression candidate${candidates.length === 1 ? '' : 's'} ready`
    : 'No fresh regression candidates yet.';

  return {
    ok: true,
    summary,
    candidateCount: candidates.length,
    candidates: candidates.slice(0, 6),
    targetWorkspaceRoot: String(targetWorkspaceRoot || '').trim(),
  };
}

module.exports = {
  buildRegressionCandidates,
};
