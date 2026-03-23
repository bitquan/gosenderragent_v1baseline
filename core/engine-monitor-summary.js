'use strict';

const { parseRunMoment } = require('./run-selection');

function normalizeStatus(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeReviewSummary(summary = {}) {
  return summary && typeof summary === 'object' ? summary : {};
}

function reviewRequiresManual(reviewSummary = {}) {
  const review = normalizeReviewSummary(reviewSummary);
  return review.requiresManualReview === true
    || review.requires_manual_review === true
    || Number(review.pendingApprovalCount ?? review.pending_approval_count ?? 0) > 0;
}

function repairCountForRun(link = {}) {
  const metadata = link?.metadata && typeof link.metadata === 'object' ? link.metadata : {};
  const reviewSummary = normalizeReviewSummary(metadata.reviewSummary);
  const candidates = [
    metadata.repairCount,
    metadata.repairAttempts,
    metadata.repair_attempt_count,
    reviewSummary.repairCount,
    reviewSummary.repair_count,
    reviewSummary.failedStepCount,
    reviewSummary.failed_step_count,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return 0;
}

function roundMetric(value, digits = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
}

function buildLiveEngineMonitorSummary(taskHub = {}) {
  const hub = taskHub && typeof taskHub === 'object' ? taskHub : {};
  const tasks = Array.isArray(hub.tasks) ? hub.tasks : [];
  const runLinks = Array.isArray(hub.runLinks) ? hub.runLinks : [];
  const tasksById = new Map(tasks.map((task) => [String(task?.id || ''), task]));
  const latestRunByTask = new Map();

  for (const link of runLinks) {
    const taskId = String(link?.taskId || '').trim();
    const task = tasksById.get(taskId);
    const taskStatus = normalizeStatus(task?.status || '');
    if (taskStatus === 'archived') {
      continue;
    }
    const dedupeKey = taskId || String(link?.runId || '').trim() || `${normalizeStatus(link?.status)}:${String(link?.summary || link?.label || '').trim()}`;
    const current = latestRunByTask.get(dedupeKey);
    if (!current || parseRunMoment(link) >= parseRunMoment(current)) {
      latestRunByTask.set(dedupeKey, link);
    }
  }

  const liveRuns = Array.from(latestRunByTask.values());

  if (liveRuns.length === 0) {
    return {
      hasLiveData: false,
      total: 0,
      passRate: 0,
      passCount: 0,
      failCount: 0,
      blockedCount: 0,
      skippedCount: 0,
      reviewRequiredCount: 0,
      reviewRequiredRate: 0,
      averageRepairAttempts: 0,
      latestProblemSummary: '',
      latestProblemStatus: '',
      summary: 'No live engine runs yet.',
    };
  }

  const counts = {
    total: liveRuns.length,
    pass: 0,
    fail: 0,
    blocked: 0,
    skipped: 0,
    reviewRequired: 0,
  };
  let repairTotal = 0;
  const problematicRuns = [];

  for (const link of liveRuns) {
    const status = normalizeStatus(link?.status || link?.runtimeState || '');
    const metadata = link?.metadata && typeof link.metadata === 'object' ? link.metadata : {};
    const reviewSummary = normalizeReviewSummary(metadata.reviewSummary);
    if (status === 'pass') {
      counts.pass += 1;
    } else if (status === 'fail') {
      counts.fail += 1;
      problematicRuns.push({
        status,
        summary: String(link?.summary || link?.label || '').trim(),
        updatedAt: parseRunMoment(link),
      });
    } else if (status === 'blocked') {
      counts.blocked += 1;
      problematicRuns.push({
        status,
        summary: String(link?.summary || link?.label || '').trim(),
        updatedAt: parseRunMoment(link),
      });
    } else if (status === 'skipped') {
      counts.skipped += 1;
      problematicRuns.push({
        status,
        summary: String(link?.summary || link?.label || '').trim(),
        updatedAt: parseRunMoment(link),
      });
    }
    if (reviewRequiresManual(reviewSummary)) {
      counts.reviewRequired += 1;
    }
    repairTotal += repairCountForRun(link);
  }

  problematicRuns.sort((left, right) => right.updatedAt - left.updatedAt);
  const latestProblem = problematicRuns[0] || null;
  const passRate = counts.total > 0 ? roundMetric((counts.pass / counts.total) * 100, 0) : 0;
  const reviewRequiredRate = counts.total > 0 ? roundMetric((counts.reviewRequired / counts.total) * 100, 0) : 0;
  const averageRepairAttempts = counts.total > 0 ? roundMetric(repairTotal / counts.total, 2) : 0;

  return {
    hasLiveData: true,
    total: counts.total,
    passRate,
    passCount: counts.pass,
    failCount: counts.fail,
    blockedCount: counts.blocked,
    skippedCount: counts.skipped,
    reviewRequiredCount: counts.reviewRequired,
    reviewRequiredRate,
    averageRepairAttempts,
    latestProblemSummary: latestProblem?.summary || '',
    latestProblemStatus: latestProblem?.status || '',
    summary: `${counts.total} live runs • ${passRate}% pass • ${counts.fail} fail • ${counts.blocked} blocked • ${counts.skipped} skipped • ${reviewRequiredRate}% review required • avg repairs ${averageRepairAttempts}`,
  };
}

module.exports = {
  buildLiveEngineMonitorSummary,
};
