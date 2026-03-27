'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function wrapInvoke(channel) {
  return (payload = {}) => ipcRenderer.invoke(channel, payload);
}

const appApi = {
  bootstrap: (payload = {}) => ipcRenderer.invoke('app:bootstrap', payload),
  bootstrapLite: (payload = {}) => ipcRenderer.invoke('app:bootstrapLite', payload),
  getMeta: () => ipcRenderer.invoke('app:meta'),
  getSettings: () => ipcRenderer.invoke('app:getSettings'),
  pickWorkspace: () => ipcRenderer.invoke('app:pickWorkspace'),
  setWorkspace: (workspaceRoot) => ipcRenderer.invoke('app:setWorkspace', { workspaceRoot }),
  setLab: (payload = {}) => ipcRenderer.invoke('app:setLab', payload),
  updateSettings: (payload) => ipcRenderer.invoke('app:updateSettings', payload),
  reportRendererError: (payload = {}) => ipcRenderer.invoke('app:reportRendererError', payload),
  setSecret: (name, value) => ipcRenderer.invoke('app:secrets:set', { name, value }),
  getSecret: (name) => ipcRenderer.invoke('app:secrets:get', { name }),
  startDevEngine: () => ipcRenderer.invoke('devEngine:start'),
};

const agentApi = {
  chatMessage: (text, workspace = '', options = {}) => ipcRenderer.invoke('assistant:chat', { text, workspace, ...options }),
  pickAttachments: wrapInvoke('assistant:attachments:pick'),
  preflight: wrapInvoke('agent:preflight'),
  status: wrapInvoke('agent:status'),
  plan: wrapInvoke('agent:plan'),
  run: wrapInvoke('agent:run'),
  implement: wrapInvoke('agent:implement'),
  taskLoopExecute: wrapInvoke('agent:taskLoop:execute'),
  taskLoopRetry: wrapInvoke('agent:taskLoop:retry'),
  taskLoopRepair: wrapInvoke('agent:taskLoop:repair'),
  taskLoopLatest: wrapInvoke('agent:taskLoop:latest'),
  sprint: wrapInvoke('agent:sprint'),
  autopilot: wrapInvoke('agent:autopilot'),
  selfImprove: wrapInvoke('agent:selfImprove'),
  train: wrapInvoke('agent:train'),
  learn: wrapInvoke('agent:learn'),
  repair: wrapInvoke('agent:repair'),
  autopilotSchedulerStart: wrapInvoke('agent:autopilotSchedulerStart'),
  autopilotSchedulerStop: wrapInvoke('agent:autopilotSchedulerStop'),
  autopilotSchedulerStatus: wrapInvoke('agent:autopilotSchedulerStatus'),
  cancel: wrapInvoke('agent:cancel'),
  openLocation: wrapInvoke('agent:openLocation'),
  getEditorContext: wrapInvoke('agent:getEditorContext'),
  setEditorContextFocus: wrapInvoke('agent:setEditorContextFocus'),
};

const reviewApi = {
  getSnapshot: wrapInvoke('review:getSnapshot'),
  rememberSelection: wrapInvoke('review:rememberSelection'),
  readFile: wrapInvoke('review:readFile'),
  getDiff: wrapInvoke('review:getDiff'),
  saveFile: wrapInvoke('review:saveFile'),
  setDecision: wrapInvoke('review:setDecision'),
  copyText: wrapInvoke('review:copyText'),
  openInVsCode: wrapInvoke('review:openInVsCode'),
};

const gitApi = {
  getSummary: wrapInvoke('git:getSummary'),
  getStatus: wrapInvoke('git:getStatus'),
  getDiff: wrapInvoke('git:getDiff'),
  stage: wrapInvoke('git:stage'),
  unstage: wrapInvoke('git:unstage'),
  stageAll: wrapInvoke('git:stageAll'),
  unstageAll: wrapInvoke('git:unstageAll'),
  discardPaths: wrapInvoke('git:discardPaths'),
  commit: wrapInvoke('git:commit'),
  pull: wrapInvoke('git:pull'),
  push: wrapInvoke('git:push'),
  listBranches: wrapInvoke('git:listBranches'),
  createBranch: wrapInvoke('git:createBranch'),
  switchBranch: wrapInvoke('git:switchBranch'),
  publishBranch: wrapInvoke('git:publishBranch'),
};

const skillsApi = {
  list: wrapInvoke('skills:list'),
  run: wrapInvoke('skills:run'),
};

const goalsApi = {
  list: wrapInvoke('goals:list'),
  create: wrapInvoke('goals:create'),
  update: wrapInvoke('goals:update'),
};

const tasksApi = {
  list: wrapInvoke('tasks:list'),
  create: wrapInvoke('tasks:create'),
  run: wrapInvoke('tasks:run'),
  cancel: wrapInvoke('tasks:cancel'),
};

const runsApi = {
  list: wrapInvoke('runs:list'),
  get: wrapInvoke('runs:get'),
};

const recipesApi = {
  list: wrapInvoke('recipes:list'),
  queueFollowup: wrapInvoke('recipes:queueFollowup'),
  queueTaskLoopNextAction: wrapInvoke('recipes:queueTaskLoopNextAction'),
  run: wrapInvoke('recipes:run'),
};

const workspaceApi = {
  vscodeStatus: wrapInvoke('workspace:vscodeStatus'),
  vscodeBootstrap: wrapInvoke('workspace:vscodeBootstrap'),
  vscodeInstallCompanion: wrapInvoke('workspace:vscodeInstallCompanion'),
  vscodeOpen: wrapInvoke('workspace:vscodeOpen'),
};

const automationsApi = {
  list: wrapInvoke('automations:list'),
  getSettings: wrapInvoke('automations:getSettings'),
  saveSettings: wrapInvoke('automations:saveSettings'),
  upsert: wrapInvoke('automations:upsert'),
  toggle: wrapInvoke('automations:toggle'),
  remove: wrapInvoke('automations:remove'),
  runNow: wrapInvoke('automations:runNow'),
};

const labsApi = {
  list: wrapInvoke('labs:list'),
  create: wrapInvoke('labs:create'),
  reset: wrapInvoke('labs:reset'),
  destroy: wrapInvoke('labs:destroy'),
  runRecipe: wrapInvoke('labs:runRecipe'),
};

const promotionsApi = {
  list: wrapInvoke('promotions:list'),
  createCandidate: wrapInvoke('promotions:createCandidate'),
  promote: wrapInvoke('promotions:promote'),
  rollback: wrapInvoke('promotions:rollback'),
  history: wrapInvoke('promotions:history'),
};

const updatesApi = {
  check: wrapInvoke('updates:check'),
  plan: wrapInvoke('updates:plan'),
  apply: wrapInvoke('updates:apply'),
  rollback: wrapInvoke('updates:rollback'),
  backups: wrapInvoke('updates:backups'),
  buildBinary: wrapInvoke('updates:binaryBuild'),
  checkBinary: wrapInvoke('updates:binaryCheck'),
  downloadBinary: wrapInvoke('updates:binaryDownload'),
  installBinary: wrapInvoke('updates:binaryInstall'),
  promoteBinary: wrapInvoke('updates:binaryPromote'),
  pruneBinary: wrapInvoke('updates:binaryPrune'),
};

const storageApi = {
  cleanup: wrapInvoke('storage:cleanup'),
};

const artifactsApi = {
  openPath: wrapInvoke('artifacts:openPath'),
  readPreview: wrapInvoke('artifacts:readPreview'),
};

const learningApi = {
  capture: wrapInvoke('learning:capture'),
  getChanges: wrapInvoke('learning:changes'),
  getStatus: wrapInvoke('learning:status'),
  exportChanges: wrapInvoke('learning:export'),
  fetchApprovedDoc: wrapInvoke('learning:fetchApprovedDoc'),
  prepareTrainingHandoff: wrapInvoke('learning:trainingHandoff'),
  exportLocalTraining: wrapInvoke('learning:localTrainingExport'),
};

const benchmarkApi = {
  list: wrapInvoke('ai:benchmarks:list'),
  run: wrapInvoke('ai:benchmarks:run'),
};

const tuningApi = {
  getStatus: wrapInvoke('tuning:getStatus'),
  startOllama: wrapInvoke('tuning:startOllama'),
  stopOllama: wrapInvoke('tuning:stopOllama'),
  importModels: wrapInvoke('tuning:importModels'),
  mergeCheckpoints: wrapInvoke('tuning:mergeCheckpoints'),
};

const foundryApi = {
  status: wrapInvoke('foundry:status'),
  seed: wrapInvoke('foundry:seed'),
};

const aiApi = {
  status: wrapInvoke('ai:status'),
  listProfiles: wrapInvoke('ai:profiles:list'),
  setProfile: wrapInvoke('ai:profiles:set'),
  getRouting: wrapInvoke('ai:routing:get'),
  setRouting: wrapInvoke('ai:routing:set'),
  listProviders: wrapInvoke('ai:providers:list'),
  discoverModels: wrapInvoke('ai:models:discover'),
  importModels: wrapInvoke('ai:models:import'),
  listBenchmarks: wrapInvoke('ai:benchmarks:list'),
  runBenchmark: wrapInvoke('ai:benchmarks:run'),
  getTelemetry: wrapInvoke('ai:telemetry'),
};

const monitorApi = {
  status: wrapInvoke('monitor:status'),
  events: wrapInvoke('monitor:events'),
  recordOperatorFeedback: wrapInvoke('monitor:recordOperatorFeedback'),
  runAcceptance: wrapInvoke('monitor:runAcceptance'),
  setSafeMode: wrapInvoke('monitor:setSafeMode'),
  debugBundle: wrapInvoke('monitor:debugBundle'),
};

const toolsApi = {
  list: wrapInvoke('tools:list'),
};

const integrationsApi = {
  list: wrapInvoke('integrations:list'),
  install: wrapInvoke('integrations:install'),
};

const layoutApi = {
  captureDiagnostics: wrapInvoke('layout:saveDiagnostics'),
};

const eventsApi = {
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
  onUpdateEvent: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('app:update-event', wrapped);
    return () => ipcRenderer.removeListener('app:update-event', wrapped);
  },
  onTuningImportEvent: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('tuning:import-event', wrapped);
    return () => ipcRenderer.removeListener('tuning:import-event', wrapped);
  },
  onLearningEvent: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('learning:event', wrapped);
    return () => ipcRenderer.removeListener('learning:event', wrapped);
  },
  onLabEvent: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('labs:event', wrapped);
    return () => ipcRenderer.removeListener('labs:event', wrapped);
  },
  onBenchmarkEvent: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('engine:benchmark-event', wrapped);
    return () => ipcRenderer.removeListener('engine:benchmark-event', wrapped);
  },
  onAssistantChatEvent: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('assistant:chat-event', wrapped);
    return () => ipcRenderer.removeListener('assistant:chat-event', wrapped);
  },
};

contextBridge.exposeInMainWorld('gosAgent', {
  app: appApi,
  agent: agentApi,
  review: reviewApi,
  git: gitApi,
  skills: skillsApi,
  goals: goalsApi,
  tasks: tasksApi,
  runs: runsApi,
  recipes: recipesApi,
  workspace: workspaceApi,
  automations: automationsApi,
  labs: labsApi,
  promotions: promotionsApi,
  updates: updatesApi,
  storage: storageApi,
  artifacts: artifactsApi,
  learning: learningApi,
  benchmarks: benchmarkApi,
  tuning: tuningApi,
  foundry: foundryApi,
  ai: aiApi,
  monitor: monitorApi,
  tools: toolsApi,
  integrations: integrationsApi,
  layout: layoutApi,
  events: eventsApi,

  bootstrap: appApi.bootstrap,
  bootstrapLite: appApi.bootstrapLite,
  getMeta: appApi.getMeta,
  getSettings: appApi.getSettings,
  chatMessage: agentApi.chatMessage,
  pickChatAttachments: agentApi.pickAttachments,
  pickWorkspace: appApi.pickWorkspace,
  setWorkspace: appApi.setWorkspace,
  setLab: appApi.setLab,
  updateSettings: appApi.updateSettings,
  reportRendererError: appApi.reportRendererError,

  setSecret: appApi.setSecret,
  getSecret: appApi.getSecret,
  startDevEngine: appApi.startDevEngine,

  preflight: agentApi.preflight,
  status: agentApi.status,
  plan: agentApi.plan,
  run: agentApi.run,
  implement: agentApi.implement,
  executeTaskLoop: agentApi.taskLoopExecute,
  retryTaskLoop: agentApi.taskLoopRetry,
  repairTaskLoop: agentApi.taskLoopRepair,
  getLatestTaskLoop: agentApi.taskLoopLatest,
  sprint: agentApi.sprint,
  autopilot: agentApi.autopilot,
  selfImprove: agentApi.selfImprove,
  train: agentApi.train,
  learn: agentApi.learn,
  repair: agentApi.repair,
  autopilotSchedulerStart: agentApi.autopilotSchedulerStart,
  autopilotSchedulerStop: agentApi.autopilotSchedulerStop,
  autopilotSchedulerStatus: agentApi.autopilotSchedulerStatus,
  cancel: agentApi.cancel,
  openLocation: agentApi.openLocation,
  getEditorContext: agentApi.getEditorContext,
  setEditorContextFocus: agentApi.setEditorContextFocus,

  getReviewSnapshot: reviewApi.getSnapshot,
  rememberReviewSelection: reviewApi.rememberSelection,
  readReviewFile: reviewApi.readFile,
  getReviewDiff: reviewApi.getDiff,
  saveReviewFile: reviewApi.saveFile,
  setReviewDecision: reviewApi.setDecision,
  copyReviewText: reviewApi.copyText,
  openInVsCode: reviewApi.openInVsCode,

  getGitSummary: gitApi.getSummary,
  getGitStatus: gitApi.getStatus,
  getGitDiff: gitApi.getDiff,
  stageGitPaths: gitApi.stage,
  unstageGitPaths: gitApi.unstage,
  stageAllGitPaths: gitApi.stageAll,
  unstageAllGitPaths: gitApi.unstageAll,
  discardGitPaths: gitApi.discardPaths,
  commitGitStaged: gitApi.commit,
  pullGitBranch: gitApi.pull,
  pushGitBranch: gitApi.push,
  listGitBranches: gitApi.listBranches,
  createGitBranch: gitApi.createBranch,
  switchGitBranch: gitApi.switchBranch,
  publishGitBranch: gitApi.publishBranch,

  listSkills: skillsApi.list,
  runSkill: skillsApi.run,
  listGoals: goalsApi.list,
  createGoal: goalsApi.create,
  updateGoal: goalsApi.update,
  listTasks: tasksApi.list,
  createTask: tasksApi.create,
  runTask: tasksApi.run,
  cancelTask: tasksApi.cancel,
  listRunsHub: runsApi.list,
  getRunHub: runsApi.get,
  listRecipes: recipesApi.list,
  queueFollowupRecipe: recipesApi.queueFollowup,
  queueTaskLoopNextActionFollowup: recipesApi.queueTaskLoopNextAction,
  runRecipe: recipesApi.run,
  getWorkspaceVsCodeStatus: workspaceApi.vscodeStatus,
  bootstrapWorkspaceVsCode: workspaceApi.vscodeBootstrap,
  installWorkspaceVsCodeCompanion: workspaceApi.vscodeInstallCompanion,
  openWorkspaceInVsCode: workspaceApi.vscodeOpen,

  listAutomations: automationsApi.list,
  getAutomationSettings: automationsApi.getSettings,
  saveAutomationSettings: automationsApi.saveSettings,
  upsertAutomation: automationsApi.upsert,
  toggleAutomation: automationsApi.toggle,
  removeAutomation: automationsApi.remove,
  runAutomationNow: automationsApi.runNow,

  listLabs: labsApi.list,
  createLab: labsApi.create,
  resetLab: labsApi.reset,
  destroyLab: labsApi.destroy,
  runLabRecipe: labsApi.runRecipe,
  listPromotions: promotionsApi.list,
  createCandidate: promotionsApi.createCandidate,
  promoteCandidate: promotionsApi.promote,
  rollbackPromotion: promotionsApi.rollback,
  getMonitorStatus: monitorApi.status,
  getMonitorEvents: monitorApi.events,
  recordOperatorFeedback: monitorApi.recordOperatorFeedback,
  runMonitorAcceptance: monitorApi.runAcceptance,
  setMonitorSafeMode: monitorApi.setSafeMode,
  exportMonitorDebugBundle: monitorApi.debugBundle,

  checkUpdates: updatesApi.check,
  planUpdates: updatesApi.plan,
  applyUpdates: updatesApi.apply,
  rollbackUpdates: updatesApi.rollback,
  listBackups: updatesApi.backups,
  buildBinaryUpdate: updatesApi.buildBinary,
  checkBinaryUpdates: updatesApi.checkBinary,
  downloadBinaryUpdate: updatesApi.downloadBinary,
  installBinaryUpdate: updatesApi.installBinary,
  promoteBinaryUpdate: updatesApi.promoteBinary,
  pruneBinaryUpdates: updatesApi.pruneBinary,
  cleanupStorage: storageApi.cleanup,
  openArtifactPath: artifactsApi.openPath,
  readArtifactPreview: artifactsApi.readPreview,
  getLearningChanges: learningApi.getChanges,
  getLearningStatus: learningApi.getStatus,
  exportLearningChanges: learningApi.exportChanges,
  getTuningStatus: tuningApi.getStatus,
  startOllama: tuningApi.startOllama,
  stopOllama: tuningApi.stopOllama,
  getModelFoundryStatus: foundryApi.status,
  seedModelFoundryCandidate: foundryApi.seed,
  getAiStatus: aiApi.status,
  listAiProfiles: aiApi.listProfiles,
  setAiProfile: aiApi.setProfile,
  getAiRouting: aiApi.getRouting,
  setAiRouting: aiApi.setRouting,
  listAiProviders: aiApi.listProviders,
  discoverAiModels: aiApi.discoverModels,
  importAiModels: aiApi.importModels,
  getAiTelemetry: aiApi.getTelemetry,
  listTools: toolsApi.list,
  listIntegrations: integrationsApi.list,
  installIntegration: integrationsApi.install,
  listBenchmarks: benchmarkApi.list,
  runBenchmark: benchmarkApi.run,

  onRunEvent: eventsApi.onRunEvent,
  onSchedulerEvent: eventsApi.onSchedulerEvent,
  onUpdateEvent: eventsApi.onUpdateEvent,
  onTuningImportEvent: eventsApi.onTuningImportEvent,
  onLearningEvent: eventsApi.onLearningEvent,
  onLabEvent: eventsApi.onLabEvent,
  onBenchmarkEvent: eventsApi.onBenchmarkEvent,
  onAssistantChatEvent: eventsApi.onAssistantChatEvent,
});
