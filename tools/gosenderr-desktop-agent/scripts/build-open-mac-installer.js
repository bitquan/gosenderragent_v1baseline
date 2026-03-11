#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const appRoot = path.resolve(__dirname, '..');
const distDir = path.join(appRoot, 'dist');

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
    if (lower.endsWith('.dmg') || lower.endsWith('.zip')) {
      fs.rmSync(path.join(directory, name), { force: true });
    }
  }
}

function latestArtifact(directory, extension) {
  if (!fs.existsSync(directory)) {
    return null;
  }
  const hits = fs
    .readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith(extension))
    .map((name) => ({
      name,
      fullPath: path.join(directory, name),
      mtime: fs.statSync(path.join(directory, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return hits[0] || null;
}

function openInstallerFromDist(directory) {
  const dmg = latestArtifact(directory, '.dmg');
  if (dmg) {
    console.log(`[install:mac] opening DMG installer: ${dmg.fullPath}`);
    runOrExit('open', [dmg.fullPath], appRoot);
    console.log('[install:mac] installer opened. Drag app to /Applications.');
    return;
  }

  const zip = latestArtifact(directory, '.zip');
  if (zip) {
    console.log(`[install:mac] DMG unavailable. Opening ZIP build: ${zip.fullPath}`);
    runOrExit('open', [zip.fullPath], appRoot);
    console.log('[install:mac] unzip, then move GoSenderr Desktop Agent.app to /Applications.');
    return;
  }

  console.error(`[install:mac] no installer artifacts found in ${directory}`);
  process.exit(1);
}

function buildInstaller() {
  console.log('[install:mac] building mac installer (dmg + zip)...');
  const status = run('npm', ['run', 'dist:mac'], appRoot);
  if (status === 0) {
    return;
  }

  // DMG creation can fail on some macOS setups (hdiutil busy/resource errors).
  console.warn('[install:mac] DMG build failed, falling back to ZIP-only build...');
  runOrExit('npm', ['run', 'dist:mac:zip'], appRoot);
}

if (process.platform !== 'darwin') {
  console.error('install:mac is only supported on macOS.');
  process.exit(1);
}

console.log('[install:mac] running desktop smoke checks...');
runOrExit('npm', ['run', 'smoke'], appRoot);

cleanInstallerArtifacts(distDir);
buildInstaller();
openInstallerFromDist(distDir);
