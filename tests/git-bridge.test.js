'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

test('main process exposes the desktop git IPC handlers', () => {
  assert.match(mainJs, /ipcMain\.handle\('git:getSummary'/);
  assert.match(mainJs, /ipcMain\.handle\('git:getStatus'/);
  assert.match(mainJs, /ipcMain\.handle\('git:getDiff'/);
  assert.match(mainJs, /ipcMain\.handle\('git:stage'/);
  assert.match(mainJs, /ipcMain\.handle\('git:unstage'/);
  assert.match(mainJs, /ipcMain\.handle\('git:stageAll'/);
  assert.match(mainJs, /ipcMain\.handle\('git:unstageAll'/);
  assert.match(mainJs, /ipcMain\.handle\('git:discardPaths'/);
  assert.match(mainJs, /ipcMain\.handle\('git:commit'/);
  assert.match(mainJs, /ipcMain\.handle\('git:pull'/);
  assert.match(mainJs, /ipcMain\.handle\('git:push'/);
  assert.match(mainJs, /ipcMain\.handle\('git:listBranches'/);
  assert.match(mainJs, /ipcMain\.handle\('git:createBranch'/);
  assert.match(mainJs, /ipcMain\.handle\('git:switchBranch'/);
  assert.match(mainJs, /ipcMain\.handle\('git:publishBranch'/);
});

test('preload exposes the desktop git bridge to the renderer', () => {
  assert.match(preloadJs, /const gitApi = \{/);
  assert.match(preloadJs, /getSummary: wrapInvoke\('git:getSummary'\)/);
  assert.match(preloadJs, /getStatus: wrapInvoke\('git:getStatus'\)/);
  assert.match(preloadJs, /getDiff: wrapInvoke\('git:getDiff'\)/);
  assert.match(preloadJs, /stage: wrapInvoke\('git:stage'\)/);
  assert.match(preloadJs, /unstage: wrapInvoke\('git:unstage'\)/);
  assert.match(preloadJs, /stageAll: wrapInvoke\('git:stageAll'\)/);
  assert.match(preloadJs, /unstageAll: wrapInvoke\('git:unstageAll'\)/);
  assert.match(preloadJs, /discardPaths: wrapInvoke\('git:discardPaths'\)/);
  assert.match(preloadJs, /commit: wrapInvoke\('git:commit'\)/);
  assert.match(preloadJs, /pull: wrapInvoke\('git:pull'\)/);
  assert.match(preloadJs, /push: wrapInvoke\('git:push'\)/);
  assert.match(preloadJs, /listBranches: wrapInvoke\('git:listBranches'\)/);
  assert.match(preloadJs, /createBranch: wrapInvoke\('git:createBranch'\)/);
  assert.match(preloadJs, /switchBranch: wrapInvoke\('git:switchBranch'\)/);
  assert.match(preloadJs, /publishBranch: wrapInvoke\('git:publishBranch'\)/);
  assert.match(preloadJs, /publishGitBranch: gitApi\.publishBranch/);
});
