'use strict';

const fs = require('fs');
const path = require('path');

const { APP_ROOT } = require('./app-roots');
const { ensureDirectory, nowIso, readJsonFile, writeJsonFileAtomic } = require('./utils');

const LIBRARY_DIR = 'integration-library';
const USER_DIR = '.gos-integrations';
const KIND_DIRS = Object.freeze({
  plugin: 'plugins',
  extension: 'extensions',
  adapter: 'adapters',
});
const MANIFEST_FILE = 'integration.json';

function normalizeKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  return ['plugin', 'extension', 'adapter'].includes(kind) ? kind : '';
}

function normalizeRoot(value) {
  const root = String(value || '').trim();
  return root ? path.resolve(root) : '';
}

function builtInLibraryRoot(appRoot = APP_ROOT) {
  return path.join(normalizeRoot(appRoot) || APP_ROOT, LIBRARY_DIR);
}

function installedIntegrationsRoot(workspaceRoot) {
  const root = normalizeRoot(workspaceRoot);
  return root ? path.join(root, USER_DIR) : '';
}

function manifestPathFor(rootPath) {
  return path.join(rootPath, MANIFEST_FILE);
}

function readManifest(rootPath) {
  const manifest = readJsonFile(manifestPathFor(rootPath), {});
  if (!manifest || typeof manifest !== 'object') {
    return null;
  }
  const kind = normalizeKind(manifest.kind);
  const id = String(manifest.id || '').trim();
  if (!kind || !id) {
    return null;
  }
  return {
    id,
    kind,
    label: String(manifest.label || id).trim() || id,
    summary: String(manifest.summary || '').trim(),
    version: String(manifest.version || '0.1.0').trim() || '0.1.0',
    entry: String(manifest.entry || '').trim(),
    installMode: String(manifest.installMode || 'copy').trim() || 'copy',
    source: String(manifest.source || 'builtin').trim() || 'builtin',
    contributes: Array.isArray(manifest.contributes) ? manifest.contributes.map((item) => String(item || '').trim()).filter(Boolean) : [],
    tags: Array.isArray(manifest.tags) ? manifest.tags.map((item) => String(item || '').trim()).filter(Boolean) : [],
  };
}

function listBuiltInIntegrations(appRoot = APP_ROOT) {
  const libraryRoot = builtInLibraryRoot(appRoot);
  if (!fs.existsSync(libraryRoot)) {
    return [];
  }
  const entries = [];
  for (const [kind, dirName] of Object.entries(KIND_DIRS)) {
    const kindRoot = path.join(libraryRoot, dirName);
    if (!fs.existsSync(kindRoot)) {
      continue;
    }
    for (const entry of fs.readdirSync(kindRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const rootPath = path.join(kindRoot, entry.name);
      const manifest = readManifest(rootPath);
      if (!manifest || manifest.kind !== kind) {
        continue;
      }
      entries.push({
        ...manifest,
        rootPath,
        manifestPath: manifestPathFor(rootPath),
        builtIn: true,
      });
    }
  }
  return entries.sort((left, right) => String(left.label || left.id).localeCompare(String(right.label || right.id)));
}

function listInstalledIntegrations(workspaceRoot) {
  const root = installedIntegrationsRoot(workspaceRoot);
  if (!root || !fs.existsSync(root)) {
    return [];
  }
  const installed = [];
  for (const [kind, dirName] of Object.entries(KIND_DIRS)) {
    const kindRoot = path.join(root, dirName);
    if (!fs.existsSync(kindRoot)) {
      continue;
    }
    for (const entry of fs.readdirSync(kindRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const integrationRoot = path.join(kindRoot, entry.name);
      const manifest = readManifest(integrationRoot);
      if (!manifest || manifest.kind !== kind) {
        continue;
      }
      installed.push({
        ...manifest,
        rootPath: integrationRoot,
        manifestPath: manifestPathFor(integrationRoot),
        installed: true,
      });
    }
  }
  return installed.sort((left, right) => String(left.label || left.id).localeCompare(String(right.label || right.id)));
}

function buildIntegrationStudioStatus(workspaceRoot, options = {}) {
  const appRoot = options.appRoot || APP_ROOT;
  const builtIn = listBuiltInIntegrations(appRoot);
  const installed = listInstalledIntegrations(workspaceRoot);
  const installedById = new Map(installed.map((entry) => [entry.id, entry]));
  const library = builtIn.map((entry) => ({
    ...entry,
    installed: installedById.has(entry.id),
    installedPath: installedById.get(entry.id)?.rootPath || '',
  }));
  const counts = ['plugin', 'extension', 'adapter'].reduce((accumulator, kind) => {
    accumulator[kind] = library.filter((entry) => entry.kind === kind).length;
    accumulator[`${kind}Installed`] = installed.filter((entry) => entry.kind === kind).length;
    return accumulator;
  }, {});
  return {
    ok: true,
    libraryRoot: builtInLibraryRoot(appRoot),
    userRoot: installedIntegrationsRoot(workspaceRoot),
    library,
    installed,
    counts,
    summary: installed.length > 0
      ? `${installed.length} integration${installed.length === 1 ? '' : 's'} installed across plugins, adapters, and extensions.`
      : 'Install a starter plugin, extension, or adapter to grow the local integration surface safely.',
  };
}

function installIntegration(workspaceRoot, payload = {}, options = {}) {
  const appRoot = options.appRoot || APP_ROOT;
  const targetRoot = normalizeRoot(workspaceRoot);
  if (!targetRoot) {
    throw new Error('A real workspace root is required before installing an integration scaffold.');
  }
  const integrationId = String(payload.integrationId || payload.id || '').trim();
  if (!integrationId) {
    throw new Error('integrationId is required.');
  }
  const builtIn = listBuiltInIntegrations(appRoot);
  const selected = builtIn.find((entry) => entry.id === integrationId);
  if (!selected) {
    throw new Error(`Unknown integration scaffold: ${integrationId}.`);
  }
  const integrationsRoot = installedIntegrationsRoot(targetRoot);
  const targetDir = path.join(integrationsRoot, KIND_DIRS[selected.kind], selected.id);
  if (fs.existsSync(targetDir) && payload.force !== true) {
    return {
      ok: true,
      installed: false,
      alreadyInstalled: true,
      integration: {
        ...selected,
        installed: true,
        installedPath: targetDir,
      },
      studio: buildIntegrationStudioStatus(targetRoot, { appRoot }),
    };
  }
  ensureDirectory(path.dirname(targetDir));
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  fs.cpSync(selected.rootPath, targetDir, { recursive: true, force: true });
  const manifest = {
    ...(readJsonFile(path.join(targetDir, MANIFEST_FILE), {}) || {}),
    installedAt: nowIso(),
    source: 'builtin',
    sourceRoot: selected.rootPath,
  };
  writeJsonFileAtomic(path.join(targetDir, MANIFEST_FILE), manifest);
  return {
    ok: true,
    installed: true,
    integration: {
      ...selected,
      installed: true,
      installedPath: targetDir,
    },
    studio: buildIntegrationStudioStatus(targetRoot, { appRoot }),
  };
}

module.exports = {
  KIND_DIRS,
  LIBRARY_DIR,
  USER_DIR,
  buildIntegrationStudioStatus,
  builtInLibraryRoot,
  installIntegration,
  listBuiltInIntegrations,
  listInstalledIntegrations,
};
