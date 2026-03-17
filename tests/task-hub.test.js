'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getAssistantRunsDir } = require('../core/assistant-paths');

const {
  buildDailyTaskSummary,
  completeTaskRun,
  createGoalAndTask,
  createTask,
  findTask,
  listGoals,
  listRuns,
  listTasks,
  readHub,
  recordTaskRun,
  summarizeSelfHostExpansion,
  updateTask,
} = require('../core/task-hub');

function makeWorkspace() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-agent-task-hub-'));
  const artifactsRoot = path.join(workspaceRoot, 'artifacts');
  fs.mkdirSync(artifactsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, 'dev_assistant.local.yaml'),
    `assistant_artifacts_root: ${artifactsRoot}\nassistant_runs_dir: ${path.join(artifactsRoot, 'assistant_runs')}\n`,
    'utf8',
  );
  fs.mkdirSync(path.join(workspaceRoot, 'docs'), { recursive: true });
  return workspaceRoot;
}

test('task hub creates linked goals and tasks for chat prompts', () => {
  const workspaceRoot = makeWorkspace();

  try {
    const result = createGoalAndTask(workspaceRoot, {
      source: 'chat',
      objective: 'Review the current repo and tell me what needs fixing first.',
      targetWorkspaceRoot: workspaceRoot,
      threadId: 'thread_1',
      changeSessionId: 'session_1',
    });

    assert.equal(result.ok, true);
    assert.equal(result.goal.source, 'chat');
    assert.equal(result.task.goalId, result.goal.id);
    assert.deepEqual(result.task.capabilities.includes('plan-reasoning'), true);
    assert.deepEqual(result.task.capabilities.includes('review-verify'), true);
    assert.equal(result.task.metadata.requestedModelRole, 'engine');
    assert.ok(['planner', 'validator', 'summarizer'].includes(result.task.metadata.taskMode));
    assert.ok(['plan-reasoning', 'review-verify', 'ops-summary'].includes(result.task.metadata.routeLaneId));
    assert.equal(result.task.metadata.workspaceScopeRoot, workspaceRoot);

    const goals = listGoals(workspaceRoot);
    const tasks = listTasks(workspaceRoot);
    assert.equal(goals.count, 1);
    assert.equal(tasks.count, 1);
    assert.equal(tasks.tasks[0].id, result.task.id);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('task hub exposes built-in recipes and aliases runLinks as runs when reading the hub', () => {
  const workspaceRoot = makeWorkspace();

  try {
    const created = createTask(workspaceRoot, {
      source: 'chat',
      objective: 'Review the next safe builder workflow.',
      targetWorkspaceRoot: workspaceRoot,
    });
    recordTaskRun(workspaceRoot, {
      taskId: created.task.id,
      goalId: created.task.goalId,
      runId: 'agent_recipe_alias_1',
      action: 'orchestrate',
      status: 'pass',
      targetWorkspaceRoot: workspaceRoot,
    });

    const hubPath = path.join(getAssistantRunsDir(workspaceRoot), 'task-hub.json');
    const stored = JSON.parse(fs.readFileSync(hubPath, 'utf8'));
    fs.writeFileSync(hubPath, `${JSON.stringify({ ...stored, recipes: [] }, null, 2)}\n`, 'utf8');

    const hub = readHub(workspaceRoot);

    assert.equal(Array.isArray(hub.recipes), true);
    assert.equal(hub.recipes.some((recipe) => recipe.id === 'self-host'), true);
    assert.equal(Array.isArray(hub.runs), true);
    assert.equal(hub.runs.some((run) => run.runId === 'agent_recipe_alias_1'), true);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('task hub run links merge runtime status into listRuns output', () => {
  const workspaceRoot = makeWorkspace();

  try {
    const { goal, task } = createGoalAndTask(workspaceRoot, {
      source: 'chat',
      objective: 'Fix the latest failing run and summarize the repair.',
      targetWorkspaceRoot: workspaceRoot,
    });
    recordTaskRun(workspaceRoot, {
      taskId: task.id,
      goalId: goal.id,
      runId: 'agent_123',
      action: 'orchestrate',
      status: 'running',
      targetWorkspaceRoot: workspaceRoot,
    });

    const runs = listRuns(workspaceRoot, {}, {
      latest: [
        {
          runId: 'agent_123',
          state: 'pass',
          label: 'Task: Fix the latest failing run',
          blockedReason: '',
          artifactPaths: ['/tmp/result.json'],
        },
      ],
    });

    assert.equal(runs.count, 1);
    assert.equal(runs.runs[0].runId, 'agent_123');
    assert.equal(runs.runs[0].runtimeState, 'pass');
    assert.deepEqual(runs.runs[0].artifactPaths, ['/tmp/result.json']);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('task hub exposes engine BAT backlog items as compatibility tasks without replacing normal tasks', () => {
  const workspaceRoot = makeWorkspace();

  try {
    fs.writeFileSync(path.join(workspaceRoot, 'docs', 'BAT_FEATURE_BOARD.md'), [
      '- `BAT<176>` Harden the engine routing fallback [TODO] [RISK:medium]',
      '- `BAT<177>` Clean finished BAT rows [DONE]',
    ].join('\n'), 'utf8');

    const compatGoals = listGoals(workspaceRoot);
    const compatTasks = listTasks(workspaceRoot);
    const compatTask = findTask(workspaceRoot, 'task_engine_bat_176');

    assert.equal(compatGoals.goals.some((goal) => goal.source === 'bat-board'), true);
    assert.equal(compatTasks.tasks.some((task) => task.id === 'task_engine_bat_176'), true);
    assert.equal(compatTasks.tasks.some((task) => task.id === 'task_engine_bat_177'), false);
    assert.equal(compatTask?.metadata?.batTicket, '176');
    assert.equal(compatTask?.metadata?.defaultAction, 'run');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('task hub creates screenshot-aware slices without treating reference images as editable targets', () => {
  const workspaceRoot = makeWorkspace();

  try {
    const result = createGoalAndTask(workspaceRoot, {
      source: 'chat',
      objective: 'Implement the next settings screen slice from this screenshot.',
      targetWorkspaceRoot: workspaceRoot,
      targetPaths: ['renderer-src/main.tsx', 'renderer-src/styles.css'],
      metadata: {
        attachments: [
          {
            id: 'attachment_1',
            kind: 'image',
            name: 'settings-reference.png',
            path: '/tmp/settings-reference.png',
            mimeType: 'image/png',
            width: 1440,
            height: 900,
          },
        ],
        trustedDocs: [
          {
            url: 'https://code.visualstudio.com/api',
            title: 'VS Code API',
            domain: 'code.visualstudio.com',
          },
        ],
      },
    });

    assert.equal(result.task.title.includes('(from screenshot)'), true);
    assert.deepEqual(result.task.sliceTargetPaths, ['renderer-src/main.tsx', 'renderer-src/styles.css']);
    assert.equal(result.task.sliceTargetPaths.includes('/tmp/settings-reference.png'), false);
    assert.equal(result.task.slices.length, 3);
    assert.equal(result.task.slices[0].kind, 'analyze-reference');
    assert.equal(result.task.slices[1].kind, 'implement-screen-slice');
    assert.equal(result.task.slices[2].kind, 'validate-visual-slice');
    assert.equal(result.task.slices[0].referenceAttachments.length, 1);
    assert.equal(result.task.slices[0].referenceAttachments[0].name, 'settings-reference.png');
    assert.equal(result.task.slices[0].trustedDocs[0].url, 'https://code.visualstudio.com/api');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('task hub carries trusted docs through standard bounded slices', () => {
  const workspaceRoot = makeWorkspace();

  try {
    const result = createGoalAndTask(workspaceRoot, {
      source: 'chat',
      objective: 'Research the Python packaging docs and prepare the safest setup task.',
      targetWorkspaceRoot: workspaceRoot,
      metadata: {
        trustedDocs: [
          {
            url: 'https://docs.python.org/3/installing/index.html',
            title: 'Installing Python Modules',
            domain: 'docs.python.org',
          },
        ],
      },
    });

    assert.equal(result.task.slices[0].kind, 'scope');
    assert.equal(result.task.slices[result.task.slices.length - 1].kind, 'validate');
    assert.equal(result.task.slices[0].trustedDocs[0].title, 'Installing Python Modules');
    assert.equal(result.task.slices[0].referenceAttachments.length, 0);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('task hub adds docs-companion acceptance checks for code and settings work', () => {
  const workspaceRoot = makeWorkspace();

  try {
    const result = createGoalAndTask(workspaceRoot, {
      source: 'chat',
      objective: 'Update the AI settings screen and wire in a new provider selector.',
      targetWorkspaceRoot: workspaceRoot,
    });

    assert.equal(
      result.task.acceptanceChecks.some((item) => /Update or generate operator-facing docs/i.test(String(item))),
      true,
    );
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('task hub dedupes open monitor follow-up tasks by signature', () => {
  const workspaceRoot = makeWorkspace();

  try {
    const first = createTask(workspaceRoot, {
      source: 'reviewer',
      objective: 'Refresh the trusted docs context before the next revision.',
      targetWorkspaceRoot: workspaceRoot,
      metadata: {
        followupSignature: 'monitor-followup:docs-refresh-1',
      },
    });
    const second = createTask(workspaceRoot, {
      source: 'reviewer',
      objective: 'Refresh the trusted docs context before the next revision.',
      targetWorkspaceRoot: workspaceRoot,
      metadata: {
        followupSignature: 'monitor-followup:docs-refresh-1',
      },
    });

    const tasks = listTasks(workspaceRoot, { includeCompat: false });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.deduped, true);
    assert.equal(tasks.count, 1);
    assert.equal(second.task.id, first.task.id);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('task hub updates task status and merges metadata for blocked slices', () => {
  const workspaceRoot = makeWorkspace();

  try {
    const created = createTask(workspaceRoot, {
      source: 'chat',
      objective: 'Plan the next safe coding task.',
      targetWorkspaceRoot: workspaceRoot,
      metadata: {
        followupSignature: 'daily-task:2026-03-16:planning',
      },
    });
    const updated = updateTask(workspaceRoot, {
      taskId: created.task.id,
      patch: {
        status: 'needs-rescope',
        metadata: {
          lastBlockedBy: 'model-fit',
          lastBlockedReason: 'Rescope this task before launch.',
        },
      },
    });

    assert.equal(updated.ok, true);
    assert.equal(updated.task.status, 'needs-rescope');
    assert.equal(updated.task.metadata.followupSignature, 'daily-task:2026-03-16:planning');
    assert.equal(updated.task.metadata.lastBlockedBy, 'model-fit');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('task hub summarizes today focus tasks and blocked rescope pressure without a new store', () => {
  const workspaceRoot = makeWorkspace();
  const otherWorkspaceRoot = path.join(workspaceRoot, '..', 'other-repo');

  try {
    createTask(workspaceRoot, {
      source: 'codex',
      objective: 'Finish the unified daily quota proof surface.',
      targetWorkspaceRoot: workspaceRoot,
      metadata: {
        dailyTask: true,
        roadmapMonth: 'month-1-engine-baseline',
        roadmapDay: '2026-03-16',
        followupSignature: 'daily-task:2026-03-16:quota-proof',
      },
    });
    createTask(workspaceRoot, {
      source: 'codex',
      objective: 'Do not use this foreign workspace focus task.',
      targetWorkspaceRoot: otherWorkspaceRoot,
      metadata: {
        dailyTask: true,
        roadmapMonth: 'month-1-engine-baseline',
        roadmapDay: '2026-03-16',
        followupSignature: 'daily-task:2026-03-16:foreign-focus',
      },
    });
    const blocked = createTask(workspaceRoot, {
      source: 'chat',
      objective: 'Rescope the overscoped patch task.',
      targetWorkspaceRoot: workspaceRoot,
      metadata: {
        roadmapDay: '2026-03-16',
      },
    });
    const foreignBlocked = createTask(workspaceRoot, {
      source: 'chat',
      objective: 'Rescope the foreign repo patch task.',
      targetWorkspaceRoot: otherWorkspaceRoot,
      metadata: {
        roadmapDay: '2026-03-16',
      },
    });
    updateTask(workspaceRoot, {
      taskId: blocked.task.id,
      patch: {
        status: 'needs-rescope',
        metadata: {
          lastBlockedBy: 'model-fit',
          lastBlockedReason: 'Task is above the active model envelope.',
        },
      },
    });
    updateTask(workspaceRoot, {
      taskId: foreignBlocked.task.id,
      patch: {
        status: 'needs-rescope',
        metadata: {
          lastBlockedBy: 'model-fit',
          lastBlockedReason: 'Foreign repo task should not pollute current workspace readiness.',
        },
      },
    });

    const summary = buildDailyTaskSummary({
      goals: listGoals(workspaceRoot, { includeCompat: false }).goals,
      tasks: listTasks(workspaceRoot, { includeCompat: false }).tasks,
    }, {
      now: '2026-03-16T18:00:00.000Z',
      workspaceRoot,
      targetWorkspaceRoot: workspaceRoot,
    });

    assert.equal(summary.ok, true);
    assert.equal(summary.focusTask.title, 'Finish the unified daily quota proof surface');
    assert.equal(summary.blockedRescopedCount, 1);
    assert.equal(summary.blockedRescopedTasks[0].blockedBy, 'model-fit');
    assert.match(summary.summary, /focus/i);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('task hub scopes self-host expansion progress to the current workspace', () => {
  const workspaceRoot = makeWorkspace();
  const otherWorkspaceRoot = path.join(workspaceRoot, '..', 'other-repo');

  try {
    createTask(workspaceRoot, {
      source: 'engine',
      objective: 'Run the current repo self-host expansion.',
      targetWorkspaceRoot: workspaceRoot,
      metadata: {
        roadmapDay: '2026-03-17',
        selfHostExpansion: true,
      },
    });
    createTask(workspaceRoot, {
      source: 'engine',
      objective: 'Run the foreign repo self-host expansion.',
      targetWorkspaceRoot: otherWorkspaceRoot,
      metadata: {
        roadmapDay: '2026-03-17',
        selfHostExpansion: true,
      },
    });

    const summary = summarizeSelfHostExpansion(readHub(workspaceRoot), {
      roadmapDay: '2026-03-17',
      workspaceRoot,
      targetWorkspaceRoot: workspaceRoot,
    });

    assert.equal(summary.exists, true);
    assert.equal(summary.queuedCount, 1);
    assert.equal(summary.label, 'QUEUED');
    assert.match(summary.summary, /queued but not consumed yet/i);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('task hub tracks self-host expansion usage from launched and completed runs instead of queued task existence alone', () => {
  const workspaceRoot = makeWorkspace();

  try {
    const created = createTask(workspaceRoot, {
      source: 'engine',
      objective: 'Run one extra bounded self-host follow-up.',
      targetWorkspaceRoot: workspaceRoot,
      metadata: {
        roadmapDay: '2026-03-17',
        selfHostExpansion: true,
      },
    });

    const queued = summarizeSelfHostExpansion({
      tasks: listTasks(workspaceRoot, { includeCompat: false }).tasks,
      runLinks: [],
    }, {
      roadmapDay: '2026-03-17',
    });

    assert.equal(queued.exists, true);
    assert.equal(queued.label, 'QUEUED');
    assert.equal(queued.consumedCount, 0);

    recordTaskRun(workspaceRoot, {
      taskId: created.task.id,
      runId: 'agent_self_host_1',
      action: 'orchestrate',
      status: 'running',
      targetWorkspaceRoot: workspaceRoot,
    });

    const running = summarizeSelfHostExpansion({
      tasks: listTasks(workspaceRoot, { includeCompat: false }).tasks,
      runLinks: readTaskHubRuns(workspaceRoot),
    }, {
      roadmapDay: '2026-03-17',
    });

    assert.equal(running.label, 'RUNNING');
    assert.equal(running.consumedCount, 1);
    assert.equal(running.runningCount, 1);

    const completed = completeTaskRun(workspaceRoot, {
      runId: 'agent_self_host_1',
      status: 'pass',
      summary: 'The extra self-host follow-up passed cleanly.',
      reviewSummary: {
        pendingCount: 0,
      },
    });

    assert.equal(completed.ok, true);
    assert.equal(completed.selfHostExpansion.outcome, 'pass');
    assert.match(completed.selfHostExpansion.summary, /passed cleanly/i);
    const passed = summarizeSelfHostExpansion(readHub(workspaceRoot), {
      roadmapDay: '2026-03-17',
    });
    assert.equal(passed.label, 'PASS');
    assert.equal(passed.consumedCount, 1);
    assert.match(passed.summary, /consumed successfully/i);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

function readTaskHubRuns(workspaceRoot) {
  const hub = readHub(workspaceRoot);
  return Array.isArray(hub.runLinks) ? hub.runLinks : [];
}
