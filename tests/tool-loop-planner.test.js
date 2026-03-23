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

test('tool-loop planner turns direct append-section objectives into a bounded edit step for the named file', () => {
  const result = runPythonJson(`
import json
from backend.agent.core.tool_loop import _planner_handler
from backend.agent.core.orchestrator import OrchestrationTask

class FakeOrchestrator:
    def execute_tool(self, agent_name, tool_name, **kwargs):
        if tool_name == "list_tasks":
            return {"ok": True, "todos": [], "count": 0}
        if tool_name == "search_repo":
            return {"ok": True, "matches": ["OWNER_DOCS/01_desktop_app_complete_guide.md"], "ranked_matches": []}
        raise AssertionError(f"unexpected tool: {tool_name}")

task = OrchestrationTask(
    objective="In the lab only, add a short section to OWNER_DOCS/README.md called Autonomous clone workflow with exactly three bullets: start in a self-host lab, keep the main repo untouched, use Stop to cancel active work. Then summarize exactly what changed.",
    ticket=None,
    context={},
)
payload = _planner_handler(FakeOrchestrator(), None, task, {})
step = dict((payload.get("payload") or {}).get("plan", {}).get("steps", [])[0] or {})
print(json.dumps({
    "action": step.get("action"),
    "path": step.get("path"),
    "mode": step.get("mode"),
    "content": step.get("content"),
}))
`);

  assert.equal(result.action, 'edit_file');
  assert.equal(result.path, 'OWNER_DOCS/README.md');
  assert.equal(result.mode, 'append');
  assert.match(String(result.content || ''), /## Autonomous clone workflow/);
  assert.match(String(result.content || ''), /- start in a self-host lab/);
  assert.match(String(result.content || ''), /- keep the main repo untouched/);
  assert.match(String(result.content || ''), /- use Stop to cancel active work/);
});
