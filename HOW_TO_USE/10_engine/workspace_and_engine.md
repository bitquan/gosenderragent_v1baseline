# Workspace And Engine

## The five roots that matter

`appRoot`

- the standalone desktop app repo
- example: `E:\dev\projects\gosenderr-desktop-agent-PC`

`runtimeRoot`

- the bundled runtime code the desktop app launches
- this is not the same as the target repo you want to work on

`workspaceRoot`

- the real repo you selected in the app
- example: `E:/dev/workspaces/my-project`

`targetWorkspaceRoot`

- the root the current run is actually touching
- this may be the real workspace or a selected lab

`labRoot`

- an isolated managed clone or generated sandbox under the offload labs area

## The public work model

The app is designed around:

- Goals
- Tasks
- Runs
- Recipes

Normal users should think in those terms, or just talk naturally in chat and let the app create them.

## Phase-first roadmap view

The MVP roadmap is now phase-first for operators:

- Phase 1: Safe Engine Core
- Phase 2: Assisted Coding Parity
- Phase 3: Memory-Guided Supervision
- Phase 4: Builder and Model Lifecycle
- Phase 5: Release, Training, and Convergence

What that means in practice:

- you should supervise the current phase and gate, not micromanage day numbers
- the engine still keeps month/day quotas internally for audit, readiness, and task-hub focus
- Monitor and `system:check` should now tell you:
  - current phase
  - phase gate
  - internal month
  - next phase-safe action

Use that phase view when deciding whether to keep going, hold review, or ask the engine for another bounded slice.

How to read the phase scorecard:

1. Start with `Current phase`.
2. Read `Phase gate` before widening the work.
3. Use `Next phase-safe action` as the bounded operator or engine move.
4. Treat `Internal audit` as proof detail, not as the main planning view.
5. Use the per-phase scorecard rows to see which phase is blocked, partial, or ready without reading the month ladder manually.

## Closing Phase 1 safely

Phase 1 is still the honest human-facing phase until the hard gate clears, but the engine can now use one extra bounded self-host lane when the local proof is strong enough.

What to watch:

- `Self-host proof`
  - this tells you whether the project really passed bootstrap, tests, and smoke against itself
- `Self-host expansion`
  - this tells you whether the engine is allowed to take one extra bounded self-host follow-up even while the broader phase gate is still blocked
- `Self-host expansion outcome`
  - this tells you what actually happened after that extra lane was used:
    - `NOT USED`
    - `QUEUED`
    - `RUNNING`
    - `PASS`
    - `REVIEW`
    - `FAIL`
- `Phase closeout`
  - this lists the remaining blockers before Phase 1 can honestly close
- `Next phase preview`
  - this shows what Phase 2 will need next so you can steer toward it without widening early

How to use it:

1. Run `npm run engine:acceptance -- --full-self-host` after meaningful self-work.
2. Check `npm run system:check -- --area roadmap`.
3. If `Self-host proof` is `PROVEN` and `Self-host expansion` is `OPEN`, let the engine queue or auto-run one more bounded self-host follow-up.
4. Watch `Self-host expansion outcome` until it settles.
5. If the outcome is `PASS`, use that proof to close remaining Phase 1 blockers instead of widening again.
6. If the outcome is `REVIEW` or `FAIL`, follow the recorded next step and clear that before asking for more self-host work.
7. Keep the slice supervised and rerun the same self-host proof after that follow-up lands.
8. Do not treat `OPEN` as a full phase transition. `Phase closeout` still tells you what remains before Phase 1 is actually done.

## Where BAT still fits

BAT still exists, but only as an engine compatibility path:

- if a workspace has a BAT board, the app can expose it as an internal engine backlog
- chat can still refer to BAT tickets directly
- BAT is not the main top-level product model anymore

## Labs

Use labs when you want safe experiments:

- `self-host` for working on the desktop agent itself
- `workspace mirror` for risky repo work
- `dummy app lab` for simple benchmark tasks
- `broken dummy lab` for repair-loop testing
- `self-host benchmark` for repeating engine comparisons against the app itself

## Mental model for safe work

- real workspace for real changes
- lab for risky or benchmark work
- chat for intent
- settings for control
- review rail for human approval and file inspection

## Using the dev-engine control loop

The shipped workbench now has two runtime cards that read the same shared loop state as desktop runtime and the VS Code companion:

- `Dev-engine control loop`
- `Recovery and review`

Use them like this:

1. Start work from chat in the main workbench thread.
2. Let the engine create the first bounded run.
3. Use the control-loop buttons based on the captured state:
   - `Continue run`
     - retries the latest loop on the same lane
   - `Retry with research`
     - reruns the same objective on the research lane first
   - `Repair loop`
     - starts the repair path when the latest run has a ticket-backed failure
   - `Open trace`
     - opens the latest runtime artifact or checkpoint when one exists
   - `Open files`
     - jumps the inspector to the latest changed file from the loop
   - `Open sandbox`
     - opens the active lab or sandbox location when the run was bounded there
   - `Review interrupt`
     - opens the inbox when review or approval is holding the loop
   - `Rollback last pass`
     - restores the latest protected backup when rollback is available

## Reading the loop state

The control loop should now tell you:

- `Current objective`
  - the bounded task the engine thinks it is solving
- `Failure class`
  - whether the issue is closer to:
    - `empty-proposal`
    - `parse-failure`
    - `invalid-change-set`
    - `validation-failure`
    - `reviewer-block`
    - `risky-interrupt`
- `Recovery ladder`
  - the next recommended safe move, such as:
    - `research-expansion`
    - `repair-oriented-route`
    - `bridge-plan-retry`
    - `sandbox-retry`
- `Checkpoint`
  - the latest runtime checkpoint, even if no separate artifact file was emitted

If the loop is blocked by approval or review, use `Review interrupt` first instead of retrying blindly.

## Letting the engine choose the next step

The shared runtime now derives one `Next safe action` from the live objective, failure class, recovery ladder, checkpoint, interrupt, and review bundle.

That means desktop chat and the VS Code companion no longer have to guess separately what the next move should be.

What the engine can choose today:

- `Review interrupt`
  - use this first when approval or review is holding the run
- `Repair loop`
  - use this when the latest run failed in a repair-worthy way
- `Retry with research`
  - use this when the engine needs more repo context before another bounded retry
- `Open sandbox`
  - use this when the safest next move is to inspect or continue from the active lab/worktree
- `Continue run`
  - use this when the current bounded objective is healthy enough to continue
- `Open files` or `Open trace`
  - use these when inspection should come before another edit

How to use it in desktop:

1. Look at `Next safe action` in the workbench helper or full control loop.
2. Click the primary action button.
3. Let the engine run that bounded action instead of translating the recovery state yourself.

If you want the engine to line up the next bounded task without running it immediately:

1. Open the same helper or control-loop card.
2. Click `Queue next task`.
3. The app will turn the current `Next safe action` into one bounded follow-up recipe when that action is safe to queue.
4. Use this when you want the engine to do more of the planning for you, but you still want a reviewable queued task before it runs.

If you want the engine to keep doing more of that bounded follow-up work for you:

1. Open `Settings -> Autonomy`.
2. Turn on `Auto-queue bounded next task after the run settles`.
3. Leave `Auto-run queued next task when safe` off if you want the engine to queue the next bounded task but wait for you before launch.
4. Turn on `Auto-run queued next task when safe` only when you want the engine to launch that queued follow-up automatically after the run settles and the current review, safe-mode, workspace-scope, and roadmap gates all stay healthy.

How to use it in VS Code:

1. Open the GoSenderr companion workbench.
2. Read the `Next safe action` card.
3. Click `Run next safe action`.
4. The companion will reuse the same shared action decision it received from the runtime.

## Letting the engine queue the next bounded task

Desktop chat and the VS Code companion now share the same bounded follow-up path.

What happens after a run settles:

1. The shared runtime scores the latest `Next safe action`.
2. If that action is queueable as one bounded task, the engine can materialize it as a follow-up recipe.
3. Depending on your autonomy settings:
   - it stays manual
   - it queues for review
   - or it auto-runs only when the current gates are healthy

That means you do less manual translation of recovery state, but the engine still stays supervised.

In the VS Code companion, that same follow-up path is now visible and usable:

1. Open the GoSenderr workbench in VS Code.
2. Run a bounded task first so the companion has a shared runtime snapshot.
3. Use `Queue next task` when the `Next safe action` is queueable.
4. Read the `Queued follow-up` card to see whether the task was newly queued or already present.
5. Use `Open task hub` when you want to inspect the current workspace queue file directly.

This means desktop and VS Code now queue the same bounded follow-up tasks through the same task-hub path instead of keeping separate queue state.

## Using learned reject and fix patterns

The learning journal now summarizes recurring reject reasons and fix guidance instead of leaving them as one-off notes.

Where you can see that:

- desktop chat/workbench under:
  - `Learned guidance`
  - `Top reject pattern`
  - `Preferred response`
- `Settings -> Learning` under:
  - `Reject and fix patterns`
- the VS Code companion under:
  - `Learned guidance`
- `npm run system:check -- --area learning`

How to use it:

1. If `Top reject reason` keeps repeating, stop widening the task.
2. Use `Preferred response` first before inventing a new retry.
3. Reuse `Reusable fix guidance` as the next bounded prompt or repair objective.
4. Let the engine bias toward that response when the same blocker appears again.
5. If the same path keeps failing, let `Run next safe action` promote a safer `Repair loop` or `Retry with research` automatically instead of manually overriding it.
6. When you queue the next bounded task, expect the engine to keep the learned path and current phase hint attached to that follow-up.
7. The runtime now carries those learned reject, fix, and phase hints on its own, so cold-start runs can still bias `Run next safe action` and queued follow-ups before the frontend learning panel has warmed up.
8. If a repeated failure keeps landing on the same file or phase, expect the engine to favor the learned repair or research move automatically instead of asking you to restate it.
9. Check `Self-host proof` in Monitor, VS Code, or `npm run system:check -- --area learning` before widening self-work. That tells you whether the latest acceptance bundle really proved the project can bootstrap, test, and smoke its own self-host lab.
10. Treat `Self-host next step` as the gate for opening things up further: if it says `PROVEN`, keep slices bounded and rerun proof after meaningful self-work; if it says `PARTIAL` or `BLOCKED`, fix that before widening autonomy.

This is the current memory-guided supervision layer. It does not create a new memory subsystem. It reuses the existing learning journal and the runtime memory path so the engine can gradually choose safer retries and repair paths with less manual translation from you, even when the frontend snapshot is cold.

## Keeping chat usable

If the workbench helpers are taking too much space, open:

- `Settings -> General -> Workbench view`

Use these modes:

- `Focus chat`
  - hides the large status strip
  - keeps one compact `Engine helper` card
  - best when you mostly want to read/write messages
- `Balanced`
  - keeps chat first, but expands the larger control cards when recovery, review, or checkpoint details matter
  - this is the default
- `Control room`
  - keeps the full status strip and full recovery cards visible all the time
  - best when you are supervising the engine closely

You can also change:

- `Composer height`
  - `Comfortable` for the normal input height
  - `Tall` when you want more room for longer prompts, notes, or repair instructions

You do not have to leave chat to do this. The workbench also has quick buttons for:

- `Focus chat`
- `Balanced`
- `Control room`
- `Chat settings`

That means you can shrink the helper surface when you want to talk, then reopen the full control room when you want to supervise the engine more closely.

## VS Code and editor setup

The app can now help bootstrap VS Code for the current target workspace.

Use `Settings -> Workspace -> Bootstrap VS Code` when you want the app to prepare:

- recommended extensions
- baseline workspace settings
- reusable tasks for test, smoke, typecheck, and acceptance

This keeps the operator setup aligned with the desktop workbench without requiring manual editor cleanup every time.

The app can now also install the real GoSenderr VS Code companion into your user VS Code profile.

Use `Settings -> Workspace -> Install companion` when you want to:

- copy the real companion from this repo into your local VS Code extensions directory
- keep the companion aligned with the real desktop-agent repo instead of a retired `tools/...` copy
- verify whether the companion is already installed for your current Windows user profile

What you should see after install:

- `Companion install` should show `Installed`
- the install section should show the extensions root and installed path
- if VS Code is already open, reload or restart it so the new extension build is picked up

This install path is app-managed and uses the real companion at:

- `integration-library/extensions/vscode-companion`

## Model Foundry

Model Foundry lives under `Settings -> AI`.

Think of it as the safe candidate area for:

- route bundles from benchmark leaders
- lighter low-memory bundles
- prompt distillation bundles from trusted reusable prompts
- self-host route candidates when readiness is strong enough

The point is not to magically invent a new model in one jump. The point is to capture benchmark-backed improvements in a way we can compare, promote, or discard safely.

## Low-memory learning fallback

When the machine is under pressure, the app should not pretend a full local training pass is still the right move.

Instead it now surfaces a smaller fallback path:

- quiet profile
- eco mode
- training handoff export
- low-memory Model Foundry candidate

That means the engine can keep learning in a safer, lighter way while the laptop is busy.

## Review verdict summary system

The dev-engine control loop now turns review state into one readable summary instead of making you decode raw runtime fields by hand.

In desktop chat and in the VS Code companion, look for:

- `Review verdict`
- `Review reason`
- `How to fix`
- `Change summary`

What they mean:

- `Review verdict`
  - the engine's current bounded decision such as `Approved`, `Approved with warnings`, `Repair required`, or `Review required`
- `Review reason`
  - the clearest current blocker or approval reason from the shared runtime review bundle
- `How to fix`
  - the next bounded repair or review step the engine recommends
- `Change summary`
  - a quick rollup of the files the current run touched

How to use it:

1. If the verdict is `Approved`, you can keep the next slice bounded and continue.
2. If the verdict is `Approved with warnings`, inspect the changed files or rerun the most relevant validation before promotion.
3. If the verdict is `Repair required`, use `Run next safe action` or `Repair loop`.
4. If the verdict is `Review required`, use `Review interrupt` and clear the held review or approval items before continuing.

This summary uses the same shared runtime truth in desktop and the VS Code companion, so the approval/reject/fix story should match across both surfaces.
