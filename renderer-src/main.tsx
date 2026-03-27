import React, { useEffect, useEffectEvent } from 'react';
import { createRoot } from 'react-dom/client';

import { AI_ROUTE_COPY, buildLocalModelProgram, localModelProgramStatusLabel } from './lib/ai-route-copy';
import { shortPath, formatStamp, summarizeText, makeId } from './lib/format';
import { createStore, useStoreValue } from './lib/store';
import type { AssistantChatEvent, AssistantChatProgress, ChatMessage, ChatThread, InspectorState, JsonMap } from './lib/types';

const THREADS_KEY = 'gosenderr.desktop.workbench.threads.v3';
const ACTIVE_THREAD_KEY = 'gosenderr.desktop.workbench.active-thread.v3';
const IDE_PANEL_PROMPT = 'Open Workbench IDE tools.';
const SETTINGS_TABS = ['general', 'workspace', 'ai', 'tunepod', 'autonomy', 'skills', 'extensions', 'tools', 'automations', 'labs', 'learning', 'storage'] as const;
const MONITOR_TABS = ['overview', 'runs', 'learning', 'promotions', 'debug', 'ide'] as const;
const INSPECTOR_TABS = ['manager', 'inbox', 'file', 'diff', 'learning'] as const;
type SettingsTabId = typeof SETTINGS_TABS[number];
type MonitorTabId = typeof MONITOR_TABS[number];
type InspectorTabId = typeof INSPECTOR_TABS[number];
type UiIconName = 'plus' | 'agents' | 'spaces' | 'spark' | 'mode' | 'repo' | 'issue' | 'git' | 'pull-request' | 'session' | 'terminal';
type QuickPromptAction = {
  label: string;
  action: 'chat' | 'tunepod' | 'ide';
};

const INSPECTOR_TAB_LABELS: Record<InspectorTabId, string> = {
  manager: 'Context',
  inbox: 'Inbox',
  file: 'File',
  diff: 'Diff',
  learning: 'Learning',
};

const SETTINGS_NAV_GROUPS = [
  { id: 'system', label: 'System', tabs: ['general', 'workspace', 'storage'] as SettingsTabId[] },
  { id: 'intelligence', label: 'Intelligence', tabs: ['ai', 'autonomy', 'skills', 'tools'] as SettingsTabId[] },
  { id: 'operations', label: 'Operations', tabs: ['extensions', 'automations', 'labs', 'learning'] as SettingsTabId[] },
] as const;

const SETTINGS_TAB_META: Record<SettingsTabId, {
  navLabel: string;
  title: string;
  eyebrow: string;
  description: string;
  icon: UiIconName;
}> = {
  general: {
    navLabel: 'System',
    title: 'Desktop system controls',
    eyebrow: 'Shell + updates',
    description: 'Theme, chat defaults, instruction shaping, and updater controls stay here so the main chat surface can stay focused on work.',
    icon: 'mode',
  },
  workspace: {
    navLabel: 'Workspace',
    title: 'Workspace targeting',
    eyebrow: 'Roots + editor alignment',
    description: 'Choose the active workspace, confirm the current target, and keep the VS Code companion aligned with the desktop shell.',
    icon: 'repo',
  },
  ai: {
    navLabel: 'AI routing',
    title: 'AI routing and model selection',
    eyebrow: 'Profiles + providers',
    description: AI_ROUTE_COPY.settingsTabDescription,
    icon: 'spark',
  },
  tunepod: {
    navLabel: 'Tune Pod',
    title: 'Tune Pod',
    eyebrow: 'Machine fit + model setup',
    description: 'See what this machine can run, which local models are ready, and what setup step comes next.',
    icon: 'spark',
  },
  autonomy: {
    navLabel: 'Autonomy',
    title: 'Autonomy and safety policy',
    eyebrow: 'Guardrails + retries',
    description: 'Tune how far the engine can go on its own, how often it retries, and which actions still require supervision.',
    icon: 'agents',
  },
  skills: {
    navLabel: 'Skills',
    title: 'Local skills library',
    eyebrow: 'Reusable expertise',
    description: 'Review the installed skill catalog and open individual skills when you want to inspect or refine the packaged guidance.',
    icon: 'session',
  },
  extensions: {
    navLabel: 'Extensions',
    title: 'Integration studio',
    eyebrow: 'Plugins + adapters',
    description: 'Track starter integrations, installed items, and rollback archives without scattering extension management across other panels.',
    icon: 'pull-request',
  },
  tools: {
    navLabel: 'Tools',
    title: 'Tool catalog',
    eyebrow: 'Capabilities + safety',
    description: 'See which tools are exposed to the engine and how each one is classified before you widen or tighten the operational surface.',
    icon: 'git',
  },
  automations: {
    navLabel: 'Automations',
    title: 'Automation queue',
    eyebrow: 'Jobs + schedules',
    description: 'Keep recurring jobs and autopilot-style actions grouped here so scheduled work does not clutter the interactive workflow.',
    icon: 'plus',
  },
  labs: {
    navLabel: 'Labs',
    title: 'Lab management',
    eyebrow: 'Scratch spaces',
    description: 'Create disposable labs, broken proof targets, and mirrors from the same surface you use to manage the rest of the system.',
    icon: 'spaces',
  },
  learning: {
    navLabel: 'Learning',
    title: 'Learning loop',
    eyebrow: 'Journal + carry-forward',
    description: 'Capture approved lessons, inspect the current learning state, and export the journal without leaving the unified settings surface.',
    icon: 'issue',
  },
  storage: {
    navLabel: 'Diagnostics',
    title: 'Storage and diagnostics roots',
    eyebrow: 'Paths + persistence',
    description: 'Keep the durable storage locations explicit so runs, labs, journals, and rollback artifacts never drift to the wrong place.',
    icon: 'repo',
  },
};

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
  activeInspectorTab: InspectorTabId;
  activeBottomTab: 'runtime' | 'learning' | 'labs' | 'benchmarks';
  threads: ChatThread[];
  activeThreadId: string;
  threadReadMarkers: Record<string, string>;
  composerText: string;
  pendingAttachments: JsonMap[];
  busyChat: boolean;
  activeChatRequestId: string;
  activeChatThreadId: string;
  activeChatMessageId: string;
  liveChatProgress: AssistantChatProgress | null;
  busyBinaryUpdate: boolean;
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
  activeChatRequestId: '',
  activeChatThreadId: '',
  activeChatMessageId: '',
  liveChatProgress: null,
  busyBinaryUpdate: false,
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

function upsertThreadMessage(messages: ChatMessage[], nextMessage: ChatMessage) {
  const messageIndex = messages.findIndex((message) => message.id === nextMessage.id);
  if (messageIndex === -1) {
    return [...messages, nextMessage];
  }
  return messages.map((message) => (message.id === nextMessage.id ? { ...message, ...nextMessage } : message));
}

function updateThreadMessages(
  threads: ChatThread[],
  threadId: string,
  updater: (messages: ChatMessage[]) => ChatMessage[],
  updatedAt: string,
) {
  return threads.map((thread) => (thread.id === threadId
    ? { ...thread, updatedAt, messages: updater(thread.messages) }
    : thread));
}

type InboxItem = {
  id: string;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  detail: string;
  path?: string;
  source?: string;
  openModule?: 'monitor' | 'settings' | 'workbench';
  targetTab?: InspectorTabId | MonitorTabId;
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

function UiIcon(props: { name: UiIconName; className?: string }) {
  const classes = `ui-icon ${props.className || ''}`.trim();
  switch (props.name) {
    case 'plus':
      return <svg className={classes} viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.25v9.5M3.25 8h9.5" /></svg>;
    case 'agents':
      return <svg className={classes} viewBox="0 0 16 16" aria-hidden="true"><path d="M5 4.25h6a2 2 0 0 1 2 2v3.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3.5a2 2 0 0 1 2-2Zm1-1.5h4M6 7.5h.01M10 7.5h.01M5.75 10c.7-.55 1.45-.85 2.25-.85s1.55.3 2.25.85" /></svg>;
    case 'spaces':
      return <svg className={classes} viewBox="0 0 16 16" aria-hidden="true"><path d="M4.75 3.25h6.5a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5h-6.5a1.5 1.5 0 0 1-1.5-1.5v-6.5a1.5 1.5 0 0 1 1.5-1.5ZM5 5.5h6" /></svg>;
    case 'spark':
      return <svg className={classes} viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.75 9.45 6.55 13.25 8 9.45 9.45 8 13.25 6.55 9.45 2.75 8 6.55 6.55Z" /></svg>;
    case 'mode':
      return <svg className={classes} viewBox="0 0 16 16" aria-hidden="true"><path d="M3.25 4.5h9.5M3.25 8h9.5M3.25 11.5h6.25" /></svg>;
    case 'repo':
      return <svg className={classes} viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.25h5.75a2 2 0 0 1 2 2v5.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5.5a2 2 0 0 1 2-2Zm0 0v9.5M5.25 5.5h4" /></svg>;
    case 'issue':
      return <svg className={classes} viewBox="0 0 16 16" aria-hidden="true"><path d="M8 4.5v4M8 11.25h.01M4.75 3.25h6.5a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5h-6.5a1.5 1.5 0 0 1-1.5-1.5v-6.5a1.5 1.5 0 0 1 1.5-1.5Z" /></svg>;
    case 'git':
      return <svg className={classes} viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.75a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm0 0V11a2 2 0 0 0 2 2h2M11 4a1.25 1.25 0 1 0 0 2.5A1.25 1.25 0 0 0 11 4Zm0 0v7.5" /></svg>;
    case 'pull-request':
      return <svg className={classes} viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.75a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm0 0v8.5m6-8.5a1.25 1.25 0 1 0 0 2.5A1.25 1.25 0 0 0 11 3.75Zm0 0V8a3 3 0 0 1-3 3H6.25" /></svg>;
    case 'terminal':
      return <svg className={classes} viewBox="0 0 16 16" aria-hidden="true"><path d="M3.25 4.25h9.5a1.5 1.5 0 0 1 1.5 1.5v4.5a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5v-4.5a1.5 1.5 0 0 1 1.5-1.5Zm1.5 2 1.75 1.75-1.75 1.75M8.25 10h2.75" /></svg>;
    case 'session':
    default:
      return <svg className={classes} viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4.75h8M4 8h8M4 11.25h5.5" /></svg>;
  }
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

function renderChatInlineText(value: string, keyPrefix: string) {
  return String(value || '').split('\n').map((line, index) => (
    <React.Fragment key={`${keyPrefix}-${index}`}>
      {index > 0 ? <br /> : null}
      {line}
    </React.Fragment>
  ));
}

function renderChatMessageBody(text: string, keyPrefix: string) {
  const blocks = String(text || '')
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (blocks.length === 0) {
    return null;
  }
  return (
    <div className="chat-message-body">
      {blocks.map((block, blockIndex) => {
        const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
        if (lines.length > 0 && lines.every((line) => /^[-*]\s+/.test(line))) {
          return (
            <ul key={`${keyPrefix}-ul-${blockIndex}`}>
              {lines.map((line, itemIndex) => (
                <li key={`${keyPrefix}-ul-${blockIndex}-${itemIndex}`}>
                  {renderChatInlineText(line.replace(/^[-*]\s+/, ''), `${keyPrefix}-ul-${blockIndex}-${itemIndex}`)}
                </li>
              ))}
            </ul>
          );
        }
        if (lines.length > 0 && lines.every((line) => /^\d+\.\s+/.test(line))) {
          return (
            <ol key={`${keyPrefix}-ol-${blockIndex}`}>
              {lines.map((line, itemIndex) => (
                <li key={`${keyPrefix}-ol-${blockIndex}-${itemIndex}`}>
                  {renderChatInlineText(line.replace(/^\d+\.\s+/, ''), `${keyPrefix}-ol-${blockIndex}-${itemIndex}`)}
                </li>
              ))}
            </ol>
          );
        }
        return <p key={`${keyPrefix}-p-${blockIndex}`}>{renderChatInlineText(block, `${keyPrefix}-p-${blockIndex}`)}</p>;
      })}
    </div>
  );
}

function buildAssistantProgressState(input: { busyChat: boolean; activeTaskRun: JsonMap | null; chatProgress: AssistantChatProgress | null }) {
  if (input.activeTaskRun) {
    const runLabel = String(
      input.activeTaskRun.runtimeLabel
      || input.activeTaskRun.label
      || input.activeTaskRun.title
      || input.activeTaskRun.task
      || 'Current task',
    ).trim() || 'Current task';
    const runState = String(
      input.activeTaskRun.runtimeState
      || input.activeTaskRun.state
      || input.activeTaskRun.status
      || 'running',
    ).trim().toLowerCase().replace(/_/g, ' ');
    return {
      title: `Working on ${runLabel}`,
      detail: `${runLabel} is ${runState || 'running'}. Chat keeps the summary here while Workbench holds files, diffs, and validation.`,
      showWorkbenchAction: true,
    };
  }
  if (input.chatProgress && input.busyChat) {
    return {
      title: String(input.chatProgress.title || 'Reviewing the workspace'),
      detail: String(input.chatProgress.detail || 'Checking the current repo context before drafting the reply.'),
      showWorkbenchAction: false,
    };
  }
  if (input.busyChat) {
    return {
      title: 'Reviewing the workspace',
      detail: 'Checking the current repo context before drafting the reply.',
      showWorkbenchAction: false,
    };
  }
  return null;
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
      detail: String(reviewer.summary || reviewer.nextAction || 'Open Workbench to inspect the Test Bench review results.'),
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
      detail: String(regression.summary || 'Open Workbench to turn the latest fix into replayable coverage.'),
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
      actionLabel: 'Open Workbench',
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
      detail: String(acceptance?.summary || acceptance?.nextAction || 'Open Workbench to review the latest engine acceptance report.'),
      openModule: 'monitor',
      targetTab: 'overview',
      actionLabel: 'Open Workbench',
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
  tunePodPrompt?: string;
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
  const tunePodPrompt = String(input.tunePodPrompt || '').trim();

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
    if (tunePodPrompt) {
      pushUniqueSuggestion(suggestions, tunePodPrompt);
    }
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

  if (tunePodPrompt && /(local|model|ollama|route|routing|proof|benchmark|acceptance|fit|gpu|vram|ram|hardware|tunepod|tune pod)/.test(lower)) {
    pushUniqueSuggestion(suggestions, tunePodPrompt);
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
    pushUniqueSuggestion(suggestions, IDE_PANEL_PROMPT);
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
    pushUniqueSuggestion(suggestions, AI_ROUTE_COPY.modelSetupPrompt);
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

function mergeUpdateSnapshot(snapshot: JsonMap | null, payload: JsonMap) {
  if (!snapshot || !payload || typeof payload !== 'object') {
    return snapshot;
  }
  const currentUpdates = snapshot.updates && typeof snapshot.updates === 'object' ? snapshot.updates : {};
  const currentBinary = currentUpdates.binary && typeof currentUpdates.binary === 'object' ? currentUpdates.binary : {};
  const nextBinary = payload.binary && typeof payload.binary === 'object'
    ? { ...currentBinary, ...payload.binary }
    : currentBinary;
  return {
    ...snapshot,
    updates: {
      ...currentUpdates,
      ...payload,
      ...(payload.binary && typeof payload.binary === 'object' ? { binary: nextBinary } : {}),
    },
  };
}

function mergeBinaryUpdateSnapshot(snapshot: JsonMap | null, payload: JsonMap) {
  if (!snapshot || !payload || typeof payload !== 'object') {
    return snapshot;
  }
  const interestingKeys = [
    'state',
    'message',
    'downloaded',
    'availableVersion',
    'progressPercent',
    'localArtifactPath',
    'localReleaseDir',
    'feedUrl',
    'configured',
    'autoDownload',
    'version',
    'localStaged',
    'liveVersion',
  ];
  if (!interestingKeys.some((key) => payload[key] !== undefined)) {
    return snapshot;
  }
  return mergeUpdateSnapshot(snapshot, { binary: payload });
}

function isLocalProvider(value: any) {
  const provider = String(value || '').trim().toLowerCase();
  return provider === 'ollama' || provider === 'local';
}

function buildLocalModelProgramView(snapshot: JsonMap | null, aiStatus: JsonMap | null, tuning: JsonMap | null) {
  const settings = snapshot?.settings || {};
  const localModels = readAiModelOptions(aiStatus, tuning, settings)
    .filter((option) => option.ready && isLocalProvider(option.provider));
  const currentProvider = String(aiStatus?.current?.provider || settings.runtime || 'ollama').trim().toLowerCase();
  const currentRuntime = String(settings.runtime || currentProvider || 'ollama').trim().toLowerCase();
  const routePolicy = String(settings.aiRoutingPolicy || settings.aiProfile || '').trim().toLowerCase();
  const laneOverrides = normalizeLaneOverrides(settings.aiLaneOverrides || aiStatus?.current?.laneOverrides || {});
  const benchmarkSummary = Array.isArray(aiStatus?.benchmarkSummary) ? aiStatus.benchmarkSummary : [];
  const benchmarkLeader = benchmarkSummary[0] || {};
  const benchmarkLeaderIsLocal = isLocalProvider(benchmarkLeader.providerSource || benchmarkLeader.provider || currentProvider);
  const localCodingProof = aiStatus?.localCodingProof && typeof aiStatus.localCodingProof === 'object'
    ? aiStatus.localCodingProof
    : (aiStatus?.gsDev1?.localCodingProof && typeof aiStatus.gsDev1.localCodingProof === 'object'
      ? aiStatus.gsDev1.localCodingProof
      : null);
  const acceptance = snapshot?.acceptance?.report && typeof snapshot.acceptance.report === 'object'
    ? snapshot.acceptance.report
    : {};
  const acceptanceStatus = String(acceptance.overallStatus || '').trim().toLowerCase();
  const promotions = snapshot?.promotions && typeof snapshot.promotions === 'object' ? snapshot.promotions : {};
  const candidates = Array.isArray(promotions.candidates) ? promotions.candidates : [];
  const promotedCandidates = candidates.filter((candidate: JsonMap) => ['promoted', 'live'].includes(String(candidate.status || '').trim().toLowerCase()));
  const modelFoundry = snapshot?.modelFoundry && typeof snapshot.modelFoundry === 'object' ? snapshot.modelFoundry : {};
  const safeMode = readSafeMode(snapshot);
  const remoteFallbackReady = Boolean(String(settings.aiRemoteModel || aiStatus?.current?.remoteModel || '').trim());
  const activeLaneOverrideCount = Object.keys(laneOverrides).length;
  const localRuntimeReady = ['ollama', 'local', 'hybrid'].includes(currentRuntime) || ['ollama', 'local', 'hybrid'].includes(currentProvider);
  return buildLocalModelProgram({
    localModelCount: localModels.length,
    localRuntimeReady,
    routePolicy,
    activeRouteOverrideCount: activeLaneOverrideCount,
    localCodingProofSummary: String(localCodingProof?.summary || '').trim(),
    acceptanceStatus,
    benchmarkSummaryCount: benchmarkSummary.length,
    benchmarkLeaderIsLocal,
    promotedCandidateCount: promotedCandidates.length,
    candidateCount: candidates.length,
    modelFoundryCandidateCount: Number(modelFoundry.candidateCount || 0),
    remoteFallbackReady,
    safeModeActive: safeMode.active === true,
  });
}

function readPositiveNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function readTunePodCapabilities(target: JsonMap | null, machineProfile: JsonMap | null, fallbackTarget: JsonMap | null = null) {
  const targetCapabilities = target?.capabilities && typeof target.capabilities === 'object'
    ? target.capabilities
    : (fallbackTarget?.capabilities && typeof fallbackTarget.capabilities === 'object' ? fallbackTarget.capabilities : {});
  return {
    systemRamGb: readPositiveNumber(machineProfile?.totalMemoryGiB) || readPositiveNumber(targetCapabilities?.systemRamGb),
    cpuThreads: readPositiveNumber(machineProfile?.cpuCount) || readPositiveNumber(targetCapabilities?.cpuThreads),
    gpuVramGb: readPositiveNumber(machineProfile?.gpuVramGb) || readPositiveNumber(targetCapabilities?.gpuVramGb),
    dedicatedGpu: typeof machineProfile?.hasDedicatedGpu === 'boolean'
      ? machineProfile.hasDedicatedGpu === true
      : (typeof targetCapabilities?.dedicatedGpu === 'boolean' ? targetCapabilities.dedicatedGpu === true : null),
  };
}

function evaluateTunePodRequirementFit(
  preset: JsonMap | null,
  capabilities: { systemRamGb: number | null; cpuThreads: number | null; gpuVramGb: number | null; dedicatedGpu: boolean | null },
) {
  const requirements = preset?.requirements && typeof preset.requirements === 'object' ? preset.requirements : {};
  const blockers: string[] = [];
  if (Number(requirements.minimumSystemRamGb || 0) > 0 && capabilities.systemRamGb !== null && capabilities.systemRamGb < Number(requirements.minimumSystemRamGb)) {
    blockers.push(`${Number(requirements.minimumSystemRamGb)} GB RAM minimum`);
  }
  if (Number(requirements.minimumCpuThreads || 0) > 0 && capabilities.cpuThreads !== null && capabilities.cpuThreads < Number(requirements.minimumCpuThreads)) {
    blockers.push(`${Number(requirements.minimumCpuThreads)} CPU threads minimum`);
  }
  if (requirements.requiresDedicatedGpu === true && capabilities.dedicatedGpu === false) {
    blockers.push('dedicated GPU required');
  }
  if (Number(requirements.minimumGpuVramGb || 0) > 0 && capabilities.gpuVramGb !== null && capabilities.gpuVramGb < Number(requirements.minimumGpuVramGb)) {
    blockers.push(`${Number(requirements.minimumGpuVramGb)} GB VRAM minimum`);
  }
  return {
    fits: blockers.length === 0,
    blockers,
  };
}

function buildTunePodGuidance(snapshot: JsonMap | null, aiStatus: JsonMap | null, tuning: JsonMap | null) {
  const settings = snapshot?.settings || {};
  const targetHardwareOptions = Array.isArray(tuning?.hardwareTargets) ? tuning.hardwareTargets : [];
  const installPresets = Array.isArray(tuning?.installPresets) ? tuning.installPresets : [];
  const selectedHardwareTarget = String(settings.trainingHardwareTarget || tuning?.settings?.trainingHardwareTarget || 'auto');
  const machineProfile = tuning?.telemetry?.machine && typeof tuning.telemetry.machine === 'object' ? tuning.telemetry.machine : {};
  const selectedTarget = targetHardwareOptions.find((item: JsonMap) => String(item?.id || '') === selectedHardwareTarget) || null;
  const fallbackTarget = targetHardwareOptions.find((item: JsonMap) => String(item?.id || '') === String(machineProfile.id || '')) || null;
  const capabilities = readTunePodCapabilities(selectedTarget, machineProfile, fallbackTarget);
  const compatiblePresets = installPresets.filter((preset: JsonMap) => evaluateTunePodRequirementFit(preset, capabilities).fits);
  const localModelProgram = buildLocalModelProgramView(snapshot, aiStatus, tuning);
  const nextLayerId = String(localModelProgram.nextLayer?.id || '').trim().toLowerCase();
  const fitBlocked = nextLayerId === 'foundation' || compatiblePresets.length === 0;
  const routeProofBlocked = ['routing', 'coding'].includes(nextLayerId);
  if (!fitBlocked && !routeProofBlocked) {
    return {
      blocked: false,
      prompt: '',
      reason: '',
    };
  }
  return {
    blocked: true,
    prompt: fitBlocked ? AI_ROUTE_COPY.tunePodFitPrompt : AI_ROUTE_COPY.tunePodRoutePrompt,
    reason: fitBlocked
      ? 'Tune Pod has the machine-fit and compatible-model view for the current blocker.'
      : 'Tune Pod has the local-first route proof ladder for the current blocker.',
  };
}

function App() {
  const state = useStoreValue(store);
  const reportRendererError = window.gosAgent.reportRendererError;
  void reportRendererError;
  const handbookPath = 'docs/BAT_FEATURE_BOARD.md';
  const thread = activeThread(state);
  const threadIsFresh = !Array.isArray(thread?.messages) || !thread.messages.some((message) => message.role !== 'system');
  const status = shellStatus(state.snapshot);
  const safeMode = readSafeMode(state.snapshot);
  const updates = state.snapshot?.updates && typeof state.snapshot.updates === 'object' ? state.snapshot.updates : {};
  const binaryUpdates = updates.binary && typeof updates.binary === 'object' ? updates.binary : {};
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
  const binaryUpdateState = String(binaryUpdates.state || '').trim().toLowerCase();
  const binaryUpdateProgress = Math.round(Number(binaryUpdates.progressPercent || 0));
  const binaryUpdateReadyToInstall = Boolean(binaryUpdates.downloaded) || String(binaryUpdates.localArtifactPath || '').trim().length > 0;
  const binaryUpdateCanDownload = binaryUpdateState === 'available' && !binaryUpdateReadyToInstall;
  const binaryUpdateInstallLabel = String(binaryUpdates.localArtifactPath || '').trim() ? 'Open installer' : 'Install update';
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
      store.update((current) => ({
        ...current,
        busyBinaryUpdate: payload?.binary?.state
          ? ['checking', 'downloading', 'installing'].includes(String(payload.binary.state || '').toLowerCase())
          : current.busyBinaryUpdate,
        snapshot: mergeUpdateSnapshot(current.snapshot, payload),
      }));
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
    const offAssistantChat = window.gosAgent.onAssistantChatEvent((payload) => {
      const event = payload as AssistantChatEvent;
      store.update((current) => {
        const requestId = String(event?.requestId || '').trim();
        if (!requestId || requestId !== current.activeChatRequestId || !current.activeChatThreadId || !current.activeChatMessageId) {
          return current;
        }
        const eventAt = String(event?.createdAt || new Date().toISOString());
        const activeThread = current.threads.find((thread) => thread.id === current.activeChatThreadId) || null;
        const activeMessage = activeThread?.messages.find((message) => message.id === current.activeChatMessageId) || null;
        const hasStartedReply = String(activeMessage?.text || '').length > 0;
        if (event.type === 'progress') {
          if (hasStartedReply) {
            return current;
          }
          return {
            ...current,
            liveChatProgress: {
              requestId,
              title: String(event.title || 'Reviewing the workspace'),
              detail: String(event.detail || 'Checking the current repo context before drafting the reply.'),
              createdAt: eventAt,
            },
          };
        }
        if (event.type === 'reply-delta') {
          const delta = String(event.delta || '');
          if (!delta) {
            return current;
          }
          return {
            ...current,
            liveChatProgress: null,
            threads: updateThreadMessages(
              current.threads,
              current.activeChatThreadId,
              (messages) => messages.map((message) => (message.id === current.activeChatMessageId
                ? { ...message, text: `${message.text || ''}${delta}` }
                : message)),
              eventAt,
            ),
          };
        }
        if (event.type === 'complete') {
          return {
            ...current,
            liveChatProgress: null,
          };
        }
        if (event.type === 'error') {
          return {
            ...current,
            liveChatProgress: {
              requestId,
              title: 'Reply interrupted',
              detail: String(event.message || 'The assistant could not finish the reply.'),
              createdAt: eventAt,
            },
          };
        }
        return current;
      });
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
      offAssistantChat();
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
    const requestId = makeId('chatreq');
    const assistantMessageId = makeId('msg');
    const assistantPlaceholder: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      text: '',
      createdAt,
    };
    store.update((current) => ({
      ...current,
      busyChat: true,
      activeChatRequestId: requestId,
      activeChatThreadId: currentThread.id,
      activeChatMessageId: assistantMessageId,
      liveChatProgress: {
        requestId,
        title: 'Reviewing the workspace',
        detail: 'Checking the current repo context before drafting the reply.',
        createdAt,
      },
      composerText: '',
      pendingAttachments: [],
      error: '',
      threads: updateThreadMessages(current.threads, currentThread.id, (messages) => [...messages, userMessage, assistantPlaceholder], createdAt),
    }));

    try {
      const reply = await window.gosAgent.chatMessage(text, snapshot.targetWorkspaceRoot || snapshot.workspaceRoot, {
        requestId,
        workspaceRoot: snapshot.workspaceRoot,
        targetWorkspaceRoot: snapshot.targetWorkspaceRoot,
        labRoot: snapshot.selectedLabRoot || '',
        threadId: currentThread.id,
        changeSessionId: currentThread.changeSessionId,
        history: currentThread.messages.slice(-8).map((entry) => ({ role: entry.role, text: entry.text })),
        attachments,
        chatContext: {
          activeView: store.getState().activeModuleId,
          chatMode: store.getState().snapshot?.settings?.chatMode || 'auto',
          activeFile: store.getState().inspector.selectedPath,
          changedFiles: changedItems.length,
          approvalCount: approvalItems.length,
          activeRunId: snapshot.recentRuns?.[0]?.runId || snapshot.taskHub?.runs?.[0]?.runId || '',
          activeRunLabel: snapshot.recentRuns?.[0]?.label || '',
          worktree: snapshot.worktree?.scopeLabel || '',
          modelProvisioning: store.getState().aiStatus?.provisioning || {},
        },
      });

      const completedAt = new Date().toISOString();

      store.update((current) => ({
        ...current,
        busyChat: false,
        activeChatRequestId: current.activeChatRequestId === requestId ? '' : current.activeChatRequestId,
        activeChatThreadId: current.activeChatRequestId === requestId ? '' : current.activeChatThreadId,
        activeChatMessageId: current.activeChatRequestId === requestId ? '' : current.activeChatMessageId,
        liveChatProgress: current.activeChatRequestId === requestId ? null : current.liveChatProgress,
        threads: updateThreadMessages(current.threads, currentThread.id, (messages) => {
          const existingMessage = messages.find((message) => message.id === assistantMessageId) || null;
          const nextMessage: ChatMessage = {
            id: assistantMessageId,
            role: 'assistant',
            text: String(reply?.reply || reply?.message || '').trim() || String(existingMessage?.text || '').trim() || 'No response.',
            createdAt: completedAt,
            suggestions: Array.isArray(reply?.suggestions) ? reply.suggestions : [],
            refs: Array.isArray(reply?.refs) ? reply.refs : [],
          };
          return upsertThreadMessage(messages, nextMessage);
        }, completedAt),
        threadReadMarkers: current.activeModuleId === 'workbench'
          ? {
            ...current.threadReadMarkers,
            [currentThread.id]: assistantMessageId,
          }
          : current.threadReadMarkers,
      }));

      if (reply?.refs?.[0]?.path) {
        void onLoadInspectorPath(String(reply.refs[0].path || ''), 'chat-ref');
      }
      await refreshApp('lite');
    } catch (error) {
      const failureMessage: ChatMessage = {
        id: assistantMessageId,
        role: 'assistant',
        text: error instanceof Error ? error.message : 'Chat failed.',
        createdAt: new Date().toISOString(),
      };
      store.update((current) => ({
        ...current,
        busyChat: false,
        activeChatRequestId: current.activeChatRequestId === requestId ? '' : current.activeChatRequestId,
        activeChatThreadId: current.activeChatRequestId === requestId ? '' : current.activeChatThreadId,
        activeChatMessageId: current.activeChatRequestId === requestId ? '' : current.activeChatMessageId,
        liveChatProgress: current.activeChatRequestId === requestId ? null : current.liveChatProgress,
        error: failureMessage.text,
        threads: updateThreadMessages(current.threads, currentThread.id, (messages) => upsertThreadMessage(messages, failureMessage), failureMessage.createdAt),
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
    if (command === IDE_PANEL_PROMPT) {
      onOpenIdeModule();
      return;
    }
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

  const onOpenTunePod = () => {
    store.update((current) => ({
      ...current,
      activeModuleId: 'tunepod',
      activeSettingsTab: 'tunepod',
      chatFocused: false,
    }));
    void refreshApp('lite');
  };

  const onOpenIdeModule = () => {
    onOpenMonitorTab('ide');
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
    if (tab === 'tunepod') {
      onOpenTunePod();
      return;
    }
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

  const onBootstrapWorkspaceVsCode = async () => {
    const snapshot = store.getState().snapshot;
    if (!snapshot) {
      return;
    }
    const result = await window.gosAgent.bootstrapWorkspaceVsCode({
      workspaceRoot: snapshot.workspaceRoot,
      targetWorkspaceRoot: snapshot.targetWorkspaceRoot,
      labRoot: snapshot.selectedLabRoot || '',
    });
    store.update((current) => ({
      ...current,
      error: result?.ok ? '' : String(result?.message || 'Unable to bootstrap VS Code for this workspace.'),
    }));
    await refreshApp('full');
  };

  const onInstallVsCodeCompanion = async () => {
    const snapshot = store.getState().snapshot;
    if (!snapshot) {
      return;
    }
    const result = await window.gosAgent.installWorkspaceVsCodeCompanion({
      workspaceRoot: snapshot.workspaceRoot,
      targetWorkspaceRoot: snapshot.targetWorkspaceRoot,
      labRoot: snapshot.selectedLabRoot || '',
    });
    store.update((current) => ({
      ...current,
      error: result?.ok ? '' : String(result?.message || 'Unable to install the VS Code companion.'),
    }));
    await refreshApp('full');
  };

  const onOpenWorkspaceInVsCode = async () => {
    const snapshot = store.getState().snapshot;
    if (!snapshot) {
      return;
    }
    const result = await window.gosAgent.openWorkspaceInVsCode({
      workspaceRoot: snapshot.workspaceRoot,
      targetWorkspaceRoot: snapshot.targetWorkspaceRoot,
      labRoot: snapshot.selectedLabRoot || '',
    });
    store.update((current) => ({
      ...current,
      error: result?.ok ? '' : String(result?.message || 'Unable to open the current workspace in VS Code.'),
    }));
  };

  const onOpenActiveEditorFileInVsCode = async () => {
    const snapshot = store.getState().snapshot;
    const activeFilePath = String(snapshot?.editorContext?.active_file_path || '').trim();
    if (!snapshot || !activeFilePath) {
      return;
    }
    const result = await window.gosAgent.openInVsCode({
      workspaceRoot: snapshot.workspaceRoot,
      targetWorkspaceRoot: snapshot.targetWorkspaceRoot,
      labRoot: snapshot.selectedLabRoot || '',
      path: activeFilePath,
      line: Number(snapshot?.editorContext?.selection_start_line || 1),
    });
    store.update((current) => ({
      ...current,
      error: result?.ok ? '' : String(result?.message || 'Unable to open the active file in VS Code.'),
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
    const inspectorTab = INSPECTOR_TABS.includes(item.targetTab as InspectorTabId)
      ? (item.targetTab as InspectorTabId)
      : 'inbox';
    store.update((current) => ({
      ...current,
      rightRailOpen: true,
      activeInspectorTab: inspectorTab,
    }));
  };

  const onToggleManagerInspector = () => {
    store.update((current) => {
      const isOpen = current.rightRailOpen && current.activeInspectorTab === 'manager';
      return {
        ...current,
        rightRailOpen: !isOpen,
        activeInspectorTab: 'manager',
      };
    });
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

  const onCheckBinaryUpdate = async () => {
    store.update((current) => ({
      ...current,
      busyBinaryUpdate: true,
      error: '',
    }));
    try {
      const result = await window.gosAgent.checkBinaryUpdates();
      store.update((current) => ({
        ...current,
        busyBinaryUpdate: false,
        error: result?.ok === false ? String(result?.message || 'Unable to check for desktop updates.') : '',
        snapshot: mergeBinaryUpdateSnapshot(current.snapshot, result),
      }));
      if (result?.ok !== false) {
        await refreshApp('lite');
      }
    } catch (error) {
      store.update((current) => ({
        ...current,
        busyBinaryUpdate: false,
        error: error instanceof Error ? error.message : 'Unable to check for desktop updates.',
      }));
    }
  };

  const onDownloadBinaryUpdate = async () => {
    store.update((current) => ({
      ...current,
      busyBinaryUpdate: true,
      error: '',
    }));
    try {
      const result = await window.gosAgent.downloadBinaryUpdate();
      store.update((current) => ({
        ...current,
        busyBinaryUpdate: false,
        error: result?.ok === false ? String(result?.message || 'Unable to download the desktop update.') : '',
        snapshot: mergeBinaryUpdateSnapshot(current.snapshot, result),
      }));
      if (result?.ok !== false) {
        await refreshApp('lite');
      }
    } catch (error) {
      store.update((current) => ({
        ...current,
        busyBinaryUpdate: false,
        error: error instanceof Error ? error.message : 'Unable to download the desktop update.',
      }));
    }
  };

  const onInstallBinaryUpdate = async () => {
    store.update((current) => ({
      ...current,
      busyBinaryUpdate: true,
      error: '',
    }));
    try {
      const result = await window.gosAgent.installBinaryUpdate();
      store.update((current) => ({
        ...current,
        busyBinaryUpdate: false,
        error: result?.ok === false ? String(result?.message || 'Unable to install the desktop update.') : '',
        snapshot: mergeBinaryUpdateSnapshot(current.snapshot, result),
      }));
      if (result?.ok !== false && String(result?.path || '').trim()) {
        await refreshApp('lite');
      }
    } catch (error) {
      store.update((current) => ({
        ...current,
        busyBinaryUpdate: false,
        error: error instanceof Error ? error.message : 'Unable to install the desktop update.',
      }));
    }
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

  const activeScreenMeta = (() => {
    if (state.activeModuleId === 'monitor') {
      return {
        title: 'Workbench',
        subtitle: 'Inspect active tasks, changes, validation, and execution proof.',
      };
    }
    if (state.activeModuleId === 'tunepod') {
      return {
        title: 'Tune Pod',
        subtitle: 'Machine fit, model readiness, and current setup for this workspace.',
      };
    }
    if (state.activeModuleId === 'settings') {
      return {
        title: 'Settings',
        subtitle: 'Preferences, updates, diagnostics, and workspace defaults.',
      };
    }
    return {
      title: 'Chat',
      subtitle: 'Ask, plan, and start coding work from one conversation.',
    };
  })();

  return (
    <div className={`workbench-shell${state.leftRailOpen ? ' left-open' : ''}${state.rightRailOpen ? ' right-open' : ''}`} data-workbench-shell="true">
      <aside className="left-rail app-nav-rail">
        <div className="rail-brand-row">
          <div className="rail-brand-badge">GS</div>
          <button className="icon-button rail-collapse" onClick={() => store.update((current) => ({ ...current, leftRailOpen: false }))}>Close</button>
        </div>

        <button className="new-chat-button" onClick={onNewThread}>
          <UiIcon name="plus" className="nav-icon" />
          <span>New chat</span>
        </button>

        <nav className="rail-nav-list">
          <button
            className={`rail-nav-item${state.activeModuleId === 'workbench' ? ' active' : ''}`}
            data-module-nav="chat"
            data-route-tab="chat"
            onClick={() => store.update((current) => ({ ...current, activeModuleId: 'workbench' }))}
          >
              <UiIcon name="agents" className="nav-icon" />
            <strong>Chat</strong>
            <span>{unreadThreadCount > 0 ? `${unreadThreadCount} active conversation${unreadThreadCount === 1 ? '' : 's'}` : 'Ask questions, plan work, and launch coding tasks'}</span>
          </button>
          <button
            className={`rail-nav-item${state.activeModuleId === 'monitor' ? ' active' : ''}`}
            data-module-nav="workbench"
            data-route-tab="workbench"
            onClick={() => onOpenMonitorTab(state.activeMonitorTab === 'ide' ? 'ide' : 'runs')}
          >
              <UiIcon name="spark" className="nav-icon" />
            <strong>Workbench</strong>
            <span>{activeTaskRun ? 'Inspect the active run, files, and validation proof' : 'Review execution history, blockers, and recovery evidence'}</span>
          </button>
          <button
            className={`rail-nav-item${state.activeModuleId === 'tunepod' ? ' active' : ''}`}
            data-module-nav="tunepod"
            data-route-tab="tunepod"
            onClick={onOpenTunePod}
          >
              <UiIcon name="terminal" className="nav-icon" />
            <strong>Tune Pod</strong>
            <span>{state.tuning ? 'Check machine fit, ready local models, and current setup' : 'Load machine fit and model readiness for this workspace'}</span>
          </button>
          <button
            className={`rail-nav-item${state.activeModuleId === 'settings' ? ' active' : ''}`}
            data-module-nav="settings"
            data-route-tab="settings"
            onClick={() => onOpenSettingsTab(state.activeSettingsTab === 'tunepod' ? 'general' : (state.activeSettingsTab || 'general'))}
          >
              <UiIcon name="spaces" className="nav-icon" />
            <strong>Settings</strong>
            <span>{shortPath(status.target) || 'Preferences, updates, and diagnostics'}</span>
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
                    <div className="session-thread-heading">
                      <UiIcon name="session" className="session-thread-icon" />
                      <strong>{entry.title}</strong>
                    </div>
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
            <span>Workspace</span>
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
        <header className={`topbar topbar-minimal${state.activeModuleId === 'workbench' && threadIsFresh ? ' is-fresh-thread' : ''}`}>
          <div className="topbar-left">
            {!state.leftRailOpen ? (
              <button className="icon-button" data-sidebar-toggle="left" onClick={() => store.update((current) => ({ ...current, leftRailOpen: !current.leftRailOpen }))}>
                Menu
              </button>
            ) : null}
            <div className="topbar-copy">
              <strong>{activeScreenMeta.title}</strong>
              <span>{`${activeScreenMeta.subtitle} • ${shortPath(status.target) || shortPath(status.workspace) || 'Pick a workspace'}`}</span>
            </div>
          </div>

          <div className="topbar-actions">
            {binaryUpdateState === 'checking' ? (
              <button className="toolbar-chip" disabled>
                Checking update…
              </button>
            ) : null}
            {binaryUpdateState === 'downloading' ? (
              <button className="toolbar-chip" disabled>
                {`Downloading ${binaryUpdateProgress}%`}
              </button>
            ) : null}
            {binaryUpdateCanDownload ? (
              <button className="toolbar-chip" onClick={() => void onDownloadBinaryUpdate()} disabled={state.busyBinaryUpdate}>
                {state.busyBinaryUpdate ? 'Downloading…' : 'Download update'}
              </button>
            ) : null}
            {binaryUpdateReadyToInstall ? (
              <button className="toolbar-chip primary" onClick={() => void onInstallBinaryUpdate()} disabled={state.busyBinaryUpdate}>
                {state.busyBinaryUpdate ? 'Installing…' : binaryUpdateInstallLabel}
              </button>
            ) : null}
            <button
              className={`toolbar-chip${state.activeModuleId === 'monitor' ? ' active' : ''}`}
              data-route-tab="workbench"
              onClick={() => onOpenMonitorTab(state.activeMonitorTab === 'ide' ? 'ide' : 'runs')}
            >
              Workbench
            </button>
            <button
              className={`toolbar-chip${state.activeModuleId === 'workbench' ? ' active' : ''}`}
              data-route-tab="chat"
              onClick={() => store.update((current) => ({ ...current, activeModuleId: 'workbench' }))}
            >
              Chat
            </button>
            <button
              className={`toolbar-chip${state.activeModuleId === 'tunepod' ? ' active' : ''}`}
              data-route-tab="tunepod"
              onClick={onOpenTunePod}
            >
              Tune Pod
            </button>
            <button
              className={`toolbar-chip${state.activeModuleId === 'settings' ? ' active' : ''}`}
              data-route-tab="settings"
              onClick={() => onOpenSettingsTab(state.activeSettingsTab === 'tunepod' ? 'general' : (state.activeSettingsTab || 'general'))}
            >
              Settings
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
              tuning={state.tuning}
              learningStatus={state.learningStatus}
              thread={thread}
              threads={state.threads}
              activeThreadId={state.activeThreadId}
              threadReadMarkers={state.threadReadMarkers}
              activeChatThreadId={state.activeChatThreadId}
              activeChatMessageId={state.activeChatMessageId}
              liveChatProgress={state.liveChatProgress}
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
              onComposerChange={(value) => store.update((current) => ({ ...current, composerText: value }))}
              onChatFocusChange={(focused) => store.update((current) => ({ ...current, chatFocused: focused }))}
              onSendChat={onSendChat}
              onQuickChat={onQuickChat}
              onPickAttachments={onPickChatAttachments}
              onNewThread={onNewThread}
              onSelectThread={onSelectThread}
              onUpdateSetting={onUpdateSetting}
              onOpenSettingsTab={onOpenSettingsTab}
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
              onOpenWorkbench={() => onOpenMonitorTab('runs')}
              onOpenIdeModule={onOpenIdeModule}
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
              binaryUpdateBusy={state.busyBinaryUpdate}
              onPickWorkspace={onSwitchWorkspace}
              onSetActiveTab={(tab) => onOpenSettingsTab(tab)}
              onUpdateSetting={onUpdateSetting}
              onCheckBinaryUpdate={onCheckBinaryUpdate}
              onDownloadBinaryUpdate={onDownloadBinaryUpdate}
              onInstallBinaryUpdate={onInstallBinaryUpdate}
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

          {state.activeModuleId === 'tunepod' ? (
            <TunePodPanel
              snapshot={state.snapshot}
              settings={state.settings}
              aiStatus={state.aiStatus}
              tuning={state.tuning}
              onUpdateSetting={onUpdateSetting}
              onRunBenchmark={onRunBenchmark}
              onOpenSettingsTab={onOpenSettingsTab}
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
              tools={state.tools}
              taskList={taskList}
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
              onQuickChat={onQuickChat}
              onCreateSuggestedTask={onCreateSuggestedTask}
              onQueueSuggestedRecipe={onQueueSuggestedRecipe}
              onRecordOperatorFeedback={onRecordOperatorFeedback}
              onOpenSettingsTab={onOpenSettingsTab}
              onBootstrapVsCode={onBootstrapWorkspaceVsCode}
              onInstallVsCodeCompanion={onInstallVsCodeCompanion}
              onOpenWorkspaceInVsCode={onOpenWorkspaceInVsCode}
              onOpenActiveFileInVsCode={onOpenActiveEditorFileInVsCode}
              onRefresh={() => void refreshApp('full')}
              acceptanceBusy={state.busyAcceptance}
              safetyBusy={state.busySafetyController}
            />
          ) : null}
        </main>
      </div>

      {!state.rightRailOpen ? (
        <button className="right-rail-toggle" data-sidebar-toggle="right" onClick={onToggleManagerInspector}>
          Context
        </button>
      ) : null}

      <aside className={`inspector inspector-${state.activeInspectorTab}`}>
        <div className="rail-header">
          <div className="eyebrow">Context</div>
          <button className="icon-button" data-sidebar-toggle="right" onClick={() => store.update((current) => ({ ...current, rightRailOpen: false }))}>
            Close
          </button>
        </div>

        <div className="inspector-tabs">
          {INSPECTOR_TABS.map((tab) => (
            <button
              key={tab}
              className={state.activeInspectorTab === tab ? 'active' : ''}
              data-inspector-tab={tab}
              onClick={() => store.update((current) => ({ ...current, activeInspectorTab: tab, rightRailOpen: true }))}
            >
              {INSPECTOR_TAB_LABELS[tab]}
            </button>
          ))}
        </div>

        {state.activeInspectorTab === 'manager' ? (
          <ManagerInspector
            snapshot={state.snapshot}
            safeMode={safeMode}
            inboxCount={inboxItems.length}
            quickPrompts={(() => {
              const tunePodGuidance = buildTunePodGuidance(state.snapshot, state.aiStatus, state.tuning);
              return [
                { label: 'Plan the next safe coding task in this repo.', action: 'chat' as const },
                { label: 'Review the current repo and tell me what needs fixing first.', action: 'chat' as const },
                { label: IDE_PANEL_PROMPT, action: 'ide' as const },
                tunePodGuidance.blocked
                  ? { label: tunePodGuidance.prompt, action: 'tunepod' as const }
                  : { label: AI_ROUTE_COPY.modelSetupPrompt, action: 'chat' as const },
              ];
            })()}
            onUpdateSetting={onUpdateSetting}
            onQuickChat={onQuickChat}
            onOpenIdeModule={onOpenIdeModule}
            onOpenSettingsTab={onOpenSettingsTab}
            onShowInspector={(tab) => store.update((current) => ({ ...current, activeInspectorTab: tab, rightRailOpen: true }))}
          />
        ) : null}

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
  tuning: JsonMap | null;
  learningStatus: JsonMap;
  thread: ChatThread | undefined;
  threads: ChatThread[];
  activeThreadId: string;
  threadReadMarkers: Record<string, string>;
  activeChatThreadId: string;
  activeChatMessageId: string;
  liveChatProgress: AssistantChatProgress | null;
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
  onOpenSettingsTab: (tab: SettingsTabId) => void;
  onOpenIdeModule: () => void;
  onSelectPath: (path: string, source?: string) => void;
  onShowInspector: (tab: InspectorTabId) => void;
  onOpenInbox: () => void;
  onOpenWorkbench: () => void;
  onRollbackLatestBackup: (backupId?: string) => void;
}) {
  const settings = props.snapshot?.settings || {};
  const chatModes = ['auto', 'ask', 'plan', 'edit', 'agent'] as const;
  const chatModeLabels: Record<typeof chatModes[number], string> = {
    auto: 'Auto',
    ask: 'Answer only',
    plan: 'Plan next step',
    edit: 'Prepare code changes',
    agent: 'Run with tool support',
  };
  const messages = props.thread?.messages || [];
  const visibleMessages = messages.filter((message) => message.role !== 'system');
  const isFreshThread = !messages.some((message) => message.role !== 'system');
  const chatMode = chatModes.includes(String(settings.chatMode || '').trim().toLowerCase() as typeof chatModes[number])
    ? (String(settings.chatMode || '').trim().toLowerCase() as typeof chatModes[number])
    : 'auto';
  const modeRouteSummary: Record<typeof chatModes[number], string> = {
    auto: 'I will choose whether to answer, plan, or work.',
    ask: 'Answer in chat without changing files.',
    plan: 'Work through the next step before editing.',
    edit: 'Prepare the code changes and what to touch.',
    agent: 'Use tools to carry the task forward safely.',
  };
  const branchLabel = String(props.snapshot?.git?.branch || props.snapshot?.review?.branch || 'workspace').trim() || 'workspace';
  const safetyLabel = props.safeMode.active
    ? 'Safe mode active'
    : (props.safeMode.watchOnly ? 'Safety watch active' : 'Safety ready');
  const workspaceLabel = shortPath(props.snapshot?.targetWorkspaceRoot || props.snapshot?.workspaceRoot || '') || 'workspace';
  const testBench = props.snapshot?.testBench && typeof props.snapshot.testBench === 'object'
    ? props.snapshot.testBench
    : {};
  const docsContext = props.snapshot?.manager?.approvedDocsVault && typeof props.snapshot.manager.approvedDocsVault === 'object'
    ? props.snapshot.manager.approvedDocsVault
    : {};
  const tunePodGuidance = buildTunePodGuidance(props.snapshot, props.aiStatus, props.tuning);
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
    tunePodPrompt: tunePodGuidance.prompt,
  });
  const freshThreadPromptCards: QuickPromptAction[] = [
    { label: 'Explain this repo.', action: 'chat' },
    { label: 'Find the next bug worth fixing.', action: 'chat' },
    { label: 'Plan the next safe change.', action: 'chat' },
    { label: 'Help me debug this failure.', action: 'chat' },
  ];
  const welcomeCards = [
    {
      title: 'Explain this repo',
      detail: 'Get a quick read on the structure, main flows, and what matters first.',
      icon: 'repo' as UiIconName,
      onClick: () => props.onQuickChat('Explain this repo and call out the next safe change to make.'),
    },
    {
      title: 'Plan the next change',
      detail: 'Turn the current repo state into one safe, concrete next step.',
      icon: 'mode' as UiIconName,
      onClick: () => props.onQuickChat('Plan the next safe change for this repo.'),
    },
    {
      title: 'Debug a failure',
      detail: 'Start from an error, failing test, or broken flow and work toward a fix.',
      icon: 'issue' as UiIconName,
      onClick: () => props.onQuickChat('Help me debug this failure and suggest the safest fix first.'),
    },
  ];
  const activeTaskRun = props.taskRuns.find((item: JsonMap) => ['running', 'queued', 'active', 'in_progress', 'starting'].includes(String(item?.runtimeState || item?.state || item?.status || '').toLowerCase())) || null;
  const blockedTaskRun = props.taskRuns.find((item: JsonMap) => ['fail', 'blocked', 'cancelled'].includes(String(item?.runtimeState || item?.state || item?.status || '').toLowerCase())) || null;
  const liveProgress = buildAssistantProgressState({
    busyChat: props.busyChat,
    activeTaskRun,
    chatProgress: props.thread?.id === props.activeChatThreadId ? props.liveChatProgress : null,
  });
  const streamingMessageId = props.thread?.id === props.activeChatThreadId ? props.activeChatMessageId : '';

  const workbenchHandoff = (() => {
    if (blockedTaskRun) {
      return {
        title: 'Run needs review',
        detail: summarizeText(String(blockedTaskRun?.blockedReason || blockedTaskRun?.message || blockedTaskRun?.summary || 'Open Workbench to inspect the latest blocked or failed run.'), 140),
      };
    }
    if (props.approvalItems.length > 0) {
      return {
        title: 'Review needed',
        detail: `${props.approvalItems.length} item${props.approvalItems.length === 1 ? '' : 's'} are waiting for review in Workbench.`,
      };
    }
    if (activeTaskRun) {
      return {
        title: 'Work in progress',
        detail: summarizeText(`${String(activeTaskRun?.runtimeLabel || activeTaskRun?.label || activeTaskRun?.title || 'Current task')} is running. Open Workbench for detailed progress, files, and validation.`, 140),
      };
    }
    if (props.changedItems.length > 0) {
      return {
        title: 'Recent changes ready to inspect',
        detail: `${props.changedItems.length} changed file${props.changedItems.length === 1 ? '' : 's'} are ready to inspect in Workbench.`,
      };
    }
    return null;
  })();

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
                <button className="ghost" onClick={props.onOpenWorkbench}>Open Workbench</button>
                {props.safeMode.rollbackAvailable ? (
                  <button className="ghost" onClick={() => props.onRollbackLatestBackup(String(props.safeMode.latestBackupId || ''))}>
                    Restore latest backup
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          {workbenchHandoff ? (
            <section className="queue-card workbench-handoff-card">
              <div className="eyebrow">Workbench handoff</div>
              <strong>{workbenchHandoff.title}</strong>
              <p>{workbenchHandoff.detail}</p>
              <div className="row-actions">
                <button className="ghost" onClick={props.onOpenWorkbench}>Open Workbench</button>
              </div>
            </section>
          ) : null}

          {isFreshThread ? (
            <div className="workbench-start-shell">
              <section className="chat-welcome-panel" data-legacy-empty-title="Let's build">
                <div className="chat-empty-state compact start-hero-copy">
                  <div className="start-hero-mark">GS</div>
                  <h2>Welcome to GoSenderr</h2>
                  <p>Your chat is the front door to coding work.</p>
                </div>
                <div className="welcome-action-grid">
                  {welcomeCards.map((card) => (
                    <button key={card.title} className="welcome-action-card" onClick={card.onClick}>
                      <div className="welcome-action-icon">
                        <UiIcon name={card.icon} className="action-icon" />
                      </div>
                      <strong>{card.title}</strong>
                      <span>{card.detail}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="workbench-hero-panel chat-entry-panel">
                <div className="composer chat-composer launch-composer">
                <div className="chat-mode-bar launch-toolbar">
                  <label className="selector-chip">
                    <UiIcon name="mode" className="toolbar-icon" />
                    <span>Mode</span>
                    <select value={String(settings.chatMode || 'auto')} onChange={(event) => void props.onUpdateSetting("chatMode", event.target.value)} aria-label="Chat mode">
                      {chatModes.map((mode) => (
                        <option key={mode} value={mode}>{chatModeLabels[mode]}</option>
                      ))}
                    </select>
                  </label>
                  <button className="selector-chip selector-button" onClick={props.onNewThread}>
                    <UiIcon name="plus" className="toolbar-icon" />
                    <span>New chat</span>
                  </button>
                  <button className="selector-chip selector-button workspace-button" onClick={() => props.onShowInspector('file')}>
                    <UiIcon name="repo" className="toolbar-icon" />
                    <span>{workspaceLabel}</span>
                  </button>
                  <button className="selector-chip selector-button" onClick={props.onPickAttachments} aria-label="Attach screenshot">
                    <UiIcon name="plus" className="toolbar-icon" />
                    <span>Add</span>
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
                  <div className="chat-activity-strip launch-status-row">
                    <span className="status-inline-chip">{workspaceLabel}</span>
                    {branchLabel && branchLabel !== 'workspace' ? <span className="status-inline-chip">{branchLabel}</span> : null}
                    {props.safeMode.active || props.safeMode.watchOnly ? <span className="status-inline-chip">{safetyLabel}</span> : null}
                  </div>
                  <div className="launch-send-row">
                    <button className="primary send-icon-button" id="chatSend" data-chat-send="true" onClick={props.onSendChat} disabled={props.busyChat}>
                      {props.busyChat ? 'Working…' : 'Send'}
                    </button>
                  </div>
                </div>

                <div className="prompt-grid compact manager-prompt-grid">
                  {freshThreadPromptCards.map((prompt) => (
                    <button
                      key={prompt.label}
                      className="prompt-card compact"
                      onClick={() => props.onQuickChat(prompt.label)}
                    >
                      {prompt.label}
                    </button>
                  ))}
                </div>

                {!isFreshThread ? (
                  <div className="composer-toolbar compact">
                    <div className="chip-row quick-command-row">
                      {composerSuggestions.map((command) => (
                        <button
                          key={command}
                          className="ghost"
                          onClick={() => command === AI_ROUTE_COPY.tunePodFitPrompt || command === AI_ROUTE_COPY.tunePodRoutePrompt
                            ? props.onOpenSettingsTab('tunepod')
                            : (command === IDE_PANEL_PROMPT ? props.onOpenIdeModule() : props.onQuickChat(command))}
                        >
                          {command}
                        </button>
                      ))}
                    </div>
                  </div>
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
            </div>
          ) : (
            <div className="active-thread-shell">
              {liveProgress ? (
                <section className="queue-card assistant-progress-card">
                  <div className="assistant-progress-header">
                    <div className="eyebrow">Live progress</div>
                    <span className="status-inline-chip">Separate from reply text</span>
                  </div>
                  <strong>{liveProgress.title}</strong>
                  <p>{liveProgress.detail}</p>
                  {liveProgress.showWorkbenchAction ? (
                    <div className="row-actions">
                      <button className="ghost" onClick={props.onOpenWorkbench}>Open Workbench</button>
                    </div>
                  ) : null}
                </section>
              ) : null}

              <div className="chat-stage active-thread-stage">
                <div className="chat-log" data-chat-log="true">
                  {visibleMessages.map((message) => (
                    <article key={message.id} className={`chat-bubble ${message.role}${message.id === streamingMessageId ? ' is-streaming' : ''}`}>
                      <header>
                        <strong>{message.role === 'assistant' ? 'GoSenderr' : 'You'}</strong>
                        <span>{formatStamp(message.createdAt)}</span>
                      </header>
                      {renderChatMessageBody(message.text, message.id)}
                      {!message.text && Array.isArray(message.attachments) && message.attachments.length > 0 ? <p>Attached screenshot context.</p> : null}
                      {message.id === streamingMessageId ? <span className="streaming-caret" aria-hidden="true" /> : null}
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

              <div className="composer chat-composer active-thread-composer">
                <div className="chat-mode-bar launch-toolbar">
                  <label className="selector-chip">
                    <UiIcon name="mode" className="toolbar-icon" />
                    <span>Mode</span>
                    <select value={String(settings.chatMode || 'auto')} onChange={(event) => void props.onUpdateSetting("chatMode", event.target.value)} aria-label="Chat mode">
                      {chatModes.map((mode) => (
                        <option key={mode} value={mode}>{chatModeLabels[mode]}</option>
                      ))}
                    </select>
                  </label>
                  <button className="ghost" onClick={props.onPickAttachments}>Attach screenshot</button>
                  <button className="ghost" onClick={props.onOpenWorkbench}>Open Workbench</button>
                </div>

                {props.pendingAttachments.length > 0 ? (
                  <div className="chip-row attachment-row">
                    {props.pendingAttachments.map((attachment, index) => (
                      <span key={`${attachment.id || attachment.path || index}`} className="attachment-chip">
                        {attachment.originalName || attachment.name || `image ${index + 1}`}
                      </span>
                    ))}
                  </div>
                ) : null}

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
                    <span>{workspaceLabel}</span>
                    {branchLabel && branchLabel !== 'workspace' ? <span>{branchLabel}</span> : null}
                    {props.safeMode.active || props.safeMode.watchOnly ? <span>{safetyLabel}</span> : null}
                  </div>
                  <div className="launch-send-row">
                    <button className="primary send-icon-button" id="chatSend" data-chat-send="true" onClick={props.onSendChat} disabled={props.busyChat}>
                      {props.busyChat ? 'Working…' : 'Send'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ManagerInspector(props: {
  snapshot: JsonMap | null;
  safeMode: JsonMap;
  inboxCount: number;
  quickPrompts: QuickPromptAction[];
  onUpdateSetting: (key: string, value: any) => void | Promise<void>;
  onQuickChat: (command: string) => void;
  onOpenIdeModule: () => void;
  onOpenSettingsTab: (tab: SettingsTabId) => void;
  onShowInspector: (tab: InspectorTabId) => void;
}) {
  const settings = props.snapshot?.settings || {};
  const chatModes = ['auto', 'ask', 'plan', 'edit', 'agent'] as const;
  const chatModeLabels: Record<typeof chatModes[number], string> = {
    auto: 'Auto',
    ask: 'Answer only',
    plan: 'Plan next step',
    edit: 'Prepare code changes',
    agent: 'Run with tool support',
  };
  const chatMode = chatModes.includes(String(settings.chatMode || '').trim().toLowerCase() as typeof chatModes[number])
    ? (String(settings.chatMode || '').trim().toLowerCase() as typeof chatModes[number])
    : 'auto';
  const modeRouteSummary: Record<typeof chatModes[number], string> = {
    auto: 'Let Chat choose the best help mode.',
    ask: 'Answer in chat only.',
    plan: 'Talk through the next step before editing.',
    edit: 'Prepare the next code change safely.',
    agent: 'Use tools when the task needs them.',
  };
  const workspaceLabel = shortPath(props.snapshot?.targetWorkspaceRoot || props.snapshot?.workspaceRoot || '') || 'workspace';
  const branchLabel = String(props.snapshot?.git?.branch || props.snapshot?.review?.branch || 'workspace').trim() || 'workspace';
  const safetyLabel = props.safeMode.active
    ? 'Safe mode active'
    : (props.safeMode.watchOnly ? 'Safety watch active' : 'Safety ready');

  return (
    <div className="inspector-body manager-inspector-body">
      <section className="manager-drawer manager-drawer-rail">
        <div className="manager-copy">
          <div className="eyebrow">Context</div>
          <strong>Use this rail only when you need extra detail</strong>
          <p>Keep the main conversation clean, then open context when you want files, inbox items, or supporting detail.</p>
        </div>

        <div className="composer-selector-row manager-control-row">
          <label className="selector-chip">
            <span>Mode</span>
            <select value={String(settings.chatMode || 'auto')} onChange={(event) => void props.onUpdateSetting('chatMode', event.target.value)} aria-label="Chat mode">
              {chatModes.map((mode) => (
                <option key={`manager-${mode}`} value={mode}>{chatModeLabels[mode]}</option>
              ))}
            </select>
          </label>
          <label className="selector-chip">
            <span>Workspace</span>
            <span>{workspaceLabel}</span>
          </label>
        </div>

        <div className="workbench-status-strip manager-status-strip">
          <span className="status-inline-chip">{chatModeLabels[chatMode]}</span>
          {branchLabel && branchLabel !== 'workspace' ? <span className="status-inline-chip">{branchLabel}</span> : null}
          {props.safeMode.active || props.safeMode.watchOnly ? <span className="status-inline-chip">{safetyLabel}</span> : null}
        </div>

        <div className="chat-compact-strip manager-compact-strip">
          <span>Optional details</span>
          <span>{modeRouteSummary[chatMode]}</span>
        </div>

        <div className="manager-quick-grid">
          <button className="ghost" onClick={() => props.onQuickChat('/health')}>Check status</button>
          {props.quickPrompts.some((prompt) => prompt.action === 'tunepod') ? <button className="ghost" onClick={() => props.onOpenSettingsTab('tunepod')}>{AI_ROUTE_COPY.tunePodActionLabel}</button> : null}
          <button className="ghost" onClick={() => props.onShowInspector('inbox')}>Open inbox {props.inboxCount ? `(${props.inboxCount})` : ''}</button>
          <button className="ghost" onClick={() => props.onShowInspector('file')}>Open files</button>
        </div>

        <div className="prompt-grid compact manager-prompt-grid">
          {props.quickPrompts.map((prompt) => (
            <button
              key={prompt.label}
              className="prompt-card compact"
              onClick={() => prompt.action === 'tunepod'
                ? props.onOpenSettingsTab('tunepod')
                : (prompt.action === 'ide' ? props.onOpenIdeModule() : props.onQuickChat(prompt.label))}
            >
              {prompt.label}
            </button>
          ))}
        </div>
      </section>

      <section className="queue-card manager-summary-card">
        <div className="eyebrow">Workspace</div>
        <strong>{workspaceLabel}</strong>
        <span>{props.inboxCount > 0 ? `${props.inboxCount} inbox item${props.inboxCount === 1 ? '' : 's'} pending review` : 'Inbox is clear'}</span>
      </section>
    </div>
  );
}

function IDEPanel(props: {
  snapshot: JsonMap | null;
  tools: JsonMap[];
  taskList: JsonMap[];
  taskRuns: JsonMap[];
  onQuickChat: (command: string) => void;
  onRefresh: () => void;
  onOpenSettingsTab: (tab: SettingsTabId) => void;
  onOpenMonitorTab: (tab: MonitorTabId) => void;
  onBootstrapVsCode: () => void;
  onInstallVsCodeCompanion: () => void;
  onOpenWorkspaceInVsCode: () => void;
  onOpenActiveFileInVsCode: () => void;
}) {
  const vscodeSetup = props.snapshot?.vscodeSetup || {};
  const extensionHealth = props.snapshot?.extensionHealth || {};
  const editorContext = props.snapshot?.editorContext || {};
  const activeFilePath = String(editorContext?.active_file_path || '').trim();
  const openFiles = Array.isArray(editorContext?.open_files) ? editorContext.open_files : [];
  const missingBootstrapCount = Number(vscodeSetup?.missingFiles?.length || 0)
    + Number(vscodeSetup?.missingRecommendations?.length || 0)
    + Number(vscodeSetup?.missingTaskLabels?.length || 0);
  const companionInstalled = Boolean(vscodeSetup?.companionInstall?.installed || extensionHealth?.exists);
  const activeTask = props.taskList[0] || null;
  const activeRun = props.taskRuns[0] || null;
  const toolKinds = props.tools.reduce((accumulator, item) => {
    const kind = String(item?.kind || 'other').trim() || 'other';
    accumulator[kind] = Number(accumulator[kind] || 0) + 1;
    return accumulator;
  }, {} as Record<string, number>);
  const terminalLanes = [
    {
      id: 'plan',
      title: 'Plan next safe slice',
      detail: 'Keep chat and the tool loop scoped before the engine mutates the workspace.',
      actionLabel: 'Open in chat',
      onClick: () => props.onQuickChat('Plan the next safe coding task in this repo.'),
    },
    {
      id: 'implement',
      title: 'Implement with tools',
      detail: 'Push the bounded file/search/edit/test tool loop through the next concrete repo task.',
      actionLabel: 'Run through chat',
      onClick: () => props.onQuickChat('Implement the next safe coding task using the bounded tool loop and summarize the touched files.'),
    },
    {
      id: 'repair',
      title: 'Repair latest blocker',
      detail: 'Route the engine into the smallest failing slice instead of widening the request.',
      actionLabel: 'Repair in chat',
      onClick: () => props.onQuickChat('Repair the latest failed run and summarize the fix.'),
    },
    {
      id: 'monitor',
      title: 'Inspect blockers',
      detail: 'Stay in Workbench when the tool route is blocked by acceptance, safety, or queued run debt.',
      actionLabel: 'Open Workbench',
      onClick: () => props.onOpenMonitorTab('overview'),
    },
  ];

  return (
    <section className="module-panel ide-panel" data-panel="ide">
      <section className="ide-hero">
        <div className="ide-hero-main">
          <div>
            <div className="eyebrow">Workbench IDE lanes</div>
            <h2>Tool use, editor handoff, and terminal lanes stay attached to execution work</h2>
            <p>Workbench surfaces the bounded tool loop, VS Code bootstrap state, and editor handoff without turning IDE actions into a fifth top-level destination.</p>
          </div>
          <div className="row-actions ide-hero-actions">
            <button className="primary" onClick={props.onOpenWorkspaceInVsCode}>Open workspace in VS Code</button>
            <button className="ghost" onClick={props.onBootstrapVsCode}>Bootstrap VS Code</button>
            <button className="ghost" onClick={props.onInstallVsCodeCompanion}>Install companion</button>
            <button className="ghost" onClick={props.onRefresh}>Refresh</button>
          </div>
        </div>

        <div className="ide-hero-grid">
          <article className="metric-card">
            <div className="eyebrow">Workspace target</div>
            <strong>{shortPath(props.snapshot?.targetWorkspaceRoot || props.snapshot?.workspaceRoot || '') || 'Not selected'}</strong>
            <p>{props.snapshot?.selectedLabRoot ? 'A lab is active, so the IDE handoff will follow the lab target.' : 'The IDE handoff follows the live workspace target.'}</p>
          </article>
          <article className="metric-card">
            <div className="eyebrow">VS Code bootstrap</div>
            <strong>{missingBootstrapCount > 0 ? 'Needs bootstrap' : 'Ready'}</strong>
            <p>{String(vscodeSetup?.summary || 'Bootstrap tasks, settings, and recommendations before widening editor-side work.')}</p>
          </article>
          <article className="metric-card">
            <div className="eyebrow">Companion</div>
            <strong>{companionInstalled ? 'Detected' : 'Missing'}</strong>
            <p>{String(extensionHealth?.summary || 'Install the VS Code companion so desktop and editor actions stay aligned.')}</p>
          </article>
          <article className="metric-card">
            <div className="eyebrow">Tool catalog</div>
            <strong>{props.tools.length}</strong>
            <p>{Object.keys(toolKinds).length > 0 ? `${Object.keys(toolKinds).length} tool families are exposed to the engine.` : 'Tool metadata will appear after the next refresh.'}</p>
          </article>
          <article className="metric-card">
            <div className="eyebrow">Active file</div>
            <strong>{shortPath(activeFilePath) || 'No active file'}</strong>
            <p>{activeFilePath ? 'Use the editor handoff to reopen the current working file in VS Code.' : 'Open a file from chat or the inspector and it will show up here.'}</p>
          </article>
          <article className="metric-card">
            <div className="eyebrow">Active task</div>
            <strong>{String(activeRun?.runtimeState || activeRun?.status || 'idle')}</strong>
            <p>{String(activeRun?.runtimeLabel || activeRun?.label || activeTask?.title || 'No active coding run is recorded yet.')}</p>
          </article>
        </div>
      </section>

      <div className="card-grid ide-lane-grid">
        {terminalLanes.map((lane) => (
          <article key={lane.id} className="metric-card ide-lane-card">
            <div className="eyebrow">Terminal lane</div>
            <strong>{lane.title}</strong>
            <p>{lane.detail}</p>
            <div className="row-actions">
              <button className="ghost" onClick={lane.onClick}>{lane.actionLabel}</button>
            </div>
          </article>
        ))}
      </div>

      <div className="card-grid ide-workspace-grid">
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
              <strong>Missing recommendations</strong>
              <span>{(Array.isArray(vscodeSetup.missingRecommendations) ? vscodeSetup.missingRecommendations.slice(0, 6) : []).join(', ')}</span>
            </div>
          ) : null}
          {Number(vscodeSetup?.missingTaskLabels?.length || 0) > 0 ? (
            <div className="run-item">
              <strong>Missing tasks</strong>
              <span>{(Array.isArray(vscodeSetup.missingTaskLabels) ? vscodeSetup.missingTaskLabels : []).join(', ')}</span>
            </div>
          ) : null}
          {missingBootstrapCount === 0 ? <p className="empty-copy">VS Code workspace files, tasks, and recommendations are already aligned for this target.</p> : null}
        </section>

        <section className="queue-card">
          <div className="eyebrow">Editor handoff</div>
          <div className="run-item">
            <strong>Workspace launch</strong>
            <span>Open the current target root in VS Code so terminals, problems, and editor tools stay attached to the same workspace the desktop shell is supervising.</span>
          </div>
          <div className="run-item">
            <strong>Active file</strong>
            <span>{activeFilePath ? shortPath(activeFilePath) : 'No active file is pinned yet.'}</span>
          </div>
          {openFiles.slice(0, 5).map((entry: unknown, index: number) => (
            <div key={`${String(entry || '')}-${index}`} className="run-item">
              <strong>Recent editor file</strong>
              <span>{shortPath(String(entry || '')) || 'Unknown file'}</span>
            </div>
          ))}
          <div className="row-actions">
            <button className="ghost" onClick={props.onOpenWorkspaceInVsCode}>Open workspace in VS Code</button>
            <button className="ghost" onClick={props.onOpenActiveFileInVsCode} disabled={!activeFilePath}>Open active file</button>
            <button className="ghost" onClick={() => props.onOpenSettingsTab('workspace')}>Workspace settings</button>
          </div>
        </section>
      </div>

      <div className="card-grid ide-workspace-grid">
        <section className="queue-card">
          <div className="eyebrow">Tool access exposed to the model</div>
          {props.tools.slice(0, 10).map((tool, index) => (
            <div key={`${String(tool?.id || tool?.label || 'tool')}-${index}`} className="run-item">
              <strong>{String(tool?.label || tool?.id || 'Tool')}</strong>
              <span>{String(tool?.summary || `${tool?.kind || 'tool'} • ${tool?.safetyLevel || 'unknown safety'}`)}</span>
            </div>
          ))}
          {props.tools.length === 0 ? <p className="empty-copy">No tool metadata is available yet. Refresh the shell and verify the tool catalog preload path.</p> : null}
        </section>

        <section className="queue-card">
          <div className="eyebrow">Companion alignment</div>
          {Array.isArray(extensionHealth?.warnings) && extensionHealth.warnings.length > 0 ? (
            extensionHealth.warnings.map((warning: string, index: number) => (
              <div key={`${warning}-${index}`} className="run-item">
                <strong>{extensionHealth.displayName || 'VS Code companion'}</strong>
                <span>{warning}</span>
              </div>
            ))
          ) : (
            <div className="run-item">
              <strong>{extensionHealth.displayName || 'VS Code companion'}</strong>
              <span>{String(extensionHealth?.nextStep || extensionHealth?.summary || 'Companion health looks aligned with the desktop shell.')}</span>
            </div>
          )}
          <div className="row-actions">
            <button className="ghost" onClick={props.onInstallVsCodeCompanion}>Install companion</button>
            <button className="ghost" onClick={() => props.onOpenSettingsTab('tools')}>Open tool catalog</button>
          </div>
        </section>
      </div>
    </section>
  );
}

function TunePodPanel(props: {
  snapshot: JsonMap | null;
  settings: JsonMap;
  aiStatus: JsonMap | null;
  tuning: JsonMap | null;
  onUpdateSetting: (field: string, value: any) => void | Promise<void>;
  onRunBenchmark: () => void;
  onOpenSettingsTab: (tab: SettingsTabId) => void;
}) {
  const settings = props.settings || props.snapshot?.settings || {};
  const aiRoutingPolicies = Array.isArray(props.aiStatus?.routingPolicies) ? props.aiStatus.routingPolicies : [];
  const aiRemoteProviders = Array.isArray(props.aiStatus?.remoteProviders) ? props.aiStatus.remoteProviders : [];
  const aiRemoteModelOptions = Array.isArray(props.aiStatus?.remoteModelCatalog) ? props.aiStatus.remoteModelCatalog : [];
  const capabilityLanes = Array.isArray(props.aiStatus?.capabilityLanes) ? props.aiStatus.capabilityLanes : [];
  const targetHardwareOptions = Array.isArray(props.tuning?.hardwareTargets) ? props.tuning.hardwareTargets : [];
  const selectedHardwareTarget = String(settings.trainingHardwareTarget || props.tuning?.settings?.trainingHardwareTarget || 'auto');
  const installPresets = Array.isArray(props.tuning?.installPresets) ? props.tuning.installPresets : [];
  const localModelProgram = buildLocalModelProgramView(props.snapshot, props.aiStatus, props.tuning);
  const tuningLifecycle = props.tuning?.lifecycle && typeof props.tuning.lifecycle === 'object'
    ? props.tuning.lifecycle
    : (props.aiStatus?.localModelInventory && typeof props.aiStatus.localModelInventory === 'object' ? props.aiStatus.localModelInventory : {});
  const machineProfile = props.tuning?.telemetry?.machine && typeof props.tuning.telemetry.machine === 'object'
    ? props.tuning.telemetry.machine
    : {};
  const selectedHardwareTargetMeta = targetHardwareOptions.find((item: JsonMap) => String(item?.id || '') === selectedHardwareTarget)
    || targetHardwareOptions[0]
    || null;
  const effectiveHardwareTargetId = selectedHardwareTarget === 'auto'
    ? (String(machineProfile.id || '').trim() || 'auto')
    : selectedHardwareTarget;
  const effectiveHardwareTargetMeta = targetHardwareOptions.find((item: JsonMap) => String(item?.id || '') === effectiveHardwareTargetId)
    || selectedHardwareTargetMeta;
  const effectiveTunePodCapabilities = readTunePodCapabilities(effectiveHardwareTargetMeta, machineProfile, selectedHardwareTargetMeta);
  const routePolicyId = String(settings.aiRoutingPolicy || settings.aiProfile || props.aiStatus?.profileId || 'hybrid-default');
  const routePolicyMeta = aiRoutingPolicies.find((policy: JsonMap) => String(policy?.id || '') === routePolicyId) || null;
  const routePolicyLabel = String(routePolicyMeta?.label || routePolicyId);
  const routePolicySummary = String(routePolicyMeta?.summary || '').trim();
  const selectedRemoteProviderId = String(settings.aiRemoteProvider || props.aiStatus?.current?.remoteProvider || 'openai');
  const selectedRemoteProvider = aiRemoteProviders.find((provider: JsonMap) => String(provider?.id || '') === selectedRemoteProviderId)
    || aiRemoteProviders[0]
    || null;
  const selectedRemoteModel = String(settings.aiRemoteModel || props.aiStatus?.current?.remoteModel || aiRemoteModelOptions[0]?.model || '');
  const remoteFallbackReady = Boolean(selectedRemoteModel.trim());
  const benchmarkLeader = props.aiStatus?.benchmarkSummary?.[0] || null;
  const machineProfileFootprint = effectiveTunePodCapabilities.systemRamGb
    ? `${Number(effectiveTunePodCapabilities.systemRamGb)} GB RAM • ${Number(effectiveTunePodCapabilities.cpuThreads || 0)} CPU cores${effectiveTunePodCapabilities.gpuVramGb ? ` • ${Number(effectiveTunePodCapabilities.gpuVramGb)} GB VRAM` : ''}`
    : 'Machine telemetry is still warming up.';
  const hardwareTargetLabelMap = targetHardwareOptions.reduce((accumulator, item: JsonMap) => {
    const targetId = String(item?.id || '').trim();
    if (targetId) {
      accumulator[targetId] = String(item?.label || targetId);
    }
    return accumulator;
  }, {} as Record<string, string>);
  const tunePodReadyModelSet = new Set(readAiModelOptions(props.aiStatus, props.tuning, settings).filter((option) => option.ready).map((option) => option.model));
  const tunePodPresetTargetLabels = (preset: JsonMap) => {
    const targetIds = (Array.isArray(preset?.recommendedTargets) ? preset.recommendedTargets : [])
      .map((item: unknown) => String(item || '').trim())
      .filter((item: string) => item && item !== 'auto');
    return targetIds.map((targetId: string) => hardwareTargetLabelMap[targetId] || targetId);
  };
  const tunePodPresetFit = (preset: JsonMap) => evaluateTunePodRequirementFit(preset, effectiveTunePodCapabilities);
  const compatibleTunePodPresets = installPresets.filter((preset: JsonMap) => tunePodPresetFit(preset).fits);
  const incompatibleTunePodPresets = installPresets.filter((preset: JsonMap) => !tunePodPresetFit(preset).fits);
  const readinessCounts = (Array.isArray(tuningLifecycle?.entries) ? tuningLifecycle.entries : []).reduce((accumulator: { live: number; registered: number; staged: number; missing: number }, entry: JsonMap) => {
    const readiness = String(entry?.localReadiness || entry?.installState || '').trim().toLowerCase();
    if (readiness === 'live' || readiness === 'ready') {
      accumulator.live += 1;
    } else if (readiness === 'registered' || readiness === 'store-only') {
      accumulator.registered += 1;
    } else if (readiness === 'staged' || readiness === 'stored') {
      accumulator.staged += 1;
    } else {
      accumulator.missing += 1;
    }
    return accumulator;
  }, { live: 0, registered: 0, staged: 0, missing: 0 });
  const routePlanCards = capabilityLanes.slice(0, 5).map((lane: JsonMap) => ({
    id: String(lane?.id || lane?.label || ''),
    label: String(lane?.label || lane?.id || 'Lane'),
    summary: String(lane?.summary || 'Route detail pending.'),
    owner: `${String(lane?.provider || 'provider')} • ${String(lane?.preferredModel || 'model pending')}`,
    source: String(lane?.sourceLabel || (lane?.source === 'override' ? AI_ROUTE_COPY.routeSourceOverride : AI_ROUTE_COPY.routeSourceInherited)),
  }));
  const nextSetupStep = (() => {
    const nextLayerId = String(localModelProgram.nextLayer?.id || '').trim().toLowerCase();
    if (nextLayerId === 'foundation') {
      return {
        title: 'Add more local models',
        summary: 'This machine needs more ready local models before local coding can be the default path.',
      };
    }
    if (nextLayerId === 'routing') {
      return {
        title: 'Finish local coding setup',
        summary: 'Set the active model choices so local coding is ready by default for everyday work.',
      };
    }
    if (nextLayerId === 'coding') {
      return {
        title: 'Verify local coding',
        summary: 'Run readiness checks to confirm local coding works cleanly on this machine.',
      };
    }
    if (nextLayerId === 'promotion') {
      return {
        title: 'Review advanced promotion options',
        summary: 'Promotion is an advanced step and can wait until the local coding setup is stable.',
      };
    }
    if (nextLayerId === 'self-improve') {
      return {
        title: 'Keep advanced improvement tools paused',
        summary: 'Leave advanced improvement tools alone until the lower setup layers are stable.',
      };
    }
    return {
      title: 'Current setup looks ready',
      summary: 'The main local model setup is in good shape for normal daily work.',
    };
  })();

  return (
    <section className="module-panel settings-panel-v2 tunepod-panel" data-panel="tunepod">
      <div className="settings-shell">
        <section className="settings-hero">
          <div className="settings-hero-main">
            <div>
              <div className="eyebrow">Tune Pod</div>
              <h2>See what fits this machine and what is ready now</h2>
              <p>Tune Pod shows what this PC can run, which local models are ready, what is active, and what setup step comes next.</p>
            </div>
            <div className="row-actions settings-hero-actions">
              <button className="primary" data-run-benchmark="true" onClick={props.onRunBenchmark}>Check readiness</button>
              <button className="ghost" onClick={() => props.onOpenSettingsTab('ai')}>Import models</button>
            </div>
          </div>
          <div className="settings-hero-grid">
            <article className="settings-hero-card">
              <div className="eyebrow">Machine fit</div>
              <strong>{String(machineProfile.label || 'Machine profile pending')}</strong>
              <p>{machineProfileFootprint}</p>
            </article>
            <article className="settings-hero-card">
              <div className="eyebrow">Current setup</div>
              <strong>{routePolicyLabel}</strong>
              <p>{routePolicySummary || 'These are the active model choices for this workspace.'}</p>
            </article>
            <article className="settings-hero-card">
              <div className="eyebrow">Next recommended step</div>
              <strong>{nextSetupStep.title}</strong>
              <p>{nextSetupStep.summary}</p>
            </article>
            <article className="settings-hero-card">
              <div className="eyebrow">Fallback help</div>
              <strong>{remoteFallbackReady ? 'Available when needed' : 'Local only'}</strong>
              <p>{remoteFallbackReady ? `${String(selectedRemoteProvider?.label || 'Remote')} is available as backup help or for quick comparison.` : 'No fallback help is configured. Local models are the main path right now.'}</p>
            </article>
          </div>
        </section>

        <section className="settings-section">
          <div className="card-grid">
            <article className="metric-card active">
              <div className="eyebrow">Active machine target</div>
              <strong>{String(effectiveHardwareTargetMeta?.label || 'Current machine')}</strong>
              <p>{String(effectiveHardwareTargetMeta?.summary || 'Use the live machine fit unless you are staging for a larger target.')}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Active local model</div>
              <strong>{String(settings.trainingOllamaModel || props.aiStatus?.current?.derivedModelLabel || 'Not selected')}</strong>
              <p>{benchmarkLeader ? `Recent checks favor ${String(benchmarkLeader.model || 'this model')} on this machine.` : 'Run Check readiness to compare the current options.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Fits this PC</div>
              <strong>{compatibleTunePodPresets.length}</strong>
              <p>{compatibleTunePodPresets.length > 0 ? 'These curated presets match the active target tier.' : 'No curated presets fit the active target tier yet.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Model readiness</div>
              <strong>{`${Number(tuningLifecycle.readyCount || readinessCounts.live || 0)} ready • ${Number(tuningLifecycle.localCount || 0)} tracked`}</strong>
              <p>See what is ready now, saved for later, or still missing below.</p>
            </article>
          </div>

          <div className="settings-grid">
            <label>
              <span>Machine target</span>
              <select value={selectedHardwareTarget} onChange={(event) => void props.onUpdateSetting('trainingHardwareTarget', event.target.value)}>
                {(targetHardwareOptions.length ? targetHardwareOptions : [{ id: 'auto', label: 'Current machine' }]).map((target: JsonMap) => (
                  <option key={String(target.id || '')} value={String(target.id || '')}>{String(target.label || target.id || '')}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Current setup</span>
              <input value={routePolicyLabel} readOnly />
            </label>
            <label>
              <span>Active local model</span>
              <input value={String(settings.trainingOllamaModel || props.aiStatus?.current?.derivedModelLabel || 'Not selected')} readOnly />
            </label>
            <label>
              <span>Fallback help</span>
              <input value={remoteFallbackReady ? `${String(selectedRemoteProvider?.label || 'Remote')} • compare or backup help` : 'Not configured'} readOnly />
            </label>
          </div>

          <section className="queue-card">
            <div className="panel-header">
              <div>
                <div className="eyebrow">Model readiness</div>
                <h2>See what is ready now, saved, or still missing</h2>
                <p>Tune Pod should make it obvious which models are ready to use now and which ones still need setup.</p>
              </div>
            </div>
            <div className="card-grid">
              <article className="metric-card">
                <div className="eyebrow">Ready now</div>
                <strong>{readinessCounts.live}</strong>
                <p>Ready to use on this machine right now.</p>
              </article>
              <article className="metric-card">
                <div className="eyebrow">Added</div>
                <strong>{readinessCounts.registered}</strong>
                <p>Added to the app, but not confirmed ready on this machine yet.</p>
              </article>
              <article className="metric-card">
                <div className="eyebrow">Stored</div>
                <strong>{readinessCounts.staged}</strong>
                <p>Available to import later, but not added to the live setup yet.</p>
              </article>
              <article className="metric-card">
                <div className="eyebrow">Missing</div>
                <strong>{readinessCounts.missing}</strong>
                <p>Not available for this machine yet or not installed locally.</p>
              </article>
            </div>
          </section>

          <section className="queue-card">
            <div className="panel-header">
              <div>
                <div className="eyebrow">Fits this PC</div>
                <h2>Compatible local model presets for the active target</h2>
                <p>Start with the presets that fit this machine before you widen to heavier families.</p>
              </div>
            </div>
            {compatibleTunePodPresets.slice(0, 6).map((preset: JsonMap) => {
              const targetLabels = tunePodPresetTargetLabels(preset);
              const presetModel = String(preset.ollamaModel || '');
              const isReady = presetModel ? tunePodReadyModelSet.has(presetModel) : false;
              return (
                <div key={String(preset.id || preset.label)} className="run-item">
                  <strong>{String(preset.label || preset.id || 'Preset')}</strong>
                  <span>
                    {String(preset.sizeLabel || 'size pending')}
                    {preset.requirementSummary ? ` • ${String(preset.requirementSummary)}` : ''}
                    {targetLabels.length > 0 ? ` • Fits ${targetLabels.join(' • ')}` : ''}
                    {isReady ? ' • ready now' : ' • needs setup'}
                  </span>
                </div>
              );
            })}
            {compatibleTunePodPresets.length === 0 ? <p className="empty-copy">No curated local models fit the active target tier yet.</p> : null}
          </section>

          <details className="queue-card tunepod-advanced-card">
            <summary className="panel-header">
              <div>
                <div className="eyebrow">Advanced</div>
                <h2>Model choices and deeper setup details</h2>
                <p>Open this when you want task-specific model choices, fallback detail, or deeper readiness steps.</p>
              </div>
            </summary>

            <section className="queue-card">
              <div className="panel-header">
                <div>
                  <div className="eyebrow">Current setup</div>
                  <h2>Which model handles each kind of work</h2>
                  <p>Use this only when you need to inspect or change task-specific model choices.</p>
                </div>
              </div>
              <div className="card-grid lane-grid">
                {routePlanCards.map((lane) => (
                  <article key={lane.id} className="metric-card lane-card">
                    <div className="eyebrow">Active choice</div>
                    <strong>{lane.label}</strong>
                    <p>{lane.summary}</p>
                    <div className="lane-summary">
                      <span>{lane.owner}</span>
                      <span>{lane.source}</span>
                    </div>
                  </article>
                ))}
              </div>
              {routePlanCards.length === 0 ? <p className="empty-copy">Task model choices will appear here after the next AI status refresh.</p> : null}
            </section>

            <section className="queue-card">
              <div className="eyebrow">Advanced readiness details</div>
              <div className="run-item">
                <strong>{`${localModelProgram.verifiedCount}/${localModelProgram.layers.length} steps verified`}</strong>
                <span>{localModelProgram.summary}</span>
              </div>
              {localModelProgram.layers.map((layer: { id: string; label: string; status: string; summary: string; unlockRule: string }) => (
                <div key={layer.id} className="run-item">
                  <strong>{layer.label}</strong>
                  <span>{`${localModelProgramStatusLabel(layer.status)} • ${layer.summary}`}</span>
                  <div className="row-actions">
                    <span className={`status-pill${layer.status === 'verified' ? ' ready' : ''}`}>{localModelProgramStatusLabel(layer.status)}</span>
                    <span className="status-pill">{layer.unlockRule}</span>
                  </div>
                </div>
              ))}
            </section>

            <section className="queue-card">
              <div className="eyebrow">Fallback and compare</div>
              <div className="run-item">
                <strong>Fallback help</strong>
                <span>{remoteFallbackReady ? `${String(selectedRemoteProvider?.label || 'Remote')} with ${selectedRemoteModel || 'a selected model'} is available as backup help or for quick comparison.` : 'No fallback help is configured yet.'}</span>
              </div>
              <div className="run-item">
                <strong>Compare</strong>
                <span>{capabilityLanes.find((lane: JsonMap) => String(lane?.id || '').toLowerCase().includes('compare'))?.summary || 'Quick compare stays available here when it is configured.'}</span>
              </div>
              <div className="run-item">
                <strong>Better on bigger hardware</strong>
                <span>{incompatibleTunePodPresets.length > 0 ? `${incompatibleTunePodPresets.length} heavier preset${incompatibleTunePodPresets.length === 1 ? '' : 's'} stay listed here as bigger-machine options.` : 'No heavier curated presets are recorded for this target right now.'}</span>
              </div>
            </section>
          </details>
        </section>
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
          <h2>{AI_ROUTE_COPY.enginePanelTitle}</h2>
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
          <p className="empty-copy">No operator supervision signals yet. Record approvals, needs changes, or comments from Workbench to start shaping the engine.</p>
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
  binaryUpdateBusy: boolean;
  onPickWorkspace: () => void;
  onSetActiveTab: (tab: SettingsTabId) => void;
  onUpdateSetting: (field: string, value: any) => void | Promise<void>;
  onCheckBinaryUpdate: () => Promise<void>;
  onDownloadBinaryUpdate: () => Promise<void>;
  onInstallBinaryUpdate: () => Promise<void>;
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
  const updates = props.snapshot?.updates && typeof props.snapshot.updates === 'object' ? props.snapshot.updates : {};
  const binaryUpdates = updates.binary && typeof updates.binary === 'object' ? updates.binary : {};
  const updateRecovery = updates.workspace?.recovery && typeof updates.workspace.recovery === 'object'
    ? updates.workspace.recovery
    : (updates.recovery && typeof updates.recovery === 'object' ? updates.recovery : {});
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
  const appRollbackSummary = String(appRollbacks?.summary || '').trim();
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
  const localModelProgram = buildLocalModelProgramView(props.snapshot, props.aiStatus, props.tuning);
  const tuningLifecycle = props.tuning?.lifecycle && typeof props.tuning.lifecycle === 'object'
    ? props.tuning.lifecycle
    : (props.aiStatus?.localModelInventory && typeof props.aiStatus.localModelInventory === 'object' ? props.aiStatus.localModelInventory : {});
  const machineProfile = props.tuning?.telemetry?.machine && typeof props.tuning.telemetry.machine === 'object'
    ? props.tuning.telemetry.machine
    : {};
  const selectedHardwareTargetMeta = targetHardwareOptions.find((item: JsonMap) => String(item?.id || '') === selectedHardwareTarget)
    || targetHardwareOptions[0]
    || null;
  const effectiveHardwareTargetId = selectedHardwareTarget === 'auto'
    ? (String(machineProfile.id || '').trim() || 'auto')
    : selectedHardwareTarget;
  const effectiveHardwareTargetMeta = targetHardwareOptions.find((item: JsonMap) => String(item?.id || '') === effectiveHardwareTargetId)
    || selectedHardwareTargetMeta;
  const effectiveTunePodCapabilities = readTunePodCapabilities(effectiveHardwareTargetMeta, machineProfile, selectedHardwareTargetMeta);
  const routePolicyId = String(settings.aiRoutingPolicy || settings.aiProfile || props.aiStatus?.profileId || 'hybrid-default');
  const routePolicyMeta = aiRoutingPolicies.find((policy: JsonMap) => String((policy as JsonMap)?.id || '') === routePolicyId) || null;
  const routePolicyLabel = String(routePolicyMeta?.label || routePolicyId);
  const routePolicySummary = String(routePolicyMeta?.summary || '').trim();
  const remoteFallbackReady = Boolean(String(settings.aiRemoteModel || props.aiStatus?.current?.remoteModel || '').trim());
  const hardwareTargetLabelMap = targetHardwareOptions.reduce((accumulator, item: JsonMap) => {
    const targetId = String(item?.id || '').trim();
    if (targetId) {
      accumulator[targetId] = String(item?.label || targetId);
    }
    return accumulator;
  }, {} as Record<string, string>);
  const tunePodReadyModelSet = new Set(aiModelOptions.filter((option) => option.ready).map((option) => option.model));
  const tunePodPresetTargetLabels = (preset: JsonMap) => {
    const targetIds = (Array.isArray(preset?.recommendedTargets) ? preset.recommendedTargets : [])
      .map((item: unknown) => String(item || '').trim())
      .filter((item: string) => item && item !== 'auto');
    return targetIds.map((targetId: string) => hardwareTargetLabelMap[targetId] || targetId);
  };
  const tunePodPresetFit = (preset: JsonMap) => evaluateTunePodRequirementFit(preset, effectiveTunePodCapabilities);
  const compatibleTunePodPresets = installPresets.filter((preset: JsonMap) => tunePodPresetFit(preset).fits);
  const incompatibleTunePodPresets = installPresets.filter((preset: JsonMap) => !tunePodPresetFit(preset).fits);
  const remoteReductionUnlock = localModelProgram.unlocks.find((unlock) => unlock.id === 'remote-min') || null;
  const machineProfileFootprint = effectiveTunePodCapabilities.systemRamGb
    ? `${Number(effectiveTunePodCapabilities.systemRamGb)} GB RAM • ${Number(effectiveTunePodCapabilities.cpuThreads || 0)} CPU cores${effectiveTunePodCapabilities.gpuVramGb ? ` • ${Number(effectiveTunePodCapabilities.gpuVramGb)} GB VRAM` : ''}`
    : 'Machine telemetry is still warming up.';
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
  const fallbackRemoteKeyEntries: JsonMap[] = [
    { id: 'openai', label: 'OpenAI', secretName: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1', available: false, detail: 'Hosted OpenAI models and compatibility endpoints.' },
    { id: 'huggingface', label: 'Hugging Face Router', secretName: 'HUGGINGFACE_API_KEY', baseUrl: 'https://router.huggingface.co/v1', available: false, detail: 'OpenAI-compatible router for hosted models plus Hugging Face discovery.' },
    { id: 'custom-compatible', label: 'Custom Compatible', secretName: 'OPENAI_COMPAT_API_KEY', baseUrl: '', available: false, detail: 'Bring your own OpenAI-compatible endpoint and secret slot.' },
  ];
  const keyPanelEntries: JsonMap[] = [];
  const seenKeyPanelIds = new Set<string>();
  for (const provider of (aiRemoteProviders.length ? aiRemoteProviders : fallbackRemoteKeyEntries)) {
    const id = String(provider?.id || provider?.secretName || '').trim();
    const secretName = String(provider?.secretName || provider?.apiKeyName || '').trim();
    if (!id || !secretName || seenKeyPanelIds.has(id)) {
      continue;
    }
    seenKeyPanelIds.add(id);
    keyPanelEntries.push({
      id,
      label: String(provider?.label || provider?.id || secretName),
      secretName,
      baseUrl: String(provider?.baseUrl || ''),
      summary: String(provider?.detail || provider?.summary || ''),
      available: provider?.available === true,
      kind: 'provider',
    });
  }
  if (!seenKeyPanelIds.has('huggingface-hub-token')) {
    keyPanelEntries.push({
      id: 'huggingface-hub-token',
      label: 'Hugging Face Hub token',
      secretName: 'HF_TOKEN',
      baseUrl: 'https://huggingface.co',
      summary: 'Used by Hugging Face Hub downloads and higher-rate model staging.',
      available: false,
      kind: 'download',
    });
  }
  const preferredKeyPanelId = keyPanelEntries.some((entry: JsonMap) => String(entry?.id || '') === selectedRemoteProviderId)
    ? selectedRemoteProviderId
    : String(keyPanelEntries.find((entry: JsonMap) => String(entry?.id || '') === 'huggingface')?.id || keyPanelEntries[0]?.id || '');
  const [keyPanelOpen, setKeyPanelOpen] = React.useState(false);
  const [keyPanelSelectedId, setKeyPanelSelectedId] = React.useState(preferredKeyPanelId);
  const [keyPanelDrafts, setKeyPanelDrafts] = React.useState<Record<string, string>>({});
  const [keyPanelPresence, setKeyPanelPresence] = React.useState<Record<string, boolean>>({});
  const [keyPanelBusySecretName, setKeyPanelBusySecretName] = React.useState('');
  const [keyPanelError, setKeyPanelError] = React.useState('');
  const [keyPanelMessage, setKeyPanelMessage] = React.useState('');
  const selectedKeyPanelEntry = keyPanelEntries.find((entry: JsonMap) => String(entry?.id || '') === keyPanelSelectedId) || keyPanelEntries[0] || null;
  const selectedKeyPanelSecretName = String(selectedKeyPanelEntry?.secretName || '').trim();
  const selectedKeyPanelDraft = selectedKeyPanelSecretName ? String(keyPanelDrafts[selectedKeyPanelSecretName] || '') : '';
  const selectedRemoteKeyConfigured = Object.prototype.hasOwnProperty.call(keyPanelPresence, providerSecretName)
    ? keyPanelPresence[providerSecretName] === true
    : selectedRemoteProvider?.available === true;
  const binaryUpdateState = String(binaryUpdates.state || 'idle').trim().toLowerCase();
  const binaryCurrentVersion = String(binaryUpdates.version || props.snapshot?.meta?.version || '').trim() || 'current build';
  const binaryAvailableVersion = String(binaryUpdates.availableVersion || '').trim() || 'not announced';
  const binaryFeedUrl = String(settings.releaseFeedUrl || binaryUpdates.feedUrl || '').trim();
  const binaryProgressPercent = Math.round(Number(binaryUpdates.progressPercent || 0));
  const binaryDownloaded = Boolean(binaryUpdates.downloaded) || String(binaryUpdates.localArtifactPath || '').trim().length > 0;
  const binaryConfigured = binaryUpdates.configured === true || binaryFeedUrl.length > 0 || binaryDownloaded;
  const binaryInstallLabel = String(binaryUpdates.localArtifactPath || '').trim() ? 'Open staged installer' : 'Install update';
  const autoInstallEnabled = settings.autoUpdateEnabled === true && settings.autoUpdateAutoApply === true;
  const activeTabMeta = SETTINGS_TAB_META[props.activeTab];
  const labsList = Array.isArray(props.labs?.labs) ? props.labs.labs : [];
  const learningEntries = Array.isArray(props.learningChanges?.entries) ? props.learningChanges.entries : [];
  const styleProfileSummary = String(props.learningStatus?.styleProfile?.summary || '').trim();
  const safeToolCount = props.tools.filter((tool: JsonMap) => String(tool?.safetyLevel || 'safe') === 'safe').length;
  const settingsHeroStats = [
    {
      label: 'Target workspace',
      value: shortPath(groupedWorkspace.currentTargetRoot) || 'No target selected',
      detail: groupedWorkspace.selectedLabRoot ? `Lab active: ${shortPath(groupedWorkspace.selectedLabRoot)}` : 'Real workspace is active.',
    },
    {
      label: 'Routing profile',
      value: String(props.aiStatus?.profileId || settings.aiProfile || 'hybrid-default'),
      detail: `${currentProvider} runtime${aiManualMode ? ' • custom mode' : ' • selector mode'}`,
    },
    {
      label: 'Safety level',
      value: String(activeSafetyLevel?.label || selectedSafetyLevel),
      detail: `${String(groupedAutonomy.profileId || 'supervised-auto')} autonomy profile`,
    },
    {
      label: 'Learning state',
      value: styleProfileSummary ? 'Profile active' : 'Warming up',
      detail: `${Number(props.learningStatus?.reusablePrompts?.length || 0)} reusable prompt${Number(props.learningStatus?.reusablePrompts?.length || 0) === 1 ? '' : 's'}`,
    },
  ];
  const activeTabHighlights = (() => {
    switch (props.activeTab) {
      case 'general':
        return [
          { label: 'Chat mode', value: String(settings.chatMode || 'auto') },
          { label: 'Theme', value: String(['codex', 'obsidian'].includes(settings.theme || '') ? settings.theme : 'codex') },
          { label: 'Updates', value: binaryDownloaded ? 'Ready to install' : (binaryUpdateState || 'idle') },
        ];
      case 'workspace':
        return [
          { label: 'Current target', value: shortPath(groupedWorkspace.currentTargetRoot) || 'None' },
          { label: 'VS Code', value: vscodeSetup?.ok ? 'Connected' : 'Needs setup' },
          { label: 'Runs', value: String(props.taskRuns.length) },
        ];
      case 'ai':
        return [
          { label: 'Provider', value: currentProvider },
          { label: 'Ready models', value: String(readyModelCount) },
          { label: 'Overrides', value: String(activeLaneOverrideCount) },
        ];
      case 'tunepod':
        return [
          { label: 'Current target', value: String(effectiveHardwareTargetMeta?.label || 'Current machine') },
          { label: 'Fits this target', value: String(compatibleTunePodPresets.length) },
          { label: 'Next unlock', value: localModelProgram.nextLayer.label },
        ];
      case 'autonomy':
        return [
          { label: 'Safety', value: String(activeSafetyLevel?.label || selectedSafetyLevel) },
          { label: 'Mode', value: String(groupedAutonomy.profileId || 'supervised-auto') },
          { label: 'Retries', value: String(groupedAutonomy.maxRetryRounds || 2) },
        ];
      case 'skills':
        return [
          { label: 'Installed skills', value: String(props.skills.length) },
          { label: 'Guidance', value: styleProfileSummary ? 'Learning active' : 'No style profile yet' },
          { label: 'Prompts', value: String(Number(props.learningStatus?.reusablePrompts?.length || 0)) },
        ];
      case 'extensions':
        return [
          { label: 'Starter items', value: String(integrationLibrary.length) },
          { label: 'Installed', value: String(installedIntegrations.length) },
          { label: 'Rollbacks', value: String(archivedAppBackups.length) },
        ];
      case 'tools':
        return [
          { label: 'Catalog size', value: String(props.tools.length) },
          { label: 'Safe tools', value: String(safeToolCount) },
          { label: 'Needs review', value: String(Math.max(props.tools.length - safeToolCount, 0)) },
        ];
      case 'automations':
        return [
          { label: 'Jobs', value: String(props.automations.length) },
          { label: 'Action', value: String(groupedAutomations.action || 'implement') },
          { label: 'Self improve', value: groupedAutomations.selfImprove ? 'Enabled' : 'Off' },
        ];
      case 'labs':
        return [
          { label: 'Known labs', value: String(labsList.length) },
          { label: 'Active target', value: shortPath(groupedWorkspace.selectedLabRoot) || 'Workspace' },
          { label: 'Benchmarks', value: String(Array.isArray(props.benchmarks?.runs) ? props.benchmarks.runs.length : 0) },
        ];
      case 'learning':
        return [
          { label: 'Style profile', value: styleProfileSummary ? 'Active' : 'Pending' },
          { label: 'Journal entries', value: String(learningEntries.length) },
          { label: 'Prompts', value: String(Number(props.learningStatus?.reusablePrompts?.length || 0)) },
        ];
      case 'storage':
      default:
        return [
          { label: 'Runs root', value: shortPath(groupedStorage.runsDir) || 'Unset' },
          { label: 'Labs root', value: shortPath(groupedStorage.labsRoot) || 'Unset' },
          { label: 'Benchmarks', value: shortPath(groupedStorage.benchmarkRoot) || 'Unset' },
        ];
    }
  })();

  const refreshKeyPanelPresence = useEffectEvent(async () => {
    const entries = keyPanelEntries.filter((entry: JsonMap) => String(entry?.secretName || '').trim());
    const results = await Promise.all(entries.map(async (entry: JsonMap) => {
      const secretName = String(entry.secretName || '').trim();
      const response = await window.gosAgent.getSecret(secretName);
      return [secretName, !!String(response?.value || '').trim()] as const;
    }));
    const nextPresence = results.reduce((accumulator, [secretName, configured]) => {
      accumulator[secretName] = configured;
      return accumulator;
    }, {} as Record<string, boolean>);
    setKeyPanelPresence(nextPresence);
  });

  const openKeyPanel = (preferredId = '') => {
    const nextSelectedId = keyPanelEntries.some((entry: JsonMap) => String(entry?.id || '') === preferredId)
      ? preferredId
      : preferredKeyPanelId;
    setKeyPanelSelectedId(nextSelectedId);
    setKeyPanelOpen(true);
    setKeyPanelError('');
    setKeyPanelMessage('');
    void refreshKeyPanelPresence();
  };

  const closeKeyPanel = () => {
    setKeyPanelOpen(false);
    setKeyPanelError('');
    setKeyPanelMessage('');
  };

  React.useEffect(() => {
    if (!keyPanelOpen) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setKeyPanelOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [keyPanelOpen]);

  const saveSelectedKeyPanelEntry = async () => {
    if (!selectedKeyPanelEntry || !selectedKeyPanelSecretName) {
      return;
    }
    const nextValue = String(keyPanelDrafts[selectedKeyPanelSecretName] || '').trim();
    if (!nextValue) {
      setKeyPanelError('Enter a key before saving it.');
      setKeyPanelMessage('');
      return;
    }
    setKeyPanelBusySecretName(selectedKeyPanelSecretName);
    setKeyPanelError('');
    setKeyPanelMessage('');
    try {
      await window.gosAgent.setSecret(selectedKeyPanelSecretName, nextValue);
      setKeyPanelDrafts((current) => ({ ...current, [selectedKeyPanelSecretName]: '' }));
      setKeyPanelPresence((current) => ({ ...current, [selectedKeyPanelSecretName]: true }));
      setKeyPanelMessage(`${selectedKeyPanelEntry.label || 'Key'} saved to ${selectedKeyPanelSecretName}.`);
      props.onRefresh();
    } catch (error) {
      setKeyPanelError(error instanceof Error ? error.message : 'Unable to save the key.');
    } finally {
      setKeyPanelBusySecretName('');
    }
  };

  const clearSelectedKeyPanelEntry = async () => {
    if (!selectedKeyPanelEntry || !selectedKeyPanelSecretName) {
      return;
    }
    setKeyPanelBusySecretName(selectedKeyPanelSecretName);
    setKeyPanelError('');
    setKeyPanelMessage('');
    try {
      await window.gosAgent.setSecret(selectedKeyPanelSecretName, '');
      setKeyPanelDrafts((current) => ({ ...current, [selectedKeyPanelSecretName]: '' }));
      setKeyPanelPresence((current) => ({ ...current, [selectedKeyPanelSecretName]: false }));
      setKeyPanelMessage(`${selectedKeyPanelEntry.label || 'Key'} cleared from ${selectedKeyPanelSecretName}.`);
      props.onRefresh();
    } catch (error) {
      setKeyPanelError(error instanceof Error ? error.message : 'Unable to clear the key.');
    } finally {
      setKeyPanelBusySecretName('');
    }
  };

  return (
    <section className="module-panel settings-panel-v2" data-panel="settings">
      <div className="settings-shell">
        <section className="settings-hero">
          <div className="settings-hero-main">
            <div>
              <div className="eyebrow">Unified settings center</div>
              <h2>Keep chat clean and move the system controls here</h2>
              <p>AI, autonomy, workspace targeting, tools, labs, learning, and diagnostics all live behind one modular settings surface.</p>
            </div>
            <div className="row-actions settings-hero-actions">
              <button className="ghost" onClick={props.onRefresh}>Refresh</button>
              <button className="primary" onClick={props.onPickWorkspace}>Pick workspace</button>
            </div>
          </div>
          <div className="settings-hero-grid">
            {settingsHeroStats.map((item) => (
              <article key={item.label} className="settings-hero-card">
                <div className="eyebrow">{item.label}</div>
                <strong>{item.value}</strong>
                <p>{item.detail}</p>
              </article>
            ))}
          </div>
        </section>

        <div className="settings-layout">
          <aside className="settings-sidebar" aria-label="Settings sections">
            {SETTINGS_NAV_GROUPS.map((group) => (
              <section key={group.id} className="settings-nav-group">
                <div className="settings-nav-group-label">{group.label}</div>
                <div className="settings-nav-list">
                  {group.tabs.map((tab) => {
                    const meta = SETTINGS_TAB_META[tab];
                    return (
                      <button
                        key={tab}
                        className={`settings-nav-button${props.activeTab === tab ? ' active' : ''}`}
                        data-settings-tab={tab}
                        aria-pressed={props.activeTab === tab}
                        onClick={() => props.onSetActiveTab(tab)}
                      >
                        <UiIcon name={meta.icon} className="settings-nav-icon" />
                        <div className="settings-nav-copy">
                          <strong>{meta.navLabel}</strong>
                          <span>{meta.eyebrow}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </aside>

          <div className="settings-main">
            <section className="settings-focus-card">
              <div className="settings-focus-copy">
                <div className="settings-focus-heading">
                  <div className="settings-focus-icon-wrap">
                    <UiIcon name={activeTabMeta.icon} className="settings-focus-icon" />
                  </div>
                  <div>
                    <div className="eyebrow">{activeTabMeta.eyebrow}</div>
                    <h3>{activeTabMeta.title}</h3>
                    <p>{activeTabMeta.description}</p>
                  </div>
                </div>
              </div>
              <div className="settings-highlight-grid">
                {activeTabHighlights.map((item) => (
                  <article key={item.label} className="settings-highlight-card">
                    <div className="eyebrow">{item.label}</div>
                    <strong>{item.value}</strong>
                  </article>
                ))}
              </div>
            </section>

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
          <section className="queue-card">
            <div className="panel-header">
              <div>
                <div className="eyebrow">Update Center</div>
                <h2>Install desktop updates without leaving the app</h2>
                <p>{String(binaryUpdates.message || 'Connect a release feed or stage a local release so the desktop shell can check, download, and install updates here.')}</p>
              </div>
            </div>
            <div className="settings-grid">
              <label>
                <span>Release feed URL</span>
                <input
                  defaultValue={binaryFeedUrl}
                  placeholder="https://updates.example.com/live"
                  onBlur={(event) => void props.onUpdateSetting('releaseFeedUrl', event.target.value)}
                />
              </label>
              <label>
                <span>Auto-check interval minutes</span>
                <input
                  type="number"
                  min={5}
                  max={240}
                  value={String(settings.autoUpdateIntervalMinutes || 30)}
                  onChange={(event) => void props.onUpdateSetting('autoUpdateIntervalMinutes', Number(event.target.value || 30))}
                />
              </label>
            </div>
            <div className="toggle-grid">
              <label className="toggle-row">
                <input type="checkbox" checked={settings.releaseAutoDownload === true} onChange={(event) => void props.onUpdateSetting('releaseAutoDownload', event.target.checked)} />
                <span>Auto-download desktop releases when one is found</span>
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={autoInstallEnabled}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    void props.onUpdateSetting('autoUpdateEnabled', checked);
                    void props.onUpdateSetting('autoUpdateAutoApply', checked);
                    if (checked && settings.releaseAutoDownload !== true) {
                      void props.onUpdateSetting('releaseAutoDownload', true);
                    }
                  }}
                />
                <span>Install downloaded updates automatically when the app is idle and safe</span>
              </label>
            </div>
            <div className="card-grid">
              <article className="metric-card">
                <div className="eyebrow">Desktop update status</div>
                <strong>{binaryUpdateState || 'idle'}</strong>
                <p>{binaryConfigured ? 'Updater is configured for this build.' : 'Add a feed URL or stage a local installer to enable in-app desktop updates.'}</p>
              </article>
              <article className="metric-card">
                <div className="eyebrow">Current version</div>
                <strong>{binaryCurrentVersion}</strong>
                <p>{binaryAvailableVersion !== 'not announced' ? `Latest announced: ${binaryAvailableVersion}` : 'No newer desktop release is announced yet.'}</p>
              </article>
              <article className="metric-card">
                <div className="eyebrow">Download state</div>
                <strong>{binaryDownloaded ? 'Ready to install' : (binaryUpdateState === 'downloading' ? `${binaryProgressPercent}%` : 'Waiting')}</strong>
                <p>{String(binaryUpdates.localArtifactPath || '').trim() ? 'A staged local installer is ready.' : 'Feed-downloaded releases can install directly from the app once they are ready.'}</p>
              </article>
              <article className="metric-card">
                <div className="eyebrow">Rollback readiness</div>
                <strong>{updateRecovery.rollbackReady ? (shortPath(String(updateRecovery.latestBackupId || '')) || 'Ready') : 'Not staged'}</strong>
                <p>{String(updateRecovery.summary || 'No workspace update rollback snapshot is recorded yet.')}</p>
              </article>
            </div>
            <div className="row-actions">
              <button className="ghost" onClick={() => void props.onCheckBinaryUpdate()} disabled={props.binaryUpdateBusy}>
                {props.binaryUpdateBusy && binaryUpdateState === 'checking' ? 'Checking…' : 'Check for updates'}
              </button>
              <button className="ghost" onClick={() => void props.onDownloadBinaryUpdate()} disabled={props.binaryUpdateBusy || (!binaryConfigured && !binaryDownloaded) || binaryDownloaded}>
                {props.binaryUpdateBusy && binaryUpdateState === 'downloading' ? `Downloading ${binaryProgressPercent}%` : 'Download update'}
              </button>
              <button className="primary" onClick={() => void props.onInstallBinaryUpdate()} disabled={props.binaryUpdateBusy || !binaryDownloaded}>
                {props.binaryUpdateBusy && binaryUpdateState === 'installing' ? 'Installing…' : binaryInstallLabel}
              </button>
            </div>
          </section>
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
                onClick={() => void window.gosAgent.installWorkspaceVsCodeCompanion({
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
              <div className="eyebrow">{AI_ROUTE_COPY.overrideMetricLabel}</div>
              <strong>{activeLaneOverrideCount}</strong>
              <p>{activeLaneOverrideCount > 0 ? AI_ROUTE_COPY.overrideMetricActiveSummary : AI_ROUTE_COPY.overrideMetricIdleSummary}</p>
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
              <span>Route plan</span>
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
                  <input value={`${selectedRemoteKeyConfigured ? 'Configured' : 'Missing'} • ${providerSecretName}`} readOnly />
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
                  <input value={`${selectedRemoteKeyConfigured ? 'Configured' : 'Missing'} • ${providerSecretName}`} readOnly />
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
            <button className="ghost" onClick={() => openKeyPanel(selectedRemoteProviderId)}>
              API keys
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
            {activeLaneOverrideCount > 0 ? <button className="ghost" onClick={() => void props.onUpdateSetting('aiLaneOverrides', {})}>{AI_ROUTE_COPY.resetOverridesLabel}</button> : null}
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
          {keyPanelOpen ? (
            <div className="modal-scrim" data-api-key-modal="true" onClick={closeKeyPanel}>
              <section
                className="settings-modal api-key-modal"
                role="dialog"
                aria-modal="true"
                aria-label="API keys"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="settings-modal-header">
                  <div>
                    <div className="eyebrow">Secure key manager</div>
                    <h2>API keys</h2>
                    <p>Keys are stored through the desktop secret store. Use Hugging Face Router for hosted models and HF_TOKEN for Hub downloads.</p>
                  </div>
                  <div className="row-actions">
                    <button className="ghost" onClick={() => void refreshKeyPanelPresence()}>Refresh status</button>
                    <button className="ghost" onClick={closeKeyPanel}>Close</button>
                  </div>
                </div>
                <div className="api-key-modal-layout">
                  <div className="api-key-provider-list">
                    {keyPanelEntries.map((entry: JsonMap) => {
                      const entryId = String(entry.id || '');
                      const entrySecretName = String(entry.secretName || '');
                      const configured = Object.prototype.hasOwnProperty.call(keyPanelPresence, entrySecretName)
                        ? keyPanelPresence[entrySecretName] === true
                        : entry.available === true;
                      return (
                        <button
                          key={entryId}
                          className={`api-key-provider-button${keyPanelSelectedId === entryId ? ' active' : ''}`}
                          onClick={() => {
                            setKeyPanelSelectedId(entryId);
                            setKeyPanelError('');
                            setKeyPanelMessage('');
                          }}
                        >
                          <strong>{String(entry.label || entry.id || 'Key')}</strong>
                          <span>{entrySecretName}</span>
                          <small>{configured ? 'Configured' : 'Missing'}</small>
                        </button>
                      );
                    })}
                  </div>
                  <div className="api-key-editor">
                    {selectedKeyPanelEntry ? (
                      <>
                        <div className="card-grid compact">
                          <article className="metric-card compact">
                            <div className="eyebrow">Selected key</div>
                            <strong>{String(selectedKeyPanelEntry.label || selectedKeyPanelEntry.id || 'Key')}</strong>
                            <p>{String(selectedKeyPanelEntry.summary || 'Store this secret securely for the current desktop profile.')}</p>
                          </article>
                          <article className="metric-card compact">
                            <div className="eyebrow">Secret slot</div>
                            <strong>{selectedKeyPanelSecretName}</strong>
                            <p>{String(selectedKeyPanelEntry.baseUrl || 'Stored locally in encrypted desktop secrets.')}</p>
                          </article>
                        </div>
                        <label>
                          <span>Provider API key</span>
                          <input
                            type="password"
                            value={selectedKeyPanelDraft}
                            onChange={(event) => setKeyPanelDrafts((current) => ({
                              ...current,
                              [selectedKeyPanelSecretName]: event.target.value,
                            }))}
                            placeholder={`Save to ${selectedKeyPanelSecretName}`}
                          />
                        </label>
                        <div className="api-key-status-row">
                          <span className={`status-pill${(Object.prototype.hasOwnProperty.call(keyPanelPresence, selectedKeyPanelSecretName) ? keyPanelPresence[selectedKeyPanelSecretName] === true : selectedKeyPanelEntry.available === true) ? ' ready' : ''}`}>
                            {(Object.prototype.hasOwnProperty.call(keyPanelPresence, selectedKeyPanelSecretName) ? keyPanelPresence[selectedKeyPanelSecretName] === true : selectedKeyPanelEntry.available === true) ? 'Configured' : 'Missing'}
                          </span>
                          <span>{selectedKeyPanelEntry.id === 'huggingface-hub-token' ? 'Use this token for Hugging Face Hub downloads and higher rate limits.' : 'Use this key for the selected hosted provider route.'}</span>
                        </div>
                        {keyPanelError ? <p className="api-key-feedback error">{keyPanelError}</p> : null}
                        {keyPanelMessage ? <p className="api-key-feedback success">{keyPanelMessage}</p> : null}
                        <div className="row-actions">
                          <button
                            className="primary"
                            disabled={!selectedKeyPanelSecretName || keyPanelBusySecretName === selectedKeyPanelSecretName || !selectedKeyPanelDraft.trim()}
                            onClick={() => void saveSelectedKeyPanelEntry()}
                          >
                            {keyPanelBusySecretName === selectedKeyPanelSecretName ? 'Saving key…' : `Save ${String(selectedKeyPanelEntry.label || 'key')}`}
                          </button>
                          <button
                            className="ghost"
                            disabled={!selectedKeyPanelSecretName || keyPanelBusySecretName === selectedKeyPanelSecretName}
                            onClick={() => void clearSelectedKeyPanelEntry()}
                          >
                            Clear key
                          </button>
                        </div>
                      </>
                    ) : (
                      <p className="empty-copy">No provider key slots are available yet.</p>
                    )}
                  </div>
                </div>
              </section>
            </div>
          ) : null}
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
                <div className="eyebrow">{AI_ROUTE_COPY.capabilityRoutesEyebrow}</div>
                <h2>{AI_ROUTE_COPY.capabilityRoutesTitle}</h2>
                <p>{AI_ROUTE_COPY.capabilityRoutesSummary}</p>
              </div>
            </div>
            <div className="card-grid lane-grid">
              {capabilityLanes.map((lane: JsonMap) => (
                <article key={String(lane.id)} className="metric-card lane-card">
                  <div className="eyebrow">{AI_ROUTE_COPY.routeCardEyebrow}</div>
                  <strong>{lane.label || lane.id}</strong>
                  <p>{lane.summary}</p>
                  <div className="lane-summary">
                    <span>{lane.provider || 'provider'} • {lane.preferredModel || 'model pending'}</span>
                    <span>{lane.sourceLabel || (lane.source === 'override' ? AI_ROUTE_COPY.routeSourceOverride : AI_ROUTE_COPY.routeSourceInherited)}</span>
                    <span>Default: {lane.defaultProvider || 'provider'} • {lane.defaultModel || 'model pending'}</span>
                  </div>
                  <label className="lane-select-row">
                    <span>{AI_ROUTE_COPY.routeSelectLabel}</span>
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
                        {AI_ROUTE_COPY.routeResetLabel}
                      </button>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
          <section className="queue-card">
            <div className="eyebrow">Workbench handoff</div>
            <div className="run-item">
              <strong>Deep health, benchmarks, recovery, and debug exports moved to Workbench.</strong>
              <span>Keep AI settings focused on selectors and lane tuning here, then use Workbench for the live operational view.</span>
            </div>
          </section>
        </section>
      ) : null}

      {props.activeTab === 'tunepod' ? (
        <section className="settings-section">
          <div className="card-grid">
            <article className="metric-card active">
              <div className="eyebrow">Current machine fit</div>
              <strong>{String(machineProfile.label || 'Machine profile pending')}</strong>
              <p>{machineProfileFootprint}{machineProfile.summary ? ` • ${String(machineProfile.summary)}` : ''}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Selected Tune Pod target</div>
              <strong>{String(selectedHardwareTargetMeta?.label || 'Current machine')}</strong>
              <p>{String(selectedHardwareTargetMeta?.summary || 'The selected target controls which local model presets count as a good fit.')}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Local route block</div>
              <strong>{`${localModelProgram.verifiedCount}/${localModelProgram.layers.length} verified`}</strong>
              <p>{localModelProgram.summary}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Compatible local options</div>
              <strong>{compatibleTunePodPresets.length}</strong>
              <p>{compatibleTunePodPresets.length > 0 ? 'These presets match the current hardware target.' : 'No curated presets match this target yet.'}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Local inventory</div>
              <strong>{`${Number(tuningLifecycle.readyCount || 0)} ready • ${Number(tuningLifecycle.localCount || 0)} tracked`}</strong>
              <p>{String(tuningLifecycle.summary || 'Import or stage local models to start proving the daily coding loop.')}</p>
            </article>
            <article className="metric-card">
              <div className="eyebrow">Remote reduction</div>
              <strong>{remoteReductionUnlock ? localModelProgramStatusLabel(remoteReductionUnlock.status) : (remoteFallbackReady ? 'Configured' : 'Locked')}</strong>
              <p>{remoteReductionUnlock?.summary || (remoteFallbackReady ? 'Remote is configured as a fallback path, not the daily default.' : 'Add a remote fallback only if you need compare or overflow coverage.')}</p>
            </article>
          </div>
          <div className="settings-grid">
            <label>
              <span>Tune Pod target</span>
              <select value={selectedHardwareTarget} onChange={(event) => void props.onUpdateSetting('trainingHardwareTarget', event.target.value)}>
                {(targetHardwareOptions.length ? targetHardwareOptions : [{ id: 'auto', label: 'Current machine' }]).map((target: JsonMap) => (
                  <option key={String(target.id || '')} value={String(target.id || '')}>{String(target.label || target.id || '')}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Route plan</span>
              <input value={routePolicyLabel} readOnly />
            </label>
            <label>
              <span>Primary local model</span>
              <input value={String(settings.trainingOllamaModel || derivedModelLabel || 'qwen2.5-coder:7b')} readOnly />
            </label>
            <label>
              <span>Remote fallback</span>
              <input value={remoteFallbackReady ? `${String(selectedRemoteProvider?.label || 'Remote')} • ${selectedRemoteModel || 'model pending'}` : 'Fallback not configured'} readOnly />
            </label>
          </div>
          <section className="queue-card">
            <div className="panel-header">
              <div>
                <div className="eyebrow">Tune Pod route plan</div>
                <h2>Keep local-first visible while remote shrinks to backup</h2>
                <p>{routePolicySummary || 'Tune Pod keeps the route proof visible so the operator can widen local capability intentionally instead of drifting back to remote-by-default.'}</p>
              </div>
            </div>
            <div className="run-item">
              <strong>{routePolicyLabel}</strong>
              <span>{localModelProgram.summary}</span>
            </div>
            <div className="run-item">
              <strong>Benchmark leader</strong>
              <span>{benchmarkLeader ? `${String(benchmarkLeader.model || 'model')} • ${Number(benchmarkLeader.passRate || 0)}% pass • ${Number(benchmarkLeader.averageLatencyMs || 0)}ms avg latency` : 'Run a benchmark to compare local candidates against the current route.'}</span>
            </div>
            <div className="run-item">
              <strong>Remote fallback posture</strong>
              <span>{remoteFallbackReady ? `${String(selectedRemoteProvider?.label || 'Remote')} with ${selectedRemoteModel || 'a selected model'} is available for compare, overflow, or approval only.` : 'No remote fallback is configured yet. The current plan depends entirely on local readiness.'}</span>
            </div>
            <div className="run-item">
              <strong>Local inventory status</strong>
              <span>{String(tuningLifecycle.summary || 'No local inventory summary is available yet.')}</span>
            </div>
          </section>
          <section className="queue-card">
            <div className="panel-header">
              <div>
                <div className="eyebrow">Hardware target tiers</div>
                <h2>Match the target before you pull heavier local models</h2>
                <p>These tiers are the requirement blocks the repo actually tracks today. Tune Pod uses them to sort good-fit models from models that belong on a larger machine.</p>
              </div>
            </div>
            <div className="card-grid">
              {(targetHardwareOptions.length ? targetHardwareOptions : [{ id: 'auto', label: 'Current machine', summary: 'Use the current machine as the tuning reference.' }]).map((target: JsonMap) => {
                const targetId = String(target.id || '');
                const isSelectedTarget = targetId === selectedHardwareTarget;
                const isEffectiveTarget = targetId === effectiveHardwareTargetId;
                return (
                  <article key={targetId} className={`metric-card${isSelectedTarget || isEffectiveTarget ? ' active' : ''}`}>
                    <div className="eyebrow">{isEffectiveTarget ? 'Current fit tier' : isSelectedTarget ? 'Selected target' : 'Target tier'}</div>
                    <strong>{String(target.label || target.id || 'Target')}</strong>
                    <p>{String(target.summary || 'Target summary unavailable.')}</p>
                    <div className="row-actions">
                      {isSelectedTarget ? <span className="status-pill ready">Selected in Tune Pod</span> : null}
                      {isEffectiveTarget ? <span className="status-pill ready">Current machine fit</span> : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
          <section className="queue-card">
            <div className="panel-header">
              <div>
                <div className="eyebrow">Fits this PC</div>
                <h2>Compatible local models for the active Tune Pod target</h2>
                <p>Tune Pod promotes the presets that match the current fit tier first so the local route can get stronger before you widen to heavier families.</p>
              </div>
            </div>
            {compatibleTunePodPresets.slice(0, 8).map((preset: JsonMap) => {
              const targetLabels = tunePodPresetTargetLabels(preset);
              const presetModel = String(preset.ollamaModel || '');
              const isReady = presetModel ? tunePodReadyModelSet.has(presetModel) : false;
              return (
                <div key={String(preset.id || preset.label)} className="run-item">
                  <strong>{String(preset.label || preset.id || 'Preset')}</strong>
                  <span>
                    {String(preset.sizeLabel || 'size pending')}
                    {preset.sourceLabel ? ` • ${String(preset.sourceLabel)}` : ''}
                    {preset.requirementSummary ? ` • ${String(preset.requirementSummary)}` : ''}
                    {targetLabels.length > 0 ? ` • Fits ${targetLabels.join(' • ')}` : ''}
                    {isReady ? ' • ready locally' : ' • import needed'}
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
              );
            })}
            {compatibleTunePodPresets.length === 0 ? <p className="empty-copy">Tune Pod does not have a curated fit for this target yet. Pick a smaller target or import a lighter local family first.</p> : null}
          </section>
          <section className="queue-card">
            <div className="panel-header">
              <div>
                <div className="eyebrow">Better on bigger hardware</div>
                <h2>Models that do not currently fit this Tune Pod target</h2>
                <p>If a model does not match the active target, Tune Pod keeps it visible but marks which larger tiers it belongs to so you do not waste time staging the wrong family.</p>
              </div>
            </div>
            {incompatibleTunePodPresets.slice(0, 8).map((preset: JsonMap) => {
              const targetLabels = tunePodPresetTargetLabels(preset);
              const fit = tunePodPresetFit(preset);
              return (
                <div key={String(preset.id || preset.label)} className="run-item">
                  <strong>{String(preset.label || preset.id || 'Preset')}</strong>
                  <span>
                    {String(preset.sizeLabel || 'size pending')}
                    {preset.requirementSummary ? ` • ${String(preset.requirementSummary)}` : ''}
                    {fit.blockers.length > 0 ? ` • Needs ${fit.blockers.join(' • ')}` : ''}
                    {targetLabels.length > 0 ? ` • Better on ${targetLabels.join(' • ')}` : ' • Use a larger hardware tier'}
                    {preset.sourceLabel ? ` • ${String(preset.sourceLabel)}` : ''}
                  </span>
                </div>
              );
            })}
            {incompatibleTunePodPresets.length === 0 ? <p className="empty-copy">Everything in the curated preset list currently fits this target tier.</p> : null}
          </section>
          <section className="queue-card">
            <div className="eyebrow">{AI_ROUTE_COPY.ladderEyebrow}</div>
            <div className="run-item">
              <strong>{`${localModelProgram.verifiedCount}/${localModelProgram.layers.length} verified`}</strong>
              <span>{localModelProgram.summary}</span>
            </div>
            {localModelProgram.layers.map((layer: { id: string; label: string; status: string; summary: string; unlockRule: string }) => (
              <div key={layer.id} className="run-item">
                <strong>{layer.label}</strong>
                <span>{`${localModelProgramStatusLabel(layer.status)} • ${layer.summary}`}</span>
                <div className="row-actions">
                  <span className={`status-pill${layer.status === 'verified' ? ' ready' : ''}`}>{localModelProgramStatusLabel(layer.status)}</span>
                  <span className="status-pill">{layer.unlockRule}</span>
                </div>
              </div>
            ))}
            <p className="empty-copy">{AI_ROUTE_COPY.ladderSummary}</p>
          </section>
          <section className="queue-card">
            <div className="eyebrow">{AI_ROUTE_COPY.unlockEyebrow}</div>
            <div className="run-item">
              <strong>{localModelProgram.nextLayer.label}</strong>
              <span>{localModelProgram.nextLayer.unlockRule}</span>
            </div>
            {localModelProgram.unlocks.map((unlock: { id: string; label: string; status: string; summary: string }) => (
              <div key={unlock.id} className="run-item">
                <strong>{unlock.label}</strong>
                <span>{`${localModelProgramStatusLabel(unlock.status)} • ${unlock.summary}`}</span>
              </div>
            ))}
            <p className="empty-copy">{AI_ROUTE_COPY.unlockSummary}</p>
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
              <p>{appRollbackSummary || String(props.snapshot?.settings?.storage?.appRollbackRoot || appRollbacks.root || 'Desktop app rollbacks will be archived outside /Applications so the live install stays clean.')}</p>
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
          </div>
        </div>
      </div>
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
  tools: JsonMap[];
  taskList: JsonMap[];
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
  onQuickChat: (command: string) => void;
  onCreateSuggestedTask: (candidate: JsonMap) => Promise<void>;
  onQueueSuggestedRecipe: (recipe: JsonMap) => Promise<void>;
  onRecordOperatorFeedback: (payload: JsonMap) => Promise<void>;
  onOpenSettingsTab: (tab: SettingsTabId) => void;
  onBootstrapVsCode: () => void;
  onInstallVsCodeCompanion: () => void;
  onOpenWorkspaceInVsCode: () => void;
  onOpenActiveFileInVsCode: () => void;
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
  const promotionRecoverySummary = backups[0]?.id
    ? `Rollback backup ${String(backups[0].id || '')} is ready if the current promotion needs to unwind.`
    : 'No promotion backup is recorded yet.';
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
  const localModelProgram = buildLocalModelProgramView(props.snapshot, props.aiStatus, props.tuning);
  const supervisionSignals = Array.isArray(operatorSupervision.signals) ? operatorSupervision.signals : [];
  const testBenchFollowups = Array.isArray(testBench.followups) ? testBench.followups : [];
  const nextSafeAction = testBench.nextSafeAction && typeof testBench.nextSafeAction === 'object'
    ? testBench.nextSafeAction
    : {};
  const safeRecipe = testBench.safeRecipe && typeof testBench.safeRecipe === 'object'
    ? testBench.safeRecipe
    : {};
  const latestTaskRunLabel = String(taskRuns[0]?.runtimeLabel || taskRuns[0]?.label || taskRuns[0]?.title || '').trim();
  const changedFiles = Array.isArray(testBench.changedFiles) ? testBench.changedFiles : [];
  const failingLocations = Array.isArray(testBench.failingLocations) ? testBench.failingLocations : [];
  const previewPath = String(
    testBench.preferredPath
    || changedFiles[0]?.path
    || reviewer.notes?.[0]?.path
    || ''
  ).trim();
  const previewTitle = String(
    latestTaskRunLabel
    || testBench.summary
    || reviewer.summary
    || 'Latest workspace run'
  ).trim();
  const previewLines = [
    `// ${previewTitle || 'Workbench preview'}`,
    previewPath ? `target_file("${previewPath.replace(/\\/g, '/')}" )` : 'target_file("workspace task")',
    latestTaskRunLabel ? `run_label("${latestTaskRunLabel}")` : 'run_label("Task detail")',
    `state("${String(taskRuns[0]?.runtimeState || taskRuns[0]?.status || testBench.status || 'ready')}")`,
    '',
    ...(changedFiles.slice(0, 5).map((item: JsonMap, index: number) => `${index + 1}. change(${JSON.stringify(shortPath(String(item?.path || item || 'changed file')))});`)),
    ...(changedFiles.length === 0 ? ['1. change("No changed files recorded yet.");'] : []),
    '',
    ...(failingLocations.slice(0, 4).map((item: JsonMap) => `validate(${JSON.stringify(`${shortPath(String(item?.path || 'finding'))} line ${Number(item?.line || 1)}: ${String(item?.message || 'finding')}`)});`)),
    ...(failingLocations.length === 0 ? ['validate("Focused proof is clear or not yet recorded.");'] : []),
  ];
  const validationCards: Array<{ label: string; detail: string; status: string }> = failingLocations.length > 0
    ? failingLocations.slice(0, 4).map((item: JsonMap) => ({
        label: shortPath(String(item?.path || 'Validation finding')) || 'Validation finding',
        detail: `line ${Number(item?.line || 1)} • ${String(item?.message || 'Validation finding')}`,
        status: 'needs review',
      }))
    : (Array.isArray(acceptance?.checks) ? acceptance.checks.slice(0, 4).map((check: JsonMap) => ({
        label: String(check?.label || check?.id || 'Check'),
        detail: summarizeText(String(check?.summary || 'Validation check'), 90),
        status: String(check?.status || 'unknown'),
      })) : []);
  const workbenchTabLabels: Record<MonitorTabId, string> = {
    overview: 'Overview',
    runs: 'Tasks',
    learning: 'Learning',
    promotions: 'Recovery',
    debug: 'Artifacts',
    ide: 'IDE',
  };
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
          <div className="eyebrow">Workbench</div>
          <h2>Inspect active tasks, run history, changes, and proof</h2>
          <p>Execution details, recovery state, IDE lanes, and deeper artifacts stay here so chat can stay calm.</p>
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
            {workbenchTabLabels[tab]}
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
            <div className="eyebrow">{AI_ROUTE_COPY.ladderEyebrow}</div>
            <div className="run-item">
              <strong>{`${localModelProgram.verifiedCount}/${localModelProgram.layers.length} verified`}</strong>
              <span>{localModelProgram.summary}</span>
            </div>
            {localModelProgram.layers.map((layer: { id: string; label: string; status: string; summary: string; unlockRule: string }) => (
              <div key={layer.id} className="run-item">
                <strong>{layer.label}</strong>
                <span>{`${localModelProgramStatusLabel(layer.status)} • ${layer.summary}`}</span>
                <div className="chip-row">
                  <span className="chip">{localModelProgramStatusLabel(layer.status)}</span>
                  <span className="chip">{layer.unlockRule}</span>
                </div>
              </div>
            ))}
            <p className="empty-copy">{AI_ROUTE_COPY.ladderSummary}</p>
          </section>
          <section className="queue-card">
            <div className="eyebrow">{AI_ROUTE_COPY.unlockEyebrow}</div>
            <div className="run-item">
              <strong>{localModelProgram.nextLayer.label}</strong>
              <span>{localModelProgram.nextLayer.unlockRule}</span>
            </div>
            {localModelProgram.unlocks.map((unlock: { id: string; label: string; status: string; summary: string }) => (
              <div key={unlock.id} className="run-item">
                <strong>{unlock.label}</strong>
                <span>{`${localModelProgramStatusLabel(unlock.status)} • ${unlock.summary}`}</span>
              </div>
            ))}
            <p className="empty-copy">{AI_ROUTE_COPY.unlockSummary}</p>
          </section>
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
            <div className="run-item">
              <strong>Recovery state</strong>
              <span>{promotionRecoverySummary}</span>
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
          <section className="workbench-review-shell">
            <div className="workbench-review-tabs">
              {['Output', 'Diffs', 'Tests', 'IDE'].map((tab) => (
                <button key={tab} className={tab === 'Diffs' ? 'active' : ''}>{tab}</button>
              ))}
            </div>
            <div className="workbench-review-layout">
              <article className="workbench-preview-stage">
                <div className="workbench-preview-stage-header">
                  <div>
                    <div className="eyebrow">Selected task</div>
                    <strong>{previewTitle || 'Latest workspace run'}</strong>
                  </div>
                  <span className="status-pill">{String(taskRuns[0]?.runtimeState || taskRuns[0]?.status || testBench.status || 'ready')}</span>
                </div>
                <pre className="workbench-code-preview">{previewLines.join('\n')}</pre>
              </article>

              <aside className="workbench-review-side">
                <section className="workbench-result-card">
                  <div className="eyebrow">Result preview</div>
                  <strong>{latestTaskRunLabel || testBench.status || 'Ready for review'}</strong>
                  <p>{String(testBench.summary || reviewer.summary || 'Review the current task, touched files, and focused proof from this surface.')}</p>
                  <div className="chip-row">
                    {previewPath ? <button className="ghost" onClick={() => props.onOpenReviewPath(previewPath, 'workbench-preview')}>Open file</button> : null}
                    <button className="ghost" onClick={() => props.onSetActiveTab('ide')}>Open IDE lane</button>
                  </div>
                </section>

                <section className="workbench-validation-card">
                  <div className="eyebrow">Validation checks</div>
                  {validationCards.map((item, index) => (
                    <div key={`${item.label}-${index}`} className="workbench-validation-item">
                      <strong>{item.label}</strong>
                      <span>{item.detail}</span>
                      <small>{item.status}</small>
                    </div>
                  ))}
                  {validationCards.length === 0 ? <p className="empty-copy">Focused validation results will land here after the next run.</p> : null}
                </section>
              </aside>
            </div>
          </section>

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
              <p>{promotionRecoverySummary}</p>
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

      {props.activeTab === 'ide' ? (
        <IDEPanel
          snapshot={props.snapshot}
          tools={props.tools}
          taskList={props.taskList}
          taskRuns={taskRuns}
          onQuickChat={props.onQuickChat}
          onRefresh={props.onRefresh}
          onOpenSettingsTab={props.onOpenSettingsTab}
          onOpenMonitorTab={props.onSetActiveTab}
          onBootstrapVsCode={props.onBootstrapVsCode}
          onInstallVsCodeCompanion={props.onInstallVsCodeCompanion}
          onOpenWorkspaceInVsCode={props.onOpenWorkspaceInVsCode}
          onOpenActiveFileInVsCode={props.onOpenActiveFileInVsCode}
        />
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
