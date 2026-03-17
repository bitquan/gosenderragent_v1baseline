'use strict';

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');
const RUNTIME_ROOT = path.join(APP_ROOT, 'runtime');

function isExistingDirectory(targetPath) {
  return !!targetPath && fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
}

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
  resolveTargetWorkspaceRoot,
};
