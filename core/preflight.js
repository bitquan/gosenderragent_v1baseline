'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { DEFAULTS } = require('./constants');
const { nowIso } = require('./utils');
const { resolvePythonCommand } = require('../shared-runtime/agent-runtime-client');

function runProbe(command, args, cwd) {
  try {
    const result = childProcess.spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 7000,
    });
    return {
      ok: result.status === 0,
      detail: (result.stdout || result.stderr || '').trim() || `exit=${result.status}`,
    };
  } catch (err) {
    return { ok: false, detail: String(err.message || err) };
  }
}

function addCheck(list, { name, ok, severity = 'blocking', detail = '' }) {
  list.push({ name, ok: !!ok, severity, detail });
}

function resolvePython(workspaceRoot, pythonRelative = DEFAULTS.PYTHON_RELATIVE) {
  return resolvePythonCommand(
    workspaceRoot,
    pythonRelative,
    path.join(workspaceRoot, 'runtime'),
  );
}

function runPreflight(workspaceRoot, options = {}) {
  const checks = [];
  const requireGh = !!options.requireGh;

  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
    addCheck(checks, {
      name: 'workspace',
      ok: false,
      severity: 'blocking',
      detail: 'workspace path does not exist',
    });
    return {
      generatedAt: nowIso(),
      workspaceRoot,
      checks,
      ready: false,
      blockingCount: 1,
      warningCount: 0,
    };
  }

  const pythonPath = resolvePython(workspaceRoot, options.pythonRelative || DEFAULTS.PYTHON_RELATIVE);
  addCheck(checks, {
    name: 'python runtime',
    ok: !!pythonPath,
    severity: 'blocking',
    detail: pythonPath,
  });

  addCheck(checks, {
    name: 'BAT board',
    ok: fs.existsSync(path.join(workspaceRoot, 'docs', 'BAT_FEATURE_BOARD.md')),
    severity: 'blocking',
    detail: 'docs/BAT_FEATURE_BOARD.md',
  });

  addCheck(checks, {
    name: 'assistant scripts',
    ok:
      fs.existsSync(path.join(workspaceRoot, 'runtime', 'backend', 'scripts', 'dev_assistant.py')) &&
      fs.existsSync(path.join(workspaceRoot, 'runtime', 'backend', 'scripts', 'solo_dev_assistant.py')),
    severity: 'blocking',
    detail: 'runtime/backend/scripts/dev_assistant.py + solo_dev_assistant.py',
  });

  addCheck(checks, {
    name: 'frontend deps',
    ok: fs.existsSync(path.join(workspaceRoot, 'frontend/node_modules')),
    severity: 'warning',
    detail: 'frontend/node_modules',
  });

  const gitProbe = runProbe('git', ['rev-parse', '--is-inside-work-tree'], workspaceRoot);
  addCheck(checks, {
    name: 'git workspace',
    ok: gitProbe.ok,
    severity: 'warning',
    detail: gitProbe.detail,
  });

  if (requireGh) {
    const ghProbe = runProbe('gh', ['auth', 'status'], workspaceRoot);
    addCheck(checks, {
      name: 'GitHub auth',
      ok: ghProbe.ok,
      severity: 'warning',
      detail: ghProbe.detail || 'gh auth status',
    });
  }

  const blockingCount = checks.filter((item) => item.severity === 'blocking' && !item.ok).length;
  const warningCount = checks.filter((item) => item.severity === 'warning' && !item.ok).length;

  return {
    generatedAt: nowIso(),
    workspaceRoot,
    checks,
    ready: blockingCount === 0,
    blockingCount,
    warningCount,
  };
}

module.exports = {
  runPreflight,
  resolvePython,
};
