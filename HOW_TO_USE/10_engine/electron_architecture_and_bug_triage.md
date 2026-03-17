# Electron Architecture And Bug Triage

Use this guide when the desktop app breaks and you need to know where to look fast.

## Main process

- `main.js` owns app startup, IPC, workspace selection, scheduler controls, packaging hooks, and monitor snapshots.
- `preload.js` is the bridge between Electron and the renderer.
- `core/` holds reusable desktop logic: model discovery, labs, autonomy, promotions, settings, task hub, storage, and validation helpers.
- `host/` holds the runtime-service bridge and assistant config parsing.

## Renderer

- `renderer-src/main.tsx` is the source of truth for the React UI.
- `renderer/app.js` is the built bundle generated from `renderer-src/`.
- UI-only fixes should start in `renderer-src/`, then rebuild the renderer.

## Runtime / engine

- `runtime/backend/agent/` is the Python runtime, planning, tool loop, history, and artifact layer.
- `runtime/backend/scripts/autopilot.py` runs the scheduler loop.
- `shared-runtime/` is the Node-side runtime client/state bridge.

## Tests and validation

- `tests/` covers desktop JS/TS behavior.
- `npm test` runs renderer build + Node tests.
- `npm run smoke` checks core smoke behavior.
- `npm run smoke:ui` checks Electron boot/UI state.
- `npm run engine:acceptance` checks the self-host/dummy-lab gate.

## Fast triage by symptom

### Boot / startup errors

- check `main.js`
- check `core/settings-store.js`
- check cache/session paths
- run `npm run smoke:ui`

### Workspace / lab / scheduler issues

- check `host/agent-runtime-service.js`
- check `core/autonomy.js`
- check `core/safety-controller.js`
- check `runtime/backend/scripts/autopilot.py`

### Models / selector / AI settings issues

- check `core/training-tuning.js`
- check `renderer-src/main.tsx`
- check shared storage/config paths
- run `node --test .\tests\training-tuning.test.js`

### Duplicate lists / React key warnings / settings UI issues

- check `renderer-src/main.tsx`
- check `core/model-foundry.js`
- rebuild renderer before trusting the fix

### Packaging / installer / update issues

- check `scripts/run-electron-builder.js`
- check `package.json`
- check `core/desktop-release.js`
- run `npm run packaged:smoke`

## Useful boundaries

- `core/`, `host/`, `renderer-src/`, `scripts/`, `tests/`, `HOW_TO_USE/`, `main.js`, and `runtime/backend/` are all treated as assistant-owned self-improvement surfaces now.
- That is the path set the autonomous self-improvement queue can work inside.
