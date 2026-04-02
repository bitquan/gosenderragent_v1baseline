'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildVsCodeSetupStatus,
  bootstrapVsCodeWorkspace,
  installVsCodeCompanion,
  resolveVsCodeCompanionRoot,
} = require('../core/vscode-setup');

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gos-vscode-setup-'));
}

test('buildVsCodeSetupStatus detects missing files, recommendations, and tasks', () => {
  const workspaceRoot = makeWorkspace();
  fs.writeFileSync(path.join(workspaceRoot, 'package.json'), JSON.stringify({
    name: 'desktop-agent-test',
    scripts: {
      test: 'node --test',
      smoke: 'node scripts/smoke.js',
      'smoke:ui': 'node scripts/ui-smoke.js',
      typecheck: 'tsc --noEmit',
      'engine:acceptance': 'node scripts/engine-acceptance.js',
    },
  }, null, 2));
  fs.writeFileSync(path.join(workspaceRoot, 'tsconfig.json'), '{}\n');

  const status = buildVsCodeSetupStatus(workspaceRoot);

  assert.equal(status.ok, true);
  assert.deepEqual(status.missingFiles, ['extensions', 'settings', 'tasks']);
  assert.ok(status.missingRecommendations.includes('dbaeumer.vscode-eslint'));
  assert.ok(status.missingTaskLabels.includes('Desktop Agent: Test'));
});

test('bootstrapVsCodeWorkspace writes recommended files and removes missing items', () => {
  const workspaceRoot = makeWorkspace();
  fs.writeFileSync(path.join(workspaceRoot, 'package.json'), JSON.stringify({
    name: 'desktop-agent-test',
    scripts: {
      test: 'node --test',
      typecheck: 'tsc --noEmit',
    },
  }, null, 2));

  const result = bootstrapVsCodeWorkspace(workspaceRoot);

  assert.equal(result.ok, true);
  assert.equal(result.status.missingFiles.length, 0);
  assert.equal(result.status.missingRecommendations.length, 0);
  assert.equal(result.status.missingTaskLabels.length, 0);

  const extensions = JSON.parse(fs.readFileSync(path.join(workspaceRoot, '.vscode', 'extensions.json'), 'utf8'));
  const settings = JSON.parse(fs.readFileSync(path.join(workspaceRoot, '.vscode', 'settings.json'), 'utf8'));
  const tasks = JSON.parse(fs.readFileSync(path.join(workspaceRoot, '.vscode', 'tasks.json'), 'utf8'));

  assert.ok(Array.isArray(extensions.recommendations));
  assert.equal(settings['editor.formatOnSave'], true);
  assert.ok(Array.isArray(tasks.tasks));
  assert.ok(tasks.tasks.some((task) => String(task.label || '') === 'Desktop Agent: Test'));
});

test('buildVsCodeSetupStatus resolves the real companion path before legacy extension copies', () => {
  const workspaceRoot = makeWorkspace();
  const companionRoot = path.join(workspaceRoot, 'integration-library', 'extensions', 'vscode-companion');
  const legacyRoot = path.join(workspaceRoot, 'tools', 'vscode-dev-assistant-extension');
  fs.mkdirSync(path.join(companionRoot, 'src'), { recursive: true });
  fs.mkdirSync(legacyRoot, { recursive: true });
  fs.writeFileSync(path.join(companionRoot, 'package.json'), JSON.stringify({
    name: 'gosenderr-vscode-companion',
    engines: { vscode: '^1.95.0' },
    contributes: { commands: [{ command: 'gosenderr.openDesktopAgent' }] },
  }, null, 2));
  fs.writeFileSync(path.join(companionRoot, 'src', 'extension.ts'), 'export function activate() {}\n');
  fs.writeFileSync(path.join(legacyRoot, 'package.json'), JSON.stringify({
    name: 'legacy-vscode-extension',
    engines: { vscode: '^1.95.0' },
  }, null, 2));

  const status = buildVsCodeSetupStatus(workspaceRoot);

  assert.equal(resolveVsCodeCompanionRoot(workspaceRoot), companionRoot);
  assert.equal(status.capabilities.hasExtensionEntry, true);
  assert.equal(status.companionExtensionRoot, companionRoot);
  assert.deepEqual(status.legacyExtensionRoots, [legacyRoot]);
});

test('installVsCodeCompanion copies the real companion into the user extensions root and updates status', () => {
  const workspaceRoot = makeWorkspace();
  const companionRoot = path.join(workspaceRoot, 'integration-library', 'extensions', 'vscode-companion');
  const extensionsRoot = path.join(workspaceRoot, '.tmp-vscode-extensions');
  fs.mkdirSync(companionRoot, { recursive: true });
  fs.writeFileSync(path.join(companionRoot, 'package.json'), JSON.stringify({
    name: 'gosenderr-vscode-companion',
    publisher: 'gosenderr',
    displayName: 'GoSenderr VS Code Companion',
    version: '0.1.0',
    main: './extension.js',
    engines: { vscode: '^1.95.0' },
    contributes: { commands: [{ command: 'gosenderr.openWorkbench' }] },
  }, null, 2));
  fs.writeFileSync(path.join(companionRoot, 'integration.json'), JSON.stringify({
    id: 'vscode-companion-extension',
    kind: 'extension',
    version: '0.1.0',
  }, null, 2));
  fs.writeFileSync(path.join(companionRoot, 'extension.js'), 'module.exports = {};\n');

  const result = installVsCodeCompanion(workspaceRoot, {
    extensionsRoot,
    cliCommand: 'code.cmd',
  });

  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(path.join(result.installRoot, 'package.json')));
  assert.match(path.basename(result.installRoot), /^gosenderr\.gosenderr-vscode-companion-0\.1\.0$/);
  assert.equal(result.status.companionInstall.installed, true);
  assert.equal(result.status.companionInstall.installRoot, result.installRoot);
  assert.equal(result.status.companionInstall.publisher, 'gosenderr');
  assert.equal(result.status.companionInstall.versionMismatch, false);
  assert.equal(result.status.companionInstall.metadataVersionMismatch, false);
});

test('buildVsCodeSetupStatus flags companion install version drift and metadata drift', () => {
  const workspaceRoot = makeWorkspace();
  const companionRoot = path.join(workspaceRoot, 'integration-library', 'extensions', 'vscode-companion');
  const extensionsRoot = path.join(workspaceRoot, '.tmp-vscode-extensions');
  const installedRoot = path.join(extensionsRoot, 'gosenderr.gosenderr-vscode-companion-0.1.2');
  fs.mkdirSync(companionRoot, { recursive: true });
  fs.mkdirSync(installedRoot, { recursive: true });
  fs.writeFileSync(path.join(companionRoot, 'package.json'), JSON.stringify({
    name: 'gosenderr-vscode-companion',
    publisher: 'gosenderr',
    version: '0.1.3',
    main: './extension.js',
    engines: { vscode: '^1.95.0' },
    contributes: { commands: [{ command: 'gosenderr.openWorkbench' }] },
  }, null, 2));
  fs.writeFileSync(path.join(companionRoot, 'integration.json'), JSON.stringify({
    id: 'vscode-companion-extension',
    kind: 'extension',
    version: '0.1.0',
  }, null, 2));
  fs.writeFileSync(path.join(companionRoot, 'extension.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(installedRoot, 'package.json'), JSON.stringify({
    name: 'gosenderr-vscode-companion',
    publisher: 'gosenderr',
    version: '0.1.2',
  }, null, 2));

  const status = buildVsCodeSetupStatus(workspaceRoot, { extensionsRoot, cliCommand: 'code.cmd' });

  assert.equal(status.status, 'needs-attention');
  assert.equal(status.companionInstall.installed, true);
  assert.equal(status.companionInstall.versionMismatch, true);
  assert.equal(status.companionInstall.installedVersion, '0.1.2');
  assert.equal(status.companionInstall.metadataVersionMismatch, true);
  assert.deepEqual(status.companionInstall.staleInstallRoots, [installedRoot]);
  assert.ok(status.setupWarnings.some((warning) => /installed companion version 0\.1\.2/i.test(warning)));
  assert.ok(status.setupWarnings.some((warning) => /integration metadata version/i.test(warning)));
});
