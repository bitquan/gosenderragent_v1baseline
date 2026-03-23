'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('desktop chat routing keeps ask and plan non-mutating while agent is gated for execution', () => {
  assert.match(mainJs, /function parseChatModeDirective/);
  assert.match(mainJs, /function inferChatModeRouting/);
  assert.match(mainJs, /const effectiveChatMode = resolveChatModeValue\(chatGuidance\.effectiveChatMode \|\| chatMode\)/);
  assert.match(mainJs, /!\['ask', 'plan'\]\.includes\(effectiveChatMode\)/);
  assert.match(mainJs, /task && effectiveChatMode === 'agent'/);
  assert.match(mainJs, /effectiveChatMode === 'edit' && !run\?\.runId/);
  assert.match(mainJs, /effectiveChatMode,/);
  assert.match(mainJs, /Switched to \$\{chatMode\.charAt\(0\)\.toUpperCase\(\) \+ chatMode\.slice\(1\)\} mode/);
  assert.match(mainJs, /Auto mode is on\. I will decide when to stay conversational, when to plan, and when a bounded agent action is actually appropriate\./);
});
