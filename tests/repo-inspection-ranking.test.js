'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resolvePythonExecutable() {
  const root = path.join(__dirname, '..');
  const candidates = [
    path.join(root, '.venv', 'Scripts', 'python.exe'),
    path.join(root, '.venv', 'bin', 'python'),
    process.env.PYTHON,
    'python',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'python') {
      return candidate;
    }
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return '';
}

test('rank_related_files promotes JS and TS implementation imports from tests', () => {
  const pythonExecutable = resolvePythonExecutable();
  if (!pythonExecutable) {
    test.skip('Python runtime is unavailable for repo inspection regression coverage.');
    return;
  }

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-inspection-ranking-'));
  try {
    fs.mkdirSync(path.join(fixtureRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'src', 'add.ts'), 'export function add(left, right) {\n  return left + right;\n}\n', 'utf8');
    fs.writeFileSync(
      path.join(fixtureRoot, 'tests', 'add.test.ts'),
      "import { add } from '../src/add';\n\nconsole.log(add(1, 2));\n",
      'utf8',
    );

    const repoInspectionPath = path.join(__dirname, '..', 'runtime', 'backend', 'agent', 'core', 'repo_inspection.py');
    const script = [
      'from pathlib import Path',
      'import importlib.util',
      'import json',
      'import sys',
      'module_path = Path(sys.argv[1])',
      'project_root = Path(sys.argv[2])',
      'spec = importlib.util.spec_from_file_location("repo_inspection", module_path)',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'ranked = module.rank_related_files(',
      '    project_root,',
      '    candidates=["tests/add.test.ts"],',
      '    query="add implementation",',
      '    editor_context={"active_file_path": "tests/add.test.ts", "open_files": ["tests/add.test.ts"]},',
      '    limit=4,',
      ')',
      'print(json.dumps(ranked))',
    ].join('\n');

    const result = childProcess.spawnSync(pythonExecutable, ['-c', script, repoInspectionPath, fixtureRoot], {
      encoding: 'utf8',
      cwd: path.join(__dirname, '..'),
    });

    assert.equal(result.status, 0, result.stderr || result.stdout || 'repo inspection regression script failed');
    const ranked = JSON.parse(String(result.stdout || '[]').trim() || '[]');
    const sourceEntry = ranked.find((item) => item.path === 'src/add.ts');
    const testEntry = ranked.find((item) => item.path === 'tests/add.test.ts');

    assert.ok(sourceEntry, 'expected imported implementation file to appear in ranked results');
    assert.ok(testEntry, 'expected originating test file to remain in ranked results');
    assert.ok(Number(sourceEntry.score || 0) > Number(testEntry.score || 0), 'expected imported implementation file to outrank the test file');
    assert.match(String((sourceEntry.reasons || []).join(' ')), /imported-by-test:tests\/add\.test\.ts/);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});