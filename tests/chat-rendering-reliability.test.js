'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const esbuild = require('esbuild');

function loadChatMarkdownModule() {
  const sourceFile = path.resolve(__dirname, '..', 'renderer-src', 'lib', 'chat-markdown.ts');
  const result = esbuild.buildSync({
    entryPoints: [sourceFile],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    write: false,
    logLevel: 'silent',
  });

  const bundledCode = result.outputFiles[0].text;
  const compiledModule = { exports: {} };
  const evaluator = new Function('require', 'module', 'exports', bundledCode);
  evaluator(require, compiledModule, compiledModule.exports);
  return compiledModule.exports;
}

const { parseChatMarkdownBlocks, tokenizeChatInlineText } = loadChatMarkdownModule();

test('fenced code blocks keep blank lines intact', () => {
  const blocks = parseChatMarkdownBlocks('Intro\n\n```js\nconst first = 1;\n\nconst second = 2;\n```\n\nAfter');

  assert.deepEqual(blocks, [
    { kind: 'paragraph', text: 'Intro' },
    { kind: 'code', language: 'js', code: 'const first = 1;\n\nconst second = 2;' },
    { kind: 'paragraph', text: 'After' },
  ]);
});

test('inline code and bold tokenization is preserved', () => {
  const tokens = tokenizeChatInlineText('Use `npm test` and **ship it** now.');

  assert.deepEqual(tokens, [
    { kind: 'text', value: 'Use ' },
    { kind: 'code', value: 'npm test' },
    { kind: 'text', value: ' and ' },
    { kind: 'bold', value: 'ship it' },
    { kind: 'text', value: ' now.' },
  ]);
});

test('headings still parse as section blocks', () => {
  const blocks = parseChatMarkdownBlocks('### Reliability pass');

  assert.deepEqual(blocks, [
    { kind: 'heading', level: 3, text: 'Reliability pass' },
  ]);
});

test('partial fenced code degrades to a safe paragraph block', () => {
  const blocks = parseChatMarkdownBlocks('```ts\nconst value = 1;\n\nconst next = 2;');

  assert.deepEqual(blocks, [
    { kind: 'paragraph', text: '```ts\nconst value = 1;\n\nconst next = 2;' },
  ]);
});

test('ordered and unordered list parsing remains correct', () => {
  const blocks = parseChatMarkdownBlocks('- alpha\n- beta\n\n1. first\n2. second');

  assert.deepEqual(blocks, [
    { kind: 'unordered-list', items: ['alpha', 'beta'] },
    { kind: 'ordered-list', items: ['first', 'second'] },
  ]);
});
