# Model-aware thinking and reasoning controls

## Constraint
Preserve the intentionally curated model catalogs. This work must not add providers or model IDs. Dynamic Copilot `/models` remains account-scoped, but fallback catalogs stay curated.

## Problem
Visibility and request generation are keyed only by provider. This fails for mixed-protocol providers (GitHub Copilot), adaptive-only Anthropic models (Fable 5), and models whose supported effort tiers differ. Capability data fetched from Copilot is discarded. Role settings support more fields than their UI exposes.

## Evidence
- OpenCode `transform.ts`: GPT-5.2+ efforts are `none|minimal|low|medium|high|xhigh`; newer Anthropic/Fable 5 use `thinking:{type:"adaptive",display:"summarized"}` plus top-level `effort` (`low|medium|high|xhigh|max`); Copilot Anthropic limits adaptive effort to `low|medium|high`; Copilot OpenAI uses `reasoningEffort`, `reasoningSummary:"auto"`, encrypted reasoning include.
- Anthropic official docs: Fable 5/adaptive-only models do not support disabled/manual budget thinking.

## Design
1. Extend curated model defaults with explicit reasoning capability metadata rather than infer UI solely from provider. Metadata includes kind (`openai`, `anthropic-adaptive`, `anthropic-budget`, `deepseek`, `google`), supported effort values, whether thinking can be disabled, and optional budget bounds/default. Existing model IDs only.
2. Preserve existing persisted fields for compatibility, adding `anthropicThinkingEffort` (`low|medium|high|xhigh|max`). No generic untyped bag.
3. Settings UI chooses controls by selected model capability:
   - OpenAI/Codex/Copilot GPT: effort dropdown filtered to supported values.
   - Anthropic adaptive/Fable/Copilot Claude adaptive: thinking is forced on when disabling is unsupported; show effort; hide budget.
   - Anthropic legacy budget: show on/off and budget; no unsupported effort.
   - DeepSeek: show on/off and supported effort.
   - Google: show supported thinking levels.
   Unsupported controls are hidden/disabled and are not submitted.
4. Copilot `/models` retains endpoint and supports fields (`reasoning_effort`, `adaptive_thinking`, min/max budget). Expose a synchronous cached capability lookup so both model creation and settings UI can use the last fetched result. Curated fallback metadata applies before fetch.
5. `buildProviderOptions` emits protocol-correct options for Copilot and Anthropic adaptive models. OpenAI Responses uses `reasoningEffort`; Anthropic uses adaptive thinking plus effort; Copilot GPT includes summary/encrypted reasoning. Never send budget/manual thinking to adaptive-only models.
6. Runtime model defaults and role overrides apply by capability, not only provider equality. Add role effort controls only where existing role override architecture can represent them reliably.
7. OpenCode Go: only expose thinking controls for curated models whose actual Go API protocol/capability is known. Do not assume every model supports a provider-native option.

## Acceptance
- Existing curated model IDs unchanged.
- Selecting every curated reasoning-capable model shows only valid controls and sends matching provider options.
- Settings round-trip preserves selected effort/on state.
- `trunk build --release`, `cargo test --manifest-path src-tauri/Cargo.toml`, `git diff --check` pass.
