'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  AUTOPILOT_DEFAULTS,
  getAutopilotSettings,
  saveAutopilotSettings,
  listAutomations,
} = require('../core/automations');

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-automations-'));
}

test('getAutopilotSettings reads configured scheduler policy fields', () => {
  const workspaceRoot = makeWorkspace();
  fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), [
    'autopilot_jobs:',
    '  - name: "every_10_minutes"',
    '    cron: "*/10 * * * *"',
    '    enabled: true',
    'autopilot_self_improve: false',
    'autopilot_action: run',
    'autopilot_count: 3',
    'autopilot_status: TESTED',
    'autopilot_profile: preview',
    'autopilot_template: brainstorm',
    'autopilot_require_tag: "BE"',
    'autopilot_require_text: "dispatch"',
    'autopilot_prefer_domain: dispatch',
    'autopilot_interval_seconds: 600',
    'autopilot_ticket_cooldown_minutes: 5',
    'autopilot_failure_block_minutes: 90',
    'autopilot_fix_loop: false',
    'autopilot_continue_on_fail: false',
    'autopilot_skip_learn: true',
    'autopilot_notify_summary: false',
    '',
  ].join('\n'), 'utf8');

  try {
    const settings = getAutopilotSettings(workspaceRoot);
    assert.equal(settings.selfImprove, false);
    assert.equal(settings.action, 'run');
    assert.equal(settings.count, 3);
    assert.equal(settings.status, 'TESTED');
    assert.equal(settings.profile, 'preview');
    assert.equal(settings.template, 'brainstorm');
    assert.equal(settings.requireTag, 'BE');
    assert.equal(settings.requireText, 'dispatch');
    assert.equal(settings.preferDomain, 'dispatch');
    assert.equal(settings.intervalSeconds, 600);
    assert.equal(settings.cooldownMinutes, 5);
    assert.equal(settings.failureBlockMinutes, 90);
    assert.equal(settings.fixLoop, false);
    assert.equal(settings.continueOnFail, false);
    assert.equal(settings.skipLearn, true);
    assert.equal(settings.notifySummary, false);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('saveAutopilotSettings keeps automation jobs and writes policy keys', () => {
  const workspaceRoot = makeWorkspace();
  fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), [
    'autopilot_jobs:',
    '  - name: "nightly"',
    '    cron: "0 2 * * *"',
    '    enabled: true',
    '',
  ].join('\n'), 'utf8');

  try {
    const saved = saveAutopilotSettings(workspaceRoot, {
      ...AUTOPILOT_DEFAULTS,
      action: 'run',
      count: 4,
      requireTag: 'OPS',
      preferDomain: 'platform',
      intervalSeconds: 300,
      skipLearn: true,
    });
    const raw = fs.readFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), 'utf8');
    const jobs = listAutomations(workspaceRoot);

    assert.equal(saved.action, 'run');
    assert.equal(saved.count, 4);
    assert.match(raw, /autopilot_action: "run"/);
    assert.match(raw, /autopilot_count: 4/);
    assert.match(raw, /autopilot_require_tag: "OPS"/);
    assert.match(raw, /autopilot_prefer_domain: "platform"/);
    assert.match(raw, /autopilot_interval_seconds: 300/);
    assert.match(raw, /autopilot_skip_learn: true/);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].name, 'nightly');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});