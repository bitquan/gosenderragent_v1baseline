'use strict';

const path = require('path');

function resolveOptionalPath(value) {
  const text = String(value || '').trim();
  return text ? path.resolve(text) : '';
}

function buildAppStoragePaths({
  appName = '',
  isDev = false,
  localStorageRoot = '',
  requestedUserDataDir = '',
  requestedSessionDataDir = '',
  requestedCacheDir = '',
  fallbackUserDataDir = '',
} = {}) {
  const resolvedAppName = String(appName || '').trim() || 'GoSenderr Desktop Agent';
  const storageAppName = isDev ? `${resolvedAppName} Dev` : resolvedAppName;
  const resolvedLocalStorageRoot = resolveOptionalPath(localStorageRoot);
  const storageRoot = resolvedLocalStorageRoot
    ? path.join(resolvedLocalStorageRoot, storageAppName)
    : '';
  const resolvedFallbackUserDataDir = resolveOptionalPath(fallbackUserDataDir);
  const managedUserDataDir = storageRoot ? path.join(storageRoot, 'user-data') : '';

  const userDataDir = resolveOptionalPath(requestedUserDataDir)
    || (isDev ? managedUserDataDir : (resolvedFallbackUserDataDir || managedUserDataDir));

  const sessionDataDir = resolveOptionalPath(requestedSessionDataDir)
    || (storageRoot ? path.join(storageRoot, 'session-data') : path.join(userDataDir, 'session-data'));

  const cacheDir = resolveOptionalPath(requestedCacheDir)
    || path.join(sessionDataDir, 'Cache');

  return {
    storageAppName,
    userDataDir: path.resolve(userDataDir),
    sessionDataDir: path.resolve(sessionDataDir),
    cacheDir: path.resolve(cacheDir),
  };
}

module.exports = {
  buildAppStoragePaths,
};
