'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildIntegrationStudioStatus,
  installIntegration,
} = require('../core/integration-studio');

const APP_ROOT = path.resolve(__dirname, '..');

test('integration studio lists the starter plugin, adapter, and extension library', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-integrations-'));
  const status = buildIntegrationStudioStatus(workspaceRoot, { appRoot: APP_ROOT });

  assert.equal(status.ok, true);
  assert.equal(status.library.some((item) => item.id === 'docs-companion-plugin' && item.kind === 'plugin'), true);
  assert.equal(status.library.some((item) => item.id === 'openai-compatible-router-adapter' && item.kind === 'adapter'), true);
  assert.equal(status.library.some((item) => item.id === 'vscode-companion-extension' && item.kind === 'extension'), true);
});

test('integration studio can install a built-in sample into the target workspace', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-integrations-install-'));
  const result = installIntegration(workspaceRoot, {
    integrationId: 'vscode-companion-extension',
  }, { appRoot: APP_ROOT });

  const installedRoot = path.join(workspaceRoot, '.gos-integrations', 'extensions', 'vscode-companion-extension');
  assert.equal(result.ok, true);
  assert.equal(result.installed, true);
  assert.equal(fs.existsSync(path.join(installedRoot, 'integration.json')), true);
  assert.equal(fs.existsSync(path.join(installedRoot, 'package.json')), true);
  assert.equal(result.studio.installed.some((item) => item.id === 'vscode-companion-extension'), true);
});
