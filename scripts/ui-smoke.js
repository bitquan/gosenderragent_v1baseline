#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { runUiSmokeInWindow, logUiSmokeResult } = require('./ui-smoke-runner');

process.env.DESKTOP_AGENT_UI_SMOKE = process.env.DESKTOP_AGENT_UI_SMOKE || '1';
const managedUserDataDir = process.env.DESKTOP_AGENT_USER_DATA_DIR
  ? ''
  : fs.mkdtempSync(path.join(os.tmpdir(), 'gos-ui-smoke-user-data-'));
if (managedUserDataDir) {
  process.env.DESKTOP_AGENT_USER_DATA_DIR = managedUserDataDir;
  process.env.DESKTOP_AGENT_SESSION_DATA_DIR = path.join(managedUserDataDir, 'session-data');
  process.env.DESKTOP_AGENT_CACHE_DIR = path.join(managedUserDataDir, 'session-data', 'Cache');
}

require(path.resolve(__dirname, '..', 'main.js'));

function cleanupManagedUserData() {
  if (!managedUserDataDir) {
    return;
  }
  try {
    fs.rmSync(managedUserDataDir, { recursive: true, force: true });
  } catch (_error) {
    // ignore cleanup failures
  }
}

app.once('will-quit', cleanupManagedUserData);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(getter, { timeout = 15000, interval = 100, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await getter();
    if (value) {
      return value;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function runUiSmoke() {
  await app.whenReady();

  const mainWindow = await waitFor(
    () => BrowserWindow.getAllWindows()[0] || null,
    { label: 'desktop window' },
  );
  return runUiSmokeInWindow(mainWindow);
}

(async () => {
  try {
    const result = await runUiSmoke();
    logUiSmokeResult('[ui-smoke]', result);
    process.exitCode = 0;
    setTimeout(() => {
      BrowserWindow.getAllWindows().forEach((window) => {
        try {
          window.close();
        } catch (_error) {
          // ignore cleanup failures
        }
      });
      app.exit(process.exitCode || 0);
    }, 150);
  } catch (error) {
    console.error('[ui-smoke] FAIL', error && error.stack ? error.stack : error);
    process.exitCode = 1;
    setTimeout(() => {
      BrowserWindow.getAllWindows().forEach((window) => {
        try {
          window.close();
        } catch (_error) {
          // ignore cleanup failures
        }
      });
      app.exit(process.exitCode || 1);
    }, 150);
  }
})();
