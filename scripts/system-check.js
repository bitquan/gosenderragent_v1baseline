'use strict';

const path = require('path');

const { buildSystemCheck, renderSystemCheck, SYSTEM_CHECK_AREAS } = require('../core/system-check');
const { buildSystemCheckContext } = require('../core/system-check-context');

function parseArgs(argv = []) {
  const parsed = {
    workspaceRoot: process.cwd(),
    area: '',
    path: '',
    runId: '',
    task: '',
    json: false,
    compact: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token) {
      continue;
    }
    if (token === '--json') {
      parsed.json = true;
      continue;
    }
    if (token === '--compact') {
      parsed.compact = true;
      continue;
    }
    const nextValue = String(argv[index + 1] || '').trim();
    if (token === '--workspace' && nextValue) {
      parsed.workspaceRoot = path.resolve(nextValue);
      index += 1;
      continue;
    }
    if (token === '--area' && nextValue) {
      parsed.area = nextValue;
      index += 1;
      continue;
    }
    if (token === '--path' && nextValue) {
      parsed.path = nextValue;
      index += 1;
      continue;
    }
    if (token === '--run-id' && nextValue) {
      parsed.runId = nextValue;
      index += 1;
      continue;
    }
    if (token === '--task' && nextValue) {
      parsed.task = nextValue;
      index += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
  }
  return parsed;
}

function printHelp() {
  console.log('Usage: npm run system:check -- [--workspace <path>] [--area <area>] [--path <path>] [--run-id <id>] [--task <text>] [--compact] [--json]');
  console.log(`Areas: ${SYSTEM_CHECK_AREAS.join(', ')}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const context = await buildSystemCheckContext(args.workspaceRoot);
  const report = buildSystemCheck({
    ...args,
    ...context,
  });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(renderSystemCheck(report, args));
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
