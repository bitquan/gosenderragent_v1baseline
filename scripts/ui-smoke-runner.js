'use strict';

function logUiSmokeResult(prefix, result) {
  console.log(`${prefix} workspace =`, result.workspaceRoot || '<not selected>');
  console.log(`${prefix} modules =`, result.visitedModules.join(' -> '));
  console.log(`${prefix} target =`, result.targetWorkspaceRoot || '<not selected>');
  console.log(`${prefix} queue counts =`, `changed=${result.changedCount}`, `approvals=${result.approvalCount}`);
  if (result.emptyWorkspace) {
    console.log(`${prefix} empty-state =`, result.emptyWorkspaceMessage || 'workspace picker required');
  } else {
    console.log(`${prefix} chat =`, result.chatReplyPreview || 'no reply captured');
  }
  console.log(`${prefix} runtime =`, result.runtimeSetting || 'n/a');
}

async function runUiSmokeInWindow(mainWindow) {
  if (!mainWindow) {
    throw new Error('Desktop window was not available.');
  }

  if (!mainWindow.webContents.isLoadingMainFrame()) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  } else {
    await new Promise((resolve) => {
      mainWindow.webContents.once('did-finish-load', resolve);
    });
  }

  return mainWindow.webContents.executeJavaScript(`
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (getter, timeout = 10000, label = 'condition') => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeout) {
          const value = await getter();
          if (value) {
            return value;
          }
          await sleep(100);
        }
        throw new Error('Timed out waiting for ' + label + '.');
      };
      const assert = (condition, message) => {
        if (!condition) {
          throw new Error(message);
        }
      };
      const clickModule = async (moduleId) => {
        const button = document.querySelector('[data-route-tab="' + moduleId + '"]')
          || document.querySelector('[data-module-nav="' + moduleId + '"]');
        assert(button, 'Missing module button for ' + moduleId + '.');
        button.click();
        await waitFor(() => document.querySelector('[data-panel="' + moduleId + '"]'), 2500, moduleId + ' panel');
        return moduleId;
      };
      const clickSettingsTab = async (tabId) => {
        const button = document.querySelector('[data-settings-tab="' + tabId + '"]')
          || document.querySelector('[data-settings-shortcut="' + tabId + '"]');
        assert(button, 'Missing settings tab for ' + tabId + '.');
        button.click();
        await waitFor(() => {
          const current = document.querySelector('[data-settings-tab="' + tabId + '"].active');
          return current || document.querySelector('[data-panel="settings"]');
        }, 2500, 'settings tab ' + tabId);
        return 'settings:' + tabId;
      };

      await waitFor(() => window.gosAgent && document.querySelector('[data-workbench-shell="true"]'), 10000, 'renderer bootstrap');
      const bootstrap = await window.gosAgent.bootstrap();
      await sleep(600);

      const visitedModules = [];
      visitedModules.push(await clickModule('settings'));
      for (const tabId of ['ai', 'labs', 'learning', 'storage']) {
        visitedModules.push(await clickSettingsTab(tabId));
      }
      visitedModules.push(await clickModule('monitor'));
      visitedModules.push(await clickModule('workbench'));

      if (!bootstrap || !bootstrap.workspaceRoot) {
        await clickModule('settings');
        visitedModules.push(await clickSettingsTab('workspace'));
        const pickWorkspaceButton = Array.from(document.querySelectorAll('button')).find((button) => /pick workspace|switch workspace/i.test(String(button.textContent || '')));
        assert(pickWorkspaceButton, 'Workspace picker button was not rendered.');
        const workspaceCopy = String(document.body.textContent || '');
        assert(/Pick a workspace to start routing chat tasks\./.test(workspaceCopy) || /Not selected/.test(workspaceCopy), 'Empty workspace copy was not rendered.');
        return {
          ok: true,
          workspaceRoot: '',
          targetWorkspaceRoot: '',
          visitedModules,
          changedCount: 0,
          approvalCount: 0,
          runtimeSetting: '',
          emptyWorkspace: true,
          emptyWorkspaceMessage: 'Workspace selection is required before live work starts.',
          chatReplyPreview: '',
        };
      }

      const changedCount = document.querySelectorAll('[data-review-path]').length;
      const approvalCount = Array.from(document.querySelectorAll('.queue-card .eyebrow'))
        .some((node) => String(node.textContent || '').includes('Approvals'))
        ? document.querySelectorAll('[data-review-path]').length
        : 0;

      await clickModule('workbench');
      const firstReviewTarget = document.querySelector('[data-review-path]');
      if (firstReviewTarget) {
        firstReviewTarget.click();
        await waitFor(() => document.querySelector('[data-file-editor="true"]'), 10000, 'file editor');
      }

      await clickModule('settings');
      await clickSettingsTab('ai');
      const runtimeSelect = await waitFor(() => document.querySelector('[data-setting="runtime"]'), 5000, 'settings runtime selector');
      assert(runtimeSelect, 'Settings runtime selector was not rendered.');

      await clickModule('workbench');
      const chatInput = document.querySelector('[data-chat-input="true"]');
      const chatSend = document.querySelector('[data-chat-send="true"]');
      assert(chatInput && chatSend, 'Chat composer did not render.');
      const textAreaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      assert(textAreaSetter, 'Textarea value setter was not available.');
      const initialBubbleCount = document.querySelectorAll('.chat-bubble').length;
      chatInput.focus();
      textAreaSetter.call(chatInput, '/health');
      chatInput.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(80);
      chatSend.click();

      const replyArticle = await waitFor(() => {
        const assistantItems = Array.from(document.querySelectorAll('.chat-bubble.assistant, .chat-bubble.system'));
        if (assistantItems.length) {
          return assistantItems[assistantItems.length - 1] || null;
        }
        const allItems = Array.from(document.querySelectorAll('.chat-bubble'));
        if (allItems.length > initialBubbleCount) {
          return allItems[allItems.length - 1] || null;
        }
        return null;
      }, 15000, 'chat reply');

      return {
        ok: true,
        workspaceRoot: bootstrap.workspaceRoot,
        targetWorkspaceRoot: bootstrap.targetWorkspaceRoot || bootstrap.workspaceRoot,
        visitedModules,
        changedCount,
        approvalCount,
        runtimeSetting: String(runtimeSelect.value || ''),
        emptyWorkspace: false,
        chatReplyPreview: String(replyArticle.textContent || '').trim().slice(0, 180),
      };
    })();
  `, true);
}

module.exports = {
  logUiSmokeResult,
  runUiSmokeInWindow,
};
