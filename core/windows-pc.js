'use strict';

const path = require('path');
const {
  buildModelInstallPresets,
  getHardwareTargetPreset,
  normalizeTrainingTuningSettings,
} = require('./training-tuning');

const DEFAULT_WINDOWS_PC_VOLUME = '/Volumes/projects';
const DEFAULT_WINDOWS_PC_FOLDER = 'gosenderr-desktop-agent-PC';

function normalizePath(value) {
  return String(value || '').trim();
}

function defaultWindowsPcCloneRoot() {
  return path.posix.join(DEFAULT_WINDOWS_PC_VOLUME, DEFAULT_WINDOWS_PC_FOLDER);
}

function resolveWindowsPcCloneRoot(explicitRoot = '') {
  const normalized = normalizePath(explicitRoot);
  if (!normalized) {
    return defaultWindowsPcCloneRoot();
  }
  if (/^[A-Za-z]:[\\/]/.test(normalized) || normalized.startsWith('\\\\')) {
    return path.win32.normalize(normalized);
  }
  return normalized.startsWith('/')
    ? path.posix.normalize(normalized)
    : path.posix.normalize(path.posix.join(DEFAULT_WINDOWS_PC_VOLUME, normalized.replace(/\\/g, '/')));
}

function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function buildWindowsPcPackage(basePackage = {}) {
  const next = JSON.parse(JSON.stringify(basePackage && typeof basePackage === 'object' ? basePackage : {}));
  next.name = 'gosenderr-desktop-agent-pc';
  next.productName = 'GoSenderr Desktop Agent PC';
  next.description = 'Windows-ready sibling of the standalone GoSenderr Desktop Agent.';
  next.build = next.build && typeof next.build === 'object' ? next.build : {};
  next.build.appId = 'com.gosenderr.desktop.agent.pc';
  return next;
}

function buildWindowsExtensionsJson() {
  return stringifyJson({
    recommendations: [
      'ms-vscode.powershell',
      'ms-python.python',
      'eamodio.gitlens',
    ],
  });
}

function buildWindowsSettingsJson() {
  return stringifyJson({
    'terminal.integrated.defaultProfile.windows': 'PowerShell',
    'files.eol': '\n',
    'editor.formatOnSave': false,
  });
}

function buildWindowsTasksJson() {
  return stringifyJson({
    version: '2.0.0',
    tasks: [
      {
        label: 'Desktop Agent PC: Bootstrap',
        type: 'shell',
        command: 'powershell',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '${workspaceFolder}\\scripts\\windows\\bootstrap.ps1'],
        problemMatcher: [],
      },
      {
        label: 'Desktop Agent PC: Validate',
        type: 'shell',
        command: 'powershell',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '${workspaceFolder}\\scripts\\windows\\validate.ps1'],
        problemMatcher: [],
      },
      {
        label: 'Desktop Agent PC: Start Dev',
        type: 'shell',
        command: 'powershell',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '${workspaceFolder}\\scripts\\windows\\dev.ps1'],
        problemMatcher: [],
      },
      {
        label: 'Desktop Agent PC: Package Win',
        type: 'shell',
        command: 'powershell',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '${workspaceFolder}\\scripts\\windows\\package.ps1'],
        problemMatcher: [],
      },
      {
        label: 'Desktop Agent PC: Install recommended models',
        type: 'shell',
        command: 'powershell',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '${workspaceFolder}\\scripts\\windows\\install-models.ps1'],
        problemMatcher: [],
      },
    ],
  });
}

function buildWindowsLaunchJson() {
  return stringifyJson({
    version: '0.2.0',
    configurations: [
      {
        name: 'GoSenderr Desktop Agent PC',
        type: 'node',
        request: 'launch',
        cwd: '${workspaceFolder}',
        runtimeExecutable: '${workspaceFolder}\\node_modules\\.bin\\electron.cmd',
        args: ['.'],
        console: 'integratedTerminal',
        windows: {
          runtimeExecutable: '${workspaceFolder}\\node_modules\\.bin\\electron.cmd',
        },
      },
    ],
  });
}

function buildPowerShellScript(commandLines = []) {
  return [
    '$ErrorActionPreference = "Stop"',
    '$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\\..")',
    'Set-Location $projectRoot',
    'Write-Host "[gosenderr-pc] project = $projectRoot"',
    ...commandLines,
    '',
  ].join('\n');
}

function buildCmdWrapper(psScriptName) {
  return [
    '@echo off',
    'setlocal',
    `powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0${psScriptName}" %*`,
    '',
  ].join('\r\n');
}

function buildWindowsGuide(targetRoot) {
  const cloneRoot = normalizePath(targetRoot) || defaultWindowsPcCloneRoot();
  const hardwarePreset = getHardwareTargetPreset('windows-i9-32gb-rtx4060-8gb');
  return `# GoSenderr Desktop Agent PC

This is the Windows-ready sibling bundle for the standalone desktop agent.

## Default clone path

\`${cloneRoot}\`

Copy this folder from the external SSD onto the Windows machine before you run installs or builds.

## Recommended tools on Windows

- Git
- Node.js 20+
- PowerShell 7+
- Python 3.11+
- VS Code
- Ollama (recommended for local models)

## Recommended hardware target

- ${hardwarePreset.label}
- ${hardwarePreset.summary}
- Start with \`qwen2.5-coder:7b\` as the normal local baseline, then move to \`qwen2.5-coder:14b\` only when a specific proof slice shows the heavier lane is worth the extra headroom.

## Fast start in PowerShell

\`\`\`powershell
Set-Location .\\gosenderr-desktop-agent-PC
powershell -ExecutionPolicy Bypass -File .\\scripts\\windows\\bootstrap.ps1
\`\`\`

## Fast start in Command Prompt

\`\`\`bat
cd /d D:\\gosenderr-desktop-agent-PC
call scripts\\windows\\bootstrap.cmd
\`\`\`

## Core commands

PowerShell:

\`\`\`powershell
npm test
npm run typecheck
npm run smoke
npm run engine:acceptance
npm run dist:win:x64
\`\`\`

Command Prompt:

\`\`\`bat
npm test
npm run typecheck
npm run smoke
npm run engine:acceptance
npm run dist:win:x64
\`\`\`

## VS Code

Open the folder in VS Code and use:

- \`Desktop Agent PC: Bootstrap\`
- \`Desktop Agent PC: Validate\`
- \`Desktop Agent PC: Start Dev\`
- \`Desktop Agent PC: Package Win\`
- \`Desktop Agent PC: Install recommended models\`

The bundle ships with:

- recommended extensions
- Windows launch config
- Windows tasks

## Important note

This PC bundle is meant to start from a known-good desktop baseline. Run validation on Windows before trusting self-improvement or promotion work there.
`;
}

function buildWindowsConfigExample() {
  return [
    '# Windows PC tuning template for GoSenderr Desktop Agent PC',
    'assistant_training_hardware_target: windows-i9-32gb-rtx4060-8gb',
    'assistant_training_profile: high',
    'assistant_training_eco_mode: false',
    'assistant_training_cpu_limit_percent: 70',
    'assistant_training_thread_limit: 8',
    'assistant_training_thermal_preset: 85',
    'assistant_training_live_sampling_sec: 3',
    'assistant_training_ollama_model: qwen2.5-coder:7b',
    '',
    '# Update this path after copying the bundle onto Windows.',
    '# assistant_training_model_storage_root: D:/gosenderr-models',
    '',
  ].join('\n');
}

function buildWindowsAppReadme() {
  return `# Windows app bundle

This folder is where packaged Windows installers and unpacked validation builds will be copied when they exist.

If there is no \`.exe\` or \`.msi\` here yet, run the source bundle first:

\`\`\`powershell
powershell -ExecutionPolicy Bypass -File .\\scripts\\windows\\bootstrap.ps1
powershell -ExecutionPolicy Bypass -File .\\scripts\\windows\\dev.ps1
\`\`\`

Then package a Windows build on the PC with:

\`\`\`powershell
powershell -ExecutionPolicy Bypass -File .\\scripts\\windows\\package.ps1
\`\`\`

For the current target machine, the default packaging path is the x64 build for an i9 / 32 GB Windows PC.
`;
}

function buildWindowsPcFiles(options = {}) {
  const sourceRoot = normalizePath(options.sourceRoot) || path.resolve(__dirname, '..');
  const targetRoot = resolveWindowsPcCloneRoot(options.targetRoot);
  const installPresets = buildModelInstallPresets(sourceRoot, normalizeTrainingTuningSettings({
    trainingHardwareTarget: 'windows-i9-32gb-rtx4060-8gb',
  }));
  const installCommands = installPresets
    .filter((preset) => preset.hardwareRecommended && preset.downloadCommand)
    .slice(0, 4)
    .map((preset) => {
      const followup = preset.ollamaPullCommand
        ? ''
        : '\nWrite-Host "[gosenderr-pc] staged for import via Settings -> AI -> Import all stored models"';
      return `Write-Host "[gosenderr-pc] ${String(preset.label || '')}"\n${String(preset.downloadCommand || '')}${followup}`;
    });

  return {
    '.vscode/extensions.json': buildWindowsExtensionsJson(),
    '.vscode/settings.json': buildWindowsSettingsJson(),
    '.vscode/tasks.json': buildWindowsTasksJson(),
    '.vscode/launch.json': buildWindowsLaunchJson(),
    'scripts/windows/bootstrap.ps1': buildPowerShellScript([
      'npm install',
      'Write-Host "[gosenderr-pc] bootstrap complete. Next: npm test ; npm run typecheck ; npm run smoke"',
    ]),
    'scripts/windows/validate.ps1': buildPowerShellScript([
      'npm test',
      'npm run typecheck',
      'npm run smoke',
      'npm run engine:acceptance',
    ]),
    'scripts/windows/dev.ps1': buildPowerShellScript([
      'npm run dev',
    ]),
    'scripts/windows/package.ps1': buildPowerShellScript([
      'npm run dist:win:x64',
    ]),
    'scripts/windows/install-models.ps1': buildPowerShellScript(
      installCommands.length > 0
        ? installCommands
        : ['Write-Host "[gosenderr-pc] No curated model install commands are available yet."'],
    ),
    'scripts/windows/bootstrap.cmd': buildCmdWrapper('bootstrap.ps1'),
    'scripts/windows/validate.cmd': buildCmdWrapper('validate.ps1'),
    'scripts/windows/dev.cmd': buildCmdWrapper('dev.ps1'),
    'scripts/windows/package.cmd': buildCmdWrapper('package.ps1'),
    'scripts/windows/install-models.cmd': buildCmdWrapper('install-models.ps1'),
    'dev_assistant.local.yaml.example': buildWindowsConfigExample(),
    'WINDOWS_HOW_TO/README.md': buildWindowsGuide(targetRoot),
    'WINDOWS_APP/README.md': buildWindowsAppReadme(),
    'windows-pc.clone.json': stringifyJson({
      generatedFrom: sourceRoot,
      targetRoot,
      productName: 'GoSenderr Desktop Agent PC',
      generatedAt: new Date().toISOString(),
      hardwareTarget: 'windows-i9-32gb-rtx4060-8gb',
    }),
  };
}

module.exports = {
  buildWindowsPcFiles,
  buildWindowsPcPackage,
  defaultWindowsPcCloneRoot,
  resolveWindowsPcCloneRoot,
};
