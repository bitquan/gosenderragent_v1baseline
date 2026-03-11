'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  dialog,
  shell,
  safeStorage,
} = require('electron');
const StoreModule = require('electron-store');
const Store = StoreModule.default || StoreModule;

const { SharedAgentRuntime } = require('./shared-runtime/runtime');
const { parseBatBoard, summarizeBats, parseAssistantRuns } = require('./core/board');
const { listSkills, runSkill } = require('./core/skills');
const {
  listAutomations,
  upsertAutomation,
  toggleAutomation,
  removeAutomation,
} = require('./core/automations');
const {
  checkForUpdates,
  buildUpdatePlan,
  applyUpdate,
  rollbackUpdate,
  listBackups,
} = require('./core/updater');
const { runPreflight } = require('./core/preflight');
const { sanitizeRelativePath } = require('./core/utils');
const { handleAssistantChat } = require('./core/chat');
const {
  buildReviewSnapshot,
  readWorkspaceFile,
  saveWorkspaceFile,
  getWorkspaceDiff,
  normalizeReviewPath,
} = require('./core/review');

let keytar = null;
try {
  // optional native dependency
  // eslint-disable-next-line global-require
  keytar = require('keytar');
} catch (_err) {
  keytar = null;
}

const DEFAULT_WORKSPACE = path.resolve(__dirname, '..', '..');
const SECRET_SERVICE = 'gosenderr-desktop-agent';

const store = new Store({
  name: 'desktop-agent-settings',
  defaults: {
    workspaceRoot: DEFAULT_WORKSPACE,
    model: 'Qwen2.5-Coder-7B (Local)',
    mode: 'Extra High',
    runtime: 'local',
    localAiCmd: 'backend/.venv/bin/python backend/scripts/local_ai_llama_bridge.py',
    githubEnabled: false,
    reviewDecisions: {},
    autoUpdateEnabled: true,
    autoUpdateAutoApply: true,
    autoUpdateIntervalMinutes: 30,
  },
});

let mainWindow = null;
let latestUpdateStatus = {
  state: 'idle',
  message: 'Auto-update standby.',
  checkedAt: null,
  hasUpdates: false,
  trigger: 'startup',
};
let autoUpdateTimer = null;
const runtime = new SharedAgentRuntime({
  workspaceRoot: getWorkspaceRoot(),
  pythonRelative: 'backend/.venv/bin/python',
});

runtime.on('run-event', (event) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('agent:run-event', event);
});

runtime.on('scheduler-event', (event) => {
  sendSchedulerEvent(event);
});

function sendSchedulerEvent(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('agent:scheduler-event', payload);
}

function sendUpdateEvent(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('app:update-event', payload);
}

function activeRunCount() {
  const status = runtime.getStatus();
  return Array.isArray(status?.activeRuns) ? status.activeRuns.length : 0;
}

function repoIsClean(workspaceRoot) {
  if (!workspaceRoot) {
    return false;
  }
  try {
    const output = childProcess.execSync('git status --porcelain', {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return !String(output || '').trim();
  } catch (_err) {
    return false;
  }
}

function autoUpdateSettings() {
  return {
    enabled: !!store.get('autoUpdateEnabled'),
    autoApply: !!store.get('autoUpdateAutoApply'),
    intervalMinutes: Math.max(5, Number(store.get('autoUpdateIntervalMinutes') || 30)),
  };
}

function updateStatusSnapshot(patch = {}) {
  latestUpdateStatus = {
    ...latestUpdateStatus,
    ...patch,
    checkedAt: patch.checkedAt || new Date().toISOString(),
  };
  sendUpdateEvent(latestUpdateStatus);
  return latestUpdateStatus;
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

  updateStatusSnapshot({
    state: 'applying',
    message: 'Applying safe auto-update…',
    trigger,
    hasUpdates: true,
    details: check,
  });
  const applied = applyUpdate(workspaceRoot, { confirm: true });
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
  autoUpdateTimer = setInterval(() => {
    runAutoUpdateCycle({ trigger: 'interval', allowApply: true });
  }, settings.intervalMinutes * 60 * 1000);
}

function schedulerStatusPayload() {
  return runtime.schedulerStatus();
}

function startAutopilotScheduler(payload = {}) {
  const workspaceRoot = payload.workspace
    ? setWorkspaceRoot(payload.workspace)
    : getWorkspaceRoot();

  runtime.setWorkspaceRoot(workspaceRoot);
  return runtime.startScheduler({ workspace: workspaceRoot });
}

function stopAutopilotScheduler() {
  return runtime.stopScheduler();
}

function isFinalRunState(state) {
  return state === 'pass' || state === 'fail' || state === 'cancelled';
}

function waitForRunCompletion(runId) {
  return new Promise((resolve) => {
    const listener = (event) => {
      if (!event || event.runId !== runId) {
        return;
      }
      if (!isFinalRunState(event.state)) {
        return;
      }
      runtime.off('run-event', listener);
      resolve(event);
    };
    runtime.on('run-event', listener);
  });
}

async function runLearnPipeline(payload = {}) {
  const analyzeRun = handleAgentRun('analyze-log', payload);
  const analyzeFinal = analyzeRun?.runId ? await waitForRunCompletion(analyzeRun.runId) : null;
  if (analyzeFinal && analyzeFinal.state !== 'pass') {
    return {
      ok: false,
      message: 'Learn pipeline stopped: analyze-log failed.',
      analyzeRun,
      analyzeFinal,
      trainRun: null,
      trainFinal: null,
    };
  }

  const trainRun = handleAgentRun('train', payload);
  const trainFinal = trainRun?.runId ? await waitForRunCompletion(trainRun.runId) : null;
  const ok = !!trainFinal && trainFinal.state === 'pass';
  return {
    ok,
    message: ok ? 'Learn pipeline completed.' : 'Learn pipeline finished with failures.',
    analyzeRun,
    analyzeFinal,
    trainRun,
    trainFinal,
  };
}

function getWorkspaceRoot() {
  const configured = String(store.get('workspaceRoot') || '').trim();
  if (configured && fs.existsSync(configured)) {
    return configured;
  }
  return DEFAULT_WORKSPACE;
}

function setWorkspaceRoot(nextRoot) {
  const root = path.resolve(String(nextRoot || '').trim());
  if (!root || !fs.existsSync(root)) {
    throw new Error('Workspace path does not exist.');
  }
  store.set('workspaceRoot', root);
  runtime.setWorkspaceRoot(root);
  restartAutoUpdateMonitor();
  setTimeout(() => {
    runAutoUpdateCycle({ trigger: 'workspace-change', allowApply: true });
  }, 100);
  return root;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    title: 'GoSenderr Desktop Agent',
    backgroundColor: '#0b0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function setSecret(name, value) {
  if (!name) {
    throw new Error('Secret name is required.');
  }

  if (keytar) {
    await keytar.setPassword(SECRET_SERVICE, name, String(value || ''));
    return { ok: true, backend: 'keytar' };
  }

  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, backend: 'none', message: 'OS encryption is unavailable.' };
  }

  const encrypted = safeStorage.encryptString(String(value || '')).toString('base64');
  const fallback = store.get('encryptedSecrets') || {};
  fallback[name] = encrypted;
  store.set('encryptedSecrets', fallback);
  return { ok: true, backend: 'safeStorage-fallback' };
}

async function getSecret(name) {
  if (!name) {
    return { ok: false, value: null, backend: 'none' };
  }

  if (keytar) {
    const value = await keytar.getPassword(SECRET_SERVICE, name);
    return { ok: true, value: value || '', backend: 'keytar' };
  }

  const fallback = store.get('encryptedSecrets') || {};
  const blob = fallback[name];
  if (!blob) {
    return { ok: true, value: '', backend: 'safeStorage-fallback' };
  }

  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, value: null, backend: 'none' };
  }

  const value = safeStorage.decryptString(Buffer.from(blob, 'base64'));
  return { ok: true, value, backend: 'safeStorage-fallback' };
}

function runAssistantCli(workspaceRoot, args, extraEnv = {}) {
  if (!Array.isArray(args) || args[0] !== '--ai') {
    return Promise.resolve('Unsupported assistant CLI invocation.');
  }
  const promptIndex = args.indexOf('--prompt');
  const prompt = promptIndex >= 0 ? String(args[promptIndex + 1] || '') : '';
  const editorContext = buildDesktopEditorContext(workspaceRoot);
  const editorContextText = compactEditorContextText(editorContext);
  const promptWithContext = editorContextText
    ? `${prompt}\n\nDesktop editor context:\n${editorContextText}`
    : prompt;
  runtime.setWorkspaceRoot(workspaceRoot);
  return runtime.chat(promptWithContext, { env: extraEnv, editor_context: editorContext }).then((response) => {
    const reply = response && typeof response.reply === 'string' ? response.reply.trim() : '';
    return reply || '(AI unavailable)';
  }).catch((err) => `AI command failed to start: ${err.message}`);
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

function getConfiguredLocalAiCmd() {
  const configured = normalizeLocalAiCmd(store.get('localAiCmd') || '');
  if (configured) {
    return configured;
  }
  return normalizeLocalAiCmd(process.env.LOCAL_AI_CMD || '');
}

function workspaceSnapshot() {
  const workspaceRoot = getWorkspaceRoot();
  const bats = parseBatBoard(workspaceRoot);
  const boardStatusByTicket = new Map(bats.map((item) => [String(item.ticket), String(item.status || '')]));
  const latestRuntime = runtime.getStatus().latest?.[0] || null;
  const recentRuns = parseAssistantRuns(workspaceRoot, { limit: 20 });
  const recovery = runtime.getRecoveryState();
  let changedFiles = [];
  if (workspaceRoot) {
    try {
      const out = childProcess.execSync('git status --short', { cwd: workspaceRoot, encoding: 'utf8' });
      changedFiles = out.trim().split(/\r?\n/).filter((l) => l);
    } catch (_e) {
      // ignore errors
    }
  }
  return {
    workspaceRoot,
    bats,
    summary: summarizeBats(bats),
    recentRuns,
    changedFiles,
    editorContext: buildDesktopEditorContext(workspaceRoot),
    review: buildReviewSnapshot(workspaceRoot, {
      changedFiles,
      recentRuns,
      latestRun: latestRuntime,
      decisions: store.get('reviewDecisions') || {},
    }),
    preflight: runPreflight(workspaceRoot, { requireGh: false }),
    updates: latestUpdateStatus,
    recovery: {
      ...recovery,
      runs: (Array.isArray(recovery?.runs) ? recovery.runs : []).filter((run) => {
        const status = boardStatusByTicket.get(String(run?.ticket || '')) || '';
        const hasArtifacts = Array.isArray(run?.artifactPaths) && run.artifactPaths.length > 0;
        const hasChecks = Array.isArray(run?.checks) && run.checks.length > 0;
        return !(status.includes('DONE') && !hasArtifacts && !hasChecks);
      }),
    },
    settings: {
      model: store.get('model'),
      mode: store.get('mode'),
      runtime: store.get('runtime'),
      localAiCmd: store.get('localAiCmd'),
      githubEnabled: !!store.get('githubEnabled'),
      autoUpdateEnabled: !!store.get('autoUpdateEnabled'),
      autoUpdateAutoApply: !!store.get('autoUpdateAutoApply'),
      autoUpdateIntervalMinutes: Math.max(5, Number(store.get('autoUpdateIntervalMinutes') || 30)),
    },
  };
}

function handleAgentRun(action, payload = {}) {
  const workspaceRoot = payload.workspace
    ? setWorkspaceRoot(payload.workspace)
    : getWorkspaceRoot();

  const request = {
    ...payload,
    action,
    workspace: workspaceRoot,
    editor_context: payload.editor_context || buildDesktopEditorContext(workspaceRoot),
  };

  if (!request.profile) {
    if (action === 'implement') {
      request.profile = 'aiWrite';
    } else if (action === 'run') {
      request.profile = 'preview';
    } else if (action === 'sprint' && request.sprintAction === 'implement') {
      request.profile = 'aiWrite';
    } else if (action === 'autopilot') {
      request.profile = 'aiWrite';
    }
  }

  if (action === 'sprint' && request.sprintAction === 'implement' && request.ship === undefined) {
    request.ship = false;
  }

  if (action === 'autopilot') {
    if (!request.autopilotAction && !request.sprintAction) {
      request.autopilotAction = 'implement';
    }
    if (request.count === undefined && request.autopilotCount === undefined) {
      request.autopilotCount = 1;
    }
    if (!request.status) {
      request.status = 'TODO';
    }
    if (!request.requireTag) {
      request.requireTag = 'BE';
    }
  }

  return runtime.run(request);
}

ipcMain.handle('app:bootstrap', async () => workspaceSnapshot());
ipcMain.handle('app:meta', async () => ({
  version: app.getVersion(),
  name: app.getName(),
  electron: process.versions.electron,
}));

ipcMain.handle('app:pickWorkspace', async () => {
  const selected = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    defaultPath: getWorkspaceRoot(),
  });
  if (selected.canceled || selected.filePaths.length === 0) {
    return { ok: false, cancelled: true };
  }
  const workspaceRoot = setWorkspaceRoot(selected.filePaths[0]);
  return {
    ok: true,
    workspaceRoot,
    snapshot: workspaceSnapshot(),
  };
});

ipcMain.handle('app:setWorkspace', async (_event, payload = {}) => {
  const workspaceRoot = setWorkspaceRoot(payload.workspaceRoot);
  return {
    ok: true,
    workspaceRoot,
    snapshot: workspaceSnapshot(),
  };
});

ipcMain.handle('app:updateSettings', async (_event, payload = {}) => {
  if (payload.model) {
    store.set('model', String(payload.model));
  }
  if (payload.mode) {
    store.set('mode', String(payload.mode));
  }
  if (payload.runtime) {
    store.set('runtime', String(payload.runtime));
  }
  if (payload.localAiCmd !== undefined) {
    store.set('localAiCmd', normalizeLocalAiCmd(payload.localAiCmd || ''));
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
  restartAutoUpdateMonitor();
  return {
    ok: true,
    settings: {
      model: store.get('model'),
      mode: store.get('mode'),
      runtime: store.get('runtime'),
      localAiCmd: store.get('localAiCmd'),
      githubEnabled: !!store.get('githubEnabled'),
      autoUpdateEnabled: !!store.get('autoUpdateEnabled'),
      autoUpdateAutoApply: !!store.get('autoUpdateAutoApply'),
      autoUpdateIntervalMinutes: Math.max(5, Number(store.get('autoUpdateIntervalMinutes') || 30)),
    },
  };
});

ipcMain.handle('app:secrets:set', async (_event, payload = {}) => setSecret(payload.name, payload.value));
ipcMain.handle('app:secrets:get', async (_event, payload = {}) => getSecret(payload.name));


// track state for new assistant features
let lastRunTicket = null;
let lastRunPassed = false;
let lastFailedTicket = null;
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

function getReviewDecisions() {
  const payload = store.get('reviewDecisions');
  return payload && typeof payload === 'object' ? payload : {};
}

function setReviewDecision(relativePath, status, note = '') {
  const normalizedPath = normalizeReviewPath(relativePath);
  if (!normalizedPath) {
    return { ok: false, message: 'Path is required.' };
  }
  const decisions = getReviewDecisions();
  decisions[normalizedPath] = {
    status: String(status || 'pending'),
    note: String(note || ''),
    updatedAt: new Date().toISOString(),
  };
  store.set('reviewDecisions', decisions);
  return { ok: true, path: normalizedPath, decision: decisions[normalizedPath] };
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

ipcMain.handle('assistant:chat', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspace
    ? setWorkspaceRoot(payload.workspace)
    : getWorkspaceRoot();
  const text = String(payload.text || '').trim();
  if (!text) {
    return { ok: true, reply: 'Please enter a message.' };
  }

  const reply = await handleAssistantChat(workspaceRoot, text, {
    runBatchRun: async () => {
      const res = await handleAgentRun('sprint', {
        workspace: workspaceRoot,
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
        workspace: workspaceRoot,
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
    runTicket: async ({ ticket, implement }) => {
      const res = await handleAgentRun(implement ? 'implement' : 'run', {
        workspace: workspaceRoot,
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
    next: async () => {
      const bats = parseBatBoard(workspaceRoot);
      const todo = bats.find((b) => (b.status || '').includes('TODO'));
      return todo ? `Next TODO: BAT<${todo.ticket}>` : 'No TODO tasks found.';
    },
    repair: async () => {
      if (!lastFailedTicket) {
        return 'No failed run to repair.';
      }
      await handleAgentRun('run', {
        workspace: workspaceRoot,
        ticket: lastFailedTicket,
        profile: 'repair',
        template: 'auto',
        fixLoop: true,
      });
      return `Repair launched for BAT<${lastFailedTicket}>.`;
    },
    files: async () => {
      if (!workspaceRoot) {
        return 'No workspace open.';
      }
      try {
        const out = childProcess.execSync('git status --short', { cwd: workspaceRoot, encoding: 'utf8' });
        return out.trim() ? `Changed files:\n${out}` : 'Repository clean.';
      } catch (err) {
        return `Unable to get git status: ${err.message}`;
      }
    },
    auditToggle: async () => {
      auditEnforced = !auditEnforced;
      return `Audit enforcement is now ${auditEnforced ? 'ON' : 'OFF'}.`;
    },
    getSummary: async () => summarizeBats(parseBatBoard(workspaceRoot)),
    getStatus: async () => runtime.getStatus(),
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
      const localCmd = getConfiguredLocalAiCmd();
      if (localCmd) {
        return true;
      }
      if (process.env.LOCAL_AI_CMD) {
        return true;
      }
      if (process.env.OPENAI_API_KEY) {
        return true;
      }
      const secret = await getSecret('OPENAI_API_KEY');
      return !!(secret.ok && secret.value);
    },
    runAi: async (_root, prompt) => {
      const localCmd = getConfiguredLocalAiCmd();
      const secret = await getSecret('OPENAI_API_KEY');
      const env = {};
      if (localCmd) {
        env.LOCAL_AI_CMD = localCmd;
        // Force local path when command is configured.
        env.OPENAI_API_KEY = '';
      }
      if (secret.ok && secret.value) {
        if (!localCmd) {
          env.OPENAI_API_KEY = secret.value;
        }
      }
      return runAssistantCli(workspaceRoot, ['--ai', '--prompt', prompt], env);
    },
    runAutopilot: async () => {
      const run = await handleAgentRun('autopilot', { workspace: workspaceRoot });
      return run?.runId ? `Started autopilot run (${run.runId}).` : 'Unable to start autopilot run.';
    },
    runTrain: async () => {
      const run = await handleAgentRun('train', { workspace: workspaceRoot });
      return run?.runId ? `Started training run (${run.runId}).` : 'Unable to start training run.';
    },
    runLearn: async () => {
      const result = await runLearnPipeline({ workspace: workspaceRoot });
      return result.message || 'Learn pipeline started.';
    },
    autopilotSchedulerStart: async () => startAutopilotScheduler({ workspace: workspaceRoot }).message,
    autopilotSchedulerStop: async () => stopAutopilotScheduler().message,
    autopilotSchedulerStatus: async () => schedulerStatusPayload().message,
    aiMissingMessage:
      'No AI backend configured. Set Local AI Command in Quick Controls or configure OPENAI_API_KEY.',
    helpText:
      'Try: /run 176, /implement 176, /batch run, /batch implement, /autopilot, /autopilot start, /stop, /train, /learn, /status, /cancel <runId>.',
  });

  return { ok: true, reply };
});

ipcMain.handle('agent:preflight', async (_event, payload = {}) => {
  const workspaceRoot = payload.workspace || getWorkspaceRoot();
  return runPreflight(workspaceRoot, {
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

ipcMain.handle('agent:run', async (_event, payload = {}) => handleAgentRun('run', payload));
ipcMain.handle('agent:implement', async (_event, payload = {}) => handleAgentRun('implement', payload));
ipcMain.handle('agent:sprint', async (_event, payload = {}) => handleAgentRun('sprint', payload));
ipcMain.handle('agent:autopilot', async (_event, payload = {}) => handleAgentRun('autopilot', payload));
ipcMain.handle('agent:train', async (_event, payload = {}) => handleAgentRun('train', payload));
ipcMain.handle('agent:learn', async (_event, payload = {}) => runLearnPipeline(payload));
ipcMain.handle('agent:autopilotSchedulerStart', async (_event, payload = {}) => startAutopilotScheduler(payload));
ipcMain.handle('agent:autopilotSchedulerStop', async () => stopAutopilotScheduler());
ipcMain.handle('agent:autopilotSchedulerStatus', async () => schedulerStatusPayload());
ipcMain.handle('agent:getEditorContext', async () => ({ ok: true, editorContext: buildDesktopEditorContext(getWorkspaceRoot()) }));
ipcMain.handle('agent:setEditorContextFocus', async (_event, payload = {}) => {
  const workspaceRoot = getWorkspaceRoot();
  let relativePath = String(payload.path || '').trim();
  if (relativePath && path.isAbsolute(relativePath)) {
    relativePath = toWorkspaceRelative(workspaceRoot, relativePath);
  }
  rememberDesktopFile(relativePath, payload.line || 1);
  return { ok: true, editorContext: buildDesktopEditorContext(workspaceRoot) };
});
ipcMain.handle('agent:openLocation', async (_event, payload = {}) => {
  const workspaceRoot = getWorkspaceRoot();
  const fullPath = sanitizeRelativePath(workspaceRoot, payload.path);
  if (!fullPath || !fs.existsSync(fullPath)) {
    return { ok: false, message: 'File not found.' };
  }
  rememberDesktopFile(toWorkspaceRelative(workspaceRoot, fullPath), payload.line || 1);
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

ipcMain.handle('review:readFile', async (_event, payload = {}) => {
  const workspaceRoot = getWorkspaceRoot();
  const result = readWorkspaceFile(workspaceRoot, payload.path, { maxChars: 50000 });
  if (result.ok) {
    rememberDesktopFile(result.path, payload.line || 1);
  }
  return result;
});

ipcMain.handle('review:getDiff', async (_event, payload = {}) => {
  const workspaceRoot = getWorkspaceRoot();
  return getWorkspaceDiff(workspaceRoot, payload.path, { maxChars: 50000 });
});

ipcMain.handle('review:saveFile', async (_event, payload = {}) => {
  const workspaceRoot = getWorkspaceRoot();
  const result = saveWorkspaceFile(workspaceRoot, payload.path, payload.content);
  if (!result.ok) {
    return result;
  }
  rememberDesktopFile(result.path, payload.line || 1);
  return {
    ...result,
    diff: getWorkspaceDiff(workspaceRoot, result.path, { maxChars: 50000 }).diff,
  };
});

ipcMain.handle('review:setDecision', async (_event, payload = {}) => {
  const result = setReviewDecision(payload.path, payload.status, payload.note || '');
  if (!result.ok) {
    return result;
  }
  const snapshot = workspaceSnapshot();
  return {
    ok: true,
    decision: result.decision,
    review: snapshot.review,
  };
});

ipcMain.handle('review:copyText', async (_event, payload = {}) => {
  clipboard.writeText(String(payload.text || ''));
  return { ok: true };
});

ipcMain.handle('review:openInVsCode', async (_event, payload = {}) => {
  const workspaceRoot = getWorkspaceRoot();
  return openInVsCode(workspaceRoot, payload.path, payload.line || 1);
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

app.whenReady().then(() => {
  createMainWindow();
  restartAutoUpdateMonitor();
  setTimeout(() => {
    runAutoUpdateCycle({ trigger: 'startup', allowApply: true });
  }, 1200);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopAutopilotScheduler();
  if (autoUpdateTimer) {
    clearInterval(autoUpdateTimer);
    autoUpdateTimer = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
