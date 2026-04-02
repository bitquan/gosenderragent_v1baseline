# GoSenderr Desktop Agent UI Surfaces and Operator Flows

UI priority, current gates, and cleanup status now live on `docs/BAT_FEATURE_BOARD.md`. This file is a reference map of shipped surfaces and operator flows.

## Current control-room notes

The shipped Monitor surface in `renderer/app.js` is the active control room for Month 1 work.

Current operator-visible behavior:

- opening `Monitor` paints the surface first, then hydrates control-room data through the existing `getMonitorStatus` bridge
- Monitor shows a loading state while runs, promotions, review state, and related control-room data finish hydrating
- the `Refresh` action inside Monitor reuses the same non-freezing control-room load path
- model identity summaries now stay consistent across control-room model surfaces:
  - benchmark leader
  - foundry next candidate
  - promotion candidate
- acceptance readability now uses the same report truth in Monitor and `system:check`:
  - latest acceptance result
  - latest smoke result
  - blocking checks
  - next-day gate guidance

This keeps Monitor responsive while the engine baseline is still running heavier report and review assembly in the background.

## 1. Topbar and global quick actions

Confirmed controls in `renderer/index.html`:

- `Refresh`
- `Preflight`
- `Self Improve`
- `Autopilot`
- `Implement Planned`
- `Train`
- `Learn`
- `Start Auto`
- `Stop Auto`
- `Quick Controls`

Confirmed behaviors in `renderer/app.js`:

- these buttons call preload methods directly or route through chat helpers
- topbar also shows:
  - app version label
  - live signal badge
  - status text under hero copy

## 2. Navigation views

Confirmed top-level views:

### Dashboard

Purpose:

- central operator workspace

Current sections:

- Dev Manager Health strip
- Main Hub tabs:
  - Overview
  - Workbench
  - Operations
  - Inbox

#### Dashboard > Overview tab

Confirmed content:

- safe TODO count
- approval count
- active worker count
- scheduler state
- tracked storage
- next safe BATs
- latest run preview
- approval inbox preview
- storage monitor/cleanup controls

#### Dashboard > Workbench tab

Confirmed content:

- task list with status/search filters
- task row actions: `Plan`, `Run`, `Implement`
- chat panel with slash-command chips
- run-state badge

#### Dashboard > Operations tab

Confirmed content:

- latest run summary
- run checks and failing locations
- run output log
- scheduler output log
- recent runs list
- worker monitor

#### Dashboard > Inbox tab

Confirmed content:

- approval inbox with `Open`, `Approve`, `Defer`, `Reject`

### Review

Purpose:

- inspect and lightly edit changed files, failing locations, and artifacts

Confirmed left-side queues:

- changed files
- failing locations
- artifacts

Confirmed inspector tools:

- file/diff tabs
- edit toggle
- save/discard
- open in VS Code
- copy patch
- approve/defer/reject decision controls
- optional decision note

Confirmed guardrail:

- save is blocked until the selected file is approved

### Skills

Purpose:

- list local `SKILL.md` entries from known skill roots

Confirmed action:

- `Open Skill`

### Automations

Purpose:

- view and edit `autopilot_jobs` in `dev_assistant.yaml`

Confirmed fields:

- job name
- cron expression
- enabled flag

Confirmed row actions:

- `Run now`
- enable/disable toggle
- delete

### Updates

Purpose:

- manage workspace updates and desktop binary release state

Confirmed sections:

- workspace update status card
- binary release/update status card
- workspace update policy controls
- binary release actions
- staged release history
- live channel history
- update plan JSON block
- rollback selector

### Validation

Purpose:

- focus operator attention on current coding context and self-improve artifacts

Confirmed sections:

- focused context
- latest sprint
- auto-created BATs
- changed files
- debug console

Confirmed actions inside validation surfaces:

- `Use as context`
- `Open`
- `Plan`
- `Implement`

### Settings

Purpose:

- workspace selection, preflight display, and direct secret storage

Confirmed controls:

- workspace path input + browse/set
- preflight panel
- raw secret name/value save form

## 3. Quick Controls drawer

Confirmed fields:

- model
- local AI command
- OpenAI key
- mode
- runtime
- autonomy mode
- toggle flags for:
  - auto BAT synthesis
  - auto retry until pass
  - brainstorm on failure
  - auto-approve low risk
  - human approval protected only
  - sandbox required
  - baseline self-heal priority
- retry rounds
- GitHub enabled flag

Confirmed behavior:

- opening drawer loads current `OPENAI_API_KEY` via secure storage
- saving drawer persists settings through `app:updateSettings`
- non-empty OpenAI key is stored securely via secrets API

## 4. Renderer state model

Confirmed major state buckets in `renderer/app.js`:

- workspace root
- BAT board summary and items
- recent and latest runs
- chat log
- automations and skills
- preflight state
- follow-up BAT report
- latest sprint report
- settings
- backups
- editor context
- changed files
- review state
- updates state
- manager snapshot
- dashboard layout preferences

Current inferred behavior:

- renderer state is treated as a cache of main-process truth plus transient UI-only state such as selected review tab and dirty editor contents

## 5. Main operator flows

### Flow: plan/run/implement a BAT

1. choose task-row action or use chat
2. renderer calls `plan`, `run`, or `implement`
3. run event stream updates operations panel and live signal
4. final event triggers a snapshot refresh

### Flow: self-improve / autopilot

1. use topbar button or chat command
2. main process builds request defaults from assistant config + autonomy settings
3. runtime launches backend action
4. validation surfaces later reflect sprint summary and follow-up BAT synthesis

### Flow: review a failing file

1. click a failing location or approval item
2. renderer sets editor context focus
3. renderer loads file + diff
4. operator can approve and then save a lightweight edit
5. snapshot refresh updates queues and manager cards

### Flow: start scheduler

1. click `Start Auto` or use chat
2. main process starts runtime scheduler
3. scheduler state/log events stream into dashboard
4. manager pulse and log-tail checks keep scheduler card current

### Flow: workspace update

1. check or plan updates
2. inspect JSON plan
3. apply with explicit confirm
4. backup list refreshes
5. rollback can restore selected backup ID

### Flow: binary release maintenance

1. check app release status
2. install/open downloaded release
3. promote staged release to live channel
4. prune old staged versions

## 6. UI guardrails already documented in codebase

Confirmed in desktop README:

- `renderer/app.js` `elements` object must stay DOM-reference-only
- core functions such as `setActiveView`, `appendChat`, and `renderTaskList` must remain present
- after renderer/main/preload edits, `npm run smoke` should be run

## 7. Current inferred UX intent

Current inferred behavior:

- Dashboard is the day-to-day mission-control surface
- Review is the approval and lightweight-fix surface
- Validation is the self-improve evidence surface
- Updates is both repo-update ops and desktop-release ops in one place

## 8. TODO to verify with live/manual runs

- whether any view is hidden or repurposed in packaged production builds
- whether binary-install actions always open a local artifact versus invoking `electron-updater` install flow, depending on state
