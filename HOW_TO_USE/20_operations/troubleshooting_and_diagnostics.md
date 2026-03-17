# Troubleshooting And Diagnostics

## The app opens but feels frozen or half-clickable

Do this first:

```sh
cd /Users/papadev/dev/gosenderr-desktop-agent
npm run smoke:ui
```

Then check for stale app copies:

```sh
ps aux | grep -i "GoSenderr Desktop Agent"
ps aux | grep -i electron
```

If you have an old dev `electron .` window and a packaged app window open at the same time, close both and relaunch only the packaged app.

## Settings or long lists get clipped off-screen

This usually means a layout or overflow regression.

Check:

- the settings panel should scroll on its own
- the left rail should scroll when thread lists get long
- the center panel should not trap content past the bottom edge

Run:

```sh
npm run smoke:ui
```

If the AI, Learning, Automations, or Monitor pages are long:

- the center panel itself should scroll
- the left rail should still scroll separately
- the right inspector should still scroll separately
- content should never disappear below the window with no scroll path

## The app is using too much CPU or memory

Check live processes:

```sh
top -o cpu -l 1 | head -20
ps aux | grep -i ollama
ps aux | grep -i "GoSenderr Desktop Agent"
```

Common causes:

- repeated startup refresh loops
- too much background learning polling
- aggressive multi-run activity
- oversized local models

Fixes:

- switch to a lighter profile in `Settings -> AI`
- move training and benchmark work back to a lab or let safe mode throttle it
- disable extra background work
- stop extra runs
- use a smaller Ollama model

## Ollama is not responding

Check:

```sh
ollama --version
ollama list
```

If needed, start it from the app or from terminal:

```sh
ollama serve
```

## A model is listed but not usable

- In `Settings -> AI`, check whether the model says `ready` or `import needed`.
- If it is not ready, use `Import selected model`.
- If storage is offline, fix storage before trying again.

## Validation commands to run before digging deeper

```sh
npm test
npm run typecheck
npm run smoke
npm run smoke:ui
```

## Promotion and safe-mode recovery

If self-work went wrong:

1. Open `Monitor -> Promotions`
2. Check whether a candidate was promoted recently
3. Use `Restore last known good` or pick a specific backup from history
4. If safe mode is active, do not force more self-improve runs until the cause is understood

If safe mode keeps turning on:

- check whether you are targeting the live app repo directly instead of a lab
- check `Monitor -> Overview`
- check the newest failed run in `Monitor -> Runs`
- export a debug bundle from `Monitor -> Debug`

If the app is still unstable and you want to force a calm state:

1. Open `Monitor -> Overview`
2. Click `Pause risky work`
3. Review the paused systems list before enabling anything again

## Last-resort sanity checks

Re-open the packaged app:

```sh
open "/Applications/GoSenderr Desktop Agent.app"
```

If the installed build seems stale, rebuild and reinstall from the standalone repo instead of editing the old in-repo copy.
