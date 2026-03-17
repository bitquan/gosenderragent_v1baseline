# Autonomous Self-Improvement

This repo now supports a bounded self-improvement loop for the desktop agent itself.

## What changed

- Self-improvement execution is no longer limited to `backend/agent/`; it now accepts desktop-agent-owned paths such as `core/`, `host/`, `renderer-src/`, `scripts/`, `tests/`, and `HOW_TO_USE/`.
- The scheduler now checks prepared self-improvement work before falling back to BAT sprint work.
- Prepared self-improvement tasks now respect a difficulty budget:
  - `low` first
  - `medium` after repeated trusted passes
  - `high` only after a stronger success/trust history

## How the engine decides the next slice

The prepared queue is synthesized from:

- self-improvement history
- failure-memory hotspots
- review rejects/deferred outcomes
- owner summary recommendations
- experiment and benchmark weak spots
- operator-seeded requests

The queue keeps the next slice bounded and bug-focused. One scheduler cycle runs one prepared slice.

## Difficulty progression

- `low` is the default until the engine has multiple successful/reviewed self-improvement runs.
- `medium` unlocks after several successful passes with trusted history.
- `high` only unlocks after a longer clean streak with more trusted passes and low recent failure pressure.

That keeps early autonomy focused on small repairs instead of jumping into broad refactors too soon.

## Current Windows baseline

The repo and the persistent self-host lab are configured with:

- `assistant_safety_level: lab-full-auto`
- `assistant_autonomy_mode: self`
- `assistant_self_improvement_only: true`
- `autopilot_self_improve: true`
- `autopilot_self_improve_max_difficulty: "medium"`
- `autopilot_interval_seconds: 900`

This means:

- self-work should happen in the lab
- the scheduler stays bug-focused
- the scheduler still prefers small slices first, but it can now graduate to medium slices after the recent trusted streak

## Starter backlog command

Use this when you want to seed the current bug-fix loop without hand-editing JSONL files:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\bootstrap-self-improvement.ps1
```

That seeds starter low-scope work for:

- `core/`
- `host/`
- `renderer-src/`

## Start the autonomous loop

Foreground scheduler run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\bootstrap-self-improvement.ps1 -StartScheduler
```

Background scheduler run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\bootstrap-self-improvement.ps1
```

Then start the scheduler from the app, or launch the runtime API scheduler from a shell that points `PROJECT_ROOT` at the persistent `self-host` lab.

Inside the app, the safe flow is still:

1. open workspace `E:\dev\projects\gosenderr-desktop-agent-PC`
2. select the `self-host` lab
3. start autopilot/scheduler

## Windows dependency note

The scheduler needs `APScheduler` installed in the Windows Python used by the runtime API.

If scheduler start prints `APScheduler required`, install it once:

```powershell
python -m pip install APScheduler
```

## How to verify the loop is alive

- Scheduler log: `E:\dev\projects\gosenderr_dev_offload\assistant_labs\persistent\self-host\assistant_scheduler.log`
- Self-improvement execution history: `E:\dev\projects\gosenderr_dev_offload\dev_data\.dev_agent_runs\self_improvement\execution_history.jsonl`
- The scheduler runs one slice immediately on startup, then continues on the configured interval.

If the log is quiet while detached, check the execution history file instead; it is the reliable record of the completed slice.

## Git and lab note

- Use `E:\dev\projects\gosenderr-desktop-agent-PC` when you need Git history, branches, or remotes.
- Use the persistent `self-host` lab for safe autonomous execution.
- The lab may not behave like a normal Git workspace, so `git status` there is not the right health check.

## If you want bigger slices later

Raise `autopilot_self_improve_max_difficulty` from `"low"` to `"medium"` only after the low-scope bug loop stays healthy.

Do not raise the budget while baseline smoke, UI smoke, or acceptance is failing.
