# Copilot Instructions

Use `docs/BAT_FEATURE_BOARD.md` as the single source of truth for this repository.

Rules:

- Read `docs/BAT_FEATURE_BOARD.md` before making workflow, architecture, engine, or operational changes.
- Treat that file as the canonical board, audit, command book, and operating manual.
- Prefer source files over generated copies under `dist/` or `WINDOWS_APP/`.
- When you add a durable rule or workflow, update `docs/BAT_FEATURE_BOARD.md` first.
- If an older doc conflicts with that file, prefer `docs/BAT_FEATURE_BOARD.md`.