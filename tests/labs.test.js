'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listLabs, resetLab, runLabRecipe } = require('../core/labs');

function makeWorkspace() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-agent-labs-'));
  const artifactsRoot = path.join(workspaceRoot, 'artifacts');
  fs.mkdirSync(artifactsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, 'dev_assistant.local.yaml'),
    `assistant_artifacts_root: ${artifactsRoot}\n`,
    'utf8',
  );
  return { workspaceRoot, artifactsRoot };
}

test('dummy lab recipes create generated benchmark projects and list them', () => {
  const { workspaceRoot } = makeWorkspace();

  try {
    const result = runLabRecipe(workspaceRoot, {
      recipe: 'dummy-node-app',
      kind: 'scratch',
      name: 'dummy-benchmark',
    });

    assert.equal(result.ok, true);
    assert.equal(result.cloneMethod, 'generated');
    assert.equal(fs.existsSync(path.join(result.labRoot, 'package.json')), true);
    assert.equal(fs.existsSync(path.join(result.labRoot, 'test', 'calculator.test.js')), true);

    const labs = listLabs(workspaceRoot);
    assert.equal(labs.labs.some((lab) => lab.labRoot === result.labRoot && lab.status === 'generated'), true);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('resetLab rebuilds generated dummy labs from their recipe metadata', () => {
  const { workspaceRoot } = makeWorkspace();

  try {
    const result = runLabRecipe(workspaceRoot, {
      recipe: 'dummy-broken-node-app',
      kind: 'scratch',
    });
    const sourcePath = path.join(result.labRoot, 'src', 'calculator.js');
    fs.writeFileSync(sourcePath, `'use strict';\nmodule.exports = { sum: () => 99, describeTask: () => 'broken' };\n`, 'utf8');

    const reset = resetLab(workspaceRoot, {
      labRoot: result.labRoot,
    });

    assert.equal(reset.ok, true);
    const restored = fs.readFileSync(sourcePath, 'utf8');
    assert.match(restored, /return left - right;/);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('benchmark-self-host can clone from an explicit source override for repeatable tests', () => {
  const { workspaceRoot } = makeWorkspace();
  const sourceRoot = path.join(workspaceRoot, 'self-host-source');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'package.json'), '{"name":"self-host-source"}\n', 'utf8');

  try {
    const result = runLabRecipe(workspaceRoot, {
      recipe: 'benchmark-self-host',
      kind: 'scratch',
      sourceRoot,
    });

    assert.equal(result.ok, true);
    assert.equal(result.recipe, 'benchmark-self-host');
    assert.equal(result.sourceRoot, sourceRoot);
    assert.equal(fs.existsSync(path.join(result.labRoot, 'package.json')), true);
    assert.equal(result.cloneMethod, 'copy');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
