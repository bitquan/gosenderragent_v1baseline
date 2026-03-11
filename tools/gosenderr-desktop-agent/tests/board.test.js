'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseAssistantRuns, parseBatBoard } = require('../core/board');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-board-'));
  fs.mkdirSync(path.join(root, 'docs', 'assistant_runs'), { recursive: true });
  return root;
}

test('parseAssistantRuns hides artifacts for BATs already marked DONE', () => {
  const workspaceRoot = makeWorkspace();
  try {
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'BAT_FEATURE_BOARD.md'),
      [
        '- `BAT<230>` [DONE][TESTED][BE][P1] Already complete.',
        '- `BAT<179>` [TODO][BE][P1][UNTESTED] Still active.',
        '',
      ].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'BAT230_implement.json'),
      JSON.stringify({ ticket: '230', command: 'implement', all_checks_passed: true, generated_at: '2026-03-11T21:00:00Z' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'BAT179_implement.json'),
      JSON.stringify({ ticket: '179', command: 'implement', all_checks_passed: true, generated_at: '2026-03-11T21:01:00Z' }),
      'utf8',
    );

    const runs = parseAssistantRuns(workspaceRoot, { limit: 10 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].ticket, '179');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('parseAssistantRuns keeps only the newest artifact per ticket and command', () => {
  const workspaceRoot = makeWorkspace();
  try {
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'BAT_FEATURE_BOARD.md'),
      '- `BAT<179>` [TODO][BE][P1][UNTESTED] Still active.\n',
      'utf8',
    );

    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'BAT179_run.json'),
      JSON.stringify({ ticket: '179', command: 'run', all_checks_passed: true, generated_at: '2026-03-11T21:00:00Z' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'BAT179_run_older.json'),
      JSON.stringify({ ticket: '179', command: 'run', all_checks_passed: false, generated_at: '2026-03-11T20:00:00Z' }),
      'utf8',
    );

    const runs = parseAssistantRuns(workspaceRoot, { limit: 10 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].ticket, '179');
    assert.equal(runs[0].command, 'run');
    assert.equal(runs[0].pass, true);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('parseBatBoard keeps the first BAT occurrence when duplicate ids exist', () => {
  const workspaceRoot = makeWorkspace();
  try {
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'BAT_FEATURE_BOARD.md'),
      [
        '- `BAT<230>` [TODO][CI][P1] Current active ticket.',
        '- `BAT<230>` [DONE][FE][P1][TESTED] Stale duplicate ticket.',
        '',
      ].join('\n'),
      'utf8',
    );

    const bats = parseBatBoard(workspaceRoot);
    assert.equal(bats.length, 1);
    assert.equal(bats[0].ticket, '230');
    assert.match(bats[0].desc, /Current active ticket/);
    assert.equal(bats[0].status, 'TODO');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
