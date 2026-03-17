#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { resolveTargetWorkspaceRoot } = require('../core/app-roots');
const { getConfiguredAssistantDesktopBuildDir } = require('../core/assistant-paths');

const appRoot = path.resolve(__dirname, '..');
const workspaceRoot = resolveTargetWorkspaceRoot(process.env.DESKTOP_AGENT_TARGET_WORKSPACE);
const configuredOutputDir = getConfiguredAssistantDesktopBuildDir(workspaceRoot);
const electronBuilderBin = path.join(appRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');

const args = process.argv.slice(2);
const explicitOutputArg = args.find((arg) => /^-c\.directories\.output=/.test(String(arg || '')));
const outputDir = explicitOutputArg
  ? String(explicitOutputArg).replace(/^-c\.directories\.output=/, '')
  : (configuredOutputDir || path.join(appRoot, 'dist'));
if (configuredOutputDir && !explicitOutputArg) {
  args.push(`-c.directories.output=${configuredOutputDir}`);
}

if (
  process.platform === 'win32'
  && args.includes('--win')
  && !args.some((arg) => /^--config\.win\.signAndEditExecutable=/.test(String(arg || '')))
  && process.env.DESKTOP_AGENT_ENABLE_WIN_SIGN_EDIT !== '1'
) {
  args.push('--config.win.signAndEditExecutable=false');
}

function removePathRobustly(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return;
  }
  try {
    fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
    return;
  } catch (error) {
    if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(String(error?.code || ''))) {
      throw error;
    }
  }

  const stat = fs.statSync(targetPath, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    for (const name of fs.readdirSync(targetPath)) {
      removePathRobustly(path.join(targetPath, name));
    }
  }

  try {
    fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
    return;
  } catch (error) {
    if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(String(error?.code || ''))) {
      throw error;
    }
  }

  const renamedPath = `${targetPath}.stale-${Date.now()}`;
  fs.renameSync(targetPath, renamedPath);
  fs.rmSync(renamedPath, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
}

function printResult(result) {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

function runBuilder(currentArgs) {
  const env = { ...process.env };
  const isDirBuild = currentArgs.includes('--dir');
  if (isDirBuild && !Object.prototype.hasOwnProperty.call(env, 'CSC_IDENTITY_AUTO_DISCOVERY')) {
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  }
  return spawnSync(electronBuilderBin, currentArgs, {
    cwd: appRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32' && /\.cmd$/i.test(electronBuilderBin),
  });
}

function shouldRetryBuilder(result) {
  const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
  return /corrupted Electron dist/i.test(combined) || /ERR_ELECTRON_BUILDER_CANNOT_EXECUTE/i.test(combined);
}

function cleanOutputTargets(directory, currentArgs) {
  if (!directory || !fs.existsSync(directory)) {
    return;
  }
  const wantsMac = currentArgs.includes('--mac');
  const wantsWin = currentArgs.includes('--win');
  const wantsDir = currentArgs.includes('--dir');

  for (const name of fs.readdirSync(directory)) {
    const lower = name.toLowerCase();
    const fullPath = path.join(directory, name);
    const isDirectory = fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();

    if (isDirectory) {
      const shouldRemove = (wantsMac && lower.startsWith('mac'))
        || (wantsWin && lower.startsWith('win'))
        || (wantsDir && (lower.startsWith('mac') || lower.startsWith('win') || lower.startsWith('linux')));
      if (shouldRemove) {
        removePathRobustly(fullPath);
      }
      continue;
    }

    if (wantsMac && (lower.endsWith('.dmg') || lower.endsWith('.zip') || lower.endsWith('.blockmap'))) {
      removePathRobustly(fullPath);
      continue;
    }
    if (wantsWin && (lower.endsWith('.exe') || lower.endsWith('.msi') || lower.endsWith('.zip') || lower.endsWith('.blockmap'))) {
      removePathRobustly(fullPath);
    }
  }
}

cleanOutputTargets(outputDir, args);

let result = runBuilder(args);
printResult(result);

if ((result.status || 0) !== 0 && shouldRetryBuilder(result)) {
  process.stderr.write('[run-electron-builder] build failed with a recoverable Electron packaging error. Retrying once after cleaning output...\n');
  cleanOutputTargets(outputDir, args);
  result = runBuilder(args);
  printResult(result);
}

process.exit(result.status || 0);
