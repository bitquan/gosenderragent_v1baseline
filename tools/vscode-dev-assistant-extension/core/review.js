'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const { sanitizeRelativePath } = require('./utils');

function clipText(value, maxChars) {
  const text = String(value || '');
  if (!text) {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeReviewPath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
}

function parseChangedFileLine(line) {
  const raw = String(line || '').trim();
  if (!raw) {
    return null;
  }
  const status = raw.slice(0, 2).trim() || '??';
  const rest = raw.slice(2).trim();
  const currentPath = rest.includes('->') ? rest.split('->').pop().trim() : rest;
  const relativePath = normalizeReviewPath(currentPath);
  if (!relativePath) {
    return null;
  }
  return {
    status,
    raw,
    path: relativePath,
  };
}

function guessLanguage(relativePath) {
  const ext = path.extname(String(relativePath || '').toLowerCase());
  const map = {
    '.py': 'python',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.json': 'json',
    '.md': 'markdown',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.html': 'html',
    '.css': 'css',
    '.sh': 'shell',
    '.txt': 'text',
  };
  return map[ext] || 'text';
}

function readWorkspaceFile(workspaceRoot, relativePath, { maxChars = 40000 } = {}) {
  const normalizedPath = normalizeReviewPath(relativePath);
  const fullPath = sanitizeRelativePath(workspaceRoot, normalizedPath);
  if (!fullPath || !fs.existsSync(fullPath)) {
    return { ok: false, message: 'File not found.', path: normalizedPath };
  }
  const stat = fs.statSync(fullPath);
  if (!stat.isFile()) {
    return { ok: false, message: 'Only files can be inspected.', path: normalizedPath };
  }
  const raw = fs.readFileSync(fullPath, 'utf8');
  const truncated = raw.length > maxChars;
  return {
    ok: true,
    path: normalizedPath,
    fullPath,
    language: guessLanguage(normalizedPath),
    lineCount: raw.split(/\r?\n/).length,
    truncated,
    content: truncated ? clipText(raw, maxChars) : raw,
  };
}

function saveWorkspaceFile(workspaceRoot, relativePath, content) {
  const normalizedPath = normalizeReviewPath(relativePath);
  const fullPath = sanitizeRelativePath(workspaceRoot, normalizedPath);
  if (!fullPath || !fs.existsSync(fullPath)) {
    return { ok: false, message: 'File not found.', path: normalizedPath };
  }
  const stat = fs.statSync(fullPath);
  if (!stat.isFile()) {
    return { ok: false, message: 'Only files can be edited.', path: normalizedPath };
  }
  fs.writeFileSync(fullPath, String(content || ''), 'utf8');
  return {
    ok: true,
    path: normalizedPath,
    fullPath,
    language: guessLanguage(normalizedPath),
    lineCount: String(content || '').split(/\r?\n/).length,
  };
}

function getWorkspaceDiff(workspaceRoot, relativePath, { maxChars = 40000 } = {}) {
  const normalizedPath = normalizeReviewPath(relativePath);
  const fullPath = sanitizeRelativePath(workspaceRoot, normalizedPath);
  if (!fullPath || !fs.existsSync(fullPath)) {
    return { ok: false, message: 'File not found.', path: normalizedPath, diff: '' };
  }
  try {
    const diff = childProcess.execSync(`git diff -- ${JSON.stringify(normalizedPath)}`, {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const truncated = diff.length > maxChars;
    return {
      ok: true,
      path: normalizedPath,
      truncated,
      diff: truncated ? clipText(diff, maxChars) : diff,
    };
  } catch (_err) {
    return { ok: true, path: normalizedPath, truncated: false, diff: '' };
  }
}

function artifactLabelFromName(name) {
  const fileName = path.basename(String(name || ''));
  return fileName
    .replace(/\.json$/i, ' json')
    .replace(/\.md$/i, ' notes')
    .replace(/_/g, ' ')
    .trim();
}

function collectArtifactEntriesForRun(run, { limit = 12 } = {}) {
  if (!run || !run.path) {
    return [];
  }
  const runPath = String(run.path);
  const dir = path.dirname(runPath);
  if (!fs.existsSync(dir)) {
    return [];
  }

  const explicit = [];
  if (run.path) {
    explicit.push(run.path);
  }
  if (Array.isArray(run.artifactPaths)) {
    explicit.push(...run.artifactPaths);
  }

  const fileName = path.basename(runPath);
  const stem = fileName.replace(/\.[^.]+$/, '');
  const ticket = String(run.ticket || '').trim();
  const ticketPrefix = ticket ? `BAT${ticket}_` : stem.split('_').slice(0, 2).join('_');

  const candidates = new Set(explicit.filter(Boolean).map((entry) => path.resolve(entry)));
  const explicitPriority = new Map(explicit.filter(Boolean).map((entry, index) => [path.resolve(entry), index]));
  const names = fs.readdirSync(dir);
  names.forEach((name) => {
    if (!/\.(json|md)$/i.test(name)) {
      return;
    }
    if (name.startsWith(stem) || (ticketPrefix && name.startsWith(ticketPrefix))) {
      candidates.add(path.join(dir, name));
    }
  });

  return Array.from(candidates)
    .filter((entry) => fs.existsSync(entry))
    .sort((a, b) => {
      const aPriority = explicitPriority.has(a) ? explicitPriority.get(a) : Number.MAX_SAFE_INTEGER;
      const bPriority = explicitPriority.has(b) ? explicitPriority.get(b) : Number.MAX_SAFE_INTEGER;
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }
      const aName = path.basename(a);
      const bName = path.basename(b);
      const aExact = aName.startsWith(stem) ? 0 : 1;
      const bExact = bName.startsWith(stem) ? 0 : 1;
      if (aExact !== bExact) {
        return aExact - bExact;
      }
      return aName.localeCompare(bName);
    })
    .slice(0, limit)
    .map((entry) => ({
      path: entry,
      relativePath: normalizeReviewPath(path.relative(path.dirname(path.dirname(dir)), entry)),
      label: artifactLabelFromName(entry),
      kind: 'artifact',
      ticket: ticket || '',
      generatedAt: run.generatedAt || '',
    }));
}

function buildReviewSnapshot(workspaceRoot, payload = {}) {
  const changedFiles = Array.isArray(payload.changedFiles) ? payload.changedFiles : [];
  const recentRuns = Array.isArray(payload.recentRuns) ? payload.recentRuns : [];
  const latestRun = payload.latestRun || null;
  const decisions = payload.decisions && typeof payload.decisions === 'object' ? payload.decisions : {};

  const reviewFiles = changedFiles
    .map(parseChangedFileLine)
    .filter(Boolean)
    .map((item) => ({
      ...item,
      decision: decisions[item.path]?.status || 'pending',
      note: decisions[item.path]?.note || '',
    }));

  const failingLocations = (Array.isArray(latestRun?.locations) ? latestRun.locations : [])
    .slice(0, 12)
    .map((item) => {
      const reviewPath = normalizeReviewPath(item.path || '');
      return {
        path: reviewPath,
        line: Number(item.line || 1),
        message: String(item.message || item.source || item.name || 'Validation issue'),
        decision: decisions[reviewPath]?.status || 'pending',
      };
    })
    .filter((item) => item.path);

  const recentArtifacts = recentRuns
    .slice(0, 8)
    .flatMap((run) => collectArtifactEntriesForRun(run, { limit: 8 }).map((entry) => ({
      ...entry,
      decision: decisions[entry.relativePath]?.status || 'pending',
      runLabel: run.command || 'run',
    })))
    .slice(0, 30);

  return {
    changedFiles: reviewFiles,
    failingLocations,
    recentArtifacts,
    decisions,
  };
}

module.exports = {
  normalizeReviewPath,
  parseChangedFileLine,
  guessLanguage,
  readWorkspaceFile,
  saveWorkspaceFile,
  getWorkspaceDiff,
  collectArtifactEntriesForRun,
  buildReviewSnapshot,
};
