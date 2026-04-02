'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');

const {
  getConfiguredAssistantDesktopBuildDir,
  getConfiguredAssistantDesktopLiveChannelDir,
  getConfiguredAssistantDesktopReleaseDir,
  readConfigMap,
} = require('./assistant-paths');

const RELEASE_SUFFIXES = ['.dmg', '.zip', '.exe', '.appimage', '.blockmap'];
const VERSION_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

function compareReleaseVersions(left, right) {
  const normalizedLeft = String(left || '').trim();
  const normalizedRight = String(right || '').trim();
  if (normalizedLeft && normalizedRight) {
    return VERSION_COLLATOR.compare(normalizedLeft, normalizedRight);
  }
  if (normalizedLeft) {
    return 1;
  }
  if (normalizedRight) {
    return -1;
  }
  return 0;
}

function normalizeReleasePlatform(platform) {
  const normalized = String(platform || '').trim().toLowerCase();
  if (['win32', 'darwin', 'linux'].includes(normalized)) {
    return normalized;
  }
  return 'default';
}

function preferredArtifactSuffixes(platform = process.platform) {
  switch (normalizeReleasePlatform(platform)) {
    case 'win32':
      return ['.exe', '.zip', '.dmg', '.appimage', '.blockmap'];
    case 'darwin':
      return ['.dmg', '.zip', '.exe', '.appimage', '.blockmap'];
    case 'linux':
      return ['.appimage', '.zip', '.exe', '.dmg', '.blockmap'];
    default:
      return ['.zip', '.exe', '.dmg', '.appimage', '.blockmap'];
  }
}

function compatibleArtifactSuffixes(platform = process.platform) {
  switch (normalizeReleasePlatform(platform)) {
    case 'win32':
      return ['.exe', '.zip'];
    case 'darwin':
      return ['.dmg', '.zip'];
    case 'linux':
      return ['.appimage', '.zip'];
    default:
      return ['.zip', '.exe', '.dmg', '.appimage'];
  }
}

function isArtifactCompatibleWithPlatform(fileName, platform = process.platform) {
  const lower = String(fileName || '').toLowerCase();
  return compatibleArtifactSuffixes(platform).some((suffix) => lower.endsWith(suffix));
}

function normalizeManifestScalar(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return '';
  }
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function readJson(filePath, fallback = null) {
  if (!filePath || !fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return fallback;
  }
}

function ensureDirectory(dirPath) {
  if (!dirPath) {
    return;
  }
  fs.mkdirSync(dirPath, { recursive: true });
}

function requestUrl(url, options = {}, redirectCount = 0) {
  const target = String(url || '').trim();
  if (!target) {
    return Promise.reject(new Error('Download URL is required.'));
  }
  if (redirectCount > 5) {
    return Promise.reject(new Error(`Too many redirects while fetching ${target}`));
  }
  return new Promise((resolve, reject) => {
    const transport = target.startsWith('https:') ? https : http;
    const req = transport.get(target, options, (response) => {
      const statusCode = Number(response.statusCode || 0);
      if ([301, 302, 303, 307, 308].includes(statusCode) && response.headers.location) {
        response.resume();
        const redirected = new URL(response.headers.location, target).toString();
        requestUrl(redirected, options, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`Request failed (${statusCode}) for ${target}`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    req.on('error', reject);
  });
}

function fetchText(url, options = {}) {
  return requestUrl(url, options).then((buffer) => buffer.toString('utf8'));
}

function fetchBuffer(url, options = {}) {
  return requestUrl(url, options);
}

function resolveLatestMacManifestUrl(feedUrl) {
  const raw = String(feedUrl || '').trim();
  if (!raw) {
    return '';
  }
  if (/latest-mac\.ya?ml$/i.test(raw)) {
    return raw;
  }
  return new URL(raw.endsWith('/') ? 'latest-mac.yml' : `${raw}/latest-mac.yml`).toString();
}

function parseLatestMacManifest(content) {
  const manifest = {
    version: '',
    path: '',
    files: [],
  };
  let currentFile = null;
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const withoutComment = String(rawLine || '').split('#')[0].replace(/\t/g, '    ');
    if (!withoutComment.trim()) {
      continue;
    }
    const versionMatch = withoutComment.match(/^version:\s*(.+)$/);
    if (versionMatch) {
      manifest.version = normalizeManifestScalar(versionMatch[1]);
      continue;
    }
    const pathMatch = withoutComment.match(/^path:\s*(.+)$/);
    if (pathMatch) {
      manifest.path = normalizeManifestScalar(pathMatch[1]);
      continue;
    }
    const fileMatch = withoutComment.match(/^\s*-\s*url:\s*(.+)$/);
    if (fileMatch) {
      currentFile = { url: normalizeManifestScalar(fileMatch[1]) };
      manifest.files.push(currentFile);
      continue;
    }
    if (!currentFile) {
      continue;
    }
    const nestedUrlMatch = withoutComment.match(/^\s+url:\s*(.+)$/);
    if (nestedUrlMatch) {
      currentFile.url = normalizeManifestScalar(nestedUrlMatch[1]);
      continue;
    }
    const shaMatch = withoutComment.match(/^\s+sha512:\s*(.+)$/);
    if (shaMatch) {
      currentFile.sha512 = normalizeManifestScalar(shaMatch[1]);
      continue;
    }
    const sizeMatch = withoutComment.match(/^\s+size:\s*(.+)$/);
    if (sizeMatch) {
      const parsed = Number.parseInt(normalizeManifestScalar(sizeMatch[1]), 10);
      currentFile.size = Number.isFinite(parsed) ? parsed : 0;
    }
  }
  return manifest;
}

function manifestDownloadUrls(manifest) {
  const urls = [];
  for (const file of Array.isArray(manifest?.files) ? manifest.files : []) {
    const url = String(file?.url || '').trim();
    if (url && !urls.includes(url)) {
      urls.push(url);
    }
  }
  const primaryPath = String(manifest?.path || '').trim();
  if (primaryPath && !urls.includes(primaryPath)) {
    urls.push(primaryPath);
  }
  return urls;
}

function artifactPriority(fileName, options = {}) {
  const lower = String(fileName || '').toLowerCase();
  const suffixes = preferredArtifactSuffixes(options.platform);
  for (let index = 0; index < suffixes.length; index += 1) {
    if (lower.endsWith(suffixes[index])) {
      return index;
    }
  }
  return 10;
}

function parseVersionFromName(fileName) {
  let baseName = String(fileName || '');
  if (baseName.toLowerCase().endsWith('.blockmap')) {
    baseName = baseName.slice(0, -'.blockmap'.length);
  }
  baseName = baseName.replace(/\.[^.]+$/, '');
  const match = baseName.match(/-(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)*)/);
  return match ? match[1] : '';
}

function listReleaseArtifacts(directory) {
  if (!directory || !fs.existsSync(directory)) {
    return [];
  }
  return fs.readdirSync(directory)
    .filter((name) => RELEASE_SUFFIXES.some((suffix) => String(name).toLowerCase().endsWith(suffix)))
    .map((name) => {
      const fullPath = path.join(directory, name);
      const stat = fs.statSync(fullPath);
      return {
        name,
        fullPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        version: parseVersionFromName(name),
      };
    })
    .sort((left, right) => {
      const priorityGap = artifactPriority(left.name) - artifactPriority(right.name);
      if (priorityGap !== 0) {
        return priorityGap;
      }
      return right.mtimeMs - left.mtimeMs;
    });
}

function getLatestStagedRelease(workspaceRoot, options = {}) {
  const releaseDir = getConfiguredAssistantDesktopReleaseDir(workspaceRoot);
  const artifacts = listReleaseArtifacts(releaseDir).filter((item) => !String(item.name).toLowerCase().endsWith('.blockmap'));
  const groups = groupedArtifactsByVersion(artifacts);
  const latestGroup = groups.find((group) => group.items.some((item) => isArtifactCompatibleWithPlatform(item.name, options.platform)))
    || groups[0]
    || null;
  const latest = latestGroup ? resolvePreferredReleaseArtifact(latestGroup.items, options) : null;
  return {
    releaseDir,
    artifacts,
    latest,
  };
}

function resolvePreferredReleaseArtifact(artifacts, options = {}) {
  const candidates = Array.isArray(artifacts)
    ? artifacts.filter((item) => !String(item?.name || '').toLowerCase().endsWith('.blockmap'))
    : [];
  if (candidates.length === 0) {
    return null;
  }
  return candidates
    .slice()
    .sort((left, right) => {
      const priorityGap = artifactPriority(left.name, options) - artifactPriority(right.name, options);
      if (priorityGap !== 0) {
        return priorityGap;
      }
      return Number(right.mtimeMs || 0) - Number(left.mtimeMs || 0);
    })[0] || null;
}

function getLiveChannelStatus(workspaceRoot, options = {}) {
  const channelDir = getConfiguredAssistantDesktopLiveChannelDir(workspaceRoot);
  const artifacts = listReleaseArtifacts(channelDir);
  const manifestPath = channelDir ? path.join(channelDir, 'latest-mac.yml') : '';
  const manifestExists = !!(manifestPath && fs.existsSync(manifestPath));
  const groups = groupedArtifactsByVersion(artifacts);
  const latestGroup = groups.find((group) => group.items.some((item) => isArtifactCompatibleWithPlatform(item.name, options.platform)))
    || groups[0]
    || null;
  const latest = latestGroup ? resolvePreferredReleaseArtifact(latestGroup.items, options) : null;
  return {
    channelDir,
    artifacts,
    manifestPath,
    manifestExists,
    latest,
  };
}

function copyIfChanged(sourcePath, targetPath) {
  const sourceStat = fs.statSync(sourcePath);
  if (fs.existsSync(targetPath)) {
    const targetStat = fs.statSync(targetPath);
    if (targetStat.size === sourceStat.size && Math.round(targetStat.mtimeMs) === Math.round(sourceStat.mtimeMs)) {
      return false;
    }
  }
  fs.copyFileSync(sourcePath, targetPath);
  fs.utimesSync(targetPath, sourceStat.atime, sourceStat.mtime);
  return true;
}

function stageDesktopReleaseArtifacts(workspaceRoot, options = {}) {
  const sourceDir = options.sourceDir || getConfiguredAssistantDesktopBuildDir(workspaceRoot);
  const releaseDir = options.releaseDir || getConfiguredAssistantDesktopReleaseDir(workspaceRoot);
  if (!sourceDir || !releaseDir || !fs.existsSync(sourceDir)) {
    return {
      ok: false,
      sourceDir,
      releaseDir,
      copied: [],
      message: 'No desktop build output is available to stage.',
    };
  }

  const candidates = listReleaseArtifacts(sourceDir);
  if (candidates.length === 0) {
    return {
      ok: false,
      sourceDir,
      releaseDir,
      copied: [],
      message: 'No desktop installer artifacts were found to stage.',
    };
  }

  ensureDirectory(releaseDir);
  const copied = [];
  for (const artifact of candidates) {
    const targetPath = path.join(releaseDir, artifact.name);
    if (copyIfChanged(artifact.fullPath, targetPath)) {
      copied.push(targetPath);
    }
  }

  return {
    ok: true,
    sourceDir,
    releaseDir,
    copied,
    latest: getLatestStagedRelease(workspaceRoot, options).latest,
    message: copied.length
      ? `Staged ${copied.length} desktop release artifact(s) into ${releaseDir}.`
      : `Desktop release artifacts are already staged in ${releaseDir}.`,
  };
}

async function downloadLatestReleaseFromFeed(workspaceRoot, options = {}) {
  const feedUrl = String(options.feedUrl || '').trim();
  const releaseDir = options.releaseDir || getConfiguredAssistantDesktopReleaseDir(workspaceRoot);
  if (!feedUrl) {
    return {
      ok: false,
      message: 'No desktop release feed URL is configured.',
      releaseDir,
    };
  }
  if (!releaseDir) {
    return {
      ok: false,
      message: 'No desktop release directory is configured.',
      releaseDir,
    };
  }

  const manifestUrl = resolveLatestMacManifestUrl(feedUrl);
  const textFetcher = typeof options.fetchText === 'function' ? options.fetchText : fetchText;
  const bufferFetcher = typeof options.fetchBuffer === 'function' ? options.fetchBuffer : fetchBuffer;
  const manifestText = await textFetcher(manifestUrl, options.requestOptions || {});
  const manifest = parseLatestMacManifest(manifestText);
  const urls = manifestDownloadUrls(manifest);
  if (!urls.length) {
    return {
      ok: false,
      message: 'Desktop release manifest did not list any downloadable artifacts.',
      manifestUrl,
      releaseDir,
    };
  }

  ensureDirectory(releaseDir);
  const downloaded = [];
  for (const relativeUrl of urls) {
    const artifactUrl = new URL(relativeUrl, manifestUrl).toString();
    const fileName = decodeURIComponent(path.basename(new URL(artifactUrl).pathname));
    const targetPath = path.join(releaseDir, fileName);
    const content = await bufferFetcher(artifactUrl, options.requestOptions || {});
    fs.writeFileSync(targetPath, content);
    downloaded.push(targetPath);
  }

  const manifestPath = path.join(releaseDir, 'latest-mac.yml');
  fs.writeFileSync(manifestPath, manifestText, 'utf8');
  const channelPath = path.join(releaseDir, 'channel.json');
  fs.writeFileSync(channelPath, `${JSON.stringify({
    version: manifest.version || '',
    downloadedAt: new Date().toISOString(),
    sourceFeedUrl: feedUrl,
    manifestUrl,
    artifacts: downloaded.map((item) => path.basename(item)),
    channel: 'downloaded',
  }, null, 2)}\n`, 'utf8');

  return {
    ok: true,
    feedUrl,
    manifestUrl,
    manifestPath,
    channelPath,
    releaseDir,
    version: manifest.version || '',
    downloaded,
    latest: getLatestStagedRelease(workspaceRoot, options).latest,
    message: `Downloaded desktop release ${manifest.version || 'unknown'} into ${releaseDir}.`,
  };
}

function groupedArtifactsByVersion(artifacts) {
  const groups = new Map();
  for (const artifact of artifacts || []) {
    const version = artifact.version || 'unknown';
    const bucket = groups.get(version) || [];
    bucket.push(artifact);
    groups.set(version, bucket);
  }
  return Array.from(groups.entries())
    .map(([version, items]) => ({
      version,
      items: items.sort((left, right) => right.mtimeMs - left.mtimeMs),
      mtimeMs: Math.max(...items.map((item) => item.mtimeMs || 0)),
    }))
    .sort((left, right) => {
      const versionGap = compareReleaseVersions(String(right.version || ''), String(left.version || ''));
      if (versionGap !== 0) {
        return versionGap;
      }
      const mtimeGap = right.mtimeMs - left.mtimeMs;
      if (mtimeGap !== 0) {
        return mtimeGap;
      }
      return 0;
    });
}

function buildReleaseHistoryEntries(artifacts, options = {}) {
  const promotedVersion = String(options.promotedVersion || '');
  return groupedArtifactsByVersion(artifacts).map((group, index) => ({
    version: group.version,
    artifactCount: group.items.length,
    mtimeMs: group.mtimeMs,
    latestFile: group.items[0]?.name || '',
    files: group.items.map((item) => ({
      name: item.name,
      size: item.size,
      mtimeMs: item.mtimeMs,
      fullPath: item.fullPath,
    })),
    promoted: !!promotedVersion && group.version === promotedVersion,
    current: index === 0,
  }));
}

function removeFileIfPresent(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true, recursive: true });
    return true;
  }
  return false;
}

function getStagedReleaseKeepCount(workspaceRoot) {
  const config = readConfigMap(workspaceRoot);
  const raw = Number(config.assistant_desktop_release_keep || 3);
  if (!Number.isFinite(raw) || raw < 1) {
    return 1;
  }
  return Math.floor(raw);
}

function pruneStagedReleases(workspaceRoot, options = {}) {
  const releaseDir = options.releaseDir || getConfiguredAssistantDesktopReleaseDir(workspaceRoot);
  if (!releaseDir || !fs.existsSync(releaseDir)) {
    return {
      ok: true,
      releaseDir,
      removed: [],
      keptVersions: [],
      message: 'No staged release directory found.',
    };
  }
  const keepCount = Number.isFinite(Number(options.keepVersions))
    ? Math.max(1, Math.floor(Number(options.keepVersions)))
    : getStagedReleaseKeepCount(workspaceRoot);
  const groups = groupedArtifactsByVersion(listReleaseArtifacts(releaseDir));
  const keep = groups.slice(0, keepCount).map((group) => group.version);
  const remove = groups.slice(keepCount);
  const removed = [];
  for (const group of remove) {
    for (const artifact of group.items) {
      if (removeFileIfPresent(artifact.fullPath)) {
        removed.push(artifact.fullPath);
      }
    }
  }
  return {
    ok: true,
    releaseDir,
    removed,
    keptVersions: keep,
    message: removed.length
      ? `Pruned ${removed.length} staged artifact(s). Keeping ${keep.length} version(s).`
      : `No staged releases needed pruning. Keeping ${keep.length} version(s).`,
  };
}

function sha512Base64(filePath) {
  const digest = crypto.createHash('sha512');
  digest.update(fs.readFileSync(filePath));
  return digest.digest('base64');
}

function renderLatestMacYml(version, artifacts) {
  const fileArtifacts = artifacts
    .filter((item) => !String(item.name).toLowerCase().endsWith('.blockmap'))
    .map((item) => ({
      url: item.name,
      sha512: sha512Base64(item.fullPath),
      size: fs.statSync(item.fullPath).size,
    }));
  const primary = fileArtifacts.find((item) => item.url.toLowerCase().endsWith('.zip')) || fileArtifacts[0] || null;
  const releaseDate = new Date().toISOString();
  const lines = [
    `version: ${version || '0.0.0'}`,
    `files:`,
  ];
  for (const item of fileArtifacts) {
    lines.push(`  - url: ${item.url}`);
    lines.push(`    sha512: ${item.sha512}`);
    lines.push(`    size: ${item.size}`);
  }
  if (primary) {
    lines.push(`path: ${primary.url}`);
    lines.push(`sha512: ${primary.sha512}`);
  }
  lines.push(`releaseDate: '${releaseDate}'`);
  return `${lines.join('\n')}\n`;
}

function promoteLatestStagedRelease(workspaceRoot, options = {}) {
  const staged = getLatestStagedRelease(workspaceRoot);
  if (!staged.latest) {
    return {
      ok: false,
      message: 'No staged desktop release is available to promote.',
      channelDir: getConfiguredAssistantDesktopLiveChannelDir(workspaceRoot),
    };
  }
  const version = staged.latest.version || 'unknown';
  const channelDir = options.channelDir || getConfiguredAssistantDesktopLiveChannelDir(workspaceRoot);
  if (!channelDir) {
    return {
      ok: false,
      message: 'No live update channel directory is configured.',
      channelDir: '',
    };
  }
  ensureDirectory(channelDir);
  const versionArtifacts = listReleaseArtifacts(staged.releaseDir).filter((item) => item.version === version);
  const existingArtifacts = listReleaseArtifacts(channelDir);
  for (const artifact of existingArtifacts) {
    removeFileIfPresent(artifact.fullPath);
  }
  removeFileIfPresent(path.join(channelDir, 'latest-mac.yml'));
  removeFileIfPresent(path.join(channelDir, 'channel.json'));

  const copied = [];
  for (const artifact of versionArtifacts) {
    const targetPath = path.join(channelDir, artifact.name);
    fs.copyFileSync(artifact.fullPath, targetPath);
    copied.push(targetPath);
  }
  fs.writeFileSync(path.join(channelDir, 'latest-mac.yml'), renderLatestMacYml(version, versionArtifacts), 'utf8');
  fs.writeFileSync(path.join(channelDir, 'channel.json'), `${JSON.stringify({
    version,
    promotedAt: new Date().toISOString(),
    artifacts: versionArtifacts.map((item) => item.name),
    channel: 'live',
  }, null, 2)}\n`, 'utf8');
  return {
    ok: true,
    channelDir,
    version,
    copied,
    message: `Promoted desktop release ${version} to live channel at ${channelDir}.`,
  };
}

function getStagedReleaseStatus(workspaceRoot, options = {}) {
  const staged = getLatestStagedRelease(workspaceRoot, options);
  return {
    ...staged,
    history: buildReleaseHistoryEntries(staged.artifacts),
  };
}

function getStagedReleaseByVersion(workspaceRoot, version, options = {}) {
  const releaseDir = options.releaseDir || getConfiguredAssistantDesktopReleaseDir(workspaceRoot);
  const normalizedVersion = String(version || '').trim();
  const artifacts = listReleaseArtifacts(releaseDir)
    .filter((item) => !String(item.name).toLowerCase().endsWith('.blockmap'))
    .filter((item) => String(item.version || '') === normalizedVersion);
  const history = buildReleaseHistoryEntries(listReleaseArtifacts(releaseDir));
  return {
    releaseDir,
    version: normalizedVersion,
    artifacts,
    preferred: resolvePreferredReleaseArtifact(artifacts, options),
    entry: history.find((item) => item.version === normalizedVersion) || null,
  };
}

function getLiveChannelReleaseStatus(workspaceRoot, options = {}) {
  const live = getLiveChannelStatus(workspaceRoot, options);
  const channelMeta = readJson(live.channelDir ? path.join(live.channelDir, 'channel.json') : '', {});
  const promotedVersion = String(channelMeta?.version || live.latest?.version || '');
  return {
    ...live,
    promotedVersion,
    promotedAt: String(channelMeta?.promotedAt || ''),
    history: buildReleaseHistoryEntries(live.artifacts, { promotedVersion }),
  };
}

module.exports = {
  buildReleaseHistoryEntries,
  compareReleaseVersions,
  downloadLatestReleaseFromFeed,
  getLiveChannelStatus,
  getLiveChannelReleaseStatus,
  getLatestStagedRelease,
  getStagedReleaseByVersion,
  getStagedReleaseStatus,
  listReleaseArtifacts,
  parseVersionFromName,
  promoteLatestStagedRelease,
  pruneStagedReleases,
  resolvePreferredReleaseArtifact,
  stageDesktopReleaseArtifacts,
};
