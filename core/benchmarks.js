'use strict';

const fs = require('fs');
const path = require('path');

const { getConfiguredAssistantBenchmarkRoot } = require('./assistant-paths');

function nowIso() {
  return new Date().toISOString();
}

function ensureBenchmarkRoot(workspaceRoot) {
  const root = getConfiguredAssistantBenchmarkRoot(workspaceRoot);
  if (!root) {
    throw new Error('assistant_benchmark_root is not configured. Set assistant_artifacts_root or assistant_benchmark_root before running benchmarks.');
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function benchmarkFileName(name) {
  const safe = String(name || 'benchmark')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'benchmark';
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${safe}.json`;
}

function buildBenchmarkIdentity(payload = {}) {
  const wrappedProfileId = String(
    payload.wrappedProfileId
    || payload.modelProfileId
    || payload.profileId
    || '',
  ).trim();
  const baseModel = String(payload.baseModel || payload.model || '').trim();
  const providerSource = String(payload.providerSource || '').trim().toLowerCase();
  const taskMode = String(payload.taskMode || '').trim().toLowerCase();
  const modelRole = String(payload.modelRole || '').trim().toLowerCase();
  const id = String(payload.id || payload.outputPath || '').trim();
  return {
    id,
    modelRole,
    wrappedProfileId,
    baseModel,
    providerSource,
    taskMode,
    summary: [
      modelRole ? `role ${modelRole}` : '',
      id ? `bench ${id}` : '',
      wrappedProfileId ? `profile ${wrappedProfileId}` : '',
      providerSource && baseModel ? `${providerSource}:${baseModel}` : baseModel,
      taskMode ? `mode ${taskMode}` : '',
    ].filter(Boolean).join(' | '),
  };
}

function listBenchmarkRuns(workspaceRoot) {
  const root = getConfiguredAssistantBenchmarkRoot(workspaceRoot);
  if (!root || !fs.existsSync(root)) {
    return {
      ok: true,
      benchmarkRoot: root || '',
      runs: [],
      count: 0,
      configured: !!root,
    };
  }
  const runs = fs.readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const fullPath = path.join(root, name);
      try {
        const payload = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        return payload && typeof payload === 'object'
          ? {
              ...payload,
              outputPath: payload.outputPath || fullPath,
              benchmarkIdentity: buildBenchmarkIdentity({
                ...payload,
                outputPath: payload.outputPath || fullPath,
              }),
            }
          : null;
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => String(right.startedAt || '').localeCompare(String(left.startedAt || '')));

  return {
    ok: true,
    benchmarkRoot: root,
    runs,
    count: runs.length,
    configured: true,
  };
}

function recordBenchmarkRun(workspaceRoot, payload = {}) {
  const root = ensureBenchmarkRoot(workspaceRoot);
  const startedAt = String(payload.startedAt || nowIso());
  const completedAt = String(payload.completedAt || nowIso());
  const outputPath = path.join(root, benchmarkFileName(payload.name || payload.recipe || payload.taskId || 'run'));
  const benchmark = {
    id: String(payload.id || path.basename(outputPath, '.json')),
    name: String(payload.name || payload.recipe || payload.taskId || 'Benchmark').trim(),
    model: String(payload.model || '').trim(),
    modelProfileId: String(payload.modelProfileId || payload.profileId || '').trim(),
    wrappedProfileId: String(payload.wrappedProfileId || payload.modelProfileId || payload.profileId || '').trim(),
    baseModel: String(payload.baseModel || '').trim(),
    taskMode: String(payload.taskMode || '').trim().toLowerCase(),
    providerSource: String(payload.providerSource || '').trim().toLowerCase(),
    benchmarkTags: Array.isArray(payload.benchmarkTags) ? payload.benchmarkTags.map((item) => String(item || '').trim()).filter(Boolean) : [],
    runtime: String(payload.runtime || '').trim(),
    status: String(payload.status || (payload.ok === false ? 'fail' : 'pass')).trim(),
    ok: payload.ok !== false,
    startedAt,
    completedAt,
    taskId: String(payload.taskId || '').trim(),
    recipe: String(payload.recipe || '').trim(),
    workspaceRoot: String(payload.workspaceRoot || workspaceRoot || '').trim(),
    targetRoot: String(payload.targetRoot || '').trim(),
    labRoot: String(payload.labRoot || '').trim(),
    passRate: Number(payload.passRate || 0),
    latencyMs: Number(payload.latencyMs || 0),
    repairDepth: Number(payload.repairDepth || 0),
    approvalCount: Number(payload.approvalCount || 0),
    summary: String(payload.summary || '').trim(),
    artifactPaths: Array.isArray(payload.artifactPaths) ? payload.artifactPaths.map((item) => String(item || '')).filter(Boolean) : [],
    rawResult: payload.rawResult && typeof payload.rawResult === 'object' ? payload.rawResult : {},
    outputPath,
  };
  benchmark.benchmarkIdentity = buildBenchmarkIdentity(benchmark);
  fs.writeFileSync(outputPath, `${JSON.stringify(benchmark, null, 2)}\n`, 'utf8');
  return benchmark;
}

module.exports = {
  buildBenchmarkIdentity,
  ensureBenchmarkRoot,
  listBenchmarkRuns,
  recordBenchmarkRun,
};
