# VS Code Companion Complete Guide

## What it is

The VS Code companion is the editor-side surface for the same bounded coding loop used by the desktop app.

It is not supposed to replace Monitor or the full desktop operator surface. It is meant to give you the core coding actions in the editor.

## What it can do

Core actions:

- submit task
- continue
- retry with research
- repair
- run one bounded autopilot pass
- run one bounded self-improvement pass
- run next safe action
- queue next task
- open trace
- open files
- open problems
- open sandbox
- open provider settings
- inspect review verdict, reason, how to fix, learned guidance, and queued follow-up
- inspect compact git status and hand off to native Source Control/history

## Install and verify

From the desktop app:

1. Open `Settings -> Workspace`
2. Use the companion install/bootstrap actions
3. Confirm extension health says it is ready

Inside VS Code:

1. Open the same workspace
2. Reload VS Code if needed
3. Look for the `GoSenderr` icon in the left activity bar
4. Click it to open the `Workbench` view in the side bar
5. If you do not see it yet, open the command palette
6. Run `GoSenderr: Open Chat`
7. Use `GoSenderr: Open Chat Panel` when you want the wider panel surface

Bounded safe actions inside VS Code:

- `GoSenderr: Run Background Self-Improve Pass`
- `GoSenderr: Run Background Autopilot Pass`

Git handoff inside VS Code:

- `Open Source Control`
- `Open Git history`

## Daily use

Recommended flow:

1. Start the task from desktop Chat or directly from the companion
2. Open the same workspace in VS Code
3. Use the companion to:
   - inspect current objective
   - run next safe action
   - queue a follow-up
   - open trace or files
   - open the wide panel from the side bar when you want more room
4. Use desktop Monitor for heavier review, promotion, and readiness work

## Best split between desktop and companion

Use desktop for:

- readiness
- acceptance
- learning
- promotions
- safety control
- rollback decisions

Use VS Code for:

- editor-side run visibility
- quick continue and repair actions
- one bounded autopilot or self-improvement pass without leaving the editor
- jumping to changed files and problems
- seeing branch/dirty state without leaving the companion
- handing off to native VS Code git views
- staying in the coding loop without losing the shared run state

## Release and source-of-truth note

The companion currently stays workspace-installed through the integration copy flow.

- `integration-library/extensions/vscode-companion/extension.js` is the live runtime entry
- `integration-library/extensions/vscode-companion/src/extension.ts` now delegates to that runtime instead of carrying its own stub behavior
- treat this guide as reference material only; governance stays on `docs/BAT_FEATURE_BOARD.md`

## If the companion looks out of sync

Do this:

1. Confirm the desktop app and VS Code are pointed at the same workspace
2. Re-open the companion workbench
3. Use the workspace bootstrap action again from desktop settings if needed
4. Check `Settings -> Workspace` and `Settings -> Extensions` in the desktop app

## Practical rule

Use the companion for bounded coding actions.

Use the desktop app for supervision.
