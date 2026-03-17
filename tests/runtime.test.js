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

function waitForFinalRunEvent(runtime, runIdResolver) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for final run event: ${runIdResolver()}`));
    }, 2000);
    runtime.on('run-event', (event) => {
      const runId = runIdResolver();
      if (runId && event.runId === runId && (event.state === 'skipped' || event.state === 'fail' || event.state === 'pass')) {
        clearTimeout(timer);
        resolve(event);
      }
    });
  });
}

test('runtime ignores stale artifacts and treats skipped BAT runs as skipped', async () => {
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
    let runId = '';
    const finalEventPromise = waitForFinalRunEvent(runtime, () => runId);
    const run = runtime.run({
      action: 'run',
      workspace: workspaceRoot,
      ticket: '230',
      profile: 'preview',
    });
    runId = run.runId;
    const finalEvent = await finalEventPromise;

    assert.equal(finalEvent.state, 'skipped');
  } finally {
    childProcess.spawn = originalSpawn;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('live skipped BAT run overrides failing result payload to skipped', async () => {
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
    let runId = '';
    const finalEventPromise = waitForFinalRunEvent(runtime, () => runId);
    const run = runtime.run({
      action: 'run',
      workspace: workspaceRoot,
      ticket: '230',
      profile: 'preview',
    });
    runId = run.runId;
    const finalEvent = await finalEventPromise;

    assert.equal(finalEvent.state, 'skipped');
    assert.deepEqual(finalEvent.checks, []);
    assert.deepEqual(finalEvent.locations, []);
    assert.deepEqual(finalEvent.artifactPaths, []);
  } finally {
    childProcess.spawn = originalSpawn;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('runtime treats no-eligible sprint results as skipped when the current message variant is logged', async () => {
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
        ok: true,
        noop: true,
        blockedReason: 'No eligible tickets matched current sprint filters.',
        label: 'SPRINT IMPLEMENT x2',
      }));
      proc.stdout.emit('data', 'No eligible tickets matched current sprint filters.\n');
      proc.emit('close', 0);
    });
    return proc;
  };

  try {
    const runtime = new SharedAgentRuntime({
      workspaceRoot,
      pythonRelative: 'backend/.venv/bin/python',
    });
    let runId = '';
    const finalEventPromise = waitForFinalRunEvent(runtime, () => runId);
    const run = runtime.run({
      action: 'self-improve',
      workspace: workspaceRoot,
      profile: 'aiWrite',
    });
    runId = run.runId;
    const finalEvent = await finalEventPromise;

    assert.equal(finalEvent.state, 'skipped');
    assert.equal(finalEvent.blockedReason, 'No eligible tickets matched current sprint filters.');
  } finally {
    childProcess.spawn = originalSpawn;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('runtime treats structured skipped result state as skipped without relying on log text', async () => {
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
        ok: true,
        state: 'skipped',
        blockedReason: 'No eligible tickets matched current sprint filters.',
        label: 'SPRINT IMPLEMENT x2',
      }));
      proc.stdout.emit('data', 'scheduler idle\n');
      proc.emit('close', 0);
    });
    return proc;
  };

  try {
    const runtime = new SharedAgentRuntime({
      workspaceRoot,
      pythonRelative: 'backend/.venv/bin/python',
    });
    let runId = '';
    const finalEventPromise = waitForFinalRunEvent(runtime, () => runId);
    const run = runtime.run({
      action: 'self-improve',
      workspace: workspaceRoot,
      profile: 'aiWrite',
    });
    runId = run.runId;
    const finalEvent = await finalEventPromise;

    assert.equal(finalEvent.state, 'skipped');
    assert.equal(finalEvent.blockedReason, 'No eligible tickets matched current sprint filters.');
  } finally {
    childProcess.spawn = originalSpawn;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('runtime surfaces live review summaries and approval requests from result payloads', async () => {
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
        label: 'ORCHESTRATE TOOL LOOP',
        checks: [],
        runtimeContext: {
          schema_version: '2026-03-12',
          ticket: '613',
          active_file_path: 'docs/notes.md',
          related_files: ['docs/notes.md'],
          changed_files: [{ path: 'docs/notes.md', status: 'M' }],
        },
        artifact: {
          runtime_context: {
            schema_version: '2026-03-12',
            ticket: '613',
            active_file_path: 'docs/notes.md',
            related_files: ['docs/notes.md'],
            changed_files: [{ path: 'docs/notes.md', status: 'M' }],
          },
          review_summary: {
            requires_manual_review: true,
            pending_approval_count: 1,
            low_confidence_patch_count: 1,
            summary: '1 approval request(s) pending; 1 low-confidence patch selection(s)',
          },
          pending_approvals: [
            {
              id: 'implementer:edit_file:path=docs/notes.md',
              agent: 'implementer',
              tool: 'edit_file',
              reason: 'edit_file is controlled and requires approval before execution.',
              safety_level: 'controlled',
              input: { path: 'docs/notes.md' },
            },
          ],
        },
        reviewSummary: {
          requires_manual_review: true,
          pending_approval_count: 1,
          low_confidence_patch_count: 1,
          summary: '1 approval request(s) pending; 1 low-confidence patch selection(s)',
        },
        approvalRequests: [
          {
            id: 'implementer:edit_file:path=docs/notes.md',
            agent: 'implementer',
            tool: 'edit_file',
            reason: 'edit_file is controlled and requires approval before execution.',
            safety_level: 'controlled',
            input: { path: 'docs/notes.md' },
          },
        ],
      }));
      proc.emit('close', 1);
    });
    return proc;
  };

  try {
    const runtime = new SharedAgentRuntime({
      workspaceRoot,
      pythonRelative: 'backend/.venv/bin/python',
    });
    let runId = '';
    const finalEventPromise = waitForFinalRunEvent(runtime, () => runId);
    const run = runtime.run({
      action: 'orchestrate',
      workspace: workspaceRoot,
      ticket: '613',
      profile: 'preview',
    });
    runId = run.runId;
    const finalEvent = await finalEventPromise;

    assert.equal(finalEvent.state, 'fail');
    assert.equal(finalEvent.reviewSummary.requiresManualReview, true);
    assert.equal(finalEvent.reviewSummary.pendingApprovalCount, 1);
    assert.equal(finalEvent.approvalRequests[0].path, 'docs/notes.md');
    assert.equal(finalEvent.runtimeContext.active_file_path, 'docs/notes.md');
    assert.equal(runtime.getStatus(runId).reviewSummary.lowConfidencePatchCount, 1);
    assert.equal(runtime.getStatus(runId).runtimeContext.changed_files[0].path, 'docs/notes.md');
  } finally {
    childProcess.spawn = originalSpawn;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('runtime falls back to artifact review metadata for approval handoff signals', async () => {
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
        label: 'ORCHESTRATE TOOL LOOP',
        checks: [],
        artifact: {
          runtime_context: {
            schema_version: '2026-03-12',
            ticket: '614',
            active_file_path: 'backend/alembic/versions/0005_wallet_transactions.py',
            changed_files: [{ path: 'backend/alembic/versions/0005_wallet_transactions.py', status: 'M' }],
          },
          review_summary: {
            requires_manual_review: true,
            pending_approval_count: 1,
            low_confidence_patch_count: 0,
            summary: '1 approval request pending',
          },
          pending_approvals: [
            {
              id: 'implementer:edit_file:path=backend/alembic/versions/0005_wallet_transactions.py',
              agent: 'implementer',
              tool: 'edit_file',
              reason: 'edit_file is controlled and requires approval before execution.',
              safety_level: 'controlled',
              input: { path: 'backend/alembic/versions/0005_wallet_transactions.py' },
            },
          ],
        },
      }));
      proc.emit('close', 1);
    });
    return proc;
  };

  try {
    const runtime = new SharedAgentRuntime({
      workspaceRoot,
      pythonRelative: 'backend/.venv/bin/python',
    });
    let runId = '';
    const finalEventPromise = waitForFinalRunEvent(runtime, () => runId);
    const run = runtime.run({
      action: 'orchestrate',
      workspace: workspaceRoot,
      ticket: '614',
      profile: 'preview',
    });
    runId = run.runId;
    const finalEvent = await finalEventPromise;

    assert.equal(finalEvent.reviewSummary.pendingApprovalCount, 1);
    assert.equal(finalEvent.approvalRequests[0].path, 'backend/alembic/versions/0005_wallet_transactions.py');
    assert.equal(finalEvent.runtimeContext.active_file_path, 'backend/alembic/versions/0005_wallet_transactions.py');
  } finally {
    childProcess.spawn = originalSpawn;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('runtime surfaces owner, experiment, and automation summaries from result payloads', async () => {
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
        ok: true,
        label: 'OWNER AUTOMATION SUMMARY',
        ownerSummary: { summary: 'Owner-ready summary', status: 'review' },
        runSummary: { summary: 'Runtime completed with review follow-up.' },
        testSummary: { summary: 'No tests requested.', failed_count: 0 },
        reviewQueueSummary: { pending_review_count: 1 },
        recommendedActions: [{ title: 'Approve owner automation task', reason: 'manual review required' }],
        experimentBenchmarkSummary: { total_runs: 4 },
        ownerExperimentSummary: { recommended_next_action: 'retry backend_api' },
        trainingHandoff: { recommended_focus: 'review failure clusters' },
        trustSummary: { trust_state: 'needs_review', summary: 'trust=needs_review' },
        trustSignalCount: 2,
        trustStateCounts: { needs_review: 2 },
        queueSummary: { summary: 'Prepared 2 owner automation task(s).', prepared_task_count: 2 },
        historySummary: { entry_count: 3, status_counts: { review: 2, failed: 1 } },
        recommendation: { summary: 'Execute the top owner automation task next.' },
        projectMaintenanceSummary: { queueSummary: { prepared_task_count: 1 }, trust_summary: { trust_state: 'needs_review' } },
        ownerGoals: [{ title: 'Stabilize validation review loop' }],
        ownerGoalPlan: { summary: 'Owner goals normalized into two categories.' },
      }));
      proc.emit('close', 0);
    });
    return proc;
  };

  try {
    const runtime = new SharedAgentRuntime({
      workspaceRoot,
      pythonRelative: 'backend/.venv/bin/python',
    });
    let runId = '';
    const finalEventPromise = waitForFinalRunEvent(runtime, () => runId);
    const run = runtime.run({
      action: 'owner-automation-summary',
      workspace: workspaceRoot,
      profile: 'preview',
    });
    runId = run.runId;
    const finalEvent = await finalEventPromise;

    assert.equal(finalEvent.ownerSummary.summary, 'Owner-ready summary');
    assert.equal(finalEvent.experimentBenchmarkSummary.total_runs, 4);
    assert.equal(finalEvent.trustSummary.trust_state, 'needs_review');
    assert.equal(finalEvent.trustSignalCount, 2);
    assert.equal(finalEvent.trustStateCounts.needs_review, 2);
    assert.equal(finalEvent.queueSummary.prepared_task_count, 2);
    assert.equal(finalEvent.historySummary.entry_count, 3);
    assert.equal(finalEvent.projectMaintenanceSummary.queueSummary.prepared_task_count, 1);
    assert.equal(finalEvent.projectMaintenanceSummary.trust_summary.trust_state, 'needs_review');
    assert.equal(runtime.getStatus(runId).ownerGoalPlan.summary, 'Owner goals normalized into two categories.');
    assert.equal(runtime.getStatus(runId).trustSummary.trust_state, 'needs_review');
  } finally {
    childProcess.spawn = originalSpawn;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('recovery state normalizes skipped BAT failures to skipped', () => {
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
    assert.equal(recovered.state, 'skipped');
    assert.deepEqual(recovered.checks, []);
    assert.deepEqual(recovered.locations, []);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('runtime recovery state uses configured external runtime file', () => {
  const workspaceRoot = makeWorkspace();
  const offloadRoot = path.join(workspaceRoot, 'offload');
  const runsDir = path.join(offloadRoot, 'assistant_runs');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), `assistant_runs_dir: ${runsDir}\n`, 'utf8');
  const runtimeStatePath = path.join(runsDir, 'runtime_state.json');
  fs.writeFileSync(runtimeStatePath, JSON.stringify({ updatedAt: '2026-03-12T12:00:00Z', runs: [] }));

  try {
    const runtime = new SharedAgentRuntime({
      workspaceRoot,
      pythonRelative: 'backend/.venv/bin/python',
    });
    assert.equal(runtime.runtimeStatePath, runtimeStatePath);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
