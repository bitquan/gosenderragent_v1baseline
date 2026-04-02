'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildAcceptanceControlSummary,
  readLatestAcceptanceReport,
  summarizeFailureOutput,
  summarizeAcceptanceReport,
  writeAcceptanceReport,
} = require('../core/engine-acceptance');

function makeWorkspace() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-agent-acceptance-'));
  const artifactsRoot = path.join(workspaceRoot, 'artifacts');
  fs.mkdirSync(artifactsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, 'dev_assistant.local.yaml'),
    `assistant_artifacts_root: ${artifactsRoot}\n`,
    'utf8',
  );
  return { workspaceRoot, artifactsRoot };
}

test('summarizeAcceptanceReport marks warnings for healthy checks under training pressure', () => {
  const summary = summarizeAcceptanceReport({
    checks: [
      { status: 'pass' },
      { status: 'pass' },
    ],
    training: {
      trustSummary: {
        status: 'caution',
        recommendedNextStep: 'Wait for the laptop to cool down.',
      },
    },
  });

  assert.equal(summary.overallStatus, 'warn');
  assert.equal(summary.counts.pass, 2);
  assert.equal(summary.counts.fail, 0);
  assert.match(summary.nextAction, /cool down/i);
});

test('writeAcceptanceReport persists a latest report that can be read back', () => {
  const { workspaceRoot } = makeWorkspace();

  try {
    const stored = writeAcceptanceReport(workspaceRoot, {
      runId: 'engine_acceptance_1',
      label: 'engine-acceptance',
      checks: [{ status: 'pass' }],
      overallStatus: 'pass',
      summary: 'All checks passed.',
    });
    const latest = readLatestAcceptanceReport(workspaceRoot);

    assert.equal(typeof stored.outputPath, 'string');
    assert.equal(typeof stored.latestPath, 'string');
    assert.equal(fs.existsSync(stored.latestPath), true);
    assert.equal(latest.exists, true);
    assert.equal(latest.outputPath.endsWith('latest.json'), true);
    assert.equal(latest.report.runId, 'engine_acceptance_1');
    assert.equal(latest.report.summary, 'All checks passed.');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('buildAcceptanceControlSummary surfaces smoke and next-day gate readability', () => {
  const summary = buildAcceptanceControlSummary({
    overallStatus: 'fail',
    summary: '1 acceptance check failed.',
    nextAction: 'Repair the smoke suite before widening.',
    completedAt: '2026-03-16T18:00:00.000Z',
    checks: [
      { id: 'smoke', label: 'Smoke suite', status: 'fail', summary: 'Renderer smoke failed.' },
      { id: 'smoke-ui', label: 'UI smoke suite', status: 'pass', summary: 'UI smoke passed.' },
      { id: 'tests', label: 'Node tests', status: 'pass', summary: 'Tests passed.' },
    ],
  }, { exists: true });

  assert.equal(summary.acceptanceStatus, 'fail');
  assert.equal(summary.capabilityState, 'blocked');
  assert.equal(summary.capabilityLabel, 'BLOCKED');
  assert.equal(summary.smokeStatus, 'fail');
  assert.equal(summary.smokeCapabilityState, 'blocked');
  assert.equal(summary.smokeCapabilityLabel, 'BLOCKED');
  assert.equal(summary.blockerCount, 1);
  assert.equal(summary.nextDayStatus, 'blocked');
  assert.equal(summary.safeForNextDay, false);
  assert.match(summary.smokeSummary, /smoke check\(s\) failed/i);
  assert.match(summary.nextSafeAction, /smoke/i);
});

test('buildAcceptanceControlSummary surfaces repo-scoped autonomy proof readability', () => {
  const summary = buildAcceptanceControlSummary({
    overallStatus: 'pass',
    summary: 'Acceptance passed.',
    checks: [
      { id: 'tests', label: 'Node tests', status: 'pass', summary: 'Tests passed.' },
      { id: 'smoke-ui', label: 'UI smoke suite', status: 'pass', summary: 'UI smoke passed.' },
    ],
    autonomyProof: {
      target: 5,
      safeCount: 5,
      overscopedCount: 0,
      actionCount: 5,
      workspaceScoped: true,
      workspaceRoot: 'E:/dev/projects/gosenderr-desktop-agent-PC',
      summary: 'Repo-scoped autonomy proof captured 5/5 safe current-workspace action(s).',
      actions: [{ runId: 'proof-1', state: 'pass' }],
    },
  }, { exists: true });

  assert.equal(summary.autonomyProof.status, 'pass');
  assert.equal(summary.autonomyProof.safeCount, 5);
  assert.equal(summary.autonomyProof.actionCount, 5);
  assert.equal(summary.autonomyProof.workspaceScoped, true);
  assert.match(summary.autonomyProof.summary, /5\/5 safe current-workspace action/i);
});

test('buildAcceptanceControlSummary surfaces repo-scoped self-improvement proof readability', () => {
  const summary = buildAcceptanceControlSummary({
    overallStatus: 'pass',
    summary: 'Acceptance passed.',
    checks: [
      { id: 'tests', label: 'Node tests', status: 'pass', summary: 'Tests passed.' },
      { id: 'smoke-ui', label: 'UI smoke suite', status: 'pass', summary: 'UI smoke passed.' },
      { id: 'self-host-smoke', label: 'Self-host smoke suite', status: 'pass', summary: 'Self-host smoke passed.' },
    ],
    selfImprovementProof: {
      target: 5,
      safeCount: 5,
      overscopedCount: 0,
      actionCount: 5,
      workspaceScoped: true,
      workspaceRoot: 'E:/dev/projects/gosenderr-desktop-agent-PC',
      summary: 'Repo-scoped self-improvement proof captured 5/5 safe current-workspace action(s).',
      actions: [{ runId: 'proof-1', state: 'pass' }],
    },
  }, { exists: true });

  assert.equal(summary.selfImprovementProof.status, 'pass');
  assert.equal(summary.selfImprovementProof.capabilityState, 'verified');
  assert.equal(summary.selfImprovementProof.capabilityLabel, 'VERIFIED');
  assert.equal(summary.selfImprovementProof.safeCount, 5);
  assert.equal(summary.selfImprovementProof.actionCount, 5);
  assert.equal(summary.selfImprovementProof.workspaceScoped, true);
  assert.match(summary.selfImprovementProof.summary, /5\/5 safe current-workspace action/i);
});

test('buildAcceptanceControlSummary surfaces repo-scoped builder proof readability', () => {
  const summary = buildAcceptanceControlSummary({
    overallStatus: 'pass',
    summary: 'Acceptance passed.',
    checks: [
      { id: 'tests', label: 'Node tests', status: 'pass', summary: 'Tests passed.' },
      { id: 'smoke-ui', label: 'UI smoke suite', status: 'pass', summary: 'UI smoke passed.' },
    ],
    builderProof: {
      target: 1,
      safeCount: 1,
      overscopedCount: 0,
      actionCount: 1,
      workspaceScoped: true,
      workspaceRoot: 'E:/dev/projects/gosenderr-desktop-agent-PC',
      summary: 'Repo-scoped builder proof captured 1/1 safe current-workspace builder run.',
      actions: [{ runId: 'builder-proof-1', state: 'pass' }],
    },
  }, { exists: true });

  assert.equal(summary.builderProof.status, 'pass');
  assert.equal(summary.builderProof.safeCount, 1);
  assert.equal(summary.builderProof.actionCount, 1);
  assert.equal(summary.builderProof.workspaceScoped, true);
  assert.match(summary.builderProof.summary, /1\/1 safe current-workspace builder run/i);
});

test('buildAcceptanceControlSummary surfaces local-vs-remote model parity readability', () => {
  const summary = buildAcceptanceControlSummary({
    overallStatus: 'pass',
    summary: 'Acceptance passed.',
    checks: [
      { id: 'tests', label: 'Node tests', status: 'pass', summary: 'Tests passed.' },
      { id: 'smoke-ui', label: 'UI smoke suite', status: 'pass', summary: 'UI smoke passed.' },
    ],
    modelParity: {
      status: 'pass',
      capabilityCount: 5,
      readyCount: 5,
      widenReady: true,
      summary: 'Local-vs-remote parity is PROVEN across 5/5 core coding capabilities.',
      entries: [
        {
          id: 'plan',
          label: 'Plan',
          status: 'pass',
          proofStatus: 'pass',
          local: { role: 'workspace', modelProfileId: 'gs-dev-1-default', baseModel: 'qwen2.5-coder:14b', providerSource: 'ollama' },
          remote: { role: 'engine', modelProfileId: 'gse-1-engine', baseModel: 'gpt-5.4', providerSource: 'openai' },
        },
      ],
    },
  }, { exists: true });

  assert.equal(summary.modelParity.status, 'pass');
  assert.equal(summary.modelParity.proven, true);
  assert.equal(summary.modelParity.readyCount, 5);
  assert.equal(summary.modelParity.capabilityCount, 5);
  assert.match(summary.modelParity.summary, /PROVEN across 5\/5/i);
});

test('summarizeFailureOutput preserves the actionable smoke failure instead of the trailing Node version line', () => {
  const summary = summarizeFailureOutput('', [
    'Error: Renderer guard failed: missing required snippet "data-inspector-tab" in renderer/app.js',
    '    at assert (scripts/smoke.js:49:11)',
    'Node.js v24.14.0',
  ].join('\n'));

  assert.match(summary, /Renderer guard failed/);
  assert.doesNotMatch(summary, /Node\.js v24\.14\.0/);
});
