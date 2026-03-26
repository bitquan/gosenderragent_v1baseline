'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  collectProtectedBatReviewSignals,
  collectRuntimeApprovalSignals,
  parseAssistantRuns,
  parseBatBoard,
  parseFollowupBatReport,
  parseLatestSprintSummary,
  parseAssistantDashboard,
  summarizeWorkspaceTopology,
  summarizeRunDetail,
} = require('../core/board');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-board-'));
  fs.mkdirSync(path.join(root, 'docs', 'assistant_runs'), { recursive: true });
  return root;
}

test('parseAssistantRuns hides artifacts for BATs already marked DONE', () => {
  const workspaceRoot = makeWorkspace();
  try {
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'BAT_FEATURE_BOARD.md'),
      [
        '- `BAT<230>` [DONE][TESTED][BE][P1] Already complete.',
        '- `BAT<179>` [TODO][BE][P1][UNTESTED] Still active.',
        '',
      ].join('\n'),
      'utf8',
    );

    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'BAT230_implement.json'),
      JSON.stringify({ ticket: '230', command: 'implement', all_checks_passed: true, generated_at: '2026-03-11T21:00:00Z' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'BAT179_implement.json'),
      JSON.stringify({ ticket: '179', command: 'implement', all_checks_passed: true, generated_at: '2026-03-11T21:01:00Z' }),
      'utf8',
    );

    const runs = parseAssistantRuns(workspaceRoot, { limit: 10 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].ticket, '179');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('parseAssistantRuns keeps only the newest artifact per ticket and command', () => {
  const workspaceRoot = makeWorkspace();
  try {
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'BAT_FEATURE_BOARD.md'),
      '- `BAT<179>` [TODO][BE][P1][UNTESTED] Still active.\n',
      'utf8',
    );

    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'BAT179_run.json'),
      JSON.stringify({ ticket: '179', command: 'run', all_checks_passed: true, generated_at: '2026-03-11T21:00:00Z' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'BAT179_run_older.json'),
      JSON.stringify({ ticket: '179', command: 'run', all_checks_passed: false, generated_at: '2026-03-11T20:00:00Z' }),
      'utf8',
    );

    const runs = parseAssistantRuns(workspaceRoot, { limit: 10 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].ticket, '179');
    assert.equal(runs[0].command, 'run');
    assert.equal(runs[0].pass, true);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('parseBatBoard keeps the first BAT occurrence when duplicate ids exist', () => {
  const workspaceRoot = makeWorkspace();
  try {
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'BAT_FEATURE_BOARD.md'),
      [
        '- `BAT<230>` [TODO][CI][P1] Current active ticket.',
        '- `BAT<230>` [DONE][FE][P1][TESTED] Stale duplicate ticket.',
        '',
      ].join('\n'),
      'utf8',
    );

    const bats = parseBatBoard(workspaceRoot);
    assert.equal(bats.length, 1);
    assert.equal(bats[0].ticket, '230');
    assert.match(bats[0].desc, /Current active ticket/);
    assert.equal(bats[0].status, 'TODO');
    assert.equal(bats[0].lineNumber, 1);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('collectProtectedBatReviewSignals returns manual-review handoffs for protected TODO BATs', () => {
  const workspaceRoot = makeWorkspace();
  try {
    const signals = collectProtectedBatReviewSignals(workspaceRoot, [
      {
        ticket: '500',
        status: 'TODO',
        lineNumber: 241,
        safeBlockedReason: 'safe mode blocked protected domain: payments',
      },
      {
        ticket: '439',
        status: 'DONE',
        lineNumber: 13,
        safeBlockedReason: 'safe mode blocked protected term: payment',
      },
    ]);

    assert.equal(signals.length, 1);
    assert.equal(signals[0].path, 'docs/BAT_FEATURE_BOARD.md');
    assert.equal(signals[0].source, 'protected-bat');
    assert.equal(signals[0].line, 241);
    assert.equal(signals[0].detail, 'safe mode blocked protected domain: payments');
    assert.equal(signals[0].ticket, '500');
    assert.match(signals[0].protectedWhy, /payment|network pool|wallet/i);
    assert.match(signals[0].nextAction, /approve|review/i);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('parseBatBoard tolerates indented bullets and status tags not in first position', () => {
  const workspaceRoot = makeWorkspace();
  try {
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'BAT_FEATURE_BOARD.md'),
      [
        '  * `BAT<501>` [OPS][TODO][P1][UNTESTED] Harden keyed approval review state.',
        '',
      ].join('\n'),
      'utf8',
    );

    const bats = parseBatBoard(workspaceRoot);
    assert.equal(bats.length, 1);
    assert.equal(bats[0].ticket, '501');
    assert.equal(bats[0].status, 'TODO');
    assert.equal(bats[0].summary, 'Harden keyed approval review state.');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('parseFollowupBatReport returns inserted auto-created BATs', () => {
  const workspaceRoot = makeWorkspace();
  try {
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'assistant_followup_bats.json'),
      JSON.stringify({
        ok: true,
        generated_at: '2026-03-11T23:05:00Z',
        candidate_count: 5,
        scanned_artifacts: 80,
        inserted: [
          {
            ticket: '401',
            line: '- `BAT<401>` [TODO][BE][P1][UNTESTED] Add manual-review handoff for repeated assistant block.',
            occurrences: 2,
            source_tickets: ['166'],
            signature: 'blocked::safe mode blocked protected terms: network pool',
          },
        ],
      }),
      'utf8',
    );

    const report = parseFollowupBatReport(workspaceRoot);
    assert.equal(report.ok, true);
    assert.equal(report.inserted.length, 1);
    assert.equal(report.inserted[0].ticket, '401');
    assert.equal(report.inserted[0].occurrences, 2);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('parseLatestSprintSummary surfaces first failing artifact reason', () => {
  const workspaceRoot = makeWorkspace();
  try {
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'BAT217_implement.json'),
      JSON.stringify({
        ticket: '217',
        command: 'implement',
        checks: [
          {
            name: 'targeted pytest (test_scheduled_dispatch_readiness.py)',
            ok: false,
            stdout_tail: "E fixture 'client' not found",
          },
        ],
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'sprint_implement_20260311T230046Z.json'),
      JSON.stringify({
        action: 'implement',
        count_requested: 2,
        blocked_skips: ['BAT<208> (safe mode blocked protected terms: migration)'],
        outcomes: [
          {
            ticket: '217',
            action: 'implement',
            exit_code: 1,
            all_checks_passed: false,
            artifact: 'docs/assistant_runs/BAT217_implement.json',
          },
        ],
        generated_at: '2026-03-11T23:00:46Z',
      }),
      'utf8',
    );

    const sprint = parseLatestSprintSummary(workspaceRoot);
    assert.equal(sprint.action, 'implement');
    assert.equal(sprint.status, 'fail');
    assert.equal(sprint.failure.ticket, '217');
    assert.match(sprint.failure.summary, /Fixture "client" not found/);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('summarizeWorkspaceTopology marks isolated worktree scope from runtime host boundary', () => {
  const workspaceRoot = makeWorkspace();
  try {
    const topology = summarizeWorkspaceTopology(
      workspaceRoot,
      {
        active_file_path: path.join(workspaceRoot, 'backend', 'agent', 'runtime.py'),
        host_boundary: {
          project_root: path.join(workspaceRoot, 'worktrees', 'bat-701'),
          allowed_target_paths: [
            path.join(workspaceRoot, 'worktrees', 'bat-701', 'backend', 'agent'),
            path.join(workspaceRoot, 'worktrees', 'bat-701', 'docs'),
          ],
        },
      },
      {
        changedFiles: [
          { path: path.join(workspaceRoot, 'worktrees', 'bat-701', 'backend', 'agent', 'runtime.py') },
          'M worktrees/bat-701/docs/ENGINE_DAILY_REPORT.md',
        ],
      },
    );

    assert.equal(topology.isolated, true);
    assert.equal(topology.scopeLabel, 'isolated worktree');
    assert.equal(topology.displayName, 'worktrees/bat-701');
    assert.equal(topology.changedCount, 2);
    assert.deepEqual(topology.allowedTargetPaths, ['worktrees/bat-701/backend/agent', 'worktrees/bat-701/docs']);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('summarizeWorkspaceTopology falls back to main workspace scope', () => {
  const workspaceRoot = makeWorkspace();
  try {
    const topology = summarizeWorkspaceTopology(workspaceRoot, {}, { changedFiles: ['M backend/app/main.py'] });

    assert.equal(topology.isolated, false);
    assert.equal(topology.scopeLabel, 'main workspace');
    assert.equal(topology.displayName, path.basename(workspaceRoot));
    assert.equal(topology.changedCount, 1);
    assert.match(topology.summary, /main workspace/i);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('summarizeRunDetail exposes review, experiment, training, and worktree mapping', () => {
  const detail = summarizeRunDetail(
    {
      blockedReason: '',
      runSummary: { summary: 'Repair path selected.' },
      testSummary: { failed_count: 2 },
      trustSummary: { trust_state: 'needs_review', summary: 'trust=needs_review' },
      reviewSummary: { summary: 'Manual review requested', requires_manual_review: true, pending_approval_count: 1 },
      reviewQueueSummary: { pending_review_count: 2, summary: 'Two items need review.' },
      recommendedActions: [{ title: 'Inspect review queue', reason: 'pending approval is blocking release' }],
      experimentBenchmarkSummary: { total_runs: 4, best_strategy: { strategy: 'repair-first' } },
      ownerExperimentSummary: { recommended_next_action: 'retry targeted repair' },
      trainingHandoff: { recommended_focus: 'review recurring approval blockers', summary: 'Collect reviewer outcomes.' },
      validationFingerprints: [{ label: 'approval-loop' }],
      runtimeContext: {
        active_file_path: 'backend/agent/runtime.py',
        changed_files: [{ path: 'backend/agent/runtime.py' }, { path: 'docs/ENGINE_DAILY_REPORT.md' }],
        related_files: ['backend/tests/test_runtime.py'],
      },
    },
    {
      scopeLabel: 'isolated worktree',
      displayName: 'worktrees/bat-812',
    },
  );

  assert.equal(detail.pendingReviewCount, 2);
  assert.equal(detail.riskyState, 'review-required');
  assert.match(detail.reviewText, /Two items need review/i);
  assert.match(detail.reviewText, /trust needs_review/i);
  assert.match(detail.experimentText, /repair-first/i);
  assert.match(detail.trainingText, /review recurring approval blockers/i);
  assert.match(detail.worktreeText, /worktrees\/bat-812/i);
  assert.match(detail.nextActionText, /Inspect review queue/i);
  assert.equal(detail.trustSummary.trust_state, 'needs_review');
  assert.match(detail.automationText, /No automation queue detail recorded/i);
});

test('summarizeRunDetail falls back to self-improvement advisory guidance', () => {
  const detail = summarizeRunDetail({
    recommendation: {
      recommended_action: 'prepare-runtime-execution',
      summary: 'Execute the top self-improvement task next.',
      candidate: {
        recommended_next_step: 'review-other-candidates-first',
        advisory_reason_code: 'recent_duplicate',
        advisory_summary: 'Recent self-improvement history already executed the same candidate and target-path signature.',
      },
    },
  });

  assert.match(detail.nextActionText, /review-other-candidates-first/i);
  assert.match(detail.nextActionText, /same candidate and target-path signature/i);
  assert.match(detail.automationText, /review-other-candidates-first/i);
  assert.match(detail.automationText, /same candidate and target-path signature/i);
});

test('parseAssistantRuns reads configured external assistant_runs dir', () => {
  const workspaceRoot = makeWorkspace();
  const offloadRoot = path.join(workspaceRoot, 'offload');
  const runsDir = path.join(offloadRoot, 'assistant_runs');
  fs.mkdirSync(runsDir, { recursive: true });
  try {
    fs.writeFileSync(
      path.join(workspaceRoot, 'dev_assistant.yaml'),
      `assistant_runs_dir: ${runsDir}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'BAT_FEATURE_BOARD.md'),
      '- `BAT<610>` [TODO][BE][P1][UNTESTED] External offload artifact.\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(runsDir, 'BAT610_run.json'),
      JSON.stringify({ ticket: '610', command: 'run', all_checks_passed: true, generated_at: '2026-03-12T12:00:00Z' }),
      'utf8',
    );

    const runs = parseAssistantRuns(workspaceRoot, { limit: 10 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].ticket, '610');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('parseAssistantRuns extracts patch insight metadata from artifacts', () => {
  const workspaceRoot = makeWorkspace();
  try {
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'BAT_FEATURE_BOARD.md'),
      '- `BAT<611>` [TODO][BE][P1][UNTESTED] Patch insight artifact.\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'BAT611_implement.json'),
      JSON.stringify({
        ticket: '611',
        command: 'implement',
        all_checks_passed: true,
        generated_at: '2026-03-12T12:20:00Z',
        results: [
          {
            path: 'backend/app/services/dispatch.py',
            ai_patch_review: {
              selected_label: 'strict-minimal',
              selected_score: 88,
              selected_reasons: ['plain-output', 'memory-preferred-label'],
              selected_preview: 'def dispatch_job(job_id):',
              candidate_count: 2,
              memory_preferred_labels: ['strict-minimal'],
              memory_backed: true,
              alternate_candidates: [
                {
                  label: 'balanced',
                  score: 63,
                  reasons: ['plain-output'],
                  preview: 'def dispatch_job(job_id): return job_id',
                },
              ],
            },
          },
        ],
      }),
      'utf8',
    );

    const runs = parseAssistantRuns(workspaceRoot, { limit: 10 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].patchInsightCount, 1);
    assert.match(runs[0].runId, /611/);
    assert.equal(runs[0].state, 'pass');
    assert.equal(runs[0].patchInsights[0].selectedLabel, 'strict-minimal');
    assert.equal(runs[0].patchInsights[0].memoryBacked, true);
    assert.equal(runs[0].patchInsights[0].alternates[0].label, 'balanced');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('parseAssistantRuns extracts engine signals from artifacts', () => {
  const workspaceRoot = makeWorkspace();
  try {
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'BAT_FEATURE_BOARD.md'),
      '- `BAT<612>` [TODO][BE][P1][UNTESTED] Engine signal artifact.\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'BAT612_run.json'),
      JSON.stringify({
        ticket: '612',
        command: 'run',
        state: 'skipped',
        blocked_reason: 'blocked by unrelated failing test selection',
        generated_at: '2026-03-12T12:30:00Z',
        validation_fingerprints: [
          { label: 'unrelated-failing-test-selection', blocking: true },
        ],
        retry_policy: { action: 'rescope', reason: 'blocked by unrelated failing test selection' },
        engine_decisions: [
          { type: 'retry-policy', action: 'rescope', reason: 'blocked by unrelated failing test selection' },
          { type: 'repair-skip', reason: 'repair skipped by policy' },
        ],
        engine_metrics: {
          validation_failure_count: 1,
          blocking_fingerprint_count: 1,
          repair_skipped: true,
          decision_count: 2,
        },
      }),
      'utf8',
    );

    const runs = parseAssistantRuns(workspaceRoot, { limit: 10 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].state, 'skipped');
    assert.equal(runs[0].blockedReason, 'blocked by unrelated failing test selection');
    assert.equal(runs[0].validationFingerprints[0].label, 'unrelated-failing-test-selection');
    assert.equal(runs[0].retryPolicy.action, 'rescope');
    assert.equal(runs[0].engineDecisions[1].type, 'repair-skip');
    assert.equal(runs[0].engineMetrics.repair_skipped, true);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('parseAssistantRuns extracts owner, experiment, and automation summaries from artifacts', () => {
  const workspaceRoot = makeWorkspace();
  try {
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'BAT_FEATURE_BOARD.md'),
      '- `BAT<612>` [TODO][OPS][P1][UNTESTED] Surface consolidated runtime payloads in desktop views.\n',
      'utf8',
    );

    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'BAT612_implement.json'),
      JSON.stringify({
        ticket: '612',
        command: 'implement',
        generated_at: '2026-03-13T15:00:00Z',
        owner_summary: { summary: 'Owner-ready summary', status: 'blocked' },
        run_summary: { summary: 'Runtime failed', strategy: 'backend_api' },
        test_summary: { failed_count: 2, summary: '2 tests failed' },
        review_queue_summary: { pending_review_count: 1, summary: '1 review pending' },
        recommended_actions: [{ title: 'Inspect failure', reason: 'repair targeted tests' }],
        experiment_benchmark_summary: { total_runs: 3, best_strategy: { strategy: 'backend_api' } },
        owner_experiment_summary: { recommended_next_action: 'retry backend_api' },
        training_handoff: { recommended_focus: 'review failure clusters' },
        trust_summary: { trust_state: 'needs_review', summary: 'trust=needs_review' },
        trust_signal_count: 2,
        trust_state_counts: { needs_review: 2 },
        queue_summary: { summary: 'Prepared 2 self-improvement task(s).', prepared_task_count: 2 },
        history_summary: { entry_count: 4, status_counts: { review: 2, failed: 1 } },
        recommendation: { summary: 'Execute the top self-improvement task next.' },
        project_maintenance_summary: {
          queueSummary: { summary: 'Prepared 1 project-maintenance task.', prepared_task_count: 1 },
          historySummary: { status_counts: { review: 1 } },
        },
      }),
      'utf8',
    );

    const runs = parseAssistantRuns(workspaceRoot, { limit: 10 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].ownerSummary.summary, 'Owner-ready summary');
    assert.equal(runs[0].experimentBenchmarkSummary.total_runs, 3);
    assert.equal(runs[0].trustSummary.trust_state, 'needs_review');
    assert.equal(runs[0].trustSignalCount, 2);
    assert.equal(runs[0].trustStateCounts.needs_review, 2);
    assert.equal(runs[0].queueSummary.prepared_task_count, 2);
    assert.equal(runs[0].historySummary.entry_count, 4);
    assert.equal(runs[0].projectMaintenanceSummary.queueSummary.prepared_task_count, 1);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('parseAssistantRuns extracts review summaries and approval requests', () => {
  const workspaceRoot = makeWorkspace();
  try {
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'BAT_FEATURE_BOARD.md'),
      '- `BAT<613>` [TODO][BE][P1][UNTESTED] Review summary artifact.\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'BAT613_run.json'),
      JSON.stringify({
        ticket: '613',
        command: 'run',
        all_checks_passed: true,
        generated_at: '2026-03-12T12:40:00Z',
        runtime_context: {
          schema_version: '2026-03-12',
          ticket: '613',
          active_file_path: 'backend/app/services/jobs.py',
          related_files: ['backend/app/services/jobs.py'],
          changed_files: [{ path: 'backend/app/services/jobs.py', status: 'M' }],
          artifact_context: { referenced_paths: ['docs/assistant_runs/BAT613_run.json'] },
          baseline_state: { state: 'yellow', reason: 'recent failure hotspot' },
        },
        review_summary: {
          requires_manual_review: true,
          pending_approval_count: 1,
          low_confidence_patch_count: 2,
          summary: '1 approval request(s) pending; 2 low-confidence patch selection(s)',
        },
        pending_approvals: [
          {
            id: 'implementer:edit_file:path=backend/app/services/jobs.py',
            agent: 'implementer',
            tool: 'edit_file',
            reason: 'edit_file is controlled and requires approval before execution.',
            safety_level: 'controlled',
            input: { path: 'backend/app/services/jobs.py' },
          },
        ],
      }),
      'utf8',
    );

    const runs = parseAssistantRuns(workspaceRoot, { limit: 10 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].reviewSummary.requiresManualReview, true);
    assert.equal(runs[0].reviewSummary.pendingApprovalCount, 1);
    assert.equal(runs[0].reviewSummary.lowConfidencePatchCount, 2);
    assert.equal(runs[0].approvalRequests[0].path, 'backend/app/services/jobs.py');
    assert.equal(runs[0].approvalRequests[0].safetyLevel, 'controlled');
    assert.equal(runs[0].runtimeContext.active_file_path, 'backend/app/services/jobs.py');
    assert.equal(runs[0].runtimeContext.changed_files[0].path, 'backend/app/services/jobs.py');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('collectRuntimeApprovalSignals prioritizes approval requests and low-confidence patch paths', () => {
  const items = collectRuntimeApprovalSignals([
    {
      ticket: '700',
      runId: '700::run',
      approvalRequests: [
        {
          path: 'backend/app/services/jobs.py',
          agent: 'implementer',
          tool: 'edit_file',
          reason: 'approval required',
        },
      ],
      patchInsights: [
        {
          path: 'backend/app/services/matching.py',
          selectedLabel: 'balanced',
          selectedScore: 22,
        },
        {
          path: 'backend/app/services/dispatch.py',
          selectedLabel: 'strict-minimal',
          selectedScore: 88,
        },
      ],
      reviewSummary: {
        requiresManualReview: true,
        summary: 'manual review requested',
        activeFilePath: 'backend/app/services/jobs.py',
      },
    },
    {
      ticket: '701',
      runId: '701::run',
      approvalRequests: [],
      patchInsights: [],
      reviewSummary: {
        requiresManualReview: true,
        summary: 'fallback review path',
        reviewedPaths: ['backend/app/api/routes/jobs.py'],
      },
    },
  ]);

  assert.deepEqual(
    items.map((item) => [item.source, item.path]),
    [
      ['runtime-approval', 'backend/app/services/jobs.py'],
      ['patch-review', 'backend/app/services/matching.py'],
      ['review-summary', 'backend/app/api/routes/jobs.py'],
    ],
  );
});

test('collectRuntimeApprovalSignals dedupes seeded approval path across review sources', () => {
  const items = collectRuntimeApprovalSignals([
    {
      ticket: '702',
      runId: '702::run',
      approvalRequests: [
        {
          path: 'backend/alembic/versions/0005_wallet_transactions.py',
          reason: 'approval required',
        },
      ],
      patchInsights: [
        {
          path: 'backend/alembic/versions/0005_wallet_transactions.py',
          selectedLabel: 'balanced',
          selectedScore: 10,
        },
      ],
      reviewSummary: {
        requiresManualReview: true,
        activeFilePath: 'backend/alembic/versions/0005_wallet_transactions.py',
        reviewedPaths: ['backend/alembic/versions/0005_wallet_transactions.py'],
        summary: 'manual review requested',
      },
    },
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'runtime-approval');
  assert.equal(items[0].path, 'backend/alembic/versions/0005_wallet_transactions.py');
});

test('parseLatestSprintSummary surfaces sprint engine signals', () => {
  const workspaceRoot = makeWorkspace();
  try {
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'BAT701_implement.json'),
      JSON.stringify({
        ticket: '701',
        command: 'implement',
        summary: 'Validation blocked by unrelated failing tests.',
        checks: [
          { name: 'targeted pytest', ok: false, stdout_tail: 'unrelated failing test selection' },
        ],
        validation_fingerprints: [
          { label: 'unrelated-failing-test-selection', blocking: true },
        ],
        retry_policy: { action: 'handoff', reason: 'needs manual test selection review' },
        engine_decisions: [
          { type: 'retry-policy', action: 'handoff', reason: 'needs manual test selection review' },
        ],
        engine_metrics: { validation_failure_count: 1, blocking_fingerprint_count: 1, decision_count: 1 },
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'sprint_implement_20260312T123500Z.json'),
      JSON.stringify({
        action: 'implement',
        outcomes: [
          {
            ticket: '701',
            action: 'implement',
            exit_code: 1,
            all_checks_passed: false,
            artifact: 'docs/assistant_runs/BAT701_implement.json',
          },
        ],
        generated_at: '2026-03-12T12:35:00Z',
      }),
      'utf8',
    );

    const sprint = parseLatestSprintSummary(workspaceRoot);
    assert.equal(sprint.failure.validationFingerprints[0].label, 'unrelated-failing-test-selection');
    assert.equal(sprint.failure.retryPolicy.action, 'handoff');
    assert.equal(sprint.failure.engineDecisions[0].type, 'retry-policy');
    assert.equal(sprint.failure.engineMetrics.blocking_fingerprint_count, 1);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('parseLatestSprintSummary marks no-match sprint as skipped', () => {
  const workspaceRoot = makeWorkspace();
  try {
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'sprint_implement_20260312T125700Z.json'),
      JSON.stringify({
        action: 'implement',
        count_requested: 1,
        status_filter: 'TODO',
        prefer_domain: 'assistant_runtime',
        profile: 'aiWrite',
        no_match_reason: 'No tickets matched sprint filters',
        blocked_skips: ['BAT<3> (safe mode blocked protected terms: payment)'],
        outcomes: [],
        generated_at: '2026-03-12T12:57:00Z',
      }),
      'utf8',
    );

    const sprint = parseLatestSprintSummary(workspaceRoot);
    assert.equal(sprint.status, 'skipped');
    assert.equal(sprint.noMatchReason, 'No tickets matched sprint filters');
    assert.equal(sprint.failure, null);
    assert.equal(sprint.blockedSkips[0], 'BAT<3> (safe mode blocked protected terms: payment)');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('parseAssistantDashboard reads blocked skipped and fingerprint counts', () => {
  const workspaceRoot = makeWorkspace();
  try {
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'assistant_dashboard.json'),
      JSON.stringify({
        recent_count: 8,
        pass_rate: 62.5,
        blocked_count: 2,
        skipped_count: 1,
        top_validation_fingerprints: [{ label: 'missing-fixture-client', count: 2 }],
      }),
      'utf8',
    );

    const dashboard = parseAssistantDashboard(workspaceRoot);
    assert.equal(dashboard.blocked_count, 2);
    assert.equal(dashboard.skipped_count, 1);
    assert.equal(dashboard.top_validation_fingerprints[0].label, 'missing-fixture-client');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('parseAssistantDashboard adds training readiness summary from exported dataset', () => {
  const workspaceRoot = makeWorkspace();
  try {
    fs.mkdirSync(path.join(workspaceRoot, 'backend', 'scripts'), { recursive: true });
    const trainingPath = path.join(workspaceRoot, 'backend', 'scripts', 'dev_assistant_training.jsonl');
    fs.writeFileSync(trainingPath, '{"messages":[]}\n{"messages":[{"role":"user","content":"hi"}]}\n', 'utf8');
    fs.utimesSync(trainingPath, new Date('2026-03-11T10:00:00Z'), new Date('2026-03-11T10:00:00Z'));
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'assistant_dashboard.json'),
      JSON.stringify({
        recent_count: 4,
        recent_tickets: [
          { ticket: '9', generated_at: '2026-03-11T09:00:00Z' },
          { ticket: '10', generated_at: '2026-03-11T12:30:00Z' },
        ],
      }),
      'utf8',
    );

    const dashboard = parseAssistantDashboard(workspaceRoot);
    assert.equal(dashboard.training.exists, true);
    assert.equal(dashboard.training.exampleCount, 2);
    assert.equal(dashboard.training.pendingRunsCount, 1);
    assert.equal(dashboard.training.state, 'warn');
    assert.equal(dashboard.training.outputPath, 'backend/scripts/dev_assistant_training.jsonl');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('parseAssistantDashboard adds closed-loop summary with analyze and quality gate status', () => {
  const workspaceRoot = makeWorkspace();
  try {
    fs.mkdirSync(path.join(workspaceRoot, 'backend', 'scripts'), { recursive: true });
    const trainingPath = path.join(workspaceRoot, 'backend', 'scripts', 'dev_assistant_training.jsonl');
    fs.writeFileSync(trainingPath, '{"messages":[{"role":"user","content":"hi"}]}\n', 'utf8');
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'assistant_dashboard.json'),
      JSON.stringify({
        recent_tickets: [
          { ticket: '55', generated_at: '2026-03-11T10:00:00Z' },
        ],
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'assistant_analyze_status.json'),
      JSON.stringify({
        generated_at: '2026-03-11T10:05:00Z',
        entry_count: 12,
        ticket_count: 1,
        report_path: 'docs/DEV_ASSISTANT_LOG_REPORT.md',
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'assistant_training_status.json'),
      JSON.stringify({
        generated_at: '2026-03-11T10:08:00Z',
        example_count: 1,
        quality_gate: {
          passed: false,
          state: 'warn',
          summary: 'Need more validated examples.',
        },
      }),
      'utf8',
    );

    const dashboard = parseAssistantDashboard(workspaceRoot);
    assert.equal(dashboard.analyze.entryCount, 12);
    assert.equal(dashboard.training.qualityGate.passed, false);
    assert.equal(dashboard.closedLoop.stage, 'quality-gate');
    assert.equal(dashboard.closedLoop.state, 'warn');
    assert.match(dashboard.closedLoop.summary, /validated examples/i);
    assert.equal(dashboard.closedLoop.lastAnalyzeAt, '2026-03-11T10:05:00Z');
    assert.equal(dashboard.closedLoop.lastTrainAt, '2026-03-11T10:08:00Z');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('parseAssistantDashboard exposes local Qwen / Ollama training export metadata', () => {
  const workspaceRoot = makeWorkspace();
  try {
    fs.mkdirSync(path.join(workspaceRoot, 'backend', 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'assistant_training_status.json'),
      JSON.stringify({
        generated_at: '2026-03-14T10:08:00Z',
        example_count: 303,
        local_export: {
          requested: true,
          ready: true,
          format: 'qwen-ollama',
          provider: 'ollama',
          base_model: 'qwen2.5-coder:7b',
          bundle_dir: path.join(workspaceRoot, 'dev_data', 'local_training_exports', 'qwen-ollama', '20260314T100800Z'),
          messages_path: path.join(workspaceRoot, 'dev_data', 'local_training_exports', 'qwen-ollama', '20260314T100800Z', 'train.messages.jsonl'),
          manifest_path: path.join(workspaceRoot, 'dev_data', 'local_training_exports', 'qwen-ollama', '20260314T100800Z', 'manifest.json'),
          modelfile_path: path.join(workspaceRoot, 'dev_data', 'local_training_exports', 'qwen-ollama', '20260314T100800Z', 'Modelfile'),
          readme_path: path.join(workspaceRoot, 'dev_data', 'local_training_exports', 'qwen-ollama', '20260314T100800Z', 'README.md'),
          example_count: 303,
        },
      }),
      'utf8',
    );

    const dashboard = parseAssistantDashboard(workspaceRoot);
    assert.equal(dashboard.training.localExport.format, 'qwen-ollama');
    assert.equal(dashboard.training.localExport.provider, 'ollama');
    assert.equal(dashboard.training.localExport.baseModel, 'qwen2.5-coder:7b');
    assert.match(dashboard.training.localExport.bundleDir, /local_training_exports/);
    assert.match(dashboard.training.localExport.messagesPath, /train\.messages\.jsonl/);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('parseAssistantDashboard exposes compact engine baseline and daily report summaries', () => {
  const workspaceRoot = makeWorkspace();
  try {
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'assistant_dashboard.json'),
      JSON.stringify({ recent_count: 8, pass_rate: 62.5, blocked_count: 2, skipped_count: 1 }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'engine_baseline_summary.json'),
      JSON.stringify({
        generated_at: '2026-03-13T10:00:00Z',
        baseline: { state: 'yellow', blocked: true, reason: 'Recent failure cluster' },
        runtime: { run_count: 8, success_rate: 0.625, review_request_rate: 0.25, average_repair_attempts_per_run: 1.25 },
        experiments: { review_required_rate: 0.5 },
        common_failure_fingerprints: [{ label: 'import-setup-failure', count: 3 }],
        common_recommended_actions: [{ label: 'Resolve pending review queue', count: 2 }],
      }),
      'utf8',
    );
    fs.writeFileSync(path.join(workspaceRoot, 'docs', 'ENGINE_BASELINE.md'), '# Engine Baseline Summary\n', 'utf8');
    fs.writeFileSync(
      path.join(workspaceRoot, 'docs', 'assistant_runs', 'engine_daily_report.json'),
      JSON.stringify({
        generated_at: '2026-03-13T11:00:00Z',
        baseline: { state: 'yellow', blocked: true, reason: 'Recent failure cluster' },
        runtime: { run_count: 6, success_rate: 0.5, review_request_rate: 0.33, average_repair_attempts_per_run: 1.5 },
        experiments: { review_required_rate: 0.4, average_repair_count: 1.7, recommended_next_action: 'repair' },
        daily_focus: {
          suggested_workstream: 'review-and-triage',
          reason: 'Review queue pressure is rising.',
          operator_actions: ['Resolve pending review queue'],
        },
        maintenance_checklist: {
          open_today: [{ label: 'Unify readiness wording', category: 'fix' }, { label: 'Shrink route latency', category: 'tune' }],
          missing_today: [{ label: 'Auto-rescope overscoped objectives', category: 'implement' }],
        },
        top_blockers: [{ label: 'review queue pressure', count: 2 }],
        common_recommended_actions: [{ label: 'Resolve pending review queue', count: 2 }],
      }),
      'utf8',
    );
    fs.writeFileSync(path.join(workspaceRoot, 'docs', 'ENGINE_DAILY_REPORT.md'), '# Engine Daily Report\n', 'utf8');

    const dashboard = parseAssistantDashboard(workspaceRoot);
    assert.equal(dashboard.engineBaselineSummary.runsAnalyzed, 8);
    assert.equal(dashboard.engineBaselineSummary.successRate, 62.5);
    assert.equal(dashboard.engineBaselineSummary.blockedRate, 25);
    assert.equal(dashboard.engineBaselineSummary.reviewRequiredRate, 50);
    assert.equal(dashboard.engineBaselineSummary.averageRepairAttempts, 1.25);
    assert.equal(dashboard.engineBaselineSummary.topIssues[0].label, 'import-setup-failure');
    assert.equal(dashboard.engineBaselineSummary.canonicalMarkdownPath, 'docs/ENGINE_BASELINE.md');
    assert.equal(dashboard.engineDailyReport.suggestedWorkstream, 'review-and-triage');
    assert.equal(dashboard.engineDailyReport.recommendedFocus, 'Review queue pressure is rising.');
    assert.equal(dashboard.engineDailyReport.openChecklistCount, 2);
    assert.equal(dashboard.engineDailyReport.missingCapabilityCount, 1);
    assert.equal(dashboard.engineDailyReport.topIssues[0].label, 'review queue pressure');
    assert.match(dashboard.engineDailyReport.summary, /review-and-triage/i);
    assert.match(dashboard.engineDailyReport.summary, /2 open audit items/i);
    assert.equal(dashboard.engineDailyReport.canonicalMarkdownPath, 'docs/ENGINE_DAILY_REPORT.md');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
