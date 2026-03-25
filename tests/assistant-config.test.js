'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  readAssistantConfig,
  writeAssistantAutonomySettings,
  writeAssistantModelSettings,
} = require('../host/assistant-config');

test('assistant config persists GS-Dev-1 model profile routing fields in dev_assistant.yaml', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-assistant-config-'));
  try {
    writeAssistantModelSettings(workspaceRoot, {
      modelProfileId: 'gs-dev-1-default',
      modelDisplayName: 'GS-Dev-1 Default',
      baseModel: 'qwen2.5-coder:14b',
      baseProvider: 'ollama',
      providerSource: 'ollama',
      workspaceModelProfileId: 'gs-dev-1-default',
      workspaceModelDisplayName: 'GS-Dev-1 Default',
      workspaceBaseModel: 'qwen2.5-coder:14b',
      workspaceBaseProvider: 'ollama',
      workspaceProviderSource: 'ollama',
      engineModelProfileId: 'gse-1-engine',
      engineModelDisplayName: 'GSE-1 Engine',
      engineBaseModel: 'qwen2.5-coder:7b',
      engineBaseProvider: 'ollama',
      engineProviderSource: 'ollama',
      plannerProvider: 'ollama',
      plannerModel: 'qwen2.5-coder:7b',
      coderProvider: 'ollama',
      coderModel: 'qwen2.5-coder:14b',
      validatorProvider: 'ollama',
      validatorModel: 'qwen2.5-coder:7b',
      summarizerProvider: 'openai',
      summarizerModel: 'gpt-4.1-mini',
    });

    const config = readAssistantConfig(workspaceRoot);
    assert.equal(config.modelProfileId, 'gs-dev-1-default');
    assert.equal(config.baseModel, 'qwen2.5-coder:14b');
    assert.equal(config.workspaceModelProfileId, 'gs-dev-1-default');
    assert.equal(config.workspaceBaseModel, 'qwen2.5-coder:14b');
    assert.equal(config.engineModelProfileId, 'gse-1-engine');
    assert.equal(config.engineBaseProvider, 'ollama');
    assert.equal(config.dailySafeAutonomousTarget, 5);
    assert.equal(config.dailySelfImprovementTarget, 5);
    assert.equal(config.taskModeRoutes.planner.model, 'qwen2.5-coder:7b');
    assert.equal(config.taskModeRoutes.coder.provider, 'ollama');
    assert.equal(config.taskModeRoutes.summarizer.model, 'gpt-4.1-mini');

    const raw = fs.readFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), 'utf8');
    assert.match(raw, /assistant_model_profile_id: gs-dev-1-default/);
    assert.match(raw, /assistant_workspace_model_profile_id: gs-dev-1-default/);
    assert.match(raw, /assistant_engine_model_profile_id: gse-1-engine/);
    assert.match(raw, /assistant_task_mode_coder_model: qwen2\.5-coder:14b/);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('assistant config reads custom daily autonomy and self-improvement targets', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-assistant-config-daily-'));
  try {
    fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), [
      'assistant_daily_safe_autonomous_target: 7',
      'assistant_daily_self_improvement_target: 6',
    ].join('\n'), 'utf8');

    const config = readAssistantConfig(workspaceRoot);
    assert.equal(config.dailySafeAutonomousTarget, 7);
    assert.equal(config.dailySelfImprovementTarget, 6);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('assistant config persists auto queue and auto run follow-up autonomy fields', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-assistant-config-followups-'));
  try {
    writeAssistantAutonomySettings(workspaceRoot, {
      autoQueueTaskLoopFollowups: true,
      autoRunQueuedTaskLoopFollowups: false,
    });

    const config = readAssistantConfig(workspaceRoot);
    assert.equal(config.autoQueueTaskLoopFollowups, true);
    assert.equal(config.autoRunQueuedTaskLoopFollowups, false);

    const raw = fs.readFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), 'utf8');
    assert.match(raw, /assistant_auto_queue_task_loop_followups: true/);
    assert.match(raw, /assistant_auto_run_queued_task_loop_followups: false/);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
