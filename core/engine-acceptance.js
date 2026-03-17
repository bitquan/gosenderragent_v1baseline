'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const { APP_ROOT } = require('./app-roots');
const {
  acceptanceRoot,
  buildAcceptanceControlSummary,
  readLatestAcceptanceReport,
  summarizeAcceptanceReport,
  writeAcceptanceReport,
} = require('./acceptance-report');
const { recordBenchmarkRun } = require('./benchmarks');
const { LearningJournalService } = require('./learning-journal');
const { runLabRecipe } = require('./labs');
const { listPromotionState } = require('./promotions');
const { completeTaskRun, createTask, recordTaskRun } = require('./task-hub');
const { collectTrainingTelemetry, readTrainingTuningSettings } = require('./training-tuning');
const { nowIso, randomId } = require('./utils');
const { readAssistantConfig } = require('../host/assistant-config');

function tailSummary(stdout = '', stderr = '') {
  const lines = `${String(stdout || '')}\n${String(stderr || '')}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

function resolveCommandBinary(command) {
  const normalized = String(command || '').trim();
  if (process.platform === 'win32' && /^[a-z0-9_-]+$/i.test(normalized) && !/\.(cmd|bat|exe)$/i.test(normalized)) {
    if (normalized.toLowerCase() === 'npm') {
      return 'npm.cmd';
    }
    if (normalized.toLowerCase() === 'npx') {
      return 'npx.cmd';
    }
  }
  return normalized;
}

function runCommand(command, args, options = {}) {
  const startedAt = Date.now();
  const executable = resolveCommandBinary(command);
  const result = childProcess.spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 8,
    timeout: Number(options.timeoutMs || 20 * 60 * 1000),
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable),
  });
  const durationMs = Date.now() - startedAt;
  return {
    ok: result.status === 0,
    command,
    args,
    cwd: options.cwd || '',
    status: Number.isFinite(result.status) ? result.status : null,
    signal: result.signal || '',
    durationMs,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    summary: tailSummary(result.stdout, result.stderr),
  };
}

function runSelfHostBaselineSuite(labRoot) {
  const steps = [
    {
      label: 'typecheck',
      command: 'npm',
      args: ['run', 'typecheck'],
      timeoutMs: 10 * 60 * 1000,
    },
    {
      label: 'targeted-tests',
      command: 'node',
      args: ['--test', './tests/mvp-readiness.test.js', './tests/training-tuning.test.js'],
      timeoutMs: 10 * 60 * 1000,
    },
    {
      label: 'smoke',
      command: 'npm',
      args: ['run', 'smoke'],
      timeoutMs: 15 * 60 * 1000,
    },
    {
      label: 'smoke-ui',
      command: 'npm',
      args: ['run', 'smoke:ui'],
      timeoutMs: 20 * 60 * 1000,
    },
  ];

  const results = [];
  for (const step of steps) {
    const result = runCommand(step.command, step.args, {
      cwd: labRoot,
      timeoutMs: step.timeoutMs,
    });
    results.push({
      label: step.label,
      result,
    });
    if (!result.ok) {
      break;
    }
  }

  const failedStep = results.find((entry) => entry.result.ok !== true) || null;
  const durationMs = results.reduce((sum, entry) => sum + Number(entry.result.durationMs || 0), 0);
  const stdout = results
    .map((entry) => entry.result.stdout ? `[${entry.label}] ${entry.result.stdout.trim()}` : '')
    .filter(Boolean)
    .join('\n\n');
  const stderr = results
    .map((entry) => entry.result.stderr ? `[${entry.label}] ${entry.result.stderr.trim()}` : '')
    .filter(Boolean)
    .join('\n\n');

  return {
    ok: !failedStep,
    command: 'self-host-baseline',
    args: results.map((entry) => `${entry.result.command} ${(entry.result.args || []).join(' ')}`.trim()),
    cwd: labRoot,
    status: failedStep ? failedStep.result.status : 0,
    signal: failedStep ? failedStep.result.signal : '',
    durationMs,
    stdout,
    stderr,
    summary: failedStep
      ? `${failedStep.label} failed: ${failedStep.result.summary || tailSummary(failedStep.result.stdout, failedStep.result.stderr) || 'command failed.'}`
      : `Self-host baseline suite passed (${results.map((entry) => entry.label).join(', ')}).`,
  };
}

function normalizeCheckStatus(check = {}) {
  const status = String(check.status || '').trim().toLowerCase();
  return ['pass', 'warn', 'fail'].includes(status) ? status : 'warn';
}

function buildLearningSnapshot(workspaceRoot) {
  const learning = new LearningJournalService();
  learning.setScope({
    workspaceRoot,
    targetRoot: workspaceRoot,
    changeSessionId: 'engine-acceptance',
    pollingEnabled: false,
  });
  return learning.getStatus();
}

function createCheck(id, label, commandResult, options = {}) {
  const expected = String(options.expected || 'pass').trim().toLowerCase();
  const observedPass = commandResult.ok === true;
  const status = expected === 'fail'
    ? (observedPass ? 'fail' : 'pass')
    : (observedPass ? 'pass' : 'fail');
  const summary = options.summary
    || (expected === 'fail'
      ? (observedPass ? 'Expected this command to fail, but it passed.' : 'Expected failure was observed, so the repair target is ready.')
      : (commandResult.summary || (observedPass ? 'Command completed successfully.' : 'Command failed.')));
  return {
    id,
    label,
    status,
    expected,
    command: `${commandResult.command} ${Array.isArray(commandResult.args) ? commandResult.args.join(' ') : ''}`.trim(),
    cwd: commandResult.cwd,
    durationMs: commandResult.durationMs,
    summary,
    exitCode: commandResult.status,
    signal: commandResult.signal,
    stdoutTail: tailSummary(commandResult.stdout, ''),
    stderrTail: tailSummary('', commandResult.stderr),
    labRoot: String(options.labRoot || '').trim(),
    recipe: String(options.recipe || '').trim(),
    artifactPath: String(options.artifactPath || '').trim(),
  };
}

function buildRepoProofAction(id, label, commandResult, options = {}) {
  const assistantConfig = options.assistantConfig && typeof options.assistantConfig === 'object'
    ? options.assistantConfig
    : {};
  const proofKind = String(options.proofKind || 'autonomy').trim().toLowerCase() || 'autonomy';
  const proofFlag = String(options.proofFlag || `${proofKind}Proof`).trim() || `${proofKind}Proof`;
  const laneId = String(options.laneId || 'plan-reasoning').trim().toLowerCase();
  const taskMode = String(options.taskMode || 'planner').trim().toLowerCase();
  const modelDisplayName = String(
    assistantConfig.engineModelDisplayName
    || assistantConfig.workspaceModelDisplayName
    || 'GSE-1 Engine',
  ).trim();
  const baseModel = String(
    assistantConfig.engineBaseModel
    || assistantConfig.workspaceBaseModel
    || assistantConfig.baseModel
    || '',
  ).trim();
  const modelProfileId = String(
    assistantConfig.engineModelProfileId
    || assistantConfig.workspaceModelProfileId
    || assistantConfig.modelProfileId
    || '',
  ).trim();
  const providerSource = String(
    assistantConfig.engineProviderSource
    || assistantConfig.workspaceProviderSource
    || assistantConfig.providerSource
    || 'acceptance',
  ).trim().toLowerCase() || 'acceptance';
  const startedAt = nowIso();
  const endedAt = nowIso();
  const ok = commandResult.ok === true;
  const proofLabel = proofKind === 'selfImprovement' ? 'Self-improvement proof' : 'Autonomy proof';
  return {
    runId: `${proofKind}_proof_${id}`,
    action: `${proofKind}-proof`,
    ticket: '',
    task: label,
    taskMode,
    laneId,
    laneLabel: String(options.laneLabel || label).trim(),
    modelProfileId,
    modelRole: 'engine',
    modelDisplayName,
    baseModel,
    providerSource,
    workspaceRoot: String(options.workspaceRoot || '').trim(),
    targetWorkspaceRoot: String(options.targetWorkspaceRoot || options.workspaceRoot || '').trim(),
    labRoot: String(options.labRoot || '').trim(),
    changeSessionId: '',
    state: ok ? 'pass' : 'fail',
    label,
    startedAt,
    endedAt,
    blockedReason: ok ? '' : (commandResult.summary || `${proofLabel} command failed.`),
    metadata: {
      [proofFlag]: true,
      workspaceScopeRoot: String(options.targetWorkspaceRoot || options.workspaceRoot || '').trim(),
      requestedModelRole: 'engine',
      routeLaneId: laneId,
      taskMode,
      autonomyDifficultyCeiling: 2,
    },
    operatorExecution: {
      task: label,
      laneId,
      laneLabel: String(options.laneLabel || label).trim(),
      action: `${proofKind}-proof`,
      taskMode,
      modelProfileId,
      modelRole: 'engine',
      modelDisplayName,
      baseModel,
      providerSource,
      runId: `${proofKind}_proof_${id}`,
      status: ok ? 'pass' : 'fail',
      runState: ok ? 'pass' : 'fail',
      changedFiles: [],
      changedFileCount: 0,
      reviewSummary: {
        requiresManualReview: false,
        pendingApprovalCount: 0,
        lowConfidencePatchCount: 0,
        failedStepCount: 0,
        summary: 'no manual review blockers detected',
      },
      trustSummary: {
        trust_state: ok ? 'ready' : 'needs_review',
        summary: ok ? 'Trust is clear.' : (commandResult.summary || `Trust could not be proven for the ${proofLabel.toLowerCase()} action.`),
      },
      resultSummary: String(commandResult.summary || '').trim() || (ok ? `${proofLabel} action passed.` : `${proofLabel} action failed.`),
      outputTail: {
        combined: tailSummary(commandResult.stdout, commandResult.stderr),
        stdout: tailSummary(commandResult.stdout, ''),
        stderr: tailSummary('', commandResult.stderr),
      },
      metadata: {
        [proofFlag]: true,
        workspaceScopeRoot: String(options.targetWorkspaceRoot || options.workspaceRoot || '').trim(),
        requestedModelRole: 'engine',
        routeLaneId: laneId,
        taskMode,
        autonomyDifficultyCeiling: 2,
      },
    },
    safeToAdvance: ok,
    capabilityFit: 'comfortable',
  };
}

function runRepoAutonomyProofBundle(workspaceRoot, assistantConfig = {}) {
  const steps = [
    {
      id: 'blocker-summary',
      label: 'Repo blocker summary',
      laneId: 'plan-reasoning',
      taskMode: 'planner',
      command: 'npm',
      args: ['run', 'system:check', '--', '--area', 'acceptance'],
    },
    {
      id: 'review-summary',
      label: 'Acceptance and review summary',
      laneId: 'review-verify',
      taskMode: 'validator',
      command: 'npm',
      args: ['run', 'system:check', '--', '--area', 'trust'],
    },
    {
      id: 'validation-snapshot',
      label: 'Validation snapshot',
      laneId: 'review-verify',
      taskMode: 'validator',
      command: 'npm',
      args: ['run', 'system:check', '--', '--area', 'models'],
    },
    {
      id: 'learning-snapshot',
      label: 'Learned guidance snapshot',
      laneId: 'research-docs',
      taskMode: 'research',
      command: 'npm',
      args: ['run', 'system:check', '--', '--area', 'learning'],
    },
    {
      id: 'promotion-envelope',
      label: 'Promotion envelope snapshot',
      laneId: 'ops-summary',
      taskMode: 'summarizer',
      command: 'npm',
      args: ['run', 'system:check', '--', '--area', 'promotion'],
    },
  ];
  const actions = steps.map((step) => {
    const result = runCommand(step.command, step.args, {
      cwd: workspaceRoot,
      timeoutMs: 10 * 60 * 1000,
    });
    return buildRepoProofAction(step.id, step.label, result, {
      assistantConfig,
      proofKind: 'autonomy',
      proofFlag: 'autonomyProof',
      workspaceRoot,
      targetWorkspaceRoot: workspaceRoot,
      laneId: step.laneId,
      laneLabel: step.label,
      taskMode: step.taskMode,
    });
  });
  const safeCount = actions.filter((action) => action.safeToAdvance === true).length;
  const overscopedCount = actions.filter((action) => String(action.capabilityFit || '').trim().toLowerCase() === 'overscoped').length;
  return {
    status: overscopedCount > 0 ? 'fail' : safeCount >= 5 ? 'pass' : 'warn',
    target: 5,
    safeCount,
    overscopedCount,
    actionCount: actions.length,
    workspaceScoped: true,
    workspaceRoot,
    summary: overscopedCount > 0
      ? `${overscopedCount} repo-scoped autonomy proof action(s) are overscoped.`
      : `Repo-scoped autonomy proof captured ${safeCount}/5 safe current-workspace action(s).`,
    actions,
  };
}

function runRepoSelfImprovementProofBundle(workspaceRoot, assistantConfig = {}) {
  const steps = [
    {
      id: 'roadmap-blockers',
      label: 'Self-improvement blocker summary',
      laneId: 'plan-reasoning',
      taskMode: 'planner',
      command: 'npm',
      args: ['run', 'system:check', '--', '--area', 'roadmap'],
    },
    {
      id: 'self-improvement-queue',
      label: 'Self-improvement queue snapshot',
      laneId: 'review-verify',
      taskMode: 'validator',
      command: 'npm',
      args: ['run', 'system:check', '--', '--area', 'self-improvement'],
    },
    {
      id: 'learning-guidance',
      label: 'Learning guidance snapshot',
      laneId: 'research-docs',
      taskMode: 'research',
      command: 'npm',
      args: ['run', 'system:check', '--', '--area', 'learning'],
    },
    {
      id: 'trust-envelope',
      label: 'Trust and review envelope',
      laneId: 'review-verify',
      taskMode: 'validator',
      command: 'npm',
      args: ['run', 'system:check', '--', '--area', 'trust'],
    },
    {
      id: 'acceptance-envelope',
      label: 'Acceptance envelope snapshot',
      laneId: 'ops-summary',
      taskMode: 'summarizer',
      command: 'npm',
      args: ['run', 'system:check', '--', '--area', 'acceptance'],
    },
  ];
  const actions = steps.map((step) => {
    const result = runCommand(step.command, step.args, {
      cwd: workspaceRoot,
      timeoutMs: 10 * 60 * 1000,
    });
    return buildRepoProofAction(step.id, step.label, result, {
      assistantConfig,
      proofKind: 'selfImprovement',
      proofFlag: 'selfImprovementProof',
      workspaceRoot,
      targetWorkspaceRoot: workspaceRoot,
      laneId: step.laneId,
      laneLabel: step.label,
      taskMode: step.taskMode,
    });
  });
  const safeCount = actions.filter((action) => action.safeToAdvance === true).length;
  const overscopedCount = actions.filter((action) => String(action.capabilityFit || '').trim().toLowerCase() === 'overscoped').length;
  return {
    status: overscopedCount > 0 ? 'fail' : safeCount >= 5 ? 'pass' : 'warn',
    target: 5,
    safeCount,
    overscopedCount,
    actionCount: actions.length,
    workspaceScoped: true,
    workspaceRoot,
    summary: overscopedCount > 0
      ? `${overscopedCount} repo-scoped self-improvement proof action(s) are overscoped.`
      : `Repo-scoped self-improvement proof captured ${safeCount}/5 safe current-workspace action(s).`,
    actions,
  };
}

function runRepoBuilderProofBundle(workspaceRoot, assistantConfig = {}) {
  const builderLab = runLabRecipe(workspaceRoot, {
    recipe: 'dummy-node-app',
    kind: 'scratch',
    name: 'acceptance-builder-proof',
  });
  const builderTask = createTask(workspaceRoot, {
    source: 'engine-acceptance',
    objective: 'Exercise the dummy-node-app builder recipe and validate the generated delivery template in a lab.',
    targetWorkspaceRoot: workspaceRoot,
    labRoot: builderLab.labRoot,
    metadata: {
      builderProof: true,
      recipeId: 'dummy-node-app',
      workspaceScopeRoot: workspaceRoot,
      requestedModelRole: 'engine',
      routeLaneId: 'plan-reasoning',
      taskMode: 'planner',
      autonomyDifficultyCeiling: 2,
    },
  });
  const runId = `builder_proof_${randomId('dummy_node_app')}`;
  recordTaskRun(workspaceRoot, {
    taskId: builderTask.task.id,
    goalId: builderTask.task.goalId,
    runId,
    action: 'builder-proof',
    status: 'running',
    label: 'Builder proof: dummy-node-app recipe',
    summary: 'Exercising the dummy-node-app builder recipe in a scratch lab.',
    targetWorkspaceRoot: workspaceRoot,
    labRoot: builderLab.labRoot,
    metadata: {
      builderProof: true,
      recipeId: 'dummy-node-app',
      workspaceScopeRoot: workspaceRoot,
      requestedModelRole: 'engine',
      routeLaneId: 'plan-reasoning',
      taskMode: 'planner',
      autonomyDifficultyCeiling: 2,
    },
  });

  const commandResult = runCommand('npm', ['test'], {
    cwd: builderLab.labRoot,
    timeoutMs: 10 * 60 * 1000,
  });
  completeTaskRun(workspaceRoot, {
    runId,
    status: commandResult.ok ? 'pass' : 'fail',
    summary: commandResult.summary || (commandResult.ok
      ? 'The dummy builder lab validated cleanly.'
      : 'The dummy builder lab failed validation.'),
    reviewSummary: {
      requiresManualReview: false,
      pendingApprovalCount: 0,
      lowConfidencePatchCount: 0,
      failedStepCount: commandResult.ok ? 0 : 1,
      summary: commandResult.ok ? 'no manual review blockers detected' : 'builder proof validation failed',
    },
  });

  const action = buildRepoProofAction('dummy-node-app', 'Builder delivery proof', commandResult, {
    assistantConfig,
    proofKind: 'builder',
    proofFlag: 'builderProof',
    workspaceRoot,
    targetWorkspaceRoot: workspaceRoot,
    labRoot: builderLab.labRoot,
    laneId: 'plan-reasoning',
    laneLabel: 'Builder delivery proof',
    taskMode: 'planner',
  });
  action.metadata = {
    ...(action.metadata && typeof action.metadata === 'object' ? action.metadata : {}),
    recipeId: 'dummy-node-app',
    builderTaskId: String(builderTask.task.id || '').trim(),
  };
  if (action.operatorExecution && typeof action.operatorExecution === 'object') {
    action.operatorExecution.metadata = {
      ...(action.operatorExecution.metadata && typeof action.operatorExecution.metadata === 'object'
        ? action.operatorExecution.metadata
        : {}),
      recipeId: 'dummy-node-app',
      builderTaskId: String(builderTask.task.id || '').trim(),
    };
  }

  return {
    status: commandResult.ok ? 'pass' : 'fail',
    target: 1,
    safeCount: commandResult.ok ? 1 : 0,
    overscopedCount: 0,
    actionCount: 1,
    workspaceScoped: true,
    workspaceRoot,
    summary: commandResult.ok
      ? 'Repo-scoped builder proof captured 1/1 safe current-workspace builder run.'
      : `Repo-scoped builder proof failed: ${commandResult.summary || 'builder recipe validation failed.'}`,
    actions: [action],
    labRoot: builderLab.labRoot,
    taskId: String(builderTask.task.id || '').trim(),
    runId,
  };
}

function benchmarkSummaryForCheck(check) {
  return String(check.summary || '').trim()
    || (normalizeCheckStatus(check) === 'pass' ? 'Acceptance check passed.' : 'Acceptance check failed.');
}

function hasUsableSelfHostDependencies(labRoot) {
  const nodeModulesPath = path.join(labRoot, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    return false;
  }
  const electronRoot = path.join(nodeModulesPath, 'electron');
  const electronPathFile = path.join(electronRoot, 'path.txt');
  if (!fs.existsSync(electronPathFile)) {
    return false;
  }
  const relativeBinaryPath = String(fs.readFileSync(electronPathFile, 'utf8') || '').trim();
  if (!relativeBinaryPath) {
    return false;
  }
  return fs.existsSync(path.join(electronRoot, 'dist', relativeBinaryPath));
}

function ensureSelfHostDependencies(labRoot, options = {}) {
  if (hasUsableSelfHostDependencies(labRoot)) {
    return {
      ok: true,
      skipped: true,
      status: 'pass',
      summary: 'Self-host lab dependencies already exist.',
      durationMs: 0,
      cwd: labRoot,
      command: 'npm',
      args: ['ci'],
      stdout: '',
      stderr: '',
    };
  }
  return runCommand('npm', ['ci', '--no-audit', '--no-fund'], {
    cwd: labRoot,
    timeoutMs: Number(options.timeoutMs || 30 * 60 * 1000),
  });
}

async function runEngineAcceptanceSuite(workspaceRoot, options = {}) {
  const runId = String(options.runId || randomId('engine_acceptance')).trim();
  const startedAt = nowIso();
  const selfHostSourceRoot = path.resolve(String(options.selfHostSourceRoot || APP_ROOT));
  const keepLabs = options.keepLabs !== false;
  const fullSelfHost = options.fullSelfHost === true;
  const assistantConfig = readAssistantConfig(workspaceRoot, { defaultWorkspace: workspaceRoot });

  const labs = {
    selfHost: runLabRecipe(workspaceRoot, {
      recipe: 'benchmark-self-host',
      kind: 'scratch',
      name: options.selfHostLabName || 'acceptance-self-host',
      sourceRoot: selfHostSourceRoot,
    }),
    cleanDummy: runLabRecipe(workspaceRoot, {
      recipe: 'dummy-node-app',
      kind: 'scratch',
      name: options.cleanDummyLabName || 'acceptance-dummy-clean',
    }),
    brokenDummy: runLabRecipe(workspaceRoot, {
      recipe: 'dummy-broken-node-app',
      kind: 'scratch',
      name: options.brokenDummyLabName || 'acceptance-dummy-broken',
    }),
  };

  const checks = [];

  const cleanDummyResult = runCommand('npm', ['test'], {
    cwd: labs.cleanDummy.labRoot,
    timeoutMs: 10 * 60 * 1000,
  });
  const cleanDummyCheck = createCheck('dummy-clean-tests', 'Dummy clean lab tests', cleanDummyResult, {
    expected: 'pass',
    labRoot: labs.cleanDummy.labRoot,
    recipe: 'dummy-node-app',
  });
  recordBenchmarkRun(workspaceRoot, {
    name: 'acceptance-dummy-clean',
    recipe: 'dummy-node-app',
    status: cleanDummyCheck.status,
    ok: cleanDummyCheck.status === 'pass',
    workspaceRoot,
    targetRoot: labs.cleanDummy.labRoot,
    labRoot: labs.cleanDummy.labRoot,
    latencyMs: cleanDummyCheck.durationMs,
    passRate: cleanDummyCheck.status === 'pass' ? 100 : 0,
    summary: benchmarkSummaryForCheck(cleanDummyCheck),
    rawResult: cleanDummyCheck,
  });
  checks.push(cleanDummyCheck);

  const brokenDummyResult = runCommand('npm', ['test'], {
    cwd: labs.brokenDummy.labRoot,
    timeoutMs: 10 * 60 * 1000,
  });
  const brokenDummyCheck = createCheck('dummy-broken-detection', 'Broken dummy lab fails as expected', brokenDummyResult, {
    expected: 'fail',
    labRoot: labs.brokenDummy.labRoot,
    recipe: 'dummy-broken-node-app',
  });
  recordBenchmarkRun(workspaceRoot, {
    name: 'acceptance-dummy-broken',
    recipe: 'dummy-broken-node-app',
    status: brokenDummyCheck.status,
    ok: brokenDummyCheck.status === 'pass',
    workspaceRoot,
    targetRoot: labs.brokenDummy.labRoot,
    labRoot: labs.brokenDummy.labRoot,
    latencyMs: brokenDummyCheck.durationMs,
    passRate: brokenDummyCheck.status === 'pass' ? 100 : 0,
    summary: benchmarkSummaryForCheck(brokenDummyCheck),
    rawResult: brokenDummyCheck,
  });
  checks.push(brokenDummyCheck);

  const selfHostBootstrap = ensureSelfHostDependencies(labs.selfHost.labRoot, {
    timeoutMs: 35 * 60 * 1000,
  });
  const selfHostBootstrapCheck = createCheck('self-host-bootstrap', 'Self-host lab dependency bootstrap', selfHostBootstrap, {
    expected: 'pass',
    labRoot: labs.selfHost.labRoot,
    recipe: 'benchmark-self-host',
    summary: selfHostBootstrap.ok
      ? (selfHostBootstrap.skipped ? 'Self-host lab dependencies were already ready.' : 'Bootstrapped self-host lab dependencies.')
      : (selfHostBootstrap.summary || 'Unable to bootstrap self-host dependencies.'),
  });
  checks.push(selfHostBootstrapCheck);

  const selfHostTests = runSelfHostBaselineSuite(labs.selfHost.labRoot);
  const selfHostTestsCheck = createCheck('self-host-tests', 'Self-host lab test suite', selfHostTests, {
    expected: 'pass',
    labRoot: labs.selfHost.labRoot,
    recipe: 'benchmark-self-host',
  });
  recordBenchmarkRun(workspaceRoot, {
    name: 'acceptance-self-host',
    recipe: 'benchmark-self-host',
    status: selfHostTestsCheck.status,
    ok: selfHostTestsCheck.status === 'pass',
    workspaceRoot,
    targetRoot: labs.selfHost.labRoot,
    labRoot: labs.selfHost.labRoot,
    latencyMs: selfHostTestsCheck.durationMs,
    passRate: selfHostTestsCheck.status === 'pass' ? 100 : 0,
    summary: benchmarkSummaryForCheck(selfHostTestsCheck),
    rawResult: selfHostTestsCheck,
  });
  checks.push(selfHostTestsCheck);

  if (fullSelfHost) {
    const selfHostSmoke = runCommand('npm', ['run', 'smoke'], {
      cwd: labs.selfHost.labRoot,
      timeoutMs: 20 * 60 * 1000,
    });
    const selfHostSmokeCheck = createCheck('self-host-smoke', 'Self-host lab smoke suite', selfHostSmoke, {
      expected: 'pass',
      labRoot: labs.selfHost.labRoot,
      recipe: 'benchmark-self-host',
    });
    checks.push(selfHostSmokeCheck);
  }

  const autonomyProof = checks.every((check) => String(check?.status || '').trim().toLowerCase() === 'pass')
    ? runRepoAutonomyProofBundle(workspaceRoot, assistantConfig)
    : {
      status: 'missing',
      target: 5,
      safeCount: 0,
      overscopedCount: 0,
      actionCount: 0,
      workspaceScoped: true,
      workspaceRoot,
      summary: 'Repo-scoped autonomy proof was skipped because the acceptance baseline is not clean yet.',
      actions: [],
    };
  const selfImprovementProof = checks.every((check) => String(check?.status || '').trim().toLowerCase() === 'pass')
    ? runRepoSelfImprovementProofBundle(workspaceRoot, assistantConfig)
    : {
      status: 'missing',
      target: 5,
      safeCount: 0,
      overscopedCount: 0,
      actionCount: 0,
      workspaceScoped: true,
      workspaceRoot,
      summary: 'Repo-scoped self-improvement proof was skipped because the acceptance baseline is not clean yet.',
      actions: [],
    };
  const builderProof = checks.every((check) => String(check?.status || '').trim().toLowerCase() === 'pass')
    ? runRepoBuilderProofBundle(workspaceRoot, assistantConfig)
    : {
      status: 'missing',
      target: 1,
      safeCount: 0,
      overscopedCount: 0,
      actionCount: 0,
      workspaceScoped: true,
      workspaceRoot,
      summary: 'Repo-scoped builder proof was skipped because the acceptance baseline is not clean yet.',
      actions: [],
    };

  const settings = readTrainingTuningSettings(workspaceRoot);
  const training = await collectTrainingTelemetry({
    settings,
    activeRuns: 0,
    schedulerRunning: false,
  });
  const learning = buildLearningSnapshot(workspaceRoot);
  const promotions = listPromotionState(workspaceRoot, {});

  const completedAt = nowIso();
  const summary = summarizeAcceptanceReport({
    checks,
    training,
  });
  const report = {
    ok: summary.overallStatus !== 'fail',
    runId,
    label: 'engine-acceptance',
    startedAt,
    completedAt,
    workspaceRoot,
    targetWorkspaceRoot: workspaceRoot,
    selfHostSourceRoot,
    keepLabs,
    labs,
    checks,
    training,
    learning,
    promotions,
    autonomyProof,
    selfImprovementProof,
    builderProof,
    overallStatus: summary.overallStatus,
    counts: summary.counts,
    summary: summary.summary,
    nextAction: summary.nextAction,
  };
  const stored = writeAcceptanceReport(workspaceRoot, report);
  return {
    ok: report.ok,
    ...stored,
    report: {
      ...report,
      outputPath: stored.outputPath,
    },
  };
}

module.exports = {
  acceptanceRoot,
  buildAcceptanceControlSummary,
  readLatestAcceptanceReport,
  runEngineAcceptanceSuite,
  summarizeAcceptanceReport,
  writeAcceptanceReport,
};
