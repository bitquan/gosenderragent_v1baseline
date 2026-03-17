# Learning And Self Tuning

Open `Settings -> Learning` when you want to see what the engine is actually learning from your approved work.

## What the Learning panel now shows

- `Pending train candidates`
  - trusted edits, approved reviews, and accepted passed runs queue up here
- `Naming profile`
  - the app learns which verbs and change styles show up most often in trusted sessions
- `Training readiness`
  - tells you if training is `ready`, `waiting`, `paused`, `triggered`, or `idle`
- `Reusable prompt patterns`
  - trusted chat prompts graduate here so they can become cleaner recipe candidates later
- `Reusable command patterns`
  - trusted supervision and accepted work can now suggest better slash commands and quick prompts without forcing you to type them from scratch
- `Common targets`
  - shows the screens, features, or change areas the engine is learning most often
- `Operator supervision`
  - approvals, needs-changes notes, and comment-only guidance from Test Bench/Monitor land here so chat can reuse them without turning into clutter

## What counts as trusted learning

The app should only learn from signals that are actually useful.

Trusted signals include:

- approved review decisions
- approved operator supervision from Monitor/Test Bench
- accepted manual edits
- passed runs that were explicitly accepted or trusted
- explicit training-candidate events

The app should not treat every prompt or failed run as something worth learning from.

## What the training readiness states mean

- `ready`
  - trusted candidates exist and the next quiet machine window can use them
- `waiting`
  - training is intentionally waiting because the machine is busy, still cooling down, or inside cooldown
- `paused`
  - training should not run yet because a stronger guardrail blocked it, usually thermal pressure
- `triggered`
  - idle-safe learning already kicked off for the latest candidate set
- `idle`
  - nothing trusted is queued yet

## Screenshot-first learning

When you attach a screenshot in chat:

- the engine uses it as a reference, not as a file to edit
- the planner builds safe slices around it
- the resulting accepted work can help the learning profile understand your preferred UI direction over time

## Best habit

If the engine produces good work:

1. review it
2. approve or accept it clearly
3. let the learning profile absorb that pattern

If the engine produces weak work:

1. reject or revise it
2. do not force training
3. keep learning signals clean

That makes the profile sharper instead of noisier.

## Operator supervision loop

Open `Monitor -> Runs` when you want to guide the engine without editing code yourself.

You can now:

- record `approval`
- record `needs changes`
- record `comment`
- turn a note into a bounded follow-up task

Those signals feed:

- chat guidance
- reusable command patterns
- reusable supervision patterns
- naming and task phrasing
- future revision suggestions
- future regression suggestions

## What reusable command patterns are for

The app now keeps a small learned list of commands and prompt starters that match the work you actually approve.

That means:

- if you often ask for review, repair, or implement flows, chat suggestions should drift in that direction
- if you guide the engine with repeated operator notes, those notes can become cleaner prompt starters later
- the goal is less retyping, not more UI clutter
