'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SAFE_BLOCKED_TAGS = ['SEC', 'AUTH', 'PAYMENT', 'MIGRATION', 'WALLET'];
const DEFAULT_SAFE_BLOCKED_DOMAINS = ['payments'];
const DEFAULT_SAFE_BLOCKED_TERMS = ['auth', 'payment', 'wallet', 'network pool', 'security', 'migration'];
const ASSISTANT_AUTONOMY_KEY_MAP = {
  safeMode: 'assistant_safe_mode',
  safetyLevel: 'assistant_safety_level',
  autonomyMode: 'assistant_autonomy_mode',
  autoSynthesizeBats: 'assistant_auto_synthesize_bats',
  autoRetryUntilPass: 'assistant_auto_retry_until_pass',
  autoBrainstormOnFailure: 'assistant_auto_brainstorm_on_failure',
  autoApproveLowRisk: 'assistant_auto_approve_low_risk',
  humanApprovalProtectedOnly: 'assistant_human_approval_protected_only',
  sandboxRequired: 'assistant_sandbox_required',
  baselineSelfHealPriority: 'assistant_baseline_self_heal_priority',
  supervisedAutoRunRecipes: 'assistant_supervised_auto_run_recipes',
  autoQueueTaskLoopFollowups: 'assistant_auto_queue_task_loop_followups',
  autoRunQueuedTaskLoopFollowups: 'assistant_auto_run_queued_task_loop_followups',
  maxRetryRounds: 'assistant_max_retry_rounds',
};
const ASSISTANT_MODEL_PROFILE_KEY_MAP = {
  modelProfileId: 'assistant_model_profile_id',
  modelDisplayName: 'assistant_model_display_name',
  baseModel: 'assistant_model_base_model',
  baseProvider: 'assistant_model_base_provider',
  providerSource: 'assistant_model_provider_source',
  workspaceModelProfileId: 'assistant_workspace_model_profile_id',
  workspaceModelDisplayName: 'assistant_workspace_model_display_name',
  workspaceBaseModel: 'assistant_workspace_model_base_model',
  workspaceBaseProvider: 'assistant_workspace_model_base_provider',
  workspaceProviderSource: 'assistant_workspace_model_provider_source',
  engineModelProfileId: 'assistant_engine_model_profile_id',
  engineModelDisplayName: 'assistant_engine_model_display_name',
  engineBaseModel: 'assistant_engine_model_base_model',
  engineBaseProvider: 'assistant_engine_model_base_provider',
  engineProviderSource: 'assistant_engine_model_provider_source',
  plannerProvider: 'assistant_task_mode_planner_provider',
  plannerModel: 'assistant_task_mode_planner_model',
  coderProvider: 'assistant_task_mode_coder_provider',
  coderModel: 'assistant_task_mode_coder_model',
  validatorProvider: 'assistant_task_mode_validator_provider',
  validatorModel: 'assistant_task_mode_validator_model',
  summarizerProvider: 'assistant_task_mode_summarizer_provider',
  summarizerModel: 'assistant_task_mode_summarizer_model',
};

function configPathForWorkspace(workspaceRoot, options = {}) {
  const defaultWorkspace = options.defaultWorkspace || '';
  return path.join(workspaceRoot || defaultWorkspace, 'dev_assistant.yaml');
}

function localConfigPathForWorkspace(workspaceRoot, options = {}) {
  const defaultWorkspace = options.defaultWorkspace || '';
  return path.join(workspaceRoot || defaultWorkspace, 'dev_assistant.local.yaml');
}

function parseAssistantConfigScalar(raw) {
  const text = String(raw || '').split('#')[0].trim();
  if (!text) {
    return '';
  }
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function parseAssistantConfigBoolean(raw, fallback = false) {
  if (typeof raw === 'boolean') {
    return raw;
  }
  const text = String(raw || '').trim().toLowerCase();
  if (!text) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(text)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(text)) {
    return false;
  }
  return fallback;
}

function readAssistantConfig(workspaceRoot, options = {}) {
  const defaultWorkspace = options.defaultWorkspace || '';
  const config = {
    autopilotAction: '',
    autopilotCount: null,
    autopilotStatus: '',
    autopilotProfile: '',
    autopilotRequireTag: '',
    safeMode: false,
    safeBlockedTags: [...DEFAULT_SAFE_BLOCKED_TAGS],
    safeBlockedDomains: [...DEFAULT_SAFE_BLOCKED_DOMAINS],
    safeBlockedTerms: [...DEFAULT_SAFE_BLOCKED_TERMS],
    safetyLevel: '',
    autonomyMode: '',
    autoSynthesizeBats: null,
    autoRetryUntilPass: null,
    autoBrainstormOnFailure: null,
    autoApproveLowRisk: null,
    humanApprovalProtectedOnly: null,
    sandboxRequired: null,
    baselineSelfHealPriority: null,
    autoQueueTaskLoopFollowups: null,
    autoRunQueuedTaskLoopFollowups: null,
    maxRetryRounds: null,
    selfImprovementOnly: null,
    dailySafeAutonomousTarget: 5,
    dailySelfImprovementTarget: 5,
    modelProfileId: '',
    modelDisplayName: '',
    baseModel: '',
    baseProvider: '',
    providerSource: '',
    workspaceModelProfileId: '',
    workspaceModelDisplayName: '',
    workspaceBaseModel: '',
    workspaceBaseProvider: '',
    workspaceProviderSource: '',
    engineModelProfileId: '',
    engineModelDisplayName: '',
    engineBaseModel: '',
    engineBaseProvider: '',
    engineProviderSource: '',
    taskModeRoutes: {
      planner: { provider: '', model: '' },
      coder: { provider: '', model: '' },
      validator: { provider: '', model: '' },
      summarizer: { provider: '', model: '' },
    },
  };

  try {
    const listKeys = new Set([
      'assistant_safe_blocked_tags',
      'assistant_safe_blocked_domains',
      'assistant_safe_blocked_terms',
    ]);
    for (const configPath of [configPathForWorkspace(workspaceRoot, options), localConfigPathForWorkspace(workspaceRoot, options)]) {
      if (!fs.existsSync(configPath)) {
        continue;
      }
      const lines = fs.readFileSync(configPath, 'utf8').split(/\r?\n/);
      let activeListKey = '';
      for (const rawLine of lines) {
        const line = String(rawLine || '').split('#')[0].replace(/\t/g, '    ');
        const listMatch = activeListKey ? line.match(/^\s*-\s*(.+)$/) : null;
        if (listMatch) {
          const value = parseAssistantConfigScalar(listMatch[1]);
          if (value) {
            if (activeListKey === 'assistant_safe_blocked_tags') {
              config.safeBlockedTags.push(String(value).toUpperCase());
            } else if (activeListKey === 'assistant_safe_blocked_domains') {
              config.safeBlockedDomains.push(String(value).toLowerCase());
            } else if (activeListKey === 'assistant_safe_blocked_terms') {
              config.safeBlockedTerms.push(String(value).toLowerCase());
            }
          }
          continue;
        }
        const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
        if (!match) {
          if (/^\S/.test(line)) {
            activeListKey = '';
          }
          continue;
        }
        activeListKey = '';
        const key = match[1];
        const value = parseAssistantConfigScalar(match[2]);
        if (key === 'autopilot_action') {
          config.autopilotAction = String(value || '').toLowerCase();
        } else if (key === 'autopilot_count') {
          const count = Number.parseInt(String(value || ''), 10);
          config.autopilotCount = Number.isFinite(count) ? count : null;
        } else if (key === 'autopilot_status') {
          config.autopilotStatus = value;
        } else if (key === 'autopilot_profile') {
          config.autopilotProfile = value;
        } else if (key === 'autopilot_require_tag') {
          config.autopilotRequireTag = value;
        } else if (key === 'assistant_safe_mode') {
          config.safeMode = parseAssistantConfigBoolean(value, false);
        } else if (key === 'assistant_autonomy_mode') {
          config.autonomyMode = String(value || '').toLowerCase();
        } else if (key === 'assistant_safety_level') {
          config.safetyLevel = String(value || '').toLowerCase();
        } else if (key === 'assistant_auto_synthesize_bats') {
          config.autoSynthesizeBats = parseAssistantConfigBoolean(value, null);
        } else if (key === 'assistant_auto_retry_until_pass') {
          config.autoRetryUntilPass = parseAssistantConfigBoolean(value, null);
        } else if (key === 'assistant_auto_brainstorm_on_failure') {
          config.autoBrainstormOnFailure = parseAssistantConfigBoolean(value, null);
        } else if (key === 'assistant_auto_approve_low_risk') {
          config.autoApproveLowRisk = parseAssistantConfigBoolean(value, null);
        } else if (key === 'assistant_human_approval_protected_only') {
          config.humanApprovalProtectedOnly = parseAssistantConfigBoolean(value, null);
        } else if (key === 'assistant_sandbox_required') {
          config.sandboxRequired = parseAssistantConfigBoolean(value, null);
        } else if (key === 'assistant_baseline_self_heal_priority') {
          config.baselineSelfHealPriority = parseAssistantConfigBoolean(value, null);
        } else if (key === 'assistant_auto_queue_task_loop_followups') {
          config.autoQueueTaskLoopFollowups = parseAssistantConfigBoolean(value, null);
        } else if (key === 'assistant_auto_run_queued_task_loop_followups') {
          config.autoRunQueuedTaskLoopFollowups = parseAssistantConfigBoolean(value, null);
        } else if (key === 'assistant_max_retry_rounds') {
          const rounds = Number.parseInt(String(value || ''), 10);
          config.maxRetryRounds = Number.isFinite(rounds) ? rounds : null;
        } else if (key === 'assistant_self_improvement_only') {
          config.selfImprovementOnly = parseAssistantConfigBoolean(value, null);
        } else if (key === 'assistant_daily_safe_autonomous_target') {
          const target = Number.parseInt(String(value || ''), 10);
          config.dailySafeAutonomousTarget = Number.isFinite(target) && target > 0 ? target : 5;
        } else if (key === 'assistant_daily_self_improvement_target') {
          const target = Number.parseInt(String(value || ''), 10);
          config.dailySelfImprovementTarget = Number.isFinite(target) && target > 0 ? target : 5;
        } else if (key === 'assistant_model_profile_id') {
          config.modelProfileId = String(value || '').trim();
        } else if (key === 'assistant_model_display_name') {
          config.modelDisplayName = String(value || '').trim();
        } else if (key === 'assistant_model_base_model') {
          config.baseModel = String(value || '').trim();
        } else if (key === 'assistant_model_base_provider') {
          config.baseProvider = String(value || '').trim().toLowerCase();
        } else if (key === 'assistant_model_provider_source') {
          config.providerSource = String(value || '').trim().toLowerCase();
        } else if (key === 'assistant_workspace_model_profile_id') {
          config.workspaceModelProfileId = String(value || '').trim();
        } else if (key === 'assistant_workspace_model_display_name') {
          config.workspaceModelDisplayName = String(value || '').trim();
        } else if (key === 'assistant_workspace_model_base_model') {
          config.workspaceBaseModel = String(value || '').trim();
        } else if (key === 'assistant_workspace_model_base_provider') {
          config.workspaceBaseProvider = String(value || '').trim().toLowerCase();
        } else if (key === 'assistant_workspace_model_provider_source') {
          config.workspaceProviderSource = String(value || '').trim().toLowerCase();
        } else if (key === 'assistant_engine_model_profile_id') {
          config.engineModelProfileId = String(value || '').trim();
        } else if (key === 'assistant_engine_model_display_name') {
          config.engineModelDisplayName = String(value || '').trim();
        } else if (key === 'assistant_engine_model_base_model') {
          config.engineBaseModel = String(value || '').trim();
        } else if (key === 'assistant_engine_model_base_provider') {
          config.engineBaseProvider = String(value || '').trim().toLowerCase();
        } else if (key === 'assistant_engine_model_provider_source') {
          config.engineProviderSource = String(value || '').trim().toLowerCase();
        } else if (key === 'assistant_task_mode_planner_provider') {
          config.taskModeRoutes.planner.provider = String(value || '').trim().toLowerCase();
        } else if (key === 'assistant_task_mode_planner_model') {
          config.taskModeRoutes.planner.model = String(value || '').trim();
        } else if (key === 'assistant_task_mode_coder_provider') {
          config.taskModeRoutes.coder.provider = String(value || '').trim().toLowerCase();
        } else if (key === 'assistant_task_mode_coder_model') {
          config.taskModeRoutes.coder.model = String(value || '').trim();
        } else if (key === 'assistant_task_mode_validator_provider') {
          config.taskModeRoutes.validator.provider = String(value || '').trim().toLowerCase();
        } else if (key === 'assistant_task_mode_validator_model') {
          config.taskModeRoutes.validator.model = String(value || '').trim();
        } else if (key === 'assistant_task_mode_summarizer_provider') {
          config.taskModeRoutes.summarizer.provider = String(value || '').trim().toLowerCase();
        } else if (key === 'assistant_task_mode_summarizer_model') {
          config.taskModeRoutes.summarizer.model = String(value || '').trim();
        } else if (listKeys.has(key)) {
          activeListKey = key;
          if (key === 'assistant_safe_blocked_tags') {
            config.safeBlockedTags = [];
          } else if (key === 'assistant_safe_blocked_domains') {
            config.safeBlockedDomains = [];
          } else if (key === 'assistant_safe_blocked_terms') {
            config.safeBlockedTerms = [];
          }
        }
      }
    }
  } catch (_err) {
    return config;
  }

  config.safeBlockedTags = Array.from(new Set(config.safeBlockedTags.map((item) => String(item || '').toUpperCase()).filter(Boolean)));
  config.safeBlockedDomains = Array.from(new Set(config.safeBlockedDomains.map((item) => String(item || '').toLowerCase()).filter(Boolean)));
  config.safeBlockedTerms = Array.from(new Set(config.safeBlockedTerms.map((item) => String(item || '').toLowerCase()).filter(Boolean)));
  if (config.selfImprovementOnly === null && config.autonomyMode === 'self') {
    config.selfImprovementOnly = true;
  }
  if (!config.workspaceModelProfileId) {
    config.workspaceModelProfileId = config.modelProfileId;
    config.workspaceModelDisplayName = config.workspaceModelDisplayName || config.modelDisplayName;
    config.workspaceBaseModel = config.workspaceBaseModel || config.baseModel;
    config.workspaceBaseProvider = config.workspaceBaseProvider || config.baseProvider;
    config.workspaceProviderSource = config.workspaceProviderSource || config.providerSource;
  }
  if (!config.engineModelProfileId) {
    config.engineModelProfileId = config.workspaceModelProfileId;
    config.engineModelDisplayName = config.engineModelDisplayName || config.workspaceModelDisplayName;
    config.engineBaseModel = config.engineBaseModel || config.workspaceBaseModel;
    config.engineBaseProvider = config.engineBaseProvider || config.workspaceBaseProvider;
    config.engineProviderSource = config.engineProviderSource || config.workspaceProviderSource;
  }

  return config;
}

function formatAssistantConfigValue(field, value) {
  if (field === 'maxRetryRounds') {
    return String(Math.min(8, Math.max(1, Number.parseInt(String(value ?? ''), 10) || 1)));
  }
  if (field === 'autonomyMode') {
    return String(value || 'guided').trim().toLowerCase() || 'guided';
  }
  if (field === 'safetyLevel') {
    return String(value || 'supervised-auto').trim().toLowerCase() || 'supervised-auto';
  }
  if (field === 'safeMode') {
    return value ? 'true' : 'false';
  }
  return value ? 'true' : 'false';
}

function writeAssistantAutonomySettings(workspaceRoot, payload = {}, options = {}) {
  const configPath = configPathForWorkspace(workspaceRoot, options);
  const nextPathRoot = path.dirname(configPath);
  fs.mkdirSync(nextPathRoot, { recursive: true });
  const lines = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, 'utf8').split(/\r?\n/)
    : [];

  for (const [field, key] of Object.entries(ASSISTANT_AUTONOMY_KEY_MAP)) {
    if (payload[field] === undefined) {
      continue;
    }
    const nextLine = `${key}: ${formatAssistantConfigValue(field, payload[field])}`;
    const existingIndex = lines.findIndex((line) => {
      if (/^\s*#/.test(String(line || ''))) {
        return false;
      }
      return new RegExp(`^${key}:\\s*`).test(String(line || '').trim());
    });
    if (existingIndex >= 0) {
      lines[existingIndex] = nextLine;
    } else {
      if (lines.length && String(lines[lines.length - 1] || '').trim()) {
        lines.push('');
      }
      lines.push(nextLine);
    }
  }

  fs.writeFileSync(configPath, `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`, 'utf8');
  return readAssistantConfig(workspaceRoot, options);
}

function writeAssistantModelSettings(workspaceRoot, payload = {}, options = {}) {
  const configPath = configPathForWorkspace(workspaceRoot, options);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const lines = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, 'utf8').split(/\r?\n/)
    : [];

  for (const [field, key] of Object.entries(ASSISTANT_MODEL_PROFILE_KEY_MAP)) {
    if (payload[field] === undefined) {
      continue;
    }
    const nextValue = String(payload[field] || '').trim();
    const nextLine = `${key}: ${nextValue}`;
    const existingIndex = lines.findIndex((line) => {
      if (/^\s*#/.test(String(line || ''))) {
        return false;
      }
      return new RegExp(`^${key}:\\s*`).test(String(line || '').trim());
    });
    if (existingIndex >= 0) {
      lines[existingIndex] = nextLine;
    } else {
      if (lines.length && String(lines[lines.length - 1] || '').trim()) {
        lines.push('');
      }
      lines.push(nextLine);
    }
  }

  fs.writeFileSync(configPath, `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`, 'utf8');
  return readAssistantConfig(workspaceRoot, options);
}

function safeBlockedReasonForBat(item, assistantConfig) {
  if (!assistantConfig?.safeMode) {
    return '';
  }
  const tags = new Set((Array.isArray(item?.tags) ? item.tags : []).map((entry) => String(entry || '').toUpperCase()));
  const blockedTag = (assistantConfig.safeBlockedTags || []).find((entry) => tags.has(String(entry || '').toUpperCase()));
  if (blockedTag) {
    return `safe mode blocked protected tag: ${blockedTag}`;
  }
  const haystack = `${String(item?.desc || '')} ${(Array.isArray(item?.tags) ? item.tags.join(' ') : '')}`.toLowerCase();
  const blockedDomain = (assistantConfig.safeBlockedDomains || []).find((entry) => haystack.includes(String(entry || '').toLowerCase()));
  if (blockedDomain) {
    return `safe mode blocked protected domain: ${blockedDomain}`;
  }
  const blockedTerm = (assistantConfig.safeBlockedTerms || []).find((entry) => haystack.includes(String(entry || '').toLowerCase()));
  if (blockedTerm) {
    return `safe mode blocked protected term: ${blockedTerm}`;
  }
  return '';
}

module.exports = {
  ASSISTANT_AUTONOMY_KEY_MAP,
  ASSISTANT_MODEL_PROFILE_KEY_MAP,
  DEFAULT_SAFE_BLOCKED_TAGS,
  DEFAULT_SAFE_BLOCKED_DOMAINS,
  DEFAULT_SAFE_BLOCKED_TERMS,
  configPathForWorkspace,
  parseAssistantConfigScalar,
  parseAssistantConfigBoolean,
  readAssistantConfig,
  safeBlockedReasonForBat,
  writeAssistantModelSettings,
  writeAssistantAutonomySettings,
};
