'use strict';

const fs = require('fs');
const path = require('path');

let vscodeModule = null;
let workbenchController = null;

const WORKBENCH_VIEW_CONTAINER_ID = 'gosenderrSidebar';
const WORKBENCH_VIEW_ID = 'gosenderr.workbenchView';

function getVsCode() {
  if (!vscodeModule) {
    vscodeModule = require('vscode');
  }
  return vscodeModule;
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
  return {
    label: decisionLabel || summary || 'No review bundle yet',
    meta: [
      summary && summary !== decisionLabel ? summary : '',
      reason ? `reason: ${reason}` : '',
      howToFix ? `fix: ${howToFix}` : '',
      changeSummary ? `changes: ${changeSummary}` : '',
      bundle.requiresManualReview ? 'manual review required' : '',
      bundle.pendingCount ? `${String(bundle.pendingCount)} pending` : '',
    ].filter(Boolean).join(' • '),
    decisionLabel,
    summary,
    reason,
    howToFix,
    changeSummary,
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
  const label = clipText(proof.label || '', 80);
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
  const label = clipText(proof.label || '', 80);
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
  return {
    summary: String(objective || '').trim(),
    kind: options.retryWithResearch === true ? 'research-retry' : 'coding-task',
    source: 'vscode-companion',
    loopSteps: ['goal', 'observe', 'research', 'propose', 'apply', 'validate', 'review', 'learn', 'continue-stop'],
  };
}

function buildOrchestrateRequest(objective, workspaceRoot, options = {}) {
  const text = String(objective || '').trim();
  const targetRoot = String(workspaceRoot || '').trim();
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
    taskObjective,
    metadata: {
      surface: 'vscode-companion',
      retry_with_research: options.retryWithResearch === true,
      source: 'integration-library/extensions/vscode-companion',
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
    const { readLatestAcceptanceReport } = require(path.join(root, 'core', 'engine-acceptance.js'));
    const acceptance = readLatestAcceptanceReport(targetRoot);
    const report = acceptance?.report && typeof acceptance.report === 'object' ? acceptance.report : {};
    const checks = asArray(report.checks).filter((check) => /^self-host-/.test(String(check?.id || '').trim().toLowerCase()));
    const failing = checks.filter((check) => String(check?.status || '').trim().toLowerCase() === 'fail');
    const passing = checks.filter((check) => String(check?.status || '').trim().toLowerCase() === 'pass');
    const smokeCheck = checks.find((check) => String(check?.id || '').trim() === 'self-host-smoke') || null;
    if (checks.length === 0) {
      return {
        label: acceptance?.exists ? 'PARTIAL' : 'NOT RUN',
        summary: acceptance?.exists
          ? 'No self-host proof checks are recorded in the latest acceptance bundle yet.'
          : 'No self-host proof is recorded yet.',
        nextAction: 'Run npm run engine:acceptance -- --full-self-host before widening self-work.',
        blockerSummary: '',
      };
    }
    if (failing.length > 0) {
      return {
        label: 'BLOCKED',
        summary: `${failing.length}/${checks.length} self-host proof check(s) failed.`,
        blockerSummary: String(failing[0]?.summary || failing[0]?.label || 'A self-host proof check failed.').trim(),
        nextAction: String(report?.nextAction || 'Repair the failing self-host proof and rerun the full self-host acceptance suite.').trim(),
      };
    }
    if (!smokeCheck) {
      return {
        label: 'PARTIAL',
        summary: `Self-host bootstrap/tests passed (${passing.length}/${checks.length}), but smoke proof is still missing.`,
        blockerSummary: '',
        nextAction: 'Run npm run engine:acceptance -- --full-self-host to add smoke proof.',
      };
    }
    return {
      label: 'PROVEN',
      summary: `Self-host proof passed (${passing.length}/${checks.length}), including smoke.`,
      blockerSummary: '',
      nextAction: 'Keep the next self-host slice bounded and rerun the same proof after meaningful self-work.',
    };
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
  if (['ask', 'plan', 'edit', 'agent'].includes(explicit)) {
    return explicit;
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

function buildChatModeViewModel(snapshot = {}) {
  const mode = inferChatModeFromSnapshot(snapshot);
  const label = mode.charAt(0).toUpperCase() + mode.slice(1);
  const metaByMode = {
    ask: 'Human-style help, explanation, and repo guidance only.',
    plan: 'Scoped planning, risks, and next steps without launching edits.',
    edit: 'Code-focused changes and repair flow, with confirmation before execution.',
    agent: 'Bounded next-safe actions through the supervised engine loop.',
  };
  return {
    mode,
    label,
    meta: metaByMode[mode] || metaByMode.ask,
  };
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
  const chatModeView = buildChatModeViewModel(snapshot || {});
  const selfHostProof = readCompanionSelfHostProof(controller.repoRoot, controller.workspaceRoot);
  const selfImprovementProof = readCompanionSelfImprovementProof(controller.repoRoot);
  return {
    workspaceRoot: controller.workspaceRoot,
    repoRoot: controller.repoRoot,
    ready: Boolean(controller.workspaceRoot && controller.repoRoot),
    running: controller.running,
    statusMessage: controller.statusMessage,
    errorMessage: controller.errorMessage,
    lastObjective: controller.lastObjective,
    logTail: controller.logTail,
    queuedFollowupView: buildQueuedFollowupViewModel(queuedFollowup || {}),
    reviewBundleView: buildReviewBundleViewModel(snapshot || {}),
    memoryHintsView: buildMemoryHintsViewModel(memoryHints),
    chatModeView,
    gitSummaryView,
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
      failureClass: snapshot.failureClass || {},
      recoveryLadder: snapshot.recoveryLadder || {},
      checkpointRef: snapshot.checkpointRef || {},
      interruptRequest: snapshot.interruptRequest || {},
      reviewBundle: snapshot.reviewBundle || {},
      chatMode: chatModeView.mode,
      nextAction: snapshot.nextAction || {},
      queuedFollowup: snapshot.queuedFollowup || {},
      memoryHints,
      workbenchArtifacts: asArray(snapshot.workbenchArtifacts),
    } : null,
  };
}

function buildWorkbenchHtml() {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>GoSenderr Workbench</title>
    <style>
      body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        margin: 0;
        padding: 16px;
      }
      .shell { display: grid; gap: 16px; }
      .card {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 12px;
        padding: 14px;
        background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-panel-border));
      }
      .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
      .row button {
        border-radius: 999px;
        border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        padding: 8px 12px;
        cursor: pointer;
      }
      .row button.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }
      .row button:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.12em;
        font-size: 11px;
        opacity: 0.75;
      }
      h1, h2, h3, p, pre { margin: 0; }
      textarea {
        width: 100%;
        min-height: 120px;
        resize: vertical;
        border-radius: 12px;
        border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        padding: 12px;
        box-sizing: border-box;
      }
      .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
      .meta { font-size: 12px; opacity: 0.85; }
      .status-ok { color: var(--vscode-testing-iconPassed); }
      .status-warn { color: var(--vscode-testing-iconQueued); }
      .status-error { color: var(--vscode-testing-iconFailed); }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 260px;
        overflow: auto;
        font-family: var(--vscode-editor-font-family);
        font-size: 12px;
      }
      ul { margin: 8px 0 0 18px; padding: 0; }
      li { margin: 4px 0; }
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="card">
        <div class="eyebrow">GoSenderr Workbench</div>
        <h1>Shared desktop runtime, now exposed as a VS Code coding surface.</h1>
        <p id="summary" class="meta" style="margin-top:8px;">Loading workspace status…</p>
      </section>
      <section class="card">
        <div class="eyebrow">Objective</div>
        <textarea id="objective" placeholder="Describe the bounded coding task you want the engine to work on."></textarea>
        <div class="row" style="margin-top:12px;">
          <button id="submit" class="primary">Submit task</button>
          <button id="continue">Continue</button>
          <button id="retryResearch">Retry with research</button>
          <button id="openPanel">Open wide panel</button>
        </div>
      </section>
      <section class="card">
        <div class="eyebrow">Actions</div>
        <div class="row" style="margin-top:8px;">
          <button id="runNextAction" class="primary">Run next safe action</button>
          <button id="queueNextTask">Queue next task</button>
          <button id="openSourceControl">Open Source Control</button>
          <button id="openGitHistory">Open Git history</button>
          <button id="openTrace">Open trace</button>
          <button id="openFiles">Open files</button>
          <button id="openTaskHub">Open task hub</button>
          <button id="openProblems">Open problems</button>
          <button id="openSandbox">Open sandbox</button>
          <button id="openProviderSettings">Provider settings</button>
        </div>
      </section>
      <section class="grid">
        <div class="card">
          <div class="eyebrow">Chat mode</div>
          <h3 id="chatModeLabel">Ask</h3>
          <p id="chatModeMeta" class="meta" style="margin-top:8px;"></p>
        </div>
        <div class="card">
          <div class="eyebrow">Git</div>
          <h3 id="gitLabel">No git summary yet</h3>
          <p id="gitMeta" class="meta" style="margin-top:8px;"></p>
        </div>
        <div class="card">
          <div class="eyebrow">Runtime</div>
          <h3 id="runtimeLabel">Waiting for workspace</h3>
          <p id="runtimeMeta" class="meta" style="margin-top:8px;"></p>
        </div>
        <div class="card">
          <div class="eyebrow">Review</div>
          <h3 id="reviewLabel">No review yet</h3>
          <p id="reviewMeta" class="meta" style="margin-top:8px;"></p>
        </div>
        <div class="card">
          <div class="eyebrow">Trust</div>
          <h3 id="trustLabel">No trust summary yet</h3>
          <p id="trustMeta" class="meta" style="margin-top:8px;"></p>
        </div>
      </section>
      <section class="grid">
        <div class="card">
          <div class="eyebrow">Objective</div>
          <h3 id="objectiveLabel">No objective bundle yet</h3>
          <p id="objectiveMeta" class="meta" style="margin-top:8px;"></p>
        </div>
        <div class="card">
          <div class="eyebrow">Recovery ladder</div>
          <h3 id="recoveryLabel">No recovery state yet</h3>
          <p id="recoveryMeta" class="meta" style="margin-top:8px;"></p>
        </div>
        <div class="card">
          <div class="eyebrow">Interrupt</div>
          <h3 id="interruptLabel">No interrupt pending</h3>
          <p id="interruptMeta" class="meta" style="margin-top:8px;"></p>
        </div>
        <div class="card">
          <div class="eyebrow">Review bundle</div>
          <h3 id="bundleLabel">No review bundle yet</h3>
          <p id="bundleMeta" class="meta" style="margin-top:8px;"></p>
        </div>
        <div class="card">
          <div class="eyebrow">Next safe action</div>
          <h3 id="nextActionLabel">No engine action chosen yet</h3>
          <p id="nextActionMeta" class="meta" style="margin-top:8px;"></p>
        </div>
        <div class="card">
          <div class="eyebrow">Queued follow-up</div>
          <h3 id="queuedLabel">No queued follow-up yet</h3>
          <p id="queuedMeta" class="meta" style="margin-top:8px;"></p>
        </div>
        <div class="card">
          <div class="eyebrow">Learned guidance</div>
          <h3 id="memoryLabel">No learned guidance yet</h3>
          <p id="memoryMeta" class="meta" style="margin-top:8px;"></p>
        </div>
        <div class="card">
          <div class="eyebrow">Self-host proof</div>
          <h3 id="selfHostLabel">No self-host proof yet</h3>
          <p id="selfHostMeta" class="meta" style="margin-top:8px;"></p>
        </div>
        <div class="card">
          <div class="eyebrow">Self-improvement proof</div>
          <h3 id="selfImproveLabel">No self-improvement proof yet</h3>
          <p id="selfImproveMeta" class="meta" style="margin-top:8px;"></p>
        </div>
      </section>
      <section class="card">
        <div class="eyebrow">Touched files</div>
        <ul id="files"></ul>
      </section>
      <section class="card">
        <div class="eyebrow">Workbench artifacts</div>
        <ul id="artifacts"></ul>
      </section>
      <section class="card">
        <div class="eyebrow">Recommended next actions</div>
        <ul id="actions"></ul>
      </section>
      <section class="card">
        <div class="eyebrow">Log tail</div>
        <pre id="log"></pre>
      </section>
    </div>
    <script>
      const vscode = acquireVsCodeApi();
      const objective = document.getElementById('objective');
      const summary = document.getElementById('summary');
      const runtimeLabel = document.getElementById('runtimeLabel');
      const runtimeMeta = document.getElementById('runtimeMeta');
      const chatModeLabel = document.getElementById('chatModeLabel');
      const chatModeMeta = document.getElementById('chatModeMeta');
      const gitLabel = document.getElementById('gitLabel');
      const gitMeta = document.getElementById('gitMeta');
      const reviewLabel = document.getElementById('reviewLabel');
      const reviewMeta = document.getElementById('reviewMeta');
      const trustLabel = document.getElementById('trustLabel');
      const trustMeta = document.getElementById('trustMeta');
      const objectiveLabel = document.getElementById('objectiveLabel');
      const objectiveMeta = document.getElementById('objectiveMeta');
      const recoveryLabel = document.getElementById('recoveryLabel');
      const recoveryMeta = document.getElementById('recoveryMeta');
      const interruptLabel = document.getElementById('interruptLabel');
      const interruptMeta = document.getElementById('interruptMeta');
      const bundleLabel = document.getElementById('bundleLabel');
      const bundleMeta = document.getElementById('bundleMeta');
      const nextActionLabel = document.getElementById('nextActionLabel');
      const nextActionMeta = document.getElementById('nextActionMeta');
      const queuedLabel = document.getElementById('queuedLabel');
      const queuedMeta = document.getElementById('queuedMeta');
      const memoryLabel = document.getElementById('memoryLabel');
      const memoryMeta = document.getElementById('memoryMeta');
      const selfHostLabel = document.getElementById('selfHostLabel');
      const selfHostMeta = document.getElementById('selfHostMeta');
      const selfImproveLabel = document.getElementById('selfImproveLabel');
      const selfImproveMeta = document.getElementById('selfImproveMeta');
      const files = document.getElementById('files');
      const artifacts = document.getElementById('artifacts');
      const actions = document.getElementById('actions');
      const log = document.getElementById('log');
      const buttons = {
        submit: document.getElementById('submit'),
        continue: document.getElementById('continue'),
        retryResearch: document.getElementById('retryResearch'),
        runNextAction: document.getElementById('runNextAction'),
        queueNextTask: document.getElementById('queueNextTask'),
        openSourceControl: document.getElementById('openSourceControl'),
        openGitHistory: document.getElementById('openGitHistory'),
        openTrace: document.getElementById('openTrace'),
        openFiles: document.getElementById('openFiles'),
        openTaskHub: document.getElementById('openTaskHub'),
        openProblems: document.getElementById('openProblems'),
        openSandbox: document.getElementById('openSandbox'),
        openProviderSettings: document.getElementById('openProviderSettings'),
        openPanel: document.getElementById('openPanel'),
      };

      function setList(target, values, emptyText) {
        target.innerHTML = '';
        const items = Array.isArray(values) ? values : [];
        if (!items.length) {
          const li = document.createElement('li');
          li.textContent = emptyText;
          target.appendChild(li);
          return;
        }
        for (const item of items) {
          const li = document.createElement('li');
          li.textContent = typeof item === 'string' ? item : (item.path || item.summary || JSON.stringify(item));
          target.appendChild(li);
        }
      }

      function renderState(state) {
        const ready = !!state.ready;
        const running = !!state.running;
        const snapshot = state.snapshot || null;
        summary.textContent = state.errorMessage
          ? state.errorMessage
          : (state.statusMessage || (ready
            ? 'Companion is ready to submit bounded tasks through the shared GoSenderr runtime.'
            : 'Open the desktop-agent repo workspace so the companion can find the current runtime.'));
        runtimeLabel.textContent = snapshot
          ? [snapshot.status || 'unknown', snapshot.task || 'Latest task'].filter(Boolean).join(' • ')
          : (running ? 'Run in progress' : 'No run yet');
        runtimeMeta.textContent = snapshot
          ? [snapshot.laneLabel || snapshot.laneId, snapshot.taskMode, snapshot.modelDisplayName || snapshot.modelProfileId, snapshot.baseModel, snapshot.providerSource].filter(Boolean).join(' • ')
          : [state.workspaceRoot || 'No workspace', state.repoRoot || 'No repo root'].filter(Boolean).join(' • ');
        const chatModeView = state.chatModeView || { label: 'Ask', meta: 'Human-style help, explanation, and repo guidance only.' };
        chatModeLabel.textContent = chatModeView.label || 'Ask';
        chatModeMeta.textContent = chatModeView.meta || '';
        const gitSummaryView = state.gitSummaryView || { label: 'No git summary yet', meta: '' };
        gitLabel.textContent = gitSummaryView.label || 'No git summary yet';
        gitMeta.textContent = gitSummaryView.meta || '';
        const reviewBundleView = state.reviewBundleView || { label: 'No review bundle yet', meta: '', decisionLabel: '', summary: '' };
        reviewLabel.textContent = reviewBundleView.decisionLabel || snapshot?.reviewSummary?.summary || 'No review verdict yet';
        reviewMeta.textContent = [reviewBundleView.summary, snapshot?.runSummary?.summary || ''].filter(Boolean).join(' • ');
        trustLabel.textContent = snapshot?.trustSummary?.summary || 'No trust summary yet';
        trustMeta.textContent = snapshot?.testSummary?.summary || '';
        objectiveLabel.textContent = snapshot?.taskObjective?.summary || 'No objective bundle yet';
        objectiveMeta.textContent = [snapshot?.taskObjective?.kind, snapshot?.taskObjective?.source, ...(Array.isArray(snapshot?.taskObjective?.loopSteps) ? [snapshot.taskObjective.loopSteps.join(' → ')] : [])].filter(Boolean).join(' • ');
        recoveryLabel.textContent = snapshot?.recoveryLadder?.state || 'No recovery state yet';
        recoveryMeta.textContent = [snapshot?.recoveryLadder?.currentStep, snapshot?.recoveryLadder?.nextStep ? ('next: ' + snapshot.recoveryLadder.nextStep) : '', snapshot?.failureClass?.summary].filter(Boolean).join(' • ');
        interruptLabel.textContent = snapshot?.interruptRequest?.active ? (snapshot.interruptRequest.summary || snapshot.interruptRequest.kind || 'Interrupt pending') : 'No interrupt pending';
        interruptMeta.textContent = snapshot?.interruptRequest?.active ? [snapshot?.interruptRequest?.requestedAction, ...(Array.isArray(snapshot?.interruptRequest?.allowedActions) ? snapshot.interruptRequest.allowedActions : [])].filter(Boolean).join(' • ') : '';
        bundleLabel.textContent = reviewBundleView.label;
        bundleMeta.textContent = reviewBundleView.meta;
        nextActionLabel.textContent = snapshot?.nextAction?.label || 'No engine action chosen yet';
        nextActionMeta.textContent = [snapshot?.nextAction?.summary, snapshot?.nextAction?.reason ? ('reason: ' + snapshot.nextAction.reason) : '', snapshot?.nextAction?.blocked ? 'review-held' : ''].filter(Boolean).join(' • ');
        const queuedFollowupView = state.queuedFollowupView || { exists: false, label: 'No queued follow-up yet', meta: '', hubPath: '' };
        queuedLabel.textContent = queuedFollowupView.label || 'No queued follow-up yet';
        queuedMeta.textContent = queuedFollowupView.meta || '';
        const memoryHintsView = state.memoryHintsView || { label: 'No learned guidance yet', meta: '' };
        memoryLabel.textContent = memoryHintsView.label || 'No learned guidance yet';
        memoryMeta.textContent = memoryHintsView.meta || '';
        const selfHostProofView = state.selfHostProofView || { label: 'No self-host proof yet', meta: '' };
        selfHostLabel.textContent = selfHostProofView.label || 'No self-host proof yet';
        selfHostMeta.textContent = selfHostProofView.meta || '';
        const selfImprovementProofView = state.selfImprovementProofView || { label: 'No self-improvement proof yet', meta: '' };
        selfImproveLabel.textContent = selfImprovementProofView.label || 'No self-improvement proof yet';
        selfImproveMeta.textContent = selfImprovementProofView.meta || '';
        setList(files, snapshot?.changedFiles || [], 'No changed files captured yet.');
        setList(artifacts, snapshot?.workbenchArtifacts || [], 'No workbench artifacts captured yet.');
        setList(actions, [snapshot?.nextAction?.summary, ...(snapshot?.recommendedActions || [])].filter(Boolean), 'No follow-up actions recorded yet.');
        log.textContent = state.logTail || '';
        if (!objective.value && state.lastObjective) {
          objective.value = state.lastObjective;
        }
        buttons.submit.disabled = !ready || running;
        buttons.continue.disabled = !ready || running || !state.lastObjective;
        buttons.retryResearch.disabled = !ready || running || !state.lastObjective;
        buttons.runNextAction.disabled = !ready || running || !snapshot?.nextAction?.command;
        buttons.runNextAction.textContent = snapshot?.nextAction?.label || 'Run next safe action';
        buttons.queueNextTask.disabled = !ready || running || !(snapshot?.queuedFollowup?.exists || snapshot?.nextAction?.command);
        buttons.openSourceControl.disabled = !state.repoRoot;
        buttons.openGitHistory.disabled = !state.repoRoot;
        buttons.openTrace.disabled = !snapshot;
        buttons.openFiles.disabled = !snapshot || !Array.isArray(snapshot.changedFiles) || snapshot.changedFiles.length === 0;
        buttons.openTaskHub.disabled = !queuedFollowupView.hubPath;
        buttons.openSandbox.disabled = !snapshot || !Array.isArray(snapshot.artifactPaths) || snapshot.artifactPaths.length === 0;
        buttons.openProviderSettings.disabled = !state.repoRoot;
      }

      buttons.submit.addEventListener('click', () => vscode.postMessage({ type: 'submit-task', objective: objective.value }));
      buttons.continue.addEventListener('click', () => vscode.postMessage({ type: 'continue-task' }));
      buttons.retryResearch.addEventListener('click', () => vscode.postMessage({ type: 'retry-with-research' }));
      buttons.runNextAction.addEventListener('click', () => vscode.postMessage({ type: 'run-next-action' }));
      buttons.queueNextTask.addEventListener('click', () => vscode.postMessage({ type: 'queue-next-task' }));
      buttons.openSourceControl.addEventListener('click', () => vscode.postMessage({ type: 'open-source-control' }));
      buttons.openGitHistory.addEventListener('click', () => vscode.postMessage({ type: 'open-git-history' }));
      buttons.openTrace.addEventListener('click', () => vscode.postMessage({ type: 'open-trace' }));
      buttons.openFiles.addEventListener('click', () => vscode.postMessage({ type: 'open-files' }));
      buttons.openTaskHub.addEventListener('click', () => vscode.postMessage({ type: 'open-task-hub' }));
      buttons.openProblems.addEventListener('click', () => vscode.postMessage({ type: 'open-problems' }));
      buttons.openSandbox.addEventListener('click', () => vscode.postMessage({ type: 'open-sandbox' }));
      buttons.openProviderSettings.addEventListener('click', () => vscode.postMessage({ type: 'open-provider-settings' }));
      buttons.openPanel.addEventListener('click', () => vscode.postMessage({ type: 'open-panel' }));

      window.addEventListener('message', (event) => {
        if (event?.data?.type === 'state') {
          renderState(event.data.payload || {});
        }
      });

      vscode.postMessage({ type: 'bootstrap' });
    </script>
  </body>
</html>`;
}

function listWorkbenchSurfaces(controller) {
  return [controller.panel, controller.view].filter((surface) => surface && surface.webview);
}

function postState(controller) {
  const surfaces = listWorkbenchSurfaces(controller);
  if (!surfaces.length) {
    return;
  }
  const payload = buildStatePayload(controller);
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
    const type = String(message?.type || '').trim();
    if (type === 'bootstrap') {
      await refreshControllerContext(controller);
      postState(controller);
      return;
    }
    if (type === 'submit-task') {
      await runObjective(controller, message?.objective || '', { retryWithResearch: false });
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
  };
  return controller.messageHandler;
}

function attachWorkbenchSurface(controller, surface) {
  if (!surface || !surface.webview) {
    return;
  }
  surface.webview.options = {
    ...(surface.webview.options || {}),
    enableScripts: true,
  };
  surface.webview.html = buildWorkbenchHtml();
  if (controller.boundWebviews.has(surface.webview)) {
    return;
  }
  controller.boundWebviews.add(surface.webview);
  surface.webview.onDidReceiveMessage(getWorkbenchMessageHandler(controller));
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

async function runObjective(controller, objective, options = {}) {
  const vscode = getVsCode();
  const text = String(objective || '').trim();
  if (!text) {
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

  const runtimeBridge = loadRuntimeBridge(controller.repoRoot, controller.workspaceRoot);
  const actualObjective = options.retryWithResearch ? buildResearchObjective(text) : text;
  const request = buildOrchestrateRequest(actualObjective, controller.workspaceRoot, options);
  controller.lastObjective = text;
  controller.lastRequest = request;
  controller.lastResult = null;
  controller.lastSnapshot = null;
  controller.lastQueuedFollowup = null;
  controller.logTail = '';
  controller.errorMessage = '';
  controller.statusMessage = `Running ${options.retryWithResearch ? 'a research-first retry' : 'the shared dev-engine loop'} from VS Code…`;
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
  controller.lastSnapshot = snapshot;
  controller.statusMessage = finished?.exitCode === 0
    ? 'GoSenderr completed the latest VS Code workbench run.'
    : 'GoSenderr finished with a failing or blocked result. Open the trace and follow the recorded next action.';
  controller.errorMessage = finished?.exitCode === 0 ? '' : clipText(rawResult.message || rawResult.summary || rawResult.error || '');
  controller.logTail = `${controller.logTail}\n${String(finished?.stdout || '')}\n${String(finished?.stderr || '')}`.trim().slice(-120000);
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
    lastObjective: '',
    lastRequest: null,
    lastResult: null,
    lastSnapshot: null,
    lastQueuedFollowup: null,
    currentOperation: null,
    boundWebviews: new WeakSet(),
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
      'GoSenderr Workbench',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    attachWorkbenchSurface(controller, controller.panel);
    controller.panel.onDidDispose(() => {
      controller.panel = null;
    });
  }

  await refreshControllerContext(controller);
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
    await vscode.window.showInformationMessage('Running a repair-oriented retry through the shared GoSenderr loop.');
    await runObjective(controller, buildRepairObjective(controller.lastObjective), { retryWithResearch: false });
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
      attachWorkbenchSurface(controller, webviewView);
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
            postState(controller);
          }
        }));
      }
      context.subscriptions.push(...disposables);
      void refreshControllerContext(controller).then(() => {
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
    vscode.commands.registerCommand('gosenderr.submitTask', async () => {
      await submitTaskFromInput(context);
    }),
    vscode.commands.registerCommand('gosenderr.continueTask', async () => {
      await continueLastTask(context, false);
    }),
    vscode.commands.registerCommand('gosenderr.retryWithResearch', async () => {
      await continueLastTask(context, true);
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
  buildSelfHostProofViewModel,
  buildSelfImprovementProofViewModel,
  buildReviewBundleViewModel,
  buildQueuedFollowupViewModel,
  buildChatModeViewModel,
  collectWorkspaceFileCandidates,
  queueNextTaskLoopFollowupInWorkspace,
  resolveNextActionCommand,
  resolveCompanionRepoRoot,
  resolveTaskHubDocumentPath,
  WORKBENCH_VIEW_CONTAINER_ID,
  WORKBENCH_VIEW_ID,
};
