'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const preloadJs = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

test('preload exposes renderer error reporting through the shared desktop bridge', () => {
  assert.match(preloadJs, /reportRendererError:\s*\(payload = \{\}\) => ipcRenderer\.invoke\('app:reportRendererError', payload\)/);
  assert.match(preloadJs, /reportRendererError: appApi\.reportRendererError/);
});

test('preload exposes checkpoint merge lifecycle actions through tuning', () => {
  assert.match(preloadJs, /mergeCheckpoints:\s*wrapInvoke\('tuning:mergeCheckpoints'\)/);
  assert.match(preloadJs, /tuning:\s*tuningApi/);
});
