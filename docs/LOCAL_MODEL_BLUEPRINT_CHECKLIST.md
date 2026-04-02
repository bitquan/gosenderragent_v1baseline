# Local Model Blueprint Checklist

This is the linked model-layer execution checklist. `docs/BAT_FEATURE_BOARD.md` remains the only governance board and owns policy, categorization, cleanup backlog, baseline layers, and activation order. This file tracks local-model work only after the matching engine proof gate is ready.

## Board Sync Contract

- Treat `docs/BAT_FEATURE_BOARD.md` as the canonical owner for governance, roadmap categories, cleanup state, and layer-baseline definitions.
- Use this file for model-only execution detail and gated promotion work after the engine proof gate is ready.
- When a model item changes durable policy, ownership, machine-fit rules, or cleanup categorization, update the board in the same pass.
- Do not let this file become a second board. Keep governance on the board and use this file for the model-layer details only.

## Goal

After the engine is proven, make sure the approved local model bundle can drive every required engine capability while staying inside the 32 GB Windows machine-fit rule and using as few active defaults as practical.

## Model Gate Rules

- Engine work comes first and defines the real product contract.
- Models prove the engine; they do not substitute for unfinished engine behavior.
- Default-bundle promotion stays blocked until the engine capability matrix exists and the first proof packs are green.
- The active approved default set should stay as small as practical even though a 1 to 4 model envelope is allowed.

- 2026-04-01: The engine-side focused proof packs, honesty surfaces, and acceptance-order gate are now green enough to resume Phase 0 inventory and Phase 1 baseline-bundle work in this checklist.

## Current Policy Snapshot

- Keep `qwen2.5-coder:7b` as the baseline proof route unless a better proven option appears.
- Keep `qwen2.5-coder:3b` as the low-headroom fallback.
- Keep `phi4-mini:3.8b` or another small candidate as backup-only after proof.
- Keep `qwen2.5-coder:14b` as candidate-only until it proves superior under the full engine matrix on this machine.
- Treat the current mixed live state honestly: the baseline, workspace, engine-supporting routes, and training default now point at `qwen2.5-coder:7b`, while the explicit coder lane still points at `qwen2.5-coder:14b` as a candidate-heavy route.

## Phase 0: Model Policy And Inventory

- [x] Add one canonical local-model blueprint section to `docs/BAT_FEATURE_BOARD.md`.
- [x] Inventory the live stack in `dev_assistant.yaml`.
- [x] Inventory the declared model requirements in `core/training-tuning.js`.
- [x] Separate approved defaults, candidate-only models, and larger-headroom models.
- [x] Record the current mixed state clearly in operator-facing summaries and config review notes.

- 2026-04-01: `core/training-tuning.js` now owns the canonical local-model policy snapshot for approved defaults, candidate-only models, and larger-headroom candidates; `host/assistant-config.js`, `core/ai-center.js`, and `core/system-check.js` now surface those review notes and the mixed live 7B/14B route state from one source.

## Phase 1: Baseline Bundle Definition

- [x] Set a baseline proof bundle that is smaller than the current live default.
- [x] Keep `qwen2.5-coder:7b` as the baseline primary route for engine proof unless a better proven option appears.
- [x] Keep `qwen2.5-coder:3b` as low-headroom fallback.
- [x] Keep `phi4-mini:3.8b` or another small candidate as backup only after proof.
- [x] Keep `qwen2.5-coder:14b` as candidate-only until it proves superior under the full engine matrix on this machine.
- [x] Keep the active default set to as few models as possible even though 1 to 4 models is allowed.

- 2026-04-01: The approved default proof bundle is now explicit in source as `qwen2.5-coder:7b` baseline primary plus `qwen2.5-coder:3b` low-headroom fallback, while `qwen2.5-coder:14b` and the larger-headroom families remain candidate-only until the full engine matrix proves them superior on this machine.

## Phase 2: 32 GB Guardrails

- [x] Add a per-model cap rule so no approved default model exceeds 32 GB requirement metadata.
- [x] Add a live-fit rule so the active default route bundle remains within practical whole-machine headroom on the 32 GB target.
- [x] Enforce those rules in desktop-side routing.
- [x] Enforce those rules in runtime-side routing.
- [x] Enforce those rules in promotion and rollback flow.
- [x] Surface those rules honestly in system-check and Tune Pod summaries.

## Phase 3: Per-Model Engine Proof

- [x] Make every candidate prove ask or plan behavior through the real engine loop.
- [x] Make every candidate prove coding on an existing repo slice.
- [x] Make every candidate prove repair of a failing slice.
- [x] Make every candidate prove review or validate flows.
- [x] Make every candidate prove docs-guided work when the engine requests it.
- [x] Make every candidate prove scaffold or create-project flow.
- [x] Make every candidate prove bounded clone-lab autonomy.
- [x] Record latency, headroom, success rate, and failure mode per model family.

- 2026-04-02: `core/ai-center.js` now publishes a shared per-model proof matrix, `core/system-check.js` renders it in the models area, and `core/promotions.js` reuses that matrix or benchmark-backed proof evidence to hold local candidates until the full capability set is verified.
- 2026-04-02: `core/model-foundry.js` plus `scripts/engine-cli.js` now expose `npm run engine:cli -- models proof`, which runs the focused proof packs per foundry candidate, records benchmark evidence for ask-plan, code, repair, review, docs-guided, scaffold, and clone-lab autonomy, and persists the resulting proof summary on the candidate. The live workspace's current `foundry-approved-route-bundle` candidate was re-run through that command and recorded green proof for all seven tracked capabilities.

## Phase 4: Promotion And Reporting

- [x] Promote only candidates that pass the full engine matrix and the 32 GB machine-fit rule.
- [x] Keep heavier or weaker models visible as candidate-only rather than silently routing to them.
- [x] Freeze the approved model bundle into live config only after proof is green.
- [x] Update system-check, Tune Pod, and route summaries so they all show the same approved state.
- [x] Preserve rollback to the last known-good bundle.

- 2026-04-01: Tune Pod now reuses the shared local-model policy snapshot so approved defaults, candidate-only models, and live mixed-state route summaries stay visible alongside the existing system-check models area and promotion guardrails.
- 2026-04-01: `core/promotions.js` now refuses route-bundle config writes until the route activation is proof-ready and persists the frozen approved bundle metadata on successful promotion, with focused coverage proving a green `qwen2.5-coder:7b` route bundle rewrites the live config only after the full local proof matrix passes.
- 2026-04-01: Route-bundle rollback now returns and persists the restored last-known-good config bundle, with focused coverage proving the live config returns to the prior `qwen2.5-coder:3b` plus remote-lane fallback state after rolling back an approved local freeze.

## Model Verification Checklist

- [x] Assert that every approved default model is at or below the 32 GB cap in `core/training-tuning.js`.
- [x] Assert that the active live default bundle stays within practical whole-machine fit for the Windows 32 GB target.
- [x] Run `npm run test:route-parity`.
- [x] Run `node --test ./tests/ai-center.test.js ./tests/assistant-config.test.js ./tests/agent-runtime-service.test.js ./tests/system-check.test.js`.
- [x] Run `node --test ./tests/training-tuning.test.js`.
- [x] Re-run the full engine proof matrix per candidate before promotion.
- [x] Run `npm run engine:acceptance` for the approved bundle only.

## Model Relevant Files

- `docs/BAT_FEATURE_BOARD.md`
- `dev_assistant.yaml`
- `core/training-tuning.js`
- `core/ai-center.js`
- `core/model-foundry.js`
- `core/promotions.js`
- `core/system-check.js`
- `core/windows-pc.js`
- `runtime/backend/agent/core/model_routing.py`
- `host/assistant-config.js`
- `tests/ai-center.test.js`
- `tests/assistant-config.test.js`
- `tests/agent-runtime-service.test.js`
- `tests/system-check.test.js`
- `tests/engine-acceptance.test.js`
- `tests/training-tuning.test.js`

## Working Rules For Updating This Checklist

- [ ] When a checklist item is implemented, mark it done here and in `docs/BAT_FEATURE_BOARD.md` if it changes durable repo policy.
- [ ] When a proof fails, add the missing capability as blocked work instead of silently carrying it forward.
- [ ] When a route, model, or proof rule changes, update the relevant verification checklist in the same pass.
- [ ] Keep engine work ahead of model work until the engine contract is truly proven.
- [ ] Keep the existing desktop shell, existing VS Code companion, and existing tool catalog as the main product path.