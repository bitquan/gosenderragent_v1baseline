'use strict';

const fs = require('fs');
const path = require('path');

function stripUtf8Bom(text = '') {
  return String(text || '').replace(/^\uFEFF/, '');
}

function resolveStorePath(userDataRoot, storeName) {
  const root = path.resolve(String(userDataRoot || '.'));
  const name = String(storeName || 'config').trim() || 'config';
  return path.join(root, `${name}.json`);
}

function writeJsonUtf8(storePath, value) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

function recoverStoreFile(storePath) {
  if (!storePath || !fs.existsSync(storePath)) {
    return { recovered: false, reset: false, backupPath: '' };
  }

  const raw = fs.readFileSync(storePath, 'utf8');
  const sanitized = stripUtf8Bom(raw);

  try {
    const parsed = JSON.parse(sanitized);
    if (sanitized !== raw) {
      writeJsonUtf8(storePath, parsed);
      return { recovered: true, reset: false, backupPath: '' };
    }
    return { recovered: false, reset: false, backupPath: '' };
  } catch (_error) {
    const backupPath = `${storePath}.corrupt-${Date.now()}`;
    fs.renameSync(storePath, backupPath);
    return { recovered: false, reset: true, backupPath };
  }
}

function createResilientStore(StoreClass, options = {}) {
  try {
    return new StoreClass(options);
  } catch (error) {
    const storePath = resolveStorePath(options.userDataRoot, options.name);
    const recovery = recoverStoreFile(storePath);
    if (!recovery.recovered && !recovery.reset) {
      throw error;
    }
    return new StoreClass(options);
  }
}

module.exports = {
  createResilientStore,
  recoverStoreFile,
  resolveStorePath,
  stripUtf8Bom,
};
