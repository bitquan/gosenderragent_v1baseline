'use strict';

const fs = require('fs');
const path = require('path');

function clipText(value, maxLength = 180) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}…` : text;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_error) {
    return '';
  }
}

function isRetiredLegacyDesktopRoot(targetRoot) {
  const root = String(targetRoot || '').trim();
  if (!root || !fs.existsSync(root)) {
    return false;
  }
  try {
    const entries = fs.readdirSync(root).filter((entry) => entry !== '.DS_Store');
    return entries.length > 0 && entries.every((entry) => entry === 'README.md');
  } catch (_error) {
    return false;
  }
}

function hasExtensionPackage(targetRoot) {
  const root = String(targetRoot || '').trim();
  if (!root) {
    return false;
  }
  const packagePath = path.join(root, 'package.json');
  if (!fs.existsSync(packagePath)) {
    return false;
  }
  const pkg = readJson(packagePath) || {};
  const contributes = pkg.contributes && typeof pkg.contributes === 'object' ? pkg.contributes : {};
  const engines = pkg.engines && typeof pkg.engines === 'object' ? pkg.engines : {};
  return Boolean(
    fs.existsSync(path.join(root, 'src', 'extension.ts'))
    || fs.existsSync(path.join(root, 'extension.js'))
    || fs.existsSync(path.join(root, String(pkg.main || '').replace(/^\.\//, '')))
    || Array.isArray(contributes.commands)
    || engines.vscode
  );
}

function resolveExtensionRoot(workspaceRoot) {
  const root = String(workspaceRoot || '').trim();
  if (!root) {
    return '';
  }
  const candidates = [
    path.join(root, 'integration-library', 'extensions', 'vscode-companion'),
    path.join(root, 'tools', 'vscode-dev-assistant-extension'),
    path.join(root, 'vscode-dev-assistant-extension'),
  ];
  return candidates.find((candidate) => hasExtensionPackage(candidate)) || '';
}

function listLegacyExtensionRoots(workspaceRoot, activeRoot = '') {
  const root = String(workspaceRoot || '').trim();
  if (!root) {
    return [];
  }
  const resolvedActiveRoot = String(activeRoot || '').trim();
  return [
    path.join(root, 'tools', 'vscode-dev-assistant-extension'),
    path.join(root, 'vscode-dev-assistant-extension'),
  ].filter((candidate) => candidate !== resolvedActiveRoot && hasExtensionPackage(candidate));
}

function looksStubCompanion(extensionRoot, pkg = {}) {
  const commandList = Array.isArray(pkg?.contributes?.commands) ? pkg.contributes.commands : [];
  const mainEntry = String(pkg?.main || './extension.js').replace(/^\.\//, '');
  const source = [
    readText(path.join(extensionRoot, mainEntry)),
    readText(path.join(extensionRoot, 'src', 'extension.ts')),
  ].join('\n');
  return (
    commandList.length === 1
    && String(commandList[0]?.command || '').trim() === 'gosenderr.openDesktopAgent'
    && /showInformationMessage\(/.test(source)
  );
}

function readCompanionVersionMetadata(extensionRoot) {
  const root = String(extensionRoot || '').trim();
  if (!root) {
    return {
      packageVersion: '',
      integrationVersion: '',
      metadataVersionMismatch: false,
    };
  }
  const pkg = readJson(path.join(root, 'package.json')) || {};
  const integration = readJson(path.join(root, 'integration.json')) || {};
  const packageVersion = String(pkg.version || '').trim();
  const integrationVersion = String(integration.version || '').trim();
  return {
    packageVersion,
    integrationVersion,
    metadataVersionMismatch: Boolean(packageVersion && integrationVersion && packageVersion !== integrationVersion),
  };
}

function buildVsCodeExtensionHealth(workspaceRoot) {
  const root = String(workspaceRoot || '').trim();
  if (!root) {
    return {
      ok: false,
      exists: false,
      summary: 'Workspace root is not configured.',
      workspaceRoot: '',
      extensionRoot: '',
      warnings: [],
      nextStep: 'Pick a workspace before checking extension health.',
    };
  }

  const extensionRoot = resolveExtensionRoot(root);
  if (!extensionRoot) {
    return {
      ok: true,
      exists: false,
      summary: 'No VS Code extension was detected in this workspace.',
      workspaceRoot: root,
      extensionRoot: '',
      warnings: [],
      nextStep: 'Create or connect a VS Code extension only if this workspace still needs one.',
    };
  }

  const pkg = readJson(path.join(extensionRoot, 'package.json')) || {};
  const contributes = pkg.contributes && typeof pkg.contributes === 'object' ? pkg.contributes : {};
  const commands = Array.isArray(contributes.commands) ? contributes.commands : [];
  const configuration = contributes.configuration && typeof contributes.configuration === 'object' ? contributes.configuration : {};
  const properties = configuration.properties && typeof configuration.properties === 'object' ? configuration.properties : {};
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const warnings = [];
  const legacyExtensionRoots = listLegacyExtensionRoots(root, extensionRoot);
  const legacyDesktopRoot = path.join(root, 'tools', 'gosenderr-desktop-agent');
  const expectedMain = path.join(extensionRoot, String(pkg.main || './extension.js').replace(/^\.\//, ''));
  const versionMetadata = readCompanionVersionMetadata(extensionRoot);

  if (!fs.existsSync(expectedMain)) {
    warnings.push('Extension build output is missing.');
  }
  if (Object.keys(scripts).length === 0) {
    warnings.push('Extension package has no scripts, so validation and packaging are harder to repeat.');
  }
  if (looksStubCompanion(extensionRoot, pkg)) {
    warnings.push('VS Code companion is still a stub and does not expose the shared dev-engine flow yet.');
  }
  if (versionMetadata.metadataVersionMismatch) {
    warnings.push('Companion integration metadata version does not match the extension package version.');
  }
  if (legacyExtensionRoots.length > 0) {
    warnings.push('Legacy VS Code extension copies still exist beside the real companion path. Treat them as compatibility drift.');
  }
  if (fs.existsSync(legacyDesktopRoot) && !isRetiredLegacyDesktopRoot(legacyDesktopRoot)) {
    warnings.push('Legacy in-repo desktop copy still exists beside the extension. Retire it to reduce drift.');
  }

  const status = warnings.length === 0 ? 'ready' : 'needs-attention';
  return {
    ok: true,
    exists: true,
    status,
    workspaceRoot: root,
    extensionRoot,
    legacyExtensionRoots,
    packageName: String(pkg.name || '').trim(),
    displayName: String(pkg.displayName || pkg.name || 'VS Code extension').trim(),
    version: String(pkg.version || '').trim(),
    integrationVersion: versionMetadata.integrationVersion,
    metadataVersionMismatch: versionMetadata.metadataVersionMismatch,
    commandCount: commands.length,
    settingCount: Object.keys(properties).length,
    scriptCount: Object.keys(scripts).length,
    warnings,
    nextStep: warnings.length === 0
      ? 'Keep the extension aligned with the desktop contracts as you tune the engine.'
      : 'Use the extension health warnings to clean up drift before trusting desktop and VS Code behavior together.',
    summary: warnings.length === 0
      ? clipText(`${String(pkg.displayName || pkg.name || 'VS Code extension').trim()} is aligned enough for the current desktop baseline.`)
      : clipText(`${warnings.length} extension health warning(s) need attention before the desktop app and VS Code path are fully aligned.`),
  };
}

module.exports = {
  buildVsCodeExtensionHealth,
  listLegacyExtensionRoots,
  resolveExtensionRoot,
};
