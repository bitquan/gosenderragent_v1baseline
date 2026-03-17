# GoSenderr Desktop Agent IPC and Internal API

This file documents the current internal API between renderer and main process.

## 1. Bridge shape

Confirmed in `preload.js`:

- the renderer receives a single global object: `window.gosAgent`
- almost all methods are thin wrappers over `ipcRenderer.invoke(channel, payload)`
- three event subscriptions are also exposed

## 2. Event subscriptions

### `gosAgent.onRunEvent(handler)`

Confirmed event source:

- Electron channel: `agent:run-event`

Confirmed event families seen in renderer/runtime flow:

- run started
- incremental log chunk
- final pass/fail/cancelled event

Confirmed fields used by renderer:

- `runId`
- `state`
- `label`
- `exitCode`
- `checks`
- `locations`
- `artifactPaths`
- `logChunk`
- `boardUpdate`
- `blockedReason`

Current inferred behavior:

- a final event may omit some fields if earlier events already carried them; renderer preserves prior values where needed

### `gosAgent.onSchedulerEvent(handler)`

Confirmed event source:

- Electron channel: `agent:scheduler-event`

Confirmed event kinds:

- `type: "state"`
- `type: "log"`

Confirmed state-event fields:

- `running`
- `message`
- `pid`

Confirmed log-event fields:

- `stream`
- `text`

### `gosAgent.onUpdateEvent(handler)`

Confirmed event source:

- Electron channel: `app:update-event`

Confirmed renderer expectations:

- top-level event contains workspace/binary update state families
- renderer reads `event.workspace` and `event.binary`

## 3. App/bootstrap namespace

### `bootstrap()` -> `app:bootstrap`

Purpose:

- fetch the full workspace snapshot used to render the UI

Confirmed response families:

- `workspaceRoot`
- `bats`
- `summary`
- `recentRuns`
- `followupBats`
- `latestSprint`
- `changedFiles`
- `editorContext`
- `review`
- `preflight`
- `updates`
- `manager`
- `recovery`
- `settings`

### `getMeta()` -> `app:meta`

Confirmed response fields:

- `version`
- `name`
- `electron`

### `pickWorkspace()` -> `app:pickWorkspace`

Confirmed behavior:

- opens directory picker
- sets workspace when user selects a folder

Confirmed response patterns:

- `{ ok: false, cancelled: true }`
- `{ ok: true, workspaceRoot, snapshot }`

### `setWorkspace(workspaceRoot)` -> `app:setWorkspace`

Confirmed response:

- `{ ok: true, workspaceRoot, snapshot }`

### `updateSettings(payload)` -> `app:updateSettings`

Confirmed supported input families:

- model/runtime UI settings
- local AI command
- GitHub enable flag
- auto-update policy
- release feed policy
- autonomy controls:
  - `autonomyMode`
  - `autoSynthesizeBats`
  - `autoRetryUntilPass`
  - `autoBrainstormOnFailure`
  - `autoApproveLowRisk`
  - `humanApprovalProtectedOnly`
  - `sandboxRequired`
  - `baselineSelfHealPriority`
  - `maxRetryRounds`

Confirmed response:

- `{ ok: true, settings }`

### `setSecret(name, value)` -> `app:secrets:set`

Confirmed response families:

- `{ ok: true, backend: "keytar" }`
- `{ ok: true, backend: "safeStorage-fallback" }`
- `{ ok: false, backend: "none", message }`

### `getSecret(name)` -> `app:secrets:get`

Confirmed response families:

- `{ ok: true, value, backend }`
- `{ ok: false, value: null, backend: "none" }`

## 4. Agent/runtime namespace

### `preflight(payload)` -> `agent:preflight`

Confirmed input:

- optional `workspace`
- optional `requireGh`

Confirmed output:

- preflight report from desktop/core preflight module

### `status(payload)` -> `agent:status`

Confirmed behavior:

- without `runId`: returns runtime status bundle
- with `runId`: returns single run snapshot if present

### `plan(payload)` -> `agent:plan`
### `run(payload)` -> `agent:run`
### `implement(payload)` -> `agent:implement`
### `sprint(payload)` -> `agent:sprint`
### `autopilot(payload)` -> `agent:autopilot`
### `selfImprove(payload)` -> `agent:selfImprove`
### `train(payload)` -> `agent:train`

Confirmed shared behavior:

- all route through `handleAgentRun(...)` except `learn`
- workspace can be overridden in payload
- editor context is injected if not provided
- autonomy settings are applied before runtime execution

Confirmed response on launch:

- `{ runId, state: "running", label, artifactPaths: [] }`

Current inferred behavior:

- final outcome is delivered mainly via `onRunEvent`, not by awaiting the launch call

### `learn(payload)` -> `agent:learn`

Confirmed behavior:

- runs analyze-log first
- if analyze passes, runs train second
- returns a composed result object with analyze/train run metadata and message

### `cancel(payload)` -> `agent:cancel`

Confirmed input:

- `runId`

Confirmed output:

- runtime cancel result

### `autopilotSchedulerStart(payload)` -> `agent:autopilotSchedulerStart`
### `autopilotSchedulerStop()` -> `agent:autopilotSchedulerStop`
### `autopilotSchedulerStatus()` -> `agent:autopilotSchedulerStatus`

Confirmed response fields:

- `ok`
- `running`
- `pid`
- `message`

### `getEditorContext()` -> `agent:getEditorContext`

Confirmed response:

- `{ ok: true, editorContext }`

### `setEditorContextFocus(payload)` -> `agent:setEditorContextFocus`

Confirmed input:

- `path`
- `line`

Confirmed response:

- `{ ok: true, editorContext }`

### `openLocation(payload)` -> `agent:openLocation`

Confirmed input:

- `path`
- `line`

Confirmed response fields:

- `ok`
- `message`
- `path`
- `line`

## 5. Chat namespace

### `chatMessage(text, workspace)` -> `assistant:chat`

Confirmed behavior:

- main process delegates parsing to `core/chat.js`
- callbacks in `main.js` implement concrete actions

Confirmed response:

- `{ ok: true, reply }`

## 6. Review namespace

### `getReviewSnapshot()` -> `review:getSnapshot`

Confirmed response:

- `{ ok: true, review, editorContext }`

### `readReviewFile(payload)` -> `review:readFile`

Confirmed input:

- `path`
- optional `line`

Confirmed success fields:

- `ok`
- `path`
- `fullPath`
- `language`
- `lineCount`
- `truncated`
- `content`

### `getReviewDiff(payload)` -> `review:getDiff`

Confirmed response fields:

- `ok`
- `path`
- `truncated`
- `diff`
- `summary`

Confirmed `summary` fields:

- `additions`
- `deletions`
- `hunkCount`
- `hunks[]`

### `saveReviewFile(payload)` -> `review:saveFile`

Confirmed input:

- `path`
- `content`
- optional `line`
- optional `force`

Confirmed approval guard:

- save is rejected unless file is approved, unless `force` is set

Confirmed success response adds:

- `diff`
- `summary`

### `setReviewDecision(payload)` -> `review:setDecision`

Confirmed input:

- `path`
- `status`
- optional `note`

Confirmed response:

- `{ ok: true, decision, review }`

### `copyReviewText(payload)` -> `review:copyText`

Confirmed behavior:

- writes text to clipboard

### `openInVsCode(payload)` -> `review:openInVsCode`

Confirmed input:

- `path`
- `line`

Confirmed response:

- `{ ok, message, path, line }`

## 7. Skills namespace

### `listSkills()` -> `skills:list`

Confirmed response items include:

- `name`
- `description`
- `path`
- `root`

### `runSkill(payload)` -> `skills:run`

Confirmed input:

- `skillPath`
- optional `open`

Confirmed behavior:

- validates the path is inside known skill roots
- returns parsed skill metadata
- main process optionally opens the skill file after success

## 8. Automations namespace

### `listAutomations()` -> `automations:list`

Confirmed source:

- parsed from `autopilot_jobs` block in `dev_assistant.yaml`

### `upsertAutomation(payload)` -> `automations:upsert`
### `toggleAutomation(payload)` -> `automations:toggle`
### `removeAutomation(payload)` -> `automations:remove`

Confirmed input families:

- `name`
- `cron`
- `enabled`

Confirmed behavior:

- these rewrite the `autopilot_jobs` YAML block

### `runAutomationNow(payload)` -> `automations:runNow`

Confirmed behavior:

- resolves named job from current automation list
- rejects disabled jobs unless forced
- starts runtime action `autopilot` with schedule metadata

## 9. Updates namespace

### Workspace update handlers

- `checkUpdates()` -> `updates:check`
- `planUpdates()` -> `updates:plan`
- `applyUpdates(payload)` -> `updates:apply`
- `rollbackUpdates(payload)` -> `updates:rollback`
- `listBackups()` -> `updates:backups`

Confirmed apply input:

- `confirm`
- optional `backupTargets`

Confirmed rollback input:

- `backupId`

### Binary/update-channel handlers

- `checkBinaryUpdates()` -> `updates:binaryCheck`
- `installBinaryUpdate()` -> `updates:binaryInstall`
- `promoteBinaryUpdate()` -> `updates:binaryPromote`
- `pruneBinaryUpdates()` -> `updates:binaryPrune`

Current inferred behavior:

- `checkBinaryUpdates()` merges live feed state and local staged-release state into one response family used by the renderer

## 10. Storage namespace

### `cleanupStorage(payload)` -> `storage:cleanup`

Confirmed current UI scopes:

- `desktop-builds`
- `transient-artifacts`

TODO to verify:

- whether additional cleanup scopes exist but are not currently surfaced in the renderer

## 11. Renderer expectations summary

The renderer currently assumes:

- `bootstrap()` returns enough data to redraw the whole UI
- run launches return quickly with a `runId`
- final run outcomes arrive via `onRunEvent`
- scheduler logs may stream independently of scheduler state changes
- review saves may fail due to approval gating
- update events may update both workspace and binary cards together
