'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const {
  getAssistantArtifactsRoot,
  getAssistantRunsDir,
  getConfiguredAssistantDesktopBuildDir,
  readConfigMap,
} = require('./assistant-paths');
const { APP_ROOT } = require('./app-roots');

const GIB = 1024 ** 3;
const CACHE_TTL_MS = 15000;
const snapshotCache = new Map();

const BUILD_ARTIFACT_FILE_SUFFIXES = ['.dmg', '.zip', '.blockmap'];
const BUILD_ARTIFACT_FILE_NAMES = new Set(['builder-effective-config.yaml', 'builder-debug.yml']);
const BUILD_ARTIFACT_DIR_PREFIXES = ['mac', 'win', 'linux'];

function resolveConfiguredPath(workspaceRoot, configuredPath, fallbackPath = '') {
  if (!configuredPath) {
    return fallbackPath;
  }
  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }
  return path.join(workspaceRoot, configuredPath);
}

function getConfiguredStoragePath(workspaceRoot, key, fallbackPath = '') {
  const config = readConfigMap(workspaceRoot);
  return resolveConfiguredPath(workspaceRoot, config[key], fallbackPath);
}

function detectVolumeKey(targetPath) {
  const resolved = String(targetPath || path.sep).trim().replace(/\\/g, '/');
  const match = resolved.match(/^\/Volumes\/([^/]+)/);
  if (match) {
    return `/Volumes/${match[1]}`;
  }
  const driveMatch = resolved.match(/^[A-Za-z]:/);
  if (driveMatch) {
    return `${driveMatch[0]}/`;
  }
  return '/';
}

function detectVolumeLabel(targetPath) {
  const resolved = String(targetPath || path.sep).trim().replace(/\\/g, '/');
  const match = resolved.match(/^\/Volumes\/([^/]+)/);
  if (match) {
    return match[1];
  }
  return 'Mac Disk';
}

function findExistingProbePath(targetPath) {
  let probe = path.resolve(String(targetPath || path.sep));
  while (probe && !fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) {
      return '';
    }
    probe = parent;
  }
  return probe;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const precision = size >= 100 || index === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(precision)} ${units[index]}`;
}

function directorySizeFallback(targetPath) {
  try {
    const stat = fs.lstatSync(targetPath);
    if (!stat.isDirectory()) {
      return stat.size;
    }
    let total = 0;
    for (const entry of fs.readdirSync(targetPath)) {
      total += directorySizeFallback(path.join(targetPath, entry));
    }
    return total;
  } catch (_err) {
    return 0;
  }
}

function measurePathBytes(targetPath) {
  const resolved = String(targetPath || '').trim();
  if (!resolved || !fs.existsSync(resolved)) {
    return 0;
  }
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory()) {
      return stat.size;
    }
  } catch (_err) {
    return 0;
  }
  try {
    const output = childProcess.execFileSync('du', ['-sk', resolved], { encoding: 'utf8' });
    const kilobytes = Number.parseInt(String(output || '').trim().split(/\s+/)[0] || '0', 10);
    if (Number.isFinite(kilobytes) && kilobytes >= 0) {
      return kilobytes * 1024;
    }
  } catch (_err) {
    // fall back to recursive walk
  }
  return directorySizeFallback(resolved);
}

function evaluateVolumeState(totalBytes, freeBytes) {
  const total = Number(totalBytes || 0);
  const free = Number(freeBytes || 0);
  if (total <= 0) {
    return 'idle';
  }
  const freeRatio = free / total;
  if (free <= 5 * GIB || freeRatio <= 0.05) {
    return 'fail';
  }
  if (free <= 20 * GIB || freeRatio <= 0.15) {
    return 'warn';
  }
  return 'ready';
}

function readVolumeStats(targetPath, id, label) {
  const probePath = findExistingProbePath(targetPath);
  const volumeKey = detectVolumeKey(targetPath || probePath || path.sep);
  const volumeLabel = label || detectVolumeLabel(targetPath || probePath || path.sep);
  if (!probePath) {
    return {
      id,
      label: volumeLabel,
      path: String(targetPath || ''),
      probePath: '',
      volumeKey,
      exists: false,
      totalBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      usedPercent: 0,
      freePercent: 0,
      state: 'idle',
      totalText: '0 B',
      usedText: '0 B',
      freeText: '0 B',
      summary: 'Path unavailable',
    };
  }
  try {
    const stat = fs.statfsSync(probePath);
    const blockSize = Number(stat.bsize || stat.frsize || 0);
    const totalBytes = Number(stat.blocks || 0) * blockSize;
    const freeBlocks = Number(stat.bavail || stat.bfree || 0);
    const freeBytes = freeBlocks * blockSize;
    const usedBytes = Math.max(totalBytes - freeBytes, 0);
    const usedPercent = totalBytes > 0 ? Math.min(100, Math.max(0, (usedBytes / totalBytes) * 100)) : 0;
    const freePercent = totalBytes > 0 ? Math.min(100, Math.max(0, (freeBytes / totalBytes) * 100)) : 0;
    const state = evaluateVolumeState(totalBytes, freeBytes);
    return {
      id,
      label: volumeLabel,
      path: String(targetPath || ''),
      probePath,
      volumeKey,
      exists: true,
      totalBytes,
      usedBytes,
      freeBytes,
      usedPercent,
      freePercent,
      state,
      totalText: formatBytes(totalBytes),
      usedText: formatBytes(usedBytes),
      freeText: formatBytes(freeBytes),
      summary: `${formatBytes(freeBytes)} free of ${formatBytes(totalBytes)}`,
    };
  } catch (_err) {
    return {
      id,
      label: volumeLabel,
      path: String(targetPath || ''),
      probePath,
      volumeKey,
      exists: true,
      totalBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      usedPercent: 0,
      freePercent: 0,
      state: 'idle',
      totalText: '0 B',
      usedText: '0 B',
      freeText: '0 B',
      summary: 'Volume stats unavailable',
    };
  }
}

function buildTrackedItems(workspaceRoot) {
  const artifactsRoot = getAssistantArtifactsRoot(workspaceRoot);
  const runsDir = getAssistantRunsDir(workspaceRoot);
  const desktopBuildDir = getConfiguredAssistantDesktopBuildDir(workspaceRoot)
    || path.join(APP_ROOT, 'dist');

  const items = [
    { id: 'assistant-runs', label: 'Assistant Runs', path: runsDir },
    {
      id: 'dev-data',
      label: 'Dev Data',
      path: getConfiguredStoragePath(
        workspaceRoot,
        'assistant_dev_data_dir',
        artifactsRoot ? path.join(artifactsRoot, 'dev_data') : path.join(workspaceRoot, 'dev_data'),
      ),
    },
    { id: 'desktop-builds', label: 'Desktop Builds', path: desktopBuildDir },
    {
      id: 'sandboxes',
      label: 'Sandboxes',
      path: getConfiguredStoragePath(
        workspaceRoot,
        'assistant_sandbox_dir',
        artifactsRoot ? path.join(artifactsRoot, 'assistant_sandboxes') : path.join(workspaceRoot, 'assistant_sandboxes'),
      ),
    },
    {
      id: 'test-artifacts',
      label: 'Test Artifacts',
      path: getConfiguredStoragePath(
        workspaceRoot,
        'assistant_test_artifacts_dir',
        artifactsRoot ? path.join(artifactsRoot, 'test_artifacts') : path.join(workspaceRoot, 'test_artifacts'),
      ),
    },
    {
      id: 'tmp',
      label: 'Tmp Cache',
      path: getConfiguredStoragePath(
        workspaceRoot,
        'assistant_tmp_dir',
        artifactsRoot ? path.join(artifactsRoot, 'tmp') : path.join(workspaceRoot, 'tmp'),
      ),
    },
  ];

  const unique = new Set();
  return items.filter((item) => {
    const resolved = String(item.path || '').trim();
    if (!resolved || unique.has(resolved)) {
      return false;
    }
    unique.add(resolved);
    return true;
  });
}

function buildStorageSnapshot(workspaceRoot, options = {}) {
  const root = String(workspaceRoot || '').trim();
  const now = Number(options.now || Date.now());
  const force = !!options.force;
  if (!root) {
    return {
      state: 'idle',
      summaryText: 'No workspace selected',
      trackedTotalBytes: 0,
      trackedTotalText: '0 B',
      generatedAt: new Date(now).toISOString(),
      volumes: [],
      items: [],
      offloadConfigured: false,
    };
  }

  const cached = snapshotCache.get(root);
  if (!force && cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.payload;
  }

  const artifactsRoot = getAssistantArtifactsRoot(root);
  const offloadRoot = artifactsRoot || getAssistantRunsDir(root);
  const workspaceVolume = readVolumeStats(root, 'workspace-volume', 'Workspace Disk');
  const offloadVolume = readVolumeStats(offloadRoot, 'offload-volume', artifactsRoot ? 'Offload Disk' : 'Artifact Disk');
  const sameVolume = workspaceVolume.volumeKey === offloadVolume.volumeKey;
  const trackedItems = buildTrackedItems(root)
    .map((item) => {
      const exists = fs.existsSync(item.path);
      const bytes = exists ? measurePathBytes(item.path) : 0;
      return {
        ...item,
        exists,
        bytes,
        bytesText: formatBytes(bytes),
        volumeId: sameVolume || detectVolumeKey(item.path) === workspaceVolume.volumeKey ? 'workspace-volume' : 'offload-volume',
      };
    })
    .sort((left, right) => right.bytes - left.bytes);

  const trackedTotalBytes = trackedItems.reduce((total, item) => total + Number(item.bytes || 0), 0);
  const largestBytes = trackedItems.reduce((largest, item) => Math.max(largest, Number(item.bytes || 0)), 0);
  const items = trackedItems.map((item) => ({
    ...item,
    sharePercent: trackedTotalBytes > 0 ? (item.bytes / trackedTotalBytes) * 100 : 0,
    meterPercent: largestBytes > 0 ? (item.bytes / largestBytes) * 100 : 0,
    state: item.exists ? 'ready' : 'idle',
    summary: item.exists ? `${item.bytesText} tracked` : 'Not present',
  }));

  const volumes = sameVolume
    ? [{ ...workspaceVolume, label: artifactsRoot ? 'Workspace + Offload Disk' : workspaceVolume.label }]
    : [workspaceVolume, offloadVolume];
  const state = volumes.some((item) => item.state === 'fail')
    ? 'fail'
    : volumes.some((item) => item.state === 'warn')
      ? 'warn'
      : 'ready';
  const primaryVolume = sameVolume
    ? volumes[0]
    : (!sameVolume && artifactsRoot ? offloadVolume : workspaceVolume);
  const largestItem = items[0] || null;
  const summaryParts = [
    `${formatBytes(trackedTotalBytes)} tracked`,
    `${primaryVolume.freeText} free on ${primaryVolume.label}`,
  ];
  if (largestItem && largestItem.bytes > 0) {
    summaryParts.push(`largest ${largestItem.label.toLowerCase()} ${largestItem.bytesText}`);
  }

  const cleanupHints = [];
  const desktopBuilds = items.find((item) => item.id === 'desktop-builds') || null;
  const assistantRuns = items.find((item) => item.id === 'assistant-runs') || null;
  const buildCleanupThreshold = 500 * 1024 * 1024;
  if (desktopBuilds && Number(desktopBuilds.bytes || 0) >= buildCleanupThreshold) {
    cleanupHints.push(`Desktop builds are using ${desktopBuilds.bytesText}; consider cleanup or pruning old packaged outputs.`);
  }
  if (assistantRuns && Number(assistantRuns.bytes || 0) >= 2 * GIB) {
    cleanupHints.push(`Assistant runs are using ${assistantRuns.bytesText}; consider archiving old run artifacts.`);
  }
  if (cleanupHints.length) {
    summaryParts.push('consider cleanup');
  }

  const payload = {
    state,
    summaryText: summaryParts.join(' • '),
    trackedTotalBytes,
    trackedTotalText: formatBytes(trackedTotalBytes),
    generatedAt: new Date(now).toISOString(),
    offloadConfigured: !!artifactsRoot,
    workspaceVolume,
    offloadVolume,
    sameVolume,
    volumes,
    items,
    cleanupHints,
  };

  snapshotCache.set(root, { timestamp: now, payload });
  return payload;
}

function clearStorageSnapshotCache() {
  snapshotCache.clear();
}

function safeRemoveEntry(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return 0;
  }
  const bytes = measurePathBytes(targetPath);
  fs.rmSync(targetPath, { recursive: true, force: true });
  return bytes;
}

function collectDesktopBuildCleanupTargets(workspaceRoot) {
  const buildDir = getConfiguredAssistantDesktopBuildDir(workspaceRoot)
    || path.join(APP_ROOT, 'dist');
  if (!buildDir || !fs.existsSync(buildDir)) {
    return [];
  }
  const targets = [];
  for (const name of fs.readdirSync(buildDir)) {
    const fullPath = path.join(buildDir, name);
    const lower = name.toLowerCase();
    const stat = fs.lstatSync(fullPath);
    if (stat.isDirectory() && BUILD_ARTIFACT_DIR_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}-`))) {
      targets.push({
        scope: 'desktop-builds',
        label: `build folder ${name}`,
        path: fullPath,
        kind: 'directory',
      });
      continue;
    }
    if (stat.isFile() && (BUILD_ARTIFACT_FILE_NAMES.has(lower) || BUILD_ARTIFACT_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix)))) {
      targets.push({
        scope: 'desktop-builds',
        label: `build artifact ${name}`,
        path: fullPath,
        kind: 'file',
      });
    }
  }
  return targets;
}

function collectTransientCleanupTargets(workspaceRoot) {
  const items = buildTrackedItems(workspaceRoot)
    .filter((item) => ['sandboxes', 'test-artifacts', 'tmp'].includes(String(item.id || '')))
    .filter((item) => item.path && fs.existsSync(item.path));
  return items.map((item) => ({
    scope: 'transient-artifacts',
    label: item.label,
    path: item.path,
    kind: 'directory',
  }));
}

function cleanupStorageArtifacts(workspaceRoot, options = {}) {
  const root = String(workspaceRoot || '').trim();
  const scope = String(options.scope || 'desktop-builds').trim().toLowerCase();
  if (!root) {
    return { ok: false, message: 'No workspace selected.', removed: [], removedBytes: 0, removedText: '0 B' };
  }

  const targets = [];
  if (scope === 'desktop-builds' || scope === 'all') {
    targets.push(...collectDesktopBuildCleanupTargets(root));
  }
  if (scope === 'transient-artifacts' || scope === 'all') {
    targets.push(...collectTransientCleanupTargets(root));
  }

  const removed = [];
  let removedBytes = 0;
  for (const target of targets) {
    const bytes = safeRemoveEntry(target.path);
    if (bytes <= 0 && fs.existsSync(target.path)) {
      continue;
    }
    removedBytes += bytes;
    removed.push({
      ...target,
      bytes,
      bytesText: formatBytes(bytes),
    });
  }

  clearStorageSnapshotCache();
  const label = scope === 'transient-artifacts'
    ? 'transient artifacts'
    : scope === 'all'
      ? 'builds/downloads and transient artifacts'
      : 'builds/downloads';
  return {
    ok: true,
    scope,
    removed,
    removedBytes,
    removedText: formatBytes(removedBytes),
    message: removed.length
      ? `Removed ${removed.length} ${label} item(s) and freed ${formatBytes(removedBytes)}.`
      : `No ${label} cleanup items were found.`,
  };
}

module.exports = {
  buildStorageSnapshot,
  cleanupStorageArtifacts,
  clearStorageSnapshotCache,
  detectVolumeKey,
  formatBytes,
};
