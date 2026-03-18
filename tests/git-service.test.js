'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getGitStatus,
  normalizeAppBranchName,
  commitStaged,
  pullTrackedBranch,
  publishBranch,
  switchBranch,
} = require('../core/git-service');

function hasGit() {
  const result = childProcess.spawnSync('git', ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

function runGit(cwd, args) {
  childProcess.execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    windowsHide: true,
  });
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-git-service-'));
  runGit(root, ['init', '--initial-branch=main']);
  runGit(root, ['config', 'user.name', 'GoSenderr Test']);
  runGit(root, ['config', 'user.email', 'gosenderr@example.com']);
  fs.writeFileSync(path.join(root, 'README.md'), '# temp\n', 'utf8');
  runGit(root, ['add', 'README.md']);
  runGit(root, ['commit', '-m', 'chore: initial']);
  return root;
}

test('normalizeAppBranchName keeps or adds the codex prefix', (t) => {
  if (!hasGit()) {
    t.skip('git is not installed');
  }
  assert.equal(normalizeAppBranchName('codex/test-branch'), 'codex/test-branch');
  assert.equal(normalizeAppBranchName('test-branch'), 'codex/test-branch');
});

test('getGitStatus separates staged, unstaged, and untracked files', (t) => {
  if (!hasGit()) {
    t.skip('git is not installed');
  }
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'stage me\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new file\n', 'utf8');
  runGit(repo, ['add', 'staged.txt']);

  const status = getGitStatus(repo);

  assert.equal(status.ok, true);
  assert.equal(status.branch, 'main');
  assert.equal(status.stagedCount, 1);
  assert.equal(status.unstagedCount, 1);
  assert.equal(status.untrackedCount, 1);
  assert.equal(status.dirty, true);
});

test('commitStaged rejects empty commit messages', (t) => {
  if (!hasGit()) {
    t.skip('git is not installed');
  }
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'change.txt'), 'hello\n', 'utf8');
  runGit(repo, ['add', 'change.txt']);

  const result = commitStaged(repo, '   ');

  assert.equal(result.ok, false);
  assert.match(result.message, /Commit message is required/i);
});

test('pullTrackedBranch blocks while the worktree is dirty', (t) => {
  if (!hasGit()) {
    t.skip('git is not installed');
  }
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-git-remote-'));
  runGit(remote, ['init', '--bare']);
  const repo = makeRepo();
  runGit(repo, ['remote', 'add', 'origin', remote]);
  runGit(repo, ['push', '-u', 'origin', 'main']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# dirty\n', 'utf8');

  const result = pullTrackedBranch(repo);

  assert.equal(result.ok, false);
  assert.match(result.message, /dirty|local changes/i);
});

test('switchBranch blocks while the worktree is dirty', (t) => {
  if (!hasGit()) {
    t.skip('git is not installed');
  }
  const repo = makeRepo();
  runGit(repo, ['checkout', '-b', 'codex/other']);
  runGit(repo, ['checkout', 'main']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# dirty\n', 'utf8');

  const result = switchBranch(repo, 'codex/other');

  assert.equal(result.ok, false);
  assert.match(result.message, /disabled while the worktree has local changes/i);
});

test('publishBranch publishes a codex branch when origin exists and no upstream is set', (t) => {
  if (!hasGit()) {
    t.skip('git is not installed');
  }
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-git-publish-remote-'));
  runGit(remote, ['init', '--bare']);
  const repo = makeRepo();
  runGit(repo, ['remote', 'add', 'origin', remote]);
  runGit(repo, ['checkout', '-b', 'codex/publish-test']);

  const result = publishBranch(repo);
  const status = getGitStatus(repo);

  assert.equal(result.ok, true);
  assert.match(result.message, /Published codex\/publish-test/i);
  assert.equal(status.upstream, 'origin/codex/publish-test');
  assert.equal(status.canPush, true);
});
