'use strict';

const fs = require('fs');
const childProcess = require('child_process');
const path = require('path');

const { RUNTIME_ROOT } = require('../core/app-roots');
const { getGitDiff, getGitStatus, getGitSummary, stagePaths, unstagePaths, stageAll, unstageAll, discardPaths, commitStaged, pullTrackedBranch, pushTrackedBranch, publishBranch, listBranches, createBranch, switchBranch } = require('../core/git-service');
const {
  buildHumanPromptInstruction,
  buildTerminalRoutingSummary,
  getChatModeConfig,
  normalizeTaskLoopMode,
  resolveExecutionModelRole,
  resolveModelProfileSelection,
  resolveTaskLoopAction,
  resolveTaskLoopLane,
} = require('../core/engine-contract');
const { buildAiStatus } = require('../core/ai-center');
const { listBenchmarkRuns } = require('../core/benchmarks');
const { readLatestAcceptanceReport } = require('../core/engine-acceptance');
const {
  buildDirectAskReply: buildSharedDirectAskReply,
  buildDirectPlanReply: buildSharedDirectPlanReply,
  buildGroundedChatPrompt: buildSharedGroundedChatPrompt,
  buildLiveStateSummary: buildSharedLiveStateSummary,
} = require('../core/grounded-chat');
const { buildModelFoundryStatus } = require('../core/model-foundry');
const { runPreflight } = require('../core/preflight');
const { buildSystemCheck, renderSystemCheck } = require('../core/system-check');
const { buildSystemCheckContext } = require('../core/system-check-context');
const {
  buildCheckpointMergeCommand,
  collectTrainingTelemetry,
  PROMOTION_POLICY_OPTIONS,
  readTrainingTuningSettings,
  RECOMMENDED_LOCAL_MODELS,
  WORKER_FAMILY_OPTIONS,
} = require('../core/training-tuning');
const {
  fetchTrustedDocDigests,
  renderTrustedDocPromptBlock,
} = require('../core/trusted-docs');
const { buildEngineModelProofSnapshot: buildSharedEngineModelProofSnapshot } = require('../core/engine-model-proof');
const { LearningJournalService } = require('../core/learning-journal');
const { readAssistantConfig } = require('../host/assistant-config');
const { AgentRuntimeClient, resolvePythonCommand } = require('../shared-runtime/agent-runtime-client');
const { SharedAgentRuntime, buildOperatorExecutionSnapshot } = require('../shared-runtime/runtime');
const { FOUNDRY_PROOF_CAPABILITIES, runFoundryCandidateProofs } = require('../core/model-foundry');

function clipText(value, maxLength = 220) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}...` : text;
}

function parseCliArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const parsed = {
    command: String(args.shift() || 'status').trim().toLowerCase() || 'status',
    workspaceRoot: path.resolve(process.cwd()),
    labRoot: '',
    validationCommands: [],
    yes: false,
    message: '',
    area: '',
    cached: false,
    json: false,
    basePath: '',
    secondaryPath: '',
    outputPath: '',
    mergeName: '',
    candidateId: '',
    title: '',
    alpha: null,
    method: '',
    capabilityIds: [],
    dryRun: false,
    docSources: [],
    summaryPath: '',
    all: false,
    trailing: [],
  };

  while (args.length > 0) {
    const token = String(args.shift() || '').trim();
    if (!token) {
      continue;
    }
    if (token === '--workspace' || token === '-w') {
      parsed.workspaceRoot = path.resolve(String(args.shift() || '').trim() || parsed.workspaceRoot);
      continue;
    }
    if (token === '--lab') {
      parsed.labRoot = path.resolve(String(args.shift() || '').trim());
      continue;
    }
    if (token === '--validation-command' || token === '--validation') {
      const validationCommand = String(args.shift() || '').trim();
      if (validationCommand) {
        parsed.validationCommands.push(validationCommand);
      }
      continue;
    }
    if (token === '--yes' || token === '-y') {
      parsed.yes = true;
      continue;
    }
    if (token === '--message' || token === '-m') {
      parsed.message = String(args.shift() || '').trim();
      continue;
    }
    if (token === '--area') {
      parsed.area = String(args.shift() || '').trim().toLowerCase();
      continue;
    }
    if (token === '--cached') {
      parsed.cached = true;
      continue;
    }
    if (token === '--json') {
      parsed.json = true;
      continue;
    }
    if (token === '--base-path') {
      parsed.basePath = path.resolve(String(args.shift() || '').trim());
      continue;
    }
    if (token === '--secondary-path') {
      parsed.secondaryPath = path.resolve(String(args.shift() || '').trim());
      continue;
    }
    if (token === '--output-path' || token === '--output-dir') {
      parsed.outputPath = path.resolve(String(args.shift() || '').trim());
      continue;
    }
    if (token === '--name' || token === '--merge-name') {
      parsed.mergeName = String(args.shift() || '').trim();
      continue;
    }
    if (token === '--candidate-id' || token === '--candidate') {
      parsed.candidateId = String(args.shift() || '').trim();
      continue;
    }
    if (token === '--title') {
      parsed.title = String(args.shift() || '').trim();
      continue;
    }
    if (token === '--alpha') {
      const alpha = Number(args.shift() || '');
      parsed.alpha = Number.isFinite(alpha) ? alpha : null;
      continue;
    }
    if (token === '--method') {
      parsed.method = String(args.shift() || '').trim().toLowerCase();
      continue;
    }
    if (token === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (token === '--capability') {
      const capabilityId = String(args.shift() || '').trim().toLowerCase();
      if (capabilityId) {
        parsed.capabilityIds.push(capabilityId);
      }
      continue;
    }
    if (token === '--all') {
      parsed.all = true;
      continue;
    }
    if (token === '--doc-source' || token === '--doc-url') {
      const docSource = String(args.shift() || '').trim();
      if (docSource) {
        parsed.docSources.push(docSource);
      }
      continue;
    }
    if (token === '--summary-path') {
      parsed.summaryPath = path.resolve(String(args.shift() || '').trim());
      continue;
    }
    parsed.trailing.push(token);
  }

  return parsed;
}

function buildSyntheticTicketId(seed = '') {
  const text = String(seed || '').trim() || 'terminal-engine-request';
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  const digits = String(Math.abs(hash % 1000000000)).padStart(9, '0');
  return `9${digits}`;
}

function normalizeCliChatCommand(command = '') {
  const value = String(command || '').trim().toLowerCase();
  if (value === 'ask-docs') {
    return 'ask';
  }
  if (value === 'plan-docs') {
    return 'plan';
  }
  return value;
}

function usesTrustedDocs(command = '', docSources = []) {
  return ['ask-docs', 'plan-docs'].includes(String(command || '').trim().toLowerCase())
    || (Array.isArray(docSources) && docSources.length > 0);
}

function buildTerminalRequest({ command, workspaceRoot, labRoot, prompt = '', validationCommands = [] } = {}) {
  const normalizedCommand = normalizeCliChatCommand(command);
  const chatMode = normalizedCommand === 'plan'
    ? 'plan'
    : normalizedCommand === 'edit'
      ? 'edit'
      : normalizedCommand === 'agent'
        ? 'agent'
        : 'ask';
  const normalizedValidationCommands = Array.isArray(validationCommands)
    ? validationCommands.map((commandText) => String(commandText || '').trim()).filter(Boolean)
    : [];
  const targetWorkspaceRoot = String(labRoot || workspaceRoot || '').trim() || String(workspaceRoot || '').trim();
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
  const syntheticTicket = ['plan', 'run', 'implement'].includes(routedAction)
    ? buildSyntheticTicketId(`${command}\n${targetWorkspaceRoot}\n${prompt}`)
    : '';
  return {
    command,
    chatMode,
    routing,
    request: {
      action,
      ticket: syntheticTicket,
      desc: prompt,
      workspaceRoot,
      workspace: targetWorkspaceRoot,
      targetWorkspaceRoot,
      projectRoot: targetWorkspaceRoot,
      labRoot: String(labRoot || '').trim(),
      objective: prompt,
      task: prompt,
      label: `${routing.modeLabel}: ${prompt || 'Untitled objective'}`,
      laneId: lane.laneId,
      laneLabel: lane.laneLabel,
      taskMode: normalizeTaskLoopMode(routing.suggestedTaskMode, action),
      modelRole,
      modelProfileId: String(modelSelection.active.modelProfileId || '').trim(),
      modelDisplayName: String(modelSelection.active.modelDisplayName || '').trim(),
      baseModel: String(modelSelection.active.baseModel || '').trim(),
      providerSource: String(modelSelection.active.providerSource || modelSelection.active.baseProvider || '').trim(),
      validationCommands: normalizedValidationCommands,
      metadata: {
        surface: 'terminal-cli',
        chatMode,
        lane_id: lane.laneId,
        lane_label: lane.laneLabel,
        task_mode: normalizeTaskLoopMode(routing.suggestedTaskMode, action),
        suggestedTaskMode: routing.suggestedTaskMode,
        suggestedLaneId: routing.suggestedLaneId,
        modeAllowsExecution: routing.modeAllowsExecution,
        modeRequiresEditConfirmation: routing.modeRequiresEditConfirmation,
        syntheticTicket,
        wrappedProfileRole: modelSelection.wrappedProfileRole,
      },
    },
  };
}

function buildDocsAwareGroundedPrompt({ built = {}, report = {}, userPrompt = '', docDigests = [] } = {}) {
  const basePrompt = buildGroundedChatPrompt({
    chatMode: built.chatMode || 'ask',
    userPrompt,
    report,
    built,
  });
  const docsBlock = renderTrustedDocPromptBlock(docDigests);
  if (!docsBlock) {
    return basePrompt;
  }
  return [
    basePrompt,
    '',
    docsBlock,
    '',
    'In this prompt, docs means trusted technical documentation such as VS Code, Node, Python, MDN, or Microsoft references. It does not mean building a document CRUD subsystem.',
    'Do not invent new folders, commands, or subsystems unless the current repo state or trusted docs above explicitly require them.',
    'Name the real repo files or commands you would touch. If you cannot name concrete repo files from the live state, say that the evidence is missing instead of giving generic project-management steps.',
    'Do not add review, stakeholder, or submission workflow advice unless the live repo state explicitly calls for it.',
    'Use the trusted online docs above only as supporting evidence. Prefer the repo state and repo files when they conflict.',
  ].filter(Boolean).join('\n');
}

function buildProgressSummaryMarkdown({
  title = '',
  objective = '',
  workspaceRoot = '',
  report = {},
  docDigests = [],
  updatedAt = new Date().toISOString(),
} = {}) {
  const roadmap = report?.areas?.roadmap && typeof report.areas.roadmap === 'object' ? report.areas.roadmap : {};
  const acceptance = report?.areas?.acceptance && typeof report.areas.acceptance === 'object' ? report.areas.acceptance : {};
  const trust = report?.areas?.trust && typeof report.areas.trust === 'object' ? report.areas.trust : {};
  const runs = report?.areas?.runs && typeof report.areas.runs === 'object' ? report.areas.runs : {};
  const latestRun = runs.latestRun && typeof runs.latestRun === 'object' ? runs.latestRun : {};
  const lines = [
    '# Locked Plan Summary',
    '',
    `Updated: ${updatedAt}`,
    `Workspace: ${workspaceRoot}`,
    '',
    `## ${title || 'Untitled locked plan'}`,
    '',
    '### Goal',
    objective || 'No objective recorded yet.',
    '',
    '### Repo Snapshot',
    `- Roadmap: ${String(roadmap.status || 'unknown').toUpperCase()} | ${clipText(roadmap.summary || 'No roadmap summary recorded yet.', 180)}`,
    `- Acceptance: ${String(acceptance.status || 'unknown').toUpperCase()} | ${clipText(acceptance.summary || 'No acceptance summary recorded yet.', 180)}`,
    `- Trust: ${String(trust.status || 'unknown').toUpperCase()} | ${clipText(trust.summary || 'No trust summary recorded yet.', 180)}`,
    latestRun.task ? `- Latest run: ${clipText(latestRun.task, 180)}` : '- Latest run: none recorded',
    roadmap.recommendedNextSafeAction ? `- Next safe action: ${clipText(roadmap.recommendedNextSafeAction, 180)}` : '- Next safe action: not recorded',
    '',
    '### Locked Trackers',
    '- Primary board: docs/BAT_FEATURE_BOARD.md',
    '- Engine blueprint: docs/ENGINE_BLUEPRINT_CHECKLIST.md',
    '- Model blueprint: docs/LOCAL_MODEL_BLUEPRINT_CHECKLIST.md',
    '- Engine model proof: docs/ENGINE_MODEL_PROOF.md',
    '',
    '### Guardrails',
    '- Keep using the existing desktop shell, VS Code companion, and tool catalog until native engine replacements are actually proven.',
    '- Keep learning user-driven and review-backed by default; autonomous self-improvement stays optional and gated.',
    '- Refresh docs/ENGINE_MODEL_PROOF.md after each bounded engine or model pass so Python runtime proof and routed model proof stay visible.',
  ];
  if (Array.isArray(docDigests) && docDigests.length > 0) {
    lines.push('', '### Trusted Online Docs');
    docDigests.slice(0, 5).forEach((digest) => {
      lines.push(`- ${digest.title || digest.url}`);
      lines.push(`  - URL: ${digest.url}`);
      if (digest.summary) {
        lines.push(`  - Summary: ${clipText(digest.summary, 180)}`);
      }
      if (Array.isArray(digest.goodPatterns) && digest.goodPatterns.length > 0) {
        lines.push(`  - Good patterns: ${digest.goodPatterns.slice(0, 2).join(' | ')}`);
      }
      if (Array.isArray(digest.avoidPatterns) && digest.avoidPatterns.length > 0) {
        lines.push(`  - Avoid patterns: ${digest.avoidPatterns.slice(0, 2).join(' | ')}`);
      }
    });
  }
  lines.push('', '### Notes', '- Update this file whenever a multi-phase engine plan starts, changes phase, or is replaced by a newer locked plan.');
  return lines.join('\n');
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

function buildCliRouteProofRows(workspaceRoot, { labRoot = '' } = {}) {
  const rows = [
    {
      label: 'Ask',
      cliCommand: 'npm run engine:cli -- ask "Why is the current run blocked?"',
      built: buildTerminalRequest({
        command: 'ask',
        workspaceRoot,
        labRoot,
        prompt: 'Why is the current run blocked?',
      }),
    },
    {
      label: 'Plan',
      cliCommand: 'npm run engine:cli -- plan "Plan the safest next slice for the current roadmap."',
      built: buildTerminalRequest({
        command: 'plan',
        workspaceRoot,
        labRoot,
        prompt: 'Plan the safest next slice for the current roadmap.',
      }),
    },
    {
      label: 'Edit',
      cliCommand: 'npm run engine:cli -- edit --yes "Prepare the smallest safe fix for the current issue."',
      built: buildTerminalRequest({
        command: 'edit',
        workspaceRoot,
        labRoot,
        prompt: 'Prepare the smallest safe fix for the current issue.',
      }),
    },
    {
      label: 'Repair',
      cliCommand: 'npm run engine:cli -- repair "Repair the latest failed bounded run and rerun the smallest relevant validation."',
      built: {
        ...buildTerminalRequest({
          command: 'edit',
          workspaceRoot,
          labRoot,
          prompt: 'Repair the latest failed bounded run and rerun the smallest relevant validation.',
        }),
      },
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

function buildLearningProofSnapshot(workspaceRoot) {
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

function buildEngineModelProofMarkdown({
  title = '',
  objective = '',
  workspaceRoot = '',
  pythonCommand = '',
  acceptanceState = {},
  assistantConfig = {},
  learningStatus = {},
  routeProofRows = [],
  updatedAt = new Date().toISOString(),
} = {}) {
  const control = acceptanceState?.controlSummary && typeof acceptanceState.controlSummary === 'object'
    ? acceptanceState.controlSummary
    : {};
  const operatorSupervision = learningStatus?.operatorSupervision && typeof learningStatus.operatorSupervision === 'object'
    ? learningStatus.operatorSupervision
    : {};
  const trainingReadiness = learningStatus?.trainingReadiness && typeof learningStatus.trainingReadiness === 'object'
    ? learningStatus.trainingReadiness
    : {};
  const exportReadiness = learningStatus?.gsDev1ExportReadiness && typeof learningStatus.gsDev1ExportReadiness === 'object'
    ? learningStatus.gsDev1ExportReadiness
    : {};
  const reusablePrompts = Array.isArray(learningStatus?.reusablePrompts)
    ? learningStatus.reusablePrompts
    : [];
  const learningPolicy = buildLearningPolicySummary(assistantConfig);
  const lines = [
    '# Engine Model Proof',
    '',
    `Updated: ${updatedAt}`,
    `Workspace: ${workspaceRoot}`,
    `Pass: ${title || 'Engine model proof'}`,
    '',
    '## Goal',
    objective || 'Show the current Python-backed engine path, routed CLI models, learning envelope, and proof gate.',
    '',
    '## Engine Path',
    `- Python runtime: ${pythonCommand || 'missing'}`,
    `- Acceptance artifact: ${acceptanceState.outputPath || 'not recorded yet'}`,
    `- Acceptance gate: ${control.acceptanceLabel || 'NOT RUN'} | ${clipText(control.acceptanceSummary || 'No acceptance summary recorded yet.', 180)}`,
    `- Smoke gate: ${control.smokeLabel || 'NOT RUN'} | ${clipText(control.smokeSummary || 'No smoke summary recorded yet.', 180)}`,
    `- Next-day gate: ${control.nextDayLabel || 'BLOCKED'} | ${clipText(control.nextDaySummary || 'Next-day readiness is not recorded yet.', 180)}`,
    `- Model parity: ${clipText(control.modelParity?.summary || 'No model parity proof is recorded yet.', 180)}`,
    `- Next safe action: ${clipText(control.nextSafeAction || 'Run acceptance before widening the engine surface.', 180)}`,
    '',
    '## Routed CLI Model Proof',
  ];

  if (Array.isArray(routeProofRows) && routeProofRows.length > 0) {
    routeProofRows.forEach((row) => {
      lines.push(`- ${row.label}: ${row.laneLabel} | ${row.taskMode} | ${row.modelRole} role | ${row.modelDisplayName}${row.providerSource ? ` via ${row.providerSource}` : ''}`);
      lines.push(`  - CLI: ${row.cliCommand}`);
      if (row.baseModel || row.modelProfileId) {
        lines.push(`  - Model details: ${row.baseModel || row.modelProfileId}${row.modelProfileId && row.baseModel && row.modelProfileId !== row.baseModel ? ` | profile ${row.modelProfileId}` : ''}`);
      }
    });
  } else {
    lines.push('- No routed CLI model proof rows are available.');
  }

  lines.push(
    '',
    '## Learning And Self-Improvement Envelope',
    `- Operator supervision: ${Number(operatorSupervision.count || 0)} signal(s) | ${clipText(operatorSupervision.summary || 'No operator supervision summary recorded yet.', 180)}`,
    `- Training readiness: ${String(trainingReadiness.status || 'unknown').toUpperCase()} | ${clipText(trainingReadiness.summary || 'Training readiness is not recorded yet.', 180)}`,
    `- GS-Dev-1 export readiness: ${String(exportReadiness.status || 'unknown').toUpperCase()} | ${clipText(exportReadiness.summary || 'GS-Dev-1 export readiness is not recorded yet.', 180)}`,
    `- Reusable prompts: ${reusablePrompts.length}${reusablePrompts.length > 0 ? ` | ${reusablePrompts.slice(0, 2).map((item) => `${clipText(item?.prompt || '', 140)}${Array.isArray(item?.surfaces) && item.surfaces.length > 0 ? ` (${item.surfaces.join(', ')})` : ''}`).join(' | ')}` : ' | No trusted prompt patterns recorded yet.'}`,
    `- Learning default: ${learningPolicy.learningDefault}`,
    `- Self-improvement: ${learningPolicy.selfImproveSummary}`,
    `- Approval envelope: ${learningPolicy.approvalEnvelope}`,
    `- Learning journal: ${learningStatus.journalPath || 'not configured'}`,
    '',
    '## VS Code Reuse Contract',
    '- Desktop bridge: main.js + preload.js stay the existing operator bridge.',
    '- VS Code client surface: integration-library/extensions/vscode-companion/extension.js stays the coding-side client surface.',
    '- Canonical tools: core/tool-catalog.js stays the engine tool surface until native replacements are proven.',
    '- Locked plan: docs/LOCKED_PLAN_SUMMARY.md stays the multi-phase plan anchor.',
    '',
    '## Per-Pass Proof Commands',
    '- npm run engine:cli -- status --area roadmap',
    '- npm run engine:acceptance',
    '- npm run engine:cli -- proof-summary --title "Current engine pass"',
    '',
    '## Notes',
    '- Refresh this file after each bounded engine or model pass so the Python runtime path, routed model path, and current proof gate stay visible.',
    '- Keep autonomous self-improvement opt-in. User input, accepted runs, focused tests, and review outcomes should remain the main supervised learning signals.'
  );
  return lines.join('\n');
}

function buildAuditScriptArgs(workspaceRoot, { json = false } = {}) {
  const args = [
    path.join(RUNTIME_ROOT, 'backend', 'scripts', 'engine_daily_report.py'),
    '--project-root',
    workspaceRoot,
  ];
  if (json) {
    args.push('--json');
  }
  return args;
}

function buildSnapshotFromResult(request, result = {}, chatMode = 'ask') {
  const artifact = result?.artifact && typeof result.artifact === 'object' ? result.artifact : {};
  const runtimeFailure = result.runtimeFailure
    || result.runtime_failure
    || artifact.runtime_failure
    || artifact.runtimeFailure
    || ((result && result.ok === false && (result.error || result.message))
      ? {
          kind: 'runtime-api-error',
          message: String(result.error || result.message || '').trim(),
          blocking: true,
        }
      : {});
  return buildOperatorExecutionSnapshot({
    action: request.action,
    task: request.task || request.objective || '',
    taskMode: request.taskMode,
    laneId: request.laneId,
    laneLabel: request.laneLabel,
    modelProfileId: request.modelProfileId,
    modelRole: request.modelRole,
    modelDisplayName: request.modelDisplayName,
    baseModel: request.baseModel,
    providerSource: request.providerSource,
    runtimeRun: result.runtimeRun || result.runtime_run || artifact.runtime_run || artifact.runtimeRun || {},
    runtimeResult: result.runtimeResult || result.runtime_result || artifact.runtime_result || artifact.runtimeResult || {},
    runtimeFailure,
    reviewBundle: result.reviewBundle || result.review_bundle || artifact.review_bundle || artifact.reviewBundle || {},
    nextAction: result.nextAction || result.next_action || artifact.next_action || artifact.nextAction || {},
    memoryHints: result.memoryHints || result.memory_hints || artifact.memory_hints || artifact.memoryHints || {},
    workbenchArtifacts: result.workbenchArtifacts || result.workbench_artifacts || artifact.workbench_artifacts || artifact.workbenchArtifacts || [],
    artifactPaths: result.artifactPaths || artifact.artifactPaths || [],
  }, {
    seed: {
      ...(result.operatorExecution && typeof result.operatorExecution === 'object' ? result.operatorExecution : {}),
      chatMode,
      laneId: request.laneId,
      laneLabel: request.laneLabel,
      taskMode: request.taskMode,
      modelRole: request.modelRole,
      modelProfileId: request.modelProfileId,
      modelDisplayName: request.modelDisplayName,
      baseModel: request.baseModel,
      providerSource: request.providerSource,
    },
  });
}

function renderSnapshot(snapshot = {}) {
  const lines = [];
  const providerSummary = String(snapshot.providerAccountability?.summary || '').trim();
  const reviewBundle = snapshot.reviewBundle && typeof snapshot.reviewBundle === 'object' ? snapshot.reviewBundle : {};
  const nextAction = snapshot.nextAction && typeof snapshot.nextAction === 'object' ? snapshot.nextAction : {};
  const memoryHints = snapshot.memoryHints && typeof snapshot.memoryHints === 'object' ? snapshot.memoryHints : {};
  const failureClass = snapshot.failureClass && typeof snapshot.failureClass === 'object' ? snapshot.failureClass : {};

  lines.push(`Objective: ${snapshot.task || snapshot.taskObjective?.summary || 'Untitled objective'}`);
  lines.push(`Route: ${snapshot.laneLabel || snapshot.laneId || 'Unknown lane'} | ${snapshot.taskMode || 'unknown'} | ${snapshot.modelRole || 'unknown'} role`);
  lines.push(`Model: ${snapshot.modelDisplayName || snapshot.modelProfileId || snapshot.baseModel || 'unresolved'}${snapshot.providerSource ? ` via ${snapshot.providerSource}` : ''}`);
  if (providerSummary) {
    lines.push(`Provider accountability: ${providerSummary}`);
  }
  if (failureClass.summary) {
    lines.push(`Failure: ${clipText(failureClass.summary, 180)}`);
  }
  if (reviewBundle.decisionLabel || reviewBundle.verdict) {
    lines.push(`Review: ${reviewBundle.decisionLabel || reviewBundle.verdict}`);
  }
  if (reviewBundle.reason) {
    lines.push(`Reason: ${clipText(reviewBundle.reason, 180)}`);
  }
  if (reviewBundle.howToFix) {
    lines.push(`How to fix: ${clipText(reviewBundle.howToFix, 180)}`);
  }
  if (nextAction.label || nextAction.summary) {
    lines.push(`Next safe action: ${clipText([nextAction.label, nextAction.summary].filter(Boolean).join(' - '), 200)}`);
  }
  if (memoryHints.summary) {
    lines.push(`Memory: ${clipText(memoryHints.summary, 200)}`);
  }
  return lines.join('\n');
}

function renderPreflight(preflight = {}) {
  const checks = Array.isArray(preflight.checks) ? preflight.checks : [];
  const lines = [
    `Workspace: ${preflight.workspaceRoot || ''}`,
    `Ready: ${preflight.ready === true ? 'yes' : 'no'}`,
    `Blocking: ${Number(preflight.blockingCount || 0)} | Warnings: ${Number(preflight.warningCount || 0)}`,
  ];
  checks.forEach((check) => {
    lines.push(`- ${check.name}: ${check.ok ? 'ok' : 'missing'}${check.detail ? ` :: ${check.detail}` : ''}`);
  });
  return lines.join('\n');
}

function renderGitStatus(status = {}) {
  const files = Array.isArray(status.files) ? status.files : [];
  const lines = [
    `Branch: ${status.branch || 'Detached HEAD'}`,
    `Upstream: ${status.upstream || 'unpublished'}`,
    `Ahead/behind: ${Number(status.ahead || 0)}/${Number(status.behind || 0)}`,
    `Dirty: ${status.dirty === true ? 'yes' : 'no'} | staged ${Number(status.stagedCount || 0)} | unstaged ${Number(status.unstagedCount || 0)} | untracked ${Number(status.untrackedCount || 0)}`,
  ];
  if (status.lastCommit) {
    lines.push(`Last commit: ${status.lastCommit}`);
  }
  files.slice(0, 20).forEach((file) => {
    lines.push(`- ${file.path} [${file.state}]`);
  });
  if (files.length > 20) {
    lines.push(`- ... ${files.length - 20} more file(s)`);
  }
  return lines.join('\n');
}

function renderModelLifecycleStatus(status = {}) {
  const lifecycle = status.lifecycle && typeof status.lifecycle === 'object' ? status.lifecycle : {};
  const routeCoverage = lifecycle.routeCoverage && typeof lifecycle.routeCoverage === 'object' ? lifecycle.routeCoverage : {};
  const benchmarkLeader = status.benchmarkLeader && typeof status.benchmarkLeader === 'object' ? status.benchmarkLeader : {};
  const workerFamilies = lifecycle.workerFamilies && typeof lifecycle.workerFamilies === 'object' ? lifecycle.workerFamilies : {};
  const entries = Array.isArray(lifecycle.entries) ? lifecycle.entries : [];
  const lines = [
    `Workspace: ${status.workspaceRoot || ''}`,
    `Promotion policy: ${String(lifecycle.promotionPolicy || status.settings?.trainingPromotionPolicy || 'manual-promote').trim() || 'manual-promote'}`,
    `Worker families: primary ${workerFamilies.primary || 'qwen'} | backup ${workerFamilies.backup || 'deepseek-coder'} | reasoning ${workerFamilies.reasoningFallback || 'qwen3'}`,
    `Lifecycle: ${String(lifecycle.summary || 'No local worker lifecycle artifacts discovered yet.').trim()}`,
  ];
  if (routeCoverage.summary) {
    lines.push(`Route coverage: ${routeCoverage.summary}`);
  }
  if (benchmarkLeader?.model) {
    lines.push(`Benchmark leader: ${benchmarkLeader.model}${benchmarkLeader.providerSource ? ` via ${benchmarkLeader.providerSource}` : ''}`);
  }
  lines.push(`Recommended models: ${RECOMMENDED_LOCAL_MODELS.map((item) => item.label).join(', ')}`);
  lines.push(`Promotion modes: ${PROMOTION_POLICY_OPTIONS.map((item) => item.label).join(', ')}`);
  lines.push(`Worker families available: ${WORKER_FAMILY_OPTIONS.map((item) => item.label).join(', ')}`);
  entries.slice(0, 8).forEach((entry) => {
    const variant = [entry.workerFamily, entry.workerVariantType].filter(Boolean).join('/');
    const readiness = [
      String(entry.installState || '').trim(),
      String(entry.promotionReadiness || entry.readiness || entry.tuningState || '').trim(),
    ].filter(Boolean).join(' | ');
    lines.push(`- ${entry.label || entry.wrappedProfileId || entry.workerVariantId || entry.baseModel || 'Local worker'} :: ${variant || 'variant'}${readiness ? ` :: ${readiness}` : ''}`);
  });
  if (entries.length > 8) {
    lines.push(`- ... ${entries.length - 8} more local lifecycle entry(s)`);
  }
  if (status.commands?.checkpointMerge) {
    lines.push(`Checkpoint merge command: ${status.commands.checkpointMerge}`);
  }
  if (status.commands?.candidateProof) {
    lines.push(`Candidate proof command: ${status.commands.candidateProof}`);
  }
  return lines.join('\n');
}

function renderFoundryProofExecution(result = {}) {
  const lines = [
    `Workspace: ${String(result.workspaceRoot || '').trim()}`,
    `Dry run: ${result.dryRun === true ? 'yes' : 'no'}`,
    `Candidates: ${Number(result.candidateCount || 0)} | Capabilities: ${Number(result.capabilityCount || 0)}`,
  ];
  if (result.summary) {
    lines.push(`Summary: ${result.summary}`);
  }
  if (result.message) {
    lines.push(`Message: ${result.message}`);
  }
  const candidateResults = Array.isArray(result.results) ? result.results : [];
  candidateResults.forEach((entry) => {
    const candidate = entry?.candidate && typeof entry.candidate === 'object' ? entry.candidate : {};
    const proof = entry?.proof && typeof entry.proof === 'object' ? entry.proof : {};
    lines.push(`- ${candidate.label || candidate.id || 'Foundry candidate'} :: ${String(proof.status || 'next').toUpperCase()} :: ${Number(proof.verifiedCapabilityCount || 0)}/${Number(proof.capabilityCount || 0)} capabilities`);
    if (proof.summary) {
      lines.push(`  ${proof.summary}`);
    }
    const capabilityResults = Array.isArray(entry?.capabilityResults) ? entry.capabilityResults : [];
    capabilityResults.forEach((capability) => {
      lines.push(`  - ${capability.label || capability.capabilityId}: ${capability.ok === true || capability.dryRun === true ? 'pass' : 'fail'}${capability.benchmarkId ? ` | ${capability.benchmarkId}` : ''}`);
    });
  });
  return lines.join('\n');
}

function buildChatEnvOverrides(request = {}, chatMode = 'ask') {
  const env = {
    ASSISTANT_SYSTEM_PROMPT: buildHumanPromptInstruction(chatMode),
  };
  const provider = String(request.providerSource || '').trim().toLowerCase();
  const model = String(request.baseModel || '').trim();
  if (provider) {
    env.AGENT_PROVIDER = provider;
  }
  if (provider === 'openai' && model) {
    env.OPENAI_MODEL = model;
  }
  if (provider === 'ollama' && model) {
    env.OLLAMA_MODEL = model;
  }
  return env;
}

function buildLiveStateSummary(report = {}) {
  return buildSharedLiveStateSummary(report);
}

function buildGroundedChatPrompt({ chatMode = 'ask', userPrompt = '', report = {}, built = {} } = {}) {
  return buildSharedGroundedChatPrompt({
    chatMode,
    userPrompt,
    report,
    built,
    modeConfig: getChatModeConfig(chatMode),
  });
}

function buildDirectAskReply(userPrompt = '', report = {}) {
  return buildSharedDirectAskReply(userPrompt, report);
}

function buildDirectPlanReply(userPrompt = '', report = {}, built = {}) {
  return buildSharedDirectPlanReply(userPrompt, report, built);
}

function extractChatReply(result = {}) {
  return String(result.reply || result.summary || result.message || '').trim();
}

function createCliLearningJournal({ workspaceRoot = '', targetWorkspaceRoot = '', labRoot = '', command = '', prompt = '', changeSessionId = '' } = {}) {
  const service = new LearningJournalService();
  service.setScope({
    workspaceRoot,
    targetRoot: String(targetWorkspaceRoot || workspaceRoot || '').trim(),
    labRoot,
    pollingEnabled: false,
    threadId: `engine-cli:${normalizeCliChatCommand(command) || 'ask'}`,
    changeSessionId: String(changeSessionId || '').trim() || buildSyntheticTicketId(`${command}\n${targetWorkspaceRoot || workspaceRoot}\n${prompt}`),
  });
  return service;
}

function collectCliChangedFiles(snapshot = {}) {
  const items = Array.isArray(snapshot?.changedFiles) ? snapshot.changedFiles : [];
  return items
    .map((item) => {
      if (item && typeof item === 'object') {
        return {
          path: String(item.path || '').trim(),
          status: String(item.status || item.state || '').trim(),
        };
      }
      return {
        path: String(item || '').trim(),
        status: '',
      };
    })
    .filter((item) => item.path);
}

function recordCliPromptStart(learningJournal, { command = '', prompt = '', built = {}, docsResult = {} } = {}) {
  if (!learningJournal || !prompt) {
    return;
  }
  const normalizedCommand = normalizeCliChatCommand(command);
  const docDigests = Array.isArray(docsResult?.digests) ? docsResult.digests : [];
  learningJournal.recordEvent('chat-prompt', {
    text: prompt,
    command: normalizedCommand,
    chatMode: String(built?.chatMode || normalizedCommand || '').trim(),
    laneId: String(built?.request?.laneId || '').trim(),
    taskMode: String(built?.request?.taskMode || '').trim(),
    surface: 'engine-cli',
    source: 'engine-cli',
    docSourceCount: docDigests.length,
    trustedDocs: docDigests.slice(0, 3).map((item) => ({
      title: String(item?.title || item?.summary || item?.url || '').trim(),
      url: String(item?.url || '').trim(),
      domain: String(item?.domain || '').trim(),
    })),
  });
  if (['plan', 'edit', 'agent', 'repair'].includes(normalizedCommand)) {
    learningJournal.recordEvent('task-created', {
      title: prompt,
      command: normalizedCommand,
      laneId: String(built?.request?.laneId || '').trim(),
      taskMode: String(built?.request?.taskMode || '').trim(),
      surface: 'engine-cli',
      source: 'engine-cli',
    });
  }
}

function recordCliRunOutcome(learningJournal, { command = '', built = {}, trackedRun = {} } = {}) {
  if (!learningJournal) {
    return;
  }
  const snapshot = trackedRun?.operatorExecution || buildOperatorExecutionSnapshot(trackedRun || {}, {});
  const changedFiles = collectCliChangedFiles(snapshot);
  const state = String(trackedRun?.state || snapshot?.status || '').trim().toLowerCase() || 'unknown';
  learningJournal.recordEvent('run-complete', {
    state,
    accepted: state === 'pass',
    trusted: state === 'pass',
    command: normalizeCliChatCommand(command),
    laneId: String(built?.request?.laneId || snapshot?.laneId || '').trim(),
    taskMode: String(built?.request?.taskMode || snapshot?.taskMode || '').trim(),
    summary: String(snapshot?.reviewSummary?.summary || snapshot?.runSummary?.summary || snapshot?.testSummary?.summary || '').trim(),
    reviewBundle: snapshot?.reviewBundle && typeof snapshot.reviewBundle === 'object' ? snapshot.reviewBundle : {},
    failureClass: snapshot?.failureClass && typeof snapshot.failureClass === 'object' ? snapshot.failureClass : {},
    nextAction: snapshot?.nextAction && typeof snapshot.nextAction === 'object' ? snapshot.nextAction : {},
    changedFiles,
    changedFileCount: Number(snapshot?.changedFileCount || changedFiles.length || 0),
    surface: 'engine-cli',
    source: 'engine-cli',
  });
}

async function executeTrackedRuntimeRun(runtime, request, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 0);
  const run = runtime.run(request);
  if (!run || !run.runId) {
    throw new Error('Engine run did not start.');
  }
  return runtime.waitForRun(run.runId, { timeoutMs });
}

async function runChatCommand(parsed) {
  const prompt = parsed.trailing.join(' ').trim();
  if (!prompt) {
    throw new Error(`A prompt is required for ${parsed.command} mode.`);
  }
  const workspaceRoot = parsed.workspaceRoot;
  const targetWorkspaceRoot = parsed.labRoot || workspaceRoot;
  const runtime = new SharedAgentRuntime({ workspaceRoot });
  const context = await buildSystemCheckContext(workspaceRoot);
  const report = buildSystemCheck({
    workspaceRoot,
    ...context,
  });
  const docMode = usesTrustedDocs(parsed.command, parsed.docSources);
  const docsResult = docMode
    ? await fetchTrustedDocDigests(parsed.docSources)
    : { digests: [], failures: [] };
  if (docMode && parsed.docSources.length > 0 && docsResult.digests.length === 0) {
    throw new Error(`Unable to load trusted docs: ${docsResult.failures.map((item) => `${item.source || 'source'} (${item.reason})`).join('; ')}`);
  }
  const built = buildTerminalRequest({
    command: normalizeCliChatCommand(parsed.command),
    workspaceRoot,
    labRoot: parsed.labRoot,
    prompt,
    validationCommands: parsed.validationCommands,
  });
  const modeConfig = getChatModeConfig(built.chatMode);
  const learningJournal = createCliLearningJournal({
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot: parsed.labRoot,
    command: parsed.command,
    prompt,
    changeSessionId: built?.request?.ticket || '',
  });
  recordCliPromptStart(learningJournal, {
    command: parsed.command,
    prompt,
    built,
    docsResult,
  });

  if (['ask', 'plan', 'ask-docs', 'plan-docs'].includes(parsed.command)) {
    const directReply = !docMode && normalizeCliChatCommand(parsed.command) === 'ask'
      ? buildDirectAskReply(prompt, report)
      : (!docMode ? buildDirectPlanReply(prompt, report, built) : '');
    if (directReply) {
      console.log(directReply);
      if (normalizeCliChatCommand(parsed.command) === 'plan') {
        console.log('');
        console.log(`Route: ${built.routing.laneLabel} | ${built.request.taskMode} | ${built.request.modelRole} role`);
        console.log(`Model: ${built.request.modelDisplayName || built.request.modelProfileId || built.request.baseModel || 'unresolved'}${built.request.providerSource ? ` via ${built.request.providerSource}` : ''}`);
      }
      learningJournal.stop();
      return 0;
    }
    const chatPrompt = buildDocsAwareGroundedPrompt({
      built,
      report,
      userPrompt: prompt,
      docDigests: docsResult.digests,
    });
    const result = await runtime.chat(chatPrompt, {
      chatMode: built.chatMode,
      targetWorkspaceRoot,
      workspace: targetWorkspaceRoot,
      projectRoot: targetWorkspaceRoot,
      env: buildChatEnvOverrides(built.request, built.chatMode),
    });
    const reply = extractChatReply(result);
    if (normalizeCliChatCommand(parsed.command) === 'plan') {
      console.log(reply || 'No plan reply received.');
      if (docsResult.failures.length > 0) {
        console.log('');
        console.log(`Docs skipped: ${docsResult.failures.map((item) => `${item.source || 'source'} (${item.reason})`).join('; ')}`);
      }
      console.log('');
      console.log(`Route: ${built.routing.laneLabel} | ${built.request.taskMode} | ${built.request.modelRole} role`);
      console.log(`Model: ${built.request.modelDisplayName || built.request.modelProfileId || built.request.baseModel || 'unresolved'}${built.request.providerSource ? ` via ${built.request.providerSource}` : ''}`);
      learningJournal.stop();
      return result.ok === false ? 1 : 0;
    }
    console.log(reply || 'No reply received.');
    if (docsResult.failures.length > 0) {
      console.log('');
      console.log(`Docs skipped: ${docsResult.failures.map((item) => `${item.source || 'source'} (${item.reason})`).join('; ')}`);
    }
    learningJournal.stop();
    return result.ok === false ? 1 : 0;
  }

  if (parsed.command === 'edit' && built.routing.modeRequiresEditConfirmation && !parsed.yes) {
    console.log(`${modeConfig.label} mode is ready, but execution is still waiting for confirmation.`);
    console.log(`Route: ${built.routing.laneLabel} | ${built.request.taskMode} | ${built.request.modelRole} role`);
    console.log(`Next step: ${built.routing.suggestedNextAction}`);
    console.log('Run the same command again with --yes when you want the engine to execute it.');
    learningJournal.stop();
    return 0;
  }

  if (built.request.taskMode === 'summarizer') {
    const report = buildSystemCheck(workspaceRoot);
    console.log(renderSystemCheck(report, { area: parsed.area || 'roadmap', compact: true }));
    learningJournal.stop();
    return report.areas?.roadmap?.status === 'blocked' ? 1 : 0;
  }

  if (parsed.yes && targetWorkspaceRoot && targetWorkspaceRoot !== workspaceRoot) {
    built.request.approvalGated = false;
    built.request.approvalProtectedOnly = false;
    built.request.metadata = {
      ...(built.request.metadata || {}),
      executionBoundary: 'clone-lab-confirmed',
      approvalMode: 'auto-approved-in-clone',
    };
  }

  const trackedRun = await executeTrackedRuntimeRun(runtime, {
    ...built.request,
    workspaceRoot,
    targetWorkspaceRoot,
    workspace: targetWorkspaceRoot,
    projectRoot: targetWorkspaceRoot,
  });
  const snapshot = trackedRun?.operatorExecution || buildOperatorExecutionSnapshot(trackedRun || {}, {});
  recordCliRunOutcome(learningJournal, {
    command: parsed.command,
    built,
    trackedRun,
  });
  learningJournal.stop();
  console.log(`${modeConfig.label} mode completed.`);
  console.log(renderSnapshot(snapshot));
  return trackedRun?.state === 'pass' || trackedRun?.state === 'skipped' ? 0 : 1;
}

async function runProgressSummaryCommand(parsed) {
  const objective = parsed.trailing.join(' ').trim();
  const context = await buildSystemCheckContext(parsed.workspaceRoot);
  const report = buildSystemCheck({
    workspaceRoot: parsed.workspaceRoot,
    ...context,
  });
  const docsResult = parsed.docSources.length > 0
    ? await fetchTrustedDocDigests(parsed.docSources)
    : { digests: [], failures: [] };
  const outputPath = parsed.summaryPath || path.join(parsed.workspaceRoot, 'docs', 'LOCKED_PLAN_SUMMARY.md');
  const markdown = buildProgressSummaryMarkdown({
    title: parsed.title || objective || 'Locked engine plan',
    objective,
    workspaceRoot: parsed.workspaceRoot,
    report,
    docDigests: docsResult.digests,
  });
  fs.writeFileSync(outputPath, `${markdown}\n`, 'utf8');
  console.log(`Wrote locked plan summary to ${outputPath}`);
  if (docsResult.failures.length > 0) {
    console.log(`Docs skipped: ${docsResult.failures.map((item) => `${item.source || 'source'} (${item.reason})`).join('; ')}`);
  }
  return 0;
}

async function runProofSummaryCommand(parsed) {
  const objective = parsed.trailing.join(' ').trim();
  const proofSnapshot = buildSharedEngineModelProofSnapshot({
    workspaceRoot: parsed.workspaceRoot,
    labRoot: parsed.labRoot,
  });
  const outputPath = parsed.summaryPath || path.join(parsed.workspaceRoot, 'docs', 'ENGINE_MODEL_PROOF.md');
  const markdown = buildEngineModelProofMarkdown({
    title: parsed.title || objective || 'Engine model proof',
    objective,
    workspaceRoot: parsed.workspaceRoot,
    pythonCommand: proofSnapshot.pythonCommand,
    acceptanceState: proofSnapshot.acceptanceState,
    assistantConfig: proofSnapshot.assistantConfig,
    learningStatus: proofSnapshot.learningStatus,
    routeProofRows: proofSnapshot.routeProofRows,
  });
  fs.writeFileSync(outputPath, `${markdown}\n`, 'utf8');
  console.log(`Wrote engine model proof to ${outputPath}`);
  return 0;
}

async function runStatusCommand(parsed) {
  const context = await buildSystemCheckContext(parsed.workspaceRoot);
  const report = buildSystemCheck({
    workspaceRoot: parsed.workspaceRoot,
    area: parsed.area || '',
    ...context,
  });
  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.areas?.roadmap?.status === 'blocked' ? 1 : 0;
  }
  console.log(renderSystemCheck(report, {
    area: parsed.area || '',
    compact: true,
  }));
  return report.areas?.roadmap?.status === 'blocked' ? 1 : 0;
}

async function runDoctorCommand(parsed) {
  const preflight = runPreflight(parsed.workspaceRoot, { requireGh: false });
  console.log(renderPreflight(preflight));
  console.log('');
  const context = await buildSystemCheckContext(parsed.workspaceRoot);
  const report = buildSystemCheck({
    workspaceRoot: parsed.workspaceRoot,
    ...context,
  });
  console.log(renderSystemCheck(report, { compact: true }));
  return preflight.ready === true && report.areas?.acceptance?.status !== 'fail' ? 0 : 1;
}

async function runAuditCommand(parsed) {
  const python = resolvePythonCommand(parsed.workspaceRoot, '', RUNTIME_ROOT);
  if (!python) {
    console.error('Python runtime is not available. Install Python or configure the repo virtual environment before running the daily audit.');
    return 1;
  }
  const args = buildAuditScriptArgs(parsed.workspaceRoot, { json: parsed.json === true });
  try {
    const output = childProcess.execFileSync(python, args, {
      cwd: parsed.workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const text = String(output || '').trimEnd();
    if (text) {
      console.log(text);
    }
    return 0;
  } catch (error) {
    const stdout = String(error?.stdout || '').trim();
    const stderr = String(error?.stderr || '').trim();
    if (stdout) {
      console.log(stdout);
    }
    if (stderr) {
      console.error(stderr);
    } else {
      console.error(String(error?.message || error));
    }
    return 1;
  }
}

async function runReviewCommand(parsed) {
  const runtime = new SharedAgentRuntime({ workspaceRoot: parsed.workspaceRoot });
  const latest = Array.isArray(runtime.getStatus().latest) ? runtime.getStatus().latest[0] : null;
  if (!latest) {
    console.log('No recorded engine run is available yet.');
    return 1;
  }
  const snapshot = latest.operatorExecution || buildOperatorExecutionSnapshot(latest, {});
  console.log(renderSnapshot(snapshot));
  return 0;
}

async function runRepairCommand(parsed) {
  const prompt = parsed.trailing.join(' ').trim() || 'Repair the latest failed bounded run and rerun the smallest relevant validation.';
  const built = buildTerminalRequest({
    command: 'edit',
    workspaceRoot: parsed.workspaceRoot,
    labRoot: parsed.labRoot,
    prompt,
    validationCommands: parsed.validationCommands,
  });
  built.request = applyRepairRouteOverride(built.request);
  const runtime = new SharedAgentRuntime({ workspaceRoot: parsed.workspaceRoot });
  const targetWorkspaceRoot = parsed.labRoot || parsed.workspaceRoot;
  const learningJournal = createCliLearningJournal({
    workspaceRoot: parsed.workspaceRoot,
    targetWorkspaceRoot,
    labRoot: parsed.labRoot,
    command: 'repair',
    prompt,
    changeSessionId: built?.request?.ticket || '',
  });
  recordCliPromptStart(learningJournal, {
    command: 'repair',
    prompt,
    built,
  });
  if (targetWorkspaceRoot && targetWorkspaceRoot !== parsed.workspaceRoot) {
    built.request.approvalGated = false;
    built.request.approvalProtectedOnly = false;
    built.request.metadata = {
      ...(built.request.metadata || {}),
      executionBoundary: 'clone-lab-confirmed',
      approvalMode: 'auto-approved-in-clone',
    };
  }
  const trackedRun = await executeTrackedRuntimeRun(runtime, {
    ...built.request,
    workspaceRoot: parsed.workspaceRoot,
    targetWorkspaceRoot,
    workspace: targetWorkspaceRoot,
    projectRoot: targetWorkspaceRoot,
  });
  const snapshot = trackedRun?.operatorExecution || buildOperatorExecutionSnapshot(trackedRun || {}, {});
  recordCliRunOutcome(learningJournal, {
    command: 'repair',
    built,
    trackedRun,
  });
  learningJournal.stop();
  console.log(renderSnapshot(snapshot));
  return trackedRun?.state === 'pass' || trackedRun?.state === 'skipped' ? 0 : 1;
}

async function runSelfImproveCommand(parsed) {
  const client = new AgentRuntimeClient({ workspaceRoot: parsed.workspaceRoot });
  const targetWorkspaceRoot = parsed.labRoot || parsed.workspaceRoot;
  const response = await client.invoke('action', {
    request: {
      action: 'self-improve',
      workspaceRoot: parsed.workspaceRoot,
      workspace: targetWorkspaceRoot,
      targetWorkspaceRoot,
      projectRoot: targetWorkspaceRoot,
      labRoot: parsed.labRoot || '',
      selfImprove: true,
    },
    workspaceRoot: parsed.workspaceRoot,
    targetWorkspaceRoot,
    workspace: targetWorkspaceRoot,
    projectRoot: targetWorkspaceRoot,
  });
  const result = response.result || { ok: response.ok };
  console.log(clipText(result.summary || result.message || result.label || 'Self-improvement run finished.', 240));
  return response.ok && result.ok !== false ? 0 : 1;
}

async function runAutopilotCommand(parsed) {
  const client = new AgentRuntimeClient({ workspaceRoot: parsed.workspaceRoot });
  const targetWorkspaceRoot = parsed.labRoot || parsed.workspaceRoot;
  const response = await client.invoke('action', {
    request: {
      action: 'autopilot',
      workspaceRoot: parsed.workspaceRoot,
      workspace: targetWorkspaceRoot,
      targetWorkspaceRoot,
      projectRoot: targetWorkspaceRoot,
      labRoot: parsed.labRoot || '',
    },
    workspaceRoot: parsed.workspaceRoot,
    targetWorkspaceRoot,
    workspace: targetWorkspaceRoot,
    projectRoot: targetWorkspaceRoot,
  });
  const result = response.result || { ok: response.ok };
  console.log(clipText(result.summary || result.message || result.label || 'Autopilot run finished.', 240));
  return response.ok && result.ok !== false ? 0 : 1;
}

async function runTrainCommand(parsed) {
  const client = new AgentRuntimeClient({ workspaceRoot: parsed.workspaceRoot });
  const targetWorkspaceRoot = parsed.labRoot || parsed.workspaceRoot;
  const response = await client.train({
    workspaceRoot: parsed.workspaceRoot,
    targetWorkspaceRoot,
    projectRoot: targetWorkspaceRoot,
    workspace: targetWorkspaceRoot,
    labRoot: parsed.labRoot || '',
  });
  console.log(clipText(response.summary || response.message || 'Training run finished.', 240));
  return response.ok === false ? 1 : 0;
}

async function runModelsCommand(parsed) {
  const subcommand = String(parsed.trailing[0] || 'status').trim().toLowerCase() || 'status';
  const settings = readTrainingTuningSettings(parsed.workspaceRoot);
  const runtime = new SharedAgentRuntime({ workspaceRoot: parsed.workspaceRoot });
  const telemetry = await collectTrainingTelemetry({
    settings,
    activeRuns: Array.isArray(runtime.getStatus()?.activeRuns) ? runtime.getStatus().activeRuns.length : 0,
    schedulerRunning: false,
  });
  const benchmarkRuns = listBenchmarkRuns(parsed.workspaceRoot);
  const foundryStatus = buildModelFoundryStatus(parsed.workspaceRoot, {
    benchmarks: { runs: benchmarkRuns },
    learning: {},
    acceptance: readLatestAcceptanceReport(parsed.workspaceRoot),
  });

  if (subcommand === 'proof') {
    const candidateId = String(parsed.candidateId || parsed.trailing[1] || '').trim();
    const proofResult = runFoundryCandidateProofs(parsed.workspaceRoot, {
      candidateId,
      all: parsed.all === true,
      capabilityIds: parsed.capabilityIds,
      dryRun: parsed.dryRun === true,
      labRoot: parsed.labRoot || '',
      foundryStatus,
    });
    const payload = {
      ...proofResult,
      workspaceRoot: parsed.workspaceRoot,
      candidateId,
      supportedCapabilities: FOUNDRY_PROOF_CAPABILITIES.map((capability) => ({
        id: capability.id,
        label: capability.label,
        commands: capability.commands,
      })),
    };
    if (parsed.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(renderFoundryProofExecution(payload));
    }
    return proofResult.ok ? 0 : 1;
  }

  const aiStatus = buildAiStatus({
    workspaceRoot: parsed.workspaceRoot,
    settings,
    tuningStatus: { telemetry, recommendedModels: RECOMMENDED_LOCAL_MODELS },
    benchmarkRuns,
    modelFoundry: foundryStatus,
    secretAvailability: {},
  });
  const payload = {
    workspaceRoot: parsed.workspaceRoot,
    settings,
    lifecycle: aiStatus.localModelInventory,
    benchmarkLeader: aiStatus.benchmarkSummary?.[0] || null,
    commands: {
      checkpointMerge: buildCheckpointMergeCommand(parsed.workspaceRoot, {
        basePath: '<base-model-dir>',
        secondaryPath: '<secondary-model-dir>',
        outputPath: path.join(parsed.workspaceRoot, '.assistant_checkpoint_merges', 'merge-output'),
        mergeName: 'lab-merge',
      }),
      candidateProof: `npm run engine:cli -- models proof --candidate-id "${String(foundryStatus?.nextCandidate?.id || '<candidate-id>').trim() || '<candidate-id>'}"`,
    },
  };
  if (parsed.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderModelLifecycleStatus(payload));
  }
  return 0;
}

async function runCheckpointMergeCommand(parsed) {
  const client = new AgentRuntimeClient({ workspaceRoot: parsed.workspaceRoot });
  const targetWorkspaceRoot = parsed.labRoot || parsed.workspaceRoot;
  const basePath = String(parsed.basePath || parsed.trailing[0] || '').trim();
  const secondaryPath = String(parsed.secondaryPath || parsed.trailing[1] || '').trim();
  if (!basePath || !secondaryPath) {
    throw new Error('checkpoint-merge requires --base-path and --secondary-path (or two trailing paths).');
  }
  const response = await client.invoke('action', {
    request: {
      action: 'checkpoint-merge',
      workspaceRoot: parsed.workspaceRoot,
      workspace: targetWorkspaceRoot,
      targetWorkspaceRoot,
      projectRoot: targetWorkspaceRoot,
      labRoot: parsed.labRoot || '',
      basePath,
      secondaryPath,
      outputPath: parsed.outputPath || '',
      mergeName: parsed.mergeName || '',
      alpha: parsed.alpha ?? 0.2,
      method: parsed.method || 'linear',
      dryRun: parsed.dryRun === true,
    },
    workspaceRoot: parsed.workspaceRoot,
    targetWorkspaceRoot,
    workspace: targetWorkspaceRoot,
    projectRoot: targetWorkspaceRoot,
  });
  const result = response.result || { ok: response.ok };
  const summary = result.summary || result.message || 'Checkpoint merge finished.';
  console.log(summary);
  if (result.checkpointMerge && typeof result.checkpointMerge === 'object') {
    console.log(JSON.stringify(result.checkpointMerge, null, 2));
  }
  return response.ok && result.ok !== false ? 0 : 1;
}

async function runGitCommand(parsed) {
  const subcommand = String(parsed.trailing.shift() || 'status').trim().toLowerCase();
  const workspaceRoot = parsed.workspaceRoot;
  let result;

  if (subcommand === 'status' || subcommand === 'summary') {
    result = subcommand === 'summary' ? getGitSummary(workspaceRoot) : getGitStatus(workspaceRoot);
    console.log(renderGitStatus(result));
    return result.ok === false ? 1 : 0;
  }
  if (subcommand === 'diff') {
    const relativePath = String(parsed.trailing[0] || '').trim();
    if (!relativePath) {
      throw new Error('git diff requires a workspace-relative path.');
    }
    result = getGitDiff(workspaceRoot, relativePath, { cached: parsed.cached });
    console.log(result.diff || `No diff for ${result.path}.`);
    return 0;
  }
  if (subcommand === 'stage-all') {
    result = stageAll(workspaceRoot);
  } else if (subcommand === 'unstage-all') {
    result = unstageAll(workspaceRoot);
  } else if (subcommand === 'stage') {
    result = stagePaths(workspaceRoot, parsed.trailing);
  } else if (subcommand === 'unstage') {
    result = unstagePaths(workspaceRoot, parsed.trailing);
  } else if (subcommand === 'discard') {
    result = discardPaths(workspaceRoot, parsed.trailing);
  } else if (subcommand === 'commit') {
    result = commitStaged(workspaceRoot, parsed.message || parsed.trailing.join(' '));
  } else if (subcommand === 'pull') {
    result = pullTrackedBranch(workspaceRoot);
  } else if (subcommand === 'push') {
    result = pushTrackedBranch(workspaceRoot);
  } else if (subcommand === 'publish') {
    result = publishBranch(workspaceRoot);
  } else if (subcommand === 'branches') {
    result = listBranches(workspaceRoot);
    if (result.ok) {
      result.branches.forEach((branch) => {
        console.log(`${branch.current ? '*' : '-'} ${branch.name}${branch.upstream ? ` -> ${branch.upstream}` : ''}`);
      });
    } else {
      console.log(result.message || 'Unable to list branches.');
    }
    return result.ok ? 0 : 1;
  } else if (subcommand === 'create-branch') {
    result = createBranch(workspaceRoot, parsed.trailing[0] || '');
  } else if (subcommand === 'switch-branch') {
    result = switchBranch(workspaceRoot, parsed.trailing[0] || '');
  } else {
    throw new Error(`Unsupported git subcommand: ${subcommand}`);
  }

  if (result?.message) {
    console.log(result.message);
  }
  if (result?.status) {
    console.log(renderGitStatus(result.status));
  }
  return result?.ok === false ? 1 : 0;
}

async function dispatch(parsed) {
  switch (parsed.command) {
    case 'ask':
    case 'plan':
    case 'ask-docs':
    case 'plan-docs':
    case 'edit':
    case 'agent':
      return runChatCommand(parsed);
    case 'status':
      return runStatusCommand(parsed);
    case 'review':
      return runReviewCommand(parsed);
    case 'audit':
      return runAuditCommand(parsed);
    case 'repair':
      return runRepairCommand(parsed);
    case 'autopilot':
      return runAutopilotCommand(parsed);
    case 'self-improve':
      return runSelfImproveCommand(parsed);
    case 'train':
      return runTrainCommand(parsed);
    case 'models':
      return runModelsCommand(parsed);
    case 'checkpoint-merge':
      return runCheckpointMergeCommand(parsed);
    case 'doctor':
      return runDoctorCommand(parsed);
    case 'progress-summary':
      return runProgressSummaryCommand(parsed);
    case 'proof-summary':
      return runProofSummaryCommand(parsed);
    case 'git':
      return runGitCommand(parsed);
    default:
      throw new Error(`Unsupported engine command: ${parsed.command}`);
  }
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  const exitCode = await dispatch(parsed);
  if (Number.isInteger(exitCode)) {
    process.exitCode = exitCode;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[engine-cli] ${String(error?.message || error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildDirectAskReply,
  buildDirectPlanReply,
  buildAuditScriptArgs,
  buildEngineModelProofMarkdown,
  buildDocsAwareGroundedPrompt,
  buildGroundedChatPrompt,
  buildLiveStateSummary,
  buildProgressSummaryMarkdown,
  buildTerminalRequest,
  buildChatEnvOverrides,
  createCliLearningJournal,
  collectCliChangedFiles,
  extractChatReply,
  normalizeCliChatCommand,
  parseCliArgs,
  recordCliPromptStart,
  recordCliRunOutcome,
  renderGitStatus,
  renderFoundryProofExecution,
  renderModelLifecycleStatus,
  renderPreflight,
  renderSnapshot,
};
