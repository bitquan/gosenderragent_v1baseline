# Archive Folder

Use this folder when something is no longer active but is still worth keeping for reference or rollback.

Rules:

- Create a dated subfolder such as `archive/2026-03-26-route-cleanup/`.
- Add a short note inside that subfolder that records:
  - the original path
  - why the item was retired
  - what replaced it
  - whether it is safe to delete later
- Move source-side docs, experiments, or retired implementation files here only when they are no longer part of the live workflow.
- Do not archive generated output from `renderer/`, `dist/`, or `WINDOWS_APP/`.
- Do not treat `archive/` as a trash bin. If something is still active, leave it in the live tree.

Current state:

- The archive workflow exists, but no files have been moved here yet.