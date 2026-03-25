import React, { useEffect, useEffectEvent } from 'react';
import { createRoot } from 'react-dom/client';

import { shortPath, formatStamp, summarizeText, makeId } from './lib/format';
import { createStore, useStoreValue } from './lib/store';
import type { ChatMessage, ChatThread, InspectorState, JsonMap } from './lib/types';

const THREADS_KEY = 'gosenderr.desktop.workbench.threads.v3';
const ACTIVE_THREAD_KEY = 'gosenderr.desktop.workbench.active-thread.v3';
const SETTINGS_TABS = ['general', 'workspace', 'ai', 'autonomy', 'skills', 'extensions', 'tools', 'automations', 'labs', 'learning', 'storage'] as const;
const MONITOR_TABS = ['overview', 'runs', 'learning', 'promotions', 'debug'] as const;
type SettingsTabId = typeof SETTINGS_TABS[number];
type MonitorTabId = typeof MONITOR_TABS[number];

type AppState = {
  loading: boolean;
  error: string;
  snapshot: JsonMap | null;
  meta: JsonMap | null;
  settings: JsonMap;
  tuning: JsonMap | null;
  labs: JsonMap;
  benchmarks: JsonMap;
  skills: JsonMap[];
  tools: JsonMap[];
  automations: JsonMap[];
  aiStatus: JsonMap | null;
  learningStatus: JsonMap;
  learningChanges: JsonMap;
  activeModuleId: string;
  activeSettingsTab: SettingsTabId;
  activeMonitorTab: MonitorTabId;
  activeInspectorTab: 'inbox' | 'file' | 'diff' | 'learning';
  activeBottomTab: 'runtime' | 'learning' | 'labs' | 'benchmarks';
  threads: ChatThread[];
  activeThreadId: string;
  threadReadMarkers: Record<string, string>;
  composerText: string;
  pendingAttachments: JsonMap[];
  busyChat: boolean;
  busyAcceptance: boolean;
  busySafetyController: boolean;
  chatFocused: boolean;
  inspector: InspectorState;
  runtimeEvents: JsonMap[];
  learningEvents: JsonMap[];
  labEvents: JsonMap[];
  benchmarkEvents: JsonMap[];
  leftRailOpen: boolean;
  rightRailOpen: boolean;
};

const initialState: AppState = {
  loading: true,
  error: '',
  snapshot: null,
  meta: null,
  settings: {},
  tuning: null,
  labs: { labs: [] },
  benchmarks: { runs: [] },
  skills: [],
  tools: [],
  automations: [],
  aiStatus: null,
  learningStatus: {},
  learningChanges: { entries: [] },
  activeModuleId: 'workbench',
  activeSettingsTab: 'ai',
  activeMonitorTab: 'overview',
  activeInspectorTab: 'inbox',
  activeBottomTab: 'runtime',
  threads: loadThreads(),
  activeThreadId: loadActiveThreadId(),
  threadReadMarkers: {},
  composerText: '',
  pendingAttachments: [],
  busyChat: false,
  busyAcceptance: false,
  busySafetyController: false,
  chatFocused: false,
  inspector: {
    selectedPath: '',
    fileContent: '',
    diffContent: '',
    fileStatus: 'Select a file, approval item, or chat reference to inspect it here.',
    diffStatus: 'Open a file to view its diff.',
    reviewNote: '',
  },
  runtimeEvents: [],
  learningEvents: [],
  labEvents: [],
  benchmarkEvents: [],
  leftRailOpen: true,
  rightRailOpen: false,
};

const store = createStore(initialState);

type InboxItem = {
  id: string;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  detail: string;
  path?: string;
  source?: string;
  openModule?: 'monitor' | 'settings' | 'workbench';
  targetTab?: AppState['activeInspectorTab'] | MonitorTabId;
  actionLabel?: string;
  backupId?: string;
};

function createThread(title: string): ChatThread {
  const createdAt = new Date().toISOString();
  return {
    id: makeId('thread'),
    title,
    changeSessionId: makeId('session'),
    createdAt,
    updatedAt: createdAt,
    messages: [{
      id: makeId('msg'),
      role: 'system',
      text: 'Model-connected workbench ready. Ask for planning, implementation, repair, review, or a direct coding task.',
      createdAt,
    }],
  };
}

function loadThreads(): ChatThread[] {
  try {
    const raw = window.localStorage.getItem(THREADS_KEY);
    if (!raw) {
      return [createThread('Main Thread')];
    }
    const parsed = JSON.parse(raw) as ChatThread[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [createThread('Main Thread')];
    }
    return parsed.map((thread) => ({
      ...thread,
      messages: Array.isArray(thread.messages) ? thread.messages : [],
      changeSessionId: thread.changeSessionId || makeId('session'),
    }));
  } catch (_error) {
    return [createThread('Main Thread')];
  }
}

function loadActiveThreadId() {
  return window.localStorage.getItem(ACTIVE_THREAD_KEY) || '';
}

function persistThreads(threads: ChatThread[], activeThreadId: string) {
  window.localStorage.setItem(THREADS_KEY, JSON.stringify(threads));
  window.localStorage.setItem(ACTIVE_THREAD_KEY, activeThreadId);
}

function activeThread(state: AppState) {
  return state.threads.find((thread) => thread.id === state.activeThreadId) || state.threads[0];
}

function latestMessageId(thread: ChatThread | undefined) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  return String(messages[messages.length - 1]?.id || '').trim();
}

function latestAssistantMessageId(thread: ChatThread | undefined) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  const latest = [...messages].reverse().find((message) => message.role === 'assistant' || message.role === 'system');
  return String(latest?.id || '').trim();
}

function readChangedFileItems(snapshot: JsonMap | null) {
  const review = snapshot?.review || {};
  if (Array.isArray(review.changedFiles)) {
    return review.changedFiles;
  }
  const changedFiles = Array.isArray(snapshot?.changedFiles) ? snapshot.changedFiles : [];
  return changedFiles.map((entry: string) => ({ path: String(entry).slice(3).trim(), status: 'modified' }));
}

function readApprovalItems(snapshot: JsonMap | null) {
  const queue = snapshot?.manager?.approvalQueue;
  return Array.isArray(queue) ? queue : [];
}

function readSafeMode(snapshot: JsonMap | null) {
  return snapshot?.manager?.safeMode && typeof snapshot.manager.safeMode === 'object'
    ? snapshot.manager.safeMode
    : {};
}

function deriveInboxDedupeKey(item: InboxItem) {
  return [
    String(item.id || '').trim(),
    String(item.path || '').trim(),
    String(item.source || '').trim(),
    String(item.targetTab || '').trim(),
    String(item.title || '').trim(),
  ].filter(Boolean).join('::');
}

function dedupeInboxItems(items: InboxItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = deriveInboxDedupeKey(item);
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildInboxItems(input: {
  snapshot: JsonMap | null;
  learningStatus: JsonMap;
  runtimeEvents: JsonMap[];
  benchmarkEvents: JsonMap[];
}) {
  const items: InboxItem[] = [];
  const snapshot = input.snapshot;
  const safeMode = readSafeMode(snapshot);
  const approvals = readApprovalItems(snapshot);
  const changedFiles = readChangedFileItems(snapshot);
  const taskRuns = Array.isArray(snapshot?.taskHub?.runs) ? snapshot?.taskHub?.runs : [];
  const reviewer = snapshot?.reviewer && typeof snapshot.reviewer === 'object' ? snapshot.reviewer : {};
  const regression = snapshot?.regression && typeof snapshot.regression === 'object' ? snapshot.regression : {};
  const updates = snapshot?.updates || {};
  const promotions = snapshot?.promotions || {};
  const acceptance = snapshot?.acceptance?.report && typeof snapshot.acceptance.report === 'object'
    ? snapshot.acceptance.report
    : {};
  const learningStatus = input.learningStatus || {};

  if (safeMode.active || safeMode.watchOnly) {
    const reasons = Array.isArray(safeMode.reasons) ? safeMode.reasons : [];
    if (reasons.length > 0) {
      reasons.slice(0, 2).forEach((reason: JsonMap, index: number) => {
        items.push({
          id: `safety-${reason.id || index}`,
          severity: safeMode.active ? 'critical' : 'warn',
          title: String(reason.title || 'Safety notice'),
          detail: String(reason.detail || safeMode.summary || 'Safety guardrails are active.'),
          targetTab: 'inbox',
          actionLabel: safeMode.rollbackAvailable ? 'Restore latest backup' : 'Open inbox',
          backupId: safeMode.rollbackAvailable ? String(safeMode.latestBackupId || '') : '',
        });
      });
    } else {
      items.push({
        id: 'safety-summary',
        severity: safeMode.active ? 'critical' : 'warn',
        title: safeMode.active ? 'Safe mode is active' : 'Safety watch is active',
        detail: String(safeMode.summary || 'Safety guardrails are monitoring this workspace.'),
        targetTab: 'inbox',
        actionLabel: safeMode.rollbackAvailable ? 'Restore latest backup' : 'Open inbox',
        backupId: safeMode.rollbackAvailable ? String(safeMode.latestBackupId || '') : '',
      });
    }
  }

  approvals.slice(0, 6).forEach((item: JsonMap, index: number) => {
    items.push({
      id: `approval-${item.approvalKey || item.path || index}`,
      severity: 'warn',
      title: shortPath(item.path) || `Approval ${index + 1}`,
      detail: `${item.ticket ? `BAT<${item.ticket}> • ` : ''}${item.nextAction || item.source || 'Needs review'}`,
      path: String(item.path || ''),
      source: 'approval',
      targetTab: 'file',
      actionLabel: 'Open file',
    });
  });

  taskRuns
    .filter((item: JsonMap) => ['fail', 'blocked', 'cancelled'].includes(String(item.runtimeState || item.state || item.status || '').toLowerCase()))
    .slice(0, 3)
    .forEach((item: JsonMap, index: number) => {
      items.push({
        id: `run-${item.runId || item.id || index}`,
        severity: String(item.runtimeState || item.state || item.status || '').toLowerCase() === 'blocked' ? 'warn' : 'critical',
        title: String(item.runtimeLabel || item.label || item.title || 'Run needs attention'),
        detail: summarizeText(String(item.blockedReason || item.message || item.summary || item.status || 'Run needs review.'), 140),
        targetTab: 'inbox',
      });
    });

  const reviewerStatus = String(reviewer.status || '').trim().toLowerCase();
  if (['needs-review', 'needs-revision'].includes(reviewerStatus)) {
    items.push({
      id: 'reviewer-summary',
      severity: reviewerStatus === 'needs-revision' ? 'warn' : 'info',
      title: reviewerStatus === 'needs-revision' ? 'Reviewer wants a revision pass' : 'Reviewer wants a manual review pass',
      detail: String(reviewer.summary || reviewer.nextAction || 'Open Monitor to inspect the Test Bench review results.'),
      openModule: 'monitor',
      targetTab: 'runs',
      actionLabel: 'Open Test Bench',
    });
  }

  const regressionCount = Number(regression.candidateCount || 0);
  if (regressionCount > 0) {
    items.push({
      id: 'regression-candidates',
      severity: 'info',
      title: `${regressionCount} regression candidate${regressionCount === 1 ? '' : 's'} ready`,
      detail: String(regression.summary || 'Open Monitor to turn the latest fix into replayable coverage.'),
      openModule: 'monitor',
      targetTab: 'runs',
      actionLabel: 'Open Test Bench',
    });
  }

  const pendingCandidates = Number(
    learningStatus.pendingTrainingCandidates
    || learningStatus.pendingCandidateCount
    || learningStatus.pendingRunsCount
    || snapshot?.manager?.training?.pendingRunsCount
    || 0,
  );
  if (pendingCandidates > 0) {
    items.push({
      id: 'learning-pending',
      severity: 'info',
      title: `${pendingCandidates} learning candidate${pendingCandidates === 1 ? '' : 's'} ready`,
      detail: 'Review the change journal and training handoff before promoting new self-improvement patterns.',
      openModule: 'monitor',
      targetTab: 'learning',
      actionLabel: 'Open learning',
    });
  }

  const readyPromotionCandidates = Array.isArray(promotions.readyCandidates) ? promotions.readyCandidates : [];
  if (readyPromotionCandidates.length > 0) {
    const newestCandidate = readyPromotionCandidates[0] || {};
    items.push({
      id: `promotion-${newestCandidate.id || 'candidate'}`,
      severity: 'info',
      title: `${readyPromotionCandidates.length} candidate ring item${readyPromotionCandidates.length === 1 ? '' : 's'} ready`,
      detail: `${newestCandidate.name || newestCandidate.id || 'Candidate'} is ready for monitored promotion.`,
      openModule: 'monitor',
      targetTab: 'inbox',
      actionLabel: 'Open monitor',
    });
  }

  const updateState = String(updates?.workspace?.state || updates?.state || '').trim().toLowerCase();
  const hasUpdates = updates?.workspace?.hasUpdates || updates?.hasUpdates;
  if (['failed', 'rolled-back'].includes(updateState) || hasUpdates) {
    items.push({
      id: 'updates-status',
      severity: updateState === 'failed' ? 'critical' : 'info',
      title: updateState === 'failed' ? 'Update flow needs review' : 'Workspace update available',
      detail: String(updates?.workspace?.message || updates?.message || 'A new update is available.'),
      targetTab: 'inbox',
    });
  }

  const acceptanceStatus = String(acceptance?.overallStatus || '').trim().toLowerCase();
  if (['fail', 'warn'].includes(acceptanceStatus)) {
    items.push({
      id: 'engine-acceptance-status',
      severity: acceptanceStatus === 'fail' ? 'critical' : 'warn',
      title: acceptanceStatus === 'fail' ? 'Engine acceptance needs review' : 'Engine acceptance raised warnings',
      detail: String(acceptance?.summary || acceptance?.nextAction || 'Open Monitor to review the latest engine acceptance report.'),
      openModule: 'monitor',
      targetTab: 'overview',
      actionLabel: 'Open monitor',
    });
  }

  input.benchmarkEvents
    .filter((item) => ['fail', 'failed', 'warn', 'warning'].includes(String(item.state || item.status || '').toLowerCase()))
    .slice(0, 2)
    .forEach((item, index) => {
      items.push({
        id: `benchmark-${item.runId || item.id || index}`,
        severity: String(item.state || item.status || '').toLowerCase().startsWith('fail') ? 'critical' : 'warn',
        title: String(item.label || item.name || 'Benchmark signal'),
        detail: summarizeText(String(item.message || item.summary || 'Benchmark emitted a warning.'), 140),
        targetTab: 'inbox',
      });
    });

  if (items.length === 0 && changedFiles.length > 0) {
    items.push({
      id: 'changed-files',
      severity: 'info',
      title: `${changedFiles.length} changed file${changedFiles.length === 1 ? '' : 's'}`,
      detail: 'Open the file inspector to review the latest workspace edits.',
      targetTab: 'file',
      actionLabel: 'Open files',
    });
  }

  return dedupeInboxItems(items).slice(0, 12);
}

function pushUniqueSuggestion(target: string[], value: string) {
  const normalized = String(value || '').trim();
  if (!normalized || target.includes(normalized)) {
    return;
  }
  target.push(normalized);
}

function buildComposerSuggestions(input: {
  composerText: string;
  learningStatus: JsonMap;
  pendingAttachments: JsonMap[];
  safeMode: JsonMap;
  docsContext?: JsonMap;
  nextSafeAction?: JsonMap;
  safeRecipe?: JsonMap;
}) {
  const suggestions: string[] = [];
  const lower = String(input.composerText || '').trim().toLowerCase();
  const reusablePrompts = Array.isArray(input.learningStatus?.reusablePrompts) ? input.learningStatus.reusablePrompts : [];
  const recommendedCommands = Array.isArray(input.learningStatus?.styleProfile?.recommendedCommands)
    ? input.learningStatus.styleProfile.recommendedCommands
    : [];
  const docsRecommendations = Array.isArray(input.docsContext?.recommendedSources)
    ? input.docsContext.recommendedSources
    : [];
  const nextSafeActionPrompt = String(
    input.nextSafeAction?.prompt
    || input.nextSafeAction?.candidate?.objective
    || input.nextSafeAction?.candidate?.summary
    || input.nextSafeAction?.summary
    || ''
  ).trim();
  const safeRecipePrompt = String(
    input.safeRecipe?.prompt
    || input.safeRecipe?.summary
    || ''
  ).trim();

  if (!lower && safeRecipePrompt) {
    pushUniqueSuggestion(suggestions, summarizeText(safeRecipePrompt, 120));
  }

  if (!lower && nextSafeActionPrompt) {
    pushUniqueSuggestion(suggestions, summarizeText(nextSafeActionPrompt, 120));
  }

  if (Array.isArray(input.pendingAttachments) && input.pendingAttachments.length > 0) {
    pushUniqueSuggestion(suggestions, 'Use the attached screenshot and implement the next safe slice.');
  }

  if (!lower) {
    pushUniqueSuggestion(suggestions, 'Plan the next safe coding task.');
    pushUniqueSuggestion(suggestions, 'Review the current repo and tell me what needs fixing first.');
  }

  if (lower.includes('/')) {
    pushUniqueSuggestion(suggestions, '/health');
    pushUniqueSuggestion(suggestions, '/approvals');
    pushUniqueSuggestion(suggestions, '/self-improve');
    recommendedCommands.forEach((item: JsonMap) => {
      if (suggestions.length >= 3) {
        return;
      }
      pushUniqueSuggestion(suggestions, String(item?.command || '').trim());
    });
  }

  if (/(review|audit|inspect|what needs fixing)/.test(lower)) {
    pushUniqueSuggestion(suggestions, 'Review the current repo and tell me what needs fixing first.');
  }

  if (/(fix|repair|broken|failing|failed|debug|issue|bug)/.test(lower)) {
    pushUniqueSuggestion(suggestions, 'Repair the latest failed run and summarize the fix.');
  }

  if (/(plan|roadmap|next step|next task|scope)/.test(lower)) {
    pushUniqueSuggestion(suggestions, 'Plan the next safe coding task.');
  }

  if (/(doc|docs|documentation|guide|reference)/.test(lower)) {
    const topDoc = docsRecommendations[0] && typeof docsRecommendations[0] === 'object' ? docsRecommendations[0] : null;
    if (topDoc?.label && topDoc?.domain) {
      pushUniqueSuggestion(
        suggestions,
        summarizeText(`Use ${String(topDoc.label)} (${String(topDoc.domain)}) and turn that guidance into the next safe coding task.`, 120),
      );
    } else {
      pushUniqueSuggestion(suggestions, 'Research the trusted docs and turn them into the next safe coding task.');
    }
  }

  if (/(vscode|vs code|extension|editor|ide)/.test(lower)) {
    pushUniqueSuggestion(suggestions, 'Set up VS Code support for this workspace and summarize what changed.');
  }

  if (input.safeMode?.active) {
    pushUniqueSuggestion(suggestions, 'Explain why safe mode is active and tell me the next safe step.');
  }

  reusablePrompts.forEach((item: JsonMap) => {
    if (suggestions.length >= 3) {
      return;
    }
    pushUniqueSuggestion(suggestions, String(item?.prompt || '').trim());
  });

  recommendedCommands.forEach((item: JsonMap) => {
    if (suggestions.length >= 3) {
      return;
    }
    pushUniqueSuggestion(suggestions, String(lower.includes('/') ? item?.command : item?.prompt || '').trim());
  });

  if (suggestions.length === 0) {
    pushUniqueSuggestion(suggestions, 'Plan the next safe coding task.');
    pushUniqueSuggestion(suggestions, 'Review the current repo and tell me what needs fixing first.');
    pushUniqueSuggestion(suggestions, 'Set up the coding model and verify the engine is ready.');
  }

  return suggestions.slice(0, 3);
}

function appendRuntimeEvent<
  T extends keyof Pick<AppState, 'runtimeEvents' | 'learningEvents' | 'labEvents' | 'benchmarkEvents'>
>(key: T, payload: JsonMap) {
  store.update((state) => ({
    ...state,
    [key]: [payload, ...(state[key] as JsonMap[])].slice(0, 80),
  }));
}

async function refreshData(mode: 'lite' | 'full' = 'lite') {
  const state = store.getState();
  const wantsFullSnapshot = mode === 'full' || !window.gosAgent.bootstrapLite;
  const snapshot = wantsFullSnapshot
    ? await window.gosAgent.bootstrap({ captureLearning: true })
    : await window.gosAgent.bootstrapLite({ captureLearning: false });
  const shouldLoadReview = wantsFullSnapshot || store.getState().rightRailOpen;
  const [meta, tuning, labs, benchmarks, skills, automations, tools, aiStatus, learningStatus, learningChanges, reviewSnapshot] = await Promise.all([
    window.gosAgent.getMeta(),
    window.gosAgent.getTuningStatus({ workspace: snapshot.workspaceRoot }),
    window.gosAgent.listLabs({ workspaceRoot: snapshot.workspaceRoot }),
    window.gosAgent.listBenchmarks({ workspaceRoot: snapshot.workspaceRoot }),
    window.gosAgent.listSkills(),
    window.gosAgent.listAutomations(),
    window.gosAgent.listTools ? window.gosAgent.listTools() : Promise.resolve({ tools: [] }),
    window.gosAgent.getAiStatus ? window.gosAgent.getAiStatus({ workspaceRoot: snapshot.workspaceRoot }) : Promise.resolve({}),
    window.gosAgent.getLearningStatus({
      workspaceRoot: snapshot.workspaceRoot,
      targetWorkspaceRoot: snapshot.targetWorkspaceRoot,
      labRoot: snapshot.selectedLabRoot || '',
      threadId: activeThread(state)?.id || '',
      changeSessionId: activeThread(state)?.changeSessionId || '',
    }),
    window.gosAgent.getLearningChanges({
      workspaceRoot: snapshot.workspaceRoot,
      targetWorkspaceRoot: snapshot.targetWorkspaceRoot,
      labRoot: snapshot.selectedLabRoot || '',
      threadId: activeThread(state)?.id || '',
      changeSessionId: activeThread(state)?.changeSessionId || '',
      limit: 40,
    }),
    shouldLoadReview && window.gosAgent.getReviewSnapshot
      ? window.gosAgent.getReviewSnapshot({
        workspaceRoot: snapshot.workspaceRoot,
        targetWorkspaceRoot: snapshot.targetWorkspaceRoot,
        labRoot: snapshot.selectedLabRoot || '',
      })
      : Promise.resolve(null),
  ]);
  const nextSnapshot = reviewSnapshot?.review
    ? {
      ...snapshot,
      review: reviewSnapshot.review,
      editorContext: reviewSnapshot.editorContext || snapshot.editorContext,
    }
    : snapshot;

  store.update((current) => ({
    ...current,
    loading: false,
    error: '',
    snapshot: nextSnapshot,
    meta,
    settings: nextSnapshot.settings || current.settings,
    tuning,
    labs,
    benchmarks,
    skills: Array.isArray(skills) ? skills : (Array.isArray((skills as JsonMap)?.skills) ? (skills as JsonMap).skills : []),
    automations: Array.isArray(automations) ? automations : (Array.isArray((automations as JsonMap)?.jobs) ? (automations as JsonMap).jobs : []),
    tools: Array.isArray((tools as JsonMap)?.tools) ? (tools as JsonMap).tools : [],
    aiStatus,
    learningStatus,
    learningChanges,
  }));
}

async function loadShellData() {
  const snapshot = window.gosAgent.bootstrapLite
    ? await window.gosAgent.bootstrapLite({ captureLearning: false })
    : await window.gosAgent.bootstrap({ captureLearning: false });
  const meta = await window.gosAgent.getMeta();
  store.update((current) => ({
    ...current,
    loading: false,
    error: '',
    snapshot,
    meta,
    settings: snapshot.settings || current.settings,
  }));
}

function shellStatus(snapshot: JsonMap | null) {
  const manager = snapshot?.manager || {};
  const settings = snapshot?.settings || {};
  return {
    workspace: snapshot?.workspaceRoot || '',
    target: snapshot?.targetWorkspaceRoot || snapshot?.workspaceRoot || '',
    lab: snapshot?.selectedLabRoot || '',
    summary: summarizeText(
      String(manager.summaryText || 'Workbench is ready for the next safe task.'),
      180,
    ),
    approvals: Number(manager.approvals?.total || 0),
    model: String(settings.model || settings.trainingOllamaModel || 'qwen2.5-coder:7b'),
    runtime: String(settings.runtime || 'ollama'),
  };
}

function normalizeLaneOverrides(value: any): Record<string, JsonMap> {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return Object.entries(value).reduce((accumulator, [laneId, laneValue]) => {
    if (laneValue && typeof laneValue === 'object') {
      accumulator[laneId] = laneValue as JsonMap;
    }
    return accumulator;
  }, {} as Record<string, JsonMap>);
}

function encodeLaneOverrideValue(override: JsonMap | null) {
  const mode = String(override?.mode || '').trim().toLowerCase();
  if (!mode) {
    return 'inherit';
  }
  if (mode === 'benchmark') {
    return 'benchmark';
  }
  if (mode === 'current') {
    return 'current';
  }
  if (mode === 'model') {
    const provider = String(override?.provider || '').trim().toLowerCase() || 'auto';
    const model = String(override?.model || '').trim();
    return model ? `model:${provider}:${model}` : 'inherit';
  }
  return 'inherit';
}

function decodeLaneOverrideValue(value: string): JsonMap | null {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === 'inherit') {
    return null;
  }
  if (normalized === 'benchmark') {
    return { mode: 'benchmark' };
  }
  if (normalized === 'current') {
    return { mode: 'current' };
  }
  if (normalized.startsWith('model:')) {
    const [, provider, ...modelParts] = normalized.split(':');
    const model = modelParts.join(':').trim();
    if (!model) {
      return null;
    }
    return {
      mode: 'model',
      provider: String(provider || '').trim().toLowerCase(),
      model,
    };
  }
  return null;
}

function readAiModelOptions(aiStatus: JsonMap | null, tuning: JsonMap | null, settings: JsonMap) {
  const primary = Array.isArray(aiStatus?.modelCatalog) ? aiStatus.modelCatalog : (Array.isArray(aiStatus?.availableModels) ? aiStatus.availableModels : []);
  const fallback = Array.isArray(tuning?.telemetry?.models?.availableOptions) ? tuning.telemetry.models.availableOptions : [];
  const options: Array<{ model: string; label: string; provider: string; ready: boolean; note: string; source?: string }> = (primary.length ? primary : fallback).map((item: any) => ({
    model: String(item?.model || item?.value || item?.label || '').trim(),
    label: String(item?.label || item?.model || item?.value || '').trim(),
    provider: String(item?.provider || item?.source || 'ollama').trim().toLowerCase(),
    ready: item?.ready !== false,
    note: String(item?.note || '').trim(),
    source: String(item?.source || '').trim(),
  })).filter((item: { model: string }) => item.model);
  const currentModel = String(settings.trainingOllamaModel || '').trim();
  if (currentModel && !options.some((item) => item.model === currentModel)) {
    options.unshift({
      model: currentModel,
      label: currentModel,
      provider: 'ollama',
      ready: false,
      note: 'current setting',
      source: 'current',
    });
  }
  return options;
}

function App() {
  const state = useStoreValue(store);
  const reportRendererError = window.gosAgent.reportRendererError;
  void reportRendererError;
  const handbookPath = 'docs/BAT_FEATURE_BOARD.md';
  const thread = activeThread(state);
  const status = shellStatus(state.snapshot);
  const safeMode = readSafeMode(state.snapshot);
  const approvalItems = readApprovalItems(state.snapshot);
  const changedItems = readChangedFileItems(state.snapshot);
  const inboxItems = buildInboxItems({
    snapshot: state.snapshot,
    learningStatus: state.learningStatus,
    runtimeEvents: state.runtimeEvents,
    benchmarkEvents: state.benchmarkEvents,
  });
  const taskHub = state.snapshot?.taskHub || {};
  const goalList = Array.isArray(taskHub.goals) ? taskHub.goals : [];
  const taskRuns = Array.isArray(taskHub.runs) ? taskHub.runs : [];
  const taskList = Array.isArray(taskHub.tasks) ? taskHub.tasks : [];
  const unreadThreadCount = state.threads.reduce((count, entry) => {
    const latestAssistantId = latestAssistantMessageId(entry);
    if (latestAssistantId && state.threadReadMarkers[entry.id] !== latestAssistantId) {
      return count + 1;
    }
    return count;
  }, 0);
  const chatSignalState = safeMode.active
    ? 'alert'
    : state.busyChat || state.chatFocused
      ? 'active'
      : unreadThreadCount > 0
        ? 'message'
        : 'idle';
  const activeTaskRun = taskRuns.find((item: JsonMap) => ['running', 'queued', 'active', 'in_progress', 'starting'].includes(String(item.runtimeState || item.status || '').toLowerCase()))
    || (Array.isArray(state.snapshot?.recentRuns)
      ? state.snapshot.recentRuns.find((item: JsonMap) => ['running', 'queued', 'active', 'in_progress', 'starting'].includes(String(item.state || item.status || '').toLowerCase()))
      : null);
  const refreshTimerRef = React.useRef<number | null>(null);
  const refreshInFlightRef = React.useRef(false);

  const refreshApp = useEffectEvent(async (mode: 'lite' | 'full' = 'lite') => {
    if (refreshInFlightRef.current) {
      return;
    }
    refreshInFlightRef.current = true;
    try {
      await refreshData(mode);
    } catch (error) {
      store.update((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to refresh desktop state.',
      }));
    } finally {
      refreshInFlightRef.current = false;
    }
  });

  const scheduleRefresh = useEffectEvent((delay = 400) => {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void refreshApp('lite');
    }, delay);
  });

  useEffect(() => {
    void (async () => {
      try {
        await loadShellData();
      } catch (error) {
        store.update((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : 'Failed to load desktop shell.',
        }));
      }
    })();

    const offRun = window.gosAgent.onRunEvent((payload) => {
      appendRuntimeEvent('runtimeEvents', payload);
      if (['pass', 'fail', 'skipped', 'cancelled'].includes(String(payload?.state || ''))) {
        scheduleRefresh(300);
      }
    });
    const offScheduler = window.gosAgent.onSchedulerEvent((payload) => {
      appendRuntimeEvent('runtimeEvents', { ...payload, kind: 'scheduler' });
    });
    const offUpdate = window.gosAgent.onUpdateEvent((payload) => {
      appendRuntimeEvent('runtimeEvents', { ...payload, kind: 'updates' });
    });
    const offTuning = window.gosAgent.onTuningImportEvent((payload) => {
      appendRuntimeEvent('runtimeEvents', { ...payload, kind: 'tuning-import' });
      scheduleRefresh(500);
    });
    const offLearning = window.gosAgent.onLearningEvent((payload) => {
      appendRuntimeEvent('learningEvents', payload);
      store.update((current) => ({
        ...current,
        learningStatus: payload?.targetRoot ? {
          ...current.learningStatus,
          ...payload,
        } : current.learningStatus,
      }));
    });
    const offLab = window.gosAgent.onLabEvent((payload) => {
      appendRuntimeEvent('labEvents', payload);
      scheduleRefresh(500);
    });
    const offBenchmark = window.gosAgent.onBenchmarkEvent((payload) => {
      appendRuntimeEvent('benchmarkEvents', payload);
      scheduleRefresh(500);
    });

    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      offRun();
      offScheduler();
      offUpdate();
      offTuning();
      offLearning();
      offLab();
      offBenchmark();
    };
  }, []);

  useEffect(() => {
    persistThreads(state.threads, state.activeThreadId);
  }, [state.threads, state.activeThreadId]);

  useEffect(() => {
    if (state.activeModuleId !== 'workbench' || !thread) {
      return;
    }
    const latestSeenId = latestAssistantMessageId(thread) || latestMessageId(thread);
    if (!latestSeenId || state.threadReadMarkers[thread.id] === latestSeenId) {
      return;
    }
    store.update((current) => ({
      ...current,
      threadReadMarkers: {
        ...current.threadReadMarkers,
        [thread.id]: latestSeenId,
      },
    }));
  }, [state.activeModuleId, state.threadReadMarkers, thread]);

  useEffect(() => {
    const requestedTheme = String(state.snapshot?.settings?.theme || 'codex').trim().toLowerCase() || 'codex';
    document.body.dataset.theme = ['codex', 'obsidian'].includes(requestedTheme) ? requestedTheme : 'codex';
  }, [state.snapshot?.settings?.theme]);

  const onNewThread = () => {
    const nextThread = createThread(`Thread ${state.threads.length + 1}`);
    store.update((current) => ({
      ...current,
      threads: [nextThread, ...current.threads],
      activeThreadId: nextThread.id,
      threadReadMarkers: {
        ...current.threadReadMarkers,
        [nextThread.id]: latestMessageId(nextThread),
      },
      activeModuleId: 'workbench',
      composerText: '',
      pendingAttachments: [],
    }));
  };

  const onSelectThread = (threadId: string) => {
    store.update((current) => ({
      ...current,
      activeThreadId: threadId,
      activeModuleId: 'workbench',
      pendingAttachments: [],
      threadReadMarkers: {
        ...current.threadReadMarkers,
        [threadId]: latestAssistantMessageId(current.threads.find((entry) => entry.id === threadId)) || latestMessageId(current.threads.find((entry) => entry.id === threadId)),
      },
    }));
  };

  const onPickChatAttachments = async () => {
    const snapshot = store.getState().snapshot;
    const currentThread = activeThread(store.getState());
    if (!snapshot || !currentThread) {
      return;
    }
    const result = await window.gosAgent.pickChatAttachments({
      workspaceRoot: snapshot.workspaceRoot,
      threadId: currentThread.id,
    });
    if (result?.cancelled) {
      return;
    }
    const attachments = Array.isArray(result?.attachments) ? result.attachments : [];
    store.update((current) => ({
      ...current,
      pendingAttachments: [...current.pendingAttachments, ...attachments].slice(-6),
      activeModuleId: 'workbench',
      error: attachments.length > 0 ? '' : (result?.message ? String(result.message) : current.error),
    }));
  };

  const onLoadInspectorPath = async (selectedPath: string, source = 'files') => {
    const snapshot = store.getState().snapshot;
    if (!snapshot || !selectedPath) {
      return;
    }
    const roots = {
      workspaceRoot: snapshot.workspaceRoot,
      targetWorkspaceRoot: snapshot.targetWorkspaceRoot,
      labRoot: snapshot.selectedLabRoot || '',
    };
    const [fileResult, diffResult] = await Promise.all([
      window.gosAgent.readReviewFile({ path: selectedPath, source, ...roots }),
      window.gosAgent.getReviewDiff({ path: selectedPath, source, ...roots }),
    ]);
    store.update((current) => ({
      ...current,
      activeInspectorTab: 'file',
      rightRailOpen: true,
      inspector: {
        ...current.inspector,
        selectedPath,
        fileContent: String(fileResult?.content || fileResult?.message || ''),
        diffContent: String(diffResult?.diff || diffResult?.message || ''),
        fileStatus: fileResult?.ok ? 'Loaded file preview. Edit and save when ready.' : String(fileResult?.message || 'Unable to load file.'),
        diffStatus: diffResult?.ok ? String(diffResult?.summary || 'Loaded diff preview.') : String(diffResult?.message || 'Unable to load diff.'),
        reviewNote: '',
      },
    }));
  };

  const onSendChat = async () => {
    const snapshot = store.getState().snapshot;
    const currentThread = activeThread(store.getState());
    if (!snapshot || !currentThread || store.getState().busyChat) {
      return;
    }
    const text = store.getState().composerText.trim();
    const attachments = Array.isArray(store.getState().pendingAttachments) ? store.getState().pendingAttachments : [];
    if (!text && attachments.length === 0) {
      return;
    }
    const createdAt = new Date().toISOString();
    const userMessage: ChatMessage = {
      id: makeId('msg'),
      role: 'user',
      text,
      createdAt,
      attachments,
    };
    store.update((current) => ({
      ...current,
      busyChat: true,
      composerText: '',
      pendingAttachments: [],
      error: '',
      threads: current.threads.map((entry) => entry.id === currentThread.id
        ? { ...entry, updatedAt: createdAt, messages: [...entry.messages, userMessage] }
        : entry),
    }));

    try {
      const reply = await window.gosAgent.chatMessage(text, snapshot.targetWorkspaceRoot || snapshot.workspaceRoot, {
        workspaceRoot: snapshot.workspaceRoot,
        targetWorkspaceRoot: snapshot.targetWorkspaceRoot,
        labRoot: snapshot.selectedLabRoot || '',
        threadId: currentThread.id,
        changeSessionId: currentThread.changeSessionId,
        history: currentThread.messages.slice(-8).map((entry) => ({ role: entry.role, text: entry.text })),
        attachments,
        chatContext: {
          activeView: store.getState().activeModuleId,
          activeFile: store.getState().inspector.selectedPath,
          changedFiles: changedItems.length,
          approvalCount: approvalItems.length,
          activeRunId: snapshot.recentRuns?.[0]?.runId || snapshot.taskHub?.runs?.[0]?.runId || '',
          activeRunLabel: snapshot.recentRuns?.[0]?.label || '',
          worktree: snapshot.worktree?.scopeLabel || '',
          modelProvisioning: store.getState().aiStatus?.provisioning || {},
        },
      });

      const assistantMessage: ChatMessage = {
        id: makeId('msg'),
        role: 'assistant',
        text: String(reply?.reply || reply?.message || 'No response.'),
        createdAt: new Date().toISOString(),
        suggestions: Array.isArray(reply?.suggestions) ? reply.suggestions : [],
        refs: Array.isArray(reply?.refs) ? reply.refs : [],
      };

      store.update((current) => ({
        ...current,
        busyChat: false,
        threads: current.threads.map((entry) => entry.id === currentThread.id
          ? { ...entry, updatedAt: assistantMessage.createdAt, messages: [...entry.messages, assistantMessage] }
          : entry),
        threadReadMarkers: current.activeModuleId === 'workbench'
          ? {
            ...current.threadReadMarkers,
            [currentThread.id]: assistantMessage.id,
          }
          : current.threadReadMarkers,
      }));

      if (assistantMessage.refs?.[0]?.path) {
        void onLoadInspectorPath(String(assistantMessage.refs[0].path || ''), 'chat-ref');
      }
      await refreshApp('lite');
    } catch (error) {
      const failureMessage: ChatMessage = {
        id: makeId('msg'),
        role: 'system',
        text: error instanceof Error ? error.message : 'Chat failed.',
        createdAt: new Date().toISOString(),
      };
      store.update((current) => ({
        ...current,
        busyChat: false,
        error: failureMessage.text,
        threads: current.threads.map((entry) => entry.id === currentThread.id
          ? { ...entry, updatedAt: failureMessage.createdAt, messages: [...entry.messages, failureMessage] }
          : entry),
        threadReadMarkers: current.activeModuleId === 'workbench'
          ? {
            ...current.threadReadMarkers,
            [currentThread.id]: failureMessage.id,
          }
          : current.threadReadMarkers,
      }));
    }
  };

  const onQuickChat = (command: string) => {
    store.update((current) => ({
      ...current,
      activeModuleId: 'workbench',
      composerText: command,
    }));
  };

  const onOpenMonitorTab = (tab: MonitorTabId = 'overview') => {
    store.update((current) => ({
      ...current,
      activeModuleId: 'monitor',
      activeMonitorTab: tab,
      chatFocused: false,
    }));
    void refreshApp('full');
  };

  const onStopRun = async () => {
    const runId = String(activeTaskRun?.runId || activeTaskRun?.id || '').trim();
    if (!runId) {
      return;
    }
    const result = await window.gosAgent.cancel({ runId });
    store.update((current) => ({
      ...current,
      error: result?.ok === false ? String(result?.message || 'Unable to stop the active run.') : '',
    }));
    await refreshApp('lite');
  };

  const onOpenSettingsTab = (tab: SettingsTabId) => {
    store.update((current) => ({
      ...current,
      activeModuleId: 'settings',
      activeSettingsTab: tab,
      chatFocused: false,
    }));
    void refreshApp('lite');
  };

  const onOpenInbox = () => {
    store.update((current) => ({
      ...current,
      rightRailOpen: true,
      activeInspectorTab: 'inbox',
    }));
    void refreshApp('full');
  };

  const onOpenHandbook = async () => {
    const result = await window.gosAgent.openLocation({ path: handbookPath });
    store.update((current) => ({
      ...current,
      error: result?.ok ? '' : String(result?.message || 'Unable to open the handbook.'),
    }));
  };

  const onRollbackLatestBackup = async (backupId = '') => {
    const promotionBackups = Array.isArray(state.snapshot?.promotions?.backups) ? state.snapshot?.promotions?.backups : [];
    const availableBackups = await window.gosAgent.listBackups();
    const updaterBackups = Array.isArray(availableBackups) ? availableBackups : [];
    const selectedBackupId = String(backupId || promotionBackups[0]?.id || updaterBackups[0] || '').trim();
    if (!selectedBackupId) {
      store.update((current) => ({
        ...current,
        error: 'No backup is available to restore yet.',
      }));
      return;
    }
    const confirmed = window.confirm(`Restore backup ${selectedBackupId}? This will replace the protected workspace files from the latest known-good snapshot.`);
    if (!confirmed) {
      return;
    }
    const isPromotionBackup = promotionBackups.some((item: JsonMap) => String(item?.id || '') === selectedBackupId);
    const result = isPromotionBackup
      ? await window.gosAgent.rollbackPromotion({ backupId: selectedBackupId, workspaceRoot: state.snapshot?.workspaceRoot })
      : await window.gosAgent.rollbackUpdates({ backupId: selectedBackupId });
    store.update((current) => ({
      ...current,
      error: result?.ok ? '' : String(result?.error || result?.message || 'Rollback failed.'),
    }));
    await refreshApp('full');
  };

  const onOpenInboxItem = async (item: InboxItem) => {
    if (item.backupId) {
      await onRollbackLatestBackup(item.backupId);
      return;
    }
    if (item.openModule === 'monitor') {
      onOpenMonitorTab(item.targetTab === 'learning' ? 'learning' : item.targetTab === 'overview' ? 'overview' : 'promotions');
      return;
    }
    if (item.path) {
      await onLoadInspectorPath(item.path, item.source || 'inbox');
      return;
    }
    store.update((current) => ({
      ...current,
      rightRailOpen: true,
      activeInspectorTab: item.targetTab === 'file' || item.targetTab === 'diff' || item.targetTab === 'learning'
        ? item.targetTab
        : 'inbox',
    }));
  };

  const onSwitchWorkspace = async () => {
    await window.gosAgent.pickWorkspace();
    await refreshApp('lite');
  };

  const onSelectLab = async (labRoot: string) => {
    const snapshot = store.getState().snapshot;
    if (!snapshot) {
      return;
    }
    await window.gosAgent.setLab({
      workspaceRoot: snapshot.workspaceRoot,
      labRoot,
      threadId: activeThread(store.getState())?.id || '',
      changeSessionId: activeThread(store.getState())?.changeSessionId || '',
    });
    await refreshApp('lite');
  };

  const onClearLab = async () => {
    const snapshot = store.getState().snapshot;
    if (!snapshot) {
      return;
    }
    await window.gosAgent.setLab({
      workspaceRoot: snapshot.workspaceRoot,
      labRoot: '',
      threadId: activeThread(store.getState())?.id || '',
      changeSessionId: activeThread(store.getState())?.changeSessionId || '',
    });
    await refreshApp('lite');
  };

  const onCaptureLearning = async () => {
    const snapshot = store.getState().snapshot;
    if (!snapshot) {
      return;
    }
    await window.gosAgent.learning.capture({
      workspaceRoot: snapshot.workspaceRoot,
      targetWorkspaceRoot: snapshot.targetWorkspaceRoot,
      labRoot: snapshot.selectedLabRoot || '',
      summary: 'Captured from the desktop learning panel.',
      focusArea: 'workbench-feedback-loop',
    });
    await refreshApp('lite');
  };

  const onRunBenchmark = async () => {
    const snapshot = store.getState().snapshot;
    if (!snapshot) {
      return;
    }
    await window.gosAgent.runBenchmark({
      workspaceRoot: snapshot.workspaceRoot,
      targetWorkspaceRoot: snapshot.targetWorkspaceRoot,
      labRoot: snapshot.selectedLabRoot || '',
      name: snapshot.selectedLabRoot ? 'active-lab-benchmark' : 'workspace-benchmark',
      threadId: thread?.id || '',
      changeSessionId: thread?.changeSessionId || '',
    });
    await refreshApp('lite');
  };

  const onRunAcceptance = async () => {
    const snapshot = store.getState().snapshot;
    if (!snapshot) {
      return;
    }
    store.update((current) => ({
      ...current,
      busyAcceptance: true,
      error: '',
    }));
    try {
      const result = await window.gosAgent.runMonitorAcceptance({
        workspaceRoot: snapshot.workspaceRoot,
      });
      store.update((current) => ({
        ...current,
        error: result?.ok ? '' : String(result?.message || 'Unable to run the engine acceptance suite.'),
      }));
      await refreshApp('full');
    } finally {
      store.update((current) => ({
        ...current,
        busyAcceptance: false,
      }));
    }
  };

  const onSetManualSafeMode = async (enabled: boolean) => {
    const snapshot = store.getState().snapshot;
    if (!snapshot) {
      return;
    }
    const confirmed = enabled
      ? window.confirm('Engage hard safe mode? This will stop the scheduler, cancel risky active runs, and keep promotions paused until you release it.')
      : window.confirm('Release manual safe mode? The current safety level will stay in place until you change it.');
    if (!confirmed) {
      return;
    }
    store.update((current) => ({
      ...current,
      busySafetyController: true,
      error: '',
    }));
    try {
      const result = await window.gosAgent.setMonitorSafeMode({
        workspaceRoot: snapshot.workspaceRoot,
        enabled,
      });
      store.update((current) => ({
        ...current,
        error: result?.ok ? '' : String(result?.message || 'Unable to update hard safe mode.'),
      }));
      await refreshApp('full');
    } finally {
      store.update((current) => ({
        ...current,
        busySafetyController: false,
      }));
    }
  };

  const onUpdateSetting = async (field: string, value: any) => {
    await window.gosAgent.updateSettings({
      [field]: value,
      threadId: thread?.id || '',
      changeSessionId: thread?.changeSessionId || '',
    });
    await refreshApp('lite');
  };

  const onCreateSuggestedTask = async (candidate: JsonMap) => {
    const snapshot = store.getState().snapshot;
    if (!snapshot) {
      return;
    }
    const result = await window.gosAgent.createTask({
      workspaceRoot: snapshot.workspaceRoot,
      targetWorkspaceRoot: snapshot.targetWorkspaceRoot,
      labRoot: snapshot.selectedLabRoot || '',
      threadId: thread?.id || '',
      changeSessionId: thread?.changeSessionId || '',
      title: String(candidate.title || candidate.objective || 'Follow-up task'),
      objective: String(candidate.objective || candidate.summary || candidate.title || 'Create a bounded follow-up task from review feedback.'),
      source: String(candidate.source || candidate.kind || 'reviewer'),
      riskClass: String(candidate.riskClass || (candidate.kind === 'regression' ? 'low' : 'medium')),
      targetPaths: Array.isArray(candidate.targetPaths) ? candidate.targetPaths : [],
      capabilities: Array.isArray(candidate.capabilities) ? candidate.capabilities : [],
      acceptanceChecks: Array.isArray(candidate.acceptanceChecks) ? candidate.acceptanceChecks : [],
      budget: candidate.budget && typeof candidate.budget === 'object' ? candidate.budget : undefined,
      ring: String(candidate.ring || '').trim(),
      promotionState: String(candidate.promotionState || '').trim(),
      candidateId: String(candidate.id || '').trim(),
      metadata: {
        ...(candidate.metadata && typeof candidate.metadata === 'object' ? candidate.metadata : {}),
        createdFromMonitor: true,
        candidateKind: String(candidate.kind || ''),
        candidateCategory: String(candidate.category || ''),
        candidateSummary: String(candidate.summary || ''),
        followupSignature: String(
          candidate.metadata?.followupSignature
          || (candidate.id ? `monitor-followup:${String(candidate.id).trim()}` : '')
        ).trim(),
      },
    });
    store.update((current) => ({
      ...current,
      error: result?.ok === false ? String(result?.message || 'Unable to create the follow-up task.') : '',
    }));
    await refreshApp('full');
  };

  const onRecordOperatorFeedback = async (payload: JsonMap) => {
    const snapshot = store.getState().snapshot;
    if (!snapshot) {
      return;
    }
    const result = await window.gosAgent.recordOperatorFeedback({
      workspaceRoot: snapshot.workspaceRoot,
      targetWorkspaceRoot: snapshot.targetWorkspaceRoot,
      labRoot: snapshot.selectedLabRoot || '',
      threadId: thread?.id || '',
      changeSessionId: thread?.changeSessionId || '',
      ...payload,
    });
    store.update((current) => ({
      ...current,
      error: result?.ok ? '' : String(result?.message || 'Unable to record operator feedback.'),
    }));
    if (result?.ok) {
      await refreshApp('full');
    }
  };

  const onQueueSuggestedRecipe = async (recipe: JsonMap) => {
    const snapshot = store.getState().snapshot;
    if (!snapshot) {
      return;
    }
    const result = await window.gosAgent.queueFollowupRecipe({
      workspaceRoot: snapshot.workspaceRoot,
      targetWorkspaceRoot: snapshot.targetWorkspaceRoot,
      labRoot: snapshot.selectedLabRoot || '',
      threadId: thread?.id || '',
      changeSessionId: thread?.changeSessionId || '',
      recipe,
    });
    store.update((current) => ({
      ...current,
      error: result?.ok === false ? String(result?.message || 'Unable to queue the supervised recipe.') : '',
    }));
    await refreshApp('full');
  };

  const onCreateLab = async (recipe: string) => {
    const snapshot = store.getState().snapshot;
    if (!snapshot) {
      return;
    }
    const persistentRecipes = new Set(['self-host']);
    await window.gosAgent.runLabRecipe({
      workspaceRoot: snapshot.workspaceRoot,
      recipe,
      kind: persistentRecipes.has(recipe) ? 'persistent' : 'scratch',
      selectAfterCreate: true,
      threadId: thread?.id || '',
      changeSessionId: thread?.changeSessionId || '',
    });
    await refreshApp('lite');
  };

  const onCreateCandidate = async () => {
    const snapshot = store.getState().snapshot;
    if (!snapshot?.selectedLabRoot) {
      store.update((current) => ({
        ...current,
        error: 'Select a lab before creating a candidate.',
      }));
      return;
    }
    const labs = Array.isArray(snapshot?.labs?.labs) ? snapshot.labs.labs : [];
    const activeLab = labs.find((item: JsonMap) => String(item?.labRoot || '') === String(snapshot.selectedLabRoot || '')) || null;
    const liveTargetRoot = String(activeLab?.sourceRoot || snapshot.workspaceRoot || '').trim() || String(snapshot.workspaceRoot || '');
    const result = await window.gosAgent.createCandidate({
      workspaceRoot: snapshot.workspaceRoot,
      targetWorkspaceRoot: liveTargetRoot,
      labRoot: snapshot.selectedLabRoot,
      name: `${shortPath(snapshot.selectedLabRoot) || 'candidate'} candidate`,
    });
    store.update((current) => ({
      ...current,
      error: result?.ok ? '' : String(result?.message || 'Unable to create candidate.'),
    }));
    await refreshApp('full');
  };

  const onPromoteCandidate = async (candidateId: string) => {
    const snapshot = store.getState().snapshot;
    if (!snapshot) {
      return;
    }
    const confirmed = window.confirm('Promote this candidate to the live workspace? A promotion backup will be created first.');
    if (!confirmed) {
      return;
    }
    const candidates = Array.isArray(snapshot?.promotions?.candidates) ? snapshot.promotions.candidates : [];
    const targetCandidate = candidates.find((item: JsonMap) => String(item?.id || '') === String(candidateId || '')) || null;
    const liveTargetRoot = String(targetCandidate?.targetWorkspaceRoot || targetCandidate?.sourceRoot || snapshot.workspaceRoot || '').trim() || String(snapshot.workspaceRoot || '');
    const result = await window.gosAgent.promoteCandidate({
      workspaceRoot: snapshot.workspaceRoot,
      targetWorkspaceRoot: liveTargetRoot,
      candidateId,
      labRoot: snapshot.selectedLabRoot || '',
    });
    store.update((current) => ({
      ...current,
      error: result?.ok ? '' : String(result?.message || 'Unable to promote candidate.'),
    }));
    await refreshApp('full');
  };

  const onExportMonitorBundle = async () => {
    const snapshot = store.getState().snapshot;
    if (!snapshot) {
      return;
    }
    const result = await window.gosAgent.exportMonitorDebugBundle({
      workspaceRoot: snapshot.workspaceRoot,
      name: 'monitor-debug',
    });
    store.update((current) => ({
      ...current,
      error: result?.ok ? '' : String(result?.message || 'Unable to export debug bundle.'),
    }));
    await refreshApp('lite');
  };

  const onOpenInspectorInIde = async () => {
    const snapshot = store.getState().snapshot;
    const selectedPath = String(store.getState().inspector.selectedPath || '').trim();
    if (!snapshot || !selectedPath) {
      return;
    }
    await window.gosAgent.openInVsCode({
      workspaceRoot: snapshot.workspaceRoot,
      targetWorkspaceRoot: snapshot.targetWorkspaceRoot,
      labRoot: snapshot.selectedLabRoot || '',
      path: selectedPath,
    });
  };

  const onSaveInspector = async () => {
    const snapshot = store.getState().snapshot;
    const inspector = store.getState().inspector;
    if (!snapshot || !inspector.selectedPath) {
      return;
    }
    const result = await window.gosAgent.saveReviewFile({
      workspaceRoot: snapshot.workspaceRoot,
      targetWorkspaceRoot: snapshot.targetWorkspaceRoot,
      labRoot: snapshot.selectedLabRoot || '',
      path: inspector.selectedPath,
      content: inspector.fileContent,
      line: 1,
    });
    store.update((current) => ({
      ...current,
      error: result?.ok ? '' : String(result?.message || 'Unable to save file.'),
      inspector: {
        ...current.inspector,
        diffContent: result?.ok ? String(result?.diff || current.inspector.diffContent || '') : current.inspector.diffContent,
        fileStatus: result?.ok ? 'Saved file changes from the workbench editor.' : String(result?.message || 'Unable to save file.'),
        diffStatus: result?.ok ? String(result?.summary || 'Diff updated after save.') : current.inspector.diffStatus,
      },
    }));
    if (result?.ok) {
      await refreshApp('full');
    }
  };

  const onReviewDecision = async (decision: 'approved' | 'rejected' | 'deferred') => {
    const snapshot = store.getState().snapshot;
    const inspector = store.getState().inspector;
    if (!snapshot || !inspector.selectedPath) {
      return;
    }
    const result = await window.gosAgent.setReviewDecision({
      workspaceRoot: snapshot.workspaceRoot,
      targetWorkspaceRoot: snapshot.targetWorkspaceRoot,
      labRoot: snapshot.selectedLabRoot || '',
      path: inspector.selectedPath,
      status: decision,
      note: inspector.reviewNote || '',
    });
    store.update((current) => ({
      ...current,
      error: result?.ok ? '' : String(result?.message || 'Unable to record review decision.'),
      inspector: {
        ...current.inspector,
        fileStatus: result?.ok
          ? `Marked ${decision} for ${current.inspector.selectedPath}.`
          : String(result?.message || 'Unable to record review decision.'),
      },
    }));
    if (result?.ok) {
      await refreshApp('full');
    }
  };

  return (
    <div className={`workbench-shell${state.leftRailOpen ? ' left-open' : ''}${state.rightRailOpen ? ' right-open' : ''}`} data-workbench-shell="true">
      <aside className="left-rail app-nav-rail">
        <div className="rail-brand-row">
          <div className="rail-brand-badge">GS</div>
          <button className="icon-button rail-collapse" onClick={() => store.update((current) => ({ ...current, leftRailOpen: false }))}>Close</button>
        </div>

        <button className="new-chat-button" onClick={onNewThread}>
          <span>New chat</span>
        </button>

        <nav className="rail-nav-list">
          <button
            className={`rail-nav-item${state.activeModuleId === 'workbench' ? ' active' : ''}`}
            data-module-nav="workbench"
            data-route-tab="workbench"
            onClick={() => store.update((current) => ({ ...current, activeModuleId: 'workbench' }))}
          >
            <strong>Agents</strong>
            <span>{unreadThreadCount > 0 ? `${unreadThreadCount} active session${unreadThreadCount === 1 ? '' : 's'}` : 'Open the main workspace chat'}</span>
          </button>
          <button
            className={`rail-nav-item${state.activeModuleId === 'settings' && state.activeSettingsTab === 'workspace' ? ' active' : ''}`}
            data-route-tab="settings"
            onClick={() => onOpenSettingsTab('workspace')}
          >
            <strong>Spaces</strong>
            <span>{shortPath(status.target) || 'Choose a workspace root'}</span>
          </button>
          <button
            className={`rail-nav-item${state.activeModuleId === 'monitor' ? ' active' : ''}`}
            data-route-tab="monitor"
            onClick={() => onOpenMonitorTab('overview')}
          >
            <strong>Spark</strong>
            <span>{activeTaskRun ? 'Live run status is available' : 'Preview runs, learning, and promotions'}</span>
            <em>Preview</em>
          </button>
        </nav>

        <section className="rail-session-section">
          <div className="rail-section-head">
            <span>Agent sessions</span>
            <button className="icon-button" onClick={onNewThread}>+</button>
          </div>
          <div className="thread-list session-thread-list">
            {state.threads.slice(0, 6).map((entry) => {
              const latestSeenId = latestAssistantMessageId(entry) || latestMessageId(entry);
              const unread = Boolean(latestSeenId && state.threadReadMarkers[entry.id] !== latestSeenId);
              const preview = [...entry.messages].reverse().find((message) => message.role !== 'system')?.text || 'Initial implementation';
              return (
                <button
                  key={entry.id}
                  className={`thread-btn session-thread-btn${entry.id === thread?.id ? ' active' : ''}`}
                  onClick={() => onSelectThread(entry.id)}
                >
                  <div className="session-thread-title-row">
                    <strong>{entry.title}</strong>
                    {unread ? <span className="session-unread-dot" aria-hidden="true" /> : null}
                  </div>
                  <span>{summarizeText(preview, 56)}</span>
                  <small>{formatStamp(entry.updatedAt)} • {entry.messages.length} msgs</small>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rail-session-section secondary">
          <div className="rail-section-head">
            <span>Chats</span>
            <button className="icon-button" onClick={() => void onOpenHandbook()}>?</button>
          </div>
          <div className="rail-mini-card">
            <strong>{status.lab ? 'Lab active' : 'Workspace ready'}</strong>
            <span>{status.lab ? shortPath(status.lab) : shortPath(status.target) || shortPath(status.workspace) || 'No workspace selected'}</span>
            <div className="row-actions">
              <button className="ghost" onClick={onSwitchWorkspace}>Switch</button>
              <button className="ghost" onClick={() => void onOpenHandbook()}>Handbook</button>
            </div>
          </div>
        </section>
      </aside>

      <div className="main-column">
        <header className="topbar topbar-minimal">
          <div className="topbar-left">
            <button className="icon-button" data-sidebar-toggle="left" onClick={() => store.update((current) => ({ ...current, leftRailOpen: !current.leftRailOpen }))}>
              Menu
            </button>
            <div className="topbar-copy">
              <strong>{thread?.title || 'New thread'}</strong>
              <span>{shortPath(status.target) || 'Pick a workspace'}</span>
            </div>
          </div>

          <div className="topbar-actions">
            <button
              className={`toolbar-chip${state.activeModuleId === 'monitor' ? ' active' : ''}`}
              data-route-tab="monitor"
              onClick={() => onOpenMonitorTab(state.activeMonitorTab || 'overview')}
            >
              CLI
            </button>
            <button
              className={`toolbar-chip${state.activeModuleId === 'workbench' ? ' active' : ''}`}
              data-route-tab="workbench"
              onClick={() => store.update((current) => ({ ...current, activeModuleId: 'workbench' }))}
            >
              Chat
            </button>
            <button
              className={`toolbar-chip${state.activeModuleId === 'settings' ? ' active' : ''}`}
              data-route-tab="settings"
              onClick={() => onOpenSettingsTab(state.activeSettingsTab || 'ai')}
            >
              Download
            </button>
            <button className="toolbar-chip" onClick={() => void refreshApp('full')}>Sync</button>
            <button className="toolbar-chip" onClick={() => void onOpenHandbook()}>Handbook</button>
          </div>
        </header>

        <main className="center-panel main-surface">
          {state.activeModuleId === 'workbench' ? (
            <WorkbenchPanel
              snapshot={state.snapshot}
              aiStatus={state.aiStatus}
              learningStatus={state.learningStatus}
              thread={thread}
              composerText={state.composerText}
              pendingAttachments={state.pendingAttachments}
              busyChat={state.busyChat}
              chatSignalState={chatSignalState}
              unreadCount={unreadThreadCount}
              safeMode={safeMode}
              inboxItems={inboxItems}
              changedItems={changedItems}
              approvalItems={approvalItems}
              goalList={goalList}
              taskList={taskList}
              taskRuns={taskRuns}
              threads={state.threads}
              activeThreadId={state.activeThreadId}
              threadReadMarkers={state.threadReadMarkers}
              onComposerChange={(value) => store.update((current) => ({ ...current, composerText: value }))}
              onChatFocusChange={(focused) => store.update((current) => ({ ...current, chatFocused: focused }))}
              onSendChat={onSendChat}
              onQuickChat={onQuickChat}
              onPickAttachments={onPickChatAttachments}
              onNewThread={onNewThread}
              onSelectThread={onSelectThread}
              onUpdateSetting={onUpdateSetting}
              onSelectPath={onLoadInspectorPath}
              onShowInspector={(tab) => {
                store.update((current) => ({
                  ...current,
                  rightRailOpen: true,
                  activeInspectorTab: tab,
                }));
                if (tab === 'inbox') {
                  void refreshApp('full');
                }
              }}
              onOpenInbox={onOpenInbox}
              onRollbackLatestBackup={onRollbackLatestBackup}
            />
          ) : null}

          {state.activeModuleId === 'settings' ? (
            <SettingsPanel
              snapshot={state.snapshot}
              settings={state.settings}
              activeTab={state.activeSettingsTab}
              aiStatus={state.aiStatus}
              goalList={goalList}
              taskList={taskList}
              taskRuns={taskRuns}
              skills={state.skills}
              tools={state.tools}
              automations={state.automations}
              tuning={state.tuning}
              labs={state.labs}
              benchmarks={state.benchmarks}
              learningStatus={state.learningStatus}
              learningChanges={state.learningChanges}
              onPickWorkspace={onSwitchWorkspace}
              onSetActiveTab={(tab) => onOpenSettingsTab(tab)}
              onUpdateSetting={onUpdateSetting}
              onSelectLab={onSelectLab}
              onClearLab={onClearLab}
              onCaptureLearning={onCaptureLearning}
              onRunBenchmark={onRunBenchmark}
              onRefresh={() => void refreshApp('full')}
              onCreateLab={onCreateLab}
              onExportLearning={async () => {
                await window.gosAgent.exportLearningChanges({
                  workspaceRoot: state.snapshot?.workspaceRoot,
                  targetWorkspaceRoot: state.snapshot?.targetWorkspaceRoot,
                  labRoot: state.snapshot?.selectedLabRoot || '',
                  threadId: thread?.id || '',
                  changeSessionId: thread?.changeSessionId || '',
                });
                await refreshApp('lite');
              }}
            />
          ) : null}

          {state.activeModuleId === 'monitor' ? (
            <MonitorPanel
              snapshot={state.snapshot}
              aiStatus={state.aiStatus}
              tuning={state.tuning}
              learningStatus={state.learningStatus}
              runtimeEvents={state.runtimeEvents}
              learningEvents={state.learningEvents}
              labEvents={state.labEvents}
              benchmarkEvents={state.benchmarkEvents}
              activeTab={state.activeMonitorTab}
              onSetActiveTab={(tab) => store.update((current) => ({ ...current, activeMonitorTab: tab, activeModuleId: 'monitor' }))}
              onCreateCandidate={onCreateCandidate}
              onPromoteCandidate={onPromoteCandidate}
              onRollbackLatestBackup={onRollbackLatestBackup}
              onSetManualSafeMode={onSetManualSafeMode}
              onRunBenchmark={onRunBenchmark}
              onRunAcceptance={onRunAcceptance}
              onExportDebugBundle={onExportMonitorBundle}
              onOpenReviewPath={onLoadInspectorPath}
              onCreateSuggestedTask={onCreateSuggestedTask}
              onQueueSuggestedRecipe={onQueueSuggestedRecipe}
              onRecordOperatorFeedback={onRecordOperatorFeedback}
              onRefresh={() => void refreshApp('full')}
              acceptanceBusy={state.busyAcceptance}
              safetyBusy={state.busySafetyController}
            />
          ) : null}
        </main>
      </div>

      <aside className="inspector">
        <div className="rail-header">
          <div className="eyebrow">Context</div>
          <button className="icon-button" data-sidebar-toggle="right" onClick={() => store.update((current) => ({ ...current, rightRailOpen: false }))}>
            Close
          </button>
        </div>

        <div className="inspector-tabs">
          {(['inbox', 'file', 'diff', 'learning'] as const).map((tab) => (
            <button
              key={tab}
              className={state.activeInspectorTab === tab ? 'active' : ''}
              data-inspector-tab={tab}
              onClick={() => store.update((current) => ({ ...current, activeInspectorTab: tab, rightRailOpen: true }))}
            >
              {tab}
            </button>
          ))}
        </div>

        {state.activeInspectorTab === 'inbox' ? (
          <InboxInspector
            snapshot={state.snapshot}
            learningStatus={state.learningStatus}
            inboxItems={inboxItems}
            onSelectPath={onLoadInspectorPath}
            onOpenItem={onOpenInboxItem}
          />
        ) : null}

        {state.activeInspectorTab === 'file' ? (
          <FileInspector
            inspector={state.inspector}
            onChange={(value) => store.update((current) => ({
              ...current,
              inspector: {
                ...current.inspector,
                fileContent: value,
              },
            }))}
            onNoteChange={(value) => store.update((current) => ({
              ...current,
              inspector: {
                ...current.inspector,
                reviewNote: value,
              },
            }))}
            onSave={onSaveInspector}
            onOpenInIde={onOpenInspectorInIde}
            onDecision={onReviewDecision}
          />
        ) : null}

        {state.activeInspectorTab === 'diff' ? (
          <TextInspector title={state.inspector.selectedPath || 'Diff preview'} status={state.inspector.diffStatus} text={state.inspector.diffContent} />
        ) : null}

        {state.activeInspectorTab === 'learning' ? (
          <LearningInspector snapshot={state.snapshot} learningStatus={state.learningStatus} />
        ) : null}
      </aside>

      {state.loading ? <div className="overlay">Loading desktop workbench…</div> : null}
      {state.error ? <div className="error-banner">{state.error}</div> : null}
    </div>
  );
}

function WorkbenchPanel(props: {
  snapshot: JsonMap | null;
  aiStatus: JsonMap | null;
  learningStatus: JsonMap;
  thread: ChatThread | undefined;
  threads: ChatThread[];
  activeThreadId: string;
  threadReadMarkers: Record<string, string>;
  composerText: string;
  pendingAttachments: JsonMap[];
  busyChat: boolean;
  chatSignalState: 'idle' | 'active' | 'message' | 'alert';
  unreadCount: number;
  safeMode: JsonMap;
  inboxItems: InboxItem[];
  changedItems: JsonMap[];
  approvalItems: JsonMap[];
  goalList: JsonMap[];
  taskList: JsonMap[];
  taskRuns: JsonMap[];
  onComposerChange: (value: string) => void;
  onChatFocusChange: (focused: boolean) => void;
  onSendChat: () => void;
  onQuickChat: (command: string) => void;
  onPickAttachments: () => void;
  onNewThread: () => void;
  onSelectThread: (threadId: string) => void;
  onUpdateSetting: (key: string, value: any) => void | Promise<void>;
  onSelectPath: (path: string, source?: string) => void;
  onShowInspector: (tab: 'inbox' | 'file' | 'diff' | 'learning') => void;
  onOpenInbox: () => void;
  onRollbackLatestBackup: (backupId?: string) => void;
}) {
  const [managerPanelOpen, setManagerPanelOpen] = React.useState(false);
  const settings = props.snapshot?.settings || {};
  const chatModes = ['auto', 'ask', 'plan', 'edit', 'agent'] as const;
  const messages = props.thread?.messages || [];
  const isFreshThread = !messages.some((message) => message.role !== 'system');
  const chatMode = chatModes.includes(String(settings.chatMode || '').trim().toLowerCase() as typeof chatModes[number])
    ? (String(settings.chatMode || '').trim().toLowerCase() as typeof chatModes[number])
    : 'auto';
  const chatTransparencyLevel = String(settings.chatTransparencyLevel || 'balanced');
  const effectiveChatMode = chatMode;
  const modeSummaryLabel = `effective ${effectiveChatMode}`;
  const modeRouteSummary: Record<typeof chatModes[number], string> = {
    auto: 'supervised engine loop',
    ask: 'answer directly without mutating the workspace',
    plan: 'shape the next safe slice before making edits',
    edit: 'focus on bounded repo edits and validation',
    agent: 'use auto manager to route the full operator loop',
  };
  const branchLabel = String(props.snapshot?.git?.branch || props.snapshot?.review?.branch || 'workspace').trim() || 'workspace';
  const safetyLabel = props.safeMode.active
    ? 'Safe mode active'
    : (props.safeMode.watchOnly ? 'Safety watch active' : 'Safety ready');
  const openModule = props.inboxItems.length > 0 ? 'monitor' : 'workbench';
  const latestGoal = props.goalList[0] || null;
  const latestTask = props.taskList[0] || null;
  const latestRun = props.taskRuns[0] || null;
  const recentRuns = props.taskRuns.slice(0, 4);
  const recentThreads = props.threads.slice(0, 4);
  const workspaceLabel = shortPath(props.snapshot?.targetWorkspaceRoot || props.snapshot?.workspaceRoot || '') || 'workspace';
  const modelLabel = String(settings.model || settings.trainingOllamaModel || 'qwen2.5-coder:7b');
  const testBench = props.snapshot?.testBench && typeof props.snapshot.testBench === 'object'
    ? props.snapshot.testBench
    : {};
  const docsContext = props.snapshot?.manager?.approvedDocsVault && typeof props.snapshot.manager.approvedDocsVault === 'object'
    ? props.snapshot.manager.approvedDocsVault
    : {};
  const composerSuggestions = buildComposerSuggestions({
    composerText: props.composerText,
    learningStatus: props.learningStatus,
    pendingAttachments: props.pendingAttachments,
    safeMode: props.safeMode,
    docsContext,
    nextSafeAction: testBench?.nextSafeAction && typeof testBench.nextSafeAction === 'object'
      ? testBench.nextSafeAction
      : {},
    safeRecipe: testBench?.safeRecipe && typeof testBench.safeRecipe === 'object'
      ? testBench.safeRecipe
      : {},
  });
  const promptCards = [
    `Plan the next safe coding task in ${shortPath(props.snapshot?.targetWorkspaceRoot || props.snapshot?.workspaceRoot || '') || 'this repo'}.`,
    'Review the current repo and tell me what needs fixing first.',
    'Set up the coding model and verify the engine is ready.',
  ];
  const launcherActions = [
    { label: 'Agent', onClick: () => void props.onUpdateSetting('chatMode', 'agent') },
    { label: 'Create issue', onClick: () => props.onQuickChat('Create a scoped issue list for the current workspace and rank it by impact.') },
    { label: 'Spark', onClick: () => props.onQuickChat('Brainstorm three high-leverage improvements for this repo and explain the tradeoffs.') },
    { label: 'Git', onClick: () => props.onShowInspector('file') },
    { label: 'Pull requests', onClick: () => props.onShowInspector('inbox') },
  ];
  const recentSessionItems = recentRuns.length > 0
    ? recentRuns.map((item) => ({
      id: String(item?.runId || item?.id || item?.runtimeLabel || Math.random()),
      title: String(item?.runtimeLabel || item?.label || item?.title || 'Session'),
      status: String(item?.runtimeState || item?.status || item?.riskClass || 'ready'),
      detail: summarizeText(String(item?.blockedReason || item?.summary || item?.objective || 'No extra detail recorded yet.'), 120),
      meta: String(item?.completedAt || item?.updatedAt || item?.createdAt || ''),
      onClick: latestTask ? () => props.onQuickChat(`Summarize the current run state for ${String(item?.runtimeLabel || item?.label || 'this session')}.`) : undefined,
    }))
    : recentThreads.map((entry) => {
      const latestSeenId = latestAssistantMessageId(entry) || latestMessageId(entry);
      const unread = Boolean(latestSeenId && props.threadReadMarkers[entry.id] !== latestSeenId);
      const preview = [...entry.messages].reverse().find((message) => message.role !== 'system')?.text || 'No reply recorded yet.';
      return {
        id: entry.id,
        title: entry.title,
        status: unread ? 'unread' : 'read',
        detail: summarizeText(preview, 120),
        meta: formatStamp(entry.updatedAt),
        onClick: () => props.onSelectThread(entry.id),
      };
    });

  return (
    <section className="module-panel workbench-panel" data-panel="workbench">
      <div className="chat-home">
        <div
          className={`chat-home-main${isFreshThread ? ' is-fresh-thread' : ''} signal-${props.chatSignalState}`}
          data-chat-signal={props.chatSignalState}
        >
          {props.safeMode.active || props.safeMode.watchOnly ? (
            <section className={`safety-banner${props.safeMode.active ? ' is-alert' : ''}`}>
              <div>
                <div className="eyebrow">Safety</div>
                <strong>{props.safeMode.active ? 'Safe mode is protecting the live workspace' : 'Safety watch is active'}</strong>
                <p>{String(props.safeMode.summary || 'Safety guardrails are active for this workspace.')}</p>
              </div>
              <div className="row-actions">
                <button className="ghost" onClick={props.onOpenInbox}>Open inbox</button>
                {props.safeMode.rollbackAvailable ? (
                  <button className="ghost" onClick={() => props.onRollbackLatestBackup(String(props.safeMode.latestBackupId || ''))}>
                    Restore latest backup
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          <div className="workbench-start-shell">
            <section className="workbench-hero-panel">
              {isFreshThread ? (
                <div className="chat-empty-state compact start-hero-copy" data-legacy-empty-title="Let's build">
                  <div className="start-hero-mark">GS</div>
                  <h2>Ask anything</h2>
                  <p>{workspaceLabel} • {modelLabel}</p>
                </div>
              ) : (
                <div className="chat-stage start-conversation-stage">
                  <div className="chat-log" data-chat-log="true">
                    {messages.map((message) => (
                      <article key={message.id} className={`chat-bubble ${message.role}`}>
                        <header>
                          <strong>{message.role}</strong>
                          <span>{formatStamp(message.createdAt)}</span>
                        </header>
                        <p>{message.text || (Array.isArray(message.attachments) && message.attachments.length > 0 ? 'Attached screenshot context.' : '')}</p>
                        {Array.isArray(message.attachments) && message.attachments.length > 0 ? (
                          <div className="chip-row">
                            {message.attachments.map((attachment, index) => (
                              <span key={`${message.id}-attachment-${index}`} className="attachment-chip">
                                {attachment.originalName || attachment.name || `attachment ${index + 1}`}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {message.refs?.length ? (
                          <div className="chip-row">
                            {message.refs.map((ref, index) => (
                              <button
                                key={`${message.id}-${index}`}
                                className="ghost"
                                onClick={() => ref.path ? props.onSelectPath(String(ref.path), 'chat-ref') : undefined}
                              >
                                {ref.label || shortPath(ref.path)}
                              </button>
                            ))}
                          </div>
                        ) : null}
                        {message.suggestions?.length ? (
                          <div className="chip-row">
                            {message.suggestions.map((suggestion) => (
                              <button key={suggestion} className="ghost" onClick={() => props.onQuickChat(suggestion)}>
                                {suggestion}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </article>
                    ))}
                  </div>
                </div>
              )}

              <div className="composer chat-composer launch-composer">
                <div className="chat-mode-bar launch-toolbar">
                  <label className="selector-chip">
                    <span>Mode</span>
                    <select value={String(settings.chatMode || 'auto')} onChange={(event) => void props.onUpdateSetting("chatMode", event.target.value)} aria-label="Chat mode">
                      {chatModes.map((mode) => (
                        <option key={mode} value={mode}>{mode}</option>
                      ))}
                    </select>
                  </label>
                  <button className="selector-chip selector-button" onClick={props.onNewThread}>
                    <span>New chat</span>
                  </button>
                  <button className="selector-chip selector-button workspace-button" onClick={() => props.onShowInspector('file')}>
                    <span>{workspaceLabel}</span>
                  </button>
                  <button className="selector-chip selector-button" onClick={props.onPickAttachments} aria-label="Attach screenshot">
                    <span>+</span>
                  </button>
                </div>

                <textarea
                  id="chatInput"
                  data-chat-input="true"
                  value={props.composerText}
                  onChange={(event) => props.onComposerChange(event.target.value)}
                  onFocus={() => props.onChatFocusChange(true)}
                  onBlur={() => props.onChatFocusChange(false)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      props.onSendChat();
                    }
                  }}
                  placeholder="Ask anything"
                />

                <div className="composer-footer launch-footer">
                  <div className="chat-activity-strip">
                    <span>{modeSummaryLabel}</span>
                    <span>{modeRouteSummary[chatMode]}</span>
                    <span>{branchLabel}</span>
                    <span>{safetyLabel}</span>
                  </div>
                  <div className="launch-send-row">
                    <span className="composer-model-tag">{modelLabel}</span>
                    <button className="primary send-icon-button" id="chatSend" data-chat-send="true" onClick={props.onSendChat} disabled={props.busyChat}>
                      {props.busyChat ? 'Working…' : 'Send'}
                    </button>
                  </div>
                </div>

                <div className="launch-action-row">
                  {launcherActions.map((action) => (
                    <button key={action.label} className="ghost launch-action-pill" onClick={action.onClick}>{action.label}</button>
                  ))}
                </div>

                {isFreshThread ? (
                  <div className="prompt-grid compact launch-prompts">
                    {promptCards.map((card) => (
                      <button key={card} className="prompt-card compact" onClick={() => props.onQuickChat(card)}>
                        {card}
                      </button>
                    ))}
                  </div>
                ) : null}

                <div className="composer-toolbar compact">
                  <div className="chip-row quick-command-row">
                    {composerSuggestions.map((command) => (
                      <button key={command} className="ghost" onClick={() => props.onQuickChat(command)}>{command}</button>
                    ))}
                  </div>
                </div>

                {managerPanelOpen ? (
                  <section className="manager-drawer compact">
                    <div>
                      <div className="eyebrow">Manager</div>
                      <strong>Use auto manager</strong>
                      <p>Talk to the engine like a teammate and only open the heavier control surface when you need it.</p>
                    </div>
                    <div className="composer-selector-row">
                      <label className="selector-chip">
                        <span>Manager</span>
                        <select defaultValue="auto" aria-label="Manager mode">
                          <option value="auto">auto</option>
                          <option value="guided">guided</option>
                        </select>
                      </label>
                      <label className="selector-chip">
                        <span>Worker</span>
                        <select defaultValue="workspace" aria-label="Worker routing">
                          <option value="workspace">workspace</option>
                          <option value="engine">engine</option>
                        </select>
                      </label>
                      <label className="selector-chip">
                        <span>Mode</span>
                        <select value={effectiveChatMode} onChange={(event) => void props.onUpdateSetting("chatMode", event.target.value)} aria-label="Effective mode">
                          {chatModes.map((mode) => (
                            <option key={`drawer-${mode}`} value={mode}>{mode}</option>
                          ))}
                        </select>
                      </label>
                      <button className="ghost" onClick={() => props.onQuickChat('/health')}>Run hygiene</button>
                    </div>
                    <div className="chat-compact-strip">
                      <span>Auto-run queued tasks</span>
                      <span>{modeRouteSummary[chatMode]} • {chatTransparencyLevel}</span>
                    </div>
                  </section>
                ) : null}

                {props.pendingAttachments.length > 0 ? (
                  <div className="chip-row attachment-row">
                    {props.pendingAttachments.map((attachment, index) => (
                      <span key={`${attachment.id || attachment.path || index}`} className="attachment-chip">
                        {attachment.originalName || attachment.name || `image ${index + 1}`}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </section>

            <section className="recent-session-card recent-session-panel">
              <div className="panel-header compact">
                <div>
                  <div className="eyebrow">Recent agent sessions</div>
                  <h2>{latestRun?.runtimeLabel || latestTask?.title || 'Latest workspace activity'}</h2>
                </div>
                <button className="ghost" onClick={() => setManagerPanelOpen((current) => !current)}>Manager panel</button>
              </div>
              <div className="recent-session-list">
                {recentSessionItems.map((item) => (
                  <article key={item.id} className={`recent-session-item${item.id === props.activeThreadId ? ' active' : ''}`}>
                    <button className="recent-session-button" onClick={item.onClick} disabled={!item.onClick}>
                      <strong>{item.title}</strong>
                      <span>{item.status}</span>
                      <span>{item.detail}</span>
                      <small>{item.meta || 'Ready'}</small>
                    </button>
                  </article>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </section>
  );
}

function EnginePanel(props: {
  snapshot: JsonMap | null;
  tuning: JsonMap | null;
  benchmarks: JsonMap;
  onRunBenchmark: () => void;
  onRefresh: () => void;
}) {
  const healthCards = Array.isArray(props.snapshot?.manager?.healthCards) ? props.snapshot.manager.healthCards : [];
  const benchmarkRuns = Array.isArray(props.benchmarks?.runs) ? props.benchmarks.runs : [];

  return (
    <section className="module-panel" data-panel="engine">
      <div className="panel-header">
        <div>
          <div className="eyebrow">Models + execution engine</div>
          <h2>Chat is routed through the current coding model</h2>
          <p>{props.snapshot?.settings?.model || 'Local model'} • {props.snapshot?.settings?.runtime || 'runtime'} • {props.tuning?.telemetry?.ollama?.running ? 'Ollama ready' : 'Ollama idle'}</p>
        </div>
        <div className="row-actions">
          <button className="ghost" onClick={() => void window.gosAgent.startOllama({ workspaceRoot: props.snapshot?.workspaceRoot }).then(props.onRefresh)}>Start Ollama</button>
          <button className="ghost" onClick={() => void window.gosAgent.stopOllama().then(props.onRefresh)}>Stop Ollama</button>
          <button className="ghost" data-run-benchmark="true" onClick={props.onRunBenchmark}>Run benchmark</button>
          <button className="primary" onClick={props.onRefresh}>Refresh</button>
        </div>
      </div>

      <div className="card-grid">
        {healthCards.map((card: JsonMap) => (
          <article key={card.id} className="metric-card">
            <div className="eyebrow">{card.label}</div>
            <strong>{card.value}</strong>
            <p>{summarizeText(card.detail)}</p>
          </article>
        ))}
      </div>

      <section className="queue-card">
        <div className="eyebrow">Benchmarks</div>
        {benchmarkRuns.slice(0, 8).map((run: JsonMap) => (
          <div key={run.id || run.outputPath} className="run-item">
            <strong>{run.name}</strong>
            <span>{run.status} • {run.model || 'model'} • {formatStamp(run.completedAt)}</span>
          </div>
        ))}
        {benchmarkRuns.length === 0 ? <p className="empty-copy">No benchmark runs recorded yet.</p> : null}
      </section>
    </section>
  );
}

function LabsPanel(props: {
  snapshot: JsonMap | null;
  labs: JsonMap;
  onSelectLab: (labRoot: string) => void;
  onRefresh: () => void;
}) {
  const labs = Array.isArray(props.labs?.labs) ? props.labs.labs : [];

  return (
    <section className="module-panel" data-panel="labs">
      <div className="panel-header">
        <div>
          <div className="eyebrow">Managed clone labs</div>
          <h2>Self-host, break, reset, and benchmark safely</h2>
          <p>Every lab stays off the app repo and can become the live chat target without touching the real workspace.</p>
        </div>
      </div>

      <div className="card-grid">
        {labs.map((lab: JsonMap) => (
          <article key={lab.labRoot} className="metric-card">
            <div className="eyebrow">{lab.kind}</div>
            <strong>{lab.name}</strong>
            <p>{lab.recipe || 'custom'} • {shortPath(lab.labRoot)}</p>
            <div className="row-actions">
              <button className="ghost" onClick={() => props.onSelectLab(String(lab.labRoot || ''))}>Target this lab</button>
              <button className="ghost" onClick={() => void window.gosAgent.runLabRecipe({ workspaceRoot: props.snapshot?.workspaceRoot, recipe: 'benchmark-self-host', sourceRoot: lab.labRoot, kind: 'scratch' }).then(props.onRefresh)}>Benchmark clone</button>
              <button className="ghost" onClick={() => void window.gosAgent.runLabRecipe({ workspaceRoot: props.snapshot?.workspaceRoot, labRoot: lab.labRoot, recipe: 'break-node-test' }).then(props.onRefresh)}>Break test</button>
              <button className="ghost" onClick={() => void window.gosAgent.resetLab({ workspaceRoot: props.snapshot?.workspaceRoot, labRoot: lab.labRoot }).then(props.onRefresh)}>Reset</button>
              <button className="ghost danger" onClick={() => void window.gosAgent.destroyLab({ workspaceRoot: props.snapshot?.workspaceRoot, labRoot: lab.labRoot }).then(props.onRefresh)}>Destroy</button>
            </div>
          </article>
        ))}
      </div>

      {labs.length === 0 ? <p className="empty-copy">No labs exist yet. Create one from the left rail and test the engine there first.</p> : null}
    </section>
  );
}

function LearningPanel(props: {
  snapshot: JsonMap | null;
  learningStatus: JsonMap;
  learningChanges: JsonMap;
  onCaptureLearning: () => void;
  onExport: () => void;
}) {
  const entries = Array.isArray(props.learningChanges?.entries) ? props.learningChanges.entries : [];
  const styleProfile = props.learningStatus?.styleProfile || {};
  const reusablePrompts = Array.isArray(props.learningStatus?.reusablePrompts) ? props.learningStatus.reusablePrompts : [];
  const recommendedCommands = Array.isArray(styleProfile?.recommendedCommands) ? styleProfile.recommendedCommands : [];
  const preferredVerbs = Array.isArray(styleProfile?.preferredVerbs) ? styleProfile.preferredVerbs : [];
  const commonTargets = Array.isArray(styleProfile?.commonTargets) ? styleProfile.commonTargets : [];
  const operatorSupervision = props.learningStatus?.operatorSupervision || {};
  const supervisionSignals = Array.isArray(operatorSupervision?.signals) ? operatorSupervision.signals : [];
  const trainingReadiness = props.learningStatus?.trainingReadiness || {};

  return (
    <section className="module-panel" data-panel="learning">
      <div className="panel-header">
        <div>
          <div className="eyebrow">Change journal</div>
          <h2>Auto-learn without cooking the laptop</h2>
          <p>{props.learningStatus?.recentSummary?.summary || 'Change journal is waiting for tracked edits and approvals.'}</p>
        </div>
        <div className="row-actions">
          <button className="ghost" onClick={props.onCaptureLearning}>Capture learning record</button>
          <button className="primary" onClick={props.onExport}>Export journal</button>
        </div>
      </div>

      <div className="card-grid">
        <article className="metric-card">
          <div className="eyebrow">Target root</div>
          <strong>{shortPath(props.learningStatus?.targetRoot) || 'none'}</strong>
          <p>{props.learningStatus?.journalPath ? shortPath(props.learningStatus.journalPath) : 'Journal root not configured yet.'}</p>
        </article>
        <article className="metric-card">
          <div className="eyebrow">Pending train candidates</div>
          <strong>{Number(props.learningStatus?.pendingTrainingCandidates || 0)}</strong>
          <p>Idle-safe learn/train runs trigger only when the machine is cool, quiet, and not actively running work.</p>
        </article>
        <article className="metric-card">
          <div className="eyebrow">Naming profile</div>
          <strong>{preferredVerbs.length > 0 ? preferredVerbs.map((item: JsonMap) => String(item?.verb || '')).filter(Boolean).join(' • ') : 'warming up'}</strong>
          <p>{String(styleProfile?.summary || 'Waiting for more approved or trusted sessions before shaping naming and command preferences.')}</p>
        </article>
        <article className="metric-card">
          <div className="eyebrow">Training readiness</div>
          <strong>{String(trainingReadiness?.status || 'idle')}</strong>
          <p>{String(trainingReadiness?.summary || 'Training is idle until trusted edits create new candidates.')}</p>
        </article>
        <article className="metric-card">
          <div className="eyebrow">Operator supervision</div>
          <strong>{Number(operatorSupervision?.count || 0)}</strong>
          <p>{String(operatorSupervision?.summary || 'No operator supervision has been recorded yet.')}</p>
        </article>
      </div>

      <section className="queue-card">
        <div className="eyebrow">Reusable prompt patterns</div>
        {reusablePrompts.length > 0 ? (
          <>
            <div className="chip-row">
              {reusablePrompts.map((item: JsonMap, index: number) => (
                <span key={`${item.prompt || index}`} className="attachment-chip">
                  {String(item.prompt || '').trim()}
                </span>
              ))}
            </div>
            <p className="empty-copy">Trusted prompt patterns graduate here so future tasks and recipes stay cleaner and easier to reuse.</p>
          </>
        ) : (
          <p className="empty-copy">No trusted reusable prompts yet. Approved runs and accepted edits will seed them here.</p>
        )}
      </section>

      <section className="queue-card">
        <div className="eyebrow">Reusable command patterns</div>
        {recommendedCommands.length > 0 ? (
          <>
            <div className="chip-row">
              {recommendedCommands.map((item: JsonMap, index: number) => (
                <span key={`${item.command || item.prompt || index}`} className="attachment-chip">
                  {String(item.command || item.prompt || '').trim()}
                </span>
              ))}
            </div>
            <p className="empty-copy">These are the lean commands and prompts the engine should start favoring as your trusted patterns get stronger.</p>
          </>
        ) : (
          <p className="empty-copy">No reusable command patterns yet. Trusted prompts and operator supervision will condense into shortcuts here.</p>
        )}
      </section>

      <div className="card-grid">
        <article className="metric-card">
          <div className="eyebrow">Common targets</div>
          <strong>{commonTargets.length > 0 ? commonTargets.map((item: JsonMap) => String(item?.label || '')).filter(Boolean).join(' • ') : 'none yet'}</strong>
          <p>These are the screens, features, or change areas showing up most often in trusted learning sessions.</p>
        </article>
        <article className="metric-card">
          <div className="eyebrow">Trusted sessions</div>
          <strong>{Number(styleProfile?.trustedSessionCount || 0)}</strong>
          <p>{String(styleProfile?.confidence || 'low')} confidence across {Number(styleProfile?.sampleCount || 0)} recent learning events.</p>
        </article>
      </div>

      <section className="queue-card">
        <div className="eyebrow">Operator supervision signals</div>
        {supervisionSignals.length > 0 ? (
          <>
            {supervisionSignals.map((signal: JsonMap, index: number) => (
              <div key={`${signal.note || index}-${signal.verdict || 'comment'}`} className="run-item">
                <strong>{String(signal.verdict || 'comment')}</strong>
                <span>{summarizeText(signal.note || '', 180)}</span>
              </div>
            ))}
            <p className="empty-copy">These signals come from approvals, needs-changes notes, and operator comments. Chat guidance can reuse them without flooding the UI.</p>
          </>
        ) : (
          <p className="empty-copy">No operator supervision signals yet. Record approvals, needs changes, or comments from Monitor to start shaping the engine.</p>
        )}
      </section>

      <section className="queue-card">
        <div className="eyebrow">Recent change events</div>
        {entries.slice(-20).reverse().map((entry: JsonMap, index: number) => (
          <div key={`${entry.recordedAt || index}-${entry.type || 'event'}`} className="run-item">
            <strong>{entry.type}</strong>
            <span>{formatStamp(entry.recordedAt)} • {summarizeText(entry.payload?.summary || entry.payload?.path || entry.payload?.message || '')}</span>
          </div>
        ))}
        {entries.length === 0 ? <p className="empty-copy">No learning journal entries yet.</p> : null}
      </section>
    </section>
  );
}

function SettingsPanel(props: {
  snapshot: JsonMap | null;
  settings: JsonMap;
  activeTab: SettingsTabId;
  aiStatus: JsonMap | null;
  goalList: JsonMap[];
  taskList: JsonMap[];
  taskRuns: JsonMap[];
  skills: JsonMap[];
  tools: JsonMap[];
  automations: JsonMap[];
  tuning: JsonMap | null;
  labs: JsonMap;
  benchmarks: JsonMap;
  learningStatus: JsonMap;
  learningChanges: JsonMap;
  onPickWorkspace: () => void;
  onSetActiveTab: (tab: SettingsTabId) => void;
  onUpdateSetting: (field: string, value: any) => void;
  onSelectLab: (labRoot: string) => void;
  onClearLab: () => void;
  onCaptureLearning: () => void;
  onRunBenchmark: () => void;
  onRefresh: () => void;
  onCreateLab: (recipe: string) => void;
  onExportLearning: () => void;
}) {
  const settings = props.settings || props.snapshot?.settings || {};
  const groupedWorkspace = settings.workspace || {};
  const groupedStorage = settings.storage || {};
  const groupedAutonomy = settings.autonomy || {};
  const groupedAutomations = settings.automations || {};
  const resourcePolicy = props.aiStatus?.resourcePolicy || {};
  const aiTelemetry = props.aiStatus?.telemetry || {};
  const aiProfiles = Array.isArray(props.aiStatus?.profiles) ? props.aiStatus.profiles : [];
  const aiProviders = Array.isArray(props.aiStatus?.providers) ? props.aiStatus.providers : [];
  const aiRemoteProviders = Array.isArray(props.aiStatus?.remoteProviders) ? props.aiStatus.remoteProviders : [];
  const aiBridgeProfiles = Array.isArray(props.aiStatus?.bridgeProfiles) ? props.aiStatus.bridgeProfiles : [];
  const aiRoutingPolicies = Array.isArray(props.aiStatus?.routingPolicies) ? props.aiStatus.routingPolicies : [];
  const capabilityLanes = Array.isArray(props.aiStatus?.capabilityLanes) ? props.aiStatus.capabilityLanes : [];
  const aiModelOptions = readAiModelOptions(props.aiStatus, props.tuning, settings);
  const aiRemoteModelOptions = Array.isArray(props.aiStatus?.remoteModelCatalog) ? props.aiStatus.remoteModelCatalog : [];
  const aiLaneOverrides = normalizeLaneOverrides(settings.aiLaneOverrides || props.aiStatus?.current?.laneOverrides || {});
  const vscodeSetup = props.snapshot?.vscodeSetup || {};
  const extensionHealth = props.snapshot?.extensionHealth || {};
  const modelFoundry = props.snapshot?.modelFoundry || {};
  const integrations = props.snapshot?.integrations || {};
  const integrationLibrary = Array.isArray(integrations?.library) ? integrations.library : [];
  const installedIntegrations = Array.isArray(integrations?.installed) ? integrations.installed : [];
  const appRollbacks = props.snapshot?.appRollbacks || {};
  const archivedAppBackups = Array.isArray(appRollbacks?.backups) ? appRollbacks.backups : [];
  const benchmarkLeader = props.aiStatus?.benchmarkSummary?.[0] || null;
  const activeLaneOverrideCount = Object.keys(aiLaneOverrides).length;
  const aiManualMode = settings.aiManualMode === true || props.aiStatus?.current?.manualMode === true;
  const aiBridgeProfile = String(settings.aiBridgeProfile || props.aiStatus?.current?.bridgeProfile || 'llama-bridge');
  const derivedModelLabel = String(props.aiStatus?.current?.derivedModelLabel || settings.model || settings.trainingOllamaModel || 'qwen2.5-coder:7b');
  const currentProvider = String(props.aiStatus?.current?.provider || settings.runtime || 'ollama');
  const selectedRuntime = String(settings.runtime || 'ollama');
  const selectedRemoteProviderId = String(settings.aiRemoteProvider || props.aiStatus?.current?.remoteProvider || 'openai');
  const selectedRemoteProvider = aiRemoteProviders.find((provider: JsonMap) => String(provider?.id || '') === selectedRemoteProviderId)
    || aiRemoteProviders[0]
    || null;
  const selectedRemoteModel = String(settings.aiRemoteModel || props.aiStatus?.current?.remoteModel || aiRemoteModelOptions[0]?.model || '');
  const targetHardwareOptions = Array.isArray(props.tuning?.hardwareTargets) ? props.tuning.hardwareTargets : [];
  const selectedHardwareTarget = String(settings.trainingHardwareTarget || props.tuning?.settings?.trainingHardwareTarget || 'auto');
  const installPresets = Array.isArray(props.tuning?.installPresets) ? props.tuning.installPresets : [];
  const recommendedInstallPresets = installPresets.filter((item: JsonMap) => item.hardwareRecommended);
  const [providerKeyBusy, setProviderKeyBusy] = React.useState(false);
  const visibleBridgeProfiles = (aiBridgeProfiles.length ? aiBridgeProfiles : [{ id: 'llama-bridge', label: 'Llama Bridge' }, { id: 'gpt4all-bridge', label: 'GPT4All Bridge' }, { id: 'custom', label: 'Custom' }])
    .filter((profile: JsonMap) => aiManualMode || String(profile?.id || '') !== 'custom');
  const selectedBridgeProfile = visibleBridgeProfiles.find((profile: JsonMap) => String(profile?.id || '') === aiBridgeProfile)
    || visibleBridgeProfiles[0]
    || null;
  const nextFoundryCandidate = modelFoundry?.nextCandidate
    || (Array.isArray(modelFoundry?.suggested) ? modelFoundry.suggested[0] : null)
    || null;
  const savedFoundryCandidates = Array.isArray(modelFoundry?.candidates) ? modelFoundry.candidates : [];
  const suggestedFoundryCandidates = Array.isArray(modelFoundry?.suggested) ? modelFoundry.suggested : [];
  const trainingFallback = props.aiStatus?.telemetry?.trustSummary?.fallbackPlan || props.tuning?.telemetry?.trustSummary?.fallbackPlan || null;
  const integrationKinds = ['plugin', 'adapter', 'extension'];
  const resolvedBridgeCommand = aiManualMode
    ? String(settings.localAiCmdManual || settings.localAiCmd || '').trim()
    : String(selectedBridgeProfile?.command || props.aiStatus?.current?.localAiCmd || '').trim();
  const readyModelCount = aiModelOptions.filter((option) => option.ready).length;
  const storedModelCount = Array.isArray(props.tuning?.telemetry?.models?.discovered) ? props.tuning.telemetry.models.discovered.length : 0;
  const registeredModelCount = Array.isArray(props.tuning?.telemetry?.models?.registered) ? props.tuning.telemetry.models.registered.length : 0;
  const modelStorageRoot = String(props.tuning?.telemetry?.models?.storageRoot || settings.trainingModelStorageRoot || '').trim();
  const catalogProviderCount = new Set(aiModelOptions.map((option) => option.provider)).size;
  const safetyLevels = Array.isArray(groupedAutonomy.safetyLevels)
    ? groupedAutonomy.safetyLevels
    : [
        { id: 'locked', label: 'Locked', summary: 'Read and monitor only.' },
        { id: 'guarded', label: 'Guarded', summary: 'Planning plus bounded lab work.' },
        { id: 'supervised-auto', label: 'Supervised Auto', summary: 'Balanced default.' },
        { id: 'builder', label: 'Builder', summary: 'Wider coding loops.' },
        { id: 'lab-full-auto', label: 'Lab Full Auto', summary: 'Aggressive lab-only automation.' },
        { id: 'custom', label: 'Custom', summary: 'Manual safety shaping.' },
      ];
  const selectedSafetyLevel = String(groupedAutonomy.safetyLevel || 'supervised-auto');
  const activeSafetyLevel = safetyLevels.find((item: JsonMap) => String(item?.id || '') === selectedSafetyLevel) || safetyLevels[0] || null;
  const providerSecretName = String(selectedRemoteProvider?.secretName || props.aiStatus?.current?.remoteApiKeyName || 'OPENAI_API_KEY').trim() || 'OPENAI_API_KEY';
  const [providerKeyValue, setProviderKeyValue] = React.useState('');

  const saveSelectedRemoteKey = async () => {
    if (!selectedRemoteProvider) {
      return;
    }
    const nextValue = String(providerKeyValue || '').trim();
    if (!nextValue) {
      return;
    }
    setProviderKeyBusy(true);
    try {
      await window.gosAgent.setSecret(providerSecretName, nextValue);
      setProviderKeyValue('');
      props.onRefresh();
    } finally {
      setProviderKeyBusy(false);
    }
  };

  const clearSelectedRemoteKey = async () => {
    if (!selectedRemoteProvider) {
      return;
    }
    setProviderKeyBusy(true);
    try {
      await window.gosAgent.setSecret(providerSecretName, '');
      setProviderKeyValue('');
      props.onRefresh();
    } finally {
      setProviderKeyBusy(false);
    }
  };

  return (
    <section className="module-panel settings-panel-v2" data-panel="settings">
      <div className="panel-header">
        <div>
          <div className="eyebrow">Unified settings center</div>
          <h2>Keep chat clean and move the system controls here</h2>
          <p>AI, autonomy, workspace targeting, tools, labs, learning, and diagnostics all live behind one modular settings surface.</p>
        </div>
        <div className="row-actions">
          <button className="ghost" onClick={props.onRefresh}>Refresh</button>
          <button className="primary" onClick={props.onPickWorkspace}>Pick workspace</button>
        </div>
      </div>

      <div className="settings-tabs" data-settings-tabs="true">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab}
            className={props.activeTab === tab ? 'active' : ''}
            data-settings-tab={tab}
            onClick={() => props.onSetActiveTab(tab)}
          >
            {tab === 'ai' ? 'AI' : tab === 'labs' ? 'Labs' : tab === 'tools' ? 'Tools' : tab === 'extensions' ? 'Extensions' : tab === 'storage' ? 'Storage & Diagnostics' : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {props.activeTab === 'general' ? (
        <section className="settings-section">
          <div className="settings-grid">
            <label>
              <span>Chat mode</span>
              <select value={String(settings.chatMode || 'auto')} onChange={(event) => void props.onUpdateSetting("chatMode", event.target.value)}>
                {['auto', 'ask', 'plan', 'edit', 'agent'].map((mode) => (
                  <option key={mode} value={mode}>{mode}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Theme</span>
              <select value={['codex', 'obsidian'].includes(settings.theme || '') ? settings.theme : 'codex'} onChange={(event) => void props.onUpdateSetting('theme', event.target.value)}>
                {['codex', 'obsidian'].map((theme) => (
                  <option key={theme} value={theme}>{theme}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Inspector mode</span>
              <select value={settings.chatUtilityMode || 'context'} onChange={(event) => void props.onUpdateSetting('chatUtilityMode', event.target.value)}>
                {['context', 'diff', 'review'].map((mode) => (
                  <option key={mode} value={mode}>{mode}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Chat instruction mode</span>
              <select
                value={['off', 'auto', 'custom'].includes(String(settings.chatInstructionMode || '').toLowerCase()) ? String(settings.chatInstructionMode || '').toLowerCase() : 'auto'}
                onChange={(event) => void props.onUpdateSetting('chatInstructionMode', event.target.value)}
              >
                <option value="off">Off</option>
                <option value="auto">Auto</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            <label>
              <span>Chat inspector width</span>
              <input
                type="number"
                min={320}
                max={620}
                value={String(settings.chatInspectorWidth || 380)}
                onChange={(event) => void props.onUpdateSetting('chatInspectorWidth', Number(event.target.value || 380))}
              />
            </label>
            <label>
              <span>Composer height</span>
              <select
                value={String(settings.chatComposerHeight || 'comfortable')}
                onChange={(event) => void props.onUpdateSetting('chatComposerHeight', event.target.value)}
              >
                {['compact', 'comfortable', 'tall'].map((height) => (
                  <option key={height} value={height}>{height}</option>
                ))}
              </select>
            </label>
          </div>
          {String(settings.chatInstructionMode || 'auto').toLowerCase() === 'custom' ? (
            <label className="stacked-input">
              <span>Custom chat instructions</span>
              <textarea
                value={String(settings.chatCustomInstructions || '')}
                onChange={(event) => void props.onUpdateSetting('chatCustomInstructions', event.target.value)}
                placeholder="Example: Prefer reusable file edits, explain risky changes briefly, and keep UI changes screen-by-screen."
              />
            </label>
          ) : null}
          <div className="card-grid">
            <article className="metric-card">
              <div className="eyebrow">Workspace target</div>
              <strong>{shortPath(groupedWorkspace.currentTargetRoot) || 'No target selected'}</strong>
              <p>{groupedWorkspace.selectedLabRoot ? `Lab: ${shortPath(groupedWorkspace.selectedLabRoot)}` : 'The real workspace is active.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Chat startup</div>
              <strong>{settings.startInChatWorkspace === false ? 'Custom' : 'Chat first'}</strong>
              <p>The app opens directly into the chat canvas so the workbench stays simple by default.</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Learned chat guidance</div>
              <strong>{props.learningStatus?.styleProfile?.summary ? 'Active' : 'Warming up'}</strong>
              <p>{String(props.learningStatus?.styleProfile?.summary || 'Approved sessions will shape naming, prompt suggestions, and reusable guidance here.')}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Reusable prompts</div>
              <strong>{Number(props.learningStatus?.reusablePrompts?.length || 0)}</strong>
              <p>{Number(props.learningStatus?.reusablePrompts?.length || 0) > 0 ? 'Chat suggestions can pull from trusted prompt patterns as you work.' : 'Trusted prompt patterns will show up here after accepted runs.'}</p>
            </article>
          </div>
        </section>
      ) : null}

      {props.activeTab === 'workspace' ? (
        <section className="settings-section">
          <div className="card-grid">
            <article className="metric-card">
              <div className="eyebrow">Current workspace</div>
              <strong>{shortPath(groupedWorkspace.currentRoot) || 'Not selected'}</strong>
              <p>{groupedWorkspace.hasWorkspace ? 'The workspace is explicit and separate from the app repo.' : 'Pick a workspace to start routing chat tasks.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Current target</div>
              <strong>{shortPath(groupedWorkspace.currentTargetRoot) || 'None'}</strong>
              <p>{groupedWorkspace.selectedLabRoot ? 'A lab is currently active.' : 'Runs will target the real workspace unless you select a lab.'}</p>
            </article>
          </div>
          <div className="row-actions">
            <button className="primary" onClick={props.onPickWorkspace}>Switch workspace</button>
            {vscodeSetup?.ok ? (
              <button
                className="ghost"
                onClick={() => void window.gosAgent.bootstrapWorkspaceVsCode({
                  workspaceRoot: props.snapshot?.workspaceRoot,
                  targetWorkspaceRoot: props.snapshot?.targetWorkspaceRoot,
                }).then(props.onRefresh)}
              >
                Bootstrap VS Code
              </button>
            ) : null}
            {groupedWorkspace.selectedLabRoot ? <button className="ghost" onClick={props.onClearLab}>Leave active lab</button> : null}
          </div>
          <div className="card-grid">
            <article className="metric-card">
              <div className="eyebrow">VS Code workspace</div>
              <strong>{vscodeSetup?.ok ? ((Number(vscodeSetup?.missingFiles?.length || 0) + Number(vscodeSetup?.missingRecommendations?.length || 0) + Number(vscodeSetup?.missingTaskLabels?.length || 0)) > 0 ? 'Needs bootstrap' : 'Ready') : 'Unavailable'}</strong>
              <p>{String(vscodeSetup?.summary || 'Bootstrap workspace settings, tasks, and recommended extensions from here.')}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">VS Code recommendations</div>
              <strong>{Number(vscodeSetup?.recommendations?.length || 0)}</strong>
              <p>{Number(vscodeSetup?.missingRecommendations?.length || 0)} missing recommendation(s) • {Number(vscodeSetup?.missingTaskLabels?.length || 0)} missing task(s)</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Extension health</div>
              <strong>{extensionHealth?.exists ? (extensionHealth?.status === 'ready' ? 'Ready' : 'Needs attention') : 'Not detected'}</strong>
              <p>{String(extensionHealth?.summary || 'Check the VS Code extension path here so the desktop app and editor flow do not drift.')}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Goals</div>
              <strong>{props.goalList.length}</strong>
              <p>{props.goalList[0]?.title || 'Chat will create the first goal when you ask for real work.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Tasks</div>
              <strong>{props.taskList.length}</strong>
              <p>{props.taskList[0] ? `${props.taskList[0].status || 'ready'} • ${props.taskList[0].title}` : 'Scoped tasks stay attached to the current workspace or lab.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Runs</div>
              <strong>{props.taskRuns.length}</strong>
              <p>{props.taskRuns[0] ? `${props.taskRuns[0].runtimeState || props.taskRuns[0].status || 'idle'} • ${props.taskRuns[0].runtimeLabel || props.taskRuns[0].label || 'Latest run'}` : 'Runs appear here after the first actionable prompt or recipe.'}</p>
            </article>
          </div>
          <section className="queue-card">
            <div className="eyebrow">VS Code setup</div>
            {Number(vscodeSetup?.missingFiles?.length || 0) > 0 ? (
              <div className="run-item">
                <strong>Missing files</strong>
                <span>{(Array.isArray(vscodeSetup.missingFiles) ? vscodeSetup.missingFiles : []).join(', ')}</span>
              </div>
            ) : null}
            {Number(vscodeSetup?.missingRecommendations?.length || 0) > 0 ? (
              <div className="run-item">
                <strong>Missing extension recommendations</strong>
                <span>{(Array.isArray(vscodeSetup.missingRecommendations) ? vscodeSetup.missingRecommendations.slice(0, 5) : []).join(', ')}{Number(vscodeSetup?.missingRecommendations?.length || 0) > 5 ? '…' : ''}</span>
              </div>
            ) : null}
            {Number(vscodeSetup?.missingTaskLabels?.length || 0) > 0 ? (
              <div className="run-item">
                <strong>Missing VS Code tasks</strong>
                <span>{(Array.isArray(vscodeSetup.missingTaskLabels) ? vscodeSetup.missingTaskLabels : []).join(', ')}</span>
              </div>
            ) : null}
            {Number(vscodeSetup?.missingFiles?.length || 0) === 0 && Number(vscodeSetup?.missingRecommendations?.length || 0) === 0 && Number(vscodeSetup?.missingTaskLabels?.length || 0) === 0 ? (
              <p className="empty-copy">VS Code workspace files are already ready for this target.</p>
            ) : null}
          </section>
          <section className="queue-card">
            <div className="eyebrow">Extension alignment</div>
            {Array.isArray(extensionHealth?.warnings) && extensionHealth.warnings.length > 0 ? (
              extensionHealth.warnings.map((warning: string, index: number) => (
                <div key={`${warning}-${index}`} className="run-item">
                  <strong>{extensionHealth.displayName || 'VS Code extension'}</strong>
                  <span>{warning}</span>
                </div>
              ))
            ) : extensionHealth?.exists ? (
              <div className="run-item">
                <strong>{extensionHealth.displayName || 'VS Code extension'}</strong>
                <span>{String(extensionHealth.nextStep || extensionHealth.summary || 'Extension health looks good.')}</span>
              </div>
            ) : (
              <p className="empty-copy">No VS Code extension path was detected for this workspace.</p>
            )}
          </section>
          <section className="queue-card">
            <div className="eyebrow">Companion install</div>
            <div className="run-item">
              <strong>{extensionHealth?.exists ? 'Companion detected' : 'Install companion'}</strong>
              <span>{String(extensionHealth?.nextStep || extensionHealth?.summary || 'Install the VS Code companion so the desktop app and editor stay aligned.')}</span>
            </div>
            <div className="row-actions">
              <button
                className="ghost"
                onClick={() => void window.gosAgent.bootstrapWorkspaceVsCode({
                  workspaceRoot: props.snapshot?.workspaceRoot,
                  targetWorkspaceRoot: props.snapshot?.targetWorkspaceRoot,
                }).then(props.onRefresh)}
              >
                Install companion
              </button>
            </div>
          </section>
          <section className="queue-card">
            <div className="eyebrow">Work graph</div>
            {props.goalList.slice(0, 2).map((goal: JsonMap) => (
              <div key={String(goal.id || goal.title)} className="run-item">
                <strong>{goal.title || 'Goal'}</strong>
                <span>{goal.status || 'active'} • {shortPath(goal.labRoot || goal.targetWorkspaceRoot || goal.workspaceRoot || '') || 'target pending'}</span>
              </div>
            ))}
            {props.taskList.slice(0, 3).map((task: JsonMap) => (
              <div key={String(task.id || task.title)} className="run-item">
                <strong>{task.title || 'Task'}</strong>
                <span>{task.status || 'ready'} • {task.riskClass || 'medium'} risk • {(Array.isArray(task.capabilities) ? task.capabilities.slice(0, 2).join(', ') : 'chat-fast') || 'chat-fast'}</span>
              </div>
            ))}
            {props.taskRuns.slice(0, 3).map((run: JsonMap) => (
              <div key={String(run.runId || run.id || run.label)} className="run-item">
                <strong>{run.runtimeLabel || run.label || 'Run'}</strong>
                <span>{run.runtimeState || run.status || 'idle'}{run.blockedReason ? ` • ${summarizeText(run.blockedReason, 100)}` : ''}</span>
              </div>
            ))}
            {props.goalList.length === 0 && props.taskList.length === 0 && props.taskRuns.length === 0 ? <p className="empty-copy">No goals, tasks, or runs are recorded yet.</p> : null}
          </section>
        </section>
      ) : null}

      {props.activeTab === 'ai' ? (
        <section className="settings-section">
          <div className="card-grid">
            <article className="metric-card">
              <div className="eyebrow">Routing profile</div>
              <strong>{props.aiStatus?.profileId || settings.aiProfile || 'hybrid-default'}</strong>
              <p>{aiProfiles.find((profile: JsonMap) => profile.active)?.summary || 'Use the profile cards below to swap routing behavior quickly.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Active provider</div>
              <strong>{currentProvider}</strong>
              <p>{selectedRuntime} runtime • {aiManualMode ? 'custom mode' : 'selector mode'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Remote provider</div>
              <strong>{selectedRemoteProvider?.label || 'OpenAI'}</strong>
              <p>{selectedRemoteProvider?.available ? 'API key configured' : 'API key missing'} • {String(selectedRemoteProvider?.baseUrl || props.aiStatus?.current?.remoteBaseUrl || 'compatible endpoint')}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Benchmark leader</div>
              <strong>{benchmarkLeader?.model || settings.trainingOllamaModel || settings.model || 'No benchmark yet'}</strong>
              <p>{benchmarkLeader ? `${benchmarkLeader.passRate || 0}% pass • ${benchmarkLeader.averageLatencyMs || 0}ms avg latency` : 'Run a benchmark to seed smarter lane routing.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Lane overrides</div>
              <strong>{activeLaneOverrideCount}</strong>
              <p>{activeLaneOverrideCount > 0 ? 'Manual lane overrides are active.' : 'All lanes currently inherit the profile and routing policy.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Selector catalog</div>
              <strong>{readyModelCount} ready • {catalogProviderCount} provider{catalogProviderCount === 1 ? '' : 's'}</strong>
              <p>{aiManualMode ? 'Custom mode is enabled, but the selector catalog is still available for comparison.' : 'Use selectors first. Manual text fields stay hidden until you switch to Custom.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Model storage</div>
              <strong>{storedModelCount} stored / {registeredModelCount} registered</strong>
              <p>{modelStorageRoot || 'No shared model folder is configured yet.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Target hardware</div>
              <strong>{targetHardwareOptions.find((item: JsonMap) => String(item?.id || '') === selectedHardwareTarget)?.label || 'Current machine'}</strong>
              <p>{String(targetHardwareOptions.find((item: JsonMap) => String(item?.id || '') === selectedHardwareTarget)?.summary || 'Use the current machine profile unless you are preparing a Windows or workstation target.')}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Model Foundry</div>
              <strong>{Number(modelFoundry?.candidateCount || 0)} candidate{Number(modelFoundry?.candidateCount || 0) === 1 ? '' : 's'}</strong>
              <p>{String(modelFoundry?.summary || 'Capture benchmark-backed route bundles and prompt distillation candidates here.')}</p>
            </article>
          </div>
          <div className="settings-grid">
            <label>
              <span>Configuration mode</span>
              <select value={aiManualMode ? 'custom' : 'selector'} onChange={(event) => void props.onUpdateSetting('aiManualMode', event.target.value === 'custom')}>
                <option value="selector">Selector</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            <label>
              <span>Runtime</span>
              <select data-setting="runtime" value={settings.runtime || 'ollama'} onChange={(event) => void props.onUpdateSetting('runtime', event.target.value)}>
                {['ollama', 'local', 'hybrid', 'openai'].map((runtime) => (
                  <option key={runtime} value={runtime}>{runtime}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Remote provider</span>
              <select value={selectedRemoteProviderId} onChange={(event) => void props.onUpdateSetting('aiRemoteProvider', event.target.value)}>
                {(aiRemoteProviders.length ? aiRemoteProviders : [{ id: 'openai', label: 'OpenAI' }]).map((provider: JsonMap) => (
                  <option key={String(provider.id || '')} value={String(provider.id || '')}>{String(provider.label || provider.id || '')}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Remote model</span>
              <select value={selectedRemoteModel} onChange={(event) => void props.onUpdateSetting('aiRemoteModel', event.target.value)}>
                {(aiRemoteModelOptions.length ? aiRemoteModelOptions : [{ model: 'gpt-4o-mini', label: 'GPT-4o Mini' }]).map((option: JsonMap) => (
                  <option key={String(option.model || option.label || '')} value={String(option.model || '')}>{String(option.label || option.model || '')}</option>
                ))}
              </select>
            </label>
            <label>
              <span>AI profile</span>
              <select value={settings.aiProfile || 'hybrid-default'} onChange={(event) => void props.onUpdateSetting('aiProfile', event.target.value)}>
                {(aiProfiles.length ? aiProfiles : [
                  { id: 'local-fast', label: 'Local Fast' },
                  { id: 'balanced-local', label: 'Balanced Local' },
                  { id: 'hybrid-default', label: 'Hybrid Default' },
                  { id: 'best-available', label: 'Best Available' },
                  { id: 'custom', label: 'Custom' },
                ]).map((profile: JsonMap) => (
                  <option key={String(profile.id || '')} value={String(profile.id || '')}>{String(profile.label || profile.id || '')}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Routing policy</span>
              <select data-setting="ai-routing-policy" value={settings.aiRoutingPolicy || settings.aiProfile || 'hybrid-default'} onChange={(event) => void props.onUpdateSetting('aiRoutingPolicy', event.target.value)}>
                {(aiRoutingPolicies.length ? aiRoutingPolicies : ['local-fast', 'balanced-local', 'hybrid-default', 'best-available', 'custom']).map((policy: JsonMap | string) => {
                  const policyId = typeof policy === 'string' ? policy : String(policy.id || '');
                  const policyLabel = typeof policy === 'string' ? policy : String(policy.label || policy.id || '');
                  return <option key={policyId} value={policyId}>{policyLabel}</option>;
                })}
              </select>
            </label>
            <label>
              <span>Bridge profile</span>
              <select value={aiBridgeProfile} onChange={(event) => void props.onUpdateSetting('aiBridgeProfile', event.target.value)}>
                {visibleBridgeProfiles.map((profile: JsonMap) => (
                  <option key={String(profile.id || '')} value={String(profile.id || '')}>{String(profile.label || profile.id || '')}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Target hardware</span>
              <select value={selectedHardwareTarget} onChange={(event) => void props.onUpdateSetting('trainingHardwareTarget', event.target.value)}>
                {(targetHardwareOptions.length ? targetHardwareOptions : [{ id: 'auto', label: 'Current machine' }]).map((target: JsonMap) => (
                  <option key={String(target.id || '')} value={String(target.id || '')}>{String(target.label || target.id || '')}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Primary model</span>
              <select data-setting="trainingOllamaModel" value={String(settings.trainingOllamaModel || 'qwen2.5-coder:7b')} onChange={(event) => void props.onUpdateSetting('trainingOllamaModel', event.target.value)}>
                {aiModelOptions.map((option) => (
                  <option key={`${option.provider}-${option.model}`} value={option.model}>
                    {option.label} • {option.provider}{option.ready ? ' • ready' : option.source === 'recommended' ? ' • recommended' : ' • import needed'}
                  </option>
                ))}
              </select>
            </label>
            {aiManualMode ? (
              <>
                <label>
                  <span>Model label</span>
                  <input data-setting="model" value={settings.model || ''} onChange={(event) => void props.onUpdateSetting('model', event.target.value)} />
                </label>
                <label>
                  <span>Compatible base URL</span>
                  <input value={String(settings.aiRemoteBaseUrl || '')} onChange={(event) => void props.onUpdateSetting('aiRemoteBaseUrl', event.target.value)} placeholder="https://provider.example/v1" />
                </label>
                <label>
                  <span>Remote API key name</span>
                  <input value={String(settings.aiRemoteApiKeyName || '')} onChange={(event) => void props.onUpdateSetting('aiRemoteApiKeyName', event.target.value)} placeholder="OPENAI_COMPAT_API_KEY" />
                </label>
                <label>
                  <span>Provider API key</span>
                  <input
                    type="password"
                    value={providerKeyValue}
                    onChange={(event) => setProviderKeyValue(event.target.value)}
                    placeholder={`Save to ${providerSecretName}`}
                  />
                </label>
                <label>
                  <span>Local AI command</span>
                  <input
                    data-setting="localAiCmd"
                    defaultValue={settings.localAiCmdManual || settings.localAiCmd || ''}
                    placeholder="Optional local bridge command"
                    onBlur={(event) => void props.onUpdateSetting('localAiCmd', event.target.value)}
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  <span>Derived model label</span>
                  <input value={derivedModelLabel} readOnly />
                </label>
                <label>
                  <span>Resolved bridge command</span>
                  <input value={resolvedBridgeCommand || 'No bridge command is needed for this runtime.'} readOnly />
                </label>
                <label>
                  <span>Compatible base URL</span>
                  <input value={String(selectedRemoteProvider?.baseUrl || props.aiStatus?.current?.remoteBaseUrl || 'Use the provider default')} readOnly />
                </label>
                <label>
                  <span>Remote API key slot</span>
                  <input value={String(selectedRemoteProvider?.secretName || props.aiStatus?.current?.remoteApiKeyName || 'OPENAI_API_KEY')} readOnly />
                </label>
                <label>
                  <span>Provider API key</span>
                  <input
                    type="password"
                    value={providerKeyValue}
                    onChange={(event) => setProviderKeyValue(event.target.value)}
                    placeholder={`Save to ${providerSecretName}`}
                  />
                </label>
              </>
            )}
          </div>
          <div className="row-actions">
            <button className="ghost" onClick={() => void window.gosAgent.startOllama({ workspaceRoot: props.snapshot?.workspaceRoot }).then(props.onRefresh)}>Start Ollama</button>
            <button className="ghost" onClick={() => void window.gosAgent.stopOllama().then(props.onRefresh)}>Stop Ollama</button>
            <button className="ghost" onClick={() => void window.gosAgent.importAiModels({ workspaceRoot: props.snapshot?.workspaceRoot, onlySelected: true }).then(props.onRefresh)}>Import selected model</button>
            <button className="ghost" onClick={() => void window.gosAgent.importAiModels({ workspaceRoot: props.snapshot?.workspaceRoot }).then(props.onRefresh)}>Import all stored models</button>
            <button className="primary" data-run-benchmark="true" onClick={props.onRunBenchmark}>Run benchmark</button>
            <button className="ghost" disabled={!selectedRemoteProvider || providerKeyBusy || !String(providerKeyValue || '').trim()} onClick={() => void saveSelectedRemoteKey()}>
              {providerKeyBusy ? 'Saving key…' : `Save ${selectedRemoteProvider?.label || 'remote'} key`}
            </button>
            <button className="ghost" disabled={!selectedRemoteProvider || providerKeyBusy} onClick={() => void clearSelectedRemoteKey()}>
              Clear key
            </button>
            {nextFoundryCandidate ? (
              <button
                className="ghost"
                onClick={() => void window.gosAgent.seedModelFoundryCandidate({
                  workspaceRoot: props.snapshot?.workspaceRoot,
                  candidate: nextFoundryCandidate,
                }).then(props.onRefresh)}
              >
                Seed next candidate
              </button>
            ) : null}
            {activeLaneOverrideCount > 0 ? <button className="ghost" onClick={() => void props.onUpdateSetting('aiLaneOverrides', {})}>Reset lane overrides</button> : null}
          </div>
          <div className="card-grid">
            <article className="metric-card">
              <div className="eyebrow">Guardrails</div>
              <strong>{resourcePolicy.recommendedProfileId || 'hybrid-default'}</strong>
              <p>{resourcePolicy.summary || 'No guardrail summary yet.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Machine load</div>
              <strong>CPU {Number(aiTelemetry.cpuUsagePercent || 0)}% • MEM {Number(aiTelemetry.memoryUsedPercent || 0)}%</strong>
              <p>{String(aiTelemetry.thermalState || 'unknown')} thermal • {Number(aiTelemetry.activeRuns || 0)} active run(s)</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Storage + background work</div>
              <strong>{resourcePolicy.storageReachable === false ? 'Paused' : (resourcePolicy.shouldThrottleBackgroundWork ? 'Throttle' : 'Ready')}</strong>
              <p>{resourcePolicy.storageReachable === false ? 'Model storage is unreachable.' : `Background work ${resourcePolicy.shouldThrottleBackgroundWork ? 'should stay quiet' : 'can stay enabled'} right now.`}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Training fallback</div>
              <strong>{trainingFallback ? (trainingFallback.label || 'Ready') : 'Not needed'}</strong>
              <p>{trainingFallback ? String(trainingFallback.summary || 'Use the smaller fallback path first.') : 'Current telemetry does not need a fallback path right now.'}</p>
            </article>
          </div>
          <div className="card-grid">
            {aiProfiles.map((profile: JsonMap) => (
              <article key={profile.id} className={`metric-card${profile.active ? ' active' : ''}`}>
                <div className="eyebrow">{profile.active ? 'Active profile' : 'Profile'}</div>
                <strong>{profile.label || profile.id}</strong>
                <p>{profile.summary}</p>
                <div className="row-actions">
                  <button
                    className={profile.active ? 'ghost' : 'primary'}
                    onClick={() => {
                      void props.onUpdateSetting('aiProfile', profile.id);
                      void props.onUpdateSetting('aiRoutingPolicy', profile.routingPolicy || profile.id);
                    }}
                  >
                    {profile.active ? 'Active' : 'Use profile'}
                  </button>
                </div>
              </article>
            ))}
          </div>
          <div className="card-grid">
            {aiProviders.map((provider: JsonMap) => (
              <article key={provider.id} className="metric-card">
                <div className="eyebrow">{provider.available ? 'Ready' : 'Unavailable'}</div>
                <strong>{provider.label || provider.id}</strong>
                <p>{provider.detail || provider.summary}</p>
              </article>
            ))}
          </div>
          <section className="queue-card">
            <div className="eyebrow">Selector catalog</div>
            {modelStorageRoot ? <p className="empty-copy">Shared folder: {modelStorageRoot}</p> : null}
            {aiModelOptions.slice(0, 10).map((option) => (
              <div key={`${option.provider}-${option.model}`} className="run-item">
                <strong>{option.label}</strong>
                <span>{option.provider} • {option.ready ? 'ready' : (option.source === 'recommended' ? 'recommended' : 'import needed')}{option.note ? ` • ${option.note}` : ''}</span>
              </div>
            ))}
            {aiModelOptions.length === 0 ? <p className="empty-copy">No selector-backed models are available yet. Start Ollama or import a recommended model first.</p> : null}
          </section>
          <section className="queue-card">
            <div className="panel-header">
              <div>
                <div className="eyebrow">Download presets</div>
                <h2>Pull more local models without guessing</h2>
                <p>Use these curated presets for the current hardware target. Hugging Face links stay attached so you can trace the source.</p>
              </div>
            </div>
            {(recommendedInstallPresets.length ? recommendedInstallPresets : installPresets).slice(0, 6).map((preset: JsonMap) => (
              <div key={String(preset.id || preset.label)} className="run-item">
                <strong>{preset.label || preset.id}</strong>
                <span>
                  {String(preset.sizeLabel || '') || 'size pending'}
                  {preset.sourceLabel ? ` • ${String(preset.sourceLabel)}` : ''}
                  {preset.hardwareRecommended ? ' • good fit for this target' : ''}
                  {preset.sourceUrl ? ` • ${String(preset.sourceUrl)}` : ''}
                </span>
                <div className="row-actions">
                  {preset.ollamaModel ? (
                    <button className="ghost" onClick={() => void props.onUpdateSetting('trainingOllamaModel', String(preset.ollamaModel || ''))}>
                      Pick model
                    </button>
                  ) : null}
                  {preset.downloadCommand ? (
                    <button className="ghost" onClick={() => void window.navigator.clipboard?.writeText(String(preset.downloadCommand || ''))}>
                      Copy install command
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {(recommendedInstallPresets.length ? recommendedInstallPresets : installPresets).length === 0 ? (
              <p className="empty-copy">No curated local model presets are available yet.</p>
            ) : null}
          </section>
          <section className="queue-card">
            <div className="eyebrow">Model Foundry suggestions</div>
            {suggestedFoundryCandidates.slice(0, 4).map((candidate: JsonMap) => (
              <div key={String(candidate.id || candidate.title)} className="run-item">
                <strong>{candidate.title || candidate.id || 'Candidate'}</strong>
                <span>{summarizeText(candidate.summary || '')}</span>
              </div>
            ))}
            {suggestedFoundryCandidates.length === 0 ? <p className="empty-copy">Run more benchmarks or approve more sessions to seed the next candidate automatically.</p> : null}
          </section>
          <section className="queue-card">
            <div className="eyebrow">Saved Model Foundry candidates</div>
            {savedFoundryCandidates.slice(0, 4).map((candidate: JsonMap) => (
              <div key={String(candidate.id || candidate.title)} className="run-item">
                <strong>{candidate.title || candidate.id || 'Candidate'}</strong>
                <span>{candidate.safetyLevel || 'candidate'} • {(Array.isArray(candidate.targetLanes) ? candidate.targetLanes.join(', ') : '') || 'lanes pending'}</span>
              </div>
            ))}
            {savedFoundryCandidates.length === 0 ? <p className="empty-copy">No foundry candidates have been seeded yet.</p> : null}
          </section>
          <section className="queue-card">
            <div className="eyebrow">Training fallback plan</div>
            {trainingFallback ? (
              <>
                <div className="run-item">
                  <strong>{trainingFallback.label || 'Fallback plan'}</strong>
                  <span>{String(trainingFallback.summary || '')}</span>
                </div>
                {(Array.isArray(trainingFallback.notes) ? trainingFallback.notes : []).slice(0, 3).map((note: string, index: number) => (
                  <div key={`${note}-${index}`} className="run-item">
                    <strong>{trainingFallback.recommendedProfile || 'low'} profile</strong>
                    <span>{note}</span>
                  </div>
                ))}
              </>
            ) : (
              <p className="empty-copy">The current machine load does not require a smaller fallback path.</p>
            )}
          </section>
          <section className="queue-card">
            <div className="panel-header">
              <div>
                <div className="eyebrow">Capability lanes</div>
                <h2>Tune each lane without hand-editing routing rules</h2>
                <p>Leave a lane on inherit to follow the active profile, or pin it to the benchmark leader or a specific model.</p>
              </div>
            </div>
            <div className="card-grid lane-grid">
              {capabilityLanes.map((lane: JsonMap) => (
                <article key={String(lane.id)} className="metric-card lane-card">
                  <div className="eyebrow">Lane</div>
                  <strong>{lane.label || lane.id}</strong>
                  <p>{lane.summary}</p>
                  <div className="lane-summary">
                    <span>{lane.provider || 'provider'} • {lane.preferredModel || 'model pending'}</span>
                    <span>{lane.sourceLabel || (lane.source === 'override' ? 'Manual override' : 'Inherited route')}</span>
                    <span>Default: {lane.defaultProvider || 'provider'} • {lane.defaultModel || 'model pending'}</span>
                  </div>
                  <label className="lane-select-row">
                    <span>Route this lane</span>
                    <select
                      data-lane-select={String(lane.id)}
                      value={encodeLaneOverrideValue((lane.override as JsonMap) || aiLaneOverrides[String(lane.id)] || null)}
                      onChange={(event) => {
                        const nextOverrides = { ...aiLaneOverrides };
                        const nextOverride = decodeLaneOverrideValue(event.target.value);
                        if (nextOverride) {
                          nextOverrides[String(lane.id)] = nextOverride;
                        } else {
                          delete nextOverrides[String(lane.id)];
                        }
                        void props.onUpdateSetting('aiLaneOverrides', nextOverrides);
                      }}
                    >
                      <option value="inherit">Inherit profile + policy</option>
                      <option value="current">Pin to current workspace route</option>
                      <option value="benchmark">Use benchmark leader</option>
                      {aiModelOptions.map((option) => (
                        <option key={`${lane.id}-${option.provider}-${option.model}`} value={`model:${option.provider}:${option.model}`}>
                          {option.label} ({option.provider}{option.ready ? ', ready' : ', import'})
                        </option>
                      ))}
                    </select>
                  </label>
                  {lane.override ? (
                    <div className="chip-row">
                      <button className="ghost" onClick={() => {
                        const nextOverrides = { ...aiLaneOverrides };
                        delete nextOverrides[String(lane.id)];
                        void props.onUpdateSetting('aiLaneOverrides', nextOverrides);
                      }}>
                        Reset lane
                      </button>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
          <section className="queue-card">
            <div className="eyebrow">Monitor handoff</div>
            <div className="run-item">
              <strong>Deep health, benchmarks, promotions, and debug exports moved to Monitor.</strong>
              <span>Keep AI settings focused on selectors and lane tuning here, then use Monitor for the live operational view.</span>
            </div>
          </section>
        </section>
      ) : null}

      {props.activeTab === 'autonomy' ? (
        <section className="settings-section">
          <div className="settings-grid">
            <label>
              <span>Safety level</span>
              <select value={selectedSafetyLevel} onChange={(event) => void props.onUpdateSetting('safetyLevel', event.target.value)}>
                {safetyLevels.map((level: JsonMap) => (
                  <option key={String(level.id)} value={String(level.id)}>{level.label || level.id}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Autonomy profile</span>
              <select
                value={groupedAutonomy.profileId || 'supervised-auto'}
                disabled={selectedSafetyLevel !== 'custom'}
                onChange={(event) => void props.onUpdateSetting('autonomyMode', event.target.value)}
              >
                {['manual', 'supervised-auto', 'builder', 'operator', 'lab-full-auto', 'custom'].map((profile) => (
                  <option key={profile} value={profile}>{profile}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Max retry rounds</span>
              <input type="number" min={1} max={8} value={String(groupedAutonomy.maxRetryRounds || 2)} onChange={(event) => void props.onUpdateSetting('maxRetryRounds', Number(event.target.value || 2))} />
            </label>
          </div>
          <div className="card-grid">
            <article className="metric-card">
              <div className="eyebrow">Active safety level</div>
              <strong>{activeSafetyLevel?.label || selectedSafetyLevel}</strong>
              <p>{String(activeSafetyLevel?.summary || groupedAutonomy.safetySummary || 'Choose how aggressive the engine is allowed to be.')}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Autonomy mode</div>
              <strong>{groupedAutonomy.profileId || 'supervised-auto'}</strong>
              <p>{selectedSafetyLevel === 'custom' ? 'Custom safety leaves the autonomy profile editable.' : 'Autonomy follows the selected safety level unless you switch to Custom.'}</p>
            </article>
          </div>
          <div className="toggle-grid">
            {[
              ['autoSynthesizeBats', 'Auto-queue bounded next task after the run settles', groupedAutonomy.autoSynthesizeBats],
              ['autoRetryUntilPass', 'Auto retry failing coding runs', groupedAutonomy.autoRetryUntilPass],
              ['autoBrainstormOnFailure', 'Brainstorm repair options on failure', groupedAutonomy.autoBrainstormOnFailure],
              ['autoApproveLowRisk', 'Auto approve low-risk patches', groupedAutonomy.autoApproveLowRisk],
              ['supervisedAutoRunRecipes', 'Auto-run queued next task when safe', groupedAutonomy.supervisedAutoRunRecipes],
              ['humanApprovalProtectedOnly', 'Gate protected paths only', groupedAutonomy.humanApprovalProtectedOnly],
              ['sandboxRequired', 'Require sandboxed execution', groupedAutonomy.sandboxRequired],
            ].map(([field, label, checked]) => (
              <label key={String(field)} className="toggle-row">
                <input type="checkbox" checked={checked === true} onChange={(event) => void props.onUpdateSetting(String(field), event.target.checked)} />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </section>
      ) : null}

      {props.activeTab === 'skills' ? (
        <section className="settings-section">
          <div className="card-grid">
            {props.skills.map((skill: JsonMap) => (
              <article key={String(skill.path || skill.name)} className="metric-card">
                <div className="eyebrow">Skill</div>
                <strong>{skill.name}</strong>
                <p>{skill.description}</p>
                <button className="ghost" onClick={() => void window.gosAgent.runSkill({ skillPath: skill.path, open: true })}>Open</button>
              </article>
            ))}
          </div>
          {props.skills.length === 0 ? <p className="empty-copy">No local skills were discovered yet.</p> : null}
        </section>
      ) : null}

      {props.activeTab === 'extensions' ? (
        <section className="settings-section">
          <div className="card-grid">
            <article className="metric-card">
              <div className="eyebrow">Integration Studio</div>
              <strong>{integrationLibrary.length} starter item{integrationLibrary.length === 1 ? '' : 's'}</strong>
              <p>{String(integrations.summary || 'Keep one clean registry for plugins, adapters, and extensions so the system grows without duplicating surfaces.')}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Installed locally</div>
              <strong>{installedIntegrations.length}</strong>
              <p>{installedIntegrations.length ? 'Installed items live under .gos-integrations in the target workspace.' : 'Nothing is installed yet. Start with a bounded sample and review it before expanding the surface.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Rollback archive</div>
              <strong>{archivedAppBackups.length} archived app backup{archivedAppBackups.length === 1 ? '' : 's'}</strong>
              <p>{String(props.snapshot?.settings?.storage?.appRollbackRoot || appRollbacks.root || 'Desktop app rollbacks will be archived outside /Applications so the live install stays clean.')}</p>
            </article>
          </div>

          {integrationKinds.map((kind) => {
            const entries = integrationLibrary.filter((item: JsonMap) => String(item?.kind || '') === kind);
            if (!entries.length) {
              return null;
            }
            return (
              <section key={kind} className="queue-card">
                <div className="eyebrow">{kind}s</div>
                {entries.map((entry: JsonMap) => (
                  <article key={String(entry.id || '')} className="run-item">
                    <div>
                      <strong>{String(entry.label || entry.id || '')}</strong>
                      <span>{String(entry.summary || 'No summary recorded yet.')}</span>
                      <span>{String(entry.version || '0.1.0')} • {entry.installed ? 'installed' : 'ready to install'}</span>
                    </div>
                    <div className="row-actions">
                      <button
                        className="ghost"
                        onClick={() => void window.gosAgent.openLocation({ path: String(entry.installedPath || entry.rootPath || '') })}
                      >
                        Open
                      </button>
                      <button
                        className={entry.installed ? 'ghost' : 'primary'}
                        onClick={() => void window.gosAgent.installIntegration({
                          workspaceRoot: props.snapshot?.targetWorkspaceRoot || props.snapshot?.workspaceRoot,
                          integrationId: entry.id,
                        }).then(props.onRefresh)}
                      >
                        {entry.installed ? 'Reinstall sample' : 'Install sample'}
                      </button>
                    </div>
                  </article>
                ))}
              </section>
            );
          })}

          {installedIntegrations.length > 0 ? (
            <section className="queue-card">
              <div className="eyebrow">Installed items</div>
              {installedIntegrations.map((entry: JsonMap) => (
                <div key={String(entry.rootPath || entry.id)} className="run-item">
                  <strong>{String(entry.label || entry.id || '')}</strong>
                  <span>{String(entry.kind || 'integration')} • {shortPath(String(entry.rootPath || ''))}</span>
                </div>
              ))}
            </section>
          ) : null}
        </section>
      ) : null}

      {props.activeTab === 'tools' ? (
        <section className="settings-section">
          <div className="card-grid">
            {props.tools.map((tool: JsonMap) => (
              <article key={String(tool.id)} className="metric-card">
                <div className="eyebrow">{tool.safetyLevel || 'safe'} • {tool.kind || 'tool'}</div>
                <strong>{tool.label || tool.id}</strong>
                <p>{tool.summary}</p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {props.activeTab === 'automations' ? (
        <section className="settings-section">
          <div className="card-grid">
            <article className="metric-card">
              <div className="eyebrow">Autopilot action</div>
              <strong>{groupedAutomations.action || 'implement'}</strong>
              <p>{groupedAutomations.selfImprove ? 'Self-improvement support is enabled.' : 'General coding automation mode.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Queued automations</div>
              <strong>{props.automations.length}</strong>
              <p>Keep automation jobs here so the chat surface stays uncluttered.</p>
            </article>
          </div>
          <section className="queue-card">
            <div className="eyebrow">Automation jobs</div>
            {props.automations.map((job: JsonMap) => (
              <div key={String(job.id || job.name)} className="run-item">
                <strong>{job.name || job.id}</strong>
                <span>{job.enabled === false ? 'disabled' : 'active'} • {job.cron || job.schedule || 'manual'}</span>
              </div>
            ))}
            {props.automations.length === 0 ? <p className="empty-copy">No automations are configured yet.</p> : null}
          </section>
        </section>
      ) : null}

      {props.activeTab === 'labs' ? (
        <section className="settings-section">
          <div className="row-actions">
            <button className="ghost" onClick={() => props.onCreateLab('self-host')}>Create self-host lab</button>
            <button className="ghost" onClick={() => props.onCreateLab('mirror')}>Create scratch mirror</button>
            <button className="ghost" onClick={() => props.onCreateLab('benchmark-self-host')}>Create self-host benchmark</button>
            <button className="ghost" onClick={() => props.onCreateLab('dummy-node-app')}>Create dummy app lab</button>
            <button className="ghost" onClick={() => props.onCreateLab('dummy-broken-node-app')}>Create broken dummy lab</button>
          </div>
          <LabsPanel
            snapshot={props.snapshot}
            labs={props.labs}
            onSelectLab={props.onSelectLab}
            onRefresh={props.onRefresh}
          />
        </section>
      ) : null}

      {props.activeTab === 'learning' ? (
        <LearningPanel
          snapshot={props.snapshot}
          learningStatus={props.learningStatus}
          learningChanges={props.learningChanges}
          onCaptureLearning={props.onCaptureLearning}
          onExport={props.onExportLearning}
        />
      ) : null}

      {props.activeTab === 'storage' ? (
        <section className="settings-section">
          <div className="card-grid">
            {[
              ['Runs', groupedStorage.runsDir],
              ['Learning journal', groupedStorage.journalPath],
              ['Labs root', groupedStorage.labsRoot],
              ['Benchmarks', groupedStorage.benchmarkRoot],
              ['App rollbacks', groupedStorage.appRollbackRoot],
            ].map(([label, value]) => (
              <article key={String(label)} className="metric-card">
                <div className="eyebrow">{label}</div>
                <strong>{shortPath(String(value || '')) || 'Not configured'}</strong>
                <p>{String(value || '') || 'This path will remain explicit so the app never silently writes into the wrong place.'}</p>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </section>
  );
}

function MonitorPanel(props: {
  snapshot: JsonMap | null;
  aiStatus: JsonMap | null;
  tuning: JsonMap | null;
  learningStatus: JsonMap;
  runtimeEvents: JsonMap[];
  learningEvents: JsonMap[];
  labEvents: JsonMap[];
  benchmarkEvents: JsonMap[];
  activeTab: MonitorTabId;
  onSetActiveTab: (tab: MonitorTabId) => void;
  onCreateCandidate: () => void;
  onPromoteCandidate: (candidateId: string) => void;
  onRollbackLatestBackup: (backupId?: string) => void;
  onSetManualSafeMode: (enabled: boolean) => void;
  onRunBenchmark: () => void;
  onRunAcceptance: () => void;
  onExportDebugBundle: () => void;
  onOpenReviewPath: (path: string, source?: string) => void;
  onCreateSuggestedTask: (candidate: JsonMap) => Promise<void>;
  onQueueSuggestedRecipe: (recipe: JsonMap) => Promise<void>;
  onRecordOperatorFeedback: (payload: JsonMap) => Promise<void>;
  onRefresh: () => void;
  acceptanceBusy: boolean;
  safetyBusy: boolean;
}) {
  const safeMode = readSafeMode(props.snapshot);
  const taskRuns = Array.isArray(props.snapshot?.taskHub?.runs) ? props.snapshot?.taskHub?.runs : [];
  const promotions = props.snapshot?.promotions || {};
  const reviewer = props.snapshot?.reviewer && typeof props.snapshot.reviewer === 'object'
    ? props.snapshot.reviewer
    : {};
  const regression = props.snapshot?.regression && typeof props.snapshot.regression === 'object'
    ? props.snapshot.regression
    : {};
  const testBench = props.snapshot?.testBench && typeof props.snapshot.testBench === 'object'
    ? props.snapshot.testBench
    : {};
  const acceptanceState = props.snapshot?.acceptance && typeof props.snapshot.acceptance === 'object'
    ? props.snapshot.acceptance
    : {};
  const acceptance = acceptanceState?.report && typeof acceptanceState.report === 'object'
    ? acceptanceState.report
    : {};
  const readiness = props.snapshot?.readiness && typeof props.snapshot.readiness === 'object'
    ? props.snapshot.readiness
    : {};
  const candidates = Array.isArray(promotions.candidates) ? promotions.candidates : [];
  const backups = Array.isArray(promotions.backups) ? promotions.backups : [];
  const promotionHistory = Array.isArray(promotions.history) ? promotions.history : [];
  const promotionGate = promotions.promotionGate && typeof promotions.promotionGate === 'object'
    ? promotions.promotionGate
    : {};
  const selectedLabRoot = String(props.snapshot?.selectedLabRoot || '').trim();
  const benchmarkLeader = props.aiStatus?.benchmarkSummary?.[0] || null;
  const modelProvisioning = props.aiStatus?.provisioning && typeof props.aiStatus.provisioning === 'object'
    ? props.aiStatus.provisioning
    : {};
  const resourcePolicy = props.aiStatus?.resourcePolicy || {};
  const pausedSystems = Array.isArray(safeMode.controller?.pausedSystems)
    ? safeMode.controller.pausedSystems
    : (Array.isArray(safeMode.pausedSystems) ? safeMode.pausedSystems : []);
  const readinessMilestones = Array.isArray(readiness.milestones) ? readiness.milestones : [];
  const currentRoadmapMonth = readiness.currentMonth && typeof readiness.currentMonth === 'object'
    ? readiness.currentMonth
    : {};
  const readinessHardGate = readiness.hardGate && typeof readiness.hardGate === 'object'
    ? readiness.hardGate
    : {};
  const docsVault = props.snapshot?.manager?.approvedDocsVault && typeof props.snapshot.manager.approvedDocsVault === 'object'
    ? props.snapshot.manager.approvedDocsVault
    : {};
  const operatorSupervision = props.learningStatus?.operatorSupervision && typeof props.learningStatus.operatorSupervision === 'object'
    ? props.learningStatus.operatorSupervision
    : {};
  const supervisionSignals = Array.isArray(operatorSupervision.signals) ? operatorSupervision.signals : [];
  const testBenchFollowups = Array.isArray(testBench.followups) ? testBench.followups : [];
  const nextSafeAction = testBench.nextSafeAction && typeof testBench.nextSafeAction === 'object'
    ? testBench.nextSafeAction
    : {};
  const safeRecipe = testBench.safeRecipe && typeof testBench.safeRecipe === 'object'
    ? testBench.safeRecipe
    : {};
  const [operatorComment, setOperatorComment] = React.useState('');
  const [creatingOperatorTask, setCreatingOperatorTask] = React.useState(false);
  const [recordingOperatorFeedback, setRecordingOperatorFeedback] = React.useState(false);

  const onCreateOperatorTask = async () => {
    const note = operatorComment.trim();
    if (!note) {
      return;
    }
    const targetPaths = testBench.preferredPath ? [String(testBench.preferredPath)] : [];
    setCreatingOperatorTask(true);
    try {
      await props.onCreateSuggestedTask({
        id: makeId('operator-revision'),
        kind: 'revision',
        category: 'operator-comment',
        title: 'Revise from operator comment',
        objective: note,
        summary: `Operator comment: ${summarizeText(note, 120)}`,
        targetPaths,
        riskClass: 'medium',
        source: 'operator-comment',
      });
      setOperatorComment('');
    } finally {
      setCreatingOperatorTask(false);
    }
  };

  const onRecordFeedback = async (verdict: 'approved' | 'needs-changes' | 'comment') => {
    setRecordingOperatorFeedback(true);
    try {
      await props.onRecordOperatorFeedback({
        verdict,
        note: operatorComment.trim(),
        path: String(testBench.preferredPath || ''),
        summary: verdict === 'approved'
          ? 'Operator approved the current Test Bench direction.'
          : verdict === 'needs-changes'
            ? 'Operator requested another revision pass from Test Bench.'
            : 'Operator left a supervision note for the current Test Bench direction.',
        source: 'monitor-runs',
      });
      if (
        verdict === 'needs-changes'
        && !operatorComment.trim()
        && safeRecipe?.autoQueueEligible
        && safeRecipe.exists
      ) {
        await props.onQueueSuggestedRecipe({
          ...safeRecipe,
          autoQueuedFromMonitor: true,
        });
      } else if (
        verdict === 'needs-changes'
        && !operatorComment.trim()
        && nextSafeAction?.autoQueueEligible
        && nextSafeAction.candidate
      ) {
        await props.onCreateSuggestedTask({
          ...nextSafeAction.candidate,
          metadata: {
            ...(nextSafeAction.candidate.metadata && typeof nextSafeAction.candidate.metadata === 'object'
              ? nextSafeAction.candidate.metadata
              : {}),
            autoQueuedFromMonitor: true,
          },
        });
      }
      setOperatorComment('');
    } finally {
      setRecordingOperatorFeedback(false);
    }
  };

  return (
    <section className="module-panel monitor-panel" data-panel="monitor">
      <div className="panel-header">
        <div>
          <div className="eyebrow">Monitor</div>
          <h2>One place to watch the engine, learning loop, and promotion rings</h2>
          <p>Safe mode, runs, benchmarks, promotions, and debug exports stay here so chat can stay clean.</p>
        </div>
        <div className="row-actions">
          <button className="ghost" onClick={props.onRefresh}>Refresh</button>
          <button className="ghost" onClick={() => props.onSetManualSafeMode(true)} disabled={props.safetyBusy || safeMode.controller?.manualSafeMode === true}>
            {props.safetyBusy && safeMode.controller?.manualSafeMode !== true ? 'Stabilizing…' : 'Pause risky work'}
          </button>
          <button className="ghost" onClick={() => props.onSetManualSafeMode(false)} disabled={props.safetyBusy || safeMode.controller?.manualSafeMode !== true}>
            {props.safetyBusy && safeMode.controller?.manualSafeMode === true ? 'Releasing…' : 'Release safe mode'}
          </button>
          <button className="ghost" onClick={props.onRunAcceptance} disabled={props.acceptanceBusy}>
            {props.acceptanceBusy ? 'Running acceptance…' : 'Run acceptance'}
          </button>
          <button className="ghost" onClick={props.onRunBenchmark}>Run benchmark</button>
          <button className="primary" onClick={props.onExportDebugBundle}>Export debug bundle</button>
        </div>
      </div>

      <div className="settings-tabs">
        {MONITOR_TABS.map((tab) => (
          <button key={tab} className={props.activeTab === tab ? 'active' : ''} onClick={() => props.onSetActiveTab(tab)}>
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {props.activeTab === 'overview' ? (
        <section className="settings-section">
          <div className="card-grid">
            <article className="metric-card">
              <div className="eyebrow">Ring</div>
              <strong>{selectedLabRoot ? 'Lab' : 'Live'}</strong>
              <p>{selectedLabRoot ? shortPath(selectedLabRoot) : shortPath(props.snapshot?.workspaceRoot) || 'No workspace selected'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Safe mode</div>
              <strong>{safeMode.active ? 'Active' : safeMode.watchOnly ? 'Watch' : 'Ready'}</strong>
              <p>{String(safeMode.summary || 'Safety guardrails look healthy.')}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Benchmark leader</div>
              <strong>{benchmarkLeader?.model || props.aiStatus?.current?.derivedModelLabel || 'No benchmark yet'}</strong>
              <p>{benchmarkLeader ? `${benchmarkLeader.passRate || 0}% pass • ${benchmarkLeader.averageLatencyMs || 0}ms avg latency` : 'Run the daily benchmark targets to tune routing.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Background work</div>
              <strong>{resourcePolicy.shouldThrottleBackgroundWork ? 'Throttle' : 'Ready'}</strong>
              <p>{resourcePolicy.summary || 'Machine guardrails look healthy for background work.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Acceptance</div>
              <strong>{acceptance?.overallStatus ? String(acceptance.overallStatus).toUpperCase() : 'Not run yet'}</strong>
              <p>{acceptance?.summary || 'Run the engine acceptance suite here to seed Monitor with a real self-host + dummy lab gate result.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">12-month baseline</div>
              <strong>{typeof readiness.percent === 'number' ? `${readiness.percent}%${currentRoadmapMonth.number ? ` • Month ${Number(currentRoadmapMonth.number)}` : ''}` : 'Not scored yet'}</strong>
              <p>{String(readiness.summary || 'Readiness scoring will appear once the monitor snapshot is fully available.')}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Paused systems</div>
              <strong>{pausedSystems.length > 0 ? pausedSystems.join(' • ') : 'none'}</strong>
              <p>{safeMode.controller?.manualSafeMode ? 'Manual hard safe mode is engaged.' : 'No hard pause is currently holding the engine.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Reviewer</div>
              <strong>{String(reviewer.status || 'ready')}</strong>
              <p>{String(reviewer.summary || 'Reviewer summary will appear here after the next full sync.')}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Regression builder</div>
              <strong>{Number(regression.candidateCount || 0)} candidate{Number(regression.candidateCount || 0) === 1 ? '' : 's'}</strong>
              <p>{String(regression.summary || 'Regression Builder will suggest replayable follow-up coverage here.')}</p>
            </article>
          </div>
          <div className="card-grid">
            {Array.isArray(props.snapshot?.manager?.healthCards) ? props.snapshot?.manager?.healthCards.map((card: JsonMap) => (
              <article key={String(card.id || card.label)} className="metric-card">
                <div className="eyebrow">{card.label || card.id}</div>
                <strong>{card.value || '—'}</strong>
                <p>{summarizeText(card.detail || '')}</p>
              </article>
            )) : null}
          </div>
          {acceptanceState?.exists ? (
            <section className="queue-card">
              <div className="eyebrow">Latest engine acceptance</div>
              <div className="run-item">
                <strong>{acceptance?.summary || 'Acceptance report ready'}</strong>
                <span>{formatStamp(acceptance?.completedAt || acceptance?.startedAt)} • {acceptance?.nextAction || 'No follow-up guidance recorded.'}</span>
              </div>
              {Array.isArray(acceptance?.checks) ? acceptance.checks.slice(0, 6).map((check: JsonMap) => (
                <div key={String(check.id || check.label)} className="run-item">
                  <strong>{check.label || check.id || 'check'}</strong>
                  <span>{String(check.status || 'unknown')} • {summarizeText(check.summary || '', 140)}</span>
                </div>
              )) : null}
              <p className="empty-copy">Run acceptance here or from `npm run engine:acceptance` whenever you want a fresh self-host + dummy lab gate.</p>
            </section>
          ) : null}
          {docsVault.exists ? (
            <section className="queue-card">
              <div className="eyebrow">Trusted docs vault</div>
              <div className="run-item">
                <strong>{String(docsVault.freshnessLabel || 'unknown').toUpperCase()}</strong>
                <span>{String(docsVault.summary || 'Trusted docs vault is active.')}</span>
              </div>
              {String(docsVault.recommendedAction || '').trim() ? (
                <div className="run-item">
                  <strong>Recommended next move</strong>
                  <span>{String(docsVault.recommendedAction || '')}</span>
                </div>
              ) : null}
              {Array.isArray(docsVault.recommendedSources) ? docsVault.recommendedSources.slice(0, 3).map((item: JsonMap, index: number) => (
                <div key={`${item.domain || index}-docs-recommendation`} className="run-item">
                  <strong>{String(item.label || item.domain || 'Trusted docs')}</strong>
                  <span>{String(item.reason || item.domain || '')}</span>
                </div>
              )) : null}
              {docsVault.latest && typeof docsVault.latest === 'object' ? (
                <div className="run-item">
                  <strong>{String(docsVault.latest.domain || 'trusted docs')}</strong>
                  <span>{String(docsVault.latest.title || docsVault.latest.summary || '')}</span>
                </div>
              ) : null}
              {Array.isArray(docsVault.domains) ? docsVault.domains.slice(0, 3).map((item: JsonMap, index: number) => (
                <div key={`${item.domain || index}-docs-domain`} className="run-item">
                  <strong>{String(item.label || item.domain || 'domain')}</strong>
                  <span>{`${Number(item.count || 0)} saved • ${String(item.safetyLevel || 'official')}`}</span>
                </div>
              )) : null}
            </section>
          ) : null}
          <section className="queue-card">
            <div className="eyebrow">Hard safe-mode controller</div>
            <div className="run-item">
              <strong>{safeMode.controller?.manualSafeMode ? 'Manual hard safe mode is engaged' : 'Hard safe mode is ready'}</strong>
              <span>{String(safeMode.summary || 'Safety guardrails look healthy.')}</span>
            </div>
            {pausedSystems.length > 0 ? (
              <div className="run-item">
                <strong>Paused systems</strong>
                <span>{pausedSystems.join(' • ')}</span>
              </div>
            ) : null}
            <p className="empty-copy">This is the emergency brake. It stops the scheduler, cancels risky active runs, and keeps promotions, training, and benchmarks paused until you release it.</p>
          </section>
          <section className="queue-card">
            <div className="eyebrow">Promotion gate</div>
            <div className="run-item">
              <strong>{String(promotionGate.status || 'blocked').toUpperCase()}</strong>
              <span>{String(promotionGate.summary || 'Create a verified candidate and run acceptance before promoting live.')}</span>
            </div>
            {String(promotionGate.acceptanceSummary || '').trim() ? (
              <div className="run-item">
                <strong>Acceptance baseline</strong>
                <span>{String(promotionGate.acceptanceStatus || 'unknown')} • {String(promotionGate.acceptanceSummary || '')}</span>
              </div>
            ) : null}
            {Array.isArray(promotionGate.reasons) ? promotionGate.reasons.slice(0, 3).map((reason: string, index: number) => (
              <div key={`${reason}-${index}`} className="run-item">
                <strong>Gate reason</strong>
                <span>{reason}</span>
              </div>
            )) : null}
          </section>
          <section className="queue-card">
            <div className="eyebrow">12-month baseline readiness</div>
            <div className="run-item">
              <strong>{typeof readiness.percent === 'number' ? `${readiness.percent}% • ${String(readiness.status || 'warming-up')}` : 'Scoring unavailable'}</strong>
              <span>{String(readiness.summary || 'Readiness scoring will appear after the next snapshot refresh.')}</span>
            </div>
            {currentRoadmapMonth.label ? (
              <div className="run-item">
                <strong>{String(currentRoadmapMonth.label || 'Current month')}</strong>
                <span>{String(currentRoadmapMonth.layer || 'Primary layer not recorded yet.')}</span>
              </div>
            ) : null}
            {readinessHardGate.label ? (
              <div className="run-item">
                <strong>{String(readinessHardGate.label || 'Hard gate')}</strong>
                <span>{String(readinessHardGate.summary || 'Hard gate detail not recorded yet.')}</span>
              </div>
            ) : null}
            {readiness.dailyTargets ? (
              <div className="run-item">
                <strong>{`Daily targets • auto ${Number(readiness.dailyTargets?.autonomous?.safeCount || 0)}/${Number(readiness.dailyTargets?.autonomous?.target || 0)} • self ${Number(readiness.dailyTargets?.selfImprovement?.safeCount || 0)}/${Number(readiness.dailyTargets?.selfImprovement?.target || 0)}`}</strong>
                <span>{String(readiness.recommendedNextSafeAction || 'The next safe action will appear here when the roadmap is scored.')}</span>
              </div>
            ) : null}
            {String(modelProvisioning.summary || '').trim() ? (
              <div className="run-item">
                <strong>{`Model provisioning • ${String(modelProvisioning.status || modelProvisioning.state || 'unknown')}`}</strong>
                <span>{String(modelProvisioning.summary || '')}</span>
              </div>
            ) : null}
            {String(modelProvisioning.recommendedAction || '').trim() ? (
              <div className="run-item">
                <strong>Provisioning next step</strong>
                <span>{String(modelProvisioning.recommendedAction || '')}</span>
              </div>
            ) : null}
            {readiness.nextMilestone ? (
              <div className="run-item">
                <strong>{String(readiness.nextMilestone.label || 'Next milestone')}</strong>
                <span>{String(readiness.nextMilestone.summary || 'No extra detail recorded yet.')}</span>
              </div>
            ) : null}
            {readinessMilestones.slice(0, 5).map((milestone: JsonMap) => (
              <div key={String(milestone.id || milestone.label)} className="run-item">
                <strong>{String(milestone.label || milestone.id || 'Milestone')}</strong>
                <span>{String(milestone.completion || 0)}% • {String(milestone.summary || '')}</span>
              </div>
            ))}
          </section>
        </section>
      ) : null}

      {props.activeTab === 'runs' ? (
        <section className="settings-section">
          <div className="card-grid">
            <article className="metric-card">
              <div className="eyebrow">Test Bench</div>
              <strong>{String(testBench.status || 'ready')}</strong>
              <p>{String(testBench.summary || 'Test Bench summary will appear after the next sync.')}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Preferred path</div>
              <strong>{shortPath(testBench.preferredPath) || 'none yet'}</strong>
              <p>{testBench.preferredPath ? 'Open this path first for the fastest review loop.' : 'Reviewer will pick a preferred path once enough evidence is available.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Review notes</div>
              <strong>{Array.isArray(reviewer.notes) ? reviewer.notes.length : 0}</strong>
              <p>{String(reviewer.nextAction || 'Reviewer actions will land here once runs and review evidence are available.')}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Regression tasks</div>
              <strong>{Number(regression.candidateCount || 0)}</strong>
              <p>{String(regression.summary || 'Regression Builder will suggest coverage tasks here.')}</p>
            </article>
          </div>
          <section className="queue-card">
            <div className="eyebrow">Reviewer</div>
            <div className="run-item">
              <strong>{String(reviewer.summary || 'Reviewer is ready.')}</strong>
              <span>{String(reviewer.nextAction || 'No reviewer action is needed yet.')}</span>
            </div>
            {Array.isArray(reviewer.notes) ? reviewer.notes.map((note: JsonMap, index: number) => (
              <div key={`${note.title || note.path || index}`} className="run-item">
                <strong>{note.title || 'Reviewer note'}</strong>
                <span>{String(note.detail || '')}</span>
                {note.path ? (
                  <div className="chip-row">
                    <button className="ghost" onClick={() => props.onOpenReviewPath(String(note.path || ''), 'reviewer')}>Open file</button>
                  </div>
                ) : null}
              </div>
            )) : null}
            {Array.isArray(reviewer.revisionCandidates) ? reviewer.revisionCandidates.map((candidate: JsonMap) => (
              <div key={String(candidate.id || candidate.title)} className="run-item">
                <strong>{candidate.title || 'Revision task'}</strong>
                <span>{String(candidate.summary || candidate.objective || '')}</span>
                <div className="chip-row">
                  <button className="ghost" onClick={() => props.onCreateSuggestedTask(candidate)}>Create revision task</button>
                  {candidate.targetPaths?.[0] ? (
                    <button className="ghost" onClick={() => props.onOpenReviewPath(String(candidate.targetPaths[0] || ''), 'reviewer-task')}>Open target</button>
                  ) : null}
                </div>
              </div>
            )) : null}
            {!Array.isArray(reviewer.notes) || reviewer.notes.length === 0 ? <p className="empty-copy">Reviewer notes will appear here after changed files, validation, or approvals give it something to evaluate.</p> : null}
          </section>
          <section className="queue-card">
            <div className="eyebrow">Operator comment</div>
            <div className="run-item">
              <strong>Kick feedback back into the engine</strong>
              <span>Use this when you want the reviewer loop to turn your note into the next bounded revision task or a reusable supervision signal. File approvals still happen in Review.</span>
            </div>
            <label className="review-note">
              <span>What should change before approval?</span>
              <textarea
                value={operatorComment}
                onChange={(event) => setOperatorComment(event.target.value)}
                placeholder="Example: tighten the layout spacing, rerun the smoke test, and match the trusted docs setup before this is approved."
              />
            </label>
            <div className="chip-row">
              <button className="ghost" onClick={onCreateOperatorTask} disabled={!operatorComment.trim() || creatingOperatorTask}>
                {creatingOperatorTask ? 'Creating task…' : 'Create task from note'}
              </button>
              <button className="ghost" onClick={() => void onRecordFeedback('approved')} disabled={recordingOperatorFeedback}>
                {recordingOperatorFeedback ? 'Recording…' : 'Record approval'}
              </button>
              <button className="ghost" onClick={() => void onRecordFeedback('needs-changes')} disabled={recordingOperatorFeedback}>
                {recordingOperatorFeedback ? 'Recording…' : 'Record needs changes'}
              </button>
              <button className="ghost" onClick={() => void onRecordFeedback('comment')} disabled={recordingOperatorFeedback}>
                {recordingOperatorFeedback ? 'Recording…' : 'Record comment'}
              </button>
              {testBench.preferredPath ? (
                <button className="ghost" onClick={() => props.onOpenReviewPath(String(testBench.preferredPath || ''), 'operator-comment')}>
                  Open preferred path
                </button>
              ) : null}
            </div>
            {supervisionSignals.length > 0 ? (
              <>
                {supervisionSignals.slice(0, 3).map((signal: JsonMap, index: number) => (
                  <div key={`${signal.note || index}-${signal.verdict || 'comment'}`} className="run-item">
                    <strong>{String(signal.verdict || 'comment')}</strong>
                    <span>{String(signal.note || '')}</span>
                  </div>
                ))}
                <p className="empty-copy">{String(operatorSupervision.summary || 'Recent operator supervision is helping shape future guidance.')}</p>
              </>
            ) : (
              <p className="empty-copy">Operator comments stay lightweight on purpose. The goal is to capture the next safe revision and a reusable supervision signal, not open another giant control surface.</p>
            )}
          </section>
          <section className="queue-card">
            <div className="eyebrow">Test Bench</div>
            {nextSafeAction.exists ? (
              <div className="run-item">
                <strong>{String(nextSafeAction.title || 'Next safe action')}</strong>
                <span>{String(nextSafeAction.summary || nextSafeAction.reason || '')}</span>
                <div className="chip-row">
                  {nextSafeAction.candidate ? (
                    <button className="ghost" onClick={() => props.onCreateSuggestedTask(nextSafeAction.candidate)}>
                      {String(nextSafeAction.actionLabel || 'Create task')}
                    </button>
                  ) : null}
                  <span className="chip">{String(nextSafeAction.autoQueueEligible ? 'auto-queue ready' : nextSafeAction.reason || '')}</span>
                </div>
                {Array.isArray(nextSafeAction.candidate?.metadata?.recommendedSources)
                  ? nextSafeAction.candidate.metadata.recommendedSources.slice(0, 2).map((item: JsonMap, index: number) => (
                    <div key={`${item.domain || index}-next-safe-docs`} className="run-item">
                      <strong>{String(item.label || item.domain || 'Trusted docs')}</strong>
                      <span>{String(item.reason || item.domain || '')}</span>
                    </div>
                  ))
                  : null}
              </div>
            ) : null}
            {safeRecipe.exists ? (
              <div className="run-item">
                <strong>{String(safeRecipe.title || 'Supervised recipe')}</strong>
                <span>{String(safeRecipe.summary || safeRecipe.reason || '')}</span>
                <div className="chip-row">
                  <button className="ghost" onClick={() => props.onQueueSuggestedRecipe(safeRecipe)}>
                    {String(safeRecipe.actionLabel || 'Queue supervised recipe')}
                  </button>
                  <span className="chip">{String(safeRecipe.autoQueueEligible ? 'recipe queue ready' : safeRecipe.reason || '')}</span>
                </div>
                {Array.isArray(safeRecipe.steps) ? safeRecipe.steps.slice(0, 3).map((step: JsonMap, index: number) => (
                  <div key={`${step.id || index}-safe-recipe-step`} className="run-item">
                    <strong>{String(step.stepLabel || `Step ${index + 1}`)} • {String(step.title || 'Recipe step')}</strong>
                    <span>{String(step.summary || step.objective || '')}</span>
                  </div>
                )) : null}
              </div>
            ) : null}
            {testBench.docsContext?.exists ? (
              <>
                <div className="run-item">
                  <strong>Trusted docs context</strong>
                  <span>{String(testBench.docsContext.freshnessLabel || 'unknown')} • {String(testBench.docsContext.summary || '')}</span>
                </div>
                {String(testBench.docsContext.recommendedAction || '').trim() ? (
                  <div className="run-item">
                    <strong>Recommended next move</strong>
                    <span>{String(testBench.docsContext.recommendedAction || '')}</span>
                  </div>
                ) : null}
                {Array.isArray(testBench.docsContext.recommendedSources) ? testBench.docsContext.recommendedSources.slice(0, 3).map((item: JsonMap, index: number) => (
                  <div key={`${item.domain || index}-test-bench-docs`} className="run-item">
                    <strong>{String(item.label || item.domain || 'Trusted docs')}</strong>
                    <span>{String(item.reason || item.domain || '')}</span>
                  </div>
                )) : null}
                {testBench.docsContext.latest?.domain ? (
                  <div className="run-item">
                    <strong>{String(testBench.docsContext.latest.domain || 'trusted docs')}</strong>
                    <span>{String(testBench.docsContext.latest.title || testBench.docsContext.latest.summary || '')}</span>
                  </div>
                ) : null}
              </>
            ) : null}
            {testBenchFollowups.length > 0 ? (
              <>
                <div className="run-item">
                  <strong>Suggested next moves</strong>
                  <span>Reviewer and Regression Builder are merged here so you can pick the next safe slice without bouncing between panels.</span>
                </div>
                {testBenchFollowups.slice(0, 6).map((item: JsonMap) => (
                  <div key={String(item.id || item.title)} className="run-item">
                    <strong>{String(item.title || 'Follow-up task')}</strong>
                    <span>{String(item.kind || 'task')} • {String(item.riskClass || 'medium')} • {String(item.summary || '')}</span>
                    <div className="chip-row">
                      <button className="ghost" onClick={() => props.onCreateSuggestedTask(item.candidate && typeof item.candidate === 'object' ? item.candidate : item)}>
                        {String(item.actionLabel || '').trim()
                          || (String(item.kind || '').toLowerCase() === 'regression' ? 'Create regression task' : 'Create revision task')}
                      </button>
                      {item.targetPath ? (
                        <button className="ghost" onClick={() => props.onOpenReviewPath(String(item.targetPath || ''), 'test-bench-followup')}>
                          Open target
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </>
            ) : null}
            {Array.isArray(testBench.failingLocations) ? testBench.failingLocations.map((item: JsonMap, index: number) => (
              <div key={`${item.path || index}-${item.line || 1}`} className="run-item">
                <strong>{shortPath(item.path) || 'Validation finding'}</strong>
                <span>{`line ${Number(item.line || 1)} • ${String(item.message || 'Validation finding')}`}</span>
                {item.path ? (
                  <div className="chip-row">
                    <button className="ghost" onClick={() => props.onOpenReviewPath(String(item.path || ''), 'test-bench-failure')}>Open file</button>
                  </div>
                ) : null}
              </div>
            )) : null}
            {Array.isArray(testBench.changedFiles) ? testBench.changedFiles.slice(0, 8).map((item: JsonMap, index: number) => (
              <div key={`${item.path || index}-changed`} className="run-item">
                <strong>{shortPath(item.path || item) || 'Changed file'}</strong>
                <span>{String(item.status || 'modified')}</span>
                {item.path ? (
                  <div className="chip-row">
                    <button className="ghost" onClick={() => props.onOpenReviewPath(String(item.path || ''), 'test-bench-changed')}>Open file</button>
                  </div>
                ) : null}
              </div>
            )) : null}
            {Array.isArray(testBench.recentArtifacts) ? testBench.recentArtifacts.slice(0, 5).map((artifact: JsonMap, index: number) => (
              <div key={`${artifact.path || artifact.label || index}-artifact`} className="run-item">
                <strong>{artifact.label || shortPath(artifact.path || '') || 'Artifact'}</strong>
                <span>{shortPath(artifact.path || '') || String(artifact.kind || 'artifact')}</span>
              </div>
            )) : null}
            {(testBenchFollowups.length === 0)
              && (!Array.isArray(testBench.changedFiles) || testBench.changedFiles.length === 0)
              && (!Array.isArray(testBench.failingLocations) || testBench.failingLocations.length === 0)
              ? <p className="empty-copy">Test Bench will show changed files, failing locations, and artifacts after a full sync or run.</p>
              : null}
          </section>
          <section className="queue-card">
            <div className="eyebrow">Task runs</div>
            {taskRuns.slice(0, 14).map((run: JsonMap) => (
              <div key={String(run.runId || run.id || run.label)} className="run-item">
                <strong>{run.runtimeLabel || run.label || 'Run'}</strong>
                <span>{run.runtimeState || run.status || 'idle'} • {run.ring || 'live'}{run.sliceId ? ` • ${run.sliceId}` : ''}{run.blockedReason ? ` • ${summarizeText(run.blockedReason, 100)}` : ''}</span>
              </div>
            ))}
            {taskRuns.length === 0 ? <p className="empty-copy">No runs recorded yet.</p> : null}
          </section>
          <section className="queue-card">
            <div className="eyebrow">Regression Builder</div>
            {Array.isArray(regression.candidates) ? regression.candidates.map((candidate: JsonMap) => (
              <div key={String(candidate.id || candidate.title)} className="run-item">
                <strong>{candidate.title || 'Regression candidate'}</strong>
                <span>{String(candidate.summary || candidate.objective || '')}</span>
                <div className="chip-row">
                  <button className="ghost" onClick={() => props.onCreateSuggestedTask(candidate)}>Create regression task</button>
                  {candidate.targetPaths?.[0] ? (
                    <button className="ghost" onClick={() => props.onOpenReviewPath(String(candidate.targetPaths[0] || ''), 'regression')}>Open target</button>
                  ) : null}
                </div>
              </div>
            )) : null}
            {Number(regression.candidateCount || 0) === 0 ? <p className="empty-copy">Regression Builder has no fresh candidates yet.</p> : null}
          </section>
          <section className="queue-card">
            <div className="eyebrow">Runtime + benchmark stream</div>
            <EventStream tab="runtime" state={{ ...store.getState(), runtimeEvents: [...props.runtimeEvents, ...props.benchmarkEvents] }} />
          </section>
        </section>
      ) : null}

      {props.activeTab === 'learning' ? (
        <section className="settings-section">
          <div className="card-grid">
            <article className="metric-card">
              <div className="eyebrow">Journal</div>
              <strong>{shortPath(props.learningStatus?.journalPath) || 'Not configured'}</strong>
              <p>{props.learningStatus?.recentSummary?.summary || 'Learning journal is waiting for trusted changes.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Training candidates</div>
              <strong>{Number(props.learningStatus?.pendingTrainingCandidates || 0)}</strong>
              <p>Only approved or trusted outcomes should become train candidates.</p>
            </article>
          </div>
          <section className="queue-card">
            <div className="eyebrow">Learning stream</div>
            <EventStream tab="learning" state={{ ...store.getState(), learningEvents: props.learningEvents }} />
          </section>
        </section>
      ) : null}

      {props.activeTab === 'promotions' ? (
        <section className="settings-section">
          <div className="row-actions">
            <button className="ghost" onClick={props.onCreateCandidate} disabled={!selectedLabRoot}>Create candidate from active lab</button>
            {candidates.find((candidate: JsonMap) => candidate.status === 'candidate') ? (
              <button className="primary" onClick={() => props.onPromoteCandidate(String(candidates.find((candidate: JsonMap) => candidate.status === 'candidate')?.id || ''))}>
                Promote newest candidate
              </button>
            ) : null}
            {backups[0]?.id ? <button className="ghost" onClick={() => props.onRollbackLatestBackup(String(backups[0].id || ''))}>Restore last known good</button> : null}
          </div>
          <div className="card-grid">
            <article className="metric-card">
              <div className="eyebrow">Candidates</div>
              <strong>{candidates.length}</strong>
              <p>{selectedLabRoot ? `Active lab: ${shortPath(selectedLabRoot)}` : 'Select a lab to stage self-work safely.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Backups</div>
              <strong>{backups.length}</strong>
              <p>{backups[0]?.id ? `Last known good ${shortPath(backups[0].id)}` : 'No promotion backups yet.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Gate</div>
              <strong>{String(promotionGate.status || 'blocked').toUpperCase()}</strong>
              <p>{String(promotionGate.summary || 'Promotion is waiting for acceptance and verification.')}</p>
            </article>
          </div>
          <section className="queue-card">
            <div className="eyebrow">Candidate ring</div>
            {candidates.slice(0, 12).map((candidate: JsonMap) => (
              <div key={String(candidate.id)} className="run-item">
                <strong>{candidate.name || candidate.id}</strong>
                <span>{candidate.status || 'candidate'} • {candidate.verification?.source || 'manual'} • {candidate.changeSummary?.count || 0} changed path(s)</span>
                <span>{String(candidate.promotionSummary || '')}</span>
                <div className="chip-row">
                  {candidate.status === 'candidate' ? (
                    <button className="ghost" onClick={() => props.onPromoteCandidate(String(candidate.id || ''))}>Promote</button>
                  ) : null}
                  {candidate.latestBackupId ? (
                    <button className="ghost" onClick={() => props.onRollbackLatestBackup(String(candidate.latestBackupId || ''))}>Rollback</button>
                  ) : null}
                </div>
              </div>
            ))}
            {candidates.length === 0 ? <p className="empty-copy">No candidates yet. Create one from a verified lab run.</p> : null}
          </section>
          <section className="queue-card">
            <div className="eyebrow">Backup history</div>
            {backups.slice(0, 12).map((backup: JsonMap) => (
              <div key={String(backup.id)} className="run-item">
                <strong>{backup.id}</strong>
                <span>{formatStamp(backup.createdAt)} • {backup.entries?.length || 0} protected path(s) • {shortPath(backup.targetWorkspaceRoot || '') || 'live target'}</span>
                <div className="chip-row">
                  <button className="ghost" onClick={() => props.onRollbackLatestBackup(String(backup.id || ''))}>Restore this backup</button>
                </div>
              </div>
            ))}
            {backups.length === 0 ? <p className="empty-copy">No promotion backups have been created yet.</p> : null}
          </section>
          <section className="queue-card">
            <div className="eyebrow">Promotion history</div>
            {promotionHistory.slice(0, 12).map((entry: JsonMap) => (
              <div key={String(entry.id || `${entry.kind}-${entry.recordedAt}`)} className="run-item">
                <strong>{String(entry.kind || 'promotion-event')}</strong>
                <span>{formatStamp(entry.recordedAt)} • {entry.candidateId ? `candidate ${entry.candidateId}` : ''}{entry.backupId ? ` • backup ${entry.backupId}` : ''}</span>
              </div>
            ))}
            {promotionHistory.length === 0 ? <p className="empty-copy">No promotion history yet.</p> : null}
          </section>
        </section>
      ) : null}

      {props.activeTab === 'debug' ? (
        <section className="settings-section">
          <div className="card-grid">
            <article className="metric-card">
              <div className="eyebrow">Workspace</div>
              <strong>{shortPath(props.snapshot?.workspaceRoot) || 'none'}</strong>
              <p>{shortPath(props.snapshot?.targetWorkspaceRoot) || 'No target selected'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Lab</div>
              <strong>{shortPath(selectedLabRoot) || 'none'}</strong>
              <p>{selectedLabRoot ? 'Candidate and promotion actions stay scoped here first.' : 'Live workspace is selected.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Debug export</div>
              <strong>JSON bundle</strong>
              <p>Export current tasks, runs, safe-mode reasons, benchmarks, and promotion history for debugging.</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Acceptance bundle</div>
              <strong>{acceptanceState?.exists ? 'Ready' : 'Missing'}</strong>
              <p>{acceptanceState?.outputPath || 'Run npm run engine:acceptance to capture the latest self-host gate.'}</p>
            </article>
          </div>
          <section className="queue-card">
            <div className="eyebrow">Recent system events</div>
            <EventStream tab="runtime" state={{ ...store.getState(), runtimeEvents: [...props.runtimeEvents, ...props.labEvents, ...props.benchmarkEvents] }} />
          </section>
        </section>
      ) : null}
    </section>
  );
}

function InboxInspector(props: {
  snapshot: JsonMap | null;
  learningStatus: JsonMap;
  inboxItems: InboxItem[];
  onSelectPath: (path: string, source?: string) => void;
  onOpenItem: (item: InboxItem) => void;
}) {
  const changedFiles = readChangedFileItems(props.snapshot);
  const safeMode = readSafeMode(props.snapshot);

  return (
    <div className="inspector-body">
      <section className="queue-card">
        <div className="eyebrow">Unified inbox</div>
        {props.inboxItems.slice(0, 10).map((item) => (
          <div key={item.id} className={`queue-item inbox-item severity-${item.severity}`}>
            <strong>{item.title}</strong>
            <span>{item.detail}</span>
            <div className="chip-row">
              <button
                className="ghost"
                {...(item.path ? { 'data-review-path': String(item.path) } : {})}
                onClick={() => void props.onOpenItem(item)}
              >
                {item.actionLabel || (item.path ? 'Open file' : 'Open')}
              </button>
            </div>
          </div>
        ))}
        {props.inboxItems.length === 0 ? <p className="empty-copy">Inbox is clear. Approvals, warnings, and learning signals will land here.</p> : null}
      </section>

      {safeMode.active || safeMode.watchOnly ? (
        <section className="queue-card">
          <div className="eyebrow">Safety status</div>
          <div className="run-item">
            <strong>{safeMode.active ? 'Safe mode active' : 'Safety watch active'}</strong>
            <span>{String(safeMode.summary || 'Safety guardrails are monitoring this workspace.')}</span>
          </div>
        </section>
      ) : null}

      <section className="queue-card">
        <div className="eyebrow">Changed files</div>
        {changedFiles.slice(0, 10).map((item: JsonMap, index: number) => (
          <button key={`${item.path || item}-${index}`} className="queue-item" data-review-path={String(item.path || item || '')} onClick={() => props.onSelectPath(String(item.path || item || ''), 'changed')}>
            <strong>{shortPath(item.path || item)}</strong>
            <span>{item.status || 'modified'}</span>
          </button>
        ))}
        {changedFiles.length === 0 ? <p className="empty-copy">No changed files available in the review queue.</p> : null}
      </section>

      <section className="queue-card">
        <div className="eyebrow">Learning context</div>
        <div className="run-item">
          <strong>Journal</strong>
          <span>{props.learningStatus?.recentSummary?.summary || 'No recent learning summary yet.'}</span>
        </div>
      </section>
    </div>
  );
}

function FileInspector(props: {
  inspector: InspectorState;
  onChange: (value: string) => void;
  onNoteChange: (value: string) => void;
  onSave: () => void;
  onOpenInIde: () => void;
  onDecision: (decision: 'approved' | 'rejected' | 'deferred') => void;
}) {
  const hasSelection = !!props.inspector.selectedPath;
  return (
    <div className="inspector-body">
      <section className="queue-card">
        <div className="eyebrow">{props.inspector.selectedPath || 'File editor'}</div>
        <p className="empty-copy">{props.inspector.fileStatus}</p>
        <div className="file-action-bar">
          <button className="ghost" onClick={props.onOpenInIde} disabled={!hasSelection}>Open in IDE</button>
          <button className="ghost" onClick={() => props.onDecision('deferred')} disabled={!hasSelection}>Defer</button>
          <button className="ghost" onClick={() => props.onDecision('rejected')} disabled={!hasSelection}>Reject</button>
          <button className="ghost" onClick={() => props.onDecision('approved')} disabled={!hasSelection}>Approve</button>
          <button className="primary" data-save-file="true" onClick={props.onSave} disabled={!hasSelection}>Save</button>
        </div>
        <textarea
          className="code-editor"
          data-file-editor="true"
          value={props.inspector.fileContent}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder="Open a file from approvals, changed files, or chat references to edit it here."
          spellCheck={false}
        />
        <label className="review-note">
          <span>Review note</span>
          <textarea
            value={props.inspector.reviewNote}
            onChange={(event) => props.onNoteChange(event.target.value)}
            placeholder="Why this change is approved, rejected, or deferred."
          />
        </label>
      </section>
    </div>
  );
}

function TextInspector(props: { title: string; status: string; text: string }) {
  return (
    <div className="inspector-body">
      <section className="queue-card">
        <div className="eyebrow">{props.title}</div>
        <p className="empty-copy">{props.status}</p>
        <pre className="code-block">{props.text || 'Nothing loaded yet.'}</pre>
      </section>
    </div>
  );
}

function LearningInspector(props: { snapshot: JsonMap | null; learningStatus: JsonMap }) {
  const manager = props.snapshot?.manager || {};
  const prompts = Array.isArray(props.learningStatus?.reusablePrompts) ? props.learningStatus.reusablePrompts : [];
  return (
    <div className="inspector-body">
      <section className="queue-card">
        <div className="eyebrow">Learning state</div>
        <div className="run-item"><strong>Record</strong><span>{manager.learningRecord?.summary || 'No supervised learning record captured yet.'}</span></div>
        <div className="run-item"><strong>Training handoff</strong><span>{manager.trainingHandoffArtifact?.summary || 'No training handoff prepared yet.'}</span></div>
        <div className="run-item"><strong>Journal</strong><span>{props.learningStatus?.recentSummary?.summary || 'No change journal summary yet.'}</span></div>
        <div className="run-item"><strong>Training</strong><span>{props.learningStatus?.trainingReadiness?.summary || 'Training is idle.'}</span></div>
        <div className="run-item"><strong>Style</strong><span>{props.learningStatus?.styleProfile?.summary || 'No naming profile yet.'}</span></div>
        {prompts.slice(0, 2).map((item: JsonMap, index: number) => (
          <div key={`${item.prompt || index}`} className="run-item">
            <strong>Prompt</strong>
            <span>{String(item.prompt || '').trim()}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

function EventStream(props: { tab: AppState['activeBottomTab']; state: AppState }) {
  const items = props.tab === 'runtime'
    ? props.state.runtimeEvents
    : props.tab === 'learning'
      ? props.state.learningEvents
      : props.tab === 'labs'
        ? props.state.labEvents
        : props.state.benchmarkEvents;

  return (
    <div className="event-stream" data-event-stream={props.tab}>
      {items.slice(0, 18).map((item, index) => (
        <div key={`${item.timestamp || item.recordedAt || index}-${item.type || item.state || 'event'}`} className="run-item">
          <strong>{item.type || item.state || 'event'}</strong>
          <span>{formatStamp(item.timestamp || item.recordedAt)} • {summarizeText(item.message || item.label || item.summary || '')}</span>
        </div>
      ))}
      {items.length === 0 ? <p className="empty-copy">No events in this stream yet.</p> : null}
    </div>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Renderer root element was not found.');
}

createRoot(rootElement).render(<App />);
