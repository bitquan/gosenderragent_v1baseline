'use strict';

const { normalizeTicket } = require('../shared-runtime/runtime');

const DEFAULT_HELP_TEXT =
  'Try: "Plan the next safe coding task", "Review the current repo and tell me what needs fixing first", "Set up the coding model and verify the engine is ready", "/plan 176", "/implement planned", "/repair", "/autopilot", "/approve", "/health", "/app update check", "/train", "/learn", "/status", or "/cancel <runId>".';

const DEFAULT_FALLBACK_TEXT =
  'I can turn English requests into scoped coding work, review diffs, manage approvals, run the engine, and report workspace health. Example: "Plan the next safe coding task."';

const DEFAULT_AI_MISSING_TEXT =
  'No chat backend configured. Start Ollama, set a working LOCAL_AI_CMD, or configure OPENAI_API_KEY.';

function clipText(value, maxChars = 900) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function formatSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return 'Task summary unavailable.';
  }
  return `Board summary: total=${summary.total || 0}, todo=${summary.todo || 0}, done=${summary.done || 0}, tested=${summary.tested || 0}.`;
}

function parseStatusReply(statusPayload) {
  if (!statusPayload) {
    return '';
  }
  if (typeof statusPayload === 'string') {
    return statusPayload;
  }
  if (typeof statusPayload.activeCount === 'number') {
    return `Active runs: ${statusPayload.activeCount}.`;
  }
  if (Array.isArray(statusPayload.activeRuns)) {
    return `Active runs: ${statusPayload.activeRuns.length}.`;
  }
  return '';
}

function parseApprovalQueueReply(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return 'Approval queue is clear.';
  }
  const preview = items
    .slice(0, 3)
    .map((item) => `${item.path}:${item.line} (${item.status})`)
    .join('; ');
  return `Approval queue: ${items.length} item(s). ${preview}`;
}

function isCapabilitiesIntent(lower) {
  return /what can you do|what do you do|capabilities|how can you help|how do i use you|show (me )?examples|what can i ask/.test(
    lower,
  );
}

function normalizeActionReply(result, fallbackText) {
  if (typeof result === 'string') {
    return result;
  }
  if (result && typeof result.message === 'string' && result.message.trim()) {
    return result.message.trim();
  }
  return fallbackText;
}

function normalizeChatHistory(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      role: String(item?.role || 'assistant').trim().toLowerCase(),
      text: String(item?.text || '').trim(),
    }))
    .filter((item) => item.text)
    .slice(-8);
}

function summarizeChatContext(chatContext) {
  const context = chatContext && typeof chatContext === 'object' ? chatContext : {};
  const lines = [];
  if (context.activeFile) {
    lines.push(`Active file: ${context.activeFile}${context.selectionLine ? `:${context.selectionLine}` : ''}`);
  }
  if (context.activeRunLabel || context.activeRunId) {
    lines.push(`Selected run: ${[context.activeRunLabel, context.activeRunId].filter(Boolean).join(' • ')}`);
  }
  if (context.changedFiles !== undefined) {
    lines.push(`Changed files: ${Number(context.changedFiles || 0)}`);
  }
  if (context.approvalCount !== undefined) {
    lines.push(`Pending approvals: ${Number(context.approvalCount || 0)}`);
  }
  if (context.worktree) {
    lines.push(`Worktree: ${context.worktree}`);
  }
  if (context.activeView) {
    lines.push(`Active desktop view: ${context.activeView}`);
  }
  if (context.recentWorkSummary) {
    lines.push(`Recent work: ${String(context.recentWorkSummary).trim()}`);
  }
  if (context.recentWorkWorkedAt) {
    lines.push(`Recent work timestamp: ${String(context.recentWorkWorkedAt).trim()}`);
  }
  if (Array.isArray(context.recentWorkFiles) && context.recentWorkFiles.length > 0) {
    lines.push(`Recent work files: ${context.recentWorkFiles.slice(0, 5).map((item) => String(item || '').trim()).filter(Boolean).join(', ')}`);
  }
  if (Array.isArray(context.openFiles) && context.openFiles.length > 0) {
    lines.push(`Open files: ${context.openFiles.slice(0, 5).map((item) => String(item || '').trim()).filter(Boolean).join(', ')}`);
  }
  if (Array.isArray(context.diagnostics) && context.diagnostics.length > 0) {
    const diagnosticSummary = context.diagnostics
      .slice(0, 3)
      .map((item) => String(item?.message || item?.summary || '').trim())
      .filter(Boolean)
      .join(' | ');
    if (diagnosticSummary) {
      lines.push(`Diagnostics: ${diagnosticSummary}`);
    }
  }
  if (context.surroundingSnippet) {
    lines.push(`Nearby code:\n${clipText(context.surroundingSnippet, 900)}`);
  }
  if (context.currentFileDiff) {
    lines.push(`Current file diff:\n${clipText(context.currentFileDiff, 900)}`);
  }
  if (Array.isArray(context.attachments) && context.attachments.length > 0) {
    const attachmentSummary = context.attachments
      .slice(0, 3)
      .map((item) => {
        const label = String(item?.name || item?.path || 'attachment').trim();
        const dimensions = item?.width && item?.height ? ` (${item.width}x${item.height})` : '';
        return `${label}${dimensions}`;
      })
      .join(', ');
    lines.push(`Attached images: ${attachmentSummary}`);
  }
  if (Array.isArray(context.trustedDocs) && context.trustedDocs.length > 0) {
    const docsSummary = context.trustedDocs
      .slice(0, 2)
      .map((item) => String(item?.title || item?.summary || item?.url || 'trusted doc').trim())
      .filter(Boolean)
      .join(', ');
    if (docsSummary) {
      lines.push(`Trusted docs: ${docsSummary}`);
    }
  }
  if (context.modelProvisioning && typeof context.modelProvisioning === 'object') {
    if (context.modelProvisioning.summary) {
      lines.push(`Model provisioning: ${String(context.modelProvisioning.summary).trim()}`);
    }
    if (context.modelProvisioning.recommendedAction) {
      lines.push(`Provisioning follow-up: ${String(context.modelProvisioning.recommendedAction).trim()}`);
    }
  }
  const chatGuidance = context.chatGuidance && typeof context.chatGuidance === 'object' ? context.chatGuidance : {};
  if (context.chatMode) {
    lines.push(`Chat mode: ${String(context.chatMode).trim()}`);
  }
  if (context.suggestedLaneId || context.suggestedTaskMode) {
    lines.push(
      `Mode route: ${[String(context.suggestedLaneId || '').trim(), String(context.suggestedTaskMode || '').trim()].filter(Boolean).join(' • ')}`,
    );
  }
  if (context.modeAllowsExecution === false) {
    lines.push('Execution: stay conversational unless the operator explicitly switches to an execution-capable mode.');
  }
  if (context.modeRequiresEditConfirmation) {
    lines.push('Edit safety: do not execute code changes until the operator explicitly confirms them.');
  }
  if (chatGuidance.mode && chatGuidance.mode !== 'off') {
    if (chatGuidance.chatMode) {
      lines.push(`Mode guidance: ${String(chatGuidance.chatMode).trim()}`);
    }
    if (chatGuidance.customInstructions) {
      lines.push(`Custom instructions: ${String(chatGuidance.customInstructions).trim()}`);
    }
    if (chatGuidance.autoInstructions) {
      lines.push(`Learned guidance: ${String(chatGuidance.autoInstructions).trim()}`);
    }
    if (Array.isArray(chatGuidance.reusablePrompts) && chatGuidance.reusablePrompts.length > 0) {
      const promptSummary = chatGuidance.reusablePrompts
        .slice(0, 2)
        .map((item) => String(item?.prompt || '').trim())
        .filter(Boolean)
        .join(' | ');
      if (promptSummary) {
        lines.push(`Reusable prompts: ${promptSummary}`);
      }
    }
    if (Array.isArray(chatGuidance.supervisionSignals) && chatGuidance.supervisionSignals.length > 0) {
      const supervisionSummary = chatGuidance.supervisionSignals
        .slice(0, 2)
        .map((item) => `${String(item?.verdict || 'comment').trim()}: ${String(item?.note || '').trim()}`)
        .filter((item) => !/:\s*$/.test(item))
        .join(' | ');
      if (supervisionSummary) {
        lines.push(`Operator supervision: ${supervisionSummary}`);
      }
    }
    if (Array.isArray(chatGuidance.recommendedSources) && chatGuidance.recommendedSources.length > 0) {
      const docsSummary = chatGuidance.recommendedSources
        .slice(0, 2)
        .map((item) => `${String(item?.label || item?.domain || 'trusted docs').trim()}${item?.domain ? ` (${String(item.domain).trim()})` : ''}`)
        .filter(Boolean)
        .join(' | ');
      if (docsSummary) {
        lines.push(`Recommended docs: ${docsSummary}`);
      }
    }
    if (chatGuidance.docsRecommendedAction) {
      lines.push(`Docs follow-up: ${String(chatGuidance.docsRecommendedAction).trim()}`);
    }
    if (chatGuidance.modelProvisioningSummary) {
      lines.push(`Model route health: ${String(chatGuidance.modelProvisioningSummary).trim()}`);
    }
    if (chatGuidance.modelProvisioningAction) {
      lines.push(`Model route next step: ${String(chatGuidance.modelProvisioningAction).trim()}`);
    }
  }
  return lines;
}

function isAiUnavailableReply(value) {
  const text = String(value || '').toLowerCase().trim();
  if (!text) {
    return true;
  }
  return (
    text === '(ai unavailable)' ||
    text.includes('ai unavailable') ||
    text.includes('no local gguf model found') ||
    text.includes('ai command exited with code') ||
    text.includes('ai command failed to start')
  );
}

function normalizeInputText(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r/g, '')
    .trim();
}

function pickAutopilotMode(message, lower) {
  const slashMatch = message.match(/^\/(?:autopilot|auto)(?:\s+(.*))?$/i);
  if (slashMatch) {
    const mode = String(slashMatch[1] || '').trim().toLowerCase();
    if (!mode) {
      return 'once';
    }
    if (/(status|state)/.test(mode)) {
      return 'status';
    }
    if (/(stop|off|disable)/.test(mode)) {
      return 'stop';
    }
    if (/(start|on|enable|schedule)/.test(mode)) {
      return 'start';
    }
    return 'once';
  }

  if (/autopilot/.test(lower)) {
    if (/(status|state)/.test(lower)) {
      return 'status';
    }
    if (/(stop|off|disable)/.test(lower)) {
      return 'stop';
    }
    if (/(start|on|enable|schedule)/.test(lower)) {
      return 'start';
    }
    return 'once';
  }

  return '';
}

function buildCapabilitiesPrompt({ userMessage, summaryText, commandHints, workspaceRoot }) {
  return [
    'You are the GoSenderr desktop coding workbench for this local software workspace.',
    '',
    `Workspace: ${workspaceRoot || '(unknown)'}`,
    `Current board snapshot: ${summaryText}`,
    `Command shortcuts available: ${commandHints}`,
    '',
    `The user asked: "${userMessage}"`,
    '',
    'Respond in this exact structure:',
    '1) "What I can do": 4-6 concise bullets tailored to the coding workbench.',
    '2) "Fast examples": 8 practical prompts they can copy/paste (mix chat + slash commands).',
    '3) "Best next step": 1 recommended next action for today.',
    '',
    'Keep it short, practical, and specific to this workspace. Do not mention being unable unless required.',
  ].join('\n');
}

function buildConversationalPrompt({
  userMessage,
  summaryText,
  commandHints,
  workspaceRoot,
  history,
  chatContext,
}) {
  const historyLines = normalizeChatHistory(history)
    .map((item) => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.text}`);
  const contextLines = summarizeChatContext(chatContext);

  return [
    'You are the GoSenderr desktop coding workbench inside the local desktop app for this software workspace.',
    'Act like a warm, capable pair-programming partner: clear, calm, practical, and grounded in the current repo state.',
    'Answer the way a strong human collaborator would: understand the request, reply directly, and suggest the next step naturally.',
    'Prefer short paragraphs by default. Use bullets only when the content is clearly list-shaped.',
    'Respect the operator guidance and learned prompt patterns when they are present, but do not overfit or become repetitive.',
    'If a slash command or in-app action would help, mention it briefly at the end.',
    'Do not invent completed work, test results, or file edits.',
    '',
    `Workspace: ${workspaceRoot || '(unknown)'}`,
    `Current board snapshot: ${summaryText}`,
    `Available slash commands: ${commandHints}`,
    contextLines.length ? `Live desktop context:\n${contextLines.map((line) => `- ${line}`).join('\n')}` : '',
    historyLines.length ? `Recent conversation:\n${historyLines.join('\n')}` : '',
    `User message: ${userMessage}`,
    '',
    'Reply as a helpful pair-programming assistant for this repository.',
  ].filter(Boolean).join('\n');
}

function pickAppUpdateIntent(message, lower) {
  const slashMatch = message.match(/^\/app(?:lication)?\s+update(?:\s+(check|status|download|install))?$/i);
  if (slashMatch) {
    return String(slashMatch[1] || 'smart').trim().toLowerCase();
  }

  if (/(install|apply)\s+(?:the\s+)?(?:app|desktop)\s+(?:update|release)/i.test(message)) {
    return 'install';
  }
  if (/download\s+(?:the\s+)?(?:app|desktop)\s+(?:update|release)/i.test(message)) {
    return 'download';
  }
  if (/(check|status).*(?:app|desktop).*(?:update|release)|(?:app|desktop).*(?:update|release).*(check|status)/i.test(message)) {
    return /(status)/i.test(message) ? 'status' : 'check';
  }
  if (/(?:update|upgrade).*(?:app|desktop)|(?:app|desktop).*(?:update|upgrade)/.test(lower)) {
    return 'smart';
  }
  return '';
}

function isBinaryUpdateReady(status) {
  return !!(status && (status.downloaded || status.localStaged));
}

function isBinaryUpdateAvailable(status) {
  return !!(status && ['available', 'downloaded', 'downloading'].includes(String(status.state || '').toLowerCase()));
}

async function handleCapabilitiesReply(workspaceRoot, message, callbacks) {
  const commandHints = callbacks.helpText || DEFAULT_HELP_TEXT;
  let summaryText = 'BAT summary unavailable.';
  if (typeof callbacks.getSummary === 'function') {
    try {
      const summary = await callbacks.getSummary(workspaceRoot);
      summaryText = formatSummary(summary);
    } catch (_err) {
      // keep fallback summary text
    }
  }

  if (typeof callbacks.runAi === 'function') {
    if (typeof callbacks.hasAiKey === 'function') {
      const hasKey = await callbacks.hasAiKey();
      if (!hasKey) {
        return callbacks.aiMissingMessage || DEFAULT_AI_MISSING_TEXT;
      }
    }
    const aiPrompt = buildCapabilitiesPrompt({
      userMessage: message,
      summaryText,
      commandHints,
      workspaceRoot,
    });
    const aiText = await callbacks.runAi(workspaceRoot, aiPrompt);
    if (aiText && !isAiUnavailableReply(aiText)) {
      return String(aiText);
    }
  }

  return [
    'What I can do:',
    '- Turn plain-English coding requests into scoped goals, tasks, and runs.',
    '- Review diffs, changed files, and approval queues in this workspace.',
    '- Run engine, learn, self-improve, and benchmark flows safely.',
    '- Report status and active runs (`/status`, `/cancel <runId>`).',
    '- Help with code fixes, architecture, and debugging chat.',
    '',
    `Fast examples: ${commandHints}`,
  ].join('\n');
}

async function handleSingle(workspaceRoot, rawMessage, callbacks) {
  const message = normalizeInputText(rawMessage);
  if (!message) {
    return 'Please enter a message.';
  }

  const lower = message.toLowerCase();

  const cancelMatch = message.match(/^\/cancel\s+([a-zA-Z0-9_.-]+)/i);
  if (cancelMatch) {
    if (typeof callbacks.cancelRun === 'function') {
      const result = await callbacks.cancelRun(cancelMatch[1]);
      if (typeof result === 'string') {
        return result;
      }
      if (result && result.ok === true) {
        return 'Cancel signal sent.';
      }
      return (result && result.message) || 'Unable to cancel run.';
    }
    return 'Cancel is not available in this host.';
  }

  if (/^\/open\s+run/i.test(message)) {
    if (typeof callbacks.openRunPanel === 'function') {
      await callbacks.openRunPanel();
      return 'Opened run panel.';
    }
    return 'Run panel is not available in this host.';
  }

  if (/^\/status\b/i.test(message) || /^(status|summary|health)$/i.test(lower)) {
    if (typeof callbacks.getManagerStatus === 'function') {
      const statusText = await callbacks.getManagerStatus(workspaceRoot);
      if (statusText) {
        return String(statusText);
      }
    }
    if (typeof callbacks.getStatus === 'function') {
      const statusPayload = await callbacks.getStatus();
      const text = parseStatusReply(statusPayload);
      if (text) {
        return text;
      }
    }
    if (typeof callbacks.getSummary === 'function') {
      const summary = await callbacks.getSummary(workspaceRoot);
      return formatSummary(summary);
    }
    return 'Status is not available.';
  }

  if (
    /^\/(health|dashboard)\b/i.test(message) ||
    /^(dashboard|health dashboard|manager health|what is happening|what's happening)$/i.test(lower)
  ) {
    if (typeof callbacks.getManagerStatus === 'function') {
      return String((await callbacks.getManagerStatus(workspaceRoot)) || 'Manager status unavailable.');
    }
    return 'Manager status is not available in this host.';
  }

  if (/^\/workers\b/i.test(message) || /^(workers|worker status|who is working)$/i.test(lower)) {
    if (typeof callbacks.getWorkerStatus === 'function') {
      return String((await callbacks.getWorkerStatus(workspaceRoot)) || 'Workers are idle.');
    }
    return 'Worker status is not available in this host.';
  }

  if (/^\/(approvals|approval)\b/i.test(message) || /^(show approvals|approval queue|pending approvals)$/i.test(lower)) {
    if (typeof callbacks.getApprovalQueue === 'function') {
      const queue = await callbacks.getApprovalQueue(workspaceRoot);
      return parseApprovalQueueReply(queue);
    }
    return 'Approval queue is not available in this host.';
  }

  if (/^\/approve\b/i.test(message) || /^(approve|approve this|approve this patch|approve selected)$/i.test(lower)) {
    if (typeof callbacks.approveSelection === 'function') {
      const batMatch = message.match(/BAT<(\d+)>/i);
      const target = batMatch ? { ticket: batMatch[1] } : undefined;
      return String((await callbacks.approveSelection(workspaceRoot, target)) || 'Approved current review item.');
    }
    return 'Approve is not available in this host.';
  }

  if (/^\/reject\b/i.test(message) || /^(reject|reject this|reject this patch)$/i.test(lower)) {
    if (typeof callbacks.rejectSelection === 'function') {
      return String((await callbacks.rejectSelection(workspaceRoot)) || 'Rejected current review item.');
    }
    return 'Reject is not available in this host.';
  }

  if (/^\/defer\b/i.test(message) || /^(defer|defer this|defer this patch)$/i.test(lower)) {
    if (typeof callbacks.deferSelection === 'function') {
      return String((await callbacks.deferSelection(workspaceRoot)) || 'Deferred current review item.');
    }
    return 'Defer is not available in this host.';
  }

  if (/^\/stop\b/i.test(message) || /^(stop|stop run|stop autopilot)$/i.test(lower)) {
    if (typeof callbacks.stop === 'function') {
      const out = await callbacks.stop(workspaceRoot);
      return String(out || 'Stop signal sent.');
    }
    return 'Stop is not available in this host.';
  }

  if (/^\/help\b/i.test(message) || /^(help|commands|show commands|command list)$/i.test(lower)) {
    return callbacks.helpText || DEFAULT_HELP_TEXT;
  }

  const appUpdateIntent = pickAppUpdateIntent(message, lower);
  if (appUpdateIntent) {
    const currentStatus = typeof callbacks.getBinaryUpdateStatus === 'function'
      ? await callbacks.getBinaryUpdateStatus(workspaceRoot)
      : null;

    if (appUpdateIntent === 'status') {
      return normalizeActionReply(currentStatus, 'Desktop app update status is unavailable.');
    }

    if (appUpdateIntent === 'check') {
      if (typeof callbacks.checkBinaryUpdate === 'function') {
        const result = await callbacks.checkBinaryUpdate(workspaceRoot);
        return normalizeActionReply(result, 'Desktop app update check finished.');
      }
      return normalizeActionReply(currentStatus, 'Desktop app update checks are not available in this host.');
    }

    if (appUpdateIntent === 'download') {
      if (typeof callbacks.downloadBinaryUpdate === 'function') {
        const result = await callbacks.downloadBinaryUpdate(workspaceRoot);
        return normalizeActionReply(result, 'Desktop app update download started.');
      }
      return 'Desktop app update downloads are not available in this host.';
    }

    if (appUpdateIntent === 'install') {
      let nextStatus = currentStatus;
      if (!isBinaryUpdateReady(nextStatus) && typeof callbacks.checkBinaryUpdate === 'function') {
        nextStatus = await callbacks.checkBinaryUpdate(workspaceRoot);
      }
      if (!isBinaryUpdateReady(nextStatus) && isBinaryUpdateAvailable(nextStatus) && typeof callbacks.downloadBinaryUpdate === 'function') {
        nextStatus = await callbacks.downloadBinaryUpdate(workspaceRoot);
      }
      if (isBinaryUpdateReady(nextStatus) && typeof callbacks.installBinaryUpdate === 'function') {
        const result = await callbacks.installBinaryUpdate(workspaceRoot);
        return normalizeActionReply(result, 'Installing the desktop app update.');
      }
      return normalizeActionReply(nextStatus, 'No downloaded desktop app update is ready to install.');
    }

    if (isBinaryUpdateReady(currentStatus) && typeof callbacks.installBinaryUpdate === 'function') {
      const result = await callbacks.installBinaryUpdate(workspaceRoot);
      return normalizeActionReply(result, 'Installing the desktop app update.');
    }

    if (typeof callbacks.checkBinaryUpdate === 'function') {
      const checked = await callbacks.checkBinaryUpdate(workspaceRoot);
      if (isBinaryUpdateAvailable(checked) && typeof callbacks.downloadBinaryUpdate === 'function') {
        const downloaded = await callbacks.downloadBinaryUpdate(workspaceRoot);
        return normalizeActionReply(downloaded, normalizeActionReply(checked, 'Desktop app update is available.'));
      }
      return normalizeActionReply(checked, 'Desktop app update check finished.');
    }

    return normalizeActionReply(currentStatus, 'Desktop app update controls are not available in this host.');
  }

  if (/^\/next\b/i.test(message) || /^(next|next task|what('?s| is) next)$/i.test(lower)) {
    if (typeof callbacks.next === 'function') {
      const out = await callbacks.next(workspaceRoot);
      return String(out || 'No next task found.');
    }
    return 'Next-task lookup is not available in this host.';
  }

  if (/^\/repair\b/i.test(message) || /^(repair|repair last|fix last fail(ure)?)$/i.test(lower)) {
    if (typeof callbacks.repair === 'function') {
      const out = await callbacks.repair(workspaceRoot);
      return String(out || 'No failed run to repair.');
    }
    return 'Repair is not available in this host.';
  }

  if (/^\/files\b/i.test(message) || /^(files|changed files|show files)$/i.test(lower)) {
    if (typeof callbacks.files === 'function') {
      const out = await callbacks.files(workspaceRoot);
      return String(out || 'No changed files.');
    }
    return 'File summary is not available in this host.';
  }

  if (/^\/audit\b/i.test(message) || /^(audit|toggle audit)$/i.test(lower)) {
    if (typeof callbacks.auditToggle === 'function') {
      const out = await callbacks.auditToggle(workspaceRoot);
      return String(out || 'Audit toggle updated.');
    }
    return 'Audit toggle is not available in this host.';
  }

  const autopilotMode = pickAutopilotMode(message, lower);
  if (autopilotMode) {
    if (autopilotMode === 'status') {
      if (typeof callbacks.autopilotSchedulerStatus === 'function') {
        const out = await callbacks.autopilotSchedulerStatus(workspaceRoot);
        return String(out || 'Autopilot scheduler status unavailable.');
      }
      return 'Autopilot scheduler status is not available in this host.';
    }
    if (autopilotMode === 'stop') {
      if (typeof callbacks.autopilotSchedulerStop === 'function') {
        const out = await callbacks.autopilotSchedulerStop(workspaceRoot);
        return String(out || 'Autopilot scheduler stopped.');
      }
      return 'Autopilot scheduler controls are not available in this host.';
    }
    if (autopilotMode === 'start') {
      if (typeof callbacks.autopilotSchedulerStart === 'function') {
        const out = await callbacks.autopilotSchedulerStart(workspaceRoot);
        return String(out || 'Autopilot scheduler started.');
      }
      return 'Autopilot scheduler controls are not available in this host.';
    }
    if (typeof callbacks.runAutopilot === 'function') {
      const out = await callbacks.runAutopilot(workspaceRoot);
      return String(out || 'Started autopilot run.');
    }
    return 'Autopilot is not available in this host.';
  }

  if (
    /^\/train\b/i.test(message) ||
    /^(train|retrain|train assistant|generate training data)$/i.test(lower)
  ) {
    if (typeof callbacks.runTrain === 'function') {
      const out = await callbacks.runTrain(workspaceRoot);
      return String(out || 'Started training run.');
    }
    return 'Training is not available in this host.';
  }

  if (
    /^\/learn\b/i.test(message) ||
    /^(learn|learn now|refresh learning|analyze and train|learn pipeline)$/i.test(lower)
  ) {
    if (typeof callbacks.runLearn === 'function') {
      const out = await callbacks.runLearn(workspaceRoot);
      return String(out || 'Started learn pipeline.');
    }
    return 'Learn pipeline is not available in this host.';
  }

  if (/^\/self-improve\b/i.test(message) || /^(self improve|self-improve)$/i.test(lower)) {
    if (typeof callbacks.runSelfImprove === 'function') {
      const out = await callbacks.runSelfImprove(workspaceRoot);
      return String(out || 'Started self-improve run.');
    }
    return 'Self-improve is not available in this host.';
  }

  if (isCapabilitiesIntent(lower)) {
    return handleCapabilitiesReply(workspaceRoot, message, callbacks);
  }

  if (/run next 5 todo|^\/batch\s+run\b|batch run/i.test(lower)) {
    if (typeof callbacks.runBatchRun === 'function') {
      await callbacks.runBatchRun(workspaceRoot);
      return callbacks.batchRunReply || 'Started batch run for next 5 TODO BATs.';
    }
    return 'Batch run is not available in this host.';
  }

  if (/implement next 3 be|^\/batch\s+implement\b|batch implement/i.test(lower)) {
    if (typeof callbacks.runBatchImplement === 'function') {
      await callbacks.runBatchImplement(workspaceRoot);
      return callbacks.batchImplementReply || 'Started batch implement for next 3 TODO [BE] BATs.';
    }
    return 'Batch implement is not available in this host.';
  }

  if (/^\/implement\s+planned\b/i.test(message)) {
    if (typeof callbacks.implementPlanned === 'function') {
      const out = await callbacks.implementPlanned(workspaceRoot);
      return String(out || 'Started implement for planned BAT.');
    }
    return 'Implement-planned action is not available in this host.';
  }

  const slashPlan = message.match(/^\/plan\s+(\d+)/i);
  if (slashPlan) {
    if (typeof callbacks.planTicket === 'function') {
      const ticket = normalizeTicket(slashPlan[1]);
      await callbacks.planTicket({ workspaceRoot, ticket });
      return `Started plan for BAT<${ticket}>.`;
    }
    return 'Plan action is not available in this host.';
  }

  const slashImplement = message.match(/^\/implement\s+(\d+)/i);
  if (slashImplement) {
    if (typeof callbacks.runTicket === 'function') {
      const ticket = normalizeTicket(slashImplement[1]);
      await callbacks.runTicket({ workspaceRoot, ticket, implement: true });
      return `Started implement for BAT<${ticket}>.`;
    }
    return 'Implement action is not available in this host.';
  }

  const slashRun = message.match(/^\/run\s+(\d+)/i);
  if (slashRun) {
    if (typeof callbacks.runTicket === 'function') {
      const ticket = normalizeTicket(slashRun[1]);
      await callbacks.runTicket({ workspaceRoot, ticket, implement: false });
      return `Started run for BAT<${ticket}>.`;
    }
    return 'Run action is not available in this host.';
  }

  const ticket = normalizeTicket(message);
  if (ticket && /plan/.test(lower)) {
    if (typeof callbacks.planTicket === 'function') {
      await callbacks.planTicket({ workspaceRoot, ticket });
      return `Started plan for BAT<${ticket}>.`;
    }
  }
  if (ticket && /implement/.test(lower)) {
    if (typeof callbacks.runTicket === 'function') {
      await callbacks.runTicket({ workspaceRoot, ticket, implement: true });
      return `Started implement for BAT<${ticket}>.`;
    }
  }
  if (ticket && /run|scaffold|start/.test(lower)) {
    if (typeof callbacks.runTicket === 'function') {
      await callbacks.runTicket({ workspaceRoot, ticket, implement: false });
      return `Started run for BAT<${ticket}>.`;
    }
  }

  if (message.startsWith('/')) {
    return `Unknown command. ${callbacks.helpText || DEFAULT_HELP_TEXT}`;
  }

  if (typeof callbacks.runAi === 'function') {
    if (typeof callbacks.hasAiKey === 'function') {
      const hasKey = await callbacks.hasAiKey();
      if (!hasKey) {
        return callbacks.aiMissingMessage || DEFAULT_AI_MISSING_TEXT;
      }
    }
    let summaryText = 'BAT summary unavailable.';
    if (typeof callbacks.getSummary === 'function') {
      try {
        const summary = await callbacks.getSummary(workspaceRoot);
        summaryText = formatSummary(summary);
      } catch (_err) {
        // keep fallback summary text
      }
    }
    const aiPrompt = buildConversationalPrompt({
      userMessage: message,
      summaryText,
      commandHints: callbacks.helpText || DEFAULT_HELP_TEXT,
      workspaceRoot,
      history: callbacks.chatHistory,
      chatContext: callbacks.chatContext,
    });
    const aiText = await callbacks.runAi(workspaceRoot, aiPrompt);
    if (aiText && !isAiUnavailableReply(aiText)) {
      return String(aiText);
    }
  }

  const fallback = callbacks.fallbackText || DEFAULT_FALLBACK_TEXT;
  return `${fallback} Configure Ollama, a working LOCAL_AI_CMD, or OPENAI_API_KEY for free-form chat replies.`;
}

async function handleAssistantChat(workspaceRoot, rawText, callbacks = {}) {
  const message = normalizeInputText(rawText);
  if (!message) {
    return 'Please enter a message.';
  }

  const newlineParts = message
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (newlineParts.length > 1) {
    const responses = [];
    for (const part of newlineParts) {
      // eslint-disable-next-line no-await-in-loop
      const out = await handleSingle(workspaceRoot, part, callbacks);
      if (out) {
        responses.push(out);
      }
    }
    return responses.join(' ');
  }

  const actionSplitHint =
    /(^|\s)(\/run|\/implement|\/batch|run\s+bat|implement\s+bat|run\s+next|implement\s+next)/i.test(message);
  if (/\band\b/i.test(message) && actionSplitHint) {
    const parts = message
      .split(/\band\b/i)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length > 1) {
      const responses = [];
      for (const part of parts) {
        // eslint-disable-next-line no-await-in-loop
        const out = await handleSingle(workspaceRoot, part, callbacks);
        if (out) {
          responses.push(out);
        }
      }
      return responses.join(' ');
    }
  }

  return handleSingle(workspaceRoot, message, callbacks);
}

module.exports = {
  handleAssistantChat,
};
