'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildAuditScriptArgs,
  buildDocsAwareGroundedPrompt,
  buildDirectAskReply,
  buildDirectPlanReply,
  buildEngineModelProofMarkdown,
  buildGroundedChatPrompt,
  buildLiveStateSummary,
  buildProgressSummaryMarkdown,
  buildTerminalRequest,
  buildChatEnvOverrides,
  createCliLearningJournal,
  collectCliChangedFiles,
  extractChatReply,
  normalizeCliChatCommand,
  parseCliArgs,
  recordCliPromptStart,
  recordCliRunOutcome,
  renderFoundryProofExecution,
  renderGitStatus,
  renderModelLifecycleStatus,
  renderPreflight,
  renderSnapshot,
} = require('../scripts/engine-cli');
const { shouldUseGroundedAskReply } = require('../core/grounded-chat');
const {
  buildTrustedDocDigest,
  fetchTrustedDocDigests,
  normalizeTrustedDocSource,
  renderTrustedDocPromptBlock,
} = require('../core/trusted-docs');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cli-learning-'));
  const offloadRoot = path.join(root, 'offload');
  fs.mkdirSync(offloadRoot, { recursive: true });
  fs.writeFileSync(path.join(root, 'dev_assistant.local.yaml'), `assistant_artifacts_root: ${offloadRoot}\n`, 'utf8');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"engine-cli-learning-fixture"}\n', 'utf8');
  return { root, offloadRoot };
}

test('engine CLI parses workspace, mode, and git flags without losing trailing arguments', () => {
  const parsed = parseCliArgs([
    'git',
    '--workspace',
    'E:\\dev\\projects\\gosenderr-desktop-agent-PC',
    'commit',
    '-m',
    'feat: tighten engine contract',
  ]);

  assert.equal(parsed.command, 'git');
  assert.equal(parsed.workspaceRoot, path.resolve('E:\\dev\\projects\\gosenderr-desktop-agent-PC'));
  assert.equal(parsed.message, 'feat: tighten engine contract');
  assert.deepEqual(parsed.trailing, ['commit']);
});

test('engine CLI parses repeated validation commands for bounded repair proofs', () => {
  const parsed = parseCliArgs([
    'repair',
    '--lab',
    'E:\\dev\\projects\\gosenderr_dev_offload\\assistant_labs\\scratch\\acceptance-self-host-fresh',
    '--validation-command',
    'node --test tests/training-tuning.test.js',
    '--validation',
    'node --test tests/ai-center.test.js',
    'Repair',
    'the',
    'local',
    'readiness',
    'wording.',
  ]);

  assert.equal(parsed.command, 'repair');
  assert.deepEqual(parsed.validationCommands, [
    'node --test tests/training-tuning.test.js',
    'node --test tests/ai-center.test.js',
  ]);
  assert.deepEqual(parsed.trailing, ['Repair', 'the', 'local', 'readiness', 'wording.']);
});

test('engine CLI parses docs-aware flags and summary output path', () => {
  const parsed = parseCliArgs([
    'plan-docs',
    '--doc-source',
    'https://nodejs.org/api/fs.html',
    '--doc-url',
    'https://docs.python.org/3/library/pathlib.html',
    '--summary-path',
    'docs/LOCKED_PLAN_SUMMARY.md',
    '--title',
    'Engine CLI docs grounding',
    'Plan',
    'the',
    'next',
    'slice.',
  ]);

  assert.equal(parsed.command, 'plan-docs');
  assert.deepEqual(parsed.docSources, [
    'https://nodejs.org/api/fs.html',
    'https://docs.python.org/3/library/pathlib.html',
  ]);
  assert.equal(parsed.title, 'Engine CLI docs grounding');
  assert.match(parsed.summaryPath, /LOCKED_PLAN_SUMMARY\.md$/);
});

test('engine CLI builds the daily audit script invocation for the active workspace', () => {
  const workspaceRoot = path.resolve('E:\\dev\\projects\\gosenderr-desktop-agent-PC');
  const args = buildAuditScriptArgs(workspaceRoot, { json: true });

  assert.match(args[0], /engine_daily_report\.py$/);
  assert.deepEqual(args.slice(1), ['--project-root', workspaceRoot, '--json']);
});

test('engine CLI parses checkpoint merge arguments without dropping paths', () => {
  const parsed = parseCliArgs([
    'checkpoint-merge',
    '--workspace',
    'E:\\dev\\projects\\gosenderr-desktop-agent-PC',
    '--base-path',
    'E:\\models\\qwen-base',
    '--secondary-path',
    'E:\\models\\qwen-adapter',
    '--output-path',
    'E:\\merges\\qwen-merge',
    '--alpha',
    '0.3',
    '--method',
    'linear',
    '--dry-run',
  ]);

  assert.equal(parsed.command, 'checkpoint-merge');
  assert.equal(parsed.basePath, path.resolve('E:\\models\\qwen-base'));
  assert.equal(parsed.secondaryPath, path.resolve('E:\\models\\qwen-adapter'));
  assert.equal(parsed.outputPath, path.resolve('E:\\merges\\qwen-merge'));
  assert.equal(parsed.alpha, 0.3);
  assert.equal(parsed.method, 'linear');
  assert.equal(parsed.dryRun, true);
});

test('engine CLI parses candidate proof flags for model proof runs', () => {
  const parsed = parseCliArgs([
    'models',
    'proof',
    '--candidate-id',
    'route-bundle:qwen',
    '--capability',
    'code',
    '--capability',
    'docs-guided',
    '--all',
    '--dry-run',
  ]);

  assert.equal(parsed.command, 'models');
  assert.equal(parsed.candidateId, 'route-bundle:qwen');
  assert.deepEqual(parsed.capabilityIds, ['code', 'docs-guided']);
  assert.equal(parsed.all, true);
  assert.equal(parsed.dryRun, true);
  assert.deepEqual(parsed.trailing, ['proof']);
});

test('engine CLI builds edit requests that reuse the canonical terminal routing contract', () => {
  const workspaceRoot = path.resolve('E:\\dev\\projects\\gosenderr-desktop-agent-PC');
  const repairBuilt = buildTerminalRequest({
    command: 'edit',
    workspaceRoot,
    labRoot: '',
    prompt: 'repair the failing validation path',
  });
  const implementBuilt = buildTerminalRequest({
    command: 'edit',
    workspaceRoot,
    labRoot: '',
    prompt: 'Add a brief comment to renderer/app.js and keep behavior unchanged.',
  });

  assert.equal(repairBuilt.chatMode, 'edit');
  assert.equal(repairBuilt.request.action, 'orchestrate');
  assert.equal(repairBuilt.request.laneId, 'repair-fast');
  assert.equal(repairBuilt.request.taskMode, 'repair');
  assert.equal(repairBuilt.request.metadata.chatMode, 'edit');
  assert.equal(repairBuilt.request.metadata.modeRequiresEditConfirmation, true);
  assert.equal(repairBuilt.request.desc, 'repair the failing validation path');

  assert.equal(implementBuilt.request.laneId, 'code-main');
  assert.equal(implementBuilt.request.taskMode, 'coder');
  assert.match(String(implementBuilt.request.ticket || ''), /^9\d{9}$/);
  assert.equal(implementBuilt.request.desc, 'Add a brief comment to renderer/app.js and keep behavior unchanged.');
});

test('engine CLI forwards bounded validation commands into execution requests', () => {
  const workspaceRoot = path.resolve('E:\\dev\\projects\\gosenderr-desktop-agent-PC');
  const built = buildTerminalRequest({
    command: 'edit',
    workspaceRoot,
    labRoot: 'E:\\dev\\projects\\gosenderr_dev_offload\\assistant_labs\\scratch\\acceptance-self-host-fresh',
    prompt: 'Repair the remaining BAT<MODEL-BASE-007> wording drift in core/training-tuning.js only.',
    validationCommands: [
      'node --test tests/training-tuning.test.js',
      'node --test tests/ai-center.test.js',
    ],
  });

  assert.equal(built.request.workspace, path.resolve('E:\\dev\\projects\\gosenderr_dev_offload\\assistant_labs\\scratch\\acceptance-self-host-fresh'));
  assert.deepEqual(built.request.validationCommands, [
    'node --test tests/training-tuning.test.js',
    'node --test tests/ai-center.test.js',
  ]);
});

test('engine CLI render helpers keep status readable in the terminal', () => {
  const git = renderGitStatus({
    branch: 'main',
    upstream: 'origin/main',
    ahead: 1,
    behind: 0,
    dirty: true,
    stagedCount: 1,
    unstagedCount: 2,
    untrackedCount: 0,
    lastCommit: 'abc123 feat: baseline',
    files: [{ path: 'renderer/app.js', state: 'staged' }],
  });
  const preflight = renderPreflight({
    workspaceRoot: 'E:\\dev\\projects\\gosenderr-desktop-agent-PC',
    ready: true,
    blockingCount: 0,
    warningCount: 1,
    checks: [{ name: 'python runtime', ok: true, detail: 'C:\\Windows\\py.exe' }],
  });
  const snapshot = renderSnapshot({
    task: 'Repair the failing validation path.',
    laneLabel: 'Repair fast',
    taskMode: 'repair',
    modelRole: 'workspace',
    modelDisplayName: 'Qwen2.5 Coder 14B',
    providerSource: 'ollama',
    providerAccountability: { summary: 'planner:openai/gpt-5-mini' },
    reviewBundle: {
      decisionLabel: 'Repair required',
      reason: 'Validation failed in renderer/app.js.',
      howToFix: 'Repair the failing validation path and rerun the smallest relevant check.',
    },
    nextAction: {
      label: 'Repair loop',
      summary: 'Repair the failing validation path.',
    },
    memoryHints: {
      summary: 'Most common reject: validation failure in renderer/app.js.',
    },
  });

  assert.match(git, /Branch: main/);
  assert.match(preflight, /python runtime: ok/i);
  assert.match(snapshot, /Review: Repair required/);
  assert.match(snapshot, /Next safe action: Repair loop/);
});

test('engine CLI renders local lifecycle status for terminal model operations', () => {
  const rendered = renderModelLifecycleStatus({
    workspaceRoot: 'E:\\dev\\projects\\gosenderr-desktop-agent-PC',
    lifecycle: {
      summary: '2 ready local worker variants.',
      promotionPolicy: 'manual-promote',
      workerFamilies: {
        primary: 'qwen',
        backup: 'deepseek-coder',
        reasoningFallback: 'qwen3',
      },
      entries: [
        {
          label: 'GS-Dev-1 Workspace',
          workerFamily: 'qwen',
          workerVariantType: 'base',
          promotionReadiness: 'benchmark-ready',
        },
      ],
    },
    benchmarkLeader: {
      model: 'qwen2.5-coder:14b',
      providerSource: 'ollama',
    },
    commands: {
      checkpointMerge: 'npm run engine:cli -- checkpoint-merge --base-path "<base>" --secondary-path "<secondary>"',
      candidateProof: 'npm run engine:cli -- models proof --candidate-id "route-bundle:qwen"',
    },
  });

  assert.match(rendered, /Promotion policy: manual-promote/);
  assert.match(rendered, /Worker families: primary qwen \| backup deepseek-coder \| reasoning qwen3/);
  assert.match(rendered, /Checkpoint merge command:/);
  assert.match(rendered, /Candidate proof command:/);
});

test('engine CLI renders foundry proof execution summaries for terminal use', () => {
  const rendered = renderFoundryProofExecution({
    workspaceRoot: 'E:\\dev\\projects\\gosenderr-desktop-agent-PC',
    dryRun: false,
    candidateCount: 1,
    capabilityCount: 2,
    summary: 'Promote qwen route bundle now proves 2/2 tracked candidate capabilities.',
    results: [
      {
        candidate: {
          id: 'route-bundle:qwen',
          label: 'Promote qwen route bundle',
        },
        proof: {
          status: 'verified',
          verifiedCapabilityCount: 2,
          capabilityCount: 2,
          summary: 'Promote qwen route bundle now proves 2/2 tracked candidate capabilities.',
        },
        capabilityResults: [
          { label: 'Ask/plan', ok: true, benchmarkId: 'route-bundle-qwen-ask-plan-1' },
          { label: 'Code', ok: true, benchmarkId: 'route-bundle-qwen-code-1' },
        ],
      },
    ],
  });

  assert.match(rendered, /Promote qwen route bundle :: VERIFIED :: 2\/2 capabilities/);
  assert.match(rendered, /Ask\/plan: pass/);
  assert.match(rendered, /route-bundle-qwen-code-1/);
});

test('engine CLI render helpers surface runtime failures clearly', () => {
  const snapshot = renderSnapshot({
    task: 'Add a brief comment above describeTask.',
    laneLabel: 'Code main',
    taskMode: 'coder',
    modelRole: 'workspace',
    modelDisplayName: 'GS-Dev-1 Default',
    providerSource: 'ollama',
    failureClass: {
      summary: 'ticket id is required',
    },
  });

  assert.match(snapshot, /Failure: ticket id is required/);
});

test('engine CLI answers blocked-run questions from live repo state instead of generic speculation', () => {
  const reply = buildDirectAskReply('Why is the current run blocked?', {
    areas: {
      runs: {
        latestRun: {
          status: 'pass',
          task: 'Review the latest run and summarize any blockers.',
          reviewSummary: {
            summary: 'no manual review blockers detected',
          },
        },
      },
      roadmap: {
        recommendedNextSafeAction: 'Advance with another bounded autonomous slice at or below the current model level and keep acceptance green.',
      },
    },
  });

  assert.match(reply, /not blocked right now/i);
  assert.match(reply, /no manual review blockers detected/i);
  assert.match(reply, /next safe move/i);
});

test('grounded ask helper only triggers for explicit repo-state questions', () => {
  assert.equal(shouldUseGroundedAskReply('Why is the current run blocked?'), true);
  assert.equal(shouldUseGroundedAskReply('What is the next safe action right now?'), true);
  assert.equal(shouldUseGroundedAskReply('Can you help me think through this refactor?'), false);
  assert.equal(shouldUseGroundedAskReply('Help me draft the fix before we change anything.'), false);
});

test('engine CLI live repo summary reports canonical acceptance capability state', () => {
  const summary = buildLiveStateSummary({
    workspaceRoot: 'E:\\dev\\projects\\gosenderr-desktop-agent-PC',
    areas: {
      roadmap: {
        status: 'ready',
        summary: 'Baseline is healthy.',
        currentPhase: { label: 'Phase 5: Release, Training, And Convergence' },
      },
      acceptance: {
        status: 'pass',
        capabilityState: 'candidate',
        summary: 'Acceptance is green but the proof pack is still partial.',
      },
      trust: {
        status: 'pass',
        summary: 'Trust is clear.',
      },
      runs: {
        latestRun: {
          status: 'pass',
          task: 'Review the latest run and summarize any blockers.',
        },
      },
      models: {
        summary: 'Workspace coding and engine control roles are provisioned.',
      },
      autonomy: {
        nextSafeAction: 'Keep the next run bounded.',
      },
    },
  });

  assert.match(summary, /Acceptance: CANDIDATE-ONLY \(PASS\) \| Acceptance is green but the proof pack is still partial\./);
});

test('engine CLI builds grounded ask and plan prompts from live repo state', () => {
  const built = buildTerminalRequest({
    command: 'plan',
    workspaceRoot: path.resolve('E:\\dev\\projects\\gosenderr-desktop-agent-PC'),
    prompt: 'Plan the safest next slice for the routing drift.',
  });
  const prompt = buildGroundedChatPrompt({
    chatMode: 'plan',
    userPrompt: 'Plan the safest next slice for the routing drift.',
    built,
    report: {
      workspaceRoot: 'E:\\dev\\projects\\gosenderr-desktop-agent-PC',
      areas: {
        roadmap: {
          status: 'ready',
          summary: 'Baseline is healthy.',
          currentPhase: { label: 'Phase 5: Release, Training, And Convergence' },
          recommendedNextSafeAction: 'Advance with another bounded autonomous slice.',
        },
        acceptance: {
          status: 'pass',
          summary: 'Acceptance is green.',
        },
        trust: {
          status: 'pass',
          summary: 'Trust is clear.',
        },
        runs: {
          latestRun: {
            status: 'pass',
            task: 'Review the latest run and summarize any blockers.',
            reviewSummary: { summary: 'no manual review blockers detected' },
          },
        },
        models: {
          summary: 'Workspace coding and engine control roles are provisioned.',
        },
        autonomy: {
          nextSafeAction: 'Keep the next run bounded.',
        },
      },
    },
  });

  assert.match(prompt, /Live repo state:/);
  assert.match(prompt, /Latest run:/);
  assert.match(prompt, /Resolved route: Plan reasoning/);
  assert.match(prompt, /Give a concrete, bounded plan/i);
});

test('engine CLI can normalize docs-aware chat commands back to ask and plan', () => {
  assert.equal(normalizeCliChatCommand('ask-docs'), 'ask');
  assert.equal(normalizeCliChatCommand('plan-docs'), 'plan');
  assert.equal(normalizeCliChatCommand('plan'), 'plan');
});

test('trusted docs helper normalizes allowed sources and extracts snippet guidance', async () => {
  const source = normalizeTrustedDocSource('https://code.visualstudio.com/api/extension-guides/command');
  const html = [
    '<html><head><title>VS Code Command Guide</title></head><body>',
    '<p>Use registerCommand for command handlers. This is the recommended pattern for extension commands.</p>',
    '<p>Avoid global mutable state when a command can read from workspace state instead.</p>',
    '<pre><code>vscode.commands.registerCommand(\'demo.run\', async () => {\n  return true;\n});</code></pre>',
    '</body></html>',
  ].join('');
  const digest = buildTrustedDocDigest({ url: source.url, html });
  const fetched = await fetchTrustedDocDigests([source.url], {
    fetchImpl: async () => ({ ok: true, text: async () => html }),
  });
  const rendered = renderTrustedDocPromptBlock([digest]);

  assert.equal(source.ok, true);
  assert.equal(digest.title, 'VS Code Command Guide');
  assert.match(digest.summary, /recommended pattern/i);
  assert.match(digest.goodPatterns.join(' '), /recommended pattern/i);
  assert.match(digest.avoidPatterns.join(' '), /avoid global mutable state/i);
  assert.match(digest.snippets[0], /registerCommand/);
  assert.equal(fetched.failures.length, 0);
  assert.equal(fetched.digests.length, 1);
  assert.match(rendered, /Trusted online docs:/);
  assert.match(rendered, /Good patterns:/);
  assert.match(rendered, /Snippet 1:/);
});

test('engine CLI can append trusted docs context to grounded ask and plan prompts', () => {
  const built = buildTerminalRequest({
    command: 'plan',
    workspaceRoot: path.resolve('E:\\dev\\projects\\gosenderr-desktop-agent-PC'),
    prompt: 'Plan a safe VS Code command implementation.',
  });
  const prompt = buildDocsAwareGroundedPrompt({
    built,
    userPrompt: 'Plan a safe VS Code command implementation.',
    report: {
      workspaceRoot: built.request.workspaceRoot,
      areas: {
        roadmap: { status: 'ready', summary: 'Baseline is healthy.' },
        acceptance: { status: 'pass', summary: 'Acceptance is green.' },
        trust: { status: 'pass', summary: 'Trust is clear.' },
        runs: { latestRun: { status: 'pass', task: 'Review the latest run.' } },
      },
    },
    docDigests: [
      {
        title: 'VS Code Command Guide',
        url: 'https://code.visualstudio.com/api/extension-guides/command',
        summary: 'Use registerCommand for handlers.',
        goodPatterns: ['Use registerCommand for command handlers.'],
        avoidPatterns: ['Avoid global mutable state.'],
        snippets: ['vscode.commands.registerCommand(\'demo.run\', async () => true);'],
      },
    ],
  });

  assert.match(prompt, /Trusted online docs:/);
  assert.match(prompt, /VS Code Command Guide/);
  assert.match(prompt, /Use registerCommand/);
  assert.match(prompt, /Avoid global mutable state/);
  assert.match(prompt, /docs means trusted technical documentation/i);
  assert.match(prompt, /say that the evidence is missing instead of giving generic project-management steps/i);
});

test('engine CLI can build a locked markdown progress summary for future plans', () => {
  const markdown = buildProgressSummaryMarkdown({
    title: 'Engine CLI docs grounding',
    objective: 'Expand ask and plan with trusted online docs and locked progress tracking.',
    workspaceRoot: 'E:\\dev\\projects\\gosenderr-desktop-agent-PC',
    report: {
      areas: {
        roadmap: {
          status: 'ready',
          summary: 'Baseline is healthy.',
          recommendedNextSafeAction: 'Add the first focused proof pack.',
        },
        acceptance: {
          status: 'pass',
          summary: 'Acceptance is green.',
        },
        trust: {
          status: 'pass',
          summary: 'Trust is clear.',
        },
        runs: {
          latestRun: {
            task: 'Review the latest run and summarize any blockers.',
          },
        },
      },
    },
    docDigests: [
      {
        title: 'Node.js fs docs',
        url: 'https://nodejs.org/api/fs.html',
        summary: 'Use the synchronous API only in bounded tooling paths.',
        goodPatterns: ['Use narrow file operations.'],
        avoidPatterns: ['Avoid wide recursive writes without a bounded path.'],
      },
    ],
    updatedAt: '2026-04-01T12:00:00.000Z',
  });

  assert.match(markdown, /# Locked Plan Summary/);
  assert.match(markdown, /## Engine CLI docs grounding/);
  assert.match(markdown, /### Trusted Online Docs/);
  assert.match(markdown, /Node.js fs docs/);
  assert.match(markdown, /docs\/ENGINE_BLUEPRINT_CHECKLIST\.md/);
  assert.match(markdown, /docs\/ENGINE_MODEL_PROOF\.md/);
  assert.match(markdown, /user-driven and review-backed by default/i);
});

test('engine CLI can build a per-pass engine model proof markdown summary', () => {
  const markdown = buildEngineModelProofMarkdown({
    title: 'Routing and Python proof',
    objective: 'Show the current Python-backed engine path and routed model proof for this pass.',
    workspaceRoot: 'E:\\dev\\projects\\gosenderr-desktop-agent-PC',
    pythonCommand: 'E:\\dev\\projects\\gosenderr-desktop-agent-PC\\.venv\\Scripts\\python.exe',
    acceptanceState: {
      outputPath: 'E:\\dev\\projects\\gosenderr_dev_offload\\assistant_benchmarks\\acceptance\\latest.json',
      controlSummary: {
        acceptanceLabel: 'PASS',
        acceptanceSummary: 'Acceptance is green.',
        smokeLabel: 'PASS',
        smokeSummary: 'Smoke is green.',
        nextDayLabel: 'READY',
        nextDaySummary: 'Safe for the next bounded slice.',
        nextSafeAction: 'Advance with another bounded slice.',
        modelParity: {
          summary: 'Local and remote parity proof is recorded for the current pack.',
        },
      },
    },
    assistantConfig: {
      autonomyMode: 'safe',
      safetyLevel: 'guarded',
      humanApprovalProtectedOnly: true,
      sandboxRequired: true,
      selfImprovementOnly: false,
    },
    learningStatus: {
      journalPath: 'E:\\dev\\projects\\gosenderr_dev_offload\\assistant_learning\\journal.jsonl',
      reusablePrompts: [
        {
          prompt: 'Repair the latest failed bounded run and rerun the smallest relevant validation.',
          surfaces: ['engine-cli'],
        },
      ],
      operatorSupervision: {
        count: 3,
        summary: 'Recent operator approvals and manual edits are available.',
      },
      trainingReadiness: {
        status: 'ready',
        summary: 'Trusted learning candidates are queued for the next idle-safe window.',
      },
      gsDev1ExportReadiness: {
        status: 'ready',
        summary: 'Approved examples are ready for GS-Dev-1 export.',
      },
    },
    routeProofRows: [
      {
        label: 'Ask',
        laneLabel: 'Chat fast',
        taskMode: 'ask',
        modelRole: 'engine',
        modelDisplayName: 'GSE-1 Engine',
        providerSource: 'openai',
        cliCommand: 'npm run engine:cli -- ask "Why is the current run blocked?"',
        baseModel: 'gpt-5-mini',
        modelProfileId: 'engine-default',
      },
      {
        label: 'Repair',
        laneLabel: 'Repair fast',
        taskMode: 'repair',
        modelRole: 'workspace',
        modelDisplayName: 'Qwen2.5 Coder 7B',
        providerSource: 'ollama',
        cliCommand: 'npm run engine:cli -- repair "Repair the latest failed bounded run and rerun the smallest relevant validation."',
        baseModel: 'qwen2.5-coder:7b',
        modelProfileId: 'repair-local',
      },
    ],
    updatedAt: '2026-04-01T12:30:00.000Z',
  });

  assert.match(markdown, /# Engine Model Proof/);
  assert.match(markdown, /Python runtime: E:\\dev\\projects\\gosenderr-desktop-agent-PC\\.venv\\Scripts\\python\.exe/);
  assert.match(markdown, /Acceptance gate: PASS \| Acceptance is green\./);
  assert.match(markdown, /Ask: Chat fast \| ask \| engine role \| GSE-1 Engine via openai/);
  assert.match(markdown, /Repair: Repair fast \| repair \| workspace role \| Qwen2\.5 Coder 7B via ollama/);
  assert.match(markdown, /Reusable prompts: 1 \| Repair the latest failed bounded run and rerun the smallest relevant validation\. \(engine-cli\)/);
  assert.match(markdown, /User-driven and review-backed learning stays primary/i);
  assert.match(markdown, /integration-library\/extensions\/vscode-companion\/extension\.js/);
  assert.match(markdown, /npm run engine:cli -- proof-summary --title/);
});

test('engine CLI learning capture turns successful repair prompts into reusable prompt guidance', () => {
  const { root } = makeWorkspace();
  const service = createCliLearningJournal({
    workspaceRoot: root,
    targetWorkspaceRoot: root,
    command: 'repair',
    prompt: 'Repair renderer/app.js and rerun the UI shell test.',
  });

  try {
    const built = {
      chatMode: 'edit',
      request: {
        laneId: 'repair-fast',
        taskMode: 'repair',
      },
    };
    recordCliPromptStart(service, {
      command: 'repair',
      prompt: 'Repair renderer/app.js and rerun the UI shell test.',
      built,
    });
    recordCliRunOutcome(service, {
      command: 'repair',
      built,
      trackedRun: {
        state: 'pass',
        operatorExecution: {
          laneId: 'repair-fast',
          taskMode: 'repair',
          changedFileCount: 1,
          changedFiles: [{ path: 'renderer/app.js', status: 'modified' }],
          reviewBundle: {
            decisionLabel: 'Accepted',
          },
          nextAction: {
            label: 'Run the next bounded slice',
          },
        },
      },
    });

    const changedFiles = collectCliChangedFiles({
      changedFiles: [{ path: 'renderer/app.js', status: 'modified' }],
    });
    const status = service.getStatus();
    assert.equal(changedFiles.length, 1);
    assert.equal(status.reusablePrompts.length, 1);
    assert.equal(status.reusablePrompts[0].prompt, 'Repair renderer/app.js and rerun the UI shell test.');
    assert.deepEqual(status.reusablePrompts[0].surfaces, ['engine-cli']);
    assert.ok(status.reusablePrompts[0].trustedSignals.includes('run-complete'));
    assert.equal(status.trainingReadiness.status, 'ready');
  } finally {
    service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('engine CLI builds repo-grounded routing plans instead of generic workflow advice', () => {
  const reply = buildDirectPlanReply('Plan the safest next slice for the routing drift.', {
    areas: {
      roadmap: {
        recommendedNextSafeAction: 'Advance with another bounded autonomous slice at or below the current model level and keep acceptance green.',
      },
      acceptance: {
        summary: 'Acceptance is green.',
      },
      trust: {
        summary: 'Trust is clear.',
      },
      runs: {
        latestRun: {
          task: 'Review the latest run and summarize any blockers.',
        },
      },
    },
  });

  assert.match(reply, /shared routing source/i);
  assert.match(reply, /core\/engine-contract\.js/i);
  assert.match(reply, /engine:acceptance/i);
  assert.doesNotMatch(reply, /make test/i);
});

test('engine CLI chat env overrides pin the resolved provider and model', () => {
  const env = buildChatEnvOverrides({
    providerSource: 'openai',
    baseModel: 'gpt-5-mini',
  }, 'plan');

  assert.equal(env.AGENT_PROVIDER, 'openai');
  assert.equal(env.OPENAI_MODEL, 'gpt-5-mini');
  assert.match(env.ASSISTANT_SYSTEM_PROMPT, /scoped plans/i);
});

test('engine CLI extracts chat replies without dropping summary or message fallbacks', () => {
  assert.equal(extractChatReply({ reply: 'hello' }), 'hello');
  assert.equal(extractChatReply({ summary: 'summary text' }), 'summary text');
  assert.equal(extractChatReply({ message: 'message text' }), 'message text');
});
