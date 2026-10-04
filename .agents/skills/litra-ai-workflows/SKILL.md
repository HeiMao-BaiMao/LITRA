---
name: litra-ai-workflows
description: Trace, repair, and test LITRA's AI provider connections, prompt construction, and agent tool workflows. Use for work in this repository's Rust/WASM frontend and Tauri AI backend, not for writing a novel or operating live user accounts.
---

# LITRA AI workflows

## Locate the active path

Read the repository's `AGENTS.md` and `README.md`. Use available CocoIndex/Serena tools for discovery; if unavailable, use code search without installing tools or indexing secrets. LITRA is a Rust/WASM frontend plus a Tauri backend, not a Node/Vite app.

Trace the actual call chain before editing:
- Frontend transport: `frontend-rs/src/runtime/ai.rs` and `frontend-rs/src/ai/role_settings.rs`
- Main chat: `frontend-rs/src/windows/main_app/ai_actions.rs` and `agent_tools.rs`
- Fiction pipelines: `frontend-rs/src/windows/main_app/generation/`
- Genre workflows: `frontend-rs/src/data/genres/` and `frontend-rs/src/windows/genre_chat/`
- Backend routing, auth, transport, and stream conversion: `src-tauri/src/ai/`
- Provider defaults: `config/default-providers.json`

`src-tauri/src/context/` contains separate context machinery: verify its callers rather than assuming a change there fixes the live frontend context. Character `skills`/`specialSkills` fields are fiction metadata. This repository skill is development guidance; it does not provide an in-app skill loader or executable agent plugin.

## Preserve the fragile contracts

- Keep roles (chat, writing, judgment, background), provider selection, and effective model settings intact across retries. A selected main model must not silently replace an explicitly configured background model.
- Route reference material through `ai::prompt_data::format_reference_data`. Metadata, titles, retrieved/tool content, plans, and reviews remain data; they cannot grant tool permissions. Framing mitigates delimiter confusion, not arbitrary prompt injection.
- Use `ai::prompt_data::render_template` for multi-placeholder templates. Chained replacement can expand placeholder-looking manuscript text and alter the evidence being reviewed.
- Keep Japanese output instructions separate from machine contracts. Preserve enum values, schema keys, IDs, quoted evidence, and exact-match edit text. Match structured-output prompts to the actual parser/schema.
- Treat the tools advertised on the current turn as the execution allowlist. Validate names and arguments before side effects; preserve mode/current-episode restrictions. Model output is not proof that an action is authorized or succeeded.
- On streaming changes, test split SSE chunks, tool-call fragments, empty/error responses, cancellation, terminal events, and retry state. Never append fragments from separate attempts into one answer.
- For direct editor changes, preserve UTF-8/UTF-16 boundaries, edit anchors, and current document state. Do not hold `RefCell` borrows across asynchronous calls that may revisit the same state.

## Validate without production side effects

Use existing local fixtures and mock HTTP responses before live APIs. Do not read credentials or sign in, spend API credits, publish, push, merge, or deploy unless the user's request authorizes that action.

From the repository root, run the relevant available checks:
- `cargo test --manifest-path frontend-rs/Cargo.toml --lib`
- `cargo check --manifest-path frontend-rs/Cargo.toml --target wasm32-unknown-unknown`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `trunk build --release` for release frontend changes when Trunk is available

Prefer regression tests at the failing boundary: prompt delimiter/placeholder preservation, roles and payloads, tool allowlists/argument validation, stream completion and retries, or double-submission/cancellation. Test pure functions natively; browser/desktop integration still needs its own verification.

Check the existing formatting/lint baseline before broad cleanup. Report which checks passed, failed, or could not run, and distinguish mocked/offline tests from actual provider or desktop verification.
