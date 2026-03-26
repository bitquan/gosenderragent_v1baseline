'use strict';

const fs = require('fs');
const path = require('path');

const {
  CAPABILITY_ROUTE_LANES,
  MODEL_EXECUTION_ROLE_DEFAULTS,
  resolveLaneExecutionRoleId,
  resolveLaneRouteTaskMode,
  resolveLaneWrappedProfileRole,
} = require('./route-schema');
const { buildBenchmarkIdentity, listBenchmarkRuns } = require('./benchmarks');
const {
  buildAutonomousActionSummary,
  normalizeWorkspaceScope,
  runMatchesWorkspaceScope,
} = require('./autonomous-actions');
const { buildApprovedDocumentationVault } = require('../desktop-learning-records');
const { readLatestAcceptanceReport } = require('./engine-acceptance');
const { LearningJournalService } = require('./learning-journal');
const { buildModelFoundryStatus } = require('./model-foundry');
const { buildMvpReadiness } = require('./mvp-readiness');
const { buildIntegrationStudioStatus } = require('./integration-studio');
const { listPromotionState } = require('./promotions');
const { buildDailyTaskSummary, readHub } = require('./task-hub');
const { listArchivedAppBackups } = require('./app-backup-archive');
const { checkForUpdates, summarizeUpdateRecoveryState } = require('./updater');
const { buildVsCodeSetupStatus } = require('./vscode-setup');
const { buildVsCodeExtensionHealth } = require('./vscode-extension-health');
const {
  getAssistantArtifactsRoot,
  getAssistantRuntimeStatePath,
  readConfigMap,
} = require('./assistant-paths');
const { readJsonFile } = require('./utils');
const { readAssistantConfig } = require('../host/assistant-config');

const SYSTEM_CHECK_AREAS = Object.freeze([
  'roadmap',
  'engine',
  'runs',
  'trust',
  'learning',
  'promotion',
  'models',
  'autonomy',
  'self-improvement',
  'acceptance',
]);

const SELF_IMPROVEMENT_SAFE_STATUSES = new Set(['succeeded', 'review']);

function nowIso() {
  return new Date().toISOString();
}

function listUniqueValues(values = []) {
  const seen = new Set();
  const ordered = [];
  for (const value of values) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function normalizePathLike(value) {
  return String(value || '').trim().replace(/\\/g, '/');
}

function normalizeArea(area) {
  const normalized = String(area || '').trim().toLowerCase();
  return SYSTEM_CHECK_AREAS.includes(normalized) ? normalized : '';
}

function normalizePathFilter(value) {
  return normalizePathLike(value).toLowerCase();
}

function normalizeTaskFilter(value) {
  return String(value || '').trim().toLowerCase();
}

function shortText(value, maxLength = 180) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}...` : text;
}

function isReadyLikeStatus(value) {
  return ['ready', 'pass', 'green', 'open', 'strong', 'triggered', 'proven'].includes(String(value || '').trim().toLowerCase());
}

function buildAppRollbackStatus(workspaceRoot) {
  const platforms = listUniqueValues([process.platform, 'darwin', 'win32', 'linux']);
  const backups = [];
  const seen = new Set();
  for (const platform of platforms) {
    const archived = listArchivedAppBackups(workspaceRoot, platform);
    for (const backup of archived) {
      const key = [
        String(backup?.backupRoot || '').trim().toLowerCase(),
        String(backup?.id || '').trim().toLowerCase(),
        String(platform || '').trim().toLowerCase(),
      ].join('::');
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      backups.push({
        ...backup,
        platform: String(backup?.platform || platform || '').trim().toLowerCase(),
      });
    }
  }
  backups.sort((left, right) => String(right?.createdAt || '').localeCompare(String(left?.createdAt || '')));
  return {
    backups,
    backupCount: backups.length,
    latestBackupId: String(backups[0]?.id || '').trim(),
    latestBackupPlatform: String(backups[0]?.platform || '').trim().toLowerCase(),
    rollbackReady: backups.length > 0,
    summary: backups.length > 0
      ? `Archived desktop rollback ${String(backups[0]?.id || '').trim()} is ready for ${String(backups[0]?.platform || '').trim().toLowerCase() || 'the current platform'}.`
      : 'No archived desktop app rollback is recorded yet.',
  };
}

function buildWorkspaceUpdateStatus(workspaceRoot) {
  const update = checkForUpdates(workspaceRoot);
  const recovery = summarizeUpdateRecoveryState(workspaceRoot);
  const branch = String(update?.branch || '').trim();
  const upstream = String(update?.upstream || '').trim();
  let state = 'unavailable';
  if (update?.ok === true) {
    if (update?.hasUpdates) {
      state = 'updates-available';
    } else if (upstream) {
      state = 'current';
    } else {
      state = 'no-upstream';
    }
  }
  return {
    ...update,
    state,
    recovery,
    workspace: {
      state,
      ok: update?.ok === true,
      hasUpdates: update?.hasUpdates === true,
      branch,
      upstream: upstream || null,
      reason: String(update?.reason || '').trim(),
      ahead: Number(update?.ahead || 0),
      behind: Number(update?.behind || 0),
      recovery,
      message: String(update?.reason || '').trim() || recovery.summary,
    },
  };
}

function normalizeMemoryHints(value) {
  const hints = value && typeof value === 'object' ? value : {};
  return {
    summary: String(hints.summary || '').trim(),
    topRejectReason: String(hints.topRejectReason || hints.top_reject_reason || '').trim(),
    topFixPattern: String(hints.topFixPattern || hints.top_fix_pattern || '').trim(),
    recommendedResponse: String(hints.recommendedResponse || hints.recommended_response || '').trim(),
    recommendedPrompt: String(hints.recommendedPrompt || hints.recommended_prompt || '').trim(),
    rejectCount: Number(hints.rejectCount ?? hints.reject_count ?? 0),
    topPaths: Array.isArray(hints.topPaths)
      ? hints.topPaths
      : (Array.isArray(hints.top_paths) ? hints.top_paths : []),
    topPhaseId: String(hints.topPhaseId || hints.top_phase_id || '').trim(),
    topPhaseLabel: String(hints.topPhaseLabel || hints.top_phase_label || '').trim(),
    topPhaseReason: String(hints.topPhaseReason || hints.top_phase_reason || '').trim(),
    phaseSummary: String(hints.phaseSummary || hints.phase_summary || '').trim(),
    phaseRelevance: Array.isArray(hints.phaseRelevance)
      ? hints.phaseRelevance
      : (Array.isArray(hints.phase_relevance) ? hints.phase_relevance : []),
    recentRejects: Array.isArray(hints.recentRejects)
      ? hints.recentRejects
      : (Array.isArray(hints.recent_rejects) ? hints.recent_rejects : []),
  };
}

function hasMeaningfulMemoryHints(value) {
  const hints = normalizeMemoryHints(value);
  return Boolean(
    hints.summary
    || hints.topRejectReason
    || hints.topFixPattern
    || hints.recommendedResponse
    || hints.recommendedPrompt
    || hints.topPhaseId
    || hints.topPhaseLabel
    || hints.topPhaseReason
    || hints.phaseSummary
    || Number(hints.rejectCount || 0) > 0
    || (Array.isArray(hints.topPaths) && hints.topPaths.length > 0)
    || (Array.isArray(hints.phaseRelevance) && hints.phaseRelevance.length > 0)
    || (Array.isArray(hints.recentRejects) && hints.recentRejects.length > 0)
  );
}

function mergeMemoryHints(...values) {
  const normalized = values
    .map((value) => normalizeMemoryHints(value))
    .filter((value) => hasMeaningfulMemoryHints(value));
  if (normalized.length === 0) {
    return {};
  }
  const merged = normalized.reduce((current, hints) => ({
    summary: current.summary || hints.summary,
    topRejectReason: current.topRejectReason || hints.topRejectReason,
    topFixPattern: current.topFixPattern || hints.topFixPattern,
    recommendedResponse: current.recommendedResponse || hints.recommendedResponse,
    recommendedPrompt: current.recommendedPrompt || hints.recommendedPrompt,
    rejectCount: Math.max(Number(current.rejectCount || 0), Number(hints.rejectCount || 0)),
    topPaths: Array.isArray(current.topPaths) && current.topPaths.length > 0 ? current.topPaths : hints.topPaths,
    topPhaseId: current.topPhaseId || hints.topPhaseId,
    topPhaseLabel: current.topPhaseLabel || hints.topPhaseLabel,
    topPhaseReason: current.topPhaseReason || hints.topPhaseReason,
    phaseSummary: current.phaseSummary || hints.phaseSummary,
    phaseRelevance: Array.isArray(current.phaseRelevance) && current.phaseRelevance.length > 0
      ? current.phaseRelevance
      : hints.phaseRelevance,
    recentRejects: Array.isArray(current.recentRejects) && current.recentRejects.length > 0
      ? current.recentRejects
      : hints.recentRejects,
  }), {
    summary: '',
    topRejectReason: '',
    topFixPattern: '',
    recommendedResponse: '',
    recommendedPrompt: '',
    rejectCount: 0,
    topPaths: [],
    topPhaseId: '',
    topPhaseLabel: '',
    topPhaseReason: '',
    phaseSummary: '',
    phaseRelevance: [],
    recentRejects: [],
  });
  return hasMeaningfulMemoryHints(merged) ? merged : {};
}

function profileMatchesWorkspace(profileId, workspaceProfileId) {
  const current = String(profileId || '').trim();
  const workspace = String(workspaceProfileId || '').trim();
  if (!workspace || !current) {
    return true;
  }
  return current === workspace;
}

function buildPhase2EvidenceCounts(promotions = {}, benchmarks = {}, modelFoundry = {}, modelRoles = {}) {
  const workspaceProfileId = String(modelRoles?.workspace?.modelProfileId || '').trim();
  const benchmarkRuns = Array.isArray(benchmarks?.runs)
    ? benchmarks.runs
    : (Array.isArray(benchmarks?.benchmarkSummary) ? benchmarks.benchmarkSummary : []);
  const benchmarkCount = benchmarkRuns.filter((run) => {
    const identity = run?.benchmarkIdentity && typeof run.benchmarkIdentity === 'object' ? run.benchmarkIdentity : {};
    const profileId = String(run?.modelProfileId || run?.wrappedProfileId || identity?.wrappedProfileId || '').trim();
    const status = String(run?.status || '').trim().toLowerCase();
    return profileMatchesWorkspace(profileId, workspaceProfileId)
      && (status === 'pass' || run?.ok === true || Number(run?.passRate || 0) >= 100);
  }).length;

  const candidates = Array.isArray(promotions?.candidates) ? promotions.candidates : [];
  const readyCandidates = Array.isArray(promotions?.readyCandidates) ? promotions.readyCandidates : candidates;
  const promotionReadyCount = readyCandidates.filter((candidate) => {
    const profileId = String(
      candidate?.modelProfileId
      || candidate?.wrappedProfileId
      || candidate?.modelIdentity?.wrappedProfileId
      || ''
    ).trim();
    const gateStatus = String(candidate?.promotionGate?.status || candidate?.promotionState || '').trim().toLowerCase();
    return profileMatchesWorkspace(profileId, workspaceProfileId)
      && (candidate?.promotionGate?.canPromote === true || gateStatus === 'ready');
  }).length;
  const promotedCount = candidates.filter((candidate) => {
    const profileId = String(
      candidate?.modelProfileId
      || candidate?.wrappedProfileId
      || candidate?.modelIdentity?.wrappedProfileId
      || ''
    ).trim();
    const state = String(candidate?.promotionState || candidate?.status || '').trim().toLowerCase();
    return profileMatchesWorkspace(profileId, workspaceProfileId)
      && ['promoted', 'rolled-back', 'rolled_back'].includes(state);
  }).length;

  const foundryCandidates = [];
  if (Array.isArray(modelFoundry?.candidates)) {
    foundryCandidates.push(...modelFoundry.candidates);
  }
  if (Array.isArray(modelFoundry?.suggested)) {
    foundryCandidates.push(...modelFoundry.suggested);
  }
  if (modelFoundry?.nextCandidate && typeof modelFoundry.nextCandidate === 'object') {
    foundryCandidates.push(modelFoundry.nextCandidate);
  }
  if (modelFoundry?.nextCandidateIdentity && typeof modelFoundry.nextCandidateIdentity === 'object') {
    foundryCandidates.push({
      id: String(modelFoundry.nextCandidateIdentity.candidateId || '').trim(),
      nextCandidateIdentity: modelFoundry.nextCandidateIdentity,
    });
  }
  const foundryKeys = new Set();
  const foundryCount = foundryCandidates.filter((candidate) => {
    const identity = candidate?.modelIdentity && typeof candidate.modelIdentity === 'object'
      ? candidate.modelIdentity
      : (candidate?.nextCandidateIdentity && typeof candidate.nextCandidateIdentity === 'object' ? candidate.nextCandidateIdentity : {});
    const profileId = String(
      candidate?.modelProfileId
      || identity?.wrappedProfileId
      || identity?.modelProfileId
      || ''
    ).trim();
    if (!profileMatchesWorkspace(profileId, workspaceProfileId)) {
      return false;
    }
    const key = String(candidate?.id || candidate?.title || identity?.candidateId || '').trim();
    if (key && foundryKeys.has(key)) {
      return false;
    }
    if (key) {
      foundryKeys.add(key);
    }
    return true;
  }).length;

  return {
    benchmarkCount,
    promotionReadyCount,
    promotedCount,
    foundryCount,
    total: benchmarkCount + promotionReadyCount + promotedCount + foundryCount,
  };
}

function augmentLearningStatusWithLiveEvidence(learningJournal = {}, options = {}) {
  const current = learningJournal && typeof learningJournal === 'object' ? learningJournal : {};
  const acceptance = options.acceptance && typeof options.acceptance === 'object' ? options.acceptance : {};
  const selfHostProof = options.selfHostProof && typeof options.selfHostProof === 'object' ? options.selfHostProof : {};
  const selfImprovement = options.selfImprovement && typeof options.selfImprovement === 'object' ? options.selfImprovement : {};
  const promotions = options.promotions && typeof options.promotions === 'object' ? options.promotions : {};
  const benchmarks = options.benchmarks && typeof options.benchmarks === 'object' ? options.benchmarks : {};
  const modelFoundry = options.modelFoundry && typeof options.modelFoundry === 'object' ? options.modelFoundry : {};
  const modelRoles = options.modelRoles && typeof options.modelRoles === 'object' ? options.modelRoles : {};

  const trainingReadiness = current.trainingReadiness && typeof current.trainingReadiness === 'object'
    ? { ...current.trainingReadiness }
    : {};
  const exportReadiness = current.gsDev1ExportReadiness && typeof current.gsDev1ExportReadiness === 'object'
    ? { ...current.gsDev1ExportReadiness }
    : {};
  const acceptanceStatus = String(acceptance?.report?.overallStatus || acceptance?.overallStatus || '').trim().toLowerCase();
  const selfHostProven = selfHostProof?.proven === true
    || String(selfHostProof?.label || '').trim().toUpperCase() === 'PROVEN'
    || isReadyLikeStatus(selfHostProof?.status);
  const selfImprovementProof = selfImprovement?.proof && typeof selfImprovement.proof === 'object' ? selfImprovement.proof : {};
  const selfImprovementProven = selfImprovementProof?.proven === true
    || String(selfImprovementProof?.label || '').trim().toUpperCase() === 'PROVEN'
    || isReadyLikeStatus(selfImprovementProof?.status);
  const evidence = buildPhase2EvidenceCounts(promotions, benchmarks, modelFoundry, modelRoles);
  const baselineReady = acceptanceStatus === 'pass' || selfHostProven;

  if ((exportReadiness.ready === true || isReadyLikeStatus(exportReadiness.status)) && !baselineReady) {
    exportReadiness.ready = false;
    exportReadiness.status = acceptance?.exists === true ? 'blocked' : 'warn';
    exportReadiness.blockedByAcceptance = true;
    exportReadiness.summary = shortText(
      'Approved or trusted GS-Dev-1 export candidates exist, but the latest local-first acceptance baseline is not green enough to unlock export yet.',
    );
  }

  if (!(exportReadiness.ready === true || isReadyLikeStatus(exportReadiness.status))
    && baselineReady
    && evidence.total > 0) {
    const baselineLabel = acceptanceStatus === 'pass'
      ? 'the accepted baseline bundle'
      : 'the proven self-host and comparison baseline';
    exportReadiness.ready = true;
    exportReadiness.status = 'ready';
    exportReadiness.inferred = true;
    exportReadiness.eligibleCount = Math.max(Number(exportReadiness.eligibleCount || 0), evidence.total);
    exportReadiness.trustedCount = Math.max(Number(exportReadiness.trustedCount || 0), Math.max(1, evidence.benchmarkCount + evidence.promotionReadyCount));
    exportReadiness.approvedCount = Math.max(Number(exportReadiness.approvedCount || 0), Math.max(1, evidence.promotionReadyCount + evidence.promotedCount));
    exportReadiness.approvedOrTrustedCount = Math.max(
      Number(exportReadiness.approvedOrTrustedCount || 0),
      Math.max(Number(exportReadiness.trustedCount || 0), Number(exportReadiness.approvedCount || 0)),
    );
    exportReadiness.summary = shortText(
      `Approved or trusted GS-Dev-1 training handoff is ready from ${baselineLabel} plus ${evidence.benchmarkCount} benchmark run(s), ${evidence.promotionReadyCount} promotion-ready candidate(s), and ${evidence.foundryCount} foundry candidate(s).`,
    );
  }

  if (!isReadyLikeStatus(trainingReadiness.status)
    && (exportReadiness.ready === true || isReadyLikeStatus(exportReadiness.status))
    && selfImprovementProven) {
    trainingReadiness.status = 'ready';
    trainingReadiness.inferred = true;
    trainingReadiness.detail = shortText(`${evidence.total} trusted Phase 2 evidence signal(s) are ready for GS-Dev-1 hardening.`);
    trainingReadiness.summary = shortText(
      'GS-Dev-1 training handoff is ready from trusted export evidence, passing self-host proof, and supervised self-improvement proof.',
    );
  }

  return {
    ...current,
    trainingReadiness,
    gsDev1ExportReadiness: exportReadiness,
  };
}

function buildSelfHostProof(acceptance = {}, latestRunSummary = {}) {
  const report = acceptance?.report && typeof acceptance.report === 'object' ? acceptance.report : {};
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const selfHostChecks = checks.filter((check) => /^self-host-/.test(String(check?.id || '').trim().toLowerCase()));
  const failing = selfHostChecks.filter((check) => String(check?.status || '').trim().toLowerCase() === 'fail');
  const passing = selfHostChecks.filter((check) => String(check?.status || '').trim().toLowerCase() === 'pass');
  const bootstrapCheck = selfHostChecks.find((check) => String(check?.id || '').trim() === 'self-host-bootstrap') || null;
  const testsCheck = selfHostChecks.find((check) => String(check?.id || '').trim() === 'self-host-tests') || null;
  const smokeCheck = selfHostChecks.find((check) => String(check?.id || '').trim() === 'self-host-smoke') || null;
  const hasSelfHostSmoke = Boolean(smokeCheck);
  if (selfHostChecks.length === 0) {
    return {
      status: acceptance?.exists ? 'warn' : 'idle',
      label: acceptance?.exists ? 'PARTIAL' : 'NOT RUN',
      summary: acceptance?.exists
        ? 'No self-host proof checks were recorded in the latest acceptance bundle yet. Run the full self-host acceptance suite before widening self-work.'
        : 'No self-host proof is recorded yet. Run the acceptance suite to verify that the project can bootstrap and validate its own self-host lab safely.',
      blockerSummary: '',
      nextAction: 'Run npm run engine:acceptance -- --full-self-host to capture a real self-host proof bundle before widening self-work.',
      checkCount: 0,
      passedCount: 0,
      latestCheckLabel: '',
      smokeRecorded: false,
    };
  }
  if (failing.length > 0) {
    const topFailure = failing[0];
    return {
      status: 'fail',
      label: 'BLOCKED',
      summary: `${failing.length}/${selfHostChecks.length} self-host proof check(s) failed. ${shortText(topFailure.summary || 'Repair the self-host proof before widening self-work.')}`,
      blockerSummary: shortText(topFailure.summary || topFailure.label || 'A self-host proof check failed.', 180),
      nextAction: shortText(
        report?.nextAction
        || latestRunSummary?.summary
        || `Repair ${String(topFailure.label || topFailure.id || 'the failing self-host check').trim()} and rerun the full self-host acceptance suite.`,
        180,
      ),
      checkCount: selfHostChecks.length,
      passedCount: passing.length,
      latestCheckLabel: String(topFailure.label || topFailure.id || '').trim(),
      smokeRecorded: hasSelfHostSmoke,
    };
  }
  if (bootstrapCheck && testsCheck && (!hasSelfHostSmoke || String(smokeCheck?.status || '').trim().toLowerCase() !== 'pass')) {
    return {
      status: hasSelfHostSmoke ? 'warn' : 'warn',
      label: 'PARTIAL',
      summary: hasSelfHostSmoke
        ? 'Self-host bootstrap and tests passed, but the latest self-host smoke proof is still missing or not clean.'
        : 'Self-host bootstrap and tests passed. Capture the full self-host smoke proof before widening self-work.',
      blockerSummary: '',
      nextAction: hasSelfHostSmoke
        ? 'Repair the self-host smoke path and rerun the full self-host acceptance suite.'
        : 'Run npm run engine:acceptance -- --full-self-host to add smoke proof to the current self-host baseline.',
      checkCount: selfHostChecks.length,
      passedCount: passing.length,
      latestCheckLabel: String(testsCheck.label || testsCheck.id || '').trim(),
      smokeRecorded: hasSelfHostSmoke,
    };
  }
  return {
    status: 'pass',
    label: 'PROVEN',
    summary: `Self-host proof passed. ${passing.length}/${selfHostChecks.length} self-host check(s) succeeded${hasSelfHostSmoke ? ', including smoke.' : '.'}`,
    blockerSummary: '',
    nextAction: 'Keep the next self-host slice bounded and supervised, then rerun the same proof bundle after meaningful self-work.',
    checkCount: selfHostChecks.length,
    passedCount: passing.length,
    latestCheckLabel: String((smokeCheck || testsCheck || bootstrapCheck)?.label || '').trim(),
    smokeRecorded: hasSelfHostSmoke,
  };
}

function describeModelIdentity(identity = {}) {
  const benchmarkIdentity = identity?.benchmarkIdentity && typeof identity.benchmarkIdentity === 'object'
    ? identity.benchmarkIdentity
    : null;
  const benchmarkId = String(benchmarkIdentity?.id || identity?.id || '').trim();
  return [
    identity?.modelRole ? `role ${String(identity.modelRole || '').trim().toLowerCase()}` : '',
    identity?.wrappedProfileId ? `profile ${String(identity.wrappedProfileId || '').trim()}` : '',
    identity?.providerSource && identity?.baseModel
      ? `${String(identity.providerSource || '').trim().toLowerCase()}:${String(identity.baseModel || '').trim()}`
      : String(identity?.baseModel || '').trim(),
    identity?.taskMode ? `mode ${String(identity.taskMode || '').trim().toLowerCase()}` : '',
    identity?.candidateId ? `candidate ${String(identity.candidateId || '').trim()}` : '',
    benchmarkId ? `bench ${benchmarkId}` : '',
    identity?.promotionState ? `promotion ${String(identity.promotionState || '').trim().toLowerCase()}` : '',
    identity?.latestBackupId ? `backup ${String(identity.latestBackupId || '').trim()}` : '',
  ].filter(Boolean).join(' | ');
}

function safeJsonParse(raw) {
  try {
    const parsed = JSON.parse(String(raw || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function readRecentJsonLines(filePath, limit = 200) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => safeJsonParse(line))
      .filter(Boolean)
      .slice(-Math.max(1, Number(limit || 200)));
  } catch (_error) {
    return [];
  }
}

function resolveConfiguredPath(workspaceRoot, configuredPath) {
  const raw = String(configuredPath || '').trim();
  if (!raw) {
    return '';
  }
  if (path.isAbsolute(raw)) {
    return raw;
  }
  return path.join(workspaceRoot, raw);
}

function resolveAssistantDevRunsDir(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  const explicit = resolveConfiguredPath(workspaceRoot, config.assistant_dev_runs_dir);
  if (explicit) {
    return explicit;
  }
  const artifactsRoot = getAssistantArtifactsRoot(workspaceRoot);
  if (artifactsRoot) {
    return path.join(artifactsRoot, 'dev_data', '.dev_agent_runs');
  }
  return path.join(workspaceRoot, '.dev_agent_runs');
}

function resolveSelfImprovementQueuePath(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  const explicit = resolveConfiguredPath(workspaceRoot, config.assistant_self_improvement_queue_path);
  if (explicit) {
    return explicit;
  }
  return path.join(resolveAssistantDevRunsDir(workspaceRoot), 'self_improvement', 'queue_summary.json');
}

function resolveSelfImprovementHistoryPath(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  const explicit = resolveConfiguredPath(workspaceRoot, config.assistant_self_improvement_history_path);
  if (explicit) {
    return explicit;
  }
  return path.join(resolveAssistantDevRunsDir(workspaceRoot), 'self_improvement', 'execution_history.jsonl');
}

function filterChangedFiles(changedFiles = [], pathFilter = '') {
  const normalizedFilter = normalizePathFilter(pathFilter);
  const items = Array.isArray(changedFiles) ? changedFiles : [];
  if (!normalizedFilter) {
    return items;
  }
  return items.filter((item) => normalizePathLike(item?.path || item).toLowerCase().includes(normalizedFilter));
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return '';
}

function selectLatestRun(runtimeState = {}, filters = {}, workspaceScope = {}) {
  const runs = Array.isArray(runtimeState?.latest)
    ? runtimeState.latest
    : (Array.isArray(runtimeState?.runs) ? runtimeState.runs : []);
  const scope = normalizeWorkspaceScope(workspaceScope);
  const normalizedRunId = String(filters.runId || '').trim();
  const normalizedTask = normalizeTaskFilter(filters.task);
  const normalizedPath = normalizePathFilter(filters.path);
  const scopedRuns = runs.filter((run) => runMatchesWorkspaceScope(run, scope));
  return scopedRuns.find((run) => {
    if (normalizedRunId && String(run?.runId || '').trim() !== normalizedRunId) {
      return false;
    }
    if (normalizedTask) {
      const taskText = `${String(run?.task || '')} ${String(run?.label || '')} ${String(run?.ticket || '')}`.toLowerCase();
      if (!taskText.includes(normalizedTask)) {
        return false;
      }
    }
    if (normalizedPath) {
      const changedFiles = filterChangedFiles(run?.operatorExecution?.changedFiles || [], normalizedPath);
      if (!changedFiles.length) {
        return false;
      }
    }
    return true;
  }) || scopedRuns[0] || null;
}

function buildLatestRunSummary(latestRun, pathFilter = '') {
  if (!latestRun || typeof latestRun !== 'object') {
    return {
      status: 'idle',
      summary: 'No runtime activity has been recorded yet.',
      changedFiles: [],
      reviewSummary: {},
      trustSummary: {},
      benchmarkMetadata: {},
      learningMetadata: {},
      outputTail: '',
      runState: '',
      task: '',
      taskMode: '',
      laneLabel: '',
      modelRole: '',
      modelProfileId: '',
      modelDisplayName: '',
      infrastructureFailure: false,
    };
  }
  const execution = latestRun.operatorExecution && typeof latestRun.operatorExecution === 'object'
    ? latestRun.operatorExecution
    : {};
  const changedFiles = filterChangedFiles(execution.changedFiles || [], pathFilter);
  const combinedOutput = firstDefined(
    execution.outputTail?.combined,
    latestRun.logTail,
    latestRun.stdoutTail,
    latestRun.stderrTail,
  );
  const infrastructureFailure = /could not start the python runtime|spawn .* enoent|ticket id is required|invalid ticket id|runtime launch failed|python runtime is not available/i.test([
    combinedOutput,
    latestRun.blockedReason,
    latestRun.message,
    execution.resultSummary,
  ].map((value) => String(value || '').trim()).filter(Boolean).join('\n'));
  return {
    status: String(latestRun.state || execution.status || execution.runState || 'unknown').trim().toLowerCase() || 'unknown',
    summary: shortText(firstDefined(
      execution.resultSummary,
      execution.stageSummary?.summary,
      execution.reviewSummary?.summary,
      execution.runSummary?.summary,
      execution.testSummary?.summary,
      latestRun.blockedReason,
      latestRun.label,
      'Latest runtime activity is available.',
    )),
    changedFiles,
    reviewSummary: execution.reviewSummary || latestRun.reviewSummary || {},
    trustSummary: execution.trustSummary || latestRun.trustSummary || {},
    benchmarkMetadata: execution.benchmarkMetadata || {},
    learningMetadata: execution.learningMetadata || {},
    outputTail: shortText(combinedOutput, 280),
    runState: String(execution.runState || latestRun.state || '').trim().toLowerCase(),
    task: String(execution.task || latestRun.task || '').trim(),
    taskMode: String(execution.taskMode || latestRun.taskMode || '').trim().toLowerCase(),
    laneLabel: String(execution.laneLabel || latestRun.laneLabel || '').trim(),
    modelRole: String(execution.modelRole || latestRun.modelRole || '').trim().toLowerCase(),
    modelProfileId: String(execution.modelProfileId || latestRun.modelProfileId || '').trim(),
    modelDisplayName: String(execution.modelDisplayName || latestRun.modelDisplayName || '').trim(),
    retryAvailable: execution.retryAvailable === true,
    repairAvailable: execution.repairAvailable === true,
    infrastructureFailure,
  };
}

function buildModelRoleSummary(assistantConfig = {}, aiStatus = null, tuningSettings = {}) {
  const workspaceProfileId = String(
    aiStatus?.dualModel?.workspaceProfileId
    || assistantConfig.workspaceModelProfileId
    || assistantConfig.modelProfileId
    || 'gs-dev-1-default',
  ).trim();
  const engineProfileId = String(
    aiStatus?.dualModel?.engineProfileId
    || assistantConfig.engineModelProfileId
    || workspaceProfileId
    || 'gse-1-engine',
  ).trim();
  const workspaceLabel = String(
    aiStatus?.dualModel?.workspaceProfile?.displayName
    || assistantConfig.workspaceModelDisplayName
    || assistantConfig.modelDisplayName
    || 'Workspace coding model',
  ).trim();
  const engineLabel = String(
    aiStatus?.dualModel?.engineProfile?.displayName
    || assistantConfig.engineModelDisplayName
    || 'Engine control model',
  ).trim();
  const workspaceBaseModel = String(
    aiStatus?.dualModel?.workspaceProfile?.baseModel
    || assistantConfig.workspaceBaseModel
    || tuningSettings.trainingOllamaModel
    || assistantConfig.baseModel
    || '',
  ).trim();
  const workspaceBaseProvider = String(
    aiStatus?.dualModel?.workspaceProfile?.baseProvider
    || assistantConfig.workspaceBaseProvider
    || (tuningSettings.trainingOllamaModel ? 'ollama' : '')
    || assistantConfig.baseProvider
    || '',
  ).trim().toLowerCase();
  const workspaceProviderSource = String(
    aiStatus?.dualModel?.workspaceProfile?.providerSource
    || assistantConfig.workspaceProviderSource
    || assistantConfig.providerSource
    || workspaceBaseProvider,
  ).trim().toLowerCase();
  const engineBaseModel = String(
    aiStatus?.dualModel?.engineProfile?.baseModel
    || assistantConfig.engineBaseModel
    || assistantConfig?.taskModeRoutes?.planner?.model
    || assistantConfig?.taskModeRoutes?.validator?.model
    || assistantConfig?.taskModeRoutes?.summarizer?.model
    || assistantConfig.workspaceBaseModel
    || tuningSettings.trainingOllamaModel
    || assistantConfig.baseModel
    || '',
  ).trim();
  const engineBaseProvider = String(
    aiStatus?.dualModel?.engineProfile?.baseProvider
    || assistantConfig.engineBaseProvider
    || assistantConfig?.taskModeRoutes?.planner?.provider
    || assistantConfig?.taskModeRoutes?.validator?.provider
    || assistantConfig?.taskModeRoutes?.summarizer?.provider
    || assistantConfig.workspaceBaseProvider
    || (tuningSettings.trainingOllamaModel ? 'ollama' : '')
    || assistantConfig.baseProvider
    || '',
  ).trim().toLowerCase();
  const engineProviderSource = String(
    aiStatus?.dualModel?.engineProfile?.providerSource
    || assistantConfig.engineProviderSource
    || assistantConfig.workspaceProviderSource
    || assistantConfig.providerSource
    || engineBaseProvider,
  ).trim().toLowerCase();
  const workspace = {
    modelProfileId: workspaceProfileId,
    modelDisplayName: workspaceLabel,
    baseModel: workspaceBaseModel,
    baseProvider: workspaceBaseProvider,
    providerSource: workspaceProviderSource,
  };
  const engine = {
    modelProfileId: engineProfileId,
    modelDisplayName: engineLabel,
    baseModel: engineBaseModel,
    baseProvider: engineBaseProvider,
    providerSource: engineProviderSource,
  };
  const laneAssignments = Array.isArray(aiStatus?.capabilityLanes)
    ? aiStatus.capabilityLanes.map((lane) => ({
      laneId: String(lane?.id || '').trim(),
      laneLabel: String(lane?.label || '').trim(),
      role: String(lane?.profileRole || '').trim().toLowerCase() || resolveLaneWrappedProfileRole(String(lane?.id || '').trim()),
      modelRoleId: String(lane?.modelRoleId || '').trim().toLowerCase() || resolveLaneExecutionRoleId(String(lane?.id || '').trim()),
      modelRoleLabel: String(lane?.modelRoleLabel || MODEL_EXECUTION_ROLE_DEFAULTS[String(lane?.modelRoleId || '').trim().toLowerCase()]?.label || '').trim(),
      taskMode: String(lane?.routeTaskMode || '').trim().toLowerCase(),
      profileId: String(lane?.profileId || '').trim(),
      profileLabel: String(lane?.profileLabel || '').trim(),
      preferredModel: String(lane?.preferredModel || '').trim(),
      provider: String(lane?.provider || '').trim().toLowerCase(),
      providerSource: String(lane?.providerSource || lane?.provider || '').trim().toLowerCase(),
      fallbackModel: String(lane?.fallbackModel || '').trim(),
      fallbackProvider: String(lane?.fallbackProvider || '').trim().toLowerCase(),
    }))
    : CAPABILITY_ROUTE_LANES.map((lane) => ({
      laneId: lane.id,
      laneLabel: lane.label,
      role: resolveLaneWrappedProfileRole(lane.id),
      modelRoleId: resolveLaneExecutionRoleId(lane.id),
      modelRoleLabel: MODEL_EXECUTION_ROLE_DEFAULTS[resolveLaneExecutionRoleId(lane.id)]?.label || 'Worker',
      taskMode: resolveLaneRouteTaskMode(lane.id),
      profileId: resolveLaneWrappedProfileRole(lane.id) === 'engine' ? engineProfileId : workspaceProfileId,
      profileLabel: resolveLaneWrappedProfileRole(lane.id) === 'engine' ? engineLabel : workspaceLabel,
      preferredModel: resolveLaneWrappedProfileRole(lane.id) === 'engine' ? engineBaseModel : workspaceBaseModel,
      provider: resolveLaneWrappedProfileRole(lane.id) === 'engine' ? engineBaseProvider : workspaceBaseProvider,
      providerSource: resolveLaneWrappedProfileRole(lane.id) === 'engine' ? engineProviderSource : workspaceProviderSource,
      fallbackModel: '',
      fallbackProvider: '',
    }));
  const explicitRoles = Array.isArray(aiStatus?.modelRoles) && aiStatus.modelRoles.length > 0
    ? aiStatus.modelRoles.map((role) => ({
      ...role,
      laneMappings: Array.isArray(role?.laneMappings) ? role.laneMappings : [],
      laneIds: Array.isArray(role?.laneIds) ? role.laneIds : [],
      taskModes: Array.isArray(role?.taskModes) ? role.taskModes : [],
    }))
    : Object.values(MODEL_EXECUTION_ROLE_DEFAULTS).map((definition) => {
      const roleLanes = laneAssignments.filter((lane) => lane.modelRoleId === definition.id);
      const primaryRole = definition.primaryProfileRole === 'engine' ? engine : workspace;
      return {
        id: definition.id,
        label: definition.label,
        summary: `${definition.label} currently inherits ${definition.primaryProfileRole === 'engine' ? engineLabel : workspaceLabel}.`,
        wrappedProfileId: primaryRole.modelProfileId,
        wrappedProfileLabel: primaryRole.modelDisplayName,
        wrappedProfileRole: definition.primaryProfileRole,
        wrappedProfileIds: Array.from(new Set(roleLanes.map((lane) => lane.profileId).filter(Boolean))),
        baseModel: primaryRole.baseModel,
        baseProvider: primaryRole.baseProvider,
        providerSource: primaryRole.providerSource,
        fallbackModel: roleLanes[0]?.fallbackModel || '',
        fallbackProvider: roleLanes[0]?.fallbackProvider || '',
        laneIds: roleLanes.map((lane) => lane.laneId).filter(Boolean),
        taskModes: Array.from(new Set(roleLanes.map((lane) => lane.taskMode).filter(Boolean))),
        laneMappings: roleLanes,
        provisioningState: '',
        provisioningSummary: '',
        localReadiness: '',
        localReady: false,
      };
    });
  return {
    status: workspaceProfileId && engineProfileId ? 'ready' : 'partial',
    summary: `Workspace coding model: ${workspaceLabel || workspaceProfileId || 'unset'} | Engine control model: ${engineLabel || engineProfileId || 'unset'} | roles: front-door chat / orchestrator, worker, reviewer.`,
    workspace,
    engine,
    roles: explicitRoles,
    laneAssignments,
  };
}

function rowTargetPaths(row = {}) {
  return Array.isArray(row?.target_paths)
    ? row.target_paths
    : (Array.isArray(row?.targetPaths) ? row.targetPaths : []);
}

function historyMatchesPath(row = {}, pathFilter = '') {
  const normalizedFilter = normalizePathFilter(pathFilter);
  if (!normalizedFilter) {
    return true;
  }
  const targets = rowTargetPaths(row).map((item) => normalizePathLike(item).toLowerCase());
  return targets.some((item) => item.includes(normalizedFilter));
}

function parseIsoTimestamp(value) {
  const parsed = Date.parse(String(value || '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRepoProofRows(proof = {}, workspaceScope = {}, pathFilter = '') {
  const actions = Array.isArray(proof?.actions) ? proof.actions : [];
  return actions
    .filter((action) => runMatchesWorkspaceScope(action, workspaceScope))
    .map((action) => ({
      timestamp: String(action?.endedAt || action?.startedAt || '').trim(),
      task_id: String(action?.runId || action?.taskId || '').trim(),
      candidate_id: String(action?.candidateId || '').trim(),
      status: action?.safeToAdvance === true || String(action?.state || '').trim().toLowerCase() === 'pass'
        ? 'succeeded'
        : String(action?.state || '').trim().toLowerCase() || 'blocked',
      target_paths: Array.isArray(action?.targetPaths) ? action.targetPaths : [],
      source: 'repo-proof',
      label: String(action?.label || action?.task || '').trim(),
    }))
    .filter((row) => row.timestamp)
    .filter((row) => historyMatchesPath(row, pathFilter));
}

function buildSelfImprovementSummary(workspaceRoot, pathFilter = '', options = {}) {
  const queuePath = resolveSelfImprovementQueuePath(workspaceRoot);
  const historyPath = resolveSelfImprovementHistoryPath(workspaceRoot);
  const payload = readJsonFile(queuePath, {}) || {};
  const acceptance = options.acceptance && typeof options.acceptance === 'object' ? options.acceptance : {};
  const acceptanceControl = acceptance?.controlSummary && typeof acceptance.controlSummary === 'object'
    ? acceptance.controlSummary
    : {};
  const acceptanceStatus = String(
    acceptanceControl.acceptanceStatus
    || acceptance?.report?.overallStatus
    || acceptance?.overallStatus
    || ''
  ).trim().toLowerCase();
  const workspaceScope = normalizeWorkspaceScope({
    workspaceRoot,
    targetWorkspaceRoot: options.targetWorkspaceRoot || workspaceRoot,
    labRoot: options.labRoot || '',
  });
  const preparedTasks = Array.isArray(payload.prepared_tasks)
    ? payload.prepared_tasks
    : (Array.isArray(payload.preparedTasks) ? payload.preparedTasks : []);
  const filteredTasks = pathFilter
    ? preparedTasks.filter((task) => {
        const paths = Array.isArray(task?.target_paths) ? task.target_paths : (Array.isArray(task?.targetPaths) ? task.targetPaths : []);
        return paths.some((item) => normalizePathLike(item).toLowerCase().includes(normalizePathFilter(pathFilter)));
      })
    : preparedTasks;
  const nowValue = Number.isFinite(Date.parse(String(options.now || ''))) ? Date.parse(String(options.now)) : Date.now();
  const dailyTarget = Math.max(1, Number(options.dailyTarget || 5));
  const historyRows = readRecentJsonLines(historyPath, 200)
    .filter((row) => historyMatchesPath(row, pathFilter))
    .sort((left, right) => parseIsoTimestamp(right?.timestamp) - parseIsoTimestamp(left?.timestamp));
  const acceptanceProof = acceptanceControl.selfImprovementProof && typeof acceptanceControl.selfImprovementProof === 'object'
    ? acceptanceControl.selfImprovementProof
    : (acceptance?.report?.selfImprovementProof && typeof acceptance.report.selfImprovementProof === 'object'
      ? acceptance.report.selfImprovementProof
      : {});
  const proofRows = acceptanceStatus === 'pass' || acceptanceControl.safeForNextDay === true
    ? normalizeRepoProofRows(acceptanceProof, workspaceScope, pathFilter)
    : [];
  const combinedHistory = [...proofRows, ...historyRows]
    .sort((left, right) => parseIsoTimestamp(right?.timestamp) - parseIsoTimestamp(left?.timestamp));
  const rowsToday = combinedHistory.filter((row) => nowValue - parseIsoTimestamp(row?.timestamp) <= 24 * 60 * 60 * 1000);
  const safeToday = rowsToday.filter((row) => SELF_IMPROVEMENT_SAFE_STATUSES.has(String(row?.status || '').trim().toLowerCase()));
  const historicalSafeRows = combinedHistory.filter((row) => SELF_IMPROVEMENT_SAFE_STATUSES.has(String(row?.status || '').trim().toLowerCase()));
  const lastExecution = combinedHistory[0] || null;
  const dailyProgress = {
    target: dailyTarget,
    totalCount: rowsToday.length,
    safeCount: safeToday.length,
    remaining: Math.max(0, dailyTarget - safeToday.length),
    met: safeToday.length >= dailyTarget,
  };
  const lastStatus = String(lastExecution?.status || '').trim().toLowerCase();
  let proof = {
    status: 'idle',
    label: 'NOT RUN',
    proven: false,
    blocked: false,
    partial: false,
    summary: 'No supervised self-improvement proof is recorded yet.',
    nextAction: 'Generate and complete one bounded supervised self-improvement task before widening further.',
  };
  if (['fail', 'failed', 'blocked', 'needs-repair', 'cancelled'].includes(lastStatus)) {
    proof = {
      status: 'fail',
      label: 'BLOCKED',
      proven: false,
      blocked: true,
      partial: false,
      summary: shortText('The latest supervised self-improvement run still needs repair or review.'),
      nextAction: shortText('Repair the latest supervised self-improvement run before opening another one.'),
    };
  } else if (safeToday.length > 0 || historicalSafeRows.length > 0) {
    proof = {
      status: 'ready',
      label: 'PROVEN',
      proven: true,
      blocked: false,
      partial: false,
      summary: shortText(
        acceptanceProof?.status === 'pass' && acceptanceProof?.summary
          ? acceptanceProof.summary
          : `Supervised self-improvement is proven with ${Math.max(safeToday.length, 1)} safe run(s) recorded.`,
      ),
      nextAction: shortText(
        acceptanceProof?.status === 'pass' && acceptanceProof?.nextAction
          ? acceptanceProof.nextAction
          : 'Open at most one more bounded self-improvement task and keep it under the same review, trust, and rollback gates.',
      ),
    };
  } else if (filteredTasks.length > 0 || combinedHistory.length > 0) {
    proof = {
      status: 'warn',
      label: 'PARTIAL',
      proven: false,
      blocked: false,
      partial: true,
      summary: shortText('Self-improvement is seeded, but one supervised self-improvement round-trip still needs to complete successfully.'),
      nextAction: shortText('Run one bounded supervised self-improvement task and keep the same review and trust gates attached.'),
    };
  }
  let status = proof.blocked ? 'fail' : proof.proven ? 'ready' : 'missing';
  if (!proof.proven && !proof.blocked && (filteredTasks.length > 0 || combinedHistory.length > 0)) {
    status = 'warn';
  } else if (!proof.proven && !proof.blocked && (fs.existsSync(queuePath) || fs.existsSync(historyPath))) {
    status = 'idle';
  }
  let summary = 'No self-improvement queue summary is available yet.';
  if (proof.proven) {
    summary = filteredTasks.length > 0
      ? `${proof.summary} ${filteredTasks.length} prepared task(s) are queued for the next bounded pass.`
      : `${proof.summary} The queue is clear right now.`;
  } else if (filteredTasks.length > 0) {
    summary = `${dailyProgress.safeCount}/${dailyProgress.target} safe self-improvement slice(s) today; ${filteredTasks.length} prepared task(s) are queued.`;
  } else if (combinedHistory.length > 0) {
    summary = dailyProgress.met
      ? `${dailyProgress.safeCount}/${dailyProgress.target} safe self-improvement slice(s) completed today. The queue is clear right now.`
      : `${dailyProgress.safeCount}/${dailyProgress.target} safe self-improvement slice(s) completed today; ${dailyProgress.remaining} more safe slice(s) are needed before the daily gate is clear.`;
  } else if (fs.existsSync(queuePath)) {
    summary = 'No prepared self-improvement tasks are queued right now.';
  }
  const recommendation = String(
    payload?.recommendation?.summary
    || payload?.queue_summary?.recommendation
    || ''
  ).trim();
  return {
    status,
    summary,
    queuePath: fs.existsSync(queuePath) ? queuePath : '',
    historyPath: fs.existsSync(historyPath) ? historyPath : '',
    totalCandidates: Number(payload.total_candidates || payload.totalCandidates || 0),
    eligibleCandidateCount: Number(payload.eligible_candidate_count || payload.eligibleCandidateCount || 0),
    preparedTaskCount: filteredTasks.length,
    historyCount: combinedHistory.length,
    dailyTarget: dailyProgress,
    safeExecutionCount: safeToday.length,
    proofActionCount: proofRows.length,
    proofBundle: acceptanceProof,
    lastExecution: lastExecution ? {
      taskId: String(lastExecution.task_id || lastExecution.taskId || '').trim(),
      candidateId: String(lastExecution.candidate_id || lastExecution.candidateId || '').trim(),
      status: String(lastExecution.status || '').trim().toLowerCase(),
      timestamp: String(lastExecution.timestamp || '').trim(),
      targetPaths: rowTargetPaths(lastExecution).slice(0, 4),
    } : null,
    recommendedNextSafeAction: recommendation
      || proof.nextAction
      || (dailyProgress.met
        ? 'Keep the next self-improvement slice bounded and reuse the same review/trust gates.'
        : `${dailyProgress.remaining} more safe self-improvement slice(s) are needed today before the hard gate is clear.`),
    proof,
    topTasks: filteredTasks.slice(0, 5).map((task) => ({
      taskId: String(task?.task_id || task?.taskId || '').trim(),
      title: String(task?.title || task?.summary || task?.objective || '').trim(),
      targetPaths: Array.isArray(task?.target_paths) ? task.target_paths.slice(0, 4) : (Array.isArray(task?.targetPaths) ? task.targetPaths.slice(0, 4) : []),
    })),
  };
}

function buildReadinessSnapshot(learningStatus, promotions, acceptance, modelRoles, options = {}) {
  const workspaceRoot = String(options.workspaceRoot || '').trim();
  const targetWorkspaceRoot = String(options.targetWorkspaceRoot || workspaceRoot || '').trim();
  const appRollbacks = options.appRollbacks && typeof options.appRollbacks === 'object'
    ? options.appRollbacks
    : buildAppRollbackStatus(targetWorkspaceRoot || workspaceRoot);
  const updates = options.updates && typeof options.updates === 'object'
    ? options.updates
    : buildWorkspaceUpdateStatus(targetWorkspaceRoot || workspaceRoot);
  return buildMvpReadiness({
    generatedAt: String(options.now || nowIso()).trim(),
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot: String(options.labRoot || '').trim(),
    manager: {
      summaryText: acceptance?.report?.summary || acceptance?.summary || '',
      safeMode: options.safeMode && typeof options.safeMode === 'object' ? options.safeMode : { active: false, watchOnly: false },
      approvals: options.approvals && typeof options.approvals === 'object' ? options.approvals : { total: 0 },
      autonomousActions: options.autonomy && typeof options.autonomy === 'object' ? options.autonomy : {},
    },
    promotions,
    reviewer: options.reviewer && typeof options.reviewer === 'object' ? options.reviewer : {},
    regression: options.regression && typeof options.regression === 'object' ? options.regression : {},
    testBench: options.testBench && typeof options.testBench === 'object' ? options.testBench : {},
    learningJournal: learningStatus,
    modelRoles,
    settings: options.settings && typeof options.settings === 'object' ? options.settings : {},
    taskHub: options.taskHub && typeof options.taskHub === 'object' ? options.taskHub : { tasks: [] },
    acceptance,
    vscodeSetup: options.vscodeSetup && typeof options.vscodeSetup === 'object' ? options.vscodeSetup : {},
    extensionHealth: options.extensionHealth && typeof options.extensionHealth === 'object' ? options.extensionHealth : {},
    modelFoundry: options.modelFoundry && typeof options.modelFoundry === 'object' ? options.modelFoundry : {},
    integrations: options.integrations && typeof options.integrations === 'object'
      ? options.integrations
      : buildIntegrationStudioStatus(targetWorkspaceRoot || workspaceRoot),
    appRollbacks,
    benchmarks: options.benchmarks && typeof options.benchmarks === 'object' ? options.benchmarks : {},
    updates,
    selfImprovement: options.selfImprovement && typeof options.selfImprovement === 'object' ? options.selfImprovement : {},
    modelProvisioning: options.modelProvisioning && typeof options.modelProvisioning === 'object' ? options.modelProvisioning : {},
    approvedDocsVault: options.approvedDocsVault && typeof options.approvedDocsVault === 'object' ? options.approvedDocsVault : {},
  });
}

function buildModelProvisioningArea(assistantConfig = {}, aiStatus = null, tuningStatus = {}) {
  const provisioning = aiStatus?.provisioning && typeof aiStatus.provisioning === 'object'
    ? aiStatus.provisioning
    : {};
  if (provisioning.summary) {
    const routeCoverage = provisioning.routeCoverage && typeof provisioning.routeCoverage === 'object'
      ? provisioning.routeCoverage
      : {};
    return {
      status: String(provisioning.status || provisioning.state || 'unknown').trim().toLowerCase(),
      summary: shortText(provisioning.summary || 'Model provisioning status is available.'),
      recommendedAction: shortText(provisioning.recommendedAction || ''),
      currentProvider: String(provisioning.currentProvider || '').trim().toLowerCase(),
      currentModel: String(provisioning.currentModel || '').trim(),
      roles: Array.isArray(provisioning.roles) ? provisioning.roles.slice(0, 2) : [],
      blockers: Array.isArray(provisioning.blockers) ? provisioning.blockers.slice(0, 4) : [],
      warnings: Array.isArray(provisioning.warnings) ? provisioning.warnings.slice(0, 4) : [],
      routeCoverage: {
        status: String(routeCoverage.status || '').trim().toLowerCase(),
        requiredModels: Array.isArray(routeCoverage.requiredModels) ? routeCoverage.requiredModels.slice(0, 8) : [],
        readyModels: Array.isArray(routeCoverage.readyModels) ? routeCoverage.readyModels.slice(0, 8) : [],
        missingLiveModels: Array.isArray(routeCoverage.missingLiveModels) ? routeCoverage.missingLiveModels.slice(0, 8) : [],
      },
      ollama: provisioning.ollama && typeof provisioning.ollama === 'object' ? provisioning.ollama : {},
    };
  }

  const telemetry = tuningStatus?.telemetry && typeof tuningStatus.telemetry === 'object'
    ? tuningStatus.telemetry
    : (tuningStatus && typeof tuningStatus === 'object' ? tuningStatus : {});
  const ollama = telemetry.ollama && typeof telemetry.ollama === 'object' ? telemetry.ollama : {};
  const workspaceProvider = String(
    assistantConfig.workspaceBaseProvider
    || assistantConfig.workspaceProviderSource
    || assistantConfig.baseProvider
    || assistantConfig.providerSource
    || 'ollama',
  ).trim().toLowerCase() || 'ollama';
  const engineProvider = String(
    assistantConfig.engineBaseProvider
    || assistantConfig.engineProviderSource
    || assistantConfig.workspaceBaseProvider
    || assistantConfig.workspaceProviderSource
    || assistantConfig.baseProvider
    || assistantConfig.providerSource
    || workspaceProvider,
  ).trim().toLowerCase() || workspaceProvider;
  const workspaceModel = String(assistantConfig.workspaceBaseModel || assistantConfig.baseModel || '').trim();
  const engineModel = String(assistantConfig.engineBaseModel || assistantConfig.workspaceBaseModel || assistantConfig.baseModel || '').trim();
  const remoteKeyPresent = !!process.env.OPENAI_API_KEY;
  const liveOllamaModels = new Set(
    (Array.isArray(ollama.models) ? ollama.models : []).map((item) => String(item || '').trim()).filter(Boolean),
  );
  const describeRole = (role, provider, model) => {
    if (provider === 'ollama') {
      const readyOllama = model
        ? (liveOllamaModels.has(model) || (ollama.selectedModelReady === true && String(ollama.selectedModel || '').trim() === model))
        : Number(ollama.modelCount || 0) > 0;
      return {
        role,
        provider,
        model,
        state: readyOllama ? 'ready' : 'fail',
        summary: readyOllama
          ? `${role === 'engine' ? 'Engine' : 'Workspace'} role is provisioned on Ollama${model ? ` with ${model}` : ''}.`
          : `${role === 'engine' ? 'Engine' : 'Workspace'} role expects Ollama${model ? ` model ${model}` : ''}, but no ready local model is available.`,
      };
    }
    if (provider === 'local') {
      return {
        role,
        provider,
        model,
        state: process.env.LOCAL_AI_CMD ? 'ready' : 'fail',
        summary: process.env.LOCAL_AI_CMD
          ? `${role === 'engine' ? 'Engine' : 'Workspace'} role is provisioned through the Local AI bridge.`
          : `${role === 'engine' ? 'Engine' : 'Workspace'} role expects a Local AI bridge, but no command is configured.`,
      };
    }
    return {
      role,
      provider,
      model,
      state: remoteKeyPresent ? 'ready' : 'warn',
      summary: remoteKeyPresent
        ? `${role === 'engine' ? 'Engine' : 'Workspace'} role can use ${provider}.`
        : `${role === 'engine' ? 'Engine' : 'Workspace'} role may need ${provider}, but CLI cannot confirm the secure API key from this shell.`,
    };
  };
  const roles = [
    describeRole('workspace', workspaceProvider, workspaceModel),
    describeRole('engine', engineProvider, engineModel),
  ];
  const failedRoles = roles.filter((item) => item.state === 'fail');
  const warnedRoles = roles.filter((item) => item.state === 'warn');
  const status = failedRoles.length > 0 ? 'fail' : warnedRoles.length > 0 ? 'warn' : 'ready';
  const summary = failedRoles.length > 0
    ? failedRoles[0].summary
    : warnedRoles.length > 0
      ? warnedRoles[0].summary
      : 'Workspace coding and engine control roles look provisioned from the current CLI-visible state.';
  const recommendedAction = failedRoles.some((item) => item.provider === 'ollama')
    ? `Import or select a ready Ollama model${workspaceModel ? ` (${workspaceModel})` : ''} before asking the engine for local coding work.`
    : failedRoles.some((item) => item.provider === 'local')
      ? 'Set a Local AI command before routing work through the local bridge.'
      : warnedRoles.length > 0
        ? 'Open the desktop app or export the provider key into this shell to confirm remote model provisioning.'
        : 'Keep the current provider routing and validate the next safe slice.';
  return {
    status,
    summary: shortText(summary),
    recommendedAction: shortText(recommendedAction),
    currentProvider: workspaceProvider,
    currentModel: workspaceModel,
    roles,
    blockers: failedRoles.map((item) => item.summary),
    warnings: warnedRoles.map((item) => item.summary),
    ollama: {
      running: ollama.running === true || ollama.reachable === true,
      modelCount: Number(ollama.modelCount || 0),
      selectedModel: String(ollama.selectedModel || workspaceModel || '').trim(),
      selectedModelReady: ollama.selectedModelReady === true,
      models: Array.isArray(ollama.models) ? ollama.models.slice(0, 16) : [],
    },
  };
}

function mergeModelExecutionRoleProvisioning(modelRoleSummary = {}, modelProvisioning = {}) {
  const roles = Array.isArray(modelRoleSummary?.roles) ? modelRoleSummary.roles : [];
  const provisioningRoles = Array.isArray(modelProvisioning?.roles) ? modelProvisioning.roles : [];
  return roles.map((role) => {
    const laneMappings = Array.isArray(role?.laneMappings) ? role.laneMappings : [];
    const matchedProvisioning = provisioningRoles.filter((item) => (
      String(item?.wrappedProfileId || '').trim() === String(role?.wrappedProfileId || '').trim()
      || String(item?.wrappedProfileRole || item?.role || '').trim().toLowerCase() === String(role?.wrappedProfileRole || '').trim().toLowerCase()
      || laneMappings.some((lane) => (
        String(item?.wrappedProfileId || '').trim() === String(lane?.profileId || '').trim()
        || String(item?.wrappedProfileRole || item?.role || '').trim().toLowerCase() === String(lane?.role || lane?.wrappedProfileRole || '').trim().toLowerCase()
      ))
    ));
    const failed = matchedProvisioning.filter((item) => item.state === 'fail');
    const warned = matchedProvisioning.filter((item) => item.state === 'warn');
    const provisioningState = String(role?.provisioningState || '').trim().toLowerCase()
      || (failed.length > 0 ? 'fail' : warned.length > 0 ? 'warn' : matchedProvisioning.length > 0 ? 'ready' : '');
    const localReady = role?.localReady === true || matchedProvisioning.some((item) => item.localReady === true);
    const storeRegistered = matchedProvisioning.some((item) => item.storeRegistered === true);
    const localVisible = role?.localReadiness || (matchedProvisioning.some((item) => item.local === true)
      ? (localReady ? 'live' : (storeRegistered ? 'registered' : 'staged'))
      : 'not-local');
    return {
      ...role,
      provisioningState,
      provisioningSummary: String(role?.provisioningSummary || matchedProvisioning[0]?.summary || '').trim(),
      localReadiness: String(localVisible || '').trim(),
      localReady,
    };
  });
}

function buildDocsLabGuidance(docsVault = {}) {
  const exists = docsVault?.exists === true;
  const freshness = String(docsVault?.freshnessLabel || 'idle').trim().toLowerCase() || 'idle';
  const status = !exists ? 'warn' : freshness === 'stale' ? 'warn' : freshness === 'aging' ? 'warn' : 'ready';
  const summary = !exists
    ? 'No approved docs are captured yet. Use the docs-scout recipe in a lab before relying on docs-led changes.'
    : freshness === 'stale'
      ? 'Approved docs are stale. Refresh them with the docs-scout recipe before the next promotion-sensitive change.'
      : freshness === 'aging'
        ? 'Approved docs are aging. Reuse them carefully and refresh them in a docs-scout lab before wider changes.'
        : 'Approved docs are fresh enough to guide the next bounded lab slice.';
  const recommendedAction = !exists
    ? 'Run the docs-scout recipe in a lab and capture one approved documentation source.'
    : freshness === 'fresh'
      ? 'Reuse the trusted docs for the next bounded slice, and run docs-scout again only if the surface changed.'
      : 'Refresh the trusted docs in a docs-scout lab before relying on docs-led review or promotion.';
  return {
    status,
    recipeId: 'docs-scout',
    summary: shortText(summary),
    recommendedAction: shortText(recommendedAction),
    recommendedSources: Array.isArray(docsVault?.recommendedSources) ? docsVault.recommendedSources.slice(0, 4) : [],
    latest: docsVault?.latest && typeof docsVault.latest === 'object' ? docsVault.latest : null,
    freshnessLabel: freshness,
  };
}

function buildValidationRollup(acceptance = {}, latestRunSummary = {}, autonomy = {}) {
  const acceptanceControl = acceptance?.controlSummary && typeof acceptance.controlSummary === 'object'
    ? acceptance.controlSummary
    : {};
  const acceptanceStatus = String(
    acceptanceControl.acceptanceStatus
    || acceptance?.report?.overallStatus
    || acceptance?.overallStatus
    || '',
  ).trim().toLowerCase();
  const latestRunStatus = latestRunSummary?.infrastructureFailure || String(latestRunSummary?.taskMode || '').trim().toLowerCase() !== 'validator'
    ? 'idle'
    : String(latestRunSummary?.status || latestRunSummary?.runState || '').trim().toLowerCase();
  const validationToday = autonomy?.validationToday && typeof autonomy.validationToday === 'object'
    ? autonomy.validationToday
    : {};
  const passCount = Number(validationToday.passCount || 0);
  const failCount = Number(validationToday.failCount || 0);
  const reviewBlockedCount = Number(validationToday.reviewBlockedCount || 0);
  const status = acceptanceStatus === 'fail' || failCount > 0 || latestRunStatus === 'fail'
    ? 'fail'
    : acceptanceStatus === 'warn' || reviewBlockedCount > 0 || latestRunStatus === 'warn'
      ? 'warn'
      : acceptanceStatus === 'pass' || passCount > 0 || latestRunStatus === 'pass'
        ? 'ready'
        : 'idle';
  const label = status === 'fail'
    ? 'FAIL'
    : status === 'warn'
      ? 'WARN'
      : status === 'ready'
        ? 'PASS'
        : 'IDLE';
  const summary = status === 'fail'
    ? `Validation is blocking: ${passCount} pass, ${failCount} fail, ${reviewBlockedCount} review-held today.`
    : status === 'warn'
      ? `Validation is mixed: ${passCount} pass, ${failCount} fail, ${reviewBlockedCount} review-held today.`
      : status === 'ready'
        ? `Validation is holding: ${passCount} pass, ${failCount} fail, ${reviewBlockedCount} review-held today.`
        : 'Validation proof has not been recorded yet for today.';
  return {
    status,
    label,
    passCount,
    failCount,
    reviewBlockedCount,
    acceptanceStatus,
    latestRunStatus,
    summary: shortText(summary),
  };
}

function buildAcceptanceArea(acceptance = {}) {
  const acceptanceControl = acceptance?.controlSummary && typeof acceptance.controlSummary === 'object'
    ? acceptance.controlSummary
    : {};
  const acceptanceStatus = String(
    acceptanceControl.acceptanceStatus
    || acceptance?.report?.overallStatus
    || acceptance?.overallStatus
    || '',
  ).trim().toLowerCase();
  return {
    status: acceptanceStatus || (acceptance?.exists ? 'recorded' : 'missing'),
    summary: shortText(
      acceptanceControl.nextDaySummary
      || acceptanceControl.acceptanceSummary
      || acceptance?.report?.summary
      || acceptance?.summary
      || 'Acceptance has not been recorded yet.',
    ),
    exists: acceptance?.exists === true,
    outputPath: String(acceptance?.outputPath || '').trim(),
    controlSummary: acceptanceControl,
    latestAcceptanceStatus: String(acceptanceControl.acceptanceStatus || '').trim(),
    latestAcceptanceLabel: String(acceptanceControl.acceptanceLabel || '').trim(),
    latestAcceptanceAt: String(acceptanceControl.lastAcceptanceAt || '').trim(),
    latestSmokeStatus: String(acceptanceControl.smokeStatus || '').trim(),
    latestSmokeLabel: String(acceptanceControl.smokeLabel || '').trim(),
    latestSmokeAt: String(acceptanceControl.lastSmokeAt || '').trim(),
    smokeSummary: shortText(acceptanceControl.smokeSummary || ''),
    blockerCount: Number(acceptanceControl.blockerCount || 0),
    blockerSummary: shortText(acceptanceControl.blockerSummary || ''),
    blockers: Array.isArray(acceptanceControl.blockers) ? acceptanceControl.blockers.slice(0, 3) : [],
    autonomyProof: acceptanceControl.autonomyProof && typeof acceptanceControl.autonomyProof === 'object'
      ? acceptanceControl.autonomyProof
      : {},
    selfImprovementProof: acceptanceControl.selfImprovementProof && typeof acceptanceControl.selfImprovementProof === 'object'
      ? acceptanceControl.selfImprovementProof
      : {},
    builderProof: acceptanceControl.builderProof && typeof acceptanceControl.builderProof === 'object'
      ? acceptanceControl.builderProof
      : {},
    modelParity: acceptanceControl.modelParity && typeof acceptanceControl.modelParity === 'object'
      ? acceptanceControl.modelParity
      : {},
    nextDayStatus: String(acceptanceControl.nextDayStatus || '').trim(),
    nextDayLabel: String(acceptanceControl.nextDayLabel || '').trim(),
    nextDaySummary: shortText(acceptanceControl.nextDaySummary || ''),
    safeForNextDay: acceptanceControl.safeForNextDay === true,
    nextSafeAction: shortText(acceptanceControl.nextSafeAction || acceptance?.report?.nextAction || ''),
  };
}

function buildDailyQuotaProof(readiness = {}, autonomy = {}, selfImprovement = {}, validation = {}, taskHubDaily = {}) {
  const autonomyDaily = autonomy?.dailyTarget && typeof autonomy.dailyTarget === 'object' ? autonomy.dailyTarget : {};
  const selfImprovementDaily = selfImprovement?.dailyTarget && typeof selfImprovement.dailyTarget === 'object' ? selfImprovement.dailyTarget : {};
  const focusTask = taskHubDaily?.focusTask && typeof taskHubDaily.focusTask === 'object'
    ? taskHubDaily.focusTask
    : (readiness?.dailyQuotaProof?.focusTask && typeof readiness.dailyQuotaProof.focusTask === 'object' ? readiness.dailyQuotaProof.focusTask : null);
  const blockedRescopedCount = Number(
    taskHubDaily?.blockedRescopedCount
    ?? readiness?.dailyQuotaProof?.blockedRescopedCount
    ?? 0
  );
  const doNotWidenYetBecause = String(
    readiness?.dailyQuotaProof?.doNotWidenYetBecause
    || readiness?.doNotWidenYetBecause
    || ''
  ).trim();
  const targetMet = autonomyDaily.met === true && selfImprovementDaily.met === true;
  const status = doNotWidenYetBecause || validation.status === 'fail'
    ? 'fail'
    : blockedRescopedCount > 0 || validation.status === 'warn' || !targetMet
      ? 'warn'
      : focusTask
        ? 'ready'
        : 'idle';
  const summary = doNotWidenYetBecause
    ? doNotWidenYetBecause
    : status === 'ready'
      ? 'The daily 5+5 quota proof is healthy enough to stay within the current Month 1 envelope.'
      : 'The daily 5+5 quota proof still needs attention before widening.';
  return {
    status,
    summary: shortText(summary),
    focusTask,
    autonomous: {
      target: Number(autonomyDaily.target || 0),
      safeCount: Number(autonomyDaily.safeCount || 0),
      met: autonomyDaily.met === true,
    },
    selfImprovement: {
      target: Number(selfImprovementDaily.target || 0),
      safeCount: Number(selfImprovementDaily.safeCount || 0),
      met: selfImprovementDaily.met === true,
    },
    blockedRescopedCount,
    validation,
    recommendedNextSafeAction: String(
      readiness?.recommendedNextSafeAction
      || autonomy?.recommendedNextSafeAction
      || selfImprovement?.recommendedNextSafeAction
      || ''
    ).trim(),
    doNotWidenYetBecause,
  };
}

function buildRoadmapArea(readiness = {}, autonomy = {}, selfImprovement = {}, latestRunSummary = {}, taskHubDaily = {}, validation = {}, acceptanceArea = {}) {
  const currentPhase = readiness.currentPhase && typeof readiness.currentPhase === 'object' ? readiness.currentPhase : {};
  const phaseGate = readiness.phaseGate && typeof readiness.phaseGate === 'object' ? readiness.phaseGate : {};
  const currentMonth = readiness.currentMonth && typeof readiness.currentMonth === 'object' ? readiness.currentMonth : {};
  const hardGate = readiness.hardGate && typeof readiness.hardGate === 'object' ? readiness.hardGate : {};
  const internalAudit = readiness.internalAudit && typeof readiness.internalAudit === 'object' ? readiness.internalAudit : {};
  const phaseCloseout = readiness.phaseCloseout && typeof readiness.phaseCloseout === 'object' ? readiness.phaseCloseout : {};
  const nextPhasePreview = readiness.nextPhasePreview && typeof readiness.nextPhasePreview === 'object' ? readiness.nextPhasePreview : {};
  const selfHostExpansion = readiness.selfHostExpansion && typeof readiness.selfHostExpansion === 'object' ? readiness.selfHostExpansion : {};
  const selfHostExpansionProgress = readiness.selfHostExpansionProgress && typeof readiness.selfHostExpansionProgress === 'object'
    ? readiness.selfHostExpansionProgress
    : {};
  const selfHostProof = readiness.selfHostProof && typeof readiness.selfHostProof === 'object' ? readiness.selfHostProof : {};
  const selfImprovementProof = readiness.selfImprovementProof && typeof readiness.selfImprovementProof === 'object'
    ? readiness.selfImprovementProof
    : (selfImprovement.proof && typeof selfImprovement.proof === 'object' ? selfImprovement.proof : {});
  const companionParity = readiness.companionParity && typeof readiness.companionParity === 'object' ? readiness.companionParity : {};
  const modelParity = acceptanceArea?.modelParity && typeof acceptanceArea.modelParity === 'object' && Object.keys(acceptanceArea.modelParity).length > 0
    ? acceptanceArea.modelParity
    : (acceptanceArea?.controlSummary?.modelParity && typeof acceptanceArea.controlSummary.modelParity === 'object' && Object.keys(acceptanceArea.controlSummary.modelParity).length > 0
      ? acceptanceArea.controlSummary.modelParity
      : (readiness.modelParity && typeof readiness.modelParity === 'object' ? readiness.modelParity : {}));
  const autonomyProof = acceptanceArea?.autonomyProof && typeof acceptanceArea.autonomyProof === 'object'
    ? acceptanceArea.autonomyProof
    : {};
  const acceptanceStatus = String(acceptanceArea?.status || '').trim().toLowerCase();
  const acceptanceBlocked = acceptanceStatus === 'fail' || acceptanceStatus === 'blocked';
  const phaseScorecards = Array.isArray(readiness.phaseScorecards) ? readiness.phaseScorecards : [];
  const latestModelLabel = String(latestRunSummary.modelDisplayName || latestRunSummary.modelProfileId || '').trim();
  const latestTask = String(latestRunSummary.task || '').trim();
  const engineProofSummary = latestTask
    ? `${latestModelLabel || 'Model'} handled "${latestTask}" on ${latestRunSummary.laneLabel || 'the current lane'} (${latestRunSummary.status || 'unknown'}).`
    : 'No engine-assisted execution proof is recorded yet for this workspace.';
  const dailyQuotaProof = buildDailyQuotaProof(readiness, autonomy, selfImprovement, validation, taskHubDaily);
  const derivedStatus = acceptanceBlocked
    ? 'blocked'
    : String(phaseGate.status || hardGate.status || readiness.phaseStatus || readiness.status || 'unknown').trim().toLowerCase();
  const derivedSummary = acceptanceBlocked
    ? shortText(
        acceptanceArea.blockerSummary
        || acceptanceArea.summary
        || acceptanceArea.nextSafeAction
        || 'Engine acceptance is still blocking roadmap progress.',
      )
    : shortText(
        phaseCloseout.summary
        || phaseGate.summary
        || readiness.phaseProof
        || readiness.phaseSummary
        || readiness.summary
        || hardGate.summary
        || dailyQuotaProof.doNotWidenYetBecause
        || 'Roadmap status is available.',
      );
  return {
    status: derivedStatus,
    summary: derivedSummary,
    currentPhase: {
      id: String(currentPhase.id || '').trim(),
      number: Number(currentPhase.number || 0),
      label: String(currentPhase.label || '').trim(),
      summary: shortText(currentPhase.summary || readiness.phaseSummary || ''),
      completion: Number(currentPhase.completion || readiness.phasePercent || 0),
      status: String(currentPhase.status || readiness.phaseStatus || '').trim().toLowerCase(),
      monthNumbers: Array.isArray(currentPhase.monthNumbers) ? currentPhase.monthNumbers.slice() : [],
    },
    phaseGate: {
      ok: phaseGate.ok === true,
      status: String(phaseGate.status || '').trim().toLowerCase(),
      label: String(phaseGate.label || '').trim(),
      summary: shortText(phaseGate.summary || ''),
      reasons: Array.isArray(phaseGate.reasons) ? phaseGate.reasons.slice(0, 5) : [],
      blockedMonth: phaseGate.blockedMonth && typeof phaseGate.blockedMonth === 'object' ? {
        id: String(phaseGate.blockedMonth.id || '').trim(),
        number: Number(phaseGate.blockedMonth.number || 0),
        label: String(phaseGate.blockedMonth.label || '').trim(),
        layer: String(phaseGate.blockedMonth.layer || '').trim(),
      } : null,
    },
    phasePercent: Number(readiness.phasePercent || 0),
    phaseStatus: String(readiness.phaseStatus || currentPhase.status || '').trim().toLowerCase(),
    phaseProof: {
      summary: shortText(readiness.phaseProof || readiness.phaseSummary || ''),
    },
    phaseScorecards: phaseScorecards.map((item) => ({
      id: String(item.id || '').trim(),
      number: Number(item.number || 0),
      label: String(item.label || '').trim(),
      goal: shortText(item.goal || item.summary || ''),
      completion: Number(item.completion || 0),
      status: String(item.status || '').trim().toLowerCase(),
      gateLabel: String(item.gateLabel || '').trim(),
      gateSummary: shortText(item.gateSummary || ''),
      proofSummary: shortText(item.proofSummary || ''),
      monthNumbers: Array.isArray(item.monthNumbers) ? item.monthNumbers.slice() : [],
    })),
    currentMonth: {
      id: String(currentMonth.id || '').trim(),
      number: Number(currentMonth.number || 0),
      label: String(currentMonth.label || '').trim(),
      layer: String(currentMonth.layer || '').trim(),
      completion: Number(currentMonth.completion || readiness.percent || 0),
      status: String(currentMonth.status || readiness.status || '').trim().toLowerCase(),
    },
    hardGate: {
      ok: hardGate.ok === true,
      status: String(hardGate.status || '').trim().toLowerCase(),
      label: String(hardGate.label || '').trim(),
      summary: shortText(hardGate.summary || ''),
      reasons: Array.isArray(hardGate.reasons) ? hardGate.reasons.slice(0, 5) : [],
    },
    roadmapPercent: Number(readiness.roadmapPercent || 0),
    roadmapStatus: String(readiness.roadmapStatus || '').trim().toLowerCase(),
    monthPercent: Number(readiness.percent || 0),
    monthStatus: String(readiness.status || '').trim().toLowerCase(),
    internalAudit: {
      summary: shortText(internalAudit.summary || ''),
      roadmapPercent: Number(internalAudit.roadmapPercent || readiness.roadmapPercent || 0),
      monthPercent: Number(internalAudit.monthPercent || readiness.percent || 0),
      currentMonth: internalAudit.currentMonth && typeof internalAudit.currentMonth === 'object' ? {
        id: String(internalAudit.currentMonth.id || '').trim(),
        number: Number(internalAudit.currentMonth.number || 0),
        label: String(internalAudit.currentMonth.label || '').trim(),
        layer: String(internalAudit.currentMonth.layer || '').trim(),
      } : null,
      hardGate: internalAudit.hardGate && typeof internalAudit.hardGate === 'object' ? {
        ok: internalAudit.hardGate.ok === true,
        label: String(internalAudit.hardGate.label || '').trim(),
        summary: shortText(internalAudit.hardGate.summary || ''),
      } : null,
    },
    phaseCloseout: {
      status: String(phaseCloseout.status || '').trim().toLowerCase(),
      label: String(phaseCloseout.label || '').trim(),
      summary: shortText(phaseCloseout.summary || ''),
      blockers: Array.isArray(phaseCloseout.blockers) ? phaseCloseout.blockers.slice(0, 4).map((item) => shortText(item, 160)) : [],
      nextAction: shortText(phaseCloseout.nextAction || ''),
    },
    nextPhasePreview: nextPhasePreview.label ? {
      id: String(nextPhasePreview.id || '').trim(),
      number: Number(nextPhasePreview.number || 0),
      label: String(nextPhasePreview.label || '').trim(),
      summary: shortText(nextPhasePreview.summary || ''),
      gateSummary: shortText(nextPhasePreview.gateSummary || ''),
      proofSummary: shortText(nextPhasePreview.proofSummary || ''),
    } : null,
    selfHostExpansion: {
      eligible: selfHostExpansion.eligible === true,
      status: String(selfHostExpansion.status || '').trim().toLowerCase(),
      label: String(selfHostExpansion.label || '').trim(),
      summary: shortText(selfHostExpansion.summary || ''),
      nextAction: shortText(selfHostExpansion.nextAction || ''),
      remainingCount: Number(selfHostExpansion.remainingCount || 0),
    },
    selfHostExpansionProgress: {
      exists: selfHostExpansionProgress.exists === true,
      status: String(selfHostExpansionProgress.status || '').trim().toLowerCase(),
      label: String(selfHostExpansionProgress.label || '').trim(),
      summary: shortText(selfHostExpansionProgress.summary || ''),
      nextAction: shortText(selfHostExpansionProgress.nextAction || ''),
      queuedCount: Number(selfHostExpansionProgress.queuedCount || 0),
      consumedCount: Number(selfHostExpansionProgress.consumedCount || 0),
      successfulCount: Number(selfHostExpansionProgress.successfulCount || 0),
      reviewCount: Number(selfHostExpansionProgress.reviewCount || 0),
      failedCount: Number(selfHostExpansionProgress.failedCount || 0),
      runningCount: Number(selfHostExpansionProgress.runningCount || 0),
      latestSummary: shortText(selfHostExpansionProgress.latestSummary || ''),
      latestTaskId: String(selfHostExpansionProgress.latestTaskId || '').trim(),
      latestRunId: String(selfHostExpansionProgress.latestRunId || '').trim(),
    },
    selfHostProof: {
      label: String(selfHostProof.label || '').trim(),
      summary: shortText(selfHostProof.summary || ''),
    },
    selfImprovementProof: {
      label: String(selfImprovementProof.label || '').trim(),
      summary: shortText(selfImprovementProof.summary || ''),
      nextAction: shortText(selfImprovementProof.nextAction || ''),
    },
    companionParity: {
      label: String(companionParity.label || '').trim(),
      summary: shortText(companionParity.summary || ''),
      nextAction: shortText(companionParity.nextAction || ''),
    },
    modelParity: {
      label: String(modelParity.label || '').trim(),
      summary: shortText(modelParity.summary || ''),
      nextAction: shortText(modelParity.nextAction || ''),
      capabilityCount: Number(modelParity.capabilityCount || 0),
      readyCount: Number(modelParity.readyCount || 0),
    },
    autonomyProof: {
      status: String(autonomyProof.status || '').trim().toLowerCase(),
      label: String(autonomyProof.label || '').trim(),
      summary: shortText(autonomyProof.summary || ''),
      target: Number(autonomyProof.target || 0),
      safeCount: Number(autonomyProof.safeCount || 0),
      overscopedCount: Number(autonomyProof.overscopedCount || 0),
      actionCount: Number(autonomyProof.actionCount || 0),
      workspaceScoped: autonomyProof.workspaceScoped !== false,
      workspaceRoot: String(autonomyProof.workspaceRoot || '').trim(),
    },
    phaseNextMilestone: readiness.phaseNextMilestone && typeof readiness.phaseNextMilestone === 'object' ? {
      id: String(readiness.phaseNextMilestone.id || '').trim(),
      number: Number(readiness.phaseNextMilestone.number || 0),
      label: String(readiness.phaseNextMilestone.label || '').trim(),
      summary: shortText(readiness.phaseNextMilestone.summary || ''),
      monthNumbers: Array.isArray(readiness.phaseNextMilestone.monthNumbers) ? readiness.phaseNextMilestone.monthNumbers.slice() : [],
    } : null,
    dailyTargets: {
      autonomous: autonomy.dailyTarget && typeof autonomy.dailyTarget === 'object' ? autonomy.dailyTarget : {},
      selfImprovement: selfImprovement.dailyTarget && typeof selfImprovement.dailyTarget === 'object' ? selfImprovement.dailyTarget : {},
    },
    overscopedActionCount: Number(
      autonomy.currentWorkspaceOverscopedCount
      ?? autonomy.overscopedCount
      ?? 0
    ),
    dailyQuotaProof,
    recommendedNextSafeAction: String(
      readiness.recommendedNextSafeAction
      || autonomy.recommendedNextSafeAction
      || selfImprovement.recommendedNextSafeAction
      || phaseGate.summary
      || hardGate.summary
      || ''
    ).trim(),
    engineProof: {
      status: latestTask ? 'recorded' : 'missing',
      summary: engineProofSummary,
      modelRole: String(latestRunSummary.modelRole || '').trim().toLowerCase(),
      modelDisplayName: latestModelLabel,
      task: latestTask,
      laneLabel: String(latestRunSummary.laneLabel || '').trim(),
    },
  };
}

function buildSystemCheck(options = {}) {
  const workspaceRoot = path.resolve(String(options.workspaceRoot || process.cwd()).trim());
  const targetWorkspaceRoot = path.resolve(String(options.targetWorkspaceRoot || workspaceRoot).trim());
  const labRoot = String(options.labRoot || '').trim();
  const filters = {
    area: normalizeArea(options.area),
    path: String(options.path || '').trim(),
    runId: String(options.runId || '').trim(),
    task: String(options.task || '').trim(),
  };
  const assistantConfig = options.assistantConfig && typeof options.assistantConfig === 'object'
    ? options.assistantConfig
    : readAssistantConfig(workspaceRoot, { defaultWorkspace: workspaceRoot });
  const tuningSettings = options.tuningSettings && typeof options.tuningSettings === 'object'
    ? options.tuningSettings
    : {};
  const runtimeState = options.runtimeState && typeof options.runtimeState === 'object'
    ? options.runtimeState
    : (readJsonFile(getAssistantRuntimeStatePath(workspaceRoot), { runs: [], activeRuns: [] }) || { runs: [], activeRuns: [] });
  const learningJournalRaw = options.learningJournal
    || (() => {
      const service = new LearningJournalService();
      service.setScope({
        workspaceRoot,
        targetRoot: targetWorkspaceRoot,
        labRoot,
        pollingEnabled: false,
      });
      return service.getStatus();
    })();
  const acceptance = options.acceptance && typeof options.acceptance === 'object'
    ? options.acceptance
    : readLatestAcceptanceReport(workspaceRoot);
  const benchmarks = options.benchmarks && typeof options.benchmarks === 'object'
    ? options.benchmarks
    : listBenchmarkRuns(workspaceRoot);
  const promotions = options.promotions && typeof options.promotions === 'object'
    ? options.promotions
    : listPromotionState(workspaceRoot, { labRoot });
  const acceptanceControl = acceptance?.controlSummary && typeof acceptance.controlSummary === 'object'
    ? acceptance.controlSummary
    : {};
  const latestRun = selectLatestRun(runtimeState, filters, {
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
  });
  const latestRunSummary = buildLatestRunSummary(latestRun, filters.path);
  const benchmarkLeader = Array.isArray(benchmarks?.runs) ? benchmarks.runs[0] : Array.isArray(benchmarks?.benchmarkSummary) ? benchmarks.benchmarkSummary[0] : null;
  const benchmarkLeaderIdentity = benchmarkLeader && typeof benchmarkLeader === 'object'
    ? (benchmarkLeader.benchmarkIdentity && typeof benchmarkLeader.benchmarkIdentity === 'object'
      ? benchmarkLeader.benchmarkIdentity
      : buildBenchmarkIdentity(benchmarkLeader))
    : null;
  const modelRoles = buildModelRoleSummary(assistantConfig, options.aiStatus || null, tuningSettings);
  const tuningStatus = options.tuningStatus && typeof options.tuningStatus === 'object'
    ? options.tuningStatus
    : {};
  const autonomy = buildAutonomousActionSummary({
    runtimeState,
    modelRoles,
    filters,
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
    proofActions: Array.isArray(acceptanceControl?.autonomyProof?.actions)
      ? acceptanceControl.autonomyProof.actions
      : [],
    dailyTarget: Number(assistantConfig?.dailySafeAutonomousTarget || 5),
  });
  const selfImprovement = buildSelfImprovementSummary(workspaceRoot, filters.path, {
    dailyTarget: Number(assistantConfig?.dailySelfImprovementTarget || 5),
    acceptance,
    targetWorkspaceRoot,
    labRoot,
  });
  const taskHub = options.taskHub && typeof options.taskHub === 'object'
    ? options.taskHub
    : readHub(workspaceRoot);
  const vscodeSetup = options.vscodeSetup && typeof options.vscodeSetup === 'object'
    ? options.vscodeSetup
    : buildVsCodeSetupStatus(targetWorkspaceRoot);
  const extensionHealth = options.extensionHealth && typeof options.extensionHealth === 'object'
    ? options.extensionHealth
    : buildVsCodeExtensionHealth(targetWorkspaceRoot);
  const integrations = options.integrations && typeof options.integrations === 'object'
    ? options.integrations
    : buildIntegrationStudioStatus(targetWorkspaceRoot || workspaceRoot);
  const taskHubDaily = buildDailyTaskSummary(taskHub, {
    now: options.now || nowIso(),
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
  });
  const selfHostProof = buildSelfHostProof(acceptance, latestRunSummary);
  const learningJournal = augmentLearningStatusWithLiveEvidence(learningJournalRaw, {
    acceptance,
    selfHostProof,
    selfImprovement,
    promotions,
    benchmarks,
    modelFoundry: options.modelFoundry && typeof options.modelFoundry === 'object' ? options.modelFoundry : {},
    modelRoles,
  });
  const approvedDocsVault = options.approvedDocsVault && typeof options.approvedDocsVault === 'object'
    ? options.approvedDocsVault
    : buildApprovedDocumentationVault(workspaceRoot, {
      context: {
        targetPath: filters.path,
        title: latestRunSummary.task,
        objective: latestRunSummary.summary,
        summary: latestRunSummary.laneLabel,
      },
    });
  const docsLab = buildDocsLabGuidance(approvedDocsVault);
  const modelFoundry = options.modelFoundry && typeof options.modelFoundry === 'object'
    ? options.modelFoundry
    : buildModelFoundryStatus(workspaceRoot, {
      benchmarks,
      learning: learningJournal,
      acceptance,
      readiness: options.readiness && typeof options.readiness === 'object' ? options.readiness : {},
    });
  const learningJournalAugmented = augmentLearningStatusWithLiveEvidence(learningJournal, {
    acceptance,
    selfHostProof,
    selfImprovement,
    promotions,
    benchmarks,
    modelFoundry,
    modelRoles,
  });
  const modelProvisioning = buildModelProvisioningArea(assistantConfig, options.aiStatus || null, tuningStatus);
  const modelExecutionRoles = mergeModelExecutionRoleProvisioning(modelRoles, modelProvisioning);
  const localModelInventory = options.aiStatus?.localModelInventory && typeof options.aiStatus.localModelInventory === 'object'
    ? options.aiStatus.localModelInventory
    : {};
  const readiness = options.readiness && typeof options.readiness === 'object'
    ? options.readiness
    : buildReadinessSnapshot(learningJournalAugmented, promotions, acceptance, modelRoles, {
      now: options.now || nowIso(),
      autonomy,
      selfImprovement,
      taskHub,
      workspaceRoot,
      targetWorkspaceRoot,
      labRoot,
      integrations,
      benchmarks,
      vscodeSetup,
      extensionHealth,
      modelProvisioning,
      approvedDocsVault,
    });
  const trustSummary = latestRunSummary.trustSummary || {};
  const reviewSummary = latestRunSummary.reviewSummary || {};
  const acceptanceArea = buildAcceptanceArea(acceptance);
  const acceptanceAreaControl = acceptanceArea.controlSummary || {};
  const acceptanceStatus = String(
    acceptanceArea.latestAcceptanceStatus
    || acceptance?.report?.overallStatus
    || acceptance?.overallStatus
    || '',
  ).trim().toLowerCase();
  const validation = buildValidationRollup(acceptance, latestRunSummary, autonomy);
  const roadmap = buildRoadmapArea(readiness, autonomy, selfImprovement, latestRunSummary, taskHubDaily, validation, acceptanceArea);
  const learningMemoryHints = mergeMemoryHints(
    learningJournalAugmented?.memoryHints,
    latestRunSummary?.learningMetadata?.memoryHints,
    latestRunSummary?.memoryHints,
  );
  const selfImprovementProof = selfImprovement?.proof && typeof selfImprovement.proof === 'object' ? selfImprovement.proof : {};

  const areas = {
    roadmap,
    engine: {
      status: acceptanceStatus || (latestRunSummary.runState || 'ready'),
      summary: shortText(
        acceptanceControl.nextDaySummary
        || acceptanceAreaControl.acceptanceSummary
        || acceptance?.report?.summary
        || acceptance?.summary
        || readiness.summary
        || 'Engine status is available.',
      ),
      targetWorkspaceRoot,
      labRoot,
      benchmarkLeader: benchmarkLeader ? {
        model: String(benchmarkLeader.model || '').trim(),
        modelProfileId: String(benchmarkLeader.modelProfileId || '').trim(),
        passRate: Number(benchmarkLeader.passRate || 0),
        averageLatencyMs: Number(benchmarkLeader.averageLatencyMs || 0),
      } : null,
      nextSafeAction: String(
        roadmap.dailyQuotaProof?.doNotWidenYetBecause
        || roadmap.recommendedNextSafeAction
        || readiness.recommendedNextSafeAction
        || ((autonomy.status === 'fail' || autonomy.status === 'warn')
          ? autonomy.recommendedNextSafeAction
          : '')
        || readiness?.roadmapNextMilestone?.summary
        || readiness?.nextMilestone?.summary
        || acceptanceAreaControl.nextSafeAction
        || acceptance?.report?.nextAction
        || '',
      ).trim(),
    },
    runs: {
      status: latestRunSummary.status,
      summary: latestRunSummary.summary,
      activeRunCount: Array.isArray(runtimeState?.activeRuns) ? runtimeState.activeRuns.length : Number(runtimeState?.activeRuns || 0),
      latestRun: latestRunSummary,
    },
    trust: {
      status: String(trustSummary.trust_state || trustSummary.status || latestRunSummary.status || 'unknown').trim().toLowerCase(),
      summary: shortText(
        trustSummary.summary
        || reviewSummary.summary
        || latestRunSummary.summary
        || 'No trust summary is available yet.',
      ),
      trustSummary,
      reviewSummary,
    },
    learning: {
      status: String(selfImprovementProof.status || learningJournalAugmented?.trainingReadiness?.status || 'idle').trim().toLowerCase(),
      summary: shortText(
        [
          learningJournalAugmented?.trainingReadiness?.summary,
          learningJournalAugmented?.gsDev1ExportReadiness?.summary,
          learningMemoryHints?.summary,
          selfHostProof?.summary,
          selfImprovementProof?.summary,
          docsLab.status !== 'ready' ? docsLab.summary : '',
        ].filter(Boolean).join(' ')
        || 'Learning status is available.',
      ),
      trainingReadiness: learningJournalAugmented?.trainingReadiness || {},
      exportReadiness: learningJournalAugmented?.gsDev1ExportReadiness || {},
      memoryHints: learningMemoryHints,
      selfHostProof,
      selfImprovementProof,
      docsContext: docsLab,
    },
    promotion: {
      status: String(promotions?.promotionGate?.status || 'blocked').trim().toLowerCase(),
      summary: shortText(
        [
          promotions?.promotionGate?.summary,
          promotions?.latestBackupId ? `Rollback backup ${String(promotions.latestBackupId || '').trim()} is ready.` : '',
        ].filter(Boolean).join(' ')
        || acceptance?.report?.summary
        || 'Promotion gate status is available.',
      ),
      readyCandidateCount: Array.isArray(promotions?.readyCandidates) ? promotions.readyCandidates.length : 0,
      latestBackupId: String(promotions?.latestBackupId || '').trim(),
      currentCandidateIdentity: promotions?.currentCandidateIdentity || null,
      benchmarkIdentity: promotions?.currentBenchmarkIdentity || null,
    },
    models: {
      ...modelRoles,
      status: modelProvisioning.status || modelRoles.status,
      summary: shortText(`${modelRoles.summary}. ${modelProvisioning.summary || ''}${localModelInventory.summary ? ` ${localModelInventory.summary}` : ''}${modelFoundry.summary ? ` ${modelFoundry.summary}` : ''}`),
      roles: modelExecutionRoles,
      provisioning: modelProvisioning,
      integrations,
      localInventory: localModelInventory,
      benchmarkLeaderIdentity,
      foundryNextCandidateIdentity: modelFoundry?.nextCandidateIdentity || modelFoundry?.nextCandidate?.modelIdentity || null,
      promotionCandidateIdentity: promotions?.currentCandidateIdentity || null,
    },
    autonomy: {
      ...autonomy,
      autonomyProof: acceptanceArea.autonomyProof && typeof acceptanceArea.autonomyProof === 'object'
        ? acceptanceArea.autonomyProof
        : {},
    },
    'self-improvement': selfImprovement,
    acceptance: acceptanceArea,
  };

  let headline = areas.engine.summary || 'System status is available.';
  if (areas.acceptance.status === 'fail') {
    headline = areas.acceptance.summary;
  } else if (areas.runs.status === 'fail' || areas.runs.status === 'cancelled') {
    headline = areas.runs.summary;
  } else if (areas.models.status === 'fail') {
    headline = areas.models.summary;
  } else if (areas.roadmap.status === 'blocked') {
    headline = areas.roadmap.summary;
  } else if (areas.autonomy.status === 'fail') {
    headline = areas.autonomy.summary;
  } else if (areas['self-improvement'].preparedTaskCount > 0) {
    headline = areas['self-improvement'].summary;
  }

  return {
    ok: true,
    generatedAt: nowIso(),
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
    filters,
    summary: headline,
    areas,
    commands: {
      default: 'npm run system:check',
      roadmap: 'npm run system:check -- --area roadmap',
      trust: 'npm run system:check -- --area trust',
      autonomy: 'npm run system:check -- --area autonomy',
      path: 'npm run system:check -- --path renderer/app.js',
      json: 'npm run system:check -- --json',
    },
  };
}

function renderTextBlock(label, value, options = {}) {
  const compact = options.compact === true;
  if (compact) {
    return `${label}: ${shortText(value, 140)}`;
  }
  return `${label}: ${value}`;
}

function renderSystemCheck(report, options = {}) {
  const compact = options.compact === true;
  const area = normalizeArea(options.area || report?.filters?.area);
  const blocks = [];
  blocks.push(renderTextBlock('Summary', report?.summary || 'System status unavailable.', { compact }));
  blocks.push(renderTextBlock('Workspace', report?.workspaceRoot || '', { compact }));
  blocks.push(renderTextBlock('Target', report?.targetWorkspaceRoot || '', { compact }));
  if (report?.labRoot) {
    blocks.push(renderTextBlock('Lab', report.labRoot, { compact }));
  }
  const areaEntries = area
    ? [[area, report?.areas?.[area] || {}]]
    : Object.entries(report?.areas || {});
  for (const [areaId, payload] of areaEntries) {
    blocks.push('');
    blocks.push(`[${areaId}] ${String(payload?.status || 'unknown').toUpperCase()}`);
    if (payload?.summary) {
      blocks.push(shortText(payload.summary, compact ? 160 : 240));
    }
    if (areaId === 'roadmap') {
      if (payload?.currentPhase?.label) {
        blocks.push(renderTextBlock('Current phase', payload.currentPhase.label, { compact }));
      }
      if (payload?.currentPhase?.summary) {
        blocks.push(renderTextBlock('Phase goal', payload.currentPhase.summary, { compact }));
      }
      if (payload?.phaseGate?.label) {
        blocks.push(renderTextBlock('Phase gate', `${payload.phaseGate.label} | ${payload.phaseGate.summary || ''}`, { compact }));
      }
      if (payload?.phaseProof?.summary) {
        blocks.push(renderTextBlock('Phase proof', payload.phaseProof.summary, { compact }));
      }
      if (payload?.internalAudit?.summary) {
        blocks.push(renderTextBlock('Internal audit', payload.internalAudit.summary, { compact }));
      } else if (payload?.currentMonth?.label) {
        blocks.push(renderTextBlock('Internal month', payload.currentMonth.label, { compact }));
      }
      if (payload?.phasePercent || payload?.roadmapPercent) {
        blocks.push(renderTextBlock(
          'Phase score',
          `${Number(payload?.phasePercent || 0)}% | roadmap ${Number(payload?.roadmapPercent || 0)}%`,
          { compact },
        ));
      }
      if (Array.isArray(payload?.phaseScorecards) && payload.phaseScorecards.length > 0) {
        payload.phaseScorecards.slice(0, 5).forEach((card) => {
          blocks.push(renderTextBlock(
            card.label || `Phase ${Number(card.number || 0)}`,
            `${Number(card.completion || 0)}% | ${card.gateLabel || card.status || 'unknown'} | ${card.gateSummary || card.goal || ''}`,
            { compact },
          ));
        });
      } else if (payload?.hardGate?.label) {
        blocks.push(renderTextBlock('Internal month gate', `${payload.hardGate.label} | ${payload.hardGate.summary || ''}`, { compact }));
      }
      blocks.push(renderTextBlock(
        'Daily targets',
        `autonomy ${Number(payload?.dailyTargets?.autonomous?.safeCount || 0)}/${Number(payload?.dailyTargets?.autonomous?.target || 0)} | self-improvement ${Number(payload?.dailyTargets?.selfImprovement?.safeCount || 0)}/${Number(payload?.dailyTargets?.selfImprovement?.target || 0)}`,
        { compact },
      ));
      if (payload?.dailyQuotaProof?.focusTask?.title) {
        blocks.push(renderTextBlock('Focus task', payload.dailyQuotaProof.focusTask.title, { compact }));
      }
      blocks.push(renderTextBlock('Blocked or rescoped', `${Number(payload?.dailyQuotaProof?.blockedRescopedCount || 0)}`, { compact }));
      if (payload?.dailyQuotaProof?.validation?.label) {
        blocks.push(renderTextBlock(
          'Validation',
          `${payload.dailyQuotaProof.validation.label} | ${Number(payload?.dailyQuotaProof?.validation?.passCount || 0)} pass | ${Number(payload?.dailyQuotaProof?.validation?.failCount || 0)} fail | ${Number(payload?.dailyQuotaProof?.validation?.reviewBlockedCount || 0)} review-held`,
          { compact },
        ));
      }
      blocks.push(renderTextBlock('Overscoped actions', `${Number(payload?.overscopedActionCount || 0)}`, { compact }));
      if (payload?.autonomyProof?.summary) {
        blocks.push(renderTextBlock(
          'Autonomy proof',
          `${String(payload.autonomyProof.label || payload.autonomyProof.status || 'unknown').toUpperCase()} | ${payload.autonomyProof.summary}`,
          { compact },
        ));
      }
      if (payload?.recommendedNextSafeAction) {
        blocks.push(renderTextBlock('Next phase-safe action', payload.recommendedNextSafeAction, { compact }));
      }
      if (payload?.selfHostExpansion?.summary) {
        blocks.push(renderTextBlock(
          'Self-host expansion',
          `${String(payload.selfHostExpansion.label || payload.selfHostExpansion.status || 'unknown').toUpperCase()} | ${payload.selfHostExpansion.summary}`,
          { compact },
        ));
      }
      if (payload?.selfHostExpansionProgress?.summary) {
        blocks.push(renderTextBlock(
          'Self-host expansion outcome',
          `${String(payload.selfHostExpansionProgress.label || payload.selfHostExpansionProgress.status || 'unknown').toUpperCase()} | ${payload.selfHostExpansionProgress.summary}`,
          { compact },
        ));
      }
      if (payload?.selfHostExpansionProgress?.nextAction) {
        blocks.push(renderTextBlock(
          'Self-host expansion next step',
          payload.selfHostExpansionProgress.nextAction,
          { compact },
        ));
      }
      if (payload?.selfImprovementProof?.summary) {
        blocks.push(renderTextBlock(
          'Self-improvement proof',
          `${String(payload.selfImprovementProof.label || 'unknown').toUpperCase()} | ${payload.selfImprovementProof.summary}`,
          { compact },
        ));
      }
      if (payload?.selfImprovementProof?.nextAction) {
        blocks.push(renderTextBlock('Self-improvement next step', payload.selfImprovementProof.nextAction, { compact }));
      }
      if (payload?.companionParity?.summary) {
        blocks.push(renderTextBlock(
          'Companion parity',
          `${String(payload.companionParity.label || 'unknown').toUpperCase()} | ${payload.companionParity.summary}`,
          { compact },
        ));
      }
      if (payload?.companionParity?.nextAction) {
        blocks.push(renderTextBlock('Companion next step', payload.companionParity.nextAction, { compact }));
      }
      if (payload?.modelParity?.summary) {
        blocks.push(renderTextBlock(
          'Model parity',
          `${String(payload.modelParity.label || 'unknown').toUpperCase()} | ${payload.modelParity.summary}`,
          { compact },
        ));
      }
      if (payload?.modelParity?.nextAction) {
        blocks.push(renderTextBlock('Model parity next step', payload.modelParity.nextAction, { compact }));
      }
      if (payload?.phaseCloseout?.summary) {
        blocks.push(renderTextBlock(
          'Phase closeout',
          `${String(payload.phaseCloseout.label || payload.phaseCloseout.status || 'unknown').toUpperCase()} | ${payload.phaseCloseout.summary}`,
          { compact },
        ));
      }
      if (Array.isArray(payload?.phaseCloseout?.blockers) && payload.phaseCloseout.blockers.length > 0) {
        blocks.push(renderTextBlock('Closeout blockers', payload.phaseCloseout.blockers.join(' • '), { compact }));
      }
      if (payload?.phaseCloseout?.nextAction) {
        blocks.push(renderTextBlock('Closeout next step', payload.phaseCloseout.nextAction, { compact }));
      }
      if (payload?.nextPhasePreview?.label) {
        blocks.push(renderTextBlock(
          'Next phase preview',
          `${payload.nextPhasePreview.label} | ${payload.nextPhasePreview.summary || payload.nextPhasePreview.gateSummary || ''}`,
          { compact },
        ));
      }
      if (payload?.phaseNextMilestone?.label) {
        blocks.push(renderTextBlock('Next phase milestone', payload.phaseNextMilestone.label, { compact }));
      }
      if (payload?.dailyQuotaProof?.doNotWidenYetBecause) {
        blocks.push(renderTextBlock('Do not widen yet', payload.dailyQuotaProof.doNotWidenYetBecause, { compact }));
      }
      if (payload?.engineProof?.summary) {
        blocks.push(renderTextBlock('Engine proof', payload.engineProof.summary, { compact }));
      }
    }
    if (areaId === 'runs' && payload?.latestRun?.task) {
      blocks.push(renderTextBlock('Task', payload.latestRun.task, { compact }));
      blocks.push(renderTextBlock('Lane', payload.latestRun.laneLabel || 'n/a', { compact }));
      blocks.push(renderTextBlock('Model', payload.latestRun.modelDisplayName || payload.latestRun.modelProfileId || 'n/a', { compact }));
    }
    if (areaId === 'models') {
      blocks.push(renderTextBlock('Workspace coding model', payload?.workspace?.modelDisplayName || payload?.workspace?.modelProfileId || 'unset', { compact }));
      blocks.push(renderTextBlock('Engine control model', payload?.engine?.modelDisplayName || payload?.engine?.modelProfileId || 'unset', { compact }));
      if (Array.isArray(payload?.roles)) {
        payload.roles.slice(0, 3).forEach((role) => {
          const lanes = Array.isArray(role?.laneIds) ? role.laneIds.filter(Boolean).join(', ') : '';
          const fallback = role?.fallbackModel
            ? ` | fallback ${String(role.fallbackProvider || role.providerSource || '').trim().toLowerCase() || 'auto'}:${role.fallbackModel}`
            : '';
          const readiness = role?.provisioningState
            ? ` | ${String(role.provisioningState || '').trim().toUpperCase()}`
            : '';
          blocks.push(renderTextBlock(
            String(role?.label || role?.id || 'Role'),
            `${String(role?.wrappedProfileLabel || role?.wrappedProfileId || 'unset')} | ${String(role?.providerSource || role?.baseProvider || 'unknown').trim().toLowerCase()}:${String(role?.baseModel || 'unset')}${lanes ? ` | lanes ${lanes}` : ''}${fallback}${readiness}`,
            { compact },
          ));
        });
      }
      if (payload?.provisioning?.summary) {
        blocks.push(renderTextBlock(
          'Provisioning',
          `${String(payload.provisioning.status || 'unknown').toUpperCase()} | ${payload.provisioning.summary}`,
          { compact },
        ));
      }
      if (Array.isArray(payload?.provisioning?.routeCoverage?.missingLiveModels) && payload.provisioning.routeCoverage.missingLiveModels.length > 0) {
        blocks.push(renderTextBlock(
          'Missing live tags',
          payload.provisioning.routeCoverage.missingLiveModels.join(', '),
          { compact },
        ));
      }
      if (payload?.provisioning?.recommendedAction) {
        blocks.push(renderTextBlock('Next safe action', payload.provisioning.recommendedAction, { compact }));
      }
      if (payload?.localInventory?.summary) {
        blocks.push(renderTextBlock(
          'Local inventory',
          `${String(payload.localInventory.status || 'unknown').toUpperCase()} | ${payload.localInventory.summary}`,
          { compact },
        ));
      }
      if (Array.isArray(payload?.localInventory?.entries)) {
        payload.localInventory.entries.slice(0, 4).forEach((entry) => {
          const profile = entry?.wrappedProfileId ? ` | profile ${String(entry.wrappedProfileId || '').trim()}` : '';
          const family = entry?.modelFamily ? ` | family ${String(entry.modelFamily || '').trim()}` : '';
          const installState = entry?.installState ? ` | ${String(entry.installState || '').trim()}` : '';
          const foundry = entry?.foundryCandidate?.id ? ` | foundry ${String(entry.foundryCandidate.id || '').trim()}` : '';
          const benchmark = entry?.benchmarkIdentity?.id ? ` | bench ${String(entry.benchmarkIdentity.id || '').trim()}` : '';
          blocks.push(renderTextBlock(
            entry.kind === 'foundry-candidate'
              ? `Candidate ${String(entry.label || entry.id || 'candidate').trim()}`
              : String(entry.label || entry.wrappedProfileId || entry.id || 'Local model'),
            `${String(entry.providerSource || 'unknown').trim().toLowerCase() || 'unknown'}:${String(entry.baseModel || 'unset').trim() || 'unset'}${profile}${family} | ${String(entry.localReadiness || 'unknown').trim().toUpperCase()}${installState}${foundry}${benchmark}`,
            { compact },
          ));
        });
      }
      if (payload?.benchmarkLeaderIdentity) {
        blocks.push(renderTextBlock('Benchmark leader', describeModelIdentity(payload.benchmarkLeaderIdentity), { compact }));
      }
      if (payload?.foundryNextCandidateIdentity) {
        blocks.push(renderTextBlock('Foundry next', describeModelIdentity(payload.foundryNextCandidateIdentity), { compact }));
      }
      if (payload?.promotionCandidateIdentity) {
        blocks.push(renderTextBlock('Promotion candidate', describeModelIdentity(payload.promotionCandidateIdentity), { compact }));
      }
    }
    if (areaId === 'learning') {
      if (payload?.trainingReadiness?.summary) {
        blocks.push(renderTextBlock(
          'Training handoff',
          `${String(payload.trainingReadiness.status || 'unknown').toUpperCase()} | ${payload.trainingReadiness.summary}`,
          { compact },
        ));
      }
      if (payload?.exportReadiness?.summary) {
        blocks.push(renderTextBlock(
          'GS-Dev-1 export',
          `${String(payload.exportReadiness.status || (payload.exportReadiness.ready ? 'ready' : 'unknown')).toUpperCase()} | ${payload.exportReadiness.summary}`,
          { compact },
        ));
      }
      if (payload?.memoryHints?.summary) {
        blocks.push(renderTextBlock('Reject patterns', payload.memoryHints.summary, { compact }));
      }
      if (payload?.memoryHints?.topRejectReason) {
        blocks.push(renderTextBlock('Top reject reason', payload.memoryHints.topRejectReason, { compact }));
      }
      if (payload?.memoryHints?.topFixPattern) {
        blocks.push(renderTextBlock('How to fix', payload.memoryHints.topFixPattern, { compact }));
      }
      if (payload?.memoryHints?.recommendedResponse) {
        blocks.push(renderTextBlock('Preferred response', payload.memoryHints.recommendedResponse, { compact }));
      }
      if (payload?.memoryHints?.topPhaseLabel || payload?.memoryHints?.phaseSummary) {
        blocks.push(renderTextBlock(
          'Phase focus',
          payload.memoryHints.phaseSummary || payload.memoryHints.topPhaseLabel,
          { compact },
        ));
      }
      if (Array.isArray(payload?.memoryHints?.topPaths) && payload.memoryHints.topPaths.length > 0) {
        const topPath = payload.memoryHints.topPaths[0];
        blocks.push(renderTextBlock(
          'Learned path',
          String(topPath?.value || topPath || '').trim(),
          { compact },
        ));
      }
      if (payload?.selfHostProof?.summary) {
        blocks.push(renderTextBlock(
          'Self-host proof',
          `${String(payload.selfHostProof.label || payload.selfHostProof.status || 'unknown').toUpperCase()} | ${payload.selfHostProof.summary}`,
          { compact },
        ));
      }
      if (payload?.selfHostProof?.blockerSummary) {
        blocks.push(renderTextBlock('Self-host blocker', payload.selfHostProof.blockerSummary, { compact }));
      }
      if (payload?.selfHostProof?.nextAction) {
        blocks.push(renderTextBlock('Self-host next step', payload.selfHostProof.nextAction, { compact }));
      }
      if (payload?.selfImprovementProof?.summary) {
        blocks.push(renderTextBlock(
          'Self-improvement proof',
          `${String(payload.selfImprovementProof.label || payload.selfImprovementProof.status || 'unknown').toUpperCase()} | ${payload.selfImprovementProof.summary}`,
          { compact },
        ));
      }
      if (payload?.selfImprovementProof?.nextAction) {
        blocks.push(renderTextBlock('Self-improvement next step', payload.selfImprovementProof.nextAction, { compact }));
      }
      if (payload?.docsContext?.summary) {
        blocks.push(renderTextBlock(
          'Docs lab',
          `${String(payload.docsContext.status || 'unknown').toUpperCase()} | ${payload.docsContext.summary}`,
          { compact },
        ));
      }
      if (payload?.docsContext?.recommendedAction) {
        blocks.push(renderTextBlock('Docs next step', payload.docsContext.recommendedAction, { compact }));
      }
    }
    if (areaId === 'autonomy') {
      blocks.push(renderTextBlock(
        'Workspace scoped',
        payload?.workspaceScoped === false ? 'no' : 'yes',
        { compact },
      ));
      blocks.push(renderTextBlock(
        'Daily target',
        `${Number(payload?.dailyTarget?.safeCount || 0)}/${Number(payload?.dailyTarget?.target || 0)} safe today`,
        { compact },
      ));
      blocks.push(renderTextBlock(
        'Current workspace',
        `${Number(payload?.currentWorkspaceSafeCount || 0)}/${Number(payload?.currentWorkspaceActionCount || 0)} safe actions today | overscoped ${Number(payload?.currentWorkspaceOverscopedCount || 0)}`,
        { compact },
      ));
      blocks.push(renderTextBlock(
        'Historical actions',
        `${Number(payload?.historicalActionCount || 0)} scoped action(s) | overscoped ${Number(payload?.historicalOverscopedCount || 0)}`,
        { compact },
      ));
      blocks.push(renderTextBlock('Average score', `${Number(payload?.averageAutomationScore || 0)}`, { compact }));
      if (payload?.autonomyProof?.summary) {
        blocks.push(renderTextBlock(
          'Autonomy proof',
          `${String(payload.autonomyProof.label || payload.autonomyProof.status || 'unknown').toUpperCase()} | ${payload.autonomyProof.summary}`,
          { compact },
        ));
      }
      if (payload?.recommendedNextSafeAction) {
        blocks.push(renderTextBlock('Next safe action', payload.recommendedNextSafeAction, { compact }));
      }
      if (payload?.highestRiskAction?.task || payload?.highestRiskAction?.label) {
        blocks.push(renderTextBlock(
          'Highest risk',
          `${payload.highestRiskAction.task || payload.highestRiskAction.label} | job ${payload.highestRiskAction.difficultyLevel}/5 vs model ${payload.highestRiskAction.modelLevel}/5 (${payload.highestRiskAction.capabilityFit})`,
          { compact },
        ));
      }
    }
    if (areaId === 'self-improvement') {
      blocks.push(renderTextBlock(
        'Daily target',
        `${Number(payload?.dailyTarget?.safeCount || 0)}/${Number(payload?.dailyTarget?.target || 0)} safe today`,
        { compact },
      ));
      blocks.push(renderTextBlock('Prepared tasks', `${Number(payload?.preparedTaskCount || 0)}`, { compact }));
      if (payload?.proof?.summary) {
        blocks.push(renderTextBlock(
          'Self-improvement proof',
          `${String(payload.proof.label || payload.proof.status || 'unknown').toUpperCase()} | ${payload.proof.summary}`,
          { compact },
        ));
      }
      if (payload?.recommendedNextSafeAction) {
        blocks.push(renderTextBlock('Next safe action', payload.recommendedNextSafeAction, { compact }));
      }
      if (payload?.lastExecution?.status) {
        blocks.push(renderTextBlock(
          'Last execution',
          `${payload.lastExecution.status} | ${payload.lastExecution.taskId || payload.lastExecution.candidateId || 'unknown task'}`,
          { compact },
        ));
      }
    }
    if (areaId === 'acceptance') {
      if (payload?.outputPath) {
        blocks.push(renderTextBlock('Report', payload.outputPath, { compact }));
      }
      if (payload?.latestAcceptanceLabel || payload?.latestAcceptanceAt) {
        blocks.push(renderTextBlock(
          'Latest acceptance',
          [payload.latestAcceptanceLabel || 'UNKNOWN', payload.latestAcceptanceAt || 'time unknown'].filter(Boolean).join(' | '),
          { compact },
        ));
      }
      if (payload?.latestSmokeLabel || payload?.smokeSummary) {
        blocks.push(renderTextBlock(
          'Latest smoke',
          [payload.latestSmokeLabel || 'NOT RUN', payload.smokeSummary || '', payload.latestSmokeAt || ''].filter(Boolean).join(' | '),
          { compact },
        ));
      }
      if (payload?.blockerCount > 0 || payload?.blockerSummary) {
        blocks.push(renderTextBlock('Blockers', payload.blockerSummary || 'No acceptance blockers are recorded.', { compact }));
      }
      if (payload?.autonomyProof?.summary) {
        blocks.push(renderTextBlock(
          'Autonomy proof',
          `${String(payload.autonomyProof.label || payload.autonomyProof.status || 'unknown').toUpperCase()} | ${payload.autonomyProof.summary}`,
          { compact },
        ));
      }
      if (payload?.selfImprovementProof?.summary) {
        blocks.push(renderTextBlock(
          'Self-improvement proof',
          `${String(payload.selfImprovementProof.label || payload.selfImprovementProof.status || 'unknown').toUpperCase()} | ${payload.selfImprovementProof.summary}`,
          { compact },
        ));
      }
      if (payload?.builderProof?.summary) {
        blocks.push(renderTextBlock(
          'Builder proof',
          `${String(payload.builderProof.label || payload.builderProof.status || 'unknown').toUpperCase()} | ${payload.builderProof.summary}`,
          { compact },
        ));
      }
      if (payload?.nextDayLabel || payload?.nextDaySummary) {
        blocks.push(renderTextBlock(
          'Next day gate',
          [payload.nextDayLabel || 'BLOCKED', payload.nextDaySummary || ''].filter(Boolean).join(' | '),
          { compact },
        ));
      }
      if (payload?.nextSafeAction) {
        blocks.push(renderTextBlock('Next safe action', payload.nextSafeAction, { compact }));
      }
    }
    if (areaId === 'promotion') {
      blocks.push(renderTextBlock('Ready candidates', `${Number(payload?.readyCandidateCount || 0)}`, { compact }));
      if (payload?.currentCandidateIdentity) {
        blocks.push(renderTextBlock('Current candidate', describeModelIdentity(payload.currentCandidateIdentity), { compact }));
      }
      if (payload?.benchmarkIdentity) {
        blocks.push(renderTextBlock('Linked benchmark', describeModelIdentity({ benchmarkIdentity: payload.benchmarkIdentity }), { compact }));
      }
      if (payload?.latestBackupId) {
        blocks.push(renderTextBlock('Latest backup', payload.latestBackupId, { compact }));
      }
    }
  }
  blocks.push('');
  blocks.push('Commands:');
  blocks.push(`- ${report?.commands?.default || 'npm run system:check'}`);
  blocks.push(`- ${report?.commands?.roadmap || 'npm run system:check -- --area roadmap'}`);
  blocks.push(`- ${report?.commands?.trust || 'npm run system:check -- --area trust'}`);
  blocks.push(`- ${report?.commands?.autonomy || 'npm run system:check -- --area autonomy'}`);
  blocks.push(`- ${report?.commands?.path || 'npm run system:check -- --path renderer/app.js'}`);
  blocks.push(`- ${report?.commands?.json || 'npm run system:check -- --json'}`);
  return blocks.join('\n').trim();
}

module.exports = {
  SYSTEM_CHECK_AREAS,
  augmentLearningStatusWithLiveEvidence,
  buildAppRollbackStatus,
  buildSelfImprovementSummary,
  buildSystemCheck,
  buildWorkspaceUpdateStatus,
  renderSystemCheck,
};
