const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('config loader source includes coherence validation for routing and followup settings', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'backend', 'agent', 'core', 'config_loader.py'), 'utf8');
  assert.match(source, /def validate_config_coherence\(/);
  assert.match(source, /assistant_auto_run_queued_task_loop_followups/);
  assert.match(source, /for lane in \('planner', 'repair', 'coder', 'validator', 'summarizer'\)/);
});
