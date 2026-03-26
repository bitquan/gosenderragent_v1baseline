'use strict';

const fs = require('fs');
const path = require('path');

const { getConfiguredAssistantBenchmarkRoot } = require('./assistant-paths');
const { ensureDirectory, readJsonFile, writeJsonFileAtomic } = require('./utils');

const LATEST_REPORT_FILE = 'latest.json';
const SMOKE_CHECK_IDS = new Set(['smoke', 'smoke-ui', 'self-host-smoke']);
const LOCAL_PROVIDER_SOURCES = new Set(['huggingface-local', 'lmstudio', 'local', 'ollama']);

function normalizeWorkspacePath(value) {
  return String(value || '').trim().replace(/\\/g, '/').toLowerCase();
}

function collectAcceptanceWorkspaceRoots(report = {}) {
  const autonomyProof = report?.autonomyProof && typeof report.autonomyProof === 'object' ? report.autonomyProof : {};
  const selfImprovementProof = report?.selfImprovementProof && typeof report.selfImprovementProof === 'object'
    ? report.selfImprovementProof
    : {};
  const builderProof = report?.builderProof && typeof report.builderProof === 'object'
    ? report.builderProof
    : {};
  const labs = report?.labs && typeof report.labs === 'object' ? report.labs : {};
  const labEntries = Object.values(labs).filter((entry) => entry && typeof entry === 'object');
  return Array.from(new Set([
    report?.workspaceRoot,
    report?.targetWorkspaceRoot,
    report?.selfHostSourceRoot,
    autonomyProof?.workspaceRoot,
    selfImprovementProof?.workspaceRoot,
    builderProof?.workspaceRoot,
    ...labEntries.flatMap((entry) => [
      entry?.workspaceRoot,
      entry?.sourceRoot,
      entry?.labRoot,
    ]),
  ].map((item) => normalizeWorkspacePath(item)).filter(Boolean)));
}

function reportMatchesWorkspace(report = {}, workspaceRoot = '') {
  const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    return true;
  }
  const roots = collectAcceptanceWorkspaceRoots(report);
  if (roots.length === 0) {
    return false;
  }
  return roots.includes(normalizedWorkspaceRoot);
}

function slugify(value, fallback = 'acceptance') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function acceptanceRoot(workspaceRoot) {
  const benchmarkRoot = getConfiguredAssistantBenchmarkRoot(workspaceRoot);
  if (!benchmarkRoot) {
    throw new Error('assistant_benchmark_root is not configured. Set assistant_artifacts_root or assistant_benchmark_root before running the engine acceptance suite.');
  }
  const root = path.join(benchmarkRoot, 'acceptance');
  ensureDirectory(root);
  return root;
}

function reportFileName(label = 'engine-acceptance') {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${slugify(label, 'engine-acceptance')}.json`;
}

function acceptanceStateWithControlSummary(payload = {}) {
  return {
    ...payload,
    controlSummary: buildAcceptanceControlSummary(payload.report, payload),
  };
}

function writeAcceptanceReport(workspaceRoot, report) {
  const root = acceptanceRoot(workspaceRoot);
  const safeReport = {
    workspaceRoot: String(report?.workspaceRoot || workspaceRoot || '').trim(),
    targetWorkspaceRoot: String(report?.targetWorkspaceRoot || report?.workspaceRoot || workspaceRoot || '').trim(),
    ...report,
  };
  const outputPath = path.join(root, reportFileName(safeReport.runId || safeReport.label || 'engine-acceptance'));
  const latestPath = path.join(root, LATEST_REPORT_FILE);
  writeJsonFileAtomic(outputPath, safeReport);
  writeJsonFileAtomic(latestPath, safeReport);
  return {
    root,
    outputPath,
    latestPath,
  };
}

function readLatestAcceptanceReport(workspaceRoot) {
  const benchmarkRoot = getConfiguredAssistantBenchmarkRoot(workspaceRoot);
  if (!benchmarkRoot) {
    return acceptanceStateWithControlSummary({
      ok: true,
      exists: false,
      root: '',
      outputPath: '',
      report: null,
    });
  }
  const root = path.join(benchmarkRoot, 'acceptance');
  if (!fs.existsSync(root)) {
    return acceptanceStateWithControlSummary({
      ok: true,
      exists: false,
      root,
      outputPath: '',
      report: null,
    });
  }
  const latestPath = path.join(root, LATEST_REPORT_FILE);
  if (fs.existsSync(latestPath)) {
    const latestReport = readJsonFile(latestPath, null);
    if (reportMatchesWorkspace(latestReport, workspaceRoot)) {
      return acceptanceStateWithControlSummary({
        ok: true,
        exists: true,
        root,
        outputPath: latestPath,
        report: latestReport,
      });
    }
  }
  const candidates = fs.readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse();
  const first = candidates
    .map((name) => ({
      name,
      outputPath: path.join(root, name),
      report: readJsonFile(path.join(root, name), null),
    }))
    .find((entry) => reportMatchesWorkspace(entry.report, workspaceRoot));
  if (!first) {
    return acceptanceStateWithControlSummary({
      ok: true,
      exists: false,
      root,
      outputPath: '',
      report: null,
    });
  }
  return acceptanceStateWithControlSummary({
    ok: true,
    exists: true,
    root,
    outputPath: first.outputPath,
    report: first.report,
  });
}

function normalizeCheckStatus(check = {}) {
  const status = String(check.status || '').trim().toLowerCase();
  return ['pass', 'warn', 'fail'].includes(status) ? status : 'warn';
}

function isSmokeCheck(check = {}) {
  const id = String(check.id || check.label || '').trim().toLowerCase();
  return SMOKE_CHECK_IDS.has(id);
}

function formatStatusLabel(status, fallback = 'UNKNOWN') {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'pass') {
    return 'PASS';
  }
  if (normalized === 'warn') {
    return 'WARN';
  }
  if (normalized === 'fail') {
    return 'FAIL';
  }
  if (normalized === 'ready') {
    return 'READY';
  }
  if (normalized === 'caution') {
    return 'CAUTION';
  }
  if (normalized === 'blocked') {
    return 'BLOCKED';
  }
  return fallback;
}

function buildSmokeSummary(smokeChecks = []) {
  if (!smokeChecks.length) {
    return {
      smokeChecks: [],
      smokeStatus: 'missing',
      smokeLabel: 'NOT RUN',
      smokeSummary: 'The latest acceptance report does not include a recorded smoke result.',
    };
  }
  const counts = smokeChecks.reduce((acc, check) => {
    const status = normalizeCheckStatus(check);
    acc[status] += 1;
    return acc;
  }, { pass: 0, warn: 0, fail: 0 });
  const smokeStatus = counts.fail > 0
    ? 'fail'
    : counts.warn > 0
      ? 'warn'
      : 'pass';
  const failingLabels = smokeChecks
    .filter((check) => normalizeCheckStatus(check) !== 'pass')
    .map((check) => String(check.label || check.id || 'smoke check').trim())
    .filter(Boolean);
  const smokeSummary = smokeStatus === 'fail'
    ? `${counts.fail} smoke check(s) failed: ${failingLabels.join(', ')}.`
    : smokeStatus === 'warn'
      ? `${counts.pass} smoke check(s) passed with ${counts.warn} warning(s).`
      : `${counts.pass} smoke check(s) passed.`;
  return {
    smokeChecks: smokeChecks.map((check) => ({
      id: String(check.id || '').trim(),
      label: String(check.label || check.id || 'smoke check').trim(),
      status: normalizeCheckStatus(check),
      summary: String(check.summary || '').trim(),
    })),
    smokeStatus,
    smokeLabel: formatStatusLabel(smokeStatus, 'NOT RUN'),
    smokeSummary,
  };
}

function buildAutonomyProofSummary(report = {}) {
  return buildRepoScopedProofSummary(report, 'autonomyProof', {
    missingSummary: 'No repo-scoped autonomy proof actions are recorded yet.',
    failSummary: (overscopedCount) => `${overscopedCount} repo-scoped autonomy proof action(s) are still overscoped.`,
    passSummary: (safeCount, target) => `Repo-scoped autonomy proof captured ${safeCount}/${target} safe current-workspace action(s).`,
    warnSummary: (safeCount, target) => `Repo-scoped autonomy proof captured ${safeCount}/${target} safe current-workspace action(s) so far.`,
    missingNextAction: 'Run the repo-scoped autonomy proof bundle before widening the autonomy control plane.',
    failNextAction: 'Rescope or reroute the overscoped autonomy proof action before widening.',
    passNextAction: 'Keep the next autonomous slice bounded and reuse the same workspace-scoped proof envelope.',
    warnNextAction: 'Finish the remaining repo-scoped autonomy proof actions before widening.',
  });
}

function buildSelfImprovementProofSummary(report = {}) {
  return buildRepoScopedProofSummary(report, 'selfImprovementProof', {
    missingSummary: 'No repo-scoped self-improvement proof actions are recorded yet.',
    failSummary: (overscopedCount) => `${overscopedCount} repo-scoped self-improvement proof action(s) are still overscoped.`,
    passSummary: (safeCount, target) => `Repo-scoped self-improvement proof captured ${safeCount}/${target} safe current-workspace action(s).`,
    warnSummary: (safeCount, target) => `Repo-scoped self-improvement proof captured ${safeCount}/${target} safe current-workspace action(s) so far.`,
    missingNextAction: 'Run the repo-scoped self-improvement proof bundle before widening the learning loop.',
    failNextAction: 'Repair or rescope the overscoped self-improvement proof action before widening.',
    passNextAction: 'Keep the next self-improvement slice bounded and reuse the same review, trust, and rollback gates.',
    warnNextAction: 'Finish the remaining repo-scoped self-improvement proof actions before widening.',
  });
}

function buildBuilderProofSummary(report = {}) {
  return buildRepoScopedProofSummary(report, 'builderProof', {
    missingSummary: 'No repo-scoped builder proof actions are recorded yet.',
    failSummary: (overscopedCount) => `${overscopedCount} repo-scoped builder proof action(s) are still overscoped.`,
    passSummary: (safeCount, target) => `Repo-scoped builder proof captured ${safeCount}/${target} safe current-workspace builder run(s).`,
    warnSummary: (safeCount, target) => `Repo-scoped builder proof captured ${safeCount}/${target} safe current-workspace builder run(s) so far.`,
    missingNextAction: 'Run the repo-scoped builder proof bundle before widening the builder delivery phase.',
    failNextAction: 'Repair or rescope the failing builder proof run before widening.',
    passNextAction: 'Keep builder delivery slices repeatable and reuse the same repo-scoped proof envelope.',
    warnNextAction: 'Finish the remaining repo-scoped builder proof actions before widening.',
  });
}

function buildModelParitySummary(report = {}) {
  const parity = report?.modelParity && typeof report.modelParity === 'object' ? report.modelParity : {};
  const entries = Array.isArray(parity.entries) ? parity.entries : [];
  const capabilityCount = Math.max(0, Number(parity.capabilityCount ?? entries.length) || 0);
  const readyCount = Math.max(
    0,
    Number(parity.readyCount ?? entries.filter((entry) => String(entry?.status || '').trim().toLowerCase() === 'pass').length) || 0,
  );
  const status = String(parity.status || '').trim().toLowerCase()
    || (capabilityCount === 0
      ? 'missing'
      : readyCount >= capabilityCount
        ? 'pass'
        : readyCount > 0
          ? 'warn'
          : 'fail');
  const summary = String(parity.summary || '').trim()
    || (status === 'missing'
      ? 'No local-vs-remote model parity pack is recorded yet.'
      : status === 'pass'
        ? `Local-vs-remote parity is PROVEN across ${readyCount}/${capabilityCount} core coding capabilities.`
        : `Local-vs-remote parity is only ${readyCount}/${capabilityCount} across the core coding capabilities.`);
  const nextAction = String(parity.nextAction || '').trim()
    || (status === 'pass'
      ? 'Keep local and remote helper routes aligned as the bounded coding loop changes.'
      : 'Finish the missing local-vs-remote parity checks before widening the local default path.');
  return {
    status,
    label: status === 'pass'
      ? 'PROVEN'
      : status === 'warn'
        ? 'PARTIAL'
        : status === 'fail'
          ? 'BLOCKED'
          : 'NOT READY',
    proven: status === 'pass',
    widenReady: parity.widenReady === true || status === 'pass',
    capabilityCount,
    readyCount,
    summary,
    nextAction,
    entries: entries.map((entry) => ({
      id: String(entry?.id || '').trim(),
      label: String(entry?.label || entry?.id || 'capability').trim(),
      status: String(entry?.status || '').trim().toLowerCase(),
      summary: String(entry?.summary || '').trim(),
      proofStatus: String(entry?.proofStatus || '').trim().toLowerCase(),
      local: entry?.local && typeof entry.local === 'object' ? {
        role: String(entry.local.role || '').trim().toLowerCase(),
        modelProfileId: String(entry.local.modelProfileId || '').trim(),
        baseModel: String(entry.local.baseModel || '').trim(),
        providerSource: String(entry.local.providerSource || '').trim().toLowerCase(),
        localProvider: LOCAL_PROVIDER_SOURCES.has(String(entry.local.providerSource || '').trim().toLowerCase()),
      } : {},
      remote: entry?.remote && typeof entry.remote === 'object' ? {
        role: String(entry.remote.role || '').trim().toLowerCase(),
        modelProfileId: String(entry.remote.modelProfileId || '').trim(),
        baseModel: String(entry.remote.baseModel || '').trim(),
        providerSource: String(entry.remote.providerSource || '').trim().toLowerCase(),
        remoteProvider: !LOCAL_PROVIDER_SOURCES.has(String(entry.remote.providerSource || '').trim().toLowerCase()),
      } : {},
    })),
  };
}

function buildRepoScopedProofSummary(report = {}, proofKey = '', options = {}) {
  const proof = report?.[proofKey] && typeof report[proofKey] === 'object' ? report[proofKey] : {};
  const actions = Array.isArray(proof.actions) ? proof.actions : [];
  const target = Math.max(1, Number(proof.target || 5) || 5);
  const safeCount = Math.max(
    0,
    Number(
      proof.safeCount
      ?? actions.filter((action) => action?.safeToAdvance === true || String(action?.state || '').trim().toLowerCase() === 'pass').length,
    ) || 0,
  );
  const overscopedCount = Math.max(
    0,
    Number(
      proof.overscopedCount
      ?? actions.filter((action) => String(action?.capabilityFit || '').trim().toLowerCase() === 'overscoped').length,
    ) || 0,
  );
  const actionCount = Math.max(0, Number(proof.actionCount ?? actions.length) || 0);
  const workspaceScoped = proof.workspaceScoped !== false;
  const workspaceRoot = String(proof.workspaceRoot || report?.workspaceRoot || '').trim();
  const summary = String(proof.summary || '').trim()
    || (
      actionCount === 0
        ? String(options.missingSummary || 'No repo-scoped proof actions are recorded yet.')
        : overscopedCount > 0
          ? String(
            typeof options.failSummary === 'function'
              ? options.failSummary(overscopedCount, target)
              : `${overscopedCount} repo-scoped proof action(s) are still overscoped.`,
          )
          : safeCount >= target
            ? String(
              typeof options.passSummary === 'function'
                ? options.passSummary(safeCount, target)
                : `Repo-scoped proof captured ${safeCount}/${target} safe current-workspace action(s).`,
            )
            : String(
              typeof options.warnSummary === 'function'
                ? options.warnSummary(safeCount, target)
                : `Repo-scoped proof captured ${safeCount}/${target} safe current-workspace action(s) so far.`,
            )
    );
  const status = actionCount === 0
    ? 'missing'
    : overscopedCount > 0
      ? 'fail'
      : safeCount >= target
        ? 'pass'
        : 'warn';
  const nextAction = String(proof.nextAction || '').trim()
    || (
      status === 'missing'
        ? String(options.missingNextAction || 'Record the repo-scoped proof bundle before widening.')
        : status === 'fail'
          ? String(options.failNextAction || 'Repair the failing repo-scoped proof action before widening.')
          : status === 'pass'
            ? String(options.passNextAction || 'Keep the next slice bounded and supervised.')
            : String(options.warnNextAction || 'Finish the remaining repo-scoped proof actions before widening.')
    );
  return {
    status,
    label: formatStatusLabel(status, actionCount > 0 ? 'RECORDED' : 'NOT RUN'),
    target,
    safeCount,
    overscopedCount,
    actionCount,
    workspaceScoped,
    workspaceRoot,
    summary,
    nextAction,
    actions,
  };
}

function buildAcceptanceControlSummary(report = null, state = {}) {
  const safeReport = report && typeof report === 'object' ? report : {};
  const checks = Array.isArray(safeReport.checks) ? safeReport.checks : [];
  const baseSummary = summarizeAcceptanceReport({
    checks,
    training: safeReport.training,
  });
  const autonomyProof = buildAutonomyProofSummary(safeReport);
  const selfImprovementProof = buildSelfImprovementProofSummary(safeReport);
  const builderProof = buildBuilderProofSummary(safeReport);
  const modelParity = buildModelParitySummary(safeReport);
  const acceptanceStatus = String(
    safeReport.overallStatus
    || baseSummary.overallStatus
    || ((state.exists === true || checks.length > 0) ? 'recorded' : 'missing')
  ).trim().toLowerCase();
  const acceptanceLabel = formatStatusLabel(
    acceptanceStatus,
    acceptanceStatus === 'missing' ? 'NOT RUN' : 'RECORDED'
  );
  const lastAcceptanceAt = String(safeReport.completedAt || safeReport.startedAt || '').trim();
  const smoke = buildSmokeSummary(checks.filter((check) => isSmokeCheck(check)));
  const blockers = checks
    .filter((check) => normalizeCheckStatus(check) !== 'pass')
    .map((check) => ({
      id: String(check.id || '').trim(),
      label: String(check.label || check.id || 'acceptance check').trim(),
      status: normalizeCheckStatus(check),
      summary: String(check.summary || '').trim(),
    }));
  const blockerSummary = blockers.length > 0
    ? blockers.slice(0, 3).map((check) => `${check.label}: ${check.summary}`).join(' | ')
    : 'No acceptance blockers are recorded.';
  let nextDayStatus = 'blocked';
  let nextDaySummary = 'Run acceptance before the next day\'s bounded engine work.';
  if (acceptanceStatus === 'pass' && smoke.smokeStatus === 'pass' && blockers.length === 0) {
    nextDayStatus = 'ready';
    nextDaySummary = 'Yes - acceptance and smoke are healthy enough for the next day\'s bounded work.';
  } else if (acceptanceStatus === 'warn') {
    nextDayStatus = 'caution';
    nextDaySummary = `Proceed with caution - acceptance raised warnings. ${safeReport.nextAction || baseSummary.nextAction}`;
  } else if (acceptanceStatus === 'pass' && smoke.smokeStatus === 'missing') {
    nextDayStatus = 'caution';
    nextDaySummary = 'Proceed with caution - the latest acceptance run does not include a recorded smoke result.';
  } else if (acceptanceStatus === 'fail') {
    nextDayStatus = 'blocked';
    nextDaySummary = `No - acceptance is failing. ${blockerSummary}`;
  } else if (smoke.smokeStatus === 'fail') {
    nextDayStatus = 'blocked';
    nextDaySummary = `No - smoke is failing. ${smoke.smokeSummary}`;
  }
  const nextSafeAction = nextDayStatus === 'blocked' && smoke.smokeStatus === 'fail'
    ? 'Repair the failing smoke check and rerun acceptance before widening.'
    : nextDayStatus === 'blocked' && blockers.length > 0
      ? `Repair ${String(blockers[0].label || 'the failing acceptance check').toLowerCase()} and rerun acceptance before widening.`
      : nextDayStatus === 'caution' && smoke.smokeStatus === 'missing'
        ? 'Rerun acceptance with smoke coverage before using it as the next-day gate.'
        : String(safeReport.nextAction || baseSummary.nextAction || '').trim();
  return {
    acceptanceStatus,
    acceptanceLabel,
    acceptanceSummary: String(safeReport.summary || baseSummary.summary || '').trim(),
    lastAcceptanceAt,
    smokeStatus: smoke.smokeStatus,
    smokeLabel: smoke.smokeLabel,
    smokeSummary: smoke.smokeSummary,
    lastSmokeAt: smoke.smokeChecks.length > 0 ? lastAcceptanceAt : '',
    smokeChecks: smoke.smokeChecks,
    blockerCount: blockers.length,
    blockers,
    blockerSummary,
    autonomyProof,
    selfImprovementProof,
    builderProof,
    modelParity,
    nextDayStatus,
    nextDayLabel: formatStatusLabel(nextDayStatus, 'BLOCKED'),
    nextDaySummary,
    safeForNextDay: nextDayStatus === 'ready',
    nextSafeAction,
  };
}

function summarizeAcceptanceReport(report = {}) {
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const counts = checks.reduce((acc, check) => {
    const status = normalizeCheckStatus(check);
    acc[status] += 1;
    return acc;
  }, { pass: 0, warn: 0, fail: 0 });
  const trainingStatus = String(report?.training?.trustSummary?.status || '').trim().toLowerCase();
  const hasTrainingPressure = ['caution', 'pause'].includes(trainingStatus);
  const overallStatus = counts.fail > 0
    ? 'fail'
    : (counts.warn > 0 || hasTrainingPressure ? 'warn' : 'pass');
  const summary = counts.fail > 0
    ? `${counts.fail} acceptance check(s) failed.`
    : counts.warn > 0
      ? `${counts.pass} acceptance check(s) passed with ${counts.warn} warning(s).`
      : `${counts.pass} acceptance check(s) passed.`;
  const nextAction = counts.fail > 0
    ? 'Review the failing acceptance check before promoting any self-improvement work.'
    : hasTrainingPressure
      ? String(report?.training?.trustSummary?.recommendedNextStep || 'Machine pressure is elevated. Keep self-improvement small and supervised.')
      : 'The baseline looks healthy enough for another small supervised engine slice.';
  return {
    overallStatus,
    counts,
    summary,
    nextAction,
  };
}

module.exports = {
  acceptanceRoot,
  buildAcceptanceControlSummary,
  readLatestAcceptanceReport,
  summarizeAcceptanceReport,
  writeAcceptanceReport,
};
