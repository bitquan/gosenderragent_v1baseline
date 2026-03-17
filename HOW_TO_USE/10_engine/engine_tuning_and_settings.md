# Engine Tuning And Settings

Open `Settings -> AI` for model and routing controls.

Open `Settings -> Autonomy` for the safety-level selector and the approval/autonomy guardrails.

Open `Settings -> General` for chat guidance controls.

- `Off` means the chat ignores learned guidance and custom instructions.
- `Auto` means the chat can use trusted reusable prompts and style signals from accepted work.
- `Custom` means you can write a short operator instruction block by hand.

Keep `Auto` on unless you have a specific reason to force a custom style.

## The main controls

Runtime:

- `ollama` means local Ollama is the main route.
- `local` means the custom local bridge command is the main route.
- `hybrid` means local-first with fallback paths when needed.
- `openai` means the selected OpenAI-compatible remote provider is allowed as the main path.

Remote provider:

- Use the selector instead of hand-typing endpoints in normal mode.
- The current presets are:
  - `OpenAI`
  - `OpenRouter`
- `Groq`
- `Together`
- `Hugging Face Router`
- `Custom Compatible`
- `Custom Compatible` is the only normal path that should ask you for a base URL or custom key name.
- Use the masked `Provider API key` field plus `Save <provider> key` in the AI tab to store the selected provider key in the OS secret store.
- Fixed providers keep the compatible endpoint and API key slot app-managed so the status card, AI status, and Monitor stay aligned.
- `Remote API key slot` is only editable for `Custom Compatible`.
- If the provider card says `API key configured`, the app-managed secret store and the provider status path agree on that slot.

Remote model:

- This is the selector-backed model for the selected remote provider.
- Keep it selector-first.
- The app will keep the compatible endpoint and key slot attached to the provider so you do not have to remember them.

AI profile:

- `local-fast`
- `balanced-local`
- `hybrid-default`
- `best-available`
- `custom`

Routing policy:

- This is the lane-routing rule set.
- Most users should leave it matched to the active profile.
- Use `custom` only when you really want lane-by-lane control.

Configuration mode:

- `Selector` is the normal mode.
- `Custom` is the only mode that should reveal manual text fields.
- Most users should stay in `Selector`.
- In `Selector`, the app now shows a read-only resolved bridge command and a selector catalog instead of asking you to type model or command text.

Bridge profile:

- This chooses the local bridge without typing commands by hand.
- Use the built-in bridge selector first.
- The `custom` bridge only appears when configuration mode is `Custom`.
- Switch to `Custom` only if you truly need a manual command.

Primary model:

- This is the selector-backed coding model choice.
- Pick a ready discovered model when possible.
- The display label should be derived automatically unless you are in `Custom`.
- The selector catalog now mixes discovered models with recommended models, so you can see what is ready versus what still needs import.

Target hardware:

- This lets you tune the local recommendations for the machine you are preparing, even if you are not on that machine right now.
- `Current machine` is the normal default.
- `Windows dev PC (i9 / 32 GB / GPU)` is the preset for your Windows box.
- `Windows dev PC (i9 / 32 GB / RTX 4060 8 GB)` is the stronger preset for your Windows box once you want the GPU-aware target.
- That preset currently points toward a stronger local path like `qwen2.5-coder:14b` and a higher-throughput daytime profile.

Download presets:

- The AI tab now includes curated download presets.
- These show:
  - model size
  - source
  - whether it fits the current target hardware
  - a copyable install command
- Hugging Face-backed model sources are attached here so the model origin stays visible.
- Use `Pick model` for selector-first local routing and `Copy install command` when you need to fetch a model quickly.

## Extensions and integrations

Open `Settings -> Extensions` to manage the starter integration registry.

This keeps one clean place for:

- plugins
- provider adapters
- VS Code companion extensions

Installed items go into `.gos-integrations/` inside the target workspace, which keeps them easy to inspect, remove, or promote later.

Model Foundry:

- This is where the app starts turning benchmark wins and trusted prompt patterns into reusable candidates.
- Use `Seed next candidate` when the suggested candidate looks sensible.
- Good early candidates are route bundles, low-memory bundles, and prompt distillation bundles.
- Keep Model Foundry in selector-first mode too. It should suggest candidates from data instead of asking you to type model wiring by hand.

Training fallback:

- If memory, CPU, or thermal pressure gets too high, the app now shows a `Training fallback` plan instead of only telling you to stop.
- The normal fallback is:
  - switch to a quiet or eco path
  - prepare a training handoff
  - seed a lighter Model Foundry candidate
- This keeps learning moving without forcing a full local tuning pass at the worst time.

Derived model label:

- In normal selector mode, the app should derive this automatically.
- You should not have to type normal model labels by hand anymore.

## Capability lanes

The AI panel now exposes the real engine lanes:

- `chat-fast`
- `plan-reasoning`
- `code-main`
- `repair-fast`
- `review-verify`
- `research-docs`
- `ops-summary`

For each lane you can:

- inherit the profile and routing policy
- pin it to the current workspace route
- force the benchmark leader
- pin it to a specific discovered model
- reset just that lane without wiping every other lane override

Use `Reset lane overrides` if the routing starts feeling too customized or confusing.

## How to tune without making a mess

Safe tuning order:

1. Start Ollama if you want local routing.
2. Pick the correct `Primary model`.
3. Run a benchmark.
4. Check the benchmark leader and guardrail summary.
5. Only then add lane overrides.
6. If you want manual text inputs, switch to `Custom` on purpose.

Good default:

- runtime: `hybrid`
- profile: `hybrid-default`
- policy: `hybrid-default`
- main Ollama model: `qwen2.5-coder:7b` or your current best local coding model
- remote provider: `OpenAI` or `OpenRouter`, depending on whether you want official OpenAI first or a broader hosted router

## Guardrails

## Safety levels

The app now has a first-class safety-level selector.

- `Locked` means monitor and inspect only.
- `Guarded` means planning is okay, but coding work must stay in labs and promotions stay blocked.
- `Supervised Auto` is the normal balanced default.
- `Builder` allows wider coding loops with fewer pauses.
- `Lab Full Auto` is the aggressive self-improve mode, but only for labs.
- `Custom` is the only mode where you should expect more manual control.

Important:

- the safety level is the top guardrail
- if the selected safety level is not `Custom`, it can intentionally clamp the autonomy profile underneath it
- use `Custom` only when you really mean to shape the behavior by hand
- `Auto-run first step of safe supervised recipes` is useful when you want the engine to pick up low-risk follow-up work automatically without jumping straight into full autonomy

The AI panel shows:

- CPU pressure
- memory pressure
- thermal state
- active runs
- storage reachability

If memory is high:

- prefer smaller models
- reduce background work
- avoid aggressive training or multiple concurrent runs

If storage is unreachable:

- fix storage first
- do not trust training or model import flows until it comes back

## Benchmarks

Benchmarks are how the app decides which models deserve stronger lanes.

The benchmark summary tracks:

- pass rate
- latency
- repair depth
- approval count

Do not change the default routing profile just because one model feels good once. Benchmark it first.

The fastest way to do this now is:

1. Open `Monitor -> Overview`
2. Use `Run acceptance`
3. Read the newest benchmark and acceptance summary before changing routing

## Where the operational view moved

`Settings -> AI` is now for tuning.

`Monitor` is now for:

- live health
- benchmark history
- promotions
- rollback
- debug export

## VS Code bootstrap

Open `Settings -> Workspace` and use `Bootstrap VS Code` when the target repo is missing:

- `.vscode/extensions.json`
- `.vscode/settings.json`
- `.vscode/tasks.json`

The app will merge safe defaults instead of wiping your existing workspace setup.

This is meant to save time on:

- recommended extensions
- test/typecheck/smoke tasks
- basic editor settings

The workspace tab also shows `Extension health` now.

Use that to catch drift like:

- missing extension entry files
- missing shared core/runtime files
- no extension validation scripts
- an old in-repo desktop copy still sitting beside the extension
