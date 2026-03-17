'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const RUNTIME_ROOT = path.join(REPO_ROOT, 'runtime');

function runPythonJson(source) {
  const output = childProcess.execFileSync('python', ['-c', source], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PYTHONPATH: [RUNTIME_ROOT, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter),
      PROJECT_ROOT: REPO_ROOT,
    },
    encoding: 'utf8',
  });
  return JSON.parse(String(output || '').trim());
}

test('self-improvement execution accepts desktop-owned paths outside backend agent internals', () => {
  const result = runPythonJson(`
import json
from backend.agent.runtime import runtime_api

runtime_api.summarize_self_improvement_work = lambda *args, **kwargs: {
    "prepared_tasks": [{
        "task_id": "self-task-001",
        "candidate_id": "seed-001",
        "title": "Repair desktop-owned core surface",
        "objective": "Keep the next fix bounded to desktop-owned code.",
        "action": "implement",
        "mode": "integrate",
        "target_paths": ["core/"],
        "runtime_task": {
            "action": "implement",
            "mode": "integrate",
            "metadata": {"target_paths": ["core/"]},
        },
        "metadata": {"difficulty": "low"},
    }]
}
runtime_api._PreparedSelfImprovementAdapter = lambda *args, **kwargs: object()
runtime_api._facade_run_ticket = lambda *args, **kwargs: {
    "ok": True,
    "ticket": "self-task-001",
    "artifacts": {},
    "review_state": {},
    "review_summary": {},
    "owner_summary": {},
    "run_summary": {},
    "test_summary": {},
    "recommended_actions": [],
}
runtime_api.append_self_improvement_history = lambda *args, **kwargs: None
runtime_api.append_self_improvement_seed = lambda *args, **kwargs: None
runtime_api.export_self_improvement_queue = lambda *args, **kwargs: {"outputPath": ""}
runtime_api.summarize_self_improvement_history = lambda *args, **kwargs: {}

result = runtime_api.execute_self_improvement_task({})
print(json.dumps({
    "ok": result.get("ok"),
    "status": result.get("status"),
    "blockedReason": result.get("blockedReason"),
}))
`);

  assert.equal(result.ok, true);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.blockedReason, null);
});

test('bootstrap self-improvement backlog pauses stale doc seeds and seeds app-focused slices', () => {
  const result = runPythonJson(`
import json
from backend.agent.runtime import runtime_api

paused = []
seeded = []

runtime_api.load_self_improvement_seeds = lambda *args, **kwargs: [
    {
        "seed_id": "batch-docs-seed",
        "requested_by": "operator-batch",
        "target_paths": ["docs/assistant_runs/BAT17_status_suggestion.json"],
    },
    {
        "seed_id": "old-bootstrap-seed",
        "requested_by": "bootstrap",
        "target_paths": ["host/"],
    },
    {
        "seed_id": "owner-core-seed",
        "requested_by": "operator",
        "target_paths": ["core/"],
    },
]
runtime_api.append_self_improvement_seed = lambda *args, **kwargs: paused.append(kwargs.get("payload") or args[1] or {})
runtime_api.seed_self_improvement_task = lambda payload=None: seeded.append(dict(payload or {})) or {
    "seedId": str((payload or {}).get("seedId") or ""),
    "taskId": "self-task-" + str(len(seeded)),
    "summary": "seeded",
}
runtime_api.export_self_improvement_queue = lambda *args, **kwargs: {
    "queueSummary": {"summary": "ok"},
    "preparedTasks": [{"task_id": "self-task-1"}],
    "backlogExport": [],
    "artifactPaths": [],
}

result = runtime_api.bootstrap_self_improvement_backlog({
    "seeds": [
        {"seedId": "bootstrap-core-bug-slice", "targetPaths": ["core/"]},
        {"seedId": "bootstrap-renderer-bug-slice", "targetPaths": ["renderer-src/"]},
    ],
    "pauseExisting": True,
})
print(json.dumps({
    "pausedSeedIds": result.get("pausedSeedIds"),
    "seededIds": [item.get("seedId") for item in result.get("seeded", [])],
    "pausedPayloads": paused,
    "seededPayloads": seeded,
}))
`);

  assert.deepEqual(result.pausedSeedIds, ['batch-docs-seed', 'old-bootstrap-seed']);
  assert.deepEqual(result.seededIds, ['bootstrap-core-bug-slice', 'bootstrap-renderer-bug-slice']);
  assert.equal(result.pausedPayloads.length, 2);
  assert.equal(result.pausedPayloads[0].status, 'paused');
  assert.equal(result.pausedPayloads[1].status, 'paused');
  assert.equal(result.seededPayloads.length, 2);
  assert.equal(result.seededPayloads[0].targetPaths[0], 'core/');
  assert.equal(result.seededPayloads[1].targetPaths[0], 'renderer-src/');
});

test('self-improvement difficulty budget graduates from low to medium to high after trusted passes', () => {
  const result = runPythonJson(`
import json
from backend.agent.core import artifact_service

print(json.dumps({
    "low": artifact_service._preferred_self_improvement_difficulty({
        "status_counts": {"succeeded": 1, "review": 0, "failed": 1},
        "trust_state_counts": {"trusted": 0},
    }),
    "medium": artifact_service._preferred_self_improvement_difficulty({
        "status_counts": {"succeeded": 2, "review": 1, "failed": 1},
        "trust_state_counts": {"trusted": 1},
    }),
    "high": artifact_service._preferred_self_improvement_difficulty({
        "status_counts": {"succeeded": 6, "review": 2, "failed": 1},
        "trust_state_counts": {"trusted": 4},
    }),
}))
`);

  assert.equal(result.low, 'low');
  assert.equal(result.medium, 'medium');
  assert.equal(result.high, 'high');
});

test('prepared self-improvement tasks use stable candidate-based ids instead of stale ordinal ids', () => {
  const result = runPythonJson(`
import json
from pathlib import Path
from backend.agent.core import artifact_service

artifact_service.load_runtime_history_artifacts = lambda *args, **kwargs: []
artifact_service.load_memory = lambda *args, **kwargs: []
artifact_service.load_experiment_dataset = lambda *args, **kwargs: []
artifact_service.load_self_improvement_history = lambda *args, **kwargs: [
    {
        "timestamp": "2026-03-14T21:54:53+00:00",
        "task_id": "self-task-001",
        "candidate_id": "self-seed-old-doc-task",
        "status": "blocked",
        "target_paths": ["docs/assistant_runs/BAT17_status_suggestion.md"],
    }
]
artifact_service.load_self_improvement_seeds = lambda *args, **kwargs: [
    {
        "timestamp": "2026-03-16T10:00:00+00:00",
        "seed_id": "bootstrap-host-bug-slice",
        "status": "active",
        "title": "Tighten self-host runtime control",
        "summary": "Repair the next bounded self-host or scheduler control issue.",
        "objective": "Repair the next bounded self-host or scheduler control issue.",
        "target_paths": ["host/"],
        "requested_by": "bootstrap",
        "priority": "medium",
        "severity": 0,
    }
]
artifact_service._build_self_improvement_candidates_from_memory = lambda *args, **kwargs: []
artifact_service._build_self_improvement_candidates_from_owner_summary = lambda *args, **kwargs: []
artifact_service._build_self_improvement_candidates_from_benchmark = lambda *args, **kwargs: []

summary = artifact_service.summarize_self_improvement_work(Path(r'E:\\\\dev\\\\projects\\\\gosenderr-desktop-agent-PC'))
task = dict(summary.get("prepared_tasks")[0])
print(json.dumps({
    "task_id": task.get("task_id"),
    "status": task.get("status"),
    "ticket_id": dict(task.get("runtime_task") or {}).get("ticket"),
}))
`);

  assert.equal(result.task_id, 'self-task-bootstrap-host-bug-slice');
  assert.equal(result.status, 'prepared');
  assert.equal(result.ticket_id, 'self-bootstrap-host-bug-slice');
});

test('config loader falls back to scalar parsing when PyYAML is unavailable', () => {
  const result = runPythonJson(`
import builtins
import json
import tempfile
from pathlib import Path
from backend.agent.core import config_loader

root = Path(tempfile.mkdtemp(prefix="gos-self-config-"))
(root / "dev_assistant.yaml").write_text(
    "assistant_artifacts_root: E:/dev/projects/gosenderr_dev_offload\\n"
    "assistant_autonomy_mode: self\\n"
    "autopilot_interval_seconds: 900\\n"
    "autopilot_jobs:\\n"
    "  - name: nightly\\n"
    "    cron: \\"0 2 * * *\\"\\n",
    encoding="utf-8",
)

original_import = builtins.__import__
def fake_import(name, *args, **kwargs):
    if name == "yaml":
        raise ImportError("forced-missing-yaml")
    return original_import(name, *args, **kwargs)

builtins.__import__ = fake_import
try:
    payload = config_loader.load_project_config(root)
finally:
    builtins.__import__ = original_import

print(json.dumps({
    "assistant_artifacts_root": payload.get("assistant_artifacts_root"),
    "assistant_autonomy_mode": payload.get("assistant_autonomy_mode"),
    "autopilot_interval_seconds": payload.get("autopilot_interval_seconds"),
    "autopilot_jobs": payload.get("autopilot_jobs"),
}))
`);

  assert.equal(result.assistant_artifacts_root, 'E:/dev/projects/gosenderr_dev_offload');
  assert.equal(result.assistant_autonomy_mode, 'self');
  assert.equal(result.autopilot_interval_seconds, 900);
  assert.equal(result.autopilot_jobs[0].name, 'nightly');
  assert.equal(result.autopilot_jobs[0].cron, '0 2 * * *');
});
