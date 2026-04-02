# VS Code Companion Extension

This extension adds a real GoSenderr activity-bar entry in VS Code and exposes the shared coding workbench in the side bar.

It keeps the current bounded coding loop close to the editor:

- side-bar workbench view
- wide-panel fallback
- shared next-action, review, trace, file, sandbox, and provider actions
- CLI-backed `Self improve` and `Autopilot` actions in dedicated terminals
- native Source Control and history handoff inside VS Code

Open the `GoSenderr` icon in the activity bar, run `GoSenderr: Open Chat`, or use `GoSenderr: Open Chat Panel` when you want the wide companion surface.

Packaging note:

- the current release path stays workspace-copy first through `integration.json`
- `extension.js` is the live runtime entry
- `src/extension.ts` delegates to that live runtime so the source strategy does not drift
