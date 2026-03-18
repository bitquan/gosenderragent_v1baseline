'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const process = require('process');

const {
  buildBenchmarkValidationPlan,
  finalizeBenchmarkOutcome,
  listBenchmarkRuns,
  recordBenchmarkRun,
  runBenchmarkValidation,
} = require('../core/benchmarks');

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

test('buildBenchmarkValidationPlan infers npm test for Node targets with a test script', () => {
  const { workspaceRoot } = makeWorkspace();
  try {
    fs.writeFileSync(path.join(workspaceRoot, 'package.json'), JSON.stringify({
      name: 'bench-target',
      private: true,
      scripts: {
        test: 'node --test',
      },
    }, null, 2));

    const plan = buildBenchmarkValidationPlan(workspaceRoot, {}, { required: true });

    assert.equal(plan.required, true);
    assert.equal(plan.ready, true);
    assert.equal(plan.inferred, true);
    assert.equal(plan.command, 'npm');
    assert.deepEqual(plan.args, ['test']);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('runBenchmarkValidation fails fast when validation is required but no command can be inferred', () => {
  const { workspaceRoot } = makeWorkspace();
  try {
    const result = runBenchmarkValidation(workspaceRoot, {}, { required: true });

    assert.equal(result.ok, false);
    assert.equal(result.ready, false);
    assert.match(result.summary, /no validation command/i);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('runBenchmarkValidation executes an explicit validation command', () => {
  const { workspaceRoot } = makeWorkspace();
  try {
    const result = runBenchmarkValidation(workspaceRoot, {
      validation: {
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
      },
    }, { required: true });

    assert.equal(result.ok, true);
    assert.equal(result.ready, true);
    assert.equal(result.command, process.execPath);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('finalizeBenchmarkOutcome turns a runtime pass into a benchmark failure when validation fails', () => {
  const outcome = finalizeBenchmarkOutcome({
    status: 'pass',
    summary: 'no manual review blockers detected',
    validationResult: {
      required: true,
      ok: false,
      summary: 'Validation failed: npm test',
    },
  });

  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.summary, 'Validation failed: npm test');
});

test('recordBenchmarkRun persists validation results alongside the benchmark artifact', () => {
  const { workspaceRoot } = makeWorkspace();
  try {
    const run = recordBenchmarkRun(workspaceRoot, {
      name: 'validated-benchmark',
      status: 'fail',
      ok: false,
      validationResult: {
        required: true,
        ok: false,
        command: 'npm',
        args: ['test'],
        summary: 'Validation failed: npm test',
      },
    });
    const listed = listBenchmarkRuns(workspaceRoot);

    assert.equal(run.validationResult.ok, false);
    assert.equal(listed.runs[0].validationResult.command, 'npm');
    assert.equal(listed.runs[0].validationResult.summary, 'Validation failed: npm test');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
