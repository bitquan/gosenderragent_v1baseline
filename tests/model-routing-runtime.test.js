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

test('runtime model routing keeps Qwen low-headroom fallbacks on worker lanes', () => {
  const result = runPythonJson(`
import json
from backend.agent.core.model_routing import resolve_agent_model_route

implementer = resolve_agent_model_route("implementer")
repair = resolve_agent_model_route("repair")
print(json.dumps({
    "implementer_model": implementer.model,
    "implementer_fallback_model": implementer.fallback_model,
    "repair_model": repair.model,
    "repair_fallback_model": repair.fallback_model,
}))
`);

  assert.equal(result.implementer_model, 'qwen2.5-coder:14b');
  assert.equal(result.implementer_fallback_model, 'qwen2.5-coder:3b');
  assert.equal(result.repair_model, 'qwen2.5-coder:7b');
  assert.equal(result.repair_fallback_model, 'qwen2.5-coder:3b');
});

test('runtime model routing keeps default fallback providers on local routes', () => {
  const result = runPythonJson(`
import json
from backend.agent.core.model_routing import resolve_agent_model_route

planner = resolve_agent_model_route("planner")
implementer = resolve_agent_model_route("implementer")
validator = resolve_agent_model_route("validator")
repair = resolve_agent_model_route("repair")
release = resolve_agent_model_route("release")
print(json.dumps({
    "planner_fallback_provider": planner.fallback_provider,
    "planner_fallback_model": planner.fallback_model,
    "implementer_fallback_provider": implementer.fallback_provider,
    "validator_fallback_provider": validator.fallback_provider,
    "validator_fallback_model": validator.fallback_model,
    "repair_fallback_provider": repair.fallback_provider,
    "release_fallback_provider": release.fallback_provider,
    "release_fallback_model": release.fallback_model,
}))
`);

  assert.equal(result.planner_fallback_provider, 'ollama');
  assert.equal(result.planner_fallback_model, 'qwen2.5-coder:14b');
  assert.equal(result.implementer_fallback_provider, 'ollama');
  assert.equal(result.validator_fallback_provider, 'ollama');
  assert.equal(result.validator_fallback_model, 'qwen2.5-coder:14b');
  assert.equal(result.repair_fallback_provider, 'ollama');
  assert.equal(result.release_fallback_provider, 'ollama');
  assert.equal(result.release_fallback_model, 'qwen2.5-coder:14b');
});

test('runtime model routing honors flat assistant task-mode config written by the desktop host', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-routing-config-'));
  try {
    fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), [
      'assistant_task_mode_repair_provider: ollama',
      'assistant_task_mode_repair_model: qwen2.5-coder:7b',
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
repair = resolve_agent_model_route("repair", root)
coder = resolve_agent_model_route("implementer", root)
summarizer = resolve_agent_model_route("release", root)
print(json.dumps({
  "repair_provider": repair.provider,
  "repair_model": repair.model,
    "coder_provider": coder.provider,
    "coder_model": coder.model,
    "summarizer_provider": summarizer.provider,
    "summarizer_model": summarizer.model,
}))
`, { PROJECT_ROOT: workspaceRoot });

  assert.equal(result.repair_provider, 'ollama');
  assert.equal(result.repair_model, 'qwen2.5-coder:7b');
    assert.equal(result.coder_provider, 'openai');
    assert.equal(result.coder_model, 'gpt-5.4-pro');
    assert.equal(result.summarizer_provider, 'openai');
    assert.equal(result.summarizer_model, 'gpt-4.1-mini');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
