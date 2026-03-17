#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { APP_ROOT } = require('../core/app-roots');
const {
  getStagedReleaseStatus,
  stageDesktopReleaseArtifacts,
} = require('../core/desktop-release');
const { getConfiguredAssistantDesktopBuildDir } = require('../core/assistant-paths');
const { version } = require('../package.json');

function resolveOutputDir() {
  const baseDir = getConfiguredAssistantDesktopBuildDir(APP_ROOT) || path.join(APP_ROOT, 'dist');
  return path.join(baseDir, `owner-current-release-${Date.now()}`);
}

function runBuilder(outputDir) {
  const builderScript = path.join(APP_ROOT, 'scripts', 'run-electron-builder.js');
  return spawnSync(process.execPath, [
    builderScript,
    '--win',
    'nsis',
    'zip',
    '--x64',
    '--publish',
    'never',
    `-c.directories.output=${outputDir}`,
  ], {
    cwd: APP_ROOT,
    stdio: 'inherit',
  });
}

function main() {
  const outputDir = resolveOutputDir();
  const build = runBuilder(outputDir);
  if ((build.status || 0) !== 0) {
    process.exit(build.status || 1);
  }

  const staged = stageDesktopReleaseArtifacts(APP_ROOT, { sourceDir: outputDir });
  if (!staged.ok) {
    console.error(`[build-current-win-release] ${staged.message}`);
    process.exit(1);
  }

  const releaseStatus = getStagedReleaseStatus(APP_ROOT);
  const windowsArtifacts = fs.existsSync(staged.releaseDir)
    ? fs.readdirSync(staged.releaseDir)
      .filter((name) => new RegExp(`-${version.replace(/\./g, '\\.')}-`, 'i').test(String(name || '')))
      .filter((name) => /\.(exe|zip)$/i.test(String(name || '')))
      .map((name) => path.join(staged.releaseDir, name))
    : [];
  console.log(`[build-current-win-release] ${staged.message}`);
  console.log(`[build-current-win-release] Build output: ${outputDir}`);
  windowsArtifacts.forEach((artifactPath) => {
    console.log(`[build-current-win-release] Windows artifact: ${artifactPath}`);
  });
  if (windowsArtifacts.length === 0 && releaseStatus.latest?.fullPath) {
    console.log(`[build-current-win-release] Latest download: ${releaseStatus.latest.fullPath}`);
  }
}

main();
