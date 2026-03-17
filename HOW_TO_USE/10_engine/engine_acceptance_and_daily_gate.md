# Engine Acceptance And Daily Gate

Run this from:

```sh
cd /Users/papadev/dev/gosenderr-desktop-agent
```

## What this does

The engine acceptance suite is the safe daily gate for the new self-improving engine baseline.

It:

- creates a fresh self-host lab
- creates a clean dummy app lab
- creates a broken dummy app lab
- bootstraps the self-host lab dependencies
- runs the validation checks
- records benchmark entries
- captures training and learning state
- writes one acceptance report for the `Monitor` tab to read later

## Main command

```sh
npm run engine:acceptance
```

You can also run the same acceptance flow from inside the app:

1. Open `Monitor -> Overview`
2. Click `Run acceptance`
3. Wait for the newest report to appear

## Full self-host pass

If you want the self-host lab to run the heavier smoke step too:

```sh
npm run engine:acceptance -- --full-self-host
```

## What “good” looks like

- clean dummy lab tests pass
- broken dummy lab fails on purpose
- self-host lab bootstraps and passes `npm test`
- training telemetry does not show a hard failure
- the report says `pass` or `warn`, not `fail`

The live promotion gate now uses that same acceptance result.

- `pass` means the baseline is clean
- `warn` means the baseline is usable, but you should stay supervised
- `fail` means do not promote self-improvement work into live yet

## Where the report goes

The latest report is written under the configured benchmark root:

- `assistant_benchmarks/acceptance/latest.json`

The `Monitor` tab reads that file and shows:

- overall acceptance status
- the newest check results
- the next recommended action
- an in-app `Run acceptance` action for the same daily gate

## If the report says `warn`

Warnings usually mean:

- machine pressure is high
- training should stay quiet for a while
- the baseline is usable, but not ideal for a heavier self-improvement slice

That is not always a product bug. Sometimes it is just the laptop telling you to slow down.

## If the report says `fail`

Do this in order:

1. Open `Monitor`.
2. Read the latest acceptance summary.
3. Check the self-host or dummy lab that failed.
4. Fix the failing check before promoting any self-improvement work.
5. Run `Run acceptance` again from `Monitor -> Overview`, or rerun `npm run engine:acceptance`.

## Why this matters

This project is trying to become a safe AI dev team, not just a chat UI.

That means we need a repeatable gate that answers:

- can it still work on safe labs?
- can it still test itself?
- is the machine healthy enough for more work?
- should we promote, wait, or roll back?
