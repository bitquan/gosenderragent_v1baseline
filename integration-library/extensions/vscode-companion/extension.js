'use strict';

const fs = require('fs');
const path = require('path');

let vscodeModule = null;
let workbenchController = null;

const WORKBENCH_VIEW_CONTAINER_ID = 'gosenderrSidebar';
const WORKBENCH_VIEW_ID = 'gosenderr.workbenchView';
const WORKBENCH_SURFACE_SIDEBAR = 'sidebar';
const WORKBENCH_SURFACE_PANEL = 'panel';
const COMPANION_CHAT_MODE_KEY = 'gosenderr.companion.chatMode';
const COMPANION_CHAT_MODES = ['auto', 'ask', 'plan', 'edit', 'agent'];

const DEFAULT_CHAT_MODE_CONFIG = Object.freeze({
  auto: {
    id: 'auto',
    label: 'Auto',
    meta: 'Let the manager pick the right behavior for the request and current safety state.',
    allowsExecution: true,
    requiresEditConfirmation: false,
  },
  ask: {
    id: 'ask',
    label: 'Ask',
    meta: 'Human-style help, explanation, and repo guidance only.',
    allowsExecution: false,
    requiresEditConfirmation: false,
  },
  plan: {
    id: 'plan',
    label: 'Plan',
    meta: 'Scoped planning, risks, and next steps without launching work.',
    allowsExecution: false,
    requiresEditConfirmation: false,
  },
  edit: {
    id: 'edit',
    label: 'Edit',
    meta: 'Prepare code changes and diffs, but require explicit confirmation before execution.',
    allowsExecution: false,
    requiresEditConfirmation: true,
  },
  agent: {
    id: 'agent',
    label: 'Agent',
    meta: 'Bounded execution through the safe engine loop only when current gates allow it.',
    allowsExecution: true,
    requiresEditConfirmation: false,
  },
});

function getVsCode() {
  if (!vscodeModule) {
    vscodeModule = require('vscode');
  }
  return vscodeModule;
}

function setVsCodeModuleForTests(moduleOrNull = null) {
  vscodeModule = moduleOrNull || null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clipText(value, maxLength = 220) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}…` : text;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hasRepoMarkers(targetRoot) {
  const root = String(targetRoot || '').trim();
  if (!root) {
    return false;
  }
  return (
    fs.existsSync(path.join(root, 'package.json'))
    && fs.existsSync(path.join(root, 'main.js'))
    && fs.existsSync(path.join(root, 'shared-runtime', 'agent-runtime-client.js'))
    && fs.existsSync(path.join(root, 'runtime', 'backend', 'agent', 'runtime', 'runtime_api.py'))
  );
}

function resolveCompanionRepoRoot({ workspaceRoots = [], extensionRoot = '' } = {}) {
  const candidates = [];
  const seen = new Set();
  const pushCandidate = (value) => {
    const root = String(value || '').trim();
    if (!root) {
      return;
    }
    const resolved = path.resolve(root);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      candidates.push(resolved);
    }
  };

  pushCandidate(process.env.GOSENDERR_DESKTOP_AGENT_ROOT);
  for (const root of asArray(workspaceRoots)) {
    pushCandidate(root);
  }

  let cursor = String(extensionRoot || '').trim();
  for (let depth = 0; cursor && depth < 6; depth += 1) {
    pushCandidate(cursor);
    const parent = path.dirname(cursor);
    if (!parent || parent === cursor) {
      break;
    }
    cursor = parent;
  }

  return candidates.find((root) => hasRepoMarkers(root)) || '';
}

function loadEngineContract(repoRoot = '') {
  const root = String(repoRoot || '').trim();
  if (!root) {
    return null;
  }
  try {
    return require(path.join(root, 'core', 'engine-contract.js'));
  } catch (_error) {
    return null;
  }
}

function resolveCompanionChatMode(repoRoot = '', value = 'auto') {
  const contract = loadEngineContract(repoRoot);
  if (contract && typeof contract.resolveChatModeValue === 'function') {
    return contract.resolveChatModeValue(value);
  }
  const mode = String(value || 'auto').trim().toLowerCase();
  return COMPANION_CHAT_MODES.includes(mode) ? mode : 'auto';
}

function getCompanionChatModeConfig(repoRoot = '', value = 'auto') {
  const contract = loadEngineContract(repoRoot);
  if (contract && typeof contract.getChatModeConfig === 'function') {
    return contract.getChatModeConfig(value);
  }
  return DEFAULT_CHAT_MODE_CONFIG[resolveCompanionChatMode(repoRoot, value)] || DEFAULT_CHAT_MODE_CONFIG.auto;
}

function parseCompanionChatModeDirective(repoRoot = '', value = '') {
  const contract = loadEngineContract(repoRoot);
  if (contract && typeof contract.parseChatModeDirective === 'function') {
    return contract.parseChatModeDirective(value);
  }
  const message = String(value || '').trim();
  const match = message.match(/^\/(auto|ask|plan|edit|agent)(?:\s+(.*))?$/i);
  if (!match) {
    return { mode: '', message };
  }
  return {
    mode: resolveCompanionChatMode(repoRoot, match[1]),
    message: String(match[2] || '').trim(),
  };
}

function inferCompanionChatModeState(repoRoot = '', chatMode = 'auto', message = '') {
  const contract = loadEngineContract(repoRoot);
  if (contract && typeof contract.inferChatModeRouting === 'function') {
    return contract.inferChatModeRouting(chatMode, message);
  }
  const mode = resolveCompanionChatMode(repoRoot, chatMode);
  const config = getCompanionChatModeConfig(repoRoot, mode);
  return {
    chatMode: mode,
    effectiveChatMode: mode,
    suggestedTaskMode: mode === 'plan' ? 'planner' : mode === 'edit' ? 'coder' : mode === 'agent' ? 'coder' : 'chat',
    suggestedLaneId: mode === 'plan' ? 'plan-reasoning' : mode === 'edit' ? 'code-main' : mode === 'agent' ? 'code-main' : 'chat-fast',
    modeAllowsExecution: config.allowsExecution,
    modeRequiresEditConfirmation: config.requiresEditConfirmation,
    suggestedNextAction: String(config.meta || '').trim(),
  };
}

function resolveWorkspaceRoot(vscode) {
  const folders = asArray(vscode.workspace.workspaceFolders);
  const first = folders[0];
  return first && first.uri ? first.uri.fsPath : '';
}

function buildResearchObjective(objective) {
  const text = String(objective || '').trim();
  if (!text) {
    return '';
  }
  return `Research the repo state, changed files, diagnostics, and trusted docs before proposing changes for: ${text}`;
}

function buildRepairObjective(objective) {
  const text = String(objective || '').trim();
  if (!text) {
    return 'Repair the latest failed GoSenderr run and rerun the smallest relevant validation.';
  }
  return `Repair the latest failed run for: ${text}`;
}

function isExplicitNewTaskRequest(value = '') {
  const text = String(value || '').trim();
  if (!text) {
    return false;
  }
  return /^\/new\b/i.test(text) || /^(new task|different task|switch task|reset task)\s*[:\-]?/i.test(text);
}

function stripNewTaskDirective(value = '') {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (/^\/new\b/i.test(text)) {
    return text.replace(/^\/new\b\s*/i, '').trim();
  }
  return text.replace(/^(new task|different task|switch task|reset task)\s*[:\-]?\s*/i, '').trim();
}

function buildFocusedFollowupObjective(taskFocus = '', followup = '') {
  const focus = String(taskFocus || '').trim();
  const text = String(followup || '').trim();
  if (!focus) {
    return text;
  }
  if (!text || text.toLowerCase() === focus.toLowerCase()) {
    return focus;
  }
  return [
    `Stay on this bounded task: ${focus}`,
    '',
    `Follow-up within the same task: ${text}`,
  ].join('\n');
}

function resolveNextActionCommand(snapshot = {}) {
  return String(snapshot?.nextAction?.command || '').trim().toLowerCase();
}

function buildReviewBundleViewModel(snapshot = {}) {
  const bundle = snapshot && typeof snapshot.reviewBundle === 'object' ? snapshot.reviewBundle : {};
  const decisionLabel = clipText(bundle.decisionLabel || bundle.verdict || '', 80);
  const summary = clipText(bundle.summary || '', 180);
  const reason = clipText(bundle.reason || '', 180);
  const howToFix = clipText(bundle.howToFix || '', 180);
  const changeSummary = clipText(bundle.changeSummary || '', 140);
  const approvalState = clipText(bundle.approvalState || '', 60);
  const requestCount = Math.max(0, Number(bundle.requestCount || 0));
  const primaryFixAction = Array.isArray(bundle.fixActions) && bundle.fixActions.length > 0
    ? clipText(bundle.fixActions[0] || '', 80)
    : '';
  const primaryReviewRequest = Array.isArray(bundle.reviewRequests) && bundle.reviewRequests.length > 0
    ? clipText(
      bundle.reviewRequests[0]?.title
      || bundle.reviewRequests[0]?.summary
      || bundle.reviewRequests[0]?.objective
      || '',
      120,
    )
    : '';
  const trustState = clipText(bundle.trustSummary?.trust_state || '', 40);
  return {
    label: decisionLabel || summary || 'No review bundle yet',
    meta: [
      summary && summary !== decisionLabel ? summary : '',
      reason ? `reason: ${reason}` : '',
      howToFix ? `fix: ${howToFix}` : '',
      changeSummary ? `changes: ${changeSummary}` : '',
      approvalState ? `approval: ${approvalState}` : '',
      primaryFixAction ? `action: ${primaryFixAction}` : '',
      requestCount ? `${String(requestCount)} request${requestCount === 1 ? '' : 's'}` : '',
      primaryReviewRequest ? `request: ${primaryReviewRequest}` : '',
      trustState ? `trust: ${trustState}` : '',
      bundle.requiresManualReview ? 'manual review required' : '',
      bundle.pendingCount ? `${String(bundle.pendingCount)} pending` : '',
    ].filter(Boolean).join(' • '),
    decisionLabel,
    summary,
    reason,
    howToFix,
    changeSummary,
    approvalState,
    requestCount,
    primaryFixAction,
    primaryReviewRequest,
    trustState,
  };
}

function buildMemoryHintsViewModel(value = {}) {
  const hints = value && typeof value === 'object' ? value : {};
  const summary = clipText(hints.summary || '', 180);
  const topRejectReason = clipText(hints.topRejectReason || '', 160);
  const topFixPattern = clipText(hints.topFixPattern || hints.recommendedPrompt || '', 180);
  const recommendedResponse = clipText(hints.recommendedResponse || '', 80);
  const phaseSummary = clipText(hints.phaseSummary || hints.topPhaseLabel || '', 140);
  const topPath = Array.isArray(hints.topPaths) && hints.topPaths.length > 0
    ? clipText(hints.topPaths[0]?.value || hints.topPaths[0] || '', 120)
    : '';
  return {
    label: summary || 'No learned guidance yet',
    meta: [
      topRejectReason ? `reject: ${topRejectReason}` : '',
      topFixPattern ? `fix: ${topFixPattern}` : '',
      recommendedResponse ? `response: ${recommendedResponse}` : '',
      phaseSummary ? `phase: ${phaseSummary}` : '',
      topPath ? `path: ${topPath}` : '',
    ].filter(Boolean).join(' â€¢ '),
    summary,
    topRejectReason,
    topFixPattern,
    recommendedResponse,
  };
}

function mergeCompanionMemoryHints(...values) {
  const normalized = values
    .map((value) => value && typeof value === 'object' ? value : {})
    .filter((value) => Object.keys(value).length > 0);
  if (normalized.length === 0) {
    return {};
  }
  return normalized.reduce((current, hints) => ({
    summary: current.summary || hints.summary || '',
    topRejectReason: current.topRejectReason || hints.topRejectReason || hints.top_reject_reason || '',
    topFixPattern: current.topFixPattern || hints.topFixPattern || hints.top_fix_pattern || '',
    recommendedResponse: current.recommendedResponse || hints.recommendedResponse || hints.recommended_response || '',
    recommendedPrompt: current.recommendedPrompt || hints.recommendedPrompt || hints.recommended_prompt || '',
    topPhaseLabel: current.topPhaseLabel || hints.topPhaseLabel || hints.top_phase_label || '',
    phaseSummary: current.phaseSummary || hints.phaseSummary || hints.phase_summary || '',
    topPaths: Array.isArray(current.topPaths) && current.topPaths.length > 0
      ? current.topPaths
      : (Array.isArray(hints.topPaths) ? hints.topPaths : (Array.isArray(hints.top_paths) ? hints.top_paths : [])),
  }), {});
}

function buildSelfHostProofViewModel(value = {}) {
  const proof = value && typeof value === 'object' ? value : {};
  const label = clipText(proof.capabilityLabel || proof.label || '', 80);
  const summary = clipText(proof.summary || '', 180);
  const nextAction = clipText(proof.nextAction || '', 160);
  const blockerSummary = clipText(proof.blockerSummary || '', 160);
  return {
    label: label || summary || 'No self-host proof yet',
    meta: [
      blockerSummary ? `blocker: ${blockerSummary}` : '',
      nextAction ? `next: ${nextAction}` : '',
    ].filter(Boolean).join(' â€¢ '),
    summary,
    nextAction,
    blockerSummary,
  };
}

function buildSelfImprovementProofViewModel(value = {}) {
  const proof = value && typeof value === 'object' ? value : {};
  const label = clipText(proof.capabilityLabel || proof.label || '', 80);
  const summary = clipText(proof.summary || '', 180);
  const nextAction = clipText(proof.nextAction || '', 160);
  return {
    label: label || summary || 'No self-improvement proof yet',
    meta: [
      nextAction ? `next: ${nextAction}` : '',
    ].filter(Boolean).join(' • '),
    summary,
    nextAction,
  };
}

function buildEngineModelProofViewModel(value = {}) {
  const proof = value && typeof value === 'object' ? value : {};
  const label = clipText(proof.capabilityLabel || proof.label || '', 80);
  const summary = clipText(proof.summary || '', 180);
  const nextAction = clipText(proof.nextAction || '', 160);
  const routeSummary = clipText(proof.routeSummary || '', 180);
  return {
    label: label || summary || 'No engine model proof yet',
    meta: [
      clipText(proof.meta || '', 160),
      routeSummary ? `routes: ${routeSummary}` : '',
      nextAction ? `next: ${nextAction}` : '',
    ].filter(Boolean).join(' • '),
    summary,
    nextAction,
    routeSummary,
  };
}

function readCompanionGitSummary(repoRoot, workspaceRoot) {
  const root = String(repoRoot || '').trim();
  const targetRoot = String(workspaceRoot || '').trim();
  if (!root || !targetRoot) {
    return {
      label: 'No repo yet',
      meta: 'Open the desktop-agent workspace to load git status.',
      branch: '',
      dirty: false,
    };
  }
  try {
    const { getGitSummary } = require(path.join(root, 'core', 'git-service.js'));
    const summary = getGitSummary(targetRoot);
    return {
      label: clipText(summary.branch || 'Detached HEAD', 80),
      meta: clipText(summary.summary || summary.blockedReason || 'Git summary unavailable.', 180),
      branch: String(summary.branch || '').trim(),
      dirty: summary.dirty === true,
    };
  } catch (error) {
    return {
      label: 'Git unavailable',
      meta: clipText(error instanceof Error ? error.message : 'Git summary unavailable.', 180),
      branch: '',
      dirty: false,
    };
  }
}

function buildTaskObjective(objective, options = {}) {
  const summary = String(objective || '').trim();
  const chatMode = resolveCompanionChatMode(options.repoRoot || '', options.chatMode || 'auto');
  const effectiveChatMode = resolveCompanionChatMode(options.repoRoot || '', options.effectiveChatMode || chatMode);
  return {
    summary,
    kind: options.retryWithResearch === true ? 'research-retry' : 'coding-task',
    source: 'vscode-companion',
    taskFocus: String(options.taskFocus || '').trim(),
    chatMode,
    effectiveChatMode,
    suggestedLaneId: String(options.suggestedLaneId || '').trim(),
    suggestedTaskMode: String(options.suggestedTaskMode || '').trim(),
    loopSteps: ['goal', 'observe', 'research', 'propose', 'apply', 'validate', 'review', 'learn', 'continue-stop'],
  };
}

function buildOrchestrateRequest(objective, workspaceRoot, options = {}) {
  const text = String(objective || '').trim();
  const targetRoot = String(workspaceRoot || '').trim();
  const chatMode = resolveCompanionChatMode(options.repoRoot || '', options.chatMode || 'auto');
  const effectiveChatMode = resolveCompanionChatMode(options.repoRoot || '', options.effectiveChatMode || chatMode);
  const taskObjective = buildTaskObjective(text, options);
  return {
    action: 'orchestrate',
    objective: text,
    prompt: text,
    workspace: targetRoot,
    projectRoot: targetRoot,
    targetWorkspaceRoot: targetRoot,
    approvalGated: true,
    approvalProtectedOnly: true,
    chatMode,
    effectiveChatMode,
    suggestedLaneId: String(options.suggestedLaneId || '').trim(),
    suggestedTaskMode: String(options.suggestedTaskMode || '').trim(),
    taskObjective,
    ui: {
      chatMode,
      effectiveChatMode,
      taskFocus: String(options.taskFocus || '').trim(),
    },
    metadata: {
      surface: 'vscode-companion',
      retry_with_research: options.retryWithResearch === true,
      source: 'integration-library/extensions/vscode-companion',
      taskFocus: String(options.taskFocus || '').trim(),
      chatMode,
      effectiveChatMode,
      suggestedLaneId: String(options.suggestedLaneId || '').trim(),
      suggestedTaskMode: String(options.suggestedTaskMode || '').trim(),
      taskObjective,
    },
  };
}

function uniquePaths(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    out.push(text);
  }
  return out;
}

function collectWorkspaceFileCandidates(snapshot = {}, workspaceRoot = '') {
  const root = String(workspaceRoot || '').trim();
  return uniquePaths(
    asArray(snapshot.changedFiles).map((item) => {
      const raw = String(item?.path || '').trim();
      if (!raw) {
        return '';
      }
      return path.isAbsolute(raw) ? raw : path.join(root, raw);
    }),
  ).filter((candidate) => fs.existsSync(candidate));
}

function collectArtifactCandidates(snapshot = {}, result = {}, workspaceRoot = '') {
  const root = String(workspaceRoot || '').trim();
  const values = [
    ...asArray(snapshot.artifactPaths),
    ...asArray(result.artifactPaths),
    ...asArray(result.runtime_artifacts),
  ];
  return uniquePaths(values.map((item) => {
    const raw = String(item || '').trim();
    if (!raw) {
      return '';
    }
    return path.isAbsolute(raw) ? raw : path.join(root || process.cwd(), raw);
  })).filter((candidate) => fs.existsSync(candidate));
}

function collectReviewDecisionCandidates(snapshot = {}, workspaceRoot = '') {
  const root = String(workspaceRoot || '').trim();
  return uniquePaths(
    asArray(snapshot.changedFiles).map((item) => {
      const raw = String(item?.path || '').trim();
      if (!raw) {
        return '';
      }
      if (!root || !path.isAbsolute(raw)) {
        return raw.replace(/\\/g, '/').replace(/^\/+/, '');
      }
      return path.relative(root, raw).replace(/\\/g, '/');
    }),
  ).map((relativePath) => ({
    relativePath,
    label: path.basename(relativePath),
    description: relativePath,
  }));
}

function resolveProviderSettingsPath(repoRoot) {
  const root = String(repoRoot || '').trim();
  if (!root) {
    return '';
  }
  const candidates = [
    path.join(root, 'dev_assistant.yaml'),
    path.join(root, 'HOW_TO_USE', '10_engine', 'engine_tuning_and_settings.md'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function resolveTaskHubDocumentPath(repoRoot, workspaceRoot) {
  const root = String(repoRoot || '').trim();
  const targetRoot = String(workspaceRoot || '').trim();
  if (!root || !targetRoot) {
    return '';
  }
  const { hubPath } = require(path.join(root, 'core', 'task-hub.js'));
  return String(hubPath(targetRoot) || '').trim();
}

function readCompanionLearningMemoryHints(repoRoot, workspaceRoot) {
  const root = String(repoRoot || '').trim();
  const targetRoot = String(workspaceRoot || '').trim();
  if (!root || !targetRoot) {
    return {};
  }
  try {
    const { readLearningMemoryHints } = require(path.join(root, 'core', 'learning-journal.js'));
    return readLearningMemoryHints(targetRoot, targetRoot);
  } catch (_error) {
    return {};
  }
}

function readCompanionSelfHostProof(repoRoot, workspaceRoot) {
  const root = String(repoRoot || '').trim();
  const targetRoot = String(workspaceRoot || '').trim();
  if (!root || !targetRoot) {
    return {};
  }
  try {
    const { buildCapabilityDescriptor } = require(path.join(root, 'core', 'capability-status.js'));
    const { readLatestAcceptanceReport } = require(path.join(root, 'core', 'engine-acceptance.js'));
    const acceptance = readLatestAcceptanceReport(targetRoot);
    const report = acceptance?.report && typeof acceptance.report === 'object' ? acceptance.report : {};
    const checks = asArray(report.checks).filter((check) => /^self-host-/.test(String(check?.id || '').trim().toLowerCase()));
    const failing = checks.filter((check) => String(check?.status || '').trim().toLowerCase() === 'fail');
    const passing = checks.filter((check) => String(check?.status || '').trim().toLowerCase() === 'pass');
    const smokeCheck = checks.find((check) => String(check?.id || '').trim() === 'self-host-smoke') || null;
    const withCapabilityDescriptor = (payload = {}) => ({
      ...payload,
      ...buildCapabilityDescriptor(payload),
    });
    if (checks.length === 0) {
      return withCapabilityDescriptor({
        label: acceptance?.exists ? 'PARTIAL' : 'NOT RUN',
        summary: acceptance?.exists
          ? 'No self-host proof checks are recorded in the latest acceptance bundle yet.'
          : 'No self-host proof is recorded yet.',
        nextAction: 'Run npm run engine:acceptance -- --full-self-host before widening self-work.',
        blockerSummary: '',
      });
    }
    if (failing.length > 0) {
      return withCapabilityDescriptor({
        label: 'BLOCKED',
        summary: `${failing.length}/${checks.length} self-host proof check(s) failed.`,
        blockerSummary: String(failing[0]?.summary || failing[0]?.label || 'A self-host proof check failed.').trim(),
        nextAction: String(report?.nextAction || 'Repair the failing self-host proof and rerun the full self-host acceptance suite.').trim(),
      });
    }
    if (!smokeCheck) {
      return withCapabilityDescriptor({
        label: 'PARTIAL',
        summary: `Self-host bootstrap/tests passed (${passing.length}/${checks.length}), but smoke proof is still missing.`,
        blockerSummary: '',
        nextAction: 'Run npm run engine:acceptance -- --full-self-host to add smoke proof.',
      });
    }
    return withCapabilityDescriptor({
      label: 'PROVEN',
      summary: `Self-host proof passed (${passing.length}/${checks.length}), including smoke.`,
      blockerSummary: '',
      nextAction: 'Keep the next self-host slice bounded and rerun the same proof after meaningful self-work.',
    });
  } catch (_error) {
    return {};
  }
}

function readCompanionSelfImprovementProof(repoRoot) {
  const root = String(repoRoot || '').trim();
  if (!root) {
    return {};
  }
  try {
    const { buildSelfImprovementSummary } = require(path.join(root, 'core', 'system-check.js'));
    const summary = buildSelfImprovementSummary(root, '', { dailyTarget: 5 });
    return summary?.proof && typeof summary.proof === 'object' ? summary.proof : {};
  } catch (_error) {
    return {};
  }
}

function readCompanionEngineModelProof(repoRoot, workspaceRoot) {
  const root = String(repoRoot || '').trim();
  const targetRoot = String(workspaceRoot || '').trim();
  if (!root || !targetRoot) {
    return {};
  }
  try {
    const { buildEngineModelProofSnapshot, buildEngineModelProofViewModel } = require(path.join(root, 'core', 'engine-model-proof.js'));
    return buildEngineModelProofViewModel(buildEngineModelProofSnapshot({
      workspaceRoot: targetRoot,
    }));
  } catch (_error) {
    return {};
  }
}

function buildQueuedFollowupViewModel(value = {}) {
  const payload = value && typeof value === 'object' ? value : {};
  const recipe = payload.recipe && typeof payload.recipe === 'object' ? payload.recipe : {};
  const label = clipText(recipe.title || payload.label || '', 100);
  const summary = clipText(recipe.summary || payload.summary || payload.message || '', 180);
  const stepCount = Number(payload.createdCount || recipe.stepCount || 0);
  return {
    exists: Boolean(payload.exists || label),
    label: label || 'No queued follow-up yet',
    summary,
    meta: [
      payload.deduped ? 'already queued' : '',
      payload.ok === true && !payload.deduped && stepCount > 0 ? `${String(stepCount)} queued step${stepCount === 1 ? '' : 's'}` : '',
      recipe.autoQueueEligible === true ? 'queueable' : '',
      payload.hubPath ? path.basename(payload.hubPath) : '',
    ].filter(Boolean).join(' • '),
    hubPath: String(payload.hubPath || '').trim(),
  };
}

function inferChatModeFromSnapshot(snapshot = {}) {
  const explicit = String(snapshot.chatMode || '').trim().toLowerCase();
  if (['auto', 'ask', 'plan', 'edit', 'agent'].includes(explicit)) {
    return explicit;
  }
  const effective = String(snapshot.effectiveChatMode || '').trim().toLowerCase();
  if (['ask', 'plan', 'edit', 'agent'].includes(effective)) {
    return 'auto';
  }
  const laneId = String(snapshot.laneId || '').trim().toLowerCase();
  const taskMode = String(snapshot.taskMode || '').trim().toLowerCase();
  if (laneId.includes('plan') || taskMode.includes('plan') || laneId.includes('research') || taskMode.includes('research')) {
    return 'plan';
  }
  if (laneId.includes('code') || laneId.includes('repair') || laneId.includes('review') || taskMode.includes('code') || taskMode.includes('repair') || taskMode.includes('review')) {
    return 'edit';
  }
  if (snapshot?.nextAction?.command || snapshot?.queuedFollowup?.exists) {
    return 'agent';
  }
  return 'ask';
}

function buildChatModeViewModel(snapshot = {}, options = {}) {
  const mode = inferChatModeFromSnapshot(snapshot);
  const effectiveMode = ['ask', 'plan', 'edit', 'agent'].includes(String(snapshot.effectiveChatMode || '').trim().toLowerCase())
    ? String(snapshot.effectiveChatMode || '').trim().toLowerCase()
    : (mode === 'auto' ? 'ask' : mode);
  const contract = loadEngineContract(options.repoRoot || '');
  const config = contract && typeof contract.getChatModeConfig === 'function'
    ? contract.getChatModeConfig(mode)
    : null;
  const label = String(config?.label || (mode.charAt(0).toUpperCase() + mode.slice(1))).trim();
  const metaByMode = {
    auto: 'Auto chooses the safest grounded behavior for the current request and gates.',
    ask: 'Human-style help, explanation, and repo guidance only.',
    plan: 'Scoped planning, risks, and next steps without launching edits.',
    edit: 'Code-focused changes and repair flow, with confirmation before execution.',
    agent: 'Bounded next-safe actions through the supervised engine loop.',
  };
  return {
    mode,
    effectiveMode,
    label,
    meta: [String(config?.meta || metaByMode[mode] || metaByMode.ask).trim(), mode === 'auto' ? `effective: ${effectiveMode}` : ''].filter(Boolean).join(' - '),
  };
}

function buildGroundedReplyViewModel(controller, snapshot = {}, chatModeView = {}) {
  const repoRoot = String(controller?.repoRoot || '').trim();
  const workspaceRoot = String(controller?.workspaceRoot || '').trim();
  if (!repoRoot || !workspaceRoot) {
    return {
      label: 'Grounded reply unavailable',
      meta: 'Open the desktop-agent repo workspace so the companion can reuse the shared Ask and Plan path.',
      reply: '',
    };
  }
  const prompt = chatModeView.effectiveMode === 'plan'
    ? (String(controller?.lastObjective || snapshot?.task || '').trim() || 'Plan the safest next slice for the current workspace.')
    : (String(controller?.lastObjective || snapshot?.task || '').trim() || 'What should I know about the current workspace right now?');
  const cacheKey = JSON.stringify({
    repoRoot,
    workspaceRoot,
    labRoot: String(snapshot?.selectedLabRoot || '').trim(),
    prompt,
    mode: String(chatModeView.mode || 'auto').trim(),
    effectiveMode: String(chatModeView.effectiveMode || '').trim(),
    status: String(snapshot?.status || '').trim(),
    laneId: String(snapshot?.laneId || '').trim(),
    changedFileCount: Number(snapshot?.changedFileCount || 0),
    reviewSummary: String(snapshot?.reviewSummary?.summary || '').trim(),
    nextAction: String(snapshot?.nextAction?.command || '').trim(),
  });
  if (controller?.groundedReplyCacheKey === cacheKey && controller?.groundedReplyCacheValue) {
    return controller.groundedReplyCacheValue;
  }
  try {
    const { buildGroundedReplyView } = require(path.join(repoRoot, 'core', 'grounded-chat.js'));
    const { buildSystemCheck } = require(path.join(repoRoot, 'core', 'system-check.js'));
    const report = buildSystemCheck({
      workspaceRoot: repoRoot,
      targetWorkspaceRoot: workspaceRoot,
      labRoot: String(snapshot?.selectedLabRoot || '').trim(),
    });
    const view = buildGroundedReplyView({
      chatMode: chatModeView.mode || 'auto',
      userPrompt: prompt,
      report,
    });
    controller.groundedReplyCacheKey = cacheKey;
    controller.groundedReplyCacheValue = view;
    return view;
  } catch (error) {
    const fallback = {
      label: 'Grounded reply unavailable',
      meta: clipText(error instanceof Error ? error.message : 'Unable to load grounded reply view.', 180),
      reply: '',
    };
    controller.groundedReplyCacheKey = cacheKey;
    controller.groundedReplyCacheValue = fallback;
    return fallback;
  }
}

function queueNextTaskLoopFollowupInWorkspace({ repoRoot = '', workspaceRoot = '', snapshot = null, context = {} } = {}) {
  const root = String(repoRoot || '').trim();
  const targetRoot = String(workspaceRoot || '').trim();
  const execution = snapshot && typeof snapshot === 'object' ? snapshot : {};
  if (!root || !targetRoot) {
    return { ok: false, message: 'The companion needs both the repo root and workspace root before it can queue a follow-up.' };
  }
  const { buildNextActionRecipe, queueFollowupRecipeTasks } = require(path.join(root, 'core', 'followup-recipes.js'));
  const queuedFollowup = execution?.queuedFollowup && typeof execution.queuedFollowup === 'object'
    ? execution.queuedFollowup
    : {};
  const queuedRecipe = queuedFollowup.recipe && typeof queuedFollowup.recipe === 'object'
    ? {
      exists: queuedFollowup.exists === true || Array.isArray(queuedFollowup.recipe.steps),
      ...queuedFollowup.recipe,
    }
    : null;
  const recipe = queuedRecipe || buildNextActionRecipe(execution);
  if (!recipe) {
    return { ok: false, message: 'The current next safe action is not queueable as a bounded follow-up task yet.' };
  }
  return queueFollowupRecipeTasks(targetRoot, recipe, {
    workspaceRoot: targetRoot,
    targetWorkspaceRoot: String(context.targetWorkspaceRoot || targetRoot).trim() || targetRoot,
    labRoot: String(context.labRoot || '').trim(),
    threadId: String(context.threadId || '').trim(),
    changeSessionId: String(context.changeSessionId || '').trim(),
    ring: String(context.ring || '').trim(),
    promotionState: String(context.promotionState || '').trim(),
  });
}

function loadRuntimeBridge(repoRoot, workspaceRoot) {
  const root = String(repoRoot || '').trim();
  if (!root) {
    throw new Error('GoSenderr desktop-agent repo root is not available.');
  }
  const { AgentRuntimeClient } = require(path.join(root, 'shared-runtime', 'agent-runtime-client.js'));
  const { buildOperatorExecutionSnapshot } = require(path.join(root, 'shared-runtime', 'runtime.js'));
  return {
    buildOperatorExecutionSnapshot,
    client: new AgentRuntimeClient({
      workspaceRoot,
      runtimeRoot: path.join(root, 'runtime'),
      pythonRelative: path.join('runtime', '.venv', 'Scripts', 'python.exe'),
    }),
  };
}

function buildStatePayload(controller) {
  const snapshot = controller.lastSnapshot || null;
  const queuedFollowup = controller.lastQueuedFollowup || snapshot?.queuedFollowup || null;
  const memoryHints = mergeCompanionMemoryHints(
    snapshot?.memoryHints,
    readCompanionLearningMemoryHints(controller.repoRoot, controller.workspaceRoot),
  );
  const gitSummaryView = readCompanionGitSummary(controller.repoRoot, controller.workspaceRoot);
  const selectedChatMode = resolveCompanionChatMode(controller.repoRoot, controller.chatMode || snapshot?.chatMode || 'auto');
  const currentModeState = inferCompanionChatModeState(controller.repoRoot, selectedChatMode, controller.lastObjective || snapshot?.task || '');
  const chatModeView = buildChatModeViewModel({
    ...(snapshot || {}),
    chatMode: selectedChatMode,
    effectiveChatMode: snapshot?.effectiveChatMode || selectedChatMode,
  }, { repoRoot: controller.repoRoot });
  const currentModelView = buildCompanionModelView({
    repoRoot: controller.repoRoot,
    workspaceRoot: controller.workspaceRoot,
    snapshot,
    chatMode: selectedChatMode,
    modeState: currentModeState,
  });
  const groundedReplyView = buildGroundedReplyViewModel(controller, snapshot || {}, chatModeView);
  const selfHostProof = readCompanionSelfHostProof(controller.repoRoot, controller.workspaceRoot);
  const selfImprovementProof = readCompanionSelfImprovementProof(controller.repoRoot);
  const engineModelProof = readCompanionEngineModelProof(controller.repoRoot, controller.workspaceRoot);
  return {
    workspaceRoot: controller.workspaceRoot,
    repoRoot: controller.repoRoot,
    ready: Boolean(controller.workspaceRoot && controller.repoRoot),
    running: controller.running,
    statusMessage: controller.statusMessage,
    errorMessage: controller.errorMessage,
    assistantReply: controller.lastAssistantReply,
    lastObjective: controller.lastObjective,
    taskFocus: controller.taskFocus,
    logTail: controller.logTail,
    selectedChatMode,
    currentModelView,
    threadEntries: asArray(controller.threadEntries),
    queuedFollowupView: buildQueuedFollowupViewModel(queuedFollowup || {}),
    reviewBundleView: buildReviewBundleViewModel(snapshot || {}),
    memoryHintsView: buildMemoryHintsViewModel(memoryHints),
    chatModeView,
    groundedReplyView,
    gitSummaryView,
    engineModelProofView: buildEngineModelProofViewModel(engineModelProof),
    selfHostProofView: buildSelfHostProofViewModel(selfHostProof),
    selfImprovementProofView: buildSelfImprovementProofViewModel(selfImprovementProof),
    snapshot: snapshot ? {
      task: snapshot.task,
      status: snapshot.status,
      laneId: snapshot.laneId,
      laneLabel: snapshot.laneLabel,
      taskMode: snapshot.taskMode,
      modelRole: snapshot.modelRole,
      modelProfileId: snapshot.modelProfileId,
      modelDisplayName: snapshot.modelDisplayName,
      baseModel: snapshot.baseModel,
      providerSource: snapshot.providerSource,
      changedFileCount: snapshot.changedFileCount,
      changedFiles: asArray(snapshot.changedFiles),
      artifactPaths: asArray(snapshot.artifactPaths),
      reviewSummary: snapshot.reviewSummary || {},
      trustSummary: snapshot.trustSummary || {},
      runSummary: snapshot.runSummary || {},
      testSummary: snapshot.testSummary || {},
      retryAvailable: Boolean(snapshot.retryAvailable),
      repairAvailable: Boolean(snapshot.repairAvailable),
      recommendedActions: asArray((controller.lastResult || {}).recommendedActions || snapshot.recommendedActions),
      taskObjective: snapshot.taskObjective || {},
      taskFocus: snapshot.taskFocus || controller.taskFocus || '',
      failureClass: snapshot.failureClass || {},
      recoveryLadder: snapshot.recoveryLadder || {},
      checkpointRef: snapshot.checkpointRef || {},
      interruptRequest: snapshot.interruptRequest || {},
      reviewBundle: snapshot.reviewBundle || {},
      chatMode: snapshot.chatMode || selectedChatMode,
      effectiveChatMode: snapshot.effectiveChatMode || chatModeView.effectiveMode,
      nextAction: snapshot.nextAction || {},
      queuedFollowup: snapshot.queuedFollowup || {},
      memoryHints,
      workbenchArtifacts: asArray(snapshot.workbenchArtifacts),
    } : null,
  };
}

function readCompanionAssistantConfig(repoRoot, workspaceRoot) {
  const root = String(repoRoot || '').trim();
  const targetRoot = String(workspaceRoot || '').trim();
  if (!root || !targetRoot) {
    return null;
  }
  try {
    const { readAssistantConfig } = require(path.join(root, 'host', 'assistant-config.js'));
    return readAssistantConfig(targetRoot, { defaultWorkspace: root });
  } catch (_error) {
    return null;
  }
}

function buildCompanionModelView({ repoRoot = '', workspaceRoot = '', snapshot = null, chatMode = 'auto', modeState = null } = {}) {
  const currentSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const resolvedModeState = modeState && typeof modeState === 'object'
    ? modeState
    : inferCompanionChatModeState(repoRoot, chatMode, '');
  const config = readCompanionAssistantConfig(repoRoot, workspaceRoot);
  const contract = loadEngineContract(repoRoot);
  const routeSelection = config && contract && typeof contract.resolveModelProfileSelection === 'function'
    ? contract.resolveModelProfileSelection(config, {
      taskMode: resolvedModeState?.suggestedTaskMode || currentSnapshot.taskMode || '',
      laneId: resolvedModeState?.suggestedLaneId || currentSnapshot.laneId || '',
      action: String(currentSnapshot.action || '').trim(),
    })
    : null;
  const active = routeSelection?.active && typeof routeSelection.active === 'object' ? routeSelection.active : {};
  const provider = String(
    currentSnapshot.providerSource
    || active.providerSource
    || active.baseProvider
    || ''
  ).trim().toLowerCase();
  const displayName = String(
    currentSnapshot.modelDisplayName
    || active.modelDisplayName
    || currentSnapshot.modelProfileId
    || active.modelProfileId
    || currentSnapshot.baseModel
    || active.baseModel
    || ''
  ).trim();
  const baseModel = String(currentSnapshot.baseModel || active.baseModel || '').trim();
  const detailParts = [
    provider ? provider : '',
    baseModel && baseModel !== displayName ? baseModel : '',
    routeSelection?.modelRole ? `role:${String(routeSelection.modelRole).trim()}` : '',
  ].filter(Boolean);
  return {
    label: clipText(displayName || 'No model', 42),
    detail: clipText(detailParts.join(' • '), 120),
    provider,
    baseModel,
    modelRole: String(routeSelection?.modelRole || '').trim(),
    clickable: true,
  };
}

function createThreadEntry(role, text, options = {}) {
  const message = String(text || '').trim();
  if (!message) {
    return null;
  }
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: String(role || 'assistant').trim().toLowerCase(),
    text: message,
    meta: String(options.meta || '').trim(),
    kind: String(options.kind || 'message').trim().toLowerCase(),
  };
}

function appendThreadEntry(controller, role, text, options = {}) {
  const entry = createThreadEntry(role, text, options);
  if (!entry) {
    return;
  }
  controller.threadEntries = [...asArray(controller.threadEntries), entry].slice(-40);
}

function buildCompanionResultReply(snapshot = {}, rawResult = {}, finished = {}) {
  const runtimeLabel = clipText(snapshot?.laneLabel || snapshot?.taskMode || snapshot?.laneId || '', 80);
  const summary = clipText(
    rawResult.summary
      || rawResult.message
      || snapshot?.reviewSummary?.summary
      || snapshot?.runSummary?.summary
      || snapshot?.testSummary?.summary
      || '',
    240,
  );
  const nextAction = clipText(snapshot?.nextAction?.summary || snapshot?.nextAction?.label || '', 180);
  const changedCount = Number(snapshot?.changedFileCount || asArray(snapshot?.changedFiles).length || 0);
  const parts = [];
  if (finished?.exitCode === 0) {
    parts.push(runtimeLabel ? `${runtimeLabel} completed.` : 'Run completed.');
  } else {
    parts.push(runtimeLabel ? `${runtimeLabel} finished with a blocked or failing result.` : 'Run finished with a blocked or failing result.');
  }
  if (summary) {
    parts.push(summary);
  }
  if (changedCount > 0) {
    parts.push(`${String(changedCount)} touched file${changedCount === 1 ? '' : 's'} captured.`);
  }
  if (nextAction) {
    parts.push(`Next: ${nextAction}`);
  }
  return parts.join(' ');
}

async function persistCompanionChatMode(controller, value) {
  const nextMode = resolveCompanionChatMode(controller.repoRoot, value);
  controller.chatMode = nextMode;
  await controller.context.workspaceState.update(COMPANION_CHAT_MODE_KEY, nextMode);
  return nextMode;
}

function setCompanionReply(controller, message, options = {}) {
  const text = String(message || '').trim();
  controller.lastAssistantReply = text;
  if (options.record !== false && text) {
    appendThreadEntry(controller, options.role || 'assistant', text, {
      meta: options.meta,
      kind: options.kind,
    });
  }
  if (options.keepStatus !== true) {
    controller.statusMessage = text || controller.statusMessage;
  }
  if (options.clearError !== false) {
    controller.errorMessage = '';
  }
}

function buildCompanionHelpText() {
  return [
    'Slash commands: /files, /trace, /problems, /taskhub, /sandbox, /settings, /scm, /history, /continue, /research, /repair, /self-improve, /autopilot, /next, /queue, /approve, /reject, /mode <auto|ask|plan|edit|agent>, /new.',
    'Use /new to clear the current task focus before starting something different.',
    'You can also start a task with /plan, /edit, /agent, /ask, or /auto followed by the request.',
  ].join(' ');
}

function clearCompanionTaskFocus(controller, reply = 'Task focus cleared. Describe the next bounded task when you are ready.') {
  controller.taskFocus = '';
  controller.lastObjective = '';
  controller.lastQueuedFollowup = null;
  controller.errorMessage = '';
  setCompanionReply(controller, reply);
}

async function runCompanionSlashCommand(controller, rawInput) {
  const vscode = getVsCode();
  const input = String(rawInput || '').trim();
  const lower = input.toLowerCase();
  if (/^\/new\b$/i.test(input)) {
    appendThreadEntry(controller, 'user', input);
    clearCompanionTaskFocus(controller);
    postState(controller);
    return true;
  }
  const modeMatch = input.match(/^\/mode\s+(auto|ask|plan|edit|agent)\b/i);
  if (modeMatch) {
    appendThreadEntry(controller, 'user', input);
    const nextMode = await persistCompanionChatMode(controller, modeMatch[1]);
    const config = getCompanionChatModeConfig(controller.repoRoot, nextMode);
    setCompanionReply(controller, nextMode === 'auto'
      ? 'Auto mode is on. I will choose when to answer, plan, prepare edits, or use the bounded agent loop.'
      : `Switched to ${String(config.label || nextMode).trim()} mode.`);
    postState(controller);
    return true;
  }
  if (/^\/help\b/i.test(input)) {
    appendThreadEntry(controller, 'user', input);
    setCompanionReply(controller, buildCompanionHelpText());
    postState(controller);
    return true;
  }
  if (/^\/(approve|review\s+approve)\b/i.test(lower)) {
    appendThreadEntry(controller, 'user', input);
    await updateCompanionReviewDecision(controller, 'approved');
    return true;
  }
  if (/^\/(reject|review\s+reject)\b/i.test(lower)) {
    appendThreadEntry(controller, 'user', input);
    await updateCompanionReviewDecision(controller, 'rejected');
    return true;
  }
  if (/^\/continue\b/i.test(input)) {
    appendThreadEntry(controller, 'user', input);
    if (!controller.lastObjective) {
      await vscode.window.showInformationMessage('Run a bounded task first so the companion has something to continue.');
      return true;
    }
    await runObjective(controller, controller.lastObjective, { retryWithResearch: false });
    return true;
  }
  if (/^\/(research|retry)\b/i.test(input)) {
    appendThreadEntry(controller, 'user', input);
    if (!controller.lastObjective) {
      await vscode.window.showInformationMessage('Run a bounded task first so the companion has something to retry.');
      return true;
    }
    await runObjective(controller, controller.lastObjective, { retryWithResearch: true });
    return true;
  }
  if (/^\/repair\b/i.test(input)) {
    appendThreadEntry(controller, 'user', input);
    await runRepairLoopFromCompanion(controller.context, { announce: true });
    return true;
  }
  if (/^\/(self-improve|selfimprove|improve)\b/i.test(input)) {
    appendThreadEntry(controller, 'user', input);
    await runSelfImproveInBackground(controller.context);
    return true;
  }
  if (/^\/autopilot\b/i.test(input)) {
    appendThreadEntry(controller, 'user', input);
    await runAutopilotInBackground(controller.context);
    return true;
  }
  if (/^\/(next|run-next)\b/i.test(input)) {
    appendThreadEntry(controller, 'user', input);
    await runNextAction(controller.context);
    return true;
  }
  if (/^\/queue\b/i.test(input)) {
    appendThreadEntry(controller, 'user', input);
    await queueNextTask(controller.context);
    return true;
  }
  if (/^\/trace\b/i.test(input)) {
    appendThreadEntry(controller, 'user', input);
    await openTraceDocument(controller);
    return true;
  }
  if (/^\/files\b/i.test(input)) {
    appendThreadEntry(controller, 'user', input);
    await openTouchedFiles(controller);
    return true;
  }
  if (/^\/taskhub\b/i.test(input)) {
    appendThreadEntry(controller, 'user', input);
    await openTaskHubDocument(controller);
    return true;
  }
  if (/^\/problems\b/i.test(input)) {
    appendThreadEntry(controller, 'user', input);
    await vscode.commands.executeCommand('workbench.actions.view.problems');
    return true;
  }
  if (/^\/sandbox\b/i.test(input)) {
    appendThreadEntry(controller, 'user', input);
    await openSandboxArtifact(controller);
    return true;
  }
  if (/^\/(settings|provider)\b/i.test(input)) {
    appendThreadEntry(controller, 'user', input);
    await openProviderSettings(controller);
    return true;
  }
  if (/^\/(scm|source-control)\b/i.test(input)) {
    appendThreadEntry(controller, 'user', input);
    await openSourceControlView();
    return true;
  }
  if (/^\/(history|git-history)\b/i.test(input)) {
    appendThreadEntry(controller, 'user', input);
    await openGitHistoryView();
    return true;
  }
  return false;
}

async function updateCompanionReviewDecision(controller, status) {
  const vscode = getVsCode();
  if (!controller.repoRoot || !controller.workspaceRoot) {
    await vscode.window.showWarningMessage('Open the GoSenderr desktop-agent repo workspace before setting review decisions.');
    return;
  }
  const candidates = collectReviewDecisionCandidates(controller.lastSnapshot || {}, controller.workspaceRoot);
  if (!candidates.length) {
    await vscode.window.showInformationMessage('No changed files are available yet for review approval.');
    return;
  }
  const selected = candidates.length === 1
    ? candidates[0]
    : await vscode.window.showQuickPick(candidates, {
      placeHolder: `Choose the file to mark as ${status}.`,
    });
  if (!selected?.relativePath) {
    return;
  }

  const { applyDecision } = require(path.join(controller.repoRoot, 'core', 'review-approval-state.js'));
  const { readStoredReviewDecisions, writeStoredReviewDecisions } = require(path.join(controller.repoRoot, 'core', 'review-decision-store.js'));
  const stored = readStoredReviewDecisions(controller.workspaceRoot);
  const result = applyDecision(stored.decisions, { path: selected.relativePath }, status, '');
  writeStoredReviewDecisions(controller.workspaceRoot, result.decisions);

  if (controller.lastSnapshot && Array.isArray(controller.lastSnapshot.changedFiles)) {
    controller.lastSnapshot.changedFiles = controller.lastSnapshot.changedFiles.map((item) => {
      const itemPath = String(item?.path || '').trim();
      const normalizedItemPath = itemPath
        ? (path.isAbsolute(itemPath)
            ? path.relative(controller.workspaceRoot, itemPath).replace(/\\/g, '/')
            : itemPath.replace(/\\/g, '/').replace(/^\/+/, ''))
        : '';
      if (normalizedItemPath !== selected.relativePath) {
        return item;
      }
      return {
        ...item,
        decision: status,
        note: '',
      };
    });
  }
  controller.statusMessage = `Marked ${selected.relativePath} as ${status} in the shared review state.`;
  controller.errorMessage = '';
  postState(controller);
  await vscode.window.showInformationMessage(`Marked ${selected.relativePath} as ${status}.`);
}

function buildWorkbenchHtml(surfaceKind = WORKBENCH_SURFACE_PANEL, options = {}) {
  const isSidebar = surfaceKind === WORKBENCH_SURFACE_SIDEBAR;
  const initialPayload = options.initialPayload && typeof options.initialPayload === 'object'
    ? options.initialPayload
    : {};
  const initialPayloadJson = JSON.stringify(initialPayload).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>GoSenderr Chat</title>
    <style>
      body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-sideBar-background, var(--vscode-editor-background));
        margin: 0;
        padding: 0;
      }
      * {
        box-sizing: border-box;
      }
      .shell {
        min-height: 100vh;
        display: flex;
        flex-direction: column;
      }
      .surface-header {
        display: grid;
        gap: 10px;
        padding: 10px 12px 6px;
        border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
        background: color-mix(in srgb, var(--vscode-sideBar-background) 94%, black 6%);
        position: sticky;
        top: 0;
        z-index: 2;
      }
      .surface-label {
        font-size: 12px;
        line-height: 1;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        opacity: 0.9;
      }
      .thread-header {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }
      .thread-heading {
        flex: 1;
        min-width: 0;
        display: grid;
        gap: 4px;
      }
      .thread-title {
        font-size: 12px;
        line-height: 1.3;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .thread-summary {
        font-size: 12px;
        line-height: 1.4;
        opacity: 0.72;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .thread-focus {
        max-width: 100%;
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 80%, transparent);
        background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-panel-border));
        font-size: 11px;
        line-height: 1.4;
        font-weight: 600;
        color: color-mix(in srgb, var(--vscode-foreground) 92%, transparent);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .icon-button {
        width: 28px;
        height: 28px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent);
        background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-panel-border));
        color: inherit;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font: inherit;
        padding: 0;
      }
      .icon-button.subtle {
        opacity: 0.82;
      }
      .icon-button:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .conversation {
        flex: 1;
        overflow: auto;
        padding: 12px 14px 140px;
        display: grid;
        align-content: start;
        gap: 14px;
      }
      .transcript {
        display: grid;
        gap: 14px;
      }
      .transcript-row {
        display: grid;
        gap: 6px;
      }
      .transcript-row.user {
        justify-items: end;
      }
      .user-bubble {
        max-width: min(82%, 320px);
        background: color-mix(in srgb, var(--vscode-button-background) 22%, var(--vscode-editor-background));
        border: 1px solid color-mix(in srgb, var(--vscode-button-background) 26%, transparent);
        border-radius: 18px;
        padding: 12px 14px;
        line-height: 1.45;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .assistant-copy {
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 14px;
      }
      .transcript-meta {
        font-size: 12px;
        line-height: 1.4;
        opacity: 0.7;
      }
      .status-copy {
        font-size: 12px;
        line-height: 1.45;
        opacity: 0.72;
      }
      .activity-card {
        display: grid;
        gap: 10px;
        padding: 10px 12px;
        border-radius: 14px;
        border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent);
        background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-panel-border));
      }
      .activity-label {
        font-size: 11px;
        line-height: 1;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-weight: 700;
        opacity: 0.74;
      }
      .activity-summary {
        font-size: 13px;
        line-height: 1.5;
      }
      .activity-list {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .activity-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 86%, transparent);
        background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-panel-border));
        font-size: 11px;
        line-height: 1.2;
      }
      .composer-wrap {
        position: sticky;
        bottom: 0;
        z-index: 3;
        padding: 10px 12px 12px;
        background: linear-gradient(to top, var(--vscode-sideBar-background, var(--vscode-editor-background)) 78%, transparent);
      }
      .composer-shell {
        position: relative;
        border-radius: 16px;
        border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 36%, var(--vscode-panel-border));
        background: color-mix(in srgb, var(--vscode-editor-background) 96%, black 4%);
        padding: 10px 10px 8px;
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.18);
      }
      .action-popover {
        position: absolute;
        left: 0;
        right: 0;
        bottom: calc(100% + 8px);
        display: grid;
        gap: 12px;
        padding: 12px;
        border-radius: 14px;
        border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent);
        background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-panel-border));
      }
      .action-popover[hidden] {
        display: none;
      }
      .popover-row {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .popover-label {
        font-size: 12px;
        opacity: 0.74;
      }
      .composer-controls {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-top: 8px;
      }
      .composer-left {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
      .composer-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 86%, transparent);
        background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-panel-border));
        font-size: 12px;
      }
      .composer-pill.buttonish {
        cursor: pointer;
        color: inherit;
      }
      .composer-pill.buttonish:disabled {
        opacity: 0.55;
        cursor: default;
      }
      .composer-pill-label {
        max-width: 160px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .action-button,
      .send-button {
        border-radius: 999px;
        border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        padding: 8px 12px;
        cursor: pointer;
        font: inherit;
      }
      .action-grid {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .send-button {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        min-width: 38px;
        height: 38px;
        padding: 0 12px;
      }
      .action-button:disabled,
      .send-button:disabled {
        opacity: 0.5;
        cursor: default;
      }
      textarea,
      select,
      button {
        font: inherit;
      }
      textarea,
      p,
      pre {
        margin: 0;
      }
      textarea {
        width: 100%;
        min-height: ${isSidebar ? '92px' : '120px'};
        resize: none;
        border: none;
        outline: none;
        background: transparent;
        color: var(--vscode-input-foreground, var(--vscode-editor-foreground));
        padding: 6px 4px 4px;
        line-height: 1.55;
      }
      select {
        border: none;
        outline: none;
        background: transparent;
        color: inherit;
      }
      .panel-rail {
        display: ${isSidebar ? 'none' : 'grid'};
        gap: 10px;
      }
    </style>
  </head>
  <body class="surface-${escapeHtml(surfaceKind)}">
    <div class="shell">
      <header class="surface-header">
        <div class="surface-label">CHAT</div>
        <div class="thread-header">
          <button class="icon-button subtle" id="threadBack" disabled>&lt;</button>
          <div class="thread-heading">
            <div id="threadTitle" class="thread-title">START A BOUNDED CODING TASK</div>
            <div id="summary" class="thread-summary">Open the GoSenderr desktop-agent repo workspace to start chatting with the shared runtime.</div>
            <div id="taskFocusBadge" class="thread-focus" hidden>Task focus: waiting for the first bounded task</div>
          </div>
          ${isSidebar ? '<button id="openPanel" class="icon-button subtle">[]</button>' : '<div style="width:28px;height:28px;"></div>'}
        </div>
      </header>
      <main class="conversation" id="conversation">
        <section class="transcript" id="transcript"></section>
        <section id="activityRail" class="activity-card" hidden>
          <div id="activityLabel" class="activity-label">Run context</div>
          <div id="activitySummary" class="activity-summary"></div>
          <div id="activityList" class="activity-list"></div>
        </section>
        <section id="panelRail" class="panel-rail" hidden>
          <div class="activity-card">
            <div class="activity-label">Engine model proof</div>
            <div id="proofSummary" class="activity-summary"></div>
          </div>
          <div class="activity-card">
            <div class="activity-label">Latest log</div>
            <div id="logSummary" class="activity-summary"></div>
          </div>
        </section>
      </main>
      <div class="composer-wrap">
        <section class="composer-shell">
          <div id="actionPopover" class="action-popover" hidden>
            <div class="popover-row">
              <span class="popover-label">Mode</span>
              <label class="composer-pill">
                <select id="modeSelect" aria-label="Companion chat mode">
                  <option value="auto">Auto</option>
                  <option value="ask">Ask</option>
                  <option value="plan">Plan</option>
                  <option value="edit">Edit</option>
                  <option value="agent">Agent</option>
                </select>
              </label>
            </div>
            <div class="action-grid">
              <button id="clearTaskFocus" class="action-button">New task</button>
              <button id="continueAction" class="action-button">Continue</button>
              <button id="repairLoop" class="action-button">Repair</button>
              <button id="selfImprove" class="action-button">Self improve</button>
              <button id="autopilot" class="action-button">Autopilot</button>
              <button id="retryResearch" class="action-button">Research retry</button>
              <button id="runNextAction" class="action-button">Next action</button>
              <button id="queueNextTask" class="action-button">Queue task</button>
              <button id="openFiles" class="action-button">Files</button>
              <button id="openTrace" class="action-button">Trace</button>
              <button id="openTaskHub" class="action-button">Task hub</button>
              <button id="openProblems" class="action-button">Problems</button>
              <button id="openSandbox" class="action-button">Sandbox</button>
              <button id="openProviderSettings" class="action-button">Settings</button>
              <button id="reviewApprove" class="action-button">Approve</button>
              <button id="reviewReject" class="action-button">Reject</button>
              <button id="openSourceControl" class="action-button">SCM</button>
              <button id="openGitHistory" class="action-button">History</button>
            </div>
          </div>
          <textarea id="objective" placeholder="Describe what to build"></textarea>
          <div class="composer-controls">
            <div class="composer-left">
              <button id="toggleActions" class="icon-button">+</button>
              <button id="modePill" class="composer-pill buttonish" title="Change companion mode">
                <span id="modePillLabel" class="composer-pill-label">Agent</span>
              </button>
              <button id="modelPill" class="composer-pill buttonish" title="Open model and provider settings">
                <span id="modelPillLabel" class="composer-pill-label">Loading model</span>
              </button>
              <button id="toggleModeMenu" class="icon-button subtle">/</button>
            </div>
            <button id="submit" class="send-button">&gt;</button>
          </div>
        </section>
      </div>
    </div>
    <script id="initialState" type="application/json">${initialPayloadJson}</script>
    <script>
      const vscode = acquireVsCodeApi();
      const initialStateNode = document.getElementById('initialState');
      const conversation = document.getElementById('conversation');
      const transcript = document.getElementById('transcript');
      const objective = document.getElementById('objective');
      const summary = document.getElementById('summary');
      const threadTitle = document.getElementById('threadTitle');
      const taskFocusBadge = document.getElementById('taskFocusBadge');
      const modeSelect = document.getElementById('modeSelect');
      const modePillLabel = document.getElementById('modePillLabel');
      const modelPillLabel = document.getElementById('modelPillLabel');
      const actionPopover = document.getElementById('actionPopover');
      const activityRail = document.getElementById('activityRail');
      const activityLabel = document.getElementById('activityLabel');
      const activitySummary = document.getElementById('activitySummary');
      const activityList = document.getElementById('activityList');
      const panelRail = document.getElementById('panelRail');
      const proofSummary = document.getElementById('proofSummary');
      const logSummary = document.getElementById('logSummary');
      const buttons = {
        submit: document.getElementById('submit'),
        clearTaskFocus: document.getElementById('clearTaskFocus'),
        continueAction: document.getElementById('continueAction'),
        repairLoop: document.getElementById('repairLoop'),
        selfImprove: document.getElementById('selfImprove'),
        autopilot: document.getElementById('autopilot'),
        retryResearch: document.getElementById('retryResearch'),
        runNextAction: document.getElementById('runNextAction'),
        queueNextTask: document.getElementById('queueNextTask'),
        openTrace: document.getElementById('openTrace'),
        openFiles: document.getElementById('openFiles'),
        openTaskHub: document.getElementById('openTaskHub'),
        openProblems: document.getElementById('openProblems'),
        openSandbox: document.getElementById('openSandbox'),
        openProviderSettings: document.getElementById('openProviderSettings'),
        reviewApprove: document.getElementById('reviewApprove'),
        reviewReject: document.getElementById('reviewReject'),
        openSourceControl: document.getElementById('openSourceControl'),
        openGitHistory: document.getElementById('openGitHistory'),
        toggleActions: document.getElementById('toggleActions'),
        modePill: document.getElementById('modePill'),
        modelPill: document.getElementById('modelPill'),
        toggleModeMenu: document.getElementById('toggleModeMenu'),
        openPanel: document.getElementById('openPanel'),
      };
      let lastRenderedState = null;

      function setText(target, value, fallback = '') {
        if (target) {
          target.textContent = value || fallback;
        }
      }

      function setHidden(target, hidden) {
        if (target) {
          target.hidden = !!hidden;
        }
      }

      function setButtonDisabled(target, disabled) {
        if (target) {
          target.disabled = !!disabled;
        }
      }

      function setHtml(target, value) {
        if (target) {
          target.innerHTML = value || '';
        }
      }

      function firstText(values, fallback = '') {
        for (const value of values) {
          const text = String(value || '').trim();
          if (text) {
            return text;
          }
        }
        return fallback;
      }

      function scrollTranscriptToBottom() {
        if (conversation) {
          conversation.scrollTop = conversation.scrollHeight;
        }
      }

      function updateComposerButtons() {
        const ready = !!lastRenderedState?.ready;
        const running = !!lastRenderedState?.running;
        const hasDraft = !!String(objective?.value || '').trim();
        const hasChangedFiles = !!(lastRenderedState?.snapshot && Array.isArray(lastRenderedState.snapshot.changedFiles) && lastRenderedState.snapshot.changedFiles.length > 0);
        const hasArtifacts = !!(lastRenderedState?.snapshot && Array.isArray(lastRenderedState.snapshot.workbenchArtifacts) && lastRenderedState.snapshot.workbenchArtifacts.length > 0);
        setButtonDisabled(buttons.submit, !ready || running || !hasDraft);
        setButtonDisabled(buttons.clearTaskFocus, !lastRenderedState?.taskFocus);
        setButtonDisabled(buttons.continueAction, !ready || running || !lastRenderedState?.lastObjective);
        setButtonDisabled(buttons.repairLoop, !ready || running || !lastRenderedState?.lastObjective);
        setButtonDisabled(buttons.selfImprove, !ready || running);
        setButtonDisabled(buttons.autopilot, !ready || running);
        setButtonDisabled(buttons.retryResearch, !ready || running || !lastRenderedState?.lastObjective);
        setButtonDisabled(buttons.runNextAction, !ready || running || !lastRenderedState?.snapshot?.nextAction?.command);
        setButtonDisabled(buttons.queueNextTask, !ready || running || !(lastRenderedState?.queuedFollowupView?.exists || lastRenderedState?.snapshot?.nextAction?.command));
        setButtonDisabled(buttons.openTrace, !lastRenderedState?.snapshot);
        setButtonDisabled(buttons.openFiles, !hasChangedFiles);
        setButtonDisabled(buttons.openTaskHub, !ready);
        setButtonDisabled(buttons.openProblems, false);
        setButtonDisabled(buttons.openSandbox, !hasArtifacts);
        setButtonDisabled(buttons.openProviderSettings, !ready);
        setButtonDisabled(buttons.reviewApprove, !hasChangedFiles);
        setButtonDisabled(buttons.reviewReject, !hasChangedFiles);
        setButtonDisabled(buttons.openSourceControl, false);
        setButtonDisabled(buttons.openGitHistory, false);
      }

      function updateObjectivePlaceholder() {
        if (!objective) {
          return;
        }
        if (String(lastRenderedState?.taskFocus || '').trim()) {
          objective.placeholder = 'Add a follow-up for the current task or use /new';
          return;
        }
        const mode = String(modeSelect?.value || lastRenderedState?.selectedChatMode || 'auto').trim().toLowerCase();
        if (mode === 'ask') {
          objective.placeholder = 'Ask anything about this workspace';
          return;
        }
        if (mode === 'plan') {
          objective.placeholder = 'Plan the next safe coding slice';
          return;
        }
        if (mode === 'edit') {
          objective.placeholder = 'Describe the code change to prepare';
          return;
        }
        if (mode === 'agent') {
          objective.placeholder = 'Describe the bounded task to run';
          return;
        }
        objective.placeholder = 'Describe what to build';
      }

      function postMessage(type, extra = {}) {
        vscode.postMessage({ type, ...extra });
      }

      function toggleActionPopover(force) {
        if (!actionPopover) {
          return;
        }
        const nextHidden = typeof force === 'boolean' ? !force : !actionPopover.hidden;
        actionPopover.hidden = nextHidden;
      }

      function bindButton(button, type, extraFactory) {
        if (!button) {
          return;
        }
        button.addEventListener('click', () => {
          const extra = typeof extraFactory === 'function' ? extraFactory() : {};
          postMessage(type, extra);
        });
      }

      function renderTranscript(entries, fallbackText, fallbackMeta) {
        if (!transcript) {
          return;
        }
        const rows = Array.isArray(entries) && entries.length
          ? entries
          : [{ role: 'assistant', text: fallbackText, meta: fallbackMeta, kind: 'message' }];
        transcript.innerHTML = '';
        for (const entry of rows) {
          const role = String(entry?.role || 'assistant').trim().toLowerCase();
          const kind = String(entry?.kind || 'message').trim().toLowerCase();
          const row = document.createElement('article');
          row.className = 'transcript-row ' + role;
          if (role === 'user') {
            const bubble = document.createElement('div');
            bubble.className = 'user-bubble';
            bubble.textContent = String(entry?.text || '').trim();
            row.appendChild(bubble);
          } else {
            const copy = document.createElement('div');
            copy.className = kind === 'status' ? 'status-copy' : 'assistant-copy';
            copy.textContent = String(entry?.text || '').trim();
            row.appendChild(copy);
            if (entry?.meta) {
              const meta = document.createElement('div');
              meta.className = 'transcript-meta';
              meta.textContent = String(entry.meta || '').trim();
              row.appendChild(meta);
            }
          }
          transcript.appendChild(row);
        }
        scrollTranscriptToBottom();
      }

      function renderActivity(state, runtimeSummary, reviewSummary, gitSummary) {
        const snapshot = state.snapshot || null;
        const engineModelProofView = state.engineModelProofView || { label: 'No proof', summary: '', meta: '', nextAction: '' };
        const chips = [];
        if (state.chatModeView?.label) {
          chips.push(state.chatModeView.label);
        }
        if (runtimeSummary) {
          chips.push(runtimeSummary);
        }
        if (reviewSummary) {
          chips.push(reviewSummary);
        }
        if (gitSummary) {
          chips.push(gitSummary);
        }
        const nextAction = firstText([snapshot?.nextAction?.label, snapshot?.nextAction?.summary]);
        const changedCount = Number(snapshot?.changedFileCount || (Array.isArray(snapshot?.changedFiles) ? snapshot.changedFiles.length : 0) || 0);
        const shouldShow = !!(state.running || snapshot || state.errorMessage);
        setHidden(activityRail, !shouldShow);
        setHidden(panelRail, !shouldShow || ${isSidebar ? 'true' : 'false'});
        if (!shouldShow) {
          return;
        }
        setText(activityLabel, state.running ? 'Evaluating' : 'Recent run');
        setText(activitySummary, firstText([
          state.errorMessage,
          engineModelProofView.summary,
          snapshot?.runSummary?.summary,
          snapshot?.reviewSummary?.summary,
          nextAction ? 'Next: ' + nextAction : '',
          state.statusMessage,
        ], 'Waiting for the next bounded task.'));
        if (activityList) {
          activityList.innerHTML = '';
          for (const chipText of chips.slice(0, 4)) {
            const chip = document.createElement('span');
            chip.className = 'activity-chip';
            chip.textContent = chipText;
            activityList.appendChild(chip);
          }
          if (engineModelProofView.label) {
            const chip = document.createElement('span');
            chip.className = 'activity-chip';
            chip.textContent = 'Proof ' + engineModelProofView.label;
            activityList.appendChild(chip);
          }
          if (changedCount > 0) {
            const chip = document.createElement('span');
            chip.className = 'activity-chip';
            chip.textContent = changedCount + ' file' + (changedCount === 1 ? '' : 's');
            activityList.appendChild(chip);
          }
        }
        if (proofSummary) {
          setText(proofSummary, firstText([
            engineModelProofView.summary,
            engineModelProofView.meta,
            engineModelProofView.nextAction,
          ], 'Run npm run engine:cli -- proof-summary to capture the current Python and model path proof.'));
        }
        if (logSummary) {
          setText(logSummary, firstText([
            String(state.logTail || '').trim().split(/\\r?\\n/).filter(Boolean).slice(-1)[0] || '',
            nextAction,
            runtimeSummary,
          ], 'No log output captured yet.'));
        }
      }

      function renderState(state) {
        lastRenderedState = state || {};
        const ready = !!state.ready;
        const running = !!state.running;
        const snapshot = state.snapshot || null;
        const chatModeView = state.chatModeView || { label: 'Ask', meta: 'Human-style help, explanation, and repo guidance only.' };
        const currentModelView = state.currentModelView || { label: 'No model', detail: '' };
        const groundedReplyView = state.groundedReplyView || { label: 'Assistant', meta: '', reply: '' };
        const reviewBundleView = state.reviewBundleView || { decisionLabel: '', summary: '' };
        const gitSummaryView = state.gitSummaryView || { label: 'No git summary yet' };
        const statusText = state.errorMessage
          ? state.errorMessage
          : (state.statusMessage || (ready
            ? 'Companion is ready to submit bounded coding tasks through the shared GoSenderr runtime.'
            : 'Open the desktop-agent repo workspace so the companion can find the current runtime.'));
        const currentObjective = firstText([
          state.lastObjective,
          snapshot?.taskObjective?.summary,
          snapshot?.task,
        ]);
        const taskFocusText = firstText([
          state.taskFocus,
          snapshot?.taskFocus,
          currentObjective,
        ]);
        const followupText = taskFocusText && currentObjective && taskFocusText.toLowerCase() !== currentObjective.toLowerCase()
          ? currentObjective
          : '';
        const assistantText = firstText([
          state.assistantReply,
          groundedReplyView.reply,
          groundedReplyView.meta,
          statusText,
        ], 'Describe the change you want and send it to the shared GoSenderr runtime.');
        const assistantMetaText = [
          groundedReplyView.label,
          snapshot?.laneLabel || snapshot?.laneId,
          snapshot?.taskMode,
          snapshot?.modelDisplayName || snapshot?.modelProfileId,
        ].filter(Boolean).join(' • ');
        const runtimeSummary = snapshot
          ? [snapshot.status || 'ready', snapshot.taskMode || snapshot.laneLabel || snapshot.laneId].filter(Boolean).join(' • ')
          : (running ? 'Run in progress' : 'No run yet');
        const reviewSummary = reviewBundleView.decisionLabel || snapshot?.reviewSummary?.summary || 'No review yet';

        setText(summary, followupText ? ('Latest follow-up: ' + followupText) : statusText);
        setText(threadTitle, (taskFocusText || currentObjective || (ready ? 'Start a bounded coding task' : 'Open the GoSenderr workspace')).toUpperCase());
        setHidden(taskFocusBadge, !taskFocusText);
        setText(taskFocusBadge, taskFocusText ? ('Task focus: ' + taskFocusText) : '');
        setText(modePillLabel, chatModeView.label || 'Mode');
        setText(modelPillLabel, currentModelView.label || 'No model');
        if (buttons.modelPill) {
          buttons.modelPill.title = currentModelView.detail
            ? (String(currentModelView.label || '') + ' - ' + String(currentModelView.detail || ''))
            : String(currentModelView.label || 'Open provider settings');
        }
        if (modeSelect) {
          modeSelect.value = state.selectedChatMode || chatModeView.mode || 'auto';
        }
        renderTranscript(state.threadEntries, assistantText, assistantMetaText);
        renderActivity(state, runtimeSummary, reviewSummary, gitSummaryView.label || 'No git summary yet');
        if (!objective.value && state.lastObjective) {
          objective.value = state.lastObjective;
        }
        if (buttons.runNextAction) {
          buttons.runNextAction.textContent = snapshot?.nextAction?.label || 'Run next safe action';
        }
        setButtonDisabled(buttons.modelPill, !ready);
        updateObjectivePlaceholder();
        updateComposerButtons();
      }

      bindButton(buttons.submit, 'submit-task', () => ({ objective: objective.value }));
      bindButton(buttons.clearTaskFocus, 'clear-task-focus');
      bindButton(buttons.continueAction, 'continue-task');
      bindButton(buttons.repairLoop, 'repair-loop');
      bindButton(buttons.selfImprove, 'self-improve');
      bindButton(buttons.autopilot, 'autopilot');
      bindButton(buttons.retryResearch, 'retry-with-research');
      bindButton(buttons.runNextAction, 'run-next-action');
      bindButton(buttons.queueNextTask, 'queue-next-task');
      bindButton(buttons.openTrace, 'open-trace');
      bindButton(buttons.openFiles, 'open-files');
      bindButton(buttons.openTaskHub, 'open-task-hub');
      bindButton(buttons.openProblems, 'open-problems');
      bindButton(buttons.openSandbox, 'open-sandbox');
      bindButton(buttons.openProviderSettings, 'open-provider-settings');
      bindButton(buttons.reviewApprove, 'review-approve');
      bindButton(buttons.reviewReject, 'review-reject');
      bindButton(buttons.openSourceControl, 'open-source-control');
      bindButton(buttons.openGitHistory, 'open-git-history');
      bindButton(buttons.openPanel, 'open-panel');

      if (buttons.toggleActions) {
        buttons.toggleActions.addEventListener('click', () => toggleActionPopover());
      }
      if (buttons.modePill) {
        buttons.modePill.addEventListener('click', () => {
          toggleActionPopover(true);
          if (modeSelect) {
            modeSelect.focus();
          }
        });
      }
      if (buttons.modelPill) {
        buttons.modelPill.addEventListener('click', () => postMessage('open-provider-settings'));
      }
      if (buttons.toggleModeMenu) {
        buttons.toggleModeMenu.addEventListener('click', () => toggleActionPopover());
      }

      if (modeSelect) {
        modeSelect.addEventListener('change', () => {
          postMessage('set-chat-mode', { chatMode: modeSelect.value });
          updateObjectivePlaceholder();
        });
      }
      objective.addEventListener('input', () => {
        updateComposerButtons();
      });
      objective.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && buttons.submit && !buttons.submit.disabled) {
          postMessage('submit-task', { objective: objective.value });
        }
        if (event.key === 'Escape') {
          toggleActionPopover(false);
        }
      });

      window.addEventListener('message', (event) => {
        if (event?.data?.type === 'state') {
          renderState(event.data.payload || {});
        }
      });

      try {
        const initialState = initialStateNode ? JSON.parse(initialStateNode.textContent || '{}') : {};
        if (initialState && typeof initialState === 'object' && Object.keys(initialState).length > 0) {
          renderState(initialState);
        }
      } catch (_error) {
      }

      setTimeout(() => {
        vscode.postMessage({ type: 'bootstrap' });
      }, 0);
    </script>
  </body>
</html>`;
}

function listWorkbenchSurfaces(controller) {
  return [controller.panel, controller.view].filter((surface) => surface && surface.webview);
}

function buildFallbackStatePayload(controller, error) {
  const message = clipText(error instanceof Error ? error.message : String(error || 'Companion bootstrap failed.'), 220)
    || 'Companion bootstrap failed.';
  const selectedChatMode = resolveCompanionChatMode(controller.repoRoot, controller.chatMode || 'auto');
  const chatModeView = buildChatModeViewModel({ chatMode: selectedChatMode, effectiveChatMode: selectedChatMode }, { repoRoot: controller.repoRoot });
  return {
    workspaceRoot: controller.workspaceRoot,
    repoRoot: controller.repoRoot,
    ready: Boolean(controller.workspaceRoot && controller.repoRoot),
    running: controller.running,
    statusMessage: controller.statusMessage || 'Companion could not finish booting.',
    errorMessage: message,
    assistantReply: '',
    lastObjective: controller.lastObjective,
    taskFocus: controller.taskFocus,
    logTail: controller.logTail,
    selectedChatMode,
    currentModelView: {
      label: 'No model',
      detail: 'Companion bootstrap failed before model resolution.',
      provider: '',
      baseModel: '',
      modelRole: '',
      clickable: true,
    },
    threadEntries: asArray(controller.threadEntries),
    queuedFollowupView: buildQueuedFollowupViewModel({}),
    reviewBundleView: buildReviewBundleViewModel({}),
    memoryHintsView: buildMemoryHintsViewModel({}),
    chatModeView,
    groundedReplyView: {
      label: 'Companion bootstrap failed',
      meta: message,
      reply: '',
    },
    gitSummaryView: {
      label: 'Git unavailable',
      meta: 'Bootstrap did not complete.',
      branch: '',
      dirty: false,
    },
    engineModelProofView: buildEngineModelProofViewModel({}),
    selfHostProofView: buildSelfHostProofViewModel({}),
    selfImprovementProofView: buildSelfImprovementProofViewModel({}),
    snapshot: null,
  };
}

function setCompanionStartupError(controller, error, prefix = 'Companion startup failed.') {
  const message = clipText(error instanceof Error ? error.message : String(error || ''), 220);
  controller.errorMessage = message || prefix;
  controller.statusMessage = prefix;
}

function buildCurrentWorkbenchPayload(controller) {
  try {
    return buildStatePayload(controller);
  } catch (error) {
    return buildFallbackStatePayload(controller, error);
  }
}

function postState(controller) {
  const surfaces = listWorkbenchSurfaces(controller);
  if (!surfaces.length) {
    return;
  }
  const payload = buildCurrentWorkbenchPayload(controller);
  for (const surface of surfaces) {
    void surface.webview.postMessage({
      type: 'state',
      payload,
    });
  }
}

function getWorkbenchMessageHandler(controller) {
  if (controller.messageHandler) {
    return controller.messageHandler;
  }
  controller.messageHandler = async (message) => {
    const vscode = getVsCode();
    try {
      const type = String(message?.type || '').trim();
      if (type === 'bootstrap') {
        await refreshControllerContext(controller);
        postState(controller);
        return;
      }
      if (type === 'set-chat-mode') {
        const nextMode = await persistCompanionChatMode(controller, message?.chatMode || 'auto');
        const config = getCompanionChatModeConfig(controller.repoRoot, nextMode);
        setCompanionReply(controller, nextMode === 'auto'
          ? 'Auto mode is on. I will choose when to answer, plan, prepare edits, or use the bounded agent loop.'
          : `Switched to ${String(config.label || nextMode).trim()} mode.`);
        postState(controller);
        return;
      }
      if (type === 'submit-task') {
        await runObjective(controller, message?.objective || '', { retryWithResearch: false });
        return;
      }
      if (type === 'clear-task-focus') {
        clearCompanionTaskFocus(controller);
        postState(controller);
        return;
      }
      if (type === 'continue-task') {
        await runObjective(controller, controller.lastObjective, { retryWithResearch: false });
        return;
      }
      if (type === 'retry-with-research') {
        await runObjective(controller, controller.lastObjective, { retryWithResearch: true });
        return;
      }
      if (type === 'repair-loop') {
        await runRepairLoopFromCompanion(controller.context);
        return;
      }
      if (type === 'self-improve') {
        await runSelfImproveInBackground(controller.context);
        return;
      }
      if (type === 'autopilot') {
        await runAutopilotInBackground(controller.context);
        return;
      }
      if (type === 'review-approve') {
        await updateCompanionReviewDecision(controller, 'approved');
        return;
      }
      if (type === 'review-reject') {
        await updateCompanionReviewDecision(controller, 'rejected');
        return;
      }
      if (type === 'run-next-action') {
        await runNextAction(controller.context);
        return;
      }
      if (type === 'queue-next-task') {
        await queueNextTask(controller.context);
        return;
      }
      if (type === 'open-trace') {
        await openTraceDocument(controller);
        return;
      }
      if (type === 'open-files') {
        await openTouchedFiles(controller);
        return;
      }
      if (type === 'open-task-hub') {
        await openTaskHubDocument(controller);
        return;
      }
      if (type === 'open-problems') {
        await vscode.commands.executeCommand('workbench.actions.view.problems');
        return;
      }
      if (type === 'open-sandbox') {
        await openSandboxArtifact(controller);
        return;
      }
      if (type === 'open-provider-settings') {
        await openProviderSettings(controller);
        return;
      }
      if (type === 'open-source-control') {
        await openSourceControlView();
        return;
      }
      if (type === 'open-git-history') {
        await openGitHistoryView();
        return;
      }
      if (type === 'open-panel') {
        await openWorkbenchPanel(controller.context);
      }
    } catch (error) {
      setCompanionStartupError(controller, error, 'Companion request handling failed.');
      postState(controller);
    }
  };
  return controller.messageHandler;
}

function attachWorkbenchSurface(controller, surface, surfaceKind = WORKBENCH_SURFACE_PANEL) {
  if (!surface || !surface.webview) {
    return;
  }
  surface.webview.options = {
    ...(surface.webview.options || {}),
    enableScripts: true,
  };
  if (controller.boundWebviews.has(surface.webview) && controller.boundSurfaceKinds.get(surface.webview) === surfaceKind) {
    return;
  }
  if (!controller.boundWebviews.has(surface.webview)) {
    surface.webview.onDidReceiveMessage(getWorkbenchMessageHandler(controller));
    controller.boundWebviews.add(surface.webview);
  }
  controller.boundSurfaceKinds.set(surface.webview, surfaceKind);
  surface.webview.html = buildWorkbenchHtml(surfaceKind, { initialPayload: buildCurrentWorkbenchPayload(controller) });
}

async function openPathInEditor(targetPath) {
  const vscode = getVsCode();
  const document = await vscode.workspace.openTextDocument(targetPath);
  await vscode.window.showTextDocument(document, { preview: false });
}

async function openTraceDocument(controller) {
  const vscode = getVsCode();
  if (!controller.lastResult && !controller.lastSnapshot) {
    await vscode.window.showInformationMessage('No trace is available yet.');
    return;
  }
  const document = await vscode.workspace.openTextDocument({
    language: 'json',
    content: JSON.stringify({
      objective: controller.lastObjective,
      snapshot: controller.lastSnapshot,
      result: controller.lastResult,
    }, null, 2),
  });
  await vscode.window.showTextDocument(document, { preview: false });
}

async function openTouchedFiles(controller) {
  const vscode = getVsCode();
  const candidates = collectWorkspaceFileCandidates(controller.lastSnapshot || {}, controller.workspaceRoot);
  if (!candidates.length) {
    await vscode.window.showInformationMessage('No touched files are available yet.');
    return;
  }
  if (candidates.length === 1) {
    await openPathInEditor(candidates[0]);
    return;
  }
  const choice = await vscode.window.showQuickPick(
    candidates.map((candidate) => ({
      label: path.basename(candidate),
      description: candidate,
      candidate,
    })),
    { placeHolder: 'Open a touched file from the latest GoSenderr run.' },
  );
  if (choice?.candidate) {
    await openPathInEditor(choice.candidate);
  }
}

async function openSourceControlView() {
  const vscode = getVsCode();
  await vscode.commands.executeCommand('workbench.view.scm');
}

async function openGitHistoryView() {
  const vscode = getVsCode();
  const availableCommands = typeof vscode.commands.getCommands === 'function'
    ? await vscode.commands.getCommands(true)
    : [];
  const preferredCommands = [
    'git.viewHistory',
    'git.openRepository',
    'workbench.view.scm',
  ];
  const command = preferredCommands.find((entry) => availableCommands.includes(entry)) || 'workbench.view.scm';
  await vscode.commands.executeCommand(command);
}

async function openSandboxArtifact(controller) {
  const vscode = getVsCode();
  const candidates = collectArtifactCandidates(controller.lastSnapshot || {}, controller.lastResult || {}, controller.workspaceRoot);
  if (!candidates.length) {
    await vscode.window.showInformationMessage('No sandbox or artifact path is available yet.');
    return;
  }
  await openPathInEditor(candidates[0]);
}

async function openProviderSettings(controller) {
  const vscode = getVsCode();
  const targetPath = resolveProviderSettingsPath(controller.repoRoot);
  if (!targetPath) {
    await vscode.window.showWarningMessage('Provider settings are not available in this workspace.');
    return;
  }
  await openPathInEditor(targetPath);
}

async function openTaskHubDocument(controller) {
  const vscode = getVsCode();
  const targetPath = resolveTaskHubDocumentPath(controller.repoRoot, controller.workspaceRoot);
  if (!targetPath || !fs.existsSync(targetPath)) {
    await vscode.window.showInformationMessage('No task hub has been created for this workspace yet.');
    return;
  }
  await openPathInEditor(targetPath);
}

function quoteTerminalArg(value = '') {
  const text = String(value || '').trim();
  if (!text) {
    return '""';
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function buildCompanionCliCommand(repoRoot = '', command = 'status', options = {}) {
  const root = String(repoRoot || '').trim();
  if (!root) {
    throw new Error('GoSenderr desktop-agent repo root is not available.');
  }
  const workspaceRoot = String(options.workspaceRoot || '').trim();
  const labRoot = String(options.labRoot || '').trim();
  const title = String(options.title || '').trim();
  const trailing = asArray(options.trailing).map((entry) => String(entry || '').trim()).filter(Boolean);
  const cliScriptPath = path.join(root, 'scripts', 'engine-cli.js');
  const parts = [quoteTerminalArg(process.execPath), quoteTerminalArg(cliScriptPath), String(command || 'status').trim().toLowerCase() || 'status'];
  if (workspaceRoot) {
    parts.push('--workspace', quoteTerminalArg(workspaceRoot));
  }
  if (labRoot) {
    parts.push('--lab', quoteTerminalArg(labRoot));
  }
  if (title) {
    parts.push('--title', quoteTerminalArg(title));
  }
  for (const entry of trailing) {
    parts.push(quoteTerminalArg(entry));
  }
  return parts.join(' ');
}

async function runSelfImproveInBackground(context) {
  const vscode = getVsCode();
  const controller = workbenchController || await ensureWorkbench(context);
  if (!controller.repoRoot || !controller.workspaceRoot) {
    await vscode.window.showWarningMessage('Open the GoSenderr desktop-agent repo workspace before starting background self-improvement.');
    return;
  }
  if (controller.running) {
    await vscode.window.showInformationMessage('Wait for the current companion run to finish before starting a background self-improvement pass.');
    return;
  }
  const terminal = vscode.window.createTerminal({
    name: 'GoSenderr Self Improve',
    cwd: controller.repoRoot,
  });
  terminal.sendText(buildCompanionCliCommand(controller.repoRoot, 'self-improve', {
    workspaceRoot: controller.workspaceRoot,
  }), true);
  terminal.sendText(buildCompanionCliCommand(controller.repoRoot, 'proof-summary', {
    workspaceRoot: controller.workspaceRoot,
    title: 'VS Code companion self-improve pass',
    trailing: ['Run a bounded supervised self-improvement pass from the VS Code companion and refresh the shared proof artifact.'],
  }), true);
  terminal.show(true);
  setCompanionReply(
    controller,
    'Started a background CLI self-improve pass in the GoSenderr Self Improve terminal. Keep coding here, then refresh the companion view to inspect the updated self-improvement proof.',
    {
      kind: 'status',
      keepStatus: true,
      meta: 'CLI-backed background pass',
    },
  );
  controller.statusMessage = 'Background self-improvement is running in the GoSenderr Self Improve terminal.';
  controller.errorMessage = '';
  postState(controller);
}

async function runAutopilotInBackground(context) {
  const vscode = getVsCode();
  const controller = workbenchController || await ensureWorkbench(context);
  if (!controller.repoRoot || !controller.workspaceRoot) {
    await vscode.window.showWarningMessage('Open the GoSenderr desktop-agent repo workspace before starting a background autopilot pass.');
    return;
  }
  if (controller.running) {
    await vscode.window.showInformationMessage('Wait for the current companion run to finish before starting a background autopilot pass.');
    return;
  }
  const terminal = vscode.window.createTerminal({
    name: 'GoSenderr Autopilot',
    cwd: controller.repoRoot,
  });
  terminal.sendText(buildCompanionCliCommand(controller.repoRoot, 'autopilot', {
    workspaceRoot: controller.workspaceRoot,
  }), true);
  terminal.sendText(buildCompanionCliCommand(controller.repoRoot, 'proof-summary', {
    workspaceRoot: controller.workspaceRoot,
    title: 'VS Code companion autopilot pass',
    trailing: ['Run one bounded supervised autopilot pass from the VS Code companion and refresh the shared proof artifact.'],
  }), true);
  terminal.show(true);
  setCompanionReply(
    controller,
    'Started a background CLI autopilot pass in the GoSenderr Autopilot terminal. Keep coding here, then refresh the companion view to inspect the updated bounded-autonomy proof and next safe action.',
    {
      kind: 'status',
      keepStatus: true,
      meta: 'CLI-backed background autopilot pass',
    },
  );
  controller.statusMessage = 'Background autopilot is running in the GoSenderr Autopilot terminal.';
  controller.errorMessage = '';
  postState(controller);
}

async function runObjective(controller, objective, options = {}) {
  const vscode = getVsCode();
  const rawText = String(objective || '').trim();
  if (!rawText) {
    await vscode.window.showWarningMessage('Enter a bounded objective before running the companion.');
    return;
  }
  if (!controller.repoRoot || !controller.workspaceRoot) {
    await vscode.window.showWarningMessage('Open the GoSenderr desktop-agent repo as your workspace before using the companion.');
    return;
  }
  if (controller.running) {
    await vscode.window.showInformationMessage('A GoSenderr companion run is already in progress.');
    return;
  }

  const directive = parseCompanionChatModeDirective(controller.repoRoot, rawText);
  const chatMode = directive.mode
    ? await persistCompanionChatMode(controller, directive.mode)
    : resolveCompanionChatMode(controller.repoRoot, controller.chatMode || 'auto');
  const candidateText = directive.mode ? String(directive.message || '').trim() : rawText;
  const explicitNewTask = isExplicitNewTaskRequest(candidateText);
  const text = explicitNewTask ? stripNewTaskDirective(candidateText) : candidateText;
  if (directive.mode && !text) {
    const config = getCompanionChatModeConfig(controller.repoRoot, chatMode);
    setCompanionReply(controller, chatMode === 'auto'
      ? 'Auto mode is on. I will choose when to answer, plan, prepare edits, or use the bounded agent loop.'
      : `Switched to ${String(config.label || chatMode).trim()} mode.`);
    postState(controller);
    return;
  }
  if (explicitNewTask && !text) {
    clearCompanionTaskFocus(controller);
    postState(controller);
    return;
  }
  if (await runCompanionSlashCommand(controller, text)) {
    return;
  }
  const modeState = inferCompanionChatModeState(controller.repoRoot, chatMode, text);
  const previousTaskFocus = explicitNewTask ? '' : String(controller.taskFocus || '').trim();
  const taskFocus = previousTaskFocus || text;
  const scopedObjective = previousTaskFocus ? buildFocusedFollowupObjective(previousTaskFocus, text) : text;

  const runtimeBridge = loadRuntimeBridge(controller.repoRoot, controller.workspaceRoot);
  const actualObjective = options.retryWithResearch ? buildResearchObjective(scopedObjective) : scopedObjective;
  appendThreadEntry(controller, 'user', text);
  const request = buildOrchestrateRequest(actualObjective, controller.workspaceRoot, {
    ...options,
    repoRoot: controller.repoRoot,
    taskFocus,
    chatMode,
    effectiveChatMode: modeState.effectiveChatMode,
    suggestedLaneId: modeState.suggestedLaneId,
    suggestedTaskMode: modeState.suggestedTaskMode,
  });
  controller.taskFocus = taskFocus;
  controller.lastObjective = text;
  controller.lastRequest = request;
  controller.lastResult = null;
  controller.lastSnapshot = null;
  controller.lastQueuedFollowup = null;
  controller.lastAssistantReply = '';
  controller.logTail = '';
  controller.errorMessage = '';
  controller.statusMessage = `Running ${options.retryWithResearch ? 'a research-first retry' : `${getCompanionChatModeConfig(controller.repoRoot, modeState.effectiveChatMode).label.toLowerCase()} mode`} through the shared GoSenderr loop…`;
  appendThreadEntry(controller, 'assistant', controller.statusMessage, { kind: 'status' });
  controller.running = true;
  postState(controller);

  const operation = runtimeBridge.client.startAction(request, {
    onStdout(textChunk) {
      controller.logTail = `${controller.logTail}${String(textChunk || '')}`.slice(-120000);
      postState(controller);
    },
    onStderr(textChunk) {
      controller.logTail = `${controller.logTail}${String(textChunk || '')}`.slice(-120000);
      postState(controller);
    },
  });

  controller.currentOperation = operation;
  const finished = await operation.promise;
  controller.currentOperation = null;
  controller.running = false;

  const rawResult = finished?.result && typeof finished.result === 'object' ? finished.result : {};
  const snapshot = runtimeBridge.buildOperatorExecutionSnapshot(rawResult.operatorExecution || rawResult.operator_execution || rawResult, {
    task: String(rawResult.task || rawResult.objective || controller.lastObjective || '').trim(),
    action: String(rawResult.action || request.action || 'orchestrate').trim(),
    taskMode: String(rawResult.taskMode || rawResult.task_mode || 'coder').trim(),
    artifactPaths: asArray(rawResult.artifactPaths || rawResult.artifact_paths),
  });

  controller.lastResult = rawResult;
  controller.lastSnapshot = {
    ...snapshot,
    taskFocus,
    chatMode,
    effectiveChatMode: modeState.effectiveChatMode,
    suggestedLaneId: modeState.suggestedLaneId,
    suggestedTaskMode: modeState.suggestedTaskMode,
  };
  controller.statusMessage = finished?.exitCode === 0
    ? 'GoSenderr completed the latest chat run.'
    : 'GoSenderr finished with a failing or blocked result. Open the trace and follow the recorded next action.';
  controller.errorMessage = finished?.exitCode === 0 ? '' : clipText(rawResult.message || rawResult.summary || rawResult.error || '');
  controller.logTail = `${controller.logTail}\n${String(finished?.stdout || '')}\n${String(finished?.stderr || '')}`.trim().slice(-120000);
  setCompanionReply(controller, buildCompanionResultReply(controller.lastSnapshot, rawResult, finished), {
    keepStatus: true,
    meta: [controller.lastSnapshot?.modelDisplayName || controller.lastSnapshot?.modelProfileId, controller.lastSnapshot?.taskMode].filter(Boolean).join(' • '),
  });
  postState(controller);
}

function createWorkbenchController(context) {
  return {
    context,
    panel: null,
    view: null,
    workspaceRoot: '',
    repoRoot: '',
    running: false,
    logTail: '',
    statusMessage: '',
    errorMessage: '',
    chatMode: 'auto',
    lastAssistantReply: '',
    threadEntries: [],
    taskFocus: '',
    lastObjective: '',
    lastRequest: null,
    lastResult: null,
    lastSnapshot: null,
    lastQueuedFollowup: null,
    currentOperation: null,
    boundWebviews: new WeakSet(),
    boundSurfaceKinds: new WeakMap(),
    groundedReplyCacheKey: '',
    groundedReplyCacheValue: null,
    messageHandler: null,
  };
}

async function refreshControllerContext(controller) {
  const vscode = getVsCode();
  controller.workspaceRoot = resolveWorkspaceRoot(vscode);
  controller.repoRoot = resolveCompanionRepoRoot({
    workspaceRoots: asArray(vscode.workspace.workspaceFolders).map((folder) => folder.uri.fsPath),
    extensionRoot: controller.context.extensionPath,
  });
  controller.chatMode = resolveCompanionChatMode(
    controller.repoRoot,
    controller.context.workspaceState.get(COMPANION_CHAT_MODE_KEY, controller.chatMode || 'auto'),
  );
  if (!controller.workspaceRoot) {
    controller.statusMessage = 'Open a workspace folder to run the GoSenderr companion.';
  } else if (!controller.repoRoot) {
    controller.statusMessage = 'The companion could not find the GoSenderr desktop-agent runtime in the current workspace.';
  } else if (!controller.running) {
    controller.statusMessage = 'Companion is ready to submit bounded coding tasks through the shared GoSenderr runtime.';
  }
}

async function openWorkbenchPanel(context) {
  const vscode = getVsCode();
  if (!workbenchController) {
    workbenchController = createWorkbenchController(context);
  }
  const controller = workbenchController;

  if (!controller.panel) {
    controller.panel = vscode.window.createWebviewPanel(
      'gosenderrWorkbench',
      'GoSenderr Chat',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    attachWorkbenchSurface(controller, controller.panel, WORKBENCH_SURFACE_PANEL);
    controller.panel.onDidDispose(() => {
      controller.panel = null;
    });
  }

  await refreshControllerContext(controller);
  attachWorkbenchSurface(controller, controller.panel, WORKBENCH_SURFACE_PANEL);
  controller.panel.reveal(vscode.ViewColumn.Beside, true);
  postState(controller);
  return controller;
}

async function openWorkbench(context) {
  const vscode = getVsCode();
  if (!workbenchController) {
    workbenchController = createWorkbenchController(context);
  }
  const controller = workbenchController;
  await refreshControllerContext(controller);
  await vscode.commands.executeCommand(`workbench.view.extension.${WORKBENCH_VIEW_CONTAINER_ID}`);
  if (controller.view && typeof controller.view.show === 'function') {
    controller.view.show?.(true);
  }
  postState(controller);
  return controller;
}

async function ensureWorkbench(context) {
  const controller = await openWorkbench(context);
  return controller;
}

async function openLatestTrace(context) {
  const controller = workbenchController || await ensureWorkbench(context);
  await openTraceDocument(controller);
}

async function continueLastTask(context, retryWithResearch = false) {
  const controller = workbenchController || await ensureWorkbench(context);
  await runObjective(controller, controller.lastObjective, { retryWithResearch });
}

async function runRepairLoopFromCompanion(context, options = {}) {
  const vscode = getVsCode();
  const controller = workbenchController || await ensureWorkbench(context);
  if (!controller.lastObjective) {
    await vscode.window.showInformationMessage('Run a bounded task first so the companion has a repair target.');
    return;
  }
  if (options.announce !== false) {
    await vscode.window.showInformationMessage('Running a repair-oriented retry through the shared GoSenderr loop.');
  }
  await runObjective(controller, buildRepairObjective(controller.lastObjective), { retryWithResearch: false });
}

async function runNextAction(context) {
  const vscode = getVsCode();
  const controller = workbenchController || await ensureWorkbench(context);
  const command = resolveNextActionCommand(controller.lastSnapshot);
  if (!command) {
    await vscode.window.showInformationMessage('No shared next safe action is available yet.');
    return;
  }
  if (command === 'continue-run') {
    await runObjective(controller, controller.lastObjective, { retryWithResearch: false });
    return;
  }
  if (command === 'retry-with-research') {
    await runObjective(controller, controller.lastObjective, { retryWithResearch: true });
    return;
  }
  if (command === 'repair-loop') {
    await runRepairLoopFromCompanion(context, { announce: true });
    return;
  }
  if (command === 'open-files') {
    await openTouchedFiles(controller);
    return;
  }
  if (command === 'open-trace') {
    await openTraceDocument(controller);
    return;
  }
  if (command === 'open-sandbox') {
    await openSandboxArtifact(controller);
    return;
  }
  if (command === 'review-interrupt') {
    await vscode.window.showInformationMessage('Opening the latest trace so you can inspect the current interrupt and review hold.');
    await openTraceDocument(controller);
    return;
  }
  await vscode.window.showInformationMessage(`The shared next safe action "${command}" is not wired in the VS Code companion yet.`);
}

async function queueNextTask(context) {
  const vscode = getVsCode();
  const controller = workbenchController || await ensureWorkbench(context);
  if (!controller.lastSnapshot) {
    await vscode.window.showInformationMessage('Run a bounded task first so the engine can derive a queued follow-up.');
    return;
  }
  const result = queueNextTaskLoopFollowupInWorkspace({
    repoRoot: controller.repoRoot,
    workspaceRoot: controller.workspaceRoot,
    snapshot: controller.lastSnapshot,
    context: {
      targetWorkspaceRoot: controller.workspaceRoot,
    },
  });
  controller.lastQueuedFollowup = result;
  controller.statusMessage = result?.ok
    ? (result.deduped
      ? 'The current bounded follow-up is already queued in the task hub.'
      : `Queued ${String(result.createdCount || 0)} bounded follow-up step${Number(result.createdCount || 0) === 1 ? '' : 's'} from the shared next action.`)
    : String(result?.message || 'The engine could not queue a bounded follow-up yet.');
  controller.errorMessage = result?.ok ? '' : clipText(result?.message || '');
  postState(controller);
}

async function submitTaskFromInput(context) {
  const vscode = getVsCode();
  const controller = workbenchController || await ensureWorkbench(context);
  const objective = await vscode.window.showInputBox({
    prompt: 'Describe the bounded coding task for GoSenderr.',
    placeHolder: 'Repair the failing validation path in renderer/app.js and rerun the smallest relevant checks.',
    value: controller.lastObjective || '',
    ignoreFocusOut: true,
  });
  if (objective) {
    await runObjective(controller, objective, { retryWithResearch: false });
  }
}

function activate(context) {
  const vscode = getVsCode();
  const workbenchViewProvider = {
    resolveWebviewView(webviewView) {
      if (!workbenchController) {
        workbenchController = createWorkbenchController(context);
      }
      const controller = workbenchController;
      controller.view = webviewView;
      attachWorkbenchSurface(controller, webviewView, WORKBENCH_SURFACE_SIDEBAR);
      const disposables = [];
      if (typeof webviewView.onDidDispose === 'function') {
        disposables.push(webviewView.onDidDispose(() => {
          if (controller.view === webviewView) {
            controller.view = null;
          }
        }));
      }
      if (typeof webviewView.onDidChangeVisibility === 'function') {
        disposables.push(webviewView.onDidChangeVisibility(() => {
          if (webviewView.visible) {
            attachWorkbenchSurface(controller, webviewView, WORKBENCH_SURFACE_SIDEBAR);
            postState(controller);
          }
        }));
      }
      context.subscriptions.push(...disposables);
      void refreshControllerContext(controller).then(() => {
        attachWorkbenchSurface(controller, webviewView, WORKBENCH_SURFACE_SIDEBAR);
        postState(controller);
      }).catch((error) => {
        setCompanionStartupError(controller, error);
        attachWorkbenchSurface(controller, webviewView, WORKBENCH_SURFACE_SIDEBAR);
        postState(controller);
      });
    },
  };
  const commands = [
    vscode.commands.registerCommand('gosenderr.openDesktopAgent', async () => {
      await openWorkbenchPanel(context);
    }),
    vscode.commands.registerCommand('gosenderr.openWorkbench', async () => {
      await openWorkbench(context);
    }),
    vscode.commands.registerCommand('gosenderr.openWorkbenchPanel', async () => {
      await openWorkbenchPanel(context);
    }),
    vscode.commands.registerCommand('gosenderr.submitTask', async () => {
      await submitTaskFromInput(context);
    }),
    vscode.commands.registerCommand('gosenderr.continueTask', async () => {
      await continueLastTask(context, false);
    }),
    vscode.commands.registerCommand('gosenderr.retryWithResearch', async () => {
      await continueLastTask(context, true);
    }),
    vscode.commands.registerCommand('gosenderr.repairLoop', async () => {
      await runRepairLoopFromCompanion(context, { announce: true });
    }),
    vscode.commands.registerCommand('gosenderr.selfImprove', async () => {
      await runSelfImproveInBackground(context);
    }),
    vscode.commands.registerCommand('gosenderr.autopilot', async () => {
      await runAutopilotInBackground(context);
    }),
    vscode.commands.registerCommand('gosenderr.reviewApprove', async () => {
      const controller = workbenchController || await ensureWorkbench(context);
      await updateCompanionReviewDecision(controller, 'approved');
    }),
    vscode.commands.registerCommand('gosenderr.reviewReject', async () => {
      const controller = workbenchController || await ensureWorkbench(context);
      await updateCompanionReviewDecision(controller, 'rejected');
    }),
    vscode.commands.registerCommand('gosenderr.runNextAction', async () => {
      await runNextAction(context);
    }),
    vscode.commands.registerCommand('gosenderr.queueNextTask', async () => {
      await queueNextTask(context);
    }),
    vscode.commands.registerCommand('gosenderr.openTrace', async () => {
      await openLatestTrace(context);
    }),
    vscode.commands.registerCommand('gosenderr.openFiles', async () => {
      const controller = workbenchController || await ensureWorkbench(context);
      await openTouchedFiles(controller);
    }),
    vscode.commands.registerCommand('gosenderr.openTaskHub', async () => {
      const controller = workbenchController || await ensureWorkbench(context);
      await openTaskHubDocument(controller);
    }),
    vscode.commands.registerCommand('gosenderr.openProblems', async () => {
      await vscode.commands.executeCommand('workbench.actions.view.problems');
    }),
    vscode.commands.registerCommand('gosenderr.openSandbox', async () => {
      const controller = workbenchController || await ensureWorkbench(context);
      await openSandboxArtifact(controller);
    }),
    vscode.commands.registerCommand('gosenderr.openProviderSettings', async () => {
      const controller = workbenchController || await ensureWorkbench(context);
      await openProviderSettings(controller);
    }),
    vscode.commands.registerCommand('gosenderr.openSourceControl', async () => {
      await openSourceControlView();
    }),
    vscode.commands.registerCommand('gosenderr.openGitHistory', async () => {
      await openGitHistoryView();
    }),
  ];

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(WORKBENCH_VIEW_ID, workbenchViewProvider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
    ...commands,
  );
}

function deactivate() {
  if (workbenchController?.currentOperation?.cancel) {
    workbenchController.currentOperation.cancel();
  }
}

module.exports = {
  activate,
  deactivate,
  buildOrchestrateRequest,
  buildTaskObjective,
  buildResearchObjective,
  buildRepairObjective,
  buildMemoryHintsViewModel,
  buildEngineModelProofViewModel,
  buildSelfHostProofViewModel,
  buildSelfImprovementProofViewModel,
  buildReviewBundleViewModel,
  buildQueuedFollowupViewModel,
  buildChatModeViewModel,
  buildGroundedReplyViewModel,
  buildWorkbenchHtml,
  buildStatePayload,
  buildCompanionCliCommand,
  collectWorkspaceFileCandidates,
  openTraceDocument,
  queueNextTaskLoopFollowupInWorkspace,
  resolveNextActionCommand,
  resolveCompanionRepoRoot,
  resolveTaskHubDocumentPath,
  setVsCodeModuleForTests,
  updateCompanionReviewDecision,
  WORKBENCH_SURFACE_SIDEBAR,
  WORKBENCH_SURFACE_PANEL,
  WORKBENCH_VIEW_CONTAINER_ID,
  WORKBENCH_VIEW_ID,
};
