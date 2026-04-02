'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const { getConfiguredAssistantModelFoundryRoot } = require('./assistant-paths');
const { buildBenchmarkIdentity, recordBenchmarkRun } = require('./benchmarks');

const FOUNDRY_PROOF_CAPABILITIES = Object.freeze([
  Object.freeze({
    id: 'ask-plan',
    label: 'Ask/plan',
    taskMode: 'planner',
    recipe: 'candidate-proof:ask-plan',
    benchmarkTags: ['ask-plan', 'candidate-proof', 'engine-proof'],
    commands: ['npm run test:ask-proof', 'npm run test:plan-proof'],
  }),
  Object.freeze({
    id: 'code',
    label: 'Code',
    taskMode: 'coder',
    recipe: 'candidate-proof:code',
    benchmarkTags: ['code', 'candidate-proof', 'engine-proof'],
    commands: ['npm run test:code-proof'],
  }),
  Object.freeze({
    id: 'repair',
    label: 'Repair',
    taskMode: 'repair',
    recipe: 'candidate-proof:repair',
    benchmarkTags: ['repair', 'candidate-proof', 'engine-proof'],
    commands: ['npm run test:repair-proof'],
  }),
  Object.freeze({
    id: 'review-validate',
    label: 'Review/validate',
    taskMode: 'validator',
    recipe: 'candidate-proof:review-validate',
    benchmarkTags: ['review-validate', 'candidate-proof', 'engine-proof'],
    commands: ['npm run test:review-proof'],
  }),
  Object.freeze({
    id: 'docs-guided',
    label: 'Docs-guided',
    taskMode: 'research',
    recipe: 'candidate-proof:docs-guided',
    benchmarkTags: ['docs-guided', 'candidate-proof', 'engine-proof'],
    commands: ['npm run test:docs-proof'],
  }),
  Object.freeze({
    id: 'scaffold-create',
    label: 'Scaffold/create',
    taskMode: 'coder',
    recipe: 'candidate-proof:scaffold-create',
    benchmarkTags: ['scaffold', 'create-project', 'candidate-proof', 'engine-proof'],
    commands: ['npm run test:code-proof'],
  }),
  Object.freeze({
    id: 'clone-lab-autonomy',
    label: 'Clone-lab autonomy',
    taskMode: 'coder',
    recipe: 'candidate-proof:clone-lab-autonomy',
    benchmarkTags: ['clone-lab', 'autonomy-proof', 'candidate-proof', 'engine-proof'],
    commands: ['npm run test:self-improve-proof'],
  }),
]);

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

function shortText(value, maxLength = 220) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 3).trim()}...` : text;
}

function clipCommandOutput(value, maxLength = 4000) {
  const text = String(value || '');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? text.slice(text.length - maxLength) : text;
}

function tailSummary(stdout = '', stderr = '') {
  const lines = `${String(stdout || '')}\n${String(stderr || '')}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

function resolveCommand(command = '') {
  const normalized = String(command || '').trim();
  if (process.platform === 'win32' && /^[a-z0-9_-]+$/i.test(normalized) && !/\.(cmd|bat|exe)$/i.test(normalized)) {
    if (normalized.toLowerCase() === 'npm') {
      return 'npm.cmd';
    }
    if (normalized.toLowerCase() === 'npx') {
      return 'npx.cmd';
    }
  }
  return normalized;
}

function runShellCommand(commandText, cwd, env = process.env) {
  const startedAt = Date.now();
  let result;
  if (process.platform === 'win32') {
    result = childProcess.spawnSync('cmd.exe', ['/d', '/s', '/c', commandText], {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 8,
      windowsHide: true,
    });
  } else {
    result = childProcess.spawnSync('sh', ['-lc', commandText], {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 8,
    });
  }
  return {
    command: commandText,
    ok: result?.status === 0,
    status: Number.isFinite(result?.status) ? result.status : null,
    signal: result?.signal || '',
    stdout: String(result?.stdout || ''),
    stderr: String(result?.stderr || ''),
    durationMs: Date.now() - startedAt,
    summary: tailSummary(result?.stdout, result?.stderr),
  };
}

function normalizeFoundryProofCapabilitySpecs(capabilitySpecs = FOUNDRY_PROOF_CAPABILITIES) {
  return Array.isArray(capabilitySpecs)
    ? capabilitySpecs
      .map((capability) => ({
        id: String(capability?.id || '').trim().toLowerCase(),
        label: String(capability?.label || capability?.id || 'Capability').trim(),
        taskMode: String(capability?.taskMode || '').trim().toLowerCase(),
        recipe: String(capability?.recipe || capability?.id || 'candidate-proof').trim(),
        benchmarkTags: Array.isArray(capability?.benchmarkTags)
          ? capability.benchmarkTags.map((item) => String(item || '').trim()).filter(Boolean)
          : [],
        commands: Array.isArray(capability?.commands)
          ? capability.commands.map((item) => String(item || '').trim()).filter(Boolean)
          : [],
      }))
      .filter((capability) => capability.id && capability.taskMode && capability.commands.length > 0)
    : [];
}

function normalizeFoundryProofCandidate(candidate = {}) {
  const modelIdentity = candidate?.modelIdentity && typeof candidate.modelIdentity === 'object'
    ? candidate.modelIdentity
    : buildFoundryCandidateIdentity(candidate);
  const baseModel = String(candidate.baseModel || candidate.recommendedModels?.[0] || modelIdentity?.baseModel || '').trim();
  const providerSource = String(candidate.providerSource || modelIdentity?.providerSource || 'ollama').trim().toLowerCase() || 'ollama';
  const modelProfileId = String(candidate.modelProfileId || candidate.wrappedProfileId || modelIdentity?.wrappedProfileId || '').trim();
  return {
    ...candidate,
    modelIdentity,
    baseModel,
    providerSource,
    modelProfileId,
    label: String(candidate.title || candidate.label || candidate.id || baseModel || 'Foundry candidate').trim(),
  };
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
  const workerVariantType = String(candidate.workerVariantType || candidate.variantType || candidate.type || '').trim().toLowerCase();
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
    workerVariantType,
    benchmarkIdentity,
    summary: [
      modelRole ? `role ${modelRole}` : '',
      wrappedProfileId ? `profile ${wrappedProfileId}` : '',
      providerSource && baseModel ? `${providerSource}:${baseModel}` : baseModel,
      taskMode ? `mode ${taskMode}` : '',
      workerVariantType ? `variant ${workerVariantType}` : '',
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

function getFoundryCandidateEntry(workspaceRoot, candidateId = '') {
  const normalizedCandidateId = String(candidateId || '').trim();
  if (!normalizedCandidateId) {
    return null;
  }
  return listFoundryCandidateEntries(workspaceRoot).find((entry) => {
    const candidate = entry.candidate && typeof entry.candidate === 'object' ? entry.candidate : {};
    return String(candidate.id || '').trim() === normalizedCandidateId;
  }) || null;
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
    const baseModel = String(benchmarkLeader.baseModel || benchmarkLeader.model || '').trim();
    const providerSource = String(benchmarkLeader.providerSource || '').trim().toLowerCase();
    const normalizedModel = baseModel.toLowerCase();
    const workerFamily = normalizedModel.startsWith('deepseek')
      ? 'deepseek-coder'
      : (normalizedModel.startsWith('qwen3') ? 'qwen3' : (normalizedModel.startsWith('qwen') ? 'qwen' : ''));
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
      baseModel,
      taskMode: String(benchmarkLeader.taskMode || 'coder').trim().toLowerCase(),
      providerSource,
      workerFamily,
      workerVariantType: 'route-bundle',
    });
    if (providerSource === 'ollama' && workerFamily) {
      candidates.push({
        id: `adapter-bundle:${slugify(baseModel, workerFamily)}`,
        type: 'adapter-bundle',
        title: 'Promote an adapter-backed local worker variant',
        summary: clipText(`Export a supervised ${workerFamily} adapter bundle from the current benchmark leader so it can be benchmarked and promoted with rollback.`),
        recommendedModels: [baseModel].filter(Boolean),
        sourceBenchmarks: [String(benchmarkLeader.id || benchmarkLeader.outputPath || '').trim()].filter(Boolean),
        targetLanes: ['code-main', 'repair-fast'],
        safetyLevel: 'candidate',
        modelProfileId: String(benchmarkLeader.modelProfileId || benchmarkLeader.wrappedProfileId || '').trim(),
        baseModel,
        taskMode: 'coder',
        providerSource,
        workerFamily,
        workerVariantType: 'adapter-export',
      });
      candidates.push({
        id: `checkpoint-merge:${slugify(baseModel, workerFamily)}-lab`,
        type: 'checkpoint-merge',
        title: 'Prepare a tensor-level checkpoint merge in a lab',
        summary: clipText(`Create a lab-only tensor merge candidate for ${baseModel} so a merged worker variant can be benchmarked before promotion.`),
        recommendedModels: [baseModel].filter(Boolean),
        sourceBenchmarks: [String(benchmarkLeader.id || benchmarkLeader.outputPath || '').trim()].filter(Boolean),
        targetLanes: ['code-main'],
        safetyLevel: 'lab-only',
        modelProfileId: String(benchmarkLeader.modelProfileId || benchmarkLeader.wrappedProfileId || '').trim(),
        baseModel,
        taskMode: 'coder',
        providerSource,
        workerFamily,
        workerVariantType: 'checkpoint-merge',
      });
    }
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
          nextCandidate?.proof?.summary || '',
        ].filter(Boolean).join(' '))
      : 'Model Foundry is waiting for stronger benchmark or learning signals.',
  };
}

function updateFoundryCandidateProof(workspaceRoot, candidateId = '', proof = {}) {
  const entry = getFoundryCandidateEntry(workspaceRoot, candidateId);
  if (!entry) {
    return {
      ok: false,
      persisted: false,
      message: `Foundry candidate ${candidateId} was not found for proof persistence.`,
    };
  }
  const candidate = entry.candidate && typeof entry.candidate === 'object' ? entry.candidate : {};
  const nextProof = {
    ...(candidate.proof && typeof candidate.proof === 'object' ? candidate.proof : {}),
    ...(proof && typeof proof === 'object' ? proof : {}),
    updatedAt: String(proof?.updatedAt || nowIso()),
  };
  const updatedCandidate = {
    ...candidate,
    proof: nextProof,
    updatedAt: nowIso(),
  };
  fs.writeFileSync(entry.filePath, `${JSON.stringify(updatedCandidate, null, 2)}\n`, 'utf8');
  return {
    ok: true,
    persisted: true,
    candidate: updatedCandidate,
    outputPath: entry.filePath,
  };
}

function resolveFoundryProofCandidates(workspaceRoot, options = {}) {
  const storedCandidates = listFoundryCandidates(workspaceRoot).map(attachFoundryIdentity);
  const foundryStatus = options.foundryStatus && typeof options.foundryStatus === 'object'
    ? options.foundryStatus
    : null;
  const nextCandidate = foundryStatus?.nextCandidate && typeof foundryStatus.nextCandidate === 'object'
    ? attachFoundryIdentity(foundryStatus.nextCandidate)
    : null;
  if (options.all === true) {
    return storedCandidates.map(normalizeFoundryProofCandidate);
  }
  const candidateId = String(options.candidateId || '').trim();
  if (candidateId) {
    const explicit = storedCandidates.find((candidate) => String(candidate.id || '').trim() === candidateId)
      || (nextCandidate && String(nextCandidate.id || '').trim() === candidateId ? nextCandidate : null);
    return explicit ? [normalizeFoundryProofCandidate(explicit)] : [];
  }
  if (storedCandidates.length > 0) {
    return [normalizeFoundryProofCandidate(storedCandidates[0])];
  }
  return nextCandidate ? [normalizeFoundryProofCandidate(nextCandidate)] : [];
}

function executeFoundryCapabilityProof(workspaceRoot, candidate = {}, capability = {}, options = {}) {
  const commandRunner = typeof options.runCommand === 'function'
    ? options.runCommand
    : (commandText, cwd) => runShellCommand(commandText, cwd, options.env || process.env);
  const benchmarkTagSet = new Set([
    ...capability.benchmarkTags,
    `candidate-${slugify(candidate.id || candidate.label || 'candidate', 'candidate')}`,
    `proof-${capability.id}`,
  ]);
  if (options.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      candidateId: String(candidate.id || '').trim(),
      capabilityId: capability.id,
      label: capability.label,
      commands: capability.commands.slice(),
      benchmarkTags: Array.from(benchmarkTagSet),
    };
  }

  const commandResults = [];
  for (const commandText of capability.commands) {
    const result = commandRunner(commandText, workspaceRoot, candidate, capability);
    commandResults.push({
      command: commandText,
      ok: result?.ok === true,
      status: Number.isFinite(result?.status) ? result.status : null,
      signal: String(result?.signal || '').trim(),
      stdout: String(result?.stdout || ''),
      stderr: String(result?.stderr || ''),
      durationMs: Number(result?.durationMs || 0),
      summary: String(result?.summary || '').trim(),
    });
    if (result?.ok !== true) {
      break;
    }
  }

  const ok = commandResults.every((result) => result.ok === true);
  const totalDurationMs = commandResults.reduce((sum, result) => sum + Number(result.durationMs || 0), 0);
  const stdout = clipCommandOutput(commandResults.map((result) => result.stdout).filter(Boolean).join('\n'));
  const stderr = clipCommandOutput(commandResults.map((result) => result.stderr).filter(Boolean).join('\n'));
  const summary = ok
    ? `${candidate.label} passed ${capability.label.toLowerCase()} proof.`
    : shortText(commandResults.find((result) => result.ok !== true)?.summary || `${candidate.label} failed ${capability.label.toLowerCase()} proof.`);
  const benchmark = recordBenchmarkRun(workspaceRoot, {
    id: `${slugify(candidate.id || candidate.label || 'candidate', 'candidate')}-${capability.id}-${Date.now()}`,
    name: `${candidate.label} ${capability.label} proof`,
    model: candidate.baseModel,
    modelProfileId: candidate.modelProfileId,
    wrappedProfileId: candidate.modelProfileId,
    baseModel: candidate.baseModel,
    providerSource: candidate.providerSource,
    taskMode: capability.taskMode,
    benchmarkTags: Array.from(benchmarkTagSet),
    runtime: 'engine-cli-model-proof',
    recipe: capability.recipe,
    workspaceRoot,
    targetRoot: workspaceRoot,
    labRoot: String(options.labRoot || '').trim(),
    status: ok ? 'pass' : 'fail',
    ok,
    passRate: ok ? 100 : 0,
    latencyMs: totalDurationMs,
    summary,
    validationResult: {
      required: true,
      ok,
      summary,
      commandCount: commandResults.length,
      commands: commandResults.map((result) => result.command),
    },
    rawResult: {
      commands: commandResults.map((result) => ({
        command: result.command,
        ok: result.ok,
        status: result.status,
        signal: result.signal,
        durationMs: result.durationMs,
        summary: result.summary,
        stdout: clipCommandOutput(result.stdout, 1200),
        stderr: clipCommandOutput(result.stderr, 1200),
      })),
      stdout,
      stderr,
    },
  });

  return {
    ok,
    dryRun: false,
    candidateId: String(candidate.id || '').trim(),
    capabilityId: capability.id,
    label: capability.label,
    commands: capability.commands.slice(),
    benchmarkId: String(benchmark.id || benchmark.outputPath || '').trim(),
    outputPath: String(benchmark.outputPath || '').trim(),
    benchmarkTags: Array.from(benchmarkTagSet),
    durationMs: totalDurationMs,
    summary,
  };
}

function summarizeFoundryCandidateProof(candidate = {}, capabilityResults = [], capabilitySpecs = []) {
  const resultsByCapability = new Map(
    capabilityResults.map((result) => [String(result.capabilityId || '').trim(), result]),
  );
  const blockedCapabilities = [];
  const missingCapabilities = [];
  let verifiedCapabilityCount = 0;

  capabilitySpecs.forEach((capability) => {
    const result = resultsByCapability.get(capability.id) || null;
    if (!result) {
      missingCapabilities.push(capability.label);
      return;
    }
    if (result.ok === true || result.dryRun === true) {
      verifiedCapabilityCount += 1;
      return;
    }
    blockedCapabilities.push(capability.label);
  });

  const capabilityCount = capabilitySpecs.length;
  const status = capabilityCount > 0 && verifiedCapabilityCount === capabilityCount
    ? 'verified'
    : blockedCapabilities.length > 0
      ? 'blocked'
      : 'next';
  const summary = status === 'verified'
    ? `${candidate.label} now proves ${verifiedCapabilityCount}/${capabilityCount} tracked candidate capabilities.`
    : status === 'blocked'
      ? `${candidate.label} is blocked on ${blockedCapabilities.join(', ')}.`
      : `${candidate.label} proves ${verifiedCapabilityCount}/${capabilityCount} tracked candidate capabilities.`;
  return {
    status,
    capabilityCount,
    verifiedCapabilityCount,
    missingCapabilities,
    blockedCapabilities,
    benchmarkRunIds: capabilityResults.map((result) => String(result.benchmarkId || '').trim()).filter(Boolean),
    summary,
    updatedAt: nowIso(),
  };
}

function runFoundryCandidateProofs(workspaceRoot, options = {}) {
  const candidates = resolveFoundryProofCandidates(workspaceRoot, options);
  if (candidates.length === 0) {
    return {
      ok: false,
      message: options.candidateId
        ? `No Model Foundry candidate matched ${options.candidateId}.`
        : 'No Model Foundry candidate is available for proof.',
      candidates: [],
      results: [],
    };
  }

  const capabilityFilter = Array.isArray(options.capabilityIds)
    ? options.capabilityIds.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const capabilitySpecs = normalizeFoundryProofCapabilitySpecs(options.capabilitySpecs)
    .filter((capability) => capabilityFilter.length === 0 || capabilityFilter.includes(capability.id));
  if (capabilitySpecs.length === 0) {
    return {
      ok: false,
      message: 'No candidate proof capabilities were selected.',
      candidates,
      results: [],
    };
  }

  const results = candidates.map((candidate) => {
    const capabilityResults = capabilitySpecs.map((capability) => executeFoundryCapabilityProof(workspaceRoot, candidate, capability, options));
    const proof = summarizeFoundryCandidateProof(candidate, capabilityResults, capabilitySpecs);
    const persistedProof = options.dryRun === true
      ? { ok: true, persisted: false }
      : updateFoundryCandidateProof(workspaceRoot, candidate.id, proof);
    return {
      candidate,
      capabilityResults,
      proof,
      persistedProof,
    };
  });

  return {
    ok: results.every((result) => result.proof.status === 'verified' || options.dryRun === true),
    dryRun: options.dryRun === true,
    candidateCount: results.length,
    capabilityCount: capabilitySpecs.length,
    candidates: results.map((result) => result.candidate),
    results,
    summary: shortText(results.map((result) => result.proof.summary).join(' '), 260),
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
    workerFamily: String(candidate.workerFamily || '').trim(),
    workerVariantType: String(candidate.workerVariantType || candidate.variantType || candidate.type || '').trim().toLowerCase(),
    adapterArtifact: String(candidate.adapterArtifact || '').trim(),
    checkpointMergeArtifact: String(candidate.checkpointMergeArtifact || '').trim(),
    ollamaModelName: String(candidate.ollamaModelName || candidate.ollamaModel || '').trim(),
    rollbackSource: String(candidate.rollbackSource || '').trim(),
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
  FOUNDRY_PROOF_CAPABILITIES,
  buildModelFoundryStatus,
  deriveFoundrySuggestions,
  listFoundryCandidates,
  runFoundryCandidateProofs,
  seedModelFoundryCandidate,
};
