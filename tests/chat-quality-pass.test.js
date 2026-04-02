'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeAssistantChatText,
  selectChatReplyBackend,
  shouldPreferRemoteChatReplies,
} = require('../core/chat-quality');

const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('normal Ask prefers remote-quality routes while coding lanes stay local-first', () => {
  assert.equal(shouldPreferRemoteChatReplies({ chatMode: 'ask' }), true);
  assert.equal(shouldPreferRemoteChatReplies({ suggestedLaneId: 'chat-fast', chatMode: 'edit' }), true);
  assert.equal(shouldPreferRemoteChatReplies({ suggestedLaneId: 'code-main', chatMode: 'ask' }), false);
  assert.equal(shouldPreferRemoteChatReplies({ suggestedTaskMode: 'validator', chatMode: 'plan' }), false);
});

test('host provider selection prefers remote for conversational Ask and falls back to local when remote is unavailable', () => {
  assert.equal(selectChatReplyBackend({
    runtimeMode: 'hybrid',
    hasRemoteKey: true,
    hasLocalCmd: true,
    canUseOllama: true,
    options: { effectiveChatMode: 'ask', suggestedLaneId: 'chat-fast', suggestedTaskMode: 'chat' },
  }), 'openai');
  assert.equal(selectChatReplyBackend({
    runtimeMode: 'openai',
    hasRemoteKey: false,
    hasLocalCmd: true,
    canUseOllama: true,
    options: { effectiveChatMode: 'ask', suggestedLaneId: 'chat-fast', suggestedTaskMode: 'chat' },
  }), 'local');
});

test('coding lanes remain local-first even when a remote key is configured', () => {
  assert.equal(selectChatReplyBackend({
    runtimeMode: 'openai',
    hasRemoteKey: true,
    hasLocalCmd: true,
    canUseOllama: true,
    options: { effectiveChatMode: 'edit', suggestedLaneId: 'code-main', suggestedTaskMode: 'coder' },
  }), 'local');
});

test('local output sanitization strips control tokens, wrappers, and fence-only envelopes', () => {
  const raw = "<|im_start|>assistant\nUnderstood. Let's proceed with your coding request.\n```markdown\nNatural answer.\n<|im_end|>\n```\n";
  assert.equal(sanitizeAssistantChatText(raw), 'Natural answer.');
});

test('local output sanitization removes provider artifacts and raw system-style markers', () => {
  const raw = "Assistant: <<SYS>>\n<think>hidden scratchpad</think>\n```markdown\nClean answer.\n```\n";
  assert.equal(sanitizeAssistantChatText(raw), 'Clean answer.');
});

test('streaming sanitization drops partial control-token leakage', () => {
  assert.equal(sanitizeAssistantChatText('Working on it<|im_sta', { streaming: true }), 'Working on it');
  assert.equal(sanitizeAssistantChatText('Working on it<think', { streaming: true }), 'Working on it');
});

test('mode-aware fallback suggestions use conversational prompts for Ask/auto and operator commands for agent/edit', () => {
  // verify the suggestion function is present and mode-branching is in main.js
  assert.match(mainJs, /function buildAssistantReplySuggestions/);
  assert.match(mainJs, /chatMode === 'plan'/);
  assert.match(mainJs, /chatMode === 'edit' \|\| chatMode === 'agent'/);
  assert.match(mainJs, /Tell me more\./);
  assert.match(mainJs, /What should I do next\?/);
  assert.match(mainJs, /buildAssistantReplySuggestions\(text, reply, \{ chatMode: effectiveChatMode \}\)/);
});