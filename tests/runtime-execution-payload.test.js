'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync, spawnSync } = require('node:child_process');

const { buildOperatorExecutionSnapshot } = require('../shared-runtime/runtime');

function resolvePythonCommand() {
  const candidates = process.platform === 'win32' ? ['py', 'python', 'python.exe'] : ['python3', 'python'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }
  throw new Error('Python runtime is required for runtime execution payload tests.');
}

test('shared runtime normalizes operator execution snapshots for the task loop', () => {
  const payload = buildOperatorExecutionSnapshot({
    action: 'implement',
    task: 'Patch the failing validation path',
    taskMode: 'coder',
    laneId: 'code-main',
    laneLabel: 'Code main',
    runId: 'run-123',
    ticket: 'BAT-77',
    state: 'fail',
    modelProfileId: 'gs-dev-1-default',
    modelRole: 'workspace',
    modelDisplayName: 'Workspace Coding Model',
    baseModel: 'qwen2.5-coder:14b',
    providerSource: 'ollama',
    logTail: 'npm test\nFAIL src/app.test.js',
    stdoutTail: 'stdout line',
    stderrTail: 'stderr line',
    runtimeContext: {
      changed_files: [
        { path: 'src/app.js', status: 'modified' },
      ],
    },
    reviewSummary: { summary: 'Review is still pending.' },
    trustSummary: { trust_state: 'needs_review' },
    runSummary: { summary: 'Command execution failed.' },
    testSummary: { summary: '1 test failed.' },
    experimentBenchmarkSummary: { model_profile_id: 'gs-dev-1-default' },
    trainingHandoff: { summary: '1 trusted example ready.' },
    taskObjective: {
      summary: 'Patch the failing validation path',
      kind: 'coding-task',
      source: 'desktop-runtime',
      loopSteps: ['goal', 'observe', 'research'],
    },
    failureClass: {
      code: 'validation-failure',
      summary: 'Validation failed.',
      stage: 'validation',
      retryable: true,
      blocking: true,
    },
    recoveryLadder: {
      state: 'blocked',
      currentStep: 'repair-oriented-route',
      nextStep: 'bridge-plan-retry',
      history: [{ stage: 'repair', summary: 'repair loop evaluating validation outcome' }],
    },
    checkpointRef: {
      refId: 'run-123',
      label: 'latest-runtime-artifact',
      path: 'artifacts/run.json',
    },
    interruptRequest: {
      active: true,
      kind: 'review',
      summary: 'Manual review required.',
      requestedAction: 'resolve-review',
      allowedActions: ['open-trace', 'resume-interrupted-task'],
    },
    reviewBundle: {
      verdict: 'pending-review',
      decisionLabel: 'Review required',
      summary: 'Review is still pending.',
      reason: 'Manual review is still required before release.',
      howToFix: 'Review the latest changed files and clear the held approval.',
      changeSummary: '1 changed file(s) touched, starting with src/app.js',
      requiresManualReview: true,
      pendingCount: 1,
    },
    memoryHints: {
      summary: '2 reject pattern(s) recorded. Most common: Validation failed in renderer/app.js. Preferred response: repair-loop.',
      topRejectReason: 'Validation failed in renderer/app.js.',
      topFixPattern: 'Repair renderer/app.js and rerun the UI shell test.',
      recommendedResponse: 'repair-loop',
    },
    workbenchArtifacts: [{ kind: 'changed-file', label: 'src/app.js', path: 'src/app.js' }],
  });

  assert.equal(payload.taskMode, 'coder');
  assert.equal(payload.laneId, 'code-main');
  assert.equal(payload.modelRole, 'workspace');
  assert.equal(payload.modelProfileId, 'gs-dev-1-default');
  assert.equal(payload.modelDisplayName, 'Workspace Coding Model');
  assert.equal(payload.baseModel, 'qwen2.5-coder:14b');
  assert.equal(payload.status, 'fail');
  assert.equal(payload.retryAvailable, true);
  assert.equal(payload.repairAvailable, true);
  assert.equal(payload.changedFileCount, 1);
  assert.deepEqual(payload.changedFiles, [
    { path: 'src/app.js', status: 'modified' },
  ]);
  assert.match(payload.outputTail.combined, /FAIL src\/app\.test\.js/);
  assert.equal(payload.reviewSummary.summary, 'Review is still pending.');
  assert.equal(payload.trustSummary.trust_state, 'needs_review');
  assert.equal(payload.benchmarkMetadata.experimentBenchmarkSummary.model_profile_id, 'gs-dev-1-default');
  assert.equal(payload.learningMetadata.trainingHandoff.summary, '1 trusted example ready.');
  assert.equal(payload.taskObjective.kind, 'coding-task');
  assert.equal(payload.failureClass.code, 'validation-failure');
  assert.equal(payload.recoveryLadder.nextStep, 'bridge-plan-retry');
  assert.equal(payload.checkpointRef.refId, 'run-123');
  assert.equal(payload.interruptRequest.active, true);
  assert.equal(payload.reviewBundle.verdict, 'pending-review');
  assert.equal(payload.reviewBundle.decisionLabel, 'Review required');
  assert.match(payload.reviewBundle.reason, /Manual review/);
  assert.match(payload.reviewBundle.howToFix, /clear the held approval/i);
  assert.match(payload.memoryHints.summary, /reject pattern/i);
  assert.equal(payload.learningMetadata.memoryHints.recommendedResponse, 'repair-loop');
  assert.equal(payload.nextAction.command, 'review-interrupt');
  assert.equal(payload.nextAction.blocked, true);
  assert.match(payload.nextAction.reason, /Review required|Manual review/);
  assert.equal(payload.queuedFollowup.exists, false);
  assert.equal(payload.workbenchArtifacts[0].label, 'src/app.js');
});

test('shared runtime derives retry and repair availability from recovery ladder and interrupt state', () => {
  const retriable = buildOperatorExecutionSnapshot({
    action: 'implement',
    task: 'Retry the bounded patch',
    taskMode: 'coder',
    laneId: 'code-main',
    laneLabel: 'Code main',
    runId: 'run-derive',
    state: 'failed',
    recoveryLadder: {
      state: 'failed',
      current_step: 'research-expansion',
      next_step: 'research-expansion',
    },
    interruptRequest: {
      active: false,
      kind: 'runtime-block',
    },
  });
  assert.equal(retriable.retryAvailable, true);
  assert.equal(retriable.repairAvailable, true);
  assert.equal(retriable.nextAction.command, 'retry-with-research');
  assert.equal(retriable.queuedFollowup.exists, true);
  assert.equal(retriable.queuedFollowup.recipe.steps[0].metadata.nextActionCommand, 'retry-with-research');

  const held = buildOperatorExecutionSnapshot({
    action: 'run',
    task: 'Review the latest run',
    taskMode: 'validator',
    laneId: 'review-verify',
    laneLabel: 'Review verify',
    runId: 'run-held',
    state: 'blocked',
    recoveryLadder: {
      state: 'blocked',
      current_step: 'interrupt-or-rollback',
      next_step: 'interrupt-or-rollback',
    },
    interruptRequest: {
      active: true,
      kind: 'review',
    },
  });
  assert.equal(held.retryAvailable, false);
  assert.equal(held.repairAvailable, false);
  assert.equal(held.nextAction.command, 'review-interrupt');
});

test('shared runtime tunes the next action from learned reject patterns when the same path fails again', () => {
  const payload = buildOperatorExecutionSnapshot({
    action: 'implement',
    task: 'Continue the renderer repair.',
    taskMode: 'coder',
    laneId: 'code-main',
    laneLabel: 'Code main',
    runId: 'run-memory',
    state: 'fail',
    runtimeContext: {
      changed_files: [
        { path: 'renderer/app.js', status: 'modified' },
      ],
    },
    nextAction: {
      command: 'continue-run',
      label: 'Continue run',
      summary: 'Continue the renderer repair.',
      prompt: 'Continue the renderer repair.',
      blocked: false,
    },
    memoryHints: {
      summary: '2 reject pattern(s) recorded. Most common: Validation failed in renderer/app.js. Preferred response: repair-loop. Phase focus: Phase 1: Safe Engine Core.',
      topRejectReason: 'Validation failed in renderer/app.js.',
      topFixPattern: 'Repair renderer/app.js and rerun the UI shell test.',
      recommendedPrompt: 'Repair renderer/app.js and rerun the UI shell test.',
      recommendedResponse: 'repair-loop',
      topPaths: [{ value: 'renderer/app.js', count: 2 }],
      topPhaseId: 'phase-1-safe-engine-core',
      topPhaseLabel: 'Phase 1: Safe Engine Core',
      rejectCount: 2,
      recentRejects: [{ reason: 'Validation failed in renderer/app.js.' }],
    },
  });

  assert.equal(payload.nextAction.command, 'repair-loop');
  assert.equal(payload.nextAction.learned, true);
  assert.equal(payload.nextAction.phaseId, 'phase-1-safe-engine-core');
  assert.match(String(payload.nextAction.reason || ''), /Validation failed in renderer\/app\.js/i);
  assert.equal(payload.queuedFollowup.exists, true);
  assert.equal(payload.queuedFollowup.recipe.steps[0].metadata.phaseId, 'phase-1-safe-engine-core');
  assert.deepEqual(payload.queuedFollowup.recipe.steps[0].targetPaths, ['renderer/app.js']);
});

test('runtime api exposes one normalized operator execution payload family for plan run implement and repair', () => {
  const repoRoot = path.join(__dirname, '..');
  const runtimeRoot = path.join(repoRoot, 'runtime');
  const script = [
    'import json',
    'import sys',
    `sys.path.insert(0, r"${runtimeRoot.replace(/\\/g, '\\\\')}")`,
    'from backend.agent.runtime.runtime_api import _build_operator_execution_payload',
    'modes = [("plan", "planner"), ("run", "validator"), ("implement", "coder"), ("repair", "repair")]',
    'payloads = []',
    'for action, task_mode in modes:',
    '    payloads.append(_build_operator_execution_payload(',
    '        task=f"{action} ticket",',
    '        task_mode=task_mode,',
    '        action=action,',
    '        lane_id="review-verify" if action == "run" else "code-main",',
    '        lane_label="Review verify" if action == "run" else "Code main",',
    '        ticket_id="BAT-9",',
    '        run_id=f"run-{action}",',
    '        status="completed",',
        '        run_state="pass",',
    '        current_stage=action,',
    '        result_summary=f"{action} summary",',
    '        model_profile_id="gse-1-engine" if action in ("plan", "run") else "gs-dev-1-default",',
    '        model_role="engine" if action in ("plan", "run") else "workspace",',
    '        model_display_name="GSE-1 Engine" if action in ("plan", "run") else "Workspace Coding Model",',
    '        base_model="gpt-5.4" if action in ("plan", "run") else "qwen2.5-coder:14b",',
    '        provider_source="openai" if action in ("plan", "run") else "ollama",',
    '        runtime_context={"changed_files": [{"path": "src/app.js", "status": "modified"}]},',
    '        review_summary={"summary": "review summary"},',
    '        trust_summary={"trust_state": "trusted"},',
    '        run_summary={"summary": "run summary"},',
    '        test_summary={"summary": "test summary"},',
    '        benchmark_summary={"model_profile_id": "gs-dev-1-default"},',
    '        owner_experiment_summary={"summary": "owner benchmark"},',
    '        training_handoff={"summary": "training ready"},',
    '        artifact_paths=["artifacts/run.json"],',
    '        runtime_failure={"kind": "validation-failure", "message": "validation failed", "retryable": True, "blocking": True, "retry_policy": {"action": "repair"}},',
    '        runtime_events=[{"stage": "repair", "state": "repairing", "summary": "repair loop started"}],',
    '        review_state={"requires_manual_review": action == "run", "pending_review_count": 1 if action == "run" else 0},',
    '        review_requests=[{"review_id": "review-1", "summary": "manual review", "state": "pending_review"}],',
    '        retry_available=(action != "plan"),',
    '        repair_available=(action in ("implement", "repair")),',
    '    ))',
    'print(json.dumps(payloads))',
  ].join('\n');
  const raw = execFileSync('python', ['-c', script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONPATH: runtimeRoot,
    },
    encoding: 'utf8',
  });
  const payloads = JSON.parse(raw);

  assert.deepEqual(payloads.map((item) => item.action), ['plan', 'run', 'implement', 'repair']);
  assert.deepEqual(payloads.map((item) => item.taskMode), ['planner', 'validator', 'coder', 'repair']);
  assert.ok(payloads.every((item) => item.stageSummary && item.stageSummary.currentStage));
  assert.ok(payloads.every((item) => item.outputTail && Object.prototype.hasOwnProperty.call(item.outputTail, 'combined')));
  assert.ok(payloads.every((item) => Array.isArray(item.changedFiles) && item.changedFiles.length === 1));
  assert.equal(payloads[0].modelRole, 'engine');
  assert.equal(payloads[1].laneId, 'review-verify');
  assert.equal(payloads[2].modelProfileId, 'gs-dev-1-default');
  assert.equal(payloads[2].modelDisplayName, 'Workspace Coding Model');
  assert.equal(payloads[2].benchmarkMetadata.experiment_benchmark_summary.model_profile_id, 'gs-dev-1-default');
  assert.equal(payloads[3].learningMetadata.training_handoff.summary, 'training ready');
  assert.equal(payloads[0].retryAvailable, false);
  assert.equal(payloads[3].repairAvailable, true);
  assert.equal(payloads[0].taskObjective.kind, 'plan');
  assert.equal(payloads[1].reviewBundle.verdict, 'pending-review');
  assert.equal(payloads[1].reviewBundle.decisionLabel, 'Review required');
  assert.match(payloads[1].reviewBundle.reason, /review summary/i);
  assert.match(payloads[2].reviewBundle.howToFix, /Repair the failing validation path/i);
  assert.equal(payloads[2].failureClass.code, 'validation-failure');
  assert.equal(payloads[2].recoveryLadder.nextStep, 'repair-oriented-route');
  assert.equal(payloads[3].checkpointRef.label, 'latest-runtime-artifact');
});

test('agent runtime recovery contracts classify empty proposals and keep a checkpoint even without artifact files', () => {
  const repoRoot = path.join(__dirname, '..');
  const runtimeRoot = path.join(repoRoot, 'runtime');
  const script = [
    'import json',
    'import sys',
    `sys.path.insert(0, r"${runtimeRoot.replace(/\\/g, '\\\\')}")`,
    'from backend.agent.runtime.agent_runtime import _derive_runtime_failure, _build_failure_class_contract, _build_recovery_ladder_contract, _build_checkpoint_ref_contract',
    'result = {',
    '  "ticket": "BAT-7",',
    '  "runtime_task": {"task_id": "task-7", "ticket": "BAT-7"},',
    '  "runtime_run": {"run_id": "run-7", "state": "failed", "current_stage": "validating", "updated_at": "2026-03-17T12:00:00Z"},',
    '  "execution": {"created": []},',
    '  "validation": {',
    '    "ok": False,',
    '    "commands": [],',
    '    "retry_policy": {"action": "run", "reason": "No changes produced"},',
    '    "fingerprints": [{"label": "no-op proposal", "message": "model produced no changed files"}],',
    '  },',
    '  "repair": {},',
    '  "runtime_context": {"changed_files": []},',
    '  "artifacts": {},',
    '}',
    'result["runtime_failure"] = _derive_runtime_failure(result)',
    'print(json.dumps({',
    '  "runtime_failure": result["runtime_failure"],',
    '  "failure_class": _build_failure_class_contract(result),',
    '  "recovery_ladder": _build_recovery_ladder_contract(result),',
    '  "checkpoint_ref": _build_checkpoint_ref_contract(result),',
    '}))',
  ].join('\n');
  const raw = execFileSync('python', ['-c', script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONPATH: runtimeRoot,
    },
    encoding: 'utf8',
  });
  const payload = JSON.parse(raw);

  assert.equal(payload.runtime_failure.kind, 'empty-proposal');
  assert.equal(payload.failure_class.code, 'empty-proposal');
  assert.equal(payload.recovery_ladder.next_step, 'research-expansion');
  assert.equal(payload.checkpoint_ref.label, 'runtime-checkpoint');
  assert.equal(payload.checkpoint_ref.ref_id, 'run-7');
});

test('tool-loop contracts classify invalid step sets and expose checkpoint plus interrupt guidance', () => {
  const repoRoot = path.join(__dirname, '..');
  const runtimeRoot = path.join(repoRoot, 'runtime');
  const script = [
    'import json',
    'import sys',
    `sys.path.insert(0, r"${runtimeRoot.replace(/\\/g, '\\\\')}")`,
    'from backend.agent.core.tool_loop import _tool_loop_failure_class, _tool_loop_recovery_ladder, _tool_loop_interrupt_request, _tool_loop_checkpoint_ref',
    'runtime_run = {"run_id": "run-tool", "state": "failed"}',
    'result = {',
    '  "ok": False,',
    '  "status": "failed",',
    '  "summary": "unknown step action: explode",',
    '  "payload": {"execution": [{"step": {"action": "explode", "path": "src/app.js"}, "result": {"error": "unknown step action: explode"}}]},',
    '  "runtime_events": [],',
    '  "pending_approvals": [],',
    '  "tool_audit_trail": [{"tool": "implementer"}],',
    '}',
    'print(json.dumps({',
    '  "failure_class": _tool_loop_failure_class(result, {}),',
    '  "recovery_ladder": _tool_loop_recovery_ladder(result, runtime_run),',
    '  "interrupt_request": _tool_loop_interrupt_request(result),',
    '  "checkpoint_ref": _tool_loop_checkpoint_ref(result, runtime_run),',
    '}))',
  ].join('\n');
  const raw = execFileSync('python', ['-c', script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONPATH: runtimeRoot,
    },
    encoding: 'utf8',
  });
  const payload = JSON.parse(raw);

  assert.equal(payload.failure_class.code, 'invalid-change-set');
  assert.equal(payload.recovery_ladder.next_step, 'bridge-plan-retry');
  assert.equal(payload.interrupt_request.requested_action, 'bridge-plan-retry');
  assert.equal(payload.checkpoint_ref.label, 'tool-loop-checkpoint');
});

test('backend runtime memory hints summarize recurring reject patterns and phase relevance', () => {
  const repoRoot = path.join(__dirname, '..');
  const runtimeRoot = path.join(repoRoot, 'runtime');
  const script = [
    'import json',
    'import sys',
    'import tempfile',
    'from pathlib import Path',
    `sys.path.insert(0, r"${runtimeRoot.replace(/\\/g, '\\\\')}")`,
    'from backend.agent.core.memory_service import record_memory, summarize_runtime_memory_hints',
    'with tempfile.TemporaryDirectory() as tmpdir:',
    '    project_root = Path(tmpdir)',
    '    for _index in range(2):',
    '        record_memory(',
    '            project_root,',
    '            "BAT-88",',
    '            "ui_repair",',
    '            ["renderer/app.js"],',
    '            False,',
    '            metadata={',
    '                "timestamp": "2026-03-17T12:00:00+00:00",',
    '                "validation_fingerprints": ["ui-shell-failure"],',
    '                "retry_action": "repair",',
    '                "active_file_path": "renderer/app.js",',
    '                "review_verdict": "repair-required",',
    '                "review_reason": "Validation failed in renderer/app.js.",',
    '                "how_to_fix": "Repair renderer/app.js and rerun the UI shell test.",',
    '                "recommended_prompt": "Repair renderer/app.js and rerun the UI shell test.",',
    '                "next_action_command": "repair-loop",',
    '            },',
    '        )',
    '    payload = summarize_runtime_memory_hints(',
    '        project_root,',
    '        ticket="BAT-88",',
    '        strategy="ui_repair",',
    '        fingerprint_labels=["ui-shell-failure"],',
    '        target_path="renderer/app.js",',
    '        active_file_path="renderer/app.js",',
    '    )',
    '    print(json.dumps(payload))',
  ].join('\n');
  const raw = execFileSync('python', ['-c', script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONPATH: runtimeRoot,
    },
    encoding: 'utf8',
  });
  const payload = JSON.parse(raw);

  assert.equal(payload.reject_count, 2);
  assert.equal(payload.top_reject_reason, 'Validation failed in renderer/app.js.');
  assert.match(String(payload.top_fix_pattern || ''), /Repair renderer\/app\.js/i);
  assert.equal(payload.recommended_response, 'repair-loop');
  assert.equal(payload.runtime_retry_action, 'repair');
  assert.equal(payload.top_phase_id, 'phase-1-safe-engine-core');
  assert.equal(payload.top_paths[0].value, 'renderer/app.js');
});

test('runtime api forwards backend memory hints so cold payloads still tune the next action', () => {
  const repoRoot = path.join(__dirname, '..');
  const runtimeRoot = path.join(repoRoot, 'runtime');
  const script = [
    'import json',
    'import sys',
    `sys.path.insert(0, r"${runtimeRoot.replace(/\\/g, '\\\\')}")`,
    'from backend.agent.runtime.runtime_api import _build_operator_execution_payload',
    'payload = _build_operator_execution_payload(',
    '    task="Repair the renderer layout issue.",',
    '    task_mode="coder",',
    '    action="implement",',
    '    ticket_id="BAT-91",',
    '    run_id="run-memory-cold",',
    '    status="failed",',
    '    run_state="failed",',
    '    current_stage="validation",',
    '    result_summary="Validation failed in renderer/app.js.",',
    '    runtime_context={',
    '        "changed_files": [{"path": "renderer/app.js", "status": "modified"}],',
    '        "memory_state": {',
    '            "memory_hints": {',
    '                "summary": "2 runtime reject pattern(s) matched. Most common: Validation failed in renderer/app.js. Preferred response: repair-loop. Phase focus: Phase 1: Safe Engine Core.",',
    '                "top_reject_reason": "Validation failed in renderer/app.js.",',
    '                "top_fix_pattern": "Repair renderer/app.js and rerun the UI shell test.",',
    '                "recommended_prompt": "Repair renderer/app.js and rerun the UI shell test.",',
    '                "recommended_response": "repair-loop",',
    '                "reject_count": 2,',
    '                "top_paths": [{"value": "renderer/app.js", "count": 2}],',
    '                "top_phase_id": "phase-1-safe-engine-core",',
    '                "top_phase_label": "Phase 1: Safe Engine Core",',
    '                "recent_rejects": [{"reason": "Validation failed in renderer/app.js."}],',
    '            }',
    '        },',
    '    },',
    '    review_summary={"summary": "Repair the renderer path before release."},',
    '    trust_summary={"trust_state": "needs_review"},',
    '    run_summary={"summary": "Validation failed."},',
    '    test_summary={"summary": "UI shell failed."},',
    '    runtime_failure={"kind": "validation-failure", "message": "Validation failed in renderer/app.js.", "retryable": True, "blocking": False, "retry_policy": {"action": "repair"}},',
    '    retry_available=True,',
    '    repair_available=True,',
    ')',
    'print(json.dumps(payload))',
  ].join('\n');
  const raw = execFileSync('python', ['-c', script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONPATH: runtimeRoot,
    },
    encoding: 'utf8',
  });
  const operatorExecution = JSON.parse(raw);
  const snapshot = buildOperatorExecutionSnapshot(operatorExecution);

  assert.equal(snapshot.learningMetadata.memoryHints.topRejectReason, 'Validation failed in renderer/app.js.');
  assert.equal(snapshot.nextAction.command, 'repair-loop');
  assert.equal(snapshot.nextAction.learned, true);
  assert.equal(snapshot.queuedFollowup.recipe.steps[0].metadata.phaseId, 'phase-1-safe-engine-core');
});

test('runtime api marks no-op coding orchestrations as failures instead of approved passes', () => {
  const repoRoot = path.join(__dirname, '..');
  const runtimeRoot = path.join(repoRoot, 'runtime');
  const python = resolvePythonCommand();
  const script = [
    'import json',
    'import sys',
    `sys.path.insert(0, r"${runtimeRoot.replace(/\\/g, '\\\\')}")`,
    'from backend.agent.runtime.runtime_api import _mark_orchestration_noop_failure',
    'payload = _mark_orchestration_noop_failure({',
    '    "ok": True,',
    '    "runtime_run": {"run_id": "run-1", "task_id": "task-1"},',
    '    "runtime_context": {"changed_files": []},',
    '    "runtime_events": [{"data": {"tool": "read_file"}}],',
    '    "runtime_result": {"ok": True, "status": "succeeded", "final_state": "succeeded"},',
    '    "review_summary": {"summary": "no manual review blockers detected"},',
    '    "run_summary": {},',
    '}, "Add a brief comment above describeTask.")',
    'print(json.dumps(payload))',
  ].join('\n');
  const raw = execFileSync(python, ['-c', script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONPATH: runtimeRoot,
    },
    encoding: 'utf8',
  });
  const payload = JSON.parse(raw);

  assert.equal(payload.ok, false);
  assert.equal(payload.runtime_failure.kind, 'no-op-edit');
  assert.equal(payload.runtime_result.status, 'failed');
  assert.match(String(payload.review_summary.summary || ''), /did not apply any file changes/i);
});
