'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');

function parseConfigScalar(raw) {
  const text = String(raw || '').split('#')[0].trim();
  if (!text) {
    return '';
  }
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
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

function readConfigEntries(workspaceRoot) {
  const entries = {};
  for (const root of listConfigRoots(workspaceRoot)) {
    for (const fileName of ['dev_assistant.yaml', 'dev_assistant.local.yaml']) {
      const configPath = path.join(root, fileName);
      if (!fs.existsSync(configPath)) {
        continue;
      }
      try {
        const lines = fs.readFileSync(configPath, 'utf8').split(/\r?\n/);
        for (const rawLine of lines) {
          const line = String(rawLine || '').split('#')[0];
          const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
          if (!match) {
            continue;
          }
          const key = match[1];
          const value = parseConfigScalar(match[2]);
          if (value) {
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

function readConfigMap(workspaceRoot) {
  const entries = readConfigEntries(workspaceRoot);
  return Object.fromEntries(
    Object.entries(entries).map(([key, entry]) => [key, entry.value]),
  );
}

function resolveConfiguredPath(entry, fallbackPath) {
  const configuredPath = String(entry?.value || '').trim();
  if (!configuredPath) {
    return fallbackPath;
  }
  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }
  const baseRoot = normalizeConfigRoot(entry?.root);
  return baseRoot ? path.join(baseRoot, configuredPath) : configuredPath;
}

function resolvePath(workspaceRoot, configuredPath, fallbackPath) {
  if (!configuredPath) {
    return fallbackPath;
  }
  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }
  return path.join(workspaceRoot, configuredPath);
}

function buildWorkspaceScopedSuffix(workspaceRoot) {
  const normalizedWorkspaceRoot = normalizeConfigRoot(workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    return '';
  }
  const baseName = path.basename(normalizedWorkspaceRoot) || 'workspace';
  const hash = crypto.createHash('sha1').update(normalizedWorkspaceRoot).digest('hex').slice(0, 10);
  return `${baseName}-${hash}`;
}

function namespaceConfiguredDir(configuredDir, workspaceRoot, entry = null) {
  const normalizedConfiguredDir = normalizeConfigRoot(configuredDir);
  const normalizedWorkspaceRoot = normalizeConfigRoot(workspaceRoot);
  const entryRoot = normalizeConfigRoot(entry?.root);
  if (!normalizedConfiguredDir || !normalizedWorkspaceRoot || normalizedWorkspaceRoot === APP_ROOT) {
    return normalizedConfiguredDir;
  }
  if (entryRoot && entryRoot === normalizedWorkspaceRoot) {
    return normalizedConfiguredDir;
  }
  return path.join(normalizedConfiguredDir, 'workspaces', buildWorkspaceScopedSuffix(normalizedWorkspaceRoot));
}

function shouldPreferWorkspaceLocalAssistantRuns(workspaceRoot) {
  const normalizedWorkspaceRoot = normalizeConfigRoot(workspaceRoot);
  return !!normalizedWorkspaceRoot && normalizedWorkspaceRoot !== APP_ROOT;
}

function getAssistantArtifactsRoot(workspaceRoot) {
  const entries = readConfigEntries(workspaceRoot);
  return namespaceConfiguredDir(resolveConfiguredPath(entries.assistant_artifacts_root, ''), workspaceRoot, entries.assistant_artifacts_root);
}

function getAssistantRunsDir(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  const entries = readConfigEntries(workspaceRoot);
  const normalizedWorkspaceRoot = normalizeConfigRoot(workspaceRoot);
  const localRunsDir = normalizedWorkspaceRoot ? path.join(normalizedWorkspaceRoot, 'docs', 'assistant_runs') : '';
  const preferWorkspaceLocalRuns = shouldPreferWorkspaceLocalAssistantRuns(normalizedWorkspaceRoot);
  if (config.assistant_runs_dir) {
    const configuredRunsDir = namespaceConfiguredDir(
      resolveConfiguredPath(
        entries.assistant_runs_dir,
        localRunsDir,
      ),
      normalizedWorkspaceRoot,
      entries.assistant_runs_dir,
    );
    if (entries.assistant_runs_dir && normalizeConfigRoot(entries.assistant_runs_dir.root) === normalizedWorkspaceRoot) {
      return configuredRunsDir;
    }
    if (preferWorkspaceLocalRuns && localRunsDir && fs.existsSync(localRunsDir)) {
      return localRunsDir;
    }
    return configuredRunsDir;
  }
  const root = getAssistantArtifactsRoot(workspaceRoot);
  if (root) {
    const configuredRunsDir = path.join(root, 'assistant_runs');
    if (preferWorkspaceLocalRuns && localRunsDir && fs.existsSync(localRunsDir)) {
      return localRunsDir;
    }
    return configuredRunsDir;
  }
  return localRunsDir;
}

function getAssistantSchedulerLogPath(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  const entries = readConfigEntries(workspaceRoot);
  if (config.assistant_scheduler_log_path) {
    return resolveConfiguredPath(entries.assistant_scheduler_log_path, path.join(getAssistantRunsDir(workspaceRoot), 'autopilot_scheduler.log'));
  }
  return path.join(getAssistantRunsDir(workspaceRoot), 'autopilot_scheduler.log');
}

function getAssistantRuntimeStatePath(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  const entries = readConfigEntries(workspaceRoot);
  const runsDir = getAssistantRunsDir(workspaceRoot);
  const preferWorkspaceLocalRuns = shouldPreferWorkspaceLocalAssistantRuns(workspaceRoot);
  const localRuntimeStatePath = normalizeConfigRoot(workspaceRoot)
    ? path.join(normalizeConfigRoot(workspaceRoot), 'docs', 'assistant_runs', 'runtime_state.json')
    : '';
  if (config.assistant_runtime_state_path) {
    const configuredPath = resolveConfiguredPath(entries.assistant_runtime_state_path, path.join(runsDir, 'runtime_state.json'));
    if (entries.assistant_runtime_state_path && normalizeConfigRoot(entries.assistant_runtime_state_path.root) === normalizeConfigRoot(workspaceRoot)) {
      return configuredPath;
    }
    if (preferWorkspaceLocalRuns && localRuntimeStatePath && fs.existsSync(localRuntimeStatePath)) {
      return localRuntimeStatePath;
    }
    return configuredPath;
  }
  if (preferWorkspaceLocalRuns && localRuntimeStatePath && fs.existsSync(localRuntimeStatePath)) {
    return localRuntimeStatePath;
  }
  return path.join(runsDir, 'runtime_state.json');
}

function getConfiguredAssistantDesktopBuildDir(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  const entries = readConfigEntries(workspaceRoot);
  if (config.assistant_desktop_build_dir) {
    return resolveConfiguredPath(entries.assistant_desktop_build_dir, '');
  }
  const root = getAssistantArtifactsRoot(workspaceRoot);
  return root ? path.join(root, 'desktop_builds') : '';
}

function getConfiguredAssistantDesktopReleaseDir(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  const entries = readConfigEntries(workspaceRoot);
  if (config.assistant_desktop_release_dir) {
    return resolveConfiguredPath(entries.assistant_desktop_release_dir, '');
  }
  const coldRoot = getConfiguredAssistantColdStorageRoot(workspaceRoot);
  if (coldRoot) {
    return path.join(coldRoot, 'desktop_releases');
  }
  const root = getAssistantArtifactsRoot(workspaceRoot);
  return root ? path.join(root, 'desktop_releases') : '';
}

function getConfiguredAssistantDesktopLiveChannelDir(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  const entries = readConfigEntries(workspaceRoot);
  if (config.assistant_desktop_live_channel_dir) {
    return resolveConfiguredPath(entries.assistant_desktop_live_channel_dir, '');
  }
  const root = getAssistantArtifactsRoot(workspaceRoot);
  return root ? path.join(root, 'desktop_update_channel', 'live') : '';
}

function getConfiguredAssistantLabsRoot(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  const entries = readConfigEntries(workspaceRoot);
  if (config.assistant_labs_root) {
    return resolveConfiguredPath(entries.assistant_labs_root, '');
  }
  const root = getAssistantArtifactsRoot(workspaceRoot);
  return root ? path.join(root, 'assistant_labs') : '';
}

function getConfiguredAssistantLearningJournalRoot(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  const entries = readConfigEntries(workspaceRoot);
  if (config.assistant_learning_journal_root) {
    return resolveConfiguredPath(entries.assistant_learning_journal_root, '');
  }
  const root = getAssistantArtifactsRoot(workspaceRoot);
  return root ? path.join(root, 'learning_journal') : '';
}

function getConfiguredAssistantBenchmarkRoot(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  const entries = readConfigEntries(workspaceRoot);
  if (config.assistant_benchmark_root) {
    return resolveConfiguredPath(entries.assistant_benchmark_root, '');
  }
  const root = getAssistantArtifactsRoot(workspaceRoot);
  return root ? path.join(root, 'assistant_benchmarks') : '';
}

function getConfiguredAssistantColdStorageRoot(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  const entries = readConfigEntries(workspaceRoot);
  if (config.assistant_cold_storage_root) {
    return namespaceConfiguredDir(resolveConfiguredPath(entries.assistant_cold_storage_root, ''), workspaceRoot, entries.assistant_cold_storage_root);
  }
  return '';
}

function getConfiguredAssistantPromotionsRoot(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  const entries = readConfigEntries(workspaceRoot);
  if (config.assistant_promotions_root) {
    return namespaceConfiguredDir(resolveConfiguredPath(entries.assistant_promotions_root, ''), workspaceRoot, entries.assistant_promotions_root);
  }
  const coldRoot = getConfiguredAssistantColdStorageRoot(workspaceRoot);
  if (coldRoot) {
    return path.join(coldRoot, 'assistant_promotions');
  }
  const root = getAssistantArtifactsRoot(workspaceRoot);
  return root ? path.join(root, 'assistant_promotions') : '';
}

function getConfiguredAssistantModelFoundryRoot(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  const entries = readConfigEntries(workspaceRoot);
  if (config.assistant_model_foundry_root) {
    return resolveConfiguredPath(entries.assistant_model_foundry_root, '');
  }
  const root = getAssistantArtifactsRoot(workspaceRoot);
  return root ? path.join(root, 'model_foundry') : '';
}

function getConfiguredAssistantDevDataRoot(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  const entries = readConfigEntries(workspaceRoot);
  if (config.assistant_dev_data_dir) {
    return resolveConfiguredPath(entries.assistant_dev_data_dir, '');
  }
  const root = getAssistantArtifactsRoot(workspaceRoot);
  return root ? path.join(root, 'dev_data') : '';
}

function getConfiguredAssistantLocalTrainingExportsRoot(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  const entries = readConfigEntries(workspaceRoot);
  if (config.assistant_local_training_exports_root) {
    return resolveConfiguredPath(entries.assistant_local_training_exports_root, '');
  }
  const root = getConfiguredAssistantDevDataRoot(workspaceRoot);
  return root ? path.join(root, 'local_training_exports') : '';
}

function getConfiguredAssistantCheckpointMergesRoot(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  const entries = readConfigEntries(workspaceRoot);
  if (config.assistant_checkpoint_merges_root) {
    return resolveConfiguredPath(entries.assistant_checkpoint_merges_root, '');
  }
  const root = getConfiguredAssistantModelFoundryRoot(workspaceRoot) || getConfiguredAssistantDevDataRoot(workspaceRoot);
  return root ? path.join(root, 'checkpoint_merges') : '';
}

function getConfiguredAssistantChatAttachmentsRoot(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  const entries = readConfigEntries(workspaceRoot);
  if (config.assistant_chat_attachments_root) {
    return resolveConfiguredPath(entries.assistant_chat_attachments_root, '');
  }
  const root = getAssistantArtifactsRoot(workspaceRoot);
  return root ? path.join(root, 'chat_attachments') : '';
}

module.exports = {
  getAssistantArtifactsRoot,
  getConfiguredAssistantBenchmarkRoot,
  getConfiguredAssistantChatAttachmentsRoot,
  getConfiguredAssistantColdStorageRoot,
  getConfiguredAssistantDesktopBuildDir,
  getConfiguredAssistantDesktopLiveChannelDir,
  getConfiguredAssistantDesktopReleaseDir,
  getConfiguredAssistantDevDataRoot,
  getConfiguredAssistantLabsRoot,
  getConfiguredAssistantLearningJournalRoot,
  getConfiguredAssistantLocalTrainingExportsRoot,
  getConfiguredAssistantModelFoundryRoot,
  getConfiguredAssistantCheckpointMergesRoot,
  getConfiguredAssistantPromotionsRoot,
  getAssistantRunsDir,
  getAssistantRuntimeStatePath,
  getAssistantSchedulerLogPath,
  readConfigMap,
};
