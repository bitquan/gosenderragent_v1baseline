#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { resolveTargetWorkspaceRoot } = require('../core/app-roots');
const { getConfiguredAssistantDesktopBuildDir } = require('../core/assistant-paths');
const { installMacAppBundle, migrateLegacyAppBackups } = require('../core/app-backup-archive');

function resolveBuiltAppPath(workspaceRoot) {
  const buildRoot = getConfiguredAssistantDesktopBuildDir(workspaceRoot);
  if (!buildRoot) {
    throw new Error('assistant_desktop_build_dir is not configured.');
  }
  const candidates = [
    path.join(buildRoot, 'mac-arm64', 'GoSenderr Desktop Agent.app'),
    path.join(buildRoot, 'mac', 'GoSenderr Desktop Agent.app'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`No built macOS app bundle was found under ${buildRoot}. Run npm run pack:mac first.`);
  }
  return found;
}

function main() {
  const workspaceRoot = resolveTargetWorkspaceRoot(process.env.DESKTOP_AGENT_TARGET_WORKSPACE);
  if (!workspaceRoot) {
    throw new Error('No target workspace was available while resolving the rollback archive root.');
  }
  const sourceAppPath = process.argv[2] ? path.resolve(process.argv[2]) : resolveBuiltAppPath(workspaceRoot);
  const migrated = migrateLegacyAppBackups(workspaceRoot, { applicationsDir: '/Applications' });
  const installed = installMacAppBundle(workspaceRoot, sourceAppPath, { applicationsDir: '/Applications' });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    workspaceRoot,
    sourceAppPath,
    installedPath: installed.installedPath,
    archivedLiveApp: installed.archived?.manifest || null,
    migratedLegacyBackups: migrated.moved || [],
    rollbackRoot: migrated.rollbackRoot || '',
  }, null, 2)}\n`);
}

main();
