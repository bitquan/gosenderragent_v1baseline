#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const packageMeta = require('../package.json');
const { buildAppStoragePaths } = require('../core/app-storage-paths');
const { getConfiguredAssistantDevDataRoot } = require('../core/assistant-paths');
const { createResilientStore } = require('../core/settings-store');

const SECRET_SERVICE = 'gosenderr-desktop-agent';
const STORE_NAME = 'desktop-agent-settings';
const APP_NAME = String(packageMeta.productName || 'GoSenderr Desktop Agent').trim() || 'GoSenderr Desktop Agent';

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function parseArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  return {
    electronFallback: args.includes('--electron-fallback'),
    secretName: String(args.find((value) => value && !value.startsWith('--')) || '').trim(),
  };
}

async function readWithKeytar(secretName) {
  let keytar;
  try {
    keytar = require('keytar');
  } catch (_error) {
    return null;
  }
  const value = await keytar.getPassword(SECRET_SERVICE, secretName);
  return {
    ok: true,
    value: value || '',
    backend: 'keytar',
  };
}

function ensureAppStoragePath(app, pathName, targetPath) {
  const resolvedPath = path.resolve(String(targetPath || '').trim());
  if (!resolvedPath) {
    return '';
  }
  fs.mkdirSync(resolvedPath, { recursive: true });
  try {
    app.setPath(pathName, resolvedPath);
  } catch (_error) {
    return '';
  }
  return resolvedPath;
}

async function readWithElectronProcess(secretName) {
  const { app, safeStorage } = require('electron');
  const StoreModule = require('electron-store');
  const Store = StoreModule.default || StoreModule;

  app.setName(APP_NAME);

  const requestedUserDataDir = String(process.env.DESKTOP_AGENT_USER_DATA_DIR || '').trim();
  const requestedSessionDataDir = String(process.env.DESKTOP_AGENT_SESSION_DATA_DIR || '').trim();
  const requestedCacheDir = String(process.env.DESKTOP_AGENT_CACHE_DIR || '').trim();
  const configuredDevDataRoot = getConfiguredAssistantDevDataRoot(path.resolve(__dirname, '..'));
  const configuredLocalStorageRoot = configuredDevDataRoot ? path.join(configuredDevDataRoot, 'desktop_app_state') : '';
  const requestedLocalStorageRoot = String(process.env.DESKTOP_AGENT_LOCAL_STORAGE_ROOT || '').trim()
    || (process.platform === 'win32'
      ? path.resolve(configuredLocalStorageRoot || String(process.env.LOCALAPPDATA || '').trim() || app.getPath('temp'))
      : '');

  const storagePaths = buildAppStoragePaths({
    appName: APP_NAME,
    isDev: !app.isPackaged,
    localStorageRoot: requestedLocalStorageRoot,
    requestedUserDataDir,
    requestedSessionDataDir,
    requestedCacheDir,
    fallbackUserDataDir: app.getPath('userData'),
  });

  ensureAppStoragePath(app, 'userData', storagePaths.userDataDir);
  ensureAppStoragePath(app, 'sessionData', storagePaths.sessionDataDir);
  ensureAppStoragePath(app, 'cache', storagePaths.cacheDir);

  await app.whenReady();

  try {
    const store = createResilientStore(Store, {
      userDataRoot: app.getPath('userData'),
      name: STORE_NAME,
    });
    const fallback = store.get('encryptedSecrets') || {};
    const blob = fallback[secretName];
    if (!blob) {
      return { ok: true, value: '', backend: 'safeStorage-fallback' };
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, value: null, backend: 'none', message: 'OS encryption is unavailable.' };
    }
    const value = safeStorage.decryptString(Buffer.from(blob, 'base64'));
    return { ok: true, value, backend: 'safeStorage-fallback' };
  } finally {
    app.quit();
  }
}

async function readWithElectronFallback(secretName) {
  const electronBinary = require('electron');
  const result = childProcess.spawnSync(
    electronBinary,
    [__filename, '--electron-fallback', secretName],
    {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_NO_ATTACH_CONSOLE: '1',
        ...(process.env.DESKTOP_AGENT_LOCAL_STORAGE_ROOT ? {} : { DESKTOP_AGENT_LOCAL_STORAGE_ROOT: requestedLocalStorageRoot || '' }),
      },
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `Electron fallback failed with exit code ${result.status}`).trim());
  }
  const output = String(result.stdout || '').trim();
  return output ? JSON.parse(output) : { ok: true, value: '', backend: 'safeStorage-fallback' };
}

async function main() {
  const { electronFallback, secretName } = parseArgs(process.argv);
  if (!secretName) {
    throw new Error('Secret name is required.');
  }

  if (electronFallback) {
    printJson(await readWithElectronProcess(secretName));
    return;
  }

  const keytarResult = await readWithKeytar(secretName);
  if (keytarResult) {
    printJson(keytarResult);
    return;
  }

  printJson(await readWithElectronFallback(secretName));
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error || 'Unknown secret reader failure.');
  console.error(message);
  process.exit(1);
});