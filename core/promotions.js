'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const { buildAcceptanceControlSummary, readLatestAcceptanceReport, summarizeAcceptanceReport } = require('./acceptance-report');
const { getConfiguredAssistantPromotionsRoot } = require('./assistant-paths');
const { buildBenchmarkIdentity, listBenchmarkRuns } = require('./benchmarks');
const { resolveExecutionModelRole, resolveModelProfileSelection, resolveTaskLoopLane } = require('./engine-contract');
const { listFoundryCandidates } = require('./model-foundry');
const { resolveRouteTaskMode } = require('./route-schema');
const { buildLocalModelGuardrailDecision } = require('./training-tuning');
const { ensureDirectory, isWithin, nowIso, randomId, readJsonFile, writeJsonFileAtomic } = require('./utils');
const { configPathForWorkspace, readAssistantConfig, writeAssistantModelSettings } = require('../host/assistant-config');

const CANDIDATES_FILE = 'candidates.json';
const HISTORY_FILE = 'history.json';
const BACKUPS_DIR = 'backups';
const DEBUG_DIR = 'debug';
const LAB_META_FILE = '.gos-lab.json';
const INTERNAL_PROMOTION_PATHS = new Set([
  '.gos-lab.json',
]);
const LOCAL_PROVIDER_SOURCES = new Set(['huggingface-local', 'lmstudio', 'local', 'ollama']);
const LOCAL_MODEL_PROOF_CAPABILITIES = Object.freeze([
  { id: 'ask-plan', label: 'Ask/plan' },
  { id: 'code', label: 'Code' },
  { id: 'repair', label: 'Repair' },
  { id: 'review-validate', label: 'Review/validate' },
  { id: 'docs-guided', label: 'Docs-guided' },
  { id: 'scaffold-create', label: 'Scaffold/create' },
  { id: 'clone-lab-autonomy', label: 'Clone-lab autonomy' },
]);
const DOCS_GUIDED_PROOF_TAGS = Object.freeze([
  'approved-docs',
  'docs',
  'docs-guided',
  'docs-scout',
  'research-docs',
  'trusted-docs',
]);
const SCAFFOLD_PROOF_TAGS = Object.freeze([
  'builder',
  'builder-proof',
  'create-project',
  'create_project',
  'recipe',
  'scaffold',
]);
const AUTONOMY_PROOF_TAGS = Object.freeze([
  'autonomy',
  'autonomy-proof',
  'autonomyproof',
  'clone-lab',
  'clone_lab',
  'lab-autonomy',
]);

function normalizeWorkspacePath(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  return path.resolve(text).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function slugify(value, fallback = 'candidate') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function ensurePromotionsRoot(workspaceRoot) {
  const root = getConfiguredAssistantPromotionsRoot(workspaceRoot);
  if (!root) {
    throw new Error('assistant_promotions_root is not configured. Set assistant_artifacts_root or assistant_promotions_root before using promotion rings.');
  }
  ensureDirectory(root);
  ensureDirectory(path.join(root, BACKUPS_DIR));
  ensureDirectory(path.join(root, DEBUG_DIR));
  return root;
}

function candidatesPath(workspaceRoot) {
  return path.join(ensurePromotionsRoot(workspaceRoot), CANDIDATES_FILE);
}

function historyPath(workspaceRoot) {
  return path.join(ensurePromotionsRoot(workspaceRoot), HISTORY_FILE);
}

function backupRoot(workspaceRoot, backupId) {
  return path.join(ensurePromotionsRoot(workspaceRoot), BACKUPS_DIR, backupId);
}

function debugOutputRoot(workspaceRoot) {
  return path.join(ensurePromotionsRoot(workspaceRoot), DEBUG_DIR);
}

function readCandidates(workspaceRoot) {
  const current = readJsonFile(candidatesPath(workspaceRoot), []);
  return Array.isArray(current) ? current : [];
}

function writeCandidates(workspaceRoot, candidates) {
  writeJsonFileAtomic(candidatesPath(workspaceRoot), Array.isArray(candidates) ? candidates : []);
}

function readHistory(workspaceRoot) {
  const current = readJsonFile(historyPath(workspaceRoot), []);
  return Array.isArray(current) ? current : [];
}

function writeHistory(workspaceRoot, history) {
  writeJsonFileAtomic(historyPath(workspaceRoot), Array.isArray(history) ? history.slice(0, 120) : []);
}

function appendHistory(workspaceRoot, entry) {
  const history = readHistory(workspaceRoot);
  history.unshift({
    id: String(entry?.id || randomId('promotion_history')),
    recordedAt: String(entry?.recordedAt || nowIso()),
    ...entry,
  });
  writeHistory(workspaceRoot, history);
}

function readLabMetadata(labRoot) {
  const metaPath = path.join(String(labRoot || ''), LAB_META_FILE);
  return readJsonFile(metaPath, {});
}

function normalizeRelativePath(relativePath) {
  return String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

function isInternalPromotionPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    return true;
  }
  if (INTERNAL_PROMOTION_PATHS.has(normalized)) {
    return true;
  }
  return normalized.startsWith('.gos-lab-recipes/');
}

function sanitizeTargetPath(rootPath, relativePath) {
  const clean = normalizeRelativePath(relativePath);
  if (!clean) {
    return null;
  }
  const resolved = path.resolve(rootPath, clean);
  if (!isWithin(rootPath, resolved)) {
    return null;
  }
  return {
    clean,
    resolved,
  };
}

function parseGitStatusLine(line) {
  const raw = String(line || '').trimEnd();
  if (!raw) {
    return [];
  }
  const statusCode = raw.slice(0, 2).trim() || raw.slice(0, 1).trim();
  const remainder = raw.slice(3).trim();
  if (!remainder) {
    return [];
  }
  if (statusCode.startsWith('R') && remainder.includes(' -> ')) {
    const [fromPath, toPath] = remainder.split(' -> ');
    return [
      { path: normalizeRelativePath(fromPath), status: 'deleted' },
      { path: normalizeRelativePath(toPath), status: 'modified' },
    ];
  }
  const normalizedStatus = statusCode.includes('D')
    ? 'deleted'
    : statusCode.includes('A') || statusCode.includes('?')
      ? 'added'
      : 'modified';
  return [{ path: normalizeRelativePath(remainder), status: normalizedStatus }];
}

function listFilesRecursive(rootPath, prefix = '') {
  const fullRoot = prefix ? path.join(rootPath, prefix) : rootPath;
  if (!fs.existsSync(fullRoot)) {
    return [];
  }
  const results = [];
  const entries = fs.readdirSync(fullRoot, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = normalizeRelativePath(path.join(prefix, entry.name));
    if (isInternalPromotionPath(relativePath)) {
      continue;
    }
    const absolutePath = path.join(rootPath, relativePath);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(rootPath, relativePath));
      continue;
    }
    if (entry.isFile()) {
      results.push({ path: relativePath, status: 'modified' });
    }
  }
  return results;
}

function collectChangedEntries(labRoot) {
  if (!labRoot || !fs.existsSync(labRoot)) {
    throw new Error('Lab root does not exist.');
  }
  try {
    const output = childProcess.execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: labRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024,
    });
    const entries = output
      .split(/\r?\n/)
      .flatMap((line) => parseGitStatusLine(line))
      .filter((entry) => entry.path && !isInternalPromotionPath(entry.path));
    const deduped = new Map();
    for (const entry of entries) {
      deduped.set(entry.path, entry);
    }
    if (deduped.size > 0) {
      return Array.from(deduped.values());
    }
  } catch (_error) {
    // fall back to a simple file walk for generated labs or non-git content
  }
  return listFilesRecursive(labRoot);
}

function findLatestRelevantBenchmark(workspaceRoot, labRoot, benchmarkRuns = null) {
  const benchmarks = Array.isArray(benchmarkRuns) ? benchmarkRuns : listBenchmarkRuns(workspaceRoot).runs;
  const targetLabRoot = String(labRoot || '').trim();
  return benchmarks.find((run) => String(run?.labRoot || '').trim() === targetLabRoot)
    || benchmarks.find((run) => String(run?.targetRoot || '').trim() === targetLabRoot)
    || null;
}

function buildPromotionModelIdentity(candidate = {}, benchmark = null) {
  const benchmarkIdentity = benchmark && typeof benchmark === 'object'
    ? (benchmark.benchmarkIdentity && typeof benchmark.benchmarkIdentity === 'object'
      ? benchmark.benchmarkIdentity
      : buildBenchmarkIdentity(benchmark))
    : null;
  const modelRole = String(candidate.modelRole || benchmarkIdentity?.modelRole || '').trim().toLowerCase();
  const wrappedProfileId = String(candidate.modelProfileId || benchmarkIdentity?.wrappedProfileId || '').trim();
  const baseModel = String(candidate.baseModel || benchmarkIdentity?.baseModel || '').trim();
  const providerSource = String(candidate.providerSource || benchmarkIdentity?.providerSource || '').trim().toLowerCase();
  const taskMode = String(candidate.taskMode || benchmarkIdentity?.taskMode || '').trim().toLowerCase();
  return {
    candidateId: String(candidate.id || '').trim(),
    modelRole,
    wrappedProfileId,
    baseModel,
    providerSource,
    taskMode,
    promotionState: String(candidate.promotionState || candidate.status || '').trim().toLowerCase(),
    latestBackupId: String(candidate.latestBackupId || '').trim(),
    benchmarkIdentity,
    summary: [
      modelRole ? `role ${modelRole}` : '',
      wrappedProfileId ? `profile ${wrappedProfileId}` : '',
      providerSource && baseModel ? `${providerSource}:${baseModel}` : baseModel,
      taskMode ? `mode ${taskMode}` : '',
      benchmarkIdentity?.id ? `bench ${benchmarkIdentity.id}` : '',
      candidate?.promotionState ? `promotion ${String(candidate.promotionState || '').trim().toLowerCase()}` : '',
      candidate?.latestBackupId ? `backup ${String(candidate.latestBackupId || '').trim()}` : '',
    ].filter(Boolean).join(' | '),
  };
}

function normalizeCandidate(candidate = {}) {
  return {
    id: String(candidate.id || '').trim(),
    name: String(candidate.name || '').trim(),
    status: String(candidate.status || 'candidate').trim().toLowerCase() || 'candidate',
    ring: 'candidate',
    workspaceRoot: String(candidate.workspaceRoot || '').trim(),
    targetWorkspaceRoot: String(candidate.targetWorkspaceRoot || '').trim(),
    labRoot: String(candidate.labRoot || '').trim(),
    sourceRoot: String(candidate.sourceRoot || '').trim(),
    createdAt: String(candidate.createdAt || nowIso()),
    updatedAt: String(candidate.updatedAt || candidate.createdAt || nowIso()),
    createdFromRecipe: String(candidate.createdFromRecipe || '').trim(),
    verification: candidate.verification && typeof candidate.verification === 'object' ? candidate.verification : {},
    changeSummary: candidate.changeSummary && typeof candidate.changeSummary === 'object' ? candidate.changeSummary : { count: 0, top: [] },
    governance: candidate.governance && typeof candidate.governance === 'object' ? candidate.governance : {},
    notes: String(candidate.notes || '').trim(),
    promotionState: String(candidate.promotionState || '').trim() || 'blocked',
    promotionSummary: String(candidate.promotionSummary || '').trim(),
    promotedAt: String(candidate.promotedAt || '').trim(),
    latestBackupId: String(candidate.latestBackupId || '').trim(),
    foundryCandidateId: String(candidate.foundryCandidateId || '').trim(),
    modelProfileId: String(candidate.modelProfileId || '').trim(),
    variantType: String(candidate.variantType || 'wrapped').trim().toLowerCase() || 'wrapped',
    baseModel: String(candidate.baseModel || '').trim(),
    taskMode: String(candidate.taskMode || '').trim().toLowerCase(),
    providerSource: String(candidate.providerSource || '').trim().toLowerCase(),
    targetLanes: Array.isArray(candidate.targetLanes) ? candidate.targetLanes.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean) : [],
    rollbackSource: String(candidate.rollbackSource || '').trim(),
    routeBundlePromotion: candidate.routeBundlePromotion && typeof candidate.routeBundlePromotion === 'object' ? candidate.routeBundlePromotion : {},
    promotedRouteBundle: candidate.promotedRouteBundle && typeof candidate.promotedRouteBundle === 'object' ? candidate.promotedRouteBundle : {},
    proofRequirement: candidate.proofRequirement && typeof candidate.proofRequirement === 'object' ? candidate.proofRequirement : {},
  };
}

function candidateMatchesWorkspace(candidate = {}, workspaceRoot = '', selectedLabRoot = '') {
  const workspace = normalizeWorkspacePath(workspaceRoot);
  const selectedLab = normalizeWorkspacePath(selectedLabRoot);
  if (!workspace && !selectedLab) {
    return true;
  }
  const roots = [
    candidate.workspaceRoot,
    candidate.targetWorkspaceRoot,
    candidate.sourceRoot,
    candidate.labRoot,
  ].map((value) => normalizeWorkspacePath(value)).filter(Boolean);
  if (selectedLab && roots.includes(selectedLab)) {
    return true;
  }
  if (!workspace) {
    return false;
  }
  return roots.includes(workspace);
}

function readPromotionAcceptanceState(workspaceRoot) {
  const acceptance = readLatestAcceptanceReport(workspaceRoot);
  const report = acceptance?.report && typeof acceptance.report === 'object' ? acceptance.report : null;
  const controlSummary = report ? buildAcceptanceControlSummary(report, { exists: acceptance?.exists === true }) : null;
  const summary = report ? summarizeAcceptanceReport(report) : null;
  return {
    exists: acceptance?.exists === true,
    outputPath: String(acceptance?.outputPath || '').trim(),
    report,
    controlSummary,
    summary,
  };
}

function buildPromotionGate(candidate = {}, acceptanceState = {}, routeBundlePromotion = null, proofRequirement = null) {
  const reasons = [];
  const verificationOk = candidate?.verification?.ok === true;
  if (!verificationOk) {
    reasons.push('This candidate is missing a verified lab result.');
  }

  if (!acceptanceState.exists || !acceptanceState.summary) {
    reasons.push('Run engine acceptance before promoting work into live.');
  } else if (acceptanceState.summary.overallStatus === 'fail') {
    reasons.push(acceptanceState.summary.nextAction || 'The latest engine acceptance report is failing.');
  }
  if (routeBundlePromotion?.applies && routeBundlePromotion?.canActivate !== true) {
    reasons.push(String(routeBundlePromotion.summary || 'The linked route bundle does not satisfy the live default guardrails.').trim());
  }
  if (proofRequirement?.applies && proofRequirement?.verified !== true) {
    reasons.push(String(proofRequirement.summary || 'This local model candidate has not cleared the full engine proof matrix yet.').trim());
  }

  const canPromote = reasons.length === 0;
  return {
    canPromote,
    status: canPromote ? 'ready' : 'blocked',
    summary: canPromote
      ? 'Acceptance and candidate verification are healthy enough for manual promotion.'
      : reasons[0],
    reasons,
    acceptanceStatus: acceptanceState.summary?.overallStatus || (acceptanceState.exists ? 'unknown' : 'missing'),
    acceptanceSummary: acceptanceState.summary?.summary || '',
    acceptanceOutputPath: acceptanceState.outputPath || '',
    proofRequirement: proofRequirement && typeof proofRequirement === 'object' ? proofRequirement : null,
  };
}

function readBackupManifest(workspaceRoot, backupId) {
  const manifestPath = path.join(backupRoot(workspaceRoot, backupId), 'manifest.json');
  const manifest = readJsonFile(manifestPath, {});
  return manifest && typeof manifest === 'object' ? manifest : {};
}

function listBackupMetadata(workspaceRoot) {
  const root = ensurePromotionsRoot(workspaceRoot);
  const backupsDir = path.join(root, BACKUPS_DIR);
  if (!fs.existsSync(backupsDir)) {
    return [];
  }
  return fs.readdirSync(backupsDir)
    .map((backupId) => readBackupManifest(workspaceRoot, backupId))
    .filter((item) => item && item.id)
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
}

function buildChangeSummary(entries = []) {
  const filtered = Array.isArray(entries) ? entries.filter((entry) => entry && entry.path) : [];
  return {
    count: filtered.length,
    top: filtered.slice(0, 8).map((entry) => String(entry.path || '')),
  };
}

function normalizeStringArray(values) {
  return Array.isArray(values)
    ? values.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function resolvePromotionRouteKey({ taskMode = '', laneId = '' } = {}) {
  return resolveRouteTaskMode({ laneId, taskMode });
}

function normalizeProviderSource(value) {
  return String(value || '').trim().toLowerCase();
}

function clipText(value, maxLength = 180) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}...` : text;
}

function isLocalProviderSource(value) {
  return LOCAL_PROVIDER_SOURCES.has(normalizeProviderSource(value));
}

function benchmarkRunPassed(run = {}) {
  if (!run || typeof run !== 'object') {
    return false;
  }
  if (run.ok === true || run.pass === true || run.passed === true) {
    return true;
  }
  const status = String(run.status || run.result || run.outcome || '').trim().toLowerCase();
  return ['pass', 'passed', 'ok', 'success', 'green', 'verified'].includes(status);
}

function normalizeProofTags(values = []) {
  return Array.isArray(values)
    ? Array.from(new Set(values.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)))
    : [];
}

function normalizeProofTaskMode(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }
  if (['chat', 'plan', 'planner'].includes(normalized)) {
    return 'planner';
  }
  if (['implement', 'implementer', 'coder'].includes(normalized)) {
    return 'coder';
  }
  if (['review', 'run', 'validator'].includes(normalized)) {
    return 'validator';
  }
  if (normalized === 'repair') {
    return 'repair';
  }
  if (normalized === 'research') {
    return 'research';
  }
  if (['release', 'summary', 'summarizer'].includes(normalized)) {
    return 'summarizer';
  }
  return normalized;
}

function buildLocalPromotionProofSubject(candidate = {}) {
  const providerSource = normalizeProviderSource(candidate.providerSource || '');
  const baseModel = String(candidate.baseModel || '').trim();
  const wrappedProfileId = String(candidate.modelProfileId || '').trim();
  return {
    providerSource,
    baseModel,
    wrappedProfileId,
    label: baseModel
      ? `${providerSource || 'local'}:${baseModel}${wrappedProfileId ? ` (${wrappedProfileId})` : ''}`
      : (wrappedProfileId || 'local candidate'),
  };
}

function candidateMatchesProofRun(candidate = {}, run = {}) {
  const subject = buildLocalPromotionProofSubject(candidate);
  const runProvider = normalizeProviderSource(run?.providerSource || run?.provider || '');
  const runBaseModel = String(run?.baseModel || run?.model || '').trim();
  const runProfileId = String(run?.modelProfileId || run?.wrappedProfileId || run?.profileId || '').trim();
  if (!isLocalProviderSource(runProvider) || !isLocalProviderSource(subject.providerSource)) {
    return false;
  }
  if (subject.wrappedProfileId && runProfileId && subject.wrappedProfileId !== runProfileId) {
    return false;
  }
  if (subject.baseModel && runBaseModel && subject.baseModel !== runBaseModel) {
    return false;
  }
  if (subject.providerSource && runProvider && subject.providerSource !== runProvider) {
    return false;
  }
  return Boolean(
    (subject.wrappedProfileId && runProfileId && subject.wrappedProfileId === runProfileId)
    || (subject.baseModel && runBaseModel && subject.baseModel === runBaseModel)
  );
}

function runMatchesProofCapability(run = {}, capabilityId = '') {
  const normalizedTaskMode = normalizeProofTaskMode(run?.taskMode || run?.mode || '');
  const tags = normalizeProofTags(run?.benchmarkTags);
  const searchText = [
    ...tags,
    String(run?.recipe || '').trim().toLowerCase(),
    String(run?.taskId || '').trim().toLowerCase(),
    String(run?.name || '').trim().toLowerCase(),
    String(run?.summary || '').trim().toLowerCase(),
  ].join(' ');
  if (capabilityId === 'ask-plan') {
    return normalizedTaskMode === 'planner';
  }
  if (capabilityId === 'code') {
    return normalizedTaskMode === 'coder';
  }
  if (capabilityId === 'repair') {
    return normalizedTaskMode === 'repair';
  }
  if (capabilityId === 'review-validate') {
    return normalizedTaskMode === 'validator';
  }
  if (capabilityId === 'docs-guided') {
    return normalizedTaskMode === 'research' || DOCS_GUIDED_PROOF_TAGS.some((tag) => searchText.includes(tag));
  }
  if (capabilityId === 'scaffold-create') {
    return SCAFFOLD_PROOF_TAGS.some((tag) => searchText.includes(tag));
  }
  if (capabilityId === 'clone-lab-autonomy') {
    return AUTONOMY_PROOF_TAGS.some((tag) => searchText.includes(tag));
  }
  return false;
}

function findMatchingProofMatrixEntry(localModelProofMatrix = null, candidate = {}) {
  const matrix = localModelProofMatrix && typeof localModelProofMatrix === 'object' ? localModelProofMatrix : {};
  const entries = Array.isArray(matrix.entries) ? matrix.entries : [];
  if (!entries.length) {
    return null;
  }
  const subject = buildLocalPromotionProofSubject(candidate);
  const foundryCandidateId = String(candidate.foundryCandidateId || '').trim();
  return entries.find((entry) => {
    const current = entry && typeof entry === 'object' ? entry : {};
    if (foundryCandidateId && String(current?.foundryCandidate?.id || '').trim() === foundryCandidateId) {
      return true;
    }
    const entryProfileId = String(current.wrappedProfileId || '').trim();
    const entryBaseModel = String(current.baseModel || '').trim();
    const entryProvider = normalizeProviderSource(current.providerSource || '');
    if (subject.wrappedProfileId && entryProfileId && subject.wrappedProfileId !== entryProfileId) {
      return false;
    }
    if (subject.baseModel && entryBaseModel && subject.baseModel !== entryBaseModel) {
      return false;
    }
    if (subject.providerSource && entryProvider && subject.providerSource !== entryProvider) {
      return false;
    }
    return Boolean(
      (subject.wrappedProfileId && entryProfileId && subject.wrappedProfileId === entryProfileId)
      || (subject.baseModel && entryBaseModel && subject.baseModel === entryBaseModel)
    );
  }) || null;
}

function buildLocalPromotionProofRequirement(candidate = {}, options = {}) {
  const subject = buildLocalPromotionProofSubject(candidate);
  if (!isLocalProviderSource(subject.providerSource) || !subject.baseModel) {
    return {
      applies: false,
      verified: true,
      status: 'not-applicable',
      summary: 'Per-model proof promotion gating only applies to local model candidates.',
      verifiedCapabilityCount: 0,
      capabilityCount: LOCAL_MODEL_PROOF_CAPABILITIES.length,
      missingCapabilities: [],
      source: 'not-applicable',
    };
  }

  const matrixEntry = findMatchingProofMatrixEntry(options.localModelProofMatrix, candidate);
  if (matrixEntry) {
    const capabilityCount = Number(matrixEntry.capabilityCount || LOCAL_MODEL_PROOF_CAPABILITIES.length);
    const verifiedCapabilityCount = Number(matrixEntry.verifiedCapabilityCount || 0);
    const missingCapabilities = Array.isArray(matrixEntry.missingCapabilities)
      ? matrixEntry.missingCapabilities.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const verified = String(matrixEntry.status || '').trim().toLowerCase() === 'verified'
      && verifiedCapabilityCount >= capabilityCount;
    return {
      applies: true,
      verified,
      status: verified ? 'verified' : String(matrixEntry.status || 'blocked').trim().toLowerCase(),
      summary: verified
        ? `${subject.label} has verified per-model engine proof coverage.`
        : `Local model promotion stays blocked until ${subject.label} proves the full engine matrix${missingCapabilities.length ? ` (${missingCapabilities.join(', ')})` : ''}.`,
      verifiedCapabilityCount,
      capabilityCount,
      missingCapabilities,
      source: 'ai-status',
      headroom: matrixEntry.headroom && typeof matrixEntry.headroom === 'object' ? matrixEntry.headroom : null,
    };
  }

  const benchmarkRuns = Array.isArray(options.benchmarkRuns) ? options.benchmarkRuns : [];
  const relevantRuns = benchmarkRuns.filter((run) => candidateMatchesProofRun(candidate, run));
  const verifiedCapabilities = LOCAL_MODEL_PROOF_CAPABILITIES.filter((capability) => (
    relevantRuns.some((run) => benchmarkRunPassed(run) && runMatchesProofCapability(run, capability.id))
  ));
  const missingCapabilities = LOCAL_MODEL_PROOF_CAPABILITIES
    .filter((capability) => !verifiedCapabilities.some((verified) => verified.id === capability.id))
    .map((capability) => capability.label);
  const verified = missingCapabilities.length === 0 && verifiedCapabilities.length === LOCAL_MODEL_PROOF_CAPABILITIES.length;
  return {
    applies: true,
    verified,
    status: verified ? 'verified' : (relevantRuns.length > 0 ? 'blocked' : 'missing'),
    summary: verified
      ? `${subject.label} has benchmark-backed proof for all tracked engine capabilities.`
      : relevantRuns.length > 0
        ? `Local model promotion stays blocked until ${subject.label} proves ${missingCapabilities.join(', ')}.`
        : `Run the full per-model engine proof matrix for ${subject.label} before promoting it into live.`,
    verifiedCapabilityCount: verifiedCapabilities.length,
    capabilityCount: LOCAL_MODEL_PROOF_CAPABILITIES.length,
    missingCapabilities,
    source: 'benchmark-runs',
    runCount: relevantRuns.length,
  };
}

function buildLinkedBenchmarkIdentity(benchmark = null) {
  if (!benchmark || typeof benchmark !== 'object') {
    return null;
  }
  return benchmark.benchmarkIdentity && typeof benchmark.benchmarkIdentity === 'object'
    ? benchmark.benchmarkIdentity
    : buildBenchmarkIdentity(benchmark);
}

function arraysIntersect(left = [], right = []) {
  const rightSet = new Set(normalizeStringArray(right).map((item) => item.toLowerCase()));
  return normalizeStringArray(left).some((item) => rightSet.has(item.toLowerCase()));
}

function findLinkedFoundryCandidate(workspaceRoot, candidate = {}, linkedBenchmark = null) {
  const foundryCandidates = listFoundryCandidates(workspaceRoot);
  if (!foundryCandidates.length) {
    return null;
  }
  const benchmarkIdentity = buildLinkedBenchmarkIdentity(linkedBenchmark);
  const benchmarkId = String(benchmarkIdentity?.id || candidate?.verification?.benchmarkRunId || '').trim();
  const targetLanes = normalizeStringArray(candidate.targetLanes).map((item) => item.toLowerCase());
  const modelProfileId = String(candidate.modelProfileId || benchmarkIdentity?.wrappedProfileId || '').trim();
  const baseModel = String(candidate.baseModel || benchmarkIdentity?.baseModel || '').trim();
  const providerSource = normalizeProviderSource(candidate.providerSource || benchmarkIdentity?.providerSource || '');
  const taskMode = String(candidate.taskMode || benchmarkIdentity?.taskMode || '').trim().toLowerCase();
  const explicitId = String(candidate.foundryCandidateId || '').trim();

  return foundryCandidates.find((entry) => {
    const current = entry && typeof entry === 'object' ? entry : {};
    if (explicitId && String(current.id || '').trim() === explicitId) {
      return true;
    }
    const sourceBenchmarks = normalizeStringArray(current.sourceBenchmarks);
    const benchmarkMatches = benchmarkId ? sourceBenchmarks.includes(benchmarkId) : false;
    const laneMatches = targetLanes.length === 0 || arraysIntersect(targetLanes, current.targetLanes);
    const profileMatches = modelProfileId && String(current.modelProfileId || '').trim() === modelProfileId;
    const baseMatches = baseModel && String(current.baseModel || '').trim() === baseModel;
    const providerMatches = providerSource && normalizeProviderSource(current.providerSource || '') === providerSource;
    const taskModeMatches = !taskMode || String(current.taskMode || '').trim().toLowerCase() === taskMode;
    const modelMatches = profileMatches || ((baseMatches || !baseModel) && (providerMatches || !providerSource));
    return benchmarkMatches && laneMatches && modelMatches && taskModeMatches;
  }) || null;
}

function buildRouteBundlePromotionState(workspaceRoot, candidate = {}, linkedBenchmark = null, acceptanceState = {}, proofRequirement = null) {
  const benchmarkIdentity = buildLinkedBenchmarkIdentity(linkedBenchmark);
  const foundryCandidate = findLinkedFoundryCandidate(workspaceRoot, candidate, linkedBenchmark);
  const explicitVariant = String(candidate.variantType || '').trim().toLowerCase();
  const foundryType = String(foundryCandidate?.type || foundryCandidate?.workerVariantType || '').trim().toLowerCase();
  const targetLanes = normalizeStringArray(foundryCandidate?.targetLanes || candidate.targetLanes).map((item) => item.toLowerCase());
  const applies = explicitVariant === 'route-bundle'
    || foundryType === 'route-bundle'
    || (String(candidate.foundryCandidateId || '').trim() && targetLanes.length > 0);
  if (!applies) {
    return {
      applies: false,
      canActivate: false,
      status: 'not-applicable',
      summary: 'This candidate is not linked to a live route-bundle promotion.',
      reasons: [],
      foundryCandidateId: String(foundryCandidate?.id || '').trim(),
      benchmarkId: String(benchmarkIdentity?.id || '').trim(),
      targetLanes,
    };
  }

  const providerSource = normalizeProviderSource(
    foundryCandidate?.providerSource
    || candidate.providerSource
    || benchmarkIdentity?.providerSource
    || ''
  );
  const baseModel = String(
    foundryCandidate?.baseModel
    || candidate.baseModel
    || benchmarkIdentity?.baseModel
    || ''
  ).trim();
  const modelProfileId = String(
    foundryCandidate?.modelProfileId
    || candidate.modelProfileId
    || benchmarkIdentity?.wrappedProfileId
    || ''
  ).trim();
  const taskMode = String(foundryCandidate?.taskMode || candidate.taskMode || benchmarkIdentity?.taskMode || '').trim().toLowerCase();
  const benchmarkId = String(benchmarkIdentity?.id || '').trim();
  const sourceBenchmarks = normalizeStringArray(foundryCandidate?.sourceBenchmarks);
  const benchmarkBacked = Boolean(
    benchmarkId
    && String(linkedBenchmark?.status || '').trim().toLowerCase() === 'pass'
    && (sourceBenchmarks.length === 0 || sourceBenchmarks.includes(benchmarkId))
  );
  const acceptanceReady = acceptanceState?.controlSummary?.safeForNextDay === true;
  const reasons = [];
  const guardrailDecision = baseModel
    ? buildLocalModelGuardrailDecision(baseModel)
    : null;
  if (!foundryCandidate) {
    reasons.push('Seed a matching Model Foundry route bundle before promoting it into the live lane map.');
  }
  if (!isLocalProviderSource(providerSource)) {
    reasons.push('Only local route bundles can become the default live lane map.');
  }
  if (!benchmarkBacked) {
    reasons.push('The linked route bundle needs a passing benchmark artifact before it can become a default route.');
  }
  if (!acceptanceReady) {
    reasons.push('Keep route-bundle promotion blocked until the latest acceptance bundle is green for the next day.');
  }
  if (!targetLanes.length) {
    reasons.push('The linked route bundle is missing target lanes to activate.');
  }
  if (!baseModel || !providerSource) {
    reasons.push('The linked route bundle is missing model identity.');
  }
  if (guardrailDecision && guardrailDecision.allowedAsDefault !== true) {
    reasons.push(guardrailDecision.summary || 'The linked route bundle exceeds the 32 GB live default guardrail.');
  }
  if (proofRequirement?.applies && proofRequirement?.verified !== true) {
    reasons.push(String(proofRequirement.summary || 'The linked route bundle has not cleared the full engine proof matrix yet.').trim());
  }

  const canActivate = reasons.length === 0;
  return {
    applies: true,
    canActivate,
    status: canActivate ? 'ready' : 'blocked',
    summary: canActivate
      ? `Ready to activate ${providerSource}:${baseModel} across ${targetLanes.length} lane(s).`
      : reasons[0],
    reasons,
    foundryCandidateId: String(foundryCandidate?.id || '').trim(),
    foundryTitle: String(foundryCandidate?.title || '').trim(),
    benchmarkId,
    targetLanes,
    providerSource,
    baseModel,
    modelProfileId,
    taskMode,
    rollbackSource: String(foundryCandidate?.rollbackSource || candidate.rollbackSource || '').trim(),
    guardrailDecision,
    proofRequirement: proofRequirement && typeof proofRequirement === 'object' ? proofRequirement : null,
  };
}

function captureAssistantConfigBackup(workspaceRoot, targetWorkspaceRoot, backupId) {
  const configPath = configPathForWorkspace(targetWorkspaceRoot);
  const existed = fs.existsSync(configPath);
  const manifest = {
    configPath,
    existed,
    backupPath: '',
    snapshot: readAssistantConfig(targetWorkspaceRoot),
  };
  if (!existed) {
    return manifest;
  }
  const backupFilePath = path.join(backupRoot(workspaceRoot, backupId), 'config', 'dev_assistant.yaml');
  ensureDirectory(path.dirname(backupFilePath));
  fs.cpSync(configPath, backupFilePath, { recursive: true });
  manifest.backupPath = path.relative(backupRoot(workspaceRoot, backupId), backupFilePath);
  return manifest;
}

function restoreAssistantConfigBackup(workspaceRoot, backupId, configBackup = {}) {
  const configPath = String(configBackup.configPath || '').trim();
  if (!configPath) {
    return;
  }
  if (!configBackup.existed) {
    if (fs.existsSync(configPath)) {
      fs.rmSync(configPath, { force: true });
    }
    return;
  }
  const backupFilePath = path.join(backupRoot(workspaceRoot, backupId), String(configBackup.backupPath || '').trim());
  if (!fs.existsSync(backupFilePath)) {
    return;
  }
  ensureDirectory(path.dirname(configPath));
  fs.cpSync(backupFilePath, configPath, { recursive: true });
}

function updateBackupManifest(workspaceRoot, backupId, mutate) {
  const manifestPath = path.join(backupRoot(workspaceRoot, backupId), 'manifest.json');
  const current = readJsonFile(manifestPath, {});
  const next = typeof mutate === 'function' ? (mutate(current) || current) : current;
  writeJsonFileAtomic(manifestPath, next);
  return next;
}

function buildRouteBundleActivationSettings(currentConfig = {}, routeBundlePromotion = {}, candidate = {}) {
  const providerSource = normalizeProviderSource(routeBundlePromotion.providerSource || candidate.providerSource || currentConfig.providerSource || currentConfig.workspaceProviderSource || '');
  const baseModel = String(routeBundlePromotion.baseModel || candidate.baseModel || currentConfig.baseModel || currentConfig.workspaceBaseModel || '').trim();
  const modelProfileId = String(routeBundlePromotion.modelProfileId || candidate.modelProfileId || currentConfig.modelProfileId || '').trim();
  const displayName = String(candidate.name || routeBundlePromotion.foundryTitle || modelProfileId || baseModel || '').trim();
  const targetLanes = normalizeStringArray(routeBundlePromotion.targetLanes).map((item) => item.toLowerCase());
  const routeKeys = Array.from(new Set(targetLanes.map((laneId) => resolvePromotionRouteKey({ laneId, taskMode: routeBundlePromotion.taskMode })).filter(Boolean)));
  const includesWorkspaceRole = targetLanes.some((laneId) => resolveExecutionModelRole({ laneId, taskMode: routeBundlePromotion.taskMode }) === 'workspace');
  const includesEngineRole = targetLanes.some((laneId) => resolveExecutionModelRole({ laneId, taskMode: routeBundlePromotion.taskMode }) === 'engine');
  const settings = {};

  if (modelProfileId) {
    settings.modelProfileId = modelProfileId;
  }
  if (displayName) {
    settings.modelDisplayName = displayName;
  }
  if (baseModel) {
    settings.baseModel = baseModel;
  }
  if (providerSource) {
    settings.baseProvider = providerSource;
    settings.providerSource = providerSource;
  }

  if (includesWorkspaceRole) {
    if (modelProfileId) {
      settings.workspaceModelProfileId = modelProfileId;
    }
    if (displayName) {
      settings.workspaceModelDisplayName = displayName;
    }
    if (baseModel) {
      settings.workspaceBaseModel = baseModel;
    }
    if (providerSource) {
      settings.workspaceBaseProvider = providerSource;
      settings.workspaceProviderSource = providerSource;
    }
  }
  if (includesEngineRole) {
    if (modelProfileId) {
      settings.engineModelProfileId = modelProfileId;
    }
    if (displayName) {
      settings.engineModelDisplayName = displayName;
    }
    if (baseModel) {
      settings.engineBaseModel = baseModel;
    }
    if (providerSource) {
      settings.engineBaseProvider = providerSource;
      settings.engineProviderSource = providerSource;
    }
  }

  for (const routeKey of routeKeys) {
    if (routeKey === 'planner') {
      settings.plannerProvider = providerSource;
      settings.plannerModel = baseModel;
    } else if (routeKey === 'repair') {
      settings.repairProvider = providerSource;
      settings.repairModel = baseModel;
    } else if (routeKey === 'coder') {
      settings.coderProvider = providerSource;
      settings.coderModel = baseModel;
    } else if (routeKey === 'validator') {
      settings.validatorProvider = providerSource;
      settings.validatorModel = baseModel;
    } else if (routeKey === 'summarizer') {
      settings.summarizerProvider = providerSource;
      settings.summarizerModel = baseModel;
    }
  }

  return settings;
}

function buildAssistantConfigBundleSnapshot(config = {}) {
  const taskModeRoutes = config?.taskModeRoutes && typeof config.taskModeRoutes === 'object'
    ? config.taskModeRoutes
    : {};
  return {
    modelProfileId: String(config?.modelProfileId || '').trim(),
    baseModel: String(config?.baseModel || '').trim(),
    providerSource: normalizeProviderSource(config?.providerSource || config?.baseProvider || ''),
    workspaceModelProfileId: String(config?.workspaceModelProfileId || '').trim(),
    workspaceBaseModel: String(config?.workspaceBaseModel || '').trim(),
    workspaceProviderSource: normalizeProviderSource(config?.workspaceProviderSource || config?.workspaceBaseProvider || ''),
    engineModelProfileId: String(config?.engineModelProfileId || '').trim(),
    engineBaseModel: String(config?.engineBaseModel || '').trim(),
    engineProviderSource: normalizeProviderSource(config?.engineProviderSource || config?.engineBaseProvider || ''),
    taskModeRoutes: {
      planner: taskModeRoutes.planner && typeof taskModeRoutes.planner === 'object'
        ? {
            provider: normalizeProviderSource(taskModeRoutes.planner.provider || ''),
            model: String(taskModeRoutes.planner.model || '').trim(),
          }
        : null,
      repair: taskModeRoutes.repair && typeof taskModeRoutes.repair === 'object'
        ? {
            provider: normalizeProviderSource(taskModeRoutes.repair.provider || ''),
            model: String(taskModeRoutes.repair.model || '').trim(),
          }
        : null,
      coder: taskModeRoutes.coder && typeof taskModeRoutes.coder === 'object'
        ? {
            provider: normalizeProviderSource(taskModeRoutes.coder.provider || ''),
            model: String(taskModeRoutes.coder.model || '').trim(),
          }
        : null,
      validator: taskModeRoutes.validator && typeof taskModeRoutes.validator === 'object'
        ? {
            provider: normalizeProviderSource(taskModeRoutes.validator.provider || ''),
            model: String(taskModeRoutes.validator.model || '').trim(),
          }
        : null,
      summarizer: taskModeRoutes.summarizer && typeof taskModeRoutes.summarizer === 'object'
        ? {
            provider: normalizeProviderSource(taskModeRoutes.summarizer.provider || ''),
            model: String(taskModeRoutes.summarizer.model || '').trim(),
          }
        : null,
    },
  };
}

function verifyRouteBundlePromotion(targetWorkspaceRoot, routeBundlePromotion = {}) {
  const targetLanes = normalizeStringArray(routeBundlePromotion.targetLanes).map((item) => item.toLowerCase());
  if (!targetLanes.length) {
    return {
      ok: false,
      verifiedCount: 0,
      missingCount: 0,
      missingLanes: [],
      summary: 'No target lanes were declared for route-bundle verification.',
    };
  }
  const config = readAssistantConfig(targetWorkspaceRoot);
  const expectedModel = String(routeBundlePromotion.baseModel || '').trim();
  const expectedProvider = normalizeProviderSource(routeBundlePromotion.providerSource || '');
  const missingLanes = [];

  for (const laneId of targetLanes) {
    const lane = resolveTaskLoopLane(laneId);
    const selection = resolveModelProfileSelection(config, {
      laneId,
      taskMode: routeBundlePromotion.taskMode,
      action: lane.action,
    });
    const activeModel = String(selection?.active?.baseModel || '').trim();
    const activeProvider = normalizeProviderSource(selection?.active?.providerSource || selection?.active?.baseProvider || '');
    if (activeModel !== expectedModel || activeProvider !== expectedProvider) {
      missingLanes.push(laneId);
    }
  }

  return {
    ok: missingLanes.length === 0,
    verifiedCount: targetLanes.length - missingLanes.length,
    missingCount: missingLanes.length,
    missingLanes,
    summary: missingLanes.length === 0
      ? `Verified route-bundle activation across ${targetLanes.length} lane(s).`
      : `Route-bundle activation is missing on ${missingLanes.length} lane(s).`,
  };
}

function applyRouteBundlePromotion(targetWorkspaceRoot, routeBundlePromotion = {}, candidate = {}) {
  if (routeBundlePromotion?.applies && routeBundlePromotion?.canActivate !== true) {
    throw new Error(String(
      routeBundlePromotion?.summary
      || 'The approved local model bundle is not ready to freeze into live config yet.'
    ).trim());
  }
  if (routeBundlePromotion?.proofRequirement?.applies && routeBundlePromotion?.proofRequirement?.verified !== true) {
    throw new Error(String(
      routeBundlePromotion?.proofRequirement?.summary
      || 'Per-model proof must stay green before freezing the approved local bundle into live config.'
    ).trim());
  }
  const currentConfig = readAssistantConfig(targetWorkspaceRoot);
  const settings = buildRouteBundleActivationSettings(currentConfig, routeBundlePromotion, candidate);
  const nextConfig = writeAssistantModelSettings(targetWorkspaceRoot, settings);
  const verification = verifyRouteBundlePromotion(targetWorkspaceRoot, routeBundlePromotion);
  return {
    ok: verification.ok,
    appliedAt: nowIso(),
    appliedSettings: settings,
    approvedBundleFrozen: verification.ok,
    frozenBundle: verification.ok
      ? {
          ...buildAssistantConfigBundleSnapshot(nextConfig),
          targetLanes: normalizeStringArray(routeBundlePromotion.targetLanes).map((item) => item.toLowerCase()),
        }
      : null,
    config: nextConfig,
    verification,
    summary: verification.ok
      ? `Froze approved live bundle ${routeBundlePromotion.providerSource}:${routeBundlePromotion.baseModel} across ${routeBundlePromotion.targetLanes.length} lane(s).`
      : verification.summary,
  };
}



function verifyPromotionState(targetWorkspaceRoot, changedEntries = []) {
  const missing = [];
  const present = [];
  for (const entry of changedEntries) {
    const safeTarget = sanitizeTargetPath(targetWorkspaceRoot, entry.path);
    if (!safeTarget) {
      continue;
    }
    const exists = fs.existsSync(safeTarget.resolved);
    if (String(entry.status || '').trim().toLowerCase() === 'deleted') {
      if (!exists) {
        present.push(entry.path);
      } else {
        missing.push(entry.path);
      }
      continue;
    }
    if (exists) {
      present.push(entry.path);
    } else {
      missing.push(entry.path);
    }
  }
  return {
    ok: missing.length === 0,
    verifiedCount: present.length,
    missingCount: missing.length,
    missingPaths: missing.slice(0, 20),
    summary: missing.length === 0 ? `Verified ${present.length} promoted path(s).` : `Missing ${missing.length} promoted path(s).`,
  };
}

function buildPromotionGovernance(candidate, acceptanceState, changedEntries = [], routeBundlePromotion = null, proofRequirement = null) {
  const gate = buildPromotionGate(candidate, acceptanceState, routeBundlePromotion, proofRequirement);
  return {
    canPromote: gate.canPromote === true,
    hold: gate.canPromote !== true,
    rollbackRecommended: gate.status === 'blocked' || gate.status === 'warn',
    changedPathCount: Array.isArray(changedEntries) ? changedEntries.length : 0,
    routeBundleStatus: routeBundlePromotion?.status || 'not-applicable',
    proofStatus: proofRequirement?.status || 'not-applicable',
    summary: gate.summary,
    status: gate.status,
  };
}
function createCandidate(workspaceRoot, payload = {}) {
  const promotionsRoot = ensurePromotionsRoot(workspaceRoot);
  const labRoot = path.resolve(String(payload.labRoot || '').trim());
  if (!labRoot || !fs.existsSync(labRoot)) {
    throw new Error('A real labRoot is required before creating a candidate.');
  }
  const labMeta = readLabMetadata(labRoot);
  const targetWorkspaceRoot = path.resolve(String(
    payload.targetWorkspaceRoot
    || labMeta?.sourceRoot
    || workspaceRoot
    || '',
  ).trim());
  const changedEntries = collectChangedEntries(labRoot);
  if (!changedEntries.length) {
    throw new Error('The lab has no changes to promote yet.');
  }
  const benchmarkRuns = listBenchmarkRuns(workspaceRoot).runs;
  const latestBenchmark = findLatestRelevantBenchmark(workspaceRoot, labRoot, benchmarkRuns);
  const explicitVerificationOk = payload?.verification?.ok === true;
  const benchmarkOk = String(latestBenchmark?.status || '').trim().toLowerCase() === 'pass';
  const verified = explicitVerificationOk || benchmarkOk;
  if (!verified && payload.force !== true) {
    throw new Error('Candidate creation requires a passing benchmark or explicit verified result.');
  }
  const acceptanceState = readPromotionAcceptanceState(workspaceRoot);
  const proofRequirement = buildLocalPromotionProofRequirement({
    ...payload,
    verification: { ok: verified },
    modelProfileId: String(payload.modelProfileId || latestBenchmark?.modelProfileId || latestBenchmark?.wrappedProfileId || '').trim(),
    baseModel: String(payload.baseModel || latestBenchmark?.baseModel || latestBenchmark?.model || '').trim(),
    providerSource: String(payload.providerSource || latestBenchmark?.providerSource || '').trim().toLowerCase(),
  }, {
    localModelProofMatrix: payload.localModelProofMatrix,
    benchmarkRuns,
  });
  const routeBundlePromotion = buildRouteBundlePromotionState(workspaceRoot, payload, latestBenchmark, acceptanceState, proofRequirement);
  const promotionGate = buildPromotionGate({
    ...payload,
    verification: { ok: verified },
  }, acceptanceState, routeBundlePromotion, proofRequirement);

  const governance = buildPromotionGovernance({ ...payload, verification: { ok: verified } }, acceptanceState, changedEntries, routeBundlePromotion, proofRequirement);
  const candidate = normalizeCandidate({
    id: payload.id || randomId(`candidate_${slugify(payload.name || path.basename(labRoot), 'candidate')}`),
    name: payload.name || path.basename(labRoot),
    status: 'candidate',
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
    sourceRoot: String(labMeta?.sourceRoot || '').trim() || targetWorkspaceRoot,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    createdFromRecipe: String(labMeta?.recipe || payload.recipe || '').trim(),
    verification: {
      ok: verified,
      source: explicitVerificationOk ? 'explicit' : (benchmarkOk ? 'benchmark' : 'manual'),
      benchmarkRunId: String(latestBenchmark?.id || '').trim(),
      benchmarkSummary: String(latestBenchmark?.summary || '').trim(),
      passRate: Number(latestBenchmark?.passRate || 0),
      latencyMs: Number(latestBenchmark?.latencyMs || 0),
    },
    changeSummary: buildChangeSummary(changedEntries),
    notes: String(payload.notes || '').trim(),
    promotionState: promotionGate.status,
    promotionSummary: promotionGate.summary,
    governance,
    foundryCandidateId: String(payload.foundryCandidateId || routeBundlePromotion.foundryCandidateId || '').trim(),
    modelProfileId: String(payload.modelProfileId || latestBenchmark?.modelProfileId || latestBenchmark?.wrappedProfileId || '').trim(),
    variantType: String(payload.variantType || 'wrapped').trim().toLowerCase() || 'wrapped',
    baseModel: String(payload.baseModel || latestBenchmark?.baseModel || latestBenchmark?.model || '').trim(),
    taskMode: String(payload.taskMode || latestBenchmark?.taskMode || '').trim().toLowerCase(),
    providerSource: String(payload.providerSource || latestBenchmark?.providerSource || '').trim().toLowerCase(),
    targetLanes: Array.isArray(payload.targetLanes) ? payload.targetLanes : routeBundlePromotion.targetLanes,
    rollbackSource: String(payload.rollbackSource || routeBundlePromotion.rollbackSource || '').trim(),
    routeBundlePromotion,
    proofRequirement,
  });

  const candidates = readCandidates(workspaceRoot);
  candidates.unshift(candidate);
  writeCandidates(workspaceRoot, candidates.slice(0, 60));
  appendHistory(workspaceRoot, {
    kind: 'candidate-created',
    candidateId: candidate.id,
    targetWorkspaceRoot,
    labRoot,
    promotionsRoot,
    changeCount: candidate.changeSummary.count,
    promotionState: candidate.promotionState,
  });
  return {
    ok: true,
    candidate,
    promotionsRoot,
  };
}

function backupPathForTarget(workspaceRoot, backupId, relativePath) {
  return path.join(backupRoot(workspaceRoot, backupId), 'files', normalizeRelativePath(relativePath));
}

function createPromotionBackup(workspaceRoot, payload = {}) {
  const backupId = String(payload.backupId || randomId('promotion_backup')).trim();
  const targetWorkspaceRoot = path.resolve(String(payload.targetWorkspaceRoot || workspaceRoot || '').trim());
  const changedEntries = Array.isArray(payload.changedEntries) ? payload.changedEntries : [];
  const manifest = {
    id: backupId,
    createdAt: nowIso(),
    kind: 'promotion-backup',
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot: String(payload.labRoot || '').trim(),
    candidateId: String(payload.candidateId || '').trim(),
    entries: [],
    assistantConfig: captureAssistantConfigBackup(workspaceRoot, targetWorkspaceRoot, backupId),
    routeBundlePromotion: payload.routeBundlePromotion && typeof payload.routeBundlePromotion === 'object'
      ? payload.routeBundlePromotion
      : null,
  };

  for (const entry of changedEntries) {
    const safeTarget = sanitizeTargetPath(targetWorkspaceRoot, entry.path);
    if (!safeTarget) {
      continue;
    }
    const existed = fs.existsSync(safeTarget.resolved);
    const nextEntry = {
      path: safeTarget.clean,
      status: String(entry.status || 'modified'),
      existed,
      backupPath: '',
    };
    if (existed) {
      const backupFilePath = backupPathForTarget(workspaceRoot, backupId, safeTarget.clean);
      ensureDirectory(path.dirname(backupFilePath));
      fs.cpSync(safeTarget.resolved, backupFilePath, { recursive: true });
      nextEntry.backupPath = path.relative(backupRoot(workspaceRoot, backupId), backupFilePath);
    }
    manifest.entries.push(nextEntry);
  }

  writeJsonFileAtomic(path.join(backupRoot(workspaceRoot, backupId), 'manifest.json'), manifest);
  return manifest;
}

function applyChangedEntries(targetWorkspaceRoot, labRoot, changedEntries = []) {
  for (const entry of changedEntries) {
    const safeTarget = sanitizeTargetPath(targetWorkspaceRoot, entry.path);
    const safeLab = sanitizeTargetPath(labRoot, entry.path);
    if (!safeTarget) {
      continue;
    }
    if (String(entry.status || '').trim().toLowerCase() === 'deleted') {
      if (fs.existsSync(safeTarget.resolved)) {
        fs.rmSync(safeTarget.resolved, { recursive: true, force: true });
      }
      continue;
    }
    if (!safeLab || !fs.existsSync(safeLab.resolved)) {
      continue;
    }
    ensureDirectory(path.dirname(safeTarget.resolved));
    fs.cpSync(safeLab.resolved, safeTarget.resolved, { recursive: true });
  }
}

function promoteCandidate(workspaceRoot, payload = {}) {
  const candidateId = String(payload.candidateId || '').trim();
  if (!candidateId) {
    throw new Error('candidateId is required.');
  }
  const candidates = readCandidates(workspaceRoot);
  const candidateIndex = candidates.findIndex((item) => String(item.id || '').trim() === candidateId);
  if (candidateIndex < 0) {
    throw new Error(`Candidate not found: ${candidateId}`);
  }
  const candidate = normalizeCandidate(candidates[candidateIndex]);
  if (candidate.status === 'promoted' && payload.force !== true) {
    throw new Error('This candidate is already promoted.');
  }
  const acceptanceState = readPromotionAcceptanceState(workspaceRoot);
  const benchmarkRuns = listBenchmarkRuns(workspaceRoot).runs;
  const linkedBenchmark = findLatestRelevantBenchmark(workspaceRoot, candidate.labRoot, benchmarkRuns);
  const candidateWithBenchmarkIdentity = {
    ...candidate,
    modelProfileId: String(candidate.modelProfileId || linkedBenchmark?.modelProfileId || linkedBenchmark?.wrappedProfileId || '').trim(),
    baseModel: String(candidate.baseModel || linkedBenchmark?.baseModel || linkedBenchmark?.model || '').trim(),
    providerSource: String(candidate.providerSource || linkedBenchmark?.providerSource || '').trim().toLowerCase(),
    taskMode: String(candidate.taskMode || linkedBenchmark?.taskMode || '').trim().toLowerCase(),
  };
  const proofRequirement = buildLocalPromotionProofRequirement(candidateWithBenchmarkIdentity, {
    localModelProofMatrix: payload.localModelProofMatrix,
    benchmarkRuns,
  });
  const routeBundlePromotion = buildRouteBundlePromotionState(workspaceRoot, candidateWithBenchmarkIdentity, linkedBenchmark, acceptanceState, proofRequirement);
  const promotionGate = buildPromotionGate(candidateWithBenchmarkIdentity, acceptanceState, routeBundlePromotion, proofRequirement);
  if (!promotionGate.canPromote && payload.force !== true) {
    throw new Error(promotionGate.summary);
  }
  if (routeBundlePromotion.applies && !routeBundlePromotion.canActivate && payload.force !== true) {
    throw new Error(routeBundlePromotion.summary);
  }
  const changedEntries = collectChangedEntries(candidate.labRoot);
  if (!changedEntries.length) {
    throw new Error('This candidate has no changed files to promote.');
  }
  const targetWorkspaceRoot = candidate.targetWorkspaceRoot || workspaceRoot;
  if (payload.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      candidate: normalizeCandidate({
        ...candidate,
        proofRequirement,
        routeBundlePromotion,
      }),
      changedEntries,
      proofRequirement,
      routeBundlePromotion,
      verification: verifyPromotionState(targetWorkspaceRoot, changedEntries),
      governance: buildPromotionGovernance(candidateWithBenchmarkIdentity, acceptanceState, changedEntries, routeBundlePromotion, proofRequirement),
    };
  }
  const backup = createPromotionBackup(workspaceRoot, {
    candidateId,
    targetWorkspaceRoot,
    labRoot: candidate.labRoot,
    changedEntries,
    routeBundlePromotion,
  });
  let verification = null;
  let routeActivation = null;
  try {
    applyChangedEntries(targetWorkspaceRoot, candidate.labRoot, changedEntries);
    verification = verifyPromotionState(targetWorkspaceRoot, changedEntries);
    if (!verification.ok) {
      throw new Error(verification.summary);
    }
    if (routeBundlePromotion.canActivate) {
      routeActivation = applyRouteBundlePromotion(targetWorkspaceRoot, routeBundlePromotion, candidate);
      if (!routeActivation.ok) {
        throw new Error(routeActivation.summary);
      }
      updateBackupManifest(workspaceRoot, backup.id, (manifest) => ({
        ...manifest,
        routeBundlePromotion: {
          ...routeBundlePromotion,
          status: 'promoted',
          activatedAt: routeActivation.appliedAt,
          activationSummary: routeActivation.summary,
          verification: routeActivation.verification,
        },
      }));
    }
  } catch (error) {
    rollbackPromotion(workspaceRoot, { backupId: backup.id });
    appendHistory(workspaceRoot, {
      kind: 'promotion-auto-rollback',
      candidateId,
      backupId: backup.id,
      targetWorkspaceRoot,
      reason: String(error?.message || error || 'promotion verification failed'),
    });
    throw error;
  }

  const nextCandidate = normalizeCandidate({
    ...candidate,
    status: 'promoted',
    updatedAt: nowIso(),
    promotedAt: nowIso(),
    latestBackupId: backup.id,
    changeSummary: buildChangeSummary(changedEntries),
    promotionState: 'promoted',
    promotionSummary: `Promoted from ${candidate.labRoot || 'lab'} into ${candidate.targetWorkspaceRoot || workspaceRoot}.`,
    governance: buildPromotionGovernance({ ...candidateWithBenchmarkIdentity, status: 'promoted' }, acceptanceState, changedEntries, routeBundlePromotion, proofRequirement),
    routeBundlePromotion: routeBundlePromotion.applies
      ? {
          ...routeBundlePromotion,
          status: routeActivation ? 'promoted' : routeBundlePromotion.status,
          summary: routeActivation ? routeActivation.summary : routeBundlePromotion.summary,
          latestBackupId: backup.id,
        }
      : candidate.routeBundlePromotion,
    proofRequirement,
    promotedRouteBundle: routeActivation
      ? {
          foundryCandidateId: routeBundlePromotion.foundryCandidateId,
          benchmarkId: routeBundlePromotion.benchmarkId,
          targetLanes: routeBundlePromotion.targetLanes,
          providerSource: routeBundlePromotion.providerSource,
          baseModel: routeBundlePromotion.baseModel,
          modelProfileId: routeBundlePromotion.modelProfileId,
          approvedBundleFrozen: routeActivation.approvedBundleFrozen === true,
          frozenBundle: routeActivation.frozenBundle,
          appliedSettings: routeActivation.appliedSettings,
          verification: routeActivation.verification,
          appliedAt: routeActivation.appliedAt,
        }
      : candidate.promotedRouteBundle,
  });
  candidates[candidateIndex] = nextCandidate;
  writeCandidates(workspaceRoot, candidates);
  appendHistory(workspaceRoot, {
    kind: 'candidate-promoted',
    candidateId,
    backupId: backup.id,
    targetWorkspaceRoot: nextCandidate.targetWorkspaceRoot,
    labRoot: nextCandidate.labRoot,
    changeCount: nextCandidate.changeSummary.count,
    routeBundleActivated: routeActivation?.ok === true,
  });
  return {
    ok: true,
    candidate: nextCandidate,
    backup,
    verification,
    routeActivation,
  };
}

function restoreBackupEntry(workspaceRoot, targetWorkspaceRoot, backupId, entry = {}) {
  const safeTarget = sanitizeTargetPath(targetWorkspaceRoot, entry.path);
  if (!safeTarget) {
    return;
  }
  if (!entry.existed) {
    if (fs.existsSync(safeTarget.resolved)) {
      fs.rmSync(safeTarget.resolved, { recursive: true, force: true });
    }
    return;
  }
  const backupFilePath = path.join(backupRoot(workspaceRoot, backupId), String(entry.backupPath || '').trim());
  if (!backupFilePath || !fs.existsSync(backupFilePath)) {
    return;
  }
  ensureDirectory(path.dirname(safeTarget.resolved));
  if (fs.existsSync(safeTarget.resolved)) {
    fs.rmSync(safeTarget.resolved, { recursive: true, force: true });
  }
  fs.cpSync(backupFilePath, safeTarget.resolved, { recursive: true });
}

function rollbackPromotion(workspaceRoot, payload = {}) {
  const backupId = String(payload.backupId || '').trim();
  if (!backupId) {
    throw new Error('backupId is required.');
  }
  const manifest = readBackupManifest(workspaceRoot, backupId);
  if (!manifest?.id) {
    throw new Error(`Backup not found: ${backupId}`);
  }
  const targetWorkspaceRoot = path.resolve(String(manifest.targetWorkspaceRoot || workspaceRoot || '').trim());
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const rolledBackAt = nowIso();
  for (const entry of entries) {
    restoreBackupEntry(workspaceRoot, targetWorkspaceRoot, backupId, entry);
  }
  restoreAssistantConfigBackup(workspaceRoot, backupId, manifest.assistantConfig);
  const restoredConfig = readAssistantConfig(targetWorkspaceRoot);
  const restoredBundle = buildAssistantConfigBundleSnapshot(restoredConfig);
  const candidates = readCandidates(workspaceRoot).map((candidate) => {
    if (String(candidate.id || '').trim() !== String(manifest.candidateId || '').trim()) {
      return candidate;
    }
    return normalizeCandidate({
      ...candidate,
      status: 'rolled-back',
      updatedAt: rolledBackAt,
      latestBackupId: backupId,
      promotionState: 'rolled-back',
      promotionSummary: `Rolled back the live route bundle from backup ${backupId}.`,
      routeBundlePromotion: candidate.routeBundlePromotion && typeof candidate.routeBundlePromotion === 'object'
        ? {
            ...candidate.routeBundlePromotion,
            status: 'rolled-back',
            summary: `Rolled back the live route bundle from backup ${backupId}.`,
          }
        : candidate.routeBundlePromotion,
      promotedRouteBundle: candidate.promotedRouteBundle && typeof candidate.promotedRouteBundle === 'object'
        ? {
            ...candidate.promotedRouteBundle,
            rolledBackAt,
            restoredBundle,
          }
        : candidate.promotedRouteBundle,
    });
  });
  writeCandidates(workspaceRoot, candidates);
  appendHistory(workspaceRoot, {
    kind: 'rollback',
    backupId,
    candidateId: String(manifest.candidateId || '').trim(),
    targetWorkspaceRoot,
    restoredCount: entries.length,
  });
  return {
    ok: true,
    backupId,
    targetWorkspaceRoot,
    restoredCount: entries.length,
    restoredBundle,
  };
}

function listPromotionState(workspaceRoot, payload = {}) {
  const promotionsRoot = getConfiguredAssistantPromotionsRoot(workspaceRoot);
  const acceptanceState = promotionsRoot ? readPromotionAcceptanceState(workspaceRoot) : { exists: false, outputPath: '', report: null, summary: null };
  const selectedLabRoot = String(payload.labRoot || '').trim();
  const benchmarkRuns = listBenchmarkRuns(workspaceRoot).runs;
  const localModelProofMatrix = payload.localModelProofMatrix && typeof payload.localModelProofMatrix === 'object'
    ? payload.localModelProofMatrix
    : null;
  const candidates = promotionsRoot
    ? readCandidates(workspaceRoot).map((candidate) => {
        const normalized = normalizeCandidate(candidate);
        const linkedBenchmark = findLatestRelevantBenchmark(workspaceRoot, normalized.labRoot || selectedLabRoot, benchmarkRuns);
        const candidateWithBenchmarkIdentity = {
          ...normalized,
          modelProfileId: String(normalized.modelProfileId || linkedBenchmark?.modelProfileId || linkedBenchmark?.wrappedProfileId || '').trim(),
          baseModel: String(normalized.baseModel || linkedBenchmark?.baseModel || linkedBenchmark?.model || '').trim(),
          providerSource: String(normalized.providerSource || linkedBenchmark?.providerSource || '').trim().toLowerCase(),
          taskMode: String(normalized.taskMode || linkedBenchmark?.taskMode || '').trim().toLowerCase(),
        };
        const proofRequirement = buildLocalPromotionProofRequirement(candidateWithBenchmarkIdentity, {
          localModelProofMatrix,
          benchmarkRuns,
        });
        const routeBundlePromotion = buildRouteBundlePromotionState(workspaceRoot, candidateWithBenchmarkIdentity, linkedBenchmark, acceptanceState, proofRequirement);
        const gate = buildPromotionGate(candidateWithBenchmarkIdentity, acceptanceState, routeBundlePromotion, proofRequirement);
        const usesStoredPromotionState = ['promoted', 'rolled-back'].includes(String(normalized.status || '').trim().toLowerCase());
        const effectiveRouteBundlePromotion = usesStoredPromotionState && normalized.routeBundlePromotion && Object.keys(normalized.routeBundlePromotion).length > 0
          ? {
              ...routeBundlePromotion,
              ...normalized.routeBundlePromotion,
            }
          : routeBundlePromotion;
        const effectiveProofRequirement = proofRequirement?.applies || !normalized.proofRequirement || Object.keys(normalized.proofRequirement).length === 0
          ? proofRequirement
          : normalized.proofRequirement;
        const effectivePromotionState = normalized.status === 'promoted'
          ? 'promoted'
          : normalized.status === 'rolled-back'
            ? 'rolled-back'
            : gate.status;
        const effectivePromotionSummary = normalized.status === 'promoted' || normalized.status === 'rolled-back'
          ? normalized.promotionSummary
          : gate.summary;
        return {
          ...candidateWithBenchmarkIdentity,
          benchmarkIdentity: linkedBenchmark
            ? (linkedBenchmark.benchmarkIdentity && typeof linkedBenchmark.benchmarkIdentity === 'object'
              ? linkedBenchmark.benchmarkIdentity
              : buildBenchmarkIdentity(linkedBenchmark))
            : null,
          modelIdentity: buildPromotionModelIdentity({
            ...candidateWithBenchmarkIdentity,
            promotionState: effectivePromotionState,
          }, linkedBenchmark),
          promotionState: effectivePromotionState,
          promotionSummary: effectivePromotionSummary,
          promotionGate: gate,
          routeBundlePromotion: effectiveRouteBundlePromotion,
          proofRequirement: effectiveProofRequirement,
        };
      })
      .filter((candidate) => candidateMatchesWorkspace(candidate, workspaceRoot, selectedLabRoot))
    : [];
  const backups = promotionsRoot ? listBackupMetadata(workspaceRoot) : [];
  const history = promotionsRoot ? readHistory(workspaceRoot) : [];
  const currentRing = selectedLabRoot ? 'lab' : 'live';
  const currentCandidate = selectedLabRoot
    ? candidates.find((candidate) => candidate.labRoot === selectedLabRoot)
    : null;
  const readyCandidates = candidates.filter((candidate) => candidate.status === 'candidate');
  const firstReadyCandidate = readyCandidates.find((candidate) => candidate?.promotionGate?.canPromote === true)
    || readyCandidates[0]
    || null;
  const effectiveCandidate = currentCandidate || firstReadyCandidate;
  const effectivePromotionGate = effectiveCandidate?.promotionGate && typeof effectiveCandidate.promotionGate === 'object'
    ? effectiveCandidate.promotionGate
    : buildPromotionGate({}, acceptanceState, null, null);
  const holdCandidates = candidates.filter((candidate) => candidate?.promotionGate?.canPromote !== true);
  const rollbackCandidates = candidates.filter((candidate) => String(candidate.status || "").trim().toLowerCase() === "promoted" && String(candidate.promotionState || "").trim().toLowerCase() !== "promoted");
  return {
    ok: true,
    promotionsRoot: promotionsRoot || '',
    currentRing: effectiveCandidate?.status === 'candidate' ? 'candidate' : currentRing,
    currentCandidateId: effectiveCandidate?.id || '',
    candidates,
    candidateCount: candidates.length,
    readyCandidates,
    holdCandidates,
    rollbackCandidates,
    backups,
    backupCount: backups.length,
    latestBackupId: String(backups[0]?.id || '').trim(),
    history: history.slice(0, 40),
    promotionGate: effectivePromotionGate,
    currentCandidateIdentity: effectiveCandidate?.modelIdentity || null,
    currentBenchmarkIdentity: effectiveCandidate?.benchmarkIdentity || null,
    acceptance: {
      exists: acceptanceState.exists,
      outputPath: acceptanceState.outputPath,
      summary: acceptanceState.summary || null,
    },
  };
}

function exportDebugBundle(workspaceRoot, payload = {}) {
  const outputPath = path.join(
    debugOutputRoot(workspaceRoot),
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${slugify(payload.name || 'monitor-debug', 'monitor-debug')}.json`,
  );
  const document = {
    exportedAt: nowIso(),
    workspaceRoot,
    payload,
  };
  writeJsonFileAtomic(outputPath, document);
  return {
    ok: true,
    outputPath,
  };
}

module.exports = {
  createCandidate,
  ensurePromotionsRoot,
  exportDebugBundle,
  listPromotionState,
  promoteCandidate,
  rollbackPromotion,
};
