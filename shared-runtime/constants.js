'use strict';

const RUN_STATES = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  SKIPPED: 'skipped',
  PASS: 'pass',
  FAIL: 'fail',
  CANCELLED: 'cancelled',
});

const RUN_ACTIONS = Object.freeze({
  RUN: 'run',
  IMPLEMENT: 'implement',
  SPRINT: 'sprint',
  AUTOPILOT: 'autopilot',
  ANALYZE_LOG: 'analyze-log',
  TRAIN: 'train',
});

const DEFAULTS = Object.freeze({
  PYTHON_RELATIVE: 'backend/.venv/bin/python',
  RUN_HISTORY_LIMIT: 60,
  RUNTIME_STATE_FILE: 'docs/assistant_runs/runtime_state.json',
});

module.exports = {
  RUN_STATES,
  RUN_ACTIONS,
  DEFAULTS,
};
