'use strict';

const fs = require('fs');
const path = require('path');

const { getConfiguredAssistantLearningJournalRoot } = require('./assistant-paths');

const FILLER_PREFIXES = [
  /^please\s+/i,
  /^(can|could|would)\s+you\s+/i,
  /^i\s+need\s+you\s+to\s+/i,
  /^i\s+want\s+you\s+to\s+/i,
  /^help\s+me\s+/i,
];

const VERB_ALIASES = Object.freeze({
  plan: 'plan',
  review: 'review',
  analyze: 'review',
  inspect: 'review',
  audit: 'review',
  implement: 'implement',
  build: 'implement',
  create: 'implement',
  add: 'implement',
  update: 'implement',
  refactor: 'implement',
  repair: 'repair',
  fix: 'repair',
  debug: 'repair',
  recover: 'repair',
  explain: 'summarize',
  summarize: 'summarize',
  report: 'summarize',
  research: 'research',
  investigate: 'research',
  compare: 'research',
  set: 'setup',
  setup: 'setup',
});

const VERB_COMMANDS = Object.freeze({
  plan: {
    command: '/plan next',
    prompt: 'Plan the next safe coding task.',
  },
  review: {
    command: '/health',
    prompt: 'Review the current repo and tell me what needs fixing first.',
  },
  implement: {
    command: '/implement planned',
    prompt: 'Implement the latest planned slice and summarize the change.',
  },
  repair: {
    command: '/repair',
    prompt: 'Repair the latest failed run and summarize the fix.',
  },
  summarize: {
    command: '/health',
    prompt: 'Summarize the current workspace health and next safe step.',
  },
  research: {
    command: 'Research trusted docs',
    prompt: 'Research the trusted docs and turn them into the next safe coding task.',
  },
  setup: {
    command: 'Set up VS Code support',
    prompt: 'Set up VS Code support for this workspace and summarize what changed.',
  },
});

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(raw) {
  try {
    const parsed = JSON.parse(String(raw || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function normalizePath(value) {
  return String(value || '').trim().replace(/\\/g, '/');
}

function journalFilePath(workspaceRoot, targetRoot) {
  const root = getConfiguredAssistantLearningJournalRoot(workspaceRoot);
  if (!root) {
    return '';
  }
  const basename = path.basename(String(targetRoot || workspaceRoot || 'workspace')) || 'workspace';
  return path.join(root, `${basename}-change-journal.jsonl`);
}

function readRecentJournalEntries(workspaceRoot, targetRoot, limit = 160) {
  const filePath = journalFilePath(workspaceRoot, targetRoot);
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => safeJsonParse(line))
      .filter(Boolean)
      .slice(-Math.max(1, Number(limit || 160)));
  } catch (_error) {
    return [];
  }
}

function stripPromptFiller(value) {
  let text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  for (const pattern of FILLER_PREFIXES) {
    text = text.replace(pattern, '');
  }
  return text.trim();
}

function toSentenceCase(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function clipText(value, maxLength = 160) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}…` : text;
}

function canonicalVerb(value) {
  const word = String(value || '').trim().toLowerCase();
  if (!word) {
    return '';
  }
  return VERB_ALIASES[word] || word;
}

function appendUniqueText(values = [], nextValues = []) {
  const out = [];
  const seen = new Set();
  [...values, ...nextValues].forEach((value) => {
    const text = String(value || '').trim();
    if (!text) {
      return;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(text);
  });
  return out;
}

function normalizeVerdict(value) {
  const verdict = String(value || '').trim().toLowerCase();
  if (!verdict) {
    return 'comment';
  }
  if (['approved', 'approve', 'pass', 'accepted'].includes(verdict)) {
    return 'approved';
  }
  if (['needs-changes', 'needs_changes', 'revise', 'revision', 'rejected', 'reject', 'deferred'].includes(verdict)) {
    return 'needs-changes';
  }
  return 'comment';
}

function inferIntentVerb(value) {
  const text = stripPromptFiller(value).toLowerCase();
  if (!text) {
    return '';
  }
  if (/(review|inspect|what needs fixing|audit|diff)/.test(text)) {
    return 'review';
  }
  if (/(fix|repair|debug|recover|failing|broken|regression)/.test(text)) {
    return 'repair';
  }
  if (/(plan|next safe|what next|roadmap|prepare)/.test(text)) {
    return 'plan';
  }
  if (/(build|create|implement|add|update|refactor|screen|ui|layout|component)/.test(text)) {
    return 'implement';
  }
  if (/(set up|setup|configure|install)/.test(text)) {
    return 'setup';
  }
  if (/(research|docs|documentation|compare|look up|investigate)/.test(text)) {
    return 'research';
  }
  if (/(summarize|summary|report|status)/.test(text)) {
    return 'summarize';
  }
  const firstWord = text.split(/\s+/)[0] || '';
  return canonicalVerb(firstWord);
}

function qualifiesAsTrustedOutcome(entry = {}) {
  const type = String(entry.type || '').trim().toLowerCase();
  const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
  if (type === 'approval-decision') {
    return String(payload.status || '').trim().toLowerCase() === 'approved' || payload.trusted === true;
  }
  if (type === 'manual-edit') {
    return payload.accepted === true || payload.trusted === true;
  }
  if (type === 'run-complete') {
    return String(payload.state || '').trim().toLowerCase() === 'pass' && (payload.accepted === true || payload.trusted === true);
  }
  if (type === 'operator-feedback') {
    return normalizeVerdict(payload.verdict || payload.status) === 'approved' || payload.trusted === true;
  }
  if (type === 'training-candidate') {
    return true;
  }
  return false;
}

function sessionKey(entry = {}, index = 0) {
  return String(
    entry.changeSessionId
    || entry.threadId
    || entry.payload?.taskId
    || entry.payload?.goalId
    || `entry-${index}`,
  ).trim();
}

function increment(map, key, amount = 1) {
  if (!key) {
    return;
  }
  map.set(key, Number(map.get(key) || 0) + amount);
}

function sortedCounts(map, limit = 4) {
  return Array.from(map.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return String(left[0]).localeCompare(String(right[0]));
    })
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function extractTargetPhrase(value) {
  const cleaned = stripPromptFiller(value)
    .replace(/[.?!]+$/g, '')
    .replace(/^\/[a-z-]+\s+/i, '');
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length <= 1) {
    return '';
  }
  const startIndex = canonicalVerb(words[0]) ? 1 : 0;
  const filtered = words
    .slice(startIndex)
    .map((word) => word.replace(/[^a-z0-9/_-]+/gi, '').toLowerCase())
    .filter((word) => word && !['the', 'a', 'an', 'this', 'that', 'my', 'our', 'current', 'next', 'safe'].includes(word));
  return filtered.slice(0, 3).join(' ');
}

function buildReusablePrompts(promptMap, limit = 4) {
  return Array.from(promptMap.values())
    .sort((left, right) => {
      if (right.uses !== left.uses) {
        return right.uses - left.uses;
      }
      return String(right.lastUsedAt || '').localeCompare(String(left.lastUsedAt || ''));
    })
    .slice(0, limit)
    .map((item) => ({
      prompt: item.prompt,
      category: item.category,
      uses: item.uses,
      lastUsedAt: item.lastUsedAt || nowIso(),
      source: 'learning-journal',
      surfaces: Array.isArray(item.surfaces) ? item.surfaces : [],
      trustedSignals: Array.isArray(item.trustedSignals) ? item.trustedSignals : [],
    }));
}

function buildSupervisionSignals(feedbackMap, limit = 4) {
  return Array.from(feedbackMap.values())
    .sort((left, right) => {
      if (right.uses !== left.uses) {
        return right.uses - left.uses;
      }
      return String(right.lastUsedAt || '').localeCompare(String(left.lastUsedAt || ''));
    })
    .slice(0, limit)
    .map((item) => ({
      note: item.note,
      verdict: item.verdict,
      uses: item.uses,
      lastUsedAt: item.lastUsedAt || nowIso(),
      source: 'operator-feedback',
    }));
}

function buildRecommendedCommands(preferredVerbs = [], supervisionSignals = [], reusablePrompts = [], limit = 4) {
  const entries = new Map();
  const pushCommand = (verb, source, note = '') => {
    const normalizedVerb = canonicalVerb(verb);
    const template = VERB_COMMANDS[normalizedVerb];
    if (!template) {
      return;
    }
    const key = template.command.toLowerCase();
    const current = entries.get(key) || {
      command: template.command,
      prompt: template.prompt,
      category: normalizedVerb,
      source,
      reason: '',
    };
    current.reason = note || current.reason || `${normalizedVerb} is showing up often in trusted prompts and operator supervision.`;
    entries.set(key, current);
  };

  preferredVerbs.forEach((item) => pushCommand(item?.verb, 'style-profile'));
  supervisionSignals.forEach((item) => pushCommand(inferIntentVerb(item?.note || ''), 'operator-feedback', String(item?.note || '')));
  reusablePrompts.forEach((item) => pushCommand(item?.category, 'learning-journal', String(item?.prompt || '')));

  return Array.from(entries.values()).slice(0, limit);
}

function deriveStyleProfileFromEntries(entries = []) {
  const groups = new Map();
  entries.forEach((entry, index) => {
    const key = sessionKey(entry, index);
    const current = groups.get(key) || { entries: [], trusted: false };
    current.entries.push(entry);
    current.trusted = current.trusted || qualifiesAsTrustedOutcome(entry);
    groups.set(key, current);
  });

  const trustedGroups = Array.from(groups.values()).filter((group) => group.trusted);
  const verbCounts = new Map();
  const targetCounts = new Map();
  const promptMap = new Map();
  const titleExamples = [];
  const supervisionMap = new Map();
  const verdictCounts = new Map();
  const recentOperatorFeedback = [];

  for (const group of trustedGroups) {
    const trustedPrompts = group.entries.filter((entry) => String(entry.type || '').trim().toLowerCase() === 'chat-prompt');
    const trustedTitles = group.entries.filter((entry) => ['goal-created', 'task-created'].includes(String(entry.type || '').trim().toLowerCase()));
    const trustedSignals = appendUniqueText([], group.entries
      .filter((entry) => qualifiesAsTrustedOutcome(entry))
      .map((entry) => String(entry.type || '').trim().toLowerCase()));

    for (const entry of trustedPrompts) {
      const prompt = stripPromptFiller(entry.payload?.text || '');
      if (!prompt) {
        continue;
      }
      const category = inferIntentVerb(prompt) || 'general';
      const key = prompt.toLowerCase();
      const current = promptMap.get(key) || {
        prompt,
        category,
        uses: 0,
        lastUsedAt: '',
        surfaces: [],
        trustedSignals: [],
      };
      current.uses += 1;
      current.lastUsedAt = String(entry.recordedAt || current.lastUsedAt || '');
      current.surfaces = appendUniqueText(current.surfaces, [entry.payload?.surface, entry.payload?.source]);
      current.trustedSignals = appendUniqueText(current.trustedSignals, trustedSignals);
      promptMap.set(key, current);
      increment(verbCounts, category);
      const target = extractTargetPhrase(prompt);
      if (target) {
        increment(targetCounts, target);
      }
    }

    for (const entry of trustedTitles) {
      const title = stripPromptFiller(entry.payload?.title || '');
      if (!title) {
        continue;
      }
      titleExamples.push(title);
      const verb = inferIntentVerb(title);
      if (verb) {
        increment(verbCounts, verb);
      }
      const target = extractTargetPhrase(title);
      if (target) {
        increment(targetCounts, target);
      }
    }
  }

  for (const entry of entries) {
    if (String(entry.type || '').trim().toLowerCase() !== 'operator-feedback') {
      continue;
    }
    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
    const verdict = normalizeVerdict(payload.verdict || payload.status || payload.kind);
    const note = clipText(stripPromptFiller(payload.note || payload.summary || payload.message || ''), 180);
    increment(verdictCounts, verdict);
    recentOperatorFeedback.push({
      verdict,
      note: note || clipText(payload.summary || `${verdict} feedback recorded`, 160),
      path: String(payload.path || '').trim(),
      recordedAt: String(entry.recordedAt || '').trim(),
    });
    if (note) {
      const key = `${verdict}:${note.toLowerCase()}`;
      const current = supervisionMap.get(key) || {
        note,
        verdict,
        uses: 0,
        lastUsedAt: '',
      };
      current.uses += 1;
      current.lastUsedAt = String(entry.recordedAt || current.lastUsedAt || '');
      supervisionMap.set(key, current);
      const category = inferIntentVerb(note)
        || (verdict === 'needs-changes' ? 'repair' : verdict === 'approved' ? 'review' : '');
      if (category) {
        increment(verbCounts, category);
      }
      const target = extractTargetPhrase(note);
      if (target) {
        increment(targetCounts, target);
      }
    }
  }

  const preferredVerbs = sortedCounts(verbCounts, 4).map((item) => ({
    verb: item.value,
    count: item.count,
  }));
  const commonTargets = sortedCounts(targetCounts, 4).map((item) => ({
    label: item.value,
    count: item.count,
  }));
  const reusablePrompts = buildReusablePrompts(promptMap, 4);
  const supervisionSignals = buildSupervisionSignals(supervisionMap, 4);
  const recommendedCommands = buildRecommendedCommands(preferredVerbs, supervisionSignals, reusablePrompts, 4);
  const trustedSessionCount = trustedGroups.length;
  const sampleCount = entries.length;
  const confidence = trustedSessionCount >= 4 ? 'high' : trustedSessionCount >= 2 ? 'medium' : 'low';
  const approvedCount = Number(verdictCounts.get('approved') || 0);
  const revisionCount = Number(verdictCounts.get('needs-changes') || 0);
  const commentCount = Number(verdictCounts.get('comment') || 0);
  const supervisionSummary = approvedCount || revisionCount || commentCount
    ? `${approvedCount} approval${approvedCount === 1 ? '' : 's'} • ${revisionCount} needs-change${revisionCount === 1 ? '' : 's'} • ${commentCount} comment${commentCount === 1 ? '' : 's'} recorded`
    : 'No operator supervision has been recorded yet.';
  const recentFeedback = recentOperatorFeedback
    .sort((left, right) => String(right.recordedAt || '').localeCompare(String(left.recordedAt || '')))
    .slice(0, 4);

  return {
    sampleCount,
    trustedSessionCount,
    confidence,
    namingStyle: preferredVerbs.length > 0 ? 'imperative-clean' : 'default',
    preferredVerbs,
    commonTargets,
    reusablePrompts,
    recommendedCommands,
    operatorFeedbackCount: approvedCount + revisionCount + commentCount,
    supervisionSummary,
    supervisionSignals,
    recentOperatorFeedback: recentFeedback,
    exampleTitles: titleExamples.slice(0, 4),
    summary: preferredVerbs.length > 0
      ? `Learns toward ${preferredVerbs.map((item) => item.verb).join(', ')} style prompts from trusted sessions.`
      : supervisionSignals.length > 0
        ? 'Learning from operator approvals and revision notes while trusted naming patterns warm up.'
        : 'Waiting for more approved or trusted sessions before shaping naming and command preferences.',
  };
}

function deriveWorkspaceStyleProfile(workspaceRoot, targetRoot = workspaceRoot, limit = 160) {
  return deriveStyleProfileFromEntries(readRecentJournalEntries(workspaceRoot, targetRoot, limit));
}

function improveTitleWithStyleProfile(value, styleProfile = {}, options = {}) {
  let cleaned = stripPromptFiller(value).replace(/[.?!]+$/g, '').trim();
  if (!cleaned) {
    return '';
  }

  const inferredVerb = inferIntentVerb(cleaned);
  const learnedVerb = String(styleProfile?.preferredVerbs?.[0]?.verb || '').trim().toLowerCase();
  const preferredVerb = inferredVerb || learnedVerb;
  const lower = cleaned.toLowerCase();

  if (/^what needs fixing/.test(lower) && preferredVerb) {
    cleaned = `${preferredVerb} ${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}`;
  } else if (/^what should (i|we) do next/.test(lower)) {
    cleaned = 'Plan the next safe task';
  } else if (options.forceImperative === true && preferredVerb && !canonicalVerb(cleaned.split(/\s+/)[0])) {
    cleaned = `${preferredVerb} ${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}`;
  }

  return toSentenceCase(cleaned.replace(/\s+/g, ' ').trim());
}

module.exports = {
  deriveStyleProfileFromEntries,
  deriveWorkspaceStyleProfile,
  improveTitleWithStyleProfile,
  inferIntentVerb,
  journalFilePath,
  qualifiesAsTrustedOutcome,
  readRecentJournalEntries,
  stripPromptFiller,
};
