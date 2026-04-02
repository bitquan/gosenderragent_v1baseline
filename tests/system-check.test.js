'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('node:child_process');

const { buildAcceptanceControlSummary } = require('../core/engine-acceptance');
const { buildAiStatus } = require('../core/ai-center');
const { getAssistantArtifactsRoot, getAssistantRunsDir, getConfiguredAssistantBenchmarkRoot } = require('../core/assistant-paths');
const {
  augmentLearningStatusWithLiveEvidence,
  buildAppRollbackStatus,
  buildSelfImprovementSummary,
  buildSystemCheck,
  buildWorkspaceUpdateStatus,
  renderSystemCheck,
} = require('../core/system-check');
const { readHub } = require('../core/task-hub');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function localDayStamp(value = Date.now()) {
  const moment = new Date(value);
  return `${moment.getFullYear()}-${String(moment.getMonth() + 1).padStart(2, '0')}-${String(moment.getDate()).padStart(2, '0')}`;
}

function createWorkspaceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-system-check-'));
  const otherWorkspaceRoot = path.join(root, '..', 'other-workspace');
  const artifactsRoot = path.join(root, 'artifacts');
  const companionRoot = path.join(root, 'integration-library', 'extensions', 'vscode-companion');
  const roadmapDay = localDayStamp();
  fs.mkdirSync(artifactsRoot, { recursive: true });
  fs.mkdirSync(companionRoot, { recursive: true });
  fs.writeFileSync(path.join(root, 'dev_assistant.yaml'), [
    'assistant_artifacts_root: ./artifacts',
    'assistant_daily_safe_autonomous_target: 5',
    'assistant_daily_self_improvement_target: 5',
    'assistant_model_profile_id: gs-dev-1-default',
    'assistant_model_display_name: Workspace Coding Model',
    'assistant_model_base_model: qwen2.5-coder:14b',
    'assistant_model_base_provider: ollama',
    'assistant_model_provider_source: ollama',
    'assistant_workspace_model_profile_id: gs-dev-1-default',
    'assistant_workspace_model_display_name: Workspace Coding Model',
    'assistant_workspace_model_base_model: qwen2.5-coder:14b',
    'assistant_workspace_model_base_provider: ollama',
    'assistant_workspace_model_provider_source: ollama',
    'assistant_engine_model_profile_id: gse-1-engine',
    'assistant_engine_model_display_name: GSE-1 Engine',
    'assistant_engine_model_base_model: gpt-5.4',
    'assistant_engine_model_base_provider: openai',
    'assistant_engine_model_provider_source: openai',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(companionRoot, 'package.json'), JSON.stringify({
    name: 'gosenderr-vscode-companion',
    displayName: 'GoSenderr VS Code Companion',
    version: '0.1.0',
    main: './extension.js',
    scripts: {
      check: 'node --check ./extension.js',
    },
    contributes: {
      commands: [{ command: 'gosenderr.openWorkbench' }],
    },
    engines: { vscode: '^1.95.0' },
  }, null, 2));
  fs.writeFileSync(path.join(companionRoot, 'extension.js'), 'module.exports = { activate() {} };\n');
  const resolvedArtifactsRoot = getAssistantArtifactsRoot(root);
  const runsRoot = getAssistantRunsDir(root);
  const benchmarkRoot = getConfiguredAssistantBenchmarkRoot(root);
  const devRunsRoot = path.join(resolvedArtifactsRoot, 'dev_data', '.dev_agent_runs');
  writeJson(path.join(runsRoot, 'runtime_state.json'), {
    activeRuns: ['run-123'],
    runs: [
      {
        runId: 'run-123',
        workspaceRoot: root,
        targetWorkspaceRoot: root,
        state: 'fail',
        task: 'Patch renderer status cards',
        taskMode: 'coder',
        laneLabel: 'Code main',
        modelRole: 'workspace',
        modelProfileId: 'gs-dev-1-default',
        modelDisplayName: 'Workspace Coding Model',
        operatorExecution: {
          task: 'Patch renderer status cards',
          taskMode: 'coder',
          laneLabel: 'Code main',
          runState: 'fail',
          resultSummary: 'Validation failed on the renderer smoke test.',
          changedFiles: [
            { path: 'renderer/app.js', status: 'modified' },
            { path: 'main.js', status: 'modified' },
          ],
          reviewSummary: { summary: 'Review still needs one more pass.' },
          trustSummary: { trust_state: 'needs_review', summary: 'Trust summary pending repair.' },
          outputTail: { combined: 'node --test\nFAIL tests/ui-shell.test.js' },
          modelRole: 'workspace',
          modelProfileId: 'gs-dev-1-default',
          modelDisplayName: 'Workspace Coding Model',
          workspaceRoot: root,
          targetWorkspaceRoot: root,
          retryAvailable: true,
          repairAvailable: true,
        },
      },
      {
        runId: 'run-foreign',
        workspaceRoot: otherWorkspaceRoot,
        targetWorkspaceRoot: otherWorkspaceRoot,
        state: 'pass',
        task: 'Foreign workspace run should not count.',
        taskMode: 'planner',
        modelRole: 'engine',
        operatorExecution: {
          task: 'Foreign workspace run should not count.',
          taskMode: 'planner',
          modelRole: 'engine',
          workspaceRoot: otherWorkspaceRoot,
          targetWorkspaceRoot: otherWorkspaceRoot,
          changedFiles: [],
          reviewSummary: {
            requiresManualReview: false,
            pendingApprovalCount: 0,
            lowConfidencePatchCount: 0,
            summary: 'No manual blockers.',
          },
          trustSummary: {
            trust_state: 'ready',
            summary: 'Trust is clear.',
          },
        },
      },
    ],
  });
  writeJson(path.join(devRunsRoot, 'self_improvement', 'queue_summary.json'), {
    total_candidates: 2,
    eligible_candidate_count: 1,
    prepared_tasks: [
      {
        task_id: 'self-1',
        title: 'Tighten renderer task-loop status copy',
        target_paths: ['renderer/app.js'],
      },
    ],
  });
  fs.writeFileSync(
    path.join(devRunsRoot, 'self_improvement', 'execution_history.jsonl'),
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      task_id: 'self-1',
      candidate_id: 'candidate-1',
      status: 'succeeded',
      target_paths: ['renderer/app.js'],
    })}\n`,
    'utf8',
  );
  writeJson(path.join(runsRoot, 'task-hub.json'), {
    schemaVersion: '2026-03-15',
    updatedAt: new Date().toISOString(),
    goals: [],
    tasks: [
      {
        id: 'task-daily-1',
        goalId: 'goal-daily-1',
        title: 'Finish the unified daily quota proof surface',
        objective: 'Finish the unified daily quota proof surface.',
        source: 'codex',
        status: 'ready',
        workspaceRoot: root,
        targetWorkspaceRoot: root,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {
          dailyTask: true,
          roadmapMonth: 'month-1-engine-baseline',
          roadmapDay,
          followupSignature: `daily-task:${roadmapDay}:quota-proof`,
          workspaceScopeRoot: root,
        },
      },
      {
        id: 'task-blocked-1',
        goalId: 'goal-daily-1',
        title: 'Rescope the blocked autonomous patch slice',
        objective: 'Rescope the blocked autonomous patch slice.',
        source: 'chat',
        status: 'needs-rescope',
        workspaceRoot: root,
        targetWorkspaceRoot: root,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {
          roadmapDay,
          lastBlockedBy: 'model-fit',
          lastBlockedReason: 'Task exceeds the active model envelope.',
          workspaceScopeRoot: root,
        },
      },
      {
        id: 'task-foreign-1',
        goalId: 'goal-daily-2',
        title: 'Foreign workspace focus task',
        objective: 'Foreign workspace focus task.',
        source: 'codex',
        status: 'ready',
        workspaceRoot: otherWorkspaceRoot,
        targetWorkspaceRoot: otherWorkspaceRoot,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {
          dailyTask: true,
          roadmapMonth: 'month-1-engine-baseline',
          roadmapDay,
          followupSignature: `daily-task:${roadmapDay}:foreign-focus`,
          workspaceScopeRoot: otherWorkspaceRoot,
        },
      },
    ],
    runLinks: [],
  });
  writeJson(path.join(benchmarkRoot, 'acceptance', 'latest.json'), {
    runId: 'engine_acceptance_1',
    label: 'engine-acceptance',
    startedAt: '2026-03-16T17:55:00.000Z',
    completedAt: '2026-03-16T18:00:00.000Z',
    workspaceRoot: root,
    targetWorkspaceRoot: root,
    overallStatus: 'fail',
    summary: '1 acceptance check(s) failed.',
    nextAction: 'Repair the smoke suite before promoting or widening.',
    autonomyProof: {
      target: 5,
      safeCount: 5,
      overscopedCount: 0,
      actionCount: 5,
      workspaceScoped: true,
      workspaceRoot: root,
      summary: 'Repo-scoped autonomy proof captured 5/5 safe current-workspace action(s).',
      actions: Array.from({ length: 5 }, (_, index) => ({
        runId: `proof-${index + 1}`,
        workspaceRoot: root,
        targetWorkspaceRoot: root,
        state: 'pass',
        modelRole: 'engine',
        taskMode: 'planner',
        safeToAdvance: true,
        metadata: {
          autonomyProof: true,
          workspaceScopeRoot: root,
          requestedModelRole: 'engine',
        },
      })),
    },
    builderProof: {
      target: 1,
      safeCount: 1,
      overscopedCount: 0,
      actionCount: 1,
      workspaceScoped: true,
      workspaceRoot: root,
      summary: 'Repo-scoped builder proof captured 1/1 safe current-workspace builder run.',
      nextAction: 'Keep the next builder slice bounded and reuse the same repo-scoped proof envelope.',
      actions: [
        {
          runId: 'builder-proof-1',
          workspaceRoot: root,
          targetWorkspaceRoot: root,
          state: 'pass',
          modelRole: 'engine',
          taskMode: 'planner',
          safeToAdvance: true,
          metadata: {
            builderProof: true,
            workspaceScopeRoot: root,
            requestedModelRole: 'engine',
          },
        },
      ],
    },
    modelParity: {
      status: 'pass',
      capabilityCount: 5,
      readyCount: 5,
      widenReady: true,
      summary: 'Local-vs-remote parity is PROVEN across 5/5 core coding capabilities.',
      nextAction: 'Keep the local stack aligned with the remote helper path as the bounded loop changes.',
      entries: [
        {
          id: 'plan',
          label: 'Plan',
          status: 'pass',
          proofStatus: 'pass',
          local: { role: 'workspace', modelProfileId: 'gs-dev-1-default', baseModel: 'qwen2.5-coder:14b', providerSource: 'ollama' },
          remote: { role: 'engine', modelProfileId: 'gse-1-engine', baseModel: 'gpt-5.4', providerSource: 'openai' },
        },
      ],
    },
    modelParity: {
      status: 'pass',
      capabilityCount: 5,
      readyCount: 5,
      widenReady: true,
      summary: 'Local-vs-remote parity is PROVEN across 5/5 core coding capabilities.',
      nextAction: 'Keep the local stack aligned with the remote helper path as the bounded loop changes.',
      entries: [
        {
          id: 'plan',
          label: 'Plan',
          status: 'pass',
          proofStatus: 'pass',
          local: { role: 'workspace', modelProfileId: 'gs-dev-1-default', baseModel: 'qwen2.5-coder:14b', providerSource: 'ollama' },
          remote: { role: 'engine', modelProfileId: 'gse-1-engine', baseModel: 'gpt-5.4', providerSource: 'openai' },
        },
      ],
    },
    checks: [
      {
        id: 'tests',
        label: 'Node test suite',
        status: 'pass',
        summary: 'Tests passed.',
      },
      {
        id: 'smoke',
        label: 'Smoke suite',
        status: 'fail',
        summary: 'Renderer smoke failed on the latest candidate.',
      },
      {
        id: 'smoke-ui',
        label: 'UI smoke suite',
        status: 'pass',
        summary: 'UI smoke passed.',
      },
      {
        id: 'self-host-bootstrap',
        label: 'Self-host lab dependency bootstrap',
        status: 'pass',
        summary: 'Bootstrapped self-host lab dependencies.',
      },
      {
        id: 'self-host-tests',
        label: 'Self-host lab test suite',
        status: 'pass',
        summary: 'Self-host baseline suite passed.',
      },
      {
        id: 'self-host-smoke',
        label: 'Self-host lab smoke suite',
        status: 'pass',
        summary: 'Self-host lab smoke passed.',
      },
    ],
  });
  return root;
}

test('buildSystemCheck aggregates runtime, model roles, and self-improvement queue state', () => {
  const workspaceRoot = createWorkspaceFixture();
  const aiStatus = buildAiStatus({
    settings: {
      runtime: 'ollama',
      trainingOllamaModel: 'qwen2.5-coder:14b',
      aiProfile: 'hybrid-default',
      aiRoutingPolicy: 'hybrid-default',
      aiWorkspaceWrappedProfileId: 'gs-dev-1-default',
      aiEngineWrappedProfileId: 'gse-1-engine',
      aiWrappedProfiles: [
        {
          id: 'gs-dev-1-default',
          displayName: 'Workspace Coding Model',
          role: 'workspace',
          family: 'gs-dev-1',
          baseModel: 'qwen2.5-coder:14b',
          baseProvider: 'ollama',
          providerSource: 'ollama',
        },
        {
          id: 'gse-1-engine',
          displayName: 'GSE-1 Engine',
          role: 'engine',
          family: 'gse-1',
          baseModel: 'qwen2.5-coder:14b',
          baseProvider: 'ollama',
          providerSource: 'ollama',
        },
      ],
    },
    tuningStatus: {
      telemetry: {
        ollama: {
          running: true,
          reachable: true,
          modelCount: 1,
          models: ['qwen2.5-coder:14b'],
          selectedModel: 'qwen2.5-coder:14b',
          selectedModelReady: true,
        },
        models: {
          storageRoot: path.join(workspaceRoot, 'models'),
          storageReachable: true,
          registeredRoot: path.join(workspaceRoot, 'ollama-home', 'models'),
          registeredReachable: true,
          registered: [
            { value: 'qwen2.5-coder:14b', source: 'ollama-store', ready: true },
          ],
          discovered: [
            {
              fileName: 'Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf',
              source: 'storage',
              importTag: 'qwen2.5-coder:14b',
              ollamaModel: 'qwen2.5-coder:14b',
            },
          ],
          availableOptions: [
            { value: 'qwen2.5-coder:14b', label: 'Qwen2.5 Coder 14B', source: 'ollama', ready: true },
          ],
        },
        trustSummary: {
          status: 'ready',
          summary: 'Local tuning looks healthy.',
        },
      },
    },
    benchmarkRuns: [
      {
        id: 'bench-local-qwen',
        model: 'qwen2.5-coder:14b',
        modelProfileId: 'gs-dev-1-default',
        baseModel: 'qwen2.5-coder:14b',
        providerSource: 'ollama',
        taskMode: 'coder',
        status: 'pass',
        passRate: 100,
      },
    ],
    modelFoundry: {
      candidates: [
        {
          id: 'candidate-local-qwen',
          title: 'Local qwen route bundle',
          modelProfileId: 'gs-dev-1-default',
          baseModel: 'qwen2.5-coder:14b',
          providerSource: 'ollama',
          sourceBenchmarks: ['bench-local-qwen'],
          safetyLevel: 'candidate',
        },
      ],
    },
  });
  const modelFoundry = {
    summary: 'Local qwen route bundle is ready for the next bounded comparison.',
    nextCandidate: {
      id: 'candidate-local-qwen',
      modelIdentity: {
        candidateId: 'candidate-local-qwen',
        wrappedProfileId: 'gs-dev-1-default',
        baseModel: 'qwen2.5-coder:14b',
        providerSource: 'ollama',
        taskMode: 'coder',
        benchmarkIdentity: {
          id: 'bench-local-qwen',
          wrappedProfileId: 'gs-dev-1-default',
          baseModel: 'qwen2.5-coder:14b',
          providerSource: 'ollama',
          taskMode: 'coder',
        },
      },
    },
    nextCandidateIdentity: {
      candidateId: 'candidate-local-qwen',
      wrappedProfileId: 'gs-dev-1-default',
      baseModel: 'qwen2.5-coder:14b',
      providerSource: 'ollama',
      taskMode: 'coder',
      benchmarkIdentity: {
        id: 'bench-local-qwen',
        wrappedProfileId: 'gs-dev-1-default',
        baseModel: 'qwen2.5-coder:14b',
        providerSource: 'ollama',
        taskMode: 'coder',
      },
    },
  };
  const benchmarks = {
    runs: [
      {
        id: 'bench-local-qwen',
        model: 'qwen2.5-coder:14b',
        modelProfileId: 'gs-dev-1-default',
        wrappedProfileId: 'gs-dev-1-default',
        baseModel: 'qwen2.5-coder:14b',
        providerSource: 'ollama',
        taskMode: 'coder',
        status: 'pass',
        passRate: 100,
        benchmarkIdentity: {
          id: 'bench-local-qwen',
          wrappedProfileId: 'gs-dev-1-default',
          baseModel: 'qwen2.5-coder:14b',
          providerSource: 'ollama',
          taskMode: 'coder',
        },
      },
    ],
  };
  const promotions = {
    promotionGate: {
      status: 'ready',
      summary: 'Promotion gate is ready for a bounded manual promotion.',
    },
    readyCandidates: [{ id: 'candidate-promote-local-qwen' }],
    latestBackupId: 'backup-123',
    currentCandidateIdentity: {
      candidateId: 'candidate-promote-local-qwen',
      wrappedProfileId: 'gs-dev-1-default',
      baseModel: 'qwen2.5-coder:14b',
      providerSource: 'ollama',
      taskMode: 'coder',
      promotionState: 'ready',
      latestBackupId: 'backup-123',
      benchmarkIdentity: {
        id: 'bench-local-qwen',
        wrappedProfileId: 'gs-dev-1-default',
        baseModel: 'qwen2.5-coder:14b',
        providerSource: 'ollama',
        taskMode: 'coder',
      },
    },
    currentBenchmarkIdentity: {
      id: 'bench-local-qwen',
      wrappedProfileId: 'gs-dev-1-default',
      baseModel: 'qwen2.5-coder:14b',
      providerSource: 'ollama',
      taskMode: 'coder',
    },
  };
  const acceptanceReport = {
    runId: 'engine_acceptance_1',
    label: 'engine-acceptance',
    startedAt: '2026-03-16T17:55:00.000Z',
    completedAt: '2026-03-16T18:00:00.000Z',
    workspaceRoot,
    targetWorkspaceRoot: workspaceRoot,
    overallStatus: 'fail',
    summary: '1 acceptance check(s) failed.',
    nextAction: 'Repair the smoke suite before promoting or widening.',
    autonomyProof: {
      target: 5,
      safeCount: 5,
      overscopedCount: 0,
      actionCount: 5,
      workspaceScoped: true,
      workspaceRoot,
      summary: 'Repo-scoped autonomy proof captured 5/5 safe current-workspace action(s).',
      actions: Array.from({ length: 5 }, (_, index) => ({
        runId: `proof-${index + 1}`,
        workspaceRoot,
        targetWorkspaceRoot: workspaceRoot,
        state: 'pass',
        modelRole: 'engine',
        taskMode: 'planner',
        safeToAdvance: true,
        metadata: {
          autonomyProof: true,
          workspaceScopeRoot: workspaceRoot,
          requestedModelRole: 'engine',
        },
      })),
    },
    builderProof: {
      target: 1,
      safeCount: 1,
      overscopedCount: 0,
      actionCount: 1,
      workspaceScoped: true,
      workspaceRoot,
      summary: 'Repo-scoped builder proof captured 1/1 safe current-workspace builder run.',
      nextAction: 'Keep the next builder slice bounded and reuse the same repo-scoped proof envelope.',
      actions: [
        {
          runId: 'builder-proof-1',
          workspaceRoot,
          targetWorkspaceRoot: workspaceRoot,
          state: 'pass',
          modelRole: 'engine',
          taskMode: 'planner',
          safeToAdvance: true,
          metadata: {
            builderProof: true,
            workspaceScopeRoot: workspaceRoot,
            requestedModelRole: 'engine',
          },
        },
      ],
    },
    modelParity: {
      status: 'pass',
      capabilityCount: 5,
      readyCount: 5,
      widenReady: true,
      summary: 'Local-vs-remote parity is PROVEN across 5/5 core coding capabilities.',
      nextAction: 'Keep the local stack aligned with the remote helper path as the bounded loop changes.',
      entries: [
        {
          id: 'plan',
          label: 'Plan',
          status: 'pass',
          proofStatus: 'pass',
          local: { role: 'workspace', modelProfileId: 'gs-dev-1-default', baseModel: 'qwen2.5-coder:14b', providerSource: 'ollama' },
          remote: { role: 'engine', modelProfileId: 'gse-1-engine', baseModel: 'gpt-5.4', providerSource: 'openai' },
        },
      ],
    },
    checks: [
      {
        id: 'tests',
        label: 'Node test suite',
        status: 'pass',
        summary: 'Tests passed.',
      },
      {
        id: 'smoke',
        label: 'Smoke suite',
        status: 'fail',
        summary: 'Renderer smoke failed on the latest candidate.',
      },
      {
        id: 'smoke-ui',
        label: 'UI smoke suite',
        status: 'pass',
        summary: 'UI smoke passed.',
      },
      {
        id: 'self-host-bootstrap',
        label: 'Self-host lab dependency bootstrap',
        status: 'pass',
        summary: 'Bootstrapped self-host lab dependencies.',
      },
      {
        id: 'self-host-tests',
        label: 'Self-host lab test suite',
        status: 'pass',
        summary: 'Self-host baseline suite passed.',
      },
      {
        id: 'self-host-smoke',
        label: 'Self-host lab smoke suite',
        status: 'pass',
        summary: 'Self-host lab smoke passed.',
      },
    ],
  };
  const report = buildSystemCheck({
    workspaceRoot,
    targetWorkspaceRoot: workspaceRoot,
    path: 'renderer/app.js',
    now: `${localDayStamp()}T18:00:00.000Z`,
    acceptance: {
      ok: true,
      exists: true,
      outputPath: path.join(workspaceRoot, 'artifacts', 'assistant_benchmarks', 'acceptance', 'latest.json'),
      report: acceptanceReport,
      controlSummary: buildAcceptanceControlSummary(acceptanceReport, { exists: true }),
    },
    aiStatus,
    benchmarks,
    modelFoundry,
    promotions,
    learningJournal: {
      trainingReadiness: {
        status: 'ready',
        summary: 'Trusted learning candidates are queued for the next idle-safe training window.',
      },
      gsDev1ExportReadiness: {
        summary: '1 trusted example is ready for GS-Dev-1 training handoff export.',
      },
      memoryHints: {
        summary: '2 reject pattern(s) recorded. Most common: Validation failed in renderer/app.js. Preferred response: repair-loop.',
        topRejectReason: 'Validation failed in renderer/app.js.',
        topFixPattern: 'Repair renderer/app.js and rerun the UI shell test.',
        recommendedResponse: 'repair-loop',
        phaseSummary: 'Phase 1: Safe Engine Core is showing the strongest reusable guidance right now.',
        topPaths: [{ value: 'renderer/app.js', count: 2 }],
      },
    },
    vscodeSetup: {
      companionInstall: {
        available: true,
        installed: true,
      },
    },
    extensionHealth: {
      exists: true,
      status: 'ready',
      summary: 'GoSenderr VS Code Companion is aligned enough for the current desktop baseline.',
      nextStep: 'Keep the extension aligned with the desktop contracts as you tune the engine.',
    },
    tuningStatus: {
      telemetry: {
        ollama: {
          running: false,
          reachable: false,
          modelCount: 0,
          selectedModel: 'qwen2.5-coder:14b',
          selectedModelReady: false,
        },
      },
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.areas.models.workspace.modelProfileId, 'gs-dev-1-default');
  assert.equal(report.areas.models.engine.modelProfileId, 'gse-1-engine');
  assert.equal(Array.isArray(report.areas.models.roles), true);
  assert.equal(report.areas.models.roles.length, 3);
  assert.equal(report.areas.models.roles.find((role) => role.id === 'orchestrator').wrappedProfileId, 'gse-1-engine');
  assert.equal(report.areas.models.roles.find((role) => role.id === 'worker').wrappedProfileId, 'gs-dev-1-default');
  assert.equal(report.areas.models.roles.find((role) => role.id === 'reviewer').wrappedProfileId, 'gse-1-engine');
  assert.deepEqual(report.areas.models.roles.find((role) => role.id === 'orchestrator').laneIds, ['chat-fast', 'plan-reasoning', 'research-docs', 'ops-summary']);
  assert.equal(report.areas.models.laneAssignments.find((lane) => lane.laneId === 'chat-fast').role, 'engine');
  assert.equal(report.areas.models.localInventory.status, 'ready');
  assert.equal(report.areas.models.localInventory.entries.some((entry) => entry.wrappedProfileId === 'gs-dev-1-default'), true);
  assert.equal(report.areas.models.localInventory.entries.some((entry) => entry.kind === 'foundry-candidate'), true);
  assert.equal(report.areas.models.benchmarkLeaderIdentity.id, 'bench-local-qwen');
  assert.equal(report.areas.models.foundryNextCandidateIdentity.candidateId, 'candidate-local-qwen');
  assert.equal(report.areas.models.promotionCandidateIdentity.candidateId, 'candidate-promote-local-qwen');
  assert.equal(report.areas.promotion.currentCandidateIdentity.candidateId, 'candidate-promote-local-qwen');
  assert.equal(report.areas.promotion.benchmarkIdentity.id, 'bench-local-qwen');
  assert.equal(report.areas.runs.latestRun.changedFiles.length, 1);
  assert.equal(report.areas.runs.latestRun.changedFiles[0].path, 'renderer/app.js');
  assert.equal(report.areas.trust.trustSummary.trust_state, 'needs_review');
  assert.equal(report.areas.autonomy.actionCount, 1);
  assert.equal(report.areas.autonomy.workspaceScoped, true);
  assert.equal(report.areas.autonomy.currentWorkspaceActionCount, 1);
  assert.equal(report.areas.autonomy.latestActions.some((item) => item.runId === 'run-foreign'), false);
  assert.equal(report.areas.autonomy.highestRiskAction.runId, 'run-123');
  assert.equal(report.areas.autonomy.blockers.total, 1);
  assert.equal(report.areas.autonomy.unlockPlan.status, 'hold');
  assert.match(report.areas.autonomy.summary, /daily progress|review|overscoped/i);
  assert.match(report.areas.autonomy.recommendedNextSafeAction, /Repair|Rescope|provisioning|trustworthy/i);
  assert.match(report.areas.engine.nextSafeAction, /Repair|Rescope|provisioning|trustworthy/i);
  assert.equal(report.areas['self-improvement'].preparedTaskCount, 1);
  assert.equal(report.areas['self-improvement'].dailyTarget.safeCount, 1);
  assert.match(report.areas['self-improvement'].summary, /queued|safe self-improvement/i);
  assert.equal(report.areas.roadmap.currentPhase.number, 1);
  assert.equal(report.areas.roadmap.currentPhase.id, 'phase-1-safe-engine-core');
  assert.equal(report.areas.roadmap.phaseGate.label, 'BLOCKED');
  assert.equal(report.areas.roadmap.phasePercent > 0, true);
  assert.match(report.areas.roadmap.phaseProof.summary, /Month 1|structural baseline proof/i);
  assert.equal(Array.isArray(report.areas.roadmap.phaseScorecards), true);
  assert.equal(report.areas.roadmap.phaseScorecards.length > 0, true);
  assert.match(report.areas.roadmap.internalAudit.summary, /Month 1|BLOCKED/i);
  assert.equal(report.areas.roadmap.currentMonth.number, 1);
  assert.equal(report.areas.roadmap.hardGate.label, 'BLOCKED');
  assert.equal(report.areas.roadmap.phaseNextMilestone.id, 'phase-1-safe-engine-core');
  assert.equal(report.areas.roadmap.selfHostExpansionProgress.label, 'NOT USED');
  assert.equal(report.areas.roadmap.dailyQuotaProof.focusTask.title, 'Finish the unified daily quota proof surface');
  assert.equal(report.areas.roadmap.dailyQuotaProof.blockedRescopedCount, 1);
  assert.equal(report.areas.roadmap.dailyQuotaProof.validation.label, 'FAIL');
  assert.match(report.areas.roadmap.dailyQuotaProof.doNotWidenYetBecause, /blocked or need rescope|provisioning|trustworthy/i);
  assert.equal(report.areas.roadmap.selfImprovementProof.label, 'PROVEN');
  assert.equal(report.areas.roadmap.companionParity.label, 'PROVEN');
  assert.equal(report.areas.roadmap.modelParity.label, 'PROVEN');
  assert.equal(report.areas.roadmap.autonomyProof.safeCount, 5);
  assert.equal(report.areas.roadmap.autonomyProof.workspaceScoped, true);
  assert.match(report.areas.roadmap.engineProof.summary, /Patch renderer status cards/i);
  assert.equal(report.areas.acceptance.capabilityState, 'blocked');
  assert.equal(report.areas.acceptance.capabilityLabel, 'BLOCKED');
  assert.equal(report.areas.acceptance.latestAcceptanceLabel, 'FAIL');
  assert.equal(report.areas.acceptance.latestSmokeLabel, 'FAIL');
  assert.equal(report.areas.acceptance.smokeCapabilityState, 'blocked');
  assert.equal(report.areas.acceptance.smokeCapabilityLabel, 'BLOCKED');
  assert.equal(report.areas.acceptance.nextDayLabel, 'BLOCKED');
  assert.match(report.areas.acceptance.smokeSummary, /smoke check\(s\) failed/i);
  assert.match(report.areas.acceptance.blockerSummary, /Renderer smoke failed/i);
  assert.equal(report.areas.acceptance.autonomyProof.safeCount, 5);
  assert.equal(report.areas.acceptance.builderProof.safeCount, 1);
  assert.equal(report.areas.acceptance.modelParity.readyCount, 5);
  assert.match(report.areas.acceptance.nextSafeAction, /Repair the failing smoke check/i);
  assert.equal(report.areas.models.provisioning.status, 'warn');
  assert.match(report.areas.models.provisioning.summary, /provisioned|routing|not live|guardrail/i);
  assert.equal(report.areas.models.localPolicy.mixedLiveState, true);
  assert.match(report.areas.models.localPolicy.currentStateSummary, /qwen2\.5-coder:14b.*candidate-only/i);
  assert.match(report.areas.models.localPolicy.perModelCapSummary, /32 GB cap/i);
  assert.match(report.areas.models.localPolicy.activeBundleSummary, /32 GB live-fit/i);
  assert.match(report.areas.models.localPolicy.enforcementSummary, /runs on qwen2\.5-coder:7b/i);
  assert.equal(typeof report.areas.models.localProofMatrix.summary, 'string');
  assert.equal(Array.isArray(report.areas.models.localProofMatrix.entries), true);
  assert.equal(Array.isArray(report.areas.models.localProofMatrix.families), true);
  assert.equal(Array.isArray(report.areas.models.integrations?.library), true);
  assert.equal(report.areas.models.integrations.library.length >= 3, true);
  assert.equal(report.areas.learning.docsContext.recipeId, 'docs-scout');
  assert.match(report.areas.learning.docsContext.summary, /docs-scout|approved docs/i);
  assert.match(report.areas.learning.memoryHints.summary, /reject pattern/i);
  assert.equal(report.areas.learning.memoryHints.recommendedResponse, 'repair-loop');
  assert.equal(report.areas.learning.capabilityState, 'verified');
  assert.equal(report.areas.learning.capabilityLabel, 'VERIFIED');
  assert.equal(report.areas.learning.selfHostProof.label, 'PROVEN');
  assert.match(report.areas.learning.selfHostProof.summary, /Self-host proof passed/i);
  assert.match(renderSystemCheck(report, { compact: true }), /Current phase:/);
  assert.match(renderSystemCheck(report, { compact: true }), /Phase proof:/);
  assert.match(renderSystemCheck(report, { compact: true }), /Internal audit:/);
  assert.match(renderSystemCheck(report, { compact: true }), /Phase score:/);
  assert.match(renderSystemCheck(report, { area: 'roadmap', compact: true }), /Focus task:/);
  assert.match(renderSystemCheck(report, { area: 'roadmap', compact: true }), /Phase gate:/);
  assert.match(renderSystemCheck(report, { area: 'roadmap', compact: true }), /Next phase-safe action:/);
  assert.match(renderSystemCheck(report, { area: 'roadmap', compact: true }), /Self-host expansion:/);
  assert.match(renderSystemCheck(report, { area: 'roadmap', compact: true }), /Self-host expansion outcome:/);
  assert.match(renderSystemCheck(report, { area: 'roadmap', compact: true }), /Self-improvement proof:/);
  assert.match(renderSystemCheck(report, { area: 'roadmap', compact: true }), /Companion parity:/);
  assert.match(renderSystemCheck(report, { area: 'roadmap', compact: true }), /Model parity:/);
  assert.match(renderSystemCheck(report, { area: 'roadmap', compact: true }), /Autonomy proof:/);
  assert.match(renderSystemCheck(report, { area: 'roadmap', compact: true }), /Phase closeout:/);
  assert.match(renderSystemCheck(report, { area: 'roadmap', compact: true }), /Closeout blockers:/);
  assert.match(renderSystemCheck(report, { area: 'roadmap', compact: true }), /Next phase preview:/);
  assert.match(renderSystemCheck(report, { area: 'roadmap', compact: true }), /Do not widen yet:/);
  assert.match(renderSystemCheck(report, { compact: true }), /Engine proof:/);
  assert.match(renderSystemCheck(report, { area: 'models', compact: true }), /Provisioning:/);
  assert.match(renderSystemCheck(report, { area: 'models', compact: true }), /Front-door chat \/ orchestrator:/);
  assert.match(renderSystemCheck(report, { area: 'models', compact: true }), /Reviewer \/ approval reasoning:/);
  assert.match(renderSystemCheck(report, { area: 'models', compact: true }), /Local inventory:/);
  assert.match(renderSystemCheck(report, { area: 'models', compact: true }), /Engine proof matrix:/);
  assert.match(renderSystemCheck(report, { area: 'models', compact: true }), /Approved defaults:/);
  assert.match(renderSystemCheck(report, { area: 'models', compact: true }), /Candidate-only:/);
  assert.match(renderSystemCheck(report, { area: 'models', compact: true }), /Larger-headroom:/);
  assert.match(renderSystemCheck(report, { area: 'models', compact: true }), /32 GB cap:/);
  assert.match(renderSystemCheck(report, { area: 'models', compact: true }), /32 GB live-fit:/);
  assert.match(renderSystemCheck(report, { area: 'models', compact: true }), /Guardrail enforcement:/);
  assert.match(renderSystemCheck(report, { area: 'models', compact: true }), /Config review:/);
  assert.match(renderSystemCheck(report, { area: 'models', compact: true }), /Proof family /);
  assert.match(renderSystemCheck(report, { area: 'models', compact: true }), /Proof /);
  assert.match(renderSystemCheck(report, { area: 'models', compact: true }), /Candidate Local qwen route bundle:/);
  assert.match(renderSystemCheck(report, { area: 'models', compact: true }), /Benchmark leader:/);
  assert.match(renderSystemCheck(report, { area: 'models', compact: true }), /Foundry next:/);
  assert.match(renderSystemCheck(report, { area: 'models', compact: true }), /Promotion candidate:/);
  assert.match(renderSystemCheck(report, { area: 'promotion', compact: true }), /Current candidate:/);
  assert.match(renderSystemCheck(report, { area: 'promotion', compact: true }), /Linked benchmark:/);
  assert.match(renderSystemCheck(report, { area: 'acceptance', compact: true }), /Latest smoke:/);
  assert.match(renderSystemCheck(report, { area: 'acceptance', compact: true }), /Next day gate:/);
  assert.match(renderSystemCheck(report, { area: 'acceptance', compact: true }), /Capability: BLOCKED/);
  assert.match(renderSystemCheck(report, { area: 'acceptance', compact: true }), /Repair the failing smoke check/i);
  assert.match(renderSystemCheck(report, { area: 'learning', compact: true }), /Reject patterns:/);
  assert.match(renderSystemCheck(report, { area: 'learning', compact: true }), /Training handoff:/);
  assert.match(renderSystemCheck(report, { area: 'learning', compact: true }), /GS-Dev-1 export:/);
  assert.match(renderSystemCheck(report, { area: 'learning', compact: true }), /Top reject reason:/);
  assert.match(renderSystemCheck(report, { area: 'learning', compact: true }), /Preferred response:/);
  assert.match(renderSystemCheck(report, { area: 'learning', compact: true }), /Phase focus:/);
  assert.match(renderSystemCheck(report, { area: 'learning', compact: true }), /Learned path:/);
  assert.match(renderSystemCheck(report, { area: 'learning', compact: true }), /Capability: VERIFIED/);
  assert.match(renderSystemCheck(report, { area: 'learning', compact: true }), /Self-host proof:/);
  assert.match(renderSystemCheck(report, { area: 'learning', compact: true }), /Self-host next step:/);
  assert.match(renderSystemCheck(report, { area: 'learning', compact: true }), /Self-improvement proof:/);
  assert.match(renderSystemCheck(report, { area: 'autonomy', compact: true }), /Workspace scoped:/);
  assert.match(renderSystemCheck(report, { area: 'autonomy', compact: true }), /Current workspace:/);
  assert.match(renderSystemCheck(report, { area: 'autonomy', compact: true }), /Blockers:/);
  assert.match(renderSystemCheck(report, { area: 'autonomy', compact: true }), /Unlock path:/);
  assert.match(renderSystemCheck(report, { area: 'autonomy', compact: true }), /Autonomy proof:/);
  assert.match(renderSystemCheck(report, { area: 'acceptance', compact: true }), /Autonomy proof:/);
  assert.match(renderSystemCheck(report, { area: 'acceptance', compact: true }), /Builder proof:/);
});

test('system-check falls back daily quota focus to a blocked rescope slice when no explicit daily focus task exists', () => {
  const workspaceRoot = createWorkspaceFixture();
  const taskHub = readHub(workspaceRoot);

  taskHub.tasks = taskHub.tasks.filter((task) => String(task?.id || '').trim() !== 'task-daily-1');

  const report = buildSystemCheck({
    workspaceRoot,
    targetWorkspaceRoot: workspaceRoot,
    taskHub,
  });

  assert.equal(report.areas.roadmap.dailyQuotaProof.focusTask.title, 'Rescope the blocked autonomous patch slice');
  assert.equal(report.areas.roadmap.dailyQuotaProof.focusTask.focusSourceType, 'blocked-rescope');
  assert.equal(report.areas.roadmap.dailyQuotaProof.focusTask.blockedBy, 'model-fit');
});

test('system-check infers GS-Dev-1 export and training proof from accepted benchmark and promotion evidence', () => {
  const augmented = augmentLearningStatusWithLiveEvidence({
    trainingReadiness: {
      status: 'idle',
      summary: 'Training is idle until trusted edits land.',
    },
    gsDev1ExportReadiness: {
      ready: false,
      status: 'idle',
      summary: 'Trusted exports are not ready yet.',
    },
  }, {
    acceptance: {
      exists: true,
      report: {
        overallStatus: 'pass',
      },
    },
    selfHostProof: {
      label: 'PROVEN',
      status: 'pass',
    },
    selfImprovement: {
      proof: {
        label: 'PROVEN',
        status: 'ready',
        proven: true,
      },
    },
    benchmarks: {
      runs: [
        {
          id: 'bench-gs-dev1',
          modelProfileId: 'gs-dev-1-default',
          wrappedProfileId: 'gs-dev-1-default',
          status: 'pass',
          passRate: 100,
        },
      ],
    },
    promotions: {
      readyCandidates: [
        {
          id: 'candidate-gs-dev1',
          modelProfileId: 'gs-dev-1-default',
          promotionGate: {
            status: 'ready',
            canPromote: true,
          },
        },
      ],
      candidates: [
        {
          id: 'candidate-gs-dev1',
          modelProfileId: 'gs-dev-1-default',
          status: 'candidate',
          promotionState: 'ready',
          promotionGate: {
            status: 'ready',
            canPromote: true,
          },
        },
      ],
    },
    modelFoundry: {
      candidates: [
        {
          id: 'foundry-gs-dev1',
          modelProfileId: 'gs-dev-1-default',
        },
      ],
    },
    modelRoles: {
      workspace: {
        modelProfileId: 'gs-dev-1-default',
      },
    },
  });

  assert.equal(augmented.gsDev1ExportReadiness.ready, true);
  assert.equal(augmented.gsDev1ExportReadiness.status, 'ready');
  assert.match(augmented.gsDev1ExportReadiness.summary, /approved or trusted gs-dev-1 training handoff is ready/i);
  assert.equal(augmented.trainingReadiness.status, 'ready');
  assert.match(augmented.trainingReadiness.summary, /training handoff is ready/i);
});

test('system-check models area surfaces missing live routed local tags from ai status provisioning', () => {
  const workspaceRoot = createWorkspaceFixture();
  try {
    const tuningStatus = {
      telemetry: {
        ollama: {
          running: true,
          reachable: true,
          modelCount: 1,
          selectedModel: 'qwen2.5-coder:14b',
          selectedModelReady: true,
          models: ['qwen2.5-coder:14b'],
        },
        models: {
          availableOptions: [
            { value: 'qwen2.5-coder:14b', label: 'Qwen2.5 Coder 14B', source: 'ollama', ready: true },
          ],
          registered: [
            { value: 'qwen2.5-coder:7b', label: 'Qwen2.5 Coder 7B', source: 'ollama-store', ready: true },
          ],
        },
        memory: { usedPercent: 42 },
        cpuUsagePercent: 21,
        thermal: { state: 'nominal' },
        runtime: { activeRuns: 0, schedulerRunning: false },
      },
    };
    const aiStatus = buildAiStatus({
      workspaceRoot,
      settings: {
        runtime: 'ollama',
        trainingOllamaModel: 'qwen2.5-coder:14b',
        aiProfile: 'hybrid-default',
        aiRoutingPolicy: 'hybrid-default',
        aiWorkspaceWrappedProfileId: 'gs-dev-1-default',
        aiEngineWrappedProfileId: 'gse-1-engine',
        aiWrappedProfiles: [
          {
            id: 'gs-dev-1-default',
            displayName: 'Workspace Coding Model',
            role: 'workspace',
            baseModel: 'qwen2.5-coder:14b',
            baseProvider: 'ollama',
            providerSource: 'ollama',
          },
          {
            id: 'gse-1-engine',
            displayName: 'GSE-1 Engine',
            role: 'engine',
            baseModel: 'qwen2.5-coder:7b',
            baseProvider: 'ollama',
            providerSource: 'ollama',
          },
        ],
      },
      tuningStatus,
      benchmarkRuns: [
        { id: 'bench-plan', model: 'qwen2.5-coder:7b', modelProfileId: 'gse-1-engine', baseModel: 'qwen2.5-coder:7b', providerSource: 'ollama', taskMode: 'planner', status: 'pass', ok: true, completedAt: '2026-03-25T10:00:00Z' },
        { id: 'bench-code', model: 'qwen2.5-coder:14b', modelProfileId: 'gs-dev-1-default', baseModel: 'qwen2.5-coder:14b', providerSource: 'ollama', taskMode: 'coder', status: 'pass', ok: true, completedAt: '2026-03-25T10:05:00Z' },
        { id: 'bench-validate', model: 'qwen2.5-coder:7b', modelProfileId: 'gse-1-engine', baseModel: 'qwen2.5-coder:7b', providerSource: 'ollama', taskMode: 'validator', status: 'pass', ok: true, completedAt: '2026-03-25T10:10:00Z' },
      ],
      acceptance: {
        exists: true,
        report: {
          overallStatus: 'pass',
          summary: 'Acceptance passed.',
        },
        controlSummary: {
          acceptanceStatus: 'pass',
          safeForNextDay: true,
          nextDaySummary: 'Acceptance is healthy.',
          nextSafeAction: 'Keep the next slice bounded.',
        },
      },
    });

    const report = buildSystemCheck({
      workspaceRoot,
      aiStatus,
      tuningStatus,
    });
    const modelsView = renderSystemCheck(report, { area: 'models', compact: true });

    assert.equal(report.areas.models.provisioning.status, 'warn');
    assert.deepEqual(report.areas.models.provisioning.routeCoverage.missingLiveModels, ['qwen2.5-coder:7b']);
    assert.match(modelsView, /Missing live tags:/);
    assert.match(modelsView, /qwen2.5-coder:7b/);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('system-check keeps GS-Dev-1 export blocked when acceptance is not green', () => {
  const augmented = augmentLearningStatusWithLiveEvidence({
    trainingReadiness: {
      status: 'idle',
      summary: 'Training is idle until trusted edits land.',
    },
    gsDev1ExportReadiness: {
      ready: true,
      status: 'ready',
      summary: '1 approved or trusted example is ready for GS-Dev-1 training handoff export.',
    },
  }, {
    acceptance: {
      exists: true,
      report: {
        overallStatus: 'fail',
      },
    },
    selfHostProof: {
      label: 'NOT RUN',
      status: 'idle',
    },
    selfImprovement: {
      proof: {
        label: 'PROVEN',
        status: 'ready',
        proven: true,
      },
    },
    benchmarks: {
      runs: [
        {
          id: 'bench-gs-dev1-blocked',
          modelProfileId: 'gs-dev-1-default',
          wrappedProfileId: 'gs-dev-1-default',
          status: 'pass',
          passRate: 100,
        },
      ],
    },
    promotions: {
      readyCandidates: [
        {
          id: 'candidate-gs-dev1-blocked',
          modelProfileId: 'gs-dev-1-default',
          promotionGate: {
            status: 'ready',
            canPromote: true,
          },
        },
      ],
      candidates: [
        {
          id: 'candidate-gs-dev1-blocked',
          modelProfileId: 'gs-dev-1-default',
          status: 'candidate',
          promotionState: 'ready',
          promotionGate: {
            status: 'ready',
            canPromote: true,
          },
        },
      ],
    },
    modelFoundry: {
      candidates: [
        {
          id: 'foundry-gs-dev1-blocked',
          modelProfileId: 'gs-dev-1-default',
        },
      ],
    },
    modelRoles: {
      workspace: {
        modelProfileId: 'gs-dev-1-default',
      },
    },
  });

  assert.equal(augmented.gsDev1ExportReadiness.ready, false);
  assert.equal(augmented.gsDev1ExportReadiness.status, 'blocked');
  assert.match(augmented.gsDev1ExportReadiness.summary, /acceptance baseline is not green enough/i);
  assert.notEqual(augmented.trainingReadiness.status, 'ready');
});

test('system-check CLI supports filtered JSON output', () => {
  const workspaceRoot = createWorkspaceFixture();
  const repoRoot = path.join(__dirname, '..');
  const raw = execFileSync('node', ['./scripts/system-check.js', '--workspace', workspaceRoot, '--area', 'trust', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const payload = JSON.parse(raw);

  assert.equal(payload.filters.area, 'trust');
  assert.equal(payload.areas.trust.status, 'needs_review');
  assert.equal(payload.areas.autonomy.actionCount, 6);
  assert.equal(payload.areas.roadmap.dailyTargets.autonomous.target, 5);
  assert.equal(payload.areas.models.engine.modelProfileId, 'gse-1-engine');
});

test('buildSelfImprovementSummary counts repo-scoped proof actions toward today when acceptance is healthy', () => {
  const workspaceRoot = createWorkspaceFixture();
  const now = `${localDayStamp()}T22:30:00.000Z`;
  const historyPath = path.join(getAssistantArtifactsRoot(workspaceRoot), 'dev_data', '.dev_agent_runs', 'self_improvement', 'execution_history.jsonl');
  fs.writeFileSync(
    historyPath,
    `${JSON.stringify({
      timestamp: '2026-03-15T08:00:00.000Z',
      task_id: 'self-older',
      candidate_id: 'candidate-older',
      status: 'succeeded',
      target_paths: ['renderer/app.js'],
    })}\n`,
    'utf8',
  );
  const acceptanceReport = {
    runId: 'engine_acceptance_healthy',
    label: 'engine-acceptance',
    startedAt: now,
    completedAt: now,
    workspaceRoot,
    targetWorkspaceRoot: workspaceRoot,
    overallStatus: 'pass',
    summary: 'Acceptance passed cleanly.',
    selfImprovementProof: {
      target: 5,
      safeCount: 5,
      overscopedCount: 0,
      actionCount: 5,
      workspaceScoped: true,
      workspaceRoot,
      summary: 'Repo-scoped self-improvement proof captured 5/5 safe current-workspace action(s).',
      nextAction: 'Keep the next self-improvement slice bounded and reuse the same gates.',
      actions: Array.from({ length: 5 }, (_, index) => ({
        runId: `self-proof-${index + 1}`,
        workspaceRoot,
        targetWorkspaceRoot: workspaceRoot,
        state: 'pass',
        safeToAdvance: true,
        startedAt: now,
        endedAt: now,
      })),
    },
    checks: [
      { id: 'tests', status: 'pass', summary: 'Tests passed.' },
      { id: 'smoke-ui', status: 'pass', summary: 'UI smoke passed.' },
      { id: 'self-host-smoke', status: 'pass', summary: 'Self-host smoke passed.' },
    ],
  };
  const acceptance = {
    exists: true,
    report: acceptanceReport,
    controlSummary: buildAcceptanceControlSummary(acceptanceReport, { exists: true }),
  };

  const summary = buildSelfImprovementSummary(workspaceRoot, '', {
    now,
    dailyTarget: 5,
    acceptance,
    targetWorkspaceRoot: workspaceRoot,
  });

  assert.equal(summary.dailyTarget.safeCount, 5);
  assert.equal(summary.dailyTarget.met, true);
  assert.equal(summary.proofActionCount, 5);
  assert.equal(summary.proof.label, 'PROVEN');
  assert.match(summary.summary, /5\/5 safe current-workspace action/i);
  assert.match(summary.recommendedNextSafeAction, /bounded|gates/i);
});

test('system-check derives rollback and update evidence from the current workspace by default', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-release-proof-'));
  const promotionsRoot = path.join(workspaceRoot, 'assistant_promotions');
  const backupRoot = path.join(
    promotionsRoot,
    'desktop_app_rollbacks',
    'darwin',
    'desktop-app-proof-1',
  );
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, 'dev_assistant.local.yaml'),
    `assistant_promotions_root: ${promotionsRoot}\n`,
    'utf8',
  );
  fs.mkdirSync(path.join(workspaceRoot, '.assistant_backups', 'proof-backup-1'), { recursive: true });
  writeJson(path.join(workspaceRoot, '.assistant_backups', 'history.json'), [
    {
      backupId: 'proof-backup-1',
      timestamp: '2026-03-18T10:00:00.000Z',
      ok: true,
      afterHead: 'abc1234def',
    },
  ]);
  writeJson(path.join(backupRoot, 'manifest.json'), {
    id: 'desktop-app-proof-1',
    platform: 'darwin',
    createdAt: '2026-03-17T22:45:55.829Z',
    reason: 'pre-install-replaced-live-app',
    workspaceRoot,
  });
  execFileSync('git', ['init', '-b', 'main'], { cwd: workspaceRoot, stdio: 'ignore' });

  const appRollbacks = buildAppRollbackStatus(workspaceRoot);
  const updates = buildWorkspaceUpdateStatus(workspaceRoot);

  assert.equal(appRollbacks.backupCount, 1);
  assert.equal(appRollbacks.latestBackupId, 'desktop-app-proof-1');
  assert.equal(appRollbacks.latestBackupPlatform, 'darwin');
  assert.equal(appRollbacks.rollbackReady, true);
  assert.match(String(appRollbacks.summary || ''), /desktop-app-proof-1/);
  assert.equal(updates.workspace.state, 'no-upstream');
  assert.equal(updates.workspace.ok, true);
  assert.equal(updates.workspace.hasUpdates, false);
  assert.equal(updates.workspace.recovery.rollbackReady, true);
  assert.equal(updates.workspace.recovery.latestBackupId, 'proof-backup-1');
  assert.match(String(updates.workspace.recovery.summary || ''), /rollback backup proof-backup-1/i);
});

test('buildSystemCheck falls back chat-fast to the engine route when lane role metadata is missing', () => {
  const workspaceRoot = createWorkspaceFixture();
  const report = buildSystemCheck(workspaceRoot, {
    assistantConfig: {
      workspaceModelProfileId: 'gs-dev-1-default',
      workspaceModelDisplayName: 'Workspace Coding Model',
      workspaceBaseModel: 'qwen2.5-coder:14b',
      workspaceBaseProvider: 'ollama',
      workspaceProviderSource: 'ollama',
      engineModelProfileId: 'gse-1-engine',
      engineModelDisplayName: 'GSE-1 Engine',
      engineBaseModel: 'qwen2.5-coder:7b',
      engineBaseProvider: 'ollama',
      engineProviderSource: 'ollama',
      dailySafeAutonomousTarget: 5,
      dailySelfImprovementTarget: 5,
    },
    aiStatus: {
      capabilityLanes: [
        { id: 'chat-fast', label: 'Chat fast' },
      ],
    },
    tuningSettings: {},
    tuningStatus: { telemetry: {} },
    runtimeState: { runs: [], activeRuns: [] },
    learningJournal: {},
    acceptance: { exists: false, report: { checks: [] } },
    benchmarks: { runs: [] },
    promotions: { candidates: [], readyCandidates: [], promotionGate: { status: 'blocked', summary: '' } },
    taskHub: { tasks: [], recipes: [], runs: [] },
    vscodeSetup: {},
    extensionHealth: {},
    integrations: {},
    modelFoundry: {},
    approvedDocsVault: { exists: false, domains: [] },
    updates: {},
    appBackups: { backups: [] },
  });

  const chatLane = report.areas.models.laneAssignments.find((lane) => lane.laneId === 'chat-fast');
  assert.equal(chatLane.role, 'engine');
  assert.equal(chatLane.modelRoleId, 'orchestrator');
});

test('buildSystemCheck ignores infrastructure bootstrap failures in roadmap validation and focus cards', () => {
  const workspaceRoot = createWorkspaceFixture();
  const acceptanceReport = {
    runId: 'engine_acceptance_pass',
    label: 'engine-acceptance',
    startedAt: '2026-03-26T20:40:00.000Z',
    completedAt: '2026-03-26T20:41:00.000Z',
    workspaceRoot,
    targetWorkspaceRoot: workspaceRoot,
    overallStatus: 'pass',
    summary: 'Acceptance passed.',
    nextAction: 'Keep the next slice bounded.',
    checks: [
      {
        id: 'tests',
        label: 'Node test suite',
        status: 'pass',
        summary: 'Tests passed.',
      },
    ],
  };

  try {
    const report = buildSystemCheck({
      workspaceRoot,
      targetWorkspaceRoot: workspaceRoot,
      now: '2026-03-26T21:00:00.000Z',
      acceptance: {
        ok: true,
        exists: true,
        outputPath: path.join(workspaceRoot, 'artifacts', 'assistant_benchmarks', 'acceptance', 'latest.json'),
        report: acceptanceReport,
        controlSummary: buildAcceptanceControlSummary(acceptanceReport, { exists: true }),
      },
      runtimeState: {
        runs: [
          {
            runId: 'bootstrap-fail',
            workspaceRoot,
            targetWorkspaceRoot: workspaceRoot,
            state: 'fail',
            task: 'Set up the workspace coding model, engine control model, and verify the route plan is ready.',
            taskMode: 'coder',
            modelRole: 'workspace',
            startedAt: '2026-03-26T20:46:55.111Z',
            endedAt: '2026-03-26T20:46:55.130Z',
            stderrTail: 'Could not start the Python runtime: spawn C:\\WINDOWS\\py.exe ENOENT',
            operatorExecution: {
              task: 'Set up the workspace coding model, engine control model, and verify the route plan is ready.',
              taskMode: 'coder',
              modelRole: 'workspace',
              outputTail: {
                stderr: 'Could not start the Python runtime: spawn C:\\WINDOWS\\py.exe ENOENT',
              },
            },
          },
          {
            runId: 'validation-pass',
            workspaceRoot,
            targetWorkspaceRoot: workspaceRoot,
            state: 'pass',
            task: 'Acceptance and review summary',
            taskMode: 'validator',
            modelRole: 'engine',
            startedAt: '2026-03-26T20:41:27.017Z',
            endedAt: '2026-03-26T20:41:27.017Z',
            operatorExecution: {
              task: 'Acceptance and review summary',
              taskMode: 'validator',
              modelRole: 'engine',
              reviewSummary: {
                requiresManualReview: false,
                pendingApprovalCount: 0,
                lowConfidencePatchCount: 0,
              },
              trustSummary: {
                trust_state: 'ready',
                summary: 'Trust is clear.',
              },
            },
          },
        ],
        activeRuns: [],
      },
      taskHub: {
        schemaVersion: '2026-03-15',
        updatedAt: '2026-03-26T20:46:56.410Z',
        goals: [
          {
            id: 'goal-bootstrap',
            title: 'Set up the workspace coding model, engine control model, and verify the route plan is ready',
            objective: 'Set up the workspace coding model, engine control model, and verify the route plan is ready.',
            status: 'active',
            workspaceRoot,
            targetWorkspaceRoot: workspaceRoot,
            updatedAt: '2026-03-26T20:46:55.118Z',
            lastRunId: 'bootstrap-fail',
          },
        ],
        tasks: [
          {
            id: 'task-bootstrap',
            goalId: 'goal-bootstrap',
            title: 'Set up the workspace coding model, engine control model, and verify the route plan is ready',
            objective: 'Set up the workspace coding model, engine control model, and verify the route plan is ready.',
            status: 'needs-repair',
            source: 'chat',
            workspaceRoot,
            targetWorkspaceRoot: workspaceRoot,
            updatedAt: '2026-03-26T20:46:55.130Z',
            lastRunId: 'bootstrap-fail',
            metadata: {
              roadmapDay: '2026-03-26',
              workspaceScopeRoot: workspaceRoot,
            },
          },
        ],
        runs: [],
        runLinks: [
          {
            runId: 'bootstrap-fail',
            taskId: 'task-bootstrap',
            goalId: 'goal-bootstrap',
            action: 'orchestrate',
            status: 'fail',
            summary: 'Could not start the Python runtime: spawn C:\\WINDOWS\\py.exe ENOENT',
          },
        ],
      },
    });

    assert.equal(report.areas.roadmap.dailyQuotaProof.focusTask, null);
    assert.equal(report.areas.roadmap.dailyQuotaProof.blockedRescopedCount, 0);
    assert.equal(report.areas.roadmap.dailyQuotaProof.validation.label, 'PASS');
    assert.equal(report.areas.roadmap.dailyQuotaProof.validation.failCount, 0);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
