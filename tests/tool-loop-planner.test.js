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

  test('tool-loop planner recognizes standalone filenames and append objectives as write work', () => {
    const result = runPythonJson(`
  import json
  from backend.agent.core.tool_loop import _planner_handler
  from backend.agent.core.orchestrator import OrchestrationTask

  class FakeOrchestrator:
    def execute_tool(self, agent_name, tool_name, **kwargs):
      if tool_name == "list_tasks":
        return {"ok": True, "todos": [], "count": 0}
      if tool_name == "search_repo":
        return {"ok": True, "matches": ["core/engine-acceptance.js"], "ranked_matches": []}
      raise AssertionError(f"unexpected tool: {tool_name}")

  task = OrchestrationTask(
    objective="Append a single line LOCAL DEBUG PROOF to README.md without changing anything else.",
    ticket=None,
    context={},
  )
  payload = _planner_handler(FakeOrchestrator(), None, task, {})
  steps = [dict(item) for item in list((payload.get("payload") or {}).get("plan", {}).get("steps", []))]
  print(json.dumps(steps))
  `);

    assert.equal(result[0].action, 'inspect_file');
    assert.equal(result[0].path, 'README.md');
    assert.equal(result[result.length - 1].action, 'synthesize_edit');
    assert.equal(result[result.length - 1].path, 'README.md');
  });

  test('tool-loop implementer can synthesize a new file when the target does not exist yet', () => {
    const result = runPythonJson(`
  import json
  from backend.agent.core.tool_loop import _implementer_handler

  class FakeProvider:
    def propose_patch(self, prompt):
      return "# Local Engine Proof\\n\\nGenerated in a missing-file synthesize edit path.\\n"

  class FakeOrchestrator:
    def __init__(self):
      self.calls = []
    def execute_tool(self, agent_name, tool_name, **kwargs):
      self.calls.append({"tool": tool_name, "kwargs": dict(kwargs)})
      if tool_name == "read_file":
        return {"ok": False, "error": "[Errno 2] No such file or directory: 'LOCAL_ENGINE_PROOF.md'"}
      if tool_name == "edit_file":
        return {"ok": True, "path": kwargs.get("path"), "mode": kwargs.get("mode"), "bytes_written": len(str(kwargs.get("content") or "").encode("utf-8"))}
      raise AssertionError(f"unexpected tool: {tool_name}")
    def pending_approvals(self):
      return []
    def _active_context(self):
      return {"provider": FakeProvider(), "editor_context": {}}

  orchestrator = FakeOrchestrator()
  payload = {
    "task": {"objective": "Create a new file named LOCAL_ENGINE_PROOF.md with a short proof note."},
    "plan": {"steps": [{"action": "synthesize_edit", "path": "LOCAL_ENGINE_PROOF.md"}]},
  }
  result = _implementer_handler(orchestrator, None, None, payload)
  execution = list((result.get("payload") or {}).get("execution") or [])
  last = dict(execution[-1] or {})
  print(json.dumps({
    "status": result.get("status"),
    "toolCalls": orchestrator.calls,
    "lastResult": last.get("result"),
  }))
  `);

    assert.equal(result.status, 'completed');
    assert.equal(result.toolCalls[0].tool, 'read_file');
    assert.equal(result.toolCalls[1].tool, 'edit_file');
    assert.equal(result.lastResult.path, 'LOCAL_ENGINE_PROOF.md');
    assert.equal(result.lastResult.mode, 'replace');
  });

    test('tool-loop implementer normalizes simple shell append responses into updated file contents', () => {
      const result = runPythonJson(`
    import json
    from backend.agent.core.tool_loop import _implementer_handler

    class FakeProvider:
      def propose_patch(self, prompt):
        return 'echo "LOCAL DEBUG PROOF" >> README.md'

    class FakeOrchestrator:
      def __init__(self):
        self.calls = []
      def execute_tool(self, agent_name, tool_name, **kwargs):
        self.calls.append({"tool": tool_name, "kwargs": dict(kwargs)})
        if tool_name == "read_file":
          return {"ok": True, "path": "README.md", "content": "# Title\\n\\nBody\\n"}
        if tool_name == "edit_file":
          return {"ok": True, "path": kwargs.get("path"), "mode": kwargs.get("mode"), "content": kwargs.get("content")}
        raise AssertionError(f"unexpected tool: {tool_name}")
      def pending_approvals(self):
        return []
      def _active_context(self):
        return {"provider": FakeProvider(), "editor_context": {}}

    orchestrator = FakeOrchestrator()
    payload = {
      "task": {"objective": "Append a single line LOCAL DEBUG PROOF to README.md without changing anything else."},
      "plan": {"steps": [{"action": "synthesize_edit", "path": "README.md"}]},
    }
    result = _implementer_handler(orchestrator, None, None, payload)
    execution = list((result.get("payload") or {}).get("execution") or [])
    last = dict(execution[-1] or {})
    print(json.dumps({
      "status": result.get("status"),
      "toolCalls": orchestrator.calls,
      "lastResult": last.get("result"),
    }))
    `);

      assert.equal(result.status, 'completed');
      assert.equal(result.toolCalls[1].tool, 'edit_file');
      assert.match(String(result.lastResult.content || ''), /^# Title/m);
      assert.match(String(result.lastResult.content || ''), /LOCAL DEBUG PROOF/);
    });

      test('tool-loop implementer rejects markdown review prose when no code follows the suggestion header', () => {
        const result = runPythonJson(`
      import json
      from backend.agent.core.tool_loop import _implementer_handler

      class FakeProvider:
        def propose_patch(self, prompt):
          return """### Suggested Fix:\\n\\nUpdate the RECOMMENDED_LOCAL_MODELS array to replace the current wording with the specified live, registered, and import needed tags.\\n\\n**Minimal Change:**"""

      class FakeOrchestrator:
        def __init__(self):
          self.calls = []
        def execute_tool(self, agent_name, tool_name, **kwargs):
          self.calls.append({"tool": tool_name, "kwargs": dict(kwargs)})
          if tool_name == "read_file":
            return {"ok": True, "path": "core/training-tuning.js", "content": "'use strict';\\n"}
          if tool_name == "edit_file":
            return {"ok": True, "path": kwargs.get("path"), "mode": kwargs.get("mode"), "content": kwargs.get("content")}
          raise AssertionError(f"unexpected tool: {tool_name}")
        def pending_approvals(self):
          return []
        def _active_context(self):
          return {"provider": FakeProvider(), "editor_context": {"active_file_path": "core/training-tuning.js", "open_files": ["core/training-tuning.js"]}}

      orchestrator = FakeOrchestrator()
      payload = {
        "task": {"objective": "Repair the remaining wording drift in core/training-tuning.js only."},
        "plan": {"steps": [{"action": "synthesize_edit", "path": "core/training-tuning.js"}]},
      }
      result = _implementer_handler(orchestrator, None, None, payload)
      execution = list((result.get("payload") or {}).get("execution") or [])
      last = dict(execution[-1] or {})
      print(json.dumps({
        "status": result.get("status"),
        "toolCalls": orchestrator.calls,
        "lastResult": last.get("result"),
      }))
        `);

        assert.equal(result.status, 'failed');
        assert.equal(result.toolCalls.length, 1);
        assert.equal(result.toolCalls[0].tool, 'read_file');
        assert.match(String(result.lastResult.error || ''), /did not normalize into file contents/i);
      });

      test('tool-loop implementer normalizes shell heredoc file writes into updated file contents', () => {
        const result = runPythonJson(`
      import json
      from backend.agent.core.tool_loop import _implementer_handler

      class FakeProvider:
        def propose_patch(self, prompt):
          return "cat <<'EOF' > README.md\\n# Title\\n\\nBody\\n\\nLOCAL DEBUG PROOF\\nEOF"

      class FakeOrchestrator:
        def __init__(self):
          self.calls = []
        def execute_tool(self, agent_name, tool_name, **kwargs):
          self.calls.append({"tool": tool_name, "kwargs": dict(kwargs)})
          if tool_name == "read_file":
            return {"ok": True, "path": "README.md", "content": "# Title\\n\\nBody\\n"}
          if tool_name == "edit_file":
            return {"ok": True, "path": kwargs.get("path"), "mode": kwargs.get("mode"), "content": kwargs.get("content")}
          raise AssertionError(f"unexpected tool: {tool_name}")
        def pending_approvals(self):
          return []
        def _active_context(self):
          return {"provider": FakeProvider(), "editor_context": {}}

      orchestrator = FakeOrchestrator()
      payload = {
        "task": {"objective": "Update README.md with LOCAL DEBUG PROOF."},
        "plan": {"steps": [{"action": "synthesize_edit", "path": "README.md"}]},
      }
      result = _implementer_handler(orchestrator, None, None, payload)
      execution = list((result.get("payload") or {}).get("execution") or [])
      last = dict(execution[-1] or {})
      print(json.dumps({
        "status": result.get("status"),
        "lastResult": last.get("result"),
      }))
      `.replace(/^ {6}/gm, ''));

        assert.equal(result.status, 'completed');
        assert.match(String(result.lastResult.content || ''), /^# Title/m);
        assert.match(String(result.lastResult.content || ''), /LOCAL DEBUG PROOF/);
        assert.doesNotMatch(String(result.lastResult.content || ''), /^cat <</m);
      });

      test('tool-loop implementer strips updated-file preambles before writing synthesized contents', () => {
        const result = runPythonJson(`
      import json
      from backend.agent.core.tool_loop import _implementer_handler

      class FakeProvider:
        def propose_patch(self, prompt):
          return "Here is the updated file:\\n\\nREADME.md\\n---\\n# Title\\n\\nBody\\n\\nLOCAL DEBUG PROOF\\n"

      class FakeOrchestrator:
        def __init__(self):
          self.calls = []
        def execute_tool(self, agent_name, tool_name, **kwargs):
          self.calls.append({"tool": tool_name, "kwargs": dict(kwargs)})
          if tool_name == "read_file":
            return {"ok": True, "path": "README.md", "content": "# Title\\n\\nBody\\n"}
          if tool_name == "edit_file":
            return {"ok": True, "path": kwargs.get("path"), "mode": kwargs.get("mode"), "content": kwargs.get("content")}
          raise AssertionError(f"unexpected tool: {tool_name}")
        def pending_approvals(self):
          return []
        def _active_context(self):
          return {"provider": FakeProvider(), "editor_context": {}}

      orchestrator = FakeOrchestrator()
      payload = {
        "task": {"objective": "Update README.md with LOCAL DEBUG PROOF."},
        "plan": {"steps": [{"action": "synthesize_edit", "path": "README.md"}]},
      }
      result = _implementer_handler(orchestrator, None, None, payload)
      execution = list((result.get("payload") or {}).get("execution") or [])
      last = dict(execution[-1] or {})
      print(json.dumps({
        "status": result.get("status"),
        "lastResult": last.get("result"),
      }))
      `.replace(/^ {6}/gm, ''));

        assert.equal(result.status, 'completed');
        assert.doesNotMatch(String(result.lastResult.content || ''), /Here is the updated file/i);
        assert.doesNotMatch(String(result.lastResult.content || ''), /^README\.md$/m);
        assert.match(String(result.lastResult.content || ''), /LOCAL DEBUG PROOF/);
      });

      test('tool-loop implementer strips echoed instruction lines and control tokens from repair output', () => {
        const result = runPythonJson(`
      import json
      from backend.agent.core.tool_loop import _implementer_handler

      class FakeProvider:
        def propose_patch(self, prompt):
          return """Do not include any markdown or additional text.

  // Your repair suggestion here

  'use strict';

  function sum(left, right) {
    return left + right;
  }

  function describeTask(name) {
    const taskName = String(name || '').trim() || 'unnamed';
    return 'Task: ' + taskName;
  }

  module.exports = {
    sum,
    describeTask,
  };
  <|im_start|>'t"""

      class FakeOrchestrator:
        def __init__(self):
          self.calls = []
        def execute_tool(self, agent_name, tool_name, **kwargs):
          self.calls.append({"tool": tool_name, "kwargs": dict(kwargs)})
          if tool_name == "read_file":
            return {"ok": True, "path": "src/calculator.js", "content": """'use strict';

  function sum(left, right) {
    return left - right;
  }

  function describeTask(name) {
    return 'Task: ' + (String(name || '').trim() || 'unnamed');
  }

  module.exports = {
    sum,
    describeTask,
  };
  """}
          if tool_name == "edit_file":
            return {"ok": True, "path": kwargs.get("path"), "mode": kwargs.get("mode"), "content": kwargs.get("content")}
          raise AssertionError(f"unexpected tool: {tool_name}")
        def pending_approvals(self):
          return []
        def _active_context(self):
          return {"provider": FakeProvider(), "editor_context": {"active_file_path": "test/calculator.test.js", "open_files": ["test/calculator.test.js"]}}

      orchestrator = FakeOrchestrator()
      payload = {
        "task": {"objective": "Repair the latest failed bounded run and rerun the smallest relevant validation."},
        "plan": {"steps": [{"action": "synthesize_edit", "path": "src/calculator.js"}]},
      }
      result = _implementer_handler(orchestrator, None, None, payload)
      execution = list((result.get("payload") or {}).get("execution") or [])
      last = dict(execution[-1] or {})
      print(json.dumps({
        "status": result.get("status"),
        "lastResult": last.get("result"),
      }))
      `.replace(/^ {6}/gm, ''));

        assert.equal(result.status, 'completed');
        assert.doesNotMatch(String(result.lastResult.content || ''), /Do not include any markdown/i);
        assert.doesNotMatch(String(result.lastResult.content || ''), /Your repair suggestion here/i);
        assert.doesNotMatch(String(result.lastResult.content || ''), /<\|im_start\|>/i);
        assert.match(String(result.lastResult.content || ''), /return left \+ right;/);
      });

      test('tool-loop implementer can infer a bounded append from a short local-model line response', () => {
        const result = runPythonJson(`
      import json
      from backend.agent.core.tool_loop import _implementer_handler

      class FakeProvider:
        def propose_patch(self, prompt):
          return '<|im_start|>\\nLOCAL DEBUG PROOF'

      class FakeOrchestrator:
        def __init__(self):
          self.calls = []
        def execute_tool(self, agent_name, tool_name, **kwargs):
          self.calls.append({"tool": tool_name, "kwargs": dict(kwargs)})
          if tool_name == "read_file":
            return {"ok": True, "path": "README.md", "content": "# Title\\n\\nBody\\n"}
          if tool_name == "edit_file":
            return {"ok": True, "path": kwargs.get("path"), "mode": kwargs.get("mode"), "content": kwargs.get("content")}
          raise AssertionError(f"unexpected tool: {tool_name}")
        def pending_approvals(self):
          return []
        def _active_context(self):
          return {"provider": FakeProvider(), "editor_context": {}}

      orchestrator = FakeOrchestrator()
      payload = {
        "task": {"objective": "Append a single line LOCAL DEBUG PROOF to README.md without changing anything else."},
        "plan": {"steps": [{"action": "synthesize_edit", "path": "README.md"}]},
      }
      result = _implementer_handler(orchestrator, None, None, payload)
      execution = list((result.get("payload") or {}).get("execution") or [])
      last = dict(execution[-1] or {})
      print(json.dumps({
        "status": result.get("status"),
        "lastResult": last.get("result"),
      }))
      `);

        assert.equal(result.status, 'completed');
        assert.match(String(result.lastResult.content || ''), /^# Title/m);
        assert.match(String(result.lastResult.content || ''), /LOCAL DEBUG PROOF/);
      });

      test('tool-loop implementer preserves raw candidate patch diagnostics when synthesized edit normalization fails', () => {
        const result = runPythonJson(`
      import json
      from backend.agent.core.tool_loop import _implementer_handler

      class FakeProvider:
        def propose_patch(self, prompt):
          return 'bash echo LOCAL DEBUG PROOF >> README.md'

      class FakeOrchestrator:
        def __init__(self):
          self.calls = []
        def execute_tool(self, agent_name, tool_name, **kwargs):
          self.calls.append({"tool": tool_name, "kwargs": dict(kwargs)})
          if tool_name == "read_file":
            return {"ok": True, "path": "README.md", "content": "# Title\\n\\nBody\\n"}
          raise AssertionError(f"unexpected tool: {tool_name}")
        def pending_approvals(self):
          return []
        def _active_context(self):
          return {"provider": FakeProvider(), "editor_context": {}}

      orchestrator = FakeOrchestrator()
      payload = {
        "task": {"objective": "Append a single line LOCAL DEBUG PROOF to README.md without changing anything else."},
        "plan": {"steps": [{"action": "synthesize_edit", "path": "README.md"}]},
      }
      result = _implementer_handler(orchestrator, None, None, payload)
      execution = list((result.get("payload") or {}).get("execution") or [])
      last = dict(execution[-1] or {})
      print(json.dumps({
        "status": result.get("status"),
        "lastResult": last.get("result"),
      }))
      `);

        assert.equal(result.status, 'failed');
        assert.equal(result.lastResult.ok, false);
        assert.match(String(result.lastResult.error || ''), /shell command|did not normalize/i);
        assert.equal(Array.isArray(result.lastResult.selection.candidates), true);
        assert.match(String(result.lastResult.selection.candidates[0].patch || ''), /bash echo LOCAL DEBUG PROOF/);
      });

      test('tool-loop validator fails the run when rerun output contains a syntax error', () => {
        const result = runPythonJson(`
      import json
      from backend.agent.core.tool_loop import _validator_handler
      from backend.agent.core.orchestrator import OrchestrationTask

      class FakeOrchestrator:
        def execute_tool(self, agent_name, tool_name, **kwargs):
          if tool_name == "git_status":
            return {"ok": True, "dirty": True}
          if tool_name == "run_command":
            return {
              "ok": False,
              "returncode": 1,
              "stdout": "> gosenderr-desktop-agent-pc@0.1.6 test\\n> node --test\\n\\nE:/lab/core/training-tuning.js:1\\n### Suggested Fix:\\n^\\n\\nSyntaxError: Invalid or unexpected token\\n",
              "stderr": "",
            }
          raise AssertionError(f"unexpected tool: {tool_name}")
        def pending_approvals(self):
          return []

      task = OrchestrationTask(
        objective="Repair the remaining wording drift and rerun the smallest relevant proof.",
        ticket=None,
        context={"project_root": ".", "runtime_context": {"failure_output": {"checks": [{"command": "npm test"}]}}},
      )
      result = _validator_handler(FakeOrchestrator(), None, task, {})
      print(json.dumps(result))
      `);

        assert.equal(result.status, 'failed');
        assert.equal(result.payload.validation.valid, false);
        assert.match(String(result.summary || ''), /training-tuning\.js:1|SyntaxError/i);
      });

      test('tool-loop implementer can fall back to a stronger file-only prompt when weaker variants return a shell command or empty patch', () => {
        const result = runPythonJson(`
      import json
      from backend.agent.core.tool_loop import _implementer_handler

      class FakeProvider:
        def propose_patch(self, prompt):
          if 'Do not describe the fix.' in prompt:
            return """'use strict';

const READY_LABEL = 'registered';

module.exports = { READY_LABEL };
"""
          if 'Return the full updated file contents with no markdown fences.' in prompt:
            return ''
          return 'bash echo registered > readiness.js'

      class FakeOrchestrator:
        def __init__(self):
          self.calls = []
        def execute_tool(self, agent_name, tool_name, **kwargs):
          self.calls.append({"tool": tool_name, "kwargs": dict(kwargs)})
          if tool_name == "read_file":
            return {"ok": True, "path": "readiness.js", "content": """'use strict';

const READY_LABEL = 'live';

module.exports = { READY_LABEL };
"""}
          if tool_name == "edit_file":
            return {"ok": True, "path": kwargs.get("path"), "mode": kwargs.get("mode"), "content": kwargs.get("content")}
          raise AssertionError(f"unexpected tool: {tool_name}")
        def pending_approvals(self):
          return []
        def _active_context(self):
          return {"provider": FakeProvider(), "editor_context": {}}

      orchestrator = FakeOrchestrator()
      payload = {
        "task": {"objective": "Update readiness.js so registered is used for stored inventory and live stays reserved for runtime availability."},
        "plan": {"steps": [{"action": "synthesize_edit", "path": "readiness.js"}]},
      }
      result = _implementer_handler(orchestrator, None, None, payload)
      execution = list((result.get("payload") or {}).get("execution") or [])
      last = dict(execution[-1] or {})
      print(json.dumps({
        "status": result.get("status"),
        "lastResult": last.get("result"),
      }))
      `.replace(/^ {6}/gm, ''));

        assert.equal(result.status, 'completed');
        assert.match(String(result.lastResult.content || ''), /registered/);
        assert.doesNotMatch(String(result.lastResult.content || ''), /bash echo/);
      });

        test('build_review_summary captures failed synthesized-edit candidate artifacts without requiring manual review', () => {
          const result = runPythonJson(`
        import json
        from backend.agent.core.patch_review import build_review_summary

        summary = build_review_summary(
          execution_results=[{
            "ok": False,
            "path": "README.md",
            "error": "patch candidate returned a shell command instead of file contents",
            "selection": {
              "best_candidate": {
                "label": "strict-tool-loop-edit",
                "score": 0.42,
                "reasons": ["non-empty patch"],
                "preview": 'echo "LOCAL DEBUG PROOF" >> README.md',
              },
              "candidates": [{
                "label": "strict-tool-loop-edit",
                "score": 0.42,
                "reasons": ["non-empty patch"],
                "preview": 'echo "LOCAL DEBUG PROOF" >> README.md',
                "patch": 'echo "LOCAL DEBUG PROOF" >> README.md',
              }],
            },
          }],
          runtime_context={"run_id": "run-1", "task_id": "task-1", "ticket": "BAT-1"},
        )
        print(json.dumps({
          "requiresManualReview": summary.get("requires_manual_review"),
          "failureCount": summary.get("synthesized_edit_failure_count"),
          "artifactKind": ((summary.get("review_artifacts") or [{}])[0].get("kind") or ""),
          "artifactPatch": (((summary.get("review_artifacts") or [{}])[0].get("metadata") or {}).get("candidates") or [{}])[0].get("patch") or "",
        }))
        `.replace(/^ {6}/gm, ''));

          assert.equal(result.requiresManualReview, false);
          assert.equal(result.failureCount, 1);
          assert.equal(result.artifactKind, 'synthesized-edit-failure');
          assert.match(String(result.artifactPatch || ''), /LOCAL DEBUG PROOF/);
        });

      test('tool-loop implementer surfaces provider exceptions instead of collapsing them into empty patch failures', () => {
        const result = runPythonJson(`
      import json
      from backend.agent.core.tool_loop import _implementer_handler

      class FakeProvider:
        def propose_patch(self, prompt):
          raise RuntimeError('Ollama request failed (400): model requires more system memory (47.8 GiB) than is available (18.7 GiB)')

      class FakeOrchestrator:
        def __init__(self):
          self.calls = []
        def execute_tool(self, agent_name, tool_name, **kwargs):
          self.calls.append({"tool": tool_name, "kwargs": dict(kwargs)})
          if tool_name == "read_file":
            return {"ok": True, "path": "src/calculator.js", "content": "module.exports = {\\n  sum(left, right) {\\n    return left - right;\\n  },\\n};\\n"}
          raise AssertionError(f"unexpected tool: {tool_name}")
        def pending_approvals(self):
          return []
        def _active_context(self):
          return {"provider": FakeProvider(), "editor_context": {"active_file_path": "test/calculator.test.js", "open_files": ["test/calculator.test.js"]}}

      orchestrator = FakeOrchestrator()
      payload = {
        "task": {"objective": "Repair the latest failed bounded run and rerun the smallest relevant validation."},
        "plan": {"steps": [{"action": "synthesize_edit", "path": "src/calculator.js"}]},
      }
      result = _implementer_handler(orchestrator, None, None, payload)
      execution = list((result.get("payload") or {}).get("execution") or [])
      last = dict(execution[-1] or {})
      print(json.dumps({
        "status": result.get("status"),
        "lastResult": last.get("result"),
      }))
      `.replace(/^ {6}/gm, ''));

        assert.equal(result.status, 'failed');
        assert.equal(result.lastResult.ok, false);
        assert.match(String(result.lastResult.error || ''), /requires more system memory/i);
        assert.match(
          String((result.lastResult.selection.candidates[0].reasons || []).join(' ') || ''),
          /provider error/i,
        );
      });

      test('ollama provider preserves HTTP error bodies in raised exceptions', () => {
        const result = runPythonJson(`
      import io
      import json
      from urllib import error
      from backend.agent.core.providers.base import ProviderConfig
      from backend.agent.core.providers.ollama_provider import OllamaProvider

      provider = OllamaProvider(ProviderConfig(ollama_model='deepseek-coder-v2-lite-instruct:q4-k-m'))

      def fail(path, payload):
        raise error.HTTPError(
          'http://localhost:11434/api/generate',
          400,
          'Bad Request',
          None,
          io.BytesIO(b'{"error":"model requires more system memory (47.8 GiB) than is available (18.7 GiB)"}')
        )

      provider._post_json = fail
      try:
        provider.propose_patch('repair the file')
      except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
      else:
        print(json.dumps({"ok": True}))
      `);

        assert.equal(result.ok, false);
        assert.match(String(result.error || ''), /requires more system memory/i);
        assert.match(String(result.error || ''), /Ollama request failed \(400\)/i);
      });

      test('tool-loop preflight blocks local mutation routes before execution when the selected model cannot load', () => {
        const result = runPythonJson(`
      import json
      from pathlib import Path
      from backend.agent.core.approval import ApprovalGate
      from backend.agent.core.tool_loop import run_tool_loop

      class FakeProvider:
        def preflight_check(self, **kwargs):
          return {"ok": False, "message": "Ollama request failed (500): model requires more system memory (47.8 GiB) than is available (19.0 GiB)"}

      result = run_tool_loop(
        project_root=Path.cwd(),
        objective='Repair the latest failed bounded run and rerun the smallest relevant validation.',
        context={
          'task_mode': 'repair',
          'lane_id': 'repair-fast',
          'steps': [
            {'action': 'synthesize_edit', 'path': 'src/calculator.js'},
          ],
        },
        approval_gate=ApprovalGate(require_controlled=False, require_privileged=False),
        provider=FakeProvider(),
      )
      print(json.dumps({
        'ok': result.get('ok'),
        'status': result.get('status'),
        'summary': result.get('summary'),
        'failureKind': ((result.get('runtime_failure') or {}).get('kind') or ''),
        'interruptAction': ((result.get('runtime_result') or {}).get('interrupt_request') or {}).get('requested_action'),
      }))
      `);

        assert.equal(result.ok, false);
        assert.equal(result.status, 'failed');
        assert.match(String(result.summary || ''), /requires more system memory/i);
        assert.equal(result.failureKind, 'route-not-ready');
        assert.equal(result.interruptAction, 'open-trace');
      });

      test('tool-loop implementer recovers from malformed top candidate when an alternate loose fenced patch contains valid file contents', () => {
        const result = runPythonJson(`
      import json
      from backend.agent.core.tool_loop import _implementer_handler

      class FakeProvider:
        def __init__(self):
          self.calls = 0
        def propose_patch(self, prompt):
          fence = chr(96) * 3
          self.calls += 1
          if self.calls == 1:
            return f'{fence} {fence} {fence}'
          return f"""No markdown, no comments. {fence} 'use strict';

function sum(left, right) {{
  return left + right;
}}

function describeTask(name) {{
  return 'Task: ' + (String(name || '').trim() || 'unnamed');
}}

module.exports = {{
  sum,
  describeTask,
}};
{fence}"""

      class FakeOrchestrator:
        def __init__(self):
          self.calls = []
        def execute_tool(self, agent_name, tool_name, **kwargs):
          self.calls.append({"tool": tool_name, "kwargs": dict(kwargs)})
          if tool_name == "read_file":
            return {"ok": True, "path": "src/calculator.js", "content": """'use strict';

function sum(left, right) {
  return left - right;
}

function describeTask(name) {
  return 'Task: ' + (String(name || '').trim() || 'unnamed');
}

module.exports = {
  sum,
  describeTask,
};
"""}
          if tool_name == "edit_file":
            return {"ok": True, "path": kwargs.get("path"), "mode": kwargs.get("mode"), "content": kwargs.get("content")}
          raise AssertionError(f"unexpected tool: {tool_name}")
        def pending_approvals(self):
          return []
        def _active_context(self):
          return {"provider": FakeProvider(), "editor_context": {"active_file_path": "test/calculator.test.js", "open_files": ["test/calculator.test.js"]}}

      orchestrator = FakeOrchestrator()
      payload = {
        "task": {"objective": "Repair the latest failed bounded run and rerun the smallest relevant validation."},
        "plan": {"steps": [{"action": "synthesize_edit", "path": "src/calculator.js"}]},
      }
      result = _implementer_handler(orchestrator, None, None, payload)
      execution = list((result.get("payload") or {}).get("execution") or [])
      last = dict(execution[-1] or {})
      print(json.dumps({
        "status": result.get("status"),
        "toolCalls": orchestrator.calls,
        "lastResult": last.get("result"),
      }))
        `.replace(/^ {6}/gm, ''));

        assert.equal(result.status, 'completed');
        assert.equal(result.toolCalls[1].tool, 'edit_file');
        assert.equal(result.lastResult.ok, true);
        assert.match(String(result.lastResult.content || ''), /return left \+ right;/);
      });
