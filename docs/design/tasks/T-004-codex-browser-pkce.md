# T-004: Codex browser PKCE login as default

## Goal
Make OpenCode-compatible browser OAuth + PKCE + localhost callback the default Codex login. Keep device auth only as an explicit fallback if UI supports it clearly.

## Source of truth
- `sample/opencode/packages/opencode/src/plugin/openai/codex.ts` browser method: CLIENT_ID, issuer, authorize params, PKCE/state, callback path/port, token exchange, account-id extraction.
- Current `src/providers/codex-auth.ts`, settings OAuth UI, Tauri command registration.

## Requirements
1. Implement a temporary localhost callback server in Rust/Tauri, default port 1455 and callback `/auth/callback`, with single-flight state, bounded timeout, cleanup, and cancellation. Never expose tokens to the callback page or logs.
2. Generate cryptographically secure PKCE verifier/challenge and CSRF state. Browser authorize URL parameters must match the sample (`openid profile email offline_access`, organizations, simplified flow, state, originator).
3. Open the authorize URL in the system browser, validate returned state, exchange code at `https://auth.openai.com/oauth/token`, extract/store credentials through the existing OS-keyring path, then shut down callback listener.
4. Settings Codex login button uses browser PKCE by default. It must not mention or require device-code authorization. Existing cancel button cancels the callback wait and resets UI. GitHub Copilot remains device auth.
5. Provide a safe browser success/error page. Bind only loopback. Handle port-in-use and timeout with actionable Japanese errors. If practical, try IPv4 loopback and ensure redirect URI exactly matches authorization/token exchange.
6. Device auth may remain as an internal/exported fallback, but must not be the default Codex UI action.
7. Add only necessary Rust dependencies; update generated licenses through existing build command.
8. Run `bun run build`, `cargo check --manifest-path src-tauri/Cargo.toml`, and `git diff --check`.

## Decision policy
- Exact OAuth protocol details must follow sample.
- Escalate only if Tauri command cancellation cannot be implemented without architectural change.
