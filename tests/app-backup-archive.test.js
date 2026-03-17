'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getDesktopAppRollbackRoot,
  installMacAppBundle,
  listArchivedAppBackups,
  migrateLegacyAppBackups,
} = require('../core/app-backup-archive');

function writeWorkspaceConfig(workspaceRoot, promotionsRoot) {
  fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.local.yaml'), `assistant_promotions_root: ${promotionsRoot}\n`, 'utf8');
}

function makeFakeApp(appPath, marker = 'app') {
  fs.mkdirSync(path.join(appPath, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(appPath, 'Contents', 'MacOS', marker), marker, 'utf8');
}

test('legacy application backups are migrated into the rollback archive root', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-workspace-'));
  const promotionsRoot = path.join(workspaceRoot, 'assistant_promotions');
  const applicationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-apps-'));
  writeWorkspaceConfig(workspaceRoot, promotionsRoot);

  const legacyBackupPath = path.join(applicationsDir, 'GoSenderr Desktop Agent.app.backup-legacy');
  makeFakeApp(legacyBackupPath, 'legacy');

  const result = migrateLegacyAppBackups(workspaceRoot, { applicationsDir });
  const rollbackRoot = getDesktopAppRollbackRoot(workspaceRoot, 'darwin');

  assert.equal(result.ok, true);
  assert.equal(result.moved.length, 1);
  assert.equal(fs.existsSync(legacyBackupPath), false);
  assert.equal(fs.existsSync(rollbackRoot), true);
  assert.equal(listArchivedAppBackups(workspaceRoot, 'darwin').length, 1);
});

test('installMacAppBundle archives the existing live app into the rollback archive', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-install-workspace-'));
  const promotionsRoot = path.join(workspaceRoot, 'assistant_promotions');
  const applicationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-install-apps-'));
  writeWorkspaceConfig(workspaceRoot, promotionsRoot);

  const liveAppPath = path.join(applicationsDir, 'GoSenderr Desktop Agent.app');
  const builtAppPath = path.join(workspaceRoot, 'build', 'GoSenderr Desktop Agent.app');
  makeFakeApp(liveAppPath, 'live');
  makeFakeApp(builtAppPath, 'built');

  const result = installMacAppBundle(workspaceRoot, builtAppPath, { applicationsDir });
  const archived = listArchivedAppBackups(workspaceRoot, 'darwin');

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(result.installedPath), true);
  assert.equal(archived.length, 1);
  assert.match(String(archived[0].reason || ''), /pre-install-replaced-live-app/);
});

test('listArchivedAppBackups returns an empty list when no promotions root is configured yet', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-empty-workspace-'));
  try {
    assert.deepEqual(listArchivedAppBackups(workspaceRoot, 'darwin'), []);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
