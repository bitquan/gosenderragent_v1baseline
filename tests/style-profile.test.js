'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveStyleProfileFromEntries,
  improveTitleWithStyleProfile,
} = require('../core/style-profile');

test('deriveStyleProfileFromEntries learns reusable prompts only from trusted sessions', () => {
  const entries = [
    {
      recordedAt: '2026-03-15T16:00:00.000Z',
      type: 'chat-prompt',
      changeSessionId: 'session-1',
      payload: {
        text: 'Review the current repo and tell me what needs fixing first.',
        surface: 'engine-cli',
      },
    },
    {
      recordedAt: '2026-03-15T16:00:01.000Z',
      type: 'task-created',
      changeSessionId: 'session-1',
      payload: {
        title: 'Review the current repo and tell me what needs fixing first.',
      },
    },
    {
      recordedAt: '2026-03-15T16:02:00.000Z',
      type: 'run-complete',
      changeSessionId: 'session-1',
      payload: {
        state: 'pass',
        accepted: true,
      },
    },
    {
      recordedAt: '2026-03-15T16:05:00.000Z',
      type: 'chat-prompt',
      changeSessionId: 'session-2',
      payload: {
        text: 'Please build a new monitor tab.',
      },
    },
  ];

  const profile = deriveStyleProfileFromEntries(entries);

  assert.equal(profile.trustedSessionCount, 1);
  assert.equal(profile.reusablePrompts.length, 1);
  assert.equal(profile.reusablePrompts[0].prompt, 'Review the current repo and tell me what needs fixing first.');
  assert.deepEqual(profile.reusablePrompts[0].surfaces, ['engine-cli']);
  assert.equal(profile.preferredVerbs[0].verb, 'review');
});

test('improveTitleWithStyleProfile strips filler and can use learned imperative style', () => {
  const title = improveTitleWithStyleProfile('Please review the current repo and tell me what needs fixing first.', {
    preferredVerbs: [{ verb: 'review', count: 3 }],
  }, { forceImperative: true });

  assert.equal(title, 'Review the current repo and tell me what needs fixing first');
});

test('deriveStyleProfileFromEntries keeps operator supervision signals reusable without requiring a full trusted run', () => {
  const entries = [
    {
      recordedAt: '2026-03-15T16:10:00.000Z',
      type: 'operator-feedback',
      changeSessionId: 'session-3',
      payload: {
        verdict: 'needs-changes',
        note: 'Tighten the layout spacing and rerun smoke before approval.',
      },
    },
    {
      recordedAt: '2026-03-15T16:12:00.000Z',
      type: 'operator-feedback',
      changeSessionId: 'session-3',
      payload: {
        verdict: 'approved',
        note: 'Keep selector-first controls and compact monitor cards.',
      },
    },
  ];

  const profile = deriveStyleProfileFromEntries(entries);

  assert.equal(profile.operatorFeedbackCount, 2);
  assert.equal(profile.supervisionSignals.length, 2);
  assert.ok(profile.recommendedCommands.length > 0);
  assert.ok(profile.recommendedCommands.some((item) => String(item.prompt || '').trim().length > 0));
  assert.match(profile.supervisionSummary, /approval/i);
  assert.ok(profile.preferredVerbs.some((item) => ['repair', 'implement', 'review'].includes(String(item.verb || ''))));
});
