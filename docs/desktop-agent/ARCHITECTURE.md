# GoSenderr Desktop Agent Architecture

## 1. Purpose

The GoSenderr Desktop Agent is an Electron host for the repo's developer-agent runtime.

Confirmed current responsibilities:

- show BAT board state and safe actionable work
- launch plan/run/implement/sprint/autopilot/self-improve actions
- surface runtime health and scheduler state
- provide local review/edit/approval workflows
- expose update, storage, skill, and automation controls
- persist local desktop state and secrets

The desktop app is not the execution engine by itself. Confirmed current execution still routes into backend Python runtime commands through `backend.agent.runtime.runtime_api`.

## 2. High-level layer map

```text
Renderer (renderer/index.html + renderer/app.js)
  -> window.gosAgent bridge (preload.js)
    -> Electron main process (main.js)
      -> desktop core helpers (core/*.js)
      -> shared runtime wrapper (shared-runtime/runtime.js)
        -> runtime client (shared-runtime/agent-runtime-client.js)
          -> python -m backend.agent.runtime.runtime_api
            -> backend assistant runtime / solo assistant / autopilot flows
```

## 3. Current subsystem boundaries

### Renderer

Confirmed:

- owns local UI state
- calls preload methods for all privileged actions
- subscribes to run, scheduler, and update events
- renders dashboard, review, validation, updates, automations, skills, and settings views

It does not directly access Node APIs.

### Preload

Confirmed:

- exposes `window.gosAgent`
- maps named methods to `ipcRenderer.invoke(...)`
- exposes event subscriptions for:
  - `agent:run-event`
  - `agent:scheduler-event`
  - `app:update-event`

### Main process

Confirmed:

- owns Electron app/window lifecycle
- stores workspace and settings in `electron-store`
- stores secrets via `keytar` or `safeStorage` fallback
- builds workspace snapshots for renderer bootstrap/pulse refresh
- owns all IPC handlers
- translates UI actions into runtime requests
- aggregates manager/health cards, worker states, approval queue, and scheduler log state

### Shared runtime

Confirmed:

- tracks active runs and recent history
- persists recovery state to runtime-state JSON
- emits normalized run and scheduler events to the main process
- delegates actual work to Python via spawned subprocesses

### Backend runtime

Confirmed:

- receives action/scheduler/chat commands through `backend.agent.runtime.runtime_api`
- remains the execution host for run/implement/sprint/autopilot/self-improve flows

## 4. Startup and bootstrap flow

Confirmed current flow:

1. Electron app becomes ready in `main.js`
2. `createMainWindow()` loads `renderer/index.html`
3. auto-update monitor and binary updater are initialized
4. renderer runs `init()` in `renderer/app.js`
5. renderer calls `gosAgent.getMeta()` for version label
6. renderer calls `gosAgent.bootstrap()`
7. main process returns `workspaceSnapshot()`
8. renderer hydrates state and renders all panels
9. renderer starts a 5-second pulse via `refreshManagerPulse()`

## 5. Workspace snapshot model

Confirmed `workspaceSnapshot()` assembles these families of data:

- workspace root
- BAT board items and summary
- recent assistant runs
- follow-up BAT synthesis report
- latest sprint summary
- changed git files
- editor context
- review snapshot
- preflight result
- update state
- manager snapshot
- recovery/runtime history
- desktop settings payload

This means the main process is the composition layer for the dashboard.

## 6. Artifact and offload path resolution

Confirmed in `core/assistant-paths.js`:

- the desktop app reads `dev_assistant.yaml`
- `assistant_runs_dir` wins if configured
- otherwise `assistant_artifacts_root/assistant_runs` is used if configured
- otherwise repo-local `docs/assistant_runs` is used

Additional resolved paths include:

- scheduler log path
- runtime state path
- desktop build dir
- staged desktop release dir
- live update channel dir

This is important because the desktop UI can show stale data if it reads repo-local artifacts while the runtime writes to an offloaded artifacts root.

## 7. Manager health architecture

Confirmed:

- `buildManagerSnapshot()` in `main.js` synthesizes manager state
- renderer does not compute core health logic itself

Confirmed manager inputs:

- latest runtime state
- git changed files
- review snapshot
- preflight result
- storage snapshot
- assistant dashboard baseline payload
- scheduler runtime state
- scheduler log tail/activity
- update state

Confirmed output families:

- `scheduler`
- `baseline`
- `storage`
- `approvals`
- `approvalQueue`
- `healthCards`
- `workers`
- `summaryText`

Current inferred behavior:

- the desktop dashboard is intended to be an operator-friendly aggregation layer over many lower-level assistant artifacts and runtime signals

## 8. Run lifecycle

Confirmed flow:

1. UI action or chat command calls a preload method
2. main process routes through `handleAgentRun(...)`
3. workspace root is resolved and autonomy settings are applied
4. request defaults are filled for action/profile/autopilot fields
5. `runtime.run(...)` is called
6. shared runtime spawns Python runtime API action process
7. stdout/stderr chunks become incremental run events
8. final result updates history and recovery state
9. renderer receives run events and refreshes snapshot after completion

Confirmed normalized run states:

- `running`
- `skipped`
- `pass`
- `fail`
- `cancelled`

Confirmed special handling:

- structured skipped results and skip/no-eligible runtime signals are normalized to `skipped` during live runs and recovery-state load

## 9. Scheduler lifecycle

Confirmed:

- scheduler start/stop/status are owned by the shared runtime client
- the main process emits scheduler events into renderer
- manager snapshot also checks scheduler log freshness to detect external scheduler activity

Current inferred behavior:

- the desktop app can reflect scheduler activity even when the currently running scheduler was started outside the current Electron process, as long as the scheduler log is being updated

## 10. Review and approval architecture

Confirmed components:

- `core/review.js` handles safe file read/write/diff
- `main.js` enforces approval before save unless `force` is supplied
- `buildApprovalQueue()` synthesizes pending review items
- renderer provides inspector, diff view, edit toggle, save/discard, decision buttons

Confirmed approval exclusions:

- generated assistant artifacts under `docs/assistant_runs`
- `docs/dev_assistant_log_report.md`

Confirmed approval queue sources:

- changed git files
- latest failing locations
- recent run artifacts

Confirmed risk shaping:

- protected paths are matched by terms such as `payment`, `wallet`, `auth`, `security`, `migration`, `network`, `billing`
- low-risk paths include docs and test-heavy locations
- autonomy settings can restrict approval queue to protected scopes only and auto-approve low-risk outputs

## 11. Chat orchestration architecture

Confirmed:

- `assistant:chat` calls `core/chat.js`
- `core/chat.js` parses slash commands and natural-language intent patterns
- callbacks supplied by `main.js` map chat intents into concrete actions

Confirmed examples of routed actions:

- `/plan <ticket>`
- `/run <ticket>`
- `/implement <ticket>`
- `/implement planned`
- `/batch run`
- `/batch implement`
- `/autopilot`
- `/autopilot start|stop|status`
- `/self-improve`
- `/workers`
- `/health`
- `/approvals`
- `/approve`, `/reject`, `/defer`
- `/train`
- `/learn`
- `/cancel <runId>`

## 12. Update and release architecture

There are two distinct update surfaces.

### Workspace update flow

Confirmed in `core/updater.js`:

- checks git upstream status
- fetches update metadata
- creates backups under `.assistant_backups/`
- applies fast-forward pull when explicitly confirmed
- runs preflight after update/rollback

### Desktop binary/update-channel flow

Confirmed in `core/desktop-release.js` plus main-process update handlers:

- stages local desktop installer artifacts
- tracks staged release history
- promotes latest staged version into live channel directory
- renders `latest-mac.yml` for channel metadata
- prunes old staged versions

TODO to verify:

- exact Windows live-channel manifest strategy in production

## 13. Storage monitoring architecture

Confirmed in `core/storage.js`:

- tracks assistant runs, dev data, desktop builds, sandboxes, test artifacts, and tmp cache
- reads configured paths from `dev_assistant.yaml`
- computes folder sizes and volume pressure
- labels disk state as `ready`, `warn`, `fail`, or `idle`
- exposes cleanup scopes used by overview-panel cleanup buttons

## 14. Renderer refresh model

Confirmed:

- full bootstrap refresh via `gosAgent.bootstrap()`
- periodic manager pulse every 5 seconds
- event-driven updates for runs, scheduler, and updates
- follow-up snapshot refresh after non-running run completion and several mutating actions

Current inferred behavior:

- the renderer intentionally prefers authoritative main-process snapshots over independently recomputing domain logic

## 15. Current screens

Confirmed current top-level views:

- Dashboard
- Review
- Skills
- Automations
- Updates
- Validation
- Settings

A separate Quick Controls drawer exposes model/runtime/autonomy controls.

## 16. Testing evidence used for docs

Inspected tests confirm:

- runtime recovery uses configured offload runtime-state path
- skipped BAT runs and structured skipped results are normalized to `skipped`
- review helpers stay inside workspace boundaries
- review snapshot merges changed files, failures, artifacts, and decisions

## 17. Known documentation gaps

TODO to verify with live/manual checks:

- packaged VS Code open behavior across platforms
- all `shell.openPath(...)` UX details when a file or artifact is missing
- complete remote release-feed lifecycle with signed production artifacts
