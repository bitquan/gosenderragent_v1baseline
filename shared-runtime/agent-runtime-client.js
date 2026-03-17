'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULTS } = require('./constants');
const { existsExecutable, readJsonFile } = require('./utils');
const { RUNTIME_ROOT } = require('../core/app-roots');

function canRunSystemCommand(command) {
  const text = String(command || '').trim();
  if (!text) {
    return false;
  }
  try {
    const result = childProcess.spawnSync(text, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  } catch (_error) {
    return false;
  }
}

function resolvePythonCandidates(workspaceRoot, pythonRelative, runtimeRoot) {
  const root = String(workspaceRoot || '').trim();
  const runtime = String(runtimeRoot || '').trim();
  const configuredRelative = String(pythonRelative || '').trim();
  const candidates = [];
  const pushCandidate = (value) => {
    const text = String(value || '').trim();
    if (text && !candidates.includes(text)) {
      candidates.push(text);
    }
  };

  if (root && configuredRelative) {
    pushCandidate(path.join(root, configuredRelative));
  }
  if (root) {
    pushCandidate(path.join(root, 'runtime', '.venv', 'Scripts', 'python.exe'));
    pushCandidate(path.join(root, 'runtime', '.venv', 'bin', 'python'));
    pushCandidate(path.join(root, 'backend', '.venv', 'Scripts', 'python.exe'));
    pushCandidate(path.join(root, 'backend', '.venv', 'bin', 'python'));
    pushCandidate(path.join(root, 'backend', 'virtualenv', 'Scripts', 'python.exe'));
    pushCandidate(path.join(root, 'backend', 'virtualenv', 'bin', 'python'));
  }
  if (runtime) {
    pushCandidate(path.join(runtime, '.venv', 'Scripts', 'python.exe'));
    pushCandidate(path.join(runtime, '.venv', 'bin', 'python'));
  }
  if (process.platform === 'win32') {
    pushCandidate(path.join(process.env.SystemRoot || 'C:\\Windows', 'py.exe'));
    pushCandidate('py.exe');
    pushCandidate('py');
    pushCandidate('python.exe');
  }
  pushCandidate(process.platform === 'win32' ? 'python.exe' : 'python3');
  pushCandidate('python3');
  pushCandidate('python');
  return candidates;
}

function resolvePythonCommand(workspaceRoot, pythonRelative, runtimeRoot) {
  const candidates = resolvePythonCandidates(workspaceRoot, pythonRelative, runtimeRoot);
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) || path.isAbsolute(candidate)) {
      if (existsExecutable(candidate)) {
        return candidate;
      }
      continue;
    }
    if (canRunSystemCommand(candidate)) {
      return candidate;
    }
  }
  return '';
}

function buildRuntimeStartFailure(message, extra = {}) {
  const summary = String(message || 'Python runtime is not available.').trim();
  const stderr = String(extra.stderr || summary).trim();
  const result = {
    ok: false,
    message: summary,
    summary,
    error: summary,
    errorCode: String(extra.errorCode || '').trim(),
    python: String(extra.python || '').trim(),
    runtimeAvailable: false,
  };
  return {
    ok: false,
    child: {
      pid: null,
      killed: false,
      exitCode: 1,
      kill() {
        return false;
      },
    },
    promise: Promise.resolve({
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr,
      result,
    }),
    cancel: () => ({
      ok: false,
      message: 'The Python runtime process never started.',
    }),
    message: summary,
  };
}

class AgentRuntimeClient {
  constructor(options = {}) {
    this.workspaceRoot = options.workspaceRoot || '';
    this.pythonRelative = options.pythonRelative || DEFAULTS.PYTHON_RELATIVE;
    this.runtimeRoot = options.runtimeRoot || RUNTIME_ROOT;
    this.scheduler = null;
  }

  setWorkspaceRoot(workspaceRoot) {
    if (workspaceRoot) {
      this.workspaceRoot = workspaceRoot;
    }
  }

  _resolvePython(workspaceRoot) {
    const root = workspaceRoot || this.workspaceRoot;
    return resolvePythonCommand(root, this.pythonRelative, this.runtimeRoot);
  }

  _spawn(command, payload = {}, handlers = {}) {
    const targetWorkspaceRoot = payload.targetWorkspaceRoot || payload.projectRoot || payload.workspace || this.workspaceRoot;
    const python = this._resolvePython(targetWorkspaceRoot);
    if (!python) {
      return buildRuntimeStartFailure(
        process.platform === 'win32'
          ? 'Python runtime is not available. Install Python or configure the repo virtual environment before running the engine.'
          : 'Python runtime is not available. Install Python or configure the repo virtual environment before running the engine.',
        {
          errorCode: 'PYTHON_NOT_FOUND',
        },
      );
    }
    const resultFile = path.join(
      os.tmpdir(),
      `gosenderr-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`,
    );
    const envOverrides = { ...(payload.envOverrides || {}) };
    const runtimePayload = {
      ...payload,
      targetWorkspaceRoot,
      projectRoot: payload.projectRoot || targetWorkspaceRoot,
      workspace: payload.workspace || targetWorkspaceRoot,
    };
    delete runtimePayload.envOverrides;
    const pythonPath = [this.runtimeRoot, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter);

    const args = [
      '-m',
      'backend.agent.runtime.runtime_api',
      command,
      '--payload-json',
      JSON.stringify(runtimePayload),
      '--result-file',
      resultFile,
    ];

    let child = null;
    try {
      child = childProcess.spawn(python, args, {
        cwd: this.runtimeRoot,
        env: {
          ...process.env,
          PYTHONPATH: pythonPath,
          PROJECT_ROOT: targetWorkspaceRoot || process.env.PROJECT_ROOT || '',
          ...envOverrides,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      return buildRuntimeStartFailure(
        `Could not start the Python runtime: ${String(error?.message || error)}`,
        {
          errorCode: String(error?.code || 'RUNTIME_SPAWN_FAILED'),
          python,
        },
      );
    }

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      const text = String(chunk || '');
      stdout += text;
      if (typeof handlers.onStdout === 'function') {
        handlers.onStdout(text);
      }
    });

    child.stderr?.on('data', (chunk) => {
      const text = String(chunk || '');
      stderr += text;
      if (typeof handlers.onStderr === 'function') {
        handlers.onStderr(text);
      }
    });

    const promise = new Promise((resolve) => {
      let settled = false;
      const finish = (payloadResult) => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          fs.rmSync(resultFile, { force: true });
        } catch (_err) {
          // ignore cleanup issues
        }
        resolve(payloadResult);
      };

      child.on('error', (error) => {
        const message = `Could not start the Python runtime: ${String(error?.message || error)}`;
        finish({
          exitCode: 1,
          signal: null,
          stdout,
          stderr: [stderr, message].filter(Boolean).join('\n').trim(),
          result: {
            ok: false,
            message,
            summary: message,
            error: message,
            errorCode: String(error?.code || 'RUNTIME_SPAWN_FAILED'),
            python,
            runtimeAvailable: false,
          },
        });
      });

      child.on('close', (exitCode, signal) => {
        const result = readJsonFile(resultFile, null);
        finish({
          exitCode: Number(exitCode ?? 1),
          signal: signal || null,
          stdout,
          stderr,
          result,
        });
      });
    });

    return {
      child,
      promise,
      cancel: () => {
        try {
          child.kill('SIGTERM');
          return { ok: true };
        } catch (err) {
          return { ok: false, message: String(err.message || err) };
        }
      },
    };
  }

  startAction(request, handlers = {}) {
    const targetWorkspaceRoot = request.targetWorkspaceRoot || request.projectRoot || request.workspace || this.workspaceRoot;
    return this._spawn('action', {
      request: {
        ...request,
        targetWorkspaceRoot,
        projectRoot: request.projectRoot || targetWorkspaceRoot,
        workspace: request.workspace || targetWorkspaceRoot,
      },
      targetWorkspaceRoot,
      projectRoot: request.projectRoot || targetWorkspaceRoot,
      workspace: request.workspace || targetWorkspaceRoot,
    }, handlers);
  }

  invoke(command, payload = {}, handlers = {}) {
    const targetWorkspaceRoot = payload.targetWorkspaceRoot || payload.projectRoot || payload.workspace || this.workspaceRoot;
    const operation = this._spawn(command, {
      ...payload,
      targetWorkspaceRoot,
      projectRoot: payload.projectRoot || targetWorkspaceRoot,
      workspace: payload.workspace || targetWorkspaceRoot,
    }, handlers);
    return operation.promise.then(({ exitCode, stdout, stderr, result }) => ({
      ok: exitCode === 0,
      exitCode,
      stdout,
      stderr,
      result,
    }));
  }

  chat(prompt, context = {}) {
    return this.invoke('chat', {
      prompt,
      context,
      envOverrides: context.env || {},
    }).then((response) => response.result || { ok: response.ok, reply: '' });
  }

  analyzeLogs(payload = {}) {
    return this.invoke('analyze-logs', payload).then((response) => response.result || { ok: response.ok });
  }

  train(payload = {}) {
    return this.invoke('train', payload).then((response) => response.result || { ok: response.ok });
  }

  startScheduler(payload = {}, handlers = {}) {
    if (this.scheduler && this.scheduler.child && this.scheduler.child.exitCode === null && !this.scheduler.child.killed) {
      return {
        ok: true,
        running: true,
        pid: this.scheduler.child.pid,
        message: `Autopilot scheduler is already running (pid ${this.scheduler.child.pid}).`,
      };
    }

    const targetWorkspaceRoot = payload.targetWorkspaceRoot || payload.projectRoot || payload.workspace || this.workspaceRoot;
    const operation = this._spawn('scheduler-start', {
      ...payload,
      targetWorkspaceRoot,
      projectRoot: payload.projectRoot || targetWorkspaceRoot,
      workspace: payload.workspace || targetWorkspaceRoot,
    }, handlers);
    if (operation.ok === false) {
      return {
        ok: false,
        running: false,
        pid: null,
        message: String(operation.message || 'Autopilot scheduler could not start because the Python runtime is unavailable.'),
      };
    }
    this.scheduler = operation;
    operation.promise.finally(() => {
      if (this.scheduler && this.scheduler.child === operation.child) {
        this.scheduler = null;
      }
    });
    return {
      ok: true,
      running: true,
      pid: operation.child.pid,
      message: `Autopilot scheduler started (pid ${operation.child.pid}).`,
    };
  }

  stopScheduler() {
    if (!this.scheduler || !this.scheduler.child || this.scheduler.child.exitCode !== null || this.scheduler.child.killed) {
      return { ok: true, running: false, message: 'Autopilot scheduler is not running.' };
    }
    try {
      this.scheduler.child.kill('SIGTERM');
    } catch (_err) {
      // best effort
    }
    return { ok: true, running: false, message: 'Autopilot scheduler stop signal sent.' };
  }

  schedulerStatus() {
    if (!this.scheduler || !this.scheduler.child || this.scheduler.child.exitCode !== null || this.scheduler.child.killed) {
      return {
        ok: true,
        running: false,
        pid: null,
        message: 'Autopilot scheduler is not running.',
      };
    }
    return {
      ok: true,
      running: true,
      pid: this.scheduler.child.pid,
      message: `Autopilot scheduler is running (pid ${this.scheduler.child.pid}).`,
    };
  }
}

module.exports = {
  AgentRuntimeClient,
  buildRuntimeStartFailure,
  canRunSystemCommand,
  resolvePythonCommand,
  resolvePythonCandidates,
};
