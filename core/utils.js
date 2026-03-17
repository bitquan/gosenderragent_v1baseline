'use strict';

const fs = require('fs');
const path = require('path');

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return fallback;
  }
}

function readJsonFile(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return safeJsonParse(fs.readFileSync(filePath, 'utf8'), fallback);
  } catch (_err) {
    return fallback;
  }
}

function writeJsonFileAtomic(filePath, payload) {
  const dir = path.dirname(filePath);
  ensureDirectory(dir);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function isWithin(parentPath, targetPath) {
  const parent = path.resolve(parentPath);
  const target = path.resolve(targetPath);
  return target === parent || target.startsWith(`${parent}${path.sep}`);
}

function sanitizeRelativePath(workspaceRoot, relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const resolved = path.resolve(workspaceRoot, normalized);
  if (!isWithin(workspaceRoot, resolved)) {
    return null;
  }
  return resolved;
}

function nowIso() {
  return new Date().toISOString();
}

function parseFailureLocationsFromChecks(checks) {
  const out = [];
  const seen = new Set();
  const pathRe = /((?:backend|frontend|docs)\/[A-Za-z0-9_./-]+\.(?:py|ts|tsx|js|jsx|md|json|ya?ml))(?::(\d+))?/g;
  const fileLineRe = /File "((?:backend|frontend|docs)\/[^"]+)", line (\d+)/g;

  for (const check of checks || []) {
    if (!check || check.ok) {
      continue;
    }
    const text = `${check.stdout_tail || ''}\n${check.stderr_tail || ''}`;
    let match = null;

    while ((match = fileLineRe.exec(text)) !== null) {
      const relPath = match[1];
      const line = Number(match[2] || 1);
      const key = `${relPath}:${line}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({ path: relPath, line, source: check.name || 'check' });
    }

    while ((match = pathRe.exec(text)) !== null) {
      const relPath = match[1];
      const line = Number(match[2] || 1);
      const key = `${relPath}:${line}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({ path: relPath, line, source: check.name || 'check' });
    }
  }

  return out.slice(0, 30);
}

function randomId(prefix = 'run') {
  const nonce = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${nonce}`;
}

function existsExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (_err) {
    return false;
  }
}

function shellEscape(value) {
  const s = String(value || '');
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

module.exports = {
  ensureDirectory,
  safeJsonParse,
  readJsonFile,
  writeJsonFileAtomic,
  isWithin,
  sanitizeRelativePath,
  nowIso,
  parseFailureLocationsFromChecks,
  randomId,
  existsExecutable,
  shellEscape,
};
