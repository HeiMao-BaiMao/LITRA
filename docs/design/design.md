# Codex / GitHub Copilot provider support

## Goal
LITRA can authenticate with ChatGPT Codex and GitHub Copilot subscriptions, list usable models, and stream/tool-call through the protocol each model exposes. Existing OpenAI and Anthropic fallback catalogs are synchronized with the current `sample/opencode` snapshot.

## Source of truth
Implement behavior from these checked-in files, not guessed public endpoints or model names:
- `sample/opencode/packages/opencode/src/plugin/openai/codex.ts`
- `sample/opencode/packages/opencode/src/plugin/github-copilot/copilot.ts`
- `sample/opencode/packages/opencode/src/plugin/github-copilot/models.ts`
- `sample/opencode/packages/opencode/test/tool/fixtures/models-api.json` (OpenAI/Anthropic current catalog evidence)

## Chosen design
- Add providers `codex` and `github-copilot` to the existing settings/config/provider pipeline.
- Both use cancellable device authorization, avoiding a localhost callback server in Tauri.
- Store OAuth credential JSON only in OS keyring under a dedicated OAuth key. Settings JSON stores no token. Runtime request fetchers read/refresh credentials as needed.
- Codex follows the sample exactly: OpenAI device authorization endpoints/client ID, refresh grant, JWT account-id extraction, `https://chatgpt.com/backend-api/codex/responses`, Bearer plus `ChatGPT-Account-Id`, and the sample's current allowed models. Use OpenAI Responses protocol and omit the output cap where the sample does.
- Copilot follows the sample exactly: GitHub device endpoints/client ID, GitHub token used directly (no invented token-exchange call), `https://api.githubcopilot.com`, required API-version/User-Agent/Openai-Intent/x-initiator headers, and dynamic `/models` parsing. Select Messages for models advertising `/v1/messages`, Responses for `/responses`, otherwise Chat Completions. Because `AiSettings` currently only carries a model ID, persist a small non-secret protocol/model-capability cache or deterministically resolve it from the last fetched catalog; fall back conservatively to known definitions.
- OAuth UI replaces the API-key control for these providers with login/logout/status controls, opens verification URL using the existing Tauri opener, displays the user code, supports cancellation/timeout, and does not log tokens.
- Use a single in-flight Codex refresh promise and refresh before expiry with skew; on auth failure surface a re-login message. Retry a request at most once after refresh where safe.
- Keep OAuth mechanics provider-specific behind a small shared credential/device-poll helper only where behavior is genuinely identical.

## Catalog update
Derive OpenAI and Anthropic fallback model IDs/limits from the checked-in OpenCode models fixture/current provider references. Do not invent models beyond the sample snapshot. Preserve user config merge behavior.

## Security / robustness
- Validate OAuth credential JSON on read; malformed credentials behave as logged out.
- No access/refresh token in settings, DOM, logs, errors, or request diagnostics.
- Polling obeys server interval and `slow_down`, has AbortSignal and expiry/deadline.
- Device flow network failures produce actionable Japanese UI errors.
- Reset deletes OAuth secrets too.

## Acceptance
- `trunk build --release`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- Provider selection, settings save/load/reset, model listing, protocol routing, and auth wrappers compile and are reviewable without real credentials.
