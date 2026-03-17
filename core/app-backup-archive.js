'use strict';

const fs = require('fs');
const path = require('path');

const { getConfiguredAssistantPromotionsRoot } = require('./assistant-paths');
const { ensureDirectory, nowIso, randomId, readJsonFile, writeJsonFileAtomic } = require('./utils');

const APP_ROLLBACKS_DIR = 'desktop_app_rollbacks';
const MANIFEST_FILE = 'manifest.json';
const DEFAULT_APP_NAME = 'GoSenderr Desktop Agent.app';

function normalizePath(value) {
  return path.resolve(String(value || '').trim());
}

function getDesktopAppRollbackRoot(workspaceRoot, platform = process.platform) {
  const promotionsRoot = getConfiguredAssistantPromotionsRoot(workspaceRoot);
  if (!promotionsRoot) {
    return '';
  }
  return path.join(promotionsRoot, APP_ROLLBACKS_DIR, String(platform || process.platform || 'darwin').trim().toLowerCase());
}

function ensureDesktopAppRollbackRoot(workspaceRoot, platform = process.platform) {
  const root = getDesktopAppRollbackRoot(workspaceRoot, platform);
  if (!root) {
    throw new Error('assistant_promotions_root is not configured. Configure assistant_artifacts_root or assistant_promotions_root before archiving desktop rollbacks.');
  }
  ensureDirectory(root);
  return root;
}

function appBundleExists(targetPath) {
  return !!targetPath && fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
}

function buildBackupId(prefix = 'backup') {
  return `${String(prefix || 'backup').trim()}-${randomId('app')}`;
}

function writeBackupManifest(root, manifest = {}) {
  writeJsonFileAtomic(path.join(root, MANIFEST_FILE), manifest);
}

function readBackupManifest(root) {
  return readJsonFile(path.join(root, MANIFEST_FILE), {});
}

function moveBundleAcrossDevices(sourcePath, targetPath) {
  try {
    fs.renameSync(sourcePath, targetPath);
    return { mode: 'rename' };
  } catch (error) {
    if (!error || error.code !== 'EXDEV') {
      throw error;
    }
  }
  fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
  fs.rmSync(sourcePath, { recursive: true, force: true });
  return { mode: 'copy-delete' };
}

function archiveAppBundle(workspaceRoot, sourceAppPath, options = {}) {
  const sourcePath = normalizePath(sourceAppPath);
  if (!appBundleExists(sourcePath)) {
    throw new Error(`Desktop app bundle was not found at ${sourcePath}.`);
  }
  const platform = String(options.platform || process.platform || 'darwin').trim().toLowerCase();
  const rollbackRoot = ensureDesktopAppRollbackRoot(workspaceRoot, platform);
  const backupId = String(options.backupId || buildBackupId('desktop-app')).trim();
  const backupRoot = path.join(rollbackRoot, backupId);
  const appName = String(options.appName || path.basename(sourcePath) || DEFAULT_APP_NAME).trim() || DEFAULT_APP_NAME;
  ensureDirectory(backupRoot);
  const archivedAppPath = path.join(backupRoot, appName);
  const archiveMode = moveBundleAcrossDevices(sourcePath, archivedAppPath);
  const manifest = {
    id: backupId,
    platform,
    appName,
    createdAt: String(options.createdAt || nowIso()),
    sourcePath,
    archivedAppPath,
    reason: String(options.reason || 'archived-application-backup').trim() || 'archived-application-backup',
    installSourcePath: String(options.installSourcePath || '').trim(),
    workspaceRoot: String(workspaceRoot || '').trim(),
    legacyName: String(options.legacyName || path.basename(sourcePath)).trim(),
    archiveMode: archiveMode.mode,
  };
  writeBackupManifest(backupRoot, manifest);
  return {
    ok: true,
    backupId,
    rollbackRoot,
    backupRoot,
    manifest,
  };
}

function installMacAppBundle(workspaceRoot, sourceAppPath, options = {}) {
  const sourcePath = normalizePath(sourceAppPath);
  if (!appBundleExists(sourcePath)) {
    throw new Error(`Built macOS app bundle was not found at ${sourcePath}.`);
  }
  const applicationsDir = normalizePath(options.applicationsDir || '/Applications');
  ensureDirectory(applicationsDir);
  const appName = String(options.appName || path.basename(sourcePath) || DEFAULT_APP_NAME).trim() || DEFAULT_APP_NAME;
  const installedPath = path.join(applicationsDir, appName);
  let archived = null;
  if (appBundleExists(installedPath)) {
    archived = archiveAppBundle(workspaceRoot, installedPath, {
      platform: 'darwin',
      reason: 'pre-install-replaced-live-app',
      installSourcePath: sourcePath,
      appName,
    });
  }
  fs.cpSync(sourcePath, installedPath, { recursive: true, force: true });
  return {
    ok: true,
    installedPath,
    archived,
  };
}

function migrateLegacyAppBackups(workspaceRoot, options = {}) {
  const applicationsDir = normalizePath(options.applicationsDir || '/Applications');
  if (!fs.existsSync(applicationsDir)) {
    return { ok: true, moved: [], rollbackRoot: ensureDesktopAppRollbackRoot(workspaceRoot, 'darwin') };
  }
  const rollbackRoot = ensureDesktopAppRollbackRoot(workspaceRoot, 'darwin');
  const moved = [];
  const entries = fs.readdirSync(applicationsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!/^GoSenderr Desktop Agent\.app\.backup-/i.test(entry.name)) {
      continue;
    }
    const sourcePath = path.join(applicationsDir, entry.name);
    const archived = archiveAppBundle(workspaceRoot, sourcePath, {
      platform: 'darwin',
      reason: 'migrated-legacy-application-backup',
      legacyName: entry.name,
      appName: DEFAULT_APP_NAME,
    });
    moved.push(archived.manifest);
  }
  return {
    ok: true,
    rollbackRoot,
    moved,
  };
}

function listArchivedAppBackups(workspaceRoot, platform = process.platform) {
  const rollbackRoot = getDesktopAppRollbackRoot(workspaceRoot, platform);
  if (!rollbackRoot) {
    return [];
  }
  if (!fs.existsSync(rollbackRoot)) {
    return [];
  }
  return fs.readdirSync(rollbackRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifest = readBackupManifest(path.join(rollbackRoot, entry.name));
      return {
        id: entry.name,
        backupRoot: path.join(rollbackRoot, entry.name),
        ...manifest,
      };
    })
    .filter((entry) => entry.id)
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
}

module.exports = {
  APP_ROLLBACKS_DIR,
  DEFAULT_APP_NAME,
  archiveAppBundle,
  ensureDesktopAppRollbackRoot,
  getDesktopAppRollbackRoot,
  installMacAppBundle,
  listArchivedAppBackups,
  migrateLegacyAppBackups,
};
