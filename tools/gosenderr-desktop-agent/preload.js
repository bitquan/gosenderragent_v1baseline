'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function wrapInvoke(channel) {
  return (payload = {}) => ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld('gosAgent', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  getMeta: () => ipcRenderer.invoke('app:meta'),
  chatMessage: (text, workspace = '') => ipcRenderer.invoke('assistant:chat', { text, workspace }),
  pickWorkspace: () => ipcRenderer.invoke('app:pickWorkspace'),
  setWorkspace: (workspaceRoot) => ipcRenderer.invoke('app:setWorkspace', { workspaceRoot }),
  updateSettings: (payload) => ipcRenderer.invoke('app:updateSettings', payload),

  setSecret: (name, value) => ipcRenderer.invoke('app:secrets:set', { name, value }),
  getSecret: (name) => ipcRenderer.invoke('app:secrets:get', { name }),

  preflight: wrapInvoke('agent:preflight'),
  status: wrapInvoke('agent:status'),
  run: wrapInvoke('agent:run'),
  implement: wrapInvoke('agent:implement'),
  sprint: wrapInvoke('agent:sprint'),
  autopilot: wrapInvoke('agent:autopilot'),
  train: wrapInvoke('agent:train'),
  learn: wrapInvoke('agent:learn'),
  autopilotSchedulerStart: wrapInvoke('agent:autopilotSchedulerStart'),
  autopilotSchedulerStop: wrapInvoke('agent:autopilotSchedulerStop'),
  autopilotSchedulerStatus: wrapInvoke('agent:autopilotSchedulerStatus'),
  cancel: wrapInvoke('agent:cancel'),
  openLocation: wrapInvoke('agent:openLocation'),
  getEditorContext: wrapInvoke('agent:getEditorContext'),
  setEditorContextFocus: wrapInvoke('agent:setEditorContextFocus'),

  getReviewSnapshot: wrapInvoke('review:getSnapshot'),
  readReviewFile: wrapInvoke('review:readFile'),
  getReviewDiff: wrapInvoke('review:getDiff'),
  saveReviewFile: wrapInvoke('review:saveFile'),
  setReviewDecision: wrapInvoke('review:setDecision'),
  copyReviewText: wrapInvoke('review:copyText'),
  openInVsCode: wrapInvoke('review:openInVsCode'),

  listSkills: wrapInvoke('skills:list'),
  runSkill: wrapInvoke('skills:run'),

  listAutomations: wrapInvoke('automations:list'),
  upsertAutomation: wrapInvoke('automations:upsert'),
  toggleAutomation: wrapInvoke('automations:toggle'),
  removeAutomation: wrapInvoke('automations:remove'),
  runAutomationNow: wrapInvoke('automations:runNow'),

  checkUpdates: wrapInvoke('updates:check'),
  planUpdates: wrapInvoke('updates:plan'),
  applyUpdates: wrapInvoke('updates:apply'),
  rollbackUpdates: wrapInvoke('updates:rollback'),
  listBackups: wrapInvoke('updates:backups'),

  onRunEvent: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('agent:run-event', wrapped);
    return () => ipcRenderer.removeListener('agent:run-event', wrapped);
  },
  onSchedulerEvent: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('agent:scheduler-event', wrapped);
    return () => ipcRenderer.removeListener('agent:scheduler-event', wrapped);
  },
});
