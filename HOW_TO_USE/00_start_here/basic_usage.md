# Basic Usage

## 1. Open the app

Packaged app:

```sh
open "/Applications/GoSenderr Desktop Agent.app"
```

Run from source:

```sh
cd /Users/papadev/dev/gosenderr-desktop-agent
npm run start
```

## 2. What you should see on startup

- The app should open into the chat workbench first.
- You should not need to look at settings before sending a normal coding request.
- The left rail and right rail are optional. Open them only when you need more context.

## 3. Pick a workspace

- Use `Pick workspace` or `Switch` if the wrong repo is active.
- The desktop app repo and the target workspace are different things.
- Choose a workspace on the current machine before you run work, or create a new empty one and point the app there.

## 4. Start with chat

Good first prompts:

- `Review the current repo and tell me what needs fixing first.`
- `Plan the next safe coding task in this workspace.`
- `Set up the coding model and verify the engine is ready.`
- `Repair the latest failure and summarize the diff.`

You can also attach a screenshot from the chat composer.

- The app treats screenshots as reference material.
- It should break the work into safe slices instead of trying to edit the screenshot file itself.

## 5. Use the rails only when needed

Left rail:

- threads
- workspace and lab targeting
- shortcuts into Settings sections like AI, Skills, Tools, Labs, and Learning

Right rail:

- review queue
- file preview
- diff
- learning and context

If the app is in `safe mode`, that is not a random error state.

- it means live risky work is intentionally paused
- open `Monitor` or `Inbox` to see why
- release it only when you understand the reason

## 6. Use Settings for system controls

Settings is where the non-chat controls live:

- General
- Workspace
- AI
- Autonomy
- Skills
- Tools
- Automations
- Labs
- Learning
- Storage & Diagnostics

## 7. Know the BAT rule

- Normal users should think in chat requests, goals, tasks, and runs.
- BAT is still supported, but only for engine/backlog compatibility when the workspace already has BAT files.
- BAT is not the main public UI language anymore.
