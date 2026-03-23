'use strict';

const fs = require('fs');
const path = require('path');
const assistantPaths = require('./assistant-paths');
const { getAssistantRunsDir } = assistantPaths;
const { isIgnoredWorkspacePath } = require('./review');

const BAT_BOARD_ITEM_RE = /^\s*[-*]\s+`BAT<(\d+)>`\s+(.+)$/;

function readJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function readWorkspaceConfigMap(workspaceRoot) {
  if (!workspaceRoot) {
    return {};
  }
  const out = {};
  for (const fileName of ['dev_assistant.yaml', 'dev_assistant.local.yaml']) {
    const configPath = path.join(workspaceRoot, fileName);
    if (!fs.existsSync(configPath)) {
      continue;
    }
    try {
      const lines = fs.readFileSync(configPath, 'utf8').split(/\r?\n/);
      for (const rawLine of lines) {
        const line = String(rawLine || '').split('#')[0];
        const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
        if (!match) {
          continue;
        }
        const key = match[1];
        const value = String(match[2] || '').trim().replace(/^['"]|['"]$/g, '');
        if (value) {
          out[key] = value;
        }
      }
    } catch (_err) {
      return out;
    }
  }
  return out;
}

function getBoardAssistantRunsDir(workspaceRoot) {
  if (!workspaceRoot) {
    return '';
  }
  const workspaceConfig = readWorkspaceConfigMap(workspaceRoot);
  if (workspaceConfig.assistant_runs_dir) {
    return path.isAbsolute(workspaceConfig.assistant_runs_dir)
      ? workspaceConfig.assistant_runs_dir
      : path.join(workspaceRoot, workspaceConfig.assistant_runs_dir);
  }
  if (workspaceConfig.assistant_artifacts_root) {
    const artifactsRoot = path.isAbsolute(workspaceConfig.assistant_artifacts_root)
      ? workspaceConfig.assistant_artifacts_root
      : path.join(workspaceRoot, workspaceConfig.assistant_artifacts_root);
    return path.join(artifactsRoot, 'assistant_runs');
  }
  const localRunsDir = path.join(workspaceRoot, 'docs', 'assistant_runs');
  if (fs.existsSync(localRunsDir)) {
    return localRunsDir;
  }
  return getAssistantRunsDir(workspaceRoot);
}

function resolveWorkspacePath(workspaceRoot, targetPath) {
  if (!workspaceRoot || !targetPath) {
    return '';
  }
  if (path.isAbsolute(targetPath)) {
    return targetPath;
  }
  return path.join(workspaceRoot, targetPath);
}

function toRelativeWorkspacePath(workspaceRoot, targetPath) {
  if (!workspaceRoot || !targetPath) {
    return '';
  }
  const resolved = resolveWorkspacePath(workspaceRoot, targetPath);
  const relative = path.relative(workspaceRoot, resolved);
  return relative && !relative.startsWith('..') ? relative.replace(/\\/g, '/') : String(targetPath).replace(/\\/g, '/');
}

function normalizeRuntimeContext(workspaceRoot, value) {
  const input = value && typeof value === 'object' ? value : {};
  const relatedFiles = Array.isArray(input.related_files)
    ? input.related_files
    : (Array.isArray(input.relatedFiles) ? input.relatedFiles : []);
  const changedFiles = Array.isArray(input.changed_files)
    ? input.changed_files
    : (Array.isArray(input.changedFiles) ? input.changedFiles : []);
  const artifactContext = input.artifact_context && typeof input.artifact_context === 'object'
    ? input.artifact_context
    : (input.artifactContext && typeof input.artifactContext === 'object' ? input.artifactContext : {});
  const referencedPaths = Array.isArray(artifactContext.referenced_paths)
    ? artifactContext.referenced_paths
    : (Array.isArray(artifactContext.referencedPaths) ? artifactContext.referencedPaths : []);
  return {
    ...input,
    active_file_path: toRelativeWorkspacePath(workspaceRoot, input.active_file_path || input.activeFilePath || ''),
    related_files: relatedFiles.map((item) => toRelativeWorkspacePath(workspaceRoot, item)).filter(Boolean),
    changed_files: changedFiles
      .map((item) => {
        if (!item) {
          return null;
        }
        if (typeof item === 'string') {
          return { path: toRelativeWorkspacePath(workspaceRoot, item), status: 'M' };
        }
        return {
          ...item,
          path: toRelativeWorkspacePath(workspaceRoot, item.path || item.file || ''),
          status: String(item.status || 'M'),
        };
      })
      .filter((item) => item?.path && !isIgnoredWorkspacePath(item.path)),
    artifact_context: {
      ...artifactContext,
      referenced_paths: referencedPaths.map((item) => toRelativeWorkspacePath(workspaceRoot, item)).filter(Boolean),
    },
  };
}

function normalizeWorkspaceChangedPath(workspaceRoot, value) {
  if (!value) {
    return '';
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const renamedPath = trimmed.includes(' -> ') ? trimmed.split(' -> ').pop() : trimmed;
    const rawPath = String(renamedPath || trimmed).replace(/^[A-Z?!RCMADU\s]+/, '').trim();
    return toRelativeWorkspacePath(workspaceRoot, rawPath || renamedPath || trimmed);
  }
  if (typeof value === 'object') {
    return toRelativeWorkspacePath(workspaceRoot, value.path || value.file || '');
  }
  return '';
}

function summarizeWorkspaceTopology(workspaceRoot, runtimeContext, options = {}) {
  const normalizedContext = normalizeRuntimeContext(workspaceRoot, runtimeContext);
  const hostBoundary = normalizeLooseObject(normalizedContext.host_boundary || normalizedContext.hostBoundary);
  const projectRootRaw = String(hostBoundary.project_root || hostBoundary.projectRoot || '').trim();
  const projectRoot = projectRootRaw ? resolveWorkspacePath(workspaceRoot, projectRootRaw) : '';
  const activeRoot = projectRoot || workspaceRoot || '';
  const workspaceName = workspaceRoot ? path.basename(workspaceRoot) : 'workspace';
  const activeRootName = activeRoot ? path.basename(activeRoot) : workspaceName;
  const isolated = !!(workspaceRoot && projectRoot && path.resolve(projectRoot) !== path.resolve(workspaceRoot));
  const allowedTargetPaths = Array.isArray(hostBoundary.allowed_target_paths)
    ? hostBoundary.allowed_target_paths
    : (Array.isArray(hostBoundary.allowedTargetPaths) ? hostBoundary.allowedTargetPaths : []);
  const normalizedTargetPaths = allowedTargetPaths
    .map((item) => toRelativeWorkspacePath(workspaceRoot, item))
    .filter(Boolean);
  const changedFileInputs = Array.isArray(options.changedFiles) && options.changedFiles.length > 0
    ? options.changedFiles
    : normalizedContext.changed_files;
  const changedPaths = changedFileInputs
    .map((item) => normalizeWorkspaceChangedPath(workspaceRoot, item))
    .filter((item) => item && !isIgnoredWorkspacePath(item));
  const activeFilePath = String(normalizedContext.active_file_path || normalizedContext.activeFilePath || '').trim();
  const rootRelativePath = activeRoot && workspaceRoot ? toRelativeWorkspacePath(workspaceRoot, activeRoot) : '';
  const scopeLabel = isolated ? 'isolated worktree' : (workspaceRoot ? 'main workspace' : 'no workspace');
  const displayName = isolated
    ? (rootRelativePath || activeRootName || 'isolated root')
    : (workspaceName || activeRootName || 'workspace');
  const summary = [
    scopeLabel,
    isolated && activeRootName && activeRootName !== workspaceName ? activeRootName : '',
    changedPaths.length > 0 ? `${changedPaths.length} changed` : 'clean',
    normalizedTargetPaths.length > 0 ? `${normalizedTargetPaths.length} target path${normalizedTargetPaths.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' • ');
  return {
    workspaceName,
    displayName,
    scopeLabel,
    scopeTone: isolated ? 'warn' : 'ok',
    isolated,
    activeRootPath: activeRoot,
    rootRelativePath: rootRelativePath || '',
    activeFilePath,
    changedCount: changedPaths.length,
    changedPathsPreview: changedPaths.slice(0, 4),
    allowedTargetPaths: normalizedTargetPaths,
    summary: summary || 'No workspace context yet.',
  };
}

function firstSummaryText(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) {
      return text;
    }
  }
  return '';
}

function summarizeRunDetail(run, worktreeSummary = {}) {
  const entry = run && typeof run === 'object' ? run : {};
  const runtimeContext = normalizeLooseObject(entry.runtimeContext || entry.runtime_context);
  const reviewSummary = normalizeReviewSummary(entry.reviewSummary || entry.review_summary);
  const reviewQueueSummary = normalizeLooseObject(entry.reviewQueueSummary || entry.review_queue_summary);
  const trustSummary = normalizeLooseObject(entry.trustSummary || entry.trust_summary);
  const trustSignalCount = Number(entry.trustSignalCount ?? entry.trust_signal_count ?? 0);
  const trustStateCounts = normalizeLooseObject(entry.trustStateCounts || entry.trust_state_counts);
  const queueSummary = normalizeLooseObject(entry.queueSummary || entry.queue_summary);
  const recommendation = normalizeLooseObject(entry.recommendation);
  const recommendationCandidate = normalizeLooseObject(recommendation.candidate);
  const runSummary = normalizeLooseObject(entry.runSummary || entry.run_summary);
  const testSummary = normalizeLooseObject(entry.testSummary || entry.test_summary);
  const experimentBenchmarkSummary = normalizeLooseObject(entry.experimentBenchmarkSummary || entry.experiment_benchmark_summary);
  const ownerExperimentSummary = normalizeLooseObject(entry.ownerExperimentSummary || entry.owner_experiment_summary);
  const trainingHandoff = normalizeLooseObject(entry.trainingHandoff || entry.training_handoff);
  const recommendedActions = normalizeLooseList(entry.recommendedActions || entry.recommended_actions);
  const pendingReviewCount = Number(
    reviewQueueSummary.pending_review_count
    ?? reviewQueueSummary.pendingReviewCount
    ?? reviewSummary.pendingApprovalCount
    ?? 0
  );
  const failedCount = Number(testSummary.failed_count ?? testSummary.failedCount ?? 0);
  const lowConfidenceCount = Number(reviewSummary.lowConfidencePatchCount || 0);
  const validationFingerprints = Array.isArray(entry.validationFingerprints || entry.validation_fingerprints)
    ? entry.validationFingerprints || entry.validation_fingerprints
    : [];
  const changedFiles = Array.isArray(runtimeContext.changed_files) ? runtimeContext.changed_files : [];
  const relatedFiles = Array.isArray(runtimeContext.related_files) ? runtimeContext.related_files : [];
  const bestStrategy = String(
    experimentBenchmarkSummary.best_strategy?.strategy
      || experimentBenchmarkSummary.bestStrategy?.strategy
      || ''
  ).trim();
  const experimentNext = String(
    ownerExperimentSummary.recommended_next_action
      || ownerExperimentSummary.recommendedNextAction
      || ''
  ).trim();
  const trainingFocus = String(
    trainingHandoff.recommended_focus
      || trainingHandoff.recommendedFocus
      || ''
  ).trim();
  const nextAction = recommendedActions[0] || null;
  const nextActionTitle = nextAction
    ? String(nextAction.title || nextAction.action_type || nextAction.actionType || 'Review next step').trim()
    : '';
  const nextActionReason = nextAction
    ? String(nextAction.reason || nextAction.summary || '').trim()
    : '';
  const recommendationStep = String(
    recommendationCandidate.recommended_next_step
      || recommendationCandidate.recommendedNextStep
      || recommendation.recommended_action
      || recommendation.recommendedAction
      || ''
  ).trim();
  const recommendationReason = String(
    recommendationCandidate.advisory_summary
      || recommendationCandidate.advisorySummary
      || recommendation.summary
      || recommendationCandidate.summary
      || ''
  ).trim();
  const trustState = String(
    trustSummary.trust_state
      || trustSummary.trustState
      || ''
  ).trim();
  const trustText = firstSummaryText(
    trustState ? `trust ${trustState}` : '',
    String(trustSummary.summary || '').trim().replace(/=/g, ' '),
    trustSignalCount > 0 ? `${trustSignalCount} trust signal${trustSignalCount === 1 ? '' : 's'}` : '',
  );
  const reviewText = [
    firstSummaryText(reviewQueueSummary.summary, reviewSummary.summary),
    trustText,
    pendingReviewCount > 0 ? `${pendingReviewCount} pending review` : '',
    lowConfidenceCount > 0 ? `${lowConfidenceCount} low-confidence patch${lowConfidenceCount === 1 ? '' : 'es'}` : '',
    reviewSummary.requiresManualReview ? 'manual review required' : '',
  ].filter(Boolean).join(' • ');
  const filesText = [
    runtimeContext.active_file_path ? `focus ${runtimeContext.active_file_path}` : '',
    changedFiles.length ? `${changedFiles.length} changed` : '',
    relatedFiles.length ? `${relatedFiles.length} related` : '',
  ].filter(Boolean).join(' • ');
  const experimentText = [
    Number(experimentBenchmarkSummary.total_runs || 0) > 0 ? `${Number(experimentBenchmarkSummary.total_runs || 0)} benchmark run(s)` : '',
    bestStrategy,
    experimentNext,
  ].filter(Boolean).join(' • ');
  const trainingText = [
    trainingFocus,
    String(trainingHandoff.summary || '').trim(),
  ].filter(Boolean).join(' • ');
  const riskyState = String(entry.blockedReason || entry.blocked_reason || '').trim()
    ? 'blocked'
    : (failedCount > 0 || pendingReviewCount > 0 || lowConfidenceCount > 0 || validationFingerprints.length > 0)
      ? 'review-required'
      : 'ready';
  const riskyText = [
    String(entry.blockedReason || entry.blocked_reason || '').trim(),
    failedCount > 0 ? `${failedCount} failed check${failedCount === 1 ? '' : 's'}` : '',
    pendingReviewCount > 0 ? `${pendingReviewCount} review pending` : '',
    validationFingerprints.length > 0 ? `${validationFingerprints.length} recurring fingerprint${validationFingerprints.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' • ');
  const worktreeText = [
    worktreeSummary.scopeLabel || '',
    worktreeSummary.displayName || worktreeSummary.workspaceName || '',
    filesText,
  ].filter(Boolean).join(' • ');
  const automationText = [
    queueSummary.summary,
    Number(queueSummary.prepared_task_count || 0) > 0 ? `${Number(queueSummary.prepared_task_count || 0)} prepared` : '',
    Number(queueSummary.eligible_candidate_count || 0) > 0 ? `${Number(queueSummary.eligible_candidate_count || 0)} eligible` : '',
    recommendationStep && recommendationReason ? `${recommendationStep} — ${recommendationReason}` : '',
    recommendationReason,
    recommendationStep,
  ].filter(Boolean).join(' • ');
  const nextActionText = nextActionTitle
    ? [nextActionTitle, nextActionReason].filter(Boolean).join(' — ')
    : ([
        recommendationStep && recommendationReason ? `${recommendationStep} — ${recommendationReason}` : '',
        recommendationReason,
        recommendationStep,
        experimentNext,
        trainingFocus,
        'Review queue and continue with the next safe task.',
      ].find(Boolean));
  return {
    reviewText: reviewText || 'No review queue detail recorded.',
    pendingReviewCount,
    filesText: filesText || 'No file scope recorded.',
    experimentText: experimentText || 'No benchmark detail recorded.',
    trainingText: trainingText || 'No training handoff recorded.',
    automationText: automationText || 'No automation queue detail recorded.',
    nextActionText,
    riskyState,
    riskyText: riskyText || 'No risk flags recorded.',
    worktreeText: worktreeText || 'No worktree scope recorded.',
    activeFilePath: String(runtimeContext.active_file_path || ''),
    trustSummary,
    trustSignalCount,
    trustStateCounts,
  };
}

function normalizeReviewSummary(value) {
  const summary = value && typeof value === 'object' ? value : {};
  const reviewedPaths = Array.isArray(summary.reviewed_paths)
    ? summary.reviewed_paths
    : (Array.isArray(summary.reviewedPaths) ? summary.reviewedPaths : []);
  return {
    requiresManualReview: summary.requires_manual_review === true || summary.requiresManualReview === true,
    pendingApprovalCount: Number(summary.pending_approval_count ?? summary.pendingApprovalCount ?? 0),
    lowConfidencePatchCount: Number(summary.low_confidence_patch_count ?? summary.lowConfidencePatchCount ?? 0),
    failedStepCount: Number(summary.failed_step_count ?? summary.failedStepCount ?? 0),
    summary: String(summary.summary || ''),
    activeFilePath: String(summary.active_file_path || summary.activeFilePath || ''),
    reviewedPaths: reviewedPaths.map((item) => String(item || '')).filter(Boolean),
  };
}

function normalizeApprovalRequests(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const input = item && typeof item.input === 'object' ? item.input : {};
      return {
        id: String(item?.id || ''),
        agent: String(item?.agent || ''),
        tool: String(item?.tool || ''),
        reason: String(item?.reason || ''),
        safetyLevel: String(item?.safety_level || item?.safetyLevel || ''),
        input,
        path: String(input.path || item?.path || ''),
      };
    })
    .filter((item) => item.path || item.id);
}

function normalizePatchInsights(workspaceRoot, results) {
  if (!Array.isArray(results)) {
    return [];
  }
  return results
    .map((item) => {
      const review = item?.ai_patch_review && typeof item.ai_patch_review === 'object'
        ? item.ai_patch_review
        : (item?.aiPatchReview && typeof item.aiPatchReview === 'object' ? item.aiPatchReview : null);
      if (!review) {
        return null;
      }
      return {
        path: toRelativeWorkspacePath(workspaceRoot, item.path || item.file || ''),
        selectedLabel: String(review.selected_label || review.selectedLabel || ''),
        selectedScore: Number(review.selected_score ?? review.selectedScore ?? 0),
        selectedReasons: Array.isArray(review.selected_reasons) ? review.selected_reasons.map((entry) => String(entry)) : [],
        selectedPreview: String(review.selected_preview || review.selectedPreview || ''),
        candidateCount: Number(review.candidate_count ?? review.candidateCount ?? 0),
        memoryPreferredLabels: Array.isArray(review.memory_preferred_labels)
          ? review.memory_preferred_labels.map((entry) => String(entry))
          : [],
        memoryBacked: review.memory_backed === true || review.memoryBacked === true,
        alternates: Array.isArray(review.alternate_candidates)
          ? review.alternate_candidates.map((candidate) => ({
              label: String(candidate?.label || ''),
              score: Number(candidate?.score ?? 0),
              reasons: Array.isArray(candidate?.reasons) ? candidate.reasons.map((entry) => String(entry)) : [],
              preview: String(candidate?.preview || ''),
            }))
          : [],
      };
    })
    .filter((item) => item?.path);
}

function normalizeValidationFingerprints(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => ({
    ...item,
    label: String(item?.label || ''),
    blocking: item?.blocking === true,
  })).filter((item) => item.label);
}

function normalizeRetryPolicy(value) {
  return value && typeof value === 'object'
    ? {
        ...value,
        action: String(value.action || ''),
        reason: String(value.reason || ''),
      }
    : {};
}

function normalizeEngineDecisions(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => ({
    ...item,
    type: String(item?.type || ''),
    action: String(item?.action || ''),
    reason: String(item?.reason || ''),
  })).filter((item) => item.type);
}

function normalizeEngineMetrics(value) {
  return value && typeof value === 'object' ? value : {};
}

function normalizeLooseObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeLooseList(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

function normalizeSentence(value, fallback = 'Validation failed.') {
  const firstLine = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return fallback;
  }
  let text = firstLine.replace(/^E\s+/, '').replace(/^AssertionError:\s*/i, '').trim();
  text = text.replace(/'([^']+)'/g, '"$1"');
  if (!text) {
    return fallback;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function pickLatestJson(workspaceRoot, matcher) {
  if (!workspaceRoot) {
    return null;
  }
  const runsDir = getBoardAssistantRunsDir(workspaceRoot);
  if (!fs.existsSync(runsDir)) {
    return null;
  }
  const entries = fs
    .readdirSync(runsDir)
    .filter((name) => matcher.test(name))
    .map((name) => {
      const fullPath = path.join(runsDir, name);
      const payload = readJson(fullPath);
      const stamp = payload?.generated_at || new Date(fs.statSync(fullPath).mtimeMs).toISOString();
      return { name, fullPath, payload, stamp };
    })
    .filter((entry) => entry.payload);
  entries.sort((a, b) => Date.parse(b.stamp) - Date.parse(a.stamp));
  return entries[0] || null;
}

function normalizeFixSuggestion(workspaceRoot, suggestion) {
  return {
    path: toRelativeWorkspacePath(workspaceRoot, suggestion?.path || ''),
    line: Number(suggestion?.line || 1),
    source: String(suggestion?.source || ''),
  };
}

function normalizeFailingChecks(workspaceRoot, artifactPayload) {
  const fixSuggestions = Array.isArray(artifactPayload?.fix_suggestions)
    ? artifactPayload.fix_suggestions.map((item) => normalizeFixSuggestion(workspaceRoot, item))
    : [];
  const byPath = new Map(fixSuggestions.filter((item) => item.path).map((item) => [item.path, item]));
  const checks = Array.isArray(artifactPayload?.checks) ? artifactPayload.checks : [];
  return checks
    .filter((check) => check && (check.ok === false || Number(check.exit_code || 0) !== 0))
    .map((check) => {
      const matchedSuggestion = fixSuggestions.find((item) => item.source === check.name) || byPath.values().next().value || null;
      return {
        name: String(check.name || 'check'),
        summary: normalizeSentence(check.summary || check.stderr_tail || check.stdout_tail),
        path: matchedSuggestion?.path || '',
        line: Number(matchedSuggestion?.line || 1),
      };
    });
}

function summarizeFailure(workspaceRoot, outcome, sprintPayload) {
  const rawArtifactPath = outcome?.artifactPath || outcome?.artifact || '';
  const artifactPath = toRelativeWorkspacePath(workspaceRoot, rawArtifactPath);
  const artifactPayload = readJson(resolveWorkspacePath(workspaceRoot, rawArtifactPath));
  const failingChecks = normalizeFailingChecks(workspaceRoot, artifactPayload);
  const primaryCheck = failingChecks[0] || null;
  return {
    ticket: String(outcome?.ticket || outcome?.objective_id || ''),
    artifactPath,
    generatedAt: artifactPayload?.generated_at || outcome?.generated_at || sprintPayload?.generated_at || '',
    summary: normalizeSentence(
      artifactPayload?.summary || artifactPayload?.baseline?.reason || primaryCheck?.summary || outcome?.summary,
    ),
    failingChecks,
    fixSuggestions: Array.isArray(artifactPayload?.fix_suggestions)
      ? artifactPayload.fix_suggestions.map((item) => normalizeFixSuggestion(workspaceRoot, item))
      : [],
    validationFingerprints: normalizeValidationFingerprints(artifactPayload?.validation_fingerprints || artifactPayload?.validationFingerprints),
    retryPolicy: normalizeRetryPolicy(artifactPayload?.retry_policy || artifactPayload?.retryPolicy),
    engineDecisions: normalizeEngineDecisions(artifactPayload?.engine_decisions || artifactPayload?.engineDecisions),
    engineMetrics: normalizeEngineMetrics(artifactPayload?.engine_metrics || artifactPayload?.engineMetrics),
  };
}

function extractBatStatus(tags) {
  const normalizedTags = Array.isArray(tags) ? tags.map((entry) => String(entry || '').toUpperCase()) : [];
  return normalizedTags.find((tag) => ['TODO', 'DONE', 'BLOCKED', 'IN-PROGRESS', 'UNTESTED', 'TESTED'].includes(tag)) || normalizedTags[0] || 'UNKNOWN';
}

function parseBatBoard(workspaceRoot) {
  if (!workspaceRoot) {
    return [];
  }
  const boardPath = path.join(workspaceRoot, 'docs', 'BAT_FEATURE_BOARD.md');
  if (!fs.existsSync(boardPath)) {
    return [];
  }

  const lines = fs.readFileSync(boardPath, 'utf8').split(/\r?\n/);
  const out = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(BAT_BOARD_ITEM_RE);
    if (!match) {
      continue;
    }
    const ticket = match[1];
    if (out.some((item) => item.ticket === ticket)) {
      continue;
    }
    const desc = match[2].trim();
    const tags = Array.from(desc.matchAll(/\[([^\]]+)\]/g)).map((entry) => String(entry[1]).toUpperCase());
    // extract structured fields from tags
    let risk = null;
    const deps = [];
    tags.forEach((t) => {
      if (t.startsWith('RISK:')) {
        risk = t.split(':')[1].toLowerCase();
      }
      if (t.startsWith('DEP:')) {
        deps.push(t.split(':')[1]);
      }
    });
    out.push({
      ticket,
      desc,
      summary: desc.replace(/\[[^\]]+\]/g, '').trim(),
      tags,
      status: extractBatStatus(tags),
      risk,
      deps,
      lineNumber: index + 1,
    });
  }

  return out;
}

function summarizeBats(items) {
  const summary = {
    total: 0,
    todo: 0,
    done: 0,
    tested: 0,
  };

  for (const item of items || []) {
    summary.total += 1;
    const status = String(item.status || '');
    if (status.includes('TODO')) {
      summary.todo += 1;
    }
    if (status.includes('DONE')) {
      summary.done += 1;
    }
    if ((item.tags || []).includes('TESTED')) {
      summary.tested += 1;
    }
  }

  return summary;
}

function parseAssistantRuns(workspaceRoot, { limit = 30 } = {}) {
  if (!workspaceRoot) {
    return [];
  }
  const runsDir = getBoardAssistantRunsDir(workspaceRoot);
  if (!fs.existsSync(runsDir)) {
    return [];
  }

  const files = fs
    .readdirSync(runsDir)
    .filter((name) => name.endsWith('.json'))
    .filter((name) => name.includes('_run') || name.includes('_implement'));

  const boardStatusByTicket = new Map(parseBatBoard(workspaceRoot).map((item) => [String(item.ticket), String(item.status || '')]));

  const runs = [];
  for (const name of files) {
    const fullPath = path.join(runsDir, name);
    try {
      const payload = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const ticketFromName = name.match(/BAT(\d+)_/)?.[1] || '';
      const ticket = String(payload.ticket || ticketFromName || '');
      const command = payload.command || (name.includes('_implement') ? 'implement' : 'run');
      const pass = payload.all_checks_passed !== false;
      const createdCount = Array.isArray(payload.created_files) ? payload.created_files.length : 0;
      const checkCount = Array.isArray(payload.checks) ? payload.checks.length : 0;
      const generatedAt = payload.generated_at || new Date(fs.statSync(fullPath).mtimeMs).toISOString();
      const boardStatus = boardStatusByTicket.get(ticket) || '';
      const patchInsights = normalizePatchInsights(workspaceRoot, payload.results);
      const reviewSummary = normalizeReviewSummary(payload.review_summary || payload.reviewSummary);
      const approvalRequests = normalizeApprovalRequests(payload.pending_approvals || payload.approvalRequests);
      const runtimeContext = normalizeRuntimeContext(workspaceRoot, payload.runtime_context || payload.runtimeContext);
      const explicitState = String(payload.state || '').toLowerCase();
      runs.push({
        ticket,
        command,
        pass,
        state: explicitState || (pass ? 'pass' : 'fail'),
        createdCount,
        checkCount,
        generatedAt,
        profile: payload.profile || 'n/a',
        path: fullPath,
        boardStatus,
        runId: [ticket, command, generatedAt].filter(Boolean).join('::'),
        patchInsights,
        patchInsightCount: patchInsights.length,
        reviewSummary,
        approvalRequests,
        runtimeContext,
        blockedReason: String(payload.blocked_reason || payload.blockedReason || ''),
        validationFingerprints: normalizeValidationFingerprints(payload.validation_fingerprints || payload.validationFingerprints),
        retryPolicy: normalizeRetryPolicy(payload.retry_policy || payload.retryPolicy),
        engineDecisions: normalizeEngineDecisions(payload.engine_decisions || payload.engineDecisions),
        engineMetrics: normalizeEngineMetrics(payload.engine_metrics || payload.engineMetrics),
        ownerSummary: normalizeLooseObject(payload.owner_summary || payload.ownerSummary),
        runSummary: normalizeLooseObject(payload.run_summary || payload.runSummary),
        testSummary: normalizeLooseObject(payload.test_summary || payload.testSummary),
        reviewQueueSummary: normalizeLooseObject(payload.review_queue_summary || payload.reviewQueueSummary),
        trustSummary: normalizeLooseObject(payload.trust_summary || payload.trustSummary),
        trustSignalCount: Number(payload.trust_signal_count ?? payload.trustSignalCount ?? 0),
        trustStateCounts: normalizeLooseObject(payload.trust_state_counts || payload.trustStateCounts),
        recommendedActions: normalizeLooseList(payload.recommended_actions || payload.recommendedActions),
        experimentBenchmarkSummary: normalizeLooseObject(payload.experiment_benchmark_summary || payload.experimentBenchmarkSummary),
        ownerExperimentSummary: normalizeLooseObject(payload.owner_experiment_summary || payload.ownerExperimentSummary),
        trainingHandoff: normalizeLooseObject(payload.training_handoff || payload.trainingHandoff),
        queueSummary: normalizeLooseObject(payload.queue_summary || payload.queueSummary),
        historySummary: normalizeLooseObject(payload.history_summary || payload.historySummary),
        recommendation: normalizeLooseObject(payload.recommendation),
        projectProfile: normalizeLooseObject(payload.project_profile || payload.projectProfile),
        projectHealthSummary: normalizeLooseObject(payload.health_summary || payload.healthSummary || payload.project_health_summary || payload.projectHealthSummary),
        projectMaintenanceSummary: normalizeLooseObject(payload.project_maintenance_summary || payload.projectMaintenanceSummary),
        ownerGoals: normalizeLooseList(payload.owner_goals || payload.ownerGoals),
        ownerGoalPlan: normalizeLooseObject(payload.owner_goal_plan || payload.ownerGoalPlan),
      });
    } catch (_err) {
      // ignore malformed files
    }
  }

  runs.sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
  const out = [];
  const seen = new Set();
  for (const run of runs) {
    if (run.ticket && run.boardStatus.includes('DONE')) {
      continue;
    }
    const dedupeKey = run.ticket ? `${run.ticket}:${run.command}` : `${run.path}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    out.push(run);
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

function collectRuntimeApprovalSignals(runs) {
  const seen = new Set();
  const out = [];

  const addItem = (pathValue, source, context = {}) => {
    const normalizedPath = String(pathValue || '').trim().replace(/\\/g, '/');
    if (!normalizedPath || seen.has(normalizedPath)) {
      return;
    }
    seen.add(normalizedPath);
    out.push({
      path: normalizedPath,
      source,
      line: Number(context.line || 1),
      detail: String(context.detail || ''),
      ticket: String(context.ticket || ''),
      runId: String(context.runId || ''),
    });
  };

  for (const run of Array.isArray(runs) ? runs : []) {
    for (const request of Array.isArray(run?.approvalRequests) ? run.approvalRequests : []) {
      addItem(request.path, 'runtime-approval', {
        detail: request.reason || request.tool || 'approval required',
        ticket: run.ticket,
        runId: run.runId,
      });
    }

    for (const insight of Array.isArray(run?.patchInsights) ? run.patchInsights : []) {
      if (Number(insight.selectedScore || 0) >= 55) {
        continue;
      }
      addItem(insight.path, 'patch-review', {
        detail: insight.selectedLabel || 'low-confidence patch selection',
        ticket: run.ticket,
        runId: run.runId,
      });
    }

    const reviewSummary = run?.reviewSummary && typeof run.reviewSummary === 'object' ? run.reviewSummary : {};
    if (reviewSummary.requiresManualReview) {
      const fallbackPaths = [];
      if (reviewSummary.activeFilePath) {
        fallbackPaths.push(reviewSummary.activeFilePath);
      }
      if (Array.isArray(reviewSummary.reviewedPaths)) {
        fallbackPaths.push(...reviewSummary.reviewedPaths);
      }
      for (const reviewPath of fallbackPaths) {
        addItem(reviewPath, 'review-summary', {
          detail: reviewSummary.summary || 'manual review requested',
          ticket: run.ticket,
          runId: run.runId,
        });
      }
    }
  }

  return out;
}

function collectProtectedBatReviewSignals(workspaceRoot, bats) {
  return (Array.isArray(bats) ? bats : [])
    .filter((item) => String(item?.status || '').includes('TODO') && String(item?.safeBlockedReason || '').trim())
    .map((item) => ({
      path: 'docs/BAT_FEATURE_BOARD.md',
      source: 'protected-bat',
      line: Number(item?.lineNumber || 1),
      detail: String(item?.safeBlockedReason || ''),
      ticket: String(item?.ticket || ''),
      protectedWhy: String(item?.safeBlockedReason || ''),
      nextAction: 'Review and approve the protected BAT or edit it manually.',
      workspaceRoot,
    }));
}

function parseFollowupBatReport(workspaceRoot) {
  if (!workspaceRoot) {
    return null;
  }
  const payload = readJson(path.join(getBoardAssistantRunsDir(workspaceRoot), 'assistant_followup_bats.json'));
  if (!payload) {
    return null;
  }
  const inserted = Array.isArray(payload.inserted)
    ? payload.inserted.map((item) => ({
        ticket: String(item.ticket || ''),
        line: String(item.line || ''),
        summary: String(item.summary || item.line || ''),
        occurrences: Number(item.occurrences || 0),
        signature: String(item.signature || ''),
        sourceTickets: Array.isArray(item.source_tickets) ? item.source_tickets.map((entry) => String(entry)) : [],
      }))
    : [];
  return {
    ok: payload.ok !== false,
    generatedAt: String(payload.generated_at || ''),
    inserted,
    candidateCount: Number(payload.candidate_count || 0),
    scannedArtifacts: Number(payload.scanned_artifacts || 0),
    minOccurrences: Number(payload.min_occurrences || 0),
    maxNewBats: Number(payload.max_new_bats || 0),
  };
}

function parseLatestSprintSummary(workspaceRoot) {
  if (!workspaceRoot) {
    return null;
  }
  const latest = pickLatestJson(workspaceRoot, /^sprint_(?:implement|run|plan)_.*\.json$/i);
  if (!latest?.payload) {
    return null;
  }
  const payload = latest.payload;
  const outcomes = Array.isArray(payload.outcomes)
    ? payload.outcomes.map((item) => ({
        ticket: String(item.ticket || item.objective_id || ''),
        action: String(item.action || payload.action || 'run'),
        exitCode: Number(item.exit_code || 0),
        allChecksPassed: item.all_checks_passed !== false,
        artifactPath: toRelativeWorkspacePath(workspaceRoot, item.artifact || ''),
        generatedAt: String(item.generated_at || payload.generated_at || ''),
        synthetic: item.synthetic === true,
      }))
    : [];
  const failureOutcome = outcomes.find((item) => item.allChecksPassed === false || item.exitCode !== 0) || null;
  const blockedSkips = Array.isArray(payload.blocked_skips) ? payload.blocked_skips.map((item) => String(item)) : [];
  const noMatchReason = String(payload.no_match_reason || '').trim();
  let status = 'pass';
  if (failureOutcome) {
    status = 'fail';
  } else if (!outcomes.length && noMatchReason) {
    status = 'skipped';
  } else if (blockedSkips.length && !outcomes.length) {
    status = 'skipped';
  } else if (!outcomes.length) {
    status = 'idle';
  }
  return {
    action: String(payload.action || 'run'),
    status,
    sourcePath: toRelativeWorkspacePath(workspaceRoot, latest.fullPath),
    generatedAt: String(payload.generated_at || latest.stamp || ''),
    countRequested: Number(payload.count_requested || 0),
    statusFilter: String(payload.status_filter || ''),
    tagFilter: payload.require_tag || null,
    textFilter: payload.require_text || null,
    preferDomain: payload.prefer_domain || null,
    profile: String(payload.profile || 'n/a'),
    noMatchReason,
    blockedSkips,
    outcomes,
    failure: failureOutcome ? summarizeFailure(workspaceRoot, failureOutcome, payload) : null,
  };
}

function countNonEmptyLines(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return 0;
  }
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter((line) => String(line || '').trim()).length;
  } catch (_err) {
    return 0;
  }
}

function getTrainingOutputPath(workspaceRoot) {
  if (typeof assistantPaths.getAssistantTrainingOutputPath === 'function') {
    return assistantPaths.getAssistantTrainingOutputPath(workspaceRoot);
  }
  return path.join(workspaceRoot, 'backend', 'scripts', 'dev_assistant_training.jsonl');
}

function parseAssistantAnalyzeSummary(workspaceRoot) {
  if (!workspaceRoot) {
    return {
      exists: false,
      generatedAt: '',
      entryCount: 0,
      ticketCount: 0,
      reportPath: '',
      logPath: '',
      state: 'idle',
    };
  }
  const status = readJson(path.join(getBoardAssistantRunsDir(workspaceRoot), 'assistant_analyze_status.json')) || {};
  const reportPath = status.report_path || status.reportPath || path.join(workspaceRoot, 'docs', 'DEV_ASSISTANT_LOG_REPORT.md');
  const resolvedReportPath = resolveWorkspacePath(workspaceRoot, reportPath);
  const exists = !!(resolvedReportPath && fs.existsSync(resolvedReportPath));
  let generatedAt = String(status.generated_at || status.generatedAt || '');
  if (!generatedAt && exists) {
    try {
      generatedAt = new Date(fs.statSync(resolvedReportPath).mtimeMs).toISOString();
    } catch (_err) {
      generatedAt = '';
    }
  }
  return {
    exists,
    generatedAt,
    entryCount: Number(status.entry_count || status.entryCount || 0),
    ticketCount: Number(status.ticket_count || status.ticketCount || 0),
    reportPath: toRelativeWorkspacePath(workspaceRoot, resolvedReportPath),
    logPath: toRelativeWorkspacePath(workspaceRoot, status.log_path || status.logPath || ''),
    state: exists || generatedAt ? 'ready' : 'idle',
  };
}

function parseAssistantTrainingSummary(workspaceRoot, dashboard = {}) {
  if (!workspaceRoot) {
    return {
      exists: false,
      outputPath: '',
      generatedAt: '',
      exampleCount: 0,
      pendingRunsCount: 0,
      stale: false,
      staleAfterHours: 24,
      ageHours: null,
      qualityGate: {},
      fineTuneRequested: false,
      fineTuneModel: '',
      localExport: {},
      state: 'idle',
    };
  }
  const rawTraining = dashboard.training && typeof dashboard.training === 'object' ? dashboard.training : {};
  const status = readJson(path.join(getBoardAssistantRunsDir(workspaceRoot), 'assistant_training_status.json')) || {};
  const outputPath = getTrainingOutputPath(workspaceRoot);
  const exists = !!(outputPath && fs.existsSync(outputPath));
  const staleAfterHours = Math.max(1, Number(rawTraining.stale_after_hours || rawTraining.staleAfterHours || 24));
  let generatedAt = String(status.generated_at || status.generatedAt || rawTraining.generated_at || rawTraining.generatedAt || '');
  if (!generatedAt && exists) {
    try {
      generatedAt = new Date(fs.statSync(outputPath).mtimeMs).toISOString();
    } catch (_err) {
      generatedAt = '';
    }
  }
  let exampleCount = Number(status.example_count || status.exampleCount || rawTraining.example_count || rawTraining.exampleCount || 0);
  if (exists && exampleCount <= 0) {
    exampleCount = countNonEmptyLines(outputPath);
  }
  const qualityGate = status.quality_gate && typeof status.quality_gate === 'object'
    ? status.quality_gate
    : (status.qualityGate && typeof status.qualityGate === 'object' ? status.qualityGate : {});
  const generatedAtMs = Date.parse(generatedAt || '');
  const recentTickets = Array.isArray(dashboard.recent_tickets) ? dashboard.recent_tickets : [];
  const pendingRunsCount = Number(
    status.pending_runs_count
      || status.pendingRunsCount
      || rawTraining.pending_runs_count
      || rawTraining.pendingRunsCount
      || (Number.isFinite(generatedAtMs)
        ? recentTickets.filter((item) => Date.parse(String(item?.generated_at || item?.generatedAt || '')) > generatedAtMs).length
        : 0)
  );
  const ageHours = Number.isFinite(generatedAtMs)
    ? Math.max(0, Math.round(((Date.now() - generatedAtMs) / 3600000) * 10) / 10)
    : null;
  const stale = ageHours !== null && ageHours >= staleAfterHours;
  let state = 'idle';
  if (qualityGate.passed === false) {
    state = String(qualityGate.state || 'warn');
  } else if (exists && exampleCount > 0) {
    state = stale || pendingRunsCount > 0 ? 'warn' : 'ready';
  } else if (exists) {
    state = 'warn';
  }
  const localExportRaw = status.local_export && typeof status.local_export === 'object'
    ? status.local_export
    : (status.localExport && typeof status.localExport === 'object' ? status.localExport : {});
  const localExport = {
    requested: localExportRaw.requested === true,
    ready: localExportRaw.ready === true,
    format: String(localExportRaw.format || ''),
    provider: String(localExportRaw.provider || ''),
    baseModel: String(localExportRaw.base_model || localExportRaw.baseModel || ''),
    bundleDir: toRelativeWorkspacePath(workspaceRoot, localExportRaw.bundle_dir || localExportRaw.bundleDir || ''),
    messagesPath: toRelativeWorkspacePath(workspaceRoot, localExportRaw.messages_path || localExportRaw.messagesPath || ''),
    manifestPath: toRelativeWorkspacePath(workspaceRoot, localExportRaw.manifest_path || localExportRaw.manifestPath || ''),
    modelfilePath: toRelativeWorkspacePath(workspaceRoot, localExportRaw.modelfile_path || localExportRaw.modelfilePath || ''),
    readmePath: toRelativeWorkspacePath(workspaceRoot, localExportRaw.readme_path || localExportRaw.readmePath || ''),
    exampleCount: Number(localExportRaw.example_count || localExportRaw.exampleCount || 0),
  };
  return {
    exists,
    outputPath: toRelativeWorkspacePath(workspaceRoot, outputPath),
    generatedAt,
    exampleCount,
    pendingRunsCount,
    stale,
    staleAfterHours,
    ageHours,
    qualityGate,
    fineTuneRequested: status.fine_tune_requested === true || status.fineTuneRequested === true,
    fineTuneModel: String(status.fine_tune_model || status.fineTuneModel || ''),
    localExport,
    state,
  };
}

function parseAssistantClosedLoopSummary(workspaceRoot, dashboard = {}, trainingSummary = null) {
  const analyze = parseAssistantAnalyzeSummary(workspaceRoot);
  const training = trainingSummary || parseAssistantTrainingSummary(workspaceRoot, dashboard);
  const recentTickets = Array.isArray(dashboard.recent_tickets) ? dashboard.recent_tickets : [];
  const lastRunAt = String(recentTickets[0]?.generated_at || recentTickets[0]?.generatedAt || '');
  const lastRunMs = Date.parse(lastRunAt || '');
  const analyzeMs = Date.parse(String(analyze.generatedAt || ''));
  const trainMs = Date.parse(String(training.generatedAt || ''));
  const qualityGate = training.qualityGate && typeof training.qualityGate === 'object' ? training.qualityGate : {};

  let state = 'idle';
  let stage = 'idle';
  let summary = 'No closed-loop cycle has run yet.';
  if (lastRunAt) {
    state = 'warn';
    stage = 'run-complete';
    summary = 'Recent assistant work is waiting for learning refresh.';
    if (!analyze.generatedAt || (Number.isFinite(lastRunMs) && (!Number.isFinite(analyzeMs) || analyzeMs < lastRunMs))) {
      stage = 'analyze-due';
      summary = 'Recent assistant work is waiting for log analysis.';
    } else if (!training.generatedAt || (Number.isFinite(analyzeMs) && (!Number.isFinite(trainMs) || trainMs < analyzeMs)) || Number(training.pendingRunsCount || 0) > 0) {
      stage = 'train-due';
      summary = Number(training.pendingRunsCount || 0) > 0
        ? `${Number(training.pendingRunsCount || 0)} run(s) landed after the last training export.`
        : 'Training export needs a fresh closed-loop pass.';
    } else if (qualityGate.passed === false) {
      stage = 'quality-gate';
      state = String(qualityGate.state || 'warn');
      summary = String(qualityGate.summary || 'Training quality gate is blocking the closed loop.');
    } else {
      stage = 'ready';
      state = 'ready';
      summary = 'Latest run, analysis, and training export are aligned.';
    }
  } else if (training.exists) {
    stage = qualityGate.passed === false ? 'quality-gate' : 'ready';
    state = qualityGate.passed === false ? String(qualityGate.state || 'warn') : training.state;
    summary = qualityGate.passed === false
      ? String(qualityGate.summary || 'Training quality gate is blocking the closed loop.')
      : 'Training dataset is available.';
  }

  return {
    state,
    stage,
    summary,
    lastRunAt,
    lastAnalyzeAt: analyze.generatedAt,
    lastTrainAt: training.generatedAt,
    analyze,
    qualityGate,
  };
}

function roundMetric(value, digits = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
}

function normalizeRatePercent(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return roundMetric(fallback, 1);
  }
  if (numeric >= 0 && numeric <= 1) {
    return roundMetric(numeric * 100, 1);
  }
  return roundMetric(numeric, 1);
}

function normalizeCountRows(value, key = 'label') {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => ({
      label: String(item?.[key] || item?.label || ''),
      count: Number(item?.count || 0),
    }))
    .filter((item) => item.label);
}

function summarizeCountRows(rows, prefix = '', limit = 2) {
  return (Array.isArray(rows) ? rows : [])
    .slice(0, limit)
    .map((item) => `${prefix}${item.label}×${Number(item.count || 0)}`)
    .join(' • ');
}

function normalizeActionRows(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => ({
      label: String(item?.label || item?.action || ''),
      count: Number(item?.count || 0),
    }))
    .filter((item) => item.label);
}

function normalizeStringList(value, limit = 4) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, limit);
}

function parseEngineBaselineSummary(workspaceRoot, dashboard = {}) {
  if (!workspaceRoot) {
    return null;
  }
  const runsDir = getBoardAssistantRunsDir(workspaceRoot);
  const jsonPath = path.join(runsDir, 'engine_baseline_summary.json');
  const markdownPath = path.join(runsDir, 'engine_baseline_summary.md');
  const canonicalMarkdownPath = path.join(workspaceRoot, 'docs', 'ENGINE_BASELINE.md');
  const payload = readJson(jsonPath);
  const baseline = payload?.baseline && typeof payload.baseline === 'object' ? payload.baseline : {};
  const runtime = payload?.runtime && typeof payload.runtime === 'object' ? payload.runtime : {};
  const experiments = payload?.experiments && typeof payload.experiments === 'object' ? payload.experiments : {};
  const runsAnalyzed = Number(runtime.run_count || dashboard.recent_count || 0);
  const successRate = normalizeRatePercent(runtime.success_rate, Number(dashboard.pass_rate || 0));
  const blockedRate = runsAnalyzed > 0
    ? roundMetric((Number(dashboard.blocked_count || 0) / runsAnalyzed) * 100, 1)
    : (baseline.blocked ? 100 : 0);
  const reviewRequiredRate = normalizeRatePercent(
    experiments.review_required_rate,
    normalizeRatePercent(runtime.review_request_rate, 0),
  );
  const averageRepairAttempts = roundMetric(runtime.average_repair_attempts_per_run || 0, 2);
  const topIssues = normalizeCountRows(payload?.common_failure_fingerprints);
  const recommendedActions = normalizeActionRows(payload?.common_recommended_actions);
  const generatedAt = String(payload?.generated_at || '');
  const exists = !!payload || fs.existsSync(canonicalMarkdownPath) || fs.existsSync(markdownPath);
  return {
    exists,
    generatedAt,
    baselineState: String(baseline.state || 'unknown'),
    blocked: baseline.blocked === true,
    runsAnalyzed,
    successRate,
    blockedRate,
    reviewRequiredRate,
    averageRepairAttempts,
    topIssues,
    recommendedActions,
    topIssuesText: summarizeCountRows(topIssues),
    recommendedActionsText: summarizeCountRows(recommendedActions),
    summary: runsAnalyzed > 0
      ? `${runsAnalyzed} runs • ${successRate}% success • ${blockedRate}% blocked • ${reviewRequiredRate}% review required • avg repairs ${averageRepairAttempts}`
      : 'No engine baseline summary yet.',
    jsonPath: toRelativeWorkspacePath(workspaceRoot, jsonPath),
    markdownPath: toRelativeWorkspacePath(workspaceRoot, markdownPath),
    canonicalMarkdownPath: toRelativeWorkspacePath(workspaceRoot, canonicalMarkdownPath),
  };
}

function parseEngineDailyReport(workspaceRoot, dashboard = {}) {
  if (!workspaceRoot) {
    return null;
  }
  const runsDir = getBoardAssistantRunsDir(workspaceRoot);
  const jsonPath = path.join(runsDir, 'engine_daily_report.json');
  const markdownPath = path.join(runsDir, 'engine_daily_report.md');
  const canonicalMarkdownPath = path.join(workspaceRoot, 'docs', 'ENGINE_DAILY_REPORT.md');
  const payload = readJson(jsonPath);
  const baseline = payload?.baseline && typeof payload.baseline === 'object' ? payload.baseline : {};
  const runtime = payload?.runtime && typeof payload.runtime === 'object' ? payload.runtime : {};
  const experiments = payload?.experiments && typeof payload.experiments === 'object' ? payload.experiments : {};
  const dailyFocus = payload?.daily_focus && typeof payload.daily_focus === 'object'
    ? payload.daily_focus
    : (payload?.dailyFocus && typeof payload.dailyFocus === 'object' ? payload.dailyFocus : {});
  const runsAnalyzed = Number(runtime.run_count || dashboard.recent_count || 0);
  const successRate = normalizeRatePercent(runtime.success_rate, Number(dashboard.pass_rate || 0));
  const blockedRate = runsAnalyzed > 0
    ? roundMetric((Number(dashboard.blocked_count || 0) / runsAnalyzed) * 100, 1)
    : (baseline.blocked ? 100 : 0);
  const reviewRequiredRate = normalizeRatePercent(
    experiments.review_required_rate,
    normalizeRatePercent(runtime.review_request_rate, 0),
  );
  const averageRepairAttempts = roundMetric(
    experiments.average_repair_count ?? runtime.average_repair_attempts_per_run ?? 0,
    2,
  );
  const topIssues = normalizeCountRows(payload?.top_blockers);
  const recommendedActions = normalizeActionRows(payload?.common_recommended_actions);
  const highlights = normalizeStringList(dailyFocus.operator_actions || dailyFocus.operatorActions);
  const suggestedWorkstream = String(dailyFocus.suggested_workstream || dailyFocus.suggestedWorkstream || '');
  const recommendedFocus = String(
    dailyFocus.reason
      || experiments.recommended_next_action
      || experiments.recommendedNextAction
      || recommendedActions[0]?.label
      || ''
  );
  const exists = !!payload || fs.existsSync(canonicalMarkdownPath) || fs.existsSync(markdownPath);
  return {
    exists,
    generatedAt: String(payload?.generated_at || ''),
    suggestedWorkstream,
    recommendedFocus,
    highlights,
    runsAnalyzed,
    successRate,
    blockedRate,
    reviewRequiredRate,
    averageRepairAttempts,
    topIssues,
    recommendedActions,
    topIssuesText: summarizeCountRows(topIssues),
    recommendedActionsText: summarizeCountRows(recommendedActions),
    summary: runsAnalyzed > 0
      ? `${suggestedWorkstream || 'Daily review'} • ${runsAnalyzed} runs • ${successRate}% success • ${reviewRequiredRate}% review required • avg repairs ${averageRepairAttempts}`
      : 'No daily engine report yet.',
    jsonPath: toRelativeWorkspacePath(workspaceRoot, jsonPath),
    markdownPath: toRelativeWorkspacePath(workspaceRoot, markdownPath),
    canonicalMarkdownPath: toRelativeWorkspacePath(workspaceRoot, canonicalMarkdownPath),
  };
}

function parseAssistantDashboard(workspaceRoot) {
  if (!workspaceRoot) {
    return null;
  }
  const dashboard = readJson(path.join(getBoardAssistantRunsDir(workspaceRoot), 'assistant_dashboard.json')) || {};
  const training = parseAssistantTrainingSummary(workspaceRoot, dashboard);
  const engineBaselineSummary = parseEngineBaselineSummary(workspaceRoot, dashboard);
  const engineDailyReport = parseEngineDailyReport(workspaceRoot, dashboard);
  return {
    ...dashboard,
    analyze: parseAssistantAnalyzeSummary(workspaceRoot),
    training,
    closedLoop: parseAssistantClosedLoopSummary(workspaceRoot, dashboard, training),
    engineBaselineSummary,
    engineDailyReport,
  };
}

module.exports = {
  collectProtectedBatReviewSignals,
  collectRuntimeApprovalSignals,
  normalizeRuntimeContext,
  summarizeRunDetail,
  summarizeWorkspaceTopology,
  parseBatBoard,
  summarizeBats,
  parseAssistantRuns,
  parseFollowupBatReport,
  parseLatestSprintSummary,
  parseAssistantDashboard,
};
