# GoSenderr Desktop Agent Five-Phase MVP

## Summary

This is now the **primary roadmap** for the MVP.

The project no longer uses month-by-month planning as the main human-facing structure. The operator tracks **five phases**. The engine keeps **month/day** mechanics internally for quota proof, task-hub focus, readiness scoring, and historical audit.

Implementation source of truth:

- `E:\dev\projects\gosenderr-desktop-agent-PC`
- shipped desktop UI: `renderer/app.js`
- backend/runtime root: `runtime/backend`
- real VS Code companion path: `integration-library/extensions/vscode-companion`

Legacy copies under `tools/gosenderr-desktop-agent` and `tools/vscode-dev-assistant-extension` stay frozen unless an acceptance-approved compatibility cleanup explicitly touches them.

The fixed control loop remains:

- `plan -> implement -> validate -> review -> release`

Models may propose work, but the engine owns repo mutation, validation, trust, review, and release.

## Fixed engine-owned execution rule

The engine still manages day-to-day bounded execution through current systems:

- task hub
- next safe action
- queued follow-up
- review bundle
- recovery ladder
- learning journal
- runtime memory

The engine continues to enforce the internal daily minimum:

- 5 safe autonomous actions
- 5 safe self-improvement slices

The operator should not need to drive day numbering manually unless investigating a blocked or unsafe result.

## Phase 1: Safe Engine Core

Goal:

- make desktop and the VS Code companion share one safe coding loop with clear review, recovery, and next-step guidance

Deliver:

- shared `plan -> implement -> validate -> review -> release` loop
- explicit review verdict summary everywhere
- shared next safe action and bounded follow-up behavior
- checkpoint, interrupt, rollback, repair, and trace flows
- trustworthy provider/model status
- acceptance and smoke readability
- engine-owned bounded slicing through existing task-hub/runtime surfaces

Exit gate:

- desktop and companion both run the same bounded dev-engine flow
- review verdicts and fix guidance are readable without raw payload decoding
- next-action and queued follow-up logic are working and gated
- acceptance/trust/roadmap surfaces agree

## Phase 2: Assisted Coding Parity

Goal:

- make desktop and VS Code parity real for the core coding experience

Deliver:

- same objective, recovery, review, and next-action story across both surfaces
- strong role visibility:
  - orchestrator
  - planner
  - worker
  - reviewer
  - validator
- same trace/files/problems/sandbox/provider settings concepts across both surfaces
- engine-owned continue/retry/repair flow with less manual steering

Exit gate:

- the companion is a real bounded coding surface, not a stub
- the operator can supervise the same run in desktop or VS Code without losing context
- the engine can carry bounded follow-up work forward with minimal manual translation

## Phase 3: Memory-Guided Supervision

Goal:

- make the engine safer and smarter from accumulated outcomes

Deliver:

- unify the existing learning journal and runtime memory around shared run outcomes
- record and reuse:
  - files touched
  - successful patches
  - repair strategies
  - rejection reasons
  - review verdicts
  - follow-up results
  - benchmark/model-fit signals
- use memory to tune:
  - routing bias
  - repair hints
  - review guidance
  - self-task suggestions
  - overscope avoidance

Exit gate:

- repeated failure patterns are reduced by memory-informed decisions
- repair and routing recommendations improve over time
- review reject reasons become reusable guidance instead of one-off notes

## Phase 4: Builder And Model Lifecycle

Goal:

- expand from the safe coding loop into safe software-building and model lifecycle work

Deliver:

- bounded builder workflows for app/site/software tasks
- foundry/benchmark/promotion identity stays consistent
- trusted-docs-guided experiments feed builder patterns
- local models stay first-class through wrapped profiles, routing, tuning, foundry, and promotions
- memory and review signals lower risk before widening work

Exit gate:

- bounded builder tasks can be started from chat safely
- model identity, benchmark proof, and promotion state are consistent
- the engine can assemble larger tasks without abandoning hard gates

## Phase 5: Release, Training, And Convergence

Goal:

- converge coding, review, learning, builder, release, and model improvement into one supervised system

Deliver:

- safe release/update/rollback operations
- trusted training/export orchestration using the current learning/memory path
- model and engine improvements stay tied to benchmarks, review, and rollback safety
- phase-level scorecards across desktop, companion, and `system:check`

Exit gate:

- the system can plan, code, repair, review, build, ship, and improve itself under supervision
- model and engine changes are benchmarked, reviewable, and reversible
- the operator manages phases and gates, not daily micromanagement

## Cross-cutting requirements

- Use existing infrastructure first. New subsystems only happen when a real gap blocks the layer.
- The engine, not the model, owns repo writes, review gates, trust gates, and release decisions.
- Rejected or blocked work must always include:
  - reason
  - how to fix
  - next bounded action
- Trusted docs improve the engine only when they stay approved, attributable, and exercised through bounded lab work.
- Local models stay first-class through the current wrapped-profile, routing, tuning, benchmark, foundry, and promotion surfaces.
- Memory tuning must extend the current learning journal and runtime memory path instead of creating a new memory subsystem.

## Internal month/day mapping

The month-based baseline still exists as an internal audit and execution overlay:

- Phase 1 maps to internal Months 1-2
- Phase 2 maps to internal Months 3-4
- Phase 3 maps to internal Months 5-6
- Phase 4 maps to internal Months 7-9
- Phase 5 maps to internal Months 10-12

Those internal mechanics still drive:

- `system:check`
- task-hub daily focus
- daily quota proof
- historical audit/reporting

The operator-facing roadmap is now phase-first.

## Required proof surfaces

Every phase must show proof on existing surfaces:

- desktop chat/workbench
- Monitor
- VS Code companion
- `npm run system:check`
- acceptance report
- trust/review summaries
- task-hub focus record

Required commands:

```bash
npm run system:check
npm run system:check -- --area roadmap
npm run system:check -- --area trust
npm run system:check -- --area acceptance
npm run system:check -- --json
```

## Memory tuning direction

The memory layer becomes more useful by recording and reusing:

- run outcome
- lesson
- review rejection reason
- fix guidance
- benchmark effect
- model-fit result
- phase relevance

That same memory should guide:

- safer retries earlier
- better next safe action quality
- lower-risk route selection
- overscope reduction
- bounded self-task generation

## Acceptance standard

For every phase, required proof includes:

- focused JS/Python contract tests
- desktop UI shell tests
- VS Code companion tests
- `system:check` roadmap/trust/autonomy validation
- acceptance and smoke readability checks
- phase summary proof in existing surfaces

## Assumptions

- The 5-phase plan is now the primary roadmap and execution lens.
- The engine still keeps daily quotas and daily focus internally because they are useful control mechanics.
- Safety, review, rollback, trust, and acceptance remain hard gates even as the engine takes on more bounded day-to-day work.
