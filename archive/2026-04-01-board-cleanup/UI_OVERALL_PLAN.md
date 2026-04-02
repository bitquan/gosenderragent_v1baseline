# GoSenderr Desktop Agent UI Overall Plan

## Goal

Turn the desktop host into a calmer, more predictable self-improvement workspace so the operator always knows:

- where to start
- what is active now
- what needs approval
- what failed validation
- what the next safe action is

This plan is for the GoSenderr Dev Agent Platform only.
It does not unlock marketplace product work.

## March 2026 shell overhaul update

The next UI pass should move from incremental layout fixes to a full shell cleanup.

The goal of this update is to stop spending repeated time on overlapping cards, blocked panels, and half-open surfaces by simplifying the shell itself.

## March 13 2026 full new shell reset plan

## March 13 2026 Codex / VS Code Copilot shell target

The shell reset target is now more specific.

The desktop host should stop behaving like a dashboard product and start behaving like a coding shell closer to Codex or VS Code Copilot.

This means the primary reference is no longer:

- summary cards
- dashboard boards
- equal-weight page sections

The new reference is:

- thin activity rail
- left sidebar for threads and workspace context
- large quiet main canvas
- bottom prompt composer
- optional side or bottom panels only when needed

### What this target changes

The previous shell reset plan was directionally right, but still too card-oriented.

The active shell target now becomes:

1. **activity rail** on the far left
2. **sidebar** for threads, workspace, worktrees, and support shortcuts
3. **main canvas** centered on the active thread or coding task
4. **prompt dock** at the bottom of the canvas
5. **secondary inspector/panel** hidden until explicitly opened

### Codex-like shell principles

#### 1. Main canvas first

The main workspace should dominate the screen.

It should feel like:

- a coding canvas
- a chat/editor workspace
- a quiet home state ready for input

It should not feel like a report dashboard.

#### 2. Sidebar instead of mixed rails

The shell should use a pattern closer to IDE tooling:

- activity rail for major modes
- sidebar for threads and local context

The sidebar should carry:

- new thread
- thread list
- workspace/worktree context
- a few support shortcuts such as Automations and Skills

#### 3. Top toolbar should be minimal

The top area should behave like a toolbar, not a board of status cards.

Keep only compact status and action items such as:

- workspace
- active run
- runtime/model
- review count
- a small set of toolbar actions

#### 4. Prompt dock should be persistent

The input composer should stay anchored at the bottom of the main canvas.

It should include:

- prompt input
- quick attach affordance
- model selection
- mode selection
- send action

This should feel like Copilot or Codex, not a form embedded inside a dashboard card.

#### 5. Secondary surfaces should open on demand

Review, validation, diff, and artifacts should open as:

- side inspectors
- bottom panels
- explicit workspace switches

They should not all stay visible by default.

### Codex target page model

#### Workbench

Workbench becomes the default home and should behave like the Codex start screen:

- centered empty state for a new thread
- large conversation/work area
- sidebar thread history
- bottom composer
- optional right inspector closed by default

#### Review

Review should feel closer to an IDE review panel or inbox.

It should open when selected and prioritize:

- approvals
- diffs
- file detail

#### Validate

Validate should feel like a testing panel or report view, not a home screen.

#### Automate

Automate should feel like an operations sidebar/workspace, not a dashboard competing with the main coding canvas.

#### Settings

Settings should feel like a utility/preferences area, not a primary day-to-day workspace.

### Codex visual target

The shell should trend toward:

- dark-first presentation
- flatter surfaces
- fewer heavy borders
- fewer stacked cards
- more spacing around the main canvas
- clearer IDE-like chrome

### Codex first implementation slice

The first build slice for this target should be:

1. convert the shell chrome into activity rail + sidebar + main canvas
2. make Workbench the Codex-style home state
3. keep the composer dock fixed at the bottom
4. keep the right inspector closed by default
5. move report-style content out of the first viewport

### Codex acceptance criteria

This target is successful when:

- the host feels closer to an IDE assistant than a dashboard
- the home screen is mostly quiet until the operator starts work
- the main canvas clearly dominates the viewport
- the sidebar feels like thread/workspace context, not a second dashboard
- toolbar chrome is compact
- prompt entry is always obvious
- review/validation detail is secondary until opened

The current shell cleanup is not enough.
Even after reducing overlap in individual surfaces, the host still feels like one large page with too many competing bars, tabs, and side regions.

The next plan should assume a **new shell frame**, not another round of local panel repair.

### Why a new shell is needed

The current host still has structural problems:

- the left rail mixes destination switching with thread browsing
- the top bar is carrying too many equal-weight status pills
- page-level tabs and sub-tabs are stacking too close together
- large surfaces still read like one continuous board instead of distinct work modes
- support tools, thread history, and daily work are visible at the same time even when only one is needed
- the shell still rewards density more than clarity

This means the next step should be a shell reset with clearer boundaries between:

1. navigation
2. current work
3. support context
4. system operations
5. history and thread browsing

### New shell objective

Build a calmer desktop host where the operator can always identify:

- where they are
- what mode they are in
- what single task surface is active
- what supporting context is open
- what next safe action is available