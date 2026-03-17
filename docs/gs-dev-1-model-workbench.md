# GS-Dev-1 Model Workbench

GS-Dev-1 is the first repo-accurate model workbench slice for GoSenderr Desktop Agent. It does not introduce a second model platform. Instead, it extends the existing desktop AI settings, runtime routing, benchmark records, training handoff path, foundry candidates, promotion rings, and trust summaries so a wrapped model profile can behave like "my own model" while still using the engine's current layers.

## What it adds

- A GS-style wrapped profile in the existing AI settings payload.
- First-class task modes for `planner`, `coder`, `validator`, and `summarizer`.
- Backward-compatible runtime routing where:
  - `coder` maps to the engine's existing `implementer` route.
  - `summarizer` maps to the existing `release` route.
- Benchmark records that can carry:
  - wrapped profile id
  - base model
  - task mode
  - provider/source
  - benchmark tags
- Training handoff metadata for future fine-tuning exports.
- Foundry and promotion metadata for wrapped variants and future trained variants.

## Where operators see it

- `Settings -> AI`
  - GS-Dev-1 wrapper card
  - task-mode routing preferences
  - benchmark and export eligibility context
- `Monitor -> Learning`
  - GS-Dev-1 export readiness counts from trusted learning outcomes
- `Monitor -> Promotions`
  - candidate rows now show wrapped profile / base model metadata when available

## Training handoff scope

This slice is "fine-tune ready", not a full fine-tuning platform. Exported handoff metadata now preserves:

- wrapped profile id
- base model
- task mode
- trust state
- approval state
- benchmark tags when present

The repo still uses the existing artifact and training paths. It does not claim to orchestrate a full hosted fine-tune lifecycle end to end.

## Promotion and rollback

Wrapped variants flow through the current foundry and promotion systems. Candidates can now carry model-profile metadata without changing the promotion ring structure, and rollback stays on the existing backup-based path.

## Out of scope

- A separate model platform next to the engine
- A giant new dashboard
- A replacement for existing trust, review, or artifact families
- Unbounded autonomous promotion or training orchestration
