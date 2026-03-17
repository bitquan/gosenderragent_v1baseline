'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildVsCodeExtensionHealth,
  listLegacyExtensionRoots,
  resolveExtensionRoot,
} = require('../core/vscode-extension-health');

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gos-extension-health-'));
}

test('buildVsCodeExtensionHealth reports missing extension when no package exists', () => {
  const workspaceRoot = makeWorkspace();
  const health = buildVsCodeExtensionHealth(workspaceRoot);

  assert.equal(health.ok, true);
  assert.equal(health.exists, false);
  assert.match(String(health.summary || ''), /No VS Code extension/i);
});

test('buildVsCodeExtensionHealth prefers the real companion path and flags stub drift', () => {
  const workspaceRoot = makeWorkspace();
  const extensionRoot = path.join(workspaceRoot, 'integration-library', 'extensions', 'vscode-companion');
  const legacyExtensionRoot = path.join(workspaceRoot, 'tools', 'vscode-dev-assistant-extension');
  fs.mkdirSync(path.join(extensionRoot, 'src'), { recursive: true });
  fs.mkdirSync(legacyExtensionRoot, { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, 'tools', 'gosenderr-desktop-agent'), { recursive: true });
  fs.writeFileSync(path.join(extensionRoot, 'package.json'), JSON.stringify({
    name: 'gosenderr-vscode-companion',
    displayName: 'GoSenderr VS Code Companion',
    version: '0.1.0',
    main: './out/extension.js',
    contributes: {
      commands: [{ command: 'gosenderr.openDesktopAgent' }],
    },
  }, null, 2));
  fs.writeFileSync(path.join(extensionRoot, 'src', 'extension.ts'), [
    "import * as vscode from 'vscode';",
    'export function activate(context: vscode.ExtensionContext) {',
    "  context.subscriptions.push(vscode.commands.registerCommand('gosenderr.openDesktopAgent', async () => {",
    "    await vscode.window.showInformationMessage('Open the GoSenderr Desktop Agent and sync the current workspace.');",
    '  }));',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(legacyExtensionRoot, 'package.json'), JSON.stringify({
    name: 'legacy-vscode-extension',
    displayName: 'Legacy GoSenderr Extension',
    version: '0.0.1',
    engines: { vscode: '^1.95.0' },
  }, null, 2));

  const health = buildVsCodeExtensionHealth(workspaceRoot);

  assert.equal(health.exists, true);
  assert.equal(health.status, 'needs-attention');
  assert.equal(resolveExtensionRoot(workspaceRoot), extensionRoot);
  assert.deepEqual(listLegacyExtensionRoots(workspaceRoot, extensionRoot), [legacyExtensionRoot]);
  assert.ok(Array.isArray(health.warnings));
  assert.ok(health.warnings.some((warning) => /build output is missing/i.test(warning)));
  assert.ok(health.warnings.some((warning) => /no scripts/i.test(warning)));
  assert.ok(health.warnings.some((warning) => /still a stub/i.test(warning)));
  assert.ok(health.warnings.some((warning) => /legacy vs code extension copies/i.test(warning)));
  assert.ok(health.warnings.some((warning) => /legacy in-repo desktop copy/i.test(warning)));
});

test('buildVsCodeExtensionHealth ignores a retired breadcrumb-only desktop folder', () => {
  const workspaceRoot = makeWorkspace();
  const extensionRoot = path.join(workspaceRoot, 'integration-library', 'extensions', 'vscode-companion');
  const legacyDesktopRoot = path.join(workspaceRoot, 'tools', 'gosenderr-desktop-agent');
  fs.mkdirSync(path.join(extensionRoot, 'out'), { recursive: true });
  fs.mkdirSync(legacyDesktopRoot, { recursive: true });
  fs.writeFileSync(path.join(extensionRoot, 'package.json'), JSON.stringify({
    name: 'gosenderr-vscode-companion',
    displayName: 'GoSenderr VS Code Companion',
    version: '0.1.0',
    main: './out/extension.js',
    scripts: {
      test: 'node --test tests/*.js',
    },
    contributes: {
      commands: [
        { command: 'gosenderr.openDesktopAgent' },
        { command: 'gosenderr.openWorkbench' },
      ],
    },
  }, null, 2));
  fs.writeFileSync(path.join(extensionRoot, 'out', 'extension.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(legacyDesktopRoot, 'README.md'), '# Retired\n');

  const health = buildVsCodeExtensionHealth(workspaceRoot);

  assert.equal(health.exists, true);
  assert.ok(!health.warnings.some((warning) => /legacy in-repo desktop copy/i.test(warning)));
  assert.ok(!health.warnings.some((warning) => /still a stub/i.test(warning)));
});
