'use strict';

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');

function isExistingDirectory(targetPath) {
  return !!targetPath && fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
}

function resolveRuntimeRoot(appRoot = APP_ROOT) {
  const primary = path.join(appRoot, 'runtime');
  if (isExistingDirectory(primary)) {
    return primary;
  }
  const normalizedRoot = path.resolve(String(appRoot || '').trim());
  if (normalizedRoot.includes('app.asar')) {
    const unpackedRoot = normalizedRoot.replace(/app\.asar/i, 'app.asar.unpacked');
    const unpackedRuntime = path.join(unpackedRoot, 'runtime');
    if (isExistingDirectory(unpackedRuntime)) {
      return unpackedRuntime;
    }
  }
  return primary;
}

const RUNTIME_ROOT = resolveRuntimeRoot(APP_ROOT);

function normalizeDirectory(targetPath) {
  const raw = String(targetPath || '').trim();
  if (!raw) {
    return '';
  }
  const resolved = path.resolve(raw);
  return isExistingDirectory(resolved) ? resolved : '';
}

function getSuggestedWorkspaceRoots() {
  const candidates = [
    process.env.DESKTOP_AGENT_TARGET_WORKSPACE,
    process.env.GOSENDERR_TARGET_WORKSPACE_ROOT,
  ];
  const seen = new Set();
  return candidates
    .map(normalizeDirectory)
    .filter((item) => {
      if (!item || seen.has(item)) {
        return false;
      }
      seen.add(item);
      return true;
    });
}

function resolveTargetWorkspaceRoot(preferredPath = '') {
  const explicit = normalizeDirectory(preferredPath);
  if (explicit) {
    return explicit;
  }
  return '';
}

module.exports = {
  APP_ROOT,
  RUNTIME_ROOT,
  getSuggestedWorkspaceRoots,
  isExistingDirectory,
  normalizeDirectory,
  resolveRuntimeRoot,
  resolveTargetWorkspaceRoot,
};
