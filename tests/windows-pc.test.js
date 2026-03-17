'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  buildWindowsPcFiles,
  buildWindowsPcPackage,
  defaultWindowsPcCloneRoot,
  resolveWindowsPcCloneRoot,
} = require('../core/windows-pc');

test('buildWindowsPcPackage rewrites product metadata for the PC clone', () => {
  const next = buildWindowsPcPackage({
    name: 'gosenderr-desktop-agent',
    productName: 'GoSenderr Desktop Agent',
    build: {
      appId: 'com.gosenderr.desktop.agent',
    },
  });

  assert.equal(next.name, 'gosenderr-desktop-agent-pc');
  assert.equal(next.productName, 'GoSenderr Desktop Agent PC');
  assert.equal(next.build.appId, 'com.gosenderr.desktop.agent.pc');
});

test('resolveWindowsPcCloneRoot falls back to the external SSD path', () => {
  assert.equal(defaultWindowsPcCloneRoot(), '/Volumes/projects/gosenderr-desktop-agent-PC');
  assert.equal(resolveWindowsPcCloneRoot(), '/Volumes/projects/gosenderr-desktop-agent-PC');
  assert.equal(resolveWindowsPcCloneRoot('custom-folder'), '/Volumes/projects/custom-folder');
});

test('buildWindowsPcFiles returns VS Code tasks, Windows scripts, and a guide', () => {
  const files = buildWindowsPcFiles({
    sourceRoot: '/Users/papadev/dev/gosenderr-desktop-agent',
    targetRoot: '/Volumes/projects/gosenderr-desktop-agent-PC',
  });

  assert.match(String(files['.vscode/tasks.json'] || ''), /Desktop Agent PC: Validate/);
  assert.match(String(files['.vscode/tasks.json'] || ''), /Desktop Agent PC: Install recommended models/);
  assert.match(String(files['scripts/windows/bootstrap.ps1'] || ''), /npm install/);
  assert.match(String(files['scripts/windows/package.ps1'] || ''), /npm run dist:win:x64/);
  assert.match(String(files['scripts/windows/install-models.ps1'] || ''), /ollama pull|huggingface_hub/i);
  assert.match(String(files['WINDOWS_HOW_TO/README.md'] || ''), /PowerShell/);
  assert.match(String(files['WINDOWS_HOW_TO/README.md'] || ''), /Command Prompt/);
  assert.match(String(files['WINDOWS_HOW_TO/README.md'] || ''), /RTX 4060/i);
  assert.match(String(files['dev_assistant.local.yaml.example'] || ''), /assistant_training_hardware_target: windows-i9-32gb-rtx4060-8gb/);
  assert.match(String(files['WINDOWS_APP/README.md'] || ''), /package a Windows build on the PC/i);
});

test('buildWindowsPcFiles defaults the source root to the current app repo', () => {
  const files = buildWindowsPcFiles();
  const cloneMeta = JSON.parse(String(files['windows-pc.clone.json'] || '{}'));
  assert.equal(cloneMeta.generatedFrom, path.resolve(__dirname, '..'));
});
