import type * as vscode from 'vscode';

type CompanionRuntime = {
  activate: (context: vscode.ExtensionContext) => unknown;
  deactivate?: () => unknown;
};

const runtime = require('../extension.js') as CompanionRuntime;

export function activate(context: vscode.ExtensionContext) {
  return runtime.activate(context);
}

export function deactivate() {
  return runtime.deactivate?.();
}
