'use strict';

const {
  getChatModeConfig,
  inferChatModeRouting,
  resolveChatModeValue,
} = require('./engine-contract');

function clipText(value, maxLength = 220) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}...` : text;
}

function readArea(report, key) {
  return report?.areas?.[key] && typeof report.areas[key] === 'object'
    ? report.areas[key]
    : {};
}

function buildLiveStateSummary(report = {}) {
  const roadmap = readArea(report, 'roadmap');
  const acceptance = readArea(report, 'acceptance');
  const trust = readArea(report, 'trust');
  const runs = readArea(report, 'runs');
  const models = readArea(report, 'models');
  const autonomy = readArea(report, 'autonomy');
  const latestRun = runs.latestRun && typeof runs.latestRun === 'object' ? runs.latestRun : {};
  const lines = [
    `Workspace: ${report.workspaceRoot || ''}`,
    `Roadmap: ${String(roadmap.status || '').toUpperCase()} | ${clipText(roadmap.summary || '', 180)}`,
    `Current phase: ${String(roadmap.currentPhase?.label || '').trim() || 'unknown'}`,
    `Acceptance: ${String(acceptance.status || '').toUpperCase()} | ${clipText(acceptance.summary || '', 160)}`,
    `Trust: ${String(trust.status || '').toUpperCase()} | ${clipText(trust.summary || '', 160)}`,
  ];
  if (latestRun.task || latestRun.summary) {
    lines.push(
      `Latest run: ${String(latestRun.status || '').toUpperCase() || 'UNKNOWN'} | ${clipText(latestRun.task || latestRun.summary || '', 160)}`,
    );
  }
  if (latestRun.reviewSummary?.summary) {
    lines.push(`Latest review: ${clipText(latestRun.reviewSummary.summary, 160)}`);
  }
  if (roadmap.recommendedNextSafeAction) {
    lines.push(`Next safe action: ${clipText(roadmap.recommendedNextSafeAction, 180)}`);
  }
  if (models.summary) {
    lines.push(`Model routing: ${clipText(models.summary, 180)}`);
  }
  if (autonomy.nextSafeAction) {
    lines.push(`Autonomy next step: ${clipText(autonomy.nextSafeAction, 180)}`);
  }
  return lines.join('\n');
}

function shouldUseGroundedAskReply(userPrompt = '') {
  const lower = String(userPrompt || '').trim().toLowerCase();
  if (!lower) {
    return false;
  }
  if (/(why.*current run.*blocked|current run.*blocked|what.*blocking.*current run)/.test(lower)) {
    return true;
  }
  if (/(what('?s| is) next|next safe action)/.test(lower)) {
    return true;
  }
  if (/\b(status|summary|health)\b/.test(lower)) {
    return true;
  }
  if (/(model routing|which model|which lane|which profile|manager|worker)/.test(lower)) {
    return true;
  }
  if (/(latest run|what changed|what happened)/.test(lower) && /(run|repo|workspace|current|latest)/.test(lower)) {
    return true;
  }
  return /(acceptance|trust|roadmap)/.test(lower) && /(status|summary|state|current|latest)/.test(lower);
}

function buildGroundedChatPrompt({ chatMode = 'ask', userPrompt = '', report = {}, built = {}, modeConfig = null } = {}) {
  const liveState = buildLiveStateSummary(report);
  const resolvedChatMode = resolveChatModeValue(chatMode);
  const routeState = inferChatModeRouting(resolvedChatMode, userPrompt);
  const effectiveMode = routeState.effectiveChatMode || resolvedChatMode;
  const effectiveConfig = getChatModeConfig(effectiveMode);
  const resolvedModeConfig = modeConfig || getChatModeConfig(resolvedChatMode);
  const routeLine = `Resolved route: ${built.routing?.laneLabel || built.request?.laneLabel || 'Unknown lane'} | ${built.request?.taskMode || routeState.suggestedTaskMode || 'unknown'} | ${built.request?.modelRole || 'unknown'} role | ${built.request?.modelDisplayName || built.request?.modelProfileId || built.request?.baseModel || 'unresolved'}${built.request?.providerSource ? ` via ${built.request.providerSource}` : ''}`;
  const modeSpecificInstruction = effectiveMode === 'plan'
    ? 'Give a concrete, bounded plan for the next safest slice. Include the goal, the safest implementation steps, the checks to rerun, and one recommendation for what to avoid widening right now.'
    : 'Answer directly from the live repo state. If something is not actually blocked, say that plainly. Do not speculate about upstream servers or generic causes unless the live state says so.';
  return [
    'You are the GoSenderr terminal operator surface for this local repository.',
    'Speak like a strong human collaborator: warm, grounded, direct, and honest.',
    `Mode: ${resolvedModeConfig.label}`,
    resolvedChatMode !== effectiveMode ? `Auto resolved to: ${effectiveConfig.label}` : '',
    `Mode guidance: ${effectiveConfig.instruction || resolvedModeConfig.instruction || ''}`.trim(),
    modeSpecificInstruction,
    'Use the live repo state below as the source of truth. If the question depends on missing evidence, say so briefly instead of guessing.',
    '',
    'Live repo state:',
    liveState,
    routeLine,
    '',
    `User request: ${String(userPrompt || '').trim()}`,
    '',
    'Answer with short paragraphs first. Use lists only if they genuinely help.',
  ].filter(Boolean).join('\n');
}

function buildDirectAskReply(userPrompt = '', report = {}) {
  const lower = String(userPrompt || '').trim().toLowerCase();
  const latestRun = readArea(report, 'runs').latestRun && typeof readArea(report, 'runs').latestRun === 'object'
    ? readArea(report, 'runs').latestRun
    : {};
  const roadmap = readArea(report, 'roadmap');
  const acceptance = readArea(report, 'acceptance');
  const models = readArea(report, 'models');
  const trust = readArea(report, 'trust');
  const reviewSummary = String(latestRun.reviewSummary?.summary || '').trim();
  const latestTask = String(latestRun.task || '').trim();
  const latestStatus = String(latestRun.status || latestRun.runState || '').trim().toLowerCase();

  if (/(why.*current run.*blocked|current run.*blocked|what.*blocking.*current run)/.test(lower)) {
    if (!['fail', 'blocked', 'review', 'cancelled'].includes(latestStatus)) {
      return [
        'The latest recorded run is not blocked right now.',
        latestTask
          ? `It finished as ${latestStatus || 'pass'} on "${latestTask}".`
          : `It finished as ${latestStatus || 'pass'}.`,
        reviewSummary ? `Review says: ${reviewSummary}` : '',
        roadmap.recommendedNextSafeAction ? `The next safe move is: ${clipText(roadmap.recommendedNextSafeAction, 180)}` : '',
      ].filter(Boolean).join(' ');
    }
    return [
      latestTask ? `The current run is blocked on "${latestTask}".` : 'The current run is blocked.',
      reviewSummary ? `The clearest signal I have is: ${reviewSummary}` : '',
      roadmap.recommendedNextSafeAction ? `The next safe move is: ${clipText(roadmap.recommendedNextSafeAction, 180)}` : '',
    ].filter(Boolean).join(' ');
  }

  if (/(model routing|which model|which lane|which profile|manager|worker)/.test(lower)) {
    return [
      models.summary ? `The current routing picture is: ${clipText(models.summary, 220)}` : '',
      acceptance.nextSafeAction ? `Acceptance is green, so the next safe move is: ${clipText(acceptance.nextSafeAction, 180)}` : '',
    ].filter(Boolean).join(' ');
  }

  if (/(what('?s| is) next|next safe action)/.test(lower) && roadmap.recommendedNextSafeAction) {
    return `The next safe action is: ${clipText(roadmap.recommendedNextSafeAction, 220)}`;
  }

  const parts = [];
  if (roadmap.summary) {
    parts.push(`From the live repo state, the workspace looks ${String(roadmap.status || '').trim().toLowerCase() || 'active'} right now: ${clipText(roadmap.summary, 180)}`);
  }
  if (latestTask) {
    parts.push(`The latest run I can see is "${latestTask}"${latestStatus ? `, and it settled as ${latestStatus}` : ''}.`);
  }
  if (reviewSummary) {
    parts.push(`Review is currently saying: ${reviewSummary}`);
  }
  if (trust.summary) {
    parts.push(`Trust is: ${clipText(trust.summary, 140)}`);
  }
  if (roadmap.recommendedNextSafeAction) {
    parts.push(`The safest next move is: ${clipText(roadmap.recommendedNextSafeAction, 180)}`);
  }
  if (models.summary && /(route|model|lane|provider|manager|worker|engine)/.test(lower)) {
    parts.push(`Routing context: ${clipText(models.summary, 180)}`);
  }
  return parts.join(' ');
}

function buildDirectPlanReply(userPrompt = '', report = {}) {
  const prompt = String(userPrompt || '').trim();
  const lower = prompt.toLowerCase();
  const roadmap = readArea(report, 'roadmap');
  const acceptance = readArea(report, 'acceptance');
  const trust = readArea(report, 'trust');
  const latestRun = readArea(report, 'runs').latestRun && typeof readArea(report, 'runs').latestRun === 'object'
    ? readArea(report, 'runs').latestRun
    : {};

  let goal = `Move "${prompt}" forward without breaking the current baseline.`;
  const steps = [];
  const checks = [];
  let avoid = 'Avoid widening the slice beyond one shared source of truth plus the exact downstream consumers that depend on it.';

  if (/(routing|lane|model|profile|chat mode|mode drift)/.test(lower)) {
    goal = 'Tighten routing so terminal, VS Code, and desktop all resolve the same chat mode, lane, task mode, and model role.';
    steps.push('Start at the shared routing source first, not the UI. Compare the current lane and mode truth in `core/engine-contract.js` with the backend/runtime and host bridges that consume it.');
    steps.push('Fix one drift at the source, then update only the terminal, VS Code companion, and desktop consumers that still mirror stale routing assumptions.');
    steps.push('Verify the specific user-facing path that motivated the slice, especially Ask/Plan/Edit/Agent selection and the chosen model role for the affected lane.');
    checks.push('`node --test .\\tests\\engine-contract.test.js .\\tests\\engine-cli.test.js .\\tests\\vscode-companion-extension.test.js .\\tests\\runtime-operator-execution.test.js`');
    checks.push('`npm run engine:acceptance -- --full-self-host`');
    checks.push('`npm run engine:cli -- status --area roadmap`');
    avoid = 'Avoid changing desktop-only settings or per-lane overrides first, because that hides routing drift instead of fixing it.';
  } else if (/(acceptance|self-host|baseline|readiness)/.test(lower)) {
    goal = 'Close the acceptance/readiness gap at the canonical engine layer before touching surface-specific logic.';
    steps.push('Reproduce the red path with the exact acceptance or readiness command that is disagreeing with the other surfaces.');
    steps.push('Trace that signal back to the shared report or task-hub truth, then fix the stale handoff instead of adding another summary layer.');
    steps.push('Re-run acceptance, roadmap, and terminal status together to prove they agree on the same outcome.');
    checks.push('`npm run engine:acceptance -- --full-self-host`');
    checks.push('`npm run system:check -- --area roadmap`');
    checks.push('`npm run engine:cli -- doctor`');
  } else if (/(git|branch|commit|push|pull)/.test(lower)) {
    goal = 'Keep Git workflow terminal-first and make desktop/VS Code consume the same Git truth.';
    steps.push('Inspect the shared Git service output first so branch, dirty state, and staged file truth are correct before changing any surface UI.');
    steps.push('Fix the terminal workflow behavior first, then verify the desktop Git route and VS Code summary card are only presenting the same state.');
    steps.push('Re-test a real branch/status/commit path instead of only checking that the UI renders.');
    checks.push('`npm run engine:cli -- git status`');
    checks.push('`node --test .\\tests\\git-service.test.js .\\tests\\git-bridge.test.js .\\tests\\ui-shell.test.js .\\tests\\vscode-companion-extension.test.js`');
  } else {
    steps.push('Restate the goal as one bounded slice that fits the current acceptance and trust envelope.');
    steps.push('Change the shared engine or runtime contract first, then update the smallest set of downstream consumers that depend on it.');
    steps.push('Validate the exact path you changed with focused tests before re-running the broader engine acceptance bundle.');
    checks.push('`npm run engine:acceptance -- --full-self-host`');
    checks.push('`npm run system:check -- --area roadmap`');
  }

  if (acceptance.summary) {
    steps.unshift(`Keep the current acceptance truth intact while you work: ${clipText(acceptance.summary, 180)}`);
  }
  if (trust.summary) {
    steps.push(`Use the current trust envelope as a guardrail: ${clipText(trust.summary, 160)}`);
  }
  if (latestRun.task) {
    steps.push(`Use the latest recorded run as the first concrete reference point: "${clipText(latestRun.task, 140)}".`);
  }

  const nextSafeAction = String(roadmap.recommendedNextSafeAction || acceptance.nextSafeAction || '').trim();

  return [
    `Here’s the safest next slice for "${prompt}".`,
    '',
    `Goal: ${goal}`,
    '',
    'Plan:',
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    'Checks:',
    ...checks.map((check) => `- ${check}`),
    '',
    `Avoid: ${avoid}`,
    nextSafeAction ? `Next safe action after this slice: ${clipText(nextSafeAction, 200)}` : '',
  ].filter(Boolean).join('\n');
}

function buildGroundedModeReply({ chatMode = 'ask', userPrompt = '', report = {} } = {}) {
  const mode = resolveChatModeValue(chatMode);
  const routeState = inferChatModeRouting(mode, userPrompt);
  const effectiveMode = routeState.effectiveChatMode || mode;
  const prompt = String(userPrompt || '').trim()
    || (effectiveMode === 'plan'
      ? 'Plan the safest next bounded slice for the current workspace.'
      : 'What should I know about the current workspace right now?');
  return effectiveMode === 'plan'
    ? buildDirectPlanReply(prompt, report)
    : buildDirectAskReply(prompt, report);
}

function buildGroundedReplyView({ chatMode = 'ask', userPrompt = '', report = {} } = {}) {
  const mode = resolveChatModeValue(chatMode);
  const routeState = inferChatModeRouting(mode, userPrompt);
  const effectiveMode = routeState.effectiveChatMode || mode;
  const reply = buildGroundedModeReply({ chatMode: mode, userPrompt, report });
  const title = effectiveMode === 'plan' ? 'Grounded plan' : 'Grounded reply';
  return {
    label: title,
    meta: [
      mode === 'auto' ? `Auto resolved to ${getChatModeConfig(effectiveMode).label}` : '',
      clipText(reply, 180),
    ].filter(Boolean).join(' - '),
    reply,
    chatMode: mode,
    effectiveChatMode: effectiveMode,
  };
}

module.exports = {
  buildDirectAskReply,
  buildDirectPlanReply,
  buildGroundedChatPrompt,
  buildGroundedModeReply,
  buildGroundedReplyView,
  buildLiveStateSummary,
  clipText,
  shouldUseGroundedAskReply,
};
