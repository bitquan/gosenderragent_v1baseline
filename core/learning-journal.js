'use strict';

const EventEmitter = require('events');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const { getConfiguredAssistantLearningJournalRoot } = require('./assistant-paths');
const { deriveStyleProfileFromEntries } = require('./style-profile');

const POLL_INTERVAL_MS = 15000;
const TRAINING_COOLDOWN_MS = 45 * 60 * 1000;
const RECENT_TAIL_BYTES = 256 * 1024;
const HEAVY_PATH_MARKERS = [
  '/.git/',
  '/.venv/',
  '/__pycache__/',
  '/node_modules/',
  '/dist/',
  '/desktop_builds/',
  '/desktop_releases/',
  '/local_model_storage/',
  '/ollama-home/',
];

const MEMORY_PHASE_PATTERNS = Object.freeze([
  {
    id: 'phase-1-safe-engine-core',
    label: 'Phase 1: Safe Engine Core',
    pathTokens: [
      'renderer/app.js',
      'renderer/styles.css',
      'main.js',
      'preload.js',
      'core/system-check.js',
      'core/assistant-paths.js',
      'core/engine-acceptance.js',
      'core/task-hub.js',
      'core/safety-controller.js',
    ],
    keywords: ['review', 'acceptance', 'trust', 'rollback', 'checkpoint', 'interrupt', 'safe mode', 'provider key'],
  },
  {
    id: 'phase-2-assisted-coding-parity',
    label: 'Phase 2: Assisted Coding Parity',
    pathTokens: [
      'integration-library/extensions/vscode-companion',
      'core/vscode-setup.js',
      'core/vscode-extension-health.js',
      'shared-runtime/agent-runtime-client.js',
    ],
    keywords: ['vs code', 'companion', 'parity', 'trace', 'problems', 'open sandbox', 'provider settings'],
  },
  {
    id: 'phase-3-memory-guided-supervision',
    label: 'Phase 3: Memory-Guided Supervision',
    pathTokens: [
      'core/learning-journal.js',
      'shared-runtime/runtime.js',
      'core/followup-recipes.js',
      'runtime/backend/agent/core/memory_service.py',
    ],
    keywords: ['memory', 'learned guidance', 'reject pattern', 'repair hint', 'routing bias', 'overscope', 'self-improvement'],
  },
  {
    id: 'phase-4-builder-and-model-lifecycle',
    label: 'Phase 4: Builder And Model Lifecycle',
    pathTokens: [
      'core/model-foundry.js',
      'core/promotions.js',
      'core/benchmarks.js',
      'core/training-tuning.js',
      'core/ai-center.js',
    ],
    keywords: ['builder', 'foundry', 'promotion', 'benchmark', 'model lifecycle', 'candidate'],
  },
  {
    id: 'phase-5-release-training-and-convergence',
    label: 'Phase 5: Release, Training, And Convergence',
    pathTokens: [
      'core/desktop-release.js',
      'core/app-backup-archive.js',
      'runtime/backend/scripts/dev_assistant_training.js',
      'runtime/backend/scripts/dev_assistant_training.jsonl',
    ],
    keywords: ['release', 'rollback archive', 'training export', 'trusted export', 'deployment'],
  },
]);

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

function isHeavyPath(relativePath) {
  const normalized = `/${normalizePath(relativePath).toLowerCase()}`;
  return HEAVY_PATH_MARKERS.some((marker) => normalized.includes(marker));
}

function summarizeChangedPaths(paths = []) {
  const filtered = paths.map((item) => normalizePath(item)).filter(Boolean).filter((item) => !isHeavyPath(item));
  const top = filtered.slice(0, 5);
  return {
    count: filtered.length,
    top,
    summary: filtered.length === 0
      ? 'No tracked source changes.'
      : `${filtered.length} changed file(s): ${top.join(', ')}${filtered.length > top.length ? '…' : ''}`,
  };
}

function resolveJournalRoot(workspaceRoot) {
  const root = getConfiguredAssistantLearningJournalRoot(workspaceRoot);
  if (!root) {
    return '';
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function journalFilePath(workspaceRoot, targetRoot) {
  const root = resolveJournalRoot(workspaceRoot);
  if (!root) {
    return '';
  }
  const basename = path.basename(String(targetRoot || workspaceRoot || 'workspace')) || 'workspace';
  return path.join(root, `${basename}-change-journal.jsonl`);
}

function exportFilePath(workspaceRoot, changeSessionId) {
  const root = resolveJournalRoot(workspaceRoot);
  if (!root) {
    return '';
  }
  const exportRoot = path.join(root, 'exports');
  fs.mkdirSync(exportRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(exportRoot, `${changeSessionId || 'session'}-${stamp}.json`);
}

function readRecentJsonLines(filePath, limit = 40) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }
  let raw = '';
  try {
    const stat = fs.statSync(filePath);
    const size = Math.max(0, Number(stat.size || 0));
    if (size <= RECENT_TAIL_BYTES) {
      raw = fs.readFileSync(filePath, 'utf8');
    } else {
      const start = Math.max(0, size - RECENT_TAIL_BYTES);
      const length = size - start;
      const handle = fs.openSync(filePath, 'r');
      try {
        const buffer = Buffer.alloc(length);
        fs.readSync(handle, buffer, 0, length, start);
        raw = buffer.toString('utf8');
      } finally {
        fs.closeSync(handle);
      }
      if (start > 0) {
        const firstBreak = raw.indexOf('\n');
        raw = firstBreak >= 0 ? raw.slice(firstBreak + 1) : '';
      }
    }
  } catch (_error) {
    raw = '';
  }
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => safeJsonParse(line))
    .filter(Boolean)
    .slice(-Math.max(1, Number(limit || 40)));
}

function appendJsonLine(filePath, payload) {
  if (!filePath) {
    return '';
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
  return filePath;
}

function gitStatusPaths(targetRoot) {
  if (!targetRoot || !fs.existsSync(targetRoot)) {
    return [];
  }
  try {
    const output = childProcess.execFileSync('git', ['status', '--short', '--untracked-files=no'], {
      cwd: targetRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024,
    });
    return output
      .split(/\r?\n/)
      .map((line) => String(line || '').trim())
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .filter((item) => !isHeavyPath(item));
  } catch (_error) {
    return [];
  }
}

function gitDiffStat(targetRoot) {
  if (!targetRoot || !fs.existsSync(targetRoot)) {
    return '';
  }
  try {
    return childProcess.execFileSync('git', ['diff', '--stat', '--', '.'], {
      cwd: targetRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024,
    }).trim();
  } catch (_error) {
    return '';
  }
}

function eventQualifiesForTraining(entry = {}) {
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
    return String(payload.verdict || payload.status || '').trim().toLowerCase() === 'approved' || payload.trusted === true;
  }
  if (type === 'training-candidate') {
    return true;
  }
  return false;
}

function summarizeTrainingReadiness(entries = [], pendingTrainingCandidates = 0) {
  const latestTrigger = [...entries].reverse().find((entry) => String(entry?.type || '').trim().toLowerCase() === 'training-trigger') || null;
  if (latestTrigger) {
    const payload = latestTrigger.payload && typeof latestTrigger.payload === 'object' ? latestTrigger.payload : {};
    const result = payload.result && typeof payload.result === 'object' ? payload.result : {};
    const reason = String(result.reason || payload.reason || '').trim().toLowerCase();
    if (result.ok === true) {
      return {
        status: 'triggered',
        summary: 'Idle-safe learning already triggered on the latest trusted candidate set.',
        detail: String(result.message || '').trim(),
        lastTriggeredAt: String(latestTrigger.recordedAt || '').trim(),
      };
    }
    if (reason === 'thermal') {
      return {
        status: 'paused',
        summary: 'Training is paused until the machine cools down.',
        detail: String(result.message || payload.thermalState || '').trim(),
        lastTriggeredAt: String(latestTrigger.recordedAt || '').trim(),
      };
    }
    if (reason === 'not-idle' || reason === 'runtime-busy' || reason === 'cooldown') {
      return {
        status: 'waiting',
        summary: 'Training is waiting for a quieter machine window before it runs again.',
        detail: String(result.message || reason || '').trim(),
        lastTriggeredAt: String(latestTrigger.recordedAt || '').trim(),
      };
    }
  }

  if (pendingTrainingCandidates > 0) {
    return {
      status: 'ready',
      summary: 'Trusted learning candidates are queued for the next idle-safe training window.',
      detail: `${pendingTrainingCandidates} pending candidate(s)`,
      lastTriggeredAt: '',
    };
  }

  return {
    status: 'idle',
    summary: 'Training is idle until trusted edits, approvals, or passed runs create new candidates.',
    detail: '',
    lastTriggeredAt: '',
  };
}

function summarizeGsDev1ExportReadiness(entries = []) {
  let eligibleCount = 0;
  let trustedCount = 0;
  let approvedCount = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!eventQualifiesForTraining(entry)) {
      continue;
    }
    const payload = entry && typeof entry.payload === 'object' ? entry.payload : {};
    eligibleCount += 1;
    if (payload.trusted === true || String(payload.verdict || payload.status || '').trim().toLowerCase() === 'approved') {
      trustedCount += 1;
    }
    if (payload.accepted === true || String(payload.status || '').trim().toLowerCase() === 'approved') {
      approvedCount += 1;
    }
  }
  const ready = trustedCount > 0;
  return {
    eligibleCount,
    trustedCount,
    approvedCount,
    ready,
    status: ready ? 'ready' : (eligibleCount > 0 ? 'warn' : 'idle'),
    summary: ready
      ? `${trustedCount} trusted example(s) are ready for GS-Dev-1 training handoff export.`
      : 'Trusted GS-Dev-1 training handoff examples will appear after approved or trusted outcomes land.',
  };
}

function normalizeVerdict(value) {
  const verdict = String(value || '').trim().toLowerCase();
  if (!verdict) {
    return '';
  }
  if (['approved', 'approve', 'accepted', 'pass'].includes(verdict)) {
    return 'approved';
  }
  if ([
    'needs-changes',
    'needs_changes',
    'repair-required',
    'review-required',
    'pending-review',
    'blocked',
    'rejected',
    'reject',
    'fail',
    'failed',
  ].includes(verdict)) {
    return 'needs-changes';
  }
  return verdict;
}

function compactInsightText(value, maxLength = 180) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 3).trim()}...` : text;
}

function incrementCounter(map, key, amount = 1) {
  const normalized = compactInsightText(key, 180);
  if (!normalized) {
    return;
  }
  map.set(normalized, Number(map.get(normalized) || 0) + amount);
}

function sortCounter(map, limit = 4) {
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

function normalizeMemoryAction(value) {
  const action = String(value || '').trim().toLowerCase();
  if (!action) {
    return '';
  }
  if (['repair-loop', 'repair', 'repair-loop-retry'].includes(action)) {
    return 'repair-loop';
  }
  if (['retry-with-research', 'research', 'bridge-plan-retry', 'research-expansion'].includes(action)) {
    return 'retry-with-research';
  }
  if (['review-interrupt', 'review', 'approval-review', 'manual-review'].includes(action)) {
    return 'review-interrupt';
  }
  if (['continue-run', 'continue'].includes(action)) {
    return 'continue-run';
  }
  if (['open-files', 'open-file'].includes(action)) {
    return 'open-files';
  }
  if (['open-trace', 'trace'].includes(action)) {
    return 'open-trace';
  }
  if (['open-sandbox', 'sandbox', 'sandbox-retry'].includes(action)) {
    return 'open-sandbox';
  }
  return action;
}

function defaultPromptForAction(action) {
  if (action === 'repair-loop') {
    return 'Repair the latest failed run and rerun the smallest relevant validation.';
  }
  if (action === 'retry-with-research') {
    return 'Retry the current objective with more repo research first.';
  }
  if (action === 'review-interrupt') {
    return 'Review the latest run, summarize the blockers, and clear held review items.';
  }
  if (action === 'open-files') {
    return 'Open the changed files and show me the diff.';
  }
  if (action === 'open-trace') {
    return 'Open the latest trace and summarize what happened.';
  }
  if (action === 'open-sandbox') {
    return 'Open the active sandbox and inspect the current bounded retry context.';
  }
  return 'Continue the current bounded objective.';
}

function pathSignalsFromPayload(payload = {}) {
  const out = [];
  if (payload.path) {
    out.push(String(payload.path || '').trim());
  }
  if (Array.isArray(payload.changedFiles)) {
    payload.changedFiles.forEach((item) => {
      const candidate = String(item?.path || item || '').trim();
      if (candidate) {
        out.push(candidate);
      }
    });
  }
  return out.filter(Boolean);
}

function incrementPhaseCounter(map, match) {
  if (!match || !match.id || !match.label) {
    return;
  }
  const existing = map.get(match.id) || {
    id: String(match.id || '').trim(),
    label: String(match.label || '').trim(),
    count: 0,
    score: 0,
    reason: '',
  };
  const nextCount = existing.count + 1;
  const nextScore = Number(existing.score || 0) + Number(match.score || 0);
  map.set(existing.id, {
    ...existing,
    count: nextCount,
    score: nextScore,
    reason: existing.reason || String(match.reason || '').trim(),
  });
}

function sortPhaseCounter(map, limit = 3) {
  return Array.from(map.values())
    .sort((left, right) => {
      if (Number(right.count || 0) !== Number(left.count || 0)) {
        return Number(right.count || 0) - Number(left.count || 0);
      }
      if (Number(right.score || 0) !== Number(left.score || 0)) {
        return Number(right.score || 0) - Number(left.score || 0);
      }
      return String(left.label || '').localeCompare(String(right.label || ''));
    })
    .slice(0, limit)
    .map((item) => ({
      id: String(item.id || '').trim(),
      label: String(item.label || '').trim(),
      count: Number(item.count || 0),
      score: Number(item.score || 0),
      reason: String(item.reason || '').trim(),
    }));
}

function inferPhaseRelevanceFromPayload(payload = {}) {
  const changedPaths = pathSignalsFromPayload(payload);
  const searchableText = [
    payload.summary,
    payload.note,
    payload.taskObjective?.summary,
    payload.reviewBundle?.reason,
    payload.reviewBundle?.howToFix,
    payload.failureClass?.summary,
    payload.failureClass?.code,
    payload.nextAction?.summary,
    payload.nextAction?.prompt,
  ]
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');

  let bestMatch = null;
  for (const definition of MEMORY_PHASE_PATTERNS) {
    let score = 0;
    let reason = '';

    for (const token of definition.pathTokens) {
      const normalizedToken = String(token || '').trim().toLowerCase();
      if (!normalizedToken) {
        continue;
      }
      const matchedPath = changedPaths.find((item) => normalizePath(item).toLowerCase().includes(normalizedToken));
      if (matchedPath) {
        score += 3;
        reason = reason || `Touched ${matchedPath}.`;
      }
    }

    for (const keyword of definition.keywords) {
      const normalizedKeyword = String(keyword || '').trim().toLowerCase();
      if (!normalizedKeyword || !searchableText.includes(normalizedKeyword)) {
        continue;
      }
      score += 1;
      reason = reason || `Objective/review text matched "${keyword}".`;
    }

    if (score <= 0) {
      continue;
    }
    const candidate = {
      id: definition.id,
      label: definition.label,
      score,
      reason: compactInsightText(reason, 140),
    };
    if (!bestMatch || candidate.score > bestMatch.score) {
      bestMatch = candidate;
    }
  }

  return bestMatch;
}

function buildLearningMemoryHints(entries = []) {
  const rejectReasons = new Map();
  const fixPatterns = new Map();
  const failureClasses = new Map();
  const preferredResponses = new Map();
  const pathCounts = new Map();
  const phaseCounts = new Map();
  const recentRejects = [];
  let rejectCount = 0;
  let approvedCount = 0;

  for (const entry of Array.isArray(entries) ? entries : []) {
    const type = String(entry?.type || '').trim().toLowerCase();
    const payload = entry?.payload && typeof entry.payload === 'object' ? entry.payload : {};
    const reviewBundle = payload.reviewBundle && typeof payload.reviewBundle === 'object' ? payload.reviewBundle : {};
    const reviewSummary = payload.reviewSummary && typeof payload.reviewSummary === 'object' ? payload.reviewSummary : {};
    const failureClass = payload.failureClass && typeof payload.failureClass === 'object' ? payload.failureClass : {};
    const nextAction = payload.nextAction && typeof payload.nextAction === 'object' ? payload.nextAction : {};
    const state = String(payload.state || '').trim().toLowerCase();
    const verdict = normalizeVerdict(payload.verdict || payload.status || reviewBundle.verdict || '');
    const needsChanges = verdict === 'needs-changes'
      || (type === 'run-complete' && ['fail', 'failed', 'cancelled', 'skipped'].includes(state))
      || ['repair-required', 'review-required', 'pending-review', 'blocked'].includes(String(reviewBundle.verdict || '').trim().toLowerCase());

    if (verdict === 'approved') {
      approvedCount += 1;
    }

    const phaseMatch = inferPhaseRelevanceFromPayload(payload);
    incrementPhaseCounter(phaseCounts, phaseMatch);

    if (!needsChanges) {
      continue;
    }

    rejectCount += 1;
    const reason = compactInsightText(
      reviewBundle.reason
      || payload.summary
      || payload.note
      || reviewSummary.summary
      || failureClass.summary
      || String(failureClass.code || '').replace(/-/g, ' '),
      180,
    );
    const howToFix = compactInsightText(
      reviewBundle.howToFix
      || payload.note
      || nextAction.prompt
      || nextAction.summary
      || '',
      180,
    );
    const failureCode = compactInsightText(String(failureClass.code || '').trim().toLowerCase(), 80);
    const preferredResponse = normalizeMemoryAction(
      nextAction.command
      || (reviewBundle.requiresManualReview ? 'review-interrupt' : '')
      || (failureCode === 'empty-proposal' ? 'retry-with-research' : '')
      || (['parse-failure', 'invalid-change-set', 'validation-failure'].includes(failureCode) ? 'repair-loop' : ''),
    );
    incrementCounter(rejectReasons, reason);
    incrementCounter(fixPatterns, howToFix);
    incrementCounter(failureClasses, failureCode);
    incrementCounter(preferredResponses, preferredResponse);
    pathSignalsFromPayload(payload).forEach((item) => incrementCounter(pathCounts, item));
    if (recentRejects.length < 3 && (reason || howToFix)) {
      recentRejects.push({
        type,
        verdict: verdict || state || 'needs-changes',
        reason,
        howToFix,
        path: String(pathSignalsFromPayload(payload)[0] || '').trim(),
      });
    }
  }

  const topRejectReasons = sortCounter(rejectReasons, 3);
  const topFixPatterns = sortCounter(fixPatterns, 3);
  const recurringFailureClasses = sortCounter(failureClasses, 3);
  const preferredResponseCounts = sortCounter(preferredResponses, 3);
  const topPaths = sortCounter(pathCounts, 4);
  const phaseRelevance = sortPhaseCounter(phaseCounts, 3);
  const recommendedResponse = String(preferredResponseCounts[0]?.value || '').trim();
  const topRejectReason = String(topRejectReasons[0]?.value || '').trim();
  const topFixPattern = String(topFixPatterns[0]?.value || '').trim();
  const topPhaseId = String(phaseRelevance[0]?.id || '').trim();
  const topPhaseLabel = String(phaseRelevance[0]?.label || '').trim();
  const topPhaseReason = String(phaseRelevance[0]?.reason || '').trim();
  const summary = rejectCount > 0
    ? `${rejectCount} reject pattern(s) recorded. Most common: ${topRejectReason || 'review-held or failed run'}${recommendedResponse ? `. Preferred response: ${recommendedResponse}` : ''}${topPhaseLabel ? `. Phase focus: ${topPhaseLabel}` : ''}.`
    : approvedCount > 0
      ? `Trusted outcomes are accumulating, but no recurring reject patterns are recorded yet.${topPhaseLabel ? ` Most active phase: ${topPhaseLabel}.` : ''}`
      : 'No recurring reject or fix patterns are recorded yet.';

  return {
    rejectCount,
    approvedCount,
    summary,
    topRejectReason,
    topFixPattern,
    recommendedResponse,
    recommendedPrompt: topFixPattern || defaultPromptForAction(recommendedResponse),
    topRejectReasons,
    topFixPatterns,
    recurringFailureClasses,
    preferredResponses: preferredResponseCounts,
    topPaths,
    topPhaseId,
    topPhaseLabel,
    topPhaseReason,
    phaseSummary: topPhaseLabel
      ? `${topPhaseLabel} is showing the strongest reusable guidance right now.${topPhaseReason ? ` ${topPhaseReason}` : ''}`
      : '',
    phaseRelevance,
    recentRejects,
  };
}

function readLearningMemoryHints(workspaceRoot, targetRoot, limit = 120) {
  return buildLearningMemoryHints(readRecentJsonLines(journalFilePath(workspaceRoot, targetRoot), limit));
}

class LearningJournalService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.getTelemetry = typeof options.getTelemetry === 'function' ? options.getTelemetry : async () => null;
    this.getSystemIdleTime = typeof options.getSystemIdleTime === 'function' ? options.getSystemIdleTime : () => 0;
    this.getActiveRunCount = typeof options.getActiveRunCount === 'function' ? options.getActiveRunCount : () => 0;
    this.getTrainingSettings = typeof options.getTrainingSettings === 'function' ? options.getTrainingSettings : () => ({});
    this.runLearnAction = typeof options.runLearnAction === 'function' ? options.runLearnAction : async () => ({ ok: false, message: 'learn action unavailable' });
    this.pollTimer = null;
    this.scope = {
      workspaceRoot: '',
      targetRoot: '',
      labRoot: '',
      threadId: '',
      changeSessionId: '',
      pollingEnabled: false,
    };
    this.lastStatusSignature = '';
    this.lastPathsSignature = '';
    this.pendingTrainingCandidates = 0;
    this.lastTrainingAttemptAt = 0;
    this.pollInFlight = false;
  }

  setScope(payload = {}) {
    const nextScope = {
      workspaceRoot: String(payload.workspaceRoot || '').trim(),
      targetRoot: String(payload.targetRoot || payload.labRoot || payload.workspaceRoot || '').trim(),
      labRoot: String(payload.labRoot || '').trim(),
      threadId: String(payload.threadId || '').trim(),
      changeSessionId: String(payload.changeSessionId || '').trim(),
      pollingEnabled: payload.pollingEnabled === true,
    };
    const rootsChanged = nextScope.workspaceRoot !== this.scope.workspaceRoot
      || nextScope.targetRoot !== this.scope.targetRoot
      || nextScope.labRoot !== this.scope.labRoot
      || nextScope.pollingEnabled !== this.scope.pollingEnabled;
    this.scope = nextScope;
    if (rootsChanged) {
      this.lastPathsSignature = '';
      this.lastStatusSignature = '';
    }
    this._ensurePolling();
    return this.getStatus();
  }

  _ensurePolling() {
    if (!this.scope.pollingEnabled || !this.scope.targetRoot) {
      this.stop();
      return;
    }
    if (this.pollTimer) {
      return;
    }
    const tick = () => {
      this.pollTimer = setTimeout(async () => {
        if (this.pollInFlight) {
          tick();
          return;
        }
        this.pollInFlight = true;
        try {
          await this.pollWorkspace();
        } catch (_error) {
          // best-effort polling only
        } finally {
          this.pollInFlight = false;
          if (this.scope.pollingEnabled && this.scope.targetRoot) {
            tick();
          } else {
            this.stop();
          }
        }
      }, POLL_INTERVAL_MS);
    };
    tick();
  }

  stop() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async captureNow() {
    return this.pollWorkspace();
  }

  currentJournalPath() {
    return journalFilePath(this.scope.workspaceRoot, this.scope.targetRoot);
  }

  recordEvent(type, payload = {}) {
    const journalPath = this.currentJournalPath();
    if (!journalPath) {
      return { ok: false, message: 'Learning journal root is not configured.' };
    }
    const entry = {
      recordedAt: nowIso(),
      type: String(type || 'event').trim(),
      workspaceRoot: this.scope.workspaceRoot,
      targetRoot: this.scope.targetRoot,
      labRoot: this.scope.labRoot,
      threadId: this.scope.threadId,
      changeSessionId: this.scope.changeSessionId,
      payload: payload && typeof payload === 'object' ? payload : {},
    };
    appendJsonLine(journalPath, entry);
    this.pendingTrainingCandidates += eventQualifiesForTraining(entry) ? 1 : 0;
    this.emitStatus('recorded', {
      message: `${entry.type} recorded`,
      journalPath,
      lastEntry: entry,
    });
    return {
      ok: true,
      journalPath,
      entry,
    };
  }

  async pollWorkspace() {
    const targetRoot = this.scope.targetRoot;
    if (!targetRoot || !fs.existsSync(targetRoot)) {
      return this.getStatus();
    }
    const paths = gitStatusPaths(targetRoot);
    const signature = JSON.stringify(paths);
    if (signature !== this.lastPathsSignature) {
      this.lastPathsSignature = signature;
      const diffSummary = summarizeChangedPaths(paths);
      const diffStat = gitDiffStat(targetRoot);
      appendJsonLine(this.currentJournalPath(), {
        recordedAt: nowIso(),
        type: 'workspace-diff',
        workspaceRoot: this.scope.workspaceRoot,
        targetRoot,
        labRoot: this.scope.labRoot,
        threadId: this.scope.threadId,
        changeSessionId: this.scope.changeSessionId,
        payload: {
          changedPaths: diffSummary.top,
          changedCount: diffSummary.count,
          summary: diffSummary.summary,
          diffStat,
        },
      });
      this.emitStatus('diff', {
        message: diffSummary.summary,
        changedPaths: diffSummary.top,
        changedCount: diffSummary.count,
        diffStat,
      });
    }
    await this.maybeRunIdleTraining();
    return this.getStatus();
  }

  async maybeRunIdleTraining() {
    if (this.pendingTrainingCandidates <= 0 || !this.scope.targetRoot) {
      return { ok: false, reason: 'no-pending-candidates' };
    }
    if (this.getActiveRunCount() > 0) {
      return { ok: false, reason: 'runtime-busy' };
    }
    const now = Date.now();
    if ((now - this.lastTrainingAttemptAt) < TRAINING_COOLDOWN_MS) {
      return { ok: false, reason: 'cooldown' };
    }

    const settings = this.getTrainingSettings(this.scope.workspaceRoot);
    const telemetry = await this.getTelemetry({
      workspace: this.scope.workspaceRoot,
      targetWorkspaceRoot: this.scope.targetRoot,
      labRoot: this.scope.labRoot,
    });
    const idleSeconds = Number(this.getSystemIdleTime() || 0);
    const allowDuringActiveUse = settings.trainingAllowDuringActiveUse === true;
    const thermalState = String(telemetry?.thermal?.state || '').toLowerCase();
    const cpuUsagePercent = Number(telemetry?.cpuUsagePercent || 0);
    const thermalSafe = !settings.trainingPauseOnThermal || !['heavy', 'limited'].includes(thermalState);
    const idleSafe = allowDuringActiveUse ? cpuUsagePercent <= Number(settings.trainingCpuLimitPercent || 55) : idleSeconds >= 60;
    if (!thermalSafe || !idleSafe) {
      return {
        ok: false,
        reason: thermalSafe ? 'not-idle' : 'thermal',
      };
    }

    this.lastTrainingAttemptAt = now;
    const result = await this.runLearnAction({
      workspace: this.scope.targetRoot,
      targetWorkspaceRoot: this.scope.targetRoot,
      labRoot: this.scope.labRoot,
      changeSessionId: this.scope.changeSessionId,
      trigger: 'idle-safe-journal',
      approvalGated: true,
    });
    appendJsonLine(this.currentJournalPath(), {
      recordedAt: nowIso(),
      type: 'training-trigger',
      workspaceRoot: this.scope.workspaceRoot,
      targetRoot: this.scope.targetRoot,
      labRoot: this.scope.labRoot,
      threadId: this.scope.threadId,
      changeSessionId: this.scope.changeSessionId,
      payload: {
        ok: !!result?.ok,
        result,
        trigger: 'idle-safe-journal',
        idleSeconds,
        cpuUsagePercent,
        thermalState,
      },
    });
    if (result?.ok) {
      this.pendingTrainingCandidates = 0;
    }
    this.emitStatus('training-trigger', {
      message: result?.message || (result?.ok ? 'Idle-safe learning triggered.' : 'Idle-safe learning was blocked.'),
      result,
    });
    return result;
  }

  listRecentChanges(limit = 40) {
    const entries = readRecentJsonLines(this.currentJournalPath(), limit);
    const changedPaths = new Set();
    for (const entry of entries) {
      const entryPaths = Array.isArray(entry?.payload?.changedPaths) ? entry.payload.changedPaths : [];
      for (const item of entryPaths) {
        if (item) {
          changedPaths.add(String(item));
        }
      }
      if (entry?.payload?.path) {
        changedPaths.add(String(entry.payload.path));
      }
    }
    const styleProfile = deriveStyleProfileFromEntries(entries);
    return {
      ok: true,
      journalPath: this.currentJournalPath(),
      entries,
      summary: summarizeChangedPaths(Array.from(changedPaths)),
      pendingTrainingCandidates: this.pendingTrainingCandidates,
      styleProfile,
      reusablePrompts: Array.isArray(styleProfile.reusablePrompts) ? styleProfile.reusablePrompts : [],
    };
  }

  exportRecentChanges() {
    const status = this.listRecentChanges(200);
    const outputPath = exportFilePath(this.scope.workspaceRoot, this.scope.changeSessionId || 'session');
    if (!outputPath) {
      return { ok: false, message: 'Learning journal root is not configured.' };
    }
    const payload = {
      exportedAt: nowIso(),
      scope: { ...this.scope },
      pendingTrainingCandidates: this.pendingTrainingCandidates,
      entries: status.entries,
      summary: status.summary,
      styleProfile: status.styleProfile || {},
      reusablePrompts: status.reusablePrompts || [],
      trainingReadiness: summarizeTrainingReadiness(status.entries, this.pendingTrainingCandidates),
      gs_dev1_export_readiness: summarizeGsDev1ExportReadiness(status.entries),
      memoryHints: buildLearningMemoryHints(status.entries),
    };
    fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return {
      ok: true,
      outputPath,
      entryCount: status.entries.length,
      summary: status.summary.summary,
    };
  }

  getStatus() {
    const recent = this.listRecentChanges(20);
    const insightEntries = readRecentJsonLines(this.currentJournalPath(), 120);
    const styleProfile = deriveStyleProfileFromEntries(insightEntries);
    const trainingReadiness = summarizeTrainingReadiness(insightEntries, this.pendingTrainingCandidates);
    const gsDev1ExportReadiness = summarizeGsDev1ExportReadiness(insightEntries);
    const memoryHints = buildLearningMemoryHints(insightEntries);
    const operatorSupervision = {
      count: Number(styleProfile?.operatorFeedbackCount || 0),
      summary: String(styleProfile?.supervisionSummary || 'No operator supervision has been recorded yet.'),
      signals: Array.isArray(styleProfile?.supervisionSignals) ? styleProfile.supervisionSignals : [],
      recent: Array.isArray(styleProfile?.recentOperatorFeedback) ? styleProfile.recentOperatorFeedback : [],
    };
    const status = {
      ok: true,
      workspaceRoot: this.scope.workspaceRoot,
      targetRoot: this.scope.targetRoot,
      labRoot: this.scope.labRoot,
      threadId: this.scope.threadId,
      changeSessionId: this.scope.changeSessionId,
      pollingEnabled: this.scope.pollingEnabled,
      journalPath: this.currentJournalPath(),
      pendingTrainingCandidates: this.pendingTrainingCandidates,
      tracking: !!this.scope.targetRoot,
      recentSummary: recent.summary,
      styleProfile,
      reusablePrompts: Array.isArray(styleProfile.reusablePrompts) ? styleProfile.reusablePrompts : [],
      operatorSupervision,
      trainingReadiness,
      gsDev1ExportReadiness,
      memoryHints,
    };
    return status;
  }

  emitStatus(type, payload = {}) {
    const status = {
      type,
      timestamp: nowIso(),
      ...this.getStatus(),
      ...payload,
    };
    const signature = JSON.stringify({
      type: status.type,
      targetRoot: status.targetRoot,
      labRoot: status.labRoot,
      pendingTrainingCandidates: status.pendingTrainingCandidates,
      summary: status.recentSummary?.summary || '',
      message: status.message || '',
    });
    if (signature === this.lastStatusSignature) {
      return status;
    }
    this.lastStatusSignature = signature;
    this.emit('learning-event', status);
    return status;
  }
}

module.exports = {
  LearningJournalService,
  buildLearningMemoryHints,
  readLearningMemoryHints,
  summarizeChangedPaths,
};
