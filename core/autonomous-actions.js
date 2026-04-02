'use strict';

const DAILY_SAFE_ACTION_TARGET = 5;
const ACTION_SAMPLE_LIMIT = 20;

const ENGINE_TASK_MODES = new Set(['planner', 'validator', 'summarizer', 'summary', 'research']);
const NON_DAILY_AUTONOMY_ACTION_PATTERN = /\b(benchmark|promotion|export|training|foundry|release)\b/i;

function clampLevel(value) {
  return Math.max(1, Math.min(5, Number(value || 1)));
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value || 0))));
}

function normalizePathLike(value) {
  return String(value || '').trim().replace(/\\/g, '/');
}

function normalizePathFilter(value) {
  return normalizePathLike(value).toLowerCase();
}

function normalizeTaskFilter(value) {
  return String(value || '').trim().toLowerCase();
}

function padDatePart(value) {
  return String(Math.max(0, Number(value || 0))).padStart(2, '0');
}

function localDayKey(value) {
  const stamp = value instanceof Date
    ? value.getTime()
    : (Number.isFinite(Number(value)) ? Number(value) : Date.parse(String(value || '')));
  const moment = new Date(Number.isFinite(stamp) ? stamp : Date.now());
  return `${moment.getFullYear()}-${padDatePart(moment.getMonth() + 1)}-${padDatePart(moment.getDate())}`;
}

function shortText(value, maxLength = 180) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}...` : text;
}

function slugify(value, fallback = 'item') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function normalizeRuns(runtimeState = {}) {
  if (Array.isArray(runtimeState?.latest) && runtimeState.latest.length > 0) {
    return runtimeState.latest;
  }
  return Array.isArray(runtimeState?.runs) ? runtimeState.runs : [];
}

function normalizeWorkspaceRoots(values = []) {
  return Array.from(new Set(
    values
      .map((item) => normalizePathFilter(item))
      .filter(Boolean),
  ));
}

function normalizeWorkspaceScope(options = {}) {
  return {
    workspaceRoot: normalizePathFilter(options.workspaceRoot || ''),
    targetWorkspaceRoot: normalizePathFilter(options.targetWorkspaceRoot || ''),
    labRoot: normalizePathFilter(options.labRoot || ''),
    roots: normalizeWorkspaceRoots([
      options.workspaceRoot,
      options.targetWorkspaceRoot,
      options.labRoot,
    ]),
  };
}

function collectRunWorkspaceRoots(run = {}) {
  const execution = run?.operatorExecution && typeof run.operatorExecution === 'object'
    ? run.operatorExecution
    : {};
  const metadata = run?.metadata && typeof run.metadata === 'object'
    ? run.metadata
    : (execution?.metadata && typeof execution.metadata === 'object' ? execution.metadata : {});
  const runtimeContext = run?.runtimeContext && typeof run.runtimeContext === 'object'
    ? run.runtimeContext
    : {};
  const runtimeMetadata = run?.runtimeResult?.metadata && typeof run.runtimeResult.metadata === 'object'
    ? run.runtimeResult.metadata
    : {};
  const hostBoundary = runtimeContext?.host_boundary && typeof runtimeContext.host_boundary === 'object'
    ? runtimeContext.host_boundary
    : {};
  const safetyStatus = hostBoundary?.safetyStatus && typeof hostBoundary.safetyStatus === 'object'
    ? hostBoundary.safetyStatus
    : {};
  return normalizeWorkspaceRoots([
    run?.workspaceRoot,
    run?.targetWorkspaceRoot,
    run?.projectRoot,
    run?.sourceRoot,
    run?.labRoot,
    execution?.workspaceRoot,
    execution?.targetWorkspaceRoot,
    execution?.projectRoot,
    execution?.sourceRoot,
    execution?.labRoot,
    metadata?.workspaceRoot,
    metadata?.targetWorkspaceRoot,
    metadata?.projectRoot,
    metadata?.sourceRoot,
    metadata?.labRoot,
    metadata?.workspaceScopeRoot,
    metadata?.workspace_scope_root,
    runtimeMetadata?.workspaceRoot,
    runtimeMetadata?.targetWorkspaceRoot,
    runtimeMetadata?.projectRoot,
    runtimeMetadata?.sourceRoot,
    runtimeMetadata?.labRoot,
    runtimeMetadata?.workspaceScopeRoot,
    runtimeContext?.workspaceRoot,
    runtimeContext?.targetWorkspaceRoot,
    runtimeContext?.projectRoot,
    runtimeContext?.sourceRoot,
    runtimeContext?.labRoot,
    runtimeContext?.workspace_root,
    runtimeContext?.target_workspace_root,
    runtimeContext?.project_root,
    runtimeContext?.source_root,
    runtimeContext?.lab_root,
    hostBoundary?.workspaceRoot,
    hostBoundary?.targetWorkspaceRoot,
    hostBoundary?.labRoot,
    safetyStatus?.workspaceRoot,
    safetyStatus?.targetWorkspaceRoot,
    safetyStatus?.labRoot,
  ]);
}

function collectPreferredRunWorkspaceRoots(run = {}) {
  const execution = run?.operatorExecution && typeof run.operatorExecution === 'object'
    ? run.operatorExecution
    : {};
  const metadata = run?.metadata && typeof run.metadata === 'object'
    ? run.metadata
    : (execution?.metadata && typeof execution.metadata === 'object' ? execution.metadata : {});
  const runtimeContext = run?.runtimeContext && typeof run.runtimeContext === 'object'
    ? run.runtimeContext
    : {};
  const runtimeMetadata = run?.runtimeResult?.metadata && typeof run.runtimeResult.metadata === 'object'
    ? run.runtimeResult.metadata
    : {};
  const hostBoundary = runtimeContext?.host_boundary && typeof runtimeContext.host_boundary === 'object'
    ? runtimeContext.host_boundary
    : {};
  const safetyStatus = hostBoundary?.safetyStatus && typeof hostBoundary.safetyStatus === 'object'
    ? hostBoundary.safetyStatus
    : {};
  return normalizeWorkspaceRoots([
    run?.targetWorkspaceRoot,
    run?.projectRoot,
    run?.sourceRoot,
    run?.labRoot,
    execution?.targetWorkspaceRoot,
    execution?.projectRoot,
    execution?.sourceRoot,
    execution?.labRoot,
    metadata?.targetWorkspaceRoot,
    metadata?.projectRoot,
    metadata?.sourceRoot,
    metadata?.labRoot,
    metadata?.workspaceScopeRoot,
    metadata?.workspace_scope_root,
    runtimeMetadata?.targetWorkspaceRoot,
    runtimeMetadata?.projectRoot,
    runtimeMetadata?.sourceRoot,
    runtimeMetadata?.labRoot,
    runtimeMetadata?.workspaceScopeRoot,
    runtimeContext?.targetWorkspaceRoot,
    runtimeContext?.projectRoot,
    runtimeContext?.sourceRoot,
    runtimeContext?.labRoot,
    runtimeContext?.target_workspace_root,
    runtimeContext?.project_root,
    runtimeContext?.source_root,
    runtimeContext?.lab_root,
    hostBoundary?.targetWorkspaceRoot,
    hostBoundary?.labRoot,
    safetyStatus?.targetWorkspaceRoot,
    safetyStatus?.labRoot,
  ]);
}

function runMatchesWorkspaceScope(run = {}, workspaceScope = {}) {
  if (!Array.isArray(workspaceScope?.roots) || workspaceScope.roots.length === 0) {
    return true;
  }
  const runRoots = collectPreferredRunWorkspaceRoots(run);
  if (runRoots.length > 0) {
    return runRoots.some((item) => workspaceScope.roots.includes(item));
  }
  const fallbackRoots = collectRunWorkspaceRoots(run);
  if (fallbackRoots.length === 0) {
    return false;
  }
  return fallbackRoots.some((item) => workspaceScope.roots.includes(item));
}

function normalizeProofActions(value) {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object')
    : [];
}

function normalizeChangedFiles(run = {}) {
  const execution = run.operatorExecution && typeof run.operatorExecution === 'object'
    ? run.operatorExecution
    : {};
  const changedFiles = Array.isArray(execution.changedFiles)
    ? execution.changedFiles
    : (Array.isArray(run.changedFiles) ? run.changedFiles : []);
  return changedFiles
    .map((item) => {
      if (typeof item === 'string') {
        return { path: normalizePathLike(item), status: '' };
      }
      return {
        path: normalizePathLike(item?.path || item?.file || ''),
        status: String(item?.status || '').trim(),
      };
    })
    .filter((item) => item.path);
}

function runMatchesFilters(run = {}, filters = {}) {
  const runId = String(filters.runId || '').trim();
  const taskFilter = normalizeTaskFilter(filters.task);
  const pathFilter = normalizePathFilter(filters.path);
  if (runId && String(run?.runId || '').trim() !== runId) {
    return false;
  }
  if (taskFilter) {
    const text = [
      run?.task,
      run?.label,
      run?.ticket,
      run?.operatorExecution?.task,
      run?.operatorExecution?.resultSummary,
    ].map((item) => String(item || '').toLowerCase()).join(' ');
    if (!text.includes(taskFilter)) {
      return false;
    }
  }
  if (pathFilter) {
    const changedFiles = normalizeChangedFiles(run);
    if (!changedFiles.some((item) => item.path.toLowerCase().includes(pathFilter))) {
      return false;
    }
  }
  return true;
}

function inferRunRole(run = {}) {
  const metadata = run?.metadata && typeof run.metadata === 'object'
    ? run.metadata
    : (run?.operatorExecution?.metadata && typeof run.operatorExecution.metadata === 'object' ? run.operatorExecution.metadata : {});
  const explicitRole = String(
    run?.operatorExecution?.modelRole
    || metadata?.requestedModelRole
    || metadata?.requested_model_role
    || metadata?.modelRole
    || run?.modelRole
    || '',
  ).trim().toLowerCase();
  if (explicitRole === 'engine' || explicitRole === 'workspace') {
    return explicitRole;
  }
  const taskMode = String(run?.operatorExecution?.taskMode || run?.taskMode || '').trim().toLowerCase();
  return ENGINE_TASK_MODES.has(taskMode) ? 'engine' : 'workspace';
}

function resolveModelInfo(run = {}, modelRoles = {}) {
  const role = inferRunRole(run);
  const roleInfo = modelRoles?.[role] && typeof modelRoles[role] === 'object'
    ? modelRoles[role]
    : {};
  return {
    role,
    modelProfileId: String(
      run?.operatorExecution?.modelProfileId
      || run?.modelProfileId
      || roleInfo.modelProfileId
      || ''
    ).trim(),
    modelDisplayName: String(
      run?.operatorExecution?.modelDisplayName
      || run?.modelDisplayName
      || roleInfo.modelDisplayName
      || ''
    ).trim(),
    baseModel: String(
      run?.operatorExecution?.baseModel
      || run?.baseModel
      || roleInfo.baseModel
      || ''
    ).trim(),
    providerSource: String(
      run?.operatorExecution?.providerSource
      || run?.providerSource
      || roleInfo.providerSource
      || ''
    ).trim().toLowerCase(),
  };
}

function inferTaskRole(task = {}) {
  const explicitRole = String(
    task?.modelRole
    || task?.metadata?.requestedModelRole
    || task?.metadata?.requested_model_role
    || task?.metadata?.modelRole
    || '',
  ).trim().toLowerCase();
  if (explicitRole === 'engine' || explicitRole === 'workspace') {
    return explicitRole;
  }
  const capabilities = Array.isArray(task?.capabilities)
    ? task.capabilities.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
  if (capabilities.some((item) => ['code-main', 'repair-fast'].includes(item))) {
    return 'workspace';
  }
  if (capabilities.some((item) => ['plan-reasoning', 'review-verify', 'research-docs', 'ops-summary'].includes(item))) {
    return 'engine';
  }
  const objective = String(task?.objective || task?.title || '').trim().toLowerCase();
  if (/(build|create|implement|write|code|refactor|fix|repair|debug|update)/.test(objective)) {
    return 'workspace';
  }
  return 'engine';
}

function resolveTaskModelInfo(task = {}, modelRoles = {}) {
  const role = inferTaskRole(task);
  const roleInfo = modelRoles?.[role] && typeof modelRoles[role] === 'object'
    ? modelRoles[role]
    : {};
  return {
    role,
    modelProfileId: String(roleInfo.modelProfileId || '').trim(),
    modelDisplayName: String(roleInfo.modelDisplayName || '').trim(),
    baseModel: String(roleInfo.baseModel || '').trim(),
    providerSource: String(roleInfo.providerSource || roleInfo.baseProvider || '').trim().toLowerCase(),
  };
}

function inferModelLevel(modelInfo = {}) {
  const text = [
    modelInfo.modelProfileId,
    modelInfo.modelDisplayName,
    modelInfo.baseModel,
    modelInfo.providerSource,
  ].map((item) => String(item || '').toLowerCase()).join(' ');

  if (!text) {
    return { level: 2, label: 'unknown', reason: 'No model metadata was available.' };
  }
  if (/\b(gpt-5|o3|o4|claude-4|claude opus|opus-4|70b|72b|405b)\b/.test(text)) {
    return { level: 5, label: 'elite', reason: 'Large frontier model or top-tier custom profile.' };
  }
  if (/\b(1b|2b|3b)\b/.test(text)) {
    return { level: 1, label: 'tiny', reason: 'Very small model that should only take low-difficulty tasks.' };
  }
  if (/\b(7b|8b|coder-mini|mini)\b/.test(text)) {
    return { level: 2, label: 'light', reason: 'Compact model that should stay on smaller bounded slices.' };
  }
  if (/\b(gse-1|gpt-4|claude sonnet|32b|34b|40b)\b/.test(text)) {
    return { level: 4, label: 'strong', reason: 'Engine-grade reasoning model or large custom profile.' };
  }
  if (/\b(gs-dev-1|14b|15b|13b)\b/.test(text)) {
    return { level: 3, label: 'solid', reason: 'Mid-tier coding model suited to bounded repo work.' };
  }
  return { level: 2, label: 'light', reason: 'Defaulting to a conservative bounded-work estimate.' };
}

function inferTaskDifficulty(task = {}) {
  const objective = [
    task?.objective,
    task?.title,
    task?.metadata?.batSummary,
    task?.metadata?.compatSource,
  ].map((item) => String(item || '').toLowerCase()).join(' ');
  const capabilities = Array.isArray(task?.capabilities)
    ? task.capabilities.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const targetPathCount = Array.isArray(task?.sliceTargetPaths) ? task.sliceTargetPaths.length : 0;
  const sliceCount = Array.isArray(task?.slices) ? task.slices.length : 0;
  const acceptanceCheckCount = Array.isArray(task?.acceptanceChecks) ? task.acceptanceChecks.length : 0;
  let level = 1;
  const reasons = [];

  if (capabilities.some((item) => ['code-main', 'repair-fast'].includes(item))) {
    level += 2;
    reasons.push('repo editing path');
  } else if (capabilities.some((item) => ['plan-reasoning', 'review-verify', 'research-docs', 'ops-summary'].includes(item))) {
    level += 1;
    reasons.push('engine reasoning path');
  }
  if (sliceCount >= 3) {
    level += 1;
    reasons.push('multi-stage task slices');
  }
  if (targetPathCount >= 3) {
    level += 1;
    reasons.push('multi-file scope');
  }
  if (targetPathCount >= 8) {
    level += 1;
    reasons.push('broad file impact');
  }
  if (acceptanceCheckCount >= 3) {
    level += 1;
    reasons.push('heavier validation burden');
  }
  if (String(task?.riskClass || '').trim().toLowerCase() === 'high') {
    level += 1;
    reasons.push('high-risk scope');
  }
  if (/(benchmark|promotion|training|export|foundry|acceptance|release|migration)/.test(objective)) {
    level += 1;
    reasons.push('release-grade or benchmark-critical work');
  }
  if (/(repair|recover|debug|refactor)/.test(objective)) {
    level += 1;
    reasons.push('repair pressure');
  }

  const clamped = clampLevel(level);
  const label = clamped >= 5
    ? 'expert'
    : clamped === 4
      ? 'advanced'
      : clamped === 3
        ? 'bounded'
        : clamped === 2
          ? 'light'
          : 'starter';
  return {
    level: clamped,
    label,
    reasons,
  };
}

function summarizeReview(run = {}) {
  const review = run?.operatorExecution?.reviewSummary && typeof run.operatorExecution.reviewSummary === 'object'
    ? run.operatorExecution.reviewSummary
    : (run?.reviewSummary && typeof run.reviewSummary === 'object' ? run.reviewSummary : {});
  return {
    requiresManualReview: review.requiresManualReview === true || review.requires_manual_review === true,
    pendingApprovalCount: Number(review.pendingApprovalCount ?? review.pending_approval_count ?? 0),
    lowConfidencePatchCount: Number(review.lowConfidencePatchCount ?? review.low_confidence_patch_count ?? 0),
    summary: String(review.summary || '').trim(),
  };
}

function summarizeTrust(run = {}) {
  const trust = run?.operatorExecution?.trustSummary && typeof run.operatorExecution.trustSummary === 'object'
    ? run.operatorExecution.trustSummary
    : (run?.trustSummary && typeof run.trustSummary === 'object' ? run.trustSummary : {});
  return {
    state: String(trust.trust_state || trust.trustState || trust.status || '').trim().toLowerCase(),
    summary: String(trust.summary || '').trim(),
  };
}

function inferDifficulty(run = {}, changedFiles = [], review = {}, trust = {}) {
  const taskMode = String(run?.operatorExecution?.taskMode || run?.taskMode || '').trim().toLowerCase();
  const action = String(run?.action || '').trim().toLowerCase();
  const taskText = [
    run?.task,
    run?.operatorExecution?.task,
    run?.label,
    run?.operatorExecution?.resultSummary,
  ].map((item) => String(item || '').toLowerCase()).join(' ');
  let level = 1;
  const reasons = [];
  const readOnlyEngineLikeTask = changedFiles.length === 0
    && (
      ENGINE_TASK_MODES.has(taskMode)
      || /(plan|review|summarize|summary|research|inspect|validate|acceptance|blocker|read-only|read only|snapshot|compare)/.test(taskText)
    );

  if (action === 'orchestrate' || action === 'self-improve') {
    level += 1;
    reasons.push('multi-stage orchestration');
  }
  if (taskMode === 'coder' || taskMode === 'repair') {
    if (readOnlyEngineLikeTask) {
      level += 1;
      reasons.push('bounded read-only engine pass');
    } else {
      level += 2;
      reasons.push('repo editing path');
    }
  } else if (taskMode === 'planner' || taskMode === 'validator' || taskMode === 'research' || taskMode === 'summarizer') {
    level += 1;
    reasons.push('engine reasoning path');
  }
  if (changedFiles.length >= 3) {
    level += 1;
    reasons.push('multi-file scope');
  }
  if (changedFiles.length >= 8) {
    level += 1;
    reasons.push('broad file impact');
  }
  if (/(benchmark|promotion|training|export|foundry|acceptance)/.test(taskText)) {
    level += 1;
    reasons.push('release-grade or benchmark-critical work');
  }
  if (review.requiresManualReview || review.pendingApprovalCount > 0 || review.lowConfidencePatchCount > 0) {
    level += 1;
    reasons.push('review or approval pressure');
  }
  if (trust.state && !['ready', 'trusted', 'pass', 'green'].includes(trust.state)) {
    level += 1;
    reasons.push('trust not yet clear');
  }
  if (String(run?.state || '').trim().toLowerCase() === 'fail') {
    level += 1;
    reasons.push('repair pressure after failure');
  }

  const clamped = clampLevel(level);
  const label = clamped >= 5
    ? 'expert'
    : clamped === 4
      ? 'advanced'
      : clamped === 3
        ? 'bounded'
        : clamped === 2
          ? 'light'
          : 'starter';
  return {
    level: clamped,
    label,
    reasons,
  };
}

function classifyCapabilityFit(modelLevel, difficultyLevel) {
  const gap = Number(modelLevel || 0) - Number(difficultyLevel || 0);
  if (gap >= 1) {
    return { label: 'comfortable', gap };
  }
  if (gap === 0) {
    return { label: 'tight', gap };
  }
  if (gap === -1) {
    return { label: 'stretched', gap };
  }
  return { label: 'overscoped', gap };
}

function computeTaskAutomationScore(task = {}, fit = {}) {
  const riskClass = String(task?.riskClass || '').trim().toLowerCase();
  const targetPathCount = Array.isArray(task?.sliceTargetPaths) ? task.sliceTargetPaths.length : 0;
  const sliceCount = Array.isArray(task?.slices) ? task.slices.length : 0;
  const trustedDocCount = Array.isArray(task?.metadata?.trustedDocs) ? task.metadata.trustedDocs.length : 0;
  let score = 70;
  if (fit.label === 'comfortable') {
    score += 12;
  } else if (fit.label === 'tight') {
    score += 6;
  } else if (fit.label === 'stretched') {
    score -= 10;
  } else if (fit.label === 'overscoped') {
    score -= 28;
  }
  if (riskClass === 'high') {
    score -= 10;
  } else if (riskClass === 'low') {
    score += 4;
  }
  if (targetPathCount >= 3) {
    score -= 6;
  }
  if (targetPathCount >= 8) {
    score -= 6;
  }
  if (sliceCount >= 3) {
    score += 4;
  }
  if (trustedDocCount > 0) {
    score += 3;
  }
  return clampScore(score);
}

function computeAutomationScore(run = {}, fit = {}, review = {}, trust = {}) {
  const state = String(run?.state || '').trim().toLowerCase();
  let score = state === 'pass'
    ? 78
    : state === 'running'
      ? 55
      : state === 'skipped'
        ? 42
        : 24;
  if (fit.label === 'comfortable') {
    score += 12;
  } else if (fit.label === 'tight') {
    score += 6;
  } else if (fit.label === 'stretched') {
    score -= 12;
  } else if (fit.label === 'overscoped') {
    score -= 24;
  }
  if (review.requiresManualReview) {
    score -= 14;
  }
  score -= Math.min(10, Number(review.pendingApprovalCount || 0) * 5);
  score -= Math.min(12, Number(review.lowConfidencePatchCount || 0) * 6);
  if (trust.state && ['ready', 'trusted', 'pass', 'green'].includes(trust.state)) {
    score += 5;
  } else if (trust.state) {
    score -= 8;
  }
  return clampScore(score);
}

function inferActionText(run = {}) {
  return [
    run?.task,
    run?.label,
    run?.operatorExecution?.task,
    run?.operatorExecution?.resultSummary,
  ].map((item) => String(item || '').trim()).filter(Boolean).join(' ');
}

function isProofAction(run = {}) {
  const metadata = run?.metadata && typeof run.metadata === 'object'
    ? run.metadata
    : (run?.operatorExecution?.metadata && typeof run.operatorExecution.metadata === 'object' ? run.operatorExecution.metadata : {});
  return metadata.autonomyProof === true;
}

function looksInfrastructureFailure(...values) {
  const haystack = values.map((value) => String(value || '').trim()).filter(Boolean).join('\n').toLowerCase();
  if (!haystack) {
    return false;
  }
  return /could not start the python runtime|spawn .* enoent|ticket id is required|invalid ticket id|runtime launch failed|python runtime is not available/.test(haystack);
}

function runLooksInfrastructureFailure(run = {}) {
  return looksInfrastructureFailure(
    run?.stderrTail,
    run?.stdoutTail,
    run?.logTail,
    run?.blockedReason,
    run?.message,
    run?.operatorExecution?.resultSummary,
    run?.operatorExecution?.outputTail?.stderr,
    run?.operatorExecution?.outputTail?.stdout,
  );
}

function countsTowardDailyAutonomy(run = {}, entry = {}) {
  const taskText = inferActionText(run).toLowerCase();
  if (NON_DAILY_AUTONOMY_ACTION_PATTERN.test(taskText) && !isProofAction(run)) {
    return false;
  }
  if (runLooksInfrastructureFailure(run)) {
    return false;
  }
  const state = String(entry?.state || run?.state || '').trim().toLowerCase();
  return ['pass', 'fail', 'running', 'warn', 'blocked', 'cancelled', 'skipped'].includes(state);
}

function buildTaskAutonomyAssessment(task = {}, modelRoles = {}) {
  const model = resolveTaskModelInfo(task, modelRoles);
  const modelLevel = inferModelLevel(model);
  const difficulty = inferTaskDifficulty(task);
  const fit = classifyCapabilityFit(modelLevel.level, difficulty.level);
  const automationScore = computeTaskAutomationScore(task, fit);
  const taskLabel = shortText(task?.objective || task?.title || 'the current task');
  const recommendedDifficulty = Math.max(1, Number(modelLevel.level || 1));
  const recommendedAction = fit.label === 'overscoped'
    ? `Rescope "${taskLabel}" to difficulty ${recommendedDifficulty}/5 or reroute it to a stronger model before launching.`
    : fit.label === 'stretched'
      ? `Keep "${taskLabel}" tightly bounded, or move it to a stronger model before widening the slice.`
      : `The task fits the current ${model.role || 'assigned'} model envelope. Keep the slice bounded and reviewed.`;
  return {
    requestedModelRole: model.role,
    modelProfileId: model.modelProfileId,
    modelDisplayName: model.modelDisplayName || model.baseModel || 'Unknown model',
    providerSource: model.providerSource,
    modelLevel: modelLevel.level,
    modelLevelLabel: modelLevel.label,
    modelLevelReason: modelLevel.reason,
    difficultyLevel: difficulty.level,
    difficultyLabel: difficulty.label,
    difficultyReasons: difficulty.reasons,
    capabilityFit: fit.label,
    capabilityGap: fit.gap,
    automationScore,
    safeToLaunch: fit.label !== 'overscoped',
    blockingReason: fit.label === 'overscoped' ? recommendedAction : '',
    recommendedAction,
  };
}

function buildAutonomyRescopeTask(task = {}, assessment = {}, options = {}) {
  const ceiling = clampLevel(
    options.autonomyDifficultyCeiling
    || assessment.modelLevel
    || task?.metadata?.autonomyDifficultyCeiling
    || task?.metadata?.autonomy_difficulty_ceiling
    || 1,
  );
  const taskLabel = shortText(task?.objective || task?.task || task?.title || 'the current task', 120);
  const blockedBy = String(options.blockedBy || 'model-fit').trim().toLowerCase() || 'model-fit';
  const blockedReason = shortText(
    options.blockedReason
    || assessment.blockingReason
    || assessment.recommendedAction
    || 'Rescope this task before retrying.',
    220,
  );
  const requestedModelRole = String(
    assessment.requestedModelRole
    || task?.modelRole
    || task?.metadata?.requestedModelRole
    || task?.metadata?.requested_model_role
    || '',
  ).trim().toLowerCase();
  const taskMode = String(
    task?.taskMode
    || task?.task_mode
    || task?.metadata?.taskMode
    || task?.metadata?.task_mode
    || '',
  ).trim().toLowerCase();
  const routeLaneId = String(
    task?.laneId
    || task?.metadata?.lane_id
    || task?.metadata?.routeLaneId
    || '',
  ).trim().toLowerCase();
  const limitedPaths = Array.isArray(task?.sliceTargetPaths)
    ? task.sliceTargetPaths.map((item) => normalizePathLike(item)).filter(Boolean).slice(0, Math.max(1, Math.min(2, ceiling)))
    : [];
  const signatureSeed = [
    taskLabel,
    blockedBy,
    requestedModelRole,
    taskMode,
    ...limitedPaths,
  ].filter(Boolean).join('-');
  return {
    title: `Rescope ${taskLabel}`,
    objective: [
      `Rescope "${taskLabel}" into one lab-safe slice that stays at difficulty ${ceiling}/5 or lower.`,
      limitedPaths.length > 0
        ? `Keep the retry focused on ${limitedPaths.join(', ')}.`
        : 'Keep the retry limited to one or two files.',
      'Run the smallest relevant validation before widening again.',
    ].join(' '),
    status: 'needs-rescope',
    ring: 'lab',
    sliceTargetPaths: limitedPaths,
    slices: [
      {
        id: 'scope',
        title: 'Pin the smallest failing scope',
        summary: 'Limit the retry to one bounded change and the smallest useful validation command.',
      },
      {
        id: 'implement',
        title: 'Retry in a clone lab',
        summary: 'Keep the follow-up inside a lab so repo protection and approvals do not distort the proof.',
      },
      {
        id: 'validate',
        title: 'Re-run focused validation',
        summary: 'Record whether the smaller slice is now clean before widening the next pass.',
      },
    ],
    metadata: {
      autoRescoped: true,
      followupSignature: `autonomy-rescope:${slugify(signatureSeed, 'task')}`,
      lastBlockedBy: blockedBy,
      lastBlockedReason: blockedReason,
      requestedModelRole,
      routeLaneId,
      taskMode,
      autonomyDifficultyCeiling: ceiling,
      sourceTaskTitle: taskLabel,
    },
  };
}

function runTimestamp(run = {}) {
  const raw = String(run?.endedAt || run?.startedAt || '').trim();
  const value = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(value) ? value : 0;
}

function buildActionEntry(run = {}, modelRoles = {}) {
  const changedFiles = normalizeChangedFiles(run);
  const model = resolveModelInfo(run, modelRoles);
  const modelLevel = inferModelLevel(model);
  const review = summarizeReview(run);
  const trust = summarizeTrust(run);
  const difficulty = inferDifficulty(run, changedFiles, review, trust);
  const fit = classifyCapabilityFit(modelLevel.level, difficulty.level);
  const automationScore = computeAutomationScore(run, fit, review, trust);
  const state = String(run?.state || '').trim().toLowerCase() || 'unknown';
  const countsTowardDailyTarget = countsTowardDailyAutonomy(run, { state });
  const readOnlyEngineTask = model.role === 'engine'
    && changedFiles.length === 0
    && fit.label !== 'overscoped';
  const safeToAdvance = state === 'pass'
    && !review.requiresManualReview
    && review.pendingApprovalCount === 0
    && fit.label !== 'overscoped'
    && countsTowardDailyTarget
    && (automationScore >= 70 || (readOnlyEngineTask && automationScore >= 60));
  return {
    runId: String(run?.runId || '').trim(),
    ticket: String(run?.ticket || '').trim(),
    action: String(run?.action || '').trim().toLowerCase(),
    label: String(run?.label || '').trim(),
    state,
    task: shortText(run?.operatorExecution?.task || run?.task || run?.label || ''),
    taskMode: String(run?.operatorExecution?.taskMode || run?.taskMode || '').trim().toLowerCase(),
    changedFiles: changedFiles.slice(0, 4),
    changedFileCount: changedFiles.length,
    startedAt: String(run?.startedAt || '').trim(),
    endedAt: String(run?.endedAt || '').trim(),
    modelRole: model.role,
    modelProfileId: model.modelProfileId,
    modelDisplayName: model.modelDisplayName || model.baseModel || 'Unknown model',
    baseModel: model.baseModel,
    providerSource: model.providerSource,
    modelLevel: modelLevel.level,
    modelLevelLabel: modelLevel.label,
    modelLevelReason: modelLevel.reason,
    difficultyLevel: difficulty.level,
    difficultyLabel: difficulty.label,
    difficultyReasons: difficulty.reasons,
    capabilityFit: fit.label,
    capabilityGap: fit.gap,
    reviewSummary: review,
    trustSummary: trust,
    automationScore,
    countsTowardDailyTarget,
    safeToAdvance,
    outputSummary: shortText(
      run?.operatorExecution?.resultSummary
      || review.summary
      || trust.summary
      || run?.blockedReason
      || run?.label
      || '',
    ),
  };
}

function summarizeArea(actions = [], dailyProgress = {}) {
  if (!actions.length) {
    return 'No autonomous actions have been recorded yet.';
  }
  const overscopedCount = actions.filter((item) => item.capabilityFit === 'overscoped').length;
  const blockedCount = actions.filter((item) => item.reviewSummary.requiresManualReview || item.state === 'fail').length;
  if (overscopedCount > 0) {
    return `${overscopedCount} autonomous action(s) are overscoped for the assigned model. Safe daily progress is ${dailyProgress.safeCount || 0}/${dailyProgress.target || DAILY_SAFE_ACTION_TARGET}.`;
  }
  if (blockedCount > 0) {
    return `${blockedCount} autonomous action(s) still need review or repair. Safe daily progress is ${dailyProgress.safeCount || 0}/${dailyProgress.target || DAILY_SAFE_ACTION_TARGET}.`;
  }
  return `Safe daily progress is ${dailyProgress.safeCount || 0}/${dailyProgress.target || DAILY_SAFE_ACTION_TARGET}. Recent autonomous actions match the current model envelope.`;
}

function buildRecommendedNextSafeAction(summary = {}) {
  const highestRiskAction = summary.highestRiskAction && typeof summary.highestRiskAction === 'object'
    ? summary.highestRiskAction
    : null;
  const dailyTarget = summary.dailyTarget && typeof summary.dailyTarget === 'object'
    ? summary.dailyTarget
    : {};
  if (!summary.actionCount) {
    return 'Start with one low-difficulty bounded autonomous slice and validate it end-to-end before scaling up.';
  }
  if (Number(summary.overscopedCount || 0) > 0 && highestRiskAction) {
    const taskLabel = highestRiskAction.task || highestRiskAction.label || 'the current autonomous task';
    return `Rescope "${taskLabel}" to difficulty ${Math.max(1, Number(highestRiskAction.modelLevel || 1))}/5 or reroute it to a stronger model before retrying.`;
  }
  if (Number(summary.reviewBlockedCount || 0) > 0 && highestRiskAction) {
    const taskLabel = highestRiskAction.task || highestRiskAction.label || 'the latest autonomous task';
    return `Repair or review "${taskLabel}" before queueing more autonomous work.`;
  }
  if (!dailyTarget.met) {
    return `${Math.max(0, Number(dailyTarget.remaining || 0))} more safe autonomous action(s) are needed today; keep the next slices bounded and low-difficulty.`;
  }
  return 'Advance with another bounded autonomous slice at or below the current model level and keep acceptance green.';
}

function actionNeedsReview(action = {}) {
  return action?.reviewSummary?.requiresManualReview === true
    || Number(action?.reviewSummary?.pendingApprovalCount || 0) > 0;
}

function inferActionBlockerKind(action = {}) {
  if (String(action?.capabilityFit || '').trim().toLowerCase() === 'overscoped') {
    return 'model-fit';
  }
  if (actionNeedsReview(action)) {
    return 'review-held';
  }
  if (String(action?.state || '').trim().toLowerCase() === 'fail') {
    return 'validation-fail';
  }
  if (String(action?.capabilityFit || '').trim().toLowerCase() === 'stretched') {
    return 'tight-fit';
  }
  return '';
}

function buildAutonomyBlockers(actions = [], highestRiskAction = null) {
  const scopedActions = Array.isArray(actions) ? actions : [];
  const blockedActions = scopedActions.filter((action) => inferActionBlockerKind(action));
  const modelFitCount = blockedActions.filter((action) => inferActionBlockerKind(action) === 'model-fit').length;
  const reviewHeldCount = blockedActions.filter((action) => inferActionBlockerKind(action) === 'review-held').length;
  const validationFailCount = blockedActions.filter((action) => inferActionBlockerKind(action) === 'validation-fail').length;
  const tightFitCount = blockedActions.filter((action) => inferActionBlockerKind(action) === 'tight-fit').length;
  const topAction = inferActionBlockerKind(highestRiskAction)
    ? highestRiskAction
    : blockedActions[0] || null;
  const summary = blockedActions.length === 0
    ? 'No autonomy blockers are active in the current workspace.'
    : `Autonomy blockers: ${modelFitCount} model-fit, ${reviewHeldCount} review-held, ${validationFailCount} validation-fail, ${tightFitCount} tight-fit.`;
  return {
    total: blockedActions.length,
    modelFitCount,
    reviewHeldCount,
    validationFailCount,
    tightFitCount,
    summary,
    topBlocker: topAction
      ? {
          runId: String(topAction.runId || '').trim(),
          task: String(topAction.task || topAction.label || '').trim(),
          blockerKind: inferActionBlockerKind(topAction),
          difficultyLevel: Number(topAction.difficultyLevel || 0),
          modelLevel: Number(topAction.modelLevel || 0),
          capabilityFit: String(topAction.capabilityFit || '').trim().toLowerCase(),
        }
      : null,
  };
}

function buildAutonomyUnlockPlan(summary = {}, actions = [], blockers = {}) {
  const safeActions = (Array.isArray(actions) ? actions : []).filter((action) => action?.safeToAdvance === true);
  const highestRiskAction = summary.highestRiskAction && typeof summary.highestRiskAction === 'object'
    ? summary.highestRiskAction
    : null;
  const provenDifficultyCeiling = Math.max(
    1,
    safeActions.reduce((max, action) => Math.max(max, Number(action?.difficultyLevel || 0)), 0)
      || Number(highestRiskAction?.modelLevel || 1),
  );
  if (!Number(summary.actionCount || 0)) {
    return {
      status: 'seed',
      currentDifficultyCeiling: provenDifficultyCeiling,
      nextDifficultyCeiling: provenDifficultyCeiling,
      summary: 'Seed one bounded autonomous slice and capture proof before widening the difficulty ceiling.',
    };
  }
  if (Number(blockers.total || 0) > 0) {
    return {
      status: 'hold',
      currentDifficultyCeiling: provenDifficultyCeiling,
      nextDifficultyCeiling: Math.max(1, Math.min(provenDifficultyCeiling, Number(highestRiskAction?.modelLevel || provenDifficultyCeiling))),
      summary: `Hold autonomy at difficulty ${provenDifficultyCeiling}/5 until the active blocker queue clears.`,
    };
  }
  if (summary.dailyTarget?.met === true) {
    const nextDifficultyCeiling = Math.min(5, provenDifficultyCeiling + 1);
    return {
      status: 'widen-ready',
      currentDifficultyCeiling: provenDifficultyCeiling,
      nextDifficultyCeiling,
      summary: `Current proof supports widening from difficulty ${provenDifficultyCeiling}/5 to ${nextDifficultyCeiling}/5 on the next bounded slice.`,
    };
  }
  return {
    status: 'collect-proof',
    currentDifficultyCeiling: provenDifficultyCeiling,
    nextDifficultyCeiling: provenDifficultyCeiling,
    summary: `${Math.max(0, Number(summary.dailyTarget?.remaining || 0))} more safe autonomous action(s) are needed before widening past difficulty ${provenDifficultyCeiling}/5.`,
  };
}

function buildAutonomousActionSummary(options = {}) {
  const runtimeState = options.runtimeState && typeof options.runtimeState === 'object'
    ? options.runtimeState
    : {};
  const modelRoles = options.modelRoles && typeof options.modelRoles === 'object'
    ? options.modelRoles
    : {};
  const filters = options.filters && typeof options.filters === 'object'
    ? options.filters
    : {};
  const sampleLimit = Math.max(1, Number(options.sampleLimit || ACTION_SAMPLE_LIMIT));
  const dailyTarget = Math.max(1, Number(options.dailyTarget || DAILY_SAFE_ACTION_TARGET));
  const nowValue = Number.isFinite(Date.parse(String(options.now || ''))) ? Date.parse(String(options.now)) : Date.now();
  const workspaceScope = normalizeWorkspaceScope({
    workspaceRoot: options.workspaceRoot,
    targetWorkspaceRoot: options.targetWorkspaceRoot,
    labRoot: options.labRoot,
  });
  const proofActions = normalizeProofActions(options.proofActions);
  const runs = [...normalizeRuns(runtimeState), ...proofActions]
    .filter((run) => run && typeof run === 'object')
    .filter((run) => runMatchesWorkspaceScope(run, workspaceScope))
    .filter((run) => runMatchesFilters(run, filters));
  const actions = runs.slice(0, sampleLimit).map((run) => buildActionEntry(run, modelRoles));
  const currentDay = localDayKey(nowValue);
  const actionsToday = actions.filter((item) => localDayKey(runTimestamp(item) || nowValue) === currentDay);
  const eligibleActions = actions.filter((item) => item.countsTowardDailyTarget === true);
  const eligibleActionsToday = actionsToday.filter((item) => item.countsTowardDailyTarget === true);
  const validationActionsToday = eligibleActionsToday.filter((item) => item.taskMode === 'validator');
  const safeToday = eligibleActionsToday.filter((item) => item.safeToAdvance);
  const passTodayCount = validationActionsToday.filter((item) => item.state === 'pass').length;
  const failTodayCount = validationActionsToday.filter((item) => ['fail', 'cancelled'].includes(item.state)).length;
  const reviewBlockedTodayCount = validationActionsToday.filter((item) => item.reviewSummary.requiresManualReview || item.reviewSummary.pendingApprovalCount > 0).length;
  const averageAutomationScore = actions.length > 0
    ? Math.round(actions.reduce((sum, item) => sum + Number(item.automationScore || 0), 0) / actions.length)
    : 0;
  const overscopedCount = eligibleActionsToday.filter((item) => item.capabilityFit === 'overscoped').length;
  const stretchedCount = eligibleActionsToday.filter((item) => item.capabilityFit === 'stretched').length;
  const reviewBlockedCount = eligibleActionsToday.filter((item) => item.reviewSummary.requiresManualReview || item.reviewSummary.pendingApprovalCount > 0).length;
  const failureCount = eligibleActionsToday.filter((item) => item.state === 'fail').length;
  const dailyProgress = {
    target: dailyTarget,
    totalCount: eligibleActionsToday.length,
    safeCount: safeToday.length,
    remaining: Math.max(0, dailyTarget - safeToday.length),
    met: safeToday.length >= dailyTarget,
  };
  const riskPool = eligibleActionsToday.length > 0 ? eligibleActionsToday : eligibleActions;
  const scopedActionPool = eligibleActionsToday.length > 0 ? eligibleActionsToday : eligibleActions;
  const highestRiskAction = riskPool
    .slice()
    .sort((left, right) => {
      if (left.capabilityFit !== right.capabilityFit) {
        const order = { overscoped: 0, stretched: 1, tight: 2, comfortable: 3 };
        return Number(order[left.capabilityFit] ?? 9) - Number(order[right.capabilityFit] ?? 9);
      }
      return Number(left.automationScore || 0) - Number(right.automationScore || 0);
    })[0] || null;
  const status = !eligibleActions.length
    ? 'idle'
    : overscopedCount > 0
      ? 'fail'
      : (failureCount > 0 || reviewBlockedCount > 0 || stretchedCount > 0)
        ? 'warn'
        : 'ready';
  const summary = {
    status,
    summary: summarizeArea(eligibleActionsToday.length > 0 ? eligibleActionsToday : eligibleActions, dailyProgress),
    dailyTarget: dailyProgress,
    actionCount: eligibleActionsToday.length,
    currentWorkspaceActionCount: eligibleActionsToday.length,
    currentWorkspaceSafeCount: safeToday.length,
    currentWorkspaceOverscopedCount: overscopedCount,
    historicalActionCount: eligibleActions.length,
    historicalOverscopedCount: eligibleActions.filter((item) => item.capabilityFit === 'overscoped').length,
    safeActionCount: eligibleActions.filter((item) => item.safeToAdvance).length,
    workspaceScoped: workspaceScope.roots.length > 0,
    validationToday: {
      passCount: passTodayCount,
      failCount: failTodayCount,
      reviewBlockedCount: reviewBlockedTodayCount,
    },
    overscopedCount,
    stretchedCount,
    reviewBlockedCount,
    failureCount,
    averageAutomationScore,
    highestRiskAction,
    latestActions: actions.slice(0, 5),
  };
  summary.blockers = buildAutonomyBlockers(scopedActionPool, highestRiskAction);
  summary.unlockPlan = buildAutonomyUnlockPlan(summary, scopedActionPool, summary.blockers);
  summary.recommendedNextSafeAction = buildRecommendedNextSafeAction(summary);
  return summary;
}



function buildAutonomyGraduationPlan(summary = {}, evaluationSnapshot = {}) {
  const ladder = evaluationSnapshot && typeof evaluationSnapshot === 'object' && evaluationSnapshot.autonomyLadder && typeof evaluationSnapshot.autonomyLadder === 'object'
    ? evaluationSnapshot.autonomyLadder
    : (evaluationSnapshot.memory && evaluationSnapshot.memory.autonomy_ladder && typeof evaluationSnapshot.memory.autonomy_ladder === 'object'
      ? evaluationSnapshot.memory.autonomy_ladder
      : {});
  const stage = clampLevel(ladder.stage || ladder.difficulty_ceiling || 1);
  const overscopedCount = Number(summary.currentWorkspaceOverscopedCount || summary.overscopedCount || 0);
  const reviewBlockedCount = Number(summary.reviewBlockedCount || 0);
  const failureCount = Number(summary.failureCount || 0);
  const nextCeiling = overscopedCount > 0 || reviewBlockedCount > 0 || failureCount > 0
    ? Math.max(1, stage - 1)
    : Math.min(5, stage + (Number(summary.currentWorkspaceSafeCount || 0) >= 3 ? 1 : 0));
  return {
    stage,
    nextDifficultyCeiling: nextCeiling,
    canGraduate: nextCeiling > stage,
    shouldHold: nextCeiling < stage || reviewBlockedCount > 0,
    summary: nextCeiling > stage
      ? `Autonomy can widen from stage ${stage} to ${nextCeiling} after another clean bounded pass.`
      : reviewBlockedCount > 0 || failureCount > 0 || overscopedCount > 0
        ? `Hold autonomy at stage ${stage} until review and validation pressure drop.`
        : `Keep autonomy at stage ${stage} and continue collecting proof.`,
  };
}
module.exports = {
  ACTION_SAMPLE_LIMIT,
  DAILY_SAFE_ACTION_TARGET,
  buildAutonomousActionSummary,
  buildAutonomyRescopeTask,
  buildActionEntry,
  buildTaskAutonomyAssessment,
  inferModelLevel,
  inferTaskDifficulty,
  normalizeWorkspaceScope,
  runMatchesWorkspaceScope,
  buildAutonomyGraduationPlan,
};
