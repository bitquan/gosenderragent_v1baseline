'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleAssistantChat } = require('../core/chat');

test('stop alias delegates to host stop callback', async () => {
  let called = 0;
  const reply = await handleAssistantChat('/workspace', '/stop', {
    stop: async () => {
      called += 1;
      return 'Stop signal sent to the latest active run.';
    },
  });

  assert.equal(called, 1);
  assert.equal(reply, 'Stop signal sent to the latest active run.');
});

test('newline-delimited slash commands are processed sequentially', async () => {
  const seen = [];
  const reply = await handleAssistantChat('/workspace', '/next\n/files', {
    next: async () => {
      seen.push('next');
      return 'Next TODO: BAT<179>';
    },
    files: async () => {
      seen.push('files');
      return 'Repository clean.';
    },
  });

  assert.deepEqual(seen, ['next', 'files']);
  assert.equal(reply, 'Next TODO: BAT<179> Repository clean.');
});

test('plan slash command delegates to host plan callback', async () => {
  const seen = [];
  const reply = await handleAssistantChat('/workspace', '/plan 176', {
    planTicket: async ({ ticket }) => {
      seen.push(ticket);
      return { ok: true };
    },
  });

  assert.deepEqual(seen, ['176']);
  assert.equal(reply, 'Started plan for BAT<176>.');
});

test('implement planned delegates to host promotion callback', async () => {
  let called = 0;
  const reply = await handleAssistantChat('/workspace', '/implement planned', {
    implementPlanned: async () => {
      called += 1;
      return 'Started implement for planned BAT<176>.';
    },
  });

  assert.equal(called, 1);
  assert.equal(reply, 'Started implement for planned BAT<176>.');
});

test('self-improve command delegates to host self-improve callback', async () => {
  let called = 0;
  const reply = await handleAssistantChat('/workspace', '/self-improve', {
    runSelfImprove: async () => {
      called += 1;
      return 'Started self-improve run (agent_123).';
    },
  });

  assert.equal(called, 1);
  assert.equal(reply, 'Started self-improve run (agent_123).');
});

test('health command delegates to manager status callback', async () => {
  let called = 0;
  const reply = await handleAssistantChat('/workspace', '/health', {
    getManagerStatus: async () => {
      called += 1;
      return 'Manager health: runtime idle • scheduler off • approvals 0.';
    },
  });

  assert.equal(called, 1);
  assert.equal(reply, 'Manager health: runtime idle • scheduler off • approvals 0.');
});

test('approve command delegates to approval callback', async () => {
  let called = 0;
  const reply = await handleAssistantChat('/workspace', '/approve', {
    approveSelection: async () => {
      called += 1;
      return 'approved backend/app/api/jobs.py';
    },
  });

  assert.equal(called, 1);
  assert.equal(reply, 'approved backend/app/api/jobs.py');
});

test('approve command can target a BAT ticket from chat', async () => {
  let received = null;
  const reply = await handleAssistantChat('/workspace', '/approve BAT<500>', {
    approveSelection: async (_workspaceRoot, target) => {
      received = target;
      return 'approved docs/BAT_FEATURE_BOARD.md';
    },
  });

  assert.deepEqual(received, { ticket: '500' });
  assert.equal(reply, 'approved docs/BAT_FEATURE_BOARD.md');
});

test('approval queue command summarizes pending items', async () => {
  const reply = await handleAssistantChat('/workspace', '/approvals', {
    getApprovalQueue: async () => ([
      { path: 'backend/app/api/jobs.py', line: 17, status: 'pending' },
      { path: 'backend/tests/test_jobs.py', line: 4, status: 'deferred' },
    ]),
  });

  assert.equal(reply, 'Approval queue: 2 item(s). backend/app/api/jobs.py:17 (pending); backend/tests/test_jobs.py:4 (deferred)');
});

test('app update check delegates to binary update callback', async () => {
  let called = 0;
  const reply = await handleAssistantChat('/workspace', '/app update check', {
    checkBinaryUpdate: async () => {
      called += 1;
      return { message: 'Desktop release 0.1.4 is available.' };
    },
  });

  assert.equal(called, 1);
  assert.equal(reply, 'Desktop release 0.1.4 is available.');
});

test('install app update can check, download, and install when needed', async () => {
  const seen = [];
  const reply = await handleAssistantChat('/workspace', 'install the app update', {
    getBinaryUpdateStatus: async () => ({ state: 'ready', downloaded: false }),
    checkBinaryUpdate: async () => {
      seen.push('check');
      return { state: 'available', downloaded: false, message: 'Desktop release 0.1.4 is available.' };
    },
    downloadBinaryUpdate: async () => {
      seen.push('download');
      return { state: 'downloaded', downloaded: true, message: 'Desktop release 0.1.4 downloaded. Install when ready.' };
    },
    installBinaryUpdate: async () => {
      seen.push('install');
      return { message: 'Restarting to install desktop release.' };
    },
  });

  assert.deepEqual(seen, ['check', 'download', 'install']);
  assert.equal(reply, 'Restarting to install desktop release.');
});

test('free-form ai prompt includes recent history and desktop context', async () => {
  let receivedPrompt = '';
  const reply = await handleAssistantChat('/workspace', 'Can you help me fix this?', {
    hasAiKey: async () => true,
    getSummary: async () => ({ total: 3, todo: 1, done: 2, tested: 1 }),
    runAi: async (_workspaceRoot, prompt) => {
      receivedPrompt = prompt;
      return 'Yes — start with the focused file and latest diff.';
    },
    chatHistory: [
      { role: 'user', text: 'Plan BAT<176>' },
      { role: 'assistant', text: 'Started plan for BAT<176>.' },
    ],
    chatContext: {
      activeFile: 'main.js',
      selectionLine: 2317,
      changedFiles: 4,
      approvalCount: 1,
      activeRunLabel: 'Implement BAT<176>',
      activeRunId: 'run-176',
      worktree: 'desktop-agent',
      openFiles: ['main.js', 'renderer/app.js'],
      recentWorkSummary: 'Implement BAT<176> • status fail • lane Code main • model Workspace Coding Model • last worked 2026-03-16T12:34:56.000Z • files main.js, renderer/app.js',
      recentWorkWorkedAt: '2026-03-16T12:34:56.000Z',
      recentWorkFiles: ['main.js', 'renderer/app.js'],
      surroundingSnippet: 'function latestFix() {\n  return true;\n}',
      currentFileDiff: '@@ -1,2 +1,2 @@\n-function latestFix() {\n+function latestFixImproved() {',
    },
    helpText: 'Try: /plan 176, /app update check.',
  });

  assert.equal(reply, 'Yes — start with the focused file and latest diff.');
  assert.match(receivedPrompt, /Recent conversation:/);
  assert.match(receivedPrompt, /User: Plan BAT<176>/);
  assert.match(receivedPrompt, /Assistant: Started plan for BAT<176>\./);
  assert.match(receivedPrompt, /Active file: main\.js:2317/);
  assert.match(receivedPrompt, /Selected run: Implement BAT<176> .* run-176/);
  assert.match(receivedPrompt, /Changed files: 4/);
  assert.match(receivedPrompt, /Pending approvals: 1/);
  assert.match(receivedPrompt, /Recent work: Implement BAT<176>/);
  assert.match(receivedPrompt, /Recent work timestamp: 2026-03-16T12:34:56.000Z/);
  assert.match(receivedPrompt, /Recent work files: main\.js, renderer\/app\.js/);
  assert.match(receivedPrompt, /Open files: main\.js, renderer\/app\.js/);
  assert.match(receivedPrompt, /Nearby code:/);
  assert.match(receivedPrompt, /Current file diff:/);
  assert.match(receivedPrompt, /User message: Can you help me fix this\?/);
});

test('free-form ai prompt includes learned guidance and custom instructions when present', async () => {
  let receivedPrompt = '';
  const reply = await handleAssistantChat('/workspace', 'Help me improve this flow.', {
    hasAiKey: async () => true,
    getSummary: async () => ({ total: 1, todo: 1, done: 0, tested: 0 }),
    runAi: async (_workspaceRoot, prompt) => {
      receivedPrompt = prompt;
      return 'Start with the smallest reusable slice.';
    },
    chatContext: {
      activeView: 'workbench',
      chatGuidance: {
        mode: 'custom',
        customInstructions: 'Prefer reusable slices and explain risky changes briefly.',
        autoInstructions: 'Prefer implement and refine style task phrasing.',
        reusablePrompts: [
          { prompt: 'Plan the next safe coding task.' },
          { prompt: 'Repair the latest failed run and summarize the fix.' },
        ],
        supervisionSignals: [
          { verdict: 'needs-changes', note: 'Tighten the layout spacing and rerun smoke before approval.' },
        ],
      },
    },
  });

  assert.equal(reply, 'Start with the smallest reusable slice.');
  assert.match(receivedPrompt, /Custom instructions: Prefer reusable slices and explain risky changes briefly\./);
  assert.match(receivedPrompt, /Learned guidance: Prefer implement and refine style task phrasing\./);
  assert.match(receivedPrompt, /Reusable prompts: Plan the next safe coding task\./);
  assert.match(receivedPrompt, /Operator supervision: needs-changes: Tighten the layout spacing and rerun smoke before approval\./);
  assert.match(receivedPrompt, /Active desktop view: workbench/);
});

test('free-form ai prompt includes recommended docs guidance when present', async () => {
  let receivedPrompt = '';
  const reply = await handleAssistantChat('/workspace', 'Help me wire the VS Code extension settings.', {
    hasAiKey: async () => true,
    getSummary: async () => ({ total: 1, todo: 1, done: 0, tested: 0 }),
    runAi: async (_workspaceRoot, prompt) => {
      receivedPrompt = prompt;
      return 'Start with the trusted extension docs and keep the slice bounded.';
    },
    chatContext: {
      activeFile: 'src/extension.ts',
      activeView: 'workbench',
      chatGuidance: {
        mode: 'auto',
        autoInstructions: 'Prefer docs-guided changes when the slice is editor-sensitive.',
        recommendedSources: [
          { label: 'VS Code', domain: 'code.visualstudio.com' },
          { label: 'Node.js', domain: 'nodejs.org' },
        ],
        docsRecommendedAction: 'Capture a trusted docs source before promoting extension changes.',
        modelProvisioningSummary: 'Workspace role expects Ollama, but no ready local model is available yet.',
        modelProvisioningAction: 'Import or select a ready Ollama model before asking for local coding work.',
      },
      modelProvisioning: {
        status: 'fail',
        summary: 'Workspace role expects Ollama, but no ready local model is available yet.',
        recommendedAction: 'Import or select a ready Ollama model before asking for local coding work.',
      },
    },
  });

  assert.equal(reply, 'Start with the trusted extension docs and keep the slice bounded.');
  assert.match(receivedPrompt, /Recommended docs: VS Code \(code\.visualstudio\.com\) \| Node\.js \(nodejs\.org\)/);
  assert.match(receivedPrompt, /Docs follow-up: Capture a trusted docs source before promoting extension changes\./);
  assert.match(receivedPrompt, /Model provisioning: Workspace role expects Ollama, but no ready local model is available yet\./);
  assert.match(receivedPrompt, /Model route next step: Import or select a ready Ollama model before asking for local coding work\./);
});

test('free-form ai prompt keeps the default voice human-first and includes chat mode context', async () => {
  let receivedPrompt = '';
  const reply = await handleAssistantChat('/workspace', 'Can you help me think through the next step?', {
    hasAiKey: async () => true,
    getSummary: async () => ({ total: 2, todo: 1, done: 1, tested: 1 }),
    runAi: async (_workspaceRoot, prompt) => {
      receivedPrompt = prompt;
      return 'Yes. Start with the smallest safe check, then we can decide whether this needs a wider fix.';
    },
    chatContext: {
      activeView: 'workbench',
      chatMode: 'ask',
      suggestedTaskMode: 'chat-fast',
      suggestedLaneId: 'chat-fast',
      modeAllowsExecution: false,
      modeRequiresEditConfirmation: false,
      chatGuidance: {
        chatMode: 'ask',
        modeLabel: 'Ask',
      },
    },
  });

  assert.equal(reply, 'Yes. Start with the smallest safe check, then we can decide whether this needs a wider fix.');
  assert.match(receivedPrompt, /warm, capable pair-programming partner/i);
  assert.match(receivedPrompt, /Answer the way a strong human collaborator would/i);
  assert.match(receivedPrompt, /Prefer short paragraphs by default/i);
  assert.match(receivedPrompt, /Chat mode: ask/i);
  assert.match(receivedPrompt, /Mode route: chat-fast/i);
  assert.match(receivedPrompt, /Execution: stay conversational unless the operator explicitly switches to an execution-capable mode\./i);
});
