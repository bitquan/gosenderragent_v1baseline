'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('node:child_process');

const { applySmartPatch } = require('../core/smart-patch');

function createWorkspaceFixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gos-smart-patch-'));
}

test('applySmartPatch can dry-run and apply a normal unified diff', () => {
  const workspaceRoot = createWorkspaceFixture();
  const filePath = path.join(workspaceRoot, 'demo.txt');
  fs.writeFileSync(filePath, 'alpha\nbeta\ngamma\n', 'utf8');

  const patchText = [
    'diff --git a/demo.txt b/demo.txt',
    '--- a/demo.txt',
    '+++ b/demo.txt',
    '@@ -1,3 +1,3 @@',
    ' alpha',
    '-beta',
    '+beta patched',
    ' gamma',
    '',
  ].join('\n');

  const check = applySmartPatch({
    workspaceRoot,
    patchText,
    dryRun: true,
  });
  assert.equal(check.ok, true);
  assert.equal(check.appliedFileCount, 1);
  assert.equal(check.confidence.label, 'high');
  assert.ok(check.confidence.score >= 95);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'alpha\nbeta\ngamma\n');

  const applied = applySmartPatch({
    workspaceRoot,
    patchText,
    dryRun: false,
  });
  assert.equal(applied.ok, true);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'alpha\nbeta patched\ngamma\n');
});

test('applySmartPatch uses fuzzy matching when only trailing whitespace drifted', () => {
  const workspaceRoot = createWorkspaceFixture();
  const filePath = path.join(workspaceRoot, 'demo.txt');
  fs.writeFileSync(filePath, 'alpha   \nbeta\ngamma\n', 'utf8');

  const patchText = [
    'diff --git a/demo.txt b/demo.txt',
    '--- a/demo.txt',
    '+++ b/demo.txt',
    '@@ -1,3 +1,3 @@',
    ' alpha',
    ' beta',
    '-gamma',
    '+gamma patched',
    '',
  ].join('\n');

  const result = applySmartPatch({
    workspaceRoot,
    patchText,
    dryRun: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.files[0].matchModes.includes('trim-end'), true);
  assert.ok(result.confidence.score < 95);
  assert.ok(result.files[0].confidence.score < 95);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'alpha   \nbeta\ngamma patched\n');
});

test('applySmartPatch rejects unmatched hunks and leaves files unchanged', () => {
  const workspaceRoot = createWorkspaceFixture();
  const filePath = path.join(workspaceRoot, 'demo.txt');
  fs.writeFileSync(filePath, 'alpha\nbeta\ngamma\n', 'utf8');

  const patchText = [
    'diff --git a/demo.txt b/demo.txt',
    '--- a/demo.txt',
    '+++ b/demo.txt',
    '@@ -1,3 +1,3 @@',
    ' alpha',
    '-delta',
    '+delta patched',
    ' gamma',
    '',
  ].join('\n');

  const result = applySmartPatch({
    workspaceRoot,
    patchText,
    dryRun: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.rejects.length, 1);
  assert.equal(result.confidence.recommendation, 'manual-review');
  assert.ok(result.confidence.score <= 35);
  assert.match(result.rejects[0].reason, /Unable to match hunk context/i);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'alpha\nbeta\ngamma\n');
});

test('smart-patch CLI can report dry-run JSON', () => {
  const workspaceRoot = createWorkspaceFixture();
  const filePath = path.join(workspaceRoot, 'demo.txt');
  const patchPath = path.join(workspaceRoot, 'demo.diff');
  fs.writeFileSync(filePath, 'alpha\nbeta\ngamma\n', 'utf8');
  fs.writeFileSync(patchPath, [
    'diff --git a/demo.txt b/demo.txt',
    '--- a/demo.txt',
    '+++ b/demo.txt',
    '@@ -1,3 +1,3 @@',
    ' alpha',
    '-beta',
    '+beta cli',
    ' gamma',
    '',
  ].join('\n'), 'utf8');

  const repoRoot = path.join(__dirname, '..');
  const raw = execFileSync('node', ['./scripts/smart-patch.js', '--workspace', workspaceRoot, '--patch', patchPath, '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const payload = JSON.parse(raw);

  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.files[0].path, 'demo.txt');
});

test('backend runtime exposes smart_patch through registry, approvals, and tool-loop execution', () => {
  const repoRoot = path.join(__dirname, '..');
  const script = [
    'from pathlib import Path',
    'import sys',
    'import os',
    '',
    `repo_root = Path(${JSON.stringify(repoRoot)})`,
    "sys.path.insert(0, str((repo_root / 'runtime').resolve()))",
    '',
    'from backend.agent.core.approval import ApprovalGate',
    'from backend.agent.core.permissions import build_default_permissions',
    'from backend.agent.core.tool_loop import OrchestrationTask, build_tool_loop_orchestrator, run_tool_loop',
    'from backend.agent.core.tool_registry import build_default_tool_registry',
    'from backend.agent.runtime.runtime_api import dispatch_action',
    '',
    "source_path = repo_root / 'tmp-smart-patch-source.txt'",
    "source_path.write_text('alpha\\nbeta\\ngamma\\n', encoding='utf-8')",
    'try:',
    "    patch_text = '\\n'.join([",
    "        'diff --git a/tmp-smart-patch-source.txt b/tmp-smart-patch-source.txt',",
    "        '--- a/tmp-smart-patch-source.txt',",
    "        '+++ b/tmp-smart-patch-source.txt',",
    "        '@@ -1,3 +1,3 @@',",
    "        ' alpha',",
    "        '-beta',",
    "        '+beta patched',",
    "        ' gamma',",
    "        '',",
    '    ])',
    '',
    '    registry = build_default_tool_registry(repo_root)',
    "    assert registry.get_tool('smart_patch').name == 'smart_patch'",
    '    permissions = build_default_permissions()',
    "    assert permissions.is_allowed('implementer', 'smart_patch')",
    "    assert permissions.is_allowed('repair', 'smart_patch')",
    '',
    "    preview = registry.run_tool('smart_patch', args={'patch_text': patch_text, 'dry_run': True})",
    "    assert preview['ok'] is True",
    "    assert preview['dryRun'] is True",
    "    assert preview['files'][0]['path'] == 'tmp-smart-patch-source.txt'",
    "    assert preview['confidence']['score'] >= 95",
    '',
    '    approval_gate = ApprovalGate(require_controlled=True, require_privileged=True)',
    "    request = approval_gate.request_for('implementer', registry.get_tool('smart_patch'), payload={'patch_text': patch_text})",
    '    assert request is not None',
    "    assert request.review_context['target_paths'] == ['tmp-smart-patch-source.txt']",
    '',
    '    blocked_orchestrator = build_tool_loop_orchestrator(repo_root)',
    '    blocked = blocked_orchestrator.run(',
    '        OrchestrationTask(',
    "            objective='Review a smart patch before approval',",
    "            ticket='SPATCH-BLOCKED',",
    '            context={',
    "                'steps': [",
    '                    {',
    "                        'action': 'smart_patch',",
    "                        'patch_text': patch_text,",
    "                        'dry_run': False,",
    '                    }',
    '                ]',
    '            },',
    '        )',
    '    )',
    "    assert blocked['status'] == 'blocked'",
    "    approval = blocked['payload']['execution'][0]['result']['approval_request']",
    "    assert approval['payload']['patch_preview']['confidence']['label'] == 'high'",
    "    assert approval['payload']['patch_preview']['automationScore'] >= 95",
    "    assert approval['review_context']['evidence']['patch_preview']['confidence']['label'] == 'high'",
    "    assert approval['review_context']['evidence']['patch_preview']['automation_score'] >= 95",
    '',
    '    orchestrator = build_tool_loop_orchestrator(repo_root, approval_gate=ApprovalGate(require_controlled=False, require_privileged=False))',
    '    result = orchestrator.run(',
    '        OrchestrationTask(',
    "            objective='Dry-run a smart patch',",
    "            ticket='SPATCH',",
    '            context={',
    "                'steps': [",
    '                    {',
    "                        'action': 'smart_patch',",
    "                        'patch_text': patch_text,",
    "                        'dry_run': True,",
    '                    }',
    '                ]',
    '            },',
    '        )',
    '    )',
    "    assert result['ok'] is True",
    "    execution = result['payload']['execution'][0]['result']",
    "    assert execution['ok'] is True",
    "    assert execution['dryRun'] is True",
    "    assert execution['files'][0]['path'] == 'tmp-smart-patch-source.txt'",
    "    assert execution['confidence']['score'] >= 95",
    '',
    '    wrapped = run_tool_loop(',
    '        project_root=repo_root,',
    "        objective='Dry-run a smart patch via wrapper',",
    "        ticket='SPATCH-WRAPPED',",
    '        context={',
    "            'steps': [",
    '                {',
    "                    'action': 'smart_patch',",
    "                    'patch_text': patch_text,",
    "                    'dry_run': True,",
    '                }',
    '            ]',
    '        },',
    '        approval_gate=ApprovalGate(require_controlled=False, require_privileged=False),',
    '    )',
    "    assert wrapped['ok'] is True",
    "    assert wrapped['runtime_run']['state'] == 'succeeded'",
    "    assert wrapped['runtime_result']['status'] == 'succeeded'",
    "    wrapped_execution = wrapped['payload']['execution'][0]['result']",
    "    assert wrapped_execution['confidence']['score'] >= 95",
    '',
    '    dispatched = dispatch_action({',
    "        'action': 'orchestrate',",
    "        'ticket': 'SPATCH-DISPATCH',",
    "        'objective': 'Dry-run a smart patch through runtime_api',",
    "        'approvalGated': False,",
    "        'approvalProtectedOnly': False,",
    "        'context': {",
    "            'steps': [",
    '                {',
    "                    'action': 'smart_patch',",
    "                    'patch_text': patch_text,",
    "                    'dry_run': True,",
    '                }',
    '            ]',
    '        },',
    '    })',
    "    assert dispatched['label'] == 'ORCHESTRATE TOOL LOOP'",
    "    assert dispatched['ok'] is True",
    "    assert dispatched['runtimeRun']['state'] == 'succeeded'",
    "    assert dispatched['runtimeResult']['status'] == 'succeeded'",
    'finally:',
    '    try:',
    '        source_path.unlink()',
    '    except FileNotFoundError:',
    '        pass',
  ].join('\n');

  execFileSync('python', ['-c', script], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
});

test('approval-gated orchestrate uses safe git status and finishes without pending approvals', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const fileName = `tmp-orchestrate-smoke-${process.pid}.txt`;
  const filePath = path.join(repoRoot, 'runtime', fileName);
  fs.writeFileSync(filePath, 'orchestrate smoke\n', 'utf8');

  const script = [
    'from pathlib import Path',
    'import sys',
    '',
    'repo_root = Path.cwd()',
    'sys.path.insert(0, str(repo_root / "runtime"))',
    '',
    'from backend.agent.core.approval import ApprovalGate',
    'from backend.agent.core.tool_loop import run_tool_loop',
    'from backend.agent.runtime.runtime_api import dispatch_action',
    '',
    `target_path = ${JSON.stringify(filePath)}`,
    '',
    'wrapped = run_tool_loop(',
    '    project_root=repo_root,',
    "    objective='Capture a validation snapshot without edits',",
    "    ticket='ORCH-SAFE-STATUS',",
    '    context={',
    "        'steps': [",
    '            {',
    "                'action': 'inspect_file',",
    "                'path': target_path,",
    '            }',
    '        ]',
    '    },',
    '    approval_gate=ApprovalGate(require_controlled=True, require_privileged=True),',
    ')',
    "assert wrapped['ok'] is True",
    "assert wrapped['runtime_run']['state'] == 'succeeded'",
    "assert wrapped['runtime_result']['status'] == 'succeeded'",
    "assert wrapped['payload']['validation']['valid'] is True",
    "assert wrapped['payload']['validation']['git_status']['ok'] is True",
    "assert wrapped['pending_approvals'] == []",
    '',
    'dispatched = dispatch_action({',
    "    'action': 'orchestrate',",
    "    'ticket': 'ORCH-SAFE-DISPATCH',",
    "    'objective': 'Capture a validation snapshot without edits',",
    "    'approvalGated': True,",
    "    'approvalProtectedOnly': True,",
    "    'context': {",
    "        'steps': [",
    '            {',
    "                'action': 'inspect_file',",
    "                'path': target_path,",
    '            }',
    '        ]',
    '    },',
    '})',
    "assert dispatched['label'] == 'ORCHESTRATE TOOL LOOP'",
    "assert dispatched['ok'] is True",
    "assert dispatched['exitCode'] == 0",
    "assert dispatched['approvalRequests'] == []",
    "assert dispatched['runtimeRun']['state'] == 'succeeded'",
    "assert dispatched['runtimeResult']['status'] == 'succeeded'",
    "validation = dispatched['artifact']['payload']['validation']",
    "assert validation['valid'] is True",
    "assert validation['git_status']['ok'] is True",
  ].join('\n');

  try {
    execFileSync('python', ['-c', script], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});
