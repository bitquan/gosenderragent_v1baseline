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

test('training handoff carries GS-Dev-1 metadata for selected runs', () => {
  const result = runPythonJson(`
import json
from backend.agent.core.artifact_service import build_training_handoff_from_dataset

benchmark_summary = {
    "dataset_path": "dataset.jsonl",
    "total_runs": 1,
    "recommended_next_strategy": "repair-first",
    "recommended_next_action": "resolve-review-queue",
    "strategy_summaries": [],
    "repeated_blockers": [],
    "metadata": {
        "model_profile_counts": {"gs-dev-1-default": 1},
        "base_model_counts": {"qwen2.5-coder:14b": 1},
        "task_mode_counts": {"coder": 1},
        "provider_source_counts": {"ollama": 1},
    },
}
rows = [{
    "experiment_run": {
        "experiment_id": "exp-1",
        "ticket": "BAT<1>",
        "strategy": "repair-first",
        "training_signals": {},
        "metadata": {
            "model_profile_id": "gs-dev-1-default",
            "base_model": "qwen2.5-coder:14b",
            "task_mode": "coder",
            "provider_source": "ollama",
        },
    },
    "experiment_scorecard": {"status": "succeeded", "final_score": 92, "review_required": False},
}]
handoff = build_training_handoff_from_dataset(benchmark_summary, rows, export_path="handoff.json")
selected = handoff["selected_runs"][0]
print(json.dumps({
    "model_profile_id": selected.get("model_profile_id"),
    "base_model": selected.get("base_model"),
    "task_mode": selected.get("task_mode"),
    "provider_source": selected.get("provider_source"),
    "metadata_task_mode_counts": handoff.get("metadata", {}).get("task_mode_counts", {}),
}))
`);

  assert.equal(result.model_profile_id, 'gs-dev-1-default');
  assert.equal(result.base_model, 'qwen2.5-coder:14b');
  assert.equal(result.task_mode, 'coder');
  assert.equal(result.provider_source, 'ollama');
  assert.deepEqual(result.metadata_task_mode_counts, { coder: 1 });
});
