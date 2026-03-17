'use strict';

const fs = require('fs');
const path = require('path');

const { getConfiguredAssistantModelFoundryRoot } = require('./assistant-paths');
const { buildBenchmarkIdentity } = require('./benchmarks');

function nowIso() {
  return new Date().toISOString();
}

function clipText(value, maxLength = 180) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}…` : text;
}

function slugify(value, fallback = 'item') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function ensureFoundryRoot(workspaceRoot) {
  const root = getConfiguredAssistantModelFoundryRoot(workspaceRoot);
  if (!root) {
    throw new Error('assistant_model_foundry_root is not configured. Set assistant_artifacts_root or assistant_model_foundry_root before using Model Foundry.');
  }
  fs.mkdirSync(path.join(root, 'candidates'), { recursive: true });
  return root;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function candidateSortValue(candidate = {}) {
  return String(candidate.updatedAt || candidate.createdAt || '');
}

function buildFoundryCandidateIdentity(candidate = {}) {
  const modelRole = String(candidate.modelRole || '').trim().toLowerCase();
  const wrappedProfileId = String(candidate.modelProfileId || candidate.wrappedProfileId || '').trim();
  const baseModel = String(candidate.baseModel || candidate.recommendedModels?.[0] || '').trim();
  const providerSource = String(candidate.providerSource || '').trim().toLowerCase();
  const taskMode = String(candidate.taskMode || '').trim().toLowerCase();
  const benchmarkId = Array.isArray(candidate.sourceBenchmarks)
    ? candidate.sourceBenchmarks.map((item) => String(item || '').trim()).find(Boolean) || ''
    : '';
  const benchmarkIdentity = benchmarkId || wrappedProfileId || baseModel || providerSource || taskMode
    ? buildBenchmarkIdentity({
        id: benchmarkId,
        wrappedProfileId,
        baseModel,
        providerSource,
        taskMode,
        model: candidate.recommendedModels?.[0] || baseModel,
      })
    : null;
  return {
    candidateId: String(candidate.id || '').trim(),
    modelRole,
    wrappedProfileId,
    baseModel,
    providerSource,
    taskMode,
    benchmarkIdentity,
    summary: [
      modelRole ? `role ${modelRole}` : '',
      wrappedProfileId ? `profile ${wrappedProfileId}` : '',
      providerSource && baseModel ? `${providerSource}:${baseModel}` : baseModel,
      taskMode ? `mode ${taskMode}` : '',
      benchmarkIdentity?.id ? `bench ${benchmarkIdentity.id}` : '',
    ].filter(Boolean).join(' | '),
  };
}

function attachFoundryIdentity(candidate = {}) {
  return {
    ...candidate,
    modelIdentity: buildFoundryCandidateIdentity(candidate),
  };
}

function listFoundryCandidateEntries(workspaceRoot) {
  const root = getConfiguredAssistantModelFoundryRoot(workspaceRoot);
  if (!root || !fs.existsSync(path.join(root, 'candidates'))) {
    return [];
  }
  return fs.readdirSync(path.join(root, 'candidates'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const filePath = path.join(root, 'candidates', name);
      const candidate = readJson(filePath);
      if (!candidate) {
        return null;
      }
      return {
        fileName: name,
        filePath,
        candidate,
      };
    })
    .filter(Boolean)
    .sort((left, right) => candidateSortValue(right.candidate).localeCompare(candidateSortValue(left.candidate)));
}

function listFoundryCandidates(workspaceRoot) {
  const seen = new Set();
  return listFoundryCandidateEntries(workspaceRoot)
    .filter((entry) => {
      const candidate = entry.candidate && typeof entry.candidate === 'object' ? entry.candidate : {};
      const candidateId = String(candidate.id || '').trim()
        || `${String(candidate.type || '').trim()}:${String(candidate.title || '').trim()}`.toLowerCase();
      if (!candidateId || seen.has(candidateId)) {
        return false;
      }
      seen.add(candidateId);
      return true;
    })
    .map((entry) => entry.candidate);
}

function deriveFoundrySuggestions(workspaceRoot, payload = {}) {
  const benchmarks = Array.isArray(payload.benchmarks?.runs) ? payload.benchmarks.runs : [];
  const benchmarkLeader = benchmarks.find((run) => String(run.status || '').trim().toLowerCase() === 'pass') || benchmarks[0] || null;
  const learning = payload.learning && typeof payload.learning === 'object' ? payload.learning : {};
  const readiness = payload.readiness && typeof payload.readiness === 'object' ? payload.readiness : {};
  const resourcePolicy = payload.resourcePolicy && typeof payload.resourcePolicy === 'object' ? payload.resourcePolicy : {};
  const candidates = [];

  if (benchmarkLeader) {
    candidates.push({
      id: `route-bundle:${slugify(benchmarkLeader.model || benchmarkLeader.name || 'leader', 'leader')}`,
      type: 'route-bundle',
      title: 'Promote benchmark leader into a route bundle',
      summary: clipText(`${benchmarkLeader.model || 'Current leader'} is the best recent coding route. Capture it as a reusable lane bundle before the next promotion.`),
      recommendedModels: [String(benchmarkLeader.model || '').trim()].filter(Boolean),
      sourceBenchmarks: [String(benchmarkLeader.id || benchmarkLeader.outputPath || '').trim()].filter(Boolean),
      targetLanes: ['code-main', 'repair-fast', 'review-verify'],
      safetyLevel: 'candidate',
      modelProfileId: String(benchmarkLeader.modelProfileId || benchmarkLeader.wrappedProfileId || '').trim(),
      baseModel: String(benchmarkLeader.baseModel || benchmarkLeader.model || '').trim(),
      taskMode: String(benchmarkLeader.taskMode || 'coder').trim().toLowerCase(),
      providerSource: String(benchmarkLeader.providerSource || '').trim().toLowerCase(),
    });
  }

  if (Number(resourcePolicy.memoryUsedPercent || payload.telemetry?.memoryUsedPercent || 0) >= 85) {
    candidates.push({
      id: 'low-memory-local-bundle',
      type: 'resource-bundle',
      title: 'Seed a low-memory local bundle',
      summary: 'Memory pressure is high, so the foundry should keep a lighter local route ready for code and review work.',
      recommendedModels: ['qwen2.5-coder:7b'],
      sourceBenchmarks: [],
      targetLanes: ['chat-fast', 'code-main'],
      safetyLevel: 'candidate',
    });
  }

  const reusablePromptCount = Array.isArray(learning.reusablePrompts) ? learning.reusablePrompts.length : 0;
  if (reusablePromptCount > 0) {
    candidates.push({
      id: 'prompt-distillation-bundle',
      type: 'prompt-distill',
      title: 'Distill trusted prompt patterns into a reusable bundle',
      summary: `There are ${reusablePromptCount} trusted prompt pattern(s). Capture them as a distillation bundle before the next tuning pass.`,
      recommendedModels: [],
      sourceBenchmarks: [],
      targetLanes: ['plan-reasoning', 'ops-summary'],
      safetyLevel: 'lab-only',
    });
  }

  if (String(readiness.status || '').trim().toLowerCase() === 'strong') {
    candidates.push({
      id: 'self-host-candidate-bundle',
      type: 'self-host',
      title: 'Seed a self-host route candidate',
      summary: 'The baseline is strong enough to compare a self-host route bundle against the current production path in a lab.',
      recommendedModels: [String(benchmarkLeader?.model || '').trim()].filter(Boolean),
      sourceBenchmarks: [String(benchmarkLeader?.id || '').trim()].filter(Boolean),
      targetLanes: ['code-main', 'repair-fast'],
      safetyLevel: 'lab-only',
    });
  }

  return candidates;
}

function buildModelFoundryStatus(workspaceRoot, payload = {}) {
  const root = getConfiguredAssistantModelFoundryRoot(workspaceRoot) || '';
  const candidates = listFoundryCandidates(workspaceRoot).map(attachFoundryIdentity);
  const suggested = deriveFoundrySuggestions(workspaceRoot, payload).map(attachFoundryIdentity);
  const nextCandidate = candidates[0] || suggested[0] || null;
  const nextCandidateIdentity = nextCandidate?.modelIdentity || null;
  return {
    ok: true,
    root,
    exists: !!root,
    candidateCount: candidates.length,
    candidates: candidates.slice(0, 8),
    suggested: suggested.slice(0, 6),
    nextCandidate,
    nextCandidateIdentity,
    summary: nextCandidate
      ? clipText([
          nextCandidate.summary || nextCandidate.title || 'Model Foundry has a next candidate ready.',
          nextCandidateIdentity?.summary || '',
        ].filter(Boolean).join(' '))
      : 'Model Foundry is waiting for stronger benchmark or learning signals.',
  };
}

function seedModelFoundryCandidate(workspaceRoot, payload = {}) {
  const root = ensureFoundryRoot(workspaceRoot);
  const candidate = payload.candidate && typeof payload.candidate === 'object' ? payload.candidate : {};
  const existingEntry = listFoundryCandidateEntries(workspaceRoot).find((entry) => {
    const existingCandidate = entry.candidate && typeof entry.candidate === 'object' ? entry.candidate : {};
    return String(existingCandidate.id || '').trim() === String(candidate.id || '').trim();
  }) || null;
  const createdAt = existingEntry?.candidate?.createdAt || nowIso();
  const updatedAt = nowIso();
  const normalized = {
    id: String(candidate.id || `foundry-${slugify(candidate.title || candidate.type || 'candidate', 'candidate')}-${Date.now()}`).trim(),
    type: String(candidate.type || 'route-bundle').trim(),
    title: String(candidate.title || 'Model Foundry candidate').trim(),
    summary: clipText(candidate.summary || candidate.title || 'Model Foundry candidate'),
    recommendedModels: Array.isArray(candidate.recommendedModels) ? candidate.recommendedModels.map((item) => String(item || '').trim()).filter(Boolean) : [],
    sourceBenchmarks: Array.isArray(candidate.sourceBenchmarks) ? candidate.sourceBenchmarks.map((item) => String(item || '').trim()).filter(Boolean) : [],
    targetLanes: Array.isArray(candidate.targetLanes) ? candidate.targetLanes.map((item) => String(item || '').trim()).filter(Boolean) : [],
    modelProfileId: String(candidate.modelProfileId || '').trim(),
    baseModel: String(candidate.baseModel || '').trim(),
    taskMode: String(candidate.taskMode || '').trim().toLowerCase(),
    providerSource: String(candidate.providerSource || '').trim().toLowerCase(),
    safetyLevel: String(candidate.safetyLevel || 'candidate').trim().toLowerCase(),
    notes: String(candidate.notes || '').trim(),
    createdAt,
    updatedAt,
    workspaceRoot: String(workspaceRoot || '').trim(),
  };
  const filePath = existingEntry?.filePath
    || path.join(root, 'candidates', `${createdAt.replace(/[:.]/g, '-')}-${slugify(normalized.id, 'candidate')}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return {
    ok: true,
    candidate: normalized,
    outputPath: filePath,
    status: buildModelFoundryStatus(workspaceRoot, payload.context || {}),
  };
}

module.exports = {
  buildModelFoundryStatus,
  deriveFoundrySuggestions,
  listFoundryCandidates,
  seedModelFoundryCandidate,
};
