'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildAppStoragePaths } = require('../core/app-storage-paths');

test('buildAppStoragePaths isolates dev storage from the installed app root', () => {
  const result = buildAppStoragePaths({
    appName: 'GoSenderr Desktop Agent PC',
    isDev: true,
    localStorageRoot: 'C:\\Users\\benzo\\AppData\\Local',
    fallbackUserDataDir: 'C:\\Users\\benzo\\AppData\\Roaming\\GoSenderr Desktop Agent PC',
  });

  assert.equal(
    result.userDataDir,
    path.resolve('C:\\Users\\benzo\\AppData\\Local\\GoSenderr Desktop Agent PC Dev\\user-data'),
  );
  assert.equal(
    result.sessionDataDir,
    path.resolve('C:\\Users\\benzo\\AppData\\Local\\GoSenderr Desktop Agent PC Dev\\session-data'),
  );
  assert.equal(
    result.cacheDir,
    path.resolve('C:\\Users\\benzo\\AppData\\Local\\GoSenderr Desktop Agent PC Dev\\session-data\\Cache'),
  );
});

test('buildAppStoragePaths preserves the packaged fallback userData path', () => {
  const result = buildAppStoragePaths({
    appName: 'GoSenderr Desktop Agent PC',
    isDev: false,
    localStorageRoot: 'C:\\Users\\benzo\\AppData\\Local',
    fallbackUserDataDir: 'C:\\Users\\benzo\\AppData\\Roaming\\GoSenderr Desktop Agent PC',
  });

  assert.equal(
    result.userDataDir,
    path.resolve('C:\\Users\\benzo\\AppData\\Roaming\\GoSenderr Desktop Agent PC'),
  );
  assert.equal(
    result.sessionDataDir,
    path.resolve('C:\\Users\\benzo\\AppData\\Local\\GoSenderr Desktop Agent PC\\session-data'),
  );
});
