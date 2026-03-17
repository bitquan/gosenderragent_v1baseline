'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { LearningJournalService } = require('../core/learning-journal');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-journal-'));
  const offloadRoot = path.join(root, 'offload');
  fs.mkdirSync(offloadRoot, { recursive: true });
  fs.writeFileSync(path.join(root, 'dev_assistant.local.yaml'), `assistant_artifacts_root: ${offloadRoot}\n`, 'utf8');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"journal-fixture"}\n', 'utf8');
  return { root, offloadRoot };
}

test('learning journal keeps background polling disabled until explicitly enabled', () => {
  const { root } = makeWorkspace();
  const service = new LearningJournalService();
  try {
    service.setScope({
      workspaceRoot: root,
      targetRoot: root,
      pollingEnabled: false,
    });
    assert.equal(service.getStatus().pollingEnabled, false);
    assert.equal(service.pollTimer, null);

    service.setScope({
      workspaceRoot: root,
      targetRoot: root,
      pollingEnabled: true,
    });
    assert.equal(service.getStatus().pollingEnabled, true);
    assert.notEqual(service.pollTimer, null);
  } finally {
    service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('learning journal reads recent entries from large journal files without losing the newest records', () => {
  const { root } = makeWorkspace();
  const service = new LearningJournalService();
  try {
    service.setScope({
      workspaceRoot: root,
      targetRoot: root,
      pollingEnabled: false,
      changeSessionId: 'session-1',
    });
    for (let index = 0; index < 2600; index += 1) {
      service.recordEvent('manual-edit', {
        path: `src/file-${index}.ts`,
        summary: `updated ${index}`,
      });
    }

    const recent = service.listRecentChanges(5);
    assert.equal(recent.ok, true);
    assert.equal(recent.entries.length, 5);
    assert.equal(recent.entries.at(-1)?.payload?.path, 'src/file-2599.ts');
  } finally {
    service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('learning journal status exposes style profile, reusable prompts, and training readiness from trusted sessions', () => {
  const { root } = makeWorkspace();
  const service = new LearningJournalService();
  try {
    service.setScope({
      workspaceRoot: root,
      targetRoot: root,
      pollingEnabled: false,
      changeSessionId: 'session-1',
      threadId: 'thread-1',
    });

    service.recordEvent('chat-prompt', {
      text: 'Review the current repo and tell me what needs fixing first.',
    });
    service.recordEvent('task-created', {
      title: 'Review the current repo and tell me what needs fixing first.',
    });
    service.recordEvent('run-complete', {
      state: 'pass',
      accepted: true,
    });

    const status = service.getStatus();

    assert.equal(status.styleProfile.trustedSessionCount, 1);
    assert.equal(status.reusablePrompts.length, 1);
    assert.equal(status.reusablePrompts[0].prompt, 'Review the current repo and tell me what needs fixing first.');
    assert.equal(status.trainingReadiness.status, 'ready');
  } finally {
    service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('learning journal status exposes operator supervision signals from monitor feedback', () => {
  const { root } = makeWorkspace();
  const service = new LearningJournalService();
  try {
    service.setScope({
      workspaceRoot: root,
      targetRoot: root,
      pollingEnabled: false,
      changeSessionId: 'session-2',
      threadId: 'thread-2',
    });

    service.recordEvent('operator-feedback', {
      verdict: 'needs-changes',
      note: 'Tighten the spacing, rerun smoke, and keep the settings selector-first.',
      path: 'renderer-src/main.tsx',
    });
    service.recordEvent('operator-feedback', {
      verdict: 'approved',
      note: 'Keep the compact monitor cards.',
      path: 'renderer-src/main.tsx',
      trusted: true,
    });

    const status = service.getStatus();

    assert.equal(status.operatorSupervision.count, 2);
    assert.equal(status.operatorSupervision.signals.length, 2);
    assert.match(String(status.operatorSupervision.summary || ''), /approval/i);
    assert.equal(status.trainingReadiness.status, 'ready');
    assert.equal(status.gsDev1ExportReadiness.ready, true);
    assert.equal(status.gsDev1ExportReadiness.status, 'ready');
  } finally {
    service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('learning journal derives reusable reject reasons, fix guidance, and preferred responses', () => {
  const { root } = makeWorkspace();
  const service = new LearningJournalService();
  try {
    service.setScope({
      workspaceRoot: root,
      targetRoot: root,
      pollingEnabled: false,
      changeSessionId: 'session-3',
      threadId: 'thread-3',
    });

    service.recordEvent('run-complete', {
      state: 'fail',
      reviewBundle: {
        verdict: 'repair-required',
        reason: 'Validation failed in renderer/app.js.',
        howToFix: 'Repair renderer/app.js and rerun the UI shell test.',
      },
      failureClass: {
        code: 'validation-failure',
        summary: 'Validation failed in renderer/app.js.',
      },
      nextAction: {
        command: 'repair-loop',
        prompt: 'Repair renderer/app.js and rerun the UI shell test.',
      },
      changedFiles: [
        { path: 'renderer/app.js', status: 'modified' },
      ],
    });
    service.recordEvent('run-complete', {
      state: 'fail',
      reviewBundle: {
        verdict: 'repair-required',
        reason: 'Validation failed in renderer/app.js.',
        howToFix: 'Repair renderer/app.js and rerun the UI shell test.',
      },
      failureClass: {
        code: 'validation-failure',
        summary: 'Validation failed in renderer/app.js.',
      },
      nextAction: {
        command: 'repair-loop',
        prompt: 'Repair renderer/app.js and rerun the UI shell test.',
      },
      changedFiles: [
        { path: 'renderer/app.js', status: 'modified' },
      ],
    });
    service.recordEvent('operator-feedback', {
      verdict: 'needs-changes',
      note: 'Keep the settings selector-first and rerun smoke.',
      path: 'renderer/app.js',
    });

    const status = service.getStatus();

    assert.equal(status.memoryHints.rejectCount, 3);
    assert.match(String(status.memoryHints.summary || ''), /reject pattern/i);
    assert.equal(status.memoryHints.topRejectReason, 'Validation failed in renderer/app.js.');
    assert.match(String(status.memoryHints.topFixPattern || ''), /Repair renderer\/app\.js/i);
    assert.equal(status.memoryHints.recommendedResponse, 'repair-loop');
    assert.equal(status.memoryHints.topPaths[0].value, 'renderer/app.js');
    assert.equal(status.memoryHints.topPhaseId, 'phase-1-safe-engine-core');
    assert.match(String(status.memoryHints.phaseSummary || ''), /Phase 1: Safe Engine Core/i);
    assert.equal(status.memoryHints.recentRejects.length > 0, true);
  } finally {
    service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
