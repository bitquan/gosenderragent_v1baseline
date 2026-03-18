'use strict';

const childProcess = require('child_process');
const path = require('path');

function normalizeWorkspaceRoot(workspaceRoot) {
  const root = path.resolve(String(workspaceRoot || '').trim());
  if (!root) {
    throw new Error('Workspace root is required.');
  }
  return root;
}

function toRelativeWorkspacePath(workspaceRoot, value) {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const input = String(value || '').trim();
  if (!input) {
    return '';
  }
  const resolved = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the workspace: ${input}`);
  }
  return relative.replace(/\\/g, '/');
}

function clipText(value, maxLength = 180) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}…` : text;
}

function runGit(workspaceRoot, args, options = {}) {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const result = childProcess.spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs || 20000,
  });
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  if (result.error) {
    if (options.allowFailure) {
      return {
        ok: false,
        code: '',
        stdout,
        stderr,
        message: result.error.message,
      };
    }
    throw result.error;
  }
  if (result.status !== 0) {
    if (options.allowFailure) {
      return {
        ok: false,
        code: String(result.status || ''),
        stdout,
        stderr,
        message: stderr || stdout || 'Git command failed.',
      };
    }
    throw new Error(stderr || stdout || `Git command failed: ${args.join(' ')}`);
  }
  return {
    ok: true,
    code: String(result.status || '0'),
    stdout,
    stderr,
    message: '',
  };
}

function parseStatusLines(text) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  let branch = '';
  let upstream = '';
  let ahead = 0;
  let behind = 0;
  const files = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const header = line.slice(3).trim();
      const [branchPart, trackingPartRaw] = header.split('...');
      branch = String(branchPart || '').trim();
      const trackingPart = String(trackingPartRaw || '').trim();
      if (trackingPart) {
        const match = trackingPart.match(/^([^\s]+)(?: \[(.+)\])?$/);
        if (match) {
          upstream = String(match[1] || '').trim();
          const counters = String(match[2] || '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
          for (const item of counters) {
            const aheadMatch = item.match(/^ahead (\d+)$/i);
            const behindMatch = item.match(/^behind (\d+)$/i);
            if (aheadMatch) {
              ahead = Number(aheadMatch[1] || 0) || 0;
            }
            if (behindMatch) {
              behind = Number(behindMatch[1] || 0) || 0;
            }
          }
        }
      }
      continue;
    }

    const x = line[0] || ' ';
    const y = line[1] || ' ';
    const rawPath = line.slice(3).trim();
    const nextPath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop().trim() : rawPath;
    const filePath = String(nextPath || '').replace(/\\/g, '/');
    if (!filePath) {
      continue;
    }

    const untracked = x === '?' && y === '?';
    const staged = !untracked && x !== ' ';
    const unstaged = !untracked && y !== ' ';

    files.push({
      path: filePath,
      x,
      y,
      staged,
      unstaged,
      untracked,
      state: untracked ? 'untracked' : staged && unstaged ? 'staged+unstaged' : staged ? 'staged' : unstaged ? 'unstaged' : 'clean',
      summary: `${x}${y}`.trim() || 'clean',
    });
  }

  return {
    branch,
    upstream,
    ahead,
    behind,
    files,
  };
}

function readLastCommit(workspaceRoot) {
  const result = runGit(workspaceRoot, ['log', '-1', '--pretty=format:%h %s'], { allowFailure: true });
  return result.ok ? clipText(result.stdout, 160) : '';
}

function hasOriginRemote(workspaceRoot) {
  const result = runGit(workspaceRoot, ['remote'], { allowFailure: true });
  if (!result.ok) {
    return false;
  }
  return result.stdout.split(/\r?\n/).map((item) => item.trim()).includes('origin');
}

function buildBlockedReason(summary) {
  if (!summary.upstream && !summary.hasOriginRemote) {
    return 'No git remote is configured yet.';
  }
  if (!summary.upstream && summary.hasOriginRemote) {
    return 'This branch is not published yet.';
  }
  if (summary.dirty) {
    return 'Commit, discard, or unstage changes before running this action.';
  }
  return '';
}

function getGitStatus(workspaceRoot) {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const result = runGit(root, ['status', '--porcelain=v1', '--branch'], { allowFailure: true });
  if (!result.ok) {
    return {
      ok: false,
      workspaceRoot: root,
      branch: '',
      upstream: '',
      ahead: 0,
      behind: 0,
      dirty: false,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      lastCommit: '',
      files: [],
      canCommit: false,
      canPull: false,
      canPush: false,
      canPublish: false,
      blockedReason: result.message || 'Git status is unavailable.',
      hasOriginRemote: false,
    };
  }

  const parsed = parseStatusLines(result.stdout);
  const stagedCount = parsed.files.filter((item) => item.staged).length;
  const unstagedCount = parsed.files.filter((item) => item.unstaged).length;
  const untrackedCount = parsed.files.filter((item) => item.untracked).length;
  const dirty = stagedCount > 0 || unstagedCount > 0 || untrackedCount > 0;
  const remoteOrigin = hasOriginRemote(root);

  const summary = {
    ok: true,
    workspaceRoot: root,
    branch: parsed.branch,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    dirty,
    stagedCount,
    unstagedCount,
    untrackedCount,
    lastCommit: readLastCommit(root),
    files: parsed.files,
    canCommit: stagedCount > 0,
    canPull: !!parsed.upstream && !dirty,
    canPush: !!parsed.upstream,
    canPublish: !!parsed.branch && !parsed.upstream && remoteOrigin,
    blockedReason: '',
    hasOriginRemote: remoteOrigin,
  };
  summary.blockedReason = buildBlockedReason(summary);
  return summary;
}

function getGitSummary(workspaceRoot) {
  const status = getGitStatus(workspaceRoot);
  return {
    ...status,
    label: status.branch || 'Detached HEAD',
    summary: status.ok
      ? [
          status.upstream ? `${status.ahead} ahead` : 'unpublished',
          status.upstream ? `${status.behind} behind` : '',
          status.dirty ? `${status.stagedCount + status.unstagedCount + status.untrackedCount} changed` : 'clean',
        ].filter(Boolean).join(' • ')
      : status.blockedReason,
  };
}

function getGitDiff(workspaceRoot, relativePath, options = {}) {
  const normalizedPath = toRelativeWorkspacePath(workspaceRoot, relativePath);
  const args = options.cached === true ? ['diff', '--cached', '--', normalizedPath] : ['diff', '--', normalizedPath];
  const result = runGit(workspaceRoot, args, { allowFailure: true });
  return {
    ok: true,
    path: normalizedPath,
    diff: result.ok ? result.stdout : '',
    source: options.cached === true ? 'cached' : 'working-tree',
  };
}

function stagePaths(workspaceRoot, paths) {
  const normalized = (Array.isArray(paths) ? paths : []).map((item) => toRelativeWorkspacePath(workspaceRoot, item));
  if (!normalized.length) {
    return { ok: false, message: 'Select at least one file to stage.' };
  }
  runGit(workspaceRoot, ['add', '--', ...normalized]);
  return { ok: true, paths: normalized, status: getGitStatus(workspaceRoot) };
}

function unstagePaths(workspaceRoot, paths) {
  const normalized = (Array.isArray(paths) ? paths : []).map((item) => toRelativeWorkspacePath(workspaceRoot, item));
  if (!normalized.length) {
    return { ok: false, message: 'Select at least one file to unstage.' };
  }
  runGit(workspaceRoot, ['restore', '--staged', '--', ...normalized]);
  return { ok: true, paths: normalized, status: getGitStatus(workspaceRoot) };
}

function stageAll(workspaceRoot) {
  runGit(workspaceRoot, ['add', '-A']);
  return { ok: true, status: getGitStatus(workspaceRoot) };
}

function unstageAll(workspaceRoot) {
  runGit(workspaceRoot, ['restore', '--staged', ':./']);
  return { ok: true, status: getGitStatus(workspaceRoot) };
}

function discardPaths(workspaceRoot, paths) {
  const normalized = (Array.isArray(paths) ? paths : []).map((item) => toRelativeWorkspacePath(workspaceRoot, item));
  if (!normalized.length) {
    return { ok: false, message: 'Select at least one file to discard.' };
  }
  runGit(workspaceRoot, ['restore', '--worktree', '--source=HEAD', '--', ...normalized]);
  return { ok: true, paths: normalized, status: getGitStatus(workspaceRoot) };
}

function commitStaged(workspaceRoot, message) {
  const trimmed = String(message || '').trim();
  if (!trimmed) {
    return { ok: false, message: 'Commit message is required.' };
  }
  const status = getGitStatus(workspaceRoot);
  if (!status.canCommit) {
    return { ok: false, message: 'Stage changes before committing.' };
  }
  runGit(workspaceRoot, ['commit', '-m', trimmed]);
  return {
    ok: true,
    message: 'Committed staged changes.',
    status: getGitStatus(workspaceRoot),
  };
}

function pullTrackedBranch(workspaceRoot) {
  const status = getGitStatus(workspaceRoot);
  if (!status.upstream) {
    return { ok: false, message: 'This branch has no upstream to pull from.' };
  }
  if (status.dirty) {
    return { ok: false, message: 'Pull is disabled while the worktree has local changes.' };
  }
  runGit(workspaceRoot, ['pull', '--ff-only']);
  return { ok: true, message: 'Pulled the latest upstream changes.', status: getGitStatus(workspaceRoot) };
}

function pushTrackedBranch(workspaceRoot) {
  const status = getGitStatus(workspaceRoot);
  if (!status.upstream) {
    return { ok: false, message: 'This branch is not published yet. Use Publish branch first.' };
  }
  runGit(workspaceRoot, ['push']);
  return { ok: true, message: 'Pushed the current branch.', status: getGitStatus(workspaceRoot) };
}

function normalizeAppBranchName(name) {
  const raw = String(name || '').trim().replace(/^refs\/heads\//i, '');
  if (!raw) {
    return '';
  }
  return raw.startsWith('codex/') ? raw : `codex/${raw}`;
}

function publishBranch(workspaceRoot) {
  const status = getGitStatus(workspaceRoot);
  if (!status.branch) {
    return { ok: false, message: 'Current branch is unavailable.' };
  }
  if (!status.hasOriginRemote) {
    return { ok: false, message: 'Add an origin remote before publishing this branch.' };
  }
  if (status.upstream) {
    return { ok: false, message: 'This branch already has an upstream.' };
  }
  runGit(workspaceRoot, ['push', '-u', 'origin', status.branch]);
  return { ok: true, message: `Published ${status.branch}.`, status: getGitStatus(workspaceRoot) };
}

function listBranches(workspaceRoot) {
  const result = runGit(workspaceRoot, ['branch', '--format=%(HEAD)|%(refname:short)|%(upstream:short)'], { allowFailure: true });
  if (!result.ok) {
    return { ok: false, message: result.message || 'Unable to list branches.', branches: [] };
  }
  const branches = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [head, branch, upstream] = line.split('|');
      return {
        name: String(branch || '').trim(),
        upstream: String(upstream || '').trim(),
        current: String(head || '').trim() === '*',
      };
    })
    .filter((item) => item.name);
  return { ok: true, branches };
}

function createBranch(workspaceRoot, name) {
  const branch = normalizeAppBranchName(name);
  if (!branch) {
    return { ok: false, message: 'Branch name is required.' };
  }
  runGit(workspaceRoot, ['checkout', '-b', branch]);
  return { ok: true, message: `Created and switched to ${branch}.`, branch, status: getGitStatus(workspaceRoot) };
}

function switchBranch(workspaceRoot, name) {
  const branch = String(name || '').trim();
  if (!branch) {
    return { ok: false, message: 'Choose a branch first.' };
  }
  const status = getGitStatus(workspaceRoot);
  if (status.dirty) {
    return { ok: false, message: 'Switch branch is disabled while the worktree has local changes.' };
  }
  runGit(workspaceRoot, ['checkout', branch]);
  return { ok: true, message: `Switched to ${branch}.`, branch, status: getGitStatus(workspaceRoot) };
}

module.exports = {
  getGitSummary,
  getGitStatus,
  getGitDiff,
  stagePaths,
  unstagePaths,
  stageAll,
  unstageAll,
  discardPaths,
  commitStaged,
  pullTrackedBranch,
  pushTrackedBranch,
  publishBranch,
  listBranches,
  createBranch,
  switchBranch,
  normalizeAppBranchName,
};
