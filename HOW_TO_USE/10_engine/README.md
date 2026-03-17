# Engine And Autonomy

## Core guides

- [`workspace_and_engine.md`](./workspace_and_engine.md)
- [`engine_tuning_and_settings.md`](./engine_tuning_and_settings.md)
- [`learning_and_self_tuning.md`](./learning_and_self_tuning.md)
- [`engine_acceptance_and_daily_gate.md`](./engine_acceptance_and_daily_gate.md)

## New operator guides

- [`autonomous_self_improvement.md`](./autonomous_self_improvement.md) for the low -> medium -> high slice progression and the starter bug-fix loop.
- [`electron_architecture_and_bug_triage.md`](./electron_architecture_and_bug_triage.md) for main-process, renderer, runtime, and test-surface triage.

## Quick commands

- Seed the starter self-improvement backlog: `powershell -ExecutionPolicy Bypass -File .\scripts\windows\bootstrap-self-improvement.ps1`
- Seed and start the scheduler in the self-host lab: `powershell -ExecutionPolicy Bypass -File .\scripts\windows\bootstrap-self-improvement.ps1 -StartScheduler`
- Acceptance gate: `npm run engine:acceptance`
