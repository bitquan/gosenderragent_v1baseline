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
  configPathForWorkspace,
  parseAutopilotJobs,
  renderAutopilotJobs,
  upsertAutopilotBlock,
  listAutomations,
  upsertAutomation,
  toggleAutomation,
  removeAutomation,
};
