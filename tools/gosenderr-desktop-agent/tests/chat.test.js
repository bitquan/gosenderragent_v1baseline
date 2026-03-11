'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleAssistantChat } = require('../core/chat');

test('stop alias delegates to host stop callback', async () => {
  let called = 0;
  const reply = await handleAssistantChat('/workspace', '/stop', {
    stop: async () => {
      called += 1;
      return 'Stop signal sent to the latest active run.';
    },
  });

  assert.equal(called, 1);
  assert.equal(reply, 'Stop signal sent to the latest active run.');
});

test('newline-delimited slash commands are processed sequentially', async () => {
  const seen = [];
  const reply = await handleAssistantChat('/workspace', '/next\n/files', {
    next: async () => {
      seen.push('next');
      return 'Next TODO: BAT<179>';
    },
    files: async () => {
      seen.push('files');
      return 'Repository clean.';
    },
  });

  assert.deepEqual(seen, ['next', 'files']);
  assert.equal(reply, 'Next TODO: BAT<179> Repository clean.');
});
