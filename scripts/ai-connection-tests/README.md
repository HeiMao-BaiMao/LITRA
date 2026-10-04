# Headless AI connection regression tests

Run `cargo test --manifest-path scripts/ai-connection-tests/Cargo.toml`.

This harness compiles the production AI request lifecycle, protocol parsers,
provider adapters, credential store, and OAuth flow code directly. Only Tauri's
IPC/command shell and browser launcher are stubbed, and OS credential access
panics. Tests use collected IPC events, fake keyring storage, and loopback HTTP.
No real provider requests, saved keys, OAuth logins, or desktop are required.

This is a focused check for systems without Tauri/GTK libraries. It does not
replace `cargo test --manifest-path src-tauri/Cargo.toml` or interactive desktop
verification. Keep the harness dependencies aligned with the application.
