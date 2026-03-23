'use strict';

const path = require('path');
const { recommendApprovedDocumentationSources } = require('../desktop-learning-records');

function clipText(value, maxLength = 180) {
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

function normalizeApprovalQueue(queue) {
  return Array.isArray(queue) ? queue : [];
}

function basenameLabel(value) {
  const normalized = String(value || '').trim();
  return normalized ? path.basename(normalized) : '';
}

function buildCandidateId(prefix, value = '') {
  return `${prefix}:${String(value || '').trim().toLowerCase() || 'item'}`;
}

function looksInfrastructureFailure(...values) {
  const haystack = values.map((value) => String(value || '').trim()).filter(Boolean).join(' \n').toLowerCase();
  if (!haystack) {
    return false;
  }
  return /could not start the python runtime|spawn .*py\.exe enonent|ticket id is required|invalid ticket id|runtime launch failed|python runtime is not available/.test(haystack);
}

function looksDocsSensitiveReviewContext(targetPath = '', detail = '') {
  const haystack = `${String(targetPath || '')} ${String(detail || '')}`.toLowerCase();
  return /(config|settings|setup|install|runtime|extension|vscode|electron|python|schema|migration|api|provider|model|autonomy|learning|training)/.test(haystack);
}

function buildReviewerSummary(targetWorkspaceRoot, payload = {}) {
  const review = payload.review && typeof payload.review === 'object' ? payload.review : {};
  const latestRun = payload.latestRun && typeof payload.latestRun === 'object' ? payload.latestRun : {};
  const approvalQueue = normalizeApprovalQueue(payload.approvalQueue);
  const approvedDocReference = payload.approvedDocReference && typeof payload.approvedDocReference === 'object'
    ? payload.approvedDocReference
    : {};
  const approvedDocsVault = payload.approvedDocsVault && typeof payload.approvedDocsVault === 'object'
    ? payload.approvedDocsVault
    : {};
  const operatorSupervision = payload.operatorSupervision && typeof payload.operatorSupervision === 'object'
    ? payload.operatorSupervision
    : {};
  const acceptance = payload.acceptance && typeof payload.acceptance === 'object'
    ? (payload.acceptance.report && typeof payload.acceptance.report === 'object' ? payload.acceptance.report : payload.acceptance)
    : {};

  const changedFiles = normalizeChangedFiles(review);
  const failingLocations = normalizeFailingLocations(review);
  const pendingApprovals = approvalQueue.filter((item) => String(item?.status || 'pending').trim().toLowerCase() === 'pending');
  const rejectedApprovals = approvalQueue.filter((item) => String(item?.status || '').trim().toLowerCase() === 'rejected');
  const deferredApprovals = approvalQueue.filter((item) => String(item?.status || '').trim().toLowerCase() === 'deferred');
  const reviewArtifacts = Array.isArray(review.recentArtifacts) ? review.recentArtifacts : [];
  const firstContextPath = String(
    failingLocations[0]?.path
    || rejectedApprovals[0]?.path
    || deferredApprovals[0]?.path
    || pendingApprovals[0]?.path
    || changedFiles[0]?.path
    || ''
  ).trim();
  const docsSensitiveContext = looksDocsSensitiveReviewContext(
    firstContextPath,
    [
      latestRun.label,
      latestRun.message,
      latestRun.blockedReason,
      failingLocations[0]?.message,
      rejectedApprovals[0]?.nextAction,
      deferredApprovals[0]?.nextAction,
    ].filter(Boolean).join(' • '),
  );
  const docsRecommendations = recommendApprovedDocumentationSources({
    targetPath: firstContextPath,
    title: latestRun.label,
    objective: latestRun.blockedReason || latestRun.message,
    summary: failingLocations[0]?.message || rejectedApprovals[0]?.nextAction || deferredApprovals[0]?.nextAction,
    category: docsSensitiveContext ? 'docs-sensitive-review' : '',
  });
  const notes = [];
  const revisionCandidates = [];
  let status = 'ready';
  let summary = 'Reviewer sees no immediate blockers.';
  let nextAction = 'Keep working or open Test Bench for a manual spot check.';

  const pushCandidate = (candidate) => {
    const id = String(candidate?.id || '').trim();
    if (!id || revisionCandidates.some((item) => item.id === id)) {
      return;
    }
    revisionCandidates.push(candidate);
  };

  if (String(latestRun.state || latestRun.runtimeState || latestRun.status || '').trim().toLowerCase() === 'fail') {
    const latestFailureDetail = latestRun.blockedReason || latestRun.stderrTail || latestRun.message || latestRun.label || latestRun.runtimeLabel || 'The latest run failed validation.';
    const latestFailureLooksInfra = looksInfrastructureFailure(
      latestFailureDetail,
      latestRun.stdoutTail,
      latestRun.logTail,
    );
    if (latestFailureLooksInfra) {
      notes.push({
        level: 'warn',
        title: 'Engine launch issue',
        detail: clipText(latestFailureDetail),
        path: '',
      });
      if (status === 'ready') {
        summary = 'Reviewer is clear; the latest blocker is an engine launch issue, not a code-review failure.';
        nextAction = 'Repair the engine/runtime startup path or rerun the task from a healthy runtime before asking for another revision pass.';
      }
    } else {
      status = 'needs-revision';
      summary = 'Reviewer found a failed run that should be repaired before approval.';
      nextAction = 'Create a revision task and repair the failing validation path first.';
      notes.push({
        level: 'critical',
        title: 'Latest run failed',
        detail: clipText(latestFailureDetail),
        path: String(failingLocations[0]?.path || ''),
      });
      const firstFailure = failingLocations[0] || {};
      pushCandidate({
        id: buildCandidateId('repair-failed-run', firstFailure.path || latestRun.runId || latestRun.id || latestRun.label),
        kind: 'revision',
        title: `Repair ${basenameLabel(firstFailure.path) || 'the latest failed run'}`,
        objective: clipText(firstFailure.message || latestRun.blockedReason || 'Repair the latest failed validation path and rerun the relevant checks.', 140),
        summary: 'Reviewer detected a failing run and wants a bounded repair task before promotion.',
        targetPaths: firstFailure.path ? [String(firstFailure.path)] : [],
        riskClass: 'medium',
        source: 'reviewer',
      });
    }
  }

  if (failingLocations.length > 0) {
    if (status === 'ready') {
      status = 'needs-revision';
      summary = 'Reviewer found failing validation locations that need a revision pass.';
      nextAction = 'Open the failing file in Test Bench and create a revision task.';
    }
    const firstFailure = failingLocations[0] || {};
    notes.push({
      level: 'warn',
      title: 'Validation findings',
      detail: clipText(`${failingLocations.length} failing location(s) need a fix.${firstFailure.message ? ` First signal: ${firstFailure.message}` : ''}`),
      path: String(firstFailure.path || ''),
    });
    pushCandidate({
      id: buildCandidateId('repair-validation', firstFailure.path || firstFailure.message || 'validation'),
      kind: 'revision',
      category: 'validation-repair',
      title: `Repair ${basenameLabel(firstFailure.path) || 'the failing validation path'}`,
      objective: clipText(firstFailure.message || 'Repair the failing validation path and rerun the smallest relevant check.', 140),
      summary: 'Reviewer wants the next bounded repair slice to clear the current validation signal.',
      targetPaths: firstFailure.path ? [String(firstFailure.path)] : [],
      riskClass: 'medium',
      capabilities: ['code-main', 'repair-fast', 'review-verify'],
      acceptanceChecks: [
        'Rerun the smallest relevant validation command after the repair.',
        'Summarize the fix and any remaining review risk before promotion.',
      ],
      source: 'reviewer-validation',
    });
  }

  if (rejectedApprovals.length > 0 || deferredApprovals.length > 0) {
    if (status === 'ready') {
      status = 'needs-revision';
      summary = 'Reviewer is holding changes that were rejected or deferred.';
      nextAction = 'Create a revision task for the held files before trying to promote them.';
    }
    const firstHeld = rejectedApprovals[0] || deferredApprovals[0] || {};
    notes.push({
      level: rejectedApprovals.length > 0 ? 'critical' : 'warn',
      title: rejectedApprovals.length > 0 ? 'Rejected review items' : 'Deferred review items',
      detail: clipText(`${rejectedApprovals.length} rejected • ${deferredApprovals.length} deferred. Resolve review feedback before approval.`),
      path: String(firstHeld.path || ''),
    });
    pushCandidate({
      id: buildCandidateId('review-revision', firstHeld.path || 'review'),
      kind: 'revision',
      title: `Revise ${basenameLabel(firstHeld.path) || 'the held review items'}`,
      objective: clipText(firstHeld.nextAction || 'Revise the rejected or deferred review changes and resubmit them with a clearer fix.'),
      summary: 'Reviewer wants a revision pass on review-held files.',
      targetPaths: firstHeld.path ? [String(firstHeld.path)] : [],
      riskClass: 'medium',
      source: 'reviewer',
    });
  }

  if (pendingApprovals.length > 0 && status === 'ready') {
    status = 'needs-review';
    summary = 'Reviewer is waiting on manual approvals.';
    nextAction = 'Open Test Bench or the file inspector and clear the pending approvals.';
    const firstPending = pendingApprovals[0] || {};
    notes.push({
      level: 'info',
      title: 'Pending approvals',
      detail: clipText(`${pendingApprovals.length} approval item(s) are waiting. Review the first protected or low-confidence change next.`),
      path: String(firstPending.path || ''),
    });
  }

  if (changedFiles.length > 0 && notes.length === 0) {
    notes.push({
      level: 'info',
      title: 'Changed files ready for review',
      detail: clipText(`${changedFiles.length} changed file(s) are available for a Test Bench pass.`),
      path: String(changedFiles[0]?.path || ''),
    });
  }

  const recentOperatorFeedback = Array.isArray(operatorSupervision.recent) ? operatorSupervision.recent : [];
  const latestNeedsChanges = recentOperatorFeedback.find((item) => String(item?.verdict || '').trim().toLowerCase() === 'needs-changes') || null;
  if (latestNeedsChanges) {
    if (status === 'ready') {
      status = 'needs-revision';
      summary = 'Reviewer is following the latest operator needs-changes note.';
      nextAction = 'Create a bounded revision task from the latest operator supervision and rerun the smallest relevant checks.';
    }
    notes.push({
      level: 'warn',
      title: 'Latest operator needs-changes note',
      detail: clipText(String(latestNeedsChanges.note || latestNeedsChanges.summary || 'Operator requested another revision pass.')),
      path: String(latestNeedsChanges.path || ''),
    });
    pushCandidate({
      id: buildCandidateId('operator-revision', latestNeedsChanges.path || latestNeedsChanges.recordedAt || 'operator'),
      kind: 'revision',
      category: 'operator-feedback',
      title: `Revise ${basenameLabel(latestNeedsChanges.path) || 'the latest Test Bench change'}`,
      objective: clipText(String(latestNeedsChanges.note || 'Follow the latest operator needs-changes guidance and rerun the relevant validation.')),
      summary: 'Operator supervision requested another revision pass from Test Bench.',
      targetPaths: latestNeedsChanges.path ? [String(latestNeedsChanges.path)] : [],
      riskClass: 'medium',
      source: 'operator-feedback',
    });
  }

  if (!approvedDocReference.exists && !approvedDocsVault.exists && docsSensitiveContext) {
    const topDoc = docsRecommendations[0] || null;
    notes.push({
      level: 'info',
      title: 'Trusted docs are missing',
      detail: clipText(`This review context looks docs-sensitive, but the trusted docs vault is empty.${topDoc ? ` Start with ${topDoc.label} (${topDoc.domain}).` : ' Scout a trusted source before relying on docs-led changes.'}`),
      path: firstContextPath,
    });
    pushCandidate({
      id: buildCandidateId('docs-scout', firstContextPath || latestRun.label || 'docs'),
      kind: 'revision',
      category: 'docs-scout',
      title: `Scout trusted docs for ${basenameLabel(firstContextPath) || 'the current slice'}`,
      objective: clipText(`Capture a trusted docs source${topDoc ? ` from ${topDoc.label} (${topDoc.domain})` : ''} for the current slice, then compare the implementation against that guidance before approval.`),
      summary: 'Reviewer wants a trusted docs source before the next docs-sensitive revision or promotion.',
      targetPaths: firstContextPath ? [firstContextPath] : [],
      riskClass: 'low',
      capabilities: ['research-docs', 'review-verify'],
      acceptanceChecks: [
        'Capture one approved docs artifact from the allowlist for the current slice.',
        'Summarize how the docs should change the next bounded revision or review decision.',
      ],
      promotionState: 'candidate',
      source: 'trusted-docs-vault',
      metadata: {
        docsFreshness: 'missing',
        recommendedSources: docsRecommendations,
      },
    });
  }

  if (approvedDocReference.exists || approvedDocsVault.exists) {
    const docsLatest = approvedDocsVault.latest && typeof approvedDocsVault.latest === 'object'
      ? approvedDocsVault.latest
      : approvedDocReference;
    const docsSummary = String(
      approvedDocsVault.summary
      || approvedDocReference.summary
      || 'Documentation guidance is available for review.'
    ).trim();
    notes.push({
      level: 'info',
      title: 'Trusted docs vault',
      detail: clipText(`${docsLatest.domain || 'trusted docs'} • ${docsSummary}${approvedDocsVault.recommendedAction ? ` • ${approvedDocsVault.recommendedAction}` : ''}`),
      path: '',
    });
    if (String(approvedDocsVault.freshnessLabel || '').trim().toLowerCase() === 'aging') {
      notes.push({
        level: 'warn',
        title: 'Trusted docs context is aging',
        detail: clipText('The latest trusted docs are aging. Reuse them carefully and refresh them before a docs-led promotion if the surface changed.'),
        path: '',
      });
    }
    if (String(approvedDocsVault.freshnessLabel || '').trim().toLowerCase() === 'stale') {
      notes.push({
        level: 'warn',
        title: 'Trusted docs context is stale',
        detail: clipText('The latest approved docs context is stale. Refresh docs guidance before trusting a final docs-led promotion.'),
        path: '',
      });
      const docsRefreshPath = String(
        failingLocations[0]?.path
        || rejectedApprovals[0]?.path
        || deferredApprovals[0]?.path
        || changedFiles[0]?.path
        || ''
      ).trim();
      pushCandidate({
        id: buildCandidateId('refresh-docs', docsRefreshPath || docsLatest.domain || 'docs'),
        kind: 'revision',
        category: 'docs-refresh',
        title: `Refresh trusted docs for ${basenameLabel(docsRefreshPath) || 'the current slice'}`,
        objective: clipText(`Refresh the trusted docs context from ${docsLatest.domain || 'the approved docs vault'} and compare it against the current change before approval.`),
        summary: 'Docs vault is stale. Refresh approved docs guidance before trusting the next docs-led revision or promotion.',
        targetPaths: docsRefreshPath ? [docsRefreshPath] : [],
        riskClass: 'low',
        capabilities: ['research-docs', 'review-verify'],
        acceptanceChecks: [
          'Capture a refreshed approved docs artifact from an allowlisted source.',
          'Summarize whether the refreshed docs change the current implementation or review decision.',
        ],
        promotionState: 'candidate',
        source: 'trusted-docs-vault',
        metadata: {
          docsDomain: String(docsLatest.domain || '').trim(),
          docsFreshness: String(approvedDocsVault.freshnessLabel || '').trim().toLowerCase(),
          recommendedSources: docsRecommendations,
        },
      });
    }
    if ((status === 'needs-review' || status === 'needs-revision') && (failingLocations.length > 0 || rejectedApprovals.length > 0 || deferredApprovals.length > 0)) {
      const firstDocsPath = String(
        failingLocations[0]?.path
        || rejectedApprovals[0]?.path
        || deferredApprovals[0]?.path
        || changedFiles[0]?.path
        || ''
      ).trim();
      notes.push({
        level: 'info',
        title: 'Docs-aware revision suggestion',
        detail: clipText(`Use ${docsLatest.domain || 'trusted docs'}${docsLatest.title ? ` • ${docsLatest.title}` : ''} while revising the current change.`),
        path: firstDocsPath,
      });
      pushCandidate({
        id: buildCandidateId('reviewer-docs', firstDocsPath || docsLatest.domain || 'docs'),
        kind: 'revision',
        category: 'docs-guided',
        title: `Revise ${basenameLabel(firstDocsPath) || 'the current change'} with trusted docs`,
        objective: clipText(`Use ${docsLatest.domain || 'trusted docs'}${docsLatest.title ? ` (${docsLatest.title})` : ''} to revise the current change and align it with the documented setup.`),
        summary: `Reviewer wants the next revision to follow the latest trusted docs signal before approval.${approvedDocsVault.freshnessLabel ? ` Docs vault is ${approvedDocsVault.freshnessLabel}.` : ''}`,
        targetPaths: firstDocsPath ? [firstDocsPath] : [],
        riskClass: 'medium',
        capabilities: ['research-docs', 'code-main', 'review-verify'],
        acceptanceChecks: [
          'Revise the current slice to match the trusted docs guidance.',
          'Summarize the docs alignment and any remaining review risk before promotion.',
        ],
        metadata: {
          docsDomain: String(docsLatest.domain || '').trim(),
          docsProvider: String(docsLatest.provider || '').trim(),
          docsCategory: String(docsLatest.category || '').trim(),
          docsFreshness: String(approvedDocsVault.freshnessLabel || '').trim().toLowerCase(),
          recommendedSources: docsRecommendations,
        },
        source: 'reviewer-docs',
      });
    }
  }

  if (String(acceptance.overallStatus || '').trim().toLowerCase() === 'warn') {
    notes.push({
      level: 'warn',
      title: 'Acceptance warnings remain',
      detail: clipText(acceptance.summary || acceptance.nextAction || 'Acceptance still wants operator review before promotion.'),
      path: '',
    });
  }

  return {
    ok: true,
    status,
    summary,
    nextAction,
    changedFileCount: changedFiles.length,
    failingLocationCount: failingLocations.length,
    pendingApprovalCount: pendingApprovals.length,
    rejectedApprovalCount: rejectedApprovals.length,
    deferredApprovalCount: deferredApprovals.length,
    recentArtifactCount: reviewArtifacts.length,
    notes: notes.slice(0, 6),
    revisionCandidates: revisionCandidates.slice(0, 4),
    targetWorkspaceRoot: String(targetWorkspaceRoot || '').trim(),
  };
}

module.exports = {
  buildReviewerSummary,
};
