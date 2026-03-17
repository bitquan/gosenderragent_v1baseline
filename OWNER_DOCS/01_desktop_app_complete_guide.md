# Desktop App Complete Guide

## What the app is for

The desktop app is the main control surface for:

- chat-first coding work
- safe engine follow-ups
- supervised self-improvement
- monitor, review, rollback, and promotion visibility
- keeping the VS Code companion aligned with the same run state

## Main areas

Top navigation:

- `Chat`
  Primary work surface. Start here.
- `Monitor`
  Dense operational view for readiness, acceptance, learning, promotions, and safety.
- `Sync`
  Repo and runtime sync helpers.
- `Inbox`
  Approvals, warnings, review holds, and follow-up items.
- `Settings`
  Workspace, model, autonomy, tools, extensions, labs, storage, and diagnostics.

## First-time setup

1. Open the app.
2. Go to `Settings -> Workspace`.
3. Pick the workspace you actually want to work in.
4. Go to `Settings -> AI`.
5. Confirm the coding model, provider, and bridge/runtime are correct.
6. Go to `Settings -> Extensions`.
7. Confirm the VS Code companion is installed and healthy.

## Chat view

The app now defaults to `Focus chat`.

What you see:

- a centered intro state for a new thread
- prompt cards for common starting actions
- pinned run tasks so the core engine actions stay in one place
- pinned model profiles so you can switch lanes without opening Settings
- compact status cards
- a larger composer
- advanced engine and recovery detail only when it matters

Chat view modes:

- `Focus chat`
  Best default. Conversation first.
- `Balanced`
  Shows more helper detail without turning Chat into Monitor.
- `Control room`
  Shows the dense engine cards for deeper supervision.

You can change this in either place:

- the Chat view toggle row inside Chat when visible
- `Settings -> General -> Workbench view`

## Starting work

From Chat, use one of these:

- type your task directly into the composer
- click a prompt card
- click one of the quick suggestions above the composer

Good examples:

- `Review the repo and tell me what needs fixing first.`
- `Plan the next safe coding task in this workspace.`
- `Fix the failing smoke path and explain the risk.`

## The bounded engine loop

The engine can help with these core actions:

- `Run next safe action`
- `Queue next task`
- `Continue run`
- `Retry with research`
- `Repair loop`
- `Open trace`
- `Open files`
- `Open sandbox`
- `Review interrupt`
- `Rollback last pass`

Use this rule:

- if the engine suggests a bounded next action, prefer that first
- if review blocks, read the reason and `How to fix`
- if a run fails, use `Repair loop` or `Retry with research`

## Review and repair

Every blocked or rejected run should now tell you:

- review verdict
- reason
- how to fix
- next bounded action

If the run is blocked:

1. Open `Review`
2. Read the reason
3. Use the repair or retry action
4. Re-run only the bounded fix, not a wider task

## Self-improvement

The app supports supervised self-improvement for this repo.

Use it only when:

- trust is passing
- review is clear
- the workspace is this desktop-agent repo
- the app is not already running another self-improvement task

Use:

- `Run supervised self-improvement`

That run goes through the same loop:

- objective
- execution
- validation
- review
- memory writeback

## Monitor

Use `Monitor` when you want the dense view.

Best uses:

- readiness and roadmap
- acceptance
- learning and memory
- promotions
- debug exports
- safety control

If Chat starts to feel too detailed, leave Chat in `Focus chat` and use Monitor for the heavy operational view.

## Inbox

Use Inbox for:

- approvals
- review holds
- warnings
- safety notices
- follow-up items

If something is blocked, Inbox is usually the quickest place to confirm why.

## Settings

Most important tabs:

- `General`
  Theme, workbench view, composer size, general chat behavior.
- `Workspace`
  Workspace target, VS Code bootstrap, extension alignment.
- `AI`
  Provider, model, bridge/runtime, keys, roles, routing.
- `Autonomy`
  Safety level, bounded follow-up behavior, supervised automation settings.
- `Extensions`
  VS Code companion health and install.
- `Labs`
  Scratch and self-host lab workflows.
- `Learning`
  Learning export, change journal, guidance.
- `Storage`
  Paths, diagnostics, artifacts, and release storage.

## Safe daily pattern

Use this flow:

1. Open Chat
2. Confirm workspace and model
3. Ask for a bounded task
4. Let the engine run the next safe action
5. Repair or review only when needed
6. Use Monitor for dense proof and status
7. Use self-improvement only for one bounded supervised pass at a time
