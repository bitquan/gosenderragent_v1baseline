# Windows PC Clone

Use this when you want to stage a Windows-ready sibling copy of the desktop agent on the external SSD.

## Default target

The prep script now defaults to:

`/Volumes/projects/gosenderr-desktop-agent-PC`

That keeps the Windows bundle on the external drive instead of mixing it into the main Mac repo.

## Build the clone

Run this from:

```sh
cd /Users/papadev/dev/gosenderr-desktop-agent
```

Then run:

```sh
npm run prep:windows:pc
```

If you want a different target path:

```sh
node ./scripts/prepare-windows-pc-clone.js /Volumes/projects/custom-gosenderr-agent-PC
```

## What the prep script does

- backs up any existing Windows clone first
- copies the current working tree to the SSD target
- rewrites the clone package metadata to `GoSenderr Desktop Agent PC`
- adds Windows VS Code settings, tasks, and launch configs
- adds PowerShell and Command Prompt helper scripts
- adds a Windows tuning template with the `windows-i9-32gb-rtx4060-8gb` hardware target preset
- adds a recommended model install task
- copies packaged Windows installers and unpacked Windows app builds into `WINDOWS_APP/` if any already exist
- writes a Windows operator guide inside the clone

## What to open on the Windows machine

After you move the folder to Windows, start with:

- `WINDOWS_HOW_TO/README.md`
- `.vscode/tasks.json`
- `scripts/windows/bootstrap.ps1`
- `dev_assistant.local.yaml.example`
- `WINDOWS_APP/README.md`

## Good first steps on Windows

PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\bootstrap.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-models.ps1
npm test
npm run typecheck
npm run smoke
npm run dist:win:x64
```

Recommended Windows baseline for your PC:

- hardware target: `windows-i9-32gb-rtx4060-8gb`
- GPU target: `RTX 4060 8 GB`
- primary local model: `qwen2.5-coder:14b`
- keep a remote provider configured too, so hard review or vision tasks can escalate safely when the local route is not enough

## Honest note

This gives you a clean Windows-ready bundle and starter configs, but it is still a staged operator bundle until it has been validated on the Windows machine itself.
