'use strict';

const REMOTE_PREFERRED_CHAT_LANES = new Set(['chat-fast', 'plan-reasoning', 'research-docs', 'ops-summary']);
const LOCAL_FIRST_CHAT_LANES = new Set(['code-main', 'repair-fast', 'review-verify']);
const REMOTE_PREFERRED_CHAT_TASK_MODES = new Set(['chat', 'planner', 'research', 'summarizer']);
const LOCAL_FIRST_CHAT_TASK_MODES = new Set(['coder', 'repair', 'validator']);

const MODEL_CONTROL_TOKEN_RE = /<\|[^>\r\n]{1,80}\|>/gi;
const TRAILING_PARTIAL_CONTROL_TOKEN_RE = /(?:<\|[^\n<>]{0,80})$/i;
const TRAILING_PARTIAL_XML_MARKER_RE = /(?:<\/?(?:assistant|system|user|human|response|analysis|final|think|thinking)[^>\n]{0,80})$/i;
const XML_ROLE_MARKER_RE = /<\/?(?:assistant|system|user)>/gi;
const PROVIDER_TAG_TOKEN_RE = /<<\/?(?:sys|system|assistant|user|context|response|analysis|final)>>?/gi;
const THINK_BLOCK_RE = /<(?:think|thinking|analysis)>[\s\S]*?<\/(?:think|thinking|analysis)>/gi;
const LLAMA_ROLE_LINE_RE = /(?:^|\n)\s*(?:assistant|system|user|human)\s*:?\s*(?=\n|$)/gi;
const MARKDOWN_FENCE_ONLY_RE = /^```(?:markdown|md|text|plain)?\s*\n([\s\S]*?)\n```\s*$/i;
const MARKDOWN_FENCE_LINE_RE = /^```(?:markdown|md|text|plain)\s*$/i;
const CLOSING_FENCE_LINE_RE = /^```\s*$/;
const BOUNDARY_MARKER_LINE_RE = /^\s*(?:#{1,6}\s*)?(?:\[(?:\/)?(?:assistant|system|user|human|response|analysis|final|developer)\]|<\/?(?:assistant|system|user|human|response|analysis|final|developer)>|<<\/?(?:sys|system|assistant|user|context|response|analysis|final)>>?)\s*:?\s*$/i;
const LEADING_ROLE_PREFIX_RE = /^\s*(?:#{1,6}\s*)?(?:(?:assistant|system|user|human|response|analysis|final|developer|assistant response|assistant reply)\s*:\s*|\[(?:assistant|response|answer)\]\s*)/i;
const KNOWN_LEADING_WRAPPERS = [
  /^\s*understood\.\s+let'?s proceed with your coding request\.?(?:\s+|$)/i,
  /^\s*please provide the details of what you need assistance with, and i'?ll guide you through the process step-by-step\.?(?:\s+|$)/i,
  /^\s*here'?s a direct answer[:\-]?\s*/i,
  /^\s*(?:assistant\s+response|assistant\s+reply|response|answer)[:\-]?\s*/i,
];

function normalizeMode(value) {
  return String(value || '').trim().toLowerCase();
}

function stripKnownLeadingWrappers(text) {
  let sanitized = String(text || '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of KNOWN_LEADING_WRAPPERS) {
      const next = sanitized.replace(pattern, '');
      if (next !== sanitized) {
        sanitized = next;
        changed = true;
      }
    }
  }
  return sanitized;
}

function stripWholeReplyFence(text) {
  const match = String(text || '').match(MARKDOWN_FENCE_ONLY_RE);
  if (!match) {
    return String(text || '');
  }
  return String(match[1] || '');
}

function stripBoundaryMarkerLines(text, { streaming = false } = {}) {
  const lines = String(text || '').split('\n');
  if (lines.length === 0) {
    return '';
  }

  let start = 0;
  let end = lines.length - 1;

  while (start <= end) {
    const line = String(lines[start] || '').trim();
    if (!line) {
      start += 1;
      continue;
    }
    if (BOUNDARY_MARKER_LINE_RE.test(line) || MARKDOWN_FENCE_LINE_RE.test(line)) {
      start += 1;
      continue;
    }
    break;
  }

  while (end >= start) {
    const line = String(lines[end] || '').trim();
    if (!line) {
      end -= 1;
      continue;
    }
    if (BOUNDARY_MARKER_LINE_RE.test(line) || (!streaming && CLOSING_FENCE_LINE_RE.test(line))) {
      end -= 1;
      continue;
    }
    break;
  }

  return lines.slice(start, end + 1).join('\n');
}

function stripLeadingRolePrefixes(text) {
  const lines = String(text || '').split('\n');
  if (lines.length === 0) {
    return '';
  }

  let changed = true;
  while (changed && lines.length > 0) {
    changed = false;
    const firstLine = String(lines[0] || '');
    const stripped = firstLine.replace(LEADING_ROLE_PREFIX_RE, '');
    if (stripped !== firstLine) {
      lines[0] = stripped;
      changed = true;
    }
    if (!String(lines[0] || '').trim() && lines.length > 1) {
      lines.shift();
      changed = true;
    }
  }

  return lines.join('\n');
}

function normalizeWhitespace(text, { streaming = false } = {}) {
  const normalized = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u200b|\ufeff/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return streaming ? normalized.replace(/^\s+/, '') : normalized.trim();
}

function sanitizeAssistantChatText(value, { streaming = false } = {}) {
  let text = String(value || '');
  if (!text) {
    return '';
  }

  text = normalizeWhitespace(text, { streaming: true });
  text = text
    .replace(THINK_BLOCK_RE, '')
    .replace(MODEL_CONTROL_TOKEN_RE, '')
    .replace(XML_ROLE_MARKER_RE, '')
    .replace(PROVIDER_TAG_TOKEN_RE, '')
    .replace(/\[\/?INST\]/gi, '')
    .replace(/<\/?s>/gi, '')
    .replace(/<\|im_start\|>\s*(?:assistant|system|user)?\s*/gi, '')
    .replace(/<\|im_end\|>/gi, '')
    .replace(LLAMA_ROLE_LINE_RE, '\n');

  if (streaming) {
    text = text
      .replace(TRAILING_PARTIAL_CONTROL_TOKEN_RE, '')
      .replace(TRAILING_PARTIAL_XML_MARKER_RE, '');
  }

  text = stripBoundaryMarkerLines(text, { streaming });
  text = stripLeadingRolePrefixes(text);
  text = stripKnownLeadingWrappers(text);
  text = stripWholeReplyFence(text);
  text = stripBoundaryMarkerLines(text, { streaming });
  text = normalizeWhitespace(text, { streaming });

  return streaming ? text : text.trim();
}

function shouldPreferRemoteChatReplies(options = {}) {
  const laneId = normalizeMode(options.suggestedLaneId || options.laneId);
  if (LOCAL_FIRST_CHAT_LANES.has(laneId)) {
    return false;
  }
  if (REMOTE_PREFERRED_CHAT_LANES.has(laneId)) {
    return true;
  }

  const taskMode = normalizeMode(options.suggestedTaskMode || options.taskMode);
  if (LOCAL_FIRST_CHAT_TASK_MODES.has(taskMode)) {
    return false;
  }
  if (REMOTE_PREFERRED_CHAT_TASK_MODES.has(taskMode)) {
    return true;
  }

  const chatMode = normalizeMode(options.effectiveChatMode || options.chatMode || 'auto');
  return chatMode === 'ask' || chatMode === 'plan';
}

function selectChatReplyBackend({
  runtimeMode = 'ollama',
  hasRemoteKey = false,
  hasLocalCmd = false,
  canUseOllama = true,
  options = {},
} = {}) {
  const normalizedRuntimeMode = normalizeMode(runtimeMode || 'ollama') || 'ollama';
  const preferRemote = shouldPreferRemoteChatReplies(options);

  if (preferRemote && hasRemoteKey) {
    return 'openai';
  }

  if (hasLocalCmd) {
    return 'local';
  }

  if (normalizedRuntimeMode === 'openai' && hasRemoteKey) {
    return 'openai';
  }

  if (normalizedRuntimeMode === 'hybrid' && hasRemoteKey && !canUseOllama) {
    return 'openai';
  }

  return 'ollama';
}

module.exports = {
  LOCAL_FIRST_CHAT_LANES,
  LOCAL_FIRST_CHAT_TASK_MODES,
  REMOTE_PREFERRED_CHAT_LANES,
  REMOTE_PREFERRED_CHAT_TASK_MODES,
  sanitizeAssistantChatText,
  selectChatReplyBackend,
  shouldPreferRemoteChatReplies,
};