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

### New shell architecture

The new shell should use four fixed regions instead of the current mixed frame.

#### 1. App rail

Purpose:

- switch between the five primary destinations only

Destinations:

- Workbench
- Validate
- Review
- Automate
- Settings

Rules:

- no threads in this rail
- no support utilities in this rail
- no page-specific tabs in this rail
- this rail should stay visually narrow and stable

#### 2. Session rail

Purpose:

- hold thread history, pinned runs, and recent working context

Contents:

- new thread
- thread list
- pinned sessions
- optional recent runs group

Rules:

- collapsible
- can fully hide during focused work
- should not share styling with primary app navigation

#### 3. Active workspace canvas

Purpose:

- hold exactly one primary task surface for the selected destination

Rules:

- one main page title
- one mode row at most
- one primary content surface
- nested tabs are allowed only inside the canvas header for that destination
- no second competing tab strip above the fold

#### 4. Context drawer

Purpose:

- open secondary detail only when requested

Examples:

- diff inspector
- review inspector
- changed file preview
- artifact preview
- layout debugger detail

Rules:

- closed by default on medium widths
- never permanently consume space unless explicitly opened
- should behave like a true drawer or inspector, not a second page

### Header simplification plan

The current top strip should become a lighter shell header.

Keep only:

- workspace/worktree identity
- active run summary
- runtime health
- review queue count

Move out of the header:

- low-priority status pills
- duplicate action buttons
- anything that behaves like page navigation

The header should answer status questions, not operate as a second control center.

### Destination model for the new shell

Each destination should have one clear purpose.

#### Workbench

Primary job:

- work the current thread and next safe action

Inside Workbench:

- current thread
- next actions
- current run summary
- optional context drawer for files/diffs/review

Do not place system administration panels here.

#### Validate

Primary job:

- understand test truth and failure recovery

Inside Validate:

- summary
- tests
- files in scope
- runtime/debug trail

Validate should open as a report surface, not a dashboard collage.

#### Review

Primary job:

- make approval decisions

Inside Review:

- approvals queue
- changed files
- artifacts
- inspector

Review should behave like an inbox plus inspector workflow.

#### Automate

Primary job:

- supervise system-level workflows

Inside Automate:

- templates
- scheduler jobs
- autopilot policy
- experiments
- learning and training artifacts

Automate should feel like a separate operations area, not part of the daily coding lane.

#### Settings

Primary job:

- tune the shell and safety profile

Inside Settings:

- workspace
- safety
- appearance
- diagnostics

Settings should never become an active workflow page.

### Page composition rules

Every destination page should use this composition:

1. title row
2. one sentence page guidance
3. one mode/tab row if needed
4. one primary workspace surface
5. optional action row

Avoid:

- stacked tab rows from unrelated concerns
- floating cards with independent scroll behavior above the fold
- more than one always-open inspector region
- mixed summary, control, and archive sections in the same first viewport

### Explicit removals in the new shell

The reset plan should remove these patterns:

- threads inside the primary navigation rail
- duplicated control buttons across header and page bodies
- always-visible support content that belongs in a drawer
- dense dashboard treatment for Validate and Review
- multiple overlapping card stacks inside the same first viewport

### Implementation plan for the new shell

#### Phase A: shell reset framing

- split the current left side into App rail and Session rail
- simplify the top header
- define the shared canvas and context drawer frame
- make Workbench the default landing page in the new frame

#### Phase B: destination remap

- refit Workbench into one active-thread workspace
- refit Validate into a report-first surface
- refit Review into inbox plus inspector
- refit Automate into operations workspace
- keep Settings as a simple four-group utility surface

#### Phase C: drawer and inspector discipline

- move support detail into the context drawer
- ensure only one inspector is open at a time
- persist drawer state carefully per destination
- keep medium widths stacked and closed by default

#### Phase D: visual cleanup

- normalize spacing and page headers
- unify card types across destinations
- reduce duplicated labels and chips
- tune empty states and first-use guidance

### Acceptance criteria for the new shell

The new shell is ready when:

- the primary rail only switches destinations
- threads live in their own session rail
- every destination has one obvious primary surface
- header content is smaller and calmer than page content
- Validate and Review no longer feel like dashboards
- support detail opens in a drawer instead of competing in the main layout
- medium-width screens avoid overlap without relying on rescue styling
- the operator can explain the shell as app rail + session rail + canvas + drawer

### Recommended first build slice for the reset

The first implementation slice should be structural, not cosmetic:

1. split the current left column into App rail and Session rail
2. simplify the top header to four status items max
3. create the shared canvas plus context drawer shell
4. move Workbench into the new frame first
5. only after that, remap Validate, Review, and Automate

This is the smallest whole-shell move that can stop repeated overlap work from coming back under a different tab layout.

### Concrete Phase A implementation slice

Phase A should now be treated as a bounded desktop-host implementation mission.

#### Phase A goal

Replace the current mixed left shell and crowded top frame with the new base shell:

- App rail
- Session rail
- simplified header
- shared workspace canvas
- closed-by-default context drawer

Do this before remapping every destination in detail.

#### Files in scope for Phase A

- `tools/gosenderr-desktop-agent/renderer/index.html`
- `tools/gosenderr-desktop-agent/renderer/app.js`
- `tools/gosenderr-desktop-agent/renderer/styles.css`
- `tools/gosenderr-desktop-agent/main.js` only if new shell state must persist
- `tools/gosenderr-desktop-agent/tests/ui-shell.test.js`
- desktop-host docs that describe the shell

#### Phase A deliverables

##### 1. New left shell split

Implement two separate left-side regions:

- App rail for destination switching only
- Session rail for threads and recent session context

Minimum Phase A behavior:

- App rail stays narrow and fixed
- Session rail can collapse
- thread list moves out of the primary navigation rail
- support-view helper copy moves out of the main rail if it still creates clutter

##### 2. Simplified shell header

Reduce the header to one status line with only:

- workspace/worktree identity
- active run
- runtime health
- review queue count

Phase A should also:

- remove duplicate header actions where possible
- move destination-like controls out of the header
- keep one small page-level action cluster only when necessary

##### 3. Shared canvas frame

Create one reusable content frame for primary destinations:

- page title row
- short guidance row
- optional mode row
- primary content surface

For Phase A, Workbench should be the first destination fully moved into this frame.

##### 4. Shared context drawer

Create a single drawer pattern that can later host:

- file context
- diff preview
- review inspector
- artifacts
- diagnostics detail

Phase A behavior:

- closed by default
- one open drawer only
- medium widths prefer closed or stacked behavior
- drawer should feel detachable from the main page flow

##### 5. Base shell state model

If persistence is needed, Phase A should normalize shell state around:

- `activeView`
- `sessionRailCollapsed`
- `contextDrawerOpen`
- `contextDrawerMode`
- `shellMode` or `surfaceTemplate` only if already needed

Do not add destination-specific state explosion during Phase A.

#### Workbench-specific Phase A mapping

During Phase A, Workbench should become the shell proving ground.

Workbench should show:

- current thread header
- chat/work surface
- next safe actions
- current run summary

Workbench should stop showing unrelated support surfaces by default.
Those should open through the shared context drawer instead.

#### IDE and terminal integration note

The new shell plan should explicitly leave room for IDE-connected workflows.

We will be adding IDE support to this host, and the shell should treat that as a first-class operator context.

That means:

- show current workspace/editor context without overloading the main page
- allow terminal-aware actions from the shell where useful
- support using terminals the operator has installed on their machine when they want to launch or continue work from there
- keep terminal choice user-driven rather than forcing one built-in terminal path

For Phase A, this does **not** require a full IDE panel yet.
It only means the shell structure must reserve clean places for:

- editor/workspace status
- terminal handoff actions
- future IDE-specific context and quick actions

#### Phase A acceptance criteria

Phase A is complete when:

- threads are no longer in the primary destination rail
- the new App rail and Session rail are visually distinct
- the header is materially simpler than the current one
- Workbench uses the shared canvas structure
- one shared context drawer exists, even if only Workbench uses it first
- medium-width layout no longer depends on layered rescue fixes to stay readable
- tests cover the new shell frame and basic collapse/drawer behavior

#### Phase A validation plan

Minimum validation for this slice:

- update desktop shell tests for the new rail split
- test collapsed and expanded Session rail behavior
- test context drawer open/close behavior
- test that Workbench renders inside the new shared frame
- run the desktop test suite after implementation

#### Phase A non-goals

Do not combine these into the same slice:

- full Validate redesign
- full Review redesign
- full Automate redesign
- new experiment dashboards
- complete IDE tooling surface
- terminal provider abstraction work

Phase A should prove the shell frame first.
Destination deep work should follow after the frame is stable.

### What changes in this update

- reduce shell complexity before adding more controls
- make one stable shell frame shared by every primary destination
- redesign Settings into fewer, clearer groups
- move placeholder-style skills into real repo-grounded operator skills
- add a safe layout fallback that prefers readable stacking over dense side-by-side cards

### New shell priorities

1. shell stability first
2. current work clarity second
3. review and validation visibility third
4. automation depth fourth
5. personalization last

This means the shell should prefer predictable resizing, readable card widths, and fewer simultaneous panels over showing every control at once.

## Current problem summary

The current desktop app has strong building blocks, but the overall surface still feels spread across too many equal-weight panels.

Main issues:

- too many top-level destinations compete for attention
- some names describe implementation details instead of operator intent
- summary, validation, review, and action controls are split across multiple places
- primary workflows are present, but not visually sequenced
- utility panels and deep controls can feel mixed with everyday actions
- layout work keeps colliding with overlapping, blocked, or half-open cards
- settings are carrying too many unrelated controls in one place
- the current Skills surface is not yet anchored to real supervised desktop workflows

## Design principles

### 1. One primary path

The UI should always make one path obvious:

1. understand status
2. inspect context
3. take the next safe action
4. validate result
5. review or continue

### 2. Operator intent first

Labels should reflect what the operator wants to do, not how the code is organized.

Prefer:

- Work
- Validate
- Review
- Automate
- Settings

Avoid over-exposing internal buckets as primary navigation.

### 3. Summary before detail

Every major surface should open with:

- current state
- why it matters
- next recommended action

Raw logs and deep controls should stay one level lower.

### 4. Stable layout grammar

Every view should reuse the same shell structure:

- page header
- status strip
- main content column
- secondary context column
- action footer or action row

The shell should also enforce these hard constraints:

- no card should render below a safe readable width
- no more than one inspector lane should be open at a time on medium screens
- medium and smaller widths should stack instead of squeezing panels
- dense layouts should be opt-in and desktop-width only

### 5. Self-first clarity

The UI should continuously reinforce that current scope is:

- engine self-improvement
- host polish
- validation quality
- review safety

### 6. Safety over density

When the shell must choose between showing more panels or preserving readability, it should preserve readability.

That means:

- stacked fallback is correct behavior, not a degraded mode
- hidden secondary content is better than clipped interactive content
- safe defaults matter more than configurable edge cases

## Proposed information architecture

## Level 1 navigation

Reduce the app to five primary destinations:

1. **Workbench**
   - current work
   - active thread
   - next actions
   - run summary snapshot
2. **Validate**
   - latest test status
   - run summary
   - changed files
   - debug trail
3. **Review**
   - approvals
   - diffs
   - artifacts
   - file decisions
4. **Automate**
   - scheduler
   - autopilot jobs
   - experiments
   - skills
5. **Settings**
   - workspace profile
   - safety and approval rules
   - appearance and shell behavior
   - diagnostics and recovery

## Level 2 destinations

Group existing views into the new IA:

### Workbench

- Dashboard overview
- Current Work chat surface
- latest run card
- worktree scope
- recommended next actions

### Validate

- current Validation sprint panel
- run summary
- test summary
- changed files in scope
- failure clusters
- runtime debug log

### Review

- current Review view
- approval inbox
- patch signals
- artifacts

### Automate

- current Automations view
- real operator skills
- worker health
- experiment/benchmark summaries
- scheduler output

### Settings

- current Settings view
- quick controls drawer content moved into structured settings sections
- Workspace section
- Safety section
- Appearance section
- Diagnostics section

## Proposed screen model

## 1. Workbench becomes the home screen

The default screen should answer four questions in the first viewport:

- what is running?
- what is blocked?
- what changed?
- what should I do next?

### Workbench layout

**Top strip**

- workspace
- worktree
- live runtime state
- model
- approval count
- active run

**Main column**

- focused thread/chat
- next safe actions
- current run summary

**Right column**

- validation health
- approval inbox preview
- changed file preview
- recommended follow-up BATs

## 2. Validate becomes the truth surface for tests

Validation should become the single source of truth for:

- last command run
- last test command run
- pass/fail state
- failing checks
- changed files linked to the run
- next fix suggestion

### Validate layout

Tabs:

- Summary
- Tests
- Files
- Debug

The current sprint/follow-up/debug split should be reorganized so tests are first-class, not implied inside summary text.

## 3. Review becomes the decision surface

Review should own all accept/defer/reject actions.

It should show:

- approval queue first
- selected diff second
- file/artifact details third

The operator should not need to jump back to other views to finish a review decision.

## 4. Automate becomes the systems surface

Automate should hold:

- scheduler controls
- autopilot jobs
- worker status
- experiments and benchmarks
- learn/train actions
- direct access to learning records, training handoffs, and experiment datasets

This keeps system-level operations away from the daily coding surface.

The Automate overview should also keep supervised learning artifacts openable in one place so the operator can move from:

1. capture learning record
2. prepare training handoff
3. inspect exported artifacts inline
4. decide whether the result is safe to promote

Those inline artifact surfaces should show compact summary cards first, then the raw export body second.

Automate should also support two operator-trust helpers:

- **Approved Documentation Intake**
   - allowlist-only documentation URLs
   - explicit source capture with domain, title, section, reason, and artifact path
   - reuse of approved source references inside supervised learning records
- **Layout Debugger**
   - capture overlap, overflow, spacing, and density issues from the active view
   - save the viewport, theme, layout preset, and surface template with each report
   - keep saved layout diagnostics openable and previewable beside other automation artifacts

## 5. Settings becomes the only place for personalization

Move all appearance and environment tuning into one predictable place:

- theme preset
- layout preset
- density preset
- provider settings
- safety toggles
- workspace path

The shell overhaul should narrow this further into four explicit settings groups:

### Settings groups

#### 1. Workspace

- workspace path
- current worktree
- thread defaults
- startup destination

#### 2. Safety

- approval requirements
- autonomy level
- allowed self-improvement scope
- review gating

#### 3. Appearance

- theme preset
- shell mode
- safe layout mode
- density preset
- inspector default behavior

#### 4. Diagnostics

- layout debugger access
- state reset actions
- artifact paths
- renderer health/debug details

Provider tuning and training operations should stay outside Settings when they behave like active workflows.
Those belong in Automate, not in shell personalization.

## Navigation changes recommended

### Rename primary rail items

Current rail can be simplified to:

- Workbench
- Validate
- Review
- Automate
- Settings

### Move these out of primary navigation

- Skills
- Updates
- Files/Worktrees
- Queue/Projects
- Runs/Reports

These should become subpanels, drawers, or tabs inside the five primary areas.

## Layout plan

## Shared layout system

Adopt three stable shell modes and one protected fallback:

### 1. Focus mode

Best for:

- chat-driven implementation
- single active run
- low-noise work

Behavior:

- hides non-critical side panels by default
- keeps chat large
- shows compact validation strip

### 2. Review mode

Best for:

- approval queue triage
- diff inspection
- failing file investigation

Behavior:

- larger right-side inspector
- diff and decision controls stay visible
- validation summary pinned

### 3. Control Tower mode

Best for:

- autopilot supervision
- experiment tracking
- scheduler visibility

Behavior:

- more dashboard density
- larger status/worker/queue cards
- chat becomes secondary

### 4. Safe layout mode

Best for:

- medium screens
- overlap recovery
- debugging blocked panels
- long review and reading sessions

Behavior:

- forces stacked or board-safe layout rules
- disables dense grid behavior
- collapses secondary lanes by default
- preserves action visibility and readable card widths
- becomes the automatic fallback when layout diagnostics detect repeated overlap risk

## Surface template system

In addition to layout presets, the host should expose board-level surface templates that keep card sizing and lane structure consistent across major views.

Templates should be reusable across:

- Automate
- Validate
- Review

Recommended templates:

### 1. Board

- stable two-column board
- larger cards
- reduced overlap risk
- best default for mixed operator work

### 2. Split Ops

- stronger primary lane
- clear secondary inspector lane
- best for automation and approval-heavy sessions

### 3. Stacked

- single-column reading flow
- no half-open cards on medium widths
- best for smaller screens and calm review passes

### 4. Dense Grid

- more cards at once on large displays
- tighter spacing with preserved card boundaries
- best for wide monitors only

Dense Grid should no longer be treated as a normal default candidate.
It should be treated as an explicit large-screen operator choice.

## Shell frame overhaul

The next major pass should standardize the full desktop shell into five consistent regions:

### 1. Primary rail

- only the five top-level destinations
- compact thread entry
- no duplicated utility destinations

### 2. Header strip

- workspace
- active run
- runtime state
- model
- review state

### 3. Primary canvas

- the main task surface for the current destination
- one dominant action area only

### 4. Context lane

- optional secondary lane for diff, context, validation, or automation details
- can be collapsed
- should never compete with the primary rail as a second navigation system

### 5. Action dock

- next safe actions
- destination-specific shortcuts
- no hidden high-priority actions above the fold

This shell frame should replace ad hoc side stacks and reduce view-specific layout invention.

## Real skills overhaul

The current shell should stop treating skills as generic shortcuts and instead promote them into real supervised workflows.

Skills should be grounded in actual engine/operator tasks such as:

- plan the next BAT
- inspect failing validation
- prepare a review decision
- run one self-improvement pass
- capture a learning record
- prepare a training handoff
- capture approved documentation
- capture layout diagnostics

Each skill should define:

- goal
- required inputs
- output artifact or decision
- validation step
- review expectation

Real skills should live primarily in Automate and Workbench action areas.
They should not need a separate top-level utility destination to feel useful.

## Component hierarchy plan

Standardize cards into five types only:

1. **Status card**
   - state + short explanation
2. **Action card**
   - one primary action + optional secondary actions
3. **Queue card**
   - count + top items + open action
4. **Inspector card**
   - details for selected item
5. **Log card**
   - raw output/debug text

This prevents every panel from inventing its own layout rules.

## Visual hierarchy plan

### Emphasis levels

- Primary: active run, failing tests, approval-required items
- Secondary: recommended actions, changed files, follow-up BATs
- Tertiary: logs, history, archived artifacts, low-priority metrics

### Button hierarchy

Use one action model consistently:

- primary button: next safe action
- secondary button: alternate operator action
- ghost button: navigation or low-risk utility
- destructive button: reject/cancel/rollback only

## Rollout phases

## Phase 1: Shell frame cleanup

- simplify the primary rail to five destinations only
- remove duplicated utility navigation from the shell frame
- standardize header, canvas, context lane, and action dock structure
- make Workbench the obvious default landing state

## Phase 2: Settings overhaul

- split Settings into Workspace, Safety, Appearance, and Diagnostics
- remove workflow-heavy controls from Settings
- add explicit safe layout mode controls
- make reset and recovery actions easy to find

## Phase 3: Validation and review clarity

- add dedicated test result blocks with last-command visibility
- keep approval queue first in Review
- pin decision controls near the inspected diff or artifact
- reduce bouncing between Validate and Review for one decision loop

## Phase 4: Real skills conversion

- replace generic skill shortcuts with repo-grounded operator skills
- define input, output, validation, and review expectations for each skill
- surface skills inside Workbench and Automate instead of utility navigation

## Phase 5: Layout safety and diagnostics

- wire safe layout mode into real shell behavior
- connect layout debugger output to shell recommendations
- use diagnostics to tune breakpoints, stacking, and lane rules
- keep dense layouts opt-in only

## Phase 6: Visual polish pass

- tighten spacing, hierarchy, and labels after the shell is stable
- avoid adding new panels until overlap regressions stay quiet

## Recommended implementation order

1. shell frame cleanup
2. settings overhaul
3. validation/review clarity pass
4. real skills conversion
5. layout safety and diagnostics tuning
6. visual polish pass

## Success criteria

The UI is no longer "all over the place" when:

- the home screen clearly explains current state and next action
- test results are visible in one obvious place
- approvals are handled in one obvious place
- system controls are separated from day-to-day coding work
- personalization is separated from runtime operations
- the same layout grammar is reused across views
- medium-width shells stack cleanly instead of producing blocked panels
- Settings no longer acts like a mixed dump of runtime, theme, and debug controls
- skills map to real supervised operator tasks instead of placeholder shortcuts

## Suggested first build slice

If only one focused UI pass is done next, it should be:

1. simplify the rail to five destinations
2. lock in the shared shell frame
3. split Settings into four groups
4. add safe layout mode
5. convert one or two high-value skills into real supervised workflows

That is the smallest shell-focused change set that will stop layout drift while making the product feel intentionally organized instead of additive.

## Supervised self-build mode

Yes, this should be done as a supervised loop.

The right model is not "let it redesign itself freely."
The right model is:

1. give it one bounded UI objective
2. constrain allowed files
3. require a short plan before edits
4. let it implement one slice
5. run tests automatically
6. inspect the result
7. tune prompts, layout rules, and review signals
8. repeat

That gives the engine room to improve its own UI without letting it drift.

## Recommended supervised workflow

### Step 1: bounded target

Only allow self-work in desktop host paths for this loop:

- `tools/gosenderr-desktop-agent/renderer/index.html`
- `tools/gosenderr-desktop-agent/renderer/app.js`
- `tools/gosenderr-desktop-agent/renderer/styles.css`
- desktop UI tests
- relevant desktop docs

### Step 2: one mission at a time

Only let it work on one of these per pass:

- shell frame cleanup
- settings overhaul
- validation panel clarity
- review landing flow
- real skill conversion
- layout safety tuning

Do not let one self-pass try to redesign the entire app.

### Step 3: required output before coding

Before each implementation pass, it should produce:

- goal
- files it plans to touch
- risk level
- test plan
- rollback note

### Step 4: automatic validation after each pass

Minimum validation for every self-pass:

- desktop tests
- UI smoke if the surface changed materially
- summary of changed files
- summary of pass/fail counts

### Step 5: human-reviewed tuning

After the pass, tune these things:

- prompt instructions
- UI naming rules
- layout heuristics
- action hierarchy
- summary formatting
- approval triggers

## Self-tuning plan

Yes, it should be able to self-tune, but only in bounded ways.

### Safe self-tuning areas

- theme and layout preset generation
- label clarity
- card ordering
- summary wording
- default tab selection
- spacing and density presets
- recommended action ranking

### Unsafe self-tuning areas

- changing runtime safety gates on its own
- expanding target paths on its own
- silently changing review policy
- enabling autonomous product work
- rewriting architecture contracts

### Self-tuning rule

Self-tuning should change presentation and prioritization first.
It should not change trust boundaries without review.

## Self-detection plan

Yes, it should detect what is already wrong with itself before trying to improve itself.

That should be a built-in preflight step.

### It should detect these classes of problems

#### 1. UI structure problems

- too many primary nav items
- duplicate actions in multiple places
- missing clear home screen
- mixed settings and daily actions
- hidden test state

#### 2. Validation visibility problems

- last test command missing
- pass/fail counts not visible
- failures buried inside logs only
- run summary present but no test block

#### 3. Review flow problems

- approvals not first in review flow
- decision controls too far from diff context
- review state split across views

#### 4. Interaction consistency problems

- inconsistent button hierarchy
- inconsistent card types
- inconsistent headings and labels
- layout modes that do not preserve context

#### 5. Reliability problems

- broken selectors
- dead buttons
- missing state refresh
- tests failing
- smoke regressions

## Self-detection inputs

The engine should inspect:

- renderer structure
- current docs and UI plan
- recent run summaries
- test summaries
- smoke outcomes
- changed-file scope
- approval signals

## Self-detection outputs

Before editing, it should emit a compact report with:

- `uiProblems`
- `severity`
- `likelyFiles`
- `recommendedNextAction`
- `validationPlan`

## Best operating mode for the next build

The best next mode is:

- let it propose and implement one bounded UI slice
- I monitor the implementation
- I run and report the tests
- I tune the next pass based on the results

That is better than either extreme:

- not as manual as building everything by hand first
- not as risky as fully unsupervised self-redesign

## Recommended first supervised self-build slice

The first slice should be:

1. simplify the left rail
2. lock the shared shell frame
3. make Workbench the clear default home
4. move Settings toward four stable groups

Why this first:

- it improves overall coherence quickly
- it is visible immediately
- it stays inside desktop UI files
- it is easy to validate with existing tests plus one targeted shell-layout check

## Go / No-Go rule

Go only if each self-pass includes:

- bounded scope
- explicit changed-file list
- green desktop tests
- no safety-boundary drift
- clear before/after summary

No-Go if the engine starts:

- broadening scope on its own
- editing product paths
- changing autonomy or approval policy silently
- piling on multiple UI restructures in one pass without validation