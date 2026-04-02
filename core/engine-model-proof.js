'use strict';

const path = require('path');

const {
  buildTerminalRoutingSummary,
  normalizeTaskLoopMode,
  resolveExecutionModelRole,
  resolveModelProfileSelection,
  resolveTaskLoopAction,
  resolveTaskLoopLane,
} = require('./engine-contract');
const { buildCapabilityDescriptor } = require('./capability-status');
const { readLatestAcceptanceReport } = require('./engine-acceptance');
const { LearningJournalService } = require('./learning-journal');
const { readAssistantConfig } = require('../host/assistant-config');
const { resolvePythonCommand } = require('../shared-runtime/agent-runtime-client');
const { RUNTIME_ROOT } = require('./app-roots');

function clipText(value, maxLength = 220) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}...` : text;
}

function applyRepairRouteOverride(request = {}) {
  return {
    ...request,
    taskMode: 'repair',
    laneId: 'repair-fast',
    laneLabel: 'Repair fast',
    modelRole: resolveExecutionModelRole({
      taskMode: 'repair',
      action: request.action,
      laneId: 'repair-fast',
    }),
  };
}

function buildProofRouteRequest({ command = 'ask', workspaceRoot = '', labRoot = '', prompt = '' } = {}) {
  const chatMode = command === 'plan'
    ? 'plan'
    : command === 'edit'
      ? 'edit'
      : command === 'agent'
        ? 'agent'
        : 'ask';
  const routing = buildTerminalRoutingSummary({ chatMode, message: prompt });
  const lane = resolveTaskLoopLane(routing.suggestedLaneId);
  const routedAction = routing.action || resolveTaskLoopAction(routing.suggestedTaskMode) || 'plan';
  const action = ['edit', 'agent'].includes(chatMode) ? 'orchestrate' : routedAction;
  const assistantConfig = readAssistantConfig(workspaceRoot, { defaultWorkspace: workspaceRoot });
  const modelSelection = resolveModelProfileSelection(assistantConfig, {
    taskMode: routing.suggestedTaskMode,
    action: routedAction,
    laneId: lane.laneId,
  });
  const modelRole = resolveExecutionModelRole({
    taskMode: routing.suggestedTaskMode,
    action: routedAction,
    laneId: lane.laneId,
  });
  return {
    routing,
    request: {
      action,
      workspaceRoot,
      workspace: String(labRoot || workspaceRoot || '').trim() || String(workspaceRoot || '').trim(),
      targetWorkspaceRoot: String(labRoot || workspaceRoot || '').trim() || String(workspaceRoot || '').trim(),
      projectRoot: String(labRoot || workspaceRoot || '').trim() || String(workspaceRoot || '').trim(),
      labRoot: String(labRoot || '').trim(),
      objective: prompt,
      task: prompt,
      laneId: lane.laneId,
      laneLabel: lane.laneLabel,
      taskMode: normalizeTaskLoopMode(routing.suggestedTaskMode, action),
      modelRole,
      modelProfileId: String(modelSelection.active.modelProfileId || '').trim(),
      modelDisplayName: String(modelSelection.active.modelDisplayName || '').trim(),
      baseModel: String(modelSelection.active.baseModel || '').trim(),
      providerSource: String(modelSelection.active.providerSource || modelSelection.active.baseProvider || '').trim(),
    },
  };
}

function buildCliRouteProofRows(workspaceRoot, { labRoot = '' } = {}) {
  const rows = [
    {
      label: 'Ask',
      cliCommand: 'npm run engine:cli -- ask "Why is the current run blocked?"',
      built: buildProofRouteRequest({
        command: 'ask',
        workspaceRoot,
        labRoot,
        prompt: 'Why is the current run blocked?',
      }),
    },
    {
      label: 'Plan',
      cliCommand: 'npm run engine:cli -- plan "Plan the safest next slice for the current roadmap."',
      built: buildProofRouteRequest({
        command: 'plan',
        workspaceRoot,
        labRoot,
        prompt: 'Plan the safest next slice for the current roadmap.',
      }),
    },
    {
      label: 'Edit',
      cliCommand: 'npm run engine:cli -- edit --yes "Implement the smallest safe code change for the current task."',
      built: buildProofRouteRequest({
        command: 'edit',
        workspaceRoot,
        labRoot,
        prompt: 'Implement the smallest safe code change for the current task.',
      }),
    },
    {
      label: 'Repair',
      cliCommand: 'npm run engine:cli -- repair "Repair the latest failed bounded run and rerun the smallest relevant validation."',
      built: buildProofRouteRequest({
        command: 'edit',
        workspaceRoot,
        labRoot,
        prompt: 'Repair the latest failed bounded run and rerun the smallest relevant validation.',
      }),
    },
  ];

  return rows.map((row) => {
    const request = row.label === 'Repair'
      ? applyRepairRouteOverride(row.built.request)
      : row.built.request;
    return {
      label: row.label,
      cliCommand: row.cliCommand,
      laneLabel: request.laneLabel || request.laneId || 'Unknown lane',
      laneId: request.laneId || '',
      taskMode: request.taskMode || '',
      modelRole: request.modelRole || '',
      modelDisplayName: request.modelDisplayName || request.modelProfileId || request.baseModel || 'unresolved',
      modelProfileId: request.modelProfileId || '',
      baseModel: request.baseModel || '',
      providerSource: request.providerSource || '',
    };
  });
}

function buildLearningPolicySummary(assistantConfig = {}) {
  const autonomyMode = String(assistantConfig.autonomyMode || '').trim().toLowerCase();
  const safetyLevel = String(assistantConfig.safetyLevel || '').trim().toLowerCase();
  const selfImproveEnabled = autonomyMode === 'self' || assistantConfig.selfImprovementOnly === true;
  const approvalGate = assistantConfig.humanApprovalProtectedOnly === true
    ? 'protected-only approvals'
    : assistantConfig.humanApprovalProtectedOnly === false
      ? 'broader automatic approvals'
      : 'default protected approvals';
  const sandboxPolicy = assistantConfig.sandboxRequired === true
    ? 'sandbox required'
    : assistantConfig.sandboxRequired === false
      ? 'sandbox optional'
      : 'sandbox policy not overridden';
  return {
    learningDefault: 'User-driven and review-backed learning stays primary. Research, tests, and accepted runs can feed memory, but they do not widen autonomy on their own.',
    selfImproveSummary: selfImproveEnabled
      ? 'Autonomous self-improvement is enabled by config, but it still remains bounded by approvals, safety level, and proof.'
      : 'Autonomous self-improvement stays optional and should remain off until explicitly enabled for a bounded slice.',
    approvalEnvelope: `Autonomy mode: ${autonomyMode || 'default'} | Safety level: ${safetyLevel || 'default'} | Approval gate: ${approvalGate} | ${sandboxPolicy}`,
  };
}

function buildLearningProofSnapshot(workspaceRoot, learningStatus = null) {
  if (learningStatus && typeof learningStatus === 'object') {
    return learningStatus;
  }
  try {
    const service = new LearningJournalService();
    service.setScope({
      workspaceRoot,
      targetRoot: workspaceRoot,
      pollingEnabled: false,
    });
    return service.getStatus();
  } catch (error) {
    return {
      ok: false,
      journalPath: '',
      operatorSupervision: {
        count: 0,
        summary: `Learning journal unavailable: ${String(error?.message || error).trim()}`,
      },
      trainingReadiness: {
        status: 'missing',
        summary: 'Learning readiness is unavailable.',
      },
      gsDev1ExportReadiness: {
        status: 'missing',
        summary: 'GS-Dev-1 export readiness is unavailable.',
      },
    };
  }
}

function buildEngineModelProofSnapshot(options = {}) {
  const workspaceRoot = String(options.workspaceRoot || '').trim();
  const labRoot = String(options.labRoot || '').trim();
  const assistantConfig = options.assistantConfig && typeof options.assistantConfig === 'object'
    ? options.assistantConfig
    : readAssistantConfig(workspaceRoot, { defaultWorkspace: workspaceRoot });
  const acceptanceState = options.acceptanceState && typeof options.acceptanceState === 'object'
    ? options.acceptanceState
    : readLatestAcceptanceReport(workspaceRoot);
  const learningStatus = buildLearningProofSnapshot(workspaceRoot, options.learningStatus);
  const pythonCommand = String(options.pythonCommand || (workspaceRoot ? resolvePythonCommand(workspaceRoot, '', RUNTIME_ROOT) : '')).trim();
  const routeProofRows = buildCliRouteProofRows(workspaceRoot, { labRoot });
  return {
    workspaceRoot,
    labRoot,
    pythonCommand,
    proofPath: path.join(workspaceRoot, 'docs', 'ENGINE_MODEL_PROOF.md'),
    acceptanceState,
    assistantConfig,
    learningStatus,
    learningPolicy: buildLearningPolicySummary(assistantConfig),
    routeProofRows,
  };
}

function buildEngineModelProofViewModel(snapshot = {}) {
  const control = snapshot?.acceptanceState?.controlSummary && typeof snapshot.acceptanceState.controlSummary === 'object'
    ? snapshot.acceptanceState.controlSummary
    : {};
  const operatorSupervision = snapshot?.learningStatus?.operatorSupervision && typeof snapshot.learningStatus.operatorSupervision === 'object'
    ? snapshot.learningStatus.operatorSupervision
    : {};
  const reusablePrompts = Array.isArray(snapshot?.learningStatus?.reusablePrompts)
    ? snapshot.learningStatus.reusablePrompts
    : [];
  const pythonReady = Boolean(String(snapshot.pythonCommand || '').trim());
  const routeProofRows = Array.isArray(snapshot.routeProofRows) ? snapshot.routeProofRows : [];
  const routeSummary = routeProofRows.map((row) => `${row.label} ${row.modelDisplayName}`).join(' • ');
  const promptLead = reusablePrompts[0] && typeof reusablePrompts[0] === 'object' ? reusablePrompts[0] : {};
  const promptSurfaceSummary = Array.isArray(promptLead.surfaces) && promptLead.surfaces.length > 0
    ? ` via ${promptLead.surfaces.join(', ')}`
    : '';
  const learningSummary = reusablePrompts.length > 0
    ? `${reusablePrompts.length} reusable prompt${reusablePrompts.length === 1 ? '' : 's'}${promptSurfaceSummary}`
    : 'No reusable prompts recorded yet';
  const acceptanceStatus = String(control.acceptanceStatus || '').trim().toLowerCase();
  const smokeStatus = String(control.smokeStatus || '').trim().toLowerCase();
  let label = 'BLOCKED';
  let status = 'blocked';
  if (pythonReady && control.safeForNextDay === true) {
    label = 'PROVEN';
    status = 'proven';
  } else if (pythonReady && ['pass', 'warn'].includes(acceptanceStatus)) {
    label = 'PARTIAL';
    status = 'partial';
  } else if (pythonReady) {
    label = 'READY TO RECORD';
    status = 'next';
  }
  const summary = label === 'PROVEN'
    ? 'Python runtime and Ask, Plan, Edit, and Repair route proof are visible, and the current acceptance gate is safe for the next bounded slice.'
    : label === 'PARTIAL'
      ? `Python runtime and routed CLI model proof are visible, but the gate is still ${smokeStatus === 'missing' ? 'waiting on smoke proof' : 'not yet fully clear'}.`
      : pythonReady
        ? 'Python runtime is visible, but a fresh acceptance-backed proof bundle still needs to be recorded.'
        : 'Python runtime proof is missing, so the current engine path is not fully verified yet.';
  const meta = [
    pythonReady ? `python: ${path.basename(String(snapshot.pythonCommand || '').trim())}` : 'python: missing',
    control.acceptanceLabel ? `acceptance: ${control.acceptanceLabel}` : '',
    control.smokeLabel ? `smoke: ${control.smokeLabel}` : '',
    `prompts: ${learningSummary}`,
    Number(operatorSupervision.count || 0) > 0 ? `supervision: ${Number(operatorSupervision.count || 0)} signal(s)` : 'supervision: none yet',
  ].filter(Boolean).join(' • ');
  const capability = buildCapabilityDescriptor({ status, label });
  return {
    ...capability,
    status,
    label,
    summary: clipText(summary, 200),
    meta,
    learningSummary,
    nextAction: clipText(control.nextSafeAction || 'Run npm run engine:cli -- proof-summary after the next bounded pass.', 180),
    routeSummary: clipText(routeSummary, 220),
    acceptanceLabel: String(control.acceptanceLabel || '').trim(),
    smokeLabel: String(control.smokeLabel || '').trim(),
    pythonCommand: String(snapshot.pythonCommand || '').trim(),
    proofPath: String(snapshot.proofPath || '').trim(),
    routeProofRows,
  };
}

module.exports = {
  applyRepairRouteOverride,
  buildCliRouteProofRows,
  buildEngineModelProofSnapshot,
  buildEngineModelProofViewModel,
  buildLearningPolicySummary,
  buildLearningProofSnapshot,
};