# Engine Daily Report

- Generated: 2026-03-26T20:27:46.250343+00:00
- Project root: E:\dev\projects\gosenderr-desktop-agent-PC
- Window: last 24h

## Daily Focus

- Suggested workstream: review-and-triage
- Reason: Recent runs or experiments still require manual review before widening scope.

## Maintenance Checklist

### Completed Today

- [completed | audit | daily-report] Reviewed runtime baseline state. (green baseline; blocked=False; Baseline healthy.)
- [completed | audit | daily-report] Reviewed review, repair, and validation pressure. (30 runs; 0 review-held; 0 executed repairs; 4 pass / 8 fail today)
- [completed | audit | board] Reviewed board backlog and current audit snapshot. (0 active TODO BAT items; 3 current broken audit bullets.)
- [completed | audit | board] Reviewed missing engine capability gaps for faster returns. (0 priority capability gaps still open.)

### Open Today

- [open | test | board-audit] The learning journal large-file path is functionally correct but still expensive enough that the large-journal regression test is a noticeable hotspot in the repo test suite.
- [open | remove | board-audit] Older docs still contain stale Mac-first examples and duplicate information.
- [open | fix | board-audit] Repo-wide validation still includes unrelated red tests outside this cleanup block (`tests/app-storage-paths.test.js` and `tests/smart-patch.test.js`), so the global green baseline remains blocked until those failures are repaired.

### New Problems Today

- [new | audit] No new problems were detected in the selected window.

### Missing For Faster Returns

- [missing | audit] No missing capability gaps were flagged.

### Audit Notes

- Clear review-required runs before scheduling broader autonomous work.
- Bias the next slice toward a single retry policy: repair (16 recent experiment rows).
- Keep the next operator-visible action narrow: Review the diff, update the BAT board, and continue with the next highest-priority ticket..
- Retry pressure still leans to repair (16 recent experiment rows).
- Most common training next action is Review the diff, update the BAT board, and continue with the next highest-priority ticket. (119 rows).
- Board still flags: The learning journal large-file path is functionally correct but still expensive enough that the large-journal regression test is a noticeable hotspot in the repo test suite.

### Audit Log

- [verified | audit | daily-report] Reviewed runtime baseline state. (green baseline; blocked=False; Baseline healthy.)
- [verified | audit | daily-report] Reviewed review, repair, and validation pressure. (30 runs; 0 review-held; 0 executed repairs; 4 pass / 8 fail today)
- [verified | audit | board] Reviewed board backlog and current audit snapshot. (0 active TODO BAT items; 3 current broken audit bullets.)
- [verified | audit | board] Reviewed missing engine capability gaps for faster returns. (0 priority capability gaps still open.)
- [open | test | board-audit] The learning journal large-file path is functionally correct but still expensive enough that the large-journal regression test is a noticeable hotspot in the repo test suite.
- [open | remove | board-audit] Older docs still contain stale Mac-first examples and duplicate information.
- [open | fix | board-audit] Repo-wide validation still includes unrelated red tests outside this cleanup block (`tests/app-storage-paths.test.js` and `tests/smart-patch.test.js`), so the global green baseline remains blocked until those failures are repaired.

## Daily Quota Proof

- Focus task: none recorded
- Safe autonomous actions today: 4/5
- Safe self-improvement today: 0/5
- Blocked or rescoped tasks today: 0
- Validation today: 4 pass / 8 fail / 0 review-held
- Do not widen yet because: Do not widen yet because safe autonomous progress is 4/5 today.

### Operator Actions

- Clear review-required runs before scheduling broader autonomous work.
- Bias the next slice toward a single retry policy: repair (16 recent experiment rows).
- Keep the next operator-visible action narrow: Review the diff, update the BAT board, and continue with the next highest-priority ticket..

### Small-Model Guardrails

- Force short numbered plans with 3-5 concrete steps.
- Prefer direct file edits and minimal diffs over speculative rewrites.
- Run targeted validation first before broader verification.
- Escalate to review after repeated low-confidence or repair-heavy attempts.

## Runtime Snapshot

- Baseline state: green
- Blocked: False
- Baseline reason: Baseline healthy.
- Runs analyzed: 30
- Success rate: 46.7% (14/30)
- Review request rate: 0.0% (0/30)
- Executed repair attempts: 0 total across 0 repaired runs

## Experiment Pressure

- Experiment rows analyzed: 0
- Strategy count: 1
- Review-required rate: 0.0%
- Low-confidence run rate: 0.0% (0 runs)
- Average executed repairs per experiment row: 0.00
- Retry policy recommending repair: 16 experiment rows
- Recommended next action: resolve-review-queue
- Recommended next strategy: backend_api
- Best strategy: backend_api (75.0% success, avg score 86.2)
- Weakest strategy: backend_api (75.0% success, avg score 86.2)

## Top Blockers

- none observed in the selected window

## Common Failure Fingerprints

- none observed in the selected window

## Retry Policy Mix

- repair: 16

## Recommended Actions

- Review the diff, update the BAT board, and continue with the next highest-priority ticket.: 119

## Training Signal Coverage

- Training rows analyzed: 120
- Artifact-backed rows: 119
- Log-backed rows: 1

### Training Next Actions

- Review the diff, update the BAT board, and continue with the next highest-priority ticket.: 119
