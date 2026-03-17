'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const { APP_ROOT } = require('./app-roots');
const { getConfiguredAssistantLabsRoot } = require('./assistant-paths');

const LAB_META_FILE = '.gos-lab.json';
const COPY_IGNORE_NAMES = new Set([
  '.DS_Store',
  '.git',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  'coverage',
  'dist',
  'node_modules',
  'tmp',
]);
const GENERATED_LAB_RECIPES = new Set([
  'dummy-node-app',
  'dummy-broken-node-app',
]);

function nowIso() {
  return new Date().toISOString();
}

function slugify(value, fallback = 'lab') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function ensureLabsRoot(workspaceRoot) {
  const root = getConfiguredAssistantLabsRoot(workspaceRoot);
  if (!root) {
    throw new Error('assistant_labs_root is not configured. Set assistant_artifacts_root or assistant_labs_root before using labs.');
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function labKindsRoot(workspaceRoot, kind = 'persistent') {
  const root = ensureLabsRoot(workspaceRoot);
  const normalizedKind = String(kind || 'persistent').trim().toLowerCase() === 'scratch' ? 'scratch' : 'persistent';
  const directory = path.join(root, normalizedKind);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function metadataPathFor(labRoot) {
  return path.join(labRoot, LAB_META_FILE);
}

function readLabMetadata(labRoot) {
  const metaPath = metadataPathFor(labRoot);
  if (!fs.existsSync(metaPath)) {
    return null;
  }
  try {
    const payload = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch (_error) {
    return null;
  }
}

function writeLabMetadata(labRoot, payload) {
  fs.mkdirSync(labRoot, { recursive: true });
  fs.writeFileSync(metadataPathFor(labRoot), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function listLabs(workspaceRoot) {
  const root = getConfiguredAssistantLabsRoot(workspaceRoot);
  if (!root || !fs.existsSync(root)) {
    return {
      ok: true,
      labsRoot: root || '',
      labs: [],
      count: 0,
      configured: !!root,
    };
  }
  const labs = [];
  for (const kind of ['persistent', 'scratch']) {
    const kindRoot = path.join(root, kind);
    if (!fs.existsSync(kindRoot)) {
      continue;
    }
    for (const name of fs.readdirSync(kindRoot)) {
      const labRoot = path.join(kindRoot, name);
      let stat = null;
      try {
        stat = fs.statSync(labRoot);
      } catch (_error) {
        stat = null;
      }
      if (!stat || !stat.isDirectory()) {
        continue;
      }
      const metadata = readLabMetadata(labRoot) || {};
      const sourceRoot = String(metadata.sourceRoot || '').trim();
      const active = metadata.active === true;
      const recipe = String(metadata.recipe || '').trim();
      labs.push({
        id: String(metadata.id || name),
        name: String(metadata.name || name),
        kind,
        recipe,
        active,
        sourceRoot,
        createdAt: String(metadata.createdAt || stat.birthtime?.toISOString?.() || stat.mtime.toISOString()),
        updatedAt: String(metadata.updatedAt || stat.mtime.toISOString()),
        labRoot,
        status: String(metadata.cloneMethod || '').trim() || (fs.existsSync(path.join(labRoot, '.git')) ? 'git-clone' : 'copied'),
      });
    }
  }
  labs.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  return {
    ok: true,
    labsRoot: root,
    labs,
    count: labs.length,
    configured: true,
  };
}

function copyWorkspace(sourceRoot, destinationRoot) {
  fs.cpSync(sourceRoot, destinationRoot, {
    recursive: true,
    filter: (sourcePath) => {
      const baseName = path.basename(sourcePath);
      return !COPY_IGNORE_NAMES.has(baseName);
    },
  });
}

function cloneWorkspace(sourceRoot, destinationRoot, options = {}) {
  const requestedMethod = String(options.method || 'auto').trim().toLowerCase();
  if (requestedMethod === 'copy') {
    copyWorkspace(sourceRoot, destinationRoot);
    return {
      ok: true,
      method: 'copy',
      stdout: '',
      stderr: '',
    };
  }
  const gitDir = path.join(sourceRoot, '.git');
  if (requestedMethod !== 'copy' && fs.existsSync(gitDir)) {
    const result = childProcess.spawnSync('git', ['clone', '--no-hardlinks', sourceRoot, destinationRoot], {
      encoding: 'utf8',
    });
    if (result.status === 0) {
      return {
        ok: true,
        method: 'git-clone',
        stdout: result.stdout || '',
        stderr: result.stderr || '',
      };
    }
  }
  copyWorkspace(sourceRoot, destinationRoot);
  return {
    ok: true,
    method: 'copy',
    stdout: '',
    stderr: '',
  };
}

function allocateLabLocation(workspaceRoot, payload = {}, fallbackName = 'lab') {
  const requestedKind = String(payload.kind || 'persistent').trim().toLowerCase();
  const kind = requestedKind === 'scratch' ? 'scratch' : 'persistent';
  const recipe = String(payload.recipe || 'mirror').trim().toLowerCase();
  const labsRoot = labKindsRoot(workspaceRoot, kind);
  const baseName = slugify(payload.name || fallbackName, recipe || fallbackName);
  const suffix = payload.labRoot ? '' : (kind === 'scratch' ? `-${Date.now()}` : '');
  const labRoot = payload.labRoot ? path.resolve(String(payload.labRoot)) : path.join(labsRoot, `${baseName}${suffix}`);
  if (fs.existsSync(labRoot)) {
    throw new Error(`Lab already exists: ${labRoot}`);
  }
  return {
    kind,
    recipe,
    labsRoot,
    baseName,
    suffix,
    labRoot,
    name: String(payload.name || baseName),
  };
}

function createLab(workspaceRoot, payload = {}) {
  const recipe = String(payload.recipe || 'mirror').trim().toLowerCase();
  const sourceRoot = path.resolve(String(payload.sourceRoot || workspaceRoot || ''));
  if (!sourceRoot || !fs.existsSync(sourceRoot)) {
    throw new Error(`Lab source root was not found: ${sourceRoot || '(empty)'}`);
  }
  const location = allocateLabLocation(workspaceRoot, payload, `${recipe}-${path.basename(sourceRoot)}`);
  const cloneStrategy = String(payload.cloneStrategy || 'auto').trim().toLowerCase();
  const cloned = cloneWorkspace(sourceRoot, location.labRoot, {
    method: ['copy', 'git-clone'].includes(cloneStrategy) ? cloneStrategy : 'auto',
  });
  const metadata = {
    id: payload.id || `${location.baseName}${location.suffix}`,
    name: location.name,
    kind: location.kind,
    recipe,
    sourceRoot,
    workspaceRoot: String(workspaceRoot || ''),
    labRoot: location.labRoot,
    createdAt: payload.createdAt || nowIso(),
    updatedAt: nowIso(),
    active: !!payload.active,
    modelIntent: String(payload.modelIntent || 'general').trim() || 'general',
    notes: String(payload.notes || '').trim(),
    cloneMethod: cloned.method,
  };
  writeLabMetadata(location.labRoot, metadata);
  return {
    ok: true,
    ...metadata,
    labsRoot: path.dirname(location.labRoot),
  };
}

function removeDirectory(targetPath) {
  if (targetPath && fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function resetLab(workspaceRoot, payload = {}) {
  const labRoot = path.resolve(String(payload.labRoot || '').trim());
  if (!labRoot || !fs.existsSync(labRoot)) {
    throw new Error('Lab root does not exist.');
  }
  const metadata = readLabMetadata(labRoot);
  if (!metadata) {
    throw new Error('Lab metadata is missing, so reset cannot rebuild it safely.');
  }
  if (metadata.sourceRoot) {
    const sourceRoot = path.resolve(String(metadata.sourceRoot));
    if (!fs.existsSync(sourceRoot)) {
      throw new Error(`Lab source root is unavailable: ${sourceRoot}`);
    }
    const preserved = { ...metadata, updatedAt: nowIso() };
    removeDirectory(labRoot);
    cloneWorkspace(sourceRoot, labRoot);
    writeLabMetadata(labRoot, preserved);
    return {
      ok: true,
      labRoot,
      sourceRoot,
      updatedAt: preserved.updatedAt,
    };
  }
  const recipe = String(metadata.recipe || '').trim().toLowerCase();
  if (GENERATED_LAB_RECIPES.has(recipe)) {
    removeDirectory(labRoot);
    const rebuilt = createGeneratedLab(workspaceRoot, {
      ...metadata,
      labRoot,
      recipe,
      name: metadata.name,
      kind: metadata.kind,
      active: metadata.active,
      modelIntent: metadata.modelIntent,
      notes: metadata.notes,
      id: metadata.id,
      createdAt: metadata.createdAt,
    });
    return {
      ok: true,
      labRoot: rebuilt.labRoot,
      sourceRoot: '',
      updatedAt: rebuilt.updatedAt,
    };
  }
  throw new Error('Lab metadata is missing sourceRoot, so reset cannot rebuild it safely.');
}

function destroyLab(workspaceRoot, payload = {}) {
  const labRoot = path.resolve(String(payload.labRoot || '').trim());
  if (!labRoot || !fs.existsSync(labRoot)) {
    return { ok: false, message: 'Lab root does not exist.', labRoot };
  }
  const labsRoot = getConfiguredAssistantLabsRoot(workspaceRoot);
  const normalizedLabsRoot = labsRoot ? path.resolve(labsRoot) : '';
  if (normalizedLabsRoot && labRoot !== normalizedLabsRoot && !labRoot.startsWith(`${normalizedLabsRoot}${path.sep}`)) {
    throw new Error('Refusing to remove a lab outside the configured assistant_labs_root.');
  }
  removeDirectory(labRoot);
  return { ok: true, labRoot };
}

function writeTextFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function createGeneratedDummyContents(options = {}) {
  const broken = options.broken === true;
  const title = broken ? 'Broken dummy app lab' : 'Dummy app lab';
  const packageName = broken ? 'gosenderr-dummy-broken-lab' : 'gosenderr-dummy-lab';
  const calculatorSource = broken
    ? `'use strict';\n\nfunction sum(left, right) {\n  return left - right;\n}\n\nfunction describeTask(name) {\n  return \`Task: \${String(name || '').trim() || 'unnamed'}\`;\n}\n\nmodule.exports = {\n  sum,\n  describeTask,\n};\n`
    : `'use strict';\n\nfunction sum(left, right) {\n  return left + right;\n}\n\nfunction describeTask(name) {\n  return \`Task: \${String(name || '').trim() || 'unnamed'}\`;\n}\n\nmodule.exports = {\n  sum,\n  describeTask,\n};\n`;
  const readme = [
    `# ${title}`,
    '',
    'This generated lab is safe benchmark material for the desktop agent.',
    '',
    '## What to try',
    '- Ask the chat to review the project and suggest the next safe fix.',
    '- Ask the agent to run tests, repair the failure, and summarize the diff.',
    '- Use this lab as a clean benchmark target before changing model routing defaults.',
    '',
    '## Validation',
    '```sh',
    'npm test',
    '```',
    '',
    broken
      ? 'This version intentionally contains a failing implementation so the repair loop has something real to fix.'
      : 'This version starts clean so the planner and reviewer lanes can benchmark against a stable target.',
    '',
  ].join('\n');
  return {
    'package.json': `${JSON.stringify({
      name: packageName,
      private: true,
      version: '0.0.1',
      type: 'commonjs',
      scripts: {
        test: 'node --test',
      },
    }, null, 2)}\n`,
    'README.md': `${readme}\n`,
    'src/calculator.js': calculatorSource,
    'src/index.js': `'use strict';\n\nconst { sum, describeTask } = require('./calculator');\n\nmodule.exports = {\n  sum,\n  describeTask,\n};\n`,
    'test/calculator.test.js': `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { sum, describeTask } = require('../src/calculator');\n\ntest('sum adds numbers together', () => {\n  assert.equal(sum(2, 3), 5);\n});\n\ntest('describeTask returns a clean label', () => {\n  assert.equal(describeTask('benchmark lane'), 'Task: benchmark lane');\n});\n`,
    'docs/PLAYBOOK.md': `# ${title} playbook\n\n- Safe for self-host benchmark drills.\n- Keep changes small and reversible.\n- Record what the engine changed and why.\n`,
  };
}

function createGeneratedLab(workspaceRoot, payload = {}) {
  const recipe = String(payload.recipe || 'dummy-node-app').trim().toLowerCase();
  const broken = recipe === 'dummy-broken-node-app';
  const location = allocateLabLocation(workspaceRoot, payload, broken ? 'dummy-broken-node-app' : 'dummy-node-app');
  fs.mkdirSync(location.labRoot, { recursive: true });
  const files = createGeneratedDummyContents({ broken });
  for (const [relativePath, contents] of Object.entries(files)) {
    writeTextFile(path.join(location.labRoot, relativePath), contents);
  }
  const createdAt = payload.createdAt || nowIso();
  const metadata = {
    id: payload.id || `${location.baseName}${location.suffix}`,
    name: location.name,
    kind: location.kind,
    recipe,
    sourceRoot: '',
    workspaceRoot: String(workspaceRoot || ''),
    labRoot: location.labRoot,
    createdAt,
    updatedAt: nowIso(),
    active: !!payload.active,
    modelIntent: String(payload.modelIntent || 'benchmark').trim() || 'benchmark',
    notes: String(payload.notes || (broken
      ? 'Generated broken dummy app for repair-loop benchmarks.'
      : 'Generated dummy app for clean benchmark and planning runs.')).trim(),
    cloneMethod: 'generated',
  };
  writeLabMetadata(location.labRoot, metadata);
  writeTextFile(path.join(location.labRoot, '.gos-lab-recipes', `${recipe}.json`), `${JSON.stringify({
    recipe,
    createdAt,
    broken,
    summary: metadata.notes,
  }, null, 2)}\n`);
  return {
    ok: true,
    ...metadata,
    labsRoot: path.dirname(location.labRoot),
  };
}

function runLabRecipe(workspaceRoot, payload = {}) {
  const recipe = String(payload.recipe || 'mirror').trim().toLowerCase();
  if (recipe === 'mirror') {
    return createLab(workspaceRoot, {
      ...payload,
      recipe,
      sourceRoot: payload.sourceRoot || workspaceRoot,
      name: payload.name || 'workspace-mirror',
    });
  }
  if (recipe === 'self-host') {
    return createLab(workspaceRoot, {
      ...payload,
      recipe,
      sourceRoot: payload.sourceRoot || APP_ROOT,
      name: payload.name || 'self-host',
      modelIntent: payload.modelIntent || 'self-host',
      cloneStrategy: payload.cloneStrategy || 'copy',
    });
  }
  if (recipe === 'dummy-node-app' || recipe === 'dummy-broken-node-app') {
    return createGeneratedLab(workspaceRoot, {
      ...payload,
      recipe,
      kind: payload.kind || 'scratch',
      name: payload.name || recipe,
      modelIntent: payload.modelIntent || 'benchmark',
    });
  }
  if (recipe === 'benchmark-self-host') {
    const sourceRoot = payload.sourceRoot || APP_ROOT;
    const result = createLab(workspaceRoot, {
      ...payload,
      recipe: 'self-host',
      sourceRoot,
      name: payload.name || 'benchmark-self-host',
      kind: payload.kind || 'scratch',
      modelIntent: 'benchmark',
      cloneStrategy: payload.cloneStrategy || 'copy',
    });
    writeTextFile(path.join(result.labRoot, '.gos-lab-recipes', 'benchmark-self-host.json'), JSON.stringify({
      recipe,
      createdAt: nowIso(),
      labRoot: result.labRoot,
      sourceRoot,
    }, null, 2) + '\n');
    return {
      ...result,
      recipe,
      summary: 'Prepared a fresh self-host benchmark lab clone.',
    };
  }

  const existingLabRoot = String(payload.labRoot || '').trim();
  if (!existingLabRoot) {
    throw new Error(`Recipe "${recipe}" requires an existing labRoot or a clone recipe.`);
  }
  const labRoot = path.resolve(existingLabRoot);
  if (!fs.existsSync(labRoot)) {
    throw new Error(`Lab root was not found: ${labRoot}`);
  }
  const metadata = readLabMetadata(labRoot) || {};
  const recipesDir = path.join(labRoot, '.gos-lab-recipes');
  fs.mkdirSync(recipesDir, { recursive: true });

  if (recipe === 'break-node-test') {
    const breakPath = path.join(labRoot, '__lab__', 'intentional_failure.test.js');
    writeTextFile(breakPath, `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\n\ntest('intentional lab failure', () => {\n  assert.fail('Intentional lab failure created by desktop lab recipe.');\n});\n`);
    writeTextFile(path.join(recipesDir, 'break-node-test.json'), JSON.stringify({
      recipe,
      createdAt: nowIso(),
      breakPath,
    }, null, 2) + '\n');
    writeLabMetadata(labRoot, {
      ...metadata,
      recipeHistory: [...(Array.isArray(metadata.recipeHistory) ? metadata.recipeHistory : []), { recipe, createdAt: nowIso(), breakPath }],
      updatedAt: nowIso(),
    });
    return {
      ok: true,
      recipe,
      labRoot,
      breakPath,
      summary: 'Injected a failing Node test into the lab for repair-loop benchmarking.',
    };
  }

  throw new Error(`Unknown lab recipe: ${recipe}`);
}

module.exports = {
  LAB_META_FILE,
  createLab,
  createGeneratedLab,
  destroyLab,
  ensureLabsRoot,
  listLabs,
  readLabMetadata,
  resetLab,
  runLabRecipe,
  writeLabMetadata,
};
