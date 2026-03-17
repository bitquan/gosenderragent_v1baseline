#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { resolveTargetWorkspaceRoot } = require('../core/app-roots');
const { getConfiguredAssistantDesktopBuildDir } = require('../core/assistant-paths');
const {
  buildWindowsPcFiles,
  buildWindowsPcPackage,
  resolveWindowsPcCloneRoot,
} = require('../core/windows-pc');

const APP_ROOT = path.resolve(__dirname, '..');
const targetRoot = resolveWindowsPcCloneRoot(process.argv[2] || process.env.GOSENDERR_WINDOWS_PC_ROOT);

const SKIP_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.next',
  '.cache',
  '.turbo',
  'artifacts',
  'scorecards',
]);

function nowStamp() {
  const value = new Date();
  const pad = (input) => String(input).padStart(2, '0');
  return `${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}-${pad(value.getHours())}${pad(value.getMinutes())}${pad(value.getSeconds())}`;
}

function shouldCopy(sourcePath) {
  const relative = path.relative(APP_ROOT, sourcePath);
  if (!relative) {
    return true;
  }
  const normalized = relative.split(path.sep);
  if (normalized.some((segment) => SKIP_SEGMENTS.has(segment))) {
    return false;
  }
  if (normalized.includes('__pycache__')) {
    return false;
  }
  const basename = path.basename(sourcePath);
  if (basename === '.DS_Store' || basename === 'dev_assistant.db') {
    return false;
  }
  if (/\.(pyc|pyo|log)$/i.test(basename)) {
    return false;
  }
  if (relative.startsWith('.git') && !relative.startsWith('.git/HEAD') && !relative.startsWith('.git/config') && !relative.startsWith('.git/refs') && !relative.startsWith('.git/objects') && !relative.startsWith('.git/info') && !relative.startsWith('.git/hooks')) {
    return true;
  }
  return true;
}

function backupExistingTarget(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return '';
  }
  const backupPath = `${targetPath}.backup-${nowStamp()}`;
  fs.renameSync(targetPath, backupPath);
  return backupPath;
}

function copyWorkingTree(sourceRoot, destinationRoot) {
  fs.cpSync(sourceRoot, destinationRoot, {
    recursive: true,
    force: true,
    filter: (sourcePath) => shouldCopy(sourcePath),
  });
}

function writeTextFile(root, relativePath, contents) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
}

function copyWindowsArtifacts(root) {
  const workspaceRoot = resolveTargetWorkspaceRoot(process.env.DESKTOP_AGENT_TARGET_WORKSPACE);
  const distRoot = getConfiguredAssistantDesktopBuildDir(workspaceRoot) || path.join(APP_ROOT, 'dist');
  const targetDistRoot = path.join(root, 'WINDOWS_APP');
  const copied = [];
  if (!fs.existsSync(distRoot)) {
    return copied;
  }
  const queue = [distRoot];
  while (queue.length > 0) {
    const current = queue.shift();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (/^win-.*unpacked$/i.test(entry.name)) {
          const relative = path.relative(distRoot, fullPath);
          const destination = path.join(targetDistRoot, relative);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.cpSync(fullPath, destination, { recursive: true, force: true });
          copied.push(destination);
          continue;
        }
        queue.push(fullPath);
        continue;
      }
      if (!/\.(exe|msi|zip)$/i.test(entry.name)) {
        continue;
      }
      const relative = path.relative(distRoot, fullPath);
      const destination = path.join(targetDistRoot, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(fullPath, destination);
      copied.push(destination);
    }
  }
  return copied;
}

function patchPackageJson(root) {
  const packagePath = path.join(root, 'package.json');
  const current = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const next = buildWindowsPcPackage(current);
  fs.writeFileSync(packagePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function main() {
  const backupPath = backupExistingTarget(targetRoot);
  copyWorkingTree(APP_ROOT, targetRoot);
  patchPackageJson(targetRoot);

  const extraFiles = buildWindowsPcFiles({
    sourceRoot: APP_ROOT,
    targetRoot,
  });
  for (const [relativePath, contents] of Object.entries(extraFiles)) {
    writeTextFile(targetRoot, relativePath, contents);
  }
  const copiedWindowsArtifacts = copyWindowsArtifacts(targetRoot);

  const summary = {
    ok: true,
    targetRoot,
    backupPath,
    guidePath: path.join(targetRoot, 'WINDOWS_HOW_TO', 'README.md'),
    bootstrapPath: path.join(targetRoot, 'scripts', 'windows', 'bootstrap.ps1'),
    copiedWindowsArtifacts,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main();
