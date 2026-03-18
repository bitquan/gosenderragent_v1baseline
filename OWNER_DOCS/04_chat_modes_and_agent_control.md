# Chat Modes and Agent Control

## The four chat modes

The app now keeps two separate controls visible in Chat:

- `Focus / Balanced / Control room`
  Layout only.
- `Ask / Plan / Edit / Agent`
  Behavior and routing.

Use them together:

- pick the layout that feels comfortable
- pick the mode that matches the kind of help you want

## Ask

Use `Ask` when you want the app to talk with you like a human teammate.

Best for:

- explanations
- repo questions
- debugging advice
- “what should I do next?”
- comparing options

What it will not do:

- it will not auto-launch edit work
- it will not turn a normal question into an autonomous run

## Plan

Use `Plan` when you want a scoped plan before changing anything.

Best for:

- breaking work into steps
- risk review
- choosing the smallest next slice
- shaping a repair plan

What it will not do:

- it will not directly launch code edits
- it will not auto-run the agent loop

## Edit

Use `Edit` when you want the app to focus on code changes and diffs.

Best for:

- preparing a fix
- reviewing the smallest patch
- repair loops
- file-level change work

Important rule:

- `Edit` can prepare or apply code changes, but it should still require explicit confirmation before mutating work

## Agent

Use `Agent` when you want the engine to act through the bounded runtime loop.

Best for:

- `Run next safe action`
- bounded follow-ups
- repair/research retries
- supervised self-improvement

Important rule:

- `Agent` mode is still gated by safe mode, review, autonomy, and current workspace scope
- it does not bypass the existing safety envelope

## Slash commands

You can switch modes directly in the composer:

- `/ask`
- `/plan`
- `/edit`
- `/agent`

Examples:

- `/ask why is this validation path failing?`
- `/plan the next safe coding task`
- `/edit prepare the smallest fix for renderer/app.js`
- `/agent run the next safe action`

## Recommended everyday pattern

Use this rhythm:

1. Start in `Ask`
2. Switch to `Plan` when the task needs structure
3. Switch to `Edit` when you want to prepare or confirm the patch
4. Switch to `Agent` only when you want the engine to execute the bounded loop

That keeps chat natural most of the time and still lets the engine do real work when you mean it.
