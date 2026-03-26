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
};

export const AI_ROUTE_COPY = Object.freeze({
  settingsTabDescription: 'Manage selector-driven routing, bridge profiles, local model inventory, remote providers, and per-route overrides from one place.',
  modelSetupPrompt: 'Set up the workspace coding model, engine control model, and verify the route plan is ready.',
  enginePanelTitle: 'Chat follows the current route plan',
  overrideMetricLabel: 'Route overrides',
  overrideMetricActiveSummary: 'Manual route overrides are active.',
  overrideMetricIdleSummary: 'All capability routes currently follow the active profile and route plan.',
  resetOverridesLabel: 'Reset route overrides',
  capabilityRoutesEyebrow: 'Capability routes',
  capabilityRoutesTitle: 'Tune each capability route without hand-editing routing rules',
  capabilityRoutesSummary: 'Leave a route on inherit to follow the active profile and route plan, or pin that route to the benchmark leader or a specific model.',
  routeCardEyebrow: 'Route',
  routeSourceOverride: 'Manual route override',
  routeSourceInherited: 'Inherited from route plan',
  routeSelectLabel: 'Route selection',
  routeResetLabel: 'Reset route',
  ladderEyebrow: 'Local model MVP ladder',
  ladderSummary: 'This is the local-first MVP ladder for the solo-dev assistant. Higher capability blocks stay locked until the lower block has benchmark, acceptance, or promotion proof.',
  unlockEyebrow: 'Capability unlock ladder',
  unlockSummary: 'Use this ladder as the hard rule for widening the engine: verify the current block, then unlock the next one. If a higher block regresses, fall back to the last verified block.',
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
          ? 'Candidate and foundry signals exist, but promotion still needs a clean benchmark-backed proof path.'
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
      summary: 'Candidate promotion stays locked until the foundry path is benchmark-backed and rollback-safe.',
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
    nextLayer,
    summary: nextLayer.status === 'verified'
      ? 'All current local-model MVP blocks are verified. Keep remote use constrained to explicit fallback or comparison.'
      : `Next focus: ${nextLayer.label}. ${nextLayer.summary}`,
    layers,
    unlocks,
  };
}