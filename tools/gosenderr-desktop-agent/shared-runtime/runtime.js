'use strict';

const EventEmitter = require('events');
const { RUN_STATES, DEFAULTS } = require('./constants');
const {
  readJsonFile,
  writeJsonFileAtomic,
  randomId,
  nowIso,
  parseFailureLocationsFromChecks,
} = require('./utils');
const { runPreflight } = require('./preflight');
const { AgentRuntimeClient } = require('./agent-runtime-client');

function normalizeRecoveredRun(run) {
  if (!run || typeof run !== 'object') {
    return run;
  }
  const logTail = String(run.logTail || '');
  const skippedDone = /Skipping BAT<\d+>.*status is DONE/i.test(logTail);
  if (!skippedDone) {
    return run;
  }
  return {
    ...run,
    state: RUN_STATES.PASS,
    checks: [],
    locations: [],
    artifactPaths: [],
  };
}

function isSkippedDoneLog(text) {
  return /Skipping BAT<\d+>.*status is DONE/i.test(String(text || ''));
}

class SharedAgentRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workspaceRoot = options.workspaceRoot || '';
    this.pythonRelative = options.pythonRelative || DEFAULTS.PYTHON_RELATIVE;
    this.client = new AgentRuntimeClient({
      workspaceRoot: this.workspaceRoot,
      pythonRelative: this.pythonRelative,
    });
    this.runs = new Map();
    this.processes = new Map();
    this.history = [];
    this.runtimeStatePath = '';
    if (this.workspaceRoot) {
      this._setRuntimePath();
      this._loadRecoveryState();
    }
  }

  setWorkspaceRoot(workspaceRoot) {
    if (!workspaceRoot || workspaceRoot === this.workspaceRoot) {
      return;
    }
    this.workspaceRoot = workspaceRoot;
    this.client.setWorkspaceRoot(workspaceRoot);
    this._setRuntimePath();
    this._loadRecoveryState();
  }

  _setRuntimePath() {
    this.runtimeStatePath = require('path').join(this.workspaceRoot, DEFAULTS.RUNTIME_STATE_FILE);
  }

  _loadRecoveryState() {
    const payload = readJsonFile(this.runtimeStatePath, null);
    if (!payload || !Array.isArray(payload.runs)) {
      return;
    }
    this.history = payload.runs.slice(0, DEFAULTS.RUN_HISTORY_LIMIT).map(normalizeRecoveredRun);
    this.runs.clear();
    for (const run of this.history) {
      if (run && run.runId) {
        this.runs.set(run.runId, run);
      }
    }
  }

  _persistRecoveryState() {
    if (!this.runtimeStatePath) {
      return;
    }
    const snapshot = {
      updatedAt: nowIso(),
      runs: this.history.slice(0, DEFAULTS.RUN_HISTORY_LIMIT),
    };
    writeJsonFileAtomic(this.runtimeStatePath, snapshot);
  }

  _recordRun(snapshot) {
    this.runs.set(snapshot.runId, snapshot);
    this.history = [snapshot, ...this.history.filter((item) => item.runId !== snapshot.runId)].slice(0, DEFAULTS.RUN_HISTORY_LIMIT);
    this._persistRecoveryState();
  }

  _emitRunEvent(event) {
    this.emit('run-event', event);
  }

  _emitSchedulerEvent(event) {
    this.emit('scheduler-event', event);
  }

  cancelLatest() {
    const activeRuns = Array.from(this.processes.keys());
    if (activeRuns.length === 0) {
      return { ok: false, message: 'Run not active.' };
    }
    return this.cancel(activeRuns[activeRuns.length - 1]);
  }

  getStatus(runId = null) {
    if (runId) {
      return this.runs.get(runId) || null;
    }
    return {
      activeRuns: Array.from(this.processes.keys()),
      latest: this.history.slice(0, 30),
    };
  }

  getRecoveryState() {
    return {
      runs: this.history.slice(0, 30),
      activeRuns: Array.from(this.processes.keys()),
    };
  }

  cancel(runId) {
    const proc = this.processes.get(runId);
    if (!proc) {
      return { ok: false, message: 'Run not active.' };
    }
    proc.__cancelRequested = true;
    return proc.cancel();
  }

  runPreflight(workspaceRoot, options = {}) {
    const root = workspaceRoot || this.workspaceRoot;
    return runPreflight(root, options);
  }

  chat(prompt, context = {}) {
    this.client.setWorkspaceRoot(this.workspaceRoot);
    return this.client.chat(prompt, context);
  }

  startScheduler(options = {}) {
    this.client.setWorkspaceRoot(options.workspace || this.workspaceRoot);
    const status = this.client.startScheduler(options, {
      onStdout: (text) => {
        this._emitSchedulerEvent({ type: 'log', stream: 'stdout', text });
      },
      onStderr: (text) => {
        this._emitSchedulerEvent({ type: 'log', stream: 'stderr', text });
      },
    });
    this._emitSchedulerEvent({ type: 'state', running: !!status.running, message: status.message, pid: status.pid || null });
    const active = this.client.scheduler;
    if (active && active.promise) {
      active.promise.then(({ exitCode, signal }) => {
        this._emitSchedulerEvent({
          type: 'state',
          running: false,
          message: `Autopilot scheduler stopped (code ${exitCode ?? 'n/a'}${signal ? `, signal ${signal}` : ''}).`,
          pid: null,
        });
      });
    }
    return status;
  }

  stopScheduler() {
    const status = this.client.stopScheduler();
    this._emitSchedulerEvent({ type: 'state', running: !!status.running, message: status.message, pid: status.pid || null });
    return status;
  }

  schedulerStatus() {
    return this.client.schedulerStatus();
  }

  run(request) {
    this.client.setWorkspaceRoot(request.workspace || this.workspaceRoot);
    const runId = request.runId || randomId('agent');
    const startedAt = nowIso();
    const runSnapshot = {
      runId,
      action: request.action,
      ticket: request.ticket || '',
      state: RUN_STATES.RUNNING,
      label: request.label || request.action,
      startedAt,
      endedAt: null,
      exitCode: null,
      checks: [],
      locations: [],
      artifactPaths: [],
      logTail: '',
    };
    this._recordRun(runSnapshot);
    this._emitRunEvent({
      runId,
      state: RUN_STATES.RUNNING,
      timestamp: startedAt,
      label: runSnapshot.label,
      checks: [],
      locations: [],
      artifactPaths: [],
    });

    const operation = this.client.startAction(request, {
      onStdout: (text) => this._appendLog(runId, request.action, text),
      onStderr: (text) => this._appendLog(runId, request.action, text),
    });
    operation.__cancelRequested = false;
    this.processes.set(runId, operation);

    operation.promise.then(({ exitCode, result }) => {
      const current = this.runs.get(runId) || runSnapshot;
      const wasCancelled = !!operation.__cancelRequested;
      const skippedDone = Number(exitCode ?? 1) === 0 && isSkippedDoneLog(current.logTail);
      this.processes.delete(runId);
      current.endedAt = nowIso();
      current.exitCode = Number(exitCode ?? 1);
      current.checks = skippedDone ? [] : (Array.isArray(result?.checks) ? result.checks : []);
      current.locations = skippedDone
        ? []
        : (Array.isArray(result?.locations) ? result.locations : parseFailureLocationsFromChecks(current.checks));
      current.artifactPaths = skippedDone ? [] : (Array.isArray(result?.artifactPaths) ? result.artifactPaths : []);
      current.label = result?.label || current.label;
      if (wasCancelled) {
        current.state = RUN_STATES.CANCELLED;
      } else if (skippedDone) {
        current.state = RUN_STATES.PASS;
      } else {
        current.state = exitCode === 0 && result?.ok !== false ? RUN_STATES.PASS : RUN_STATES.FAIL;
      }
      this._recordRun(current);
      this._emitRunEvent({
        runId,
        state: current.state,
        timestamp: current.endedAt,
        label: current.label,
        exitCode: current.exitCode,
        checks: current.checks,
        locations: current.locations,
        artifactPaths: current.artifactPaths,
        boardUpdate: result?.artifact?.board_update || null,
        blockedReason: result?.artifact?.blocked_reason || '',
      });
    });

    return {
      runId,
      state: RUN_STATES.RUNNING,
      label: runSnapshot.label,
      artifactPaths: [],
    };
  }

  _appendLog(runId, fallbackLabel, text) {
    const current = this.runs.get(runId);
    if (!current) {
      return;
    }
    current.logTail = `${current.logTail || ''}${String(text || '')}`.slice(-100000);
    this._recordRun(current);
    this._emitRunEvent({
      runId,
      state: RUN_STATES.RUNNING,
      timestamp: nowIso(),
      label: current.label || fallbackLabel,
      logChunk: String(text || ''),
      checks: current.checks,
      locations: current.locations,
      artifactPaths: current.artifactPaths,
    });
  }
}

function normalizeTicket(value) {
  const match = String(value || '').match(/(?:BAT<)?(\d+)>?/i);
  return match ? match[1] : '';
}

module.exports = {
  SharedAgentRuntime,
  normalizeTicket,
};
