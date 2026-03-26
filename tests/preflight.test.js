'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runPreflight: runCorePreflight } = require('../core/preflight');
const { runPreflight: runSharedPreflight } = require('../shared-runtime/preflight');

function makeWorkspace() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-agent-preflight-'));
  fs.mkdirSync(path.join(workspaceRoot, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, 'runtime', 'backend', 'agent', 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, 'runtime', 'backend', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'docs', 'BAT_FEATURE_BOARD.md'), '# board\n', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'runtime', 'backend', 'agent', 'runtime', 'runtime_api.py'), 'print("ok")\n', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'runtime', 'backend', 'scripts', 'dev_assistant.py'), 'print("ok")\n', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'runtime', 'backend', 'scripts', 'solo_dev_assistant.py'), 'print("ok")\n', 'utf8');
  return workspaceRoot;
}

function findCheck(report, name) {
  return report.checks.find((item) => item.name === name) || null;
}

test('core preflight accepts runtime-backed assistant script locations', () => {
  const workspaceRoot = makeWorkspace();

  try {
    const report = runCorePreflight(workspaceRoot, {
      pythonRelative: 'missing/python.exe',
    });

    const assistantScripts = findCheck(report, 'assistant scripts');
    assert.equal(assistantScripts?.ok, true);
    assert.match(String(assistantScripts?.detail || ''), /runtime\/backend\/scripts/i);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('shared-runtime preflight accepts runtime-backed runtime api and assistant script locations', () => {
  const workspaceRoot = makeWorkspace();

  try {
    const report = runSharedPreflight(workspaceRoot, {
      pythonRelative: 'missing/python.exe',
    });

    const runtimeApi = findCheck(report, 'runtime api');
    const assistantScripts = findCheck(report, 'assistant scripts');
    assert.equal(runtimeApi?.ok, true);
    assert.equal(assistantScripts?.ok, true);
    assert.match(String(runtimeApi?.detail || ''), /runtime\/backend\/agent\/runtime/i);
    assert.match(String(assistantScripts?.detail || ''), /runtime\/backend\/scripts/i);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});