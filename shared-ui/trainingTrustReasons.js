'use strict';

const TRAINING_TRUST_REASON_CODES = Object.freeze({
  THERMAL_PRESSURE: 'thermal_pressure',
  MEMORY_PRESSURE: 'memory_pressure',
  MEMORY_WARM: 'memory_warm',
  CPU_PRESSURE: 'cpu_pressure',
  CPU_WARM: 'cpu_warm',
  ACTIVE_RUN_IN_PROGRESS: 'active_run_in_progress',
  SCHEDULER_ACTIVE: 'scheduler_active',
  OLLAMA_NOT_RUNNING: 'ollama_not_running',
  SELECTED_MODEL_NOT_READY: 'selected_model_not_ready',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  TELEMETRY_STALE: 'telemetry_stale',
});

module.exports = {
  TRAINING_TRUST_REASON_CODES,
};
