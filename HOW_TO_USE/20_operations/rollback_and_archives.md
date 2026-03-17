# Rollback And Archives

The desktop app now keeps its old application bundles out of `/Applications`.

## Why this matters

Leaving every backup app in `/Applications` makes the machine messy and confusing.

It also increases the chance that you launch the wrong copy.

## New rule

Old desktop app bundles should be archived into the project rollback area instead.

For the desktop app, that archive lives under the configured promotions/offload root in:

`desktop_app_rollbacks/`

## What gets archived

- replaced live app bundles before a fresh install
- migrated legacy backups that used to live in `/Applications`

## How to install a fresh local Mac build cleanly

From the standalone repo:

```sh
cd /Users/papadev/dev/gosenderr-desktop-agent
npm run pack:mac
npm run install:mac:local
```

That flow now:

1. finds the built app
2. archives the old live app into the rollback folder
3. moves old legacy backup copies out of `/Applications`
4. installs the new app cleanly

## Where to look in the app

Open:

- `Settings -> Extensions`
- `Settings -> Storage & Diagnostics`
- `Monitor -> Promotions`

Those surfaces now help explain where rollback-ready state lives.

## Honest note

Workspace rollbacks and desktop-app rollbacks are related, but not the same thing.

- workspace rollbacks protect repo changes
- desktop app rollbacks protect the installed application bundle

Both need to stay clean if you want safe self-improvement.
