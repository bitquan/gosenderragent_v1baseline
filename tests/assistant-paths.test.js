const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getAssistantRunsDir } = require('../core/assistant-paths');

test('assistant runs dir keeps the repo root on the configured offload path', () => {
  const repoRoot = path.join(__dirname, '..');
  const runsDir = getAssistantRunsDir(repoRoot);

  assert.match(runsDir, /gosenderr_dev_offload/i);
  assert.doesNotMatch(runsDir, /\\workspaces\\/i);
});

test('assistant runs dir namespaces non-root workspaces under the configured offload path', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-assistant-paths-'));
  const runsDir = getAssistantRunsDir(workspaceRoot);

  assert.match(runsDir, /gosenderr_dev_offload/i);
  assert.match(runsDir, /\\workspaces\\.*\\assistant_runs$/i);
  assert.match(runsDir, new RegExp(`${path.basename(workspaceRoot)}-`, 'i'));
});
