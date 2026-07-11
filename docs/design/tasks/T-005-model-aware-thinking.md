# T-005: Model-aware thinking controls

## Goal
Fix settings and wire options so every already-curated reasoning-capable model exposes only its supported thinking controls. Do not add/remove model IDs.

## Sources
- `docs/design/thinking-controls.md`
- `sample/opencode/packages/opencode/src/provider/transform.ts` effort functions/variants
- Current official documentation summarized in the design: OpenAI Responses reasoning effort; Anthropic adaptive thinking.

## Requirements
1. Preserve exactly the current provider/model ID sets in `src/providers/default-providers.json`; no catalog expansion or pruning.
2. Extend typed model defaults minimally with supported effort metadata and Anthropic thinking mode (`adaptive` vs `budget`), plus persisted `anthropicThinkingEffort` (`low|medium|high|xhigh|max`). Validate config and role profiles.
3. Annotate the existing curated OpenAI/Codex/Copilot GPT, Anthropic, Copilot Claude/Fable, DeepSeek and Google reasoning-capable entries with accurate supported efforts/mode based on checked-in OpenCode logic. Fable 5 is adaptive-only, cannot be disabled, uses summarized display, efforts low/medium/high/xhigh/max direct Anthropic and low/medium/high through Copilot. GPT-5.2+ families expose none/minimal/low/medium/high/xhigh as applicable. Do not invent metadata for non-reasoning models.
4. Enrich Copilot cached `/models` metadata with endpoint, advertised `reasoning_effort`, `adaptive_thinking`, and min/max budget. Expose synchronous lookup. Remote authenticated capabilities override curated fallback for UI/request behavior; invalidate cache on login/logout.
5. Replace provider-only advanced-control visibility with selected-model-aware rendering. Reuse current controls where sensible, add Anthropic effort selector. Adaptive-only models force thinking on and hide/disable manual budget; budget models show on/off and budget; OpenAI/Codex/Copilot GPT show only valid effort options; Copilot Claude shows Anthropic controls. Unsupported controls hidden and values not submitted. Re-render on provider and model changes.
6. Settings load/save/read/render round-trip new values. Switching models must not accidentally send stale incompatible fields.
7. Runtime default/role application must handle Codex and mixed Copilot protocols by model capability. Add role-level effort controls if needed to make existing role overrides fully editable, but avoid unrelated UI redesign.
8. `buildProviderOptions` must emit exact protocol options:
   - OpenAI/Codex Responses: `reasoningEffort`, summary.
   - Anthropic adaptive: `thinking:{type:"adaptive", display:"summarized" when required}` plus top-level `effort`; never manual budget/disabled for adaptive-only.
   - Anthropic budget: existing enabled+budget or disabled behavior.
   - Copilot GPT Responses: reasoning effort, summary auto, encrypted reasoning include.
   - Copilot Anthropic Messages: adaptive/budget options consistent with cached/fallback capabilities.
   - DeepSeek/Google remain valid and their controls filtered by selected model metadata.
9. OpenCode Go: expose controls only for existing curated models with known supported behavior and send options compatible with its actual OpenAI/Anthropic route. Do not broadly assume support.
10. Add focused pure tests if feasible with existing `bun test`; at minimum export/test capability resolution and provider option building.

## Acceptance
- Script/assertion proves provider/model ID sets before and after this task are unchanged (use git diff/base snapshot, excluding pre-task additions already present).
- `bun test` if tests exist/add.
- `bun run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `git diff --check`

## Decision policy
- Decide local naming/layout.
- Do not add models. Escalate protocol ambiguity rather than guessing.
