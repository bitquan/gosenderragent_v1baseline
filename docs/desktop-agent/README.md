# GoSenderr Desktop Agent Docs

This folder documents the current GoSenderr Desktop Agent implementation in `tools/gosenderr-desktop-agent`.

## Scope

These docs describe the desktop app as it exists today:

- Electron main process
- preload bridge and renderer contract
- desktop runtime integration with `backend.agent.runtime.runtime_api`
- BAT board, review, automation, validation, and update surfaces
- workspace/offload artifact handling

## Source-of-truth code

Primary source files:

- `tools/gosenderr-desktop-agent/main.js`
- `tools/gosenderr-desktop-agent/preload.js`
- `tools/gosenderr-desktop-agent/renderer/index.html`
- `tools/gosenderr-desktop-agent/renderer/app.js`
- `tools/gosenderr-desktop-agent/core/*.js`
- `tools/gosenderr-desktop-agent/shared-runtime/*.js`

Supporting runtime/backend sources:

- `backend/agent/runtime/runtime_api.py`
- `backend/scripts/solo_dev_assistant.py`
- `backend/scripts/autopilot.py`
- `backend/agent/core/storage_paths.py`
- `dev_assistant.yaml`

## Documentation status markers

The docs use these labels when needed:

- **Confirmed**: directly verified in current code
- **Current inferred behavior**: consistent with code flow, but not fully explicit in one place
- **TODO to verify**: behavior likely exists, but needs a live run or packaging check

## Document map

- [Implementation plan](./IMPLEMENTATION_PLAN.md)
- [Architecture](./ARCHITECTURE.md)
- [IPC and internal API](./IPC_API.md)
- [UI surfaces and operator flows](./UI_SURFACES.md)
- [UI overall plan](./UI_OVERALL_PLAN.md)
- [Month 1 / 30-day engine baseline](./ROADMAP_30_DAY_MVP.md)
- [12-month layered MVP baseline](./ROADMAP_12_MONTH_MVP.md)

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
