# Engine Model Proof

Updated: 2026-04-02T00:54:13.416Z
Workspace: E:\dev\projects\gosenderr-desktop-agent-PC
Pass: Per-candidate local proof pass

## Goal
Show the current Python-backed engine path, routed CLI models, learning envelope, and proof gate.

## Engine Path
- Python runtime: E:\dev\projects\gosenderr-desktop-agent-PC\.venv\Scripts\python.exe
- Acceptance artifact: E:\dev\projects\gosenderr_dev_offload\assistant_benchmarks\acceptance\2026-04-02T00-38-49-862Z-engine-acceptance-1775090298356-a4acjz9e.json
- Acceptance gate: PASS | 4 acceptance check(s) passed.
- Smoke gate: NOT RUN | The latest acceptance report does not include a recorded smoke result.
- Next-day gate: CAUTION | Proceed with caution - the latest acceptance run does not include a recorded smoke result.
- Model parity: Local-vs-remote parity is PROVEN across 5/5 core coding capabilities.
- Next safe action: Rerun acceptance with smoke coverage before using it as the next-day gate.

## Routed CLI Model Proof
- Ask: Ops summary | summarizer | engine role | GSE-1 Engine via ollama
  - CLI: npm run engine:cli -- ask "Why is the current run blocked?"
  - Model details: qwen2.5-coder:7b | profile gse-1-engine
- Plan: Plan reasoning | planner | engine role | GSE-1 Engine via ollama
  - CLI: npm run engine:cli -- plan "Plan the safest next slice for the current roadmap."
  - Model details: qwen2.5-coder:7b | profile gse-1-engine
- Edit: Code main | coder | workspace role | GS-Dev-1 Default via ollama
  - CLI: npm run engine:cli -- edit --yes "Implement the smallest safe code change for the current task."
  - Model details: qwen2.5-coder:7b | profile gs-dev-1-default
- Repair: Repair fast | repair | workspace role | GS-Dev-1 Default via ollama
  - CLI: npm run engine:cli -- repair "Repair the latest failed bounded run and rerun the smallest relevant validation."
  - Model details: qwen2.5-coder:7b | profile gs-dev-1-default

## Learning And Self-Improvement Envelope
- Operator supervision: 0 signal(s) | No operator supervision has been recorded yet.
- Training readiness: IDLE | Training is idle until trusted edits, approvals, or passed runs create new candidates.
- GS-Dev-1 export readiness: IDLE | Approved or trusted GS-Dev-1 training handoff examples will appear after safe outcomes land.
- Reusable prompts: 0 | No trusted prompt patterns recorded yet.
- Learning default: User-driven and review-backed learning stays primary. Research, tests, and accepted runs can feed memory, but they do not widen autonomy on their own.
- Self-improvement: Autonomous self-improvement is enabled by config, but it still remains bounded by approvals, safety level, and proof.
- Approval envelope: Autonomy mode: self | Safety level: lab-full-auto | Approval gate: default protected approvals | sandbox policy not overridden
- Learning journal: E:\dev\projects\gosenderr_dev_offload\learning_journal\gosenderr-desktop-agent-PC-change-journal.jsonl

## VS Code Reuse Contract
- Desktop bridge: main.js + preload.js stay the existing operator bridge.
- VS Code client surface: integration-library/extensions/vscode-companion/extension.js stays the coding-side client surface.
- Canonical tools: core/tool-catalog.js stays the engine tool surface until native replacements are proven.
- Locked plan: docs/LOCKED_PLAN_SUMMARY.md stays the multi-phase plan anchor.

## Per-Pass Proof Commands
- npm run engine:cli -- status --area roadmap
- npm run engine:acceptance
- npm run engine:cli -- proof-summary --title "Current engine pass"

## Notes
- Refresh this file after each bounded engine or model pass so the Python runtime path, routed model path, and current proof gate stay visible.
- Keep autonomous self-improvement opt-in. User input, accepted runs, focused tests, and review outcomes should remain the main supervised learning signals.
