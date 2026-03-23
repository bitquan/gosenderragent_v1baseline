# Preferred Vs Compatibility Paths

## Why this exists

This repo has newer baseline paths and older compatibility paths living side by side.

Use this guide when you or the engine are choosing where new work should go.

## Preferred baseline paths

Use these for new baseline behavior and new fixes:

- `scripts/engine-cli.js`
  Canonical human terminal surface for `ask`, `plan`, `edit`, `agent`, review, and status.
- `core/engine-contract.js`
  Shared route, mode, lane, and model contract across terminal, VS Code, and desktop.
- `core/grounded-chat.js`
  Shared grounded teammate voice and repo-aware `Ask` and `Plan` behavior.
- `shared-runtime/agent-runtime-client.js`
  Host-side Python runtime bridge.
- `shared-runtime/runtime.js`
  Shared run state and operator execution snapshots.
- `runtime/backend/agent/runtime/runtime_api.py`
  Canonical machine boundary for runtime actions.
- `runtime/backend/agent/core/tool_loop.py`
  Bounded tool-loop execution for clone-safe orchestrated tasks.
- `core/task-hub.js`
  Canonical task/inbox state used by the manager surfaces.
- `core/git-service.js`
  Shared Git baseline used by desktop and terminal workflows.
- `OWNER_DOCS/`
  Owner-facing operating guides for the current baseline.

## Compatibility-only or debug-only paths

Keep these for compatibility, migration, or debugging. Do not build new baseline behavior on top of them unless you are explicitly repairing legacy flow:

- `docs/BAT_FEATURE_BOARD.md`
  Legacy backlog board. Still readable for compatibility, but not the operator-facing baseline surface.
- `runtime/backend/scripts/solo_dev_assistant.py`
  Legacy BAT-style solo pipeline path.
- `runtime/backend/scripts/dev_assistant.py`
  Legacy script path kept for compatibility.
- `WINDOWS_APP/win-unpacked/`
  Packaged app output, not source of truth.
- `dist/win-unpacked/`
  Build artifact output, not source of truth.
- generated files under `docs/assistant_runs/` or offload run artifacts
  Useful for history, proofs, and debugging, but not where new behavior should be implemented.

## Good rule for new work

When adding or fixing baseline behavior:

1. start in the shared engine contract
2. patch the runtime or shared host bridge
3. sync VS Code and desktop to that same contract
4. update docs only after the behavior is real

## Good rule for the engine

When the engine decides what to reuse:

- prefer shared runtime, engine-contract, grounded-chat, task-hub, and git-service paths
- treat BAT board, old solo scripts, and packaged outputs as compatibility context, not primary implementation targets
