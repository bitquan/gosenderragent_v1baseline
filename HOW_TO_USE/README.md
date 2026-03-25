# GoSenderr Desktop Agent PC Docs

This folder is the operator handoff for the Windows desktop-agent repo at `E:\dev\projects\gosenderr-desktop-agent-PC`.

## Start here

- Read [`00_start_here/README.md`](./00_start_here/README.md) first for startup, workspace, and daily commands.
- Read [`10_engine/README.md`](./10_engine/README.md) for autonomy, self-hosting, models, engine tuning, and Electron bug triage.
- Read [`20_operations/README.md`](./20_operations/README.md) for validation, monitor, rollback, and troubleshooting.
- Read [`30_release/README.md`](./30_release/README.md) for packaging, Windows clone notes, and integrations.

## Critical paths

- App repo: `E:\dev\projects\gosenderr-desktop-agent-PC`
- Live offload: `E:\dev\projects\gosenderr_dev_offload`
- Persistent self-host lab: `E:\dev\projects\gosenderr_dev_offload\assistant_labs\persistent\self-host`
- Model storage: `E:\dev\projects\gosenderr_dev_offload\local_model_storage`
- Windows builds and live update channel: `E:\dev\projects\gosenderr_dev_offload`
- Cold backup/archive storage: `D:\dev\projects\gosenderr_dev_backup`

## Self-improvement mental model

- Live repo stays the source of truth.
- Risky self-work runs in the persistent `self-host` lab.
- The scheduler now prefers prepared self-improvement slices before BAT sprint work.
- Self-improvement starts with low-difficulty bug slices, graduates to medium after repeated trusted passes, and only reaches high/full slices after a stronger success history.
- Operator seeds, failure history, review outcomes, owner signals, and benchmark weak spots all feed the next prepared task list.

## Best habit

If the app feels wrong, run validation first, repair the current hotspot, then let autonomy continue. Do not stack new scope on top of an unhealthy baseline.
