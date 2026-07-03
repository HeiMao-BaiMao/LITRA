use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

pub fn documents_dir() -> Result<PathBuf, String> {
    dirs::document_dir().ok_or_else(|| "Documents directory not found".to_string())
}

pub fn data_or_documents_dir() -> Result<PathBuf, String> {
    dirs::data_dir()
        .or_else(dirs::document_dir)
        .ok_or_else(|| "App data directory not found".to_string())
}

pub fn project_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(documents_dir()?.join("phenex/projects").join(project_id))
}

pub fn project_settings_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("settings"))
}

pub fn project_episodes_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("episodes"))
}

pub fn project_characters_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_settings_dir(project_id)?.join("characters.json"))
}

pub fn project_world_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_settings_dir(project_id)?.join("world.json"))
}

pub fn project_episodes_list_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("episodes.json"))
}

pub fn project_memos_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("memos.json"))
}

pub fn project_memos_list_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("project-memos.json"))
}

pub fn project_relationships_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("relationships.json"))
}

pub fn project_summaries_path(project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(project_id)?.join("summaries.json"))
}

pub fn project_search_index_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(data_or_documents_dir()?
        .join("phenex/index")
        .join(project_id))
}

pub fn genre_dir(genre_id: &str) -> Result<PathBuf, String> {
    Ok(documents_dir()?.join("phenex/genres").join(genre_id))
}

pub fn genre_search_index_dir(genre_id: &str) -> Result<PathBuf, String> {
    Ok(data_or_documents_dir()?
        .join("phenex/genre-index")
        .join(genre_id))
}

pub fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    serde_json::from_str(&text).map_err(|e| format!("Failed to parse {}: {}", path.display(), e))
}

pub fn read_or_empty(path: &Path, empty: Value) -> Value {
    if path.exists() {
        read_json(path).unwrap_or(empty)
    } else {
        empty
    }
}

pub fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {}: {}", parent.display(), e))?;
    }
    Ok(())
}

pub fn write_text(path: &Path, content: &str) -> Result<(), String> {
    ensure_parent_dir(path)?;
    fs::write(path, content).map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

pub fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    write_text(path, &serde_json::to_string_pretty(value).unwrap())
}
