#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { APP_ROOT, resolveTargetWorkspaceRoot } = require('../core/app-roots');
const { getConfiguredAssistantDesktopBuildDir } = require('../core/assistant-paths');
const packageMeta = require('../package.json');

const appRoot = APP_ROOT;
const workspaceRoot = resolveTargetWorkspaceRoot(process.env.DESKTOP_AGENT_TARGET_WORKSPACE);
const distDir = getConfiguredAssistantDesktopBuildDir(workspaceRoot) || path.join(appRoot, 'dist');
const productName = String(packageMeta.productName || 'GoSenderr Desktop Agent').trim() || 'GoSenderr Desktop Agent';
const managedUserDataDir = process.env.DESKTOP_AGENT_USER_DATA_DIR
  ? ''
  : fs.mkdtempSync(path.join(os.tmpdir(), 'gos-packaged-smoke-user-data-'));
const managedSessionDataDir = managedUserDataDir ? path.join(managedUserDataDir, 'session-data') : '';
const managedCacheDir = managedSessionDataDir ? path.join(managedSessionDataDir, 'Cache') : '';

function fail(message) {
  console.error(`[packaged-smoke] ${message}`);
  if (managedUserDataDir) {
    try {
      fs.rmSync(managedUserDataDir, { recursive: true, force: true });
    } catch (_error) {
      // ignore cleanup failures
    }
  }
  process.exit(1);
}

function findExecutable() {
  if (!fs.existsSync(distDir)) {
    return '';
  }

  if (process.platform === 'darwin') {
    for (const directory of fs.readdirSync(distDir)) {
      if (!/^mac(?:-|$)/i.test(directory)) {
        continue;
      }
      const candidate = path.join(distDir, directory, `${productName}.app`, 'Contents', 'MacOS', productName);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return '';
  }

  if (process.platform === 'linux') {
    for (const directory of fs.readdirSync(distDir)) {
      if (!/^linux/i.test(directory)) {
        continue;
      }
      const candidate = path.join(distDir, directory, productName);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return '';
  }

  if (process.platform === 'win32') {
    for (const directory of fs.readdirSync(distDir)) {
      if (!/^win/i.test(directory)) {
        continue;
      }
      const candidate = path.join(distDir, directory, `${productName}.exe`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return '';
}

const executable = findExecutable();
if (!executable) {
  fail(`No packaged executable found under ${distDir}. Run npm run pack or npm run pack:mac first.`);
}

console.log('[packaged-smoke] executable =', executable);

const child = spawn(executable, [], {
  cwd: appRoot,
  env: {
    ...process.env,
    DESKTOP_AGENT_PACKAGED_SMOKE: '1',
    DESKTOP_AGENT_UI_SMOKE: '1',
    ...(managedUserDataDir ? { DESKTOP_AGENT_USER_DATA_DIR: managedUserDataDir } : {}),
    ...(managedSessionDataDir ? { DESKTOP_AGENT_SESSION_DATA_DIR: managedSessionDataDir } : {}),
    ...(managedCacheDir ? { DESKTOP_AGENT_CACHE_DIR: managedCacheDir } : {}),
    ...(workspaceRoot ? { DESKTOP_AGENT_TARGET_WORKSPACE: workspaceRoot } : {}),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
});

child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
});

child.on('error', (error) => {
  fail(error.message || 'Packaged app failed to launch.');
});

child.on('close', (code) => {
  if (managedUserDataDir) {
    try {
      fs.rmSync(managedUserDataDir, { recursive: true, force: true });
    } catch (_error) {
      // ignore cleanup failures
    }
  }
  process.exit(Number(code || 0));
});
