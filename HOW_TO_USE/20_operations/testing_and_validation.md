# Testing And Validation

Run all commands from:

```sh
cd /Users/papadev/dev/gosenderr-desktop-agent
```

## Fast checks

Renderer and Node tests:

```sh
npm test
```

TypeScript safety:

```sh
npm run typecheck
```

## Smoke checks

App smoke:

```sh
npm run smoke
```

UI smoke:

```sh
npm run smoke:ui
```

Packaged smoke:

```sh
npm run packaged:smoke
```

Engine acceptance:

```sh
npm run engine:acceptance
```

Or run the same gate from inside the app:

- open `Monitor -> Overview`
- click `Run acceptance`
- read the new report before promoting self-work

## Packaging checks

Build a package directory:

```sh
npm run pack
```

Build release artifacts:

```sh
npm run dist:mac
```

## Recommended validation chain before a serious handoff

```sh
npm test
npm run typecheck
npm run smoke
npm run smoke:ui
npm run packaged:smoke
npm run engine:acceptance
```

## What to check manually in the app

- startup opens to chat
- left and right rails can open and close
- settings sections scroll correctly
- AI panel shows routing profile, providers, and lanes
- Autonomy shows the current safety level clearly
- Monitor shows the latest engine acceptance report
- Monitor can trigger `Run acceptance` successfully
- Monitor -> Overview shows the current `30-day readiness` score and next milestone
- Monitor -> Overview shows whether the trusted docs vault is fresh, aging, stale, or empty
- Monitor -> Runs shows Reviewer, Test Bench, and Regression Builder output
- Monitor -> Runs lets you turn an operator comment into a bounded follow-up task
- Monitor -> Runs lets you record `approval`, `needs changes`, and `comment` supervision for the learning loop
- Monitor -> Runs shows the current trusted docs context beside the Test Bench follow-up queue
- Monitor -> Runs offers a docs-refresh follow-up when trusted docs are stale and the next slice should not rely on old guidance
- Monitor -> Runs can offer a docs-scout follow-up when the current review slice looks docs-sensitive but no trusted docs have been captured yet
- Monitor -> Runs shows one `Next safe action` and only marks `auto-queue ready` for low-risk supervised follow-ups
- Monitor -> Runs can queue one bounded `Supervised recipe` so docs, revision, and regression follow-ups move as a safe chain instead of isolated tasks
- Settings -> Learning shows reusable command patterns and operator supervision signals after trusted feedback lands
- labs can be created and targeted
- a simple chat command like `/health` replies

## If validation fails

- fix the failing test or smoke check first
- do not package a build that still fails smoke
- if the UI is broken, run `npm run smoke:ui` before guessing
