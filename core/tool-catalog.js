'use strict';

const TOOL_CATALOG = Object.freeze([
  {
    id: 'read_file',
    label: 'Read file',
    safetyLevel: 'safe',
    kind: 'read',
    summary: 'Read repository files, optionally with a focused line range.',
  },
  {
    id: 'search_repo',
    label: 'Search repo',
    safetyLevel: 'safe',
    kind: 'inspect',
    summary: 'Search the repository for matching paths or content patterns.',
  },
  {
    id: 'list_files',
    label: 'List files',
    safetyLevel: 'safe',
    kind: 'inspect',
    summary: 'List repository files with priority hints from the current runtime context.',
  },
  {
    id: 'list_tasks',
    label: 'List tasks',
    safetyLevel: 'safe',
    kind: 'read',
    summary: 'Read queued board tasks for compatibility with older BAT workflows.',
  },
  {
    id: 'edit_file',
    label: 'Edit file',
    safetyLevel: 'controlled',
    kind: 'write',
    summary: 'Create or replace repository files inside the target workspace or lab.',
  },
  {
    id: 'smart_patch',
    label: 'Smart patch',
    safetyLevel: 'controlled',
    kind: 'write',
    summary: 'Apply unified diffs with dry-run support, fuzzy context matching, and reject reporting.',
  },
  {
    id: 'git_diff',
    label: 'Git diff',
    safetyLevel: 'safe',
    kind: 'inspect',
    summary: 'Inspect current working tree diffs before review or patch approval.',
  },
  {
    id: 'git_status',
    label: 'Git status',
    safetyLevel: 'controlled',
    kind: 'inspect',
    summary: 'Read short working-tree status for the current target.',
  },
  {
    id: 'run_command',
    label: 'Run command',
    safetyLevel: 'privileged',
    kind: 'exec',
    summary: 'Run a shell command inside the workspace under approval-aware boundaries.',
  },
  {
    id: 'run_tests',
    label: 'Run tests',
    safetyLevel: 'privileged',
    kind: 'exec',
    summary: 'Run focused validation commands and store the result as an artifact.',
  },
  {
    id: 'inspect_artifact',
    label: 'Inspect artifact',
    safetyLevel: 'safe',
    kind: 'artifact-read',
    summary: 'Read recent run, test, or summary artifacts without leaving the workbench.',
  },
  {
    id: 'notify',
    label: 'Notify',
    safetyLevel: 'controlled',
    kind: 'network',
    summary: 'Send a notification payload to an approved webhook destination.',
  },
]);

function listTools() {
  return TOOL_CATALOG.map((tool) => ({ ...tool }));
}

module.exports = {
  TOOL_CATALOG,
  listTools,
};
