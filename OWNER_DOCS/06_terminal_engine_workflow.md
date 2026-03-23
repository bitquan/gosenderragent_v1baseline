# Terminal Engine Workflow

Use the terminal as the canonical operator surface when you want the engine, Git, and readiness story in one place.

## Start here

From the repo root:

```powershell
npm run engine:cli -- status
```

That prints the current roadmap, trust, learning, and engine state from the same baseline checks the app reads.

## Core chat modes

```powershell
npm run engine:cli -- ask "Why is the current run blocked?"
npm run engine:cli -- plan "Plan the safest next slice for the routing drift."
npm run engine:cli -- edit "Refactor the lane routing helpers into one shared contract."
npm run engine:cli -- edit "Refactor the lane routing helpers into one shared contract." --yes
npm run engine:cli -- agent "Repair the failing self-host readiness test."
```

Rules:

- `ask` stays conversational and non-mutating
- `plan` stays planning-only
- `edit` prepares edit work and requires `--yes` before execution
- `agent` can execute bounded work through the engine loop

## Engine controls

```powershell
npm run engine:cli -- review
npm run engine:cli -- repair
npm run engine:cli -- self-improve
npm run engine:cli -- train
npm run engine:cli -- doctor
```

What they do:

- `review` shows the latest recorded run's review, fix, and next-action state
- `repair` runs the bounded repair path
- `self-improve` runs the supervised self-improvement path
- `train` runs the training handoff/train path
- `doctor` shows preflight plus system-check in one terminal view

## Git workflow

```powershell
npm run engine:cli -- git status
npm run engine:cli -- git stage renderer/app.js
npm run engine:cli -- git commit -m "feat: tighten shared engine routing"
npm run engine:cli -- git create-branch routing-baseline
npm run engine:cli -- git publish
npm run engine:cli -- git push
```

Supported commands:

- `git status`
- `git summary`
- `git diff <path> [--cached]`
- `git stage <path...>`
- `git unstage <path...>`
- `git stage-all`
- `git unstage-all`
- `git discard <path...>`
- `git commit -m "message"`
- `git pull`
- `git push`
- `git publish`
- `git branches`
- `git create-branch <name>`
- `git switch-branch <name>`

Branch names created by the app are normalized to `codex/*`.

## Workspace and lab targeting

Use a different workspace:

```powershell
npm run engine:cli -- status --workspace E:\dev\projects\gosenderr-desktop-agent-PC
```

Use a lab target:

```powershell
npm run engine:cli -- agent "Run the bounded fix in the lab." --lab E:\dev\projects\gosenderr_dev_offload\assistant_labs\persistent\self-host
```

## Baseline rule

If terminal acceptance is red, do not trust a green-looking UI alone. Fix the engine baseline first, then confirm VS Code and desktop still show the same truth.
