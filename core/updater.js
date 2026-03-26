'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { ensureDirectory, nowIso, isWithin, readJsonFile, writeJsonFileAtomic } = require('./utils');
const { runPreflight } = require('./preflight');

const BACKUP_DIR_NAME = '.assistant_backups';
const PROTECTED_UPDATE_TERMS = ['payment', 'wallet', 'auth', 'security', 'migration', 'network', 'billing'];

function git(cmdArgs, workspaceRoot) {
  const result = childProcess.spawnSync('git', cmdArgs, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

function getBackupRoot(workspaceRoot) {
  return path.join(workspaceRoot, BACKUP_DIR_NAME);
}

function historyPath(workspaceRoot) {
  return path.join(getBackupRoot(workspaceRoot), 'history.json');
}

function appendHistory(workspaceRoot, item) {
  const file = historyPath(workspaceRoot);
  const next = readUpdateHistory(workspaceRoot);
  next.unshift(item);
  writeJsonFileAtomic(file, next.slice(0, 30));
}

function readUpdateHistory(workspaceRoot) {
  const current = readJsonFile(historyPath(workspaceRoot), []);
  return Array.isArray(current) ? current : [];
}

function defaultBackupTargets() {
  return [
    'backend/scripts',
    'tools/vscode-dev-assistant-extension',
    'tools/gosenderr-desktop-agent',
    'docs/BAT_FEATURE_BOARD.md',
    'dev_assistant.yaml',
    '.vscode/tasks.json',
  ];
}

function sanitizeTargetPath(workspaceRoot, relativePath) {
  const clean = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const resolved = path.resolve(workspaceRoot, clean);
  if (!isWithin(workspaceRoot, resolved)) {
    return null;
  }
  return { clean, resolved };
}

function copyForBackup(workspaceRoot, backupId, targets) {
  const backupRoot = getBackupRoot(workspaceRoot);
  const backupPath = path.join(backupRoot, backupId);
  ensureDirectory(backupPath);

  const copied = [];
  for (const target of targets) {
    const safe = sanitizeTargetPath(workspaceRoot, target);
    if (!safe) {
      continue;
    }
    if (!fs.existsSync(safe.resolved)) {
      continue;
    }

    const dest = path.join(backupPath, safe.clean);
    ensureDirectory(path.dirname(dest));
    fs.cpSync(safe.resolved, dest, { recursive: true });
    copied.push(safe.clean);
  }

  return { backupPath, copied };
}

function restoreFromBackup(workspaceRoot, backupId) {
  const backupPath = path.join(getBackupRoot(workspaceRoot), backupId);
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup ${backupId} not found.`);
  }

  const entries = [];
  function walk(dir, prefix = '') {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const rel = path.join(prefix, item.name);
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(full, rel);
      } else {
        entries.push(rel);
      }
    }
  }
  walk(backupPath);

  const topLevel = new Set(entries.map((entry) => entry.split(path.sep)[0]));
  for (const top of topLevel) {
    const destination = path.join(workspaceRoot, top);
    if (fs.existsSync(destination)) {
      fs.rmSync(destination, { recursive: true, force: true });
    }
    const source = path.join(backupPath, top);
    fs.cpSync(source, destination, { recursive: true });
  }

  return {
    backupId,
    restoredPaths: Array.from(topLevel),
  };
}

function checkForUpdates(workspaceRoot) {
  const insideRepo = git(['rev-parse', '--is-inside-work-tree'], workspaceRoot);
  if (!insideRepo.ok) {
    return {
      ok: false,
      hasUpdates: false,
      reason: insideRepo.stderr || 'not a git workspace',
    };
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceRoot);
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], workspaceRoot);
  if (!upstream.ok) {
    return {
      ok: true,
      hasUpdates: false,
      branch: branch.stdout,
      upstream: null,
      reason: 'No upstream configured.',
    };
  }

  git(['fetch', '--quiet', '--all'], workspaceRoot);

  const diverged = git(['rev-list', '--left-right', '--count', `HEAD...${upstream.stdout}`], workspaceRoot);
  let ahead = 0;
  let behind = 0;
  if (diverged.ok) {
    const parts = diverged.stdout.split(/\s+/).filter(Boolean).map(Number);
    ahead = parts[0] || 0;
    behind = parts[1] || 0;
  }

  return {
    ok: true,
    hasUpdates: behind > 0,
    branch: branch.stdout,
    upstream: upstream.stdout,
    ahead,
    behind,
  };
}

function normalizeUpdatePath(relativePath) {
  return String(relativePath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

function isProtectedAutoUpdatePath(relativePath) {
  const normalizedPath = normalizeUpdatePath(relativePath);
  if (!normalizedPath) {
    return false;
  }
  return PROTECTED_UPDATE_TERMS.some((term) => normalizedPath.includes(term));
}

function isLowRiskAutoUpdatePath(relativePath) {
  const normalizedPath = normalizeUpdatePath(relativePath);
  if (!normalizedPath) {
    return false;
  }
  return normalizedPath.startsWith('docs/')
    || normalizedPath.startsWith('backend/tests/')
    || normalizedPath.startsWith('tests/')
    || normalizedPath.includes('/__tests__/')
    || normalizedPath.endsWith('.md');
}

function summarizeAutoUpdateSafety(files = []) {
  const normalizedFiles = Array.isArray(files)
    ? files.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const safeFiles = [];
  const blockedFiles = [];

  for (const file of normalizedFiles) {
    if (!isLowRiskAutoUpdatePath(file) || isProtectedAutoUpdatePath(file)) {
      blockedFiles.push(file);
      continue;
    }
    safeFiles.push(file);
  }

  return {
    safe: normalizedFiles.length > 0 && blockedFiles.length === 0,
    fileCount: normalizedFiles.length,
    safeFiles,
    blockedFiles,
  };
}

function buildUpdatePlan(workspaceRoot) {
  const check = checkForUpdates(workspaceRoot);
  const preflight = runPreflight(workspaceRoot, { requireGh: false });

  if (!check.ok || !check.upstream || !check.hasUpdates) {
    return {
      ...check,
      preflight,
      commits: [],
      files: [],
      summary: check.reason || 'No update available.',
    };
  }

  const commits = git(['log', '--oneline', `HEAD..${check.upstream}`, '-n', '30'], workspaceRoot);
  const files = git(['diff', '--name-only', `HEAD..${check.upstream}`], workspaceRoot);

  return {
    ...check,
    preflight,
    commits: commits.ok ? commits.stdout.split(/\r?\n/).filter(Boolean) : [],
    files: files.ok ? files.stdout.split(/\r?\n/).filter(Boolean) : [],
    summary: `${check.behind} commit(s) available on ${check.upstream}.`,
  };
}

function applyUpdate(workspaceRoot, options = {}) {
  if (!options.confirm) {
    throw new Error('Update apply requires explicit confirmation.');
  }

  const plan = buildUpdatePlan(workspaceRoot);
  if (!plan.ok) {
    return { ok: false, plan, error: plan.reason || 'Unable to check updates.' };
  }

  if (!plan.hasUpdates) {
    return { ok: true, plan, updated: false, message: 'Already up to date.' };
  }

  const now = new Date();
  const backupId = now.toISOString().replace(/[:.]/g, '-');
  const targets = Array.isArray(options.backupTargets) && options.backupTargets.length > 0
    ? options.backupTargets
    : defaultBackupTargets();

  const backup = copyForBackup(workspaceRoot, backupId, targets);
  const beforeHead = git(['rev-parse', 'HEAD'], workspaceRoot).stdout;

  const pull = git(['pull', '--ff-only'], workspaceRoot);
  if (!pull.ok) {
    appendHistory(workspaceRoot, {
      backupId,
      timestamp: nowIso(),
      ok: false,
      beforeHead,
      error: pull.stderr || 'git pull failed',
      copied: backup.copied,
    });
    return {
      ok: false,
      plan,
      updated: false,
      backupId,
      error: pull.stderr || 'git pull failed',
    };
  }

  const verify = runPreflight(workspaceRoot, { requireGh: false });
  const afterHead = git(['rev-parse', 'HEAD'], workspaceRoot).stdout;

  if (options.rollbackOnFailedVerify && verify.ready === false) {
    const reset = git(['reset', '--hard', beforeHead], workspaceRoot);
    const rollbackVerify = runPreflight(workspaceRoot, { requireGh: false });
    appendHistory(workspaceRoot, {
      backupId,
      timestamp: nowIso(),
      ok: false,
      beforeHead,
      afterHead,
      copied: backup.copied,
      verify,
      rollback: true,
      rollbackReason: 'post-update preflight failed',
      rollbackVerify,
      resetOk: reset.ok,
    });
    return {
      ok: false,
      updated: false,
      backupId,
      beforeHead,
      afterHead,
      verify,
      rollback: true,
      rollbackVerify,
      error: 'Post-update preflight failed. Update was rolled back automatically.',
      plan,
    };
  }

  appendHistory(workspaceRoot, {
    backupId,
    timestamp: nowIso(),
    ok: true,
    beforeHead,
    afterHead,
    copied: backup.copied,
    verify,
  });

  return {
    ok: true,
    updated: true,
    backupId,
    beforeHead,
    afterHead,
    verify,
    plan,
  };
}

function rollbackUpdate(workspaceRoot, options = {}) {
  const backupId = String(options.backupId || '').trim();
  if (!backupId) {
    throw new Error('rollback requires backupId.');
  }

  const restored = restoreFromBackup(workspaceRoot, backupId);
  const verify = runPreflight(workspaceRoot, { requireGh: false });

  appendHistory(workspaceRoot, {
    backupId,
    timestamp: nowIso(),
    rollback: true,
    ok: true,
    restoredPaths: restored.restoredPaths,
    verify,
  });

  return {
    ok: true,
    backupId,
    restoredPaths: restored.restoredPaths,
    verify,
  };
}

function listBackups(workspaceRoot) {
  const backupRoot = getBackupRoot(workspaceRoot);
  if (!fs.existsSync(backupRoot)) {
    return [];
  }
  return fs
    .readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));
}

function summarizeUpdateRecoveryState(workspaceRoot) {
  const backups = listBackups(workspaceRoot);
  const history = readUpdateHistory(workspaceRoot);
  const latest = history[0] && typeof history[0] === 'object' ? history[0] : null;
  const latestBackupId = String(latest?.backupId || backups[0] || '').trim();
  let summary = latestBackupId
    ? `Rollback is ready from backup ${latestBackupId}.`
    : 'No update backup is recorded yet.';
  if (latest?.rollback === true && latest?.ok === true) {
    summary = `Last update recovery restored backup ${latestBackupId || 'latest'} and re-ran preflight.`;
  } else if (latest?.rollback === true && latest?.ok === false) {
    summary = `Last update attempt rolled back after verification failed${latestBackupId ? ` using backup ${latestBackupId}` : ''}.`;
  } else if (latest?.ok === true && latest?.afterHead) {
    summary = `Last update advanced the workspace safely${latestBackupId ? ` with rollback backup ${latestBackupId}` : ''}.`;
  }
  return {
    backupCount: backups.length,
    latestBackupId,
    rollbackReady: backups.length > 0,
    historyCount: history.length,
    lastEvent: latest,
    summary,
  };
}

module.exports = {
  checkForUpdates,
  buildUpdatePlan,
  applyUpdate,
  rollbackUpdate,
  listBackups,
  readUpdateHistory,
  summarizeUpdateRecoveryState,
  defaultBackupTargets,
  isLowRiskAutoUpdatePath,
  isProtectedAutoUpdatePath,
  summarizeAutoUpdateSafety,
};
