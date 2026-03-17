'use strict';

const fs = require('fs');
const path = require('path');

function configPathForWorkspace(workspaceRoot) {
  return path.join(workspaceRoot, 'dev_assistant.yaml');
}

function parseBool(value, fallback = true) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (['true', 'yes', 'on', '1'].includes(raw)) {
    return true;
  }
  if (['false', 'no', 'off', '0'].includes(raw)) {
    return false;
  }
  return fallback;
}

function stripQuotes(value) {
  const raw = String(value || '').trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

const AUTOPILOT_DEFAULTS = {
  selfImprove: true,
  action: 'implement',
  count: 1,
  status: 'TODO',
  profile: 'aiWrite',
  template: 'auto',
  requireTag: '',
  requireText: '',
  preferDomain: '',
  intervalSeconds: 0,
  cooldownMinutes: 30,
  failureBlockMinutes: 180,
  brainstorm: false,
  fullVerify: false,
  skipVerify: false,
  skipPreflight: false,
  fixLoop: true,
  continueOnFail: true,
  synthesizeFollowups: true,
  skipLearn: false,
  notifySummary: true,
};

const AUTOPILOT_KEY_MAP = {
  selfImprove: 'autopilot_self_improve',
  action: 'autopilot_action',
  count: 'autopilot_count',
  status: 'autopilot_status',
  profile: 'autopilot_profile',
  template: 'autopilot_template',
  requireTag: 'autopilot_require_tag',
  requireText: 'autopilot_require_text',
  preferDomain: 'autopilot_prefer_domain',
  intervalSeconds: 'autopilot_interval_seconds',
  cooldownMinutes: 'autopilot_ticket_cooldown_minutes',
  failureBlockMinutes: 'autopilot_failure_block_minutes',
  brainstorm: 'autopilot_brainstorm',
  fullVerify: 'autopilot_full_verify',
  skipVerify: 'autopilot_skip_verify',
  skipPreflight: 'autopilot_skip_preflight',
  fixLoop: 'autopilot_fix_loop',
  continueOnFail: 'autopilot_continue_on_fail',
  synthesizeFollowups: 'autopilot_synthesize_followups',
  skipLearn: 'autopilot_skip_learn',
  notifySummary: 'autopilot_notify_summary',
};

const AUTOPILOT_NUMERIC_FIELDS = new Set([
  'count',
  'intervalSeconds',
  'cooldownMinutes',
  'failureBlockMinutes',
]);

const AUTOPILOT_BOOLEAN_FIELDS = new Set([
  'selfImprove',
  'brainstorm',
  'fullVerify',
  'skipVerify',
  'skipPreflight',
  'fixLoop',
  'continueOnFail',
  'synthesizeFollowups',
  'skipLearn',
  'notifySummary',
]);

function normalizeAutopilotSettings(payload = {}) {
  const normalized = { ...AUTOPILOT_DEFAULTS };
  for (const [field, key] of Object.entries(AUTOPILOT_KEY_MAP)) {
    const value = payload[field] !== undefined ? payload[field] : payload[key];
    if (value === undefined) {
      continue;
    }
    if (AUTOPILOT_BOOLEAN_FIELDS.has(field)) {
      normalized[field] = parseBool(value, AUTOPILOT_DEFAULTS[field]);
      continue;
    }
    if (AUTOPILOT_NUMERIC_FIELDS.has(field)) {
      const parsed = Number.parseInt(String(value || ''), 10);
      normalized[field] = Number.isFinite(parsed) ? Math.max(0, parsed) : AUTOPILOT_DEFAULTS[field];
      continue;
    }
    normalized[field] = stripQuotes(value);
  }
  if (!['run', 'implement'].includes(String(normalized.action || '').toLowerCase())) {
    normalized.action = AUTOPILOT_DEFAULTS.action;
  } else {
    normalized.action = String(normalized.action).toLowerCase();
  }
  if (!String(normalized.status || '').trim()) {
    normalized.status = AUTOPILOT_DEFAULTS.status;
  }
  if (!String(normalized.profile || '').trim()) {
    normalized.profile = AUTOPILOT_DEFAULTS.profile;
  }
  if (!String(normalized.template || '').trim()) {
    normalized.template = AUTOPILOT_DEFAULTS.template;
  }
  return normalized;
}

function configLineMatch(line, key) {
  if (/^\s*#/.test(line)) {
    return null;
  }
  const stripped = String(line || '').split('#')[0].trim();
  const pattern = new RegExp(`^${key}:\\s*(.*)$`);
  return stripped.match(pattern);
}

function getAutopilotSettings(workspaceRoot) {
  const configPath = configPathForWorkspace(workspaceRoot);
  if (!fs.existsSync(configPath)) {
    return { ...AUTOPILOT_DEFAULTS };
  }
  const lines = fs.readFileSync(configPath, 'utf8').split(/\r?\n/);
  const parsed = {};
  for (const [field, key] of Object.entries(AUTOPILOT_KEY_MAP)) {
    const line = lines.find((entry) => configLineMatch(entry, key));
    if (!line) {
      continue;
    }
    const match = configLineMatch(line, key);
    if (!match) {
      continue;
    }
    parsed[field] = stripQuotes(match[1]);
  }
  return normalizeAutopilotSettings(parsed);
}

function formatAutopilotScalar(field, value) {
  if (AUTOPILOT_BOOLEAN_FIELDS.has(field)) {
    return value ? 'true' : 'false';
  }
  if (AUTOPILOT_NUMERIC_FIELDS.has(field)) {
    return String(Math.max(0, Number(value || 0)));
  }
  return JSON.stringify(String(value || ''));
}

function saveAutopilotSettings(workspaceRoot, payload = {}) {
  const settings = normalizeAutopilotSettings(payload);
  const configPath = ensureConfigFile(workspaceRoot);
  const raw = fs.readFileSync(configPath, 'utf8');
  const lines = String(raw || '').split(/\r?\n/);
  const block = findAutopilotBlock(lines);
  let insertionIndex = block ? block.end : lines.length;

  for (const [field, key] of Object.entries(AUTOPILOT_KEY_MAP)) {
    const nextLine = `${key}: ${formatAutopilotScalar(field, settings[field])}`;
    const existingIndex = lines.findIndex((line) => configLineMatch(line, key));
    if (existingIndex >= 0) {
      lines[existingIndex] = nextLine;
      if (existingIndex >= insertionIndex) {
        insertionIndex = existingIndex + 1;
      }
      continue;
    }
    lines.splice(insertionIndex, 0, nextLine);
    insertionIndex += 1;
  }

  fs.writeFileSync(configPath, `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`, 'utf8');
  return settings;
}

function findAutopilotBlock(lines) {
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^autopilot_jobs:\s*$/.test(lines[i].trim())) {
      start = i;
      break;
    }
  }
  if (start < 0) {
    return null;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      continue;
    }
    if (/^\s*#/.test(line)) {
      continue;
    }
    if (/^[A-Za-z0-9_]+:\s*/.test(line)) {
      end = i;
      break;
    }
  }

  return { start, end };
}

function parseAutopilotJobs(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  const block = findAutopilotBlock(lines);
  if (!block) {
    return { jobs: [], block: null };
  }

  const jobs = [];
  let current = null;

  for (let i = block.start + 1; i < block.end; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    if (trimmed.startsWith('- ')) {
      if (current && current.name) {
        jobs.push(current);
      }
      current = { name: '', cron: '', enabled: true };
      const inlineName = trimmed.match(/^-\s+name:\s*(.+)$/);
      if (inlineName) {
        current.name = stripQuotes(inlineName[1]);
      }
      continue;
    }

    if (!current) {
      continue;
    }

    const field = trimmed.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!field) {
      continue;
    }
    const key = field[1];
    const value = stripQuotes(field[2]);
    if (key === 'name') {
      current.name = value;
    } else if (key === 'cron') {
      current.cron = value;
    } else if (key === 'enabled') {
      current.enabled = parseBool(value, true);
    }
  }

  if (current && current.name) {
    jobs.push(current);
  }

  return { jobs, block };
}

function renderAutopilotJobs(jobs) {
  const normalized = (jobs || [])
    .filter((job) => job && job.name)
    .map((job) => ({
      name: String(job.name).trim(),
      cron: String(job.cron || '0 * * * *').trim(),
      enabled: job.enabled !== false,
    }));

  const lines = ['autopilot_jobs:'];
  if (normalized.length === 0) {
    lines.push('  []');
    return lines.join('\n');
  }

  for (const job of normalized) {
    lines.push(`  - name: "${job.name.replace(/"/g, '\\"')}"`);
    lines.push(`    cron: "${job.cron.replace(/"/g, '\\"')}"`);
    lines.push(`    enabled: ${job.enabled ? 'true' : 'false'}`);
  }

  return lines.join('\n');
}

function upsertAutopilotBlock(rawText, jobs) {
  const lines = String(rawText || '').split(/\r?\n/);
  const blockText = renderAutopilotJobs(jobs);
  const blockLines = blockText.split(/\r?\n/);
  const block = findAutopilotBlock(lines);

  if (!block) {
    const out = [...lines.filter((_line, idx, arr) => !(idx === arr.length - 1 && !arr[idx]))];
    if (out.length > 0) {
      out.push('');
    }
    out.push(...blockLines);
    out.push('');
    return out.join('\n');
  }

  const out = [...lines.slice(0, block.start), ...blockLines, ...lines.slice(block.end)];
  return out.join('\n');
}

function ensureConfigFile(workspaceRoot) {
  const configPath = configPathForWorkspace(workspaceRoot);
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, '# managed by GoSenderr Desktop Agent\n\n', 'utf8');
  }
  return configPath;
}

function listAutomations(workspaceRoot) {
  const configPath = configPathForWorkspace(workspaceRoot);
  if (!fs.existsSync(configPath)) {
    return [];
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = parseAutopilotJobs(raw);
  return parsed.jobs;
}

function upsertAutomation(workspaceRoot, payload = {}) {
  const name = String(payload.name || '').trim();
  if (!name) {
    throw new Error('Automation name is required.');
  }

  const configPath = ensureConfigFile(workspaceRoot);
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = parseAutopilotJobs(raw);
  const jobs = [...parsed.jobs];

  const idx = jobs.findIndex((job) => job.name.toLowerCase() === name.toLowerCase());
  const nextJob = {
    name,
    cron: String(payload.cron || (idx >= 0 ? jobs[idx].cron : '0 * * * *')).trim(),
    enabled: payload.enabled !== undefined ? !!payload.enabled : idx >= 0 ? jobs[idx].enabled !== false : true,
  };

  if (idx >= 0) {
    jobs[idx] = nextJob;
  } else {
    jobs.push(nextJob);
  }

  const nextRaw = upsertAutopilotBlock(raw, jobs);
  fs.writeFileSync(configPath, nextRaw, 'utf8');
  return jobs;
}

function toggleAutomation(workspaceRoot, payload = {}) {
  const name = String(payload.name || '').trim();
  if (!name) {
    throw new Error('Automation name is required.');
  }
  const enabled = payload.enabled !== false;
  return upsertAutomation(workspaceRoot, {
    name,
    cron: payload.cron,
    enabled,
  });
}

function removeAutomation(workspaceRoot, payload = {}) {
  const name = String(payload.name || '').trim();
  if (!name) {
    throw new Error('Automation name is required.');
  }

  const configPath = ensureConfigFile(workspaceRoot);
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = parseAutopilotJobs(raw);
  const jobs = parsed.jobs.filter((job) => job.name.toLowerCase() !== name.toLowerCase());
  const nextRaw = upsertAutopilotBlock(raw, jobs);
  fs.writeFileSync(configPath, nextRaw, 'utf8');
  return jobs;
}

module.exports = {
  AUTOPILOT_DEFAULTS,
  configPathForWorkspace,
  getAutopilotSettings,
  normalizeAutopilotSettings,
  parseAutopilotJobs,
  renderAutopilotJobs,
  saveAutopilotSettings,
  upsertAutopilotBlock,
  listAutomations,
  upsertAutomation,
  toggleAutomation,
  removeAutomation,
};
