use std::{env, fs, path::PathBuf};
fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let path = root.join("src-tauri/src/ai/mod.rs");
    println!("cargo:rerun-if-changed={}", path.display());
    let source = fs::read_to_string(path).unwrap();
    // Keep the production request lifecycle and its unit tests byte-for-byte;
    // only module declarations are replaced with direct production paths.
    let start = source.find("use std::").unwrap();
    let mut modules = String::new();
    for name in [
        "auth",
        "effort_control",
        "messages",
        "oauth",
        "providers",
        "stream",
        "transport",
        "types",
    ] {
        let file = root.join(format!("src-tauri/src/ai/{name}.rs"));
        let file = if file.exists() {
            file
        } else {
            root.join(format!("src-tauri/src/ai/{name}/mod.rs"))
        };
        modules.push_str(&format!(
            "#[path = {:?}] pub mod {name};\n",
            file.canonicalize().unwrap()
        ));
    }
    modules.push_str(&source[start..]);
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("ai.rs"),
        modules,
    )
    .unwrap();
}
