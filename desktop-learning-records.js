'use strict';

const fs = require('fs');
const path = require('path');

const {
  getAssistantArtifactsRoot,
  getAssistantRunsDir,
  readConfigMap,
} = require('./core/assistant-paths');

const APPROVED_DOCUMENTATION_SOURCES = Object.freeze([
  { domain: 'react.dev', label: 'React', provider: 'Meta', safetyLevel: 'official', category: 'frontend' },
  { domain: 'developer.mozilla.org', label: 'MDN Web Docs', provider: 'MDN', safetyLevel: 'official', category: 'web-platform' },
  { domain: 'nodejs.org', label: 'Node.js', provider: 'Node.js Foundation', safetyLevel: 'official', category: 'runtime' },
  { domain: 'www.electronjs.org', label: 'Electron', provider: 'Electron', safetyLevel: 'official', category: 'desktop' },
  { domain: 'electronjs.org', label: 'Electron', provider: 'Electron', safetyLevel: 'official', category: 'desktop' },
  { domain: 'code.visualstudio.com', label: 'VS Code', provider: 'Microsoft', safetyLevel: 'official', category: 'editor' },
  { domain: 'docs.python.org', label: 'Python', provider: 'Python Software Foundation', safetyLevel: 'official', category: 'language' },
  { domain: 'fastapi.tiangolo.com', label: 'FastAPI', provider: 'FastAPI', safetyLevel: 'official', category: 'backend' },
  { domain: 'docs.sqlalchemy.org', label: 'SQLAlchemy', provider: 'SQLAlchemy', safetyLevel: 'official', category: 'backend' },
  { domain: 'docs.pydantic.dev', label: 'Pydantic', provider: 'Pydantic', safetyLevel: 'official', category: 'backend' },
  { domain: 'pydantic.dev', label: 'Pydantic', provider: 'Pydantic', safetyLevel: 'official', category: 'backend' },
  { domain: 'www.postgresql.org', label: 'PostgreSQL', provider: 'PostgreSQL', safetyLevel: 'official', category: 'database' },
  { domain: 'postgresql.org', label: 'PostgreSQL', provider: 'PostgreSQL', safetyLevel: 'official', category: 'database' },
]);

function safeStamp(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }
  return date.toISOString().replace(/[:.]/g, '-');
}

function trimText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeList(value) {
  return Array.isArray(value) ? value : [];
}

function resolvePath(workspaceRoot, configuredPath, fallbackPath) {
  if (!configuredPath) {
    return fallbackPath;
  }
  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }
  return path.join(workspaceRoot, configuredPath);
}

function getAssistantDevDataDir(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  if (config.assistant_dev_data_dir) {
    return resolvePath(workspaceRoot, config.assistant_dev_data_dir, workspaceRoot);
  }
  const artifactsRoot = getAssistantArtifactsRoot(workspaceRoot);
  return artifactsRoot ? path.join(artifactsRoot, 'dev_data') : workspaceRoot;
}

function resolveApprovedDocsDir(workspaceRoot) {
  return path.join(getAssistantRunsDir(workspaceRoot), 'approved_docs');
}

function resolveLayoutDiagnosticsDir(workspaceRoot) {
  return path.join(getAssistantRunsDir(workspaceRoot), 'layout_diagnostics');
}

function resolveExperimentDatasetPath(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  if (config.assistant_experiment_dataset_path) {
    return resolvePath(workspaceRoot, config.assistant_experiment_dataset_path, path.join(workspaceRoot, 'dev_assistant_experiments.jsonl'));
  }
  return path.join(getAssistantDevDataDir(workspaceRoot), 'dev_assistant_experiments.jsonl');
}

function resolveTrainingHandoffPath(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  if (config.assistant_training_handoff_path) {
    return resolvePath(workspaceRoot, config.assistant_training_handoff_path, path.join(path.dirname(resolveExperimentDatasetPath(workspaceRoot)), 'training_handoff.json'));
  }
  return path.join(path.dirname(resolveExperimentDatasetPath(workspaceRoot)), 'training_handoff.json');
}

function listDesktopArtifactRoots(workspaceRoot) {
  const roots = [
    workspaceRoot,
    getAssistantRunsDir(workspaceRoot),
    getAssistantArtifactsRoot(workspaceRoot),
    getAssistantDevDataDir(workspaceRoot),
    path.dirname(resolveExperimentDatasetPath(workspaceRoot)),
    path.dirname(resolveTrainingHandoffPath(workspaceRoot)),
  ].filter(Boolean).map((item) => path.resolve(String(item)));
  return Array.from(new Set(roots));
}

function resolveDesktopArtifactPath(workspaceRoot, candidatePath) {
  const rawPath = String(candidatePath || '').trim();
  if (!rawPath) {
    return '';
  }
  const fullPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(workspaceRoot, rawPath);
  const allowedRoots = listDesktopArtifactRoots(workspaceRoot);
  const isAllowed = allowedRoots.some((rootPath) => fullPath === rootPath || fullPath.startsWith(`${rootPath}${path.sep}`));
  if (!isAllowed || !fs.existsSync(fullPath)) {
    return '';
  }
  return fullPath;
}

function guessArtifactLanguage(fullPath) {
  const ext = path.extname(String(fullPath || '')).toLowerCase();
  if (ext === '.json') {
    return 'json';
  }
  if (ext === '.jsonl') {
    return 'jsonl';
  }
  if (ext === '.md') {
    return 'markdown';
  }
  return 'text';
}

function formatArtifactPreview(raw, language, maxChars) {
  const text = String(raw || '');
  if (language === 'json') {
    try {
      const parsed = JSON.parse(text);
      const pretty = JSON.stringify(parsed, null, 2);
      return {
        content: pretty.length > maxChars ? `${pretty.slice(0, maxChars)}\n…` : pretty,
        truncated: pretty.length > maxChars,
      };
    } catch (_err) {
      return {
        content: text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text,
        truncated: text.length > maxChars,
      };
    }
  }
  return {
    content: text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text,
    truncated: text.length > maxChars,
  };
}

function htmlEntityDecode(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripHtmlToText(html) {
  return htmlEntityDecode(String(html || ''))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function approvedDocumentationAllowlist() {
  return APPROVED_DOCUMENTATION_SOURCES.map((item) => ({
    domain: item.domain,
    label: item.label,
    provider: item.provider || item.label,
    safetyLevel: item.safetyLevel || 'official',
    category: item.category || 'docs',
  }));
}

function recommendApprovedDocumentationSources(context = {}) {
  const haystack = [
    context.targetPath,
    context.title,
    context.objective,
    context.summary,
    context.message,
    context.category,
    context.topic,
  ].map((item) => String(item || '').trim().toLowerCase()).filter(Boolean).join(' • ');

  const scoreByDomain = new Map();
  const bump = (domain, score, reason) => {
    const current = scoreByDomain.get(domain) || { domain, score: 0, reasons: [] };
    current.score += Number(score || 0);
    if (reason && !current.reasons.includes(reason)) {
      current.reasons.push(reason);
    }
    scoreByDomain.set(domain, current);
  };

  if (/(react|jsx|tsx|component|hook|frontend|ui|screen|layout)/.test(haystack)) {
    bump('react.dev', 5, 'React and UI guidance fits this slice.');
    bump('developer.mozilla.org', 3, 'MDN can help with browser and layout details.');
  }
  if (/(electron|desktop|browserwindow|ipc|preload|main process)/.test(haystack)) {
    bump('electronjs.org', 5, 'Electron docs fit desktop shell and IPC work.');
    bump('developer.mozilla.org', 2, 'MDN can support browser-side behavior inside Electron.');
    bump('nodejs.org', 2, 'Node runtime details may matter for Electron host code.');
  }
  if (/(vscode|extension|editor|tasks\\.json|launch\\.json|command palette|language server)/.test(haystack)) {
    bump('code.visualstudio.com', 6, 'VS Code docs fit editor and extension work.');
    bump('nodejs.org', 2, 'Node runtime behavior may affect extension host code.');
  }
  if (/(python|pip|venv|packaging|fastapi|pydantic|sqlalchemy|backend|alembic)/.test(haystack)) {
    bump('docs.python.org', 4, 'Python docs fit packaging and runtime setup.');
    bump('fastapi.tiangolo.com', 3, 'FastAPI docs fit backend API slices.');
    bump('docs.pydantic.dev', 3, 'Pydantic docs fit data model and validation work.');
    bump('docs.sqlalchemy.org', 3, 'SQLAlchemy docs fit ORM and migration slices.');
  }
  if (/(postgres|database|sql|migration|schema|query)/.test(haystack)) {
    bump('postgresql.org', 4, 'PostgreSQL docs fit database and schema review.');
    bump('docs.sqlalchemy.org', 3, 'SQLAlchemy docs fit ORM and migration behavior.');
  }
  if (/(node|npm|package\\.json|runtime|stream|fs|path|child_process)/.test(haystack)) {
    bump('nodejs.org', 5, 'Node.js docs fit runtime and tooling behavior.');
  }
  if (/(dom|css|html|fetch|web|browser|accessibility|aria)/.test(haystack)) {
    bump('developer.mozilla.org', 5, 'MDN fits web platform and browser behavior.');
  }

  const ranked = Array.from(scoreByDomain.values())
    .map((entry) => {
      const rule = approvedDocumentationRuleForDomain(entry.domain);
      return rule
        ? {
            domain: rule.domain,
            label: rule.label,
            provider: rule.provider || rule.label,
            category: rule.category || 'docs',
            safetyLevel: rule.safetyLevel || 'official',
            score: entry.score,
            reason: entry.reasons[0] || `Trusted ${rule.label} docs fit this slice.`,
            topic: trimText(context.topic || context.title || context.targetPath || context.summary),
          }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return String(left.domain || '').localeCompare(String(right.domain || ''));
    });

  if (ranked.length > 0) {
    return ranked.slice(0, 4);
  }

  return approvedDocumentationAllowlist()
    .filter((item) => ['developer.mozilla.org', 'nodejs.org', 'docs.python.org'].includes(item.domain))
    .map((item) => ({
      ...item,
      score: 1,
      reason: 'General trusted docs fallback for the current slice.',
      topic: trimText(context.topic || context.title || context.targetPath || context.summary),
    }))
    .slice(0, 3);
}

function approvedDocumentationRuleForDomain(rawDomain) {
  const hostname = String(rawDomain || '').trim().toLowerCase();
  if (!hostname) {
    return null;
  }
  return APPROVED_DOCUMENTATION_SOURCES.find((item) => hostname === item.domain || hostname.endsWith(`.${item.domain}`)) || null;
}

function approvedDocumentationRuleForUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (parsed.protocol !== 'https:') {
      return null;
    }
    return approvedDocumentationRuleForDomain(parsed.hostname);
  } catch (_err) {
    return null;
  }
}

function hoursSince(value) {
  const stamp = new Date(value || 0).getTime();
  if (!Number.isFinite(stamp) || stamp <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return (Date.now() - stamp) / (1000 * 60 * 60);
}

function documentationFreshnessLabel(ageHours) {
  if (!Number.isFinite(ageHours)) {
    return 'unknown';
  }
  if (ageHours <= 72) {
    return 'fresh';
  }
  if (ageHours <= 240) {
    return 'aging';
  }
  return 'stale';
}

function recommendedDocsActionForFreshness(freshnessLabel, exists) {
  const label = String(freshnessLabel || '').trim().toLowerCase();
  if (!exists) {
    return 'Scout a trusted docs source before relying on docs-aware review help.';
  }
  if (label === 'fresh') {
    return 'Use the latest trusted docs during the next bounded revision or review pass.';
  }
  if (label === 'aging') {
    return 'Docs are aging. Reuse them carefully and refresh before a docs-led promotion if the surface changed.';
  }
  if (label === 'stale') {
    return 'Refresh the trusted docs context before trusting the next docs-led revision or promotion.';
  }
  return 'Review the trusted docs vault before relying on docs-guided changes.';
}

function normalizeApprovedDocumentationArtifact(payload = {}, outputPath = '') {
  const inferredRule = approvedDocumentationRuleForDomain(payload.domain)
    || approvedDocumentationRuleForUrl(payload.url)
    || approvedDocumentationRuleForUrl(payload.requestedUrl);
  return {
    outputPath: trimText(outputPath),
    generatedAt: trimText(payload.generatedAt),
    url: trimText(payload.url || payload.requestedUrl),
    requestedUrl: trimText(payload.requestedUrl),
    domain: trimText(payload.domain, inferredRule?.domain || ''),
    label: trimText(payload.source, inferredRule?.label || 'Trusted docs'),
    provider: trimText(payload.provider, inferredRule?.provider || inferredRule?.label || 'Trusted docs'),
    safetyLevel: trimText(payload.safetyLevel, inferredRule?.safetyLevel || 'official'),
    category: trimText(payload.category, inferredRule?.category || 'docs'),
    title: trimText(payload.title),
    section: trimText(payload.section),
    reason: trimText(payload.reason),
    excerpt: trimText(payload.excerpt),
    summary: trimText(payload.title || payload.section || payload.url, 'Approved documentation source ready.'),
  };
}

async function fetchTextFromUrl(url) {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is unavailable in this runtime.');
  }
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'GoSenderr Desktop Agent approved-doc-fetch/0.1',
      accept: 'text/html,text/plain;q=0.9,*/*;q=0.2',
    },
  });
  if (!response.ok) {
    throw new Error(`Documentation fetch failed with status ${response.status}.`);
  }
  const finalRule = approvedDocumentationRuleForUrl(response.url || url);
  if (!finalRule) {
    throw new Error('Documentation fetch redirected outside the approved domain allowlist.');
  }
  return {
    url: response.url || url,
    contentType: String(response.headers.get('content-type') || '').toLowerCase(),
    text: await response.text(),
    rule: finalRule,
  };
}

function readDesktopArtifactPreview(workspaceRoot, candidatePath, options = {}) {
  const maxChars = Number(options.maxChars || 12000);
  const fullPath = resolveDesktopArtifactPath(workspaceRoot, candidatePath);
  if (!fullPath) {
    return { ok: false, message: 'Artifact path is unavailable or outside allowed assistant artifact roots.' };
  }
  const stat = fs.statSync(fullPath);
  if (!stat.isFile()) {
    return { ok: false, message: 'Only files can be previewed.', path: fullPath };
  }
  const raw = fs.readFileSync(fullPath, 'utf8');
  const language = guessArtifactLanguage(fullPath);
  const preview = formatArtifactPreview(raw, language, maxChars);
  return {
    ok: true,
    path: fullPath,
    language,
    truncated: preview.truncated,
    byteLength: Buffer.byteLength(raw, 'utf8'),
    lineCount: raw.split(/\r?\n/).length,
    content: preview.content,
  };
}

function buildDesktopLearningRecord(snapshot, options = {}) {
  const recentRuns = normalizeList(snapshot?.recentRuns);
  const latestRun = snapshot?.latestRun || recentRuns[0] || null;
  const manager = snapshot?.manager || {};
  const training = manager.training || {};
  const approvals = manager.approvals || {};
  const worktree = snapshot?.worktree || manager.worktree || {};
  const currentRunDetail = manager.currentRunDetail || {};
  const latestSprint = snapshot?.latestSprint || null;
  const changedFiles = normalizeList(snapshot?.changedFiles);
  const approvedSources = normalizeList(options.approvedSources).map((item) => ({
    url: trimText(item?.url),
    domain: trimText(item?.domain),
    title: trimText(item?.title),
    section: trimText(item?.section),
    reason: trimText(item?.reason),
    fetchedAt: trimText(item?.fetchedAt || item?.generatedAt),
    artifactPath: trimText(item?.artifactPath || item?.outputPath),
    usedInPatch: item?.usedInPatch === true,
    citedInArtifact: item?.citedInArtifact === true,
    usefulnessRating: Number(item?.usefulnessRating || 0) || 0,
    impactSummary: trimText(item?.impactSummary),
  })).filter((item) => item.url);
  const validationFailedCount = Number(latestRun?.testSummary?.failed_count || latestRun?.testSummary?.failedCount || 0);
  const validationPassedCount = Number(latestRun?.testSummary?.passed_count || latestRun?.testSummary?.passedCount || 0);
  const validationSkippedCount = Number(latestRun?.testSummary?.skipped_count || latestRun?.testSummary?.skippedCount || 0);
  const patchArtifactCount = normalizeList(latestRun?.artifactPaths).length;
  const operatorCorrections = normalizeList(options.operatorCorrections).map((item) => ({
    field: trimText(item?.field),
    before: trimText(item?.before),
    after: trimText(item?.after),
    reason: trimText(item?.reason),
  })).filter((item) => item.field || item.reason);
  const validationCommands = normalizeList(options.validationCommands).map((item) => ({
    command: trimText(item?.command || item),
    kind: trimText(item?.kind),
    outcome: trimText(item?.outcome),
  })).filter((item) => item.command);
  const patchOutcome = {
    changedFileCount: Number(changedFiles.length || 0),
    changedFiles: changedFiles.slice(0, 24),
    artifactCount: patchArtifactCount,
    repairRequired: options.patchOutcome?.repairRequired === true || trimText(latestRun?.state) === 'fail',
    reverted: options.patchOutcome?.reverted === true,
    diffSizeEstimate: trimText(options.patchOutcome?.diffSizeEstimate, patchArtifactCount > 0 ? `${patchArtifactCount} artifact-backed change(s)` : ''),
    patchPaths: normalizeList(options.patchOutcome?.patchPaths).length ? normalizeList(options.patchOutcome.patchPaths) : changedFiles.slice(0, 24),
  };
  const reviewQuality = {
    pendingApprovalCount: Number(approvals.pending || approvals.total || 0),
    deferredCount: Number(approvals.deferred || 0),
    rejectedCount: Number(approvals.rejected || 0),
    queueSize: normalizeList(manager.approvalQueue).length,
    operatorDecisionReason: trimText(options.reviewQuality?.operatorDecisionReason),
    protectedPathTouched: options.reviewQuality?.protectedPathTouched === true || normalizeList(worktree.allowedTargetPaths).length > 0,
    timeToApprovalSeconds: Number(options.reviewQuality?.timeToApprovalSeconds || 0) || 0,
  };
  const uiContext = {
    theme: trimText(options.uiContext?.theme),
    layoutPreset: trimText(options.uiContext?.layoutPreset),
    surfaceTemplate: trimText(options.uiContext?.surfaceTemplate),
    activeView: trimText(options.uiContext?.activeView),
    panelView: trimText(options.uiContext?.panelView),
    viewport: options.uiContext?.viewport && typeof options.uiContext.viewport === 'object' ? options.uiContext.viewport : {},
    layoutIssueCount: Number(options.uiContext?.layoutIssueCount || 0) || 0,
    layoutIssueTypes: normalizeList(options.uiContext?.layoutIssueTypes).map((item) => trimText(item)).filter(Boolean),
  };
  const docUsefulness = {
    consultedCount: approvedSources.length,
    usedInPatchCount: approvedSources.filter((item) => item.usedInPatch).length,
    citedInArtifactCount: approvedSources.filter((item) => item.citedInArtifact).length,
    averageUsefulnessRating: approvedSources.length
      ? Number((approvedSources.reduce((sum, item) => sum + Number(item.usefulnessRating || 0), 0) / approvedSources.length).toFixed(2))
      : 0,
    sources: approvedSources,
  };
  const operatorSupervision = {
    interventionRequired: options.operatorSupervision?.interventionRequired === true || operatorCorrections.length > 0,
    operatorCorrections,
    acceptedWithoutChanges: Number(options.operatorSupervision?.acceptedWithoutChanges || 0) || 0,
    rejectedChanges: Number(options.operatorSupervision?.rejectedChanges || 0) || 0,
    supervisionSummary: trimText(options.operatorSupervision?.summary),
  };
  const experimentLinks = {
    experimentId: trimText(options.experimentLinks?.experimentId || latestRun?.experimentRun?.id || latestRun?.experimentRunId),
    strategy: trimText(options.experimentLinks?.strategy || latestRun?.ownerExperimentSummary?.recommended_next_action || latestRun?.ownerExperimentSummary?.recommendedNextAction),
    benchmarkSummary: trimText(options.experimentLinks?.benchmarkSummary),
    scoreBefore: Number(options.experimentLinks?.scoreBefore || 0) || 0,
    scoreAfter: Number(options.experimentLinks?.scoreAfter || 0) || 0,
    improvedTrust: options.experimentLinks?.improvedTrust === true,
    improvedQuality: options.experimentLinks?.improvedQuality === true,
    improvedSpeed: options.experimentLinks?.improvedSpeed === true,
  };
  const trainingReadiness = {
    safeForTraining: options.trainingReadiness?.safeForTraining !== undefined
      ? options.trainingReadiness.safeForTraining === true
      : validationFailedCount === 0,
    repositoryGrounded: options.trainingReadiness?.repositoryGrounded !== undefined
      ? options.trainingReadiness.repositoryGrounded === true
      : (changedFiles.length > 0 || normalizeList(worktree.allowedTargetPaths).length > 0),
    approvalComplete: options.trainingReadiness?.approvalComplete !== undefined
      ? options.trainingReadiness.approvalComplete === true
      : Number(approvals.pending || 0) === 0,
    containsExternalDocSupport: approvedSources.length > 0,
    validationPassed: validationFailedCount === 0,
    operatorReviewed: operatorCorrections.length > 0 || Number(options.operatorSupervision?.acceptedWithoutChanges || 0) > 0,
  };
  const recommendedActions = normalizeList(latestRun?.recommendedActions).slice(0, 5).map((item) => ({
    title: trimText(item?.title || item?.action_type || item?.actionType, 'action'),
    reason: trimText(item?.reason || item?.summary || ''),
  }));

  return {
    kind: 'desktop-supervised-learning-record',
    generatedAt: new Date().toISOString(),
    focusArea: trimText(options.focusArea, 'desktop-ui-self-improvement'),
    summary: trimText(options.summary, 'Captured supervised desktop self-improvement learning record.'),
    operatorIntent: trimText(options.operatorIntent, 'supervised desktop self-improvement'),
    workspaceRoot: trimText(snapshot?.workspaceRoot),
    latestRun: latestRun
      ? {
          runId: trimText(latestRun.runId),
          label: trimText(latestRun.label || latestRun.command || latestRun.action, 'run'),
          state: trimText(latestRun.state, 'unknown'),
          generatedAt: trimText(latestRun.generatedAt || latestRun.updatedAt || latestRun.startedAt),
          ticket: trimText(latestRun.ticket),
          runSummary: latestRun.runSummary || {},
          testSummary: latestRun.testSummary || {},
          reviewSummary: latestRun.reviewSummary || {},
          reviewQueueSummary: latestRun.reviewQueueSummary || {},
          ownerExperimentSummary: latestRun.ownerExperimentSummary || {},
          experimentBenchmarkSummary: latestRun.experimentBenchmarkSummary || {},
          trainingHandoff: latestRun.trainingHandoff || {},
          recommendedActions,
          artifactPaths: normalizeList(latestRun.artifactPaths),
        }
      : null,
    validation: {
      latestState: trimText(latestRun?.state, 'idle'),
      latestSprint: latestSprint || {},
      failedCount: validationFailedCount,
      passedCount: validationPassedCount,
      skippedCount: validationSkippedCount,
      changedFiles,
    },
    review: {
      pendingApprovalCount: Number(approvals.pending || approvals.total || 0),
      deferredCount: Number(approvals.deferred || 0),
      rejectedCount: Number(approvals.rejected || 0),
      queue: normalizeList(manager.approvalQueue).slice(0, 8),
    },
    workspace: {
      scopeLabel: trimText(worktree.scopeLabel, 'workspace'),
      displayName: trimText(worktree.displayName),
      changedCount: Number(worktree.changedCount || changedFiles.length || 0),
      activeFilePath: trimText(worktree.activeFilePath),
      allowedTargetPaths: normalizeList(worktree.allowedTargetPaths),
    },
    training: {
      exists: training.exists === true,
      state: trimText(training.state, 'idle'),
      exampleCount: Number(training.exampleCount || 0),
      pendingRunsCount: Number(training.pendingRunsCount || 0),
      generatedAt: trimText(training.generatedAt),
      outputPath: trimText(training.outputPath),
    },
    patchOutcome,
    reviewQuality,
    validationDepth: {
      commands: validationCommands,
      totalChecks: validationPassedCount + validationFailedCount + validationSkippedCount,
      failedCount: validationFailedCount,
      passedCount: validationPassedCount,
      skippedCount: validationSkippedCount,
      firstFailure: trimText(options.validationDepth?.firstFailure),
      failureKind: trimText(options.validationDepth?.failureKind),
    },
    uiContext,
    learnedSignals: [
      trimText(currentRunDetail.nextActionText),
      trimText(currentRunDetail.reviewText),
      trimText(currentRunDetail.trainingText),
      trimText(currentRunDetail.experimentText),
      ...normalizeList(options.learnedSignals).map((item) => trimText(item)).filter(Boolean),
    ].filter(Boolean),
    approvedSources,
    docUsefulness,
    operatorSupervision,
    experimentLinks,
    trainingReadiness,
    notes: normalizeList(options.notes).map((item) => trimText(item)).filter(Boolean),
  };
}

function buildApprovedDocumentationVault(workspaceRoot, options = {}) {
  const docsDir = resolveApprovedDocsDir(workspaceRoot);
  const allowlist = approvedDocumentationAllowlist();
  const recommendedSources = recommendApprovedDocumentationSources(options.context || {});
  const emptyVault = {
    ok: true,
    exists: false,
    count: 0,
    parsedCount: 0,
    unreadableCount: 0,
    outputDir: docsDir,
    latest: null,
    recent: [],
    domains: [],
    freshnessLabel: 'idle',
    state: 'idle',
    summary: 'Trusted docs vault is empty. Capture an approved doc source before expecting docs-aware review help.',
    recommendedAction: recommendedDocsActionForFreshness('idle', false),
    recommendedSources,
    allowedDomains: allowlist.map((item) => item.domain),
    allowlist,
  };
  if (!fs.existsSync(docsDir)) {
    return emptyVault;
  }
  const entries = fs.readdirSync(docsDir)
    .filter((name) => /^approved_doc_.*\.json$/i.test(name))
    .sort();
  if (!entries.length) {
    return emptyVault;
  }

  const parsed = [];
  let unreadableCount = 0;
  entries.forEach((name) => {
    const outputPath = path.join(docsDir, name);
    try {
      const payload = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      parsed.push(normalizeApprovedDocumentationArtifact(payload, outputPath));
    } catch (_err) {
      unreadableCount += 1;
    }
  });

  const recentLimit = Math.max(1, Number(options.limit || 8));
  const latest = parsed.length > 0 ? parsed[parsed.length - 1] : null;
  const ageHours = latest ? hoursSince(latest.generatedAt) : Number.POSITIVE_INFINITY;
  const freshnessLabel = latest ? documentationFreshnessLabel(ageHours) : 'unknown';
  const domains = Array.from(parsed.reduce((map, item) => {
    const domain = String(item.domain || '').trim();
    if (!domain) {
      return map;
    }
    const current = map.get(domain) || {
      domain,
      label: item.label || domain,
      provider: item.provider || item.label || domain,
      safetyLevel: item.safetyLevel || 'official',
      category: item.category || 'docs',
      count: 0,
    };
    current.count += 1;
    map.set(domain, current);
    return map;
  }, new Map()).values()).sort((left, right) => {
    if (right.count !== left.count) {
      return right.count - left.count;
    }
    return String(left.domain || '').localeCompare(String(right.domain || ''));
  });

  return {
    ok: true,
    exists: parsed.length > 0,
    count: entries.length,
    parsedCount: parsed.length,
    unreadableCount,
    outputDir: docsDir,
    latest: latest
      ? {
          ...latest,
          ageHours: Number.isFinite(ageHours) ? Number(ageHours.toFixed(1)) : null,
          freshnessLabel,
        }
      : null,
    recent: parsed.slice(-recentLimit).reverse(),
    domains: domains.slice(0, 8),
    freshnessLabel,
    recommendedAction: recommendedDocsActionForFreshness(freshnessLabel, parsed.length > 0),
    state: latest ? (freshnessLabel === 'fresh' ? 'ready' : 'warn') : 'warn',
    summary: latest
      ? `${parsed.length} approved doc source${parsed.length === 1 ? '' : 's'} across ${domains.length} domain${domains.length === 1 ? '' : 's'} • ${freshnessLabel} ${latest.label || latest.domain} guidance`
      : 'Trusted docs vault has artifacts, but the latest entry could not be parsed.',
    recommendedSources,
    allowedDomains: allowlist.map((item) => item.domain),
    allowlist,
  };
}

async function fetchApprovedDocumentationSource(workspaceRoot, options = {}) {
  const sourceUrl = trimText(options.url);
  if (!sourceUrl) {
    return { ok: false, message: 'Documentation URL is required.' };
  }
  const approvedRule = approvedDocumentationRuleForUrl(sourceUrl);
  if (!approvedRule) {
    return {
      ok: false,
      message: 'URL is outside the approved documentation allowlist. Use an https:// URL from the approved docs list only.',
      allowedDomains: approvedDocumentationAllowlist().map((item) => item.domain),
    };
  }
  const fetched = await fetchTextFromUrl(sourceUrl);
  const html = String(fetched.text || '');
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const headingMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = trimText(stripHtmlToText(titleMatch?.[1] || headingMatch?.[1] || ''), approvedRule.label);
  const content = fetched.contentType.includes('html') ? stripHtmlToText(html) : trimText(html);
  const excerpt = trimText(content.slice(0, 2400));
  const artifact = {
    kind: 'approved-documentation-source',
    generatedAt: new Date().toISOString(),
    url: fetched.url,
    requestedUrl: sourceUrl,
    domain: approvedRule.domain,
    source: approvedRule.label,
    provider: approvedRule.provider || approvedRule.label,
    safetyLevel: approvedRule.safetyLevel || 'official',
    category: approvedRule.category || 'docs',
    reason: trimText(options.reason, 'approved documentation reference'),
    topic: trimText(options.topic),
    title,
    section: trimText(headingMatch ? stripHtmlToText(headingMatch[1]) : title),
    contentType: fetched.contentType,
    excerpt,
  };
  const approvedDocsDir = resolveApprovedDocsDir(workspaceRoot);
  fs.mkdirSync(approvedDocsDir, { recursive: true });
  const outputPath = path.join(approvedDocsDir, `approved_doc_${safeStamp(artifact.generatedAt)}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(artifact, null, 2), 'utf8');
  return {
    ok: true,
    outputPath,
    artifact,
    summary: `Captured approved documentation source from ${approvedRule.domain}.`,
    label: 'APPROVED DOCUMENTATION',
    allowedDomains: approvedDocumentationAllowlist().map((item) => item.domain),
  };
}

function readLatestApprovedDocumentationSource(workspaceRoot) {
  const vault = buildApprovedDocumentationVault(workspaceRoot, { limit: 1 });
  if (!vault.exists || !vault.latest) {
    return {
      exists: false,
      count: Number(vault.count || 0),
      allowedDomains: vault.allowedDomains || approvedDocumentationAllowlist().map((item) => item.domain),
      vault,
    };
  }
  return {
    exists: true,
    count: vault.count,
    outputPath: trimText(vault.latest.outputPath),
    generatedAt: trimText(vault.latest.generatedAt),
    url: trimText(vault.latest.url),
    title: trimText(vault.latest.title),
    section: trimText(vault.latest.section),
    reason: trimText(vault.latest.reason),
    domain: trimText(vault.latest.domain),
    provider: trimText(vault.latest.provider),
    safetyLevel: trimText(vault.latest.safetyLevel),
    freshnessLabel: trimText(vault.latest.freshnessLabel || vault.freshnessLabel),
    summary: trimText(vault.latest.summary, 'Approved documentation source ready.'),
    payload: vault.latest,
    allowedDomains: vault.allowedDomains,
    vault,
  };
}

function captureLayoutDiagnosticsArtifact(workspaceRoot, payload = {}) {
  const diagnosticsDir = resolveLayoutDiagnosticsDir(workspaceRoot);
  fs.mkdirSync(diagnosticsDir, { recursive: true });
  const artifact = {
    kind: 'layout-diagnostics-report',
    generatedAt: new Date().toISOString(),
    workspaceRoot: trimText(workspaceRoot),
    viewId: trimText(payload.viewId),
    panelView: trimText(payload.panelView),
    theme: trimText(payload.theme),
    layoutPreset: trimText(payload.layoutPreset),
    surfaceTemplate: trimText(payload.surfaceTemplate),
    viewport: payload.viewport && typeof payload.viewport === 'object' ? payload.viewport : {},
    issueCount: Number(payload.issueCount || normalizeList(payload.issues).length || 0),
    severityCounts: payload.severityCounts && typeof payload.severityCounts === 'object' ? payload.severityCounts : {},
    summary: trimText(payload.summary, 'Captured layout diagnostics report.'),
    issues: normalizeList(payload.issues).map((item) => ({
      type: trimText(item?.type, 'issue'),
      severity: trimText(item?.severity, 'warn'),
      label: trimText(item?.label || item?.selector || 'surface'),
      selector: trimText(item?.selector),
      detail: trimText(item?.detail),
      metrics: item?.metrics && typeof item.metrics === 'object' ? item.metrics : {},
    })),
  };
  const outputPath = path.join(diagnosticsDir, `layout_diagnostics_${safeStamp(artifact.generatedAt)}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(artifact, null, 2), 'utf8');
  return {
    ok: true,
    outputPath,
    artifact,
    summary: artifact.summary,
    label: 'LAYOUT DIAGNOSTICS',
  };
}

function readLatestLayoutDiagnosticsArtifact(workspaceRoot) {
  const diagnosticsDir = resolveLayoutDiagnosticsDir(workspaceRoot);
  if (!fs.existsSync(diagnosticsDir)) {
    return { exists: false, count: 0 };
  }
  const entries = fs.readdirSync(diagnosticsDir)
    .filter((name) => /^layout_diagnostics_.*\.json$/i.test(name))
    .sort();
  if (!entries.length) {
    return { exists: false, count: 0 };
  }
  const outputPath = path.join(diagnosticsDir, entries[entries.length - 1]);
  try {
    const payload = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    return {
      exists: true,
      count: entries.length,
      outputPath,
      generatedAt: trimText(payload.generatedAt),
      summary: trimText(payload.summary),
      issueCount: Number(payload.issueCount || normalizeList(payload.issues).length || 0),
      viewId: trimText(payload.viewId),
      panelView: trimText(payload.panelView),
      payload,
    };
  } catch (_err) {
    return {
      exists: true,
      count: entries.length,
      outputPath,
      generatedAt: '',
      summary: 'Latest layout diagnostics report could not be parsed.',
      issueCount: 0,
    };
  }
}

function captureDesktopLearningRecord(workspaceRoot, snapshot, options = {}) {
  const runsDir = getAssistantRunsDir(workspaceRoot);
  const learningDir = path.join(runsDir, 'learning_records');
  fs.mkdirSync(learningDir, { recursive: true });
  const record = buildDesktopLearningRecord(snapshot, options);
  const outputPath = path.join(learningDir, `desktop_learning_record_${safeStamp(record.generatedAt)}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(record, null, 2), 'utf8');
  return {
    ok: true,
    outputPath,
    record,
    artifactPaths: [outputPath],
    summary: `Captured supervised learning record at ${path.basename(outputPath)}.`,
    label: 'DESKTOP LEARNING RECORD',
  };
}

function readLatestDesktopLearningRecord(workspaceRoot) {
  const learningDir = path.join(getAssistantRunsDir(workspaceRoot), 'learning_records');
  if (!fs.existsSync(learningDir)) {
    return { exists: false, count: 0 };
  }
  const entries = fs.readdirSync(learningDir)
    .filter((name) => /^desktop_learning_record_.*\.json$/i.test(name))
    .sort();
  if (entries.length === 0) {
    return { exists: false, count: 0 };
  }
  const latestName = entries[entries.length - 1];
  const outputPath = path.join(learningDir, latestName);
  try {
    const payload = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    return {
      exists: true,
      count: entries.length,
      outputPath,
      generatedAt: trimText(payload.generatedAt),
      summary: trimText(payload.summary),
      focusArea: trimText(payload.focusArea),
      latestRunState: trimText(payload.latestRun?.state),
      latestRunLabel: trimText(payload.latestRun?.label),
      payload,
    };
  } catch (_err) {
    return {
      exists: true,
      count: entries.length,
      outputPath,
      generatedAt: '',
      summary: 'Latest learning record could not be parsed.',
      focusArea: '',
    };
  }
}

function readLatestDesktopTrainingHandoff(workspaceRoot) {
  const datasetPath = resolveExperimentDatasetPath(workspaceRoot);
  const outputPath = resolveTrainingHandoffPath(workspaceRoot);
  if (!fs.existsSync(outputPath)) {
    return {
      exists: false,
      outputPath,
      datasetPath,
    };
  }
  try {
    const payload = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    return {
      exists: true,
      outputPath,
      datasetPath,
      generatedAt: trimText(payload.generatedAt || payload.generated_at),
      summary: trimText(payload.summary, 'Training handoff ready.'),
      recommendedFocus: trimText(payload.recommended_focus || payload.recommendedFocus),
      selectedRunCount: Number(payload.selected_run_count || payload.selectedRunCount || 0),
      payload,
    };
  } catch (_err) {
    return {
      exists: true,
      outputPath,
      datasetPath,
      generatedAt: '',
      summary: 'Latest training handoff could not be parsed.',
      recommendedFocus: '',
    };
  }
}

module.exports = {
  APPROVED_DOCUMENTATION_SOURCES,
  recommendApprovedDocumentationSources,
  buildApprovedDocumentationVault,
  buildDesktopLearningRecord,
  captureLayoutDiagnosticsArtifact,
  captureDesktopLearningRecord,
  fetchApprovedDocumentationSource,
  listDesktopArtifactRoots,
  readDesktopArtifactPreview,
  readLatestApprovedDocumentationSource,
  readLatestDesktopTrainingHandoff,
  readLatestDesktopLearningRecord,
  readLatestLayoutDiagnosticsArtifact,
  resolveDesktopArtifactPath,
  resolveExperimentDatasetPath,
  resolveTrainingHandoffPath,
};
