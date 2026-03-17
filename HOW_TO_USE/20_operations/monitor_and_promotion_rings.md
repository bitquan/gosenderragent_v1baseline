# Monitor And Promotion Rings

This is the easiest way to think about safe self-improvement in the desktop agent.

## The three rings

`Lab`:

- The agent experiments here first.
- This is where self-hosting and risky fixes should happen.
- A lab can be broken, reset, benchmarked, and thrown away.

`Candidate`:

- This is the staging ring between a lab and the live workspace.
- A candidate means: "this lab change looks good enough to consider promoting."
- Candidates should come from a verified lab run, not from guessing.

`Live`:

- This is the real workspace or real installed flow you care about.
- Live should only receive promoted work after checks pass.

## The normal safe flow

1. Create or select a lab.
2. Ask chat to do the work there.
3. Run the benchmark or validation checks.
4. Open `Monitor -> Promotions`.
5. Create a candidate from the active lab.
6. Check that the promotion gate says the candidate is ready.
7. Promote that candidate to live.
8. If the result is bad, restore the last known good backup or pick a specific backup from history.

## Where to watch this

Open `Monitor`.

Use these sub-tabs:

- `Overview` for general health
- `Runs` for execution history, Reviewer, Test Bench, and Regression Builder
- `Learning` for journal and training candidates
- `Promotions` for candidate and rollback actions
- `Debug` for export bundles

`Overview` is also where you can run the acceptance gate without leaving the app.

It is also where the new `Trusted docs vault` summary lives, so you can tell whether docs context is:

- fresh
- aging
- stale
- missing

It is also where you can:

- engage hard safe mode
- release manual safe mode
- see which systems are paused right now
- read the promotion gate summary before touching live
- see the current `30-day baseline readiness` score
- see the next milestone the engine still needs before the MVP baseline feels trustworthy

## Test Bench and Reviewer

Open `Monitor -> Runs` when you want the review loop in one place.

That screen now gives you:

- Reviewer summary
- reviewer notes
- one-click revision task creation
- operator comments that turn into bounded follow-up tasks
- operator approvals / needs-changes / comment-only supervision
- a merged `Suggested next moves` queue that combines revision and regression follow-ups
- stale-doc signals that can become a bounded docs-refresh task before the next docs-led revision or promotion
- docs-sensitive review work without trusted docs can now trigger a bounded docs-scout task instead of guessing
- trusted docs context, including freshness and the latest approved source
- `Next safe action` highlights the single safest follow-up to queue next, and only marks `auto-queue ready` for very low-risk supervised slices
- when docs are missing or stale, Monitor now suggests the most relevant trusted docs families for that slice instead of making you guess which source to use first
- `Supervised recipe` can queue a small safe sequence like `docs refresh -> revision -> regression` so the engine can take a little more of the loop without widening scope
- changed files and failing locations
- recent artifacts
- regression task suggestions
- auto revision pressure when the latest trusted operator note says `needs changes`

Use it like this:

1. run or sync the workspace
2. open `Monitor -> Runs`
3. read the Reviewer summary first
4. open the suggested file if needed
5. add an operator comment if you want a specific change before approval
6. create a revision task or regression task directly from that screen

If you record `needs changes`, the reviewer and regression builder now treat that as supervision instead of a dead-end note:

- Reviewer can flip the run back into a revision-ready state
- Regression Builder can suggest a follow-up regression task so the same problem is less likely to come back

## What the readiness score means

The `30-day readiness` score is a simple progress meter, not magic.

It blends:

- baseline stability
- promotion rings and rollback
- monitor coverage
- chat learning
- reviewer/test bench/regression foundations
- trusted docs usage
- safe-slice execution

Use it like this:

- `0-39%`: still early, keep changes small
- `40-59%`: the MVP shape is visible, but the loop still needs more proof
- `60-79%`: advancing, safe enough for stronger lab work
- `80%+`: strong baseline, ready for wider unlocks if the daily gates stay green

## When safe mode should block you

Safe mode is doing its job when:

- the live app repo is targeted directly instead of a lab
- the baseline is unhealthy
- recent self-work failed badly
- the machine is under enough pressure that training or benchmark work should pause

If safe mode is active:

- background autonomy should pause
- training can be paused
- benchmark work can be paused
- promotion can be blocked

If you hit `Pause risky work` in `Monitor`, the app now does three things together:

- stops the scheduler
- cancels risky active runs
- keeps promotion, training, and benchmark work paused

## How safety level and safe mode work together

Think of them like two different layers:

- `Safety level` is the operator-selected policy
- `Safe mode` is the emergency brake when the app thinks the baseline is at risk

Good rule of thumb:

- use `Supervised Auto` for normal day-to-day work
- use `Guarded` when you want to slow the app down without fully locking it
- use `Lab Full Auto` only when the active target is truly a lab
- if safe mode trips, fix the cause first instead of forcing more self-work

## Rollback

Promotion creates a backup before live files are replaced.

If a promotion goes wrong:

1. Open `Monitor -> Promotions`
2. Use `Restore last known good` if you want the fastest rollback
3. Or pick a specific backup from `Backup history`

That should restore the protected files from the pre-promotion state.

## Best habit

If you want the app to work on itself safely, do not skip the rings.

`Lab -> Candidate -> Live` is the line that keeps "self-improving" from turning into "self-breaking."
