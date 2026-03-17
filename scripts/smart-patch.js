#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { applySmartPatch } = require('../core/smart-patch');

function parseArgs(argv = []) {
  const parsed = {
    workspaceRoot: process.cwd(),
    patchFile: '',
    dryRun: false,
    json: false,
    allowPartial: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token) {
      continue;
    }
    if (token === '--dry-run' || token === '--check') {
      parsed.dryRun = true;
      continue;
    }
    if (token === '--json') {
      parsed.json = true;
      continue;
    }
    if (token === '--allow-partial') {
      parsed.allowPartial = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    const nextValue = String(argv[index + 1] || '').trim();
    if ((token === '--workspace' || token === '--cwd') && nextValue) {
      parsed.workspaceRoot = path.resolve(nextValue);
      index += 1;
      continue;
    }
    if ((token === '--patch' || token === '--file') && nextValue) {
      parsed.patchFile = path.resolve(nextValue);
      index += 1;
      continue;
    }
  }

  return parsed;
}

function printHelp() {
  console.log('Usage: node ./scripts/smart-patch.js [--workspace <path>] [--patch <file.diff>] [--dry-run] [--allow-partial] [--json]');
  console.log('If --patch is omitted, patch text is read from stdin.');
}

function readPatchText(patchFile) {
  if (patchFile) {
    return fs.readFileSync(patchFile, 'utf8');
  }
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_error) {
    return '';
  }
}

function renderText(result) {
  const lines = [
    `Status: ${result.ok ? 'OK' : 'REJECTED'}`,
    `Mode: ${result.dryRun ? 'dry-run' : 'apply'}`,
    `Workspace: ${result.workspaceRoot}`,
    `Summary: ${result.message}`,
  ];
  if (result.confidence && typeof result.confidence === 'object') {
    lines.push(
      `Confidence: ${result.confidence.score}/100 (${result.confidence.label}, ${result.confidence.recommendation})`,
    );
  }
  if (Array.isArray(result.files) && result.files.length > 0) {
    lines.push('');
    lines.push('Files:');
    for (const item of result.files) {
      const confidence = item.confidence && typeof item.confidence === 'object'
        ? ` confidence=${item.confidence.score}/100 ${item.confidence.label}`
        : '';
      lines.push(`- ${item.path} (${item.operation}) applied=${item.appliedHunks} already=${item.alreadyAppliedHunks} rejected=${item.rejectedHunks}${confidence}`);
    }
  }
  if (Array.isArray(result.rejects) && result.rejects.length > 0) {
    lines.push('');
    lines.push('Rejects:');
    for (const reject of result.rejects) {
      lines.push(`- ${reject.path || '(unknown file)'} ${reject.header || ''} ${reject.reason}`.trim());
    }
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const patchText = readPatchText(args.patchFile);
  const result = applySmartPatch({
    workspaceRoot: args.workspaceRoot,
    patchText,
    dryRun: args.dryRun,
    allowPartial: args.allowPartial,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderText(result));
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

main();
