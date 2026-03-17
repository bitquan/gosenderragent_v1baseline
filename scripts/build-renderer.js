#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'renderer-src');
const outputRoot = path.join(projectRoot, 'renderer');

async function build() {
  fs.mkdirSync(outputRoot, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(sourceRoot, 'main.tsx')],
    outfile: path.join(outputRoot, 'app.js'),
    bundle: true,
    format: 'iife',
    target: ['chrome124'],
    platform: 'browser',
    sourcemap: false,
    legalComments: 'none',
    jsx: 'automatic',
    loader: {
      '.ts': 'ts',
      '.tsx': 'tsx',
    },
    logLevel: 'error',
  });
  fs.copyFileSync(path.join(sourceRoot, 'styles.css'), path.join(outputRoot, 'styles.css'));
}

build().catch((error) => {
  console.error('[build:renderer] failed', error && error.stack ? error.stack : error);
  process.exit(1);
});
