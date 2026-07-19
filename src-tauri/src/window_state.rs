use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const STORE_FILE: &str = "window-bounds.json";

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Default, Deserialize, Serialize)]
struct WindowStateFile {
    #[serde(default)]
    bounds: HashMap<String, WindowBounds>,
    #[serde(default)]
    detached: HashMap<String, bool>,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app config dir not found: {e}"))?
        .join(STORE_FILE))
}

fn read_state(app: &AppHandle) -> WindowStateFile {
    let Ok(path) = store_path(app) else {
        return WindowStateFile::default();
    };
    let Ok(contents) = fs::read_to_string(&path) else {
        return WindowStateFile::default();
    };
    serde_json::from_str(&contents).unwrap_or_default()
}

fn write_state(app: &AppHandle, state: &WindowStateFile) -> Result<(), String> {
    let path = store_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }
    fs::write(
        &path,
        serde_json::to_string_pretty(state).expect("window state serialization should not fail"),
    )
    .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

#[tauri::command]
pub fn load_window_bounds(app: AppHandle, label: String) -> Result<Option<WindowBounds>, String> {
    Ok(read_state(&app).bounds.get(&label).copied())
}

#[tauri::command]
pub fn save_window_bounds(
    app: AppHandle,
    label: String,
    bounds: WindowBounds,
) -> Result<(), String> {
    let mut state = read_state(&app);
    state.bounds.insert(label, bounds);
    write_state(&app, &state)
}

#[tauri::command]
pub fn load_window_detached(app: AppHandle, label: String) -> Result<bool, String> {
    Ok(read_state(&app).detached.get(&label).copied().unwrap_or(false))
}

#[tauri::command]
pub fn save_window_detached(app: AppHandle, label: String, detached: bool) -> Result<(), String> {
    let mut state = read_state(&app);
    state.detached.insert(label, detached);
    write_state(&app, &state)
}
