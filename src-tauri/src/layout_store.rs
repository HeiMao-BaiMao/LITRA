use std::fs;
use std::path::PathBuf;

const LAYOUT_FILENAME: &str = "litra-layout.json";
const LEGACY_LAYOUT_FILENAME: &str = "phenex-layout.json";

fn layout_path() -> Result<PathBuf, String> {
    Ok(crate::storage::data_or_documents_dir()?.join(LAYOUT_FILENAME))
}

fn legacy_layout_path() -> Result<PathBuf, String> {
    Ok(crate::storage::data_or_documents_dir()?.join(LEGACY_LAYOUT_FILENAME))
}

fn load_layout() -> Result<Option<String>, String> {
    let path = layout_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read layout file: {e}"))?;
    Ok(Some(content))
}

fn save_layout(json: &str) -> Result<(), String> {
    let path = layout_path()?;
    crate::storage::ensure_parent_dir(&path)?;
    fs::write(&path, json).map_err(|e| format!("Failed to write layout file: {e}"))
}

/// Migrate legacy `phenex-layout.json` to the current `litra-layout.json`.
/// Runs at most once: the legacy file is deleted after a successful copy.
fn migrate_legacy_layout() -> Result<Option<String>, String> {
    let legacy = legacy_layout_path()?;
    if !legacy.exists() {
        return Ok(None);
    }
    let content =
        fs::read_to_string(&legacy).map_err(|e| format!("Failed to read legacy layout: {e}"))?;
    let target = layout_path()?;
    crate::storage::ensure_parent_dir(&target)?;
    fs::write(&target, &content)
        .map_err(|e| format!("Failed to write migrated layout: {e}"))?;
    fs::remove_file(&legacy).map_err(|e| format!("Failed to remove legacy layout: {e}"))?;
    Ok(Some(content))
}

#[tauri::command]
pub fn layout_load() -> Result<Option<String>, String> {
    // If the current layout exists, return it directly.
    if let Some(content) = load_layout()? {
        return Ok(Some(content));
    }
    // Otherwise attempt a one-shot migration from the legacy file.
    migrate_legacy_layout()
}

#[tauri::command]
pub fn layout_save(json: String) -> Result<(), String> {
    save_layout(&json)
}

/// レイアウト（パネル比率）を空に初期化する。
/// 旧TS `clearPanelRatios()` の移植。
#[tauri::command]
pub fn layout_clear() -> Result<(), String> {
    save_layout(r#"{"schemaVersion":1,"panelRatios":{}}"#)
}
