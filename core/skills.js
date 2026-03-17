'use strict';

const fs = require('fs');
const path = require('path');

function parseSkillMarkdown(skillPath) {
  const raw = fs.readFileSync(skillPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  let title = path.basename(path.dirname(skillPath));
  let description = '';

  for (const line of lines) {
    if (!title && line.startsWith('# ')) {
      title = line.replace(/^#\s+/, '').trim();
      continue;
    }
    if (!description && line.trim() && !line.startsWith('#')) {
      description = line.trim();
      break;
    }
  }

  return {
    name: title || path.basename(path.dirname(skillPath)),
    description: description || 'No description.',
    path: skillPath,
  };
}

function walkForSkillFiles(root, maxDepth = 5) {
  const out = [];
  function walk(current, depth) {
    if (depth > maxDepth) {
      return;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_err) {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isFile() && entry.name === 'SKILL.md') {
        out.push(fullPath);
      } else if (entry.isDirectory() && !entry.name.startsWith('.git')) {
        walk(fullPath, depth + 1);
      }
    }
  }

  walk(root, 0);
  return out;
}

function detectSkillRoots(workspaceRoot) {
  const roots = new Set();
  if (workspaceRoot) {
    roots.add(path.join(workspaceRoot, 'skills'));
    roots.add(path.join(workspaceRoot, '.codex', 'skills'));
  }

  const codeHome = process.env.CODEX_HOME;
  if (codeHome) {
    roots.add(path.join(codeHome, 'skills'));
  }

  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    roots.add(path.join(home, '.codex', 'skills'));
  }

  return Array.from(roots).filter((rootPath) => fs.existsSync(rootPath));
}

function listSkills(workspaceRoot) {
  const roots = detectSkillRoots(workspaceRoot);
  const files = new Set();

  for (const root of roots) {
    for (const file of walkForSkillFiles(root, 6)) {
      files.add(file);
    }
  }

  const skills = [];
  for (const file of files) {
    try {
      const parsed = parseSkillMarkdown(file);
      skills.push({
        ...parsed,
        root: roots.find((root) => file.startsWith(root)) || '',
      });
    } catch (_err) {
      // ignore malformed files
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

function runSkill(workspaceRoot, payload = {}) {
  const skillPath = String(payload.skillPath || '');
  if (!skillPath || !fs.existsSync(skillPath)) {
    return {
      ok: false,
      error: 'Skill file does not exist.',
    };
  }

  const allowedRoots = detectSkillRoots(workspaceRoot);
  const isAllowed = allowedRoots.some((root) => skillPath.startsWith(root));
  if (!isAllowed) {
    return {
      ok: false,
      error: 'Skill path is outside known skill roots.',
    };
  }

  const parsed = parseSkillMarkdown(skillPath);
  return {
    ok: true,
    skill: parsed,
    message: `Opened ${parsed.name}. Follow SKILL.md workflow for execution.`,
  };
}

module.exports = {
  listSkills,
  runSkill,
  detectSkillRoots,
};
