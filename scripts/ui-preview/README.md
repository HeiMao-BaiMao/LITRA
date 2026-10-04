# Real Rust/WASM UI preview

This harness loads the compiled production frontend, including its Rust DOM rendering,
event handlers, settings form and provider switching. It replaces only Tauri IPC with
explicitly fictional, memory-only data. It is **not** a native app, live AI connection,
credential test, synchronization test, or desktop-window integration test.

## Build and run

Use the repository's Rust toolchain to build `frontend-rs` for
`wasm32-unknown-unknown --release`. Install the official `wasm-bindgen-cli` version
matching `frontend-rs/Cargo.lock` (currently 0.2.126).

```sh
cargo build --manifest-path frontend-rs/Cargo.toml --target wasm32-unknown-unknown --release
python3 scripts/ui-preview/preview.py build --name baseline --ref ef88c643fe2332213d5ec81f6fa28d32a99f3ea6 --bindgen /path/to/wasm-bindgen
python3 scripts/ui-preview/preview.py build --name current --bindgen /path/to/wasm-bindgen
python3 scripts/ui-preview/preview.py serve
```

- Before: http://127.0.0.1:4173/baseline/
- Current working tree: http://127.0.0.1:4173/current/
- Empty state: http://127.0.0.1:4173/current/?fixture=empty
- Error state: http://127.0.0.1:4173/current/?fixture=error
- Loading state: http://127.0.0.1:4173/current/?fixture=loading
- Detached UI example: http://127.0.0.1:4173/current/settings-window.html
- Exact-width iframe controls: http://127.0.0.1:4173/viewport.html

`error` fails model fetching and simulated generation after the normal mount.
`loading` holds model fetching and simulated generation pending, so the app's real
loading/disabled/stop states can be inspected. Normal generation is a clearly marked,
fixed fictional answer. Reload resets all edits. Empty mode starts without projects.

The script takes HTML/CSS/public provider catalog from `--ref`, or the working tree
when omitted. The supplied WASM binary is shared across snapshots. For a functional
before/after comparison after Rust changes, build and supply each version separately
using `--wasm`. `preview-manifest.json` records the binary hash and source revision.

All build output is ignored under `.build/`. Re-run `build --name current` after
HTML/CSS changes and reload the browser. The server disables caching and limits
network connections to its own origin through CSP. The harness loads no user files,
credentials or native data. Unsupported commands fail explicitly; inspect
`window.__LITRA_PREVIEW__.unsupported`, `.errors`, and `.calls` in browser diagnostics.
Only command names, never credential arguments, are recorded.

Detached windows can be opened directly and receive fictional seed events. Pop-outs
use browser tabs and a same-origin BroadcastChannel for previewing synchronization;
this does not validate Tauri window geometry or lifecycle behavior.

## Verification and current environment limitation

```sh
python3 -m py_compile scripts/ui-preview/preview.py
node --check scripts/ui-preview/tauri-fixture.js
node --test scripts/ui-preview/fixture-smoke.cjs
```

These dependency-free tests check the **fixture's IPC contract only**, including
populated/empty data, settings save/reset, fixed-response streaming, error behavior,
loading cancellation and detached seed events. They do not execute browser DOM
rendering, WASM mounting, or CSS layout.

In the audit's cloud environment, the browser rejected the local preview URL with
`ERR_BLOCKED_BY_CLIENT`; separate command sandboxes also could not reach the preview
listener. The build completed, but interactive UI checks and before/after screenshots
were **blocked and not verified** there. No tunnel, external hosting or alternative
network route was used. Run the documented local server in an authorized environment
to complete visual and interaction QA; serving the files does not by itself prove
that the Rust app mounted successfully.
