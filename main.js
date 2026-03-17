

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  dialog,
  nativeImage,
  powerMonitor,
  shell,
  safeStorage,
} = require('electron');
const packageMeta = require('./package.json');
const APP_NAME = String(packageMeta.productName || 'GoSenderr Desktop Agent').trim() || 'GoSenderr Desktop Agent';
const APP_STORAGE_NAME = app.isPackaged ? APP_NAME : `${APP_NAME} Dev`;
app.setName(APP_NAME);
const requestedUserDataDir = String(process.env.DESKTOP_AGENT_USER_DATA_DIR || '').trim();
const requestedSessionDataDir = String(process.env.DESKTOP_AGENT_SESSION_DATA_DIR || '').trim();
const requestedCacheDir = String(process.env.DESKTOP_AGENT_CACHE_DIR || '').trim();
const requestedLocalStorageRoot = process.platform === 'win32'
  ? path.resolve(String(process.env.LOCALAPPDATA || '').trim() || app.getPath('temp'))
  : '';
function ensureAppStoragePath(pathName, targetPath) {
  const resolvedPath = path.resolve(String(targetPath || '').trim());
  if (!resolvedPath) {
    return '';
  }
  fs.mkdirSync(resolvedPath, { recursive: true });
  try {
    app.setPath(pathName, resolvedPath);
  } catch (_error) {
    return '';
  }
  return resolvedPath;
}
function bestEffortRemovePath(targetPath) {
  const resolvedPath = path.resolve(String(targetPath || '').trim());
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return;
  }
  try {
    fs.rmSync(resolvedPath, { recursive: true, force: true });
  } catch (_error) {
    // ignore cleanup failures
  }
}
function migrateLegacyCacheDirectories(legacyRoot, sessionDataRoot) {
  const resolvedLegacyRoot = path.resolve(String(legacyRoot || '').trim());
  const resolvedSessionRoot = path.resolve(String(sessionDataRoot || '').trim());
  if (!resolvedLegacyRoot || !resolvedSessionRoot || resolvedLegacyRoot === resolvedSessionRoot) {
    return;
  }
  for (const directoryName of ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache']) {
    const legacyPath = path.join(resolvedLegacyRoot, directoryName);
    const sessionPath = path.join(resolvedSessionRoot, directoryName);
    if (!fs.existsSync(legacyPath) || fs.existsSync(sessionPath)) {
      continue;
    }
    try {
      fs.renameSync(legacyPath, sessionPath);
    } catch (_error) {
      bestEffortRemovePath(legacyPath);
    }
  }
}
const resolvedUserDataDir = ensureAppStoragePath(
  'userData',
  requestedUserDataDir || (
    requestedLocalStorageRoot
      ? path.join(requestedLocalStorageRoot, APP_STORAGE_NAME, 'user-data')
      : app.getPath('userData')
  ),
) || (
  requestedLocalStorageRoot
    ? path.join(requestedLocalStorageRoot, APP_STORAGE_NAME, 'user-data')
    : app.getPath('userData')
);
const resolvedSessionDataDir = ensureAppStoragePath(
  'sessionData',
  requestedSessionDataDir || (
    requestedLocalStorageRoot
      ? path.join(requestedLocalStorageRoot, APP_STORAGE_NAME, 'session-data')
      : path.join(resolvedUserDataDir, 'session-data')
  ),
) || (
  requestedLocalStorageRoot
    ? path.join(requestedLocalStorageRoot, APP_STORAGE_NAME, 'session-data')
    : path.join(resolvedUserDataDir, 'session-data')
);
migrateLegacyCacheDirectories(resolvedUserDataDir, resolvedSessionDataDir);
const resolvedCacheDir = ensureAppStoragePath(
  'cache',
  requestedCacheDir || path.join(resolvedSessionDataDir, 'Cache'),
) || path.join(resolvedSessionDataDir, 'Cache');
app.commandLine.appendSwitch('disk-cache-dir', resolvedCacheDir);
app.commandLine.appendSwitch('media-cache-dir', resolvedCacheDir);
process.env.DESKTOP_AGENT_USER_DATA_DIR = resolvedUserDataDir;
process.env.DESKTOP_AGENT_SESSION_DATA_DIR = resolvedSessionDataDir;
process.env.DESKTOP_AGENT_CACHE_DIR = resolvedCacheDir;
const StoreModule = require('electron-store');
const Store = StoreModule.default || StoreModule;
const { createResilientStore } = require('./core/settings-store');
const {
  APP_ROOT,
  RUNTIME_ROOT,
  getSuggestedWorkspaceRoots,
  normalizeDirectory,
  resolveTargetWorkspaceRoot,
} = require('./core/app-roots');

// --- Dev Engine Integration ---
ipcMain.handle('devEngine:start', async (_event) => {
  try {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      return { ok: false, message: 'No target workspace configured.' };
    }
    const devEnginePath = path.join(workspaceRoot, 'tools', 'dev_engine', 'dev_engine_runner.js');
    if (!fs.existsSync(devEnginePath)) {
      return { ok: false, message: 'dev_engine_runner.js not found.' };
    }
    // Spawn the dev engine as a detached child process
    const child = childProcess.spawn(
      process.execPath,
      [devEnginePath],
      {
        cwd: path.dirname(devEnginePath),
        detached: true,
        stdio: 'ignore',
      }
    );
    child.unref();
    return { ok: true, message: 'Dev Engine started.' };
  } catch (err) {
    return { ok: false, message: err && err.message ? err.message : 'Failed to start Dev Engine.' };
  }
});

const { SharedAgentRuntime, mergeMemoryHints } = require('./shared-runtime/runtime');
const board = require('./core/board');
const parseBatBoard = board.parseBatBoard;
const summarizeBats = board.summarizeBats;
const parseAssistantRuns = board.parseAssistantRuns;
const parseFollowupBatReport =
  typeof board.parseFollowupBatReport === 'function' ? board.parseFollowupBatReport : () => null;
const parseLatestSprintSummary =
  typeof board.parseLatestSprintSummary === 'function' ? board.parseLatestSprintSummary : () => null;
const parseAssistantDashboard =
  typeof board.parseAssistantDashboard === 'function' ? board.parseAssistantDashboard : () => null;
const collectRuntimeApprovalSignals =
  typeof board.collectRuntimeApprovalSignals === 'function' ? board.collectRuntimeApprovalSignals : () => [];
const collectProtectedBatReviewSignals =
  typeof board.collectProtectedBatReviewSignals === 'function' ? board.collectProtectedBatReviewSignals : () => [];
const normalizeRuntimeContext =
  typeof board.normalizeRuntimeContext === 'function' ? board.normalizeRuntimeContext : () => ({});
const summarizeRunDetail =
  typeof board.summarizeRunDetail === 'function' ? board.summarizeRunDetail : () => ({});
const summarizeWorkspaceTopology =
  typeof board.summarizeWorkspaceTopology === 'function' ? board.summarizeWorkspaceTopology : () => ({});
const { listSkills, runSkill } = require('./core/skills');
const { listTools } = require('./core/tool-catalog');
const {
  listAutomations,
  upsertAutomation,
  toggleAutomation,
  removeAutomation,
  getAutopilotSettings,
  saveAutopilotSettings,
} = require('./core/automations');
const {
  checkForUpdates,
  buildUpdatePlan,
  applyUpdate,
  rollbackUpdate,
  listBackups,
  summarizeAutoUpdateSafety,
} = require('./core/updater');
const {
  SAFETY_LEVEL_PRESETS,
  applyAutonomyToRequest,
  applySafetyLevelToRequest,
  normalizeSafetyLevel,
  resolveAutonomySettings,
} = require('./core/autonomy');
const { applySafetyModeToRequest, buildSafetyStatus } = require('./core/safety-controller');
const { runPreflight } = require('./core/preflight');
const { sanitizeRelativePath } = require('./core/utils');
const { handleAssistantChat } = require('./core/chat');
const { buildStorageSnapshot, cleanupStorageArtifacts } = require('./core/storage');
const { listLabs, createLab, destroyLab, resetLab, runLabRecipe } = require('./core/labs');
const { listBenchmarkRuns, recordBenchmarkRun } = require('./core/benchmarks');
const { readLatestAcceptanceReport, runEngineAcceptanceSuite } = require('./core/engine-acceptance');
const { buildReviewerSummary } = require('./core/reviewer');
const { buildRegressionCandidates } = require('./core/regression-builder');
const { buildAutonomousActionSummary, buildTaskAutonomyAssessment } = require('./core/autonomous-actions');
const { buildSystemCheck, buildSelfImprovementSummary } = require('./core/system-check');
const { buildTestBenchSnapshot } = require('./core/test-bench');
const { buildMvpReadiness } = require('./core/mvp-readiness');
const {
  getDesktopAppRollbackRoot,
  installMacAppBundle,
  listArchivedAppBackups,
  migrateLegacyAppBackups,
} = require('./core/app-backup-archive');
const {
  AI_CAPABILITY_LANES,
  AI_BRIDGE_PROFILES,
  GS_DEV1_TASK_MODES,
  AI_ROUTING_POLICIES,
  buildAiStatus,
  listRemoteProviderSecretNames,
  normalizeLaneOverrides,
  normalizeProfileId,
  normalizeRemoteProviderId,
  normalizeRemoteProviderSecretName,
  normalizeRoutingPolicy,
  normalizeWrappedProfile,
  normalizeWrappedProfileId,
  resolveRemoteProviderPreset,
} = require('./core/ai-center');
const {
  buildIntegrationStudioStatus,
  installIntegration,
} = require('./core/integration-studio');
const {
  createCandidate,
  exportDebugBundle,
  listPromotionState,
  promoteCandidate,
  rollbackPromotion,
} = require('./core/promotions');
const { LearningJournalService } = require('./core/learning-journal');
const { buildVsCodeSetupStatus, bootstrapVsCodeWorkspace, installVsCodeCompanion } = require('./core/vscode-setup');
const { buildVsCodeExtensionHealth } = require('./core/vscode-extension-health');
const { buildModelFoundryStatus, seedModelFoundryCandidate } = require('./core/model-foundry');
const {
  completeTaskRun,
  createGoal,
  createGoalAndTask,
  createTask,
  findGoal,
  findTaskByFollowupSignature,
  findTask,
  inferIntentType,
  isActionablePrompt,
  listGoals,
  listRecipes,
  listRuns,
  listTasks,
  readHub,
  recordTaskRun,
  updateTask,
  updateGoal,
} = require('./core/task-hub');
const {
  buildAutoFollowupPlan,
  buildNextActionRecipe,
  buildQueuedRecipePayload,
  queueFollowupRecipeTasks,
} = require('./core/followup-recipes');
const {
  downloadLatestReleaseFromFeed,
  getStagedReleaseStatus,
  getStagedReleaseByVersion,
  getLiveChannelReleaseStatus,
  promoteLatestStagedRelease,
  pruneStagedReleases,
  listReleaseArtifacts,
  parseVersionFromName,
  stageDesktopReleaseArtifacts,
} = require('./core/desktop-release');
const {
  readAssistantConfig,
  safeBlockedReasonForBat,
  writeAssistantModelSettings,
  writeAssistantAutonomySettings,
} = require('./host/assistant-config');
const {
  readTrainingTuningSettings,
  writeTrainingTuningSettings,
  buildTrainingRunPayload,
  buildLearnRunPayload,
  buildSelfImproveRunPayload,
  buildTerminalTrainingCommand,
  buildModelDownloadCommand,
  buildModelInstallPresets,
  discoverStoredModels,
  HARDWARE_TARGET_PRESETS,
  normalizeHardwareTarget,
  RECOMMENDED_LOCAL_MODELS,
  resolveOllamaHomeRoot,
  resolveOllamaModelsRoot,
  collectTrainingTelemetry,
} = require('./core/training-tuning');
const {
  DesktopAgentRuntimeService,
  resolveTaskLoopLane,
} = require('./host/agent-runtime-service');
const {
  buildReviewSnapshot,
  readWorkspaceFile,
  saveWorkspaceFile,
  getWorkspaceDiff,
  summarizeUnifiedDiff,
  isApprovalRequiredPath,
  normalizeReviewPath,
} = require('./core/review');
const { buildApprovalQueue } = require('./core/approval-queue');
const { collectAutoApprovedDecisions } = require('./core/approval-auto');
const {
  applyDecision,
  findApprovalItem,
  normalizeReviewDecisions,
  normalizeReviewSelection,
  resolveSaveApproval,
} = require('./core/review-approval-state');
const {
  getAssistantRunsDir,
  getAssistantSchedulerLogPath,
  getConfiguredAssistantChatAttachmentsRoot,
  getConfiguredAssistantModelFoundryRoot,
} = require('./core/assistant-paths');
const {
  APPROVED_DOCUMENTATION_SOURCES,
  buildApprovedDocumentationVault,
  captureLayoutDiagnosticsArtifact,
  captureDesktopLearningRecord,
  fetchApprovedDocumentationSource,
  readDesktopArtifactPreview,
  readLatestApprovedDocumentationSource,
  readLatestDesktopTrainingHandoff,
  readLatestDesktopLearningRecord,
  readLatestLayoutDiagnosticsArtifact,
  recommendApprovedDocumentationSources,
  resolveDesktopArtifactPath,
} = require('./desktop-learning-records');

function defaultApprovalRequiredPath(relativePath) {
  const normalizedPath = String(relativePath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  if (!normalizedPath) {
    return false;
  }
  if (
    normalizedPath.startsWith('docs/assistant_runs/') ||
    normalizedPath.startsWith('assistant_runs/') ||
    normalizedPath.includes('/assistant_runs/')
  ) {
    return false;
  }
  if (normalizedPath === 'docs/dev_assistant_log_report.md') {
    return false;
  }
  return true;
}

const approvalRequiredPath = typeof isApprovalRequiredPath === 'function'
  ? isApprovalRequiredPath
  : defaultApprovalRequiredPath;

let keytarModule;
let electronAutoUpdater = null;
try {
  ({ autoUpdater: electronAutoUpdater } = require('electron-updater'));
} catch (_err) {
  electronAutoUpdater = null;
}

const DEFAULT_TARGET_WORKSPACE = resolveTargetWorkspaceRoot();
const SECRET_SERVICE = 'gosenderr-desktop-agent';
const UI_SMOKE_MODE = process.env.DESKTOP_AGENT_UI_SMOKE === '1';
const PACKAGED_SMOKE_MODE = process.env.DESKTOP_AGENT_PACKAGED_SMOKE === '1';
const HEADLESS_SMOKE_MODE = UI_SMOKE_MODE || PACKAGED_SMOKE_MODE;
const DEFAULT_UI_ZOOM = 0.9;
const UI_SMOKE_APPROVAL_FIXTURE_CANDIDATES = [
  'backend/alembic/versions/0005_wallet_transactions.py',
  'backend/alembic/versions/0013_network_pool_governance.py',
  'backend/tmp_chat_test.py',
  'renderer/index.html',
];

function shouldUseKeytar() {
  return !HEADLESS_SMOKE_MODE && process.env.DESKTOP_AGENT_DISABLE_KEYTAR !== '1';
}

function getKeytarModule() {
  if (!shouldUseKeytar()) {
    return null;
  }
  if (keytarModule !== undefined) {
    return keytarModule;
  }
  try {
    // optional native dependency
    // eslint-disable-next-line global-require
    keytarModule = require('keytar');
  } catch (_error) {
    keytarModule = null;
  }
  return keytarModule;
}

function nowIso() {
  return new Date().toISOString();
}

function getAutonomySettings(workspaceRoot) {
  const assistantConfig = workspaceRoot
    ? readAssistantConfig(workspaceRoot, { defaultWorkspace: DEFAULT_TARGET_WORKSPACE })
    : {};
  return resolveAutonomySettings({
    safetyLevel: assistantConfig.safetyLevel || store.get('safetyLevel'),
    autonomyMode: assistantConfig.autonomyMode || store.get('autonomyMode'),
    autoSynthesizeBats: assistantConfig.autoSynthesizeBats ?? store.get('autoSynthesizeBats'),
    autoRetryUntilPass: assistantConfig.autoRetryUntilPass ?? store.get('autoRetryUntilPass'),
    autoBrainstormOnFailure: assistantConfig.autoBrainstormOnFailure ?? store.get('autoBrainstormOnFailure'),
    autoApproveLowRisk: assistantConfig.autoApproveLowRisk ?? store.get('autoApproveLowRisk'),
    humanApprovalProtectedOnly: assistantConfig.humanApprovalProtectedOnly ?? store.get('humanApprovalProtectedOnly'),
    sandboxRequired: assistantConfig.sandboxRequired ?? store.get('sandboxRequired'),
    baselineSelfHealPriority: assistantConfig.baselineSelfHealPriority ?? store.get('baselineSelfHealPriority'),
    supervisedAutoRunRecipes: assistantConfig.supervisedAutoRunRecipes ?? store.get('supervisedAutoRunRecipes'),
    maxRetryRounds: assistantConfig.maxRetryRounds ?? store.get('maxRetryRounds'),
  });
}

function autonomyProfileId(mode) {
  switch (String(mode || '').trim().toLowerCase()) {
    case 'safe':
      return 'manual';
    case 'full':
      return 'builder';
    case 'self':
      return 'lab-full-auto';
    case 'guided':
    default:
      return 'supervised-auto';
  }
}

function safetyLevelOptions() {
  return Object.values(SAFETY_LEVEL_PRESETS).map((item) => ({
    id: item.id,
    label: item.label,
    summary: item.summary,
  }));
}

function autonomyModeFromProfile(profileId) {
  switch (String(profileId || '').trim().toLowerCase()) {
    case 'manual':
      return 'safe';
    case 'builder':
    case 'operator':
      return 'full';
    case 'lab-full-auto':
      return 'self';
    case 'custom':
    case 'supervised-auto':
    default:
      return 'guided';
  }
}

function normalizeSettingsUpdatePayload(payload = {}) {
  const normalized = {
    ...(payload && typeof payload === 'object' ? payload : {}),
  };
  for (const groupKey of ['ui', 'workspace', 'ai', 'autonomy', 'automations', 'labs', 'learning', 'storage']) {
    const group = payload?.[groupKey];
    if (group && typeof group === 'object') {
      Object.assign(normalized, group);
    }
  }
  if (payload?.workspace?.currentRoot && !normalized.workspaceRoot) {
    normalized.workspaceRoot = payload.workspace.currentRoot;
  }
  if (payload?.workspace?.selectedLabRoot !== undefined && normalized.selectedLabRoot === undefined) {
    normalized.selectedLabRoot = payload.workspace.selectedLabRoot;
  }
  if (payload?.ai?.profileId !== undefined && normalized.aiProfile === undefined) {
    normalized.aiProfile = payload.ai.profileId;
  }
  if (payload?.ai?.routingPolicy !== undefined && normalized.aiRoutingPolicy === undefined) {
    normalized.aiRoutingPolicy = payload.ai.routingPolicy;
  }
  if (payload?.ai?.laneOverrides !== undefined && normalized.aiLaneOverrides === undefined) {
    normalized.aiLaneOverrides = payload.ai.laneOverrides;
  }
  if (payload?.ai?.manualMode !== undefined && normalized.aiManualMode === undefined) {
    normalized.aiManualMode = payload.ai.manualMode;
  }
  if (payload?.ai?.bridgeProfile !== undefined && normalized.aiBridgeProfile === undefined) {
    normalized.aiBridgeProfile = payload.ai.bridgeProfile;
  }
  if (payload?.ai?.remoteProvider !== undefined && normalized.aiRemoteProvider === undefined) {
    normalized.aiRemoteProvider = payload.ai.remoteProvider;
  }
  if (payload?.ai?.remoteModel !== undefined && normalized.aiRemoteModel === undefined) {
    normalized.aiRemoteModel = payload.ai.remoteModel;
  }
  if (payload?.ai?.remoteBaseUrl !== undefined && normalized.aiRemoteBaseUrl === undefined) {
    normalized.aiRemoteBaseUrl = payload.ai.remoteBaseUrl;
  }
  if (payload?.ai?.remoteApiKeyName !== undefined && normalized.aiRemoteApiKeyName === undefined) {
    normalized.aiRemoteApiKeyName = payload.ai.remoteApiKeyName;
  }
  if (payload?.ai?.wrappedProfileId !== undefined && normalized.aiWrappedProfileId === undefined) {
    normalized.aiWrappedProfileId = payload.ai.wrappedProfileId;
  }
  if (payload?.ai?.workspaceWrappedProfileId !== undefined && normalized.aiWorkspaceWrappedProfileId === undefined) {
    normalized.aiWorkspaceWrappedProfileId = payload.ai.workspaceWrappedProfileId;
  }
  if (payload?.ai?.engineWrappedProfileId !== undefined && normalized.aiEngineWrappedProfileId === undefined) {
    normalized.aiEngineWrappedProfileId = payload.ai.engineWrappedProfileId;
  }
  if (payload?.ai?.wrappedProfiles !== undefined && normalized.aiWrappedProfiles === undefined) {
    normalized.aiWrappedProfiles = payload.ai.wrappedProfiles;
  }
  if (payload?.ai?.modelLabel !== undefined && normalized.model === undefined) {
    normalized.model = payload.ai.modelLabel;
  }
  if (payload?.autonomy?.profileId !== undefined && normalized.autonomyMode === undefined) {
    normalized.autonomyMode = autonomyModeFromProfile(payload.autonomy.profileId);
  }
  if (payload?.learning?.livePolling !== undefined && normalized.learningLivePolling === undefined) {
    normalized.learningLivePolling = payload.learning.livePolling;
  }
  if (payload?.ui?.chatInstructionMode !== undefined && normalized.chatInstructionMode === undefined) {
    normalized.chatInstructionMode = payload.ui.chatInstructionMode;
  }
  if (payload?.ui?.chatCustomInstructions !== undefined && normalized.chatCustomInstructions === undefined) {
    normalized.chatCustomInstructions = payload.ui.chatCustomInstructions;
  }
  if (payload?.ui?.chatWorkbenchMode !== undefined && normalized.chatWorkbenchMode === undefined) {
    normalized.chatWorkbenchMode = payload.ui.chatWorkbenchMode;
  }
  if (payload?.ui?.chatComposerSize !== undefined && normalized.chatComposerSize === undefined) {
    normalized.chatComposerSize = payload.ui.chatComposerSize;
  }
  return normalized;
}

function getDesktopSettingsPayload(workspaceRoot) {
  const tuningSettings = readTrainingTuningSettings(workspaceRoot || APP_ROOT);
  const autonomy = getAutonomySettings(workspaceRoot);
  const labs = workspaceRoot ? listLabs(workspaceRoot) : { labs: [], labsRoot: '' };
  const benchmarks = workspaceRoot ? listBenchmarkRuns(workspaceRoot) : { runs: [], benchmarkRoot: '' };
  const learning = learningJournal.getStatus();
  const appRollbackRoot = getDesktopAppRollbackRoot(workspaceRoot || '', 'darwin');
  const archivedAppBackups = listArchivedAppBackups(workspaceRoot || '', 'darwin');
  const aiProfile = normalizeProfileId(store.get('aiProfile'));
  const aiRoutingPolicy = normalizeRoutingPolicy(store.get('aiRoutingPolicy'), aiProfile);
  const aiLaneOverrides = normalizeLaneOverrides(store.get('aiLaneOverrides'));
  const aiManualMode = store.get('aiManualMode') === true;
  const aiBridgeProfile = String(store.get('aiBridgeProfile') || 'llama-bridge').trim().toLowerCase() || 'llama-bridge';
  const aiRemoteProvider = normalizeRemoteProviderId(store.get('aiRemoteProvider'));
  const aiRemoteProviderPreset = resolveRemoteProviderPreset({
    aiRemoteProvider,
    aiRemoteBaseUrl: store.get('aiRemoteBaseUrl'),
    aiRemoteApiKeyName: store.get('aiRemoteApiKeyName'),
  });
  const aiWrappedProfileId = normalizeWrappedProfileId(store.get('aiWrappedProfileId'));
  const aiWorkspaceWrappedProfileId = normalizeWrappedProfileId(store.get('aiWorkspaceWrappedProfileId') || aiWrappedProfileId);
  const aiEngineWrappedProfileId = normalizeWrappedProfileId(store.get('aiEngineWrappedProfileId') || 'gse-1-engine');
  const aiWrappedProfiles = Array.isArray(store.get('aiWrappedProfiles'))
    ? store.get('aiWrappedProfiles').map((profile) => normalizeWrappedProfile(profile))
    : [];
  const resolvedLocalAiCmd = getConfiguredLocalAiCmd();
  const ui = {
    theme: String(store.get('theme') || 'linen'),
    layoutPreset: String(store.get('layoutPreset') || 'balanced'),
    surfaceTemplate: String(store.get('surfaceTemplate') || 'board'),
    safeLayoutMode: !!store.get('safeLayoutMode'),
    startInChatWorkspace: !!store.get('startInChatWorkspace'),
    chatInspectorCollapsed: store.get('chatInspectorCollapsed') !== false,
    chatInspectorWidth: Math.max(320, Math.min(620, Math.round(Number(store.get('chatInspectorWidth') || 380)))),
    chatUtilityMode: String(store.get('chatUtilityMode') || 'context'),
    showLiveWork: !!store.get('showLiveWork'),
    chatInstructionMode: String(store.get('chatInstructionMode') || 'auto').trim().toLowerCase() || 'auto',
    chatCustomInstructions: String(store.get('chatCustomInstructions') || ''),
    chatWorkbenchMode: String(store.get('chatWorkbenchMode') || 'focus').trim().toLowerCase() || 'focus',
    chatComposerSize: String(store.get('chatComposerSize') || 'tall').trim().toLowerCase() || 'tall',
  };
  return {
    model: store.get('model'),
    mode: store.get('mode'),
    theme: ui.theme,
    runtime: store.get('runtime'),
    localAiCmd: resolvedLocalAiCmd,
    localAiCmdManual: store.get('localAiCmd'),
    aiManualMode,
    aiBridgeProfile,
    aiRemoteProvider,
    aiRemoteModel: String(store.get('aiRemoteModel') || '').trim(),
    aiRemoteBaseUrl: String(aiRemoteProviderPreset.baseUrl || '').trim(),
    aiRemoteApiKeyName: String(aiRemoteProviderPreset.apiKeyName || '').trim(),
    aiWrappedProfileId,
    aiWorkspaceWrappedProfileId,
    aiEngineWrappedProfileId,
    aiWrappedProfiles,
    githubEnabled: !!store.get('githubEnabled'),
    autoUpdateEnabled: !!store.get('autoUpdateEnabled'),
    autoUpdateAutoApply: !!store.get('autoUpdateAutoApply'),
    autoUpdateIntervalMinutes: Math.max(5, Number(store.get('autoUpdateIntervalMinutes') || 30)),
    safetyLevel: autonomy.safetyLevel || normalizeSafetyLevel(store.get('safetyLevel')),
    releaseFeedUrl: String(store.get('releaseFeedUrl') || ''),
    releaseAutoDownload: !!store.get('releaseAutoDownload'),
    aiProfile,
    aiRoutingPolicy,
    aiLaneOverrides,
    chatInstructionMode: ['off', 'auto', 'custom'].includes(ui.chatInstructionMode) ? ui.chatInstructionMode : 'auto',
    chatCustomInstructions: ui.chatCustomInstructions,
    chatWorkbenchMode: ['focus', 'balanced', 'control-room'].includes(ui.chatWorkbenchMode) ? ui.chatWorkbenchMode : 'focus',
    chatComposerSize: ['comfortable', 'tall'].includes(ui.chatComposerSize) ? ui.chatComposerSize : 'tall',
    learningLivePolling: !!store.get('learningLivePolling'),
    autoQueueTaskLoopFollowups: autonomy.autoQueueTaskLoopFollowups === true,
    autoRunQueuedTaskLoopFollowups: autonomy.autoRunQueuedTaskLoopFollowups === true,
    ...tuningSettings,
    ...autonomy,
    ui,
    workspace: buildWorkspaceSelectionPayload(workspaceRoot),
    ai: {
      profileId: aiProfile,
      routingPolicy: aiRoutingPolicy,
      routingPolicies: AI_ROUTING_POLICIES,
      laneOverrides: aiLaneOverrides,
      capabilityLanes: AI_CAPABILITY_LANES,
      runtime: store.get('runtime'),
      modelLabel: store.get('model'),
      localAiCmd: resolvedLocalAiCmd,
      localAiCmdManual: store.get('localAiCmd'),
      manualMode: aiManualMode,
      bridgeProfile: aiBridgeProfile,
      remoteProvider: aiRemoteProvider,
      remoteModel: String(store.get('aiRemoteModel') || '').trim(),
      remoteBaseUrl: String(aiRemoteProviderPreset.baseUrl || '').trim(),
      remoteApiKeyName: String(aiRemoteProviderPreset.apiKeyName || '').trim(),
      wrappedProfileId: aiWrappedProfileId,
      workspaceWrappedProfileId: aiWorkspaceWrappedProfileId,
      engineWrappedProfileId: aiEngineWrappedProfileId,
      wrappedProfiles: aiWrappedProfiles,
      taskModes: GS_DEV1_TASK_MODES,
      bridgeProfiles: AI_BRIDGE_PROFILES,
      catalog: Array.isArray(tuningSettings.recommendedModels) ? tuningSettings.recommendedModels : RECOMMENDED_LOCAL_MODELS,
      hardwareTargets: HARDWARE_TARGET_PRESETS,
      ...tuningSettings,
    },
    autonomy: {
      ...autonomy,
      profileId: autonomyProfileId(autonomy.autonomyMode),
      safetyLevel: autonomy.safetyLevel || normalizeSafetyLevel(store.get('safetyLevel')),
      safetyLevels: safetyLevelOptions(),
      supervisedAutoRunRecipes: autonomy.supervisedAutoRunRecipes === true,
      autoQueueTaskLoopFollowups: autonomy.autoQueueTaskLoopFollowups === true,
      autoRunQueuedTaskLoopFollowups: autonomy.autoRunQueuedTaskLoopFollowups === true,
    },
    automations: workspaceRoot ? getAutopilotSettings(workspaceRoot) : {},
    labs: {
      selectedLabRoot: getSelectedLabRoot(),
      currentTargetRoot: getTargetWorkspaceRoot(),
      labsRoot: labs.labsRoot || '',
    },
    learning: {
      ...learning,
      livePolling: !!store.get('learningLivePolling'),
    },
    promotions: workspaceRoot ? listPromotionState(workspaceRoot, { labRoot: getSelectedLabRoot() }) : { candidates: [], backups: [], history: [] },
    storage: {
      runsDir: workspaceRoot ? getAssistantRunsDir(workspaceRoot) : '',
      schedulerLogPath: workspaceRoot ? getAssistantSchedulerLogPath(workspaceRoot) : '',
      labsRoot: labs.labsRoot || '',
      benchmarkRoot: benchmarks.benchmarkRoot || '',
      modelFoundryRoot: workspaceRoot ? getConfiguredAssistantModelFoundryRoot(workspaceRoot) : '',
      journalPath: learning.journalPath || '',
      appRollbackRoot,
      appRollbackCount: archivedAppBackups.length,
    },
  };
}

function getDesktopDashboardLayoutPayload() {
  const layoutPreset = String(store.get('layoutPreset') || 'balanced').trim().toLowerCase();
  const surfaceTemplate = String(store.get('surfaceTemplate') || 'board').trim().toLowerCase();
  const chatUtilityMode = String(store.get('chatUtilityMode') || 'context').trim().toLowerCase();
  const chatInspectorWidth = Math.max(320, Math.min(620, Math.round(Number(store.get('chatInspectorWidth') || 380))));
  return {
    layoutPreset: ['balanced', 'focus', 'review', 'compact-review', 'summary'].includes(layoutPreset)
      ? layoutPreset
      : 'balanced',
    surfaceTemplate: ['board', 'split', 'stacked', 'dense'].includes(surfaceTemplate)
      ? surfaceTemplate
      : 'board',
    safeLayoutMode: !!store.get('safeLayoutMode'),
    startInChatWorkspace: store.get('startInChatWorkspace') !== false,
    chatInspectorCollapsed: store.get('chatInspectorCollapsed') !== false,
    chatInspectorWidth,
    chatUtilityMode: ['context', 'diff', 'review'].includes(chatUtilityMode) ? chatUtilityMode : 'context',
    showLiveWork: store.get('showLiveWork') !== false,
  };
}

function prioritizeBatsForSafeMode(workspaceRoot, bats) {
  const assistantConfig = readAssistantConfig(workspaceRoot, { defaultWorkspace: DEFAULT_TARGET_WORKSPACE });
  return (Array.isArray(bats) ? bats : [])
    .map((item, index) => {
      const safeBlockedReason = safeBlockedReasonForBat(item, assistantConfig);
      return {
        ...item,
        safeBlockedReason,
        safeActionable: String(item.status || '').includes('TODO') && !safeBlockedReason,
        _sortIndex: index,
      };
    })
    .sort((left, right) => {
      const leftTodo = String(left.status || '').includes('TODO') ? 0 : 1;
      const rightTodo = String(right.status || '').includes('TODO') ? 0 : 1;
      if (leftTodo !== rightTodo) {
        return leftTodo - rightTodo;
      }
      const leftProtected = left.safeBlockedReason ? 1 : 0;
      const rightProtected = right.safeBlockedReason ? 1 : 0;
      if (leftProtected !== rightProtected) {
        return leftProtected - rightProtected;
      }
      return Number(left._sortIndex || 0) - Number(right._sortIndex || 0);
    })
    .map(({ _sortIndex, ...item }) => item);
}

function nextActionableTodoBat(workspaceRoot) {
  const bats = prioritizeBatsForSafeMode(workspaceRoot, parseBatBoard(workspaceRoot));
  return bats.find((item) => item.safeActionable) || bats.find((item) => String(item.status || '').includes('TODO')) || null;
}

const store = createResilientStore(Store, {
  userDataRoot: app.getPath('userData'),
  name: 'desktop-agent-settings',
  defaults: {
    workspaceRoot: '',
    selectedLabRoot: '',
    model: 'Qwen2.5-Coder-7B (Local)',
    mode: 'Extra High',
    theme: 'linen',
    layoutPreset: 'balanced',
    surfaceTemplate: 'board',
    safeLayoutMode: false,
    startInChatWorkspace: true,
    chatInspectorCollapsed: true,
    chatInspectorWidth: 380,
    chatUtilityMode: 'context',
    showLiveWork: true,
    chatInstructionMode: 'auto',
    chatCustomInstructions: '',
    chatWorkbenchMode: 'focus',
    chatComposerSize: 'tall',
    runtime: 'ollama',
    localAiCmd: '',
    aiManualMode: false,
    aiBridgeProfile: 'llama-bridge',
    aiRemoteProvider: 'openai',
    aiRemoteModel: 'gpt-4o-mini',
    aiRemoteBaseUrl: '',
    aiRemoteApiKeyName: '',
    aiWrappedProfileId: 'gs-dev-1-default',
    aiWorkspaceWrappedProfileId: 'gs-dev-1-default',
    aiEngineWrappedProfileId: 'gse-1-engine',
    aiWrappedProfiles: [],
    aiProfile: 'hybrid-default',
    aiRoutingPolicy: 'hybrid-default',
    learningLivePolling: false,
    aiLaneOverrides: {},
    githubEnabled: false,
    reviewDecisions: {},
    reviewSelection: {},
    autoUpdateEnabled: false,
    autoUpdateAutoApply: false,
    autoUpdateIntervalMinutes: 30,
    safetyLevel: 'supervised-auto',
    releaseFeedUrl: '',
    releaseAutoDownload: false,
    autonomyMode: 'guided',
    autoSynthesizeBats: true,
    autoRetryUntilPass: true,
    autoBrainstormOnFailure: true,
    autoApproveLowRisk: true,
    humanApprovalProtectedOnly: true,
    sandboxRequired: true,
    baselineSelfHealPriority: true,
    supervisedAutoRunRecipes: false,
    autoQueueTaskLoopFollowups: true,
    autoRunQueuedTaskLoopFollowups: false,
    maxRetryRounds: 2,
    stabilityProfileVersion: 2,
  },
});

function applyStabilityProfileMigration() {
  const currentVersion = Number(store.get('stabilityProfileVersion') || 0);
  if (currentVersion >= 2) {
    return;
  }
  store.set('learningLivePolling', false);
  store.set('autoUpdateEnabled', false);
  store.set('autoUpdateAutoApply', false);
  store.set('releaseAutoDownload', false);
  store.set('stabilityProfileVersion', 2);
}

let mainWindow = null;
let uiSmokeApprovalFixtureWorkspace = '';
let latestUpdateStatus = {
  state: 'idle',
  message: 'Auto-update standby.',
  checkedAt: null,
  hasUpdates: false,
  trigger: 'startup',
  workspace: {
    state: 'idle',
    message: 'Auto-update standby.',
    checkedAt: null,
    hasUpdates: false,
    trigger: 'startup',
  },
  binary: {
    state: 'idle',
    message: 'Binary release updates are not configured yet.',
    checkedAt: null,
    configured: false,
    downloaded: false,
    version: app.getVersion(),
  },
};
let autoUpdateTimer = null;
let binaryUpdaterInitialized = false;
let binaryAutoInstallScheduled = false;
let lastBroadcastUpdateSignature = '';
let tuningImportState = {
  running: false,
  status: 'idle',
  workspaceRoot: '',
  startedAt: null,
  finishedAt: null,
  total: 0,
  completed: 0,
  percent: 0,
  currentModel: '',
  message: 'No model import is running.',
  imported: [],
  skipped: [],
};
const MONITOR_EVENT_LIMIT = 80;
const monitorEventBuffers = {
  runtime: [],
  scheduler: [],
  updates: [],
  learning: [],
  labs: [],
  benchmarks: [],
};
let latestTaskLoopSession = {
  request: null,
  latestExecution: null,
};

function pushMonitorEvent(kind, payload = {}) {
  const bucket = monitorEventBuffers[kind];
  if (!Array.isArray(bucket)) {
    return;
  }
  bucket.unshift({
    recordedAt: nowIso(),
    ...((payload && typeof payload === 'object') ? payload : { message: String(payload || '') }),
  });
  monitorEventBuffers[kind] = bucket.slice(0, MONITOR_EVENT_LIMIT);
}

function clipOperatorText(value, maxChars = 1200) {
  return String(value || '').slice(-maxChars);
}

function normalizeOperatorExecutionPayload(value = {}) {
  return value && typeof value === 'object' ? value : {};
}

function normalizeOperatorExecutionList(value = []) {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object')
    : [];
}

function buildOperatorExecutionDevLoopFields(run = {}, operatorExecution = {}) {
  return {
    taskObjective: normalizeOperatorExecutionPayload(operatorExecution.taskObjective || run.taskObjective || {}),
    failureClass: normalizeOperatorExecutionPayload(operatorExecution.failureClass || run.failureClass || {}),
    recoveryLadder: normalizeOperatorExecutionPayload(operatorExecution.recoveryLadder || run.recoveryLadder || {}),
    checkpointRef: normalizeOperatorExecutionPayload(operatorExecution.checkpointRef || run.checkpointRef || {}),
    interruptRequest: normalizeOperatorExecutionPayload(operatorExecution.interruptRequest || run.interruptRequest || {}),
    reviewBundle: normalizeOperatorExecutionPayload(operatorExecution.reviewBundle || run.reviewBundle || {}),
    workbenchArtifacts: normalizeOperatorExecutionList(operatorExecution.workbenchArtifacts || run.workbenchArtifacts || []),
  };
}

function summarizeOperatorExecutionFromRun(run = {}) {
  const operatorExecution = normalizeOperatorExecutionPayload(run.operatorExecution || {});
  const devLoopFields = buildOperatorExecutionDevLoopFields(run, operatorExecution);
  if (Object.keys(operatorExecution).length > 0) {
    return {
      ...operatorExecution,
      ...devLoopFields,
      task: String(operatorExecution.task || run.task || '').trim(),
      laneId: String(operatorExecution.laneId || run.laneId || '').trim(),
      laneLabel: String(operatorExecution.laneLabel || run.laneLabel || '').trim(),
      taskMode: String(operatorExecution.taskMode || run.taskMode || '').trim(),
      modelProfileId: String(operatorExecution.modelProfileId || run.modelProfileId || '').trim(),
      modelRole: String(operatorExecution.modelRole || run.modelRole || '').trim(),
      modelDisplayName: String(operatorExecution.modelDisplayName || run.modelDisplayName || '').trim(),
      baseModel: String(operatorExecution.baseModel || run.baseModel || '').trim(),
      providerSource: String(operatorExecution.providerSource || run.providerSource || '').trim(),
      outputTail: {
        combined: clipOperatorText(operatorExecution.outputTail?.combined || run.logTail || ''),
        stdout: clipOperatorText(operatorExecution.outputTail?.stdout || run.stdoutTail || ''),
        stderr: clipOperatorText(operatorExecution.outputTail?.stderr || run.stderrTail || ''),
      },
    };
  }
  const runtimeContext = normalizeRuntimeContext(run.runtimeContext || {});
  const changedFiles = Array.isArray(runtimeContext.changed_files)
    ? runtimeContext.changed_files
    : (Array.isArray(runtimeContext.changedFiles) ? runtimeContext.changedFiles : []);
  const resultSummary = String(
    run.reviewSummary?.summary
    || run.runSummary?.summary
    || run.testSummary?.summary
    || run.ownerSummary?.summary
    || run.blockedReason
    || '',
  ).trim();
  return {
    ...devLoopFields,
    task: String(run.task || run.label || '').trim(),
    laneId: String(run.laneId || '').trim(),
    laneLabel: String(run.laneLabel || '').trim(),
    taskMode: String(run.taskMode || '').trim(),
    action: String(run.action || '').trim(),
    modelProfileId: String(run.modelProfileId || '').trim(),
    modelRole: String(run.modelRole || '').trim(),
    modelDisplayName: String(run.modelDisplayName || '').trim(),
    baseModel: String(run.baseModel || '').trim(),
    providerSource: String(run.providerSource || '').trim(),
    ticket: String(run.ticket || '').trim(),
    runId: String(run.runId || '').trim(),
    status: String(run.state || '').trim(),
    runState: String(run.state || '').trim(),
    stageSummary: {
      currentStage: String(run.runtimeRun?.currentStage || run.runtimeRun?.current_stage || 'runtime'),
      summary: resultSummary,
      finalState: String(run.runtimeResult?.finalState || run.runtimeResult?.final_state || run.state || ''),
    },
    resultSummary,
    diffSummary: '',
    changedFiles: changedFiles.map((item) => ({
      path: String(item?.path || '').trim(),
      status: String(item?.status || '').trim(),
    })).filter((item) => item.path),
    changedFileCount: changedFiles.length,
    outputTail: {
      combined: clipOperatorText(run.logTail || ''),
      stdout: clipOperatorText(run.stdoutTail || ''),
      stderr: clipOperatorText(run.stderrTail || ''),
    },
    reviewSummary: run.reviewSummary || {},
    trustSummary: run.trustSummary || {},
    runSummary: run.runSummary || {},
    testSummary: run.testSummary || {},
    benchmarkMetadata: {
      experimentBenchmarkSummary: run.experimentBenchmarkSummary || {},
      ownerExperimentSummary: run.ownerExperimentSummary || {},
    },
    learningMetadata: {
      trainingHandoff: run.trainingHandoff || {},
    },
    retryAvailable: ['fail', 'cancelled', 'skipped'].includes(String(run.state || '').toLowerCase()),
    repairAvailable: !!String(run.ticket || '').trim(),
    artifactPaths: Array.isArray(run.artifactPaths) ? run.artifactPaths : [],
  };
}

function buildTaskLoopPayload({ request = null, execution = null, ok = false, message = '' } = {}) {
  const operatorExecution = normalizeOperatorExecutionPayload(execution || {});
  const devLoopFields = buildOperatorExecutionDevLoopFields({}, operatorExecution);
  return {
    ok,
    message: String(message || operatorExecution.resultSummary || operatorExecution.stageSummary?.summary || '').trim(),
    laneId: String(request?.laneId || '').trim(),
    laneLabel: String(request?.laneLabel || '').trim(),
    task: String(operatorExecution.task || request?.task || '').trim(),
    taskMode: String(operatorExecution.taskMode || request?.taskMode || '').trim(),
    action: String(operatorExecution.action || request?.action || '').trim(),
    runId: String(operatorExecution.runId || request?.runId || '').trim(),
    status: String(operatorExecution.status || '').trim(),
    runState: String(operatorExecution.runState || '').trim(),
    stageSummary: operatorExecution.stageSummary || {},
    resultSummary: String(operatorExecution.resultSummary || '').trim(),
    diffSummary: String(operatorExecution.diffSummary || '').trim(),
    changedFiles: Array.isArray(operatorExecution.changedFiles) ? operatorExecution.changedFiles : [],
    changedFileCount: Number(operatorExecution.changedFileCount || 0),
    outputTail: operatorExecution.outputTail || { combined: '', stdout: '', stderr: '' },
    reviewSummary: operatorExecution.reviewSummary || {},
    trustSummary: operatorExecution.trustSummary || {},
    runSummary: operatorExecution.runSummary || {},
    testSummary: operatorExecution.testSummary || {},
    benchmarkMetadata: operatorExecution.benchmarkMetadata || {},
    learningMetadata: operatorExecution.learningMetadata || {},
    taskObjective: devLoopFields.taskObjective,
    failureClass: devLoopFields.failureClass,
    recoveryLadder: devLoopFields.recoveryLadder,
    checkpointRef: devLoopFields.checkpointRef,
    interruptRequest: devLoopFields.interruptRequest,
    reviewBundle: devLoopFields.reviewBundle,
    workbenchArtifacts: devLoopFields.workbenchArtifacts,
    retryAvailable: operatorExecution.retryAvailable === true,
    repairAvailable: operatorExecution.repairAvailable === true,
    artifactPaths: Array.isArray(operatorExecution.artifactPaths) ? operatorExecution.artifactPaths : [],
    operatorExecution,
  };
}

function latestTaskLoopExecution() {
  const latestRuntime = runtime.getStatus()?.latest?.[0] || null;
  if (latestTaskLoopSession.latestExecution && typeof latestTaskLoopSession.latestExecution === 'object') {
    return latestTaskLoopSession.latestExecution;
  }
  if (!latestRuntime) {
    return null;
  }
  return summarizeOperatorExecutionFromRun(latestRuntime);
}
const runtime = new SharedAgentRuntime({
  workspaceRoot: getWorkspaceRoot(),
  pythonRelative: 'backend/.venv/bin/python',
});
const agentRuntimeService = new DesktopAgentRuntimeService({
  runtime,
  getWorkspaceRoot,
  setWorkspaceRoot,
  getSelectedLabRoot,
  buildEditorContext: buildDesktopEditorContext,
  readAssistantConfig: (workspaceRoot) => readAssistantConfig(workspaceRoot, { defaultWorkspace: DEFAULT_TARGET_WORKSPACE }),
  getAutonomySettings,
  applyAutonomyToRequest,
  getSafetyStatus: ({ workspaceRoot, targetWorkspaceRoot, labRoot, assistantConfig }) => buildSafetyStatus({
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
    appRoot: APP_ROOT,
    assistantConfig: assistantConfig || readAssistantConfig(workspaceRoot, { defaultWorkspace: DEFAULT_TARGET_WORKSPACE }),
    baseline: parseAssistantDashboard(targetWorkspaceRoot || workspaceRoot)?.baseline || {},
    latestRuntime: runtime.getStatus()?.latest?.[0] || null,
    backups: listBackups(workspaceRoot),
    promotions: listPromotionState(workspaceRoot, { labRoot }),
    schedulerRunning: !!schedulerStatusPayload().running,
  }),
});
const learningJournal = new LearningJournalService({
  getTelemetry: async ({ workspace }) => {
    const settings = readTrainingTuningSettings(workspace || getWorkspaceRoot());
    const runtimeStatus = runtime.getStatus();
    return collectTrainingTelemetry({
      settings,
      activeRuns: Array.isArray(runtimeStatus?.activeRuns) ? runtimeStatus.activeRuns.length : 0,
      schedulerRunning: !!schedulerStatusPayload().running,
    });
  },
  getSystemIdleTime: () => {
    try {
      return typeof powerMonitor.getSystemIdleTime === 'function' ? powerMonitor.getSystemIdleTime() : 0;
    } catch (_error) {
      return 0;
    }
  },
  getActiveRunCount: () => {
    const status = runtime.getStatus();
    return Array.isArray(status?.activeRuns) ? status.activeRuns.length : 0;
  },
  getTrainingSettings: (workspaceRoot) => readTrainingTuningSettings(workspaceRoot || getWorkspaceRoot()),
  runLearnAction: async (payload) => runTunedAction('learn', payload),
});

function updateLearningJournalScope(payload = {}) {
  const roots = resolveRequestRoots(payload);
  return learningJournal.setScope({
    workspaceRoot: roots.workspaceRoot,
    targetRoot: roots.targetWorkspaceRoot,
    labRoot: roots.labRoot,
    threadId: payload.threadId || '',
    changeSessionId: payload.changeSessionId || '',
    pollingEnabled: payload.pollingEnabled === true || (payload.pollingEnabled !== false && !!store.get('learningLivePolling')),
  });
}

runtime.on('run-event', (event) => {
  if (event && typeof event === 'object' && event.operatorExecution && typeof event.operatorExecution === 'object') {
    latestTaskLoopSession.latestExecution = summarizeOperatorExecutionFromRun(event);
  }
  if (event && event.state && ['pass', 'fail', 'skipped', 'cancelled'].includes(String(event.state))) {
    const operatorExecution = event.operatorExecution && typeof event.operatorExecution === 'object'
      ? event.operatorExecution
      : {};
    const taskHubCompletion = completeTaskRun(String(event.workspaceRoot || getWorkspaceRoot() || '').trim(), {
      runId: event.runId,
      status: event.state,
      summary: operatorExecution.resultSummary || event.blockedReason || event.label || '',
      reviewSummary: event.reviewSummary || {},
    });
    learningJournal.recordEvent('run-complete', {
      runId: event.runId,
      label: event.label,
      state: event.state,
      artifactPaths: Array.isArray(event.artifactPaths) ? event.artifactPaths : [],
      approvalCount: Array.isArray(event.approvalRequests) ? event.approvalRequests.length : 0,
      trustSignalCount: Number(event.trustSignalCount || 0),
      reviewSummary: event.reviewSummary || {},
      reviewBundle: operatorExecution.reviewBundle || {},
      failureClass: operatorExecution.failureClass || {},
      nextAction: operatorExecution.nextAction || {},
      changedFiles: Array.isArray(operatorExecution.changedFiles) ? operatorExecution.changedFiles : [],
      taskObjective: operatorExecution.taskObjective || {},
      trusted: String(event.state || '').toLowerCase() === 'pass'
        && (Number(event.trustSignalCount || 0) > 0 || (Array.isArray(event.approvalRequests) ? event.approvalRequests.length === 0 : true)),
    });
    if (taskHubCompletion?.ok && taskHubCompletion.selfHostExpansion) {
      learningJournal.recordEvent('self-host-expansion', {
        runId: event.runId,
        taskId: taskHubCompletion.selfHostExpansion.taskId,
        verdict: taskHubCompletion.selfHostExpansion.outcome,
        summary: taskHubCompletion.selfHostExpansion.summary,
        trusted: String(taskHubCompletion.selfHostExpansion.outcome || '').trim().toLowerCase() === 'pass',
      });
    }
  }
  pushMonitorEvent('runtime', event);
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('agent:run-event', event);
});

runtime.on('scheduler-event', (event) => {
  sendSchedulerEvent(event);
});

function sendSchedulerEvent(payload) {
  pushMonitorEvent('scheduler', payload);
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('agent:scheduler-event', payload);
}

function sendUpdateEvent(payload) {
  pushMonitorEvent('updates', payload);
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const signature = JSON.stringify({
    state: String(payload?.state || ''),
    message: String(payload?.message || ''),
    hasUpdates: !!payload?.hasUpdates,
    trigger: String(payload?.trigger || ''),
    workspace: {
      state: String(payload?.workspace?.state || ''),
      message: String(payload?.workspace?.message || ''),
      hasUpdates: !!payload?.workspace?.hasUpdates,
      trigger: String(payload?.workspace?.trigger || ''),
      upstream: String(payload?.workspace?.details?.upstream || ''),
      behind: Number(payload?.workspace?.details?.behind || 0),
    },
    binary: {
      state: String(payload?.binary?.state || ''),
      message: String(payload?.binary?.message || ''),
      downloaded: !!payload?.binary?.downloaded,
      configured: !!payload?.binary?.configured,
      version: String(payload?.binary?.version || ''),
      availableVersion: String(payload?.binary?.availableVersion || ''),
      feedUrl: String(payload?.binary?.feedUrl || ''),
      progressPercent: Math.round(Number(payload?.binary?.progressPercent || 0)),
    },
  });
  if (signature === lastBroadcastUpdateSignature) {
    return;
  }
  lastBroadcastUpdateSignature = signature;
  mainWindow.webContents.send('app:update-event', payload);
}

function sendLearningEvent(payload) {
  pushMonitorEvent('learning', payload);
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('learning:event', payload);
}

function sendLabEvent(payload) {
  pushMonitorEvent('labs', payload);
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('labs:event', payload);
}

function sendBenchmarkEvent(payload) {
  pushMonitorEvent('benchmarks', payload);
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('engine:benchmark-event', payload);
}

learningJournal.on('learning-event', (payload) => {
  sendLearningEvent(payload);
});

function snapshotTuningImportState() {
  return {
    ...tuningImportState,
    imported: Array.isArray(tuningImportState.imported) ? [...tuningImportState.imported] : [],
    skipped: Array.isArray(tuningImportState.skipped) ? [...tuningImportState.skipped] : [],
  };
}

function sendTuningImportEvent(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('tuning:import-event', payload);
}

function updateTuningImportState(patch = {}) {
  tuningImportState = {
    ...tuningImportState,
    ...patch,
  };
  const snapshot = snapshotTuningImportState();
  sendTuningImportEvent(snapshot);
  return snapshot;
}

function syncCombinedUpdateStatus() {
  const workspace = latestUpdateStatus.workspace || {};
  latestUpdateStatus = {
    ...latestUpdateStatus,
    message: workspace.message || latestUpdateStatus.message,
    checkedAt: workspace.checkedAt || latestUpdateStatus.checkedAt,
    hasUpdates: !!workspace.hasUpdates,
  };
  sendUpdateEvent(latestUpdateStatus);
  return latestUpdateStatus;
}

function updateStatusSnapshot(payload = {}) {
  latestUpdateStatus = {
    ...latestUpdateStatus,
    workspace: {
      ...latestUpdateStatus.workspace,
      ...payload,
      checkedAt: payload.checkedAt || nowIso(),
    },
  };
  return syncCombinedUpdateStatus();
}

function binaryUpdateStatusSnapshot(payload = {}) {
  latestUpdateStatus = {
    ...latestUpdateStatus,
    binary: {
      ...latestUpdateStatus.binary,
      ...payload,
      checkedAt: payload.checkedAt || nowIso(),
    },
  };
  sendUpdateEvent(latestUpdateStatus);
  return latestUpdateStatus.binary;
}

function activeRunCount() {
  const status = runtime.getStatus();
  return Array.isArray(status?.activeRuns) ? status.activeRuns.length : 0;
}

function autoUpdateSettings() {
  return {
    enabled: !!store.get('autoUpdateEnabled'),
    autoApply: !!store.get('autoUpdateAutoApply'),
    intervalMinutes: Math.max(5, Number(store.get('autoUpdateIntervalMinutes') || 30)),
  };
}

function binaryUpdateSettings() {
  const workspaceRoot = getWorkspaceRoot();
  return {
    enabled: true,
    feedUrl: String(store.get('releaseFeedUrl') || '').trim(),
    autoDownload: !!store.get('releaseAutoDownload'),
    staged: getStagedReleaseStatus(workspaceRoot),
    live: getLiveChannelReleaseStatus(workspaceRoot),
  };
}

function binaryAutoInstallEnabled() {
  const workspaceSettings = autoUpdateSettings();
  const binarySettings = binaryUpdateSettings();
  return workspaceSettings.enabled && workspaceSettings.autoApply && binarySettings.autoDownload;
}

function evaluateBinaryAutoInstallReadiness() {
  if (!binaryAutoInstallEnabled()) {
    return { ok: false, reason: 'Binary auto-install is disabled.' };
  }
  if (!electronAutoUpdater) {
    return { ok: false, reason: 'Binary updater dependency is unavailable.' };
  }
  if (String(latestUpdateStatus.binary?.localArtifactPath || '').trim()) {
    return { ok: false, reason: 'A staged desktop installer is ready, but staged installers still require manual install.' };
  }
  if (!latestUpdateStatus.binary?.downloaded) {
    return { ok: false, reason: 'No downloaded desktop release is ready to install.' };
  }
  if (activeRunCount() > 0) {
    return { ok: false, reason: 'Desktop release install deferred until active runs finish.' };
  }
  return { ok: true };
}

function maybeAutoInstallBinaryUpdate(trigger = 'binary-check') {
  const readiness = evaluateBinaryAutoInstallReadiness();
  if (!readiness.ok) {
    if (latestUpdateStatus.binary?.downloaded && !binaryAutoInstallScheduled) {
      binaryUpdateStatusSnapshot({
        state: 'downloaded',
        message: readiness.reason,
        configured: true,
        downloaded: true,
        trigger,
        availableVersion: latestUpdateStatus.binary?.availableVersion || '',
        version: app.getVersion(),
      });
    }
    return { ok: false, deferred: true, reason: readiness.reason };
  }
  if (binaryAutoInstallScheduled) {
    return { ok: true, scheduled: true, message: 'Desktop release install is already scheduled.' };
  }
  binaryAutoInstallScheduled = true;
  binaryUpdateStatusSnapshot({
    state: 'installing',
    message: 'Installing downloaded desktop release automatically…',
    configured: true,
    downloaded: true,
    trigger,
    availableVersion: latestUpdateStatus.binary?.availableVersion || '',
    version: app.getVersion(),
  });
  setTimeout(() => {
    electronAutoUpdater.quitAndInstall(false, true);
  }, 250);
  return { ok: true, scheduled: true, message: 'Restarting to install desktop release.' };
}

function schedulerStatusPayload() {
  return agentRuntimeService.schedulerStatus();
}

function isSafetySensitiveRun(run = {}) {
  const haystack = `${String(run?.action || '')} ${String(run?.label || '')} ${String(run?.ticket || '')}`.toLowerCase();
  return /(autopilot|self-improve|train|learn|benchmark|implement|repair|sprint|run)/.test(haystack);
}

async function startAutopilotScheduler(payload = {}) {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const { targetWorkspaceRoot, labRoot } = resolveRequestRoots(payload);
  const safetyLevel = evaluateSafetyLevelGuard('autopilot', {
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
    ...payload,
  });
  if (safetyLevel.blocked) {
    return {
      ok: false,
      blocked: true,
      blockedBy: 'safety-level',
      message: safetyLevel.message || 'The current safety level blocked the autopilot scheduler.',
    };
  }
  const safety = await evaluateHardSafety('autopilot', {
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
  });
  if (safety.applied.blocked) {
    return {
      ok: false,
      blocked: true,
      blockedBy: 'safe-mode',
      message: safety.applied.message || 'Safety guardrails blocked the autopilot scheduler.',
      safetyStatus: safety.safeMode,
    };
  }
  return agentRuntimeService.startScheduler(payload);
}

function stopAutopilotScheduler() {
  return agentRuntimeService.stopScheduler();
}

async function setManualSafeMode(payload = {}) {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const enable = payload.enabled !== false;
  const currentAutonomy = getAutonomySettings(workspaceRoot);
  const nextSafetyLevel = enable
    ? normalizeSafetyLevel(payload.safetyLevel || (currentAutonomy.safetyLevel === 'locked' ? 'locked' : 'guarded'))
    : normalizeSafetyLevel(payload.safetyLevel || currentAutonomy.safetyLevel || store.get('safetyLevel'));

  const schedulerBefore = schedulerStatusPayload();
  const cancelledRuns = [];
  if (enable) {
    if (schedulerBefore.running) {
      stopAutopilotScheduler();
    }
    const runtimeStatus = runtime.getStatus();
    const activeRuns = Array.isArray(runtimeStatus?.activeRuns) ? runtimeStatus.activeRuns : [];
    for (const activeRun of activeRuns) {
      if (!activeRun?.runId || !isSafetySensitiveRun(activeRun)) {
        continue;
      }
      const result = runtime.cancel(activeRun.runId);
      cancelledRuns.push({
        runId: String(activeRun.runId || ''),
        ok: result?.ok !== false,
        label: String(activeRun.label || activeRun.action || activeRun.runId || 'run'),
      });
    }
  }

  writeAssistantAutonomySettings(workspaceRoot, {
    safeMode: enable,
    safetyLevel: enable ? nextSafetyLevel : undefined,
  }, { defaultWorkspace: DEFAULT_TARGET_WORKSPACE });
  if (enable) {
    store.set('safetyLevel', nextSafetyLevel);
  }

  const safeMode = getSafetyStatusSnapshot({
    workspaceRoot,
    targetWorkspaceRoot: getTargetWorkspaceRoot(),
    labRoot: getSelectedLabRoot(),
    latestRuntime: runtime.getStatus()?.latest?.[0] || null,
    baseline: parseAssistantDashboard(getTargetWorkspaceRoot() || workspaceRoot)?.baseline || {},
    assistantConfig: readAssistantConfig(workspaceRoot, { defaultWorkspace: DEFAULT_TARGET_WORKSPACE }),
  });
  pushMonitorEvent('updates', {
    type: enable ? 'safe-mode-engaged' : 'safe-mode-released',
    timestamp: nowIso(),
    status: enable ? 'warn' : 'ready',
    message: enable
      ? `Hard safe mode engaged. ${cancelledRuns.length} run(s) cancelled${schedulerBefore.running ? ' and scheduler stopped' : ''}.`
      : 'Manual safe mode released. Safety level remains under operator control.',
  });
  return {
    ok: true,
    enabled: enable,
    safetyLevel: nextSafetyLevel,
    stoppedScheduler: enable && !!schedulerBefore.running,
    cancelledRuns,
    safeMode,
    snapshot: workspaceSnapshot(),
  };
}

async function runLearnPipeline(payload = {}) {
  return agentRuntimeService.runLearnPipeline(payload);
}

function runRepairLoop(payload = {}) {
  return agentRuntimeService.runRepairLoop(payload);
}

function buildLocalStagedBinaryStatus(settings = binaryUpdateSettings()) {
  const latest = settings?.staged?.latest || null;
  const releaseDir = settings?.staged?.releaseDir || '';
  const live = settings?.live || {};
  if (!latest) {
    if (live.latest) {
      return {
        state: 'ready',
        message: `Live desktop update channel is set to ${live.latest.version || live.latest.name}.`,
        configured: true,
        downloaded: false,
        localStaged: false,
        localArtifactPath: '',
        localReleaseDir: releaseDir,
        liveChannelDir: live.channelDir || '',
        liveVersion: live.latest.version || '',
        liveManifestPath: live.manifestPath || '',
        livePromotedAt: live.promotedAt || '',
        stagedHistory: Array.isArray(settings?.staged?.history) ? settings.staged.history : [],
        liveHistory: Array.isArray(live.history) ? live.history : [],
        version: app.getVersion(),
      };
    }
    return null;
  }
  return {
    state: 'downloaded',
    message: `Local staged release ${latest.version || latest.name} is ready to install.`,
    configured: true,
    downloaded: true,
    localStaged: true,
    localArtifactPath: latest.fullPath,
    localReleaseDir: releaseDir,
    liveChannelDir: live.channelDir || '',
    liveVersion: live.latest?.version || '',
    liveManifestPath: live.manifestPath || '',
    livePromotedAt: live.promotedAt || '',
    stagedHistory: Array.isArray(settings?.staged?.history) ? settings.staged.history : [],
    liveHistory: Array.isArray(live.history) ? live.history : [],
    availableVersion: latest.version || '',
    version: app.getVersion(),
  };
}

function initializeBinaryUpdater() {
  const settings = binaryUpdateSettings();
  const localStagedStatus = buildLocalStagedBinaryStatus(settings);
  if (!electronAutoUpdater) {
    if (localStagedStatus) {
      return binaryUpdateStatusSnapshot(localStagedStatus);
    }
    return binaryUpdateStatusSnapshot({
      state: 'unsupported',
      message: 'Binary updater dependency is unavailable in this build.',
      configured: false,
      downloaded: false,
      version: app.getVersion(),
    });
  }

  if (!settings.feedUrl) {
    if (localStagedStatus) {
      return binaryUpdateStatusSnapshot(localStagedStatus);
    }
    return binaryUpdateStatusSnapshot({
      state: 'idle',
      message: 'Set a release feed URL or stage a local desktop release to enable app updates.',
      configured: false,
      downloaded: false,
      version: app.getVersion(),
    });
  }

  if (!binaryUpdaterInitialized) {
    binaryUpdaterInitialized = true;
    electronAutoUpdater.on('checking-for-update', () => {
      binaryUpdateStatusSnapshot({
        state: 'checking',
        message: 'Checking desktop release feed…',
        configured: true,
        downloaded: false,
        version: app.getVersion(),
      });
    });
    electronAutoUpdater.on('update-available', (info) => {
      binaryUpdateStatusSnapshot({
        state: 'available',
        message: `Desktop release ${info?.version || 'unknown'} is available.`,
        configured: true,
        downloaded: false,
        availableVersion: info?.version || '',
        version: app.getVersion(),
      });
    });
    electronAutoUpdater.on('update-not-available', () => {
      binaryUpdateStatusSnapshot({
        state: 'ready',
        message: 'Desktop app is already on the latest release.',
        configured: true,
        downloaded: false,
        version: app.getVersion(),
      });
    });
    electronAutoUpdater.on('download-progress', (progress) => {
      binaryUpdateStatusSnapshot({
        state: 'downloading',
        message: `Downloading desktop release… ${Math.round(Number(progress?.percent || 0))}%`,
        configured: true,
        downloaded: false,
        progressPercent: Number(progress?.percent || 0),
        version: app.getVersion(),
      });
    });
    electronAutoUpdater.on('update-downloaded', (info) => {
      binaryUpdateStatusSnapshot({
        state: 'downloaded',
        message: `Desktop release ${info?.version || 'unknown'} downloaded. Install when ready.`,
        configured: true,
        downloaded: true,
        availableVersion: info?.version || '',
        version: app.getVersion(),
      });
      maybeAutoInstallBinaryUpdate('binary-downloaded');
    });
    electronAutoUpdater.on('error', (error) => {
      binaryUpdateStatusSnapshot({
        state: 'failed',
        message: error?.message || 'Desktop release check failed.',
        configured: true,
        downloaded: false,
        version: app.getVersion(),
      });
    });
  }

  electronAutoUpdater.autoDownload = settings.autoDownload;
  electronAutoUpdater.autoInstallOnAppQuit = false;
  try {
    electronAutoUpdater.setFeedURL({ provider: 'generic', url: settings.feedUrl });
  } catch (error) {
    return binaryUpdateStatusSnapshot({
      state: 'failed',
      message: error?.message || 'Invalid desktop release feed configuration.',
      configured: false,
      downloaded: false,
      version: app.getVersion(),
    });
  }

  return binaryUpdateStatusSnapshot({
    state: localStagedStatus?.state || (latestUpdateStatus.binary?.downloaded ? 'downloaded' : 'ready'),
    message: localStagedStatus?.message || (latestUpdateStatus.binary?.downloaded
      ? latestUpdateStatus.binary.message
      : 'Desktop release feed connected.'),
    configured: true,
    downloaded: !!(localStagedStatus?.downloaded || latestUpdateStatus.binary?.downloaded),
    feedUrl: settings.feedUrl,
    localStaged: !!localStagedStatus,
    localArtifactPath: localStagedStatus?.localArtifactPath || '',
    localReleaseDir: localStagedStatus?.localReleaseDir || '',
    liveChannelDir: localStagedStatus?.liveChannelDir || settings.live?.channelDir || '',
    liveVersion: localStagedStatus?.liveVersion || settings.live?.latest?.version || '',
    liveManifestPath: localStagedStatus?.liveManifestPath || settings.live?.manifestPath || '',
    livePromotedAt: localStagedStatus?.livePromotedAt || settings.live?.promotedAt || '',
    stagedHistory: Array.isArray(localStagedStatus?.stagedHistory) ? localStagedStatus.stagedHistory : (Array.isArray(settings.staged?.history) ? settings.staged.history : []),
    liveHistory: Array.isArray(localStagedStatus?.liveHistory) ? localStagedStatus.liveHistory : (Array.isArray(settings.live?.history) ? settings.live.history : []),
    availableVersion: localStagedStatus?.availableVersion || latestUpdateStatus.binary?.availableVersion || '',
    autoDownload: settings.autoDownload,
    version: app.getVersion(),
  });
}

async function checkBinaryForUpdates() {
  const settings = binaryUpdateSettings();
  initializeBinaryUpdater();
  if (settings?.staged?.latest) {
    return latestUpdateStatus.binary;
  }
  if (!settings.feedUrl || !electronAutoUpdater) {
    return latestUpdateStatus.binary;
  }
  try {
    await electronAutoUpdater.checkForUpdates();
  } catch (error) {
    binaryUpdateStatusSnapshot({
      state: 'failed',
      message: error?.message || 'Desktop release check failed.',
      configured: true,
      downloaded: false,
      version: app.getVersion(),
    });
  }
  maybeAutoInstallBinaryUpdate('binary-check');
  return latestUpdateStatus.binary;
}

async function downloadBinaryUpdateNow() {
  const workspaceRoot = getWorkspaceRoot();
  const settings = binaryUpdateSettings();
  initializeBinaryUpdater();
  if (!settings.feedUrl) {
    return { ok: false, message: 'Set a release feed URL before downloading a desktop release.' };
  }
  if (settings?.staged?.latest) {
    const refreshed = initializeBinaryUpdater();
    return {
      ok: true,
      message: `A staged desktop release is already available: ${path.basename(settings.staged.latest.fullPath)}.`,
      ...refreshed,
    };
  }

  binaryUpdateStatusSnapshot({
    state: 'downloading',
    message: 'Downloading desktop release into the staged release folder…',
    configured: true,
    downloaded: false,
    feedUrl: settings.feedUrl,
    version: app.getVersion(),
  });

  try {
    const result = await downloadLatestReleaseFromFeed(workspaceRoot, {
      feedUrl: settings.feedUrl,
      releaseDir: settings?.staged?.releaseDir || undefined,
    });
    if (!result.ok) {
      binaryUpdateStatusSnapshot({
        state: 'failed',
        message: result.message || 'Unable to download desktop release.',
        configured: true,
        downloaded: false,
        feedUrl: settings.feedUrl,
        version: app.getVersion(),
      });
      return result;
    }
    const pruned = pruneStagedReleases(workspaceRoot, { releaseDir: result.releaseDir });
    const refreshed = initializeBinaryUpdater();
    return {
      ok: true,
      message: `${result.message} ${pruned.message}`.trim(),
      ...refreshed,
    };
  } catch (error) {
    binaryUpdateStatusSnapshot({
      state: 'failed',
      message: error?.message || 'Unable to download desktop release.',
      configured: true,
      downloaded: false,
      feedUrl: settings.feedUrl,
      version: app.getVersion(),
    });
    return {
      ok: false,
      message: error?.message || 'Unable to download desktop release.',
    };
  }
}

function runCommandCapture(command, args, cwd, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      cwd,
      env: { ...process.env, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        ok: Number(code || 0) === 0,
        exitCode: Number(code || 0),
        stdout,
        stderr,
      });
    });
  });
}

function resolveRuntimeApiPython(workspaceRoot) {
  const candidates = [
    path.join(workspaceRoot, 'backend', '.venv', 'bin', 'python'),
    path.join(workspaceRoot, 'backend', 'virtualenv', 'bin', 'python'),
    path.join(APP_ROOT, '.venv', 'bin', 'python'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return 'python3';
}

async function runRuntimeApiAction(workspaceRoot, request) {
  if (!workspaceRoot) {
    return {
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: 'No target workspace configured.',
      payload: { ok: false, error: 'No target workspace configured.' },
    };
  }
  const pythonCommand = resolveRuntimeApiPython(workspaceRoot);
  const runtimeRequest = {
    ...request,
    targetWorkspaceRoot: workspaceRoot,
    projectRoot: request?.projectRoot || workspaceRoot,
    workspace: request?.workspace || workspaceRoot,
  };
  const result = await runCommandCapture(
    pythonCommand,
    ['-m', 'backend.agent.runtime.runtime_api', 'action', '--payload-json', JSON.stringify(runtimeRequest)],
    RUNTIME_ROOT,
    {
      PROJECT_ROOT: workspaceRoot,
      PYTHONPATH: [RUNTIME_ROOT, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter),
    },
  );
  const raw = String(result.stdout || '').trim();
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch (_err) {
      payload = {};
    }
  }
  return {
    ok: result.ok && payload.ok !== false,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    payload,
  };
}

async function prepareDesktopTrainingHandoff(workspaceRoot, payload = {}) {
  const request = {
    action: 'training-handoff',
    workspace: workspaceRoot,
    targetWorkspaceRoot: workspaceRoot,
    projectRoot: workspaceRoot,
    ...(payload || {}),
  };
  const result = await runRuntimeApiAction(workspaceRoot, request);
  if (!result.ok) {
    return {
      ok: false,
      message: result.payload.error || result.stderr || 'Unable to prepare training handoff.',
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  return {
    ok: true,
    message: result.payload.summary || 'Prepared training handoff.',
    outputPath: result.payload.outputPath || null,
    artifactPaths: Array.isArray(result.payload.artifactPaths) ? result.payload.artifactPaths : [],
    handoff: result.payload.handoff || {},
    datasetPath: result.payload.datasetPath || null,
  };
}

async function exportDesktopLocalTrainingBundle(workspaceRoot, payload = {}) {
  const request = {
    action: 'train',
    workspace: workspaceRoot,
    targetWorkspaceRoot: workspaceRoot,
    projectRoot: workspaceRoot,
    repoRoot: workspaceRoot,
    assistantOnly: payload.assistantOnly !== false,
    localExportFormat: payload.format || 'qwen-ollama',
    localBaseModel: payload.baseModel || process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b',
  };
  const result = await runRuntimeApiAction(workspaceRoot, request);
  if (!result.ok) {
    return {
      ok: false,
      message: result.payload.error || result.stderr || 'Unable to export local training bundle.',
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      localExport: {},
    };
  }
  const localExport = result.payload.localExport && typeof result.payload.localExport === 'object' ? result.payload.localExport : {};
  return {
    ok: true,
    message: localExport.bundle_dir || localExport.bundleDir
      ? `Local Qwen/Ollama export ready at ${localExport.bundle_dir || localExport.bundleDir}.`
      : (result.payload.summary || 'Exported local training bundle.'),
    outputPath: result.payload.outputPath || null,
    localExport,
    qualityGate: result.payload.qualityGate || {},
  };
}

async function buildBinaryReleaseNow() {
  const workspaceRoot = getWorkspaceRoot();
  const settings = binaryUpdateSettings();
  initializeBinaryUpdater();

  if (!workspaceRoot) {
    return { ok: false, message: 'No target workspace configured for desktop release staging.' };
  }

  if (process.platform !== 'darwin') {
    return { ok: false, message: 'Building the Mac desktop release is only supported on macOS.' };
  }

  const desktopAgentRoot = APP_ROOT;
  const packageJsonPath = path.join(desktopAgentRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return { ok: false, message: `Desktop agent project was not found at ${desktopAgentRoot}.` };
  }

  binaryUpdateStatusSnapshot({
    state: 'building',
    message: 'Building downloadable desktop release…',
    configured: true,
    downloaded: !!settings?.staged?.latest,
    feedUrl: settings.feedUrl,
    localStaged: !!settings?.staged?.latest,
    localReleaseDir: settings?.staged?.releaseDir || '',
    liveChannelDir: settings?.live?.channelDir || '',
    liveVersion: settings?.live?.latest?.version || '',
    stagedHistory: Array.isArray(settings?.staged?.history) ? settings.staged.history : [],
    liveHistory: Array.isArray(settings?.live?.history) ? settings.live.history : [],
    version: app.getVersion(),
  });

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    const result = await runCommandCapture(npmCommand, ['run', 'release:mac'], desktopAgentRoot);
    if (!result.ok) {
      const failureMessage = String(result.stderr || result.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]
        || 'Desktop release build failed.';
      binaryUpdateStatusSnapshot({
        state: 'failed',
        message: failureMessage,
        configured: true,
        downloaded: !!settings?.staged?.latest,
        feedUrl: settings.feedUrl,
        version: app.getVersion(),
      });
      return {
        ok: false,
        message: failureMessage,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    const refreshed = initializeBinaryUpdater();
    return {
      ok: true,
      message: refreshed?.localArtifactPath
        ? `Built and staged desktop release ${path.basename(refreshed.localArtifactPath)}.`
        : 'Built and staged a new desktop release.',
      stdout: result.stdout,
      stderr: result.stderr,
      ...refreshed,
    };
  } catch (error) {
    binaryUpdateStatusSnapshot({
      state: 'failed',
      message: error?.message || 'Desktop release build failed.',
      configured: true,
      downloaded: !!settings?.staged?.latest,
      feedUrl: settings.feedUrl,
      version: app.getVersion(),
    });
    return {
      ok: false,
      message: error?.message || 'Desktop release build failed.',
    };
  }
}

function installBinaryUpdateNow(payload = {}) {
  const requestedVersion = String(payload?.version || payload?.selectedVersion || '').trim();
  let localArtifactPath = String(latestUpdateStatus.binary?.localArtifactPath || '').trim();
  if (requestedVersion) {
    const selected = getStagedReleaseByVersion(getWorkspaceRoot(), requestedVersion);
    if (!selected?.preferred?.fullPath) {
      return {
        ok: false,
        message: `Staged desktop release ${requestedVersion} was not found. Refresh Update Center and try again.`,
        version: requestedVersion,
      };
    }
    localArtifactPath = selected.preferred.fullPath;
  }
  if (localArtifactPath) {
    const opened = shell.openPath(localArtifactPath);
    return Promise.resolve(opened).then((result) => ({
      ok: result === '',
      message: result || `Opened staged desktop release${requestedVersion ? ` ${requestedVersion}` : ''}: ${path.basename(localArtifactPath)}`,
      path: localArtifactPath,
      version: requestedVersion || parseVersionFromName(path.basename(localArtifactPath)),
    }));
  }
  if (!electronAutoUpdater) {
    return { ok: false, message: 'Binary updater dependency is unavailable.' };
  }
  if (!latestUpdateStatus.binary?.downloaded) {
    return { ok: false, message: 'No downloaded desktop release is ready to install.' };
  }
  binaryUpdateStatusSnapshot({
    state: 'installing',
    message: 'Installing desktop release and restarting…',
    configured: true,
    downloaded: true,
    version: app.getVersion(),
  });
  setTimeout(() => {
    electronAutoUpdater.quitAndInstall(false, true);
  }, 150);
  return { ok: true, message: 'Restarting to install desktop release.' };
}

function runAutoUpdateCycle(options = {}) {
  const { trigger = 'interval', allowApply = true } = options;
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    return updateStatusSnapshot({
      state: 'blocked',
      message: 'No workspace configured for auto-updates.',
      trigger,
      hasUpdates: false,
    });
  }

  updateStatusSnapshot({
    state: 'checking',
    message: 'Checking for workspace updates…',
    trigger,
    hasUpdates: false,
  });

  const check = checkForUpdates(workspaceRoot);
  if (!check.ok) {
    return updateStatusSnapshot({
      state: 'blocked',
      message: check.reason || check.stderr || 'Unable to check updates.',
      trigger,
      hasUpdates: false,
      details: check,
    });
  }

  if (!check.hasUpdates) {
    return updateStatusSnapshot({
      state: 'ready',
      message: check.reason || 'Workspace is up to date.',
      trigger,
      hasUpdates: false,
      details: check,
    });
  }

  const settings = autoUpdateSettings();
  updateStatusSnapshot({
    state: 'available',
    message: `${check.behind || 0} update(s) available from ${check.upstream || 'upstream'}.`,
    trigger,
    hasUpdates: true,
    details: check,
  });

  if (!allowApply || !settings.enabled || !settings.autoApply) {
    return latestUpdateStatus;
  }
  if (activeRunCount() > 0) {
    return updateStatusSnapshot({
      state: 'deferred',
      message: 'Updates deferred until active runs finish.',
      trigger,
      hasUpdates: true,
      details: check,
    });
  }
  if (!repoIsClean(workspaceRoot)) {
    return updateStatusSnapshot({
      state: 'deferred',
      message: 'Updates deferred because the workspace is not clean.',
      trigger,
      hasUpdates: true,
      details: check,
    });
  }

  const plan = buildUpdatePlan(workspaceRoot);
  const safety = plan.ok ? summarizeAutoUpdateSafety(plan.files || []) : { safe: false, blockedFiles: [] };
  if (!plan.ok) {
    return updateStatusSnapshot({
      state: 'failed',
      message: plan.reason || 'Unable to build update plan.',
      trigger,
      hasUpdates: true,
      details: plan,
    });
  }
  if (!safety.safe) {
    return updateStatusSnapshot({
      state: 'deferred',
      message: `Updates deferred because ${safety.blockedFiles.length} file(s) need manual review.`,
      trigger,
      hasUpdates: true,
      details: {
        ...plan,
        safety,
      },
    });
  }

  updateStatusSnapshot({
    state: 'applying',
    message: 'Applying safe auto-update…',
    trigger,
    hasUpdates: true,
    details: {
      ...plan,
      safety,
    },
  });
  const applied = applyUpdate(workspaceRoot, { confirm: true, rollbackOnFailedVerify: true });
  if (!applied.ok) {
    return updateStatusSnapshot({
      state: 'failed',
      message: applied.error || 'Auto-update failed.',
      trigger,
      hasUpdates: true,
      details: applied,
    });
  }
  return updateStatusSnapshot({
    state: applied.updated ? 'updated' : 'ready',
    message: applied.updated ? 'Workspace updated successfully.' : (applied.message || 'Workspace already up to date.'),
    trigger,
    hasUpdates: false,
    details: applied,
  });
}

function restartAutoUpdateMonitor() {
  if (autoUpdateTimer) {
    clearInterval(autoUpdateTimer);
    autoUpdateTimer = null;
  }
  const settings = autoUpdateSettings();
  if (!settings.enabled) {
    updateStatusSnapshot({
      state: 'idle',
      message: 'Auto-update monitoring is disabled.',
      trigger: 'settings',
      hasUpdates: false,
    });
    return;
  }
  updateStatusSnapshot({
    state: 'idle',
    message: 'Background update checks are paused. Use Sync or Update Center to check manually.',
    trigger: 'settings',
    hasUpdates: !!latestUpdateStatus.hasUpdates,
  });
}

function getWorkspaceRoot() {
  const configured = normalizeDirectory(store.get('workspaceRoot'));
  return configured || resolveTargetWorkspaceRoot();
}

function getSelectedLabRoot() {
  return normalizeDirectory(store.get('selectedLabRoot'));
}

function getTargetWorkspaceRoot() {
  return getSelectedLabRoot() || getWorkspaceRoot();
}

function setSelectedLabRoot(nextRoot) {
  const normalized = normalizeDirectory(nextRoot);
  if (!normalized) {
    store.set('selectedLabRoot', '');
    return '';
  }
  store.set('selectedLabRoot', normalized);
  return normalized;
}

function clearSelectedLabRoot() {
  store.set('selectedLabRoot', '');
  return '';
}

function resolveRequestRoots(payload = {}) {
  const workspaceRoot = payload.workspaceRoot
    ? setWorkspaceRoot(payload.workspaceRoot)
    : getWorkspaceRoot();
  const requestedLabRoot = payload.clearLab
    ? ''
    : (payload.labRoot !== undefined ? setSelectedLabRoot(payload.labRoot) : getSelectedLabRoot());
  const requestedTarget = normalizeDirectory(
    payload.targetWorkspaceRoot
    || payload.targetRoot
    || payload.projectRoot
    || payload.workspace
    || requestedLabRoot,
  );
  const targetWorkspaceRoot = requestedTarget || requestedLabRoot || workspaceRoot;
  return {
    workspaceRoot,
    labRoot: requestedLabRoot || '',
    targetWorkspaceRoot,
  };
}

function setWorkspaceRoot(nextRoot) {
  const root = normalizeDirectory(nextRoot);
  if (!root) {
    throw new Error('Workspace path does not exist.');
  }
  store.set('workspaceRoot', root);
  runtime.setWorkspaceRoot(root);
  if (getSelectedLabRoot() && !fs.existsSync(getSelectedLabRoot())) {
    clearSelectedLabRoot();
  }
  restartAutoUpdateMonitor();
  return root;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    acceptFirstMouse: true,
    focusable: true,
    show: !HEADLESS_SMOKE_MODE,
    title: APP_NAME,
    backgroundColor: '#0b0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.once('did-finish-load', () => {
    try {
      mainWindow.webContents.setZoomFactor(DEFAULT_UI_ZOOM);
    } catch (_error) {
      // Ignore zoom configuration failures.
    }
  });

  mainWindow.once('ready-to-show', () => {
    try {
      mainWindow.setIgnoreMouseEvents(false);
      if (!HEADLESS_SMOKE_MODE) {
        mainWindow.show();
        mainWindow.focus();
      }
    } catch (_error) {
      // Ignore focus/mouse recovery failures.
    }
  });

  mainWindow.on('focus', () => {
    try {
      mainWindow.setIgnoreMouseEvents(false);
    } catch (_error) {
      // Ignore focus recovery failures.
    }
  });

  if (PACKAGED_SMOKE_MODE) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const snapshot = workspaceSnapshot();
        const review = snapshot.review || {};
        const approvalQueue = buildWorkspaceApprovalQueue(
          snapshot.workspaceRoot,
          review,
          snapshot.recentRuns || [],
          review.decisions || null,
          snapshot.bats || [],
        );
        const duplicateApprovalKeys = approvalQueue
          .map((item) => String(item.approvalKey || ''))
          .filter(Boolean)
          .filter((key, index, items) => items.indexOf(key) !== index);
        const domState = await mainWindow.webContents.executeJavaScript(`({
          shellRendered: !!document.querySelector('[data-workbench-shell="true"]'),
          routeCount: document.querySelectorAll('[data-route-tab], [data-module-nav]').length,
          panelCount: document.querySelectorAll('[data-panel]').length,
          activePanel: document.querySelector('[data-panel]')?.getAttribute('data-panel') || '',
          hasWorkspacePicker: Array.from(document.querySelectorAll('button')).some((button) => /pick workspace|switch workspace/i.test(String(button.textContent || ''))),
          bodyText: String(document.body?.textContent || ''),
        })`, true);
        const fixturePath = getUiSmokeApprovalFixturePath(snapshot.workspaceRoot)
          || approvalQueue[0]?.path
          || '';
        if (duplicateApprovalKeys.length > 0) {
          throw new Error(`Packaged app detected duplicate approval keys: ${duplicateApprovalKeys.join(', ')}`);
        }
        if (!domState || domState.shellRendered !== true || Number(domState.routeCount || 0) === 0) {
          throw new Error('Packaged app shell did not render navigation.');
        }
        if (!snapshot.workspaceRoot) {
          console.log('[packaged-smoke] workspace = <not selected>');
          console.log('[packaged-smoke] shell =', `routes=${Number(domState.routeCount || 0)}`, `panels=${Number(domState.panelCount || 0)}`, `active=${String(domState.activePanel || '')}`);
          console.log('[packaged-smoke] empty-state = Workspace selection is required before live work starts.');
        } else if (!fixturePath) {
          throw new Error('Packaged app did not surface an approval fixture path.');
        } else {
          console.log('[packaged-smoke] workspace =', snapshot.workspaceRoot);
          console.log('[packaged-smoke] shell =', `routes=${Number(domState.routeCount || 0)}`, `panels=${Number(domState.panelCount || 0)}`, `active=${String(domState.activePanel || '')}`);
          console.log('[packaged-smoke] review counts =', `changed=${Array.isArray(review.changedFiles) ? review.changedFiles.length : 0}`, `failures=${Array.isArray(review.failingLocations) ? review.failingLocations.length : 0}`, `artifacts=${Array.isArray(review.recentArtifacts) ? review.recentArtifacts.length : 0}`);
          console.log('[packaged-smoke] approval queue =', `pending=${approvalQueue.length}`, `fixture=${fixturePath}`);
        }
        setTimeout(() => {
          BrowserWindow.getAllWindows().forEach((window) => {
            try {
              window.close();
            } catch (_error) {
              // ignore cleanup failures
            }
          });
          app.exit(0);
        }, 150);
      } catch (error) {
        console.error('[packaged-smoke] FAIL', error && error.stack ? error.stack : error);
        setTimeout(() => {
          BrowserWindow.getAllWindows().forEach((window) => {
            try {
              window.close();
            } catch (_error) {
              // ignore cleanup failures
            }
          });
          app.exit(1);
        }, 150);
      }
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function setSecret(name, value) {
  if (!name) {
    throw new Error('Secret name is required.');
  }
  const nextValue = String(value || '').trim();
  try {
    const keytar = getKeytarModule();
    if (keytar) {
      if (!nextValue) {
        await keytar.deletePassword(SECRET_SERVICE, name);
        delete process.env[name];
        return { ok: true, backend: 'keytar', configured: false };
      }
      await keytar.setPassword(SECRET_SERVICE, name, nextValue);
      process.env[name] = nextValue;
      return { ok: true, backend: 'keytar', configured: true };
    }

    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, backend: 'none', configured: false, message: 'OS encryption is unavailable.' };
    }

    const fallback = store.get('encryptedSecrets') || {};
    if (!nextValue) {
      delete fallback[name];
      store.set('encryptedSecrets', fallback);
      delete process.env[name];
      return { ok: true, backend: 'safeStorage-fallback', configured: false };
    }
    const encrypted = safeStorage.encryptString(nextValue).toString('base64');
    fallback[name] = encrypted;
    store.set('encryptedSecrets', fallback);
    process.env[name] = nextValue;
    return { ok: true, backend: 'safeStorage-fallback', configured: true };
  } catch (error) {
    return {
      ok: false,
      backend: getKeytarModule() ? 'keytar' : 'none',
      configured: false,
      message: error?.message || 'Secret update failed.',
    };
  }
}

async function getSecret(name) {
  if (!name) {
    return { ok: false, value: null, backend: 'none', configured: false };
  }

  const keytar = getKeytarModule();
  if (keytar) {
    const value = await keytar.getPassword(SECRET_SERVICE, name);
    const configured = !!String(value || '').trim();
    return { ok: true, value: value || '', backend: 'keytar', configured };
  }

  const fallback = store.get('encryptedSecrets') || {};
  const blob = fallback[name];
  if (!blob) {
    return { ok: true, value: '', backend: 'safeStorage-fallback', configured: false };
  }

  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, value: null, backend: 'none', configured: false };
  }

  const value = safeStorage.decryptString(Buffer.from(blob, 'base64'));
  return { ok: true, value, backend: 'safeStorage-fallback', configured: !!String(value || '').trim() };
}

function runAssistantCli(workspaceRoot, args, extraEnv = {}) {
  if (!Array.isArray(args) || args[0] !== '--ai') {
    return Promise.resolve('Unsupported assistant CLI invocation.');
  }
  const promptIndex = args.indexOf('--prompt');
  const prompt = promptIndex >= 0 ? String(args[promptIndex + 1] || '') : '';
  const editorContext = buildDesktopEditorContext(workspaceRoot);
  runtime.setWorkspaceRoot(workspaceRoot);
  return runtime.chat(prompt, { env: extraEnv, editor_context: editorContext }).then((response) => {
    const reply = response && typeof response.reply === 'string' ? response.reply.trim() : '';
    return reply || '(AI unavailable)';
  }).catch((err) => `AI command failed to start: ${err.message}`);
}

function normalizeChatHistoryPayload(history) {
  return (Array.isArray(history) ? history : [])
    .map((item) => ({
      role: String(item?.role || 'assistant').trim().toLowerCase(),
      text: String(item?.text || '').trim(),
      kind: String(item?.kind || '').trim().toLowerCase(),
      timestamp: String(item?.timestamp || '').trim(),
    }))
    .filter((item) => item.text)
    .slice(-8);
}

function buildAssistantChatContext(workspaceRoot, payload = {}) {
  const incoming = payload && typeof payload === 'object' ? payload : {};
  const editorContext = buildDesktopEditorContext(workspaceRoot);
  const modelProvisioning = incoming.modelProvisioning && typeof incoming.modelProvisioning === 'object'
    ? {
        status: String(incoming.modelProvisioning.status || incoming.modelProvisioning.state || '').trim().toLowerCase(),
        summary: String(incoming.modelProvisioning.summary || '').trim(),
        recommendedAction: String(incoming.modelProvisioning.recommendedAction || '').trim(),
      }
    : null;
  const activeFile = String(incoming.activeFile || editorContext.active_file_path || '').trim();
  const selectionLine = Number(incoming.selectionLine || editorContext.selection_start_line || 0) || 0;
  const surroundingSnippet = String(
    incoming.surroundingSnippet
    || (activeFile && activeFile === editorContext.active_file_path ? editorContext.surrounding_snippet : '')
    || (activeFile ? buildSurroundingSnippet(workspaceRoot, activeFile, selectionLine || 1) : '')
    || ''
  ).trim();
  const currentFileDiff = String(
    incoming.currentFileDiff
    || (activeFile && activeFile === editorContext.active_file_path ? editorContext.current_file_diff : '')
    || (activeFile ? buildCurrentFileDiff(workspaceRoot, activeFile) : '')
    || ''
  ).trim();
  const recentWork = incoming.recentWork && typeof incoming.recentWork === 'object'
    ? {
        ...incoming.recentWork,
        summary: String(incoming.recentWork.summary || '').trim(),
        workedAt: String(incoming.recentWork.workedAt || '').trim(),
        changedFiles: normalizeChatChangedFileList(incoming.recentWork.changedFiles),
      }
    : buildChatRecentWorkContext(workspaceRoot, incoming);
  return {
    ...incoming,
    activeFile,
    selectionLine,
    changedFiles: Number(incoming.changedFiles || 0) || 0,
    approvalCount: Number(incoming.approvalCount || 0) || 0,
    activeRunId: String(incoming.activeRunId || recentWork.runId || '').trim(),
    activeRunLabel: String(incoming.activeRunLabel || '').trim(),
    worktree: String(incoming.worktree || '').trim(),
    activeView: String(incoming.activeView || '').trim(),
    openFiles: Array.isArray(incoming.openFiles) ? incoming.openFiles : (Array.isArray(editorContext.open_files) ? editorContext.open_files.slice(0, 6) : []),
    diagnostics: Array.isArray(incoming.diagnostics) ? incoming.diagnostics : (Array.isArray(editorContext.diagnostics) ? editorContext.diagnostics.slice(0, 6) : []),
    surroundingSnippet,
    currentFileDiff,
    recentWork,
    recentWorkSummary: String(incoming.recentWorkSummary || recentWork.summary || '').trim(),
    recentWorkWorkedAt: String(incoming.recentWorkWorkedAt || recentWork.workedAt || '').trim(),
    recentWorkFiles: normalizeChatChangedFileList(incoming.recentWorkFiles || recentWork.changedFiles),
    modelProvisioning,
  };
}

function buildTrustedDocReferences(workspaceRoot) {
  const latest = readLatestApprovedDocumentationSource(workspaceRoot);
  if (!latest?.exists) {
    return [];
  }
  return [{
    url: String(latest.url || '').trim(),
    title: String(latest.title || latest.summary || '').trim(),
    section: String(latest.section || '').trim(),
    summary: String(latest.summary || latest.title || latest.url || '').trim(),
    domain: String(latest.domain || '').trim(),
    reason: String(latest.reason || '').trim(),
    outputPath: String(latest.outputPath || '').trim(),
  }].filter((item) => item.url || item.title);
}

function buildChatGuidancePayload(targetWorkspaceRoot = '', context = {}) {
  const mode = String(store.get('chatInstructionMode') || 'auto').trim().toLowerCase() || 'auto';
  const customInstructions = String(store.get('chatCustomInstructions') || '').trim();
  const learningStatus = learningJournal.getStatus();
  const styleProfile = learningStatus?.styleProfile && typeof learningStatus.styleProfile === 'object'
    ? learningStatus.styleProfile
    : {};
  const reusablePrompts = Array.isArray(learningStatus?.reusablePrompts) ? learningStatus.reusablePrompts : [];
  const supervisionSignals = Array.isArray(learningStatus?.operatorSupervision?.signals)
    ? learningStatus.operatorSupervision.signals
    : [];
  const preferredVerbs = Array.isArray(styleProfile.preferredVerbs)
    ? styleProfile.preferredVerbs.map((item) => String(item?.verb || '').trim()).filter(Boolean)
    : [];
  const commonTargets = Array.isArray(styleProfile.commonTargets)
    ? styleProfile.commonTargets.map((item) => String(item?.label || '').trim()).filter(Boolean)
    : [];
  const autoInstructionsParts = [];
  const provisioning = context.modelProvisioning && typeof context.modelProvisioning === 'object'
    ? context.modelProvisioning
    : {};
  if (preferredVerbs.length > 0) {
    autoInstructionsParts.push(`Prefer ${preferredVerbs.join(', ')} style task phrasing.`);
  }
  if (commonTargets.length > 0) {
    autoInstructionsParts.push(`Common target areas: ${commonTargets.slice(0, 3).join(', ')}.`);
  }
  if (String(styleProfile.summary || '').trim()) {
    autoInstructionsParts.push(String(styleProfile.summary || '').trim());
  }
  if (supervisionSignals.length > 0) {
    const notes = supervisionSignals
      .slice(0, 2)
      .map((item) => String(item?.note || '').trim())
      .filter(Boolean);
    if (notes.length > 0) {
      autoInstructionsParts.push(`Recent operator supervision: ${notes.join(' | ')}.`);
    }
  }
  const docsContext = {
    targetPath: String(context.activeFile || '').trim(),
    title: String(context.activeRunLabel || '').trim(),
    objective: String(context.message || '').trim(),
    summary: [
      String(context.activeView || '').trim(),
      String(context.worktree || '').trim(),
      String(context.selectionSummary || '').trim(),
    ].filter(Boolean).join(' • '),
    category: String(context.activeView || '').trim(),
  };
  const docsVault = buildApprovedDocumentationVault(targetWorkspaceRoot || getTargetWorkspaceRoot() || getWorkspaceRoot(), {
    context: docsContext,
  });
  const recommendedSources = Array.isArray(docsVault?.recommendedSources) && docsVault.recommendedSources.length > 0
    ? docsVault.recommendedSources.slice(0, 3)
    : recommendApprovedDocumentationSources(docsContext).slice(0, 3);
  if (recommendedSources.length > 0) {
    const docsSummary = recommendedSources
      .map((item) => `${String(item?.label || item?.domain || 'docs').trim()}${item?.domain ? ` (${String(item.domain).trim()})` : ''}`)
      .filter(Boolean)
      .slice(0, 2)
      .join(', ');
    if (docsSummary) {
      autoInstructionsParts.push(`Preferred trusted docs for this slice: ${docsSummary}.`);
    }
  }
  if (docsVault?.exists && String(docsVault.recommendedAction || '').trim()) {
    autoInstructionsParts.push(String(docsVault.recommendedAction || '').trim());
  }
  if (!docsVault?.exists || ['aging', 'stale'].includes(String(docsVault?.freshnessLabel || '').trim().toLowerCase())) {
    autoInstructionsParts.push('Use the docs-scout lab recipe before trusting a new documentation-led change.');
  }
  if (String(provisioning.summary || '').trim()) {
    autoInstructionsParts.push(`Model provisioning: ${String(provisioning.summary || '').trim()}`);
  }
  if (['fail', 'warn'].includes(String(provisioning.status || provisioning.state || '').trim().toLowerCase())
    && String(provisioning.recommendedAction || '').trim()) {
    autoInstructionsParts.push(String(provisioning.recommendedAction || '').trim());
  }
  return {
    mode,
    customInstructions: mode === 'custom' ? customInstructions : '',
    autoInstructions: mode === 'off' ? '' : autoInstructionsParts.join(' '),
    reusablePrompts: reusablePrompts.slice(0, 3),
    supervisionSignals: supervisionSignals.slice(0, 3),
    recommendedSources,
    docsFreshness: String(docsVault?.freshnessLabel || '').trim(),
    docsRecommendedAction: String(docsVault?.recommendedAction || '').trim(),
    docsLabRecipeId: 'docs-scout',
    modelProvisioningSummary: String(provisioning.summary || '').trim(),
    modelProvisioningAction: String(provisioning.recommendedAction || '').trim(),
    styleProfile,
  };
}

function buildAssistantReplySuggestions(message, reply) {
  const lower = `${String(message || '')}\n${String(reply || '')}`.toLowerCase();
  const suggestions = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (!text || suggestions.includes(text)) {
      return;
    }
    suggestions.push(text);
  };

  if (/(?:app|desktop).*(?:update|release)|\/app\s+update/.test(lower)) {
    push('/app update status');
    push('/app update check');
    push('/app update install');
    return suggestions.slice(0, 3);
  }
  if (/approval/.test(lower)) {
    push('/approvals');
    push('/approve');
  }
  if (/health|runtime|scheduler/.test(lower)) {
    push('/health');
    push('/workers');
  }
  if (suggestions.length === 0) {
    push('/next');
    push('/approvals');
    push('/health');
  }
  return suggestions.slice(0, 3);
}

function buildAssistantReplyRefs(chatContext = {}) {
  const refs = [];
  if (chatContext.activeFile) {
    refs.push({
      type: 'file',
      path: chatContext.activeFile,
      line: Number(chatContext.selectionLine || 1) || 1,
      label: chatContext.selectionLine
        ? `${chatContext.activeFile}:${chatContext.selectionLine}`
        : chatContext.activeFile,
    });
  }
  return refs;
}

function normalizeLocalAiCmd(value) {
  let normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }
  normalized = normalized.replace(/\s+/g, ' ');
  const lowered = normalized.toLowerCase();

  if (lowered.includes('local_ai_llama_bridge.py')) {
    return 'backend/.venv/bin/python backend/scripts/local_ai_llama_bridge.py';
  }
  if (lowered.includes('local_ai_gpt4all_bridge.py')) {
    return 'backend/.venv/bin/python backend/scripts/local_ai_gpt4all_bridge.py';
  }
  if (/^(thon|ython)\s+/i.test(normalized)) {
    normalized = `p${normalized}`;
  }
  if (/^python\s+backend\/scripts\/local_ai_(llama|gpt4all)_bridge\.py\b/i.test(normalized)) {
    normalized = `backend/.venv/bin/python ${normalized.replace(/^python\s+/i, '')}`;
  }
  if (/^backend\/scripts\/local_ai_(llama|gpt4all)_bridge\.py\b/i.test(normalized)) {
    normalized = `backend/.venv/bin/python ${normalized}`;
  }
  return normalized;
}

function resolveBridgeProfileCommand(profileId) {
  const normalized = String(profileId || '').trim().toLowerCase();
  const profile = AI_BRIDGE_PROFILES.find((item) => item.id === normalized);
  return profile ? normalizeLocalAiCmd(profile.command) : '';
}

function splitShellCommand(command) {
  const parts = String(command || '').match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return parts.map((part) => part.replace(/^['"]|['"]$/g, ''));
}

function commandExecutableExists(command, cwd = RUNTIME_ROOT) {
  const [binary] = splitShellCommand(command);
  if (!binary) {
    return false;
  }
  if (path.isAbsolute(binary)) {
    return fs.existsSync(binary);
  }
  if (binary.includes(path.sep) || binary.startsWith('.')) {
    return fs.existsSync(path.resolve(cwd, binary));
  }
  try {
    childProcess.execFileSync('which', [binary], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    return true;
  } catch (_err) {
    return false;
  }
}

function getConfiguredLocalAiCmd() {
  const manualMode = store.get('aiManualMode') === true;
  const bridgeProfile = String(store.get('aiBridgeProfile') || 'llama-bridge').trim().toLowerCase() || 'llama-bridge';
  if (!manualMode && bridgeProfile && bridgeProfile !== 'custom') {
    const selectedBridgeCommand = resolveBridgeProfileCommand(bridgeProfile);
    if (selectedBridgeCommand) {
      return selectedBridgeCommand;
    }
  }
  const configured = normalizeLocalAiCmd(store.get('localAiCmd') || '');
  if (configured) {
    return configured;
  }
  return normalizeLocalAiCmd(process.env.LOCAL_AI_CMD || '');
}

function getAvailableLocalAiCmd() {
  const command = getConfiguredLocalAiCmd();
  return commandExecutableExists(command, RUNTIME_ROOT) ? command : '';
}

function getChatBackendConfig(workspaceRoot) {
  const runtimeMode = String(store.get('runtime') || 'ollama').trim().toLowerCase();
  const tuningSettings = readTrainingTuningSettings(workspaceRoot || getWorkspaceRoot());
  const remoteProvider = resolveRemoteProviderPreset({
    aiRemoteProvider: store.get('aiRemoteProvider'),
    aiRemoteBaseUrl: store.get('aiRemoteBaseUrl'),
    aiRemoteApiKeyName: store.get('aiRemoteApiKeyName'),
  });
  return {
    runtimeMode,
    localCmd: getAvailableLocalAiCmd(),
    ollamaModel: String(
      tuningSettings.trainingOllamaModel
      || process.env.OLLAMA_MODEL
      || 'qwen2.5-coder:7b',
    ).trim() || 'qwen2.5-coder:7b',
    remoteProviderId: remoteProvider.id,
    remoteBaseUrl: String(remoteProvider.baseUrl || '').trim(),
    remoteApiKeyName: String(remoteProvider.apiKeyName || '').trim() || 'OPENAI_API_KEY',
    remoteModel: String(store.get('aiRemoteModel') || store.get('model') || remoteProvider.models?.[0]?.id || 'gpt-4o-mini').trim() || 'gpt-4o-mini',
  };
}

async function buildAiEnvOverrides(workspaceRoot) {
  const backend = getChatBackendConfig(workspaceRoot);
  const env = {};
  const runtimeMode = backend.runtimeMode;
  if (runtimeMode === 'local' && backend.localCmd) {
    env.AGENT_PROVIDER = 'local';
    env.LOCAL_AI_CMD = backend.localCmd;
    return env;
  }
  if (runtimeMode === 'openai') {
    const secret = await getSecret(backend.remoteApiKeyName);
    if (secret?.ok && secret.value) {
      env.AGENT_PROVIDER = 'openai';
      env.OPENAI_API_KEY = secret.value;
      env.OPENAI_MODEL = backend.remoteModel;
      if (backend.remoteBaseUrl) {
        env.OPENAI_BASE_URL = backend.remoteBaseUrl;
      }
    }
    return env;
  }
  if (runtimeMode === 'hybrid') {
    env.OLLAMA_MODEL = backend.ollamaModel;
    const secret = await getSecret(backend.remoteApiKeyName);
    if (secret?.ok && secret.value) {
      env.OPENAI_API_KEY = secret.value;
      env.OPENAI_MODEL = backend.remoteModel;
      if (backend.remoteBaseUrl) {
        env.OPENAI_BASE_URL = backend.remoteBaseUrl;
      }
    }
  }
  return env;
}

function canManageOllama() {
  try {
    childProcess.execFileSync('ollama', ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    return true;
  } catch (_err) {
    return false;
  }
}

function buildOllamaServiceEnv(settings = {}) {
  const env = { ...process.env };
  const ollamaHome = resolveOllamaHomeRoot(settings);
  const ollamaModels = resolveOllamaModelsRoot(settings);
  fs.mkdirSync(ollamaModels, { recursive: true });
  env.OLLAMA_HOME = ollamaHome;
  env.OLLAMA_MODELS = ollamaModels;
  return env;
}

function startOllamaService(settings = {}) {
  if (!canManageOllama()) {
    return { ok: false, started: false, message: 'Ollama CLI is not available on this machine.' };
  }
  try {
    const child = childProcess.spawn('ollama', ['serve'], {
      detached: true,
      stdio: 'ignore',
      env: buildOllamaServiceEnv(settings),
    });
    child.unref();
    return { ok: true, started: true, pid: child.pid || null, message: `Ollama service started${child.pid ? ` (pid ${child.pid})` : ''}.` };
  } catch (error) {
    return { ok: false, started: false, message: error?.message || 'Unable to start Ollama.' };
  }
}

async function waitForOllamaReady(settings = {}, timeoutMs = 15000) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 15000);
  while (Date.now() < deadline) {
    try {
      childProcess.execFileSync('ollama', ['list'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2500,
        env: buildOllamaServiceEnv(settings),
      });
      return { ok: true };
    } catch (_err) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return { ok: false, message: 'Ollama did not become ready in time.' };
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function stopOllamaService() {
  if (!canManageOllama()) {
    return { ok: false, stopped: false, message: 'Ollama CLI is not available on this machine.' };
  }
  try {
    if (process.platform === 'win32') {
      childProcess.execFileSync('taskkill', ['/IM', 'ollama.exe', '/F'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 2500,
      });
    } else {
      childProcess.execFileSync('pkill', ['-x', 'ollama'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 1500,
      });
    }
    return { ok: true, stopped: true, message: 'Ollama stop signal sent.' };
  } catch (_err) {
    return { ok: true, stopped: false, message: 'Ollama was not running.' };
  }
}

async function getTrainingTuningStatus(payload = {}) {
  const workspaceRoot = payload.workspace || payload.workspaceRoot || getWorkspaceRoot();
  const settings = readTrainingTuningSettings(workspaceRoot);
  const runtimeStatus = runtime.getStatus();
  const telemetry = await collectTrainingTelemetry({
    settings,
    activeRuns: Array.isArray(runtimeStatus?.activeRuns) ? runtimeStatus.activeRuns.length : 0,
    schedulerRunning: !!schedulerStatusPayload().running,
  });
  return {
    ok: true,
    workspaceRoot,
    settings,
    telemetry,
    importState: snapshotTuningImportState(),
    cliAvailable: canManageOllama(),
    recommendedModels: RECOMMENDED_LOCAL_MODELS,
    hardwareTargets: HARDWARE_TARGET_PRESETS,
    installPresets: buildModelInstallPresets(workspaceRoot, settings),
    commands: {
      train: buildTerminalTrainingCommand(workspaceRoot, settings, 'train'),
      learn: buildTerminalTrainingCommand(workspaceRoot, settings, 'learn'),
      selfImprove: buildTerminalTrainingCommand(workspaceRoot, settings, 'self-improve'),
      ollama: workspaceRoot ? `cd '${String(workspaceRoot).replace(/'/g, `'"'"'`)}' && make ollama-serve` : 'make ollama-serve',
      modelPack: buildModelDownloadCommand(workspaceRoot, settings, 'pack'),
    },
  };
}

function buildOllamaImportModelfile(modelPath) {
  return `FROM ${String(modelPath || '').trim()}\n`;
}

function buildTrainingImportCandidates(discovered = [], readyTags = new Set(), payload = {}, settings = {}) {
  const selectedModel = String(payload.model || settings.trainingOllamaModel || '').trim();
  const onlySelected = payload.onlySelected === true;
  const filtered = (Array.isArray(discovered) ? discovered : []).filter((item) => {
    const tag = String(item?.importTag || item?.ollamaModel || '').trim();
    if (!item?.fullPath || !tag || readyTags.has(tag)) {
      return false;
    }
    if (!onlySelected) {
      return true;
    }
    return tag === selectedModel;
  });
  return filtered.sort((left, right) => {
    const leftTag = String(left?.importTag || left?.ollamaModel || '').trim();
    const rightTag = String(right?.importTag || right?.ollamaModel || '').trim();
    const leftSelected = selectedModel && leftTag === selectedModel ? 1 : 0;
    const rightSelected = selectedModel && rightTag === selectedModel ? 1 : 0;
    if (leftSelected !== rightSelected) {
      return rightSelected - leftSelected;
    }
    const leftSize = Number(left?.sizeBytes || 0);
    const rightSize = Number(right?.sizeBytes || 0);
    if (leftSize !== rightSize) {
      return leftSize - rightSize;
    }
    return String(left?.fileName || '').localeCompare(String(right?.fileName || ''));
  });
}

async function runStoredTrainingModelImport(payload = {}) {
  const workspaceRoot = payload.workspace || payload.workspaceRoot || getWorkspaceRoot() || APP_ROOT;
  const settings = readTrainingTuningSettings(workspaceRoot);
  const status = await getTrainingTuningStatus({ workspace: workspaceRoot });
  const readyTags = new Set(Array.isArray(status?.telemetry?.ollama?.models) ? status.telemetry.ollama.models.map((item) => String(item || '').trim()) : []);
  const discovered = Array.isArray(status?.telemetry?.models?.discovered)
    ? status.telemetry.models.discovered
    : discoverStoredModels(settings).models;
  const candidates = buildTrainingImportCandidates(discovered, readyTags, payload, settings);
  const selectedModel = String(payload.model || settings.trainingOllamaModel || '').trim();
  const onlySelected = payload.onlySelected === true;
  updateTuningImportState({
    running: true,
    status: 'starting',
    workspaceRoot,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total: candidates.length,
    completed: 0,
    percent: 0,
    currentModel: '',
    message: candidates.length
      ? `Preparing to import ${candidates.length} stored model${candidates.length === 1 ? '' : 's'}${onlySelected && selectedModel ? ` for ${selectedModel}` : ''}.`
      : (onlySelected && selectedModel
        ? `${selectedModel} is already available in Ollama or not present in SSD storage.`
        : 'All stored GGUF models are already available in Ollama.'),
    imported: [],
    skipped: [],
  });
  if (!candidates.length) {
    const result = {
      ok: true,
      imported: [],
      skipped: [],
      message: onlySelected && selectedModel
        ? `${selectedModel} is already available in Ollama or not present in SSD storage.`
        : 'All stored GGUF models are already available in Ollama.',
    };
    updateTuningImportState({
      running: false,
      status: 'completed',
      finishedAt: new Date().toISOString(),
      percent: 100,
      message: result.message,
    });
    return result;
  }
  const ollamaStatus = status?.telemetry?.ollama?.running ? { ok: true } : startOllamaService(settings);
  if (ollamaStatus?.ok === false) {
    const result = { ok: false, imported: [], skipped: [], message: ollamaStatus.message || 'Unable to start Ollama before import.' };
    updateTuningImportState({
      running: false,
      status: 'error',
      finishedAt: new Date().toISOString(),
      message: result.message,
    });
    return result;
  }
  const readyStatus = await waitForOllamaReady(settings, 20000);
  if (readyStatus?.ok === false) {
    const result = { ok: false, imported: [], skipped: [], message: readyStatus.message || 'Ollama did not become ready before import.' };
    updateTuningImportState({
      running: false,
      status: 'error',
      finishedAt: new Date().toISOString(),
      message: result.message,
    });
    return result;
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gos-ollama-import-'));
  const imported = [];
  const skipped = [];
  try {
    for (let index = 0; index < candidates.length; index += 1) {
      const model = candidates[index];
      const tag = String(model.importTag || model.ollamaModel || '').trim();
      const modelPath = String(model.fullPath || '').trim();
      updateTuningImportState({
        status: 'importing',
        currentModel: tag,
        completed: imported.length + skipped.length,
        percent: Math.round(((imported.length + skipped.length) / candidates.length) * 100),
        message: `Importing ${index + 1}/${candidates.length}: ${tag}`,
        imported,
        skipped,
      });
      if (!tag || !modelPath || !fs.existsSync(modelPath)) {
        skipped.push({ fileName: model.fileName, model: tag, reason: 'missing model file' });
        updateTuningImportState({
          completed: imported.length + skipped.length,
          percent: Math.round(((imported.length + skipped.length) / candidates.length) * 100),
          message: `Skipped ${tag}: missing model file.`,
          imported,
          skipped,
        });
        continue;
      }
      const modelfilePath = path.join(tempRoot, `${String(model.id || 'model')}.Modelfile`);
      fs.writeFileSync(modelfilePath, buildOllamaImportModelfile(modelPath), 'utf8');
      try {
        await execFileAsync('ollama', ['create', tag, '-f', modelfilePath], {
          maxBuffer: 16 * 1024 * 1024,
          env: buildOllamaServiceEnv(settings),
        });
        imported.push({ fileName: model.fileName, model: tag });
        updateTuningImportState({
          completed: imported.length + skipped.length,
          percent: Math.round(((imported.length + skipped.length) / candidates.length) * 100),
          message: `Imported ${tag} (${imported.length + skipped.length}/${candidates.length}).`,
          imported,
          skipped,
        });
      } catch (error) {
        skipped.push({
          fileName: model.fileName,
          model: tag,
          reason: error?.stderr || error?.message || 'Ollama import failed.',
        });
        updateTuningImportState({
          completed: imported.length + skipped.length,
          percent: Math.round(((imported.length + skipped.length) / candidates.length) * 100),
          message: `Failed to import ${tag}. Continuing with the next model.`,
          imported,
          skipped,
        });
      }
    }
  } catch (error) {
    const result = {
      ok: false,
      imported,
      skipped,
      message: error?.message || 'Ollama import failed.',
    };
    updateTuningImportState({
      running: false,
      status: 'error',
      finishedAt: new Date().toISOString(),
      completed: imported.length + skipped.length,
      percent: Math.round((((imported.length + skipped.length) || 0) / Math.max(candidates.length, 1)) * 100),
      message: result.message,
      imported,
      skipped,
      currentModel: '',
    });
    return result;
  } finally {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (_err) {
      // ignore cleanup failures
    }
  }
  const result = {
    ok: true,
    imported,
    skipped,
    message: imported.length
      ? `Imported ${imported.length} stored model${imported.length === 1 ? '' : 's'} into Ollama${skipped.length ? ` - ${skipped.length} skipped` : ''}.`
      : (skipped.length ? `No models imported - ${skipped.length} skipped.` : 'No new models were imported.'),
  };
  updateTuningImportState({
    running: false,
    status: skipped.length ? 'completed-with-errors' : 'completed',
    finishedAt: new Date().toISOString(),
    completed: candidates.length,
    percent: 100,
    currentModel: '',
    message: result.message,
    imported,
    skipped,
  });
  return result;
}

async function importStoredTrainingModels(payload = {}) {
  if (tuningImportState.running) {
    return {
      ok: true,
      started: false,
      message: tuningImportState.message || 'A model import is already running.',
      importState: snapshotTuningImportState(),
    };
  }
  const workspaceRoot = payload.workspace || payload.workspaceRoot || getWorkspaceRoot() || APP_ROOT;
  updateTuningImportState({
    running: true,
    status: 'queued',
    workspaceRoot,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total: 0,
    completed: 0,
    percent: 0,
    currentModel: '',
    message: 'Import queued. Waiting for Ollama preparation.',
    imported: [],
    skipped: [],
  });
  runStoredTrainingModelImport(payload).catch((error) => {
    updateTuningImportState({
      running: false,
      status: 'error',
      finishedAt: new Date().toISOString(),
      currentModel: '',
      message: error?.message || 'Model import failed.',
    });
  });
  return {
    ok: true,
    started: true,
    message: 'Model import started in the background.',
    importState: snapshotTuningImportState(),
  };
}

function buildTunedActionPayload(action, payload = {}) {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const targetWorkspaceRoot = payload.targetWorkspaceRoot || payload.workspace || payload.labRoot || getTargetWorkspaceRoot();
  const settings = readTrainingTuningSettings(workspaceRoot);
  if (action === 'train') {
    return buildTrainingRunPayload(settings, { ...payload, workspaceRoot, workspace: targetWorkspaceRoot, targetWorkspaceRoot, projectRoot: targetWorkspaceRoot });
  }
  if (action === 'learn' || action === 'analyze-log') {
    return buildLearnRunPayload(settings, { ...payload, workspaceRoot, workspace: targetWorkspaceRoot, targetWorkspaceRoot, projectRoot: targetWorkspaceRoot });
  }
  if (action === 'self-improve') {
    return buildSelfImproveRunPayload(settings, { ...payload, workspaceRoot, workspace: targetWorkspaceRoot, targetWorkspaceRoot, projectRoot: targetWorkspaceRoot });
  }
  return { ...payload, workspaceRoot, workspace: targetWorkspaceRoot, targetWorkspaceRoot, projectRoot: targetWorkspaceRoot };
}

async function maybeEnsureOllamaForAction(action, payload = {}) {
  if (!['self-improve', 'learn', 'train'].includes(String(action || '').trim().toLowerCase())) {
    return { ok: true, started: false, message: '' };
  }
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const settings = readTrainingTuningSettings(workspaceRoot);
  const { runtimeMode, localCmd } = getChatBackendConfig(workspaceRoot);
  const wantsOllama = runtimeMode === 'ollama' || runtimeMode === 'hybrid' || /ollama|llama_bridge/i.test(localCmd);
  if (!settings.trainingAutoStartOllama || !['local', 'hybrid', 'ollama'].includes(runtimeMode) || !wantsOllama) {
    return { ok: true, started: false, message: '' };
  }
  const status = await getTrainingTuningStatus({ workspace: workspaceRoot });
  if (status?.telemetry?.ollama?.running) {
    return { ok: true, started: false, message: 'Ollama already running.' };
  }
  return startOllamaService(settings);
}

async function runTunedAction(action, payload = {}) {
  const safetyLevel = evaluateSafetyLevelGuard(action, payload);
  if (safetyLevel.blocked) {
    return {
      ok: false,
      blocked: true,
      blockedBy: 'safety-level',
      message: safetyLevel.message || 'The current safety level blocked this action.',
      safetyLevel: safetyLevel.request?.safetyLevel || '',
    };
  }
  const safety = await evaluateHardSafety(action, payload);
  if (safety.applied.blocked) {
    return {
      ok: false,
      blocked: true,
      blockedBy: 'safe-mode',
      message: safety.applied.message || 'Safety guardrails blocked this action.',
      safetyStatus: safety.safeMode,
    };
  }
  await maybeEnsureOllamaForAction(action, payload);
  const tunedPayload = buildTunedActionPayload(action, safetyLevel.request || payload);
  if (action === 'learn') {
    return runLearnPipeline(tunedPayload);
  }
  return handleAgentRun(action, tunedPayload);
}

function workspaceSnapshot() {
  const workspaceRoot = getWorkspaceRoot();
  const statusWorkspaceRoot = workspaceRoot || '';
  const targetWorkspaceRoot = getTargetWorkspaceRoot();
  const selectedLabRoot = getSelectedLabRoot();
  const uiSmokeApprovalFixturePath = ensureUiSmokeApprovalFixture(targetWorkspaceRoot);
  const reviewSelection = getReviewSelectionState();
  const bats = prioritizeBatsForSafeMode(targetWorkspaceRoot, parseBatBoard(targetWorkspaceRoot));
  const boardStatusByTicket = new Map(bats.map((item) => [String(item.ticket), String(item.status || '')]));
  const runtimeStatus = runtime.getStatus();
  const latestRuntime = runtimeStatus.latest?.[0] || null;
  const runtimeRuns = Array.isArray(runtimeStatus.latest) ? runtimeStatus.latest : [];
  const recentRuns = parseAssistantRuns(targetWorkspaceRoot, { limit: 20 });
  const sharedRuntimeContext = normalizeRuntimeContext(latestRuntime?.runtimeContext || recentRuns[0]?.runtimeContext || {});
  const followupBats = parseFollowupBatReport(targetWorkspaceRoot);
  const latestSprint = parseLatestSprintSummary(targetWorkspaceRoot);
  const recovery = runtime.getRecoveryState();
  const taskHubGoals = listGoals(workspaceRoot, { limit: 20 });
  const taskHubTasks = listTasks(workspaceRoot, { limit: 40 });
  const taskHubRuns = listRuns(workspaceRoot, { limit: 40 }, runtimeStatus);
  const taskHubRecipes = listRecipes();
  const acceptance = readLatestAcceptanceReport(statusWorkspaceRoot);
  const benchmarkRuns = listBenchmarkRuns(statusWorkspaceRoot);
  const vscodeSetup = buildVsCodeSetupStatus(targetWorkspaceRoot);
  const extensionHealth = buildVsCodeExtensionHealth(targetWorkspaceRoot);
  const integrations = buildIntegrationStudioStatus(targetWorkspaceRoot || workspaceRoot, { appRoot: APP_ROOT });
  const appRollbacks = {
    root: getDesktopAppRollbackRoot(statusWorkspaceRoot, 'darwin'),
    backups: listArchivedAppBackups(statusWorkspaceRoot, 'darwin'),
  };
  let changedFiles = [];
  if (targetWorkspaceRoot) {
    try {
      const out = childProcess.execSync('git status --short', {
        cwd: targetWorkspaceRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      changedFiles = out.trim().split(/\r?\n/).filter((l) => l);
    } catch (_e) {
      // ignore errors
    }
  }
  const review = buildReviewSnapshot(targetWorkspaceRoot, {
    changedFiles,
    recentRuns,
    latestRun: latestRuntime,
    decisions: getReviewDecisions(),
    runtimeContext: sharedRuntimeContext,
  });
  const reviewWithSmokeFixture = {
    ...injectUiSmokeApprovalFixture(targetWorkspaceRoot, review, uiSmokeApprovalFixturePath),
    selection: reviewSelection,
  };
  const worktree = summarizeWorkspaceTopology(targetWorkspaceRoot, sharedRuntimeContext, { changedFiles });
  const preflight = runPreflight(targetWorkspaceRoot, { requireGh: false });
  const learningStatus = learningJournal.getStatus();
  const manager = buildManagerSnapshot(targetWorkspaceRoot, {
    canonicalWorkspaceRoot: workspaceRoot,
    selectedLabRoot: getSelectedLabRoot(),
    latestRuntime,
    runtimeRuns,
    recentRuns,
    bats,
    changedFiles,
    review: reviewWithSmokeFixture,
    runtimeContext: sharedRuntimeContext,
    worktree,
    preflight,
    updates: latestUpdateStatus,
    docsContext: {
      targetPath: reviewWithSmokeFixture?.failingLocations?.[0]?.path
        || reviewWithSmokeFixture?.changedFiles?.[0]?.path
        || '',
      title: latestRuntime?.label || '',
      objective: latestRuntime?.blockedReason || latestRuntime?.message || '',
      summary: reviewWithSmokeFixture?.failingLocations?.[0]?.message || '',
    },
  });
  const cleanedDecisions = normalizeReviewDecisions(reviewWithSmokeFixture.decisions, {
    queue: manager.approvalQueue || [],
    preserveKeys: [reviewSelection.approvalKey, lastReviewApprovalKey],
  });
  if (JSON.stringify(cleanedDecisions) !== JSON.stringify(reviewWithSmokeFixture.decisions || {})) {
    store.set('reviewDecisions', cleanedDecisions);
    reviewWithSmokeFixture.decisions = cleanedDecisions;
  }
  const reviewer = buildReviewerSummary(targetWorkspaceRoot, {
    review: reviewWithSmokeFixture,
    latestRun: latestRuntime,
    approvalQueue: manager.approvalQueue || [],
    approvedDocReference: manager.approvedDocReference || {},
    approvedDocsVault: manager.approvedDocsVault || {},
    operatorSupervision: learningStatus.operatorSupervision || {},
    acceptance,
  });
  const regression = buildRegressionCandidates(targetWorkspaceRoot, {
    review: reviewWithSmokeFixture,
    latestRun: latestRuntime,
    approvalQueue: manager.approvalQueue || [],
    operatorSupervision: learningStatus.operatorSupervision || {},
  });
  const testBench = buildTestBenchSnapshot(targetWorkspaceRoot, {
    review: reviewWithSmokeFixture,
    reviewer,
    regression,
    latestRun: latestRuntime,
    docsVault: manager.approvedDocsVault || {},
    safeMode: manager.safeMode || {},
  });
  const modelFoundry = buildModelFoundryStatus(statusWorkspaceRoot, {
    benchmarks: benchmarkRuns,
    learning: learningStatus,
    acceptance,
  });
  const promotions = listPromotionState(statusWorkspaceRoot, { labRoot: selectedLabRoot });
  const settings = getDesktopSettingsPayload(workspaceRoot);
  const assistantConfig = readAssistantConfig(workspaceRoot, { defaultWorkspace: DEFAULT_TARGET_WORKSPACE });
  const selfImprovement = buildSelfImprovementSummary(statusWorkspaceRoot || DEFAULT_TARGET_WORKSPACE, '', {
    dailyTarget: Number(assistantConfig.dailySelfImprovementTarget || 5),
  });
  const taskHub = {
    goals: taskHubGoals.goals,
    tasks: taskHubTasks.tasks,
    runs: taskHubRuns.runs,
    recipes: taskHubRecipes.recipes,
    hubPath: taskHubGoals.hubPath || taskHubTasks.hubPath || taskHubRuns.hubPath || '',
  };
  const readiness = buildMvpReadiness({
    manager,
    promotions,
    reviewer,
    regression,
    testBench,
    learningJournal: learningStatus,
    settings,
    taskHub,
    acceptance,
    vscodeSetup,
    extensionHealth,
    modelFoundry,
    integrations,
    appRollbacks,
    benchmarks: benchmarkRuns,
    updates: latestUpdateStatus,
    selfImprovement,
  });
  const systemCheck = buildSystemCheck({
    workspaceRoot: statusWorkspaceRoot || DEFAULT_TARGET_WORKSPACE,
    targetWorkspaceRoot: targetWorkspaceRoot || statusWorkspaceRoot || DEFAULT_TARGET_WORKSPACE,
    labRoot: selectedLabRoot,
    assistantConfig,
    runtimeState: recovery,
    acceptance,
    benchmarks: benchmarkRuns,
    learningJournal: learningStatus,
    promotions,
    readiness,
    taskHub,
  });
  return {
    workspaceRoot,
    targetWorkspaceRoot,
    selectedLabRoot: getSelectedLabRoot(),
    bats,
    summary: summarizeBats(bats),
    recentRuns,
    followupBats,
    latestSprint,
    changedFiles,
    worktree,
    runtimeContext: sharedRuntimeContext,
    editorContext: buildDesktopEditorContext(targetWorkspaceRoot),
    review: reviewWithSmokeFixture,
    preflight,
    updates: latestUpdateStatus,
    manager,
    reviewer,
    regression,
    testBench,
    dashboardLayout: getDesktopDashboardLayoutPayload(),
    workspaceSelection: buildWorkspaceSelectionPayload(workspaceRoot),
    labs: listLabs(workspaceRoot),
    promotions,
    learningJournal: learningStatus,
    selfImprovement,
    benchmarks: benchmarkRuns,
    acceptance,
    vscodeSetup,
    extensionHealth,
    modelFoundry,
    integrations,
    appRollbacks,
    readiness,
    systemCheck,
    taskHub,
    operatorLoop: buildTaskLoopSnapshot(workspaceRoot),
    recovery: {
      ...recovery,
      runs: (Array.isArray(recovery?.runs) ? recovery.runs : []).filter((run) => {
        const status = boardStatusByTicket.get(String(run?.ticket || '')) || '';
        const hasArtifacts = Array.isArray(run?.artifactPaths) && run.artifactPaths.length > 0;
        const hasChecks = Array.isArray(run?.checks) && run.checks.length > 0;
        return !(status.includes('DONE') && !hasArtifacts && !hasChecks);
      }),
    },
    settings,
  };
}

function workspaceSnapshotLite() {
  const workspaceRoot = getWorkspaceRoot();
  const statusWorkspaceRoot = workspaceRoot || '';
  const targetWorkspaceRoot = getTargetWorkspaceRoot();
  const selectedLabRoot = getSelectedLabRoot();
  const settings = getDesktopSettingsPayload(workspaceRoot);
  const assistantConfig = readAssistantConfig(workspaceRoot, { defaultWorkspace: DEFAULT_TARGET_WORKSPACE });
  const selfImprovement = buildSelfImprovementSummary(statusWorkspaceRoot || DEFAULT_TARGET_WORKSPACE, '', {
    dailyTarget: Number(assistantConfig.dailySelfImprovementTarget || 5),
  });
  const safeMode = getSafetyStatusSnapshot({
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot: selectedLabRoot,
    latestRuntime: null,
    baseline: { state: 'green', blocked: false, reason: '' },
    assistantConfig,
  });
  const taskHubRecipes = listRecipes();
  const acceptance = readLatestAcceptanceReport(statusWorkspaceRoot);
  const promotions = listPromotionState(statusWorkspaceRoot, { labRoot: selectedLabRoot });
  const learningStatus = learningJournal.getStatus();
  const vscodeSetup = buildVsCodeSetupStatus(targetWorkspaceRoot);
  const extensionHealth = buildVsCodeExtensionHealth(targetWorkspaceRoot);
  const modelFoundry = buildModelFoundryStatus(statusWorkspaceRoot, {
    benchmarks: { runs: [] },
    learning: learningStatus,
    acceptance,
  });
  const integrations = buildIntegrationStudioStatus(targetWorkspaceRoot || workspaceRoot, { appRoot: APP_ROOT });
  const appRollbacks = {
    root: getDesktopAppRollbackRoot(statusWorkspaceRoot, 'darwin'),
    backups: listArchivedAppBackups(statusWorkspaceRoot, 'darwin'),
  };
  const taskHub = {
    goals: [],
    tasks: [],
    runs: [],
    recipes: taskHubRecipes.recipes,
    hubPath: '',
  };
  const readiness = buildMvpReadiness({
    manager: {
      summaryText: `Shell ready. Safety ${safeMode.active ? 'safe-mode' : safeMode.watchOnly ? 'watch' : 'ready'}. Sync workspace data when you want review queues, changed files, and recent runs.`,
      approvals: { total: 0 },
      approvalQueue: [],
      healthCards: [],
      workers: [],
      safeMode,
    },
    promotions,
    reviewer: {
      status: 'ready',
      summary: 'Sync the workspace to let Reviewer inspect changed files, validation, and approvals.',
      nextAction: 'Open Monitor after a full sync to review the latest Test Bench snapshot.',
      notes: [],
      revisionCandidates: [],
    },
    regression: {
      summary: 'Sync the workspace to generate regression candidates from changed files and review feedback.',
      candidateCount: 0,
      candidates: [],
    },
    testBench: {
      status: 'ready',
      summary: 'Sync the workspace to build the latest Test Bench snapshot.',
      preferredPath: '',
      changedFiles: [],
      failingLocations: [],
      recentArtifacts: [],
      reviewer: {
        status: 'ready',
        notes: [],
        revisionCandidates: [],
      },
      regression: {
        candidateCount: 0,
        candidates: [],
      },
      latestRun: {},
    },
    learningJournal: learningStatus,
    settings,
    taskHub,
    acceptance,
    vscodeSetup,
    extensionHealth,
    modelFoundry,
    integrations,
    appRollbacks,
    benchmarks: { runs: [] },
    updates: latestUpdateStatus,
    selfImprovement,
  });
  const systemCheck = buildSystemCheck({
    workspaceRoot: statusWorkspaceRoot || DEFAULT_TARGET_WORKSPACE,
    targetWorkspaceRoot: targetWorkspaceRoot || statusWorkspaceRoot || DEFAULT_TARGET_WORKSPACE,
    labRoot: selectedLabRoot,
    assistantConfig,
    acceptance,
    learningJournal: learningStatus,
    promotions,
    readiness,
    taskHub,
  });
  return {
    workspaceRoot,
    targetWorkspaceRoot,
    selectedLabRoot,
    bats: [],
    summary: summarizeBats([]),
    recentRuns: [],
    followupBats: null,
    latestSprint: null,
    changedFiles: [],
    worktree: {
      scopeLabel: selectedLabRoot ? 'active lab' : 'workspace',
      targetRoot: targetWorkspaceRoot,
      labRoot: selectedLabRoot,
    },
    runtimeContext: {},
    editorContext: { files: [], activeFile: '', activeLine: 1 },
    review: {
      changedFiles: [],
      failingLocations: [],
      recentArtifacts: [],
      decisions: {},
      selection: getReviewSelectionState(),
    },
    preflight: { ok: true, checks: [] },
    updates: latestUpdateStatus,
    manager: {
      summaryText: `Shell ready. Safety ${safeMode.active ? 'safe-mode' : safeMode.watchOnly ? 'watch' : 'ready'}. Sync workspace data when you want review queues, changed files, and recent runs.`,
      approvals: { total: 0 },
      approvalQueue: [],
      healthCards: [],
      workers: [],
      safeMode,
    },
    reviewer: {
      status: 'ready',
      summary: 'Sync the workspace to let Reviewer inspect changed files, validation, and approvals.',
      nextAction: 'Open Monitor after a full sync to review the latest Test Bench snapshot.',
      notes: [],
      revisionCandidates: [],
    },
    regression: {
      summary: 'Sync the workspace to generate regression candidates from changed files and review feedback.',
      candidateCount: 0,
      candidates: [],
    },
    testBench: {
      status: 'ready',
      summary: 'Sync the workspace to build the latest Test Bench snapshot.',
      preferredPath: '',
      changedFiles: [],
      failingLocations: [],
      recentArtifacts: [],
      reviewer: {
        status: 'ready',
        notes: [],
        revisionCandidates: [],
      },
      regression: {
        candidateCount: 0,
        candidates: [],
      },
      latestRun: {},
    },
    dashboardLayout: getDesktopDashboardLayoutPayload(),
    workspaceSelection: buildWorkspaceSelectionPayload(workspaceRoot),
    labs: { labs: [] },
    promotions,
    learningJournal: learningStatus,
    selfImprovement,
    benchmarks: { runs: [] },
    acceptance,
    vscodeSetup,
    extensionHealth,
    modelFoundry,
    integrations,
    appRollbacks,
    readiness,
    systemCheck,
    taskHub,
    operatorLoop: buildTaskLoopSnapshot(workspaceRoot),
    recovery: { runs: [] },
    settings,
  };
}

async function handleAgentRun(action, payload = {}) {
  updateLearningJournalScope(payload);
  const targetWorkspaceRoot = payload.targetWorkspaceRoot || payload.workspace || getTargetWorkspaceRoot();
  const aiEnvOverrides = await buildAiEnvOverrides(targetWorkspaceRoot);
  const nextPayload = {
    ...payload,
    envOverrides: {
      ...(payload.envOverrides && typeof payload.envOverrides === 'object' ? payload.envOverrides : {}),
      ...aiEnvOverrides,
    },
  };
  return agentRuntimeService.handleRun(action, nextPayload);
}

function mergeTaskLoopMemoryHints(execution = {}, learningStatus = {}) {
  const journalMemoryHints = learningStatus && typeof learningStatus.memoryHints === 'object'
    ? learningStatus.memoryHints
    : {};
  if (!execution || typeof execution !== 'object') {
    return execution;
  }
  const learningMetadata = execution.learningMetadata && typeof execution.learningMetadata === 'object'
    ? execution.learningMetadata
    : {};
  const mergedMemoryHints = mergeMemoryHints(
    execution.memoryHints,
    learningMetadata.memoryHints,
    journalMemoryHints,
  );
  if (Object.keys(mergedMemoryHints).length === 0) {
    return execution;
  }
  return {
    ...execution,
    learningMetadata: {
      ...learningMetadata,
      memoryHints: mergedMemoryHints,
    },
    memoryHints: mergedMemoryHints,
  };
}

function buildTaskLoopSnapshot(workspaceRoot = getWorkspaceRoot(), learningStatus = learningJournal.getStatus()) {
  const latestExecution = mergeTaskLoopMemoryHints(latestTaskLoopExecution(), learningStatus);
  return {
    workspaceRoot: workspaceRoot || '',
    lanes: AI_CAPABILITY_LANES,
    latestExecution,
    latestRequest: latestTaskLoopSession.request
      ? {
          laneId: latestTaskLoopSession.request.laneId,
          laneLabel: latestTaskLoopSession.request.laneLabel,
          task: latestTaskLoopSession.request.task,
          taskMode: latestTaskLoopSession.request.taskMode,
          action: latestTaskLoopSession.request.action,
        }
      : null,
  };
}

function summarizeTaskLoopFromLatest(payload = {}) {
  const base = latestTaskLoopExecution();
  if (!base) {
    return {
      ok: false,
      message: 'No completed run is available to summarize yet.',
      laneId: 'ops-summary',
      laneLabel: 'Ops summary',
      task: String(payload.task || '').trim(),
      taskMode: 'summarizer',
      action: 'summarize',
      retryAvailable: false,
      repairAvailable: false,
      operatorExecution: {},
    };
  }
  const resultSummary = String(
    payload.task
    || base.resultSummary
    || base.reviewSummary?.summary
    || base.runSummary?.summary
    || base.testSummary?.summary
    || 'Summarized the latest operator run.'
  ).trim();
  const operatorExecution = {
    ...base,
    task: String(payload.task || base.task || '').trim(),
    taskMode: 'summarizer',
    action: 'summarize',
    status: 'completed',
    stageSummary: {
      ...(base.stageSummary || {}),
      currentStage: 'summary',
      summary: resultSummary,
    },
    resultSummary,
  };
  latestTaskLoopSession.latestExecution = operatorExecution;
  return buildTaskLoopPayload({
    request: {
      laneId: 'ops-summary',
      laneLabel: 'Ops summary',
      task: operatorExecution.task,
      taskMode: 'summarizer',
      action: 'summarize',
    },
    execution: operatorExecution,
    ok: true,
    message: resultSummary,
  });
}

async function runHelperTaskLoopLane(lane, payload = {}) {
  const { workspaceRoot, targetWorkspaceRoot, labRoot } = resolveRequestRoots(payload);
  const task = String(payload.task || payload.objective || '').trim();
  if (!task) {
    return {
      ok: false,
      message: 'Enter a repo task before running this lane.',
      laneId: lane.laneId,
      laneLabel: lane.laneLabel,
      task: '',
      taskMode: lane.taskMode,
      action: lane.action,
      operatorExecution: {},
    };
  }
  const prompt = lane.laneId === 'research-docs'
    ? `Research the trusted docs and summarize the next safe coding move for this repo task:\n${task}`
    : task;
  const reply = await handleAssistantChat(targetWorkspaceRoot, prompt, {
    chatHistory: [],
    chatContext: {
      activeView: 'workbench',
      laneId: lane.laneId,
      laneLabel: lane.laneLabel,
      workspaceRoot,
      targetWorkspaceRoot,
      labRoot,
    },
  });
  const operatorExecution = {
    task,
    taskMode: lane.taskMode,
    action: lane.action,
    taskObjective: {
      kind: lane.laneId === 'research-docs' ? 'research' : 'chat',
      summary: task,
      source: 'desktop-workbench',
      laneId: lane.laneId,
    },
    runId: '',
    status: 'completed',
    runState: 'completed',
    stageSummary: {
      currentStage: lane.laneId === 'research-docs' ? 'research' : 'chat',
      summary: String(reply?.reply || 'Completed helper lane response.'),
      finalState: 'completed',
    },
    resultSummary: String(reply?.reply || 'Completed helper lane response.'),
    diffSummary: '',
    changedFiles: [],
    changedFileCount: 0,
    outputTail: {
      combined: '',
      stdout: '',
      stderr: '',
    },
    reviewSummary: {},
    trustSummary: {},
    runSummary: {},
    testSummary: {},
    benchmarkMetadata: {},
    learningMetadata: {},
    retryAvailable: false,
    repairAvailable: false,
    artifactPaths: [],
  };
  latestTaskLoopSession.request = {
    laneId: lane.laneId,
    laneLabel: lane.laneLabel,
    task,
    taskMode: lane.taskMode,
    action: lane.action,
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
  };
  latestTaskLoopSession.latestExecution = operatorExecution;
  return buildTaskLoopPayload({
    request: latestTaskLoopSession.request,
    execution: operatorExecution,
    ok: true,
    message: operatorExecution.resultSummary,
  });
}

async function executeTaskLoop(payload = {}) {
  const lane = resolveTaskLoopLane(payload.laneId || payload.activeLaneId || payload.lane);
  const planned = agentRuntimeService.buildTaskLoopRequest({
    ...payload,
    laneId: lane.laneId,
  });
  latestTaskLoopSession.request = {
    laneId: planned.laneId,
    laneLabel: planned.laneLabel,
    task: planned.task,
    taskMode: planned.taskMode,
    action: planned.action,
    workspaceRoot: planned.request.workspaceRoot,
    targetWorkspaceRoot: planned.request.targetWorkspaceRoot,
    labRoot: planned.request.labRoot,
  };
  if (lane.laneId === 'ops-summary') {
    return summarizeTaskLoopFromLatest({
      ...payload,
      task: planned.task,
    });
  }
  if (lane.laneId === 'chat-fast' || lane.laneId === 'research-docs') {
    return runHelperTaskLoopLane(lane, {
      ...payload,
      task: planned.task,
    });
  }
  if (lane.laneId === 'repair-fast') {
    return repairTaskLoop({
      ...payload,
      task: planned.task,
    });
  }
  const run = agentRuntimeService.handleRun(planned.action, planned.request);
  if (!run?.runId) {
    return buildTaskLoopPayload({
      request: latestTaskLoopSession.request,
      execution: {},
      ok: false,
      message: String(run?.message || 'Unable to start the task loop.'),
    });
  }
  const finalEvent = await agentRuntimeService.waitForRunCompletion(run.runId);
  const operatorExecution = summarizeOperatorExecutionFromRun(finalEvent || {});
  latestTaskLoopSession.latestExecution = operatorExecution;
  return buildTaskLoopPayload({
    request: {
      ...latestTaskLoopSession.request,
      runId: run.runId,
    },
    execution: operatorExecution,
    ok: String(finalEvent?.state || '').toLowerCase() === 'pass',
    message: operatorExecution.resultSummary || finalEvent?.blockedReason || '',
  });
}

async function retryTaskLoop(payload = {}) {
  if (!latestTaskLoopSession.request) {
    return {
      ok: false,
      message: 'No prior task loop run is available to retry yet.',
      operatorExecution: {},
    };
  }
  return executeTaskLoop({
    ...latestTaskLoopSession.request,
    ...payload,
    laneId: payload.laneId || latestTaskLoopSession.request.laneId,
    task: payload.task || latestTaskLoopSession.request.task,
  });
}

async function repairTaskLoop(payload = {}) {
  const request = latestTaskLoopSession.request || {};
  const latestExecution = latestTaskLoopExecution() || {};
  const ticket = String(payload.ticket || latestExecution.ticket || '').trim();
  const roots = resolveRequestRoots({
    workspaceRoot: payload.workspaceRoot || request.workspaceRoot,
    targetWorkspaceRoot: payload.targetWorkspaceRoot || request.targetWorkspaceRoot,
    labRoot: payload.labRoot || request.labRoot,
  });
  if (!ticket) {
    return {
      ok: false,
      message: 'Repair needs a ticket-backed failed run before the repair loop can start.',
      laneId: 'repair-fast',
      laneLabel: 'Repair fast',
      task: String(payload.task || request.task || '').trim(),
      taskMode: 'repair',
      action: 'repair',
      operatorExecution: latestExecution,
    };
  }
  const run = runRepairLoop({
    workspaceRoot: roots.workspaceRoot,
    workspace: roots.targetWorkspaceRoot,
    targetWorkspaceRoot: roots.targetWorkspaceRoot,
    labRoot: roots.labRoot,
    ticket,
  });
  if (!run?.runId) {
    return buildTaskLoopPayload({
      request: {
        laneId: 'repair-fast',
        laneLabel: 'Repair fast',
        task: String(payload.task || request.task || '').trim(),
        taskMode: 'repair',
        action: 'repair',
      },
      execution: latestExecution,
      ok: false,
      message: String(run?.message || 'Unable to start the repair loop.'),
    });
  }
  const finalEvent = await agentRuntimeService.waitForRunCompletion(run.runId);
  const operatorExecution = summarizeOperatorExecutionFromRun(finalEvent || {});
  operatorExecution.taskMode = 'repair';
  operatorExecution.action = 'repair';
  latestTaskLoopSession.request = {
    laneId: 'repair-fast',
    laneLabel: 'Repair fast',
    task: String(payload.task || request.task || '').trim(),
    taskMode: 'repair',
    action: 'repair',
    workspaceRoot: roots.workspaceRoot,
    targetWorkspaceRoot: roots.targetWorkspaceRoot,
    labRoot: roots.labRoot,
  };
  latestTaskLoopSession.latestExecution = operatorExecution;
  return buildTaskLoopPayload({
    request: latestTaskLoopSession.request,
    execution: operatorExecution,
    ok: String(finalEvent?.state || '').toLowerCase() === 'pass',
    message: operatorExecution.resultSummary || finalEvent?.blockedReason || '',
  });
}

function buildWorkspaceSelectionPayload(workspaceRoot = getWorkspaceRoot()) {
  const selectedLabRoot = getSelectedLabRoot();
  return {
    currentRoot: workspaceRoot || '',
    currentTargetRoot: selectedLabRoot || workspaceRoot || '',
    selectedLabRoot,
    suggestedRoots: getSuggestedWorkspaceRoots(),
    appRoot: APP_ROOT,
    runtimeRoot: RUNTIME_ROOT,
    hasWorkspace: !!workspaceRoot,
  };
}

async function buildAiStatusPayload(workspaceRoot = getWorkspaceRoot()) {
  const tuningStatus = await getTrainingTuningStatus({ workspace: workspaceRoot });
  const benchmarks = listBenchmarkRuns(workspaceRoot);
  const settings = getDesktopSettingsPayload(workspaceRoot);
  const secretNames = Array.from(new Set([
    ...listRemoteProviderSecretNames(),
    String(settings.aiRemoteApiKeyName || '').trim(),
  ].filter(Boolean)));
  const secretAvailability = Object.fromEntries(
    await Promise.all(secretNames.map(async (name) => {
      if (process.env[name]) {
        return [name, true];
      }
      const secret = await getSecret(name);
      return [name, !!(secret?.ok && secret.value)];
    })),
  );
  return buildAiStatus({
    settings,
    tuningStatus,
    benchmarkRuns: benchmarks.runs,
    hasOpenAiKey: !!secretAvailability.OPENAI_API_KEY,
    secretAvailability,
  });
}

async function syncAssistantModelProfileSettings(workspaceRoot = getWorkspaceRoot()) {
  if (!workspaceRoot) {
    return null;
  }
  const aiStatus = await buildAiStatusPayload(workspaceRoot);
  const workspaceProfile = aiStatus?.dualModel?.workspaceProfile || aiStatus?.current?.workspaceWrappedProfile || aiStatus?.gsDev1?.activeWrappedProfile || null;
  const engineProfile = aiStatus?.dualModel?.engineProfile || aiStatus?.current?.engineWrappedProfile || workspaceProfile || null;
  if (!workspaceProfile || !engineProfile) {
    return null;
  }
  return writeAssistantModelSettings(workspaceRoot, {
    modelProfileId: workspaceProfile.id,
    modelDisplayName: workspaceProfile.displayName || workspaceProfile.label,
    baseModel: workspaceProfile.baseModel,
    baseProvider: workspaceProfile.baseProvider,
    providerSource: workspaceProfile.providerSource,
    workspaceModelProfileId: workspaceProfile.id,
    workspaceModelDisplayName: workspaceProfile.displayName || workspaceProfile.label,
    workspaceBaseModel: workspaceProfile.baseModel,
    workspaceBaseProvider: workspaceProfile.baseProvider,
    workspaceProviderSource: workspaceProfile.providerSource,
    engineModelProfileId: engineProfile.id,
    engineModelDisplayName: engineProfile.displayName || engineProfile.label,
    engineBaseModel: engineProfile.baseModel,
    engineBaseProvider: engineProfile.baseProvider,
    engineProviderSource: engineProfile.providerSource,
    plannerProvider: engineProfile.taskModeRoutes?.planner?.provider,
    plannerModel: engineProfile.taskModeRoutes?.planner?.model,
    coderProvider: workspaceProfile.taskModeRoutes?.coder?.provider,
    coderModel: workspaceProfile.taskModeRoutes?.coder?.model,
    validatorProvider: engineProfile.taskModeRoutes?.validator?.provider,
    validatorModel: engineProfile.taskModeRoutes?.validator?.model,
    summarizerProvider: engineProfile.taskModeRoutes?.summarizer?.provider,
    summarizerModel: engineProfile.taskModeRoutes?.summarizer?.model,
  });
}

function cloneMonitorEventBuffers() {
  return Object.fromEntries(
    Object.entries(monitorEventBuffers).map(([key, items]) => [key, Array.isArray(items) ? [...items] : []]),
  );
}

async function buildMonitorStatusPayload(workspaceRoot = getWorkspaceRoot()) {
  const snapshot = workspaceSnapshot();
  const aiStatus = await buildAiStatusPayload(workspaceRoot);
  const tuning = await getTrainingTuningStatus({ workspace: workspaceRoot });
  const acceptance = readLatestAcceptanceReport(workspaceRoot);
  return {
    ok: true,
    workspaceRoot,
    targetWorkspaceRoot: snapshot.targetWorkspaceRoot || workspaceRoot,
    labRoot: snapshot.selectedLabRoot || '',
    snapshot,
    aiStatus,
    tuning,
    acceptance,
    automations: listAutomations(workspaceRoot),
    promotions: listPromotionState(workspaceRoot, { labRoot: snapshot.selectedLabRoot || '' }),
    events: cloneMonitorEventBuffers(),
  };
}

function evaluateSafetyLevelGuard(action, payload = {}) {
  const { workspaceRoot, targetWorkspaceRoot, labRoot } = resolveRequestRoots(payload);
  const autonomySettings = getAutonomySettings(workspaceRoot);
  return applySafetyLevelToRequest(action, {
    ...payload,
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
  }, autonomySettings);
}

async function evaluateHardSafety(action, payload = {}) {
  const { workspaceRoot, targetWorkspaceRoot, labRoot } = resolveRequestRoots(payload);
  const assistantConfig = readAssistantConfig(workspaceRoot, { defaultWorkspace: DEFAULT_TARGET_WORKSPACE });
  const dashboard = parseAssistantDashboard(targetWorkspaceRoot || workspaceRoot) || {};
  const aiStatus = await buildAiStatusPayload(workspaceRoot);
  const safeMode = buildSafetyStatus({
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
    appRoot: APP_ROOT,
    latestRuntime: runtime.getStatus()?.latest?.[0] || null,
    baseline: dashboard.baseline || {},
    assistantConfig,
    backups: listBackups(workspaceRoot),
    promotions: listPromotionState(workspaceRoot, { labRoot }),
    resourcePolicy: aiStatus.resourcePolicy || {},
    schedulerRunning: !!schedulerStatusPayload().running,
  });
  const applied = applySafetyModeToRequest(action, {
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
  }, safeMode);
  return {
    safeMode,
    applied,
  };
}

function findTaskById(workspaceRoot, taskId) {
  return findTask(workspaceRoot, taskId);
}

function findGoalById(workspaceRoot, goalId) {
  return findGoal(workspaceRoot, goalId);
}

function buildTaskModelRoles(assistantConfig = {}) {
  return {
    workspace: {
      modelProfileId: String(assistantConfig.workspaceModelProfileId || assistantConfig.modelProfileId || '').trim(),
      modelDisplayName: String(assistantConfig.workspaceModelDisplayName || assistantConfig.modelDisplayName || '').trim(),
      baseModel: String(assistantConfig.workspaceBaseModel || assistantConfig.baseModel || '').trim(),
      providerSource: String(assistantConfig.workspaceProviderSource || assistantConfig.providerSource || '').trim().toLowerCase(),
    },
    engine: {
      modelProfileId: String(assistantConfig.engineModelProfileId || assistantConfig.workspaceModelProfileId || assistantConfig.modelProfileId || '').trim(),
      modelDisplayName: String(assistantConfig.engineModelDisplayName || '').trim(),
      baseModel: String(assistantConfig.engineBaseModel || assistantConfig.workspaceBaseModel || assistantConfig.baseModel || '').trim(),
      providerSource: String(assistantConfig.engineProviderSource || assistantConfig.workspaceProviderSource || assistantConfig.providerSource || '').trim().toLowerCase(),
    },
  };
}

function buildTaskLaunchBlockResult(task = {}, goal = {}, assessment = {}) {
  const blockedReason = String(
    assessment.blockingReason
    || assessment.recommendedAction
    || 'This task is outside the current model envelope.',
  ).trim();
  return {
    ok: false,
    blocked: true,
    blockedBy: 'model-fit',
    blockedReason,
    message: blockedReason,
    label: `Blocked task: ${task?.title || goal?.title || 'Untitled task'}`,
    goalId: String(goal?.id || task?.goalId || '').trim(),
    taskId: String(task?.id || '').trim(),
    taskEnvelope: assessment,
  };
}

async function launchUniversalTaskRun({ workspaceRoot, targetWorkspaceRoot, labRoot, task, goal, changeSessionId = '', label = '' }) {
  const objective = String(task?.objective || goal?.objective || '').trim();
  if (!objective) {
    return { ok: false, message: 'Task objective is missing.' };
  }
  const assistantConfig = readAssistantConfig(workspaceRoot, { defaultWorkspace: targetWorkspaceRoot || workspaceRoot || DEFAULT_TARGET_WORKSPACE });
  const taskEnvelope = buildTaskAutonomyAssessment(task, buildTaskModelRoles(assistantConfig));
  if (taskEnvelope.capabilityFit === 'overscoped') {
    if (task?.id) {
      updateTask(workspaceRoot, {
        taskId: task.id,
        patch: {
          status: 'needs-rescope',
          metadata: {
            ...(task.metadata && typeof task.metadata === 'object' ? task.metadata : {}),
            taskEnvelope,
            lastBlockedBy: 'model-fit',
            lastBlockedAt: new Date().toISOString(),
            lastBlockedReason: taskEnvelope.blockingReason || taskEnvelope.recommendedAction || '',
          },
        },
      });
    }
    return buildTaskLaunchBlockResult(task, goal, taskEnvelope);
  }
  const slices = Array.isArray(task?.slices) ? task.slices : [];
  const primarySlice = slices[0] || {};
  const compatibilityTicket = String(task?.metadata?.batTicket || task?.metadata?.ticket || '').trim();
  if (compatibilityTicket) {
    const compatibilityAction = String(task?.metadata?.defaultAction || 'run').trim().toLowerCase();
    const legacyAction = compatibilityAction === 'implement'
      ? 'implement'
      : compatibilityAction === 'plan'
        ? 'plan'
        : 'run';
    const legacyRun = await handleAgentRun(legacyAction, {
      workspaceRoot,
      workspace: targetWorkspaceRoot,
      targetWorkspaceRoot,
      labRoot,
      changeSessionId: changeSessionId || task?.changeSessionId || '',
      label: label || `BAT<${compatibilityTicket}> ${task?.title || goal?.title || 'Engine backlog task'}`,
      ticket: compatibilityTicket,
      profile: legacyAction === 'implement' ? 'aiWrite' : 'preview',
      template: 'auto',
      fixLoop: legacyAction === 'implement',
      objective,
      goalId: goal?.id || task?.goalId || '',
      taskId: task?.id || '',
      metadata: {
        ...(task?.metadata && typeof task.metadata === 'object' ? task.metadata : {}),
        source: 'task-hub',
        compatSource: task?.source || '',
        goalId: goal?.id || task?.goalId || '',
        taskId: task?.id || '',
        batTicket: compatibilityTicket,
        ring: task?.ring || (labRoot ? 'lab' : 'live'),
        candidateId: task?.candidateId || '',
        promotionState: task?.promotionState || task?.ring || (labRoot ? 'lab' : 'live'),
        sliceId: primarySlice.id || '',
        sliceIndex: Number.isFinite(Number(primarySlice.sliceIndex)) ? Number(primarySlice.sliceIndex) : null,
        sliceTargetPaths: Array.isArray(task?.sliceTargetPaths) ? task.sliceTargetPaths : [],
        slices,
        taskEnvelope,
      },
    });
    if (legacyRun?.runId && task?.id) {
      recordTaskRun(workspaceRoot, {
        taskId: task.id,
        goalId: goal?.id || task.goalId || '',
        runId: legacyRun.runId,
        action: legacyAction,
        status: 'running',
        intentType: 'launched-run',
        label: legacyRun.label || label,
        summary: legacyRun.blockedReason || '',
        targetWorkspaceRoot,
        labRoot,
        ring: task?.ring,
        candidateId: task?.candidateId,
        promotionState: task?.promotionState,
        sliceId: primarySlice.id || '',
        sliceIndex: primarySlice.sliceIndex,
        sliceTargetPaths: task?.sliceTargetPaths,
      });
    }
    return legacyRun;
  }
  const run = await handleAgentRun('orchestrate', {
    workspaceRoot,
    workspace: targetWorkspaceRoot,
    targetWorkspaceRoot,
    labRoot,
    changeSessionId: changeSessionId || task?.changeSessionId || '',
    label: label || `Task: ${task?.title || goal?.title || 'Untitled task'}`,
    objective,
    goalId: goal?.id || task?.goalId || '',
    taskId: task?.id || '',
    requestedCapabilities: Array.isArray(task?.capabilities) ? task.capabilities : [],
    acceptanceChecks: Array.isArray(task?.acceptanceChecks) ? task.acceptanceChecks : [],
    riskClass: String(task?.riskClass || 'medium'),
    budget: task?.budget && typeof task.budget === 'object' ? task.budget : {},
      metadata: {
        ...(task?.metadata && typeof task.metadata === 'object' ? task.metadata : {}),
        source: 'task-hub',
        goalId: goal?.id || task?.goalId || '',
      taskId: task?.id || '',
      ring: task?.ring || (labRoot ? 'lab' : 'live'),
      candidateId: task?.candidateId || '',
      promotionState: task?.promotionState || task?.ring || (labRoot ? 'lab' : 'live'),
      sliceId: primarySlice.id || '',
      sliceIndex: Number.isFinite(Number(primarySlice.sliceIndex)) ? Number(primarySlice.sliceIndex) : null,
      sliceTargetPaths: Array.isArray(task?.sliceTargetPaths) ? task.sliceTargetPaths : [],
      slices,
      taskEnvelope,
    },
  });
  if (run?.runId && task?.id) {
    recordTaskRun(workspaceRoot, {
      taskId: task.id,
      goalId: goal?.id || task.goalId || '',
      runId: run.runId,
      action: 'orchestrate',
      status: 'running',
      intentType: 'launched-run',
      label: run.label || label,
      summary: run.blockedReason || '',
      targetWorkspaceRoot,
      labRoot,
      ring: task?.ring,
      candidateId: task?.candidateId,
      promotionState: task?.promotionState,
      sliceId: primarySlice.id || '',
      sliceIndex: primarySlice.sliceIndex,
      sliceTargetPaths: task?.sliceTargetPaths,
    });
  }
  return run;
}

function normalizeBenchmarkExecutionMode(value, fallback = 'orchestrate') {
  const normalized = String(value || '').trim().toLowerCase();
  return ['orchestrate', 'baseline', 'lab-task'].includes(normalized) ? normalized : fallback;
}

function collectBenchmarkArtifactPaths(result) {
  const seen = new Set();
  const paths = [];
  const candidates = [];
  if (Array.isArray(result?.artifactPaths)) {
    candidates.push(...result.artifactPaths);
  }
  if (Array.isArray(result?.payload?.artifactPaths)) {
    candidates.push(...result.payload.artifactPaths);
  }
  if (Array.isArray(result?.artifact?.paths)) {
    candidates.push(...result.artifact.paths);
  }
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    paths.push(value);
  }
  return paths;
}

async function executeBenchmarkRun(payload = {}, options = {}) {
  const workspaceRoot = options.workspaceRoot || payload.workspaceRoot || getWorkspaceRoot();
  const targetWorkspaceRoot = options.targetWorkspaceRoot || payload.targetWorkspaceRoot || payload.labRoot || getTargetWorkspaceRoot();
  const labRoot = String(options.labRoot || payload.labRoot || '').trim();
  const safetyLevel = evaluateSafetyLevelGuard('benchmark', {
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
    ...payload,
  });
  if (safetyLevel.blocked) {
    return {
      ok: false,
      blocked: true,
      blockedBy: 'safety-level',
      message: safetyLevel.message || 'The current safety level blocked this benchmark run.',
      safetyLevel: safetyLevel.request?.safetyLevel || '',
    };
  }
  const safety = await evaluateHardSafety('benchmark', {
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
  });
  if (safety.applied.blocked) {
    return {
      ok: false,
      blocked: true,
      blockedBy: 'safe-mode',
      message: safety.applied.message || 'Safety guardrails blocked this benchmark run.',
      safetyStatus: safety.safeMode,
    };
  }
  const settings = getDesktopSettingsPayload(workspaceRoot);
  const aiStatus = await buildAiStatusPayload(workspaceRoot);
  const activeWrappedProfile = aiStatus?.gsDev1?.activeWrappedProfile || aiStatus?.wrappedProfiles?.find((profile) => profile.active) || null;
  const startedAt = nowIso();
  const defaultExecutionMode = payload.taskPath ? 'lab-task' : (options.defaultExecutionMode || 'orchestrate');
  const executionMode = normalizeBenchmarkExecutionMode(payload.executionMode || options.executionMode, defaultExecutionMode);
  let rawResult = null;
  let status = 'pass';
  let summary = 'Benchmark run completed.';

  if (executionMode === 'baseline') {
    rawResult = await runRuntimeApiAction(targetWorkspaceRoot, {
      action: 'engine-baseline-summary',
      targetWorkspaceRoot,
      workspace: targetWorkspaceRoot,
      projectRoot: targetWorkspaceRoot,
      contractPath: payload.contractPath || '',
    });
    status = rawResult?.ok ? 'pass' : 'fail';
    summary = rawResult?.message || rawResult?.label || 'Engine baseline summary captured.';
  } else if (executionMode === 'lab-task' || payload.taskPath) {
    rawResult = await runRuntimeApiAction(targetWorkspaceRoot, {
      action: 'lab-run-task',
      taskPath: payload.taskPath,
      targetWorkspaceRoot,
      workspace: targetWorkspaceRoot,
      projectRoot: targetWorkspaceRoot,
      contractPath: payload.contractPath || '',
    });
    status = rawResult?.ok ? 'pass' : 'fail';
    summary = rawResult?.payload?.summary || rawResult?.payload?.error || rawResult?.message || rawResult?.label || 'Benchmark task run completed.';
  } else {
    const benchmarkRun = await handleAgentRun('orchestrate', {
      workspaceRoot,
      workspace: targetWorkspaceRoot,
      targetWorkspaceRoot,
      labRoot,
      changeSessionId: payload.changeSessionId || '',
      objective: payload.objective || 'Run a benchmark-grade coding task and report latency, repair depth, and review signals.',
      label: payload.name || options.defaultName || 'Engine benchmark',
      requestedCapabilities: payload.capabilities || ['plan-reasoning', 'code-main', 'review-verify'],
    });
    rawResult = { ok: !!benchmarkRun?.runId, payload: benchmarkRun };
    status = benchmarkRun?.runId ? 'pass' : 'fail';
    summary = benchmarkRun?.blockedReason || benchmarkRun?.label || summary;
  }

  const completedAt = nowIso();
  const artifactPaths = collectBenchmarkArtifactPaths(rawResult);
  const benchmarkModel = settings.runtime === 'openai'
    ? (settings.aiRemoteModel || settings.model || 'gpt-4o-mini')
    : (payload.model || settings.ai?.trainingOllamaModel || settings.trainingOllamaModel || settings.model);
  const benchmark = recordBenchmarkRun(workspaceRoot, {
    id: payload.id,
    name: payload.name || options.defaultName || payload.recipe || payload.taskId || 'benchmark',
    model: benchmarkModel,
    modelProfileId: activeWrappedProfile?.id || settings.aiWrappedProfileId || '',
    wrappedProfileId: activeWrappedProfile?.id || settings.aiWrappedProfileId || '',
    baseModel: activeWrappedProfile?.baseModel || benchmarkModel,
    taskMode: String(payload.taskMode || 'coder').trim().toLowerCase(),
    providerSource: activeWrappedProfile?.providerSource || settings.runtime || '',
    benchmarkTags: activeWrappedProfile?.benchmarkTags || [],
    runtime: settings.runtime,
    status,
    ok: status !== 'fail',
    startedAt,
    completedAt,
    taskId: String(payload.taskId || '').trim(),
    recipe: String(payload.recipe || options.recipe || '').trim() || (executionMode === 'baseline'
      ? 'engine-baseline'
      : executionMode === 'lab-task'
        ? 'lab-run-task'
        : 'engine-benchmark'),
    workspaceRoot,
    targetRoot: targetWorkspaceRoot,
    labRoot,
    passRate: Number(payload.passRate || (status === 'fail' ? 0 : 100)),
    latencyMs: Number(payload.latencyMs || rawResult?.durationMs || 0),
    repairDepth: Number(payload.repairDepth || rawResult?.repairDepth || 0),
    approvalCount: Number(payload.approvalCount || (Array.isArray(rawResult?.approvalRequests) ? rawResult.approvalRequests.length : 0)),
    summary,
    artifactPaths,
    rawResult: rawResult?.payload || rawResult || {},
  });
  sendBenchmarkEvent({
    type: 'benchmark-recorded',
    timestamp: completedAt,
    name: benchmark.name,
    outputPath: benchmark.outputPath,
    status: benchmark.status,
    summary: benchmark.summary,
    recipe: benchmark.recipe,
  });
  return {
    ok: benchmark.ok,
    benchmark,
    rawResult,
    runs: listBenchmarkRuns(workspaceRoot),
  };
}

ipcMain.handle('app:bootstrap', async (_event, payload = {}) => {
  updateLearningJournalScope(payload);
  if (payload.captureLearning !== false) {
    await learningJournal.captureNow().catch(() => null);
  }
  return workspaceSnapshot();
});
ipcMain.handle('app:bootstrapLite', async (_event, payload = {}) => {
  updateLearningJournalScope(payload);
  return workspaceSnapshotLite();
});
ipcMain.handle('app:meta', async () => ({
  version: app.getVersion(),
  name: app.getName(),
  electron: process.versions.electron,
}));
ipcMain.handle('app:getSettings', async () => {
  const workspaceRoot = getWorkspaceRoot();
  return {
    ok: true,
    settings: getDesktopSettingsPayload(workspaceRoot),
    dashboardLayout: getDesktopDashboardLayoutPayload(),
    workspaceSelection: buildWorkspaceSelectionPayload(workspaceRoot),
  };
});

ipcMain.handle('app:pickWorkspace', async () => {
  const selected = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    defaultPath: getWorkspaceRoot() || getSuggestedWorkspaceRoots()[0] || APP_ROOT,
  });
  if (selected.canceled || selected.filePaths.length === 0) {
    return { ok: false, cancelled: true };
  }
  const workspaceRoot = setWorkspaceRoot(selected.filePaths[0]);
  clearSelectedLabRoot();
  updateLearningJournalScope({ workspaceRoot, clearLab: true });
  return {
    ok: true,
    workspaceRoot,
    snapshot: workspaceSnapshot(),
  };
});

ipcMain.handle('app:setWorkspace', async (_event, payload = {}) => {
  const workspaceRoot = setWorkspaceRoot(payload.workspaceRoot);
  if (payload.clearLab !== false) {
    clearSelectedLabRoot();
  }
  updateLearningJournalScope({ workspaceRoot, clearLab: payload.clearLab !== false });
  return {
    ok: true,
    workspaceRoot,
    snapshot: workspaceSnapshot(),
  };
});

ipcMain.handle('app:setLab', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot ? setWorkspaceRoot(payload.workspaceRoot) : getWorkspaceRoot();
  const selectedLabRoot = payload.labRoot ? setSelectedLabRoot(payload.labRoot) : clearSelectedLabRoot();
  updateLearningJournalScope({
    workspaceRoot,
    labRoot: selectedLabRoot,
    targetWorkspaceRoot: selectedLabRoot || workspaceRoot,
    threadId: payload.threadId || '',
    changeSessionId: payload.changeSessionId || '',
  });
  return {
    ok: true,
    workspaceRoot,
    selectedLabRoot,
    snapshot: workspaceSnapshot(),
  };
});

ipcMain.handle('assistant:attachments:pick', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const selected = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff'] },
    ],
    defaultPath: workspaceRoot || APP_ROOT,
  });
  if (selected.canceled || selected.filePaths.length === 0) {
    return { ok: false, cancelled: true, attachments: [] };
  }
  return importChatAttachments(workspaceRoot, {
    threadId: payload.threadId || '',
    filePaths: selected.filePaths,
  });
});

ipcMain.handle('app:updateSettings', async (_event, payload = {}) => {
  payload = normalizeSettingsUpdatePayload(payload);
  const workspaceRoot = getWorkspaceRoot();
  let resolvedAutonomyMode;
  if (payload.selectedLabRoot !== undefined) {
    if (payload.selectedLabRoot) {
      setSelectedLabRoot(payload.selectedLabRoot);
    } else {
      clearSelectedLabRoot();
    }
  }
  if (payload.model) {
    store.set('model', String(payload.model));
  }
  if (payload.mode) {
    store.set('mode', String(payload.mode));
  }
  if (payload.theme !== undefined) {
    store.set('theme', String(payload.theme || 'linen').trim().toLowerCase() || 'linen');
  }
  if (payload.layoutPreset !== undefined) {
    const layoutPreset = String(payload.layoutPreset || 'balanced').trim().toLowerCase();
    store.set('layoutPreset', ['balanced', 'focus', 'review', 'compact-review', 'summary'].includes(layoutPreset) ? layoutPreset : 'balanced');
  }
  if (payload.surfaceTemplate !== undefined) {
    const surfaceTemplate = String(payload.surfaceTemplate || 'board').trim().toLowerCase();
    store.set('surfaceTemplate', ['board', 'split', 'stacked', 'dense'].includes(surfaceTemplate) ? surfaceTemplate : 'board');
  }
  if (payload.safeLayoutMode !== undefined) {
    store.set('safeLayoutMode', !!payload.safeLayoutMode);
  }
  if (payload.startInChatWorkspace !== undefined) {
    store.set('startInChatWorkspace', !!payload.startInChatWorkspace);
  }
  if (payload.chatInspectorCollapsed !== undefined) {
    store.set('chatInspectorCollapsed', !!payload.chatInspectorCollapsed);
  }
  if (payload.chatInspectorWidth !== undefined) {
    store.set('chatInspectorWidth', Math.max(320, Math.min(620, Math.round(Number(payload.chatInspectorWidth) || 380))));
  }
  if (payload.chatUtilityMode !== undefined) {
    const chatUtilityMode = String(payload.chatUtilityMode || 'context').trim().toLowerCase();
    store.set('chatUtilityMode', ['context', 'diff', 'review'].includes(chatUtilityMode) ? chatUtilityMode : 'context');
  }
  if (payload.showLiveWork !== undefined) {
    store.set('showLiveWork', !!payload.showLiveWork);
  }
  if (payload.chatInstructionMode !== undefined) {
    const mode = String(payload.chatInstructionMode || 'auto').trim().toLowerCase();
    store.set('chatInstructionMode', ['off', 'auto', 'custom'].includes(mode) ? mode : 'auto');
  }
  if (payload.chatCustomInstructions !== undefined) {
    store.set('chatCustomInstructions', String(payload.chatCustomInstructions || '').trim());
  }
  if (payload.chatWorkbenchMode !== undefined) {
    const chatWorkbenchMode = String(payload.chatWorkbenchMode || 'focus').trim().toLowerCase();
    store.set('chatWorkbenchMode', ['focus', 'balanced', 'control-room'].includes(chatWorkbenchMode) ? chatWorkbenchMode : 'focus');
  }
  if (payload.chatComposerSize !== undefined) {
    const chatComposerSize = String(payload.chatComposerSize || 'tall').trim().toLowerCase();
    store.set('chatComposerSize', ['comfortable', 'tall'].includes(chatComposerSize) ? chatComposerSize : 'tall');
  }
  if (payload.learningLivePolling !== undefined) {
    store.set('learningLivePolling', !!payload.learningLivePolling);
  }
  if (payload.runtime) {
    const nextRuntime = String(payload.runtime);
    store.set('runtime', nextRuntime);
    if (store.get('aiManualMode') !== true) {
      const normalizedRuntime = nextRuntime.trim().toLowerCase();
      if (normalizedRuntime === 'openai') {
        const remoteProvider = resolveRemoteProviderPreset({
          aiRemoteProvider: payload.aiRemoteProvider !== undefined ? payload.aiRemoteProvider : store.get('aiRemoteProvider'),
          aiRemoteBaseUrl: payload.aiRemoteBaseUrl !== undefined ? payload.aiRemoteBaseUrl : store.get('aiRemoteBaseUrl'),
          aiRemoteApiKeyName: payload.aiRemoteApiKeyName !== undefined ? payload.aiRemoteApiKeyName : store.get('aiRemoteApiKeyName'),
        });
        store.set('model', String(payload.aiRemoteModel || store.get('aiRemoteModel') || remoteProvider.models?.[0]?.id || store.get('model') || 'gpt-4o-mini'));
      } else if (['ollama', 'local', 'hybrid'].includes(normalizedRuntime)) {
        const currentTuningSettings = readTrainingTuningSettings(workspaceRoot);
        store.set('model', String(currentTuningSettings.trainingOllamaModel || store.get('model') || 'qwen2.5-coder:7b'));
      }
    }
  }
  if (payload.localAiCmd !== undefined) {
    store.set('localAiCmd', normalizeLocalAiCmd(payload.localAiCmd || ''));
  }
  if (payload.aiManualMode !== undefined) {
    store.set('aiManualMode', !!payload.aiManualMode);
  }
  if (payload.aiBridgeProfile !== undefined) {
    const bridgeProfile = String(payload.aiBridgeProfile || 'llama-bridge').trim().toLowerCase();
    store.set(
      'aiBridgeProfile',
      AI_BRIDGE_PROFILES.some((item) => item.id === bridgeProfile) ? bridgeProfile : 'llama-bridge',
    );
  }
  if (payload.aiRemoteProvider !== undefined) {
    const nextRemoteProvider = normalizeRemoteProviderId(payload.aiRemoteProvider);
    store.set('aiRemoteProvider', nextRemoteProvider);
    if (store.get('aiManualMode') !== true && String(store.get('runtime') || '').trim().toLowerCase() === 'openai') {
      const remoteProvider = resolveRemoteProviderPreset({
        aiRemoteProvider: nextRemoteProvider,
        aiRemoteBaseUrl: payload.aiRemoteBaseUrl !== undefined ? payload.aiRemoteBaseUrl : store.get('aiRemoteBaseUrl'),
        aiRemoteApiKeyName: payload.aiRemoteApiKeyName !== undefined ? payload.aiRemoteApiKeyName : store.get('aiRemoteApiKeyName'),
      });
      store.set('model', String(store.get('aiRemoteModel') || remoteProvider.models?.[0]?.id || store.get('model') || 'gpt-4o-mini'));
    }
  }
  if (payload.aiRemoteModel !== undefined) {
    const remoteModel = String(payload.aiRemoteModel || '').trim();
    store.set('aiRemoteModel', remoteModel);
    if (remoteModel && store.get('aiManualMode') !== true && String(store.get('runtime') || '').trim().toLowerCase() === 'openai') {
      store.set('model', remoteModel);
    }
  }
  if (payload.aiRemoteBaseUrl !== undefined) {
    store.set('aiRemoteBaseUrl', String(payload.aiRemoteBaseUrl || '').trim());
  }
  if (payload.aiRemoteApiKeyName !== undefined || payload.aiRemoteProvider !== undefined) {
    const resolvedRemoteProvider = normalizeRemoteProviderId(payload.aiRemoteProvider !== undefined ? payload.aiRemoteProvider : store.get('aiRemoteProvider'));
    const normalizedSecretName = resolvedRemoteProvider === 'custom-compatible'
      ? normalizeRemoteProviderSecretName(
        payload.aiRemoteApiKeyName !== undefined ? payload.aiRemoteApiKeyName : store.get('aiRemoteApiKeyName'),
        'OPENAI_COMPAT_API_KEY',
      )
      : '';
    store.set('aiRemoteApiKeyName', normalizedSecretName);
  }
  if (payload.aiWrappedProfileId !== undefined) {
    store.set('aiWrappedProfileId', normalizeWrappedProfileId(payload.aiWrappedProfileId));
  }
  if (payload.aiWrappedProfiles !== undefined) {
    const wrappedProfiles = Array.isArray(payload.aiWrappedProfiles)
      ? payload.aiWrappedProfiles.map((profile) => normalizeWrappedProfile(profile))
      : [];
    store.set('aiWrappedProfiles', wrappedProfiles);
  }
  if (payload.aiProfile !== undefined) {
    store.set('aiProfile', normalizeProfileId(payload.aiProfile));
  }
  if (payload.aiRoutingPolicy !== undefined) {
    const fallbackProfile = normalizeProfileId(payload.aiProfile || store.get('aiProfile'));
    store.set('aiRoutingPolicy', normalizeRoutingPolicy(payload.aiRoutingPolicy, fallbackProfile));
  }
  if (payload.aiLaneOverrides !== undefined) {
    store.set('aiLaneOverrides', normalizeLaneOverrides(payload.aiLaneOverrides));
  }
  if (
    payload.runtime !== undefined
    || payload.model !== undefined
    || payload.aiRemoteProvider !== undefined
    || payload.aiRemoteModel !== undefined
    || payload.aiWrappedProfileId !== undefined
    || payload.aiWrappedProfiles !== undefined
    || payload.aiLaneOverrides !== undefined
  ) {
    await syncAssistantModelProfileSettings(workspaceRoot);
  }
  if (payload.githubEnabled !== undefined) {
    store.set('githubEnabled', !!payload.githubEnabled);
  }
  if (payload.autoUpdateEnabled !== undefined) {
    store.set('autoUpdateEnabled', !!payload.autoUpdateEnabled);
  }
  if (payload.autoUpdateAutoApply !== undefined) {
    store.set('autoUpdateAutoApply', !!payload.autoUpdateAutoApply);
  }
  if (payload.autoUpdateIntervalMinutes !== undefined) {
    store.set('autoUpdateIntervalMinutes', Math.max(5, Number(payload.autoUpdateIntervalMinutes) || 30));
  }
  if (payload.releaseFeedUrl !== undefined) {
    store.set('releaseFeedUrl', String(payload.releaseFeedUrl || '').trim());
  }
  if (payload.releaseAutoDownload !== undefined) {
    store.set('releaseAutoDownload', !!payload.releaseAutoDownload);
  }
  if (payload.autonomyMode !== undefined) {
    const nextMode = ['manual', 'supervised-auto', 'builder', 'operator', 'lab-full-auto', 'custom'].includes(String(payload.autonomyMode || '').toLowerCase())
      ? autonomyModeFromProfile(payload.autonomyMode)
      : String(payload.autonomyMode || 'guided').toLowerCase();
    resolvedAutonomyMode = nextMode;
    store.set('autonomyMode', nextMode);
  }
  if (payload.safetyLevel !== undefined) {
    store.set('safetyLevel', normalizeSafetyLevel(payload.safetyLevel));
  }
  if (payload.autoSynthesizeBats !== undefined) {
    store.set('autoSynthesizeBats', !!payload.autoSynthesizeBats);
  }
  if (payload.autoRetryUntilPass !== undefined) {
    store.set('autoRetryUntilPass', !!payload.autoRetryUntilPass);
  }
  if (payload.autoBrainstormOnFailure !== undefined) {
    store.set('autoBrainstormOnFailure', !!payload.autoBrainstormOnFailure);
  }
  if (payload.autoApproveLowRisk !== undefined) {
    store.set('autoApproveLowRisk', !!payload.autoApproveLowRisk);
  }
  if (payload.humanApprovalProtectedOnly !== undefined) {
    store.set('humanApprovalProtectedOnly', !!payload.humanApprovalProtectedOnly);
  }
  if (payload.sandboxRequired !== undefined) {
    store.set('sandboxRequired', !!payload.sandboxRequired);
  }
  if (payload.baselineSelfHealPriority !== undefined) {
    store.set('baselineSelfHealPriority', !!payload.baselineSelfHealPriority);
  }
  if (payload.supervisedAutoRunRecipes !== undefined) {
    store.set('supervisedAutoRunRecipes', !!payload.supervisedAutoRunRecipes);
  }
  if (payload.autoQueueTaskLoopFollowups !== undefined) {
    store.set('autoQueueTaskLoopFollowups', !!payload.autoQueueTaskLoopFollowups);
  }
  if (payload.autoRunQueuedTaskLoopFollowups !== undefined) {
    store.set('autoRunQueuedTaskLoopFollowups', !!payload.autoRunQueuedTaskLoopFollowups);
  }
  if (payload.maxRetryRounds !== undefined) {
    store.set('maxRetryRounds', Math.min(8, Math.max(1, Number(payload.maxRetryRounds) || 1)));
  }
  const tuningPayload = {};
  [
    'trainingProfile',
    'trainingLaunchSurface',
    'trainingEcoMode',
    'trainingCpuLimitPercent',
    'trainingThreadLimit',
    'trainingThermalPreset',
    'trainingThermalCustomC',
    'trainingPauseOnThermal',
    'trainingAllowDuringActiveUse',
    'trainingAutoStartOllama',
    'trainingOllamaModel',
    'trainingOllamaKeepAlive',
    'trainingModelStorageRoot',
    'trainingLiveSamplingSec',
    'trainingHardwareTarget',
  ].forEach((field) => {
    if (payload[field] !== undefined) {
      tuningPayload[field] = payload[field];
    }
  });
  if (Object.keys(tuningPayload).length > 0) {
    const nextTuningSettings = writeTrainingTuningSettings(workspaceRoot || APP_ROOT, tuningPayload);
    if ((payload.trainingOllamaModel !== undefined || payload.trainingHardwareTarget !== undefined) && store.get('aiManualMode') !== true) {
      store.set('model', String(nextTuningSettings.trainingOllamaModel || store.get('model') || 'qwen2.5-coder:7b'));
    }
  }
  writeAssistantAutonomySettings(workspaceRoot, {
    safetyLevel: payload.safetyLevel !== undefined ? normalizeSafetyLevel(payload.safetyLevel) : undefined,
    autonomyMode: payload.autonomyMode !== undefined ? (resolvedAutonomyMode || String(payload.autonomyMode || 'guided').toLowerCase()) : undefined,
    autoSynthesizeBats: payload.autoSynthesizeBats,
    autoRetryUntilPass: payload.autoRetryUntilPass,
    autoBrainstormOnFailure: payload.autoBrainstormOnFailure,
    autoApproveLowRisk: payload.autoApproveLowRisk,
    humanApprovalProtectedOnly: payload.humanApprovalProtectedOnly,
    sandboxRequired: payload.sandboxRequired,
    baselineSelfHealPriority: payload.baselineSelfHealPriority,
    supervisedAutoRunRecipes: payload.supervisedAutoRunRecipes,
    autoQueueTaskLoopFollowups: payload.autoQueueTaskLoopFollowups,
    autoRunQueuedTaskLoopFollowups: payload.autoRunQueuedTaskLoopFollowups,
    maxRetryRounds: payload.maxRetryRounds,
  }, { defaultWorkspace: DEFAULT_TARGET_WORKSPACE });
  restartAutoUpdateMonitor();
  updateLearningJournalScope({
    workspaceRoot,
    labRoot: getSelectedLabRoot(),
    targetWorkspaceRoot: getTargetWorkspaceRoot(),
    threadId: payload.threadId || '',
    changeSessionId: payload.changeSessionId || '',
  });
  return {
    ok: true,
    settings: getDesktopSettingsPayload(workspaceRoot),
    dashboardLayout: getDesktopDashboardLayoutPayload(),
    workspaceSelection: buildWorkspaceSelectionPayload(workspaceRoot),
  };
});

ipcMain.handle('goals:list', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  return listGoals(workspaceRoot, payload);
});

ipcMain.handle('goals:create', async (_event, payload = {}) => {
  const { workspaceRoot, targetWorkspaceRoot, labRoot } = resolveRequestRoots(payload);
  const result = payload.createTask === false
    ? createGoal(workspaceRoot, {
      ...payload,
      targetWorkspaceRoot,
      labRoot,
    })
    : createGoalAndTask(workspaceRoot, {
      ...payload,
      targetWorkspaceRoot,
      labRoot,
    });
  if (result.goal) {
    learningJournal.recordEvent('goal-created', {
      goalId: result.goal.id,
      title: result.goal.title,
      objective: result.goal.objective,
    });
  }
  if (result.task) {
    learningJournal.recordEvent('task-created', {
      taskId: result.task.id,
      goalId: result.task.goalId,
      title: result.task.title,
      objective: result.task.objective,
    });
  }
  return result;
});

ipcMain.handle('goals:update', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  return updateGoal(workspaceRoot, payload);
});

ipcMain.handle('tasks:list', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  return listTasks(workspaceRoot, payload);
});

ipcMain.handle('tasks:create', async (_event, payload = {}) => {
  const { workspaceRoot, targetWorkspaceRoot, labRoot } = resolveRequestRoots(payload);
  const result = createTask(workspaceRoot, {
    ...payload,
    targetWorkspaceRoot,
    labRoot,
  });
  if (result.task) {
    learningJournal.recordEvent('task-created', {
      taskId: result.task.id,
      goalId: result.task.goalId,
      title: result.task.title,
      objective: result.task.objective,
    });
  }
  return result;
});

ipcMain.handle('tasks:run', async (_event, payload = {}) => {
  const { workspaceRoot, targetWorkspaceRoot, labRoot } = resolveRequestRoots(payload);
  const task = findTaskById(workspaceRoot, payload.taskId);
  if (!task) {
    return { ok: false, message: 'Task not found.' };
  }
  const goal = task.goalId ? findGoalById(workspaceRoot, task.goalId) : null;
  const run = await launchUniversalTaskRun({
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
    task,
    goal,
    changeSessionId: payload.changeSessionId || task.changeSessionId || '',
    label: payload.label || '',
  });
  learningJournal.recordEvent('task-run', {
    taskId: task.id,
    goalId: task.goalId || '',
    runId: run?.runId || '',
    label: run?.label || '',
  });
  return {
    ok: !!run?.runId,
    task,
    goal,
    run,
  };
});

ipcMain.handle('tasks:cancel', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const task = findTaskById(workspaceRoot, payload.taskId);
  if (!task || !task.lastRunId) {
    return { ok: false, message: 'Task does not have an active run.' };
  }
  return runtime.cancel(task.lastRunId);
});

ipcMain.handle('runs:list', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  return listRuns(workspaceRoot, payload, runtime.getStatus());
});

ipcMain.handle('runs:get', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const result = listRuns(workspaceRoot, { ...payload, limit: 200 }, runtime.getStatus());
  const runId = String(payload.runId || '').trim();
  const run = result.runs.find((item) => item.runId === runId || item.id === runId) || null;
  return {
    ok: !!run,
    run,
  };
});

ipcMain.handle('recipes:list', async () => listRecipes());

async function queueFollowupRecipeDefinition(workspaceRoot, targetWorkspaceRoot, labRoot, payload = {}, recipe = {}) {
  const result = queueFollowupRecipeTasks(workspaceRoot, recipe, {
    targetWorkspaceRoot,
    labRoot,
    threadId: payload.threadId || '',
    changeSessionId: payload.changeSessionId || '',
    ring: payload.ring || '',
    promotionState: payload.promotionState || '',
  });
  if (!result.ok || result.deduped) {
    return result;
  }
  const queued = buildQueuedRecipePayload(recipe, {
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
    threadId: payload.threadId || '',
    changeSessionId: payload.changeSessionId || '',
    ring: payload.ring || '',
    promotionState: payload.promotionState || '',
  });
  const createdTasks = result.createdTasks;
  const goalResult = { goal: result.goal || null };

  learningJournal.recordEvent('recipe-created', {
    recipeId: queued.recipe.id,
    title: queued.recipe.title,
    summary: queued.recipe.summary,
    stepCount: queued.recipe.stepCount,
    threadId: payload.threadId || '',
    changeSessionId: payload.changeSessionId || '',
  });
  result.createdTasks.forEach((task) => {
    learningJournal.recordEvent('task-created', {
      taskId: task.id,
      goalId: task.goalId || '',
      title: task.title || '',
      objective: task.objective || '',
      source: 'followup-recipe',
    });
  });
  let firstRun = null;
  const autonomy = getAutonomySettings(workspaceRoot);
  const shouldAutoRunFirstStep = payload.autoRunFirstStep === true
    || (autonomy.supervisedAutoRunRecipes === true && recipe.autoQueueEligible === true);
  if (shouldAutoRunFirstStep && result.createdTasks.length > 0 && String(result.createdTasks[0].riskClass || '').trim().toLowerCase() === 'low') {
    firstRun = await launchUniversalTaskRun({
      workspaceRoot,
      targetWorkspaceRoot,
      labRoot,
      task: result.createdTasks[0],
      goal: result.goal || null,
      changeSessionId: payload.changeSessionId || result.createdTasks[0].changeSessionId || '',
      label: `${queued.recipe.title} • ${createdTasks[0].title || 'Step 1'}`,
    });
    if (firstRun?.runId) {
      learningJournal.recordEvent('task-run', {
        taskId: result.createdTasks[0].id,
        goalId: result.createdTasks[0].goalId || '',
        runId: firstRun.runId,
        label: firstRun.label || '',
        source: 'followup-recipe',
      });
    }
  }
  return {
    ok: true,
    recipe: queued.recipe,
    goal: goalResult.goal || null,
    tasks: createdTasks,
    createdCount: createdTasks.length,
    run: firstRun,
  };
}

ipcMain.handle('recipes:queueFollowup', async (_event, payload = {}) => {
  const { workspaceRoot, targetWorkspaceRoot, labRoot } = resolveRequestRoots(payload);
  const recipe = payload.recipe && typeof payload.recipe === 'object' ? payload.recipe : {};
  return queueFollowupRecipeDefinition(workspaceRoot, targetWorkspaceRoot, labRoot, payload, recipe);
});

ipcMain.handle('recipes:queueTaskLoopNextAction', async (_event, payload = {}) => {
  const { workspaceRoot, targetWorkspaceRoot, labRoot } = resolveRequestRoots(payload);
  const snapshot = workspaceSnapshot();
  const execution = payload.execution && typeof payload.execution === 'object'
    ? payload.execution
    : snapshot.operatorLoop?.latestExecution || {};
  const manualTrigger = payload.autoTrigger !== true;
  const recipe = buildNextActionRecipe(execution);
  if (!recipe) {
    return {
      ok: false,
      queued: false,
      message: 'The current next safe action is not queueable as a bounded follow-up task yet.',
    };
  }
  const followupPlan = buildAutoFollowupPlan(execution, {
    settings: snapshot.settings || getDesktopSettingsPayload(workspaceRoot),
    safeMode: snapshot.manager?.safeMode || {},
    readiness: snapshot.readiness || {},
    pendingApprovals: Number(snapshot.manager?.approvals?.total || 0) || 0,
  });
  if (!manualTrigger && followupPlan.shouldQueue !== true) {
    return {
      ok: true,
      queued: false,
      autoTriggered: true,
      message: String(followupPlan.reason || 'Automatic follow-up queueing is blocked right now.'),
      plan: followupPlan,
      snapshot,
    };
  }
  const queuedRecipe = manualTrigger
    ? { ...recipe, autoQueueEligible: false }
    : (followupPlan.recipe || { ...recipe, autoQueueEligible: false });
  const result = await queueFollowupRecipeDefinition(
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
    {
      ...payload,
      autoRunFirstStep: manualTrigger ? false : followupPlan.shouldAutoRun === true,
    },
    queuedRecipe,
  );
  return {
    ...result,
    autoTriggered: !manualTrigger,
    plan: followupPlan,
    snapshot: workspaceSnapshot(),
  };
});

ipcMain.handle('recipes:run', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const recipeId = String(payload.recipeId || payload.id || payload.recipe || '').trim().toLowerCase();
  if (!recipeId) {
    return { ok: false, message: 'recipeId is required.' };
  }
  if (recipeId === 'engine-benchmark') {
    return executeBenchmarkRun({
      ...payload,
      recipe: recipeId,
    }, {
      workspaceRoot,
      defaultName: payload.name || 'Engine benchmark',
      defaultExecutionMode: payload.taskPath ? 'lab-task' : 'orchestrate',
      recipe: recipeId,
    });
  }
  if (recipeId === 'self-host') {
    return runLabRecipe(workspaceRoot, {
      ...payload,
      recipe: 'self-host',
      kind: payload.kind || 'persistent',
      selectAfterCreate: payload.selectAfterCreate !== false,
    });
  }
  if (recipeId === 'workspace-mirror') {
    return runLabRecipe(workspaceRoot, {
      ...payload,
      recipe: 'mirror',
      kind: payload.kind || 'persistent',
      selectAfterCreate: payload.selectAfterCreate !== false,
    });
  }
  if (recipeId === 'benchmark-self-host') {
    return runLabRecipe(workspaceRoot, {
      ...payload,
      recipe: 'benchmark-self-host',
      kind: payload.kind || 'scratch',
      selectAfterCreate: payload.selectAfterCreate !== false,
    });
  }
  if (recipeId === 'dummy-node-app' || recipeId === 'dummy-broken-node-app') {
    return runLabRecipe(workspaceRoot, {
      ...payload,
      recipe: recipeId,
      kind: payload.kind || 'scratch',
      selectAfterCreate: payload.selectAfterCreate !== false,
    });
  }
  if (recipeId === 'break-node-test') {
    if (payload.labRoot) {
      return runLabRecipe(workspaceRoot, {
        ...payload,
        recipe: 'break-node-test',
      });
    }
    const lab = runLabRecipe(workspaceRoot, {
      ...payload,
      recipe: 'mirror',
      kind: payload.kind || 'scratch',
      selectAfterCreate: true,
    });
    return runLabRecipe(workspaceRoot, {
      ...payload,
      labRoot: lab.labRoot,
      recipe: 'break-node-test',
    });
  }
  if (recipeId === 'docs-scout') {
    const lab = runLabRecipe(workspaceRoot, {
      ...payload,
      recipe: 'mirror',
      kind: payload.kind || 'scratch',
      selectAfterCreate: true,
      name: payload.name || 'docs-scout-trial',
    });
    return {
      ok: true,
      message: `Docs scout trial prepared in ${lab.labRoot}. Run the benchmark there before promoting any change.`,
      lab,
    };
  }
  return { ok: false, message: `Unknown recipe: ${recipeId}` };
});

ipcMain.handle('workspace:vscodeStatus', async (_event, payload = {}) => {
  const { targetWorkspaceRoot } = resolveRequestRoots(payload);
  return {
    ok: true,
    status: buildVsCodeSetupStatus(targetWorkspaceRoot),
  };
});

ipcMain.handle('workspace:vscodeBootstrap', async (_event, payload = {}) => {
  const { targetWorkspaceRoot } = resolveRequestRoots(payload);
  const result = bootstrapVsCodeWorkspace(targetWorkspaceRoot);
  return {
    ...result,
    snapshot: workspaceSnapshot(),
  };
});

ipcMain.handle('workspace:vscodeInstallCompanion', async (_event, payload = {}) => {
  const { targetWorkspaceRoot } = resolveRequestRoots(payload);
  const result = installVsCodeCompanion(targetWorkspaceRoot);
  return {
    ...result,
    snapshot: workspaceSnapshot(),
  };
});

ipcMain.handle('foundry:status', async (_event, payload = {}) => {
  const { workspaceRoot } = resolveRequestRoots(payload);
  return {
    ok: true,
    status: buildModelFoundryStatus(workspaceRoot, {
      benchmarks: listBenchmarkRuns(workspaceRoot),
      learning: learningJournal.getStatus(),
      acceptance: readLatestAcceptanceReport(workspaceRoot),
    }),
  };
});

ipcMain.handle('foundry:seed', async (_event, payload = {}) => {
  const { workspaceRoot } = resolveRequestRoots(payload);
  const context = {
    benchmarks: listBenchmarkRuns(workspaceRoot),
    learning: learningJournal.getStatus(),
    acceptance: readLatestAcceptanceReport(workspaceRoot),
  };
  const result = seedModelFoundryCandidate(workspaceRoot, {
    ...payload,
    context,
  });
  return {
    ...result,
    snapshot: workspaceSnapshot(),
  };
});

ipcMain.handle('ai:status', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  return buildAiStatusPayload(workspaceRoot);
});

ipcMain.handle('ai:profiles:list', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const status = await buildAiStatusPayload(workspaceRoot);
  return {
    ok: true,
    profiles: status.profiles,
    wrappedProfiles: status.wrappedProfiles || [],
    activeProfileId: status.profileId,
    activeWrappedProfileId: status.current?.wrappedProfileId || '',
  };
});

ipcMain.handle('ai:profiles:set', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const profileId = normalizeProfileId(payload.profileId || payload.id);
  store.set('aiProfile', profileId);
  if (!String(payload.keepRouting || '').trim()) {
    store.set('aiRoutingPolicy', normalizeRoutingPolicy(payload.routingPolicy, profileId));
  }
  await syncAssistantModelProfileSettings(workspaceRoot);
  return {
    ok: true,
    profileId,
    settings: getDesktopSettingsPayload(workspaceRoot),
  };
});

ipcMain.handle('ai:routing:get', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const settings = getDesktopSettingsPayload(workspaceRoot);
  return {
    ok: true,
    profileId: settings.aiProfile,
    wrappedProfileId: settings.aiWrappedProfileId,
    wrappedProfiles: settings.aiWrappedProfiles || settings.ai?.wrappedProfiles || [],
    routingPolicy: settings.aiRoutingPolicy,
    routingPolicies: settings.ai?.routingPolicies || AI_ROUTING_POLICIES,
    laneOverrides: settings.aiLaneOverrides || settings.ai?.laneOverrides || {},
    lanes: settings.ai?.capabilityLanes || AI_CAPABILITY_LANES,
    taskModes: settings.ai?.taskModes || GS_DEV1_TASK_MODES,
  };
});

ipcMain.handle('ai:routing:set', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const profileId = normalizeProfileId(payload.profileId || store.get('aiProfile'));
  store.set('aiProfile', profileId);
  store.set('aiRoutingPolicy', normalizeRoutingPolicy(payload.routingPolicy, profileId));
  if (payload.laneOverrides !== undefined) {
    store.set('aiLaneOverrides', normalizeLaneOverrides(payload.laneOverrides));
  }
  if (payload.wrappedProfileId !== undefined) {
    store.set('aiWrappedProfileId', normalizeWrappedProfileId(payload.wrappedProfileId));
  }
  await syncAssistantModelProfileSettings(workspaceRoot);
  return {
    ok: true,
    settings: getDesktopSettingsPayload(workspaceRoot),
  };
});

ipcMain.handle('ai:providers:list', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const status = await buildAiStatusPayload(workspaceRoot);
  return {
    ok: true,
    providers: status.providers,
  };
});

ipcMain.handle('ai:models:discover', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const status = await getTrainingTuningStatus({ workspace: workspaceRoot });
  return {
    ok: true,
    workspaceRoot,
    models: status?.telemetry?.models?.availableOptions || [],
    discovered: status?.telemetry?.models?.discovered || [],
    storageRoot: status?.telemetry?.models?.storageRoot || '',
    storageReachable: !!status?.telemetry?.models?.storageReachable,
  };
});

ipcMain.handle('ai:models:import', async (_event, payload = {}) => importStoredTrainingModels(payload));

ipcMain.handle('ai:benchmarks:list', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  return listBenchmarkRuns(workspaceRoot);
});

ipcMain.handle('ai:benchmarks:run', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  return executeBenchmarkRun(payload, {
    workspaceRoot,
    defaultName: payload.name || payload.recipe || 'Engine benchmark',
    defaultExecutionMode: payload.taskPath ? 'lab-task' : 'orchestrate',
    recipe: String(payload.recipe || '').trim() || 'engine-benchmark',
  });
});

ipcMain.handle('ai:telemetry', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const status = await getTrainingTuningStatus({ workspace: workspaceRoot });
  return {
    ok: true,
    telemetry: status.telemetry || {},
    settings: status.settings || {},
  };
});

ipcMain.handle('tools:list', async () => ({
  ok: true,
  tools: listTools(),
}));

ipcMain.handle('integrations:list', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getTargetWorkspaceRoot() || getWorkspaceRoot();
  return buildIntegrationStudioStatus(workspaceRoot, { appRoot: APP_ROOT });
});

ipcMain.handle('integrations:install', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getTargetWorkspaceRoot() || getWorkspaceRoot();
  const result = installIntegration(workspaceRoot, payload, { appRoot: APP_ROOT });
  pushMonitorEvent('updates', {
    type: 'integration-installed',
    timestamp: nowIso(),
    status: 'ready',
    message: `${result.integration?.label || result.integration?.id || 'Integration'} ${result.alreadyInstalled ? 'was already installed' : 'installed successfully'}.`,
  });
  return {
    ...result,
    snapshot: workspaceSnapshot(),
  };
});

ipcMain.handle('labs:list', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  return {
    ...listLabs(workspaceRoot),
    selectedLabRoot: getSelectedLabRoot(),
    targetWorkspaceRoot: getTargetWorkspaceRoot(),
  };
});

ipcMain.handle('labs:create', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const result = createLab(workspaceRoot, payload);
  if (payload.selectAfterCreate) {
    setSelectedLabRoot(result.labRoot);
    updateLearningJournalScope({
      workspaceRoot,
      labRoot: result.labRoot,
      targetWorkspaceRoot: result.labRoot,
      threadId: payload.threadId || '',
      changeSessionId: payload.changeSessionId || '',
    });
  }
  sendLabEvent({ type: 'created', timestamp: nowIso(), ...result });
  return {
    ok: true,
    lab: result,
    labs: listLabs(workspaceRoot),
    snapshot: workspaceSnapshot(),
  };
});

ipcMain.handle('labs:reset', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const result = resetLab(workspaceRoot, payload);
  sendLabEvent({ type: 'reset', timestamp: nowIso(), ...result });
  return {
    ok: true,
    result,
    labs: listLabs(workspaceRoot),
  };
});

ipcMain.handle('labs:destroy', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const result = destroyLab(workspaceRoot, payload);
  if (result.ok && getSelectedLabRoot() && path.resolve(getSelectedLabRoot()) === path.resolve(String(payload.labRoot || ''))) {
    clearSelectedLabRoot();
    updateLearningJournalScope({ workspaceRoot, clearLab: true });
  }
  sendLabEvent({ type: 'destroyed', timestamp: nowIso(), ...result });
  return {
    ok: !!result.ok,
    result,
    labs: listLabs(workspaceRoot),
    snapshot: workspaceSnapshot(),
  };
});

ipcMain.handle('labs:runRecipe', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const result = runLabRecipe(workspaceRoot, payload);
  if (payload.selectAfterCreate && result.labRoot) {
    setSelectedLabRoot(result.labRoot);
    updateLearningJournalScope({
      workspaceRoot,
      labRoot: result.labRoot,
      targetWorkspaceRoot: result.labRoot,
      threadId: payload.threadId || '',
      changeSessionId: payload.changeSessionId || '',
    });
  }
  sendLabEvent({ type: 'recipe', timestamp: nowIso(), ...result });
  return {
    ok: true,
    result,
    labs: listLabs(workspaceRoot),
    snapshot: workspaceSnapshot(),
  };
});

ipcMain.handle('promotions:list', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  return listPromotionState(workspaceRoot, { labRoot: payload.labRoot || getSelectedLabRoot() });
});

ipcMain.handle('promotions:createCandidate', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const result = createCandidate(workspaceRoot, {
    ...payload,
    labRoot: payload.labRoot || getSelectedLabRoot(),
  });
  pushMonitorEvent('updates', {
    type: 'candidate-created',
    timestamp: nowIso(),
    candidateId: result.candidate?.id || '',
    message: `Created candidate ${result.candidate?.name || result.candidate?.id || ''}.`,
  });
  return {
    ok: true,
    candidate: result.candidate,
    promotions: listPromotionState(workspaceRoot, { labRoot: payload.labRoot || getSelectedLabRoot() }),
  };
});

ipcMain.handle('promotions:promote', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const promotionState = listPromotionState(workspaceRoot, { labRoot: payload.labRoot || getSelectedLabRoot() });
  const candidate = Array.isArray(promotionState.candidates)
    ? promotionState.candidates.find((item) => String(item?.id || '') === String(payload.candidateId || ''))
    : null;
  const targetWorkspaceRoot = String(
    payload.targetWorkspaceRoot
    || candidate?.targetWorkspaceRoot
    || candidate?.sourceRoot
    || getWorkspaceRoot(),
  ).trim() || getWorkspaceRoot();
  const safetyLevel = evaluateSafetyLevelGuard('candidate-promote', {
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot: payload.labRoot || getSelectedLabRoot(),
  });
  if (safetyLevel.blocked) {
    return {
      ok: false,
      blocked: true,
      message: safetyLevel.message || 'The current safety level blocked this promotion.',
      safetyLevel: safetyLevel.request?.safetyLevel || '',
      promotions: listPromotionState(workspaceRoot, { labRoot: payload.labRoot || getSelectedLabRoot() }),
    };
  }
  const safety = await evaluateHardSafety('candidate-promote', {
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot: payload.labRoot || getSelectedLabRoot(),
  });
  if (safety.applied.blocked) {
    return {
      ok: false,
      blocked: true,
      message: safety.applied.message || 'Safety guardrails blocked this promotion.',
      safetyStatus: safety.safeMode,
      promotions: promotionState,
    };
  }
  const result = promoteCandidate(workspaceRoot, payload);
  pushMonitorEvent('updates', {
    type: 'candidate-promoted',
    timestamp: nowIso(),
    candidateId: result.candidate?.id || '',
    backupId: result.backup?.id || '',
    message: `Promoted candidate ${result.candidate?.name || result.candidate?.id || ''} to live.`,
  });
  return {
    ok: true,
    candidate: result.candidate,
    backup: result.backup,
    promotions: listPromotionState(workspaceRoot, { labRoot: payload.labRoot || getSelectedLabRoot() }),
    snapshot: workspaceSnapshot(),
  };
});

ipcMain.handle('promotions:rollback', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const result = rollbackPromotion(workspaceRoot, payload);
  pushMonitorEvent('updates', {
    type: 'promotion-rollback',
    timestamp: nowIso(),
    backupId: result.backupId,
    message: `Restored backup ${result.backupId}.`,
  });
  return {
    ok: true,
    result,
    promotions: listPromotionState(workspaceRoot, { labRoot: payload.labRoot || getSelectedLabRoot() }),
    snapshot: workspaceSnapshot(),
  };
});

ipcMain.handle('promotions:history', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const promotions = listPromotionState(workspaceRoot, { labRoot: payload.labRoot || getSelectedLabRoot() });
  return {
    ok: true,
    history: promotions.history || [],
    backups: promotions.backups || [],
    candidates: promotions.candidates || [],
  };
});

ipcMain.handle('monitor:status', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  return buildMonitorStatusPayload(workspaceRoot);
});

ipcMain.handle('monitor:events', async () => ({
  ok: true,
  events: cloneMonitorEventBuffers(),
}));

ipcMain.handle('monitor:recordOperatorFeedback', async (_event, payload = {}) => {
  const { workspaceRoot, targetWorkspaceRoot, labRoot } = resolveRequestRoots(payload);
  updateLearningJournalScope(payload);
  const snapshot = workspaceSnapshot();
  const verdict = String(payload.verdict || payload.status || 'comment').trim().toLowerCase() || 'comment';
  const normalizedVerdict = ['approved', 'needs-changes', 'comment'].includes(verdict) ? verdict : 'comment';
  const fallbackPath = String(
    payload.path
    || snapshot?.testBench?.preferredPath
    || getReviewSelectionState().path
    || ''
  ).trim();
  const note = String(payload.note || '').trim();
  const summary = String(
    note
    || payload.summary
    || snapshot?.reviewer?.summary
    || snapshot?.testBench?.summary
    || `${normalizedVerdict} feedback recorded`
  ).trim();
  const feedback = {
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
    path: fallbackPath,
    verdict: normalizedVerdict,
    note,
    summary,
    source: String(payload.source || 'monitor-runs'),
    trusted: normalizedVerdict === 'approved',
    targetRunId: String(payload.runId || snapshot?.taskHub?.runs?.[0]?.runId || ''),
  };
  const result = learningJournal.recordEvent('operator-feedback', feedback);
  pushMonitorEvent('learning', {
    type: 'operator-feedback',
    timestamp: nowIso(),
    status: normalizedVerdict,
    message: summary,
    path: fallbackPath,
  });
  return {
    ok: !!result.ok,
    feedback,
    snapshot: workspaceSnapshot(),
  };
});

ipcMain.handle('monitor:runAcceptance', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const result = await runEngineAcceptanceSuite(workspaceRoot, {
    selfHostSourceRoot: payload.selfHostSourceRoot || APP_ROOT,
    fullSelfHost: payload.fullSelfHost === true,
  });
  pushMonitorEvent('benchmarks', {
    type: 'engine-acceptance',
    timestamp: nowIso(),
    status: result.report?.overallStatus || (result.ok ? 'pass' : 'fail'),
    message: result.report?.summary || 'Engine acceptance run finished.',
    outputPath: result.outputPath || '',
  });
  return {
    ok: !!result.ok,
    outputPath: result.outputPath || '',
    acceptance: result.report || {},
    snapshot: workspaceSnapshot(),
  };
});

ipcMain.handle('monitor:setSafeMode', async (_event, payload = {}) => setManualSafeMode(payload));

ipcMain.handle('monitor:debugBundle', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  const status = await buildMonitorStatusPayload(workspaceRoot);
  const result = exportDebugBundle(workspaceRoot, {
    name: payload.name || 'monitor-debug',
    reason: payload.reason || 'operator-export',
    targetWorkspaceRoot: status.targetWorkspaceRoot,
    labRoot: status.labRoot,
    safeMode: status.snapshot?.manager?.safeMode || {},
    goals: status.snapshot?.taskHub?.goals || [],
    tasks: status.snapshot?.taskHub?.tasks || [],
    runs: status.snapshot?.taskHub?.runs || [],
    learningStatus: status.snapshot?.learningJournal || {},
    aiStatus: status.aiStatus || {},
    acceptance: status.acceptance || {},
    promotions: status.promotions || {},
    events: status.events || {},
  });
  return {
    ok: true,
    outputPath: result.outputPath,
  };
});

ipcMain.handle('learning:changes', async (_event, payload = {}) => {
  updateLearningJournalScope(payload);
  return learningJournal.listRecentChanges(payload.limit || 40);
});

ipcMain.handle('learning:status', async (_event, payload = {}) => {
  updateLearningJournalScope(payload);
  return learningJournal.getStatus();
});

ipcMain.handle('learning:export', async (_event, payload = {}) => {
  updateLearningJournalScope(payload);
  const result = learningJournal.exportRecentChanges();
  sendLearningEvent({ type: 'export', timestamp: nowIso(), ...result });
  return result;
});

ipcMain.handle('engine:benchmarks:list', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  return listBenchmarkRuns(workspaceRoot);
});

ipcMain.handle('engine:benchmarks:run', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspaceRoot || getWorkspaceRoot();
  return executeBenchmarkRun(payload, {
    workspaceRoot,
    defaultName: payload.name || payload.recipe || payload.taskId || 'benchmark',
    defaultExecutionMode: payload.taskPath ? 'lab-task' : 'baseline',
    recipe: String(payload.recipe || '').trim() || (payload.taskPath ? 'lab-run-task' : 'engine-baseline'),
  });
});

ipcMain.handle('app:secrets:set', async (_event, payload = {}) => setSecret(payload.name, payload.value));
ipcMain.handle('app:secrets:get', async (_event, payload = {}) => getSecret(payload.name));


// track state for new assistant features
let lastRunTicket = null;
let lastRunPassed = false;
let lastFailedTicket = null;
let lastPlannedTicket = null;
let lastReviewPath = '';
let lastReviewApprovalKey = '';
let auditEnforced = false;
const desktopEditorState = {
  activeFilePath: '',
  activeLine: 1,
  recentFiles: [],
};

function toWorkspaceRelative(workspaceRoot, filePath) {
  if (!workspaceRoot || !filePath) {
    return '';
  }
  const relative = path.relative(workspaceRoot, filePath);
  return relative && !relative.startsWith('..') ? relative.split(path.sep).join('/') : '';
}

function clipText(value, maxChars) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function schedulerLogPath(workspaceRoot) {
  return getAssistantSchedulerLogPath(workspaceRoot || getWorkspaceRoot());
}

function readSchedulerLogTail(workspaceRoot, maxChars = 12000) {
  const logPath = schedulerLogPath(workspaceRoot);
  try {
    if (!fs.existsSync(logPath)) {
      return { path: logPath, tail: '', updatedAt: null, externallyActive: false };
    }
    const stat = fs.statSync(logPath);
    const text = fs.readFileSync(logPath, 'utf8');
    const updatedAt = stat.mtime.toISOString();
    const externallyActive = (Date.now() - stat.mtimeMs) <= 15000;
    return {
      path: logPath,
      tail: clipText(text, maxChars),
      updatedAt,
      externallyActive,
    };
  } catch (_err) {
    return { path: logPath, tail: '', updatedAt: null, externallyActive: false };
  }
}

function rememberDesktopFile(relativePath, line = 1) {
  const normalized = String(relativePath || '').trim();
  if (!normalized) {
    return;
  }
  desktopEditorState.activeFilePath = normalized;
  desktopEditorState.activeLine = Math.max(1, Number(line || 1));
  desktopEditorState.recentFiles = [normalized, ...desktopEditorState.recentFiles.filter((item) => item !== normalized)].slice(0, 8);
}

function buildDesktopDiagnostics(latestRun, activeFilePath) {
  if (!latestRun || !activeFilePath) {
    return [];
  }
  const locations = Array.isArray(latestRun.locations) ? latestRun.locations : [];
  return locations
    .filter((item) => String(item.path || '') === activeFilePath)
    .slice(0, 5)
    .map((item) => ({
      message: item.message || item.name || 'Related validation issue',
      severity: 'error',
      startLine: Number(item.line || 1),
      endLine: Number(item.line || 1),
      source: 'runtime',
    }));
}

function buildSurroundingSnippet(workspaceRoot, relativePath, lineNumber) {
  const fullPath = sanitizeRelativePath(workspaceRoot, relativePath);
  if (!fullPath || !fs.existsSync(fullPath)) {
    return '';
  }
  try {
    const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
    const center = Math.max(0, Number(lineNumber || 1) - 1);
    const start = Math.max(0, center - 12);
    const end = Math.min(lines.length - 1, center + 12);
    return clipText(lines.slice(start, end + 1).join('\n'), 2500);
  } catch (_err) {
    return '';
  }
}

function buildCurrentFileDiff(workspaceRoot, relativePath) {
  const payload = getWorkspaceDiff(workspaceRoot, relativePath, { maxChars: 2500 });
  return payload && payload.ok ? clipText(payload.diff, 2500) : '';
}

function normalizeChatChangedFileList(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => {
      if (typeof item === 'string') {
        return item.trim();
      }
      return String(item?.path || '').trim();
    })
    .filter(Boolean)
    .slice(0, 6);
}

function buildChatRecentWorkContext(_workspaceRoot, payload = {}) {
  const incoming = payload && typeof payload === 'object' ? payload : {};
  const runtimeStatus = runtime.getStatus();
  const latestRuns = Array.isArray(runtimeStatus?.latest) ? runtimeStatus.latest : [];
  const requestedRunId = String(incoming.activeRunId || '').trim();
  const selectedRun = (requestedRunId
    ? latestRuns.find((run) => String(run?.runId || '').trim() === requestedRunId)
    : null)
    || latestRuns[0]
    || null;

  if (!selectedRun || typeof selectedRun !== 'object') {
    return {
      summary: '',
      workedAt: '',
      changedFiles: [],
      status: '',
      task: '',
      laneLabel: '',
      modelDisplayName: '',
      runId: '',
    };
  }

  const operatorExecution = selectedRun.operatorExecution && typeof selectedRun.operatorExecution === 'object'
    ? selectedRun.operatorExecution
    : {};
  const changedFiles = normalizeChatChangedFileList(
    operatorExecution.changedFiles
    || operatorExecution.changed_files
    || selectedRun.runtimeContext?.changed_files
    || selectedRun.runtimeContext?.changedFiles
    || [],
  );
  const task = String(operatorExecution.task || selectedRun.task || selectedRun.label || '').trim();
  const laneLabel = String(operatorExecution.laneLabel || selectedRun.laneLabel || '').trim();
  const status = String(operatorExecution.runState || operatorExecution.status || selectedRun.state || '').trim().toLowerCase();
  const modelDisplayName = String(
    operatorExecution.modelDisplayName
    || selectedRun.modelDisplayName
    || operatorExecution.modelProfileId
    || selectedRun.modelProfileId
    || ''
  ).trim();
  const workedAt = String(selectedRun.endedAt || selectedRun.startedAt || '').trim();
  const summaryParts = [];
  if (task) {
    summaryParts.push(task);
  }
  if (status) {
    summaryParts.push(`status ${status}`);
  }
  if (laneLabel) {
    summaryParts.push(`lane ${laneLabel}`);
  }
  if (modelDisplayName) {
    summaryParts.push(`model ${modelDisplayName}`);
  }
  if (workedAt) {
    summaryParts.push(`last worked ${workedAt}`);
  }
  if (changedFiles.length > 0) {
    summaryParts.push(`files ${changedFiles.slice(0, 3).join(', ')}`);
  }
  return {
    summary: clipText(summaryParts.join(' • '), 240),
    workedAt,
    changedFiles,
    status,
    task,
    laneLabel,
    modelDisplayName,
    runId: String(selectedRun.runId || '').trim(),
  };
}

function getReviewDecisions() {
  const payload = normalizeReviewDecisions(store.get('reviewDecisions'));
  const current = store.get('reviewDecisions') || {};
  if (JSON.stringify(current) !== JSON.stringify(payload)) {
    store.set('reviewDecisions', payload);
  }
  return payload;
}

function getReviewSelectionState() {
  return normalizeReviewSelection(store.get('reviewSelection'));
}

function rememberReviewSelection(selection = {}) {
  const normalized = normalizeReviewSelection(selection);
  store.set('reviewSelection', normalized);
  lastReviewPath = normalized.path || '';
  lastReviewApprovalKey = normalized.approvalKey || '';
  return normalized;
}

function isProtectedApprovalPath(relativePath) {
  const normalizedPath = normalizeReviewPath(relativePath).toLowerCase();
  if (!normalizedPath) {
    return false;
  }
  return [
    'payment',
    'wallet',
    'auth',
    'security',
    'migration',
    'network',
    'billing',
  ].some((term) => normalizedPath.includes(term));
}

function isLowRiskApprovalPath(relativePath) {
  const normalizedPath = normalizeReviewPath(relativePath).toLowerCase();
  if (!normalizedPath) {
    return false;
  }
  return normalizedPath.startsWith('docs/')
    || normalizedPath.startsWith('backend/tests/')
    || normalizedPath.startsWith('tests/')
    || normalizedPath.includes('/__tests__/')
    || normalizedPath.endsWith('.md');
}

function getUiSmokeApprovalFixturePath(workspaceRoot) {
  if (!UI_SMOKE_MODE || !workspaceRoot) {
    return '';
  }
  for (const candidate of UI_SMOKE_APPROVAL_FIXTURE_CANDIDATES) {
    if (fs.existsSync(path.join(workspaceRoot, candidate))) {
      return normalizeReviewPath(candidate);
    }
  }
  return '';
}

function ensureUiSmokeApprovalFixture(workspaceRoot) {
  const fixturePath = getUiSmokeApprovalFixturePath(workspaceRoot);
  if (!fixturePath) {
    return '';
  }
  if (uiSmokeApprovalFixtureWorkspace === workspaceRoot) {
    return fixturePath;
  }
  const decisions = getReviewDecisions();
  decisions[fixturePath] = {
    status: 'pending',
    note: '',
    updatedAt: new Date().toISOString(),
  };
  store.set('reviewDecisions', decisions);
  uiSmokeApprovalFixtureWorkspace = workspaceRoot;
  return fixturePath;
}

function injectUiSmokeApprovalFixture(workspaceRoot, review, fixturePath = '') {
  if (!fixturePath) {
    return review;
  }
  const fullPath = sanitizeRelativePath(workspaceRoot, fixturePath);
  if (!fullPath || !fs.existsSync(fullPath)) {
    return review;
  }
  const decisions = review?.decisions && typeof review.decisions === 'object' ? review.decisions : {};
  const fixtureDecision = decisions[fixturePath] || { status: 'pending', note: '' };
  const baseChangedFiles = Array.isArray(review?.changedFiles) ? review.changedFiles : [];
  const changedFiles = [
    {
      status: 'SMOKE',
      raw: `SMOKE ${fixturePath}`,
      path: fixturePath,
      line: 1,
      decision: String(fixtureDecision.status || 'pending'),
      note: String(fixtureDecision.note || ''),
    },
    ...baseChangedFiles.filter((item) => normalizeReviewPath(item?.path) !== fixturePath),
  ];
  return {
    ...(review || {}),
    changedFiles,
    decisions,
  };
}

function buildWorkspaceApprovalQueue(workspaceRoot, review, recentRuns = [], decisionsOverride = null, bats = []) {
  const autonomy = getAutonomySettings(workspaceRoot);
  const decisions = decisionsOverride && typeof decisionsOverride === 'object'
    ? decisionsOverride
    : getReviewDecisions();
  const queue = buildApprovalQueue({
    workspaceRoot,
    review,
    recentRuns,
    decisions,
    bats,
    autonomy,
    approvalRequiredPath,
    isProtectedApprovalPath,
    isLowRiskApprovalPath,
    collectRuntimeApprovalSignals,
    collectProtectedBatReviewSignals,
  });

  if (!autonomy.autoApproveLowRisk) {
    return queue;
  }

  const autoApproval = collectAutoApprovedDecisions(queue, decisions, {
    autoApproveLowRisk: autonomy.autoApproveLowRisk,
    isProtectedApprovalPath,
    isLowRiskApprovalPath,
  });
  if (autoApproval.approvedItems.length === 0) {
    return queue;
  }
  if (!(decisionsOverride && typeof decisionsOverride === 'object')) {
    store.set('reviewDecisions', autoApproval.decisions);
  }
  return buildApprovalQueue({
    workspaceRoot,
    review,
    recentRuns,
    decisions: autoApproval.decisions,
    bats,
    autonomy,
    approvalRequiredPath,
    isProtectedApprovalPath,
    isLowRiskApprovalPath,
    collectRuntimeApprovalSignals,
    collectProtectedBatReviewSignals,
  });
}

function resolveApprovalQueueTarget(queue) {
  const items = Array.isArray(queue) ? queue : [];
  if (lastReviewApprovalKey) {
    const keyed = items.find((item) => item.approvalKey === lastReviewApprovalKey);
    if (keyed) {
      return keyed;
    }
  }
  if (lastReviewPath) {
    const matches = items.filter((item) => item.path === lastReviewPath);
    if (matches.length === 1) {
      return matches[0];
    }
  }
  const storedSelection = getReviewSelectionState();
  const storedTarget = findApprovalItem(items, storedSelection);
  if (storedTarget) {
    return storedTarget;
  }
  return items[0] || null;
}

function approvalQueueSummary(queue) {
  const items = Array.isArray(queue) ? queue : [];
  const runtimeGenerated = items.filter((item) => ['runtime-approval', 'patch-review', 'review-summary'].includes(String(item.source || ''))).length;
  const lowConfidence = items.filter((item) => String(item.source || '') === 'patch-review').length;
  const runtimeApprovals = items.filter((item) => String(item.source || '') === 'runtime-approval').length;
  return {
    total: items.length,
    pending: items.filter((item) => item.status === 'pending').length,
    deferred: items.filter((item) => item.status === 'deferred').length,
    rejected: items.filter((item) => item.status === 'rejected').length,
    runtimeGenerated,
    runtimeApprovals,
    lowConfidence,
  };
}

function describeLocalAiStatus() {
  const localCmd = getConfiguredLocalAiCmd();
  if (localCmd) {
    return {
      state: 'ready',
      label: 'Local AI',
      detail: localCmd,
    };
  }
  if (process.env.LOCAL_AI_CMD) {
    return {
      state: 'ready',
      label: 'Local AI',
      detail: process.env.LOCAL_AI_CMD,
    };
  }
  return {
    state: 'warn',
    label: 'Local AI',
    detail: 'Set a Local AI command in Settings to enable local model runs.',
  };
}

function buildWorkerStates({ latestRuntime, runtimeRuns, scheduler, approvals, changedFileCount, baseline, training }) {
  const history = [];
  const seenRuns = new Set();
  for (const run of [latestRuntime, ...(Array.isArray(runtimeRuns) ? runtimeRuns : [])]) {
    if (!run || typeof run !== 'object') {
      continue;
    }
    const key = String(run.runId || `${run.action || ''}:${run.ticket || ''}:${run.startedAt || ''}:${run.label || ''}`);
    if (seenRuns.has(key)) {
      continue;
    }
    seenRuns.add(key);
    history.push(run);
  }

  const labelForRun = (run) => String(run?.label || run?.action || 'idle');
  const stateForRun = (run) => String(run?.state || 'idle').toLowerCase();
  const summaryForRun = (run) => {
    const ticket = String(run?.ticket || '').trim();
    return ticket ? `BAT<${ticket}>` : labelForRun(run);
  };
  const matchesRun = (run, pattern) => pattern.test(labelForRun(run).toLowerCase());
  const latestMatchingRun = (pattern) => history.find((run) => matchesRun(run, pattern)) || null;
  const isRunningAction = (pattern) => {
    const run = latestMatchingRun(pattern);
    return !!run && stateForRun(run) === 'running';
  };
  const lastActionResult = (pattern, { preferBlockedReason = false } = {}) => {
    const run = latestMatchingRun(pattern);
    if (!run) {
      return 'idle';
    }
    const label = labelForRun(run);
    const state = stateForRun(run);
    if (preferBlockedReason && state === 'skipped' && String(run?.blockedReason || '').trim()) {
      return `${label} • ${String(run.blockedReason).trim()}`;
    }
    return `${label} • ${state}`;
  };

  const plannerRun = latestMatchingRun(/plan/);
  const implementerRun = latestMatchingRun(/implement|autopilot|self-improve|sprint/);
  const trainerRun = latestMatchingRun(/train/);
  const analyzerRun = latestMatchingRun(/analyze|learn/);
  const trainingState = training && typeof training === 'object' ? training : {};
  const trainingPendingText = Number(trainingState.pendingRunsCount || 0) > 0
    ? `${Number(trainingState.pendingRunsCount || 0)} new run(s) since export`
    : 'Dataset current';

  return [
    {
      id: 'planner',
      role: 'Planner',
      status: isRunningAction(/plan/) ? 'running' : 'idle',
      currentTask: isRunningAction(/plan/) ? summaryForRun(plannerRun) : 'Ready to plan the next BAT',
      lastOutcome: lastActionResult(/plan/),
    },
    {
      id: 'implementer',
      role: 'Implementer',
      status: isRunningAction(/implement|autopilot|self-improve|sprint/) ? 'running' : (stateForRun(implementerRun) === 'fail' ? 'failed' : 'idle'),
      currentTask: isRunningAction(/implement|autopilot|self-improve|sprint/) ? summaryForRun(implementerRun) : 'Ready to run or implement assistant work',
      lastOutcome: lastActionResult(/implement|autopilot|self-improve|sprint/),
    },
    {
      id: 'reviewer',
      role: 'Reviewer',
      status: approvals.total > 0 ? 'pending' : 'ready',
      currentTask: approvals.total > 0
        ? `${approvals.total} approval item(s) waiting${approvals.runtimeGenerated > 0 ? ` • ${approvals.runtimeGenerated} runtime-generated` : ''}`
        : 'Approval inbox clear',
      lastOutcome: approvals.lowConfidence > 0
        ? `${approvals.lowConfidence} low-confidence patch item(s)`
        : (approvals.rejected > 0 ? `${approvals.rejected} rejected item(s)` : (approvals.deferred > 0 ? `${approvals.deferred} deferred item(s)` : 'No backlog')),
    },
    {
      id: 'trainer',
      role: 'Trainer',
      status: isRunningAction(/train/) ? 'running' : (trainingState.state || 'idle'),
      currentTask: isRunningAction(/train/)
        ? summaryForRun(trainerRun)
        : (!trainingState.exists
            ? 'Training dataset not exported yet'
            : (trainingState.stale ? 'Retraining recommended' : 'Training dataset ready')),
      lastOutcome: lastActionResult(/train/) !== 'idle'
        ? lastActionResult(/train/)
        : (!trainingState.exists
            ? 'No curated dataset exported yet'
            : `${Number(trainingState.exampleCount || 0)} examples • ${trainingPendingText}`),
    },
    {
      id: 'log-analyzer',
      role: 'Log Analyzer',
      status: isRunningAction(/analyze|learn/) ? 'running' : 'idle',
      currentTask: isRunningAction(/analyze|learn/) ? summaryForRun(analyzerRun) : 'Ready to analyze logs and learn from runs',
      lastOutcome: lastActionResult(/analyze|learn/),
    },
    {
      id: 'scheduler',
      role: 'Autopilot Scheduler',
      status: baseline?.backlogPaused ? 'warn' : (scheduler.running ? 'running' : (changedFileCount > 0 ? 'warn' : 'idle')),
      currentTask: baseline?.backlogPaused ? 'Backlog paused for self-heal mode' : (scheduler.running ? 'Continuous autopilot loop active' : 'Scheduler stopped'),
      lastOutcome: baseline?.reason || lastActionResult(/autopilot|self-improve|sprint/, { preferBlockedReason: true }) || scheduler.message || 'Scheduler idle',
    },
  ];
}

function getSafetyStatusSnapshot({ workspaceRoot, targetWorkspaceRoot, labRoot, latestRuntime, baseline, assistantConfig }) {
  const promotions = listPromotionState(workspaceRoot, { labRoot });
  return buildSafetyStatus({
    workspaceRoot,
    targetWorkspaceRoot: targetWorkspaceRoot || workspaceRoot,
    labRoot,
    appRoot: APP_ROOT,
    latestRuntime,
    baseline,
    assistantConfig,
    backups: listBackups(workspaceRoot),
    promotions,
    schedulerRunning: !!schedulerStatusPayload().running,
  });
}

function buildManagerSnapshot(workspaceRoot, context = {}) {
  const canonicalWorkspaceRoot = String(context.canonicalWorkspaceRoot || workspaceRoot || '').trim();
  const selectedLabRoot = String(context.selectedLabRoot || '').trim();
  const latestRuntime = context.latestRuntime || null;
  const recentRuns = Array.isArray(context.recentRuns) ? context.recentRuns : [];
  const changedFiles = Array.isArray(context.changedFiles) ? context.changedFiles : [];
  const review = context.review || {};
  const runtimeContext = normalizeRuntimeContext(context.runtimeContext || latestRuntime?.runtimeContext || recentRuns[0]?.runtimeContext || review?.runtimeContext || {});
  const preflight = context.preflight || null;
  const updates = context.updates || latestUpdateStatus || {};
  const storage = buildStorageSnapshot(workspaceRoot);
  const worktree = context.worktree || summarizeWorkspaceTopology(workspaceRoot, runtimeContext, { changedFiles });
  const assistantDashboard = parseAssistantDashboard(workspaceRoot) || {};
  const training = assistantDashboard.training && typeof assistantDashboard.training === 'object'
    ? assistantDashboard.training
    : { exists: false, exampleCount: 0, pendingRunsCount: 0, state: 'idle' };
  const learningRecord = readLatestDesktopLearningRecord(workspaceRoot);
  const approvedDocReference = readLatestApprovedDocumentationSource(workspaceRoot);
  const approvedDocsVault = buildApprovedDocumentationVault(workspaceRoot, {
    context: context.docsContext && typeof context.docsContext === 'object' ? context.docsContext : {},
  });
  const trainingHandoffArtifact = readLatestDesktopTrainingHandoff(workspaceRoot);
  const layoutDiagnosticsArtifact = readLatestLayoutDiagnosticsArtifact(workspaceRoot);
  const engineBaselineSummary = assistantDashboard.engineBaselineSummary && typeof assistantDashboard.engineBaselineSummary === 'object'
    ? assistantDashboard.engineBaselineSummary
    : {};
  const engineDailyReport = assistantDashboard.engineDailyReport && typeof assistantDashboard.engineDailyReport === 'object'
    ? assistantDashboard.engineDailyReport
    : {};
  const latestArtifactRun = recentRuns[0] || null;
  const currentRunDetail = summarizeRunDetail(latestArtifactRun || latestRuntime || {}, worktree);
  const runtimeBaseline = runtimeContext.baseline_state && typeof runtimeContext.baseline_state === 'object'
    ? runtimeContext.baseline_state
    : {};
  const baseline = Object.keys(runtimeBaseline).length > 0
    ? {
        state: String(runtimeBaseline.state || 'green'),
        blocked: runtimeBaseline.blocked === true,
        reason: String(runtimeBaseline.reason || ''),
        recentFailureCount: Number(runtimeBaseline.recent_failure_count || 0),
        clusterCount: Number(runtimeBaseline.cluster_count || 0),
        hotspot: runtimeBaseline.hotspot && typeof runtimeBaseline.hotspot === 'object' ? runtimeBaseline.hotspot : {},
      }
    : (assistantDashboard.baseline || { state: 'green', blocked: false, reason: 'Baseline healthy.' });
  const baselineDetail = baseline.selfHealMode
    ? (baseline.hotspot?.summary || baseline.reason || 'Baseline self-heal is active.')
    : (baseline.reason || baseline.resumeCondition || 'Baseline healthy.');
  const baselineFollowup = baseline.backlogPaused
    ? 'Backlog paused'
    : baseline.state === 'yellow'
      ? 'Backlog active; monitor latest failures.'
      : 'Backlog active';
  const assistantConfig = readAssistantConfig(canonicalWorkspaceRoot || workspaceRoot, { defaultWorkspace: DEFAULT_TARGET_WORKSPACE });
  const autonomousActions = buildAutonomousActionSummary({
    runtimeState: {
      runs: (Array.isArray(context.runtimeRuns) && context.runtimeRuns.length > 0
        ? context.runtimeRuns
        : [latestRuntime, ...recentRuns]).filter((run, index, items) => {
          const runId = String(run?.runId || '').trim();
          if (!runId) {
            return !!run;
          }
          return items.findIndex((item) => String(item?.runId || '').trim() === runId) === index;
        }),
      activeRuns: Array.isArray(runtime.getStatus()?.activeRuns) ? runtime.getStatus().activeRuns : [],
    },
    modelRoles: {
      workspace: {
        modelProfileId: String(assistantConfig.workspaceModelProfileId || assistantConfig.modelProfileId || '').trim(),
        modelDisplayName: String(assistantConfig.workspaceModelDisplayName || assistantConfig.modelDisplayName || '').trim(),
        baseModel: String(assistantConfig.workspaceBaseModel || assistantConfig.baseModel || '').trim(),
        providerSource: String(assistantConfig.workspaceProviderSource || assistantConfig.providerSource || '').trim().toLowerCase(),
      },
      engine: {
        modelProfileId: String(assistantConfig.engineModelProfileId || assistantConfig.workspaceModelProfileId || assistantConfig.modelProfileId || '').trim(),
        modelDisplayName: String(assistantConfig.engineModelDisplayName || '').trim(),
        baseModel: String(assistantConfig.engineBaseModel || assistantConfig.workspaceBaseModel || assistantConfig.baseModel || '').trim(),
        providerSource: String(assistantConfig.engineProviderSource || assistantConfig.workspaceProviderSource || assistantConfig.providerSource || '').trim().toLowerCase(),
      },
    },
    dailyTarget: Number(assistantConfig.dailySafeAutonomousTarget || 5),
  });
  const safeMode = getSafetyStatusSnapshot({
    workspaceRoot: canonicalWorkspaceRoot || workspaceRoot,
    targetWorkspaceRoot: workspaceRoot,
    labRoot: selectedLabRoot,
    latestRuntime,
    baseline,
    assistantConfig,
  });
  const baselineReportDetail = engineBaselineSummary.exists
    ? [
        engineBaselineSummary.summary,
        engineBaselineSummary.topIssuesText ? `Top issues ${engineBaselineSummary.topIssuesText}` : '',
        engineBaselineSummary.canonicalMarkdownPath || '',
      ].filter(Boolean).join(' • ')
    : '';
  const schedulerLog = readSchedulerLogTail(workspaceRoot);
  const schedulerBase = schedulerStatusPayload();
  const scheduler = {
    ...schedulerBase,
    running: !!schedulerBase.running || !!schedulerLog.externallyActive,
    message: schedulerBase.running
      ? schedulerBase.message
      : (schedulerLog.externallyActive
          ? `External scheduler activity detected (${schedulerLog.updatedAt || 'recent log update'}).`
          : schedulerBase.message),
    logTail: schedulerLog.tail,
    logPath: schedulerLog.path,
    updatedAt: schedulerLog.updatedAt,
    externallyActive: !!schedulerLog.externallyActive,
  };
  const queue = buildWorkspaceApprovalQueue(workspaceRoot, review, recentRuns, review?.decisions || null, context.bats || []);
  const approvals = approvalQueueSummary(queue);
  const localAi = describeLocalAiStatus();
  const activeRuns = Array.isArray(runtime.getStatus()?.activeRuns) ? runtime.getStatus().activeRuns.length : 0;
  const topValidationFingerprints = Array.isArray(assistantDashboard.top_validation_fingerprints)
    ? assistantDashboard.top_validation_fingerprints
    : [];
  const latestRetryPolicy = latestArtifactRun?.retryPolicy && typeof latestArtifactRun.retryPolicy === 'object'
    ? latestArtifactRun.retryPolicy
    : {};
  const latestEngineDecisions = Array.isArray(latestArtifactRun?.engineDecisions) ? latestArtifactRun.engineDecisions : [];
  const latestFingerprints = Array.isArray(latestArtifactRun?.validationFingerprints) ? latestArtifactRun.validationFingerprints : [];
  const engineFingerprintSummary = topValidationFingerprints.length
    ? topValidationFingerprints.slice(0, 2).map((item) => `${item.label}×${item.count}`).join(' • ')
    : latestFingerprints.slice(0, 2).map((item) => item.label).filter(Boolean).join(' • ');
  const engineDecisionSummary = latestEngineDecisions.slice(0, 2).map((item) => {
    if (item.type === 'retry-policy' && item.action) {
      return `${item.type}:${item.action}`;
    }
    return String(item.type || '').trim();
  }).filter(Boolean).join(' • ');
  const engineState = assistantDashboard.recent_count
    ? ((Number(assistantDashboard.blocked_count || 0) > 0 || Number(assistantDashboard.fail_count || 0) > 0 || latestRetryPolicy.action === 'handoff')
      ? 'warn'
      : (Number(assistantDashboard.skipped_count || 0) > 0 || latestRetryPolicy.action === 'rescope' || latestEngineDecisions.some((item) => item.type === 'repair-skip' || item.type === 'low-confidence-patches'))
        ? 'warn'
        : 'ready')
    : 'idle';
  const dailyEngineReportDetail = engineDailyReport.exists
    ? [
        engineDailyReport.summary,
        engineDailyReport.recommendedFocus ? `Focus ${engineDailyReport.recommendedFocus}` : '',
        engineDailyReport.topIssuesText ? `Top issues ${engineDailyReport.topIssuesText}` : '',
        engineDailyReport.canonicalMarkdownPath || '',
      ].filter(Boolean).join(' • ')
    : '';
  const testsState = latestRuntime?.state === 'fail'
    ? 'fail'
    : latestRuntime?.state === 'skipped'
      ? 'warning'
    : latestRuntime?.state === 'pass'
      ? 'ready'
      : latestRuntime?.state === 'running'
        ? 'running'
        : 'idle';
  const preflightBlocking = Number(preflight?.blockingCount || 0);

  const healthCards = [
    {
      id: 'worktree',
      label: 'Worktree',
      state: worktree.isolated ? (worktree.changedCount > 0 ? 'warn' : 'ready') : 'ready',
      value: worktree.scopeLabel || 'main workspace',
      detail: [
        worktree.displayName,
        worktree.activeFilePath ? `focus ${worktree.activeFilePath}` : '',
        worktree.allowedTargetPaths?.length ? `${worktree.allowedTargetPaths.length} target path${worktree.allowedTargetPaths.length === 1 ? '' : 's'}` : '',
      ].filter(Boolean).join(' • ') || 'Workspace scope not available',
    },
    {
      id: 'runtime',
      label: 'Agent Runtime',
      state: activeRuns > 0 ? 'running' : 'ready',
      value: activeRuns > 0 ? `${activeRuns} active` : 'Ready',
      detail: latestRuntime?.label || 'No active runs',
    },
    {
      id: 'scheduler',
      label: 'Scheduler',
      state: scheduler.running ? 'running' : 'idle',
      value: scheduler.running ? 'Auto on' : 'Auto off',
      detail: scheduler.message || 'Scheduler idle',
    },
    {
      id: 'approvals',
      label: 'Approvals',
      state: approvals.total > 0 ? 'warn' : 'ready',
      value: approvals.total > 0 ? `${approvals.total} waiting` : 'Inbox clear',
      detail: approvals.total > 0
        ? [
            `${approvals.pending} pending`,
            `${approvals.deferred} deferred`,
            `${approvals.rejected} rejected`,
            approvals.runtimeGenerated > 0 ? `${approvals.runtimeGenerated} runtime-generated` : '',
            approvals.lowConfidence > 0 ? `${approvals.lowConfidence} low-confidence` : '',
          ].filter(Boolean).join(' • ')
        : 'No manual approvals needed',
    },
    {
      id: 'baseline',
      label: 'Baseline',
      state: baseline.state === 'red' ? 'fail' : baseline.state === 'yellow' ? 'warn' : 'ready',
      value: baseline.selfHealMode ? 'Self-heal active' : baseline.state === 'yellow' ? 'Watch' : 'Healthy',
      detail: [baselineDetail, baselineFollowup, baselineReportDetail]
        .filter(Boolean)
        .join(' • '),
    },
    {
      id: 'safe-mode',
      label: 'Safety',
      state: safeMode.active ? 'fail' : safeMode.watchOnly ? 'warn' : 'ready',
      value: safeMode.active ? 'Safe mode' : safeMode.watchOnly ? 'Watch' : 'Healthy',
      detail: [
        safeMode.summary,
        safeMode.rollbackAvailable ? `${safeMode.backupCount} backup${safeMode.backupCount === 1 ? '' : 's'} ready` : '',
      ].filter(Boolean).join(' • '),
    },
    {
      id: 'storage',
      label: 'Storage',
      state: storage.state || 'idle',
      value: storage.trackedTotalText || '0 B',
      detail: storage.summaryText || 'Storage monitor unavailable',
    },
    {
      id: 'tests',
      label: 'Validation',
      state: testsState,
      value: latestRuntime?.state ? String(latestRuntime.state).toUpperCase() : 'Unknown',
      detail: latestRuntime?.label || 'No validation run recorded yet',
    },
    {
      id: 'engine',
      label: 'Engine',
      state: engineState,
      value: assistantDashboard.recent_count ? `${Number(assistantDashboard.pass_rate || 0)}% pass` : 'No runs yet',
      detail: [
        `${Number(assistantDashboard.blocked_count || 0)} blocked • ${Number(assistantDashboard.skipped_count || 0)} skipped`,
        latestRetryPolicy.action ? `retry ${latestRetryPolicy.action}` : '',
        engineFingerprintSummary,
        engineDecisionSummary,
        dailyEngineReportDetail,
      ].filter(Boolean).join(' • ') || 'Engine signals are clear',
    },
    {
      id: 'autonomy',
      label: 'Autonomy',
      state: autonomousActions.status === 'fail' ? 'fail' : autonomousActions.status === 'warn' ? 'warn' : autonomousActions.status === 'ready' ? 'ready' : 'idle',
      value: autonomousActions.actionCount > 0
        ? `${Number(autonomousActions.dailyTarget?.safeCount || 0)}/${Number(autonomousActions.dailyTarget?.target || 0)} safe today`
        : 'No actions yet',
      detail: autonomousActions.highestRiskAction
        ? [
            `${autonomousActions.highestRiskAction.capabilityFit} fit`,
            `job ${autonomousActions.highestRiskAction.difficultyLevel}/5 vs model ${autonomousActions.highestRiskAction.modelLevel}/5`,
            autonomousActions.highestRiskAction.task || autonomousActions.highestRiskAction.label,
          ].filter(Boolean).join(' | ')
        : autonomousActions.summary,
    },
    {
      id: 'training',
      label: 'Training',
      state: training.state || 'idle',
      value: training.exists ? `${Number(training.exampleCount || 0)} examples` : 'Not exported',
      detail: [
        training.exists
          ? (Number(training.pendingRunsCount || 0) > 0
              ? `${Number(training.pendingRunsCount || 0)} new run(s) since export`
              : (training.stale ? 'Export is stale' : 'Dataset current'))
          : 'Run training export to build a curated dataset',
        training.localExport?.ready ? `Local export ${training.localExport.format || 'ready'}${training.localExport.baseModel ? ` • ${training.localExport.baseModel}` : ''}` : '',
        training.generatedAt ? `updated ${training.generatedAt}` : '',
        training.outputPath || '',
      ].filter(Boolean).join(' • '),
    },
    {
      id: 'learning-record',
      label: 'Learning Record',
      state: learningRecord.exists ? 'ready' : 'idle',
      value: learningRecord.exists ? `${Number(learningRecord.count || 0)} captured` : 'Not captured',
      detail: learningRecord.exists
        ? [learningRecord.summary, learningRecord.generatedAt ? `updated ${learningRecord.generatedAt}` : '', learningRecord.outputPath || ''].filter(Boolean).join(' • ')
        : 'Capture supervised learning records before promoting training handoff data.',
    },
    {
      id: 'training-handoff',
      label: 'Training Handoff',
      state: trainingHandoffArtifact.exists ? 'ready' : 'idle',
      value: trainingHandoffArtifact.exists ? (Number(trainingHandoffArtifact.selectedRunCount || 0) > 0 ? `${Number(trainingHandoffArtifact.selectedRunCount || 0)} selected` : 'Ready') : 'Not prepared',
      detail: trainingHandoffArtifact.exists
        ? [trainingHandoffArtifact.summary, trainingHandoffArtifact.generatedAt ? `updated ${trainingHandoffArtifact.generatedAt}` : '', trainingHandoffArtifact.outputPath || ''].filter(Boolean).join(' • ')
        : 'Prepare a training handoff after capturing a supervised learning record.',
    },
    {
      id: 'approved-docs',
      label: 'Approved Docs',
      state: approvedDocsVault.state || (approvedDocReference.exists ? 'ready' : 'idle'),
      value: approvedDocsVault.exists
        ? `${Number(approvedDocsVault.count || 0)} saved • ${String(approvedDocsVault.freshnessLabel || 'ready')}`
        : 'Not consulted',
      detail: approvedDocsVault.exists
        ? [approvedDocsVault.summary, approvedDocsVault.latest?.outputPath || approvedDocReference.outputPath || ''].filter(Boolean).join(' • ')
        : `Allowlist: ${APPROVED_DOCUMENTATION_SOURCES.slice(0, 4).map((item) => item.domain).join(', ')}…`,
    },
    {
      id: 'layout-diagnostics',
      label: 'Layout Debug',
      state: layoutDiagnosticsArtifact.exists ? (Number(layoutDiagnosticsArtifact.issueCount || 0) > 0 ? 'warn' : 'ready') : 'idle',
      value: layoutDiagnosticsArtifact.exists ? `${Number(layoutDiagnosticsArtifact.issueCount || 0)} issue${Number(layoutDiagnosticsArtifact.issueCount || 0) === 1 ? '' : 's'}` : 'Not scanned',
      detail: layoutDiagnosticsArtifact.exists
        ? [layoutDiagnosticsArtifact.summary, layoutDiagnosticsArtifact.viewId || '', layoutDiagnosticsArtifact.outputPath || ''].filter(Boolean).join(' • ')
        : 'Capture layout diagnostics to track overlap, overflow, and spacing issues.',
    },
    {
      id: 'git',
      label: 'Workspace',
      state: changedFiles.length === 0 ? 'ready' : 'warn',
      value: changedFiles.length === 0 ? 'Clean' : `${changedFiles.length} changed`,
      detail: changedFiles.length === 0 ? 'Git working tree clean' : changedFiles.slice(0, 2).join(' • '),
    },
    {
      id: 'local-ai',
      label: localAi.label,
      state: localAi.state,
      value: localAi.state === 'ready' ? 'Connected' : 'Attention',
      detail: localAi.detail,
    },
    {
      id: 'preflight',
      label: 'Preflight',
      state: preflightBlocking > 0 ? 'fail' : 'ready',
      value: preflightBlocking > 0 ? `${preflightBlocking} blocking` : 'Clear',
      detail: preflight?.ready ? 'Environment ready' : 'Run preflight for full detail',
    },
    {
      id: 'updates',
      label: 'Updates',
      state: String(updates?.workspace?.state || updates?.state || 'idle').toLowerCase(),
      value: updates?.workspace?.hasUpdates || updates?.hasUpdates ? 'Pending' : 'Current',
      detail: updates?.workspace?.message || updates?.message || 'Update standby',
    },
  ];

  return {
    scheduler,
    baseline,
    storage,
    safeMode,
    approvals,
    approvalQueue: queue,
    assistantDashboard,
    training,
    learningRecord,
    approvedDocReference,
    approvedDocsVault,
    trainingHandoffArtifact,
    layoutDiagnosticsArtifact,
    approvedDocumentationSources: APPROVED_DOCUMENTATION_SOURCES,
    runtimeContext,
    worktree,
    currentRunDetail,
    autonomousActions,
    healthCards,
    workers: buildWorkerStates({ latestRuntime, runtimeRuns: context.runtimeRuns, scheduler, approvals, changedFileCount: changedFiles.length, baseline, training }),
    summaryText: `runtime ${activeRuns > 0 ? 'busy' : 'idle'} • ${worktree.scopeLabel || 'workspace'} ${worktree.displayName || workspaceRoot || ''} • safety ${safeMode.active ? 'safe-mode' : safeMode.watchOnly ? 'watch' : 'ready'} • baseline ${baseline.state || 'green'} • scheduler ${scheduler.running ? 'on' : 'off'} • training ${training.exists ? (training.stale || Number(training.pendingRunsCount || 0) > 0 ? 'due' : 'ready') : 'idle'} • approvals ${approvals.total}${approvals.runtimeGenerated > 0 ? ` (${approvals.runtimeGenerated} runtime)` : ''} • changed files ${changedFiles.length}`,
    workspaceRoot,
  };
}

function managerStatusText(workspaceRoot) {
  const snapshot = workspaceSnapshot();
  const manager = snapshot.manager || buildManagerSnapshot(workspaceRoot, {
    latestRuntime: runtime.getStatus().latest?.[0] || null,
    runtimeRuns: runtime.getStatus().latest || [],
    recentRuns: snapshot.recentRuns,
    changedFiles: snapshot.changedFiles,
    review: snapshot.review,
    preflight: snapshot.preflight,
    updates: snapshot.updates,
  });
  const nextApproval = Array.isArray(manager.approvalQueue) ? manager.approvalQueue[0] : null;
  const autonomyText = String(manager.autonomousActions?.recommendedNextSafeAction || '').trim();
  const dailyQuotaProof = snapshot.systemCheck?.areas?.roadmap?.dailyQuotaProof || {};
  const nextText = nextApproval
    ? ` Next approval: ${nextApproval.ticket ? `BAT<${nextApproval.ticket}> • ` : ''}${nextApproval.path}:${nextApproval.line} (${nextApproval.source})${nextApproval.nextAction ? ` • ${nextApproval.nextAction}` : ''}.`
    : '';
  const nextAutonomy = autonomyText ? ` Next safe action: ${autonomyText}.` : '';
  const focusText = dailyQuotaProof?.focusTask?.title
    ? ` Focus task: ${dailyQuotaProof.focusTask.title}.`
    : '';
  const doNotWidenText = dailyQuotaProof?.doNotWidenYetBecause
    ? ` ${dailyQuotaProof.doNotWidenYetBecause}`
    : '';
  return `Manager health: ${manager.summaryText}.${nextText}${nextAutonomy}${focusText}${doNotWidenText}`.trim();
}

function applyApprovalDecision(status, note = '', target = {}) {
  const snapshot = workspaceSnapshot();
  const queue = snapshot.manager?.approvalQueue || [];
  const matchedTarget = findApprovalItem(queue, target) || resolveApprovalQueueTarget(queue);
  const targetPath = matchedTarget?.path || lastReviewPath || '';
  const targetApprovalKey = matchedTarget?.approvalKey || '';
  if (!targetPath) {
    return { ok: false, message: 'No approval candidate is selected.' };
  }
  const result = setReviewDecision(targetPath, status, note, targetApprovalKey);
  if (!result.ok) {
    return result;
  }
  rememberReviewSelection({
    path: targetPath,
    approvalKey: result.approvalKey || targetApprovalKey,
    line: Number(matchedTarget?.line || 1),
    kind: 'files',
    source: String(matchedTarget?.source || ''),
    ticket: String(matchedTarget?.ticket || ''),
    detail: String(matchedTarget?.detail || ''),
  });
  learningJournal.recordEvent('approval-decision', {
    workspaceRoot: getWorkspaceRoot(),
    targetWorkspaceRoot: getTargetWorkspaceRoot(),
    labRoot: getSelectedLabRoot(),
    path: targetPath,
    status,
    note,
    approvalKey: result.approvalKey || targetApprovalKey,
    source: matchedTarget?.source || '',
    trusted: status === 'approved',
  });
  return {
    ok: true,
    message: `${status} ${targetPath}`,
    decision: result.decision,
    path: targetPath,
    approvalKey: result.approvalKey || targetApprovalKey,
  };
}

function setReviewDecision(relativePath, status, note = '', approvalKey = '') {
  const normalizedPath = normalizeReviewPath(relativePath);
  if (!normalizedPath) {
    return { ok: false, message: 'Path is required.' };
  }
  const result = applyDecision(getReviewDecisions(), { path: normalizedPath, approvalKey }, status, note);
  store.set('reviewDecisions', result.decisions);
  return { ok: true, path: normalizedPath, approvalKey: result.key, decision: result.decision };
}

async function openInVsCode(workspaceRoot, relativePath, line = 1) {
  const fullPath = sanitizeRelativePath(workspaceRoot, relativePath);
  if (!fullPath || !fs.existsSync(fullPath)) {
    return { ok: false, message: 'File not found.' };
  }
  rememberDesktopFile(toWorkspaceRelative(workspaceRoot, fullPath), line || 1);

  if (process.platform === 'darwin') {
    const target = line ? `${fullPath}:${Number(line || 1)}` : fullPath;
    try {
      childProcess.execFileSync('open', ['-a', 'Visual Studio Code', target], {
        stdio: 'ignore',
      });
      return { ok: true, path: fullPath, line: Number(line || 1), message: 'opened in VS Code' };
    } catch (_err) {
      // fall through to default opener
    }
  }

  const opened = await shell.openPath(fullPath);
  return {
    ok: opened === '',
    message: opened || 'opened',
    path: fullPath,
    line: Number(line || 1),
  };
}

function buildDesktopEditorContext(workspaceRoot) {
  const activeFilePath = desktopEditorState.activeFilePath || '';
  const latest = runtime.getStatus().latest?.[0] || null;
  return {
    active_file_path: activeFilePath,
    selection_start_line: activeFilePath ? desktopEditorState.activeLine : null,
    selection_end_line: activeFilePath ? desktopEditorState.activeLine : null,
    surrounding_snippet: activeFilePath ? buildSurroundingSnippet(workspaceRoot, activeFilePath, desktopEditorState.activeLine) : '',
    diagnostics: buildDesktopDiagnostics(latest, activeFilePath),
    open_files: desktopEditorState.recentFiles.slice(0, 8),
    current_file_diff: activeFilePath ? buildCurrentFileDiff(workspaceRoot, activeFilePath) : '',
  };
}

function compactEditorContextText(editorContext) {
  if (!editorContext || typeof editorContext !== 'object') {
    return '';
  }
  const lines = [];
  if (editorContext.active_file_path) {
    lines.push(`Active file: ${editorContext.active_file_path}`);
  }
  if (editorContext.selection_start_line) {
    lines.push(`Focus line: ${editorContext.selection_start_line}`);
  }
  if (Array.isArray(editorContext.diagnostics) && editorContext.diagnostics.length > 0) {
    lines.push(`Diagnostics: ${editorContext.diagnostics.map((item) => item.message).join(' | ')}`);
  }
  if (editorContext.surrounding_snippet) {
    lines.push(`Nearby code:\n${editorContext.surrounding_snippet}`);
  }
  return clipText(lines.join('\n'), 1200);
}

function sanitizeAttachmentFileName(fileName) {
  const extension = path.extname(String(fileName || '')).toLowerCase();
  const stem = path.basename(String(fileName || ''), extension)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${stem || 'attachment'}${extension || ''}`;
}

function inferAttachmentKind(filePath) {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff'].includes(extension)) {
    return 'image';
  }
  return 'file';
}

function detectAttachmentMimeType(filePath) {
  const extension = path.extname(String(filePath || '')).toLowerCase();
  if (extension === '.png') {
    return 'image/png';
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpeg';
  }
  if (extension === '.gif') {
    return 'image/gif';
  }
  if (extension === '.webp') {
    return 'image/webp';
  }
  if (extension === '.bmp') {
    return 'image/bmp';
  }
  if (extension === '.tiff') {
    return 'image/tiff';
  }
  return 'application/octet-stream';
}

function resolveChatAttachmentsRoot(workspaceRoot, threadId = '') {
  const root = getConfiguredAssistantChatAttachmentsRoot(workspaceRoot);
  if (!root) {
    throw new Error('assistant_chat_attachments_root is not configured. Set assistant_artifacts_root or assistant_chat_attachments_root before attaching images.');
  }
  const scopedRoot = path.join(root, threadId ? sanitizeAttachmentFileName(threadId) : 'thread');
  fs.mkdirSync(scopedRoot, { recursive: true });
  return scopedRoot;
}

function importChatAttachments(workspaceRoot, payload = {}) {
  const filePaths = Array.isArray(payload.filePaths)
    ? payload.filePaths.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const imported = [];
  const attachmentsRoot = resolveChatAttachmentsRoot(workspaceRoot, String(payload.threadId || 'thread'));
  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const kind = inferAttachmentKind(filePath);
    if (kind !== 'image') {
      continue;
    }
    const stampedName = `${Date.now()}-${sanitizeAttachmentFileName(path.basename(filePath))}`;
    const destinationPath = path.join(attachmentsRoot, stampedName);
    fs.copyFileSync(filePath, destinationPath);
    const stat = fs.statSync(destinationPath);
    const image = nativeImage.createFromPath(destinationPath);
    const size = typeof image.getSize === 'function' ? image.getSize() : { width: 0, height: 0 };
    imported.push({
      id: randomId('attachment'),
      name: path.basename(destinationPath),
      originalName: path.basename(filePath),
      kind,
      path: destinationPath,
      sourcePath: filePath,
      mimeType: detectAttachmentMimeType(destinationPath),
      sizeBytes: Number(stat.size || 0),
      width: Number(size.width || 0),
      height: Number(size.height || 0),
      importedAt: nowIso(),
    });
  }
  return {
    ok: true,
    attachmentsRoot,
    attachments: imported,
    count: imported.length,
  };
}

ipcMain.handle('assistant:chat', async (_event, payload = {}) => {
  const { workspaceRoot, targetWorkspaceRoot, labRoot } = resolveRequestRoots(payload);
  let text = String(payload.text || '').trim();
  const chatHistory = normalizeChatHistoryPayload(payload.history);
  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments.map((item) => (item && typeof item === 'object' ? item : null)).filter(Boolean)
    : [];
  const trustedDocs = buildTrustedDocReferences(targetWorkspaceRoot);
  if (!text && attachments.length === 0) {
    return { ok: true, reply: 'Please enter a message.' };
  }
  if (!text && attachments.length > 0) {
    text = 'Analyze the attached screenshot(s) and implement the next safe coding slice.';
  }
  updateLearningJournalScope({
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
    threadId: payload.threadId || '',
    changeSessionId: payload.changeSessionId || '',
  });
  const aiStatus = await buildAiStatusPayload(targetWorkspaceRoot || workspaceRoot);
  const modelProvisioning = aiStatus?.provisioning && typeof aiStatus.provisioning === 'object'
    ? aiStatus.provisioning
    : {};
  const chatGuidance = buildChatGuidancePayload(targetWorkspaceRoot, {
    ...(payload.chatContext && typeof payload.chatContext === 'object' ? payload.chatContext : {}),
    modelProvisioning,
    message: text,
  });
  const chatContext = buildAssistantChatContext(targetWorkspaceRoot, {
    ...(payload.chatContext && typeof payload.chatContext === 'object' ? payload.chatContext : {}),
    attachments,
    trustedDocs,
    chatGuidance,
    modelProvisioning,
  });
  learningJournal.recordEvent('chat-prompt', {
    text,
    threadId: payload.threadId || '',
    changeSessionId: payload.changeSessionId || '',
    attachmentCount: attachments.length,
    attachments: attachments.map((item) => ({
      id: item.id || '',
      kind: item.kind || '',
      name: item.originalName || item.name || '',
      path: item.path || '',
    })),
  });

  const explicitTicket = String(text.match(/(?:BAT<)?(\d+)>?/i)?.[1] || '').trim();
  if (!text.startsWith('/') && explicitTicket) {
    const batEntry = parseBatBoard(targetWorkspaceRoot).find((item) => String(item.ticket || '') === explicitTicket) || null;
    const explicitAction = /\bplan\b/i.test(text)
      ? 'plan'
      : /\b(implement|build|code|ship|fix)\b/i.test(text)
        ? 'implement'
        : 'run';
    const ticketSummary = String(batEntry?.summary || batEntry?.desc || '').trim();
    const titledObjective = ticketSummary
      ? `${explicitAction === 'plan' ? 'Plan' : explicitAction === 'implement' ? 'Implement' : 'Work'} BAT<${explicitTicket}>: ${ticketSummary}`
      : text;
    const bundle = createGoalAndTask(workspaceRoot, {
      source: 'chat',
      objective: titledObjective,
      title: titledObjective,
      targetWorkspaceRoot,
      labRoot,
      threadId: payload.threadId || '',
      changeSessionId: payload.changeSessionId || '',
      metadata: {
        workspaceRoot,
        targetWorkspaceRoot,
        activeView: payload.chatContext?.activeView || '',
        compatSource: 'bat-board',
        batTicket: explicitTicket,
        batStatus: batEntry?.status || '',
        batSummary: ticketSummary,
        defaultAction: explicitAction,
        attachments,
        referenceAttachments: attachments,
        trustedDocs,
        chatGuidance,
      },
    });
    const goal = bundle.goal || null;
    const task = bundle.task || null;
    learningJournal.recordEvent('goal-created', {
      goalId: goal?.id || '',
      title: goal?.title || '',
      objective: goal?.objective || '',
      source: 'chat',
    });
    learningJournal.recordEvent('task-created', {
      taskId: task?.id || '',
      goalId: task?.goalId || '',
      title: task?.title || '',
      objective: task?.objective || '',
      source: 'chat',
      batTicket: explicitTicket,
    });
    const run = task
      ? await launchUniversalTaskRun({
        workspaceRoot,
        targetWorkspaceRoot,
        labRoot,
        task,
        goal,
        changeSessionId: payload.changeSessionId || task.changeSessionId || '',
      })
      : null;
    learningJournal.recordEvent('task-run', {
      taskId: task?.id || '',
      goalId: task?.goalId || '',
      runId: run?.runId || '',
      label: run?.label || '',
      source: 'chat',
      batTicket: explicitTicket,
    });
    const blockedByModelFit = run?.blockedBy === 'model-fit';
    const createdTaskReply = run?.runId
      ? `Created an engine task for BAT<${explicitTicket}> and launched ${run.label || 'the run'} (${run.runId}).`
      : blockedByModelFit
        ? `Created an engine task for BAT<${explicitTicket}>${ticketSummary ? ` • ${ticketSummary}` : ''}, but kept it queued because ${run.blockedReason || 'the current model is undersized for that slice'}.`
        : `Created an engine task for BAT<${explicitTicket}>${ticketSummary ? ` • ${ticketSummary}` : ''}.`;
    const createdTaskSuggestions = run?.runId
      ? ['Review the latest run and summarize any blockers.', 'Open the changed files and show me the diff.']
      : blockedByModelFit
        ? ['Rescope the queued task to fit the current model.', 'Open AI settings and verify the model routing before retrying.']
        : ['Run the newest task now.', 'Open the engine backlog in settings and verify the target.'];
    return {
      ok: true,
      reply: createdTaskReply,
      intentType: run?.runId ? 'launched-run' : 'created-task',
      goal,
      task,
      run: run?.runId ? run : null,
      suggestions: createdTaskSuggestions,
      refs: [],
      targetWorkspaceRoot,
      labRoot,
    };
    return {
      ok: true,
      reply: run?.runId
        ? `Created an engine task for BAT<${explicitTicket}> and launched ${run.label || 'the run'} (${run.runId}).`
        : `Created an engine task for BAT<${explicitTicket}>${ticketSummary ? ` • ${ticketSummary}` : ''}.`,
      intentType: run?.runId ? 'launched-run' : 'created-task',
      goal,
      task,
      run: run?.runId ? run : null,
      suggestions: run?.runId
        ? ['Review the latest run and summarize any blockers.', 'Open the changed files and show me the diff.']
        : ['Run the newest task now.', 'Open the engine backlog in settings and verify the target.'],
      refs: [],
      targetWorkspaceRoot,
      labRoot,
    };
  }

  if (!text.startsWith('/') && isActionablePrompt(text)) {
    const bundle = createGoalAndTask(workspaceRoot, {
      source: payload.source || 'chat',
      objective: text,
      title: text,
      targetWorkspaceRoot,
      labRoot,
      threadId: payload.threadId || '',
      changeSessionId: payload.changeSessionId || '',
      metadata: {
        workspaceRoot,
        targetWorkspaceRoot,
        activeView: payload.chatContext?.activeView || '',
        attachments,
        referenceAttachments: attachments,
        trustedDocs,
        chatGuidance,
      },
    });
    const goal = bundle.goal || null;
    const task = bundle.task || null;
    learningJournal.recordEvent('goal-created', {
      goalId: goal?.id || '',
      title: goal?.title || '',
      objective: goal?.objective || '',
      source: 'chat',
    });
    learningJournal.recordEvent('task-created', {
      taskId: task?.id || '',
      goalId: task?.goalId || '',
      title: task?.title || '',
      objective: task?.objective || '',
      source: 'chat',
    });

    const intentType = inferIntentType(text);
    if (intentType === 'launched-run' && task) {
      const run = await launchUniversalTaskRun({
        workspaceRoot,
        targetWorkspaceRoot,
        labRoot,
        task,
        goal,
        changeSessionId: payload.changeSessionId || task.changeSessionId || '',
      });
      learningJournal.recordEvent('task-run', {
        taskId: task.id,
        goalId: task.goalId || '',
        runId: run?.runId || '',
        label: run?.label || '',
        source: 'chat',
      });
      const blockedByModelFit = run?.blockedBy === 'model-fit';
      const launchedTaskReply = run?.runId
        ? `Created goal "${goal?.title || 'Untitled goal'}", queued task "${task.title}", and launched ${run.label || 'the coding run'} (${run.runId}).`
        : blockedByModelFit
          ? `Created goal "${goal?.title || 'Untitled goal'}" and queued task "${task.title}", but kept it queued because ${run.blockedReason || 'the current model is undersized for that slice'}.`
          : `Created goal "${goal?.title || 'Untitled goal'}" and queued task "${task.title}", but the run did not start cleanly yet.`;
      const launchedTaskSuggestions = run?.runId
        ? ['Review the latest run and summarize any blockers.', 'Open the changed files and show me the diff.']
        : blockedByModelFit
          ? ['Rescope the queued task to fit the current model.', 'Open AI settings and verify the current model routing.']
          : ['Run the newest task now.', 'Open AI settings and verify the current model routing.'];
      return {
        ok: true,
        reply: launchedTaskReply,
        intentType: run?.runId ? 'launched-run' : 'blocked-by-policy',
        goal,
        task,
        run: run?.runId ? run : null,
        suggestions: launchedTaskSuggestions,
        refs: [],
        targetWorkspaceRoot,
        labRoot,
      };
      return {
        ok: true,
        reply: run?.runId
          ? `Created goal "${goal?.title || 'Untitled goal'}", queued task "${task.title}", and launched ${run.label || 'the coding run'} (${run.runId}).`
          : `Created goal "${goal?.title || 'Untitled goal'}" and queued task "${task.title}", but the run did not start cleanly yet.`,
        intentType: run?.runId ? 'launched-run' : 'blocked-by-policy',
        goal,
        task,
        run: run?.runId ? run : null,
        suggestions: run?.runId
          ? ['Review the latest run and summarize any blockers.', 'Open the changed files and show me the diff.']
          : ['Run the newest task now.', 'Open AI settings and verify the current model routing.'],
        refs: [],
        targetWorkspaceRoot,
        labRoot,
      };
    }

    return {
      ok: true,
      reply: `Created goal "${goal?.title || 'Untitled goal'}" and queued task "${task?.title || 'Untitled task'}".`,
      intentType: 'created-task',
      goal,
      task,
      run: null,
      suggestions: ['Run the newest task now.', 'Create a self-host lab and test the task there first.'],
      refs: [],
      targetWorkspaceRoot,
      labRoot,
    };
  }

  const reply = await handleAssistantChat(targetWorkspaceRoot, text, {
    chatHistory,
    chatContext: {
      ...chatContext,
      attachments: attachments.map((item) => ({
        kind: item.kind || '',
        name: item.originalName || item.name || '',
        path: item.path || '',
        width: item.width || 0,
        height: item.height || 0,
      })),
      trustedDocs,
      chatGuidance,
    },
    runBatchRun: async () => {
      const res = await handleAgentRun('sprint', {
        workspaceRoot,
        workspace: targetWorkspaceRoot,
        targetWorkspaceRoot,
        labRoot,
        changeSessionId: payload.changeSessionId || '',
        sprintAction: 'run',
        count: 5,
        status: 'TODO',
        profile: 'aiWrite',
        template: 'auto',
        fixLoop: true,
      });
      lastRunTicket = null; // unknown
      lastRunPassed = res && res.ok;
      return res;
    },
    runBatchImplement: async () => {
      const res = await handleAgentRun('sprint', {
        workspaceRoot,
        workspace: targetWorkspaceRoot,
        targetWorkspaceRoot,
        labRoot,
        changeSessionId: payload.changeSessionId || '',
        sprintAction: 'implement',
        count: 3,
        status: 'TODO',
        requireTag: 'BE',
        profile: 'aiWrite',
        template: 'auto',
        fixLoop: true,
        ship: false,
      });
      lastRunTicket = null;
      lastRunPassed = res && res.ok;
      return res;
    },
    planTicket: async ({ ticket }) => {
      const res = await handleAgentRun('plan', {
        workspaceRoot,
        workspace: targetWorkspaceRoot,
        targetWorkspaceRoot,
        labRoot,
        changeSessionId: payload.changeSessionId || '',
        ticket,
        profile: 'preview',
        template: 'auto',
      });
      lastPlannedTicket = ticket;
      return res;
    },
    runTicket: async ({ ticket, implement }) => {
      const res = await handleAgentRun(implement ? 'implement' : 'run', {
        workspaceRoot,
        workspace: targetWorkspaceRoot,
        targetWorkspaceRoot,
        labRoot,
        changeSessionId: payload.changeSessionId || '',
        ticket,
        profile: implement ? 'aiWrite' : 'preview',
        template: 'auto',
        fixLoop: !!implement,
      });
      lastRunTicket = ticket;
      lastRunPassed = res && res.ok;
      if (!implement && !(res && res.ok)) {
        lastFailedTicket = ticket;
      }
      return res;
    },
    implementPlanned: async () => {
      if (!lastPlannedTicket) {
        return 'No planned BAT available yet.';
      }
      const res = await handleAgentRun('implement', {
        workspaceRoot,
        workspace: targetWorkspaceRoot,
        targetWorkspaceRoot,
        labRoot,
        changeSessionId: payload.changeSessionId || '',
        ticket: lastPlannedTicket,
        profile: 'aiWrite',
        template: 'auto',
        fixLoop: true,
      });
      lastRunTicket = lastPlannedTicket;
      lastRunPassed = res && res.ok;
      return res?.runId ? `Started implement for planned BAT<${lastPlannedTicket}> (${res.runId}).` : `Started implement for planned BAT<${lastPlannedTicket}>.`;
    },
    next: async () => {
      const todo = nextActionableTodoBat(targetWorkspaceRoot);
      return todo ? `Next TODO: BAT<${todo.ticket}>` : 'No TODO tasks found.';
    },
    repair: async () => {
      const result = runRepairLoop({
        workspaceRoot,
        workspace: targetWorkspaceRoot,
        targetWorkspaceRoot,
        labRoot,
        changeSessionId: payload.changeSessionId || '',
        ticket: lastFailedTicket || '',
      });
      if (result?.ok && result.ticket) {
        lastFailedTicket = result.ticket;
        if (result.action === 'plan') {
          lastPlannedTicket = result.ticket;
        } else {
          lastRunTicket = result.ticket;
          lastRunPassed = false;
        }
      }
      return result?.message || 'No failed run to repair.';
    },
    files: async () => {
      if (!targetWorkspaceRoot) {
        return 'No workspace open.';
      }
      try {
        const out = childProcess.execSync('git status --short', {
          cwd: targetWorkspaceRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.trim() ? `Changed files:\n${out}` : 'Repository clean.';
      } catch (err) {
        return `Unable to get git status: ${err.message}`;
      }
    },
    auditToggle: async () => {
      auditEnforced = !auditEnforced;
      return `Audit enforcement is now ${auditEnforced ? 'ON' : 'OFF'}.`;
    },
    getSummary: async () => summarizeBats(parseBatBoard(targetWorkspaceRoot)),
    getStatus: async () => runtime.getStatus(),
    getManagerStatus: async () => managerStatusText(targetWorkspaceRoot),
    getApprovalQueue: async () => workspaceSnapshot().manager?.approvalQueue || [],
    getWorkerStatus: async () => {
      const workers = workspaceSnapshot().manager?.workers || [];
      return workers.map((item) => `${item.role}: ${item.status} (${item.currentTask})`).join('\n');
    },
    approveSelection: async (_workspaceRoot, target = {}) => applyApprovalDecision('approved', '', target).message,
    rejectSelection: async (_workspaceRoot, target = {}) => applyApprovalDecision('rejected', '', target).message,
    deferSelection: async (_workspaceRoot, target = {}) => applyApprovalDecision('deferred', '', target).message,
    cancelRun: async (runId) => runtime.cancel(runId),
    stop: async () => {
      const active = runtime.getStatus();
      if (Array.isArray(active.activeRuns) && active.activeRuns.length > 0) {
        const result = runtime.cancelLatest();
        return result.ok ? 'Stop signal sent to the latest active run.' : (result.message || 'Unable to stop the active run.');
      }
      const scheduler = schedulerStatusPayload();
      if (scheduler.running) {
        return stopAutopilotScheduler().message;
      }
      return 'No active run or scheduler to stop.';
    },
    hasAiKey: async () => {
      const { runtimeMode, remoteApiKeyName } = getChatBackendConfig(targetWorkspaceRoot);
      if (runtimeMode !== 'openai') {
        return true;
      }
      if (process.env[remoteApiKeyName]) {
        return true;
      }
      const secret = await getSecret(remoteApiKeyName);
      return !!(secret.ok && secret.value);
    },
    runAi: async (_root, prompt) => {
      const { runtimeMode, localCmd, ollamaModel, remoteBaseUrl, remoteModel, remoteApiKeyName } = getChatBackendConfig(targetWorkspaceRoot);
      const secret = await getSecret(remoteApiKeyName);
      const env = {};
      const hasSecret = !!(secret.ok && secret.value);

      if (runtimeMode === 'openai') {
        if (hasSecret) {
          env.AGENT_PROVIDER = 'openai';
          env.OPENAI_API_KEY = secret.value;
          env.OPENAI_MODEL = remoteModel;
          if (remoteBaseUrl) {
            env.OPENAI_BASE_URL = remoteBaseUrl;
          }
        }
      } else if ((runtimeMode === 'local' || runtimeMode === 'hybrid') && localCmd) {
        env.AGENT_PROVIDER = 'local';
        env.LOCAL_AI_CMD = localCmd;
        env.OPENAI_API_KEY = '';
      } else if (runtimeMode === 'hybrid' && hasSecret && !canManageOllama()) {
        env.AGENT_PROVIDER = 'openai';
        env.OPENAI_API_KEY = secret.value;
        env.OPENAI_MODEL = remoteModel;
        if (remoteBaseUrl) {
          env.OPENAI_BASE_URL = remoteBaseUrl;
        }
      } else {
        env.AGENT_PROVIDER = 'ollama';
        env.OLLAMA_MODEL = ollamaModel;
        if (hasSecret && runtimeMode === 'hybrid') {
          env.OPENAI_API_KEY = secret.value;
          env.OPENAI_MODEL = remoteModel;
          if (remoteBaseUrl) {
            env.OPENAI_BASE_URL = remoteBaseUrl;
          }
        }
      }
      return runAssistantCli(targetWorkspaceRoot, ['--ai', '--prompt', prompt], env);
    },
    getBinaryUpdateStatus: async () => initializeBinaryUpdater(),
    checkBinaryUpdate: async () => checkBinaryForUpdates(),
    downloadBinaryUpdate: async () => downloadBinaryUpdateNow(),
    installBinaryUpdate: async () => installBinaryUpdateNow(),
    runAutopilot: async () => {
      const run = await handleAgentRun('autopilot', { workspaceRoot, workspace: targetWorkspaceRoot, targetWorkspaceRoot, labRoot, changeSessionId: payload.changeSessionId || '' });
      return run?.runId ? `Started autopilot run (${run.runId}).` : 'Unable to start autopilot run.';
    },
    runSelfImprove: async () => {
      const run = await runTunedAction('self-improve', { workspaceRoot, workspace: targetWorkspaceRoot, targetWorkspaceRoot, labRoot, changeSessionId: payload.changeSessionId || '', selfImprove: true });
      return run?.runId ? `Started self-improve run (${run.runId}).` : 'Unable to start self-improve run.';
    },
    runTrain: async () => {
      const run = await runTunedAction('train', { workspaceRoot, workspace: targetWorkspaceRoot, targetWorkspaceRoot, labRoot, changeSessionId: payload.changeSessionId || '' });
      return run?.runId ? `Started training run (${run.runId}).` : 'Unable to start training run.';
    },
    runLearn: async () => {
      const result = await runTunedAction('learn', { workspaceRoot, workspace: targetWorkspaceRoot, targetWorkspaceRoot, labRoot, changeSessionId: payload.changeSessionId || '' });
      return result.message || 'Learn pipeline started.';
    },
    autopilotSchedulerStart: async () => {
      const result = await startAutopilotScheduler({ workspaceRoot, workspace: targetWorkspaceRoot, targetWorkspaceRoot, labRoot });
      return result?.message || 'Autopilot scheduler status unavailable.';
    },
    autopilotSchedulerStop: async () => stopAutopilotScheduler().message,
    autopilotSchedulerStatus: async () => schedulerStatusPayload().message,
    aiMissingMessage:
      'No chat backend configured. Start Ollama, set a working Local AI Command, or configure the selected remote provider key.',
    helpText:
      'Try: /plan 176, /run 176, /implement 176, /implement planned, /batch run, /batch implement, /self-improve, /autopilot, /autopilot start, /app update, /app update check, /app update install, /stop, /train, /learn, /status, /cancel <runId>.',
  });

  return {
    ok: true,
    reply,
    intentType: text.startsWith('/') ? 'command' : 'answer-only',
    goal: null,
    task: null,
    run: null,
    suggestions: buildAssistantReplySuggestions(text, reply),
    refs: buildAssistantReplyRefs(chatContext),
    targetWorkspaceRoot,
    labRoot,
  };
});

ipcMain.handle('agent:preflight', async (_event, payload = {}) => {
  const { targetWorkspaceRoot } = resolveRequestRoots(payload);
  return runPreflight(targetWorkspaceRoot, {
    requireGh: !!payload.requireGh,
  });
});

ipcMain.handle('agent:status', async (_event, payload = {}) => {
  if (payload.runId) {
    return runtime.getStatus(payload.runId);
  }
  return runtime.getStatus();
});

ipcMain.handle('agent:cancel', async (_event, payload = {}) => runtime.cancel(payload.runId));

ipcMain.handle('agent:plan', async (_event, payload = {}) => handleAgentRun('plan', payload));
ipcMain.handle('agent:run', async (_event, payload = {}) => handleAgentRun('run', payload));
ipcMain.handle('agent:implement', async (_event, payload = {}) => handleAgentRun('implement', payload));
ipcMain.handle('agent:taskLoop:execute', async (_event, payload = {}) => executeTaskLoop(payload));
ipcMain.handle('agent:taskLoop:retry', async (_event, payload = {}) => retryTaskLoop(payload));
ipcMain.handle('agent:taskLoop:repair', async (_event, payload = {}) => repairTaskLoop(payload));
ipcMain.handle('agent:taskLoop:latest', async (_event, payload = {}) => {
  const roots = resolveRequestRoots(payload);
  return {
    ok: true,
    operatorLoop: buildTaskLoopSnapshot(roots.workspaceRoot || getWorkspaceRoot()),
  };
});
ipcMain.handle('agent:sprint', async (_event, payload = {}) => handleAgentRun('sprint', payload));
ipcMain.handle('agent:autopilot', async (_event, payload = {}) => handleAgentRun('autopilot', payload));
ipcMain.handle('agent:selfImprove', async (_event, payload = {}) => runTunedAction('self-improve', payload));
ipcMain.handle('agent:train', async (_event, payload = {}) => runTunedAction('train', payload));
ipcMain.handle('agent:learn', async (_event, payload = {}) => runTunedAction('learn', payload));
ipcMain.handle('agent:repair', async (_event, payload = {}) => runRepairLoop(payload));
ipcMain.handle('agent:autopilotSchedulerStart', async (_event, payload = {}) => startAutopilotScheduler(payload));
ipcMain.handle('agent:autopilotSchedulerStop', async () => stopAutopilotScheduler());
ipcMain.handle('agent:autopilotSchedulerStatus', async () => schedulerStatusPayload());
ipcMain.handle('agent:getEditorContext', async (_event, payload = {}) => {
  const { targetWorkspaceRoot } = resolveRequestRoots(payload);
  return { ok: true, editorContext: buildDesktopEditorContext(targetWorkspaceRoot) };
});
ipcMain.handle('tuning:getStatus', async (_event, payload = {}) => getTrainingTuningStatus(payload));
ipcMain.handle('tuning:startOllama', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspace || payload.workspaceRoot || getWorkspaceRoot() || APP_ROOT;
  return startOllamaService(readTrainingTuningSettings(workspaceRoot));
});
ipcMain.handle('tuning:stopOllama', async () => stopOllamaService());
ipcMain.handle('tuning:importModels', async (_event, payload = {}) => importStoredTrainingModels(payload));
ipcMain.handle('learning:capture', async (_event, payload = {}) => {
  const { workspaceRoot, targetWorkspaceRoot, labRoot } = resolveRequestRoots(payload);
  updateLearningJournalScope(payload);
  const snapshot = workspaceSnapshot();
  const result = captureDesktopLearningRecord(targetWorkspaceRoot, snapshot, {
    summary: payload.summary,
    operatorIntent: payload.operatorIntent || 'supervised desktop self-improvement',
    focusArea: payload.focusArea || 'desktop-ui-self-improvement',
    learnedSignals: Array.isArray(payload.learnedSignals) ? payload.learnedSignals : [],
    approvedSources: Array.isArray(payload.approvedSources) ? payload.approvedSources : [],
    patchOutcome: payload.patchOutcome && typeof payload.patchOutcome === 'object' ? payload.patchOutcome : {},
    reviewQuality: payload.reviewQuality && typeof payload.reviewQuality === 'object' ? payload.reviewQuality : {},
    validationCommands: Array.isArray(payload.validationCommands) ? payload.validationCommands : [],
    validationDepth: payload.validationDepth && typeof payload.validationDepth === 'object' ? payload.validationDepth : {},
    uiContext: payload.uiContext && typeof payload.uiContext === 'object' ? payload.uiContext : {},
    operatorCorrections: Array.isArray(payload.operatorCorrections) ? payload.operatorCorrections : [],
    operatorSupervision: payload.operatorSupervision && typeof payload.operatorSupervision === 'object' ? payload.operatorSupervision : {},
    experimentLinks: payload.experimentLinks && typeof payload.experimentLinks === 'object' ? payload.experimentLinks : {},
    trainingReadiness: payload.trainingReadiness && typeof payload.trainingReadiness === 'object' ? payload.trainingReadiness : {},
    notes: Array.isArray(payload.notes) ? payload.notes : [],
  });
  learningJournal.recordEvent('learning-capture', {
    outputPath: result.outputPath || '',
    focusArea: payload.focusArea || 'desktop-ui-self-improvement',
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
  });
  return result;
});
ipcMain.handle('learning:fetchApprovedDoc', async (_event, payload = {}) => {
  const { targetWorkspaceRoot } = resolveRequestRoots(payload);
  return fetchApprovedDocumentationSource(targetWorkspaceRoot, payload);
});
ipcMain.handle('learning:trainingHandoff', async (_event, payload = {}) => {
  const { targetWorkspaceRoot } = resolveRequestRoots(payload);
  return prepareDesktopTrainingHandoff(targetWorkspaceRoot, payload);
});
ipcMain.handle('learning:localTrainingExport', async (_event, payload = {}) => {
  const { targetWorkspaceRoot } = resolveRequestRoots(payload);
  return exportDesktopLocalTrainingBundle(targetWorkspaceRoot, payload);
});
ipcMain.handle('layout:saveDiagnostics', async (_event, payload = {}) => {
  const { targetWorkspaceRoot } = resolveRequestRoots(payload);
  return captureLayoutDiagnosticsArtifact(targetWorkspaceRoot, payload);
});
ipcMain.handle('artifacts:openPath', async (_event, payload = {}) => {
  const { targetWorkspaceRoot } = resolveRequestRoots(payload);
  const fullPath = resolveDesktopArtifactPath(targetWorkspaceRoot, payload.path);
  if (!fullPath) {
    return { ok: false, message: 'Artifact path is unavailable or outside allowed assistant artifact roots.' };
  }
  const opened = await shell.openPath(fullPath);
  return {
    ok: opened === '',
    message: opened || 'opened',
    path: fullPath,
  };
});
ipcMain.handle('artifacts:readPreview', async (_event, payload = {}) => {
  const { targetWorkspaceRoot } = resolveRequestRoots(payload);
  return readDesktopArtifactPreview(targetWorkspaceRoot, payload.path, { maxChars: payload.maxChars || 12000 });
});
ipcMain.handle('agent:setEditorContextFocus', async (_event, payload = {}) => {
  const { targetWorkspaceRoot } = resolveRequestRoots(payload);
  let relativePath = String(payload.path || '').trim();
  if (relativePath && path.isAbsolute(relativePath)) {
    relativePath = toWorkspaceRelative(targetWorkspaceRoot, relativePath);
  }
  rememberDesktopFile(relativePath, payload.line || 1);
  return { ok: true, editorContext: buildDesktopEditorContext(targetWorkspaceRoot) };
});
ipcMain.handle('agent:openLocation', async (_event, payload = {}) => {
  const { targetWorkspaceRoot } = resolveRequestRoots(payload);
  const fullPath = sanitizeRelativePath(targetWorkspaceRoot, payload.path);
  if (!fullPath || !fs.existsSync(fullPath)) {
    return { ok: false, message: 'File not found.' };
  }
  rememberDesktopFile(toWorkspaceRelative(targetWorkspaceRoot, fullPath), payload.line || 1);
  const opened = await shell.openPath(fullPath);
  return {
    ok: opened === '',
    message: opened || 'opened',
    path: fullPath,
    line: Number(payload.line || 1),
  };
});

ipcMain.handle('review:getSnapshot', async () => {
  const snapshot = workspaceSnapshot();
  return { ok: true, review: snapshot.review, editorContext: snapshot.editorContext };
});

ipcMain.handle('review:rememberSelection', async (_event, payload = {}) => ({
  ok: true,
  selection: rememberReviewSelection(payload),
}));

ipcMain.handle('review:readFile', async (_event, payload = {}) => {
  const { targetWorkspaceRoot } = resolveRequestRoots(payload);
  const result = readWorkspaceFile(targetWorkspaceRoot, payload.path, { maxChars: 50000 });
  if (result.ok) {
    rememberReviewSelection({
      path: result.path,
      approvalKey: payload.approvalKey || '',
      line: payload.line || 1,
      kind: payload.kind || 'files',
      source: payload.source || '',
      ticket: payload.ticket || '',
      detail: payload.detail || '',
    });
    rememberDesktopFile(result.path, payload.line || 1);
  }
  return result;
});

ipcMain.handle('review:getDiff', async (_event, payload = {}) => {
  const { targetWorkspaceRoot } = resolveRequestRoots(payload);
  const result = getWorkspaceDiff(targetWorkspaceRoot, payload.path, { maxChars: 50000 });
  return {
    ...result,
    summary: summarizeUnifiedDiff(result.diff || ''),
  };
});

ipcMain.handle('review:saveFile', async (_event, payload = {}) => {
  const { workspaceRoot, targetWorkspaceRoot, labRoot } = resolveRequestRoots(payload);
  const normalizedPath = normalizeReviewPath(payload.path);
  const selection = getReviewSelectionState();
  const currentDecision = resolveSaveApproval(getReviewDecisions(), {
    path: normalizedPath,
    approvalKey: payload.approvalKey || selection.approvalKey || '',
  });
  if (!payload.force && currentDecision.decision.status !== 'approved') {
    return {
      ok: false,
      path: normalizedPath,
      message: 'Approve this file in Review before executing edits.',
    };
  }
  const result = saveWorkspaceFile(targetWorkspaceRoot, payload.path, payload.content);
  if (!result.ok) {
    return result;
  }
  rememberDesktopFile(result.path, payload.line || 1);
  const diffPayload = getWorkspaceDiff(targetWorkspaceRoot, result.path, { maxChars: 50000 });
  learningJournal.recordEvent('manual-edit', {
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
    path: result.path,
    line: Number(payload.line || 1),
    diffSummary: summarizeUnifiedDiff(diffPayload.diff || ''),
    accepted: true,
  });
  return {
    ...result,
    diff: diffPayload.diff,
    summary: summarizeUnifiedDiff(diffPayload.diff || ''),
  };
});

ipcMain.handle('review:setDecision', async (_event, payload = {}) => {
  const { workspaceRoot, targetWorkspaceRoot, labRoot } = resolveRequestRoots(payload);
  const result = setReviewDecision(payload.path, payload.status, payload.note || '', payload.approvalKey || '');
  if (!result.ok) {
    return result;
  }
  rememberReviewSelection({
    path: result.path,
    approvalKey: result.approvalKey || payload.approvalKey || '',
    line: payload.line || getReviewSelectionState().line || 1,
    kind: payload.kind || getReviewSelectionState().kind || 'files',
    source: payload.source || getReviewSelectionState().source || '',
    ticket: payload.ticket || getReviewSelectionState().ticket || '',
    detail: payload.detail || getReviewSelectionState().detail || '',
  });
  learningJournal.recordEvent('approval-decision', {
    workspaceRoot,
    targetWorkspaceRoot,
    labRoot,
    path: result.path,
    status: payload.status,
    note: payload.note || '',
    approvalKey: result.approvalKey || '',
    trusted: String(payload.status || '').trim().toLowerCase() === 'approved',
  });
  const snapshot = workspaceSnapshot();
  return {
    ok: true,
    decision: result.decision,
    approvalKey: result.approvalKey || '',
    review: snapshot.review,
  };
});

ipcMain.handle('review:copyText', async (_event, payload = {}) => {
  clipboard.writeText(String(payload.text || ''));
  return { ok: true };
});

ipcMain.handle('review:openInVsCode', async (_event, payload = {}) => {
  const { targetWorkspaceRoot } = resolveRequestRoots(payload);
  return openInVsCode(targetWorkspaceRoot, payload.path, payload.line || 1);
});

ipcMain.handle('skills:list', async () => {
  const workspaceRoot = getWorkspaceRoot();
  return listSkills(workspaceRoot);
});

ipcMain.handle('skills:run', async (_event, payload = {}) => {
  const workspaceRoot = getWorkspaceRoot();
  const result = runSkill(workspaceRoot, payload);
  if (result.ok && payload.open !== false && result.skill?.path) {
    await shell.openPath(result.skill.path);
  }
  return result;
});

ipcMain.handle('automations:list', async () => {
  const workspaceRoot = getWorkspaceRoot();
  return listAutomations(workspaceRoot);
});

ipcMain.handle('automations:getSettings', async () => {
  const workspaceRoot = getWorkspaceRoot();
  return getAutopilotSettings(workspaceRoot);
});

ipcMain.handle('automations:saveSettings', async (_event, payload = {}) => {
  const workspaceRoot = getWorkspaceRoot();
  return saveAutopilotSettings(workspaceRoot, payload);
});

ipcMain.handle('automations:upsert', async (_event, payload = {}) => {
  const workspaceRoot = getWorkspaceRoot();
  return upsertAutomation(workspaceRoot, payload);
});

ipcMain.handle('automations:toggle', async (_event, payload = {}) => {
  const workspaceRoot = getWorkspaceRoot();
  return toggleAutomation(workspaceRoot, payload);
});

ipcMain.handle('automations:remove', async (_event, payload = {}) => {
  const workspaceRoot = getWorkspaceRoot();
  return removeAutomation(workspaceRoot, payload);
});

ipcMain.handle('automations:runNow', async (_event, payload = {}) => {
  const workspaceRoot = getWorkspaceRoot();
  const jobs = listAutomations(workspaceRoot);
  const target = jobs.find((job) => job.name.toLowerCase() === String(payload.name || '').toLowerCase());
  if (!target) {
    return { ok: false, message: 'Automation not found.' };
  }
  if (target.enabled === false && !payload.force) {
    return { ok: false, message: 'Automation is disabled.' };
  }
  return runtime.run({
    action: 'autopilot',
    workspace: workspaceRoot,
    schedule: target.cron,
  });
});

ipcMain.handle('updates:check', async () => runAutoUpdateCycle({ trigger: 'manual-check', allowApply: false }));
ipcMain.handle('updates:plan', async () => {
  const payload = buildUpdatePlan(getWorkspaceRoot());
  updateStatusSnapshot({
    state: payload.hasUpdates ? 'available' : 'ready',
    message: payload.summary || payload.reason || 'Update plan ready.',
    trigger: 'manual-plan',
    hasUpdates: !!payload.hasUpdates,
    details: payload,
  });
  return payload;
});
ipcMain.handle('updates:apply', async (_event, payload = {}) => {
  const result = applyUpdate(getWorkspaceRoot(), {
    confirm: !!payload.confirm,
    backupTargets: payload.backupTargets,
  });
  updateStatusSnapshot({
    state: result.ok ? (result.updated ? 'updated' : 'ready') : 'failed',
    message: result.ok ? (result.message || 'Update applied.') : (result.error || 'Update failed.'),
    trigger: 'manual-apply',
    hasUpdates: false,
    details: result,
  });
  return result;
});
ipcMain.handle('updates:rollback', async (_event, payload = {}) => {
  const result = rollbackUpdate(getWorkspaceRoot(), {
    backupId: payload.backupId,
  });
  updateStatusSnapshot({
    state: result.ok ? 'rolled-back' : 'failed',
    message: result.ok ? 'Rollback restored backup successfully.' : (result.error || 'Rollback failed.'),
    trigger: 'manual-rollback',
    hasUpdates: false,
    details: result,
  });
  return result;
});
ipcMain.handle('updates:backups', async () => listBackups(getWorkspaceRoot()));
ipcMain.handle('updates:appRollbacks', async () => ({
  ok: true,
  root: getDesktopAppRollbackRoot(getWorkspaceRoot(), 'darwin'),
  backups: listArchivedAppBackups(getWorkspaceRoot(), 'darwin'),
}));
ipcMain.handle('updates:appMigrateLegacyBackups', async () => {
  const result = migrateLegacyAppBackups(getWorkspaceRoot(), { applicationsDir: '/Applications' });
  return {
    ...result,
    snapshot: workspaceSnapshot(),
  };
});
ipcMain.handle('updates:appInstallBuilt', async (_event, payload = {}) => {
  const result = installMacAppBundle(getWorkspaceRoot(), payload.sourceAppPath, {
    applicationsDir: String(payload.applicationsDir || '/Applications').trim() || '/Applications',
  });
  return {
    ...result,
    appRollbacks: {
      root: getDesktopAppRollbackRoot(getWorkspaceRoot(), 'darwin'),
      backups: listArchivedAppBackups(getWorkspaceRoot(), 'darwin'),
    },
  };
});
ipcMain.handle('updates:binaryBuild', async () => buildBinaryReleaseNow());
ipcMain.handle('updates:binaryCheck', async () => checkBinaryForUpdates());
ipcMain.handle('updates:binaryDownload', async () => downloadBinaryUpdateNow());
ipcMain.handle('updates:binaryInstall', async (_event, payload = {}) => installBinaryUpdateNow(payload));
ipcMain.handle('updates:binaryPromote', async () => {
  const result = promoteLatestStagedRelease(getWorkspaceRoot());
  initializeBinaryUpdater();
  return result;
});
ipcMain.handle('updates:binaryPrune', async () => {
  const result = pruneStagedReleases(getWorkspaceRoot());
  initializeBinaryUpdater();
  return result;
});
ipcMain.handle('storage:cleanup', async (_event, payload = {}) => {
  const workspaceRoot = getWorkspaceRoot();
  return cleanupStorageArtifacts(workspaceRoot, payload);
});


app.whenReady().then(() => {
  applyStabilityProfileMigration();
  const initialWorkspace = getWorkspaceRoot();
  if (initialWorkspace) {
    store.set('workspaceRoot', initialWorkspace);
  }
  if (getSelectedLabRoot() && !fs.existsSync(getSelectedLabRoot())) {
    clearSelectedLabRoot();
  }
  updateLearningJournalScope({
    workspaceRoot: getWorkspaceRoot(),
    labRoot: getSelectedLabRoot(),
    targetWorkspaceRoot: getTargetWorkspaceRoot(),
    pollingEnabled: false,
  });
  createMainWindow();
  if (!HEADLESS_SMOKE_MODE) {
    restartAutoUpdateMonitor();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopAutopilotScheduler();
  learningJournal.stop();
  if (autoUpdateTimer) {
    clearInterval(autoUpdateTimer);
    autoUpdateTimer = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
