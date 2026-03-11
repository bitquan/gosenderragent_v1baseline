'use strict';

const { normalizeTicket } = require('../shared-runtime/runtime');

const DEFAULT_HELP_TEXT =
  'Try: "run BAT 176", "implement BAT 176", "/batch run", "/batch implement", "/next", "/repair", "/files", "/audit", "/autopilot", "/autopilot start", "/autopilot stop", "/stop", "/train", "/learn", "/status", or "/cancel <runId>".';

const DEFAULT_FALLBACK_TEXT =
  'I can run/implement BATs, batch TODOs, and report BAT status. Example: "implement BAT 176".';

const DEFAULT_AI_MISSING_TEXT =
  'AI key not configured. Set OPENAI_API_KEY in environment or assistant settings.';

function formatSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return 'BAT summary unavailable.';
  }
  return `BAT summary: total=${summary.total || 0}, todo=${summary.todo || 0}, done=${summary.done || 0}, tested=${summary.tested || 0}.`;
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

function isCapabilitiesIntent(lower) {
  return /what can you do|what do you do|capabilities|how can you help|how do i use you|show (me )?examples|what can i ask/.test(
    lower,
  );
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
    'You are the GoSenderr Dev Assistant for this local software workspace.',
    '',
    `Workspace: ${workspaceRoot || '(unknown)'}`,
    `Current BAT snapshot: ${summaryText}`,
    `Command shortcuts available: ${commandHints}`,
    '',
    `The user asked: "${userMessage}"`,
    '',
    'Respond in this exact structure:',
    '1) "What I can do": 4-6 concise bullets tailored to GoSenderr BAT workflows.',
    '2) "Fast examples": 8 practical prompts they can copy/paste (mix chat + slash commands).',
    '3) "Best next step": 1 recommended next action for today.',
    '',
    'Keep it short, practical, and specific to this workspace. Do not mention being unable unless required.',
  ].join('\n');
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
    '- Run and implement BAT tickets in this workspace.',
    '- Execute batch flows (`/batch run`, `/batch implement`).',
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
    const aiText = await callbacks.runAi(workspaceRoot, message);
    if (aiText && !isAiUnavailableReply(aiText)) {
      return String(aiText);
    }
  }

  const fallback = callbacks.fallbackText || DEFAULT_FALLBACK_TEXT;
  return `${fallback} Configure OpenAI key or LOCAL_AI_CMD in Controls for free-form chat replies.`;
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
