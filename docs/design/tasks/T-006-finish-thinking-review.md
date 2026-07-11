# T-006: Finish thinking controls after review

## Goal
Correct incomplete T-005 implementation. Do not change any model IDs.

## Blockers to fix
1. Capability resolution currently ignores `ProviderModelDefaults` in UI and runtime. `updateAdvancedVisibility` calls `getModelCapability` without selected defaults; `buildProviderOptions` also lacks defaults. Establish one shared effective capability path: selected curated defaults plus authenticated Copilot cache override. Carry capability ephemerally in `AiSettings` or expose a synchronous resolver; do not persist untrusted capability data.
2. Copilot cached capabilities must override fallback metadata and be invalidated on login/logout. Ensure UI refresh after model fetch/login sees them.
3. Filter each effort `<select>` options to exactly `supportedEfforts`, preserving `未指定` only where valid. On model switch, clear/clamp stale unsupported selections. Google and DeepSeek included.
4. Fix Copilot OpenAI wire options: use `include: ["reasoning.encrypted_content"]`, not invented `reasoningEncrypted`. Use the AI SDK provider option key matching the selected SDK protocol.
5. Anthropic adaptive options: `thinking:{type:"adaptive"}` and add `display:"summarized"` only when metadata says so; never emit invented `display:"detailed"`. Effort is top-level Anthropic provider option. Adaptive-only thinking cannot be disabled.
6. Anthropic budget UI must restore on/off and budget rows after switching away from adaptive models (current code only hides). Explicit OFF must send `thinking:{type:"disabled"}` where supported; ON requires a valid budget.
7. Annotate/check existing curated models against OpenCode effort logic. No model IDs may be added/removed. In particular Copilot Claude adaptive capabilities should come from `/models`; fallback metadata must match curated Fable behavior.
8. Runtime model defaults and role profile application must retain capability-appropriate effort for main/background/judgment providers, including Codex and Copilot.
9. Add focused tests under a project-local test path that does not recursively run `sample/opencode`. Add a package script if needed (e.g. `test:unit`). Test capability resolution and exact provider option objects for OpenAI, Fable adaptive, legacy budget OFF/ON, Copilot GPT and Copilot Fable.

## Acceptance
- `bun run test:unit` (or targeted `bun test <project test dir>`)
- `bun run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `git diff --check`
- Script compares current model ID arrays before/after T-006 and proves unchanged.
