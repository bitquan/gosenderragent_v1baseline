'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function clipText(value, maxLength = 180) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    return '';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}…` : text;
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

function resolveVsCodeCompanionRoot(workspaceRoot) {
  const root = String(workspaceRoot || '').trim();
  if (!root) {
    return '';
  }
  const candidates = [
    path.join(root, 'integration-library', 'extensions', 'vscode-companion'),
    path.join(root, 'tools', 'vscode-dev-assistant-extension'),
    path.join(root, 'vscode-dev-assistant-extension'),
    root,
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

function readPackageScripts(workspaceRoot) {
  const packagePath = path.join(workspaceRoot, 'package.json');
  if (!fs.existsSync(packagePath)) {
    return {};
  }
  const pkg = readJson(packagePath);
  return pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
}

function resolveVsCodeCliCommand(options = {}) {
  if (options && Object.prototype.hasOwnProperty.call(options, 'cliCommand')) {
    return String(options.cliCommand || '').trim();
  }
  const validateCandidate = (candidate) => {
    const text = String(candidate || '').trim();
    if (!text) {
      return false;
    }
    const args = ['--version'];
    const command = /\.cmd$|\.bat$/i.test(text) ? 'cmd.exe' : text;
    const commandArgs = command === 'cmd.exe' ? ['/d', '/c', text, ...args] : args;
    try {
      const result = spawnSync(command, commandArgs, {
        encoding: 'utf8',
        stdio: 'pipe',
        windowsHide: true,
      });
      return Boolean(result && result.status === 0);
    } catch (_error) {
      return false;
    }
  };
  const rawCandidates = process.platform === 'win32'
    ? [
      'code.cmd',
      'code',
      'code-insiders.cmd',
      'code-insiders',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'),
      path.join('E:\\Coding\\Microsoft VS Code\\bin', 'code.cmd'),
      path.join('E:\\Coding\\Microsoft VS Code Insiders\\bin', 'code-insiders.cmd'),
    ]
    : ['code', 'code-insiders'];
  const candidates = [];
  const seen = new Set();
  const pushCandidate = (value) => {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) {
      return;
    }
    seen.add(text);
    candidates.push(text);
  };
  rawCandidates.forEach(pushCandidate);
  if (process.platform === 'win32') {
    for (const candidate of rawCandidates) {
      const text = String(candidate || '').trim();
      if (!text || text.includes(path.sep)) {
        continue;
      }
      try {
        const lookup = spawnSync('where.exe', [text], {
          encoding: 'utf8',
          stdio: 'pipe',
          windowsHide: true,
        });
        if (lookup && lookup.status === 0) {
          String(lookup.stdout || '')
            .split(/\r?\n/)
            .map((entry) => entry.trim())
            .filter(Boolean)
            .forEach(pushCandidate);
        }
      } catch (_error) {
        // keep scanning fallback locations
      }
    }
  }
  for (const candidate of candidates) {
    if (validateCandidate(candidate)) {
      return candidate;
    }
  }
  return '';
}

function resolveVsCodeExtensionsRoot(options = {}) {
  const configured = String(
    options.extensionsRoot
    || process.env.VSCODE_EXTENSIONS_DIR
    || path.join(os.homedir(), '.vscode', 'extensions'),
  ).trim();
  return configured ? path.resolve(configured) : '';
}

function readInstalledCompanion(workspaceRoot, options = {}) {
  const companionExtensionRoot = resolveVsCodeCompanionRoot(workspaceRoot);
  const extensionsRoot = resolveVsCodeExtensionsRoot(options);
  const cliCommand = resolveVsCodeCliCommand(options);
  if (!companionExtensionRoot) {
    return {
      available: false,
      installed: false,
      cliCommand,
      extensionsRoot,
      packageName: '',
      version: '',
      installRoot: '',
      installs: [],
    };
  }
  const pkg = readJson(path.join(companionExtensionRoot, 'package.json')) || {};
  const packageName = String(pkg.name || '').trim();
  const version = String(pkg.version || '').trim();
  const installs = !extensionsRoot || !fs.existsSync(extensionsRoot)
    ? []
    : fs.readdirSync(extensionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(extensionsRoot, entry.name))
      .map((installRoot) => ({
        installRoot,
        pkg: readJson(path.join(installRoot, 'package.json')) || {},
      }))
      .filter((entry) => String(entry.pkg.name || '').trim() === packageName)
      .map((entry) => ({
        installRoot: entry.installRoot,
        version: String(entry.pkg.version || '').trim(),
        packageName: String(entry.pkg.name || '').trim(),
      }));
  const preferredInstall = installs.find((entry) => entry.version === version) || installs[0] || null;
  return {
    available: true,
    installed: installs.length > 0,
    cliCommand,
    extensionsRoot,
    packageName,
    version,
    installRoot: String(preferredInstall?.installRoot || '').trim(),
    installs,
  };
}

function installVsCodeCompanion(workspaceRoot, options = {}) {
  const companionExtensionRoot = resolveVsCodeCompanionRoot(workspaceRoot);
  if (!companionExtensionRoot) {
    return { ok: false, message: 'No VS Code companion package was found in this workspace.' };
  }
  const pkg = readJson(path.join(companionExtensionRoot, 'package.json')) || {};
  const packageName = String(pkg.name || '').trim() || 'gosenderr-vscode-companion';
  const version = String(pkg.version || '').trim() || 'dev';
  const extensionsRoot = resolveVsCodeExtensionsRoot(options);
  if (!extensionsRoot) {
    return { ok: false, message: 'VS Code extensions root is not available on this machine.' };
  }
  fs.mkdirSync(extensionsRoot, { recursive: true });
  const installFolderName = `${packageName}-${version}`;
  const installRoot = path.join(extensionsRoot, installFolderName);
  const installedState = readInstalledCompanion(workspaceRoot, options);
  installedState.installs
    .map((entry) => String(entry.installRoot || '').trim())
    .filter((entry) => entry && entry !== installRoot)
    .forEach((entry) => {
      if (entry.startsWith(extensionsRoot)) {
        fs.rmSync(entry, { recursive: true, force: true });
      }
    });
  fs.rmSync(installRoot, { recursive: true, force: true });
  fs.cpSync(companionExtensionRoot, installRoot, { recursive: true, force: true });
  return {
    ok: true,
    workspaceRoot,
    installRoot,
    extensionsRoot,
    cliCommand: resolveVsCodeCliCommand(options),
    message: `VS Code companion installed to ${installRoot}. Restart or reload VS Code if it is already open.`,
    status: buildVsCodeSetupStatus(workspaceRoot, options),
  };
}

function detectCapabilities(workspaceRoot) {
  const scripts = readPackageScripts(workspaceRoot);
  const fileExists = (relativePath) => fs.existsSync(path.join(workspaceRoot, relativePath));
  const companionExtensionRoot = resolveVsCodeCompanionRoot(workspaceRoot);
  return {
    scripts,
    hasPackageJson: fs.existsSync(path.join(workspaceRoot, 'package.json')),
    hasTsconfig: fileExists('tsconfig.json'),
    hasPyproject: fileExists('pyproject.toml'),
    hasRequirements: fileExists('requirements.txt'),
    hasElectronMain: fileExists('main.js') || fileExists('electron/main.js'),
    hasExtensionEntry: !!companionExtensionRoot,
    companionExtensionRoot,
    legacyExtensionRoots: listLegacyExtensionRoots(workspaceRoot, companionExtensionRoot),
    hasTests: Object.keys(scripts).some((name) => /test|smoke|lint|typecheck/i.test(name)),
  };
}

function buildRecommendedExtensions(capabilities = {}) {
  const recommendations = [
    'dbaeumer.vscode-eslint',
    'eamodio.gitlens',
    'esbenp.prettier-vscode',
    'github.copilot',
    'yzhang.markdown-all-in-one',
  ];
  if (capabilities.hasTsconfig || capabilities.hasPackageJson) {
    recommendations.push('ms-vscode.vscode-typescript-next');
  }
  if (capabilities.hasPyproject || capabilities.hasRequirements) {
    recommendations.push('ms-python.python');
  }
  if (capabilities.hasExtensionEntry) {
    recommendations.push('ms-vscode.extension-test-runner');
  }
  if (capabilities.hasElectronMain) {
    recommendations.push('ms-vscode.js-debug-nightly');
  }
  return Array.from(new Set(recommendations));
}

function buildSuggestedTasks(capabilities = {}) {
  const scripts = capabilities.scripts || {};
  const tasks = [];
  const pushScriptTask = (scriptName, label) => {
    if (!scripts[scriptName]) {
      return;
    }
    tasks.push({
      label,
      type: 'shell',
      command: 'npm',
      args: ['run', scriptName],
      group: scriptName === 'test' ? 'test' : 'build',
      problemMatcher: [],
    });
  };

  pushScriptTask('typecheck', 'Desktop Agent: Typecheck');
  pushScriptTask('test', 'Desktop Agent: Test');
  pushScriptTask('smoke', 'Desktop Agent: Smoke');
  pushScriptTask('smoke:ui', 'Desktop Agent: UI Smoke');
  pushScriptTask('engine:acceptance', 'Desktop Agent: Engine Acceptance');

  if (tasks.length === 0 && capabilities.hasPackageJson) {
    tasks.push({
      label: 'Desktop Agent: npm test',
      type: 'shell',
      command: 'npm',
      args: ['test'],
      group: 'test',
      problemMatcher: [],
    });
  }
  return tasks;
}

function buildSuggestedSettings(capabilities = {}) {
  const filesExclude = {
    '**/.assistant_sandboxes': true,
    '**/node_modules': true,
    '**/dist': true,
    '**/out': true,
  };
  const searchExclude = {
    '**/node_modules': true,
    '**/.assistant_sandboxes': true,
    '**/dist': true,
  };
  return {
    'editor.formatOnSave': true,
    'files.trimTrailingWhitespace': true,
    'files.exclude': filesExclude,
    'search.exclude': searchExclude,
    'typescript.tsserver.maxTsServerMemory': 4096,
    ...(capabilities.hasPyproject || capabilities.hasRequirements
      ? { 'python.terminal.activateEnvironment': true }
      : {}),
  };
}

function mergeArray(existing, additions) {
  return Array.from(new Set([...(Array.isArray(existing) ? existing : []), ...additions]));
}

function mergeObject(existing, additions) {
  return {
    ...(existing && typeof existing === 'object' ? existing : {}),
    ...(additions && typeof additions === 'object' ? additions : {}),
  };
}

function buildVsCodeSetupStatus(workspaceRoot, options = {}) {
  const root = String(workspaceRoot || '').trim();
  if (!root) {
    return {
      ok: false,
      exists: false,
      summary: 'Workspace root is not configured.',
      workspaceRoot: '',
      vscodeDir: '',
      files: {},
      recommendations: [],
      suggestedTasks: [],
    };
  }
  const capabilities = detectCapabilities(root);
  const recommendations = buildRecommendedExtensions(capabilities);
  const suggestedTasks = buildSuggestedTasks(capabilities);
  const suggestedSettings = buildSuggestedSettings(capabilities);
  const companionInstall = readInstalledCompanion(root, options);
  const vscodeDir = path.join(root, '.vscode');
  const files = {
    extensions: path.join(vscodeDir, 'extensions.json'),
    settings: path.join(vscodeDir, 'settings.json'),
    tasks: path.join(vscodeDir, 'tasks.json'),
  };
  const existingExtensions = readJson(files.extensions);
  const existingSettings = readJson(files.settings);
  const existingTasks = readJson(files.tasks);
  const missingFiles = Object.entries(files)
    .filter(([, filePath]) => !fs.existsSync(filePath))
    .map(([key]) => key);
  const configuredRecommendations = Array.isArray(existingExtensions?.recommendations) ? existingExtensions.recommendations : [];
  const configuredTaskLabels = Array.isArray(existingTasks?.tasks)
    ? existingTasks.tasks.map((item) => String(item?.label || '').trim()).filter(Boolean)
    : [];
  const missingRecommendations = recommendations.filter((item) => !configuredRecommendations.includes(item));
  const missingTaskLabels = suggestedTasks
    .map((task) => String(task.label || '').trim())
    .filter((label) => !configuredTaskLabels.includes(label));
  return {
    ok: true,
    exists: true,
    workspaceRoot: root,
    vscodeDir,
    capabilities,
    companionExtensionRoot: String(capabilities.companionExtensionRoot || '').trim(),
    legacyExtensionRoots: Array.isArray(capabilities.legacyExtensionRoots) ? capabilities.legacyExtensionRoots : [],
    files: {
      extensions: { path: files.extensions, exists: fs.existsSync(files.extensions) },
      settings: { path: files.settings, exists: fs.existsSync(files.settings) },
      tasks: { path: files.tasks, exists: fs.existsSync(files.tasks) },
    },
    recommendations,
    suggestedTasks,
    suggestedSettings,
    companionInstall,
    missingFiles,
    missingRecommendations,
    missingTaskLabels,
    summary: missingFiles.length > 0 || missingRecommendations.length > 0 || missingTaskLabels.length > 0
      ? clipText(`VS Code setup can be improved. Missing files: ${missingFiles.join(', ') || 'none'} • missing recommendations: ${missingRecommendations.length} • missing tasks: ${missingTaskLabels.length}.`)
      : companionInstall.available && !companionInstall.installed
        ? 'VS Code workspace files are ready, but the GoSenderr companion is not installed yet.'
        : 'VS Code workspace setup is ready.',
  };
}

function bootstrapVsCodeWorkspace(workspaceRoot) {
  const status = buildVsCodeSetupStatus(workspaceRoot);
  if (!status.ok || !status.exists) {
    return { ok: false, message: status.summary || 'Workspace root is not configured.' };
  }
  const extensionsPath = status.files.extensions.path;
  const settingsPath = status.files.settings.path;
  const tasksPath = status.files.tasks.path;
  const existingExtensions = readJson(extensionsPath) || {};
  const existingSettings = readJson(settingsPath) || {};
  const existingTasks = readJson(tasksPath) || {};
  const mergedExtensions = {
    recommendations: mergeArray(existingExtensions.recommendations, status.recommendations),
    unwantedRecommendations: Array.isArray(existingExtensions.unwantedRecommendations) ? existingExtensions.unwantedRecommendations : [],
  };
  const mergedSettings = mergeObject(existingSettings, status.suggestedSettings);
  const currentTasks = Array.isArray(existingTasks.tasks) ? existingTasks.tasks : [];
  const suggestedTaskMap = new Map(status.suggestedTasks.map((task) => [String(task.label || '').trim(), task]));
  currentTasks.forEach((task) => {
    const label = String(task?.label || '').trim();
    if (label && suggestedTaskMap.has(label)) {
      suggestedTaskMap.set(label, task);
    }
  });
  const mergedTasks = {
    version: existingTasks.version || '2.0.0',
    tasks: Array.from(suggestedTaskMap.values()),
  };
  writeJson(extensionsPath, mergedExtensions);
  writeJson(settingsPath, mergedSettings);
  writeJson(tasksPath, mergedTasks);
  return {
    ok: true,
    workspaceRoot,
    message: 'VS Code workspace files are ready.',
    status: buildVsCodeSetupStatus(workspaceRoot),
  };
}

module.exports = {
  bootstrapVsCodeWorkspace,
  buildVsCodeSetupStatus,
  installVsCodeCompanion,
  resolveVsCodeCompanionRoot,
};
