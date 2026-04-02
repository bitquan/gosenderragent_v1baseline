'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  compareReleaseVersions,
  downloadLatestReleaseFromFeed,
  getLiveChannelReleaseStatus,
  getLiveChannelStatus,
  getStagedReleaseByVersion,
  getLatestStagedRelease,
  getStagedReleaseStatus,
  parseVersionFromName,
  promoteLatestStagedRelease,
  pruneStagedReleases,
  resolvePreferredReleaseArtifact,
  stageDesktopReleaseArtifacts,
} = require('../core/desktop-release');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-release-'));
  return root;
}

test('parseVersionFromName extracts semantic version from artifact name', () => {
  assert.equal(parseVersionFromName('GoSenderr Desktop Agent-0.1.2-arm64.zip'), '0.1.2-arm64');
  assert.equal(parseVersionFromName('random-file.zip'), '');
});

test('compareReleaseVersions keeps newer versions ahead of older ones', () => {
  assert.equal(compareReleaseVersions('0.1.7', '0.1.6') > 0, true);
  assert.equal(compareReleaseVersions('0.1.6', '0.1.7') < 0, true);
  assert.equal(compareReleaseVersions('0.1.7-x64', '0.1.6-x64') > 0, true);
});

test('stageDesktopReleaseArtifacts copies installers into configured release dir', () => {
  const workspaceRoot = makeWorkspace();
  const buildDir = path.join(workspaceRoot, 'desktop_builds');
  const releaseDir = path.join(workspaceRoot, 'desktop_releases');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'GoSenderr Desktop Agent-0.1.2-arm64.zip'), 'zip', 'utf8');
  fs.writeFileSync(path.join(buildDir, 'GoSenderr Desktop Agent-0.1.2-arm64.dmg'), 'dmg', 'utf8');
  fs.writeFileSync(path.join(buildDir, 'GoSenderr Desktop Agent-0.1.2-x64.exe'), 'exe', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), [
    `assistant_desktop_build_dir: ${buildDir}`,
    `assistant_desktop_release_dir: ${releaseDir}`,
  ].join('\n'), 'utf8');

  try {
    const result = stageDesktopReleaseArtifacts(workspaceRoot);
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.2-arm64.zip')), true);
    assert.equal(fs.existsSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.2-arm64.dmg')), true);
    assert.equal(fs.existsSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.2-x64.exe')), true);
    const latestWin = getLatestStagedRelease(workspaceRoot, { platform: 'win32' });
    const latestMac = getLatestStagedRelease(workspaceRoot, { platform: 'darwin' });
    assert.equal(path.basename(latestWin.latest.fullPath), 'GoSenderr Desktop Agent-0.1.2-x64.exe');
    assert.equal(path.basename(latestMac.latest.fullPath), 'GoSenderr Desktop Agent-0.1.2-arm64.dmg');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('pruneStagedReleases keeps newest configured versions', () => {
  const workspaceRoot = makeWorkspace();
  const releaseDir = path.join(workspaceRoot, 'desktop_releases');
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.0-arm64.zip'), 'a', 'utf8');
  fs.writeFileSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.1-arm64.zip'), 'b', 'utf8');
  fs.writeFileSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.2-arm64.zip'), 'c', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), [
    `assistant_desktop_release_dir: ${releaseDir}`,
    'assistant_desktop_release_keep: 2',
  ].join('\n'), 'utf8');

  try {
    const result = pruneStagedReleases(workspaceRoot);
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.0-arm64.zip')), false);
    assert.equal(fs.existsSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.2-arm64.zip')), true);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('getStagedReleaseStatus groups staged artifacts into version history', () => {
  const workspaceRoot = makeWorkspace();
  const releaseDir = path.join(workspaceRoot, 'desktop_releases');
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.1-arm64.zip'), 'zip-1', 'utf8');
  fs.writeFileSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.2-arm64.zip'), 'zip-2', 'utf8');
  fs.writeFileSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.2-arm64.dmg'), 'dmg-2', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), [
    `assistant_desktop_release_dir: ${releaseDir}`,
  ].join('\n'), 'utf8');

  try {
    const result = getStagedReleaseStatus(workspaceRoot);
    assert.equal(result.history.length, 2);
    assert.equal(result.history[0].version, '0.1.2-arm64');
    assert.equal(result.history[0].artifactCount, 2);
    assert.equal(result.history[0].current, true);
    assert.equal(result.history[0].files.length, 2);
    assert.equal(result.history[1].version, '0.1.1-arm64');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('getStagedReleaseByVersion resolves the preferred staged installer for a selected version', () => {
  const workspaceRoot = makeWorkspace();
  const releaseDir = path.join(workspaceRoot, 'desktop_releases');
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.1-arm64.zip'), 'zip-1', 'utf8');
  fs.writeFileSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.2-arm64.zip'), 'zip-2', 'utf8');
  fs.writeFileSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.2-arm64.dmg'), 'dmg-2', 'utf8');
  fs.writeFileSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.2-x64.exe'), 'exe-2', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), [
    `assistant_desktop_release_dir: ${releaseDir}`,
  ].join('\n'), 'utf8');

  try {
    const macResult = getStagedReleaseByVersion(workspaceRoot, '0.1.2-arm64', { platform: 'darwin' });
    const winResult = getStagedReleaseByVersion(workspaceRoot, '0.1.2-arm64', { platform: 'win32' });
    const winExeResult = getStagedReleaseByVersion(workspaceRoot, '0.1.2-x64', { platform: 'win32' });
    assert.equal(macResult.entry.version, '0.1.2-arm64');
    assert.equal(macResult.artifacts.length, 2);
    assert.equal(path.basename(macResult.preferred.fullPath), 'GoSenderr Desktop Agent-0.1.2-arm64.dmg');
    assert.equal(resolvePreferredReleaseArtifact(macResult.artifacts, { platform: 'darwin' })?.name, 'GoSenderr Desktop Agent-0.1.2-arm64.dmg');
    assert.equal(winResult.entry.version, '0.1.2-arm64');
    assert.equal(path.basename(winResult.preferred.fullPath), 'GoSenderr Desktop Agent-0.1.2-arm64.zip');
    assert.equal(winExeResult.entry.version, '0.1.2-x64');
    assert.equal(path.basename(winExeResult.preferred.fullPath), 'GoSenderr Desktop Agent-0.1.2-x64.exe');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('resolvePreferredReleaseArtifact prefers the native installer for the requested platform', () => {
  const artifacts = [
    { name: 'GoSenderr Desktop Agent-0.1.6-arm64.dmg', mtimeMs: 10 },
    { name: 'GoSenderr Desktop Agent-0.1.6-arm64.zip', mtimeMs: 20 },
    { name: 'GoSenderr Desktop Agent-0.1.6-x64.exe', mtimeMs: 30 },
  ];

  assert.equal(resolvePreferredReleaseArtifact(artifacts, { platform: 'win32' })?.name, 'GoSenderr Desktop Agent-0.1.6-x64.exe');
  assert.equal(resolvePreferredReleaseArtifact(artifacts, { platform: 'darwin' })?.name, 'GoSenderr Desktop Agent-0.1.6-arm64.dmg');
  assert.equal(resolvePreferredReleaseArtifact(artifacts, { platform: 'linux' })?.name, 'GoSenderr Desktop Agent-0.1.6-arm64.zip');
});

test('getLatestStagedRelease skips newer incompatible platform artifacts', () => {
  const workspaceRoot = makeWorkspace();
  const releaseDir = path.join(workspaceRoot, 'desktop_releases');
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.3-arm64.dmg'), 'dmg-newer', 'utf8');
  fs.writeFileSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.2-x64.exe'), 'exe-older', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), [
    `assistant_desktop_release_dir: ${releaseDir}`,
  ].join('\n'), 'utf8');

  try {
    const winLatest = getLatestStagedRelease(workspaceRoot, { platform: 'win32' });
    const macLatest = getLatestStagedRelease(workspaceRoot, { platform: 'darwin' });
    assert.equal(path.basename(winLatest.latest.fullPath), 'GoSenderr Desktop Agent-0.1.2-x64.exe');
    assert.equal(path.basename(macLatest.latest.fullPath), 'GoSenderr Desktop Agent-0.1.3-arm64.dmg');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('getLatestStagedRelease prefers the newest version even when an older artifact has a newer timestamp', () => {
  const workspaceRoot = makeWorkspace();
  const releaseDir = path.join(workspaceRoot, 'desktop_releases');
  fs.mkdirSync(releaseDir, { recursive: true });
  const newerPath = path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.7-x64.exe');
  const olderPath = path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.6-x64.exe');
  fs.writeFileSync(newerPath, 'newer', 'utf8');
  fs.writeFileSync(olderPath, 'older', 'utf8');
  const now = new Date();
  const olderTouchedLast = new Date(now.getTime() + 60_000);
  fs.utimesSync(newerPath, now, now);
  fs.utimesSync(olderPath, olderTouchedLast, olderTouchedLast);
  fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), [
    `assistant_desktop_release_dir: ${releaseDir}`,
  ].join('\n'), 'utf8');

  try {
    const winLatest = getLatestStagedRelease(workspaceRoot, { platform: 'win32' });
    const staged = getStagedReleaseStatus(workspaceRoot, { platform: 'win32' });
    assert.equal(path.basename(winLatest.latest.fullPath), 'GoSenderr Desktop Agent-0.1.7-x64.exe');
    assert.equal(staged.history[0].version, '0.1.7-x64');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('promoteLatestStagedRelease copies latest staged version into live channel', () => {
  const workspaceRoot = makeWorkspace();
  const releaseDir = path.join(workspaceRoot, 'desktop_releases');
  const liveDir = path.join(workspaceRoot, 'desktop_update_channel', 'live');
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.2-arm64.zip'), 'zip', 'utf8');
  fs.writeFileSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.2-arm64.dmg'), 'dmg', 'utf8');
  fs.writeFileSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.1-arm64.zip'), 'older', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), [
    `assistant_desktop_release_dir: ${releaseDir}`,
    `assistant_desktop_live_channel_dir: ${liveDir}`,
  ].join('\n'), 'utf8');

  try {
    const result = promoteLatestStagedRelease(workspaceRoot);
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(liveDir, 'GoSenderr Desktop Agent-0.1.2-arm64.zip')), true);
    assert.equal(fs.existsSync(path.join(liveDir, 'latest-mac.yml')), true);
    const status = getLiveChannelStatus(workspaceRoot);
    assert.equal(status.latest.version, '0.1.2-arm64');
    assert.equal(status.manifestExists, true);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('downloadLatestReleaseFromFeed stores release artifacts in staged release dir', async () => {
  const workspaceRoot = makeWorkspace();
  const releaseDir = path.join(workspaceRoot, 'desktop_releases');
  fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), [
    `assistant_desktop_release_dir: ${releaseDir}`,
  ].join('\n'), 'utf8');

  try {
    const result = await downloadLatestReleaseFromFeed(workspaceRoot, {
      feedUrl: 'https://updates.example.com/live',
      fetchText: async (url) => {
        assert.equal(url, 'https://updates.example.com/live/latest-mac.yml');
        return [
          'version: 0.1.3',
          'files:',
          '  - url: GoSenderr Desktop Agent-0.1.3-arm64.zip',
          '    sha512: zip-sha',
          '    size: 3',
          '  - url: GoSenderr Desktop Agent-0.1.3-arm64.zip.blockmap',
          '    sha512: blockmap-sha',
          '    size: 4',
          'path: GoSenderr Desktop Agent-0.1.3-arm64.zip',
        ].join('\n');
      },
      fetchBuffer: async (url) => Buffer.from(`downloaded:${url}`, 'utf8'),
    });

    assert.equal(result.ok, true);
    assert.equal(result.version, '0.1.3');
    assert.equal(fs.existsSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.3-arm64.zip')), true);
    assert.equal(fs.existsSync(path.join(releaseDir, 'GoSenderr Desktop Agent-0.1.3-arm64.zip.blockmap')), true);
    assert.equal(fs.existsSync(path.join(releaseDir, 'latest-mac.yml')), true);
    assert.equal(fs.existsSync(path.join(releaseDir, 'channel.json')), true);
    const latest = getLatestStagedRelease(workspaceRoot);
    assert.equal(latest.latest.version, '0.1.3-arm64');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('getLiveChannelReleaseStatus marks promoted live version history', () => {
  const workspaceRoot = makeWorkspace();
  const liveDir = path.join(workspaceRoot, 'desktop_update_channel', 'live');
  fs.mkdirSync(liveDir, { recursive: true });
  fs.writeFileSync(path.join(liveDir, 'GoSenderr Desktop Agent-0.1.2-arm64.zip'), 'zip', 'utf8');
  fs.writeFileSync(path.join(liveDir, 'GoSenderr Desktop Agent-0.1.2-arm64.dmg'), 'dmg', 'utf8');
  fs.writeFileSync(path.join(liveDir, 'latest-mac.yml'), 'version: 0.1.2-arm64\n', 'utf8');
  fs.writeFileSync(path.join(liveDir, 'channel.json'), `${JSON.stringify({
    version: '0.1.2-arm64',
    promotedAt: '2026-03-10T12:00:00.000Z',
    channel: 'live',
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), [
    `assistant_desktop_live_channel_dir: ${liveDir}`,
  ].join('\n'), 'utf8');

  try {
    const result = getLiveChannelReleaseStatus(workspaceRoot);
    assert.equal(result.promotedVersion, '0.1.2-arm64');
    assert.equal(result.promotedAt, '2026-03-10T12:00:00.000Z');
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0].promoted, true);
    assert.equal(result.history[0].version, '0.1.2-arm64');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});