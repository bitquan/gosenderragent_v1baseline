'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listBenchmarkRuns, recordBenchmarkRun } = require('../core/benchmarks');

function makeWorkspace() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-benchmarks-'));
  const artifactsRoot = path.join(workspaceRoot, 'artifacts');
  fs.mkdirSync(artifactsRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.local.yaml'), `assistant_artifacts_root: ${artifactsRoot}\n`, 'utf8');
  return { workspaceRoot };
}

test('recordBenchmarkRun preserves GS-Dev-1 profile, task mode, and provider metadata', () => {
  const { workspaceRoot } = makeWorkspace();
  try {
    const run = recordBenchmarkRun(workspaceRoot, {
      name: 'gs-dev-1-benchmark',
      model: 'qwen2.5-coder:14b',
      modelProfileId: 'gs-dev-1-default',
      wrappedProfileId: 'gs-dev-1-default',
      baseModel: 'qwen2.5-coder:14b',
      taskMode: 'coder',
      providerSource: 'ollama',
      benchmarkTags: ['gs-dev-1', 'local'],
      status: 'pass',
      ok: true,
    });
    const listed = listBenchmarkRuns(workspaceRoot);

    assert.equal(run.modelProfileId, 'gs-dev-1-default');
    assert.equal(run.taskMode, 'coder');
    assert.equal(run.providerSource, 'ollama');
    assert.deepEqual(run.benchmarkTags, ['gs-dev-1', 'local']);
    assert.equal(listed.runs[0].wrappedProfileId, 'gs-dev-1-default');
    assert.equal(listed.runs[0].baseModel, 'qwen2.5-coder:14b');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
