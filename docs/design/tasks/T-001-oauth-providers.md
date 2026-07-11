# T-001: Codex and GitHub Copilot providers

## Goal
Implement the complete design in `docs/design/design.md` so LITRA supports subscription-backed Codex and GitHub Copilot models and refreshes the OpenAI/Anthropic fallback catalogs.

## Context
- Read first: `docs/design/design.md`, `src/settings.ts`, `src/providers/config.ts`, `src/providers/default-providers.json`, `src/ai/provider.ts`, `src/ai/provider-options.ts`, `src/ai/model-list.ts`, `src/ui/settings-modal.ts`, settings HTML controls, `src/secrets.ts`.
- Reference behavior exactly: `sample/opencode/packages/opencode/src/plugin/openai/codex.ts`, `sample/opencode/packages/opencode/src/plugin/github-copilot/copilot.ts`, `sample/opencode/packages/opencode/src/plugin/github-copilot/models.ts`.
- Existing unrelated providers and user provider-config merging must not break.

## Requirements
1. Add typed/configured `codex` and `github-copilot` providers everywhere provider exhaustiveness requires it, including fallback initialization paths.
2. Implement cancellable, deadline-bound device OAuth for both providers using the exact checked-in sample endpoints and client IDs. Handle pending, slow-down, denial, expiry, cancellation, and network errors.
3. Store structured OAuth credentials only in OS keyring under dedicated keys; validate reads; delete them on logout/reset. Never persist or log token values.
4. Codex requests must use the sample Codex Responses endpoint, refresh behavior, Bearer/account headers, and model allowlist. Deduplicate concurrent refreshes and use expiry skew.
5. Copilot requests must use the GitHub token directly and sample headers. Fetch and parse `/models`; expose only picker-enabled usable models while retaining safe fallbacks. Route Messages/Responses/Chat based on advertised supported endpoints; support Anthropic models via the Anthropic SDK path.
6. Integrate login/logout/status controls into the existing settings UI. OAuth providers must not misleadingly ask for API keys. Open the verification URL and show/copy the user code; allow cancellation. Japanese labels/errors should match the app.
7. Update OpenAI and Anthropic fallback model entries from the current checked-in OpenCode snapshot only. Do not invent unsupported IDs.
8. Ensure all provider-specific options, protocol metadata, model defaults/capacity, role model selectors, validation, and settings save/load paths handle the new providers.
9. Add focused tests if the repository's existing tooling supports them without introducing a new test framework; otherwise keep pure helpers exported/testable and verify by build.
10. Do not modify `sample/opencode` or generated `dist` output manually.

## Non-goals
- GitHub Enterprise support unless it is straightforward without expanding UI significantly.
- Codex WebSocket transport.
- A general-purpose OAuth framework for hypothetical providers.

## Acceptance
- Run `bun run build` → success.
- Run `cargo check --manifest-path src-tauri/Cargo.toml` → success.
- Run `git diff --check` → success.

## Decision policy
- Decide yourself: names/private helper layout, exact Japanese microcopy, focused internal types.
- Escalate: deviation from sample endpoints/client IDs/auth headers; adding dependencies; omitting one of the required model protocol families; storing OAuth tokens outside keyring.
