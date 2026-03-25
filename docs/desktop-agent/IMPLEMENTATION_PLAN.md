# GoSenderr Desktop Agent Documentation Implementation Plan

Daily workflow moved to `docs/BAT_FEATURE_BOARD.md`. This file is implementation reference material, not the operator command book.

## Goal

Create a durable documentation set for the current desktop-agent repo subsystem, without redesigning the app and without inventing behavior that is not present in code.

## Stage 1 inspection summary

Confirmed from current source inspection:

### 1. Desktop app structure

- Electron entrypoint: `main.js`
- Preload bridge: `preload.js`
- Renderer shell: `renderer/index.html`
- Renderer source: `renderer-src/main.tsx`
- Renderer output: `renderer/app.js`
- Desktop core helpers:
  - `core/assistant-paths.js`
  - `core/autonomy.js`
  - `core/automations.js`
  - `core/board.js`
  - `core/chat.js`
  - `core/desktop-release.js`
  - `core/preflight.js`
  - `core/review.js`
  - `core/skills.js`
  - `core/storage.js`
  - `core/updater.js`
- Shared runtime bridge:
  - `shared-runtime/runtime.js`
  - `shared-runtime/agent-runtime-client.js`
  - `shared-runtime/preflight.js`
  - `shared-runtime/constants.js`
  - `shared-runtime/utils.js`
- Packaging/support scripts:
  - `scripts/sync-core.js`
  - `scripts/smoke.js`
  - `scripts/run-electron-builder.js`
  - `scripts/build-current-win-release.js`
  - `scripts/build-open-mac-installer.js` (compatibility path, not the Windows-first daily release flow)
  - `scripts/notarize.js`
- Tests:
  - `tests/runtime.test.js`
  - `tests/review.test.js`
  - `tests/board.test.js`
  - `tests/storage.test.js`
  - `tests/chat.test.js`
  - `tests/autonomy.test.js`
  - `tests/desktop-release.test.js`

### 2. Documentation needs by topic

#### Architecture/code docs

Need to document:

- subsystem boundaries
- layer responsibilities
- startup/bootstrap flow
- workspace snapshot composition
- runtime/process model
- artifact/offload path resolution
- scheduler and self-improve hooks
- review/edit approval flow
- update and staged release flow

#### Internal API docs

Need to document:

- `window.gosAgent` preload surface
- IPC channels in `main.js`
- run-event, scheduler-event, and update-event streams
- main response payload families
- renderer expectations for bootstrap snapshot and live events

#### UI docs

Need to document:

- current views and their responsibilities
- quick actions and chat shortcuts
- review inspector behavior
- validation view and follow-up BAT surfaces
- settings drawer autonomy controls

## Documentation set to implement

### 1. `docs/desktop-agent/README.md`

Purpose:

- landing page
- doc index
- subsystem summary
- source-of-truth list
- terminology and confidence markers

### 2. `docs/desktop-agent/ARCHITECTURE.md`

Purpose:

- explain current architecture from main process to backend runtime
- describe data sources and snapshot generation
- show lifecycle flows for run, review, scheduler, updates, and storage

### 3. `docs/desktop-agent/IPC_API.md`

Purpose:

- document the internal desktop API exposed by preload
- group handlers by namespace
- record payload and response shapes that renderer code currently expects
- separate confirmed fields from inferred fields

### 4. `docs/desktop-agent/UI_SURFACES.md`

Purpose:

- document each current screen/view
- map renderer controls to main/preload calls
- describe operator flows and guardrails

## Exact files created or updated

Created:

- `docs/desktop-agent/README.md`
- `docs/desktop-agent/IMPLEMENTATION_PLAN.md`
- `docs/desktop-agent/ARCHITECTURE.md`
- `docs/desktop-agent/IPC_API.md`
- `docs/desktop-agent/UI_SURFACES.md`

Updated:

- `docs/DESKTOP_AGENT_ELECTRON.md`

## Source mapping plan

### Main process

Primary sources:

- `main.js`
- `core/board.js`
- `core/review.js`
- `core/storage.js`
- `core/updater.js`
- `core/desktop-release.js`
- `core/assistant-paths.js`
- `core/autonomy.js`

What to extract:

- workspace snapshot structure
- manager snapshot structure
- IPC handler catalog
- approval rules
- update flow
- scheduler state logic

### Preload

Primary source:

- `preload.js`

What to extract:

- stable renderer bridge names
- event subscription helpers
- namespace grouping

### Renderer

Primary sources:

- `renderer/index.html`
- `renderer/app.js`

What to extract:

- views/screens
- local state model
- bootstrap/refresh behavior
- event-driven UI updates
- main operator actions

### Runtime integration

Primary sources:

- `shared-runtime/runtime.js`
- `shared-runtime/agent-runtime-client.js`

What to extract:

- run persistence
- process spawning model
- runtime state recovery
- scheduler lifecycle

## Constraints used while writing docs

- no subsystem redesign
- current code is source of truth
- unclear behavior is labeled as inferred or TODO to verify
- file names and actual method names are preserved
- docs stay implementation-focused rather than marketing-focused

## Recommended maintenance rule

When changing any of the following, update this doc set in the same PR:

- `main.js` IPC handlers
- `preload.js` exposed methods
- renderer view IDs or major control flows
- artifact path resolution rules
- scheduler/start/stop behavior
- update/release channel behavior
