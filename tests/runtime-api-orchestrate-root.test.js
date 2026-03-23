'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const os = require('os');
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

test('runtime_api orchestrate executes against the selected lab root instead of the default repo root', () => {
  const labRoot = path.join(os.tmpdir(), `gos-orchestrate-lab-${process.pid}-${Date.now()}`);
  const result = runPythonJson(`
import json
from pathlib import Path
from backend.agent.runtime import runtime_api

captured = {}

def fake_run_tool_loop(*, project_root, objective, ticket=None, context=None, approval_gate=None, max_steps=10):
    captured["project_root"] = str(project_root)
    captured["context_project_root"] = str((context or {}).get("project_root") or "")
    captured["host_boundary"] = dict((context or {}).get("host_boundary") or {})
    return {
        "ok": True,
        "review_summary": {},
        "run_summary": {"summary": "ok"},
        "test_summary": {},
        "runtime_context": {"changed_files": []},
        "runtime_task": {"task_mode": "planner"},
        "runtime_run": {"run_id": "run-lab", "current_stage": "tool-loop"},
        "runtime_result": {"status": "succeeded", "final_state": "succeeded"},
        "runtime_failure": {},
        "review_state": {},
        "review_requests": [],
        "recommended_actions": [],
        "pending_approvals": [],
        "artifact_paths": [],
    }

runtime_api.run_tool_loop = fake_run_tool_loop
lab_root = Path(${JSON.stringify(labRoot)})
lab_root.mkdir(parents=True, exist_ok=True)
result = runtime_api.orchestrate({
    "objective": "Make a lab-only edit",
    "targetWorkspaceRoot": str(lab_root),
    "hostBoundary": {"project_root": str(lab_root)},
    "approvalGated": False,
    "approvalProtectedOnly": False,
})
print(json.dumps({
    "ok": result.get("ok"),
    "projectRoot": result.get("projectRoot"),
    "capturedProjectRoot": captured.get("project_root"),
    "capturedContextProjectRoot": captured.get("context_project_root"),
    "capturedBoundaryProjectRoot": captured.get("host_boundary", {}).get("project_root"),
}))
`);

  assert.equal(result.ok, true);
  assert.equal(path.resolve(result.projectRoot), path.resolve(labRoot));
  assert.equal(path.resolve(result.capturedProjectRoot), path.resolve(labRoot));
  assert.equal(path.resolve(result.capturedContextProjectRoot), path.resolve(labRoot));
  assert.equal(path.resolve(result.capturedBoundaryProjectRoot), path.resolve(labRoot));
});
