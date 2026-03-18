'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const { getConfiguredAssistantBenchmarkRoot } = require('./assistant-paths');

function nowIso() {
  return new Date().toISOString();
}

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
    if (normalized.toLowerCase() === 'yarn') {
      return 'yarn.cmd';
    }
    if (normalized.toLowerCase() === 'pnpm') {
      return 'pnpm.cmd';
    }
  }
  return normalized;
}

function normalizeValidationArgs(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '')).filter(Boolean) : [];
}

function readPackageJson(targetRoot) {
  const filePath = path.join(String(targetRoot || '').trim(), 'package.json');
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function inferValidationPackageManager(targetRoot) {
  const root = String(targetRoot || '').trim();
  if (!root) {
    return 'npm';
  }
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (fs.existsSync(path.join(root, 'yarn.lock'))) {
    return 'yarn';
  }
  return 'npm';
}

function buildBenchmarkValidationPlan(targetRoot, payload = {}, options = {}) {
  const validationPayload = payload.validation && typeof payload.validation === 'object' ? payload.validation : {};
  const required = validationPayload.required !== undefined
    ? validationPayload.required === true
    : (options.required !== false);
  const cwd = String(validationPayload.cwd || payload.validationCwd || targetRoot || '').trim();
  const shellCommand = String(validationPayload.shellCommand || payload.validationShellCommand || '').trim();
  const explicitCommand = String(validationPayload.command || payload.validationCommand || '').trim();
  const explicitArgs = normalizeValidationArgs(validationPayload.args || payload.validationArgs);

  if (shellCommand) {
    return {
      required,
      ready: true,
      inferred: false,
      shellCommand,
      command: '',
      args: [],
      cwd,
      label: shellCommand,
    };
  }

  if (explicitCommand) {
    return {
      required,
      ready: true,
      inferred: false,
      shellCommand: '',
      command: explicitCommand,
      args: explicitArgs,
      cwd,
      label: [explicitCommand, ...explicitArgs].join(' ').trim(),
    };
  }

  const packageJson = readPackageJson(cwd);
  if (packageJson?.scripts && typeof packageJson.scripts.test === 'string' && String(packageJson.scripts.test).trim()) {
    const manager = inferValidationPackageManager(cwd);
    return {
      required,
      ready: true,
      inferred: true,
      shellCommand: '',
      command: manager,
      args: ['test'],
      cwd,
      label: `${manager} test`,
    };
  }

  return {
    required,
    ready: false,
    inferred: false,
    shellCommand: '',
    command: '',
    args: [],
    cwd,
    label: '',
    summary: required
      ? 'No validation command was configured or inferred for this benchmark target.'
      : 'Validation was skipped for this benchmark target.',
  };
}

function runBenchmarkValidation(targetRoot, payload = {}, options = {}) {
  const plan = buildBenchmarkValidationPlan(targetRoot, payload, options);
  if (!plan.required) {
    return {
      ...plan,
      ok: true,
      skipped: true,
      durationMs: 0,
      status: 0,
      signal: '',
      stdout: '',
      stderr: '',
      summary: plan.summary || 'Validation was skipped for this benchmark target.',
    };
  }
  if (!plan.ready) {
    return {
      ...plan,
      ok: false,
      skipped: false,
      durationMs: 0,
      status: null,
      signal: '',
      stdout: '',
      stderr: '',
      summary: plan.summary || 'No validation command was configured or inferred for this benchmark target.',
    };
  }

  const startedAt = Date.now();
  let result;
  if (plan.shellCommand) {
    if (process.platform === 'win32') {
      result = childProcess.spawnSync('cmd.exe', ['/d', '/s', '/c', plan.shellCommand], {
        cwd: plan.cwd || targetRoot,
        env: options.env || process.env,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 8,
        timeout: Number(options.timeoutMs || payload.validationTimeoutMs || 10 * 60 * 1000),
        windowsHide: true,
      });
    } else {
      result = childProcess.spawnSync('sh', ['-lc', plan.shellCommand], {
        cwd: plan.cwd || targetRoot,
        env: options.env || process.env,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 8,
        timeout: Number(options.timeoutMs || payload.validationTimeoutMs || 10 * 60 * 1000),
      });
    }
  } else {
    const executable = resolveCommandBinary(plan.command);
    result = childProcess.spawnSync(executable, plan.args, {
      cwd: plan.cwd || targetRoot,
      env: options.env || process.env,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 8,
      timeout: Number(options.timeoutMs || payload.validationTimeoutMs || 10 * 60 * 1000),
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable),
      windowsHide: true,
    });
  }

  const durationMs = Date.now() - startedAt;
  const stdout = String(result?.stdout || '');
  const stderr = String(result?.stderr || '');
  const summary = tailSummary(stdout, stderr)
    || (result?.status === 0 ? `Validation passed: ${plan.label}` : `Validation failed: ${plan.label}`);

  return {
    ...plan,
    ok: result?.status === 0,
    skipped: false,
    durationMs,
    status: Number.isFinite(result?.status) ? result.status : null,
    signal: result?.signal || '',
    stdout,
    stderr,
    summary,
  };
}

function finalizeBenchmarkOutcome(input = {}) {
  const status = String(input.status || 'fail').trim().toLowerCase() || 'fail';
  const summary = String(input.summary || '').trim();
  const validationResult = input.validationResult && typeof input.validationResult === 'object'
    ? input.validationResult
    : null;
  if (!validationResult) {
    return {
      status,
      ok: status === 'pass',
      summary,
    };
  }
  if (validationResult.required && validationResult.ok !== true) {
    return {
      status: 'fail',
      ok: false,
      summary: validationResult.summary || summary || 'Benchmark validation failed.',
    };
  }
  return {
    status,
    ok: status === 'pass',
    summary: summary || validationResult.summary || 'Benchmark run completed.',
  };
}

function ensureBenchmarkRoot(workspaceRoot) {
  const root = getConfiguredAssistantBenchmarkRoot(workspaceRoot);
  if (!root) {
    throw new Error('assistant_benchmark_root is not configured. Set assistant_artifacts_root or assistant_benchmark_root before running benchmarks.');
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function benchmarkFileName(name) {
  const safe = String(name || 'benchmark')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'benchmark';
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${safe}.json`;
}

function buildBenchmarkIdentity(payload = {}) {
  const wrappedProfileId = String(
    payload.wrappedProfileId
    || payload.modelProfileId
    || payload.profileId
    || '',
  ).trim();
  const baseModel = String(payload.baseModel || payload.model || '').trim();
  const providerSource = String(payload.providerSource || '').trim().toLowerCase();
  const taskMode = String(payload.taskMode || '').trim().toLowerCase();
  const modelRole = String(payload.modelRole || '').trim().toLowerCase();
  const id = String(payload.id || payload.outputPath || '').trim();
  return {
    id,
    modelRole,
    wrappedProfileId,
    baseModel,
    providerSource,
    taskMode,
    summary: [
      modelRole ? `role ${modelRole}` : '',
      id ? `bench ${id}` : '',
      wrappedProfileId ? `profile ${wrappedProfileId}` : '',
      providerSource && baseModel ? `${providerSource}:${baseModel}` : baseModel,
      taskMode ? `mode ${taskMode}` : '',
    ].filter(Boolean).join(' | '),
  };
}

function listBenchmarkRuns(workspaceRoot) {
  const root = getConfiguredAssistantBenchmarkRoot(workspaceRoot);
  if (!root || !fs.existsSync(root)) {
    return {
      ok: true,
      benchmarkRoot: root || '',
      runs: [],
      count: 0,
      configured: !!root,
    };
  }
  const runs = fs.readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const fullPath = path.join(root, name);
      try {
        const payload = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        return payload && typeof payload === 'object'
          ? {
              ...payload,
              outputPath: payload.outputPath || fullPath,
              benchmarkIdentity: buildBenchmarkIdentity({
                ...payload,
                outputPath: payload.outputPath || fullPath,
              }),
            }
          : null;
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => String(right.startedAt || '').localeCompare(String(left.startedAt || '')));

  return {
    ok: true,
    benchmarkRoot: root,
    runs,
    count: runs.length,
    configured: true,
  };
}

function recordBenchmarkRun(workspaceRoot, payload = {}) {
  const root = ensureBenchmarkRoot(workspaceRoot);
  const startedAt = String(payload.startedAt || nowIso());
  const completedAt = String(payload.completedAt || nowIso());
  const outputPath = path.join(root, benchmarkFileName(payload.name || payload.recipe || payload.taskId || 'run'));
  const benchmark = {
    id: String(payload.id || path.basename(outputPath, '.json')),
    name: String(payload.name || payload.recipe || payload.taskId || 'Benchmark').trim(),
    model: String(payload.model || '').trim(),
    modelProfileId: String(payload.modelProfileId || payload.profileId || '').trim(),
    wrappedProfileId: String(payload.wrappedProfileId || payload.modelProfileId || payload.profileId || '').trim(),
    baseModel: String(payload.baseModel || '').trim(),
    taskMode: String(payload.taskMode || '').trim().toLowerCase(),
    providerSource: String(payload.providerSource || '').trim().toLowerCase(),
    benchmarkTags: Array.isArray(payload.benchmarkTags) ? payload.benchmarkTags.map((item) => String(item || '').trim()).filter(Boolean) : [],
    runtime: String(payload.runtime || '').trim(),
    status: String(payload.status || (payload.ok === false ? 'fail' : 'pass')).trim(),
    ok: payload.ok !== false,
    startedAt,
    completedAt,
    taskId: String(payload.taskId || '').trim(),
    recipe: String(payload.recipe || '').trim(),
    workspaceRoot: String(payload.workspaceRoot || workspaceRoot || '').trim(),
    targetRoot: String(payload.targetRoot || '').trim(),
    labRoot: String(payload.labRoot || '').trim(),
    passRate: Number(payload.passRate || 0),
    latencyMs: Number(payload.latencyMs || 0),
    repairDepth: Number(payload.repairDepth || 0),
    approvalCount: Number(payload.approvalCount || 0),
    summary: String(payload.summary || '').trim(),
    artifactPaths: Array.isArray(payload.artifactPaths) ? payload.artifactPaths.map((item) => String(item || '')).filter(Boolean) : [],
    validationResult: payload.validationResult && typeof payload.validationResult === 'object'
      ? { ...payload.validationResult }
      : {},
    rawResult: payload.rawResult && typeof payload.rawResult === 'object' ? payload.rawResult : {},
    outputPath,
  };
  benchmark.benchmarkIdentity = buildBenchmarkIdentity(benchmark);
  fs.writeFileSync(outputPath, `${JSON.stringify(benchmark, null, 2)}\n`, 'utf8');
  return benchmark;
}

module.exports = {
  buildBenchmarkValidationPlan,
  buildBenchmarkIdentity,
  ensureBenchmarkRoot,
  finalizeBenchmarkOutcome,
  listBenchmarkRuns,
  recordBenchmarkRun,
  runBenchmarkValidation,
};
