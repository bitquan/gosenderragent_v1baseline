# Update And Release

## Work from the standalone repo

```sh
cd /Users/papadev/dev/gosenderr-desktop-agent
```

## Build local package output

```sh
npm run pack
```

## Build Mac release artifacts

```sh
npm run dist:mac
npm run dist:mac:zip
```

## Stage a Mac release

```sh
npm run release:mac
```

In the GoSenderr setup, staged desktop builds are normally kept under the configured offload area, commonly:

```sh
/Volumes/projects/gosenderr_dev_offload/desktop_builds
```

## Install or reopen the packaged app

```sh
open "/Applications/GoSenderr Desktop Agent.app"
```

## Before staging a release

Run:

```sh
npm test
npm run typecheck
npm run smoke
npm run smoke:ui
npm run packaged:smoke
```

## Important rule

Do not treat `gosenderr_v1` as the desktop source repo anymore. Package and release from `/Users/papadev/dev/gosenderr-desktop-agent`.
