#!/usr/bin/env python3
"""Build/serve the real Rust/WASM UI against an explicitly fictional Tauri fixture."""
from __future__ import annotations

import argparse
import functools
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BUILD = HERE / ".build"
HTML_FILES = ["index.html", "chat-window.html", "settings-window.html",
              "summary-window.html", "memo-window.html", "project-memo-window.html",
              "genre-library.html", "genre-chat-window.html"]


def source(path: str, ref: str | None) -> bytes:
    if ref:
        return subprocess.check_output(["git", "show", f"{ref}:{path}"], cwd=ROOT)
    return (ROOT / path).read_bytes()


def build(args: argparse.Namespace) -> None:
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", args.name):
        raise SystemExit("--name must be a simple directory name")
    output = BUILD / args.name
    output.mkdir(parents=True, exist_ok=True)
    wasm = Path(args.wasm).resolve()
    if not wasm.is_file():
        raise SystemExit(f"Build Rust first: missing {wasm}")
    bindgen = shutil.which(args.bindgen) or args.bindgen
    if not Path(bindgen).is_file():
        raise SystemExit("wasm-bindgen is missing. Install the version matching frontend-rs/Cargo.lock, then pass --bindgen PATH.")
    subprocess.run([bindgen, str(wasm), "--target", "web", "--out-dir", str(output),
                    "--out-name", "litra-frontend", "--no-typescript"], check=True)
    prefix = f"/{args.name}/"
    # The fixture runs synchronously before any WASM module can mount.
    injection = ('<script src="' + prefix + 'provider-fixture.js"></script>\n'
                 '<script src="' + prefix + 'tauri-fixture.js"></script>\n')
    for name in HTML_FILES:
        html = source(name, args.ref).decode()
        if name == "index.html":
            html = re.sub(r'<link\s+data-trunk\s+rel="css"[^>]*>',
                          '<link rel="stylesheet" href="/styles.css" />', html)
            html = re.sub(r'\s*<link\s+data-trunk\b[^>]*>', "", html)
            html = html.replace("</head>", '<script type="module">\n'
                                "import init, * as bindings from '/litra-frontend.js';\n"
                                "const wasm = await init({ module_or_path: '/litra-frontend_bg.wasm' });\n"
                                "window.wasmBindings = bindings;\n"
                                'dispatchEvent(new CustomEvent("TrunkApplicationStarted", { detail: { wasm } }));\n'
                                "</script>\n</head>")
        # Detached windows use root-relative production assets; scope these to the snapshot.
        for asset in ("styles.css", "LITRA.svg", "litra-frontend.js", "litra-frontend_bg.wasm"):
            html = html.replace("/" + asset, prefix + asset)
        html = html.replace("<head>", "<head>\n" + injection, 1)
        (output / name).write_text(html)
    (output / "styles.css").write_bytes(source("src/styles.css", args.ref))
    (output / "LITRA.svg").write_bytes(source("src/assets/LITRA.svg", args.ref))
    # Provider labels/models come only from the checked-in public catalog, never credentials.
    config = json.loads(source("config/default-providers.json", args.ref))
    (output / "provider-fixture.js").write_text(
        "window.__LITRA_PREVIEW_PROVIDERS__ = " + json.dumps(config["providers"], ensure_ascii=False) + ";\n")
    shutil.copyfile(HERE / "tauri-fixture.js", output / "tauri-fixture.js")
    manifest = {"name": args.name, "htmlCssRef": args.ref or "working-tree",
                "wasmSha256": hashlib.sha256(wasm.read_bytes()).hexdigest(),
                "wasmSource": str(wasm), "backend": "fictional in-memory fixture; no real Tauri/API"}
    (output / "preview-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    links = "".join(f'<li><a href="/{p.name}/">{p.name}</a></li>'
                    for p in sorted(BUILD.iterdir()) if p.is_dir() and (p / "index.html").exists())
    (BUILD / "index.html").write_text('<!doctype html><meta charset="utf-8"><title>LITRA UI previews</title>'
                                     '<h1>LITRA Rust/WASM previews</h1><p>Fictional data. No native backend or API calls.</p>'
                                     f'<ul>{links}</ul><a href="/viewport.html">Responsive viewport controls</a>')
    shutil.copyfile(HERE / "viewport.html", BUILD / "viewport.html")
    print(f"Built {output}\nPreview: http://127.0.0.1:4173/{args.name}/", flush=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'")
        super().end_headers()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("build")
    p.add_argument("--name", default="current")
    p.add_argument("--ref", help="Git revision for original HTML/CSS/catalog. WASM stays the supplied binary.")
    p.add_argument("--wasm", default=str(ROOT / "frontend-rs/target/wasm32-unknown-unknown/release/litra_frontend.wasm"))
    p.add_argument("--bindgen", default=os.environ.get("WASM_BINDGEN", "wasm-bindgen"))
    p = sub.add_parser("serve")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=4173)
    args = parser.parse_args()
    if args.command == "build":
        build(args)
    else:
        if not BUILD.exists():
            raise SystemExit("Run the build subcommand first")
        handler = functools.partial(Handler, directory=str(BUILD))
        print(f"Serving fictional Rust/WASM previews at http://{args.host}:{args.port}/", flush=True)
        with http.server.ThreadingHTTPServer((args.host, args.port), handler) as server:
            server.serve_forever()


if __name__ == "__main__":
    main()
