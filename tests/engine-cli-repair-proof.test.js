'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  buildCliRouteProofRows,
  buildEngineModelProofViewModel,
} = require('../core/engine-model-proof');

test('repair proof pack keeps coding and repair route rows distinct', () => {
  const workspaceRoot = path.resolve('E:\\dev\\projects\\gosenderr-desktop-agent-PC');
  const rows = buildCliRouteProofRows(workspaceRoot);
  const askRow = rows.find((row) => row.label === 'Ask');
  const editRow = rows.find((row) => row.label === 'Edit');
  const repairRow = rows.find((row) => row.label === 'Repair');

  assert.equal(askRow?.modelRole, 'engine');
  assert.equal(editRow?.laneId, 'code-main');
  assert.equal(editRow?.taskMode, 'coder');
  assert.equal(editRow?.modelRole, 'workspace');
  assert.equal(repairRow?.laneId, 'repair-fast');
  assert.equal(repairRow?.taskMode, 'repair');
  assert.equal(repairRow?.modelRole, 'workspace');
  assert.match(String(repairRow?.cliCommand || ''), /engine:cli -- repair/);
});

test('repair proof pack reports a partial proof envelope when smoke is missing', () => {
  const view = buildEngineModelProofViewModel({
    pythonCommand: 'E:\\dev\\projects\\gosenderr-desktop-agent-PC\\.venv\\Scripts\\python.exe',
    acceptanceState: {
      controlSummary: {
        acceptanceStatus: 'pass',
        acceptanceLabel: 'PASS',
        smokeStatus: 'missing',
        smokeLabel: 'NOT RUN',
        nextSafeAction: 'Run acceptance with smoke coverage before using it as the next-day gate.',
      },
    },
    learningStatus: {
      reusablePrompts: [
        {
          prompt: 'Repair the latest failed bounded run and rerun the smallest relevant validation.',
          surfaces: ['engine-cli'],
        },
      ],
      operatorSupervision: {
        count: 0,
      },
    },
    routeProofRows: [
      {
        label: 'Edit',
        modelDisplayName: 'GS-Dev-1 Default',
      },
      {
        label: 'Repair',
        modelDisplayName: 'GS-Dev-1 Default',
      },
    ],
  });

  assert.equal(view.capabilityState, 'candidate');
  assert.equal(view.capabilityLabel, 'CANDIDATE-ONLY');
  assert.equal(view.label, 'PARTIAL');
  assert.match(view.summary, /smoke proof/i);
  assert.match(view.routeSummary, /Repair GS-Dev-1 Default/);
  assert.match(view.meta, /prompts: 1 reusable prompt via engine-cli/i);
  assert.match(view.nextAction, /smoke coverage/i);
});