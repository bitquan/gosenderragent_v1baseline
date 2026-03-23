'use strict';

const EventEmitter = require('events');
const path = require('path');
const { RUN_STATES, DEFAULTS } = require('./constants');
const {
  readJsonFile,
  writeJsonFileAtomic,
  randomId,
  nowIso,
  parseFailureLocationsFromChecks,
} = require('./utils');
const { runPreflight } = require('./preflight');
const { AgentRuntimeClient } = require('./agent-runtime-client');
const { getAssistantRuntimeStatePath } = require('../core/assistant-paths');
const { buildNextActionRecipe } = require('../core/followup-recipes');

function normalizeRecoveredRun(run) {
  if (!run || typeof run !== 'object') {
    return run;
  }
  const logTail = String(run.logTail || '');
  const skippedDone = /Skipping BAT<\d+>.*status is DONE/i.test(logTail);
  if (!skippedDone) {
    return run;
  }
  return {
    ...run,
    state: RUN_STATES.SKIPPED,
    checks: [],
    locations: [],
    artifactPaths: [],
  };
}

function isSkippedDoneLog(text) {
  return /Skipping BAT<\d+>.*status is DONE/i.test(String(text || ''));
}

function isNoEligibleTicketsLog(text) {
  return /No tickets matched sprint filters/i.test(String(text || ''));
}

function normalizeReviewSummary(value) {
  const summary = value && typeof value === 'object' ? value : {};
  const reviewedPaths = Array.isArray(summary.reviewed_paths)
    ? summary.reviewed_paths
    : (Array.isArray(summary.reviewedPaths) ? summary.reviewedPaths : []);
  return {
    requiresManualReview: summary.requires_manual_review === true || summary.requiresManualReview === true,
    pendingApprovalCount: Number(summary.pending_approval_count ?? summary.pendingApprovalCount ?? 0),
    lowConfidencePatchCount: Number(summary.low_confidence_patch_count ?? summary.lowConfidencePatchCount ?? 0),
    failedStepCount: Number(summary.failed_step_count ?? summary.failedStepCount ?? 0),
    summary: String(summary.summary || ''),
    activeFilePath: String(summary.active_file_path || summary.activeFilePath || ''),
    reviewedPaths: reviewedPaths.map((item) => String(item || '')).filter(Boolean),
  };
}

function normalizeApprovalRequests(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => {
    const input = item && typeof item.input === 'object' ? item.input : {};
    return {
      id: String(item?.id || ''),
      agent: String(item?.agent || ''),
      tool: String(item?.tool || ''),
      reason: String(item?.reason || ''),
      safetyLevel: String(item?.safety_level || item?.safetyLevel || ''),
      path: String(input.path || item?.path || ''),
      input,
    };
  }).filter((item) => item.path || item.id);
}

function normalizeRuntimeContext(value) {
  return value && typeof value === 'object' ? value : {};
}

function normalizeSummaryObject(value) {
  return value && typeof value === 'object' ? value : {};
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
    topPaths: Array.isArray(current.topPaths) && current.topPaths.length > 0
      ? current.topPaths
      : hints.topPaths,
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

function normalizeMemoryAction(value) {
  const action = String(value || '').trim().toLowerCase();
  if (!action) {
    return '';
  }
  if (['repair-loop', 'repair', 'repair-loop-retry'].includes(action)) {
    return 'repair-loop';
  }
  if (['retry-with-research', 'research', 'bridge-plan-retry', 'research-expansion'].includes(action)) {
    return 'retry-with-research';
  }
  if (['review-interrupt', 'review', 'approval-review', 'manual-review'].includes(action)) {
    return 'review-interrupt';
  }
  if (['continue-run', 'continue'].includes(action)) {
    return 'continue-run';
  }
  if (['open-files', 'open-file'].includes(action)) {
    return 'open-files';
  }
  if (['open-trace', 'trace'].includes(action)) {
    return 'open-trace';
  }
  if (['open-sandbox', 'sandbox', 'sandbox-retry'].includes(action)) {
    return 'open-sandbox';
  }
  return action;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObjectArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object').map((item) => ({ ...item }))
    : [];
}



function normalizeRuntimeTimeline(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => ({
    timestamp: String(item?.timestamp || item?.time || '').trim(),
    stage: String(item?.stage || '').trim(),
    event: String(item?.event || '').trim(),
    summary: String(item?.summary || '').trim(),
    agent: String(item?.agent || '').trim(),
    provider: String(item?.provider || '').trim(),
    model: String(item?.model || '').trim(),
  })).filter((item) => item.stage || item.summary).slice(-24);
}

function summarizeProviderAccountability(run = {}, seed = {}) {
  const routing = normalizeSummaryObject(
    seed.providerRouting
    || seed.provider_routing
    || run.providerRouting
    || run.provider_routing
    || run.runtimeResult?.provider_routing
    || run.runtimeResult?.providerRouting
  );
  const lanes = Object.entries(routing).map(([lane, value]) => ({
    lane,
    provider: String(value?.provider || '').trim(),
    model: String(value?.model || '').trim(),
  })).filter((item) => item.provider || item.model);
  return {
    lanes,
    summary: lanes.map((item) => `${item.lane}:${item.provider || 'provider'}${item.model ? `/${item.model}` : ''}`).join(' | '),
  };
}
function clipTail(value, maxChars = 4000) {
  return String(value || '').slice(-maxChars);
}

function normalizeTaskLoopMode(value, fallbackAction = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'planner') {
    return 'planner';
  }
  if (normalized === 'validator' || normalized === 'review') {
    return 'validator';
  }
  if (normalized === 'summarizer' || normalized === 'summary') {
    return 'summarizer';
  }
  if (normalized === 'repair') {
    return 'repair';
  }
  if (normalized === 'research') {
    return 'research';
  }
  if (normalized === 'chat') {
    return 'chat';
  }
  if (normalized === 'implementer' || normalized === 'coder') {
    return 'coder';
  }
  if (normalized === 'plan') {
    return 'planner';
  }
  if (normalized === 'run') {
    return 'validator';
  }
  if (normalized === 'implement') {
    return 'coder';
  }
  if (normalized === 'release') {
    return 'summarizer';
  }
  return fallbackAction === 'plan'
    ? 'planner'
    : fallbackAction === 'run'
      ? 'validator'
      : fallbackAction === 'repair'
        ? 'repair'
        : fallbackAction === 'summarize'
          ? 'summarizer'
          : 'coder';
}

function normalizeChangedFiles(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object') {
      return null;
    }
    return {
      path: String(item.path || '').trim(),
      status: String(item.status || '').trim(),
    };
  }).filter((item) => item && item.path);
}

function normalizePathLike(value) {
  return String(value || '').trim().replace(/\\/g, '/').toLowerCase();
}

function topMemoryPaths(memoryHints = {}) {
  return Array.isArray(memoryHints.topPaths)
    ? memoryHints.topPaths
      .map((item) => String(item?.value || item || '').trim())
      .filter(Boolean)
      .slice(0, 4)
    : [];
}

function findRelevantMemoryPath(changedFiles = [], memoryHints = {}) {
  const changedPaths = normalizeChangedFiles(changedFiles).map((item) => String(item.path || '').trim()).filter(Boolean);
  const learnedPaths = topMemoryPaths(memoryHints);
  for (const changedPath of changedPaths) {
    const normalizedChangedPath = normalizePathLike(changedPath);
    const matched = learnedPaths.find((candidate) => {
      const normalizedCandidate = normalizePathLike(candidate);
      return normalizedChangedPath.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedChangedPath);
    });
    if (matched) {
      return changedPath;
    }
  }
  return changedPaths.length === 0 ? String(learnedPaths[0] || '').trim() : '';
}

function pickArtifactMatch(value, pattern) {
  const matcher = pattern instanceof RegExp ? pattern : null;
  const items = normalizeObjectArray(value);
  const matched = items.find((item) => item.path && (!matcher || matcher.test(String(item.kind || item.label || ''))));
  return String(matched?.path || '').trim();
}

function buildLearnedAction(command, context = {}) {
  const summary = String(context.summary || '').trim();
  const prompt = String(context.prompt || context.summary || '').trim();
  const reason = String(context.reason || '').trim();
  const phaseId = String(context.phaseId || '').trim();
  const phaseLabel = String(context.phaseLabel || '').trim();
  if (command === 'repair-loop') {
    return {
      id: 'repair-loop',
      label: 'Repair loop',
      command: 'repair-loop',
      summary: summary || 'Repair the latest failed run before continuing.',
      prompt: prompt || 'Repair the latest failed run and rerun validation.',
      reason: reason || 'learned guidance',
      blocked: false,
      learned: true,
      phaseId,
      phaseLabel,
    };
  }
  if (command === 'retry-with-research') {
    return {
      id: 'retry-with-research',
      label: 'Retry with research',
      command: 'retry-with-research',
      summary: summary || 'Research the repo state before the next bounded retry.',
      prompt: prompt || 'Retry the current objective with more repo research first.',
      reason: reason || 'learned guidance',
      blocked: false,
      learned: true,
      phaseId,
      phaseLabel,
    };
  }
  if (command === 'continue-run') {
    return {
      id: 'continue-run',
      label: 'Continue run',
      command: 'continue-run',
      summary: summary || 'Continue the current bounded objective.',
      prompt: prompt || 'Continue the current bounded objective.',
      reason: reason || 'learned guidance',
      blocked: false,
      learned: true,
      phaseId,
      phaseLabel,
    };
  }
  return {};
}

function tuneNextActionWithMemory(baseAction = {}, context = {}) {
  const action = baseAction && typeof baseAction === 'object' ? { ...baseAction } : {};
  const memoryHints = normalizeMemoryHints(context.memoryHints);
  const preferredResponse = normalizeMemoryAction(memoryHints.recommendedResponse);
  const topRejectReason = String(memoryHints.topRejectReason || '').trim();
  const topFixPattern = String(memoryHints.topFixPattern || memoryHints.recommendedPrompt || '').trim();
  const topPhaseId = String(memoryHints.topPhaseId || '').trim();
  const topPhaseLabel = String(memoryHints.topPhaseLabel || '').trim();
  if (!String(action.command || '').trim()) {
    return action;
  }

  const failureCode = String(context.failureClass?.code || '').trim().toLowerCase();
  const matchedPath = findRelevantMemoryPath(context.changedFiles, memoryHints);
  const learnedReason = topRejectReason
    ? `learned from ${topRejectReason}`
    : topPhaseLabel
      ? `learned guidance for ${topPhaseLabel}`
      : 'learned guidance';
  const evidenceStrongEnough = Boolean(
    matchedPath
    || topRejectReason
    || topFixPattern
    || Number(memoryHints.rejectCount || 0) >= 2
    || Array.isArray(memoryHints.recentRejects) && memoryHints.recentRejects.length > 0,
  );
  const requestedCommand = !action.blocked && evidenceStrongEnough
    ? preferredResponse
    : '';

  let tuned = action;
  if (requestedCommand && requestedCommand !== action.command) {
    if (requestedCommand === 'repair-loop' && context.repairAvailable) {
      tuned = buildLearnedAction('repair-loop', {
        summary: topFixPattern || action.summary,
        prompt: topFixPattern || memoryHints.recommendedPrompt || action.prompt,
        reason: learnedReason,
        phaseId: topPhaseId,
        phaseLabel: topPhaseLabel,
      });
    } else if (requestedCommand === 'retry-with-research' && context.retryAvailable) {
      tuned = buildLearnedAction('retry-with-research', {
        summary: topFixPattern || action.summary,
        prompt: topFixPattern || memoryHints.recommendedPrompt || action.prompt,
        reason: learnedReason,
        phaseId: topPhaseId,
        phaseLabel: topPhaseLabel,
      });
    } else if (requestedCommand === 'continue-run' && context.retryAvailable) {
      tuned = buildLearnedAction('continue-run', {
        summary: topFixPattern || action.summary,
        prompt: topFixPattern || memoryHints.recommendedPrompt || action.prompt,
        reason: learnedReason,
        phaseId: topPhaseId,
        phaseLabel: topPhaseLabel,
      });
    }
  }

  if (tuned && typeof tuned === 'object' && evidenceStrongEnough) {
    return {
      ...tuned,
      summary: String(tuned.summary || topFixPattern || action.summary || '').trim(),
      prompt: String(tuned.prompt || topFixPattern || memoryHints.recommendedPrompt || action.prompt || '').trim(),
      reason: String(tuned.reason || action.reason || learnedReason).trim(),
      learned: tuned.learned === true || preferredResponse === String(tuned.command || '').trim(),
      phaseId: String(tuned.phaseId || topPhaseId).trim(),
      phaseLabel: String(tuned.phaseLabel || topPhaseLabel).trim(),
      learnedPath: matchedPath,
      learnedRejectReason: topRejectReason,
    };
  }

  if (failureCode === 'empty-proposal' && context.retryAvailable && !action.blocked) {
    return buildLearnedAction('retry-with-research', {
      summary: topFixPattern || action.summary,
      prompt: topFixPattern || memoryHints.recommendedPrompt || action.prompt,
      reason: learnedReason,
      phaseId: topPhaseId,
      phaseLabel: topPhaseLabel,
    });
  }

  return action;
}

function buildOperatorNextAction(context = {}) {
  const task = String(context.task || '').trim();
  const ticket = String(context.ticket || '').trim();
  const taskObjective = normalizeSummaryObject(context.taskObjective);
  const failureClass = normalizeSummaryObject(context.failureClass);
  const recoveryLadder = normalizeSummaryObject(context.recoveryLadder);
  const checkpointRef = normalizeSummaryObject(context.checkpointRef);
  const interruptRequest = normalizeSummaryObject(context.interruptRequest);
  const reviewBundle = normalizeSummaryObject(context.reviewBundle);
  const workbenchArtifacts = normalizeObjectArray(context.workbenchArtifacts);
  const changedFiles = normalizeChangedFiles(context.changedFiles);
  const artifactPaths = normalizeArray(context.artifactPaths);
  const objectiveSummary = String(taskObjective.summary || task || '').trim();
  const failureCode = String(failureClass.code || '').trim().toLowerCase();
  const recoverySummary = String(recoveryLadder.summary || failureClass.summary || '').trim();
  const reviewDecisionLabel = String(reviewBundle.decisionLabel || reviewBundle.decision_label || reviewBundle.verdict || '').trim();
  const reviewReason = String(reviewBundle.reason || '').trim();
  const reviewHowToFix = String(reviewBundle.howToFix || reviewBundle.how_to_fix || '').trim();
  const reviewChangeSummary = String(reviewBundle.changeSummary || reviewBundle.change_summary || '').trim();
  const reviewSummary = String(
    interruptRequest.summary
    || reviewReason
    || reviewBundle.summary
    || failureClass.summary
    || ''
  ).trim();
  const recoveryCurrentStep = String(recoveryLadder.current_step || recoveryLadder.currentStep || '').trim().toLowerCase();
  const recoveryNextStep = String(recoveryLadder.next_step || recoveryLadder.nextStep || '').trim().toLowerCase();
  const interruptKind = String(interruptRequest.kind || '').trim().toLowerCase();
  const requiresManualReview = Boolean(reviewBundle.requiresManualReview || Number(reviewBundle.pendingCount || 0) > 0);
  const changedFilePath = String(changedFiles.find((item) => item?.path)?.path || pickArtifactMatch(workbenchArtifacts, /changed-file|file/i)).trim();
  const tracePath = String(checkpointRef.path || artifactPaths[0] || pickArtifactMatch(workbenchArtifacts, /trace|checkpoint|artifact|log/i)).trim();
  const sandboxPath = String(pickArtifactMatch(workbenchArtifacts, /sandbox|worktree|lab/i)).trim();

  if (interruptRequest.active || requiresManualReview) {
    return {
      id: 'review-interrupt',
      label: 'Review interrupt',
      command: 'review-interrupt',
      summary: reviewSummary || 'Review or approval is holding the current run.',
      prompt: objectiveSummary
        ? `Review the latest run for "${objectiveSummary}" and ${reviewHowToFix ? reviewHowToFix.charAt(0).toLowerCase() + reviewHowToFix.slice(1) : 'summarize the blockers.'}`
        : (reviewHowToFix || 'Review the latest run and summarize the blockers.'),
      reason: reviewDecisionLabel || reviewReason || interruptKind || 'review',
      blocked: true,
    };
  }

  if (
    Boolean(context.repairAvailable)
    && (
      recoveryCurrentStep === 'repair-oriented-route'
      || recoveryNextStep === 'repair-oriented-route'
      || ['validation-failure', 'parse-failure', 'invalid-change-set'].includes(failureCode)
      || Boolean(ticket)
    )
  ) {
    return {
      id: 'repair-loop',
      label: 'Repair loop',
      command: 'repair-loop',
      summary: reviewHowToFix || recoverySummary || 'Repair the latest failed run before continuing.',
      prompt: reviewHowToFix || 'Repair the latest failed run and rerun validation.',
      reason: reviewReason || failureCode || recoveryNextStep || 'repair',
      blocked: false,
    };
  }

  if (
    recoveryCurrentStep === 'research-expansion'
    || recoveryNextStep === 'research-expansion'
    || recoveryCurrentStep === 'bridge-plan-retry'
    || recoveryNextStep === 'bridge-plan-retry'
    || failureCode === 'empty-proposal'
  ) {
    return {
      id: 'retry-with-research',
      label: 'Retry with research',
      command: 'retry-with-research',
      summary: reviewHowToFix || recoverySummary || 'Research the repo state before the next bounded retry.',
      prompt: objectiveSummary
        ? `Retry "${objectiveSummary}" with more repo research first.`
        : 'Retry the current objective with more repo research first.',
      reason: reviewReason || recoveryNextStep || failureCode || 'research-expansion',
      blocked: false,
    };
  }

  if ((recoveryCurrentStep === 'sandbox-retry' || recoveryNextStep === 'sandbox-retry') && sandboxPath) {
    return {
      id: 'open-sandbox',
      label: 'Open sandbox',
      command: 'open-sandbox',
      path: sandboxPath,
      summary: recoverySummary || 'Inspect the active sandbox or lab before retrying.',
      prompt: 'Open the active sandbox and inspect the current bounded retry context.',
      reason: 'sandbox-retry',
      blocked: false,
    };
  }

  if (Boolean(context.retryAvailable) && objectiveSummary) {
    return {
      id: 'continue-run',
      label: 'Continue run',
      command: 'continue-run',
      summary: reviewChangeSummary || `Continue the current bounded objective: ${objectiveSummary}`,
      prompt: `Continue the current objective: ${objectiveSummary}`,
      reason: reviewReason || 'continue',
      blocked: false,
    };
  }

  if (changedFilePath) {
    return {
      id: 'open-files',
      label: 'Open files',
      command: 'open-files',
      path: changedFilePath,
      summary: 'Inspect the latest changed files before deciding the next edit.',
      prompt: 'Open the changed files and show me the diff.',
      reason: 'changed-files',
      blocked: false,
    };
  }

  if (tracePath) {
    return {
      id: 'open-trace',
      label: 'Open trace',
      command: 'open-trace',
      path: tracePath,
      summary: 'Inspect the latest trace or checkpoint before continuing.',
      prompt: 'Open the latest trace and summarize what happened.',
      reason: 'trace',
      blocked: false,
    };
  }

  return {};
}

function summarizeExecutionResult(run = {}) {
  return String(
    run?.reviewSummary?.summary
    || run?.runSummary?.summary
    || run?.testSummary?.summary
    || run?.ownerSummary?.summary
    || run?.blockedReason
    || '',
  ).trim();
}

function buildOperatorExecutionSnapshot(run = {}, overrides = {}) {
  const runtimeContext = normalizeRuntimeContext(run.runtimeContext || {});
  const runtimeRun = normalizeSummaryObject(run.runtimeRun || {});
  const runtimeResult = normalizeSummaryObject(run.runtimeResult || {});
  const runtimeFailure = normalizeSummaryObject(run.runtimeFailure || {});
  const seed = overrides.seed && typeof overrides.seed === 'object' ? overrides.seed : {};
  const changedFiles = normalizeChangedFiles(
    seed.changedFiles
    || seed.changed_files
    || runtimeContext.changedFiles
    || runtimeContext.changed_files
    || [],
  );
  const task = String(
    overrides.task
    || seed.task
    || seed.desc
    || run.task
    || runtimeContext.desc
    || run.label
    || '',
  ).trim();
  const taskMode = normalizeTaskLoopMode(
    overrides.taskMode
    || seed.taskMode
    || seed.task_mode
    || run.taskMode
    || runtimeRun.taskMode
    || runtimeRun.task_mode
    || runtimeResult.taskMode
    || runtimeResult.task_mode,
    run.action,
  );
  const resultSummary = String(
    seed.resultSummary
    || seed.result_summary
    || runtimeResult.summary
    || summarizeExecutionResult(run),
  ).trim();
  const reviewSummary = normalizeReviewSummary(seed.reviewSummary || seed.review_summary || run.reviewSummary);
  const trustSummary = normalizeSummaryObject(seed.trustSummary || seed.trust_summary || run.trustSummary);
  const runSummary = normalizeSummaryObject(seed.runSummary || seed.run_summary || run.runSummary);
  const testSummary = normalizeSummaryObject(seed.testSummary || seed.test_summary || run.testSummary);
  const artifactPaths = normalizeArray(seed.artifactPaths || seed.artifact_paths || run.artifactPaths);
  const taskObjective = normalizeSummaryObject(
    seed.taskObjective
    || seed.task_objective
    || run.taskObjective
    || run.task_objective
    || runtimeResult.taskObjective
    || runtimeResult.task_objective,
  );
  const failureClass = normalizeSummaryObject(
    seed.failureClass
    || seed.failure_class
    || run.failureClass
    || run.failure_class
    || runtimeResult.failureClass
    || runtimeResult.failure_class,
  );
  const recoveryLadder = normalizeSummaryObject(
    seed.recoveryLadder
    || seed.recovery_ladder
    || run.recoveryLadder
    || run.recovery_ladder
    || runtimeResult.recoveryLadder
    || runtimeResult.recovery_ladder,
  );
  const checkpointRef = normalizeSummaryObject(
    seed.checkpointRef
    || seed.checkpoint_ref
    || run.checkpointRef
    || run.checkpoint_ref
    || runtimeResult.checkpointRef
    || runtimeResult.checkpoint_ref,
  );
  const interruptRequest = normalizeSummaryObject(
    seed.interruptRequest
    || seed.interrupt_request
    || run.interruptRequest
    || run.interrupt_request
    || runtimeResult.interruptRequest
    || runtimeResult.interrupt_request,
  );
  const reviewBundle = normalizeSummaryObject(
    seed.reviewBundle
    || seed.review_bundle
    || run.reviewBundle
    || run.review_bundle
    || runtimeResult.reviewBundle
    || runtimeResult.review_bundle,
  );
  const nextActionSeed = normalizeSummaryObject(
    seed.nextAction
    || seed.next_action
    || run.nextAction
    || run.next_action
    || runtimeResult.nextAction
    || runtimeResult.next_action,
  );
  const workbenchArtifacts = normalizeObjectArray(
    seed.workbenchArtifacts
    || seed.workbench_artifacts
    || run.workbenchArtifacts
    || run.workbench_artifacts
    || runtimeResult.workbenchArtifacts
    || runtimeResult.workbench_artifacts,
  );
  const memoryHints = normalizeMemoryHints(
    seed.memoryHints
    || seed.memory_hints
    || run.memoryHints
    || run.memory_hints
    || runtimeResult.memoryHints
    || runtimeResult.memory_hints
    || seed.learningMetadata?.memoryHints
    || seed.learningMetadata?.memory_hints
    || run.learningMetadata?.memoryHints
    || run.learningMetadata?.memory_hints
    || seed.learning_metadata?.memory_hints,
  );
  const recoveryState = String(recoveryLadder.state || '').trim().toLowerCase();
  const recoveryCurrentStep = String(recoveryLadder.current_step || recoveryLadder.currentStep || '').trim().toLowerCase();
  const recoveryNextStep = String(recoveryLadder.next_step || recoveryLadder.nextStep || '').trim().toLowerCase();
  const interruptKind = String(interruptRequest.kind || '').trim().toLowerCase();
  const explicitRetryAvailable = seed.retryAvailable ?? seed.retry_available ?? run.retryAvailable ?? run.retry_available ?? runtimeResult.retryAvailable ?? runtimeResult.retry_available;
  const explicitRepairAvailable = seed.repairAvailable ?? seed.repair_available ?? run.repairAvailable ?? run.repair_available ?? runtimeResult.repairAvailable ?? runtimeResult.repair_available;
  const hasExplicitRetryAvailable = explicitRetryAvailable !== undefined;
  const hasExplicitRepairAvailable = explicitRepairAvailable !== undefined;
  const retryableFailure = Boolean(runtimeFailure.retryable || failureClass.retryable);
  const failedState = ['fail', 'failed', 'cancelled', 'skipped'].includes(
    String(run.state || runtimeResult.status || runtimeRun.state || '').toLowerCase(),
  );
  const retrySteps = ['local-targeted-coding', 'research-expansion', 'stronger-coding-route', 'bridge-plan-retry', 'sandbox-retry'];
  const repairSteps = ['repair-oriented-route', 'research-expansion', 'stronger-coding-route', 'bridge-plan-retry', 'sandbox-retry'];
  const interruptBlocksFallback = Boolean(interruptRequest.active && ['approval', 'review'].includes(interruptKind));
  const fallbackRetryAvailable = retryableFailure
    || failedState
    || retrySteps.includes(recoveryCurrentStep)
    || retrySteps.includes(recoveryNextStep);
  const fallbackRepairAvailable = retryableFailure
    || failedState
    || Boolean(String(run.ticket || '').trim())
    || repairSteps.includes(recoveryCurrentStep)
    || repairSteps.includes(recoveryNextStep)
    || recoveryState === 'failed';
  const derivedRetryAvailable = hasExplicitRetryAvailable
    ? Boolean(explicitRetryAvailable)
    : Boolean(retryableFailure || (!interruptBlocksFallback && fallbackRetryAvailable));
  const derivedRepairAvailable = hasExplicitRepairAvailable
    ? Boolean(explicitRepairAvailable)
    : Boolean(retryableFailure || (!interruptBlocksFallback && fallbackRepairAvailable));
  const nextActionBase = Object.keys(nextActionSeed).length > 0
    ? nextActionSeed
    : buildOperatorNextAction({
        task,
        ticket: String(seed.ticket || run.ticket || runtimeRun.ticket || runtimeResult.ticket || '').trim(),
        taskObjective,
        failureClass,
        recoveryLadder,
        checkpointRef,
        interruptRequest,
        reviewBundle,
        workbenchArtifacts,
        changedFiles,
        artifactPaths,
        retryAvailable: derivedRetryAvailable,
        repairAvailable: derivedRepairAvailable,
        memoryHints,
      });
  const nextAction = tuneNextActionWithMemory(nextActionBase, {
    memoryHints,
    changedFiles,
    failureClass,
    retryAvailable: derivedRetryAvailable,
    repairAvailable: derivedRepairAvailable,
  });
  const queuedFollowup = (() => {
    const recipe = buildNextActionRecipe({
      task,
      taskObjective,
      nextAction,
      reviewBundle,
      interruptRequest,
      changedFiles,
      workbenchArtifacts,
      memoryHints,
    });
    if (!recipe) {
      return {
        exists: false,
        recipe: null,
        summary: '',
        label: '',
        autoQueueEligible: false,
      };
    }
    return {
      exists: true,
      recipe,
      summary: String(recipe.summary || '').trim(),
      label: String(recipe.title || '').trim(),
      autoQueueEligible: recipe.autoQueueEligible === true,
    };
  })();
  const runtimeTimeline = normalizeRuntimeTimeline(seed.runtimeTimeline || seed.runtime_timeline || run.runtimeTimeline || run.runtime_timeline || runtimeResult.runtimeTimeline || runtimeResult.runtime_timeline || run.decision_timeline || runtimeResult.decision_timeline || []);
  const providerAccountability = summarizeProviderAccountability(run, seed);
  return {
    task,
    laneId: String(seed.laneId || seed.lane_id || run.laneId || runtimeContext.laneId || runtimeContext.lane_id || '').trim(),
    laneLabel: String(seed.laneLabel || seed.lane_label || run.laneLabel || runtimeContext.laneLabel || runtimeContext.lane_label || '').trim(),
    ticket: String(seed.ticket || run.ticket || runtimeRun.ticket || runtimeResult.ticket || '').trim(),
    action: String(seed.action || run.action || runtimeResult.action || runtimeRun.action || '').trim(),
    taskMode,
    modelProfileId: String(seed.modelProfileId || seed.model_profile_id || run.modelProfileId || runtimeResult.modelProfileId || runtimeResult.model_profile_id || '').trim(),
    modelRole: String(seed.modelRole || seed.model_role || run.modelRole || runtimeResult.modelRole || runtimeResult.model_role || '').trim(),
    modelDisplayName: String(seed.modelDisplayName || seed.model_display_name || run.modelDisplayName || runtimeResult.modelDisplayName || runtimeResult.model_display_name || '').trim(),
    baseModel: String(seed.baseModel || seed.base_model || run.baseModel || runtimeResult.baseModel || runtimeResult.base_model || '').trim(),
    providerSource: String(seed.providerSource || seed.provider_source || run.providerSource || runtimeResult.providerSource || runtimeResult.provider_source || '').trim(),
    runId: String(seed.runId || run.runId || runtimeRun.runId || runtimeRun.run_id || runtimeResult.runId || runtimeResult.run_id || '').trim(),
    status: String(seed.status || run.state || runtimeResult.status || '').trim(),
    runState: String(seed.runState || runtimeResult.finalState || runtimeResult.final_state || runtimeRun.state || run.state || '').trim(),
    stageSummary: {
      currentStage: String(
        seed.stageSummary?.currentStage
        || seed.stage_summary?.current_stage
        || runtimeRun.currentStage
        || runtimeRun.current_stage
        || 'runtime',
      ).trim(),
      summary: String(
        seed.stageSummary?.summary
        || seed.stage_summary?.summary
        || runtimeResult.summary
        || resultSummary,
      ).trim(),
      finalState: String(
        seed.stageSummary?.finalState
        || seed.stage_summary?.final_state
        || runtimeResult.finalState
        || runtimeResult.final_state
        || runtimeRun.state
        || run.state
        || '',
      ).trim(),
    },
    resultSummary,
    diffSummary: String(seed.diffSummary || seed.diff_summary || '').trim(),
    changedFiles,
    changedFileCount: Number(seed.changedFileCount ?? seed.changed_file_count ?? changedFiles.length),
    outputTail: {
      combined: clipTail(overrides.logTail !== undefined ? overrides.logTail : (seed.outputTail?.combined || seed.output_tail?.combined || run.logTail || '')),
      stdout: clipTail(overrides.stdoutTail !== undefined ? overrides.stdoutTail : (seed.outputTail?.stdout || seed.output_tail?.stdout || run.stdoutTail || '')),
      stderr: clipTail(overrides.stderrTail !== undefined ? overrides.stderrTail : (seed.outputTail?.stderr || seed.output_tail?.stderr || run.stderrTail || '')),
    },
    reviewSummary,
    trustSummary,
    runSummary,
    testSummary,
    runtimeTimeline,
    providerAccountability,
    benchmarkMetadata: {
      experimentBenchmarkSummary: normalizeSummaryObject(
        seed.benchmarkMetadata?.experimentBenchmarkSummary
        || seed.benchmark_metadata?.experiment_benchmark_summary
        || run.experimentBenchmarkSummary,
      ),
      ownerExperimentSummary: normalizeSummaryObject(
        seed.benchmarkMetadata?.ownerExperimentSummary
        || seed.benchmark_metadata?.owner_experiment_summary
        || run.ownerExperimentSummary,
      ),
    },
    learningMetadata: {
      trainingHandoff: normalizeSummaryObject(
        seed.learningMetadata?.trainingHandoff
        || seed.learningMetadata?.training_handoff
        || run.learningMetadata?.trainingHandoff
        || run.learningMetadata?.training_handoff
        || seed.learning_metadata?.training_handoff
        || run.trainingHandoff,
      ),
      memoryHints,
    },
    retryAvailable: derivedRetryAvailable,
    repairAvailable: derivedRepairAvailable,
    artifactPaths,
    taskObjective,
    failureClass,
    recoveryLadder,
    checkpointRef,
    interruptRequest,
    reviewBundle,
    nextAction,
    queuedFollowup,
    memoryHints,
    workbenchArtifacts,
  };
}

class SharedAgentRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workspaceRoot = options.workspaceRoot || '';
    this.pythonRelative = options.pythonRelative || DEFAULTS.PYTHON_RELATIVE;
    this.client = new AgentRuntimeClient({
      workspaceRoot: this.workspaceRoot,
      pythonRelative: this.pythonRelative,
    });
    this.runs = new Map();
    this.processes = new Map();
    this.history = [];
    this.runtimeStatePath = '';
    if (this.workspaceRoot) {
      this._setRuntimePath();
      this._loadRecoveryState();
    }
  }

  setWorkspaceRoot(workspaceRoot) {
    if (!workspaceRoot || workspaceRoot === this.workspaceRoot) {
      return;
    }
    this.workspaceRoot = workspaceRoot;
    this.client.setWorkspaceRoot(workspaceRoot);
    this._setRuntimePath();
    this._loadRecoveryState();
  }

  _setRuntimePath() {
    this.runtimeStatePath = this.workspaceRoot
      ? (getAssistantRuntimeStatePath(this.workspaceRoot) || path.join(this.workspaceRoot, DEFAULTS.RUNTIME_STATE_FILE))
      : '';
  }

  _loadRecoveryState() {
    const payload = readJsonFile(this.runtimeStatePath, null);
    if (!payload || !Array.isArray(payload.runs)) {
      return;
    }
    this.history = payload.runs.slice(0, DEFAULTS.RUN_HISTORY_LIMIT).map(normalizeRecoveredRun);
    this.runs.clear();
    for (const run of this.history) {
      if (run && run.runId) {
        this.runs.set(run.runId, run);
      }
    }
  }

  _persistRecoveryState() {
    if (!this.runtimeStatePath) {
      return;
    }
    const snapshot = {
      updatedAt: nowIso(),
      runs: this.history.slice(0, DEFAULTS.RUN_HISTORY_LIMIT),
    };
    writeJsonFileAtomic(this.runtimeStatePath, snapshot);
  }

  _recordRun(snapshot) {
    this.runs.set(snapshot.runId, snapshot);
    this.history = [snapshot, ...this.history.filter((item) => item.runId !== snapshot.runId)].slice(0, DEFAULTS.RUN_HISTORY_LIMIT);
    this._persistRecoveryState();
  }

  _emitRunEvent(event) {
    this.emit('run-event', event);
  }

  _emitSchedulerEvent(event) {
    this.emit('scheduler-event', event);
  }

  cancelLatest() {
    const activeRuns = Array.from(this.processes.keys());
    if (activeRuns.length === 0) {
      return { ok: false, message: 'Run not active.' };
    }
    return this.cancel(activeRuns[activeRuns.length - 1]);
  }

  getStatus(runId = null) {
    if (runId) {
      return this.runs.get(runId) || null;
    }
    return {
      activeRuns: Array.from(this.processes.keys()),
      latest: this.history.slice(0, 30),
    };
  }

  getRecoveryState() {
    return {
      runs: this.history.slice(0, 30),
      activeRuns: Array.from(this.processes.keys()),
    };
  }

  cancel(runId) {
    const proc = this.processes.get(runId);
    if (!proc) {
      return { ok: false, message: 'Run not active.' };
    }
    proc.__cancelRequested = true;
    return proc.cancel();
  }

  runPreflight(workspaceRoot, options = {}) {
    const root = workspaceRoot || this.workspaceRoot;
    return runPreflight(root, options);
  }

  chat(prompt, context = {}) {
    this.client.setWorkspaceRoot(this.workspaceRoot);
    return this.client.chat(prompt, context);
  }

  startScheduler(options = {}) {
    this.client.setWorkspaceRoot(options.workspace || this.workspaceRoot);
    const status = this.client.startScheduler(options, {
      onStdout: (text) => {
        this._emitSchedulerEvent({ type: 'log', stream: 'stdout', text });
      },
      onStderr: (text) => {
        this._emitSchedulerEvent({ type: 'log', stream: 'stderr', text });
      },
    });
    this._emitSchedulerEvent({ type: 'state', running: !!status.running, message: status.message, pid: status.pid || null });
    const active = this.client.scheduler;
    if (active && active.promise) {
      active.promise.then(({ exitCode, signal }) => {
        this._emitSchedulerEvent({
          type: 'state',
          running: false,
          message: `Autopilot scheduler stopped (code ${exitCode ?? 'n/a'}${signal ? `, signal ${signal}` : ''}).`,
          pid: null,
        });
      });
    }
    return status;
  }

  stopScheduler() {
    const status = this.client.stopScheduler();
    this._emitSchedulerEvent({ type: 'state', running: !!status.running, message: status.message, pid: status.pid || null });
    return status;
  }

  schedulerStatus() {
    return this.client.schedulerStatus();
  }

  run(request) {
    this.client.setWorkspaceRoot(request.workspace || this.workspaceRoot);
    const runId = request.runId || randomId('agent');
    const startedAt = nowIso();
    const runSnapshot = {
      runId,
      action: request.action,
      ticket: request.ticket || '',
      task: String(request.task || request.objective || request.prompt || request.label || '').trim(),
      taskMode: normalizeTaskLoopMode(
        request.taskMode
        || request.task_mode
        || request.metadata?.taskMode
        || request.metadata?.task_mode,
        request.action,
      ),
      laneId: String(request.laneId || request.metadata?.lane_id || '').trim(),
      laneLabel: String(request.laneLabel || request.metadata?.lane_label || '').trim(),
      modelProfileId: String(request.modelProfileId || request.metadata?.modelProfileId || '').trim(),
      modelRole: String(request.modelRole || request.metadata?.modelRole || '').trim(),
      modelDisplayName: String(request.modelDisplayName || request.metadata?.modelDisplayName || '').trim(),
      baseModel: String(request.baseModel || request.metadata?.baseModel || '').trim(),
      providerSource: String(request.providerSource || request.metadata?.providerSource || '').trim(),
      workspaceRoot: request.workspaceRoot || request.targetWorkspaceRoot || request.workspace || this.workspaceRoot,
      labRoot: request.labRoot || '',
      changeSessionId: request.changeSessionId || '',
      state: RUN_STATES.RUNNING,
      label: request.label || request.action,
      startedAt,
      endedAt: null,
      exitCode: null,
      checks: [],
      locations: [],
      artifactPaths: [],
      reviewSummary: {},
      approvalRequests: [],
      runtimeContext: {},
      ownerSummary: {},
      runSummary: {},
      testSummary: {},
      reviewQueueSummary: {},
      trustSummary: {},
      trustSignalCount: 0,
      trustStateCounts: {},
      recommendedActions: [],
      experimentBenchmarkSummary: {},
      ownerExperimentSummary: {},
      trainingHandoff: {},
      queueSummary: {},
      historySummary: {},
      recommendation: {},
      projectMaintenanceSummary: {},
      ownerGoals: [],
      ownerGoalPlan: {},
      blockedReason: '',
      logTail: '',
      stdoutTail: '',
      stderrTail: '',
      runtimeRun: {},
      runtimeResult: {},
      runtimeFailure: {},
      runtimeTimeline: [],
      providerRouting: {},
      configState: {},
      docsState: {},
      operatorExecution: {},
    };
    this._recordRun(runSnapshot);
    this._emitRunEvent({
      runId,
      state: RUN_STATES.RUNNING,
      timestamp: startedAt,
      label: runSnapshot.label,
      workspaceRoot: runSnapshot.workspaceRoot,
      labRoot: runSnapshot.labRoot,
      changeSessionId: runSnapshot.changeSessionId,
      checks: [],
      locations: [],
      artifactPaths: [],
      laneId: runSnapshot.laneId,
      laneLabel: runSnapshot.laneLabel,
      modelProfileId: runSnapshot.modelProfileId,
      modelRole: runSnapshot.modelRole,
      modelDisplayName: runSnapshot.modelDisplayName,
      baseModel: runSnapshot.baseModel,
      providerSource: runSnapshot.providerSource,
      task: runSnapshot.task,
      taskMode: runSnapshot.taskMode,
    });

    const operation = this.client.startAction(request, {
      onStdout: (text) => this._appendLog(runId, request.action, text, 'stdout'),
      onStderr: (text) => this._appendLog(runId, request.action, text, 'stderr'),
    });
    operation.__cancelRequested = false;
    this.processes.set(runId, operation);

    operation.promise.then(({ exitCode, stdout, stderr, result }) => {
      const current = this.runs.get(runId) || runSnapshot;
      const wasCancelled = !!operation.__cancelRequested;
      const skippedDone = Number(exitCode ?? 1) === 0 && isSkippedDoneLog(current.logTail);
      const skippedNoop = Number(exitCode ?? 1) === 0 && (result?.noop === true || isNoEligibleTicketsLog(current.logTail));
      const artifact = result?.artifact && typeof result.artifact === 'object' ? result.artifact : {};
      this.processes.delete(runId);
      current.endedAt = nowIso();
      current.exitCode = Number(exitCode ?? 1);
      current.checks = (skippedDone || skippedNoop) ? [] : (Array.isArray(result?.checks) ? result.checks : []);
      current.locations = (skippedDone || skippedNoop)
        ? []
        : (Array.isArray(result?.locations) ? result.locations : parseFailureLocationsFromChecks(current.checks));
      current.artifactPaths = (skippedDone || skippedNoop) ? [] : (Array.isArray(result?.artifactPaths) ? result.artifactPaths : []);
      current.label = result?.label || current.label;
      current.runtimeRun = (skippedDone || skippedNoop)
        ? {}
        : normalizeSummaryObject(result?.runtimeRun || artifact.runtime_run || artifact.runtimeRun);
      current.runtimeResult = (skippedDone || skippedNoop)
        ? {}
        : normalizeSummaryObject(result?.runtimeResult || artifact.runtime_result || artifact.runtimeResult);
      current.runtimeFailure = (skippedDone || skippedNoop)
        ? {}
        : normalizeSummaryObject(result?.runtimeFailure || artifact.runtime_failure || artifact.runtimeFailure);
      current.runtimeTimeline = (skippedDone || skippedNoop)
        ? []
        : normalizeRuntimeTimeline(result?.runtimeTimeline || result?.decision_timeline || result?.runtimeResult?.runtime_timeline || artifact.runtime_timeline || artifact.decision_timeline || artifact.runtime_result?.runtime_timeline);
      current.providerRouting = (skippedDone || skippedNoop)
        ? {}
        : normalizeSummaryObject(result?.providerRouting || result?.provider_routing || result?.runtimeResult?.provider_routing || artifact.provider_routing || artifact.runtime_result?.provider_routing);
      current.configState = (skippedDone || skippedNoop)
        ? {}
        : normalizeSummaryObject(result?.configState || result?.config_state || result?.runtimeContext?.config_state || artifact.runtime_context?.config_state);
      current.docsState = (skippedDone || skippedNoop)
        ? {}
        : normalizeSummaryObject(result?.docsState || result?.docs_state || result?.runtimeContext?.docs_state || artifact.runtime_context?.docs_state);
      current.reviewSummary = (skippedDone || skippedNoop)
        ? {}
        : normalizeReviewSummary(result?.reviewSummary || artifact.review_summary || artifact.reviewSummary);
      current.approvalRequests = (skippedDone || skippedNoop)
        ? []
        : normalizeApprovalRequests(result?.approvalRequests || artifact.pending_approvals || artifact.approvalRequests);
      current.runtimeContext = (skippedDone || skippedNoop)
        ? {}
        : normalizeRuntimeContext(result?.runtimeContext || artifact.runtime_context || artifact.runtimeContext);
      current.ownerSummary = (skippedDone || skippedNoop)
        ? {}
        : normalizeSummaryObject(result?.ownerSummary || artifact.owner_summary || artifact.ownerSummary);
      current.runSummary = (skippedDone || skippedNoop)
        ? {}
        : normalizeSummaryObject(result?.runSummary || artifact.run_summary || artifact.runSummary);
      current.testSummary = (skippedDone || skippedNoop)
        ? {}
        : normalizeSummaryObject(result?.testSummary || artifact.test_summary || artifact.testSummary);
      current.reviewQueueSummary = (skippedDone || skippedNoop)
        ? {}
        : normalizeSummaryObject(result?.reviewQueueSummary || artifact.review_queue_summary || artifact.reviewQueueSummary);
      current.trustSummary = (skippedDone || skippedNoop)
        ? {}
        : normalizeSummaryObject(result?.trustSummary || artifact.trust_summary || artifact.trustSummary);
      current.trustSignalCount = (skippedDone || skippedNoop)
        ? 0
        : Number(result?.trustSignalCount ?? artifact.trust_signal_count ?? artifact.trustSignalCount ?? 0);
      current.trustStateCounts = (skippedDone || skippedNoop)
        ? {}
        : normalizeSummaryObject(result?.trustStateCounts || artifact.trust_state_counts || artifact.trustStateCounts);
      current.recommendedActions = (skippedDone || skippedNoop)
        ? []
        : normalizeArray(result?.recommendedActions || artifact.recommended_actions || artifact.recommendedActions);
      current.experimentBenchmarkSummary = (skippedDone || skippedNoop)
        ? {}
        : normalizeSummaryObject(result?.experimentBenchmarkSummary || artifact.experiment_benchmark_summary || artifact.experimentBenchmarkSummary);
      current.ownerExperimentSummary = (skippedDone || skippedNoop)
        ? {}
        : normalizeSummaryObject(result?.ownerExperimentSummary || artifact.owner_experiment_summary || artifact.ownerExperimentSummary);
      current.trainingHandoff = (skippedDone || skippedNoop)
        ? {}
        : normalizeSummaryObject(result?.trainingHandoff || artifact.training_handoff || artifact.trainingHandoff);
      current.queueSummary = (skippedDone || skippedNoop)
        ? {}
        : normalizeSummaryObject(result?.queueSummary || artifact.queue_summary || artifact.queueSummary);
      current.historySummary = (skippedDone || skippedNoop)
        ? {}
        : normalizeSummaryObject(result?.historySummary || artifact.history_summary || artifact.historySummary);
      current.recommendation = (skippedDone || skippedNoop)
        ? {}
        : normalizeSummaryObject(result?.recommendation || artifact.recommendation);
      current.projectMaintenanceSummary = (skippedDone || skippedNoop)
        ? {}
        : normalizeSummaryObject(result?.projectMaintenanceSummary || artifact.project_maintenance_summary || artifact.projectMaintenanceSummary);
      current.ownerGoals = (skippedDone || skippedNoop)
        ? []
        : normalizeArray(result?.ownerGoals || artifact.owner_goals || artifact.ownerGoals);
      current.ownerGoalPlan = (skippedDone || skippedNoop)
        ? {}
        : normalizeSummaryObject(result?.ownerGoalPlan || artifact.owner_goal_plan || artifact.ownerGoalPlan);
      current.blockedReason = String(result?.blockedReason || artifact.blocked_reason || '');
      current.stdoutTail = clipTail(stdout);
      current.stderrTail = clipTail(stderr);
      if (wasCancelled) {
        current.state = RUN_STATES.CANCELLED;
      } else if (String(result?.state || '').toLowerCase() === RUN_STATES.SKIPPED || skippedDone || skippedNoop) {
        current.state = RUN_STATES.SKIPPED;
      } else {
        current.state = exitCode === 0 && result?.ok !== false ? RUN_STATES.PASS : RUN_STATES.FAIL;
      }
      current.operatorExecution = buildOperatorExecutionSnapshot(current, {
        seed: result?.operatorExecution || artifact.operator_execution || artifact.operatorExecution || {},
        logTail: current.logTail,
        stdoutTail: current.stdoutTail,
        stderrTail: current.stderrTail,
      });
      this._recordRun(current);
      this._emitRunEvent({
        runId,
        state: current.state,
        timestamp: current.endedAt,
        label: current.label,
        workspaceRoot: current.workspaceRoot,
        labRoot: current.labRoot,
        changeSessionId: current.changeSessionId,
        exitCode: current.exitCode,
        checks: current.checks,
        locations: current.locations,
        artifactPaths: current.artifactPaths,
        reviewSummary: current.reviewSummary,
        approvalRequests: current.approvalRequests,
        runtimeContext: current.runtimeContext,
        ownerSummary: current.ownerSummary,
        runSummary: current.runSummary,
        testSummary: current.testSummary,
        reviewQueueSummary: current.reviewQueueSummary,
        trustSummary: current.trustSummary,
        trustSignalCount: current.trustSignalCount,
        trustStateCounts: current.trustStateCounts,
        recommendedActions: current.recommendedActions,
        experimentBenchmarkSummary: current.experimentBenchmarkSummary,
        ownerExperimentSummary: current.ownerExperimentSummary,
        trainingHandoff: current.trainingHandoff,
        queueSummary: current.queueSummary,
        historySummary: current.historySummary,
        recommendation: current.recommendation,
        projectMaintenanceSummary: current.projectMaintenanceSummary,
        ownerGoals: current.ownerGoals,
        ownerGoalPlan: current.ownerGoalPlan,
        boardUpdate: result?.artifact?.board_update || null,
        blockedReason: current.blockedReason,
        laneId: current.laneId,
        laneLabel: current.laneLabel,
        modelProfileId: current.modelProfileId,
        modelRole: current.modelRole,
        modelDisplayName: current.modelDisplayName,
        baseModel: current.baseModel,
        providerSource: current.providerSource,
        task: current.task,
        taskMode: current.taskMode,
        runtimeRun: current.runtimeRun,
        runtimeResult: current.runtimeResult,
        runtimeFailure: current.runtimeFailure,
        runtimeTimeline: current.runtimeTimeline,
        providerRouting: current.providerRouting,
        configState: current.configState,
        docsState: current.docsState,
        stdoutTail: current.stdoutTail,
        stderrTail: current.stderrTail,
        operatorExecution: current.operatorExecution,
      });
    });

    return {
      runId,
      state: RUN_STATES.RUNNING,
      label: runSnapshot.label,
      artifactPaths: [],
    };
  }

  _appendLog(runId, fallbackLabel, text, stream = '') {
    const current = this.runs.get(runId);
    if (!current) {
      return;
    }
    current.logTail = `${current.logTail || ''}${String(text || '')}`.slice(-100000);
    if (stream === 'stdout') {
      current.stdoutTail = clipTail(`${current.stdoutTail || ''}${String(text || '')}`);
    } else if (stream === 'stderr') {
      current.stderrTail = clipTail(`${current.stderrTail || ''}${String(text || '')}`);
    }
    current.operatorExecution = buildOperatorExecutionSnapshot(current, {
      logTail: current.logTail,
      stdoutTail: current.stdoutTail,
      stderrTail: current.stderrTail,
    });
    this._recordRun(current);
    this._emitRunEvent({
      runId,
      state: RUN_STATES.RUNNING,
      timestamp: nowIso(),
      label: current.label || fallbackLabel,
      workspaceRoot: current.workspaceRoot,
      labRoot: current.labRoot,
      changeSessionId: current.changeSessionId,
      logChunk: String(text || ''),
      stream,
      checks: current.checks,
      locations: current.locations,
      artifactPaths: current.artifactPaths,
      laneId: current.laneId,
      laneLabel: current.laneLabel,
      modelProfileId: current.modelProfileId,
      modelRole: current.modelRole,
      modelDisplayName: current.modelDisplayName,
      baseModel: current.baseModel,
      providerSource: current.providerSource,
      task: current.task,
      taskMode: current.taskMode,
      operatorExecution: current.operatorExecution,
    });
  }
}

function normalizeTicket(value) {
  const match = String(value || '').match(/(?:BAT<)?(\d+)>?/i);
  return match ? match[1] : '';
}

module.exports = {
  SharedAgentRuntime,
  buildOperatorExecutionSnapshot,
  hasMeaningfulMemoryHints,
  mergeMemoryHints,
  normalizeMemoryHints,
  normalizeTicket,
};
