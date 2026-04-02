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

test('planner ranking promotes explicit objective file paths even when strategy matches miss them', () => {
  const pythonExecutable = resolvePythonExecutable();
  if (!pythonExecutable) {
    test.skip('Python runtime is unavailable for planner ranking regression coverage.');
    return;
  }

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-explicit-path-'));
  try {
    fs.mkdirSync(path.join(fixtureRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'src', 'local-proof-widget.ts'), 'export const widget = true;\n', 'utf8');
    fs.writeFileSync(path.join(fixtureRoot, 'src', 'other-widget.ts'), 'export const other = true;\n', 'utf8');

    const script = [
      'from pathlib import Path',
      'import importlib.util',
      'import json',
      'import sys',
      'module_path = Path(sys.argv[1])',
      'project_root = Path(sys.argv[2])',
      'repo_root = Path(sys.argv[3])',
      'sys.path.insert(0, str(repo_root / "runtime"))',
      'spec = importlib.util.spec_from_file_location("planning_service", module_path)',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'ranked = module._rank_existing_targets(',
      '    ["src/other-widget.ts"],',
      '    project_root=project_root,',
      '    editor_context={},',
      '    query="Update src/local-proof-widget.ts to add a bounded proof and leave other files alone.",',
      ')',
      'print(json.dumps(ranked))',
    ].join('\n');

    const modulePath = path.join(__dirname, '..', 'runtime', 'backend', 'agent', 'core', 'planning_service.py');
    const repoRoot = path.join(__dirname, '..');
    const result = childProcess.spawnSync(pythonExecutable, ['-c', script, modulePath, fixtureRoot, repoRoot], {
      encoding: 'utf8',
      cwd: repoRoot,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout || 'planning explicit path regression script failed');
    const ranked = JSON.parse(String(result.stdout || '[]').trim() || '[]');
    assert.equal(ranked[0], 'src/local-proof-widget.ts');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('planner ranking keeps explicit scaffold targets ahead of unrelated matches', () => {
  const pythonExecutable = resolvePythonExecutable();
  if (!pythonExecutable) {
    test.skip('Python runtime is unavailable for scaffold ranking regression coverage.');
    return;
  }

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-scaffold-path-'));
  try {
    fs.mkdirSync(path.join(fixtureRoot, 'src', 'widgets'), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, 'renderer-src'), { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'src', 'widgets', 'local-proof-widget.tsx'), 'export function Widget() { return null; }\n', 'utf8');
    fs.writeFileSync(path.join(fixtureRoot, 'src', 'widgets', 'local-proof-widget.test.tsx'), 'export const testWidget = true;\n', 'utf8');
    fs.writeFileSync(path.join(fixtureRoot, 'renderer-src', 'main.tsx'), 'export const shell = true;\n', 'utf8');

    const script = [
      'from pathlib import Path',
      'import importlib.util',
      'import json',
      'import sys',
      'module_path = Path(sys.argv[1])',
      'project_root = Path(sys.argv[2])',
      'repo_root = Path(sys.argv[3])',
      'sys.path.insert(0, str(repo_root / "runtime"))',
      'spec = importlib.util.spec_from_file_location("planning_service", module_path)',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'ranked = module._rank_existing_targets(',
      '    ["renderer-src/main.tsx"],',
      '    project_root=project_root,',
      '    editor_context={},',
      '    query="Scaffold src/widgets/local-proof-widget.tsx and src/widgets/local-proof-widget.test.tsx as the bounded local proof target.",',
      ')',
      'print(json.dumps(ranked))',
    ].join('\n');

    const modulePath = path.join(__dirname, '..', 'runtime', 'backend', 'agent', 'core', 'planning_service.py');
    const repoRoot = path.join(__dirname, '..');
    const result = childProcess.spawnSync(pythonExecutable, ['-c', script, modulePath, fixtureRoot, repoRoot], {
      encoding: 'utf8',
      cwd: repoRoot,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout || 'planning scaffold path regression script failed');
    const ranked = JSON.parse(String(result.stdout || '[]').trim() || '[]');
    assert.deepEqual(ranked.slice(0, 2), [
      'src/widgets/local-proof-widget.test.tsx',
      'src/widgets/local-proof-widget.tsx',
    ]);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('build_runtime_context seeds repair targets from failing validation output', () => {
  const pythonExecutable = resolvePythonExecutable();
  if (!pythonExecutable) {
    test.skip('Python runtime is unavailable for runtime context regression coverage.');
    return;
  }

  const repoRoot = path.join(__dirname, '..');
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-context-ranking-'));
  try {
    fs.mkdirSync(path.join(fixtureRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(fixtureRoot, 'src', 'calculator.js'),
      "'use strict';\n\nfunction sum(left, right) {\n  return left - right;\n}\n\nmodule.exports = { sum };\n",
      'utf8',
    );
    fs.writeFileSync(
      path.join(fixtureRoot, 'test', 'calculator.test.js'),
      "'use strict';\n\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { sum } = require('../src/calculator');\n\ntest('sum adds numbers together', () => {\n  assert.equal(sum(2, 3), 5);\n});\n",
      'utf8',
    );

    const script = [
      'from pathlib import Path',
      'import importlib.util',
      'import json',
      'import sys',
      'repo_root = Path(sys.argv[1])',
      'project_root = Path(sys.argv[2])',
      'sys.path.insert(0, str(repo_root / "runtime"))',
      'module_path = repo_root / "runtime" / "backend" / "agent" / "core" / "runtime_context.py"',
      'spec = importlib.util.spec_from_file_location("runtime_context", module_path)',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'stdout = "\\n".join([',
      '    "> gosenderr-dummy-broken-lab@0.0.1 test",',
      '    "> node --test",',
      '    "",',
      '    "test at test\\\\calculator.test.js:6:1",',
      '    f"      at TestContext.<anonymous> ({project_root / \'test\' / \'calculator.test.js\'}:7:10)",',
      '])',
      'context = module.build_runtime_context(',
      '    project_root,',
      '    desc="Repair the latest failed bounded run and rerun the smallest relevant validation.",',
      '    validation={',
      '        "results": [',
      '            {',
      '                "ok": False,',
      '                "command": "npm test",',
      '                "returncode": 1,',
      '                "stdout": stdout,',
      '                "stderr": "",',
      '            }',
      '        ]',
      '    },',
      ')',
      'print(json.dumps({"related_files": context["related_files"], "related_details": context["related_file_details"]}))',
    ].join('\n');

    const result = childProcess.spawnSync(pythonExecutable, ['-c', script, repoRoot, fixtureRoot], {
      encoding: 'utf8',
      cwd: repoRoot,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout || 'runtime context regression script failed');
    const payload = JSON.parse(String(result.stdout || '{}').trim() || '{}');
    const relatedFiles = Array.isArray(payload.related_files) ? payload.related_files : [];
    const sourceEntry = (Array.isArray(payload.related_details) ? payload.related_details : []).find((item) => item.path === 'src/calculator.js');

    assert.ok(relatedFiles.includes('test/calculator.test.js'), 'expected failing test file to seed related files');
    assert.ok(relatedFiles.includes('src/calculator.js'), 'expected imported implementation file to be inferred from the failing test');
    assert.ok(sourceEntry, 'expected runtime context details for the imported implementation file');
    assert.match(String((sourceEntry.reasons || []).join(' ')), /imported-by-test:test\/calculator\.test\.js/);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('build_runtime_context reuses stable baseline sections from the previous context', () => {
  const pythonExecutable = resolvePythonExecutable();
  if (!pythonExecutable) {
    test.skip('Python runtime is unavailable for runtime context caching coverage.');
    return;
  }

  const repoRoot = path.join(__dirname, '..');
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-context-cache-'));
  try {
    const script = [
      'from pathlib import Path',
      'import importlib.util',
      'import json',
      'import sys',
      'repo_root = Path(sys.argv[1])',
      'project_root = Path(sys.argv[2])',
      'sys.path.insert(0, str(repo_root / "runtime"))',
      'module_path = repo_root / "runtime" / "backend" / "agent" / "core" / "runtime_context.py"',
      'spec = importlib.util.spec_from_file_location("runtime_context", module_path)',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'calls = {"baseline": 0, "docs": 0, "config": 0}',
      'def fake_baseline(_root):',
      '    calls["baseline"] += 1',
      '    return {"state": "green", "recent_failure_count": 0}',
      'def fake_docs(_root):',
      '    calls["docs"] += 1',
      '    return {"queue_count": 0}',
      'def fake_config(_root):',
      '    calls["config"] += 1',
      '    return {"ok": True}',
      'module._normalize_baseline_state = fake_baseline',
      'module._normalize_docs_state = fake_docs',
      'module._normalize_config_state = fake_config',
      'first = module.build_runtime_context(project_root, desc="First pass")',
      'second = module.build_runtime_context(project_root, desc="Second pass", previous_context=first)',
      'print(json.dumps({"calls": calls, "first": first["baseline_state"], "second": second["baseline_state"]}))',
    ].join('\n');

    const result = childProcess.spawnSync(pythonExecutable, ['-c', script, repoRoot, fixtureRoot], {
      encoding: 'utf8',
      cwd: repoRoot,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout || 'runtime context caching script failed');
    const payload = JSON.parse(String(result.stdout || '{}').trim() || '{}');
    assert.equal(payload.calls.baseline, 1);
    assert.equal(payload.calls.docs, 1);
    assert.equal(payload.calls.config, 1);
    assert.deepEqual(payload.first, payload.second);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('build_runtime_context seeds explicit objective paths into related files for coding work', () => {
  const pythonExecutable = resolvePythonExecutable();
  if (!pythonExecutable) {
    test.skip('Python runtime is unavailable for explicit runtime-context ranking coverage.');
    return;
  }

  const repoRoot = path.join(__dirname, '..');
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-context-explicit-path-'));
  try {
    fs.mkdirSync(path.join(fixtureRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'src', 'target-widget.ts'), 'export const target = true;\n', 'utf8');
    fs.writeFileSync(path.join(fixtureRoot, 'src', 'background-widget.ts'), 'export const background = true;\n', 'utf8');

    const script = [
      'from pathlib import Path',
      'import importlib.util',
      'import json',
      'import sys',
      'repo_root = Path(sys.argv[1])',
      'project_root = Path(sys.argv[2])',
      'sys.path.insert(0, str(repo_root / "runtime"))',
      'module_path = repo_root / "runtime" / "backend" / "agent" / "core" / "runtime_context.py"',
      'spec = importlib.util.spec_from_file_location("runtime_context", module_path)',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'context = module.build_runtime_context(',
      '    project_root,',
      '    desc="Update src/target-widget.ts with a bounded local proof and keep other files unchanged.",',
      ')',
      'print(json.dumps({"related_files": context["related_files"], "related_details": context["related_file_details"]}))',
    ].join('\n');

    const result = childProcess.spawnSync(pythonExecutable, ['-c', script, repoRoot, fixtureRoot], {
      encoding: 'utf8',
      cwd: repoRoot,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout || 'runtime explicit path regression script failed');
    const payload = JSON.parse(String(result.stdout || '{}').trim() || '{}');
    const details = Array.isArray(payload.related_details) ? payload.related_details : [];
    const targetEntry = details.find((item) => item.path === 'src/target-widget.ts');

    assert.equal(payload.related_files[0], 'src/target-widget.ts');
    assert.ok(targetEntry, 'expected explicit target entry in runtime context details');
    assert.match(String((targetEntry.reasons || []).join(' ')), /explicit-query-path/);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});