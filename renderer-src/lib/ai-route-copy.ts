export type LocalModelProgramStatus = 'verified' | 'next' | 'locked';

export type LocalModelProgramLayer = {
  id: string;
  label: string;
  status: LocalModelProgramStatus;
  summary: string;
  unlockRule: string;
};

export type LocalModelProgramUnlock = {
  id: string;
  label: string;
  status: LocalModelProgramStatus;
  summary: string;
};

export type LocalModelProgram = {
  verifiedCount: number;
  localModelCount: number;
  benchmarkLeaderIsLocal: boolean;
  approvedDefaultCount: number;
  candidateOnlyCount: number;
  largerHeadroomCount: number;
  approvedDefaultsSummary: string;
  candidateOnlySummary: string;
  largerHeadroomSummary: string;
  currentStateSummary: string;
  nextLayer: LocalModelProgramLayer;
  summary: string;
  layers: LocalModelProgramLayer[];
  unlocks: LocalModelProgramUnlock[];
};

export type LocalModelProgramEvidence = {
  localModelCount: number;
  localRuntimeReady: boolean;
  routePolicy: string;
  activeRouteOverrideCount: number;
  localCodingProofSummary: string;
  acceptanceStatus: string;
  benchmarkSummaryCount: number;
  benchmarkLeaderIsLocal: boolean;
  promotedCandidateCount: number;
  candidateCount: number;
  modelFoundryCandidateCount: number;
  remoteFallbackReady: boolean;
  safeModeActive: boolean;
  approvedDefaultCount: number;
  candidateOnlyCount: number;
  largerHeadroomCount: number;
  approvedDefaultsSummary: string;
  candidateOnlySummary: string;
  largerHeadroomSummary: string;
  currentStateSummary: string;
};

export const AI_ROUTE_COPY = Object.freeze({
  settingsTabDescription: 'Manage selector-driven routing, bridge profiles, local model inventory, remote providers, and per-route overrides from one place.',
  modelSetupPrompt: 'Open Tune Pod to finish model setup for this workspace.',
  tunePodFitPrompt: 'Open Tune Pod to see which local models fit this PC.',
  tunePodRoutePrompt: 'Open Tune Pod to see what still needs setup for local coding.',
  tunePodActionLabel: 'Open Tune Pod',
  enginePanelTitle: 'Chat uses your current model setup',
  overrideMetricLabel: 'Manual model choices',
  overrideMetricActiveSummary: 'Manual model choices are active.',
  overrideMetricIdleSummary: 'Task model choices follow the current setup.',
  resetOverridesLabel: 'Reset manual choices',
  capabilityRoutesEyebrow: 'Task model choices',
  capabilityRoutesTitle: 'Choose which model handles each kind of work',
  capabilityRoutesSummary: 'Leave a task on automatic to use the current setup, or choose a specific model when you need a manual choice.',
  routeCardEyebrow: 'Task',
  routeSourceOverride: 'Manual choice',
  routeSourceInherited: 'Using the current workspace setup',
  routeSelectLabel: 'Model choice',
  routeResetLabel: 'Reset choice',
  ladderEyebrow: 'Advanced readiness ladder',
  ladderSummary: 'Advanced: deeper setup progress and checks for people tuning the full local model stack.',
  unlockEyebrow: 'Advanced setup steps',
  unlockSummary: 'Advanced: use these steps when you need to tune the full local model stack beyond the default setup view.',
});

export function localModelProgramStatusLabel(value: string) {
  if (value === 'verified') {
    return 'Verified';
  }
  if (value === 'next') {
    return 'Next';
  }
  return 'Locked';
}

export function buildLocalModelProgram(evidence: LocalModelProgramEvidence): LocalModelProgram {
  const foundationStatus: LocalModelProgramStatus = evidence.localModelCount >= 2
    ? 'verified'
    : evidence.localModelCount === 1 && evidence.localRuntimeReady
      ? 'next'
      : 'locked';
  const routingStatus: LocalModelProgramStatus = evidence.localRuntimeReady && evidence.localModelCount > 0
    ? ((evidence.activeRouteOverrideCount > 0 || evidence.routePolicy.includes('local') || evidence.routePolicy.includes('hybrid')) ? 'verified' : 'next')
    : 'locked';
  const codingStatus: LocalModelProgramStatus = String(evidence.localCodingProofSummary || '').trim()
    ? 'verified'
    : evidence.acceptanceStatus === 'pass'
      ? 'verified'
      : evidence.acceptanceStatus === 'warn' || evidence.benchmarkSummaryCount > 0
        ? 'next'
        : 'locked';
  const promotionStatus: LocalModelProgramStatus = evidence.promotedCandidateCount > 0
    ? 'verified'
    : (evidence.modelFoundryCandidateCount > 0 || evidence.candidateCount > 0 ? 'next' : 'locked');
  const selfImproveStatus: LocalModelProgramStatus = evidence.promotedCandidateCount > 0 && evidence.acceptanceStatus === 'pass'
    ? 'verified'
    : (evidence.acceptanceStatus === 'pass' || evidence.promotedCandidateCount > 0 ? 'next' : 'locked');

  const layers: LocalModelProgramLayer[] = [
    {
      id: 'foundation',
      label: 'Layer 0: Foundation',
      status: foundationStatus,
      summary: foundationStatus === 'verified'
        ? `${evidence.localModelCount} ready local coding models are installed and the local runtime is usable.`
        : foundationStatus === 'next'
          ? 'The local runtime is usable, but the second ready coding-grade local model still needs to be locked in.'
          : 'Install and register local coding models before treating the engine as local-first.',
      unlockRule: 'Need 2 ready local coding models plus a working local runtime.',
    },
    {
      id: 'routing',
      label: 'Layer 1: Local coding parity',
      status: routingStatus,
      summary: routingStatus === 'verified'
        ? `Local-first routing is configured${evidence.activeRouteOverrideCount > 0 ? ` with ${evidence.activeRouteOverrideCount} explicit route override${evidence.activeRouteOverrideCount === 1 ? '' : 's'}` : ''}.`
        : routingStatus === 'next'
          ? 'Local runtime is available, but planner/coder/validator still need a locked local-first route plan.'
          : 'Routing is not yet stable enough to treat local models as the default coding path.',
      unlockRule: 'Planner, coder, and validator must route local-first before widening capability.',
    },
    {
      id: 'coding',
      label: 'Layer 2: Verified coding block',
      status: codingStatus,
      summary: String(evidence.localCodingProofSummary || '').trim() || (codingStatus === 'verified'
        ? `Acceptance is green and ${evidence.benchmarkLeaderIsLocal ? 'the current benchmark leader is local-first' : 'benchmark evidence exists'} for the coding block.`
        : codingStatus === 'next'
          ? 'Benchmark or partial acceptance evidence exists, but the local-first coding block is not fully proven yet.'
          : 'The local-first coding block still needs benchmark and acceptance proof before autonomy expands.'),
      unlockRule: 'Need benchmark plus acceptance proof for local-first planner/coder/validator lanes.',
    },
    {
      id: 'promotion',
      label: 'Layer 3: Foundry and promotion',
      status: promotionStatus,
      summary: promotionStatus === 'verified'
        ? `${evidence.promotedCandidateCount} promoted local candidate${evidence.promotedCandidateCount === 1 ? '' : 's'} already proved the promotion path.`
        : promotionStatus === 'next'
          ? `${evidence.candidateOnlyCount > 0 ? `${evidence.candidateOnlyCount} candidate-only model${evidence.candidateOnlyCount === 1 ? ' stays' : 's stay'} visible while ` : ''}promotion still needs a clean benchmark-backed proof path.`
          : 'No verified candidate promotion path exists yet for local model bundles.',
      unlockRule: 'Only benchmark-backed local candidates should become promoted defaults.',
    },
    {
      id: 'self-improve',
      label: 'Layer 4: Self-improvement',
      status: selfImproveStatus,
      summary: selfImproveStatus === 'verified'
        ? 'Trusted self-improvement can stay gated behind approved runs while the local baseline remains green.'
        : selfImproveStatus === 'next'
          ? 'The repo is close to trusted self-improvement, but promotion or acceptance proof is still incomplete.'
          : 'Keep self-improvement bounded until the lower local-first blocks are verified.',
      unlockRule: 'Approved-run exports only, and only after local-first acceptance stays green.',
    },
  ];

  const unlocks: LocalModelProgramUnlock[] = [
    {
      id: 'chat',
      label: 'Unlock local-first daily coding',
      status: foundationStatus === 'verified' && routingStatus === 'verified' ? 'verified' : foundationStatus === 'next' || routingStatus === 'next' ? 'next' : 'locked',
      summary: 'Daily planning and coding can default local-first once foundation and routing are verified.',
    },
    {
      id: 'repair',
      label: 'Unlock local repair and edit loop',
      status: codingStatus === 'verified' ? 'verified' : codingStatus === 'next' ? 'next' : 'locked',
      summary: 'Repair, edit, and rerun loops should widen only after benchmark plus acceptance proof is visible.',
    },
    {
      id: 'promotion',
      label: 'Unlock model promotion',
      status: promotionStatus,
      summary: evidence.candidateOnlyCount > 0
        ? `Candidate-only models stay visible until the foundry path is benchmark-backed, proof-complete, and rollback-safe.`
        : 'Candidate promotion stays locked until the foundry path is benchmark-backed and rollback-safe.',
    },
    {
      id: 'self-improve',
      label: 'Unlock trusted self-improvement',
      status: selfImproveStatus,
      summary: 'Training exports and self-improvement stay gated behind approved runs and a stable local baseline.',
    },
    {
      id: 'remote-min',
      label: 'Unlock remote-minimized operation',
      status: selfImproveStatus === 'verified' && evidence.benchmarkLeaderIsLocal && !evidence.safeModeActive
        ? 'verified'
        : ((routingStatus === 'verified' || codingStatus === 'verified') && evidence.remoteFallbackReady ? 'next' : 'locked'),
      summary: evidence.remoteFallbackReady
        ? 'Remote models can stay as explicit compare or overflow helpers instead of the daily default.'
        : 'Configure remote fallback only as backup, not as the primary coding path.',
    },
  ];

  const nextLayer = layers.find((layer) => layer.status !== 'verified') || layers[layers.length - 1];
  const verifiedCount = layers.filter((layer) => layer.status === 'verified').length;

  return {
    verifiedCount,
    localModelCount: evidence.localModelCount,
    benchmarkLeaderIsLocal: evidence.benchmarkLeaderIsLocal,
    approvedDefaultCount: evidence.approvedDefaultCount,
    candidateOnlyCount: evidence.candidateOnlyCount,
    largerHeadroomCount: evidence.largerHeadroomCount,
    approvedDefaultsSummary: evidence.approvedDefaultsSummary,
    candidateOnlySummary: evidence.candidateOnlySummary,
    largerHeadroomSummary: evidence.largerHeadroomSummary,
    currentStateSummary: evidence.currentStateSummary,
    nextLayer,
    summary: nextLayer.status === 'verified'
      ? 'All current local-model MVP blocks are verified. Keep remote use constrained to explicit fallback or comparison.'
      : `Next focus: ${nextLayer.label}. ${nextLayer.summary}`,
    layers,
    unlocks,
  };
}