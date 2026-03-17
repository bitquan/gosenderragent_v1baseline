import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('gosenderr.openDesktopAgent', async () => {
    await vscode.window.showInformationMessage('Open the GoSenderr Desktop Agent and sync the current workspace.');
  });
  context.subscriptions.push(disposable);
}

export function deactivate() {}
