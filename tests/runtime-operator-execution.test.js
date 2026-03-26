const test = require('node:test');
const assert = require('node:assert/strict');

const { buildOperatorExecutionSnapshot } = require('../shared-runtime/runtime');

test('buildOperatorExecutionSnapshot carries runtime timeline and provider accountability', () => {
  const snapshot = buildOperatorExecutionSnapshot({
    runtimeContext: {
      validation_scope: {
        commands: ['npm run test:ui-shell'],
      },
    },
    runtimeResult: {
      runtime_timeline: [
        { stage: 'planning', event: 'route-selected', summary: 'planner routed', provider: 'openai', model: 'gpt-4.1-mini' },
        { stage: 'validation', event: 'validator-finished', summary: 'validator ran tests', provider: 'openai', model: 'gpt-4.1-mini' },
      ],
      provider_routing: {
        planner: { provider: 'openai', model: 'gpt-4.1-mini' },
        validator: { provider: 'openai', model: 'gpt-4.1-mini' },
      },
    },
  });
  assert.equal(snapshot.runtimeTimeline.length, 2);
  assert.deepEqual(snapshot.validationCommands, ['npm run test:ui-shell']);
  assert.match(String(snapshot.providerAccountability.summary || ''), /planner:openai/);
});
