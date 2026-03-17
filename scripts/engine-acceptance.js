'use strict';

const path = require('path');

const { APP_ROOT } = require('../core/app-roots');
const { runEngineAcceptanceSuite } = require('../core/engine-acceptance');

function parseArgs(argv = []) {
  const args = new Set(argv);
  return {
    workspaceRoot: path.resolve(process.env.DESKTOP_AGENT_WORKSPACE_ROOT || process.cwd()),
    selfHostSourceRoot: process.env.DESKTOP_AGENT_SELF_HOST_SOURCE_ROOT || APP_ROOT,
    fullSelfHost: args.has('--full-self-host'),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runEngineAcceptanceSuite(options.workspaceRoot, {
    selfHostSourceRoot: path.resolve(options.selfHostSourceRoot),
    fullSelfHost: options.fullSelfHost,
  });
  const report = result.report || {};
  console.log(`[engine-acceptance] workspace = ${options.workspaceRoot}`);
  console.log(`[engine-acceptance] output = ${result.outputPath || ''}`);
  console.log(`[engine-acceptance] overall = ${report.overallStatus || 'unknown'} :: ${report.summary || ''}`);
  for (const check of Array.isArray(report.checks) ? report.checks : []) {
    console.log(`[engine-acceptance] ${check.id} = ${check.status} :: ${check.summary || ''}`);
  }
  const training = report.training && typeof report.training === 'object' ? report.training : {};
  const trustSummary = training.trustSummary && typeof training.trustSummary === 'object' ? training.trustSummary : {};
  console.log(`[engine-acceptance] training = ${trustSummary.status || 'unknown'} :: ${trustSummary.summary || 'No training telemetry summary.'}`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[engine-acceptance] failed', error);
  process.exitCode = 1;
});
