'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildModelFoundryStatus,
  FOUNDRY_PROOF_CAPABILITIES,
  runFoundryCandidateProofs,
  seedModelFoundryCandidate,
} = require('../core/model-foundry');
const { listBenchmarkRuns } = require('../core/benchmarks');

function makeWorkspace() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-model-foundry-'));
  const artifactsRoot = path.join(workspaceRoot, 'artifacts');
  fs.mkdirSync(artifactsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, 'dev_assistant.local.yaml'),
    `assistant_artifacts_root: ${artifactsRoot}\nassistant_model_foundry_root: ${path.join(artifactsRoot, 'model_foundry')}\n`,
    'utf8',
  );
  return { workspaceRoot, artifactsRoot };
}

test('buildModelFoundryStatus derives suggestions from benchmarks and reusable prompts', () => {
  const { workspaceRoot } = makeWorkspace();

  const status = buildModelFoundryStatus(workspaceRoot, {
    benchmarks: {
      runs: [
        {
          id: 'bench-1',
          status: 'pass',
          model: 'qwen2.5-coder:7b',
          modelProfileId: 'gs-dev-1-default',
          baseModel: 'qwen2.5-coder:7b',
          providerSource: 'ollama',
          taskMode: 'coder',
        },
      ],
    },
    learning: {
      reusablePrompts: [{ id: 'prompt-1' }],
    },
    readiness: {
      status: 'strong',
    },
  });

  assert.equal(status.ok, true);
  assert.ok(status.exists);
  assert.ok(status.suggested.some((candidate) => String(candidate.type || '') === 'route-bundle'));
  assert.ok(status.suggested.some((candidate) => String(candidate.type || '') === 'adapter-bundle'));
  assert.ok(status.suggested.some((candidate) => String(candidate.type || '') === 'checkpoint-merge'));
  assert.ok(status.suggested.some((candidate) => String(candidate.type || '') === 'prompt-distill'));
  assert.ok(status.suggested.some((candidate) => String(candidate.type || '') === 'self-host'));
  assert.equal(status.nextCandidateIdentity.wrappedProfileId, 'gs-dev-1-default');
  assert.equal(status.nextCandidateIdentity.benchmarkIdentity.id, 'bench-1');
});

test('seedModelFoundryCandidate persists a candidate and updates status', () => {
  const { workspaceRoot, artifactsRoot } = makeWorkspace();

  const result = seedModelFoundryCandidate(workspaceRoot, {
    candidate: {
      id: 'route-bundle:qwen',
      type: 'route-bundle',
      title: 'Promote qwen route bundle',
      summary: 'Capture the current local benchmark leader.',
      targetLanes: ['code-main'],
      safetyLevel: 'candidate',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status.candidateCount, 1);
  assert.equal(typeof result.candidate.modelProfileId, 'string');
  assert.equal(typeof result.candidate.workerVariantType, 'string');
  const candidatesRoot = path.join(artifactsRoot, 'model_foundry', 'candidates');
  assert.ok(fs.existsSync(candidatesRoot));
  assert.ok(fs.readdirSync(candidatesRoot).some((name) => name.endsWith('.json')));
});

test('seedModelFoundryCandidate updates an existing candidate instead of duplicating ids', () => {
  const { workspaceRoot, artifactsRoot } = makeWorkspace();

  const first = seedModelFoundryCandidate(workspaceRoot, {
    candidate: {
      id: 'route-bundle:qwen',
      type: 'route-bundle',
      title: 'Promote qwen route bundle',
      summary: 'Capture the current local benchmark leader.',
      targetLanes: ['code-main'],
      safetyLevel: 'candidate',
    },
  });
  const second = seedModelFoundryCandidate(workspaceRoot, {
    candidate: {
      id: 'route-bundle:qwen',
      type: 'route-bundle',
      title: 'Promote qwen route bundle',
      summary: 'Updated summary for the same candidate id.',
      targetLanes: ['code-main', 'review-verify'],
      safetyLevel: 'candidate',
    },
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.status.candidateCount, 1);
  assert.equal(second.candidate.id, 'route-bundle:qwen');
  assert.match(second.candidate.summary, /Updated summary/i);
  assert.equal(second.candidate.taskMode, '');

  const candidatesRoot = path.join(artifactsRoot, 'model_foundry', 'candidates');
  const files = fs.readdirSync(candidatesRoot).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1);
});

test('buildModelFoundryStatus dedupes legacy candidate files with the same id', () => {
  const { workspaceRoot, artifactsRoot } = makeWorkspace();
  const candidatesRoot = path.join(artifactsRoot, 'model_foundry', 'candidates');
  fs.mkdirSync(candidatesRoot, { recursive: true });

  fs.writeFileSync(path.join(candidatesRoot, 'older-route-bundle-qwen.json'), `${JSON.stringify({
    id: 'route-bundle:qwen',
    type: 'route-bundle',
    title: 'Promote qwen route bundle',
    summary: 'Older candidate payload.',
    createdAt: '2026-03-16T08:03:15.037Z',
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(candidatesRoot, 'newer-route-bundle-qwen.json'), `${JSON.stringify({
    id: 'route-bundle:qwen',
    type: 'route-bundle',
    title: 'Promote qwen route bundle',
    summary: 'Newest candidate payload.',
    createdAt: '2026-03-16T08:04:12.581Z',
    updatedAt: '2026-03-16T08:04:12.581Z',
  }, null, 2)}\n`, 'utf8');

  const status = buildModelFoundryStatus(workspaceRoot, {});
  assert.equal(status.candidateCount, 1);
  assert.equal(status.candidates.length, 1);
  assert.equal(status.candidates[0].id, 'route-bundle:qwen');
  assert.match(String(status.candidates[0].summary || ''), /Newest candidate payload/i);
});

test('runFoundryCandidateProofs records benchmark evidence and persists proof summary for a candidate', () => {
  const { workspaceRoot, artifactsRoot } = makeWorkspace();
  seedModelFoundryCandidate(workspaceRoot, {
    candidate: {
      id: 'route-bundle:qwen',
      type: 'route-bundle',
      title: 'Promote qwen route bundle',
      summary: 'Capture the current local benchmark leader.',
      modelProfileId: 'gs-dev-1-default',
      baseModel: 'qwen2.5-coder:14b',
      providerSource: 'ollama',
      recommendedModels: ['qwen2.5-coder:14b'],
      targetLanes: ['code-main'],
      safetyLevel: 'candidate',
    },
  });

  const result = runFoundryCandidateProofs(workspaceRoot, {
    candidateId: 'route-bundle:qwen',
    capabilitySpecs: FOUNDRY_PROOF_CAPABILITIES.slice(0, 2),
    runCommand(commandText) {
      return {
        command: commandText,
        ok: true,
        status: 0,
        signal: '',
        stdout: `passed ${commandText}`,
        stderr: '',
        durationMs: 25,
        summary: `passed ${commandText}`,
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.capabilityCount, 2);
  assert.equal(result.results[0].proof.status, 'verified');
  assert.equal(result.results[0].proof.verifiedCapabilityCount, 2);
  assert.equal(result.results[0].proof.benchmarkRunIds.length, 2);

  const benchmarks = listBenchmarkRuns(workspaceRoot);
  assert.equal(benchmarks.count, 2);
  assert.equal(benchmarks.runs.every((run) => String(run.baseModel || '') === 'qwen2.5-coder:14b'), true);

  const candidatesRoot = path.join(artifactsRoot, 'model_foundry', 'candidates');
  const candidateFile = fs.readdirSync(candidatesRoot)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(candidatesRoot, name))[0];
  const persistedCandidate = JSON.parse(fs.readFileSync(candidateFile, 'utf8'));
  assert.equal(persistedCandidate.proof.status, 'verified');
  assert.equal(persistedCandidate.proof.verifiedCapabilityCount, 2);
});

test('runFoundryCandidateProofs can dry-run the next suggested candidate without recording runs', () => {
  const { workspaceRoot } = makeWorkspace();
  const status = buildModelFoundryStatus(workspaceRoot, {
    benchmarks: {
      runs: [
        {
          id: 'bench-1',
          status: 'pass',
          model: 'qwen2.5-coder:7b',
          modelProfileId: 'gs-dev-1-default',
          baseModel: 'qwen2.5-coder:7b',
          providerSource: 'ollama',
          taskMode: 'coder',
        },
      ],
    },
  });

  const result = runFoundryCandidateProofs(workspaceRoot, {
    foundryStatus: status,
    dryRun: true,
    capabilitySpecs: FOUNDRY_PROOF_CAPABILITIES.slice(0, 1),
  });

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.results[0].proof.status, 'verified');
  assert.equal(listBenchmarkRuns(workspaceRoot).count, 0);
});
