'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

function readWorkflow(name) {
  return fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', name), 'utf8');
}

test('ci workflow runs on main, codex branches, and pull requests', () => {
  const workflow = readWorkflow('ci.yml');

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:\s*\n\s*branches:\s*\n\s*-\s*main\s*\n\s*-\s*codex\/\*\*/m);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run smoke/);
  assert.match(workflow, /npm run smoke:ui/);
  assert.match(workflow, /npm run packaged:smoke/);
  assert.match(workflow, /npm run system:check -- --area roadmap/);
  assert.match(workflow, /npm run system:check -- --area trust/);
});

test('baseline proof workflow runs acceptance and baseline system checks on main', () => {
  const workflow = readWorkflow('baseline-proof.yml');

  assert.match(workflow, /branches:\s*\n\s*-\s*main/m);
  assert.match(workflow, /npm run engine:acceptance -- --full-self-host/);
  assert.match(workflow, /npm run system:check -- --area acceptance/);
  assert.match(workflow, /npm run system:check -- --area autonomy/);
  assert.match(workflow, /npm run system:check -- --area roadmap/);
  assert.match(workflow, /npm run system:check -- --area promotion/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
});

test('release workflow runs on desktop tags and publishes release artifacts', () => {
  const workflow = readWorkflow('release.yml');

  assert.match(workflow, /tags:\s*\n\s*-\s*desktop-v\*/m);
  assert.match(workflow, /npm run dist:mac/);
  assert.match(workflow, /npm run dist:win/);
  assert.match(workflow, /desktop-mac-unsigned/);
  assert.match(workflow, /desktop-win-unsigned/);
  assert.match(workflow, /softprops\/action-gh-release@v2/);
});
