# GoSenderr Unified Board And Operating Manual

This file is the single governance board for the repo. It owns policy, active categorization, layer baselines, cleanup backlog, command-book rules, and the main work queue.

## 1. Board Ownership

- Treat this file as the only governance board and operating manual for the repo.
- Keep detailed layer execution state in linked checklist files, not in competing boards.
- Keep generated proof and report markdown files as linked artifacts, not as policy owners.
- Treat `OWNER_DOCS/`, `HOW_TO_USE/`, `WINDOWS_HOW_TO/`, and `docs/desktop-agent/` as reference material only unless this board explicitly promotes a file back into governance ownership.
- If an older doc still claims to be the primary roadmap, board, or operating manual, reroute or archive it.

Linked layer checklists:

- `docs/ENGINE_BLUEPRINT_CHECKLIST.md` owns detailed engine execution tracking.
- `docs/LOCAL_MODEL_BLUEPRINT_CHECKLIST.md` owns detailed model execution tracking after the engine proof gate is ready.

Generated artifacts:

- `docs/LOCKED_PLAN_SUMMARY.md` is the current multi-phase plan anchor.
- `docs/ENGINE_MODEL_PROOF.md` is the per-pass proof artifact.
- `docs/ENGINE_DAILY_REPORT.md` is the current manager-style audit report.
- `docs/ENGINE_BASELINE.md` is the generated engine baseline snapshot.

## 2. Canonical Rules

- Treat this file as the repo operating manual.
- Do not hand-edit generated runtime copies under `dist/` or `WINDOWS_APP/`.
- Prefer source files under `runtime/`, `core/`, `renderer-src/`, `shared-runtime/`, and root Electron files.
- Edit source-of-truth files only: `renderer-src/*`, `main.js`, `preload.js`, `core/*`, `shared-runtime/*`, and `runtime/backend/*`.
- Treat `renderer/*` as generated output that should be refreshed from source instead of hand-edited.
- If code or docs are retired but might still matter later, move them under `archive/` with a short note instead of hard-deleting them on the first pass.
- Keep the desktop UI shell and current feature surface intact while fixing behavior.
- Prefer layered fixes over one-off patches.
- Baseline target rule: treat self-hosted engine autonomy, clone-lab autopilot preview, and local-first model parity as the product baseline target; when the engine cannot safely finish a full task yet, rescope it into smaller bounded jobs instead of widening remote dependence by default.
- Daily audit rule: treat `docs/ENGINE_DAILY_REPORT.md` as the canonical manager pull report for today; it should capture the completed audit checklist, open maintenance work, newly observed problems, missing engine capabilities, and audit notes for the current window.
- Engine-first blueprint rule: the full execution checklist now lives in `docs/ENGINE_BLUEPRINT_CHECKLIST.md`; this board still owns policy, gating, and activation order, and the engine checklist must be updated as implementation lands.
- Model-second blueprint rule: the gated local-model checklist now lives in `docs/LOCAL_MODEL_BLUEPRINT_CHECKLIST.md`; do not advance default-bundle promotion ahead of the matching engine proof phase.
- Locked-plan summary rule: every new multi-phase engine or model expansion plan must be written into `docs/LOCKED_PLAN_SUMMARY.md` and linked back to the blueprint checklist so future work stays anchored to one locked markdown summary instead of scattered chat notes.
- Per-pass proof rule: every bounded engine or model pass must refresh `docs/ENGINE_MODEL_PROOF.md` through `npm run engine:cli -- proof-summary ...` so the current Python runtime path, routed CLI model path, acceptance gate, and learning envelope stay visible.
- Focused proof order rule: keep focused engine proof packs green in this order before broad acceptance or autonomy widening: control plane, runtime loop, desktop and VS Code parity, capability proof matrix, regression packs, honesty surfaces, then wider autonomy or model-default work.
- Acceptance gate rule: run `npm run proof:engine-focus` before `npm run engine:acceptance`, and prefer `npm run proof:engine-gate` when you need the full focused-proof plus acceptance sequence in one command.
- Missing capability rule: when any focused proof fails, record the gap as blocked work on the active checklist or board instead of carrying it forward as an implied future promise.
- Artifact ownership rule: generated artifacts may summarize current state, but they do not replace the board for policy, prioritization, or cleanup ownership.
- Cleanup rule: fix active blockers now, but queue non-blocking duplication, stale docs, reroutes, and structural debt on this board so cleanup does not disappear behind feature work.
- Promotion rule: run `npm run engine:acceptance` before treating engine changes as ready.
- For Windows work, prefer the workspace tasks under `scripts/windows/*.ps1` and the VS Code tasks already defined in the workspace.

## 3. Board Map

Governance owner:

- `docs/BAT_FEATURE_BOARD.md` for policy, board categories, layer baselines, cleanup backlog, command-book rules, and active BAT queue.

Linked execution trackers:

- `docs/ENGINE_BLUEPRINT_CHECKLIST.md` for engine-first execution details.
- `docs/LOCAL_MODEL_BLUEPRINT_CHECKLIST.md` for gated model-second execution details.

Generated status and proof artifacts:

- `docs/LOCKED_PLAN_SUMMARY.md`
- `docs/ENGINE_MODEL_PROOF.md`
- `docs/ENGINE_DAILY_REPORT.md`
- `docs/ENGINE_BASELINE.md`

Reference-only guide trees:

- `OWNER_DOCS/`
- `HOW_TO_USE/`
- `WINDOWS_HOW_TO/`
- `docs/desktop-agent/`

## 4. Status Truth Hierarchy And Layer Baselines

Status-truth hierarchy:

1. Routing and role truth: `core/route-schema.js` and `core/engine-contract.js`
2. Acceptance and proof truth: `core/acceptance-report.js`
3. Readiness synthesis: `core/mvp-readiness.js`
4. Operator honesty aggregation: `core/system-check.js`
5. Operator-facing summaries: `core/grounded-chat.js`, desktop Monitor, Tune Pod, and the VS Code companion
6. Generated proof and audit artifacts: `docs/ENGINE_MODEL_PROOF.md`, `docs/ENGINE_DAILY_REPORT.md`, and `docs/ENGINE_BASELINE.md`

Layer baselines:

- Governance baseline: this board owns policy, categorization, and cleanup state.
- Engine execution baseline: `docs/ENGINE_BLUEPRINT_CHECKLIST.md` owns engine delivery detail.
- Model baseline: `docs/LOCAL_MODEL_BLUEPRINT_CHECKLIST.md` owns post-engine model delivery detail.
- Proof baseline: `core/acceptance-report.js` plus `docs/ENGINE_MODEL_PROOF.md` capture bounded proof.
- Operator honesty baseline: `core/system-check.js`, `core/grounded-chat.js`, Monitor, Tune Pod, and the companion must agree on the same status vocabulary.
- Cleanup baseline: this board owns fix-now and clean-later cleanup items so duplicates and stale paths stay visible.

## 5. Cleanup Backlog

Fix now:

- `BAT<CLEANUP-BOARD-001>` ACTIVE: Keep this board as the only governance owner, sync linked checklist ownership language, and archive clearly stale roadmap/UI-plan docs that still claim primary planning status.
- `BAT<CLEANUP-TRUTH-001>` ACTIVE: Normalize status and proof vocabulary across `core/acceptance-report.js`, `core/mvp-readiness.js`, `core/system-check.js`, and `core/grounded-chat.js` so operator honesty surfaces stop duplicating similar but different pass/warn/proven/blocked rules.
- `BAT<CLEANUP-DOCS-LEARNING-001>` ACTIVE: Feed docs-guided learning evidence into the shared honesty path so trusted-doc guidance shows up in `core/system-check.js`, grounded replies, and related operator summaries instead of staying CLI-only metadata.
- `BAT<CLEANUP-WINDOWS-DOCS-001>` ACTIVE: Remove stale Mac-first and cross-platform drift from Windows-facing guide entry points, especially `WINDOWS_HOW_TO/README.md`.

Clean later:

- `BAT<CLEANUP-ARCHIVE-001>` TODO: Archive stale roadmap/UI-plan docs under `docs/desktop-agent/` and reroute remaining references to this board plus the linked checklists.
- `BAT<CLEANUP-GUIDES-001>` TODO: Normalize topic ownership across `OWNER_DOCS/`, `HOW_TO_USE/`, and `WINDOWS_HOW_TO/` so one guide tree owns each topic without competing with the board.
- `BAT<CLEANUP-STATUS-ENUM-001>` TODO: Move shared status vocabulary and proof labels into one reusable source so generated artifacts and operator surfaces stop hand-rolling similar labels.
- `BAT<CLEANUP-DOCS-DRIFT-001>` TODO: Remove remaining stale Mac-first examples, duplicate release guidance, and repeated command-book snippets after board-first consolidation is stable.

## 6. Architecture In One View

```text
renderer-src/ + renderer/
  -> preload.js
    -> main.js
      -> core/*.js
      -> shared-runtime/*.js
        -> runtime/backend/agent/runtime/*.py
          -> planning / execution / validation / repair / release stages
```

Primary ownership by layer:

- UI and layout: `renderer-src/`, `renderer/`
- Electron shell and IPC: `main.js`, `preload.js`
- Desktop composition and operational helpers: `core/`
- Runtime bridge and spawned process management: `shared-runtime/`
- Actual agent engine and orchestration: `runtime/backend/agent/`

## 7. Current Audit Snapshot

What is working:

- Acceptance baseline is green after the `reportRendererError` contract/type fix.
- Runtime bootstrap now prefers real workspace virtual environments before launcher fallbacks, preflight checks the live `runtime/backend/*` paths, and roadmap validation/focus cards ignore infrastructure-only startup failures instead of replaying them as work-state debt.
- Planner related-file selection now surfaces imported JS source files from failing tests.
- The engine can now target `src/calculator.js` in the disposable broken Node lab.
- The tool loop can now synthesize and apply a real file edit for repair/edit objectives, including mixed model responses that wrap file contents in prose plus fenced blocks.
- The settings shell is back in parity with the focused UI contract, including the in-panel provider key flow, `Composer height`, companion-install affordances, and the queued-task toggle labels expected by `tests/ui-shell.test.js`.
- The desktop shell now follows the four-screen operator split directly in the primary UI: Chat, Workbench, Tune Pod, and Settings, with IDE/tool lanes nested under Workbench instead of living as a fifth top-level destination.
- The desktop shell now has a first-class IDE workspace that exposes tool catalog visibility, VS Code bootstrap and companion install actions, editor handoff, and terminal-lane launch points without burying them under Settings.
- The default codex shell presentation is now a lighter, cleaner desktop-app surface with a dark navigation rail and white work panels so the chat-first workspace reads more like a professional product UI than a debug console.
- The Windows validation wrapper now fails fast on external command exit codes instead of masking failing `npm` steps.
- Validator `git_status` now skips cleanly in disposable non-git labs instead of surfacing fatal repository noise.
- The repo now has a cheap focused `npm run test:ui-shell` regression path for the settings-shell contract.
- Self-host runtime-context refreshes now reuse stable baseline/docs/config sections within a run, and repair retries inherit the last bounded validation command pack instead of widening back to unrelated checks.
- The desktop shell now exposes in-app desktop update controls, including a check/download/install path in Settings and a live install button when a downloaded release is ready.
- Desktop update selection now ignores staged installers that are not newer than the running app version, and staged release ordering is version-first so an older touched file cannot outrank a newer build.
- Windows packaging now survives locked previous `win-unpacked` output by falling back to a fresh timestamped build directory instead of failing the whole `Desktop Agent PC: Package Win` task on `EBUSY` cleanup errors.
- Update and promotion surfaces now show rollback readiness directly from workspace recovery data so operators can see the last safe unwind path before triggering install, update, or promotion actions.
- The live Windows RTX 4060 local-model baseline is re-verified for the current Qwen route stack after the synthesized-edit recovery work, the clean broken-node lab replay, and a passing `npm run engine:acceptance`.
- The AI settings and Monitor now share one helper-backed route vocabulary for route overrides, capability-route tuning, and the local-model ladder copy instead of duplicating those strings inline.
- The local-model Phase 0 and baseline-bundle policy now live in source: `core/training-tuning.js` classifies approved defaults, candidate-only models, and larger-headroom candidates, while `host/assistant-config.js`, `core/ai-center.js`, and `core/system-check.js` surface the mixed live 7B/14B route state honestly in config review and operator summaries.
- `system-check` fallback lane summaries now keep `chat-fast` on the engine/orchestrator path even when lane role metadata is incomplete, which matches the live AI status contract.
- Focused route cleanup tests now lock the cleaned-up UI wording and the `chat-fast` engine-role parity across `ai-center`, `engine-contract`, `system-check`, and the bundled UI shell.
- Route naming now has one canonical schema in `core/route-schema.js`: each lane declares its loop task mode, model-routing task mode, wrapped profile role, and execution role once, and `ai-center`, `engine-contract`, `system-check`, and `promotions` all read that shared map instead of maintaining separate lane-role fallback tables.
- The repo now has an `archive/` workflow for retiring old code or docs safely instead of deleting possibly-useful material on the first cleanup pass.
- Desktop rollback archive proof now covers both `darwin` and `win32` archive roots in the focused app-backup regression pack.
- The engine daily report now acts as the manager-style maintenance checklist for the current window, including completed audit checks, open actions, newly observed problems, missing capability gaps, and an audit log written to `docs/ENGINE_DAILY_REPORT.md`.
- The repo now has an explicit `npm run proof:route-quality` command that runs the UI shell contract, focused route parity pack, and engine acceptance as one reusable minimum gate for route-sensitive work.
- The repo now has explicit engine-first and model-second execution checklists in `docs/ENGINE_BLUEPRINT_CHECKLIST.md` and `docs/LOCAL_MODEL_BLUEPRINT_CHECKLIST.md`, with the board remaining the canonical policy and gating source.
- Planner context selection now boosts explicit repo paths named in the objective, so bounded coding or scaffold tasks can target the right files even when generic strategy matches point elsewhere.
- Tool-loop runtime reporting now merges execution-observed file paths back into `runtime_context.changed_files` and review-bundle summaries, so non-git or scratch-lab runs still report honest changed-file evidence after create/edit work.
- `scripts/engine-cli.js` now records CLI prompt starts and execution outcomes into the shared learning journal, so successful edit and repair runs can warm reusable prompt guidance instead of leaving CLI-only prompt patterns invisible.
- Local-model promotion governance now reuses the shared per-model proof matrix in `core/promotions.js` and `core/system-check.js`, so local candidates stay blocked until the tracked ask/plan, code, repair, review, docs-guided, scaffold, and clone-lab autonomy proofs are verified alongside the existing 32 GB route guardrails.
- The repo now has a repeatable `npm run engine:cli -- models proof` workflow that executes the focused proof packs per foundry candidate, records benchmark evidence against the candidate identity, and persists a proof summary back onto the candidate so Phase 3 model proof can be re-run before promotion without hand-seeding benchmark rows.
- Tune Pod and route-plan summaries now reuse the same local-model policy snapshot as `core/system-check.js`, so approved defaults, candidate-only models, and mixed live route state stay visible in one vocabulary instead of flattening everything into generic readiness counts.
- Route-bundle promotion now treats the live config write as the final approval freeze: `core/promotions.js` refuses to rewrite the live model bundle unless the foundry route, acceptance gate, 32 GB guardrails, and per-model proof requirement are all green, and successful promotions persist the frozen approved bundle metadata for rollback and audit surfaces.

What is still broken:

- The learning journal large-file path is functionally correct but still expensive enough that the large-journal regression test is a noticeable hotspot in the repo test suite.
- Older docs still contain stale Mac-first examples and duplicate information.

## 8. Agent Working Contract

If you are Copilot, Codex, or another repo agent:

- Read this file first.
- Use the board section below as the active work queue.
- Keep fixes small, source-rooted, and reversible.
- Do not spread new workflow docs across multiple files unless this file explicitly says to split them.
- The engine and local-model blueprint checklists are the explicit exception to that rule because the live execution tracker is too large to keep inline here.
- If a rule here conflicts with an older doc, prefer this file.
- If you add a new durable workflow, add it here first and only create a dedicated doc if the section becomes too large.
- If you touch engine-phase status or model-phase status, update the relevant checklist in the same pass.

## 9. Windows Command Book

Primary workspace tasks:

- `Desktop Agent PC: Bootstrap`
- `Desktop Agent PC: Validate`
- `Desktop Agent PC: Start Dev`
- `Desktop Agent PC: Package Win`
- `Desktop Agent PC: Install recommended models`

Install note:

- The Windows recommended-model task pulls the registry-backed Qwen models directly and stages DeepSeek/Qwen3 GGUF files into `assistant_training_model_storage_root`; import those staged files from Settings -> AI -> Import all stored models.
- If `HF_TOKEN` or `HUGGINGFACE_API_KEY` is saved in Settings -> AI -> API keys, the Windows recommended-model task will pick it up automatically for authenticated Hugging Face downloads.
- Windows task scripts now pin desktop app state, temp files, npm/pip caches, Hugging Face cache, and Ollama model paths to the configured E-drive live offload root, while promotions, release archives, and migration backups can be pinned to the configured D-drive cold-storage root.

Primary npm commands:

```powershell
npm run engine:acceptance
npm run test:ask-proof
npm run test:plan-proof
npm run test:code-proof
npm run test:review-proof
npm run test:docs-proof
npm run test:self-improve-proof
npm run test:honesty-proof
npm run test:promotion-proof
npm run proof:engine-focus
npm run proof:engine-gate
npm run proof:route-quality
npm run engine:daily-report
npm run engine:cli -- audit
npm run engine:cli -- plan "Plan the next safe coding task."
npm run engine:cli -- proof-summary --title "Current engine pass"
npm run engine:cli -- models proof --candidate-id "<foundry-candidate-id>"
npm run test:repair-proof
npm run engine:cli -- edit --yes "Prepare the smallest safe fix for the current issue."
npm run engine:cli -- repair --lab "E:\dev\projects\gosenderr_dev_offload\assistant_labs\scratch\<lab-name>"
npm run engine:cli -- repair --lab "E:\dev\projects\gosenderr_dev_offload\assistant_labs\scratch\<lab-name>" --validation-command "node --test tests/<focused>.test.js"
npm test
```

Bounded repair proof rule:

- When the repo-wide baseline is already red or the objective is intentionally narrow, pass one or more `--validation-command` overrides to `engine:cli` so clone-lab edit and repair runs are judged against the smallest relevant proof instead of unrelated suite failures.
- Use `npm run engine:daily-report` or `npm run engine:cli -- audit` before manual triage so the current-day maintenance checklist and missing-capability notes are regenerated from live board and runtime evidence instead of stale notes.

Use these in order when changing engine behavior:

1. Run acceptance.
2. Reproduce in a disposable lab.
3. Fix source files, not generated copies.
4. Re-run the smallest relevant validation.
5. Run `npm run proof:route-quality` when routing, repair, validation, or operator wording changed.
6. Re-run acceptance.

## 10. Operating Workflow

Standard safe loop:

1. Ask: understand the problem and current repo state.
2. Plan: choose the smallest bounded target.
3. Edit: prepare or apply the change.
4. Agent: only when you want bounded autonomous execution.
5. Acceptance: confirm the engine baseline is still healthy.

Blueprint update loop:

1. Check `docs/ENGINE_BLUEPRINT_CHECKLIST.md` before engine work and keep that checklist ahead of model work.
2. Check `docs/LOCAL_MODEL_BLUEPRINT_CHECKLIST.md` only when the corresponding engine phase or proof gate is ready.
3. Mark completed checklist items in the blueprint doc and update this board too if the change affects durable policy or workflow.
4. Work the short ordered checklist at the top of `docs/ENGINE_BLUEPRINT_CHECKLIST.md` before pulling from the broader phase backlog.

Retirement and archive rule:

1. If code or docs are no longer active but still might matter later, move them into `archive/<yyyy-mm-dd>-<topic>/` instead of deleting them immediately.
2. Add a short note in that archive folder that says what was moved, where it came from, why it was retired, and what replaced it.
3. Archive source-side material only. Do not use `archive/` as a dump for generated output under `renderer/`, `dist/`, or `WINDOWS_APP/`.

For engine debugging:

1. Reproduce in a scratch lab.
2. Capture raw runtime output when the UI summary is too compressed.
3. Verify target-file ranking, plan steps, execution steps, and changed-file detection in that order.
4. Fix the earliest stage that is wrong.

## 11. Error Finder And Bug Finder

Use this triage order:

1. Contract mismatch: preload, IPC, type declarations, and renderer assumptions do not line up.
2. Context failure: planner or runtime context misses the real target files.
3. Execution failure: implementer has the right target but never writes.
4. Validation failure: change applied but checks fail.
5. Artifact/reporting failure: change succeeded but changed files or summaries are not recorded.

When debugging the engine, capture these artifacts if needed:

- acceptance report under offload benchmarks
- latest runtime dump JSON
- lab test output
- runtime context `related_files`
- tool audit trail

## 12. Upgrade And Layering Rules

- Keep engine orchestration separate from desktop UI composition.
- Keep repair heuristics language-aware, not Python-only.
- Prefer shared ranking/inference helpers over duplicated one-off logic.
- Keep board and workflow policy centralized here.
- Add plugin-ready seams at the ranking, planning, execution, and validation layers rather than inside UI code.

## 13. Active Board

- BAT<CLEANUP-BOARD-001> ACTIVE: Keep `docs/BAT_FEATURE_BOARD.md` as the only governance board, keep the engine/model files as linked layer checklists, and archive stale roadmap/UI-plan docs that still claim primary roadmap ownership.
- BAT<CLEANUP-TRUTH-001> ACTIVE: Normalize status/proof vocabulary and ownership across `core/acceptance-report.js`, `core/mvp-readiness.js`, `core/system-check.js`, and `core/grounded-chat.js` so the board, proofs, and operator surfaces all describe the same baseline honestly.
- BAT<CLEANUP-GUIDES-001> TODO: Clarify reference-guide ownership across `OWNER_DOCS/`, `HOW_TO_USE/`, and `WINDOWS_HOW_TO/` after the board-first consolidation lands, without creating another governance source.
- BAT<ENGINE-BLUEPRINT-001> ACTIVE: Use `docs/ENGINE_BLUEPRINT_CHECKLIST.md` as the live engine-first execution tracker; work the short ordered checklist at the top first, then keep the capability matrix, proof matrix, and phase status current there as implementation lands.
- BAT<ENGINE-CLI-EXPANSION-001> ACTIVE: Expand `scripts/engine-cli.js` so Ask and Plan can take trusted online docs, expose docs-aware CLI commands, keep a locked markdown progress summary tied back to `docs/ENGINE_BLUEPRINT_CHECKLIST.md`, and emit a per-pass engine model proof summary in `docs/ENGINE_MODEL_PROOF.md`.
- BAT<ENGINE-BLUEPRINT-002> DONE: Complete the Phase 1 control-plane audit across `dev_assistant.yaml`, `core/route-schema.js`, `core/engine-contract.js`, `host/assistant-config.js`, `host/agent-runtime-service.js`, and `runtime/backend/agent/core/model_routing.py`, including removing silent 14B baseline assumptions from the shared Windows proof path.
- BAT<MODEL-BLUEPRINT-001> ACTIVE: Use `docs/LOCAL_MODEL_BLUEPRINT_CHECKLIST.md` as the gated model-second execution tracker; do not promote default-bundle work ahead of the matching engine proof phase.
- BAT<MODEL-BLUEPRINT-002> DONE: Land the 32 GB default-bundle guardrails across `core/training-tuning.js`, `core/engine-contract.js`, `core/ai-center.js`, `core/promotions.js`, `core/system-check.js`, and `runtime/backend/agent/core/model_routing.py` so oversized or candidate-only local defaults fall back to the approved 7B/3B bundle and blocked route bundles no longer promote into live.
- BAT<ENGINE-001> DONE: Replace the read-only fallback in `runtime/backend/agent/core/tool_loop.py` so repair/edit runs can synthesize `edit_file` or `smart_patch` execution steps instead of stopping at `inspect_file`.
- BAT<ENGINE-002> DONE: Make validation tolerant of non-git disposable labs by skipping or downgrading `git_status` when no `.git` root exists.
- BAT<ENGINE-003> DONE: Re-run the disposable broken Node lab after `ENGINE-001` and confirm the engine produces a real diff and a passing `npm test`.
- BAT<OPS-003> DONE: Make `scripts/windows/validate.ps1` fail fast on external command exit codes so `npm test` regressions cannot be hidden by later steps.
- BAT<UIUX-DESKTOP-001> DONE: Keep desktop app UI/UX progress visible on this board; the current shipped baseline includes the four-screen shell split, first-class IDE workspace, focused settings-shell contract, and lighter codex-style presentation already landed in `renderer-src/main.tsx`.
- BAT<UIUX-COMPANION-001> DONE: Close the current desktop-versus-companion parity pass for task launch, trace or file handoff, shared review evidence, and bounded safe coding action reachability in `integration-library/extensions/vscode-companion/extension.js`, while `docs/ENGINE_BLUEPRINT_CHECKLIST.md` keeps the execution trail.
- BAT<UIUX-COMPANION-002> DONE: Add a CLI-backed `Self improve` action to the VS Code companion so one bounded supervised self-improvement pass can launch from the companion in a dedicated terminal and refresh the shared proof path without blocking the active chat workbench.
- BAT<UIUX-COMPANION-003> DONE: Add a CLI-backed `Autopilot` action to the VS Code companion so one bounded supervised autopilot pass can launch from the companion in a dedicated terminal and refresh the shared proof path without blocking the active chat workbench.
- BAT<UIUX-COMPANION-004> DONE: Align the companion packaging metadata and source-of-truth entry so `extension.js` stays canonical, `src/extension.ts` delegates to it, and workspace-copy install remains the default release path until a formal VSIX lane is proven.
- BAT<UI-001> DONE: Restore settings-shell parity in `renderer-src/main.tsx` by replacing the prompt-based remote key flow with an in-panel field and reintroducing the `Composer height` control expected by `tests/ui-shell.test.js`.
- BAT<QUALITY-002> DONE: Add a focused validation path for the settings-shell contract so the repo can catch `ui-shell.test.js` regressions before broader validation or packaging runs.
- BAT<OPS-001> DONE: Redirect older docs back to this Windows-first handbook and remove stale hard-coded release examples so owner-facing guidance stays current.
- BAT<OPS-002> DONE: Add a handbook affordance in the app shell so operators can open `docs/BAT_FEATURE_BOARD.md` directly from the chat/manager surface.
- BAT<ARCH-001> DONE: Document source-of-truth edit boundaries here and in desktop reference docs so generated renderer and packaged output copies stay read-only.
- BAT<QUALITY-001> DONE: Add `tests/repo-inspection-ranking.test.js` and `npm run test:planner-ranking` to prove JS/TS test imports promote implementation files into planner search results.
- BAT<PERF-001> DONE: Reduce large-journal tail-read cost in `core/learning-journal.js` and lock the bounded parse behavior with the large-journal regression fixture.
- BAT<DOCS-001> DONE: Retire overlapping daily workflow ownership by routing desktop and owner docs back to this board while keeping them as deeper reference material.
- BAT<OPS-004> DONE: Expose in-app desktop update controls so downloaded desktop releases can be checked, downloaded, and installed from the running app without leaving the shell.
- BAT<MODEL-PLAN-001> DONE: Define the local-model-first MVP ladder, unlock rules, and operator workflow in this board so the next phase is explicit and stable.
- BAT<MODEL-UI-001> DONE: Add a local-model ladder and capability-unlock monitor to the desktop Monitor overview so operators can see what is verified, what is next, and what stays locked.
- BAT<MODEL-001> DONE: Lock planner, coder, and validator lanes to local-first defaults in the routing core and runtime contract so remote models stay fallback-only unless an operator deliberately chooses compare or summary paths.
- BAT<MODEL-002> DONE: Add a canonical local coding proof gate that requires local benchmark coverage for planner, coder, and validator plus a safe acceptance baseline before the local-first block can widen.
- BAT<MODEL-003> DONE: Promote only benchmark-backed local foundry route bundles into the live lane map, back up the active assistant model config, and restore the last known-good bundle on rollback.
- BAT<MODEL-004> DONE: Keep self-improvement and GS-Dev-1 export readiness limited to approved or trusted runs, and clamp that readiness behind a green local-first acceptance baseline.
- BAT<MODEL-BASE-001> DONE: Make local readiness honest on the live machine so routed local-lane status now requires explicitly live Ollama tags and the system-check models area surfaces missing live routed tags instead of treating staged/configured inventory as ready.
- BAT<MODEL-BASE-002> DONE: Capture failed local `synthesize_edit` selections in the runtime review summary so raw candidate patches, scores, previews, and failure reasons survive into run artifacts without reclassifying normal failures as approval-blocked runs.
- BAT<MODEL-BASE-003> DONE: Harden the local synthesized-edit normalization path so shell heredoc writes, echoed instruction preambles, control-token tails, and bounded append/create/edit payloads normalize into file contents; the focused tool-loop regression pack now covers those shapes and the clean broken-node lab replay produced a real local diff again.
- BAT<MODEL-BASE-004> DONE: Import and verify the full routed local stack on this machine, including planner, coder, validator, repair, and compare tags, and fail readiness clearly when any routed tag is missing live registration.
- BAT<MODEL-BASE-005> DONE: Re-run the canonical local coding proof on the baseline labs and acceptance path using only live local routes; on 2026-03-26 the disposable broken Node lab replay produced a real `src/calculator.js` diff plus green `npm test`, and `npm run engine:acceptance` passed with a fresh acceptance artifact.
- BAT<MODEL-BASE-006> DONE: Lock the per-model bring-up recipe into the operator workflow and treat it as mandatory for DeepSeek candidates, Qwen compare lanes, and every future promoted local family before widening defaults.
- BAT<ROUTE-CLEANUP-001> DONE: Reconcile lane IDs, loop task modes, model-routing task modes, wrapped profile roles, execution roles, and fallback role defaults behind the shared `core/route-schema.js` contract so `core/ai-center.js`, `core/engine-contract.js`, `core/system-check.js`, `core/mvp-readiness.js`, `core/promotions.js`, and `host/assistant-config.js` all inherit one durable naming model.
- BAT<UIUX-CLEANUP-001> DONE: Clean up the AI settings and Monitor route surfaces so route overrides, capability-route tuning, and layer labels use one shared naming set across the operator views.
- BAT<UIUX-CLEANUP-002> DONE: Remove hardcoded local-ladder and unlock-copy drift by deriving Monitor wording from the shared `renderer-src/lib/ai-route-copy.ts` helper path instead of separate inline strings in `renderer-src/main.tsx`.
- BAT<QUALITY-ROUTE-001> DONE: Add focused parity tests that fail when `chat-fast` role defaults or cleaned-up route wording drift across `ai-center`, `engine-contract`, `system-check`, and the UI shell.
- BAT<OPS-005> DONE: Add a safe retirement workflow for old code and docs by creating the root `archive/` convention and documenting when to move items there instead of deleting them on the first cleanup pass.
- BAT<AUDIT-002> DONE: Extend the engine daily report so it emits a manager-style maintenance checklist, new-problem queue, missing-capability list, and audit log in `docs/ENGINE_DAILY_REPORT.md` for the current audit window.
- BAT<UIUX-CLEANUP-003> DONE: Keep `route plan`, `workspace coding model`, `engine control model`, and route-ownership wording aligned across every new operator surface by pushing the shared helper-backed copy into the settings shell, engine panel, prompt suggestions, chat help text, and desktop guide instead of leaving one-off labels behind.
- BAT<MODEL-BASE-007> DONE: Unify `staged`, `registered`, `ready`, and `live` local-model readiness vocabulary across the board, Monitor, system-check, CLI summaries, and the daily audit/runtime summaries so operator surfaces now distinguish staged, registered, live, and missing local state consistently.
- BAT<CHAT-QUALITY-001> DONE: Make normal conversational Ask remote-preferred when a remote key is available, keep coding/edit/repair/validate lanes local-first, and sanitize local desktop chat output at the host boundary so control-token leakage does not reach the renderer.
- BAT<CHAT-POLISH-001> DONE: Premium chat polish pass — code fence and heading block rendering in chat messages, inline code and bold rendering, mode-aware progress title/detail, cleaned-up progress card header (animated indicator replaces old eyebrow noise), and mode-aware conversational fallback suggestions for Ask/auto (replaces generic operator shortcut defaults).
- BAT<AUTONOMY-BASE-001> DONE: Default bounded autonomy proof work to clone labs so task-loop coding, repair, and self-host autonomy runs land in scratch self-host labs up front instead of waiting for main-repo safety holds to force a fallback.
- BAT<AUTONOMY-BASE-002> DONE: Auto-queue a bounded `needs-rescope` follow-up when overscoped autonomy work or immediate empty-patch/review-held failures should become a smaller lab-safe retry instead of dying as a one-shot warning.
- BAT<MODEL-PARITY-001> DONE: Record a local-vs-remote parity pack in the acceptance/reporting path for plan, edit, repair, validate, and review so operators can see whether the local workspace stack is matching the remote helper envelope before widening defaults.
- BAT<PERF-ENGINE-001> DONE: Shrink repeated self-host loop overhead by reusing stable runtime-context baseline/docs/config sections during refreshes and by carrying the last bounded validation command pack into repair retries instead of widening back to unrelated checks.
- BAT<QUALITY-ROUTE-002> DONE: Add the explicit `npm run proof:route-quality` gate (`npm run test:ui-shell`, focused route parity tests, and `npm run engine:acceptance`), wire it into the Windows validate flow, and require it in task acceptance guidance whenever routing, repair, validation, or operator wording changes.
- BAT<OPS-006> DONE: Re-prove the route-sensitive update/promotion path with a passing quality proof pack, add recovery summaries to `system-check`, and surface rollback readiness directly in Settings and Monitor wherever operators can trigger updates or promotions.
- BAT<AUDIT-001> DONE: Add a standing layered cleanup audit in this board so route cleanup, UI/UX cleanup, stale docs, naming drift, and cross-layer wiring debt stay visible after the baseline recovery pass.

## 14. Whole-Project Stable Baseline

How to read this section:

- This is the one whole-project stability checklist for the repo.
- Each layer answers five plain questions: what the layer is for, what must stay green, how we prove it, what failure looks like, and what unlocks next.
- Work from the bottom up. If a higher layer regresses, treat the lower verified layer as the real baseline.

Whole-project stable layers:

1. Layer 0: App foundation.
  Status: Working on this machine.
  Goal: The desktop app opens, the main screens load, the workspace target stays correct, and the operator can reach Chat, Workbench, Tune Pod, Settings, and inspector views without hacks.
  Must stay green:
  - [x] The desktop shell keeps the chat-first layout, Workbench inspection surface, Tune Pod, settings center, and inspector reachable.
  - [x] Workspace targeting, lab switching, and VS Code companion setup are exposed from the app.
  - [x] Storage paths, handbook access, and in-app update controls are visible from the normal operator flow.
  Proof:
  - Focused UI shell coverage exists and the settings-shell parity regression path is back in place.
  - The app can open the handbook and surface update controls without leaving the shell.
  Failure signs:
  - Blank or partial shell, missing tabs, wrong workspace target, or IDE/settings/Monitor controls disappearing.
  Next unlock:
  - Daily work only counts as stable if normal chat, planning, coding, and review flow still work from this shell.

2. Layer 1: Daily work baseline.
  Status: Working, with the main operator wording now aligned.
  Goal: A normal day of ask, plan, edit, and review work feels like one system instead of stitched-together surfaces.
  Must stay green:
  - [x] Chat mode, task routing, and workspace targeting produce actionable runs.
  - [x] The code edit flow can scope work, change files, and summarize the result.
  - [x] AI settings and Monitor now share route-copy helpers for the main route labels.
  - [x] Main operator wording now uses one vocabulary for `route plan`, `workspace coding model`, and `engine control model` across the board, UI, and system-check.
  Proof:
  - Focused UI shell tests and route parity tests now guard the main daily-work surfaces.
  - Shared route-copy helpers remove the previous duplicated route wording drift.
  Failure signs:
  - The same route means different things across the UI, runtime, and system-check, or the operator cannot tell which path is active.
  Next unlock:
  - Repair and retest flow only counts as stable if the day-to-day route names and ownership rules stay consistent.

3. Layer 2: Repair and validation baseline.
  Status: Re-verified on 2026-03-26.
  Goal: When work breaks, the app can repair it, rerun the smallest relevant checks, and show honest evidence instead of vague success.
  Must stay green:
  - [x] Repair exists as a dedicated route and task mode instead of being hidden inside generic coder behavior.
  - [x] Repair and edit loops can produce real diffs in disposable labs.
  - [x] Validation and acceptance still catch regressions instead of hiding them.
  - [x] Failed synthesized edits keep raw evidence for later review.
  Proof:
  - The clean broken Node lab replay on 2026-03-26 produced a real `src/calculator.js` fix and a passing lab `npm test`.
  - `npm run engine:acceptance` passed again on the active routed local stack.
  - Focused engine-contract, promotions, system-check, runtime-service, and ai-center route tests are green.
  Failure signs:
  - No-op repairs, empty patches, hidden validation failures, or acceptance going red after a route or repair change.
  Next unlock:
  - AI and model health only counts as stable if the models behind repair and validation are honestly reported as live and loadable.

4. Layer 3: AI and model health baseline.
  Status: Working, with readiness vocabulary aligned on 2026-03-26.
  Goal: The routed AI stack tells the truth about what is live, missing, fallback-only, compare-only, and safe to use on this machine.
  Must stay green:
  - [x] Local readiness now means live in Ollama, not just staged on disk or listed in config.
  - [x] Route naming now has one canonical schema in `core/route-schema.js`.
  - [x] Repair can be routed separately from coder, and route promotion honors that split.
  - [x] Operator vocabulary for `staged`, `registered`, `ready`, and `live` is now aligned across board, Monitor, system-check, CLI summaries, and the daily audit/runtime summaries.
  Proof:
  - `system-check`, `ai-center`, and the daily report all distinguish registered-but-not-live Ollama tags from fully live local routes.
  - Route-schema regression coverage passed in the focused route suite.
  - The live Windows RTX 4060 route stack was re-verified with one-shot load probes on 2026-03-26.
  Failure signs:
  - Monitor says a route is ready while the runtime cannot actually load it, or the same lane resolves to different roles in different surfaces.
  Next unlock:
  - Release and recovery only count as stable if the packaged app, update path, promotion path, and rollback path stay honest about the live route state.

5. Layer 4: Release and recovery baseline.
  Status: Source-ready, keep re-proving it when release workflow changes.
  Goal: Build, package, update, backup, and rollback paths stay boring and safe enough that recovery does not depend on guesswork.
  Must stay green:
  - [x] The app exposes desktop update controls.
  - [x] Assistant model config backup and restore exist for route promotion rollback.
  - [x] Promotion rules are benchmark-backed and rollback-aware.
  - [ ] Packaging, update, and recovery proof should be rerun whenever the release workflow changes.
  - [ ] Backup and rollback status should stay visible where promotions or updates are shown.
  Proof:
  - Promotion tests cover activation and rollback.
  - App rollback archive proof now covers both `darwin` and `win32` desktop directory archives.
  - The board documents the release, backup, and promotion rules in one place.
  Failure signs:
  - A new route becomes default without rollback proof, update controls drift from real behavior, or recovery depends on tribal knowledge.
  Next unlock:
  - Controlled growth only widens after release and recovery stay stable over repeated runs, not one lucky pass.

6. Layer 5: Controlled growth baseline.
  Status: Intentionally limited.
  Goal: Improve the system and widen capability without letting autonomy, remote dependency, or new model families outrun proof.
  Must stay green:
  - [x] Self-improvement stays behind trusted or approved-run gates.
  - [x] Remote models stay explicit helpers for conversational Ask quality, fallback, compare, or approval work instead of silently taking over coding/edit/repair/validate lanes.
  - [ ] Wider autonomy stays locked until the lower layers remain green over time.
  - [ ] Every new model family must repeat the bring-up recipe before promotion.
  Proof:
  - Trust and approval gates already exist in source.
  - The board keeps the bring-up recipe and widening rules explicit.
  Failure signs:
  - Hidden remote dependence, ungated self-improvement, or a new family becoming default because it "felt good" in chat.
  Next unlock:
  - None. This layer stays supervised until the lower layers are boringly stable.

Local-model MVP ladder inside the whole-project baseline:

Goal:

- Make the everyday coding loop local-first so the desktop app and engine can code, repair, review, and improve themselves without depending on a remote model for normal work.
- Treat remote models as the preferred quality path for normal conversational Ask when a remote key is available, while coding/edit/repair/validate lanes stay local-first and remote still covers fallback, comparison, or approval work.
- Expand capability only after the previous block has hard evidence, not just a successful chat demo.

Layer-by-layer local-model ladder:

1. Layer 0: Foundation.
  Exit gate: at least two ready local coding models are installed, the selected local runtime works, and the benchmark path is runnable.
  Scope: Ollama or local runtime health, model import, storage, selector catalog, and one stable default coding model.
2. Layer 1: Local coding parity.
  Exit gate: planner, coder, and validator can all route through a local-first profile, with remote fallback still available but not primary.
  Scope: lane routing, AI profile defaults, workspace-vs-engine model split, and stable local-first settings in the UI.
3. Layer 2: Verified coding block.
  Exit gate: local-first routing passes benchmark plus engine acceptance on the baseline labs, and repair/edit flows produce real diffs and valid reruns.
  Scope: benchmark leader, acceptance proof, repair loop quality, reviewer signals, and regression-builder follow-ups.
4. Layer 3: Foundry and promotion block.
  Exit gate: a benchmark-backed local candidate can move through foundry and promotion with rollback proven.
  Scope: candidate creation, promotion gate, backups, ring history, and local route-bundle promotion.
5. Layer 4: Self-improvement block.
  Exit gate: trusted accepted runs can export training/improvement artifacts without widening unsafe autonomy.
  Scope: approved learning changes, trusted prompts, distillation/training exports, and supervised self-improvement only.
6. Layer 5: Remote minimization block.
  Exit gate: the normal coding solo-dev loop stays local-first, conversational Ask can prefer remote quality when configured, and every remote route remains explicit in policy and operator-visible routing proof.
  Scope: usage policy, conversational quality routing, fallbacks, cost control, and operator-visible routing proof.

Unlock rules:

- Do not unlock a higher block because the model "felt good" in chat. Unlock only when the lower block has artifacts the operator can inspect.
- Benchmark proof must exist before acceptance proof is trusted for model widening.
- Acceptance proof must stay green before autonomy expands beyond bounded supervised work.
- Promotion proof must exist before a candidate becomes the new default route.
- Trusted learning exports must stay gated behind approval or trusted-change filters.
- If a higher block regresses, fall back to the last verified block instead of keeping the wider capability open.

Requested baseline target locked on 2026-03-26:

- The real product baseline is now a self-hosted engine that can plan, rescope, edit, repair, validate, review, and queue the next bounded follow-up in clone labs with a visible autopilot-preview path.
- Local models should carry the normal daily coding loop, while conversational Ask can prefer a configured remote helper for higher-quality natural replies until local chat quality reaches the same bar.
- When the engine is not ready for the whole task, it must break the work into smaller bounded jobs instead of failing the entire objective or silently leaning on a remote path.
- Speed is part of the baseline: the self-host loop must feel fast enough for repeated solo-dev work and small team follow-up loops, not just pass one slow acceptance run.
- This baseline is now the canonical target even though the currently verified state is still narrower; keep the board honest about that gap until the proof is real.

Stable MVP target:

- MVP means the app can plan, edit, repair, validate, and review a normal repo with local-first routing, while the operator can see exactly which capability block is verified, next, or locked.
- The currently verified MVP is not yet "equal to every remote model". The current verified MVP is "good enough to carry the daily solo-dev loop locally, with clear fallback and promotion rules" while the locked baseline target above keeps driving the parity and autonomy work.
- Tune Pod is the operator surface for this baseline: it should show the detected machine fit, selected hardware target, current route plan, verified or next local-model ladder block, and only the local model options that fit the active target while heavier options stay visible as larger-machine candidates.
- When local machine fit or local-first route proof is the blocker, chat and workbench prompt surfaces should point the operator into Tune Pod instead of falling back to a generic queued goal.
- Curated local model presets should carry explicit requirement fields, including RAM and VRAM targets, so Tune Pod can show concrete thresholds rather than only compatible hardware tiers.

Current Windows RTX 4060 starter local stack:

- Approved default proof bundle: `qwen2.5-coder:7b` as the baseline primary route and `qwen2.5-coder:3b` as the low-headroom fallback.
- Current live stack remains intentionally mixed: workspace base, engine base, planner, repair, validator, and summarizer point at `qwen2.5-coder:7b`, while the explicit coder lane still points at `qwen2.5-coder:14b` as a candidate-only route.
- Small backup-only candidate after proof: `phi4-mini:3.8b`.
- Larger-headroom candidate-only routes: `qwen2.5-coder:14b`, `deepseek-coder-v2-lite-instruct:q2-k`, `deepseek-coder-v2-lite-instruct:q4-k-m`, and `qwen3-14b:q4-k-m`.
- Remote models should stay fallback-only until the local benchmark and acceptance blocks are verified.

Current machine baseline recovery block:

- The source-side MVP BATs above are complete, and the live Windows RTX 4060 baseline was re-verified on 2026-03-26 after the local synthesized-edit recovery work landed.
- Readiness for this block means the routed tags are visible to the live Ollama runtime on this machine, not merely staged on disk or listed in config-derived inventory.
- For local mutation lanes, readiness also means a one-shot preflight load check can start the routed model inside current memory headroom before the repair/edit loop begins.
- The main synthesized-edit failure classes that were blocking this machine are now captured or normalized: empty patches survive in runtime review artifacts, and shell-write / echoed-instruction / control-token-wrapped replies normalize before write.
- On this Windows RTX 4060 machine, repair should stay Qwen-only for now: the shared `qwen2.5-coder:14b` coder lane is close enough to the live RAM ceiling that repair preflight can fail under normal desktop load, so the machine-specific repair lane should stay pinned to `qwen2.5-coder:7b` and fall back to the now-proven `qwen2.5-coder:3b` route when headroom is tighter.
- A fresh 2026-03-26 route-load replay proved the active routed local stack can load inside current headroom on this machine: planner/validator/summarizer plus repair all preflight on `qwen2.5-coder:7b`, coder resolves to `qwen2.5-coder:14b`, and the manual compare tag `qwen3-14b:q4-k-m` also passed the one-shot live load probe.
- A fresh 2026-03-26 clean-baseline replay on `dummy-broken-node-app-1774472034725` produced a real `src/calculator.js` repair diff and a passing lab `npm test`, and the same session finished with a passing `npm run engine:acceptance` artifact at `E:\dev\projects\gosenderr_dev_offload\assistant_benchmarks\acceptance\2026-03-26T16-52-18-681Z-engine-acceptance-1774543888624-y6bzpjkz.json`.
- DeepSeek Coder V2 Lite `q2-k` is now imported as a smaller candidate on this machine, but the repair-lane replay still fails the preflight load check with a live Ollama memory-fit error, so the DeepSeek family remains candidate-only here until a genuinely smaller viable route is found.
- Keep the local-first ladder at the re-verified Layer 2 block unless a future local family repeats the bring-up recipe below and clears the same proof sequence.

Per-model bring-up recipe:

1. Verify live runtime readiness for every routed tag in the family and record whether each tag is staged-only, imported, or actually live in Ollama.
2. Run a clean git-lab proof for append, create, and bounded edit objectives, and keep the raw provider response plus candidate-score artifact for every failed attempt.
3. Fix prompt shaping or response normalization until the family can produce deterministic file contents instead of empty patches, shell commands, or fenced/prose-only replies.
4. Re-run the canonical local coding proof and acceptance path with that family carrying only the lanes it is meant to own.
5. Promote the family only after the proof is green, rollback is preserved, and the operator surfaces show live readiness rather than staged-only confidence.
6. Repeat this exact recipe for DeepSeek candidates, the Qwen compare lane, and every later local family before any of them becomes a default or widened route.

Layer follow-through audit:

1. Layer 0 follow-through.
  Need next:
  - [ ] Keep app-start, shell-layout, and workspace-target checks current whenever the settings shell or top-level navigation changes.
  - [ ] Keep handbook, diagnostics, and update entry points visible from the normal operator path.

2. Layer 1 follow-through.
  Need next:
  - [ ] Keep `route plan`, `workspace coding model`, `engine control model`, and related route ownership labels aligned as new operator surfaces are added.
  - [ ] Keep shared route-copy helpers as the only source for repeated route wording in operator surfaces.

3. Layer 2 follow-through.
  Need next:
  - [x] Keep route parity tests, UI shell checks, and `npm run engine:acceptance` as the minimum gate when repair, routing, or validation flow changes.
  - [x] Keep repair evidence honest so failed synthesized edits preserve raw candidate diagnostics.
  - [x] When no explicit daily focus task is marked, let the newest current-workspace blocked or needs-rescope slice become the fallback focus so autonomy blockers stay actionable instead of reading as none recorded.

4. Layer 3 follow-through.
  Need next:
  - [x] Re-run package, update, and rollback proof whenever release workflow or promotion workflow changes.
  - [x] Keep recovery status obvious wherever the operator can trigger promotion or update actions.

5. Layer 4 follow-through.
  Need next:
  - [ ] Re-run package, update, and rollback proof whenever release workflow or promotion workflow changes.
  - [ ] Keep recovery status obvious wherever the operator can trigger promotion or update actions.

6. Layer 5 follow-through.
  Need next:
  - [ ] Keep self-improvement and widening behind trusted proof, not chat feel.
  - [ ] Keep remote conversational Ask preference explicit in policy and routing proof while preventing hidden remote dependency from creeping into coding/edit/repair/validate lanes.

## 15. Audit Plan

Current board status:

1. Section 10 is now the one whole-project stable baseline checklist, and it is organized in layers from app foundation through controlled growth.
2. The live local baseline is back to green for the current Qwen route stack, but the new priority is self-host autonomy proof, automatic task slicing, and local-vs-remote parity rather than more one-off recovery work.
3. The latest main-workspace repair trial held one controlled edit approval, so clone-lab self-host runs should be the default autonomy proof lane until the autopilot-preview path is proven.
4. The highest-value remaining work is to keep route names and readiness states aligned while making the engine smaller-job-first, faster, and honest about the gap between the verified baseline and the new locked target baseline.

Standing layered cleanup audit:

1. Layer 0: App foundation.
  Audit focus:
  - Shell navigation, workspace target, handbook access, diagnostics, and update entry points stay reachable from the normal operator path.

2. Layer 1: Shared operator vocabulary.
  Audit focus:
  - `route plan`, `workspace coding model`, `engine control model`, and route ownership wording stay sourced from shared helpers instead of one-off labels.

3. Layer 2: Route and repair proof.
  Audit focus:
  - `npm run proof:route-quality` remains the named minimum gate for routing, repair, validation, and operator-wording work.
  - Repair runs keep the last bounded validation pack and preserve raw candidate diagnostics when synthesized edits fail.

4. Layer 3: Model and naming parity.
  Audit focus:
  - Readiness terms stay locked to `staged`, `registered`, `live`, and `missing`, and route-schema ownership stays centralized.

5. Layer 4: Release and recovery.
  Audit focus:
  - Update, backup, rollback, and promotion surfaces keep showing the latest recovery path before operators trigger risky actions.
  - Package/update/rollback proof is rerun whenever release or promotion wiring changes.

6. Layer 5: Controlled growth.
  Audit focus:
  - Self-improvement, autonomy widening, and remote usage stay gated by trusted proof instead of convenience or hidden fallback drift.

## 16. Completion Standard

A task on this board is not done until:

- the source fix exists in non-generated files
- the smallest relevant validation passes
- `npm run proof:route-quality` passes for routing, repair, validation, or operator-wording changes
- acceptance still passes if engine behavior changed
- this board is updated if the durable workflow changed