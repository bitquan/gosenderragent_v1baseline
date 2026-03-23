'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveRuntimeRoot } = require('../core/app-roots');

test('resolveRuntimeRoot prefers the unpacked runtime when the app root is inside app.asar', () => {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-runtime-root-'));
  const packagedRoot = path.join(sandboxRoot, 'resources', 'app.asar');
  const unpackedRuntime = path.join(sandboxRoot, 'resources', 'app.asar.unpacked', 'runtime');
  fs.mkdirSync(packagedRoot, { recursive: true });
  fs.mkdirSync(unpackedRuntime, { recursive: true });

  assert.equal(resolveRuntimeRoot(packagedRoot), unpackedRuntime);

  fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

test('resolveRuntimeRoot keeps the direct runtime path in dev checkouts', () => {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-runtime-root-dev-'));
  const runtimeRoot = path.join(sandboxRoot, 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });

  assert.equal(resolveRuntimeRoot(sandboxRoot), runtimeRoot);

  fs.rmSync(sandboxRoot, { recursive: true, force: true });
});
