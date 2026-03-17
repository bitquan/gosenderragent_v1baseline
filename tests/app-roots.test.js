'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const appRoots = require('../core/app-roots');

test('resolveTargetWorkspaceRoot requires an explicit existing directory', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-app-roots-'));
  const previousDesktopTarget = process.env.DESKTOP_AGENT_TARGET_WORKSPACE;
  const previousLegacyTarget = process.env.GOSENDERR_TARGET_WORKSPACE_ROOT;
  try {
    process.env.DESKTOP_AGENT_TARGET_WORKSPACE = tempRoot;
    process.env.GOSENDERR_TARGET_WORKSPACE_ROOT = tempRoot;
    assert.equal(appRoots.resolveTargetWorkspaceRoot(), '');
    assert.equal(appRoots.resolveTargetWorkspaceRoot(tempRoot), tempRoot);
  } finally {
    if (previousDesktopTarget === undefined) {
      delete process.env.DESKTOP_AGENT_TARGET_WORKSPACE;
    } else {
      process.env.DESKTOP_AGENT_TARGET_WORKSPACE = previousDesktopTarget;
    }
    if (previousLegacyTarget === undefined) {
      delete process.env.GOSENDERR_TARGET_WORKSPACE_ROOT;
    } else {
      process.env.GOSENDERR_TARGET_WORKSPACE_ROOT = previousLegacyTarget;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('getSuggestedWorkspaceRoots keeps explicit environment suggestions without auto-selecting them', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-app-roots-suggest-'));
  const previousDesktopTarget = process.env.DESKTOP_AGENT_TARGET_WORKSPACE;
  const previousLegacyTarget = process.env.GOSENDERR_TARGET_WORKSPACE_ROOT;
  try {
    process.env.DESKTOP_AGENT_TARGET_WORKSPACE = tempRoot;
    process.env.GOSENDERR_TARGET_WORKSPACE_ROOT = tempRoot;
    assert.deepEqual(appRoots.getSuggestedWorkspaceRoots(), [tempRoot]);
  } finally {
    if (previousDesktopTarget === undefined) {
      delete process.env.DESKTOP_AGENT_TARGET_WORKSPACE;
    } else {
      process.env.DESKTOP_AGENT_TARGET_WORKSPACE = previousDesktopTarget;
    }
    if (previousLegacyTarget === undefined) {
      delete process.env.GOSENDERR_TARGET_WORKSPACE_ROOT;
    } else {
      process.env.GOSENDERR_TARGET_WORKSPACE_ROOT = previousLegacyTarget;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
