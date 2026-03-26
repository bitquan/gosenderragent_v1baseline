'use strict';

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
const { readAssistantConfig } = require('../host/assistant-config');
const { AgentRuntimeClient, resolvePythonCommand } = require('../shared-runtime/agent-runtime-client');
const { SharedAgentRuntime, buildOperatorExecutionSnapshot } = require('../shared-runtime/runtime');

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
    alpha: null,
    method: '',
    dryRun: false,
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

function buildTerminalRequest({ command, workspaceRoot, labRoot, prompt = '', validationCommands = [] } = {}) {
  const chatMode = command === 'plan'
    ? 'plan'
    : command === 'edit'
      ? 'edit'
      : command === 'agent'
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
  const built = buildTerminalRequest({
    command: parsed.command,
    workspaceRoot,
    labRoot: parsed.labRoot,
    prompt,
    validationCommands: parsed.validationCommands,
  });
  const modeConfig = getChatModeConfig(built.chatMode);

  if (parsed.command === 'ask' || parsed.command === 'plan') {
    const directReply = parsed.command === 'ask'
      ? buildDirectAskReply(prompt, report)
      : buildDirectPlanReply(prompt, report, built);
    if (directReply) {
      console.log(directReply);
      if (parsed.command === 'plan') {
        console.log('');
        console.log(`Route: ${built.routing.laneLabel} | ${built.request.taskMode} | ${built.request.modelRole} role`);
        console.log(`Model: ${built.request.modelDisplayName || built.request.modelProfileId || built.request.baseModel || 'unresolved'}${built.request.providerSource ? ` via ${built.request.providerSource}` : ''}`);
      }
      return 0;
    }
    const chatPrompt = buildGroundedChatPrompt({
      chatMode: built.chatMode,
      userPrompt: prompt,
      report,
      built,
    });
    const result = await runtime.chat(chatPrompt, {
      chatMode: built.chatMode,
      targetWorkspaceRoot,
      workspace: targetWorkspaceRoot,
      projectRoot: targetWorkspaceRoot,
      env: buildChatEnvOverrides(built.request, built.chatMode),
    });
    const reply = extractChatReply(result);
    if (parsed.command === 'plan') {
      console.log(reply || 'No plan reply received.');
      console.log('');
      console.log(`Route: ${built.routing.laneLabel} | ${built.request.taskMode} | ${built.request.modelRole} role`);
      console.log(`Model: ${built.request.modelDisplayName || built.request.modelProfileId || built.request.baseModel || 'unresolved'}${built.request.providerSource ? ` via ${built.request.providerSource}` : ''}`);
      return result.ok === false ? 1 : 0;
    }
    console.log(reply || 'No reply received.');
    return result.ok === false ? 1 : 0;
  }

  if (parsed.command === 'edit' && built.routing.modeRequiresEditConfirmation && !parsed.yes) {
    console.log(`${modeConfig.label} mode is ready, but execution is still waiting for confirmation.`);
    console.log(`Route: ${built.routing.laneLabel} | ${built.request.taskMode} | ${built.request.modelRole} role`);
    console.log(`Next step: ${built.routing.suggestedNextAction}`);
    console.log('Run the same command again with --yes when you want the engine to execute it.');
    return 0;
  }

  if (built.request.taskMode === 'summarizer') {
    const report = buildSystemCheck(workspaceRoot);
    console.log(renderSystemCheck(report, { area: parsed.area || 'roadmap', compact: true }));
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
  console.log(`${modeConfig.label} mode completed.`);
  console.log(renderSnapshot(snapshot));
  return trackedRun?.state === 'pass' || trackedRun?.state === 'skipped' ? 0 : 1;
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
  built.request.taskMode = 'repair';
  built.request.laneId = 'repair-fast';
  built.request.laneLabel = 'Repair fast';
  built.request.modelRole = resolveExecutionModelRole({
    taskMode: 'repair',
    action: built.request.action,
    laneId: 'repair-fast',
  });
  const runtime = new SharedAgentRuntime({ workspaceRoot: parsed.workspaceRoot });
  const targetWorkspaceRoot = parsed.labRoot || parsed.workspaceRoot;
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
  buildGroundedChatPrompt,
  buildLiveStateSummary,
  buildTerminalRequest,
  buildChatEnvOverrides,
  extractChatReply,
  parseCliArgs,
  renderGitStatus,
  renderModelLifecycleStatus,
  renderPreflight,
  renderSnapshot,
};
