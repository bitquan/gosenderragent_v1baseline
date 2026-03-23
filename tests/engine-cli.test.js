'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  buildDirectAskReply,
  buildDirectPlanReply,
  buildGroundedChatPrompt,
  buildLiveStateSummary,
  buildTerminalRequest,
  buildChatEnvOverrides,
  extractChatReply,
  parseCliArgs,
  renderGitStatus,
  renderModelLifecycleStatus,
  renderPreflight,
  renderSnapshot,
} = require('../scripts/engine-cli');

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
    },
  });

  assert.match(rendered, /Promotion policy: manual-promote/);
  assert.match(rendered, /Worker families: primary qwen \| backup deepseek-coder \| reasoning qwen3/);
  assert.match(rendered, /Checkpoint merge command:/);
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
          summary: 'Workspace model and engine model are provisioned.',
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
