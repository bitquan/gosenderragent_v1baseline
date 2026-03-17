#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const requiredDirs = [
  path.resolve(appRoot, 'core'),
  path.resolve(appRoot, 'shared-runtime'),
  path.resolve(appRoot, 'shared-ui'),
  path.resolve(appRoot, 'runtime'),
];

function fail(message) {
  console.error(`[sync:core] ${message}`);
  process.exit(1);
}

for (const directory of requiredDirs) {
  if (!fs.existsSync(directory)) {
    fail(`required local directory not found: ${directory}`);
  }
}
console.log('[sync:core] standalone repo already owns core, shared runtime, shared ui, and bundled runtime code.');
