# Git Workflow and Releases

## Branch model

Use this repo flow:

- `main`
  Baseline branch for protected work and release-ready state.
- `codex/*`
  App-created and feature branches.
- `desktop-v*`
  Release tags.

Examples:

- `codex/git-panel`
- `codex/chat-modes`
- `desktop-v0.1.5`

## Desktop Git workspace

Open the `Git` route in the desktop app when you want git-native work without leaving the app.

What it shows:

- current branch
- upstream
- ahead/behind
- dirty state
- last commit summary
- staged files
- unstaged files
- untracked files
- inline diff viewer

What you can do:

- `Stage`
- `Unstage`
- `Discard` unstaged changes for a file
- `Commit staged`
- `Pull`
- `Push`
- `Publish branch`
- `Create branch`
- `Switch branch`

## Safe rules

- commit only staged changes
- pull only with a clean worktree
- switch branches only with a clean worktree
- discard changes only per file, not with a broad reset
- app-created branches should use `codex/`

## Suggested daily git flow

1. Start in Chat
2. Ask or plan the next bounded task
3. Switch to `Git`
4. Review staged and unstaged changes
5. Commit staged work with a clear message
6. Publish the branch if it is new
7. Push tracked updates

## VS Code companion git behavior

The companion does not try to replace native VS Code source control.

Use it for:

- branch/dirty summary
- `Open Source Control`
- `Open Git history`

Use the desktop app for mutating git actions in this baseline.

## GitHub workflows

The repo now expects:

- `ci.yml`
  Runs on `main`, `codex/**`, and pull requests.
- `baseline-proof.yml`
  Runs acceptance and system checks on `main`.
- `release.yml`
  Runs on `desktop-v*` tags and publishes release artifacts.

## Release flow

Recommended release steps:

1. Make sure `main` is healthy
2. Push the final baseline commit
3. Tag the release
4. Push the tag
5. Let `release.yml` build artifacts and attach them to GitHub Releases

Example:

```powershell
git checkout main
git pull --ff-only
git tag desktop-v0.1.5
git push origin main --tags
```

Keep packaged binaries out of git. Let workflows and Releases carry them instead.
