# T-002: Complete and verify OAuth provider integration

## Goal
Finish the partial T-001 implementation currently in the worktree, especially the missing settings OAuth UI and correctness review.

## Requirements
1. Review the entire current diff and the source-of-truth sample files named in `docs/design/design.md`; fix incorrect or incomplete behavior.
2. Add usable login/logout/status/cancel UI for Codex and GitHub Copilot to the existing settings modal. Add required DOM controls and `layout.ts` element bindings. OAuth providers hide/disable API-key entry. Login starts the provider device flow, opens verification URL via Tauri opener, clearly displays/copies user code, supports cancellation, and refreshes status. Logout deletes credentials. Avoid token exposure.
3. Ensure settings save does not overwrite OAuth credentials and reset deletes them.
4. Ensure Copilot model endpoint metadata survives dynamic model fetch and request creation routes Messages/Responses/Chat correctly. A plain string list that discards advertised endpoint metadata is insufficient.
5. Ensure Codex request URL/headers/refresh/model allowlist exactly follow sample. Ensure Copilot headers and direct GitHub token exactly follow sample.
6. Check all app paths for provider exhaustiveness and defaults.
7. Do not modify generated `dist` manually or sample files.

## Acceptance
- `bun run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `git diff --check`
- Grep/manual evidence that settings UI imports and invokes both login functions and logout.
