# Common Commands

Run all terminal commands from:

```sh
cd /Users/papadev/dev/gosenderr-desktop-agent
```

## Terminal commands

Start the app:

```sh
npm run start
```

Run tests:

```sh
npm test
```

Run TypeScript checks:

```sh
npm run typecheck
```

Run smoke validation:

```sh
npm run smoke
npm run smoke:ui
npm run packaged:smoke
```

Build a local package directory:

```sh
npm run pack
```

Build release artifacts:

```sh
npm run dist:mac
npm run dist:mac:zip
npm run release:mac
```

Full validation chain:

```sh
npm test && npm run typecheck && npm run smoke && npm run smoke:ui && npm run packaged:smoke
```

## Chat slash commands

Status and safety:

- `/status`
- `/health`
- `/approvals`
- `/approve`
- `/cancel <runId>`
- `/stop`

BAT compatibility and engine work:

- `/plan 176`
- `/run 176`
- `/implement 176`
- `/implement planned`
- `/batch run`
- `/batch implement`

Learning and engine:

- `/repair`
- `/autopilot`
- `/autopilot start`
- `/autopilot stop`
- `/autopilot status`
- `/train`
- `/learn`
- `/self-improve`

App update helpers:

- `/app update`
- `/app update check`
- `/app update status`
- `/app update install`

## Plain-English prompts that also work

- `Plan the next safe coding task.`
- `Review the repo and tell me what needs fixing first.`
- `Repair the latest failed run.`
- `Create a dummy benchmark lab and test the current coding model there.`
