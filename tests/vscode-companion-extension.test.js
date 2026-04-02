'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildOrchestrateRequest,
  buildMemoryHintsViewModel,
  buildEngineModelProofViewModel,
  buildSelfHostProofViewModel,
  buildSelfImprovementProofViewModel,
  buildQueuedFollowupViewModel,
  buildChatModeViewModel,
  buildGroundedReplyViewModel,
  buildWorkbenchHtml,
  buildStatePayload,
  buildRepairObjective,
  buildReviewBundleViewModel,
  buildTaskObjective,
  buildResearchObjective,
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
} = require('../integration-library/extensions/vscode-companion/extension.js');
const extensionSource = fs.readFileSync(
  path.join(__dirname, '..', 'integration-library', 'extensions', 'vscode-companion', 'extension.js'),
  'utf8',
);
const extensionTsSource = fs.readFileSync(
  path.join(__dirname, '..', 'integration-library', 'extensions', 'vscode-companion', 'src', 'extension.ts'),
  'utf8',
);

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-vscode-companion-'));
  fs.mkdirSync(path.join(root, 'shared-runtime'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runtime', 'backend', 'agent', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'main.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(root, 'shared-runtime', 'agent-runtime-client.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(root, 'runtime', 'backend', 'agent', 'runtime', 'runtime_api.py'), '# runtime\n');
  return root;
}

function writeRepoFile(root, relativePath, content) {
  const targetPath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content);
}

test('resolveCompanionRepoRoot finds the live desktop-agent repo from workspace roots', () => {
  const repoRoot = makeRepo();
  const resolved = resolveCompanionRepoRoot({
    workspaceRoots: [repoRoot],
    extensionRoot: path.join(repoRoot, 'integration-library', 'extensions', 'vscode-companion'),
  });

  assert.equal(resolved, repoRoot);
});

test('package contributes the GoSenderr activity-bar container and sidebar workbench view', () => {
  const packagePath = path.join(
    __dirname,
    '..',
    'integration-library',
    'extensions',
    'vscode-companion',
    'package.json',
  );
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const activitybar = Array.isArray(pkg?.contributes?.viewsContainers?.activitybar)
    ? pkg.contributes.viewsContainers.activitybar
    : [];
  const workbenchContainer = activitybar.find((entry) => entry.id === WORKBENCH_VIEW_CONTAINER_ID);
  const views = Array.isArray(pkg?.contributes?.views?.[WORKBENCH_VIEW_CONTAINER_ID])
    ? pkg.contributes.views[WORKBENCH_VIEW_CONTAINER_ID]
    : [];
  const workbenchView = views.find((entry) => entry.id === WORKBENCH_VIEW_ID);
  const openCompanion = pkg.contributes.commands.find((entry) => entry.command === 'gosenderr.openDesktopAgent');

  assert.equal(pkg.version, '0.1.3');
  assert.equal(pkg.publisher, 'gosenderr');
  assert.equal(Object.hasOwn(pkg, 'activationEvents'), false);
  assert.deepEqual(pkg.files, ['extension.js', 'src', 'resources', 'README.md', 'integration.json', 'package.json']);
  assert.equal(workbenchContainer?.title, 'GoSenderr');
  assert.equal(workbenchContainer?.icon, 'resources/activitybar-icon.svg');
  assert.equal(workbenchView?.type, 'webview');
  assert.equal(workbenchView?.name, 'CHAT');
  assert.equal(openCompanion?.title, 'GoSenderr: Open Companion');
  assert.ok(pkg.contributes.commands.some((entry) => entry.command === 'gosenderr.openWorkbenchPanel'));
  assert.ok(pkg.contributes.commands.some((entry) => entry.command === 'gosenderr.openSourceControl'));
  assert.ok(pkg.contributes.commands.some((entry) => entry.command === 'gosenderr.openGitHistory'));
  assert.ok(pkg.contributes.commands.some((entry) => entry.command === 'gosenderr.repairLoop'));
  assert.ok(pkg.contributes.commands.some((entry) => entry.command === 'gosenderr.selfImprove'));
  assert.ok(pkg.contributes.commands.some((entry) => entry.command === 'gosenderr.autopilot'));
  assert.ok(pkg.contributes.commands.some((entry) => entry.command === 'gosenderr.reviewApprove'));
  assert.ok(pkg.contributes.commands.some((entry) => entry.command === 'gosenderr.reviewReject'));
});

test('integration metadata stays aligned with the live companion install strategy', () => {
  const integrationPath = path.join(
    __dirname,
    '..',
    'integration-library',
    'extensions',
    'vscode-companion',
    'integration.json',
  );
  const metadata = JSON.parse(fs.readFileSync(integrationPath, 'utf8'));

  assert.equal(metadata.version, '0.1.3');
  assert.equal(metadata.installMode, 'copy');
  assert.match(metadata.summary, /Workspace-copied GoSenderr companion/i);
  assert.ok(metadata.contributes.includes('workbench-view'));
  assert.ok(metadata.contributes.includes('bounded-safe-actions'));
});

test('typescript entry delegates to the live companion runtime instead of keeping a stub path', () => {
  assert.match(extensionTsSource, /require\('\.\.\/extension\.js'\)/);
  assert.match(extensionTsSource, /return runtime\.activate\(context\)/);
  assert.match(extensionTsSource, /return runtime\.deactivate\?\.\(\)/);
  assert.doesNotMatch(extensionTsSource, /showInformationMessage/);
});

test('buildCompanionCliCommand keeps companion self-improve on the shared engine CLI path', () => {
  const repoRoot = path.join(__dirname, '..');
  const command = buildCompanionCliCommand(repoRoot, 'self-improve', {
    workspaceRoot: 'E:\\dev\\projects\\gosenderr-desktop-agent-PC',
  });
  const proofCommand = buildCompanionCliCommand(repoRoot, 'proof-summary', {
    workspaceRoot: 'E:\\dev\\projects\\gosenderr-desktop-agent-PC',
    title: 'VS Code companion self-improve pass',
    trailing: ['Run a bounded supervised self-improvement pass from the VS Code companion and refresh the shared proof artifact.'],
  });

  assert.match(command, /scripts[\\/]engine-cli\.js/);
  assert.match(command, /self-improve/);
  assert.match(command, /--workspace/);
  assert.match(proofCommand, /proof-summary/);
  assert.match(proofCommand, /VS Code companion self-improve pass/);
});

test('buildCompanionCliCommand keeps companion autopilot on the shared engine CLI path', () => {
  const repoRoot = path.join(__dirname, '..');
  const command = buildCompanionCliCommand(repoRoot, 'autopilot', {
    workspaceRoot: 'E:\\dev\\projects\\gosenderr-desktop-agent-PC',
  });
  const proofCommand = buildCompanionCliCommand(repoRoot, 'proof-summary', {
    workspaceRoot: 'E:\\dev\\projects\\gosenderr-desktop-agent-PC',
    title: 'VS Code companion autopilot pass',
    trailing: ['Run one bounded supervised autopilot pass from the VS Code companion and refresh the shared proof artifact.'],
  });

  assert.match(command, /scripts[\\/]engine-cli\.js/);
  assert.match(command, /autopilot/);
  assert.match(command, /--workspace/);
  assert.match(proofCommand, /proof-summary/);
  assert.match(proofCommand, /VS Code companion autopilot pass/);
});

test('buildOrchestrateRequest uses the current orchestrate action and workspace root', () => {
  const request = buildOrchestrateRequest(
    'Repair the failing validation path.',
    'E:\\dev\\projects\\gosenderr-desktop-agent-PC',
    {
      retryWithResearch: true,
      taskFocus: 'Repair the failing validation path.',
      chatMode: 'plan',
      effectiveChatMode: 'plan',
      suggestedLaneId: 'plan-reasoning',
      suggestedTaskMode: 'planner',
    },
  );

  assert.equal(request.action, 'orchestrate');
  assert.equal(request.objective, 'Repair the failing validation path.');
  assert.equal(request.targetWorkspaceRoot, 'E:\\dev\\projects\\gosenderr-desktop-agent-PC');
  assert.equal(request.chatMode, 'plan');
  assert.equal(request.effectiveChatMode, 'plan');
  assert.equal(request.suggestedLaneId, 'plan-reasoning');
  assert.equal(request.suggestedTaskMode, 'planner');
  assert.equal(request.metadata.surface, 'vscode-companion');
  assert.equal(request.metadata.retry_with_research, true);
  assert.equal(request.metadata.chatMode, 'plan');
  assert.equal(request.metadata.taskFocus, 'Repair the failing validation path.');
  assert.equal(request.taskObjective.kind, 'research-retry');
  assert.equal(request.taskObjective.chatMode, 'plan');
  assert.equal(request.taskObjective.taskFocus, 'Repair the failing validation path.');
  assert.equal(request.metadata.taskObjective.source, 'vscode-companion');
});

test('buildResearchObjective makes the retry path explicit', () => {
  const objective = buildResearchObjective('Repair the failing validation path.');
  assert.match(objective, /Research the repo state/i);
  assert.match(objective, /Repair the failing validation path\./i);
});

test('buildTaskObjective keeps the shared dev-engine loop visible for the companion', () => {
  const payload = buildTaskObjective('Repair the failing validation path.', {
    retryWithResearch: false,
    taskFocus: 'Repair the failing validation path.',
    chatMode: 'edit',
    effectiveChatMode: 'edit',
    suggestedLaneId: 'code-main',
    suggestedTaskMode: 'coder',
  });
  assert.equal(payload.kind, 'coding-task');
  assert.equal(payload.source, 'vscode-companion');
  assert.equal(payload.chatMode, 'edit');
  assert.equal(payload.effectiveChatMode, 'edit');
  assert.equal(payload.taskFocus, 'Repair the failing validation path.');
  assert.equal(payload.suggestedLaneId, 'code-main');
  assert.deepEqual(payload.loopSteps.slice(0, 4), ['goal', 'observe', 'research', 'propose']);
});

test('buildRepairObjective makes the repair retry explicit for the companion', () => {
  const objective = buildRepairObjective('Repair the failing validation path.');
  assert.match(objective, /Repair the latest failed run for:/);
  assert.match(objective, /Repair the failing validation path\./);
});

test('resolveNextActionCommand reads the shared next action contract', () => {
  assert.equal(resolveNextActionCommand({ nextAction: { command: 'retry-with-research' } }), 'retry-with-research');
  assert.equal(resolveNextActionCommand({}), '');
});

test('buildReviewBundleViewModel exposes one readable verdict, reason, and fix summary', () => {
  const view = buildReviewBundleViewModel({
    reviewBundle: {
      decisionLabel: 'Repair required',
      summary: 'Reviewer found a failed validation path.',
      reason: 'Validation failed in renderer/app.js.',
      howToFix: 'Repair the failing validation path and rerun the smallest relevant check.',
      changeSummary: '2 changed file(s), starting with renderer/app.js',
      approvalState: 'held',
      requestCount: 2,
      fixActions: ['review-findings', 'open-trace'],
      reviewRequests: [{ title: 'Inspect changed files before approval.' }],
      trustSummary: { trust_state: 'needs_review' },
      pendingCount: 1,
    },
  });

  assert.equal(view.label, 'Repair required');
  assert.match(view.meta, /reason: Validation failed in renderer\/app\.js\./);
  assert.match(view.meta, /fix: Repair the failing validation path/);
  assert.match(view.meta, /changes: 2 changed file/);
  assert.match(view.meta, /approval: held/);
  assert.match(view.meta, /action: review-findings/);
  assert.match(view.meta, /2 requests/);
  assert.match(view.meta, /request: Inspect changed files before approval\./);
  assert.match(view.meta, /trust: needs_review/);
});

test('buildQueuedFollowupViewModel exposes one readable queued-task summary', () => {
  const view = buildQueuedFollowupViewModel({
    ok: true,
    createdCount: 2,
    recipe: {
      title: 'Engine follow-up: Retry with research',
      summary: 'Research the repo and retry the bounded patch.',
      autoQueueEligible: true,
      stepCount: 2,
    },
    hubPath: 'E:\\temp\\task-hub.json',
  });

  assert.equal(view.exists, true);
  assert.equal(view.label, 'Engine follow-up: Retry with research');
  assert.match(view.meta, /2 queued step/);
  assert.match(view.meta, /queueable/);
  assert.match(view.meta, /task-hub\.json/);
});

test('buildMemoryHintsViewModel exposes one readable learned-guidance summary', () => {
  const view = buildMemoryHintsViewModel({
    summary: '2 reject pattern(s) recorded. Most common: Validation failed in renderer/app.js. Preferred response: repair-loop.',
    topRejectReason: 'Validation failed in renderer/app.js.',
    topFixPattern: 'Repair renderer/app.js and rerun the UI shell test.',
    recommendedResponse: 'repair-loop',
    phaseSummary: 'Phase 1: Safe Engine Core is showing the strongest reusable guidance right now.',
    topPaths: [{ value: 'renderer/app.js', count: 2 }],
  });

  assert.match(view.label, /reject pattern/i);
  assert.match(view.meta, /reject: Validation failed in renderer\/app\.js\./);
  assert.match(view.meta, /fix: Repair renderer\/app\.js/);
  assert.match(view.meta, /response: repair-loop/);
  assert.match(view.meta, /phase: Phase 1: Safe Engine Core/i);
  assert.match(view.meta, /path: renderer\/app\.js/i);
});

test('buildSelfHostProofViewModel exposes one readable self-host proof summary', () => {
  const view = buildSelfHostProofViewModel({
    label: 'PROVEN',
    capabilityLabel: 'VERIFIED',
    summary: 'Self-host proof passed (3/3), including smoke.',
    nextAction: 'Keep the next self-host slice bounded and rerun the same proof after meaningful self-work.',
  });

  assert.equal(view.label, 'VERIFIED');
  assert.match(view.meta, /next: Keep the next self-host slice bounded/i);
});

test('buildSelfImprovementProofViewModel exposes one readable supervised self-improvement summary', () => {
  const view = buildSelfImprovementProofViewModel({
    label: 'PROVEN',
    summary: 'Supervised self-improvement is proven with 1 safe run recorded.',
    nextAction: 'Open at most one more bounded self-improvement task and keep it supervised.',
  });

  assert.equal(view.label, 'PROVEN');
  assert.match(view.meta, /next: Open at most one more bounded self-improvement task/i);
});

test('buildEngineModelProofViewModel exposes one readable engine-model proof summary', () => {
  const view = buildEngineModelProofViewModel({
    label: 'PARTIAL',
    capabilityLabel: 'CANDIDATE-ONLY',
    summary: 'Python runtime and routed CLI model proof are visible, but smoke proof is still missing.',
    meta: 'python: python.exe • acceptance: PASS • smoke: NOT RUN • prompts: 1 reusable prompt via engine-cli',
    routeSummary: 'Ask GSE-1 Engine • Repair GS-Dev-1 Default',
    nextAction: 'Run acceptance with smoke coverage before widening.',
  });

  assert.equal(view.label, 'CANDIDATE-ONLY');
  assert.match(view.meta, /python: python\.exe/i);
  assert.match(view.meta, /prompts: 1 reusable prompt via engine-cli/i);
  assert.match(view.meta, /routes: Ask GSE-1 Engine/i);
  assert.match(view.meta, /next: Run acceptance with smoke coverage/i);
});

test('buildStatePayload keeps companion engine parity and review state in one payload', () => {
  const repoRoot = makeRepo();
  writeRepoFile(repoRoot, 'host/assistant-config.js', `
module.exports = {
  readAssistantConfig() {
    return {};
  },
};
`);
  writeRepoFile(repoRoot, 'core/engine-contract.js', `
module.exports = {
  resolveChatModeValue(value) {
    return String(value || 'auto').trim().toLowerCase() || 'auto';
  },
  getChatModeConfig(mode) {
    return { label: String(mode || 'auto'), meta: 'mode meta' };
  },
  resolveModelProfileSelection() {
    return {
      active: {
        modelDisplayName: 'GS-Dev-1 Default',
        providerSource: 'ollama',
        baseModel: 'qwen2.5-coder:7b',
      },
      modelRole: 'workspace',
    };
  },
};
`);
  writeRepoFile(repoRoot, 'core/engine-model-proof.js', `
module.exports = {
  buildEngineModelProofSnapshot() {
    return {};
  },
  buildEngineModelProofViewModel() {
    return {
      capabilityState: 'candidate',
      capabilityLabel: 'CANDIDATE-ONLY',
      label: 'PARTIAL',
      summary: 'Engine proof is partial.',
      meta: 'proof meta',
      nextAction: 'Record smoke proof.',
      routeSummary: 'Ask GSE-1 Engine',
    };
  },
};
`);
  writeRepoFile(repoRoot, 'core/capability-status.js', `
module.exports = {
  buildCapabilityDescriptor(input = {}) {
    const label = String(input.label || '').trim().toUpperCase();
    if (label === 'PROVEN') {
      return { capabilityState: 'verified', capabilityLabel: 'VERIFIED' };
    }
    if (label === 'PARTIAL') {
      return { capabilityState: 'candidate', capabilityLabel: 'CANDIDATE-ONLY' };
    }
    if (label === 'BLOCKED') {
      return { capabilityState: 'blocked', capabilityLabel: 'BLOCKED' };
    }
    return { capabilityState: 'missing', capabilityLabel: 'MISSING' };
  },
};
`);
  writeRepoFile(repoRoot, 'core/engine-acceptance.js', `
module.exports = {
  readLatestAcceptanceReport() {
    return {
      exists: true,
      report: {
        checks: [
          { id: 'self-host-bootstrap', status: 'pass' },
          { id: 'self-host-tests', status: 'pass' },
          { id: 'self-host-smoke', status: 'pass' },
        ],
      },
    };
  },
};
`);
  writeRepoFile(repoRoot, 'core/system-check.js', `
module.exports = {
  buildSelfImprovementSummary() {
    return {
      proof: {
        capabilityState: 'verified',
        capabilityLabel: 'VERIFIED',
        label: 'PROVEN',
        summary: 'Supervised self-improvement is proven.',
        nextAction: 'Keep it bounded.',
      },
    };
  },
};
`);
  writeRepoFile(repoRoot, 'core/learning-journal.js', `
module.exports = {
  readLearningMemoryHints() {
    return {
      summary: '1 reject pattern recorded.',
      topRejectReason: 'Validation failed.',
    };
  },
};
`);

  const payload = buildStatePayload({
    repoRoot,
    workspaceRoot: repoRoot,
    chatMode: 'agent',
    running: false,
    statusMessage: 'Ready',
    errorMessage: '',
    lastObjective: 'Repair the current drift.',
    threadEntries: [],
    lastSnapshot: {
      task: 'Repair the current drift.',
      laneId: 'code-main',
      taskMode: 'coder',
      changedFileCount: 1,
      changedFiles: [{ path: path.join(repoRoot, 'renderer', 'app.js') }],
      reviewBundle: {
        decisionLabel: 'Repair required',
        summary: 'Reviewer found a failed validation path.',
        reason: 'Validation failed in renderer/app.js.',
        howToFix: 'Repair the failing validation path and rerun the smallest relevant check.',
        changeSummary: '1 changed file, starting with renderer/app.js',
      },
      reviewSummary: {
        summary: 'Repair required before handoff.',
      },
      effectiveChatMode: 'agent',
    },
  });

  assert.equal(payload.ready, true);
  assert.equal(payload.engineModelProofView.label, 'CANDIDATE-ONLY');
  assert.equal(payload.selfHostProofView.label, 'VERIFIED');
  assert.equal(payload.selfImprovementProofView.label, 'VERIFIED');
  assert.equal(payload.reviewBundleView.label, 'Repair required');
  assert.equal(payload.snapshot.reviewSummary.summary, 'Repair required before handoff.');
  assert.match(payload.currentModelView.label, /GS-Dev-1 Default/);
});

test('openTraceDocument opens a JSON trace payload for the current companion run', async () => {
  const opened = [];
  const shown = [];
  setVsCodeModuleForTests({
    workspace: {
      async openTextDocument(value) {
        opened.push(value);
        return { uri: 'trace-doc', value };
      },
    },
    window: {
      async showTextDocument(document, options) {
        shown.push({ document, options });
      },
      async showInformationMessage() {},
    },
  });

  try {
    await openTraceDocument({
      lastObjective: 'Repair the current drift.',
      lastSnapshot: { task: 'Repair the current drift.', status: 'blocked' },
      lastResult: { summary: 'Run failed.' },
    });
  } finally {
    setVsCodeModuleForTests(null);
  }

  assert.equal(opened.length, 1);
  assert.equal(opened[0].language, 'json');
  const trace = JSON.parse(opened[0].content);
  assert.equal(trace.objective, 'Repair the current drift.');
  assert.equal(trace.snapshot.status, 'blocked');
  assert.equal(trace.result.summary, 'Run failed.');
  assert.equal(shown[0].options.preview, false);
});

test('updateCompanionReviewDecision writes the shared review decision and updates changed files', async () => {
  const repoRoot = makeRepo();
  writeRepoFile(repoRoot, 'core/review-approval-state.js', `
module.exports = {
  applyDecision(decisions, target, status) {
    return {
      decisions: [...decisions, { path: target.path, status }],
    };
  },
};
`);
  writeRepoFile(repoRoot, 'core/review-decision-store.js', `
let lastWrite = [];

module.exports = {
  readStoredReviewDecisions() {
    return { decisions: lastWrite };
  },
  writeStoredReviewDecisions(_workspaceRoot, decisions) {
    lastWrite = decisions;
  },
  getLastWrite() {
    return lastWrite;
  },
};
`);

  const infoMessages = [];
  setVsCodeModuleForTests({
    window: {
      async showWarningMessage() {},
      async showInformationMessage(message) {
        infoMessages.push(message);
      },
      async showQuickPick() {
        return null;
      },
    },
  });

  const controller = {
    repoRoot,
    workspaceRoot: repoRoot,
    lastSnapshot: {
      changedFiles: [{ path: path.join(repoRoot, 'renderer', 'app.js') }],
    },
    statusMessage: '',
    errorMessage: 'stale error',
  };

  try {
    await updateCompanionReviewDecision(controller, 'approved');
  } finally {
    setVsCodeModuleForTests(null);
  }

  const reviewStore = require(path.join(repoRoot, 'core', 'review-decision-store.js'));
  assert.deepEqual(reviewStore.getLastWrite(), [{ path: 'renderer/app.js', status: 'approved' }]);
  assert.equal(controller.lastSnapshot.changedFiles[0].decision, 'approved');
  assert.equal(controller.errorMessage, '');
  assert.match(controller.statusMessage, /renderer\/app\.js/);
  assert.match(infoMessages[0], /approved/);
});

test('buildChatModeViewModel maps the shared runtime lane into a readable companion mode summary', () => {
  const autoView = buildChatModeViewModel({
    chatMode: 'auto',
    effectiveChatMode: 'plan',
    laneId: 'plan-reasoning',
    taskMode: 'plan-reasoning',
  });
  const planView = buildChatModeViewModel({
    laneId: 'plan-reasoning',
    taskMode: 'plan-reasoning',
  });
  const editView = buildChatModeViewModel({
    laneId: 'code-main',
    taskMode: 'code-main',
  });

  assert.equal(autoView.mode, 'auto');
  assert.equal(autoView.effectiveMode, 'plan');
  assert.match(autoView.meta, /effective: plan/i);
  assert.equal(planView.mode, 'plan');
  assert.match(planView.meta, /Scoped planning/i);
  assert.equal(editView.mode, 'edit');
  assert.match(editView.meta, /confirmation before execution/i);
});

test('buildGroundedReplyViewModel reuses the shared grounded Ask and Plan path', () => {
  const repoRoot = path.join(__dirname, '..');
  const view = buildGroundedReplyViewModel({
    repoRoot,
    workspaceRoot: repoRoot,
    lastObjective: 'Plan the safest next slice for the routing drift.',
  }, {
    task: 'Plan the safest next slice for the routing drift.',
  }, {
    mode: 'plan',
  });

  assert.equal(view.label, 'Grounded plan');
  assert.match(view.reply, /safest next slice/i);
});

test('buildWorkbenchHtml makes the sidebar a chat-first surface', () => {
  const html = buildWorkbenchHtml(WORKBENCH_SURFACE_SIDEBAR);

  assert.match(html, /<div class="surface-label">CHAT<\/div>/);
  assert.match(html, /<script id="initialState" type="application\/json">\{\}<\/script>/);
  assert.match(html, /<div id="threadTitle" class="thread-title">START A BOUNDED CODING TASK<\/div>/);
  assert.match(html, /<div id="taskFocusBadge" class="thread-focus" hidden>/);
  assert.match(html, /<section class="transcript" id="transcript"><\/section>/);
  assert.match(html, /Describe what to build/);
  assert.match(html, /<div id="actionPopover" class="action-popover" hidden>/);
  assert.match(html, /<button id="clearTaskFocus" class="action-button">New task<\/button>/);
  assert.match(html, /<button id="selfImprove" class="action-button">Self improve<\/button>/);
  assert.match(html, /<button id="toggleActions" class="icon-button">\+<\/button>/);
  assert.match(html, /<button id="modePill" class="composer-pill buttonish"/);
  assert.match(html, /<span id="modePillLabel" class="composer-pill-label">Agent<\/span>/);
  assert.match(html, /<button id="modelPill" class="composer-pill buttonish"/);
  assert.match(html, /<span id="modelPillLabel" class="composer-pill-label">Loading model<\/span>/);
  assert.match(html, /<button id="submit" class="send-button">&gt;<\/button>/);
  assert.match(html, /<button id="openPanel" class="icon-button subtle">\[\]<\/button>/);
  assert.doesNotMatch(html, /<summary>Recent run<\/summary>/);
});

test('buildWorkbenchHtml keeps the wide panel chat-first with a collapsed recent-run drawer', () => {
  const html = buildWorkbenchHtml(WORKBENCH_SURFACE_PANEL);

  assert.match(html, /<div class="surface-label">CHAT<\/div>/);
  assert.match(html, /<section id="activityRail" class="activity-card" hidden>/);
  assert.match(html, /<section id="panelRail" class="panel-rail" hidden>/);
  assert.match(html, /Engine model proof/);
  assert.match(html, /Latest log/);
  assert.match(html, /Research retry/);
  assert.match(html, /Self improve/);
  assert.match(html, /Autopilot/);
  assert.match(html, /Task hub/);
  assert.match(html, /History/);
  assert.doesNotMatch(html, /<button id="openPanel"/);
});

test('companion source keeps the command plumbing while the UI stays chat-first', () => {
  assert.match(extensionSource, /Describe what to build/);
  assert.match(extensionSource, /Add a follow-up for the current task or use \/new/);
  assert.match(extensionSource, /const COMPANION_CHAT_MODE_KEY = 'gosenderr\.companion\.chatMode'/);
  assert.match(extensionSource, /function clearCompanionTaskFocus/);
  assert.match(extensionSource, /function buildCompanionCliCommand/);
  assert.match(extensionSource, /function runSelfImproveInBackground/);
  assert.match(extensionSource, /function runAutopilotInBackground/);
  assert.match(extensionSource, /function runCompanionSlashCommand/);
  assert.match(extensionSource, /groundedReplyCacheKey/);
  assert.match(extensionSource, /groundedReplyCacheValue/);
  assert.match(extensionSource, /modeSelect\.addEventListener\('change'/);
  assert.match(extensionSource, /postMessage\('set-chat-mode'/);
  assert.match(extensionSource, /function renderTranscript/);
  assert.match(extensionSource, /function renderActivity/);
  assert.match(extensionSource, /taskFocusBadge/);
  assert.match(extensionSource, /buttons\.toggleActions\.addEventListener\('click'/);
  assert.match(extensionSource, /buttons\.modePill\.addEventListener\('click'/);
  assert.match(extensionSource, /buttons\.modelPill\.addEventListener\('click', \(\) => postMessage\('open-provider-settings'\)\)/);
  assert.match(extensionSource, /function buildCompanionModelView/);
  assert.match(extensionSource, /bindButton\(buttons\.clearTaskFocus, 'clear-task-focus'\)/);
  assert.match(extensionSource, /bindButton\(buttons\.repairLoop, 'repair-loop'/);
  assert.match(extensionSource, /bindButton\(buttons\.selfImprove, 'self-improve'/);
  assert.match(extensionSource, /bindButton\(buttons\.autopilot, 'autopilot'/);
  assert.match(extensionSource, /bindButton\(buttons\.retryResearch, 'retry-with-research'/);
  assert.match(extensionSource, /bindButton\(buttons\.runNextAction, 'run-next-action'/);
  assert.match(extensionSource, /bindButton\(buttons\.queueNextTask, 'queue-next-task'/);
  assert.match(extensionSource, /bindButton\(buttons\.openTaskHub, 'open-task-hub'/);
  assert.match(extensionSource, /bindButton\(buttons\.openProblems, 'open-problems'/);
  assert.match(extensionSource, /bindButton\(buttons\.openProviderSettings, 'open-provider-settings'/);
  assert.match(extensionSource, /bindButton\(buttons\.openSourceControl, 'open-source-control'/);
  assert.match(extensionSource, /bindButton\(buttons\.openGitHistory, 'open-git-history'/);
  assert.match(extensionSource, /if \(type === 'clear-task-focus'\)/);
  assert.match(extensionSource, /if \(type === 'repair-loop'\)/);
  assert.match(extensionSource, /if \(type === 'self-improve'\)/);
  assert.match(extensionSource, /if \(type === 'autopilot'\)/);
  assert.match(extensionSource, /if \(type === 'review-approve'\)/);
  assert.match(extensionSource, /if \(type === 'review-reject'\)/);
  assert.match(extensionSource, /function buildCurrentWorkbenchPayload/);
  assert.match(extensionSource, /function buildFallbackStatePayload/);
  assert.match(extensionSource, /function setCompanionStartupError/);
  assert.match(extensionSource, /boundSurfaceKinds: new WeakMap\(\)/);
  assert.match(extensionSource, /if \(controller\.boundWebviews\.has\(surface\.webview\) && controller\.boundSurfaceKinds\.get\(surface\.webview\) === surfaceKind\) \{/);
  assert.match(extensionSource, /function buildCurrentWorkbenchPayload\(controller\) \{\s*try \{\s*return buildStatePayload\(controller\);\s*\} catch \(error\) \{\s*return buildFallbackStatePayload\(controller, error\);\s*\}\s*\}/s);
  assert.match(extensionSource, /setCompanionStartupError\(controller, error, 'Companion request handling failed\.'\);/);
  assert.match(extensionSource, /refreshControllerContext\(controller\)\.then\(\(\) => \{\s*attachWorkbenchSurface\(controller, webviewView, WORKBENCH_SURFACE_SIDEBAR\);\s*postState\(controller\);\s*\}\)\.catch\(\(error\) => \{\s*setCompanionStartupError\(controller, error\);\s*attachWorkbenchSurface\(controller, webviewView, WORKBENCH_SURFACE_SIDEBAR\);\s*postState\(controller\);\s*\}\);/s);
  assert.match(extensionSource, /const initialStateNode = document\.getElementById\('initialState'\);/);
  assert.match(extensionSource, /renderState\(initialState\);/);
  assert.match(extensionSource, /buildWorkbenchHtml\(surfaceKind, \{ initialPayload: buildCurrentWorkbenchPayload\(controller\) \}\)/);
  assert.match(extensionSource, /setTimeout\(\(\) => \{\s*vscode\.postMessage\(\{ type: 'bootstrap' \}\);\s*\}, 0\);/s);
  assert.match(extensionSource, /surface\.webview\.onDidReceiveMessage\(getWorkbenchMessageHandler\(controller\)\);[\s\S]*surface\.webview\.html = buildWorkbenchHtml\(surfaceKind, \{ initialPayload: buildCurrentWorkbenchPayload\(controller\) \}\);/);
  assert.match(extensionSource, /gosenderr\.repairLoop/);
  assert.match(extensionSource, /gosenderr\.selfImprove/);
  assert.match(extensionSource, /gosenderr\.autopilot/);
  assert.match(extensionSource, /gosenderr\.reviewApprove/);
  assert.match(extensionSource, /gosenderr\.reviewReject/);
  assert.match(extensionSource, /gosenderr\.openWorkbenchPanel/);
  assert.match(extensionSource, /function runRepairLoopFromCompanion/);
  assert.match(extensionSource, /terminal\.sendText\(buildCompanionCliCommand\(controller\.repoRoot, 'self-improve'/);
  assert.match(extensionSource, /terminal\.sendText\(buildCompanionCliCommand\(controller\.repoRoot, 'autopilot'/);
  assert.match(extensionSource, /terminal\.sendText\(buildCompanionCliCommand\(controller\.repoRoot, 'proof-summary'/);
  assert.match(extensionSource, /function updateCompanionReviewDecision/);
  assert.match(extensionSource, /bindButton\(buttons\.openPanel, 'open-panel'/);
});

test('queueNextTaskLoopFollowupInWorkspace uses the shared task-hub queue path', () => {
  const repoRoot = path.join(__dirname, '..');
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-vscode-followup-workspace-'));
  const result = queueNextTaskLoopFollowupInWorkspace({
    repoRoot,
    workspaceRoot,
    snapshot: {
      task: 'Repair the failing validation path',
      taskObjective: {
        summary: 'Repair the failing validation path',
      },
      changedFiles: [{ path: 'renderer/app.js' }],
      nextAction: {
        command: 'retry-with-research',
        label: 'Retry with research',
        summary: 'Research the repo and retry the bounded patch.',
        prompt: 'Research the repo state and retry the failing validation path.',
        blocked: false,
      },
      queuedFollowup: {
        exists: true,
        recipe: {
          id: 'safe-recipe:test-retry-with-research',
          title: 'Engine follow-up: Retry with research',
          summary: 'Research the repo and retry the bounded patch.',
          prompt: 'Research the repo state and retry the failing validation path.',
          autoQueueEligible: true,
          steps: [
            {
              id: 'engine-next-action-retry-with-research',
              kind: 'followup',
              category: 'engine-next-action',
              title: 'Retry with research',
              objective: 'Research the repo state and retry the failing validation path.',
              summary: 'Research the repo and retry the bounded patch.',
              riskClass: 'low',
              targetPaths: ['renderer/app.js'],
              capabilities: ['research-docs'],
              metadata: {
                followupSignature: 'engine-next-action:retry-with-research:test',
                nextActionCommand: 'retry-with-research',
              },
            },
          ],
        },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.deduped, false);
  assert.equal(result.createdCount, 1);
  assert.match(result.tasks[0].objective, /Research the repo state/i);
  assert.equal(fs.existsSync(result.hubPath), true);
});

test('resolveTaskHubDocumentPath points at the workspace task hub', () => {
  const repoRoot = path.join(__dirname, '..');
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-vscode-followup-hub-'));
  const hubDocument = resolveTaskHubDocumentPath(repoRoot, workspaceRoot);

  assert.match(hubDocument, /task-hub\.json$/);
  assert.match(hubDocument, /assistant_runs/);
});

test('collectWorkspaceFileCandidates resolves changed file paths against the workspace root', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-vscode-companion-workspace-'));
  const filePath = path.join(workspaceRoot, 'renderer', 'app.js');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '// changed\n');

  const candidates = collectWorkspaceFileCandidates({
    changedFiles: [{ path: 'renderer/app.js' }, { path: 'renderer/app.js' }],
  }, workspaceRoot);

  assert.deepEqual(candidates, [filePath]);
});
