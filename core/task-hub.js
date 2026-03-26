'use strict';

const fs = require('fs');
const path = require('path');

const { getAssistantRunsDir, getAssistantRuntimeStatePath } = require('./assistant-paths');
const { parseBatBoard } = require('./board');
const { deriveWorkspaceStyleProfile, improveTitleWithStyleProfile } = require('./style-profile');

const TASK_HUB_SCHEMA_VERSION = '2026-03-15';
const TASK_HUB_FILE = 'task-hub.json';
const ENGINE_BAT_GOAL_PREFIX = 'goal_engine_bat_backlog';
const ENGINE_BAT_TASK_PREFIX = 'task_engine_bat';

const DEFAULT_RECIPES = Object.freeze([
  {
    id: 'self-host',
    label: 'Self-host',
    kind: 'lab',
    summary: 'Clone the desktop-agent repo into a persistent lab and let the agent work on itself safely.',
    target: 'self-host-lab',
  },
  {
    id: 'workspace-mirror',
    label: 'Workspace mirror',
    kind: 'lab',
    summary: 'Create a clean mirror of the current workspace before testing a risky change.',
    target: 'workspace-lab',
  },
  {
    id: 'break-node-test',
    label: 'Break/fix benchmark',
    kind: 'lab',
    summary: 'Inject a known failure into a lab so the repair loop can be benchmarked safely.',
    target: 'scratch-lab',
  },
  {
    id: 'dummy-node-app',
    label: 'Dummy app lab',
    kind: 'lab',
    summary: 'Generate a clean Node test project so planning, coding, and review lanes can be benchmarked on a simple target.',
    target: 'scratch-lab',
  },
  {
    id: 'dummy-broken-node-app',
    label: 'Broken dummy lab',
    kind: 'lab',
    summary: 'Generate an intentionally broken Node test project so repair loops can be tuned without touching a real repo.',
    target: 'scratch-lab',
  },
  {
    id: 'benchmark-self-host',
    label: 'Self-host benchmark',
    kind: 'benchmark',
    summary: 'Create a scratch self-host clone for routing, repair, and benchmark comparisons against the desktop agent itself.',
    target: 'self-host-lab',
  },
  {
    id: 'docs-scout',
    label: 'Docs scout trial',
    kind: 'trial',
    summary: 'Try a documentation-led change in a lab, then compare the diff and benchmark results before promoting it.',
    target: 'lab-only',
  },
  {
    id: 'engine-benchmark',
    label: 'Engine benchmark',
    kind: 'benchmark',
    summary: 'Run a focused coding benchmark and record latency, pass rate, and repair depth for routing decisions.',
    target: 'workspace-or-lab',
  },
]);

function nowIso() {
  return new Date().toISOString();
}

function parseIsoTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return 0;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function padDatePart(value) {
  return String(Math.max(0, Number(value || 0))).padStart(2, '0');
}

function localDayKey(value) {
  const stamp = value instanceof Date ? value.getTime() : parseIsoTimestamp(value) || Number(value || 0) || Date.now();
  const moment = new Date(stamp);
  return `${moment.getFullYear()}-${padDatePart(moment.getMonth() + 1)}-${padDatePart(moment.getDate())}`;
}

function slugify(value, fallback = 'item') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function clipText(value, maxLength = 240) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}…` : text;
}

function normalizeList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizeWorkspacePath(value) {
  return String(value || '').trim().replace(/\\/g, '/').toLowerCase();
}

function normalizeWorkspaceScope(options = {}) {
  return {
    roots: Array.from(new Set([
      options.workspaceRoot,
      options.targetWorkspaceRoot,
      options.labRoot,
    ].map((item) => normalizeWorkspacePath(item)).filter(Boolean))),
  };
}

function collectEntityWorkspaceRoots(entity = {}) {
  const metadata = entity?.metadata && typeof entity.metadata === 'object' ? entity.metadata : {};
  return Array.from(new Set([
    entity?.workspaceRoot,
    entity?.targetWorkspaceRoot,
    entity?.projectRoot,
    entity?.sourceRoot,
    entity?.labRoot,
    metadata?.workspaceRoot,
    metadata?.targetWorkspaceRoot,
    metadata?.projectRoot,
    metadata?.sourceRoot,
    metadata?.labRoot,
    metadata?.workspaceScopeRoot,
    metadata?.workspace_scope_root,
  ].map((item) => normalizeWorkspacePath(item)).filter(Boolean)));
}

function collectPreferredEntityWorkspaceRoots(entity = {}) {
  const metadata = entity?.metadata && typeof entity.metadata === 'object' ? entity.metadata : {};
  return Array.from(new Set([
    entity?.targetWorkspaceRoot,
    entity?.projectRoot,
    entity?.sourceRoot,
    entity?.labRoot,
    metadata?.targetWorkspaceRoot,
    metadata?.projectRoot,
    metadata?.sourceRoot,
    metadata?.labRoot,
    metadata?.workspaceScopeRoot,
    metadata?.workspace_scope_root,
  ].map((item) => normalizeWorkspacePath(item)).filter(Boolean)));
}

function entityMatchesWorkspaceScope(entity = {}, scope = {}) {
  if (!Array.isArray(scope?.roots) || scope.roots.length === 0) {
    return true;
  }
  const entityRoots = collectPreferredEntityWorkspaceRoots(entity);
  if (entityRoots.length > 0) {
    return entityRoots.some((item) => scope.roots.includes(item));
  }
  const fallbackRoots = collectEntityWorkspaceRoots(entity);
  if (fallbackRoots.length === 0) {
    return false;
  }
  return fallbackRoots.some((item) => scope.roots.includes(item));
}

function ensureHubDir(workspaceRoot) {
  const runsDir = getAssistantRunsDir(workspaceRoot);
  fs.mkdirSync(runsDir, { recursive: true });
  return runsDir;
}

function hubPath(workspaceRoot) {
  return path.join(ensureHubDir(workspaceRoot), TASK_HUB_FILE);
}

function scopedDefaultRecipes(workspaceRoot = '') {
  const scopedRoot = String(workspaceRoot || '').trim();
  return DEFAULT_RECIPES.map((recipe) => ({
    ...recipe,
    workspaceRoot: scopedRoot,
    targetWorkspaceRoot: scopedRoot,
    metadata: {
      workspaceScopeRoot: scopedRoot,
    },
  }));
}

function emptyHub(workspaceRoot = '') {
  return {
    schemaVersion: TASK_HUB_SCHEMA_VERSION,
    updatedAt: nowIso(),
    goals: [],
    tasks: [],
    recipes: scopedDefaultRecipes(workspaceRoot),
    runs: [],
    runLinks: [],
  };
}

function readHub(workspaceRoot) {
  if (!workspaceRoot) {
    return emptyHub();
  }
  const filePath = hubPath(workspaceRoot);
  if (!fs.existsSync(filePath)) {
    return emptyHub(workspaceRoot);
  }
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      ...emptyHub(workspaceRoot),
      ...(payload && typeof payload === 'object' ? payload : {}),
      goals: Array.isArray(payload?.goals) ? payload.goals : [],
      tasks: Array.isArray(payload?.tasks) ? payload.tasks : [],
      recipes: Array.isArray(payload?.recipes) && payload.recipes.length > 0
        ? payload.recipes
        : scopedDefaultRecipes(workspaceRoot),
      runs: Array.isArray(payload?.runs) ? payload.runs : (Array.isArray(payload?.runLinks) ? payload.runLinks : []),
      runLinks: Array.isArray(payload?.runLinks) ? payload.runLinks : [],
    };
  } catch (_error) {
    return emptyHub(workspaceRoot);
  }
}

function writeHub(workspaceRoot, payload) {
  const filePath = hubPath(workspaceRoot);
  const nextPayload = {
    schemaVersion: TASK_HUB_SCHEMA_VERSION,
    updatedAt: nowIso(),
    goals: Array.isArray(payload?.goals) ? payload.goals : [],
    tasks: Array.isArray(payload?.tasks) ? payload.tasks : [],
    runLinks: Array.isArray(payload?.runLinks) ? payload.runLinks : [],
  };
  fs.writeFileSync(filePath, `${JSON.stringify(nextPayload, null, 2)}\n`, 'utf8');
  return nextPayload;
}

function isClosedTaskStatus(status = '') {
  return ['completed', 'cancelled', 'done', 'archived'].includes(String(status || '').trim().toLowerCase());
}

function isDailyFocusEntity(item = {}) {
  const metadata = item?.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  const signature = String(metadata.followupSignature || '').trim().toLowerCase();
  return metadata.dailyTask === true
    || signature.startsWith('daily-task:');
}

function taskUpdateTimestamp(task = {}) {
  return Math.max(
    parseIsoTimestamp(task?.updatedAt),
    parseIsoTimestamp(task?.createdAt),
  );
}

function isTaskUpdatedOnRoadmapDay(task = {}, roadmapDay = '') {
  const targetDay = String(roadmapDay || '').trim();
  if (!targetDay) {
    return false;
  }
  const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  const metadataDay = String(metadata.roadmapDay || '').trim();
  if (metadataDay) {
    return metadataDay === targetDay;
  }
  const updatedAt = taskUpdateTimestamp(task);
  if (!updatedAt) {
    return false;
  }
  return localDayKey(updatedAt) === targetDay;
}

function isBlockedOrRescopedTask(task = {}) {
  const status = String(task?.status || '').trim().toLowerCase();
  const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  return status === 'needs-rescope'
    || status === 'blocked'
    || !!String(metadata.lastBlockedBy || '').trim()
    || !!String(metadata.lastBlockedReason || '').trim();
}

function findOpenTaskByFollowupSignature(hub = {}, signature = '') {
  const normalized = String(signature || '').trim();
  if (!normalized || !Array.isArray(hub.tasks)) {
    return null;
  }
  return hub.tasks.find((task) => {
    const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : {};
    return String(metadata.followupSignature || '').trim() === normalized
      && !isClosedTaskStatus(task?.status);
  }) || null;
}

function findTaskByFollowupSignature(workspaceRoot, signature = '') {
  const hub = readHub(workspaceRoot);
  return findOpenTaskByFollowupSignature(hub, signature);
}

function isSelfHostExpansionTask(task = {}) {
  const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  return metadata.selfHostExpansion === true;
}

function deriveTaskStatusFromRunStatus(status = '', reviewSummary = {}) {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  const requiresManualReview = reviewSummary?.requiresManualReview === true
    || reviewSummary?.requires_manual_review === true
    || Number(reviewSummary?.pendingApprovalCount ?? reviewSummary?.pending_approval_count ?? 0) > 0;
  if (normalizedStatus === 'running') {
    return 'running';
  }
  if (normalizedStatus === 'pass') {
    return requiresManualReview ? 'review' : 'completed';
  }
  if (normalizedStatus === 'skipped') {
    return 'queued';
  }
  if (['fail', 'failed', 'cancelled'].includes(normalizedStatus)) {
    return 'needs-repair';
  }
  return '';
}

function taskStatusRank(status = '') {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'running') {
    return 6;
  }
  if (normalized === 'review') {
    return 5;
  }
  if (normalized === 'queued' || normalized === 'ready') {
    return 4;
  }
  if (normalized === 'blocked' || normalized === 'needs-rescope' || normalized === 'needs-repair') {
    return 3;
  }
  if (normalized === 'completed') {
    return 2;
  }
  if (isClosedTaskStatus(normalized)) {
    return 1;
  }
  return 0;
}

function dedupeRunLinks(runLinks = []) {
  const buckets = new Map();
  for (const entry of Array.isArray(runLinks) ? runLinks : []) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const runId = String(entry.runId || '').trim();
    const id = String(entry.id || '').trim();
    const dedupeKey = runId || id;
    if (!dedupeKey) {
      continue;
    }
    const current = buckets.get(dedupeKey);
    if (!current || parseIsoTimestamp(entry.updatedAt) >= parseIsoTimestamp(current.updatedAt)) {
      buckets.set(dedupeKey, entry);
    }
  }
  return Array.from(buckets.values());
}

function buildOpenTaskDedupeKey(task = {}) {
  const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  const signature = String(metadata.followupSignature || '').trim().toLowerCase();
  const scopeRoots = collectPreferredEntityWorkspaceRoots(task).join('|');
  const candidateId = String(task?.candidateId || '').trim().toLowerCase();
  if (signature) {
    if (candidateId.startsWith('repair-failed-run:')) {
      const repairObjective = clipText(task.objective || task.title || '', 220).toLowerCase();
      if (repairObjective) {
        return `repair-run:${repairObjective}|${scopeRoots}`;
      }
    }
    return `sig:${signature}|${scopeRoots}`;
  }
  const objective = clipText(task.objective || task.title || '', 220).toLowerCase();
  if (!objective) {
    return '';
  }
  return `task:${objective}|${scopeRoots}|${String(task.intentType || '').trim().toLowerCase()}`;
}

function buildClosedTaskDedupeKey(task = {}, linkedRun = null) {
  if (!task || typeof task !== 'object') {
    return '';
  }
  const status = String(task.status || '').trim().toLowerCase();
  if (status !== 'completed') {
    return '';
  }
  const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  const linkedRunReviewSummary = linkedRun?.metadata && typeof linkedRun.metadata === 'object'
    ? linkedRun.metadata.reviewSummary || {}
    : {};
  const builderProof = metadata.builderProof === true || linkedRun?.metadata?.builderProof === true;
  const recipeId = String(metadata.recipeId || linkedRun?.metadata?.recipeId || '').trim().toLowerCase();
  const cleanPass = String(linkedRun?.status || metadata.lastRunState || '').trim().toLowerCase() === 'pass';
  const requiresManualReview = Boolean(
    metadata.requiresManualReview
    || linkedRunReviewSummary?.requiresManualReview
    || Number(metadata.reviewPendingCount || 0) > 0,
  );
  if (!builderProof || !recipeId || !cleanPass || requiresManualReview) {
    return '';
  }
  const stableScopeRoots = Array.from(new Set([
    task?.targetWorkspaceRoot,
    task?.projectRoot,
    task?.sourceRoot,
    task?.workspaceRoot,
    metadata?.targetWorkspaceRoot,
    metadata?.projectRoot,
    metadata?.sourceRoot,
    metadata?.workspaceScopeRoot,
    metadata?.workspace_scope_root,
  ].map((item) => normalizeWorkspacePath(item)).filter(Boolean))).join('|');
  return `completed:builder-proof:${recipeId}|${stableScopeRoots}`;
}

function looksInfrastructureFailure(...values) {
  const haystack = values.map((value) => String(value || '').trim()).filter(Boolean).join('\n').toLowerCase();
  if (!haystack) {
    return false;
  }
  return /could not start the python runtime|spawn .*py\.exe enonent|ticket id is required|invalid ticket id|runtime launch failed|python runtime is not available/.test(haystack);
}

function readRuntimeRunMap(workspaceRoot) {
  try {
    const runtimePath = getAssistantRuntimeStatePath(workspaceRoot);
    if (!runtimePath || !fs.existsSync(runtimePath)) {
      return new Map();
    }
    const payload = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    const runs = Array.isArray(payload?.runs)
      ? payload.runs
      : (Array.isArray(payload?.latest) ? payload.latest : []);
    return new Map(
      runs
        .filter((item) => item && typeof item === 'object' && String(item.runId || '').trim())
        .map((item) => [String(item.runId || '').trim(), item]),
    );
  } catch (_error) {
    return new Map();
  }
}

function parseRepairCandidateRunId(candidateId = '') {
  const normalized = String(candidateId || '').trim();
  if (!normalized.toLowerCase().startsWith('repair-failed-run:')) {
    return '';
  }
  return normalized.slice('repair-failed-run:'.length).trim();
}

function shouldArchiveInfrastructureRepairTask(task = {}, linkedRun = null, runtimeRun = null, runtimeRunById = null) {
  if (!task || typeof task !== 'object') {
    return false;
  }
  const status = String(task.status || '').trim().toLowerCase();
  if (isClosedTaskStatus(status)) {
    return false;
  }
  const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  const followupSignature = String(metadata.followupSignature || '').trim().toLowerCase();
  const candidateId = String(task.candidateId || '').trim().toLowerCase();
  const objective = clipText(task.objective || task.title || '', 220).toLowerCase();
  const isGeneratedRepairFollowup = candidateId.startsWith('repair-failed-run:')
    || followupSignature.startsWith('monitor-followup:repair-failed-run:')
    || /repair the latest failed validation path and rerun the relevant checks/.test(objective);
  if (!isGeneratedRepairFollowup) {
    return false;
  }
  const candidateRunId = parseRepairCandidateRunId(candidateId);
  const candidateRuntimeRun = candidateRunId && runtimeRunById instanceof Map
    ? (runtimeRunById.get(candidateRunId) || null)
    : null;
  const effectiveRuntimeRun = runtimeRun || candidateRuntimeRun;
  const linkedStatus = String(linkedRun?.status || effectiveRuntimeRun?.state || '').trim().toLowerCase();
  if (linkedStatus !== 'fail' && linkedStatus !== 'failed') {
    return false;
  }
  return looksInfrastructureFailure(
    effectiveRuntimeRun?.stderrTail,
    effectiveRuntimeRun?.stdoutTail,
    effectiveRuntimeRun?.logTail,
    effectiveRuntimeRun?.blockedReason,
    linkedRun?.summary,
    linkedRun?.label,
  );
}

function choosePreferredTask(candidate = null, current = null) {
  if (!current) {
    return candidate;
  }
  const candidateRank = taskStatusRank(candidate?.status);
  const currentRank = taskStatusRank(current?.status);
  if (candidateRank !== currentRank) {
    return candidateRank > currentRank ? candidate : current;
  }
  return parseIsoTimestamp(candidate?.updatedAt) >= parseIsoTimestamp(current?.updatedAt) ? candidate : current;
}

function runWorkspaceHygiene(workspaceRoot, payload = {}) {
  const hub = readHub(workspaceRoot);
  const workspaceScope = normalizeWorkspaceScope({ workspaceRoot, ...payload });
  const runtimeRunById = readRuntimeRunMap(workspaceRoot);
  const stats = {
    duplicateRunLinksRemoved: 0,
    duplicateTasksArchived: 0,
    staleTaskStatusesSettled: 0,
    infrastructureRepairTasksArchived: 0,
  };

  const dedupedRunLinks = dedupeRunLinks(hub.runLinks);
  stats.duplicateRunLinksRemoved = Math.max(0, hub.runLinks.length - dedupedRunLinks.length);
  hub.runLinks = dedupedRunLinks;

  const runLinkByRunId = new Map(
    hub.runLinks
      .filter((item) => String(item?.runId || '').trim())
      .map((item) => [String(item.runId || '').trim(), item]),
  );

  const chosenTasks = new Map();
  const chosenClosedTasks = new Map();
  for (const task of hub.tasks) {
    if (!task || typeof task !== 'object') {
      continue;
    }
    if (!entityMatchesWorkspaceScope(task, workspaceScope)) {
      continue;
    }
    const linkedRun = runLinkByRunId.get(String(task.lastRunId || '').trim());
    if (!isClosedTaskStatus(task.status)) {
      const dedupeKey = buildOpenTaskDedupeKey(task);
      if (!dedupeKey) {
        continue;
      }
      chosenTasks.set(dedupeKey, choosePreferredTask(task, chosenTasks.get(dedupeKey)));
      continue;
    }
    const closedDedupeKey = buildClosedTaskDedupeKey(task, linkedRun);
    if (!closedDedupeKey) {
      continue;
    }
    chosenClosedTasks.set(closedDedupeKey, choosePreferredTask(task, chosenClosedTasks.get(closedDedupeKey)));
  }

  const updatedAt = nowIso();
  hub.tasks = hub.tasks.map((task) => {
    if (!task || typeof task !== 'object') {
      return task;
    }
    let nextTask = task;
    if (!isClosedTaskStatus(task.status) && entityMatchesWorkspaceScope(task, workspaceScope)) {
      const dedupeKey = buildOpenTaskDedupeKey(task);
      const chosen = dedupeKey ? chosenTasks.get(dedupeKey) : null;
      if (chosen && String(chosen.id || '').trim() !== String(task.id || '').trim()) {
        stats.duplicateTasksArchived += 1;
        nextTask = {
          ...task,
          status: 'archived',
          updatedAt,
          metadata: {
            ...(task.metadata && typeof task.metadata === 'object' ? task.metadata : {}),
            hygieneArchivedAt: updatedAt,
            hygieneReason: 'duplicate-open-task',
            duplicateOfTaskId: String(chosen.id || '').trim(),
          },
        };
      }
    } else if (String(task.status || '').trim().toLowerCase() === 'completed' && entityMatchesWorkspaceScope(task, workspaceScope)) {
      const linkedRun = runLinkByRunId.get(String(task.lastRunId || '').trim());
      const dedupeKey = buildClosedTaskDedupeKey(task, linkedRun);
      const chosen = dedupeKey ? chosenClosedTasks.get(dedupeKey) : null;
      if (chosen && String(chosen.id || '').trim() !== String(task.id || '').trim()) {
        stats.duplicateTasksArchived += 1;
        nextTask = {
          ...task,
          status: 'archived',
          updatedAt,
          metadata: {
            ...(task.metadata && typeof task.metadata === 'object' ? task.metadata : {}),
            hygieneArchivedAt: updatedAt,
            hygieneReason: 'duplicate-completed-proof-task',
            duplicateOfTaskId: String(chosen.id || '').trim(),
          },
        };
      }
    }

    const linkedRun = runLinkByRunId.get(String(nextTask.lastRunId || '').trim());
    const runtimeRun = runtimeRunById.get(String(nextTask.lastRunId || '').trim()) || null;
    if (String(nextTask.status || '').trim().toLowerCase() === 'archived') {
      return nextTask;
    }
    if (shouldArchiveInfrastructureRepairTask(nextTask, linkedRun, runtimeRun, runtimeRunById)) {
      stats.infrastructureRepairTasksArchived += 1;
      return {
        ...nextTask,
        status: 'archived',
        updatedAt,
        metadata: {
          ...(nextTask.metadata && typeof nextTask.metadata === 'object' ? nextTask.metadata : {}),
          hygieneArchivedAt: updatedAt,
          hygieneReason: 'infrastructure-run-failure',
          archivedFromRunId: String(nextTask.lastRunId || '').trim(),
        },
      };
    }
    if (!linkedRun) {
      return nextTask;
    }
    const reviewSummary = linkedRun?.metadata && typeof linkedRun.metadata === 'object'
      ? linkedRun.metadata.reviewSummary || {}
      : {};
    const settledStatus = deriveTaskStatusFromRunStatus(linkedRun.status, reviewSummary);
    if (settledStatus && settledStatus !== nextTask.status) {
      stats.staleTaskStatusesSettled += 1;
      return {
        ...nextTask,
        status: settledStatus,
        updatedAt,
      };
    }
    return nextTask;
  });

  writeHub(workspaceRoot, hub);
  return {
    ok: true,
    stats,
    hubPath: hubPath(workspaceRoot),
    taskCount: hub.tasks.length,
    runCount: hub.runLinks.length,
  };
}

function summarizeSelfHostExpansion(taskHub = {}, options = {}) {
  const hub = taskHub && typeof taskHub === 'object' ? taskHub : {};
  const workspaceScope = normalizeWorkspaceScope(options);
  const roadmapDay = String(options.roadmapDay || localDayKey(options.now || Date.now())).trim();
  const tasks = Array.isArray(hub.tasks)
    ? hub.tasks.filter((task) => task && typeof task === 'object' && entityMatchesWorkspaceScope(task, workspaceScope))
    : [];
  const runLinks = Array.isArray(hub.runLinks)
    ? hub.runLinks.filter((item) => item && typeof item === 'object' && entityMatchesWorkspaceScope(item, workspaceScope))
    : [];
  const runLinkByRunId = new Map(
    runLinks
      .filter((link) => String(link?.runId || '').trim())
      .map((link) => [String(link.runId || '').trim(), link]),
  );
  const relevantTasks = tasks.filter((task) => {
    if (!isSelfHostExpansionTask(task)) {
      return false;
    }
    const metadata = task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
    const metadataRoadmapDay = String(metadata.roadmapDay || '').trim();
    if (metadataRoadmapDay && roadmapDay) {
      return metadataRoadmapDay === roadmapDay;
    }
    const signalDay = String(
      metadata.selfHostExpansionOutcomeAt
      || metadata.selfHostExpansionConsumedAt
      || task.updatedAt
      || task.createdAt
      || ''
    ).trim();
    return !roadmapDay || localDayKey(signalDay || Date.now()) === roadmapDay;
  });
  if (relevantTasks.length === 0) {
    return {
      exists: false,
      status: 'idle',
      label: 'NOT USED',
      summary: 'The extra self-host expansion lane has not been consumed today yet.',
      nextAction: 'Let the engine auto-run one bounded self-host follow-up when the lane is OPEN.',
      queuedCount: 0,
      consumedCount: 0,
      successfulCount: 0,
      reviewCount: 0,
      failedCount: 0,
      runningCount: 0,
      latestOutcome: '',
      latestSummary: '',
      latestTaskId: '',
      latestRunId: '',
    };
  }
  const outcomeRows = relevantTasks.map((task) => {
    const metadata = task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
    const runId = String(metadata.selfHostExpansionRunId || task.lastRunId || '').trim();
    const runLink = runLinkByRunId.get(runId) || null;
    const rawOutcome = String(
      metadata.selfHostExpansionOutcome
      || runLink?.status
      || task.status
      || ''
    ).trim().toLowerCase();
    const outcome = rawOutcome === 'completed'
      ? 'pass'
      : rawOutcome === 'review'
        ? 'review'
        : rawOutcome === 'needs-repair'
          ? 'fail'
          : rawOutcome;
    return {
      taskId: String(task.id || '').trim(),
      runId,
      consumed: Boolean(runId || metadata.selfHostExpansionConsumedAt),
      outcome,
      summary: String(
        metadata.selfHostExpansionOutcomeSummary
        || metadata.lastRunSummary
        || runLink?.summary
        || task.objective
        || task.title
        || ''
      ).trim(),
      updatedAt: String(
        metadata.selfHostExpansionOutcomeAt
        || metadata.selfHostExpansionConsumedAt
        || runLink?.updatedAt
        || task.updatedAt
        || task.createdAt
        || ''
      ).trim(),
    };
  }).sort((left, right) => parseIsoTimestamp(right.updatedAt) - parseIsoTimestamp(left.updatedAt));
  const queuedCount = outcomeRows.filter((item) => !item.consumed).length;
  const consumedCount = outcomeRows.filter((item) => item.consumed).length;
  const successfulCount = outcomeRows.filter((item) => item.outcome === 'pass').length;
  const reviewCount = outcomeRows.filter((item) => item.outcome === 'review').length;
  const failedCount = outcomeRows.filter((item) => ['fail', 'failed', 'cancelled'].includes(item.outcome)).length;
  const runningCount = outcomeRows.filter((item) => item.outcome === 'running').length;
  const latest = outcomeRows[0] || {};
  let label = 'QUEUED';
  let status = 'queued';
  let summary = `${queuedCount}/${relevantTasks.length} self-host expansion task(s) are queued but not consumed yet.`;
  let nextAction = 'Launch the queued bounded self-host follow-up before widening Phase 1 further.';
  if (runningCount > 0) {
    label = 'RUNNING';
    status = 'running';
    summary = `The extra self-host expansion lane is currently running (${runningCount}/${consumedCount || relevantTasks.length} active).`;
    nextAction = 'Wait for the bounded self-host follow-up to settle, then rerun roadmap and self-host proof checks.';
  } else if (failedCount > 0) {
    label = 'FAIL';
    status = 'fail';
    summary = `The extra self-host expansion lane was consumed and needs repair (${failedCount} failed).`;
    nextAction = latest.summary || 'Repair the consumed self-host follow-up before opening more self-work.';
  } else if (reviewCount > 0) {
    label = 'REVIEW';
    status = 'review';
    summary = `The extra self-host expansion lane was consumed and is now held for review (${reviewCount} review-held).`;
    nextAction = latest.summary || 'Clear the held review before letting the engine take another bounded step.';
  } else if (successfulCount > 0) {
    label = 'PASS';
    status = 'pass';
    summary = `The extra self-host expansion lane was consumed successfully (${successfulCount} pass).`;
    nextAction = 'Use the passed self-host expansion proof to close the remaining Phase 1 blockers instead of widening further.';
  }
  return {
    exists: true,
    status,
    label,
    summary: clipText(summary, 180),
    nextAction: clipText(nextAction, 180),
    queuedCount,
    consumedCount,
    successfulCount,
    reviewCount,
    failedCount,
    runningCount,
    latestOutcome: String(latest.outcome || '').trim(),
    latestSummary: clipText(latest.summary || '', 180),
    latestTaskId: String(latest.taskId || '').trim(),
    latestRunId: String(latest.runId || '').trim(),
  };
}

function makeEntityId(prefix, value = '') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace(/[-TZ]/g, '');
  return `${prefix}_${slugify(value, prefix)}_${stamp}`;
}

function humanTitleFromPrompt(prompt, options = {}) {
  const text = clipText(prompt, 96);
  if (!text) {
    return 'Untitled task';
  }
  const sentence = text.replace(/^[\s"'`]+|[\s"'`]+$/g, '');
  const targetRoot = String(options.targetWorkspaceRoot || options.workspaceRoot || '').trim();
  const styleProfile = targetRoot ? deriveWorkspaceStyleProfile(targetRoot, targetRoot, 120) : {};
  return improveTitleWithStyleProfile(sentence, styleProfile, { forceImperative: options.forceImperative === true }) || 'Untitled task';
}

function normalizeReferenceAttachments(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const pathValue = String(item.path || item.sourcePath || '').trim();
      const nameValue = String(item.originalName || item.name || '').trim();
      if (!pathValue && !nameValue) {
        return null;
      }
      return {
        id: String(item.id || '').trim(),
        kind: String(item.kind || '').trim().toLowerCase() || 'file',
        name: nameValue,
        path: pathValue,
        mimeType: String(item.mimeType || '').trim().toLowerCase(),
        width: Number(item.width || 0) || 0,
        height: Number(item.height || 0) || 0,
      };
    })
    .filter(Boolean)
    .slice(0, 6);
}

function isImageReferenceAttachment(item = {}) {
  const kind = String(item.kind || '').trim().toLowerCase();
  const mimeType = String(item.mimeType || '').trim().toLowerCase();
  const source = `${item.path || ''} ${item.name || ''}`.toLowerCase();
  return (
    kind === 'image' ||
    mimeType.startsWith('image/') ||
    /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(source)
  );
}

function inferReferenceAttachments(payload = {}) {
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  const direct = normalizeReferenceAttachments(payload.referenceAttachments);
  const fromMetadata = normalizeReferenceAttachments(
    metadata.referenceAttachments || metadata.attachments || payload.attachments,
  );
  return Array.from(new Map([...direct, ...fromMetadata].map((item) => [item.path || item.name || item.id, item])).values());
}

function normalizeTrustedDocs(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const url = String(item.url || item.requestedUrl || item.sourceUrl || '').trim();
      const title = String(item.title || item.summary || item.section || '').trim();
      if (!url && !title) {
        return null;
      }
      return {
        url,
        title,
        section: String(item.section || '').trim(),
        summary: String(item.summary || item.title || item.section || '').trim(),
        domain: String(item.domain || '').trim(),
        reason: String(item.reason || '').trim(),
        outputPath: String(item.outputPath || '').trim(),
      };
    })
    .filter(Boolean)
    .slice(0, 4);
}

function inferTrustedDocs(payload = {}) {
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  const direct = normalizeTrustedDocs(payload.trustedDocs || payload.approvedDocs);
  const fromMetadata = normalizeTrustedDocs(
    metadata.trustedDocs || metadata.approvedDocs || metadata.approvedSources,
  );
  return Array.from(new Map([...direct, ...fromMetadata].map((item) => [item.url || item.title, item])).values());
}

function inferTargetPathsFromPayload(payload = {}) {
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  const direct = normalizeList(
    payload.sliceTargetPaths || payload.targetPaths || metadata.targetPaths || metadata.sliceTargetPaths,
  );
  return Array.from(new Set(direct)).slice(0, 8);
}

function improveEntityTitle(prompt = '', payload = {}) {
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  const targetRoot = String(payload.targetWorkspaceRoot || payload.workspaceRoot || metadata.targetWorkspaceRoot || '').trim();
  const styleProfile = targetRoot ? deriveWorkspaceStyleProfile(targetRoot, targetRoot, 120) : {};
  const base = improveTitleWithStyleProfile(
    humanTitleFromPrompt(prompt, { targetWorkspaceRoot: targetRoot, forceImperative: true }),
    styleProfile,
    { forceImperative: true },
  ) || humanTitleFromPrompt(prompt, { targetWorkspaceRoot: targetRoot, forceImperative: true });
  const attachments = inferReferenceAttachments(payload).filter((item) => isImageReferenceAttachment(item));
  if (attachments.length > 0 && /(ui|screen|layout|design|screenshot|image)/i.test(prompt)) {
    return `${base.replace(/\.$/, '')} (from screenshot)`;
  }
  if (String(payload.ring || '').trim().toLowerCase() === 'candidate') {
    return `${base.replace(/\.$/, '')} [candidate]`;
  }
  return base;
}

function buildTaskSlices(objective = '', payload = {}) {
  const targetPaths = inferTargetPathsFromPayload(payload);
  const referenceAttachments = inferReferenceAttachments(payload).filter((item) => isImageReferenceAttachment(item));
  const trustedDocs = inferTrustedDocs(payload);
  const lower = String(objective || '').toLowerCase();
  const risk = classifyRisk(objective, payload);
  const validation = inferAcceptanceChecks(objective, payload);
  const promotionImpact = String(payload.promotionState || payload.ring || (payload.labRoot ? 'lab' : 'live') || 'live');
  const baseSlice = {
    targetPaths,
    risk,
    validation,
    promotionImpact,
    referenceAttachments,
    trustedDocs,
  };

  if (referenceAttachments.length > 0) {
    return [
      {
        id: makeEntityId('slice', 'analyze-reference'),
        title: 'Analyze the screenshot reference',
        summary: 'Read the attached screenshot, identify the target surface, and bound the next safe slice before editing code.',
        kind: 'analyze-reference',
        sliceMode: 'screen-reference',
        sliceIndex: 0,
        targetPaths,
        risk,
        validation: [
          'Map the screenshot to the most likely screen, component, or layout files before editing.',
          trustedDocs.length > 0
            ? 'Keep the reference aligned with the trusted documentation attached to this task.'
            : 'Keep the slice bounded to the visible screen problem.',
        ],
        promotionImpact,
        referenceAttachments,
        trustedDocs,
      },
      {
        id: makeEntityId('slice', 'implement-screen'),
        title: 'Implement the next screen slice',
        summary: 'Apply one bounded UI or code slice that moves the target screen toward the screenshot reference without widening scope.',
        kind: 'implement-screen-slice',
        sliceMode: 'screen-reference',
        sliceIndex: 1,
        ...baseSlice,
        validation: [
          'Keep the change limited to the selected screen or component slice.',
          ...validation.slice(0, 2),
        ].slice(0, 3),
      },
      {
        id: makeEntityId('slice', 'validate-visual'),
        title: 'Validate the visual slice',
        summary: 'Run checks, compare the resulting screen against the screenshot reference, and capture any remaining gap as a follow-up slice.',
        kind: 'validate-visual-slice',
        sliceMode: 'screen-reference',
        sliceIndex: 2,
        ...baseSlice,
        validation: [
          ...validation,
          'Compare the implemented result against the screenshot and note any remaining visual gaps.',
        ].filter((item, index, list) => list.indexOf(item) === index),
      },
    ];
  }

  const slices = [
    {
      id: makeEntityId('slice', 'scope'),
      title: 'Scope the task',
      summary: 'Confirm the bounded objective, risks, and validation plan before applying changes.',
      kind: 'scope',
      sliceMode: 'bounded-change',
      sliceIndex: 0,
      ...baseSlice,
      validation: validation.slice(0, 2),
    },
  ];

  if (targetPaths.length > 0 || /(build|create|implement|fix|repair|refactor|update|ui|screen|layout)/.test(lower)) {
    slices.push({
      id: makeEntityId('slice', 'implement'),
      title: /(ui|screen|layout|design|screenshot|image)/.test(lower) ? 'Implement the screen slice' : 'Implement the code slice',
      summary: 'Apply the smallest viable code change for this task slice.',
      kind: /(ui|screen|layout|design|screenshot|image)/.test(lower) ? 'implement-screen-slice' : 'implement-code-slice',
      sliceMode: /(ui|screen|layout|design|screenshot|image)/.test(lower) ? 'screen-reference' : 'bounded-change',
      sliceIndex: 1,
      ...baseSlice,
      validation: validation.slice(0, 2),
    });
  }

  slices.push({
    id: makeEntityId('slice', 'validate'),
    title: 'Validate and summarize',
    summary: 'Run the relevant checks, summarize the diff, and capture follow-up review signals.',
    kind: 'validate',
    sliceMode: 'bounded-change',
    sliceIndex: slices.length,
    ...baseSlice,
  });

  return slices.map((slice, index) => ({
    ...slice,
    sliceIndex: index,
  }));
}

function classifyRisk(prompt = '', payload = {}) {
  if (payload.riskClass) {
    return String(payload.riskClass).trim().toLowerCase() || 'medium';
  }
  const lower = String(prompt || '').toLowerCase();
  if (/(deploy|production|billing|payment|customer|database migration|schema)/.test(lower)) {
    return 'high';
  }
  if (/(review|explain|summarize|read|docs|research)/.test(lower)) {
    return 'low';
  }
  return 'medium';
}

function inferCapabilities(prompt = '', payload = {}) {
  if (Array.isArray(payload.capabilities) && payload.capabilities.length) {
    return normalizeList(payload.capabilities);
  }
  const text = String(prompt || '').trim();
  const lower = text.toLowerCase();
  const engineFirstIntent = /^(plan|review|summari[sz]e|research|investigate|analy[sz]e|validate|check|inspect)\b/.test(lower)
    || /(what needs fixing|tell me what needs fixing|blocker summary|acceptance summary|validation snapshot)/.test(lower);
  const capabilities = new Set(['chat-fast', 'plan-reasoning']);
  if (/(build|create|implement|write|code|refactor|fix|repair|debug|update)/.test(lower) && !engineFirstIntent) {
    capabilities.add('code-main');
  }
  if (/(test|verify|review|check|regression)/.test(lower)) {
    capabilities.add('review-verify');
  }
  if (/(docs|documentation|research|investigate|look up|compare)/.test(lower)) {
    capabilities.add('research-docs');
  }
  if (/(repair|fix|debug|recover)/.test(lower) && !engineFirstIntent) {
    capabilities.add('repair-fast');
  }
  if (/(ops|status|report|summarize|business)/.test(lower)) {
    capabilities.add('ops-summary');
  }
  return Array.from(capabilities);
}

function inferRouteMetadata(prompt = '', payload = {}, capabilities = []) {
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  const normalizedCapabilities = Array.isArray(capabilities)
    ? capabilities.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const requestedModelRole = String(
    metadata.requestedModelRole
    || metadata.requested_model_role
    || payload.requestedModelRole
    || (
      normalizedCapabilities.some((item) => ['code-main', 'repair-fast'].includes(item))
        ? 'workspace'
        : 'engine'
    ),
  ).trim().toLowerCase() || 'engine';
  let routeLaneId = String(
    metadata.routeLaneId
    || metadata.route_lane_id
    || payload.routeLaneId
    || '',
  ).trim().toLowerCase();
  if (!routeLaneId) {
    if (normalizedCapabilities.includes('research-docs')) {
      routeLaneId = 'research-docs';
    } else if (normalizedCapabilities.includes('review-verify')) {
      routeLaneId = 'review-verify';
    } else if (normalizedCapabilities.includes('ops-summary')) {
      routeLaneId = 'ops-summary';
    } else if (requestedModelRole === 'workspace' && normalizedCapabilities.includes('repair-fast')) {
      routeLaneId = 'repair-fast';
    } else if (requestedModelRole === 'workspace' && normalizedCapabilities.includes('code-main')) {
      routeLaneId = 'code-main';
    } else {
      routeLaneId = 'plan-reasoning';
    }
  }
  const taskMode = String(
    metadata.taskMode
    || metadata.task_mode
    || payload.taskMode
    || (
      routeLaneId === 'research-docs'
        ? 'research'
        : routeLaneId === 'review-verify'
          ? 'validator'
          : routeLaneId === 'ops-summary'
            ? 'summarizer'
            : routeLaneId === 'repair-fast'
              ? 'repair'
              : routeLaneId === 'code-main'
                ? 'coder'
                : 'planner'
    ),
  ).trim().toLowerCase();
  const autonomyDifficultyCeiling = Math.max(
    1,
    Math.min(
      5,
      Number(
        metadata.autonomyDifficultyCeiling
        || metadata.autonomy_difficulty_ceiling
        || payload.autonomyDifficultyCeiling
        || (requestedModelRole === 'workspace' ? 3 : 2),
      ) || (requestedModelRole === 'workspace' ? 3 : 2),
    ),
  );
  return {
    workspaceScopeRoot: String(
      metadata.workspaceScopeRoot
      || metadata.workspace_scope_root
      || payload.targetWorkspaceRoot
      || payload.workspaceRoot
      || '',
    ).trim(),
    requestedModelRole,
    routeLaneId,
    taskMode,
    autonomyDifficultyCeiling,
  };
}

function inferBudget(prompt = '', payload = {}) {
  if (payload.budget && typeof payload.budget === 'object') {
    return {
      maxMinutes: Math.max(5, Number(payload.budget.maxMinutes || 20)),
      maxAttempts: Math.max(1, Number(payload.budget.maxAttempts || 2)),
    };
  }
  const lower = String(prompt || '').toLowerCase();
  return {
    maxMinutes: /(benchmark|self-host|large|migration|release)/.test(lower) ? 35 : 20,
    maxAttempts: /(repair|fix|debug)/.test(lower) ? 3 : 2,
  };
}

function inferAcceptanceChecks(prompt = '', payload = {}) {
  if (Array.isArray(payload.acceptanceChecks) && payload.acceptanceChecks.length) {
    return normalizeList(payload.acceptanceChecks);
  }
  const checks = [];
  const lower = String(prompt || '').toLowerCase();
  if (/(test|fix|repair|debug|refactor|implement|code|build|create|update)/.test(lower)) {
    checks.push('Relevant tests pass or a clear validation command is provided.');
  }
  if (/(review|diff|inspect)/.test(lower)) {
    checks.push('Summarize the diff and any review risks before finishing.');
  }
  if (/(docs|documentation|research)/.test(lower)) {
    checks.push('Cite the documentation or explain why the recommendation is safe.');
  }
  if (/(test|fix|repair|debug|refactor|implement|code|build|create|update|config|setting|workflow|provider|model|extension|vscode|ui|screen)/.test(lower)) {
    checks.push('Update or generate operator-facing docs when commands, settings, flows, or visible behavior change, or explain why no docs update is needed.');
  }
  if (/(route|routing|repair|validation|operator wording|wording drift|ui shell|lane|chat-fast|repair-fast|review-verify)/.test(lower)) {
    checks.push('Run npm run proof:route-quality when routing, repair, validation, or operator wording changes.');
  }
  if (checks.length === 0) {
    checks.push('Return a concise implementation or analysis summary.');
  }
  return checks;
}

function inferIntentType(prompt = '') {
  const text = String(prompt || '').trim();
  if (!text) {
    return 'answer-only';
  }
  if (text.startsWith('/')) {
    return 'command';
  }
  const lower = text.toLowerCase();
  if (/^(what|why|how|which|who|when)\b/.test(lower) || /\?$/.test(lower)) {
    return 'answer-only';
  }
  if (/(build|create|implement|fix|repair|refactor|add|update|set up|setup|review|analyze|plan|prepare|scaffold|debug)/.test(lower)) {
    return 'launched-run';
  }
  return 'created-task';
}

function isActionablePrompt(prompt = '') {
  return ['created-task', 'launched-run'].includes(inferIntentType(prompt));
}

function engineBatGoalId(workspaceRoot) {
  return `${ENGINE_BAT_GOAL_PREFIX}_${slugify(path.basename(String(workspaceRoot || 'workspace')) || 'workspace', 'workspace')}`;
}

function engineBatTaskId(ticket) {
  return `${ENGINE_BAT_TASK_PREFIX}_${String(ticket || '').trim()}`;
}

function normalizeEngineBatTaskStatus(status = '') {
  const normalized = String(status || '').trim().toUpperCase();
  if (!normalized || normalized.includes('TODO')) {
    return 'ready';
  }
  if (normalized.includes('DONE')) {
    return 'completed';
  }
  if (normalized.includes('IN_PROGRESS') || normalized.includes('RUNNING') || normalized.includes('DOING')) {
    return 'running';
  }
  if (normalized.includes('BLOCK') || normalized.includes('HOLD')) {
    return 'blocked';
  }
  if (normalized.includes('TEST') || normalized.includes('REVIEW')) {
    return 'review-needed';
  }
  return 'ready';
}

function listEngineBatItems(workspaceRoot, payload = {}) {
  const includeCompleted = payload.includeCompletedCompat === true;
  return parseBatBoard(workspaceRoot).filter((item) => {
    if (!item || !item.ticket) {
      return false;
    }
    if (includeCompleted) {
      return true;
    }
    return !String(item.status || '').toUpperCase().includes('DONE');
  });
}

function buildEngineBatGoal(workspaceRoot, items = []) {
  if (!items.length) {
    return null;
  }
  const readyCount = items.filter((item) => normalizeEngineBatTaskStatus(item.status) === 'ready').length;
  const runningCount = items.filter((item) => normalizeEngineBatTaskStatus(item.status) === 'running').length;
  const blockedCount = items.filter((item) => normalizeEngineBatTaskStatus(item.status) === 'blocked').length;
  const summaryParts = [
    `${items.length} engine BAT task${items.length === 1 ? '' : 's'}`,
    readyCount > 0 ? `${readyCount} ready` : '',
    runningCount > 0 ? `${runningCount} running` : '',
    blockedCount > 0 ? `${blockedCount} blocked` : '',
  ].filter(Boolean);
  return {
    id: engineBatGoalId(workspaceRoot),
    title: 'Engine BAT backlog',
    objective: 'Internal engine backlog imported from the BAT board for self-hosting and engine work.',
    source: 'bat-board',
    status: runningCount > 0 ? 'active' : readyCount > 0 ? 'queued' : 'idle',
    workspaceRoot: String(workspaceRoot || '').trim(),
    targetWorkspaceRoot: String(workspaceRoot || '').trim(),
    labRoot: '',
    threadId: '',
    changeSessionId: '',
    createdAt: '',
    updatedAt: '',
    metadata: {
      compatSource: 'engine-bat-board',
      summary: summaryParts.join(' • '),
      taskCount: items.length,
      readyCount,
      runningCount,
      blockedCount,
    },
  };
}

function buildEngineBatTask(workspaceRoot, item = {}) {
  const summary = clipText(item.summary || item.desc || `BAT<${item.ticket || ''}>`, 180);
  const riskClass = String(item.risk || '').trim().toLowerCase() || classifyRisk(summary);
  const acceptanceChecks = [
    'Keep the engine BAT requirements aligned with the board entry.',
    'Summarize validation and review signals before marking work complete.',
    ...inferAcceptanceChecks(summary, {}),
  ].filter((value, index, list) => list.indexOf(value) === index);
  return {
    id: engineBatTaskId(item.ticket),
    goalId: engineBatGoalId(workspaceRoot),
    title: `BAT<${item.ticket}> ${summary || 'Engine task'}`,
    objective: `Work BAT<${item.ticket}> safely and summarize the resulting code, validation, and review state. ${summary}`.trim(),
    source: 'bat-board',
    status: normalizeEngineBatTaskStatus(item.status),
    intentType: 'launched-run',
    riskClass,
    capabilities: inferCapabilities(summary, {}),
    acceptanceChecks,
    budget: inferBudget(summary, { budget: { maxMinutes: 30, maxAttempts: riskClass === 'high' ? 2 : 3 } }),
    workspaceRoot: String(workspaceRoot || '').trim(),
    targetWorkspaceRoot: String(workspaceRoot || '').trim(),
    labRoot: '',
    threadId: '',
    changeSessionId: '',
    createdAt: '',
    updatedAt: '',
    readOnly: true,
    metadata: {
      compatSource: 'engine-bat-board',
      batTicket: String(item.ticket || '').trim(),
      batStatus: String(item.status || '').trim(),
      batSummary: summary,
      tags: Array.isArray(item.tags) ? item.tags : [],
      deps: Array.isArray(item.deps) ? item.deps : [],
      lineNumber: Number(item.lineNumber || 0),
      defaultAction: 'run',
    },
  };
}

function listCompatibilityGoals(workspaceRoot, payload = {}) {
  const items = listEngineBatItems(workspaceRoot, payload);
  const goal = buildEngineBatGoal(workspaceRoot, items);
  return goal ? [goal] : [];
}

function listCompatibilityTasks(workspaceRoot, payload = {}) {
  return listEngineBatItems(workspaceRoot, payload).map((item) => buildEngineBatTask(workspaceRoot, item));
}

function createGoalRecord(workspaceRoot, payload = {}) {
  const objective = clipText(payload.objective || payload.prompt || payload.title || '');
  const createdAt = nowIso();
  const routeMetadata = inferRouteMetadata(payload.objective || payload.prompt || payload.title || '', payload, payload.capabilities);
  return {
    id: String(payload.id || makeEntityId('goal', objective || 'goal')),
    title: humanTitleFromPrompt(payload.title || objective || 'Goal', {
      targetWorkspaceRoot: String(payload.targetWorkspaceRoot || workspaceRoot || '').trim(),
      forceImperative: true,
    }),
    objective,
    source: String(payload.source || 'chat').trim() || 'chat',
    status: String(payload.status || 'active').trim().toLowerCase() || 'active',
    workspaceRoot: String(workspaceRoot || '').trim(),
    targetWorkspaceRoot: String(payload.targetWorkspaceRoot || workspaceRoot || '').trim(),
    labRoot: String(payload.labRoot || '').trim(),
    threadId: String(payload.threadId || '').trim(),
    changeSessionId: String(payload.changeSessionId || '').trim(),
    createdAt,
    updatedAt: createdAt,
    metadata: {
      ...(payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}),
      workspaceScopeRoot: routeMetadata.workspaceScopeRoot,
      requestedModelRole: routeMetadata.requestedModelRole,
      routeLaneId: routeMetadata.routeLaneId,
      taskMode: routeMetadata.taskMode,
      autonomyDifficultyCeiling: routeMetadata.autonomyDifficultyCeiling,
    },
  };
}

function createTaskRecord(workspaceRoot, payload = {}) {
  const objective = clipText(payload.objective || payload.prompt || payload.title || '');
  const createdAt = nowIso();
  const ring = String(payload.ring || (payload.labRoot ? 'lab' : 'live')).trim().toLowerCase() || 'live';
  const capabilities = inferCapabilities(payload.objective || payload.prompt || payload.title || '', payload);
  const routeMetadata = inferRouteMetadata(payload.objective || payload.prompt || payload.title || '', payload, capabilities);
  const slices = Array.isArray(payload.slices) && payload.slices.length
    ? payload.slices
    : buildTaskSlices(objective, payload);
  return {
    id: String(payload.id || makeEntityId('task', objective || 'task')),
    goalId: String(payload.goalId || '').trim(),
    title: improveEntityTitle(payload.title || objective || 'Task', payload),
    objective,
    source: String(payload.source || 'chat').trim() || 'chat',
    status: String(payload.status || 'ready').trim().toLowerCase() || 'ready',
    intentType: inferIntentType(payload.objective || payload.prompt || payload.title || ''),
    riskClass: classifyRisk(payload.objective || payload.prompt || payload.title || '', payload),
    capabilities,
    acceptanceChecks: inferAcceptanceChecks(payload.objective || payload.prompt || payload.title || '', payload),
    budget: inferBudget(payload.objective || payload.prompt || payload.title || '', payload),
    workspaceRoot: String(workspaceRoot || '').trim(),
    targetWorkspaceRoot: String(payload.targetWorkspaceRoot || workspaceRoot || '').trim(),
    labRoot: String(payload.labRoot || '').trim(),
    ring,
    candidateId: String(payload.candidateId || '').trim(),
    promotionState: String(payload.promotionState || ring).trim().toLowerCase() || ring,
    sliceTargetPaths: inferTargetPathsFromPayload(payload),
    slices,
    threadId: String(payload.threadId || '').trim(),
    changeSessionId: String(payload.changeSessionId || '').trim(),
    createdAt,
    updatedAt: createdAt,
    metadata: {
      ...(payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}),
      workspaceScopeRoot: routeMetadata.workspaceScopeRoot,
      requestedModelRole: routeMetadata.requestedModelRole,
      routeLaneId: routeMetadata.routeLaneId,
      taskMode: routeMetadata.taskMode,
      autonomyDifficultyCeiling: routeMetadata.autonomyDifficultyCeiling,
    },
  };
}

function createGoalAndTask(workspaceRoot, payload = {}) {
  const hub = readHub(workspaceRoot);
  const goal = createGoalRecord(workspaceRoot, payload);
  const task = createTaskRecord(workspaceRoot, {
    ...payload,
    goalId: goal.id,
  });
  goal.lastTaskId = task.id;
  goal.updatedAt = task.updatedAt;
  hub.goals = [goal, ...hub.goals.filter((item) => item.id !== goal.id)].slice(0, 240);
  hub.tasks = [task, ...hub.tasks.filter((item) => item.id !== task.id)].slice(0, 480);
  writeHub(workspaceRoot, hub);
  return { ok: true, goal, task, hubPath: hubPath(workspaceRoot) };
}

function createGoal(workspaceRoot, payload = {}) {
  const hub = readHub(workspaceRoot);
  const goal = createGoalRecord(workspaceRoot, payload);
  hub.goals = [goal, ...hub.goals.filter((item) => item.id !== goal.id)].slice(0, 240);
  writeHub(workspaceRoot, hub);
  return { ok: true, goal, hubPath: hubPath(workspaceRoot) };
}

function listGoals(workspaceRoot, payload = {}) {
  const hub = readHub(workspaceRoot);
  const limit = Math.max(1, Math.min(200, Number(payload.limit || 80)));
  const workspaceScope = normalizeWorkspaceScope({ workspaceRoot, ...payload });
  const compatibilityGoals = payload.includeCompat === false ? [] : listCompatibilityGoals(workspaceRoot, payload);
  const goals = [...hub.goals, ...compatibilityGoals].filter((goal) => entityMatchesWorkspaceScope(goal, workspaceScope));
  return {
    ok: true,
    goals: goals.slice(0, limit),
    count: goals.length,
    hubPath: hubPath(workspaceRoot),
  };
}

function updateGoal(workspaceRoot, payload = {}) {
  const goalId = String(payload.goalId || payload.id || '').trim();
  if (!goalId) {
    return { ok: false, message: 'goalId is required.' };
  }
  const hub = readHub(workspaceRoot);
  let updatedGoal = null;
  hub.goals = hub.goals.map((goal) => {
    if (goal.id !== goalId) {
      return goal;
    }
    updatedGoal = {
      ...goal,
      ...(payload.patch && typeof payload.patch === 'object' ? payload.patch : {}),
      updatedAt: nowIso(),
    };
    return updatedGoal;
  });
  if (!updatedGoal) {
    return { ok: false, message: 'Goal not found.', goalId };
  }
  writeHub(workspaceRoot, hub);
  return { ok: true, goal: updatedGoal, hubPath: hubPath(workspaceRoot) };
}

function listTasks(workspaceRoot, payload = {}) {
  const hub = readHub(workspaceRoot);
  const limit = Math.max(1, Math.min(240, Number(payload.limit || 120)));
  const workspaceScope = normalizeWorkspaceScope({ workspaceRoot, ...payload });
  let tasks = [...hub.tasks];
  if (payload.includeCompat !== false) {
    tasks = tasks.concat(listCompatibilityTasks(workspaceRoot, payload));
  }
  tasks = tasks.filter((task) => entityMatchesWorkspaceScope(task, workspaceScope));
  if (payload.goalId) {
    tasks = tasks.filter((task) => task.goalId === String(payload.goalId));
  }
  if (payload.threadId) {
    tasks = tasks.filter((task) => task.threadId === String(payload.threadId));
  }
  if (payload.status) {
    const status = String(payload.status).trim().toLowerCase();
    tasks = tasks.filter((task) => String(task.status || '').trim().toLowerCase() === status);
  }
  return {
    ok: true,
    tasks: tasks.slice(0, limit),
    count: tasks.length,
    hubPath: hubPath(workspaceRoot),
  };
}

function findGoal(workspaceRoot, goalId, payload = {}) {
  const id = String(goalId || '').trim();
  if (!id) {
    return null;
  }
  const hub = readHub(workspaceRoot);
  const direct = Array.isArray(hub.goals) ? hub.goals.find((goal) => goal.id === id) : null;
  if (direct) {
    return direct;
  }
  return listCompatibilityGoals(workspaceRoot, { ...payload, limit: 999 }).find((goal) => goal.id === id) || null;
}

function findTask(workspaceRoot, taskId, payload = {}) {
  const id = String(taskId || '').trim();
  if (!id) {
    return null;
  }
  const hub = readHub(workspaceRoot);
  const direct = Array.isArray(hub.tasks) ? hub.tasks.find((task) => task.id === id) : null;
  if (direct) {
    return direct;
  }
  return listCompatibilityTasks(workspaceRoot, { ...payload, limit: 999, includeCompletedCompat: true }).find((task) => task.id === id) || null;
}

function createTask(workspaceRoot, payload = {}) {
  const hub = readHub(workspaceRoot);
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  const existingTask = findOpenTaskByFollowupSignature(hub, metadata.followupSignature);
  if (existingTask) {
    return { ok: true, task: existingTask, hubPath: hubPath(workspaceRoot), deduped: true };
  }
  const task = createTaskRecord(workspaceRoot, payload);
  const openTaskDedupeKey = buildOpenTaskDedupeKey(task);
  if (openTaskDedupeKey) {
    const matchingOpenTask = hub.tasks.find((item) => {
      if (!item || typeof item !== 'object' || isClosedTaskStatus(item.status)) {
        return false;
      }
      return buildOpenTaskDedupeKey(item) === openTaskDedupeKey;
    });
    if (matchingOpenTask) {
      return { ok: true, task: matchingOpenTask, hubPath: hubPath(workspaceRoot), deduped: true };
    }
  }
  hub.tasks = [task, ...hub.tasks.filter((item) => item.id !== task.id)].slice(0, 480);
  if (task.goalId) {
    hub.goals = hub.goals.map((goal) => (
      goal.id === task.goalId
        ? { ...goal, lastTaskId: task.id, updatedAt: task.updatedAt }
        : goal
    ));
  }
  writeHub(workspaceRoot, hub);
  return { ok: true, task, hubPath: hubPath(workspaceRoot) };
}

function updateTask(workspaceRoot, payload = {}) {
  const taskId = String(payload.taskId || payload.id || '').trim();
  if (!taskId) {
    return { ok: false, message: 'taskId is required.' };
  }
  const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {};
  const hub = readHub(workspaceRoot);
  let updatedTask = null;
  hub.tasks = hub.tasks.map((task) => {
    if (task.id !== taskId) {
      return task;
    }
    updatedTask = {
      ...task,
      ...patch,
      metadata: patch.metadata && typeof patch.metadata === 'object'
        ? {
            ...(task.metadata && typeof task.metadata === 'object' ? task.metadata : {}),
            ...patch.metadata,
          }
        : task.metadata,
      updatedAt: nowIso(),
    };
    return updatedTask;
  });
  if (!updatedTask) {
    return { ok: false, message: 'Task not found.', taskId };
  }
  writeHub(workspaceRoot, hub);
  return { ok: true, task: updatedTask, hubPath: hubPath(workspaceRoot) };
}

function recordTaskRun(workspaceRoot, payload = {}) {
  const taskId = String(payload.taskId || '').trim();
  if (!taskId) {
    return { ok: false, message: 'taskId is required.' };
  }
  const runId = String(payload.runId || '').trim();
  const hub = readHub(workspaceRoot);
  const createdAt = nowIso();
  const link = {
    id: String(payload.id || makeEntityId('runlink', `${taskId}-${runId || payload.action || 'run'}`)),
    taskId,
    goalId: String(payload.goalId || '').trim(),
    runId,
    action: String(payload.action || 'orchestrate').trim().toLowerCase() || 'orchestrate',
    status: String(payload.status || 'running').trim().toLowerCase() || 'running',
    intentType: String(payload.intentType || 'launched-run').trim().toLowerCase() || 'launched-run',
    label: String(payload.label || '').trim(),
    summary: clipText(payload.summary || ''),
    workspaceRoot: String(workspaceRoot || '').trim(),
    targetWorkspaceRoot: String(payload.targetWorkspaceRoot || workspaceRoot || '').trim(),
    labRoot: String(payload.labRoot || '').trim(),
    ring: String(payload.ring || (payload.labRoot ? 'lab' : 'live')).trim().toLowerCase() || 'live',
    candidateId: String(payload.candidateId || '').trim(),
    promotionState: String(payload.promotionState || payload.ring || (payload.labRoot ? 'lab' : 'live')).trim().toLowerCase() || 'live',
    sliceId: String(payload.sliceId || '').trim(),
    sliceIndex: Number.isFinite(Number(payload.sliceIndex)) ? Number(payload.sliceIndex) : null,
    sliceTargetPaths: inferTargetPathsFromPayload(payload),
    createdAt,
    updatedAt: createdAt,
    metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
  };
  hub.runLinks = [link, ...hub.runLinks.filter((item) => item.id !== link.id && item.runId !== runId)].slice(0, 640);
  hub.tasks = hub.tasks.map((task) => (
    task.id === taskId
      ? {
          ...task,
          lastRunId: runId || task.lastRunId || '',
          status: link.status === 'running' ? 'running' : task.status,
          updatedAt: createdAt,
          metadata: {
            ...(task.metadata && typeof task.metadata === 'object' ? task.metadata : {}),
            ...(isSelfHostExpansionTask(task)
              ? {
                  selfHostExpansionConsumedAt: String(
                    task?.metadata?.selfHostExpansionConsumedAt
                    || createdAt,
                  ).trim(),
                  selfHostExpansionRunId: runId || String(task?.metadata?.selfHostExpansionRunId || '').trim(),
                  selfHostExpansionOutcome: link.status === 'running'
                    ? 'running'
                    : String(task?.metadata?.selfHostExpansionOutcome || '').trim().toLowerCase(),
                  selfHostExpansionOutcomeAt: link.status === 'running'
                    ? createdAt
                    : String(task?.metadata?.selfHostExpansionOutcomeAt || '').trim(),
                  selfHostExpansionOutcomeSummary: link.status === 'running'
                    ? clipText(payload.summary || link.summary || 'Bounded self-host follow-up launched.')
                    : String(task?.metadata?.selfHostExpansionOutcomeSummary || '').trim(),
                }
              : {}),
          },
        }
      : task
  ));
  if (link.goalId) {
    hub.goals = hub.goals.map((goal) => (
      goal.id === link.goalId
        ? { ...goal, lastRunId: runId || goal.lastRunId || '', updatedAt: createdAt }
        : goal
    ));
  }
  writeHub(workspaceRoot, hub);
  return { ok: true, runLink: link, hubPath: hubPath(workspaceRoot) };
}

function completeTaskRun(workspaceRoot, payload = {}) {
  const runId = String(payload.runId || '').trim();
  if (!runId) {
    return { ok: false, message: 'runId is required.' };
  }
  const hub = readHub(workspaceRoot);
  const nextStatus = String(payload.status || '').trim().toLowerCase() || 'unknown';
  const summary = clipText(payload.summary || '');
  const reviewSummary = payload.reviewSummary && typeof payload.reviewSummary === 'object' ? payload.reviewSummary : {};
  const updatedAt = nowIso();
  let updatedRunLink = null;
  hub.runLinks = hub.runLinks.map((link) => {
    if (String(link.runId || '').trim() !== runId) {
      return link;
    }
    updatedRunLink = {
      ...link,
      status: nextStatus,
      summary: summary || link.summary || '',
      updatedAt,
      metadata: {
        ...(link.metadata && typeof link.metadata === 'object' ? link.metadata : {}),
        reviewSummary,
      },
    };
    return updatedRunLink;
  });
  if (!updatedRunLink) {
    return { ok: false, message: 'Run link not found.', runId };
  }
  const nextTaskStatus = deriveTaskStatusFromRunStatus(nextStatus, reviewSummary);
  let updatedTask = null;
  hub.tasks = hub.tasks.map((task) => {
    if (String(task.id || '').trim() !== String(updatedRunLink.taskId || '').trim()) {
      return task;
    }
    const metadata = {
      ...(task.metadata && typeof task.metadata === 'object' ? task.metadata : {}),
      lastRunState: nextStatus,
      lastRunSummary: summary || String(task?.metadata?.lastRunSummary || '').trim(),
      lastRunCompletedAt: updatedAt,
      reviewPendingCount: Number(reviewSummary.pendingApprovalCount ?? reviewSummary.pending_approval_count ?? 0),
      requiresManualReview: reviewSummary.requiresManualReview === true || reviewSummary.requires_manual_review === true,
    };
    if (isSelfHostExpansionTask(task)) {
      metadata.selfHostExpansionConsumedAt = String(
        metadata.selfHostExpansionConsumedAt
        || updatedRunLink.createdAt
        || updatedAt,
      ).trim();
      metadata.selfHostExpansionRunId = runId;
      metadata.selfHostExpansionOutcome = nextStatus === 'pass'
        ? (metadata.requiresManualReview ? 'review' : 'pass')
        : nextStatus === 'running'
          ? 'running'
          : nextStatus === 'skipped'
            ? 'skipped'
            : 'fail';
      metadata.selfHostExpansionOutcomeAt = updatedAt;
      metadata.selfHostExpansionOutcomeSummary = summary || String(updatedRunLink.summary || '').trim();
    }
    updatedTask = {
      ...task,
      status: nextTaskStatus || task.status,
      updatedAt,
      metadata,
    };
    return updatedTask;
  });
  writeHub(workspaceRoot, hub);
  return {
    ok: true,
    runLink: updatedRunLink,
    task: updatedTask,
    selfHostExpansion: updatedTask && isSelfHostExpansionTask(updatedTask)
      ? {
          taskId: String(updatedTask.id || '').trim(),
          runId,
          outcome: String(updatedTask?.metadata?.selfHostExpansionOutcome || '').trim(),
          summary: String(updatedTask?.metadata?.selfHostExpansionOutcomeSummary || '').trim(),
        }
      : null,
    hubPath: hubPath(workspaceRoot),
  };
}

function syncRuntimeRuns(workspaceRoot, runtimeStatus = {}) {
  const hub = readHub(workspaceRoot);
  const byRunId = new Map(
    (Array.isArray(runtimeStatus?.latest) ? runtimeStatus.latest : [])
      .filter((item) => item && item.runId)
      .map((item) => [String(item.runId), item]),
  );

  let changed = false;
  const nextRunLinks = hub.runLinks.map((link) => {
    const runtimeRun = byRunId.get(String(link.runId || ''));
    if (!runtimeRun) {
      return link;
    }
    const nextStatus = String(runtimeRun.state || link.status || '').trim().toLowerCase() || link.status;
    const nextSummary = clipText(runtimeRun.blockedReason || runtimeRun.label || link.summary || '');
    if (nextStatus === link.status && nextSummary === link.summary) {
      return link;
    }
    changed = true;
    return {
      ...link,
      status: nextStatus,
      summary: nextSummary,
      updatedAt: nowIso(),
    };
  });

  if (changed) {
    const statusByRunId = new Map(nextRunLinks.map((item) => [String(item.runId || ''), item]));
    hub.runLinks = nextRunLinks;
    hub.tasks = hub.tasks.map((task) => {
      const linked = statusByRunId.get(String(task.lastRunId || ''));
      if (!linked) {
        return task;
      }
      return {
        ...task,
        status: linked.status === 'running' ? 'running' : linked.status === 'pass' ? 'completed' : linked.status === 'fail' ? 'needs-repair' : task.status,
        updatedAt: linked.updatedAt || task.updatedAt,
      };
    });
    writeHub(workspaceRoot, hub);
  }
  return hub;
}

function listRuns(workspaceRoot, payload = {}, runtimeStatus = {}) {
  const hub = syncRuntimeRuns(workspaceRoot, runtimeStatus);
  const limit = Math.max(1, Math.min(240, Number(payload.limit || 120)));
  const workspaceScope = normalizeWorkspaceScope({ workspaceRoot, ...payload });
  const runtimeByRunId = new Map(
    (Array.isArray(runtimeStatus?.latest) ? runtimeStatus.latest : [])
      .filter((item) => item && item.runId)
      .map((item) => [String(item.runId), item]),
  );
  let runs = hub.runLinks.map((link) => {
    const runtimeRun = runtimeByRunId.get(String(link.runId || '')) || {};
    return {
      ...link,
      runtimeState: runtimeRun.state || link.status,
      runtimeLabel: runtimeRun.label || link.label || '',
      artifactPaths: Array.isArray(runtimeRun.artifactPaths) ? runtimeRun.artifactPaths : [],
      trustSummary: runtimeRun.trustSummary || {},
      approvalRequests: runtimeRun.approvalRequests || [],
      reviewSummary: runtimeRun.reviewSummary || {},
      blockedReason: runtimeRun.blockedReason || '',
      startedAt: runtimeRun.startedAt || link.createdAt,
      endedAt: runtimeRun.endedAt || null,
    };
  });
  runs = runs.filter((run) => entityMatchesWorkspaceScope(run, workspaceScope));
  if (payload.taskId) {
    runs = runs.filter((run) => run.taskId === String(payload.taskId));
  }
  if (payload.goalId) {
    runs = runs.filter((run) => run.goalId === String(payload.goalId));
  }
  return {
    ok: true,
    runs: runs.slice(0, limit),
    count: runs.length,
    hubPath: hubPath(workspaceRoot),
  };
}

function listRecipes() {
  return {
    ok: true,
    recipes: DEFAULT_RECIPES.map((recipe) => ({ ...recipe })),
    count: DEFAULT_RECIPES.length,
  };
}

function buildDailyTaskSummary(taskHub = {}, options = {}) {
  const hub = taskHub && typeof taskHub === 'object' ? taskHub : {};
  const workspaceScope = normalizeWorkspaceScope(options);
  const tasks = Array.isArray(hub.tasks)
    ? hub.tasks.filter((task) => task && typeof task === 'object' && entityMatchesWorkspaceScope(task, workspaceScope))
    : [];
  const goals = Array.isArray(hub.goals)
    ? hub.goals.filter((goal) => goal && typeof goal === 'object' && entityMatchesWorkspaceScope(goal, workspaceScope))
    : [];
  const roadmapDay = String(options.roadmapDay || localDayKey(options.now || Date.now())).trim();
  const dailyTasks = tasks.filter((task) => isDailyFocusEntity(task));
  const dailyGoals = goals.filter((goal) => isDailyFocusEntity(goal));
  const focusCandidates = dailyTasks
    .filter((task) => isTaskUpdatedOnRoadmapDay(task, roadmapDay))
    .sort((left, right) => {
      const leftStatus = isClosedTaskStatus(left?.status) ? 1 : 0;
      const rightStatus = isClosedTaskStatus(right?.status) ? 1 : 0;
      if (leftStatus !== rightStatus) {
        return leftStatus - rightStatus;
      }
      return taskUpdateTimestamp(right) - taskUpdateTimestamp(left);
    });
  const focusTask = focusCandidates[0] || null;
  const focusGoal = focusTask
    ? goals.find((goal) => goal.id === focusTask.goalId) || null
    : dailyGoals
      .filter((goal) => String(goal?.metadata?.roadmapDay || '').trim() === roadmapDay || localDayKey(goal?.updatedAt || goal?.createdAt || options.now || Date.now()) === roadmapDay)
      .sort((left, right) => taskUpdateTimestamp(right) - taskUpdateTimestamp(left))[0] || null;
  const blockedRescopedTasks = tasks
    .filter((task) => isTaskUpdatedOnRoadmapDay(task, roadmapDay))
    .filter((task) => isBlockedOrRescopedTask(task))
    .sort((left, right) => taskUpdateTimestamp(right) - taskUpdateTimestamp(left));
  const focusSource = focusTask || focusGoal || {};
  const focusTitle = String(focusSource.title || focusSource.objective || '').trim();
  const focusStatus = String(focusTask?.status || focusGoal?.status || '').trim().toLowerCase();
  const status = focusTitle
    ? (blockedRescopedTasks.length > 0 ? 'warn' : 'ready')
    : (blockedRescopedTasks.length > 0 ? 'warn' : 'idle');
  const summary = focusTitle
    ? blockedRescopedTasks.length > 0
      ? `Today's focus is "${focusTitle}". ${blockedRescopedTasks.length} blocked or needs-rescope task(s) still need follow-up.`
      : `Today's focus is "${focusTitle}". No blocked or needs-rescope task is currently holding it.`
    : blockedRescopedTasks.length > 0
      ? `${blockedRescopedTasks.length} blocked or needs-rescope task(s) are recorded today, but no daily focus task is marked in the task hub.`
      : 'No daily focus task is recorded in the task hub yet.';

  return {
    ok: true,
    roadmapDay,
    status,
    summary,
    focusTask: focusTitle
      ? {
          taskId: String(focusTask?.id || focusGoal?.lastTaskId || '').trim(),
          goalId: String(focusTask?.goalId || focusGoal?.id || '').trim(),
          title: focusTitle,
          objective: String(focusTask?.objective || focusGoal?.objective || '').trim(),
          status: focusStatus,
          source: String(focusTask?.source || focusGoal?.source || '').trim(),
          updatedAt: String(focusTask?.updatedAt || focusGoal?.updatedAt || '').trim(),
          roadmapMonth: String(focusTask?.metadata?.roadmapMonth || focusGoal?.metadata?.roadmapMonth || '').trim(),
          roadmapDay: String(focusTask?.metadata?.roadmapDay || focusGoal?.metadata?.roadmapDay || roadmapDay).trim(),
        }
      : null,
    dailyTaskCount: dailyTasks.filter((task) => isTaskUpdatedOnRoadmapDay(task, roadmapDay)).length,
    blockedRescopedCount: blockedRescopedTasks.length,
    blockedRescopedTasks: blockedRescopedTasks.slice(0, 5).map((task) => ({
      taskId: String(task?.id || '').trim(),
      goalId: String(task?.goalId || '').trim(),
      title: String(task?.title || task?.objective || '').trim(),
      status: String(task?.status || '').trim().toLowerCase(),
      blockedBy: String(task?.metadata?.lastBlockedBy || '').trim().toLowerCase(),
      blockedReason: String(task?.metadata?.lastBlockedReason || '').trim(),
      updatedAt: String(task?.updatedAt || '').trim(),
    })),
  };
}

module.exports = {
  TASK_HUB_SCHEMA_VERSION,
  DEFAULT_RECIPES,
  buildDailyTaskSummary,
  completeTaskRun,
  createGoal,
  createGoalAndTask,
  createTask,
  engineBatTaskId,
  findGoal,
  findTaskByFollowupSignature,
  findTask,
  humanTitleFromPrompt,
  hubPath,
  inferIntentType,
  isActionablePrompt,
  listGoals,
  listRecipes,
  listRuns,
  listTasks,
  readHub,
  recordTaskRun,
  runWorkspaceHygiene,
  summarizeSelfHostExpansion,
  updateTask,
  updateGoal,
  entityMatchesWorkspaceScope,
};
