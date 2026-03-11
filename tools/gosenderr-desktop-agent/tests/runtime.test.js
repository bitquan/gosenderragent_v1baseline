'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const events = require('events');
const childProcess = require('child_process');

const { SharedAgentRuntime } = require('../shared-runtime/runtime');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-agent-'));
  fs.mkdirSync(path.join(root, 'backend', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'backend', '.venv', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'assistant_runs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'backend', 'scripts', 'solo_dev_assistant.py'), '# stub\n');
  fs.writeFileSync(path.join(root, 'backend', '.venv', 'bin', 'python'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(root, 'backend', '.venv', 'bin', 'python'), 0o755);
  return root;
}

test('runtime ignores stale artifacts and treats skipped BAT runs as pass', async () => {
  const workspaceRoot = makeWorkspace();
  const artifactPath = path.join(workspaceRoot, 'docs', 'assistant_runs', 'BAT230_run.json');
  fs.writeFileSync(
    artifactPath,
    JSON.stringify({
      ticket: '230',
      command: 'run',
      generated_at: '2024-01-01T00:00:00.000Z',
      all_checks_passed: false,
      checks: [{ name: 'old failure', ok: false }],
    }),
  );

  const originalSpawn = childProcess.spawn;
  childProcess.spawn = () => {
    const proc = new events.EventEmitter();
    proc.stdout = new events.EventEmitter();
    proc.stderr = new events.EventEmitter();
    proc.kill = () => true;
    process.nextTick(() => {
      proc.stdout.emit('data', 'Skipping BAT<230>: status is DONE\n');
      proc.emit('close', 0);
    });
    return proc;
  };

  try {
    const runtime = new SharedAgentRuntime({
      workspaceRoot,
      pythonRelative: 'backend/.venv/bin/python',
    });
    const run = runtime.run({
      action: 'run',
      workspace: workspaceRoot,
      ticket: '230',
      profile: 'preview',
    });

    const finalEvent = await new Promise((resolve) => {
      runtime.on('run-event', (event) => {
        if (event.runId === run.runId && (event.state === 'pass' || event.state === 'fail')) {
          resolve(event);
        }
      });
    });

    assert.equal(finalEvent.state, 'pass');
  } finally {
    childProcess.spawn = originalSpawn;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('live skipped BAT run overrides failing result payload to pass', async () => {
  const workspaceRoot = makeWorkspace();
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = (_command, args) => {
    const proc = new events.EventEmitter();
    proc.stdout = new events.EventEmitter();
    proc.stderr = new events.EventEmitter();
    proc.kill = () => true;
    process.nextTick(() => {
      const resultFile = String(args[args.indexOf('--result-file') + 1] || '');
      fs.writeFileSync(resultFile, JSON.stringify({
        ok: false,
        checks: [{ name: 'stale failure', ok: false }],
        artifactPaths: [path.join(workspaceRoot, 'docs', 'assistant_runs', 'BAT230_run.json')],
        label: 'RUN BAT<230>',
      }));
      proc.stdout.emit('data', 'Skipping BAT<230>: status is DONE\n');
      proc.emit('close', 0);
    });
    return proc;
  };

  try {
    const runtime = new SharedAgentRuntime({
      workspaceRoot,
      pythonRelative: 'backend/.venv/bin/python',
    });
    const run = runtime.run({
      action: 'run',
      workspace: workspaceRoot,
      ticket: '230',
      profile: 'preview',
    });

    const finalEvent = await new Promise((resolve) => {
      runtime.on('run-event', (event) => {
        if (event.runId === run.runId && (event.state === 'pass' || event.state === 'fail')) {
          resolve(event);
        }
      });
    });

    assert.equal(finalEvent.state, 'pass');
    assert.deepEqual(finalEvent.checks, []);
    assert.deepEqual(finalEvent.locations, []);
    assert.deepEqual(finalEvent.artifactPaths, []);
  } finally {
    childProcess.spawn = originalSpawn;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('recovery state normalizes skipped BAT failures to pass', () => {
  const workspaceRoot = makeWorkspace();
  const runtimeStatePath = path.join(workspaceRoot, 'docs', 'assistant_runs', 'runtime_state.json');
  fs.writeFileSync(runtimeStatePath, JSON.stringify({
    updatedAt: '2026-03-11T18:38:17.587Z',
    runs: [
      {
        runId: 'agent_skip_old',
        action: 'run',
        ticket: '230',
        state: 'fail',
        label: 'RUN BAT<230>',
        startedAt: '2026-03-11T18:38:00.283Z',
        endedAt: '2026-03-11T18:38:00.386Z',
        exitCode: 0,
        checks: [{ name: 'frontend typecheck', ok: false }],
        locations: [{ path: 'frontend/foo.ts', line: 1 }],
        logTail: 'Skipping BAT<230>: status is DONE\n',
      },
    ],
  }));

  try {
    const runtime = new SharedAgentRuntime({
      workspaceRoot,
      pythonRelative: 'backend/.venv/bin/python',
    });
    const recovered = runtime.getStatus('agent_skip_old');
    assert.equal(recovered.state, 'pass');
    assert.deepEqual(recovered.checks, []);
    assert.deepEqual(recovered.locations, []);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
