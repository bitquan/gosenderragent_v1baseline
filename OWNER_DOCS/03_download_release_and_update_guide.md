# Download, Release, and Update Guide

## Goal

Use this guide when you want a real Windows download artifact from the current shipped app state.

## Build the current Windows release

From the repo root run:

```powershell
npm run dist:win:current
```

That script:

1. packages the current shipped desktop app
2. builds Windows `nsis` and `zip` artifacts
3. stages them into the configured desktop release directory
4. prints the latest downloadable artifact path

## What this script is for

Use `dist:win:current` when you want the packaged app to match the current shipped `renderer/` files.

This is the safest owner-facing release command for the current baseline.

## What gets produced

Expected artifact types:

- `.exe`
- `.zip`

The script prints the latest download path after staging completes.

Current staged Windows release location:

- `E:\dev\projects\gosenderr_dev_offload\desktop_releases`

Current version built in this pass:

- `E:\dev\projects\gosenderr_dev_offload\desktop_releases\GoSenderr Desktop Agent PC-0.1.4-x64.exe`
- `E:\dev\projects\gosenderr_dev_offload\desktop_releases\GoSenderr Desktop Agent PC-0.1.4-x64.zip`

## Install the new version

1. Run `npm run dist:win:current`
2. Open the printed release path
3. Use the `.exe` installer for the normal Windows install flow
4. Keep the `.zip` if you want a portable download copy

## Update and rollback

The app now tracks release and rollback evidence through the existing release/update path.

If you need to check status:

```powershell
npm run system:check -- --area roadmap
npm run system:check -- --area acceptance
npm run system:check -- --area promotion
```

## Before sharing a build

Run these first:

```powershell
npm run system:check -- --area roadmap
npm run system:check -- --area trust
npm run system:check -- --area acceptance
```

If you want the full proof bundle too:

```powershell
npm run engine:acceptance -- --full-self-host
```

## Recommended owner release flow

1. Make the UI or baseline change
2. Run focused tests
3. Run `system:check`
4. Build with `npm run dist:win:current`
5. Install or share the generated `.exe`
