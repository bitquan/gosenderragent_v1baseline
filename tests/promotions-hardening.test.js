const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCandidate, promoteCandidate } = require('../core/promotions');

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

test('promoteCandidate dryRun returns governance and verification preview', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-promote-'));
  const offload = path.join(root, 'offload');
  const labRoot = path.join(root, 'lab');
  const targetRoot = path.join(root, 'target');
  fs.mkdirSync(labRoot, { recursive: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  const normalizedOffload = offload.split(path.sep).join('/');
  fs.writeFileSync(path.join(root, 'dev_assistant.yaml'), `assistant_promotions_root: ${normalizedOffload}`);
  fs.writeFileSync(path.join(labRoot, 'hello.txt'), 'hello');
  writeJson(path.join(labRoot, '.gos-lab.json'), { sourceRoot: targetRoot });
  writeJson(path.join(offload, 'acceptance', 'latest.json'), { ready: true, summary: 'ready' });

  const created = createCandidate(root, { labRoot, verification: { ok: true }, force: true });
  const result = promoteCandidate(root, { candidateId: created.candidate.id, dryRun: true, force: true });
  assert.equal(result.dryRun, true);
  assert.equal(Array.isArray(result.changedEntries), true);
  assert.equal(result.governance.changedPathCount > 0, true);
});
