#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveTargetWorkspaceRoot } = require('../core/app-roots');

const appRoot = path.resolve(__dirname, '..');
const workspaceRoot = resolveTargetWorkspaceRoot(process.env.DESKTOP_AGENT_TARGET_WORKSPACE);

const requiredFiles = [
  'main.js',
  'preload.js',
  'renderer/index.html',
  'renderer/styles.css',
  'renderer/app.js',
  'shared-runtime/runtime.js',
  'core/preflight.js',
  'core/updater.js',
  'core/chat.js',
  'core/review.js',
];

const requiredFunctionSnippets = [
  'data-workbench-shell',
  'data-panel',
  'data-inspector-tab',
  'data-settings-tab',
  'data-file-editor',
];

const requiredMainSnippets = [
  "ipcMain.handle('assistant:chat'",
];

const requiredPreloadSnippets = [
  'chatMessage: (text, workspace = \'\', options = {})',
];

const syntaxCheckFiles = [
  'main.js',
  'preload.js',
  'renderer/app.js',
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

for (const rel of requiredFiles) {
  const full = path.resolve(appRoot, rel);
  assert(fs.existsSync(full), `Missing required file: ${rel}`);
}

for (const rel of syntaxCheckFiles) {
  const full = path.resolve(appRoot, rel);
  const parsed = spawnSync(process.execPath, ['--check', full], {
    cwd: appRoot,
    encoding: 'utf8',
  });
  assert(parsed.status === 0, `Syntax check failed for ${rel}:\n${parsed.stderr || parsed.stdout}`);
}

const rendererSource = fs.readFileSync(path.resolve(appRoot, 'renderer/app.js'), 'utf8');
for (const snippet of requiredFunctionSnippets) {
  assert(
    rendererSource.includes(snippet),
    `Renderer guard failed: missing required snippet "${snippet}" in renderer/app.js`,
  );
}

const mainSource = fs.readFileSync(path.resolve(appRoot, 'main.js'), 'utf8');
for (const snippet of requiredMainSnippets) {
  assert(
    mainSource.includes(snippet),
    `Desktop guard failed: missing required snippet "${snippet}" in main.js`,
  );
}

const preloadSource = fs.readFileSync(path.resolve(appRoot, 'preload.js'), 'utf8');
for (const snippet of requiredPreloadSnippets) {
  assert(
    preloadSource.includes(snippet),
    `Desktop guard failed: missing required snippet "${snippet}" in preload.js`,
  );
}

const { SharedAgentRuntime } = require(path.resolve(appRoot, 'shared-runtime/runtime.js'));
const { runPreflight } = require(path.resolve(appRoot, 'core/preflight.js'));
const { listSkills } = require(path.resolve(appRoot, 'core/skills.js'));
const { listAutomations } = require(path.resolve(appRoot, 'core/automations.js'));
const { checkForUpdates } = require(path.resolve(appRoot, 'core/updater.js'));

if (workspaceRoot) {
  const preflight = runPreflight(workspaceRoot, { requireGh: false });
  assert(Array.isArray(preflight.checks), 'Preflight checks must be an array.');

  const runtime = new SharedAgentRuntime({ workspaceRoot, pythonRelative: 'backend/.venv/bin/python' });
  const status = runtime.getStatus();
  assert(status && Array.isArray(status.latest), 'Runtime status.latest missing.');
  assert(Array.isArray(status.activeRuns), 'Runtime status.activeRuns missing.');

  const skills = listSkills(workspaceRoot);
  assert(Array.isArray(skills), 'Skills list must be an array.');

  const automations = listAutomations(workspaceRoot);
  assert(Array.isArray(automations), 'Automations list must be an array.');

  const updates = checkForUpdates(workspaceRoot);
  assert(typeof updates.ok === 'boolean', 'Updates check payload malformed.');

  console.log('[smoke] workspace =', workspaceRoot);
  console.log('[smoke] preflight ready =', preflight.ready, 'checks =', preflight.checks.length);
  console.log('[smoke] skills =', skills.length, 'automations =', automations.length);
  console.log('[smoke] updates check ok =', updates.ok, 'hasUpdates =', updates.hasUpdates);
} else {
  console.log('[smoke] workspace = <not selected>');
  console.log('[smoke] startup empty-state is valid; use Pick workspace in the app to continue.');
}

console.log('[smoke] syntax checks PASS for main/preload/renderer app');
console.log('[smoke] renderer guard checks PASS for core UI handlers');
console.log('[smoke] host guard checks PASS for shared chat bridge');
console.log('[smoke] desktop core validation PASS');
