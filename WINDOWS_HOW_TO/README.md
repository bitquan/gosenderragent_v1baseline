# GoSenderr Desktop Agent PC

This is the Windows-ready sibling bundle for the standalone desktop agent.

## Default clone path

`/Volumes/projects/gosenderr-desktop-agent-PC`

Copy this folder from the external SSD onto the Windows machine before you run installs or builds.

## Recommended tools on Windows

- Git
- Node.js 20+
- PowerShell 7+
- Python 3.11+
- VS Code
- Ollama (recommended for local models)

## Recommended hardware target

- Windows dev PC (i9 / 32 GB / RTX 4060 8 GB)
- Higher-throughput target for your Windows box with an i9 12th-gen CPU, 32 GB RAM, SSD, and an RTX 4060 8 GB GPU.
- Start with `qwen2.5-coder:14b` locally and keep remote fallbacks available for harder review and multimodal work.

## Fast start in PowerShell

```powershell
Set-Location .\gosenderr-desktop-agent-PC
powershell -ExecutionPolicy Bypass -File .\scripts\windows\bootstrap.ps1
```

## Fast start in Command Prompt

```bat
cd /d D:\gosenderr-desktop-agent-PC
call scripts\windows\bootstrap.cmd
```

## Core commands

PowerShell:

```powershell
npm test
npm run typecheck
npm run smoke
npm run engine:acceptance
npm run dist:win:x64
```

Command Prompt:

```bat
npm test
npm run typecheck
npm run smoke
npm run engine:acceptance
npm run dist:win:x64
```

## VS Code

Open the folder in VS Code and use:

- `Desktop Agent PC: Bootstrap`
- `Desktop Agent PC: Validate`
- `Desktop Agent PC: Start Dev`
- `Desktop Agent PC: Package Win`
- `Desktop Agent PC: Install recommended models`

The bundle ships with:

- recommended extensions
- Windows launch config
- Windows tasks

## Important note

This PC bundle is meant to start from a known-good desktop baseline. Run validation on Windows before trusting self-improvement or promotion work there.
