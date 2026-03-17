'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildApprovedDocumentationVault,
  buildDesktopLearningRecord,
  captureLayoutDiagnosticsArtifact,
  captureDesktopLearningRecord,
  recommendApprovedDocumentationSources,
  readDesktopArtifactPreview,
  readLatestApprovedDocumentationSource,
  readLatestDesktopTrainingHandoff,
  readLatestDesktopLearningRecord,
  readLatestLayoutDiagnosticsArtifact,
} = require('../desktop-learning-records');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-learning-'));
  fs.mkdirSync(path.join(root, 'docs', 'assistant_runs'), { recursive: true });
  return root;
}

test('buildDesktopLearningRecord keeps latest run, validation, and review signals', () => {
  const record = buildDesktopLearningRecord({
    workspaceRoot: '/workspace',
    recentRuns: [{
      runId: 'run-1',
      label: 'Self-host pass',
      state: 'pass',
      testSummary: { failed_count: 0, passed_count: 4 },
      reviewSummary: { summary: 'Manual review not required.' },
      recommendedActions: [{ title: 'Open Validate', reason: 'review the passing checks' }],
    }],
    changedFiles: ['M renderer/index.html'],
    latestSprint: { status: 'pass' },
    worktree: { scopeLabel: 'isolated', allowedTargetPaths: ['renderer'] },
    manager: {
      approvals: { total: 1, pending: 1, deferred: 0, rejected: 0 },
      approvalQueue: [{ path: 'renderer/index.html', line: 1 }],
      training: { exists: true, exampleCount: 8, pendingRunsCount: 2, state: 'warn' },
      currentRunDetail: { nextActionText: 'Inspect validation summary' },
    },
  }, {
    learnedSignals: ['approvals-first review'],
  });

  assert.equal(record.kind, 'desktop-supervised-learning-record');
  assert.equal(record.latestRun.runId, 'run-1');
  assert.equal(record.validation.changedFiles.length, 1);
  assert.equal(record.review.pendingApprovalCount, 1);
  assert.equal(record.patchOutcome.changedFileCount, 1);
  assert.equal(record.reviewQuality.queueSize, 1);
  assert.equal(record.validationDepth.totalChecks, 4);
  assert.match(record.learnedSignals.join(' | '), /Inspect validation summary/);
  assert.match(record.learnedSignals.join(' | '), /approvals-first review/);
});

test('buildDesktopLearningRecord keeps approved documentation sources', () => {
  const record = buildDesktopLearningRecord({ workspaceRoot: '/workspace', manager: { approvals: {}, training: {} } }, {
    approvedSources: [{
      url: 'https://react.dev/reference/react/useMemo',
      domain: 'react.dev',
      title: 'useMemo',
      section: 'Reference',
      reason: 'Review React memoization guidance',
      outputPath: '/workspace/docs/assistant_runs/approved_docs/doc.json',
    }],
  });

  assert.equal(Array.isArray(record.approvedSources), true);
  assert.equal(record.approvedSources.length, 1);
  assert.equal(record.approvedSources[0].domain, 'react.dev');
  assert.equal(record.docUsefulness.consultedCount, 1);
  assert.equal(record.trainingReadiness.containsExternalDocSupport, true);
});

test('buildDesktopLearningRecord includes supervision, experiment, and UI context fields', () => {
  const record = buildDesktopLearningRecord({
    workspaceRoot: '/workspace',
    recentRuns: [{
      runId: 'run-3',
      label: 'Layout pass',
      state: 'pass',
      testSummary: { failed_count: 0, passed_count: 3, skipped_count: 1 },
      ownerExperimentSummary: { recommended_next_action: 'keep review-first layout' },
      experimentBenchmarkSummary: { best_strategy: { strategy: 'review-first' } },
    }],
    changedFiles: ['M renderer/app.js'],
    worktree: { allowedTargetPaths: ['**'] },
    manager: {
      approvals: { pending: 0, deferred: 0, rejected: 0 },
      approvalQueue: [],
      training: { exists: true },
      currentRunDetail: {},
    },
  }, {
    validationCommands: [{ command: 'npm test', kind: 'suite', outcome: 'pass' }],
    uiContext: { theme: 'obsidian', layoutPreset: 'focus', surfaceTemplate: 'split', activeView: 'automations', layoutIssueCount: 2, layoutIssueTypes: ['surface-overlap'] },
    operatorCorrections: [{ field: 'padding', before: '4px', after: '12px', reason: 'spacing too tight' }],
    operatorSupervision: { interventionRequired: true, acceptedWithoutChanges: 0, rejectedChanges: 1, summary: 'Operator adjusted spacing tokens.' },
    experimentLinks: { experimentId: 'exp-1', strategy: 'review-first', scoreBefore: 72, scoreAfter: 89, improvedTrust: true },
    trainingReadiness: { safeForTraining: true, repositoryGrounded: true, approvalComplete: true },
  });

  assert.equal(record.validationDepth.commands.length, 1);
  assert.equal(record.uiContext.theme, 'obsidian');
  assert.equal(record.operatorSupervision.operatorCorrections.length, 1);
  assert.equal(record.experimentLinks.experimentId, 'exp-1');
  assert.equal(record.trainingReadiness.safeForTraining, true);
});

test('captureDesktopLearningRecord writes artifact and readLatestDesktopLearningRecord returns it', () => {
  const workspaceRoot = makeWorkspace();
  try {
    const result = captureDesktopLearningRecord(workspaceRoot, {
      workspaceRoot,
      recentRuns: [{ runId: 'run-2', label: 'UI pass', state: 'fail', testSummary: { failed_count: 2 } }],
      manager: { approvals: { total: 0 }, training: { exists: false } },
      changedFiles: [],
    }, {
      summary: 'Captured after supervised UI pass.',
    });

    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(result.outputPath));

    const latest = readLatestDesktopLearningRecord(workspaceRoot);
    assert.equal(latest.exists, true);
    assert.equal(latest.count, 1);
    assert.equal(latest.outputPath, result.outputPath);
    assert.equal(latest.latestRunState, 'fail');
    assert.equal(latest.summary, 'Captured after supervised UI pass.');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('recommendApprovedDocumentationSources suggests trusted domains for VS Code extension work', () => {
  const recommendations = recommendApprovedDocumentationSources({
    targetPath: 'src/extension.ts',
    title: 'VS Code extension setup',
    summary: 'Extension configuration key mismatch in settings',
  });

  assert.equal(Array.isArray(recommendations), true);
  assert.equal(recommendations[0].domain, 'code.visualstudio.com');
  assert.match(String(recommendations[0].reason || ''), /VS Code docs/i);
});

test('readLatestDesktopTrainingHandoff reads the default handoff artifact from configured offload storage', () => {
  const workspaceRoot = makeWorkspace();
  const offloadRoot = path.join(workspaceRoot, 'tmp-offload');
  const devDataDir = path.join(offloadRoot, 'dev_data');
  try {
    fs.mkdirSync(devDataDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.local.yaml'), `assistant_artifacts_root: ${offloadRoot}\n`, 'utf8');
    const outputPath = path.join(devDataDir, 'training_handoff.json');
    fs.writeFileSync(outputPath, JSON.stringify({
      generatedAt: '2026-03-13T12:00:00Z',
      summary: 'Prepared training handoff from 6 experiment rows.',
      recommended_focus: 'Desktop supervision loops',
      selected_run_count: 6,
    }, null, 2), 'utf8');

    const handoff = readLatestDesktopTrainingHandoff(workspaceRoot);
    assert.equal(handoff.exists, true);
    assert.equal(handoff.outputPath, outputPath);
    assert.equal(handoff.datasetPath, path.join(devDataDir, 'dev_assistant_experiments.jsonl'));
    assert.equal(handoff.recommendedFocus, 'Desktop supervision loops');
    assert.equal(handoff.selectedRunCount, 6);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('readDesktopArtifactPreview pretty-prints json artifacts and constrains access to assistant artifact roots', () => {
  const workspaceRoot = makeWorkspace();
  const offloadRoot = path.join(workspaceRoot, 'tmp-offload');
  const devDataDir = path.join(offloadRoot, 'dev_data');
  try {
    fs.mkdirSync(devDataDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.local.yaml'), `assistant_artifacts_root: ${offloadRoot}\n`, 'utf8');
    const artifactPath = path.join(devDataDir, 'training_handoff.json');
    fs.writeFileSync(artifactPath, JSON.stringify({ summary: 'ok', selected_run_count: 3 }, null, 0), 'utf8');

    const preview = readDesktopArtifactPreview(workspaceRoot, artifactPath, { maxChars: 4000 });
    assert.equal(preview.ok, true);
    assert.equal(preview.language, 'json');
    assert.match(preview.content, /"selected_run_count": 3/);

    const blocked = readDesktopArtifactPreview(workspaceRoot, path.join(os.tmpdir(), 'not-allowed.json'));
    assert.equal(blocked.ok, false);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('readLatestApprovedDocumentationSource reads the newest approved docs artifact', () => {
  const workspaceRoot = makeWorkspace();
  const docsDir = path.join(workspaceRoot, 'docs', 'assistant_runs', 'approved_docs');
  try {
    fs.mkdirSync(docsDir, { recursive: true });
    const outputPath = path.join(docsDir, 'approved_doc_2026-03-13T12-00-00-000Z.json');
    fs.writeFileSync(outputPath, JSON.stringify({
      generatedAt: '2026-03-01T12:00:00Z',
      url: 'https://react.dev/reference/react/useMemo',
      domain: 'react.dev',
      title: 'useMemo',
      section: 'Reference',
      reason: 'Check memo guidance',
    }, null, 2), 'utf8');

    const latest = readLatestApprovedDocumentationSource(workspaceRoot);
    assert.equal(latest.exists, true);
    assert.equal(latest.domain, 'react.dev');
    assert.equal(latest.title, 'useMemo');
    assert.equal(latest.safetyLevel, 'official');
    assert.equal(latest.freshnessLabel, 'stale');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('buildApprovedDocumentationVault summarizes freshness and domain coverage', () => {
  const workspaceRoot = makeWorkspace();
  const docsDir = path.join(workspaceRoot, 'docs', 'assistant_runs', 'approved_docs');
  try {
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'approved_doc_2026-03-13T12-00-00-000Z.json'), JSON.stringify({
      generatedAt: '2026-03-13T12:00:00Z',
      url: 'https://react.dev/reference/react/useMemo',
      domain: 'react.dev',
      title: 'useMemo',
      section: 'Reference',
      reason: 'Check memo guidance',
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(docsDir, 'approved_doc_2026-03-15T12-00-00-000Z.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      url: 'https://code.visualstudio.com/docs/editor/tasks',
      domain: 'code.visualstudio.com',
      title: 'Tasks',
      section: 'Editor',
      reason: 'Check task guidance',
    }, null, 2), 'utf8');

    const vault = buildApprovedDocumentationVault(workspaceRoot);
    assert.equal(vault.exists, true);
    assert.equal(vault.count, 2);
    assert.equal(vault.freshnessLabel, 'fresh');
    assert.equal(vault.latest.domain, 'code.visualstudio.com');
    assert.equal(vault.domains.length, 2);
    assert.match(String(vault.recommendedAction || ''), /use the latest trusted docs/i);
    assert.match(vault.summary, /approved doc source/i);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('captureLayoutDiagnosticsArtifact writes artifact and readLatestLayoutDiagnosticsArtifact returns it', () => {
  const workspaceRoot = makeWorkspace();
  try {
    const result = captureLayoutDiagnosticsArtifact(workspaceRoot, {
      viewId: 'automations',
      panelView: 'overview',
      layoutPreset: 'focus',
      surfaceTemplate: 'split',
      theme: 'obsidian',
      viewport: { width: 1280, height: 800 },
      issueCount: 2,
      severityCounts: { fail: 1, warn: 1 },
      summary: 'Detected 2 layout issues in automations.',
      issues: [
        { type: 'surface-overlap', severity: 'fail', label: 'card A ↔ card B', detail: 'Overlap detected.' },
        { type: 'tight-gap', severity: 'warn', label: '.overview-preview-grid', detail: 'Gap below threshold.' },
      ],
    });

    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(result.outputPath));

    const latest = readLatestLayoutDiagnosticsArtifact(workspaceRoot);
    assert.equal(latest.exists, true);
    assert.equal(latest.issueCount, 2);
    assert.equal(latest.viewId, 'automations');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
