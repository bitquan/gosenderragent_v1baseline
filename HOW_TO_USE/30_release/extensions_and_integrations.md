# Extensions And Integrations

Open `Settings -> Extensions` when you want one clean place for:

- plugins
- provider adapters
- VS Code companion extensions

## Why this exists

The goal is to avoid random one-off hooks.

Instead of scattering custom files everywhere, the app now keeps starter integrations in one bounded registry and installs them into:

`.gos-integrations/`

inside the current target workspace.

That makes integrations:

- easy to inspect
- easy to delete
- easy to review before promoting
- easy to replace later with a library or marketplace flow

## The starter set

The registry currently ships with one sample of each:

- `Docs Companion Plugin`
- `OpenAI Compatible Router Adapter`
- `VS Code Companion Extension`

These are starter scaffolds, not a giant plugin system yet.

That is intentional. We want a safe, modular baseline first.

## How to use it

1. Open `Settings -> Extensions`.
2. Review the summary for the starter item you want.
3. Click `Install sample`.
4. Open the installed path and inspect it before relying on it.

Installed samples go under:

- `.gos-integrations/plugins/...`
- `.gos-integrations/adapters/...`
- `.gos-integrations/extensions/...`

## Good operator habit

Treat every installed integration like code:

- read it
- test it
- keep it small
- promote it only after validation

## What comes later

Later, this can grow into:

- user-made integrations
- local import/export
- a shared online registry

The current version is meant to prove the structure cleanly first.
