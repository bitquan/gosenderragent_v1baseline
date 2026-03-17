'use strict';

const {
  createGoal,
  createTask,
  findTaskByFollowupSignature,
  hubPath,
} = require('./task-hub');

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

function normalizeFollowups(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

function normalizeCandidate(value = {}) {
  const candidate = value && typeof value === 'object' ? value : {};
  return {
    ...candidate,
    id: String(candidate.id || '').trim(),
    kind: String(candidate.kind || '').trim().toLowerCase(),
    category: String(candidate.category || '').trim().toLowerCase(),
    title: String(candidate.title || '').trim(),
    objective: String(candidate.objective || '').trim(),
    summary: String(candidate.summary || '').trim(),
    source: String(candidate.source || '').trim(),
    riskClass: String(candidate.riskClass || 'medium').trim().toLowerCase() || 'medium',
    targetPaths: Array.isArray(candidate.targetPaths)
      ? candidate.targetPaths.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    capabilities: Array.isArray(candidate.capabilities)
      ? candidate.capabilities.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    acceptanceChecks: Array.isArray(candidate.acceptanceChecks)
      ? candidate.acceptanceChecks.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    metadata: candidate.metadata && typeof candidate.metadata === 'object' ? candidate.metadata : {},
  };
}

function dedupeById(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const id = String(item?.id || '').trim();
    if (!id || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

function summarizeSteps(steps = []) {
  return steps
    .slice(0, 3)
    .map((step) => String(step.title || step.objective || step.summary || '').trim())
    .filter(Boolean)
    .join(' -> ');
}

function chooseRecipeTitle(steps = []) {
  const categories = new Set(steps.map((step) => String(step.category || '').trim().toLowerCase()).filter(Boolean));
  const kinds = new Set(steps.map((step) => String(step.kind || '').trim().toLowerCase()).filter(Boolean));
  if (categories.has('docs-scout') || categories.has('docs-refresh')) {
    if (kinds.has('regression')) {
      return 'Docs-verified repair loop';
    }
    return 'Docs-guided revision loop';
  }
  if (kinds.has('revision') && kinds.has('regression')) {
    return 'Repair and regression loop';
  }
  if (kinds.has('regression')) {
    return 'Regression protection loop';
  }
  return 'Supervised follow-up loop';
}

function buildRecipePrompt(steps = []) {
  const prompts = steps
    .map((step) => String(step.objective || step.summary || step.title || '').trim())
    .filter(Boolean);
  if (prompts.length === 0) {
    return '';
  }
  return clipText(prompts.join(' Then '), 220);
}

function normalizeExecution(value = {}) {
  return value && typeof value === 'object' ? value : {};
}

function normalizeMemoryHints(value) {
  return value && typeof value === 'object' ? value : {};
}

function normalizeSelfHostExpansion(value) {
  const expansion = value && typeof value === 'object' ? value : {};
  return {
    eligible: expansion.eligible === true,
    status: String(expansion.status || '').trim().toLowerCase(),
    label: String(expansion.label || '').trim(),
    summary: String(expansion.summary || '').trim(),
    nextAction: String(expansion.nextAction || '').trim(),
    remainingCount: Math.max(0, Number(expansion.remainingCount || 0) || 0),
  };
}

function topMemoryPaths(memoryHints = {}) {
  return Array.isArray(memoryHints.topPaths)
    ? memoryHints.topPaths
      .map((item) => String(item?.value || item || '').trim())
      .filter(Boolean)
      .slice(0, 3)
    : [];
}

function inferFollowupRoute({ command = '', objective = '', targetPaths = [] } = {}) {
  const lower = String(objective || '').trim().toLowerCase();
  if (String(command || '').trim().toLowerCase() === 'retry-with-research') {
    return {
      requestedModelRole: 'engine',
      routeLaneId: 'research-docs',
      taskMode: 'research',
      autonomyDifficultyCeiling: 2,
      capabilities: ['research-docs', 'plan-reasoning'],
    };
  }
  if (/(review|summari[sz]e|inspect|validate|acceptance|blocker|read-only|read only|snapshot|compare)/.test(lower)) {
    return {
      requestedModelRole: 'engine',
      routeLaneId: /summari[sz]e|report|status/.test(lower) ? 'ops-summary' : 'review-verify',
      taskMode: /summari[sz]e|report|status/.test(lower) ? 'summarizer' : 'validator',
      autonomyDifficultyCeiling: 2,
      capabilities: /summari[sz]e|report|status/.test(lower) ? ['ops-summary', 'plan-reasoning'] : ['review-verify', 'plan-reasoning'],
    };
  }
  if (/(plan|research|investigate|analy[sz]e)/.test(lower) || targetPaths.length === 0) {
    return {
      requestedModelRole: 'engine',
      routeLaneId: 'plan-reasoning',
      taskMode: 'planner',
      autonomyDifficultyCeiling: 2,
      capabilities: ['plan-reasoning'],
    };
  }
  return {
    requestedModelRole: 'workspace',
    routeLaneId: String(command || '').trim().toLowerCase() === 'repair-loop' ? 'repair-fast' : 'code-main',
    taskMode: String(command || '').trim().toLowerCase() === 'repair-loop' ? 'repair' : 'coder',
    autonomyDifficultyCeiling: 3,
    capabilities: String(command || '').trim().toLowerCase() === 'repair-loop'
      ? ['repair-fast', 'review-verify']
      : ['chat-fast', 'code-main', 'review-verify'],
  };
}

function buildNextActionRecipe(execution = {}) {
  const normalizedExecution = normalizeExecution(execution);
  const memoryHints = normalizeMemoryHints(normalizedExecution.memoryHints);
  const nextAction = normalizedExecution.nextAction && typeof normalizedExecution.nextAction === 'object'
    ? normalizedExecution.nextAction
    : {};
  const command = String(nextAction.command || '').trim().toLowerCase();
  if (!['continue-run', 'retry-with-research', 'repair-loop'].includes(command)) {
    return null;
  }
  const objective = String(
    nextAction.prompt
    || nextAction.summary
    || memoryHints.recommendedPrompt
    || normalizedExecution.taskObjective?.summary
    || normalizedExecution.task
    || '',
  ).trim();
  if (!objective) {
    return null;
  }
  const objectiveToken = slugify(
    normalizedExecution.taskObjective?.summary || normalizedExecution.task || objective,
    'followup',
  );
  const riskClass = command === 'repair-loop' ? 'medium' : 'low';
  const changedPaths = Array.isArray(normalizedExecution.changedFiles)
    ? normalizedExecution.changedFiles
      .map((item) => String(item?.path || '').trim())
      .filter(Boolean)
      .slice(0, 3)
    : [];
  const targetPaths = changedPaths.length > 0 ? changedPaths : topMemoryPaths(memoryHints);
  const phaseId = String(nextAction.phaseId || memoryHints.topPhaseId || '').trim();
  const phaseLabel = String(nextAction.phaseLabel || memoryHints.topPhaseLabel || '').trim();
  const topRejectReason = String(memoryHints.topRejectReason || '').trim();
  const learnedFromMemory = nextAction.learned === true || Boolean(String(memoryHints.recommendedResponse || '').trim());
  const route = inferFollowupRoute({ command, objective, targetPaths });
  return {
    exists: true,
    id: `safe-recipe:engine-next-action:${command}:${objectiveToken}`,
    title: `Engine follow-up: ${String(nextAction.label || 'Next safe action').trim() || 'Next safe action'}`,
    summary: String(nextAction.summary || objective).trim(),
    prompt: objective,
    autoQueueEligible: riskClass === 'low' && nextAction.blocked !== true,
    reason: learnedFromMemory
      ? `Queued from learned next-action guidance${phaseLabel ? ` for ${phaseLabel}` : ''}.`
      : 'Queued from the shared next-action contract.',
    steps: [
      {
        id: `engine-next-action-${command}-${objectiveToken}`,
        kind: command === 'repair-loop' ? 'revision' : 'followup',
        category: 'engine-next-action',
        title: String(nextAction.label || 'Next safe action').trim() || 'Next safe action',
        objective,
        summary: String(nextAction.summary || objective).trim(),
        riskClass,
        targetPaths,
        capabilities: route.capabilities,
        metadata: {
          followupSignature: `engine-next-action:${command}:${objectiveToken}`,
          nextActionCommand: command,
          learnedFromMemory,
          phaseId,
          phaseLabel,
          topRejectReason,
          workspaceScopeRoot: String(normalizedExecution.targetWorkspaceRoot || normalizedExecution.workspaceRoot || '').trim(),
          requestedModelRole: route.requestedModelRole,
          routeLaneId: route.routeLaneId,
          taskMode: route.taskMode,
          autonomyDifficultyCeiling: route.autonomyDifficultyCeiling,
        },
      },
    ],
  };
}

function buildAutoFollowupPlan(execution = {}, context = {}) {
  const normalizedExecution = normalizeExecution(execution);
  const recipe = buildNextActionRecipe(normalizedExecution);
  const settings = context.settings && typeof context.settings === 'object' ? context.settings : {};
  const safeMode = context.safeMode && typeof context.safeMode === 'object' ? context.safeMode : {};
  const readiness = context.readiness && typeof context.readiness === 'object' ? context.readiness : {};
  const reviewBundle = normalizedExecution.reviewBundle && typeof normalizedExecution.reviewBundle === 'object'
    ? normalizedExecution.reviewBundle
    : {};
  const interruptRequest = normalizedExecution.interruptRequest && typeof normalizedExecution.interruptRequest === 'object'
    ? normalizedExecution.interruptRequest
    : {};
  const selfHostExpansion = normalizeSelfHostExpansion(
    context.selfHostExpansion
    || readiness.selfHostExpansion
    || normalizedExecution.selfHostExpansion,
  );
  const queueEnabled = settings.autoQueueTaskLoopFollowups !== false;
  const autoRunEnabled = settings.autoRunQueuedTaskLoopFollowups === true;
  const pendingApprovals = Math.max(0, Number(context.pendingApprovals || 0) || 0);
  const hardSafeMode = safeMode.active === true || safeMode.controller?.manualSafeMode === true;
  const watchOnly = safeMode.watchOnly === true;
  const requiresManualReview = interruptRequest.active === true
    || reviewBundle.requiresManualReview === true
    || Number(reviewBundle.pendingCount || 0) > 0
    || pendingApprovals > 0;
  const doNotWidenYetBecause = String(
    context.doNotWidenYetBecause
    || readiness.doNotWidenYetBecause
    || readiness.dailyQuotaProof?.doNotWidenYetBecause
    || '',
  ).trim();

  if (!recipe) {
    return {
      exists: false,
      recipe: null,
      shouldQueue: false,
      shouldAutoRun: false,
      queueEnabled,
      autoRunEnabled,
      reason: 'The current next safe action is not queueable as a bounded follow-up task yet.',
    };
  }

  if (!queueEnabled) {
    return {
      exists: true,
      recipe: { ...recipe, autoQueueEligible: false },
      shouldQueue: false,
      shouldAutoRun: false,
      queueEnabled,
      autoRunEnabled,
      doNotWidenYetBecause,
      reason: 'Automatic next-task queueing is turned off.',
    };
  }

  if (hardSafeMode || watchOnly) {
    return {
      exists: true,
      recipe: { ...recipe, autoQueueEligible: false },
      shouldQueue: false,
      shouldAutoRun: false,
      queueEnabled,
      autoRunEnabled,
      doNotWidenYetBecause,
      reason: hardSafeMode
        ? 'Safe mode is active, so keep the next bounded task operator-triggered.'
        : 'Watch mode is active, so keep the next bounded task operator-triggered.',
    };
  }

  if (requiresManualReview) {
    return {
      exists: true,
      recipe: { ...recipe, autoQueueEligible: false },
      shouldQueue: false,
      shouldAutoRun: false,
      queueEnabled,
      autoRunEnabled,
      doNotWidenYetBecause,
      reason: 'Review or approval is still holding the loop, so do not auto-queue the next task yet.',
    };
  }

  const shouldQueue = true;
  const allowSelfHostExpansion = selfHostExpansion.eligible === true
    && selfHostExpansion.remainingCount > 0
    && recipe.autoQueueEligible === true
    && ['continue-run', 'retry-with-research', 'repair-loop'].includes(String(recipe.steps?.[0]?.metadata?.nextActionCommand || '').trim().toLowerCase());
  const shouldAutoRun = autoRunEnabled && recipe.autoQueueEligible === true && (!doNotWidenYetBecause || allowSelfHostExpansion);
  const queuedRecipe = shouldAutoRun
    ? {
      ...recipe,
      selfHostExpansion: allowSelfHostExpansion,
      reason: allowSelfHostExpansion
        ? `Self-host proof is PROVEN, so the engine can auto-run one extra bounded self-host follow-up. ${selfHostExpansion.summary || ''}`.trim()
        : recipe.reason,
      steps: Array.isArray(recipe.steps)
        ? recipe.steps.map((step) => ({
          ...step,
          metadata: {
            ...(step.metadata && typeof step.metadata === 'object' ? step.metadata : {}),
            selfHostExpansion: allowSelfHostExpansion,
          },
        }))
        : recipe.steps,
    }
    : {
      ...recipe,
      selfHostExpansion: allowSelfHostExpansion,
      autoQueueEligible: false,
      reason: doNotWidenYetBecause
        ? allowSelfHostExpansion
          ? `Queued under the bounded self-host expansion lane. ${selfHostExpansion.summary || doNotWidenYetBecause}`
          : `Queued for review only. ${doNotWidenYetBecause}`
        : recipe.reason,
      steps: Array.isArray(recipe.steps)
        ? recipe.steps.map((step) => ({
          ...step,
          metadata: {
            ...(step.metadata && typeof step.metadata === 'object' ? step.metadata : {}),
            selfHostExpansion: allowSelfHostExpansion,
          },
        }))
        : recipe.steps,
    };

  return {
    exists: true,
    recipe: queuedRecipe,
    shouldQueue,
    shouldAutoRun,
    queueEnabled,
    autoRunEnabled,
    doNotWidenYetBecause,
    selfHostExpansion,
    reason: shouldAutoRun
      ? allowSelfHostExpansion
        ? 'Safe to queue and auto-run one extra bounded self-host follow-up task.'
        : 'Safe to queue and auto-run the next bounded follow-up task.'
      : doNotWidenYetBecause
        ? allowSelfHostExpansion
          ? `Queued under the bounded self-host expansion lane. ${selfHostExpansion.summary || doNotWidenYetBecause}`
          : `Queued for review only. ${doNotWidenYetBecause}`
        : 'Safe to queue the next bounded follow-up task, but auto-run is still disabled.',
  };
}

function buildFollowupRecipe(testBench = {}, context = {}) {
  const followups = normalizeFollowups(testBench.followups);
  const nextSafeAction = testBench.nextSafeAction && typeof testBench.nextSafeAction === 'object'
    ? testBench.nextSafeAction
    : {};
  const reviewer = context.reviewer && typeof context.reviewer === 'object' ? context.reviewer : {};
  const safeMode = context.safeMode && typeof context.safeMode === 'object' ? context.safeMode : {};
  const hardSafeMode = safeMode.active === true || safeMode.controller?.manualSafeMode === true;
  const pendingApprovals = Number(reviewer.pendingApprovalCount || 0) || 0;

  const normalizedFollowups = dedupeById(
    followups.map((item) => ({
      id: String(item.id || item.candidate?.id || '').trim(),
      kind: String(item.kind || item.candidate?.kind || '').trim().toLowerCase(),
      category: String(item.category || item.candidate?.category || '').trim().toLowerCase(),
      title: String(item.title || item.candidate?.title || '').trim(),
      summary: String(item.summary || item.candidate?.summary || '').trim(),
      riskClass: String(item.riskClass || item.candidate?.riskClass || 'medium').trim().toLowerCase() || 'medium',
      candidate: normalizeCandidate(item.candidate && typeof item.candidate === 'object' ? item.candidate : item),
    })),
  );

  const docsStep = normalizedFollowups.find((item) => ['docs-scout', 'docs-refresh'].includes(item.category)) || null;
  const revisionStep = normalizedFollowups.find((item) => item.kind === 'revision' && !['docs-scout', 'docs-refresh'].includes(item.category)) || null;
  const regressionStep = normalizedFollowups.find((item) => item.kind === 'regression') || null;
  const candidateSteps = dedupeById([
    docsStep ? docsStep.candidate : null,
    revisionStep ? revisionStep.candidate : null,
    regressionStep ? regressionStep.candidate : null,
  ].filter(Boolean)).slice(0, 3);

  if (candidateSteps.length === 0) {
    return {
      exists: false,
      autoQueueEligible: false,
      title: '',
      summary: '',
      reason: 'No safe supervised recipe is ready yet.',
      steps: [],
      prompt: '',
      actionLabel: '',
    };
  }

  const steps = candidateSteps.map((candidate, index) => ({
    ...candidate,
    stepIndex: index,
    stepLabel: index === 0 ? 'Start' : index === candidateSteps.length - 1 ? 'Finish' : `Step ${index + 1}`,
    followupSignature: String(candidate.metadata?.followupSignature || `safe-recipe:${candidate.id}`).trim(),
  }));
  const title = chooseRecipeTitle(steps);
  const summary = summarizeSteps(steps);
  const prompt = buildRecipePrompt(steps);
  const autoQueueEligible = !hardSafeMode
    && pendingApprovals === 0
    && steps.length > 0
    && ['low', 'medium'].includes(String(steps[0].riskClass || '').trim().toLowerCase());
  const reason = hardSafeMode
    ? 'Hard safe mode is active, so keep this recipe operator-triggered.'
    : pendingApprovals > 0
      ? 'Pending approvals should be cleared before queueing the supervised recipe.'
      : autoQueueEligible
        ? 'Safe to queue as a bounded supervised follow-up recipe.'
        : 'Review the steps manually before queueing this recipe.';
  const recipeId = `safe-recipe:${slugify(steps.map((step) => step.id).join('-'), 'followup')}`;

  return {
    exists: true,
    id: recipeId,
    title,
    summary,
    prompt,
    autoQueueEligible,
    reason,
    actionLabel: autoQueueEligible ? 'Queue supervised recipe' : 'Create supervised recipe',
    riskClass: steps.some((step) => step.riskClass === 'high') ? 'high' : steps.some((step) => step.riskClass === 'medium') ? 'medium' : 'low',
    primaryStepId: String(steps[0]?.id || '').trim(),
    steps,
    nextSafeActionId: String(nextSafeAction.candidate?.id || '').trim(),
  };
}

function buildQueuedRecipePayload(recipe = {}, context = {}) {
  const steps = Array.isArray(recipe.steps) ? recipe.steps.map((step) => normalizeCandidate(step)) : [];
  const workspaceRoot = String(context.workspaceRoot || '').trim();
  const targetWorkspaceRoot = String(context.targetWorkspaceRoot || workspaceRoot || '').trim();
  const labRoot = String(context.labRoot || '').trim();
  const threadId = String(context.threadId || '').trim();
  const changeSessionId = String(context.changeSessionId || '').trim();
  const ring = String(context.ring || (labRoot ? 'lab' : 'live')).trim().toLowerCase() || 'live';
  const promotionState = String(context.promotionState || ring).trim().toLowerCase() || ring;
  const recipeId = String(recipe.id || `safe-recipe:${slugify(recipe.title || recipe.summary || 'followup', 'followup')}`).trim();

  return {
    recipe: {
      exists: true,
      id: recipeId,
      title: String(recipe.title || 'Supervised follow-up loop').trim(),
      summary: String(recipe.summary || '').trim(),
      prompt: String(recipe.prompt || '').trim(),
      stepCount: steps.length,
      autoQueueEligible: recipe.autoQueueEligible === true,
      reason: String(recipe.reason || '').trim(),
    },
    goal: {
      title: String(recipe.title || 'Supervised follow-up loop').trim(),
      objective: String(recipe.prompt || recipe.summary || 'Queue the next safe supervised follow-up recipe.').trim(),
      source: 'followup-recipe',
      targetWorkspaceRoot,
      labRoot,
      threadId,
      changeSessionId,
      status: 'active',
      metadata: {
        recipeId,
        recipeKind: 'followup-supervised',
        recipeSummary: String(recipe.summary || '').trim(),
        selfHostExpansion: recipe.selfHostExpansion === true,
        workspaceScopeRoot: targetWorkspaceRoot,
      },
    },
    tasks: steps.map((step, index) => ({
      title: step.title || step.objective || `Recipe step ${index + 1}`,
      objective: step.objective || step.summary || step.title || `Complete recipe step ${index + 1}.`,
      source: step.source || 'followup-recipe',
      status: index === 0 ? 'ready' : 'queued',
      riskClass: step.riskClass || 'medium',
      targetPaths: step.targetPaths || [],
      capabilities: step.capabilities || [],
      acceptanceChecks: step.acceptanceChecks || [],
      budget: step.budget && typeof step.budget === 'object' ? step.budget : undefined,
      ring,
      promotionState: step.promotionState || promotionState,
      candidateId: step.id || '',
      targetWorkspaceRoot,
      labRoot,
      threadId,
      changeSessionId,
      metadata: {
        ...(step.metadata && typeof step.metadata === 'object' ? step.metadata : {}),
        recipeId,
        recipeTitle: String(recipe.title || 'Supervised follow-up loop').trim(),
        recipeStepIndex: index,
        recipeStepCount: steps.length,
        createdFromMonitor: true,
        createdFromRecipe: true,
        followupSignature: String(step.followupSignature || `recipe:${recipeId}:${step.id || index}`).trim(),
        selfHostExpansion: recipe.selfHostExpansion === true
          || (step.metadata && typeof step.metadata === 'object' && step.metadata.selfHostExpansion === true),
        workspaceScopeRoot: String(
          step.metadata?.workspaceScopeRoot
          || step.metadata?.workspace_scope_root
          || targetWorkspaceRoot,
        ).trim(),
        requestedModelRole: String(
          step.metadata?.requestedModelRole
          || step.metadata?.requested_model_role
          || 'engine',
        ).trim().toLowerCase() || 'engine',
        routeLaneId: String(
          step.metadata?.routeLaneId
          || step.metadata?.route_lane_id
          || 'plan-reasoning',
        ).trim().toLowerCase() || 'plan-reasoning',
        taskMode: String(
          step.metadata?.taskMode
          || step.metadata?.task_mode
          || 'planner',
        ).trim().toLowerCase() || 'planner',
        autonomyDifficultyCeiling: Math.max(
          1,
          Math.min(
            5,
            Number(
              step.metadata?.autonomyDifficultyCeiling
              || step.metadata?.autonomy_difficulty_ceiling
              || 2,
            ) || 2,
          ),
        ),
      },
    })),
  };
}

function queueFollowupRecipeTasks(workspaceRoot, recipe = {}, context = {}) {
  const root = String(workspaceRoot || '').trim();
  if (!root) {
    return { ok: false, message: 'workspaceRoot is required.' };
  }
  if (recipe.exists !== true || !Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    return { ok: false, message: 'A supervised follow-up recipe is required.' };
  }
  const queued = buildQueuedRecipePayload(recipe, {
    workspaceRoot: root,
    targetWorkspaceRoot: context.targetWorkspaceRoot || root,
    labRoot: context.labRoot || '',
    threadId: context.threadId || '',
    changeSessionId: context.changeSessionId || '',
    ring: context.ring || '',
    promotionState: context.promotionState || '',
  });
  const existingTasks = queued.tasks
    .map((task) => findTaskByFollowupSignature(root, task.metadata?.followupSignature || ''))
    .filter(Boolean);
  if (existingTasks.length === queued.tasks.length) {
    return {
      ok: true,
      deduped: true,
      recipe: queued.recipe,
      goal: null,
      tasks: existingTasks,
      existingTasks,
      createdTasks: [],
      createdCount: 0,
      hubPath: hubPath(root),
      message: 'This supervised recipe is already queued.',
    };
  }
  const goalResult = createGoal(root, queued.goal);
  const createdTasks = [];
  const resolvedTasks = queued.tasks.map((task) => {
    const existingTask = findTaskByFollowupSignature(root, task.metadata?.followupSignature || '');
    if (existingTask) {
      return existingTask;
    }
    const createdTask = createTask(root, {
      ...task,
      goalId: goalResult.goal?.id || '',
    }).task;
    if (createdTask) {
      createdTasks.push(createdTask);
    }
    return createdTask;
  }).filter(Boolean);
  return {
    ok: true,
    deduped: false,
    recipe: queued.recipe,
    goal: goalResult.goal || null,
    tasks: resolvedTasks,
    existingTasks,
    createdTasks,
    createdCount: createdTasks.length,
    hubPath: hubPath(root),
  };
}

module.exports = {
  buildAutoFollowupPlan,
  buildFollowupRecipe,
  buildNextActionRecipe,
  buildQueuedRecipePayload,
  queueFollowupRecipeTasks,
};
