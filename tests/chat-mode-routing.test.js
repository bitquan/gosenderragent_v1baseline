'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('desktop chat routing keeps ask and plan non-mutating while agent is gated for execution', () => {
  assert.match(mainJs, /function parseChatModeDirective/);
  assert.match(mainJs, /function inferChatModeRouting/);
  assert.match(mainJs, /chatMode !== 'ask' && chatMode !== 'plan'/);
  assert.match(mainJs, /task && chatMode === 'agent'/);
  assert.match(mainJs, /chatMode === 'edit' && !run\?\.runId/);
  assert.match(mainJs, /Switched to \$\{chatMode\.charAt\(0\)\.toUpperCase\(\) \+ chatMode\.slice\(1\)\} mode/);
});
