# GoSenderr Desktop Agent Phase 1 / First 30 Days

## Summary

This document is now the **Phase 1 execution baseline** for the 5-phase MVP.

Phase 1 is still the first 30-day hardening window, but it is no longer the main human planning model. The operator now tracks **phases**, while the engine keeps **month/day** mechanics internally for quota proof, task-hub focus, and historical audit.

Implementation source of truth remains the live Windows repo root:

- `E:\dev\projects\gosenderr-desktop-agent-PC`
- shipped desktop UI: `renderer/app.js`
- backend/runtime root: `runtime/backend`
- real VS Code companion path: `integration-library/extensions/vscode-companion`

Legacy copies under `tools/gosenderr-desktop-agent` and `tools/vscode-dev-assistant-extension` are compatibility drift, not the implementation target.

## Phase 1 objective

Make desktop and the VS Code companion share one safe coding loop with clear:

- planning
- implementation
- validation
- review verdicts
- rollback/interrupt controls
- next safe action guidance
- bounded follow-up behavior
- trustworthy provider/model status
- acceptance and smoke readability

The fixed engine-controlled loop remains:

- `plan -> implement -> validate -> review -> release`

Models may propose work, but the engine owns repo mutation, review gates, trust gates, and release decisions.

## What stays engine-internal

The engine still owns:

- day-by-day bounded slicing
- 5 safe autonomous actions
- 5 safe self-improvement slices
- daily task-hub focus
- quota gating
- overscope handling
- repair/research retries
- follow-up queueing

Those mechanics remain visible through audits, but they are no longer the main roadmap language for the operator.

## Phase 1 deliverables

- shared runtime contract across desktop and companion for:
  - objective
  - failure class
  - recovery ladder
  - checkpoint
  - interrupt
  - review bundle
  - next safe action
  - queued bounded follow-up
- explicit review verdict summary everywhere:
  - approved
  - approved-with-warnings
  - repair-required
  - review-required
  - blocked
- rejection reason, how-to-fix, and next bounded action surfaced in the shipped UI and companion
- explicit model roles surfaced through current wrapped profiles and routing:
  - front-door chat / orchestrator
  - engine planner
  - worker
  - reviewer
  - validator
- hybrid-ready routing visibility without creating a parallel routing manager
- trustworthy app-managed provider key state
- acceptance and smoke readability across Monitor and `system:check`
- current learning journal and runtime memory aligned around shared run outcomes instead of a new memory subsystem

## Phase 1 acceptance gates

Phase 1 exits only when:

- desktop and companion can both supervise the same bounded coding loop
- review verdicts and fix guidance are readable without decoding raw payloads
- next safe action and queued follow-up behavior are working and gated
- acceptance, smoke, trust, and roadmap surfaces agree
- model provisioning blockers are obvious before model work is attempted
- review rejects always carry a reason and a fix path
- the operator can understand current phase state without managing day numbers manually

## Phase 1 proof surfaces

Required proof remains on the current surfaces:

- chat/workbench in `renderer/app.js`
- Monitor
- VS Code companion
- `npm run system:check`
- MVP/readiness summary
- acceptance report
- trust/review summary
- task-hub focus record

Required command shapes:

```bash
npm run system:check
npm run system:check -- --area roadmap
npm run system:check -- --area trust
npm run system:check -- --area acceptance
npm run system:check -- --json
```

## Phase 1 implementation slices

The engine should prefer bounded work that advances this phase in the following order:

1. safe coding-loop clarity
2. review/trust/readability
3. next-action and follow-up autonomy
4. companion parity
5. memory-guided tuning

When a slice is blocked or rejected, the result must include:

- reason
- how to fix
- next bounded action

## Memory tuning in Phase 1

Phase 1 does **not** add a new memory subsystem.

Instead it extends the current learning journal and runtime memory path so both can represent:

- run outcome
- review verdict
- rejection reason
- fix guidance
- files touched
- repair choice
- follow-up result
- benchmark/model-fit effect when present
- phase relevance

That memory should start influencing:

- routing bias
- repair hints
- next safe action quality
- follow-up selection

## Internal mapping

The engine still keeps the month/day baseline internally for audit:

- internal Month 1-2 map to Phase 1
- daily quota proof remains 5 safe autonomous actions + 5 safe self-improvement slices
- task-hub focus and daily summary remain internal control mechanics

The operator-facing plan is now phase-first.

## Assumptions

- The first 30 days are still a real hardening window, but not the only planning language.
- New implementation findings should update the 5-phase plan first, and only then adjust internal month/day tracking as needed.
- The engine should keep taking on more bounded planning and follow-up work over time, while safety, review, acceptance, and rollback remain hard gates.