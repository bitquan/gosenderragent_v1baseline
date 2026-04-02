# Engine Blueprint Checklist

This is the linked engine-layer execution checklist. `docs/BAT_FEATURE_BOARD.md` remains the only governance board and owns policy, categorization, cleanup backlog, baseline layers, and activation order. This file carries engine-specific execution detail because the full tracker is too large to keep inline on the board.

## Board Sync Contract

- Treat `docs/BAT_FEATURE_BOARD.md` as the canonical owner for governance, roadmap categories, cleanup state, and layer-baseline definitions.
- Use this file for engine-only execution detail, proof progress, and implementation status.
- When an engine item changes durable policy, workflow, ownership, or cleanup categorization, update the board in the same pass.
- Do not let this file become a second board. If a topic spans governance plus engine execution, keep governance on the board and link back here for detail.

## Goal

Make the project a real self-coding AI dev assistant that can ask, plan, code, repair, validate, review, do docs-guided work, scaffold or create projects, use the existing VS Code companion and tool stack, and safely run bounded autonomy through one engine loop.

## Locked Product Contract

- The existing desktop shell remains the main operator surface.
- The existing VS Code companion remains the coding-side client surface.
- The existing tool catalog remains the canonical tool surface.
- The engine must use current repo tools and current VS Code integration instead of creating a second workflow.
- User-driven and review-backed learning remains the default path; autonomous self-improvement stays optional and gated.
- Every bounded engine or model pass must leave a visible proof artifact, including the current Python runtime path and routed CLI model path.
- Focused proof must go green before broad acceptance or wider autonomy.

## Current Working Checklist

Work this section top to bottom. Do not start model-bundle or wider promotion work until these engine items are green.

### Track A: Desktop And Companion Parity

Board-visible owner: `BAT<UIUX-DESKTOP-001>` and `BAT<UIUX-COMPANION-001>` in `docs/BAT_FEATURE_BOARD.md`. Keep the board responsible for top-level app and companion UI/UX status while this track holds the detailed parity steps.

- [x] Audit the remaining parity gaps across `main.js`, `preload.js`, and `integration-library/extensions/vscode-companion/extension.js` for task launch, open-file handoff, trace inspection, review flow, and safe coding actions.
- [x] Close trace inspection parity between the desktop shell and the VS Code companion.
- [x] Close open-file handoff parity so bounded engine results can jump to the right file from both surfaces.
- [x] Close review-flow parity so review bundles, findings, and next actions show the same evidence in both surfaces.
- [x] Close task-launch and safe coding action parity so the same bounded engine actions are reachable from desktop and companion surfaces.

Track A audit notes:

- 2026-04-01: The first concrete parity gaps are explicit repair-loop launch from the VS Code companion, direct review-decision handoff from the companion, and richer trace or review inspection parity between desktop and extension surfaces.
- 2026-04-01: The VS Code companion now exposes `Repair loop` as a first-class command and workbench action, so bounded repair retries no longer depend on the shared next-action card to be reachable from the extension surface.
- 2026-04-01: The VS Code companion now writes approve or reject file decisions into the shared workspace review-decision store, so desktop and extension review actions no longer drift between separate local states.
- 2026-04-01: The VS Code companion now exposes a CLI-backed `Self improve` action as a command palette action, slash command, and workbench button, so one bounded supervised self-improvement pass can run in a dedicated terminal without blocking the active coding chat surface.
- 2026-04-01: The VS Code companion now exposes a CLI-backed `Autopilot` action as a command palette action, slash command, and workbench button, so one bounded supervised autopilot pass can run in a dedicated terminal without blocking the active coding chat surface.
- 2026-04-01: The companion review bundle now surfaces approval state, fix actions, request counts, and the first queued review request from the shared runtime payload, so desktop and extension review evidence no longer stop at only reason or fix text.
- 2026-04-01: The companion packaging path now stays workspace-copy first through `integration.json`, `extension.js` remains the live runtime entry, and `src/extension.ts` delegates to that runtime so the extension source strategy and install metadata no longer drift.
- 2026-04-01: Desktop Workbench and the VS Code companion now both expose bounded file or trace handoff, review evidence, and supervised next-step actions through the shared bridge and review store, so parity no longer depends on one surface hiding the only operator path.

### Track B: Missing Capability Proof Packs

- [x] Add a focused proof pack for conversational ask.
- [x] Add a focused proof pack for bounded planning on real repo work.
- [x] Add a focused proof pack for coding on an existing repo slice.
- [x] Add a focused proof pack for failing-test repair.
- [x] Add a focused proof pack for review or validate flows.
- [x] Add a focused proof pack for docs-guided changes.
- [x] Add a focused proof pack for self-improvement that stays behind engine honesty gates.

### Track B1: Engine CLI Docs-Grounded Ask And Plan

- [x] Phase 1: Lock this work into the canonical docs by updating `docs/BAT_FEATURE_BOARD.md`, adding a locked markdown progress summary, and adding an exact phase checklist here in `docs/ENGINE_BLUEPRINT_CHECKLIST.md`.
- [x] Phase 2: Add trusted online docs intake for `scripts/engine-cli.js`, including allowlisted sources for VS Code, Node, Python, MDN, and Microsoft docs plus snippet extraction and good or avoid pattern indexing.
- [x] Phase 3: Add docs-aware terminal commands and flags so Ask and Plan can run in repo-grounded mode with trusted online doc context instead of relying on a second workflow.
- [x] Phase 4: Add a locked markdown summary path so current and future multi-phase plans can be written to `docs/LOCKED_PLAN_SUMMARY.md` and checked outside chat.
- [x] Phase 5: Add the first focused proof pack for docs-grounded Ask and Plan, covering trusted-doc normalization, snippet extraction, good or avoid pattern indexing, grounded prompt building, and locked summary generation.
- [x] Phase 6: Feed the docs-grounded good or avoid pattern summaries into operator honesty surfaces and self-improvement memory only after the first proof pack is green.

Track B1 implementation notes:

- 2026-04-01: The first bounded slice uses the existing `scripts/engine-cli.js` Ask and Plan path rather than inventing a second docs assistant surface.
- 2026-04-01: Trusted docs intake is intentionally allowlisted and source-bounded so online docs remain supporting evidence, not a free-form web crawler.
- 2026-04-01: The locked plan summary file for this and future engine expansion work lives in `docs/LOCKED_PLAN_SUMMARY.md`.
- 2026-04-01: The first focused proof pack now lives in `tests/engine-cli.test.js`, covering docs-aware CLI arg parsing, trusted-doc normalization, snippet extraction, good or avoid pattern indexing, grounded prompt building, and locked summary markdown generation.
- 2026-04-01: Docs-guided vault context now feeds into Test Bench follow-ups and companion memory hints through `core/test-bench.js`, `core/learning-journal.js`, `renderer-src/main.tsx`, and the companion workbench payload, so docs-derived good or avoid guidance no longer stays CLI-only.

### Track B2: Engine Model Proof And Supervised Learning Policy

- [x] Phase 1: Lock the policy that the project keeps using the existing desktop shell, VS Code companion, and canonical tool catalog until native replacements are actually proven.
- [x] Phase 2: Lock the policy that user-driven and review-backed learning stays primary, while autonomous self-improvement remains optional and gated.
- [x] Phase 3: Add an engine CLI proof command that writes `docs/ENGINE_MODEL_PROOF.md` with the current Python runtime path, routed CLI model proof, acceptance gate, and learning envelope.
- [x] Phase 4: Add focused regression coverage for the proof markdown builder so the per-pass proof artifact stays stable.
- [x] Phase 5: Feed the per-pass proof artifact into broader operator honesty surfaces only after the focused proof pack stays green.

Track B2 implementation notes:

- 2026-04-01: `scripts/engine-cli.js` now owns the per-pass `proof-summary` command so proof stays on the same terminal surface as Ask, Plan, Edit, and Repair.
- 2026-04-01: `docs/ENGINE_MODEL_PROOF.md` is the visible artifact for the current Python-backed engine path, routed CLI models, acceptance control gate, and supervised learning envelope.
- 2026-04-01: The proof summary intentionally reports the current VS Code reuse contract and keeps autonomous self-improvement framed as opt-in and gated rather than silently widening it.
- 2026-04-01: Desktop Monitor and the VS Code companion now surface the same shared engine-model-proof summary built from `core/engine-model-proof.js`, so the CLI artifact and both operator surfaces stay aligned.
- 2026-04-01: The engine CLI now writes prompt starts and bounded execution outcomes into the shared learning journal, so successful CLI edit and repair runs can become reusable prompt guidance with visible proof instead of staying CLI-only history.

### Track C: Operator Honesty Surfaces

- 2026-04-01: Canonical capability-state descriptors now flow through `core/acceptance-report.js`, `core/mvp-readiness.js`, `core/system-check.js`, and `core/grounded-chat.js`, so acceptance, readiness, system-check, and grounded repo summaries can distinguish verified, candidate-only, blocked, and missing proof states.
- 2026-04-01: Desktop Monitor, Tune Pod, and the VS Code companion now prefer canonical capability labels over legacy proof shorthand, so operator surfaces show verified, candidate-only, blocked, and missing engine state without implying proof that is not there.
- [x] Update `core/system-check.js` to report verified, candidate-only, blocked, and missing capability states.
- [x] Update `core/mvp-readiness.js` and `core/acceptance-report.js` so capability pass/fail status matches the proof matrix.
- [x] Update `core/grounded-chat.js`, Monitor, Tune Pod, and the VS Code companion summaries so operator-facing status reflects the real verified engine state.

### Track D: Only After Tracks A Through C Are Green

- [x] Resume `docs/LOCAL_MODEL_BLUEPRINT_CHECKLIST.md` Phase 0 inventory and Phase 1 baseline-bundle work.
- [x] Resume wider promotion or default-bundle work only after the engine proof matrix and honesty surfaces are green.

- 2026-04-01: With the focused engine proof packs, broader honesty surfaces, and proof-artifact flow now locked, the local-model checklist is unblocked again for Phase 0 inventory and Phase 1 baseline-bundle work.

## Promised Capability Matrix

- Ask: success means grounded, useful replies, honest route selection, and no host-side control-token leakage reaching the renderer.
- Plan: success means the planner can produce a bounded next-step plan with clear target files, scope, and validation.
- Code: success means the engine can make real diffs on existing repo slices and report changed files honestly.
- Repair: success means a failing slice can be repaired with a bounded retry loop and a narrow revalidation pack.
- Validate: success means the engine can run the smallest relevant checks without widening back to unrelated repo failures.
- Review: success means the engine can inspect changes, surface real findings, and preserve failed evidence for later review.
- Docs-guided work: success means the engine can request and use trusted repo docs or operator docs without inventing a parallel workflow.
- Scaffold or create-project work: success means the engine can plan and write new files, not just edit existing files.
- Clone-lab autonomy: success means bounded autonomous runs default to scratch labs and can rescope overscoped work into smaller follow-ups.
- Self-improvement: success means training or tuning export work stays gated by the same proof and honesty rules as the rest of the engine.

## Phase 0: Lock The Engine Contract

- [x] Add one canonical engine blueprint section to `docs/BAT_FEATURE_BOARD.md`.
- [x] Define the full promised capability matrix in this checklist.
- [x] Define success criteria for each capability so acceptance can report pass or fail instead of vague readiness.
- [x] Define the rule that the existing desktop shell, existing VS Code companion, and existing tool system remain the operator surface.
- [x] Define the rule that the engine must use current repo tools and VS Code integration rather than a new parallel workflow.

## Phase 1: Control Plane Hardening

- [x] Audit route and config drift across `dev_assistant.yaml`.
- [x] Audit route and config drift across `core/route-schema.js`.
- [x] Audit route and config drift across `core/engine-contract.js`.
- [x] Audit route and config drift across `host/assistant-config.js`.
- [x] Audit route and config drift across `host/agent-runtime-service.js`.
- [x] Audit runtime-side route drift across `runtime/backend/agent/core/model_routing.py`.
- [x] Unify lane IDs, task modes, wrapped roles, execution roles, autonomy flags, and model-role mappings behind one durable contract.
- [x] Remove remaining heavy-model assumptions that block engine proof instead of helping it.

### Phase 1 Audit Notes

- 2026-03-31: `core/route-schema.js` remains the canonical lane and role contract.
- 2026-03-31: The main drift found in Phase 1 was duplicate alias handling across `core/ai-center.js`, `core/engine-contract.js`, `shared-runtime/runtime.js`, and `runtime/backend/agent/core/model_routing.py`.
- 2026-03-31: `dev_assistant.yaml` now keeps the baseline, workspace, and training defaults on `qwen2.5-coder:7b`; the heavier `qwen2.5-coder:14b` route remains an explicit coder-lane override instead of the silent base assumption.
- 2026-03-31: Runtime planner, validator, and release fallbacks now stay on `qwen2.5-coder:7b` so non-coder engine proof does not widen into a heavier lane by default.

## Phase 2: Runtime Coding Loop Completion

- [x] Verify planner context selection reliably finds the right repo files for coding tasks.
- [x] Verify the planner can generate bounded edit plans for existing repo changes.
- [x] Verify the planner can generate bounded scaffold or create-project plans when the task requires new files.
- [x] Verify execution can apply edits, create files, and record changed files consistently.
- [x] Verify bounded validation remains narrow and does not widen back to unrelated repo failures.
- [x] Verify review artifacts capture failed edit or synthesis evidence clearly.
- [x] Verify overscoped tasks become `needs-rescope` follow-ups instead of silent failures.
- [x] Verify clone-lab routing remains the default proof path for autonomous coding and repair.

### Phase 2 Proof Notes

- 2026-03-31: `planning_service.py`, `repo_inspection.py`, and `runtime_context.py` now share explicit repo-path extraction so objective text like `src/local-proof-widget.ts` or scaffold target lists can outrank unrelated strategy matches in planner context selection.
- 2026-03-31: `tool_loop.py` planner coverage now locks bounded edit planning for existing files alongside scaffold/create targets, so explicit repo-edit objectives no longer collapse into generic unrelated matches.
- 2026-03-31: `tool_loop.py` now merges execution-observed file paths back into `runtime_context.changed_files` and review-bundle change summaries, so create/edit runs still report honest changed files even when `git status` is unavailable or incomplete.
- 2026-03-31: `tool_loop.py` validator proof now explicitly locks the bounded repair-validation command path, so a focused runtime command from `failure_output.checks` stays in place instead of widening back to repo-wide `npm test`.
- 2026-03-31: Failed synthesized-edit normalization already preserves raw candidate artifacts through `build_review_summary`, and focused runtime-service/autonomy tests now confirm overscoped or empty-patch runs auto-queue `needs-rescope` follow-ups while task-loop coding defaults to clone labs for proof work.

## Phase 3: Existing Tool And VS Code Reuse

- [x] Reuse `core/tool-catalog.js` as the canonical tool surface.
- [x] Reuse `main.js` and `preload.js` as the desktop tool bridge.
- [x] Reuse `integration-library/extensions/vscode-companion/extension.js` as the VS Code coding surface.
- [x] Close desktop and VS Code parity gaps for task launch, open-file handoff, trace inspection, review flow, and safe coding actions.
- [x] Verify the VS Code companion stays a client of the engine rather than a second implementation path.

### Phase 3 Audit Notes

- 2026-03-31: `core/tool-catalog.js` remains the canonical tool metadata surface used by the runtime and operator views.
- 2026-03-31: `integration-library/extensions/vscode-companion/extension.js` stays a client of the shared engine/runtime path rather than a second implementation path, and the focused VS Code companion/setup/health test pack is green.
- 2026-04-01: `main.js` and `preload.js` remain the desktop bridge, and the desktop Workbench plus VS Code companion now expose matching trace, file handoff, review, and safe coding entry points through that shared bridge.

## Phase 4: Capability Proof Matrix

- [x] Add a proof pack for conversational ask that stays grounded and useful.
- [x] Add a proof pack for bounded planning on real repo work.
- [x] Add a proof pack for coding on an existing repo slice.
- [x] Add a proof pack for failing-test repair.
- [x] Add a proof pack for review or validate flows.
- [x] Add a proof pack for docs-guided changes when the engine requests trusted documentation.
- [x] Add a proof pack for route-sensitive work.
- [x] Add a dedicated proof pack for scaffold or create-project work.
- [x] Add a proof pack for bounded clone-lab autonomy.
- [x] Add a proof pack for self-improvement that is gated by the same engine honesty rules.
- [x] Add a proof artifact for the current Python-backed engine path and routed CLI model path on every bounded pass.

### Phase 4 Proof Notes

- 2026-03-31: `npm run proof:route-quality` is now the explicit route-sensitive proof pack and is green after the latest planner-context and tool-loop reporting changes.
- 2026-03-31: The scaffold/create-project proof path is now first-class through `tests/tool-loop-planner.test.js`, including explicit multi-file scaffold planning and end-to-end changed-file reporting through `run_tool_loop`.
- 2026-03-31: `tests/agent-runtime-service.test.js` and `tests/autonomous-actions.test.js` now serve as the focused bounded clone-lab autonomy proof pack, covering clone-lab default routing plus automatic `needs-rescope` follow-up generation for overscoped or empty-patch work.
- 2026-04-01: `npm run test:repair-proof` is now the focused failing-test repair proof pack, combining `tests/engine-cli-repair-proof.test.js`, `tests/engine-contract.test.js`, and `tests/agent-runtime-service.test.js` so repair routing, CLI proof rows, and bounded repair-loop behavior stay locked together.
- 2026-04-01: Named proof-pack scripts now exist for Ask, Plan, Code, Review or Validate, Docs-guided work, Self-improvement, Honesty, and Promotion coverage, with `npm run proof:engine-focus` and `npm run proof:engine-gate` locking the focused-proof-before-acceptance order.

## Phase 5: Route Hardening And Regression Expansion

- [x] Keep the current `npm run proof:route-quality` gate green.
- [x] Expand route regression coverage wherever route naming, task-mode routing, and promotion safety can drift.
- [x] Expand tool-loop regression coverage for scaffold, edit synthesis, append, create, and repair flows.
- [x] Expand planner-ranking regression coverage for create-project and scaffold targets.
- [x] Expand VS Code companion regression coverage for engine parity.
- [x] Expand system-check and readiness regression coverage so capability summaries stay honest.
- [x] Expand promotion regression coverage so only proven route bundles can go live.
- [x] Make scaffold or create-project proof a first-class regression path.

- 2026-04-01: The VS Code companion regression pack now covers composed workbench payload parity, trace-document export, and shared review-decision writes, so engine proof, review state, and trace inspection no longer rely only on source-pattern assertions.
- 2026-04-01: Route, honesty, and promotion regression coverage now have dedicated script surfaces through `npm run test:route-parity`, `npm run test:honesty-proof`, and `npm run test:promotion-proof`.

## Phase 6: Operator Honesty Surfaces

- [x] Update `core/system-check.js` to distinguish verified, candidate-only, blocked, and missing capability.
- [x] Update `core/mvp-readiness.js` to reflect the full engine proof matrix instead of partial success.
- [x] Update `core/grounded-chat.js` to reflect engine-backed grounded help and next-step reporting honestly.
- [x] Update `core/acceptance-report.js` so acceptance reports explicitly show pass or fail by capability.
- [x] Update Monitor, Tune Pod, and companion summaries so they report the real engine state rather than implied readiness.

## Phase 7: Acceptance And Handoff Order

- [x] Lock the execution order as control plane, runtime loop, tool and VS Code parity, proof matrix, regressions, honesty surfaces, then autonomy widening.
- [x] Keep focused proofs green before wide acceptance.
- [x] Run engine acceptance only after the focused engine proof packs are green.
- [x] Record any missing capability as blocked work, not as an implied future promise.

- 2026-04-01: `npm run proof:engine-focus` is now the canonical focused-proof sequence, and `npm run proof:engine-gate` adds the acceptance step only after those focused packs complete successfully.

## Engine Verification Checklist

- [x] Run `npm run test:ui-shell`.
- [x] Run `npm run test:route-parity`.
- [x] Run `npm run test:planner-ranking`.
- [x] Run `node --test ./tests/tool-loop-planner.test.js`.
- [x] Run `node --test ./tests/vscode-companion-extension.test.js ./tests/vscode-setup.test.js ./tests/vscode-extension-health.test.js`.
- [x] Run focused system-check and readiness tests.
- [x] Run the scaffold or create-project proof pack.
- [x] Run `npm run proof:engine-focus`.
- [x] Run `npm run engine:acceptance`.

## Engine Relevant Files

- `docs/BAT_FEATURE_BOARD.md`
- `dev_assistant.yaml`
- `core/route-schema.js`
- `core/engine-contract.js`
- `host/assistant-config.js`
- `host/agent-runtime-service.js`
- `runtime/backend/agent/core/planning_service.py`
- `runtime/backend/agent/core/execution_service.py`
- `runtime/backend/agent/core/tool_loop.py`
- `runtime/backend/agent/core/patch_review.py`
- `runtime/backend/agent/core/model_routing.py`
- `core/tool-catalog.js`
- `main.js`
- `preload.js`
- `integration-library/extensions/vscode-companion/extension.js`
- `core/system-check.js`
- `core/mvp-readiness.js`
- `core/promotions.js`
- `core/acceptance-report.js`

## Working Rules For Updating This Checklist

- [x] When a checklist item is implemented, mark it done here and in `docs/BAT_FEATURE_BOARD.md` if it changes durable repo policy.
- [x] When a proof fails, add the missing capability as blocked work instead of silently carrying it forward.
- [x] When a route, engine, or proof rule changes, update the relevant verification checklist in the same pass.
- [x] Keep the existing desktop shell, existing VS Code companion, and existing tool catalog as the main product path.
