'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const RUNTIME_ROOT = path.join(REPO_ROOT, 'runtime');

function runPythonJson(source, env = {}) {
  const output = childProcess.execFileSync('python', ['-c', source], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...env,
      PYTHONPATH: [RUNTIME_ROOT, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter),
      PROJECT_ROOT: env.PROJECT_ROOT || REPO_ROOT,
    },
    encoding: 'utf8',
  });
  return JSON.parse(String(output || '').trim());
}

test('runtime model routing maps coder and summarizer aliases through existing engine routes', () => {
  const result = runPythonJson(`
import json
from backend.agent.core.model_routing import resolve_agent_model_route, build_agent_model_routing_summary

coder = resolve_agent_model_route("coder")
summarizer = resolve_agent_model_route("summarizer")
summary = build_agent_model_routing_summary()
print(json.dumps({
    "coder_role": coder.role,
    "coder_model_role": coder.model_role,
    "coder_wrapped_profile_role": coder.wrapped_profile_role,
    "coder_task_mode": coder.task_mode,
    "coder_agent": coder.agent,
    "summarizer_role": summarizer.role,
    "summarizer_model_role": summarizer.model_role,
    "summarizer_wrapped_profile_role": summarizer.wrapped_profile_role,
    "summarizer_task_mode": summarizer.task_mode,
    "summary_has_coder": "coder" in summary,
    "summary_has_summarizer": "summarizer" in summary,
    "summary_coder_model_role": summary["coder"]["model_role"],
    "summary_summarizer_model_role": summary["summarizer"]["model_role"],
}))
`);

  assert.equal(result.coder_role, 'coding');
  assert.equal(result.coder_model_role, 'worker');
  assert.equal(result.coder_wrapped_profile_role, 'workspace');
  assert.equal(result.coder_task_mode, 'coder');
  assert.equal(result.coder_agent, 'coder');
  assert.equal(result.summarizer_role, 'release');
  assert.equal(result.summarizer_model_role, 'orchestrator');
  assert.equal(result.summarizer_wrapped_profile_role, 'engine');
  assert.equal(result.summarizer_task_mode, 'summarizer');
  assert.equal(result.summary_has_coder, true);
  assert.equal(result.summary_has_summarizer, true);
  assert.equal(result.summary_coder_model_role, 'worker');
  assert.equal(result.summary_summarizer_model_role, 'orchestrator');
});

test('runtime model routing honors flat assistant task-mode config written by the desktop host', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-routing-config-'));
  try {
    fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), [
      'assistant_task_mode_coder_provider: openai',
      'assistant_task_mode_coder_model: gpt-5.4-pro',
      'assistant_task_mode_summarizer_provider: openai',
      'assistant_task_mode_summarizer_model: gpt-4.1-mini',
    ].join('\n'), 'utf8');

    const result = runPythonJson(`
import json
from pathlib import Path
from backend.agent.core.model_routing import resolve_agent_model_route

root = Path(r"${workspaceRoot.replace(/\\/g, '\\\\')}")
coder = resolve_agent_model_route("implementer", root)
summarizer = resolve_agent_model_route("release", root)
print(json.dumps({
    "coder_provider": coder.provider,
    "coder_model": coder.model,
    "summarizer_provider": summarizer.provider,
    "summarizer_model": summarizer.model,
}))
`, { PROJECT_ROOT: workspaceRoot });

    assert.equal(result.coder_provider, 'openai');
    assert.equal(result.coder_model, 'gpt-5.4-pro');
    assert.equal(result.summarizer_provider, 'openai');
    assert.equal(result.summarizer_model, 'gpt-4.1-mini');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
