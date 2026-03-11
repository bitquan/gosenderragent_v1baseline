/* global gosAgent */

'use strict';

const state = {
  workspaceRoot: '',
  bats: [],
  summary: { total: 0, todo: 0, done: 0, tested: 0 },
  recentRuns: [],
  latestRun: null,
  activeRunId: null,
  chat: [
    'Assistant: Local-first mode active. Use /run 170, /implement 170, /batch run, /batch implement.',
  ],
  automations: [],
  skills: [],
  preflight: null,
  settings: {
    model: 'Qwen2.5-Coder-7B (Local)',
    mode: 'Extra High',
    runtime: 'local',
    localAiCmd: 'backend/.venv/bin/python backend/scripts/local_ai_llama_bridge.py',
    githubEnabled: false,
    openaiKey: '',
  },
  backups: [],
  editorContext: {},
  changedFiles: [],
  review: {
    changedFiles: [],
    failingLocations: [],
    recentArtifacts: [],
    decisions: {},
    selectedPath: '',
    selectedLine: 1,
    selectedKind: 'file',
    activeTab: 'file',
    fileContent: '',
    originalContent: '',
    diffContent: '',
    truncated: false,
    dirty: false,
    editMode: false,
    loading: false,
    status: 'Select a changed file, failure, or artifact.',
  },
};

// DOM element registry only. Keep executable logic in functions below.
const elements = {
  navButtons: document.querySelectorAll('.nav-btn'),
  views: document.querySelectorAll('.view'),
  taskList: document.getElementById('taskList'),
  taskSummary: document.getElementById('taskSummary'),
  taskStatusFilter: document.getElementById('taskStatusFilter'),
  taskSearch: document.getElementById('taskSearch'),
  chatLog: document.getElementById('chatLog'),
  chatInput: document.getElementById('chatInput'),
  chatSend: document.getElementById('chatSend'),
  runStateBadge: document.getElementById('runStateBadge'),
  latestRun: document.getElementById('latestRun'),
  runChecks: document.getElementById('runChecks'),
  recentRuns: document.getElementById('recentRuns'),
  btnCancelRun: document.getElementById('btnCancelRun'),
  skillsList: document.getElementById('skillsList'),
  automationsList: document.getElementById('automationsList'),
  autoName: document.getElementById('autoName'),
  autoCron: document.getElementById('autoCron'),
  autoEnabled: document.getElementById('autoEnabled'),
  updatePlan: document.getElementById('updatePlan'),
  rollbackSelect: document.getElementById('rollbackSelect'),
  validationLog: document.getElementById('validationLog'),
  editorContextPanel: document.getElementById('editorContextPanel'),
  reviewChangedFiles: document.getElementById('reviewChangedFiles'),
  reviewFailures: document.getElementById('reviewFailures'),
  reviewArtifacts: document.getElementById('reviewArtifacts'),
  reviewSelectionMeta: document.getElementById('reviewSelectionMeta'),
  reviewDecisionBadge: document.getElementById('reviewDecisionBadge'),
  reviewDecisionNote: document.getElementById('reviewDecisionNote'),
  reviewInspectorStatus: document.getElementById('reviewInspectorStatus'),
  reviewEditor: document.getElementById('reviewEditor'),
  btnRefreshReview: document.getElementById('btnRefreshReview'),
  btnReviewTabFile: document.getElementById('btnReviewTabFile'),
  btnReviewTabDiff: document.getElementById('btnReviewTabDiff'),
  btnReviewToggleEdit: document.getElementById('btnReviewToggleEdit'),
  btnReviewSave: document.getElementById('btnReviewSave'),
  btnReviewDiscard: document.getElementById('btnReviewDiscard'),
  btnReviewOpenVsCode: document.getElementById('btnReviewOpenVsCode'),
  btnReviewCopyPatch: document.getElementById('btnReviewCopyPatch'),
  btnDecisionApprove: document.getElementById('btnDecisionApprove'),
  btnDecisionDefer: document.getElementById('btnDecisionDefer'),
  btnDecisionReject: document.getElementById('btnDecisionReject'),
  workspaceInput: document.getElementById('workspaceInput'),
  preflightPanel: document.getElementById('preflightPanel'),
  secretName: document.getElementById('secretName'),
  secretValue: document.getElementById('secretValue'),
  settingsDrawer: document.getElementById('settingsDrawer'),
  settingModel: document.getElementById('settingModel'),
  settingMode: document.getElementById('settingMode'),
  settingRuntime: document.getElementById('settingRuntime'),
  settingLocalAiCmd: document.getElementById('settingLocalAiCmd'),
  settingGithub: document.getElementById('settingGithub'),
  settingOpenaiKey: document.getElementById('settingOpenaiKey'),
  btnAutopilot: document.getElementById('btnAutopilot'),
  btnTrain: document.getElementById('btnTrain'),
  btnLearn: document.getElementById('btnLearn'),
  btnSchedulerStart: document.getElementById('btnSchedulerStart'),
  btnSchedulerStop: document.getElementById('btnSchedulerStop'),
};

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function appendChat(line) {
  state.chat.push(line);
  if (state.chat.length > 220) {
    state.chat = state.chat.slice(-220);
  }
  renderChat();
}

function setActiveView(viewName) {
  elements.navButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });
  elements.views.forEach((view) => {
    const active = view.id === `view-${viewName}`;
    view.classList.toggle('active', active);
  });
}

function renderTaskList() {
  const statusFilter = String(elements.taskStatusFilter.value || 'TODO').toUpperCase();
  const search = String(elements.taskSearch.value || '')
    .trim()
    .toLowerCase();

  const filtered = state.bats.filter((item) => {
    if (statusFilter !== 'ALL') {
      const inStatus = item.status === statusFilter || (item.tags || []).includes(statusFilter);
      if (!inStatus) {
        return false;
      }
    }
    if (!search) {
      return true;
    }
    const haystack = `BAT<${item.ticket}> ${item.desc} ${(item.tags || []).join(' ')}`.toLowerCase();
    return haystack.includes(search);
  });

  elements.taskSummary.textContent = `${state.summary.todo || 0} TODO`;
  elements.taskList.innerHTML = filtered
    .slice(0, 80)
    .map((item) => {
      const title = item.desc.replace(/\[[^\]]+\]/g, '').trim() || `BAT<${item.ticket}>`;
      const riskBadge = item.risk ? `<span class="badge risk ${esc(item.risk)}">${esc(item.risk)}</span>` : '';
      const depsBadge = item.deps && item.deps.length ? `<span class="badge deps">deps:${esc(item.deps.join(','))}</span>` : '';
      return `
        <div class="task-row" data-ticket="${esc(item.ticket)}">
          <div class="title">BAT&lt;${esc(item.ticket)}&gt; ${esc(title)} ${riskBadge} ${depsBadge}</div>
          <div class="meta">${esc(item.status)} • ${esc((item.tags || []).join(', '))}</div>
          <div class="inline-row">
            <button data-action="run" data-ticket="${esc(item.ticket)}">Run</button>
            <button data-action="implement" data-ticket="${esc(item.ticket)}" class="primary">Implement</button>
          </div>
        </div>
      `;
    })
    .join('');

  if (!elements.taskList.innerHTML) {
    elements.taskList.innerHTML = '<div class="task-row">No tasks match current filters.</div>';
  }
}

function renderChat() {
  elements.chatLog.textContent = state.chat.join('\n');
  elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
}

function statusChipClass(runState) {
  if (runState === 'pass') {
    return 'chip chip-ok';
  }
  if (runState === 'fail' || runState === 'cancelled') {
    return 'chip chip-fail';
  }
  return 'chip chip-muted';
}

function decisionChipClass(status) {
  if (status === 'approved') {
    return 'chip chip-ok';
  }
  if (status === 'rejected') {
    return 'chip chip-fail';
  }
  if (status === 'deferred') {
    return 'chip chip-review';
  }
  return 'chip chip-muted';
}

function renderRuns() {
  const latest = state.latestRun || state.recentRuns[0] || null;
  if (!latest) {
    elements.latestRun.textContent = 'No runs yet.';
    elements.runChecks.innerHTML = '';
  } else {
    elements.latestRun.innerHTML = `
      <div class="title">${esc(latest.label || latest.command || latest.action || 'Run')}</div>
      <div class="meta">Run ID: ${esc(latest.runId || 'n/a')}</div>
      <div class="meta">State: ${esc(latest.state || 'unknown')} • Exit: ${esc(String(latest.exitCode ?? 'n/a'))}</div>
    `;
    const checks = Array.isArray(latest.checks) ? latest.checks : [];
    const locations = Array.isArray(latest.locations) ? latest.locations : [];
    elements.runChecks.innerHTML = checks.length
      ? checks
          .map((check) => `<div class="check-row">${esc(check.name || 'check')} • ${check.ok ? 'PASS' : 'FAIL'}</div>`)
          .join('')
      : '<div class="check-row">No checks captured for this run.</div>';
    if (locations.length > 0) {
      elements.runChecks.innerHTML += locations
        .slice(0, 8)
        .map(
          (loc) => `<div class="check-row">Failing: ${esc(loc.path)}:${esc(String(loc.line || 1))} <button data-open-path="${esc(loc.path)}" data-open-line="${esc(String(loc.line || 1))}">Open</button></div>`,
        )
        .join('');
    }
    elements.runStateBadge.className = statusChipClass(latest.state);
    elements.runStateBadge.textContent = String(latest.state || 'idle');
  }

  elements.recentRuns.innerHTML = state.recentRuns
    .slice(0, 20)
    .map((run) => {
      const stateLabel = run.state || (run.pass ? 'pass' : 'fail');
      const text = run.label || run.command || run.action || 'run';
      return `<div class="run-row"><div class="title">${esc(text)}</div><div class="meta">${esc(run.runId || 'n/a')} • ${esc(stateLabel)} • ${esc(run.ticket || '')}</div></div>`;
    })
    .join('');
}

function renderSkills() {
  elements.skillsList.innerHTML = state.skills
    .map((skill) => {
      return `
        <div class="skill-row">
          <div class="title">${esc(skill.name)}</div>
          <div class="meta">${esc(skill.description || '')}</div>
          <div class="meta">${esc(skill.path || '')}</div>
          <button data-skill-open="${esc(skill.path || '')}">Open Skill</button>
        </div>
      `;
    })
    .join('');

  if (!elements.skillsList.innerHTML) {
    elements.skillsList.innerHTML = '<div class="skill-row">No local skills found.</div>';
  }
}

function renderAutomations() {
  elements.automationsList.innerHTML = state.automations
    .map((job) => {
      const enabled = job.enabled !== false;
      return `
        <div class="auto-row">
          <div class="title">${esc(job.name)}</div>
          <div class="meta">${esc(job.cron)} • ${enabled ? 'enabled' : 'disabled'}</div>
          <div class="inline-row">
            <button data-auto-run="${esc(job.name)}">Run now</button>
            <button data-auto-toggle="${esc(job.name)}" data-enabled="${enabled ? '0' : '1'}">${enabled ? 'Disable' : 'Enable'}</button>
            <button data-auto-delete="${esc(job.name)}">Delete</button>
          </div>
        </div>
      `;
    })
    .join('');

  if (!elements.automationsList.innerHTML) {
    elements.automationsList.innerHTML = '<div class="auto-row">No automations configured.</div>';
  }
}

function renderPreflight() {
  const report = state.preflight;
  if (!report || !Array.isArray(report.checks)) {
    elements.preflightPanel.innerHTML = '<div class="preflight-row">Run preflight to view health checks.</div>';
    return;
  }

  elements.preflightPanel.innerHTML = report.checks
    .map((check) => {
      const level = check.ok ? 'OK' : check.severity === 'blocking' ? 'BLOCKING' : 'WARN';
      return `<div class="preflight-row"><div class="title">${esc(check.name)} • ${level}</div><div class="meta">${esc(check.detail || '')}</div></div>`;
    })
    .join('');
}

function renderUpdatePlan(payload) {
  elements.updatePlan.textContent = JSON.stringify(payload, null, 2);
}

function renderBackups() {
  elements.rollbackSelect.innerHTML = state.backups
    .map((id) => `<option value="${esc(id)}">${esc(id)}</option>`)
    .join('');
  if (!elements.rollbackSelect.innerHTML) {
    elements.rollbackSelect.innerHTML = '<option value="">No backups</option>';
  }
}

function renderEditorContext() {
  if (!elements.editorContextPanel) {
    return;
  }
  const context = state.editorContext || {};
  const diagnostics = Array.isArray(context.diagnostics) ? context.diagnostics : [];
  const openFiles = Array.isArray(context.open_files) ? context.open_files : [];
  const rows = [
    `<div class="preflight-row"><div class="title">Focused coding context</div><div class="meta">${esc(context.active_file_path || 'No focused file yet. Click a failing location or changed file to set one.')}</div></div>`,
  ];
  if (context.selection_start_line) {
    rows.push(`<div class="preflight-row"><div class="meta">Focus line: ${esc(String(context.selection_start_line))}</div></div>`);
  }
  if (context.surrounding_snippet) {
    rows.push(`<pre class="context-snippet">${esc(context.surrounding_snippet)}</pre>`);
  }
  if (diagnostics.length > 0) {
    rows.push(...diagnostics.map((item) => `<div class="preflight-row"><div class="title">${esc(item.severity || 'issue')}</div><div class="meta">${esc(item.message || '')}</div></div>`));
  }
  if (openFiles.length > 0) {
    rows.push(`<div class="preflight-row"><div class="meta">Recent files: ${esc(openFiles.join(', '))}</div></div>`);
  }
  elements.editorContextPanel.innerHTML = rows.join('');
}

function reviewDecisionFor(path) {
  return state.review.decisions?.[path] || { status: 'pending', note: '' };
}

function renderReviewList(container, items, kind) {
  if (!container) {
    return;
  }
  if (!Array.isArray(items) || items.length === 0) {
    container.innerHTML = `<div class="preflight-row">No ${esc(kind)}.</div>`;
    return;
  }
  container.innerHTML = items
    .map((item) => {
      const path = item.path || item.relativePath || '';
      const selected = path === state.review.selectedPath ? ' selected' : '';
      const decision = reviewDecisionFor(path);
      const title = kind === 'artifacts'
        ? (item.label || path)
        : `${path}${item.line ? `:${item.line}` : ''}`;
      const meta = [item.status, item.message, item.runLabel, decision.status]
        .filter(Boolean)
        .join(' • ');
      return `
        <button
          class="review-item${selected}"
          data-review-path="${esc(path)}"
          data-review-line="${esc(String(item.line || 1))}"
          data-review-kind="${esc(kind)}"
        >
          <div class="title">${esc(title)}</div>
          <div class="meta">${esc(meta)}</div>
        </button>
      `;
    })
    .join('');
}

function renderReviewInspector() {
  const selectedPath = state.review.selectedPath;
  const decision = selectedPath ? reviewDecisionFor(selectedPath) : { status: 'pending', note: '' };
  if (elements.reviewSelectionMeta) {
    elements.reviewSelectionMeta.textContent = selectedPath
      ? `${selectedPath}${state.review.selectedLine ? `:${state.review.selectedLine}` : ''}`
      : 'Select a changed file, failure, or artifact.';
  }
  if (elements.reviewDecisionBadge) {
    elements.reviewDecisionBadge.className = decisionChipClass(decision.status);
    elements.reviewDecisionBadge.textContent = decision.status || 'pending';
  }
  if (elements.reviewDecisionNote) {
    elements.reviewDecisionNote.value = decision.note || '';
  }
  if (elements.reviewInspectorStatus) {
    const bits = [state.review.status];
    if (state.review.truncated) {
      bits.push('Large file view is truncated; save is disabled.');
    }
    if (state.review.dirty) {
      bits.push('Unsaved local edits.');
    }
    elements.reviewInspectorStatus.textContent = bits.filter(Boolean).join(' ');
  }
  if (elements.reviewEditor) {
    const isDiff = state.review.activeTab === 'diff';
    elements.reviewEditor.readOnly = isDiff || !state.review.editMode || state.review.truncated;
    elements.reviewEditor.value = isDiff ? (state.review.diffContent || 'No local diff for this file yet.') : (state.review.fileContent || '');
  }
  if (elements.btnReviewTabFile) {
    elements.btnReviewTabFile.classList.toggle('primary', state.review.activeTab === 'file');
  }
  if (elements.btnReviewTabDiff) {
    elements.btnReviewTabDiff.classList.toggle('primary', state.review.activeTab === 'diff');
  }
  if (elements.btnReviewToggleEdit) {
    elements.btnReviewToggleEdit.textContent = state.review.editMode ? 'Preview' : 'Edit';
  }
  if (elements.btnReviewSave) {
    elements.btnReviewSave.disabled = !state.review.editMode || !state.review.dirty || state.review.truncated;
  }
  if (elements.btnReviewDiscard) {
    elements.btnReviewDiscard.disabled = !state.review.dirty;
  }
  if (elements.btnReviewCopyPatch) {
    elements.btnReviewCopyPatch.disabled = !state.review.selectedPath;
  }
}

function renderReview() {
  renderReviewList(elements.reviewChangedFiles, state.review.changedFiles, 'files');
  renderReviewList(elements.reviewFailures, state.review.failingLocations, 'failures');
  renderReviewList(elements.reviewArtifacts, state.review.recentArtifacts, 'artifacts');
  renderReviewInspector();
}

async function setReviewTab(tabName) {
  state.review.activeTab = tabName === 'diff' ? 'diff' : 'file';
  if (state.review.activeTab === 'diff' && state.review.selectedPath) {
    const diffPayload = await gosAgent.getReviewDiff({ path: state.review.selectedPath });
    state.review.diffContent = diffPayload?.diff || '';
    state.review.status = diffPayload?.diff ? 'Loaded current git diff.' : 'No local diff for this selection yet.';
  }
  renderReviewInspector();
}

async function loadReviewSelection(path, line = 1, kind = 'files') {
  if (!path) {
    return;
  }
  state.review.selectedPath = path;
  state.review.selectedLine = Number(line || 1);
  state.review.selectedKind = kind;
  state.review.loading = true;
  state.review.status = 'Loading selection…';
  renderReview();

  const contextPayload = await gosAgent.setEditorContextFocus({ path, line });
  state.editorContext = contextPayload?.editorContext || state.editorContext;
  renderEditorContext();

  const filePayload = await gosAgent.readReviewFile({ path, line });
  if (!filePayload?.ok) {
    state.review.fileContent = '';
    state.review.originalContent = '';
    state.review.diffContent = '';
    state.review.truncated = false;
    state.review.loading = false;
    state.review.status = filePayload?.message || 'Unable to load file.';
    renderReview();
    return;
  }

  state.review.fileContent = filePayload.content || '';
  state.review.originalContent = filePayload.content || '';
  state.review.truncated = !!filePayload.truncated;
  state.review.dirty = false;
  state.review.editMode = false;

  const diffPayload = await gosAgent.getReviewDiff({ path });
  state.review.diffContent = diffPayload?.diff || '';
  state.review.loading = false;
  state.review.status = filePayload.truncated
    ? 'Loaded truncated file preview.'
    : `Loaded ${kind === 'artifacts' ? 'artifact' : 'file'} for review.`;
  renderReview();
}

function syncReviewFromSnapshot(snapshot) {
  state.review.changedFiles = snapshot?.review?.changedFiles || [];
  state.review.failingLocations = snapshot?.review?.failingLocations || [];
  state.review.recentArtifacts = snapshot?.review?.recentArtifacts || [];
  state.review.decisions = snapshot?.review?.decisions || {};
}

async function ensureReviewSelection() {
  if (state.review.selectedPath) {
    renderReview();
    return;
  }
  const firstChanged = state.review.changedFiles[0]?.path;
  const firstFailure = state.review.failingLocations[0]?.path;
  const firstArtifact = state.review.recentArtifacts[0]?.relativePath;
  const nextPath = state.editorContext?.active_file_path || firstChanged || firstFailure || firstArtifact;
  if (nextPath) {
    const failure = state.review.failingLocations.find((item) => item.path === nextPath);
    await loadReviewSelection(nextPath, failure?.line || 1, failure ? 'failures' : 'files');
    return;
  }
  renderReview();
}

async function refreshSnapshot() {
  const snapshot = await gosAgent.bootstrap();
  state.workspaceRoot = snapshot.workspaceRoot;
  state.bats = snapshot.bats || [];
  state.summary = snapshot.summary || state.summary;
  state.recentRuns = snapshot.recentRuns || [];
  state.preflight = snapshot.preflight || null;
  state.settings = snapshot.settings || state.settings;
  state.changedFiles = snapshot.changedFiles || [];
  state.editorContext = snapshot.editorContext || {};
  syncReviewFromSnapshot(snapshot);
  if (snapshot.recovery?.runs?.length) {
    state.latestRun = snapshot.recovery.runs[0];
  }

  elements.workspaceInput.value = state.workspaceRoot;
  elements.settingModel.value = state.settings.model || 'GPT-5.3-Codex';
  elements.settingMode.value = state.settings.mode || 'Extra High';
  elements.settingRuntime.value = state.settings.runtime || 'hybrid';
  elements.settingLocalAiCmd.value =
    state.settings.localAiCmd || 'backend/.venv/bin/python backend/scripts/local_ai_llama_bridge.py';
  elements.settingGithub.checked = !!state.settings.githubEnabled;

  renderTaskList();
  renderChat();
  renderRuns();
  renderPreflight();
  renderValidation();
  renderReview();

  await loadSkills();
  await loadAutomations();
  await loadBackups();
  await ensureReviewSelection();
}

function renderValidation() {
  if (!elements.validationLog) {
    return;
  }
  const items = Array.isArray(state.changedFiles) ? state.changedFiles : [];
  elements.validationLog.innerHTML = items.length
    ? items
        .map((line) => {
          const cleaned = String(line || '').trim();
          const pathText = cleaned.replace(/^[A-Z?]{1,2}\s+/, '');
          return `<div class="preflight-row"><div class="title">${esc(cleaned)}</div><div class="inline-row"><button data-context-path="${esc(pathText)}">Use as context</button><button data-open-path="${esc(pathText)}" data-open-line="1">Open</button></div></div>`;
        })
        .join('')
    : '<div class="preflight-row">No changed files.</div>';
  renderEditorContext();
}

function onRunEvent(event) {
  if (!event) {
    return;
  }

  if (event.logChunk) {
    const rows = String(event.logChunk)
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-2)
      .map((line) => `Log: ${line}`);
    for (const row of rows) {
      appendChat(row);
    }
  }

  if (event.state && event.state !== 'running') {
    appendChat(`Assistant: ${event.label || 'Run'} finished with ${event.state.toUpperCase()}.`);
    if (event.boardUpdate?.updated) {
      appendChat(`Assistant: BAT board updated (${event.boardUpdate.reason || 'board updated'}).`);
    } else if (event.boardUpdate && event.label && /BAT<\d+>/i.test(String(event.label))) {
      appendChat(`Assistant: BAT board not updated (${event.boardUpdate.reason || 'no board change'}).`);
    } else if (event.blockedReason && event.label && /BAT<\d+>/i.test(String(event.label))) {
      appendChat(`Assistant: BAT board not updated (${event.blockedReason}).`);
    }
  }

  if (event.state === 'running' && !event.logChunk && state.activeRunId !== event.runId) {
    appendChat(`Run: ${event.label || 'job'} started (${event.runId})`);
  }

  const run = {
    runId: event.runId,
    label: event.label,
    state: event.state,
    exitCode: event.exitCode,
    checks: event.checks || [],
    locations: event.locations || [],
    ticket: event.ticket || '',
    command: event.label || '',
  };

  state.latestRun = run;
  state.activeRunId = event.state === 'running' ? event.runId : null;
  state.recentRuns = [run, ...state.recentRuns.filter((item) => item.runId !== run.runId)].slice(0, 30);
  renderRuns();

  if (event.state && event.state !== 'running') {
    refreshSnapshot().catch(() => {});
  }
}

async function executeCommand(rawInput) {
  const input = String(rawInput || '').trim();
  if (!input) {
    return;
  }
  appendChat(`You: ${input}`);
  const response = await gosAgent.chatMessage(input, state.workspaceRoot);
  appendChat(`Assistant: ${response?.reply || 'No response.'}`);
}

async function loadSkills() {
  state.skills = await gosAgent.listSkills({});
  renderSkills();
}

async function loadAutomations() {
  state.automations = await gosAgent.listAutomations({});
  renderAutomations();
}

async function loadBackups() {
  state.backups = await gosAgent.listBackups({});
  renderBackups();
}

function bindEvents() {
  elements.navButtons.forEach((btn) => {
    btn.addEventListener('click', () => setActiveView(btn.dataset.view));
  });

  elements.taskStatusFilter.addEventListener('change', renderTaskList);
  elements.taskSearch.addEventListener('input', renderTaskList);

  elements.taskList.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const action = target.dataset.action;
    const ticket = target.dataset.ticket;
    if (!action || !ticket) {
      return;
    }
    if (action === 'run') {
      await executeCommand(`/run ${ticket}`);
    } else if (action === 'implement') {
      await executeCommand(`/implement ${ticket}`);
    }
  });

  document.querySelectorAll('.cmd-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cmd = btn.dataset.cmd || '';
      elements.chatInput.value = cmd;
      elements.chatInput.focus();
    });
  });

  elements.chatSend.addEventListener('click', async () => {
    const text = elements.chatInput.value;
    elements.chatInput.value = '';
    await executeCommand(text);
  });

  elements.chatInput.addEventListener('keydown', async (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const text = elements.chatInput.value;
      elements.chatInput.value = '';
      await executeCommand(text);
    }
  });

  elements.btnCancelRun.addEventListener('click', async () => {
    if (!state.activeRunId) {
      appendChat('Assistant: no active run to cancel.');
      return;
    }
    await gosAgent.cancel({ runId: state.activeRunId });
  });

  elements.runChecks.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const openPath = target.dataset.openPath;
    if (!openPath) {
      return;
    }
    const openLine = Number(target.dataset.openLine || 1);
    const contextPayload = await gosAgent.setEditorContextFocus({ path: openPath, line: openLine });
    state.editorContext = contextPayload?.editorContext || state.editorContext;
    renderEditorContext();
    const response = await gosAgent.openLocation({ path: openPath, line: openLine });
    appendChat(`Assistant: ${response.ok ? `opened ${openPath}:${openLine}` : response.message || 'unable to open file'}`);
  });

  elements.validationLog.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const contextPath = target.dataset.contextPath;
    if (contextPath) {
      const payload = await gosAgent.setEditorContextFocus({ path: contextPath, line: 1 });
      state.editorContext = payload?.editorContext || state.editorContext;
      renderEditorContext();
      appendChat(`Assistant: focused desktop context on ${contextPath}.`);
      return;
    }
    const openPath = target.dataset.openPath;
    if (!openPath) {
      return;
    }
    const openLine = Number(target.dataset.openLine || 1);
    const contextPayload = await gosAgent.setEditorContextFocus({ path: openPath, line: openLine });
    state.editorContext = contextPayload?.editorContext || state.editorContext;
    renderEditorContext();
    const response = await gosAgent.openLocation({ path: openPath, line: openLine });
    appendChat(`Assistant: ${response.ok ? `opened ${openPath}:${openLine}` : response.message || 'unable to open file'}`);
  });

  [elements.reviewChangedFiles, elements.reviewFailures, elements.reviewArtifacts].forEach((container) => {
    container?.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const button = target.closest('[data-review-path]');
      if (!(button instanceof HTMLElement)) {
        return;
      }
      const reviewPath = button.dataset.reviewPath;
      const reviewLine = Number(button.dataset.reviewLine || 1);
      const reviewKind = button.dataset.reviewKind || 'files';
      await loadReviewSelection(reviewPath, reviewLine, reviewKind);
    });
  });

  elements.btnRefreshReview?.addEventListener('click', async () => {
    const payload = await gosAgent.getReviewSnapshot({});
    syncReviewFromSnapshot(payload);
    state.editorContext = payload?.editorContext || state.editorContext;
    renderEditorContext();
    await ensureReviewSelection();
    appendChat('Assistant: review queue refreshed.');
  });

  elements.btnReviewTabFile?.addEventListener('click', async () => setReviewTab('file'));
  elements.btnReviewTabDiff?.addEventListener('click', async () => setReviewTab('diff'));

  elements.btnReviewToggleEdit?.addEventListener('click', async () => {
    if (!state.review.selectedPath || state.review.activeTab === 'diff') {
      return;
    }
    state.review.editMode = !state.review.editMode;
    state.review.status = state.review.editMode ? 'Light edit mode enabled.' : 'Read-only preview mode.';
    renderReviewInspector();
  });

  elements.reviewEditor?.addEventListener('input', () => {
    if (state.review.activeTab !== 'file' || !state.review.editMode) {
      return;
    }
    state.review.fileContent = elements.reviewEditor.value;
    state.review.dirty = state.review.fileContent !== state.review.originalContent;
    renderReviewInspector();
  });

  elements.btnReviewSave?.addEventListener('click', async () => {
    if (!state.review.selectedPath || !state.review.dirty || state.review.truncated) {
      return;
    }
    const payload = await gosAgent.saveReviewFile({
      path: state.review.selectedPath,
      line: state.review.selectedLine,
      content: state.review.fileContent,
    });
    if (!payload?.ok) {
      appendChat(`Assistant: ${payload?.message || 'unable to save file.'}`);
      return;
    }
    state.review.originalContent = state.review.fileContent;
    state.review.dirty = false;
    state.review.diffContent = payload.diff || state.review.diffContent;
    state.review.status = 'File saved. Diff updated.';
    appendChat(`Assistant: saved ${state.review.selectedPath}.`);
    await refreshSnapshot();
  });

  elements.btnReviewDiscard?.addEventListener('click', async () => {
    if (!state.review.selectedPath) {
      return;
    }
    state.review.fileContent = state.review.originalContent;
    state.review.dirty = false;
    state.review.status = 'Unsaved edits discarded.';
    renderReviewInspector();
  });

  elements.btnReviewOpenVsCode?.addEventListener('click', async () => {
    if (!state.review.selectedPath) {
      return;
    }
    const response = await gosAgent.openInVsCode({ path: state.review.selectedPath, line: state.review.selectedLine || 1 });
    appendChat(`Assistant: ${response.ok ? `opened ${state.review.selectedPath} in VS Code.` : response.message || 'unable to open in VS Code'}`);
  });

  elements.btnReviewCopyPatch?.addEventListener('click', async () => {
    if (!state.review.selectedPath) {
      return;
    }
    if (!state.review.diffContent) {
      const diffPayload = await gosAgent.getReviewDiff({ path: state.review.selectedPath });
      state.review.diffContent = diffPayload?.diff || '';
    }
    await gosAgent.copyReviewText({ text: state.review.diffContent || '' });
    state.review.status = state.review.diffContent ? 'Patch copied to clipboard.' : 'No diff available to copy.';
    renderReviewInspector();
  });

  const handleDecision = async (status) => {
    if (!state.review.selectedPath) {
      return;
    }
    const payload = await gosAgent.setReviewDecision({
      path: state.review.selectedPath,
      status,
      note: elements.reviewDecisionNote?.value || '',
    });
    if (!payload?.ok) {
      appendChat(`Assistant: ${payload?.message || 'unable to update review decision.'}`);
      return;
    }
    state.review.decisions = payload.review?.decisions || state.review.decisions;
    state.review.changedFiles = payload.review?.changedFiles || state.review.changedFiles;
    state.review.failingLocations = payload.review?.failingLocations || state.review.failingLocations;
    state.review.recentArtifacts = payload.review?.recentArtifacts || state.review.recentArtifacts;
    state.review.status = `Marked ${state.review.selectedPath} as ${status}.`;
    renderReview();
  };

  elements.btnDecisionApprove?.addEventListener('click', async () => handleDecision('approved'));
  elements.btnDecisionDefer?.addEventListener('click', async () => handleDecision('deferred'));
  elements.btnDecisionReject?.addEventListener('click', async () => handleDecision('rejected'));

  document.getElementById('btnRefresh').addEventListener('click', refreshSnapshot);
  document.getElementById('btnPreflight').addEventListener('click', async () => {
    state.preflight = await gosAgent.preflight({ requireGh: !!state.settings.githubEnabled });
    renderPreflight();
    appendChat(`Assistant: preflight ready=${state.preflight.ready} blocking=${state.preflight.blockingCount}.`);
  });
  elements.btnAutopilot.addEventListener('click', async () => {
    const run = await gosAgent.autopilot({ workspace: state.workspaceRoot });
    appendChat(`Assistant: ${run?.runId ? `autopilot run started (${run.runId}).` : 'unable to start autopilot.'}`);
  });
  elements.btnTrain.addEventListener('click', async () => {
    const run = await gosAgent.train({ workspace: state.workspaceRoot });
    appendChat(`Assistant: ${run?.runId ? `training started (${run.runId}).` : 'unable to start training.'}`);
  });
  elements.btnLearn.addEventListener('click', async () => {
    const run = await gosAgent.learn({ workspace: state.workspaceRoot });
    appendChat(`Assistant: ${run?.ok ? 'learn pipeline started (analyze + train).' : run?.message || 'unable to start learn pipeline.'}`);
  });
  elements.btnSchedulerStart.addEventListener('click', async () => {
    const result = await gosAgent.autopilotSchedulerStart({ workspace: state.workspaceRoot });
    appendChat(`Assistant: ${result?.message || (result?.ok ? 'scheduler started.' : 'unable to start scheduler.')}`);
  });
  elements.btnSchedulerStop.addEventListener('click', async () => {
    const result = await gosAgent.autopilotSchedulerStop({});
    appendChat(`Assistant: ${result?.message || (result?.ok ? 'scheduler stopped.' : 'scheduler was not running.')}`);
  });

  document.getElementById('btnReloadSkills').addEventListener('click', loadSkills);
  elements.skillsList.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const skillPath = target.dataset.skillOpen;
    if (!skillPath) {
      return;
    }
    const result = await gosAgent.runSkill({ skillPath, open: true });
    appendChat(`Assistant: ${result.ok ? result.message : result.error}`);
  });

  document.getElementById('btnReloadAutomations').addEventListener('click', loadAutomations);
  document.getElementById('btnSaveAutomation').addEventListener('click', async () => {
    const name = elements.autoName.value.trim();
    const cron = elements.autoCron.value.trim() || '0 * * * *';
    if (!name) {
      appendChat('Assistant: automation name is required.');
      return;
    }
    await gosAgent.upsertAutomation({ name, cron, enabled: elements.autoEnabled.checked });
    appendChat(`Assistant: automation ${name} saved.`);
    await loadAutomations();
  });

  elements.automationsList.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    if (target.dataset.autoRun) {
      const res = await gosAgent.runAutomationNow({ name: target.dataset.autoRun });
      appendChat(`Assistant: ${res.runId ? `automation run started (${res.runId})` : res.message || 'automation run triggered.'}`);
      return;
    }
    if (target.dataset.autoToggle) {
      await gosAgent.toggleAutomation({
        name: target.dataset.autoToggle,
        enabled: target.dataset.enabled === '1',
      });
      await loadAutomations();
      return;
    }
    if (target.dataset.autoDelete) {
      await gosAgent.removeAutomation({ name: target.dataset.autoDelete });
      await loadAutomations();
    }
  });

  document.getElementById('btnCheckUpdates').addEventListener('click', async () => {
    const payload = await gosAgent.checkUpdates({});
    renderUpdatePlan(payload);
  });
  document.getElementById('btnPlanUpdates').addEventListener('click', async () => {
    const payload = await gosAgent.planUpdates({});
    renderUpdatePlan(payload);
  });
  document.getElementById('btnApplyUpdate').addEventListener('click', async () => {
    const payload = await gosAgent.applyUpdates({ confirm: true });
    renderUpdatePlan(payload);
    await loadBackups();
  });
  document.getElementById('btnRollback').addEventListener('click', async () => {
    const backupId = elements.rollbackSelect.value;
    if (!backupId) {
      return;
    }
    const payload = await gosAgent.rollbackUpdates({ backupId });
    renderUpdatePlan(payload);
    await refreshSnapshot();
  });

  document.getElementById('btnPickWorkspace').addEventListener('click', async () => {
    const payload = await gosAgent.pickWorkspace();
    if (payload?.ok) {
      await refreshSnapshot();
      appendChat(`Assistant: workspace set to ${payload.workspaceRoot}`);
    }
  });

  document.getElementById('btnSetWorkspace').addEventListener('click', async () => {
    const root = elements.workspaceInput.value.trim();
    if (!root) {
      return;
    }
    await gosAgent.setWorkspace(root);
    await refreshSnapshot();
    appendChat(`Assistant: workspace set to ${root}`);
  });

  document.getElementById('btnSaveSecret').addEventListener('click', async () => {
    const name = elements.secretName.value.trim();
    const value = elements.secretValue.value;
    if (!name) {
      appendChat('Assistant: secret name is required.');
      return;
    }
    const result = await gosAgent.setSecret(name, value);
    appendChat(`Assistant: ${result.ok ? `secret stored via ${result.backend}.` : result.message}`);
    elements.secretValue.value = '';
  });

  document.getElementById('btnToggleDrawer').addEventListener('click', async () => {
    // when opening drawer, show current key if any
    const resp = await gosAgent.getSecret('OPENAI_API_KEY');
    if (resp.ok && elements.settingOpenaiKey) {
      elements.settingOpenaiKey.value = resp.value || '';
    }
    elements.settingsDrawer.classList.add('open');
  });
  document.getElementById('btnCloseDrawer').addEventListener('click', () => {
    elements.settingsDrawer.classList.remove('open');
  });

  document.getElementById('btnSaveSettings').addEventListener('click', async () => {
    const payload = await gosAgent.updateSettings({
      model: elements.settingModel.value,
      mode: elements.settingMode.value,
      runtime: elements.settingRuntime.value,
      localAiCmd: elements.settingLocalAiCmd.value.trim(),
      githubEnabled: elements.settingGithub.checked,
    });
    state.settings = payload.settings || state.settings;
    // also store openai key if provided
    const keyVal = elements.settingOpenaiKey.value.trim();
    if (keyVal) {
      await gosAgent.setSecret('OPENAI_API_KEY', keyVal);
      appendChat('Assistant: OpenAI key stored securely.');
    }
    appendChat('Assistant: quick controls saved.');
    if (state.settings.localAiCmd) {
      appendChat(`Assistant: Local AI command set to "${state.settings.localAiCmd}".`);
    }
    elements.settingsDrawer.classList.remove('open');
  });

  gosAgent.onRunEvent(onRunEvent);
  gosAgent.onSchedulerEvent((event) => {
    if (!event) {
      return;
    }
    if (event.type === 'state') {
      appendChat(`Scheduler: ${event.message}`);
      return;
    }
    if (event.type === 'log' && event.text) {
      const lines = String(event.text)
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-2)
        .map((line) => `Scheduler log: ${line}`);
      for (const line of lines) {
        appendChat(line);
      }
    }
  });
}

async function init() {
  bindEvents();
  // display version from main process metadata (works in packaged app)
  try {
    const meta = await gosAgent.getMeta();
    const verSpan = document.getElementById('versionLabel');
    if (verSpan) {
      verSpan.textContent = meta?.version ? `v${meta.version}` : '';
    }
  } catch (_e) {}
  await refreshSnapshot();
}

init().catch((error) => {
  appendChat(`Assistant: bootstrap failed - ${error.message || error}`);
});
