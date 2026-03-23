'use strict';

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeState(value, fallback = 'ready') {
  const normalized = normalizeText(value).toLowerCase();
  return normalized || fallback;
}

function includesSelfWorkAction(value) {
  const normalized = normalizeText(value).toLowerCase();
  return /(self-improve|autopilot|repair|implement)/.test(normalized);
}

function looksInfrastructureFailure(...values) {
  const haystack = values.map((value) => normalizeText(value)).filter(Boolean).join('\n').toLowerCase();
  if (!haystack) {
    return false;
  }
  return /could not start the python runtime|spawn .*py\.exe enonent|ticket id is required|invalid ticket id|runtime launch failed|python runtime is not available/.test(haystack);
}

function pushReason(reasons, payload) {
  reasons.push({
    id: String(payload.id || '').trim() || 'reason',
    level: String(payload.level || 'watch').trim().toLowerCase() || 'watch',
    title: String(payload.title || '').trim() || 'Safety notice',
    detail: String(payload.detail || '').trim() || '',
  });
}

function buildSafetyStatus(options = {}) {
  const workspaceRoot = normalizeText(options.workspaceRoot);
  const targetWorkspaceRoot = normalizeText(options.targetWorkspaceRoot || workspaceRoot);
  const labRoot = normalizeText(options.labRoot);
  const appRoot = normalizeText(options.appRoot);
  const baseline = options.baseline && typeof options.baseline === 'object' ? options.baseline : {};
  const latestRuntime = options.latestRuntime && typeof options.latestRuntime === 'object' ? options.latestRuntime : {};
  const assistantConfig = options.assistantConfig && typeof options.assistantConfig === 'object' ? options.assistantConfig : {};
  const backups = Array.isArray(options.backups) ? options.backups : [];
  const promotions = options.promotions && typeof options.promotions === 'object' ? options.promotions : {};
  const resourcePolicy = options.resourcePolicy && typeof options.resourcePolicy === 'object' ? options.resourcePolicy : {};
  const schedulerRunning = options.schedulerRunning === true;
  const reasons = [];
  let state = 'ready';
  let restrictToLabs = false;
  let blockAutonomy = false;
  let blockTraining = false;
  let blockBenchmarks = false;
  let blockPromotions = false;

  if (appRoot && targetWorkspaceRoot && targetWorkspaceRoot === appRoot && !labRoot) {
    state = 'safe-mode';
    restrictToLabs = true;
    blockAutonomy = true;
    blockTraining = true;
    blockBenchmarks = true;
    blockPromotions = true;
    pushReason(reasons, {
      id: 'live-self-target',
      level: 'critical',
      title: 'Live app repo protected',
      detail: 'The standalone desktop repo is selected directly. Self-work must happen in a lab clone before promotion.',
    });
  }

  if (baseline.blocked === true || baseline.backlogPaused === true || baseline.selfHealMode === true || normalizeState(baseline.state) === 'red') {
    state = 'safe-mode';
    blockAutonomy = true;
    blockTraining = true;
    blockBenchmarks = true;
    blockPromotions = true;
    pushReason(reasons, {
      id: 'baseline-self-heal',
      level: 'critical',
      title: 'Baseline self-heal active',
      detail: normalizeText(baseline.reason || baseline.resumeCondition || baseline.hotspot?.summary) || 'The engine baseline is unhealthy, so background autonomy should pause until the workspace is stable again.',
    });
  }

  const latestRuntimeState = normalizeState(latestRuntime.state, 'idle');
  const latestRuntimeLabel = normalizeText(latestRuntime.label || latestRuntime.action);
  const latestRuntimeLooksInfra = looksInfrastructureFailure(
    latestRuntime.blockedReason,
    latestRuntime.stderrTail,
    latestRuntime.stdoutTail,
    latestRuntime.logTail,
    latestRuntime.operatorExecution?.outputTail?.stderr,
    latestRuntime.operatorExecution?.outputTail?.stdout,
  );
  if (latestRuntimeState === 'fail' && includesSelfWorkAction(latestRuntimeLabel) && !latestRuntimeLooksInfra) {
    state = 'safe-mode';
    blockAutonomy = true;
    blockPromotions = true;
    pushReason(reasons, {
      id: 'self-work-failed',
      level: 'critical',
      title: 'Self-work failed recently',
      detail: `${latestRuntimeLabel || 'A recent self-work run'} failed. Promote nothing until the issue is reviewed or isolated in a lab.`,
    });
  }

  if (resourcePolicy.shouldThrottleBackgroundWork && state !== 'safe-mode') {
    state = 'watch';
    blockTraining = true;
    blockBenchmarks = true;
    pushReason(reasons, {
      id: 'resource-throttle',
      level: 'watch',
      title: 'Background work is throttled',
      detail: normalizeText(resourcePolicy.summary) || 'Machine pressure is high, so training and benchmark work should stay quiet right now.',
    });
  }

  if (Number(promotions.backupCount || 0) > 0 && !backups.length) {
    backups.push(String(promotions.latestBackupId || '').trim());
  }

  if (assistantConfig.safeMode === true) {
    state = 'safe-mode';
    blockAutonomy = true;
    blockTraining = true;
    blockBenchmarks = true;
    blockPromotions = true;
    pushReason(reasons, {
      id: 'manual-safe-mode',
      level: 'critical',
      title: 'Manual safe mode is enabled',
      detail: 'The operator engaged hard safe mode. Autonomy, training, benchmarks, and promotion work stay paused until it is released.',
    });
  }

  const latestBackupId = backups[0] || '';
  const rollbackAvailable = backups.length > 0;
  const pausedSystems = [];
  if (blockAutonomy) {
    pausedSystems.push('autonomy');
    if (schedulerRunning) {
      pausedSystems.push('scheduler');
    }
  }
  if (blockTraining) {
    pausedSystems.push('training');
  }
  if (blockBenchmarks) {
    pausedSystems.push('benchmarks');
  }
  if (blockPromotions) {
    pausedSystems.push('promotions');
  }
  const summary = reasons[0]?.detail || (state === 'safe-mode'
    ? 'Safe mode is active.'
    : state === 'watch'
      ? 'Safety guardrails are watching this workspace.'
      : 'Safety guardrails look healthy.');

  return {
    ok: true,
    state,
    active: state === 'safe-mode',
    watchOnly: state === 'watch',
    restrictToLabs,
    blockAutonomy,
    blockTraining,
    blockBenchmarks,
    blockPromotions,
    schedulerRunning,
    pausedSystems,
    controller: {
      manualSafeMode: assistantConfig.safeMode === true,
      canStabilize: state !== 'safe-mode' || schedulerRunning,
      canResumeManualSafeMode: assistantConfig.safeMode === true,
      pausedSystems,
    },
    rollbackAvailable,
    backupCount: backups.length,
    latestBackupId,
    candidateCount: Number(promotions.candidateCount || 0),
    reasons,
    summary,
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
  };
}

function applySafetyModeToRequest(action, request = {}, safetyStatus = {}) {
  const normalizedAction = normalizeText(action).toLowerCase();
  const nextRequest = {
    ...request,
    safeMode: safetyStatus.active === true || request.safeMode === true,
    safeModeReason: safetyStatus.summary || request.safeModeReason || '',
    safetyStatus,
  };

  if (safetyStatus.active) {
    nextRequest.autoApproveLowRisk = false;
    nextRequest.humanApprovalProtectedOnly = false;
    nextRequest.approvalGated = true;
    nextRequest.synthesizeFollowups = false;
  }

  const blocksLiveSelfTarget = safetyStatus.restrictToLabs
    && !normalizeText(request.labRoot)
    && ['run', 'implement', 'repair', 'autopilot', 'self-improve'].includes(normalizedAction);
  if (blocksLiveSelfTarget) {
    return {
      blocked: true,
      message: 'Safe mode is protecting the live desktop-agent repo. Create or target a self-host lab before running self-work there.',
      request: nextRequest,
    };
  }

  const blocksBackgroundAutonomy = safetyStatus.blockAutonomy
    && !normalizeText(request.labRoot)
    && ['autopilot', 'self-improve'].includes(normalizedAction);
  if (blocksBackgroundAutonomy) {
    return {
      blocked: true,
      message: safetyStatus.summary || 'Safe mode is active. Background autonomy is paused until the workspace is stable again.',
      request: nextRequest,
    };
  }

  if (safetyStatus.blockTraining && ['train', 'learn', 'analyze-log'].includes(normalizedAction)) {
    return {
      blocked: true,
      message: safetyStatus.summary || 'Safety guardrails paused learning and training work.',
      request: nextRequest,
    };
  }

  if (safetyStatus.blockBenchmarks && ['benchmark', 'engine-benchmark'].includes(normalizedAction)) {
    return {
      blocked: true,
      message: safetyStatus.summary || 'Safety guardrails paused background benchmark work.',
      request: nextRequest,
    };
  }

  if (safetyStatus.blockPromotions && ['promote', 'candidate-promote'].includes(normalizedAction)) {
    return {
      blocked: true,
      message: safetyStatus.summary || 'Safety guardrails blocked promotion work until the workspace is stable again.',
      request: nextRequest,
    };
  }

  return {
    blocked: false,
    message: '',
    request: nextRequest,
  };
}

module.exports = {
  buildSafetyStatus,
  applySafetyModeToRequest,
};
