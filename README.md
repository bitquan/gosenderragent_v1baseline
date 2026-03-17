# GoSenderr Desktop Agent (Electron)

Standalone desktop app for Mac/Windows that runs the same BAT assistant core used by the VS Code extension.

## Features
- Shared runtime bridge with normalized run states: `idle`, `running`, `pass`, `fail`, `cancelled`.
- Local-first BAT workflows (no GitHub required for core run/implement/sprint paths).
- Autopilot now defaults to solo sprint mode (audit-first/task-aware) instead of legacy generic scaffolding.
- Panes: `Dashboard`, `Skills`, `Automations`, `Updates`, `Settings`.
- Safe-gated update flow: check -> plan -> apply (explicit confirm) -> rollback from backup.
- Automation manager backed by `dev_assistant.yaml` `autopilot_jobs`.
- Keychain-first secrets (`keytar`), with encrypted fallback (`safeStorage`) when unavailable.
- Crash recovery via persisted run history (`docs/assistant_runs/runtime_state.json`).

## Run locally
```bash
npm install
npm run start
```

Pick or create a workspace on this machine before you start work. If you want to prefill the picker with a likely location, set `DESKTOP_AGENT_TARGET_WORKSPACE`.

## Standalone Layout
- This repo owns the Electron app directly at the repo root.
- Bundled Python runtime code lives under `runtime/backend/**`.
- The desktop app now targets an external workspace explicitly instead of assuming it is running inside that workspace.
- GoSenderr compatibility is preserved by pointing the app at a selected workspace on the current machine.

## Validate locally

```bash
npm run sync:core
npm run validate
```

## Install on macOS (build + open installer)
```bash
npm install
npm run install:mac
```
This builds the DMG and opens it automatically so you can install into `/Applications`.

## Build installers
```bash
npm install
npm run dist
```

Platform-specific:
```bash
npm run dist:mac
npm run dist:win
```

## Validation chain
- Full local validation:

```bash
npm run validate
```

- Packaged app smoke after a `pack` or `pack:mac` build:

```bash
npm run packaged:smoke
```

## UI edit guardrails (important)
- `renderer/app.js`:
  - Keep `const elements = { ... }` as DOM references only.
  - Never paste function bodies or business logic inside that object.
  - Every new `id="..."` added in `renderer/index.html` must be added to `elements` if accessed in JS.
  - Add null guards in render/update functions for optional elements to avoid bootstrap crashes.
  - Must keep these UI handlers present: `setActiveView`, `appendChat`, `renderTaskList`.
- After any renderer/main/preload edit, run:
```bash
npm run smoke
npm run smoke:ui
```
- `smoke` now includes syntax checks for:
  - `main.js`
  - `preload.js`
  - `renderer/app.js`
- If you see browser error `Unexpected identifier 'filtered'` (or similar), it usually means JavaScript got pasted into the `elements` object. Move it into a proper function and rerun `npm run smoke`.

## OpenAI key + version in Quick Controls
- Drawer includes `OpenAI Key` field.
- Drawer includes `Local AI Command` field (for example `backend/.venv/bin/python backend/scripts/local_ai_llama_bridge.py`).
- Opening drawer fetches stored value via `gosAgent.getSecret('OPENAI_API_KEY')`.
- Saving drawer stores it via `gosAgent.setSecret('OPENAI_API_KEY', value)`.
- Top bar version label is loaded from main-process metadata (`app:meta`), which works in packaged builds.

## Local coding model (llama.cpp)
- Default local bridge command:
  - `backend/.venv/bin/python backend/scripts/local_ai_llama_bridge.py`
- Default model lookup order:
  1. `LLAMA_MODEL_PATH` (if set)
  2. `/Users/<you>/large-storage/models/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf`
  3. `/Users/<you>/large-storage/models/tiny-aya-global-q4_0.gguf`
- Optional tuning env vars:
  - `LLAMA_CHAT_BIN`
  - `LLAMA_N_CTX`
  - `LLAMA_N_GPU_LAYERS`
  - `LLAMA_N_PREDICT`

System prompt can be changed in the Quick Controls drawer; try prompts like
“Answer as a strict code reviewer” or “Reply with one sentence” to quickly
alter the assistant’s persona.

The assistant now understands additional slash commands: `/test` runs the
backend tests and `/open <path>` opens a file in the editor. These work
in both the desktop app and VS Code sidebar when local AI is configured.

Desktop quick actions include:
- `Autopilot` (single solo-sprint autopilot pass)
- `Train` (training data refresh)
- `Learn` (analyze log + train)
- `Start Auto` / `Stop Auto` (scheduler controls)

## Signing and notarization
- macOS signing: `CSC_LINK`, `CSC_KEY_PASSWORD`
- macOS notarization (`scripts/notarize.js`): `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
- Windows signing: `CSC_LINK`, `CSC_KEY_PASSWORD` (in CI mapped from `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`)

## IPC contract implemented
- `agent:run`, `agent:implement`, `agent:sprint`, `agent:cancel`, `agent:status`, `agent:openLocation`
- `skills:list`, `skills:run`
- `automations:list`, `automations:upsert`, `automations:toggle`, `automations:remove`, `automations:runNow`
- `updates:check`, `updates:plan`, `updates:apply`, `updates:rollback`, `updates:backups`

## Notes
- Update apply is confirmation-gated. No auto-apply behavior.
- Command execution is allowlisted to known assistant Python entrypoints.
