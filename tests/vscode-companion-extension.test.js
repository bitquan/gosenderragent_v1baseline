'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildOrchestrateRequest,
  buildMemoryHintsViewModel,
  buildSelfHostProofViewModel,
  buildSelfImprovementProofViewModel,
  buildQueuedFollowupViewModel,
  buildRepairObjective,
  buildReviewBundleViewModel,
  buildTaskObjective,
  buildResearchObjective,
  collectWorkspaceFileCandidates,
  queueNextTaskLoopFollowupInWorkspace,
  resolveNextActionCommand,
  resolveCompanionRepoRoot,
  resolveTaskHubDocumentPath,
  WORKBENCH_VIEW_CONTAINER_ID,
  WORKBENCH_VIEW_ID,
} = require('../integration-library/extensions/vscode-companion/extension.js');

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

  assert.equal(pkg.version, '0.1.1');
  assert.ok(pkg.activationEvents.includes(`onView:${WORKBENCH_VIEW_ID}`));
  assert.equal(workbenchContainer?.title, 'GoSenderr');
  assert.equal(workbenchContainer?.icon, 'resources/activitybar-icon.svg');
  assert.equal(workbenchView?.type, 'webview');
  assert.equal(workbenchView?.name, 'Workbench');
});

test('buildOrchestrateRequest uses the current orchestrate action and workspace root', () => {
  const request = buildOrchestrateRequest(
    'Repair the failing validation path.',
    'E:\\dev\\projects\\gosenderr-desktop-agent-PC',
    { retryWithResearch: true },
  );

  assert.equal(request.action, 'orchestrate');
  assert.equal(request.objective, 'Repair the failing validation path.');
  assert.equal(request.targetWorkspaceRoot, 'E:\\dev\\projects\\gosenderr-desktop-agent-PC');
  assert.equal(request.metadata.surface, 'vscode-companion');
  assert.equal(request.metadata.retry_with_research, true);
  assert.equal(request.taskObjective.kind, 'research-retry');
  assert.equal(request.metadata.taskObjective.source, 'vscode-companion');
});

test('buildResearchObjective makes the retry path explicit', () => {
  const objective = buildResearchObjective('Repair the failing validation path.');
  assert.match(objective, /Research the repo state/i);
  assert.match(objective, /Repair the failing validation path\./i);
});

test('buildTaskObjective keeps the shared dev-engine loop visible for the companion', () => {
  const payload = buildTaskObjective('Repair the failing validation path.', { retryWithResearch: false });
  assert.equal(payload.kind, 'coding-task');
  assert.equal(payload.source, 'vscode-companion');
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
      pendingCount: 1,
    },
  });

  assert.equal(view.label, 'Repair required');
  assert.match(view.meta, /reason: Validation failed in renderer\/app\.js\./);
  assert.match(view.meta, /fix: Repair the failing validation path/);
  assert.match(view.meta, /changes: 2 changed file/);
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
    summary: 'Self-host proof passed (3/3), including smoke.',
    nextAction: 'Keep the next self-host slice bounded and rerun the same proof after meaningful self-work.',
  });

  assert.equal(view.label, 'PROVEN');
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
