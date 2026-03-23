# Autonomous Clone Workflow

## What this is

Use this flow when you want the engine to work on its own in a safe clone of the main project instead of touching the main repo directly.

Current baseline:

- the main repo stays your source of truth
- the engine mutates a self-host lab clone
- you can stop active work from the desktop `Stop` button
- promotion back to the main repo still stays supervised

## Green checks before you start

Run these from the main repo first:

```powershell
npm run engine:acceptance -- --full-self-host
npm run system:check -- --area trust
```

Only start autonomous clone work when both are healthy.

## Create a self-host clone lab

From the main repo root:

```powershell
@'
const { runLabRecipe } = require('./core/labs');
const result = runLabRecipe(process.cwd(), {
  recipe: 'self-host',
  kind: 'scratch',
  cloneStrategy: 'git-clone',
  name: 'owner-proof-self-host',
});
console.log(JSON.stringify(result, null, 2));
'@ | node -
```

That returns a `labRoot`. Use that clone for the active run.

## Run a real bounded task in the clone

Example:

```powershell
npm run engine:cli -- edit --workspace "E:\dev\projects\gosenderr-desktop-agent-PC" --lab "<LAB_ROOT>" --yes "In the lab only, add a short section to OWNER_DOCS/README.md called Autonomous clone workflow with exactly three bullets: start in a self-host lab, keep the main repo untouched, use Stop to cancel active work. Then summarize exactly what changed."
```

Important baseline behavior:

- `--workspace` is the main repo you supervise
- `--lab` is the clone the engine is allowed to mutate
- `--yes` confirms execution for that bounded lab task
- clone-lab execution is auto-approved for controlled edits inside the clone only

## Verify that the edit stayed in the clone

Check the clone:

```powershell
git -C "<LAB_ROOT>" status --short
Get-Content -Path "<LAB_ROOT>\OWNER_DOCS\README.md" -Tail 30
```

Check the main repo stayed untouched for that task:

```powershell
Get-Content -Path "E:\dev\projects\gosenderr-desktop-agent-PC\OWNER_DOCS\README.md" -Tail 20
```

Expected result:

- the clone shows the changed file
- the main repo does not get that clone-only change
- `.gos-lab.json` can appear in the clone as normal lab metadata

## Let it keep working on its own

Use the desktop app when you want live supervision:

1. Open the main workspace.
2. Select the self-host lab as the active target.
3. Use `Auto` or `Agent` mode for bounded execution.
4. Keep the manager in charge of planning, review, docs, and escalation.
5. Keep the worker on local coding and repair tasks.

Current safe baseline:

- clone-only bounded edits
- supervised follow-up
- stop at any time from the desktop `Stop` button

## What `Stop` does

The desktop `Stop` button uses the host stop path to:

- cancel the latest active run when one is active
- otherwise stop the autopilot scheduler
- otherwise leave the workspace unchanged

Use it when:

- the engine chooses the wrong next slice
- a run is taking too long
- you want to pause autonomous clone work before review

## What is green today

This baseline is green when all of these are true:

- acceptance passes
- trust passes
- a real clone task changes the clone and not the main repo
- the manager and worker stay inside the current route and review gates

## What this baseline is not yet

This is not full unsupervised promotion into the main repo.

Keep this split:

- clone = autonomous work surface
- main repo = supervised source of truth
