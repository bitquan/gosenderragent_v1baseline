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
  assert.match(mainJs, /const shouldGroundAskReply = effectiveChatMode === 'ask' && shouldUseGroundedAskReply\(text\)/);
  assert.match(mainJs, /effectiveChatMode === 'plan' \|\| shouldGroundAskReply/);
  assert.match(mainJs, /task && effectiveChatMode === 'agent'/);
  assert.match(mainJs, /effectiveChatMode === 'edit' && !run\?\.runId/);
  assert.match(mainJs, /effectiveChatMode,/);
  assert.match(mainJs, /Switched to \$\{chatMode\.charAt\(0\)\.toUpperCase\(\) \+ chatMode\.slice\(1\)\} mode/);
  assert.match(mainJs, /Auto mode is on\. I will decide when to stay conversational, when to plan, and when a bounded agent action is actually appropriate\./);
});

test('desktop hybrid chat can prefer remote-quality replies for conversational lanes while keeping code lanes local-first', () => {
  assert.match(mainJs, /function shouldPreferRemoteChatReplies/);
  assert.match(mainJs, /shouldUseCodingChatContext\(/);
  assert.match(mainJs, /REMOTE_CHAT_QUALITY_LANES = new Set\(\['chat-fast', 'plan-reasoning', 'research-docs', 'ops-summary'\]\)/);
  assert.match(mainJs, /LOCAL_FIRST_CHAT_LANES = new Set\(\['code-main', 'repair-fast', 'review-verify'\]\)/);
  assert.match(mainJs, /chatMode === 'ask' \|\| chatMode === 'plan'/);
  assert.match(mainJs, /runtimeMode === 'hybrid' && preferRemoteChat && hasSecret/);
  assert.match(mainJs, /suggestedLaneId: options\.suggestedLaneId \|\| chatGuidance\.suggestedLaneId/);
  assert.match(mainJs, /suggestedTaskMode: options\.suggestedTaskMode \|\| chatGuidance\.suggestedTaskMode/);
});
