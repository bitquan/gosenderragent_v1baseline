# Start Here

## Open the app

- Source dev run: `powershell -ExecutionPolicy Bypass -File .\scripts\windows\dev.ps1`
- Smoke the UI: `npm run smoke:ui`
- Full validation sweep: `powershell -ExecutionPolicy Bypass -File .\scripts\windows\validate.ps1`

## Read next

- [`basic_usage.md`](./basic_usage.md) for the normal app flow.
- [`common_commands.md`](./common_commands.md) for slash commands and terminal commands.
- [`../10_engine/workspace_and_engine.md`](../10_engine/workspace_and_engine.md) for workspace vs lab mental model.

## Daily checklist

- Confirm the workspace is `E:\dev\projects\gosenderr-desktop-agent-PC`.
- Select the persistent `self-host` lab before letting autonomy work on the app.
- Keep model storage reachable before running learning or self-improvement.
- Run smoke or targeted tests before trusting a bigger slice.
- Read `../10_engine/autonomous_self_improvement.md` before starting the scheduler or raising slice difficulty.
- Do Git work from `E:\dev\projects\gosenderr-desktop-agent-PC`; treat the `self-host` lab as the safe execution sandbox.
