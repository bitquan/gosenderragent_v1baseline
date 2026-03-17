'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const { readLatestAcceptanceReport, summarizeAcceptanceReport } = require('./acceptance-report');
const { getConfiguredAssistantPromotionsRoot } = require('./assistant-paths');
const { buildBenchmarkIdentity, listBenchmarkRuns } = require('./benchmarks');
const { ensureDirectory, isWithin, nowIso, randomId, readJsonFile, writeJsonFileAtomic } = require('./utils');

const CANDIDATES_FILE = 'candidates.json';
const HISTORY_FILE = 'history.json';
const BACKUPS_DIR = 'backups';
const DEBUG_DIR = 'debug';
const LAB_META_FILE = '.gos-lab.json';
const INTERNAL_PROMOTION_PATHS = new Set([
  '.gos-lab.json',
]);

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
    notes: String(candidate.notes || '').trim(),
    promotionState: String(candidate.promotionState || '').trim() || 'blocked',
    promotionSummary: String(candidate.promotionSummary || '').trim(),
    promotedAt: String(candidate.promotedAt || '').trim(),
    latestBackupId: String(candidate.latestBackupId || '').trim(),
    modelProfileId: String(candidate.modelProfileId || '').trim(),
    variantType: String(candidate.variantType || 'wrapped').trim().toLowerCase() || 'wrapped',
    baseModel: String(candidate.baseModel || '').trim(),
    taskMode: String(candidate.taskMode || '').trim().toLowerCase(),
    providerSource: String(candidate.providerSource || '').trim().toLowerCase(),
  };
}

function readPromotionAcceptanceState(workspaceRoot) {
  const acceptance = readLatestAcceptanceReport(workspaceRoot);
  const report = acceptance?.report && typeof acceptance.report === 'object' ? acceptance.report : null;
  const summary = report ? summarizeAcceptanceReport(report) : null;
  return {
    exists: acceptance?.exists === true,
    outputPath: String(acceptance?.outputPath || '').trim(),
    report,
    summary,
  };
}

function buildPromotionGate(candidate = {}, acceptanceState = {}) {
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
  const latestBenchmark = findLatestRelevantBenchmark(workspaceRoot, labRoot);
  const explicitVerificationOk = payload?.verification?.ok === true;
  const benchmarkOk = String(latestBenchmark?.status || '').trim().toLowerCase() === 'pass';
  const verified = explicitVerificationOk || benchmarkOk;
  if (!verified && payload.force !== true) {
    throw new Error('Candidate creation requires a passing benchmark or explicit verified result.');
  }
  const acceptanceState = readPromotionAcceptanceState(workspaceRoot);
  const promotionGate = buildPromotionGate({
    verification: { ok: verified },
  }, acceptanceState);

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
    modelProfileId: String(payload.modelProfileId || latestBenchmark?.modelProfileId || latestBenchmark?.wrappedProfileId || '').trim(),
    variantType: String(payload.variantType || 'wrapped').trim().toLowerCase() || 'wrapped',
    baseModel: String(payload.baseModel || latestBenchmark?.baseModel || latestBenchmark?.model || '').trim(),
    taskMode: String(payload.taskMode || latestBenchmark?.taskMode || '').trim().toLowerCase(),
    providerSource: String(payload.providerSource || latestBenchmark?.providerSource || '').trim().toLowerCase(),
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
  const promotionGate = buildPromotionGate(candidate, acceptanceState);
  if (!promotionGate.canPromote && payload.force !== true) {
    throw new Error(promotionGate.summary);
  }
  const changedEntries = collectChangedEntries(candidate.labRoot);
  if (!changedEntries.length) {
    throw new Error('This candidate has no changed files to promote.');
  }
  const backup = createPromotionBackup(workspaceRoot, {
    candidateId,
    targetWorkspaceRoot: candidate.targetWorkspaceRoot || workspaceRoot,
    labRoot: candidate.labRoot,
    changedEntries,
  });
  applyChangedEntries(candidate.targetWorkspaceRoot || workspaceRoot, candidate.labRoot, changedEntries);

  const nextCandidate = normalizeCandidate({
    ...candidate,
    status: 'promoted',
    updatedAt: nowIso(),
    promotedAt: nowIso(),
    latestBackupId: backup.id,
    changeSummary: buildChangeSummary(changedEntries),
    promotionState: 'promoted',
    promotionSummary: `Promoted from ${candidate.labRoot || 'lab'} into ${candidate.targetWorkspaceRoot || workspaceRoot}.`,
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
  });
  return {
    ok: true,
    candidate: nextCandidate,
    backup,
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
  for (const entry of entries) {
    restoreBackupEntry(workspaceRoot, targetWorkspaceRoot, backupId, entry);
  }
  const candidates = readCandidates(workspaceRoot).map((candidate) => {
    if (String(candidate.id || '').trim() !== String(manifest.candidateId || '').trim()) {
      return candidate;
    }
    return normalizeCandidate({
      ...candidate,
      status: 'rolled-back',
      updatedAt: nowIso(),
      latestBackupId: backupId,
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
  };
}

function listPromotionState(workspaceRoot, payload = {}) {
  const promotionsRoot = getConfiguredAssistantPromotionsRoot(workspaceRoot);
  const acceptanceState = promotionsRoot ? readPromotionAcceptanceState(workspaceRoot) : { exists: false, outputPath: '', report: null, summary: null };
  const selectedLabRoot = String(payload.labRoot || '').trim();
  const benchmarkRuns = listBenchmarkRuns(workspaceRoot).runs;
  const candidates = promotionsRoot
    ? readCandidates(workspaceRoot).map((candidate) => {
        const normalized = normalizeCandidate(candidate);
        const linkedBenchmark = findLatestRelevantBenchmark(workspaceRoot, normalized.labRoot || selectedLabRoot, benchmarkRuns);
        const gate = buildPromotionGate(normalized, acceptanceState);
        return {
          ...normalized,
          benchmarkIdentity: linkedBenchmark
            ? (linkedBenchmark.benchmarkIdentity && typeof linkedBenchmark.benchmarkIdentity === 'object'
              ? linkedBenchmark.benchmarkIdentity
              : buildBenchmarkIdentity(linkedBenchmark))
            : null,
          modelIdentity: buildPromotionModelIdentity({
            ...normalized,
            promotionState: normalized.status === 'promoted' ? 'promoted' : gate.status,
          }, linkedBenchmark),
          promotionState: normalized.status === 'promoted' ? 'promoted' : gate.status,
          promotionSummary: normalized.status === 'promoted' ? normalized.promotionSummary : gate.summary,
          promotionGate: gate,
        };
      })
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
    : buildPromotionGate({}, acceptanceState);
  return {
    ok: true,
    promotionsRoot: promotionsRoot || '',
    currentRing: effectiveCandidate?.status === 'candidate' ? 'candidate' : currentRing,
    currentCandidateId: effectiveCandidate?.id || '',
    candidates,
    candidateCount: candidates.length,
    readyCandidates,
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
