'use strict';

const { buildFollowupRecipe } = require('./followup-recipes');

function clipText(value, maxLength = 180) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}…` : text;
}

function normalizeList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function recommendDocsAction(docsVault = {}) {
  const freshness = String(docsVault.freshnessLabel || '').trim().toLowerCase();
  if (freshness === 'fresh') {
    return 'Use the latest trusted docs during the next bounded revision or review pass.';
  }
  if (freshness === 'aging') {
    return 'Docs are aging. Reuse them carefully and refresh before a docs-led promotion if the surface changed.';
  }
  if (freshness === 'stale') {
    return 'Refresh the trusted docs context before trusting the next docs-led revision or promotion.';
  }
  return docsVault.exists ? 'Review the trusted docs vault before relying on docs-guided changes.' : '';
}

function buildNextSafeActionPrompt(nextItem = {}) {
  const candidate = nextItem.candidate && typeof nextItem.candidate === 'object' ? nextItem.candidate : {};
  const prompt = String(
    candidate.objective
    || candidate.summary
    || nextItem.summary
    || candidate.title
    || nextItem.title
    || ''
  ).trim();
  return prompt ? clipText(prompt, 140) : '';
}

function classifyNextSafeAction(followups = [], context = {}) {
  const nextItem = Array.isArray(followups) && followups.length > 0 ? followups[0] : null;
  const safeMode = context.safeMode && typeof context.safeMode === 'object' ? context.safeMode : {};
  const latestRun = context.latestRun && typeof context.latestRun === 'object' ? context.latestRun : {};
  const reviewer = context.reviewer && typeof context.reviewer === 'object' ? context.reviewer : {};
  if (!nextItem) {
    return {
      exists: false,
      autoQueueEligible: false,
      reason: 'No follow-up action is ready yet.',
      actionLabel: '',
      candidate: null,
    };
  }
  const pendingApprovals = Number(reviewer.pendingApprovalCount || 0) || 0;
  const riskClass = String(nextItem.riskClass || '').trim().toLowerCase();
  const category = String(nextItem.candidate?.category || '').trim().toLowerCase();
  const hardSafeMode = safeMode.active === true || safeMode.controller?.manualSafeMode === true;
  const runState = String(latestRun.state || latestRun.runtimeState || latestRun.status || '').trim().toLowerCase();

  let autoQueueEligible = false;
  let reason = 'Manual review is safer for this next action.';

  if (hardSafeMode) {
    reason = 'Hard safe mode is active, so the next action should stay operator-triggered.';
  } else if (runState === 'running') {
    reason = 'Wait for the active run to finish before queuing another action.';
  } else if (pendingApprovals > 0) {
    reason = 'Pending approvals should be cleared before auto-queueing the next action.';
  } else if (riskClass !== 'low') {
    reason = 'This follow-up is not low-risk enough to auto-queue.';
  } else if (!['docs-refresh', 'docs-scout', 'regression'].includes(category)) {
    reason = 'This follow-up still needs an explicit operator choice.';
  } else {
    autoQueueEligible = true;
    reason = 'Safe to queue automatically as the next supervised low-risk slice.';
  }

  const categoryLabel = category === 'docs-scout'
    ? 'Queue docs scout'
    : category === 'docs-refresh'
      ? 'Queue docs refresh'
      : category === 'regression'
        ? 'Queue regression task'
        : 'Queue next safe action';

  return {
    exists: true,
    title: String(nextItem.title || 'Next safe action').trim(),
    summary: String(nextItem.summary || '').trim(),
    actionLabel: autoQueueEligible ? categoryLabel : (String(nextItem.actionLabel || '').trim() || 'Create task'),
    riskClass,
    kind: String(nextItem.kind || '').trim(),
    category,
    autoQueueEligible,
    reason,
    prompt: buildNextSafeActionPrompt(nextItem),
    candidate: nextItem.candidate && typeof nextItem.candidate === 'object' ? nextItem.candidate : null,
  };
}

function normalizeFollowupCandidate(kind, candidate = {}, context = {}) {
  const docsVault = context.docsVault && typeof context.docsVault === 'object' ? context.docsVault : {};
  const category = String(candidate.category || kind || '').trim().toLowerCase() || kind;
  const source = String(candidate.source || '').trim() || (kind === 'regression' ? 'regression-builder' : 'reviewer');
  const targetPaths = normalizeList(candidate.targetPaths);
  const riskClass = String(
    candidate.riskClass || (kind === 'regression' || category === 'docs-refresh' || category === 'docs-scout' ? 'low' : 'medium'),
  ).trim().toLowerCase() || 'medium';
  const capabilities = normalizeList(candidate.capabilities);
  const acceptanceChecks = normalizeList(candidate.acceptanceChecks);
  const defaultCapabilities = category === 'docs-refresh'
    ? ['research-docs', 'review-verify']
    : category === 'docs-scout'
      ? ['research-docs', 'plan-reasoning']
    : kind === 'regression'
      ? ['review-verify']
      : ['plan-reasoning', 'code-main', 'review-verify'];
  const defaultChecks = category === 'docs-refresh'
    ? [
        'Capture a refreshed approved docs artifact from an allowlisted source.',
        'Summarize whether the refreshed docs change the current implementation or review direction.',
      ]
    : category === 'docs-scout'
      ? [
          'Capture one approved docs artifact from the allowlist for the current slice.',
          'Summarize how the docs should shape the next bounded revision.',
        ]
      : kind === 'regression'
      ? [
          'Add or update lightweight regression coverage for the targeted path.',
          'Summarize what behavior is now protected before promotion.',
        ]
      : [
          'Rerun the smallest relevant validation step for this slice.',
          'Summarize the fix, risk, and next review action before promotion.',
        ];
  const actionLabel = category === 'docs-refresh'
    ? 'Create docs task'
    : category === 'docs-scout'
      ? 'Create docs scout task'
    : kind === 'regression'
      ? 'Create regression task'
      : 'Create revision task';
  return {
    ...candidate,
    kind,
    category,
    source,
    targetPaths,
    riskClass,
    capabilities: capabilities.length > 0 ? capabilities : defaultCapabilities,
    acceptanceChecks: acceptanceChecks.length > 0 ? acceptanceChecks : defaultChecks,
    promotionState: String(candidate.promotionState || (category === 'docs-refresh' ? 'candidate' : '')).trim().toLowerCase(),
    metadata: {
      ...(candidate.metadata && typeof candidate.metadata === 'object' ? candidate.metadata : {}),
      followupKind: kind,
      followupCategory: category,
      docsFreshness: String(docsVault.freshnessLabel || '').trim().toLowerCase(),
    },
    actionLabel,
    priorityHint: candidate.priorityHint === undefined || candidate.priorityHint === null
      ? null
      : (Number.isFinite(Number(candidate.priorityHint)) ? Number(candidate.priorityHint) : null),
  };
}

function buildTestBenchSnapshot(targetWorkspaceRoot, payload = {}) {
  const review = payload.review && typeof payload.review === 'object' ? payload.review : {};
  const reviewer = payload.reviewer && typeof payload.reviewer === 'object' ? payload.reviewer : {};
  const regression = payload.regression && typeof payload.regression === 'object' ? payload.regression : {};
  const docsVault = payload.docsVault && typeof payload.docsVault === 'object' ? payload.docsVault : {};
  const latestRun = payload.latestRun && typeof payload.latestRun === 'object' ? payload.latestRun : {};
  const safeMode = payload.safeMode && typeof payload.safeMode === 'object' ? payload.safeMode : {};
  const changedFiles = Array.isArray(review.changedFiles) ? review.changedFiles : [];
  const failingLocations = Array.isArray(review.failingLocations) ? review.failingLocations : [];
  const artifacts = Array.isArray(review.recentArtifacts) ? review.recentArtifacts : [];
  const preferredPath = String(
    reviewer.notes?.[0]?.path
    || reviewer.revisionCandidates?.[0]?.targetPaths?.[0]
    || regression.candidates?.[0]?.targetPaths?.[0]
    || failingLocations[0]?.path
    || changedFiles[0]?.path
    || ''
  ).trim();
  const status = reviewer.status || (failingLocations.length > 0 ? 'needs-revision' : 'ready');
  const summary = reviewer.summary
    || clipText(latestRun.blockedReason || latestRun.message || latestRun.label || 'Test Bench is ready for review.');
  const reviewerCandidates = Array.isArray(reviewer.revisionCandidates) ? reviewer.revisionCandidates : [];
  const regressionCandidates = Array.isArray(regression.candidates) ? regression.candidates : [];
  const followups = [];
  const seenFollowups = new Set();

  const pushFollowup = (kind, candidate, priority) => {
    const normalizedCandidate = normalizeFollowupCandidate(kind, candidate, { docsVault });
    const id = String(normalizedCandidate?.id || '').trim();
    if (!id || seenFollowups.has(id)) {
      return;
    }
    seenFollowups.add(id);
    const effectivePriority = normalizedCandidate.priorityHint === null
      ? Number(priority || 0)
      : Number(normalizedCandidate.priorityHint || 0);
    followups.push({
      id,
      kind,
      priority: effectivePriority,
      title: String(normalizedCandidate?.title || '').trim() || (kind === 'revision' ? 'Revision task' : 'Regression task'),
      summary: clipText(normalizedCandidate?.summary || normalizedCandidate?.objective || ''),
      targetPath: String(normalizedCandidate?.targetPaths?.[0] || '').trim(),
      source: String(normalizedCandidate?.source || '').trim(),
      riskClass: String(normalizedCandidate?.riskClass || (kind === 'regression' ? 'low' : 'medium')).trim(),
      actionLabel: String(normalizedCandidate?.actionLabel || '').trim(),
      candidate: normalizedCandidate,
    });
  };

  reviewerCandidates.forEach((candidate, index) => {
    pushFollowup('revision', candidate, 100 - index);
  });
  regressionCandidates.forEach((candidate, index) => {
    pushFollowup('regression', candidate, 70 - index);
  });
  const hasDocsRefreshCandidate = reviewerCandidates.some((candidate) => String(candidate?.category || '').trim().toLowerCase() === 'docs-refresh');
  if (!hasDocsRefreshCandidate && docsVault.exists && String(docsVault.freshnessLabel || '').trim().toLowerCase() === 'stale') {
    pushFollowup('revision', {
      id: `docs-refresh:${String(docsVault.latest?.domain || targetWorkspaceRoot || 'docs').trim().toLowerCase() || 'docs'}`,
      category: 'docs-refresh',
      title: 'Refresh trusted docs context',
      objective: `Refresh the trusted docs context${docsVault.latest?.domain ? ` from ${String(docsVault.latest.domain)}` : ''} before trusting the next docs-led revision or promotion.`,
      summary: 'The docs vault is stale. Refresh it before relying on docs-guided changes.',
      targetPaths: preferredPath ? [preferredPath] : [],
      riskClass: 'low',
      source: 'trusted-docs-vault',
      priorityHint: reviewerCandidates.length > 0 ? 96 : 60,
    }, 60);
  }
  followups.sort((left, right) => {
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }
    return String(left.title || '').localeCompare(String(right.title || ''));
  });
  const nextSafeAction = classifyNextSafeAction(followups, {
    safeMode,
    latestRun,
    reviewer,
  });
  const safeRecipe = buildFollowupRecipe({
    followups,
    nextSafeAction,
    docsContext: docsVault,
  }, {
    safeMode,
    latestRun,
    reviewer,
    regression,
  });

  return {
    ok: true,
    status,
    summary,
    targetWorkspaceRoot: String(targetWorkspaceRoot || '').trim(),
    preferredPath,
    changedFiles: changedFiles.slice(0, 12),
    failingLocations: failingLocations.slice(0, 8),
    recentArtifacts: artifacts.slice(0, 10),
    followups: followups.slice(0, 8),
    nextSafeAction,
    safeRecipe,
    docsContext: docsVault.exists
      ? {
          exists: true,
          summary: String(docsVault.summary || '').trim(),
          freshnessLabel: String(docsVault.freshnessLabel || '').trim(),
          recommendedAction: String(docsVault.recommendedAction || recommendDocsAction(docsVault) || '').trim(),
          count: Number(docsVault.count || 0),
          latest: docsVault.latest && typeof docsVault.latest === 'object' ? docsVault.latest : {},
          domains: Array.isArray(docsVault.domains) ? docsVault.domains.slice(0, 4) : [],
          recommendedSources: Array.isArray(docsVault.recommendedSources) ? docsVault.recommendedSources.slice(0, 4) : [],
        }
      : { exists: false, summary: '', freshnessLabel: 'idle', recommendedAction: '', count: 0, latest: {}, domains: [], recommendedSources: [] },
    reviewer,
    regression,
    latestRun: latestRun || {},
  };
}

module.exports = {
  buildTestBenchSnapshot,
};
