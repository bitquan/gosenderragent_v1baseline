// Shared chat command parser for both VS Code sidebar and desktop agent

function _normalizeTicket(text) {
  const m = String(text || '').match(/BAT<(\d+)>/i) || String(text || '').match(/\b(\d+)\b/);
  return m ? m[1] : '';
}

async function parseAndExecute(rawInput, helpers) {
  // helpers should implement:
  // runTicket(ticket, options) -> string or Promise<string>
  // batchRun() -> string or Promise<string>
  // batchImplement() -> string or Promise<string>
  // status() -> string or Promise<string>
  // cancel(runId) -> string or Promise<string> (optional)
  // next() -> string or Promise<string>
  // repair() -> string or Promise<string>
  // files() -> string or Promise<string>
  // auditToggle() -> string or Promise<string>

  const input = String(rawInput || '').trim();
  if (!input) return '';

  // support simple chaining with "and"
  if (/\band\b/i.test(input)) {
    const parts = input.split(/\band\b/i).map((p) => p.trim()).filter(Boolean);
    let result = '';
    for (const part of parts) {
      const r = await parseAndExecute(part, helpers);
      if (r) {
        result += (result ? ' ' : '') + r;
      }
    }
    return result || '';
  }

  const lower = input.toLowerCase();
  const ticket = _normalizeTicket(input);

  if (/run next 5 todo|batch run/i.test(lower)) {
    return await helpers.batchRun();
  }
  if (/implement next 3 be|batch implement/i.test(lower)) {
    return await helpers.batchImplement();
  }
  if (/^\/next\b|next task/i.test(lower)) {
    if (typeof helpers.next === 'function') {
      return await helpers.next();
    }
    return 'Next‑task recommender not available.';
  }
  if (/^\/repair\b|repair last/i.test(lower)) {
    if (typeof helpers.repair === 'function') {
      return await helpers.repair();
    }
    return 'Repair action not available.';
  }
  if (/^\/files\b|changed files|validation/i.test(lower)) {
    if (typeof helpers.files === 'function') {
      return await helpers.files();
    }
    return 'File summary not available.';
  }
  if (/^\/audit\b|enforce audit/i.test(lower)) {
    const parts = lower.split(/\s+/);
    if (parts.length > 1 && typeof helpers.auditMark === 'function') {
      // user requested to mark a specific ticket as audited
      return await helpers.auditMark(parts[1]);
    }
    if (typeof helpers.auditToggle === 'function') {
      return await helpers.auditToggle();
    }
    return 'Audit toggle not available.';
  }
  if (ticket && /implement/.test(lower)) {
    return await helpers.runTicket(ticket, { implement: true });
  }
  if (ticket && /run|scaffold|start/.test(lower)) {
    return await helpers.runTicket(ticket, { implement: false });
  }
  if (/status|summary|health/.test(lower)) {
    return await helpers.status();
  }
  if (/^\/test\b|run tests/i.test(lower)) {
    if (typeof helpers.runTests === 'function') {
      return await helpers.runTests();
    }
    return 'Test helper not available.';
  }
  if (/^\/open\b/i.test(lower)) {
    const parts = input.split(/\s+/, 2);
    const pathArg = parts[1] || '';
    if (typeof helpers.openFile === 'function') {
      return await helpers.openFile(pathArg);
    }
    return 'Open-file helper not available.';
  }
  if (/^\/search\b/i.test(lower) || /search repo/i.test(lower)) {
    const parts = input.split(/\s+/, 2);
    const term = parts[1] || '';
    if (typeof helpers.search === 'function') {
      return await helpers.search(term);
    }
    return 'Search helper not available.';
  }
  if (/^\/runbat\b/i.test(lower)) {
    const parts = input.split(/\s+/, 2);
    const id = parts[1] || '';
    if (typeof helpers.runBat === 'function') {
      return await helpers.runBat(id);
    }
    return 'RunBAT helper not available.';
  }
  if (/^\/open-pr\b/i.test(lower)) {
    const parts = input.split(/\s+/, 2);
    const num = parts[1] || '';
    if (typeof helpers.openPR === 'function') {
      return await helpers.openPR(num);
    }
    return 'OpenPR helper not available.';
  }
  if (/help|what can you do|commands/.test(lower)) {
    return 'Try: "/run 176", "/implement 176", "/batch run", "/batch implement", "/next", "/repair", "/files", "/test", "/open <path>", "/runbat <id>", "/open-pr <num>" or "/search <term>".';
  }
  // no built-in command matched
  return null;
}

module.exports = {
  parseAndExecute,
  _normalizeTicket,
};
