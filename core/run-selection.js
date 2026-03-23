'use strict';

function parseRunMoment(run = {}) {
  const value = run?.updatedAt
    || run?.endedAt
    || run?.finishedAt
    || run?.completedAt
    || run?.startedAt
    || run?.createdAt
    || run?.updated_at
    || run?.ended_at
    || run?.finished_at
    || run?.completed_at
    || run?.started_at
    || run?.created_at
    || '';
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildRunIdentity(run = {}) {
  const runId = String(run?.runId || run?.run_id || '').trim();
  if (runId) {
    return `run:${runId}`;
  }
  const taskId = String(run?.taskId || run?.task_id || '').trim();
  const ticket = String(run?.ticket || '').trim();
  const label = String(run?.label || run?.title || run?.task || '').trim();
  const startedAt = String(run?.startedAt || run?.started_at || '').trim();
  return `task:${taskId || '?'}::ticket:${ticket || '?'}::label:${label || '?'}::started:${startedAt || '?'}`;
}

function mergeRecentRuns(...collections) {
  const merged = [];
  const seen = new Set();
  for (const collection of collections) {
    const items = Array.isArray(collection) ? collection : [];
    for (const run of items) {
      if (!run || typeof run !== 'object') {
        continue;
      }
      const identity = buildRunIdentity(run);
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      merged.push(run);
    }
  }
  merged.sort((left, right) => parseRunMoment(right) - parseRunMoment(left));
  return merged;
}

function selectFreshestRun(...collections) {
  return mergeRecentRuns(...collections)[0] || null;
}

module.exports = {
  mergeRecentRuns,
  parseRunMoment,
  selectFreshestRun,
};
