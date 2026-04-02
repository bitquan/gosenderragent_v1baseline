# GoSenderr Desktop Agent Docs

Use `docs/BAT_FEATURE_BOARD.md` as the daily source of truth for workflow, commands, validation, and active BAT status.

This folder is compatibility-oriented reference material for the desktop subsystem. It should explain the current implementation, but it should not compete with the board for operator workflow.

## Scope

These docs describe the desktop app as it exists today:

- Electron main process
- preload bridge and renderer contract
- desktop runtime integration with `backend.agent.runtime.runtime_api`
- BAT board, review, automation, validation, and update surfaces
- workspace/offload artifact handling

## Source-of-truth code

Primary source files:

- `main.js`
- `preload.js`
- `renderer-src/main.tsx`
- `renderer/index.html`
- `renderer/app.js` (generated output)
- `core/*.js`
- `shared-runtime/*.js`

Supporting runtime/backend sources:

- `runtime/backend/agent/runtime/runtime_api.py`
- `runtime/backend/agent/core/*.py`
- `runtime/backend/scripts/*.py`
- `dev_assistant.yaml`

Generated output boundaries:

- edit `renderer-src/*` instead of `renderer/app.js`
- edit source/runtime files instead of packaged copies under `WINDOWS_APP/`
- refresh generated copies through the normal build or packaging flows after source changes land

## Documentation status markers

The docs use these labels when needed:

- **Confirmed**: directly verified in current code
- **Current inferred behavior**: consistent with code flow, but not fully explicit in one place
- **TODO to verify**: behavior likely exists, but needs a live run or packaging check

## Document map

- [BAT feature board](../BAT_FEATURE_BOARD.md)
- [Implementation plan](./IMPLEMENTATION_PLAN.md)
- [Architecture](./ARCHITECTURE.md)
- [IPC and internal API](./IPC_API.md)
- [UI surfaces and operator flows](./UI_SURFACES.md)

Historical planning notes that used to act like primary roadmap docs were archived during the board-first cleanup pass. Use the canonical board plus linked checklists instead:

- [BAT feature board](../BAT_FEATURE_BOARD.md)
- [Engine blueprint checklist](../ENGINE_BLUEPRINT_CHECKLIST.md)
- [Local model blueprint checklist](../LOCAL_MODEL_BLUEPRINT_CHECKLIST.md)
- [Archived desktop-agent planning notes](../../archive/2026-04-01-board-cleanup/README.md)

## Desktop subsystem summary

Confirmed current subsystem layout:

- `main.js`
  - owns Electron lifecycle, workspace selection, runtime wiring, IPC handlers, scheduler controls, review/edit handlers, update handlers, and manager-health aggregation
- `preload.js`
  - exposes a narrow `window.gosAgent` bridge for renderer calls and subscriptions
- `renderer/index.html`
  - declares dashboard, review, skills, automations, updates, validation, settings, and quick-controls surfaces
- `renderer/app.js`
  - owns renderer state, bootstrap refresh, periodic manager pulse, event handling, and all UI rendering
- `core/board.js`
  - parses BAT board and assistant artifacts, including sprint summaries, follow-up BAT reports, and dashboard/baseline state
- `core/review.js`
  - provides guarded workspace file read/write and diff helpers for in-app review
- `core/storage.js`
  - computes storage/offload snapshots and cleanup targets
- `core/assistant-paths.js`
  - resolves repo-local vs configured offload artifact paths from `dev_assistant.yaml`
- `core/autonomy.js`
  - maps autonomy presets into runtime request flags
- `shared-runtime/runtime.js`
  - persistent desktop runtime wrapper with run history and event emission
- `shared-runtime/agent-runtime-client.js`
  - spawns Python runtime API commands and scheduler processes

## Key current behaviors

Confirmed:

- the renderer is local-state-driven and refreshes from `app:bootstrap`
- the desktop app reads assistant artifacts from configured offload locations when `dev_assistant.yaml` points away from repo-local storage
- run/sprint/autopilot/self-improve actions ultimately flow through the shared runtime into `backend.agent.runtime.runtime_api`
- the review surface can read files, inspect diffs, save approved files, copy patches, and open files in VS Code
- the manager dashboard is synthesized in the main process, not the renderer
- autopilot scheduler state is tracked both from in-process runtime state and scheduler log activity
- `npm run system:check -- --area roadmap` now exposes the Month 1 daily quota proof rollup, including today’s focus task, 5+5 progress, blocked/rescoped count, validation rollup, next safe action, and explicit do-not-widen guidance

Current inferred behavior:

- the desktop app is intended to be the operator-facing mission-control host, while deeper execution remains in backend Python runtime components
- the renderer intentionally stays thin on business rules and mostly renders main-process snapshots/events

TODO to verify:

- packaged-app behavior for every `open`/`shell` path on Windows
- full release-feed flow against a real remote update channel
