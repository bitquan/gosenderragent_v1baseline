# GoSenderr Unified Board And Operating Manual

This file is the single source of truth for engine work, operator workflow, Copilot guidance, command usage, audit findings, and the active board.

## 1. Canonical Rules

- Treat this file as the repo operating manual.
- Do not hand-edit generated runtime copies under `dist/` or `WINDOWS_APP/`.
- Prefer source files under `runtime/`, `core/`, `renderer-src/`, `shared-runtime/`, and root Electron files.
- Edit source-of-truth files only: `renderer-src/*`, `main.js`, `preload.js`, `core/*`, `shared-runtime/*`, and `runtime/backend/*`.
- Treat `renderer/*` as generated output that should be refreshed from source instead of hand-edited.
- Keep the desktop UI shell and current feature surface intact while fixing behavior.
- Prefer layered fixes over one-off patches.
- Promotion rule: run `npm run engine:acceptance` before treating engine changes as ready.
- For Windows work, prefer the workspace tasks under `scripts/windows/*.ps1` and the VS Code tasks already defined in the workspace.

## 2. Architecture In One View

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

## 3. Current Audit Snapshot

What is working:

- Acceptance baseline is green after the `reportRendererError` contract/type fix.
- Planner related-file selection now surfaces imported JS source files from failing tests.
- The engine can now target `src/calculator.js` in the disposable broken Node lab.
- The tool loop can now synthesize and apply a real file edit for repair/edit objectives, including mixed model responses that wrap file contents in prose plus fenced blocks.
- The settings shell is back in parity with the focused UI contract, including the in-panel provider key flow, `Composer height`, companion-install affordances, and the queued-task toggle labels expected by `tests/ui-shell.test.js`.
- The Windows validation wrapper now fails fast on external command exit codes instead of masking failing `npm` steps.
- Validator `git_status` now skips cleanly in disposable non-git labs instead of surfacing fatal repository noise.
- The repo now has a cheap focused `npm run test:ui-shell` regression path for the settings-shell contract.
- The desktop shell now exposes in-app desktop update controls, including a check/download/install path in Settings and a live install button when a downloaded release is ready.

What is still broken:

- The learning journal large-file path is functionally correct but still expensive enough that the large-journal regression test is a noticeable hotspot in the repo test suite.
- Older docs still contain stale Mac-first examples and duplicate information.

## 4. Agent Working Contract

If you are Copilot, Codex, or another repo agent:

- Read this file first.
- Use the board section below as the active work queue.
- Keep fixes small, source-rooted, and reversible.
- Do not spread new workflow docs across multiple files unless this file explicitly says to split them.
- If a rule here conflicts with an older doc, prefer this file.
- If you add a new durable workflow, add it here first and only create a dedicated doc if the section becomes too large.

## 5. Windows Command Book

Primary workspace tasks:

- `Desktop Agent PC: Bootstrap`
- `Desktop Agent PC: Validate`
- `Desktop Agent PC: Start Dev`
- `Desktop Agent PC: Package Win`
- `Desktop Agent PC: Install recommended models`

Primary npm commands:

```powershell
npm run engine:acceptance
npm run engine:cli -- plan "Plan the next safe coding task."
npm run engine:cli -- edit --yes "Prepare the smallest safe fix for the current issue."
npm run engine:cli -- repair --lab "E:\dev\projects\gosenderr_dev_offload\assistant_labs\scratch\<lab-name>"
npm test
```

Use these in order when changing engine behavior:

1. Run acceptance.
2. Reproduce in a disposable lab.
3. Fix source files, not generated copies.
4. Re-run the smallest relevant validation.
5. Re-run acceptance.

## 6. Operating Workflow

Standard safe loop:

1. Ask: understand the problem and current repo state.
2. Plan: choose the smallest bounded target.
3. Edit: prepare or apply the change.
4. Agent: only when you want bounded autonomous execution.
5. Acceptance: confirm the engine baseline is still healthy.

For engine debugging:

1. Reproduce in a scratch lab.
2. Capture raw runtime output when the UI summary is too compressed.
3. Verify target-file ranking, plan steps, execution steps, and changed-file detection in that order.
4. Fix the earliest stage that is wrong.

## 7. Error Finder And Bug Finder

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

## 8. Upgrade And Layering Rules

- Keep engine orchestration separate from desktop UI composition.
- Keep repair heuristics language-aware, not Python-only.
- Prefer shared ranking/inference helpers over duplicated one-off logic.
- Keep board and workflow policy centralized here.
- Add plugin-ready seams at the ranking, planning, execution, and validation layers rather than inside UI code.

## 9. Active Board

- BAT<ENGINE-001> DONE: Replace the read-only fallback in `runtime/backend/agent/core/tool_loop.py` so repair/edit runs can synthesize `edit_file` or `smart_patch` execution steps instead of stopping at `inspect_file`.
- BAT<ENGINE-002> DONE: Make validation tolerant of non-git disposable labs by skipping or downgrading `git_status` when no `.git` root exists.
- BAT<ENGINE-003> DONE: Re-run the disposable broken Node lab after `ENGINE-001` and confirm the engine produces a real diff and a passing `npm test`.
- BAT<OPS-003> DONE: Make `scripts/windows/validate.ps1` fail fast on external command exit codes so `npm test` regressions cannot be hidden by later steps.
- BAT<UI-001> DONE: Restore settings-shell parity in `renderer-src/main.tsx` by replacing the prompt-based remote key flow with an in-panel field and reintroducing the `Composer height` control expected by `tests/ui-shell.test.js`.
- BAT<QUALITY-002> DONE: Add a focused validation path for the settings-shell contract so the repo can catch `ui-shell.test.js` regressions before broader validation or packaging runs.
- BAT<OPS-001> DONE: Redirect older docs back to this Windows-first handbook and remove stale hard-coded release examples so owner-facing guidance stays current.
- BAT<OPS-002> DONE: Add a handbook affordance in the app shell so operators can open `docs/BAT_FEATURE_BOARD.md` directly from the chat/manager surface.
- BAT<ARCH-001> DONE: Document source-of-truth edit boundaries here and in desktop reference docs so generated renderer and packaged output copies stay read-only.
- BAT<QUALITY-001> DONE: Add `tests/repo-inspection-ranking.test.js` and `npm run test:planner-ranking` to prove JS/TS test imports promote implementation files into planner search results.
- BAT<PERF-001> DONE: Reduce large-journal tail-read cost in `core/learning-journal.js` and lock the bounded parse behavior with the large-journal regression fixture.
- BAT<DOCS-001> DONE: Retire overlapping daily workflow ownership by routing desktop and owner docs back to this board while keeping them as deeper reference material.
- BAT<OPS-004> DONE: Expose in-app desktop update controls so downloaded desktop releases can be checked, downloaded, and installed from the running app without leaving the shell.

## 10. Audit Plan

Current board status:

1. All active BAT items on this board are complete.
2. Inbox and stored approval state are currently clear, with no pending approvals queued in the recorded runtime artifacts.
3. The next phase after this board is model tuning and broader engine-capability expansion, using the validated acceptance and packaging baseline from this pass.

## 11. Completion Standard

A task on this board is not done until:

- the source fix exists in non-generated files
- the smallest relevant validation passes
- acceptance still passes if engine behavior changed
- this board is updated if the durable workflow changed