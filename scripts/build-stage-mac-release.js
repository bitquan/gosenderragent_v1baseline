#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { APP_ROOT, resolveTargetWorkspaceRoot } = require('../core/app-roots');
const {
  getConfiguredAssistantDesktopBuildDir,
  getConfiguredAssistantDesktopReleaseDir,
} = require('../core/assistant-paths');
const { pruneStagedReleases, stageDesktopReleaseArtifacts } = require('../core/desktop-release');

const appRoot = APP_ROOT;
const workspaceRoot = resolveTargetWorkspaceRoot(process.env.DESKTOP_AGENT_TARGET_WORKSPACE);
const distDir = getConfiguredAssistantDesktopBuildDir(workspaceRoot) || path.join(appRoot, 'dist');
const releaseDir = getConfiguredAssistantDesktopReleaseDir(workspaceRoot) || distDir;

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
  return result.status || 0;
}

function runOrExit(cmd, args, cwd) {
  const status = run(cmd, args, cwd);
  if (status !== 0) {
    process.exit(status);
  }
}

function cleanInstallerArtifacts(directory) {
  if (!fs.existsSync(directory)) {
    return;
  }
  for (const name of fs.readdirSync(directory)) {
    const lower = name.toLowerCase();
    const fullPath = path.join(directory, name);
    const removableDirectory = ['mac', 'mac-arm64', 'mac-x64', 'mac-universal'].includes(lower);
    if (removableDirectory) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      continue;
    }
    if (lower.endsWith('.dmg') || lower.endsWith('.zip') || lower.endsWith('.blockmap')) {
      fs.rmSync(fullPath, { force: true });
    }
  }
}

function buildInstaller() {
  console.log('[release:mac] building mac release artifacts (dmg + zip)...');
  const status = run('npm', ['run', 'dist:mac'], appRoot);
  if (status === 0) {
    return;
  }

  console.warn('[release:mac] DMG build failed, falling back to ZIP-only build...');
  runOrExit('npm', ['run', 'dist:mac:zip'], appRoot);
}

if (process.platform !== 'darwin') {
  console.error('release:mac is only supported on macOS.');
  process.exit(1);
}

if (!workspaceRoot) {
  console.error('release:mac requires a target workspace. Pick or create one on this machine, or set DESKTOP_AGENT_TARGET_WORKSPACE.');
  process.exit(1);
}

console.log('[release:mac] running desktop smoke checks...');
runOrExit('npm', ['run', 'smoke'], appRoot);

cleanInstallerArtifacts(distDir);
buildInstaller();

const staged = stageDesktopReleaseArtifacts(workspaceRoot, { sourceDir: distDir, releaseDir });
if (!staged.ok) {
  console.error(`[release:mac] ${staged.message}`);
  process.exit(1);
}

console.log(`[release:mac] ${staged.message}`);
const pruned = pruneStagedReleases(workspaceRoot, { releaseDir });
console.log(`[release:mac] ${pruned.message}`);
if (staged.latest?.fullPath) {
  console.log(`[release:mac] latest staged release: ${staged.latest.fullPath}`);
}
