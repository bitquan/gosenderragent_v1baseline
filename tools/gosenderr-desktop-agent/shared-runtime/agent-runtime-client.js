'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULTS } = require('./constants');
const { existsExecutable, readJsonFile } = require('./utils');

class AgentRuntimeClient {
  constructor(options = {}) {
    this.workspaceRoot = options.workspaceRoot || '';
    this.pythonRelative = options.pythonRelative || DEFAULTS.PYTHON_RELATIVE;
    this.scheduler = null;
  }

  setWorkspaceRoot(workspaceRoot) {
    if (workspaceRoot) {
      this.workspaceRoot = workspaceRoot;
    }
  }

  _resolvePython(workspaceRoot) {
    const root = workspaceRoot || this.workspaceRoot;
    const candidate = path.join(root, this.pythonRelative);
    if (existsExecutable(candidate)) {
      return candidate;
    }
    return 'python3';
  }

  _spawn(command, payload = {}, handlers = {}) {
    const workspaceRoot = payload.workspace || this.workspaceRoot;
    const python = this._resolvePython(workspaceRoot);
    const resultFile = path.join(
      os.tmpdir(),
      `gosenderr-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`,
    );
    const envOverrides = { ...(payload.envOverrides || {}) };
    const runtimePayload = { ...payload };
    delete runtimePayload.envOverrides;

    const args = [
      '-m',
      'backend.agent.runtime.runtime_api',
      command,
      '--payload-json',
      JSON.stringify(runtimePayload),
      '--result-file',
      resultFile,
    ];

    const child = childProcess.spawn(python, args, {
      cwd: workspaceRoot,
      env: { ...process.env, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = String(chunk || '');
      stdout += text;
      if (typeof handlers.onStdout === 'function') {
        handlers.onStdout(text);
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = String(chunk || '');
      stderr += text;
      if (typeof handlers.onStderr === 'function') {
        handlers.onStderr(text);
      }
    });

    const promise = new Promise((resolve) => {
      child.on('close', (exitCode, signal) => {
        const result = readJsonFile(resultFile, null);
        try {
          fs.rmSync(resultFile, { force: true });
        } catch (_err) {
          // ignore cleanup issues
        }
        resolve({
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
    return this._spawn('action', { request, workspace: this.workspaceRoot }, handlers);
  }

  invoke(command, payload = {}, handlers = {}) {
    const operation = this._spawn(command, { ...payload, workspace: payload.workspace || this.workspaceRoot }, handlers);
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

    const operation = this._spawn('scheduler-start', { ...payload, workspace: payload.workspace || this.workspaceRoot }, handlers);
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
};
