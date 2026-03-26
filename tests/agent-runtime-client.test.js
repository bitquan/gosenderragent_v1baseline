'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AgentRuntimeClient,
  buildRuntimeStartFailure,
  resolvePythonCandidates,
} = require('../shared-runtime/agent-runtime-client');

test('resolvePythonCandidates prefers Windows runtime venv paths before generic fallbacks', () => {
  const candidates = resolvePythonCandidates(
    'E:\\dev\\projects\\gosenderr-desktop-agent-PC',
    'runtime\\.venv\\Scripts\\python.exe',
    'E:\\dev\\projects\\gosenderr-desktop-agent-PC\\runtime',
  );

  assert.equal(candidates[0], 'E:\\dev\\projects\\gosenderr-desktop-agent-PC\\runtime\\.venv\\Scripts\\python.exe');
  assert.ok(candidates.includes('E:\\dev\\projects\\gosenderr-desktop-agent-PC\\.venv\\Scripts\\python.exe'));
  assert.ok(candidates.includes('E:\\dev\\projects\\gosenderr-desktop-agent-PC\\runtime\\.venv\\bin\\python'));
  assert.ok(candidates.includes('E:\\dev\\projects\\gosenderr-desktop-agent-PC\\runtime\\.venv\\Scripts\\python.exe'));
  assert.ok(candidates.indexOf('E:\\dev\\projects\\gosenderr-desktop-agent-PC\\.venv\\Scripts\\python.exe') < candidates.indexOf('py.exe'));
  assert.ok(candidates.includes('py.exe'));
  assert.ok(candidates.includes('python.exe'));
  assert.ok(candidates.includes('python'));
});

test('buildRuntimeStartFailure returns a structured runtime failure payload', async () => {
  const operation = buildRuntimeStartFailure('Python runtime is not available.', {
    errorCode: 'PYTHON_NOT_FOUND',
  });
  const result = await operation.promise;

  assert.equal(operation.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.result.ok, false);
  assert.equal(result.result.errorCode, 'PYTHON_NOT_FOUND');
  assert.match(result.result.message, /Python runtime is not available/i);
});

test('AgentRuntimeClient.invoke fails gracefully when no Python runtime can be resolved', async () => {
  const client = new AgentRuntimeClient({
    workspaceRoot: 'E:\\dev\\projects\\gosenderr-desktop-agent-PC',
    runtimeRoot: 'E:\\dev\\projects\\gosenderr-desktop-agent-PC\\runtime',
  });
  client._resolvePython = () => '';

  const response = await client.invoke('chat', {
    workspace: 'E:\\dev\\projects\\gosenderr-desktop-agent-PC',
  });

  assert.equal(response.ok, false);
  assert.equal(response.exitCode, 1);
  assert.equal(response.result.ok, false);
  assert.equal(response.result.errorCode, 'PYTHON_NOT_FOUND');
  assert.match(response.result.message, /Install Python|virtual environment/i);
});

test('AgentRuntimeClient.startScheduler fails gracefully when no Python runtime can be resolved', () => {
  const client = new AgentRuntimeClient({
    workspaceRoot: 'E:\\dev\\projects\\gosenderr-desktop-agent-PC',
    runtimeRoot: 'E:\\dev\\projects\\gosenderr-desktop-agent-PC\\runtime',
  });
  client._resolvePython = () => '';

  const response = client.startScheduler({
    workspace: 'E:\\dev\\projects\\gosenderr-desktop-agent-PC',
  });

  assert.equal(response.ok, false);
  assert.equal(response.running, false);
  assert.equal(response.pid, null);
  assert.match(response.message, /Python runtime/i);
});
