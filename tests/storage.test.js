'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const {
  buildStorageSnapshot,
  cleanupStorageArtifacts,
  clearStorageSnapshotCache,
  detectVolumeKey,
  formatBytes,
} = require('../core/storage');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-storage-'));
  fs.mkdirSync(path.join(root, 'docs', 'assistant_runs'), { recursive: true });
  return root;
}

test('formatBytes renders readable storage units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.00 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.00 MB');
});

test('detectVolumeKey distinguishes macOS external volumes', () => {
  assert.equal(detectVolumeKey('/Volumes/projects/gosenderr_dev_offload/assistant_runs'), '/Volumes/projects');
  assert.equal(detectVolumeKey('/Users/papadev/dev/gosenderr_v1'), '/');
});

test('buildStorageSnapshot reads configured offload directories', () => {
  const workspaceRoot = makeWorkspace();
  const offloadRoot = path.join(workspaceRoot, 'offload-root');
  const runsDir = path.join(offloadRoot, 'assistant_runs');
  const devDataDir = path.join(offloadRoot, 'dev_data');
  const buildDir = path.join(offloadRoot, 'desktop_builds');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(devDataDir, { recursive: true });
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, 'BAT1_run.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(devDataDir, 'memory.json'), '[]', 'utf8');
  fs.writeFileSync(path.join(buildDir, 'release.zip'), 'zip', 'utf8');
  fs.writeFileSync(
    path.join(workspaceRoot, 'dev_assistant.yaml'),
    [
      `assistant_artifacts_root: ${offloadRoot}`,
      `assistant_runs_dir: ${runsDir}`,
      `assistant_dev_data_dir: ${devDataDir}`,
      `assistant_desktop_build_dir: ${buildDir}`,
    ].join('\n'),
    'utf8',
  );

  const originalExecFileSync = childProcess.execFileSync;
  const originalStatfsSync = fs.statfsSync;
  childProcess.execFileSync = (_command, args) => {
    const target = String(args[1] || '');
    if (target === runsDir) {
      return '8\tassistant_runs\n';
    }
    if (target === devDataDir) {
      return '4\tdev_data\n';
    }
    if (target === buildDir) {
      return '1024\tdesktop_builds\n';
    }
    return '0\tunknown\n';
  };
  fs.statfsSync = (targetPath) => {
    const volumeKey = detectVolumeKey(targetPath);
    if (volumeKey === detectVolumeKey(offloadRoot)) {
      return { bsize: 1024, blocks: 400000, bavail: 100000 };
    }
    return { bsize: 1024, blocks: 800000, bavail: 500000 };
  };

  try {
    clearStorageSnapshotCache();
    const snapshot = buildStorageSnapshot(workspaceRoot, { force: true, now: 1 });
    assert.equal(snapshot.offloadConfigured, true);
    assert.equal(snapshot.sameVolume, true);
    assert.equal(snapshot.items[0].id, 'desktop-builds');
    assert.equal(snapshot.items[0].bytes, 1024 * 1024);
    assert.equal(snapshot.volumes.length, 1);
    assert.ok(Array.isArray(snapshot.cleanupHints));
    assert.match(snapshot.summaryText, /tracked/);
    assert.match(snapshot.summaryText, /free on Workspace \+ Offload Disk/);
  } finally {
    childProcess.execFileSync = originalExecFileSync;
    fs.statfsSync = originalStatfsSync;
    clearStorageSnapshotCache();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('buildStorageSnapshot surfaces cleanup hints for large desktop builds', () => {
  const workspaceRoot = makeWorkspace();
  const buildDir = path.join(workspaceRoot, 'desktop_builds');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), `assistant_desktop_build_dir: ${buildDir}\n`, 'utf8');

  const originalExecFileSync = childProcess.execFileSync;
  const originalStatfsSync = fs.statfsSync;
  childProcess.execFileSync = (_command, args) => {
    const target = String(args[1] || '');
    if (target === buildDir) {
      return '700000	desktop_builds\n';
    }
    return '1	other\n';
  };
  fs.statfsSync = () => ({ bsize: 1024, blocks: 500000, bavail: 200000 });

  try {
    clearStorageSnapshotCache();
    const snapshot = buildStorageSnapshot(workspaceRoot, { force: true, now: 5 });
    assert.ok(snapshot.cleanupHints.some((item) => item.includes('Desktop builds')));
    assert.match(snapshot.summaryText, /consider cleanup/i);
  } finally {
    childProcess.execFileSync = originalExecFileSync;
    fs.statfsSync = originalStatfsSync;
    clearStorageSnapshotCache();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('buildStorageSnapshot reuses cached payload within ttl', () => {
  const workspaceRoot = makeWorkspace();
  const originalExecFileSync = childProcess.execFileSync;
  const originalStatfsSync = fs.statfsSync;
  let duCalls = 0;
  childProcess.execFileSync = () => {
    duCalls += 1;
    return '1\tassistant_runs\n';
  };
  fs.statfsSync = () => ({ bsize: 1024, blocks: 100000, bavail: 50000 });

  try {
    clearStorageSnapshotCache();
    const first = buildStorageSnapshot(workspaceRoot, { force: true, now: 100 });
    const second = buildStorageSnapshot(workspaceRoot, { now: 200 });
    assert.equal(first.summaryText, second.summaryText);
    assert.equal(duCalls > 0, true);
    assert.equal(duCalls < 4, true);
  } finally {
    childProcess.execFileSync = originalExecFileSync;
    fs.statfsSync = originalStatfsSync;
    clearStorageSnapshotCache();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('cleanupStorageArtifacts removes generated build outputs', () => {
  const workspaceRoot = makeWorkspace();
  const buildDir = path.join(workspaceRoot, 'desktop_builds');
  fs.mkdirSync(path.join(buildDir, 'mac-arm64', 'GoSenderr Desktop Agent.app'), { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'GoSenderr Desktop Agent-0.1.2-arm64.zip'), 'zip', 'utf8');
  fs.writeFileSync(path.join(buildDir, 'GoSenderr Desktop Agent-0.1.2-arm64.dmg'), 'dmg', 'utf8');
  fs.writeFileSync(path.join(buildDir, 'builder-debug.yml'), 'debug', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), `assistant_desktop_build_dir: ${buildDir}\n`, 'utf8');

  try {
    const result = cleanupStorageArtifacts(workspaceRoot, { scope: 'desktop-builds' });
    assert.equal(result.ok, true);
    assert.equal(result.removed.length, 4);
    assert.equal(fs.existsSync(path.join(buildDir, 'mac-arm64')), false);
    assert.equal(fs.existsSync(path.join(buildDir, 'GoSenderr Desktop Agent-0.1.2-arm64.zip')), false);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('cleanupStorageArtifacts removes transient artifact directories', () => {
  const workspaceRoot = makeWorkspace();
  const offloadRoot = path.join(workspaceRoot, 'offload-root');
  const sandboxesDir = path.join(offloadRoot, 'assistant_sandboxes');
  const tmpDir = path.join(offloadRoot, 'tmp');
  const testArtifactsDir = path.join(offloadRoot, 'test_artifacts');
  fs.mkdirSync(path.join(sandboxesDir, 'run-1'), { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(testArtifactsDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'temp.log'), 'x', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'dev_assistant.yaml'), [
    `assistant_artifacts_root: ${offloadRoot}`,
    `assistant_sandbox_dir: ${sandboxesDir}`,
    `assistant_tmp_dir: ${tmpDir}`,
    `assistant_test_artifacts_dir: ${testArtifactsDir}`,
  ].join('\n'), 'utf8');

  try {
    const result = cleanupStorageArtifacts(workspaceRoot, { scope: 'transient-artifacts' });
    assert.equal(result.ok, true);
    assert.equal(result.removed.length, 3);
    assert.equal(fs.existsSync(sandboxesDir), false);
    assert.equal(fs.existsSync(tmpDir), false);
    assert.equal(fs.existsSync(testArtifactsDir), false);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});