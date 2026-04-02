# GoSenderr Desktop Agent PC

Use `docs/BAT_FEATURE_BOARD.md` first for the live command book, board ownership, and active roadmap state. This file is Windows-specific quick-start reference material only.

## Recommended clone path

Clone or copy the repo onto a local Windows drive that matches your current workspace layout, for example `E:\dev\projects\gosenderr-desktop-agent-PC`.

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
- Start with `qwen2.5-coder:7b` as the normal local baseline, then move to `qwen2.5-coder:14b` only when a specific proof slice shows the heavier lane is worth the extra headroom.

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
