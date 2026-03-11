'use strict';

const fs = require('fs');
const path = require('path');

const BAT_BOARD_ITEM_RE = /^- `BAT<(\d+)>`\s+(.+)$/;

function parseBatBoard(workspaceRoot) {
  if (!workspaceRoot) {
    return [];
  }
  const boardPath = path.join(workspaceRoot, 'docs', 'BAT_FEATURE_BOARD.md');
  if (!fs.existsSync(boardPath)) {
    return [];
  }

  const lines = fs.readFileSync(boardPath, 'utf8').split(/\r?\n/);
  const out = [];

  for (const line of lines) {
    const match = line.match(BAT_BOARD_ITEM_RE);
    if (!match) {
      continue;
    }
    const ticket = match[1];
    if (out.some((item) => item.ticket === ticket)) {
      continue;
    }
    const desc = match[2].trim();
    const tags = Array.from(desc.matchAll(/\[([^\]]+)\]/g)).map((entry) => String(entry[1]).toUpperCase());
    // extract structured fields from tags
    let risk = null;
    const deps = [];
    tags.forEach((t) => {
      if (t.startsWith('RISK:')) {
        risk = t.split(':')[1].toLowerCase();
      }
      if (t.startsWith('DEP:')) {
        deps.push(t.split(':')[1]);
      }
    });
    out.push({
      ticket,
      desc,
      tags,
      status: tags[0] || 'UNKNOWN',
      risk,
      deps,
    });
  }

  return out;
}

function summarizeBats(items) {
  const summary = {
    total: 0,
    todo: 0,
    done: 0,
    tested: 0,
  };

  for (const item of items || []) {
    summary.total += 1;
    const status = String(item.status || '');
    if (status.includes('TODO')) {
      summary.todo += 1;
    }
    if (status.includes('DONE')) {
      summary.done += 1;
    }
    if ((item.tags || []).includes('TESTED')) {
      summary.tested += 1;
    }
  }

  return summary;
}

function parseAssistantRuns(workspaceRoot, { limit = 30 } = {}) {
  if (!workspaceRoot) {
    return [];
  }
  const runsDir = path.join(workspaceRoot, 'docs', 'assistant_runs');
  if (!fs.existsSync(runsDir)) {
    return [];
  }

  const files = fs
    .readdirSync(runsDir)
    .filter((name) => name.endsWith('.json'))
    .filter((name) => name.includes('_run') || name.includes('_implement'));

  const boardStatusByTicket = new Map(parseBatBoard(workspaceRoot).map((item) => [String(item.ticket), String(item.status || '')]));

  const runs = [];
  for (const name of files) {
    const fullPath = path.join(runsDir, name);
    try {
      const payload = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const ticketFromName = name.match(/BAT(\d+)_/)?.[1] || '';
      const ticket = String(payload.ticket || ticketFromName || '');
      const command = payload.command || (name.includes('_implement') ? 'implement' : 'run');
      const pass = payload.all_checks_passed !== false;
      const createdCount = Array.isArray(payload.created_files) ? payload.created_files.length : 0;
      const checkCount = Array.isArray(payload.checks) ? payload.checks.length : 0;
      const generatedAt = payload.generated_at || new Date(fs.statSync(fullPath).mtimeMs).toISOString();
      const boardStatus = boardStatusByTicket.get(ticket) || '';
      runs.push({
        ticket,
        command,
        pass,
        createdCount,
        checkCount,
        generatedAt,
        profile: payload.profile || 'n/a',
        path: fullPath,
        boardStatus,
      });
    } catch (_err) {
      // ignore malformed files
    }
  }

  runs.sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
  const out = [];
  const seen = new Set();
  for (const run of runs) {
    if (run.ticket && run.boardStatus.includes('DONE')) {
      continue;
    }
    const dedupeKey = run.ticket ? `${run.ticket}:${run.command}` : `${run.path}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    out.push(run);
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

module.exports = {
  parseBatBoard,
  summarizeBats,
  parseAssistantRuns,
};
