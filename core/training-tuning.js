'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const childProcess = require('child_process');
const { TRAINING_TRUST_REASON_CODES } = require('../shared-ui/trainingTrustReasons');

const APP_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MODEL_STORAGE_ROOT = path.join(os.homedir(), 'large-storage', 'models');

const RECOMMENDED_LOCAL_MODELS = Object.freeze([
  Object.freeze({
    id: 'qwen-coder-7b-q4km',
    label: 'Qwen2.5 Coder 7B',
    ollamaModel: 'qwen2.5-coder:7b',
    fileName: 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',
    sizeLabel: '4.7 GB',
    makeTarget: 'model-download-qwen-coder-7b',
    sourcePortal: 'huggingface',
    sourceLabel: 'Hugging Face',
    repoId: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
    sourceUrl: 'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
    recommendedTargets: ['auto', 'balanced-laptop', 'creator-laptop', 'windows-i9-32gb-gpu', 'windows-i9-32gb-rtx4060-8gb'],
  }),
  Object.freeze({
    id: 'qwen-coder-14b-q4km',
    label: 'Qwen2.5 Coder 14B',
    ollamaModel: 'qwen2.5-coder:14b',
    fileName: 'Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf',
    sizeLabel: '9.0 GB',
    makeTarget: 'model-download-qwen-coder-14b',
    sourcePortal: 'huggingface',
    sourceLabel: 'Hugging Face',
    repoId: 'Qwen/Qwen2.5-Coder-14B-Instruct-GGUF',
    sourceUrl: 'https://huggingface.co/Qwen/Qwen2.5-Coder-14B-Instruct-GGUF',
    recommendedTargets: ['auto', 'creator-laptop', 'workstation', 'windows-i9-32gb-gpu', 'windows-i9-32gb-rtx4060-8gb'],
  }),
  Object.freeze({
    id: 'deepseek-coder-v2-lite-q4km',
    label: 'DeepSeek Coder V2 Lite',
    ollamaModel: '',
    fileName: 'DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf',
    sizeLabel: '10.4 GB',
    makeTarget: 'model-download-deepseek-coder-v2-lite',
    sourcePortal: 'huggingface',
    sourceLabel: 'Hugging Face',
    repoId: 'QuantFactory/DeepSeek-Coder-V2-Lite-Instruct-GGUF',
    sourceUrl: 'https://huggingface.co/QuantFactory/DeepSeek-Coder-V2-Lite-Instruct-GGUF',
    recommendedTargets: ['creator-laptop', 'workstation', 'windows-i9-32gb-gpu', 'windows-i9-32gb-rtx4060-8gb'],
  }),
]);

const HARDWARE_TARGET_PRESETS = Object.freeze([
  Object.freeze({
    id: 'auto',
    label: 'Current machine',
    summary: 'Use the machine you are running right now as the tuning reference.',
    patch: {},
  }),
  Object.freeze({
    id: 'balanced-laptop',
    label: 'Balanced laptop',
    summary: 'Safe default for everyday coding on an 8-16 GB machine.',
    patch: {
      trainingProfile: 'medium',
      trainingEcoMode: true,
      trainingCpuLimitPercent: 45,
      trainingThreadLimit: 4,
      trainingThermalPreset: '75',
      trainingThermalCustomC: 75,
      trainingLiveSamplingSec: 8,
      trainingOllamaModel: 'qwen2.5-coder:7b',
    },
  }),
  Object.freeze({
    id: 'creator-laptop',
    label: 'Creator laptop',
    summary: 'Stronger local coding setup for 16-32 GB machines that still need daytime responsiveness.',
    patch: {
      trainingProfile: 'high',
      trainingEcoMode: true,
      trainingCpuLimitPercent: 60,
      trainingThreadLimit: 6,
      trainingThermalPreset: '80',
      trainingThermalCustomC: 80,
      trainingLiveSamplingSec: 5,
      trainingOllamaModel: 'qwen2.5-coder:14b',
    },
  }),
  Object.freeze({
    id: 'windows-i9-32gb-gpu',
    label: 'Windows dev PC (i9 / 32 GB / GPU)',
    summary: 'Recommended target for your Windows box with an i9 12th-gen CPU, 32 GB RAM, SSD, and a dedicated GPU.',
    patch: {
      trainingProfile: 'high',
      trainingEcoMode: false,
      trainingCpuLimitPercent: 70,
      trainingThreadLimit: 8,
      trainingThermalPreset: '85',
      trainingThermalCustomC: 85,
      trainingLiveSamplingSec: 3,
      trainingOllamaModel: 'qwen2.5-coder:14b',
    },
  }),
  Object.freeze({
    id: 'windows-i9-32gb-rtx4060-8gb',
    label: 'Windows dev PC (i9 / 32 GB / RTX 4060 8 GB)',
    summary: 'Higher-throughput target for your Windows box with an i9 12th-gen CPU, 32 GB RAM, SSD, and an RTX 4060 8 GB GPU.',
    patch: {
      trainingProfile: 'high',
      trainingEcoMode: false,
      trainingCpuLimitPercent: 75,
      trainingThreadLimit: 8,
      trainingThermalPreset: '85',
      trainingThermalCustomC: 85,
      trainingLiveSamplingSec: 2,
      trainingOllamaModel: 'qwen2.5-coder:14b',
    },
  }),
  Object.freeze({
    id: 'workstation',
    label: 'Workstation',
    summary: 'Higher-throughput route for larger machines and dedicated tuning sessions.',
    patch: {
      trainingProfile: 'high',
      trainingEcoMode: false,
      trainingCpuLimitPercent: 80,
      trainingThreadLimit: 10,
      trainingThermalPreset: '90',
      trainingThermalCustomC: 90,
      trainingLiveSamplingSec: 3,
      trainingOllamaModel: 'qwen2.5-coder:14b',
    },
  }),
]);

const PROFILE_PRESETS = Object.freeze({
  low: Object.freeze({
    profile: 'low',
    label: 'Low',
    threadLimit: 2,
    cpuLimitPercent: 35,
    thermalCeilingC: 70,
    niceIncrement: 10,
    selfImproveCount: 1,
    minExamples: 2,
    minLogExamples: 1,
    minArtifactExamples: 1,
    ollamaNumParallel: 1,
  }),
  medium: Object.freeze({
    profile: 'medium',
    label: 'Medium',
    threadLimit: 4,
    cpuLimitPercent: 55,
    thermalCeilingC: 80,
    niceIncrement: 5,
    selfImproveCount: 2,
    minExamples: 3,
    minLogExamples: 1,
    minArtifactExamples: 1,
    ollamaNumParallel: 2,
  }),
  high: Object.freeze({
    profile: 'high',
    label: 'High',
    threadLimit: Math.max(4, Math.min(8, Number(os.cpus()?.length || 8))),
    cpuLimitPercent: 80,
    thermalCeilingC: 90,
    niceIncrement: 0,
    selfImproveCount: 3,
    minExamples: 4,
    minLogExamples: 2,
    minArtifactExamples: 1,
    ollamaNumParallel: 4,
  }),
});

const TRAINING_TUNING_KEY_MAP = Object.freeze({
  trainingProfile: 'assistant_training_profile',
  trainingLaunchSurface: 'assistant_training_launch_surface',
  trainingEcoMode: 'assistant_training_eco_mode',
  trainingCpuLimitPercent: 'assistant_training_cpu_limit_percent',
  trainingThreadLimit: 'assistant_training_thread_limit',
  trainingThermalPreset: 'assistant_training_thermal_preset',
  trainingThermalCustomC: 'assistant_training_thermal_custom_c',
  trainingPauseOnThermal: 'assistant_training_pause_on_thermal',
  trainingAllowDuringActiveUse: 'assistant_training_allow_during_active_use',
  trainingAutoStartOllama: 'assistant_training_auto_start_ollama',
  trainingOllamaModel: 'assistant_training_ollama_model',
  trainingOllamaKeepAlive: 'assistant_training_ollama_keep_alive',
  trainingModelStorageRoot: 'assistant_training_model_storage_root',
  trainingLiveSamplingSec: 'assistant_training_live_sampling_sec',
  trainingHardwareTarget: 'assistant_training_hardware_target',
});

const DEFAULT_TUNING_SETTINGS = Object.freeze({
  trainingProfile: 'medium',
  trainingLaunchSurface: 'app',
  trainingEcoMode: false,
  trainingCpuLimitPercent: PROFILE_PRESETS.medium.cpuLimitPercent,
  trainingThreadLimit: PROFILE_PRESETS.medium.threadLimit,
  trainingThermalPreset: String(PROFILE_PRESETS.medium.thermalCeilingC),
  trainingThermalCustomC: PROFILE_PRESETS.medium.thermalCeilingC,
  trainingPauseOnThermal: true,
  trainingAllowDuringActiveUse: true,
  trainingAutoStartOllama: true,
  trainingOllamaModel: 'qwen2.5-coder:7b',
  trainingOllamaKeepAlive: true,
  trainingModelStorageRoot: DEFAULT_MODEL_STORAGE_ROOT,
  trainingLiveSamplingSec: 5,
  trainingHardwareTarget: 'auto',
});
const TRAINING_TELEMETRY_STALE_MS = 90 * 1000;
const LOCAL_PROVIDER_SOURCES = new Set(['ollama', 'local']);

function configPathForWorkspace(workspaceRoot) {
  return path.join(String(workspaceRoot || '').trim(), 'dev_assistant.yaml');
}

function normalizeConfigRoot(root) {
  const value = String(root || '').trim();
  return value ? path.resolve(value) : '';
}

function listConfigRoots(workspaceRoot) {
  const seen = new Set();
  return [APP_ROOT, workspaceRoot]
    .map(normalizeConfigRoot)
    .filter((root) => {
      if (!root || seen.has(root)) {
        return false;
      }
      seen.add(root);
      return true;
    });
}

function parseScalar(raw) {
  const text = String(raw || '').split('#')[0].trim();
  if (!text) {
    return '';
  }
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseBool(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  const text = String(value || '').trim().toLowerCase();
  if (!text) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(text)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(text)) {
    return false;
  }
  return fallback;
}

function parseNumber(value, fallback, minimum = null, maximum = null) {
  const next = Number(value);
  if (!Number.isFinite(next)) {
    return fallback;
  }
  let bounded = next;
  if (minimum !== null) {
    bounded = Math.max(minimum, bounded);
  }
  if (maximum !== null) {
    bounded = Math.min(maximum, bounded);
  }
  return Math.round(bounded);
}

function normalizeProfile(value) {
  const profile = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PROFILE_PRESETS, profile) ? profile : DEFAULT_TUNING_SETTINGS.trainingProfile;
}

function normalizeLaunchSurface(value) {
  const surface = String(value || '').trim().toLowerCase();
  return ['app', 'terminal', 'vscode'].includes(surface) ? surface : DEFAULT_TUNING_SETTINGS.trainingLaunchSurface;
}

function normalizeHardwareTarget(value) {
  const target = String(value || '').trim().toLowerCase();
  return HARDWARE_TARGET_PRESETS.some((item) => item.id === target) ? target : DEFAULT_TUNING_SETTINGS.trainingHardwareTarget;
}

function getHardwareTargetPreset(value = 'auto') {
  const normalized = normalizeHardwareTarget(value);
  return HARDWARE_TARGET_PRESETS.find((item) => item.id === normalized) || HARDWARE_TARGET_PRESETS[0];
}

function expandHomePath(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (raw === '~') {
    return os.homedir();
  }
  if (raw.startsWith('~/')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

function normalizeModelStorageRoot(value) {
  const expanded = expandHomePath(value);
  return expanded ? path.normalize(expanded) : DEFAULT_MODEL_STORAGE_ROOT;
}

function listCandidateModelStorageRoots(value) {
  const normalizedRoot = normalizeModelStorageRoot(value);
  const candidates = [];
  const seen = new Set();
  function addCandidate(nextPath) {
    const resolved = nextPath ? path.normalize(String(nextPath)) : '';
    if (!resolved || seen.has(resolved)) {
      return;
    }
    seen.add(resolved);
    candidates.push(resolved);
  }

  addCandidate(normalizedRoot);
  if (path.basename(normalizedRoot).toLowerCase() === 'models') {
    const parentRoot = path.dirname(normalizedRoot);
    if (path.basename(parentRoot).toLowerCase() === 'ollama-home') {
      addCandidate(path.join(path.dirname(parentRoot), 'models'));
    } else {
      addCandidate(path.join(parentRoot, 'ollama-home', 'models'));
    }
  }
  return candidates;
}

function listStoredModelEntries(storageRoot) {
  if (!storageRoot || !fs.existsSync(storageRoot)) {
    return [];
  }
  try {
    return fs.readdirSync(storageRoot, { withFileTypes: true })
      .filter((entry) => entry?.isFile?.() && /\.gguf$/i.test(String(entry.name || '')));
  } catch (_err) {
    return [];
  }
}

function resolveExistingModelStorageRoot(value) {
  const candidates = listCandidateModelStorageRoots(value);
  const populatedRoot = candidates.find((candidateRoot) => listStoredModelEntries(candidateRoot).length > 0);
  if (populatedRoot) {
    return populatedRoot;
  }
  const existingRoot = candidates.find((candidateRoot) => fs.existsSync(candidateRoot));
  return existingRoot || candidates[0] || DEFAULT_MODEL_STORAGE_ROOT;
}

function resolveConfigEntryPath(entry, fallbackPath = DEFAULT_MODEL_STORAGE_ROOT) {
  const configuredPath = String(entry?.value || '').trim();
  if (!configuredPath) {
    return fallbackPath;
  }
  const expanded = expandHomePath(configuredPath);
  if (path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }
  const baseRoot = normalizeConfigRoot(entry?.root);
  return baseRoot ? path.normalize(path.join(baseRoot, expanded)) : path.normalize(expanded);
}

function resolveOllamaHomeRoot(settings = {}) {
  const normalized = normalizeTrainingTuningSettings(settings);
  const storageRoot = resolveExistingModelStorageRoot(normalized.trainingModelStorageRoot);
  if (path.basename(storageRoot).toLowerCase() === 'models') {
    const parentRoot = path.dirname(storageRoot);
    if (path.basename(parentRoot).toLowerCase() === 'ollama-home') {
      return parentRoot;
    }
    return path.join(parentRoot, 'ollama-home');
  }
  return path.join(storageRoot, 'ollama-home');
}

function resolveOllamaModelsRoot(settings = {}) {
  return path.join(resolveOllamaHomeRoot(settings), 'models');
}

function toGiB(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.round((value / (1024 ** 3)) * 10) / 10;
}

function detectMachineProfile(settings = {}) {
  const normalized = normalizeTrainingTuningSettings(settings);
  const cpuCount = Math.max(1, Number(os.cpus()?.length || 1));
  const totalMemoryGiB = toGiB(os.totalmem());
  const platform = os.platform();
  const arch = os.arch();
  const isAppleSilicon = platform === 'darwin' && arch === 'arm64';
  let id = 'balanced-laptop';
  let label = 'Balanced laptop';
  let recommendedProfile = 'medium';
  let recommendedMode = 'recommended';
  let summary = 'Balanced tuning should keep the machine responsive while local model tasks run.';

  if (totalMemoryGiB <= 8 || cpuCount <= 4) {
    id = 'ultra-light';
    label = 'Ultra-light machine';
    recommendedProfile = 'low';
    recommendedMode = 'quiet';
    summary = 'Keep tuning conservative so editing, tests, and browser tabs stay responsive.';
  } else if (totalMemoryGiB <= 16 || cpuCount <= 8) {
    id = 'balanced-laptop';
    label = isAppleSilicon ? 'Apple silicon laptop' : 'Balanced laptop';
    recommendedProfile = 'medium';
    recommendedMode = 'recommended';
    summary = 'Medium tuning is the safest default for active coding on this machine.';
  } else if (totalMemoryGiB <= 32 || cpuCount <= 10) {
    id = 'creator-laptop';
    label = isAppleSilicon ? 'High-memory Apple silicon' : 'Creator laptop';
    recommendedProfile = 'high';
    recommendedMode = 'balanced';
    summary = 'This machine can handle a stronger profile, but should still preserve thermal headroom.';
  } else {
    id = 'workstation';
    label = 'Workstation-class machine';
    recommendedProfile = 'high';
    recommendedMode = 'throughput';
    summary = 'This machine has enough cores and memory for higher-throughput local tuning.';
  }

  return {
    id,
    label,
    platform,
    arch,
    cpuCount,
    totalMemoryGiB,
    isAppleSilicon,
    recommendedProfile,
    recommendedMode,
    summary,
    activeProfile: normalized.trainingProfile,
    ecoModeDefault: id !== 'workstation',
  };
}

function buildAdaptiveTrainingProfiles(settings = {}) {
  const normalized = normalizeTrainingTuningSettings(settings);
  const machine = detectMachineProfile(normalized);
  const maxThreads = Math.max(1, Number(os.cpus()?.length || 1));
  const quietThreads = Math.max(2, Math.min(4, maxThreads));
  const balancedThreads = Math.max(4, Math.min(machine.cpuCount >= 10 ? 8 : 6, maxThreads));
  const throughputThreads = Math.max(4, Math.min(machine.cpuCount >= 12 ? 10 : 8, maxThreads));
  const profiles = [
    {
      id: 'recommended',
      label: 'Use Recommended',
      description: 'Best fit for this machine while you keep coding.',
      patch: {
        trainingProfile: machine.recommendedProfile,
        trainingEcoMode: machine.ecoModeDefault,
        trainingCpuLimitPercent: machine.recommendedProfile === 'high' ? 70 : (machine.recommendedProfile === 'medium' ? 55 : 35),
        trainingThreadLimit: machine.recommendedProfile === 'high' ? balancedThreads : (machine.recommendedProfile === 'medium' ? Math.min(4, balancedThreads) : 2),
        trainingThermalPreset: machine.recommendedProfile === 'high' ? '85' : (machine.recommendedProfile === 'medium' ? '80' : '70'),
        trainingThermalCustomC: machine.recommendedProfile === 'high' ? 85 : (machine.recommendedProfile === 'medium' ? 80 : 70),
        trainingLiveSamplingSec: machine.recommendedProfile === 'high' ? 3 : 5,
      },
    },
    {
      id: 'quiet',
      label: 'Use Quiet',
      description: 'Lowest heat and best responsiveness while coding.',
      patch: {
        trainingProfile: 'low',
        trainingEcoMode: true,
        trainingCpuLimitPercent: 35,
        trainingThreadLimit: quietThreads,
        trainingThermalPreset: '70',
        trainingThermalCustomC: 70,
        trainingLiveSamplingSec: 10,
      },
    },
    {
      id: 'balanced',
      label: 'Use Balanced',
      description: 'Good daytime default for mixed coding and tuning.',
      patch: {
        trainingProfile: 'medium',
        trainingEcoMode: machine.id !== 'workstation',
        trainingCpuLimitPercent: 55,
        trainingThreadLimit: balancedThreads,
        trainingThermalPreset: '80',
        trainingThermalCustomC: 80,
        trainingLiveSamplingSec: 5,
      },
    },
    {
      id: 'throughput',
      label: 'Use Max Throughput',
      description: 'Push local tuning harder when you can spare the machine.',
      patch: {
        trainingProfile: 'high',
        trainingEcoMode: false,
        trainingCpuLimitPercent: machine.id === 'workstation' ? 85 : 80,
        trainingThreadLimit: throughputThreads,
        trainingThermalPreset: '90',
        trainingThermalCustomC: 90,
        trainingLiveSamplingSec: 3,
      },
    },
  ];
  return {
    machine,
    profiles,
  };
}

function resolveAdaptiveTrainingProfile(settings = {}, profileId = 'recommended') {
  const adaptive = buildAdaptiveTrainingProfiles(settings);
  const selected = adaptive.profiles.find((item) => item.id === String(profileId || '').trim()) || adaptive.profiles[0];
  return normalizeTrainingTuningSettings({
    ...normalizeTrainingTuningSettings(settings),
    ...selected.patch,
  });
}

function formatBytesShort(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex >= 3 ? 1 : 0;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function humanizeModelName(fileName) {
  const base = String(fileName || '').replace(/\.gguf$/i, '').trim();
  if (!base) {
    return 'Stored model';
  }
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\b([a-z])/g, (match) => match.toUpperCase())
    .replace(/Qwen(\d)/g, 'Qwen $1')
    .replace(/Deepseek/gi, 'DeepSeek')
    .trim();
}

function detectRecommendedModel(fileName) {
  return RECOMMENDED_LOCAL_MODELS.find((item) => String(item.fileName || '').toLowerCase() === String(fileName || '').toLowerCase()) || null;
}

function buildImportTagFromFileName(fileName, recommended = null) {
  if (recommended?.ollamaModel) {
    return String(recommended.ollamaModel).trim();
  }
  const base = String(fileName || '').replace(/\.gguf$/i, '').trim();
  if (!base) {
    return 'local-model:latest';
  }
  const quantMatch = base.match(/[-_](q\d(?:_[a-z0-9]+)+|iq\d(?:_[a-z0-9]+)+)$/i);
  const quant = quantMatch?.[1] || 'latest';
  const namePart = quantMatch ? base.slice(0, -quantMatch[0].length) : base;
  const normalizedName = namePart.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'local-model';
  const normalizedTag = String(quant).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'latest';
  return `${normalizedName}:${normalizedTag}`;
}

function walkDirectoryFiles(root) {
  const pending = [root];
  const files = [];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_err) {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function discoverConfiguredOllamaModels(settings = {}) {
  const normalized = normalizeTrainingTuningSettings(settings);
  const manifestsRoot = path.join(resolveOllamaModelsRoot(normalized), 'manifests');
  if (!fs.existsSync(manifestsRoot)) {
    return {
      manifestsRoot,
      exists: false,
      models: [],
    };
  }
  const seen = new Set();
  const models = walkDirectoryFiles(manifestsRoot)
    .map((filePath) => {
      const relativePath = path.relative(manifestsRoot, filePath);
      const segments = relativePath.split(path.sep).filter(Boolean);
      if (segments.length < 4) {
        return null;
      }
      const namespace = String(segments[1] || '').trim();
      const tag = String(segments[segments.length - 1] || '').trim();
      const nameParts = segments.slice(2, -1).map((item) => String(item || '').trim()).filter(Boolean);
      if (!tag || nameParts.length === 0) {
        return null;
      }
      const baseModel = nameParts.join('/');
      const value = namespace && namespace !== 'library'
        ? `${namespace}/${baseModel}:${tag}`
        : `${baseModel}:${tag}`;
      if (!value || seen.has(value)) {
        return null;
      }
      seen.add(value);
      return {
        value,
        label: tag === 'latest' ? baseModel : value,
        source: 'ollama-store',
        ready: true,
        note: 'registered in Ollama store',
      };
    })
    .filter(Boolean)
    .sort((left, right) => String(left.label || left.value || '').localeCompare(String(right.label || right.value || '')));
  return {
    manifestsRoot,
    exists: true,
    models,
  };
}

function discoverStoredModels(settings = {}) {
  const normalized = normalizeTrainingTuningSettings(settings);
  const storageRoot = resolveExistingModelStorageRoot(normalized.trainingModelStorageRoot);
  if (!storageRoot || !fs.existsSync(storageRoot)) {
    return {
      storageRoot,
      exists: false,
      models: [],
    };
  }
  const models = listStoredModelEntries(storageRoot)
    .map((entry) => {
      const fileName = String(entry.name || '');
      const fullPath = path.join(storageRoot, fileName);
      let sizeBytes = 0;
      try {
        sizeBytes = Number(fs.statSync(fullPath)?.size || 0);
      } catch (_err) {
        sizeBytes = 0;
      }
      const recommended = detectRecommendedModel(fileName);
      const importTag = buildImportTagFromFileName(fileName, recommended);
      return {
        id: recommended?.id || fileName.replace(/\.gguf$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        label: recommended?.label || humanizeModelName(fileName),
        value: recommended?.ollamaModel || importTag,
        importTag,
        ollamaModel: recommended?.ollamaModel || importTag,
        fileName,
        fullPath,
        sizeBytes,
        sizeLabel: recommended?.sizeLabel || formatBytesShort(sizeBytes),
        makeTarget: recommended?.makeTarget || '',
        source: 'storage',
        supported: true,
        importNeeded: true,
        recommended: !!recommended,
      };
    })
    .sort((left, right) => String(left.label || left.fileName || '').localeCompare(String(right.label || right.fileName || '')));
  return {
    storageRoot,
    exists: true,
    models,
  };
}

function buildTrainingModelSelectorOptions(settings = {}, ollamaModels = []) {
  const normalized = normalizeTrainingTuningSettings(settings);
  const discovered = discoverStoredModels(normalized);
  const configuredOllama = discoverConfiguredOllamaModels(normalized);
  const readyModels = new Set([
    ...(Array.isArray(ollamaModels) ? ollamaModels : []),
    ...configuredOllama.models.map((item) => item.value),
  ].map((item) => String(item || '').trim()).filter(Boolean));
  const options = [];
  const seen = new Set();

  const readyOptions = [
    ...(Array.isArray(ollamaModels) ? ollamaModels : []).map((modelName) => ({
      value: String(modelName || '').trim(),
      label: String(modelName || '').trim(),
      source: 'ollama',
      ready: true,
      note: 'ready in Ollama',
    })),
    ...configuredOllama.models,
  ];

  for (const entry of readyOptions) {
    const value = String(entry?.value || '').trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    options.push({
      value,
      label: String(entry?.label || value).trim() || value,
      source: String(entry?.source || 'ollama').trim() || 'ollama',
      supported: true,
      ready: entry?.ready !== false,
      note: String(entry?.note || 'ready in Ollama').trim() || 'ready in Ollama',
    });
  }

  for (const item of discovered.models) {
    const optionValue = item.ollamaModel || item.importTag || item.value || `file:${item.fileName}`;
    if (seen.has(optionValue)) {
      continue;
    }
    seen.add(optionValue);
    const ready = readyModels.has(String(item.importTag || item.ollamaModel || '').trim());
    options.push({
      value: optionValue,
      label: item.label,
      source: item.source,
      supported: true,
      ready,
      fileName: item.fileName,
      sizeLabel: item.sizeLabel,
      importTag: item.importTag,
      note: ready ? 'ready in Ollama' : 'stored on SSD • import needed',
    });
  }

  const selectedValue = String(normalized.trainingOllamaModel || '').trim();
  if (selectedValue && !seen.has(selectedValue)) {
    options.unshift({
      value: selectedValue,
      label: selectedValue,
      source: 'current',
      supported: true,
      ready: false,
      note: 'current setting',
    });
  }

  return {
    storageRoot: discovered.storageRoot,
    storageReachable: discovered.exists,
    configuredOllamaRoot: configuredOllama.manifestsRoot,
    configuredOllamaReachable: configuredOllama.exists,
    registered: configuredOllama.models,
    discovered: discovered.models.map((item) => ({
      ...item,
      ready: readyModels.has(String(item.importTag || item.ollamaModel || '').trim()),
      importNeeded: !readyModels.has(String(item.importTag || item.ollamaModel || '').trim()),
    })),
    options,
  };
}

function normalizeThermalPreset(value, fallback = DEFAULT_TUNING_SETTINGS.trainingThermalPreset) {
  const raw = String(value || '').trim().toLowerCase();
  if (['90', '85', '80', '75', '70', 'custom'].includes(raw)) {
    return raw;
  }
  return String(fallback || DEFAULT_TUNING_SETTINGS.trainingThermalPreset);
}

function resolveThermalCeilingC(settings = {}) {
  const preset = normalizeThermalPreset(settings.trainingThermalPreset, settings.trainingThermalPreset);
  if (preset === 'custom') {
    return parseNumber(settings.trainingThermalCustomC, DEFAULT_TUNING_SETTINGS.trainingThermalCustomC, 55, 105);
  }
  return parseNumber(preset, DEFAULT_TUNING_SETTINGS.trainingThermalCustomC, 55, 105);
}

function resolveEffectiveTuning(normalized) {
  const ecoMode = !!normalized.trainingEcoMode;
  const effectiveThreadLimit = ecoMode ? Math.min(normalized.trainingThreadLimit, 4) : normalized.trainingThreadLimit;
  const effectiveCpuLimitPercent = ecoMode ? Math.min(normalized.trainingCpuLimitPercent, 45) : normalized.trainingCpuLimitPercent;
  const effectiveThermalCeilingC = ecoMode ? Math.min(normalized.trainingThermalCeilingC, 75) : normalized.trainingThermalCeilingC;
  const effectiveLiveSamplingSec = ecoMode ? Math.max(normalized.trainingLiveSamplingSec, 10) : normalized.trainingLiveSamplingSec;
  return {
    trainingEcoMode: ecoMode,
    threadLimit: effectiveThreadLimit,
    cpuLimitPercent: effectiveCpuLimitPercent,
    thermalCeilingC: effectiveThermalCeilingC,
    liveSamplingSec: effectiveLiveSamplingSec,
    ollamaKeepAlive: ecoMode ? false : normalized.trainingOllamaKeepAlive,
    ollamaNumParallel: ecoMode ? 1 : ((normalized.preset || PROFILE_PRESETS.medium).ollamaNumParallel || 1),
  };
}

function normalizeTrainingTuningSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const trainingHardwareTarget = normalizeHardwareTarget(source.trainingHardwareTarget);
  const hardwarePreset = getHardwareTargetPreset(trainingHardwareTarget);
  const patchedSource = trainingHardwareTarget !== 'auto'
    ? { ...hardwarePreset.patch, ...source }
    : source;
  const profile = normalizeProfile(patchedSource.trainingProfile || patchedSource.profile);
  const preset = PROFILE_PRESETS[profile] || PROFILE_PRESETS.medium;
  const thermalPreset = normalizeThermalPreset(patchedSource.trainingThermalPreset, String(preset.thermalCeilingC));
  const normalized = {
    trainingProfile: profile,
    trainingLaunchSurface: normalizeLaunchSurface(patchedSource.trainingLaunchSurface),
    trainingEcoMode: parseBool(patchedSource.trainingEcoMode, DEFAULT_TUNING_SETTINGS.trainingEcoMode),
    trainingCpuLimitPercent: parseNumber(patchedSource.trainingCpuLimitPercent, preset.cpuLimitPercent, 10, 100),
    trainingThreadLimit: parseNumber(patchedSource.trainingThreadLimit, preset.threadLimit, 1, Math.max(1, Number(os.cpus()?.length || 8))),
    trainingThermalPreset: thermalPreset,
    trainingThermalCustomC: parseNumber(patchedSource.trainingThermalCustomC, preset.thermalCeilingC, 55, 105),
    trainingPauseOnThermal: parseBool(patchedSource.trainingPauseOnThermal, DEFAULT_TUNING_SETTINGS.trainingPauseOnThermal),
    trainingAllowDuringActiveUse: parseBool(patchedSource.trainingAllowDuringActiveUse, DEFAULT_TUNING_SETTINGS.trainingAllowDuringActiveUse),
    trainingAutoStartOllama: parseBool(patchedSource.trainingAutoStartOllama, DEFAULT_TUNING_SETTINGS.trainingAutoStartOllama),
    trainingOllamaModel: String(patchedSource.trainingOllamaModel || DEFAULT_TUNING_SETTINGS.trainingOllamaModel).trim() || DEFAULT_TUNING_SETTINGS.trainingOllamaModel,
    trainingOllamaKeepAlive: parseBool(patchedSource.trainingOllamaKeepAlive, DEFAULT_TUNING_SETTINGS.trainingOllamaKeepAlive),
    trainingModelStorageRoot: normalizeModelStorageRoot(patchedSource.trainingModelStorageRoot),
    trainingLiveSamplingSec: parseNumber(patchedSource.trainingLiveSamplingSec, DEFAULT_TUNING_SETTINGS.trainingLiveSamplingSec, 2, 30),
    trainingHardwareTarget,
  };
  normalized.trainingThermalCeilingC = resolveThermalCeilingC(normalized);
  normalized.profileLabel = preset.label;
  normalized.preset = preset;
  normalized.effective = resolveEffectiveTuning(normalized);
  normalized.recommendedModels = RECOMMENDED_LOCAL_MODELS;
  normalized.hardwareTargetPreset = hardwarePreset;
  return normalized;
}

function readFlatConfigEntries(workspaceRoot) {
  const entries = {};
  for (const root of listConfigRoots(workspaceRoot)) {
    for (const fileName of ['dev_assistant.yaml', 'dev_assistant.local.yaml']) {
      const filePath = path.join(root, fileName);
      if (!fs.existsSync(filePath)) {
        continue;
      }
      try {
        const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
        for (const rawLine of lines) {
          const line = String(rawLine || '').split('#')[0];
          const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
          if (!match) {
            continue;
          }
          const key = match[1];
          const value = parseScalar(match[2]);
          if (value !== '') {
            entries[key] = { value, root };
          }
        }
      } catch (_err) {
        return entries;
      }
    }
  }
  return entries;
}

function readFlatConfigMap(workspaceRoot) {
  const entries = readFlatConfigEntries(workspaceRoot);
  return Object.fromEntries(
    Object.entries(entries).map(([key, entry]) => [key, entry.value]),
  );
}

function readTrainingTuningSettings(workspaceRoot) {
  const entries = readFlatConfigEntries(workspaceRoot);
  const next = {};
  for (const [field, key] of Object.entries(TRAINING_TUNING_KEY_MAP)) {
    if (entries[key] !== undefined) {
      next[field] = entries[key].value;
    }
  }
  if (entries.assistant_training_model_storage_root) {
    next.trainingModelStorageRoot = resolveConfigEntryPath(entries.assistant_training_model_storage_root, DEFAULT_MODEL_STORAGE_ROOT);
  }
  return normalizeTrainingTuningSettings(next);
}

function formatConfigValue(field, value) {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (field === 'trainingProfile') {
    return normalizeProfile(value);
  }
  if (field === 'trainingLaunchSurface') {
    return normalizeLaunchSurface(value);
  }
  if (field === 'trainingThermalPreset') {
    return normalizeThermalPreset(value);
  }
  if (['trainingCpuLimitPercent', 'trainingThreadLimit', 'trainingThermalCustomC', 'trainingLiveSamplingSec'].includes(field)) {
    return String(value);
  }
  const text = String(value || '').trim();
  return /[\s:#]/.test(text) ? JSON.stringify(text) : text;
}

function writeTrainingTuningSettings(workspaceRoot, payload = {}) {
  const root = String(workspaceRoot || '').trim();
  if (!root) {
    return normalizeTrainingTuningSettings(payload);
  }
  const normalized = normalizeTrainingTuningSettings(payload);
  const configPath = configPathForWorkspace(root);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const lines = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, 'utf8').split(/\r?\n/)
    : [];

  for (const [field, key] of Object.entries(TRAINING_TUNING_KEY_MAP)) {
    const nextLine = `${key}: ${formatConfigValue(field, normalized[field])}`;
    const existingIndex = lines.findIndex((line) => {
      if (/^\s*#/.test(String(line || ''))) {
        return false;
      }
      return new RegExp(`^${key}:\\s*`).test(String(line || '').trim());
    });
    if (existingIndex >= 0) {
      lines[existingIndex] = nextLine;
    } else {
      lines.push(nextLine);
    }
  }

  fs.writeFileSync(configPath, `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`, 'utf8');
  return readTrainingTuningSettings(root);
}

function buildResourceEnv(settings = {}) {
  const normalized = normalizeTrainingTuningSettings(settings);
  const effective = normalized.effective || resolveEffectiveTuning(normalized);
  const threadLimit = effective.threadLimit || normalized.trainingThreadLimit || PROFILE_PRESETS.medium.threadLimit;
  const ollamaHome = resolveOllamaHomeRoot(normalized);
  const ollamaModels = resolveOllamaModelsRoot(normalized);
  return {
    OMP_NUM_THREADS: String(threadLimit),
    OPENBLAS_NUM_THREADS: String(threadLimit),
    MKL_NUM_THREADS: String(threadLimit),
    VECLIB_MAXIMUM_THREADS: String(threadLimit),
    NUMEXPR_NUM_THREADS: String(threadLimit),
    GOMAXPROCS: String(threadLimit),
    OLLAMA_NUM_PARALLEL: String(effective.ollamaNumParallel || 1),
    OLLAMA_MODEL: normalized.trainingOllamaModel,
    OLLAMA_HOME: ollamaHome,
    OLLAMA_MODELS: ollamaModels,
    OLLAMA_KEEP_ALIVE: effective.ollamaKeepAlive ? '30m' : '0m',
    GOSENDERR_TRAINING_PROFILE: normalized.trainingProfile,
    GOSENDERR_TRAINING_ECO_MODE: effective.trainingEcoMode ? '1' : '0',
    GOSENDERR_TRAINING_CPU_LIMIT_PERCENT: String(effective.cpuLimitPercent),
    GOSENDERR_TRAINING_THERMAL_CEILING: String(effective.thermalCeilingC),
    GOSENDERR_MODEL_STORAGE_ROOT: normalized.trainingModelStorageRoot,
  };
}

function buildTrainingRunPayload(settings = {}, overrides = {}) {
  const normalized = normalizeTrainingTuningSettings(settings);
  const preset = PROFILE_PRESETS[normalized.trainingProfile] || PROFILE_PRESETS.medium;
  const effective = normalized.effective || resolveEffectiveTuning(normalized);
  const payload = {
    profile: normalized.trainingProfile,
    ecoMode: effective.trainingEcoMode,
    threadLimit: effective.threadLimit,
    cpuLimitPercent: effective.cpuLimitPercent,
    thermalCeilingC: effective.thermalCeilingC,
    pauseOnThermal: normalized.trainingPauseOnThermal,
    allowDuringActiveUse: normalized.trainingAllowDuringActiveUse,
    autoStartOllama: normalized.trainingAutoStartOllama,
    ollamaModel: normalized.trainingOllamaModel,
    ollamaKeepAlive: effective.ollamaKeepAlive,
    modelStorageRoot: normalized.trainingModelStorageRoot,
    niceIncrement: preset.niceIncrement,
    minExamples: preset.minExamples,
    minLogExamples: preset.minLogExamples,
    minArtifactExamples: preset.minArtifactExamples,
    envOverrides: buildResourceEnv(normalized),
    ...overrides,
  };
  payload.envOverrides = {
    ...buildResourceEnv(normalized),
    ...(overrides.envOverrides || {}),
  };
  return payload;
}

function buildLearnRunPayload(settings = {}, overrides = {}) {
  return buildTrainingRunPayload(settings, overrides);
}

function buildSelfImproveRunPayload(settings = {}, overrides = {}) {
  const normalized = normalizeTrainingTuningSettings(settings);
  const preset = PROFILE_PRESETS[normalized.trainingProfile] || PROFILE_PRESETS.medium;
  const effective = normalized.effective || resolveEffectiveTuning(normalized);
  const payload = {
    profile: normalized.trainingProfile,
    count: preset.selfImproveCount,
    autopilotCount: preset.selfImproveCount,
    ecoMode: effective.trainingEcoMode,
    threadLimit: effective.threadLimit,
    cpuLimitPercent: effective.cpuLimitPercent,
    thermalCeilingC: effective.thermalCeilingC,
    pauseOnThermal: normalized.trainingPauseOnThermal,
    allowDuringActiveUse: normalized.trainingAllowDuringActiveUse,
    autoStartOllama: normalized.trainingAutoStartOllama,
    ollamaModel: normalized.trainingOllamaModel,
    ollamaKeepAlive: effective.ollamaKeepAlive,
    modelStorageRoot: normalized.trainingModelStorageRoot,
    niceIncrement: preset.niceIncrement,
    envOverrides: buildResourceEnv(normalized),
    ...overrides,
  };
  payload.envOverrides = {
    ...buildResourceEnv(normalized),
    ...(overrides.envOverrides || {}),
  };
  return payload;
}

function buildTerminalTrainingCommand(workspaceRoot, settings = {}, action = 'train') {
  const normalized = normalizeTrainingTuningSettings(settings);
  const profile = normalized.trainingProfile;
  const root = String(workspaceRoot || '').trim();
  const envPrefix = buildShellEnvPrefix(normalized);
  if (!root) {
    return '';
  }
  if (action === 'learn') {
    return `cd ${shellQuote(root)} && ${envPrefix}make train-assistant-profile PROFILE=${profile} && ${envPrefix}make dev-assist-log`;
  }
  if (action === 'self-improve') {
    return `cd ${shellQuote(root)} && ${envPrefix}make solo-assist-run ARGS="--profile aiWrite --template auto --training-profile ${profile}"`;
  }
  return `cd ${shellQuote(root)} && ${envPrefix}make train-assistant-profile PROFILE=${profile}`;
}

function buildModelDownloadCommand(workspaceRoot, settings = {}, modelId = 'pack') {
  const normalized = normalizeTrainingTuningSettings(settings);
  const root = String(workspaceRoot || '').trim();
  if (!root) {
    return '';
  }
  const model = RECOMMENDED_LOCAL_MODELS.find((item) => item.id === modelId);
  const target = model ? model.makeTarget : 'model-download-coder-pack';
  return `cd ${shellQuote(root)} && make ${target} MODEL_ROOT=${shellQuote(normalized.trainingModelStorageRoot)}`;
}

function buildHuggingFaceDownloadCommand(model = {}, settings = {}) {
  const normalized = normalizeTrainingTuningSettings(settings);
  const repoId = String(model.repoId || '').trim();
  const fileName = String(model.fileName || '').trim();
  if (!repoId || !fileName) {
    return '';
  }
  return [
    'python -m huggingface_hub download',
    shellQuote(repoId),
    shellQuote(fileName),
    '--local-dir',
    shellQuote(normalized.trainingModelStorageRoot),
  ].join(' ');
}

function buildModelInstallPresets(workspaceRoot, settings = {}) {
  const normalized = normalizeTrainingTuningSettings(settings);
  const selectedHardwareTarget = normalizeHardwareTarget(normalized.trainingHardwareTarget);
  return RECOMMENDED_LOCAL_MODELS.map((model) => {
    const recommendedTargets = Array.isArray(model.recommendedTargets) ? model.recommendedTargets : [];
    const ollamaPullCommand = String(model.ollamaModel || '').trim()
      ? `ollama pull ${shellQuote(model.ollamaModel)}`
      : '';
    const huggingFaceDownloadCommand = buildHuggingFaceDownloadCommand(model, normalized);
    return {
      id: model.id,
      label: model.label,
      sizeLabel: model.sizeLabel,
      sourcePortal: String(model.sourcePortal || 'curated'),
      sourceLabel: String(model.sourceLabel || 'Curated source'),
      sourceUrl: String(model.sourceUrl || '').trim(),
      repoId: String(model.repoId || '').trim(),
      ollamaModel: String(model.ollamaModel || '').trim(),
      fileName: String(model.fileName || '').trim(),
      recommendedTargets,
      hardwareRecommended: selectedHardwareTarget === 'auto' || recommendedTargets.includes(selectedHardwareTarget),
      downloadCommand: ollamaPullCommand || huggingFaceDownloadCommand || buildModelDownloadCommand(workspaceRoot, normalized, model.id),
      ollamaPullCommand,
      huggingFaceDownloadCommand,
      installSummary: ollamaPullCommand
        ? 'Use Ollama pull for the fastest setup on this machine.'
        : (huggingFaceDownloadCommand
          ? 'Use Hugging Face download when the model is not available as an Ollama tag.'
          : 'Use the curated workspace download target.'),
    };
  });
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'"'"'`)}'`;
}

function buildShellEnvPrefix(settings = {}) {
  const env = buildResourceEnv(settings);
  return Object.entries(env)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ') + ' ';
}

function requestJson(url, timeoutMs = 900) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
      });
      response.on('end', () => {
        try {
          resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, statusCode: response.statusCode, json: JSON.parse(raw || '{}') });
        } catch (_err) {
          resolve({ ok: false, statusCode: response.statusCode, json: null });
        }
      });
    });
    request.on('error', () => resolve({ ok: false, statusCode: 0, json: null }));
    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false, statusCode: 0, json: null });
    });
  });
}

function buildTrainingTrustSummary(snapshot = {}, fallbackSettings = {}) {
  const settings = normalizeTrainingTuningSettings(snapshot.settings || fallbackSettings);
  const runtime = snapshot.runtime && typeof snapshot.runtime === 'object' ? snapshot.runtime : {};
  const memory = snapshot.memory && typeof snapshot.memory === 'object' ? snapshot.memory : {};
  const thermal = snapshot.thermal && typeof snapshot.thermal === 'object' ? snapshot.thermal : {};
  const ollama = snapshot.ollama && typeof snapshot.ollama === 'object' ? snapshot.ollama : {};
  const models = snapshot.models && typeof snapshot.models === 'object' ? snapshot.models : {};
  const severityRank = { ready: 0, caution: 1, pause: 2 };
  let status = 'ready';
  let trustLevel = 'high';
  const reasonCodes = [];
  const reasons = [];
  const actions = [];
  let fallbackPlan = null;

  function elevate(nextStatus, trust, code, reason, action) {
    if (!severityRank.hasOwnProperty(nextStatus)) {
      return;
    }
    if (severityRank[nextStatus] > severityRank[status]) {
      status = nextStatus;
      trustLevel = trust;
    } else if (severityRank[nextStatus] === severityRank[status] && trustLevel === 'high' && trust !== 'high') {
      trustLevel = trust;
    }
    if (code && !reasonCodes.includes(code)) {
      reasonCodes.push(code);
    }
    if (reason && !reasons.includes(reason)) {
      reasons.push(reason);
    }
    if (action && !actions.includes(action)) {
      actions.push(action);
    }
  }

  function ensureFallbackPlan(plan = {}) {
    if (fallbackPlan) {
      return;
    }
    fallbackPlan = {
      id: String(plan.id || 'quiet-training-fallback').trim(),
      label: String(plan.label || 'Use quiet fallback').trim(),
      summary: String(plan.summary || '').trim(),
      recommendedProfile: String(plan.recommendedProfile || 'low').trim(),
      ecoMode: plan.ecoMode !== false,
      seedFoundryCandidate: plan.seedFoundryCandidate !== false,
      prepareTrainingHandoff: plan.prepareTrainingHandoff !== false,
      notes: Array.isArray(plan.notes) ? plan.notes.map((item) => String(item || '').trim()).filter(Boolean) : [],
    };
  }

  const cpuUsagePercent = Math.max(0, Number(snapshot.cpuUsagePercent || 0));
  const cpuLimitPercent = Math.max(1, Number(runtime.cpuLimitPercent || settings.effective?.cpuLimitPercent || settings.trainingCpuLimitPercent || 55));
  const memoryUsedPercent = Math.max(0, Number(memory.usedPercent || snapshot.memoryUsedPercent || 0));
  const activeRuns = Math.max(0, Number(runtime.activeRuns || 0));
  const schedulerRunning = runtime.schedulerRunning === true;
  const lastUpdatedAt = snapshot.lastUpdatedAt ?? snapshot.sampledAt ?? null;
  const lastUpdatedMs = typeof lastUpdatedAt === 'number'
    ? Number(lastUpdatedAt)
    : Date.parse(String(lastUpdatedAt || ''));
  const nowMs = Number.isFinite(Number(snapshot.nowMs)) ? Number(snapshot.nowMs) : Date.now();
  const telemetryAgeMs = Number.isFinite(lastUpdatedMs) ? Math.max(0, nowMs - lastUpdatedMs) : null;
  const telemetryFresh = telemetryAgeMs !== null && telemetryAgeMs <= TRAINING_TELEMETRY_STALE_MS;
  const selectedModel = String(ollama.selectedModel || settings.trainingOllamaModel || '').trim();
  const selectedModelReady = ollama.selectedModelReady !== false;

  if (!telemetryFresh) {
    elevate(
      'caution',
      'medium',
      TRAINING_TRUST_REASON_CODES.TELEMETRY_STALE,
      'Training telemetry is stale, so the current advisory may not reflect the latest runtime or provider state.',
      'Refresh tuning telemetry or reconnect the host before trusting this advisory for another learn or self-improve run.',
    );
  }

  if (settings.trainingPauseOnThermal && ['heavy', 'limited'].includes(String(thermal.state || '').toLowerCase())) {
    elevate(
      'pause',
      'low',
      TRAINING_TRUST_REASON_CODES.THERMAL_PRESSURE,
      'Thermal pressure is elevated, so local training should pause before the machine throttles harder.',
      'Let the machine cool down or switch to a quieter adaptive profile before the next learn or self-improve run.',
    );
    ensureFallbackPlan({
      id: 'thermal-quiet-fallback',
      label: 'Cool down and use the quiet profile',
      summary: 'Pause full local training, then resume with the quiet profile and a smaller supervised slice.',
      recommendedProfile: 'low',
      ecoMode: true,
      notes: [
        'Wait for thermal pressure to return to nominal before retrying full local training.',
        'Use prompt distillation or a training handoff instead of a heavy local tuning pass right now.',
      ],
    });
  }

  if (memoryUsedPercent >= 92) {
    elevate(
      'pause',
      'low',
      TRAINING_TRUST_REASON_CODES.MEMORY_PRESSURE,
      'Memory pressure is critically high for another local training pass.',
      'Close other heavy apps or wait for current runs to finish before launching another training action.',
    );
    ensureFallbackPlan({
      id: 'memory-quiet-fallback',
      label: 'Use a low-memory fallback path',
      summary: 'Keep learning moving with a quiet profile, training handoff export, and a lighter local route bundle.',
      recommendedProfile: 'low',
      ecoMode: true,
      notes: [
        'Export a supervised training handoff instead of running a full local training pass.',
        'Seed a low-memory Model Foundry candidate before retrying a heavier route.',
      ],
    });
  } else if (memoryUsedPercent >= 85) {
    elevate(
      'caution',
      'medium',
      TRAINING_TRUST_REASON_CODES.MEMORY_WARM,
      'Memory use is already high enough that another run may make the machine sluggish.',
      'Prefer targeted validation or a quiet profile until memory usage drops.',
    );
    ensureFallbackPlan({
      id: 'memory-warm-fallback',
      label: 'Use the quiet profile first',
      summary: 'Memory is warm enough that the next safer move is a quiet profile plus smaller supervised learning slices.',
      recommendedProfile: 'low',
      ecoMode: true,
      notes: [
        'Keep the next learn or self-improve pass bounded and selector-first.',
      ],
    });
  }

  if (cpuUsagePercent >= Math.min(100, cpuLimitPercent + 25)) {
    elevate(
      'pause',
      'low',
      TRAINING_TRUST_REASON_CODES.CPU_PRESSURE,
      'CPU load is already well above the current training guardrail.',
      'Wait for CPU load to settle or lower the profile before launching another training action.',
    );
    ensureFallbackPlan({
      id: 'cpu-quiet-fallback',
      label: 'Wait, then retry with a quiet profile',
      summary: 'CPU load is too high for another full local pass. Reduce concurrency and use a smaller supervised slice next.',
      recommendedProfile: 'low',
      ecoMode: true,
      notes: [
        'Favor validation, docs refresh, or training handoff export while CPU pressure stays high.',
      ],
    });
  } else if (cpuUsagePercent >= Math.min(100, cpuLimitPercent + 10)) {
    elevate(
      'caution',
      'medium',
      TRAINING_TRUST_REASON_CODES.CPU_WARM,
      'CPU load is above the preferred guardrail for background tuning.',
      'Use targeted validation first or keep eco mode enabled until load falls back inside the cap.',
    );
    ensureFallbackPlan({
      id: 'cpu-warm-fallback',
      label: 'Keep eco mode enabled',
      summary: 'CPU pressure is elevated, so eco mode and smaller supervised slices are the safer next step.',
      recommendedProfile: 'medium',
      ecoMode: true,
      notes: [
        'Do smaller supervised learn slices before attempting another heavier training pass.',
      ],
    });
  }

  if (activeRuns >= 2) {
    elevate(
      'pause',
      'low',
      TRAINING_TRUST_REASON_CODES.ACTIVE_RUN_IN_PROGRESS,
      'Multiple assistant runs are already active, so adding training now would compete for the same machine resources.',
      'Finish or cancel the current runs before starting another training or self-improvement pass.',
    );
  } else if (activeRuns >= 1) {
    elevate(
      'caution',
      'medium',
      TRAINING_TRUST_REASON_CODES.ACTIVE_RUN_IN_PROGRESS,
      'An assistant run is already active, so another training pass may reduce responsiveness.',
      'Prefer smaller targeted checks until the active run or scheduler cycle is finished.',
    );
  }

  if (schedulerRunning) {
    elevate(
      'caution',
      'medium',
      TRAINING_TRUST_REASON_CODES.SCHEDULER_ACTIVE,
      'The autopilot scheduler is active, so another manual training pass may overlap with scheduled work.',
      'Let the current scheduler cycle finish or pause it before starting another learn or self-improve run.',
    );
  }

  if (!ollama.running) {
    elevate(
      'caution',
      settings.trainingAutoStartOllama ? 'medium' : 'low',
      TRAINING_TRUST_REASON_CODES.OLLAMA_NOT_RUNNING,
      settings.trainingAutoStartOllama
        ? 'Ollama is offline right now, but auto-start is enabled for the next training action.'
        : 'Ollama is offline, so local model training cannot start yet.',
      settings.trainingAutoStartOllama
        ? 'Start Ollama from the host or wait for the next run to auto-start it.'
        : 'Start Ollama or enable auto-start before running learn or self-improve.',
    );
  }

  if (selectedModel && selectedModelReady === false) {
    elevate(
      'caution',
      'medium',
      TRAINING_TRUST_REASON_CODES.SELECTED_MODEL_NOT_READY,
      `The selected model (${selectedModel}) is not ready in Ollama yet.`,
      'Import the stored GGUF into Ollama or switch to a model that is already ready.',
    );
    ensureFallbackPlan({
      id: 'selected-model-not-ready-fallback',
      label: 'Switch to a ready local model first',
      summary: 'Use a ready local model or import the selected GGUF into Ollama before the next heavier training pass.',
      recommendedProfile: activeRuns >= 1 || schedulerRunning ? 'low' : 'medium',
      ecoMode: true,
      notes: [
        'Prefer the lighter ready local model for short validation or targeted learning until the selected model is available.',
        'Import the stored GGUF into Ollama before retrying the selected route.',
      ],
    });
  }

  if (!models.storageReachable && !ollama.running) {
    elevate(
      'caution',
      'medium',
      TRAINING_TRUST_REASON_CODES.PROVIDER_UNAVAILABLE,
      'Neither Ollama nor the configured model storage folder is ready yet.',
      'Verify the model storage root and Ollama service before retrying training.',
    );
  }

  const summary = reasons[0] || 'Local training is inside the current resource guardrails.';
  const recommendedAction = actions[0] || 'Proceed with a targeted learn or self-improve run.';
  const trustState = status === 'pause' ? 'pauseSuggested' : status;
  const primaryReason = reasonCodes[0] || null;
  return {
    status,
    trustState,
    trustLevel,
    pauseSuggested: status === 'pause',
    telemetryFresh,
    telemetryAgeMs,
    lastUpdatedAt: Number.isFinite(lastUpdatedMs) ? new Date(lastUpdatedMs).toISOString() : null,
    reasonCodes,
    primaryReason,
    reasons,
    summary,
    recommendedNextStep: recommendedAction,
    recommendedAction,
    fallbackPlan,
    recoverable: true,
    activeGuardrails: {
      cpuLimitPercent,
      thermalCeilingC: Number(runtime.thermalCeilingC || settings.trainingThermalCeilingC || settings.effective?.thermalCeilingC || 0),
      threadLimit: Number(runtime.threadLimit || settings.trainingThreadLimit || settings.effective?.threadLimit || 0),
      pauseOnThermal: settings.trainingPauseOnThermal === true,
      allowDuringActiveUse: settings.trainingAllowDuringActiveUse === true,
    },
  };
}

function normalizeProviderSource(value) {
  return String(value || '').trim().toLowerCase();
}

function isLocalProviderSource(value) {
  return LOCAL_PROVIDER_SOURCES.has(normalizeProviderSource(value));
}

function inferModelFamily(value) {
  const base = String(value || '').trim().toLowerCase();
  if (!base) {
    return '';
  }
  return base.split(':')[0].trim();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function resolveSelectorSnapshot(settings = {}, telemetry = {}) {
  const telemetryModels = telemetry?.models && typeof telemetry.models === 'object' ? telemetry.models : {};
  if (Array.isArray(telemetryModels.availableOptions) && telemetryModels.availableOptions.length > 0) {
    return {
      storageRoot: String(telemetryModels.storageRoot || settings.trainingModelStorageRoot || '').trim(),
      storageReachable: telemetryModels.storageReachable === true,
      configuredOllamaRoot: String(telemetryModels.registeredRoot || '').trim(),
      configuredOllamaReachable: telemetryModels.registeredReachable === true,
      registered: toArray(telemetryModels.registered),
      discovered: toArray(telemetryModels.discovered),
      options: toArray(telemetryModels.availableOptions),
    };
  }
  const ollamaModels = toArray(telemetry?.ollama?.models).map((item) => String(item || '').trim()).filter(Boolean);
  return buildTrainingModelSelectorOptions(settings, ollamaModels);
}

function findSelectorMatch(selector = {}, modelName = '') {
  const target = String(modelName || '').trim();
  if (!target) {
    return { option: null, discovered: null, registered: null };
  }
  const option = toArray(selector.options).find((item) => String(item?.value || '').trim() === target) || null;
  const discovered = toArray(selector.discovered).find((item) => (
    String(item?.ollamaModel || '').trim() === target
    || String(item?.importTag || '').trim() === target
    || String(item?.value || '').trim() === target
  )) || null;
  const registered = toArray(selector.registered).find((item) => String(item?.value || '').trim() === target) || null;
  return { option, discovered, registered };
}

function findBenchmarkIdentity(target = {}, benchmarkSummary = []) {
  const wrappedProfileId = String(target?.wrappedProfileId || '').trim();
  const baseModel = String(target?.baseModel || '').trim();
  const providerSource = normalizeProviderSource(target?.providerSource);
  const match = toArray(benchmarkSummary).find((item) => (
    (wrappedProfileId && String(item?.modelProfileId || item?.wrappedProfileId || '').trim() === wrappedProfileId)
    || (baseModel && String(item?.baseModel || item?.model || '').trim() === baseModel
      && (!providerSource || normalizeProviderSource(item?.providerSource) === providerSource))
  )) || null;
  if (!match) {
    return null;
  }
  return {
    id: String(match.id || match.outputPath || '').trim(),
    modelProfileId: String(match.modelProfileId || match.wrappedProfileId || '').trim(),
    baseModel: String(match.baseModel || match.model || '').trim(),
    providerSource: normalizeProviderSource(match.providerSource),
    taskMode: String(match.taskMode || '').trim().toLowerCase(),
    passRate: Number(match.passRate || 0),
    status: String(match.status || '').trim().toLowerCase(),
  };
}

function findFoundryCandidateLink(target = {}, foundryStatus = {}) {
  const wrappedProfileId = String(target?.wrappedProfileId || '').trim();
  const baseModel = String(target?.baseModel || '').trim();
  const providerSource = normalizeProviderSource(target?.providerSource);
  const candidates = [
    ...toArray(foundryStatus?.candidates),
    ...toArray(foundryStatus?.suggested),
  ];
  const match = candidates.find((item) => (
    (wrappedProfileId && String(item?.modelProfileId || '').trim() === wrappedProfileId)
    || (baseModel && String(item?.baseModel || '').trim() === baseModel
      && (!providerSource || !String(item?.providerSource || '').trim() || normalizeProviderSource(item?.providerSource) === providerSource))
    || (baseModel && toArray(item?.recommendedModels).some((model) => String(model || '').trim() === baseModel))
  )) || null;
  if (!match) {
    return null;
  }
  return {
    id: String(match.id || '').trim(),
    title: String(match.title || '').trim(),
    safetyLevel: String(match.safetyLevel || '').trim().toLowerCase(),
    modelProfileId: String(match.modelProfileId || '').trim(),
    baseModel: String(match.baseModel || '').trim(),
    providerSource: normalizeProviderSource(match.providerSource),
    taskMode: String(match.taskMode || '').trim().toLowerCase(),
    sourceBenchmarks: toArray(match.sourceBenchmarks).map((item) => String(item || '').trim()).filter(Boolean),
  };
}

function buildLocalInventoryEntry(kind, payload = {}, selector = {}, benchmarkSummary = [], foundryStatus = {}, tuningTrust = {}) {
  const label = String(payload.label || payload.displayName || payload.title || payload.id || 'Local model').trim();
  const wrappedProfileId = String(payload.wrappedProfileId || payload.modelProfileId || payload.id || '').trim();
  const baseModel = String(payload.baseModel || '').trim();
  const providerSource = normalizeProviderSource(payload.providerSource || payload.baseProvider);
  const selectorMatch = findSelectorMatch(selector, baseModel);
  const localVisible = isLocalProviderSource(providerSource) || !!selectorMatch.option || !!selectorMatch.discovered || !!selectorMatch.registered;
  const localReady = selectorMatch.option?.ready === true || selectorMatch.registered?.ready === true;
  const installState = !localVisible
    ? ''
    : localReady
      ? 'installed'
      : (selectorMatch.discovered ? 'import-needed' : 'unknown');
  return {
    id: `${kind}:${String(payload.id || payload.modelProfileId || payload.baseModel || label).trim()}`,
    kind,
    label,
    wrappedProfileId,
    wrappedProfileRole: String(payload.role || payload.wrappedProfileRole || '').trim().toLowerCase(),
    modelFamily: String(payload.family || inferModelFamily(baseModel)).trim(),
    baseModel,
    providerSource,
    localReadiness: !localVisible ? 'not-local' : (localReady ? 'ready' : 'not-ready'),
    localReady,
    installState,
    importState: installState,
    tuningStatus: String(tuningTrust?.status || '').trim().toLowerCase(),
    tuningSummary: String(tuningTrust?.summary || '').trim(),
    foundryCandidate: findFoundryCandidateLink({
      wrappedProfileId,
      baseModel,
      providerSource,
    }, foundryStatus),
    benchmarkIdentity: findBenchmarkIdentity({
      wrappedProfileId,
      baseModel,
      providerSource,
    }, benchmarkSummary),
    fileName: String(selectorMatch.discovered?.fileName || '').trim(),
    source: String(selectorMatch.option?.source || selectorMatch.discovered?.source || selectorMatch.registered?.source || '').trim(),
  };
}

function summarizeLocalModelInventory(entries = [], tuningTrust = {}) {
  const items = toArray(entries);
  const localEntries = items.filter((item) => item.localReadiness !== 'not-local');
  const readyCount = localEntries.filter((item) => item.localReady).length;
  const importNeededCount = localEntries.filter((item) => item.installState === 'import-needed').length;
  const candidateCount = items.filter((item) => item.kind === 'foundry-candidate').length;
  let status = 'ready';
  if (localEntries.length === 0) {
    status = 'idle';
  } else if (readyCount === 0 || importNeededCount > 0) {
    status = 'warn';
  }
  const parts = [];
  if (localEntries.length > 0) {
    parts.push(`${readyCount}/${localEntries.length} local inventory entr${localEntries.length === 1 ? 'y is' : 'ies are'} ready`);
  } else {
    parts.push('No local inventory entries are connected yet');
  }
  if (candidateCount > 0) {
    parts.push(`${candidateCount} foundry candidate link${candidateCount === 1 ? '' : 's'}`);
  }
  if (tuningTrust?.status) {
    parts.push(`tuning ${String(tuningTrust.status).trim().toLowerCase()}`);
  }
  return {
    status,
    readyCount,
    localCount: localEntries.length,
    candidateCount,
    summary: parts.join(' | '),
  };
}

function buildLocalModelInventory(options = {}) {
  const settings = normalizeTrainingTuningSettings(options.settings || {});
  const telemetry = options.telemetry && typeof options.telemetry === 'object' ? options.telemetry : {};
  const wrappedProfiles = toArray(options.wrappedProfiles).filter((item) => item && typeof item === 'object');
  const foundryStatus = options.foundryStatus && typeof options.foundryStatus === 'object' ? options.foundryStatus : {};
  const benchmarkSummary = toArray(options.benchmarkSummary);
  const selector = resolveSelectorSnapshot(settings, telemetry);
  const tuningTrust = telemetry?.trustSummary && typeof telemetry.trustSummary === 'object' ? telemetry.trustSummary : {};

  const wrappedEntries = wrappedProfiles
    .filter((profile) => isLocalProviderSource(profile?.providerSource || profile?.baseProvider))
    .map((profile) => buildLocalInventoryEntry('wrapped-profile', profile, selector, benchmarkSummary, foundryStatus, tuningTrust));

  const candidateEntries = toArray(foundryStatus?.candidates)
    .filter((candidate) => {
      const providerSource = normalizeProviderSource(candidate?.providerSource);
      const baseModel = String(candidate?.baseModel || toArray(candidate?.recommendedModels)[0] || '').trim();
      if (isLocalProviderSource(providerSource)) {
        return true;
      }
      const selectorMatch = findSelectorMatch(selector, baseModel);
      return !!selectorMatch.option || !!selectorMatch.discovered;
    })
    .map((candidate) => buildLocalInventoryEntry('foundry-candidate', {
      ...candidate,
      label: String(candidate?.title || candidate?.id || 'Foundry candidate').trim(),
      baseModel: String(candidate?.baseModel || toArray(candidate?.recommendedModels)[0] || '').trim(),
    }, selector, benchmarkSummary, foundryStatus, tuningTrust));

  const entries = [...wrappedEntries, ...candidateEntries];
  const summary = summarizeLocalModelInventory(entries, tuningTrust);
  return {
    status: summary.status,
    summary: summary.summary,
    readyCount: summary.readyCount,
    localCount: summary.localCount,
    candidateCount: summary.candidateCount,
    tuningStatus: String(tuningTrust?.status || '').trim().toLowerCase(),
    tuningSummary: String(tuningTrust?.summary || '').trim(),
    storageRoot: String(selector.storageRoot || settings.trainingModelStorageRoot || '').trim(),
    registeredRoot: String(selector.configuredOllamaRoot || '').trim(),
    entries,
  };
}

function readThermalPressure() {
  try {
    const output = childProcess.execFileSync('pmset', ['-g', 'therm'], {
      encoding: 'utf8',
      timeout: 1200,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const text = String(output || '').trim();
    const normalized = text.toLowerCase();
    let state = 'nominal';
    if (normalized.includes('heavy')) {
      state = 'heavy';
    } else if (normalized.includes('trapping') || normalized.includes('cpu_speed_limit')) {
      state = 'limited';
    } else if (normalized.includes('no supported thermal') || !text) {
      state = 'unknown';
    }
    return { ok: true, state, detail: text.split(/\r?\n/)[0] || 'Thermal pressure nominal.' };
  } catch (_err) {
    return { ok: false, state: 'unknown', detail: 'Thermal pressure unavailable.' };
  }
}

async function collectTrainingTelemetry(options = {}) {
  const settings = normalizeTrainingTuningSettings(options.settings || {});
  const effective = settings.effective || resolveEffectiveTuning(settings);
  const adaptive = buildAdaptiveTrainingProfiles(settings);
  const cpuCount = Math.max(1, Number(os.cpus()?.length || 1));
  const loadAverage = os.loadavg();
  const memoryTotal = os.totalmem();
  const memoryFree = os.freemem();
  const memoryUsed = Math.max(0, memoryTotal - memoryFree);
  const cpuUsagePercent = Math.min(100, Math.round(((Number(loadAverage[0] || 0) / cpuCount) * 100)));
  const thermal = readThermalPressure();
  const ollama = await requestJson('http://127.0.0.1:11434/api/tags', 900);
  const models = Array.isArray(ollama.json?.models) ? ollama.json.models : [];
  const selector = buildTrainingModelSelectorOptions(settings, models.map((item) => String(item?.name || item?.model || '')).filter(Boolean));
  const configuredOllamaModels = Array.isArray(selector.registered)
    ? selector.registered.map((item) => String(item?.value || '').trim()).filter(Boolean)
    : [];
  const selectedModel = String(settings.trainingOllamaModel || '').trim();
  const selectedModelOption = selector.options.find((item) => String(item?.value || '').trim() === selectedModel) || null;
  const selectedModelReady = selectedModel ? !!selectedModelOption?.ready : false;
  const selectedModelSource = String(selectedModelOption?.source || '').trim() || (selectedModelReady ? 'ollama' : 'unknown');
  const sampledAt = new Date().toISOString();
  const runtimeSnapshot = {
    activeRuns: Math.max(0, Number(options.activeRuns || 0)),
    schedulerRunning: !!options.schedulerRunning,
    currentProfile: settings.trainingProfile,
    ecoMode: effective.trainingEcoMode,
    threadLimit: effective.threadLimit,
    cpuLimitPercent: effective.cpuLimitPercent,
    thermalCeilingC: effective.thermalCeilingC,
    launchSurface: settings.trainingLaunchSurface,
  };
  const ollamaSnapshot = {
    running: !!ollama.ok,
    reachable: !!ollama.ok,
    modelCount: models.length,
    models: models.slice(0, 8).map((item) => String(item?.name || item?.model || '')).filter(Boolean),
    configuredModelCount: configuredOllamaModels.length,
    configuredModels: configuredOllamaModels.slice(0, 16),
    selectedModel,
    selectedModelReady,
    selectedModelSource,
    storageRoot: settings.trainingModelStorageRoot,
  };
  const modelsSnapshot = {
    storageRoot: selector.storageRoot || settings.trainingModelStorageRoot,
    storageReachable: !!selector.storageReachable,
    registeredRoot: selector.configuredOllamaRoot || '',
    registeredReachable: !!selector.configuredOllamaReachable,
    catalog: RECOMMENDED_LOCAL_MODELS,
    registered: selector.registered || [],
    discovered: selector.discovered,
    availableOptions: selector.options,
  };
  const trustSummary = buildTrainingTrustSummary({
    settings,
    lastUpdatedAt: sampledAt,
    cpuUsagePercent,
    memory: {
      total: memoryTotal,
      free: memoryFree,
      used: memoryUsed,
      usedPercent: memoryTotal > 0 ? Math.round((memoryUsed / memoryTotal) * 100) : 0,
    },
    thermal,
    runtime: runtimeSnapshot,
    ollama: ollamaSnapshot,
    models: modelsSnapshot,
  }, settings);
  return {
    sampledAt,
    lastUpdatedAt: sampledAt,
    cpuCount,
    cpuUsagePercent,
    loadAverage,
    memory: {
      total: memoryTotal,
      free: memoryFree,
      used: memoryUsed,
      usedPercent: memoryTotal > 0 ? Math.round((memoryUsed / memoryTotal) * 100) : 0,
    },
    thermal,
    ollama: {
      ...ollamaSnapshot,
    },
    runtime: runtimeSnapshot,
    machine: adaptive.machine,
    adaptiveProfiles: adaptive.profiles,
    models: modelsSnapshot,
    trustSummary,
  };
}

module.exports = {
  DEFAULT_MODEL_STORAGE_ROOT,
  PROFILE_PRESETS,
  RECOMMENDED_LOCAL_MODELS,
  HARDWARE_TARGET_PRESETS,
  TRAINING_TUNING_KEY_MAP,
  DEFAULT_TUNING_SETTINGS,
  TRAINING_TELEMETRY_STALE_MS,
  TRAINING_TRUST_REASON_CODES,
  normalizeTrainingTuningSettings,
  normalizeHardwareTarget,
  getHardwareTargetPreset,
  readTrainingTuningSettings,
  writeTrainingTuningSettings,
  resolveThermalCeilingC,
  buildTrainingRunPayload,
  buildLearnRunPayload,
  buildSelfImproveRunPayload,
  buildTerminalTrainingCommand,
  buildModelDownloadCommand,
  buildModelInstallPresets,
  buildTrainingModelSelectorOptions,
  discoverStoredModels,
  discoverConfiguredOllamaModels,
  buildImportTagFromFileName,
  resolveExistingModelStorageRoot,
  resolveOllamaHomeRoot,
  resolveOllamaModelsRoot,
  detectMachineProfile,
  buildAdaptiveTrainingProfiles,
  resolveAdaptiveTrainingProfile,
  buildTrainingTrustSummary,
  buildLocalModelInventory,
  collectTrainingTelemetry,
};
