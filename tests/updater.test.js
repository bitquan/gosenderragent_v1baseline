'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isLowRiskAutoUpdatePath,
  isProtectedAutoUpdatePath,
  summarizeAutoUpdateSafety,
} = require('../core/updater');

test('isLowRiskAutoUpdatePath allows docs and tests paths', () => {
  assert.equal(isLowRiskAutoUpdatePath('docs/ENGINE_TEST_WEEK.md'), true);
  assert.equal(isLowRiskAutoUpdatePath('backend/tests/test_runtime.py'), true);
  assert.equal(isLowRiskAutoUpdatePath('tests/unit/example.test.js'), true);
});

test('isProtectedAutoUpdatePath blocks protected domains', () => {
  assert.equal(isProtectedAutoUpdatePath('backend/app/security.py'), true);
  assert.equal(isProtectedAutoUpdatePath('docs/network-pool-notes.md'), true);
  assert.equal(isProtectedAutoUpdatePath('docs/ENGINE_TEST_WEEK.md'), false);
});

test('summarizeAutoUpdateSafety only marks fully low-risk updates as safe', () => {
  const safe = summarizeAutoUpdateSafety([
    'docs/ENGINE_TEST_WEEK.md',
    'backend/tests/test_runtime.py',
  ]);
  assert.equal(safe.safe, true);
  assert.deepEqual(safe.blockedFiles, []);

  const blocked = summarizeAutoUpdateSafety([
    'docs/ENGINE_TEST_WEEK.md',
    'backend/app/security.py',
  ]);
  assert.equal(blocked.safe, false);
  assert.deepEqual(blocked.blockedFiles, ['backend/app/security.py']);
});
