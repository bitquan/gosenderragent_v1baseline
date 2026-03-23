'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const RUNTIME_ROOT = path.join(REPO_ROOT, 'runtime');

function runPythonJson(source) {
  const output = childProcess.execFileSync('python', ['-c', source], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PYTHONPATH: [RUNTIME_ROOT, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter),
      PROJECT_ROOT: REPO_ROOT,
    },
    encoding: 'utf8',
  });
  return JSON.parse(String(output || '').trim());
}

test('runtime_api checkpoint merge supports dry-run manifests for compatible local checkpoints', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-checkpoint-merge-'));
  const baseRoot = path.join(tempRoot, 'qwen-base');
  const secondaryRoot = path.join(tempRoot, 'qwen-adapter');
  const outputRoot = path.join(tempRoot, 'merged');
  try {
    fs.mkdirSync(baseRoot, { recursive: true });
    fs.mkdirSync(secondaryRoot, { recursive: true });
    fs.writeFileSync(path.join(baseRoot, 'model.safetensors'), '');
    fs.writeFileSync(path.join(secondaryRoot, 'model.safetensors'), '');

    const result = runPythonJson(`
import json
from backend.agent.runtime import runtime_api

result = runtime_api.checkpoint_merge({
    "projectRoot": ${JSON.stringify(REPO_ROOT)},
    "basePath": ${JSON.stringify(baseRoot)},
    "secondaryPath": ${JSON.stringify(secondaryRoot)},
    "outputPath": ${JSON.stringify(outputRoot)},
    "mergeName": "qwen-lab-merge",
    "alpha": 0.2,
    "method": "linear",
    "dryRun": True,
})
print(json.dumps(result))
`);

    assert.equal(result.ok, true);
    assert.equal(path.resolve(result.outputPath), path.resolve(outputRoot));
    assert.equal(result.checkpointMerge.kind, 'assistant-checkpoint-merge');
    assert.equal(result.checkpointMerge.dry_run, true);
    assert.equal(result.checkpointMerge.worker_family, 'qwen');
    assert.match(String(result.summary || ''), /Prepared tensor-level checkpoint merge/i);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
