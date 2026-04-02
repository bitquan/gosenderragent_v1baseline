'use strict';

const { buildCapabilityDescriptor } = require('./capability-status');
const { buildDailyTaskSummary, summarizeSelfHostExpansion, entityMatchesWorkspaceScope } = require('./task-hub');

function withCapabilityDescriptor(payload = {}) {
  return {
    ...payload,
    ...buildCapabilityDescriptor(payload),
  };
}

const ROADMAP_MONTHS = Object.freeze([
  {
    id: 'month-1-engine-baseline',
    number: 1,
    label: 'Month 1: Engine self-dev and self-awareness baseline',
    layer: 'Engine self-dev and self-awareness baseline',
    weight: 18,
  },
  {
    id: 'month-2-gse1-engine-brain',
    number: 2,
    label: 'Month 2: GSE-1 engine brain',
    layer: 'GSE-1 engine brain',
    weight: 12,
  },
  {
    id: 'month-3-gs-dev1-hardening',
    number: 3,
    label: 'Month 3: GS-Dev-1 workbench hardening',
    layer: 'GS-Dev-1 workbench hardening',
    weight: 10,
  },
  {
    id: 'month-4-autonomy-control-plane',
    number: 4,
    label: 'Month 4: Autonomy control plane',
    layer: 'Autonomy control plane',
    weight: 10,
  },
  {
    id: 'month-5-self-improvement-learning-loop',
    number: 5,
    label: 'Month 5: Self-improvement and learning loop',
    layer: 'Self-improvement and learning loop',
    weight: 10,
  },
  {
    id: 'month-6-trust-review-benchmark-gates',
    number: 6,
    label: 'Month 6: Trust, review, benchmark, and hard gates',
    layer: 'Trust, review, benchmark, and hard gates',
    weight: 10,
  },
  {
    id: 'month-7-promotion-foundry-lifecycle',
    number: 7,
    label: 'Month 7: Promotion, foundry, and custom-variant lifecycle',
    layer: 'Promotion, foundry, and custom-variant lifecycle',
    weight: 8,
  },
  {
    id: 'month-8-builder-core',
    number: 8,
    label: 'Month 8: Software builder core for apps and websites',
    layer: 'Software builder core for apps and websites',
    weight: 7,
  },
  {
    id: 'month-9-builder-delivery',
    number: 9,
    label: 'Month 9: Software builder delivery and templates',
    layer: 'Software builder delivery and templates',
    weight: 6,
  },
  {
    id: 'month-10-release-update-ops',
    number: 10,
    label: 'Month 10: Release, update, rollback, and deployment ops',
    layer: 'Release, update, rollback, and deployment ops',
    weight: 4,
  },
  {
    id: 'month-11-local-training-orchestration',
    number: 11,
    label: 'Month 11: Local training orchestration on trusted exports',
    layer: 'Local training orchestration on trusted exports',
    weight: 3,
  },
  {
    id: 'month-12-supervised-autonomy-convergence',
    number: 12,
    label: 'Month 12: Supervised-autonomy convergence',
    layer: 'Supervised-autonomy convergence',
    weight: 2,
  },
]);

const ROADMAP_PHASES = Object.freeze([
  {
    id: 'phase-1-safe-engine-core',
    number: 1,
    label: 'Phase 1: Safe Engine Core',
    summary: 'Make the desktop and companion share one safe coding loop with clear review, recovery, and next-step guidance.',
    monthNumbers: [1, 2],
  },
  {
    id: 'phase-2-assisted-coding-parity',
    number: 2,
    label: 'Phase 2: Assisted Coding Parity',
    summary: 'Make desktop and VS Code parity real for the core coding experience without widening into a parallel operator stack.',
    monthNumbers: [3, 4],
  },
  {
    id: 'phase-3-memory-guided-supervision',
    number: 3,
    label: 'Phase 3: Memory-Guided Supervision',
    summary: 'Use shared run outcomes, review rejects, repair history, and model-fit signals to make the engine safer and smarter over time.',
    monthNumbers: [5, 6],
  },
  {
    id: 'phase-4-builder-and-model-lifecycle',
    number: 4,
    label: 'Phase 4: Builder And Model Lifecycle',
    summary: 'Expand from the safe coding loop into bounded builder work and benchmark-backed model lifecycle controls.',
    monthNumbers: [7, 8, 9],
  },
  {
    id: 'phase-5-release-training-and-convergence',
    number: 5,
    label: 'Phase 5: Release, Training, And Convergence',
    summary: 'Converge coding, review, learning, builder, release, and model improvement into one supervised system.',
    monthNumbers: [10, 11, 12],
  },
]);

function clipText(value, maxLength = 180) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}...` : text;
}

function shortText(value, maxLength = 180) {
  return clipText(value, maxLength);
}

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function isReadyLike(status) {
  return ['ready', 'pass', 'green', 'open', 'strong'].includes(normalizeStatus(status));
}

function isBlockedLike(status) {
  return ['blocked', 'fail', 'failed', 'needs-revision', 'red'].includes(normalizeStatus(status));
}

function maturityStatus(percent) {
  if (percent >= 85) {
    return 'strong';
  }
  if (percent >= 65) {
    return 'advancing';
  }
  if (percent >= 40) {
    return 'warming-up';
  }
  return 'early';
}

function countBoundedTasks(taskHub = {}) {
  const tasks = Array.isArray(taskHub.tasks) ? taskHub.tasks : [];
  return tasks.filter((task) => Array.isArray(task?.slices) && task.slices.length > 0).length;
}

function asArrayCount(value) {
  return Array.isArray(value) ? value.length : 0;
}

function numericValue(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
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

function isClosedTaskStatus(status = '') {
  return ['completed', 'cancelled', 'done', 'archived'].includes(String(status || '').trim().toLowerCase());
}

function buildSelfHostProofSignals(acceptance = {}) {
  const report = acceptance?.report && typeof acceptance.report === 'object'
    ? acceptance.report
    : (acceptance && typeof acceptance === 'object' ? acceptance : {});
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const selfHostChecks = checks.filter((check) => /^self-host-/.test(String(check?.id || '').trim().toLowerCase()));
  const failing = selfHostChecks.filter((check) => normalizeStatus(check?.status) === 'fail');
  const passing = selfHostChecks.filter((check) => normalizeStatus(check?.status) === 'pass');
  const smokeCheck = selfHostChecks.find((check) => String(check?.id || '').trim().toLowerCase() === 'self-host-smoke') || null;
  if (selfHostChecks.length === 0) {
    return withCapabilityDescriptor({
      exists: false,
      status: acceptance?.exists ? 'warn' : 'idle',
      label: acceptance?.exists ? 'PARTIAL' : 'NOT RUN',
      proven: false,
      partial: acceptance?.exists === true,
      blocked: false,
      summary: acceptance?.exists
        ? 'No self-host proof checks are recorded in the latest acceptance bundle yet.'
        : 'No self-host proof is recorded yet.',
      nextAction: 'Run npm run engine:acceptance -- --full-self-host before widening self-work.',
      checkCount: 0,
      passedCount: 0,
      smokeRecorded: false,
    });
  }
  if (failing.length > 0) {
    return withCapabilityDescriptor({
      exists: true,
      status: 'fail',
      label: 'BLOCKED',
      proven: false,
      partial: false,
      blocked: true,
      summary: `${failing.length}/${selfHostChecks.length} self-host proof check(s) failed.`,
      nextAction: shortText(
        report?.nextAction
        || failing[0]?.summary
        || 'Repair the failing self-host proof and rerun the full self-host acceptance suite.',
        180,
      ),
      checkCount: selfHostChecks.length,
      passedCount: passing.length,
      smokeRecorded: Boolean(smokeCheck),
    });
  }
  if (!smokeCheck || normalizeStatus(smokeCheck?.status) !== 'pass') {
    return withCapabilityDescriptor({
      exists: true,
      status: 'warn',
      label: 'PARTIAL',
      proven: false,
      partial: true,
      blocked: false,
      summary: `Self-host bootstrap/tests passed (${passing.length}/${selfHostChecks.length}), but smoke proof is still missing or not clean.`,
      nextAction: 'Run npm run engine:acceptance -- --full-self-host to add clean smoke proof before widening self-work.',
      checkCount: selfHostChecks.length,
      passedCount: passing.length,
      smokeRecorded: Boolean(smokeCheck),
    });
  }
  return withCapabilityDescriptor({
    exists: true,
    status: 'pass',
    label: 'PROVEN',
    proven: true,
    partial: false,
    blocked: false,
    summary: `Self-host proof passed. ${passing.length}/${selfHostChecks.length} self-host check(s) succeeded, including smoke.`,
    nextAction: 'Keep the next self-host slice bounded and supervised, then rerun the same proof bundle after meaningful self-work.',
    checkCount: selfHostChecks.length,
    passedCount: passing.length,
    smokeRecorded: true,
  });
}

const SELF_IMPROVEMENT_SAFE_STATUSES = new Set(['succeeded', 'success', 'pass', 'passed', 'review']);

function buildOperatorBaselineAcceptanceSignals(acceptance = {}, selfHostProof = {}) {
  const report = acceptance?.report && typeof acceptance.report === 'object'
    ? acceptance.report
    : (acceptance && typeof acceptance === 'object' ? acceptance : {});
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const overallStatus = normalizeStatus(report.overallStatus || acceptance?.overallStatus);
  const testsCheck = checks.find((check) => String(check?.id || '').trim().toLowerCase() === 'tests') || null;
  const uiSmokeCheck = checks.find((check) => ['smoke-ui', 'ui-smoke', 'smoke_ui'].includes(String(check?.id || '').trim().toLowerCase())) || null;
  const baselineFailing = [testsCheck, uiSmokeCheck].filter((check) => normalizeStatus(check?.status) === 'fail');
  const testsPassed = normalizeStatus(testsCheck?.status) === 'pass';
  const uiSmokePassed = normalizeStatus(uiSmokeCheck?.status) === 'pass';
  if (!checks.length && !report.summary && !acceptance?.exists) {
    return withCapabilityDescriptor({
      exists: false,
      status: 'idle',
      label: 'NOT RUN',
      proven: false,
      blocked: false,
      partial: false,
      summary: 'No operator baseline acceptance bundle is recorded yet.',
      nextAction: 'Run the operator baseline acceptance path before widening beyond the current usable baseline.',
    });
  }
  if (overallStatus === 'pass') {
    return withCapabilityDescriptor({
      exists: true,
      status: 'pass',
      label: 'PROVEN',
      proven: true,
      blocked: false,
      partial: false,
      summary: shortText(report.summary || 'Operator baseline acceptance passed cleanly.'),
      nextAction: 'Keep the next slice bounded, then rerun the same baseline acceptance bundle after meaningful changes.',
    });
  }
  if (baselineFailing.length > 0 || selfHostProof.blocked === true) {
    return withCapabilityDescriptor({
      exists: true,
      status: 'fail',
      label: 'BLOCKED',
      proven: false,
      blocked: true,
      partial: false,
      summary: shortText(
        baselineFailing[0]?.summary
        || selfHostProof.summary
        || report.summary
        || 'Operator baseline acceptance still has a blocking failure.',
      ),
      nextAction: shortText(
        report.nextAction
        || baselineFailing[0]?.summary
        || selfHostProof.nextAction
        || 'Repair the failing baseline checks and rerun the operator baseline acceptance path.',
      ),
    });
  }
  if (testsPassed && uiSmokePassed && selfHostProof.proven === true) {
    return withCapabilityDescriptor({
      exists: true,
      status: 'pass',
      label: 'PROVEN',
      proven: true,
      blocked: false,
      partial: false,
      summary: 'Operator baseline acceptance is proven: tests, UI smoke, and self-host proof are all green.',
      nextAction: 'Keep the next slice bounded, then rerun the same operator baseline acceptance path after meaningful changes.',
    });
  }
  return withCapabilityDescriptor({
    exists: true,
    status: 'warn',
    label: 'PARTIAL',
    proven: false,
    blocked: false,
    partial: true,
    summary: shortText(
      report.summary
      || 'Operator baseline acceptance is partially recorded, but the core tests/UI/self-host proof are not all green together yet.',
    ),
    nextAction: shortText(
      report.nextAction
      || 'Finish the operator baseline acceptance path so tests, UI smoke, and self-host proof are all green together.',
    ),
  });
}

function buildSelfImprovementProofSignals(summary = {}) {
  const payload = summary && typeof summary === 'object' ? summary : {};
  const lastExecution = payload.lastExecution && typeof payload.lastExecution === 'object' ? payload.lastExecution : {};
  const lastStatus = normalizeStatus(lastExecution.status);
  const preparedTaskCount = numericValue(payload.preparedTaskCount, 0);
  const historyCount = numericValue(payload.historyCount, 0);
  const safeExecutionCount = numericValue(payload.safeExecutionCount, 0);
  if (['fail', 'failed', 'blocked', 'needs-repair', 'cancelled'].includes(lastStatus)) {
    return withCapabilityDescriptor({
      exists: true,
      status: 'fail',
      label: 'BLOCKED',
      proven: false,
      blocked: true,
      partial: false,
      summary: shortText(payload.summary || 'The latest supervised self-improvement run still needs repair.'),
      nextAction: shortText(payload.recommendedNextSafeAction || 'Repair the latest supervised self-improvement run before opening another one.'),
      lastStatus,
      lastTimestamp: String(lastExecution.timestamp || '').trim(),
    });
  }
  if (safeExecutionCount > 0 || (historyCount > 0 && SELF_IMPROVEMENT_SAFE_STATUSES.has(lastStatus))) {
    return withCapabilityDescriptor({
      exists: true,
      status: 'pass',
      label: 'PROVEN',
      proven: true,
      blocked: false,
      partial: false,
      summary: shortText(
        payload.summary
        || `Supervised self-improvement is proven with ${Math.max(safeExecutionCount, 1)} safe run(s) recorded in this repo.`,
      ),
      nextAction: shortText(
        payload.recommendedNextSafeAction
        || 'Open at most one more bounded self-improvement task and keep it under the same review, trust, and rollback gates.',
      ),
      lastStatus,
      lastTimestamp: String(lastExecution.timestamp || '').trim(),
    });
  }
  if (preparedTaskCount > 0 || historyCount > 0) {
    return withCapabilityDescriptor({
      exists: true,
      status: 'warn',
      label: 'PARTIAL',
      proven: false,
      blocked: false,
      partial: true,
      summary: shortText(
        payload.summary
        || 'Self-improvement is seeded, but one supervised self-improvement round-trip still needs to complete successfully.',
      ),
      nextAction: shortText(
        payload.recommendedNextSafeAction
        || 'Run one bounded supervised self-improvement task and keep the same review and trust gates attached.',
      ),
      lastStatus,
      lastTimestamp: String(lastExecution.timestamp || '').trim(),
    });
  }
  return withCapabilityDescriptor({
    exists: false,
    status: 'idle',
    label: 'NOT RUN',
    proven: false,
    blocked: false,
    partial: false,
    summary: 'No supervised self-improvement proof is recorded yet.',
    nextAction: 'Generate and complete one bounded supervised self-improvement task before widening further.',
    lastStatus,
    lastTimestamp: '',
  });
}

function buildCompanionParitySignals(vscodeSetup = {}, extensionHealth = {}) {
  const install = vscodeSetup?.companionInstall && typeof vscodeSetup.companionInstall === 'object'
    ? vscodeSetup.companionInstall
    : {};
  const extensionExists = extensionHealth?.exists === true;
  const extensionStatus = normalizeStatus(extensionHealth?.status || '');
  const installed = install.installed === true;
  if (installed && extensionExists && extensionStatus === 'ready') {
    return withCapabilityDescriptor({
      exists: true,
      status: 'pass',
      label: 'PROVEN',
      proven: true,
      blocked: false,
      partial: false,
      summary: shortText(extensionHealth.summary || 'Desktop and VS Code companion parity is ready for the bounded coding loop.'),
      nextAction: shortText(extensionHealth.nextStep || 'Keep the companion aligned with the desktop contracts as you tune the coding loop.'),
    });
  }
  if (install.available || extensionExists || installed) {
    return withCapabilityDescriptor({
      exists: true,
      status: 'warn',
      label: 'PARTIAL',
      proven: false,
      blocked: false,
      partial: true,
      summary: shortText(
        extensionHealth.summary
        || (installed
          ? 'The VS Code companion is installed, but parity health still needs attention.'
          : 'The VS Code companion exists, but install/health proof is not complete yet.'),
      ),
      nextAction: shortText(
        extensionHealth.nextStep
        || (installed ? 'Clean up the companion health warnings before treating parity as complete.' : 'Install and validate the real VS Code companion before calling desktop and companion parity complete.'),
      ),
    });
  }
  return withCapabilityDescriptor({
    exists: false,
    status: 'idle',
    label: 'NOT READY',
    proven: false,
    blocked: false,
    partial: false,
    summary: 'No VS Code companion parity proof is recorded yet.',
    nextAction: 'Install and validate the real VS Code companion before treating desktop and companion parity as complete.',
  });
}

function buildModelParitySignals(acceptance = {}) {
  const control = acceptance?.controlSummary && typeof acceptance.controlSummary === 'object'
    ? acceptance.controlSummary
    : {};
  const pack = control.modelParity && typeof control.modelParity === 'object'
    ? control.modelParity
    : (acceptance?.modelParity && typeof acceptance.modelParity === 'object'
      ? acceptance.modelParity
      : (acceptance?.report?.modelParity && typeof acceptance.report.modelParity === 'object' ? acceptance.report.modelParity : {}));
  const status = normalizeStatus(pack.status || '');
  const capabilityCount = Math.max(0, Number(pack.capabilityCount || 0));
  const readyCount = Math.max(0, Number(pack.readyCount || 0));
  if (status === 'pass' || pack.widenReady === true) {
    return withCapabilityDescriptor({
      exists: true,
      status: 'pass',
      label: 'PROVEN',
      proven: true,
      blocked: false,
      partial: false,
      capabilityCount,
      readyCount,
      summary: shortText(pack.summary || 'Local-vs-remote model parity is proven for the bounded coding loop.'),
      nextAction: shortText(pack.nextAction || 'Keep the local stack aligned with the remote helper path as the bounded loop changes.'),
    });
  }
  if (capabilityCount > 0 || readyCount > 0 || status === 'warn' || status === 'fail') {
    return withCapabilityDescriptor({
      exists: true,
      status: status || 'warn',
      label: readyCount > 0 ? 'PARTIAL' : 'BLOCKED',
      proven: false,
      blocked: status === 'fail',
      partial: readyCount > 0,
      capabilityCount,
      readyCount,
      summary: shortText(pack.summary || 'Local-vs-remote model parity still needs proof before the local stack can widen.'),
      nextAction: shortText(pack.nextAction || 'Finish the missing local-vs-remote parity checks before widening the local default path.'),
    });
  }
  return withCapabilityDescriptor({
    exists: false,
    status: 'idle',
    label: 'NOT READY',
    proven: false,
    blocked: false,
    partial: false,
    capabilityCount: 0,
    readyCount: 0,
    summary: 'No local-vs-remote model parity pack is recorded yet.',
    nextAction: 'Capture one clean local-vs-remote parity pack before widening the local default path.',
  });
}

function buildSelfHostExpansion(signals = {}, activePhase = null) {
  const allowedInPhase = String(activePhase?.id || '').trim() === 'phase-1-safe-engine-core';
  const selfHostExpansionProgress = signals.selfHostExpansionProgress && typeof signals.selfHostExpansionProgress === 'object'
    ? signals.selfHostExpansionProgress
    : {};
  const progressStatus = normalizeStatus(selfHostExpansionProgress.status);
  const remainingCount = Math.max(0, 1 - Number(signals.selfHostExpansionUsedCount || 0));
  const blockedReasons = [];
  if (!allowedInPhase) {
    blockedReasons.push('The current phase is not using the bounded self-host expansion lane.');
  }
  if (!signals.selfHostProofProven) {
    blockedReasons.push('Self-host proof must be PROVEN before the engine opens one more self-host follow-up.');
  }
  if (signals.safeModeActive || signals.safeModeWatchOnly) {
    blockedReasons.push('Safe mode is still holding the self-host expansion lane.');
  }
  if (signals.approvalTotal > 0) {
    blockedReasons.push('Review and approval must be clear before the engine opens one more self-host follow-up.');
  }
  if (signals.blockedRescopedCount > 0) {
    blockedReasons.push('Blocked or needs-rescope task-hub items still need follow-up before the engine opens one more self-host follow-up.');
  }
  if (!signals.hasDailyFocusTask) {
    blockedReasons.push('Today’s focus task still needs to be recorded before the engine opens one more self-host follow-up.');
  }
  if (signals.modelProvisioningStatus === 'fail') {
    blockedReasons.push('Model provisioning is still blocked.');
  }
  if (progressStatus === 'queued') {
    blockedReasons.push('The extra self-host follow-up is already queued for today.');
  }
  if (progressStatus === 'running') {
    blockedReasons.push('The extra self-host follow-up is still running.');
  }
  if (progressStatus === 'review') {
    blockedReasons.push('The consumed self-host expansion is still held for review.');
  }
  if (progressStatus === 'fail') {
    blockedReasons.push('The consumed self-host expansion still needs repair.');
  }
  if (remainingCount <= 0) {
    blockedReasons.push('The one extra self-host follow-up for today has already been consumed.');
  }
  const eligible = blockedReasons.length === 0;
  const progressLabel = String(selfHostExpansionProgress.label || progressStatus || '').trim().toUpperCase();
  return {
    eligible,
    status: eligible
      ? 'ready'
      : (progressStatus === 'queued' || progressStatus === 'running' || progressStatus === 'review' || progressStatus === 'fail'
        ? progressStatus
        : 'blocked'),
    label: eligible ? 'OPEN' : (progressLabel || 'BLOCKED'),
    summary: eligible
      ? 'One extra supervised self-host follow-up is allowed today because self-host proof is PROVEN and the non-quota gates are clear.'
      : selfHostExpansionProgress.summary
        || blockedReasons[0]
        || 'The bounded self-host expansion lane is not open right now.',
    nextAction: eligible
      ? 'Let the engine queue or auto-run one more bounded self-host follow-up, then rerun the same proof bundle before widening again.'
      : selfHostExpansionProgress.nextAction
        || blockedReasons[0]
        || '',
    remainingCount,
    usedCount: Number(signals.selfHostExpansionUsedCount || 0),
  };
}

function buildPhaseCloseout(activePhase = null, phaseGate = {}, hardGate = {}, signals = {}, selfHostExpansion = {}) {
  const blockers = [];
  const selfHostExpansionProgress = signals.selfHostExpansionProgress && typeof signals.selfHostExpansionProgress === 'object'
    ? signals.selfHostExpansionProgress
    : {};
  if (phaseGate?.ok !== true && Array.isArray(phaseGate?.reasons)) {
    blockers.push(...phaseGate.reasons.map((item) => clipText(item, 160)).filter(Boolean));
  }
  if (!signals.operatorBaselineAcceptanceProven) {
    blockers.push('Operator baseline acceptance still needs tests, UI smoke, and self-host proof to pass together.');
  }
  if (!signals.selfHostProofProven) {
    blockers.push('Self-host proof still needs a passing bootstrap, test, and smoke bundle.');
  }
  if (!signals.selfImprovementProofProven) {
    blockers.push('One supervised self-improvement round-trip still needs to complete successfully.');
  }
  if (!signals.companionParityProven) {
    blockers.push('Desktop and VS Code still need clean bounded-loop parity proof.');
  }
  if (String(selfHostExpansionProgress.status || '').trim().toLowerCase() === 'fail') {
    blockers.push(selfHostExpansionProgress.summary || 'The consumed self-host expansion still needs repair.');
  }
  if (String(selfHostExpansionProgress.status || '').trim().toLowerCase() === 'review') {
    blockers.push(selfHostExpansionProgress.summary || 'The consumed self-host expansion is still held for review.');
  }
  if (String(selfHostExpansionProgress.status || '').trim().toLowerCase() === 'queued') {
    blockers.push(selfHostExpansionProgress.summary || 'The extra self-host expansion is already queued and still needs to run.');
  }
  if (String(selfHostExpansionProgress.status || '').trim().toLowerCase() === 'running') {
    blockers.push(selfHostExpansionProgress.summary || 'The extra self-host expansion is still running.');
  }
  const uniqueBlockers = Array.from(new Set(blockers)).slice(0, 5);
  const ready = phaseGate?.ok === true;
  return {
    status: ready ? 'ready' : 'blocked',
    label: ready ? 'READY' : 'BLOCKED',
    summary: ready
      ? `${String(activePhase?.label || 'The current phase').trim()} is ready to close.`
      : `Close ${String(activePhase?.label || 'the current phase').trim()} by clearing the remaining hard-gate blockers and keeping the next slice bounded.`,
    blockers: uniqueBlockers,
    nextAction: ready
      ? `Advance to the next phase once the first ${String(activePhase?.label || 'phase').trim()} proof stays healthy.`
      : selfHostExpansionProgress?.nextAction
        ? selfHostExpansionProgress.nextAction
      : selfHostExpansion?.eligible
        ? selfHostExpansion.nextAction
        : uniqueBlockers[0] || String(hardGate?.summary || phaseGate?.summary || '').trim(),
  };
}

function buildNextPhasePreview(activePhase = null, phases = []) {
  const currentNumber = Number(activePhase?.number || 0);
  const nextPhase = phases.find((item) => Number(item?.number || 0) === currentNumber + 1) || null;
  if (!nextPhase) {
    return null;
  }
  return {
    id: String(nextPhase.id || '').trim(),
    number: Number(nextPhase.number || 0),
    label: String(nextPhase.label || '').trim(),
    summary: clipText(nextPhase.goal || nextPhase.summary || '', 180),
    gateSummary: clipText(nextPhase.gateSummary || nextPhase?.hardGate?.summary || '', 180),
    proofSummary: clipText(nextPhase.proofSummary || '', 180),
  };
}

function buildHardGate(definition, options = {}) {
  const ok = options.ok === true;
  const reasons = Array.isArray(options.reasons) ? options.reasons.map((item) => clipText(item, 140)).filter(Boolean) : [];
  const blockedBy = String(options.blockedBy || '').trim();
  let summary = '';
  if (ok) {
    summary = String(options.successSummary || '').trim() || `${definition.label} is ready to advance.`;
  } else if (blockedBy) {
    summary = `Complete ${blockedBy} before ${definition.layer} can advance.`;
  } else {
    summary = String(options.blockedSummary || '').trim() || `The hard gate is still blocking ${definition.layer}.`;
  }
  return {
    ok,
    status: ok ? 'ready' : 'blocked',
    label: ok ? 'PASS' : 'BLOCKED',
    summary: clipText(summary, 180),
    reasons,
  };
}

function buildMilestone(definition, score, summary, hardGate) {
  const safeWeight = Math.max(1, Number(definition.weight || 0));
  const safeScore = Math.max(0, Math.min(safeWeight, Number(score || 0)));
  const completion = Number(((safeScore / safeWeight) * 100).toFixed(1));
  const status = hardGate?.ok
    ? 'ready'
    : safeScore > 0
      ? 'partial'
      : 'pending';
  return {
    id: definition.id,
    number: definition.number,
    label: definition.label,
    layer: definition.layer,
    weight: safeWeight,
    score: safeScore,
    completion,
    status,
    summary: clipText(summary || hardGate?.summary || '', 180),
    hardGate,
  };
}

function buildPhaseMilestone(definition, milestones = []) {
  const phaseMonths = milestones.filter((item) => definition.monthNumbers.includes(Number(item?.number || 0)));
  const phaseWeight = phaseMonths.reduce((sum, item) => sum + Number(item?.weight || 0), 0);
  const phaseScore = phaseMonths.reduce((sum, item) => sum + Number(item?.score || 0), 0);
  const safeWeight = Math.max(1, phaseWeight);
  const safeScore = Math.max(0, Math.min(safeWeight, phaseScore));
  const completion = Number(((safeScore / safeWeight) * 100).toFixed(1));
  const blockedMonth = phaseMonths.find((item) => item?.hardGate?.ok !== true) || null;
  const ready = phaseMonths.length > 0 && phaseMonths.every((item) => item?.hardGate?.ok === true);
  const gateSummary = blockedMonth
    ? `${blockedMonth.label} is the current internal audit gate. ${blockedMonth?.hardGate?.summary || ''}`
    : `All internal month gates for ${definition.label} are currently passing.`;
  const proofSummary = blockedMonth
    ? `${definition.label} is still grounded by ${blockedMonth.label} while the current structural baseline proof is incomplete.`
    : `${definition.label} has passing internal audit gates and can advance when the next phase-wide proof stays healthy.`;
  return {
    id: definition.id,
    number: definition.number,
    label: definition.label,
    summary: clipText(definition.summary, 180),
    goal: clipText(definition.summary, 180),
    gateSummary: clipText(gateSummary, 180),
    proofSummary: clipText(proofSummary, 180),
    monthNumbers: definition.monthNumbers.slice(),
    weight: safeWeight,
    score: safeScore,
    completion,
    status: ready
      ? 'ready'
      : safeScore > 0
        ? 'partial'
        : 'pending',
    hardGate: blockedMonth
      ? {
          ok: false,
          status: 'blocked',
          label: 'BLOCKED',
          summary: clipText(blockedMonth?.hardGate?.summary || `${definition.label} is still blocked.`, 180),
          reasons: Array.isArray(blockedMonth?.hardGate?.reasons) ? blockedMonth.hardGate.reasons.slice(0, 5) : [],
          blockedMonth: {
            id: String(blockedMonth.id || '').trim(),
            number: Number(blockedMonth.number || 0),
            label: String(blockedMonth.label || '').trim(),
            layer: String(blockedMonth.layer || '').trim(),
          },
        }
      : {
          ok: true,
          status: 'ready',
          label: 'PASS',
          summary: clipText(`${definition.label} is ready to advance.`, 180),
          reasons: [],
          blockedMonth: null,
        },
  };
}

function collectSignals(snapshot = {}) {
  const workspaceRoot = String(snapshot.workspaceRoot || '').trim();
  const targetWorkspaceRoot = String(snapshot.targetWorkspaceRoot || workspaceRoot || '').trim();
  const labRoot = String(snapshot.labRoot || '').trim();
  const workspaceScope = {
    roots: [workspaceRoot, targetWorkspaceRoot, labRoot]
      .map((item) => String(item || '').trim().replace(/\\/g, '/').toLowerCase())
      .filter(Boolean),
  };
  const manager = snapshot.manager && typeof snapshot.manager === 'object' ? snapshot.manager : {};
  const safeMode = manager.safeMode && typeof manager.safeMode === 'object' ? manager.safeMode : {};
  const approvals = manager.approvals && typeof manager.approvals === 'object' ? manager.approvals : {};
  const autonomy = (snapshot.autonomy && typeof snapshot.autonomy === 'object')
    ? snapshot.autonomy
    : (manager.autonomousActions && typeof manager.autonomousActions === 'object' ? manager.autonomousActions : {});
  const selfImprovement = snapshot.selfImprovement && typeof snapshot.selfImprovement === 'object'
    ? snapshot.selfImprovement
    : {};
  const promotions = snapshot.promotions && typeof snapshot.promotions === 'object' ? snapshot.promotions : {};
  const learning = snapshot.learningJournal && typeof snapshot.learningJournal === 'object' ? snapshot.learningJournal : {};
  const taskHub = snapshot.taskHub && typeof snapshot.taskHub === 'object' ? snapshot.taskHub : {};
  const modelFoundry = snapshot.modelFoundry && typeof snapshot.modelFoundry === 'object' ? snapshot.modelFoundry : {};
  const modelRoles = snapshot.modelRoles && typeof snapshot.modelRoles === 'object' ? snapshot.modelRoles : {};
  const vscodeSetup = snapshot.vscodeSetup && typeof snapshot.vscodeSetup === 'object' ? snapshot.vscodeSetup : {};
  const extensionHealth = snapshot.extensionHealth && typeof snapshot.extensionHealth === 'object' ? snapshot.extensionHealth : {};
  const modelProvisioning = snapshot.modelProvisioning && typeof snapshot.modelProvisioning === 'object'
    ? snapshot.modelProvisioning
    : (manager.modelProvisioning && typeof manager.modelProvisioning === 'object' ? manager.modelProvisioning : {});
  const approvedDocsVault = snapshot.approvedDocsVault && typeof snapshot.approvedDocsVault === 'object'
    ? snapshot.approvedDocsVault
    : (manager.approvedDocsVault && typeof manager.approvedDocsVault === 'object' ? manager.approvedDocsVault : {});
  const acceptance = snapshot.acceptance && typeof snapshot.acceptance === 'object'
    ? (snapshot.acceptance.report && typeof snapshot.acceptance.report === 'object' ? snapshot.acceptance.report : snapshot.acceptance)
    : {};
  const reviewer = snapshot.reviewer && typeof snapshot.reviewer === 'object' ? snapshot.reviewer : {};
  const regression = snapshot.regression && typeof snapshot.regression === 'object' ? snapshot.regression : {};
  const testBench = snapshot.testBench && typeof snapshot.testBench === 'object' ? snapshot.testBench : {};
  const integrations = snapshot.integrations && typeof snapshot.integrations === 'object' ? snapshot.integrations : {};
  const appRollbacks = snapshot.appRollbacks && typeof snapshot.appRollbacks === 'object' ? snapshot.appRollbacks : {};
  const benchmarks = snapshot.benchmarks && typeof snapshot.benchmarks === 'object' ? snapshot.benchmarks : {};
  const updates = snapshot.updates && typeof snapshot.updates === 'object' ? snapshot.updates : {};

  const acceptanceStatus = normalizeStatus(acceptance.overallStatus);
  const promotionGate = promotions.promotionGate && typeof promotions.promotionGate === 'object' ? promotions.promotionGate : {};
  const trainingReadiness = learning.trainingReadiness && typeof learning.trainingReadiness === 'object'
    ? learning.trainingReadiness
    : {};
  const exportReadiness = learning.gsDev1ExportReadiness && typeof learning.gsDev1ExportReadiness === 'object'
    ? learning.gsDev1ExportReadiness
    : {};
  const workspaceProfileId = String(modelRoles?.workspace?.modelProfileId || '').trim();
  const engineProfileId = String(modelRoles?.engine?.modelProfileId || '').trim();
  const laneAssignments = Array.isArray(modelRoles?.laneAssignments) ? modelRoles.laneAssignments : [];
  const engineLaneCount = laneAssignments.filter((item) => normalizeStatus(item?.role) === 'engine').length;
  const workspaceLaneCount = laneAssignments.filter((item) => normalizeStatus(item?.role) === 'workspace').length;
  const autonomyDaily = autonomy.dailyTarget && typeof autonomy.dailyTarget === 'object' ? autonomy.dailyTarget : {};
  const selfImprovementDaily = selfImprovement.dailyTarget && typeof selfImprovement.dailyTarget === 'object' ? selfImprovement.dailyTarget : {};
  const readyCandidateCount = asArrayCount(promotions.readyCandidates) || asArrayCount(promotions.candidates);
  const backupCount = asArrayCount(promotions.backups);
  const benchmarkCount = asArrayCount(benchmarks.runs) || asArrayCount(benchmarks.benchmarkSummary);
  const integrationInstalledCount = asArrayCount(integrations.installed);
  const integrationLibraryCount = asArrayCount(integrations.library);
  const appRollbackCount = asArrayCount(appRollbacks.backups);
  const scopedTasks = Array.isArray(taskHub.tasks)
    ? taskHub.tasks.filter((task) => entityMatchesWorkspaceScope(task, workspaceScope))
    : [];
  const scopedRecipes = Array.isArray(taskHub.recipes)
    ? taskHub.recipes.filter((recipe) => entityMatchesWorkspaceScope(recipe, workspaceScope))
    : [];
  const scopedRuns = Array.isArray(taskHub.runs)
    ? taskHub.runs.filter((run) => entityMatchesWorkspaceScope(run, workspaceScope))
    : [];
  const boundedTaskCount = countBoundedTasks({ tasks: scopedTasks });
  const selfHostProof = buildSelfHostProofSignals(acceptance);
  const operatorBaselineAcceptance = buildOperatorBaselineAcceptanceSignals(acceptance, selfHostProof);
  const dailyTaskHub = buildDailyTaskSummary(taskHub, {
    now: snapshot.generatedAt || Date.now(),
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
  });
  const roadmapDay = String(dailyTaskHub.roadmapDay || localDayKey(snapshot.generatedAt || Date.now())).trim() || localDayKey(snapshot.generatedAt || Date.now());
  const selfHostExpansionProgress = summarizeSelfHostExpansion(taskHub, {
    roadmapDay,
    now: snapshot.generatedAt || Date.now(),
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
  });
  const selfHostExpansionUsedCount = numericValue(selfHostExpansionProgress.consumedCount, 0);
  const selfImprovementProof = buildSelfImprovementProofSignals(selfImprovement);
  const acceptanceBuilderProof = acceptance?.builderProof && typeof acceptance.builderProof === 'object'
    ? acceptance.builderProof
    : {};
  const builderProofActionCount = numericValue(
    acceptanceBuilderProof.actionCount,
    Array.isArray(acceptanceBuilderProof.actions) ? acceptanceBuilderProof.actions.length : 0,
  );
  const companionParity = buildCompanionParitySignals(vscodeSetup, extensionHealth);
  const modelParity = buildModelParitySignals(acceptance);

  return {
    managerSummary: clipText(manager.summaryText || '', 180),
    safeModeActive: safeMode.active === true,
    safeModeWatchOnly: safeMode.watchOnly === true,
    approvalTotal: numericValue(approvals.total, 0),
    acceptanceExists: snapshot.acceptance && snapshot.acceptance.exists === true,
    acceptanceStatus,
    acceptancePass: acceptanceStatus === 'pass',
    acceptanceWarn: acceptanceStatus === 'warn',
    acceptanceSummary: clipText(acceptance.summary || '', 180),
    operatorBaselineAcceptance,
    operatorBaselineAcceptanceProven: operatorBaselineAcceptance.proven === true,
    selfHostProof,
    selfHostProofProven: selfHostProof.proven === true,
    selfImprovementProof,
    selfImprovementProofProven: selfImprovementProof.proven === true,
    companionParity,
    companionParityProven: companionParity.proven === true,
    modelParity,
    modelParityProven: modelParity.proven === true,
    boundedTaskCount,
    promotionGateStatus: normalizeStatus(promotionGate.status),
    promotionGateSummary: clipText(promotionGate.summary || '', 180),
    readyCandidateCount,
    backupCount,
    trainingReadiness,
    exportReadiness,
    trainingReady: isReadyLike(trainingReadiness.status),
    exportReady: isReadyLike(exportReadiness.status) || exportReadiness.ready === true,
    dailyTaskHub,
    hasDailyFocusTask: !!dailyTaskHub.focusTask,
    dailyFocusTask: dailyTaskHub.focusTask || null,
    blockedRescopedCount: numericValue(dailyTaskHub.blockedRescopedCount, 0),
    selfHostExpansionUsedCount,
    selfHostExpansionProgress,
    workspaceProfileId,
    engineProfileId,
    distinctProfiles: !!workspaceProfileId && !!engineProfileId && workspaceProfileId !== engineProfileId,
    modelProvisioningStatus: normalizeStatus(modelProvisioning.status),
    modelProvisioningSummary: clipText(modelProvisioning.summary || '', 180),
    modelProvisioningReady: isReadyLike(modelProvisioning.status),
    laneAssignments,
    engineLaneCount,
    workspaceLaneCount,
    approvedDocsExists: approvedDocsVault.exists === true,
    approvedDocsFreshness: normalizeStatus(approvedDocsVault.freshnessLabel),
    autonomy,
    autonomyActionCount: numericValue(autonomy.actionCount, 0),
    autonomyDaily,
    autonomyTarget: numericValue(autonomyDaily.target, 5),
    autonomySafeCount: numericValue(autonomyDaily.safeCount, 0),
    autonomyDailyMet: autonomyDaily.met === true,
    autonomyOverscopedCount: numericValue(autonomy.overscopedCount, 0),
    autonomyRecommendedNextSafeAction: clipText(autonomy.recommendedNextSafeAction || '', 180),
    selfImprovement,
    selfImprovementPreparedTaskCount: numericValue(selfImprovement.preparedTaskCount, 0),
    selfImprovementHistoryCount: numericValue(selfImprovement.historyCount, 0),
    selfImprovementDaily,
    selfImprovementTarget: numericValue(selfImprovementDaily.target, 5),
    selfImprovementSafeCount: numericValue(selfImprovementDaily.safeCount, 0),
    selfImprovementDailyMet: selfImprovementDaily.met === true,
    selfImprovementRecommendedNextSafeAction: clipText(selfImprovement.recommendedNextSafeAction || '', 180),
    reviewerStatus: normalizeStatus(reviewer.status),
    reviewerSummary: clipText(reviewer.summary || '', 180),
    reviewerBlocked: isBlockedLike(reviewer.status),
    regressionCandidateCount: numericValue(regression.candidateCount, 0),
    testBenchStatus: normalizeStatus(testBench.status),
    modelFoundryCandidateCount: numericValue(modelFoundry.candidateCount, 0),
    modelFoundrySuggestedCount: asArrayCount(modelFoundry.suggested),
    modelFoundrySummary: clipText(modelFoundry.summary || '', 180),
    operatorSupervisionCount: numericValue(learning?.operatorSupervision?.count, 0),
    benchmarkCount,
    integrationInstalledCount,
    integrationLibraryCount,
    taskRecipeCount: scopedRecipes.length,
    taskRunCount: Math.max(scopedRuns.length, builderProofActionCount),
    builderProofActionCount,
    appRollbackCount,
    updatesState: normalizeStatus(updates?.workspace?.state || updates?.state),
    updatesPending: !!(updates?.workspace?.hasUpdates || updates?.hasUpdates),
  };
}

function evaluateMonth1(signals) {
  let score = 0;
  if (signals.acceptanceExists) {
    score += 4;
  }
  if (signals.operatorBaselineAcceptanceProven) {
    score += 4;
  } else if (signals.operatorBaselineAcceptance.partial === true || signals.acceptanceWarn) {
    score += 2;
  }
  if (signals.managerSummary) {
    score += 2;
  }
  if (!signals.safeModeActive) {
    score += 2;
  }
  if (!signals.safeModeWatchOnly) {
    score += 1;
  }
  if (signals.boundedTaskCount > 0) {
    score += 2;
  }
  if (signals.autonomySafeCount > 0) {
    score += 1;
  }
  if (signals.autonomyDailyMet) {
    score += 2;
  }
  if (signals.selfImprovementProofProven) {
    score += 2;
  } else if (signals.selfImprovementSafeCount > 0) {
    score += 1;
  }
  if (signals.selfHostProofProven) {
    score += 2;
  }
  if (signals.autonomyActionCount > 0 && signals.autonomyOverscopedCount === 0) {
    score += 1;
  }
  if (signals.approvalTotal === 0) {
    score += 1;
  }
  if (signals.modelProvisioningReady) {
    score += 1;
  }
  if (signals.hasDailyFocusTask) {
    score += 1;
  }
  const reasons = [];
  if (!signals.operatorBaselineAcceptanceProven) {
    reasons.push('Operator baseline acceptance must prove tests, UI smoke, and self-host proof together before Phase 1 can close.');
  }
  if (signals.safeModeActive) {
    reasons.push('Hard safe mode must be released before the engine baseline can advance.');
  }
  if (signals.boundedTaskCount === 0) {
    reasons.push('Bounded self-dev slices still need to be visible in the task hub.');
  }
  if (!signals.selfHostProofProven) {
    reasons.push('Self-host proof must be PROVEN before the engine baseline can clear.');
  }
  if (!signals.selfImprovementProofProven) {
    reasons.push('One supervised self-improvement round-trip must complete successfully before the engine baseline can clear.');
  }
  if (signals.approvalTotal > 0) {
    reasons.push('The approval queue must be clear before Month 1 can advance.');
  }
  if (!signals.modelProvisioningReady) {
    reasons.push('The active provider and model provisioning must be trustworthy before the engine baseline can advance.');
  }
  if (signals.blockedRescopedCount > 0) {
    reasons.push('Blocked or needs-rescope tasks still need follow-up before widening engine self-dev.');
  }
  return {
    score,
    ready: reasons.length === 0,
    reasons,
    successSummary: 'Engine baseline is healthy: operator baseline acceptance, self-host proof, and supervised self-improvement are all visible and supervised.',
    blockedSummary: 'Month 1 is still stabilizing the usable engine baseline. Keep repair, review, and bounded self-dev slices inside the safe envelope.',
  };
}

function evaluateMonth2(signals) {
  let score = 0;
  if (signals.distinctProfiles) {
    score += 4;
  } else if (signals.workspaceProfileId && signals.engineProfileId) {
    score += 2;
  }
  if (signals.engineLaneCount >= 3) {
    score += 3;
  } else if (signals.engineLaneCount > 0) {
    score += 1;
  }
  if (signals.workspaceLaneCount >= 2) {
    score += 2;
  } else if (signals.workspaceLaneCount > 0) {
    score += 1;
  }
  if (signals.laneAssignments.length >= 6) {
    score += 2;
  }
  if (signals.engineProfileId) {
    score += 1;
  }
  if (signals.companionParityProven) {
    score += 2;
  } else if (signals.companionParity.partial === true) {
    score += 1;
  }
  const reasons = [];
  if (!signals.distinctProfiles) {
    reasons.push('Workspace and engine model roles still need distinct wrapped profiles.');
  }
  if (signals.engineLaneCount < 3) {
    reasons.push('Engine-facing lanes still need to inherit GSE-1 by default.');
  }
  if (signals.workspaceLaneCount < 2) {
    reasons.push('Workspace coding lanes still need a clean default model role.');
  }
  if (!signals.companionParityProven) {
    reasons.push('Desktop and VS Code still need clean companion parity proof for the bounded coding loop.');
  }
  return {
    score,
    ready: reasons.length === 0,
    reasons,
    successSummary: 'GSE-1 is established as the engine brain and the real VS Code companion is aligned with the bounded desktop loop.',
    blockedSummary: 'Month 2 still needs the engine-vs-workspace model split or companion parity proof to become the default routing behavior.',
  };
}

function evaluateMonth3(signals) {
  let score = 0;
  if (signals.trainingReady) {
    score += 3;
  } else if (signals.trainingReadiness.summary) {
    score += 1;
  }
  if (signals.exportReady) {
    score += 3;
  } else if (signals.exportReadiness.summary) {
    score += 1;
  }
  if (signals.modelFoundryCandidateCount > 0) {
    score += 2;
  } else if (signals.modelFoundrySuggestedCount > 0) {
    score += 1;
  }
  if (signals.readyCandidateCount > 0 || isReadyLike(signals.promotionGateStatus)) {
    score += 2;
  } else if (signals.promotionGateSummary) {
    score += 1;
  }
  const reasons = [];
  if (!signals.trainingReady) {
    reasons.push('Training handoff readiness still needs to be strong before GS-Dev-1 can harden.');
  }
  if (!signals.exportReady) {
    reasons.push('Trusted export readiness is still below the Month 3 hard gate.');
  }
  if (!(signals.readyCandidateCount > 0 || isReadyLike(signals.promotionGateStatus))) {
    reasons.push('Promotion-safe custom-variant proof is still missing for GS-Dev-1.');
  }
  return {
    score,
    ready: reasons.length === 0,
    reasons,
    successSummary: `GS-Dev-1 is hardened enough to compare and promote wrapped variants with trusted export proof.`,
    blockedSummary: `Month 3 still needs stronger export, comparison, and promotion evidence for GS-Dev-1.`,
  };
}

function evaluateMonth4(signals) {
  let score = 0;
  if (signals.autonomyActionCount > 0) {
    score += 2;
  }
  if (signals.autonomySafeCount > 0) {
    score += 2;
  }
  if (signals.autonomyDailyMet) {
    score += 3;
  }
  if (signals.autonomyOverscopedCount === 0 && signals.autonomyActionCount > 0) {
    score += 2;
  }
  if (!signals.safeModeActive) {
    score += 1;
  }
  const reasons = [];
  if (!signals.autonomyDailyMet) {
    reasons.push(`Daily safe autonomy still needs to reach ${signals.autonomyTarget}/day for Month 4.`);
  }
  if (signals.autonomyOverscopedCount > 0) {
    reasons.push('Model-fit gating still allows overscoped autonomous work.');
  }
  if (signals.safeModeActive) {
    reasons.push('Safe mode is still holding the autonomy control plane.');
  }
  return {
    score,
    ready: reasons.length === 0,
    reasons,
    successSummary: `Autonomy control is within the model envelope and meeting the daily safe-action target.`,
    blockedSummary: `Month 4 still needs safer autonomy routing, quota discipline, or overscope prevention.`,
  };
}

function evaluateMonth5(signals) {
  let score = 0;
  if (signals.selfImprovementPreparedTaskCount > 0 || signals.selfImprovementHistoryCount > 0) {
    score += 3;
  }
  if (signals.selfImprovementSafeCount > 0) {
    score += 2;
  }
  if (signals.selfImprovementDailyMet) {
    score += 3;
  }
  if (signals.trainingReady || signals.exportReady) {
    score += 1;
  }
  if (signals.operatorSupervisionCount > 0 || signals.boundedTaskCount > 0) {
    score += 1;
  }
  const reasons = [];
  if (!(signals.selfImprovementPreparedTaskCount > 0 || signals.selfImprovementHistoryCount > 0)) {
    reasons.push('The self-improvement queue still needs prepared-task or execution-history evidence.');
  }
  if (!signals.selfImprovementDailyMet) {
    reasons.push(`Daily safe self-improvement still needs to reach ${signals.selfImprovementTarget}/day for Month 5.`);
  }
  if (!(signals.trainingReady || signals.exportReady)) {
    reasons.push('Learning-loop readiness still needs stronger training or export evidence.');
  }
  return {
    score,
    ready: reasons.length === 0,
    reasons,
    successSummary: `The self-improvement loop is bounded, quota-aware, and feeding the learning path cleanly.`,
    blockedSummary: `Month 5 still needs self-improvement quota proof, execution history, or stronger learning handoff evidence.`,
  };
}

function evaluateMonth6(signals) {
  let score = 0;
  if (signals.acceptancePass) {
    score += 3;
  }
  if (signals.approvalTotal === 0) {
    score += 2;
  }
  if (signals.benchmarkCount > 0) {
    score += 2;
  }
  if (!signals.reviewerBlocked && (isReadyLike(signals.reviewerStatus) || signals.reviewerSummary)) {
    score += 2;
  }
  if (signals.regressionCandidateCount > 0 || isReadyLike(signals.testBenchStatus)) {
    score += 1;
  }
  const reasons = [];
  if (!signals.acceptancePass) {
    reasons.push('Acceptance must pass before Month 6 can tighten later hard gates.');
  }
  if (signals.approvalTotal > 0) {
    reasons.push('Outstanding approvals still block the trust and review gate layer.');
  }
  if (signals.benchmarkCount === 0) {
    reasons.push('Benchmark proof is still missing for the Month 6 hard gate.');
  }
  if (signals.reviewerBlocked) {
    reasons.push('Reviewer is still asking for revisions before the trust layer can advance.');
  }
  return {
    score,
    ready: reasons.length === 0,
    reasons,
    successSummary: `Trust, review, benchmark, and acceptance signals are strong enough to gate later autonomous work.`,
    blockedSummary: `Month 6 still needs cleaner review, benchmark, or acceptance proof before later layers can trust it.`,
  };
}

function evaluateMonth7(signals) {
  let score = 0;
  if (signals.readyCandidateCount > 0) {
    score += 3;
  }
  if (isReadyLike(signals.promotionGateStatus)) {
    score += 2;
  }
  if (signals.backupCount > 0) {
    score += 1;
  }
  if (signals.modelFoundryCandidateCount > 0) {
    score += 2;
  }
  const reasons = [];
  if (signals.readyCandidateCount === 0) {
    reasons.push('A promotion-ready candidate is still required for Month 7.');
  }
  if (!isReadyLike(signals.promotionGateStatus)) {
    reasons.push('The promotion gate is still blocking the custom-variant lifecycle layer.');
  }
  if (signals.backupCount === 0) {
    reasons.push('Rollback/backups still need to be visible before promotion can harden.');
  }
  return {
    score,
    ready: reasons.length === 0,
    reasons,
    successSummary: `Promotion and foundry lifecycle controls are strong enough to recommend safe variants.`,
    blockedSummary: `Month 7 still needs candidate, gate, or rollback proof before it can clear.`,
  };
}

function evaluateMonth8(signals) {
  let score = 0;
  if (signals.integrationLibraryCount > 0) {
    score += 2;
  }
  if (signals.integrationInstalledCount > 0) {
    score += 3;
  }
  if (signals.taskRecipeCount > 0) {
    score += 1;
  }
  if (signals.boundedTaskCount > 0) {
    score += 1;
  }
  const reasons = [];
  if (signals.integrationInstalledCount === 0) {
    reasons.push('Builder-core Month 8 still needs installed integrations or scaffolds to prove delivery paths.');
  }
  if (signals.taskRecipeCount === 0) {
    reasons.push('Task recipes still need to encode a repeatable builder workflow.');
  }
  return {
    score,
    ready: reasons.length === 0,
    reasons,
    successSummary: `Builder core has enough scaffold and workflow proof to expand beyond self-dev.`,
    blockedSummary: `Month 8 still needs repeatable app/site builder scaffolds and workflows.`,
  };
}

function evaluateMonth9(signals) {
  let score = 0;
  const repeatableRunCount = Math.max(
    Number(signals.taskRunCount || 0),
    Number(signals.builderProofActionCount || 0),
  );
  if (signals.integrationInstalledCount > 0) {
    score += 2;
  }
  if (signals.taskRecipeCount >= 2) {
    score += 2;
  } else if (signals.taskRecipeCount > 0) {
    score += 1;
  }
  if (repeatableRunCount > 0) {
    score += 1;
  }
  if (signals.benchmarkCount > 0) {
    score += 1;
  }
  const reasons = [];
  if (signals.integrationInstalledCount === 0) {
    reasons.push('Builder delivery still needs installed integration or template proof.');
  }
  if (signals.taskRecipeCount === 0 || repeatableRunCount === 0) {
    reasons.push('Month 9 still needs repeatable builder recipes exercised through real runs.');
  }
  return {
    score,
    ready: reasons.length === 0,
    reasons,
    successSummary: `Builder delivery flows are repeatable enough to benchmark and reuse across software projects.`,
    blockedSummary: `Month 9 still needs more repeatable template, recipe, or delivery evidence.`,
  };
}

function evaluateMonth10(signals) {
  let score = 0;
  if (signals.appRollbackCount > 0) {
    score += 2;
  }
  if (signals.backupCount > 0) {
    score += 1;
  }
  if (signals.updatesState) {
    score += 1;
  }
  const reasons = [];
  if (signals.appRollbackCount === 0) {
    reasons.push('Release ops still need rollback artifacts before Month 10 can clear.');
  }
  if (!signals.updatesState) {
    reasons.push('Update state still needs to be surfaced through the existing release/update architecture.');
  }
  return {
    score,
    ready: reasons.length === 0,
    reasons,
    successSummary: `Release and update ops are wired into rollback-ready operator flows.`,
    blockedSummary: `Month 10 still needs stronger update or rollback proof.`,
  };
}

function evaluateMonth11(signals) {
  let score = 0;
  if (signals.trainingReady) {
    score += 1;
  }
  if (signals.exportReady) {
    score += 1;
  }
  if (signals.modelFoundryCandidateCount > 0) {
    score += 1;
  }
  const reasons = [];
  if (!signals.trainingReady) {
    reasons.push('Local training orchestration still needs training readiness to go green.');
  }
  if (!signals.exportReady) {
    reasons.push('Trusted export readiness is still below the Month 11 gate.');
  }
  return {
    score,
    ready: reasons.length === 0,
    reasons,
    successSummary: `Trusted exports are strong enough to support local training orchestration.`,
    blockedSummary: `Month 11 still needs trusted training/export proof before local orchestration can begin.`,
  };
}

function evaluateMonth12(signals, previousMonthsReady) {
  let score = 0;
  if (signals.acceptancePass) {
    score += 1;
  }
  if (signals.autonomyDailyMet) {
    score += 1;
  }
  if (signals.selfImprovementDailyMet) {
    score += 1;
  }
  if (!signals.safeModeActive) {
    score += 1;
  }
  const reasons = [];
  if (!previousMonthsReady) {
    reasons.push('All prior monthly layers must clear before supervised-autonomy convergence can pass.');
  }
  if (!signals.acceptancePass) {
    reasons.push('Acceptance must stay green for year-one convergence.');
  }
  if (!signals.autonomyDailyMet) {
    reasons.push(`Daily safe autonomy still needs to hold at ${signals.autonomyTarget}/day for convergence.`);
  }
  if (!signals.selfImprovementDailyMet) {
    reasons.push(`Daily safe self-improvement still needs to hold at ${signals.selfImprovementTarget}/day for convergence.`);
  }
  return {
    score,
    ready: reasons.length === 0,
    reasons,
    successSummary: `The year-one supervised-autonomy baseline is stable enough to code, fix, build, ship, and improve itself under hard gates.`,
    blockedSummary: `Month 12 still needs the earlier layers and daily safety baselines to stay green together.`,
  };
}

function buildDoNotWidenYetBecause(signals = {}, hardGate = {}) {
  if (!signals.operatorBaselineAcceptanceProven) {
    return 'Do not widen yet because the operator baseline acceptance path is not proven yet.';
  }
  if (!signals.selfHostProofProven) {
    return 'Do not widen yet because self-host proof is not proven yet.';
  }
  if (!signals.selfImprovementProofProven) {
    return 'Do not widen yet because supervised self-improvement proof is not complete yet.';
  }
  if (!signals.companionParityProven) {
    return 'Do not widen yet because desktop and VS Code companion parity is not proven yet.';
  }
  if (signals.approvalTotal > 0) {
    return `Do not widen yet because ${signals.approvalTotal} approval item(s) are still waiting.`;
  }
  if (!signals.modelProvisioningReady) {
    return 'Do not widen yet because provider and model provisioning are not trustworthy yet.';
  }
  if (signals.blockedRescopedCount > 0) {
    return `Do not widen yet because ${signals.blockedRescopedCount} task(s) are still blocked or need rescope in today's task hub focus.`;
  }
  if (!signals.hasDailyFocusTask) {
    return 'Do not widen yet because today\'s focus task is missing from the task hub.';
  }
  if (!signals.autonomyDailyMet) {
    return `Do not widen yet because safe autonomous progress is ${signals.autonomySafeCount}/${signals.autonomyTarget} today.`;
  }
  if (!signals.selfImprovementDailyMet) {
    return `Do not widen yet because safe self-improvement progress is ${signals.selfImprovementSafeCount}/${signals.selfImprovementTarget} today.`;
  }
  if (hardGate?.ok === false && hardGate.summary) {
    return `Do not widen yet because ${hardGate.summary}`;
  }
  return '';
}

function monthEvaluator(definition, signals, previousMonthsReady) {
  if (definition.number === 1) {
    return evaluateMonth1(signals);
  }
  if (definition.number === 2) {
    return evaluateMonth2(signals);
  }
  if (definition.number === 3) {
    return evaluateMonth3(signals);
  }
  if (definition.number === 4) {
    return evaluateMonth4(signals);
  }
  if (definition.number === 5) {
    return evaluateMonth5(signals);
  }
  if (definition.number === 6) {
    return evaluateMonth6(signals);
  }
  if (definition.number === 7) {
    return evaluateMonth7(signals);
  }
  if (definition.number === 8) {
    return evaluateMonth8(signals);
  }
  if (definition.number === 9) {
    return evaluateMonth9(signals);
  }
  if (definition.number === 10) {
    return evaluateMonth10(signals);
  }
  if (definition.number === 11) {
    return evaluateMonth11(signals);
  }
  return evaluateMonth12(signals, previousMonthsReady);
}

function buildMvpReadiness(snapshot = {}) {
  const signals = collectSignals(snapshot);
  const milestones = [];
  let previousMonthsReady = true;
  let firstBlockingMonth = null;

  for (const definition of ROADMAP_MONTHS) {
    const evaluation = monthEvaluator(definition, signals, previousMonthsReady);
    const blockedBy = !previousMonthsReady && firstBlockingMonth ? firstBlockingMonth.label : '';
    const hardGate = buildHardGate(definition, {
      ok: previousMonthsReady && evaluation.ready,
      reasons: evaluation.ready
        ? []
        : (blockedBy ? [`Complete ${blockedBy} before activating ${definition.layer}.`, ...(evaluation.reasons || [])] : evaluation.reasons),
      blockedBy,
      successSummary: evaluation.successSummary,
      blockedSummary: evaluation.blockedSummary,
    });
    const milestone = buildMilestone(
      definition,
      evaluation.score,
      hardGate.summary,
      hardGate,
    );
    milestones.push(milestone);
    if (!hardGate.ok && !firstBlockingMonth) {
      firstBlockingMonth = milestone;
    }
    previousMonthsReady = previousMonthsReady && hardGate.ok;
  }

  const activeMonth = firstBlockingMonth || milestones[milestones.length - 1];
  const phases = ROADMAP_PHASES.map((definition) => buildPhaseMilestone(definition, milestones));
  const firstBlockingPhase = phases.find((item) => item?.hardGate?.ok !== true) || null;
  const activePhase = firstBlockingPhase || phases[phases.length - 1] || null;
  const totalWeight = milestones.reduce((sum, item) => sum + Number(item.weight || 0), 0) || 100;
  const achieved = milestones.reduce((sum, item) => sum + Number(item.score || 0), 0);
  const roadmapPercent = Math.max(0, Math.min(100, Math.round((achieved / totalWeight) * 100)));
  const percent = Math.max(0, Math.min(100, Math.round(activeMonth?.completion || 0)));
  const phasePercent = Math.max(0, Math.min(100, Math.round(activePhase?.completion || 0)));
  const summary = firstBlockingPhase
    ? `5-phase MVP readiness is ${phasePercent}% for ${activePhase.label}. Roadmap track is ${roadmapPercent}%. Phase gate ${activePhase?.hardGate?.label || 'UNKNOWN'}: ${activePhase?.hardGate?.summary || ''}`
    : `5-phase MVP readiness is ${phasePercent}%. Internal month audit track is ${roadmapPercent}%. All phase gates are currently passing.`;
  const selfHostExpansion = buildSelfHostExpansion(signals, activePhase);
  const recommendedNextSafeAction = clipText(
    selfHostExpansion.eligible
      ? selfHostExpansion.nextAction
      : ''
    || signals.autonomyRecommendedNextSafeAction
    || signals.selfImprovementRecommendedNextSafeAction
    || activePhase?.hardGate?.summary
    || activeMonth?.hardGate?.summary
    || '',
    180,
  );
  const doNotWidenYetBecause = clipText(buildDoNotWidenYetBecause(signals, activeMonth?.hardGate || {}), 180);
  const phaseCloseout = buildPhaseCloseout(activePhase, activePhase?.hardGate || {}, activeMonth?.hardGate || {}, signals, selfHostExpansion);
  const nextPhasePreview = buildNextPhasePreview(activePhase, phases);

  return {
    ok: true,
    percent,
    status: maturityStatus(percent),
    phasePercent,
    phaseStatus: maturityStatus(phasePercent),
    roadmapPercent,
    roadmapStatus: maturityStatus(roadmapPercent),
    summary,
    phaseSummary: clipText(activePhase?.goal || activePhase?.summary || '', 180),
    phaseProof: clipText(
      activePhase
        ? (activePhase.proofSummary || `${activePhase.label} is currently grounded by ${activeMonth?.label || 'the internal month audit'} and the current structural baseline proof.`)
        : '',
      180,
    ),
    currentPhase: activePhase
      ? {
          id: activePhase.id,
          number: activePhase.number,
          label: activePhase.label,
          summary: activePhase.goal || activePhase.summary,
          monthNumbers: activePhase.monthNumbers.slice(),
          completion: activePhase.completion,
          status: activePhase.status,
          gateSummary: activePhase.gateSummary || activePhase.hardGate?.summary || '',
          proofSummary: activePhase.proofSummary || '',
        }
      : null,
    phaseGate: activePhase?.hardGate || {
      ok: true,
      status: 'ready',
      label: 'PASS',
      summary: 'All phase gates are passing.',
      reasons: [],
      blockedMonth: null,
    },
    currentMonth: activeMonth
      ? {
          id: activeMonth.id,
          number: activeMonth.number,
          label: activeMonth.label,
          layer: activeMonth.layer,
          completion: activeMonth.completion,
          status: activeMonth.status,
        }
      : null,
    hardGate: activeMonth?.hardGate || {
      ok: true,
      status: 'ready',
      label: 'PASS',
      summary: 'All monthly hard gates are passing.',
      reasons: [],
    },
    dailyTargets: {
      autonomous: {
        target: signals.autonomyTarget,
        safeCount: signals.autonomySafeCount,
        met: signals.autonomyDailyMet,
      },
      selfImprovement: {
        target: signals.selfImprovementTarget,
        safeCount: signals.selfImprovementSafeCount,
        met: signals.selfImprovementDailyMet,
      },
    },
    dailyQuotaProof: {
      focusTask: signals.dailyFocusTask,
      blockedRescopedCount: signals.blockedRescopedCount,
      doNotWidenYetBecause: clipText(
        selfHostExpansion.eligible
          ? `${doNotWidenYetBecause} One extra supervised self-host follow-up is still allowed because self-host proof is PROVEN and the non-quota gates are clear.`
          : doNotWidenYetBecause,
        180,
      ),
    },
    overscopedActionCount: signals.autonomyOverscopedCount,
    recommendedNextSafeAction,
    doNotWidenYetBecause,
    operatorBaselineAcceptance: signals.operatorBaselineAcceptance,
    selfHostProof: signals.selfHostProof,
    selfImprovementProof: signals.selfImprovementProof,
    companionParity: signals.companionParity,
    modelParity: signals.modelParity,
    selfHostExpansion,
    selfHostExpansionProgress: signals.selfHostExpansionProgress,
    phaseCloseout,
    nextPhasePreview,
    internalAudit: {
      summary: clipText(
        [
          activeMonth?.label ? `${activeMonth.label}` : '',
          activeMonth?.hardGate?.label ? `${activeMonth.hardGate.label}` : '',
          activeMonth?.hardGate?.summary || '',
        ].filter(Boolean).join(' | '),
        180,
      ),
      currentMonth: activeMonth
        ? {
            id: activeMonth.id,
            number: activeMonth.number,
            label: activeMonth.label,
            layer: activeMonth.layer,
            completion: activeMonth.completion,
            status: activeMonth.status,
          }
        : null,
      hardGate: activeMonth?.hardGate || null,
      roadmapPercent,
      monthPercent: percent,
    },
    phaseScorecards: phases.map((phase) => ({
      id: String(phase.id || '').trim(),
      number: Number(phase.number || 0),
      label: String(phase.label || '').trim(),
      goal: clipText(phase.goal || phase.summary || '', 180),
      summary: clipText(phase.goal || phase.summary || '', 180),
      completion: Number(phase.completion || 0),
      status: String(phase.status || '').trim().toLowerCase(),
      gateLabel: String(phase?.hardGate?.label || '').trim(),
      gateSummary: clipText(phase.gateSummary || phase?.hardGate?.summary || '', 180),
      proofSummary: clipText(phase.proofSummary || '', 180),
      monthNumbers: Array.isArray(phase.monthNumbers) ? phase.monthNumbers.slice() : [],
    })),
    phaseNextMilestone: firstBlockingPhase
      ? {
          id: firstBlockingPhase.id,
          number: firstBlockingPhase.number,
          label: firstBlockingPhase.label,
          summary: firstBlockingPhase.summary,
          monthNumbers: firstBlockingPhase.monthNumbers.slice(),
        }
      : null,
    nextMilestone: firstBlockingMonth
      ? {
          id: firstBlockingMonth.id,
          number: firstBlockingMonth.number,
          label: firstBlockingMonth.label,
          layer: firstBlockingMonth.layer,
          summary: firstBlockingMonth.summary,
        }
      : null,
    roadmapNextMilestone: firstBlockingMonth
      ? {
          id: firstBlockingMonth.id,
          number: firstBlockingMonth.number,
          label: firstBlockingMonth.label,
          layer: firstBlockingMonth.layer,
          summary: firstBlockingMonth.summary,
        }
      : null,
    phases,
    milestones,
  };
}

module.exports = {
  ROADMAP_MONTHS,
  ROADMAP_PHASES,
  buildMvpReadiness,
};
