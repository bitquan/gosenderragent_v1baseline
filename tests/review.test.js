'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const {
  parseChangedFileLine,
  readWorkspaceFile,
  saveWorkspaceFile,
  buildReviewSnapshot,
  collectArtifactEntriesForRun,
  isApprovalRequiredPath,
  isIgnoredWorkspacePath,
  summarizeUnifiedDiff,
} = require('../core/review');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-review-'));
  fs.mkdirSync(path.join(root, 'docs', 'assistant_runs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'frontend', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'frontend', 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
  childProcess.execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  childProcess.execFileSync('git', ['config', 'user.email', 'review@test.local'], { cwd: root, stdio: 'ignore' });
  childProcess.execFileSync('git', ['config', 'user.name', 'Review Test'], { cwd: root, stdio: 'ignore' });
  childProcess.execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  childProcess.execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
  return root;
}

test('parseChangedFileLine normalizes git status rows', () => {
  const parsed = parseChangedFileLine(' M frontend/src/app.ts');
  assert.deepEqual(parsed, {
    status: 'M',
    raw: 'M frontend/src/app.ts',
    path: 'frontend/src/app.ts',
  });
});

test('parseChangedFileLine ignores generated cache noise', () => {
  assert.equal(parseChangedFileLine(' M agent/core/__pycache__/worker.cpython-313.pyc'), null);
  assert.equal(parseChangedFileLine(' M docs/assistant_runs/session.json'), null);
  assert.equal(isIgnoredWorkspacePath('agent/core/__pycache__/worker.cpython-313.pyc'), true);
});

test('readWorkspaceFile and saveWorkspaceFile stay inside workspace', () => {
  const workspaceRoot = makeWorkspace();
  try {
    const readResult = readWorkspaceFile(workspaceRoot, 'frontend/src/app.ts');
    assert.equal(readResult.ok, true);
    assert.match(readResult.content, /value = 1/);

    const saveResult = saveWorkspaceFile(workspaceRoot, 'frontend/src/app.ts', 'export const value = 2;\n');
    assert.equal(saveResult.ok, true);
    assert.match(fs.readFileSync(path.join(workspaceRoot, 'frontend', 'src', 'app.ts'), 'utf8'), /value = 2/);

    const blocked = readWorkspaceFile(workspaceRoot, '../secret.txt');
    assert.equal(blocked.ok, false);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('collectArtifactEntriesForRun returns related run artifacts', () => {
  const workspaceRoot = makeWorkspace();
  try {
    const runsDir = path.join(workspaceRoot, 'docs', 'assistant_runs');
    const runPath = path.join(runsDir, 'BAT500_implement.json');
    fs.writeFileSync(runPath, '{}\n', 'utf8');
    fs.writeFileSync(path.join(runsDir, 'BAT500_implement.md'), '# summary\n', 'utf8');
    fs.writeFileSync(path.join(runsDir, 'BAT500_implement_critique.json'), '{}\n', 'utf8');

    const artifacts = collectArtifactEntriesForRun({
      ticket: '500',
      command: 'implement',
      path: runPath,
      generatedAt: '2026-03-11T00:00:00Z',
    });

    assert.ok(artifacts.length >= 3);
    assert.equal(artifacts[0].relativePath, 'docs/assistant_runs/BAT500_implement.json');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('buildReviewSnapshot merges changed files, failures, artifacts, and decisions', () => {
  const workspaceRoot = makeWorkspace();
  try {
    const runsDir = path.join(workspaceRoot, 'docs', 'assistant_runs');
    const runPath = path.join(runsDir, 'BAT501_run.json');
    fs.writeFileSync(runPath, '{}\n', 'utf8');
    fs.writeFileSync(path.join(runsDir, 'BAT501_run.md'), '# run\n', 'utf8');

    const snapshot = buildReviewSnapshot(workspaceRoot, {
      changedFiles: [' M frontend/src/app.ts'],
      recentRuns: [{ ticket: '501', command: 'run', path: runPath, generatedAt: '2026-03-11T00:00:00Z' }],
      latestRun: {
        locations: [{ path: 'frontend/src/app.ts', line: 9, message: 'Type error' }],
      },
      decisions: {
        'frontend/src/app.ts': { status: 'approved', note: 'looks good' },
      },
    });

    assert.equal(snapshot.changedFiles[0].decision, 'approved');
    assert.equal(snapshot.failingLocations[0].line, 9);
    assert.ok(snapshot.recentArtifacts.some((item) => item.relativePath === 'docs/assistant_runs/BAT501_run.json'));
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('buildReviewSnapshot carries shared runtime context and falls back to runtime changed files', () => {
  const workspaceRoot = makeWorkspace();
  try {
    const snapshot = buildReviewSnapshot(workspaceRoot, {
      changedFiles: [],
      recentRuns: [],
      latestRun: null,
      runtimeContext: {
        ticket: '900',
        active_file_path: 'frontend/src/app.ts',
        changed_files: [{ path: 'frontend/src/app.ts', status: 'M' }],
        artifact_context: { referenced_paths: ['docs/assistant_runs/BAT900_run.json'] },
      },
      decisions: {},
    });

    assert.equal(snapshot.runtimeContext.active_file_path, 'frontend/src/app.ts');
    assert.equal(snapshot.changedFiles[0].path, 'frontend/src/app.ts');
    assert.equal(snapshot.recentArtifacts[0].relativePath, 'docs/assistant_runs/BAT900_run.json');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('buildReviewSnapshot keeps runtime approval focus path decision metadata', () => {
  const workspaceRoot = makeWorkspace();
  try {
    const snapshot = buildReviewSnapshot(workspaceRoot, {
      changedFiles: [],
      recentRuns: [],
      latestRun: null,
      runtimeContext: {
        ticket: '901',
        active_file_path: 'backend/alembic/versions/0005_wallet_transactions.py',
        changed_files: [{ path: 'backend/alembic/versions/0005_wallet_transactions.py', status: 'M' }],
        artifact_context: { referenced_paths: ['docs/assistant_runs/BAT901_run.json'] },
      },
      decisions: {
        'backend/alembic/versions/0005_wallet_transactions.py': { status: 'deferred', note: 'needs approval' },
      },
    });

    assert.equal(snapshot.runtimeContext.active_file_path, 'backend/alembic/versions/0005_wallet_transactions.py');
    assert.equal(snapshot.changedFiles[0].decision, 'deferred');
    assert.equal(snapshot.changedFiles[0].note, 'needs approval');
    assert.equal(snapshot.recentArtifacts[0].relativePath, 'docs/assistant_runs/BAT901_run.json');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('summarizeUnifiedDiff returns diff stats and hunk previews', () => {
  const summary = summarizeUnifiedDiff([
    'diff --git a/demo.txt b/demo.txt',
    '--- a/demo.txt',
    '+++ b/demo.txt',
    '@@ -1,2 +1,3 @@',
    '-old line',
    '+new line',
    '+another line',
    ' unchanged',
  ].join('\n'));

  assert.equal(summary.additions, 2);
  assert.equal(summary.deletions, 1);
  assert.equal(summary.hunkCount, 1);
  assert.match(summary.hunks[0].header, /@@/);
});

test('isApprovalRequiredPath skips generated assistant artifacts', () => {
  assert.equal(isApprovalRequiredPath('docs/assistant_runs/BAT501_run.json'), false);
  assert.equal(isApprovalRequiredPath('docs/assistant_runs/self_heal_demo_implement.json'), false);
  assert.equal(isApprovalRequiredPath('docs/DEV_ASSISTANT_LOG_REPORT.md'), false);
  assert.equal(isApprovalRequiredPath('frontend/src/app.ts'), true);
});
