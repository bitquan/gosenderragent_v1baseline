'use strict';

const { applySafetyLevelToRequest } = require('../core/autonomy');
const { applySafetyModeToRequest } = require('../core/safety-controller');

function isFinalRunState(state) {
  return state === 'pass' || state === 'fail' || state === 'skipped' || state === 'cancelled';
}

const TASK_LOOP_LANE_MAP = Object.freeze({
  'chat-fast': { laneId: 'chat-fast', laneLabel: 'Chat fast', taskMode: 'chat', action: 'chat' },
  'plan-reasoning': { laneId: 'plan-reasoning', laneLabel: 'Plan reasoning', taskMode: 'planner', action: 'plan' },
  'code-main': { laneId: 'code-main', laneLabel: 'Code main', taskMode: 'coder', action: 'implement' },
  'repair-fast': { laneId: 'repair-fast', laneLabel: 'Repair fast', taskMode: 'repair', action: 'repair' },
  'review-verify': { laneId: 'review-verify', laneLabel: 'Review verify', taskMode: 'validator', action: 'run' },
  'research-docs': { laneId: 'research-docs', laneLabel: 'Research docs', taskMode: 'research', action: 'research' },
  'ops-summary': { laneId: 'ops-summary', laneLabel: 'Ops summary', taskMode: 'summarizer', action: 'summarize' },
});

function normalizeTaskLoopLane(laneId) {
  const normalized = String(laneId || '').trim().toLowerCase();
  return TASK_LOOP_LANE_MAP[normalized] ? normalized : 'code-main';
}

function resolveTaskLoopLane(laneId) {
  return TASK_LOOP_LANE_MAP[normalizeTaskLoopLane(laneId)];
}

function taskModeFromAction(action) {
  const normalized = String(action || '').trim().toLowerCase();
  if (normalized === 'plan') {
    return 'planner';
  }
  if (normalized === 'run') {
    return 'validator';
  }
  if (normalized === 'repair') {
    return 'repair';
  }
  if (normalized === 'summarize') {
    return 'summarizer';
  }
  if (normalized === 'research') {
    return 'research';
  }
  if (normalized === 'chat') {
    return 'chat';
  }
  return 'coder';
}

function normalizeTaskLoopMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized === 'repair') {
    return 'repair';
  }
  if (normalized === 'research') {
    return 'research';
  }
  if (normalized === 'chat') {
    return 'chat';
  }
  if (normalized === 'planner') {
    return 'planner';
  }
  if (normalized === 'validator') {
    return 'validator';
  }
  if (normalized === 'summarizer') {
    return 'summarizer';
  }
  return 'coder';
}

function resolveTaskLoopAction(mode) {
  const normalized = normalizeTaskLoopMode(mode);
  if (normalized === 'repair') {
    return 'repair';
  }
  if (normalized === 'research') {
    return 'research';
  }
  if (normalized === 'chat') {
    return 'chat';
  }
  if (normalized === 'planner') {
    return 'plan';
  }
  if (normalized === 'validator') {
    return 'run';
  }
  if (normalized === 'summarizer') {
    return '';
  }
  return 'implement';
}

function resolveExecutionModelRole({ taskMode = '', action = '', laneId = '' } = {}) {
  const normalizedLaneId = String(laneId || '').trim().toLowerCase();
  if (normalizedLaneId === 'chat-fast' || normalizedLaneId === 'code-main' || normalizedLaneId === 'repair-fast') {
    return 'workspace';
  }
  if (normalizedLaneId === 'plan-reasoning' || normalizedLaneId === 'review-verify' || normalizedLaneId === 'research-docs' || normalizedLaneId === 'ops-summary') {
    return 'engine';
  }
  const normalizedTaskMode = normalizeTaskLoopMode(taskMode || taskModeFromAction(action));
  if (['planner', 'validator', 'summarizer', 'research'].includes(normalizedTaskMode)) {
    return 'engine';
  }
  return 'workspace';
}

function resolveModelProfileSelection(assistantConfig = {}, { taskMode = '', action = '', laneId = '' } = {}) {
  const modelRole = resolveExecutionModelRole({ taskMode, action, laneId });
  const workspace = {
    modelProfileId: String(assistantConfig.workspaceModelProfileId || assistantConfig.modelProfileId || '').trim(),
    modelDisplayName: String(assistantConfig.workspaceModelDisplayName || assistantConfig.modelDisplayName || '').trim(),
    baseModel: String(assistantConfig.workspaceBaseModel || assistantConfig.baseModel || '').trim(),
    baseProvider: String(assistantConfig.workspaceBaseProvider || assistantConfig.baseProvider || '').trim().toLowerCase(),
    providerSource: String(assistantConfig.workspaceProviderSource || assistantConfig.providerSource || '').trim().toLowerCase(),
  };
  const engine = {
    modelProfileId: String(assistantConfig.engineModelProfileId || workspace.modelProfileId || '').trim(),
    modelDisplayName: String(assistantConfig.engineModelDisplayName || workspace.modelDisplayName || '').trim(),
    baseModel: String(assistantConfig.engineBaseModel || workspace.baseModel || '').trim(),
    baseProvider: String(assistantConfig.engineBaseProvider || workspace.baseProvider || '').trim().toLowerCase(),
    providerSource: String(assistantConfig.engineProviderSource || workspace.providerSource || '').trim().toLowerCase(),
  };
  return {
    modelRole,
    workspace,
    engine,
    active: modelRole === 'engine' ? engine : workspace,
  };
}

function normalizeRepairAction(action) {
  const normalized = String(action || '').trim().toLowerCase();
  return ['plan', 'run', 'implement'].includes(normalized) ? normalized : '';
}

function isFailedRepairRun(run) {
  const state = String(run?.state || '').trim().toLowerCase();
  return ['fail', 'cancelled'].includes(state) && String(run?.ticket || '').trim();
}

function pickRepairStrategy(target = {}, payload = {}) {
  const explicitAction = normalizeRepairAction(payload.strategy || payload.preferAction || payload.action);
  if (explicitAction) {
    return {
      action: explicitAction,
      reason: 'requested strategy override',
      source: 'explicit-strategy',
    };
  }

  const runState = String(target?.state || target?.failedRun?.state || '').trim().toLowerCase();
  const failedRunCount = Math.max(
    Number(payload.failedRunCount || 0),
    Number(target.failedRunCount || 0),
  );
  const failedChecks = Number(payload.failedCheckCount || 0)
    || (Array.isArray(target?.failedRun?.checks)
      ? target.failedRun.checks.filter((check) => check && check.ok === false).length
      : 0)
    || (Array.isArray(target?.checks) ? target.checks.length : 0);
  const hasFailingLocation = !!payload.hasFailingLocation
    || !!payload.path
    || (Array.isArray(target?.failedRun?.locations) && target.failedRun.locations.length > 0)
    || !!target.path;
  const hasArtifact = !!payload.hasArtifact
    || !!payload.artifactPath
    || (Array.isArray(target?.failedRun?.artifactPaths) && target.failedRun.artifactPaths.length > 0)
    || !!target.artifactPath;

  if (!target.failedRun && target.source === 'explicit') {
    return {
      action: 'plan',
      reason: 'no failed run context yet',
      source: 'explicit-ticket',
    };
  }

  if (runState === 'cancelled') {
    return {
      action: 'run',
      reason: 'latest repair attempt was cancelled',
      source: 'cancelled-run',
    };
  }

  if (runState === 'skipped') {
    return {
      action: 'plan',
      reason: 'latest attempt was skipped and should be re-scoped first',
      source: 'skipped-run',
    };
  }

  if (failedRunCount >= 2) {
    return {
      action: 'implement',
      reason: 'repeated failures detected for this BAT',
      source: 'repeated-failures',
    };
  }

  if (runState === 'fail' || failedChecks > 0 || hasFailingLocation || hasArtifact) {
    return {
      action: 'implement',
      reason: 'failure signals suggest code changes are needed',
      source: 'failure-signals',
    };
  }

  return {
    action: 'run',
    reason: 'retry the BAT before planning additional changes',
    source: 'default-retry',
  };
}

function applyActionDefaults(action, request, assistantConfig) {
  if (action === 'sprint' && request.sprintAction === 'implement' && request.ship === undefined) {
    request.ship = false;
  }

  if (action === 'autopilot') {
    if (!request.autopilotAction && !request.sprintAction) {
      request.autopilotAction = assistantConfig.autopilotAction || 'implement';
    }
    if (request.count === undefined && request.autopilotCount === undefined) {
      request.autopilotCount = assistantConfig.autopilotCount || 1;
    }
    if (!request.status) {
      request.status = assistantConfig.autopilotStatus || 'TODO';
    }
    if (!request.requireTag && assistantConfig.autopilotRequireTag) {
      request.requireTag = assistantConfig.autopilotRequireTag;
    }
  }

  if (action === 'self-improve') {
    if (!request.autopilotAction && !request.sprintAction) {
      request.autopilotAction = assistantConfig.autopilotAction || 'implement';
    }
    if (request.count === undefined && request.autopilotCount === undefined) {
      request.autopilotCount = assistantConfig.autopilotCount || 1;
    }
    if (!request.status) {
      request.status = assistantConfig.autopilotStatus || 'TODO';
    }
  }

  if (!request.profile) {
    if (action === 'implement') {
      request.profile = 'aiWrite';
    } else if (action === 'plan' || action === 'run') {
      request.profile = 'preview';
    } else if (action === 'sprint' && request.sprintAction === 'implement') {
      request.profile = 'aiWrite';
    } else if (action === 'sprint' && request.sprintAction === 'plan') {
      request.profile = 'preview';
    } else if (action === 'autopilot' || action === 'self-improve') {
      const selectedAction = String(
        request.autopilotAction || request.sprintAction || assistantConfig.autopilotAction || 'implement',
      ).toLowerCase();
      request.profile = assistantConfig.autopilotProfile || (selectedAction === 'implement' ? 'aiWrite' : 'preview');
    }
  }

  return request;
}

function buildHostBoundary(action, request, autonomySettings = {}) {
  return {
    hostKind: 'desktop',
    action,
    safetyLevel: autonomySettings.safetyLevel || request.safetyLevel || '',
    autonomyMode: autonomySettings.autonomyMode || request.autonomyMode || '',
    selfImprovementOnly: !!(autonomySettings.selfImprovementOnly ?? request.selfImprovementOnly),
    autoApproveLowRisk: !!(autonomySettings.autoApproveLowRisk ?? request.autoApproveLowRisk),
    approvalProtectedOnly: !!(autonomySettings.humanApprovalProtectedOnly ?? request.humanApprovalProtectedOnly),
    baselineSelfHealPriority: !!(autonomySettings.baselineSelfHealPriority ?? request.baselineSelfHealPriority),
    sandboxRequired: !!(autonomySettings.sandboxRequired ?? request.sandboxRequired),
    modelProfileId: String(request.modelProfileId || '').trim(),
    taskModeRoutes: request.taskModeRoutes && typeof request.taskModeRoutes === 'object' ? request.taskModeRoutes : {},
  };
}

class DesktopAgentRuntimeService {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.getWorkspaceRoot = options.getWorkspaceRoot;
    this.setWorkspaceRoot = options.setWorkspaceRoot;
    this.getSelectedLabRoot = options.getSelectedLabRoot || (() => '');
    this.buildEditorContext = options.buildEditorContext;
    this.readAssistantConfig = options.readAssistantConfig;
    this.getAutonomySettings = options.getAutonomySettings;
    this.applyAutonomyToRequest = options.applyAutonomyToRequest;
    this.getSafetyStatus = options.getSafetyStatus || (() => ({ ok: true, state: 'ready', active: false, restrictToLabs: false, blockAutonomy: false, summary: '' }));
  }

  resolveCanonicalWorkspaceRoot(payload = {}) {
    return payload.workspaceRoot
      ? this.setWorkspaceRoot(payload.workspaceRoot)
      : this.getWorkspaceRoot();
  }

  resolveTargetRoot(payload = {}, workspaceRoot = this.getWorkspaceRoot()) {
    const explicitTarget = String(
      payload.targetWorkspaceRoot
      || payload.targetRoot
      || payload.projectRoot
      || payload.labRoot
      || payload.workspace
      || this.getSelectedLabRoot()
      || workspaceRoot,
    ).trim();
    return explicitTarget || workspaceRoot;
  }

  buildRunRequest(action, payload = {}) {
    const workspaceRoot = this.resolveCanonicalWorkspaceRoot(payload);
    const targetRoot = this.resolveTargetRoot(payload, workspaceRoot);
    const labRoot = String(payload.labRoot || '').trim() || (targetRoot !== workspaceRoot ? targetRoot : '');
    const assistantConfig = this.readAssistantConfig(workspaceRoot);
    const autonomySettings = this.getAutonomySettings(workspaceRoot);
    const request = {
      ...payload,
      action,
      workspaceRoot,
      workspace: targetRoot,
      targetWorkspaceRoot: targetRoot,
      projectRoot: targetRoot,
      labRoot,
      editor_context: payload.editor_context || this.buildEditorContext(targetRoot),
    };
    applyActionDefaults(action, request, assistantConfig);
    const resolved = this.applyAutonomyToRequest({
      ...request,
      ...autonomySettings,
      selfImprovementOnly: assistantConfig.selfImprovementOnly ?? autonomySettings.selfImprovementOnly ?? request.selfImprovementOnly,
    }, {
      action,
      sprintAction: request.sprintAction,
    });
    const safetyStatus = this.getSafetyStatus({
      workspaceRoot,
      targetWorkspaceRoot: targetRoot,
      labRoot,
      action,
      assistantConfig,
      request: resolved,
    });
    const safetyApplied = applySafetyModeToRequest(action, resolved, safetyStatus);
    const safetyLevelApplied = applySafetyLevelToRequest(action, safetyApplied.request, autonomySettings);
    const nextResolved = safetyLevelApplied.request;
    nextResolved.blockedBySafety = safetyApplied.blocked === true || safetyLevelApplied.blocked === true;
    if (safetyApplied.message || safetyLevelApplied.message) {
      nextResolved.safeModeReason = safetyApplied.message || safetyLevelApplied.message;
    }
    nextResolved.hostBoundary = {
      ...buildHostBoundary(action, nextResolved, autonomySettings),
      hostKind: labRoot ? 'lab' : 'desktop',
      safetyStatus,
      ...(nextResolved.hostBoundary || {}),
    };
    nextResolved.approvalGated = nextResolved.approvalGated !== undefined ? !!nextResolved.approvalGated : true;
    nextResolved.approvalProtectedOnly = !!(nextResolved.humanApprovalProtectedOnly ?? autonomySettings.humanApprovalProtectedOnly);
    nextResolved.safetyLevel = autonomySettings.safetyLevel || request.safetyLevel || '';
    const requestedTaskMode = normalizeTaskLoopMode(
      nextResolved.taskMode
      || nextResolved.task_mode
      || nextResolved.metadata?.taskMode
      || nextResolved.metadata?.task_mode
      || taskModeFromAction(action),
    );
    const modelSelection = resolveModelProfileSelection(assistantConfig, {
      taskMode: requestedTaskMode,
      action,
      laneId: nextResolved.laneId || nextResolved.metadata?.lane_id || '',
    });
    nextResolved.modelProfileId = String(modelSelection.active.modelProfileId || '').trim();
    nextResolved.modelRole = modelSelection.modelRole;
    nextResolved.modelDisplayName = modelSelection.active.modelDisplayName;
    nextResolved.baseModel = nextResolved.baseModel || modelSelection.active.baseModel;
    nextResolved.baseProvider = nextResolved.baseProvider || modelSelection.active.baseProvider;
    nextResolved.providerSource = nextResolved.providerSource || modelSelection.active.providerSource;
    nextResolved.workspaceModelProfileId = modelSelection.workspace.modelProfileId;
    nextResolved.engineModelProfileId = modelSelection.engine.modelProfileId;
    nextResolved.taskModeRoutes = assistantConfig.taskModeRoutes && typeof assistantConfig.taskModeRoutes === 'object'
      ? assistantConfig.taskModeRoutes
      : {};
    nextResolved.metadata = {
      ...(nextResolved.metadata && typeof nextResolved.metadata === 'object' ? nextResolved.metadata : {}),
      modelProfileId: nextResolved.modelProfileId,
      modelRole: nextResolved.modelRole,
      modelDisplayName: nextResolved.modelDisplayName,
      baseModel: nextResolved.baseModel,
      baseProvider: nextResolved.baseProvider,
      providerSource: nextResolved.providerSource,
      workspaceModelProfileId: modelSelection.workspace.modelProfileId,
      workspaceModelDisplayName: modelSelection.workspace.modelDisplayName,
      engineModelProfileId: modelSelection.engine.modelProfileId,
      engineModelDisplayName: modelSelection.engine.modelDisplayName,
      taskModeRoutes: nextResolved.taskModeRoutes,
      gsDev1: {
        modelProfileId: nextResolved.modelProfileId,
        taskModeRoutes: nextResolved.taskModeRoutes,
      },
      dualModel: {
        modelRole: nextResolved.modelRole,
        workspaceModelProfileId: modelSelection.workspace.modelProfileId,
        workspaceModelDisplayName: modelSelection.workspace.modelDisplayName,
        engineModelProfileId: modelSelection.engine.modelProfileId,
        engineModelDisplayName: modelSelection.engine.modelDisplayName,
      },
    };
    return nextResolved;
  }

  buildTaskLoopRequest(payload = {}) {
    const lane = resolveTaskLoopLane(payload.laneId || payload.activeLaneId || payload.lane);
    const taskMode = normalizeTaskLoopMode(
      payload.taskMode
      || payload.task_mode
      || lane.taskMode
      || payload.mode,
    );
    const action = resolveTaskLoopAction(taskMode);
    const task = String(
      payload.task
      || payload.objective
      || payload.prompt
      || payload.label
      || payload.ticket
      || '',
    ).trim();
    const requestAction = ['plan', 'run', 'implement'].includes(action) ? action : 'run';
    const request = this.buildRunRequest(requestAction, {
      ...payload,
      objective: task || payload.objective || '',
      label: payload.label || (task ? `${lane.laneLabel}: ${task}` : `${lane.laneLabel} task`),
      taskMode,
      metadata: {
        ...(payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}),
        task,
        lane_id: lane.laneId,
        lane_label: lane.laneLabel,
        task_mode: taskMode,
        taskMode,
        operator_loop: true,
      },
    });
    request.task = task;
    request.taskMode = taskMode;
    request.laneId = lane.laneId;
    request.laneLabel = lane.laneLabel;
    request.metadata = {
      ...(request.metadata && typeof request.metadata === 'object' ? request.metadata : {}),
      task,
      lane_id: lane.laneId,
      lane_label: lane.laneLabel,
      task_mode: taskMode,
      taskMode,
      operator_loop: true,
    };
    request.modelRole = resolveExecutionModelRole({
      taskMode,
      action,
      laneId: lane.laneId,
    });
    return {
      action,
      laneId: lane.laneId,
      laneLabel: lane.laneLabel,
      task,
      taskMode,
      request,
    };
  }

  startTaskLoop(payload = {}) {
    const planned = this.buildTaskLoopRequest(payload);
    if (!planned.action) {
      return {
        ok: false,
        blocked: true,
        blockedBy: 'task-mode',
        message: 'Summarizer mode uses the latest completed run and does not start a new engine run.',
        action: planned.action,
        laneId: planned.laneId,
        laneLabel: planned.laneLabel,
        task: planned.task,
        taskMode: planned.taskMode,
        request: planned.request,
      };
    }
    const run = this.handleRun(planned.action, planned.request);
    return {
      ...run,
      action: planned.action,
      laneId: planned.laneId,
      laneLabel: planned.laneLabel,
      task: planned.task,
      taskMode: planned.taskMode,
      request: planned.request,
    };
  }

  handleRun(action, payload = {}) {
    const request = this.buildRunRequest(action, payload);
    if (request.blockedBySafety) {
      return {
        ok: false,
        blocked: true,
        blockedBy: 'safe-mode',
        message: request.safeModeReason || 'Safe mode blocked this run.',
        safetyStatus: request.safetyStatus || request.hostBoundary?.safetyStatus || {},
      };
    }
    this.runtime.setWorkspaceRoot(request.workspace);
    return this.runtime.run(request);
  }

  startScheduler(payload = {}) {
    const workspaceRoot = this.resolveCanonicalWorkspaceRoot(payload);
    const targetRoot = this.resolveTargetRoot(payload, workspaceRoot);
    const labRoot = String(payload.labRoot || '').trim() || (targetRoot !== workspaceRoot ? targetRoot : '');
    this.runtime.setWorkspaceRoot(targetRoot);
    return this.runtime.startScheduler({
      workspaceRoot,
      workspace: targetRoot,
      targetWorkspaceRoot: targetRoot,
      projectRoot: targetRoot,
      labRoot,
    });
  }

  stopScheduler() {
    return this.runtime.stopScheduler();
  }

  schedulerStatus() {
    return this.runtime.schedulerStatus();
  }

  resolveRepairTarget(payload = {}) {
    const workspaceRoot = this.resolveCanonicalWorkspaceRoot(payload);
    const targetRoot = this.resolveTargetRoot(payload, workspaceRoot);
    const labRoot = String(payload.labRoot || '').trim() || (targetRoot !== workspaceRoot ? targetRoot : '');
    const explicitTicket = String(payload.ticket || '').trim();
    const status = typeof this.runtime.getStatus === 'function' ? this.runtime.getStatus() : null;
    const latest = Array.isArray(status?.latest) ? status.latest : [];
    const failedRuns = latest.filter((run) => isFailedRepairRun(run));
    const failedRun = explicitTicket
      ? failedRuns.find((run) => String(run?.ticket || '').trim() === explicitTicket) || null
      : failedRuns[0] || null;
    const failedRunCount = explicitTicket
      ? failedRuns.filter((run) => String(run?.ticket || '').trim() === explicitTicket).length
      : (failedRun ? failedRuns.filter((run) => String(run?.ticket || '').trim() === String(failedRun.ticket || '').trim()).length : 0);

    if (explicitTicket) {
      return {
        ok: true,
        workspaceRoot,
        targetWorkspaceRoot: targetRoot,
        labRoot,
        ticket: explicitTicket,
        source: failedRun ? 'explicit-failed-run' : 'explicit',
        failedRun,
        failedRunCount,
        state: failedRun?.state || '',
        runId: failedRun?.runId || '',
      };
    }

    if (!failedRun) {
      return {
        ok: false,
        workspaceRoot,
        targetWorkspaceRoot: targetRoot,
        labRoot,
        message: 'No failed BAT run is available to repair.',
      };
    }

    return {
      ok: true,
      workspaceRoot,
      targetWorkspaceRoot: targetRoot,
      labRoot,
      ticket: String(failedRun.ticket || '').trim(),
      source: 'latest-failed-run',
      runId: failedRun.runId || '',
      state: failedRun.state || '',
      failedRun,
      failedRunCount,
    };
  }

  runRepairLoop(payload = {}) {
    const target = this.resolveRepairTarget(payload);
    if (!target.ok) {
      return target;
    }

    const strategy = pickRepairStrategy(target, payload);
    const action = strategy.action;
    const runPayload = {
      workspaceRoot: target.workspaceRoot,
      workspace: target.targetWorkspaceRoot,
      targetWorkspaceRoot: target.targetWorkspaceRoot,
      labRoot: target.labRoot,
      ticket: target.ticket,
      template: payload.template || 'auto',
    };

    if (action === 'implement') {
      runPayload.profile = payload.profile || 'repair';
      runPayload.fixLoop = payload.fixLoop !== undefined ? !!payload.fixLoop : true;
    } else {
      runPayload.profile = payload.profile || 'preview';
      if (payload.fixLoop !== undefined) {
        runPayload.fixLoop = !!payload.fixLoop;
      }
    }

    const run = this.handleRun(action, runPayload);

    return {
      ok: true,
      ticket: target.ticket,
      source: target.source,
      action,
      strategySource: strategy.source,
      strategyReason: strategy.reason,
      runId: run?.runId || '',
      state: run?.state || 'running',
      message: `${action === 'implement' ? 'Repair implement' : action === 'plan' ? 'Repair plan' : 'Repair run'} started for BAT<${target.ticket}> — ${strategy.reason}.${run?.runId ? ` (${run.runId})` : ''}`,
    };
  }

  waitForRunCompletion(runId) {
    return new Promise((resolve) => {
      const listener = (event) => {
        if (!event || event.runId !== runId) {
          return;
        }
        if (!isFinalRunState(event.state)) {
          return;
        }
        this.runtime.off('run-event', listener);
        resolve(event);
      };
      this.runtime.on('run-event', listener);
    });
  }

  async runLearnPipeline(payload = {}) {
    const analyzeRun = this.handleRun('analyze-log', payload);
    const analyzeFinal = analyzeRun?.runId ? await this.waitForRunCompletion(analyzeRun.runId) : null;
    if (analyzeFinal && analyzeFinal.state !== 'pass') {
      return {
        ok: false,
        message: 'Learn pipeline stopped: analyze-log failed.',
        analyzeRun,
        analyzeFinal,
        trainRun: null,
        trainFinal: null,
      };
    }

    const trainRun = this.handleRun('train', payload);
    const trainFinal = trainRun?.runId ? await this.waitForRunCompletion(trainRun.runId) : null;
    const ok = !!trainFinal && trainFinal.state === 'pass';
    const analyzeArtifact = analyzeFinal?.artifact || {};
    const trainArtifact = trainFinal?.artifact || {};
    const analyzedEntries = Number(analyzeArtifact.entryCount || 0);
    const analyzedTickets = Number(analyzeArtifact.ticketCount || 0);
    const trainingExamples = Number(trainArtifact.exampleCount || 0);
    const trainingEntries = Number(trainArtifact.entryCount || 0);
    const parts = [];
    if (analyzedEntries > 0 || analyzedTickets > 0) {
      parts.push(`analyzed ${analyzedEntries} log entries across ${analyzedTickets} BATs`);
    }
    if (trainingEntries > 0 || trainingExamples > 0) {
      parts.push(`generated ${trainingExamples} training examples from ${trainingEntries} entries`);
    }

    return {
      ok,
      message: ok
        ? (parts.join('; ') || 'Learn pipeline completed.')
        : 'Learn pipeline finished with training errors.',
      analyzeRun,
      analyzeFinal,
      trainRun,
      trainFinal,
      summary: parts.join('; '),
    };
  }
}

module.exports = {
  DesktopAgentRuntimeService,
  TASK_LOOP_LANE_MAP,
  isFinalRunState,
  normalizeTaskLoopLane,
  resolveTaskLoopLane,
  normalizeTaskLoopMode,
  resolveTaskLoopAction,
  resolveExecutionModelRole,
  applyActionDefaults,
  normalizeRepairAction,
  pickRepairStrategy,
};
