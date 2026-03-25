'use strict';

const { buildAiStatus } = require('./ai-center');
const { readLatestAcceptanceReport } = require('./acceptance-report');
const { listBenchmarkRuns } = require('./benchmarks');
const { buildModelFoundryStatus } = require('./model-foundry');
const { readTrainingTuningSettings, collectTrainingTelemetry } = require('./training-tuning');
const { readAssistantConfig } = require('../host/assistant-config');

async function buildSystemCheckContext(workspaceRoot, overrides = {}) {
  const tuningSettings = overrides.tuningSettings && typeof overrides.tuningSettings === 'object'
    ? overrides.tuningSettings
    : readTrainingTuningSettings(workspaceRoot);
  const tuningStatus = overrides.tuningStatus && typeof overrides.tuningStatus === 'object'
    ? overrides.tuningStatus
    : {
      telemetry: await collectTrainingTelemetry({
        settings: tuningSettings,
      }),
    };
  const assistantConfig = overrides.assistantConfig && typeof overrides.assistantConfig === 'object'
    ? overrides.assistantConfig
    : readAssistantConfig(workspaceRoot, { defaultWorkspace: workspaceRoot });
  const benchmarks = overrides.benchmarks && typeof overrides.benchmarks === 'object'
    ? overrides.benchmarks
    : listBenchmarkRuns(workspaceRoot);
  const modelFoundry = overrides.modelFoundry && typeof overrides.modelFoundry === 'object'
    ? overrides.modelFoundry
    : buildModelFoundryStatus(workspaceRoot, {
      benchmarks,
    });
  const acceptance = overrides.acceptance && typeof overrides.acceptance === 'object'
    ? overrides.acceptance
    : readLatestAcceptanceReport(workspaceRoot);
  const aiStatus = overrides.aiStatus && typeof overrides.aiStatus === 'object'
    ? overrides.aiStatus
    : buildAiStatus({
      settings: assistantConfig,
      tuningStatus,
      benchmarkRuns: benchmarks.runs,
      acceptance,
      modelFoundry,
    });

  return {
    acceptance,
    assistantConfig,
    benchmarks,
    modelFoundry,
    aiStatus,
    tuningSettings,
    tuningStatus,
  };
}

module.exports = {
  buildSystemCheckContext,
};
