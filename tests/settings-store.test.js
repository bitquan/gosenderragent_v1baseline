'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createResilientStore,
  recoverStoreFile,
  resolveStorePath,
  stripUtf8Bom,
} = require('../core/settings-store');

test('stripUtf8Bom removes a leading BOM only once', () => {
  assert.equal(stripUtf8Bom('\uFEFF{"ok":true}'), '{"ok":true}');
  assert.equal(stripUtf8Bom('{"ok":true}'), '{"ok":true}');
});

test('recoverStoreFile rewrites BOM-prefixed JSON as UTF-8 without BOM', () => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-store-bom-'));
  const storePath = resolveStorePath(userDataRoot, 'desktop-agent-settings');
  fs.writeFileSync(storePath, Buffer.from('\uFEFF{"workspaceRoot":"E:/dev/projects"}', 'utf8'));

  try {
    const result = recoverStoreFile(storePath);
    const bytes = fs.readFileSync(storePath);
    assert.equal(result.recovered, true);
    assert.equal(bytes[0], 0x7b);
    assert.deepEqual(JSON.parse(bytes.toString('utf8')), { workspaceRoot: 'E:/dev/projects' });
  } finally {
    fs.rmSync(userDataRoot, { recursive: true, force: true });
  }
});

test('createResilientStore recovers from BOM-prefixed JSON before retrying', () => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-store-retry-'));
  const storePath = resolveStorePath(userDataRoot, 'desktop-agent-settings');
  fs.writeFileSync(storePath, Buffer.from('\uFEFF{"workspaceRoot":"E:/dev/projects"}', 'utf8'));

  class FakeStore {
    constructor(options = {}) {
      const filePath = resolveStorePath(options.userDataRoot, options.name);
      const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
      const parsed = raw ? JSON.parse(raw) : {};
      this.store = { ...options.defaults, ...parsed };
    }
  }

  try {
    const store = createResilientStore(FakeStore, {
      userDataRoot,
      name: 'desktop-agent-settings',
      defaults: { workspaceRoot: '' },
    });
    assert.equal(store.store.workspaceRoot, 'E:/dev/projects');
  } finally {
    fs.rmSync(userDataRoot, { recursive: true, force: true });
  }
});

test('recoverStoreFile backs up invalid JSON so a fresh store can be created', () => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-store-corrupt-'));
  const storePath = resolveStorePath(userDataRoot, 'desktop-agent-settings');
  fs.writeFileSync(storePath, '{invalid-json', 'utf8');

  try {
    const result = recoverStoreFile(storePath);
    assert.equal(result.reset, true);
    assert.equal(fs.existsSync(storePath), false);
    assert.equal(fs.existsSync(result.backupPath), true);
  } finally {
    fs.rmSync(userDataRoot, { recursive: true, force: true });
  }
});
