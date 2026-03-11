#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const sourceCoreDir = path.resolve(appRoot, '..', 'vscode-dev-assistant-extension', 'core');
const targetCoreDir = path.resolve(appRoot, 'core');
const sourceSharedRuntimeDir = path.resolve(appRoot, '..', 'vscode-dev-assistant-extension', 'shared-runtime');
const targetSharedRuntimeDir = path.resolve(appRoot, 'shared-runtime');

function fail(message) {
  console.error(`[sync:core] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(sourceCoreDir)) {
  fail(`source core directory not found: ${sourceCoreDir}`);
}

if (!fs.existsSync(sourceSharedRuntimeDir)) {
  fail(`source shared-runtime directory not found: ${sourceSharedRuntimeDir}`);
}

fs.rmSync(targetCoreDir, { recursive: true, force: true });
fs.mkdirSync(targetCoreDir, { recursive: true });
fs.cpSync(sourceCoreDir, targetCoreDir, { recursive: true, force: true });

fs.rmSync(targetSharedRuntimeDir, { recursive: true, force: true });
fs.mkdirSync(targetSharedRuntimeDir, { recursive: true });
fs.cpSync(sourceSharedRuntimeDir, targetSharedRuntimeDir, { recursive: true, force: true });

console.log(`[sync:core] copied shared core from ${sourceCoreDir} -> ${targetCoreDir}`);
console.log(`[sync:core] copied shared runtime from ${sourceSharedRuntimeDir} -> ${targetSharedRuntimeDir}`);
